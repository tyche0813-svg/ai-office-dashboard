/* AI 오피스 '지시' 대화창 — 대표님(휴대폰·PC 브라우저) ↔ PC 의 Claude.
   지시와 답은 이 Durable Object(SQLite) 안에만 있다. 공개 /status, data/*.json, 저장소에는 절대 쓰지 않는다.

   휴대폰:  POST /chat/login {pin}  →  세션 토큰(브라우저 localStorage 에 보관, 이후 Authorization: Bearer <세션>)
            GET  /chat/messages?after=<id>     POST /chat/send {text}     POST /chat/cancel {id}
            POST /chat/clear                   POST /chat/logout
   PC 작업기(Authorization: Bearer <CHAT_PC_TOKEN>):
            GET  /chat/pc/next                 POST /chat/pc/result {id, ok, text}

   비밀값(Cloudflare Secret, 사용자가 직접 넣는다): APP_PIN(6자 이상), CHAT_PC_TOKEN(21자 이상).
   쿠키를 쓰지 않는 이유: 화면(github.io)과 이 Worker(workers.dev)는 서로 다른 사이트라 쿠키가 '서드파티 쿠키'가 되고,
   iOS Safari·삼성 인터넷·시크릿 창 등은 이를 기본으로 막는다. 그래서 로그인 뒤 무작위 세션 토큰을 내려 주고 헤더로 받는다.
   세션 토큰은 여기에는 SHA-256 해시로만 저장하며 30일 뒤 만료, 로그아웃하면 바로 지운다. */

export const CHAT_ORIGIN = 'https://tyche0813-svg.github.io';
const MAX_TEXT = 2000;            /* 지시 한 건 글자 수 */
const MAX_REPLY = 12000;          /* 답 한 건 글자 수 */
const KEEP = 200;                 /* 보관하는 메시지 수 */
const SESSION_MS = 30 * 86400e3;
const STALE_MS = 20 * 60e3;       /* 처리 중 상태가 이보다 오래되면 실패로 돌린다(작업기 시간 제한 15분 + 여유) */
const PC_ALIVE_MS = 60e3;
const IP_FAILS = 5, IP_WINDOW_MS = 15 * 60e3;        /* 같은 주소에서 15분에 5번 틀리면 잠금 */
const ALL_FAILS = 30, ALL_WINDOW_MS = 24 * 3600e3;   /* 전체 24시간에 30번 틀리면 새 로그인 잠금(이미 로그인한 기기는 계속 사용) */
const MIN_PIN = 6, MIN_PC_TOKEN = 21;

/* 답에 섞여 들어온 긴 토큰을 한 번 더 가린다(작업기도 올리기 전에 같은 일을 한다). */
const SECRET_RULES = [
  /\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[abprs]|AKIA|AIza)[-_A-Za-z0-9]{12,}/g,
  /\bBearer\s+[A-Za-z0-9._~+\/=-]{12,}/gi,
  /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g,
];
export function maskSecrets(s) {
  let out = String(s);
  for (const rx of SECRET_RULES) out = out.replace(rx, '[가림]');
  return out;
}

export function sameText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function chatCors(request) {
  const h = { vary: 'Origin' };
  if ((request.headers.get('origin') || '') === CHAT_ORIGIN) {
    h['access-control-allow-origin'] = CHAT_ORIGIN;
    h['access-control-allow-headers'] = 'authorization, content-type';
    h['access-control-allow-methods'] = 'GET, POST, OPTIONS';
    h['access-control-max-age'] = '600';
  }
  return h;
}

const json = (obj, status) => new Response(JSON.stringify(obj), {
  status: status || 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha = async (s) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
const bearer = (req) => (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();

/* Worker 입구: 출처 검사·CORS 를 붙이고 Durable Object 로 넘긴다. */
export async function handleChat(request, env) {
  const url = new URL(request.url);
  const cors = chatCors(request);
  const wrap = (res) => { const h = new Headers(res.headers); for (const k of Object.keys(cors)) h.set(k, cors[k]); return new Response(res.body, { status: res.status, headers: h }); };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  const origin = request.headers.get('origin');
  const isPc = url.pathname.startsWith('/chat/pc/');
  /* 브라우저가 보낸 요청은 허용한 화면 주소에서 온 것만 받는다. PC 작업기는 Origin 헤더가 없다. */
  if (origin && (isPc || origin !== CHAT_ORIGIN)) return wrap(json({ error: 'origin' }, 403));
  if (!env.CHAT) return wrap(json({ error: 'not ready' }, 503));
  return wrap(await env.CHAT.get(env.CHAT.idFromName('room')).fetch(request));
}

export class ChatRoom {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sessions(h TEXT PRIMARY KEY, created INTEGER, last INTEGER);
      CREATE TABLE IF NOT EXISTS msgs(id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT, text TEXT, status TEXT, ref INTEGER, ts INTEGER, started INTEGER);
      CREATE TABLE IF NOT EXISTS fails(ip TEXT, ts INTEGER);
      CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);`);
  }
  q(s, ...a) { return this.sql.exec(s, ...a).toArray(); }
  one(s, ...a) { return this.q(s, ...a)[0] || null; }
  kvGet(k) { const r = this.one('SELECT v FROM kv WHERE k = ?', k); return r ? r.v : null; }
  kvSet(k, v) { this.sql.exec('INSERT INTO kv(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, String(v)); }

  pin() { return String(this.env.APP_PIN || '').trim(); }
  pcOk(req) { const k = String(this.env.CHAT_PC_TOKEN || '').trim(); return k.length >= MIN_PC_TOKEN && sameText(bearer(req), k); }
  async phoneOk(req) {
    const t = bearer(req);
    if (t.length < 32) return false;
    const h = await sha(t), now = Date.now();
    const row = this.one('SELECT created FROM sessions WHERE h = ?', h);
    if (!row) return false;
    if (now - row.created > SESSION_MS) { this.sql.exec('DELETE FROM sessions WHERE h = ?', h); return false; }
    this.sql.exec('UPDATE sessions SET last = ? WHERE h = ?', now, h);
    return true;
  }
  pcState() { const ts = +(this.kvGet('pc_seen') || 0); return { alive: !!ts && Date.now() - ts < PC_ALIVE_MS }; }
  reply(ref, text) { this.sql.exec("INSERT INTO msgs(role, text, status, ref, ts) VALUES('assistant', ?, '', ?, ?)", text, ref, Date.now()); }
  /* 작업기가 답을 못 올리고 사라진 지시는 실패로 닫는다(다음 지시가 막히지 않게). */
  sweep() {
    const old = this.q("SELECT id FROM msgs WHERE role = 'user' AND status = 'processing' AND started < ?", Date.now() - STALE_MS);
    for (const r of old) {
      this.sql.exec("UPDATE msgs SET status = 'failed' WHERE id = ?", r.id);
      this.reply(r.id, '시간 안에 답이 오지 않아 중단했습니다. PC 작업기 상태를 확인한 뒤 다시 보내 주세요.');
    }
    this.sql.exec('DELETE FROM msgs WHERE id <= (SELECT COALESCE(MAX(id), 0) FROM msgs) - ?', KEEP);
  }
  view(after) {
    this.sweep();
    const rows = after > 0
      ? this.q('SELECT id, role, text, status, ref, ts FROM msgs WHERE id > ? ORDER BY id LIMIT 80', after)
      : this.q('SELECT id, role, text, status, ref, ts FROM (SELECT * FROM msgs ORDER BY id DESC LIMIT 60) ORDER BY id');
    const states = this.q("SELECT id, status FROM msgs WHERE role = 'user' ORDER BY id DESC LIMIT 20");
    const open = this.one("SELECT id, status FROM msgs WHERE role = 'user' AND status IN ('queued', 'processing') ORDER BY id LIMIT 1");
    return { ok: true, messages: rows, states, busy: open ? open.status : '', pc: this.pcState(), max_text: MAX_TEXT };
  }

  async fetch(request) {
    const url = new URL(request.url), p = url.pathname, M = request.method;

    /* ---------------- PC 작업기 ---------------- */
    if (p.startsWith('/chat/pc/')) {
      if (!this.pcOk(request)) return json({ error: 'unauthorized' }, 401);
      this.kvSet('pc_seen', Date.now());
      if (p === '/chat/pc/next' && M === 'GET') {
        this.sweep();
        /* 동시 처리 1건: 처리 중인 것이 있으면 그것만 다시 알려 준다(resumed). 작업기는 이 경우 다시 실행하지 않고 실패로 닫는다. */
        const cur = this.one("SELECT id, text, ts FROM msgs WHERE role = 'user' AND status = 'processing' ORDER BY id LIMIT 1");
        if (cur) return json({ job: { id: cur.id, text: cur.text, ts: cur.ts, resumed: true } });
        const nx = this.one("SELECT id, text, ts FROM msgs WHERE role = 'user' AND status = 'queued' ORDER BY id LIMIT 1");
        if (!nx) return json({ job: null });
        this.sql.exec("UPDATE msgs SET status = 'processing', started = ? WHERE id = ?", Date.now(), nx.id);
        return json({ job: { id: nx.id, text: nx.text, ts: nx.ts, resumed: false } });
      }
      if (p === '/chat/pc/result' && M === 'POST') {
        const b = await request.json().catch(() => ({}));
        const id = +b.id || 0;
        const row = this.one("SELECT status FROM msgs WHERE id = ? AND role = 'user'", id);
        if (!row) return json({ error: 'no job' }, 404);
        if (row.status !== 'processing') return json({ ok: true, ignored: true });
        const text = maskSecrets(String(b.text || '').trim()).slice(0, MAX_REPLY) || (b.ok ? '(빈 답)' : '처리하지 못했습니다.');
        this.sql.exec('UPDATE msgs SET status = ? WHERE id = ?', b.ok ? 'done' : 'failed', id);
        this.reply(id, text);
        return json({ ok: true });
      }
      return json({ error: 'not found' }, 404);
    }

    /* ---------------- 로그인 ---------------- */
    if (p === '/chat/login' && M === 'POST') {
      const pin = this.pin();
      if (!pin) return json({ ok: false, error: 'PIN이 아직 설정되지 않았습니다. Cloudflare에서 APP_PIN을 넣어 주세요.' }, 503);
      if (pin.length < MIN_PIN) return json({ ok: false, error: 'PIN이 너무 짧습니다. APP_PIN을 6자 이상으로 다시 넣어 주세요.' }, 503);
      const now = Date.now(), ip = request.headers.get('cf-connecting-ip') || 'x';
      this.sql.exec('DELETE FROM fails WHERE ts < ?', now - ALL_WINDOW_MS);
      const mine = this.one('SELECT COUNT(*) AS n FROM fails WHERE ip = ? AND ts > ?', ip, now - IP_WINDOW_MS).n;
      const all = this.one('SELECT COUNT(*) AS n FROM fails').n;
      if (mine >= IP_FAILS) return json({ ok: false, error: '여러 번 틀려 15분 동안 잠겼습니다.' }, 429);
      if (all >= ALL_FAILS) return json({ ok: false, error: '잘못된 시도가 많아 새 로그인을 하루 동안 막았습니다.' }, 429);
      const b = await request.json().catch(() => ({}));
      if (!sameText(String(b.pin || '').trim(), pin)) {
        this.sql.exec('INSERT INTO fails(ip, ts) VALUES(?, ?)', ip, now);
        return json({ ok: false, error: 'PIN이 맞지 않습니다.' }, 401);
      }
      this.sql.exec('DELETE FROM fails WHERE ip = ?', ip);
      this.sql.exec('DELETE FROM sessions WHERE created < ?', now - SESSION_MS);
      const token = hex(crypto.getRandomValues(new Uint8Array(32)));
      this.sql.exec('INSERT INTO sessions(h, created, last) VALUES(?, ?, ?)', await sha(token), now, now);
      return json({ ok: true, token });
    }

    if (!(await this.phoneOk(request))) return json({ error: 'unauthorized' }, 401);

    if (p === '/chat/messages' && M === 'GET') return json(this.view(Math.max(0, +url.searchParams.get('after') || 0)));
    if (M !== 'POST') return json({ error: 'not found' }, 404);
    const b = await request.json().catch(() => ({}));
    if (p === '/chat/send') {
      const text = String(b.text || '').replace(/\r\n?/g, '\n').trim();
      if (!text) return json({ ok: false, error: '지시 내용을 적어 주세요.' }, 400);
      if (text.length > MAX_TEXT) return json({ ok: false, error: '지시는 ' + MAX_TEXT + '자까지 보낼 수 있습니다.' }, 413);
      this.sweep();
      if (this.one("SELECT id FROM msgs WHERE role = 'user' AND status IN ('queued', 'processing') LIMIT 1")) {
        return json({ ok: false, error: '앞 지시를 처리하고 있습니다. 끝난 뒤에 보내 주세요.' }, 409);
      }
      this.sql.exec("INSERT INTO msgs(role, text, status, ref, ts) VALUES('user', ?, 'queued', 0, ?)", text, Date.now());
      return json({ ok: true, id: this.one('SELECT MAX(id) AS id FROM msgs').id, pc: this.pcState() });
    }
    if (p === '/chat/cancel') {
      const row = this.one("SELECT status FROM msgs WHERE id = ? AND role = 'user'", +b.id || 0);
      if (!row || row.status !== 'queued') return json({ ok: false, error: '대기 중인 지시만 취소할 수 있습니다.' }, 409);
      this.sql.exec("UPDATE msgs SET status = 'canceled' WHERE id = ?", +b.id);
      return json({ ok: true });
    }
    if (p === '/chat/clear') {
      if (this.one("SELECT id FROM msgs WHERE role = 'user' AND status = 'processing' LIMIT 1")) return json({ ok: false, error: '처리 중인 지시가 끝난 뒤에 지울 수 있습니다.' }, 409);
      this.sql.exec('DELETE FROM msgs');
      return json({ ok: true });
    }
    if (p === '/chat/logout') {
      this.sql.exec('DELETE FROM sessions WHERE h = ?', await sha(bearer(request)));
      return json({ ok: true });
    }
    return json({ error: 'not found' }, 404);
  }
}
