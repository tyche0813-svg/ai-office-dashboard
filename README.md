# AI 오피스 (AI 사무실 현황)

클로드의 지휘 아래 일하는 AI 들(클로드·Opus 보조·Fable·뮤즈·어사이드·엑사원·Azure Speech·Claude API·Copilot·ChatGPT·Codex·Stability·피클·클라우드 루틴·vooy)이
따뜻한 조명의 3D 사무실에서 **실제로 지시를 받아 일하는 모습**을 보여 주는 정적 사이트입니다.
`index.html` + `assets/` + `data/` 만으로 동작하며, 3D 는 저장소에 같이 둔 Three.js r160(`assets/vendor/`, MIT)으로 그립니다. 빌드 단계는 없습니다.

- 공개 주소: https://tyche0813-svg.github.io/ai-office-dashboard/
- 실시간 채널: https://ai-office-live.btc-indicator-mobile.workers.dev/status (읽기 전용 공개, 비식별 JSON 만)

## 화면 규칙(무엇을 하는지는 실제 데이터대로)

| 실제 상태·사건 | 화면 |
|---|---|
| 상태 `working` | 자기 책상에 앉아 타이핑 + 작업 말풍선 |
| 상태 `resting`(방금 일을 마침, 20분) | 소파·탕비실 바 의자에서 쉼 |
| 상태 `idle` | 자기 책상에 앉아 대기. 3D 화면에서는 가끔 일어나 걷거나 커피를 마시고 돌아옴(아래 '대기 연출') |
| 상태 `offline` | 책상에서 어둡게 엎드린 모습('퇴근') |
| 사건 `dispatch`(지시·요청) | 보낸 쪽이 받는 쪽 자리로 걸어가 둘이 서서 이야기하고 돌아옴 |
| 사건 `report`(결과 전달) | 일한 쪽이 지시한 쪽에게 걸어가 알리고 돌아옴 |
| 사건 `meeting`(블로그 슬롯 시작) | 관련 AI 가 원형 회의 탁자에 모였다가 흩어짐 |
| 사건 `note` | 해당 AI 머리 위에 한 줄 |

**대기 연출(2026-11-19~, 3D 화면만)**: 상태가 `idle` 인 AI 만 40초~4분 사이 무작위 간격으로 일어나 잠깐 걷거나 탕비실에서 커피를 마시고 자리로 돌아옵니다(동시에 최대 2명).
이 연출에는 말풍선을 붙이지 않습니다. 말풍선 문구는 언제나 실제 사건·상태에서 온 고정 문구뿐입니다. 실제 사건이 오거나 상태가 바뀌면 연출은 바로 멈춥니다.
근무·휴식·퇴근·지시·보고·회의는 받은 데이터 그대로이며, 오른쪽 패널 숫자도 연출과 무관합니다. 사건 시각이 파일 수정 시각뿐이면 `coarse: true` 로 보내고 화면에는 "약 N분 전"·"~HH:MM" 으로 적습니다.
최근 3분 안의 사건만 재생하고, 더 오래된 것은 관제탑 기록에만 남습니다. 미리보기: 주소 뒤에 `?demo=1`(가짜 상태·사건, 화면에 '데모' 표시).

## 화면 구성(2026-11-19 3D 전환)

- 지도는 `assets/office3d.js` 가 그리는 3D 장면입니다. 모델 파일 없이 박스·원기둥·구로 만든 가상의 사무실(대표 책상·원형 회의 탁자·칸막이 책상 15석·총괄 자리·안내 데스크 2석·라운지·탕비실)이며 실제 장소나 상표를 본뜨지 않았습니다.
- 자리·가구 좌표는 `office3d.js` 안에 미터 단위로 적혀 있습니다(`HOME` 책상, `REST` 쉬는 자리, `MEET` 회의 의자, `COFFEE`, `STROLL`). 걷는 길은 0.4m 격자 A* 로 가구를 피해 찾습니다.
- 카메라: 끌어서 회전, 휠·두 손가락으로 확대, 오른쪽 끌기·두 손가락으로 이동(각도·거리 제한). 오른쪽 아래 `+` `−` `전체`.
- 성능: 휴대폰은 화소 배율 1.5 이하·그림자 1024, 화면에 안 보이면 그리기를 멈춥니다. 처음 몇 초가 느리면 해상도·그림자를 스스로 낮춥니다.
- **2D 대체 화면**: WebGL 이 없거나(소프트웨어 렌더러 포함) import map 을 모르는 브라우저, 3D 파일을 9초 안에 못 받은 경우에는 아래의 그림 버전으로 자동으로 엽니다. 강제로 보려면 `?2d=1`, 느린 장치에서도 3D 를 보려면 `?3d=1`.
- (2D 대체 화면) 배경은 그림 한 장 `assets/office-bg.jpg`(1920×1280, 사람·글자·로고 없는 가상의 사무실. Muse 로 생성). 캐릭터·이름표·말풍선은 그 위에 SVG 로 얹습니다.
- 자리 좌표는 `assets/app.js` 의 `SEATS`(책상), `REST_SPOTS`(쉬는 자리), `MEET_SPOTS`(회의 탁자), `NODES`(걷는 통로)에 그림 픽셀 기준으로 적혀 있습니다. 배경을 바꾸면 이 좌표도 같이 맞춥니다.
- 이름표는 `[공식 아이콘 배지] 이름 · 직급`. 직급은 맡은 역할을 사무실 직급처럼 부른 것입니다. 동물 얼굴은 꾸밈일 뿐 상태와 무관하고, 대표님 자리 인형은 움직이지 않습니다.
- 왼쪽 위 칩: 근무·회의·휴식·대기·퇴근(회의 = 실제 회의 사건으로 지금 모여 있는 수, 퇴근 = `offline`). 오른쪽 패널 숫자·'최근 완료'도 모두 받은 데이터에서만 계산합니다.

## 폴더

| 경로 | 내용 | 공개 여부 |
|---|---|---|
| `index.html`, `assets/style.css`, `assets/app.js`(데이터·패널·2D 대체), `assets/office3d.js`(3D), `assets/office-bg.jpg`(2D 배경) | 화면 | 공개 |
| `assets/vendor/` | Three.js r160 모듈·OrbitControls·BufferGeometryUtils(MIT, 원본 그대로) | 공개 |
| `data/pc-status.json` | PC 감시 스크립트가 만드는 상태(백업용, 30분마다 푸시) | 공개 |
| `data/pickle-status.json` | 피클 앱이 덮어쓸 상태(지금은 템플릿) | 공개 |
| `tools/pc_watch.py` | PC 감시 스크립트 | 공개(식별 값 없음) |
| `tools/test_masking.py` | 마스킹 단위 테스트 | 공개(가짜 값만) |
| `worker/` | 실시간 채널 + '지시' 대화창(Cloudflare Worker) 소스. 토큰은 없음 | 공개 |
| `assets/chat.js`, `tools/chat_runner.py`, `tools/start_chat_runner.ps1`, `tools/test_chat.py` | '지시' 대화창 화면·PC 작업기·테스트 | 공개(식별 값 없음) |
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
## '지시' 대화창(2026-11-21~)

지도 오른쪽 아래 `지시` 버튼 → 대화창. 대표님이 적은 지시를 **이 PC 의 Claude** 가 처리하고 답을 돌려줍니다.

- 흐름: 화면(`assets/chat.js`) → Worker `ai-office-live` 의 `/chat/*`(`worker/src/chat.js`, 별도 Durable Object) → PC 작업기(`tools/chat_runner.py`)가 10초마다 가져가 `claude -p` 로 실행 → 답을 Worker 에 올림 → 화면이 받아 표시.
- **지시와 답은 Worker 안에만 있습니다.** `data/*.json`, 공개 `/status`, 이 저장소, 작업기 기록에는 내용이 남지 않습니다(기록에는 번호·걸린 시간·글자 수만). 화면 연출은 고정 문구 두 개(`대표님 지시 접수`, `대표님께 답변 전달`)이고, 로그인한 그 기기 화면에서만 보입니다.
- 로그인: PIN → 무작위 세션 토큰(그 브라우저 localStorage 에만 보관, Worker 에는 해시만, 30일 만료, `로그아웃`하면 즉시 폐기). 쿠키를 쓰지 않는 이유: 화면(github.io)과 Worker(workers.dev)는 다른 사이트라 쿠키가 서드파티 쿠키가 되어 iOS Safari·삼성 인터넷·시크릿 창에서 막힙니다.
- 제한: 틀린 PIN 은 같은 주소 15분에 5번, 전체 24시간에 30번이면 잠김. 지시 2,000자, 답 12,000자, 동시에 1건(앞 지시가 끝나야 다음 지시), 한 건 15분, 하루 30건. 브라우저 요청은 이 페이지 주소(`https://tyche0813-svg.github.io`)에서 온 것만 받습니다.
- 지시마다 새 대화로 처리합니다(앞 지시 내용을 기억하지 않음). 필요한 내용은 한 지시에 다 적습니다.

### 처리 범위(안전 장치)

헤드리스 실행은 권한 확인 창을 띄울 수 없어서 처음부터 좁혀 실행합니다(`tools/chat_runner.py` 의 `build_cmd`).

| 구분 | 내용 |
|---|---|
| 쓸 수 있는 도구 | `Read`, `Glob`, `Grep`(파일 읽기·찾기), `WebSearch`, `WebFetch`(웹 검색·읽기) |
| 쓸 수 없는 도구 | `Bash`·`PowerShell`(명령 실행), `Edit`·`Write`·`NotebookEdit`(파일 쓰기), 하위 에이전트, 스킬, MCP 연결(메일·드라이브·노션·브라우저 조작) |
| 옵션 | `--tools`(위 5개만 남김) `--allowedTools` `--disallowedTools`(`.env` 읽기 거부 포함) `--permission-mode dontAsk` `--permission-prompts none`(확인이 필요한 일은 자동 거부) `--strict-mcp-config` `--disable-slash-commands` `--no-chrome` |
| 쓰지 않는 옵션 | `--dangerously-skip-permissions` |
| 추가 지침 | 한국어로 답, 읽기·조회만, 발행·예약 금지, 삭제·결제·계정 변경 금지, 비밀번호·키 입력·출력 금지, `.env` 금지, 못 하는 일은 무엇을 해야 하는지만 답으로 적기 |

즉 "오늘 임시저장 몇 건이야?", "어제 로그에 오류 있었어?", "이 주제 검색해 줘" 같은 **확인·조회·검색**은 되고, 글 작성·임시저장·파일 수정·스크립트 실행은 되지 않습니다(그런 지시에는 해야 할 일을 정리해 답합니다). 답은 올리기 전에 긴 토큰 모양을 가립니다(작업기와 Worker 양쪽).

### 처음 한 번 설정(비밀값은 직접 넣습니다 — 채팅·파일·저장소에 적지 않기)

1. **PIN**: Cloudflare 대시보드 → Workers & Pages → `ai-office-live` → Settings → Variables and Secrets → Add → Type `Secret`, Name `APP_PIN`, Value 에 6자 이상 PIN → Deploy.
2. **PC 토큰**: 같은 화면에서 Add → Type `Secret`, Name `CHAT_PC_TOKEN`, Value 에 21자 이상 무작위 문자열 → Deploy.
   (명령으로 넣으려면 `worker` 폴더에서 `npx wrangler secret put APP_PIN`, `npx wrangler secret put CHAT_PC_TOKEN` — 값은 물어볼 때 입력)
3. **PC 쪽 같은 토큰**: 별도 PowerShell 창에서 `setx AI_OFFICE_CHAT_TOKEN "<2번과 같은 값>"`.
4. **작업기 켜기**: `powershell -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\devi_office_dashboard	ools\start_chat_runner.ps1"` (창 없이 실행, 이미 돌고 있으면 건너뜀. PowerShell 창에서 칠 때는 `%USERPROFILE%` 대신 `$env:USERPROFILE`).
   끄기는 같은 명령 뒤에 ` -Stop`. 연결 확인만 하려면 `python tools/chat_runner.py --check`(토큰 값은 출력하지 않음).
5. 페이지에서 `지시` → PIN 입력 → 맨 위에 `PC 연결됨`이 보이면 준비 끝.

- 기록: `local/logs/chat_runner.log`(비공개 폴더). 하루 건수: `local/chat_state.json`.
- PC 켤 때 자동 실행(원할 때 직접 등록): `Win + R` → `shell:startup` → 새 바로 가기 → 항목 위치에 4번 명령 한 줄.
- 급히 막기: 작업기를 끄거나(`-Stop`), Cloudflare 에서 `CHAT_PC_TOKEN` 또는 `APP_PIN` 을 지우면 바로 멈춥니다. 대화 기록은 대화창의 `기록 지우기`.
- 테스트: `python tools/test_chat.py`(가짜 Worker·모의 실행. 지시·답이 공개 파일에 남지 않는지, 도구 범위, 가림 처리 확인).

## 노션 연락판 AI(피클 · Instinct · Pally)

- `python tools/notion_push.py <pickle|instinct|pally> <줄 수>` → `data/notion-agents.json`. 줄 수 = 그 AI 연락판의 'AI → 클로드' 아래 줄 수(양식 줄 제외). 글 내용은 받지 않습니다.
- 줄 수가 늘면 '방금 보고'로 보고 20분 작업 중 → 60분까지 휴식 → 대기. 한 번도 기록이 없는 AI 는 '연결 안 됨'. 화면은 마지막 보고 시각으로 상태를 스스로 다시 계산합니다.
- 줄 수 기록은 `local/notion_state.json`(비공개). 바뀐 때만 그 파일 하나를 커밋·푸시합니다. `local/notion_push.py`, `local/pickle_push.py` 는 같은 코드를 부르는 껍데기입니다.

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
