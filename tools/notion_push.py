#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""노션 연락판으로 일하는 AI(피클·Instinct·Pally …)의 상태 -> data/notion-agents.json (공개 페이지용).

  python tools/notion_push.py <agent_id> <line_count> [--no-push]

  line_count = 그 AI 의 연락판에서 'AI → 클로드' 아래에 지금 있는 줄 수(양식 줄 제외).
  줄 수가 지난번보다 늘면 '방금 보고가 올라왔다'로 본다. 노션 글 내용은 받지도 쓰지도 않는다.

원칙(pc_watch.py 와 같음)
- 공개 JSON 의 문장은 전부 이 파일 안의 고정 문구. find_leaks() 에 하나라도 걸리면 저장하지 않는다.
- 상태: 새 줄 뒤 20분까지 working, 60분까지 resting, 그 뒤 idle. 한 번도 연결 확인이 안 된 AI 는 offline('연결 안 됨').
- 줄 수 기록은 local/notion_state.json(비공개). 바뀐 때만 data/notion-agents.json 한 파일을 커밋·푸시한다.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pc_watch as pw  # noqa: E402  (KST, iso, find_leaks, TS_RE 재사용)

ROOT = Path(__file__).resolve().parent.parent
OUT_FILE = ROOT / "data" / "notion-agents.json"
STATE_FILE = ROOT / "local" / "notion_state.json"
OLD_PICKLE_STATE = ROOT / "local" / "pickle_state.json"
WORK_MIN, REST_MIN = 20, 60

# id: (화면 이름, 역할)
AGENTS = {
    "pickle": ("피클", "클라우드 비서"),
    "instinct": ("Instinct", "일정 · 자료 조사 · 콘텐츠"),
    "pally": ("Pally", "노션 비서"),
    "keyring": ("키링", "정보 조사 · 일정 · 문서"),
}
PHRASES = {
    "working": ("작업 보고 중", "노션 연락판에 작업 결과 보고"),
    "resting": ("보고 완료", "노션 연락판 보고 완료"),
    "idle": ("요청 대기", "노션 연락판 대기"),
    "offline": ("", "연결 안 됨 · 연락판 연결 전"),
}


def load_state(state_file=STATE_FILE, old_pickle=OLD_PICKLE_STATE):
    try:
        with open(state_file, encoding="utf-8") as f:
            st = json.load(f)
        if isinstance(st, dict):
            return st
    except (OSError, ValueError):
        pass
    st = {}
    try:   # 예전 피클 전용 기록을 이어받는다
        with open(old_pickle, encoding="utf-8") as f:
            old = json.load(f)
        if isinstance(old, dict) and "count" in old:
            st["pickle"] = {"day": old.get("day", ""), "today": int(old.get("today", 0)),
                            "last": str(old.get("last", "")), "count": int(old.get("count", 0))}
    except (OSError, ValueError, TypeError):
        pass
    return st


def note_count(state, agent_id, count, now):
    """줄 수를 기록하고, 늘었으면 '새 보고' 건수를 돌려준다(순수 함수: state 를 고쳐서 돌려줌)."""
    today = now.strftime("%Y-%m-%d")
    a = dict(state.get(agent_id) or {})
    if a.get("day") != today:
        a["day"], a["today"] = today, 0
    new = 0
    if "count" in a and count > int(a.get("count", 0)):
        new = count - int(a["count"])
        a["today"] = int(a.get("today", 0)) + new
        a["last"] = pw.iso(now)
    a["count"] = int(count)
    a.setdefault("last", "")
    a.setdefault("today", 0)
    state[agent_id] = a
    if new:
        ev = [e for e in state.get("events", []) if str(e.get("time", ""))[:10] == today]
        ev.insert(0, {"time": pw.iso(now), "agent": agent_id})
        state["events"] = ev[:20]
    return new


def status_of(last_iso, now):
    if not last_iso:
        return "idle"
    try:
        age = (now - datetime.fromisoformat(last_iso)).total_seconds() / 60
    except ValueError:
        return "idle"
    if age <= WORK_MIN:
        return "working"
    if age <= REST_MIN:
        return "resting"
    return "idle"


def build_payload(state, now):
    """공개 JSON. 한 번이라도 줄 수가 기록된 AI 만 '연결됨'으로 넣고, 나머지는 '연결 안 됨'."""
    today = now.strftime("%Y-%m-%d")
    cast, done = [], 0
    for aid, (name, role) in AGENTS.items():
        a = state.get(aid) or {}
        if "count" not in a:
            st, last = "offline", ""
        else:
            last = a.get("last", "") if pw.TS_RE.match(str(a.get("last", ""))) else ""
            st = status_of(last, now)
            if a.get("day") == today:
                done += int(a.get("today", 0))
        bubble, task = PHRASES[st]
        cast.append({"id": aid, "name": name, "role": role, "status": st, "bubble": bubble, "task": task, "last_active": last})
    events = []
    for e in state.get("events", []):
        aid, t = e.get("agent"), str(e.get("time", ""))
        if aid in AGENTS and pw.TS_RE.match(t) and t[:10] == today:
            events.append({"time": t, "kind": "report", "from": aid, "to": "claude",
                           "title": "%s → 클로드: 연락판 보고" % AGENTS[aid][0], "coarse": True})
    return {"updated_at": pw.iso(now), "source": "notion", "summary": {"done_today": done},
            "cast": cast, "events": events[:20], "agents": [], "logs": []}


def _same(a, b):
    def strip(d):
        return {k: v for k, v in d.items() if k != "updated_at"}
    return strip(a) == strip(b)


def git_publish(rel="data/notion-agents.json", message="notion agents: status update"):
    git = shutil.which("git") or r"C:\Program Files\Git\cmd\git.exe"
    if not os.path.exists(git) and not shutil.which("git"):
        return "no-git"

    def run(*a):
        return subprocess.run([git, "-C", str(ROOT)] + list(a), capture_output=True, timeout=120,
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    run("add", "--", rel)
    if run("diff", "--cached", "--quiet", "--", rel).returncode == 0:
        return "nothing"
    c = run("commit", "-m", message, "--", rel).returncode
    p = run("push", "-q").returncode
    if p != 0:   # 감시 스크립트가 먼저 올렸을 수 있다: 한 번 받아서 다시
        run("pull", "-q", "--rebase", "--autostash")
        p = run("push", "-q").returncode
    return "commit %d push %d" % (c, p)


def run(agent_id, count, push=True, now=None, out_file=OUT_FILE, state_file=STATE_FILE):
    if agent_id not in AGENTS:
        print("NP>> unknown agent (가능: %s)" % ", ".join(AGENTS))
        return 2
    now = now or datetime.now(pw.KST)
    state = load_state(state_file)
    new = note_count(state, agent_id, max(0, int(count)), now)
    Path(state_file).parent.mkdir(parents=True, exist_ok=True)
    with open(state_file, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False)
    payload = build_payload(state, now)
    leaks = pw.find_leaks(payload)
    if leaks:
        print("NP>> blocked by masking check (%d)" % len(leaks))
        return 1
    try:
        with open(out_file, encoding="utf-8") as f:
            old = json.load(f)
    except (OSError, ValueError):
        old = {}
    me = next(c for c in payload["cast"] if c["id"] == agent_id)
    if _same(old, payload):
        print("NP>> %s unchanged (%s, 오늘 %d건)" % (agent_id, me["status"], (state[agent_id]).get("today", 0)))
        return 0
    Path(out_file).parent.mkdir(parents=True, exist_ok=True)
    with open(out_file, "w", encoding="utf-8", newline="\n") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
        f.write("\n")
    res = git_publish() if push else "no-push"
    print("NP>> %s %s 새 보고 %d 오늘 %d건 | %s" % (agent_id, me["status"], new, state[agent_id].get("today", 0), res))
    return 0


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    push = "--no-push" not in argv
    argv = [a for a in argv if a != "--no-push"]
    if len(argv) < 2:
        print("사용법: python tools/notion_push.py <%s> <line_count> [--no-push]" % "|".join(AGENTS))
        return 2
    try:
        count = int(argv[1])
    except ValueError:
        print("NP>> line_count 는 숫자여야 합니다")
        return 2
    return run(argv[0].strip().lower(), count, push=push)


if __name__ == "__main__":
    sys.exit(main())
