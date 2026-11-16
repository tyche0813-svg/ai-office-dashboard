/* AI 오피스 실시간 관제탑 — 외부 라이브러리 없음. 데이터는 모두 textContent 로만 넣는다.
   원칙: 꾸며낸 연출 없음. 캐릭터가 걷거나 모이거나 말하는 것은 전부 감시 스크립트가 '실제로 감지한 사건'과 '현재 상태'에서만 나온다.
   - 상태 working  → 자기 책상에서 작업(타이핑 + 작업 말풍선)
   - 상태 resting  → 방금 일을 마침: 휴게실에서 쉼
   - 상태 idle     → 자기 책상에서 조용히 대기      - 상태 offline → 책상에서 꺼진 모습
   - 사건 dispatch/report → 보낸 쪽이 받는 쪽 자리로 걸어가 말하고 돌아옴   - 사건 meeting → 회의실에 모였다 흩어짐 */
(function () {
  'use strict';

  var LIVE_URL = 'https://ai-office-live.btc-indicator-mobile.workers.dev/status';
  var FILE_URL = 'data/pc-status.json', PICKLE_URL = 'data/pickle-status.json';
  var LIVE_MS = 5000, FILE_MS = 45000;
  var LIVE_FRESH_MS = 5 * 60 * 1000;    /* 실시간 채널 값이 이보다 오래되면 백업 파일도 본다 */
  var STALE_MS = 10 * 60 * 1000;        /* 이보다 오래되면 '갱신 지연' */
  var DEAD_MS = 30 * 60 * 1000;         /* 이보다 오래되면 '작업 중' 표시를 믿지 않는다 */
  var EVENT_PLAY_MS = 3 * 60 * 1000;    /* 이 안에 일어난 사건만 화면에서 재생(더 옛것은 기록에만) */

  var STATUS = {
    working: { label: '작업 중', color: '#34d399' },
    resting: { label: '휴식', color: '#fbbf24' },
    idle: { label: '대기', color: '#94a3b8' },
    offline: { label: '오프라인', color: '#475569' }
  };
  var STATUS_ORDER = ['working', 'resting', 'idle', 'offline'];

  /* 주인공: 클로드와 그 지휘를 받는 AI 들. tag = 지도 위 짧은 이름표 */
  var CAST = [
    { id: 'claude', name: '클로드', tag: '클로드', role: '지휘 · 관제', color: '#e8935f', hat: 'star', chest: 'tie' },
    { id: 'opus', name: 'Opus 보조', tag: 'Opus', role: '블로그 슬롯 담당', color: '#f3b98f', hat: 'star' },
    { id: 'muse', name: '뮤즈', tag: '뮤즈', role: '초안 · 사진', color: '#c4a1ff', hat: 'beret' },
    { id: 'aside', name: '어사이드', tag: '어사이드', role: '브라우저 · 에디터 조작', color: '#6cb8ff', hat: 'band', chest: 'cursor' },
    { id: 'exaone', name: '엑사원', tag: '엑사원', role: '문체 검사', color: '#f58fc0', hat: 'one', chest: '가' },
    { id: 'fable', name: 'Fable', tag: 'Fable', role: '앱 개발 담당', color: '#5eead4', hat: 'one', chest: '</>' },
    { id: 'speech', name: 'Azure Speech', tag: 'Speech', role: '음성 합성', color: '#38bdf8', hat: 'phones', chest: '♪' },
    { id: 'chatgpt', name: 'ChatGPT', tag: 'GPT', role: '검수 · 가끔', color: '#4ade80', hat: 'one', chest: '✓' },
    { id: 'codex', name: 'Codex', tag: 'Codex', role: '대행 · 현재 사용 불가', color: '#a8b3c4', hat: 'none', chest: '>_' },
    { id: 'claudeapi', name: 'Claude API', tag: 'API', role: '캐러셀 문구', color: '#fb923c', hat: 'one', chest: '{}' },
    { id: 'copilot', name: 'Copilot', tag: 'Copilot', role: '이미지 · 가끔', color: '#bef264', hat: 'band', chest: '◆' },
    { id: 'pickle', name: '피클', tag: '피클', role: '클라우드 비서', color: '#7ccf6b', hat: 'two', src: 'pickle' },
    { id: 'stability', name: 'Stability', tag: 'Stability', role: '이미지 · 중단', color: '#a78bfa', hat: 'none', chest: '▣' },
    { id: 'routine', name: '클라우드 루틴', tag: '루틴', role: '새벽 키워드 수집', color: '#93c5fd', hat: 'cloud', chest: '☾' },
    { id: 'vooy', name: 'vooy', tag: 'vooy', role: '역할 확인 중', color: '#9aa4b5', hat: 'one', chest: '?', dashed: true }
  ];
  var CAST_BY = {};
  CAST.forEach(function (c) { CAST_BY[c.id] = c; });

  /* 방: rect = [gx0, gy0, gx1, gy1] (격자 16 x 12). 복도는 y 4.8~6.0.
     gate = 책상 줄 사이 통로(문 쪽 구역 0 → 안쪽 구역 1), zone(y) = 그 방 안에서의 구역 */
  var CORR_Y = 5.4, DESK_D = 0.7;
  function bottomZone(y) { return y > 8.3 ? 1 : 0; }
  var ROOMS = {
    ceo: { label: '대표님', rect: [0, 0, 3.5, 4.8], door: [2.4, 4.8], tint: '#2a2440' },
    meeting: { label: '관제탑 · 회의실', rect: [3.5, 0, 8.5, 4.8], door: [6.0, 4.8], tint: '#1c2b45' },
    lounge: { label: '휴게실', rect: [8.5, 0, 12.5, 4.8], door: [10.5, 4.8], tint: '#33283a' },
    server: { label: '서버실 · 클라우드', rect: [12.5, 0, 16, 4.8], door: [14.25, 4.8], tint: '#17303a',
      gate: [[14.25, 3.5], [14.25, 1.95]], zone: function (y) { return y < 3.15 ? 1 : 0; } },
    blog: { label: '블로그 데스크', rect: [0, 6, 6, 12], door: [2.95, 6], tint: '#18263a', gate: [[2.95, 7.0], [2.95, 9.3]], zone: bottomZone, screen: '#5eead4' },
    video: { label: '영상 · 개발실', rect: [6, 6, 11, 12], door: [8.55, 6], tint: '#221f3d', gate: [[8.55, 7.0], [8.55, 9.3]], zone: bottomZone, screen: '#f9a8d4' },
    carousel: { label: '캐러셀 · 이미지', rect: [11, 6, 16, 12], door: [13.5, 6], tint: '#1b3035', gate: [[13.5, 7.0], [13.5, 9.3]], zone: bottomZone, screen: '#fde047' }
  };
  var ROOM_ORDER = ['meeting', 'blog', 'video', 'carousel', 'server', 'lounge'];
  var CLAUDE_HOME = [4.45, 2.75];
  /* 책상 주인 */
  var DESKS = [];
  function deskRow(room, ids, xs) {
    ids.forEach(function (id, i) {
      DESKS.push({ id: id, room: room, x: xs[i % 2], y: i < 2 ? 7.5 : 10.2, w: 1.5, zone: i < 2 ? 0 : 1 });
    });
  }
  deskRow('blog', ['opus', 'muse', 'aside', 'exaone'], [0.6, 3.8]);
  deskRow('video', ['fable', 'speech', 'chatgpt', 'codex'], [6.3, 9.3]);
  deskRow('carousel', ['claudeapi', 'copilot', 'pickle', 'stability'], [11.3, 14.2]);
  DESKS.push({ id: 'routine', room: 'server', x: 12.75, y: 2.3, w: 1.1, zone: 1 });
  DESKS.push({ id: 'vooy', room: 'server', x: 14.65, y: 2.3, w: 1.1, zone: 1 });
  var HOME = { claude: { room: 'meeting', p: CLAUDE_HOME, zone: 0 } };
  DESKS.forEach(function (d) { HOME[d.id] = { room: d.room, p: [d.x + d.w / 2, d.y - 0.35], zone: d.zone, desk: d }; });
  var REST = {}, SEAT = {};
  CAST.forEach(function (c, i) {
    REST[c.id] = { room: 'lounge', p: [9.15 + (i % 4) * 0.9, 2.0 + Math.floor(i / 4) * 0.72], zone: 0 };
  });
  [[5.6, 3.7], [6.6, 3.7], [7.6, 3.7], [8.05, 2.9], [6.1, 4.4], [7.1, 4.4], [5.1, 4.4]].forEach(function (p, i) { SEAT[i] = p; });

  var SVGNS = 'http://www.w3.org/2000/svg';
  var TW = 30, TH = 15;

  var state = { cast: [], stations: [], logs: [], events: [], pc: { ok: false }, pickle: { ok: false }, mode: 'none',
    summary: { done: 0 }, tab: 'tower', view: { k: 1, x: 0, y: 0 }, popup: null, demo: false, ui: 1, placed: false, now: null };
  var chars = {};
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
  function iso(gx, gy, z) { return [(gx - gy) * TW, (gx + gy) * TH - (z || 0)]; }
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
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(function (t) {
        var j = JSON.parse(t);
        if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('형식 오류');
        return { ok: true, data: j, text: t, updated: parseTime(j.updated_at) };
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
      logs: [] } },
    pickle: { ok: true, updated: now, data: { updated_at: now.toISOString(), cast: [c('pickle', 'working', '이미지 준비 중', '이미지 요청 처리 중', 30)], agents: [], logs: [] } } };
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
      r.stale = age > STALE_MS;
      var dead = age > DEAD_MS;
      var sum = d.summary && typeof d.summary === 'object' ? d.summary : {};
      var n = Number(sum.done_today);
      if (isFinite(n) && n > 0) done += Math.floor(n);
      var agents = (Array.isArray(d.agents) ? d.agents : []).filter(function (a) { return a && typeof a === 'object'; });
      var legacy = !Array.isArray(d.cast);
      var castArr = legacy ? (key === 'pc' ? legacyCast(agents) : []) : d.cast;
      castArr.forEach(function (c) {
        if (!c || typeof c !== 'object' || !cast[c.id]) return;
        if ((key === 'pickle') !== (c.id === 'pickle')) return;   /* 피클 파일은 피클만, PC 쪽은 나머지만 */
        var m = cast[c.id];
        var st = c.status === 'meeting' ? 'working' : (STATUS[c.status] ? c.status : 'idle');
        m.status = st; m.bubble = str(c.bubble, 18); m.task = str(c.task, 80) || STATUS[st].label;
        m.last = parseTime(c.last_active); m.known = true;
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
      if (age <= limit && age > -120000) evQueue.push({ e: e, at: simT });
    });
    firstIntake = false;
  }

  var lastSig = '';
  function apply() {
    var sig = (state.pc.ok ? state.pc.text || JSON.stringify(state.pc.data) : 'x') + '|' + (state.pickle.ok ? state.pickle.text || JSON.stringify(state.pickle.data) : 'x') + '|' + state.mode;
    if (sig === lastSig) { renderFoot(); return; }
    lastSig = sig;
    normalize();
    renderAll();
    if (state.pc.ok || state.pickle.ok) {
      if (!state.placed) { placeAll(); state.placed = true; }
      intakeEvents();
    }
  }

  var lastFile = 0, lastPickle = 0;
  function poll() {
    if (state.demo) { var d = demoData(); state.pc = d.pc; state.pickle = d.pickle; state.mode = 'demo'; apply(); return Promise.resolve(); }
    var jobs = [fetchJson(LIVE_URL)], now = Date.now();
    var wantPickle = now - lastPickle >= FILE_MS - 500;
    if (wantPickle) { lastPickle = now; jobs.push(fetchJson(PICKLE_URL)); }
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

  /* ---------- 배경(가구) ---------- */
  function box(items, x, y, w, d, z0, z1, color, extra, onClick, title) {
    var g = s('g', {});
    s('polygon', { points: pts([iso(x, y + d, z1), iso(x + w, y + d, z1), iso(x + w, y + d, z0), iso(x, y + d, z0)]), fill: shade(color, 0.72) }, g);
    s('polygon', { points: pts([iso(x + w, y, z1), iso(x + w, y + d, z1), iso(x + w, y + d, z0), iso(x + w, y, z0)]), fill: shade(color, 0.5) }, g);
    s('polygon', { points: pts([iso(x, y, z1), iso(x + w, y, z1), iso(x + w, y + d, z1), iso(x, y + d, z1)]), fill: color }, g);
    if (extra) extra(g);
    if (onClick) {
      g.style.cursor = 'pointer';
      g.addEventListener('click', function (ev) { ev.stopPropagation(); if (!drag.moved) onClick(); });
      if (title) { var t = s('title', {}, g); t.textContent = title; }
    }
    items.push({ depth: x + w / 2 + y + d / 2, el: g });
    return g;
  }
  function plant(items, x, y) {
    box(items, x, y, 0.5, 0.5, 0, 9, '#6b5a4a', function (g) {
      var c = iso(x + 0.25, y + 0.25, 9);
      s('circle', { cx: c[0], cy: c[1] - 8, r: 9, fill: '#2f8f5b' }, g);
      s('circle', { cx: c[0] - 6, cy: c[1] - 3, r: 6, fill: '#3fae70' }, g);
      s('circle', { cx: c[0] + 6, cy: c[1] - 4, r: 6, fill: '#27784b' }, g);
    });
  }
  function glass(items, x0, y0, x1, y1) {
    var g = s('g', {});
    s('polygon', { points: pts([iso(x0, y0, 0), iso(x1, y1, 0), iso(x1, y1, 20), iso(x0, y0, 20)]),
      fill: 'rgba(148,197,255,.08)', stroke: 'rgba(148,197,255,.28)', 'stroke-width': 0.8 }, g);
    g.style.pointerEvents = 'none';
    items.push({ depth: (x0 + x1) / 2 + (y0 + y1) / 2 - 0.05, el: g });
  }
  function hGlass(items, y, x0, x1, doors) {
    for (var x = x0; x < x1 - 0.01; x += 0.5) {
      var mid = x + 0.25, open = false;
      doors.forEach(function (d) { if (Math.abs(mid - d) < 0.62) open = true; });
      if (!open) glass(items, x, y, Math.min(x + 0.5, x1), y);
    }
  }
  function sign(g, p, label, strong) {
    var w = textW(label, 11) + 18;
    s('rect', { x: p[0] - w / 2, y: p[1] - 10, width: w, height: 20, rx: 10, fill: strong ? '#f5d680' : 'rgba(11,15,23,.82)', stroke: strong ? '#f5d680' : '#3a4763', 'stroke-width': 1 }, g);
    var t = s('text', { x: p[0], y: p[1] + 4, 'text-anchor': 'middle', 'font-size': 11, 'font-weight': 700, fill: strong ? '#231a05' : '#cfd8ea' }, g);
    t.textContent = label;
  }
  function floorTag(g, p, st) {
    var label = st.name, color = STATUS[st.status].color, w = textW(label, 8) + 16;
    var tg = s('g', {}, g);
    s('rect', { x: p[0] - w / 2, y: p[1] - 6.5, width: w, height: 13, rx: 6.5, fill: 'rgba(11,15,23,.72)', stroke: color, 'stroke-width': 0.8 }, tg);
    s('circle', { cx: p[0] - w / 2 + 6.5, cy: p[1], r: 2.2, fill: color, 'class': st.status === 'working' ? 'lamp-on' : '' }, tg);
    var t = s('text', { x: p[0] + 4, y: p[1] + 2.9, 'text-anchor': 'middle', 'font-size': 8, 'font-weight': 600, fill: '#cfd8ea' }, tg);
    t.textContent = label;
    tg.style.cursor = 'pointer';
    tg.addEventListener('click', function (ev) { ev.stopPropagation(); if (!drag.moved) openPopup('station', st.id); });
  }
  function castOf(id) { var r = null; state.cast.forEach(function (c) { if (c.id === id) r = c; }); return r; }

  function buildScene() {
    var floor = $('floor'), signs = $('signs'), W = 16, D = 12, WALL = 64, i, k;
    [floor, signs, $('sorted')].forEach(function (g) { while (g.firstChild) g.removeChild(g.firstChild); });
    s('polygon', { points: pts([iso(0, D), iso(W, D), iso(W, D, -12), iso(0, D, -12)]), fill: '#0d1424' }, floor);
    s('polygon', { points: pts([iso(W, 0), iso(W, D), iso(W, D, -12), iso(W, 0, -12)]), fill: '#0a101c' }, floor);
    s('polygon', { points: pts([iso(0, 0), iso(W, 0), iso(W, D), iso(0, D)]), fill: '#141c2e' }, floor);
    Object.keys(ROOMS).forEach(function (key) {
      var r = ROOMS[key].rect;
      s('polygon', { points: pts([iso(r[0], r[1]), iso(r[2], r[1]), iso(r[2], r[3]), iso(r[0], r[3])]), fill: ROOMS[key].tint, stroke: 'rgba(255,255,255,.10)', 'stroke-width': 1 }, floor);
    });
    s('line', { x1: iso(0.4, CORR_Y)[0], y1: iso(0.4, CORR_Y)[1], x2: iso(15.6, CORR_Y)[0], y2: iso(15.6, CORR_Y)[1], stroke: 'rgba(255,255,255,.10)', 'stroke-width': 1, 'stroke-dasharray': '5 7' }, floor);
    var rug = iso(10.5, 3.1);
    s('ellipse', { cx: rug[0], cy: rug[1], rx: 62, ry: 30, fill: 'rgba(163,95,128,.20)', stroke: 'rgba(163,95,128,.4)', 'stroke-width': 1 }, floor);
    /* 뒷벽 */
    s('polygon', { points: pts([iso(0, 0), iso(W, 0), iso(W, 0, WALL), iso(0, 0, WALL)]), fill: '#1b2439' }, floor);
    s('polygon', { points: pts([iso(0, 0), iso(0, D), iso(0, D, WALL), iso(0, 0, WALL)]), fill: '#141b2d' }, floor);
    [[0.5, 1.6], [2.0, 3.1], [9.0, 10.2], [10.8, 12.0]].forEach(function (w) {
      s('polygon', { points: pts([iso(w[0], 0, 18), iso(w[1], 0, 18), iso(w[1], 0, 46), iso(w[0], 0, 46)]), fill: 'rgba(125,211,252,.16)', stroke: 'rgba(125,211,252,.35)', 'stroke-width': 0.8 }, floor);
    });
    /* 관제 스크린: 지금 일하는 AI 수만큼 초록 줄 */
    s('polygon', { points: pts([iso(4.6, 0, 16), iso(7.8, 0, 16), iso(7.8, 0, 46), iso(4.6, 0, 46)]), fill: '#0b1f33', stroke: '#e8935f', 'stroke-width': 1 }, floor);
    var busy = state.cast.filter(function (c) { return c.status === 'working'; }).length;
    for (k = 0; k < 4; k++) {
      var on = k < Math.min(4, busy);
      var a = iso(4.9, 0, 40 - k * 6.5), b = iso(4.9 + (on ? 2.5 - k * 0.3 : 0.9), 0, 40 - k * 6.5);
      s('line', { x1: a[0], y1: a[1], x2: b[0], y2: b[1], stroke: on ? 'rgba(52,211,153,.85)' : 'rgba(148,163,184,.45)', 'stroke-width': 1.8, 'stroke-linecap': 'round' }, floor);
    }
    [[1.0, 2.6], [3.4, 4.4], [6.6, 8.2], [9.2, 11.2]].forEach(function (w) {
      s('polygon', { points: pts([iso(0, w[0], 18), iso(0, w[1], 18), iso(0, w[1], 46), iso(0, w[0], 46)]), fill: 'rgba(125,211,252,.10)', stroke: 'rgba(125,211,252,.25)', 'stroke-width': 0.8 }, floor);
    });

    var items = [];
    hGlass(items, 4.8, 0, 16, ['ceo', 'meeting', 'lounge', 'server'].map(function (r) { return ROOMS[r].door[0]; }));
    hGlass(items, 6.0, 0, 16, ['blog', 'video', 'carousel'].map(function (r) { return ROOMS[r].door[0]; }));
    [3.5, 8.5, 12.5].forEach(function (x) { for (i = 0; i < 4.7; i += 0.8) glass(items, x, i, x, Math.min(i + 0.8, 4.8)); });
    [6, 11].forEach(function (x) { for (i = 6; i < 11.9; i += 1) glass(items, x, i, x, i + 1); });
    /* 대표실 */
    box(items, 0.7, 1.5, 2.0, 0.8, 0, 15, '#7a5a40');
    box(items, 1.4, 0.7, 0.7, 0.6, 0, 22, '#8b6fd6');
    box(items, 0.15, 0.3, 0.45, 1.0, 0, 40, '#4a3b2c');
    plant(items, 2.8, 0.4);
    /* 관제탑: 클로드 콘솔 + 회의 탁자 */
    var claude = castOf('claude');
    box(items, 3.75, 1.45, 0.9, 0.6, 0, 16, '#5a3d2e', function (g) {
      s('polygon', { points: pts([iso(3.85, 1.95, 18), iso(4.55, 1.95, 18), iso(4.55, 1.95, 29), iso(3.85, 1.95, 29)]),
        fill: claude && claude.status === 'working' ? '#e8935f' : 'rgba(148,163,184,.35)', stroke: '#0a0f1a', 'stroke-width': 1,
        'class': claude && claude.status === 'working' ? 'lamp-on' : '' }, g);
    });
    box(items, 5.0, 1.9, 2.6, 1.1, 0, 13, '#4a5f8a');
    /* 휴게실 */
    box(items, 8.9, 0.25, 2.6, 0.3, 0, 22, '#8a4f6c');
    box(items, 8.9, 0.55, 2.6, 0.75, 0, 11, '#a35f80');
    box(items, 11.8, 0.3, 0.5, 0.5, 0, 30, '#3d8f8a');
    plant(items, 8.65, 4.2);
    /* 서버실 랙 = 서버실 담당 일감 */
    var racks = state.stations.filter(function (x) { return x.room === 'server'; }).slice(0, 5);
    for (i = 0; i < 5; i++) (function (i) {
      var st = racks[i], x = 12.8 + i * 0.62, col = st ? STATUS[st.status].color : '#334155';
      box(items, x, 0.3, 0.5, 0.55, 0, 40, '#27364f', function (g) {
        for (var j = 0; j < 4; j++) {
          var p = iso(x + 0.12, 0.85, 33 - j * 8), q = iso(x + 0.4, 0.85, 33 - j * 8);
          s('line', { x1: p[0], y1: p[1], x2: q[0], y2: q[1], stroke: j === 0 ? col : 'rgba(148,163,184,.35)', 'stroke-width': 2, 'stroke-linecap': 'round',
            'class': st && st.status === 'working' && j === 0 ? 'lamp-on' : '' }, g);
        }
      }, st ? function () { openPopup('station', st.id); } : null, st ? st.name : null);
    })(i);
    /* 각자의 책상 */
    DESKS.forEach(function (d) {
      var owner = castOf(d.id), on = owner && owner.status === 'working', off = !owner || owner.status === 'offline';
      var R = ROOMS[d.room];
      box(items, d.x, d.y, d.w, DESK_D, 0, 13, d.room === 'carousel' ? '#4b5a52' : (d.room === 'server' ? '#35506a' : '#3d4b69'), function (g) {
        var m0 = d.x + d.w * 0.27, m1 = d.x + d.w * 0.73, my = d.y + 0.5;
        s('polygon', { points: pts([iso(m0, my, 14), iso(m1, my, 14), iso(m1, my, 27), iso(m0, my, 27)]), fill: '#0f1626', stroke: '#0a0f1a', 'stroke-width': 1 }, g);
        s('polygon', { points: pts([iso(m0 + 0.06, my, 16), iso(m1 - 0.06, my, 16), iso(m1 - 0.06, my, 25.5), iso(m0 + 0.06, my, 25.5)]),
          fill: on ? (R.screen || '#7dd3fc') : (off ? 'rgba(51,65,85,.35)' : 'rgba(148,163,184,.35)'), 'class': on ? 'lamp-on' : '' }, g);
      }, function () { openPopup('cast', d.id); }, owner ? owner.name + ' 자리' : null);
    });
    /* 일감 표지(방 앞쪽 바닥) */
    ['blog', 'video', 'carousel'].forEach(function (key) {
      var R = ROOMS[key].rect;
      state.stations.filter(function (x) { return x.room === key; }).slice(0, 3).forEach(function (st, n) {
        floorTag(floor, iso(R[0] + 0.9 + n * 1.75, 11.45), st);
      });
      plant(items, R[2] - 0.7, 11.35);
    });
    sign(signs, iso(1.75, 0, 56), ROOMS.ceo.label, true);
    sign(signs, iso(6.2, 0, 57), ROOMS.meeting.label);
    sign(signs, iso(10.5, 0, 56), ROOMS.lounge.label);
    sign(signs, iso(14.3, 0, 56), ROOMS.server.label);
    sign(signs, iso(3.15, 12.3, 0), ROOMS.blog.label);
    sign(signs, iso(8.65, 12.3, 0), ROOMS.video.label);
    sign(signs, iso(13.65, 12.3, 0), ROOMS.carousel.label);
    return items;
  }

  /* ---------- 캐릭터 ---------- */
  function buildChar(c) {
    var def = CAST_BY[c.id], col = def.color, dark = shade(col, 0.55), big = c.id === 'claude' ? 1.12 : 1;
    var g = c.el = s('g', { 'class': 'char', tabindex: 0, role: 'button', 'aria-label': def.name });
    s('ellipse', { cx: 0, cy: 0, rx: 12, ry: 5.5, fill: 'rgba(0,0,0,.38)' }, g);
    c.ring = s('ellipse', { cx: 0, cy: 0, rx: 16, ry: 7.5, fill: 'none', 'stroke-width': 1.6 }, g);
    var sc = s('g', { transform: 'scale(' + big + ')' }, g);
    var b = c.body = s('g', {}, sc);
    c.legL = s('rect', { x: -6.5, y: -6, width: 5, height: 6, rx: 2, fill: dark }, b);
    c.legR = s('rect', { x: 1.5, y: -6, width: 5, height: 6, rx: 2, fill: dark }, b);
    c.armL = s('rect', { x: -12.5, y: -22, width: 4.5, height: 11, rx: 2.2, fill: dark }, b);
    c.armR = s('rect', { x: 8, y: -22, width: 4.5, height: 11, rx: 2.2, fill: dark }, b);
    s('rect', { x: -9, y: -25, width: 18, height: 21, rx: 8, fill: shade(col, 0.8) }, b);
    var head = s('rect', { x: -11.5, y: -45, width: 23, height: 21, rx: 9.5, fill: col }, b);
    if (def.dashed) { head.setAttribute('stroke', '#e2e8f0'); head.setAttribute('stroke-width', 1.2); head.setAttribute('stroke-dasharray', '3 2.5'); }
    s('rect', { x: -8.5, y: -40, width: 17, height: 10, rx: 5, fill: '#0d1320' }, b);
    c.eyes = s('g', {}, b);
    c.eyeL = s('ellipse', { cx: -3.6, cy: -35, rx: 1.9, ry: 1.9 }, c.eyes);
    c.eyeR = s('ellipse', { cx: 3.6, cy: -35, rx: 1.9, ry: 1.9 }, c.eyes);
    c.zz = s('text', { 'class': 'char-zz', x: 11, y: -47, 'font-size': 9, 'font-weight': 800, fill: '#94a3b8' }, b);
    c.zz.textContent = 'z';
    c.lamps = [];
    var i;
    if (def.hat === 'star') {
      for (i = 0; i < 6; i++) {
        var an = Math.PI * i / 3;
        s('line', { x1: Math.cos(an) * 1.5, y1: -52 + Math.sin(an) * 1.5, x2: Math.cos(an) * 5, y2: -52 + Math.sin(an) * 5, stroke: '#ffd9bf', 'stroke-width': 1.6, 'stroke-linecap': 'round' }, b);
      }
      c.lamps.push(s('circle', { cx: 0, cy: -52, r: 1.8 }, b));
    } else if (def.hat === 'two') {
      s('line', { x1: -5, y1: -45, x2: -7, y2: -51, stroke: dark, 'stroke-width': 1.6 }, b);
      s('line', { x1: 5, y1: -45, x2: 7, y2: -51, stroke: dark, 'stroke-width': 1.6 }, b);
      c.lamps.push(s('circle', { cx: -7.5, cy: -52.5, r: 2.4 }, b), s('circle', { cx: 7.5, cy: -52.5, r: 2.4 }, b));
    } else if (def.hat === 'beret') {
      s('ellipse', { cx: -1.5, cy: -45.5, rx: 11, ry: 4.6, fill: '#6d3fc4' }, b);
      c.lamps.push(s('circle', { cx: -1.5, cy: -50.5, r: 1.8 }, b));
      s('line', { x1: 12, y1: -12, x2: 16, y2: -26, stroke: '#e9d5ff', 'stroke-width': 1.6, 'stroke-linecap': 'round' }, b);
      s('circle', { cx: 16.3, cy: -27.5, r: 2, fill: '#f472b6' }, b);
    } else if (def.hat === 'band') {
      s('rect', { x: -9, y: -49, width: 18, height: 4.5, rx: 2, fill: shade(col, 0.4) }, b);
      c.lamps.push(s('circle', { cx: -6, cy: -46.8, r: 1.3 }, b));
      s('circle', { cx: -2.4, cy: -46.8, r: 1.3, fill: '#e2e8f0' }, b);
    } else if (def.hat === 'phones') {
      s('path', { d: 'M-12.5 -36 Q-12.5 -51 0 -51 Q12.5 -51 12.5 -36', fill: 'none', stroke: '#0f172a', 'stroke-width': 2.2 }, b);
      s('rect', { x: -15, y: -40, width: 4.5, height: 9, rx: 2, fill: '#0f172a' }, b);
      s('rect', { x: 10.5, y: -40, width: 4.5, height: 9, rx: 2, fill: '#0f172a' }, b);
      c.lamps.push(s('circle', { cx: 0, cy: -51, r: 1.8 }, b));
    } else if (def.hat === 'cloud') {
      [[-5, -50, 4], [0, -53, 5], [5.5, -50, 4]].forEach(function (p) { s('circle', { cx: p[0], cy: p[1], r: p[2], fill: '#e0f2fe' }, b); });
      c.lamps.push(s('circle', { cx: 0, cy: -52, r: 1.6 }, b));
    } else if (def.hat === 'one') {
      s('line', { x1: 0, y1: -45, x2: 0, y2: -50, stroke: dark, 'stroke-width': 1.6 }, b);
      c.lamps.push(s('circle', { cx: 0, cy: -52, r: 2.4 }, b));
    }
    if (def.chest === 'tie') s('polygon', { points: '0,-23 -2.6,-19.5 0,-10 2.6,-19.5', fill: '#7c2d12' }, b);
    else if (def.chest === 'cursor') s('polygon', { points: '-3,-21 -3,-10.5 -0.4,-13 1.6,-9 3.2,-9.9 1.3,-13.8 4.6,-14.2', fill: '#f8fafc' }, b);
    else if (def.chest) {
      var q = s('text', { x: 0, y: -11.5, 'text-anchor': 'middle', 'font-size': def.chest.length > 1 ? 7.5 : 10, 'font-weight': 800, fill: 'rgba(11,15,23,.78)' }, b);
      q.textContent = def.chest;
    }
    var open = function (ev) { ev.stopPropagation(); if (!drag.moved) openPopup('cast', c.id); };
    g.addEventListener('click', open);
    g.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openPopup('cast', c.id); } });
    /* 이름표 + 말풍선(맨 위 층) */
    var o = c.over = s('g', {});
    o.style.cursor = 'pointer';
    o.addEventListener('click', open);
    var lw = textW(def.tag, 9) + 22;
    c.tagBox = s('rect', { x: -lw / 2, y: 5, width: lw, height: 14, rx: 7, fill: 'rgba(11,15,23,.9)', 'stroke-width': 1 }, o);
    c.tagDot = s('circle', { cx: -lw / 2 + 8, cy: 12, r: 2.6 }, o);
    var nt = s('text', { x: 5, y: 15.2, 'text-anchor': 'middle', 'font-size': 9, 'font-weight': 700, fill: '#e6ebf5' }, o);
    nt.textContent = def.tag;
    c.bub = s('g', {}, o);
    c.bubRect = s('rect', { y: -78, height: 16, rx: 8, fill: '#f8fafc' }, c.bub);
    s('polygon', { points: '-4,-63 4,-63 0,-58', fill: '#f8fafc' }, c.bub);
    c.bubText = s('text', { x: 0, y: -66.8, 'text-anchor': 'middle', 'font-size': 9, 'font-weight': 700, fill: '#0f172a' }, c.bub);
    c.bubShown = null;
  }

  function homeOf(c) { return c.data.status === 'resting' ? REST[c.id] : HOME[c.id]; }

  function ensureChars() {
    state.cast.forEach(function (d, i) {
      var c = chars[d.id];
      if (!c) {
        var hp = HOME[d.id].p;
        c = chars[d.id] = { id: d.id, x: hp[0], y: hp[1], path: [], speed: d.id === 'claude' ? 1.9 : 1.7,
          seed: i * 1.7, walk: 0, face: 1, flash: null, act: null, blink: 2 + (i * 0.37) % 3 };
        buildChar(c);
      }
      c.data = d;
      var col = STATUS[d.status].color;
      c.ring.setAttribute('stroke', col); c.tagBox.setAttribute('stroke', col); c.tagDot.setAttribute('fill', col);
      c.eyeL.setAttribute('fill', col); c.eyeR.setAttribute('fill', col);
      c.lamps.forEach(function (l) { l.setAttribute('fill', col); l.setAttribute('class', d.status === 'working' ? 'lamp-on' : ''); });
      c.el.setAttribute('opacity', d.status === 'offline' ? 0.45 : 1);
      c.over.setAttribute('opacity', d.status === 'offline' ? 0.6 : 1);
      c.zz.style.display = d.status === 'offline' || d.status === 'resting' ? '' : 'none';
    });
  }
  function placeAll() {
    for (var id in chars) { var c = chars[id], hm = homeOf(c); c.x = hm.p[0]; c.y = hm.p[1]; c.path = []; }
  }

  /* ---------- 길 찾기: 자리 → (통로) → 문 → 복도 → 문 → (통로) → 자리 ---------- */
  function roomAt(x, y) {
    for (var k in ROOMS) { var r = ROOMS[k].rect; if (x >= r[0] - 0.01 && x <= r[2] + 0.01 && y >= r[1] - 0.01 && y <= r[3] + 0.01) return k; }
    return null;
  }
  function zoneAt(room, y) { var R = ROOMS[room]; return R.zone ? R.zone(y) : 0; }
  function localLeg(P, room, from, to) {
    var gt = ROOMS[room].gate;
    if (!gt || from === to) return;
    if (from === 0) P.push(gt[0].slice(), gt[1].slice()); else P.push(gt[1].slice(), gt[0].slice());
  }
  function route(c, room, pt, zone) {
    var cur = roomAt(c.x, c.y), P = [];
    if (cur === room) { localLeg(P, room, zoneAt(room, c.y), zone); P.push(pt); return P; }
    if (cur) { var R = ROOMS[cur]; localLeg(P, cur, zoneAt(cur, c.y), 0); P.push(R.door.slice(), [R.door[0], CORR_Y]); }
    var T = ROOMS[room];
    P.push([T.door[0], CORR_Y], T.door.slice());
    localLeg(P, room, 0, zone);
    P.push(pt);
    return P;
  }
  function goTo(c, place) {
    if (Math.hypot(c.x - place.p[0], c.y - place.p[1]) < 0.05) { c.path = []; return; }
    c.path = route(c, place.room, place.p.slice(), place.zone);
  }
  function say(c, text, sec) { c.flash = { text: text, until: simT + sec }; }
  function placeOf(c) {
    /* 캐릭터가 (걷는 중이면 도착해서) 서 있을 곳 */
    var p = c.path.length ? c.path[c.path.length - 1] : [c.x, c.y];
    var room = roomAt(p[0], p[1]) || 'meeting';
    return { room: room, p: p, zone: zoneAt(room, p[1]) };
  }
  function besideOf(target) {
    var pl = placeOf(target), R = ROOMS[pl.room].rect;
    var px = pl.p[0] + (pl.p[0] + 0.85 < R[2] - 0.3 ? 0.85 : -0.85);
    return { room: pl.room, p: [clamp(px, R[0] + 0.3, R[2] - 0.3), pl.p[1] + 0.05], zone: pl.zone };
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
        var seat = 0;
        who.forEach(function (c) {
          c.act = m;
          goTo(c, c.id === 'claude' ? HOME.claude : { room: 'meeting', p: SEAT[seat++ % 7], zone: 0 });
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
        /* 할 일이 없으면 상태가 정한 자리(책상·휴게실)로 돌아가 머문다 */
        var hm = homeOf(c);
        if (Math.hypot(c.x - hm.p[0], c.y - hm.p[1]) > 0.05) goTo(c, hm);
      }
      if (c.path.length) {
        var left = c.speed * dt;
        while (left > 0 && c.path.length) {
          var p = c.path[0], dx = p[0] - c.x, dy = p[1] - c.y, dist = Math.hypot(dx, dy);
          if (dist <= left) { c.x = p[0]; c.y = p[1]; c.path.shift(); left -= dist; }
          else {
            c.x += dx / dist * left; c.y += dy / dist * left; left = 0;
            var sx = dx - dy; if (Math.abs(sx) > 0.05) c.face = sx > 0 ? 1 : -1;
          }
        }
        c.walk += dt * 11;
      }
      if (c.flash && simT > c.flash.until) c.flash = null;
      c.blink -= dt;
      if (c.blink < -0.14) c.blink = 2.5 + ((c.seed * 7 + simT) % 3);
    }
  }

  function draw() {
    var ui = state.ui, added = false;
    for (var id in chars) {
      var c = chars[id];
      if (!c.data) continue;
      var p = iso(c.x, c.y), moving = c.path.length > 0, st = c.data.status, bob, ph = c.walk;
      var hm = homeOf(c), atHome = !moving && !c.act && Math.hypot(c.x - hm.p[0], c.y - hm.p[1]) < 0.06;
      var tr = 'translate(' + p[0].toFixed(1) + ',' + p[1].toFixed(1) + ')';
      c.el.setAttribute('transform', tr);
      c.over.setAttribute('transform', tr + ' scale(' + ui.toFixed(2) + ')');
      var typing = st === 'working' && atHome;
      if (moving) {
        bob = -Math.abs(Math.sin(ph)) * 1.8;
        c.legL.setAttribute('y', (-6 - Math.max(0, Math.sin(ph)) * 3).toFixed(1));
        c.legR.setAttribute('y', (-6 - Math.max(0, -Math.sin(ph)) * 3).toFixed(1));
        c.armL.setAttribute('y', (-22 + Math.sin(ph) * 2.2).toFixed(1));
        c.armR.setAttribute('y', (-22 - Math.sin(ph) * 2.2).toFixed(1));
      } else {
        bob = st === 'offline' ? 0 : Math.sin(simT * (typing ? 3.2 : 1.5) + c.seed) * (typing ? 0.9 : 0.6);
        c.legL.setAttribute('y', -6); c.legR.setAttribute('y', -6);
        c.armL.setAttribute('y', typing ? (-23 + Math.sin(simT * 13 + c.seed) * 1.6).toFixed(1) : -22);
        c.armR.setAttribute('y', typing ? (-23 - Math.sin(simT * 13 + c.seed) * 1.6).toFixed(1) : -22);
      }
      c.body.setAttribute('transform', 'translate(0,' + bob.toFixed(1) + ')');
      c.eyes.setAttribute('transform', 'translate(' + (moving ? c.face * 1.6 : 0).toFixed(1) + ',0)');
      var ry = st === 'offline' || st === 'resting' ? 0.35 : (c.blink < 0 ? 0.3 : 1.9);
      c.eyeL.setAttribute('ry', ry); c.eyeR.setAttribute('ry', ry);
      var text = c.flash ? c.flash.text : (typing ? c.data.bubble : '');
      if (text !== c.bubShown) {
        c.bubShown = text;
        if (!text) c.bub.style.display = 'none';
        else {
          var bt = str(text, 20), bw = textW(bt, 9) + 14;
          c.bub.style.display = '';
          c.bubRect.setAttribute('x', (-bw / 2).toFixed(1)); c.bubRect.setAttribute('width', bw.toFixed(1));
          c.bubText.textContent = bt;
          c.over.parentNode.appendChild(c.over);              /* 말하는 쪽을 맨 위로 */
        }
      }
      if (!c.item) { c.item = { depth: 0, el: c.el }; added = true; }
      c.item.depth = c.x + c.y;
    }
    /* 깊이 정렬: 순서가 바뀐 때만 DOM 을 다시 꽂는다 */
    var arr = sortItems.concat(Object.keys(chars).map(function (id) { return chars[id].item; }).filter(Boolean));
    arr.forEach(function (it, i) { if (it.n == null) it.n = i + Math.random(); });
    arr.sort(function (a, b) { return a.depth - b.depth || a.n - b.n; });
    var sig = arr.map(function (it) { return it.n; }).join(',');
    if (sig !== sortSig || added) {
      sortSig = sig;
      var layer = $('sorted');
      arr.forEach(function (it) { layer.appendChild(it.el); });
    }
  }

  function renderMap() {
    sortItems = buildScene();
    sortSig = '';
    ensureChars();
    for (var id in chars) if (chars[id].over.parentNode !== $('overlay')) $('overlay').appendChild(chars[id].over);
    applyView();
    draw();
  }

  var lastTs = 0;
  function frame(ts) {
    var dt = lastTs ? Math.min(0.1, (ts - lastTs) / 1000) : 0;
    lastTs = ts;
    if (dt > 0 && state.cast.length) { step(dt); draw(); }
    requestAnimationFrame(frame);
  }

  /* ---------- zoom / pan ---------- */
  var drag = { on: false, moved: false, sx: 0, sy: 0, ox: 0, oy: 0 };
  function applyView() {
    var v = state.view;
    $('world').setAttribute('transform', 'translate(' + v.x.toFixed(1) + ',' + v.y.toFixed(1) + ') scale(' + v.k.toFixed(3) + ')');
    $('map').classList.toggle('zoomed', v.k > 1.01);
  }
  function zoomBy(f) {
    var v = state.view, cx = 60, cy = 170;
    var nk = Math.max(0.7, Math.min(3.5, v.k * f));
    v.x = cx - (cx - v.x) * (nk / v.k);
    v.y = cy - (cy - v.y) * (nk / v.k);
    v.k = nk;
    applyView();
  }
  function svgScale() {
    var r = $('map').getBoundingClientRect();
    if (!r.width || !r.height) return 1;
    return Math.max(920 / r.width, 580 / r.height);
  }
  function fitUi() { state.ui = clamp(svgScale() * 0.62, 1, 1.5); }
  function initMapControls() {
    var map = $('map');
    $('zoomIn').addEventListener('click', function () { zoomBy(1.25); });
    $('zoomOut').addEventListener('click', function () { zoomBy(0.8); });
    $('zoomFit').addEventListener('click', function () { state.view = { k: 1, x: 0, y: 0 }; applyView(); });
    map.addEventListener('wheel', function (ev) { ev.preventDefault(); zoomBy(ev.deltaY < 0 ? 1.12 : 0.89); }, { passive: false });
    map.addEventListener('pointerdown', function (ev) {
      drag.on = true; drag.moved = false; drag.sx = ev.clientX; drag.sy = ev.clientY; drag.ox = state.view.x; drag.oy = state.view.y;
    });
    window.addEventListener('pointermove', function (ev) {
      if (!drag.on) return;
      var dx = ev.clientX - drag.sx, dy = ev.clientY - drag.sy;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 6) return;
      if (ev.pointerType === 'touch' && state.view.k <= 1.01) return;
      drag.moved = true;
      map.classList.add('dragging');
      var sc = svgScale();
      state.view.x = drag.ox + dx * sc; state.view.y = drag.oy + dy * sc;
      applyView();
    });
    function end() { drag.on = false; map.classList.remove('dragging'); setTimeout(function () { drag.moved = false; }, 0); }
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    map.addEventListener('click', function () { if (!drag.moved) closePopup(); });
    window.addEventListener('resize', fitUi);
    fitUi();
  }

  /* ---------- 관제 띠(지도 위 한 줄) ---------- */
  var tickerHold = 0;
  function setTicker(e) {
    tickerHold = Date.now() + 9000;
    $('ticker').textContent = '지금 · ' + e.title;
    $('ticker').classList.add('hot');
  }
  function renderTicker() {
    if (Date.now() < tickerHold) return;
    var t = $('ticker'), e = state.events[0];
    t.classList.remove('hot');
    var busy = state.cast.filter(function (c) { return c.status === 'working'; });
    var head = busy.length ? '일하는 AI ' + busy.length + '명' : '지금은 진행 중인 지시가 없습니다';
    t.textContent = head + (e ? ' · 최근: ' + e.title + ' (' + agoEv(e) + ')' : '');
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
    if (a.status === 'resting') return ROOMS.lounge.label;
    return ROOMS[HOME[a.id].room].label + (a.id === 'claude' ? ' · 관제 콘솔' : ' · 자기 책상');
  }
  function openPopup(kind, id) {
    var a = null, rows;
    (kind === 'cast' ? state.cast : state.stations).forEach(function (x) { if (x.id === id) a = x; });
    if (!a) { closePopup(); return; }
    state.popup = { kind: kind, id: id };
    var st = STATUS[a.status];
    $('popAvatar').textContent = a.name.slice(0, 1);
    $('popAvatar').style.background = kind === 'cast' ? a.color : st.color;
    $('popName').textContent = a.name;
    $('popRole').textContent = (kind === 'cast' ? 'AI 에이전트 · ' : '일감 · ') + (a.role || '역할 미지정');
    var pb = $('popBadge'); pb.textContent = st.label; pb.style.color = st.color;
    var ul = $('popLogs'); ul.textContent = '';
    if (kind === 'cast') {
      rows = [['자리', whereOf(a)], ['현재 작업', a.task || '없음'], ['한마디', a.bubble || '–'], ['마지막 활동', lastText(a.last)]];
      if (a.id === 'vooy' && /미설정/.test(a.task)) rows.push(['안내', '활동 신호가 아직 연결되지 않아 대기로 표시합니다']);
      a.sub.slice(0, 4).forEach(function (x) { rows.push([x.name, STATUS[x.status].label + (x.task ? ' · ' + x.task : '')]); });
      var evs = state.events.filter(function (e) { return e.from === a.id || e.to === a.id || e.members.indexOf(a.id) >= 0; }).slice(0, 8);
      $('popSub').textContent = '이 AI 가 관련된 실제 지시·호출';
      if (!evs.length) ul.appendChild(h('li', 'empty', '오늘 감지된 지시·호출이 없습니다'));
      evs.forEach(function (e) { ul.appendChild(evItem(e)); });
    } else {
      rows = [['위치', ROOMS[a.room].label], ['현재 작업', a.task || '없음'], ['마지막 활동', lastText(a.last)]];
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
  function dot(color) { var d = h('span', 'dot'); d.style.background = color; return d; }
  function castCard(a) {
    var b = h('button', 'agent s-' + a.status); b.type = 'button';
    var av = h('span', 'avatar sm', a.name.slice(0, 1)); av.style.background = a.color; b.appendChild(av);
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
  function renderTab() {
    var body = $('tabBody'), keep = body.scrollTop; body.textContent = '';
    var C = state.cast, S = state.stations;
    if (state.tab === 'tower') {
      var busy = C.filter(function (a) { return a.status === 'working'; });
      section(body, '지금 일하는 AI', busy.length + '명');
      if (!busy.length) body.appendChild(h('div', 'empty sm', '진행 중인 지시가 없어 모두 자리에서 대기 중입니다'));
      busy.forEach(function (a) { body.appendChild(castCard(a)); });
      section(body, '최근 지시 · 호출', '실제 감지한 것만');
      var ul = h('ul', 'loglist'), evs = state.events.slice(0, 12);
      if (!evs.length) body.appendChild(h('div', 'empty sm', '오늘 감지된 지시·호출이 없습니다'));
      evs.forEach(function (e) { ul.appendChild(evItem(e)); });
      if (evs.length) body.appendChild(ul);
      [['resting', '방금 마치고 쉬는 중'], ['idle', '대기'], ['offline', '오프라인']].forEach(function (g) {
        var list = C.filter(function (a) { return a.status === g[0]; });
        if (!list.length) return;
        section(body, g[1], list.length + '명');
        var chips = h('div', 'chips');
        list.forEach(function (a) { chips.appendChild(chipOf(a, 'cast')); });
        body.appendChild(chips);
      });
    } else if (state.tab === 'agents') {
      C.slice().sort(function (a, b) { return STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status); })
        .forEach(function (a) { body.appendChild(castCard(a)); });
    } else if (state.tab === 'tasks') {
      ROOM_ORDER.forEach(function (key) {
        var st = S.filter(function (a) { return a.room === key; });
        if (!st.length) return;
        section(body, ROOMS[key].label, st.filter(function (a) { return a.status === 'working'; }).length + '건 진행');
        st.forEach(function (a) { body.appendChild(stationRow(a)); });
      });
      if (!S.length) body.appendChild(h('div', 'empty', '표시할 일감이 없습니다'));
    } else {
      var ul2 = h('ul', 'loglist'), ls = state.logs.slice(0, 60);
      if (!ls.length) body.appendChild(h('div', 'empty', '오늘 활동 로그가 없습니다'));
      ls.forEach(function (l) {
        var li = logItem(l.timeText, l.title, l.detail), nameOf = '';
        S.forEach(function (a) { if (a.src === l.src && a.id === l.agent) nameOf = a.name; });
        C.forEach(function (a) { if (a.id === l.agent) nameOf = a.name; });
        if (nameOf) li.lastChild.insertBefore(h('div', 'ld', nameOf), li.lastChild.firstChild);
        ul2.appendChild(li);
      });
      if (ls.length) body.appendChild(ul2);
    }
    body.scrollTop = keep;
  }

  function renderFoot() {
    var foot = $('footStatus'); foot.textContent = '';
    var modeText = { live: '실시간 채널', file: '백업 파일', demo: '데모', none: '연결 안 됨' }[state.mode];
    [['PC', state.pc, modeText], ['피클', state.pickle, '상태 파일']].forEach(function (x) {
      var i = x[1], row = h('div'), cls, txt;
      if (!i.ok) { cls = 'bad'; txt = '불러오지 못함'; }
      else if (!i.updated) { cls = 'late'; txt = '시각 정보 없음'; }
      else if (i.stale) { cls = 'late'; txt = x[2] + ' · ' + fmtMDHM(i.updated) + ' · 갱신 지연(' + ago(i.updated) + ')'; }
      else { cls = 'ok'; txt = x[2] + ' · ' + fmtMDHM(i.updated) + ' · 정상(' + ago(i.updated) + ')'; }
      row.appendChild(document.createTextNode(x[0] + ' '));
      row.appendChild(h('span', cls, txt));
      foot.appendChild(row);
    });
    var live = state.mode === 'live' && state.pc.ok && !state.pc.stale;
    $('liveDot').classList.toggle('warn', !live && state.mode !== 'demo');
    $('liveText').textContent = state.mode === 'demo' ? 'DEMO' : (live ? 'LIVE' : (state.mode === 'file' ? '백업' : '끊김'));
  }
  function renderSide() {
    var C = state.cast, S = state.stations;
    $('kDone').textContent = state.summary.done;
    $('kWork').textContent = C.filter(function (a) { return a.status === 'working'; }).length;
    $('kIdle').textContent = C.filter(function (a) { return a.status === 'idle' || a.status === 'resting'; }).length;
    $('kAll').textContent = S.filter(function (a) { return a.status === 'working'; }).length;
    renderFoot();
    var msg = $('mapMsg');
    if (state.demo) { msg.hidden = false; msg.textContent = '데모 화면입니다(실제 상태 아님)'; }
    else if (!state.pc.ok && !state.pickle.ok) { msg.hidden = false; msg.textContent = '상태를 불러오지 못했습니다. AI 들은 대기 모습으로 두고, 잠시 뒤 다시 시도합니다.'; }
    else msg.hidden = true;
    renderTicker();
    renderTab();
  }

  function renderAll() {
    renderMap();
    renderSide();
    if (state.popup) openPopup(state.popup.kind, state.popup.id);
  }

  function initSide() {
    var legend = $('legend');
    STATUS_ORDER.forEach(function (k) {
      var sp = h('span'), i = h('i'); i.style.background = STATUS[k].color;
      sp.appendChild(i); sp.appendChild(document.createTextNode(STATUS[k].label)); legend.appendChild(sp);
    });
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
    setInterval(function () { if (state.cast.length) { normalize(); ensureChars(); renderSide(); } }, 20000);
  }

  /* 미리보기용: ?demo=1(가짜 상태·사건) · ?tab=agents · ?open=claude · ?ff=12(12초 뒤 모습으로 건너뛰기) */
  var qs = new URLSearchParams(location.search);
  state.demo = qs.get('demo') === '1';
  initSide();
  initMapControls();
  normalize();          /* 데이터가 오기 전에도 모두 자리에서 대기하는 모습으로 보인다 */
  renderAll();
  if (/^(tower|agents|tasks|logs)$/.test(qs.get('tab') || '')) {
    var tb = document.querySelector('.tabs button[data-tab="' + qs.get('tab') + '"]');
    if (tb) tb.click();
  }
  poll().then(function () {
    var ff = Math.min(600, Number(qs.get('ff')) || 0);
    for (var t = 0; t < ff; t += 0.05) step(0.05);
    draw();
    if (qs.get('open')) openPopup('cast', qs.get('open'));
    document.documentElement.setAttribute('data-ready', '1');
  });
  requestAnimationFrame(frame);
  setInterval(function () { if (!document.hidden) poll(); }, state.demo ? FILE_MS : LIVE_MS);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { lastTs = 0; poll(); } });
})();
