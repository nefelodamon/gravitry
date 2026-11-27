// Gravitry level editor: place, move and tune stars, preview their motion, test and save.
(function (root) {
  'use strict';
  const NS = root.Gravitry;
  const A = NS.ARENA;
  // Mass range and size per object type.
  const KINDS = {
    star: { min: 2e5, max: 6e6, def: 2e6, radius: m => NS.radiusFor(m) },
    blackhole: { min: 3e6, max: 2e7, def: 8e6, radius: m => NS.blackHoleRadius(m) },
    comet: { min: 5e4, max: 6e5, def: 3e5, radius: () => 6 },
    pulsar: { min: 5e5, max: 3e6, def: 1.5e6, radius: () => 8 },
    whitehole: { min: 5e5, max: 6e6, def: 2e6, radius: () => 11 },
  };
  const KIND_ORDER = ['star', 'blackhole', 'comet', 'pulsar', 'whitehole'];
  const KIND_NAMES = {
    star: ['star', 'stars'], blackhole: ['black hole', 'black holes'], comet: ['comet', 'comets'],
    pulsar: ['pulsar', 'pulsars'], whitehole: ['white hole', 'white holes'],
  };
  // Circles drawn in zones mode and nebulae mode share the same editing code.
  const CIRCLES = {
    zones: { key: 'noPlaceZones', min: 30, max: 700, def: 110, count: 6, name: 'zones' },
    nebs: { key: 'nebulae', min: 40, max: 300, def: 150, count: 4, name: 'nebulae' },
  };
  const MAX_WORMS = 3;
  const WORM_MIN = 16, WORM_MAX = 60;
  const PREVIEW_SECONDS = 20;
  const HANDLE_GAP = 14;      // velocity handle sits this far outside the star's rim at zero speed
  const HANDLE_R = 8;
  const DEFAULT_MASS = 2e6;
  const MAX_STARS = 8;
  const HELP = {
    stars: 'Click empty space: add star · drag: move · drag <span class="hdl">◯</span> handle: set velocity · wheel: mass · <kbd>K</kbd> type (star, black hole, comet, pulsar, white hole) · <kbd>A</kbd> anchor · <kbd>O</kbd> orbit · <kbd>Del</kbd> delete · <kbd>Z</kbd> zones · <kbd>W</kbd> wormholes · <kbd>N</kbd> nebulae',
    nebs: 'Click-drag empty space: draw a nebula (slows the particle inside) · drag: move · drag <span class="hdl">◯</span> edge or wheel: resize · <kbd>Del</kbd> delete · <kbd>N</kbd> back to stars',
    zones: 'Click-drag empty space: draw a no-place zone · drag zone: move · drag <span class="hdl">◯</span> edge or wheel: resize · <kbd>Del</kbd> delete · <kbd>Z</kbd> back to stars',
    worms: 'Click empty space: add a wormhole pair · drag a mouth: move it · wheel: mouth size · <kbd>Del</kbd> delete pair · <kbd>W</kbd> back to stars',
  };

  const $ = id => document.getElementById(id);

  // Slider (0..1000) <-> mass, log scale within the object type's range.
  const sliderToMass = (v, k) => KINDS[k].min * Math.pow(KINDS[k].max / KINDS[k].min, v / 1000);
  const massToSlider = (m, k) => Math.round(1000 * Math.log(m / KINDS[k].min) / Math.log(KINDS[k].max / KINDS[k].min));
  const kindOf = s => s.kind || 'star';
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function Editor(hooks) {
    this.hooks = hooks; // { onTest(def), onSave(draft, entry) -> entry, onExit(), flash(text) }
    this.ui = {
      bar: $('editor-bar'), name: $('ed-name'), target: $('ed-target'), auto: $('ed-auto'),
      time: $('ed-time'), test: $('ed-test'), save: $('ed-save'), exit: $('ed-exit'),
      props: $('ed-props'), mass: $('ed-mass'), massVal: $('ed-mass-val'), fixed: $('ed-fixed'),
      orbit: $('ed-orbit'), stop: $('ed-stop'), del: $('ed-del'), status: $('ed-status'),
      modeStars: $('ed-mode-stars'), modeZones: $('ed-mode-zones'), help: $('ed-help'),
      zprops: $('ed-zone-props'), zradius: $('ed-zradius'), zradiusVal: $('ed-zradius-val'), zdel: $('ed-zdel'),
      modeWorms: $('ed-mode-worms'), wprops: $('ed-worm-props'), wradius: $('ed-wradius'), wradiusVal: $('ed-wradius-val'),
      wdel: $('ed-wdel'), kinds: Array.from(document.querySelectorAll('#ed-props [data-kind]')),
      every: $('ed-every'), everyRow: $('ed-every-row'), launch: $('ed-launch'), fixedRow: $('ed-fixed').closest('.ed-props-row'),
      period: $('ed-period'), periodRow: $('ed-period-row'), thrust: $('ed-thrust'), modeNebs: $('ed-mode-nebs'),
      zlabel: $('ed-zlabel'), zdragRow: $('ed-zdrag-row'), zdrag: $('ed-zdrag'), zdragVal: $('ed-zdrag-val'),
    };
    this.mode = 'stars';     // 'stars' | 'zones' | 'worms' | 'nebs'
    this.zsel = -1;          // selected zone index (zones mode)
    this.wsel = -1;          // selected wormhole pair (worms mode)
    this.placeable = 1;      // fraction of the arena where the particle may be dropped
    this.active = false;
    this.draft = null;
    this.entry = null;
    this.sel = -1;
    this.drag = null;
    this.hover = null;
    this.dirty = false;
    this.preview = null;
    this.world = null;
    this.bindUi();
  }

  // ---------- open / close ----------
  // def: level definition to start from (null = blank). entry: saved level being edited (or null).
  Editor.prototype.open = function (def, entry, name) {
    const d = def ? JSON.parse(JSON.stringify(def)) : null;
    this.draft = {
      name: name || (entry && entry.name) || 'My level',
      target: d && isFinite(d.target) ? d.target : 1000,
      timeLimit: d && d.timeLimit ? d.timeLimit : NS.DEFAULT_TIME_LIMIT,
      launch: !!(d && d.launch),
      thrust: d && d.thrust ? d.thrust.count || 0 : 0,
      nebulae: d && d.nebulae ? d.nebulae.map(n => ({ x: n.x, y: n.y, r: n.r, drag: n.drag != null ? n.drag : NS.NEBULA_DRAG })) : [],
      noPlaceZones: d && d.noPlaceZones ? d.noPlaceZones.map(z => ({ x: z.x, y: z.y, r: z.r })) : [],
      wormholes: d && d.wormholes ? d.wormholes.map(w => ({ ax: w.ax, ay: w.ay, bx: w.bx, by: w.by, r: w.r || NS.WORMHOLE_R })) : [],
      sources: d ? d.sources.map(s => ({
        x: s.x, y: s.y, vx: s.vx || 0, vy: s.vy || 0, mass: s.mass, radius: s.radius, fixed: !!s.fixed,
        kind: s.kind || 'star', every: s.every || 0, period: s.pulse && s.pulse.period || (s.kind === 'pulsar' ? NS.PULSE_PERIOD : 0),
      })) : [{ x: 500, y: 500, vx: 0, vy: 0, mass: 3e6, radius: NS.radiusFor(3e6), fixed: true, kind: 'star', every: 0 }],
    };
    // A generated layout may rely on zeroMomentum; bake that into the velocities now.
    if (d && d.zeroMomentum) {
      const w = new NS.World(d);
      w.sources.forEach((s, i) => { this.draft.sources[i].vx = s.vx; this.draft.sources[i].vy = s.vy; });
    }
    this.entry = entry || null;
    this.sel = -1;
    this.zsel = -1;
    this.wsel = -1;
    this.setMode('stars', true);
    this.drag = null;
    this.dirty = false;
    this.active = true;
    this.ui.bar.hidden = false;
    this.syncFields();
    this.changed(false);
  };

  // Resume after a test run, keeping the draft and selection.
  Editor.prototype.resume = function () {
    this.active = true;
    this.ui.bar.hidden = false;
    this.syncProps();
  };

  Editor.prototype.close = function () {
    this.active = false;
    this.drag = null;
    this.ui.bar.hidden = true;
    this.ui.props.hidden = true;
    this.ui.zprops.hidden = true;
    this.ui.wprops.hidden = true;
  };

  // Level definition for the game/physics from the current draft.
  Editor.prototype.toDef = function () {
    const d = this.draft;
    return {
      name: d.name.trim() || 'My level',
      hint: NS.describeLevel(d.sources, d.wormholes, d.nebulae).replace(/ Press N for a new layout\.$/, ''),
      target: d.target,
      timeLimit: d.timeLimit,
      ...(d.launch ? { launch: { max: 260 } } : {}),
      ...(d.thrust > 0 ? { thrust: { count: d.thrust } } : {}),
      nebulae: d.nebulae.map(n => ({ x: +n.x.toFixed(1), y: +n.y.toFixed(1), r: Math.round(n.r), drag: +n.drag.toFixed(2) })),
      noPlaceZones: d.noPlaceZones.map(z => ({ x: +z.x.toFixed(1), y: +z.y.toFixed(1), r: Math.round(z.r) })),
      wormholes: d.wormholes.map(w => ({
        ax: +w.ax.toFixed(1), ay: +w.ay.toFixed(1), bx: +w.bx.toFixed(1), by: +w.by.toFixed(1), r: Math.round(w.r),
      })),
      sources: d.sources.map(s => {
        const o = { x: +s.x.toFixed(1), y: +s.y.toFixed(1), mass: Math.round(s.mass), radius: s.radius };
        if (s.kind && s.kind !== 'star') o.kind = s.kind;
        if (s.kind === 'comet' && s.every > 0) o.every = s.every;
        if (s.kind === 'pulsar' && s.period && s.period !== NS.PULSE_PERIOD) o.pulse = { period: s.period };
        if (s.fixed) o.fixed = true;
        else { o.vx = +s.vx.toFixed(2); o.vy = +s.vy.toFixed(2); }
        return o;
      }),
    };
  };

  // ---------- change tracking & preview ----------
  Editor.prototype.changed = function (markDirty) {
    if (markDirty !== false) this.dirty = true;
    const def = this.toDef();
    def.target = Infinity;
    this.world = new NS.World(def);
    this.placeable = this.measurePlaceable();
    this.computePreview(def);
    this.syncProps();
    this.updateStatus();
  };

  // Simulate the stars alone for a few seconds and record their paths.
  Editor.prototype.computePreview = function (def) {
    const w = new NS.World(def);
    const bodies = w.sources.slice();
    const fixed = bodies.map(b => b.fixed); // before simulating: merges can anchor a body
    const trails = bodies.map(b => [b.x, b.y]);
    const alive = bodies.map(() => true);
    const merges = [];
    const steps = Math.round(PREVIEW_SECONDS / NS.DT);
    for (let i = 1; i <= steps; i++) {
      w.stepSources();
      if (i % 6 !== 0) continue;
      bodies.forEach((b, k) => {
        if (!alive[k]) return;
        if (w.sources.indexOf(b) === -1) {
          alive[k] = false;
          merges.push({ x: b.x, y: b.y });
          return;
        }
        trails[k].push(b.x, b.y);
      });
    }
    this.preview = { trails, merges, fixed };
  };

  // Fraction of a 40x40 grid of spots where a drop is allowed.
  Editor.prototype.measurePlaceable = function () {
    const N = 40;
    let ok = 0;
    for (let gy = 0; gy < N; gy++) {
      for (let gx = 0; gx < N; gx++) {
        if (this.world.canPlace((gx + 0.5) * A / N, (gy + 0.5) * A / N)) ok++;
      }
    }
    return ok / (N * N);
  };

  Editor.prototype.updateStatus = function () {
    const n = this.draft.sources.length;
    const z = this.draft.noPlaceZones.length;
    const m = this.preview.merges.length;
    const p = this.placeable;
    const blocked = p === 0;
    const tiny = p > 0 && p < 0.02;
    const pct = p === 0 ? '0%' : p < 0.01 ? '<1%' : Math.round(p * 100) + '%';
    const counts = {};
    for (const s of this.draft.sources) counts[kindOf(s)] = (counts[kindOf(s)] || 0) + 1;
    let msg = n ? KIND_ORDER.filter(k => counts[k]).map(k => `${counts[k]} ${KIND_NAMES[k][counts[k] === 1 ? 0 : 1]}`).join(', ')
      : 'Click anywhere to add a star';
    const w = this.draft.wormholes.length;
    if (w) msg += ` · ${w} wormhole${w === 1 ? '' : 's'}`;
    const nb = this.draft.nebulae.length;
    if (nb) msg += ` · ${nb} nebula${nb === 1 ? '' : 'e'}`;
    if (this.draft.thrust) msg += ` · ${this.draft.thrust} nudge${this.draft.thrust === 1 ? '' : 's'}`;
    if (z || w) msg += ` · ${pct} placeable`;
    if (z) msg = msg.replace(' · ' + pct, ` · ${z} zone${z === 1 ? '' : 's'} · ${pct}`);
    if (blocked) msg += ' · ⚠ nowhere to drop!';
    else if (tiny) msg += ' · ⚠ tiny drop area';
    if (m) msg += ` · ⚠ ${m} collision${m === 1 ? '' : 's'} within ${PREVIEW_SECONDS}s`;
    if (n >= MAX_STARS) msg += ` · max ${MAX_STARS} objects`;
    this.ui.status.textContent = msg;
    this.ui.status.classList.toggle('warn', m > 0 || blocked || tiny);
    this.ui.test.disabled = this.ui.save.disabled = n === 0 || blocked;
  };

  Editor.prototype.setMode = function (mode, silent) {
    this.mode = mode;
    this.sel = -1;
    this.zsel = -1;
    this.wsel = -1;
    this.drag = null;
    this.ui.modeStars.setAttribute('aria-pressed', String(mode === 'stars'));
    this.ui.modeZones.setAttribute('aria-pressed', String(mode === 'zones'));
    this.ui.modeWorms.setAttribute('aria-pressed', String(mode === 'worms'));
    this.ui.modeNebs.setAttribute('aria-pressed', String(mode === 'nebs'));
    this.ui.help.innerHTML = HELP[mode];
    if (!silent) this.syncProps();
  };

  // ---------- fields ----------
  Editor.prototype.syncFields = function () {
    this.ui.name.value = this.draft.name;
    this.ui.target.value = this.draft.target;
    this.ui.time.value = this.draft.timeLimit;
    this.ui.launch.checked = this.draft.launch;
    this.ui.thrust.value = this.draft.thrust;
    this.ui.exit.textContent = 'Exit';
    this.ui.exit.classList.remove('confirm');
  };

  Editor.prototype.syncProps = function () {
    const C = this.circles();
    const z = C && C.list[this.zsel];
    this.ui.zprops.hidden = !z;
    if (z) {
      this.ui.zlabel.textContent = this.mode === 'nebs' ? 'Nebula radius' : 'Zone radius';
      this.ui.zradius.min = C.min; this.ui.zradius.max = C.max;
      this.ui.zradius.value = Math.round(z.r);
      this.ui.zradiusVal.textContent = Math.round(z.r);
      this.ui.zdragRow.hidden = this.mode !== 'nebs';
      this.ui.zdel.textContent = this.mode === 'nebs' ? 'Delete nebula' : 'Delete zone';
      if (this.mode === 'nebs') { this.ui.zdrag.value = Math.round(z.drag * 100); this.ui.zdragVal.textContent = z.drag.toFixed(2); }
    }
    const w = this.draft.wormholes[this.wsel];
    this.ui.wprops.hidden = !w;
    if (w) {
      this.ui.wradius.value = Math.round(w.r);
      this.ui.wradiusVal.textContent = Math.round(w.r);
    }
    const s = this.draft.sources[this.sel];
    this.ui.props.hidden = !s;
    if (!s) return;
    const k = kindOf(s);
    this.ui.kinds.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.kind === k)));
    this.ui.mass.value = massToSlider(s.mass, k);
    this.ui.massVal.textContent = s.mass >= 1e6 ? (s.mass / 1e6).toFixed(2) : (s.mass / 1e6).toFixed(3);
    this.ui.fixed.checked = s.fixed;
    this.ui.fixedRow.hidden = k === 'comet';
    this.ui.everyRow.hidden = k !== 'comet';
    this.ui.periodRow.hidden = k !== 'pulsar';
    if (k === 'pulsar' && document.activeElement !== this.ui.period) this.ui.period.value = s.period || NS.PULSE_PERIOD;
    this.ui.fixed.disabled = k === 'whitehole';
    if (k === 'comet' && document.activeElement !== this.ui.every) this.ui.every.value = s.every || 0;
    this.ui.orbit.disabled = s.fixed || this.draft.sources.length < 2;
    this.ui.stop.disabled = s.fixed || (!s.vx && !s.vy);
  };

  Editor.prototype.bindUi = function () {
    const u = this.ui;
    u.name.addEventListener('input', () => { this.draft.name = u.name.value.slice(0, 40); this.dirty = true; });
    u.target.addEventListener('change', () => {
      this.draft.target = clamp(Math.round(+u.target.value || 0), 100, 50000);
      u.target.value = this.draft.target; this.dirty = true;
    });
    u.time.addEventListener('change', () => {
      this.draft.timeLimit = clamp(Math.round(+u.time.value || 0), 10, 600);
      u.time.value = this.draft.timeLimit; this.dirty = true;
    });
    u.launch.addEventListener('change', () => { this.draft.launch = u.launch.checked; this.dirty = true; u.launch.blur(); });
    u.thrust.addEventListener('change', () => {
      this.draft.thrust = clamp(Math.round(+u.thrust.value || 0), 0, 5);
      u.thrust.value = this.draft.thrust; this.dirty = true; this.updateStatus();
    });
    u.period.addEventListener('change', () => {
      const s = this.draft.sources[this.sel];
      if (!s) return;
      s.period = clamp(Math.round((+u.period.value || NS.PULSE_PERIOD) * 2) / 2, 1, 20);
      u.period.value = s.period;
      this.changed();
    });
    u.modeNebs.addEventListener('click', e => { this.setMode('nebs'); e.currentTarget.blur(); });
    u.zdrag.addEventListener('input', () => {
      const n = this.mode === 'nebs' && this.draft.nebulae[this.zsel];
      if (!n) return;
      n.drag = clamp(+u.zdrag.value / 100, 0.05, 2);
      this.changed();
    });
    u.auto.addEventListener('click', () => this.autoTarget());
    u.test.addEventListener('click', () => this.hooks.onTest(this.toDef()));
    u.save.addEventListener('click', () => this.save());
    u.exit.addEventListener('click', () => this.exit());
    u.mass.addEventListener('input', () => {
      const s = this.draft.sources[this.sel];
      if (s) this.setMass(sliderToMass(+u.mass.value, kindOf(s)));
    });
    u.kinds.forEach(b => b.addEventListener('click', e => { this.setKind(b.dataset.kind); e.currentTarget.blur(); }));
    u.every.addEventListener('change', () => {
      const s = this.draft.sources[this.sel];
      if (!s) return;
      s.every = clamp(Math.round(+u.every.value || 0), 0, 60);
      if (s.every > 0 && s.every < 2) s.every = 2;
      u.every.value = s.every;
      this.changed();
    });
    u.modeWorms.addEventListener('click', e => { this.setMode('worms'); e.currentTarget.blur(); });
    u.wradius.addEventListener('input', () => this.setWormRadius(+u.wradius.value));
    u.wdel.addEventListener('click', () => this.remove());
    u.fixed.addEventListener('change', () => this.toggleFixed());
    u.orbit.addEventListener('click', () => this.orbit());
    u.stop.addEventListener('click', () => this.stop());
    u.del.addEventListener('click', () => this.remove());
    u.modeStars.addEventListener('click', e => { this.setMode('stars'); e.currentTarget.blur(); });
    u.modeZones.addEventListener('click', e => { this.setMode('zones'); e.currentTarget.blur(); });
    u.zradius.addEventListener('input', () => this.setZoneRadius(+u.zradius.value));
    u.zdel.addEventListener('click', () => this.remove());
  };

  Editor.prototype.autoTarget = function () {
    if (!this.draft.sources.length) return;
    const u = this.ui;
    u.auto.disabled = true;
    u.auto.textContent = '…';
    setTimeout(() => {
      const t = NS.suggestTarget(this.toDef());
      u.auto.disabled = false;
      u.auto.textContent = 'Auto';
      if (t) {
        this.draft.target = t; u.target.value = t; this.dirty = true;
        this.hooks.flash(`Target set to ${t} (about 15% of drop spots pass)`);
      } else {
        this.hooks.flash('No valid drop spots — move the stars apart');
      }
    }, 30);
  };

  Editor.prototype.save = function () {
    if (!this.draft.sources.length) return;
    this.entry = this.hooks.onSave(this.toDef(), this.entry);
    if (this.entry) { this.dirty = false; this.syncFields(); }
  };

  // Two-step exit when there are unsaved changes.
  Editor.prototype.exit = function () {
    const b = this.ui.exit;
    if (this.dirty && !b.classList.contains('confirm')) {
      b.classList.add('confirm'); b.textContent = 'Discard changes?';
      setTimeout(() => { b.classList.remove('confirm'); b.textContent = 'Exit'; }, 3000);
      return;
    }
    this.close();
    this.hooks.onExit();
  };

  // ---------- star operations ----------
  Editor.prototype.addStar = function (x, y) {
    if (this.draft.sources.length >= MAX_STARS) { this.hooks.flash(`Up to ${MAX_STARS} objects`); return -1; }
    this.draft.sources.push({ x, y, vx: 0, vy: 0, mass: DEFAULT_MASS, radius: NS.radiusFor(DEFAULT_MASS), fixed: true, kind: 'star', every: 0 });
    this.sel = this.draft.sources.length - 1;
    this.changed();
    NS.Sound.play('pop');
    return this.sel;
  };

  Editor.prototype.setMass = function (m) {
    const s = this.draft.sources[this.sel];
    if (!s) return;
    const K = KINDS[kindOf(s)];
    s.mass = clamp(m, K.min, K.max);
    s.radius = K.radius(s.mass);
    this.changed();
  };

  // Turn the selected object into a star, black hole or comet (keeping its place).
  Editor.prototype.setKind = function (kind) {
    const s = this.draft.sources[this.sel];
    if (!s || !KINDS[kind] || kindOf(s) === kind) return;
    const prev = kindOf(s);
    s.kind = kind;
    const K = KINDS[kind];
    // keep the mass when it fits the new type, otherwise use the type's default
    if (s.mass < K.min || s.mass > K.max || prev === 'comet' || kind === 'comet') s.mass = K.def;
    s.radius = K.radius(s.mass);
    if (kind === 'whitehole') { s.fixed = true; s.vx = 0; s.vy = 0; }
    if (kind === 'pulsar' && !s.period) s.period = NS.PULSE_PERIOD;
    if (kind === 'comet') {
      s.fixed = false;
      if (!s.vx && !s.vy) { s.vx = 260; s.vy = 0; }  // comets need to be moving
      if (!s.every) s.every = 0;
    }
    NS.Sound.play('pop');
    this.changed();
  };

  Editor.prototype.cycleKind = function () {
    const s = this.draft.sources[this.sel];
    if (!s) return;
    this.setKind(KIND_ORDER[(KIND_ORDER.indexOf(kindOf(s)) + 1) % KIND_ORDER.length]);
  };

  Editor.prototype.toggleFixed = function () {
    const s = this.draft.sources[this.sel];
    if (!s || kindOf(s) === 'comet' || kindOf(s) === 'whitehole') return;
    s.fixed = !s.fixed;
    if (s.fixed) { s.vx = 0; s.vy = 0; }
    this.changed();
  };

  // Circular-orbit velocity around the star pulling hardest on the selected one.
  // Pressing again flips the direction.
  Editor.prototype.orbit = function () {
    const S = this.draft.sources, s = S[this.sel];
    if (!s || s.fixed) return;
    let best = null, pull = 0;
    S.forEach(o => {
      if (o === s) return;
      const r2 = (o.x - s.x) ** 2 + (o.y - s.y) ** 2;
      if (o.mass / r2 > pull) { pull = o.mass / r2; best = o; }
    });
    if (!best) return;
    const dx = s.x - best.x, dy = s.y - best.y, r = Math.hypot(dx, dy);
    const speed = NS.orbitSpeed(best.fixed ? best.mass : best.mass + s.mass, r);
    const bvx = best.fixed ? 0 : best.vx, bvy = best.fixed ? 0 : best.vy;
    let px = -dy / r, py = dx / r;                    // perpendicular
    const rel = (s.vx - bvx) * px + (s.vy - bvy) * py;
    if (rel > speed * 0.5) { px = -px; py = -py; }    // already orbiting this way: flip
    s.vx = bvx + px * speed;
    s.vy = bvy + py * speed;
    this.changed();
  };

  Editor.prototype.stop = function () {
    const s = this.draft.sources[this.sel];
    if (!s) return;
    s.vx = 0; s.vy = 0;
    this.changed();
  };

  Editor.prototype.remove = function () {
    if (this.zsel >= 0 || this.sel >= 0 || this.wsel >= 0) NS.Sound.play('unpop');
    if (this.wsel >= 0) {
      this.draft.wormholes.splice(this.wsel, 1);
      this.wsel = -1;
      this.changed();
      return;
    }
    if (this.zsel >= 0 && this.circles()) {
      this.circles().list.splice(this.zsel, 1);
      this.zsel = -1;
      this.changed();
      return;
    }
    if (this.sel < 0) return;
    this.draft.sources.splice(this.sel, 1);
    this.sel = -1;
    this.changed();
  };

  // ---------- zones & nebulae (circles) ----------
  // The circle list being edited in the current mode, with its limits.
  Editor.prototype.circles = function () {
    const C = CIRCLES[this.mode];
    return C ? Object.assign({ list: this.draft[C.key] }, C) : null;
  };

  Editor.prototype.setZoneRadius = function (r) {
    const C = this.circles();
    const z = C && C.list[this.zsel];
    if (!z) return;
    z.r = clamp(r, C.min, C.max);
    this.changed();
  };

  Editor.prototype.zoneHandle = function (z) { return { x: z.x + z.r * Math.SQRT1_2, y: z.y - z.r * Math.SQRT1_2 }; };

  // Selected zone's resize handle first, then the zone whose centre is nearest among those containing p.
  Editor.prototype.hitZone = function (p) {
    const Z = this.circles().list;
    const sel = Z[this.zsel];
    if (sel) {
      const h = this.zoneHandle(sel);
      if (Math.hypot(p.x - h.x, p.y - h.y) <= HANDLE_R + 6) return { kind: 'zsize', i: this.zsel };
    }
    let best = -1, bd = Infinity;
    Z.forEach((z, i) => {
      const d = Math.hypot(p.x - z.x, p.y - z.y);
      if (d <= z.r && d < bd) { bd = d; best = i; }
    });
    return best >= 0 ? { kind: 'zone', i: best } : null;
  };

  Editor.prototype.zonePointerDown = function (p) {
    const h = this.hitZone(p);
    const C = this.circles(), Z = C.list;
    if (h && h.kind === 'zsize') {
      this.drag = { kind: 'zsize', i: h.i };
    } else if (h) {
      this.zsel = h.i;
      this.drag = { kind: 'zmove', i: h.i, dx: Z[h.i].x - p.x, dy: Z[h.i].y - p.y };
      this.syncProps();
    } else if (this.zsel >= 0) {
      this.zsel = -1;
      this.syncProps();
    } else if (Z.length >= C.count) {
      this.hooks.flash(`Up to ${C.count} ${C.name}`);
    } else {
      const z = { x: clamp(p.x, 0, A), y: clamp(p.y, 0, A), r: C.min };
      if (this.mode === 'nebs') z.drag = NS.NEBULA_DRAG;
      Z.push(z);
      this.zsel = Z.length - 1;
      this.drag = { kind: 'zdraw', i: this.zsel, moved: false };
      NS.Sound.play('pop');
      this.changed();
    }
  };

  Editor.prototype.zonePointerMove = function (p) {
    const d = this.drag;
    const C = this.circles();
    const z = C.list[d.i];
    if (!z) return;
    if (d.kind === 'zmove') {
      z.x = clamp(p.x + d.dx, 0, A);
      z.y = clamp(p.y + d.dy, 0, A);
    } else {
      z.r = clamp(Math.hypot(p.x - z.x, p.y - z.y), C.min, C.max);
      d.moved = true;
    }
    this.changed();
  };

  // ---------- wormholes ----------
  Editor.prototype.setWormRadius = function (r) {
    const w = this.draft.wormholes[this.wsel];
    if (!w) return;
    w.r = clamp(r, WORM_MIN, WORM_MAX);
    this.changed();
  };

  // Mouth under p: { i: pair index, side: 'a' | 'b' }.
  Editor.prototype.hitWorm = function (p) {
    const W = this.draft.wormholes;
    for (let i = W.length - 1; i >= 0; i--) {
      const w = W[i];
      if (Math.hypot(p.x - w.ax, p.y - w.ay) <= w.r + 6) return { i, side: 'a' };
      if (Math.hypot(p.x - w.bx, p.y - w.by) <= w.r + 6) return { i, side: 'b' };
    }
    return null;
  };

  Editor.prototype.wormPointerDown = function (p) {
    const W = this.draft.wormholes;
    const h = this.hitWorm(p);
    if (h) {
      const w = W[h.i];
      this.wsel = h.i;
      this.drag = { kind: 'wmove', i: h.i, side: h.side, dx: w[h.side + 'x'] - p.x, dy: w[h.side + 'y'] - p.y };
      this.syncProps();
    } else if (this.wsel >= 0) {
      this.wsel = -1;
      this.syncProps();
    } else if (W.length >= MAX_WORMS) {
      this.hooks.flash(`Up to ${MAX_WORMS} wormhole pairs`);
    } else {
      // second mouth goes on the opposite side of the arena centre (or straight across if too close)
      const ax = clamp(p.x, 0, A), ay = clamp(p.y, 0, A);
      let bx = A - ax, by = A - ay;
      if (Math.hypot(bx - ax, by - ay) < 300) { bx = ax < A / 2 ? ax + 350 : ax - 350; by = ay; }
      W.push({ ax, ay, bx, by, r: NS.WORMHOLE_R });
      this.wsel = W.length - 1;
      this.drag = { kind: 'wmove', i: this.wsel, side: 'b', dx: 0, dy: 0, fresh: true };
      NS.Sound.play('pop');
      this.changed();
      this.hooks.flash('Drag to place the second mouth');
    }
  };

  Editor.prototype.wormPointerMove = function (p) {
    const d = this.drag;
    const w = this.draft.wormholes[d.i];
    if (!w) return;
    w[d.side + 'x'] = clamp(p.x + d.dx, 0, A);
    w[d.side + 'y'] = clamp(p.y + d.dy, 0, A);
    d.moved = true;
    this.changed();
  };

  // ---------- hit testing ----------
  Editor.prototype.handlePos = function (s) {
    const sp = Math.hypot(s.vx, s.vy);
    const ux = sp > 0 ? s.vx / sp : 1, uy = sp > 0 ? s.vy / sp : 0;
    const d = s.radius + HANDLE_GAP + sp;
    return { x: s.x + ux * d, y: s.y + uy * d };
  };

  Editor.prototype.hit = function (p) {
    const S = this.draft.sources;
    const sel = S[this.sel];
    if (sel && !sel.fixed) {
      const h = this.handlePos(sel);
      if (Math.hypot(p.x - h.x, p.y - h.y) <= HANDLE_R + 6) return { kind: 'vel', i: this.sel };
    }
    for (let i = S.length - 1; i >= 0; i--) {
      if (Math.hypot(p.x - S[i].x, p.y - S[i].y) <= Math.max(S[i].radius, 12) + 6) return { kind: 'star', i };
    }
    return null;
  };

  // ---------- input ----------
  Editor.prototype.pointerDown = function (p) {
    if (this.mode === 'zones' || this.mode === 'nebs') { this.zonePointerDown(p); return; }
    if (this.mode === 'worms') { this.wormPointerDown(p); return; }
    const h = this.hit(p);
    if (h && h.kind === 'vel') {
      this.drag = { kind: 'vel', i: h.i };
    } else if (h) {
      this.sel = h.i;
      const s = this.draft.sources[h.i];
      this.drag = { kind: 'move', i: h.i, dx: s.x - p.x, dy: s.y - p.y };
      this.syncProps();
    } else if (this.sel >= 0) {
      this.sel = -1;          // first click on empty space just deselects
      this.syncProps();
    } else {
      const i = this.addStar(clamp(p.x, 0, A), clamp(p.y, 0, A));
      if (i >= 0) this.drag = { kind: 'move', i, dx: 0, dy: 0 };
    }
  };

  Editor.prototype.pointerMove = function (p) {
    this.hover = p;
    const d = this.drag;
    if (!d) return;
    if (this.mode === 'zones' || this.mode === 'nebs') { this.zonePointerMove(p); return; }
    if (this.mode === 'worms') { this.wormPointerMove(p); return; }
    const s = this.draft.sources[d.i];
    if (d.kind === 'move') {
      s.x = clamp(p.x + d.dx, 0, A);
      s.y = clamp(p.y + d.dy, 0, A);
    } else {
      const dx = p.x - s.x, dy = p.y - s.y, len = Math.hypot(dx, dy);
      const sp = Math.max(0, len - s.radius - HANDLE_GAP);
      if (len > 0 && sp > 2) { s.vx = dx / len * sp; s.vy = dy / len * sp; } else { s.vx = 0; s.vy = 0; }
    }
    this.changed();
  };

  Editor.prototype.pointerUp = function () {
    const d = this.drag;
    // A plain click (no drag) in zones mode drops a default-size zone.
    if (d && d.kind === 'zdraw' && !d.moved && this.circles()) {
      this.circles().list[d.i].r = this.circles().def;
      this.changed();
    }
    this.drag = null;
  };

  Editor.prototype.wheel = function (p, deltaY) {
    if (this.mode === 'zones' || this.mode === 'nebs') {
      const hz = this.hitZone(p);
      const i = hz ? hz.i : this.zsel;
      if (i < 0) return false;
      this.zsel = i;
      this.setZoneRadius(this.circles().list[i].r * Math.pow(1.06, deltaY < 0 ? 1 : -1));
      return true;
    }
    if (this.mode === 'worms') {
      const hw = this.hitWorm(p);
      const i = hw ? hw.i : this.wsel;
      if (i < 0) return false;
      this.wsel = i;
      this.setWormRadius(this.draft.wormholes[i].r + (deltaY < 0 ? 2 : -2));
      return true;
    }
    const h = this.hit(p);
    const i = h && h.kind === 'star' ? h.i : this.sel;
    if (i < 0) return false;
    this.sel = i;
    this.setMass(this.draft.sources[i].mass * Math.pow(1.08, deltaY < 0 ? 1 : -1));
    return true;
  };

  Editor.prototype.key = function (e) {
    const k = e.key.toLowerCase();
    if (k === 'delete' || k === 'backspace') this.remove();
    else if (k === 'z') this.setMode(this.mode === 'zones' ? 'stars' : 'zones');
    else if (k === 'w') this.setMode(this.mode === 'worms' ? 'stars' : 'worms');
    else if (k === 'n') this.setMode(this.mode === 'nebs' ? 'stars' : 'nebs');
    else if (k === 'k' && this.sel >= 0) this.cycleKind();
    else if (k === 'a' && this.sel >= 0) this.toggleFixed();
    else if (k === 'o' && this.sel >= 0) this.orbit();
    else if (k === 't' || k === 'enter') { if (!this.ui.test.disabled) this.hooks.onTest(this.toDef()); }
    else if (k === 'escape') {
      if (this.sel >= 0 || this.zsel >= 0 || this.wsel >= 0) { this.sel = -1; this.zsel = -1; this.wsel = -1; this.syncProps(); } else this.exit();
    }
    else return false;
    e.preventDefault();
    return true;
  };

  Editor.prototype.cursor = function () {
    if (this.mode === 'zones' || this.mode === 'nebs') {
      if (this.drag) return this.drag.kind === 'zmove' ? 'grabbing' : 'nwse-resize';
      const hz = this.hover && this.hitZone(this.hover);
      return hz ? (hz.kind === 'zsize' ? 'nesw-resize' : 'grab') : 'cell';
    }
    if (this.mode === 'worms') {
      if (this.drag) return 'grabbing';
      return this.hover && this.hitWorm(this.hover) ? 'grab' : 'copy';
    }
    if (this.drag) return this.drag.kind === 'vel' ? 'crosshair' : 'grabbing';
    const h = this.hover && this.hit(this.hover);
    return h ? (h.kind === 'vel' ? 'crosshair' : 'grab') : 'copy';
  };

  // ---------- drawing (on top of the normal renderer) ----------
  Editor.prototype.drawOverlay = function (ctx, t) {
    const S = this.draft.sources;
    const pv = this.preview;

    // zones: in zone mode outline each one; highlight + resize handle on the selected one
    if (this.mode === 'zones' || this.mode === 'nebs') {
      const neb = this.mode === 'nebs';
      this.circles().list.forEach((z, i) => {
        const selected = i === this.zsel;
        ctx.save();
        ctx.strokeStyle = selected ? 'rgba(255,255,255,0.9)' : neb ? 'rgba(220,150,255,0.55)' : 'rgba(255,120,140,0.55)';
        ctx.lineWidth = selected ? 2.5 : 1.5;
        if (selected) { ctx.setLineDash([8, 6]); ctx.lineDashOffset = -t * 15; }
        ctx.beginPath(); ctx.arc(z.x, z.y, z.r, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
        // centre cross
        ctx.strokeStyle = 'rgba(255,120,140,0.6)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(z.x - 6, z.y); ctx.lineTo(z.x + 6, z.y);
        ctx.moveTo(z.x, z.y - 6); ctx.lineTo(z.x, z.y + 6);
        ctx.stroke();
        if (selected) {
          const h = this.zoneHandle(z);
          ctx.fillStyle = 'rgba(255,120,140,0.3)';
          ctx.strokeStyle = 'rgba(255,200,210,1)';
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(h.x, h.y, HANDLE_R, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        }
      });
    }

    // wormholes: label the mouths and link each pair; highlight the selected pair
    this.draft.wormholes.forEach((w, i) => {
      const selected = this.mode === 'worms' && i === this.wsel;
      const hue = NS.Renderer.wormHue(i);
      ctx.save();
      ctx.setLineDash([4, 8]);
      ctx.lineDashOffset = -t * 12;
      ctx.strokeStyle = `hsla(${hue},85%,72%,${selected ? 0.7 : 0.3})`;
      ctx.lineWidth = selected ? 2 : 1.5;
      ctx.beginPath(); ctx.moveTo(w.ax, w.ay); ctx.lineTo(w.bx, w.by); ctx.stroke();
      if (selected) {
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.setLineDash([5, 5]);
        for (const [x, y] of [[w.ax, w.ay], [w.bx, w.by]]) {
          ctx.beginPath(); ctx.arc(x, y, w.r + 9, 0, Math.PI * 2); ctx.stroke();
        }
      }
      ctx.restore();
      if (this.mode === 'worms') {
        ctx.fillStyle = `hsla(${hue},90%,82%,0.9)`;
        ctx.font = 'bold 14px ui-monospace, Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(String.fromCharCode(65 + i * 2), w.ax, w.ay - w.r - 10);
        ctx.fillText(String.fromCharCode(66 + i * 2), w.bx, w.by - w.r - 10);
        ctx.textAlign = 'start';
      }
    });

    // predicted star paths
    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 6]);
    pv.trails.forEach((tr, k) => {
      if (pv.fixed[k] || tr.length < 4) return;
      ctx.strokeStyle = k === this.sel ? 'rgba(255,220,150,0.6)' : 'rgba(255,190,120,0.3)';
      ctx.beginPath();
      ctx.moveTo(tr[0], tr[1]);
      for (let i = 2; i < tr.length; i += 2) ctx.lineTo(tr[i], tr[i + 1]);
      ctx.stroke();
    });
    ctx.restore();

    // predicted collisions
    ctx.strokeStyle = 'rgba(255,80,110,0.9)';
    ctx.lineWidth = 3;
    for (const m of pv.merges) {
      ctx.beginPath();
      ctx.moveTo(m.x - 9, m.y - 9); ctx.lineTo(m.x + 9, m.y + 9);
      ctx.moveTo(m.x + 9, m.y - 9); ctx.lineTo(m.x - 9, m.y + 9);
      ctx.stroke();
    }

    // velocity vectors + selection
    S.forEach((s, i) => {
      const selected = i === this.sel;
      if (!s.fixed && (s.vx || s.vy || selected)) {
        const h = this.handlePos(s);
        const sp = Math.hypot(s.vx, s.vy);
        if (sp > 0) {
          const ux = s.vx / sp, uy = s.vy / sp;
          ctx.strokeStyle = selected ? 'rgba(120,230,255,0.95)' : 'rgba(120,230,255,0.5)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(s.x + ux * s.radius, s.y + uy * s.radius);
          ctx.lineTo(h.x, h.y);
          ctx.stroke();
        }
        if (selected) {
          ctx.fillStyle = 'rgba(120,230,255,0.25)';
          ctx.strokeStyle = 'rgba(120,230,255,1)';
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(h.x, h.y, HANDLE_R, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        }
      }
      if (selected) {
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.lineDashOffset = -t * 15;
        ctx.beginPath(); ctx.arc(s.x, s.y, s.radius + 13, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }
    });

    if (!S.length) {
      ctx.fillStyle = 'rgba(230,236,245,0.45)';
      ctx.font = '22px ui-monospace, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Click anywhere to place a star', A / 2, A / 2);
      ctx.textAlign = 'start';
    }
  };

  NS.Editor = Editor;
})(window);
