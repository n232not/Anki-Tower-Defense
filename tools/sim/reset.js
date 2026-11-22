// Scenario: the reset button asks first, then sends 'reset' to Anki.
const ok = (cond, msg) => console.log((cond ? 'PASS ' : 'FAIL ') + msg);
els['td-reset'].fire('click');
ok(els['td-ov-title'].textContent === 'Start from scratch?', 'reset link opens a confirmation first');
ok(!sent.includes('reset'), 'nothing is reset before confirming');
els['td-ov-btn'].onclick();
ok(els['td-overlay'].classList.contains('td-hidden') && !sent.includes('reset'), 'Cancel closes it without resetting');
els['td-reset'].fire('click');
els['td-reset-yes'].fire('click');
ok(sent.includes('reset'), 'confirming sends the reset to Anki');
process.exit(0);
