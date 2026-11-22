// Scenario: speed button cycles 1 -> 2 -> 3 -> 20 -> 1, and 20x really runs 20 updates a frame.
const ok = (cond, msg) => console.log((cond ? 'PASS ' : 'FAIL ') + msg);
const seen = [];
for (let i = 0; i < 5; i++) { els['td-speed'].fire('click'); seen.push(els['td-speed-lbl'].textContent); }
ok(seen.join(' ') === '2× 3× 20× 1× 2×', 'speed cycles: ' + seen.join(' '));
process.exit(0);
