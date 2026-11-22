// Scenario: reviewing starts waves, building is locked during a wave, wave length.
const ok = (cond, msg) => console.log((cond ? 'PASS ' : 'FAIL ') + msg);
D.clear();
const s1 = spot(0, 300), s2 = spot(0, 700);
const t = put('archer', s1[0], s1[1]);
ok(!!t, 'can build before the wave');
window.TD.cardAnswered();
ok(D.running, 'the first card starts a wave');
const n = D.towers.length, p0 = store.points;
ok(!put('archer', s2[0], s2[1]), 'cannot build during a wave');
D.select(t); D.upgradeSelected(0);
ok(t.a === 0 && store.points === p0, 'cannot upgrade during a wave');
els['td-sell'] = undefined;
window.TD.cardAnswered();
ok(D.towers.length === n, 'more cards during a wave do nothing extra');
let f = 0; while (D.running && f < 40000) { D.step(0.05); f++; }
ok(!D.running, 'wave 1 lasted ' + (f * 0.05).toFixed(0) + 's');
ok(!!put('archer', s2[0], s2[1]), 'can build again after the wave');
D.select(t); D.upgradeSelected(0);
ok(t.a === 1, 'can upgrade again after the wave');
window.TD.cardAnswered();
ok(D.running, 'next card starts the next wave');
while (D.running) D.step(0.05);

function seeded(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function waveSecs(n) { D.clear(); D.game.mods = null; Math.random = seeded(n); D.game.wave = n; D.game.lives = 1e9; D.startWave(); let k = 0; while (D.running && k < 60000) { D.step(0.05); k++; } return (k * 0.05).toFixed(0) + 's'; }
console.log('     wave 1:', waveSecs(1), ' wave 5:', waveSecs(5), ' wave 10:', waveSecs(10), ' wave 20:', waveSecs(20), ' wave 30:', waveSecs(30));
process.exit(0);
