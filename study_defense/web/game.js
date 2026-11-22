(function () {
  'use strict';

  // ------------------------------------------------------------ boot / bridge
  const BOOT = window.TD_BOOT || null;
  const DEV = !BOOT; // standalone browser preview, no Anki
  const W = 960, H = 600;

  const DEFAULT_UNLOCKS = { archer: 0, frost: 15, boomer: 30, cannon: 45, trapper: 70, sniper: 100,
    pyro: 130, tesla: 160, gust: 200, arcanist: 240, bard: 300, titan: 400 };
  const unlocks = Object.assign({}, DEFAULT_UNLOCKS, (BOOT && BOOT.unlocks) || {});
  const START_LIVES = (BOOT && BOOT.startLives) || 100;
  // seconds between waves before the next one launches on its own (0 = manual only)
  const COUNTDOWN = BOOT && typeof BOOT.waveCountdown === 'number' ? BOOT.waveCountdown : 0;
  // Waves are long so you can just keep reviewing: each wave's slimes are spread over about
  // WAVE_SECONDS, and WAVE_SIZE scales how many slimes a wave has so it stays dense enough to matter.
  const WAVE_SECONDS = Math.max(20, Math.min(1200, (BOOT && BOOT.waveSeconds) || 300));
  const WAVE_SIZE = Math.max(0.2, Math.min(30, (BOOT && BOOT.waveSize) || 3));
  // Study powers: every FOCUS_CARDS cards answered during a wave fire a power automatically.
  const FOCUS_CARDS = Math.max(1, Math.round((BOOT && BOOT.focusCards) || 15));
  // A long wave covers several of the original short waves' worth of difficulty: wave n plays like
  // the original wave effWave(n) (slime count, which slime types, bosses).
  const WAVE_RAMP = Math.max(0.5, Math.min(10, (BOOT && BOOT.waveRamp) || 2));
  function effWave(n) { return 1 + (n - 1) * WAVE_RAMP * diffOf().ramp; }
  // Wave shape (tuned with tools/sim/bot.js; overridable from the boot data for tuning runs):
  // slime budget = (A + B*e + C*e^2). Bosses ramp up in steps: Brutes from BRUTE_AT, Behemoths from
  // BOSS_AT, Colossi 20 later; each kind starts at half health and grows every wave.
  const CURVE = Object.assign({ a: 70, b: 18, c: 0.05, bruteAt: 10, bossAt: 30 }, (BOOT && BOOT.curve) || {});
  function bossCount(n) {
    const e = effWave(n);
    let b = e >= CURVE.bossAt ? 1 + Math.floor((e - CURVE.bossAt) / 15) : 0;
    let brute = e >= CURVE.bruteAt ? 1 + Math.floor((e - CURVE.bruteAt) / 8) : 0;
    if (b) brute = Math.max(1, brute - 2 * b); // Behemoths take over from Brutes
    if (!brute && hasMod('giants') && e >= 8) brute = 1;
    if (!b && hasMod('giants') && e >= CURVE.bossAt - 10) b = 1;
    return { brute: brute, behemoth: b, colossus: e >= CURVE.bossAt + 20 ? Math.floor((e - CURVE.bossAt - 10) / 20) : 0 };
  }
  function bossHp(n, tier) {
    const start = tier === 17 ? CURVE.bruteAt : tier === 11 ? CURVE.bossAt + 20 : CURVE.bossAt;
    return Math.max(0.5, Math.min(2, 0.5 + (effWave(n) - start) / 20));
  }
  const SELL_RATE = 0.7;

  function devLoad() {
    try {
      const s = JSON.parse(localStorage.getItem('td_dev') || 'null');
      if (s) return s;
    } catch (e) { /* ignore */ }
    return { points: 60, totalCards: 0, game: null };
  }
  function devSave(s) { localStorage.setItem('td_dev', JSON.stringify(s)); }

  function bridge(cmd, cb) {
    if (!DEV && typeof pycmd === 'function') { pycmd(cmd, cb); return; }
    if (cmd === 'reset') { localStorage.removeItem('td_dev'); location.reload(); return; }
    const s = devLoad();
    let res = null;
    if (cmd.indexOf('commit:') === 0) {
      const p = JSON.parse(cmd.slice(7));
      if (s.points + p.delta < 0) {
        res = { ok: false, points: s.points, totalCards: s.totalCards };
      } else {
        s.points += p.delta;
        if (p.game) s.game = p.game;
        devSave(s);
        res = { ok: true, points: s.points, totalCards: s.totalCards };
      }
    }
    setTimeout(function () { cb && cb(res); }, 0);
  }

  const boot = BOOT || devLoad();
  let points = boot.points | 0;
  let totalCards = boot.totalCards | 0;

  // ------------------------------------------------------------ maps
  // Each map has one or more lanes and a rule that changes how it plays.
  const MAPS = {
    meadow: {
      name: 'Sunny Meadow', unlock: 0, theme: 'meadow',
      rule: 'The classic: one winding path, no tricks.',
      lanes: [[[-30, 90], [220, 90], [220, 480], [420, 480], [420, 140], [620, 140], [620, 480], [820, 480], [820, 280], [990, 280]]],
      pond: { x: 905, y: 505, rx: 42, ry: 58 },
    },
    frost: {
      name: 'Frozen Lake', unlock: 40, theme: 'frost',
      rule: 'Icy stretches make slimes slide 50% faster. Frost towers get +30% range.',
      lanes: [[[-30, 300], [160, 300], [160, 110], [400, 110], [400, 490], [600, 490], [600, 200], [800, 200], [800, 420], [990, 420]]],
      ice: [[0, 3], [0, 5], [0, 7]], // [lane, segment]
      pond: { x: 280, y: 330, rx: 50, ry: 76, frozen: true },
    },
    canyon: {
      name: 'Twin Canyon', unlock: 100, theme: 'canyon',
      rule: 'Two lanes at once. Slimes inside rock tunnels cannot be targeted or hit.',
      lanes: [
        [[-30, 110], [250, 110], [250, 250], [520, 250], [520, 90], [760, 90], [760, 230], [990, 230]],
        [[-30, 500], [200, 500], [200, 370], [460, 370], [460, 520], [700, 520], [700, 370], [990, 370]],
      ],
      tunnels: [[0, 2, 0.22, 0.78], [1, 4, 0.25, 0.75]], // [lane, segment, from, to]
    },
    misty: {
      name: 'Misty Hollow', unlock: 200, theme: 'misty',
      rule: 'Thick fog cuts tower range by 35%. Towers in lantern light get +20% instead. Snipers only see lit slimes.',
      lanes: [[[-30, 520], [140, 520], [140, 90], [330, 90], [330, 330], [520, 330], [520, 90], [700, 90], [700, 510], [860, 510], [860, 250], [990, 250]]],
      lanterns: [[240, 210], [430, 200], [425, 460], [610, 220], [780, 360], [600, 565], [930, 400]],
    },
  };
  const MAP_ORDER = ['meadow', 'frost', 'canyon', 'misty'];
  const LANTERN_R = 115;
  const PATH_HALF = 22;

  function buildLanes(m) {
    return m.lanes.map(function (pts, li) {
      const segs = [];
      let len = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const x1 = pts[i][0], y1 = pts[i][1], x2 = pts[i + 1][0], y2 = pts[i + 1][1];
        const l = Math.hypot(x2 - x1, y2 - y1);
        segs.push({ x1: x1, y1: y1, x2: x2, y2: y2, len: l, start: len });
        len += l;
      }
      function span(si, a, b) { const sg = segs[si]; return [sg.start + sg.len * a, sg.start + sg.len * b]; }
      return {
        pts: pts, segs: segs, len: len,
        ice: (m.ice || []).filter(function (x) { return x[0] === li; }).map(function (x) { return span(x[1], 0, 1); }),
        tunnels: (m.tunnels || []).filter(function (x) { return x[0] === li; }).map(function (x) { return span(x[1], x[2], x[3]); }),
      };
    });
  }
  function inSpans(spans, d) {
    for (const sp of spans) if (d >= sp[0] && d <= sp[1]) return true;
    return false;
  }

  const saved = normalizeSave(boot.game);
  function mapUnlocked(id) { return totalCards >= (MAPS[id].unlock || 0); }
  let mapId = MAPS[saved.map] && mapUnlocked(saved.map) ? saved.map : 'meadow';
  let MAP = MAPS[mapId];
  let LANES = buildLanes(MAP);

  function posAt(d, lane) {
    const L = LANES[lane || 0];
    if (d <= 0) return { x: L.pts[0][0], y: L.pts[0][1] };
    for (const sg of L.segs) {
      if (d <= sg.start + sg.len) {
        const t = (d - sg.start) / sg.len;
        return { x: sg.x1 + (sg.x2 - sg.x1) * t, y: sg.y1 + (sg.y2 - sg.y1) * t };
      }
    }
    const E = L.pts[L.pts.length - 1];
    return { x: E[0], y: E[1] };
  }
  function distToSeg(px, py, sg) {
    const dx = sg.x2 - sg.x1, dy = sg.y2 - sg.y1;
    let t = ((px - sg.x1) * dx + (py - sg.y1) * dy) / (sg.len * sg.len);
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (sg.x1 + dx * t), py - (sg.y1 + dy * t));
  }
  function distToPath(x, y) {
    let m = 1e9;
    for (const L of LANES) for (const sg of L.segs) m = Math.min(m, distToSeg(x, y, sg));
    return m;
  }
  function nearLantern(x, y) {
    return !!(MAP.lanterns && MAP.lanterns.some(function (l) { return Math.hypot(l[0] - x, l[1] - y) <= LANTERN_R; }));
  }
  // range multiplier a tower gets from the map it stands on
  function mapRangeMult(type, x, y) {
    let m = 1;
    if (mapId === 'frost' && type === 'frost') m *= 1.3;
    if (MAP.lanterns) m *= nearLantern(x, y) ? 1.2 : 0.65;
    return m;
  }

  // ------------------------------------------------------------ enemies
  // Layered slimes: popping the outer layer reveals what's inside.
  const ENEMIES = {
    1: { name: 'Teal', hp: 1, speed: 70, color: '#4cc9a0', r: 10 },
    2: { name: 'Violet', hp: 1, speed: 88, color: '#7c6cf2', r: 11, children: [1, 1] },
    3: { name: 'Amber', hp: 1, speed: 108, color: '#f29b38', r: 11.5, children: [2, 1] },
    4: { name: 'Lime', hp: 1, speed: 130, color: '#b5e04a', r: 12, children: [3, 2] },
    5: { name: 'Crimson', hp: 1, speed: 155, color: '#ef476f', r: 12.5, children: [4, 3] },
    6: { name: 'Gold', hp: 1, speed: 140, color: '#ffd23f', r: 13, children: [5, 4] },
    7: { name: 'Iron', hp: 1, speed: 80, color: '#8d939e', r: 13.5, children: [6, 5], metal: true },
    8: { name: 'Prism', hp: 1, speed: 175, color: 'prism', r: 13.5, children: [7, 6] },
    9: { name: 'Stoneshell', hp: 10, speed: 95, color: '#a08a6a', r: 15.5, children: [8, 7] },
    10: { name: 'Behemoth', hp: 160, speed: 34, color: '#3d5a80', r: 30, children: [9, 8], heavy: true },
    11: { name: 'Colossus', hp: 500, speed: 24, color: '#7a2e3a', r: 40, children: [10, 9], heavy: true },
    // special slimes: each has a trick (see update/damage)
    12: { name: 'Dasher', hp: 1, speed: 95, color: '#ff9f1c', r: 12, children: [4, 4], dasher: true },
    13: { name: 'Ghost', hp: 1, speed: 85, color: '#c9d6ff', r: 12, children: [5, 5], ghost: true },
    14: { name: 'Bulwark', hp: 2, speed: 60, color: '#6b7f99', r: 14.5, children: [6, 6], shield: 3 },
    15: { name: 'Brood', hp: 2, speed: 65, color: '#9acd32', r: 15, children: [4, 4, 4, 4] },
    16: { name: 'Mender', hp: 3, speed: 70, color: '#ff7eb6', r: 13.5, children: [6, 6], healer: true },
    // mini-boss: arrives well before the Behemoth so bosses ramp up gradually
    17: { name: 'Brute', hp: 40, speed: 45, color: '#7a8f3c', r: 21, children: [7, 6], heavy: true },
  };
  // effective wave each special slime starts showing up in (see effWave)
  const SPECIAL_WAVE = { 12: 7, 13: 10, 14: 14, 15: 16, 16: 20 };
  // first wave each tier can appear in normal groups
  const TIER_WAVE = { 1: 1, 2: 3, 3: 5, 4: 8, 5: 11, 6: 14, 7: 12, 8: 18, 9: 22 };
  const LEAK = {};
  // Lives lost when a slime gets through. Grows slower than its layer count, so a leaked boss is a
  // disaster you can survive rather than an instant loss (Behemoth: 43 instead of 533).
  function leakDamage(t) { return Math.max(1, Math.round(Math.pow(leakOf(t), 0.5))); }
  function leakOf(t) {
    if (LEAK[t]) return LEAK[t];
    const d = ENEMIES[t];
    let v = 1;
    (d.children || []).forEach(function (c) { v += leakOf(c); });
    LEAK[t] = v;
    return v;
  }

  // ------------------------------------------------------------ towers
  // dtype: sharp (blocked by Iron), cold (blocked by Iron), explosive, magic, energy, pierce
  const TOWERS = {
    archer: {
      name: 'Archer', color: '#c98b3a', cost: 10, kind: 'proj', dtype: 'sharp',
      desc: 'Quick darts. Sharp: no effect on Iron',
      base: { dmg: 1, range: 125, rate: 1.2, pierce: 1, speed: 560, shots: 1 },
      paths: [
        [
          { name: 'Keen Edge', cost: 8, desc: '+1 pierce', fx: function (s) { s.pierce += 1; } },
          { name: 'Serrated Darts', cost: 20, desc: '+2 pierce, +1 damage', fx: function (s) { s.pierce += 2; s.dmg += 1; } },
          { name: 'Fan of Darts', cost: 45, desc: 'Throws 3 darts at once', fx: function (s) { s.shots = 3; } },
        ],
        [
          { name: 'Quick Draw', cost: 8, desc: '+40% attack speed', fx: function (s) { s.rate *= 1.4; } },
          { name: 'Long Sight', cost: 15, desc: '+40 range', fx: function (s) { s.range += 40; } },
          { name: 'Hail of Arrows', cost: 55, desc: 'Double attack speed', fx: function (s) { s.rate *= 2; } },
        ],
      ],
    },
    frost: {
      name: 'Frost', color: '#8fd3ff', cost: 18, kind: 'aura', dtype: 'cold',
      desc: 'Slows everything nearby',
      base: { dmg: 0, range: 85, rate: 1.0, slow: 0.45, dur: 1.2 },
      paths: [
        [
          { name: 'Deep Chill', cost: 12, desc: 'Stronger, longer slow', fx: function (s) { s.slow = 0.3; s.dur += 0.5; } },
          { name: 'Shatter', cost: 25, desc: 'Pulses deal 1 damage', fx: function (s) { s.dmg = Math.max(s.dmg, 1); } },
          { name: 'Blizzard', cost: 60, desc: '+40 range, near-freeze', fx: function (s) { s.range += 40; s.slow = 0.2; } },
        ],
        [
          { name: 'Wide Chill', cost: 10, desc: '+20 range', fx: function (s) { s.range += 20; } },
          { name: 'Frostbite', cost: 25, desc: '1 damage, freezes through Iron', fx: function (s) { s.dmg = Math.max(s.dmg, 1); s.metal = true; } },
          { name: 'Deep Winter', cost: 75, desc: 'Longer slow, +60% pulse rate', fx: function (s) { s.dur += 1.5; s.rate *= 1.6; } },
        ],
      ],
    },
    cannon: {
      name: 'Cannon', color: '#7d8590', cost: 25, kind: 'splash', dtype: 'explosive',
      desc: 'Splash damage, cracks Iron',
      base: { dmg: 1, range: 120, rate: 0.6, splash: 48, speed: 360, cluster: 0, heavyMult: 1 },
      paths: [
        [
          { name: 'Wide Blast', cost: 18, desc: '+20 blast radius', fx: function (s) { s.splash += 20; } },
          { name: 'Heavy Shells', cost: 30, desc: '+1 damage', fx: function (s) { s.dmg += 1; } },
          { name: 'Cluster Charge', cost: 70, desc: 'Each blast scatters 4 bomblets', fx: function (s) { s.cluster = 4; } },
        ],
        [
          { name: 'Quick Loader', cost: 15, desc: '+35% attack speed', fx: function (s) { s.rate *= 1.35; } },
          { name: 'Long Barrel', cost: 20, desc: '+30 range', fx: function (s) { s.range += 30; } },
          { name: 'Giant Buster', cost: 80, desc: '+1 damage, x4 vs Behemoth/Colossus', fx: function (s) { s.dmg += 1; s.heavyMult = 4; } },
        ],
      ],
    },
    trapper: {
      name: 'Trapper', color: '#9c6b3f', cost: 28, kind: 'spikes', dtype: 'sharp',
      desc: 'Lays spike piles on the track',
      base: { dmg: 1, range: 110, rate: 0.4, hits: 4, life: 20, maxPiles: 6, mine: false },
      paths: [
        [
          { name: 'Sharper Spikes', cost: 15, desc: '+4 pops per pile', fx: function (s) { s.hits += 4; } },
          { name: 'Barbed Spikes', cost: 35, desc: '+1 damage, +2 pops', fx: function (s) { s.dmg += 1; s.hits += 2; } },
          { name: 'Spike Mines', cost: 70, desc: 'Spent piles explode', fx: function (s) { s.mine = true; } },
        ],
        [
          { name: 'Rapid Forging', cost: 15, desc: '+50% production', fx: function (s) { s.rate *= 1.5; } },
          { name: 'Lasting Spikes', cost: 15, desc: 'Piles last twice as long', fx: function (s) { s.life *= 2; s.maxPiles += 6; } },
          { name: 'Hardened Spikes', cost: 70, desc: 'Pierces Iron, +3 pops', fx: function (s) { s.metal = true; s.hits += 3; } },
        ],
      ],
    },
    sniper: {
      name: 'Sniper', color: '#4f7a3a', cost: 35, kind: 'hitscan', dtype: 'pierce',
      desc: 'Hits anywhere, any type',
      base: { dmg: 3, range: 2000, rate: 0.5, bounce: 0, heavyMult: 1 },
      paths: [
        [
          { name: 'Piercing Rounds', cost: 25, desc: '+2 damage, +25% attack speed', fx: function (s) { s.dmg += 2; s.rate *= 1.25; } },
          { name: 'Deadeye', cost: 50, desc: '+4 damage, shots hit 2 more slimes', fx: function (s) { s.dmg += 4; s.bounce = Math.max(s.bounce, 2); } },
          { name: 'Giant Slayer', cost: 100, desc: '+4 damage, x3 vs Behemoth/Colossus', fx: function (s) { s.dmg += 4; s.heavyMult = 3; } },
        ],
        [
          { name: 'Bolt Action', cost: 25, desc: '+40% attack speed', fx: function (s) { s.rate *= 1.4; } },
          { name: 'Rapid Bolt', cost: 60, desc: 'Double attack speed', fx: function (s) { s.rate *= 2; } },
          { name: 'Ricochet', cost: 90, desc: 'Shots bounce to 3 more targets', fx: function (s) { s.bounce = 3; } },
        ],
      ],
    },
    tesla: {
      name: 'Tesla', color: '#5aa9e6', cost: 45, kind: 'chain', dtype: 'energy',
      desc: 'Lightning chains between foes',
      base: { dmg: 1, range: 115, rate: 0.9, chains: 4 },
      paths: [
        [
          { name: 'Conductor', cost: 25, desc: '+3 chain targets', fx: function (s) { s.chains += 3; } },
          { name: 'Overcharge', cost: 45, desc: '+1 damage', fx: function (s) { s.dmg += 1; } },
          { name: 'Superconductor', cost: 100, desc: '+6 chains, +1 damage', fx: function (s) { s.chains += 6; s.dmg += 1; } },
        ],
        [
          { name: 'Capacitor', cost: 25, desc: '+40% attack speed', fx: function (s) { s.rate *= 1.4; } },
          { name: 'Static Field', cost: 40, desc: '+30 range', fx: function (s) { s.range += 30; } },
          { name: 'Thunderstorm', cost: 110, desc: 'Double attack speed', fx: function (s) { s.rate *= 2; } },
        ],
      ],
    },
    arcanist: {
      name: 'Arcanist', color: '#9b5de5', cost: 50, kind: 'proj', dtype: 'magic',
      desc: 'Piercing magic bolts, any type',
      base: { dmg: 1, range: 135, rate: 1.0, pierce: 3, speed: 430, shots: 1, splash: 0 },
      paths: [
        [
          { name: 'Arcane Focus', cost: 20, desc: '+3 pierce, +20 range', fx: function (s) { s.pierce += 3; s.range += 20; } },
          { name: 'Flame Burst', cost: 45, desc: 'Bolts explode on impact', fx: function (s) { s.splash = 35; } },
          { name: 'Inferno', cost: 110, desc: '2.5x attack speed, +1 damage', fx: function (s) { s.rate *= 2.5; s.dmg += 1; } },
        ],
        [
          { name: 'Swift Casting', cost: 20, desc: '+50% attack speed', fx: function (s) { s.rate *= 1.5; } },
          { name: 'Empowered Bolts', cost: 40, desc: '+1 damage, +2 pierce', fx: function (s) { s.dmg += 1; s.pierce += 2; } },
          { name: 'Phantom Orbs', cost: 90, desc: 'Casts 3 bolts at once', fx: function (s) { s.shots = 3; } },
        ],
      ],
    },
    boomer: {
      name: 'Boomerang', color: '#d9a05b', cost: 30, kind: 'boomerang', dtype: 'sharp',
      desc: 'Curving throw that hits on the way out AND back',
      base: { dmg: 1, range: 140, rate: 0.75, pierce: 6, shots: 1 },
      paths: [
        [
          { name: 'Sharpened Rim', cost: 15, desc: '+4 pierce', fx: function (s) { s.pierce += 4; } },
          { name: 'Ironwood', cost: 30, desc: '+1 damage', fx: function (s) { s.dmg += 1; } },
          { name: 'Glaive Lord', cost: 80, desc: 'Cuts Iron, +1 damage, +6 pierce', fx: function (s) { s.metal = true; s.dmg += 1; s.pierce += 6; } },
        ],
        [
          { name: 'Quick Hands', cost: 15, desc: '+50% attack speed', fx: function (s) { s.rate *= 1.5; } },
          { name: 'Long Throw', cost: 20, desc: '+35 range, +2 pierce', fx: function (s) { s.range += 35; s.pierce += 2; } },
          { name: 'Twin Rangs', cost: 55, desc: '2 boomerangs at once, +4 pierce', fx: function (s) { s.shots = 2; s.pierce += 4; } },
        ],
      ],
    },
    pyro: {
      name: 'Pyro', color: '#e8623a', cost: 45, kind: 'flame', dtype: 'fire',
      desc: 'Flame cone sets slimes on fire. Melts Iron',
      base: { dmg: 1, range: 78, rate: 1.0, cone: 0.42, burn: 1, burnDur: 2 },
      paths: [
        [
          { name: 'Hotter Fuel', cost: 20, desc: '+1 burn damage', fx: function (s) { s.burn += 1; } },
          { name: 'Sticky Gel', cost: 35, desc: 'Burns last twice as long', fx: function (s) { s.burnDur *= 2; } },
          { name: "Dragon's Breath", cost: 90, desc: '+1 burn damage, much wider cone', fx: function (s) { s.burn += 1; s.cone = 0.85; } },
        ],
        [
          { name: 'Pressure Valve', cost: 20, desc: '+25 range', fx: function (s) { s.range += 25; } },
          { name: 'Rapid Ignition', cost: 40, desc: '+50% attack speed', fx: function (s) { s.rate *= 1.5; } },
          { name: 'Firestorm', cost: 100, desc: 'Double attack speed, +1 damage', fx: function (s) { s.rate *= 2; s.dmg += 1; } },
        ],
      ],
    },
    gust: {
      name: 'Gale', color: '#bde6f2', cost: 35, kind: 'push', dtype: 'wind',
      desc: 'Blows slimes back down the path',
      base: { dmg: 0, range: 100, rate: 0.55, push: 220, heavyPush: 0.25, slow: 0, dur: 0, decay: 0.5 },
      paths: [
        [
          { name: 'Stronger Gusts', cost: 20, desc: '+90 push distance', fx: function (s) { s.push += 90; } },
          { name: 'Sharp Winds', cost: 40, desc: 'Gusts deal 1 damage', fx: function (s) { s.dmg = Math.max(s.dmg, 1); } },
          { name: 'Hurricane', cost: 100, desc: '+160 push, shoves giants hard', fx: function (s) { s.push += 160; s.heavyPush = 0.7; } },
        ],
        [
          { name: 'Wide Fan', cost: 20, desc: '+25 range', fx: function (s) { s.range += 25; } },
          { name: 'Quick Flaps', cost: 35, desc: '+60% gust rate, repeat shoves stay strong', fx: function (s) { s.rate *= 1.6; s.decay = 0.7; } },
          { name: 'Chill Wind', cost: 80, desc: 'Gusts also slow 50% for 3s, even Iron', fx: function (s) { s.slow = 0.5; s.dur = 3; s.metal = true; } },
        ],
      ],
    },
    bard: {
      name: 'Bard', color: '#9bd14a', cost: 40, kind: 'buff', dtype: 'none',
      desc: 'Nearby towers attack 35% faster',
      base: { dmg: 0, range: 120, rate: 1, buff: 1.35, buffDmg: 0, buffRange: 0, buffMetal: false },
      paths: [
        [
          { name: 'Encore', cost: 25, desc: 'Buff: +20% more attack speed', fx: function (s) { s.buff += 0.2; } },
          { name: 'Power Chord', cost: 50, desc: 'Buffed towers deal +1 damage', fx: function (s) { s.buffDmg = 1; } },
          { name: 'Anthem of Steel', cost: 120, desc: 'Buffed towers can hit Iron', fx: function (s) { s.buffMetal = true; } },
        ],
        [
          { name: 'Loud Lute', cost: 20, desc: '+35 aura range', fx: function (s) { s.range += 35; } },
          { name: 'Echo', cost: 45, desc: 'Buffed towers get +20% range', fx: function (s) { s.buffRange = 0.2; } },
          { name: 'Grand Concert', cost: 100, desc: '+40 aura range, +35% more speed', fx: function (s) { s.range += 40; s.buff += 0.35; } },
        ],
      ],
    },
    titan: {
      name: 'Titan', color: '#f4c430', cost: 120, kind: 'proj', dtype: 'energy',
      desc: 'Relentless energy barrage',
      base: { dmg: 1, range: 150, rate: 12, pierce: 1, speed: 900, shots: 1, splash: 0 },
      paths: [
        [
          { name: 'Ion Bolts', cost: 80, desc: '+1 damage, +2 pierce', fx: function (s) { s.dmg += 1; s.pierce += 2; } },
          { name: 'Solar Lance', cost: 220, desc: '+2 damage, +3 pierce, small blast', fx: function (s) { s.dmg += 2; s.pierce += 3; s.splash = 25; } },
          { name: 'Celestial Fury', cost: 450, desc: '+4 damage, +50% speed', fx: function (s) { s.dmg += 4; s.rate *= 1.5; } },
        ],
        [
          { name: 'Far Sight', cost: 50, desc: '+70 range', fx: function (s) { s.range += 70; } },
          { name: 'Twin Emitters', cost: 160, desc: 'Fires 2 bolts at once', fx: function (s) { s.shots = 2; } },
          { name: 'Overdrive', cost: 350, desc: 'Double attack speed', fx: function (s) { s.rate *= 2; } },
        ],
      ],
    },
  };
  const ORDER = ['archer', 'frost', 'boomer', 'cannon', 'trapper', 'sniper', 'pyro', 'tesla', 'gust', 'arcanist', 'bard', 'titan'];
  // towers that never turn to aim
  const STILL = { aura: 1, spikes: 1, push: 1, buff: 1 };

  // ------------------------------------------------------------ difficulty
  // Chosen when a run starts. Harder modes pay more coins per wave cleared when the run ends.
  const DIFFS = {
    // ramp: how fast tougher slimes and bosses arrive
    // Tuned with tools/sim/bot.js (6 seeds each): a weak bot wins only Easy; a strong bot (uses study
    // powers, builds well) wins Medium ~5/6, Hard ~4/6 and Extra Hard ~2/6 with few lives left.
    // ramp: how fast tougher slimes and bosses arrive. win: clearing this wave wins the run.
    easy: { name: 'Easy', lives: 1.5, budget: 1.15, speed: 0.9, ramp: 1.1, coins: 1, win: 12 },
    medium: { name: 'Medium', lives: 1, budget: 1.15, speed: 1, ramp: 1.1, coins: 2, win: 15 },
    hard: { name: 'Hard', lives: 0.75, budget: 1.25, speed: 1.1, ramp: 1.2, coins: 3, win: 15 },
    extreme: { name: 'Extra Hard', lives: 0.5, budget: 1.2, speed: 1.2, ramp: 1.15, coins: 4, win: 15 },
  };
  const DIFF_ORDER = ['easy', 'medium', 'hard', 'extreme'];
  // tuning runs can override difficulty numbers from the boot data
  if (BOOT && BOOT.diffs) Object.keys(BOOT.diffs).forEach(function (k) { if (DIFFS[k]) Object.assign(DIFFS[k], BOOT.diffs[k]); });
  function diffOf() { return DIFFS[(game && game.diff) || 'medium'] || DIFFS.medium; }

  // ------------------------------------------------------------ run modifiers
  // Every run rolls one random Twist, so no two runs play the same.
  const TWISTS = {
    speedy: { name: 'Hasty Slimes', desc: 'Slimes move 15% faster' },
    armored: { name: 'Iron Tide', desc: 'Iron slimes appear from wave 6 instead of 14' },
    giants: { name: 'Giant Season', desc: 'A Behemoth joins every 10th wave from wave 10' },
    shortage: { name: 'Supply Shortage', desc: 'One tower type is banned this run' },
    fragile: { name: 'Thin Walls', desc: 'Start with 40% fewer lives' },
    rush: { name: 'Stampede', desc: 'Slimes come 25% closer together' },
  };
  function hasMod(id) { const m = game && game.mods; return !!m && m.twist === id; }
  function isBanned(type) { return !!(game && game.mods && game.mods.banned === type); }
  function tierWave(t) { return t === 7 && hasMod('armored') ? 6 : TIER_WAVE[t]; }

  function rollMods() {
    const open = ORDER.filter(isUnlocked);
    const pool = Object.keys(TWISTS).filter(function (k) { return k !== 'shortage' || open.length >= 3; });
    const twist = pool[Math.floor(Math.random() * pool.length)];
    let banned = null;
    if (twist === 'shortage') {
      const towersPool = open.filter(function (t) { return t !== 'archer'; });
      banned = towersPool[Math.floor(Math.random() * towersPool.length)];
    }
    return { twist: twist, banned: banned };
  }

  const TARGET_MODES = ['first', 'last', 'strong', 'close'];
  const PATH_KEYS = ['Q', 'W'];

  function isUnlocked(type) { return totalCards >= (unlocks[type] || 0); }

  function computeStats(t) {
    const def = TOWERS[t.type];
    const s = Object.assign({}, def.base);
    for (let i = 0; i < t.a; i++) def.paths[0][i].fx(s);
    for (let i = 0; i < t.b; i++) def.paths[1][i].fx(s);
    s.dtype = def.dtype;
    s.kind = def.kind;
    return s;
  }
  // One path may reach tier 3; the other is then capped at tier 1.
  function canUpgrade(t, path) {
    const cur = path === 0 ? t.a : t.b;
    const other = path === 0 ? t.b : t.a;
    if (cur >= 3) return false;
    return cur + 1 <= 1 || other <= 1;
  }
  function refreshTower(t) {
    const s = computeStats(t);
    if (s.range < 1000) s.range = Math.round(s.range * mapRangeMult(t.type, t.x, t.y));
    applyBuffs(t, s);
    t.s = s;
    if (s.range < 1000) {
      t.trackPts = [];
      LANES.forEach(function (L, li) {
        for (let d = 0; d < L.len; d += 6) {
          if (inSpans(L.tunnels, d)) continue;
          const p = posAt(d, li);
          if (p.x > 0 && p.x < W && Math.hypot(p.x - t.x, p.y - t.y) <= s.range) t.trackPts.push(p);
        }
      });
    }
  }
  // Bards: the best value of each bonus from any bard in range applies (they don't stack).
  function applyBuffs(t, s) {
    t.buffedBy = null;
    if (s.kind === 'buff') return;
    let rate = 1, dmg = 0, range = 0, metal = false;
    for (const b of towers) {
      if (b === t || b.type !== 'bard' || !b.s) continue;
      if (Math.hypot(b.x - t.x, b.y - t.y) > b.s.range) continue;
      t.buffedBy = b.id;
      rate = Math.max(rate, b.s.buff);
      dmg = Math.max(dmg, b.s.buffDmg);
      range = Math.max(range, b.s.buffRange);
      metal = metal || b.s.buffMetal;
    }
    if (!t.buffedBy) return;
    s.rate *= rate;
    if (s.dmg > 0) s.dmg += dmg;
    if (s.range < 1000) s.range = Math.round(s.range * (1 + range));
    if (metal) s.metal = true;
    s.buffed = true;
  }
  function refreshAll() {
    towers.filter(function (t) { return t.type === 'bard'; }).forEach(refreshTower);
    towers.filter(function (t) { return t.type !== 'bard'; }).forEach(refreshTower);
  }
  function makeTower(o) {
    const t = { id: o.id, type: o.type, x: o.x, y: o.y,
      a: o.a != null ? o.a : Math.min(3, o.level || 0), b: o.b || 0,
      target: o.target || 'first', spent: o.spent || TOWERS[o.type].cost, cd: 0, angle: 0 };
    refreshTower(t);
    return t;
  }

  // ------------------------------------------------------------ game state
  // The save holds one record per map: { map, maps: { id: { wave, lives, bestWave, towers } } }
  let game = normalizeGame(saved.maps[mapId]);
  let towers = [];
  towers = game.towers.filter(function (t) { return TOWERS[t.type]; }).map(makeTower);
  refreshAll();
  let nextTowerId = towers.reduce(function (m, t) { return Math.max(m, t.id); }, 0) + 1;

  function normalizeSave(g) {
    // no saved preference yet: brand-new players (few towers unlocked) start on Easy
    const diff = g && typeof g === 'object' && typeof g.diff === 'string' ? g.diff : (totalCards < 200 ? 'easy' : 'medium');
    const trophies = g && typeof g === 'object' && g.trophies && typeof g.trophies === 'object' ? g.trophies : {};
    if (g && typeof g === 'object' && g.maps && typeof g.maps === 'object') return { map: g.map, maps: g.maps, diff: diff, trophies: trophies };
    if (g && typeof g === 'object' && (g.towers || g.wave)) return { map: 'meadow', maps: { meadow: g }, diff: diff, trophies: trophies }; // old single-map save
    // fresh session: only the difficulty preference and trophies survive
    return { map: 'meadow', maps: {}, diff: diff, trophies: trophies };
  }

  function normalizeGame(g) {
    g = g && typeof g === 'object' ? g : {};
    return {
      wave: Math.max(1, g.wave | 0),
      lives: g.lives > 0 ? g.lives : START_LIVES,
      bestWave: g.bestWave | 0,
      towers: Array.isArray(g.towers) ? g.towers : [],
      mods: g.mods && TWISTS[g.mods.twist] ? g.mods : null,
      diff: DIFFS[g.diff] ? g.diff : (DIFFS[saved && saved.diff] ? saved.diff : 'medium'),
      pressure: typeof g.pressure === 'number' ? Math.max(-0.1, Math.min(0.2, g.pressure)) : 0,
      endless: !!g.endless,
    };
  }
  function serial(t) {
    return { id: t.id, type: t.type, x: Math.round(t.x), y: Math.round(t.y),
      a: t.a, b: t.b, target: t.target, spent: t.spent };
  }
  function snapshot(extra, dropId, over) {
    let list = towers.filter(function (t) { return t.id !== dropId; }).map(serial);
    if (extra) list = list.concat(extra.map(serial));
    const rec = Object.assign({ wave: game.wave, lives: game.lives, bestWave: game.bestWave, towers: list, mods: game.mods, diff: game.diff,
      pressure: game.pressure, endless: game.endless }, over || {});
    const maps = Object.assign({}, saved.maps);
    maps[mapId] = rec;
    return { map: mapId, maps: maps, diff: saved.diff, trophies: saved.trophies };
  }

  let enemies = [];
  let projectiles = [];
  let piles = [];
  let effects = [];
  let spawnQueue = [];
  let spawnTimer = 0;
  let running = false;
  let paused = false;
  let gameOver = false;
  let time = 0;
  let speed = 1;
  let nextEnemyId = 1;
  let nextWaveAt = null; // wall-clock ms when the next wave auto-starts
  let leakedThisWave = false;
  let livesAtWaveStart = 0;
  let focus = 0, powersFired = 0, frenzyUntil = 0; // study powers, reset every wave
  let runSpeed = 1;
  let busy = false; // waiting on a bridge commit

  let placing = null;
  let selected = null;
  const mouse = { x: -100, y: -100, inside: false };

  // ------------------------------------------------------------ waves
  function rand(a, b) { return a + Math.random() * (b - a); }
  function randInt(a, b) { return Math.floor(rand(a, b + 1)); }

  function buildWave(n) {
    const list = [];
    const e = effWave(n);
    let budget = Math.round((CURVE.a + CURVE.b * e + CURVE.c * e * e) * diffOf().budget * WAVE_SIZE * (1 + (game.pressure || 0)));
    const allowed = Object.keys(TIER_WAVE).map(Number)
      .filter(function (t) { return e >= tierWave(t); })
      .sort(function (a, b) { return b - a; })
      .slice(0, 3);
    const gap = Math.max(0.3, 0.85 - 0.02 * e);
    const nl = LANES.length;
    let group = 0;
    const specials = Object.keys(SPECIAL_WAVE).map(Number).filter(function (t) { return e >= SPECIAL_WAVE[t]; });
    const pSpecial = specials.length ? Math.min(0.4, 0.15 + 0.01 * (e - 8)) : 0;
    while (budget > 0) {
      const tier = Math.random() < pSpecial ? specials[randInt(0, specials.length - 1)] : allowed[randInt(0, allowed.length - 1)];
      const size = tier >= 7 ? randInt(2, 4) : randInt(3, 8);
      const lane = group++ % nl;
      for (let i = 0; i < size && budget > 0; i++) {
        list.push({ tier: tier, delay: i === 0 ? gap * 3 : gap, lane: lane });
        budget -= leakOf(tier);
      }
    }
    // bosses arrive spread through the wave
    const bosses = bossCount(n);
    const add = function (tier, count) {
      for (let i = 0; i < count; i++) list.splice(Math.floor(list.length * (i + 1) / (count + 1)), 0, { tier: tier, delay: 3, lane: i % nl, hpMul: bossHp(n, tier) });
    };
    add(17, bosses.brute);
    add(10, bosses.behemoth);
    add(11, bosses.colossus);
    // stretch the spawns so the whole wave lasts about WAVE_SECONDS; Stampede packs them into 75% of the time
    const span = Math.max(15, WAVE_SECONDS - 5) * (hasMod('rush') ? 0.75 : 1);
    let total = 0;
    for (const q of list) total += q.delay;
    const k = span / Math.max(0.01, total);
    for (const q of list) q.delay *= k;
    list[0].delay = 0.3;
    return list;
  }
  function wavePreview(n) {
    const notes = [];
    const e = effWave(n), p = n > 1 ? effWave(n - 1) : -1;
    const first = function (t) { return e >= tierWave(t) && p < tierWave(t); };
    if (first(7)) notes.push('Iron slimes appear: sharp attacks bounce off!');
    if (first(8)) notes.push('Prism slimes appear: very fast.');
    if (first(9)) notes.push('Stoneshells appear: tough outer shell.');
    const firstSp = function (t) { return e >= SPECIAL_WAVE[t] && p < SPECIAL_WAVE[t]; };
    if (firstSp(12)) notes.push('Dashers appear: sudden bursts of speed!');
    if (firstSp(13)) notes.push('Ghosts appear: they fade out and can\'t be hit while faded.');
    if (firstSp(14)) notes.push('Bulwarks appear: a shield blocks their first 3 hits.');
    if (firstSp(15)) notes.push('Broods appear: they burst into 4 fast slimes.');
    if (firstSp(16)) notes.push('Menders appear: they shield nearby slimes. Snipe them first!');
    const b = bossCount(n);
    if (b.brute && !b.behemoth) notes.push(b.brute === 1 ? 'A Brute approaches!' : b.brute + ' Brutes approach!');
    if (b.behemoth) notes.push(b.behemoth === 1 ? 'A Behemoth approaches!' : b.behemoth + ' Behemoths approach!');
    if (b.colossus) notes.push(b.colossus === 1 ? 'A Colossus approaches!' : b.colossus + ' Colossi approach!');
    return notes.join(' ');
  }

  function startWave() {
    if (running || gameOver) return;
    livesAtWaveStart = game.lives;
    wake();
    placing = null; // building is locked while a wave runs
    focus = 0; powersFired = 0; frenzyUntil = 0;
    waveElapsed = 0;
    leakedThisWave = false;
    hideOverlay();
    nextWaveAt = null;
    spawnQueue = buildWave(game.wave);
    spawnTimer = spawnQueue[0].delay;
    running = true;
    paused = false;
    updateWaveTimerUI();
    bridge('wave_started', null);
    const note = wavePreview(game.wave);
    banner = { text: 'WAVE ' + game.wave, sub: note, t0: time };
    if (towers.length === 0) toast('No towers yet! Buy some with your study points.');
    renderUI();
  }

  function endWave() {
    running = false;
    paused = false;
    updateWaveTimerUI();
    focus = 0; powersFired = 0; frenzyUntil = 0;
    projectiles = [];
    const cleared = game.wave;
    game.wave += 1;
    game.bestWave = Math.max(game.bestWave, cleared);
    // pressure: cruising makes the next waves a little tougher, heavy leaking eases them slightly
    const lost = livesAtWaveStart - game.lives;
    if (lost <= 0) game.pressure = Math.min(0.2, (game.pressure || 0) + 0.04);
    else if (lost > START_LIVES * diffOf().lives * 0.05) game.pressure = Math.max(-0.1, (game.pressure || 0) - 0.03);
    if (!game.endless && cleared >= diffOf().win) { winRun(cleared); return; }
    toast(wavePreview(game.wave) || 'Wave ' + cleared + ' cleared! Build now: the next card starts wave ' + game.wave + '.');
    commit(0, snapshot(), null);
    bridge('wave_cleared:' + JSON.stringify({ cleared: cleared, nextWave: game.wave, points: points }), null);
    scheduleNextWave();
    renderUI();
  }

  function scheduleNextWave() {
    nextWaveAt = COUNTDOWN > 0 ? Date.now() + COUNTDOWN * 1000 : null;
  }
  function secondsToWave() {
    return nextWaveAt ? Math.max(0, Math.ceil((nextWaveAt - Date.now()) / 1000)) : null;
  }

  function togglePause(val) {
    if (!running || gameOver) return;
    paused = val !== undefined ? !!val : !paused;
    wake();
    renderUI();
  }

  let waveElapsed = 0;
  let lastWaveTimerSecs = -1;
  function updateWaveTimerUI() {
    const el = $('td-wavetimer');
    if (!el) return;
    if (!running) {
      el.classList.add('td-hidden');
      lastWaveTimerSecs = -1;
      return;
    }
    el.classList.remove('td-hidden');
    const secsLeft = Math.max(0, Math.ceil(WAVE_SECONDS - waveElapsed));
    if (secsLeft === lastWaveTimerSecs) return;
    lastWaveTimerSecs = secsLeft;
    const mins = Math.floor(secsLeft / 60);
    const s = secsLeft % 60;
    const valEl = $('td-wavetime-val');
    if (valEl) valEl.textContent = mins + ':' + (s < 10 ? '0' : '') + s + (paused ? ' ⏸' : '');
  }

  function triggerGameOver() {
    gameOver = true;
    running = false;
    paused = false;
    updateWaveTimerUI();
    nextWaveAt = null;
    const reached = game.wave;
    const cleared = reached - 1;
    game.bestWave = Math.max(game.bestWave, cleared);
    const bonus = diffOf().coins * cleared;
    // the run is over: towers are gone, the unlocks and the coins stay
    const fresh = newRun();
    commit(bonus, snapshot(null, null, { wave: 1, lives: fresh.lives, towers: [], mods: fresh.mods, pressure: 0, endless: false }), null);
    showOverlay('Run over!',
      'The slimes broke through on wave ' + reached + '. You cleared ' + cleared + ' wave' + (cleared === 1 ? '' : 's') +
      ' and earn +' + bonus + ' coins for your next run. Your towers are gone, but every unlock stays.',
      'Start a new run', function () {
        enemies = []; projectiles = []; effects = []; spawnQueue = []; piles = []; particles = [];
        towers = []; selected = null; placing = null;
        game.wave = 1;
        game.lives = fresh.lives;
        game.mods = fresh.mods;
        game.pressure = 0; game.endless = false;
        gameOver = false;
        refreshAll();
        scheduleNextWave();
        renderUI();
        showRunCard();
      });
    renderUI();
  }

  // ------------------------------------------------------------ study powers
  const POWERS = [
    { name: 'Frost Nova', desc: 'Freezes every slime for 3s' },
    { name: 'Meteor', desc: 'Three big blasts on the biggest clumps' },
    { name: 'Lightning Storm', desc: 'Strikes up to 20 slimes' },
    { name: 'Frenzy', desc: 'Towers attack 60% faster for 10s' },
  ];
  // first four in order, then keep cycling the three attacks
  function powerIndex(n) { return n < 4 ? n : 1 + ((n - 4) % 3); }

  function firePower() {
    const idx = powerIndex(powersFired++);
    const P = POWERS[idx];
    const live = enemies.filter(function (e) { return !e.dead && !e.hidden; });
    if (idx === 0) {
      for (const e of live) slow(e, 0.08, 3, { metal: true });
      for (const e of live) emit({ kind: 'ring', x: e.x, y: e.y, r0: 4, r1: e.def.r * 2, w: 3, max: 0.5, color: '#c9ecff' });
      emit({ kind: 'flash', x: W / 2, y: H / 2, size: 120, max: 0.25, color: '#bfe9ff' });
    } else if (idx === 1) {
      // three strikes, each on the biggest clump not already hit
      const hitAt = [];
      for (let strike = 0; strike < 3; strike++) {
        let best = null, bestN = 0;
        for (const e of live) {
          if (e.dead || hitAt.some(function (h) { return Math.hypot(h[0] - e.x, h[1] - e.y) < 120; })) continue;
          let n = 0;
          for (const o of live) if (!o.dead && Math.hypot(o.x - e.x, o.y - e.y) < 110) n++;
          if (n > bestN) { bestN = n; best = e; }
        }
        if (!best) break;
        const x = best.x, y = best.y;
        hitAt.push([x, y]);
        explode(x, y, 110, 4, 'explosive', null, false);
        boomFx(x, y, 75, false);
      }
      addShake(10);
    } else if (idx === 2) {
      const targets = live.slice().sort(function () { return Math.random() - 0.5; }).slice(0, 20);
      for (const e of targets) {
        const x = e.x, y = e.y;
        effects.push({ type: 'bolt', pts: jagged([[x + rand(-30, 30), -10], [x, y]], 9), pts2: jagged([[x + rand(-30, 30), -10], [x, y]], 12), t: 0, max: 0.3 });
        damage(e, 3, 'energy', null);
        impactFx(x, y, '#fff3a0');
      }
      addShake(4);
    } else {
      frenzyUntil = time + 10;
      for (const t of towers) emit({ kind: 'ring', x: t.x, y: t.y, r0: 8, r1: 34, w: 4, max: 0.5, color: '#ffd23f' });
    }
    banner = { text: P.name.toUpperCase() + '!', sub: 'Study power: ' + focus + ' cards this wave', t0: time };
    wake();
  }

  function renderFocus() {
    const box = $('td-focus');
    box.classList.toggle('td-hidden', !running);
    if (!running) return;
    const into = focus % FOCUS_CARDS;
    let bar = '';
    for (let i = 0; i < FOCUS_CARDS; i++) bar += '<span class="' + (i < into ? 'td-on' : '') + '"></span>';
    $('td-focus-bar').innerHTML = bar;
    $('td-focus-next').textContent = POWERS[powerIndex(powersFired)].name;
  }

  function winRun(cleared) {
    const d = diffOf();
    const bonus = d.coins * cleared * 2;
    saved.trophies = saved.trophies || {};
    const t = saved.trophies[mapId] = saved.trophies[mapId] || {};
    t[game.diff] = true;
    commit(bonus, snapshot(), null);
    banner = { text: 'VICTORY!', sub: MAP.name + ' on ' + d.name, t0: time };
    showOverlay('Victory!', '',
      'Keep going (endless)', function () { game.endless = true; hideOverlay(); commit(0, snapshot(), null); renderUI(); },
      '<span class="td-mod td-mod-good"><b class="td-outline">You held ' + esc(MAP.name) + ' for ' + cleared + ' waves on ' + esc(d.name) + '!</b>' +
      '+' + bonus + ' coins (double the usual payout) and a ' + esc(d.name) + ' trophy for this map.</span>' +
      '<span class="td-mod-note">Keep going for fun with these towers, or start a fresh run.</span>' +
      '<button id="td-newrun" class="td-btn td-blue">Start a new run</button>');
    $('td-newrun').addEventListener('click', function () {
      const fresh = newRun();
      towers = []; selected = null; placing = null; piles = [];
      game.wave = 1; game.lives = fresh.lives; game.mods = fresh.mods; game.pressure = 0; game.endless = false;
      refreshAll();
      commit(0, snapshot(), null);
      renderUI();
      showRunCard();
    });
    renderUI();
  }

  // a fresh run: new modifiers, and the lives they give
  function newRun() {
    const mods = rollMods();
    const lives = livesFor(mods, game.diff);
    return { mods: mods, lives: lives };
  }
  function livesFor(mods, diff) {
    const base = START_LIVES * (DIFFS[diff] || DIFFS.medium).lives;
    return Math.max(1, Math.round(mods && mods.twist === 'fragile' ? base * 0.6 : base));
  }
  // runs saved before modifiers existed (or brand-new ones) get theirs now
  function ensureRun() {
    if (game.mods) return false;
    const fresh = newRun();
    game.mods = fresh.mods;
    if (!game.towers.length && game.wave === 1) game.lives = fresh.lives;
    return true;
  }

  // ------------------------------------------------------------ combat
  let particles = [];
  let shake = 0;
  let banner = null;

  function spawnEnemy(tier, dist, slowUntil, slowFactor, lane) {
    const def = ENEMIES[tier];
    lane = lane || 0;
    const p = posAt(dist, lane);
    const e = { id: nextEnemyId++, tier: tier, def: def, hp: def.hp, maxHp: def.hp, dist: dist, lane: lane, hidden: false, burn: null,
      shield: def.shield || 0, inTunnel: false, phased: false,
      x: p.x, y: p.y, dir: 0, slowUntil: slowUntil || 0, slowFactor: slowFactor || 1, dead: false,
      wob: Math.random() * 6, clinkAt: -1, hitT: -1, bornT: time };
    enemies.push(e);
    return e;
  }

  function immune(e, dtype, s) {
    return !!e.def.metal && (dtype === 'sharp' || dtype === 'cold') && !(s && s.metal);
  }

  // returns false if the attack bounced off
  function damage(e, dmg, dtype, s) {
    if (e.dead) return true;
    if (immune(e, dtype, s)) {
      if (time - e.clinkAt > 0.15) {
        e.clinkAt = time;
        clinkFx(e.x, e.y - e.def.r * 0.5);
      }
      return false;
    }
    if (e.shield > 0) {
      e.shield -= 1;
      e.hitT = time;
      emit({ kind: 'ring', x: e.x, y: e.y, r0: e.def.r, r1: e.def.r * 1.8, w: 3, max: 0.25, color: '#9fe8ff' });
      return true;
    }
    if (e.def.heavy && s && s.heavyMult) dmg *= s.heavyMult;
    e.hp -= dmg;
    e.hitT = time;
    while (e.hp <= 0 && !e.dead) {
      const over = -e.hp;
      const def = e.def;
      if (!def.children) {
        e.dead = true;
        popFx(e.x, e.y, def, false);
        break;
      }
      if (def.children.length > 1) {
        e.dead = true;
        popFx(e.x, e.y, def, true);
        def.children.forEach(function (c, i) {
          spawnEnemy(c, Math.max(0, e.dist - i * 12), e.slowUntil, e.slowFactor, e.lane);
        });
        break;
      }
      popFx(e.x, e.y, def, false);
      e.tier = def.children[0];
      e.def = ENEMIES[e.tier];
      e.hp = e.def.hp - over;
      e.maxHp = e.def.hp;
      e.bornT = time;
    }
    return true;
  }

  function explode(x, y, radius, dmg, dtype, s, small) {
    boomFx(x, y, radius, small);
    for (const e of enemies.slice()) {
      if (!e.dead && !e.hidden && Math.hypot(e.x - x, e.y - y) <= radius + e.def.r) damage(e, dmg, dtype, s);
    }
  }

  function slow(e, factor, dur, s) {
    if (immune(e, 'cold', s)) return;
    if (e.def.heavy) factor = 1 - (1 - factor) * 0.4;
    if (time < e.slowUntil) e.slowFactor = Math.min(e.slowFactor, factor);
    else e.slowFactor = factor;
    e.slowUntil = Math.max(e.slowUntil, time + dur);
  }

  function pickTarget(t, range) {
    let best = null, bestScore = -Infinity;
    for (const e of enemies) {
      if (e.dead || e.hidden) continue;
      const d = Math.hypot(e.x - t.x, e.y - t.y);
      if (d > range + e.def.r) continue;
      if (range >= 1000 && MAP.lanterns && d > 260 && !nearLantern(e.x, e.y)) continue; // can't see into the fog
      const prog = e.dist / LANES[e.lane].len;
      let score;
      switch (t.target) {
        case 'last': score = -prog; break;
        case 'strong': score = leakOf(e.tier) * 10000 + prog; break;
        case 'close': score = -d; break;
        default: score = prog;
      }
      if (score > bestScore) { bestScore = score; best = e; }
    }
    return best;
  }

  function nearestFrom(x, y, maxD, hit) {
    let best = null, bd = maxD;
    for (const e of enemies) {
      if (e.dead || e.hidden || hit[e.id]) continue;
      const d = Math.hypot(e.x - x, e.y - y);
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  function jagged(pts, amp) {
    const out = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const n = Math.max(2, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 14));
      for (let j = 1; j < n; j++) {
        const k = j / n;
        out.push([a[0] + (b[0] - a[0]) * k + rand(-amp, amp), a[1] + (b[1] - a[1]) * k + rand(-amp, amp)]);
      }
      out.push(b);
    }
    return out;
  }

  function updateTower(t, dt) {
    const def = TOWERS[t.type];
    const s = t.s;

    // Smoothly track targets every frame for rotating towers
    if (!STILL[def.kind]) {
      const curTarget = pickTarget(t, s.range);
      if (curTarget) {
        const want = Math.atan2(curTarget.y - t.y, curTarget.x - t.x);
        if (t.angle == null) {
          t.angle = want;
        } else {
          let diff = want - t.angle;
          while (diff < -Math.PI) diff += Math.PI * 2;
          while (diff > Math.PI) diff -= Math.PI * 2;
          t.angle += diff * Math.min(1, dt * 18);
        }
      }
    }

    t.cd -= time < frenzyUntil ? dt * 1.6 : dt;
    if (t.cd > 0) return;

    if (def.kind === 'aura') {
      let any = false;
      for (const e of enemies) {
        if (e.dead || e.hidden || Math.hypot(e.x - t.x, e.y - t.y) > s.range + e.def.r) continue;
        any = true;
        slow(e, s.slow, s.dur, s);
        if (s.dmg) damage(e, s.dmg, 'cold', s);
      }
      if (any) {
        t.cd = 1 / s.rate;
        t.fireT = time;
        frostFx(t.x, t.y, s.range);
      }
      return;
    }

    if (def.kind === 'buff') {
      if (running && time - (t.noteT || 0) > 1.4 && towers.some(function (o) { return o.buffedBy === t.id; })) {
        t.noteT = time; t.fireT = time;
        emit({ kind: 'text', x: t.x + rand(-10, 10), y: t.y - 22, vy: -26, size: 14, max: 0.9, color: '#c8f07a', text: Math.random() < 0.5 ? '\u266A' : '\u266B' });
      }
      return;
    }

    if (def.kind === 'push') {
      let any = false;
      for (const e of enemies) {
        if (e.dead || e.hidden || Math.hypot(e.x - t.x, e.y - t.y) > s.range + e.def.r) continue;
        any = true;
        // knockback is a backwards slide (see update). Each further shove on the same slime is
        // half as strong, so Gale buys time but can never hold a slime in place forever.
        const k = (e.def.heavy ? s.heavyPush : 1) * Math.pow(s.decay, e.pushes || 0);
        e.pushes = (e.pushes || 0) + 1;
        e.kb = Math.min(520, (e.kb || 0) + s.push * k);
        if (s.slow) slow(e, s.slow, s.dur, s);
        if (s.dmg) damage(e, s.dmg, 'wind', s);
      }
      if (any) {
        t.cd = 1 / s.rate;
        t.fireT = time;
        gustFx(t.x, t.y, s.range);
      }
      return;
    }

    if (def.kind === 'spikes') {
      if (!running || !t.trackPts.length) return;
      const mine = piles.filter(function (p) { return p.owner === t.id; }).length;
      if (mine >= s.maxPiles) return;
      t.cd = 1 / s.rate;
      t.fireT = time;
      const p = t.trackPts[randInt(0, t.trackPts.length - 1)];
      piles.push({ owner: t.id, x: p.x + rand(-8, 8), y: p.y + rand(-8, 8), fx: t.x, fy: t.y, t0: time,
        hits: s.hits, life: s.life, s: s, hit: {}, seed: Math.random() * 6 });
      return;
    }

    const target = pickTarget(t, s.range);
    if (!target) return;
    t.cd = 1 / s.rate;
    t.fireT = time;
    t.angle = Math.atan2(target.y - t.y, target.x - t.x);
    const ca = Math.cos(t.angle), sa = Math.sin(t.angle);

    if (def.kind === 'proj') {
      const n = s.shots || 1;
      const kind = t.type === 'archer' ? 'dart' : (t.type === 'titan' ? 'beam' : 'bolt');
      const muzzle = t.type === 'titan' ? 18 : 14;
      for (let i = 0; i < n; i++) {
        const a = t.angle + (i - (n - 1) / 2) * (t.type === 'titan' ? 0.06 : 0.2);
        const off = t.type === 'titan' && n > 1 ? (i === 0 ? -5 : 5) : 0;
        projectiles.push({ kind: kind,
          x: t.x + ca * muzzle - sa * off, y: t.y + sa * muzzle + ca * off,
          target: (n === 1 || i === (n - 1) / 2 || t.type === 'titan') ? target : null,
          vx: Math.cos(a), vy: Math.sin(a), speed: s.speed, pierce: s.pierce, hit: {},
          life: (s.range * 1.6) / s.speed + 0.2, s: s, color: t.type === 'arcanist' ? (s.splash ? '#ff8c42' : '#b47cff') : '#9ff3ff' });
      }
      if (t.type === 'arcanist') emit({ kind: 'flash', x: t.x, y: t.y - 4, size: 16, max: 0.15, color: s.splash ? '#ff8c42' : '#c9a0ff' });
    } else if (def.kind === 'splash') {
      const lead = posAt(target.dist + target.def.speed * 0.3, target.lane);
      const mx = t.x + ca * 22, my = t.y + sa * 22;
      projectiles.push({ kind: 'shell', x: mx, y: my, sx: mx, sy: my, tx: lead.x, ty: lead.y, speed: s.speed, s: s,
        total: Math.max(1, Math.hypot(lead.x - mx, lead.y - my)) });
      muzzleFx(mx, my, t.angle, '#ffb347', 1.2);
    } else if (def.kind === 'hitscan') {
      const hit = {};
      const pts = [[t.x + ca * 30, t.y + sa * 30]];
      let cur = target;
      for (let i = 0; i <= (s.bounce || 0) && cur; i++) {
        hit[cur.id] = true;
        pts.push([cur.x, cur.y]);
        const cx = cur.x, cy = cur.y;
        damage(cur, s.dmg, s.dtype, s);
        impactFx(cx, cy, '#fff3b0');
        cur = nearestFrom(cx, cy, 170, hit);
      }
      effects.push({ type: 'tracer', pts: pts, t: 0, max: 0.14 });
      muzzleFx(pts[0][0], pts[0][1], t.angle, '#fff1a8', 0.8);
      emit({ kind: 'shard', x: t.x, y: t.y, vx: -sa * rand(40, 80), vy: ca * rand(40, 80), g: 300, size: 2.2,
        color: '#e3b64f', max: 0.5, vr: rand(-15, 15) });
    } else if (def.kind === 'chain') {
      const hit = {};
      const pts = [[t.x, t.y - 4]];
      let cur = target;
      for (let i = 0; i < s.chains && cur; i++) {
        hit[cur.id] = true;
        pts.push([cur.x, cur.y]);
        const cx = cur.x, cy = cur.y;
        damage(cur, s.dmg, s.dtype, s);
        impactFx(cx, cy, '#9fd8ff');
        cur = nearestFrom(cx, cy, 90, hit);
      }
      effects.push({ type: 'bolt', pts: jagged(pts, 7), pts2: jagged(pts, 10), t: 0, max: 0.18 });
    } else if (def.kind === 'flame') {
      for (const e of enemies) {
        if (e.dead || e.hidden) continue;
        const dx = e.x - t.x, dy = e.y - t.y, d = Math.hypot(dx, dy);
        if (d > s.range + e.def.r) continue;
        let da = Math.atan2(dy, dx) - t.angle;
        while (da < -Math.PI) da += Math.PI * 2;
        while (da > Math.PI) da -= Math.PI * 2;
        if (Math.abs(da) > s.cone && d > 20) continue;
        damage(e, s.dmg, 'fire', s);
        if (!e.dead && !(e.burn && e.burn.until > time + 0.5)) e.burn = { dmg: s.burn, until: time + s.burnDur, next: time + 1 };
      }
      flameFx(t.x + ca * 16, t.y + sa * 16, t.angle, s.range, s.cone);
    } else if (def.kind === 'boomerang') {
      const n = s.shots || 1;
      for (let i = 0; i < n; i++) {
        projectiles.push({ kind: 'rang', ox: t.x, oy: t.y, ang: t.angle + (n > 1 ? (i ? 0.25 : -0.25) : 0), R: s.range * 1.05,
          side: i % 2 ? -1 : 1, u: 0, dur: 0.6 + s.range / 450, x: t.x, y: t.y, pierce: s.pierce, hit: {}, s: s, back: false, spin: 0 });
      }
    }
  }

  function updateProjectile(p, dt) {
    const s = p.s;
    if (p.kind === 'rang') {
      // flies a loop: out along the aim line on one side, back along the other
      p.u += dt / p.dur;
      if (p.u >= 1) { p.done = true; return; }
      if (!p.back && p.u >= 0.5) { p.back = true; p.hit = {}; }
      const th = Math.PI + Math.PI * 2 * p.u;
      const along = p.R / 2 + (p.R / 2) * Math.cos(th), side = p.R * 0.3 * Math.sin(th) * p.side;
      const ca = Math.cos(p.ang), sa = Math.sin(p.ang);
      p.x = p.ox + ca * along - sa * side;
      p.y = p.oy + sa * along + ca * side;
      p.spin += dt * 24;
      for (const e of enemies) {
        if (e.dead || e.hidden || p.hit[e.id]) continue;
        if (Math.hypot(e.x - p.x, e.y - p.y) < e.def.r + 9) {
          p.hit[e.id] = true;
          damage(e, s.dmg, s.dtype, s);
          p.pierce -= 1;
          if (p.pierce <= 0) { p.done = true; return; }
        }
      }
      return;
    }
    if (p.kind === 'shell') {
      const dx = p.tx - p.x, dy = p.ty - p.y;
      const d = Math.hypot(dx, dy);
      const step = p.speed * dt;
      if (d <= step) {
        p.done = true;
        explode(p.tx, p.ty, s.splash, s.dmg, s.dtype, s, false);
        for (let i = 0; i < (s.cluster || 0); i++) {
          const a = (i / s.cluster) * Math.PI * 2 + Math.random();
          explode(p.tx + Math.cos(a) * s.splash * 0.9, p.ty + Math.sin(a) * s.splash * 0.9, 26, 1, s.dtype, s, true);
        }
      } else {
        p.x += (dx / d) * step;
        p.y += (dy / d) * step;
        if (Math.random() < 0.5) emit({ kind: 'smoke', x: p.x, y: p.y - shellHeight(p), size: 3, max: 0.4, color: '#9a9a9a', vy: -10 });
      }
      return;
    }
    if (p.target && !p.target.dead) {
      const a = Math.atan2(p.target.y - p.y, p.target.x - p.x);
      p.vx = Math.cos(a); p.vy = Math.sin(a);
    }
    p.x += p.vx * p.speed * dt;
    p.y += p.vy * p.speed * dt;
    p.life -= dt;
    if (p.kind === 'bolt' && Math.random() < 0.8) {
      emit({ kind: 'glow', x: p.x + rand(-2, 2), y: p.y + rand(-2, 2), size: 7, max: 0.3, color: p.color });
    }
    for (const e of enemies) {
      if (e.dead || e.hidden || p.hit[e.id]) continue;
      if (Math.hypot(e.x - p.x, e.y - p.y) < e.def.r + 4) {
        p.hit[e.id] = true;
        if (s.splash) explode(p.x, p.y, s.splash, s.dmg, s.dtype, s, true);
        else {
          damage(e, s.dmg, s.dtype, s);
          if (p.kind !== 'dart') impactFx(p.x, p.y, p.color);
        }
        p.pierce -= 1;
        if (p.pierce <= 0) { p.done = true; break; }
      }
    }
    if (p.life <= 0 || p.x < -20 || p.x > W + 20 || p.y < -20 || p.y > H + 20) p.done = true;
  }

  const PILE_FLIGHT = 0.45;
  function updatePile(p, dt) {
    if (time - p.t0 < PILE_FLIGHT) return;
    if (!p.landed) {
      p.landed = true;
      for (let i = 0; i < 4; i++) emit({ kind: 'smoke', x: p.x + rand(-6, 6), y: p.y + rand(-3, 3), size: 3, max: 0.4, color: '#c8a878', vy: -8 });
    }
    p.life -= dt;
    if (p.life <= 0) { p.done = true; return; }
    for (const e of enemies) {
      if (e.dead || e.hidden || p.hit[e.id]) continue;
      if (Math.hypot(e.x - p.x, e.y - p.y) < e.def.r + 9) {
        p.hit[e.id] = true;
        damage(e, p.s.dmg, 'sharp', p.s);
        p.hits -= 1;
        if (p.hits <= 0) {
          p.done = true;
          if (p.s.mine) explode(p.x, p.y, 55, 2, 'explosive', null, false);
          return;
        }
      }
    }
  }

  // ------------------------------------------------------------ particles & effects
  function emit(o) {
    if (particles.length > 450) return;
    const p = { x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 0.5, size: 3, color: '#fff', g: 0, rot: Math.random() * 6,
      vr: 0, drag: 0, kind: 'dot' };
    for (const k in o) p[k] = o[k];
    particles.push(p);
  }
  function addShake(v) { shake = Math.min(12, shake + v); }

  function popFx(x, y, def, big) {
    const prism = def.color === 'prism';
    const base = prism ? '#b088ff' : def.color;
    const heavy = !!def.heavy;
    emit({ kind: 'burst', x: x, y: y, size: def.r * (heavy ? 2.2 : 1.5), max: heavy ? 0.3 : 0.16, color: base });
    const n = heavy ? 26 : (big ? 12 : 7);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = rand(90, heavy ? 320 : 220);
      emit({ kind: 'shard', x: x, y: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 40, g: 420, drag: 1.5,
        size: rand(2.5, heavy ? 7 : 4.5), max: rand(0.35, 0.6), vr: rand(-14, 14),
        color: prism ? 'hsl(' + Math.floor(Math.random() * 360) + ',85%,65%)' : (Math.random() < 0.3 ? '#ffffff' : base) });
    }
    for (let i = 0; i < 3; i++) {
      const a = Math.random() * Math.PI * 2;
      emit({ kind: 'dot', x: x, y: y, vx: Math.cos(a) * 60, vy: Math.sin(a) * 60 - 60, g: 300, size: 2.2, max: 0.4, color: base });
    }
    if (heavy || def.metal || def.hp > 2) {
      emit({ kind: 'ring', x: x, y: y, r0: def.r * 0.5, r1: def.r * 2.2, w: heavy ? 6 : 3, max: 0.35, color: '#ffffff' });
    }
    if (heavy) {
      boomFx(x, y, def.r * 1.6, false);
      addShake(10);
      emit({ kind: 'text', x: x, y: y - def.r, vy: -30, size: 22, max: 1.1, color: '#ffd166', text: def.name + ' DOWN!' });
    }
  }

  function boomFx(x, y, r, small) {
    emit({ kind: 'flash', x: x, y: y, size: r * 1.5, max: 0.16, color: '#fff3c4' });
    emit({ kind: 'ring', x: x, y: y, r0: r * 0.2, r1: r * 1.1, w: 4, max: 0.3, color: '#ffe2a8' });
    const n = small ? 5 : 11;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, v = rand(30, 140) * (r / 50);
      emit({ kind: 'fire', x: x, y: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, drag: 3, size: rand(5, 10) * (small ? 0.7 : 1),
        max: rand(0.25, 0.45), color: Math.random() < 0.5 ? '#ffb347' : '#ff6b35' });
    }
    for (let i = 0; i < (small ? 2 : 5); i++) {
      emit({ kind: 'smoke', x: x + rand(-r, r) * 0.4, y: y + rand(-r, r) * 0.4, vx: rand(-15, 15), vy: rand(-35, -10),
        size: rand(6, 11), max: rand(0.7, 1.1), color: '#5c5c5c' });
    }
    if (!small) {
      for (let i = 0; i < 4; i++) {
        const a = Math.random() * Math.PI * 2;
        emit({ kind: 'shard', x: x, y: y, vx: Math.cos(a) * 150, vy: Math.sin(a) * 150 - 80, g: 500, size: 2.5, max: 0.5,
          vr: 12, color: '#3a3330' });
      }
      addShake(2.5);
    }
  }

  function frostFx(x, y, range) {
    emit({ kind: 'ring', x: x, y: y, r0: 10, r1: range, w: 5, max: 0.5, color: '#c9ecff' });
    emit({ kind: 'flash', x: x, y: y - 4, size: 26, max: 0.25, color: '#bfe9ff' });
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2, d = rand(0.2, 0.9) * range;
      emit({ kind: 'flake', x: x + Math.cos(a) * d, y: y + Math.sin(a) * d, vx: Math.cos(a) * 20, vy: Math.sin(a) * 20 + 8,
        size: rand(2.5, 4), max: rand(0.6, 1), vr: rand(-3, 3), color: '#ffffff' });
    }
  }

  function gustFx(x, y, range) {
    emit({ kind: 'ring', x: x, y: y, r0: 12, r1: range, w: 4, max: 0.45, color: '#e9f8ff' });
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2, d = rand(0.3, 0.9) * range;
      emit({ kind: 'spark', x: x + Math.cos(a) * d * 0.4, y: y + Math.sin(a) * d * 0.4, vx: Math.cos(a) * 220, vy: Math.sin(a) * 220,
        drag: 3, size: 2.2, max: 0.4, color: '#ffffff' });
    }
  }

  function flameFx(x, y, ang, range, cone) {
    for (let i = 0; i < 14; i++) {
      const a = ang + rand(-cone, cone) * 0.85, v = rand(0.6, 1.25) * range * 2.4;
      emit({ kind: 'fire', x: x, y: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, drag: 4.5, size: rand(4, 8),
        max: rand(0.25, 0.42), color: Math.random() < 0.5 ? '#ffb347' : '#ff6b35' });
    }
  }

  function muzzleFx(x, y, ang, color, scale) {
    emit({ kind: 'flash', x: x, y: y, size: 14 * scale, max: 0.09, color: color });
    for (let i = 0; i < 3; i++) {
      emit({ kind: 'smoke', x: x, y: y, vx: Math.cos(ang) * rand(20, 50) + rand(-10, 10), vy: Math.sin(ang) * rand(20, 50) - 10,
        size: 4 * scale, max: 0.6, color: '#8a8a8a' });
    }
  }

  function impactFx(x, y, color) {
    emit({ kind: 'flash', x: x, y: y, size: 12, max: 0.1, color: color });
    for (let i = 0; i < 3; i++) {
      const a = Math.random() * Math.PI * 2;
      emit({ kind: 'spark', x: x, y: y, vx: Math.cos(a) * 160, vy: Math.sin(a) * 160, drag: 4, size: 2, max: 0.2, color: color });
    }
  }

  function clinkFx(x, y) {
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + rand(-1.2, 1.2);
      emit({ kind: 'spark', x: x, y: y, vx: Math.cos(a) * 180, vy: Math.sin(a) * 180, g: 300, drag: 2, size: 1.6, max: 0.25, color: '#fff2b0' });
    }
    emit({ kind: 'text', x: x, y: y - 6, vy: -40, size: 11, max: 0.45, color: '#e8eef5', text: 'clink!' });
  }

  function leakFx(e) {
    const E = LANES[e.lane].pts[LANES[e.lane].pts.length - 1];
    const x = Math.max(22, Math.min(W - 22, E[0])), y = E[1];
    emit({ kind: 'flash', x: x, y: y, size: 40, max: 0.25, color: '#ff4d4d' });
    emit({ kind: 'text', x: x - 20, y: y - 30, vy: -35, size: 16, max: 0.9, color: '#ff6b6b', text: '-' + leakDamage(e.tier) });
    addShake(e.def.heavy ? 12 : 3);
  }

  function showLives() {
    const el = document.getElementById('td-lives');
    el.textContent = Math.max(0, Math.ceil(game.lives));
    if (el.animate && (!el._hurt || el._hurt.playState === 'finished')) {
      el._hurt = el.animate([{ transform: 'none' }, { transform: 'translateX(-5px) rotate(-3deg)' },
        { transform: 'translateX(5px) rotate(3deg)' }, { transform: 'none' }], { duration: 350 });
    }
  }

  function updateParticles(dt) {
    for (const p of particles) {
      p.life += dt;
      if (p.drag) { const f = Math.max(0, 1 - p.drag * dt); p.vx *= f; p.vy *= f; }
      p.vy += p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
    }
    let n = 0;
    for (let i = 0; i < particles.length; i++) if (particles[i].life < particles[i].max) particles[n++] = particles[i];
    particles.length = n;
  }

  // ------------------------------------------------------------ simulation
  function update(dt) {
    if (gameOver || paused) return;
    runSpeed = (hasMod('speedy') ? 1.15 : 1) * diffOf().speed * (1 + (game.pressure || 0) * 0.25);
    time += dt;
    if (running) {
      waveElapsed += dt;
      spawnTimer -= dt;
      while (spawnQueue.length && spawnTimer <= 0) {
        const q = spawnQueue.shift();
        const sp = spawnEnemy(q.tier, 0, 0, 1, q.lane || 0);
        if (q.hpMul) { sp.hp = sp.maxHp = Math.max(1, Math.round(sp.def.hp * q.hpMul)); }
        spawnTimer += spawnQueue.length ? spawnQueue[0].delay : 0;
      }
    }

    for (const e of enemies) {
      if (e.dead) continue;
      const L = LANES[e.lane];
      if (e.kb > 0) {
        // slide backwards fast enough to read as a shove, slow enough to see
        const m = Math.min(e.kb, 280 * dt);
        e.kb -= m;
        e.dist = Math.max(0, e.dist - m);
        if (e.dist === 0) e.kb = 0;
        if (Math.random() < 0.6) {
          const a = e.dir + rand(-0.25, 0.25), back = e.def.r * 1.1;
          emit({ kind: 'spark', x: e.x - Math.cos(e.dir) * back + rand(-4, 4), y: e.y - Math.sin(e.dir) * back - e.def.r * 0.4 + rand(-6, 6),
            vx: Math.cos(a) * 260, vy: Math.sin(a) * 260, drag: 5, size: 1.8, max: 0.28, color: '#ffffff' });
        }
      } else {
        const dash = e.def.dasher && ((time + e.wob) % 3) < 0.6 ? 2.6 : 1;
        const f = (time < e.slowUntil ? e.slowFactor : 1) * (L.ice.length && inSpans(L.ice, e.dist) ? 1.5 : 1) * runSpeed * dash;
        if (dash > 1 && Math.random() < 0.5) {
          emit({ kind: 'spark', x: e.x - Math.cos(e.dir) * e.def.r, y: e.y - Math.sin(e.dir) * e.def.r, vx: -Math.cos(e.dir) * 200, vy: -Math.sin(e.dir) * 200,
            drag: 5, size: 2, max: 0.25, color: '#ffd08a' });
        }
        e.dist += e.def.speed * f * dt;
      }
      if (e.dist >= L.len) {
        e.dead = true;
        game.lives -= leakDamage(e.tier);
        leakedThisWave = true;
        leakFx(e);
        showLives();
        continue;
      }
      const p = posAt(e.dist, e.lane);
      if (p.x !== e.x || p.y !== e.y) e.dir = Math.atan2(p.y - e.y, p.x - e.x);
      e.x = p.x; e.y = p.y;
      e.inTunnel = L.tunnels.length > 0 && inSpans(L.tunnels, e.dist);
      e.phased = !!e.def.ghost && ((time + e.wob) % 4) < 1.5;
      e.hidden = e.inTunnel || e.phased;
      if (e.def.healer && !e.hidden && time >= (e.healT || 0)) {
        e.healT = time + 3;
        let any = false;
        for (const o of enemies) {
          if (o === e || o.dead || o.shield > 0 || Math.hypot(o.x - e.x, o.y - e.y) > 85) continue;
          o.shield = 1; any = true;
        }
        if (any) emit({ kind: 'ring', x: e.x, y: e.y, r0: 8, r1: 85, w: 4, max: 0.5, color: '#ff9fcc' });
      }
      if (e.burn) {
        if (!e.inTunnel && Math.random() < 0.25) {
          emit({ kind: 'fire', x: e.x + rand(-5, 5), y: e.y - e.def.r * 0.6, vx: rand(-10, 10), vy: rand(-50, -25), size: rand(3, 5), max: 0.3,
            color: Math.random() < 0.5 ? '#ffb347' : '#ff6b35' });
        }
        if (time >= e.burn.next) { e.burn.next += 1; damage(e, e.burn.dmg, 'fire', null); }
        if (e.burn && time > e.burn.until) e.burn = null;
      }
    }

    for (const t of towers) updateTower(t, dt);
    for (const p of projectiles) updateProjectile(p, dt);
    for (const p of piles) updatePile(p, dt);

    enemies = enemies.filter(function (e) { return !e.dead; });
    projectiles = projectiles.filter(function (p) { return !p.done; });
    piles = piles.filter(function (p) { return !p.done; });
    for (const fx of effects) fx.t += dt;
    effects = effects.filter(function (fx) { return fx.t < fx.max; });
    updateParticles(dt);
    shake = Math.max(0, shake - dt * 28);

    if (running) {
      updateWaveTimerUI();
      if (game.lives <= 0) { game.lives = 0; triggerGameOver(); }
      else if (!spawnQueue.length && !enemies.length) endWave();
    }
  }

  // ------------------------------------------------------------ rendering helpers
  // Flat cartoon style: solid fills, one flat shadow tone, thick ink outlines. No gradients or glows.
  const DPR = Math.min(2, window.devicePixelRatio || 1);
  const SPR = 2; // sprite supersampling
  const INK = '#2b2233';
  const LW = 2.2;
  const FONT = 'ui-rounded, "SF Pro Rounded", -apple-system, "Segoe UI", sans-serif';
  // display face for HUD text drawn on the canvas, matching the sidebar
  const UI_FONT = '"Lilita One", "Luckiest Guy", "Arial Rounded MT Bold", ui-rounded, "SF Pro Rounded", sans-serif';
  const UI_INK = '#12213f';
  const canvas = document.getElementById('td-board');
  // Render scale of the game canvas. Starts at the screen's pixel ratio and steps down
  // automatically if the machine can't keep up (see the frame monitor in the main loop).
  let RS = DPR;
  function setRenderScale(v) {
    RS = v;
    canvas.width = Math.round(W * RS);
    canvas.height = Math.round(H * RS);
  }
  setRenderScale(DPR);
  const ctx = canvas.getContext('2d');

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.ceil(w); c.height = Math.ceil(h);
    return c;
  }
  function circle(g, x, y, r) { g.beginPath(); g.arc(x, y, Math.max(0, r), 0, Math.PI * 2); }
  function ellipse(g, x, y, rx, ry, rot) { g.beginPath(); g.ellipse(x, y, Math.max(0, rx), Math.max(0, ry), rot || 0, 0, Math.PI * 2); }
  function poly(g, n, r, rot) {
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + (rot || 0);
      g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    g.closePath();
  }
  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }
  function hexRgb(h) {
    h = h.replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function shade(h, amt) {
    const c = hexRgb(h);
    const f = function (v) { return Math.max(0, Math.min(255, Math.round(amt < 0 ? v * (1 + amt) : v + (255 - v) * amt))); };
    return '#' + [f(c[0]), f(c[1]), f(c[2])].map(function (v) { return (v < 16 ? '0' : '') + v.toString(16); }).join('');
  }
  // outlines are a deep shade of the object's own colour, not one global ink
  function outlineOf(fill) {
    return typeof fill === 'string' && fill[0] === '#' && fill.length === 7 ? shade(fill, -0.58) : '#3a2f2a';
  }
  // black silhouette of a sprite, for cast shadows
  function silhouette(cv) {
    const c = makeCanvas(cv.width, cv.height), g = c.getContext('2d');
    g.drawImage(cv, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = '#000';
    g.fillRect(0, 0, c.width, c.height);
    return c;
  }
  // a sprite filled with one flat colour, for hit flashes and frost overlays
  function tintedSilhouette(cv, color) {
    const c = makeCanvas(cv.width, cv.height), g = c.getContext('2d');
    g.drawImage(cv, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = color;
    g.fillRect(0, 0, c.width, c.height);
    return c;
  }

  // ------------------------------------------------------------ painted sprites
  // PNGs from web/sprites, inlined by page.py as window.TD_SPRITES. Anything missing
  // falls back to the vector drawing below.
  const ART = {};
  let artPending = 0;
  (function loadArt() {
    const src = window.TD_SPRITES || {};
    Object.keys(src).forEach(function (k) {
      const im = new Image();
      artPending++;
      im.onload = im.onerror = function () {
        artPending--;
        if (artPending === 0 && typeof onArtLoaded === 'function') onArtLoaded();
      };
      im.src = src[k];
      ART[k] = im;
    });
  })();
  function art(k) {
    const im = ART[k];
    return im && im.complete && im.naturalWidth > 0 ? im : null;
  }

  function easeOutBack(k) { const c = 1.7; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2); }
  function easeOut(k) { return 1 - Math.pow(1 - k, 3); }

  // Fill a shape in its shadow colour, then the main colour nudged up-left and clipped,
  // which leaves a flat shadow crescent on the lower right. Then ink the outline.
  function flat(g, pathFn, fill, shadow, ox, oy, lw) {
    pathFn(); g.fillStyle = shadow || fill; g.fill();
    if (shadow) {
      g.save(); pathFn(); g.clip();
      g.translate(ox == null ? -2 : ox, oy == null ? -2.5 : oy);
      pathFn(); g.fillStyle = fill; g.fill();
      g.restore();
    }
    if (lw !== 0) { pathFn(); g.strokeStyle = outlineOf(fill); g.lineWidth = lw || LW; g.lineJoin = 'round'; g.stroke(); }
  }
  // Same idea for a union of circles (trees, bushes, smoke): outline only the outside edge.
  function flatBlobs(g, blobs, fill, shadow, lw) {
    const path = function (grow) {
      g.beginPath();
      blobs.forEach(function (b) { g.moveTo(b[0] + b[2] + grow, b[1]); g.arc(b[0], b[1], b[2] + grow, 0, Math.PI * 2); });
    };
    g.fillStyle = outlineOf(fill); path(lw == null ? LW : lw); g.fill();
    g.fillStyle = shadow; path(0); g.fill();
    g.save(); path(0); g.clip();
    g.translate(-2, -2.5); g.fillStyle = fill; path(0); g.fill();
    g.restore();
  }
  // a short white arc reads as "shiny" without any gradient
  function shine(g, x, y, r, a0, a1) {
    g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = Math.max(1.2, r * 0.16); g.lineCap = 'round';
    g.beginPath(); g.arc(x, y, r, a0, a1); g.stroke();
  }

  // seeded RNG so the scenery is the same every time
  function mulberry(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // kept for the few places that want a soft accent; deliberately flat now
  function drawGlow(g, x, y, size, color, alpha) {
    if (size <= 0) return;
    g.save();
    g.globalAlpha = Math.max(0, Math.min(1, (alpha == null ? 1 : alpha) * 0.5));
    g.fillStyle = color;
    circle(g, x, y, size * 0.5); g.fill();
    g.restore();
  }

  function drawStar(g, n, r1, r2) {
    g.beginPath();
    for (let i = 0; i < n * 2; i++) {
      const a = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2, r = i % 2 ? r2 : r1;
      g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    g.closePath();
  }

  // ------------------------------------------------------------ scenery
  // One light source (top-left). Everything casts a shadow to the lower right.
  const LIGHT = -Math.PI * 0.75;
  const obstacles = [];
  const FOLIAGE = ['#2a6b22', '#37862b', '#46a033', '#58b73d', '#6fcb4c', '#8ad964'];

  // Each map theme: ground, path and decoration palettes plus which details to scatter.
  const THEMES = {
    meadow: {
      ground: '#66bf3b', patches: ['#61b838', '#6bc540', '#5fb536', '#70c944'], blades: ['#55a92f', '#7fd552'], bladeN: 3200,
      shadow: 'rgba(25,70,15,0.32)', foliage: FOLIAGE, foliageInk: '#1d4f18', veins: 'rgba(20,60,15,0.35)',
      clovers: true, flowers: true, specks: ['#ff8fc8', '#6fd6ff', '#ffffff', '#d98cff'], pebbles: ['#a9b89a', '#c8d4bb'],
      pathEdge: '#b89a55', pathFill: '#d6bb72', stones: ['#f1dc98', '#e9d189', '#e2c77c', '#f3e3b0', '#dcc075'],
      stoneShadow: '#b0924e', stoneHi: 'rgba(255,250,225,0.7)', fringe: ['#5cb536', '#6cc540'],
      rock: ['#7f7a6c', '#efebdf', '#5f5b50'], trees: 11, rocks: 10, bushes: 12,
    },
    frost: {
      ground: '#e4eef6', patches: ['#dbe8f2', '#eef5fa', '#d5e3ef', '#f3f8fc'], blades: ['#c3d5e4', '#ffffff'], bladeN: 1500,
      shadow: 'rgba(50,85,125,0.24)', foliage: ['#1e4a46', '#28605a', '#357a71', '#cfe4ee', '#eef7fb', '#ffffff'],
      foliageInk: '#143633', veins: 'rgba(20,50,60,0.25)', snow: true,
      specks: ['#bfe3ff', '#ffffff', '#d7ecff'], pebbles: ['#a7b6c4', '#cad6e1'],
      pathEdge: '#9cb2c6', pathFill: '#bfd0df', stones: ['#e2ecf5', '#d6e3ee', '#ecf3f9', '#cfdde9', '#f4f8fb'],
      stoneShadow: '#a5b8ca', stoneHi: 'rgba(255,255,255,0.8)', fringe: ['#dbe7f1', '#f2f7fb'],
      rock: ['#6f7f8f', '#eef4f8', '#55626e'], trees: 12, rocks: 8, bushes: 6,
    },
    canyon: {
      ground: '#dcab6c', patches: ['#d4a162', '#e2b67a', '#cf9b5b', '#e6bd82'], blades: ['#c08c4e', '#eecb92'], bladeN: 1300,
      shadow: 'rgba(95,50,20,0.28)', foliage: ['#4f6b2a', '#5f7d30', '#728f3a', '#86a346', '#9bb556', '#b0c86a'],
      foliageInk: '#34481a', veins: 'rgba(40,50,15,0.3)', cacti: true,
      specks: ['#b8773f', '#f3d8a8', '#c98b52'], pebbles: ['#a8754a', '#c99366'],
      pathEdge: '#9a673b', pathFill: '#b5804f', stones: ['#c99463', '#d3a172', '#bf8a59', '#dbad7e', '#c68f5e'],
      stoneShadow: '#8c5d35', stoneHi: 'rgba(255,235,205,0.45)', fringe: ['#cf9e60', '#e0b273'],
      rock: ['#8a5236', '#efb68c', '#5e3522'], trees: 3, rocks: 20, bushes: 7,
    },
    misty: {
      ground: '#4d8746', patches: ['#487f41', '#53904c', '#457a3e', '#579651'], blades: ['#3e7337', '#64a25a'], bladeN: 2600,
      shadow: 'rgba(10,30,15,0.36)', foliage: ['#163b1d', '#1e4d26', '#285f30', '#33723b', '#3f8446', '#4f9654'],
      foliageInk: '#0d2612', veins: 'rgba(5,25,10,0.35)', mushrooms: true,
      specks: ['#9fe8ff', '#c9a7ff', '#e6f7ff'], pebbles: ['#7b8a78', '#99a796'],
      pathEdge: '#67634f', pathFill: '#858069', stones: ['#9f9b84', '#aca891', '#958f7a', '#b8b49d', '#a39f88'],
      stoneShadow: '#6a6653', stoneHi: 'rgba(235,240,220,0.4)', fringe: ['#487f41', '#53904c'],
      rock: ['#5d6460', '#c5ccc6', '#3f4542'], trees: 15, rocks: 9, bushes: 14,
    },
  };
  let THEME = THEMES[MAP.theme];

  function buildScenery() {
    const T = THEME;
    const rnd = mulberry(1337 + MAP_ORDER.indexOf(mapId) * 101);
    const trees = [], rocks = [], bushes = [], cacti = [];
    if (MAP.pond) obstacles.push({ x: MAP.pond.x, y: MAP.pond.y, r: Math.max(MAP.pond.rx, MAP.pond.ry) + 2 });
    (MAP.lanterns || []).forEach(function (l) { obstacles.push({ x: l[0], y: l[1], r: 10 }); });
    function free(x, y, r, pathGap) {
      if (distToPath(x, y) < PATH_HALF + pathGap + r) return false;
      for (const o of obstacles) if (Math.hypot(o.x - x, o.y - y) < o.r + r + 2) return false;
      return true;
    }
    // big trees framing the edges, allowed to hang off-screen
    for (let i = 0; i < 900 && trees.length < T.trees; i++) {
      const r = 30 + rnd() * 22;
      const x = -r * 0.4 + rnd() * (W + r * 0.8), y = -r * 0.4 + rnd() * (H + r * 0.8);
      const edge = x < 60 || x > W - 60 || y < 40 || y > H - 40;
      if (!edge || !free(x, y, r * 0.8, 4)) continue;
      trees.push({ x: x, y: y, r: r, seed: rnd() * 1000 });
      obstacles.push({ x: x, y: y, r: r * 0.8 });
    }
    for (let i = 0; i < 600 && rocks.length < T.rocks; i++) {
      const x = rnd() * W, y = rnd() * H, r = 8 + rnd() * (T.cacti ? 14 : 9);
      if (!free(x, y, r, 6)) continue;
      rocks.push({ x: x, y: y, r: r, seed: rnd() * 1000 });
      obstacles.push({ x: x, y: y, r: r });
    }
    for (let i = 0; i < 400 && bushes.length < T.bushes; i++) {
      const x = rnd() * W, y = rnd() * H, r = 9 + rnd() * 6;
      if (!free(x, y, r, 5)) continue;
      bushes.push({ x: x, y: y, r: r, seed: rnd() * 1000 });
      obstacles.push({ x: x, y: y, r: r * 0.7 });
    }
    for (let i = 0; i < 400 && T.cacti && cacti.length < 9; i++) {
      const x = rnd() * W, y = rnd() * H, r = 9 + rnd() * 5;
      if (!free(x, y, r, 6)) continue;
      cacti.push({ x: x, y: y, r: r, arms: rnd() });
      obstacles.push({ x: x, y: y, r: r });
    }
    return { trees: trees, rocks: rocks, bushes: bushes, cacti: cacti };
  }

  function strokePath(g, L) {
    g.beginPath();
    g.moveTo(L.pts[0][0], L.pts[0][1]);
    for (let i = 1; i < L.pts.length; i++) g.lineTo(L.pts[i][0], L.pts[i][1]);
  }
  function strokeSpan(g, li, a, b) {
    g.beginPath();
    for (let d = a; d <= b; d += 4) { const p = posAt(d, li); g.lineTo(p.x, p.y); }
    const e = posAt(b, li); g.lineTo(e.x, e.y);
  }

  // A rosette of pointed leaves: the outline of one foliage layer.
  function leafRing(g, x, y, r, n, depth, rot) {
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const a0 = rot + (i / n) * Math.PI * 2, a1 = rot + ((i + 1) / n) * Math.PI * 2, am = (a0 + a1) / 2;
      const d = (a1 - a0) * 0.28;
      const v0 = r * (1 - depth);
      if (i === 0) g.moveTo(x + Math.cos(a0) * v0, y + Math.sin(a0) * v0);
      g.quadraticCurveTo(x + Math.cos(am - d) * r * 0.97, y + Math.sin(am - d) * r * 0.97, x + Math.cos(am) * r, y + Math.sin(am) * r);
      g.quadraticCurveTo(x + Math.cos(am + d) * r * 0.97, y + Math.sin(am + d) * r * 0.97, x + Math.cos(a1) * v0, y + Math.sin(a1) * v0);
    }
    g.closePath();
  }

  function drawFoliage(g, x, y, R, seed, layers) {
    const rnd = mulberry(Math.floor(seed));
    const pal = THEME.foliage;
    for (let k = 0; k < layers; k++) {
      const f = k / layers;
      const r = R * (1 - f * 0.8);
      const off = R * 0.14 * f; // inner layers sit up-left: reads as volume
      const cx = x + Math.cos(LIGHT) * off, cy = y + Math.sin(LIGHT) * off;
      const n = Math.max(7, Math.round(16 - k * 2.2));
      const rot = rnd() * Math.PI;
      leafRing(g, cx, cy, r, n, 0.16, rot);
      g.fillStyle = pal[Math.min(pal.length - 1, k + (layers < 5 ? 1 : 0))];
      g.fill();
      if (k === 0) { g.strokeStyle = THEME.foliageInk; g.lineWidth = 1.4; g.stroke(); }
      // leaf veins: short darker flicks just inside the edge of this layer
      g.strokeStyle = THEME.veins; g.lineWidth = 1.1; g.lineCap = 'round';
      for (let i = 0; i < n; i++) {
        const a = rot + ((i + 0.5) / n) * Math.PI * 2;
        g.beginPath();
        g.moveTo(cx + Math.cos(a) * r * 0.62, cy + Math.sin(a) * r * 0.62);
        g.lineTo(cx + Math.cos(a) * r * 0.85, cy + Math.sin(a) * r * 0.85);
        g.stroke();
      }
    }
  }

  function drawTreeShadow(g, t) {
    g.fillStyle = THEME.shadow;
    leafRing(g, t.x + t.r * 0.42, t.y + t.r * 0.36, t.r * 1.02, 16, 0.16, 0.3);
    g.fill();
  }

  function drawRock(g, r) {
    const rnd = mulberry(Math.floor(r.seed));
    const n = 7, pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rnd() * 0.5;
      const rr = r.r * (0.78 + rnd() * 0.27);
      pts.push([r.x + Math.cos(a) * rr, r.y + Math.sin(a) * rr * 0.82]);
    }
    // cast shadow
    g.fillStyle = THEME.shadow;
    g.beginPath(); pts.forEach(function (p) { g.lineTo(p[0] + r.r * 0.35, p[1] + r.r * 0.3); }); g.closePath(); g.fill();
    // faceted: fan of triangles from an off-centre peak, each lit by its facing
    const cx = r.x - r.r * 0.12, cy = r.y - r.r * 0.18;
    const dark = hexRgb(THEME.rock[0]), light = hexRgb(THEME.rock[1]);
    for (let i = 0; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      const am = Math.atan2((p[1] + q[1]) / 2 - cy, (p[0] + q[0]) / 2 - cx);
      const lit = 0.5 + 0.5 * Math.cos(am - LIGHT);
      const t = 0.15 + lit * 0.85;
      const col = 'rgb(' + dark.map(function (d, j) { return Math.round(d + (light[j] - d) * t); }).join(',') + ')';
      g.beginPath(); g.moveTo(cx, cy); g.lineTo(p[0], p[1]); g.lineTo(q[0], q[1]); g.closePath();
      g.fillStyle = col; g.fill();
      g.strokeStyle = col; g.lineWidth = 0.6; g.stroke();
    }
    g.beginPath(); pts.forEach(function (p) { g.lineTo(p[0], p[1]); }); g.closePath();
    g.strokeStyle = THEME.rock[2]; g.lineWidth = 1.2; g.lineJoin = 'round'; g.stroke();
    if (THEME.snow) { // snow cap on the lit side
      g.save(); g.beginPath(); pts.forEach(function (p) { g.lineTo(p[0], p[1]); }); g.closePath(); g.clip();
      g.fillStyle = '#ffffff'; ellipse(g, r.x - r.r * 0.35, r.y - r.r * 0.55, r.r * 0.9, r.r * 0.5, -0.3); g.fill();
      g.restore();
    }
  }

  function drawCactus(g, c) {
    const x = c.x, y = c.y, h = c.r * 2.2, w = c.r * 0.75;
    g.fillStyle = THEME.shadow; ellipse(g, x + 6, y + 3, w * 1.4, w * 0.6); g.fill();
    g.lineCap = 'round';
    function limb(x1, y1, x2, y2, lw) {
      g.strokeStyle = '#2f5a24'; g.lineWidth = lw + 3; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
      g.strokeStyle = '#5c9a3c'; g.lineWidth = lw; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
      g.strokeStyle = '#7dbb55'; g.lineWidth = lw * 0.35; g.beginPath(); g.moveTo(x1 - lw * 0.18, y1); g.lineTo(x2 - lw * 0.18, y2); g.stroke();
    }
    if (c.arms > 0.3) { limb(x - w * 0.5, y - h * 0.45, x - w * 1.5, y - h * 0.45, w * 0.7); limb(x - w * 1.5, y - h * 0.45, x - w * 1.5, y - h * 0.8, w * 0.7); }
    if (c.arms > 0.6) { limb(x + w * 0.5, y - h * 0.3, x + w * 1.4, y - h * 0.3, w * 0.7); limb(x + w * 1.4, y - h * 0.3, x + w * 1.4, y - h * 0.65, w * 0.7); }
    limb(x, y, x, y - h, w);
    g.fillStyle = '#ff7eb0'; circle(g, x, y - h - w * 0.35, w * 0.32); g.fill();
  }

  function drawLantern(g, x, y) {
    g.fillStyle = 'rgba(10,30,15,0.4)'; ellipse(g, x + 5, y + 3, 8, 3.5); g.fill();
    g.fillStyle = '#3b2a1e'; g.fillRect(x - 2.5, y - 26, 5, 27);
    g.fillStyle = '#5a4130'; g.fillRect(x - 2.5, y - 26, 2, 27);
    g.fillStyle = '#3b2a1e'; g.fillRect(x - 8, y - 32, 16, 3);
    roundRect(g, x - 6, y - 41, 12, 11, 2);
    g.fillStyle = '#ffd36b'; g.fill(); g.strokeStyle = '#2a1c12'; g.lineWidth = 2; g.stroke();
    g.fillStyle = '#fff2c2'; g.fillRect(x - 2, y - 39, 4, 6);
    g.fillStyle = '#3b2a1e'; g.beginPath(); g.moveTo(x - 8, y - 41); g.lineTo(x, y - 47); g.lineTo(x + 8, y - 41); g.closePath(); g.fill();
  }

  function drawLanePath(g, L, li, rnd) {
    const T = THEME;
    g.save(); g.translate(3, 4); strokePath(g, L);
    g.strokeStyle = T.shadow; g.lineWidth = PATH_HALF * 2 + 4; g.stroke();
    g.restore();
    strokePath(g, L);
    g.strokeStyle = T.pathEdge; g.lineWidth = PATH_HALF * 2 + 2; g.stroke();
    g.strokeStyle = T.pathFill; g.lineWidth = PATH_HALF * 2 - 6; g.stroke();
    for (let d = 0; d < L.len; d += 9) {
      const p = posAt(d, li), q = posAt(d + 1, li);
      let tx = q.x - p.x, ty = q.y - p.y;
      const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      for (let t = -PATH_HALF + 6; t <= PATH_HALF - 6; t += 9) {
        const jx = (rnd() - 0.5) * 3, jy = (rnd() - 0.5) * 3;
        const x = p.x - ty * t + jx, y = p.y + tx * t + jy;
        if (distToPath(x, y) > PATH_HALF - 4.5) continue;
        const rx = 3.8 + rnd() * 1.6, ry = 3.2 + rnd() * 1.4, rot = rnd() * 3;
        g.fillStyle = T.stoneShadow; ellipse(g, x + 0.9, y + 1.2, rx, ry, rot); g.fill();
        g.fillStyle = T.stones[Math.floor(rnd() * T.stones.length)]; ellipse(g, x, y, rx, ry, rot); g.fill();
        g.fillStyle = T.stoneHi; ellipse(g, x - rx * 0.3, y - ry * 0.35, rx * 0.4, ry * 0.3, rot); g.fill();
      }
    }
    // ground fringe spilling over the path edges
    for (let d = 0; d < L.len; d += 3.2) {
      const p = posAt(d, li), q = posAt(d + 1, li);
      let tx = q.x - p.x, ty = q.y - p.y;
      const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      [-1, 1].forEach(function (side) {
        const ex = p.x - ty * side * (PATH_HALF + 1), ey = p.y + tx * side * (PATH_HALF + 1);
        if (distToPath(ex, ey) < PATH_HALF - 1) return; // inside a corner
        const nx = ty * side, ny = -tx * side; // pointing into the path
        const h = 2.5 + rnd() * 3.5;
        g.fillStyle = rnd() < 0.5 ? T.fringe[0] : T.fringe[1];
        g.beginPath();
        g.moveTo(ex - tx * 2.2, ey - ty * 2.2);
        g.lineTo(ex + nx * h + tx * (rnd() - 0.5) * 2, ey - ny * -h + ty * (rnd() - 0.5) * 2);
        g.lineTo(ex + tx * 2.2, ey + ty * 2.2);
        g.closePath(); g.fill();
      });
    }
  }

  function buildBackground() {
    const T = THEME;
    const c = makeCanvas(W * DPR, H * DPR), g = c.getContext('2d');
    g.scale(DPR, DPR);
    const rnd = mulberry(4242 + MAP_ORDER.indexOf(mapId) * 31);
    g.lineCap = 'round'; g.lineJoin = 'round';

    // --- ground: base, low-contrast patches, thousands of small marks
    g.fillStyle = T.ground;
    g.fillRect(0, 0, W, H);
    for (let i = 0; i < 60; i++) {
      const x = rnd() * W, y = rnd() * H, r = 20 + rnd() * 55;
      g.fillStyle = T.patches[Math.floor(rnd() * 4)];
      g.beginPath();
      for (let j = 0; j < 10; j++) {
        const a = (j / 10) * Math.PI * 2, rr = r * (0.7 + rnd() * 0.4);
        g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr * 0.7);
      }
      g.closePath(); g.fill();
    }
    for (let i = 0; i < T.bladeN; i++) {
      const x = rnd() * W, y = rnd() * H, l = 2.5 + rnd() * 3;
      g.strokeStyle = rnd() < 0.55 ? T.blades[0] : T.blades[1];
      g.lineWidth = 1.1;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rnd() - 0.5) * 2.5, y - l); g.stroke();
    }
    if (T.snow) { // soft drifts
      for (let i = 0; i < 26; i++) {
        const x = rnd() * W, y = rnd() * H, r = 14 + rnd() * 26;
        if (distToPath(x, y) < PATH_HALF + r * 0.6) continue;
        g.fillStyle = 'rgba(120,160,200,0.18)'; ellipse(g, x + 3, y + 4, r, r * 0.45); g.fill();
        g.fillStyle = '#f7fbfe'; ellipse(g, x, y, r, r * 0.45); g.fill();
      }
    }
    if (T.clovers) {
      for (let i = 0; i < 70; i++) {
        const x = rnd() * W, y = rnd() * H;
        if (distToPath(x, y) < PATH_HALF + 6) continue;
        const rot = rnd() * Math.PI * 2, sz = 2 + rnd() * 1.2;
        g.fillStyle = T.shadow;
        for (let j = 0; j < 3; j++) { const a = rot + j * 2.094; circle(g, x + 1 + Math.cos(a) * sz, y + 1.5 + Math.sin(a) * sz, sz); g.fill(); }
        g.fillStyle = '#3f9a2b';
        for (let j = 0; j < 3; j++) { const a = rot + j * 2.094; circle(g, x + Math.cos(a) * sz, y + Math.sin(a) * sz, sz); g.fill(); }
        g.fillStyle = '#5cb83f';
        for (let j = 0; j < 3; j++) { const a = rot + j * 2.094; circle(g, x + Math.cos(a) * sz - 0.5, y + Math.sin(a) * sz - 0.5, sz * 0.5); g.fill(); }
      }
    }
    if (T.flowers) { // little white flowers with yellow centres
      for (let i = 0; i < 85; i++) {
        const x = rnd() * W, y = rnd() * H;
        if (distToPath(x, y) < PATH_HALF + 6) continue;
        const sz = 2 + rnd() * 1.3, rot = rnd() * 6;
        g.fillStyle = T.shadow; circle(g, x + 1.2, y + 1.6, sz * 1.6); g.fill();
        g.fillStyle = '#ffffff';
        for (let j = 0; j < 5; j++) { const a = rot + j * 1.2566; ellipse(g, x + Math.cos(a) * sz, y + Math.sin(a) * sz, sz * 0.85, sz * 0.6, a); g.fill(); }
        g.fillStyle = '#ffcf3a'; circle(g, x, y, sz * 0.55); g.fill();
      }
    }
    if (T.mushrooms) { // small glowing mushrooms
      for (let i = 0; i < 45; i++) {
        const x = rnd() * W, y = rnd() * H;
        if (distToPath(x, y) < PATH_HALF + 8) continue;
        const sz = 2.5 + rnd() * 2, col = T.specks[Math.floor(rnd() * 2)];
        g.fillStyle = T.shadow; ellipse(g, x + 2, y + 2, sz * 1.3, sz * 0.6); g.fill();
        g.fillStyle = '#e8e2cf'; g.fillRect(x - sz * 0.25, y - sz * 0.6, sz * 0.5, sz * 0.9);
        g.fillStyle = col; ellipse(g, x, y - sz * 0.7, sz, sz * 0.6); g.fill();
        g.fillStyle = 'rgba(255,255,255,0.7)'; circle(g, x - sz * 0.35, y - sz * 0.9, sz * 0.22); g.fill();
      }
    }
    for (let i = 0; i < 45; i++) {
      const x = rnd() * W, y = rnd() * H;
      if (distToPath(x, y) < PATH_HALF + 6) continue;
      for (let j = 0; j < 3; j++) {
        g.fillStyle = T.specks[Math.floor(rnd() * T.specks.length)];
        circle(g, x + (rnd() - 0.5) * 10, y + (rnd() - 0.5) * 10, 1.1); g.fill();
      }
    }
    // small flat pebbles
    for (let i = 0; i < 40; i++) {
      const x = rnd() * W, y = rnd() * H;
      if (distToPath(x, y) < PATH_HALF + 6) continue;
      g.save(); g.translate(x, y); g.rotate(rnd() * 3);
      g.fillStyle = T.shadow; g.fillRect(-2.5, -1.5, 6, 5);
      g.fillStyle = T.pebbles[0]; g.fillRect(-3, -2.5, 6, 5);
      g.fillStyle = T.pebbles[1]; g.fillRect(-3, -2.5, 6, 1.6);
      g.restore();
    }

    // --- pond (frozen on the lake map)
    const pd = MAP.pond;
    if (pd) {
      g.fillStyle = T.shadow; ellipse(g, pd.x + 4, pd.y + 5, pd.rx + 5, pd.ry + 5); g.fill();
      if (pd.frozen) {
        g.fillStyle = '#93abc0'; ellipse(g, pd.x, pd.y, pd.rx + 4, pd.ry + 4); g.fill();
        g.fillStyle = '#a9d8ef'; ellipse(g, pd.x, pd.y, pd.rx, pd.ry); g.fill();
        g.fillStyle = '#c4e7f7'; ellipse(g, pd.x + 3, pd.y + 4, pd.rx * 0.86, pd.ry * 0.86); g.fill();
        g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 2;
        [[-20, -30, 14, -48], [6, 10, 26, -6], [-14, 30, 2, 46]].forEach(function (l) {
          g.beginPath(); g.moveTo(pd.x + l[0], pd.y + l[1]); g.lineTo(pd.x + l[2], pd.y + l[3]); g.stroke();
        });
        g.strokeStyle = 'rgba(80,130,170,0.5)'; g.lineWidth = 1.2;
        g.beginPath(); g.moveTo(pd.x - 30, pd.y + 6); g.lineTo(pd.x - 8, pd.y - 2); g.lineTo(pd.x + 4, pd.y + 14); g.lineTo(pd.x + 28, pd.y + 8); g.stroke();
      } else {
        g.fillStyle = '#8b7a4e'; ellipse(g, pd.x, pd.y, pd.rx + 4, pd.ry + 4); g.fill();
        g.fillStyle = '#2f86b8'; ellipse(g, pd.x, pd.y, pd.rx, pd.ry); g.fill();
        g.fillStyle = '#4aa6d6'; ellipse(g, pd.x + 3, pd.y + 4, pd.rx * 0.86, pd.ry * 0.86); g.fill();
        g.fillStyle = '#6fc0e8'; ellipse(g, pd.x + 6, pd.y + 8, pd.rx * 0.55, pd.ry * 0.55); g.fill();
        g.strokeStyle = 'rgba(255,255,255,0.75)'; g.lineWidth = 2;
        [[-12, -26, 8], [12, 6, 6], [-4, 28, 5]].forEach(function (w) {
          g.beginPath(); g.moveTo(pd.x + w[0] - w[2], pd.y + w[1]); g.lineTo(pd.x + w[0] + w[2], pd.y + w[1]); g.stroke();
        });
        [[-20, 30, 8], [16, -36, 7]].forEach(function (l) {
          const x = pd.x + l[0], y = pd.y + l[1];
          g.fillStyle = 'rgba(10,50,80,0.35)'; g.beginPath(); g.moveTo(x + 1.5, y + 2); g.arc(x + 1.5, y + 2, l[2], 0.5, Math.PI * 2); g.closePath(); g.fill();
          g.fillStyle = '#4f9e34'; g.beginPath(); g.moveTo(x, y); g.arc(x, y, l[2], 0.5, Math.PI * 2); g.closePath(); g.fill();
          g.fillStyle = '#69b94a'; g.beginPath(); g.moveTo(x, y); g.arc(x - 1, y - 1, l[2] * 0.6, 0.5, Math.PI * 2); g.closePath(); g.fill();
        });
        g.fillStyle = '#ffffff'; circle(g, pd.x + 16, pd.y - 36, 2.6); g.fill();
        g.fillStyle = '#ff8fc8'; circle(g, pd.x + 16, pd.y - 36, 1.2); g.fill();
      }
    }

    // --- lantern light pools (under the path so the lit track shows too)
    (MAP.lanterns || []).forEach(function (l) {
      g.fillStyle = 'rgba(255,214,120,0.16)'; circle(g, l[0], l[1], LANTERN_R); g.fill();
    });

    // --- paths
    LANES.forEach(function (L, li) { drawLanePath(g, L, li, rnd); });

    // --- ice stretches: glassy blue over the path, with glints
    LANES.forEach(function (L, li) {
      L.ice.forEach(function (sp) {
        strokeSpan(g, li, sp[0] + 4, sp[1] - 4);
        g.lineCap = 'butt';
        g.strokeStyle = '#7fb8da'; g.lineWidth = PATH_HALF * 2 - 2; g.stroke();
        g.strokeStyle = '#a9daf3'; g.lineWidth = PATH_HALF * 2 - 8; g.stroke();
        g.lineCap = 'round';
        for (let d = sp[0] + 14; d < sp[1] - 10; d += 26) {
          const p = posAt(d, li);
          g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = 2;
          g.beginPath(); g.moveTo(p.x - 8, p.y + 6); g.lineTo(p.x + 6, p.y - 8); g.stroke();
          g.beginPath(); g.moveTo(p.x - 1, p.y + 9); g.lineTo(p.x + 8, p.y); g.stroke();
        }
      });
    });

    // --- tunnels: a rock ridge over the path with dark mouths at each end
    LANES.forEach(function (L, li) {
      L.tunnels.forEach(function (sp) {
        [sp[0], sp[1]].forEach(function (d) {
          const p = posAt(d, li);
          g.fillStyle = '#2a170e'; circle(g, p.x, p.y, PATH_HALF + 1); g.fill();
        });
        g.lineCap = 'butt';
        g.save(); g.translate(4, 5); strokeSpan(g, li, sp[0], sp[1]);
        g.strokeStyle = T.shadow; g.lineWidth = PATH_HALF * 2 + 26; g.stroke(); g.restore();
        strokeSpan(g, li, sp[0], sp[1]);
        g.strokeStyle = T.rock[2]; g.lineWidth = PATH_HALF * 2 + 28; g.stroke();
        g.strokeStyle = T.rock[0]; g.lineWidth = PATH_HALF * 2 + 22; g.stroke();
        g.save(); g.translate(-2, -3); strokeSpan(g, li, sp[0] + 3, sp[1] - 3);
        g.strokeStyle = '#b8764c'; g.lineWidth = PATH_HALF * 2 + 8; g.stroke(); g.restore();
        g.lineCap = 'round';
        g.strokeStyle = 'rgba(60,30,15,0.45)'; g.lineWidth = 1.5;
        for (let d = sp[0] + 16; d < sp[1] - 12; d += 22) {
          const p = posAt(d, li);
          g.beginPath(); g.moveTo(p.x - 6, p.y - 10); g.lineTo(p.x + 2, p.y - 2); g.lineTo(p.x - 3, p.y + 8); g.stroke();
        }
      });
    });

    // --- rocks, bushes, cacti, then trees on top with their shadows
    scenery.rocks.forEach(function (r) { drawRock(g, r); });
    scenery.bushes.forEach(function (b) {
      g.fillStyle = T.shadow;
      leafRing(g, b.x + b.r * 0.4, b.y + b.r * 0.35, b.r, 10, 0.18, 0.2); g.fill();
      drawFoliage(g, b.x, b.y, b.r, b.seed, 3);
    });
    scenery.cacti.forEach(function (c2) { drawCactus(g, c2); });
    (MAP.lanterns || []).forEach(function (l) { drawLantern(g, l[0], l[1]); });
    scenery.trees.forEach(function (t) { drawTreeShadow(g, t); });
    scenery.trees.forEach(function (t) { drawFoliage(g, t.x, t.y, t.r, t.seed, 6); });
    return c;
  }

  // Misty Hollow: a pale fog layer drawn over the action, with clear holes around lanterns.
  function buildFog() {
    if (!MAP.lanterns) return null;
    const c = makeCanvas(W * DPR, H * DPR), g = c.getContext('2d');
    g.scale(DPR, DPR);
    g.fillStyle = 'rgba(205,220,228,0.40)'; g.fillRect(0, 0, W, H);
    const rnd = mulberry(77);
    for (let i = 0; i < 45; i++) {
      g.fillStyle = 'rgba(240,246,250,0.12)';
      ellipse(g, rnd() * W, rnd() * H, 40 + rnd() * 90, 18 + rnd() * 30); g.fill();
    }
    g.globalCompositeOperation = 'destination-out';
    MAP.lanterns.forEach(function (l) {
      const gr = g.createRadialGradient(l[0], l[1], LANTERN_R * 0.45, l[0], l[1], LANTERN_R);
      gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; circle(g, l[0], l[1], LANTERN_R); g.fill();
    });
    g.globalCompositeOperation = 'source-over';
    return c;
  }

  let scenery = buildScenery();
  let background = buildBackground();
  let fog = buildFog();

  // The map and the fog never change during play, so they sit on their own canvases
  // (under and over the game canvas) and the browser composites them for free,
  // instead of being re-copied onto the game canvas every frame.
  const bgLayer = document.getElementById('td-bg');
  const fogLayer = document.getElementById('td-fogc');
  function paintLayers() {
    [bgLayer, fogLayer].forEach(function (c) { c.width = W * DPR; c.height = H * DPR; });
    bgLayer.getContext('2d').drawImage(background, 0, 0);
    if (fog) fogLayer.getContext('2d').drawImage(fog, 0, 0);
    fogLayer.style.display = fog ? '' : 'none';
  }
  paintLayers();

  // Swap in another map: its own lanes, scenery and saved progress.
  function loadMap(id) {
    mapId = id; MAP = MAPS[id]; LANES = buildLanes(MAP); THEME = THEMES[MAP.theme];
    obstacles.length = 0;
    scenery = buildScenery(); background = buildBackground(); fog = buildFog();
    paintLayers();
    game = normalizeGame(saved.maps[id]);
    enemies = []; projectiles = []; piles = []; effects = []; particles = []; spawnQueue = [];
    running = false; gameOver = false; selected = null; placing = null;
    towers = [];
    towers = game.towers.filter(function (t) { return TOWERS[t.type]; }).map(makeTower);
    refreshAll();
    nextTowerId = towers.reduce(function (m, t) { return Math.max(m, t.id); }, 0) + 1;
  }

  // ------------------------------------------------------------ enemy sprites
  // gumdrop-shaped slime, flat bottom
  function slimePath(g, r) {
    g.beginPath();
    g.moveTo(0, -r);
    g.bezierCurveTo(r * 0.6, -r, r * 1.05, -r * 0.25, r * 1.03, r * 0.35);
    g.bezierCurveTo(r * 1.02, r * 0.82, r * 0.62, r * 0.9, 0, r * 0.9);
    g.bezierCurveTo(-r * 0.62, r * 0.9, -r * 1.02, r * 0.82, -r * 1.03, r * 0.35);
    g.bezierCurveTo(-r * 1.05, -r * 0.25, -r * 0.6, -r, 0, -r);
    g.closePath();
  }

  const PRISM_COLS = ['#ef5b5b', '#f6a33b', '#f7d94c', '#6cc47a', '#4fa8e0', '#9b7be0'];
  const enemySprites = {};
  const ENEMY_ART = { 7: 'slime_iron', 8: 'slime_prism', 9: 'slime_stone', 10: 'slime_behemoth', 11: 'slime_colossus' };
  function enemyArtKey(tier) { return ENEMY_ART[tier] || 'slime_base'; }

  // painted slime: special tiers have their own art, the rest tint the white base slime
  function enemyArtSprite(tier, im) {
    const d = ENEMIES[tier], r = d.r;
    const size = r * (d.heavy ? 2.5 : 2.3);
    const px = Math.ceil(size * SPR);
    const cv = makeCanvas(px, px), g = cv.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(im, 0, 0, px, px);
    if (!ENEMY_ART[tier]) {
      g.globalCompositeOperation = 'multiply';
      g.fillStyle = d.color;
      g.fillRect(0, 0, px, px);
      g.globalCompositeOperation = 'destination-in';
      g.drawImage(im, 0, 0, px, px);
      // bring back a little of the jelly shine that the multiply flattened
      g.globalCompositeOperation = 'source-atop';
      g.globalAlpha = 0.22;
      g.drawImage(im, 0, 0, px, px);
    }
    return { cv: cv, size: size, sh: silhouette(cv), art: true,
      flash: tintedSilhouette(cv, '#ffffff'), ice: tintedSilhouette(cv, '#bfe8ff') };
  }

  function enemySprite(tier) {
    if (enemySprites[tier]) return enemySprites[tier];
    const im = art(enemyArtKey(tier));
    if (im) return (enemySprites[tier] = enemyArtSprite(tier, im));
    const d = ENEMIES[tier], r = d.r;
    const pad = d.heavy ? 18 : 6, size = (r + pad) * 2;
    const cv = makeCanvas(size * SPR, size * SPR), g = cv.getContext('2d');
    g.scale(SPR, SPR); g.translate(size / 2, size / 2);
    g.lineCap = 'round'; g.lineJoin = 'round';
    const lw = d.heavy ? 3 : LW;
    const base = d.color === 'prism' ? '#9b7be0' : (d.metal ? '#a7abb2' : d.color);
    const ox = -r * 0.16, oy = -r * 0.2;

    if (d.heavy) {
      [-1, 1].forEach(function (s) {
        flat(g, function () {
          g.beginPath(); g.moveTo(s * r * 0.3, -r * 0.78);
          g.quadraticCurveTo(s * r * 0.7, -r * 1.4, s * r * 1.0, -r * 1.15);
          g.quadraticCurveTo(s * r * 0.75, -r * 0.95, s * r * 0.7, -r * 0.55);
          g.closePath();
        }, '#efe6cf', '#cfc2a2', -1, -1.5, lw);
      });
    }

    if (d.color === 'prism') {
      // flat stripes clipped to the body
      flat(g, function () { slimePath(g, r); }, base, null, 0, 0, 0);
      g.save(); slimePath(g, r); g.clip();
      PRISM_COLS.forEach(function (c, i) {
        g.fillStyle = c;
        g.fillRect(-r * 1.1, -r + (i * 2 * r) / PRISM_COLS.length, r * 2.2, (2 * r) / PRISM_COLS.length + 0.5);
      });
      g.fillStyle = 'rgba(43,34,51,0.22)';
      g.beginPath(); g.rect(-r * 2, -r * 2, r * 4, r * 4);
      g.save(); g.translate(ox, oy); slimePath(g, r); g.restore();
      g.fill('evenodd');
      g.restore();
      slimePath(g, r); g.strokeStyle = '#3b2a5c'; g.lineWidth = lw; g.stroke();
    } else {
      flat(g, function () { slimePath(g, r); }, base, shade(base, d.metal ? -0.25 : -0.22), ox, oy, lw);
    }

    g.save(); slimePath(g, r); g.clip();
    g.strokeStyle = INK; g.fillStyle = INK;
    if (d.metal) {
      g.lineWidth = 1.3;
      g.beginPath(); g.moveTo(-r, r * 0.12); g.quadraticCurveTo(0, r * 0.32, r, r * 0.12); g.stroke();
      g.beginPath(); g.moveTo(0, -r); g.lineTo(0, -r * 0.45); g.stroke();
      for (let i = 0; i < 5; i++) {
        const x = -r * 0.6 + i * r * 0.3;
        circle(g, x, r * 0.22 + Math.abs(x) * -0.15 + r * 0.03, 1.2); g.fill();
      }
    }
    if (tier === 9) {
      const rr = mulberry(9);
      g.fillStyle = shade(base, -0.18);
      for (let i = 0; i < 6; i++) {
        ellipse(g, (rr() - 0.5) * r * 1.5, (rr() - 0.5) * r * 1.4, 2 + rr() * 2.5, 1.5 + rr() * 2, rr() * 3); g.fill();
      }
    }
    if (d.heavy) {
      // riveted belt
      g.fillStyle = '#8d929b';
      g.fillRect(-r * 1.1, r * 0.1, r * 2.2, r * 0.34);
      g.fillStyle = '#6f747c';
      g.fillRect(-r * 1.1, r * 0.33, r * 2.2, r * 0.11);
      g.lineWidth = 2;
      g.beginPath(); g.moveTo(-r * 1.1, r * 0.1); g.lineTo(r * 1.1, r * 0.1); g.moveTo(-r * 1.1, r * 0.44); g.lineTo(r * 1.1, r * 0.44); g.stroke();
      for (let i = -4; i <= 4; i++) { g.fillStyle = INK; circle(g, i * r * 0.22, r * 0.25, 1.6); g.fill(); }
    }
    g.restore();

    // shine flick
    shine(g, -r * 0.05, -r * 0.05, r * 0.68, Math.PI * 1.15, Math.PI * 1.42);

    const vec = { cv: cv, size: size, sh: silhouette(cv) };
    // only keep the vector version if no painted art is still on its way
    if (!ART[enemyArtKey(tier)]) enemySprites[tier] = vec;
    return vec;
  }

  function drawFace(g, e) {
    const d = e.def, r = d.r;
    const lx = Math.cos(e.dir) * r * 0.06, ly = Math.sin(e.dir) * r * 0.05;
    const ey = -r * 0.02, ex = r * 0.3;
    const blink = ((time + e.wob * 3) % 3.7) < 0.12;
    g.lineCap = 'round';
    if (d.heavy) {
      [-1, 1].forEach(function (s) {
        g.fillStyle = '#ffdf5a'; g.strokeStyle = INK; g.lineWidth = 2;
        g.beginPath();
        g.moveTo(s * ex * 0.45 + lx, ey - r * 0.04 + ly);
        g.lineTo(s * ex * 1.55 + lx, ey - r * 0.14 + ly);
        g.lineTo(s * ex * 1.25 + lx, ey + r * 0.1 + ly);
        g.closePath(); g.fill(); g.stroke();
        g.fillStyle = INK; circle(g, s * ex + lx, ey + ly, r * 0.045); g.fill();
      });
      g.strokeStyle = INK; g.lineWidth = 2.5;
      g.beginPath(); g.moveTo(-r * 0.25, r * 0.0); g.lineTo(-r * 0.08, -r * 0.05); g.lineTo(r * 0.08, -r * 0.05); g.lineTo(r * 0.25, 0); g.stroke();
      return;
    }
    const er = Math.max(1.8, r * 0.13);
    [-1, 1].forEach(function (s) {
      const x = s * ex + lx, y = ey + ly;
      if (blink) {
        g.strokeStyle = INK; g.lineWidth = 1.6;
        g.beginPath(); g.moveTo(x - er, y); g.lineTo(x + er, y); g.stroke();
        return;
      }
      g.fillStyle = INK; ellipse(g, x, y, er, er * 1.35); g.fill();
      g.fillStyle = '#ffffff'; circle(g, x - er * 0.3, y - er * 0.5, er * 0.38); g.fill();
    });
    if (e.tier >= 5) {
      g.strokeStyle = INK; g.lineWidth = 1.6;
      [-1, 1].forEach(function (s) {
        g.beginPath(); g.moveTo(s * ex * 1.6 + lx, ey - er * 2.1); g.lineTo(s * ex * 0.5 + lx, ey - er * 1.5); g.stroke();
      });
    }
    g.strokeStyle = INK; g.lineWidth = 1.3;
    g.beginPath();
    if (e.tier >= 5) { g.moveTo(-r * 0.12 + lx, r * 0.36); g.lineTo(r * 0.12 + lx, r * 0.36); }
    else g.arc(lx, r * 0.24, r * 0.13, 0.2 * Math.PI, 0.8 * Math.PI);
    g.stroke();
  }

  // markers for special slimes, drawn over the sprite
  function drawEnemyMarks(g, e) {
    const r = e.def.r * ENEMY_SCALE;
    if (e.shield > 0) {
      g.save(); g.globalAlpha = e.phased ? 0.3 : 0.9;
      g.strokeStyle = '#2b2233'; g.lineWidth = 5; circle(g, e.x, e.y, r + 5); g.stroke();
      g.strokeStyle = '#8fe3ff'; g.lineWidth = 3; circle(g, e.x, e.y, r + 5); g.stroke();
      for (let i = 0; i < e.shield; i++) {
        g.fillStyle = '#8fe3ff'; circle(g, e.x - (e.shield - 1) * 4 + i * 8, e.y - r - 10, 3); g.fill();
        g.strokeStyle = '#2b2233'; g.lineWidth = 1.2; g.stroke();
      }
      g.restore();
    }
    if (e.def.healer && !e.phased) {
      const y = e.y - r - 12 + Math.sin(time * 4 + e.wob) * 1.5;
      g.fillStyle = '#2b2233'; g.fillRect(e.x - 5.5, y - 2.5, 11, 5); g.fillRect(e.x - 2.5, y - 5.5, 5, 11);
      g.fillStyle = '#ff7eb6'; g.fillRect(e.x - 4, y - 1.2, 8, 2.4); g.fillRect(e.x - 1.2, y - 4, 2.4, 8);
    }
  }

  function drawEnemy(g, e) {
    const d = e.def, r = d.r;
    const sp = enemySprite(e.tier);
    const age = time - e.bornT;
    const pop = (age < 0.16 ? 0.65 + 0.35 * easeOutBack(Math.min(1, age / 0.16)) : 1) * ENEMY_SCALE;
    const ph = Math.sin(time * 9 + e.wob);
    const blown = e.kb > 0;
    const sq = blown ? 0.14 : d.heavy ? Math.sin(time * 3 + e.wob) * 0.025 : ph * 0.08;
    const hop = blown || d.heavy ? 0 : Math.max(0, ph) * 3;
    // cast shadow stays on the ground while the slime hops
    g.save();
    g.globalAlpha = 0.26;
    g.translate(e.x + r * 0.38 + hop * 0.6, e.y + r * 0.42 + hop * 0.4);
    g.scale(pop, pop * 0.9);
    g.drawImage(sp.sh, -sp.size / 2, -sp.size / 2, sp.size, sp.size);
    g.restore();
    g.save();
    g.translate(e.x, e.y + r * 0.9 - hop);
    g.scale(pop * (1 + sq), pop * (1 - sq));
    g.translate(0, -r * 0.9);
    g.drawImage(sp.cv, -sp.size / 2, -sp.size / 2, sp.size, sp.size);
    if (!sp.art) drawFace(g, e);
    if (e.tier === 9 && e.hp < e.maxHp) {
      g.strokeStyle = INK; g.lineWidth = 1.5; g.lineCap = 'round';
      const cracks = Math.ceil((1 - e.hp / e.maxHp) * 5);
      for (let i = 0; i < cracks; i++) {
        const a = i * 1.25 + 0.5;
        g.beginPath(); g.moveTo(Math.cos(a) * r * 0.45, Math.sin(a) * r * 0.4);
        g.lineTo(Math.cos(a + 0.25) * r * 0.7, Math.sin(a + 0.25) * r * 0.6);
        g.lineTo(Math.cos(a) * r * 0.95, Math.sin(a) * r * 0.8);
        g.stroke();
      }
    }
    if (time < e.slowUntil && sp.art) {
      g.save(); g.globalAlpha = 0.5;
      g.drawImage(sp.ice, -sp.size / 2, -sp.size / 2, sp.size, sp.size);
      g.restore();
      [[-0.6, -0.75], [0.7, -0.5]].forEach(function (p) {
        g.save(); g.translate(p[0] * r, p[1] * r);
        g.fillStyle = '#eaf7ff'; g.strokeStyle = INK; g.lineWidth = 1;
        g.beginPath(); g.moveTo(0, -3.5); g.lineTo(2, 0); g.lineTo(0, 3.5); g.lineTo(-2, 0); g.closePath(); g.fill(); g.stroke();
        g.restore();
      });
    } else if (time < e.slowUntil) {
      g.save(); slimePath(g, r); g.clip();
      g.fillStyle = 'rgba(190,232,255,0.5)'; g.fillRect(-r * 1.2, -r * 1.2, r * 2.4, r * 2.4);
      g.restore();
      g.strokeStyle = '#4fa3c9'; g.lineWidth = 1.6;
      slimePath(g, r + 1.5); g.stroke();
      [[-0.6, -0.75], [0.7, -0.5]].forEach(function (p) {
        g.save(); g.translate(p[0] * r, p[1] * r);
        g.fillStyle = '#eaf7ff'; g.strokeStyle = INK; g.lineWidth = 1;
        g.beginPath(); g.moveTo(0, -3.5); g.lineTo(2, 0); g.lineTo(0, 3.5); g.lineTo(-2, 0); g.closePath(); g.fill(); g.stroke();
        g.restore();
      });
    }
    const hit = time - e.hitT;
    if (hit < 0.07 && sp.art) {
      g.save(); g.globalAlpha = 0.65;
      g.drawImage(sp.flash, -sp.size / 2, -sp.size / 2, sp.size, sp.size);
      g.restore();
    } else if (hit < 0.07) {
      g.save(); slimePath(g, r); g.clip();
      g.fillStyle = 'rgba(255,255,255,0.65)'; g.fillRect(-r * 1.2, -r * 1.2, r * 2.4, r * 2.4);
      g.restore();
    }
    g.restore();
    if (d.hp > 2 && e.hp < e.maxHp && !d.heavy) {
      const w = Math.max(22, r * 2);
      g.fillStyle = INK; roundRect(g, e.x - w / 2 - 1.5, e.y - r * ENEMY_SCALE - 12, w + 3, 7, 3.5); g.fill();
      g.fillStyle = '#7bd35f'; roundRect(g, e.x - w / 2, e.y - r * ENEMY_SCALE - 10.5, Math.max(2, w * Math.max(0, e.hp / e.maxHp)), 4, 2); g.fill();
    }
  }

  // ------------------------------------------------------------ tower sprites
  const BASE_STYLE = { archer: 'wood', frost: 'ice', cannon: 'stone', trapper: 'crate', sniper: 'sand',
    tesla: 'metal', arcanist: 'rune', titan: 'gold', boomer: 'sand', pyro: 'stone', gust: 'ice', bard: 'wood' };
  const baseSprites = {};
  function baseSprite(type) {
    if (baseSprites[type]) return baseSprites[type];
    const size = 58, cv = makeCanvas(size * SPR, size * SPR), g = cv.getContext('2d');
    g.scale(SPR, SPR); g.translate(size / 2, size / 2);
    g.lineCap = 'round'; g.lineJoin = 'round';
    const st = BASE_STYLE[type];
    if (st === 'wood') {
      flat(g, function () { circle(g, 0, 0, 19); }, '#c08850', '#9a6a3c', -2, -3);
      g.save(); circle(g, 0, 0, 19); g.clip();
      g.strokeStyle = 'rgba(43,34,51,0.4)'; g.lineWidth = 1.3;
      for (let x = -12; x <= 12; x += 8) { g.beginPath(); g.moveTo(x, -20); g.lineTo(x, 20); g.stroke(); }
      g.restore();
    } else if (st === 'stone') {
      flat(g, function () { poly(g, 8, 20, Math.PI / 8); }, '#b4b0a8', '#8f8a82', -2, -3);
      g.strokeStyle = 'rgba(43,34,51,0.4)'; g.lineWidth = 1.2;
      [[-18, -5, 18, -5], [-18, 7, 18, 7], [-5, -18, -5, -5], [8, -5, 8, 7], [-1, 7, -1, 18]].forEach(function (l) {
        g.beginPath(); g.moveTo(l[0], l[1]); g.lineTo(l[2], l[3]); g.stroke();
      });
    } else if (st === 'ice') {
      flat(g, function () { poly(g, 6, 20, Math.PI / 6); }, '#d6f0fb', '#a8d8ee', -2, -3);
      g.strokeStyle = 'rgba(79,163,201,0.6)'; g.lineWidth = 1.2;
      for (let i = 0; i < 6; i += 2) {
        const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
        g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.cos(a) * 18, Math.sin(a) * 18); g.stroke();
      }
    } else if (st === 'crate') {
      flat(g, function () { roundRect(g, -19, -19, 38, 38, 4); }, '#c99358', '#a3713d', -2, -3);
      g.strokeStyle = INK; g.lineWidth = 1.6;
      g.beginPath(); g.rect(-13, -13, 26, 26); g.stroke();
      g.beginPath(); g.moveTo(-13, -13); g.lineTo(13, 13); g.stroke();
    } else if (st === 'sand') {
      g.fillStyle = '#7a6440'; circle(g, 0, 0, 14); g.fill();
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2;
        g.save(); g.translate(Math.cos(a) * 16, Math.sin(a) * 16); g.rotate(a + Math.PI / 2);
        flat(g, function () { ellipse(g, 0, 0, 7, 4.6); }, '#dcc58f', '#bfa56c', -1, -1.5, 1.8);
        g.restore();
      }
    } else if (st === 'metal') {
      flat(g, function () { roundRect(g, -19, -19, 38, 38, 9); }, '#a7adb5', '#80868f', -2, -3);
      g.fillStyle = INK;
      [[-13, -13], [13, -13], [-13, 13], [13, 13]].forEach(function (p) { circle(g, p[0], p[1], 1.6); g.fill(); });
      g.fillStyle = '#f2b632';
      g.save(); roundRect(g, -19, -19, 38, 38, 9); g.clip();
      for (let i = -19; i < 19; i += 7) { g.beginPath(); g.moveTo(i, 19); g.lineTo(i + 3.5, 14); g.lineTo(i + 7, 14); g.lineTo(i + 3.5, 19); g.closePath(); g.fill(); }
      g.restore();
    } else if (st === 'rune') {
      flat(g, function () { circle(g, 0, 0, 20); }, '#6a5c8a', '#54486f', -2, -3);
      g.strokeStyle = 'rgba(43,34,51,0.5)'; g.lineWidth = 1.2;
      circle(g, 0, 0, 14); g.stroke();
    } else if (st === 'gold') {
      flat(g, function () { poly(g, 6, 21, 0); }, '#f0c03c', '#c9971c', -2, -3);
      flat(g, function () { poly(g, 6, 15, 0); }, '#a7adb5', '#80868f', -1.5, -2, 1.8);
    }
    baseSprites[type] = { cv: cv, size: size, sh: silhouette(cv) };
    return baseSprites[type];
  }

  function recoilOf(t, dur) {
    if (t.fireT == null) return 0;
    return Math.max(0, 1 - (time - t.fireT) / (dur || 0.18));
  }

  // an outlined stroke: ink underneath, colour on top
  function inkLine(g, w, color, build) {
    build(); g.strokeStyle = INK; g.lineWidth = w + 2.4; g.stroke();
    build(); g.strokeStyle = color; g.lineWidth = w; g.stroke();
  }

  function drawCrossbow(g, rec) {
    const pull = 7 * (1 - rec);
    flat(g, function () { roundRect(g, -4, -2.8, 22, 5.6, 2); }, '#8a5a2b', '#6b4220', 0, -1, 1.8);
    inkLine(g, 2.6, '#e6c48a', function () { g.beginPath(); g.moveTo(12, -13); g.quadraticCurveTo(20, 0, 12, 13); });
    g.strokeStyle = INK; g.lineWidth = 1;
    g.beginPath(); g.moveTo(12, -13); g.lineTo(13 - pull, 0); g.lineTo(12, 13); g.stroke();
    if (rec < 0.25) {
      g.strokeStyle = '#6b4220'; g.lineWidth = 1.8;
      g.beginPath(); g.moveTo(13 - pull, 0); g.lineTo(22, 0); g.stroke();
      g.fillStyle = '#e8e8e8'; g.strokeStyle = INK; g.lineWidth = 1;
      g.beginPath(); g.moveTo(21, -2.4); g.lineTo(26.5, 0); g.lineTo(21, 2.4); g.closePath(); g.fill(); g.stroke();
    }
  }

  function drawGear(g, r, teeth, rot) {
    g.save(); g.rotate(rot);
    flat(g, function () {
      g.beginPath();
      for (let i = 0; i < teeth * 2; i++) {
        const a0 = (i / (teeth * 2)) * Math.PI * 2, a1 = ((i + 1) / (teeth * 2)) * Math.PI * 2, rr = i % 2 ? r * 0.76 : r;
        g.lineTo(Math.cos(a0) * rr, Math.sin(a0) * rr);
        g.lineTo(Math.cos(a1) * rr, Math.sin(a1) * rr);
      }
      g.closePath();
    }, '#b4b8bf', '#8d929b', -1, -1.5, 1.8);
    g.fillStyle = INK; circle(g, 0, 0, r * 0.25); g.fill();
    g.restore();
  }

  function drawTop(g, t) {
    const s = t.s;
    g.lineCap = 'round'; g.lineJoin = 'round';
    switch (t.type) {
      case 'archer': {
        const rec = recoilOf(t, 0.25);
        g.rotate(t.angle);
        flat(g, function () { circle(g, 0, 0, 9.5); }, '#a8723f', '#865a2f', -1.5, -2);
        const bows = s.shots > 1 ? [-0.38, 0, 0.38] : [0];
        bows.forEach(function (a) { g.save(); g.rotate(a); drawCrossbow(g, rec); g.restore(); });
        flat(g, function () { circle(g, -2, 0, 3.4); }, '#e05252', '#b83a3a', -0.5, -0.8, 1.4);
        break;
      }
      case 'frost': {
        const rec = recoilOf(t, 0.4);
        const bob = Math.sin(time * 2.2 + t.id) * 1.6;
        g.fillStyle = 'rgba(30,40,20,0.2)'; ellipse(g, 0, 6, 8 - bob * 0.5, 3); g.fill();
        g.translate(0, -5 + bob);
        g.scale(1 + rec * 0.18, 1 + rec * 0.18);
        g.rotate(Math.sin(time * 0.8 + t.id) * 0.15);
        const fill = s.metal ? '#8ccdf0' : '#d9f3ff', sh = s.metal ? '#5aa9d6' : '#9fd6ef';
        flat(g, function () { g.beginPath(); g.moveTo(0, -15); g.lineTo(7, -2); g.lineTo(0, 13); g.lineTo(-7, -2); g.closePath(); }, fill, sh, -1.5, -1);
        g.strokeStyle = 'rgba(43,34,51,0.5)'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(0, -15); g.lineTo(0, 13); g.moveTo(-7, -2); g.lineTo(7, -2); g.stroke();
        if (t.a >= 3 || t.b >= 3) {
          for (let i = 0; i < 3; i++) {
            const a = time * 1.5 + i * 2.09;
            g.save(); g.translate(Math.cos(a) * 14, Math.sin(a) * 7); g.rotate(a);
            flat(g, function () { g.beginPath(); g.moveTo(0, -3.5); g.lineTo(2, 0); g.lineTo(0, 3.5); g.lineTo(-2, 0); g.closePath(); }, '#eaf7ff', null, 0, 0, 1.2);
            g.restore();
          }
        }
        break;
      }
      case 'cannon': {
        const rec = recoilOf(t, 0.3);
        const back = rec * 7;
        g.rotate(t.angle);
        const bw = s.cluster ? 13 : 11, bl = s.heavyMult > 1 ? 28 : 24;
        flat(g, function () { roundRect(g, -2 - back, -bw / 2, bl, bw, 3); }, '#7f858f', '#60656e', 0, -2);
        g.fillStyle = s.cluster ? '#e05252' : INK;
        g.fillRect(7 - back, -bw / 2, 3, bw);
        flat(g, function () { roundRect(g, bl - 7 - back, -bw / 2 - 2, 5, bw + 4, 1.5); }, '#6a6f78', null, 0, 0, 1.8);
        g.fillStyle = INK; ellipse(g, bl - 2 - back, 0, 1.2, bw / 2 - 2.5); g.fill();
        flat(g, function () { circle(g, -2 - back * 0.4, 0, 9.5); }, '#5d626b', '#464a52', -1.5, -2);
        shine(g, -2 - back * 0.4, 0, 6, Math.PI * 1.1, Math.PI * 1.4);
        break;
      }
      case 'trapper': {
        const rec = recoilOf(t, 0.35);
        drawGear(g, 10, 8, time * (1.2 + rec * 6) + t.id);
        g.save(); g.translate(10, -10); drawGear(g, 5.5, 6, -time * 2.4 * (1 + rec * 4)); g.restore();
        [[-11, 11], [11, 11], [-11, -11]].forEach(function (p) {
          flat(g, function () { g.beginPath(); g.moveTo(p[0], p[1] - 4.5); g.lineTo(p[0] + 3.2, p[1] + 2); g.lineTo(p[0] - 3.2, p[1] + 2); g.closePath(); }, '#d4d7dc', null, 0, 0, 1.4);
        });
        break;
      }
      case 'sniper': {
        const rec = recoilOf(t, 0.3);
        const back = rec * 6;
        g.rotate(t.angle);
        flat(g, function () { circle(g, -back * 0.3, 0, 8.5); }, '#6f8a4a', '#566d38', -1.5, -2);
        flat(g, function () { roundRect(g, -9 - back, -3, 11, 6, 2); }, '#8a5a2b', null, 0, 0, 1.6);
        flat(g, function () { g.beginPath(); g.rect(-back, -1.7, 31, 3.4); }, '#4a4d52', null, 0, 0, 1.6);
        flat(g, function () { roundRect(g, 3 - back, -6.5, 11, 4, 1.5); }, '#33363b', null, 0, 0, 1.4);
        if (s.heavyMult > 1) { g.fillStyle = '#e05252'; g.fillRect(19 - back, -1.7, 2.5, 3.4); }
        break;
      }
      case 'tesla': {
        const rec = recoilOf(t, 0.25);
        const rings = s.chains >= 7 ? 4 : 3;
        for (let i = 0; i < rings; i++) {
          const r = 14.5 - i * 3.3;
          inkLine(g, 2.2, i % 2 ? '#e8a060' : '#cf8445', function () { circle(g, 0, 0, r); });
        }
        flat(g, function () { circle(g, 0, 0, 5.5 + rec * 1.5); }, rec > 0.3 ? '#ffffff' : '#9fdcff', '#5fb4e6', -1, -1.2, 1.8);
        if (rec > 0.2 || Math.random() < 0.08) {
          const a = Math.random() * Math.PI * 2, rr = 11 + Math.random() * 6;
          inkLine(g, 1.6, '#ffe45c', function () {
            g.beginPath(); g.moveTo(Math.cos(a) * 6, Math.sin(a) * 6);
            g.lineTo(Math.cos(a + 0.35) * rr * 0.6, Math.sin(a + 0.35) * rr * 0.6);
            g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
          });
        }
        break;
      }
      case 'arcanist': {
        const rec = recoilOf(t, 0.25);
        const col = s.splash ? '#f08a3c' : '#a77be8', sh = s.splash ? '#c96a24' : '#8358c4';
        g.save();
        g.rotate(time * 0.6);
        g.strokeStyle = s.splash ? '#ffc58a' : '#d8c2ff'; g.lineWidth = 1.5;
        for (let i = 0; i < 6; i++) {
          g.save(); g.rotate((i / 6) * Math.PI * 2); g.translate(14.5, 0);
          g.beginPath();
          if (i % 2) { g.moveTo(-2, -2); g.lineTo(2, 0); g.lineTo(-2, 2); } else { g.moveTo(0, -2.5); g.lineTo(0, 2.5); g.moveTo(-2, 0); g.lineTo(2, 0); }
          g.stroke(); g.restore();
        }
        g.restore();
        const bob = Math.sin(time * 2.4 + t.id) * 2;
        g.fillStyle = 'rgba(30,40,20,0.2)'; ellipse(g, 0, 5, 6, 2.5); g.fill();
        const sc = 1 + rec * 0.3;
        g.save(); g.translate(0, -5 + bob); g.scale(sc, sc);
        flat(g, function () { circle(g, 0, 0, 6.5); }, col, sh, -1.2, -1.5);
        shine(g, 0, 0, 4, Math.PI * 1.1, Math.PI * 1.45);
        g.restore();
        for (let i = 0; i < 3; i++) {
          const a = time * 2.5 + i * 2.09;
          flat(g, function () { circle(g, Math.cos(a) * 11, -5 + bob + Math.sin(a) * 5, 1.9); }, '#f3ecff', null, 0, 0, 1.1);
        }
        break;
      }
      case 'titan': {
        const rec = recoilOf(t, 0.08);
        g.rotate(t.angle);
        const n = s.shots > 1 ? [-5, 5] : [0];
        n.forEach(function (y) {
          flat(g, function () { roundRect(g, 4 - rec * 2, y - 3, 15, 6, 2); }, '#4a4d52', null, 0, 0, 1.6);
          g.fillStyle = '#f0c03c'; g.fillRect(10 - rec * 2, y - 3, 2.5, 6);
          flat(g, function () { circle(g, 19 - rec * 2, y, 2.4); }, '#7fe8ff', null, 0, 0, 1.3);
        });
        flat(g, function () { poly(g, 6, 12, Math.PI / 6); }, '#c3c8cf', '#9aa0a8', -1.5, -2);
        flat(g, function () { circle(g, 0, 0, 5); }, '#7fe8ff', '#45c3e3', -1, -1.2, 1.8);
        break;
      }
    }
  }

  // Painted animal critter on its pad. It smoothly rotates in 360 degrees to track
  // and aim at targets, recoils along its firing vector, and flips so it stays upright.
  const CRITTER_SIZE = 48;
  function drawCritter(g, t, im) {
    const isAura = !!STILL[TOWERS[t.type].kind];
    const angle = t.angle == null ? -0.5 : t.angle;
    const faceLeft = Math.cos(angle) < 0;
    const rec = recoilOf(t, t.type === 'titan' ? 0.08 : 0.22);
    const bob = Math.sin(time * 2.6 + t.id * 1.7) * 0.7;
    const S = CRITTER_SIZE;

    g.save();
    // soft contact shadow on pad
    g.fillStyle = 'rgba(30,25,20,0.28)';
    ellipse(g, 0, 8, 14, 5); g.fill();

    if (!isAura) {
      // Rotate critter to track target in 360 degrees
      // If aiming left, flip across aim axis so head remains upright
      g.translate(0, 0);
      g.rotate(angle);
      if (faceLeft) g.scale(1, -1);
      // Recoil backward along aim axis
      g.translate(-rec * 4.5, bob * 0.15);
      g.drawImage(im, -S / 2, -S / 2, S, S);
    } else {
      // Aura towers (Frost): upright bob & gentle tilt with pulse on firing
      g.translate(0, 2 + bob * 0.4);
      g.rotate(Math.sin(time * 2.2 + t.id) * 0.1);
      g.scale(1 + rec * 0.18, 1 - rec * 0.12);
      g.drawImage(im, -S / 2, -S / 2 - 2, S, S);
    }
    g.restore();

    if (t.type === 'tesla' && rec > 0.3) {
      g.save(); g.strokeStyle = '#7fe8ff'; g.lineWidth = 1.6; g.globalAlpha = rec;
      const ca = Math.cos(angle), sa = Math.sin(angle);
      g.beginPath();
      g.moveTo(ca * 12, sa * 12);
      g.lineTo(ca * 20 + sa * 6, sa * 20 - ca * 6);
      g.lineTo(ca * 26 - sa * 4, sa * 26 + ca * 4);
      g.lineTo(ca * 34, sa * 34);
      g.stroke();
      g.restore();
    }
  }

  const TOWER_SCALE = 1.2;
  const ENEMY_SCALE = 1.2;
  function drawTower(g, t, alpha) {
    g.save();
    if (alpha != null) g.globalAlpha = alpha;
    g.translate(t.x, t.y);
    g.scale(TOWER_SCALE, TOWER_SCALE);
    const b = baseSprite(t.type);
    g.save(); g.globalAlpha *= 0.3;
    g.drawImage(b.sh, -b.size / 2 + 6, -b.size / 2 + 6, b.size, b.size);
    g.restore();
    g.drawImage(b.cv, -b.size / 2, -b.size / 2, b.size, b.size);
    const im = art('tower_' + t.type);
    if (im) drawCritter(g, t, im); else drawTop(g, t);
    g.restore();
    if (t.buffedBy && alpha == null) {
      g.save();
      g.translate(t.x + 18, t.y - 20 + Math.sin(time * 3 + t.id) * 1.5);
      g.fillStyle = '#9bd14a'; circle(g, 0, 0, 6.5); g.fill();
      g.strokeStyle = INK; g.lineWidth = 1.6; g.stroke();
      g.fillStyle = INK; g.font = '10px ' + UI_FONT; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('\u266A', 0, 0.5);
      g.restore();
    }
    if ((t.a || t.b) && alpha == null) {
      const maxed = t.a >= 3 || t.b >= 3;
      g.save();
      g.translate(t.x, t.y + 28);
      g.fillStyle = maxed ? '#f0c03c' : '#ffffff';
      roundRect(g, -13, -6.5, 26, 13, 6.5); g.fill();
      g.strokeStyle = INK; g.lineWidth = 1.8; g.stroke();
      g.fillStyle = INK;
      g.font = '800 9.5px ' + FONT;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(t.a + '-' + t.b, 0, 0.5);
      g.restore();
    }
  }

  function shellHeight(p) {
    const k = 1 - Math.hypot(p.tx - p.x, p.ty - p.y) / p.total;
    return Math.sin(Math.max(0, Math.min(1, k)) * Math.PI) * Math.min(40, p.total * 0.25);
  }

  function drawProjectile(g, p) {
    g.lineCap = 'round'; g.lineJoin = 'round';
    if (p.kind === 'rang') {
      g.save(); g.translate(p.x, p.y); g.rotate(p.spin);
      g.fillStyle = 'rgba(30,25,20,0.25)'; ellipse(g, 3, 6, 9, 3); g.fill();
      g.beginPath(); g.moveTo(-11, -4); g.quadraticCurveTo(0, -12, 11, -4); g.quadraticCurveTo(0, -5, -11, -4); g.closePath();
      g.beginPath();
      g.moveTo(-12, 3); g.quadraticCurveTo(-4, -10, 0, -11); g.quadraticCurveTo(4, -10, 12, 3);
      g.quadraticCurveTo(8, 5, 6, 2); g.quadraticCurveTo(2, -5, 0, -5); g.quadraticCurveTo(-2, -5, -6, 2); g.quadraticCurveTo(-8, 5, -12, 3);
      g.closePath();
      g.fillStyle = '#c98b3a'; g.fill(); g.strokeStyle = INK; g.lineWidth = 1.8; g.stroke();
      g.fillStyle = '#e05252'; circle(g, 0, -8, 1.8); g.fill();
      g.restore();
      return;
    }
    if (p.kind === 'dart') {
      g.save(); g.translate(p.x, p.y); g.rotate(Math.atan2(p.vy, p.vx));
      inkLine(g, 1.8, '#9a6a3c', function () { g.beginPath(); g.moveTo(-11, 0); g.lineTo(4, 0); });
      flat(g, function () { g.beginPath(); g.moveTo(3, -2.6); g.lineTo(9, 0); g.lineTo(3, 2.6); g.closePath(); }, '#e8e8e8', null, 0, 0, 1.2);
      flat(g, function () { g.beginPath(); g.moveTo(-12, 0); g.lineTo(-8, -3.5); g.lineTo(-6, 0); g.lineTo(-8, 3.5); g.closePath(); }, '#e05252', null, 0, 0, 1.2);
      g.restore();
    } else if (p.kind === 'bolt') {
      flat(g, function () { circle(g, p.x, p.y, 4.5); }, p.color, null, 0, 0, 1.8);
      g.fillStyle = '#ffffff'; circle(g, p.x - 1.2, p.y - 1.2, 1.4); g.fill();
    } else if (p.kind === 'beam') {
      inkLine(g, 2.6, '#9ff0ff', function () { g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(p.x - p.vx * 14, p.y - p.vy * 14); });
    } else if (p.kind === 'shell') {
      const h = shellHeight(p);
      g.fillStyle = 'rgba(30,40,20,0.25)'; ellipse(g, p.x, p.y + 3, 5 - h * 0.05, 2.2); g.fill();
      const r = 5 + h * 0.05;
      flat(g, function () { circle(g, p.x, p.y - h, r); }, '#4a4d52', '#34373b', -1, -1.3, 1.8);
      if (p.s.cluster) { g.fillStyle = '#e05252'; g.fillRect(p.x - r + 1, p.y - h - 1, r * 2 - 2, 2); }
      shine(g, p.x, p.y - h, r * 0.6, Math.PI * 1.1, Math.PI * 1.45);
    }
  }

  function drawPile(g, p) {
    let x = p.x, y = p.y, h = 0;
    const k = (time - p.t0) / PILE_FLIGHT;
    if (k < 1) {
      x = p.fx + (p.x - p.fx) * k; y = p.fy + (p.y - p.fy) * k;
      h = Math.sin(k * Math.PI) * 30;
      g.fillStyle = 'rgba(30,40,20,0.25)'; ellipse(g, x, y + 2, 6, 2.2); g.fill();
    }
    const fade = p.life < 2 ? p.life / 2 : 1;
    g.save(); g.globalAlpha = fade;
    for (let i = 0; i < 4; i++) {
      const a = p.seed + i * 1.57;
      const sx = x + Math.cos(a) * 4.5, sy = y - h + Math.sin(a) * 3.5;
      g.save(); g.translate(sx, sy); g.rotate(a * 2);
      flat(g, function () {
        g.beginPath();
        for (let j = 0; j < 8; j++) {
          const aa = (j / 8) * Math.PI * 2, rr = j % 2 ? 1.4 : 4.3;
          g.lineTo(Math.cos(aa) * rr, Math.sin(aa) * rr);
        }
        g.closePath();
      }, p.s.metal ? '#e3e6ea' : '#b8bcc2', null, 0, 0, 1.1);
      g.restore();
    }
    if (p.s.mine && k >= 1) {
      const blink = Math.sin(time * 8 + p.seed) > 0;
      flat(g, function () { circle(g, x, y, 2.6); }, blink ? '#ff5a5a' : '#8a2a2a', null, 0, 0, 1.1);
    }
    g.restore();
  }

  function drawParticles(g) {
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (const p of particles) {
      const k = p.life / p.max, a = 1 - k;
      switch (p.kind) {
        case 'shard':
          g.save(); g.globalAlpha = Math.min(1, a * 1.6); g.translate(p.x, p.y); g.rotate(p.rot);
          g.beginPath(); g.moveTo(-p.size, -p.size * 0.6); g.lineTo(p.size, 0); g.lineTo(-p.size * 0.4, p.size * 0.7); g.closePath();
          g.fillStyle = p.color; g.fill();
          g.strokeStyle = INK; g.lineWidth = 1; g.stroke();
          g.restore();
          break;
        case 'dot':
        case 'glow':
          g.globalAlpha = a; g.fillStyle = p.color; circle(g, p.x, p.y, p.size * (p.kind === 'glow' ? 0.45 : 1) * (1 - k * 0.5)); g.fill(); g.globalAlpha = 1;
          break;
        case 'spark':
          g.globalAlpha = a;
          g.strokeStyle = INK; g.lineWidth = p.size + 2;
          g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(p.x - p.vx * 0.035, p.y - p.vy * 0.035); g.stroke();
          g.strokeStyle = p.color; g.lineWidth = p.size;
          g.stroke();
          break;
        case 'fire': {
          // cartoon puff: flat disc with an ink rim, shrinking
          const r = p.size * (1 - k * 0.7);
          g.globalAlpha = Math.min(1, a * 1.5);
          circle(g, p.x, p.y, r); g.fillStyle = k < 0.35 ? '#ffe066' : p.color; g.fill();
          g.strokeStyle = INK; g.lineWidth = 1.4; g.stroke();
          break;
        }
        case 'flash': {
          const sc = 0.7 + easeOut(Math.min(1, k * 2)) * 0.5;
          g.save(); g.globalAlpha = a; g.translate(p.x, p.y); g.scale(sc, sc);
          drawStar(g, 6, p.size * 0.8, p.size * 0.4);
          g.fillStyle = p.color === '#ff4d4d' ? '#ff6b6b' : '#fff3a0'; g.fill();
          g.strokeStyle = INK; g.lineWidth = 1.6; g.stroke();
          g.restore();
          break;
        }
        case 'smoke': {
          const r = p.size * (1 + k * 1.3);
          g.globalAlpha = a * 0.75;
          circle(g, p.x, p.y, r); g.fillStyle = p.color === '#5c5c5c' ? '#9b968f' : '#d8d2c6'; g.fill();
          g.strokeStyle = 'rgba(43,34,51,0.6)'; g.lineWidth = 1.2; g.stroke();
          break;
        }
        case 'ring':
          g.globalAlpha = a; g.strokeStyle = p.color; g.lineWidth = Math.max(1, p.w * a * 0.8);
          circle(g, p.x, p.y, p.r0 + (p.r1 - p.r0) * easeOut(k)); g.stroke(); g.globalAlpha = 1;
          break;
        case 'burst': {
          const sc = 0.55 + 0.6 * easeOutBack(Math.min(1, k * 2.2));
          g.save(); g.globalAlpha = Math.min(1, a * 1.8); g.translate(p.x, p.y); g.scale(sc, sc); g.rotate(p.rot * 0.2);
          drawStar(g, 7, p.size, p.size * 0.6);
          g.fillStyle = '#ffffff'; g.fill();
          g.strokeStyle = INK; g.lineWidth = 2.2; g.stroke();
          drawStar(g, 7, p.size * 0.55, p.size * 0.33);
          g.fillStyle = p.color; g.fill();
          g.restore();
          break;
        }
        case 'flake':
          g.save(); g.globalAlpha = a; g.translate(p.x, p.y); g.rotate(p.rot);
          g.strokeStyle = '#ffffff'; g.lineWidth = 1.4;
          for (let i = 0; i < 3; i++) {
            g.rotate(Math.PI / 3);
            g.beginPath(); g.moveTo(-p.size, 0); g.lineTo(p.size, 0); g.stroke();
          }
          g.restore();
          break;
        case 'text': {
          const sc = k < 0.15 ? easeOutBack(k / 0.15) : 1;
          g.save(); g.globalAlpha = Math.min(1, a * 1.5); g.translate(p.x, p.y); g.scale(sc, sc);
          g.font = '900 ' + p.size + 'px ' + FONT;
          g.textAlign = 'center'; g.textBaseline = 'middle';
          g.lineWidth = Math.max(3, p.size * 0.28); g.strokeStyle = INK;
          g.strokeText(p.text, 0, 0);
          g.fillStyle = p.color; g.fillText(p.text, 0, 0);
          g.restore();
          break;
        }
      }
    }
    g.globalAlpha = 1;
  }

  function drawLines(g) {
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (const fx of effects) {
      const a = 1 - fx.t / fx.max;
      const pts = fx.type === 'bolt' && Math.floor(fx.t * 40) % 2 ? fx.pts2 : fx.pts;
      const build = function () {
        g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
      };
      g.save(); g.globalAlpha = Math.min(1, a * 1.5);
      if (fx.type === 'tracer') inkLine(g, 1.6, '#fff3a0', build);
      else if (fx.type === 'bolt') inkLine(g, 3, '#ffe45c', build);
      g.restore();
    }
  }

  function drawRange(g, x, y, r, ok) {
    r = Math.min(r, 1400);
    g.save();
    g.fillStyle = ok ? 'rgba(255,255,255,0.16)' : 'rgba(224,82,82,0.2)';
    circle(g, x, y, r); g.fill();
    g.setLineDash([7, 6]);
    g.strokeStyle = ok ? 'rgba(255,255,255,0.9)' : '#e05252';
    g.lineWidth = 2;
    circle(g, x, y, r); g.stroke();
    g.restore();
  }

  function drawBossBar(g) {
    let boss = null;
    for (const e of enemies) if (e.def.heavy && (!boss || e.def.hp > boss.def.hp || (e.def.hp === boss.def.hp && e.hp < boss.hp))) boss = e;
    if (!boss) return;
    const w = 320, x = W / 2 - w / 2, y = 22;
    g.save();
    g.font = '15px ' + UI_FONT;
    g.textAlign = 'center'; g.textBaseline = 'bottom'; g.lineJoin = 'round';
    g.lineWidth = 5; g.strokeStyle = UI_INK; g.strokeText(boss.def.name.toUpperCase(), W / 2, y - 1);
    g.fillStyle = '#ffcb2e'; g.fillText(boss.def.name.toUpperCase(), W / 2, y - 1);
    g.fillStyle = '#0a1838'; roundRect(g, x, y, w, 16, 6); g.fill();
    const hw = Math.max(8, w * Math.max(0, boss.hp / boss.maxHp));
    g.fillStyle = '#f0483e'; roundRect(g, x, y, hw, 16, 6); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.35)'; roundRect(g, x + 3, y + 2, Math.max(2, hw - 6), 4, 2); g.fill();
    g.strokeStyle = UI_INK; g.lineWidth = 3; roundRect(g, x, y, w, 16, 6); g.stroke();
    g.restore();
  }

  function drawBanner(g) {
    if (!banner) return;
    const k = (time - banner.t0) / 2.2;
    if (k >= 1) { banner = null; return; }
    const sc = k < 0.12 ? easeOutBack(k / 0.12) : 1;
    const a = k > 0.75 ? 1 - (k - 0.75) / 0.25 : 1;
    g.save();
    g.globalAlpha = a;
    g.translate(W / 2, H / 2 - 40);
    g.scale(sc, sc);
    g.rotate(-0.03);
    g.font = '60px ' + UI_FONT;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.lineWidth = 12; g.strokeStyle = UI_INK; g.strokeText(banner.text, 0, 0);
    g.strokeText(banner.text, 0, 5);
    g.fillStyle = '#ffd23f'; g.fillText(banner.text, 0, 0);
    if (banner.sub) {
      g.font = '18px ' + UI_FONT;
      g.lineWidth = 6; g.strokeText(banner.sub, 0, 40);
      g.fillStyle = '#ffffff'; g.fillText(banner.sub, 0, 40);
    }
    g.restore();
  }

  const towerOrder = [], enemyOrder = [];
  function byY(a, b) { return a.y - b.y; }
  function bySizeY(a, b) { return a.def.r - b.def.r || a.y - b.y; }
  function sortInto(out, src, cmp) {
    out.length = src.length;
    for (let i = 0; i < src.length; i++) out[i] = src[i];
    return out.sort(cmp);
  }

  const boardWrap = document.getElementById('td-boardwrap');
  let shaking = false;
  function applyShake() {
    if (shake > 0.3) {
      const k = boardWrap.clientWidth / W || 1;
      boardWrap.style.transform = 'translate(' + (rand(-shake, shake) * 0.6 * k).toFixed(1) + 'px,' + (rand(-shake, shake) * 0.6 * k).toFixed(1) + 'px)';
      shaking = true;
    } else if (shaking) {
      boardWrap.style.transform = '';
      shaking = false;
    }
  }

  function draw() {
    const g = ctx;
    g.setTransform(RS, 0, 0, RS, 0, 0);
    g.clearRect(0, 0, W, H);
    g.save();
    applyShake();

    for (const p of piles) drawPile(g, p);

    if (selected) {
      if (selected.s.range < 1000) drawRange(g, selected.x, selected.y, selected.s.range, true);
      g.save();
      g.strokeStyle = '#ffd23f'; g.lineWidth = 3;
      g.setLineDash([6, 5]); g.lineDashOffset = -time * 15;
      circle(g, selected.x, selected.y, 25); g.stroke();
      g.restore();
    }

    const sortedTowers = sortInto(towerOrder, towers, byY);
    for (const t of sortedTowers) drawTower(g, t);

    const sorted = sortInto(enemyOrder, enemies, bySizeY);
    for (const e of sorted) {
      if (e.inTunnel) continue;
      if (e.phased) { g.save(); g.globalAlpha = 0.28; drawEnemy(g, e); g.restore(); }
      else drawEnemy(g, e);
      drawEnemyMarks(g, e);
    }

    for (const p of projectiles) drawProjectile(g, p);
    drawLines(g);
    drawParticles(g);

    if (placing && mouse.inside) {
      const ok = canPlace(mouse.x, mouse.y) && points >= TOWERS[placing].cost;
      const r = TOWERS[placing].base.range;
      drawRange(g, mouse.x, mouse.y, r < 1000 ? r * mapRangeMult(placing, mouse.x, mouse.y) : 32, ok);
      drawTower(g, ghostTower(placing, mouse.x, mouse.y), 0.75);
    }
    g.restore();

    drawBossBar(g);
    drawBanner(g);

    if (!running && !gameOver) {
      const secs = secondsToWave();
      const txt = secs != null ? 'Wave ' + game.wave + ' in ' + secs + 's  ·  Space to start now'
        : 'Build phase  ·  wave ' + game.wave + ' starts with your next Anki card (or Space)';
      g.save();
      g.font = '16px ' + UI_FONT;
      const tw = g.measureText(txt).width || 300;
      g.fillStyle = 'rgba(16,39,90,0.82)';
      roundRect(g, W / 2 - tw / 2 - 18, H - 50, tw + 36, 34, 12); g.fill();
      g.strokeStyle = UI_INK; g.lineWidth = 3; g.stroke();
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
      g.lineWidth = 4; g.strokeStyle = UI_INK; g.strokeText(txt, W / 2, H - 32);
      g.fillStyle = '#ffffff'; g.fillText(txt, W / 2, H - 32);
      g.restore();
    }
  }

  const ghostCache = {};
  function ghostTower(type, x, y) {
    if (!ghostCache[type]) ghostCache[type] = makeTower({ id: 0, type: type, x: 0, y: 0 });
    const t = ghostCache[type];
    t.x = x; t.y = y; t.angle = -0.5;
    return t;
  }

  function renderIcon(type) {
    const size = arguments.length > 1 ? arguments[1] : 46;
    const k = size / 40 * 0.78;
    const c = makeCanvas(size * DPR, size * DPR);
    c.style.width = size + 'px'; c.style.height = size + 'px';
    c.className = 'td-icon';
    const g = c.getContext('2d');
    g.scale(DPR * k, DPR * k);
    const t = makeTower({ id: 0, type: type, x: size / 2 / k, y: size / 2 / k - 1 });
    t.angle = -0.6;
    const im = art('tower_' + type);
    if (im) {
      // painted towers: just the critter, filling the icon
      g.setTransform(DPR, 0, 0, DPR, 0, 0);
      g.drawImage(im, 1, 1, size - 2, size - 2);
      return c;
    }
    drawTower(g, t, 1);
    return c;
  }

  // the shop icons are drawn before the sprites finish decoding: redraw them once they have
  function onArtLoaded() {
    Object.keys(shopEls).forEach(function (type) {
      const old = shopEls[type].querySelector('.td-icon');
      if (old) old.replaceWith(renderIcon(type));
    });
  }

  // ------------------------------------------------------------ actions
  function canPlace(x, y) {
    if (x < 20 || y < 20 || x > W - 20 || y > H - 20) return false;
    if (distToPath(x, y) < PATH_HALF + 18) return false;
    for (const t of towers) if (Math.hypot(t.x - x, t.y - y) < 38) return false;
    for (const o of obstacles) if (Math.hypot(o.x - x, o.y - y) < o.r + 12) return false;
    return true;
  }

  function commit(delta, snap, onOk) {
    busy = true;
    bridge('commit:' + JSON.stringify({ delta: delta, game: snap }), function (res) {
      busy = false;
      if (res) {
        if (typeof res.points === 'number') points = res.points;
        if (typeof res.totalCards === 'number') totalCards = res.totalCards;
      }
      if (res && res.ok) { if (onOk) onOk(); }
      else if (delta < 0) toast('Not enough study points. Go review some cards!');
      renderUI();
    });
  }

  function buyTower(type, x, y) {
    const def = TOWERS[type];
    if (running) { toast('Wave in progress: keep reviewing! You can build when it ends.'); return; }
    if (busy || !isUnlocked(type)) return;
    if (isBanned(type)) { toast(def.name + ' is banned this run (Supply Shortage).'); return; }
    const cost = def.cost;
    if (points < cost) { toast('Not enough study points. Go review some cards!'); return; }
    if (!canPlace(x, y)) { toast("Can't build there."); return; }
    const t = makeTower({ id: nextTowerId++, type: type, x: x, y: y,
      target: type === 'sniper' ? 'strong' : 'first', spent: cost });
    commit(-cost, snapshot([t]), function () {
      towers.push(t);
      refreshAll();
      if (points < cost) placing = null;
      renderUI();
    });
  }

  function upgradeSelected(path) {
    const t = selected;
    if (t && running) { toast('Wave in progress: keep reviewing! You can build when it ends.'); return; }
    if (!t || busy || !canUpgrade(t, path)) return;
    const up = TOWERS[t.type].paths[path][path === 0 ? t.a : t.b];
    const upCost = up.cost;
    if (points < upCost) { toast('Not enough study points. Go review some cards!'); return; }
    const next = Object.assign({}, t, { spent: t.spent + upCost });
    if (path === 0) next.a += 1; else next.b += 1;
    commit(-upCost, snapshot([next], t.id), function () {
      if (path === 0) t.a += 1; else t.b += 1;
      t.spent += upCost;
      refreshAll();
      toast(TOWERS[t.type].name + ': ' + up.name + '!');
      renderUI();
    });
  }

  function sellSelected() {
    const t = selected;
    if (t && running) { toast('Wave in progress: keep reviewing! You can build when it ends.'); return; }
    if (!t || busy) return;
    const refund = Math.floor(t.spent * SELL_RATE);
    commit(refund, snapshot(null, t.id), function () {
      towers = towers.filter(function (x) { return x !== t; });
      piles = piles.filter(function (p) { return p.owner !== t.id; });
      selected = null;
      refreshAll();
      renderUI();
    });
  }

  function setTargetMode(mode) {
    if (!selected || running) return;
    selected.target = mode;
    commit(0, snapshot(), null);
    renderUI();
  }

  // ------------------------------------------------------------ UI
  const $ = function (id) { return document.getElementById(id); };
  const shopEls = {};

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function buildShop() {
    const shop = $('td-shop');
    ORDER.forEach(function (type, i) {
      const def = TOWERS[type];
      const b = document.createElement('button');
      b.className = 'td-tower';
      b.innerHTML = (i < 10 ? '<span class="td-key">' + ((i + 1) % 10) + '</span>' : '') + '<span class="td-tname td-outline">' + def.name + '</span>' +
        '<span class="td-tdesc"></span><span class="td-cost"></span>';
      b.insertBefore(renderIcon(type), b.children[1]);
      b.addEventListener('click', function () { selectShop(type); });
      shop.appendChild(b);
      shopEls[type] = b;
    });
  }

  function selectShop(type) {
    if (running) { toast('Wave in progress: keep reviewing! You can build when it ends.'); return; }
    if (!isUnlocked(type)) {
      toast(TOWERS[type].name + ' unlocks after ' + unlocks[type] + ' reviewed cards.');
      return;
    }
    placing = placing === type ? null : type;
    selected = null;
    renderUI();
  }

  function statLine(s) {
    const parts = [];
    if (s.dmg) parts.push('Dmg ' + s.dmg);
    parts.push(s.range < 1000 ? 'Range ' + s.range : 'Range: map');
    if (s.kind !== 'buff') parts.push('Rate ' + (Math.round(s.rate * 10) / 10) + '/s');
    if (s.kind === 'buff') {
      parts.push('Nearby towers +' + Math.round((s.buff - 1) * 100) + '% speed');
      if (s.buffDmg) parts.push('+' + s.buffDmg + ' damage');
      if (s.buffRange) parts.push('+' + Math.round(s.buffRange * 100) + '% range');
      if (s.buffMetal) parts.push('hits Iron');
    }
    if (s.burn) parts.push('Burn ' + s.burn + '/s for ' + s.burnDur + 's');
    if (s.push) parts.push('Push ' + s.push);
    if (s.pierce > 1) parts.push('Pierce ' + s.pierce);
    if (s.shots > 1) parts.push(s.shots + ' shots');
    if (s.splash) parts.push('Splash ' + s.splash);
    if (s.chains) parts.push('Chains ' + s.chains);
    if (s.bounce) parts.push('Bounce ' + s.bounce);
    if (s.hits) parts.push(s.hits + ' pops/pile');
    if (s.slow) parts.push('Slow ' + Math.round((1 - s.slow) * 100) + '%');
    if (s.heavyMult > 1) parts.push('x' + s.heavyMult + ' vs giants');
    if (s.metal && s.kind !== 'buff') parts.push('hits Iron');
    if (s.buffed) parts.push('\u266A Bard buff');
    return parts.join(' &middot; ');
  }

  function renderUI() {
    $('td-points').textContent = points;
    $('td-wave').textContent = game.wave;
    $('td-lives').textContent = Math.max(0, Math.ceil(game.lives));
    $('td-cards').textContent = totalCards;
    $('td-best').textContent = game.bestWave;
    updateWaveTimerUI();

    ORDER.forEach(function (type) {
      const def = TOWERS[type];
      const b = shopEls[type];
      const unlocked = isUnlocked(type);
      b.classList.toggle('td-locked', !unlocked);
      b.classList.toggle('td-active', placing === type);
      const banned = isBanned(type);
      b.classList.toggle('td-locked', !unlocked || banned);
      b.classList.toggle('td-poor', unlocked && !banned && points < def.cost);
      b.title = unlocked ? def.name + ': ' + def.desc
        : def.name + ' unlocks at ' + unlocks[type] + ' cards (' + (unlocks[type] - totalCards) + ' to go)';
      b.querySelector('.td-cost').textContent = banned ? 'Banned' : unlocked ? def.cost : unlocks[type] + ' cards';
    });

    const next = ORDER.filter(function (t) { return !isUnlocked(t); })
      .sort(function (a, b) { return unlocks[a] - unlocks[b]; })[0];
    const ul = $('td-unlock');
    if (next) {
      const prev = Math.max.apply(null, ORDER.filter(isUnlocked).map(function (t) { return unlocks[t] || 0; }).concat([0]));
      const pct = Math.min(100, ((totalCards - prev) / Math.max(1, unlocks[next] - prev)) * 100);
      ul.innerHTML = 'Next unlock: <b>' + TOWERS[next].name + '</b> at ' + unlocks[next] + ' cards' +
        '<div class="td-bar"><div style="width:' + pct.toFixed(1) + '%"></div></div>';
    } else {
      ul.textContent = 'All towers unlocked!';
    }

    const start = $('td-start');
    start.disabled = gameOver;
    if (running) {
      start.disabled = false;
      start.classList.toggle('td-gold', !paused);
      start.classList.toggle('td-green', paused);
      $('td-start-lbl').textContent = paused ? 'Resume' : 'Pause';
      start.title = paused ? 'Resume wave (P or answer card)' : 'Pause wave (P)';
    } else {
      start.classList.remove('td-gold');
      start.classList.add('td-green');
      const secs = secondsToWave();
      $('td-start-lbl').textContent = secs != null ? secs + 's' : 'Go';
      start.title = 'Start wave ' + game.wave + ' (Space)';
    }

    const pauseBtn = $('td-pausebtn');
    if (pauseBtn) {
      pauseBtn.classList.toggle('td-hidden', !running);
      pauseBtn.textContent = paused ? '▶ Resume' : '⏸ Pause';
      pauseBtn.title = paused ? 'Resume wave (P or answer card)' : 'Pause wave (P)';
      pauseBtn.classList.toggle('td-green', paused);
      pauseBtn.classList.toggle('td-gold', !paused);
    }

    const pauseOverlay = $('td-paused-overlay');
    if (pauseOverlay) {
      pauseOverlay.classList.toggle('td-hidden', !running || !paused);
    }
    $('td-speed-lbl').textContent = speed + '×';
    const sp = $('td-speed');
    sp.classList.toggle('td-blue', speed === 1);
    sp.classList.toggle('td-gold', speed === 2);
    sp.classList.toggle('td-red', speed === 3);
    sp.classList.toggle('td-purple', speed === 20);
    sp.title = speed === 20 ? 'Game speed: 20x (for testing)' : 'Game speed';

    $('td-mapname').textContent = MAP.name;
    renderMods();
    renderFocus();
    $('td-side').classList.toggle('td-wave-lock', running);
    $('td-lockmsg').classList.toggle('td-hidden', !running);

    const info = $('td-info');
    // the upgrade panel takes the shop's place while a tower is selected
    $('td-shop').classList.toggle('td-hidden', !!selected);
    $('td-unlock').classList.toggle('td-hidden', !!selected);
    if (!selected) { info.classList.add('td-hidden'); return; }
    info.classList.remove('td-hidden');
    const t = selected, def = TOWERS[t.type];
    let html = '<div class="td-infohead"><span class="td-portrait"></span><div class="td-infotitle">' +
      '<h3 class="td-outline">' + def.name + '</h3><span class="td-tier">' + t.a + '-' + t.b + '</span></div>' +
      '<button id="td-info-close" class="td-btn td-red td-x" title="Back to towers (Esc)">\u2715</button></div>' +
      '<div class="td-statline">' + esc(def.desc) + '</div>' +
      '<div class="td-statline">' + statLine(t.s) + '</div><div class="td-paths">';
    [0, 1].forEach(function (path) {
      const lvl = path === 0 ? t.a : t.b;
      const ups = def.paths[path];
      html += '<div class="td-path"><div class="td-pips">';
      for (let i = 0; i < 3; i++) {
        html += '<span class="td-pip' + (i < lvl ? ' td-pip-on' : '') + '" title="' + esc(ups[i].name + ': ' + ups[i].desc) + '"></span>';
      }
      html += '</div>';
      if (lvl >= 3) {
        html += '<button disabled class="td-btn td-gold td-up"><b>Path maxed</b></button>';
      } else {
        const up = ups[lvl];
        const locked = !canUpgrade(t, path);
        html += '<button class="td-btn td-green td-up" data-path="' + path + '"' +
          (locked || running || points < up.cost ? ' disabled' : '') + '>' +
          '<b>' + esc(up.name) + '</b><span class="td-updesc">' + (locked ? 'Locked by other path' : esc(up.desc)) + '</span>' +
          '<span class="td-upcost"><span>' + up.cost + '</span><span class="td-key">' + PATH_KEYS[path] + '</span></span></button>';
      }
      html += '</div>';
    });
    html += '</div>';
    if (!STILL[def.kind]) {
      html += '<div class="td-targets">' + TARGET_MODES.map(function (m) {
        return '<button data-mode="' + m + '" class="' + (t.target === m ? 'td-on' : '') + '"' + (running ? ' disabled' : '') + '>' + m + '</button>';
      }).join('') + '</div>';
    }
    html += '<button id="td-sell" class="td-btn td-red"' + (running ? ' disabled' : '') + '>Sell +' + Math.floor(t.spent * SELL_RATE) + '</button>';
    info.innerHTML = html;
    info.querySelector('.td-portrait').appendChild(renderIcon(t.type, 52));
    $('td-info-close').addEventListener('click', function () { selected = null; renderUI(); });
    info.querySelectorAll('[data-path]').forEach(function (b) {
      b.addEventListener('click', function () { upgradeSelected(+b.getAttribute('data-path')); });
    });
    $('td-sell').addEventListener('click', sellSelected);
    info.querySelectorAll('[data-mode]').forEach(function (b) {
      b.addEventListener('click', function () { setTargetMode(b.getAttribute('data-mode')); });
    });
  }

  // ------------------------------------------------------------ map select
  const mapThumbs = {};
  function mapThumb(id) {
    if (mapThumbs[id]) return mapThumbs[id];
    if (id === mapId) { mapThumbs[id] = background; return background; }
    // build the other map's background off-screen, then restore the live map
    const keep = { mapId: mapId, MAP: MAP, LANES: LANES, THEME: THEME, scenery: scenery, obstacles: obstacles.slice() };
    mapId = id; MAP = MAPS[id]; LANES = buildLanes(MAP); THEME = THEMES[MAP.theme];
    obstacles.length = 0; scenery = buildScenery();
    const bg = buildBackground();
    mapId = keep.mapId; MAP = keep.MAP; LANES = keep.LANES; THEME = keep.THEME; scenery = keep.scenery;
    obstacles.length = 0; keep.obstacles.forEach(function (o) { obstacles.push(o); });
    mapThumbs[id] = bg;
    return bg;
  }

  function trophyText(id) {
    const t = (saved.trophies || {})[id];
    if (!t) return '';
    const won = DIFF_ORDER.filter(function (k) { return t[k]; }).map(function (k) { return DIFFS[k].name; });
    return won.length ? '<br>\uD83C\uDFC6 ' + esc(won.join(', ')) : '';
  }

  function openMapSelect() {
    const list = $('td-maplist');
    list.innerHTML = '';
    MAP_ORDER.forEach(function (id) {
      const m = MAPS[id], open = mapUnlocked(id), rec = id === mapId ? game : saved.maps[id];
      const b = document.createElement('button');
      b.className = 'td-mapitem' + (id === mapId ? ' td-current' : '') + (open ? '' : ' td-locked');
      const c = document.createElement('canvas');
      c.width = 192 * DPR; c.height = 120 * DPR; c.className = 'td-mapthumb';
      b.appendChild(c);
      const txt = document.createElement('div');
      txt.className = 'td-mapinfo';
      txt.innerHTML = '<div class="td-mapname td-outline">' + esc(m.name) + '</div>' +
        '<div class="td-maprule">' + esc(m.rule) + '</div>' +
        '<div class="td-mapstatus">' + (id === mapId ? 'Playing now' : !open ? 'Unlocks at ' + m.unlock + ' cards' :
          rec && rec.bestWave ? 'Best wave ' + rec.bestWave : 'New map!') +
        trophyText(id) + '</div>';
      b.appendChild(txt);
      b.addEventListener('click', function () { chooseMap(id); });
      list.appendChild(b);
      // thumbnails are drawn after the list shows, so opening the picker never stalls
      setTimeout(function () {
        const g2 = c.getContext('2d');
        g2.drawImage(mapThumb(id), 0, 0, c.width, c.height);
        if (!open) { g2.fillStyle = 'rgba(16,24,44,0.6)'; g2.fillRect(0, 0, c.width, c.height); }
      }, 0);
    });
    $('td-mapsel').classList.remove('td-hidden');
  }
  function closeMapSelect() { $('td-mapsel').classList.add('td-hidden'); }

  function chooseMap(id) {
    if (id === mapId) { closeMapSelect(); return; }
    if (!mapUnlocked(id)) { toast(MAPS[id].name + ' unlocks after ' + MAPS[id].unlock + ' reviewed cards.'); return; }
    if (running) { toast('Finish the current wave first.'); return; }
    if (busy) return;
    saved.maps[mapId] = snapshot().maps[mapId];
    loadMap(id);
    mapThumbs[id] = background;
    hideOverlay();
    closeMapSelect();
    banner = { text: MAP.name.toUpperCase(), sub: MAP.rule, t0: time };
    const rolled = ensureRun();
    refreshAll();
    commit(0, snapshot(), null);
    scheduleNextWave();
    renderUI();
    if (rolled) showRunCard();
  }

  let toastTimer = null;
  function toast(msg) {
    wake();
    const el = $('td-toast');
    el.textContent = msg;
    el.classList.add('td-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('td-show'); }, 2600);
  }

  function showRunCard() {
    const m = game.mods;
    if (!m) return;
    const T = TWISTS[m.twist];
    let diffs;
    if (canPickDifficulty()) {
      diffs = '<span class="td-mod-note">Difficulty: harder pays more coins per wave cleared when the run ends</span><span class="td-diffs">';
      DIFF_ORDER.forEach(function (k) {
        const d = DIFFS[k];
        diffs += '<button class="td-btn td-diff td-diff-' + k + (game.diff === k ? ' td-on' : '') + '" data-diff="' + k + '">' +
          esc(d.name) + '<small>' + d.coins + ' coin' + (d.coins > 1 ? 's' : '') + ' per wave</small></button>';
      });
      diffs += '</span>';
    } else {
      diffs = '<span class="td-mod-note">Difficulty: <b>' + esc(diffOf().name) + '</b> (pick a new one when this run ends)</span>';
    }
    showOverlay('New run!', '', 'Defend!', hideOverlay,
      '<span class="td-mod td-mod-bad"><b class="td-outline">This run: ' + esc(T.name) + '</b>' + esc(T.desc) +
      (m.banned ? ': ' + esc(TOWERS[m.banned].name) : '') + '</span>' + diffs +
      '<span class="td-mod-note">Runs end when you lose or close Anki. Unlocks and unspent points always stay.</span>');
    document.querySelectorAll('[data-diff]').forEach(function (b) {
      b.addEventListener('click', function () { setDifficulty(b.getAttribute('data-diff')); });
    });
  }
  // only at the start of a run (wave 1, nothing built yet)
  function canPickDifficulty() { return !running && game.wave === 1 && towers.length === 0; }
  function setDifficulty(k) {
    if (!DIFFS[k]) return;
    if (!canPickDifficulty()) { toast('Difficulty can only change at the start of a run.'); return; }
    game.diff = k;
    saved.diff = k;
    game.lives = livesFor(game.mods, k);
    commit(0, snapshot(), null);
    showRunCard();
    renderUI();
  }
  function renderMods() {
    const el = $('td-mods'), m = game.mods;
    if (!m) { el.innerHTML = ''; return; }
    const T = TWISTS[m.twist];
    const pr = Math.round((game.pressure || 0) * 100);
    el.innerHTML = '<span class="td-chip td-chip-diff td-diff-' + game.diff + '">' + esc(diffOf().name) +
      (game.endless ? ' \u00b7 endless' : ' \u00b7 win at wave ' + diffOf().win) + '</span>' +
      (pr ? '<span class="td-chip td-chip-pressure" title="Cruising without leaks makes waves a little tougher (up to +20%); leaking a lot eases them (down to -10%).">Pressure ' + (pr > 0 ? '+' : '') + pr + '%</span>' : '') +
      '<span class="td-chip td-chip-bad" title="' + esc(T.desc + (m.banned ? ': ' + TOWERS[m.banned].name : '')) + '">\u26A0 ' +
      esc(T.name) + (m.banned ? ' (' + esc(TOWERS[m.banned].name) + ')' : '') + '</span>';
  }

  // Start from scratch: two steps so it can't happen by accident.
  function confirmReset() {
    showOverlay('Start from scratch?', '', 'Cancel', hideOverlay,
      '<span class="td-mod td-mod-bad"><b class="td-outline">This erases all game progress</b>' +
      'Your study points, unlocked towers and maps, trophies and every run go back to the very beginning.</span>' +
      '<span class="td-mod-note">Your Anki cards and review history are not touched. Only the game resets.</span>' +
      '<button id="td-reset-yes" class="td-btn td-red">Yes, reset everything</button>');
    $('td-reset-yes').addEventListener('click', function () {
      $('td-reset-yes').disabled = true;
      bridge('reset', null);
    });
  }

  function showOverlay(title, text, btn, onClick, html) {
    $('td-ov-title').textContent = title;
    if (html) $('td-ov-text').innerHTML = html; else $('td-ov-text').textContent = text;
    const b = $('td-ov-btn');
    b.textContent = btn;
    b.onclick = onClick;
    $('td-overlay').classList.remove('td-hidden');
  }
  function hideOverlay() { $('td-overlay').classList.add('td-hidden'); }

  // ------------------------------------------------------------ input
  function canvasPos(ev) {
    const r = canvas.getBoundingClientRect();
    return { x: ((ev.clientX - r.left) / r.width) * W, y: ((ev.clientY - r.top) / r.height) * H };
  }
  canvas.addEventListener('mousemove', function (ev) {
    const p = canvasPos(ev);
    mouse.x = p.x; mouse.y = p.y; mouse.inside = true;
  });
  canvas.addEventListener('mouseleave', function () { mouse.inside = false; });
  canvas.addEventListener('contextmenu', function (ev) {
    ev.preventDefault();
    placing = null; selected = null; renderUI();
  });
  canvas.addEventListener('click', function (ev) {
    const p = canvasPos(ev);
    if (placing) { buyTower(placing, p.x, p.y); return; }
    let hit = null;
    for (const t of towers) if (Math.hypot(t.x - p.x, t.y - p.y) < 20) hit = t;
    selected = hit;
    renderUI();
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.target && ev.target.tagName === 'INPUT') return;
    const k = (ev.key || '').toUpperCase();
    if (ev.code === 'Space') {
      ev.preventDefault();
      if (!running) startWave();
      else togglePause();
    }
    else if (k === 'P') { ev.preventDefault(); togglePause(); }
    else if (ev.key === 'Escape') { placing = null; selected = null; closeMapSelect(); renderUI(); }
    else if (k === PATH_KEYS[0]) upgradeSelected(0);
    else if (k === PATH_KEYS[1]) upgradeSelected(1);
    else if (k.length === 1 && k >= '0' && k <= '9') { const i = (+k + 9) % 10; if (ORDER[i]) selectShop(ORDER[i]); }
    else if (k === 'M') openMapSelect();
  });

  $('td-start').addEventListener('click', function () {
    if (!running) startWave();
    else togglePause();
  });
  const pauseBtn = $('td-pausebtn');
  if (pauseBtn) {
    pauseBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      togglePause();
    });
  }
  const resumeBtn = $('td-resume-btn');
  if (resumeBtn) {
    resumeBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      togglePause(false);
    });
  }
  const pauseOverlay = $('td-paused-overlay');
  if (pauseOverlay) {
    pauseOverlay.addEventListener('click', function () {
      togglePause(false);
    });
  }
  $('td-mapbtn').addEventListener('click', openMapSelect);
  $('td-mapclose').addEventListener('click', closeMapSelect);
  $('td-reset').addEventListener('click', confirmReset);
  const dockBtn = $('td-dockbtn');
  if (dockBtn) {
    dockBtn.addEventListener('click', function () {
      bridge('toggle_dock', function (res) {
        if (res && res.floating) {
          dockBtn.innerHTML = '&#x21E5; Dock';
          dockBtn.title = 'Dock back to split screen';
        } else {
          dockBtn.innerHTML = '&#x29C9; Float';
          dockBtn.title = 'Float into separate window';
        }
      });
    });
  }
  $('td-speed').addEventListener('click', function () {
    // 1x, 2x, 3x, then 20x for testing
    speed = speed === 3 ? 20 : speed >= 20 ? 1 : speed + 1;
    renderUI();
  });

  if (DEV) {
    const dev = $('td-dev');
    dev.classList.remove('td-hidden');
    dev.addEventListener('click', function () {
      const s = devLoad();
      s.points += 10; s.totalCards += 10;
      devSave(s);
      window.TD.setPoints(s.points, s.totalCards);
    });
  }

  // ------------------------------------------------------------ API for Anki
  window.TD = {
    // Called by Anki when a question is shown: if no wave is running, the next one starts.
    reviewing: function () {
      if (!running && !gameOver) startWave();
    },
    // Called by Anki when a card is answered. During a wave it charges the Focus meter,
    // and every FOCUS_CARDS cards fire a study power; otherwise it starts the next wave.
    cardAnswered: function () {
      if (gameOver) return;
      if (paused) {
        paused = false;
        wake();
        renderUI();
      }
      if (!running) { startWave(); return; }
      focus += 1;
      if (focus % FOCUS_CARDS === 0) firePower();
      renderFocus();
    },
    pause: function (val) { togglePause(val); },
    get paused() { return paused; },
    setPoints: function (p, total) {
      const gained = p > points;
      const unlockedBefore = ORDER.filter(isUnlocked);
      const mapsBefore = MAP_ORDER.filter(mapUnlocked);
      points = p;
      if (typeof total === 'number') totalCards = total;
      ORDER.filter(isUnlocked).forEach(function (t) {
        if (unlockedBefore.indexOf(t) < 0) toast(TOWERS[t].name + ' tower unlocked!');
      });
      MAP_ORDER.forEach(function (id) {
        if (mapsBefore.indexOf(id) < 0 && mapUnlocked(id)) toast('New map unlocked: ' + MAPS[id].name + '!');
      });
      if (gained) {
        const box = $('td-points-box');
        box.classList.add('td-flash');
        setTimeout(function () { box.classList.remove('td-flash'); }, 400);
      }
      renderUI();
    },
  };

  // ------------------------------------------------------------ main loop
  let last = 0;
  // Between waves nothing moves except the towers' gentle bob, so drop to ~10 fps
  // (and sleep in between) instead of repainting 60 times a second.
  function active() {
    return running || particles.length > 0 || effects.length > 0 || projectiles.length > 0 ||
      banner !== null || placing !== null || selected !== null || shake > 0.3 || time - lastInput < 1.5;
  }
  let lastInput = 0;
  ['mousemove', 'mousedown', 'keydown'].forEach(function (t) {
    document.addEventListener(t, function () { if (lastInput < time - 0.2) wake(); lastInput = time; }, true);
  });
  let sleepTimer = null;
  function wake() {
    if (sleepTimer) { clearTimeout(sleepTimer); sleepTimer = null; requestAnimationFrame(loop); }
  }
  const perf = { frames: 0, slow: 0, upd: 0, drw: 0, t0: 0, fps: 0, show: false, el: null };
  function perfTick(ts, frameMs, updMs, drwMs) {
    perf.frames++; perf.upd += updMs; perf.drw += drwMs;
    if (frameMs > 22) perf.slow++;
    if (!perf.t0) perf.t0 = ts;
    const span = ts - perf.t0;
    if (span < 2000) return;
    perf.fps = perf.frames / (span / 1000);
    // more than a third of frames late during play: render the game canvas at a lower resolution
    if (running && perf.frames > 40 && perf.slow / perf.frames > 0.33 && RS > 1) {
      setRenderScale(Math.max(1, Math.round((RS - 0.25) * 4) / 4));
    }
    if (perf.show) {
      perf.el.textContent = perf.fps.toFixed(0) + ' fps \u00b7 update ' + (perf.upd / perf.frames).toFixed(1) + 'ms \u00b7 draw ' +
        (perf.drw / perf.frames).toFixed(1) + 'ms \u00b7 late ' + Math.round(perf.slow / perf.frames * 100) + '% \u00b7 res ' + RS + 'x \u00b7 ' +
        enemies.length + ' slimes \u00b7 ' + particles.length + ' fx';
    }
    perf.frames = 0; perf.slow = 0; perf.upd = 0; perf.drw = 0; perf.t0 = ts;
  }
  document.addEventListener('keydown', function (ev) {
    if ((ev.key || '').toUpperCase() !== 'F') return;
    perf.show = !perf.show;
    if (!perf.el) { perf.el = document.createElement('div'); perf.el.id = 'td-perf'; boardWrap.appendChild(perf.el); }
    perf.el.style.display = perf.show ? '' : 'none';
    perf.el.textContent = 'measuring\u2026';
  });

  function loop(ts) {
    const now = ts / 1000;
    const frameMs = last ? (now - last) * 1000 : 16;
    const dt = last ? Math.min(0.05, now - last) : 0;
    last = now;
    const t1 = performance.now();
    for (let i = 0; i < speed; i++) update(dt);
    const t2 = performance.now();
    draw();
    const t3 = performance.now();
    if (active()) perfTick(ts, frameMs, t2 - t1, t3 - t2);
    else perf.t0 = 0;
    if (active()) requestAnimationFrame(loop);
    else sleepTimer = setTimeout(function () { sleepTimer = null; requestAnimationFrame(loop); }, 100);
  }

  // Wall-clock countdown: keeps going even if the window is minimised.
  let lastSecs = null;
  setInterval(function () {
    if (running || gameOver || !nextWaveAt) return;
    if (Date.now() >= nextWaveAt) { startWave(); return; }
    const secs = secondsToWave();
    if (secs !== lastSecs) { lastSecs = secs; renderUI(); }
  }, 250);

  buildShop();
  scheduleNextWave();
  const rolledAtStart = ensureRun();
  refreshAll();
  if (rolledAtStart) commit(0, snapshot(), null);
  renderUI();
  if (rolledAtStart) showRunCard();
  if (!towers.length) toast('Pick a tower on the right, then click the map to build it.');
  if (mapId !== 'meadow') banner = { text: MAP.name.toUpperCase(), sub: MAP.rule, t0: time };
  requestAnimationFrame(loop);
})();
