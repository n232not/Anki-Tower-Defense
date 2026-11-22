// Scenario: Focus meter and study powers.
const ok = (cond, msg) => console.log((cond ? 'PASS ' : 'FAIL ') + msg);
// fixed randomness so the same slimes are on the map every run
function seeded(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
Math.random = seeded(7);
D.clear(); D.game.mods = null; D.game.wave = 12; D.game.lives = 1e6;
window.TD.reviewing();
ok(D.running, 'showing a question starts the wave');
for (let i = 0; i < 3; i++) window.TD.reviewing();
for (let f = 0; f < 200; f++) D.step(0.05);   // let slimes walk onto the map
const live = () => D.enemies.filter(e => !e.dead);
const n0 = live().length;
for (let i = 0; i < 14; i++) window.TD.cardAnswered();
ok(!live().some(e => e.slowUntil > 0 && e.slowFactor < 0.2), '14 cards: no power yet (questions shown do not count)');
window.TD.cardAnswered();
const frozen = live().filter(e => e.slowFactor <= 0.1 || (e.def.heavy && e.slowFactor < 1)).length;
ok(frozen === live().filter(e => !e.hidden).length && frozen > 0, '15th card: Frost Nova froze all ' + frozen + ' slimes');
let popsBefore = live().reduce((a, e) => a + D.leakOf(e.tier), 0);
for (let i = 0; i < 15; i++) window.TD.cardAnswered();
let popsAfter = live().reduce((a, e) => a + D.leakOf(e.tier), 0);
ok(popsAfter < popsBefore, '30th card: Meteor knocked layers off slimes (' + popsBefore + ' -> ' + popsAfter + ' total leak value)');
popsBefore = popsAfter;
for (let i = 0; i < 15; i++) window.TD.cardAnswered();
popsAfter = live().reduce((a, e) => a + D.leakOf(e.tier), 0);
ok(popsAfter < popsBefore, '45th card: Lightning Storm hit (' + popsBefore + ' -> ' + popsAfter + ')');
const s1 = spot(0, 300);
for (let i = 0; i < 15; i++) window.TD.cardAnswered();
ok(D.frenzyUntil > D.time + 9, '60th card: Frenzy active for the next ' + (D.frenzyUntil - D.time).toFixed(1) + 's');
while (D.running) D.step(0.05);
window.TD.cardAnswered();
ok(D.running, 'after the wave, the next card starts a new wave');
for (let i = 0; i < 14; i++) window.TD.cardAnswered();
ok(!live().some(e => e.slowFactor <= 0.1), 'meter reset: 14 cards into the new wave, no power yet');
process.exit(0);
