/* AI 오피스 대화창 — 사무실 지도 아래에 붙어 있는 대화 영역.
   - 대표님이 여기에 적으면 클로드(이 PC 의 Claude)가 답한다. '@키링 …' 처럼 이름을 붙이면 그 AI(노션 연락판)가 답한다.
   - 글 내용은 PIN 으로 로그인한 기기에서만 받아 와 글자로 그린다. 로그인하지 않은 방문자에게는
     '대표님 → 키링 지시 · 답변 완료' 같은 고정 문구만 보인다(Worker 가 내용 없이 누구에게·상태만 내려 준다).
   - 캐릭터 머리 위 말풍선도 고정 문구 두 개뿐이다. 공개 상태 파일에는 아무것도 쓰지 않는다.
   - 로그인하면 받은 세션 토큰은 이 브라우저(localStorage)에만 둔다. PIN 은 저장하지 않는다. */
(function () {
  'use strict';
  var API = 'https://ai-office-live.btc-indicator-mobile.workers.dev/chat';
  var KEY = 'aio-chat-session';
  var NOTE_IN = '대표님 지시 접수', NOTE_OUT = '대표님께 답변';
  var ICONS = 'assets/icons/';
  var AGENTS = {
    claude: { name: '클로드', icon: 'claude.png', color: '#e8935f', alias: ['클로드', 'claude'], how: 'PC' },
    pickle: { name: '피클', mark: '피', color: '#7ccf6b', alias: ['피클', 'pickle'] },
    instinct: { name: 'Instinct', mark: 'I', color: '#e2e8f0', alias: ['instinct', '인스팅트'] },
    pally: { name: 'Pally', icon: 'pally.png', color: '#64748b', alias: ['pally', '팔리'] },
    keyring: { name: '키링', mark: '키', color: '#f59e0b', alias: ['키링', 'keyring'] }
  };
  var ORDER = ['claude', 'pickle', 'instinct', 'pally', 'keyring'];
  var STATUS = { queued: '대기', processing: '처리 중', waiting: '답 기다리는 중', done: '완료', failed: '실패', canceled: '취소' };
  var FEED = { queued: '대기', processing: '처리 중', waiting: '답 대기', done: '답변 완료', failed: '실패', canceled: '취소' };

  var dock = document.getElementById('chatDock');
  if (!dock) return;
  var token = '';
  try { token = localStorage.getItem(KEY) || ''; } catch (e) {}
  var ui = {}, lastId = 0, timer = null, sending = false, maxText = 2000, open = {}, pcAlive = false;
  var rows = {};                      /* 지시 번호 -> 상태 표시 요소 */
  var seen = null;                    /* 지시 번호 -> 마지막으로 본 상태(말풍선은 바뀔 때만) */
  var firstLoad = true, feedSig = '';

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function note(title, id) { try { if (window.__aioLocalNote) window.__aioLocalNote(title, id); } catch (e) {} }
  function hm(ts) { var d = new Date(ts); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
  function agent(id) { return AGENTS[id] || AGENTS.claude; }
  function avatar(id) {
    var a = agent(id), n = el('span', 'cd-av');
    if (a.icon) { var im = document.createElement('img'); im.src = ICONS + a.icon; im.alt = ''; n.appendChild(im); }
    else { n.textContent = a.mark; n.style.background = a.color; }
    return n;
  }
  function findAgent(word) {
    var w = String(word).toLowerCase();
    for (var i = 0; i < ORDER.length; i++) if (AGENTS[ORDER[i]].alias.indexOf(w) >= 0) return ORDER[i];
    return '';
  }

  function call(method, path, body) {
    var headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body) headers['Content-Type'] = 'application/json';
    return fetch(API + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store', credentials: 'omit' })
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (data) { return { status: res.status, data: data }; }); });
  }

  function build() {
    var head = el('div', 'cd-head');
    head.appendChild(el('b', null, '대화'));
    ui.pc = el('span', 'cd-pc', ''); head.appendChild(ui.pc);
    head.appendChild(el('span', 'cd-sp'));
    ui.clear = el('button', 'cd-mini', '기록 지우기'); ui.clear.type = 'button';
    ui.logout = el('button', 'cd-mini', '로그아웃'); ui.logout.type = 'button';
    ui.size = el('button', 'cd-mini', '넓게'); ui.size.type = 'button';
    head.appendChild(ui.clear); head.appendChild(ui.logout); head.appendChild(ui.size);
    dock.appendChild(head);

    ui.list = el('div', 'cd-list'); ui.list.setAttribute('aria-live', 'polite'); dock.appendChild(ui.list);
    ui.empty = el('div', 'cd-empty', ''); ui.list.appendChild(ui.empty);

    ui.pick = el('div', 'cd-pick'); ui.pick.hidden = true;
    ORDER.forEach(function (id) {
      var b = el('button', 'cd-chip'); b.type = 'button'; b.appendChild(avatar(id)); b.appendChild(el('span', null, '@' + AGENTS[id].name));
      b.setAttribute('data-id', id);
      b.addEventListener('click', function () {
        var rest = ui.text.value.replace(/^@\S*\s*/, '');
        ui.text.value = '@' + AGENTS[id].name + ' ' + rest; ui.pick.hidden = true; ui.text.focus(); targetHint();
      });
      ui.pick.appendChild(b);
    });
    dock.appendChild(ui.pick);

    ui.form = el('form', 'cd-form');
    ui.at = el('button', 'cd-at', '@'); ui.at.type = 'button'; ui.at.setAttribute('aria-label', '받는 AI 고르기');
    ui.text = el('textarea'); ui.text.rows = 1; ui.text.placeholder = '메시지 · @이름'; ui.text.setAttribute('aria-label', '보낼 내용');
    ui.send = el('button', 'cd-go', '보내기'); ui.send.type = 'submit';
    ui.form.appendChild(ui.at); ui.form.appendChild(ui.text); ui.form.appendChild(ui.send);
    dock.appendChild(ui.form);

    ui.login = el('form', 'cd-login');
    ui.loginOpen = el('button', 'cd-loginbtn', 'PIN으로 로그인'); ui.loginOpen.type = 'button';
    ui.pin = el('input'); ui.pin.type = 'password'; ui.pin.autocomplete = 'off'; ui.pin.placeholder = 'PIN'; ui.pin.maxLength = 64; ui.pin.setAttribute('aria-label', 'PIN'); ui.pin.hidden = true;
    ui.loginGo = el('button', 'cd-go', '들어가기'); ui.loginGo.type = 'submit'; ui.loginGo.hidden = true;
    ui.login.appendChild(ui.loginOpen); ui.login.appendChild(ui.pin); ui.login.appendChild(ui.loginGo);
    dock.appendChild(ui.login);

    ui.hint = el('div', 'cd-hint', ''); dock.appendChild(ui.hint);

    ui.loginOpen.addEventListener('click', function () { ui.loginOpen.hidden = true; ui.pin.hidden = false; ui.loginGo.hidden = false; ui.pin.focus(); });
    ui.login.addEventListener('submit', function (ev) { ev.preventDefault(); login(); });
    ui.form.addEventListener('submit', function (ev) { ev.preventDefault(); send(); });
    ui.at.addEventListener('click', function () { showPick(ui.pick.hidden ? '' : null); });
    ui.text.addEventListener('input', function () {
      var m = ui.text.value.match(/^@(\S*)$/);
      showPick(m ? m[1] : null); targetHint(); grow();
    });
    ui.text.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && window.matchMedia('(hover:hover)').matches) { ev.preventDefault(); send(); }
    });
    ui.logout.addEventListener('click', function () { call('POST', '/logout', {}).then(signOut, signOut); });
    ui.clear.addEventListener('click', function () {
      if (!window.confirm('대화 기록을 모두 지울까요?')) return;
      call('POST', '/clear', {}).then(function (r) {
        if (r.status === 401) return signOut();
        if (!r.data.ok) return hint(r.data.error || '지우지 못했습니다.');
        reset(); refresh();
      }, function () { hint('연결하지 못했습니다.'); });
    });
    ui.size.addEventListener('click', function () {
      var tall = dock.classList.toggle('tall'); ui.size.textContent = tall ? '좁게' : '넓게'; ui.list.scrollTop = ui.list.scrollHeight;
    });
  }

  function grow() { ui.text.style.height = 'auto'; ui.text.style.height = Math.min(ui.text.scrollHeight, 96) + 'px'; }
  function showPick(prefix) {
    if (prefix == null) { ui.pick.hidden = true; return; }
    var p = prefix.toLowerCase(), any = false;
    Array.prototype.forEach.call(ui.pick.children, function (b) {
      var a = AGENTS[b.getAttribute('data-id')];
      var ok = !p || a.alias.some(function (x) { return x.indexOf(p) === 0; });
      b.hidden = !ok; any = any || ok;
    });
    ui.pick.hidden = !any;
  }
  /* 맨 앞 '@이름' 을 받는 AI 로 읽는다. 이름이 없으면 클로드. */
  function parse(raw) {
    var m = raw.match(/^@(\S+)\s*([\s\S]*)$/);
    if (!m) return { to: 'claude', text: raw };
    var id = findAgent(m[1]);
    return id ? { to: id, text: m[2].trim() } : { to: '', text: raw, unknown: m[1] };
  }
  function targetHint() {
    if (!token) return;
    var p = parse(ui.text.value.trim());
    if (p.unknown) return hint('모르는 이름입니다. @ 를 눌러 골라 주세요.');
    if (p.to && p.to !== 'claude') return hint(agent(p.to).name + '에게 보냅니다. 연락판을 약 5분마다 확인하므로 답은 몇 분 걸립니다.');
    idleHint();
  }
  function idleHint() {
    if (!token) return hint('대표님만 입력할 수 있습니다. 다른 분에게는 진행 표시만 보입니다.');
    if (open.claude === 'processing') return hint('클로드가 처리하고 있습니다. 길면 15분까지 걸립니다.');
    if (!pcAlive) return hint('PC 작업기가 꺼져 있습니다. 지금 보내면 켜질 때까지 대기합니다.');
    hint('클로드는 읽기·검색·상태 확인만 합니다. 다른 AI 는 @이름 으로 부릅니다.');
  }

  function reset() { lastId = 0; rows = {}; firstLoad = true; feedSig = ''; while (ui.list.firstChild) ui.list.removeChild(ui.list.firstChild); ui.list.appendChild(ui.empty); }
  function hint(t) { ui.hint.textContent = t || ''; }
  function mode() {
    var inside = !!token;
    ui.login.hidden = inside; ui.form.hidden = !inside; ui.logout.hidden = !inside; ui.clear.hidden = !inside;
    if (!inside) { ui.pick.hidden = true; ui.loginOpen.hidden = false; ui.pin.hidden = true; ui.loginGo.hidden = true; }
    dock.classList.toggle('guest', !inside);
  }
  function signOut() {
    token = ''; try { localStorage.removeItem(KEY); } catch (e) {}
    reset(); mode(); idleHint(); refresh();
  }

  function login() {
    var pin = ui.pin.value.trim();
    if (!pin) return;
    hint('확인 중…');
    call('POST', '/login', { pin: pin }).then(function (r) {
      ui.pin.value = '';
      if (r.data && r.data.ok && r.data.token) {
        token = r.data.token; try { localStorage.setItem(KEY, token); } catch (e) {}
        reset(); mode(); refresh(); ui.text.focus();
      } else hint((r.data && r.data.error) || '들어가지 못했습니다.');
    }, function () { ui.pin.value = ''; hint('연결하지 못했습니다. 잠시 뒤에 다시 해 주세요.'); });
  }

  function setState(id, status) {
    var r = rows[id]; if (!r || r.status === status) return;
    r.status = status;
    r.badge.textContent = STATUS[status] || '';
    r.badge.className = 'cd-st st-' + status;
    r.cancel.hidden = status !== 'queued' && status !== 'waiting';
  }
  function add(m) {
    var mine = m.role === 'user', who = m.who || 'claude';
    var item = el('div', 'cd-msg ' + (mine ? 'me' : 'ai'));
    var top = el('div', 'cd-who');
    if (!mine) top.appendChild(avatar(who));
    top.appendChild(el('span', null, (mine ? '대표님 → ' + agent(who).name : agent(who).name) + ' · ' + hm(m.ts)));
    item.appendChild(top);
    item.appendChild(el('div', 'cd-bubble', m.text));
    if (mine) {
      var meta = el('div', 'cd-meta');
      var badge = el('span', 'cd-st', '');
      var cancel = el('button', 'cd-mini', '취소'); cancel.type = 'button'; cancel.hidden = true;
      cancel.addEventListener('click', function () { call('POST', '/cancel', { id: m.id }).then(function () { refresh(); }); });
      meta.appendChild(badge); meta.appendChild(cancel); item.appendChild(meta);
      rows[m.id] = { badge: badge, cancel: cancel, status: '' };
      setState(m.id, m.status);
    }
    ui.list.appendChild(item);
  }
  /* 로그인하지 않은 화면: 내용 없이 고정 문구 한 줄씩 */
  function drawFeed(feed) {
    var sig = JSON.stringify(feed);
    if (sig === feedSig) return;
    feedSig = sig;
    while (ui.list.firstChild) ui.list.removeChild(ui.list.firstChild);
    ui.list.appendChild(ui.empty);
    feed.forEach(function (f) {
      var line = el('div', 'cd-feed');
      line.appendChild(avatar(f.to));
      line.appendChild(el('span', null, '대표님 → ' + agent(f.to).name + ' 지시 · ' + (FEED[f.status] || '') + ' · ' + hm(f.ts)));
      ui.list.appendChild(line);
    });
    ui.list.scrollTop = ui.list.scrollHeight;
  }
  /* 지시가 새로 들어오거나 답이 오면 그 AI 머리 위에 고정 문구를 띄운다(내용은 쓰지 않는다). */
  function bubbles(feed) {
    var first = !seen; if (first) seen = {};
    feed.forEach(function (f) {
      var was = seen[f.id]; seen[f.id] = f.status;
      if (first || was === f.status) return;
      if (was === undefined && f.status !== 'done') { if (Date.now() - f.ts < 120000) note(NOTE_IN, f.to); }
      else if (f.status === 'done') note(NOTE_OUT, f.to);
    });
  }

  function refresh() {
    var path = token ? '/messages?after=' + lastId : '/feed';
    return call('GET', path).then(function (r) {
      if (token && r.status === 401) return signOut();
      var d = r.data; if (!d || !d.ok) return;
      var feed = d.feed || [];
      pcAlive = !!(d.pc && d.pc.alive);
      ui.pc.textContent = pcAlive ? 'PC 연결됨' : 'PC 작업기 꺼짐';
      ui.pc.className = 'cd-pc ' + (pcAlive ? 'on' : 'off');
      if (token) {
        var near = ui.list.scrollHeight - ui.list.scrollTop - ui.list.clientHeight < 80;
        (d.messages || []).forEach(function (m) { if (m.id > lastId) { lastId = m.id; add(m); } });
        feed.forEach(function (f) { setState(f.id, f.status); });
        if ((d.messages || []).length && (near || firstLoad)) ui.list.scrollTop = ui.list.scrollHeight;
        firstLoad = false;
        open = d.open || {}; maxText = d.max_text || maxText;
        ui.empty.textContent = lastId ? '' : '아직 대화가 없습니다. 아래에 적으면 클로드가 답합니다.';
        ui.send.disabled = sending;
        if (!ui.text.value) idleHint();
      } else {
        drawFeed(feed);
        ui.empty.textContent = feed.length ? '' : '아직 대화가 없습니다.';
        idleHint();
      }
      bubbles(feed);
    }, function () { if (token) hint('연결이 끊겼습니다. 다시 시도하는 중입니다.'); });
  }

  function send() {
    var raw = ui.text.value.trim();
    if (!raw || sending) return;
    var p = parse(raw);
    if (p.unknown) return hint('모르는 이름입니다(@' + p.unknown + '). @ 를 눌러 골라 주세요.');
    if (!p.text) return hint(agent(p.to).name + '에게 보낼 내용을 적어 주세요.');
    if (p.text.length > maxText) return hint('한 번에 ' + maxText + '자까지 보낼 수 있습니다(지금 ' + p.text.length + '자).');
    if (open[p.to]) return hint(agent(p.to).name + '가 앞 지시를 처리하고 있습니다. 답이 온 뒤에 보내 주세요.');
    sending = true; ui.send.disabled = true;
    call('POST', '/send', { text: p.text, to: p.to }).then(function (r) {
      sending = false;
      if (r.status === 401) return signOut();
      if (r.data && r.data.ok) { ui.text.value = ''; grow(); ui.pick.hidden = true; open[p.to] = 'queued'; }
      else hint((r.data && r.data.error) || '보내지 못했습니다.');
      return refresh();
    }, function () { sending = false; ui.send.disabled = false; hint('보내지 못했습니다. 연결을 확인해 주세요.'); });
  }

  function anyOpen() { for (var k in open) if (open[k]) return true; return false; }
  function tick() {
    var wait = !token ? 20000 : (anyOpen() ? 4000 : 12000);
    if (document.hidden) { timer = setTimeout(tick, wait); return; }
    refresh().then(function () { timer = setTimeout(tick, !token ? 20000 : (anyOpen() ? 4000 : 12000)); });
  }

  build(); mode(); idleHint();
  dock.hidden = false;
  refresh().then(function () { timer = setTimeout(tick, 4000); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
})();
