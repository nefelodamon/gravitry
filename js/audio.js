// Gravitry sound effects, synthesized with the Web Audio API, plus a recorded crash.
// The AudioContext is created on the first user gesture, as browsers require.
(function (root) {
  'use strict';
  const NS = root.Gravitry;
  const PREF_KEY = 'gravitry.muted';

  const BASE_GAIN = 0.55;
  let ac = null, master = null, noiseBuf = null;
  let bus = {};            // per-category gain nodes: sfx, hum, whoosh
  let drone = null;
  let muted = false;
  let previewHumUntil = 0;
  // user-adjustable levels (0..1), applied whenever the audio graph exists
  const levels = { master: 0.8, sfx: 1, hum: 1, whoosh: 1, uiClicks: true };
  const lastPlayed = {};

  // ---------- recorded crash sound ----------
  // The clip is embedded in js/crash-sound.js (base64 WAV), so like the synthesized
  // sounds it needs no separate file and works from file:// too. It's decoded once
  // when audio starts, then played through the Effects channel like everything else.
  const CRASH_LEN = 4;        // seconds played, including the fade
  const CRASH_FADE = 1.5;     // fade-out at the end
  const CRASH_GAIN = 1;
  let crashBuf = null;

  function loadCrash() {
    const b64 = NS.CRASH_WAV;
    if (!b64) return;
    try {
      const bin = atob(b64), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      ac.decodeAudioData(bytes.buffer, b => { crashBuf = b; }, () => {});
    } catch (e) { /* keep the synthesized crash */ }
  }

  // true if the recording was played; false means use the synthesized crash
  function playCrashFile() {
    if (!crashBuf) return false;
    const t = ac.currentTime;
    const src = ac.createBufferSource(), g = ac.createGain();
    src.buffer = crashBuf;
    g.gain.setValueAtTime(CRASH_GAIN, t);
    g.gain.setValueAtTime(CRASH_GAIN, t + CRASH_LEN - CRASH_FADE);
    g.gain.linearRampToValueAtTime(0.0001, t + CRASH_LEN);
    src.connect(g).connect(bus.sfx);
    src.start(t, 0, CRASH_LEN);
    return true;
  }
  try { muted = localStorage.getItem(PREF_KEY) === '1'; } catch (e) { /* ignore */ }

  function unlock() {
    if (!ac) {
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return;
      ac = new AC();
      const comp = ac.createDynamicsCompressor();
      comp.threshold.value = -14; comp.ratio.value = 4;
      master = ac.createGain();
      master.gain.value = muted ? 0 : BASE_GAIN * levels.master;
      master.connect(comp).connect(ac.destination);
      for (const k of ['sfx', 'hum', 'whoosh']) {
        bus[k] = ac.createGain();
        bus[k].gain.value = levels[k];
        bus[k].connect(master);
      }
      // 2s of white noise, reused by every noisy effect
      loadCrash();
      noiseBuf = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ac.state === 'suspended') ac.resume();
  }

  const ready = () => ac && ac.state === 'running' && !muted;

  // ---------- building blocks ----------
  function env(gainNode, t, attack, peak, decay) {
    const g = gainNode.gain;
    g.setValueAtTime(0.0001, t);
    g.exponentialRampToValueAtTime(peak, t + attack);
    g.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  function tone(type, f0, f1, t, dur, peak, attack, out) {
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    env(g, t, attack || 0.005, peak, dur);
    o.connect(g).connect(out || bus.sfx);
    o.start(t); o.stop(t + dur + 0.05);
  }

  function noise(t, dur, peak, filterType, f0, f1, q, attack) {
    const src = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
    src.buffer = noiseBuf;
    src.loop = true;
    f.type = filterType; f.Q.value = q || 1;
    f.frequency.setValueAtTime(f0, t);
    if (f1) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    env(g, t, attack || 0.01, peak, dur);
    src.connect(f).connect(g).connect(bus.sfx);
    src.start(t, Math.random()); src.stop(t + dur + 0.05);
  }

  // ---------- effects ----------
  const FX = {
    place() {
      const t = ac.currentTime;
      tone('sine', 520, 880, t, 0.18, 0.22);
      tone('triangle', 1040, 1300, t + 0.02, 0.12, 0.06);
      noise(t, 0.12, 0.05, 'highpass', 3000, 6000, 0.7);
    },
    invalid() {
      const t = ac.currentTime;
      tone('square', 150, 120, t, 0.12, 0.06);
      tone('square', 150, 110, t + 0.13, 0.12, 0.05);
    },
    pass() {
      const t = ac.currentTime;
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
        tone('triangle', f, f, t + i * 0.09, 0.55, 0.16);
        tone('sine', f * 2, f * 2, t + i * 0.09, 0.3, 0.04);
      });
    },
    crash() {
      if (playCrashFile()) return;
      // Synthesized fallback if the recording can't be loaded. A smash, not a drum: bright crack, metallic crash shimmer, flying shards, burn-up sizzle.
      const t = ac.currentTime;
      // 1) impact crack: very short, bright
      noise(t, 0.06, 0.55, 'highpass', 1800, 900, 0.7, 0.001);
      // 2) short mid-range body so it has weight (no pitched thump)
      noise(t, 0.22, 0.28, 'bandpass', 700, 350, 0.9, 0.002);
      // 3) crash shimmer: inharmonic square-wave cluster, high-passed, long decay
      const hp = ac.createBiquadFilter(), bp = ac.createBiquadFilter(), g = ac.createGain();
      hp.type = 'highpass'; hp.frequency.value = 5200;
      bp.type = 'peaking'; bp.frequency.value = 8500; bp.gain.value = 6;
      env(g, t, 0.002, 0.2, 1.4);
      hp.connect(bp).connect(g).connect(bus.sfx);
      [263, 400, 421, 474, 587, 845].forEach(f => {
        const o = ac.createOscillator();
        o.type = 'square';
        o.frequency.value = f * (2.1 + Math.random() * 0.15);
        o.connect(hp);
        o.start(t); o.stop(t + 1.5);
      });
      noise(t, 1.3, 0.22, 'highpass', 6000, 3500, 0.5, 0.002);
      // 4) debris: scattered glassy pings
      const shards = 7 + Math.floor(Math.random() * 4);
      for (let i = 0; i < shards; i++) {
        const dt = 0.02 + Math.random() * 0.32;
        const f = 2200 + Math.random() * 4200;
        tone(Math.random() < 0.5 ? 'triangle' : 'sine', f, f * (0.92 + Math.random() * 0.06), t + dt,
          0.08 + Math.random() * 0.12, 0.03 + Math.random() * 0.05, 0.001);
      }
      // 5) burn-up sizzle fading and darkening
      noise(t + 0.05, 1.6, 0.12, 'bandpass', 5000, 700, 1.2, 0.08);
      // 6) soft low rumble underneath: swells in (not a drum hit) and rolls off slowly
      noise(t, 1.3, 0.35, 'lowpass', 160, 70, 0.7, 0.03);
      tone('sine', 56, 47, t, 1.2, 0.14, 0.04);
    },
    // Settled into a repeating orbit: a calm, sustained interval.
    orbit() {
      const t = ac.currentTime;
      tone('sine', 392, 392, t, 1.2, 0.12, 0.04);
      tone('sine', 587.33, 587.33, t + 0.12, 1.1, 0.1, 0.04);
      tone('triangle', 783.99, 783.99, t + 0.24, 0.9, 0.05, 0.04);
    },
    // Slingshot release: a quick rising twang.
    launch() {
      const t = ac.currentTime;
      tone('triangle', 220, 660, t, 0.18, 0.16, 0.004);
      tone('sine', 440, 1320, t + 0.01, 0.14, 0.06, 0.004);
      noise(t, 0.12, 0.06, 'bandpass', 1500, 4000, 2, 0.003);
    },
    // Thruster nudge: a short gassy puff with a low thump.
    thrust() {
      const t = ac.currentTime;
      noise(t, 0.22, 0.22, 'bandpass', 1400, 350, 1.1, 0.004);
      tone('sine', 150, 80, t, 0.16, 0.12, 0.004);
    },
    // Slow-mo near miss: a deep whoom that sinks and swells back.
    slowmo() {
      const t = ac.currentTime;
      tone('sine', 200, 60, t, 0.9, 0.16, 0.06);
      tone('triangle', 400, 120, t, 0.7, 0.04, 0.06);
      noise(t, 1.0, 0.07, 'lowpass', 1600, 180, 0.7, 0.15);
    },
    // Through a wormhole: a quick phasey zip down and back up.
    warp() {
      const t = ac.currentTime;
      tone('sine', 1400, 180, t, 0.16, 0.12, 0.004);
      tone('sine', 180, 1100, t + 0.15, 0.22, 0.1, 0.01);
      noise(t, 0.35, 0.08, 'bandpass', 4000, 500, 4, 0.01);
    },
    escape() {
      const t = ac.currentTime;
      tone('sine', 700, 90, t, 1.3, 0.16, 0.02);
      noise(t, 1.2, 0.12, 'bandpass', 1800, 200, 3, 0.05);
    },
    timeout() {
      const t = ac.currentTime;
      tone('triangle', 392, 392, t, 0.3, 0.14);
      tone('triangle', 311, 300, t + 0.28, 0.6, 0.14);
    },
    // Close fly-by past a star; intensity 0..1 scales loudness and brightness.
    swoosh(k) {
      const t = ac.currentTime;
      const dur = 0.35 + 0.25 * k;
      const src = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
      src.buffer = noiseBuf; src.loop = true;
      f.type = 'bandpass'; f.Q.value = 2.5;
      f.frequency.setValueAtTime(300, t);
      f.frequency.exponentialRampToValueAtTime(900 + 2200 * k, t + dur * 0.45);
      f.frequency.exponentialRampToValueAtTime(250, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.05 + 0.3 * k, t + dur * 0.45);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(f).connect(g).connect(bus.whoosh);
      src.start(t, Math.random()); src.stop(t + dur + 0.05);
    },
    leave() { const t = ac.currentTime; tone('sine', 330, 196, t, 0.45, 0.1, 0.02); },
    enter() { const t = ac.currentTime; tone('sine', 196, 330, t, 0.35, 0.1, 0.02); },
    pop() { const t = ac.currentTime; tone('sine', 300, 620, t, 0.1, 0.18); },
    unpop() { const t = ac.currentTime; tone('sine', 500, 160, t, 0.14, 0.16); },
    click() { const t = ac.currentTime; tone('sine', 1300, 900, t, 0.04, 0.05, 0.002); },
  };

  // Minimum spacing between repeats of the same effect (seconds).
  const THROTTLE = { warp: 0.1, swoosh: 0.18, invalid: 0.15, click: 0.04, pop: 0.05, leave: 0.3, enter: 0.3 };

  function play(name, arg) {
    if (!ready() || !FX[name]) return;
    if (name === 'click' && !levels.uiClicks) return;
    const now = ac.currentTime;
    if (THROTTLE[name] && now - (lastPlayed[name] || -1) < THROTTLE[name]) return;
    lastPlayed[name] = now;
    FX[name](arg);
  }

  // ---------- engine hum that follows the particle's speed ----------
  function ensureDrone() {
    if (drone) return drone;
    const o1 = ac.createOscillator(), o2 = ac.createOscillator();
    const f = ac.createBiquadFilter(), g = ac.createGain();
    o1.type = 'sawtooth'; o2.type = 'sawtooth';
    o1.frequency.value = 55; o2.frequency.value = 55.6;
    f.type = 'lowpass'; f.Q.value = 6; f.frequency.value = 200;
    g.gain.value = 0;
    o1.connect(f); o2.connect(f); f.connect(g).connect(bus.hum);
    o1.start(); o2.start();
    drone = { o1, o2, f, g };
    return drone;
  }

  // speed in world units / s; active = particle in flight
  function updateDrone(active, speed) {
    if (!ac || ac.state !== 'running') return;
    const d = ensureDrone();
    const t = ac.currentTime;
    if (t < previewHumUntil) { active = true; speed = 320; }   // settings-slider preview
    const k = Math.min(1, (speed || 0) / 450);
    d.g.gain.setTargetAtTime(active ? 0.018 + 0.05 * k : 0, t, active ? 0.08 : 0.25);
    d.f.frequency.setTargetAtTime(160 + 1500 * k * k, t, 0.06);
    d.o1.frequency.setTargetAtTime(48 + 40 * k, t, 0.1);
    d.o2.frequency.setTargetAtTime(48.6 + 41 * k, t, 0.1);
  }

  function setMuted(m) {
    muted = m;
    try { localStorage.setItem(PREF_KEY, m ? '1' : '0'); } catch (e) { /* ignore */ }
    applyLevels();
  }

  function applyLevels() {
    if (!ac) return;
    const t = ac.currentTime;
    master.gain.setTargetAtTime(muted ? 0 : BASE_GAIN * levels.master, t, 0.03);
    for (const k of ['sfx', 'hum', 'whoosh']) bus[k].gain.setTargetAtTime(levels[k], t, 0.03);
  }

  // opts: any of { master, sfx, hum, whoosh } in 0..1, uiClicks boolean
  function configure(opts) {
    Object.assign(levels, opts);
    applyLevels();
  }

  // Let the player hear a category while dragging its slider.
  function preview(kind) {
    if (!ready()) return;
    if (kind === 'hum') previewHumUntil = ac.currentTime + 0.9;
    else if (kind === 'whoosh') play('swoosh', 0.75);
    else if (kind === 'click') FX.click();
    else play('place');
  }

  NS.Sound = { unlock, play, updateDrone, setMuted, isMuted: () => muted, configure, preview };
})(window);
