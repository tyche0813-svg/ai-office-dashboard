# AI 오피스 실시간 관제탑

클로드의 지휘 아래 일하는 AI 들(클로드·Opus 보조·Fable·뮤즈·어사이드·엑사원·Azure Speech·Claude API·Copilot·ChatGPT·Codex·Stability·피클·클라우드 루틴·vooy)이
2.5D 사무실에서 **실제로 지시를 받아 일하는 모습**을 보여 주는 정적 사이트입니다.
외부 라이브러리 없이 `index.html` + `assets/` + `data/` 만으로 동작합니다.

- 공개 주소: https://tyche0813-svg.github.io/ai-office-dashboard/
- 실시간 채널: https://ai-office-live.btc-indicator-mobile.workers.dev/status (읽기 전용 공개, 비식별 JSON 만)

## 화면 규칙(꾸며낸 연출 없음)

| 실제 상태·사건 | 화면 |
|---|---|
| 상태 `working` | 자기 책상에서 타이핑 + 작업 말풍선 |
| 상태 `resting`(방금 일을 마침, 20분) | 휴게실에서 쉼 |
| 상태 `idle` | 자기 책상에서 조용히 대기 |
| 상태 `offline` | 책상에서 꺼진 모습 |
| 사건 `dispatch`(지시·요청) | 보낸 쪽이 받는 쪽 자리로 걸어가 말하고 돌아옴 |
| 사건 `report`(결과 전달) | 일한 쪽이 지시한 쪽에게 걸어가 알리고 돌아옴 |
| 사건 `meeting`(블로그 슬롯 시작) | 관련 AI 가 회의실에 모였다가 흩어짐 |
| 사건 `note` | 해당 AI 머리 위에 한 줄 |

사건이 없으면 아무도 돌아다니지 않습니다. 사건 시각이 파일 수정 시각뿐이면 `coarse: true` 로 보내고 화면에는 "약 N분 전"·"~HH:MM" 으로 적습니다.
최근 3분 안의 사건만 재생하고, 더 오래된 것은 관제탑 기록에만 남습니다. 미리보기: 주소 뒤에 `?demo=1`(가짜 상태·사건, 화면에 '데모' 표시).

## 폴더

| 경로 | 내용 | 공개 여부 |
|---|---|---|
| `index.html`, `assets/style.css`, `assets/app.js` | 화면 | 공개 |
| `data/pc-status.json` | PC 감시 스크립트가 만드는 상태(백업용, 30분마다 푸시) | 공개 |
| `data/pickle-status.json` | 피클 앱이 덮어쓸 상태(지금은 템플릿) | 공개 |
| `tools/pc_watch.py` | PC 감시 스크립트 | 공개(식별 값 없음) |
| `tools/test_masking.py` | 마스킹 단위 테스트 | 공개(가짜 값만) |
| `worker/` | 실시간 채널(Cloudflare Worker) 소스. 토큰은 없음 | 공개 |
| `local/` | 스캔 보고서·로컬 설정·감시 로그·스크린샷 | **비공개(.gitignore)** |

## 데이터 형식

```json
{
  "updated_at": "2026-11-16T22:30:00+09:00",
  "source": "pc",
  "summary": { "done_today": 0, "working": 0, "idle": 0 },
  "cast": [
    { "id": "muse", "name": "뮤즈", "role": "초안 · 사진", "status": "working",
      "bubble": "초안·사진 작업 중", "task": "블로그 초안·사진 요청 처리 중", "last_active": "2026-11-16T22:29:00+09:00" }
  ],
  "events": [
    { "time": "2026-11-16T22:29:00+09:00", "kind": "dispatch", "from": "claude", "to": "muse",
      "title": "클로드 → 뮤즈: 초안·사진 요청", "coarse": true }
  ],
  "agents": [ { "id": "blog-a", "name": "블로그팀 A", "role": "블로그 원고 작성", "status": "idle", "zone": "desk",
      "bubble": "다음 슬롯 대기", "task": "다음 슬롯 대기", "last_active": "" } ],
  "logs": [ { "time": "2026-11-16T21:29:00+09:00", "agent": "blog-a", "title": "블로그 원고 1건 임시저장", "detail": "" } ]
}
```

- `cast` = 주인공 AI(상태 `working` `resting` `idle` `offline`), `events` = 실제로 감지한 지시·호출, `agents` = 일감(블로그팀 A/B/C, 쇼츠·릴스·클립·캐러셀, 수집기).
- 화면은 실시간 채널을 5초마다 읽습니다(탭이 보일 때만). 실시간 값이 5분 넘게 멈추면 `data/pc-status.json` 을 대신 읽습니다.
- 피클은 `data/pickle-status.json` 에 `"cast": [{ "id": "pickle", ... }]` 를 같은 형식으로 덮어쓰면 됩니다.
- `updated_at` 이 10분보다 오래되면 '갱신 지연', 30분보다 오래되면 '작업 중' 표시를 믿지 않고 대기로 돌립니다.

## AI 별 감지 방법(pc_watch.py, 읽기 전용 · 이름과 수정 시각만 봄)

| AI | 신호 |
|---|---|
| 클로드 | claude 프로세스 + 세션 기록 파일이 5분 안에 바뀜 |
| Opus 보조 / Fable | 하위 에이전트 기록 파일이 4분 안에 바뀜(종류는 meta 의 model 값) |
| 어사이드 | `ar*.ps1`·`drive*.ps1`·`ed_run*.ps1`·`aside repl` 실행 중, 에디터 실행 임시 파일·`editor_log*` 수정 시각 |
| 뮤즈 | `muse_*` 스크립트 실행 중, 오늘 작업 폴더의 muse 파일 수정 시각, 영상 앱 로그의 요청 줄 |
| 엑사원 | `exaone*.py` 실행 중, `ai_check*` 파일·EXAONE 상태 파일 수정 시각 |
| Azure Speech | 영상 앱 로그의 음성 단계 |
| Claude API | 캐러셀·인스타 앱 로그의 문구 단계 |
| ChatGPT / Copilot | 해당 스크립트 실행 중, 오늘 작업 폴더의 gpt·copilot 파일 수정 시각 |
| Codex | codex 프로세스가 있을 때만 작업, 아니면 '현재 사용 불가' |
| Stability | 항상 '사용 중단' |
| 클라우드 루틴 | 흔적을 볼 수 없어 예정 시간대(`routine_window`, 기본 01:00~01:45)로만 표시 |
| 피클 | `data/pickle-status.json` |
| vooy | 아래 설정이 있을 때만. 없으면 항상 대기 |

### vooy 연결(정체 확인 뒤)

`local/pc_watch.local.json` 에 아래를 넣으면 그때부터 움직입니다(둘 중 하나만 있어도 됨).

```json
{ "vooy_signal": { "process": "프로세스 이름 일부", "path": "작업할 때 바뀌는 파일·폴더", "active_min": 10 } }
```

## 실시간 채널(Cloudflare Worker `ai-office-live`)

- `GET /status` 누구나 읽기. `POST /status` 는 `Authorization: Bearer <토큰>` 이 맞을 때만.
- 토큰은 Worker 비밀값 `PUSH_TOKEN` 과 이 PC 의 사용자 환경 변수 `AI_OFFICE_PUSH_TOKEN` 에만 있습니다(파일·로그·저장소에 없음).
- Worker 도 받은 JSON 을 다시 검사합니다: 60KB 초과, 모르는 키, 80자 넘는 문자열, 식별 패턴(경로·이메일·아이디·IP·전화·금액 등)이 하나라도 있으면 저장하지 않습니다.
- 감시 스크립트는 20초마다 상태를 보고, 내용이 바뀌었거나 2분이 지나면 올립니다. git 푸시는 30분마다(또는 일하는 AI 가 바뀌고 10분 뒤) 백업용으로만 합니다.
- 배포: `cd worker` → `npx wrangler deploy`. 토큰 교체: 환경 변수와 `npx wrangler secret put PUSH_TOKEN` 을 같은 값으로.
## 앱으로 설치(PWA)

- `manifest.json` + `sw.js` + `assets/app/`(직접 그린 아이콘). 같은 주소에서 '앱 설치'를 누르면 휴대폰·PC 에 앱으로 들어갑니다.
- `sw.js`: 화면 파일은 온라인이면 늘 새로 받고, 못 받을 때만 저장본으로 엽니다(오프라인 실행 + '오프라인' 안내). 실시간 채널 응답은 저장하지 않습니다.
- 화면 파일을 고치면 `index.html` 의 `?v=` 값을 올립니다. 미리 저장 목록을 바꾸면 `sw.js` 의 `CACHE` 이름도 올립니다.
- 미리보기: `?standalone=1`(앱 모양 배치), `?demo=1`.

## 보안(공개 페이지)

공개 JSON 에는 이름·전화·주소·계좌·금액·수익·API 키·내부 경로·IP·블로그 아이디·이메일·키워드·글 제목을 넣지 않습니다.

- `pc_watch.py` 는 화면 문구를 **파일 안의 고정 문장으로만** 만듭니다. 로그 원문·제목·키워드는 내보내지 않습니다.
- 그 위에 모든 문자열을 `mask()` 로 한 번 더 거르고, `find_leaks()` 가 하나라도 잡으면 **파일을 쓰지 않습니다**.
- 블로그 계정은 `블로그팀 A/B/C` 로만 나갑니다. 계정 ↔ 글자 대응표는 `local/pc_watch.local.json`(비공개)에만 둡니다.
- 피클 쪽 JSON 도 같은 원칙으로 써 주세요(사람이 직접 적는 문장에 실명·금액·키워드를 넣지 않기).

테스트:

```
python tools/test_masking.py
```

## PC 감시 스크립트

```
python tools/pc_watch.py --scan      읽기 전용 스캔 보고서 → local/scan_report.md (비공개)
python tools/pc_watch.py --once      data/pc-status.json 한 번 생성
python tools/pc_watch.py             감시 루프(20초마다 확인 → 실시간 채널 전송, git 은 30분마다 백업)
```

옵션: `--no-push`(커밋·푸시 안 함) `--no-live`(실시간 채널로 안 보냄) `--interval 120` `--poll 20` `--heartbeat 1800`

- 실시간 채널 토큰이 없거나 전송이 실패하면 예전 방식(내용이 바뀔 때 파일 저장 + 커밋·푸시, 최소 2분 간격)으로 돕니다.
- git 이 없거나 이 폴더가 저장소가 아니면 로컬 저장만 하고 경고를 한 줄 남깁니다(`local/pc_watch.log`).
- 읽기 전용입니다. 프로세스 목록, 로그, 폴더 수정 시각만 봅니다.

로컬 설정(선택, 비공개) `local/pc_watch.local.json`:

```json
{
  "blog_teams": { "계정아이디": "A" },
  "sensitive_terms": ["추가로 가릴 낱말"],
  "recent_call_min": 10
}
```

## 로컬 미리보기

```
cd %USERPROFILE%\dev\ai_office_dashboard
python -m http.server 8765 --bind 127.0.0.1
```

브라우저에서 `http://127.0.0.1:8765/` 를 엽니다(파일을 더블클릭해 열면 데이터를 읽지 못합니다).

## PC 켜질 때 감시 자동 실행(둘 중 하나, 직접 등록)

### ① 시작프로그램 폴더 바로가기

1. `Win + R` → `shell:startup` 입력 → 시작프로그램 폴더가 열립니다.
2. 빈 곳에서 오른쪽 클릭 → 새로 만들기 → 바로 가기.
3. 항목 위치에 아래 한 줄을 넣습니다(pythonw 는 검은 창 없이 실행).
   ```
   pythonw "%USERPROFILE%\dev\ai_office_dashboard\tools\pc_watch.py"
   ```
   `pythonw` 를 못 찾는다고 나오면 `where pythonw` 로 나온 전체 경로를 대신 적습니다.
4. 이름을 `AI 오피스 감시` 로 저장합니다.
5. 바로가기 오른쪽 클릭 → 속성 → '시작 위치'에 `%USERPROFILE%\dev\ai_office_dashboard` 를 넣습니다.
6. 다음 로그인부터 자동으로 돕니다. 지금 바로 켜려면 바로가기를 더블클릭합니다.
7. 끄려면 작업 관리자 → 세부 정보에서 `pythonw.exe`(명령줄에 pc_watch.py) 를 끝냅니다. 자동 실행을 없애려면 바로가기를 지웁니다.

### ② 작업 스케줄러 수동 등록

1. 시작 메뉴에서 '작업 스케줄러' 실행 → 오른쪽 '작업 만들기'.
2. 일반: 이름 `AI Office Watch`, '사용자가 로그온할 때만 실행' 선택.
3. 트리거: 새로 만들기 → '로그온할 때'(본인 계정).
4. 동작: 새로 만들기 → 프로그램 `pythonw`(또는 전체 경로), 인수 `tools\pc_watch.py`, 시작 위치 `%USERPROFILE%\dev\ai_office_dashboard` 의 실제 경로.
5. 조건: '컴퓨터의 AC 전원이 켜져 있는 경우에만' 체크 해제.
6. 설정: '다음 시간 이상 작업이 실행되면 중지' 체크 해제, '이미 실행 중이면 새 인스턴스 시작 안 함'.
7. 확인 → 목록에서 오른쪽 클릭 → 실행으로 바로 시험합니다.

두 방식을 함께 쓰면 감시가 두 개 떠서 푸시가 겹칩니다. 하나만 쓰세요.
