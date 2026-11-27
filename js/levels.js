// Gravitry levels. Coordinates are in the 1000x1000 arena; y grows downward.
// target = path length (arena units) the particle must travel to pass.
(function (root) {
  'use strict';
  const NS = root.Gravitry;
  const v = NS.orbitSpeed;

  // Two free bodies on circular orbits around their common centre.
  function binary(cx, cy, m1, m2, sep, angle, r1, r2) {
    const M = m1 + m2;
    const d1 = sep * m2 / M, d2 = sep * m1 / M;
    const w = Math.sqrt(NS.G * M / (sep * sep * sep)); // angular speed
    const ux = NS.dmath.cos(angle), uy = NS.dmath.sin(angle);
    return [
      { x: cx - ux * d1, y: cy - uy * d1, vx: uy * w * d1, vy: -ux * w * d1, mass: m1, radius: r1 },
      { x: cx + ux * d2, y: cy + uy * d2, vx: -uy * w * d2, vy: ux * w * d2, mass: m2, radius: r2 },
    ];
  }

  // Free body orbiting a fixed anchor at (ax, ay); phase in radians.
  function moon(ax, ay, M, r, phase, mass, radius, dir) {
    const s = v(M, r) * (dir || 1);
    const c = NS.dmath.cos(phase), sn = NS.dmath.sin(phase);
    return { x: ax + c * r, y: ay + sn * r, vx: -sn * s, vy: c * s, mass, radius };
  }

  // A black hole: very heavy with a small event horizon.
  function bh(x, y, mass, fixed) {
    return { x, y, mass, radius: NS.blackHoleRadius(mass), kind: 'blackhole', fixed: !!fixed };
  }

  // A pulsar: a tiny star whose mass pulses (default: ±60% every 4 s).
  function pulsar(x, y, mass, fixed, period) {
    const p = { x, y, mass, radius: 8, kind: 'pulsar', fixed: !!fixed };
    if (period) p.pulse = { period };
    return p;
  }

  // A white hole: pushes the particle (and comets) away; always fixed.
  function whiteHole(x, y, mass) {
    return { x, y, mass, radius: 11, kind: 'whitehole', fixed: true };
  }

  // A comet: light and fast. With `every` set, a new one follows the same course every N seconds.
  function comet(x, y, vx, vy, every, mass) {
    const c = { x, y, vx, vy, mass: mass || 3e5, radius: 6, kind: 'comet' };
    if (every) c.every = every;
    return c;
  }

  NS.LEVELS = [
    {
      name: 'First Fall',
      hint: 'Click anywhere to drop the particle. Further away = longer fall.',
      target: 450,
      sources: [{ x: 500, y: 500, mass: 3e6, radius: 30, fixed: true }],
    },
    {
      name: 'Twin Wells',
      hint: 'Two anchored wells. Find a spot where neither one wins quickly.',
      target: 1400,
      sources: [
        { x: 330, y: 500, mass: 2e6, radius: 24, fixed: true },
        { x: 670, y: 500, mass: 2e6, radius: 24, fixed: true },
      ],
    },
    {
      name: 'Binary',
      hint: 'Two stars dance. Nothing here stands still.',
      target: 1300,
      sources: binary(500, 500, 2e6, 2e6, 220, 0, 22, 22),
    },
    {
      name: 'The Moon',
      hint: 'A moon circles the star. Let it pull you sideways.',
      target: 550,
      sources: [
        { x: 500, y: 500, mass: 3e6, radius: 28, fixed: true },
        moon(500, 500, 3e6, 260, -Math.PI / 2, 6e5, 14),
      ],
    },
    {
      name: 'Lopsided',
      hint: 'A heavy star and a light companion.',
      target: 1050,
      sources: binary(500, 500, 3.5e6, 8e5, 320, Math.PI / 5, 30, 14),
    },
    {
      name: 'Trinity',
      hint: 'Three anchored wells in a triangle.',
      target: 1900,
      sources: [
        { x: 500, y: 290, mass: 1.6e6, radius: 22, fixed: true },
        { x: 318, y: 605, mass: 1.6e6, radius: 22, fixed: true },
        { x: 682, y: 605, mass: 1.6e6, radius: 22, fixed: true },
      ],
    },
    {
      name: 'Wanderer',
      hint: 'A rogue star drifts across the anchored one.',
      target: 800,
      sources: [
        { x: 500, y: 560, mass: 3e6, radius: 28, fixed: true },
        { x: 120, y: 220, vx: 55, vy: 10, mass: 1.5e6, radius: 20 },
      ],
    },
    {
      name: 'Two Moons',
      hint: 'Moons on opposite courses.',
      target: 1150,
      sources: [
        { x: 500, y: 500, mass: 3e6, radius: 28, fixed: true },
        moon(500, 500, 3e6, 200, 0, 5e5, 13, 1),
        moon(500, 500, 3e6, 330, Math.PI, 5e5, 13, -1),
      ],
    },
    {
      name: 'Keep Out',
      hint: 'You may only start in the corners.',
      target: 2800,
      sources: binary(500, 500, 2.2e6, 1.8e6, 260, Math.PI / 4, 23, 21),
      noPlaceZones: [{ x: 500, y: 500, r: 520 }],
    },
    {
      name: 'Heavy Dance',
      hint: 'A tight, fast binary. Timing is everything.',
      target: 2000,
      sources: binary(500, 500, 4e6, 4e6, 180, Math.PI / 2, 28, 28),
    },
    {
      name: 'Chaos',
      hint: 'Four free stars. Good luck predicting this one.',
      target: 1650,
      zeroMomentum: true,
      sources: [
        { x: 340, y: 360, vx: 40, vy: -55, mass: 1.5e6, radius: 20 },
        { x: 660, y: 340, vx: 60, vy: 35, mass: 1.2e6, radius: 18 },
        { x: 650, y: 660, vx: -45, vy: 50, mass: 1.6e6, radius: 21 },
        { x: 350, y: 640, vx: -55, vy: -35, mass: 1.3e6, radius: 19 },
      ],
    },
    {
      name: 'Maelstrom',
      hint: 'Anchor, binary, and a stray. 60 seconds on the clock.',
      target: 1350,
      timeLimit: 60,
      sources: [
        { x: 500, y: 500, mass: 2.5e6, radius: 26, fixed: true },
        ...binary(500, 500, 6e5, 6e5, 90, 0, 12, 12).map(s => ({
          ...s, x: s.x, y: s.y - 280, vx: s.vx + v(2.5e6, 280), vy: s.vy,
        })),
        moon(500, 500, 2.5e6, 380, Math.PI / 2, 4e5, 11, -1),
      ],
      noPlaceZones: [{ x: 500, y: 500, r: 180 }],
    },

    // ---------- black holes, comets and wormholes ----------
    {
      name: 'Event Horizon',
      hint: 'A black hole: tiny, dark and very heavy. Only the black centre is deadly; the disk is just hot gas.',
      target: 550,
      sources: [
        bh(500, 500, 8e6, true),
        moon(500, 500, 8e6, 290, -Math.PI / 2, 9e5, 15),
      ],
    },
    {
      name: 'Comet Season',
      hint: 'A comet sweeps between the stars every 6 seconds. Use its tug, but don\'t get hit.',
      target: 1900,
      sources: [
        { x: 300, y: 580, mass: 2e6, radius: 24, fixed: true },
        { x: 700, y: 580, mass: 2e6, radius: 24, fixed: true },
        comet(-230, 120, 280, 180, 6),
      ],
    },
    {
      name: 'Wormhole',
      hint: 'Fall into one mouth and come out of the other, still moving the same way.',
      target: 1950,
      sources: [
        { x: 250, y: 500, mass: 1.8e6, radius: 22, fixed: true },
        { x: 750, y: 500, mass: 1.8e6, radius: 22, fixed: true },
      ],
      wormholes: [{ ax: 350, ay: 470, bx: 650, by: 530, r: 34 }],
    },
    {
      name: 'Dark Binary',
      hint: 'A star caught in orbit around a black hole.',
      target: 1150,
      sources: binary(500, 500, 6e6, 1.2e6, 300, Math.PI / 6, 10, 18).map((s, i) => (i === 0 ? { ...s, kind: 'blackhole' } : s)),
    },
    {
      name: 'Crossfire',
      hint: 'Two comet streams cross over a lone star.',
      target: 1000,
      sources: [
        { x: 500, y: 500, mass: 2.6e6, radius: 26, fixed: true },
        moon(500, 500, 2.6e6, 250, Math.PI / 2, 5e5, 13),
        comet(-200, 330, 300, 20, 6),
        comet(760, -220, -30, 300, 8),
      ],
    },
    {
      name: 'Gateway',
      hint: 'A black hole guards the middle. The wormhole is a way out, and a way back in.',
      target: 550,
      sources: [bh(500, 500, 9e6, true)],
      wormholes: [
        { ax: 500, ay: 320, bx: 860, by: 860, r: 36 },
        { ax: 330, ay: 590, bx: 140, by: 140, r: 36 },
      ],
    },
    {
      name: 'Twin Singularity',
      hint: 'Two black holes locked together. A comet passes every 9 seconds.',
      target: 2800,
      sources: [
        ...binary(500, 500, 5e6, 5e6, 240, Math.PI / 3, 9, 9).map(s => ({ ...s, kind: 'blackhole' })),
        comet(1220, 760, -320, -40, 9),
      ],
    },
    {
      name: 'Swarm',
      hint: 'A binary star in a comet shower.',
      target: 1950,
      sources: [
        ...binary(500, 500, 2e6, 2e6, 220, 0, 22, 22),
        comet(-220, 180, 300, 60, 5),
        comet(1220, 820, -300, -50, 6),
        comet(300, 1230, 40, -310, 7),
      ],
    },
    {
      name: 'Labyrinth',
      hint: 'Three anchored wells and two wormholes. No dropping in the middle.',
      target: 2500,
      sources: [
        { x: 500, y: 270, mass: 1.6e6, radius: 22, fixed: true },
        { x: 300, y: 620, mass: 1.6e6, radius: 22, fixed: true },
        { x: 700, y: 620, mass: 1.6e6, radius: 22, fixed: true },
      ],
      wormholes: [
        { ax: 500, ay: 130, bx: 500, by: 860, r: 30 },
        { ax: 170, ay: 380, bx: 830, by: 380, r: 30 },
      ],
      noPlaceZones: [{ x: 500, y: 500, r: 190 }],
    },
    {
      name: 'Singularity',
      hint: 'Everything at once. 75 seconds on the clock.',
      target: 1550,
      timeLimit: 75,
      sources: [
        bh(500, 500, 1e7, true),
        moon(500, 500, 1e7, 230, 0, 8e5, 15, 1),
        moon(500, 500, 1e7, 370, Math.PI, 6e5, 13, -1),
        comet(-220, 120, 330, 70, 8, 1e5),
      ],
      wormholes: [{ ax: 300, ay: 700, bx: 820, by: 180, r: 30 }],
    },

    // ---------- slingshot: press, drag to aim, release to launch ----------
    {
      name: 'First Shot',
      hint: 'Slingshot! Press, drag in the direction to throw, release. Swing into orbit — tighter, faster orbits go further.',
      target: 950,
      launch: { max: 260 },
      sources: [{ x: 500, y: 500, mass: 3e6, radius: 28, fixed: true }],
    },
    {
      name: 'Slingshot',
      hint: 'Launch past the binary and let it fling you.',
      target: 1550,
      launch: { max: 260 },
      sources: binary(500, 500, 2.5e6, 2.5e6, 200, 0, 24, 24),
    },
    {
      name: 'Horizon Skimmer',
      hint: 'Skim the black hole as close as you dare.',
      target: 6950,
      launch: { max: 260 },
      sources: [
        bh(500, 500, 8e6, true),
        moon(500, 500, 8e6, 300, Math.PI, 9e5, 15),
      ],
    },
    {
      name: 'Comet Rider',
      hint: 'A star, its moon, and a comet every 6 seconds. Launch and dodge.',
      target: 2000,
      launch: { max: 260 },
      sources: [
        { x: 500, y: 520, mass: 2.6e6, radius: 26, fixed: true },
        moon(500, 520, 2.6e6, 240, -Math.PI / 2, 5e5, 13, -1),
        comet(-220, 900, 300, -40, 6, 5e4),
      ],
    },
    {
      name: 'Through the Gate',
      hint: 'Aim for a wormhole mouth and come out on the other side.',
      target: 2900,
      launch: { max: 260 },
      sources: [
        { x: 300, y: 500, mass: 1.8e6, radius: 22, fixed: true },
        { x: 700, y: 500, mass: 1.8e6, radius: 22, fixed: true },
      ],
      wormholes: [{ ax: 500, ay: 190, bx: 500, by: 810, r: 32 }],
    },
    {
      name: 'Grand Tour',
      hint: 'A black hole with two moons going opposite ways. Start outside the ring. 75 seconds.',
      target: 3650,
      timeLimit: 75,
      launch: { max: 260 },
      sources: [
        bh(500, 500, 6e6, true),
        moon(500, 500, 6e6, 240, 0, 7e5, 14, 1),
        moon(500, 500, 6e6, 400, Math.PI / 2, 5e5, 12, -1),
      ],
      noPlaceZones: [{ x: 500, y: 500, r: 210 }],
    },

    // ---------- pulsars, white holes, nebulae and thrusters ----------
    {
      name: 'Lighthouse',
      hint: 'A pulsar: its pull beats strong and weak every 4 seconds. Its moon swings wide and close with the beat.',
      target: 600,
      sources: [
        pulsar(500, 500, 2.5e6, true),
        moon(500, 500, 2.5e6, 250, 0, 4e5, 13, 1),
      ],
    },
    {
      name: 'Heartbeat',
      hint: 'A pulsar circles a star. Its pulse tugs the orbit out of shape.',
      target: 900,
      sources: [
        { x: 500, y: 500, mass: 2.4e6, radius: 26, fixed: true },
        Object.assign(moon(500, 500, 2.4e6, 260, 0, 6e5, 7, 1), { kind: 'pulsar', pulse: { period: 3, amp: 0.6 } }),
      ],
    },
    {
      name: 'Repulsor',
      hint: 'A white hole pushes you away. Fall past it and let it bend you around the star.',
      target: 1100,
      sources: [
        { x: 500, y: 620, mass: 2.5e6, radius: 26, fixed: true },
        whiteHole(500, 330, 2.5e6),
      ],
    },
    {
      name: 'Pinball',
      hint: 'Four white holes guard a black hole. Bounce between them.',
      target: 1400,
      sources: [
        bh(500, 500, 6e6, true),
        whiteHole(240, 240, 1.2e6), whiteHole(760, 240, 1.2e6),
        whiteHole(240, 760, 1.2e6), whiteHole(760, 760, 1.2e6),
      ],
    },
    {
      name: 'Fog Bank',
      hint: 'A binary hidden in a nebula. The gas slows you down while you are in it.',
      target: 850,
      sources: binary(500, 500, 2e6, 2e6, 220, 0.5, 22, 22),
      nebulae: [{ x: 500, y: 500, r: 230, drag: 0.25 }],
    },
    {
      name: 'First Burn',
      hint: 'Thrusters! While flying, click or tap to fire toward that spot (or arrow keys). 3 nudges: push sideways to stay in orbit.',
      target: 2000,
      thrust: { count: 3 },
      sources: [{ x: 500, y: 500, mass: 3e6, radius: 28, fixed: true }],
    },
    {
      name: 'Course Correction',
      hint: 'Slingshot launch, then 2 thruster nudges to fix your course around the black hole.',
      target: 3600,
      launch: { max: 260 },
      thrust: { count: 2 },
      sources: [
        bh(500, 500, 6e6, true),
        moon(500, 500, 6e6, 280, Math.PI / 2, 8e5, 15, 1),
      ],
    },
    {
      name: 'Deep Field',
      hint: 'A pulsar, a white hole and a star in a nebula. 3 nudges.',
      target: 1200,
      thrust: { count: 3 },
      sources: [
        pulsar(340, 400, 1.6e6, true),
        { x: 650, y: 640, mass: 2e6, radius: 24, fixed: true },
        whiteHole(740, 250, 1.8e6),
      ],
      nebulae: [{ x: 650, y: 640, r: 190, drag: 0.4 }],
    },
  ];
})(typeof window !== 'undefined' ? window : globalThis);
