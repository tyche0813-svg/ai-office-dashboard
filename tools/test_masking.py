# -*- coding: utf-8 -*-
"""마스킹 단위 테스트:  python -m unittest tools/test_masking.py -v  (또는 python tools/test_masking.py)

테스트용 값은 모두 지어낸 가짜다(실제 계정·경로·번호 아님).
"""
import json
import re
import sys
import unittest
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pc_watch as pw  # noqa: E402
import notion_push as npush  # noqa: E402

NOW = datetime(2026, 1, 5, 14, 0, 0, tzinfo=pw.KST)
FAKE_ID_A = "tester0123456"
FAKE_ID_B = "sample9876"
FAKE_USER = "fakeuser"
SECRETS = [
    r"C:\Users\fakeuser\dev\shorts_app\pc\sm.py",
    r"C:\Users\fakeuser\work\blog_runs\2026-01-05_tester0123456_slot19",
    "fakeuser@example.com",
    "010-1234-5678",
    "110-234-567890",
    "1,234,500원",
    "수익 35만원",
    "$1,200",
    "sk-abcDEF1234567890abcDEF1234567890",
    "https://example.com/thread/3e70dbab-5a82-482f-a9fb-7d2624b36706",
    "서울시 강서구 가짜로 123",
    "가짜 키워드 원문 제목입니다",
    "192.168.10.24",
    FAKE_ID_A, FAKE_ID_B,
]
CFG = dict(pw.DEFAULTS, blog_teams={FAKE_ID_A: "A"}, sensitive_terms=[FAKE_USER, "가짜 키워드"],
           vooy_signal={"process": "fakevooy9876", "path": r"C:\Users\fakeuser\vooy\state.json", "active_min": 10})
CAST_IDS = ["claude", "muse", "aside", "exaone", "chatgpt", "copilot", "speech", "claudeapi", "codex", "stability",
            "opus", "fable", "routine", "vooy"]

FORBIDDEN = [
    ("경로", re.compile(r"(?i)[a-z]:[\\/]|\\\\|/Users/|/home/")),
    ("이메일", re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")),
    ("금액", re.compile(r"\d[\d,]*\s?(?:원|만원|억|달러)|[₩$]\s?\d")),
    ("아이디", re.compile(r"[A-Za-z]{2,}\d{3,}")),
    ("전화", re.compile(r"01[016789][-\s.]?\d{3,4}[-\s.]?\d{4}")),
    ("링크", re.compile(r"https?://")),
    ("긴 숫자", re.compile(r"\d{7,}")),
    ("IP", re.compile(r"(?:\d{1,3}\.){3}\d{1,3}")),
]


def fake_raw():
    """식별 정보가 잔뜩 섞인 가짜 스캔 결과."""
    def app(**kw):
        base = {"exists": True, "poller": True, "job_procs": 0, "current_job": False, "current_job_mtime": None,
                "events": [], "stage": None, "stage_time": None, "muse": [], "speech": [], "copy": [], "last_log": None}
        base.update(kw)
        return base
    m = lambda n: NOW - timedelta(minutes=n)  # noqa: E731
    return {
        "now": NOW,
        "procs": [
            {"pid": 1, "name": "python.exe", "cmd": SECRETS[0] + " run --run " + SECRETS[1], "created": ""},
            {"pid": 2, "name": "claude.exe", "cmd": r"C:\Users\fakeuser\.local\bin\claude.exe --resume 3e70dbab-5a82-482f-a9fb-7d2624b36706", "created": ""},
            {"pid": 3, "name": "Aside.exe", "cmd": "Aside.exe --profile-directory=Default", "created": ""},
            {"pid": 4, "name": "pythonw.exe", "cmd": "pythonw.exe bridge.py", "created": ""},
            {"pid": 5, "name": "python.exe", "cmd": r"python C:\Users\fakeuser\dev\publish_check_app\collector\collect.py --loop", "created": ""},
            {"pid": 6, "name": "powershell.exe", "cmd": r"powershell -File C:\Users\fakeuser\work\scripts\ar.ps1 -File " + SECRETS[1] + r"\x.js", "created": ""},
        ],
        "signals": {
            "aside": {"running": True, "last": NOW, "scr_last": m(6), "run_last": m(2)},
            "muse": {"running": False, "last": m(3), "scr_last": m(9), "run_last": m(3)},
            "exaone": {"running": False, "last": m(50), "scr_last": None, "run_last": m(50)},
            "chatgpt": {"running": False, "last": None, "scr_last": None, "run_last": None},
            "copilot": {"running": False, "last": m(1), "scr_last": None, "run_last": m(1)},
            "codex": {"running": False, "last": None, "scr_last": None, "run_last": None},
        },
        "subagents": {"opus": m(1), "fable": m(30)},
        "vooy": {"configured": True, "running": False, "last": m(400)},
        "apps": {
            "shorts": app(job_procs=1, stage="voice", stage_time=m(3), events=[(m(40), "start")], muse=[m(4)], speech=[m(2)]),
            "reels": app(events=[(m(90), "start"), (m(80), "end")]),
            "clip": app(poller=False),
            "carousel": app(events=[(m(12), "start"), (m(5), "end")]),
            # 단계 이름 자리에 식별 문자열이 흘러들어온 최악의 경우
            "insta": app(job_procs=1, stage=SECRETS[2], stage_time=m(1)),
        },
        "blog": {
            "exists": True,
            "today_dirs": [{"account": FAKE_ID_A, "slot": "19", "mtime": m(5), "start": m(12)},
                           {"account": FAKE_ID_B, "slot": "20", "mtime": m(200), "start": None}],
            "rows_today": [{"time": m(300), "account": FAKE_ID_A, "saved": True},
                           {"time": m(210), "account": FAKE_ID_B, "saved": True}],
            "accounts": {FAKE_ID_A, FAKE_ID_B},
            "run_log_mtime": m(5), "schedule_mtime": m(600),
        },
        "claude_session": m(1),
        "tv": {"exists": True, "log_mtime": m(1), "last_cmd": m(1)},
        "pubcheck": {"log_mtime": m(1)},
        "insight": {"log_mtime": m(120)},
        "drive": {"onedrive_folder": True, "gdrive_folder": False},
    }


class MaskTest(unittest.TestCase):
    def test_each_secret_is_removed(self):
        for s in SECRETS:
            out = pw.mask("앞말 " + s + " 뒷말", [FAKE_ID_A, FAKE_ID_B, FAKE_USER, "가짜 키워드"])
            self.assertNotIn(s, out, s)
            for name, rx in FORBIDDEN:
                self.assertIsNone(rx.search(out), "%s 남음: %r -> %r" % (name, s, out))

    def test_path_email_money_id(self):
        self.assertEqual(pw.mask(r"열기 D:\data\secret\a.txt 끝"), "열기 [경로] 끝")
        self.assertEqual(pw.mask("문의 a.b@c-d.co.kr 로"), "문의 [이메일] 로")
        self.assertEqual(pw.mask("수익 12,300원 발생"), "수익 [금액] 발생")
        self.assertEqual(pw.mask("계정 abc02071227 확인"), "계정 [아이디] 확인")
        self.assertEqual(pw.mask("접속 10.0.12.7 에서"), "접속 [IP] 에서")

    def test_safe_phrases_survive(self):
        for s in ["블로그 원고 1건 임시저장", "쇼츠 파이프라인 1건 완료", "이미지 생성 대기",
                  "오늘 원고 2건 임시저장 · 다음 슬롯 대기", "블로그팀 A", "Azure Speech", "Claude API", "Opus 보조",
                  "클로드 → 뮤즈: 초안·사진 요청", "지시받은 작업 지휘 중 · AI 3명 가동", "회의 시작: 블로그 슬롯"]:
            self.assertEqual(pw.mask(s), s)

    def test_length_cap(self):
        self.assertLessEqual(len(pw.mask("가" * 500)), pw.MAX_TEXT)

    def test_find_leaks_catches_planted(self):
        bad = {"agents": [{"name": "x", "task": r"C:\Users\fakeuser\a.txt"}], "logs": [{"title": "메일 q@w.io"}],
               "updated_at": "어제"}
        kinds = {k for _p, k in pw.find_leaks(bad, [FAKE_USER])}
        self.assertTrue({"winpath", "email", "timestamp", "term"} <= kinds, kinds)

    def test_write_refuses_leaky_payload(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "pc-status.json"
            ok = pw.write_status({"updated_at": pw.iso(NOW), "agents": [{"task": "id tester0123456"}]}, [], out)
            self.assertFalse(ok)
            self.assertFalse(out.exists())


class BuildTest(unittest.TestCase):
    def setUp(self):
        raw = fake_raw()
        self.events = pw.derive_events(None, pw.event_marks(raw, CFG), NOW)
        self.payload, self.terms = pw.build_status(raw, CFG, self.events)
        self.text = json.dumps(self.payload, ensure_ascii=False)

    def test_no_secret_in_output(self):
        for s in SECRETS + [FAKE_USER, "fakeuser", "blog_runs", "shorts_app", "fakevooy", "state.json", "ar.ps1"]:
            self.assertNotIn(s.lower(), self.text.lower(), s)

    def test_no_forbidden_pattern_outside_timestamps(self):
        stripped = re.sub(r'"(?:updated_at|last_active|time)": "[^"]*"', '""', self.text)
        for name, rx in FORBIDDEN:
            self.assertIsNone(rx.search(stripped), "%s 패턴이 출력에 남음" % name)

    def test_leak_checker_passes(self):
        self.assertEqual(pw.find_leaks(self.payload, self.terms), [])

    def test_schema(self):
        p = self.payload
        self.assertEqual(p["source"], "pc")
        self.assertRegex(p["updated_at"], pw.TS_RE)
        self.assertEqual(set(p["summary"]), {"done_today", "working", "idle"})
        for a in p["agents"]:
            self.assertEqual(set(a), {"id", "name", "role", "status", "zone", "bubble", "task", "last_active"})
            self.assertIn(a["status"], {"working", "meeting", "resting", "idle", "offline"})
            self.assertIn(a["zone"], {"ceo", "meeting", "desk", "lounge", "reception"})
        for l in p["logs"]:
            self.assertEqual(set(l), {"time", "agent", "title", "detail"})
            self.assertRegex(l["time"], pw.TS_RE)
        self.assertEqual(set(p), {"updated_at", "source", "summary", "cast", "events", "agents", "logs"})

    def test_cast_schema(self):
        cast = self.payload["cast"]
        self.assertEqual(sorted(c["id"] for c in cast), sorted(CAST_IDS))
        self.assertEqual(cast[0]["id"], "claude")
        for c in cast:
            self.assertEqual(set(c), {"id", "name", "role", "status", "bubble", "task", "last_active"})
            self.assertIn(c["status"], pw.CAST_STATUS)
            self.assertEqual((c["name"], c["role"]), pw.CAST_INFO[c["id"]])
            self.assertTrue(c["last_active"] == "" or pw.TS_RE.match(c["last_active"]))
            self.assertLessEqual(len(c["bubble"]), 18)

    def test_cast_statuses(self):
        by = {c["id"]: c for c in self.payload["cast"]}
        self.assertEqual(by["claude"]["status"], "working")
        self.assertEqual(by["aside"]["bubble"], "에디터 입력 중")      # 실행 중 + 블로그 작업 중
        self.assertEqual(by["muse"]["status"], "working")
        self.assertEqual(by["opus"]["status"], "working")
        self.assertEqual(by["fable"]["status"], "idle")              # 30분 전 흔적 -> 쉬는 시간도 지남
        self.assertEqual(by["exaone"]["status"], "idle")
        self.assertEqual(by["copilot"]["status"], "working")
        self.assertEqual(by["chatgpt"]["status"], "idle")
        self.assertEqual(by["speech"]["status"], "working")
        self.assertEqual(by["codex"]["status"], "offline")
        self.assertEqual(by["stability"]["status"], "offline")
        self.assertEqual(by["routine"]["status"], "idle")            # 14시는 새벽 시간대가 아님
        self.assertEqual(by["vooy"]["status"], "idle")               # 신호는 있지만 오래됨

    def test_vooy_default_idle_and_configurable(self):
        raw = fake_raw()
        raw["vooy"] = {"configured": False, "running": False, "last": None}
        by = {c["id"]: c for c in pw.build_status(raw, dict(pw.DEFAULTS))[0]["cast"]}
        self.assertEqual((by["vooy"]["status"], by["vooy"]["task"]), ("idle", "활동 신호 미설정 · 대기"))
        raw["vooy"] = {"configured": True, "running": True, "last": NOW}
        payload, terms = pw.build_status(raw, CFG)
        by = {c["id"]: c for c in payload["cast"]}
        self.assertEqual(by["vooy"]["status"], "working")
        self.assertEqual(pw.find_leaks(payload, terms), [])

    def test_resting_after_recent_work(self):
        raw = fake_raw()
        raw["subagents"]["fable"] = NOW - timedelta(minutes=8)
        by = {c["id"]: c for c in pw.build_status(raw, CFG)[0]["cast"]}
        self.assertEqual(by["fable"]["status"], "resting")

    def test_events_only_fixed_phrases(self):
        ev = self.payload["events"]
        self.assertTrue(ev)
        allowed = {"time", "kind", "from", "to", "title", "coarse", "members"}
        ids = set(CAST_IDS) | {""}
        for e in ev:
            self.assertLessEqual(set(e), allowed)
            self.assertRegex(e["time"], pw.TS_RE)
            self.assertIn(e["kind"], {"dispatch", "report", "meeting", "note"})
            self.assertIn(e["from"], ids)
            self.assertIn(e["to"], ids)
            self.assertTrue(e["coarse"])                              # 감시 시작 직후에는 '대략' 사건뿐
            for mem in e.get("members", []):
                self.assertIn(mem, ids)
        titles = {e["title"] for e in ev}
        self.assertIn("회의 시작: 블로그 슬롯", titles)
        self.assertIn("클로드 → 뮤즈: 초안·사진 요청", titles)         # 되살린 사건은 지휘자 이름으로만
        self.assertIn("어사이드 → 클로드: 에디터 입력 기록", titles)

    def test_events_from_transitions(self):
        raw = fake_raw()
        prev = pw.event_marks(raw, CFG)
        self.assertEqual(pw.derive_events(prev, prev, NOW), [])       # 바뀐 게 없으면 사건도 없다
        raw2 = fake_raw()
        raw2["subagents"]["fable"] = NOW
        raw2["blog"]["rows_today"].append({"time": NOW, "account": FAKE_ID_A, "saved": True})
        raw2["signals"]["aside"]["run_last"] = NOW
        ev = pw.derive_events(prev, pw.event_marks(raw2, CFG), NOW)
        got = {(e["title"], e["coarse"]) for e in ev}
        self.assertEqual(got, {("클로드 → Fable: 개발 작업 배정", False), ("어사이드 → 클로드: 임시저장 1건 완료", False),
                               ("어사이드 → Opus 보조: 에디터 입력 기록", True)})
        merged = pw.merge_events(ev, ev, NOW)
        self.assertEqual(len(merged), len(ev))                         # 같은 사건은 한 번만
        payload, terms = pw.build_status(raw2, CFG, merged)
        self.assertEqual(pw.find_leaks(payload, terms), [])

    def test_live_post_refuses_leaky_payload(self):
        bad = {"updated_at": pw.iso(NOW), "source": "pc", "cast": [{"task": "서버 192.168.10.24 접속"}]}
        self.assertIs(pw.live_post(bad, [], {"live_url": "http://127.0.0.1:9/none"}, "x" * 8), False)

    def test_statuses(self):
        by = {a["id"]: a for a in self.payload["agents"]}
        self.assertEqual(by["blog-a"]["name"], "블로그팀 A")
        self.assertEqual(by["blog-a"]["status"], "working")
        self.assertEqual(by["blog-b"]["status"], "idle")       # 설정에 없는 계정도 글자로만
        self.assertEqual(by["shorts"]["status"], "working")
        self.assertEqual(by["shorts"]["bubble"], "음성 생성 중")
        self.assertEqual(by["carousel"]["status"], "resting")
        self.assertEqual(by["reels"]["status"], "idle")
        self.assertEqual(by["clip"]["status"], "offline")
        self.assertEqual(by["insta"]["bubble"], "작업 진행 중")  # 모르는 단계 문자열은 버린다
        for cid in ("claude", "muse", "speech", "browser"):      # 주인공은 일감 목록에 넣지 않는다
            self.assertNotIn(cid, by)

    def test_muse_idle_when_no_recent_call(self):
        raw = fake_raw()
        raw["apps"]["shorts"]["muse"] = [NOW - timedelta(minutes=45)]
        raw["apps"]["shorts"]["speech"] = []
        raw["signals"]["muse"] = {"running": False, "last": None, "scr_last": None, "run_last": None}
        by = {a["id"]: a for a in pw.build_status(raw, CFG)[0]["cast"]}
        self.assertEqual(by["muse"]["status"], "idle")
        self.assertEqual(by["speech"]["status"], "idle")

    def test_signature_ignores_timestamps(self):
        raw2 = fake_raw()
        raw2["now"] = NOW + timedelta(seconds=30)
        raw2["claude_session"] = NOW
        p2, _ = pw.build_status(raw2, CFG, self.events)
        self.assertEqual(pw.signature(self.payload), pw.signature(p2))


class NotionPushTest(unittest.TestCase):
    """노션 연락판 AI(피클·Instinct·Pally): 줄 수만 받아 고정 문구로만 내보낸다."""

    def test_states_and_fixed_phrases(self):
        st = {}
        t0 = NOW
        self.assertEqual(npush.note_count(st, "instinct", 3, t0), 0)          # 첫 기록은 기준선(보고로 세지 않음)
        p = npush.build_payload(st, t0)
        by = {c["id"]: c for c in p["cast"]}
        self.assertEqual(by["instinct"]["status"], "idle")
        self.assertEqual(by["pickle"]["status"], "offline")                    # 아직 연결 확인 전
        self.assertEqual(by["pally"]["task"], "연결 안 됨 · 연락판 연결 전")
        t1 = t0 + timedelta(minutes=5)
        self.assertEqual(npush.note_count(st, "instinct", 5, t1), 2)
        p = npush.build_payload(st, t1 + timedelta(minutes=10))
        by = {c["id"]: c for c in p["cast"]}
        self.assertEqual((by["instinct"]["status"], by["instinct"]["bubble"]), ("working", "작업 보고 중"))
        self.assertEqual(p["summary"]["done_today"], 2)
        self.assertEqual([e["title"] for e in p["events"]], ["Instinct → 클로드: 연락판 보고"])
        self.assertEqual(npush.build_payload(st, t1 + timedelta(minutes=40))["cast"][1]["status"], "resting")
        self.assertEqual(npush.build_payload(st, t1 + timedelta(minutes=90))["cast"][1]["status"], "idle")
        self.assertEqual(npush.note_count(st, "instinct", 5, t1 + timedelta(minutes=91)), 0)   # 줄 수가 같으면 보고 아님

    def test_schema_and_no_leak(self):
        st = {}
        npush.note_count(st, "pickle", 1, NOW)
        npush.note_count(st, "pickle", 2, NOW + timedelta(minutes=1))
        st["events"].append({"time": "어제", "agent": SECRETS[2]})               # 깨진 기록은 버려진다
        st["pickle"]["last"] = SECRETS[0]                                        # 식별 문자열이 끼어도 내보내지 않는다
        p = npush.build_payload(st, NOW + timedelta(minutes=2))
        self.assertEqual(set(p), {"updated_at", "source", "summary", "cast", "events", "agents", "logs"})
        self.assertEqual(pw.find_leaks(p), [])
        text = json.dumps(p, ensure_ascii=False)
        for s in SECRETS:
            self.assertNotIn(s, text)
        for c in p["cast"]:
            self.assertEqual(set(c), {"id", "name", "role", "status", "bubble", "task", "last_active"})
            self.assertIn(c["id"], npush.AGENTS)
            self.assertIn((c["bubble"], c["task"]), set(npush.PHRASES.values()))
        self.assertEqual(len(p["events"]), 1)

    def test_run_writes_only_generic_file(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            out, state = Path(d) / "notion-agents.json", Path(d) / "state.json"
            self.assertEqual(npush.run("instinct", 4, push=False, now=NOW, out_file=out, state_file=state), 0)
            self.assertEqual(npush.run("instinct", 6, push=False, now=NOW + timedelta(minutes=3), out_file=out, state_file=state), 0)
            p = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(pw.find_leaks(p), [])
            self.assertEqual({c["id"]: c["status"] for c in p["cast"]}["instinct"], "working")
            self.assertEqual(npush.run("nobody", 1, push=False, now=NOW, out_file=out, state_file=state), 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
