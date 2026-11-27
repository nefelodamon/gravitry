// Gravitry random level generator.
// Builds a layout from a seed, rejects unstable ones (sources merging or leaving),
// then simulates sample drops to pick a target that roughly PASS_RATE of spots reach.
(function (root) {
  'use strict';
  const NS = root.Gravitry;
  const A = NS.ARENA;
  const TIME_LIMIT = 60;
  const PASS_RATE = 0.15;
  const SAMPLE_GRID = 11;     // ~121 sample drops (minus invalid spots)
  const MIN_TARGET = 600;
  const MAX_TRIES = 40;

  // Small, fast seeded PRNG.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeTools(rng) {
    const range = (lo, hi) => lo + rng() * (hi - lo);
    const int = (lo, hi) => Math.floor(range(lo, hi + 1));
    const pick = arr => arr[Math.floor(rng() * arr.length)];
    const sign = () => (rng() < 0.5 ? -1 : 1);
    return { range, int, pick, sign };
  }

  const radiusFor = m => Math.max(11, Math.round(16 * Math.sqrt(m / 1e6)));

  // Random points inside [lo, hi]^2 at least `sep` apart.
  function scatter(t, n, lo, hi, sep) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const pts = [];
      for (let i = 0; i < n && pts.length === i; i++) {
        for (let k = 0; k < 60; k++) {
          const p = { x: t.range(lo, hi), y: t.range(lo, hi) };
          if (pts.every(q => NS.dmath.hypot(p.x - q.x, p.y - q.y) >= sep)) { pts.push(p); break; }
        }
      }
      if (pts.length === n) return pts;
    }
    return null;
  }

  function orbiter(t, cx, cy, M, r) {
    const phase = t.range(0, Math.PI * 2), dir = t.sign();
    const s = NS.orbitSpeed(M, r) * t.range(0.88, 1.05) * dir;
    const mass = t.range(3e5, 9e5);
    return {
      x: cx + NS.dmath.cos(phase) * r, y: cy + NS.dmath.sin(phase) * r,
      vx: -NS.dmath.sin(phase) * s, vy: NS.dmath.cos(phase) * s,
      mass, radius: radiusFor(mass),
    };
  }

  const BUILDERS = {
    // A heavy anchored star with 1-3 moons.
    anchor(t) {
      const M = t.range(2e6, 3.5e6);
      const cx = t.range(400, 600), cy = t.range(400, 600);
      const out = [{ x: cx, y: cy, mass: M, radius: radiusFor(M), fixed: true }];
      const n = t.int(1, 3);
      const radii = [];
      while (radii.length < n) {
        const r = t.range(150, 360);
        if (radii.every(q => Math.abs(q - r) > 55)) radii.push(r);
      }
      for (const r of radii) out.push(orbiter(t, cx, cy, M, r));
      return out;
    },
    // 2-4 free stars swirling around their common centre.
    cluster(t) {
      const n = t.int(2, 4);
      const pts = scatter(t, n, 260, 740, 150);
      if (!pts) return null;
      const stars = pts.map(p => { const m = t.range(1e6, 2.5e6); return { ...p, mass: m, radius: radiusFor(m) }; });
      let M = 0, cx = 0, cy = 0;
      for (const s of stars) { M += s.mass; cx += s.x * s.mass; cy += s.y * s.mass; }
      cx /= M; cy /= M;
      const dir = t.sign();
      for (const s of stars) {
        const dx = s.x - cx, dy = s.y - cy, r = Math.max(60, NS.dmath.hypot(dx, dy));
        const sp = NS.orbitSpeed(M - s.mass, r) * t.range(0.35, 0.6) * dir;
        s.vx = -dy / r * sp; s.vy = dx / r * sp;
      }
      return stars;
    },
    // 1-2 anchored stars with free stars orbiting the pair.
    mixed(t) {
      const nf = t.int(1, 2);
      const pts = scatter(t, nf, 340, 660, 170);
      if (!pts) return null;
      const out = pts.map(p => { const m = t.range(1.5e6, 2.8e6); return { ...p, mass: m, radius: radiusFor(m), fixed: true }; });
      let M = 0, cx = 0, cy = 0;
      for (const s of out) { M += s.mass; cx += s.x * s.mass; cy += s.y * s.mass; }
      cx /= M; cy /= M;
      const nm = t.int(1, 2);
      for (let i = 0; i < nm; i++) out.push(orbiter(t, cx, cy, M, t.range(230, 370)));
      return out;
    },
    // 2-4 anchored wells.
    wells(t) {
      const n = t.int(2, 4);
      const pts = scatter(t, n, 200, 800, 190);
      if (!pts) return null;
      return pts.map(p => { const m = t.range(1.2e6, 2.5e6); return { ...p, mass: m, radius: radiusFor(m), fixed: true }; });
    },
    // An anchored black hole with 1-2 stars orbiting it.
    abyss(t) {
      const M = t.range(4e6, 8e6);
      const cx = t.range(420, 580), cy = t.range(420, 580);
      const out = [blackHole(cx, cy, M, true)];
      const n = 2;
      const radii = [];
      while (radii.length < n) {
        const r = t.range(180, 400);
        if (radii.every(q => Math.abs(q - r) > 110)) radii.push(r);
      }
      for (const r of radii) out.push(orbiter(t, cx, cy, M, r));
      return out;
    },
    // A black hole and a star circling each other, sometimes with a third star farther out.
    darkbinary(t) {
      const m1 = t.range(4e6, 8e6), m2 = t.range(8e5, 2e6);
      const M = m1 + m2, sep = t.range(230, 320), ang = t.range(0, Math.PI * 2), dir = t.sign();
      const w = Math.sqrt(NS.G * M / (sep * sep * sep)) * dir;
      const ux = NS.dmath.cos(ang), uy = NS.dmath.sin(ang);
      const d1 = sep * m2 / M, d2 = sep * m1 / M;
      const out = [
        { ...blackHole(500 - ux * d1, 500 - uy * d1, m1, false), vx: uy * w * d1, vy: -ux * w * d1 },
        { x: 500 + ux * d2, y: 500 + uy * d2, vx: -uy * w * d2, vy: ux * w * d2, mass: m2, radius: radiusFor(m2) },
      ];
      if (t.range(0, 1) < 0.4) {
        // a light star on a wide orbit around the pair
        const o = orbiter(t, 500, 500, M, t.range(400, 450));
        o.mass = t.range(2e5, 4e5); o.radius = radiusFor(o.mass);
        out.push(o);
      }
      return out;
    },
  };
  const KINDS = ['anchor', 'anchor', 'cluster', 'mixed', 'mixed', 'wells', 'abyss', 'abyss', 'darkbinary'];
  const BLACK_HOLE_CHANCE = 0.25;   // an anchor/mixed layout's anchored star becomes a black hole
  const COMET_CHANCE = 0.4;         // a layout gets a stream of comets

  // What random layouts may contain, as bits of a mask (the player picks them in Options).
  // Every decision about an optional feature draws from the seeded RNG only when that feature
  // is allowed, so a seed + mask always rebuilds the same layout. LEGACY_MASK (black holes +
  // comets) reproduces layouts from before the other features existed.
  const FEATURES = {
    blackholes: 1, comets: 2, pulsars: 4, whiteholes: 8, wormholes: 16,
    nebulae: 32, thrust: 64, slingshot: 128, zones: 256,
  };
  const ALL_FEATURES = 511, LEGACY_MASK = 3;
  const CHANCE = { pulsars: 0.3, whiteholes: 0.3, wormholes: 0.25, nebulae: 0.3, thrust: 0.2, slingshot: 0.2, zones: 0.2 };
  const THRUST_TARGET = 1.3;        // thrust layouts: nudges let players go further than plain drops

  function blackHole(x, y, mass, fixed) {
    return { x, y, mass, radius: NS.blackHoleRadius(mass), kind: 'blackhole', fixed: !!fixed };
  }

  // Swap an anchored star for a black hole about twice as heavy, keeping its moons on circular orbits.
  function darken(t, sources) {
    const i = sources.findIndex(s => s.fixed);
    if (i < 0) return;
    const s = sources[i];
    const k = t.range(1.8, 2.6);
    sources[i] = blackHole(s.x, s.y, s.mass * k, true);
    if (sources.filter(o => o.fixed).length === 1) {
      // free bodies orbit this anchor alone: scale their speed for the heavier mass
      for (const o of sources) if (!o.fixed) { o.vx *= Math.sqrt(k); o.vy *= Math.sqrt(k); }
    }
  }

  // A comet stream: enters from a random edge, aimed across the arena, a new one every few seconds.
  function cometStream(t) {
    const side = t.int(0, 3), along = t.range(150, 850), out = 230;
    const start = [
      { x: -out, y: along }, { x: A + out, y: along }, { x: along, y: -out }, { x: along, y: A + out },
    ][side];
    const aim = { x: t.range(250, 750), y: t.range(250, 750) };
    const dx = aim.x - start.x, dy = aim.y - start.y, d = NS.dmath.hypot(dx, dy);
    const sp = t.range(260, 340);
    return {
      x: start.x, y: start.y, vx: dx / d * sp, vy: dy / d * sp,
      mass: t.range(1e5, 2e5), radius: 6, kind: 'comet', every: t.int(5, 9),
    };
  }

  // A spot at least `gap` from every source surface (and from the given extra points).
  function freeSpot(t, sources, gap, lo, hi, extra) {
    for (let k = 0; k < 80; k++) {
      const p = { x: t.range(lo, hi), y: t.range(lo, hi) };
      if (sources.every(s => NS.dmath.hypot(p.x - s.x, p.y - s.y) > s.radius + gap) &&
          (extra || []).every(q => NS.dmath.hypot(p.x - q.x, p.y - q.y) > gap)) return p;
    }
    return null;
  }

  // Turn one moon (or, failing that, an anchored star) into a pulsar.
  function pulsarize(t, sources) {
    const plain = s => !s.kind || s.kind === 'star';
    const moons = sources.filter(s => plain(s) && !s.fixed);
    const anchors = sources.filter(s => plain(s) && s.fixed);
    const s = moons.length ? t.pick(moons) : anchors.length ? t.pick(anchors) : null;
    if (!s) return;
    s.kind = 'pulsar';
    s.radius = 8;
    s.pulse = { period: Math.round(t.range(2.5, 5) * 2) / 2, amp: s.fixed ? 0.4 : 0.6 };
    if (!s.fixed) s.mass *= 1.6;    // a light moon's pulse would hardly be felt
  }

  function describe(sources, wormholes, nebulae, extras) {
    const stars = sources.filter(s => !s.kind || s.kind === 'star');
    const fixed = stars.filter(s => s.fixed).length;
    const free = stars.length - fixed;
    const parts = [];
    if (fixed) parts.push(`${fixed} anchored`);
    if (free) parts.push(`${free} moving`);
    const bits = [];
    if (stars.length) bits.push(`${stars.length} star${stars.length === 1 ? '' : 's'} (${parts.join(', ')})`);
    const holes = sources.filter(s => s.kind === 'blackhole').length;
    const comets = sources.filter(s => s.kind === 'comet').length;
    const worms = wormholes ? wormholes.length : 0;
    if (holes) bits.push(`${holes} black hole${holes === 1 ? '' : 's'}`);
    if (comets) bits.push(`${comets} comet${comets === 1 ? '' : 's'}`);
    if (worms) bits.push(`${worms} wormhole${worms === 1 ? '' : 's'}`);
    const pulsars = sources.filter(s => s.kind === 'pulsar').length;
    const whites = sources.filter(s => s.kind === 'whitehole').length;
    const nebs = nebulae ? nebulae.length : 0;
    if (pulsars) bits.push(`${pulsars} pulsar${pulsars === 1 ? '' : 's'}`);
    if (whites) bits.push(`${whites} white hole${whites === 1 ? '' : 's'}`);
    if (nebs) bits.push(`${nebs} nebula${nebs === 1 ? '' : 'e'}`);
    let tail = '';
    if (extras && extras.launch) tail += ' Slingshot: drag to launch.';
    if (extras && extras.thrust) tail += ` ${extras.thrust.count} thruster nudges: click while flying.`;
    if (extras && extras.zones) tail += ' Red circles: no dropping there.';
    return `${bits.join(', ')}.${tail} Press N for a new layout.`;
  }

  // Path lengths reached from a jittered grid of drop spots.
  function samplePaths(level, t) {
    const paths = [];
    const cell = A / SAMPLE_GRID;
    for (let gy = 0; gy < SAMPLE_GRID; gy++) {
      for (let gx = 0; gx < SAMPLE_GRID; gx++) {
        const x = (gx + t.range(0.15, 0.85)) * cell, y = (gy + t.range(0.15, 0.85)) * cell;
        const w = new NS.World(level);
        w.trackOrbit = () => false;   // sample the full run, not an early steady-orbit stop
        let vx = 0, vy = 0;
        if (level.launch) { const a = t.range(0, Math.PI * 2), sp = t.range(70, 250); vx = NS.dmath.cos(a) * sp; vy = NS.dmath.sin(a) * sp; }
        if (!w.place(x, y, vx, vy)) continue;
        while (w.status === 'running') w.step();
        paths.push(w.path);
      }
    }
    return paths;
  }

  function generateLevel(seed, mask) {
    if (mask == null) mask = ALL_FEATURES;
    const on = f => (mask & FEATURES[f]) !== 0;
    const kinds = on('blackholes') ? KINDS : KINDS.filter(k => k !== 'abyss' && k !== 'darkbinary');
    const t = makeTools(mulberry32(seed));
    let kind = t.pick(kinds);
    for (let tries = 0; tries < MAX_TRIES; tries++) {
      // Retry the same kind a few times so moving layouts (rejected more often) aren't crowded out.
      if (tries > 0 && tries % 10 === 0) kind = t.pick(kinds);
      const sources = BUILDERS[kind](t);
      if (!sources) continue;
      if (on('blackholes') && (kind === 'anchor' || kind === 'mixed') && t.range(0, 1) < BLACK_HOLE_CHANCE) darken(t, sources);
      if (on('comets') && t.range(0, 1) < COMET_CHANCE) {
        sources.push(cometStream(t));
        if (t.range(0, 1) < 0.25) sources.push(cometStream(t));
      }
      const extra = {};
      const roll = f => on(f) && t.range(0, 1) < CHANCE[f];
      if (roll('pulsars')) pulsarize(t, sources);
      const solid = sources.filter(s => s.kind !== 'comet');
      if (roll('whiteholes')) {
        const n = t.range(0, 1) < 0.3 ? 2 : 1, spots = [];
        for (let i = 0; i < n; i++) {
          const p = freeSpot(t, solid, 170, 120, 880, spots);
          if (p) { spots.push(p); sources.push({ x: p.x, y: p.y, mass: t.range(1e6, 2.5e6), radius: 11, kind: 'whitehole', fixed: true }); }
        }
      }
      if (roll('wormholes')) {
        const a = freeSpot(t, solid, 120, 100, 900), b = a && freeSpot(t, solid, 120, 100, 900, [{ x: a.x, y: a.y }]);
        if (a && b && NS.dmath.hypot(a.x - b.x, a.y - b.y) > 350) extra.wormholes = [{ ax: a.x, ay: a.y, bx: b.x, by: b.y, r: Math.round(t.range(26, 34)) }];
      }
      if (roll('nebulae')) {
        const around = t.range(0, 1) < 0.6 ? t.pick(solid) : null;
        const c = around || { x: t.range(250, 750), y: t.range(250, 750) };
        extra.nebulae = [{ x: c.x, y: c.y, r: Math.round(t.range(140, 240)), drag: Math.round(t.range(0.2, 0.5) * 100) / 100 }];
      }
      if (roll('thrust')) extra.thrust = { count: t.int(2, 3) };
      if (roll('slingshot')) extra.launch = { max: 260 };
      if (roll('zones')) {
        const anchors = solid.filter(s => s.fixed);
        const c = anchors.length ? t.pick(anchors) : { x: 500, y: 500 };
        extra.noPlaceZones = [{ x: c.x, y: c.y, r: Math.round(t.range(130, 220)) }];
      }
      const noFixed = sources.every(s => !s.fixed);
      const level = Object.assign({
        name: `Random #${seed}`,
        hint: describe(sources, extra.wormholes, extra.nebulae, { launch: extra.launch, thrust: extra.thrust, zones: extra.noPlaceZones }),
        target: Infinity,
        timeLimit: TIME_LIMIT,
        zeroMomentum: noFixed,
        sources,
      }, extra);
      if (!new NS.World(level).sourcesStayPut(TIME_LIMIT * 0.6, 60)) continue;

      const paths = samplePaths(level, t).sort((a, b) => b - a);
      if (paths.length < 40) continue;
      const k = Math.max(1, Math.round(PASS_RATE * paths.length));
      let target = Math.floor(paths[k - 1] / 50) * 50;
      if (target < MIN_TARGET) continue;
      if (level.thrust) target = Math.floor(target * THRUST_TARGET / 50) * 50;
      return Object.assign(level, { target, seed, kind, mask });
    }
    // Extremely unlikely fallback: a simple, known-good layout.
    return {
      name: `Random #${seed}`, hint: 'A quiet one. Press N for a new layout.', seed, kind: 'fallback', mask,
      target: 1000, timeLimit: TIME_LIMIT,
      sources: [
        { x: 500, y: 500, mass: 3e6, radius: 28, fixed: true },
        { x: 500, y: 250, vx: NS.orbitSpeed(3e6, 250), vy: 0, mass: 6e5, radius: 14 },
      ],
    };
  }

  // Fair target for any layout (used by the editor's "Auto" button).
  function suggestTarget(def, passRate) {
    const t = makeTools(mulberry32(12345));
    const level = Object.assign({}, def, { target: Infinity });
    const paths = samplePaths(level, t).sort((a, b) => b - a);
    if (!paths.length) return null;
    const k = Math.max(1, Math.round((passRate || PASS_RATE) * paths.length));
    return Math.max(100, Math.floor(paths[k - 1] / 50) * 50);
  }

  NS.generateLevel = generateLevel;
  NS.suggestTarget = suggestTarget;
  NS.radiusFor = radiusFor;
  NS.describeLevel = describe;
  NS.RANDOM_FEATURES = FEATURES;
  NS.RANDOM_ALL = ALL_FEATURES;
  NS.RANDOM_LEGACY = LEGACY_MASK;
  NS.randomSeed = () => 1 + Math.floor(Math.random() * 999999);
})(typeof window !== 'undefined' ? window : globalThis);
