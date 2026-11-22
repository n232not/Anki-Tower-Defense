// Headless test harness: runs the real game.js in Node with a fake DOM and canvas.
// Usage: node tools/sim/harness.js <scenario.js>
// The scenario file gets `D` (game internals), `store` (fake Anki points store),
// `lastSave()` (the last save the game sent) and helpers `spot`/`put`/`waves`.
const fs = require('fs');
const path = require('path');

const GAME = path.join(__dirname, '..', '..', 'study_defense', 'web', 'game.js');
let src = fs.readFileSync(GAME, 'utf8');
// expose internals for testing only (never written back to the game)
src = src.replace('  window.TD = {', `  window.__dbg = {
    get enemies() { return enemies; }, get towers() { return towers; }, get game() { return game; }, get lanes() { return LANES; },
    get map() { return mapId; }, get running() { return running; }, get points() { return points; }, get projectiles() { return projectiles; },
    get gameOver() { return gameOver; }, get MAP() { return MAP; }, get frenzyUntil() { return frenzyUntil; }, get time() { return time; },
    chooseMap, buyTower, leakOf, buildWave, spawnEnemy, damage, get saved() { return saved; }, setDifficulty, towerDef(t) { return TOWERS[t]; }, buildWave, triggerGameOver, upgradeSelected, startWave, canPlace, distToPath, posAt, renderUI, refreshAll, ensureRun, mapRangeMult,
    select(t) { selected = t; }, clear() { towers = []; enemies = []; }, step(dt) { update(dt); draw(); }, tick(dt) { update(dt); },
  };
  window.TD = {`);

const noop = () => {};
const ctxProxy = () => new Proxy({}, {
  get(t, p) {
    if (p in t) return t[p];
    if (p === 'measureText') return () => ({ width: 100 });
    if (p === 'createRadialGradient' || p === 'createLinearGradient') return () => ({ addColorStop: noop });
    return noop;
  },
  set(t, p, v) { t[p] = v; return true; },
});
function cls() {
  const s = new Set();
  return { add: (...a) => a.forEach(x => s.add(x)), remove: (...a) => a.forEach(x => s.delete(x)),
    toggle(x, f) { if (f === undefined) f = !s.has(x); f ? s.add(x) : s.delete(x); return f; }, contains: x => s.has(x) };
}
const els = {};
function mk(tag) {
  return { tag, children: [], style: {}, classList: cls(), textContent: '', innerHTML: '', width: 0, height: 0, title: '',
    listeners: {}, addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }, fire(t) { (this.listeners[t] || []).forEach(f => f({})); }, appendChild(c) { this.children.push(c); return c; }, insertBefore(c) { this.children.unshift(c); return c; },
    get firstChild() { return this.children[0] || mk('text'); }, querySelector() { return mk('q'); }, querySelectorAll() { return []; },
    replaceWith: noop, remove: noop, getContext() { return ctxProxy(); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 960, height: 600 }; }, clientWidth: 960 };
}
global.document = { getElementById(id) { return els[id] || (els[id] = mk('#' + id)); }, createElement: mk, addEventListener: noop, querySelectorAll: () => [] };
global.localStorage = { getItem: () => null, setItem: noop };
global.Image = function () {};
global.requestAnimationFrame = noop;
global.window = global;
global.devicePixelRatio = 1;

const store = { points: 1e6, totalCards: 1000 };
let saved = null;
const sent = [];
global.pycmd = (cmd, cb) => {
  sent.push(cmd);
  if (!cmd.startsWith('commit:')) { cb && cb({ ok: true }); return; }
  const p = JSON.parse(cmd.slice(7));
  if (store.points + p.delta < 0) { cb && cb({ ok: false, points: store.points, totalCards: store.totalCards }); return; }
  store.points += p.delta; saved = p.game;
  cb && cb({ ok: true, points: store.points, totalCards: store.totalCards });
};
global.TD_BOOT = Object.assign({ points: store.points, totalCards: store.totalCards, game: null, unlocks: {}, startLives: 100, waveCountdown: 0 }, JSON.parse(process.env.BOOT || "{}"));
global.TD_SPRITES = {};
global.process_env = (k, d) => process.env[k] !== undefined ? process.env[k] : d;
eval(src);
const D = window.__dbg;

function near(lane, d, off) {
  const p = D.posAt(d, lane), q = D.posAt(d + 2, lane);
  const tx = q.x - p.x, ty = q.y - p.y, l = Math.hypot(tx, ty) || 1;
  return [Math.round(p.x - ty / l * off), Math.round(p.y + tx / l * off)];
}
function spot(lane, d) {
  for (const off of [50, -50, 60, -60, 70, -70, 45, -45]) { const s = near(lane, d, off); if (D.canPlace(s[0], s[1])) return s; }
  return null;
}
function put(type, x, y) {
  const n = D.towers.length; D.buyTower(type, x, y);
  return D.towers.length > n ? D.towers[D.towers.length - 1] : null;
}
function waves(n, maxFrames) {
  for (let w = 0; w < n && !D.gameOver; w++) {
    D.startWave();
    for (let f = 0; f < (maxFrames || 8000) && D.running; f++) D.step(0.05);
  }
}
const scenario = fs.readFileSync(path.resolve(process.argv[2]), 'utf8');
eval(scenario);
