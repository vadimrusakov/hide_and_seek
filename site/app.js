/* Seek Map — hide-and-seek helper (Jet Lag style).
   Engine: the region is a grid of square cells (30 m). Every question becomes a per-cell test.
   A stop stays possible while its hiding circle still touches cells that agree with each answer
   (checked per question, because the hider may move inside their circle between questions). */
(function () {
'use strict';
const CFG = window.SEEK_CONFIG;
const APP_VERSION = '2026-10-17.6';
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} }
};
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const dec = a => { const o = []; let x = 0, y = 0; for (let i = 0; i < a.length; i += 2) { x += a[i]; y += a[i + 1]; o.push([y / 1e5, x / 1e5]); } return o; };
const decPoly = p => p.map(dec);
const fmtD = m => !isFinite(m) ? '—' : m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(m < 10000 ? 2 : 1) + ' km';
const fmtA = m2 => (m2 / 1e6).toFixed(m2 < 1e7 ? 2 : 1) + ' km²';
const ago = t => { if (!t) return ''; const s = Math.max(0, (Date.now() - t) / 1000); return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + ' min ago' : Math.floor(s / 3600) + ' h ago'; };
const nf = n => n.toLocaleString('en-GB');
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/* ------------------------------------------------------------------ state */
const S = {
  pack: null, mode: null, code: null, role: 'seeker', name: LS.get('seek-name', ''), uid: null,
  game: {}, L: null, sig: '', me: null, hider: null, conn: null,
  ui: {
    tab: null, sheetMin: false,
    ask: { type: 'radar', r: 1000, td: 1000, cat: 'museum', pins: [], active: 0 },
    list: { cid: 'stops', q: '', edit: null, adding: null },
    layers: Object.assign({ mask: true, zones: true, stops: 'possible', cats: {}, base: 'osm', still: true }, LS.get('seek-layers', {})),
    tool: { mode: null, r: 1000, a: null },
    sound: LS.get('seek-sound', true), wake: LS.get('seek-wake', false),
    confirm: null
  },
  seenQ: new Set(), seenA: new Set(), firstSync: true
};

/* ------------------------------------------------------------------ backends */
function setPath(o, p, v) {
  const ks = p.split('/'); let c = o;
  for (let i = 0; i < ks.length - 1; i++) { if (typeof c[ks[i]] !== 'object' || c[ks[i]] === null) c[ks[i]] = {}; c = c[ks[i]]; }
  if (v === null || v === undefined) delete c[ks[ks.length - 1]]; else c[ks[ks.length - 1]] = v;
}
const FB = {
  kind: 'fb',
  async init() {
    if (!window.firebase) throw new Error('The sync service did not load. Check your connection, or practise on this device.');
    if (!firebase.apps.length) firebase.initializeApp(CFG.firebase);
    const cred = await firebase.auth().signInAnonymously();
    this.uid = cred.user.uid; this.db = firebase.database();
  },
  ref(code, p) { return this.db.ref('games/' + code + (p ? '/' + p : '')); },
  async exists(code) { const s = await this.ref(code, 'meta').get(); return s.exists(); },
  open(code, cb) {
    this.r = this.ref(code);
    this.r.on('value', s => cb(s.val() || {}), e => toast('Sync stopped: ' + e.message));
    this.db.ref('.info/connected').on('value', s => setConn(!!s.val()));
    this.db.ref('.info/serverTimeOffset').on('value', s => { S.offset = s.val() || 0; });
  },
  close() { if (this.r) this.r.off(); this.db && this.db.ref('.info/connected').off(); },
  set(code, p, v) { return this.ref(code, p).set(v).catch(e => toast('Could not save: ' + e.message)); },
  push(code, p, v) { const r = this.ref(code, p).push(); r.set(v).catch(e => toast('Could not save: ' + e.message)); return r.key; },
  now() { return firebase.database.ServerValue.TIMESTAMP; }
};
const LOCAL = {
  kind: 'local',
  async init() {
    let u = null; try { u = sessionStorage.getItem('seek-local-uid'); } catch (e) {}
    this.uid = u || ('local' + Math.random().toString(36).slice(2, 10));
    try { sessionStorage.setItem('seek-local-uid', this.uid); } catch (e) {}
    this.bc = 'BroadcastChannel' in window ? new BroadcastChannel('seek-local') : null;
  },
  key(code) { return 'seek-local:' + code; },
  load(code) { return LS.get(this.key(code), null); },
  save(code, o) { LS.set(this.key(code), o); this.bc && this.bc.postMessage(code); if (this.code === code && this.cb) this.cb(o || {}); },
  async exists(code) { return !!this.load(code); },
  open(code, cb) {
    this.code = code; this.cb = cb;
    const f = () => this.cb && this.cb(this.load(code) || {});
    if (this.bc) this.bc.onmessage = e => { if (e.data === code) f(); };
    f(); setConn(true);
  },
  close() { this.cb = null; },
  set(code, p, v) { const o = this.load(code) || {}; setPath(o, p, v); this.save(code, o); },
  push(code, p, v) { const k = Date.now().toString(36) + Math.random().toString(36).slice(2, 6); this.set(code, p + '/' + k, v); return k; },
  now() { return Date.now(); }
};
let B = null;
const W = {
  set: (p, v) => B.set(S.code, p, v),
  push: (p, v) => B.push(S.code, p, v)
};

/* ------------------------------------------------------------------ grid engine */
let G = null;
function makeGrid(g) {
  const { lon0, lat1, kx, ky, cell, nx, ny } = g, N = nx * ny;
  const X = lo => (lo - lon0) * kx, Y = la => (lat1 - la) * ky;
  const lonOf = x => lon0 + x / kx, latOf = y => lat1 - y / ky;
  return {
    nx, ny, N, cell, X, Y, lonOf, latOf, kx0: kx,
    idx(la, lo) { const i = Math.floor(X(lo) / cell), j = Math.floor(Y(la) / cell); return (i < 0 || j < 0 || i >= nx || j >= ny) ? -1 : j * nx + i; },
    cx(k) { return (k % nx + 0.5) * cell; }, cy(k) { return (Math.floor(k / nx) + 0.5) * cell; },
    bounds: [[latOf(ny * cell), lon0], [lat1, lonOf(nx * cell)]]
  };
}
// Exact Euclidean distance transform with nearest-site labels (Felzenszwalb & Huttenlocher).
function edt(sites) {
  const nx = G.nx, ny = G.ny, N = G.N, INF = 1e12;
  const g = new Float64Array(N), r = new Int32Array(N);
  for (let x = 0; x < nx; x++) {
    let last = -1;
    for (let y = 0; y < ny; y++) { const k = y * nx + x; if (sites[k]) { last = y; g[k] = 0; r[k] = y; } else if (last >= 0) { g[k] = y - last; r[k] = last; } else { g[k] = INF; r[k] = -1; } }
    let next = -1;
    for (let y = ny - 1; y >= 0; y--) { const k = y * nx + x; if (sites[k]) next = y; else if (next >= 0 && next - y < g[k]) { g[k] = next - y; r[k] = next; } }
  }
  const D = new Float32Array(N), F = new Int32Array(N);
  const f = new Float64Array(nx), v = new Int32Array(nx), z = new Float64Array(nx + 1);
  for (let y = 0; y < ny; y++) {
    const row = y * nx;
    for (let x = 0; x < nx; x++) { const gv = g[row + x]; f[x] = gv >= INF ? INF : gv * gv; }
    let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
    for (let q = 1; q < nx; q++) {
      let p = v[k], s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p);
      while (s <= z[k]) { k--; p = v[k]; s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p); }
      k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
    }
    k = 0;
    for (let q = 0; q < nx; q++) {
      while (z[k + 1] < q) k++;
      const p = v[k], d = (q - p) * (q - p) + f[p];
      if (d >= INF / 2) { D[row + q] = Infinity; F[row + q] = 0; }
      else { D[row + q] = Math.sqrt(d); F[row + q] = sites[r[row + p] * nx + p]; }
    }
  }
  return { D, F };
}
let RC = null;
function rctx() {
  if (!RC) { RC = document.createElement('canvas'); RC.width = G.nx; RC.height = G.ny; }
  const c = RC.getContext('2d', { willReadFrequently: true });
  c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, G.nx, G.ny); return c;
}
const labCol = l => `rgb(${(l >> 16) & 255},${(l >> 8) & 255},${l & 255})`;
function pathRings(c, polys) {
  c.beginPath();
  polys.forEach(rings => rings.forEach(r => { r.forEach((p, m) => { const x = G.X(p[1]) / G.cell, y = G.Y(p[0]) / G.cell; m ? c.lineTo(x, y) : c.moveTo(x, y); }); c.closePath(); }));
}
function readLabels(c, sites, thr) {
  const d = c.getImageData(0, 0, G.nx, G.ny).data;
  for (let k = 0, j = 0; k < G.N; k++, j += 4) if (d[j + 3] >= thr) { const l = (d[j] << 16) | (d[j + 1] << 8) | d[j + 2]; if (l) sites[k] = l; }
}
function rasterPolys(list, thr) { // list: [{polys,label}]
  const sites = new Int32Array(G.N), c = rctx();
  list.forEach(it => { c.fillStyle = labCol(it.label); pathRings(c, it.polys); c.fill('evenodd'); });
  readLabels(c, sites, thr); return sites;
}

let BASE = null; // {inside, excl}
function buildBase() {
  const P = S.pack;
  const inside = rasterPolys([{ polys: P.boundary.map(decPoly), label: 1 }], 128);
  const ex = P.zones.filter(z => z.t === 'exclude').map(z => ({ polys: z.g.map(decPoly), label: 1 }));
  const excl = rasterPolys(ex, 128);
  BASE = { inside, excl, cache: {} };
}
function baseMask() {
  const safe = S.game.meta?.safety !== false, key = 's' + safe;
  if (BASE.cache[key]) return BASE.cache[key];
  const m = new Uint8Array(G.N);
  for (let k = 0; k < G.N; k++) m[k] = BASE.inside[k] && !(safe && BASE.excl[k]) ? 1 : 0;
  return (BASE.cache[key] = m);
}

/* ------------------------------------------------------------------ lists (defaults + game overrides) */
function buildLists() {
  const ov = S.game.lists || {}, P = S.pack;
  const mk = (cid, base, map) => {
    const o = ov[cid] || {}, off = o.off || {}, ren = o.ren || {}, add = o.add || {};
    const items = base.map(b => Object.assign(map(b), { id: b[0], n: ren[b[0]] ?? b[1], la: b[2], lo: b[3], on: !off[b[0]], added: false }));
    Object.entries(add).forEach(([k, a]) => { if (a && isFinite(a.la)) items.push({ id: 'a' + k, key: k, n: ren['a' + k] ?? a.n, la: a.la, lo: a.lo, on: !off['a' + k], added: true }); });
    return items;
  };
  const L = { stops: mk('stops', P.stops, b => ({ mode: b[4] })), cats: {} };
  P.cats.forEach(c => { L.cats[c.id] = { id: c.id, label: c.label, kind: c.kind, only: c.only, items: mk(c.id, c.items, b => c.kind === 'area' ? { polys: b._polys } : c.kind === 'line' ? { lines: b._lines } : {}) }; });
  L.stops.forEach(s => { s.k = G.idx(s.la, s.lo); });
  S.L = L;
  S.sig = JSON.stringify(ov).length + ':' + hashStr(JSON.stringify(ov));
}
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
const activeStops = () => S.L.stops.filter(s => s.on && s.k >= 0);

/* ------------------------------------------------------------------ category distance fields */
const FC = new Map();
function catField(cid) {
  const key = cid + '|' + S.sig; if (FC.has(key)) return FC.get(key);
  const L = S.L.cats[cid], items = L.items.filter(i => i.on), N = G.N, c = G.cell;
  let sites = new Int32Array(N); const outside = [];
  if (L.kind === 'area') {
    sites = rasterPolys(items.map((it, ix) => it.polys ? { polys: it.polys, label: ix + 1 } : null).filter(Boolean), 255);
  } else if (L.kind === 'line') {
    const cx = rctx(); cx.lineWidth = 1.5;
    items.forEach((it, ix) => { if (!it.lines) return; cx.strokeStyle = labCol(ix + 1); cx.beginPath(); it.lines.forEach(l => l.forEach((p, m) => { const x = G.X(p[1]) / c, y = G.Y(p[0]) / c; m ? cx.lineTo(x, y) : cx.moveTo(x, y); })); cx.stroke(); });
    readLabels(cx, sites, 40);
  }
  items.forEach((it, ix) => {
    if (L.kind === 'line' && it.lines) return;
    const k = G.idx(it.la, it.lo);
    if (k >= 0) { if (!sites[k]) sites[k] = ix + 1; } else outside.push([ix + 1, G.X(it.lo), G.Y(it.la)]);
  });
  const { D, F } = edt(sites), Dm = new Float32Array(N);
  const exact = items.map(it => L.kind === 'point' || !it.polys);
  let maxD = 0;
  for (let k = 0; k < N; k++) {
    const l = F[k];
    if (!l) { Dm[k] = Infinity; continue; }
    if (exact[l - 1] && L.kind !== 'line') { const it = items[l - 1]; Dm[k] = Math.hypot(G.cx(k) - G.X(it.lo), G.cy(k) - G.Y(it.la)); }
    else Dm[k] = D[k] * c;
    if (Dm[k] > maxD) maxD = Dm[k];
  }
  if (!items.length) maxD = Infinity;
  const W_ = G.nx * c, H_ = G.ny * c;
  outside.forEach(([l, x, y]) => {
    const dx = Math.max(0, -x, x - W_), dy = Math.max(0, -y, y - H_);
    if (Math.hypot(dx, dy) > maxD) return;
    for (let k = 0; k < N; k++) { const d = Math.hypot(G.cx(k) - x, G.cy(k) - y); if (d < Dm[k]) { Dm[k] = d; F[k] = l; } }
  });
  const out = { items, D: Dm, F };
  FC.set(key, out); return out;
}
function nearestAt(cid, la, lo) {
  const k = G.idx(la, lo); if (k < 0) return null;
  const f = catField(cid), l = f.F[k];
  return l ? { item: f.items[l - 1], d: f.D[k], k } : null;
}

/* ------------------------------------------------------------------ questions */
const QT = {
  radar: { label: 'Radar', ans: ['yes', 'no'], names: { yes: 'Yes', no: 'No' } },
  thermo: { label: 'Thermometer', ans: ['hotter', 'colder'], names: { hotter: 'Hotter', colder: 'Colder' } },
  measure: { label: 'Measuring', ans: ['closer', 'further'], names: { closer: 'Closer', further: 'Further' } },
  match: { label: 'Matching', ans: ['yes', 'no'], names: { yes: 'Same', no: 'Different' } },
  photo: { label: 'Photo', ans: ['sent'], names: { sent: 'Photo sent' } }
};
Object.assign(QT.radar, { short: 'Radar' }); Object.assign(QT.thermo, { short: 'Thermo' }); Object.assign(QT.measure, { short: 'Measure' }); Object.assign(QT.match, { short: 'Match' }); Object.assign(QT.photo, { short: 'Photo' });
const PHOTOS = [
  ['tree', 'A tree', 'Send a photo of a tree.'],
  ['sky', 'The sky', 'Send a photo of the sky.'],
  ['selfie', 'Selfie', 'Send a selfie.'],
  ['widest', 'Widest street', 'Send a photo of the widest street you can see.'],
  ['tallest', 'Tallest structure', 'Send a photo of the tallest structure in your sightline.'],
  ['building', 'Building from your stop', 'Send a photo of any building visible from your stop.'],
  ['trace', 'Trace nearest street or path', 'Trace the nearest street or path on a map and send it.']
];
const CARDS = { match: [3, 1], measure: [3, 1], thermo: [2, 1], radar: [2, 1], photo: [1, 1] };
const cardText = t => `Draw ${CARDS[t][0]} · keep ${CARDS[t][1]}`;
const cardChip = (q, late) => `<span class="cards${late ? ' none' : ''}" title="Cards the hider draws for answering">${late ? 'No draw (late)' : cardText(q.type)}</span>`;
const THERMO = [1000, 5000];
function qKey(q) { const p = q.p || {}; return q.type === 'radar' ? 'radar:' + p.r : q.type === 'thermo' ? 'thermo:' + (p.td || 0) : q.type === 'photo' ? 'photo:' + (p.subj || '') : q.type + ':' + p.cat; }
const usedKeys = () => new Set(allQs().map(qKey));
const isDeduce = q => q.type !== 'photo';
const catLabel = cid => (S.L.cats[cid]?.label || cid);
function qText(q) {
  const p = q.p || {};
  if (q.type === 'photo') return p.text || `Send a photo of ${p.subj || 'something'}.`;
  if (q.type === 'radar') return `Are you within ${fmtD(p.r)} of me?`;
  if (q.type === 'thermo') return `${p.td ? fmtD(p.td) + ' thermometer: I' : 'I'} moved ${fmtD(dm(p.la1, p.lo1, p.la2, p.lo2))}. Am I hotter or colder?`;
  if (q.type === 'measure') return p.cat === 'coast' ? 'Compared to me, are you closer to or further from the coastline?' : `Compared to me, are you closer to or further from the nearest ${catLabel(p.cat).toLowerCase()}?`;
  if (q.type === 'match') return p.cat === 'ward' ? 'Are you in the same council ward as me?' : `Is your nearest ${catLabel(p.cat).toLowerCase()} the same as mine?`;
  return '';
}
function qRef(q) {
  const p = q.p || {};
  if (q.type === 'measure') return `Mine: ${p.refName || '—'}, ${fmtD(p.ref)}`;
  if (q.type === 'match') return `Mine: ${p.refName || '—'}`;
  return '';
}
function dm(la1, lo1, la2, lo2) { return Math.hypot(G.X(lo1) - G.X(lo2), G.Y(la1) - G.Y(la2)); }
// Per-cell test: 1 where a hider standing in that cell would give answer `ans`.
function consMask(q, ans) {
  const N = G.N, out = new Uint8Array(N), p = q.p, pos = QT[q.type].ans[0] === ans;
  if (q.type === 'radar') {
    const px = G.X(p.lo), py = G.Y(p.la), r2 = p.r * p.r;
    for (let k = 0; k < N; k++) { const dx = G.cx(k) - px, dy = G.cy(k) - py; out[k] = ((dx * dx + dy * dy) <= r2) === pos ? 1 : 0; }
  } else if (q.type === 'thermo') {
    const ax = G.X(p.lo1), ay = G.Y(p.la1), bx = G.X(p.lo2), by = G.Y(p.la2);
    for (let k = 0; k < N; k++) { const x = G.cx(k), y = G.cy(k); const hot = (x - bx) ** 2 + (y - by) ** 2 < (x - ax) ** 2 + (y - ay) ** 2; out[k] = hot === pos ? 1 : 0; }
  } else if (q.type === 'measure') {
    const f = catField(p.cat), ref = p.ref + 1e-6;
    for (let k = 0; k < N; k++) out[k] = (f.D[k] <= ref) === pos ? 1 : 0;
  } else if (q.type === 'match') {
    const f = catField(p.cat); const li = f.items.findIndex(i => i.id === p.refId) + 1;
    for (let k = 0; k < N; k++) out[k] = ((li > 0 && f.F[k] === li)) === pos ? 1 : 0;
  }
  return out;
}
function answerAt(q, la, lo) {
  const k = G.idx(la, lo); if (k < 0) return null;
  const p = q.p, x = G.cx(k), y = G.cy(k), A = QT[q.type].ans;
  if (q.type === 'radar') { const d = Math.hypot(x - G.X(p.lo), y - G.Y(p.la)); return { a: d <= p.r ? A[0] : A[1], info: `You are ${fmtD(d)} from their pin.` }; }
  if (q.type === 'thermo') { const da = Math.hypot(x - G.X(p.lo1), y - G.Y(p.la1)), db = Math.hypot(x - G.X(p.lo2), y - G.Y(p.la2)); return { a: db < da ? A[0] : A[1], info: `${fmtD(da)} from where they started, ${fmtD(db)} from where they are now.` }; }
  const f = catField(p.cat), l = f.F[k], it = l ? f.items[l - 1] : null;
  if (q.type === 'measure') return { a: f.D[k] <= p.ref + 1e-6 ? A[0] : A[1], info: `Your nearest: ${it ? it.n : '—'}, ${fmtD(f.D[k])}. Theirs: ${fmtD(p.ref)}.` };
  if (q.type === 'match') return { a: it && it.id === p.refId ? A[0] : A[1], info: `Yours: ${it ? it.n : '—'}. Theirs: ${p.refName}.` };
}

/* ------------------------------------------------------------------ deduction */
const R = () => +(S.game.meta?.radius || CFG.defaults.radius);
const now = () => Date.now() + (S.offset || 0);
const hideMs = () => +(S.game.meta?.hideMin ?? CFG.defaults.hideMin) * 60000;
// game time: real time minus paused time; frozen while paused
function gT(t) { const m = S.game.meta || {}; const tt = m.pausedAt && t > m.pausedAt ? m.pausedAt : t; return tt - (m.pausedTotal || 0); }
const paused = () => !!(S.game.meta?.pausedAt) && !S.game.meta?.endedAt;
function phase() { const m = S.game.meta || {}; if (!m.startedAt) return 'lobby'; if (m.endedAt) return 'ended'; return gT(now()) < m.startedAt + hideMs() ? 'hiding' : 'seeking'; }
const limitMs = q => +((q.type === 'photo' ? S.game.meta?.photoMin ?? CFG.defaults.photoMin : S.game.meta?.ansMin ?? CFG.defaults.ansMin)) * 60000;
function qElapsed(q) { const asked = (q.t || 0) - (q.pt || 0); return q.a && q.at ? (q.at - (q.apt || 0)) - asked : gT(now()) - asked; }
const qLate = q => qElapsed(q) > limitMs(q);
const started = () => phase() !== 'lobby';
const roundKey = () => 'seek-hider:' + S.code + ':' + (S.game.meta?.round || 0);
const clock = ms => { ms = Math.max(0, ms); const t = Math.floor(ms / 1000), h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s2 = t % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s2).padStart(2, '0'); };
function timerText() {
  const m = S.game.meta || {}, p = phase();
  if (p === 'lobby') return 'Not started';
  const pz = paused() ? 'Paused · ' : '';
  if (p === 'hiding') return pz + 'Hiding · ' + clock(m.startedAt + hideMs() - gT(now())) + ' left';
  if (p === 'seeking') return pz + 'Seeking · ' + clock(gT(now()) - m.startedAt - hideMs());
  return 'Ended · found in ' + clock(gT(m.endedAt) - m.startedAt - hideMs());
}
function updateDue() { document.querySelectorAll('[data-due]').forEach(el => { const q = allQs().find(x => x.id === el.dataset.due); if (!q) return; const left = limitMs(q) - qElapsed(q); el.textContent = left >= 0 ? clock(left) + ' left' : 'time expired ' + clock(-left) + ' ago'; el.classList.toggle('late', left < 0); }); }
let lastPhase = null, lastPaused = null;
const lateSeen = new Set();
function checkLate() {
  if (!S.code || S.firstSync) return;
  allQs().forEach(q => {
    if (lateSeen.has(q.id)) return;
    const unansweredLate = !q.a && qElapsed(q) > limitMs(q) + 10000 && !paused();
    const answeredLate = q.a && q.at && qLate(q);
    if (!unansweredLate && !answeredLate && !q.late) return;
    lateSeen.add(q.id); LS.set('seek-late:' + S.code, [...lateSeen]);
    if (!q.late && S.game.qs?.[q.id]) W.set('qs/' + q.id + '/late', true);
    showModal('Answer time expired', `${QT[q.type].label}: “${qText(q)}”\nThe hider did not answer within ${Math.round(limitMs(q) / 60000)} min, so they skip the card draw for this question.`);
    alertUser('Answer time expired', `${qText(q)} The hider skips the card draw.`, 'late-' + q.id, [400, 150, 400]);
  });
}
function tick() {
  if (!S.code) return;
  const p = phase(), t = $('#tb-timer');
  if (t) { t.hidden = false; t.textContent = timerText(); t.className = 'tb-timer ph-' + (paused() ? 'paused' : p); }
  updateDue();
  checkLate();
  const pzNow = paused();
  if (lastPaused !== null && pzNow !== lastPaused) { alertUser(pzNow ? 'Game paused' : 'Game resumed', pzNow ? `Paused by ${S.game.meta?.pausedBy || 'a player'}. All clocks are stopped.` : 'Clocks are running again.', 'pause'); render(); }
  lastPaused = pzNow;
  if (lastPhase && p !== lastPhase) {
    const msg = { hiding: 'Game started. Hider, go to your stop!', seeking: 'Hiding time is over. Seekers can ask questions now.', ended: 'Game over.' }[p];
    if (msg) alertUser({ hiding: 'Game started', seeking: 'Seeking begins', ended: 'Game over' }[p], msg, 'phase', [300, 100, 300]);
    if (p === 'seeking' && S.role === 'hider' && !S.hider) toast('Hiding time is over and you have not locked a stop.', 8000);
    render();
  }
  lastPhase = p;
  const pt = $('#g-phase-timer'); if (pt) pt.textContent = timerText();
}
const TOL = () => G.cell * 0.71;
function stopsTouching(mask, stops) { // Uint8Array over stops: disc touches a cell of mask
  const sites = new Int32Array(G.N); let any = 0;
  for (let k = 0; k < G.N; k++) if (mask[k]) { sites[k] = 1; any = 1; }
  const out = new Uint8Array(stops.length); if (!any) return out;
  const D = edt(sites).D, lim = R() + TOL();
  stops.forEach((s, i) => { out[i] = D[s.k] * G.cell <= lim ? 1 : 0; });
  return out;
}
function discUnion(stops, ok, base) {
  const sites = new Int32Array(G.N); let any = 0;
  stops.forEach((s, i) => { if (ok[i]) { sites[s.k] = 1; any = 1; } });
  const m = new Uint8Array(G.N); if (!any) return m;
  const D = edt(sites).D, lim = R();
  for (let k = 0; k < G.N; k++) m[k] = base[k] && D[k] * G.cell <= lim ? 1 : 0;
  return m;
}
const QC = new Map(); // per-question cache: consistent mask & stops touching
function qEval(q, stops, base) {
  const key = [q.id, q.a, S.sig, R(), S.game.meta?.safety !== false, stops.length].join('|');
  if (QC.has(key)) return QC.get(key);
  const c = consMask(q, q.a); for (let k = 0; k < G.N; k++) c[k] &= base[k];
  const v = { c, ok: stopsTouching(c, stops) };
  QC.set(key, v); if (QC.size > 200) QC.delete(QC.keys().next().value);
  return v;
}
let STATE = null;
function evaluate() {
  const stops = activeStops(), base = baseMask();
  let ok = stopsTouching(base, stops);
  const still = Uint8Array.from(base);
  const qs = answeredQs();
  qs.forEach(q => { const e = qEval(q, stops, base); for (let i = 0; i < ok.length; i++) ok[i] &= e.ok[i]; for (let k = 0; k < G.N; k++) still[k] &= e.c[k]; });
  const union = discUnion(stops, ok, base);
  let a = 0, b = 0; for (let k = 0; k < G.N; k++) { if (union[k]) { a++; if (still[k]) b++; } }
  STATE = { stops, ok, union, still, n: ok.reduce((x, y) => x + y, 0), total: stops.length, area: a * G.cell ** 2, stillArea: b * G.cell ** 2 };
  return STATE;
}
function previewDraft(q) {
  if (!STATE) evaluate();
  const base = baseMask(), out = {}, A = QT[q.type].ans;
  A.forEach(ans => {
    const c = consMask(q, ans); for (let k = 0; k < G.N; k++) c[k] &= base[k];
    const okq = stopsTouching(c, STATE.stops), ok = STATE.ok.map((v, i) => v & okq[i]);
    const u = discUnion(STATE.stops, ok, base); let a = 0;
    for (let k = 0; k < G.N; k++) if (u[k]) a++;
    out[ans] = { n: ok.reduce((x, y) => x + y, 0), area: a * G.cell ** 2, c };
  });
  return out;
}
const answeredQs = () => Object.entries(S.game.qs || {}).map(([id, q]) => Object.assign({ id }, q)).filter(q => q.a && QT[q.type] && isDeduce(q) && !q.off).sort((a, b) => (a.t || 0) - (b.t || 0));
const allQs = () => Object.entries(S.game.qs || {}).map(([id, q]) => Object.assign({ id }, q)).filter(q => QT[q.type]).sort((a, b) => (b.t || 0) - (a.t || 0));

/* ------------------------------------------------------------------ map */
let map, Rr, layers = {}, maskOverlay = null, tiles = null;
function initMap() {
  Rr = L.canvas({ padding: 0.3, tolerance: 3 }); // one shared canvas: stacked canvases would swallow each other's taps
  map = L.map('map', { zoomSnap: 0.5, minZoom: 9, maxZoom: 19, renderer: Rr }).setView(S.pack.center, S.pack.zoom);
  map.attributionControl.setPrefix(false);
  map.createPane('zonesPane').style.zIndex = 380;
  map.createPane('maskPane').style.zIndex = 420; map.getPane('maskPane').style.pointerEvents = 'none';
  map.createPane('catPane').style.zIndex = 440;
  layers.sketch = L.layerGroup(); layers.zones = L.layerGroup(); layers.cats = L.layerGroup(); layers.stops = L.layerGroup();
  layers.qs = L.layerGroup().addTo(map); layers.draft = L.layerGroup().addTo(map); layers.tools = L.layerGroup().addTo(map);
  layers.hider = L.layerGroup().addTo(map); layers.seekers = L.layerGroup().addTo(map); layers.focus = L.layerGroup().addTo(map); layers.me = L.layerGroup().addTo(map);
  map.addControl(new (L.Control.extend({ options: { position: 'topleft' }, onAdd() {
    const b = L.DomUtil.create('button', 'loc-btn'); b.type = 'button'; b.id = 'locbtn'; b.title = 'Show my location'; b.setAttribute('aria-label', 'Show my location');
    b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>';
    L.DomEvent.disableClickPropagation(b); L.DomEvent.on(b, 'click', () => { startGPS(); if (S.me) map.flyTo([S.me.la, S.me.lo], Math.max(map.getZoom(), 15), { duration: .5 }); else S.wantCenter = true; });
    return b; } }))());
  map.on('preclick', onMapClick); // preclick fires even when a pop-up layer swallows the click
  map.on('zoomend', () => { drawStops(); if (S.ui.layers.base === 'sketch') sketchZoom(); });
  setBase(); drawZones();
  const mq = matchMedia('(prefers-color-scheme: dark)'); mq.addEventListener && mq.addEventListener('change', themeChanged);
  new MutationObserver(themeChanged).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}
function isDark() { const t = document.documentElement.getAttribute('data-theme'); return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; }
function themeChanged() { if (meCircle) meCircle.setStyle({ color: css('--me'), fillColor: css('--me') }); setBase(true); drawZones(); drawCats(); drawStops(); drawQs(); renderMask(); }
function setBase(force) {
  const want = S.ui.layers.base;
  map.getContainer().classList.toggle('tiles-dark', isDark());
  if (want === 'osm') {
    map.removeLayer(layers.sketch);
    if (!tiles) tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' });
    tiles.addTo(map);
  } else {
    if (tiles) map.removeLayer(tiles);
    if (force || !layers.sketch.getLayers().length) buildSketch();
    layers.sketch.addTo(map); sketchZoom();
  }
}
function buildSketch() {
  const P = S.pack.sketch; layers.sketch.clearLayers();
  const o = (extra) => Object.assign({ renderer: Rr, interactive: false }, extra);
  L.polygon(S.pack.boundary.map(decPoly).flat(), o({ color: css('--muted'), weight: 1.5, dashArray: '6 4', fillColor: css('--land'), fillOpacity: 1 })).addTo(layers.sketch);
  L.polygon(P.parks.map(decPoly), o({ stroke: false, fillColor: css('--park'), fillOpacity: 1 })).addTo(layers.sketch);
  L.polygon(P.water.map(decPoly), o({ stroke: false, fillColor: css('--water'), fillOpacity: 1 })).addTo(layers.sketch);
  L.polyline(P.rivers.map(dec), o({ color: css('--water'), weight: 3 })).addTo(layers.sketch);
  L.polyline(P.coast.map(dec), o({ color: css('--water'), weight: 2.5 })).addTo(layers.sketch);
  const by = [[], [], [], [], []]; P.roads.forEach(r => by[r[0]].push(dec(r[2])));
  layers.minor = L.polyline(by[3].concat(by[4]), o({ color: css('--road'), weight: 1.6 }));
  L.polyline(by[2], o({ color: css('--road'), weight: 2.4 })).addTo(layers.sketch);
  L.polyline(by[1], o({ color: css('--road-major'), weight: 3 })).addTo(layers.sketch);
  L.polyline(by[0], o({ color: css('--road-major'), weight: 4 })).addTo(layers.sketch);
  layers.labels = L.layerGroup(P.labels.filter(l => l[3] > 0.4).map(l => L.marker([l[2], l[1]], { icon: L.divIcon({ className: 'lbl', html: esc(l[0]), iconSize: null }), interactive: false })));
}
function sketchZoom() {
  if (!layers.minor) return; const z = map.getZoom();
  if (z >= 13.5) layers.minor.addTo(layers.sketch); else layers.sketch.removeLayer(layers.minor);
  if (z >= 14) layers.labels.addTo(layers.sketch); else layers.sketch.removeLayer(layers.labels);
}
const TIER = { exclude: 'No hiding', caution: 'Public spots only', busy: 'Busy centre' };
function drawZones() {
  layers.zones.clearLayers();
  if (!S.ui.layers.zones) { map.removeLayer(layers.zones); return; }
  const st = {
    exclude: { color: css('--excl'), weight: 1.4, fillColor: css('--excl-fill'), fillOpacity: 1 },
    caution: { color: css('--caut'), weight: 1.2, fillColor: css('--caut-fill'), fillOpacity: 1 },
    busy: { color: css('--busy'), weight: 1, dashArray: '5 4', fillColor: css('--busy-fill'), fillOpacity: 1 }
  };
  S.pack.zones.forEach(z => L.polygon(z.g.map(decPoly), Object.assign({ renderer: Rr, pane: 'zonesPane' }, st[z.t]))
    .bindPopup(`<b>${TIER[z.t]}</b><br>${esc(z.n)}<br><span class="muted small">Crime rank ${z.cr} of 6,976 · deprivation decile ${z.sd}</span>`).addTo(layers.zones));
  layers.zones.addTo(map);
}
const catColor = cid => { const i = S.pack.cats.findIndex(c => c.id === cid); return `hsl(${(i * 137.5 + 15) % 360} ${isDark() ? '65% 62%' : '62% 40%'})`; };
function drawCats() {
  layers.cats.clearLayers();
  Object.entries(S.ui.layers.cats).forEach(([cid, on]) => {
    if (!on || !S.L.cats[cid]) return;
    const C = S.L.cats[cid], col = catColor(cid);
    C.items.forEach(it => {
      const pop = `<b>${esc(it.n)}</b><br><span class="muted">${esc(C.label)}${it.on ? '' : ' · switched off'}${it.added ? ' · added' : ''}</span>`;
      if (it.polys) L.polygon(it.polys, { renderer: Rr, pane: 'catPane', color: col, weight: 1.5, fillColor: col, fillOpacity: it.on ? .12 : .03, opacity: it.on ? 1 : .35 }).bindPopup(pop).addTo(layers.cats);
      if (it.lines) L.polyline(it.lines, { renderer: Rr, pane: 'catPane', color: col, weight: 3 }).bindPopup(pop).addTo(layers.cats);
      else {
        const transit = cid === 'rail' || cid === 'tram';
        const mk = L.circleMarker([it.la, it.lo], { renderer: Rr, pane: 'catPane', radius: it.polys ? 3 : 6, color: '#fff', weight: 1.5, fillColor: col, fillOpacity: it.on ? 1 : .3, opacity: it.on ? 1 : .4 })
          .bindPopup(transit ? pop + `<br><span class="small">Dashed circle: ${fmtD(R())} around it${cid === 'rail' ? ' (rail stations are not hiding stops)' : ''}</span>` : pop).addTo(layers.cats);
        if (transit) { mk.on('popupopen', () => showZone(it.la, it.lo)); mk.on('popupclose', clearZone); }
      }
    });
  });
  layers.cats.addTo(map);
}
function drawStops() {
  layers.stops.clearLayers();
  const mode = S.ui.layers.stops; if (mode === 'off' || !S.L) { map.removeLayer(layers.stops); return; }
  const z = map.getZoom(), rad = z >= 15 ? 5 : z >= 13 ? 3.5 : 2.2;
  const okSet = new Set(); if (STATE) STATE.stops.forEach((s, i) => STATE.ok[i] && okSet.add(s.id));
  S.L.stops.forEach(s => {
    const possible = okSet.has(s.id);
    if (mode === 'possible' && STATE && !possible && S.role !== 'hider') return;
    const m = L.circleMarker([s.la, s.lo], { renderer: Rr, radius: rad, weight: 1, color: '#fff', fillOpacity: s.on ? 1 : .3,
      fillColor: !s.on ? css('--muted') : possible ? (s.mode === 'tram' ? css('--busy') : css('--madder')) : css('--muted') });
    m.bindPopup(() => stopPopup(s)); m.on('popupopen', () => showZone(s.la, s.lo)); m.on('popupclose', clearZone); m.addTo(layers.stops);
  });
  layers.stops.addTo(map);
}
function showZone(la, lo) {
  layers.focus.clearLayers();
  L.circle([la, lo], { radius: R(), color: css('--madder'), weight: 2.5, dashArray: '7 5', fillColor: css('--madder'), fillOpacity: .07, interactive: false }).addTo(layers.focus);
}
const clearZone = () => layers.focus && layers.focus.clearLayers();
function stopPopup(s) {
  const pos = STATE ? STATE.stops.findIndex(x => x.id === s.id) : -1;
  const st = !s.on ? 'switched off' : pos >= 0 && STATE.ok[pos] ? 'still possible' : 'ruled out';
  let h = `<b>${esc(s.n)}</b><br><span class="muted">${s.mode === 'tram' ? 'Tram stop' : 'Bus stop'} · ${st}</span><br><span class="small">Dashed circle: ${fmtD(R())} hiding zone</span>`;
  if (S.role === 'hider' && !S.hider) h += `<br><button class="btn small primary" style="margin-top:6px" data-act="pick-stop" data-id="${esc(s.id)}">Choose this stop</button>`;
  return h;
}
const PIN = col => L.divIcon({ className: 'pin', iconSize: null, html: `<svg viewBox="0 0 26 34"><path d="M13 33s11-11.5 11-20A11 11 0 0 0 2 13c0 8.5 11 20 11 20z" fill="${col}" stroke="#fff" stroke-width="2"/><circle cx="13" cy="13" r="4" fill="#fff"/></svg>` });
function drawQs() {
  layers.qs.clearLayers();
  allQs().forEach(q => {
    if (!isDeduce(q)) return;
    const p = q.p || {}, col = q.off ? css('--muted') : !q.a ? css('--wait') : QT[q.type].ans[0] === q.a ? css('--yes') : css('--no');
    const tip = `<b>${QT[q.type].label}</b> · ${esc(q.by || '')}<br>${esc(qText(q))}<br>${q.a ? '<b>' + QT[q.type].names[q.a] + '</b>' : 'Waiting for answer'}`;
    if (q.type === 'thermo') {
      L.polyline([[p.la1, p.lo1], [p.la2, p.lo2]], { color: col, weight: 3, dashArray: '6 5' }).addTo(layers.qs);
      L.circleMarker([p.la1, p.lo1], { radius: 6, color: col, weight: 2, fillColor: '#fff', fillOpacity: 1 }).bindPopup(tip).addTo(layers.qs);
      L.marker([p.la2, p.lo2], { icon: PIN(col) }).bindPopup(tip).addTo(layers.qs);
      return;
    }
    L.marker([p.la, p.lo], { icon: PIN(col) }).bindPopup(tip).addTo(layers.qs);
    if (q.type === 'radar') L.circle([p.la, p.lo], { radius: p.r, color: col, weight: 2, fill: false, dashArray: q.a ? null : '6 5', interactive: false }).addTo(layers.qs);
    if ((q.type === 'measure' || q.type === 'match') && p.refLa) L.polyline([[p.la, p.lo], [p.refLa, p.refLo]], { color: col, weight: 2, dashArray: '2 5', interactive: false }).addTo(layers.qs);
  });
}
function renderMask(prev) {
  if (!STATE || !S.ui.layers.mask) { if (maskOverlay) { map.removeLayer(maskOverlay); maskOverlay = null; } return; }
  const cv = document.createElement('canvas'); cv.width = G.nx; cv.height = G.ny;
  const c = cv.getContext('2d'), img = c.createImageData(G.nx, G.ny), d = img.data;
  const dark = isDark(), U = STATE.union, St = STATE.still, show = S.ui.layers.still;
  const out = dark ? [0, 0, 0, 150] : [30, 32, 38, 120], soft = dark ? [0, 0, 0, 70] : [30, 32, 38, 48];
  const Y = dark ? [76, 201, 133, 95] : [31, 138, 76, 80], Nn = dark ? [197, 138, 224, 95] : [139, 63, 168, 80];
  for (let k = 0, j = 0; k < G.N; k++, j += 4) {
    let px = null;
    if (!U[k]) px = out;
    else if (prev) px = prev[k] ? Y : Nn;
    else if (show && !St[k]) px = soft;
    if (px) { d[j] = px[0]; d[j + 1] = px[1]; d[j + 2] = px[2]; d[j + 3] = px[3]; }
  }
  c.putImageData(img, 0, 0);
  const url = cv.toDataURL();
  if (!maskOverlay) maskOverlay = L.imageOverlay(url, G.bounds, { pane: 'maskPane', interactive: false }).addTo(map);
  else maskOverlay.setUrl(url);
}

/* ------------------------------------------------------------------ GPS */
let watchId = null;
function startGPS() {
  if (watchId !== null) return;
  if (!('geolocation' in navigator)) { toast('This browser has no location support.'); return; }
  if (!window.isSecureContext) { toast('Location needs an https:// address.'); return; }
  watchId = navigator.geolocation.watchPosition(p => {
    S.me = { la: p.coords.latitude, lo: p.coords.longitude, acc: Math.round(p.coords.accuracy), t: Date.now() };
    drawMe(); if (S.wantCenter) { S.wantCenter = false; map.flyTo([S.me.la, S.me.lo], Math.max(map.getZoom(), 15), { duration: .5 }); }
    hiderZoneCheck(); pushLoc(); followPin(); refreshLight();
  }, e => { if (e.code === 1) { toast('Location is blocked. Allow it for this site in your browser settings.'); navigator.geolocation.clearWatch(watchId); watchId = null; } },
  { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  $('#locbtn') && $('#locbtn').classList.add('on');
}
let meCircle = null, meDot = null, meR = null;
function drawMe() {
  if (!S.me) return;
  const ll = [S.me.la, S.me.lo];
  if (!meCircle) {
    meR = L.svg({ padding: 0.5 });
    meCircle = L.circle(ll, { renderer: meR, radius: S.me.acc, color: css('--me'), weight: 1, fillColor: css('--me'), fillOpacity: .12, interactive: false }).addTo(layers.me);
    meDot = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [0, 0] }), interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(layers.me);
  } else { meCircle.setLatLng(ll); meCircle.setRadius(S.me.acc); meDot.setLatLng(ll); }
}
let lastFollow = null;
function followPin() { // keep the live preview pin on the seeker while they travel
  const a = S.ui.ask;
  if (S.role !== 'seeker' || S.ui.tab !== 'ask' || a.type === 'photo' || a.follow === false || !S.me) return;
  const i = a.type === 'thermo' ? 1 : 0, t = Date.now();
  if (lastFollow && t - lastFollow.t < 5000 && dm(lastFollow.la, lastFollow.lo, S.me.la, S.me.lo) < 25) return;
  lastFollow = { t, la: S.me.la, lo: S.me.lo };
  a.pins[i] = [S.me.la, S.me.lo]; drawDraft(); runPreview();
}
let lastPush = null;
function pushLoc() {
  if (!S.code || S.role !== 'seeker' || !S.ui.shareLoc || !S.me) return;
  const t = Date.now();
  if (lastPush && t - lastPush.t < 10000 && dm(lastPush.la, lastPush.lo, S.me.la, S.me.lo) < 25) return;
  lastPush = { t, la: S.me.la, lo: S.me.lo };
  W.set('locs/' + S.uid, { name: S.name || 'Seeker', la: +S.me.la.toFixed(5), lo: +S.me.lo.toFixed(5), acc: S.me.acc, t: B.now() });
}
function drawSeekers() {
  if (!layers.seekers) return; layers.seekers.clearLayers();
  Object.entries(S.game.locs || {}).forEach(([uid, l]) => {
    if (uid === S.uid || !l || !isFinite(l.la)) return;
    if ((S.game.players || {})[uid]?.role === 'hider') return; // never show a hider, even a stale ping
    const age = now() - (l.t || 0), stale = age > 5 * 60000;
    L.marker([l.la, l.lo], { icon: L.divIcon({ className: '', iconSize: [0, 0], html: `<div class="sk${stale ? ' stale' : ''}"><i></i><span>${esc(l.name)}${stale ? ' · ' + ago(l.t) : ''}</span></div>` }), zIndexOffset: 900 })
      .bindPopup(`<b>${esc(l.name)}</b><br><span class="muted">Seeker · updated ${ago(l.t)} · ±${l.acc || '?'} m</span>`).addTo(layers.seekers);
  });
}
let lastInside = null;
function hiderZoneCheck() {
  if (S.role !== 'hider' || !S.hider || !S.me) return;
  const d = dm(S.me.la, S.me.lo, S.hider.la, S.hider.lo), inside = d <= R();
  if (lastInside === true && !inside) { toast(`You left your hiding zone (${fmtD(d - R())} outside).`); buzz([150, 80, 150]); }
  lastInside = inside;
}

/* ------------------------------------------------------------------ alerts */
let SWR = null, AC = null, WL = null;
if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').then(r => { SWR = r; }).catch(() => {});
document.addEventListener('pointerdown', () => { try { if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)(); else if (AC.state === 'suspended') AC.resume(); } catch (e) {} }, { capture: true });
function beep() {
  if (!AC || !S.ui.sound || document.hidden) return;
  try { [0, 0.22].forEach(off => { const o = AC.createOscillator(), g = AC.createGain(), t0 = AC.currentTime + off; o.frequency.value = off ? 1175 : 880; g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18); o.connect(g).connect(AC.destination); o.start(t0); o.stop(t0 + 0.2); }); } catch (e) {}
}
// Vibration: Android supports navigator.vibrate. Safari on iPhone has no vibration API for websites;
// on iOS 18+ toggling a hidden "switch" checkbox produces a system haptic tick, which we use instead.
const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let hapEl = null;
function hapticTick() {
  try {
    const l = document.createElement('label'); l.setAttribute('aria-hidden', 'true'); l.dataset.haptic = '1'; l.style.display = 'none';
    const i = document.createElement('input'); i.type = 'checkbox'; i.setAttribute('switch', ''); l.appendChild(i);
    document.head.appendChild(l); l.click(); l.remove();
  } catch (e) {}
}
function buzz(pattern) {
  let ok = false;
  try { ok = !!(navigator.vibrate && navigator.vibrate(pattern)); } catch (e) {}
  if (!ok && IOS) { hapticTick(); const n = Math.min(4, Math.ceil(pattern.length / 2) + 1); for (let k = 1; k < n; k++) setTimeout(hapticTick, k * 160); }
}
function alertUser(title, body, tag, pattern = [200, 100, 200]) {
  const canNotify = 'Notification' in window && Notification.permission === 'granted';
  if (document.hidden && canNotify) {
    const opts = { body, tag: 'seek-' + tag, renotify: true, vibrate: pattern, requireInteraction: false };
    if (SWR) SWR.showNotification(title, opts).catch(() => {}); else { try { new Notification(title, opts); } catch (e) {} }
  } else toast(title + ': ' + body, 6000);
  buzz(pattern);
  beep();
}
async function wake() {
  try {
    if (S.ui.wake && 'wakeLock' in navigator && !document.hidden) { if (!WL) { WL = await navigator.wakeLock.request('screen'); WL.addEventListener('release', () => { WL = null; }); } }
    else if (!S.ui.wake && WL) { await WL.release(); WL = null; }
  } catch (e) { WL = null; }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { wake(); tick(); } });
const modalQ = [];
function showModal(title, text) {
  modalQ.push([title, text]); if (modalQ.length > 1) return; drawModal();
}
function drawModal() {
  let m = $('#modal'); if (!modalQ.length) { if (m) m.hidden = true; return; }
  if (!m) { m = document.createElement('div'); m.id = 'modal'; m.className = 'modal'; m.setAttribute('role', 'alertdialog'); m.setAttribute('aria-modal', 'true'); document.body.appendChild(m); }
  const [t, x] = modalQ[0];
  m.innerHTML = `<div class="modal-card"><h3>${esc(t)}</h3><p>${esc(x).replace(/\n/g, '<br>')}</p><button type="button" class="btn primary wide" id="modal-ok">OK</button></div>`;
  m.hidden = false; $('#modal-ok').focus();
  $('#modal-ok').onclick = () => { modalQ.shift(); drawModal(); };
}

/* ------------------------------------------------------------------ UI scaffolding */
function toast(msg, ms = 3500) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, ms); }
function hint(msg, cancel) {
  const h = $('#maphint');
  if (!msg) { h.hidden = true; return; }
  h.innerHTML = `<span>${esc(msg)}</span>${cancel ? '<button type="button" data-act="cancel-mode">Cancel</button>' : ''}`; h.hidden = false;
}
function setConn(on) { S.conn = on; const i = $('#tb-code i'); if (i) i.className = on ? 'on' : 'off'; }
const TABS = {
  seeker: [['ask', 'Ask'], ['log', 'Log'], ['map', 'Map'], ['lists', 'Lists'], ['game', 'Game']],
  hider: [['answer', 'Answer'], ['zone', 'Zone'], ['map', 'Map'], ['lists', 'Lists'], ['game', 'Game']]
};
function renderTabs() {
  const tabs = TABS[S.role]; if (!tabs.some(t => t[0] === S.ui.tab)) S.ui.tab = S.role === 'hider' && !S.hider ? 'zone' : tabs[0][0];
  const pend = allQs().some(q => !q.a);
  $('#tabs').innerHTML = tabs.map(([id, l]) => `<button type="button" role="tab" class="tab${S.ui.tab === id ? ' on' : ''}" data-tab="${id}" aria-selected="${S.ui.tab === id}">${l}${(id === 'answer' && pend) || (id === 'log' && pend) ? '<span class="dot"></span>' : ''}</button>`).join('');
}
function renderTop() {
  $('#topbar').hidden = false;
  if (!$('#tb-timer')) { const t = document.createElement('span'); t.id = 'tb-timer'; t.className = 'tb-timer'; $('#tb-code').after(t); }
  $('#tb-code').innerHTML = `<i class="${S.conn ? 'on' : 'off'}"></i>${S.mode === 'local' ? 'LOCAL' : esc(S.code)} · ${S.role === 'hider' ? 'Hider' : 'Seeker'}`;
  let s = '';
  if (STATE) s = `${nf(STATE.n)} of ${nf(STATE.total)} stops · ${fmtA(STATE.area)}`;
  if (S.role === 'hider') s = S.hider ? `Zone: ${S.hider.n}` : 'Choose your stop';
  $('#tb-sum').textContent = s;
}
function render() {
  if (!S.pack || !S.code) return;
  renderTabs(); renderTop();
  const pane = PANES[S.ui.tab];
  const el = $('#panes');
  const keep = document.activeElement && el.contains(document.activeElement) && document.activeElement.id;
  el.innerHTML = `<div class="pane" id="pane-${S.ui.tab}">${pane()}</div>`;
  if (keep) { const k = document.getElementById(keep); if (k) { k.focus(); if (k.setSelectionRange && k.value != null && k.type !== 'number') k.setSelectionRange(k.value.length, k.value.length); } }
  updateDue();
  applySheet();
}
const refreshLight = debounce(() => { if (['answer', 'zone'].includes(S.ui.tab)) render(); else renderTop(); }, 400);

/* ------------------------------------------------------------------ bottom sheet (phones): min / mid / tall */
const SHEET = ['min', 'mid', 'tall'];
const sheetState = () => S.ui.sheetMin ? 'min' : S.ui.sheetTall ? 'tall' : 'mid';
function applySheet() {
  const st = sheetState(), sh = $('#sheet');
  sh.classList.toggle('min', st === 'min'); sh.classList.toggle('tall', st === 'tall');
  $('#app').classList.toggle('sheetmin', st === 'min'); $('#app').classList.toggle('sheettall', st === 'tall');
}
function setSheet(st) { S.ui.sheetMin = st === 'min'; S.ui.sheetTall = st === 'tall'; applySheet(); }
(function sheetGestures() {
  const sh = $('#sheet'); let y0 = null, dy = 0, t0 = 0, fromPanes = false;
  sh.addEventListener('touchstart', e => {
    if (innerWidth > 760 || e.touches.length !== 1) return;
    const head = e.target.closest('#grab, #tabs'), panes = $('#panes');
    fromPanes = !head && panes.contains(e.target) && panes.scrollTop <= 0 && !e.target.closest('input, select, textarea, .list');
    if (!head && !fromPanes) return;
    y0 = e.touches[0].clientY; dy = 0; t0 = Date.now();
  }, { passive: true });
  sh.addEventListener('touchmove', e => {
    if (y0 == null) return;
    dy = e.touches[0].clientY - y0;
    if (fromPanes && dy < 0) { y0 = null; sh.style.transform = ''; return; } // upward drag inside content = normal scrolling
    if (Math.abs(dy) > 8) { sh.style.transition = 'none'; sh.style.transform = `translateY(${Math.max(dy, -40)}px)`; if (e.cancelable) e.preventDefault(); }
  }, { passive: false });
  const end = () => {
    if (y0 == null) return; y0 = null;
    sh.style.transition = ''; sh.style.transform = '';
    if (Math.abs(dy) < 25) return;
    const fast = Math.abs(dy) / Math.max(1, Date.now() - t0) > 0.6, i = SHEET.indexOf(sheetState());
    let j = i;
    if (dy > 0) j = (dy > 260 || (fast && dy > 120)) ? 0 : Math.max(0, i - 1);
    else j = Math.min(2, i + 1);
    S.ui.dragAt = Date.now(); setSheet(SHEET[j]);
  };
  sh.addEventListener('touchend', end); sh.addEventListener('touchcancel', end);
  const toggle = () => setSheet(sheetState() === 'min' ? 'mid' : 'min');
  $('#grab').addEventListener('click', () => { if (Date.now() - (S.ui.dragAt || 0) > 400) toggle(); });
  $('#grab').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
})();

/* ------------------------------------------------------------------ panes */
const PANES = {};
function summaryHTML() {
  if (!STATE) return '';
  return `<div class="summary"><div class="stat"><b class="mono">${nf(STATE.n)}</b><span>of ${nf(STATE.total)} stops still possible</span></div>
  <div class="stat"><b class="mono">${fmtA(STATE.area)}</b><span>possible hiding area${STATE.stillArea < STATE.area - 1 ? ` · ${fmtA(STATE.stillArea)} if the hider hasn't moved` : ''}</span></div></div>`;
}
function ensurePins() {
  const a = S.ui.ask; if (!map) return false; let ch = false;
  const here = S.me && G.idx(S.me.la, S.me.lo) >= 0 ? [S.me.la, S.me.lo] : [map.getCenter().lat, map.getCenter().lng];
  if (!a.pins[0]) { a.pins[0] = here; ch = true; }
  if (a.type === 'thermo' && !a.pins[1]) { const p = a.pins[0]; a.pins[1] = [p[0], p[1] + (a.td + 100) / G.kx0]; ch = true; }
  if (a.type !== 'thermo') a.active = 0; else if (a.active == null) a.active = 1;
  return ch;
}
PANES.ask = () => {
  const a = S.ui.ask, t = a.type, used = usedKeys();
  const cats = S.pack.cats.filter(c => (t === 'measure' ? c.only !== 'match' : c.only !== 'measure'));
  if (t === 'measure' || t === 'match') { if (!cats.some(c => c.id === a.cat) || used.has(t + ':' + a.cat)) { const f = cats.find(c => !used.has(t + ':' + c.id)); a.cat = (f || cats[0]).id; } }
  let h = summaryHTML();
  h += `<div class="grp"><h2>Question</h2><div class="seg" id="ask-type">${Object.entries(QT).map(([k, v]) => `<button type="button" data-act="ask-type" data-v="${k}" class="${t === k ? 'on' : ''}">${v.short}</button>`).join('')}</div>
    <p class="small"><b>${QT[t].label}</b> · <span class="cards">${cardText(t)}</span> <span class="muted">for the hider when they answer in time</span></p></div>`;
  const chip = (act, v, label, on, isUsed, extra = '') => `<button type="button" class="chipbtn${on ? ' on' : ''}${isUsed ? ' used' : ''}" data-act="${act}" data-v="${esc(v)}" ${isUsed ? 'disabled title="Already asked"' : ''} ${extra}>${esc(label)}${isUsed ? ' ✓' : ''}</button>`;
  if (t === 'radar') h += `<div class="grp"><h2>Radius</h2><div class="chips">${[500, 1000, 2000, 3000, 5000, 10000].map(r => chip('ask-r', r, r < 1000 ? r + ' m' : r / 1000 + ' km', a.r === r, used.has('radar:' + r))).join('')}</div>
    <label class="field"><span>Custom radius (km)</span><input id="ask-rc" type="number" inputmode="decimal" min="0.1" step="0.1" value="${a.r / 1000}"></label></div>`;
  if (t === 'thermo') h += `<div class="grp"><h2>Distance travelled</h2><div class="chips">${THERMO.map(d => chip('ask-td', d, d / 1000 + ' km', a.td === d, used.has('thermo:' + d))).join('')}</div>
    <p class="note">Place the start point where you were, and the second pin where you are now, at least that far away.</p></div>`;
  if (t === 'measure' || t === 'match') h += `<label class="field"><span>${t === 'measure' ? 'Nearest' : 'Matching'}</span><select id="ask-cat">${cats.map(c => { const u = used.has(t + ':' + c.id); return `<option value="${c.id}"${c.id === a.cat ? ' selected' : ''}${u ? ' disabled' : ''}>${esc(c.label)}${u ? ' (asked)' : ''}</option>`; }).join('')}</select></label>`;
  if (t === 'photo') {
    h += `<div class="grp"><h2>Photo</h2><div class="chips">${PHOTOS.map(([k, l]) => chip('ask-subj', k, l, a.subj === k, used.has('photo:' + k), 'style="font-family:var(--f-body)"')).join('')}</div>
      <label class="field"><span>Or write your own (photo of…)</span><input id="ask-subj" type="text" maxlength="80" value="${esc(PHOTOS.some(p => p[0] === a.subj) ? '' : a.subj || '')}" placeholder="e.g. the nearest bus stop sign"></label>
      <p class="note">The hider sends the photo in your group chat and marks it as sent here. Photos don't change the map. Time limit: ${S.game.meta?.photoMin ?? CFG.defaults.photoMin} min.</p></div>`;
  }
  const pinNames = t === 'photo' ? [] : t === 'thermo' ? ['Start point', 'Where you are now'] : ['Your position'];
  if (pinNames.length) {
    h += `<div class="grp"><h2>${t === 'thermo' ? 'Pins' : 'Pin'}</h2>`;
    pinNames.forEach((nm, i) => {
      const p = a.pins[i], act = (a.active || 0) === i && pinNames.length > 1;
      h += `<div class="row"><span class="grow"><b>${nm}</b>${act ? ' <span class="badge">moves on tap</span>' : ''}<br><span class="small muted mono">${p ? p[0].toFixed(5) + ', ' + p[1].toFixed(5) : 'not placed'}</span></span>
        <button type="button" class="btn small" data-act="pin-gps" data-i="${i}">My location</button>${pinNames.length > 1 ? `<button type="button" class="btn small${act ? ' primary' : ''}" data-act="pin-tap" data-i="${i}">Move on tap</button>` : ''}</div>`;
    });
    h += `<p class="note">Tap the map to preview from anywhere. <b>Send always uses your GPS position at that moment</b>${t === 'thermo' ? ' for “Where you are now”' : ''}. ${a.follow !== false ? 'The pin is following you.' : '<button type="button" class="linkbtn" data-act="pin-follow">Follow me again</button>'}</p>
      ${!S.me ? '<p class="small warn">Location is off. Turn it on to send questions.</p>' : ''}</div>`;
  }
  const q = draftQ();
  if (q && q.err) h += `<p class="warn">${esc(q.err)}</p>`;
  else if (q) {
    h += `<div class="card"><div class="qhead"><b>${QT[t].label}</b>${cardChip(q)}</div><div class="qtext">${esc(qText(q))}</div>`;
    if (t === 'photo') {}
    else if (S.preview && S.preview.key === previewKey(q)) {
      const pv = S.preview.r, A = QT[t].ans;
      h += `<div class="outcome">${A.map((ans, i) => `<div class="oc ${i ? 'no' : 'yes'}"><b>If ${QT[t].names[ans]}</b><div class="mono">${nf(pv[ans].n)} stops</div><div class="mono">${fmtA(pv[ans].area)}</div></div>`).join('')}</div>
        <p class="note">Map: green is where the hider could be if the answer is ${QT[t].names[A[0]].toLowerCase()}, purple if ${QT[t].names[A[1]].toLowerCase()}.</p>`;
    } else h += `<p class="note">Working out both outcomes…</p>`;
    const ph = phase();
    h += ph === 'seeking' && !paused() ? `<button type="button" class="btn primary wide" data-act="ask-send">Send question</button></div>`
      : `<button type="button" class="btn primary wide" disabled>Send question</button><p class="note">${paused() ? 'The game is paused.' : ph === 'lobby' ? 'Start the game in the Game tab first.' : ph === 'hiding' ? 'Questions open when hiding time ends. You can plan with the preview now.' : 'The game has ended.'}</p></div>`;
  }
  return h;
};
PANES.log = () => {
  let h = summaryHTML();
  const qs = allQs();
  if (!qs.length) return h + `<p class="muted">No questions yet. Ask one from the Ask tab; it appears here and on the hider's phone.</p>`;
  const shaded = qs.filter(q => q.a && isDeduce(q) && !q.off).length, hidden = qs.filter(q => q.a && isDeduce(q) && q.off).length;
  h += `<div class="grp"><h2>Questions (${qs.length})</h2>
    <p class="note">The eye on each answer turns its shading on or off for the whole team, e.g. after the hider plays a Move card.</p>
    ${S.ui.confirm === 'move' ? `<div class="confirm"><span class="grow">Hide the shading of all ${shaded} answered questions? Use this when the hider has moved to a new zone.</span><button type="button" class="btn small primary" data-act="move-yes">Hide all</button><button type="button" class="btn small" data-act="confirm-no">Cancel</button></div>`
      : `<div class="row">${shaded ? '<button type="button" class="btn small" data-act="move">Move card: hide all shading…</button>' : ''}${hidden ? '<button type="button" class="btn small ghost" data-act="unhide-all">Show all shading</button>' : ''}</div>`}`;
  qs.forEach(q => {
    const pend = !q.a;
    const late = !!(q.late || (q.a && qLate(q)));
    h += `<div class="card${pend ? ' pending' : ''}${q.off ? ' qoff' : ''}"><div class="qhead"><span><b>${QT[q.type].label}</b> ${cardChip(q, late)} <span class="small muted">· ${esc(q.by || '?')} · ${ago(q.t)}</span></span>
      ${pend ? '<span class="badge wait">Waiting</span>' : `<span class="badge ${QT[q.type].ans[0] === q.a ? 'yes' : 'no'}">${QT[q.type].names[q.a]}</span>`}</div>
      ${pend ? `<div class="small">Answer due: <span class="due mono" data-due="${q.id}"></span></div>` : q.late || qLate(q) ? '<div class="small warn">Answered late: no card draw</div>' : ''}
      <div>${esc(qText(q))}</div>${qRef(q) ? `<div class="small muted">${esc(qRef(q))}</div>` : ''}
      ${q.off ? '<div class="small muted"><b>Shading hidden</b> for everyone. It no longer rules anything out.</div>' : ''}
      ${S.ui.confirm === 'del-' + q.id ? `<div class="confirm"><span class="grow">Delete this question for everyone?</span><button type="button" class="btn small primary" data-act="q-del-yes" data-id="${q.id}">Delete</button><button type="button" class="btn small" data-act="confirm-no">Cancel</button></div>`
      : `<div class="row">${isDeduce(q) && q.a ? `<button type="button" class="iconbtn eye${q.off ? ' off' : ''}" data-act="q-eye" data-id="${q.id}" title="${q.off ? 'Shading hidden. Tap to use it again' : 'Shading in use. Tap to hide it'}" aria-label="${q.off ? 'Show this question’s shading' : 'Hide this question’s shading'}" aria-pressed="${!q.off}">${q.off ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.3 6.3C3.6 8.1 2 12 2 12s3.5 7 10 7c1.8 0 3.4-.5 4.7-1.3"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>' : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>'}</button>` : ''}${isDeduce(q) ? `<button type="button" class="btn small" data-act="q-show" data-id="${q.id}">Show on map</button>` : ''}<button type="button" class="btn small ghost" data-act="q-del" data-id="${q.id}">Delete</button></div>`}</div>`;
  });
  return h + '</div>';
};
PANES.answer = () => {
  const qs = allQs(), pend = qs.filter(q => !q.a), done = qs.filter(q => q.a);
  let h = '';
  const src = S.me ? `GPS ±${S.me.acc} m${S.me.acc > 100 ? ' (weak: step outside)' : ''}` : S.hider ? 'no GPS yet: using your stop' : 'no position yet';
  h += `<div class="row"><span class="grow small muted">Answering from: <b>${esc(src)}</b></span>${S.me ? '' : '<button type="button" class="btn small" data-act="gps-on">Turn on location</button>'}</div>`;
  if (!S.hider) h += `<p class="warn">Choose and lock your stop in the Zone tab before answering.</p>`;
  if (!pend.length) h += `<p class="muted">No questions waiting. New questions appear here, and your phone buzzes.</p>`;
  const pos = S.me ? [S.me.la, S.me.lo] : S.hider ? [S.hider.la, S.hider.lo] : null;
  pend.forEach(q => {
    const photo = q.type === 'photo';
    const r = pos && !photo ? answerAt(q, pos[0], pos[1]) : null, A = QT[q.type].ans;
    h += `<div class="card hot"><div class="qhead"><span><b>${QT[q.type].label}</b> ${cardChip(q, q.late)} <span class="small muted">· from ${esc(q.by || '?')} · ${ago(q.t)}</span></span><span class="due mono" data-due="${q.id}"></span></div>
      <div class="qtext">${esc(qText(q))}</div>${qRef(q) ? `<div class="small muted">${esc(qRef(q))}</div>` : ''}
      ${photo ? '<p class="note">Send the photo in your group chat, then tap below.</p>' : r ? `<div><span class="small muted">Your answer</span><div class="answer-big ${A[0] === r.a ? 'yes' : 'no'}">${QT[q.type].names[r.a]}</div><div class="small muted">${esc(r.info)}</div></div>` : '<p class="note">Turn on location to get your answer worked out.</p>'}
      <div class="row">${photo ? `<button type="button" class="btn yes" data-act="answer" data-id="${q.id}" data-v="sent">I've sent the photo</button>` : A.map((ans, i) => `<button type="button" class="btn ${i ? 'no' : 'yes'}${r && r.a === ans ? ' suggest' : ''}" data-act="answer" data-id="${q.id}" data-v="${ans}">Send “${QT[q.type].names[ans]}”</button>`).join('')}</div></div>`;
  });
  if (done.length) {
    h += `<div class="grp"><h2>Answered</h2>`;
    done.forEach(q => { const late = !!(q.late || qLate(q)); h += `<div class="card"><div class="small"><b>${QT[q.type].label}</b> ${cardChip(q, late)}</div><div class="qhead"><span>${esc(qText(q))}</span><span class="badge ${QT[q.type].ans[0] === q.a ? 'yes' : 'no'}">${QT[q.type].names[q.a]}</span></div></div>`; });
    h += '</div>';
  }
  return h + summaryHTML();
};
PANES.zone = () => {
  let h = '';
  if (S.hider) {
    const d = S.me ? dm(S.me.la, S.me.lo, S.hider.la, S.hider.lo) : null;
    h += `<div class="card hot"><span class="small muted">Your locked stop</span><h3>${esc(S.hider.n)}</h3>
      <dl class="kv"><dt>Locked</dt><dd>${new Date(S.hider.t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</dd><dt>Hiding radius</dt><dd>${fmtD(R())}</dd>
      <dt>You are</dt><dd>${d == null ? 'location off' : d <= R() ? fmtD(d) + ' from the stop · inside' : fmtD(d - R()) + ' outside your zone'}</dd></dl>
      ${d != null && d > R() ? '<p class="warn">Get back inside your zone.</p>' : ''}
      <p class="note">Your stop stays on this phone. Seekers never see it.</p>
      ${S.ui.confirm === 'unlock' ? `<div class="confirm"><span class="grow">Unlock only if your rules allow changing stop.</span><button type="button" class="btn small primary" data-act="unlock-yes">Unlock</button><button type="button" class="btn small" data-act="confirm-no">Cancel</button></div>`
        : `<div class="row"><button type="button" class="btn small" data-act="zone-show">Show zone</button><button type="button" class="btn small ghost" data-act="unlock">Unlock stop</button></div>`}</div>`;
    return h + summaryHTML();
  }
  h += `<div class="grp"><h2>Choose your stop</h2><p class="note">Pick a bus or tram stop. Your hiding zone is the ${fmtD(R())} circle around it. Tap a stop on the map, or pick one near you below.</p></div>`;
  const ref = S.me ? [S.me.la, S.me.lo] : [map.getCenter().lat, map.getCenter().lng];
  const near = S.L.stops.filter(s => s.on && s.k >= 0).map(s => [s, dm(ref[0], ref[1], s.la, s.lo)]).sort((a, b) => a[1] - b[1]).slice(0, 12);
  h += `<p class="small muted">Nearest to ${S.me ? 'you' : 'the map centre'}:</p><div class="list">${near.map(([s, d]) => `<div class="li${S.ui.pick === s.id ? ' sel' : ''}"><span class="nm">${esc(s.n)}<small>${s.mode === 'tram' ? 'Tram' : 'Bus'} · ${fmtD(d)}</small></span><button type="button" class="btn small" data-act="pick-stop" data-id="${esc(s.id)}">Choose</button></div>`).join('')}</div>`;
  if (S.ui.pick) {
    const s = S.L.stops.find(x => x.id === S.ui.pick);
    if (s) h += `<div class="card hot"><h3>${esc(s.n)}</h3><p class="note">Locking in is final for this round. The circle shows your zone.</p><button type="button" class="btn primary wide" data-act="lock-stop">Lock in this stop</button></div>`;
  }
  return h;
};
PANES.map = () => {
  const Ly = S.ui.layers;
  let h = `<div class="grp"><h2>Layers</h2>
    <label class="check"><input type="checkbox" data-act="ly" data-k="mask" ${Ly.mask ? 'checked' : ''}> ${S.role === 'hider' ? 'What the seekers have ruled out' : 'Ruled-out area'}</label>
    <label class="check"><input type="checkbox" data-act="ly" data-k="still" ${Ly.still ? 'checked' : ''}> Lighter shading: ruled out only if the hider hasn't moved</label>
    <label class="check"><input type="checkbox" data-act="ly" data-k="zones" ${Ly.zones ? 'checked' : ''}> Safety zones</label>
    <div class="field"><span>Stops</span><div class="seg">${[['off', 'Off'], ['possible', 'Possible'], ['all', 'All']].map(([v, l]) => `<button type="button" data-act="ly-stops" data-v="${v}" class="${Ly.stops === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
    <div class="field"><span>Places</span>${S.pack.cats.map(c => `<label class="check"><input type="checkbox" data-act="ly-cat" data-k="${c.id}" ${Ly.cats[c.id] ? 'checked' : ''}><span class="sw" style="border-color:${catColor(c.id)};background:${catColor(c.id)}"></span>${esc(c.label)} <span class="muted small">(${S.L.cats[c.id].items.filter(i => i.on).length})</span></label>`).join('')}</div>
    <div class="field"><span>Base map</span><div class="seg">${[['osm', 'Streets'], ['sketch', 'Offline sketch']].map(([v, l]) => `<button type="button" data-act="ly-base" data-v="${v}" class="${Ly.base === v ? 'on' : ''}">${l}</button>`).join('')}</div></div></div>`;
  const T = S.ui.tool;
  h += `<div class="grp"><h2>Tools</h2><p class="note">Only on this phone. Not shared.</p>
    <div class="row"><button type="button" class="btn small${T.mode === 'measure' ? ' primary' : ''}" data-act="tool" data-v="measure">Measure distance</button><button type="button" class="btn small${T.mode === 'circle' ? ' primary' : ''}" data-act="tool" data-v="circle">Draw circle</button><button type="button" class="btn small ghost" data-act="tool-clear">Clear</button></div>
    ${T.mode === 'circle' ? `<div class="chips">${[500, 1000, 2000, 5000].map(r => `<button type="button" class="chipbtn${T.r === r ? ' on' : ''}" data-act="tool-r" data-v="${r}">${r < 1000 ? r + ' m' : r / 1000 + ' km'}</button>`).join('')}</div>` : ''}</div>`;
  return h;
};
PANES.lists = () => {
  const U = S.ui.list, cid = U.cid;
  const opts = [['stops', 'Hiding stops']].concat(S.pack.cats.map(c => [c.id, c.label]));
  const items = cid === 'stops' ? S.L.stops : S.L.cats[cid].items;
  const on = items.filter(i => i.on).length;
  let h = `<div class="grp"><h2>Place lists</h2><p class="note">Lists are shared with everyone in this game, so both sides answer from the same places. Changes apply to all phones at once.</p>
    <label class="field"><span>List</span><select id="ls-cid">${opts.map(([v, l]) => `<option value="${v}"${v === cid ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
    <div class="row"><span class="grow small muted">${on} of ${items.length} switched on</span><button type="button" class="btn small" data-act="ls-add">Add a place</button></div>`;
  if (U.adding) h += `<div class="card hot">${U.adding.la ? `<label class="field"><span>Name</span><input id="ls-addname" type="text" maxlength="60" placeholder="Name"></label><div class="row"><button type="button" class="btn primary small" data-act="ls-add-save">Add</button><button type="button" class="btn small" data-act="ls-add-cancel">Cancel</button></div>` : `<p>Tap the map where the place is.</p><button type="button" class="btn small" data-act="ls-add-cancel">Cancel</button>`}</div>`;
  h += `<input id="ls-q" type="search" placeholder="Search ${esc(opts.find(o => o[0] === cid)[1].toLowerCase())}" value="${esc(U.q)}" aria-label="Search list"></div><div id="ls-rows">${listRows()}</div>`;
  return h;
};
function listRows() {
  const U = S.ui.list, cid = U.cid, q = U.q.trim().toLowerCase();
  const items = (cid === 'stops' ? S.L.stops : S.L.cats[cid].items).filter(i => !q || i.n.toLowerCase().includes(q));
  const shown = items.slice(0, 150);
  let h = `<div class="list">${shown.map(i => `<div class="li${i.on ? '' : ' off'}">
      <input type="checkbox" data-act="ls-on" data-id="${esc(i.id)}" ${i.on ? 'checked' : ''} aria-label="Use ${esc(i.n)}" style="width:18px;height:18px;accent-color:var(--madder)">
      ${U.edit === i.id ? `<input id="ls-ren" type="text" value="${esc(i.n)}" maxlength="60" class="nm"><button type="button" class="iconbtn" data-act="ls-ren-save" data-id="${esc(i.id)}" aria-label="Save name">✓</button>`
      : `<span class="nm">${esc(i.n)}${i.added ? '<small>added in this game</small>' : i.mode === 'tram' ? '<small>tram</small>' : ''}</span>
      <button type="button" class="iconbtn" data-act="ls-show" data-id="${esc(i.id)}" aria-label="Show on map" title="Show on map">◎</button>
      <button type="button" class="iconbtn" data-act="ls-ren" data-id="${esc(i.id)}" aria-label="Rename" title="Rename">✎</button>
      ${i.added ? `<button type="button" class="iconbtn" data-act="ls-del" data-id="${esc(i.id)}" aria-label="Remove" title="Remove">✕</button>` : ''}`}
    </div>`).join('')}</div>`;
  if (items.length > shown.length) h += `<p class="note">Showing ${shown.length} of ${items.length}. Search to narrow it down.</p>`;
  if (!items.length) h += `<p class="muted">Nothing matches.</p>`;
  return h;
}
PANES.game = () => {
  const m = S.game.meta || {}, players = Object.values(S.game.players || {});
  const link = location.origin + location.pathname + '?g=' + S.code;
  let h = '';
  if (S.mode === 'local') h += `<div class="card"><b>Practice mode</b><p class="note">This game lives only on this device. Open a second tab to try the other role.</p></div>`;
  else h += `<div class="grp"><h2>Game code</h2><div class="row"><span class="grow" style="font:800 40px/1 var(--f-display);letter-spacing:.12em">${esc(S.code)}</span><button type="button" class="btn small" data-act="copy-link">Copy link</button></div>
    <p class="small muted mono" style="overflow-wrap:anywhere" id="g-link">${esc(link)}</p></div>`;
  const ph = phase(), lock = ph !== 'lobby';
  const hiders = players.filter(p => p.role === 'hider').length, seekers = players.filter(p => p.role !== 'hider').length;
  h += `<div class="card hot"><span class="small muted">Game clock</span><h3 id="g-phase-timer">${esc(timerText())}</h3>`;
  if (ph === 'lobby') h += `<p class="note">Starting gives the hider ${m.hideMin ?? CFG.defaults.hideMin} min to reach their stop. Then the seeking clock runs until the seekers end the game.${hiders ? '' : ' <b>No hider has joined yet.</b>'}</p>
      ${S.ui.confirm === 'start' ? `<div class="confirm"><span class="grow">Start now for everyone?</span><button type="button" class="btn small primary" data-act="start-yes">Start</button><button type="button" class="btn small" data-act="confirm-no">Cancel</button></div>` : `<button type="button" class="btn primary wide" data-act="start">Start game</button>`}`;
  else if (ph === 'ended') h += `<p class="note">Seeking took ${clock(m.endedAt - m.startedAt - hideMs())}.</p>
      ${S.ui.confirm === 'newround' ? `<div class="confirm"><span class="grow">Clear all questions and start a new round? Lists and rules are kept.</span><button type="button" class="btn small primary" data-act="newround-yes">New round</button><button type="button" class="btn small" data-act="confirm-no">Cancel</button></div>` : `<button type="button" class="btn wide" data-act="newround">Set up a new round</button>`}`;
  else if (paused()) h += `<p class="note">Paused by ${esc(m.pausedBy || 'a player')}. All clocks, including answer timers, are stopped.</p><button type="button" class="btn primary wide" data-act="resume">Resume game</button>`;
  else h += `<p class="note">${ph === 'hiding' ? 'The hider is on their way. Questions open when this reaches zero.' : 'Seekers end the game at the bottom of this tab once the hider is found.'}</p>`;
  h += `</div>`;
  h += `<div class="grp"><h2>You</h2><label class="field"><span>Name</span><input id="g-name" type="text" maxlength="24" value="${esc(S.name)}"></label>
    <div class="field"><span>Role on this phone</span><div class="seg">${[['seeker', 'Seeker'], ['hider', 'Hider']].map(([v, l]) => `<button type="button" data-act="role" data-v="${v}" class="${S.role === v ? 'on' : ''}" ${lock ? 'disabled' : ''}>${l}</button>`).join('')}</div>
    ${lock ? '<p class="note">Roles are locked once the game starts.</p>' : ''}</div>
    ${S.role === 'seeker' ? `<label class="check"><input type="checkbox" data-act="share-loc" ${S.ui.shareLoc ? 'checked' : ''}> Share my location with everyone in the game</label>` : '<p class="note">As hider, your location is never shared.</p>'}</div>`;
  h += `<div class="grp"><h2>Rules for this game</h2>
    <label class="field"><span>Hiding time (minutes)</span><input id="g-hide" type="number" min="0" max="240" step="5" value="${m.hideMin ?? CFG.defaults.hideMin}" ${lock ? 'disabled' : ''}></label>
    <div class="row"><label class="field grow"><span>Answer time (min)</span><input id="g-ans" type="number" min="1" max="60" step="1" value="${m.ansMin ?? CFG.defaults.ansMin}" ${lock ? 'disabled' : ''}></label>
      <label class="field grow"><span>Photo answer time (min)</span><input id="g-photo" type="number" min="1" max="60" step="1" value="${m.photoMin ?? CFG.defaults.photoMin}" ${lock ? 'disabled' : ''}></label></div>
    <label class="field"><span>Hiding radius around the stop (m)</span><input id="g-radius" type="number" min="100" max="3000" step="50" value="${R()}" ${lock ? 'disabled' : ''}></label>
    <label class="check"><input type="checkbox" data-act="g-safety" ${m.safety !== false ? 'checked' : ''} ${lock ? 'disabled' : ''}> Hider may not hide in “No hiding” safety zones</label>
    <p class="note">${lock ? 'Rules are locked while the game runs.' : 'Rule changes apply to everyone in the game.'}</p></div>`;
  const np = 'Notification' in window ? Notification.permission : 'unsupported';
  h += `<div class="grp"><h2>Alerts</h2>
    <p class="note">Questions, answers and expired timers vibrate the phone and play a sound. ${IOS ? '<b>On iPhone</b>, Safari doesn’t let websites vibrate, so you get a short haptic tap instead (iOS 18 or later), plus the sound. ' : ''}With notifications on, they also appear while the browser is in the background. Phones stop web pages soon after the screen locks, so keep this page open during the game.</p>
    ${np === 'granted' ? '<p class="small"><b>Notifications are on.</b></p>' : np === 'denied' ? '<p class="small warn">Notifications are blocked for this site. Allow them in your browser settings.</p>' : np === 'unsupported' ? '<p class="small muted">This browser cannot show notifications. On iPhone, add the site to your home screen first.</p>' : '<button type="button" class="btn" data-act="notif-on">Turn on notifications</button>'}
    <label class="check"><input type="checkbox" data-act="sound" ${S.ui.sound ? 'checked' : ''}> Play a sound</label>
    <label class="check"><input type="checkbox" data-act="wake" ${S.ui.wake ? 'checked' : ''}> Keep the screen on while this page is open</label>
    <button type="button" class="btn small ghost" data-act="test-alert">Test alert</button></div>`;
  h += `<div class="grp"><h2>Players</h2><div class="list">${players.length ? players.map(p => `<div class="li"><span class="nm">${esc(p.name || 'Someone')}<small>${p.role === 'hider' ? 'Hider' : 'Seeker'} · seen ${ago(p.seen)}</small></span></div>`).join('') : '<div class="li muted">Only you so far.</div>'}</div></div>`;
  h += `<div class="grp"><h2>Region</h2><p class="small">${esc(S.pack.name)}. ${esc(S.pack.note)}</p><p class="small muted mono">App version ${APP_VERSION}</p></div>`;
  if ((ph === 'hiding' || ph === 'seeking') && !paused()) h += `<div class="grp"><h2>Pause</h2><p class="note">Stops every clock for everyone, including answer timers, until someone resumes.</p>
    ${S.ui.confirm === 'pause' ? `<div class="confirm"><span class="grow">Pause the game for everyone?</span><button type="button" class="btn small primary" data-act="pause-yes">Pause</button><button type="button" class="btn small" data-act="confirm-no">Cancel</button></div>` : `<button type="button" class="btn" data-act="pause">Pause game…</button>`}</div>`;
  if (S.role === 'seeker' && (ph === 'hiding' || ph === 'seeking')) h += `<div class="grp"><h2>End the game</h2><p class="note">Press only when the hider has been found. This stops the clock for everyone.</p>
    ${S.ui.confirm === 'end' ? `<div class="confirm"><span class="grow">Hider found? End the game now?</span><button type="button" class="btn small primary" data-act="end-yes">End game</button><button type="button" class="btn small" data-act="confirm-no">Cancel</button></div>` : `<button type="button" class="btn" data-act="end">End game…</button>`}</div>`;
  h += S.ui.confirm === 'leave' ? `<div class="confirm"><span class="grow">Leave this game on this phone?</span><button type="button" class="btn small primary" data-act="leave-yes">Leave</button><button type="button" class="btn small" data-act="confirm-no">Cancel</button></div>`
    : `<button type="button" class="btn ghost" data-act="leave">Leave game</button>`;
  return h;
};

/* ------------------------------------------------------------------ ask draft */
function draftQ() {
  const a = S.ui.ask, t = a.type, P = a.pins;
  if (t === 'photo') {
    if (!a.subj) return null;
    const pre = PHOTOS.find(p => p[0] === a.subj);
    const q = { type: 'photo', p: { subj: a.subj, text: pre ? pre[2] : `Send a photo of ${a.subj}.` } };
    if (usedKeys().has(qKey(q))) return { err: 'This photo has already been asked. Pick another.' };
    return q;
  }
  const need = t === 'thermo' ? 2 : 1;
  for (let i = 0; i < need; i++) if (!P[i]) return null;
  for (let i = 0; i < need; i++) if (G.idx(P[i][0], P[i][1]) < 0) return { err: 'Move the pin inside the map area.' };
  const q = { type: t, p: {} };
  if (t === 'radar') Object.assign(q.p, { la: P[0][0], lo: P[0][1], r: a.r });
  if (t === 'thermo') {
    Object.assign(q.p, { la1: P[0][0], lo1: P[0][1], la2: P[1][0], lo2: P[1][1], td: a.td });
    const d = dm(P[0][0], P[0][1], P[1][0], P[1][1]);
    if (d < a.td) return { err: `For the ${fmtD(a.td)} thermometer, the pins must be at least ${fmtD(a.td)} apart (now ${fmtD(d)}).` };
  }
  if (t === 'measure' || t === 'match') {
    const n = nearestAt(a.cat, P[0][0], P[0][1]);
    if (!n) return { err: 'No places in this list. Switch some on in Lists.' };
    Object.assign(q.p, { la: P[0][0], lo: P[0][1], cat: a.cat, refName: n.item.n, refLa: n.item.la, refLo: n.item.lo });
    if (t === 'measure') q.p.ref = Math.round(n.d * 10) / 10; else q.p.refId = n.item.id;
  }
  if (usedKeys().has(qKey(q))) return { err: t === 'radar' ? `A ${fmtD(a.r)} radar has already been asked. Pick another radius.` : t === 'thermo' ? `The ${fmtD(a.td)} thermometer has already been used.` : `${QT[t].label} on ${catLabel(a.cat).toLowerCase()} has already been asked.` };
  return q;
}
const previewKey = q => JSON.stringify(q) + S.sig + R() + (STATE ? STATE.n : '');
const runPreview = debounce(() => {
  const q = draftQ();
  if (!q || q.err || q.type === 'photo' || S.role !== 'seeker' || S.ui.tab !== 'ask') { S.preview = null; S.previewMask = null; renderMask(); return; }
  const key = previewKey(q); if (S.preview && S.preview.key === key) return;
  const r = previewDraft(q);
  S.preview = { key, r }; S.previewMask = r[QT[q.type].ans[0]].c;
  renderMask(S.previewMask); render();
}, 250);
function drawDraft() {
  layers.draft.clearLayers();
  if (S.role !== 'seeker' || S.ui.tab !== 'ask') return;
  const a = S.ui.ask;
  a.pins.forEach((p, i) => {
    if (!p) return;
    const m = L.marker(p, { icon: PIN(css('--madder')), draggable: true, autoPan: true }).addTo(layers.draft);
    m.on('drag', e => { a.pins[i] = [e.latlng.lat, e.latlng.lng]; if (a.type === 'radar' && layers.draftCircle) layers.draftCircle.setLatLng(e.latlng); });
    m.on('dragend', () => { if (i === (a.type === 'thermo' ? 1 : 0)) a.follow = false; drawDraft(); render(); runPreview(); });
  });
  if (a.type === 'radar' && a.pins[0]) layers.draftCircle = L.circle(a.pins[0], { radius: a.r, color: css('--madder'), weight: 2, dashArray: '6 5', fill: false, interactive: false }).addTo(layers.draft);
  if (a.type === 'thermo' && a.pins[0] && a.pins[1]) L.polyline(a.pins, { color: css('--madder'), weight: 2, dashArray: '6 5', interactive: false }).addTo(layers.draft);
  const q = draftQ();
  const label = (ll, txt) => L.marker(ll, { icon: L.divIcon({ className: '', html: `<span class="mlabel">${esc(txt)}</span>`, iconSize: null }), interactive: false, zIndexOffset: 800 }).addTo(layers.draft);
  if (q && !q.err && q.p.refLa) {
    L.polyline([[q.p.la, q.p.lo], [q.p.refLa, q.p.refLo]], { color: css('--madder'), weight: 2, dashArray: '2 5', interactive: false }).addTo(layers.draft);
    L.circleMarker([q.p.refLa, q.p.refLo], { radius: 6, color: '#fff', weight: 2, fillColor: css('--madder'), fillOpacity: 1, interactive: false }).addTo(layers.draft);
    const d = dm(q.p.la, q.p.lo, q.p.refLa, q.p.refLo);
    label([q.p.refLa, q.p.refLo], q.type === 'measure' ? `${q.p.refName} · ${fmtD(q.p.ref)}` : `${q.p.refName}${d > 1 ? ' · ' + fmtD(d) : ''}`);
  } else if (q && !q.err && q.type === 'measure' && q.p.cat === 'coast') label([q.p.la, q.p.lo], `Coast · ${fmtD(q.p.ref)}`);
  if (a.type === 'radar' && a.pins[0]) label([a.pins[0][0] + a.r / 110574, a.pins[0][1]], 'radius ' + fmtD(a.r));
  if (a.type === 'thermo' && a.pins[0] && a.pins[1]) label([(a.pins[0][0] + a.pins[1][0]) / 2, (a.pins[0][1] + a.pins[1][1]) / 2], 'moved ' + fmtD(dm(a.pins[0][0], a.pins[0][1], a.pins[1][0], a.pins[1][1])));
  if (q && q.err) label(a.pins[a.type === 'thermo' ? 1 : 0] || map.getCenter(), q.err.length > 60 ? q.err.slice(0, 58) + '…' : q.err);
}
function drawHider() {
  layers.hider.clearLayers();
  if (S.role !== 'hider') return;
  const s = S.hider || (S.ui.pick && S.L.stops.find(x => x.id === S.ui.pick));
  if (!s) return;
  L.circle([s.la, s.lo], { radius: R(), color: css('--madder'), weight: 2.5, fillColor: css('--madder'), fillOpacity: .08, dashArray: S.hider ? null : '6 5', interactive: false }).addTo(layers.hider);
  L.circleMarker([s.la, s.lo], { radius: 7, color: '#fff', weight: 2, fillColor: css('--madder'), fillOpacity: 1 }).bindPopup(`<b>${esc(s.n)}</b>`).addTo(layers.hider);
}

/* ------------------------------------------------------------------ events */
let mapMode = null;
function setMode(m, msg) { mapMode = m; hint(m ? msg : null, !!m); }
function onMapClick(e) {
  const ll = [e.latlng.lat, e.latlng.lng];
  const consumed = () => setTimeout(() => map.closePopup(), 0);
  if (mapMode || S.ui.tool.mode || (S.role === 'seeker' && S.ui.tab === 'ask' && S.ui.ask.type !== 'photo')) consumed();
  if (!mapMode && !S.ui.tool.mode && S.role === 'seeker' && S.ui.tab === 'ask' && S.ui.ask.type !== 'photo') {
    const pi = S.ui.ask.type === 'thermo' ? (S.ui.ask.active ?? 1) : 0;
    S.ui.ask.pins[pi] = ll; if (pi === (S.ui.ask.type === 'thermo' ? 1 : 0)) S.ui.ask.follow = false; drawDraft(); render(); runPreview();
    return;
  }
  if (mapMode === 'addplace') { S.ui.list.adding = { la: ll[0], lo: ll[1] }; setMode(null); setTimeout(() => L.popup().setLatLng(ll).setContent('New place here').openOn(map), 10); render(); setTimeout(() => $('#ls-addname') && $('#ls-addname').focus(), 50); return; }
  const T = S.ui.tool;
  if (T.mode === 'measure') {
    if (!T.a) { T.a = ll; L.circleMarker(ll, { radius: 5, color: css('--ink'), fillColor: css('--paper'), fillOpacity: 1, weight: 2 }).addTo(layers.tools); hint('Tap the second point.', true); }
    else { const d = dm(T.a[0], T.a[1], ll[0], ll[1]); L.polyline([T.a, ll], { color: css('--ink'), weight: 3, dashArray: '4 6' }).addTo(layers.tools);
      L.marker([(T.a[0] + ll[0]) / 2, (T.a[1] + ll[1]) / 2], { icon: L.divIcon({ className: '', html: `<span class="mlabel">${fmtD(d)}</span>`, iconSize: null }), interactive: false }).addTo(layers.tools);
      L.circleMarker(ll, { radius: 5, color: css('--ink'), fillColor: css('--paper'), fillOpacity: 1, weight: 2 }).addTo(layers.tools); T.a = null; hint(`Distance: ${fmtD(d)}. Tap to measure again.`, true); }
    return;
  }
  if (T.mode === 'circle') { L.circle(ll, { radius: T.r, color: css('--ink'), weight: 2, fill: false, dashArray: '6 5' }).addTo(layers.tools); L.circleMarker(ll, { radius: 3, color: css('--ink'), fillOpacity: 1 }).addTo(layers.tools); return; }
}
function act(el) {
  const a = el.dataset.act, id = el.dataset.id, v = el.dataset.v;
  const A = S.ui.ask;
  switch (a) {
    case 'cancel-mode': setMode(null); S.ui.tool.mode = null; S.ui.tool.a = null; S.ui.list.adding = null; render(); break;
    case 'ask-type': A.type = v; ensurePins(); S.preview = null; drawDraft(); render(); runPreview(); break;
    case 'ask-subj': A.subj = v; render(); break;
    case 'ask-td': A.td = +v; S.preview = null; drawDraft(); render(); runPreview(); break;
    case 'ask-r': A.r = +v; S.preview = null; drawDraft(); render(); runPreview(); break;
    case 'pin-gps': startGPS(); if (S.me) { A.pins[+el.dataset.i] = [S.me.la, S.me.lo]; if (+el.dataset.i === (A.type === 'thermo' ? 1 : 0)) A.follow = true; drawDraft(); render(); runPreview(); } else toast('Waiting for your location… try again in a moment.'); break;
    case 'pin-follow': A.follow = true; if (S.me) { A.pins[A.type === 'thermo' ? 1 : 0] = [S.me.la, S.me.lo]; drawDraft(); render(); runPreview(); } break;
    case 'pin-tap': A.active = +el.dataset.i; render(); hint('Tap the map to move this pin.'); setTimeout(() => { if (!mapMode) hint(null); }, 2500); break;
    case 'ask-send': {
      if (phase() !== 'seeking' || paused()) { toast(paused() ? 'The game is paused.' : 'Questions open when hiding time ends.'); return; }
      if (A.type !== 'photo') {
        // questions are sent from the seeker's GPS position at the moment Send is pressed, never from a preview pin
        if (!S.me) { startGPS(); toast('Waiting for your location. Turn location on to send questions.', 5000); return; }
        A.pins[A.type === 'thermo' ? 1 : 0] = [S.me.la, S.me.lo];
      }
      const q = draftQ(); if (!q || q.err) { if (q && q.err) toast(q.err, 6000); drawDraft(); render(); return; }
      if (q.type !== 'photo') q.p.acc = S.me.acc;
      W.push('qs', Object.assign(q, { by: S.name || 'Seeker', uid: S.uid, t: B.now(), pt: S.game.meta?.pausedTotal || 0 }));
      S.preview = null; S.previewMask = null; A.pins = []; A.follow = true; S.ui.tab = 'log'; drawDraft(); toast('Question sent.'); render(); renderMask(); break;
    }
    case 'q-show': { const q = allQs().find(x => x.id === id); if (!q || !isDeduce(q)) return; const p = q.p;
      const pts = q.type === 'thermo' ? [[p.la1, p.lo1], [p.la2, p.lo2]] : [[p.la, p.lo]].concat(p.refLa ? [[p.refLa, p.refLo]] : []);
      const b = L.latLngBounds(pts); if (q.type === 'radar') b.extend(L.latLng(p.la, p.lo).toBounds(2 * p.r));
      map.flyToBounds(b.pad(0.2), { maxZoom: 16, duration: .5 }); break; }
    case 'q-del': S.ui.confirm = 'del-' + id; render(); break;
    case 'q-eye': { const q = (S.game.qs || {})[id]; if (q) W.set('qs/' + id + '/off', q.off ? null : true); break; }
    case 'move': S.ui.confirm = 'move'; render(); break;
    case 'move-yes': S.ui.confirm = null; allQs().forEach(q => { if (q.a && isDeduce(q) && !q.off) W.set('qs/' + q.id + '/off', true); }); toast('All earlier shading hidden.'); break;
    case 'unhide-all': allQs().forEach(q => { if (q.off) W.set('qs/' + q.id + '/off', null); }); break;
    case 'q-del-yes': W.set('qs/' + id, null); S.ui.confirm = null; break;
    case 'confirm-no': S.ui.confirm = null; render(); break;
    case 'answer': {
      { const q0 = (S.game.qs || {})[id]; if (q0) { const late = q0.late || qElapsed(Object.assign({ id }, q0)) > limitMs(q0); setTimeout(() => toast(late ? 'Answer sent late: no card draw.' : `Answer sent. ${cardText(q0.type)}.`, 5000), 50); } } const q = (S.game.qs || {})[id]; if (!q) return; const m = S.game.meta || {}; W.set('qs/' + id, Object.assign({}, q, { a: v, at: B.now(), apt: (m.pausedTotal || 0) + (m.pausedAt ? Math.max(0, now() - m.pausedAt) : 0), aby: S.name || 'Hider' })); break; }
    case 'gps-on': startGPS(); break;
    case 'pick-stop': S.ui.pick = id; map.closePopup(); S.ui.tab = 'zone'; const s = S.L.stops.find(x => x.id === id); if (s) map.flyTo([s.la, s.lo], 15, { duration: .5 }); drawHider(); render(); break;
    case 'lock-stop': { const s = S.L.stops.find(x => x.id === S.ui.pick); if (!s) return; S.hider = { id: s.id, n: s.n, la: s.la, lo: s.lo, t: Date.now() }; LS.set(roundKey(), S.hider); S.ui.pick = null; lastInside = null; startGPS(); drawHider(); render(); toast('Stop locked in. Go hide!'); break; }
    case 'zone-show': if (S.hider) map.flyTo([S.hider.la, S.hider.lo], 15, { duration: .5 }); break;
    case 'unlock': S.ui.confirm = 'unlock'; render(); break;
    case 'unlock-yes': S.hider = null; LS.del(roundKey()); S.ui.confirm = null; drawHider(); render(); break;
    case 'ly': S.ui.layers[el.dataset.k] = el.checked; saveLayers(); if (el.dataset.k === 'zones') drawZones(); else renderMask(S.ui.tab === 'ask' ? S.previewMask : null); break;
    case 'ly-stops': S.ui.layers.stops = v; saveLayers(); drawStops(); render(); break;
    case 'ly-cat': S.ui.layers.cats[el.dataset.k] = el.checked; saveLayers(); drawCats(); break;
    case 'ly-base': S.ui.layers.base = v; saveLayers(); setBase(); render(); break;
    case 'tool': S.ui.tool.mode = S.ui.tool.mode === v ? null : v; S.ui.tool.a = null; setMode(null); if (S.ui.tool.mode) hint(v === 'measure' ? 'Tap the first point.' : 'Tap to place a circle.', true); render(); break;
    case 'tool-r': S.ui.tool.r = +v; render(); break;
    case 'tool-clear': layers.tools.clearLayers(); S.ui.tool.a = null; break;
    case 'ls-on': listOverride(S.ui.list.cid, 'off/' + id, el.checked ? null : true); break;
    case 'ls-show': { const it = findItem(id); if (it) { map.flyTo([it.la, it.lo], 16, { duration: .5 }); L.popup().setLatLng([it.la, it.lo]).setContent(`<b>${esc(it.n)}</b>`).openOn(map); } break; }
    case 'ls-ren': S.ui.list.edit = id; render(); setTimeout(() => $('#ls-ren') && $('#ls-ren').focus(), 30); break;
    case 'ls-ren-save': { const it = findItem(id), nv = ($('#ls-ren').value || '').trim(); S.ui.list.edit = null; if (it && nv && nv !== it.n) listOverride(S.ui.list.cid, 'ren/' + id, nv); else render(); break; }
    case 'ls-del': { const it = findItem(id); if (it && it.added) listOverride(S.ui.list.cid, 'add/' + it.key, null); break; }
    case 'ls-add': S.ui.list.adding = {}; setMode('addplace', 'Tap the map where the place is.'); if (innerWidth <= 760) S.ui.sheetMin = true; render(); break;
    case 'ls-add-cancel': S.ui.list.adding = null; setMode(null); render(); break;
    case 'ls-add-save': { const ad = S.ui.list.adding, nm = ($('#ls-addname').value || '').trim(); if (!nm) { toast('Give the place a name.'); return; } listOverride(S.ui.list.cid, 'add/' + Date.now().toString(36), { n: nm, la: +ad.la.toFixed(6), lo: +ad.lo.toFixed(6) }); S.ui.list.adding = null; map.closePopup(); break; }
    case 'copy-link': { const t = $('#g-link').textContent; (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => toast('Link copied.'), () => { const r = document.createRange(); r.selectNodeContents($('#g-link')); getSelection().removeAllRanges(); getSelection().addRange(r); toast('Select and copy the link.'); }); break; }
    case 'role': if (started()) { toast('Roles are locked once the game starts.'); return; } if (S.role !== v) { S.role = v; LS.set('seek-role', v); S.ui.tab = null; S.preview = null; registerPlayer(); if (v === 'hider') { startGPS(); S.hider = LS.get(roundKey(), null); W.set('locs/' + S.uid, null); lastPush = null; } else { lastPush = null; pushLoc(); } drawDraft(); drawHider(); drawStops(); render(); renderMask(); } break;
    case 'g-safety': if (started()) return; W.set('meta/safety', el.checked); break;
    case 'start': S.ui.confirm = 'start'; render(); break;
    case 'start-yes': S.ui.confirm = null; W.set('meta/endedAt', null); W.set('meta/startedAt', B.now()); break;
    case 'end': S.ui.confirm = 'end'; render(); break;
    case 'pause': S.ui.confirm = 'pause'; render(); break;
    case 'pause-yes': S.ui.confirm = null; if (!paused()) { W.set('meta/pausedBy', S.name || 'a player'); W.set('meta/pausedAt', B.now()); } break;
    case 'resume': { const m = S.game.meta || {}; if (m.pausedAt) { W.set('meta/pausedTotal', (m.pausedTotal || 0) + Math.max(0, now() - m.pausedAt)); W.set('meta/pausedAt', null); } break; }
    case 'notif-on': if ('Notification' in window) Notification.requestPermission().then(() => render()); break;
    case 'sound': S.ui.sound = el.checked; LS.set('seek-sound', el.checked); break;
    case 'wake': S.ui.wake = el.checked; LS.set('seek-wake', el.checked); wake(); break;
    case 'test-alert': alertUser('Test alert', 'This is how questions and answers will arrive.', 'test'); break;
    case 'end-yes': { S.ui.confirm = null; const m = S.game.meta || {}; if (m.pausedAt) { W.set('meta/pausedTotal', (m.pausedTotal || 0) + Math.max(0, now() - m.pausedAt)); W.set('meta/pausedAt', null); } W.set('meta/endedAt', B.now()); break; }
    case 'newround': S.ui.confirm = 'newround'; render(); break;
    case 'newround-yes': S.ui.confirm = null; W.set('meta/round', (S.game.meta?.round || 0) + 1); W.set('meta/pausedTotal', 0); W.set('meta/pausedAt', null); W.set('qs', null); W.set('locs', null); W.set('meta/startedAt', null); W.set('meta/endedAt', null); S.hider = null; drawHider(); break;
    case 'share-loc': S.ui.shareLoc = el.checked; LS.set('seek-share', el.checked); if (el.checked) startGPS(); else W.set('locs/' + S.uid, null); break;
    case 'leave': S.ui.confirm = 'leave'; render(); break;
    case 'leave-yes': W.set('locs/' + S.uid, null); LS.del('seek-last'); location.href = location.pathname; break;
  }
}
function A_subj(v) { v = v.trim(); if (v) { S.ui.ask.subj = v; render(); } }
function findItem(id) { const cid = S.ui.list.cid; return (cid === 'stops' ? S.L.stops : S.L.cats[cid].items).find(i => i.id === id); }
function listOverride(cid, path, v) { W.set('lists/' + cid + '/' + path, v); }
function saveLayers() { LS.set('seek-layers', S.ui.layers); }

document.addEventListener('click', e => {
  if (e.target.closest && e.target.closest('[data-haptic]')) return;
  const t = e.target.closest('[data-act]');
  if (t && t.tagName !== 'INPUT') { e.preventDefault(); act(t); return; }
  const tab = e.target.closest('[data-tab]');
  if (tab && Date.now() - (S.ui.dragAt || 0) < 400) return;
  if (tab) {
    const id = tab.dataset.tab;
    if (innerWidth <= 760 && id === S.ui.tab) S.ui.sheetMin = !S.ui.sheetMin; else { S.ui.tab = id; S.ui.sheetMin = false; }
    S.ui.confirm = null; if (id === 'ask') ensurePins(); drawDraft(); render(); if (id === 'ask') runPreview(); else if (S.preview) { S.preview = null; renderMask(); }
    return;
  }
  if (e.target.closest('#tb-code')) { S.ui.tab = 'game'; S.ui.sheetMin = false; render(); }
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.matches('input[data-act]')) { act(t); return; }
  if (t.id === 'ask-subj') { A_subj(t.value); }
  if (t.id === 'ask-cat') { S.ui.ask.cat = t.value; S.preview = null; drawDraft(); render(); runPreview(); }
  if (t.id === 'ask-rc') { const v = parseFloat(t.value); if (v > 0) { S.ui.ask.r = Math.round(v * 1000); S.preview = null; drawDraft(); render(); runPreview(); } }
  if (t.id === 'ls-cid') { S.ui.list.cid = t.value; S.ui.list.q = ''; S.ui.list.edit = null; S.ui.list.adding = null; render(); }
  if (t.id === 'g-name') { S.name = t.value.trim().slice(0, 24); LS.set('seek-name', S.name); registerPlayer(); }
  if (t.id === 'g-ans' || t.id === 'g-photo') { const v = Math.round(+t.value); if (!started() && v >= 1 && v <= 60) W.set('meta/' + (t.id === 'g-ans' ? 'ansMin' : 'photoMin'), v); }
  if (t.id === 'g-hide') { const v = Math.round(+t.value); if (!started() && v >= 0 && v <= 240) W.set('meta/hideMin', v); }
  if (t.id === 'g-radius') { if (started()) return; const v = Math.round(+t.value); if (v >= 100 && v <= 3000) W.set('meta/radius', v); else toast('Use a radius between 100 and 3000 m.'); }
});
document.addEventListener('input', e => { if (e.target.id === 'ls-q') { S.ui.list.q = e.target.value; $('#ls-rows').innerHTML = listRows(); } });
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'ls-ren') act($('[data-act="ls-ren-save"]'));
  if (e.key === 'Enter' && e.target.id === 'ls-addname') act($('[data-act="ls-add-save"]'));
  if (e.key === 'Enter' && e.target.id === 'lb-code') $('#lb-join').click();
  if (e.key === 'Escape' && mapMode) act({ dataset: { act: 'cancel-mode' } });
});

/* ------------------------------------------------------------------ game sync */
function onGame(g) {
  const prevLists = JSON.stringify(S.game.lists || {}), prevMeta = JSON.stringify(S.game.meta || {}), prevQs = JSON.stringify(S.game.qs || {}), prevPl = JSON.stringify(S.game.players || {});
  const prevRound = S.game.meta?.round;
  S.game = g || {};
  if (!S.game.meta && !S.firstSync) { toast('This game no longer exists.'); }
  const listsChanged = JSON.stringify(S.game.lists || {}) !== prevLists || !S.L;
  const metaChanged = JSON.stringify(S.game.meta || {}) !== prevMeta;
  const qsChanged = JSON.stringify(S.game.qs || {}) !== prevQs;
  if (listsChanged) { buildLists(); FC.clear(); QC.clear(); drawCats(); }
  if (S.role === 'hider' && S.game.meta?.round !== prevRound) { S.hider = LS.get(roundKey(), null); }
  if (S.role === 'hider' && (S.game.locs || {})[S.uid]) W.set('locs/' + S.uid, null); // clean up pings from before switching role
  drawSeekers();
  notify();
  if (listsChanged || metaChanged || qsChanged || !STATE) { evaluate(); renderMask(); drawStops(); drawQs(); drawHider(); }
  if (S.ui.tab === 'ask' && S.role === 'seeker') { if (ensurePins()) drawDraft(); if (qsChanged || listsChanged || metaChanged) { S.preview = null; } runPreview(); }
  const first = S.firstSync;
  if (first) allQs().forEach(q => { if (q.late || (q.a ? qLate(q) : qElapsed(q) > limitMs(q))) lateSeen.add(q.id); });
  S.firstSync = false;
  const plChanged = JSON.stringify(S.game.players || {}) !== prevPl;
  tick();
  if (first || listsChanged || metaChanged || qsChanged || (plChanged && S.ui.tab === 'game')) render(); else renderTop();
}
function notify() {
  const qs = allQs();
  qs.forEach(q => {
    if (!S.firstSync && !S.seenQ.has(q.id) && !q.a) {
      if (S.role === 'hider') alertUser('New question · ' + Math.round(limitMs(q) / 60000) + ' min to answer', qText(q), 'q-' + q.id, [250, 120, 250, 120, 250]);
      else if (q.uid !== S.uid) toast(`${q.by || 'A seeker'} asked: ${qText(q)}`, 5000);
    }
    if (!S.firstSync && q.a && !S.seenA.has(q.id) && S.role === 'seeker') alertUser('Answer: ' + QT[q.type].names[q.a], qText(q), 'a-' + q.id, [150, 80, 150]);
    S.seenQ.add(q.id); if (q.a) S.seenA.add(q.id);
  });
}
function registerPlayer() { if (S.code && S.uid) W.set('players/' + S.uid, { name: S.name || (S.role === 'hider' ? 'Hider' : 'Seeker'), role: S.role, seen: B.now() }); }

/* ------------------------------------------------------------------ lobby & boot */
const CODE_CH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 5 }, () => CODE_CH[Math.floor(Math.random() * CODE_CH.length)]).join('');
function lbMsg(t, err) { const m = $('#lb-msg'); m.textContent = t; m.className = 'lb-msg' + (err ? ' err' : ''); }
async function loadPack(regionId) {
  const reg = CFG.regions.find(r => r.id === regionId) || CFG.regions[0];
  const res = await fetch(reg.file); if (!res.ok) throw new Error('Could not load the region map.');
  const P = await res.json();
  P.cats.forEach(c => c.items.forEach(it => { if (c.kind === 'area') it._polys = it[4].map(decPoly); if (c.kind === 'line') it._lines = it[4].map(dec); }));
  S.pack = P; G = makeGrid(P.grid); buildBase();
  if (!map) initMap(); else map.setView(P.center, P.zoom);
}
async function enter(mode, code, role, create, region) {
  B = mode === 'local' ? LOCAL : FB; S.mode = mode;
  lbMsg(create ? 'Creating game…' : 'Joining…');
  await B.init(); S.uid = B.uid;
  if (create) {
    let c = code; for (let i = 0; i < 5 && await B.exists(c); i++) c = newCode();
    code = c; await B.set(code, 'meta', { region, radius: CFG.defaults.radius, safety: CFG.defaults.safety, created: B.now(), by: S.name || 'Someone' });
  } else if (!(await B.exists(code))) throw new Error(`No game with code ${code}. Check the code with whoever created it.`);
  const meta = mode === 'local' ? (LOCAL.load(code) || {}).meta : (await FB.ref(code, 'meta').get()).val();
  const me = mode === 'local' ? ((LOCAL.load(code) || {}).players || {})[S.uid] : (await FB.ref(code, 'players/' + S.uid).get()).val();
  if (meta?.startedAt && !meta?.endedAt && me && me.role && me.role !== role) { role = me.role; toast(`This game has started, so you rejoined as ${role}.`, 6000); }
  await loadPack(meta?.region || region);
  S.code = code; S.role = role; LS.set('seek-role', role); LS.set('seek-last', { mode, code });
  S.game = { meta: meta || {} }; S.ui.shareLoc = LS.get('seek-share', true);
  S.hider = role === 'hider' ? LS.get(roundKey(), null) : null; S.game = {};
  $('#lobby').hidden = true; $('#sheet').hidden = false; $('#app').classList.remove('nosheet');
  history.replaceState(null, '', location.pathname + (mode === 'fb' ? '?g=' + code : ''));
  setTimeout(() => map.invalidateSize(), 50);
  B.open(code, onGame); registerPlayer();
  if (role === 'hider' || S.ui.shareLoc) startGPS();
  LS.get('seek-late:' + code, []).forEach(id => lateSeen.add(id));
  wake();
  setInterval(tick, 1000);
  setInterval(() => { registerPlayer(); if (['log', 'answer'].includes(S.ui.tab)) render(); }, 60000);
}
function lobby() {
  $('#app').classList.add('nosheet');
  $('#lb-name').value = S.name;
  $('#lb-region').innerHTML = CFG.regions.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
  let role = LS.get('seek-role', 'seeker');
  const setRole = v => { role = v; document.querySelectorAll('#lb-role button').forEach(b => b.classList.toggle('on', b.dataset.v === v)); };
  setRole(role);
  $('#lb-role').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setRole(b.dataset.v); });
  const g = new URLSearchParams(location.search).get('g'); if (g) $('#lb-code').value = g.toUpperCase();
  const name = () => { S.name = $('#lb-name').value.trim().slice(0, 24); LS.set('seek-name', S.name); };
  const go = (fn) => async () => { name(); document.querySelectorAll('.lobby button').forEach(b => b.disabled = true); try { await fn(); } catch (e) { lbMsg(e.message || String(e), true); } finally { document.querySelectorAll('.lobby button').forEach(b => b.disabled = false); } };
  $('#lb-create').addEventListener('click', go(() => enter('fb', newCode(), role, true, $('#lb-region').value)));
  $('#lb-join').addEventListener('click', go(() => { const c = $('#lb-code').value.trim().toUpperCase(); if (!/^[A-Z2-9]{5}$/.test(c)) throw new Error('Game codes have 5 letters or digits.'); return enter('fb', c, role, false); }));
  $('#lb-local').addEventListener('click', go(async () => { const last = LS.get('seek-local-code', null) || newCode(); LS.set('seek-local-code', last); await LOCAL.init(); const ex = await LOCAL.exists(last); return enter('local', last, role, !ex, $('#lb-region').value); }));
  // load the map behind the lobby so the page doesn't look empty
  loadPack($('#lb-region').value).catch(e => lbMsg(e.message, true));
  const last = LS.get('seek-last', null);
  if (last && !g && last.mode === 'fb') lbMsg(`Last game: ${last.code}. Enter the code to rejoin.`), $('#lb-code').value = last.code;
}
lobby();
window.__seek = { S, evaluate: () => evaluate(), G: () => G, W, map: () => map, layers: () => layers };
})();
