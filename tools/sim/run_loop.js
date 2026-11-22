// Scenario: twists, bans, losing a run, coins for the next one, and the core mechanics.
const ok = (cond, msg) => console.log((cond ? 'PASS ' : 'FAIL ') + msg);

ok(D.game.mods && D.game.mods.twist, 'a run starts with a twist: ' + JSON.stringify(D.game.mods));

D.game.mods = { twist: 'shortage', banned: 'cannon' };
const s1 = spot(0, 300);
ok(!put('cannon', s1[0], s1[1]), 'a banned tower cannot be bought');
ok(!!put('archer', s1[0], s1[1]), 'other towers still can');
const s2 = spot(0, 600);
put('pyro', s2[0], s2[1]);

D.game.wave = 20; D.game.lives = 1;
const before = store.points;
waves(1);
ok(D.gameOver, 'losing all lives ends the run');
ok(store.points - before === 38, 'losing on wave 20 pays 2 coins x 19 cleared waves (got ' + (store.points - before) + ')');
const rec = saved.maps[saved.map];
ok(rec.towers.length === 0 && rec.wave === 1, 'the save already has the towers wiped and wave 1');
ok(rec.bestWave === 19, 'best wave is remembered (' + rec.bestWave + ')');
els['td-ov-btn'].onclick();
ok(D.towers.length === 0 && D.game.wave === 1 && !D.gameOver, 'new run starts empty at wave 1');
ok(D.game.mods && D.game.mods.twist, 'new run rolled a twist: ' + D.game.mods.twist);

const counts = {};
for (let i = 0; i < 600; i++) { D.game.mods = null; D.ensureRun(); counts[D.game.mods.twist] = (counts[D.game.mods.twist] || 0) + 1; }
console.log('     twist distribution over 600 rolls:', JSON.stringify(counts));

// twists that change slime speed / lives
D.game.mods = { twist: 'speedy' };
D.chooseMap('frost'); D.clear(); D.game.mods = { twist: 'speedy' };
D.startWave();
let sp = [];
for (let f = 0; f < 120; f++) {
  const b = D.enemies.map(e => [e, e.dist]); D.step(0.05);
  for (const [e, d0] of b) if (!e.dead && e.tier === 1 && !D.lanes[e.lane].ice.some(x => d0 >= x[0] && d0 <= x[1])) sp.push((e.dist - d0) / 0.05);
}
const avg = sp.reduce((a, b) => a + b, 0) / sp.length;
ok(Math.abs(avg - 70 * 1.15) < 1, 'Hasty Slimes: basic slime speed ' + avg.toFixed(1) + ' (expect 80.5)');
while (D.running) D.step(0.05);

// mechanics still intact
D.chooseMap('canyon'); D.clear();
let hidden = 0, lanes = new Set();
D.startWave();
for (let f = 0; f < 3000 && D.running; f++) { D.step(0.05); for (const e of D.enemies) { if (e.hidden) hidden++; lanes.add(e.lane); } }
ok(hidden > 0 && lanes.size === 2, 'Twin Canyon: two lanes and tunnels still work');
process.exit(0);
