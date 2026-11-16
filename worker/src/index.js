/* AI 오피스 실시간 채널.
   GET  /status  누구나 읽기(이미 비식별 처리된 JSON 만 보관)
   POST /status  PC 감시 스크립트만 쓰기(Authorization: Bearer <PUSH_TOKEN>)
   쓰기는 여기서도 한 번 더 검사한다: 크기·형식·식별 패턴이 하나라도 걸리면 저장하지 않는다. */

const MAX_BYTES = 60000;
const MAX_TEXT = 80;
const TS_FIELDS = new Set(['updated_at', 'last_active', 'time']);
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/;
const TOP_KEYS = new Set(['updated_at', 'source', 'summary', 'agents', 'cast', 'logs', 'events']);
/* tools/pc_watch.py 의 MASK_RULES 와 같은 규칙 */
const LEAK_RULES = [
  ['url', /\b(?:https?|ftp|file):\/\/\S+|\bwww\.\S+/i],
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['winpath', /(?<![A-Za-z])[a-z]:[\\/][^\s"'<>|]*|\\\\[^\s"'<>|]+|%[A-Za-z_]+%[\\/][^\s"'<>|]*/i],
  ['unixpath', /(?<![\w.])~?\/(?:[\w.\-]+\/)+[\w.\-]*/],
  ['apikey', /\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[abprs]|AKIA|AIza)[-_A-Za-z0-9]{12,}|\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b|(?<![A-Za-z0-9_\-])[A-Za-z0-9_\-]{28,}(?![A-Za-z0-9_\-])/],
  ['ip', /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/],
  ['phone', /(?<!\d)(?:\+?82[-\s.]?)?0?1[016789][-\s.]?\d{3,4}[-\s.]?\d{4}(?!\d)|(?<!\d)0\d{1,2}[-\s.]\d{3,4}[-\s.]\d{4}(?!\d)/],
  ['account', /(?<!\d)\d{2,6}-\d{2,6}-\d{2,8}(?:-\d{1,4})?(?!\d)/],
  ['money', /[₩$€¥]\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:천|만|억|조))?|\d[\d,]*(?:\.\d+)?\s?(?:천|백만|천만|만|억|조)?\s?(?:원|달러|USD|KRW|엔|유로)|\d[\d,]*(?:\.\d+)?\s?(?:백만|천만|만|억|조)(?![가-힣])/],
  ['address', /[가-힣]{1,8}(?:시|도|군|구)\s[가-힣0-9]{1,10}(?:로|길|동|읍|면)\s?\d+(?:-\d+)?(?:번길)?/],
  ['userid', /(?<![A-Za-z0-9])[A-Za-z][A-Za-z_]{1,15}\d{3,}[A-Za-z0-9_]*(?![A-Za-z0-9])/],
  ['longnum', /(?<!\d)\d{7,}(?!\d)/],
];

export function findLeak(v, key, depth) {
  if (depth > 6) return 'depth';
  if (Array.isArray(v)) {
    if (v.length > 80) return 'list-size';
    for (const x of v) { const r = findLeak(x, key, depth + 1); if (r) return r; }
    return null;
  }
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) {
      if (k.length > 24 || !/^[a-z_]+$/.test(k)) return 'key';
      const r = findLeak(v[k], k, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (typeof v === 'string') {
    if (TS_FIELDS.has(key)) return v === '' || TS_RE.test(v) ? null : 'timestamp';
    if (v.length > MAX_TEXT) return 'text-size';
    for (const [name, rx] of LEAK_RULES) if (rx.test(v)) return name;
    return null;
  }
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return null;
  return 'type';
}

function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
      'access-control-allow-origin': '*' }, extra || {}),
  });
}

function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/status') return json({ error: 'not found' }, 404);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET', 'access-control-max-age': '86400' } });
    }
    const stub = env.STATE.get(env.STATE.idFromName('office'));
    if (request.method === 'GET') return stub.fetch('https://do/status');
    if (request.method !== 'POST') return json({ error: 'method' }, 405);
    const auth = request.headers.get('authorization') || '';
    if (!sameToken(auth.replace(/^Bearer\s+/i, ''), (env.PUSH_TOKEN || '').trim())) return json({ error: 'unauthorized' }, 401);
    const body = await request.text();
    if (body.length > MAX_BYTES) return json({ error: 'too large' }, 413);
    let data;
    try { data = JSON.parse(body); } catch (e) { return json({ error: 'bad json' }, 400); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return json({ error: 'bad shape' }, 422);
    for (const k of Object.keys(data)) if (!TOP_KEYS.has(k)) return json({ error: 'unknown key' }, 422);
    if (data.source !== 'pc' || typeof data.updated_at !== 'string' || !TS_RE.test(data.updated_at)) return json({ error: 'bad header' }, 422);
    const leak = findLeak(data, null, 0);
    if (leak) return json({ error: 'rejected', rule: leak }, 422);
    return stub.fetch('https://do/status', { method: 'PUT', body: JSON.stringify(data) });
  },
};

export class OfficeState {
  constructor(ctx) { this.ctx = ctx; this.value = undefined; }
  async fetch(request) {
    if (request.method === 'PUT') {
      this.value = await request.text();
      await this.ctx.storage.put('status', this.value);
      return json({ ok: true });
    }
    if (this.value === undefined) this.value = (await this.ctx.storage.get('status')) || '';
    if (!this.value) return json({ error: 'empty' }, 404);
    return new Response(this.value, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' } });
  }
}
