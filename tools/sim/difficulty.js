// Scenario: difficulty modes.
const ok = (cond, msg) => console.log((cond ? 'PASS ' : 'FAIL ') + msg);
D.clear(); D.game.mods = { twist: 'rush' };
ok(D.game.diff === 'medium', 'default difficulty is Medium');
const rows = [];
for (const k of ['easy', 'medium', 'hard', 'extreme']) {
  D.setDifficulty(k);
  let slimes = 0; for (let i = 0; i < 20; i++) slimes += D.buildWave(15).length;
  D.startWave(); for (let f = 0; f < 30; f++) D.step(0.05);
  const e = D.enemies.find(x => !x.dead && !(x.slowUntil > D.time));
  const d0 = e.dist; D.step(0.05); const sp = ((e.dist - d0) / 0.05 / e.def.speed);
  while (D.running) { D.game.lives = 1e9; D.step(0.05); }
  D.game.wave = 1; D.game.lives = 0;
  rows.push({ mode: k, lives: (D.setDifficulty(k), D.game.lives), avgSlimesWave15: (slimes / 20).toFixed(0), speedX: sp.toFixed(2) });
}
console.table(rows);
ok(rows[0].lives === 150 && rows[1].lives === 100 && rows[2].lives === 75 && rows[3].lives === 50, 'lives scale 150/100/75/50');
// loss pays by difficulty
for (const [k, per] of [['easy', 1], ['hard', 3], ['extreme', 4]]) {
  D.clear(); D.setDifficulty(k); D.game.wave = 11; const p0 = store.points;
  D.triggerGameOver();
  ok(store.points - p0 === per * 10, k + ': losing on wave 11 pays ' + per + ' x 10 = ' + (store.points - p0));
  els['td-ov-btn'].onclick();
  const want = Math.round({ easy: 150, hard: 75, extreme: 50 }[k] * (D.game.mods.twist === 'fragile' ? 0.6 : 1));
  ok(D.game.diff === k && D.game.lives === want, 'next run keeps ' + k + ' with ' + D.game.lives + ' lives (twist: ' + D.game.mods.twist + ')');
}
ok(saved.diff === 'extreme', 'the last choice is saved as the preference: ' + saved.diff);
// can't change mid-run
D.game.wave = 3; D.setDifficulty('easy');
ok(D.game.diff === 'extreme', 'difficulty is locked once the run is under way');
process.exit(0);
