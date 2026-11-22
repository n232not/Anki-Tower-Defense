// Balance bots. Both spend ~INCOME points per wave (what ~30 reviewed cards earn during a 300s wave).
//  weak (default): builds in a fixed rotation, buys the cheapest upgrade, never fires study powers.
//  STRONG=1: answers a card every 10s during waves (study powers fire), favours strong towers,
//            pushes damage towers down their main path, uses 'strong' targeting on snipers.
// Usage: STRONG=1 INCOME=35 node tools/sim/harness.js tools/sim/bot.js
const INCOME = +(process.env.INCOME || 35), MAXW = +(process.env.MAXW || 30);
const DIFFS = (process.env.DIFFS || 'easy,medium,hard,extreme').split(',');
function seeded(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const STRONG = !!process.env.STRONG;
const ORDERED = STRONG ? ['archer', 'cannon', 'tesla', 'frost', 'arcanist', 'pyro', 'sniper', 'trapper', 'bard', 'boomer', 'tesla', 'arcanist']
  : ['archer', 'cannon', 'boomer', 'tesla', 'pyro', 'frost', 'arcanist', 'sniper', 'trapper', 'bard', 'gust'];
D.chooseMap('meadow'); D.clear();
const spots = [];
for (let x = 30; x < 930; x += 12) for (let y = 30; y < 570; y += 12) {
  if (!D.canPlace(x, y)) continue;
  let n = 0; for (let d = 0; d < D.lanes[0].len; d += 12) { const p = D.posAt(d, 0); if (Math.hypot(p.x - x, p.y - y) < 130) n++; }
  spots.push([x, y, n]);
}
spots.sort((a, b) => b[2] - a[2]);
// NEWPLAYER=1: lifetime cards start at 0 and grow by 30 per wave, so towers unlock during the run
const NEW = !!process.env.NEWPLAYER;
let cards = NEW ? 0 : 1000;
function setPts(p) { store.points = p; window.TD.setPoints(p, cards); }
const UNLOCK = { archer: 0, frost: 15, boomer: 30, cannon: 45, trapper: 70, sniper: 100, pyro: 130, tesla: 160, gust: 200, arcanist: 240, bard: 300, titan: 400 };
function spend() {
  for (let guard = 0; guard < 60; guard++) {
    const pool = ORDERED.filter(t => cards >= UNLOCK[t]);
    const want = pool[D.towers.length % pool.length];
    const cost = { archer: 10, cannon: 25, boomer: 30, tesla: 45, pyro: 45, frost: 18, arcanist: 50, sniper: 35, trapper: 28, bard: 40, gust: 35 }[want];
    // build a new tower if we have fewer than 4, or every so often when it's affordable
    const wantNew = STRONG ? (D.towers.length < 3 || (D.towers.length < 12 && D.towers.every(t => t.a + t.b >= 3)))
      : (D.towers.length < 4 || (D.towers.length < 12 && Math.random() < 0.35));
    if (wantNew && store.points >= cost) {
      const s = spots.find(p => D.canPlace(p[0], p[1]));
      if (s) { D.buyTower(want, s[0], s[1]); continue; }
    }
    // otherwise the cheapest affordable upgrade
    let best = null;
    for (const t of D.towers) for (const path of [0, 1]) {
      const lvl = path ? t.b : t.a; if (lvl >= 3) continue;
      if (!(lvl + 1 <= 1 || (path ? t.a : t.b) <= 1)) continue;
      const up = D.towerDef(t.type).paths[path][lvl];
      // strong bot: main path (A) first, value = cost discounted by how far along the path it is
      const score = STRONG ? up.cost * (path === 0 ? 1 : 1.6) / (1 + lvl * 0.3) : up.cost;
      if (up.cost <= store.points && (!best || score < best.score)) best = { t, path, cost: up.cost, score };
    }
    if (!best) { if (STRONG && wantNew) break; break; }
    D.select(best.t); D.upgradeSelected(best.path); D.select(null);
  }
}
const rows = [];
let peak = 0, firstLeak = null;
const SEEDS = +(process.env.SEEDS || 1);
for (const diff of DIFFS) for (let seed = 1; seed <= SEEDS; seed++) {
  Math.random = seeded(seed * 1009);
  if (D.gameOver) els['td-ov-btn'].onclick();
  D.chooseMap('meadow'); D.clear();
  D.game.wave = 1; D.game.diff = diff; D.game.mods = null; D.game.pressure = 0; D.game.endless = false; D.setDifficulty(diff); D.game.mods = null;
  cards = NEW ? 0 : 1000; peak = 0; global.__lv = undefined; firstLeak = null;
  setPts(60);
  const durations = [];
  let w = 0;
  const goal = ({ easy: 12, medium: 15, hard: 15, extreme: 15 })[diff];
  while (w < goal && !D.gameOver) {
    spend();
    if (STRONG) D.towers.forEach(t => { if (t.type === 'sniper') t.target = 'strong'; });
    D.startWave();
    let f = 0; while (D.running && f < 40000) { D.tick(0.05); f++; if (STRONG && f % 200 === 0) window.TD.cardAnswered(); if (f % 20 === 0) peak = Math.max(peak, D.enemies.length); }
    durations.push(f * 0.05);
    if (process.env.PERWAVE) { const lost = Math.max(0, (global.__lv || D.game.lives) - D.game.lives); (global.__pw = global.__pw || {})[w + 1] = ((global.__pw || {})[w + 1] || []).concat([D.gameOver ? 'X' : Math.round(lost)]); }
    if (firstLeak === null && (global.__lv !== undefined && D.game.lives < global.__lv || D.gameOver)) firstLeak = w + 1;
    global.__lv = D.game.lives;
    if (D.gameOver) break;
    if (!document.getElementById('td-overlay').classList.contains('td-hidden')) { /* victory screen */ }
    cards += 30;
    setPts(store.points + INCOME);
    w++;
  }
  const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
  const won = !D.gameOver && D.game.endless !== undefined && w >= ({ easy: 12, medium: 16, hard: 20, extreme: 24 })[diff];
  rows.push({ diff, result: D.gameOver ? 'lost on ' + (w + 1) : 'WON (wave ' + w + ')', livesLeft: D.gameOver ? 0 : Math.round(D.game.lives), avgWaveSecs: avg.toFixed(0), minSecs: Math.min(...durations).toFixed(0), maxSecs: Math.max(...durations).toFixed(0), towers: D.towers.length, firstLeak: firstLeak || '-', peakSlimes: peak, unlockedAtEnd: Object.keys(UNLOCK).filter(t => cards >= UNLOCK[t]).length });
}
if (process.env.PERWAVE) {
  console.log('lives lost per wave (one column per seed; X = run lost on that wave):');
  for (const w of Object.keys(global.__pw).map(Number).sort((a, b) => a - b)) console.log('  wave ' + String(w).padStart(2) + ': ' + global.__pw[w].map(v => String(v).padStart(3)).join(' '));
}
if (SEEDS > 1) {
  const by = {};
  for (const r of rows) { const b = by[r.diff] = by[r.diff] || { wins: 0, runs: 0, waves: 0, lives: 0 }; b.runs++; if (r.result.startsWith('WON')) { b.wins++; b.lives += r.livesLeft; } b.waves += r.result.startsWith('WON') ? +r.result.match(/\d+/)[0] : +r.result.match(/\d+/)[0] - 1; }
  if (process.env.SUMMARY) {
    for (const k in by) { const rs = rows.filter(r => r.diff === k); console.log(k.padEnd(8), 'wins ' + by[k].wins + '/' + by[k].runs, '| first leak on wave', rs.map(r => r.firstLeak).join(','), '| ended', rs.map(r => r.result.startsWith('WON') ? 'W' + r.livesLeft : r.result.match(/\d+/)[0]).join(',')); }
  } else for (const k in by) console.log(k.padEnd(8), 'wins ' + by[k].wins + '/' + by[k].runs, ' avg waves cleared ' + (by[k].waves / by[k].runs).toFixed(1), by[k].wins ? ' avg lives left when won ' + Math.round(by[k].lives / by[k].wins) : '');
} else console.table(rows);
process.exit(0);
