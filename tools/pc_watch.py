#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PC 자동화 감시 -> data/pc-status.json (공개 페이지용, 비식별 요약만).

  python tools/pc_watch.py --scan     1단계: 읽기 전용 스캔 보고서(local/scan_report.md, 비공개)
  python tools/pc_watch.py --once     상태 파일을 한 번만 만든다
  python tools/pc_watch.py            2분 간격 감시 루프(작업 시작/종료 감지 시 즉시 갱신)
  옵션: --no-push  --no-live  --interval 120  --poll 20  --heartbeat 1800

원칙
- 읽기 전용: 프로세스 목록·로그·폴더 수정 시각만 본다. 다른 앱 파일은 건드리지 않는다.
- 공개 JSON 의 문장은 전부 이 파일 안의 고정 문구로만 만든다(로그 원문·제목·키워드는 읽어도 내보내지 않는다).
- 그래도 모든 문자열을 mask() 에 통과시키고, find_leaks() 가 하나라도 잡으면 파일을 쓰지 않는다.
- 계정 아이디 같은 식별 값은 이 파일에 적지 않는다. local/pc_watch.local.json(비공개, git 제외)에만 둔다.
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import logging
import logging.handlers
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
LOCAL_DIR = ROOT / "local"
OUT_FILE = DATA_DIR / "pc-status.json"
LOCAL_CFG = LOCAL_DIR / "pc_watch.local.json"
SCAN_REPORT = LOCAL_DIR / "scan_report.md"
KST = timezone(timedelta(hours=9))

log = logging.getLogger("pc_watch")

# ---------------------------------------------------------------- 마스킹

MASK_RULES = [
    ("url", re.compile(r"(?i)\b(?:https?|ftp|file)://\S+|\bwww\.\S+"), "[링크]"),
    ("email", re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "[이메일]"),
    ("winpath", re.compile(r"(?i)(?<![A-Za-z])[a-z]:[\\/][^\s\"'<>|]*|\\\\[^\s\"'<>|]+|%[A-Za-z_]+%[\\/][^\s\"'<>|]*"), "[경로]"),
    ("unixpath", re.compile(r"(?<![\w.])~?/(?:[\w.\-]+/)+[\w.\-]*"), "[경로]"),
    ("apikey", re.compile(
        r"\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[abprs]|AKIA|AIza)[-_A-Za-z0-9]{12,}"
        r"|\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"
        r"|(?<![A-Za-z0-9_\-])[A-Za-z0-9_\-]{28,}(?![A-Za-z0-9_\-])"), "[키]"),
    ("ip", re.compile(r"(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])"), "[IP]"),
    ("phone", re.compile(
        r"(?<!\d)(?:\+?82[-\s.]?)?0?1[016789][-\s.]?\d{3,4}[-\s.]?\d{4}(?!\d)"
        r"|(?<!\d)0\d{1,2}[-\s.]\d{3,4}[-\s.]\d{4}(?!\d)"), "[전화]"),
    ("account", re.compile(r"(?<!\d)\d{2,6}-\d{2,6}-\d{2,8}(?:-\d{1,4})?(?!\d)"), "[계좌]"),
    ("money", re.compile(
        r"[₩$€¥]\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:천|만|억|조))?"
        r"|\d[\d,]*(?:\.\d+)?\s?(?:천|백만|천만|만|억|조)?\s?(?:원|달러|USD|KRW|엔|유로)"
        r"|\d[\d,]*(?:\.\d+)?\s?(?:백만|천만|만|억|조)(?![가-힣])"), "[금액]"),
    ("address", re.compile(
        r"[가-힣]{1,8}(?:시|도|군|구)\s[가-힣0-9]{1,10}(?:로|길|동|읍|면)\s?\d+(?:-\d+)?(?:번길)?"), "[주소]"),
    ("userid", re.compile(r"(?<![A-Za-z0-9])[A-Za-z][A-Za-z_]{1,15}\d{3,}[A-Za-z0-9_]*(?![A-Za-z0-9])"), "[아이디]"),
    ("longnum", re.compile(r"(?<!\d)\d{7,}(?!\d)"), "[번호]"),
]
TS_FIELDS = {"updated_at", "last_active", "time"}
TS_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$")
MAX_TEXT = 80


def mask(text, terms=()):
    """문자열에서 식별 정보를 지운다. terms = 추가로 가릴 낱말(아이디·이름 등)."""
    if text is None:
        return ""
    out = str(text)
    for term in sorted((t for t in terms if t), key=len, reverse=True):
        out = re.sub(re.escape(term), "[비공개]", out, flags=re.IGNORECASE)
    for _name, rx, repl in MASK_RULES:
        out = rx.sub(repl, out)
    out = re.sub(r"\s+", " ", out).strip()
    return out[:MAX_TEXT]


def sanitize(obj, terms=(), key=None):
    """payload 전체를 재귀로 마스킹(시각 필드는 형식 검사만)."""
    if isinstance(obj, dict):
        return {str(k): sanitize(v, terms, str(k)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [sanitize(v, terms, key) for v in obj]
    if isinstance(obj, str):
        if key in TS_FIELDS:
            return obj if (obj == "" or TS_RE.match(obj)) else ""
        return mask(obj, terms)
    return obj


def find_leaks(obj, terms=(), key=None, path="$"):
    """마스킹 뒤에도 남은 식별 패턴을 찾는다. 빈 목록이어야 저장한다."""
    leaks = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            leaks += find_leaks(v, terms, str(k), path + "." + str(k))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            leaks += find_leaks(v, terms, key, "%s[%d]" % (path, i))
    elif isinstance(obj, str):
        if key in TS_FIELDS:
            if obj and not TS_RE.match(obj):
                leaks.append((path, "timestamp"))
        else:
            for name, rx, _repl in MASK_RULES:
                if rx.search(obj):
                    leaks.append((path, name))
            low = obj.lower()
            for term in terms:
                if term and term.lower() in low:
                    leaks.append((path, "term"))
    return leaks


# ---------------------------------------------------------------- 설정

APPS = {
    # key: 폴더명(홈\dev 아래), 로그 폴더, 화면 이름, 역할, 로그 문구용 라벨
    "shorts": {"dir": "shorts_app", "logs": "pc/logs", "name": "쇼츠 작업자", "role": "쇼츠 영상 제작", "label": "쇼츠 파이프라인"},
    "reels": {"dir": "reels_app", "logs": "logs", "name": "릴스 작업자", "role": "릴스 영상 제작", "label": "릴스 파이프라인"},
    "clip": {"dir": "clipmaker", "logs": "pc/logs", "name": "클립 작업자", "role": "클립 영상 제작", "label": "클립 파이프라인"},
    "carousel": {"dir": "carousel_app", "logs": "logs", "name": "캐러셀 작업자", "role": "카드 뉴스 제작", "label": "캐러셀 파이프라인", "copy": True},
    "insta": {"dir": "simri_receipt_app", "logs": "logs", "name": "인스타 콘텐츠 작업자", "role": "인스타 콘텐츠 제작", "label": "인스타 콘텐츠 파이프라인", "copy": True},
}
SERVICE_SCRIPTS = ("poller.py", "server.py", "collect.py", "bridge.py")
STAGES = {
    "source": "자료 정리", "facts": "자료 확인", "script": "대본 작성", "voice": "음성 생성",
    "audio": "음성 편집", "stt": "자막 맞추기", "render": "영상 렌더링", "qa": "품질 점검",
    "texts": "문구 정리", "drive": "결과물 정리", "log": "기록 정리",
}
COPY_STAGES = ("script", "texts")   # 카드 문구를 쓰는 단계(Claude API 호출 추정)
START_RE = re.compile(r"작업 \S+.*시작|sm\.py start|job start", re.I)
END_RE = re.compile(r"작업 \S+ ?(?:끝|완료)|sm\.py exit|\] 완성|job (?:done|end)", re.I)
MUSE_RE = re.compile(r"muse|뮤즈", re.I)
SPEECH_RE = re.compile(r"azure|speech\.microsoft|cognitiveservices|speech ?sdk|\btts\b", re.I)
STAGE_RE = re.compile(r"▶\s*([a-z_]+)")
LINE_FULL = re.compile(r"^(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) (.*)$")
LINE_TIME = re.compile(r"^(\d{2}):(\d{2}):(\d{2}) (.*)$")

DEFAULTS = {
    "dev_dir": str(Path.home() / "dev"),
    "blog_runs_dir": str(Path.home() / "aside-test" / "blog_runs"),
    "blog_teams": {},          # {"계정아이디": "A"}  -> 화면에는 '블로그팀 A' 로만 나감
    "sensitive_terms": [],     # 추가로 가릴 낱말
    "recent_call_min": 10,     # Muse·음성 합성: 최근 N분 호출 흔적이 있을 때만 활동 표시
    "blog_working_min": 15,
    "rest_min": 20,
    "scripts_dir": str(Path.home() / "aside-test" / "codex_handoff" / "scripts"),
    "agent_active_min": 4,     # 어사이드·하위 에이전트: 마지막 흔적 뒤 N분까지 '작업 중'
    "routine_window": ["01:00", "01:45"],   # 클라우드 루틴(새벽 키워드) 예정 시간대
    # ------------------------------------------------------------------------------------------
    # vooy 활동 신호 (아직 정체 미확인 -> 비워 두면 항상 '대기')
    # local/pc_watch.local.json 에 아래처럼 적으면 그때부터 화면에서 일한다(둘 중 하나만 있어도 됨).
    #   "vooy_signal": {"process": "프로세스 이름 일부", "path": "작업할 때 바뀌는 파일·폴더", "active_min": 10}
    # ------------------------------------------------------------------------------------------
    "vooy_signal": {"process": "", "path": "", "active_min": 10},
    # 실시간 채널(Cloudflare Worker). 쓰기 토큰은 환경 변수 AI_OFFICE_PUSH_TOKEN 에만 둔다(여기 적지 않는다).
    "live_url": "https://ai-office-live.btc-indicator-mobile.workers.dev/status",
    "live_heartbeat": 120,     # 내용이 같아도 이 초마다 한 번은 올려 '살아 있음'을 알린다
}

# 화면의 주인공(AI 에이전트). 피클은 data/pickle-status.json 쪽에서 온다.
CAST_INFO = {
    "claude": ("클로드", "지휘 · 관제"),
    "opus": ("Opus 보조", "블로그 슬롯 담당"),
    "fable": ("Fable", "앱 개발 담당"),
    "routine": ("클라우드 루틴", "새벽 키워드 수집"),
    "aside": ("어사이드", "브라우저 · 에디터 조작"),
    "muse": ("뮤즈", "초안 · 사진"),
    "exaone": ("엑사원", "문체 검사"),
    "speech": ("Azure Speech", "음성 합성"),
    "claudeapi": ("Claude API", "캐러셀 문구"),
    "copilot": ("Copilot", "이미지 · 가끔"),
    "chatgpt": ("ChatGPT", "검수 · 가끔"),
    "codex": ("Codex", "대행 · 현재 사용 불가"),
    "stability": ("Stability", "이미지 · 중단"),
    "vooy": ("vooy", "역할 확인 중"),
}
CAST_STATUS = ("working", "resting", "idle", "offline")


def load_cfg():
    cfg = dict(DEFAULTS)
    try:
        with open(LOCAL_CFG, encoding="utf-8-sig") as f:
            user = json.load(f)
        if isinstance(user, dict):
            cfg.update(user)
    except FileNotFoundError:
        pass
    except Exception as e:  # 깨진 설정은 무시(기본값으로)
        log.warning("로컬 설정을 읽지 못해 기본값 사용: %s", type(e).__name__)
    return cfg


def sensitive_terms(cfg, accounts=()):
    terms = set(str(t) for t in cfg.get("sensitive_terms", []) if t)
    terms.update(str(a) for a in cfg.get("blog_teams", {}) if a)
    terms.update(str(a) for a in accounts if a)
    for v in (Path.home().name, os.environ.get("USERNAME"), os.environ.get("COMPUTERNAME")):
        if v and len(v) >= 3:
            terms.add(v)
    return sorted(terms)


# ---------------------------------------------------------------- 읽기 전용 수집

def _creationflags():
    return getattr(subprocess, "CREATE_NO_WINDOW", 0)


def list_processes(extra_name=""):
    """Win32_Process 에서 자동화 관련 프로세스만(읽기 전용). extra_name = 추가로 볼 프로세스 이름 조각(vooy 신호용)."""
    extra = re.sub(r"[^A-Za-z0-9_.-]", "", str(extra_name or ""))[:40]
    extra_ps = (" -or $_.Name -like '*%s*'" % extra) if extra else ""
    ps = (
        "[Console]::OutputEncoding=[Text.Encoding]::UTF8;"
        "Get-CimInstance Win32_Process | Where-Object { (($_.Name -match "
        "'^(python|pythonw|claude|aside|aside-daemon|GoogleDriveFS|OneDrive|node|codex)(\\.exe)?$' "
        "-and $_.CommandLine -notmatch '--type=') -or ($_.Name -match '^(powershell|pwsh)(\\.exe)?$' "
        "-and $_.CommandLine -match '\\.ps1')" + extra_ps + ") } | ForEach-Object { [pscustomobject]@{ "
        "pid=$_.ProcessId; name=$_.Name; cmd=$_.CommandLine; "
        "created=$(if($_.CreationDate){$_.CreationDate.ToString('o')}else{''}) } } | ConvertTo-Json -Compress"
    )
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
            capture_output=True, timeout=40, creationflags=_creationflags())
        txt = r.stdout.decode("utf-8", errors="replace").strip()
        if not txt:
            return []
        data = json.loads(txt)
        if isinstance(data, dict):
            data = [data]
        return [{"pid": d.get("pid"), "name": d.get("name") or "", "cmd": d.get("cmd") or "",
                 "created": d.get("created") or ""} for d in data if isinstance(d, dict)]
    except Exception as e:
        log.warning("프로세스 목록 실패: %s", type(e).__name__)
        return []


def mtime(path):
    try:
        return datetime.fromtimestamp(os.stat(path).st_mtime, KST)
    except OSError:
        return None


def tail_text(path, max_bytes=200_000):
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - max_bytes))
            return f.read().decode("utf-8", errors="replace")
    except OSError:
        return ""


def parse_log_lines(text, file_mtime, now):
    """(시각, 내용) 목록. 'MM-DD HH:MM:SS 내용' 또는 'HH:MM:SS 내용'."""
    out = []
    for line in text.splitlines():
        m = LINE_FULL.match(line)
        try:
            if m:
                dt = datetime(now.year, int(m.group(1)), int(m.group(2)), int(m.group(3)),
                              int(m.group(4)), int(m.group(5)), tzinfo=KST)
                if dt > now + timedelta(days=2):
                    dt = dt.replace(year=now.year - 1)
                out.append((dt, m.group(6)))
                continue
            m = LINE_TIME.match(line)
            if m and file_mtime:
                dt = file_mtime.replace(hour=int(m.group(1)), minute=int(m.group(2)),
                                        second=int(m.group(3)), microsecond=0)
                if dt > file_mtime + timedelta(minutes=2):
                    dt -= timedelta(days=1)
                out.append((dt, m.group(4)))
        except ValueError:
            continue
    return out


_LOG_CACHE = {}


def cached_log_lines(path, file_mtime, now):
    """같은 로그를 20초마다 다시 읽지 않게: 수정 시각이 같으면 지난 결과를 쓴다."""
    key = str(path)
    hit = _LOG_CACHE.get(key)
    if hit and hit[0] == file_mtime:
        return hit[1]
    lines = parse_log_lines(tail_text(path), file_mtime, now)
    if len(_LOG_CACHE) > 200:
        _LOG_CACHE.clear()
    _LOG_CACHE[key] = (file_mtime, lines)
    return lines


def collect_app(spec, dev_dir, procs, now):
    base = Path(dev_dir) / spec["dir"]
    logs_dir = base / spec["logs"]
    info = {"exists": base.is_dir(), "poller": False, "job_procs": 0, "current_job": False,
            "current_job_mtime": None, "events": [], "stage": None, "stage_time": None,
            "muse": [], "speech": [], "copy": [], "last_log": None}
    needle = ("\\dev\\" + spec["dir"] + "\\").lower()
    for p in procs:
        cmd = p["cmd"].replace("/", "\\").lower()
        if needle in cmd and p["name"].lower().startswith("python"):
            if "poller.py" in cmd:
                info["poller"] = True
            elif not any(sv in cmd for sv in SERVICE_SCRIPTS):
                info["job_procs"] += 1
    if not logs_dir.is_dir():
        return info
    cj = logs_dir / "current_job.json"
    try:
        if cj.is_file() and cj.stat().st_size < 65536:
            with open(cj, encoding="utf-8-sig") as f:
                info["current_job"] = bool(json.load(f))
            info["current_job_mtime"] = mtime(cj)
    except Exception:
        pass
    files = []
    for f in logs_dir.glob("*.log"):
        mt = mtime(f)
        if mt and now - mt < timedelta(hours=36):
            files.append((mt, f))
    files.sort(reverse=True)
    seen = set()
    for mt, f in files[:8]:
        if info["last_log"] is None or mt > info["last_log"]:
            info["last_log"] = mt
        for dt, rest in cached_log_lines(f, mt, now):
            sm = STAGE_RE.search(rest)
            if sm and (info["stage_time"] is None or dt >= info["stage_time"]):
                info["stage"], info["stage_time"] = sm.group(1), dt
            if sm and sm.group(1) == "voice":
                info["speech"].append(dt)
            if sm and sm.group(1) in COPY_STAGES and spec.get("copy"):
                info["copy"].append(dt)
            kind = "start" if START_RE.search(rest) else ("end" if END_RE.search(rest) else None)
            if kind and (dt, kind) not in seen:
                seen.add((dt, kind))
                info["events"].append((dt, kind))
            if MUSE_RE.search(rest) and "요청" in rest:
                info["muse"].append(dt)
            if SPEECH_RE.search(rest):
                info["speech"].append(dt)
    info["events"].sort()
    return info


BLOG_DIR_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})_(.+)_slot(\d{1,2})")

# AI 에이전트별 활동 신호(이름만 본다. 내용은 읽지 않는다)
#   proc = 실행 중인 명령줄, run = 오늘 블로그 작업 폴더의 파일 이름, scr = 스크립트 폴더의 임시 파일 이름
SIG_RULES = {
    "aside": {"proc": re.compile(r"(?i)(?:^|[\\/\s\"'])(?:ar\d*|drive\d*|ed_run\w*)\.ps1|\baside(?:\.exe|\.cmd)?\"?\s+repl\b"),
              "run": re.compile(r"(?i)^editor_log"), "scr": re.compile(r"(?i)^_ed_now")},
    "muse": {"proc": re.compile(r"(?i)muse_\w+\.(?:ps1|js)"), "run": re.compile(r"(?i)muse"), "scr": re.compile(r"(?i)^_muse")},
    "exaone": {"proc": re.compile(r"(?i)exaone\w*\.py"), "run": re.compile(r"(?i)^ai_check|exaone"), "scr": re.compile(r"(?i)^_exaone")},
    "chatgpt": {"proc": re.compile(r"(?i)gpt_(?:send|get)"), "run": re.compile(r"(?i)(?:^|_)gpt"), "scr": re.compile(r"(?i)^_gpt")},
    "copilot": {"proc": re.compile(r"(?i)copilot\w*\.(?:ps1|js|py)"), "run": re.compile(r"(?i)copilot"), "scr": re.compile(r"(?i)^_copilot")},
    "codex": {"proc": re.compile(r"(?i)(?:^|[\\/\"\s])codex(?:\.cmd|\.exe|\.js)?(?:[\"\s]|$)|@openai[\\/]codex")},
}


def note_signal(sig, kind, name, when):
    """이름이 규칙에 맞으면 그 에이전트의 '마지막 흔적 시각'을 갱신한다."""
    for aid, rules in SIG_RULES.items():
        rx = rules.get(kind)
        if rx and rx.search(name) and (aid not in sig or when > sig[aid]):
            sig[aid] = when


def collect_signals(cfg, procs, blog, now):
    """에이전트별 {'running': 지금 실행 중, 'last': 마지막 흔적, 'scr_last': 요청 쪽 흔적, 'run_last': 결과 쪽 흔적}."""
    run_last = dict(blog.get("sig") or {})
    scr_last = {}
    try:
        for e in os.scandir(cfg["scripts_dir"]):
            if e.is_file():
                mt = mtime(e.path)
                if mt:
                    note_signal(scr_last, "scr", e.name, mt)
    except OSError:
        pass
    mt = mtime(Path(cfg["scripts_dir"]).parent / "EXAONE_STATE.txt")
    if mt and ("exaone" not in run_last or mt > run_last["exaone"]):
        run_last["exaone"] = mt
    out = {}
    for aid, rules in SIG_RULES.items():
        running = any(rules["proc"].search(p["cmd"]) or (aid == "codex" and p["name"].lower().startswith("codex"))
                      for p in procs)
        last = max([t for t in (run_last.get(aid), scr_last.get(aid)) if t], default=None)
        out[aid] = {"running": running, "last": now if running else last,
                    "scr_last": scr_last.get(aid), "run_last": run_last.get(aid)}
    return out


def collect_subagents(now):
    """Claude 하위 에이전트 기록의 수정 시각만 본다. 종류는 meta 의 model 값(fable 여부)만 읽는다."""
    out = {"fable": None, "opus": None}
    proj = Path.home() / ".claude" / "projects"
    try:
        for d in os.scandir(proj):
            if not d.is_dir():
                continue
            for sess in os.scandir(d.path):
                if not sess.is_dir():
                    continue
                sub = os.path.join(sess.path, "subagents")
                if not os.path.isdir(sub):
                    continue
                for f in os.scandir(sub):
                    if not f.name.endswith(".jsonl"):
                        continue
                    mt = mtime(f.path)
                    if not mt or mt.date() != now.date():
                        continue
                    kind = "opus"
                    try:
                        meta = f.path[:-6] + ".meta.json"
                        if os.path.getsize(meta) < 8192:
                            with open(meta, encoding="utf-8-sig") as fh:
                                if "fable" in str(json.load(fh).get("model", "")).lower():
                                    kind = "fable"
                    except Exception:
                        pass
                    if out[kind] is None or mt > out[kind]:
                        out[kind] = mt
    except OSError:
        pass
    return out


def collect_vooy(cfg, procs, now):
    """vooy 는 아직 정체를 모른다. local/pc_watch.local.json 의 vooy_signal 에 신호를 적으면 그때부터 움직인다."""
    v = cfg.get("vooy_signal") or {}
    if not isinstance(v, dict):
        v = {}
    name = str(v.get("process") or "").lower()
    running = bool(name) and any(name in p["name"].lower() or name in p["cmd"].lower() for p in procs)
    last = None
    path = str(v.get("path") or "")
    if path:
        last = mtime(path)
        try:
            if os.path.isdir(path):
                for c in os.scandir(path):
                    mt = mtime(c.path)
                    if mt and (last is None or mt > last):
                        last = mt
        except OSError:
            pass
    return {"configured": bool(name or path), "running": running, "last": now if running else last}


def collect_blog(blog_dir, now):
    """블로그 작업 폴더·기록. 제목·키워드 열은 아예 읽어 들이지 않는다."""
    blog_dir = Path(blog_dir)
    out = {"exists": blog_dir.is_dir(), "today_dirs": [], "rows_today": [], "accounts": set(),
           "run_log_mtime": None, "schedule_mtime": None, "sig": {}}
    if not out["exists"]:
        return out
    today = now.strftime("%Y-%m-%d")
    try:
        for e in os.scandir(blog_dir):
            if not e.is_dir():
                continue
            m = BLOG_DIR_RE.match(e.name)
            if not m:
                continue
            out["accounts"].add(m.group(2))
            if m.group(1) != today:
                continue
            latest = mtime(e.path)
            start = None
            try:
                for c in os.scandir(e.path):
                    mt = mtime(c.path)
                    if mt and (latest is None or mt > latest):
                        latest = mt
                    if mt and c.name.lower() == "start_time.txt":
                        start = mt
                    if mt:   # 파일 '이름'만 본다(내용은 읽지 않는다)
                        note_signal(out["sig"], "run", c.name, mt)
            except OSError:
                pass
            out["today_dirs"].append({"account": m.group(2), "slot": m.group(3), "mtime": latest, "start": start})
    except OSError:
        pass
    rl = blog_dir / "run_log.csv"
    out["run_log_mtime"] = mtime(rl)
    out["schedule_mtime"] = mtime(blog_dir / "schedule_log.csv")
    text = tail_text(rl, 400_000)
    if text:
        try:
            with open(rl, encoding="utf-8-sig", errors="replace") as f:
                header = next(csv.reader(io.StringIO(f.readline())), [])
            idx = {name: i for i, name in enumerate(header)}
            ti, ai, si = idx.get("실행시각"), idx.get("계정"), idx.get("저장결과")
            if ti is not None and ai is not None:
                for row in csv.reader(io.StringIO(text)):
                    if len(row) <= max(ti, ai):
                        continue
                    when = row[ti].strip()
                    if not re.match(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}", when):
                        continue
                    out["accounts"].add(row[ai].strip())
                    if when[:10] != today:
                        continue
                    dt = datetime.strptime(when[:16], "%Y-%m-%d %H:%M").replace(tzinfo=KST)
                    saved = bool(si is not None and len(row) > si and "임시저장" in row[si])
                    out["rows_today"].append({"time": dt, "account": row[ai].strip(), "saved": saved})
        except Exception as e:
            log.warning("블로그 기록 읽기 실패: %s", type(e).__name__)
    return out


def collect(cfg, now=None):
    now = now or datetime.now(KST)
    vs = cfg.get("vooy_signal") if isinstance(cfg.get("vooy_signal"), dict) else {}
    procs = list_processes(vs.get("process") or "")
    dev = Path(cfg["dev_dir"])
    raw = {"now": now, "procs": procs, "apps": {}, "blog": collect_blog(cfg["blog_runs_dir"], now)}
    for key, spec in APPS.items():
        raw["apps"][key] = collect_app(spec, dev, procs, now)
    raw["signals"] = collect_signals(cfg, procs, raw["blog"], now)
    raw["subagents"] = collect_subagents(now)
    raw["vooy"] = collect_vooy(cfg, procs, now)
    # Claude 세션 기록의 최근 수정 시각(내용은 읽지 않음)
    latest = None
    proj = Path.home() / ".claude" / "projects"
    try:
        for d in os.scandir(proj):
            if d.is_dir():
                for f in os.scandir(d.path):
                    if f.name.endswith(".jsonl"):
                        mt = mtime(f.path)
                        if mt and (latest is None or mt > latest):
                            latest = mt
    except OSError:
        pass
    raw["claude_session"] = latest
    # TV 브리지
    tv_dir = dev / "tv_voice" / "pc"
    tv_log = tv_dir / "bridge.log"
    cmds = [dt for dt, rest in parse_log_lines(tail_text(tv_log, 60_000), mtime(tv_log), now) if rest.startswith("명령")]
    raw["tv"] = {"exists": tv_dir.is_dir(), "log_mtime": mtime(tv_log), "last_cmd": max(cmds) if cmds else None}
    # 수집기
    raw["pubcheck"] = {"log_mtime": mtime(dev / "publish_check_app" / "collector" / "logs" / "collect.log")}
    raw["insight"] = {"log_mtime": mtime(dev / "insight_app" / "collector" / "collect_log.txt")}
    # 동기화 폴더는 존재 여부만
    home = Path.home()
    raw["drive"] = {
        "onedrive_folder": (home / "OneDrive").is_dir(),
        "gdrive_folder": any((home / n).is_dir() for n in ("Google Drive", "My Drive", "내 드라이브")) or Path("G:/").exists(),
    }
    return raw


# ---------------------------------------------------------------- 상태 만들기(순수 함수)

def iso(dt):
    return dt.astimezone(KST).replace(microsecond=0).isoformat() if dt else ""


def _has_proc(procs, name_prefix=None, cmd_part=None):
    for p in procs:
        name = p["name"].lower()
        cmd = p["cmd"].replace("/", "\\").lower()
        if name_prefix and not name.startswith(name_prefix):
            continue
        if cmd_part and cmd_part not in cmd:
            continue
        return True
    return False


def team_labels(cfg, accounts):
    """계정 -> '블로그팀 X'. 설정에 없으면 남는 글자를 이름순으로 배정."""
    teams = {str(k): str(v) for k, v in cfg.get("blog_teams", {}).items()}
    used = set(teams.values())
    letters = [c for c in "ABCDEFGHJKLMNPQRSTUVWXYZ" if c not in used]
    for acc in sorted(a for a in accounts if a and a not in teams):
        teams[acc] = letters.pop(0) if letters else "Z"
    return teams


def build_status(raw, cfg, events=None):
    now = raw["now"]
    today = now.date()
    recent = timedelta(minutes=int(cfg.get("recent_call_min", 10)))
    rest_for = timedelta(minutes=int(cfg.get("rest_min", 20)))
    blog_work = timedelta(minutes=int(cfg.get("blog_working_min", 15)))
    procs = raw["procs"]
    agents, logs = [], []
    done_total = 0

    def add(aid, name, role, status, zone, bubble, task, last):
        agents.append({"id": aid, "name": name, "role": role, "status": status, "zone": zone,
                       "bubble": bubble, "task": task, "last_active": iso(last)})

    def add_log(dt, aid, title, detail):
        if dt and dt.date() == today:
            logs.append({"time": iso(dt), "agent": aid, "title": title, "detail": detail})

    # --- 블로그팀
    blog = raw["blog"]
    cfg_accounts = list(cfg.get("blog_teams", {}).keys())
    today_accounts = {d["account"] for d in blog["today_dirs"]} | {r["account"] for r in blog["rows_today"]}
    teams = team_labels(cfg, set(cfg_accounts) | today_accounts)
    any_blog_working = False
    for acc in sorted(set(cfg_accounts) | today_accounts, key=lambda a: teams[a]):
        letter = teams[acc]
        aid = "blog-" + letter.lower()
        dirs = [d for d in blog["today_dirs"] if d["account"] == acc and d["mtime"]]
        rows = [r for r in blog["rows_today"] if r["account"] == acc]
        saved = [r for r in rows if r["saved"]]
        done_total += len(saved)
        last_dir = max((d["mtime"] for d in dirs), default=None)
        last_row = max((r["time"] for r in rows), default=None)
        last = max([t for t in (last_dir, last_row) if t], default=None)
        if last_dir and now - last_dir <= blog_work:
            st, zone, bubble, task = "working", "desk", "원고 작성·검수 중", "블로그 원고 1건 작성·검수 중"
            any_blog_working = True
        elif last_dir and now - last_dir <= blog_work + rest_for and saved:
            st, zone, bubble, task = "resting", "lounge", "임시저장 끝, 잠깐 휴식", "블로그 원고 1건 임시저장 완료"
        else:
            st, zone, bubble = "idle", "desk", "다음 슬롯 대기"
            task = "오늘 원고 %d건 임시저장 · 다음 슬롯 대기" % len(saved) if saved else "다음 슬롯 대기"
        add(aid, "블로그팀 " + letter, "블로그 원고 작성", st, zone, bubble, task, last)
        for r in saved:
            add_log(r["time"], aid, "블로그 원고 1건 임시저장", "블로그팀 %s · 초안·검수 후 임시저장" % letter)

    # --- 영상·카드 작업자
    muse_calls, speech_calls, copy_calls = [], [], []
    for key, spec in APPS.items():
        info = raw["apps"].get(key)
        if not info or not info["exists"]:
            continue
        muse_calls += info["muse"]
        speech_calls += info["speech"]
        copy_calls += info.get("copy", [])
        ev = info["events"]
        last_start = max((t for t, k in ev if k == "start"), default=None)
        last_end = max((t for t, k in ev if k == "end"), default=None)
        done = sum(1 for t, k in ev if k == "end" and t.date() == today)
        done_total += done
        cj_fresh = info["current_job"] and info["current_job_mtime"] and now - info["current_job_mtime"] < timedelta(minutes=45)
        open_job = last_start and (not last_end or last_end < last_start) and now - last_start < timedelta(minutes=90)
        working = info["job_procs"] > 0 or cj_fresh or (open_job and info["poller"])
        last = max([t for t in (last_start, last_end, info["stage_time"]) if t], default=None)
        if working:
            stage = STAGES.get(info["stage"] or "") if info["stage_time"] and now - info["stage_time"] < timedelta(hours=2) else None
            bubble = (stage + " 중") if stage else "작업 진행 중"
            task = "%s 1건 진행 중%s" % (spec["label"], " · " + stage if stage else "")
            add(key, spec["name"], spec["role"], "working", "desk", bubble, task, last or now)
        elif last_end and now - last_end <= rest_for:
            add(key, spec["name"], spec["role"], "resting", "lounge", "한 건 끝! 잠깐 휴식", "%s 1건 완료" % spec["label"], last)
        elif info["poller"]:
            add(key, spec["name"], spec["role"], "idle", "desk", "새 요청 기다리는 중", "대기 · 새 요청 확인 중", last)
        else:
            add(key, spec["name"], spec["role"], "offline", "lounge", "", "실행 중 아님", last)
        for t, k in ev:
            if k == "start":
                add_log(t, key, "%s 작업 시작" % spec["label"], "요청을 받아 제작을 시작")
            else:
                add_log(t, key, "%s 1건 완료" % spec["label"], "제작 단계를 마침")

    # --- AI 에이전트(주인공). 문구는 전부 아래 고정 문장.
    sig = raw.get("signals") or {}
    subs = raw.get("subagents") or {}
    act = timedelta(minutes=int(cfg.get("agent_active_min", 4)))
    cast = []

    def fresh(dt, win):
        return bool(dt and now - dt <= win)

    def s_last(key):
        return (sig.get(key) or {}).get("last")

    def s_on(key, win):
        return bool((sig.get(key) or {}).get("running")) or fresh(s_last(key), win)

    def add_cast(cid, status, bubble, task, last, ask=""):
        name, role = CAST_INFO[cid]
        if status == "idle" and fresh(last, rest_for):   # 방금 일을 마쳤으면 휴게실에서 쉬는 모습
            status, bubble = "resting", "방금 마침 · 휴식"
        cast.append({"id": cid, "name": name, "role": role, "status": status, "bubble": bubble, "task": task,
                     "last_active": iso(last)})

    def today_or(dt, yes, no):
        return yes if (dt and dt.date() == today) else no

    # 뮤즈: 블로그 초안·사진(스크립트 흔적) 또는 영상 대본·음성(앱 로그)
    last_muse_app = max(muse_calls, default=None)
    muse_last = max([t for t in (s_last("muse"), last_muse_app) if t], default=None)
    if s_on("muse", recent):
        add_cast("muse", "working", "초안·사진 작업 중", "블로그 초안·사진 요청 처리 중", muse_last)
    elif fresh(last_muse_app, recent):
        add_cast("muse", "working", "대본·음성 작업 중", "영상 대본·음성 요청 처리 중", muse_last)
    else:
        add_cast("muse", "idle", "호출 대기", today_or(muse_last, "오늘 호출 기록 있음 · 대기", "최근 호출 없음 · 대기"), muse_last)
    for t in sorted(set(muse_calls)):
        add_log(t, "muse", "외부 AI 요청 1건", "대본 또는 음성 생성 요청")

    # 어사이드: REPL·에디터 스크립트 실행 또는 방금 남은 에디터 기록
    if s_on("aside", act):
        if any_blog_working:
            add_cast("aside", "working", "에디터 입력 중", "블로그 에디터 입력·임시저장 진행 중", s_last("aside"))
        else:
            add_cast("aside", "working", "웹 화면 조작 중", "브라우저 웹 작업 진행 중", s_last("aside"))
    elif _has_proc(procs, "aside"):
        add_cast("aside", "idle", "요청 대기", "대기 · 브라우저 켜져 있음", s_last("aside"))
    else:
        add_cast("aside", "offline", "", "실행 중 아님", s_last("aside"))

    # 엑사원·ChatGPT·Copilot: 스크립트 흔적이 최근일 때만
    for cid, bub, task, idle_task, title in (
            ("exaone", "문체 검사 중", "원고 문체 검사 진행 중", "검사 요청 대기", "클로드 → 엑사원: 문체 검사 요청"),
            ("chatgpt", "검수 진행 중", "원고 검수 요청 처리 중", "가끔 호출 · 대기", "클로드 → ChatGPT: 검수 요청"),
            ("copilot", "이미지 생성 중", "이미지 요청 처리 중", "가끔 호출 · 대기", "클로드 → Copilot: 이미지 요청")):
        if s_on(cid, recent):
            add_cast(cid, "working", bub, task, s_last(cid))
        else:
            add_cast(cid, "idle", "호출 대기", idle_task, s_last(cid))

    # Azure Speech: 영상 앱의 음성 단계 / Claude API: 카드 문구 단계
    last_sp = max(speech_calls, default=None)
    if fresh(last_sp, recent):
        add_cast("speech", "working", "음성 합성 중", "음성 합성 요청 처리 중", last_sp)
    else:
        add_cast("speech", "idle", "호출 대기", today_or(last_sp, "오늘 호출 기록 있음 · 대기", "최근 호출 없음 · 대기"), last_sp)
    last_copy = max(copy_calls, default=None)
    if fresh(last_copy, recent):
        add_cast("claudeapi", "working", "카드 문구 작성 중", "캐러셀 문구 작성 요청 처리 중", last_copy)
    else:
        add_cast("claudeapi", "idle", "호출 대기", today_or(last_copy, "오늘 호출 기록 있음 · 대기", "최근 호출 없음 · 대기"), last_copy)

    # Codex(현재 사용 불가) · Stability(중단)
    if (sig.get("codex") or {}).get("running"):
        add_cast("codex", "working", "대행 작업 중", "대행 작업 진행 중", now)
    else:
        add_cast("codex", "offline", "", "현재 사용 불가", None)
    add_cast("stability", "offline", "", "사용 중단", None)

    # 하위 에이전트: 기록 파일이 방금 바뀌었으면 작업 중
    working_ids = {c["id"] for c in cast if c["status"] == "working"}
    opus_last, fable_last = subs.get("opus"), subs.get("fable")
    if fresh(opus_last, act):
        ask = next((x for x in ("muse", "exaone", "aside", "chatgpt") if x in working_ids), "")
        if any_blog_working:
            add_cast("opus", "working", "블로그 슬롯 작업 중", "블로그 슬롯 원고 작업 진행 중", opus_last, ask)
        else:
            add_cast("opus", "working", "맡은 작업 진행 중", "지시받은 작업 진행 중", opus_last, ask)
    else:
        add_cast("opus", "idle", "지시 대기", today_or(opus_last, "오늘 작업 기록 있음 · 대기", "지시 대기"), opus_last)
    if fresh(fable_last, act):
        add_cast("fable", "working", "앱·화면 개발 중", "앱 개발 작업 진행 중", fable_last)
    else:
        add_cast("fable", "idle", "지시 대기", today_or(fable_last, "오늘 작업 기록 있음 · 대기", "지시 대기"), fable_last)

    # 클라우드 루틴: 흔적을 볼 수 없어 예정 시간대로만 표시
    try:
        w0, w1 = [datetime.strptime(str(x), "%H:%M").time() for x in cfg.get("routine_window", ["01:00", "01:45"])[:2]]
    except Exception:
        w0, w1 = datetime.strptime("01:00", "%H:%M").time(), datetime.strptime("01:45", "%H:%M").time()
    if w0 <= now.time() <= w1:
        add_cast("routine", "working", "새벽 키워드 수집 중", "예정 시간대 기준 표시 · 키워드 수집", None)
    else:
        add_cast("routine", "idle", "다음 새벽 대기", "다음 새벽 실행 대기", None)

    # vooy: 설정한 신호가 있을 때만 움직인다(기본 대기)
    vooy = raw.get("vooy") or {}
    vcfg = cfg.get("vooy_signal") if isinstance(cfg.get("vooy_signal"), dict) else {}
    try:
        vwin = timedelta(minutes=int(vcfg.get("active_min", 10)))
    except (TypeError, ValueError):
        vwin = timedelta(minutes=10)
    if vooy.get("configured") and (vooy.get("running") or fresh(vooy.get("last"), vwin)):
        add_cast("vooy", "working", "작업 중", "작업 진행 중", vooy.get("last"))
    elif vooy.get("configured"):
        add_cast("vooy", "idle", "대기 중", "대기", vooy.get("last"))
    else:
        add_cast("vooy", "idle", "대기 중", "활동 신호 미설정 · 대기", None)

    # 클로드: 세션이 방금까지 움직였으면 지휘 중. 지금 일하는 에이전트 하나를 '지시 대상'으로.
    cs = raw.get("claude_session")
    claude_on = _has_proc(procs, "claude")
    working_ids = [c["id"] for c in cast if c["status"] == "working"]
    order = ("opus", "fable", "muse", "aside", "exaone", "chatgpt", "copilot", "claudeapi", "speech", "codex", "vooy")
    target = next((x for x in order if x in working_ids), "")
    name, role = CAST_INFO["claude"]
    if claude_on and fresh(cs, timedelta(minutes=5)):
        me = {"status": "working", "bubble": "작업 지시 중" if target else "작업 진행 중",
              "task": "지시받은 작업 지휘 중 · AI %d명 가동" % len(working_ids) if working_ids else "지시받은 작업 진행 중"}
    elif claude_on:
        me = {"status": "idle", "bubble": "지시 대기", "task": "대기 · 다음 지시 확인 중"}
    else:
        me = {"status": "offline", "bubble": "", "task": "실행 중 아님"}
        target = ""
    cast.insert(0, dict({"id": "claude", "name": name, "role": role}, last_active=iso(cs), **me))

    tv = raw.get("tv") or {}
    if tv.get("exists"):
        tv_on = _has_proc(procs, "python", "bridge.py")
        # 공개 페이지에 사용 시각이 드러나지 않게: 실행 여부만, 상태는 항상 대기, 마지막 활동 시각도 비움
        if tv_on:
            add("tv", "TV 리모컨 브리지", "음성 명령 안내", "idle", "reception", "대기 중", "대기", None)
        else:
            add("tv", "TV 리모컨 브리지", "음성 명령 안내", "offline", "reception", "", "실행 중 아님", None)

    pm = (raw.get("pubcheck") or {}).get("log_mtime")
    if pm:
        if _has_proc(procs, "python", "\\publish_check_app\\"):
            if now - pm <= timedelta(minutes=3):
                add("pubcheck", "발행 체크 수집기", "발행 현황 수집", "working", "reception", "발행 현황 수집 중", "발행 현황 수집 중", pm)
            else:
                add("pubcheck", "발행 체크 수집기", "발행 현황 수집", "idle", "reception", "다음 수집 대기", "대기 · 주기 수집", pm)
        else:
            add("pubcheck", "발행 체크 수집기", "발행 현황 수집", "offline", "reception", "", "실행 중 아님", pm)
    im = (raw.get("insight") or {}).get("log_mtime")
    if im:
        if now - im <= timedelta(minutes=5):
            add("insight", "인사이트 수집기", "채널 지표 수집", "working", "desk", "지표 수집 중", "채널 지표 수집 중", im)
        elif im.date() == today:
            add("insight", "인사이트 수집기", "채널 지표 수집", "idle", "lounge", "오늘 수집 완료", "오늘 수집 완료 · 대기", im)
            add_log(im, "insight", "채널 지표 수집 1회 완료", "하루 지표 수집")
        else:
            add("insight", "인사이트 수집기", "채널 지표 수집", "offline", "lounge", "", "오늘 수집 기록 없음", im)

    logs.sort(key=lambda l: l["time"], reverse=True)
    payload = {
        "updated_at": iso(now),
        "source": "pc",
        "summary": {
            "done_today": done_total,
            "working": sum(1 for c in cast if c["status"] == "working"),
            "idle": sum(1 for c in cast if c["status"] != "working"),
        },
        "cast": cast,
        "events": [dict(e) for e in (events or [])][:30],
        "agents": agents,
        "logs": logs[:40],
    }
    accounts = set(blog.get("accounts", ())) | set(cfg_accounts) | today_accounts
    terms = sensitive_terms(cfg, accounts)
    payload = sanitize(payload, terms)
    return payload, terms


# ---------------------------------------------------------------- 사건(실제로 감지한 지시·호출만)

# 시각 표식: 파일 수정 시각이 새로 찍히면 사건 1건(시각은 대략 -> coarse)
#   key: (종류, 보낸 쪽, 받는 쪽, 문구)   보낸 쪽 "@lead" = 그때 일하던 지휘자(Opus 보조가 돌고 있으면 Opus 보조, 아니면 클로드)
TIME_EVENTS = {
    "muse_req": ("dispatch", "@lead", "muse", "%s → 뮤즈: 초안·사진 요청"),
    "muse_got": ("report", "muse", "@lead", "뮤즈 → %s: 초안 전달"),
    "muse_app": ("note", "", "muse", "영상 편집실 → 뮤즈: 대본·음성 요청"),
    "aside_run": ("dispatch", "@lead", "aside", "%s → 어사이드: 에디터 입력 지시"),
    "aside_done": ("report", "aside", "@lead", "어사이드 → %s: 에디터 입력 기록"),
    "exaone": ("dispatch", "@lead", "exaone", "%s → 엑사원: 문체 검사 요청"),
    "chatgpt": ("dispatch", "@lead", "chatgpt", "%s → ChatGPT: 검수 요청"),
    "copilot": ("dispatch", "@lead", "copilot", "%s → Copilot: 이미지 요청"),
    "speech": ("note", "", "speech", "영상 편집실 → Azure Speech: 음성 합성"),
    "claudeapi": ("note", "", "claudeapi", "캐러셀 작업대 → Claude API: 문구 작성"),
}
# 상태 표식: 꺼짐->켜짐(on) / 켜짐->꺼짐(off) 을 감시 주기 사이에 직접 본 것(시각이 비교적 정확)
FLAG_EVENTS = {
    "claude_on": {"on": ("note", "", "claude", "클로드: 작업 시작"), "off": ("note", "", "claude", "클로드: 작업 마침 · 대기")},
    "opus_on": {"on": ("dispatch", "claude", "opus", "클로드 → Opus 보조: 작업 배정"),
                "off": ("report", "opus", "claude", "Opus 보조 → 클로드: 작업 보고")},
    "fable_on": {"on": ("dispatch", "claude", "fable", "클로드 → Fable: 개발 작업 배정"),
                 "off": ("report", "fable", "claude", "Fable → 클로드: 작업 보고")},
    "aside_proc": {"on": ("dispatch", "@lead", "aside", "%s → 어사이드: 화면 작업 지시")},
    "muse_proc": {"on": ("dispatch", "@lead", "muse", "%s → 뮤즈: 요청 전송")},
    "codex_on": {"on": ("dispatch", "claude", "codex", "클로드 → Codex: 대행 작업 지시")},
    "routine_on": {"on": ("note", "", "routine", "클라우드 루틴: 새벽 키워드 실행 시간")},
    "vooy_on": {"on": ("note", "", "vooy", "vooy: 작업 시작")},
}
MEETING_MEMBERS = ["claude", "opus", "aside", "muse"]


def event_marks(raw, cfg):
    """사건 감지용 표식. times = {이름: 시각}, flags = {이름: 켜짐 여부}, saved = 오늘 임시저장 건수."""
    now = raw["now"]
    act = timedelta(minutes=int(cfg.get("agent_active_min", 4)))
    sig = raw.get("signals") or {}
    subs = raw.get("subagents") or {}

    def g(aid, key):
        return (sig.get(aid) or {}).get(key)

    def fresh(dt, win):
        return bool(dt and now - dt <= win)
    times = {
        "muse_req": g("muse", "scr_last"), "muse_got": g("muse", "run_last"),
        "aside_run": g("aside", "scr_last"), "aside_done": g("aside", "run_last"),
        "exaone": g("exaone", "scr_last") or g("exaone", "run_last"),
        "chatgpt": g("chatgpt", "scr_last") or g("chatgpt", "run_last"),
        "copilot": g("copilot", "scr_last") or g("copilot", "run_last"),
    }
    muse_app, speech, copy = [], [], []
    for info in (raw.get("apps") or {}).values():
        muse_app += info.get("muse", [])
        speech += info.get("speech", [])
        copy += info.get("copy", [])
    times["muse_app"] = max(muse_app, default=None)
    times["speech"] = max(speech, default=None)
    times["claudeapi"] = max(copy, default=None)
    for d in (raw.get("blog") or {}).get("today_dirs", []):
        if d.get("start"):
            times["slot@" + iso(d["start"])] = d["start"]
    try:
        w0, w1 = [datetime.strptime(str(x), "%H:%M").time() for x in cfg.get("routine_window", ["01:00", "01:45"])[:2]]
        routine_on = w0 <= now.time() <= w1
    except Exception:
        routine_on = False
    vooy = raw.get("vooy") or {}
    flags = {
        "claude_on": _has_proc(raw.get("procs") or [], "claude") and fresh(raw.get("claude_session"), timedelta(minutes=5)),
        "opus_on": fresh(subs.get("opus"), act),
        "fable_on": fresh(subs.get("fable"), act),
        "aside_proc": bool(g("aside", "running")),
        "muse_proc": bool(g("muse", "running")),
        "codex_on": bool(g("codex", "running")),
        "routine_on": routine_on,
        "vooy_on": bool(vooy.get("configured") and vooy.get("running")),
    }
    saved = sum(1 for r in (raw.get("blog") or {}).get("rows_today", []) if r.get("saved"))
    return {"times": {k: v for k, v in times.items() if v}, "flags": flags, "saved": saved}


def derive_events(prev, marks, now):
    """지난 표식과 지금 표식을 비교해 새 사건 목록을 만든다(순수 함수).
    prev 가 None(감시 시작 직후)이면 오늘 찍힌 시각 표식만 '대략' 사건으로 되살린다."""
    out = []
    # 되살린 옛 사건은 누가 시켰는지 알 수 없으니 지휘자(클로드)로만 적는다
    lead = "opus" if (prev is not None and marks["flags"].get("opus_on")) else "claude"

    def make(spec, when, coarse, members=None):
        kind, frm, to, title = spec
        frm = lead if frm == "@lead" else frm
        to = lead if to == "@lead" else to
        if "%s" in title:
            title = title % CAST_INFO[lead][0]
        ev = {"time": iso(when), "kind": kind, "from": frm, "to": to, "title": title, "coarse": bool(coarse)}
        if members:
            ev["members"] = list(members)
        out.append(ev)

    ptimes = (prev or {}).get("times", {})
    for key, when in marks["times"].items():
        if when.date() != now.date() or ptimes.get(key) == when:
            continue
        if key.startswith("slot@"):
            make(("meeting", "claude", "", "회의 시작: 블로그 슬롯"), when, True, MEETING_MEMBERS)
        elif key in TIME_EVENTS:
            make(TIME_EVENTS[key], when, True)
    if prev is not None:
        pflags = prev.get("flags", {})
        for key, on in marks["flags"].items():
            if key in pflags and pflags[key] != on:
                spec = FLAG_EVENTS.get(key, {}).get("on" if on else "off")
                if spec:
                    make(spec, now, False)
        if marks.get("saved", 0) > prev.get("saved", 0):
            make(("report", "aside", "claude", "어사이드 → 클로드: 임시저장 1건 완료"), now, False)
    out.sort(key=lambda e: e["time"], reverse=True)
    return out


def merge_events(old, new, now, keep=30):
    """새 사건을 앞에 붙이고 오늘 것만 keep 개 남긴다."""
    today = iso(now)[:10]
    seen, out = set(), []
    for e in list(new) + list(old or []):
        key = (e["time"], e["title"])
        if key in seen or e["time"][:10] != today:
            continue
        seen.add(key)
        out.append(e)
    out.sort(key=lambda e: e["time"], reverse=True)
    return out[:keep]


def signature(payload):
    """갱신 시각을 뺀 내용 서명(바뀌었는지 비교용)."""
    slim = {k: v for k, v in payload.items() if k != "updated_at"}
    slim["agents"] = [{k: v for k, v in a.items() if k != "last_active"} for a in payload.get("agents", [])]
    slim["cast"] = [{k: v for k, v in a.items() if k != "last_active"} for a in payload.get("cast", [])]

    return json.dumps(slim, ensure_ascii=False, sort_keys=True)


def write_status(payload, terms, out_file=OUT_FILE):
    leaks = find_leaks(payload, terms)
    if leaks:
        log.error("마스킹 검사 실패 %d건 -> 저장하지 않음: %s", len(leaks), ", ".join("%s(%s)" % l for l in leaks[:5]))
        return False
    out_file.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_file.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
        f.write("\n")
    os.replace(tmp, out_file)
    return True


_warned_git = False


def git_publish():
    """git 이 있고 이 폴더가 저장소일 때만 커밋·푸시. 없으면 경고 1줄만."""
    global _warned_git
    git = shutil.which("git")
    if not git or not (ROOT / ".git").exists():
        if not _warned_git:
            log.warning("git 또는 저장소(.git)가 없어 로컬 저장만 합니다(푸시 생략).")
            _warned_git = True
        return False
    rel = OUT_FILE.relative_to(ROOT).as_posix()

    def run(*a):
        return subprocess.run([git, "-C", str(ROOT)] + list(a), capture_output=True, timeout=120,
                              creationflags=_creationflags())
    try:
        run("add", "--", rel)
        if run("diff", "--cached", "--quiet", "--", rel).returncode == 0:
            return False
        if run("commit", "-m", "status: update", "--", rel).returncode != 0:
            log.warning("git commit 실패")
            return False
        if run("push").returncode != 0:
            log.warning("git push 실패(다음 주기에 다시 시도)")
            return False
        return True
    except Exception as e:
        log.warning("git 작업 실패: %s", type(e).__name__)
        return False


def load_token():
    """쓰기 토큰: 환경 변수 AI_OFFICE_PUSH_TOKEN (없으면 사용자 환경 변수 저장소에서 직접). 절대 출력·기록하지 않는다."""
    tok = os.environ.get("AI_OFFICE_PUSH_TOKEN") or ""
    if not tok and os.name == "nt":
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as k:
                tok = str(winreg.QueryValueEx(k, "AI_OFFICE_PUSH_TOKEN")[0])
        except OSError:
            tok = ""
    return tok.strip()


def live_post(payload, terms, cfg, token):
    """비식별 상태를 실시간 채널로 올린다. 마스킹 검사에 걸리면 보내지 않는다."""
    url = str(cfg.get("live_url") or "")
    if not url or not token or find_leaks(payload, terms):
        return False
    req = urllib.request.Request(
        url, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"), method="POST",
        headers={"content-type": "application/json", "authorization": "Bearer " + token, "user-agent": "ai-office-watch"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status == 200
    except urllib.error.HTTPError as e:
        return "HTTP %d" % e.code
    except Exception as e:
        return type(e).__name__


def run_once(cfg, state, push=True, heartbeat=1800, live=True, interval=120, force=False):
    """한 번 수집 -> (1) 실시간 채널 전송 (2) 로컬 파일 저장 (3) 가끔 git 푸시(백업용)."""
    raw = collect(cfg)
    marks = event_marks(raw, cfg)
    state["events"] = merge_events(state.get("events"), derive_events(state.get("marks"), marks, raw["now"]), raw["now"])
    state["marks"] = marks
    payload, terms = build_status(raw, cfg, state["events"])
    sig = signature(payload)
    now_t = time.time()
    changed = sig != state.get("sig")

    token = state.get("token") if live else ""
    if token and (sig != state.get("live_sig") or now_t - state.get("live_at", 0) >= int(cfg.get("live_heartbeat", 120))):
        res = live_post(payload, terms, cfg, token)
        ok = res is True
        if ok:
            state["live_sig"], state["live_at"] = sig, now_t
        if ok != state.get("live_ok"):
            if ok:
                log.info("실시간 채널 전송 정상")
            else:
                log.warning("실시간 채널 전송 실패(%s) -> 백업 파일 방식으로 계속", res or "검사 실패")
        state["live_ok"] = ok
    live_ok = bool(token and state.get("live_ok"))

    wrote = False
    if changed or force or now_t - state.get("written", 0) >= heartbeat:
        if not write_status(payload, terms):
            return False
        wrote = True
        state["sig"], state["written"] = sig, now_t
        s = payload["summary"]
        line = "작업 %d · 대기 %d · 오늘 처리 %d" % (s["working"], s["idle"], s["done_today"])
        if line != state.get("line") or not changed:
            state["line"] = line
            log.info("저장: %s (%s)", line, "내용 변경" if changed else "주기 갱신")
    if push:
        workset = ",".join(sorted(c["id"] for c in payload.get("cast", []) if c["status"] == "working"))
        since = now_t - state.get("pushed", 0)
        if force:
            due = True
        elif live_ok:   # 실시간 채널이 살아 있으면 git 은 백업: 30분마다, 또는 일하는 AI 가 바뀌고 10분이 지났을 때
            due = since >= heartbeat or (workset != state.get("workset") and since >= 600)
        else:           # 실시간 채널이 없으면 예전처럼 바뀔 때 올리되 너무 잦지 않게
            due = (wrote or workset != state.get("workset")) and since >= interval
        if due:
            state["pushed"], state["workset"] = now_t, workset
            git_publish()
    return wrote or not changed


def quick_signature(cfg):
    """작업 시작/종료를 빨리 알아채기 위한 가벼운 서명."""
    parts = []
    for p in list_processes():
        cmd = p["cmd"].replace("/", "\\").lower()
        if p["name"].lower().startswith("python") and "\\dev\\" in cmd and not any(sv in cmd for sv in SERVICE_SCRIPTS):
            parts.append(str(p["pid"]))
    dev = Path(cfg["dev_dir"])
    for spec in APPS.values():
        mt = mtime(dev / spec["dir"] / spec["logs"] / "current_job.json")
        parts.append(mt.isoformat() if mt else "-")
    mt = mtime(Path(cfg["blog_runs_dir"]) / "run_log.csv")
    parts.append(mt.isoformat() if mt else "-")
    return "|".join(sorted(parts))


def watch(cfg, interval=120, poll=20, push=True, heartbeat=1800, live=True):
    state = {"token": load_token() if live else ""}
    try:
        with open(OUT_FILE, encoding="utf-8") as f:
            state["sig"] = signature(json.load(f))
    except Exception:
        pass
    last_quick, next_full = None, 0.0
    log.info("감시 시작: %d초 간격, 변화 감지 %d초, 실시간 채널 %s", interval, poll,
             "켜짐" if state["token"] else "꺼짐(토큰 없음)")
    while True:
        try:
            if state["token"]:   # 실시간: 매 주기 전체 수집(로그는 바뀐 것만 다시 읽음)
                run_once(cfg, state, push=push, heartbeat=heartbeat, live=True, interval=interval)
            else:
                q = quick_signature(cfg)
                if q != last_quick or time.time() >= next_full:
                    last_quick = q
                    next_full = time.time() + interval
                    run_once(cfg, state, push=push, heartbeat=heartbeat, live=False, interval=0)
        except Exception as e:  # 감시는 죽지 않게
            log.error("주기 실패: %s", type(e).__name__)
        time.sleep(max(5, poll))


# ---------------------------------------------------------------- 스캔 보고서(비공개)

def scan_report(cfg):
    raw = collect(cfg)
    now = raw["now"]

    def t(dt):
        return dt.strftime("%m-%d %H:%M") if dt else "-"
    L = ["# PC 자동화 스캔 보고서 (비공개 · 공개 폴더 data/ 에 넣지 말 것)", "", "스캔 시각: " + now.strftime("%Y-%m-%d %H:%M:%S"), "",
         "## 프로세스", ""]
    for p in sorted(raw["procs"], key=lambda x: (x["name"].lower(), str(x["created"]))):
        L.append("- %s (pid %s, 시작 %s) `%s`" % (p["name"], p["pid"], str(p["created"])[:16].replace("T", " "), p["cmd"][:200]))
    L += ["", "## 블로그 작업", ""]
    b = raw["blog"]
    L.append("- run_log.csv 수정 %s / schedule_log.csv 수정 %s" % (t(b["run_log_mtime"]), t(b["schedule_mtime"])))
    L.append("- 기록에 나온 계정: " + ", ".join(sorted(b["accounts"])))
    for d in sorted(b["today_dirs"], key=lambda x: x["slot"]):
        L.append("- 오늘 폴더: %s 슬롯 %s (최근 수정 %s)" % (d["account"], d["slot"], t(d["mtime"])))
    for r in b["rows_today"]:
        L.append("- 오늘 기록: %s %s (%s)" % (r["time"].strftime("%H:%M"), r["account"], "임시저장" if r["saved"] else "저장 표시 없음"))
    L += ["", "## 앱별 상태", ""]
    for key, spec in APPS.items():
        i = raw["apps"][key]
        ends = [x for x, k in i["events"] if k == "end" and x.date() == now.date()]
        L.append("- %s (%s): 폴더 %s · 폴러 %s · 작업 프로세스 %d · current_job %s · 최근 로그 %s · 오늘 완료 %d · 단계 %s · Muse 호출 %d(최근 %s) · 음성합성 흔적 %d" % (
            spec["name"], spec["dir"], "있음" if i["exists"] else "없음", "실행 중" if i["poller"] else "없음",
            i["job_procs"], "있음" if i["current_job"] else "비어 있음", t(i["last_log"]), len(ends),
            i["stage"] or "-", len(i["muse"]), t(max(i["muse"], default=None)), len(i["speech"])))
    L += ["", "## 기타", ""]
    L.append("- Claude 세션 기록 최근 수정: " + t(raw["claude_session"]))
    L.append("- TV 브리지: 폴더 %s · 로그 %s · 마지막 명령 %s" % ("있음" if raw["tv"]["exists"] else "없음", t(raw["tv"]["log_mtime"]), t(raw["tv"]["last_cmd"])))
    L.append("- 발행 체크 수집기 로그: " + t(raw["pubcheck"]["log_mtime"]))
    L.append("- 인사이트 수집기 로그: " + t(raw["insight"]["log_mtime"]))
    L.append("- 동기화 폴더: OneDrive %s · Google Drive %s" % ("있음" if raw["drive"]["onedrive_folder"] else "없음", "있음" if raw["drive"]["gdrive_folder"] else "없음"))
    payload, _terms = build_status(raw, cfg)
    L += ["", "## 공개 JSON 에 나갈 AI 에이전트(마스킹 후)", ""]
    for c in payload["cast"]:
        L.append("- %s [%s] %s" % (c["name"], c["status"], c["task"]))
    L += ["", "## 공개 JSON 에 나갈 일감 목록(마스킹 후)", ""]
    for a in payload["agents"]:
        L.append("- %s [%s/%s] %s" % (a["name"], a["status"], a["zone"], a["task"]))
    LOCAL_DIR.mkdir(parents=True, exist_ok=True)
    with open(SCAN_REPORT, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(L) + "\n")
    return SCAN_REPORT


def setup_logging():
    LOCAL_DIR.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s", "%m-%d %H:%M:%S")
    fh = logging.handlers.RotatingFileHandler(LOCAL_DIR / "pc_watch.log", maxBytes=500_000, backupCount=1, encoding="utf-8")
    fh.setFormatter(fmt)
    log.addHandler(fh)
    if sys.stderr is not None:  # pythonw 에서는 콘솔이 없다
        sh = logging.StreamHandler()
        sh.setFormatter(fmt)
        log.addHandler(sh)
    log.setLevel(logging.INFO)


def main(argv=None):
    ap = argparse.ArgumentParser(description="PC 자동화 감시 -> data/pc-status.json")
    ap.add_argument("--once", action="store_true", help="한 번만 만들고 끝")
    ap.add_argument("--scan", action="store_true", help="읽기 전용 스캔 보고서만 만든다(local/, 비공개)")
    ap.add_argument("--no-push", action="store_true", help="git 커밋·푸시를 하지 않는다")
    ap.add_argument("--no-live", action="store_true", help="실시간 채널(Worker)로 보내지 않는다")
    ap.add_argument("--interval", type=int, default=120)
    ap.add_argument("--poll", type=int, default=20)
    ap.add_argument("--heartbeat", type=int, default=1800, help="내용이 같아도 이 초마다 갱신 시각을 새로 쓴다")
    args = ap.parse_args(argv)
    setup_logging()
    cfg = load_cfg()
    if args.scan:
        path = scan_report(cfg)
        log.info("스캔 보고서 저장: local/%s", path.name)
        return 0
    if args.once:
        state = {"token": "" if args.no_live else load_token()}
        ok = run_once(cfg, state, push=not args.no_push, heartbeat=0, live=not args.no_live, force=True)
        return 0 if ok else 1
    watch(cfg, interval=args.interval, poll=args.poll, push=not args.no_push, heartbeat=args.heartbeat,
          live=not args.no_live)
    return 0


if __name__ == "__main__":
    sys.exit(main())
