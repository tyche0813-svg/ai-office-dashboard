/* AI 오피스 관제 대시보드 — 외부 라이브러리 없음. 데이터는 모두 textContent 로만 넣는다. */
(function () {
  'use strict';

  var SOURCES = [
    { key: 'pc', url: 'data/pc-status.json', label: 'PC' },
    { key: 'pickle', url: 'data/pickle-status.json', label: '피클' }
  ];
  var REFRESH_MS = 45000;          /* 30~60초 사이 재조회 */
  var STALE_MS = 10 * 60 * 1000;   /* 이보다 오래되면 '갱신 지연' */

  var STATUS = {
    working: { label: '작업 중', color: '#34d399' },
    meeting: { label: '회의 중', color: '#60a5fa' },
    resting: { label: '휴식', color: '#fbbf24' },
    idle: { label: '대기', color: '#94a3b8' },
    offline: { label: '오프라인', color: '#475569' }
  };
  var STATUS_ORDER = ['working', 'meeting', 'resting', 'idle', 'offline'];
  var DEFAULT_ZONE = { working: 'desk', meeting: 'meeting', resting: 'lounge', idle: 'lounge', offline: 'lounge' };

  /* 구역: rect = [gx0, gy0, gx1, gy1] (격자 16 x 12) */
  var ZONES = {
    ceo: { label: '대표님', rect: [0, 0, 5, 5], tint: '#2a2440',
      spots: [[3.3, 3.6], [1.3, 3.9], [4.3, 2.4]] },
    meeting: { label: '회의실', rect: [5, 0, 11, 5], tint: '#1c2b45',
      spots: [[6.3, 3.9], [7.7, 4.2], [9.1, 4.2], [10.4, 3.7], [6.2, 1.3], [10.5, 1.5]] },
    lounge: { label: '라운지', rect: [11, 0, 16, 5], tint: '#33283a',
      spots: [[12.2, 1.9], [13.7, 2.0], [15.2, 1.9], [11.8, 3.5], [14.8, 3.3], [12.6, 4.5], [14.1, 4.5], [15.6, 3.0]] },
    desk: { label: '실무 데스크', rect: [0, 5, 11, 12], tint: '#18263a', spots: [] },
    reception: { label: '안내 데스크', rect: [11, 5, 16, 12], tint: '#1b3035',
      spots: [[12.5, 7.5], [13.7, 7.5], [14.9, 7.5], [12.4, 10.2], [13.9, 10.6], [15.2, 10.0]] }
  };
  var ZONE_ORDER = ['ceo', 'meeting', 'desk', 'lounge', 'reception'];
  var DESKS = [];
  [5.9, 8.0, 10.1].forEach(function (y) {
    [0.8, 3.3, 5.8, 8.3].forEach(function (x) {
      DESKS.push([x, y]);
      ZONES.desk.spots.push([x + 0.85, y + 1.3]);
    });
  });

  var PALETTE = ['#7dd3fc', '#c4b5fd', '#f9a8d4', '#fdba74', '#86efac', '#fde047', '#a5b4fc', '#5eead4', '#fca5a5', '#d9f99d'];
  var SVGNS = 'http://www.w3.org/2000/svg';
  var TW = 30, TH = 15;

  var state = { agents: [], logs: [], sources: {}, summary: { done: 0 }, tab: 'office', view: { k: 1, x: 0, y: 0 }, popupId: null };

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
  function hash(t) { var x = 0; for (var i = 0; i < t.length; i++) x = (x * 31 + t.charCodeAt(i)) >>> 0; return x; }
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
    var m = Math.round((Date.now() - d.getTime()) / 60000);
    if (m < 1) return '방금';
    if (m < 60) return m + '분 전';
    if (m < 1440) return Math.floor(m / 60) + '시간 전';
    return Math.floor(m / 1440) + '일 전';
  }

  /* ---------- data ---------- */
  function fetchSource(src) {
    return fetch(src.url + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('형식 오류');
        return { ok: true, data: j };
      })
      .catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
  }

  function normalize(results) {
    var agents = [], logs = [], sources = {}, done = 0, seen = {};
    SOURCES.forEach(function (src, i) {
      var r = results[i];
      var info = { label: src.label, ok: r.ok, updated: null, stale: false, count: 0 };
      sources[src.key] = info;
      if (!r.ok) return;
      var d = r.data;
      info.updated = parseTime(d.updated_at);
      info.stale = !info.updated || (Date.now() - info.updated.getTime() > STALE_MS);
      var sum = d.summary && typeof d.summary === 'object' ? d.summary : {};
      var n = Number(sum.done_today);
      if (isFinite(n) && n > 0) done += Math.floor(n);
      (Array.isArray(d.agents) ? d.agents : []).forEach(function (a) {
        if (!a || typeof a !== 'object') return;
        var id = str(a.id, 40) || str(a.name, 40);
        if (!id) return;
        if (seen[id]) id = src.key + ':' + id;
        seen[id] = true;
        var st = STATUS[a.status] ? a.status : 'idle';
        agents.push({
          id: id, rawId: str(a.id, 40), src: src.key, srcLabel: src.label,
          name: str(a.name, 24) || id, role: str(a.role, 40),
          status: st, zone: ZONES[a.zone] ? a.zone : DEFAULT_ZONE[st],
          bubble: str(a.bubble, 26), task: str(a.task, 80),
          last: parseTime(a.last_active), color: PALETTE[hash(id) % PALETTE.length]
        });
        info.count++;
      });
      (Array.isArray(d.logs) ? d.logs : []).slice(0, 200).forEach(function (l) {
        if (!l || typeof l !== 'object') return;
        var t = parseTime(l.time);
        logs.push({
          t: t, timeText: t ? fmtHM(t) : str(l.time, 8), agent: str(l.agent, 40),
          title: str(l.title, 60), detail: str(l.detail, 120), src: src.key
        });
      });
    });
    logs.sort(function (a, b) { return (b.t ? b.t.getTime() : 0) - (a.t ? a.t.getTime() : 0); });
    agents.sort(function (a, b) {
      return STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.name.localeCompare(b.name, 'ko');
    });
    state.agents = agents; state.logs = logs; state.sources = sources; state.summary = { done: done };
  }

  function refresh() {
    return Promise.all(SOURCES.map(fetchSource)).then(function (results) {
      normalize(results);
      renderAll();
    });
  }

  /* ---------- map scene ---------- */
  function box(items, x, y, w, d, z0, z1, color, extra) {
    items.push({
      depth: x + w / 2 + y + d / 2,
      draw: function (g) {
        s('polygon', { points: pts([iso(x, y + d, z1), iso(x + w, y + d, z1), iso(x + w, y + d, z0), iso(x, y + d, z0)]), fill: shade(color, 0.72) }, g);
        s('polygon', { points: pts([iso(x + w, y, z1), iso(x + w, y + d, z1), iso(x + w, y + d, z0), iso(x + w, y, z0)]), fill: shade(color, 0.5) }, g);
        s('polygon', { points: pts([iso(x, y, z1), iso(x + w, y, z1), iso(x + w, y + d, z1), iso(x, y + d, z1)]), fill: color }, g);
        if (extra) extra(g);
      }
    });
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
    items.push({
      depth: (x0 + x1) / 2 + (y0 + y1) / 2,
      draw: function (g) {
        s('polygon', {
          points: pts([iso(x0, y0, 0), iso(x1, y1, 0), iso(x1, y1, 22), iso(x0, y0, 22)]),
          fill: 'rgba(148,197,255,.10)', stroke: 'rgba(148,197,255,.32)', 'stroke-width': 0.8
        }, g);
      }
    });
  }
  function sign(g, p, label, strong) {
    var w = textW(label, 11) + 18;
    s('rect', { x: p[0] - w / 2, y: p[1] - 10, width: w, height: 20, rx: 10, fill: strong ? '#f5d680' : 'rgba(11,15,23,.82)', stroke: strong ? '#f5d680' : '#3a4763', 'stroke-width': 1 }, g);
    var t = s('text', { x: p[0], y: p[1] + 4, 'text-anchor': 'middle', 'font-size': 11, 'font-weight': 700, fill: strong ? '#231a05' : '#cfd8ea' }, g);
    t.textContent = label;
  }

  function buildScene(world) {
    var W = 16, D = 12, WALL = 64, k, i;
    /* 바닥 슬래브 */
    s('polygon', { points: pts([iso(0, D), iso(W, D), iso(W, D, -12), iso(0, D, -12)]), fill: '#0d1424' }, world);
    s('polygon', { points: pts([iso(W, 0), iso(W, D), iso(W, D, -12), iso(W, 0, -12)]), fill: '#0a101c' }, world);
    ZONE_ORDER.forEach(function (key) {
      var r = ZONES[key].rect;
      s('polygon', { points: pts([iso(r[0], r[1]), iso(r[2], r[1]), iso(r[2], r[3]), iso(r[0], r[3])]), fill: ZONES[key].tint, stroke: 'rgba(255,255,255,.10)', 'stroke-width': 1 }, world);
    });
    for (i = 1; i < W; i++) s('line', { x1: iso(i, 0)[0], y1: iso(i, 0)[1], x2: iso(i, D)[0], y2: iso(i, D)[1], stroke: 'rgba(255,255,255,.035)' }, world);
    for (i = 1; i < D; i++) s('line', { x1: iso(0, i)[0], y1: iso(0, i)[1], x2: iso(W, i)[0], y2: iso(W, i)[1], stroke: 'rgba(255,255,255,.035)' }, world);
    /* 뒷벽 */
    s('polygon', { points: pts([iso(0, 0), iso(W, 0), iso(W, 0, WALL), iso(0, 0, WALL)]), fill: '#1b2439' }, world);
    s('polygon', { points: pts([iso(0, 0), iso(0, D), iso(0, D, WALL), iso(0, 0, WALL)]), fill: '#141b2d' }, world);
    [[0.6, 2.0], [2.8, 4.4], [11.6, 13.2], [13.8, 15.4]].forEach(function (w) {
      s('polygon', { points: pts([iso(w[0], 0, 18), iso(w[1], 0, 18), iso(w[1], 0, 46), iso(w[0], 0, 46)]), fill: 'rgba(125,211,252,.16)', stroke: 'rgba(125,211,252,.35)', 'stroke-width': 0.8 }, world);
    });
    /* 회의실 스크린 */
    s('polygon', { points: pts([iso(6.6, 0, 16), iso(9.6, 0, 16), iso(9.6, 0, 44), iso(6.6, 0, 44)]), fill: '#0b1f33', stroke: '#5eead4', 'stroke-width': 1 }, world);
    for (k = 0; k < 3; k++) s('line', { x1: iso(6.9, 0, 38 - k * 8)[0], y1: iso(6.9, 0, 38 - k * 8)[1], x2: iso(8.6 - k * 0.5, 0, 38 - k * 8)[0], y2: iso(8.6 - k * 0.5, 0, 38 - k * 8)[1], stroke: 'rgba(94,234,212,.7)', 'stroke-width': 1.6 }, world);
    [[1.2, 3.0], [4.2, 6.0], [7.2, 9.0], [10.0, 11.4]].forEach(function (w) {
      s('polygon', { points: pts([iso(0, w[0], 18), iso(0, w[1], 18), iso(0, w[1], 46), iso(0, w[0], 46)]), fill: 'rgba(125,211,252,.10)', stroke: 'rgba(125,211,252,.25)', 'stroke-width': 0.8 }, world);
    });

    var items = [];
    /* 유리 칸막이(문 자리는 비움) */
    for (i = 0; i < W; i++) if (i !== 2 && i !== 8 && i !== 13) glass(items, i, 5, i + 1, 5);
    for (i = 0; i < 5; i++) if (i !== 3) { glass(items, 5, i, 5, i + 1); }
    for (i = 0; i < D; i++) if (i !== 2 && i !== 6 && i !== 9) glass(items, 11, i, 11, i + 1);
    /* 대표실 */
    box(items, 1.2, 1.7, 2.4, 1.0, 0, 15, '#7a5a40');
    box(items, 2.1, 0.8, 0.7, 0.6, 0, 22, '#8b6fd6');
    box(items, 0.2, 0.3, 0.5, 1.6, 0, 40, '#4a3b2c');
    plant(items, 4.3, 0.5);
    /* 회의실 */
    box(items, 6.9, 1.9, 3.2, 1.5, 0, 13, '#4a5f8a');
    /* 라운지 */
    box(items, 11.8, 0.25, 3.2, 0.3, 0, 22, '#8a4f6c');
    box(items, 11.8, 0.55, 3.2, 0.8, 0, 11, '#a35f80');
    box(items, 12.9, 2.7, 1.2, 0.8, 0, 7, '#5b6478');
    plant(items, 15.4, 0.4);
    box(items, 15.3, 4.2, 0.6, 0.6, 0, 30, '#3d8f8a');
    /* 실무 데스크 */
    DESKS.forEach(function (d) {
      box(items, d[0], d[1], 1.7, 0.8, 0, 13, '#3d4b69');
      box(items, d[0] + 0.5, d[1] + 0.12, 0.7, 0.1, 13, 26, '#0f1626', function (g) {
        s('polygon', { points: pts([iso(d[0] + 0.55, d[1] + 0.22, 15), iso(d[0] + 1.15, d[1] + 0.22, 15), iso(d[0] + 1.15, d[1] + 0.22, 24.5), iso(d[0] + 0.55, d[1] + 0.22, 24.5)]), fill: 'rgba(94,234,212,.55)' }, g);
      });
    });
    /* 안내 데스크 */
    box(items, 11.9, 8.0, 3.6, 0.7, 0, 17, '#4c6076', function (g) {
      var p = iso(13.7, 8.7, 8);
      var t = s('text', { x: p[0], y: p[1] + 3, 'text-anchor': 'middle', 'font-size': 8, 'font-weight': 800, fill: 'rgba(230,235,245,.8)', 'letter-spacing': 2 }, g);
      t.textContent = 'INFO';
    });
    plant(items, 15.3, 11.2);
    return items;
  }

  function spotsFor(agents) {
    var used = {}, out = {};
    agents.forEach(function (a) {
      var z = ZONES[a.zone], n = used[a.zone] || 0, p;
      if (n < z.spots.length) p = z.spots[n];
      else {
        var r = z.rect, hh = hash(a.id + n);
        p = [r[0] + 0.7 + (hh % 100) / 100 * (r[2] - r[0] - 1.4), r[1] + 0.9 + ((hh >> 8) % 100) / 100 * (r[3] - r[1] - 1.5)];
      }
      used[a.zone] = n + 1;
      out[a.id] = p;
    });
    return out;
  }

  function drawBot(g, a, p, overlay) {
    var st = STATUS[a.status];
    var c = iso(p[0], p[1]);
    var bot = s('g', { 'class': 'bot s-' + a.status, transform: 'translate(' + c[0].toFixed(1) + ',' + c[1].toFixed(1) + ')', tabindex: 0, role: 'button', 'aria-label': a.name + ' ' + st.label }, g);
    s('ellipse', { cx: 0, cy: 0, rx: 12, ry: 5.5, fill: 'rgba(0,0,0,.38)' }, bot);
    s('ellipse', { 'class': 'bot-ring', cx: 0, cy: 0, rx: 16, ry: 7.5, fill: 'none', stroke: st.color, 'stroke-width': 1.5 }, bot);
    var body = s('g', { 'class': 'bot-body' }, bot);
    s('rect', { x: -6.5, y: -5, width: 5, height: 5, rx: 2, fill: shade(a.color, 0.55) }, body);
    s('rect', { x: 1.5, y: -5, width: 5, height: 5, rx: 2, fill: shade(a.color, 0.55) }, body);
    s('rect', { x: -9, y: -24, width: 18, height: 21, rx: 8, fill: shade(a.color, 0.8) }, body);
    s('rect', { x: -4, y: -17, width: 8, height: 6, rx: 2, fill: 'rgba(11,15,23,.35)' }, body);
    s('rect', { x: -11.5, y: -44, width: 23, height: 21, rx: 9.5, fill: a.color }, body);
    s('rect', { x: -8.5, y: -39, width: 17, height: 10, rx: 5, fill: '#0d1320' }, body);
    if (a.status === 'offline') {
      s('line', { x1: -5, y1: -34, x2: -2, y2: -34, stroke: '#64748b', 'stroke-width': 1.6, 'stroke-linecap': 'round' }, body);
      s('line', { x1: 2, y1: -34, x2: 5, y2: -34, stroke: '#64748b', 'stroke-width': 1.6, 'stroke-linecap': 'round' }, body);
    } else if (a.status === 'resting') {
      s('path', { d: 'M-5.5 -34.5 q1.7 2 3.4 0 M2.1 -34.5 q1.7 2 3.4 0', fill: 'none', stroke: st.color, 'stroke-width': 1.5, 'stroke-linecap': 'round' }, body);
      var zz = s('text', { 'class': 'bot-zz', x: 11, y: -46, 'font-size': 9, 'font-weight': 800, fill: st.color }, body);
      zz.textContent = 'z';
    } else {
      s('circle', { cx: -3.6, cy: -34, r: 1.9, fill: st.color }, body);
      s('circle', { cx: 3.6, cy: -34, r: 1.9, fill: st.color }, body);
    }
    if (a.src === 'pickle') {
      s('line', { x1: -5, y1: -44, x2: -7, y2: -50, stroke: shade(a.color, 0.7), 'stroke-width': 1.6 }, body);
      s('line', { x1: 5, y1: -44, x2: 7, y2: -50, stroke: shade(a.color, 0.7), 'stroke-width': 1.6 }, body);
      s('circle', { 'class': 'bot-lamp', cx: -7.5, cy: -51.5, r: 2.4, fill: st.color }, body);
      s('circle', { 'class': 'bot-lamp', cx: 7.5, cy: -51.5, r: 2.4, fill: st.color }, body);
    } else {
      s('line', { x1: 0, y1: -44, x2: 0, y2: -50, stroke: shade(a.color, 0.7), 'stroke-width': 1.6 }, body);
      s('circle', { 'class': 'bot-lamp', cx: 0, cy: -52.5, r: 3, fill: st.color }, body);
    }
    /* 이름 + 상태 배지 + 말풍선: 가구에 가리지 않게 맨 위 층에 그린다 */
    var pick = function (ev) { ev.stopPropagation(); if (!drag.moved) openPopup(a.id); };
    bot.addEventListener('click', pick);
    bot.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openPopup(a.id); } });
    bot = s('g', { transform: 'translate(' + c[0].toFixed(1) + ',' + c[1].toFixed(1) + ')', opacity: a.status === 'offline' ? 0.55 : 1 }, overlay);
    bot.style.cursor = 'pointer';
    bot.addEventListener('click', pick);
    var label = a.name, lw = textW(label, 9) + 22;
    s('rect', { x: -lw / 2, y: 6, width: lw, height: 14, rx: 7, fill: 'rgba(11,15,23,.88)', stroke: st.color, 'stroke-width': 0.9 }, bot);
    s('circle', { cx: -lw / 2 + 8, cy: 13, r: 2.6, fill: st.color }, bot);
    var nt = s('text', { x: 5, y: 16.2, 'text-anchor': 'middle', 'font-size': 9, 'font-weight': 600, fill: '#e6ebf5' }, bot);
    nt.textContent = label;
    /* 말풍선 */
    if (a.bubble && (a.status === 'working' || a.status === 'meeting' || a.status === 'resting')) {
      var bt = str(a.bubble, 16), bw = textW(bt, 9) + 14;
      s('rect', { x: -bw / 2, y: -76, width: bw, height: 16, rx: 8, fill: '#f8fafc' }, bot);
      s('polygon', { points: '-4,-61 4,-61 0,-56', fill: '#f8fafc' }, bot);
      var tt = s('text', { x: 0, y: -64.8, 'text-anchor': 'middle', 'font-size': 9, 'font-weight': 600, fill: '#0f172a' }, bot);
      tt.textContent = bt;
    }
  }

  function renderMap() {
    var world = $('world');
    while (world.firstChild) world.removeChild(world.firstChild);
    var items = buildScene(world);
    var spots = spotsFor(state.agents);
    state.agents.forEach(function (a) {
      var p = spots[a.id];
      items.push({ depth: p[0] + p[1], draw: function (g) { drawBot(g, a, p, overlay); } });
    });
    var overlay = s('g', {});
    items.sort(function (a, b) { return a.depth - b.depth; });
    items.forEach(function (it) { it.draw(world); });
    world.appendChild(overlay);
    /* 구역 표지 */
    sign(world, iso(2.5, 0, 56), ZONES.ceo.label, true);
    sign(world, iso(8.1, 0, 56), ZONES.meeting.label);
    sign(world, iso(13.5, 0, 56), ZONES.lounge.label);
    sign(world, iso(0, 8.5, 56), ZONES.desk.label);
    sign(world, iso(13.6, 11.75, 0), ZONES.reception.label);
    applyView();
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
    var nk = Math.max(0.7, Math.min(3, v.k * f));
    v.x = cx - (cx - v.x) * (nk / v.k);
    v.y = cy - (cy - v.y) * (nk / v.k);
    v.k = nk;
    applyView();
  }
  function svgScale() {
    var r = $('map').getBoundingClientRect();
    return Math.max(920 / r.width, 580 / r.height);
  }
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
  }

  /* ---------- popup ---------- */
  function agentLogs(a) {
    return state.logs.filter(function (l) { return l.src === a.src && l.agent && (l.agent === a.rawId || l.agent === a.name); });
  }
  function logItem(l) {
    var li = h('li');
    li.appendChild(h('time', null, l.timeText));
    var b = h('div');
    b.appendChild(h('div', 'lt', l.title || '활동'));
    if (l.detail) b.appendChild(h('div', 'ld', l.detail));
    li.appendChild(b);
    return li;
  }
  function badge(status) {
    var st = STATUS[status], b = h('span', 'badge', st.label);
    b.style.color = st.color;
    return b;
  }
  function openPopup(id) {
    var a = null;
    state.agents.forEach(function (x) { if (x.id === id) a = x; });
    if (!a) { closePopup(); return; }
    state.popupId = id;
    var st = STATUS[a.status];
    $('popAvatar').textContent = a.name.slice(0, 1);
    $('popAvatar').style.background = a.color;
    $('popName').textContent = a.name;
    $('popRole').textContent = a.role || '역할 미지정';
    var pb = $('popBadge'); pb.textContent = st.label; pb.style.color = st.color;
    var meta = $('popMeta');
    meta.textContent = '';
    [['위치', ZONES[a.zone].label], ['현재 작업', a.task || '없음'], ['한마디', a.bubble || '–'],
      ['마지막 활동', a.last ? fmtMDHM(a.last) + ' (' + ago(a.last) + ')' : '기록 없음'], ['데이터', a.srcLabel]].forEach(function (r) {
      meta.appendChild(h('dt', null, r[0])); meta.appendChild(h('dd', null, r[1]));
    });
    var ul = $('popLogs'); ul.textContent = '';
    var ls = agentLogs(a).slice(0, 8);
    if (!ls.length) ul.appendChild(h('li', 'empty', '오늘 기록된 작업이 없습니다'));
    ls.forEach(function (l) { ul.appendChild(logItem(l)); });
    $('popup').hidden = false;
  }
  function closePopup() { state.popupId = null; $('popup').hidden = true; }

  /* ---------- sidebar ---------- */
  function agentRow(a) {
    var b = h('button', 'row'); b.type = 'button';
    var d = h('span', 'dot'); d.style.background = STATUS[a.status].color; b.appendChild(d);
    var who = h('span', 'who');
    var nm = h('span', 'nm', a.name); nm.appendChild(h('span', 'src', a.srcLabel)); who.appendChild(nm);
    who.appendChild(h('span', 'sub', a.task || a.role || ''));
    b.appendChild(who); b.appendChild(badge(a.status));
    b.addEventListener('click', function () { openPopup(a.id); });
    return b;
  }
  function renderTab() {
    var body = $('tabBody'); body.textContent = '';
    var A = state.agents;
    if (state.tab === 'office') {
      ZONE_ORDER.forEach(function (key) {
        var inZone = A.filter(function (a) { return a.zone === key; });
        var card = h('div', 'card'), hd = h('div', 'card-h', ZONES[key].label);
        hd.appendChild(h('span', 'cnt', inZone.length + '명')); card.appendChild(hd);
        if (inZone.length) {
          var chips = h('div', 'chips');
          inZone.forEach(function (a) {
            var c = h('button', 'chip'); c.type = 'button';
            var d = h('span', 'dot'); d.style.background = STATUS[a.status].color; c.appendChild(d);
            c.appendChild(document.createTextNode(a.name));
            c.addEventListener('click', function () { openPopup(a.id); });
            chips.appendChild(c);
          });
          card.appendChild(chips);
        }
        body.appendChild(card);
      });
    } else if (state.tab === 'tasks') {
      var busy = A.filter(function (a) { return a.status === 'working' || a.status === 'meeting'; });
      if (!busy.length) body.appendChild(h('div', 'empty', '지금 진행 중인 업무가 없습니다'));
      busy.forEach(function (a) {
        var card = h('div', 'card'), hd = h('div', 'card-h', a.name);
        var bd = badge(a.status); bd.style.marginLeft = 'auto'; hd.appendChild(bd); card.appendChild(hd);
        card.appendChild(h('div', 'sub', a.task || a.bubble || '작업 진행 중'));
        var m = h('div', 'ld', (a.role ? a.role + ' · ' : '') + ZONES[a.zone].label + (a.last ? ' · ' + ago(a.last) : ''));
        m.style.color = 'var(--muted)'; m.style.fontSize = '12px'; m.style.marginTop = '4px';
        card.appendChild(m);
        card.style.cursor = 'pointer';
        card.addEventListener('click', function () { openPopup(a.id); });
        body.appendChild(card);
      });
    } else if (state.tab === 'staff') {
      if (!A.length) body.appendChild(h('div', 'empty', '표시할 AI 직원이 없습니다'));
      A.forEach(function (a) { body.appendChild(agentRow(a)); });
    } else {
      var ul = h('ul', 'loglist'), ls = state.logs.slice(0, 60);
      if (!ls.length) body.appendChild(h('div', 'empty', '오늘 활동 로그가 없습니다'));
      ls.forEach(function (l) {
        var li = logItem(l), nameOf = l.agent;
        state.agents.forEach(function (a) { if (a.src === l.src && a.rawId === l.agent) nameOf = a.name; });
        if (nameOf) { var who = h('div', 'ld', nameOf); li.lastChild.insertBefore(who, li.lastChild.firstChild); }
        ul.appendChild(li);
      });
      if (ls.length) body.appendChild(ul);
    }
  }

  function renderSide() {
    var A = state.agents;
    var work = A.filter(function (a) { return a.status === 'working' || a.status === 'meeting'; }).length;
    var idle = A.filter(function (a) { return a.status === 'idle' || a.status === 'resting'; }).length;
    $('kDone').textContent = state.summary.done;
    $('kWork').textContent = work;
    $('kIdle').textContent = idle;
    $('kAll').textContent = A.length;
    var foot = $('footStatus'); foot.textContent = '';
    var anyOk = false, anyLate = false;
    SOURCES.forEach(function (src) {
      var i = state.sources[src.key] || { ok: false };
      var row = h('div'), cls, txt;
      if (!i.ok) { cls = 'bad'; txt = '불러오지 못함'; anyLate = true; }
      else if (!i.updated) { cls = 'late'; txt = '시각 정보 없음'; anyOk = true; anyLate = true; }
      else if (i.stale) { cls = 'late'; txt = fmtMDHM(i.updated) + ' · 갱신 지연(' + ago(i.updated) + ')'; anyOk = true; anyLate = true; }
      else { cls = 'ok'; txt = fmtMDHM(i.updated) + ' · 정상'; anyOk = true; }
      row.appendChild(document.createTextNode(src.label + ' '));
      row.appendChild(h('span', cls, txt));
      foot.appendChild(row);
    });
    $('liveDot').classList.toggle('warn', anyLate);
    var msg = $('mapMsg');
    if (!anyOk) { msg.hidden = false; msg.textContent = '상태 파일을 불러오지 못했습니다. 잠시 뒤 자동으로 다시 시도합니다.'; }
    else msg.hidden = true;
    renderTab();
  }

  function renderAll() {
    renderMap();
    renderSide();
    if (state.popupId) openPopup(state.popupId);
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
        renderTab();
      });
    });
    $('popClose').addEventListener('click', closePopup);
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closePopup(); });
    function tick() { var d = new Date(); $('clock').textContent = fmtMDHM(d); }
    tick(); setInterval(tick, 15000);
  }

  initSide();
  initMapControls();
  renderAll();
  /* 미리보기용: ?tab=logs&open=직원id */
  var qs = new URLSearchParams(location.search);
  if (/^(office|tasks|staff|logs)$/.test(qs.get('tab') || '')) {
    var tb = document.querySelector('.tabs button[data-tab="' + qs.get('tab') + '"]');
    if (tb) tb.click();
  }
  refresh().then(function () { if (qs.get('open')) openPopup(qs.get('open')); });
  setInterval(refresh, REFRESH_MS);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
})();
