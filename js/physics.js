// Gravitry physics: pairwise Newtonian gravity, velocity-Verlet, fixed timestep.
// Works in the browser (window.Gravitry) and headless (globalThis.Gravitry).
(function (root) {
  'use strict';
  const NS = (root.Gravitry = root.Gravitry || {});

  const G = 1;                 // gravitational constant (world units)
  const SOFT2 = 4 * 4;         // softening^2 to keep close passes stable
  const DT = 1 / 240;          // fixed simulation step (seconds)
  const ARENA = 1000;          // logical arena is ARENA x ARENA
  const PARTICLE_MASS = 1e4;   // tiny vs sources, but they still feel it
  const PARTICLE_RADIUS = 5;
  const PLACE_CLEARANCE = 25;  // min gap between a placed particle and a source edge
  const DEFAULT_TIME_LIMIT = 90;
  const PARTICLE_TRAIL_MAX = 2400;
  const SOURCE_TRAIL_MAX = 500;
  const ESCAPE_CONFIRM = 1.5;  // seconds of "outside + unbound + receding" before a run ends
  const MAX_DISTANCE = 12000;  // hard cap from the arena centre
  const ORBIT_REVS = 3;        // revolutions that must repeat before an orbit counts as steady
  const COMET_DESPAWN = 2600;  // comets farther than this from the arena centre are removed
  const WORMHOLE_R = 24;       // default wormhole mouth radius
  const ORBIT_TOL = 0.02;      // allowed spread (2%) in closest/farthest distance and period
  const PULSE_PERIOD = 4;      // pulsar default: seconds per pulse ...
  const PULSE_AMP = 0.6;       // ... and how far the mass swings (±60%)
  const NEBULA_DRAG = 0.6;     // nebula default: velocity damping per second at the cloud's centre
  const THRUST_DV = 70;        // thruster default: speed added per nudge

  // ---------- deterministic math ----------
  // Browsers may round Math.sin/cos/exp/atan2/hypot/pow differently in the last bit, and
  // chaotic orbits magnify that. Everything that feeds the simulation uses these instead:
  // they use only + - * / and Math.sqrt, which every browser must round identically
  // (IEEE 754; JavaScript never fuses multiply-adds), so results match everywhere.
  const HALF_PI = 1.5707963267948966, QUARTER_PI = 0.7853981633974483;
  const LN2_HI = 0.6931471803691238, LN2_LO = 1.9082149292705877e-10;
  // sin and cos on [-π/4, π/4]: Taylor series, error far below one unit in the last place
  function sinPoly(x) {
    const x2 = x * x;
    return x * (1 + x2 * (-1 / 6 + x2 * (1 / 120 + x2 * (-1 / 5040 + x2 * (1 / 362880 + x2 * (-1 / 39916800 + x2 * (1 / 6227020800 + x2 * (-1 / 1307674368000))))))));
  }
  function cosPoly(x) {
    const x2 = x * x;
    return 1 + x2 * (-1 / 2 + x2 * (1 / 24 + x2 * (-1 / 720 + x2 * (1 / 40320 + x2 * (-1 / 3628800 + x2 * (1 / 479001600 + x2 * (-1 / 87178291200)))))));
  }
  // reduce to [-π/4, π/4] plus a quarter-turn count. π/2 is split into three parts whose
  // products with q are exact (Cody-Waite), so the reduction stays accurate for large x.
  const PIO2_1 = 1.5707963267341256, PIO2_2 = 6.077100506303966e-11, PIO2_3 = 2.0222662487111665e-21;
  function quadrant(x) {
    const q = Math.round(x / HALF_PI);
    const r = ((x - q * PIO2_1) - q * PIO2_2) - q * PIO2_3;
    return [r, ((q % 4) + 4) % 4];
  }
  function dsin(x) {
    const [r, q] = quadrant(x);
    return q === 0 ? sinPoly(r) : q === 1 ? cosPoly(r) : q === 2 ? -sinPoly(r) : -cosPoly(r);
  }
  function dcos(x) {
    const [r, q] = quadrant(x);
    return q === 0 ? cosPoly(r) : q === 1 ? -sinPoly(r) : q === 2 ? -cosPoly(r) : sinPoly(r);
  }
  // e^x = 2^k · e^r with |r| ≤ ln2/2; 2^k built by exact doubling/halving
  function dexp(x) {
    if (x !== x) return x;
    if (x > 709) return Infinity;
    if (x < -745) return 0;
    const k = Math.round(x / 0.6931471805599453);
    const r = (x - k * LN2_HI) - k * LN2_LO;
    let sum = 1;                                    // Horner: 1 + r(1 + r/2(1 + r/3(...)))
    for (let n = 18; n >= 1; n--) sum = 1 + sum * r / n;
    let p = 1;
    if (k > 0) for (let i = 0; i < k; i++) p *= 2; else for (let i = 0; i < -k; i++) p *= 0.5;
    return sum * p;
  }
  // atan on [-1, 1]: shift by π/4 when |t| > tan(π/8), then a series in t (|t| ≤ 0.4143)
  function datanUnit(t) {
    let shift = 0;
    if (t > 0.41421356237309503) { shift = QUARTER_PI; t = (t - 1) / (t + 1); }
    else if (t < -0.41421356237309503) { shift = -QUARTER_PI; t = (t + 1) / (1 - t); }
    const t2 = t * t;
    let sum = 0, pw = t;
    for (let n = 0; n < 24; n++) { sum += (n % 2 ? -pw : pw) / (2 * n + 1); pw *= t2; }
    return shift + sum;
  }
  function datan2(y, x) {
    if (x === 0 && y === 0) return 0;
    if (Math.abs(x) >= Math.abs(y)) {
      const a = datanUnit(y / x);
      return x > 0 ? a : y >= 0 ? a + Math.PI : a - Math.PI;
    }
    const a = datanUnit(x / y);
    return y > 0 ? HALF_PI - a : -HALF_PI - a;
  }
  const dhypot = (x, y) => Math.sqrt(x * x + y * y);
  NS.dmath = { sin: dsin, cos: dcos, exp: dexp, atan2: datan2, hypot: dhypot };

  function makeBody(o) {
    return {
      x: o.x, y: o.y,
      vx: o.vx || 0, vy: o.vy || 0,
      ax: 0, ay: 0,
      mass: o.mass,
      radius: o.radius,
      fixed: !!o.fixed || o.kind === 'whitehole',   // white holes never move
      kind: o.kind || 'star',    // 'star' | 'blackhole' | 'comet' | 'pulsar' | 'whitehole'
      isParticle: !!o.isParticle,
      trail: [],
      // pulsar: mass swings around base as base·(1 + amp·sin(2πt/period))
      pulse: o.kind === 'pulsar' ? { period: (o.pulse && o.pulse.period) || PULSE_PERIOD, amp: o.pulse && o.pulse.amp != null ? o.pulse.amp : PULSE_AMP } : null,
      base: o.mass,
    };
  }

  // White holes push the particle and comets away and leave everything else alone.
  const pushedByWhite = b => b.isParticle || b.kind === 'comet';

  function computeAcc(bodies) {
    for (let i = 0; i < bodies.length; i++) { bodies[i].ax = 0; bodies[i].ay = 0; }
    for (let i = 0; i < bodies.length; i++) {
      const a = bodies[i];
      for (let j = i + 1; j < bodies.length; j++) {
        const b = bodies[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const r2 = dx * dx + dy * dy + SOFT2;
        const inv = G / (r2 * Math.sqrt(r2));
        if (a.kind === 'whitehole' || b.kind === 'whitehole') {
          if (a.kind === 'whitehole' && b.kind !== 'whitehole' && pushedByWhite(b)) { b.ax += a.mass * dx * inv; b.ay += a.mass * dy * inv; }
          else if (b.kind === 'whitehole' && a.kind !== 'whitehole' && pushedByWhite(a)) { a.ax -= b.mass * dx * inv; a.ay -= b.mass * dy * inv; }
          continue;
        }
        if (!a.fixed) { a.ax += b.mass * dx * inv; a.ay += b.mass * dy * inv; }
        if (!b.fixed) { b.ax -= a.mass * dx * inv; b.ay -= a.mass * dy * inv; }
      }
    }
  }

  function World(level) {
    this.level = level;
    this.sources = level.sources.map(makeBody);
    this.sources.forEach((s, i) => { s.variant = i; }); // stable per-star look for the renderer
    if (level.zeroMomentum) zeroMomentum(this.sources);
    this.bodies = this.sources.slice();
    // Comets with `every` set come back: a fresh copy launches from the same spot every N seconds.
    this.cometSpawns = level.sources
      .map((o, i) => ({ o, i }))
      .filter(c => c.o.kind === 'comet' && c.o.every > 0)
      .map(c => ({ def: c.o, variant: c.i, next: c.o.every }));
    this.wormholes = (level.wormholes || []).map(w => ({ ax: w.ax, ay: w.ay, bx: w.bx, by: w.by, r: w.r || WORMHOLE_R }));
    this.nebulae = (level.nebulae || []).map(n => ({ x: n.x, y: n.y, r: n.r, drag: n.drag != null ? n.drag : NEBULA_DRAG }));
    this.hasPulsars = this.sources.some(s => s.pulse);
    // thruster nudges: live ones are recorded; replays schedule them by step number
    this.thrust = level.thrust && level.thrust.count > 0
      ? { count: level.thrust.count, dv: level.thrust.dv || THRUST_DV } : null;
    this.nudgesLeft = this.thrust ? this.thrust.count : 0;
    this.nudges = [];
    this.scheduled = null;
    this.particle = null;
    this.zones = level.noPlaceZones || [];
    this.target = level.target;
    this.timeLimit = level.timeLimit || DEFAULT_TIME_LIMIT;
    this.time = 0;
    this.path = 0;
    this.steps = 0;
    this.status = 'placing'; // placing | running | crashed | escaped | orbit | timeout
    computeAcc(this.bodies);
  }

  // Remove net drift of free sources so the system stays on screen.
  function zeroMomentum(sources) {
    let px = 0, py = 0, m = 0;
    // comets are only passing through: leave them out
    const free = sources.filter(s => !s.fixed && s.kind !== 'comet');
    for (const s of free) { px += s.mass * s.vx; py += s.mass * s.vy; m += s.mass; }
    if (!m) return;
    for (const s of free) { s.vx -= px / m; s.vy -= py / m; }
  }

  World.prototype.canPlace = function (x, y) {
    const m = PARTICLE_RADIUS + 2;
    if (x < m || y < m || x > ARENA - m || y > ARENA - m) return false;
    for (const s of this.sources) {
      if (dhypot(x - s.x, y - s.y) < s.radius + PLACE_CLEARANCE) return false;
    }
    for (const z of this.zones) {
      if (dhypot(x - z.x, y - z.y) < z.r) return false;
    }
    for (const w of this.wormholes) {
      if (dhypot(x - w.ax, y - w.ay) < w.r + 12 || dhypot(x - w.bx, y - w.by) < w.r + 12) return false;
    }
    return true;
  };

  // vx, vy: optional launch velocity (slingshot levels); 0 = dropped at rest.
  World.prototype.place = function (x, y, vx, vy) {
    if (this.status !== 'placing' || !this.canPlace(x, y)) return false;
    this.topSpeed = dhypot(vx || 0, vy || 0);
    this.particle = makeBody({ x, y, vx: vx || 0, vy: vy || 0, mass: PARTICLE_MASS, radius: PARTICLE_RADIUS, isParticle: true });
    this.particle.trail.push(x, y);
    this.start = { x, y, vx: vx || 0, vy: vy || 0 };
    this.bodies.push(this.particle);
    computeAcc(this.bodies);
    this.status = 'running';
    return true;
  };

  // Pulsars: set each pulsar's mass for time t.
  function updatePulsars(sources, t) {
    for (const s of sources) {
      if (s.pulse) s.mass = s.base * (1 + s.pulse.amp * dsin(2 * Math.PI * t / s.pulse.period));
    }
  }

  // Thruster nudge toward direction (ux, uy) (normalised here). Returns the velocity added, or null.
  World.prototype.nudge = function (ux, uy) {
    if (this.status !== 'running' || !this.thrust || this.nudgesLeft <= 0) return null;
    const l = dhypot(ux, uy);
    if (!(l > 0)) return null;
    const vx = ux / l * this.thrust.dv, vy = uy / l * this.thrust.dv;
    this.applyNudge(vx, vy);
    this.nudges.push({ s: this.steps, vx, vy });
    return { vx, vy };
  };

  World.prototype.applyNudge = function (vx, vy) {
    const p = this.particle;
    p.vx += vx; p.vy += vy;
    this.nudgesLeft--;
    this.orbit = null;          // the orbit changed: start tracking afresh
  };

  // Replay: apply recorded nudges at the same step numbers (deterministic).
  World.prototype.scheduleNudges = function (list) {
    this.scheduled = (list || []).slice().sort((a, b) => a.s - b.s);
  };

  // Nebulae: damp the particle's velocity inside a cloud, strongest at its centre.
  function applyNebulae(nebulae, p) {
    for (const n of nebulae) {
      const dx = p.x - n.x, dy = p.y - n.y, d2 = dx * dx + dy * dy;
      if (d2 >= n.r * n.r) continue;
      const k = dexp(-n.drag * (1 - d2 / (n.r * n.r)) * DT);
      p.vx *= k; p.vy *= k;
    }
  }

  // velocity Verlet: half kick, drift, recompute, half kick
  function integrate(bodies) {
    for (const b of bodies) {
      if (b.fixed) continue;
      b.vx += 0.5 * b.ax * DT; b.vy += 0.5 * b.ay * DT;
      b.x += b.vx * DT; b.y += b.vy * DT;
    }
    computeAcc(bodies);
    for (const b of bodies) {
      if (b.fixed) continue;
      b.vx += 0.5 * b.ax * DT; b.vy += 0.5 * b.ay * DT;
    }
  }

  // Run only the sources (before any particle is placed), e.g. to vet a generated layout.
  // Returns false as soon as a source merges or wanders past `margin` outside the arena.
  // Comets are ignored here (they come and go, and may hit a star), but repeating ones are
  // launched on schedule so their accumulated tugs on the stars count.
  World.prototype.sourcesStayPut = function (seconds, margin) {
    const solid = () => this.sources.filter(s => s.kind !== 'comet').length;
    const n0 = solid();
    const steps = Math.round(seconds / DT);
    const t0 = this.time;
    let ok = true;
    for (let i = 0; i < steps && ok; i++) {
      if (this.hasPulsars) updatePulsars(this.sources, this.time);
      integrate(this.bodies);
      this.mergeSources();
      this.time += DT;
      if (this.cometSpawns.length || this.sources.some(s => s.kind === 'comet')) this.updateComets();
      if (solid() !== n0) ok = false;
      else if (i % 24 === 0) {
        for (const s of this.sources) {
          if (s.kind === 'comet') continue;
          if (s.x < -margin || s.y < -margin || s.x > ARENA + margin || s.y > ARENA + margin) { ok = false; break; }
        }
      }
    }
    this.time = t0;
    if (this.hasPulsars) { updatePulsars(this.sources, t0); computeAcc(this.bodies); }
    return ok;
  };

  // One step of the sources alone (editor preview). Merges still happen.
  World.prototype.stepSources = function () {
    this.previewTime = (this.previewTime || 0) + DT;
    if (this.hasPulsars) updatePulsars(this.sources, this.previewTime);
    integrate(this.bodies);
    this.mergeSources();
  };

  World.prototype.step = function () {
    if (this.status !== 'running') return;
    const p = this.particle;
    const px = p.x, py = p.y;
    if (this.scheduled) {
      while (this.scheduled.length && this.scheduled[0].s <= this.steps) {
        const n = this.scheduled.shift();
        if (this.nudgesLeft > 0) { this.applyNudge(n.vx, n.vy); this.nudges.push(n); }
      }
    }
    if (this.hasPulsars) updatePulsars(this.sources, this.time);

    integrate(this.bodies);
    if (this.nebulae.length) applyNebulae(this.nebulae, p);

    this.time += DT;
    this.steps++;
    // Leaving the arena no longer ends the run, but only distance inside it counts.
    this.outside = p.x < 0 || p.y < 0 || p.x > ARENA || p.y > ARENA;
    if (!this.outside) this.path += dhypot(p.x - px, p.y - py);
    const v = dhypot(p.vx, p.vy);
    if (!(this.topSpeed >= v)) this.topSpeed = v;
    this.warped = false;
    if (this.wormholes.length) this.passWormholes(p);

    if (this.steps % 2 === 0) pushTrail(p.trail, p.x, p.y, PARTICLE_TRAIL_MAX);
    if (this.steps % 4 === 0) {
      for (const s of this.sources) if (!s.fixed) pushTrail(s.trail, s.x, s.y, SOURCE_TRAIL_MAX);
    }

    this.mergeSources();
    if (this.cometSpawns.length || this.sources.some(s => s.kind === 'comet')) this.updateComets();

    // Reaching the target passes the level but doesn't stop the run:
    // the clock switches off and it continues until a crash or escape.
    if (!this.passed && this.path >= this.target) {
      this.passed = true;
      this.passedAt = this.time;
      this.timeLimit = Infinity;
    }
    for (const s of this.sources) {
      const dx = p.x - s.x, dy = p.y - s.y, rr = s.radius + p.radius;
      if (dx * dx + dy * dy < rr * rr) { this.status = 'crashed'; this.hit = s; return; }
    }
    if (this.outside && this.isEscaping()) {
      this.escapeTime = (this.escapeTime || 0) + DT;
      if (this.escapeTime >= ESCAPE_CONFIRM) { this.status = 'escaped'; return; }
    } else {
      this.escapeTime = 0;
    }
    if (dhypot(p.x - ARENA / 2, p.y - ARENA / 2) > MAX_DISTANCE) { this.status = 'escaped'; return; }
    if (this.warped) this.orbit = null;     // a wormhole jump breaks any orbit being tracked
    if (this.trackOrbit()) {
      this.status = 'orbit';
      // The orbit repeats forever, so the rest of the run is predictable:
      // project the distance it would cover before the clock runs out.
      const o = this.orbit, revs = o.revs;
      let dur = 0, gain = 0;
      for (const r of revs) { dur += r.dur; gain += r.path; }
      const rate = gain / dur;  // counted distance per second (outside-arena parts excluded)
      this.orbitPeriod = dur / revs.length;
      this.orbitRate = rate;
      if (!this.passed && rate > 0 && isFinite(this.timeLimit)) {
        const need = (this.target - this.path) / rate;
        this.projectedPath = this.path + rate * (this.timeLimit - this.time);
        if (this.time + need <= this.timeLimit) {
          this.passed = true; this.passedAt = this.time + need; this.projectedPass = true; this.timeLimit = Infinity;
        }
      } else if (!this.passed && rate > 0) {
        this.passed = true; this.passedAt = this.time + (this.target - this.path) / rate; this.projectedPass = true;
      }
      return;
    }
    if (this.time >= this.timeLimit) { this.status = 'timeout'; return; }
  };

  // Steady-orbit detector. Follows the particle's angle around a reference point:
  // the star that dominates its pull, or the sources' centre of mass when none does
  // (e.g. circling a whole binary). Every full turn records the closest and farthest
  // distance and how long the turn took. When the last ORBIT_REVS turns all match
  // within ORBIT_TOL, the motion is a repeating orbit and the run can end.
  World.prototype.trackOrbit = function () {
    const p = this.particle;
    let best = null, bestA = 0, total = 0;
    let mx = 0, my = 0, mvx = 0, mvy = 0, m = 0;
    for (const s of this.sources) {
      if (s.kind === 'whitehole') continue;
      const qx = p.x - s.x, qy = p.y - s.y;
      const a = s.mass / (qx * qx + qy * qy + SOFT2);
      total += a;
      if (a > bestA) { bestA = a; best = s; }
      mx += s.mass * s.x; my += s.mass * s.y; mvx += s.mass * s.vx; mvy += s.mass * s.vy; m += s.mass;
    }
    if (!best || !m) return false;
    let ref, cx, cy;
    if (bestA >= 0.6 * total) { ref = best; cx = best.x; cy = best.y; }
    else { ref = 'com'; cx = mx / m; cy = my / m; }
    const dx = p.x - cx, dy = p.y - cy;
    const r = dhypot(dx, dy), ang = datan2(dy, dx);
    let o = this.orbit;
    if (!o || o.ref !== ref || o.nSources !== this.sources.length) {
      o = this.orbit = { ref, nSources: this.sources.length, last: ang, turned: 0,
        rmin: r, rmax: r, t0: this.time, path0: this.path, revs: [] };
      return false;
    }
    let d = ang - o.last;
    if (d > Math.PI) d -= 2 * Math.PI; else if (d < -Math.PI) d += 2 * Math.PI;
    o.last = ang;
    o.turned += d;
    if (r < o.rmin) o.rmin = r;
    if (r > o.rmax) o.rmax = r;
    if (Math.abs(o.turned) < 2 * Math.PI) return false;
    const dir = Math.sign(o.turned);
    o.revs.push({ dir, rmin: o.rmin, rmax: o.rmax, dur: this.time - o.t0, path: this.path - o.path0 });
    if (o.revs.length > ORBIT_REVS) o.revs.shift();
    o.turned -= dir * 2 * Math.PI;
    o.rmin = o.rmax = r; o.t0 = this.time; o.path0 = this.path;
    if (o.revs.length < ORBIT_REVS) return false;
    const steady = key => {
      let lo = Infinity, hi = -Infinity;
      for (const v of o.revs) { lo = Math.min(lo, v[key]); hi = Math.max(hi, v[key]); }
      return hi - lo <= ORBIT_TOL * hi;
    };
    return o.revs.every(v => v.dir === dir) && steady('rmin') && steady('rmax') && steady('dur');
  };

  // True when the particle is heading away with more than escape speed:
  // positive energy (kinetic + gravitational) and moving away from the arena centre.
  // Wormholes: touching one mouth moves the particle to the matching spot at the other mouth,
  // keeping its velocity. It must leave that mouth before it can be sent back.
  World.prototype.passWormholes = function (p) {
    if (this.warpLock) {
      const w = this.warpLock.w, side = this.warpLock.side;
      const mx = side ? w.bx : w.ax, my = side ? w.by : w.ay;
      if (dhypot(p.x - mx, p.y - my) > w.r) this.warpLock = null;
      else return;
    }
    for (const w of this.wormholes) {
      for (let side = 0; side < 2; side++) {
        const fx = side ? w.bx : w.ax, fy = side ? w.by : w.ay;
        const tx = side ? w.ax : w.bx, ty = side ? w.ay : w.by;
        if (dhypot(p.x - fx, p.y - fy) >= w.r) continue;
        p.trail.push(NaN, NaN);              // break the trail across the jump
        p.x += tx - fx; p.y += ty - fy;
        p.trail.push(p.x, p.y);
        this.warpLock = { w, side: 1 - side };
        this.warped = true;
        this.warps = (this.warps || 0) + 1;
        computeAcc(this.bodies);
        return;
      }
    }
  };

  // Launch repeating comets on schedule; drop comets that have flown far away.
  World.prototype.updateComets = function () {
    let changed = false;
    for (const c of this.cometSpawns) {
      if (this.time + 1e-9 < c.next) continue;
      c.next += c.def.every;
      const b = makeBody(c.def);
      b.variant = c.variant;
      this.sources.push(b);
      this.bodies.splice(this.bodies.length - (this.particle ? 1 : 0), 0, b);
      changed = true;
    }
    for (let i = this.sources.length - 1; i >= 0; i--) {
      const s = this.sources[i];
      if (s.kind !== 'comet') continue;
      if (dhypot(s.x - ARENA / 2, s.y - ARENA / 2) < COMET_DESPAWN) continue;
      this.sources.splice(i, 1);
      this.bodies.splice(this.bodies.indexOf(s), 1);
      changed = true;
    }
    if (changed) computeAcc(this.bodies);
  };

  World.prototype.isEscaping = function () {
    const p = this.particle;
    let pot = 0;
    for (const s of this.sources) pot += (s.kind === 'whitehole' ? 1 : -1) * G * s.mass / dhypot(p.x - s.x, p.y - s.y);
    const energy = 0.5 * (p.vx * p.vx + p.vy * p.vy) + pot;
    const radial = (p.x - ARENA / 2) * p.vx + (p.y - ARENA / 2) * p.vy;
    return energy > 0 && radial > 0;
  };

  // Sources that collide merge, conserving momentum (fixed ones stay put).
  World.prototype.mergeSources = function () {
    const S = this.sources;
    for (let i = 0; i < S.length; i++) {
      for (let j = i + 1; j < S.length; j++) {
        const a = S[i], b = S[j];
        if (a.kind === 'whitehole' || b.kind === 'whitehole') continue;
        const d = dhypot(a.x - b.x, a.y - b.y);
        if (d > (a.radius + b.radius) * 0.75) continue;
        const m = a.mass + b.mass;
        if (a.fixed || b.fixed) {
          const f = a.fixed ? a : b;
          a.x = f.x; a.y = f.y; a.vx = 0; a.vy = 0; a.fixed = true;
        } else {
          a.x = (a.x * a.mass + b.x * b.mass) / m;
          a.y = (a.y * a.mass + b.y * b.mass) / m;
          a.vx = (a.vx * a.mass + b.vx * b.mass) / m;
          a.vy = (a.vy * a.mass + b.vy * b.mass) / m;
        }
        const baseSum = (a.pulse ? a.base : a.mass) + (b.pulse ? b.base : b.mass);
        a.mass = m;
        const rank = { comet: 0, star: 1, pulsar: 1, blackhole: 2 };
        const kind = rank[b.kind] > rank[a.kind] ? b.kind : a.kind;
        // a pulsar keeps pulsing only while the merged body is still a pulsar
        if (kind === 'pulsar') { a.pulse = a.pulse || b.pulse; a.base = baseSum; }
        else if (a.pulse || b.pulse) { a.pulse = null; a.mass = a.base = baseSum; }
        else a.base = m;
        if (kind === 'blackhole') {
          // a black hole swallows whatever hits it and stays small
          a.radius = Math.max(a.kind === 'blackhole' ? a.radius : 0, b.kind === 'blackhole' ? b.radius : 0, blackHoleRadius(m));
        } else if (kind === 'star' && (a.kind === 'comet' || b.kind === 'comet')) {
          a.radius = Math.max(a.radius, b.radius);   // a comet adds nothing visible to a star
        } else {
          a.radius = Math.sqrt(a.radius * a.radius + b.radius * b.radius);
        }
        if (b.kind !== a.kind && kind === b.kind) a.variant = b.variant;
        a.kind = kind;
        S.splice(j, 1);
        this.bodies.splice(this.bodies.indexOf(b), 1);
        computeAcc(this.bodies);
        j--;
      }
    }
  };

  function pushTrail(t, x, y, max) {
    t.push(x, y);
    if (t.length > max * 2) t.splice(0, 2);
  }

  // Event-horizon radius used for black holes (small for their mass).
  function blackHoleRadius(m) { return Math.max(9, Math.round(4.2 * Math.sqrt(m / 1e6))); }

  // Circular orbit speed around mass M at distance r.
  function orbitSpeed(M, r) { return Math.sqrt(G * M / r); }

  Object.assign(NS, {
    G, DT, ARENA, PARTICLE_RADIUS, PLACE_CLEARANCE, DEFAULT_TIME_LIMIT,
    World, orbitSpeed, blackHoleRadius, WORMHOLE_R, PULSE_PERIOD, PULSE_AMP, NEBULA_DRAG, THRUST_DV,
  });
})(typeof window !== 'undefined' ? window : globalThis);
