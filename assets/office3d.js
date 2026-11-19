/* AI 오피스 — 3D 사무실(Three.js r160, assets/vendor 에 같이 둠). 모델 파일 없이 박스·원기둥·구로만 만든다.
   무엇을 하는지는 app.js 가 넘겨 준 실제 상태·사건대로만 움직인다:
   - working → 자기 책상에 앉아 타이핑(+ 작업 말풍선)   - resting → 소파·1인 소파·바 의자   - offline → 자리에서 어둡게 엎드림
   - 사건 dispatch/report → 보낸 쪽이 받는 쪽 자리로 걸어가 둘이 서서 이야기하고 돌아옴   - 사건 meeting → 원형 탁자에 모였다 흩어짐
   - idle 만: 가끔(40초~4분, 무작위) 일어나 잠깐 걷거나 탕비실에서 커피를 마시고 돌아온다. 이 연출에는 말풍선이 없다.
   가상의 사무실이며 실제 장소·상표를 본뜨지 않았다. */
import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { mergeGeometries } from './vendor/BufferGeometryUtils.js';

const FX = 12, FZ = 8, WH = 3.3;                 /* 바닥 반폭(m), 벽 높이 */
const CS = 0.4, GW = Math.round(FX * 2 / CS), GH = Math.round(FZ * 2 / CS);
const WALK = 2.3;                                /* 걷는 속도(m/s) */
const HIP = 0.32;

function rng(seed) { let s = seed >>> 0; return function () { s += 0x6D2B79F5; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function dampAngle(cur, target, k) { const P = Math.PI * 2; const d = (((target - cur + Math.PI) % P) + P) % P - Math.PI; return cur + d * k; }
function shade(hex, f) { const c = new THREE.Color(hex); c.multiplyScalar(f); return c; }

function create(opts) {
  const pane = opts.pane, rand = rng(1119), mobile = (window.matchMedia && window.matchMedia('(pointer:coarse)').matches) || Math.min(window.innerWidth, window.innerHeight) < 560;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  const canvas = renderer.domElement;
  canvas.className = 'stage3d';
  canvas.setAttribute('aria-label', 'AI 사무실 3D 화면');
  const labels = document.createElement('div');
  labels.className = 'labels3d';
  pane.insertBefore(labels, pane.firstChild);
  pane.insertBefore(canvas, pane.firstChild);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#3a302b');
  const camera = new THREE.PerspectiveCamera(26, 1, 1, 220);

  /* ---------- 조명: 따뜻한 호박색 ---------- */
  scene.add(new THREE.AmbientLight('#ffdcae', 0.95));
  scene.add(new THREE.HemisphereLight('#fff1d6', '#8a5a34', 0.75));
  const sun = new THREE.DirectionalLight('#ffd49a', 2.5);
  sun.position.set(-10, 17, -9); sun.target.position.set(1.5, 0, 1.5);
  sun.castShadow = true;
  const sm = mobile ? 1024 : 2048;
  sun.shadow.mapSize.set(sm, sm);
  const sc = sun.shadow.camera; sc.left = -17; sc.right = 17; sc.top = 14; sc.bottom = -14; sc.near = 2; sc.far = 50;
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.035; sun.shadow.radius = mobile ? 2 : 3.5;
  scene.add(sun); scene.add(sun.target);
  function lamp(x, y, z, power, dist) { const l = new THREE.PointLight('#ffb463', power, dist, 1.6); l.position.set(x, y, z); scene.add(l); }

  /* ---------- 고정 물체: 꼭짓점 색으로 한 덩어리 ---------- */
  const solid = [], glow = [], glassG = [], blocked = new Uint8Array(GW * GH);
  function paint(g, color) {
    const c = color.isColor ? color : new THREE.Color(color), n = g.attributes.position.count, arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return g;
  }
  function put(list, g, color, x, y, z, ry) { if (ry) g.rotateY(ry); g.translate(x, y, z); list.push(paint(g, color)); }
  function bx(w, h, d, x, y, z, color, ry, list) { put(list || solid, new THREE.BoxGeometry(w, h, d), color, x, y + h / 2, z, ry); }
  function cy(rt, rb, h, x, y, z, color, seg, list) { put(list || solid, new THREE.CylinderGeometry(rt, rb, h, seg || 14), color, x, y + h / 2, z, 0); }
  function sp(r, x, y, z, color, sx, sy, sz, list) { const g = new THREE.SphereGeometry(r, 12, 9); g.scale(sx || 1, sy || 1, sz || 1); put(list || solid, g, color, x, y, z, 0); }
  function block(x0, z0, x1, z1, pad) {
    const p = pad == null ? 0.26 : pad;
    for (let gz = 0; gz < GH; gz++) for (let gx = 0; gx < GW; gx++) {
      const cx = -FX + (gx + 0.5) * CS, cz = -FZ + (gz + 0.5) * CS;
      if (cx > x0 - p && cx < x1 + p && cz > z0 - p && cz < z1 + p) blocked[gz * GW + gx] = 1;
    }
  }

  const C = { wall: '#f1dcbd', wallD: '#d9bf9b', wood: '#b9824c', woodD: '#7d5333', woodL: '#d6a66f', part: '#d9cdb6', metal: '#4b443d', dark: '#2c2723',
    white: '#f6efe4', green: '#6c7a55', greenD: '#55633f', tan: '#c08c58', tanD: '#9c6c3f', leaf: '#5d8a44', leafD: '#3f6a34', pot: '#d8c8ae', rug: '#e2cfa9', rugD: '#cdb489', brass: '#8a6a3a' };

  /* 바닥(나무 널) */
  (function floor() {
    const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 512;
    const g = cv.getContext('2d'), r = rng(7);
    g.fillStyle = '#c58d53'; g.fillRect(0, 0, 1024, 512);
    for (let row = 0; row < 16; row++) {
      let x = -r() * 200;
      while (x < 1024) {
        const w = 180 + r() * 220, t = 0.9 + r() * 0.2;
        g.fillStyle = 'rgb(' + Math.round(200 * t) + ',' + Math.round(144 * t) + ',' + Math.round(86 * t) + ')';
        g.fillRect(x, row * 32, w, 32);
        g.fillStyle = 'rgba(90,52,22,.35)'; g.fillRect(x + w - 1, row * 32, 2, 32);
        x += w;
      }
      g.fillStyle = 'rgba(90,52,22,.3)'; g.fillRect(0, row * 32, 1024, 1.5);
    }
    const tx = new THREE.CanvasTexture(cv); tx.wrapS = tx.wrapT = THREE.RepeatWrapping; tx.repeat.set(5, 6.5); tx.colorSpace = THREE.SRGBColorSpace;
    tx.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
    const m = new THREE.Mesh(new THREE.PlaneGeometry(FX * 2, FZ * 2), new THREE.MeshLambertMaterial({ map: tx }));
    m.rotation.x = -Math.PI / 2; m.receiveShadow = true; scene.add(m);
    bx(FX * 2 + 0.6, 0.5, FZ * 2 + 0.6, 0, -0.51, 0, C.wallD);
    bx(FX * 2 + 0.3, 0.22, 0.15, 0.075, 0, FZ + 0.075, C.wall);
    bx(0.15, 0.22, FZ * 2 + 0.3, FX + 0.075, 0, 0.075, C.wall);
  })();

  /* 창밖: 단순한 그라데이션 하늘과 건물 실루엣(가상의 도시) */
  const cityTex = (function () {
    const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 256;
    const g = cv.getContext('2d'), r = rng(31), gr = g.createLinearGradient(0, 0, 0, 256);
    gr.addColorStop(0, '#ffe2b0'); gr.addColorStop(0.55, '#ffeccb'); gr.addColorStop(1, '#f7cf99');
    g.fillStyle = gr; g.fillRect(0, 0, 1024, 256);
    [['#f0cfa2', 150, 70], ['#dcb080', 110, 60], ['#c59465', 70, 50]].forEach(function (L) {
      let x = -10; g.fillStyle = L[0];
      while (x < 1024) { const w = 26 + r() * 50, h = L[1] * (0.45 + r() * 0.75); g.fillRect(x, 256 - h, w, h); x += w + r() * 14; }
    });
    const t = new THREE.CanvasTexture(cv); t.wrapS = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  function wallRun(alongX, a0, a1, win) {
    const len = a1 - a0, mid = (a0 + a1) / 2, off = -(alongX ? FZ : FX) - 0.15;
    const B = function (l, h, y, color, t, o) { if (alongX) bx(l, h, t || 0.3, mid, y, off + (o || 0), color); else bx(t || 0.3, h, l, off + (o || 0), y, mid, color); };
    if (!win) { B(len, WH, 0, C.wall); return; }
    B(len, 0.7, 0, C.wall); B(len, WH - 2.8, 2.8, C.wall);
    B(len, 0.05, 0.7, C.metal, 0.34); B(len, 0.06, 2.74, C.metal, 0.34);
    const n = Math.max(1, Math.round(len / 1.3));
    for (let i = 0; i <= n; i++) { const p = a0 + len * i / n; if (alongX) bx(0.07, 2.1, 0.34, p, 0.7, off, C.metal); else bx(0.34, 2.1, 0.07, off, 0.7, p, C.metal); }
    const g = new THREE.PlaneGeometry(len, 2.1), uv = g.attributes.uv, u0 = rand();
    for (let i = 0; i < uv.count; i++) uv.setX(i, u0 + uv.getX(i) * len / 14);
    if (!alongX) g.rotateY(Math.PI / 2);
    g.translate(alongX ? mid : off, 1.75, alongX ? off : mid);
    glassG.push(g);
  }
  wallRun(true, -FX - 0.3, -11.2, false); wallRun(true, -11.2, -6.2, true); wallRun(true, -6.2, 0.9, false);
  wallRun(true, 0.9, 5.3, true); wallRun(true, 5.3, FX, false);
  wallRun(false, -FZ, -3.2, false); wallRun(false, -3.2, 6.6, true); wallRun(false, 6.6, FZ, false);

  /* ---------- 가구 ---------- */
  function chair(x, z, ry, color) {
    const fx = Math.sin(ry), fz = Math.cos(ry);
    cy(0.25, 0.27, 0.04, x, 0.02, z, C.dark); cy(0.035, 0.035, 0.34, x, 0.05, z, C.metal, 8);
    cy(0.25, 0.23, 0.09, x, 0.37, z, color);
    bx(0.46, 0.5, 0.08, x - fx * 0.25, 0.44, z - fz * 0.25, color, ry);
  }
  const screens = {};
  function screen(id, w, h, x, y, z, ry) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: '#1b1f26' }));
    m.position.set(x, y, z); m.rotation.y = ry; scene.add(m);
    if (id) (screens[id] = screens[id] || []).push(m);
  }
  function desk(id, x, z, w, top) {
    const zc = z + 0.78;
    bx(w, 0.05, 0.82, x, 0.71, zc, top || C.wood);
    bx(0.05, 0.71, 0.76, x - w / 2 + 0.04, 0, zc, C.woodD); bx(0.05, 0.71, 0.76, x + w / 2 - 0.04, 0, zc, C.woodD);
    bx(0.42, 0.52, 0.62, x + w / 2 - 0.28, 0.17, zc + 0.04, C.woodD);
    bx(w + 0.06, 0.74, 0.05, x, 0.3, zc + 0.44, C.part);
    bx(0.05, 0.3, 0.6, x - w / 2 - 0.01, 0.76, zc + 0.14, C.part); bx(0.05, 0.3, 0.6, x + w / 2 + 0.01, 0.76, zc + 0.14, C.part);
    const mons = w > 1.9 ? [-0.36, 0.36] : [0];
    mons.forEach(function (o) {
      bx(0.24, 0.02, 0.16, x + o, 0.76, zc + 0.2, C.metal); bx(0.06, 0.14, 0.05, x + o, 0.78, zc + 0.2, C.metal);
      bx(0.64, 0.4, 0.04, x + o, 0.88, zc + 0.2, C.dark);
      screen(id, 0.58, 0.34, x + o, 1.08, zc + 0.178, Math.PI);
    });
    bx(0.42, 0.02, 0.14, x, 0.76, zc - 0.2, C.white); bx(0.06, 0.02, 0.09, x + 0.34, 0.76, zc - 0.2, C.white);
    const k = rand();
    if (k < 0.4) { cy(0.045, 0.04, 0.09, x - w / 2 + 0.2, 0.76, zc - 0.05, C.white, 10); }
    else if (k < 0.75) { cy(0.07, 0.055, 0.1, x - w / 2 + 0.22, 0.76, zc + 0.1, C.pot, 10); sp(0.1, x - w / 2 + 0.22, 0.94, zc + 0.1, C.leaf, 1, 0.9, 1); }
    else { bx(0.24, 0.03, 0.32, x - w / 2 + 0.26, 0.76, zc - 0.05, C.white, 0.2); }
    chair(x, z, 0, C.metal);
    block(x - w / 2, z - 0.28, x + w / 2, zc + 0.47);
    return { x: x, z: z, ry: 0, sit: true, h: 0.46, ax: x, az: z - 0.86, kind: 'desk' };
  }
  function plant(x, z, s, tall) {
    cy(0.2 * s, 0.15 * s, 0.34 * s, x, 0, z, C.pot, 12);
    const r = rng(Math.round((x + 20) * 37 + (z + 20) * 911)), n = tall ? 7 : 5, h0 = 0.34 * s;
    if (tall) cy(0.03 * s, 0.04 * s, 0.9 * s, x, h0, z, C.woodD, 6);
    for (let i = 0; i < n; i++) {
      const a = r() * 6.28, d = (0.08 + r() * 0.2) * s, y = h0 + (tall ? 0.6 + r() * 0.7 : 0.12 + r() * 0.35) * s;
      sp((0.17 + r() * 0.1) * s, x + Math.cos(a) * d, y, z + Math.sin(a) * d, r() < 0.5 ? C.leaf : C.leafD, 1, 0.8, 1);
    }
    block(x - 0.2 * s, z - 0.2 * s, x + 0.2 * s, z + 0.2 * s, 0.2);
  }
  function pendant(x, z, y) {
    cy(0.012, 0.012, WH + 0.6 - y, x, y, z, C.dark, 5);
    cy(0.06, 0.24, 0.2, x, y - 0.2, z, C.brass, 14);
    sp(0.085, x, y - 0.2, z, '#fff0c8', 1, 1, 1, glow);
  }
  function floorLamp(x, z) {
    cy(0.16, 0.18, 0.03, x, 0, z, C.dark); cy(0.02, 0.02, 1.45, x, 0.03, z, C.dark, 6);
    cy(0.17, 0.25, 0.34, x, 1.42, z, '#ffe9c4', 14, glow);
    block(x - 0.15, z - 0.15, x + 0.15, z + 0.15, 0.15);
  }
  function tv(w, h, x, y, z) {                   /* 남쪽을 보는 벽걸이 화면: 글자 없는 막대·선 도형만 */
    bx(w + 0.1, h + 0.1, 0.07, x, y, z, C.dark);
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 144;
    const g = cv.getContext('2d'), r = rng(Math.round(x * 13 + 99));
    g.fillStyle = '#16323a'; g.fillRect(0, 0, 256, 144);
    for (let i = 0; i < 7; i++) { const bh = 20 + r() * 70; g.fillStyle = i % 2 ? '#5fd6bb' : '#f6b756'; g.fillRect(22 + i * 31, 124 - bh, 18, bh); }
    g.fillStyle = 'rgba(255,255,255,.25)'; g.fillRect(14, 126, 228, 2);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: t }));
    m.position.set(x, y + h / 2 + 0.05, z + 0.04); scene.add(m);
  }

  /* 책상 줄(칸막이 책상 5 x 3 = 15석) + 총괄 자리 + 안내 데스크 2석 = 18석 */
  const HOME = {}, ROWS = [['opus', 'aside', 'muse', 'exaone', 'chatgpt'], ['fable', 'codex', 'speech', 'routine', null], ['claudeapi', 'copilot', 'stability', 'vooy', 'instinct']];
  ROWS.forEach(function (row, ri) {
    row.forEach(function (id, i) { const p = desk(id, -4.2 + i * 2.1, -1.2 + ri * 2.9, 1.6); if (id) HOME[id] = p; });
  });
  HOME.claude = desk('claude', -8.8, 0.3, 2.1, C.woodL);
  plant(-10.4, 1.1, 1.1, true);

  /* 대표 책상(북서쪽): 동쪽을 보고 앉는다 */
  const CEO_SEAT = { x: -10.1, z: -5.2, ry: Math.PI / 2, sit: true, h: 0.46 };
  (function ceoArea() {
    bx(0.95, 0.06, 2.4, -9.05, 0.72, -5.2, C.woodD); bx(0.85, 0.72, 0.06, -9.05, 0, -6.34, C.woodD); bx(0.85, 0.72, 0.06, -9.05, 0, -4.06, C.woodD);
    bx(0.06, 0.6, 2.3, -8.66, 0.12, -5.2, C.woodD);
    bx(0.04, 0.38, 0.6, -8.85, 0.9, -5.2, C.dark); bx(0.14, 0.12, 0.2, -8.85, 0.78, -5.2, C.metal);
    screen(null, 0.54, 0.32, -8.873, 1.09, -5.2, -Math.PI / 2);
    bx(0.14, 0.02, 0.4, -9.3, 0.78, -5.2, C.white); bx(0.3, 0.04, 0.22, -9.1, 0.78, -4.5, C.woodL, 0.3);
    cy(0.1, 0.12, 0.03, -9.0, 0.78, -6.0, C.brass); cy(0.015, 0.015, 0.3, -9.0, 0.8, -6.0, C.brass, 5); cy(0.09, 0.15, 0.17, -9.0, 1.08, -6.0, '#ffe2b0', 12, glow);
    chair(CEO_SEAT.x, CEO_SEAT.z, Math.PI / 2, C.tanD);
    bx(0.5, 0.75, 0.1, -10.42, 0.44, -5.2, C.tanD, Math.PI / 2);
    block(-10.5, -6.4, -8.6, -4.0);
    /* 책장(서쪽 벽) */
    bx(0.42, 2.3, 3.4, -11.76, 0, -5.9, C.woodD);
    const bc = ['#b5533c', '#3f6a6a', '#d9b25f', '#6b5a8a', '#ece3d2', '#7a8f5a'];
    for (let s = 0; s < 4; s++) {
      bx(0.36, 0.42, 3.2, -11.7, 0.25 + s * 0.52, -5.9, '#5e3d25'); let z = -7.42;
      while (z < -4.5) {
        const k = rand(), w = 0.07 + rand() * 0.07;
        if (k < 0.74) bx(0.22, 0.26 + rand() * 0.12, w, -11.58, 0.25 + s * 0.52, z + w / 2, bc[Math.floor(rand() * bc.length)]);
        else if (k < 0.84) { cy(0.07, 0.05, 0.14, -11.58, 0.25 + s * 0.52, z + 0.1, C.pot, 8); z += 0.14; }
        z += w + (k > 0.9 ? 0.25 : 0.012);
      }
    }
    block(-12, -7.6, -11.55, -4.2);
    floorLamp(-11.2, -3.5); plant(-11.2, -7.3, 1.25, true); plant(-7.0, -7.3, 1.2, true);
    bx(2.6, 0.02, 3.4, -9.6, 0.005, -5.2, C.rug);
  })();

  /* 원형 회의 탁자 + 의자 8 + 벽걸이 화면 */
  const MC = { x: -2.6, z: -5.0 }, MEET = [];
  (function meeting() {
    cy(3.0, 3.0, 0.02, MC.x, 0.003, MC.z, C.rug, 40); cy(2.75, 2.75, 0.02, MC.x, 0.008, MC.z, C.rugD, 40); cy(2.65, 2.65, 0.02, MC.x, 0.013, MC.z, C.rug, 40);
    cy(1.25, 1.25, 0.07, MC.x, 0.7, MC.z, C.wood, 32); cy(0.14, 0.2, 0.7, MC.x, 0, MC.z, C.woodD, 12); cy(0.55, 0.6, 0.05, MC.x, 0, MC.z, C.woodD, 20);
    cy(0.12, 0.09, 0.12, MC.x, 0.77, MC.z, C.pot, 10); sp(0.16, MC.x, 0.99, MC.z, C.leaf, 1, 0.8, 1);
    block(MC.x - 1.15, MC.z - 1.15, MC.x + 1.15, MC.z + 1.15, 0.15);
    [4, 3, 5, 2, 6, 1, 7, 0].forEach(function (i) {     /* 북쪽 의자(얼굴이 보이는 자리)부터 채운다 */
      const a = i * Math.PI / 4, sx = Math.sin(a), cz = Math.cos(a), x = MC.x + sx * 1.82, z = MC.z + cz * 1.82, ry = Math.atan2(-sx, -cz);
      chair(x, z, ry, C.green); block(x - 0.2, z - 0.2, x + 0.2, z + 0.2, 0.1);
      MEET.push({ x: x, z: z, ry: ry, sit: true, h: 0.46, ax: MC.x + sx * 2.62, az: MC.z + cz * 2.62, kind: 'meet' });
    });
    tv(2.5, 1.3, MC.x, 1.25, -FZ + 0.04);
    bx(2.2, 0.5, 0.42, MC.x, 0, -FZ + 0.26, C.woodD); block(MC.x - 1.1, -FZ, MC.x + 1.1, -FZ + 0.47, 0.15);
    pendant(MC.x, MC.z, 2.35); lamp(MC.x, 2.0, MC.z, 26, 9);
    plant(0.4, -7.3, 1.2, true);
  })();

  /* 탕비실(북동쪽): 조리대·커피머신·선반·자판기 + 바 탁자와 높은 의자 */
  const REST = [], COFFEE = [];
  (function pantry() {
    bx(4.6, 0.86, 0.62, 8.2, 0, -7.66, C.woodD); bx(4.7, 0.05, 0.68, 8.2, 0.86, -7.64, C.white);
    block(5.9, -FZ, 10.5, -7.35);
    bx(0.42, 0.46, 0.36, 7.0, 0.91, -7.66, C.dark); bx(0.3, 0.1, 0.1, 7.0, 1.05, -7.46, C.metal); cy(0.04, 0.035, 0.07, 7.0, 0.91, -7.42, C.white, 8);
    for (let i = 0; i < 4; i++) cy(0.045, 0.04, 0.08, 7.55 + i * 0.13, 0.91, -7.7, C.white, 8);
    bx(0.5, 0.03, 0.4, 9.2, 0.9, -7.62, C.metal); cy(0.02, 0.02, 0.26, 9.2, 0.91, -7.82, C.metal, 6); bx(0.04, 0.04, 0.16, 9.2, 1.15, -7.74, C.metal);
    bx(3.2, 0.05, 0.28, 8.0, 1.75, -7.84, C.woodL);
    [6.7, 7.2, 8.4, 9.3].forEach(function (x, i) { cy(0.07, 0.055, 0.12, x, 1.8, -7.84, i % 2 ? C.pot : C.white, 8); if (i % 2) sp(0.11, x, 2.0, -7.84, C.leaf, 1, 0.9, 1); });
    /* 자판기(상표 없음) */
    bx(0.95, 1.95, 0.8, 11.2, 0, -7.5, '#3b4046'); bx(0.74, 1.15, 0.04, 11.12, 0.66, -7.09, '#fff0cf', 0, glow);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 5; c++) cy(0.045, 0.045, 0.16, 10.85 + c * 0.135, 0.72 + r * 0.27, -7.05, ['#d86a4a', '#5fa08e', '#e9b54f', '#7d8fc0'][(r + c) % 4], 8);
    bx(0.5, 0.16, 0.05, 11.12, 0.28, -7.09, C.dark);
    block(10.7, -FZ, 11.7, -7.1);
    /* 바 */
    bx(3.9, 0.07, 0.55, 8.8, 1.0, -4.4, C.woodL); bx(0.08, 1.0, 0.45, 6.95, 0, -4.4, C.woodD); bx(0.08, 1.0, 0.45, 10.65, 0, -4.4, C.woodD);
    block(6.85, -4.68, 10.75, -4.12);
    [7.6, 8.8, 10.0].forEach(function (x) {
      cy(0.2, 0.2, 0.06, x, 0.66, -5.05, C.tan); cy(0.03, 0.03, 0.66, x, 0, -5.05, C.metal, 6); cy(0.2, 0.22, 0.03, x, 0, -5.05, C.metal);
      block(x - 0.18, -5.23, x + 0.18, -4.87, 0.1);
      REST.push({ x: x, z: -5.05, ry: 0, sit: true, h: 0.72, ax: x, az: -5.8, kind: 'rest' });
      pendant(x, -4.4, 2.3);
    });
    lamp(8.8, 1.9, -4.7, 22, 8);
    COFFEE.push({ x: 6.6, z: -6.5, ax: 6.6, az: -6.5, ry: 0.55, sit: false, kind: 'coffee' }, { x: 8.1, z: -6.5, ax: 8.1, az: -6.5, ry: 0.4, sit: false, kind: 'coffee' });
    plant(5.7, -7.3, 1.15, true); plant(11.3, -3.2, 1.2, true);
  })();

  /* 라운지(남서쪽): 소파·1인 소파 2·탁자·스탠드 조명 */
  (function lounge() {
    bx(3.6, 0.02, 4.6, -9.6, 0.004, 5.2, C.rug); bx(3.3, 0.02, 4.3, -9.6, 0.008, 5.2, C.rugD); bx(3.1, 0.02, 4.1, -9.6, 0.012, 5.2, C.rug);
    bx(0.95, 0.4, 3.1, -11.2, 0, 5.5, C.tan); bx(0.25, 0.55, 3.1, -11.62, 0.4, 5.5, C.tan); bx(0.95, 0.24, 0.22, -11.2, 0.4, 3.9, C.tan); bx(0.95, 0.24, 0.22, -11.2, 0.4, 7.1, C.tan);
    bx(0.3, 0.3, 0.12, -11.4, 0.42, 4.25, C.green, 0.25); bx(0.3, 0.3, 0.12, -11.4, 0.42, 6.8, C.woodL, -0.25);
    block(-12, 3.8, -10.75, 7.2, 0.2);
    [4.6, 5.5, 6.4].forEach(function (z) { REST.push({ x: -10.95, z: z, ry: Math.PI / 2, sit: true, h: 0.42, ax: -10.05, az: z, kind: 'rest' }); });
    bx(0.8, 0.06, 1.4, -8.95, 0.36, 5.5, C.wood); bx(0.7, 0.36, 1.3, -8.95, 0, 5.5, C.woodD);
    bx(0.26, 0.04, 0.34, -8.95, 0.42, 5.2, C.white, 0.3); cy(0.07, 0.055, 0.1, -8.95, 0.42, 5.95, C.pot, 8); sp(0.1, -8.95, 0.6, 5.95, C.leaf);
    block(-9.35, 4.8, -8.55, 6.2, 0.2);
    [-9.7, -8.4].forEach(function (x) {
      bx(0.78, 0.4, 0.72, x, 0, 3.4, C.green); bx(0.78, 0.5, 0.16, x, 0.4, 3.1, C.green); bx(0.12, 0.2, 0.72, x - 0.39, 0.4, 3.4, C.greenD); bx(0.12, 0.2, 0.72, x + 0.39, 0.4, 3.4, C.greenD);
      block(x - 0.4, 3.0, x + 0.4, 3.75, 0.12);
      REST.push({ x: x, z: 3.45, ry: 0, sit: true, h: 0.42, ax: x, az: 4.3, kind: 'rest' });
    });
    floorLamp(-11.3, 7.5); lamp(-10.9, 1.6, 7.2, 16, 7);
    plant(-11.3, 2.6, 1.2, true); plant(-7.2, 7.3, 1.1, false);
  })();

  /* 안내 데스크(남동쪽): 뒷벽에 화면, 비서 2석 */
  (function reception() {
    bx(3.6, 2.3, 0.16, 9.0, 0, 3.2, C.wall); bx(3.6, 0.08, 0.2, 9.0, 2.3, 3.2, C.woodD);
    tv(1.6, 0.85, 9.0, 1.15, 3.3);
    block(7.2, 3.1, 10.8, 3.3, 0.2);
    bx(3.9, 1.02, 0.42, 9.0, 0, 6.15, C.woodL); bx(4.0, 0.05, 0.56, 9.0, 1.02, 6.12, C.woodD);
    bx(0.42, 1.02, 1.1, 7.26, 0, 5.4, C.woodL); bx(0.42, 1.02, 1.1, 10.74, 0, 5.4, C.woodL);
    bx(3.2, 0.05, 0.6, 9.0, 0.72, 5.7, C.wood);
    bx(3.7, 0.06, 0.03, 9.0, 0.12, 6.37, '#ffdf9e', 0, glow);
    block(7.05, 5.35, 10.95, 6.4, 0.2);
    ['pickle', 'pally'].forEach(function (id, i) {
      const x = 8.3 + i * 1.4;
      chair(x, 5.0, 0, C.metal); block(x - 0.25, 4.75, x + 0.25, 5.3, 0.1);
      bx(0.5, 0.3, 0.03, x, 0.85, 5.78, C.dark); bx(0.2, 0.02, 0.12, x, 0.77, 5.78, C.metal); bx(0.05, 0.1, 0.04, x, 0.78, 5.78, C.metal);
      screen(id, 0.45, 0.25, x, 1.0, 5.762, Math.PI);
      HOME[id] = { x: x, z: 5.0, ry: 0, sit: true, h: 0.46, ax: x, az: 4.2, kind: 'desk' };
    });
    lamp(9.0, 2.0, 4.9, 18, 7); pendant(9.0, 5.0, 2.5);
    plant(11.4, 3.4, 1.2, true); plant(6.6, 6.9, 1.0, false);
  })();
  /* 가운데 남쪽: 화단 상자, 책상 줄 옆 화분 */
  bx(3.2, 0.5, 0.55, 1.2, 0, 7.3, C.woodD);
  for (let i = 0; i < 7; i++) sp(0.26 + rand() * 0.1, -0.2 + i * 0.47, 0.62 + rand() * 0.15, 7.3 + (rand() - 0.5) * 0.15, i % 2 ? C.leaf : C.leafD, 1, 0.9, 1);
  block(-0.4, 7.0, 2.8, 7.6);
  plant(-6.3, -2.6, 1.1, true); plant(6.3, 7.2, 1.0, true); plant(-5.6, 7.3, 1.0, false);
  [3, 0, 6, 4, 1, 7, 5, 2].map(function (i) { return REST[i]; }).forEach(function (p, i) { REST[i] = p; });   /* 소파·바·1인 소파를 번갈아 채운다 */
  const STROLL = [[0.5, 6.3], [-6.4, 2.6], [6.4, 0.4], [3.2, -3.0], [-6.4, 6.2], [6.2, 3.9], [4.4, 6.6]];

  const allGeo = mergeGeometries(solid, false);
  const world = new THREE.Mesh(allGeo, new THREE.MeshLambertMaterial({ vertexColors: true }));
  world.castShadow = true; world.receiveShadow = true; scene.add(world);
  const glowMesh = new THREE.Mesh(mergeGeometries(glow, false), new THREE.MeshBasicMaterial({ vertexColors: true }));
  scene.add(glowMesh);
  scene.add(new THREE.Mesh(mergeGeometries(glassG, false), new THREE.MeshBasicMaterial({ map: cityTex, color: '#cdb596' })));
  solid.concat(glow, glassG).forEach(function (g) { g.dispose(); });

  /* ---------- 길 찾기(0.4m 격자 A*, 가구는 막힌 칸) ---------- */
  function cellOf(x, z) { return [Math.max(0, Math.min(GW - 1, Math.floor((x + FX) / CS))), Math.max(0, Math.min(GH - 1, Math.floor((z + FZ) / CS)))]; }
  function isBlocked(x, z) { if (x < -FX + 0.2 || x > FX - 0.2 || z < -FZ + 0.2 || z > FZ - 0.2) return true; const c = cellOf(x, z); return blocked[c[1] * GW + c[0]] === 1; }
  function nearestFree(x, z) {
    const c = cellOf(x, z);
    if (!blocked[c[1] * GW + c[0]]) return c;
    for (let r = 1; r < 12; r++) {
      let best = null, bd = 1e9;
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const gx = c[0] + dx, gz = c[1] + dz;
        if (gx < 1 || gz < 1 || gx >= GW - 1 || gz >= GH - 1 || blocked[gz * GW + gx]) continue;
        const d = dx * dx + dz * dz; if (d < bd) { bd = d; best = [gx, gz]; }
      }
      if (best) return best;
    }
    return c;
  }
  function clearLine(x0, z0, x1, z1) {
    const d = Math.hypot(x1 - x0, z1 - z0), n = Math.ceil(d / 0.15);
    for (let i = 1; i < n; i++) { const t = i / n; if (isBlocked(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t)) return false; }
    return true;
  }
  const NB = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]];
  function findPath(x0, z0, x1, z1) {
    if (Math.hypot(x1 - x0, z1 - z0) < 0.05) return [];
    const s = nearestFree(x0, z0), g = nearestFree(x1, z1), N = GW * GH, si = s[1] * GW + s[0], gi = g[1] * GW + g[0];
    const gs = new Float32Array(N).fill(1e9), fs = new Float32Array(N).fill(1e9), prev = new Int32Array(N).fill(-1), closed = new Uint8Array(N), open = [si];
    gs[si] = 0; fs[si] = Math.hypot(g[0] - s[0], g[1] - s[1]);
    let found = false;
    while (open.length) {
      let bi = 0; for (let i = 1; i < open.length; i++) if (fs[open[i]] < fs[open[bi]]) bi = i;
      const cur = open[bi]; open[bi] = open[open.length - 1]; open.pop();
      if (cur === gi) { found = true; break; }
      if (closed[cur]) continue; closed[cur] = 1;
      const cx = cur % GW, cz = (cur - cx) / GW;
      for (let k = 0; k < 8; k++) {
        const nx = cx + NB[k][0], nz = cz + NB[k][1];
        if (nx < 0 || nz < 0 || nx >= GW || nz >= GH) continue;
        const ni = nz * GW + nx;
        if (blocked[ni] || closed[ni]) continue;
        if (k > 3 && (blocked[cz * GW + nx] || blocked[nz * GW + cx])) continue;
        const ng = gs[cur] + NB[k][2];
        if (ng < gs[ni]) { gs[ni] = ng; fs[ni] = ng + Math.hypot(g[0] - nx, g[1] - nz); prev[ni] = cur; open.push(ni); }
      }
    }
    if (!found) return [[x1, z1]];
    let pts = [];
    for (let i = gi; i !== -1; i = prev[i]) { const cx = i % GW; pts.unshift([-FX + (cx + 0.5) * CS, -FZ + ((i - cx) / GW + 0.5) * CS]); }
    pts[0] = [x0, z0]; pts.push([x1, z1]);
    const out = []; let i = 0;                         /* 꺾이는 점만 남긴다 */
    while (i < pts.length - 1) {
      let j = pts.length - 1;
      while (j > i + 1 && !clearLine(pts[i][0], pts[i][1], pts[j][0], pts[j][1])) j--;
      out.push(pts[j]); i = j;
    }
    return out;
  }

  /* ---------- 캐릭터: 둥근 동물 피규어 ---------- */
  const INK = new THREE.Color('#2d2622'), CREAM = new THREE.Color('#fffaf2'), PINK = new THREE.Color('#f0a094');
  function part(list, g, color, x, y, z) { g.translate(x, y, z); list.push(paint(g, color)); }
  function ball(r, sx, sy, sz, seg) { const g = new THREE.SphereGeometry(r, seg || 14, Math.max(8, Math.round((seg || 14) * 0.7))); g.scale(sx, sy, sz); return g; }
  function buildFigure(def, scale) {
    const fur = new THREE.Color(def.fur), furD = shade(def.fur, 0.72), shirt = new THREE.Color(def.color), pants = shade(def.color, 0.55), kind = def.animal;
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0 });
    const root = new THREE.Group(), body = new THREE.Group(); root.add(body); root.scale.setScalar(scale);
    const mk = function (list) { const m = new THREE.Mesh(mergeGeometries(list, false), mat); m.castShadow = true; list.forEach(function (g) { g.dispose(); }); return m; };
    /* 몸통 */
    let L = [];
    part(L, ball(0.25, 1, 1.16, 0.9, 18), shirt, 0, 0.6, 0);
    if (def.tie) { const t = new THREE.BoxGeometry(0.07, 0.24, 0.03); part(L, t, '#7c2d12', 0, 0.66, 0.215); }
    else part(L, ball(0.1, 1, 0.8, 0.3), shade('#ffffff', 0.92), 0, 0.68, 0.2);
    if (kind === 'fox') { const c = new THREE.ConeGeometry(0.1, 0.34, 10); c.rotateX(-2.2); part(L, c, fur, 0, 0.5, -0.3); part(L, ball(0.06, 1, 1, 1, 8), CREAM, 0, 0.6, -0.42); }
    else part(L, ball(kind === 'rabbit' ? 0.09 : 0.07, 1, 1, 1, 8), kind === 'panda' ? INK : (kind === 'rabbit' ? CREAM : fur), 0, 0.44, -0.23);
    body.add(mk(L));
    /* 머리 */
    const head = new THREE.Group(); head.position.set(0, 0.86, 0); body.add(head);
    L = [];
    part(L, ball(0.29, 1.04, 0.92, 0.96, 22), fur, 0, 0.24, 0);
    [-1, 1].forEach(function (k) {
      if (kind === 'bear' || kind === 'panda') { part(L, ball(0.1, 1, 1, 0.7, 10), kind === 'panda' ? INK : fur, k * 0.21, 0.47, 0); if (kind === 'bear') part(L, ball(0.055, 1, 1, 0.5, 8), PINK, k * 0.21, 0.47, 0.05); }
      else if (kind === 'cat' || kind === 'fox') {
        const c = new THREE.ConeGeometry(0.1, 0.2, 4); c.rotateY(Math.PI / 4); c.rotateZ(-k * 0.3); part(L, c, fur, k * 0.19, 0.5, 0);
        const c2 = new THREE.ConeGeometry(0.055, 0.12, 4); c2.rotateY(Math.PI / 4); c2.rotateZ(-k * 0.3); part(L, c2, kind === 'fox' ? '#4a3328' : PINK, k * 0.185, 0.49, 0.035);
      } else if (kind === 'rabbit') {
        const e = ball(0.07, 1, 3.1, 0.7, 10); e.rotateZ(-k * 0.16); part(L, e, fur, k * 0.11, 0.62, 0);
        const e2 = ball(0.035, 1, 3.6, 0.5, 8); e2.rotateZ(-k * 0.16); part(L, e2, PINK, k * 0.11, 0.62, 0.035);
      } else if (kind === 'dog') { const e = ball(0.085, 0.8, 1.9, 1, 10); e.rotateZ(k * 0.25); part(L, e, shade(def.fur, 0.6), k * 0.29, 0.24, 0); }
      if (kind === 'panda') { const p = ball(0.07, 1, 1.25, 0.5, 10); p.rotateZ(k * 0.35); part(L, p, INK, k * 0.115, 0.27, 0.235); part(L, ball(0.026, 1, 1, 1, 8), '#ffffff', k * 0.115, 0.275, 0.268); }
      else part(L, ball(0.034, 1, 1.15, 0.8, 8), INK, k * 0.115, 0.275, 0.248);
      part(L, ball(0.045, 1, 0.7, 0.4, 8), PINK, k * 0.19, 0.17, 0.215);
    });
    if (kind === 'fox') part(L, ball(0.17, 1.2, 0.7, 0.7, 12), CREAM, 0, 0.14, 0.17);
    part(L, ball(0.1, 1.15, 0.8, 0.8, 12), CREAM, 0, 0.17, 0.24);
    part(L, ball(0.036, 1.2, 0.85, 0.8, 8), INK, 0, 0.21, 0.318);
    head.add(mk(L));
    /* 팔·다리(어깨·골반에서 돈다) */
    const limb = function (x, y, r, len, c1, c2) {
      const g = new THREE.Group(); g.position.set(x, y, 0); body.add(g);
      const l = []; const cap = new THREE.CapsuleGeometry(r, len, 4, 10); part(l, cap, c1, 0, -len / 2 - r * 0.4, 0);
      if (c2) part(l, ball(r * 1.08, 1, 1, 1, 8), c2, 0, -len - r * 0.7, 0);
      g.add(mk(l)); return g;
    };
    const armL = limb(-0.27, 0.76, 0.068, 0.2, shirt, fur), armR = limb(0.27, 0.76, 0.068, 0.2, shirt, fur);
    const legL = limb(-0.11, HIP, 0.08, 0.14, pants, furD), legR = limb(0.11, HIP, 0.08, 0.14, pants, furD);
    armL.rotation.z = -0.16; armR.rotation.z = 0.16;
    const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.042, 0.1, 10), new THREE.MeshLambertMaterial({ color: '#fffaf0' }));
    cup.position.set(0, -0.3, 0.09); cup.rotation.x = Math.PI / 2; cup.visible = false; armR.add(cup);
    return { root: root, body: body, head: head, armL: armL, armR: armR, legL: legL, legR: legR, cup: cup, mat: mat, scale: scale, top: (kind === 'rabbit' ? 1.76 : 1.42) };
  }

  const actors = {}, order = [], pickRoots = [];
  let simT = 0;
  const evQueue = [];
  const demoFast = !!opts.demo;
  function nextWander() { return simT + (demoFast ? 5 + Math.random() * 30 : 40 + Math.random() * 200); }

  function makeLabel(def, gold) {
    const el = document.createElement('div'); el.className = 'l3' + (gold ? ' ceo' : '');
    const bub = document.createElement('div'); bub.className = 'bub3'; bub.hidden = true; el.appendChild(bub);
    const tag = document.createElement(gold ? 'div' : 'button'); tag.className = 'tag3'; if (!gold) tag.type = 'button';
    const pl = document.createElement('span'); pl.className = 'pl';
    if (def.icon) { const im = document.createElement('img'); im.src = opts.iconDir + def.icon + '.png'; im.alt = ''; pl.appendChild(im); }
    else { pl.textContent = def.mark || def.name.slice(0, 1); pl.style.background = def.plate || def.color; if (def.serif) pl.style.fontFamily = 'Georgia,"Times New Roman",serif'; }
    const dot = document.createElement('i'); const tx = document.createElement('span'); tx.className = 'tx';
    tag.appendChild(pl); tag.appendChild(dot); tag.appendChild(tx); el.appendChild(tag);
    labels.appendChild(el);
    return { el: el, bub: bub, tag: tag, dot: dot, tx: tx, shown: null, bubShown: '', w: 0 };
  }
  opts.cast.forEach(function (def, i) {
    const f = buildFigure(def, def.id === 'claude' ? 1.3 : 1.2), hm = HOME[def.id];
    f.root.userData.id = def.id; scene.add(f.root); pickRoots.push(f.root);
    const a = actors[def.id] = { id: def.id, def: def, fig: f, data: { status: 'idle', bubble: '' }, x: hm.x, z: hm.z, ry: hm.ry, path: [], dest: hm, at: hm, sitK: 1, seatH: hm.h,
      act: null, wander: null, flash: null, phase: 0, seed: i * 1.7, wanderAt: 0, dim: 0, P: { ll: 0, lr: 0, al: 0, ar: 0, hx: 0, hy: 0, lean: 0, by: 0 }, label: makeLabel(def, false) };
    a.label.tag.setAttribute('aria-label', def.name);
    a.label.tag.addEventListener('click', function (ev) { ev.stopPropagation(); opts.onOpen(def.id); });
    a.wanderAt = nextWander() * (0.3 + Math.random() * 0.7);
    order.push(a);
  });
  /* 대표님 자리: 고정 인형(상태·말풍선 없음) */
  const ceo = (function () {
    const f = buildFigure(opts.ceo, 1.32); scene.add(f.root);
    f.root.position.set(CEO_SEAT.x, CEO_SEAT.h - HIP * 1.32, CEO_SEAT.z); f.root.rotation.y = CEO_SEAT.ry;
    f.legL.rotation.x = f.legR.rotation.x = -Math.PI / 2; f.armL.rotation.x = f.armR.rotation.x = -0.9;
    const lb = makeLabel(opts.ceo, true); lb.tx.textContent = opts.ceo.tag + ' · ' + opts.ceo.rank;
    return { fig: f, label: lb, x: CEO_SEAT.x, z: CEO_SEAT.z, topY: CEO_SEAT.h - HIP * 1.32 + f.top * 1.32 };
  })();

  function homeOf(a) {
    if (a.data.status !== 'resting') return HOME[a.id];
    let n = 0;
    for (let i = 0; i < order.length && order[i] !== a; i++) if (order[i].data.status === 'resting') n++;
    return REST[n % REST.length];
  }
  function goTo(a, pl) {
    if (a.dest === pl && (a.path.length || a.at === pl)) return;
    const pts = []; let sx = a.x, sz = a.z;
    if (a.at && a.at.sit) { pts.push([a.at.ax, a.at.az]); sx = a.at.ax; sz = a.at.az; }
    findPath(sx, sz, pl.ax, pl.az).forEach(function (p) { pts.push(p); });
    if (Math.hypot(pl.x - pl.ax, pl.z - pl.az) > 0.01) pts.push([pl.x, pl.z]);
    a.path = pts; a.dest = pl; a.at = null;
    if (!pts.length) a.at = pl;
  }
  function say(a, text, sec) { a.flash = { text: text, until: simT + sec }; }
  function phraseOf(e) { const i = e.title.indexOf(': '); return i >= 0 ? e.title.slice(i + 2) : e.title; }
  function standPlace(x, z) { return { x: x, z: z, ax: x, az: z, ry: 0, sit: false, kind: 'stand' }; }
  function besideSpot(hx, hz, from) {
    let best = null, bd = 1e9;
    [1.15, 1.5, 0.85].forEach(function (r, ri) {
      for (let k = 0; k < 12; k++) {
        const an = k * Math.PI / 6, x = hx + Math.sin(an) * r, z = hz + Math.cos(an) * r;
        if (isBlocked(x, z) || !clearLine(hx, hz, x, z)) continue;
        let busy = false;
        order.forEach(function (o) { if (o !== from && Math.hypot(o.x - x, o.z - z) < 0.6 && !o.path.length) busy = true; });
        if (busy) continue;
        const d = Math.hypot(from.x - x, from.z - z) + ri * 3 - Math.cos(an) * 0.8;     /* 되도록 카메라 쪽(남쪽)에 선다 */
        if (d < bd) { bd = d; best = [x, z]; }
      }
    });
    return best || [hx + 0.9, hz];
  }

  function tryStartEvents() {
    for (let i = 0; i < evQueue.length; i++) {
      const q = evQueue[i], e = q.e;
      if (simT - q.at > 150) { evQueue.splice(i--, 1); continue; }
      const ids = e.kind === 'meeting' ? e.members.slice() : [e.from, e.to].filter(Boolean);
      const who = ids.map(function (id) { return actors[id]; }).filter(Boolean);
      if (who.some(function (c) { return c.act; })) continue;
      evQueue.splice(i--, 1);
      opts.onTicker(e);
      if (e.kind === 'meeting' && who.length >= 2) {
        const m = { type: 'meet', who: who, title: e.title, end: null, t0: simT };
        let seat = who.indexOf(actors.claude) >= 0 ? 1 : 0;
        who.forEach(function (c) { c.act = m; c.wander = null; goTo(c, MEET[c.id === 'claude' ? 0 : seat++ % MEET.length]); });
      } else if ((e.kind === 'dispatch' || e.kind === 'report') && who.length === 2 && actors[e.from] && actors[e.to] && e.from !== e.to) {
        const a = actors[e.from], b = actors[e.to];
        const text = e.kind === 'dispatch' ? b.def.tag + ', ' + phraseOf(e) : phraseOf(e);
        const bd = b.path.length ? b.dest : (b.at || b.dest);
        const hs = standPlace(bd.ax, bd.az), sp2 = besideSpot(hs.x, hs.z, a), vs = standPlace(sp2[0], sp2[1]);
        a.act = { type: 'visit', other: b, text: text, end: null, t0: simT }; b.act = { type: 'host', other: a, t0: simT };
        a.wander = b.wander = null;
        goTo(b, hs); goTo(a, vs);
      } else {
        const c = actors[e.to] || actors[e.from];
        if (c) say(c, phraseOf(e), 6);
      }
    }
  }
  function release(c) { c.act = null; c.wanderAt = Math.max(c.wanderAt, simT + 20); }
  function stepAct(c) {
    const a = c.act;
    if (simT - a.t0 > 75) { if (a.other && a.other.act && a.other.act.other === c) release(a.other); if (a.who) a.who.forEach(release); release(c); return; }
    if (a.type === 'visit') {
      if (a.end == null && !c.path.length && !a.other.path.length) { a.end = simT + 5; say(c, a.text, 4.6); }
      if (a.end != null && simT > a.end) { if (a.other.act && a.other.act.other === c) release(a.other); release(c); }
    } else if (a.type === 'meet') {
      if (a.end == null && a.who.every(function (x) { return !x.path.length; })) {
        a.end = simT + 9;
        a.speaker = actors.claude && a.who.indexOf(actors.claude) >= 0 ? actors.claude : a.who[0];
        say(a.speaker, a.title, 6);
      }
      if (a.end != null && simT > a.end) a.who.forEach(release);
    }
  }
  /* 대기(idle)만 하는 가벼운 연출: 잠깐 걷기 / 커피. 말풍선 없음. 실제 사건·상태 변화가 오면 바로 그만둔다. */
  function stepWander(a) {
    const idle = a.data.status === 'idle';
    if (a.wander) {
      if (!idle) { a.wander = null; return; }
      const w = a.wander;
      if (w.until == null && !a.path.length && a.at === w.place) w.until = simT + (w.type === 'coffee' ? 8 + Math.random() * 5 : 2 + Math.random() * 3);
      if (w.until != null && simT > w.until) { a.wander = null; a.wanderAt = nextWander(); }
      return;
    }
    if (!idle || a.act || a.at !== HOME[a.id] || simT < a.wanderAt) return;
    a.wanderAt = nextWander();
    let n = 0; const used = [];
    order.forEach(function (o) { if (o.wander) { n++; used.push(o.wander.place); } });
    if (n >= 2) return;
    if (Math.random() < 0.55) {
      const free = COFFEE.filter(function (p) { return used.indexOf(p) < 0; });
      if (!free.length) return;
      a.wander = { type: 'coffee', place: free[Math.floor(Math.random() * free.length)], until: null };
    } else {
      const s = STROLL[Math.floor(Math.random() * STROLL.length)], pl = standPlace(s[0], s[1]);
      pl.ry = Math.random() * 1.6 - 0.2;
      a.wander = { type: 'stroll', place: pl, until: null };
    }
    goTo(a, a.wander.place);
  }

  function step(dt) {
    simT += dt;
    tryStartEvents();
    for (let i = 0; i < order.length; i++) {
      const a = order[i];
      if (a.act) stepAct(a);
      if (!a.act) stepWander(a);
      if (!a.act && !a.wander) { const hm = homeOf(a); if (a.dest !== hm) goTo(a, hm); }
      if (a.path.length) {
        let left = WALK * dt;
        while (left > 0 && a.path.length) {
          const p = a.path[0], dx = p[0] - a.x, dz = p[1] - a.z, d = Math.hypot(dx, dz);
          if (d > 0.001) a.faceTo = Math.atan2(dx, dz);
          if (d <= left) { a.x = p[0]; a.z = p[1]; a.path.shift(); left -= d; }
          else { a.x += dx / d * left; a.z += dz / d * left; left = 0; }
        }
        if (!a.path.length) { a.at = a.dest; if (a.at.sit) a.seatH = a.at.h; }
        a.phase += dt * 11;
      }
      if (a.flash && simT > a.flash.until) a.flash = null;
    }
  }

  function modeOf(a) {
    if (a.path.length) return 'walk';
    const c = a.act;
    if (c && (c.type === 'visit' || c.type === 'host')) return c.other.path.length ? 'stand' : 'talk';
    if (c && c.type === 'meet') return 'meet';
    if (a.wander) return a.wander.type === 'coffee' ? 'coffee' : 'look';
    if (a.at === HOME[a.id]) return a.data.status === 'working' ? 'type' : (a.data.status === 'offline' ? 'off' : 'sit');
    if (a.at && a.at.kind === 'rest') return 'rest';
    return 'stand';
  }
  function animate(a, dt) {
    const f = a.fig, P = a.P, mode = a.mode = modeOf(a), t = simT + a.seed, k = 1 - Math.exp(-dt * 12);
    const sitT = mode !== 'walk' && a.at && a.at.sit ? 1 : 0;
    a.sitK += (sitT - a.sitK) * (1 - Math.exp(-dt * 8));
    let ll = 0, lr = 0, al = 0, ar = 0, hx = 0, hy = 0, lean = 0, by = 0, face = a.at ? a.at.ry : a.ry, roll = 0;
    f.cup.visible = mode === 'coffee';
    if (mode === 'walk') {
      const s = Math.sin(a.phase); ll = s * 0.75; lr = -s * 0.75; al = -s * 0.55; ar = s * 0.55; by = Math.abs(Math.cos(a.phase)) * 0.045; roll = s * 0.045; face = a.faceTo == null ? a.ry : a.faceTo; lean = 0.06;
    } else if (mode === 'type') {
      al = -1.18 + Math.sin(t * 13) * 0.13; ar = -1.18 - Math.sin(t * 13) * 0.13; hx = 0.12 + Math.sin(t * 0.9) * 0.03; by = Math.sin(t * 3.2) * 0.006;
    } else if (mode === 'off') { al = ar = -0.9; hx = 0.55; lean = 0.2; }
    else if (mode === 'sit') { al = ar = -0.75; by = Math.sin(t * 1.5) * 0.006; hy = Math.sin(t * 0.23) * 0.25; }
    else if (mode === 'rest') { al = ar = -0.45; lean = -0.14; by = Math.sin(t * 1.2) * 0.008; hx = -0.05; }
    else if (mode === 'meet') {
      al = ar = -0.85; const sp3 = a.act.speaker;
      if (sp3 && sp3.flash) { if (sp3 === a) { ar = -1.25 + Math.sin(t * 5) * 0.25; hx = Math.sin(t * 3) * 0.05; } else hx = 0.05 + Math.max(0, Math.sin(t * 3.4)) * 0.16; }
    } else if (mode === 'talk') {
      const o = a.act.other; face = Math.atan2(o.x - a.x, o.z - a.z);
      const speaking = a.act.type === 'visit';
      hx = speaking ? Math.sin(t * 4.2) * 0.07 : 0.04 + Math.max(0, Math.sin(t * 3.6)) * 0.2;
      if (speaking) { ar = -1.05 + Math.sin(t * 5.2) * 0.3; al = -0.15; } else { al = ar = -0.1; }
      by = Math.sin(t * 2) * 0.006;
    } else if (mode === 'stand') { if (a.act && a.act.other) { const o2 = a.act.other; face = Math.atan2(o2.x - a.x, o2.z - a.z); } }
    else if (mode === 'coffee') {
      const c = (t % 3.6) / 3.6, sip = c > 0.45 && c < 0.8 ? Math.sin((c - 0.45) / 0.35 * Math.PI) : 0;
      ar = -1.0 - sip * 1.15; hx = -sip * 0.18; al = -0.1; by = Math.sin(t * 1.4) * 0.005;
    } else if (mode === 'look') { hy = Math.sin(t * 0.9) * 0.6; }
    P.ll += (ll - P.ll) * k; P.lr += (lr - P.lr) * k; P.al += (al - P.al) * k; P.ar += (ar - P.ar) * k;
    P.hx += (hx - P.hx) * k; P.hy += (hy - P.hy) * k; P.lean += (lean - P.lean) * k; P.by += (by - P.by) * k;
    a.ry = dampAngle(a.ry, face, 1 - Math.exp(-dt * 10));
    const sit = a.sitK;
    f.legL.rotation.x = P.ll * (1 - sit) - sit * Math.PI / 2; f.legR.rotation.x = P.lr * (1 - sit) - sit * Math.PI / 2;
    f.armL.rotation.x = P.al; f.armR.rotation.x = P.ar;
    f.head.rotation.x = P.hx; f.head.rotation.y = P.hy;
    f.body.rotation.x = P.lean; f.body.rotation.z = roll;
    f.body.position.y = P.by;
    a.y = sit * (a.seatH - HIP * f.scale);
    f.root.position.set(a.x, a.y, a.z); f.root.rotation.y = a.ry;
    /* 퇴근(offline)은 어둡게 */
    const dimT = a.data.status === 'offline' ? 1 : 0;
    if (Math.abs(dimT - a.dim) > 0.002) { a.dim += (dimT - a.dim) * Math.min(1, dt * 4); const v = 1 - a.dim * 0.58; f.mat.color.setRGB(v, v * (1 - a.dim * 0.04), v * (1 - a.dim * 0.1)); }
    /* 모니터: 자기 자리에서 일할 때만 켜짐 */
    const on = mode === 'type';
    if (on !== a.scrOn && screens[a.id]) { a.scrOn = on; screens[a.id].forEach(function (m) { m.material.color.set(on ? '#bfe9ff' : '#1b1f26'); }); }
  }

  /* ---------- 이름표·말풍선(HTML) ---------- */
  const v3 = new THREE.Vector3();
  let W = 1, H = 1, shortTags = false;
  function placeLabels() {
    const rects = [], items = [];
    const add = function (lb, x, y, z, key) {
      v3.set(x, y, z).project(camera);
      const px = (v3.x * 0.5 + 0.5) * W, py = (-v3.y * 0.5 + 0.5) * H;
      items.push({ lb: lb, x: px, y: py, depth: v3.z, key: key });
    };
    order.forEach(function (a) { add(a.label, a.x, a.y + a.fig.top * a.fig.scale + 0.1, a.z, a); });
    add(ceo.label, ceo.x, ceo.topY + 0.1, ceo.z, null);
    items.sort(function (p, q) { return p.depth - q.depth; });      /* 가까운 것부터 자리를 잡고, 뒤쪽 이름표가 위로 비킨다 */
    items.forEach(function (it, idx) {
      const lb = it.lb; if (!lb.w) lb.w = lb.tag.offsetWidth || 80;
      const hw = lb.w / 2 + 2; let y = it.y;
      for (let pass = 0; pass < 4; pass++) {
        let moved = false;
        for (let j = 0; j < rects.length; j++) { const r = rects[j]; if (Math.abs(r.x - it.x) < hw + r.hw && y > r.y - 21 && y - 21 < r.y) { y = r.y - 22; moved = true; } }
        if (!moved) break;
      }
      rects.push({ x: it.x, y: y, hw: hw });
      const tr = 'translate(' + it.x.toFixed(1) + 'px,' + y.toFixed(1) + 'px) translate(-50%,-100%)';
      if (tr !== lb.tr) { lb.tr = tr; lb.el.style.transform = tr; }
      const zi = String((lb.bubShown ? 500 : 100) + items.length - idx);
      if (zi !== lb.zi) { lb.zi = zi; lb.el.style.zIndex = zi; }
    });
  }
  function refreshLabel(a) {
    const lb = a.label, st = a.data.status, col = opts.statusColors[st] || '#d9cdbb';
    const text = shortTags || !a.def.rank ? a.def.tag : a.def.tag + ' · ' + a.def.rank, sig = text + '|' + st;
    if (sig !== lb.shown) {
      lb.shown = sig; lb.tx.textContent = text; lb.dot.style.background = col; lb.tag.style.borderColor = col; lb.w = 0;
      lb.el.classList.toggle('off', st === 'offline'); lb.dot.classList.toggle('lamp-on', st === 'working');
    }
  }
  function refreshBubble(a) {
    const lb = a.label; let text = a.flash ? a.flash.text : (a.mode === 'type' ? a.data.bubble || '' : '');
    if (text.length > 22) text = text.slice(0, 21) + '…';
    if (text !== lb.bubShown) { lb.bubShown = text; lb.bub.hidden = !text; lb.bub.textContent = text; }
  }

  /* ---------- 카메라 ---------- */
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true; controls.dampingFactor = 0.12; controls.screenSpacePanning = false;
  controls.minPolarAngle = 0.3; controls.maxPolarAngle = 1.18; controls.minAzimuthAngle = -0.2; controls.maxAzimuthAngle = 1.75;
  controls.minDistance = 7; controls.maxDistance = 90; controls.zoomSpeed = 0.9; controls.rotateSpeed = 0.7;
  let touched = false, fitDist = 40;
  controls.addEventListener('start', function () { touched = true; });
  controls.addEventListener('change', function () { const t = controls.target; t.x = Math.max(-FX, Math.min(FX, t.x)); t.z = Math.max(-FZ, Math.min(FZ, t.z)); });
  const AZ = 0.66, POL = 0.93;
  function fitView() {
    const narrow = W < 620 && H > W * 0.7;
    const b = narrow ? { x0: -6.2, x1: 6.2, z0: -3.2, z1: 6.4, h: 1.5 } : { x0: -FX - 0.4, x1: FX + 0.2, z0: -FZ - 0.4, z1: FZ + 0.2, h: 0 };
    const pts = [[b.x0, 0, b.z0], [b.x1, 0, b.z0], [b.x0, 0, b.z1], [b.x1, 0, b.z1], [b.x0, narrow ? b.h : WH, b.z0], [b.x1, narrow ? b.h : WH, b.z0], [b.x0, narrow ? b.h : WH, b.z1], [b.x1, b.h, b.z1]];
    const dir = new THREE.Vector3(Math.sin(POL) * Math.sin(AZ), Math.cos(POL), Math.sin(POL) * Math.cos(AZ)), tgt = new THREE.Vector3((b.x0 + b.x1) / 2, 0.5, (b.z0 + b.z1) / 2);
    const padX = 0.95, padTop = H < 420 ? 0.84 : 0.9, padBot = 0.96;
    const box = function (d) {
      camera.position.copy(tgt).addScaledVector(dir, d); camera.lookAt(tgt); camera.updateMatrixWorld(); camera.updateProjectionMatrix();
      let x0 = 9, x1 = -9, y0 = 9, y1 = -9;
      pts.forEach(function (p) { v3.set(p[0], p[1], p[2]).project(camera); x0 = Math.min(x0, v3.x); x1 = Math.max(x1, v3.x); y0 = Math.min(y0, v3.y); y1 = Math.max(y1, v3.y); });
      return [x0, x1, y0, y1];
    };
    let d = 40;
    for (let it = 0; it < 4; it++) {
      let lo = 6, hi = 160;
      for (let i = 0; i < 22; i++) { d = (lo + hi) / 2; const r = box(d); if ((r[1] - r[0]) / 2 <= padX && (r[3] - r[2]) / 2 <= (padTop + padBot) / 2) hi = d; else lo = d; }
      d = hi; const r = box(d), hh = d * Math.tan(camera.fov * Math.PI / 360), hw = hh * camera.aspect;
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
      const cx = (r[0] + r[1]) / 2, cyy = (r[2] + r[3]) / 2 - (padTop - padBot) / 2;
      const m = right.multiplyScalar(cx * hw).addScaledVector(up, cyy * hh);
      /* 화면에서의 어긋남을 바닥 위 이동으로 바꾼다 */
      const fwd = new THREE.Vector3(-dir.x, 0, -dir.z).normalize(), rgt = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
      tgt.addScaledVector(rgt, m.dot(rgt)).addScaledVector(fwd, cyy * hh / Math.cos(POL));
    }
    box(d); fitDist = d;
    controls.target.copy(tgt); controls.maxDistance = d * 1.3; controls.minDistance = Math.min(8, d * 0.4);
    controls.update();
  }
  function resize() {
    const r = pane.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return;
    W = r.width; H = r.height; renderer.setSize(W, H, false); camera.aspect = W / H; camera.updateProjectionMatrix();
    const s = W < 560; if (s !== shortTags) { shortTags = s; }
    if (!touched) fitView();
  }
  function zoom(f) {
    touched = true;
    const off = camera.position.clone().sub(controls.target), len = Math.max(controls.minDistance, Math.min(controls.maxDistance, off.length() / f));
    camera.position.copy(controls.target).add(off.setLength(len)); controls.update();
  }
  function reset() { touched = false; fitView(); }

  /* 누르면 그 AI 의 정보 창 */
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(); let down = null;
  canvas.addEventListener('pointerdown', function (ev) { down = [ev.clientX, ev.clientY]; });
  canvas.addEventListener('pointerup', function (ev) {
    if (!down || Math.abs(ev.clientX - down[0]) + Math.abs(ev.clientY - down[1]) > 6) { down = null; return; }
    down = null;
    const r = canvas.getBoundingClientRect(); ndc.set((ev.clientX - r.left) / r.width * 2 - 1, -(ev.clientY - r.top) / r.height * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(pickRoots, true)[0];
    if (!hit) { opts.onClose(); return; }
    let o = hit.object; while (o && !o.userData.id) o = o.parent;
    if (o) opts.onOpen(o.userData.id);
  });

  /* ---------- 그리기: 화면에 보일 때만 ---------- */
  let last = 0, visible = true, raf = 0, dead = false;
  const ft = new Float32Array(240); let fi = 0, fn = 0;
  function frame() {
    raf = 0;
    if (dead) return;
    const ts = performance.now();
    let el = last ? Math.min(2, (ts - last) / 1000) : 0;
    if (last) { ft[fi] = ts - last; fi = (fi + 1) % ft.length; fn++; }
    last = ts;
    /* 느린 기기: 처음 몇 초의 평균 프레임 시간이 길면 해상도 → 그림자 순으로 낮춘다 */
    if (fn === 90 || fn === 200) {
      let s = 0; for (let i = 0; i < 60; i++) s += ft[(fi - 1 - i + ft.length) % ft.length];
      if (s / 60 > 40) { if (renderer.getPixelRatio() > 1) { renderer.setPixelRatio(1); renderer.setSize(W, H, false); } else if (sun.castShadow) { sun.castShadow = false; } }
    }
    const full = el;
    while (el > 0.0001) { const dt = Math.min(0.05, el); step(dt); el -= dt; }
    for (let i = 0; i < order.length; i++) { animate(order[i], Math.min(0.1, full || 0.016)); refreshLabel(order[i]); refreshBubble(order[i]); }
    controls.update();
    renderer.render(scene, camera);
    placeLabels();
    schedule();
  }
  function schedule() { if (!raf && !dead && visible && !document.hidden) raf = requestAnimationFrame(frame); }
  function wake() { last = 0; schedule(); }
  document.addEventListener('visibilitychange', wake);
  if ('IntersectionObserver' in window) new IntersectionObserver(function (en) { visible = en[en.length - 1].isIntersecting; if (visible) wake(); }).observe(pane);
  if ('ResizeObserver' in window) new ResizeObserver(resize).observe(pane); else window.addEventListener('resize', resize);
  setInterval(function () { if (!document.hidden && visible && performance.now() - last > 500) { if (raf) { cancelAnimationFrame(raf); raf = 0; } frame(); } }, 500);
  canvas.addEventListener('webglcontextlost', function (ev) { ev.preventDefault(); });
  canvas.addEventListener('webglcontextrestored', wake);
  resize();
  schedule();

  return {
    sync: function (cast) { cast.forEach(function (d) { if (actors[d.id]) actors[d.id].data = d; }); },
    placeAll: function () {
      order.forEach(function (a) { const hm = homeOf(a); a.x = hm.x; a.z = hm.z; a.ry = hm.ry; a.at = a.dest = hm; a.path = []; a.sitK = 1; a.seatH = hm.h; a.act = null; a.wander = null; });
    },
    pushEvent: function (e) { evQueue.push({ e: e, at: simT }); },
    inMeeting: function (id) { const a = actors[id]; return !!(a && a.act && a.act.type === 'meet'); },
    zoom: zoom, reset: reset,
    fastForward: function (sec) { for (let t = 0; t < sec; t += 0.05) step(0.05); order.forEach(function (a) { for (let i = 0; i < 12; i++) animate(a, 0.05); }); },
    perf: function () {
      const n = Math.min(fn, ft.length); if (!n) return null;
      const arr = Array.prototype.slice.call(ft, 0, n).sort(function (a, b) { return a - b; }); let s = 0; arr.forEach(function (v) { s += v; });
      const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
      return { frames: fn, avgMs: +(s / n).toFixed(2), fps: +(1000 * n / s).toFixed(1), p95Ms: +arr[Math.floor(n * 0.95)].toFixed(2), maxMs: +arr[n - 1].toFixed(2),
        calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, pixelRatio: renderer.getPixelRatio(), gpu: ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)).slice(0, 80) : '' };
    },
    debug: function () { return order.map(function (a) { return a.id + ':' + a.mode + (a.wander ? '(' + a.wander.type + ')' : ''); }).join(' '); }
  };
}

window.Office3D = { create: create };
window.dispatchEvent(new Event('office3d-ready'));
