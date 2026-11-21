/* AI 오피스(AI 사무실 현황) — 데이터·오른쪽 패널·2D 대체 화면. 3D 사무실은 assets/office3d.js(Three.js)가 그린다.
   WebGL 이 없거나 3D 를 불러오지 못하면 아래의 2D 그림 버전(배경 assets/office-bg.jpg + SVG 캐릭터)으로 자동 대체한다.
   데이터는 모두 textContent 로만 넣는다.
   원칙: 무엇을 하는지(근무·휴식·퇴근·지시·보고·회의)와 말풍선 문구는 감시 스크립트가 '실제로 감지한 사건'과 '현재 상태'에서만 나온다.
   3D 화면에서는 대기(idle) 캐릭터만 가끔 걷거나 커피를 마시는 연출이 있고, 그 연출에는 말풍선이 없다(2D 대체 화면에는 연출 없음).
   - 상태 working  → 자기 책상에서 작업(타이핑 + 작업 말풍선)
   - 상태 resting  → 방금 일을 마침: 소파·탕비실에서 쉼
   - 상태 idle     → 자기 책상에서 조용히 대기      - 상태 offline → 책상에서 꺼진 모습
   - 사건 dispatch/report → 보낸 쪽이 받는 쪽 자리로 걸어가 말하고 돌아옴   - 사건 meeting → 회의 탁자에 모였다 흩어짐 */
(function () {
  'use strict';

  var LIVE_URL = 'https://ai-office-live.btc-indicator-mobile.workers.dev/status';
  var FILE_URL = 'data/pc-status.json', NOTION_URL = 'data/notion-agents.json', PICKLE_URL = 'data/pickle-status.json';
  /* 노션 연락판으로 일하는 AI: 상태는 data/notion-agents.json(없으면 예전 피클 파일)에서만 받는다 */
  var NOTION_IDS = { pickle: 1, instinct: 1, pally: 1, keyring: 1 };
  var NOTION_WORK_MS = 20 * 60000, NOTION_REST_MS = 60 * 60000;
  var NOTION_TEXT = { working: ['작업 보고 중', '노션 연락판에 작업 결과 보고'], resting: ['보고 완료', '노션 연락판 보고 완료'], idle: ['요청 대기', '노션 연락판 대기'] };
  var LIVE_MS = 5000, FILE_MS = 45000;
  var LIVE_FRESH_MS = 5 * 60 * 1000;    /* 실시간 채널 값이 이보다 오래되면 백업 파일도 본다 */
  var STALE_MS = 10 * 60 * 1000;        /* 이보다 오래되면 '갱신 지연' */
  var DEAD_MS = 30 * 60 * 1000;         /* 이보다 오래되면 '작업 중' 표시를 믿지 않는다 */
  var EVENT_PLAY_MS = 3 * 60 * 1000;    /* 이 안에 일어난 사건만 화면에서 재생(더 옛것은 기록에만) */

  var STATUS = {
    working: { label: '근무', color: '#34d399' },
    resting: { label: '휴식', color: '#fbbf24' },
    idle: { label: '대기', color: '#d9cdbb' },
    offline: { label: '퇴근', color: '#8b8177' }
  };
  var STATUS_ORDER = ['working', 'resting', 'idle', 'offline'];


  /* 주인공: 클로드와 그 지휘를 받는 AI 들. tag = 이름표 이름, rank = 이름표 직급(맡은 역할을 사무실 직급처럼 부른 것).
     icon = 각 제품 공식 사이트·앱에서 받은 아이콘(assets/icons, 크기만 줄임) — 이름표 왼쪽 배지로 붙어 누가 누구인지 알 수 있다.
     icon 이 없는 AI(피클·vooy·Instinct)는 글자 배지(mark). animal·fur = 얼굴 모양과 털 색(꾸밈일 뿐 상태와 무관). */
  var ICON_DIR = 'assets/icons/';
  var CAST = [
    { id: 'claude', name: '클로드', tag: '클로드', rank: '총괄', role: '지휘 · 관제', color: '#e8935f', icon: 'claude', animal: 'bear', fur: '#e6bd92', tie: true },
    { id: 'opus', name: 'Opus 보조', tag: 'Opus', rank: '과장', role: '블로그 슬롯 담당', color: '#f3b98f', icon: 'claude', animal: 'cat', fur: '#f3dcc0' },
    { id: 'muse', name: '뮤즈', tag: '뮤즈', rank: '작가', role: '초안 · 사진', color: '#7aa2ff', icon: 'muse', animal: 'rabbit', fur: '#f7f1ea' },
    { id: 'aside', name: '어사이드', tag: '어사이드', rank: '기사', role: '브라우저 · 에디터 조작', color: '#9fb0c8', icon: 'aside', animal: 'dog', fur: '#e9d3b4' },
    { id: 'exaone', name: '엑사원', tag: '엑사원', rank: '검수', role: '문체 검사', color: '#e0668a', icon: 'exaone', animal: 'cat', fur: '#f1c9b8' },
    { id: 'fable', name: 'Fable', tag: 'Fable', rank: '개발', role: '앱 개발 담당', color: '#4fd1bd', icon: 'claude', animal: 'fox', fur: '#f0a560' },
    { id: 'speech', name: 'Azure Speech', tag: 'Speech', rank: '성우', role: '음성 합성', color: '#38bdf8', icon: 'azure', animal: 'dog', fur: '#d9c2a3' },
    { id: 'chatgpt', name: 'ChatGPT', tag: 'ChatGPT', rank: '자문', role: '검수 · 가끔', color: '#4ade80', icon: 'openai', animal: 'bear', fur: '#f4efe8' },
    { id: 'codex', name: 'Codex', tag: 'Codex', rank: '휴직', role: '대행 · 현재 사용 불가', color: '#a8b3c4', icon: 'openai', animal: 'cat', fur: '#c9c4bd' },
    { id: 'routine', name: '클라우드 루틴', tag: '루틴', rank: '야간조', role: '새벽 키워드 수집', color: '#93c5fd', icon: 'claude', animal: 'panda', fur: '#f6f3ee' },
    { id: 'vooy', name: 'vooy', tag: 'vooy', rank: '미정', role: '역할 확인 중', color: '#9aa4b5', mark: '?', animal: 'rabbit', fur: '#d8d2ca' },
    { id: 'claudeapi', name: 'Claude API', tag: 'API', rank: '사원', role: '캐러셀 문구', color: '#fb923c', icon: 'claude', animal: 'bear', fur: '#d9a877' },
    { id: 'copilot', name: 'Copilot', tag: 'Copilot', rank: '디자인', role: '이미지 · 가끔', color: '#c4b5fd', icon: 'copilot', animal: 'fox', fur: '#f2b98a' },
    { id: 'pickle', name: '피클', tag: '피클', rank: '비서', role: '클라우드 비서', color: '#7ccf6b', mark: '피', src: 'pickle', animal: 'bear', fur: '#bfe3c9' },
    { id: 'stability', name: 'Stability', tag: 'Stability', rank: '휴직', role: '이미지 · 중단', color: '#a78bfa', icon: 'stability', animal: 'dog', fur: '#cfc6bb' },
    { id: 'instinct', name: 'Instinct', tag: 'Instinct', rank: '비서', role: '일정 · 자료 조사 · 콘텐츠', color: '#e2e8f0', mark: 'I', plate: '#ffffff', serif: true, src: 'pickle', animal: 'cat', fur: '#efe6d8' },
    { id: 'pally', name: 'Pally', tag: 'Pally', rank: '비서', role: '노션 비서', color: '#64748b', icon: 'pally', src: 'pickle', animal: 'panda', fur: '#f6f3ee' },
    { id: 'keyring', name: '키링', tag: '키링', rank: '비서', role: '정보 조사 · 일정 · 문서', color: '#f59e0b', mark: '키', src: 'pickle', animal: 'rabbit', fur: '#f3e3c3' }
  ];
  var CAST_BY = {};
  CAST.forEach(function (c) { CAST_BY[c.id] = c; });
  var CEO_DEF = { id: 'ceo', name: '대표님', tag: '대표님', rank: 'CEO', color: '#3f4f73', mark: '대', plate: '#f5d680', animal: 'bear', fur: '#c9996a', tie: true };

  /* 배경 그림(assets/office-bg.jpg, 1920 x 1280)의 픽셀 좌표. 자리는 그림 속 의자·소파에 맞췄다.
     area = 그 자리가 붙은 통로. 걸을 때는 자리 → 통로 마디(NODES) → … → 자리 순으로 간다. */
  var IMG_W = 1920, IMG_H = 1280, VB = { x: 50, y: 60, w: 1810, h: 1200 };
  var SEATS = {
    claude: [659, 950, 'CL'],
    opus: [644, 680, 'A'], aside: [756, 636, 'A'], muse: [869, 592, 'A'], exaone: [969, 552, 'A'], chatgpt: [1069, 520, 'A'],
    fable: [809, 774, 'B'], codex: [956, 714, 'B'], speech: [1073, 668, 'B'], routine: [1209, 624, 'B'], keyring: [1340, 580, 'B'],
    claudeapi: [972, 886, 'C'], copilot: [1103, 836, 'C'], stability: [1222, 786, 'C'], vooy: [1331, 742, 'C'], instinct: [1422, 705, 'C'],
    pickle: [1425, 800, 'R'], pally: [1512, 776, 'R']
  };
  var HOME = {};
  Object.keys(SEATS).forEach(function (id) { HOME[id] = { p: [SEATS[id][0], SEATS[id][1]], area: SEATS[id][2] }; });
  var CEO_SEAT = [600, 432];
  var NODES = { N: [1180, 440], EA: [1150, 495], EB: [1290, 585], EC: [1495, 702], R: [1420, 772], S: [1270, 890], SW: [860, 945],
    CL: [755, 965], WL: [530, 735], W: [470, 590], K: [1310, 615] };
  var ADJ = {};
  [['N', 'EA'], ['EA', 'EB'], ['EB', 'EC'], ['EC', 'R'], ['EC', 'S'], ['S', 'SW'], ['SW', 'CL'], ['EA', 'WL'], ['WL', 'W'], ['EB', 'K'], ['K', 'EC'], ['WL', 'CL']].forEach(function (e) {
    (ADJ[e[0]] = ADJ[e[0]] || []).push(e[1]); (ADJ[e[1]] = ADJ[e[1]] || []).push(e[0]);
  });
  var AREA = { A: ['EA', 'WL'], B: ['EB'], C: ['EC', 'SW'], CL: ['CL'], R: ['R'], M: ['N'], LW: ['W'], LS: ['SW', 'S'], BAR: ['K'] };
  /* 쉬는 자리(소파·1인 소파·탕비실 바 의자), 회의 자리(원형 탁자 둘레) */
  var REST_SPOTS = [{ p: [885, 1040], area: 'LS' }, { p: [240, 672], area: 'LW' }, { p: [1172, 965], area: 'LS' }, { p: [1325, 542], area: 'BAR' },
    { p: [308, 658], area: 'LW' }, { p: [950, 1068], area: 'LS' }, { p: [1387, 567], area: 'BAR' }, { p: [1446, 600], area: 'BAR' }];
  var MEET_SPOTS = [[982, 442], [852, 398], [1112, 398], [806, 348], [1160, 350], [918, 292], [1048, 292]];
  var GROUPS = { blog: '블로그', video: '영상', carousel: '캐러셀 · 인스타', server: '수집기' };
  var GROUP_ORDER = ['blog', 'video', 'carousel', 'server'];
  var CHIPS = [['working', '근무', '#34d399'], ['meeting', '회의', '#60a5fa'], ['resting', '휴식', '#fbbf24'], ['idle', '대기', '#d9cdbb'], ['offline', '퇴근', '#8b8177']];
  var SPR = 1.18;                       /* 캐릭터 크기 배율 */
  var WALK = 190;                       /* 걷는 속도(그림 픽셀/초) */

  var SVGNS = 'http://www.w3.org/2000/svg';

  var state = { cast: [], stations: [], logs: [], events: [], pc: { ok: false }, pickle: { ok: false }, mode: 'none',
    summary: { done: 0 }, tab: 'tower', view: { k: 1, x: 0, y: 0 }, popup: null, demo: false, ui: 1, placed: false, now: null };
  var chars = {};
  var V3 = null;                        /* 3D 화면(있으면 지도·캐릭터는 여기서 그린다) */
  var sortItems = [], sortSig = '';
  var simT = 0;
  var seenEv = {}, evQueue = [], firstIntake = true;

  /* ---------- helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function s(tag, attrs, parent) {
    var e = document.createElementNS(SVGNS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function pts(list) { return list.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' '); }
  function shade(hex, f) {
    var n = parseInt(hex.slice(1), 16);
    var r = Math.min(255, Math.round(((n >> 16) & 255) * f));
    var g = Math.min(255, Math.round(((n >> 8) & 255) * f));
    var b = Math.min(255, Math.round((n & 255) * f));
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }
  function str(v, max) {
    if (v == null) return '';
    var t = String(v).replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
  }
  function textW(t, size) {
    var w = 0;
    for (var i = 0; i < t.length; i++) w += t.charCodeAt(i) > 0x2e80 ? size : size * 0.58;
    return w;
  }
  function parseTime(v) {
    if (!v) return null;
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtHM(d) { return p2(d.getHours()) + ':' + p2(d.getMinutes()); }
  function fmtMDHM(d) { return p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + fmtHM(d); }
  function ago(d) {
    var sec = Math.round((Date.now() - d.getTime()) / 1000);
    if (sec < 45) return '방금';
    var m = Math.round(sec / 60);
    if (m < 60) return m + '분 전';
    if (m < 1440) return Math.floor(m / 60) + '시간 전';
    return Math.floor(m / 1440) + '일 전';
  }
  function agoEv(e) { return e.t ? (e.coarse ? '약 ' : '') + ago(e.t) : ''; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function stationRoom(id) {
    if (/^blog-/.test(id)) return 'blog';
    if (/^(shorts|reels|clip)$/.test(id)) return 'video';
    if (/^(carousel|insta)$/.test(id)) return 'carousel';
    return 'server';
  }

  /* ---------- data ---------- */
  function fetchJson(url) {
    return fetch(url + (url.indexOf('?') < 0 ? '?t=' : '&t=') + Date.now(), { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var cached = r.headers.get('x-aio-offline') === '1';
        return r.text().then(function (t) {
          var j = JSON.parse(t);
          if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('형식 오류');
          return { ok: true, data: j, text: t, updated: parseTime(j.updated_at), cached: cached };
        });
      })
      .catch(function () { return { ok: false }; });
  }

  function demoData() {
    /* ?demo=1 미리보기 전용(실제 상태 아님): 45초마다 사건이 하나씩 들어오는 것처럼 만든다 */
    var now = new Date(), t = function (sec) { return new Date(now.getTime() - sec * 1000).toISOString(); };
    var n = state.demoN = (state.demoN || 0) + 1;
    var ev = [
      { time: t(2), kind: 'dispatch', from: 'claude', to: 'muse', title: '클로드 → 뮤즈: 초안·사진 요청', coarse: false },
      { time: t(1), kind: 'dispatch', from: 'opus', to: 'exaone', title: 'Opus 보조 → 엑사원: 문체 검사 요청', coarse: true }
    ];
    if (n === 1) ev.unshift({ time: t(3), kind: 'meeting', from: 'claude', to: '', title: '회의 시작: 블로그 슬롯', coarse: true, members: ['claude', 'opus', 'aside', 'muse'] });
    if (n > 1) ev = [{ time: t(1), kind: 'report', from: 'aside', to: 'claude', title: '어사이드 → 클로드: 임시저장 1건 완료', coarse: false }];
    var c = function (id, status, bubble, task, sec) { return { id: id, status: status, bubble: bubble, task: task, last_active: sec == null ? '' : t(sec) }; };
    var ag = function (id, name, status, task) { return { id: id, name: name, role: '', status: status, bubble: '', task: task, last_active: t(200) }; };
    return { pc: { ok: true, updated: now, data: { updated_at: now.toISOString(), summary: { done_today: 3 },
      cast: [c('claude', 'working', '작업 지시 중', '지시받은 작업 지휘 중 · AI 5명 가동', 5), c('opus', 'working', '블로그 슬롯 작업 중', '블로그 슬롯 원고 작업 진행 중', 10),
        c('muse', 'working', '초안·사진 작업 중', '블로그 초안·사진 요청 처리 중', 60), c('aside', 'working', '에디터 입력 중', '블로그 에디터 입력·임시저장 진행 중', 20),
        c('exaone', 'resting', '방금 마침 · 휴식', '검사 요청 대기', 400), c('fable', 'working', '앱·화면 개발 중', '앱 개발 작업 진행 중', 15),
        c('speech', 'working', '음성 합성 중', '음성 합성 요청 처리 중', 90), c('chatgpt', 'idle', '호출 대기', '가끔 호출 · 대기', null),
        c('codex', 'offline', '', '현재 사용 불가', null), c('claudeapi', 'idle', '호출 대기', '최근 호출 없음 · 대기', null),
        c('copilot', 'resting', '방금 마침 · 휴식', '가끔 호출 · 대기', 700), c('stability', 'offline', '', '사용 중단', null),
        c('routine', 'idle', '다음 새벽 대기', '다음 새벽 실행 대기', null), c('vooy', 'idle', '대기 중', '활동 신호 미설정 · 대기', null)],
      events: ev,
      agents: [ag('blog-a', '블로그팀 A', 'working', '블로그 원고 1건 작성·검수 중'), ag('blog-b', '블로그팀 B', 'idle', '다음 슬롯 대기'), ag('blog-c', '블로그팀 C', 'idle', '다음 슬롯 대기'),
        ag('shorts', '쇼츠 작업자', 'working', '쇼츠 파이프라인 1건 진행 중'), ag('reels', '릴스 작업자', 'idle', '대기'), ag('clip', '클립 작업자', 'offline', '실행 중 아님'),
        ag('carousel', '캐러셀 작업자', 'idle', '대기'), ag('insta', '인스타 콘텐츠 작업자', 'idle', '대기'), ag('pubcheck', '발행 체크 수집기', 'idle', '대기'), ag('insight', '인사이트 수집기', 'idle', '대기')],
      logs: [{ time: t(900), agent: 'blog-a', title: '블로그 원고 1건 임시저장', detail: '' }, { time: t(2600), agent: 'shorts', title: '쇼츠 1건 완성', detail: '' },
        { time: t(5200), agent: 'pubcheck', title: '발행 점검 1회 완료', detail: '' }] } },
    pickle: { ok: true, updated: now, data: { updated_at: now.toISOString(), cast: [c('pickle', 'working', '', '', 30), c('instinct', 'idle', '', '', 2400)], agents: [], logs: [] } } };
  }

  function legacyCast(agents) {
    /* 옛 형식(감시 스크립트 재시작 전): 직무 목록에서 주인공 상태를 짐작한다 */
    var by = {}, out = [];
    agents.forEach(function (a) { if (a && a.id) by[a.id] = a; });
    function conv(a, id) {
      if (!a) return;
      var busy = a.status === 'working' || a.status === 'meeting';
      out.push({ id: id, status: busy ? 'working' : (a.status === 'offline' ? 'offline' : 'idle'), bubble: a.bubble, task: a.task, last_active: a.last_active });
    }
    conv(by.claude, 'claude'); conv(by.muse, 'muse'); conv(by.browser, 'aside'); conv(by.speech, 'speech');
    return out;
  }

  function normalize() {
    var cast = {}, stations = [], logs = [], events = [], done = 0, seen = {};
    CAST.forEach(function (c) {
      cast[c.id] = { id: c.id, name: c.name, tag: c.tag, role: c.role, color: c.color, src: c.src || 'pc', status: 'idle',
        bubble: '', task: '상태 정보 없음 · 대기', last: null, known: false, sub: [] };
    });
    [['pc', state.pc], ['pickle', state.pickle]].forEach(function (pair) {
      var key = pair[0], r = pair[1];
      r.stale = false;
      if (!r.ok) return;
      var d = r.data;
      var age = r.updated ? Date.now() - r.updated.getTime() : Infinity;
      r.stale = key === 'pc' && age > STALE_MS;          /* 노션 파일은 바뀔 때만 올라오니 '지연'으로 보지 않는다 */
      var dead = key === 'pc' && age > DEAD_MS;
      var sum = d.summary && typeof d.summary === 'object' ? d.summary : {};
      var n = Number(sum.done_today);
      if (isFinite(n) && n > 0) done += Math.floor(n);
      var agents = (Array.isArray(d.agents) ? d.agents : []).filter(function (a) { return a && typeof a === 'object'; });
      var legacy = !Array.isArray(d.cast);
      var castArr = legacy ? (key === 'pc' ? legacyCast(agents) : []) : d.cast;
      castArr.forEach(function (c) {
        if (!c || typeof c !== 'object' || !cast[c.id]) return;
        if ((key === 'pickle') !== !!NOTION_IDS[c.id]) return;   /* 노션 파일은 노션 비서만, PC 쪽은 나머지만 */
        var m = cast[c.id];
        var st = c.status === 'meeting' ? 'working' : (STATUS[c.status] ? c.status : 'idle');
        m.status = st; m.bubble = str(c.bubble, 18); m.task = str(c.task, 80) || STATUS[st].label;
        m.last = parseTime(c.last_active); m.known = true;
        if (key === 'pickle' && st !== 'offline') {
          /* 노션 비서: 파일은 바뀔 때만 올라오므로 '마지막 보고 뒤 몇 분'으로 화면에서 다시 계산 */
          var ageN = m.last ? Date.now() - m.last.getTime() : Infinity;
          m.status = ageN <= NOTION_WORK_MS ? 'working' : (ageN <= NOTION_REST_MS ? 'resting' : 'idle');
          m.bubble = NOTION_TEXT[m.status][0]; m.task = NOTION_TEXT[m.status][1];
          return;
        }
        if (dead && (st === 'working' || st === 'resting')) { m.status = 'idle'; m.bubble = ''; m.task = '상태 갱신 지연 · 최근 상태 확인 불가'; }
      });
      agents.forEach(function (a) {
        var id = str(a.id, 40) || str(a.name, 40);
        if (!id || (key === 'pc' && CAST_BY[id]) || (key === 'pc' && legacy && id === 'browser')) return;
        var st = a.status === 'meeting' ? 'working' : (STATUS[a.status] ? a.status : 'idle');
        var item = { id: id, src: key, name: str(a.name, 24) || id, role: str(a.role, 40),
          status: st, bubble: str(a.bubble, 26), task: str(a.task, 80), last: parseTime(a.last_active) };
        if (key === 'pickle') { cast.pickle.sub.push(item); return; }
        if (seen[id]) return;
        seen[id] = true;
        item.room = stationRoom(id);
        stations.push(item);
      });
      if (key === 'pickle' && !cast.pickle.known) {
        /* 피클 파일에 cast 가 없으면 세부 항목으로 피클 상태를 만든다 */
        var p = cast.pickle, busy = null, last = null;
        p.sub.forEach(function (x) {
          if (!busy && x.status === 'working') busy = x;
          if (x.last && (!last || x.last > last)) last = x.last;
        });
        p.known = true; p.last = last;
        if (busy && !dead) { p.status = 'working'; p.bubble = str(busy.bubble, 18) || '요청 처리 중'; p.task = busy.task || '요청 처리 중'; }
        else { p.status = 'idle'; p.bubble = ''; p.task = '요청 대기'; }
      }
      (Array.isArray(d.logs) ? d.logs : []).slice(0, 200).forEach(function (l) {
        if (!l || typeof l !== 'object') return;
        var t = parseTime(l.time);
        logs.push({ t: t, timeText: t ? fmtHM(t) : str(l.time, 8), agent: str(l.agent, 40), title: str(l.title, 60), detail: str(l.detail, 120), src: key });
      });
      (Array.isArray(d.events) ? d.events : []).slice(0, 40).forEach(function (e) {
        if (!e || typeof e !== 'object') return;
        var t = parseTime(e.time), title = str(e.title, 60);
        if (!t || !title) return;
        events.push({ t: t, key: e.time + '|' + title, kind: /^(dispatch|report|meeting|note)$/.test(e.kind) ? e.kind : 'note',
          from: cast[e.from] ? e.from : '', to: cast[e.to] ? e.to : '', title: title, coarse: e.coarse !== false,
          members: (Array.isArray(e.members) ? e.members : []).filter(function (m) { return cast[m]; }).slice(0, 7) });
      });
    });
    logs.sort(function (a, b) { return (b.t ? b.t.getTime() : 0) - (a.t ? a.t.getTime() : 0); });
    events.sort(function (a, b) { return b.t.getTime() - a.t.getTime(); });
    /* vooy: 활동 신호를 아직 모른다 -> '대기'가 아니라 '연결 안 됨'(회색)으로 보여 준다 */
    ['instinct', 'pally', 'keyring'].forEach(function (id) {
      if (!cast[id].known) { cast[id].status = 'offline'; cast[id].bubble = ''; cast[id].task = '연결 안 됨 · 연락판 연결 전'; }
    });
    var v = cast.vooy;
    if (!v.known || /미설정/.test(v.task)) { v.status = 'offline'; v.bubble = ''; v.task = '연결 안 됨 · 활동 신호 미확인'; }
    state.cast = CAST.map(function (c) { return cast[c.id]; });
    state.stations = stations; state.logs = logs; state.events = events; state.summary = { done: done };
  }

  /* 새로 들어온 사건 가운데 '방금 일어난 것'만 재생 대기열에 넣는다 */
  function intakeEvents() {
    var limit = firstIntake ? 90000 : EVENT_PLAY_MS;
    state.events.slice().reverse().forEach(function (e) {
      if (seenEv[e.key]) return;
      seenEv[e.key] = true;
      var age = Date.now() - e.t.getTime();
      if (age <= limit && age > -120000) { if (V3) V3.pushEvent(e); else evQueue.push({ e: e, at: simT }); }
    });
    firstIntake = false;
  }

  /* 대화창(assets/chat.js)이 부른다: 고정 문구 한 줄을 그 AI 머리 위에 띄운다. 지시·답 내용은 여기로 오지 않는다. */
  window.__aioLocalNote = function (title, id) {
    var to = id && CAST_BY[id] ? id : 'claude';
    var e = { t: new Date(), key: 'local|' + to + '|' + Date.now(), kind: 'note', from: '', to: to, title: String(title).slice(0, 24), coarse: false, members: [] };
    if (state.demo || !state.placed) return;
    if (V3) V3.pushEvent(e); else evQueue.push({ e: e, at: simT });
  };

  var lastSig = '';
  function apply() {
    var sig = (state.pc.ok ? state.pc.text || JSON.stringify(state.pc.data) : 'x') + '|' + (state.pickle.ok ? state.pickle.text || JSON.stringify(state.pickle.data) : 'x') + '|' + state.mode;
    if (sig === lastSig) { renderFoot(); return; }
    lastSig = sig;
    normalize();
    renderAll();
    if (state.pc.ok || state.pickle.ok) {
      if (!state.placed) { if (V3) V3.placeAll(); else placeAll(); state.placed = true; }
      intakeEvents();
    }
  }

  var lastFile = 0, lastPickle = 0;
  function poll() {
    if (state.demo) { var d = demoData(); state.pc = d.pc; state.pickle = d.pickle; state.mode = 'demo'; apply(); return Promise.resolve(); }
    var jobs = [fetchJson(LIVE_URL)], now = Date.now();
    var wantPickle = now - lastPickle >= FILE_MS - 500;
    if (wantPickle) {
      lastPickle = now;
      jobs.push(fetchJson(NOTION_URL).then(function (r) { return r.ok && Array.isArray(r.data.cast) ? r : fetchJson(PICKLE_URL); }));
    }
    return Promise.all(jobs).then(function (res) {
      var live = res[0];
      if (wantPickle) state.pickle = res[1];
      var liveGood = live.ok && live.updated && Date.now() - live.updated.getTime() < LIVE_FRESH_MS;
      if (liveGood) { state.pc = live; state.mode = 'live'; return; }
      if (Date.now() - lastFile < FILE_MS - 500 && state.pc.ok) return;
      lastFile = Date.now();
      return fetchJson(FILE_URL).then(function (file) {
        /* 둘 중 더 새 것을 쓴다 */
        var pickLive = live.ok && live.updated && (!file.ok || !file.updated || live.updated >= file.updated);
        state.pc = pickLive ? live : file;
        state.mode = pickLive ? 'live' : (file.ok ? 'file' : 'none');
      });
    }).then(apply, apply);
  }

  /* ---------- 배경 ---------- */
  function castOf(id) { var r = null; state.cast.forEach(function (c) { if (c.id === id) r = c; }); return r; }
  var sceneBuilt = false, ceo = null;
  function buildScene() {
    sceneBuilt = true;
    var im = s('image', { x: 0, y: 0, width: IMG_W, height: IMG_H, preserveAspectRatio: 'none' }, $('floor'));
    im.setAttribute('href', 'assets/office-bg.jpg');
    /* 대표님 자리: 고정 인형(상태·말풍선 없음, 움직이지 않음) */
    var sp = sprite(CEO_DEF, SPR * 1.08), tr = 'translate(' + CEO_SEAT[0] + ',' + CEO_SEAT[1] + ')';
    sp.g.setAttribute('transform', tr);
    sp.ring.setAttribute('stroke', 'rgba(245,214,128,.75)');
    sp.g.style.pointerEvents = 'none';
    var o = s('g', { transform: tr }, $('overlay'));
    o.style.pointerEvents = 'none';
    var tg = buildTag(o, CEO_DEF);
    tg.box.setAttribute('stroke', '#f5d680'); tg.dot.setAttribute('fill', '#f5d680');
    ceo = { tag: tg, item: { depth: CEO_SEAT[1], el: sp.g }, uiShown: 0 };
  }

  /* ---------- 캐릭터 ---------- */
  function animalHead(g, kind, fur, hy) {
    var dark = shade(fur, 0.7), inner = '#f3b9ae', ink = '#2d2622';
    [-1, 1].forEach(function (k) {
      if (kind === 'bear' || kind === 'panda') {
        s('circle', { cx: k * 15, cy: hy - 15, r: 7.6, fill: kind === 'panda' ? ink : fur, stroke: kind === 'panda' ? ink : dark, 'stroke-width': 1 }, g);
        if (kind === 'bear') s('circle', { cx: k * 15, cy: hy - 15, r: 3.6, fill: inner }, g);
      } else if (kind === 'cat' || kind === 'fox') {
        s('polygon', { points: pts([[k * 20, hy - 7], [k * 17.5, hy - 28], [k * 3.5, hy - 17]]), fill: fur, stroke: dark, 'stroke-width': 1, 'stroke-linejoin': 'round' }, g);
        s('polygon', { points: pts([[k * 16.5, hy - 12], [k * 15.5, hy - 23], [k * 8, hy - 17]]), fill: kind === 'fox' ? '#4a3328' : inner }, g);
      } else if (kind === 'rabbit') {
        var rot = 'rotate(' + (k * 9) + ' ' + (k * 9) + ' ' + (hy - 14) + ')';
        s('ellipse', { cx: k * 9, cy: hy - 28, rx: 5.6, ry: 15, fill: fur, stroke: dark, 'stroke-width': 1, transform: rot }, g);
        s('ellipse', { cx: k * 9, cy: hy - 28, rx: 2.4, ry: 10, fill: inner, transform: rot }, g);
      }
    });
    s('ellipse', { cx: 0, cy: hy, rx: 21, ry: 19, fill: fur, stroke: dark, 'stroke-width': 1.2 }, g);
    [-1, 1].forEach(function (k) {
      if (kind === 'dog') s('ellipse', { cx: k * 19.5, cy: hy - 3, rx: 6, ry: 12.5, fill: shade(fur, 0.62), transform: 'rotate(' + (k * -12) + ' ' + (k * 19.5) + ' ' + (hy - 14) + ')' }, g);
      if (kind === 'panda') s('ellipse', { cx: k * 8.5, cy: hy - 1, rx: 5.6, ry: 6.8, fill: ink, transform: 'rotate(' + (k * 18) + ' ' + (k * 8.5) + ' ' + (hy - 1) + ')' }, g);
    });
    if (kind === 'fox') s('ellipse', { cx: 0, cy: hy + 9, rx: 14, ry: 8.5, fill: '#fff8ef' }, g);
    s('ellipse', { cx: 0, cy: hy + 6.5, rx: 7.6, ry: 5.6, fill: '#fffaf2' }, g);
    [-1, 1].forEach(function (k) {
      s('circle', { cx: k * 8.5, cy: hy - 1.5, r: 2.7, fill: kind === 'panda' ? '#ffffff' : ink }, g);
      if (kind === 'panda') s('circle', { cx: k * 8.5, cy: hy - 1.5, r: 1.3, fill: ink }, g);
      s('circle', { cx: k * 14.5, cy: hy + 5.5, r: 3.1, fill: 'rgba(238,120,110,.42)' }, g);
    });
    s('ellipse', { cx: 0, cy: hy + 4.2, rx: 2.7, ry: 2, fill: ink }, g);
  }
  function sprite(def, big) {
    var col = def.color, dark = shade(col, 0.6);
    var sp = { g: s('g', {}) };
    s('ellipse', { cx: 0, cy: 1, rx: 21 * big, ry: 8 * big, fill: 'rgba(30,18,8,.36)' }, sp.g);
    sp.ring = s('ellipse', { cx: 0, cy: 1, rx: 26 * big, ry: 10.5 * big, fill: 'none', 'stroke-width': 2.4 }, sp.g);
    var b = sp.body = s('g', {}, s('g', { transform: 'scale(' + big.toFixed(2) + ')' }, sp.g));
    sp.legL = s('rect', { x: -10.5, y: -9, width: 8.5, height: 9, rx: 3.2, fill: dark }, b);
    sp.legR = s('rect', { x: 2, y: -9, width: 8.5, height: 9, rx: 3.2, fill: dark }, b);
    sp.armL = s('rect', { x: -19.5, y: -35, width: 7.5, height: 17, rx: 3.7, fill: shade(def.fur, 0.9) }, b);
    sp.armR = s('rect', { x: 12, y: -35, width: 7.5, height: 17, rx: 3.7, fill: shade(def.fur, 0.9) }, b);
    s('rect', { x: -14.5, y: -39, width: 29, height: 31, rx: 10.5, fill: col, stroke: dark, 'stroke-width': 1 }, b);
    if (def.tie) s('polygon', { points: '0,-37 -3.4,-32 0,-17 3.4,-32', fill: '#7c2d12' }, b);
    else s('rect', { x: -6, y: -30, width: 12, height: 9, rx: 2.5, fill: 'rgba(255,255,255,.55)' }, b);
    animalHead(b, def.animal, def.fur, -55);
    sp.top = (def.animal === 'rabbit' ? 102 : 86) * big;
    return sp;
  }
  /* 이름표: [공식 아이콘 배지] 이름 · 직급 */
  function buildTag(o, def) {
    var t = { def: def, g: s('g', {}, o), label: null };
    t.box = s('rect', { y: 6, height: 18, rx: 9, fill: 'rgba(26,19,13,.9)', 'stroke-width': 1.3 }, t.g);
    t.plate = s('rect', { y: 8, width: 14, height: 14, rx: 4.2, fill: def.icon ? '#ffffff' : (def.plate || def.color) }, t.g);
    if (def.icon) {
      t.im = s('image', { y: 9, width: 12, height: 12, preserveAspectRatio: 'xMidYMid meet' }, t.g);
      t.im.setAttribute('href', ICON_DIR + def.icon + '.png');
    } else {
      t.mk = s('text', { y: 18.5, 'text-anchor': 'middle', 'font-size': 9.5, 'font-weight': 800, fill: '#17120d' }, t.g);
      if (def.serif) { t.mk.setAttribute('font-family', 'Georgia, "Times New Roman", serif'); t.mk.setAttribute('font-size', 11.5); t.mk.setAttribute('y', 19); }
      t.mk.textContent = def.mark || def.name.slice(0, 1);
    }
    t.dot = s('circle', { cy: 9.2, r: 2.7, stroke: '#1a130d', 'stroke-width': 1 }, t.g);
    t.text = s('text', { y: 18.7, 'font-size': 10, 'font-weight': 700, fill: '#fff6ea' }, t.g);
    return t;
  }
  function layoutTag(t, short) {
    var label = short || !t.def.rank ? t.def.tag : t.def.tag + ' · ' + t.def.rank;
    if (label === t.label) return;
    t.label = label;
    var w = t.w = 22 + textW(label, 10) + 8, x0 = -w / 2;
    t.box.setAttribute('x', x0.toFixed(1)); t.box.setAttribute('width', w.toFixed(1));
    t.plate.setAttribute('x', (x0 + 2.5).toFixed(1));
    if (t.im) t.im.setAttribute('x', (x0 + 3.5).toFixed(1));
    if (t.mk) t.mk.setAttribute('x', (x0 + 9.5).toFixed(1));
    t.dot.setAttribute('cx', (x0 + 16).toFixed(1));
    t.text.setAttribute('x', (x0 + 21.5).toFixed(1));
    t.text.textContent = label;
  }
  function buildChar(c) {
    var def = CAST_BY[c.id], sp = sprite(def, SPR * (c.id === 'claude' ? 1.08 : 1));
    c.el = sp.g; c.ring = sp.ring; c.body = sp.body; c.legL = sp.legL; c.legR = sp.legR; c.armL = sp.armL; c.armR = sp.armR; c.top = sp.top;
    c.el.setAttribute('class', 'char'); c.el.setAttribute('tabindex', 0); c.el.setAttribute('role', 'button'); c.el.setAttribute('aria-label', def.name);
    c.zz = s('text', { 'class': 'char-zz', x: 20, y: -74, 'font-size': 15, 'font-weight': 800, fill: '#fff6ea', stroke: 'rgba(26,19,13,.7)', 'stroke-width': 0.6 }, c.body);
    c.zz.textContent = 'z';
    var open = function (ev) { ev.stopPropagation(); if (!drag.moved) openPopup('cast', c.id); };
    c.el.addEventListener('click', open);
    c.el.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openPopup('cast', c.id); } });
    var o = c.over = s('g', {});
    o.style.cursor = 'pointer';
    o.addEventListener('click', open);
    c.tag = buildTag(o, def);
    c.bub = s('g', {}, o);
    c.bubRect = s('rect', { y: -31, height: 21, rx: 9, fill: '#fffdf8', stroke: 'rgba(60,40,20,.25)', 'stroke-width': 0.8 }, c.bub);
    s('polygon', { points: '-5,-10.6 5,-10.6 0,-4', fill: '#fffdf8' }, c.bub);
    c.bubText = s('text', { x: 0, y: -16.6, 'text-anchor': 'middle', 'font-size': 10.5, 'font-weight': 700, fill: '#2a1d12' }, c.bub);
    c.bubShown = null;
  }

  function homeOf(c) {
    if (c.data.status !== 'resting') return HOME[c.id];
    var n = 0;
    for (var i = 0; i < state.cast.length && state.cast[i].id !== c.id; i++) if (state.cast[i].status === 'resting') n++;
    return REST_SPOTS[n % REST_SPOTS.length];
  }

  function ensureChars() {
    state.cast.forEach(function (d, i) {
      var c = chars[d.id];
      if (!c) {
        var hm = HOME[d.id];
        c = chars[d.id] = { id: d.id, x: hm.p[0], y: hm.p[1], atArea: hm.area, destArea: hm.area, path: [], speed: WALK,
          seed: i * 1.7, walk: 0, flash: null, act: null };
        buildChar(c);
      }
      c.data = d;
      var col = STATUS[d.status].color;
      c.ring.setAttribute('stroke', col); c.tag.box.setAttribute('stroke', col); c.tag.dot.setAttribute('fill', col);
      c.tag.dot.setAttribute('class', d.status === 'working' ? 'lamp-on' : '');
      c.el.setAttribute('opacity', d.status === 'offline' ? 0.5 : 1);
      c.over.setAttribute('opacity', d.status === 'offline' ? 0.7 : 1);
      c.zz.style.display = d.status === 'offline' || d.status === 'resting' ? '' : 'none';
    });
  }
  function placeAll() {
    for (var id in chars) { var c = chars[id], hm = homeOf(c); c.x = hm.p[0]; c.y = hm.p[1]; c.atArea = c.destArea = hm.area; c.path = []; }
  }

  /* ---------- 길 찾기: 자리 → 통로 마디 → … → 자리 ---------- */
  function nodeDist(a, x, y) { return Math.hypot(NODES[a][0] - x, NODES[a][1] - y); }
  function route(c, place) {
    if (c.atArea && c.atArea === place.area) return [place.p.slice()];
    var starts, k, best = null, bd = Infinity;
    if (c.atArea) starts = AREA[c.atArea];
    else { for (k in NODES) if (nodeDist(k, c.x, c.y) < bd) { bd = nodeDist(k, c.x, c.y); best = k; } starts = [best]; }
    var dist = {}, prev = {}, done = {};
    for (k in NODES) dist[k] = Infinity;
    starts.forEach(function (n) { dist[n] = nodeDist(n, c.x, c.y); });
    for (;;) {
      var u = null;
      for (k in NODES) if (!done[k] && dist[k] < Infinity && (u === null || dist[k] < dist[u])) u = k;
      if (u === null) break;
      done[u] = true;
      (ADJ[u] || []).forEach(function (v) {
        var d = dist[u] + nodeDist(v, NODES[u][0], NODES[u][1]);
        if (d < dist[v]) { dist[v] = d; prev[v] = u; }
      });
    }
    best = null; bd = Infinity;
    AREA[place.area].forEach(function (n) { var d = dist[n] + nodeDist(n, place.p[0], place.p[1]); if (d < bd) { bd = d; best = n; } });
    var P = [place.p.slice()];
    for (var n = best; n; n = prev[n]) P.unshift(NODES[n].slice());
    return P;
  }
  function goTo(c, place) {
    if (Math.hypot(c.x - place.p[0], c.y - place.p[1]) < 2) { c.path = []; c.atArea = c.destArea = place.area; return; }
    c.path = route(c, place);
    c.destArea = place.area; c.atArea = null;
  }
  function say(c, text, sec) { c.flash = { text: text, until: simT + sec }; }
  function placeOf(c) {
    /* 캐릭터가 (걷는 중이면 도착해서) 서 있을 곳 */
    return { p: c.path.length ? c.path[c.path.length - 1] : [c.x, c.y], area: c.destArea };
  }
  function besideOf(target) {
    var pl = placeOf(target), row = /^[ABC]$/.test(pl.area);
    return { p: row ? [pl.p[0] + 52, pl.p[1] - 14] : [pl.p[0] + 58, pl.p[1] + 10], area: pl.area };
  }
  function phraseOf(e) { var i = e.title.indexOf(': '); return i >= 0 ? e.title.slice(i + 2) : e.title; }

  /* 실제 사건 하나를 화면 동작으로 옮긴다. 관련 AI 가 다른 동작 중이면 기다린다. */
  function tryStartEvents() {
    for (var i = 0; i < evQueue.length; i++) {
      var q = evQueue[i], e = q.e;
      if (simT - q.at > 150) { evQueue.splice(i--, 1); continue; }
      var ids = e.kind === 'meeting' ? e.members.slice() : [e.from, e.to].filter(Boolean);
      var who = ids.map(function (id) { return chars[id]; }).filter(Boolean);
      if (who.some(function (c) { return c.act; })) continue;
      evQueue.splice(i--, 1);
      setTicker(e);
      if (e.kind === 'meeting' && who.length >= 2) {
        var m = { type: 'meet', who: who, title: e.title, end: null, t0: simT };
        var seat = who.indexOf(chars.claude) >= 0 ? 1 : 0;
        who.forEach(function (c) {
          c.act = m;
          goTo(c, { p: MEET_SPOTS[c.id === 'claude' ? 0 : seat++ % MEET_SPOTS.length], area: 'M' });
        });
      } else if ((e.kind === 'dispatch' || e.kind === 'report') && who.length === 2 && chars[e.from] && chars[e.to]) {
        var a = chars[e.from], b = chars[e.to];
        var text = e.kind === 'dispatch' ? CAST_BY[e.to].tag + ', ' + phraseOf(e) : phraseOf(e);
        a.act = { type: 'visit', other: b, text: text, end: null, t0: simT };
        b.act = { type: 'host', other: a, t0: simT };
        goTo(a, besideOf(b));
      } else {
        var c = chars[e.to] || chars[e.from];
        if (c) say(c, phraseOf(e), 6);
      }
    }
  }
  function stepAct(c) {
    var a = c.act;
    if (simT - a.t0 > 75) { release(c); return; }                     /* 안전장치 */
    if (a.type === 'visit') {
      if (a.end == null && !c.path.length) { a.end = simT + 5; say(c, a.text, 4.6); }
      if (a.end != null && simT > a.end) { if (a.other.act && a.other.act.other === c) release(a.other); release(c); }
    } else if (a.type === 'meet') {
      if (a.end == null && a.who.every(function (x) { return !x.path.length; })) {
        a.end = simT + 9;
        say(chars.claude && a.who.indexOf(chars.claude) >= 0 ? chars.claude : a.who[0], a.title, 6);
      }
      if (a.end != null && simT > a.end) a.who.forEach(release);
    }
  }
  function release(c) { c.act = null; }

  function step(dt) {
    simT += dt;
    tryStartEvents();
    for (var id in chars) {
      var c = chars[id];
      if (!c.data) continue;
      if (c.act) stepAct(c);
      else if (!c.path.length) {
        /* 할 일이 없으면 상태가 정한 자리(책상·쉬는 자리)로 돌아가 머문다 */
        var hm = homeOf(c);
        if (Math.hypot(c.x - hm.p[0], c.y - hm.p[1]) > 2) goTo(c, hm);
      }
      if (c.path.length) {
        var left = c.speed * dt;
        while (left > 0 && c.path.length) {
          var p = c.path[0], dx = p[0] - c.x, dy = p[1] - c.y, dist = Math.hypot(dx, dy);
          if (dist <= left) { c.x = p[0]; c.y = p[1]; c.path.shift(); left -= dist; }
          else { c.x += dx / dist * left; c.y += dy / dist * left; left = 0; }
        }
        if (!c.path.length) c.atArea = c.destArea;
        c.walk += dt * 11;
      }
      if (c.flash && simT > c.flash.until) c.flash = null;
    }
  }

  /* 왼쪽 위 상태 칩: 근무 · 회의 · 휴식 · 대기 · 퇴근 (회의 = 실제 회의 사건으로 지금 모여 있는 수) */
  var chipSig = '';
  function renderChips() {
    var n = { working: 0, meeting: 0, resting: 0, idle: 0, offline: 0 };
    state.cast.forEach(function (d) { var c = chars[d.id]; if (V3 ? V3.inMeeting(d.id) : (c && c.act && c.act.type === 'meet')) n.meeting++; else n[d.status]++; });
    var sig = JSON.stringify(n);
    if (sig === chipSig) return;
    chipSig = sig;
    var box = $('statChips'); box.textContent = '';
    CHIPS.forEach(function (k) {
      var sp = h('span', 'stat'), i = h('i'); i.style.background = k[2];
      sp.appendChild(i); sp.appendChild(document.createTextNode(k[1] + ' ')); sp.appendChild(h('b', null, String(n[k[0]])));
      box.appendChild(sp);
    });
  }

  function draw() {
    var ui = state.ui, added = false, short = ui > 2.15;
    if (ceo && ceo.uiShown !== ui) { ceo.uiShown = ui; layoutTag(ceo.tag, short); ceo.tag.g.setAttribute('transform', 'scale(' + ui.toFixed(2) + ')'); }
    for (var id in chars) {
      var c = chars[id];
      if (!c.data) continue;
      var moving = c.path.length > 0, st = c.data.status, bob, ph = c.walk;
      var hm = homeOf(c), atHome = !moving && !c.act && Math.hypot(c.x - hm.p[0], c.y - hm.p[1]) < 2.5;
      var tr = 'translate(' + c.x.toFixed(1) + ',' + c.y.toFixed(1) + ')';
      c.el.setAttribute('transform', tr);
      c.over.setAttribute('transform', tr);
      var typing = st === 'working' && atHome;
      if (moving) {
        bob = -Math.abs(Math.sin(ph)) * 2.6;
        c.legL.setAttribute('y', (-9 - Math.max(0, Math.sin(ph)) * 4).toFixed(1));
        c.legR.setAttribute('y', (-9 - Math.max(0, -Math.sin(ph)) * 4).toFixed(1));
        c.armL.setAttribute('y', (-35 + Math.sin(ph) * 3).toFixed(1));
        c.armR.setAttribute('y', (-35 - Math.sin(ph) * 3).toFixed(1));
      } else {
        bob = st === 'offline' ? 0 : Math.sin(simT * (typing ? 3.2 : 1.5) + c.seed) * (typing ? 1.2 : 0.8);
        c.legL.setAttribute('y', -9); c.legR.setAttribute('y', -9);
        c.armL.setAttribute('y', typing ? (-36.5 + Math.sin(simT * 13 + c.seed) * 2.2).toFixed(1) : -35);
        c.armR.setAttribute('y', typing ? (-36.5 - Math.sin(simT * 13 + c.seed) * 2.2).toFixed(1) : -35);
      }
      c.body.setAttribute('transform', 'translate(0,' + bob.toFixed(1) + ')');
      if (c.uiShown !== ui) {
        c.uiShown = ui;
        layoutTag(c.tag, short);
        c.tag.g.setAttribute('transform', 'scale(' + ui.toFixed(2) + ')');
      }
      var text = c.flash ? c.flash.text : (typing ? c.data.bubble : '');
      if (text !== c.bubShown) {
        c.bubShown = text;
        if (!text) c.bub.style.display = 'none';
        else {
          var bt = str(text, 20), bw = textW(bt, 10.5) + 18;
          c.bub.style.display = '';
          c.bubRect.setAttribute('x', (-bw / 2).toFixed(1)); c.bubRect.setAttribute('width', bw.toFixed(1));
          c.bubText.textContent = bt;
          c.bubW = bw;
          c.over.parentNode.appendChild(c.over);              /* 말하는 쪽을 맨 위로 */
        }
      }
      if (text) {
        /* 말풍선이 다른 직원의 이름표를 가리면 그 이름표 위로 올린다(누구인지는 늘 보이게) */
        var us = ui * 0.9, hw = c.bubW * us / 2, by1 = c.y - c.top - 4 * us, by0 = by1 - 27 * us, lift = 0;
        for (var oid in chars) {
          var o = chars[oid];
          if (o === c || !o.data || !o.tag.w) continue;
          if (Math.abs(o.x - c.x) < hw + o.tag.w * ui / 2 && by1 > o.y + 5 * ui && by0 < o.y + 25 * ui) lift = Math.max(lift, by1 - (o.y + 4 * ui));
        }
        var bt2 = 'translate(0,' + (-c.top - Math.min(lift, 80)).toFixed(1) + ') scale(' + us.toFixed(2) + ')';
        if (bt2 !== c.bubTr) { c.bubTr = bt2; c.bub.setAttribute('transform', bt2); }
      }
      if (!c.item) { c.item = { depth: 0, el: c.el }; added = true; }
      c.item.depth = c.y;
    }
    /* 깊이 정렬(아래쪽에 있을수록 앞): 순서가 바뀐 때만 DOM 을 다시 꽂는다 */
    var arr = (ceo ? [ceo.item] : []).concat(Object.keys(chars).map(function (id) { return chars[id].item; }).filter(Boolean));
    arr.forEach(function (it, i) { if (it.n == null) it.n = i + Math.random(); });
    arr.sort(function (a, b) { return a.depth - b.depth || a.n - b.n; });
    var sig = arr.map(function (it) { return it.n; }).join(',');
    if (sig !== sortSig || added) {
      sortSig = sig;
      var layer = $('sorted');
      arr.forEach(function (it) { layer.appendChild(it.el); });
    }
    renderChips();
  }

  function renderMap() {
    if (V3) { V3.sync(state.cast); renderChips(); return; }
    if (!sceneBuilt) buildScene();
    ensureChars();
    for (var id in chars) if (chars[id].over.parentNode !== $('overlay')) $('overlay').appendChild(chars[id].over);
    applyView();
    draw();
  }

  /* 화면 갱신: 보통은 requestAnimationFrame, 프레임이 드문 환경(절전·일부 웹뷰)에서는 타이머가 대신 민다.
     지난 시간만큼 잘게 나눠 진행하므로 프레임이 띄엄띄엄 와도 걷는 속도는 같다. */
  var lastTs = 0;
  function tick() {
    var ts = performance.now();
    var el = lastTs ? Math.min(2, (ts - lastTs) / 1000) : 0;
    lastTs = ts;
    if (V3 || el <= 0 || !state.cast.length) return;
    while (el > 0.0001) { var dt = Math.min(0.05, el); step(dt); el -= dt; }
    draw();
  }
  function frame() { tick(); requestAnimationFrame(frame); }
  setInterval(function () { if (!document.hidden && performance.now() - lastTs > 220) tick(); }, 250);

  /* ---------- zoom / pan ---------- */
  var VB_W = VB.w, VB_H = VB.h;
  var drag = { on: false, moved: false, sx: 0, sy: 0, ox: 0, oy: 0 };
  var touches = {}, pinch = null;
  function applyView() {
    var v = state.view;
    $('world').setAttribute('transform', 'translate(' + v.x.toFixed(1) + ',' + v.y.toFixed(1) + ') scale(' + v.k.toFixed(3) + ')');
    $('map').classList.toggle('zoomed', v.k > 1.01);
    fitUi();
  }
  var viewTouched = false;
  function zoomBy(f) {
    viewTouched = true;
    var v = state.view, cx = VB.x + VB.w / 2, cy = VB.y + VB.h / 2;
    var nk = Math.max(0.7, Math.min(5, v.k * f));
    v.x = cx - (cx - v.x) * (nk / v.k);
    v.y = cy - (cy - v.y) * (nk / v.k);
    v.k = nk;
    applyView();
  }
  function svgScale() {
    var r = $('map').getBoundingClientRect();
    if (!r.width || !r.height) return 1;
    return Math.max(VB_W / r.width, VB_H / r.height);
  }
  /* 이름표·말풍선은 확대 배율과 상관없이 화면에서 읽을 수 있는 크기(글자 약 10px)로 */
  function fitUi() { state.ui = Math.round(clamp(1.05 * svgScale() / state.view.k, 1.0, 2.3) * 20) / 20; }
  function defaultView() {
    /* 좁은 화면(휴대폰 세로)은 책상이 모인 곳(그림 좌표 1010, 700)을 가운데로 당겨서 시작 */
    var r = $('map').getBoundingClientRect();
    var k = r.width && r.width < 620 && r.height > r.width * 0.7 ? clamp(760 / r.width, 1, 2.1) : 1;
    var cx = VB.x + VB.w / 2, cy = VB.y + VB.h / 2;
    return k > 1.01 ? { k: k, x: cx - 1010 * k, y: cy - 700 * k } : { k: 1, x: 0, y: 0 };
  }
  function initMapControls() {
    var map = $('map');
    if (V3) {
      $('zoomIn').addEventListener('click', function () { V3.zoom(1.25); });
      $('zoomOut').addEventListener('click', function () { V3.zoom(0.8); });
      $('zoomFit').addEventListener('click', function () { V3.reset(); });
      setInterval(renderChips, 500);
      return;
    }
    $('zoomIn').addEventListener('click', function () { zoomBy(1.25); });
    $('zoomOut').addEventListener('click', function () { zoomBy(0.8); });
    $('zoomFit').addEventListener('click', function () { viewTouched = true; state.view = { k: 1, x: 0, y: 0 }; applyView(); });
    map.addEventListener('wheel', function (ev) { ev.preventDefault(); zoomBy(ev.deltaY < 0 ? 1.12 : 0.89); }, { passive: false });
    map.addEventListener('pointerdown', function (ev) {
      drag.on = true; drag.moved = false; drag.sx = ev.clientX; drag.sy = ev.clientY; drag.ox = state.view.x; drag.oy = state.view.y;
      if (ev.pointerType === 'touch') {
        touches[ev.pointerId] = [ev.clientX, ev.clientY];
        var ids = Object.keys(touches);
        if (ids.length === 2) {       /* 두 손가락: 벌리면 확대 */
          var a = touches[ids[0]], b = touches[ids[1]];
          pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, k: state.view.k };
          drag.on = false; drag.moved = true;
          map.classList.add('zoomed');
        }
      }
    });
    window.addEventListener('pointermove', function (ev) {
      if (ev.pointerType === 'touch' && touches[ev.pointerId]) {
        touches[ev.pointerId] = [ev.clientX, ev.clientY];
        var ids = Object.keys(touches);
        if (pinch && ids.length === 2) {
          var a = touches[ids[0]], b = touches[ids[1]];
          var want = clamp(pinch.k * Math.hypot(a[0] - b[0], a[1] - b[1]) / pinch.d, 0.7, 5);
          zoomBy(want / state.view.k);
          return;
        }
      }
      if (!drag.on) return;
      var dx = ev.clientX - drag.sx, dy = ev.clientY - drag.sy;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 6) return;
      if (ev.pointerType === 'touch' && state.view.k <= 1.01) return;
      drag.moved = true; viewTouched = true;
      map.classList.add('dragging');
      var sc = svgScale();
      state.view.x = drag.ox + dx * sc; state.view.y = drag.oy + dy * sc;
      applyView();
    });
    function end(ev) {
      if (ev && touches[ev.pointerId]) { delete touches[ev.pointerId]; if (Object.keys(touches).length < 2) pinch = null; }
      drag.on = false; map.classList.remove('dragging'); setTimeout(function () { drag.moved = false; }, 0);
    }
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    map.addEventListener('click', function () { if (!drag.moved) closePopup(); });
    window.addEventListener('resize', function () { if (!viewTouched) state.view = defaultView(); applyView(); });
    state.view = defaultView();
    fitUi();
  }

  /* ---------- 진행 중 띠(사이드 패널): 방금 재생한 실제 사건, 없으면 가장 최근 사건 ---------- */
  var hot = null;
  function setTicker(e) {
    hot = { title: e.title, until: Date.now() + 9000 };
    renderStrip();
    setTimeout(renderStrip, 9200);
  }
  function renderStrip() {
    var el = $('strip');
    if (!el) return;
    var e = state.events[0], on = hot && Date.now() < hot.until;
    el.className = 'strip' + (on ? ' hot' : '');
    el.textContent = '';
    el.appendChild(h('i'));
    el.appendChild(h('span', null, on ? '지금 · ' + hot.title : (e ? '최근 · ' + e.title + ' (' + agoEv(e) + ')' : '오늘 감지된 지시·호출이 아직 없습니다')));
  }

  /* ---------- popup ---------- */
  function logItem(timeText, title, detail) {
    var li = h('li');
    li.appendChild(h('time', null, timeText));
    var b = h('div');
    b.appendChild(h('div', 'lt', title || '활동'));
    if (detail) b.appendChild(h('div', 'ld', detail));
    li.appendChild(b);
    return li;
  }
  function evItem(e) { return logItem((e.coarse ? '~' : '') + fmtHM(e.t), e.title, agoEv(e) + (e.coarse ? ' · 파일 기록 시각 기준' : ' · 감지 시각')); }
  function badge(status) {
    var st = STATUS[status], b = h('span', 'badge', st.label);
    b.style.color = st.color;
    return b;
  }
  function lastText(d) { return d ? fmtMDHM(d) + ' (' + ago(d) + ')' : '기록 없음'; }
  function whereOf(a) {
    if (a.status === 'resting') return '라운지 · 탕비실';
    var area = HOME[a.id].area;
    return area === 'R' ? '안내 데스크(비서실)' : (area === 'CL' ? '총괄 자리' : '사무실 책상');
  }
  function openPopup(kind, id) {
    var a = null, rows;
    (kind === 'cast' ? state.cast : state.stations).forEach(function (x) { if (x.id === id) a = x; });
    if (!a) { closePopup(); return; }
    state.popup = { kind: kind, id: id };
    var st = STATUS[a.status];
    if (kind === 'cast') fillAvatar($('popAvatar'), a);
    else { $('popAvatar').textContent = a.name.slice(0, 1); $('popAvatar').style.background = st.color; $('popAvatar').style.boxShadow = 'none'; }
    $('popName').textContent = a.name;
    $('popRole').textContent = (kind === 'cast' ? (CAST_BY[a.id].rank ? CAST_BY[a.id].rank + ' · ' : 'AI 직원 · ') : '업무 · ') + (a.role || '역할 미지정');
    var pb = $('popBadge'); pb.textContent = st.label; pb.style.color = st.color;
    var ul = $('popLogs'); ul.textContent = '';
    if (kind === 'cast') {
      rows = [['자리', whereOf(a)], ['현재 작업', a.task || '없음'], ['한마디', a.bubble || '–'], ['마지막 활동', lastText(a.last)]];
      if (a.id === 'vooy' && /연결 안 됨/.test(a.task)) rows.push(['안내', '활동 신호가 아직 연결되지 않았습니다. 신호를 알게 되면 그때부터 움직입니다']);
      a.sub.slice(0, 4).forEach(function (x) { rows.push([x.name, STATUS[x.status].label + (x.task ? ' · ' + x.task : '')]); });
      var evs = state.events.filter(function (e) { return e.from === a.id || e.to === a.id || e.members.indexOf(a.id) >= 0; }).slice(0, 8);
      $('popSub').textContent = '이 AI 가 관련된 실제 지시·호출';
      if (!evs.length) ul.appendChild(h('li', 'empty', '오늘 감지된 지시·호출이 없습니다'));
      evs.forEach(function (e) { ul.appendChild(evItem(e)); });
    } else {
      rows = [['구분', GROUPS[a.room] + ' 업무'], ['현재 작업', a.task || '없음'], ['마지막 활동', lastText(a.last)]];
      var ls = state.logs.filter(function (l) { return l.src === a.src && l.agent === a.id; }).slice(0, 8);
      $('popSub').textContent = '작업 로그';
      if (!ls.length) ul.appendChild(h('li', 'empty', '오늘 기록된 작업이 없습니다'));
      ls.forEach(function (l) { ul.appendChild(logItem(l.timeText, l.title, l.detail)); });
    }
    var meta = $('popMeta'); meta.textContent = '';
    rows.forEach(function (r) { meta.appendChild(h('dt', null, r[0])); meta.appendChild(h('dd', null, r[1])); });
    $('popup').hidden = false;
  }
  function closePopup() { state.popup = null; $('popup').hidden = true; }

  /* ---------- sidebar ---------- */
  function fillAvatar(el, a) {
    var def = CAST_BY[a.id];
    el.textContent = '';
    if (def && def.icon) {
      var im = document.createElement('img');
      im.src = ICON_DIR + def.icon + '.png'; im.alt = ''; im.loading = 'lazy';
      el.appendChild(im);
      el.style.background = '#ffffff';
      el.style.boxShadow = 'inset 0 0 0 2px ' + a.color;
    } else {
      el.textContent = def && def.mark ? def.mark : a.name.slice(0, 1);
      el.style.background = (def && def.plate) || a.color || STATUS[a.status].color;
      el.style.fontFamily = def && def.serif ? 'Georgia, "Times New Roman", serif' : '';
      el.style.boxShadow = def && def.plate ? 'inset 0 0 0 2px ' + a.color : 'none';
    }
  }
  function dot(color) { var d = h('span', 'dot'); d.style.background = color; return d; }
  function castCard(a) {
    var b = h('button', 'agent s-' + a.status); b.type = 'button';
    var av = h('span', 'avatar sm'); fillAvatar(av, a); b.appendChild(av);
    var who = h('span', 'who');
    var nm = h('span', 'nm', a.name); nm.appendChild(h('span', 'role', a.role)); who.appendChild(nm);
    who.appendChild(h('span', 'sub', a.task || STATUS[a.status].label));
    who.appendChild(h('span', 'when', a.last ? '마지막 활동 ' + ago(a.last) : '활동 기록 없음'));
    b.appendChild(who); b.appendChild(badge(a.status));
    b.addEventListener('click', function () { openPopup('cast', a.id); });
    return b;
  }
  function chipOf(a, kind) {
    var c = h('button', 'chip'); c.type = 'button';
    if (kind === 'cast') { var av = h('span', 'avatar xs'); fillAvatar(av, a); c.appendChild(av); }
    c.appendChild(dot(STATUS[a.status].color)); c.appendChild(document.createTextNode(a.name));
    if (kind === 'cast' && a.last) c.appendChild(h('span', 'chip-when', ago(a.last)));
    c.addEventListener('click', function () { openPopup(kind, a.id); });
    return c;
  }
  function stationRow(a) {
    var b = h('button', 'row'); b.type = 'button';
    b.appendChild(dot(STATUS[a.status].color));
    var who = h('span', 'who');
    who.appendChild(h('span', 'nm', a.name));
    who.appendChild(h('span', 'sub', (a.task || a.role || '') + (a.last ? ' · ' + ago(a.last) : '')));
    b.appendChild(who); b.appendChild(badge(a.status));
    b.addEventListener('click', function () { openPopup('station', a.id); });
    return b;
  }
  function section(body, title, note) {
    var hd = h('div', 'sec-h', title);
    if (note) hd.appendChild(h('span', 'cnt', note));
    body.appendChild(hd);
  }
  function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  function nameOfAgent(l) {
    var nm = '';
    state.stations.forEach(function (a) { if (a.src === l.src && a.id === l.agent) nm = a.name; });
    state.cast.forEach(function (a) { if (a.id === l.agent) nm = a.name; });
    return nm;
  }
  function countRow(label, n, cls) {
    var r = h('div', 'count-row');
    r.appendChild(h('span', null, label));
    r.appendChild(h('b', cls, n + '건'));
    return r;
  }
  function renderTab() {
    var body = $('tabBody'), keep = body.scrollTop; body.textContent = '';
    var C = state.cast, S = state.stations, now = new Date();
    var busy = C.filter(function (a) { return a.status === 'working'; });
    if (state.tab === 'tower') {
      body.appendChild(h('div', 'lead', busy.length ? '지금 ' + busy.length + '명이 일하고 있어요' : '지금은 진행 중인 지시가 없어요'));
      body.appendChild(countRow('오늘 처리', state.summary.done, 'teal'));
      body.appendChild(countRow('오늘 지시 · 호출', state.events.filter(function (e) { return sameDay(e.t, now); }).length, 'amber'));
      body.appendChild(countRow('진행 중 업무', S.filter(function (a) { return a.status === 'working'; }).length, 'teal'));
      body.appendChild(countRow('대기 업무', S.filter(function (a) { return a.status === 'idle'; }).length, 'amber'));
      var strip = h('div', 'strip'); strip.id = 'strip';
      body.appendChild(strip);
      renderStrip();
      body.appendChild(h('div', 'sec-h', '최근 완료'));
      var done = [];
      state.logs.forEach(function (l) {
        if (!/완료|완성|저장|마침|마쳤|발행|끝/.test(l.title + ' ' + l.detail) || /시작/.test(l.title)) return;   /* 끝난 일만 */
        var nm = nameOfAgent(l);
        done.push({ t: l.t ? l.t.getTime() : 0, title: l.title || '활동', sub: [l.timeText, l.detail, nm].filter(Boolean).join(' · ') });
      });
      state.events.forEach(function (e) {
        if (e.kind === 'report') done.push({ t: e.t.getTime(), title: phraseOf(e), sub: (e.coarse ? '~' : '') + fmtHM(e.t) + (CAST_BY[e.from] ? ' · ' + CAST_BY[e.from].name : '') });
      });
      done.sort(function (a, b) { return b.t - a.t; });
      if (!done.length) body.appendChild(h('div', 'empty sm', '오늘 완료 기록이 아직 없습니다'));
      done.slice(0, 6).forEach(function (d) {
        var it = h('div', 'done');
        it.appendChild(h('span', 'check', '✓'));
        var tx = h('div', 'done-tx');
        tx.appendChild(h('div', 'done-t', d.title));
        tx.appendChild(h('div', 'done-s', d.sub));
        it.appendChild(tx);
        body.appendChild(it);
      });
    } else if (state.tab === 'tasks') {
      section(body, '지금 일하는 AI', busy.length + '명');
      if (!busy.length) body.appendChild(h('div', 'empty sm', '진행 중인 지시가 없어 모두 자리에서 대기 중입니다'));
      busy.forEach(function (a) { body.appendChild(castCard(a)); });
      section(body, '최근 지시 · 호출', '실제 감지한 것만');
      var ul = h('ul', 'loglist'), evs = state.events.slice(0, 12);
      if (!evs.length) body.appendChild(h('div', 'empty sm', '오늘 감지된 지시·호출이 없습니다'));
      evs.forEach(function (e) { ul.appendChild(evItem(e)); });
      if (evs.length) body.appendChild(ul);
      GROUP_ORDER.forEach(function (key) {
        var st = S.filter(function (a) { return a.room === key; });
        if (!st.length) return;
        section(body, GROUPS[key] + ' 업무', st.filter(function (a) { return a.status === 'working'; }).length + '건 진행');
        var card = h('div', 'card');
        st.forEach(function (a) { card.appendChild(stationRow(a)); });
        body.appendChild(card);
      });
    } else if (state.tab === 'agents') {
      [['working', '근무'], ['resting', '휴식'], ['idle', '대기'], ['offline', '퇴근']].forEach(function (g) {
        var list = C.filter(function (a) { return a.status === g[0]; });
        if (!list.length) return;
        section(body, g[1], list.length + '명');
        list.forEach(function (a) { body.appendChild(castCard(a)); });
      });
    } else {
      var ul2 = h('ul', 'loglist'), ls = state.logs.slice(0, 60);
      if (!ls.length) body.appendChild(h('div', 'empty', '오늘 활동 로그가 없습니다'));
      ls.forEach(function (l) {
        var li = logItem(l.timeText, l.title, l.detail), nm = nameOfAgent(l);
        if (nm) li.lastChild.insertBefore(h('div', 'ld', nm), li.lastChild.firstChild);
        ul2.appendChild(li);
      });
      if (ls.length) body.appendChild(ul2);
    }
    body.scrollTop = keep;
  }

  /* 오프라인: 기기가 끊겼거나, 실시간 채널이 안 되고 상태 파일도 저장본으로만 열렸을 때 */
  function isOffline() { return navigator.onLine === false || (state.mode !== 'live' && state.mode !== 'demo' && !!(state.pc.cached || state.pickle.cached)); }
  function renderFoot() {
    var foot = $('footStatus'); foot.textContent = '';
    var modeText = { live: '실시간 채널', file: '백업 파일', demo: '데모', none: '연결 안 됨' }[state.mode];
    [['데이터', state.pc, modeText], ['노션 비서', state.pickle, '마지막 변경']].forEach(function (x) {
      var i = x[1], row = h('div'), cls, txt;
      if (!i.ok) { cls = 'bad'; txt = '불러오지 못함'; }
      else if (!i.updated) { cls = 'late'; txt = '시각 정보 없음'; }
      else if (i.stale) { cls = 'late'; txt = x[2] + ' · 갱신 ' + fmtMDHM(i.updated) + ' · 지연(' + ago(i.updated) + ')'; }
      else { cls = 'ok'; txt = x[2] + ' · 갱신 ' + fmtMDHM(i.updated) + ' (' + ago(i.updated) + ')'; }
      row.appendChild(document.createTextNode(x[0] + ' '));
      row.appendChild(h('span', cls, txt));
      foot.appendChild(row);
    });
    var live = state.mode === 'live' && state.pc.ok && !state.pc.stale;
    $('liveDot').classList.toggle('warn', !live && state.mode !== 'demo');
    var off = isOffline();
    $('liveText').textContent = state.mode === 'demo' ? 'DEMO' : (off ? '오프라인' : (live ? 'LIVE' : (state.mode === 'file' ? '백업' : '끊김')));
    if (off && state.mode !== 'demo') $('liveDot').classList.add('warn');
  }
  function renderSide() {
    var C = state.cast;
    $('sideSub').textContent = '대표님 1인 기업 · AI 직원 ' + C.length + '명';
    $('kDone').textContent = state.summary.done;
    $('kWork').textContent = C.filter(function (a) { return a.status === 'working'; }).length;
    $('kIdle').textContent = C.filter(function (a) { return a.status === 'idle' || a.status === 'resting'; }).length;
    $('kAll').textContent = C.length;
    renderFoot();
    var msg = $('mapMsg');
    if (state.demo) { msg.hidden = false; msg.textContent = '데모 화면입니다(실제 상태 아님)'; }
    else if (isOffline()) { msg.hidden = false; msg.textContent = '오프라인입니다 · 마지막으로 받은 상태를 보여 주고, 연결되면 자동으로 이어집니다'; }
    else if (!state.pc.ok && !state.pickle.ok) { msg.hidden = false; msg.textContent = '상태를 불러오지 못했습니다. AI 들은 대기 모습으로 두고, 잠시 뒤 다시 시도합니다.'; }
    else msg.hidden = true;
    renderTab();
  }

  function renderAll() {
    renderMap();
    renderSide();
    if (state.popup) openPopup(state.popup.kind, state.popup.id);
  }

  function initSide() {
    Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (b) {
      b.addEventListener('click', function () {
        state.tab = b.getAttribute('data-tab');
        Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (x) { x.classList.toggle('on', x === b); });
        $('tabBody').scrollTop = 0;
        renderTab();
      });
    });
    $('popClose').addEventListener('click', closePopup);
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closePopup(); });
    function tick() { var d = new Date(); $('clock').textContent = fmtMDHM(d) + ':' + p2(d.getSeconds()); }
    tick(); setInterval(tick, 1000);
    /* '몇 분 전' 을 계속 새로 */
    setInterval(function () { if (state.cast.length) { normalize(); if (V3) V3.sync(state.cast); else ensureChars(); renderSide(); } }, 20000);
  }

  function initApp() {
    var standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true || qs.get('standalone') === '1';
    document.documentElement.classList.toggle('standalone', standalone);
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js').catch(function () {});
      navigator.serviceWorker.ready.then(function () { document.documentElement.setAttribute('data-sw', '1'); }, function () {});
    }
    var btn = $('installBtn'), deferred = null;
    window.addEventListener('beforeinstallprompt', function (ev) {      /* 설치할 수 있을 때만 버튼을 보인다 */
      ev.preventDefault(); deferred = ev; btn.hidden = false;
    });
    btn.addEventListener('click', function () {
      if (!deferred) return;
      deferred.prompt();
      var done = function () { deferred = null; btn.hidden = true; };
      if (deferred.userChoice && deferred.userChoice.then) deferred.userChoice.then(done, done); else done();
    });
    window.addEventListener('appinstalled', function () { deferred = null; btn.hidden = true; });
    /* iOS 사파리는 설치 버튼이 없다: 한 번만 안내 */
    var ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var hint = $('iosHint'), seen = false;
    try { seen = localStorage.getItem('aio-ios-hint') === '1'; } catch (e) {}
    if (ios && !standalone && !seen) hint.hidden = false;
    $('iosHintClose').addEventListener('click', function () {
      hint.hidden = true;
      try { localStorage.setItem('aio-ios-hint', '1'); } catch (e) {}
    });
    window.addEventListener('online', function () { poll(); });
    window.addEventListener('offline', function () { renderSide(); });
  }

  /* 미리보기용: ?demo=1(가짜 상태·사건) · ?tab=agents · ?open=claude · ?ff=12(12초 뒤 모습으로 건너뛰기) · ?2d=1(2D 대체 화면) · ?3d=1(느린 그래픽 장치에서도 3D) */
  var qs = new URLSearchParams(location.search);
  state.demo = qs.get('demo') === '1';

  function start() {
    initSide();
    initMapControls();
    initApp();
    normalize();          /* 데이터가 오기 전에도 모두 자리에서 대기하는 모습으로 보인다 */
    renderAll();
    if (/^(tower|agents|tasks|logs)$/.test(qs.get('tab') || '')) {
      var tb = document.querySelector('.tabs button[data-tab="' + qs.get('tab') + '"]');
      if (tb) tb.click();
    }
    poll().then(function () {
      var ff = Math.min(600, Number(qs.get('ff')) || 0);
      if (V3) { if (ff) V3.fastForward(ff); if (Number(qs.get('zoom')) > 0) V3.zoom(Number(qs.get('zoom'))); }
      else { for (var t = 0; t < ff; t += 0.05) step(0.05); draw(); }
      if (qs.get('open')) openPopup('cast', qs.get('open'));
      document.documentElement.setAttribute('data-ready', '1');
    });
    if (!V3) requestAnimationFrame(frame);
    setInterval(function () { if (!document.hidden) poll(); }, state.demo ? FILE_MS : LIVE_MS);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) { lastTs = 0; poll(); } });
  }

  /* 3D 를 쓸 수 있는지: WebGL(소프트웨어 렌더러 제외) + import map. 안 되면 2D 그림 버전으로 연다. */
  function canWebgl() {
    try {
      var c = document.createElement('canvas'), o = { failIfMajorPerformanceCaveat: qs.get('3d') !== '1' };
      var gl = window.WebGLRenderingContext && (c.getContext('webgl2', o) || c.getContext('webgl', o));
      if (!gl) return false;
      var ext = gl.getExtension('WEBGL_debug_renderer_info'), name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
      var lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext();
      return qs.get('3d') === '1' || !/swiftshader|llvmpipe|software|basic render/i.test(name);
    } catch (e) { return false; }
  }
  var started = false;
  function boot(use3d) {
    if (started) return;
    started = true;
    if (use3d && window.Office3D) {
      try {
        var colors = {};
        STATUS_ORDER.forEach(function (k) { colors[k] = STATUS[k].color; });
        V3 = window.Office3D.create({ pane: $('mapPane'), cast: CAST, ceo: CEO_DEF, statusColors: colors, iconDir: ICON_DIR, demo: state.demo,
          onOpen: function (id) { openPopup('cast', id); }, onClose: closePopup, onTicker: setTicker });
        window.__aio3d = V3;
      } catch (e) {
        V3 = null;
        window.__aio3dError = String(e && e.stack || e);
        Array.prototype.forEach.call(document.querySelectorAll('.stage3d,.labels3d'), function (n) { n.parentNode.removeChild(n); });
      }
    }
    document.documentElement.classList.add(V3 ? 'mode-3d' : 'mode-2d');
    start();
  }
  var want3d = qs.get('2d') !== '1' && !!(window.HTMLScriptElement && HTMLScriptElement.supports && HTMLScriptElement.supports('importmap')) && canWebgl();
  if (!want3d) boot(false);
  else if (window.Office3D) boot(true);
  else {
    window.addEventListener('office3d-ready', function () { boot(true); });
    window.addEventListener('office3d-fail', function () { boot(false); });
    setTimeout(function () { boot(false); }, 9000);
  }
})();
