/* AI 오피스 '지시' 대화창 — 대표님이 PC 의 Claude 에게 직접 지시하는 창.
   - 지시와 답은 Worker(비공개 저장소)에만 있다. 이 화면은 PIN 으로 로그인한 기기에서만 받아 와 글자로 그린다.
   - 공개 상태 파일에는 아무것도 쓰지 않는다. 화면 연출도 고정 문구 두 개뿐이다.
   - 로그인하면 받은 세션 토큰은 이 브라우저(localStorage)에만 둔다. PIN 은 저장하지 않는다. */
(function () {
  'use strict';
  var API = 'https://ai-office-live.btc-indicator-mobile.workers.dev/chat';
  var KEY = 'aio-chat-session';
  var NOTE_IN = '대표님 지시 접수', NOTE_OUT = '대표님께 답변 전달';
  var STATUS = { queued: '대기', processing: '처리 중', done: '완료', failed: '실패', canceled: '취소' };

  var btn = document.getElementById('chatBtn');
  if (!btn) return;
  var token = '';
  try { token = localStorage.getItem(KEY) || ''; } catch (e) {}
  var panel = null, ui = {}, lastId = 0, timer = null, opened = false, busy = '', sending = false, maxText = 2000;
  var rows = {};                      /* 지시 번호 -> 상태 표시 요소 */
  var announced = {};                 /* 이미 화면 연출을 한 답 번호 */
  var firstLoad = true;

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function note(title) { try { if (window.__aioLocalNote) window.__aioLocalNote(title); } catch (e) {} }
  function hm(ts) { var d = new Date(ts); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }

  function call(method, path, body) {
    var headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body) headers['Content-Type'] = 'application/json';
    return fetch(API + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store', credentials: 'omit' })
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (data) { return { status: res.status, data: data }; }); });
  }

  function build() {
    panel = el('section', 'chat'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', '지시 대화창'); panel.hidden = true;
    var head = el('header', 'chat-head');
    var title = el('div', 'chat-title'); title.appendChild(el('b', null, '지시')); ui.pc = el('span', 'chat-pc', ''); title.appendChild(ui.pc);
    head.appendChild(title);
    ui.clear = el('button', 'chat-mini', '기록 지우기'); ui.clear.type = 'button';
    ui.logout = el('button', 'chat-mini', '로그아웃'); ui.logout.type = 'button';
    var close = el('button', 'chat-x', '×'); close.type = 'button'; close.setAttribute('aria-label', '닫기');
    head.appendChild(ui.clear); head.appendChild(ui.logout); head.appendChild(close);
    panel.appendChild(head);

    ui.login = el('form', 'chat-login');
    ui.login.appendChild(el('p', null, '대표님만 쓰는 창입니다. PIN 을 입력해 주세요.'));
    ui.pin = el('input'); ui.pin.type = 'password'; ui.pin.autocomplete = 'off'; ui.pin.placeholder = 'PIN'; ui.pin.maxLength = 64; ui.pin.setAttribute('aria-label', 'PIN');
    ui.login.appendChild(ui.pin);
    var go = el('button', 'chat-go', '들어가기'); go.type = 'submit'; ui.login.appendChild(go);
    ui.loginMsg = el('div', 'chat-err', ''); ui.login.appendChild(ui.loginMsg);
    panel.appendChild(ui.login);

    ui.list = el('div', 'chat-list'); ui.list.setAttribute('aria-live', 'polite'); panel.appendChild(ui.list);
    ui.form = el('form', 'chat-form');
    ui.text = el('textarea'); ui.text.rows = 2; ui.text.placeholder = '클로드에게 지시할 내용'; ui.text.setAttribute('aria-label', '지시 내용');
    ui.send = el('button', 'chat-go', '보내기'); ui.send.type = 'submit';
    ui.form.appendChild(ui.text); ui.form.appendChild(ui.send);
    panel.appendChild(ui.form);
    ui.hint = el('div', 'chat-hint', ''); panel.appendChild(ui.hint);
    document.body.appendChild(panel);

    close.addEventListener('click', hide);
    ui.login.addEventListener('submit', function (ev) { ev.preventDefault(); login(); });
    ui.form.addEventListener('submit', function (ev) { ev.preventDefault(); send(); });
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
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && opened) hide(); });
  }

  function reset() { lastId = 0; rows = {}; firstLoad = true; while (ui.list.firstChild) ui.list.removeChild(ui.list.firstChild); }
  function hint(t) { ui.hint.textContent = t || ''; }
  function mode() {
    var inside = !!token;
    ui.login.hidden = inside; ui.list.hidden = !inside; ui.form.hidden = !inside; ui.logout.hidden = !inside; ui.clear.hidden = !inside;
    if (!inside) { ui.pc.textContent = ''; hint(''); }
  }
  function signOut() {
    token = ''; try { localStorage.removeItem(KEY); } catch (e) {}
    stop(); reset(); mode();
    if (opened) ui.pin.focus();
  }

  function login() {
    var pin = ui.pin.value.trim();
    if (!pin) return;
    ui.loginMsg.textContent = '확인 중…';
    call('POST', '/login', { pin: pin }).then(function (r) {
      ui.pin.value = '';
      if (r.data && r.data.ok && r.data.token) {
        token = r.data.token; try { localStorage.setItem(KEY, token); } catch (e) {}
        ui.loginMsg.textContent = ''; mode(); refresh(); start(); ui.text.focus();
      } else ui.loginMsg.textContent = (r.data && r.data.error) || '들어가지 못했습니다.';
    }, function () { ui.pin.value = ''; ui.loginMsg.textContent = '연결하지 못했습니다. 잠시 뒤에 다시 해 주세요.'; });
  }

  function setState(id, status) {
    var r = rows[id]; if (!r || r.status === status) return;
    r.status = status;
    r.badge.textContent = STATUS[status] || '';
    r.badge.className = 'chat-st st-' + status;
    r.cancel.hidden = status !== 'queued';
  }
  function add(m) {
    var mine = m.role === 'user';
    var item = el('div', 'chat-msg ' + (mine ? 'me' : 'ai'));
    item.appendChild(el('div', 'chat-who', (mine ? '대표님' : '클로드') + ' · ' + hm(m.ts)));
    item.appendChild(el('div', 'chat-bubble', m.text));
    if (mine) {
      var meta = el('div', 'chat-meta');
      var badge = el('span', 'chat-st', '');
      var cancel = el('button', 'chat-mini', '취소'); cancel.type = 'button'; cancel.hidden = true;
      cancel.addEventListener('click', function () { call('POST', '/cancel', { id: m.id }).then(function (r) { if (r.data.ok) setState(m.id, 'canceled'); refresh(); }); });
      meta.appendChild(badge); meta.appendChild(cancel); item.appendChild(meta);
      rows[m.id] = { badge: badge, cancel: cancel, status: '' };
      setState(m.id, m.status);
    } else if (!firstLoad && !announced[m.id]) { announced[m.id] = true; note(NOTE_OUT); }
    ui.list.appendChild(item);
  }

  function refresh() {
    if (!token) return Promise.resolve();
    return call('GET', '/messages?after=' + lastId).then(function (r) {
      if (r.status === 401) return signOut();
      var d = r.data; if (!d || !d.ok) return;
      var near = ui.list.scrollHeight - ui.list.scrollTop - ui.list.clientHeight < 80;
      (d.messages || []).forEach(function (m) { if (m.id > lastId) { lastId = m.id; add(m); } });
      (d.states || []).forEach(function (s) { setState(s.id, s.status); });
      if ((d.messages || []).length && (near || firstLoad)) ui.list.scrollTop = ui.list.scrollHeight;
      firstLoad = false;
      busy = d.busy || ''; maxText = d.max_text || maxText;
      var alive = d.pc && d.pc.alive;
      ui.pc.textContent = alive ? 'PC 연결됨' : 'PC 작업기 꺼짐';
      ui.pc.className = 'chat-pc ' + (alive ? 'on' : 'off');
      ui.send.disabled = !!busy || sending;
      if (busy === 'processing') hint('클로드가 처리하고 있습니다. 길면 15분까지 걸립니다.');
      else if (busy === 'queued') hint(alive ? '곧 처리를 시작합니다.' : 'PC 작업기가 꺼져 있어 대기 중입니다. PC 에서 작업기를 켜면 처리됩니다.');
      else if (!alive) hint('PC 작업기가 꺼져 있습니다. 지금 보내면 켜질 때까지 대기합니다.');
      else hint('읽기·검색·상태 확인만 할 수 있습니다. 글 발행·파일 수정은 하지 않습니다.');
    }, function () { hint('연결이 끊겼습니다. 다시 시도하는 중입니다.'); });
  }

  function send() {
    var text = ui.text.value.trim();
    if (!text || sending || busy) return;
    if (text.length > maxText) return hint('지시는 ' + maxText + '자까지 보낼 수 있습니다(지금 ' + text.length + '자).');
    sending = true; ui.send.disabled = true;
    call('POST', '/send', { text: text }).then(function (r) {
      sending = false;
      if (r.status === 401) return signOut();
      if (r.data && r.data.ok) { ui.text.value = ''; note(NOTE_IN); busy = 'queued'; start(); }
      else hint((r.data && r.data.error) || '보내지 못했습니다.');
      return refresh();
    }, function () { sending = false; ui.send.disabled = false; hint('보내지 못했습니다. 연결을 확인해 주세요.'); });
  }

  function tick() {
    timer = null;
    if (!opened || !token) return;
    var wait = busy ? 4000 : 15000;
    if (document.hidden) { timer = setTimeout(tick, wait); return; }
    refresh().then(function () { if (opened && token && !timer) timer = setTimeout(tick, busy ? 4000 : 15000); });
  }
  function start() { stop(); timer = setTimeout(tick, 3000); }
  function stop() { if (timer) { clearTimeout(timer); timer = null; } }

  function show() {
    if (!panel) build();
    opened = true; panel.hidden = false; btn.classList.add('on'); mode();
    if (token) { refresh(); start(); ui.text.focus(); } else ui.pin.focus();
  }
  function hide() { opened = false; if (panel) panel.hidden = true; btn.classList.remove('on'); stop(); }
  btn.addEventListener('click', function () { if (opened) hide(); else show(); });
  btn.hidden = false;
})();
