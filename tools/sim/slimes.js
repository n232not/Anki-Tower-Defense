// Scenario: special slimes, pressure, victory, trophies.
const ok = (cond, msg) => console.log((cond ? 'PASS ' : 'FAIL ') + msg);
D.clear(); D.game.mods = null; D.game.lives = 1e6;
D.startWave(); // just to have running state; we spawn by hand
const mk = (tier, d) => D.spawnEnemy(tier, d || 300, 0, 1, 0);
// Bulwark shield
const b = mk(14);
for (let i = 0; i < 3; i++) D.damage(b, 1, 'magic', null);
ok(b.shield === 0 && b.hp === b.maxHp, 'Bulwark: shield soaked 3 hits, no damage taken');
D.damage(b, 1, 'magic', null);
ok(b.hp < b.maxHp || b.tier !== 14, 'Bulwark: 4th hit gets through');
// Ghost phases
const g = mk(13); let phasedFrames = 0, total = 0;
for (let f = 0; f < 160; f++) { D.tick(0.05); if (!g.dead) { total++; if (g.phased) phasedFrames++; } }
ok(phasedFrames > total * 0.2 && phasedFrames < total * 0.6, 'Ghost: faded ' + Math.round(phasedFrames / total * 100) + '% of the time (untargetable then)');
// Dasher bursts
const dsh = mk(12, 100); const speeds = [];
for (let f = 0; f < 120; f++) { const d0 = dsh.dist; D.tick(0.05); if (!dsh.dead && dsh.kb === undefined) speeds.push((dsh.dist - d0) / 0.05); }
ok(Math.max(...speeds) > 2 * Math.min(...speeds.filter(v => v > 0)), 'Dasher: speed varies ' + Math.min(...speeds).toFixed(0) + ' -> ' + Math.max(...speeds).toFixed(0));
// Brood splits into 4
D.clear(); const br = mk(15);
D.damage(br, 1, 'magic', null); D.damage(br, 1, 'magic', null);
ok(D.enemies.filter(e => !e.dead && e.tier === 4).length === 4, 'Brood: popped into 4 Lime slimes');
// Mender shields neighbours
D.clear(); const m = mk(16, 400); const n1 = mk(3, 420), n2 = mk(3, 380), far = mk(3, 900);
D.tick(0.05);
ok(n1.shield === 1 && n2.shield === 1 && far.shield === 0, 'Mender: shielded the 2 nearby slimes, not the far one');
while (D.running) { D.game.lives = 1e6; D.tick(0.05); }
// waves include specials later on
D.game.diff = 'medium'; const mix = {};
for (let w = 1; w <= 16; w++) for (const q of D.buildWave(w)) if (q.tier >= 12) mix[w] = (mix[w] || 0) + 1;
console.log('     special slimes per wave (medium):', JSON.stringify(mix));
// pressure
D.clear(); D.game.pressure = 0; D.game.lives = 1e6; D.game.wave = 2; const s = spot(0, 300);
for (const t of ['cannon', 'tesla', 'arcanist']) {
  const sp = spot(0, 200 + Math.random() * 800) || spot(0, 300);
  if (sp) put(t, sp[0], sp[1]);
}
D.startWave(); while (D.running) D.tick(0.05);
ok(D.game.pressure > 0, 'clean wave raised pressure to ' + Math.round(D.game.pressure * 100) + '%');
// victory
D.clear(); D.game.diff = 'easy'; D.game.endless = false; D.game.wave = 12; D.game.lives = 1e6; const p0 = store.points;
D.startWave(); while (D.running) D.tick(0.05);
ok(store.points - p0 === 1 * 12 * 2, 'winning Easy at wave 12 pays double: +' + (store.points - p0));
ok(D.saved.trophies.meadow && D.saved.trophies.meadow.easy, 'trophy recorded: ' + JSON.stringify(D.saved.trophies));
ok(saved.trophies && saved.trophies.meadow.easy, 'trophy is in the save sent to Anki');
els['td-ov-btn'].onclick();
ok(D.game.endless, 'Keep going switches to endless');
D.startWave(); while (D.running) D.tick(0.05);
ok(D.game.wave === 14, 'endless continues past the victory wave');
process.exit(0);
