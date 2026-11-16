# AI 오피스 실시간 관제 대시보드

2.5D 쿼터뷰 사무실 지도(왼쪽 70%)와 LIVE 사이드바(오른쪽 30%)로 AI 작업자들의 상태를 보여 주는 정적 사이트입니다.
외부 라이브러리 없이 `index.html` + `assets/` + `data/` 만으로 동작합니다.

## 폴더

| 경로 | 내용 | 공개 여부 |
|---|---|---|
| `index.html`, `assets/style.css`, `assets/app.js` | 화면 | 공개 |
| `data/pc-status.json` | PC 감시 스크립트가 만드는 상태(비식별 요약) | 공개 |
| `data/pickle-status.json` | 피클 앱이 덮어쓸 상태(지금은 템플릿) | 공개 |
| `tools/pc_watch.py` | PC 감시 스크립트 | 공개(식별 값 없음) |
| `tools/test_masking.py` | 마스킹 단위 테스트 | 공개(가짜 값만) |
| `local/` | 스캔 보고서·로컬 설정·감시 로그·스크린샷 | **비공개(.gitignore)** |

## 데이터 형식(두 파일 공통)

```json
{
  "updated_at": "2026-11-15T21:30:00+09:00",
  "source": "pc",
  "summary": { "done_today": 0, "working": 0, "idle": 0 },
  "agents": [
    { "id": "shorts", "name": "쇼츠 작업자", "role": "쇼츠 영상 제작",
      "status": "working", "zone": "desk", "bubble": "영상 렌더링 중",
      "task": "쇼츠 파이프라인 1건 진행 중", "last_active": "2026-11-15T21:29:00+09:00" }
  ],
  "logs": [
    { "time": "2026-11-15T21:29:00+09:00", "agent": "shorts", "title": "쇼츠 파이프라인 1건 완료", "detail": "제작 단계를 마침" }
  ]
}
```

- `status`: `working` `meeting` `resting` `idle` `offline`
- `zone`: `ceo`(대표님) `meeting`(회의실) `desk`(실무 데스크) `lounge`(라운지) `reception`(안내 데스크)
- 화면은 두 파일을 45초마다 다시 읽어 합칩니다. 한쪽이 없거나 깨져도 다른 쪽만으로 그립니다.
- `updated_at` 이 10분보다 오래되면 하단에 '갱신 지연'으로 표시됩니다.
- 피클 쪽은 `source` 를 `"pickle"` 로 두고 같은 형식으로 `data/pickle-status.json` 을 덮어쓰면 됩니다.

## 보안(공개 페이지)

공개 JSON 에는 이름·전화·주소·계좌·금액·수익·API 키·내부 경로·블로그 아이디·이메일·키워드·글 제목을 넣지 않습니다.

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
python tools/pc_watch.py             감시 루프(2분 간격 + 작업 시작/종료 감지 시 즉시)
```

옵션: `--no-push`(커밋·푸시 안 함) `--interval 120` `--poll 20` `--heartbeat 1800`

- 내용이 이전과 달라졌을 때만 파일을 새로 쓰고 커밋·푸시합니다(같으면 30분마다 갱신 시각만 새로 씀).
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

## GitHub Pages 배포(아직 안 함)

1. Git for Windows 설치(GitHub CLI 는 선택) 후 GitHub 로그인.
2. 공개 저장소를 하나 만들고 이 폴더를 올립니다. `local/` 은 `.gitignore` 로 빠집니다.
3. 저장소 Settings → Pages → Branch `main` / 폴더 `/ (root)` 저장.
4. 감시 스크립트가 푸시할 수 있게 이 PC 에 인증(자격 증명 관리자 또는 토큰)을 한 번 저장합니다.
5. 피클 앱이 `data/pickle-status.json` 을 올리는 방법(같은 저장소에 커밋)을 정합니다.

올리기 전에 `python tools/test_masking.py` 와 `data/pc-status.json` 내용을 한 번 눈으로 확인하세요.
