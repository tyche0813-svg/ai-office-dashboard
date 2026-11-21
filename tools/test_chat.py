"""'지시' 대화창 테스트(가짜 Worker + 모의 실행. 실제 Claude·실제 Worker·실제 토큰을 쓰지 않는다).

  python tools/test_chat.py

확인하는 것
  1. 답에 섞인 긴 토큰이 올리기 전에 가려진다.
  2. Claude 실행 명령이 읽기·검색 도구로만 좁혀져 있고 위험한 옵션이 없다.
  3. 지시·답 문구가 공개 파일(저장소에 올라가는 모든 파일, data/*.json)과 작업기 기록에 남지 않는다.
  4. 화면·Worker 코드가 지시·답을 공개 저장소(data/, /status)로 보내지 않는다.
  5. 하루 한도, 중간에 꺼진 지시(resumed) 처리.
"""
import sys
for _s in (sys.stdout, sys.stderr):
    try: _s.reconfigure(encoding='utf-8', errors='replace')
    except Exception: pass

import json, secrets, subprocess, tempfile, threading, unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
import chat_runner as R        # noqa: E402

FAKE_TOKEN = 'fake-' + secrets.token_hex(16)          # 실행할 때마다 새로 만드는 가짜 값


class FakeWorker:
    """Worker 의 /chat/pc/* 만 흉내 낸다."""
    def __init__(self, jobs):
        self.jobs, self.results, self.auth_fail = list(jobs), [], 0
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a): pass

            def _send(self, code, obj):
                body = json.dumps(obj).encode('utf-8')
                self.send_response(code); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(body)))
                self.end_headers(); self.wfile.write(body)

            def _ok(self):
                if self.headers.get('Authorization') == 'Bearer ' + FAKE_TOKEN: return True
                outer.auth_fail += 1; self._send(401, {'error': 'unauthorized'}); return False

            def do_GET(self):
                if not self._ok(): return
                if self.path == '/chat/pc/next':
                    return self._send(200, {'job': outer.jobs.pop(0) if outer.jobs else None})
                self._send(404, {})

            def do_POST(self):
                if not self._ok(): return
                n = int(self.headers.get('Content-Length') or 0)
                body = json.loads(self.rfile.read(n).decode('utf-8') or '{}')
                if self.path == '/chat/pc/result':
                    outer.results.append(body); return self._send(200, {'ok': True})
                self._send(404, {})

        self.srv = ThreadingHTTPServer(('127.0.0.1', 0), H)
        self.url = f'http://127.0.0.1:{self.srv.server_address[1]}'
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self): self.srv.shutdown(); self.srv.server_close()


class MaskTest(unittest.TestCase):
    def test_long_tokens_are_masked(self):
        key = 'sk-' + 'a1B2' * 8
        long_tok = 'Zx9' + secrets.token_hex(20)
        out = R.mask_secrets(f'열쇠 {key} 그리고 {long_tok} 끝, Bearer abcdefghijklmnop123')
        self.assertNotIn(key, out); self.assertNotIn(long_tok, out); self.assertNotIn('abcdefghijklmnop123', out)
        self.assertIn('[가림]', out)

    def test_named_secret_and_own_token(self):
        out = R.mask_secrets('password: hunter2222 / ' + FAKE_TOKEN[:12] + 'x', extra=(FAKE_TOKEN[:12],))
        self.assertNotIn('hunter2222', out); self.assertNotIn(FAKE_TOKEN[:12], out)

    def test_plain_text_is_kept(self):
        s = '오늘 임시저장 2건, 예약 1건입니다. 다음 슬롯은 19시입니다.'
        self.assertEqual(R.mask_secrets(s), s)


class CommandTest(unittest.TestCase):
    def test_tools_are_read_only(self):
        cmd = R.build_cmd('claude.exe')
        self.assertNotIn('--dangerously-skip-permissions', cmd)
        self.assertNotIn('--allow-dangerously-skip-permissions', cmd)
        self.assertNotIn('bypassPermissions', cmd)
        tools = cmd[cmd.index('--tools') + 1].split(',')
        self.assertEqual(sorted(tools), ['Glob', 'Grep', 'Read', 'WebFetch', 'WebSearch'])
        self.assertEqual(cmd[cmd.index('--allowedTools') + 1], cmd[cmd.index('--tools') + 1])
        denied = cmd[cmd.index('--disallowedTools') + 1].split(',')
        for t in ('Bash', 'PowerShell', 'Edit', 'Write', 'NotebookEdit', 'Agent'): self.assertIn(t, denied)
        self.assertTrue(any('.env' in d for d in denied))
        self.assertEqual(cmd[cmd.index('--permission-mode') + 1], 'dontAsk')
        self.assertEqual(cmd[cmd.index('--permission-prompts') + 1], 'none')
        self.assertIn('--strict-mcp-config', cmd)

    def test_directive_is_not_on_command_line(self):
        self.assertFalse(any('대표님 지시]' in c for c in R.build_cmd('claude.exe')))

    def test_system_rules(self):
        for word in ('한국어', '발행', '결제', '비밀번호', '.env'): self.assertIn(word, R.SYSTEM_RULES)


class FlowTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='aio_chat_test_'))
        self.state = self.tmp / 'state.json'
        self._log = R.LOG_FILE; self._logs = R.LOGS
        R.LOGS = self.tmp; R.LOG_FILE = self.tmp / 'chat_runner.log'

    def tearDown(self):
        R.LOG_FILE = self._log; R.LOGS = self._logs

    def test_directive_and_reply_never_reach_public_files(self):
        directive = '지시-' + secrets.token_hex(8)          # 실행할 때마다 다른 표식(이 파일 자체와 겹치지 않게)
        reply = '답-' + secrets.token_hex(8)
        w = FakeWorker([{'id': 7, 'text': directive, 'resumed': False}])
        try:
            api = R.Api(w.url, FAKE_TOKEN)
            self.assertTrue(R.step(api, runner=lambda t: (True, reply + ' / ' + t), token=FAKE_TOKEN, state_file=self.state))
            self.assertFalse(R.step(api, runner=R.mock_claude, token=FAKE_TOKEN, state_file=self.state))
        finally: w.close()
        self.assertEqual(len(w.results), 1)
        self.assertTrue(w.results[0]['ok']); self.assertIn(reply, w.results[0]['text'])
        # 작업기 기록·상태 파일에는 내용이 없다
        for p in self.tmp.iterdir():
            body = p.read_text(encoding='utf-8', errors='replace')
            self.assertNotIn(directive, body, p.name); self.assertNotIn(reply, body, p.name)
        # 저장소에 올라가는 모든 파일 + data/*.json 에도 없다
        files = set(ROOT.glob('data/*.json'))
        try:
            out = subprocess.run(['git', '-C', str(ROOT), 'ls-files', '-co', '--exclude-standard'], capture_output=True, text=True, encoding='utf-8', timeout=30).stdout
            files |= {ROOT / x for x in out.splitlines() if x.strip()}
        except Exception: pass
        self.assertGreater(len(files), 3)
        for p in files:
            if not p.is_file() or p.stat().st_size > 3_000_000: continue
            body = p.read_bytes()
            self.assertNotIn(directive.encode('utf-8'), body, str(p)); self.assertNotIn(reply.encode('utf-8'), body, str(p))
            self.assertNotIn(FAKE_TOKEN.encode(), body, str(p))

    def test_secret_in_reply_is_masked_before_upload(self):
        key = 'ghp_' + 'Q7' * 14
        w = FakeWorker([{'id': 8, 'text': 'x', 'resumed': False}])
        try: R.step(R.Api(w.url, FAKE_TOKEN), runner=lambda t: (True, f'값은 {key} 와 {FAKE_TOKEN}'), token=FAKE_TOKEN, state_file=self.state)
        finally: w.close()
        self.assertNotIn(key, w.results[0]['text']); self.assertNotIn(FAKE_TOKEN, w.results[0]['text'])

    def test_resumed_job_is_closed_not_rerun(self):
        ran = []
        w = FakeWorker([{'id': 9, 'text': 'x', 'resumed': True}])
        try: R.step(R.Api(w.url, FAKE_TOKEN), runner=lambda t: ran.append(t) or (True, 'y'), token=FAKE_TOKEN, state_file=self.state)
        finally: w.close()
        self.assertEqual(ran, []); self.assertFalse(w.results[0]['ok'])

    def test_daily_limit(self):
        ran = []
        w = FakeWorker([{'id': i, 'text': 'x', 'resumed': False} for i in (1, 2, 3)])
        try:
            api = R.Api(w.url, FAKE_TOKEN)
            for _ in range(3): R.step(api, runner=lambda t: ran.append(t) or (True, 'y'), token=FAKE_TOKEN, state_file=self.state, daily_limit=2)
        finally: w.close()
        self.assertEqual(len(ran), 2)
        self.assertEqual([r['ok'] for r in w.results], [True, True, False])

    def test_runner_error_is_short(self):
        def boom(t): raise RuntimeError('내부 경로와 긴 설명 ' * 50)
        w = FakeWorker([{'id': 4, 'text': 'x', 'resumed': False}])
        try: R.step(R.Api(w.url, FAKE_TOKEN), runner=boom, token=FAKE_TOKEN, state_file=self.state)
        finally: w.close()
        self.assertFalse(w.results[0]['ok']); self.assertLess(len(w.results[0]['text']), 80)

    def test_wrong_token_gets_nothing(self):
        w = FakeWorker([{'id': 5, 'text': 'x', 'resumed': False}])
        try:
            with self.assertRaises(Exception): R.step(R.Api(w.url, 'wrong-' + FAKE_TOKEN), runner=R.mock_claude, state_file=self.state)
        finally: w.close()
        self.assertEqual(w.results, []); self.assertEqual(w.auth_fail, 1)


class SourceTest(unittest.TestCase):
    """코드가 지시·답을 공개 경로로 보내지 않는지 글자 그대로 확인한다."""
    def test_page_script_keeps_chat_private(self):
        js = (ROOT / 'assets' / 'chat.js').read_text(encoding='utf-8')
        self.assertNotIn('data/', js)                      # 공개 JSON 을 읽거나 쓰지 않는다
        self.assertNotIn('/status', js)
        self.assertNotIn('innerHTML', js)                  # 답은 글자로만 그린다(스크립트 실행 방지)
        self.assertNotIn('document.cookie', js)
        self.assertIn("'대표님 지시 접수'", js)             # 화면 연출은 고정 문구
        self.assertIn("'대표님께 답변 전달'", js)

    def test_worker_keeps_chat_out_of_public_status(self):
        chat = (ROOT / 'worker' / 'src' / 'chat.js').read_text(encoding='utf-8')
        self.assertNotIn('env.STATE', chat); self.assertNotIn("'status'", chat)
        self.assertNotIn("'*'", chat)                      # 아무 출처나 허용하지 않는다
        idx = (ROOT / 'worker' / 'src' / 'index.js').read_text(encoding='utf-8')
        self.assertNotIn('env.CHAT', idx)                  # 공개 /status 쪽 코드는 대화 저장소를 건드리지 않는다
        sw = (ROOT / 'sw.js').read_text(encoding='utf-8')
        self.assertIn('url.origin !== self.location.origin', sw)   # 서비스 워커는 Worker 응답을 저장하지 않는다

    def test_no_secret_values_in_repo_config(self):
        toml = (ROOT / 'worker' / 'wrangler.toml').read_text(encoding='utf-8')
        self.assertNotIn('[vars]', toml)
        for name in ('APP_PIN', 'CHAT_PC_TOKEN'): self.assertNotRegex(toml, name + r'\s*=')


if __name__ == '__main__':
    unittest.main(verbosity=1)
