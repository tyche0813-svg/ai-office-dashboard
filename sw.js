/* AI 오피스 서비스 워커.
   - 앱 껍데기(화면 파일·아이콘): 온라인이면 항상 새로 받고, 받지 못할 때만 저장해 둔 것으로 연다(오프라인 실행).
   - data/*.json: 항상 네트워크 먼저. 실패하면 마지막으로 받은 것(화면이 '갱신 지연'으로 표시).
   - 실시간 채널(다른 주소의 Worker /status): 손대지 않는다. 저장도 하지 않는다. */
const CACHE = 'ai-office-shell-v4';
const SHELL = [
  './', 'index.html', 'manifest.json', 'data/pc-status.json', 'data/notion-agents.json', 'assets/style.css', 'assets/app.js', 'assets/office-bg.jpg',
  'assets/app/icon-192.png', 'assets/app/icon-512.png', 'assets/app/favicon.png',
  'assets/icons/claude.png', 'assets/icons/muse.png', 'assets/icons/aside.png', 'assets/icons/exaone.png',
  'assets/icons/azure.png', 'assets/icons/copilot.png', 'assets/icons/openai.png', 'assets/icons/stability.png', 'assets/icons/pally.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;            /* 실시간 채널 등 다른 주소는 그대로 통과 */
  event.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        const key = url.origin + url.pathname;                 /* ?t= ?v= 꼬리표는 떼고 한 벌만 저장 */
        caches.open(CACHE).then((c) => c.put(key, copy));
      }
      return res;
    }).catch(() => caches.match(url.origin + url.pathname).then((hit) => {
      if (hit) {                                               /* 저장본으로 답했다는 표시(화면이 '오프라인' 안내를 띄운다) */
        const headers = new Headers(hit.headers);
        headers.set('x-aio-offline', '1');
        return hit.blob().then((body) => new Response(body, { status: hit.status, statusText: hit.statusText, headers }));
      }
      if (req.mode === 'navigate') return caches.match(new URL('index.html', self.registration.scope).href);
      return Response.error();
    }))
  );
});
