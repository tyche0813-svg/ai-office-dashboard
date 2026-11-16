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
    FAKE_ID_A, FAKE_ID_B,
]
CFG = dict(pw.DEFAULTS, blog_teams={FAKE_ID_A: "A"}, sensitive_terms=[FAKE_USER, "가짜 키워드"])

FORBIDDEN = [
    ("경로", re.compile(r"(?i)[a-z]:[\\/]|\\\\|/Users/|/home/")),
    ("이메일", re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")),
    ("금액", re.compile(r"\d[\d,]*\s?(?:원|만원|억|달러)|[₩$]\s?\d")),
    ("아이디", re.compile(r"[A-Za-z]{2,}\d{3,}")),
    ("전화", re.compile(r"01[016789][-\s.]?\d{3,4}[-\s.]?\d{4}")),
    ("링크", re.compile(r"https?://")),
    ("긴 숫자", re.compile(r"\d{7,}")),
]


def fake_raw():
    """식별 정보가 잔뜩 섞인 가짜 스캔 결과."""
    def app(**kw):
        base = {"exists": True, "poller": True, "job_procs": 0, "current_job": False, "current_job_mtime": None,
                "events": [], "stage": None, "stage_time": None, "muse": [], "speech": [], "last_log": None}
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
        ],
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
            "today_dirs": [{"account": FAKE_ID_A, "slot": "19", "mtime": m(5)},
                           {"account": FAKE_ID_B, "slot": "20", "mtime": m(200)}],
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

    def test_safe_phrases_survive(self):
        for s in ["블로그 원고 1건 임시저장", "쇼츠 파이프라인 1건 완료", "이미지 생성 대기",
                  "오늘 원고 2건 임시저장 · 다음 슬롯 대기", "Claude 과장", "블로그팀 A"]:
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
        self.payload, self.terms = pw.build_status(fake_raw(), CFG)
        self.text = json.dumps(self.payload, ensure_ascii=False)

    def test_no_secret_in_output(self):
        for s in SECRETS + [FAKE_USER, "fakeuser", "blog_runs", "shorts_app"]:
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
        self.assertEqual(by["muse"]["status"], "meeting")       # 최근 10분 안 호출
        self.assertEqual(by["speech"]["status"], "working")
        self.assertEqual(by["claude"]["status"], "working")

    def test_muse_idle_when_no_recent_call(self):
        raw = fake_raw()
        raw["apps"]["shorts"]["muse"] = [NOW - timedelta(minutes=45)]
        raw["apps"]["shorts"]["speech"] = []
        by = {a["id"]: a for a in pw.build_status(raw, CFG)[0]["agents"]}
        self.assertEqual(by["muse"]["status"], "idle")
        self.assertEqual(by["speech"]["status"], "offline")

    def test_signature_ignores_timestamps(self):
        raw2 = fake_raw()
        raw2["now"] = NOW + timedelta(seconds=30)
        raw2["claude_session"] = NOW
        p2, _ = pw.build_status(raw2, CFG)
        self.assertEqual(pw.signature(self.payload), pw.signature(p2))


if __name__ == "__main__":
    unittest.main(verbosity=2)
