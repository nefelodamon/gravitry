// Gravitry rendering on a 2D canvas. Draws in world units through a camera that normally
// frames the 1000x1000 arena and zooms out to follow the particle when it leaves.
(function (root) {
  'use strict';
  const NS = root.Gravitry;
  const A = NS.ARENA;

  function Renderer(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.scale = 1;
    this.view = { cx: A / 2, cy: A / 2, half: A / 2 }; // visible square: centre + half-size
    this.camHalf = A / 2;       // framing from follow(), before the slow-mo focus is blended in
    this.focusK = 0;            // 0..1: how far the camera is pulled in on this.focusAt
    this.focusAt = { x: A / 2, y: A / 2 };
    this.fx = [];               // live effects (sparks, rings)
    this.shakeEnabled = true;
    this.shakeAmp = 0;
    this.lastT = null;
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas);
    this.resize();
  }

  Renderer.prototype.resize = function () {
    const dpr = window.devicePixelRatio || 1;
    const size = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    if (this.canvas.width !== size) { this.canvas.width = size; this.canvas.height = size; }
    this.scale = size / A;
  };

  // ---------- camera ----------
  const VIEW_MARGIN = 90;     // world units kept between the particle and the view edge
  const ZOOM_OUT_RATE = 7;    // per second (exponential easing)
  const ZOOM_IN_RATE = 2.2;

  // Ease the camera toward framing the arena plus the particle (if it's out there).
  // The view stays centred on the arena, so leaving it reads as a zoom out.
  Renderer.prototype.follow = function (particle, dt) {
    const v = this.view;
    v.half = this.camHalf;
    let need = A / 2;
    const d = particle ? Math.max(Math.abs(particle.x - A / 2), Math.abs(particle.y - A / 2)) : 0;
    // Only zoom once the particle is past the edge; the margin ramps in over the first
    // VIEW_MARGIN units outside so there's no jump at the boundary.
    if (d > A / 2) need = d + VIEW_MARGIN * Math.min(1, (d - A / 2) / VIEW_MARGIN);
    const rate = need > v.half ? ZOOM_OUT_RATE : ZOOM_IN_RATE;
    v.half += (need - v.half) * (1 - Math.exp(-rate * dt));
    // Never let a fast particle slip off screen while the zoom catches up.
    if (d > A / 2) v.half = Math.max(v.half, d + 12);
    if (Math.abs(v.half - A / 2) < 0.5 && need === A / 2) v.half = A / 2;
    this.camHalf = v.half;
    // slow-mo: zoom in toward the focus point (a near miss) by up to FOCUS_ZOOM
    const k = this.focusK;
    if (k > 0) {
      v.half = this.camHalf * (1 - (1 - FOCUS_ZOOM) * k);
      v.cx = A / 2 + (this.focusAt.x - A / 2) * k;
      v.cy = A / 2 + (this.focusAt.y - A / 2) * k;
    } else { v.cx = A / 2; v.cy = A / 2; }
  };

  // Slow-mo camera: k = 0..1 pull toward (x, y).
  const FOCUS_ZOOM = 0.55;
  Renderer.prototype.focus = function (x, y, k) {
    this.focusK = Math.max(0, Math.min(1, k));
    if (x != null) { this.focusAt.x = x; this.focusAt.y = y; }
  };

  // Frame the arena again right away (new level): clicks must map to the arena at once.
  Renderer.prototype.resetView = function () {
    this.view.half = this.camHalf = A / 2;
    this.view.cx = this.view.cy = A / 2;
    this.focusK = 0;
  };

  Renderer.prototype.zoom = function () { return this.view.half / (A / 2); };

  // Canvas-relative fractions (0..1) -> world coordinates.
  Renderer.prototype.screenToWorld = function (fx, fy) {
    const v = this.view;
    return { x: v.cx - v.half + fx * 2 * v.half, y: v.cy - v.half + fy * 2 * v.half };
  };

  Renderer.prototype.draw = function (world, ui) {
    const ctx = this.ctx;
    const v = this.view;
    const z = this.zoom();
    const dt = this.lastT == null ? 0 : Math.max(0, Math.min(0.1, ui.time - this.lastT));
    this.lastT = ui.time;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!ui.noStars) drawStarfield(this, ctx, z, ui.time);
    // screen shake: a quick decaying jitter of the whole view
    let ox = 0, oy = 0;
    if (this.shakeAmp > 0) {
      this.shakeAge += dt;
      const a = this.shakeAmp * Math.max(0, 1 - this.shakeAge / 0.35);
      if (a <= 0) this.shakeAmp = 0;
      else { ox = (Math.random() * 2 - 1) * a; oy = (Math.random() * 2 - 1) * a; }
    }
    this.shakeOffset = { x: ox, y: oy };
    const s = this.canvas.width / (2 * v.half);
    const px = this.canvas.width / 1000;  // shake is in canvas pixels, scaled to the canvas size
    ctx.setTransform(s, 0, 0, s, -(v.cx - v.half) * s + ox * px, -(v.cy - v.half) * s + oy * px);

    if (v.cx - v.half < -0.5 || v.cy - v.half < -0.5 || v.cx + v.half > A + 0.5 || v.cy + v.half > A + 0.5) drawOutside(ctx, v, z);
    drawGrid(ctx, v, z);
    if (!world) return;

    if (ui.showField) this.drawField(world.sources, v, z);

    if (world.nebulae && world.nebulae.length) drawNebulae(ctx, world.nebulae, ui.time);
    if (world.status === 'placing') drawZones(ctx, world.zones, ui.time);
    if (ui.marks) drawMarks(ctx, ui.marks, world.status === 'placing' ? 1 : 0.35);

    if (ui.ghostPath) drawGhostPath(ctx, ui.ghostPath, z, ui.ghostTime);
    if (world.wormholes && world.wormholes.length) drawWormholes(ctx, world.wormholes, ui.time, world.status === 'placing');
    for (const s of world.sources) if (s.kind !== 'comet') drawTrail(ctx, s.trail, 'rgba(255,170,90,', 0.22, 1.5 * z);
    if (world.particle) drawTrail(ctx, world.particle.trail, 'rgba(120,230,255,', 0.9, 2 * z);

    for (const s of world.sources) {
      if (s.kind === 'blackhole') drawBlackHole(ctx, s, ui.time);
      else if (s.kind === 'pulsar') drawPulsar(ctx, s, ui.time);
      else if (s.kind === 'whitehole') drawWhiteHole(ctx, s, ui.time);
      else if (s.kind === 'comet') drawComet(ctx, s, world.sources, ui.time);
      else drawSource(ctx, s, ui.time);
    }
    drawCometPointers(ctx, world.sources, v, z);
    if (world.status === 'placing') {
      if (!ui.hideArrows) for (const s of world.sources) drawVelocity(ctx, s);
      if (ui.ghost) drawGhost(ctx, ui.ghost, ui.ghostValid, ui.time);
      if (ui.aim) drawAim(ctx, ui.aim, ui.time);
    }

    if (world.particle) drawParticle(ctx, world.particle, world.status, z);
    if (ui.thrustAim) drawThrustAim(ctx, ui.thrustAim, ui.time, z);
    drawEffects(this, ctx, dt, z);
    if (ui.vignette > 0) drawVignette(ctx, this.canvas.width, ui.vignette);
  };

  // Thruster aim: an orange arrow from the particle toward the pointer (where the next
  // nudge will push), a faint dotted line on to the pointer, and a small target ring there.
  function drawThrustAim(ctx, a, t, z) {
    const dx = a.tx - a.x, dy = a.ty - a.y, d = Math.hypot(dx, dy);
    if (d < 1) return;
    const ux = dx / d, uy = dy / d;
    const r0 = 10 * z, len = Math.min(d, (40 + a.dv * 0.7) * z);
    const pulse = 0.75 + 0.25 * Math.sin(t * 6);
    ctx.save();
    // dotted guide to the pointer
    if (d > len + 6 * z) {
      ctx.strokeStyle = 'rgba(255,190,110,0.32)';
      ctx.lineWidth = 1.2 * z;
      ctx.setLineDash([3 * z, 6 * z]);
      ctx.beginPath(); ctx.moveTo(a.x + ux * len, a.y + uy * len); ctx.lineTo(a.tx, a.ty); ctx.stroke();
      ctx.setLineDash([]);
    }
    // arrow
    const x1 = a.x + ux * Math.max(r0, len), y1 = a.y + uy * Math.max(r0, len);
    ctx.strokeStyle = `rgba(255,190,110,${0.85 * pulse})`;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 3 * z;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(a.x + ux * r0, a.y + uy * r0); ctx.lineTo(x1, y1); ctx.stroke();
    const hl = 12 * z, hw = 7 * z;
    ctx.beginPath();
    ctx.moveTo(x1 + ux * 3 * z, y1 + uy * 3 * z);
    ctx.lineTo(x1 - ux * hl - uy * hw, y1 - uy * hl + ux * hw);
    ctx.lineTo(x1 - ux * hl + uy * hw, y1 - uy * hl - ux * hw);
    ctx.closePath(); ctx.fill();
    // target ring at the pointer
    ctx.strokeStyle = 'rgba(255,190,110,0.5)';
    ctx.lineWidth = 1.2 * z;
    ctx.beginPath(); ctx.arc(a.tx, a.ty, 7 * z, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  // Slow-mo: darken the edges of the screen (k = 0..1).
  function drawVignette(ctx, W, k) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const g = ctx.createRadialGradient(W / 2, W / 2, W * 0.3, W / 2, W / 2, W * 0.75);
    g.addColorStop(0, 'rgba(0,0,8,0)');
    g.addColorStop(1, `rgba(0,0,8,${0.6 * k})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, W);
  }

  // Zoomed out: tint the space beyond the arena gray.
  function drawOutside(ctx, v, z) {
    const x0 = v.cx - v.half, y0 = v.cy - v.half, w = 2 * v.half;
    ctx.fillStyle = 'rgba(128,128,128,0.16)';
    ctx.beginPath();
    ctx.rect(x0, y0, w, w);
    ctx.rect(A, 0, -A, A);          // opposite winding punches the arena out
    ctx.fill('evenodd');
  }

  // ---------- gravitational field overlay ----------
  const FIELD_RES = 180;          // potential map resolution (pixels per side)
  const FIELD_SOFT2 = 20 * 20;

  Renderer.prototype.drawField = function (sources, v, z) {
    const ctx = this.ctx;
    if (!this.fieldCanvas) {
      this.fieldCanvas = document.createElement('canvas');
      this.fieldCanvas.width = this.fieldCanvas.height = FIELD_RES;
      this.fieldCtx = this.fieldCanvas.getContext('2d');
      this.fieldImg = this.fieldCtx.createImageData(FIELD_RES, FIELD_RES);
    }

    // Potential map: a soft glow whose brightness = depth of the gravity well.
    // Only recomputed when a source has moved.
    const x0 = v.cx - v.half, y0 = v.cy - v.half, w = 2 * v.half;
    let key = x0.toFixed(0) + ',' + y0.toFixed(0) + ',' + w.toFixed(0) + '|';
    for (const s of sources) key += s.x.toFixed(1) + ',' + s.y.toFixed(1) + ',' + s.mass + ';';
    if (key !== this.fieldKey) {
      this.fieldKey = key;
      this.computePotential(sources, x0, y0, w);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.fieldCanvas, x0, y0, w, w);
    drawWarpGrid(this, ctx, sources, x0, y0, w, z, key);
  };

  Renderer.prototype.computePotential = function (sources, x0, y0, w) {
    const d = this.fieldImg.data;
    const cell = w / FIELD_RES;
    for (let py = 0; py < FIELD_RES; py++) {
      const y = y0 + (py + 0.5) * cell;
      for (let px = 0; px < FIELD_RES; px++) {
        const x = x0 + (px + 0.5) * cell;
        let phi = 0;
        for (const s of sources) {
          if (s.kind === 'whitehole') continue;
          const dx = x - s.x, dy = y - s.y;
          phi += s.mass / Math.sqrt(dx * dx + dy * dy + FIELD_SOFT2);
        }
        const lg = Math.log10(NS.G * phi + 1);
        const n = Math.min(1, Math.max(0, (lg - 3) / 2.4));
        const i = (py * FIELD_RES + px) * 4;
        d[i] = 60 + 120 * n;
        d[i + 1] = 90 + 60 * n;
        d[i + 2] = 255;
        d[i + 3] = Math.min(255, n * n * 0.28 * 255);
      }
    }
    this.fieldCtx.putImageData(this.fieldImg, 0, 0);
  };

  // Warped grid: a sheet of grid lines pulled in toward each mass, like a rubber
  // sheet seen from above. Each source drags points toward itself by
  // D(r) = b²r / (r² + b²): zero at the centre, at most b/2, fading as b²/r far
  // away, and never folding over (r - D(r) keeps increasing with r).
  const WARP_STEP = 28;           // grid spacing in world units (at zoom 1)
  const WARP_SAMPLE = 6;          // points along each line, in world units (at zoom 1)
  const WARP_K = 0.1;             // b = WARP_K * sqrt(mass) ...
  const WARP_B_MAX = 150;         // ... capped, so two heavy wells side by side don't knot the sheet
  const WARP_BH = 1.7;            // black holes bend the sheet this much more (and get a higher cap)
  const WARP_COMET = 0.45;         // comets are light, fast visitors: a shallow dent
  const warpB = s => s.kind === 'comet' ? WARP_COMET * Math.min(WARP_B_MAX, WARP_K * Math.sqrt(s.mass))
    : s.kind === 'blackhole'
    ? Math.min(WARP_B_MAX * WARP_BH, WARP_BH * WARP_K * Math.sqrt(s.mass))
    : Math.min(WARP_B_MAX, WARP_K * Math.sqrt(s.mass));

  // Each source's pull on its own never folds the sheet, so the pulls are applied one
  // after another and the result can't fold either, even between two heavy wells.
  // Later pulls would drag an earlier funnel off its source, so each funnel is centred
  // where the later pulls will carry it back onto the source (see placeWells).
  // White holes (sgn = -1) push points outward instead: r' = r + D(r), which never folds either.
  function warpPoint(wells, x, y, out) {
    let px = x, py = y;
    for (const s of wells) {
      const rx = s.x - px, ry = s.y - py;
      const r2 = rx * rx + ry * ry;
      const k = s.sgn * s.b2 / (r2 + s.b2);  // = ±D(r) / r
      px += rx * k; py += ry * k;
    }
    out[0] = px; out[1] = py; out[2] = Math.hypot(px - x, py - y);
  }

  // Undo one well's pull: find r with r³ / (r² + b²) = r' (Newton; the answer lies in [r', r' + b/2]).
  function unwarpOne(w, x, y) {
    const dx = x - w.x, dy = y - w.y, rp = Math.hypot(dx, dy);
    if (rp < 1e-9) return [x, y];
    if (w.sgn < 0) {
      // push: solve r + b²r/(r²+b²) = r' for r in [r'/2, r']
      let r = rp * 0.75;
      for (let i = 0; i < 30; i++) {
        const q = r * r + w.b2;
        const f = r + w.b2 * r / q - rp;
        const df = 1 + w.b2 * (w.b2 - r * r) / (q * q);
        const nr = Math.min(rp, Math.max(rp / 2, r - f / df));
        if (Math.abs(nr - r) < 1e-6) { r = nr; break; }
        r = nr;
      }
      return [w.x + dx * r / rp, w.y + dy * r / rp];
    }
    let r = rp + Math.sqrt(w.b2) / 2;
    for (let i = 0; i < 30; i++) {
      const f = r * r * r / (r * r + w.b2) - rp;
      const df = (r * r * r * r + 3 * r * r * w.b2) / ((r * r + w.b2) * (r * r + w.b2));
      const nr = Math.max(rp, r - f / df);
      if (Math.abs(nr - r) < 1e-6) { r = nr; break; }
      r = nr;
    }
    return [w.x + dx * r / rp, w.y + dy * r / rp];
  }

  function placeWells(sources) {
    const wells = sources.map((s, i) => ({ sx: s.x, sy: s.y, x: s.x, y: s.y, b2: warpB(s) ** 2, sgn: s.kind === 'whitehole' ? -1 : 1, i }))
      .sort((p, q) => p.b2 - q.b2 || p.i - q.i);         // heaviest applied last
    for (let i = wells.length - 2; i >= 0; i--) {
      let p = [wells[i].sx, wells[i].sy];
      for (let j = wells.length - 1; j > i; j--) p = unwarpOne(wells[j], p[0], p[1]);
      wells[i].x = p[0]; wells[i].y = p[1];
    }
    return wells;
  }

  Renderer.prototype.buildWarpGrid = function (sources, x0, y0, w, z) {
    const step = WARP_STEP * z, ds = WARP_SAMPLE * z;
    const wells = placeWells(sources);
    const paths = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
    const pt = [0, 0, 0];
    const level = d => Math.min(3, Math.floor(d / (step * 0.35)));  // brighter where it's pulled further
    const pad = step * 4 + WARP_B_MAX * WARP_BH * z;   // lines from outside the view get pulled into it
    const gx0 = Math.floor((x0 - pad) / step) * step, gy0 = Math.floor((y0 - pad) / step) * step;
    const gx1 = x0 + w + pad, gy1 = y0 + w + pad;
    const line = (fixed, vertical) => {
      let px = 0, py = 0, plev = -1, first = true;
      for (let t = vertical ? gy0 : gx0; t <= (vertical ? gy1 : gx1) + 1e-6; t += ds) {
        if (vertical) warpPoint(wells, fixed, t, pt); else warpPoint(wells, t, fixed, pt);
        const lev = level(pt[2]);
        if (!first) {
          const p = paths[Math.max(lev, plev)];
          p.moveTo(px, py); p.lineTo(pt[0], pt[1]);
        }
        px = pt[0]; py = pt[1]; plev = lev; first = false;
      }
    };
    for (let x = gx0; x <= gx1; x += step) line(x, true);
    for (let y = gy0; y <= gy1; y += step) line(y, false);
    return paths;
  };

  function drawWarpGrid(r, ctx, sources, x0, y0, w, z, key) {
    if (r.warpKey !== key) { r.warpKey = key; r.warpPaths = r.buildWarpGrid(sources, x0, y0, w, z); }
    ctx.lineWidth = 1.1 * z;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    r.warpPaths.forEach((p, i) => {
      ctx.strokeStyle = `rgba(140,175,255,${0.16 + i * 0.14})`;
      ctx.stroke(p);
    });
  }

  function drawGrid(ctx, v, z) {
    const step = z > 4 ? 1000 : z > 1.8 ? 500 : 100;
    const x0 = v.cx - v.half, y0 = v.cy - v.half, x1 = v.cx + v.half, y1 = v.cy + v.half;
    ctx.strokeStyle = 'rgba(255,255,255,0.035)';
    ctx.lineWidth = z;
    ctx.beginPath();
    for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
    for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
    ctx.stroke();
  }

  function drawZones(ctx, zones, t) {
    if (!zones.length) return;
    // Shade everything inside forbidden circles (clipped to the arena).
    ctx.save();
    ctx.beginPath();
    for (const z of zones) { ctx.moveTo(z.x + z.r, z.y); ctx.arc(z.x, z.y, z.r, 0, Math.PI * 2); }
    ctx.fillStyle = 'rgba(255,60,90,0.06)';
    ctx.fill();
    ctx.setLineDash([10, 10]);
    ctx.lineDashOffset = -t * 20;
    ctx.strokeStyle = 'rgba(255,80,110,0.45)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  // Previous drop spots, coloured red -> yellow -> green by how far that run got.
  function drawMarks(ctx, marks, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    marks.forEach((m, i) => {
      const hue = Math.round(m.frac * 120);
      const latest = i === marks.length - 1;
      ctx.fillStyle = `hsla(${hue}, 90%, 58%, 0.85)`;
      ctx.beginPath(); ctx.arc(m.x, m.y, latest ? 6 : 4.5, 0, Math.PI * 2); ctx.fill();
      if (latest || m.won) {
        ctx.strokeStyle = `hsla(${hue}, 90%, 70%, 0.7)`;
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(m.x, m.y, 11, 0, Math.PI * 2); ctx.stroke();
      }
    });
    ctx.restore();
  }

  function drawTrail(ctx, t, rgb, alpha, width) {
    const n = t.length / 2;
    if (n < 2) return;
    const CHUNK = 24;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let start = 0; start < n - 1; start += CHUNK) {
      const end = Math.min(n - 1, start + CHUNK);
      const f = end / (n - 1);
      ctx.strokeStyle = rgb + (alpha * f * f).toFixed(3) + ')';
      ctx.beginPath();
      let pen = false;  // NaN entries mark a break (wormhole jump)
      for (let i = start; i <= end; i++) {
        const x = t[i * 2], y = t[i * 2 + 1];
        if (x !== x) { pen = false; continue; }
        if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
      }
      ctx.stroke();
    }
  }

  // ---------- stars ----------
  // Colour follows mass like real stars: light = red dwarf, medium = yellow-orange, heavy = blue-white.
  const PALETTES = [
    { at: 0.0, dark: [95, 12, 2], mid: [215, 58, 14], bright: [255, 150, 80], glow: [255, 70, 30] },
    { at: 0.7, dark: [150, 52, 4], mid: [250, 140, 30], bright: [255, 228, 150], glow: [255, 145, 50] },
    { at: 1.0, dark: [60, 95, 210], mid: [160, 190, 255], bright: [245, 250, 255], glow: [120, 165, 255] },
  ];
  const TEMP_BUCKETS = 10;
  const SPRITE = 96;
  const spriteCache = new Map();

  const mix = (a, b, k) => a + (b - a) * k;
  const mix3 = (a, b, k) => [mix(a[0], b[0], k), mix(a[1], b[1], k), mix(a[2], b[2], k)];

  function temperature(mass) {
    const t = Math.log(mass / 2e5) / Math.log(6e6 / 2e5);
    return Math.max(0, Math.min(1, t));
  }

  function paletteAt(tt) {
    const i = tt < PALETTES[1].at ? 0 : 1;
    const a = PALETTES[i], b = PALETTES[i + 1];
    const k = (tt - a.at) / (b.at - a.at);
    return { dark: mix3(a.dark, b.dark, k), mid: mix3(a.mid, b.mid, k), bright: mix3(a.bright, b.bright, k), glow: mix3(a.glow, b.glow, k) };
  }

  // Seeded value noise + fractal sum, used to paint the star surfaces.
  function makeNoise(seed) {
    // 256x256 table of seeded random values (mulberry32), wrapped.
    const T = new Float32Array(65536);
    let a = (Math.floor(seed * 1000) ^ 0x9E3779B9) >>> 0;
    for (let i = 0; i < 65536; i++) {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      T[i] = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    const h = (x, y) => T[((y & 255) << 8) | (x & 255)];
    const sm = t => t * t * (3 - 2 * t);
    const vnoise = (x, y) => {
      x += 64; y += 64; // keep lattice indices positive
      const ix = Math.floor(x), iy = Math.floor(y), fx = sm(x - ix), fy = sm(y - iy);
      const a = h(ix, iy), b = h(ix + 1, iy), c = h(ix, iy + 1), d = h(ix + 1, iy + 1);
      return mix(mix(a, b, fx), mix(c, d, fx), fy);
    };
    return (x, y) => {
      let sum = 0, amp = 0.5, f = 1;
      for (let o = 0; o < 4; o++) { sum += amp * vnoise(x * f, y * f); f *= 2.03; amp *= 0.5; }
      return sum / 0.9375;
    };
  }

  // Pre-render one star surface: churning granulation, limb darkening, a few sunspots on cooler stars.
  function starSprite(bucket, variant) {
    const key = bucket + '|' + variant;
    let sp = spriteCache.get(key);
    if (sp) return sp;
    const tt = bucket / (TEMP_BUCKETS - 1);
    const pal = paletteAt(tt);
    const seed = variant * 7.13 + bucket * 1.37 + 1;
    const fbm = makeNoise(seed);
    const rnd = makeNoise(seed + 50);
    const spots = [];
    const nSpots = tt < 0.75 ? 1 + Math.floor(rnd(3.3, 1.1) * 3) : 0;
    for (let i = 0; i < nSpots; i++) {
      const a = rnd(i * 4.1, 7.7) * Math.PI * 4, r = 0.25 + rnd(i * 2.3, 1.9) * 0.45;
      spots.push({ x: Math.cos(a) * r, y: Math.sin(a) * r, r: 0.07 + rnd(i * 5.7, 3.1) * 0.08 });
    }

    const c = document.createElement('canvas');
    c.width = c.height = SPRITE;
    const g = c.getContext('2d');
    const img = g.createImageData(SPRITE, SPRITE);
    const d = img.data;
    const R = SPRITE / 2;
    for (let py = 0; py < SPRITE; py++) {
      for (let px = 0; px < SPRITE; px++) {
        const x = (px + 0.5 - R) / R, y = (py + 0.5 - R) / R;
        const r2 = x * x + y * y;
        if (r2 > 1) continue;
        const mu = Math.sqrt(1 - r2);                       // 1 at centre, 0 at the limb
        // domain-warped noise reads as convection cells
        const qx = fbm(x * 2.2, y * 2.2), qy = fbm(x * 2.2 + 5.2, y * 2.2 + 1.3);
        const n = fbm(x * 4 + qx * 2.4, y * 4 + qy * 2.4);
        const cells = 0.5 + 0.5 * Math.sin(n * 13);
        let lum = (0.5 + 0.5 * mu) * (0.62 + 0.3 * n + 0.2 * cells);
        for (const s of spots) {
          const dd = Math.hypot(x - s.x, y - s.y) / s.r;
          if (dd < 1.6) lum *= dd < 1 ? 0.45 + 0.25 * dd : 0.7 + 0.3 * (dd - 1) / 0.6;
        }
        lum = Math.max(0, Math.min(1.15, lum));
        const col = lum < 0.6 ? mix3(pal.dark, pal.mid, lum / 0.6) : mix3(pal.mid, pal.bright, Math.min(1, (lum - 0.6) / 0.5));
        const edge = Math.min(1, (1 - Math.sqrt(r2)) * R * 1.2);   // anti-aliased rim
        const i = (py * SPRITE + px) * 4;
        d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2]; d[i + 3] = 255 * edge;
      }
    }
    g.putImageData(img, 0, 0);
    sp = { canvas: c, glow: pal.glow, bright: pal.bright };
    spriteCache.set(key, sp);
    return sp;
  }

  function drawSource(ctx, s, t) {
    const tt = temperature(s.mass);
    const bucket = Math.round(tt * (TEMP_BUCKETS - 1));
    const variant = (s.variant || 0) % 4;
    const sp = starSprite(bucket, variant);
    const [gr, gg, gb] = sp.glow.map(Math.round);
    const phase = variant * 1.7;

    // outer glow, breathing slightly
    const breathe = 1 + 0.04 * Math.sin(t * 1.6 + phase);
    const glow = s.radius * (2.4 + Math.sqrt(s.mass / 1e6) * 0.9) * breathe;
    const g = ctx.createRadialGradient(s.x, s.y, s.radius * 0.6, s.x, s.y, glow);
    g.addColorStop(0, `rgba(${gr},${gg},${gb},0.5)`);
    g.addColorStop(0.35, `rgba(${gr},${gg},${gb},0.16)`);
    g.addColorStop(1, `rgba(${gr},${gg},${gb},0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(s.x, s.y, glow, 0, Math.PI * 2); ctx.fill();

    // corona flares: soft tongues of light that flicker around the rim
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const fg = ctx.createRadialGradient(s.x, s.y, s.radius * 0.9, s.x, s.y, s.radius * 1.9);
    fg.addColorStop(0, `rgba(${gr},${gg},${gb},0.3)`);
    fg.addColorStop(0.4, `rgba(${gr},${gg},${gb},0.07)`);
    fg.addColorStop(1, `rgba(${gr},${gg},${gb},0)`);
    ctx.fillStyle = fg;
    const N = 9;
    const spin = t * 0.08 * (variant % 2 ? 1 : -1);
    ctx.beginPath();
    for (let i = 0; i < N; i++) {
      const a = phase + spin + (i / N) * Math.PI * 2 + 0.3 * Math.sin(i * 3.7 + variant);
      const flick = 0.5 + 0.5 * Math.sin(t * (1.1 + (i % 3) * 0.37) + i * 2.3 + phase);
      const len = s.radius * (0.18 + 0.42 * flick * (0.6 + 0.4 * Math.sin(i * 5.1 + variant * 2)));
      const w = 0.11 + 0.05 * Math.sin(i * 1.9);
      const r0 = s.radius * 0.92;
      ctx.moveTo(s.x + Math.cos(a - w) * r0, s.y + Math.sin(a - w) * r0);
      // rounded tongue: bulge out from one side of the base to the other
      const tipA = a + 0.12 * Math.sin(t * 0.9 + i); // tips sway a little
      ctx.bezierCurveTo(
        s.x + Math.cos(a - w * 0.8) * (r0 + len * 0.9), s.y + Math.sin(a - w * 0.8) * (r0 + len * 0.9),
        s.x + Math.cos(tipA - w * 0.3) * (r0 + len * 1.1), s.y + Math.sin(tipA - w * 0.3) * (r0 + len * 1.1),
        s.x + Math.cos(tipA) * (r0 + len * 1.1), s.y + Math.sin(tipA) * (r0 + len * 1.1));
      ctx.bezierCurveTo(
        s.x + Math.cos(tipA + w * 0.3) * (r0 + len * 1.1), s.y + Math.sin(tipA + w * 0.3) * (r0 + len * 1.1),
        s.x + Math.cos(a + w * 0.8) * (r0 + len * 0.9), s.y + Math.sin(a + w * 0.8) * (r0 + len * 0.9),
        s.x + Math.cos(a + w) * r0, s.y + Math.sin(a + w) * r0);
      ctx.closePath();
    }
    ctx.fill();
    ctx.restore();

    // textured, slowly rotating surface
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(t * 0.12 * (variant % 2 ? -1 : 1) + phase);
    ctx.drawImage(sp.canvas, -s.radius, -s.radius, s.radius * 2, s.radius * 2);
    ctx.restore();

    // hot inner highlight
    const [br, bg, bb] = sp.bright.map(Math.round);
    const hl = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.radius);
    hl.addColorStop(0, `rgba(${br},${bg},${bb},0.16)`);
    hl.addColorStop(0.55, `rgba(${br},${bg},${bb},0.03)`);
    hl.addColorStop(1, `rgba(${br},${bg},${bb},0)`);
    ctx.fillStyle = hl;
    ctx.beginPath(); ctx.arc(s.x, s.y, s.radius, 0, Math.PI * 2); ctx.fill();

    if (s.fixed) {
      // anchored sources get a slowly rotating dashed ring
      ctx.save();
      ctx.setLineDash([6, 8]);
      ctx.lineDashOffset = t * 12;
      ctx.strokeStyle = 'rgba(255,220,170,0.5)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(s.x, s.y, s.radius + 8, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
  }

  // ---------- black holes ----------
  // Pre-rendered accretion disk: hot streaky gas, white near the horizon, red at the edge.
  const DISK = 256, DISK_OUT = 3.4;   // outer disk radius in horizon radii
  const diskCache = new Map();
  function diskSprite(variant) {
    let c = diskCache.get(variant);
    if (c) return c;
    c = document.createElement('canvas');
    c.width = c.height = DISK;
    const g = c.getContext('2d');
    const img = g.createImageData(DISK, DISK);
    const d = img.data;
    const fbm = makeNoise(variant * 3.1 + 11);
    const R = DISK / 2;
    for (let py = 0; py < DISK; py++) {
      for (let px = 0; px < DISK; px++) {
        const x = (px + 0.5 - R) / R * DISK_OUT, y = (py + 0.5 - R) / R * DISK_OUT;
        const rr = Math.hypot(x, y);
        if (rr < 1 || rr > DISK_OUT) continue;
        const th = Math.atan2(y, x);
        // streaks wound into a spiral; sampled on a circle so there is no seam
        const sw = th + 1.6 * Math.log(rr);
        const n = fbm(Math.cos(sw) * 2.2 + rr * 2.6, Math.sin(sw) * 2.2 + rr * 0.6);
        const k = (rr - 1) / (DISK_OUT - 1);                       // 0 inner .. 1 outer
        const fall = Math.pow(1 - k, 1.6) * Math.min(1, (rr - 1) * 5);
        const lum = fall * (0.55 + 1.3 * n * n);
        const col = k < 0.25 ? mix3([255, 250, 235], [255, 200, 120], k / 0.25)
          : mix3([255, 200, 120], [200, 60, 20], Math.min(1, (k - 0.25) / 0.6));
        const i = (py * DISK + px) * 4;
        d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2];
        d[i + 3] = Math.min(255, lum * 255);
      }
    }
    g.putImageData(img, 0, 0);
    diskCache.set(variant, c);
    return c;
  }

  function drawBlackHole(ctx, s, t) {
    const r = s.radius, variant = (s.variant || 0) % 4;
    // faint lensing glow
    const halo = ctx.createRadialGradient(s.x, s.y, r, s.x, s.y, r * 6);
    halo.addColorStop(0, 'rgba(255,170,90,0.28)');
    halo.addColorStop(0.4, 'rgba(255,120,60,0.08)');
    halo.addColorStop(1, 'rgba(255,120,60,0)');
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(s.x, s.y, r * 6, 0, Math.PI * 2); ctx.fill();
    // spinning accretion disk, two layers turning at different rates
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(s.x, s.y);
    ctx.rotate(t * (0.9 + variant * 0.1) * (variant % 2 ? -1 : 1));
    const D = r * DISK_OUT;
    ctx.drawImage(diskSprite(variant), -D, -D, D * 2, D * 2);
    ctx.rotate(1.3 - t * 0.5);
    ctx.globalAlpha = 0.45;
    ctx.drawImage(diskSprite((variant + 1) % 4), -D * 0.8, -D * 0.8, D * 1.6, D * 1.6);
    ctx.restore();
    // event horizon: pure black with a soft edge
    const core = ctx.createRadialGradient(s.x, s.y, r * 0.7, s.x, s.y, r * 1.12);
    core.addColorStop(0, 'rgba(0,0,0,1)');
    core.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = core;
    ctx.beginPath(); ctx.arc(s.x, s.y, r * 1.12, 0, Math.PI * 2); ctx.fill();
    // photon ring
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = `rgba(255,235,200,${0.55 + 0.15 * Math.sin(t * 3 + variant)})`;
    ctx.lineWidth = Math.max(1, r * 0.12);
    ctx.beginPath(); ctx.arc(s.x, s.y, r * 1.08, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    if (s.fixed) {
      ctx.save();
      ctx.setLineDash([6, 8]);
      ctx.lineDashOffset = t * 12;
      ctx.strokeStyle = 'rgba(255,220,170,0.35)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(s.x, s.y, r * DISK_OUT + 6, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
  }

  // ---------- pulsars ----------
  // A tiny, hot neutron star sweeping two beams around; its glow follows the mass pulse.
  function pulsePhase(s) {
    return s.pulse && s.base ? Math.max(-1, Math.min(1, (s.mass / s.base - 1) / (s.pulse.amp || 1))) : 0;
  }
  function drawPulsar(ctx, s, t) {
    const r = s.radius, variant = (s.variant || 0) % 4;
    const k = 0.5 + 0.5 * pulsePhase(s);              // 0 = faint .. 1 = peak
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // glow that swells with the pulse
    const gr = r * (4 + 4 * k);
    const g = ctx.createRadialGradient(s.x, s.y, r * 0.5, s.x, s.y, gr);
    g.addColorStop(0, `rgba(150,200,255,${0.35 + 0.35 * k})`);
    g.addColorStop(0.4, `rgba(120,170,255,${0.08 + 0.12 * k})`);
    g.addColorStop(1, 'rgba(120,170,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(s.x, s.y, gr, 0, Math.PI * 2); ctx.fill();
    // two opposite beams sweeping round
    const ang = t * (1.6 + variant * 0.2) * (variant % 2 ? -1 : 1) + variant;
    const len = r * (11 + 7 * k), wid = 0.16;
    for (const dir of [0, Math.PI]) {
      const a = ang + dir;
      const bg = ctx.createRadialGradient(s.x, s.y, r, s.x, s.y, len);
      bg.addColorStop(0, `rgba(210,230,255,${0.35 + 0.4 * k})`);
      bg.addColorStop(1, 'rgba(160,200,255,0)');
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.arc(s.x, s.y, len, a - wid, a + wid);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    // core
    const c = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r);
    c.addColorStop(0, '#ffffff');
    c.addColorStop(0.6, '#dcebff');
    c.addColorStop(1, '#7fa8ff');
    ctx.fillStyle = c;
    ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2); ctx.fill();
    if (s.fixed) {
      ctx.save();
      ctx.setLineDash([5, 7]);
      ctx.lineDashOffset = t * 12;
      ctx.strokeStyle = 'rgba(190,215,255,0.45)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(s.x, s.y, r + 9, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
  }

  // ---------- white holes ----------
  // The reverse of a black hole: a blinding core with light rippling outward.
  function drawWhiteHole(ctx, s, t) {
    const r = s.radius, variant = (s.variant || 0) % 4;
    const reach = r * (3 + Math.sqrt(s.mass / 1e6) * 1.2);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(s.x, s.y, r * 0.5, s.x, s.y, reach * 1.3);
    g.addColorStop(0, 'rgba(235,245,255,0.55)');
    g.addColorStop(0.3, 'rgba(190,225,255,0.14)');
    g.addColorStop(1, 'rgba(190,225,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(s.x, s.y, reach * 1.3, 0, Math.PI * 2); ctx.fill();
    // ripples flowing outward
    for (let i = 0; i < 4; i++) {
      const k = (t * 0.45 + i / 4 + variant * 0.13) % 1;
      ctx.strokeStyle = `rgba(215,235,255,${0.45 * (1 - k)})`;
      ctx.lineWidth = Math.max(1, r * 0.18 * (1 - k));
      ctx.beginPath(); ctx.arc(s.x, s.y, r * 1.1 + k * (reach - r), 0, Math.PI * 2); ctx.stroke();
    }
    // short rays
    ctx.strokeStyle = 'rgba(235,245,255,0.35)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let i = 0; i < 12; i++) {
      const a = i / 12 * Math.PI * 2 + t * 0.15 * (variant % 2 ? 1 : -1);
      const l = r * (1.6 + 0.6 * Math.sin(t * 2 + i * 1.7));
      ctx.moveTo(s.x + Math.cos(a) * r * 1.15, s.y + Math.sin(a) * r * 1.15);
      ctx.lineTo(s.x + Math.cos(a) * l, s.y + Math.sin(a) * l);
    }
    ctx.stroke();
    ctx.restore();
    const c = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r);
    c.addColorStop(0, '#ffffff');
    c.addColorStop(0.75, '#f4f9ff');
    c.addColorStop(1, '#bcdcff');
    ctx.fillStyle = c;
    ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2); ctx.fill();
  }

  // ---------- nebulae ----------
  // Pre-rendered wispy clouds (a few colour variants), two layers drifting slowly.
  const NEB = 192;
  const NEB_COLORS = [[255, 110, 190], [90, 220, 210], [170, 120, 255], [255, 170, 90]];
  const nebCache = new Map();
  function nebulaSprite(variant) {
    let c = nebCache.get(variant);
    if (c) return c;
    c = document.createElement('canvas');
    c.width = c.height = NEB;
    const g = c.getContext('2d');
    const img = g.createImageData(NEB, NEB);
    const d = img.data;
    const fbm = makeNoise(variant * 5.3 + 21);
    const col = NEB_COLORS[variant % NEB_COLORS.length], hi = [255, 255, 255];
    const R = NEB / 2;
    for (let py = 0; py < NEB; py++) {
      for (let px = 0; px < NEB; px++) {
        const x = (px + 0.5 - R) / R, y = (py + 0.5 - R) / R;
        const r2 = x * x + y * y;
        if (r2 >= 1) continue;
        const qx = fbm(x * 1.8 + 3, y * 1.8), qy = fbm(x * 1.8, y * 1.8 + 7);
        const n = fbm(x * 2.6 + qx * 2, y * 2.6 + qy * 2);
        const fall = Math.pow(1 - r2, 1.3);
        const a = Math.max(0, n * 1.5 - 0.35) * fall;
        const cc = mix3(col, hi, Math.max(0, n - 0.6) * 1.2);
        const i = (py * NEB + px) * 4;
        d[i] = cc[0]; d[i + 1] = cc[1]; d[i + 2] = cc[2]; d[i + 3] = Math.min(255, a * 200);
      }
    }
    g.putImageData(img, 0, 0);
    nebCache.set(variant, c);
    return c;
  }
  function drawNebulae(ctx, list, t) {
    list.forEach((n, i) => {
      const v = n.variant != null ? n.variant : i;
      ctx.save();
      ctx.translate(n.x, n.y);
      ctx.rotate(t * 0.02 + i);
      ctx.globalAlpha = 0.6;
      ctx.drawImage(nebulaSprite(v), -n.r * 1.08, -n.r * 1.08, n.r * 2.16, n.r * 2.16);
      ctx.rotate(-t * 0.035 + 2.1);
      ctx.globalAlpha = 0.35;
      ctx.drawImage(nebulaSprite(v + 4), -n.r * 0.95, -n.r * 0.95, n.r * 1.9, n.r * 1.9);
      ctx.restore();
    });
  }

  // ---------- comets ----------
  // The tail points away from whichever body lights the comet most, and grows near it.
  function drawComet(ctx, s, sources, t) {
    let lx = 0, ly = 0, best = 0;
    for (const o of sources) {
      if (o === s || o.kind === 'comet') continue;
      const dx = s.x - o.x, dy = s.y - o.y, d2 = dx * dx + dy * dy;
      const w = o.mass / d2;
      if (w > best) { best = w; const d = Math.sqrt(d2); lx = dx / d; ly = dy / d; }
    }
    const sp = Math.hypot(s.vx, s.vy) || 1;
    if (!best) { lx = -s.vx / sp; ly = -s.vy / sp; }
    const heat = Math.min(1, best * 4e-3);              // ~1 within a few hundred units of a big star
    const L = 50 + 190 * heat;
    // dust tail curves back along the path a little
    const dx = lx * 0.7 - s.vx / sp * 0.3, dy = ly * 0.7 - s.vy / sp * 0.3, dl = Math.hypot(dx, dy) || 1;
    const ux = dx / dl, uy = dy / dl, nx = -uy, ny = ux;
    const r = s.radius;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const tipX = s.x + ux * L, tipY = s.y + uy * L;
    const g = ctx.createLinearGradient(s.x, s.y, tipX, tipY);
    g.addColorStop(0, 'rgba(255,240,210,0.5)');
    g.addColorStop(0.4, 'rgba(255,215,170,0.16)');
    g.addColorStop(1, 'rgba(255,200,150,0)');
    ctx.fillStyle = g;
    const wob = 1 + 0.08 * Math.sin(t * 7 + (s.variant || 0));
    ctx.beginPath();
    ctx.moveTo(s.x + nx * r * 1.2, s.y + ny * r * 1.2);
    ctx.quadraticCurveTo(s.x + ux * L * 0.5 + nx * L * 0.16 * wob, s.y + uy * L * 0.5 + ny * L * 0.16 * wob,
      tipX + nx * L * 0.2, tipY + ny * L * 0.2);
    ctx.lineTo(tipX - nx * L * 0.1, tipY - ny * L * 0.1);
    ctx.quadraticCurveTo(s.x + ux * L * 0.5 - nx * L * 0.06, s.y + uy * L * 0.5 - ny * L * 0.06,
      s.x - nx * r * 1.2, s.y - ny * r * 1.2);
    ctx.closePath();
    ctx.fill();
    // straight blue ion tail, exactly away from the light
    const L2 = L * 1.25;
    const g2 = ctx.createLinearGradient(s.x, s.y, s.x + lx * L2, s.y + ly * L2);
    g2.addColorStop(0, 'rgba(140,200,255,0.55)');
    g2.addColorStop(1, 'rgba(140,200,255,0)');
    ctx.strokeStyle = g2;
    ctx.lineWidth = Math.max(1.2, r * 0.45);
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x + lx * L2, s.y + ly * L2); ctx.stroke();
    // coma
    const cg = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r * 3.2);
    cg.addColorStop(0, 'rgba(220,245,255,0.75)');
    cg.addColorStop(0.35, 'rgba(160,220,255,0.22)');
    cg.addColorStop(1, 'rgba(160,220,255,0)');
    ctx.fillStyle = cg;
    ctx.beginPath(); ctx.arc(s.x, s.y, r * 3.2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#f4fbff';
    ctx.beginPath(); ctx.arc(s.x, s.y, r * 0.75, 0, Math.PI * 2); ctx.fill();
  }

  // Little arrows on the view edge for comets that are out of sight but heading in.
  function drawCometPointers(ctx, sources, v, z) {
    const x0 = v.cx - v.half, y0 = v.cy - v.half, x1 = v.cx + v.half, y1 = v.cy + v.half;
    const inset = 16 * z;
    for (const s of sources) {
      if (s.kind !== 'comet') continue;
      if (s.x > x0 && s.x < x1 && s.y > y0 && s.y < y1) continue;
      const toX = v.cx - s.x, toY = v.cy - s.y;
      if (toX * s.vx + toY * s.vy <= 0) continue;        // flying away: no warning
      const dx = s.x - v.cx, dy = s.y - v.cy;
      const k = (v.half - inset) / Math.max(Math.abs(dx), Math.abs(dy));
      const px = v.cx + dx * k, py = v.cy + dy * k;
      const d = Math.hypot(dx, dy), ux = dx / d, uy = dy / d;
      const far = Math.hypot(s.x - px, s.y - py);
      const a = Math.max(0.25, Math.min(0.9, 1 - far / 900));
      const sz = 9 * z;
      ctx.fillStyle = `rgba(170,225,255,${a})`;
      ctx.beginPath();
      ctx.moveTo(px + ux * sz, py + uy * sz);
      ctx.lineTo(px - ux * sz * 0.6 - uy * sz * 0.8, py - uy * sz * 0.6 + ux * sz * 0.8);
      ctx.lineTo(px - ux * sz * 0.6 + uy * sz * 0.8, py - uy * sz * 0.6 - ux * sz * 0.8);
      ctx.closePath(); ctx.fill();
    }
  }

  // ---------- wormholes ----------
  const WORM_HUES = [285, 165, 40, 330];
  function drawWormholes(ctx, list, t, placing) {
    list.forEach((w, i) => {
      const hue = WORM_HUES[i % WORM_HUES.length];
      if (placing) {
        ctx.save();
        ctx.setLineDash([3, 9]);
        ctx.lineDashOffset = -t * 10;
        ctx.strokeStyle = `hsla(${hue},80%,70%,0.22)`;
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(w.ax, w.ay); ctx.lineTo(w.bx, w.by); ctx.stroke();
        ctx.restore();
      }
      drawMouth(ctx, w.ax, w.ay, w.r, hue, t, 1);
      drawMouth(ctx, w.bx, w.by, w.r, hue, t, -1);
    });
  }

  function drawMouth(ctx, x, y, r, hue, t, dir) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r * 1.9);
    g.addColorStop(0, 'rgba(0,0,0,0.95)');
    g.addColorStop(0.45, `hsla(${hue},70%,12%,0.9)`);
    g.addColorStop(0.55, `hsla(${hue},90%,55%,0.55)`);
    g.addColorStop(0.75, `hsla(${hue},90%,50%,0.12)`);
    g.addColorStop(1, `hsla(${hue},90%,50%,0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r * 1.9, 0, Math.PI * 2); ctx.fill();
    // spiral arms swirling inward (the two mouths turn opposite ways)
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(x, y);
    ctx.rotate(t * 1.4 * dir);
    ctx.strokeStyle = `hsla(${hue},95%,72%,0.5)`;
    ctx.lineWidth = Math.max(1, r * 0.09);
    ctx.lineCap = 'round';
    for (let k = 0; k < 4; k++) {
      ctx.beginPath();
      for (let j = 0; j <= 16; j++) {
        const f = j / 16, rr = r * (1.05 - 0.8 * f), a = k * Math.PI / 2 + f * 2.6 * dir;
        const px = Math.cos(a) * rr, py = Math.sin(a) * rr;
        if (j) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      }
      ctx.stroke();
    }
    ctx.restore();
    ctx.strokeStyle = `hsla(${hue},95%,75%,${0.6 + 0.2 * Math.sin(t * 2.5)})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
  }
  Renderer.wormHue = i => WORM_HUES[i % WORM_HUES.length];

  function drawVelocity(ctx, s) {
    const sp = Math.hypot(s.vx, s.vy);
    if (s.fixed || sp < 1) return;
    const len = Math.min(150, 30 + sp * 0.9);
    const ux = s.vx / sp, uy = s.vy / sp;
    const x0 = s.x + ux * (s.radius + 6), y0 = s.y + uy * (s.radius + 6);
    const x1 = x0 + ux * len, y1 = y0 + uy * len;
    ctx.strokeStyle = 'rgba(255,220,170,0.7)';
    ctx.fillStyle = 'rgba(255,220,170,0.7)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x1 + ux * 8, y1 + uy * 8);
    ctx.lineTo(x1 - uy * 6, y1 + ux * 6);
    ctx.lineTo(x1 + uy * 6, y1 - ux * 6);
    ctx.closePath(); ctx.fill();
  }

  function drawGhost(ctx, p, ok, t) {
    const pulse = 0.5 + 0.5 * Math.sin(t * 5);
    ctx.strokeStyle = ok ? `rgba(120,230,255,${0.5 + pulse * 0.4})` : 'rgba(255,80,110,0.8)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(p.x, p.y, NS.PARTICLE_RADIUS + 6 + pulse * 3, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = ok ? 'rgba(120,230,255,0.6)' : 'rgba(255,80,110,0.6)';
    ctx.beginPath(); ctx.arc(p.x, p.y, NS.PARTICLE_RADIUS, 0, Math.PI * 2); ctx.fill();
    if (!ok) {
      ctx.beginPath();
      ctx.moveTo(p.x - 7, p.y - 7); ctx.lineTo(p.x + 7, p.y + 7);
      ctx.moveTo(p.x + 7, p.y - 7); ctx.lineTo(p.x - 7, p.y + 7);
      ctx.stroke();
    }
  }

  function drawParticle(ctx, p, status, z) {
    p = { x: p.x, y: p.y, radius: p.radius * (z || 1) };
    const dead = status === 'crashed' || status === 'escaped' || status === 'timeout';
    const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.radius * 4);
    g.addColorStop(0, dead ? 'rgba(255,90,110,0.7)' : 'rgba(150,240,255,0.8)');
    g.addColorStop(1, 'rgba(120,230,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.radius * 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = dead ? '#ff6b80' : '#e8fdff';
    ctx.beginPath(); ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2); ctx.fill();
  }

  // ---------- effects: sparks, rings, black-hole spirals, screen shake ----------
  // Effects live in world coordinates and age with real time (not simulation time).
  Renderer.prototype.burst = function (x, y, rgb, n, speed) {
    const parts = [];
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = (0.3 + Math.random()) * (speed || 220);
      parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, size: 1 + Math.random() * 2.2 });
    }
    this.fx.push({ type: 'burst', parts, rgb, age: 0, life: 0.9 });
  };
  // Thruster puff: sparks blown out opposite the push (ux, uy).
  Renderer.prototype.exhaust = function (x, y, ux, uy) {
    const parts = [];
    const l = Math.hypot(ux, uy) || 1, bx = -ux / l, by = -uy / l;
    for (let i = 0; i < 22; i++) {
      const a = Math.atan2(by, bx) + (Math.random() - 0.5) * 0.9, s = 80 + Math.random() * 160;
      parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, size: 0.8 + Math.random() * 1.8 });
    }
    this.fx.push({ type: 'burst', parts, rgb: '255,190,110', age: 0, life: 0.55 });
    this.ring(x, y, '255,210,150', 12);
  };
  Renderer.prototype.ring = function (x, y, rgb, r) {
    this.fx.push({ type: 'ring', x, y, rgb, r: r || 30, age: 0, life: 0.5 });
  };
  // Sparks thrown off and then dragged in a swirl into (x, y).
  Renderer.prototype.spiral = function (x, y, from) {
    const parts = [];
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2, r = 20 + Math.random() * 70;
      parts.push({ a, r, w: 3 + Math.random() * 4, size: 1 + Math.random() * 2 });
    }
    this.fx.push({ type: 'spiral', x, y, parts, age: 0, life: 1.1 });
    if (from) this.burst(from.x, from.y, '255,200,140', 14, 120);
  };
  Renderer.prototype.shake = function (amount) {
    if (!this.shakeEnabled) return;
    this.shakeAmp = Math.max(this.shakeAmp || 0, amount);
    this.shakeAge = 0;
  };

  function drawEffects(r, ctx, dt, z) {
    for (let i = r.fx.length - 1; i >= 0; i--) {
      const f = r.fx[i];
      f.age += dt;
      if (f.age >= f.life) { r.fx.splice(i, 1); continue; }
      const k = f.age / f.life;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      if (f.type === 'burst') {
        const drag = Math.exp(-3 * dt);
        ctx.fillStyle = `rgba(${f.rgb},${(1 - k) * 0.9})`;
        ctx.beginPath();
        for (const p of f.parts) {
          p.vx *= drag; p.vy *= drag;
          p.x += p.vx * dt; p.y += p.vy * dt;
          const s = p.size * z * (1 - k * 0.6);
          ctx.moveTo(p.x + s, p.y); ctx.arc(p.x, p.y, s, 0, Math.PI * 2);
        }
        ctx.fill();
      } else if (f.type === 'ring') {
        ctx.strokeStyle = `rgba(${f.rgb},${(1 - k) * 0.8})`;
        ctx.lineWidth = 3 * z * (1 - k) + 0.5;
        ctx.beginPath(); ctx.arc(f.x, f.y, f.r * (0.6 + 1.8 * k), 0, Math.PI * 2); ctx.stroke();
      } else if (f.type === 'spiral') {
        ctx.fillStyle = `rgba(255,190,120,${(1 - k) * 0.9})`;
        ctx.beginPath();
        for (const p of f.parts) {
          p.a += p.w * dt * (1 + 3 * k);
          const rr = p.r * (1 - k) * (1 - k);
          const x = f.x + Math.cos(p.a) * rr, y = f.y + Math.sin(p.a) * rr;
          ctx.moveTo(x + p.size, y); ctx.arc(x, y, p.size * z, 0, Math.PI * 2);
        }
        ctx.fill();
      }
      ctx.restore();
    }
  }

  // ---------- starfield ----------
  // Three layers of faint background stars in screen space. Zooming out pulls the
  // nearer layers in a little more than the far ones, which reads as depth.
  Renderer.prototype.buildStarfield = function () {
    const size = this.canvas.width;
    this.starLayers = [0, 1, 2].map(layer => {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const g = c.getContext('2d');
      const n = Math.round([170, 90, 35][layer] * (size / 1000) * (size / 1000));
      let seed = 1234 + layer * 777;
      const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
      for (let i = 0; i < n; i++) {
        const x = rnd() * size, y = rnd() * size;
        const r = (0.35 + rnd() * [0.5, 0.7, 1.0][layer]) * (size / 1000) * 1.3;
        const a = [0.16, 0.24, 0.34][layer] * (0.5 + rnd() * 0.5);
        const tint = rnd();
        g.fillStyle = tint < 0.15 ? `rgba(255,210,170,${a})` : tint < 0.3 ? `rgba(170,200,255,${a})` : `rgba(235,240,255,${a})`;
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      }
      return c;
    });
    this.starSize = size;
  };

  function drawStarfield(r, ctx, z, t) {
    if (!r.starLayers || r.starSize !== r.canvas.width) r.buildStarfield();
    const W = r.canvas.width;
    r.starLayers.forEach((layer, i) => {
      const s = 1 / (1 + (z - 1) * [0.05, 0.12, 0.22][i]);
      ctx.globalAlpha = 0.85 + 0.15 * Math.sin(t * (0.7 + i * 0.4) + i * 2);
      // tile so shrinking layers still cover the canvas
      const w = W * s, ox = W / 2 - w / 2, oy = W / 2 - w / 2;
      for (let tx = -1; tx <= 1; tx++) {
        for (let ty = -1; ty <= 1; ty++) {
          if (s > 0.999 && (tx || ty)) continue;
          ctx.drawImage(layer, ox + tx * w, oy + ty * w, w, w);
        }
      }
    });
    ctx.globalAlpha = 1;
  }

  // ---------- slingshot aim and best-run ghost ----------
  function drawAim(ctx, aim, t) {
    const sp = Math.hypot(aim.vx, aim.vy);
    // predicted first second of flight
    if (aim.preview && aim.preview.length > 2) {
      ctx.fillStyle = 'rgba(120,230,255,0.9)';
      const n = aim.preview.length / 2;
      for (let i = 0; i < n; i += 2) {
        ctx.globalAlpha = 0.85 * (1 - i / n);
        ctx.beginPath(); ctx.arc(aim.preview[i * 2], aim.preview[i * 2 + 1], 2.2, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    if (sp < 1) return;
    const ux = aim.vx / sp, uy = aim.vy / sp;
    const len = 20 + sp * 0.45;
    const x1 = aim.x + ux * len, y1 = aim.y + uy * len;
    const full = aim.max ? sp / aim.max : 0;
    const col = full > 0.98 ? '255,190,110' : '120,230,255';
    ctx.strokeStyle = `rgba(${col},0.9)`;
    ctx.fillStyle = `rgba(${col},0.9)`;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(aim.x + ux * 9, aim.y + uy * 9); ctx.lineTo(x1, y1); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x1 + ux * 10, y1 + uy * 10);
    ctx.lineTo(x1 - uy * 7, y1 + ux * 7);
    ctx.lineTo(x1 + uy * 7, y1 - ux * 7);
    ctx.closePath(); ctx.fill();
    ctx.font = '13px ui-monospace, Consolas, monospace';
    ctx.fillText(Math.round(sp) + '', x1 + ux * 16 + 4, y1 + uy * 16 + 4);
  }

  // The best run as a dashed line. While a run is on (t = its time), the line dims and a
  // ghost dot flies along it in step with the run, so you can race it.
  function drawGhostPath(ctx, g, z, t) {
    const p = g.path;
    if (!p || p.length < 4) return;
    const racing = t != null;
    ctx.save();
    ctx.strokeStyle = racing ? 'rgba(200,190,255,0.16)' : 'rgba(200,190,255,0.38)';
    ctx.lineWidth = 1.5 * z;
    ctx.setLineDash([6 * z, 6 * z]);
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < p.length; i += 2) {
      const x = p[i], y = p[i + 1];
      if (x !== x) { pen = false; continue; }
      if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
    }
    ctx.stroke();
    ctx.setLineDash([]);
    // start marker, with the launch direction if there was one
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(p[0], p[1], 8, 0, Math.PI * 2); ctx.stroke();
    const sp = Math.hypot(g.vx || 0, g.vy || 0);
    if (sp > 1) {
      const ux = g.vx / sp, uy = g.vy / sp;
      ctx.beginPath(); ctx.moveTo(p[0] + ux * 8, p[1] + uy * 8); ctx.lineTo(p[0] + ux * (14 + sp * 0.2), p[1] + uy * (14 + sp * 0.2)); ctx.stroke();
    }
    const tr = g.track;
    if (racing && tr && tr.length >= 2) {
      const f = t / g.dt, i = Math.floor(f);
      const n = tr.length / 2;
      if (i < n - 1 || (i === n - 1 && f === i)) {
        // between two samples: interpolate (skip if the ghost jumped through a wormhole)
        const a = Math.min(i, n - 1), b = Math.min(i + 1, n - 1), k = f - i;
        let x = tr[a * 2], y = tr[a * 2 + 1];
        const bx = tr[b * 2], by = tr[b * 2 + 1];
        if (Math.hypot(bx - x, by - y) < 60) { x += (bx - x) * k; y += (by - y) * k; }
        const glow = ctx.createRadialGradient(x, y, 0, x, y, 14 * z);
        glow.addColorStop(0, 'rgba(210,200,255,0.45)');
        glow.addColorStop(1, 'rgba(210,200,255,0)');
        ctx.fillStyle = glow;
        ctx.beginPath(); ctx.arc(x, y, 14 * z, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(235,230,255,0.85)';
        ctx.beginPath(); ctx.arc(x, y, 3.2 * z, 0, Math.PI * 2); ctx.fill();
      } else {
        // the ghost's run ended here (crash, escape, or the 40s it covers)
        const x = tr[tr.length - 2], y = tr[tr.length - 1], r = 5 * z;
        ctx.strokeStyle = 'rgba(210,200,255,0.5)';
        ctx.lineWidth = 1.5 * z;
        ctx.beginPath(); ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); ctx.stroke();
      }
    }
    ctx.restore();
  }

  // ---------- icons for the intro cards ----------
  // Draws one object type centred in a small canvas, using the real drawing code.
  Renderer.drawIcon = function (canvas, kind, t) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, W);
    const s = W / 160;                 // icon space is 160 x 160 world units
    ctx.setTransform(s, 0, 0, s, 0, 0);
    if (kind === 'blackhole') {
      drawBlackHole(ctx, { x: 80, y: 80, radius: 18, variant: 1, fixed: false }, t);
    } else if (kind === 'comet') {
      const x = 80 + 30 * Math.sin(t * 0.8), y = 95;
      drawComet(ctx, { x, y, vx: 200, vy: -40, radius: 6, variant: 0 },
        [{ x: 40, y: 260, mass: 3e7, kind: 'star' }], t);
    } else if (kind === 'wormhole') {
      drawMouth(ctx, 45, 80, 20, WORM_HUES[0], t, 1);
      drawMouth(ctx, 118, 80, 20, WORM_HUES[0], t, -1);
      const k = (t * 0.6) % 1;
      ctx.fillStyle = '#e8fdff';
      ctx.beginPath(); ctx.arc(k < 0.5 ? 5 + k * 80 : 78 + (k - 0.5) * 160, 80, 3.5, 0, Math.PI * 2); ctx.fill();
    } else if (kind === 'launch') {
      const k = (t * 0.5) % 1;
      drawAim(ctx, { x: 40, y: 110, vx: 120 * Math.min(1, k * 2), vy: -80 * Math.min(1, k * 2), max: 260 }, t);
      ctx.fillStyle = '#e8fdff';
      ctx.beginPath(); ctx.arc(40, 110, 5, 0, Math.PI * 2); ctx.fill();
    } else if (kind === 'zones') {
      drawZones(ctx, [{ x: 80, y: 80, r: 55 }], t);
    } else if (kind === 'pulsar') {
      drawPulsar(ctx, { x: 80, y: 80, radius: 8, variant: 1, base: 1, mass: 1 + 0.6 * Math.sin(t * Math.PI / 2), pulse: { amp: 0.6 } }, t);
    } else if (kind === 'whitehole') {
      drawWhiteHole(ctx, { x: 80, y: 80, radius: 12, mass: 3e6, variant: 0 }, t);
      // a particle bouncing off its push
      const k = (t * 0.5) % 1, d = 30 + 45 * Math.abs(Math.cos(k * Math.PI));
      ctx.fillStyle = '#e8fdff';
      ctx.beginPath(); ctx.arc(80 - d * 0.7, 80 - d * 0.7, 3.5, 0, Math.PI * 2); ctx.fill();
    } else if (kind === 'nebula') {
      drawNebulae(ctx, [{ x: 80, y: 80, r: 62, variant: 0 }], t);
      const k = (t * 0.25) % 1, x = 10 + 140 * (1 - Math.pow(1 - k, 2));  // slows down crossing it
      ctx.fillStyle = '#e8fdff';
      ctx.beginPath(); ctx.arc(x, 80, 3.5, 0, Math.PI * 2); ctx.fill();
    } else if (kind === 'thrust') {
      const k = (t * 0.4) % 1;
      const x = 30 + 100 * k, y = 110 - (k > 0.5 ? (k - 0.5) * 120 : 0);
      ctx.fillStyle = '#e8fdff';
      ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
      if (k > 0.47 && k < 0.62) {
        const a = 1 - (k - 0.47) / 0.15;
        ctx.fillStyle = `rgba(255,190,110,${a})`;
        ctx.beginPath(); ctx.moveTo(x - 4, y + 4); ctx.lineTo(x - 2 - 14 * a, y + 6 + 18 * a); ctx.lineTo(x + 5, y + 6); ctx.closePath(); ctx.fill();
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(30, 110); ctx.lineTo(80, 110); ctx.lineTo(130, 50); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  };

  NS.Renderer = Renderer;
})(window);
