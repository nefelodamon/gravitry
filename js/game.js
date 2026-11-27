// Gravitry game: state machine, input, fixed-step main loop, progress saving.
(function () {
  'use strict';
  const NS = window.Gravitry;
  const LEVELS = NS.LEVELS;
  const SAVE_KEY = 'gravitry.progress.v1';
  const MY_LEVELS_KEY = 'gravitry.saved.v1';
  const MAX_STEPS_PER_FRAME = 120; // per 1x of speed; caps catch-up after lag
  const RANDOM = -1;               // levelIndex for a freshly generated layout
  const SAVED = -2;                // levelIndex for one of the player's saved levels
  const TEST = -3;                 // levelIndex while test-playing the editor's draft
  const SHARED = -4;               // levelIndex for a level opened from a shared link
  const MAX_SEED = 999999999;
  const STATS_KEY = 'gravitry.stats.v1';
  const SEEN_KEY = 'gravitry.seen.v1';
  const LAUNCH_PULL = 1.6;         // launch speed per world unit dragged
  const GHOST_SECONDS = 40;        // how much of the best run the ghost shows
  const VERSION = '1.5.0';         // bump on every change
  const RESULT_DELAY = 1000;       // ms between a run ending and the result card
  const SETTINGS_KEY = 'gravitry.settings.v1';
  const DIFFICULTY = {
    easy: { mult: 0.7, label: 'Easy' },
    normal: { mult: 1, label: 'Normal' },
    hard: { mult: 1.35, label: 'Hard' },
  };
  const DIFF_RANK = { easy: 1, normal: 2, hard: 3 };
  const TIMER = {
    normal: { mult: 1, label: 'Normal' },
    double: { mult: 2, label: '2× time' },
    off: { mult: Infinity, label: 'No timer' },
  };
  const DEFAULT_SETTINGS = {
    master: 0.8, sfx: 1, hum: 1, whoosh: 1, uiClicks: true,
    difficulty: 'normal', timer: 'normal',
    shake: !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches),
    ghost: true,
    slowmo: true,
    random: NS.RANDOM_ALL,   // what random layouts may contain (bit mask, see random.js)
  };

  const $ = id => document.getElementById(id);
  const canvas = $('arena');
  const renderer = new NS.Renderer(canvas);
  const Sound = NS.Sound;

  const ui = {
    levelName: $('level-name'), bar: document.querySelector('#hud-play .bar'), hint: $('hint'), dist: $('dist'), barFill: $('bar-fill'),
    attempts: $('attempts'), clock: $('clock'), speed: $('speed'), best: $('best'),
    vel: $('vel'), thrust: $('thrust'), thrustStat: $('thrust-stat'), overlay: $('overlay'), oTitle: $('overlay-title'), oMsg: $('overlay-msg'),
    btnRetry: $('btn-retry'), btnNext: $('btn-next'), btnLevels: $('btn-levels'),
    menu: $('menu'), grid: $('level-grid'), btnMenu: $('btn-menu'), paused: $('paused'),
    btnField: $('btn-field'), btnMute: $('btn-mute'),
    btnOptions: $('btn-options'), btnMenuOptions: $('btn-menu-options'), options: $('options'),
    optDone: $('opt-done'), optNote: $('opt-note'), modeChip: $('mode-chip'), toast: $('toast'), btnSave: $('btn-save'),
    hudPlay: $('hud-play'), btnCreate: $('btn-create'),
    myGrid: $('my-levels'), myEmpty: $('my-empty'), seedForm: $('seed-form'), seedInput: $('seed-input'),
    btnShare: $('btn-share'), btnReplay: $('btn-replay'), shareLink: $('share-link'),
    intro: $('intro'), introIcon: $('intro-icon'), introTitle: $('intro-title'), introMsg: $('intro-msg'), introOk: $('intro-ok'),
    stats: $('stats'), statsList: $('stats-list'), statsReset: $('stats-reset'),
  };

  let progress = loadProgress();
  let myLevels = loadMyLevels();
  let levelIndex = 0;      // index into LEVELS, or RANDOM / SAVED
  let randomLevel = null;  // current generated level definition
  let randomBest = 0;      // best distance on the current generated layout
  let savedEntry = null;   // current saved level (when levelIndex === SAVED)
  let testDef = null;      // editor draft being test-played (when levelIndex === TEST)
  let testBest = 0;
  let sharedDef = null;    // level opened from a shared link (when levelIndex === SHARED)
  let sharedRun = null;    // the shared run {x, y, vx, vy}
  let sharedBest = 0;
  let autoReplay = null;   // run to play back automatically once the level is ready
  let randomBestRun = null, testBestRun = null;
  let ghostPath = null;    // re-simulated best run for this level: { path, vx, vy, len }
  let aim = null;          // slingshot aim in progress: { x, y, vx, vy, max, sx, sy, preview }
  let world = null;
  let state = 'menu'; // menu | generating | editing | placing | aiming | running | over
  let attempts = 0;
  let marks = []; // previous drop spots this level: {x, y, frac, won}
  let passAnnounced = false; // "Level passed" shown for the current run
  let paused = false;
  let menuReturn = null;   // the level the menu was opened over, to go back to on click-outside / Esc
  let speed = 1;
  const SPEEDS = [1, 2, 4, 8, 16, 32];
  // dir +1 = faster (wraps 32× → 1×), -1 = slower (wraps 1× → 32×)
  function cycleSpeed(dir) {
    const i = SPEEDS.indexOf(speed);
    speed = SPEEDS[(i + dir + SPEEDS.length) % SPEEDS.length];
    updateHud();
  }
  let showField = loadPref('gravitry.showField') === '1';
  let ghost = null;
  let acc = 0;
  let lastT = performance.now();
  let clockT = 0;
  let flyby = { prev: Infinity, prev2: Infinity }; // nearest-star distance history for fly-by whooshes
  let wasOutside = false;
  let lastRun = null;      // { run, path } of the run that just ended (for sharing)
  let overlayTimer = 0;    // pending result card

  // ---------- storage ----------
  function loadProgress() {
    try {
      const p = JSON.parse(localStorage.getItem(SAVE_KEY));
      if (p && typeof p.unlocked === 'number') {
        const cleared = p.cleared || {};
        // older saves: a best at/over the normal target counts as a Normal clear
        if (!p.cleared && p.best) LEVELS.forEach((L, i) => { if (p.best[i] >= L.target) cleared[i] = 'normal'; });
        // a level cleared when it was the last one now unlocks the one after it (new levels added)
        let unlocked = p.unlocked;
        while (unlocked + 1 < LEVELS.length && cleared[unlocked]) unlocked++;
        return { unlocked, best: p.best || {}, cleared };
      }
    } catch (e) { /* storage unavailable */ }
    return { unlocked: 0, best: {}, cleared: {} };
  }
  function saveProgress() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(progress)); } catch (e) { /* ignore */ }
  }

  // Saved levels keep the full layout (not just the seed), so they survive generator changes.
  function loadMyLevels() {
    try {
      const list = JSON.parse(localStorage.getItem(MY_LEVELS_KEY));
      if (Array.isArray(list)) return list.filter(e => e && e.def && Array.isArray(e.def.sources));
    } catch (e) { /* storage unavailable */ }
    return [];
  }
  function saveMyLevels() {
    try { localStorage.setItem(MY_LEVELS_KEY, JSON.stringify(myLevels)); return true; } catch (e) { return false; }
  }

  // ---------- settings ----------
  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY));
      if (s && typeof s === 'object') {
        const out = Object.assign({}, DEFAULT_SETTINGS, s);
        if (!DIFFICULTY[out.difficulty]) out.difficulty = 'normal';
        if (!TIMER[out.timer]) out.timer = 'normal';
        return out;
      }
    } catch (e) { /* storage unavailable */ }
    return Object.assign({}, DEFAULT_SETTINGS);
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
  }
  let settings = loadSettings();
  NS.Sound.configure(settings);
  renderer.shakeEnabled = settings.shake;

  // ---------- stats ----------
  const STATS_DEFAULT = {
    drops: 0, launches: 0, distance: 0, flightTime: 0, longest: 0, longestWhere: '',
    crashStar: 0, crashHole: 0, crashComet: 0, escapes: 0, timeouts: 0, orbits: 0,
    passes: 0, warps: 0, randomPlayed: 0, created: 0, nudges: 0, nearMisses: 0, since: Date.now(),
  };
  function loadStats() {
    try {
      const s = JSON.parse(localStorage.getItem(STATS_KEY));
      if (s && typeof s === 'object') return Object.assign({}, STATS_DEFAULT, s);
    } catch (e) { /* storage unavailable */ }
    return Object.assign({}, STATS_DEFAULT);
  }
  let stats = loadStats();
  function saveStats() {
    try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); } catch (e) { /* ignore */ }
  }

  // ---------- intro cards (seen once per object type) ----------
  function loadSeen() {
    try { const s = JSON.parse(localStorage.getItem(SEEN_KEY)); if (s && typeof s === 'object') return s; } catch (e) { /* ignore */ }
    return {};
  }
  let seen = loadSeen();

  const scaledTarget = t => Math.max(50, Math.round(t * DIFFICULTY[settings.difficulty].mult / 50) * 50);

  // The level as actually played: difficulty scales the target, the timer option scales the clock.
  // Editor test runs use the level exactly as designed.
  function effectiveDef(def) {
    if (isTest() || isShared()) return def;
    const base = def.timeLimit || NS.DEFAULT_TIME_LIMIT;
    return Object.assign({}, def, {
      target: scaledTarget(def.target),
      timeLimit: base * TIMER[settings.timer].mult,
    });
  }

  function loadPref(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  const fieldButtons = [ui.btnField, $('ed-field-btn')];
  function toggleField() {
    showField = !showField;
    fieldButtons.forEach(b => b.setAttribute('aria-pressed', String(showField)));
    try { localStorage.setItem('gravitry.showField', showField ? '1' : '0'); } catch (e) { /* ignore */ }
  }
  fieldButtons.forEach(b => {
    b.setAttribute('aria-pressed', String(showField));
    b.addEventListener('click', e => { toggleField(); e.currentTarget.blur(); });
  });

  // ---------- sound ----------
  function syncMute() {
    const m = Sound.isMuted();
    ui.btnMute.textContent = m ? '🔇' : '🔊';
    ui.btnMute.title = (m ? 'Unmute' : 'Mute') + ' sound (M)';
    ui.btnMute.setAttribute('aria-pressed', String(!m));
  }
  function toggleMute() { Sound.setMuted(!Sound.isMuted()); syncMute(); }
  syncMute();
  ui.btnMute.addEventListener('click', e => { toggleMute(); e.currentTarget.blur(); });
  // Browsers only allow audio after a user gesture.
  ['pointerdown', 'keydown'].forEach(t => window.addEventListener(t, () => Sound.unlock(), true));
  document.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (b && !b.disabled && b !== ui.btnMute) Sound.play('click');
  });

  // Whoosh when the particle whips past a star: detect the closest-approach moment.
  function checkFlyby() {
    const p = world.particle;
    let d = Infinity;
    for (const s of world.sources) d = Math.min(d, Math.hypot(p.x - s.x, p.y - s.y) - s.radius);
    const f = flyby;
    if (f.prev < f.prev2 && f.prev <= d && f.prev < 130) {
      const speed = Math.hypot(p.vx, p.vy);
      const k = Math.min(1, speed / 480) * (1 - f.prev / 130);
      if (k > 0.06) Sound.play('swoosh', Math.min(1, k * 1.3));
    }
    f.prev2 = f.prev; f.prev = d;
  }

  // ---------- flow ----------
  const isRandom = () => levelIndex === RANDOM;
  const isSaved = () => levelIndex === SAVED;
  const isTest = () => levelIndex === TEST;
  const isShared = () => levelIndex === SHARED;
  const isCampaign = () => levelIndex >= 0;
  const currentDef = () => (isRandom() ? randomLevel : isSaved() ? savedEntry.def : isTest() ? testDef
    : isShared() ? sharedDef : LEVELS[levelIndex]);

  // ---------- best runs & ghost ----------
  function bestRun() {
    if (isShared()) return sharedRun;
    if (isTest()) return testBestRun;
    if (isRandom()) return randomBestRun;
    if (isSaved()) return savedEntry.bestRun || null;
    return (progress.bestRun || {})[levelIndex] || null;
  }

  // Physics is deterministic, so a run can be rebuilt from its start point and launch velocity.
  function simulateRun(def, run, seconds) {
    const w = new NS.World(Object.assign({}, def, { target: Infinity }));
    if (!w.place(run.x, run.y, run.vx || 0, run.vy || 0)) return null;
    if (run.nudges) w.scheduleNudges(run.nudges);
    const path = [run.x, run.y];       // drawn line (NaN breaks at wormhole jumps)
    const track = [run.x, run.y];      // the ghost's position every 4 steps, for the moving dot
    const steps = Math.round(seconds / NS.DT);
    for (let i = 1; i <= steps && w.status === 'running'; i++) {
      w.step();
      if (w.warped) path.push(NaN, NaN);
      if (i % 4 === 0 || w.warped) path.push(w.particle.x, w.particle.y);
      if (i % 4 === 0) track.push(w.particle.x, w.particle.y);
    }
    return { path, track, dt: 4 * NS.DT, vx: run.vx || 0, vy: run.vy || 0, len: w.path, status: w.status };
  }

  function buildGhost() {
    const run = bestRun();
    ghostPath = run ? simulateRun(effectiveDef(currentDef()), run, GHOST_SECONDS) : null;
  }
  const maskOf = e => (e.def && e.def.mask != null ? e.def.mask : NS.RANDOM_LEGACY);
  const savedForSeed = (seed, mask) => myLevels.find(e => e.seed === seed && !e.custom && maskOf(e) === mask);

  function startLevel(i, keepAttempts) {
    levelIndex = i;
    if (!keepAttempts) { attempts = 0; marks = []; }
    const def = currentDef();
    world = new NS.World(effectiveDef(def));
    passAnnounced = false;
    flyby = { prev: Infinity, prev2: Infinity };
    wasOutside = false;
    ui.toast.classList.remove('show');
    state = 'placing';
    aim = null;
    renderer.resetView();
    resetSlowmo();
    paused = false;
    acc = 0;
    ui.menu.hidden = true;
    ui.overlay.hidden = true;
    ui.paused.hidden = true;
    buildGhost();
    if (isShared()) {
      ui.levelName.textContent = 'Shared: ' + def.name;
      const len = ghostPath ? Math.round(ghostPath.len) : 0;
      ui.hint.textContent = `A friend's run (${len} in the first ${GHOST_SECONDS}s, shown dashed). ` +
        (def.launch ? 'Drag to launch' : 'Click to drop') + ' and try to beat it.';
    } else if (isTest()) {
      ui.levelName.textContent = 'Testing: ' + def.name;
      ui.hint.textContent = 'Test run of your level. Press E or Esc to go back to the editor.';
    } else if (isSaved()) {
      ui.levelName.textContent = '★ ' + savedEntry.name;
      ui.hint.textContent = def.hint.replace(/ Press N for a new layout\.$/, '') +
        (savedEntry.custom ? ' Press E to edit.' : ` Seed ${savedEntry.seed}. Press E to edit.`);
    } else if (isRandom()) {
      ui.levelName.textContent = def.name;
      ui.hint.textContent = def.hint;
    } else {
      ui.levelName.textContent = `${i + 1}. ${def.name}`;
      ui.hint.textContent = def.hint + (ghostPath && settings.ghost ? ' Dashed line: your best run (H hides it).' : '');
    }
    ui.levelName.title = ui.levelName.textContent;
    ui.btnNext.innerHTML = isRandom() ? 'New layout <kbd>N</kbd>' : isTest() ? 'Back to editor <kbd>E</kbd>' : 'Next <kbd>N</kbd>';
    if (!keepAttempts && isTest()) { testBest = 0; }
    updateSaveButton();
    updateModeChip();
    updateHud();
    showIntros(def);
    if (autoReplay) startAutoReplay();
  }

  // Play a run by itself (used to show a shared run when its link is opened).
  function startAutoReplay() {
    if (!ui.intro.hidden || state !== 'placing') return;   // wait for the intro cards
    const run = autoReplay;
    autoReplay = null;
    launchAt(run.x, run.y, run.vx || 0, run.vy || 0, true, run.nudges);
  }

  function retry() { if (world) startLevel(levelIndex, true); }

  // Watch the run that just ended again, exactly as it flew (same start, same nudges).
  // It plays as a replay, so it isn't counted as an attempt or in stats and bests.
  function replayLast() {
    if (state !== 'over' || !lastRun || ui.btnReplay.hidden) return;
    const keep = lastRun, run = keep.run;
    startLevel(levelIndex, true);
    if (state !== 'placing') return;
    if (!launchAt(run.x, run.y, run.vx || 0, run.vy || 0, true, run.nudges)) return;
    world.ownReplay = true;
    lastRun = keep;
  }

  // Generate a layout. Generation simulates sample drops (~0.5-2s),
  // so show a badge and yield a frame before the heavy work.
  function startRandom(seed, mask) {
    state = 'generating';
    ui.menu.hidden = true;
    ui.overlay.hidden = true;
    ui.paused.textContent = 'Generating…';
    ui.paused.hidden = false;
    setTimeout(() => {
      randomLevel = NS.generateLevel(seed || NS.randomSeed(), mask != null ? mask : settings.random);
      randomBest = 0;
      randomBestRun = null;
      stats.randomPlayed++;
      saveStats();
      ui.paused.textContent = 'Paused';
      startLevel(RANDOM);
    }, 30);
  }

  function startSaved(entry) {
    savedEntry = entry;
    startLevel(SAVED);
  }

  function nextLevel() {
    if (isRandom()) { startRandom(); return; }
    if (isTest()) { backToEditor(); return; }
    if (isSaved() || isShared()) return;
    if (levelIndex + 1 < LEVELS.length && levelIndex + 1 <= progress.unlocked) startLevel(levelIndex + 1);
  }

  // ---------- my levels ----------
  function updateSaveButton() {
    const show = isRandom() || isSaved();  // never during TEST
    ui.btnSave.hidden = !show;
    if (!show) return;
    const saved = isSaved() || !!savedForSeed(randomLevel.seed, randomLevel.mask);
    ui.btnSave.textContent = saved ? '★ Saved' : '☆ Save';
    ui.btnSave.disabled = saved;
    ui.btnSave.title = saved ? 'In My levels' : 'Save this layout to My levels';
  }

  function saveCurrent() {
    if (!isRandom() || savedForSeed(randomLevel.seed, randomLevel.mask)) return;
    const def = JSON.parse(JSON.stringify(randomLevel)); // detach from the live object
    const entry = {
      id: 'L' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
      name: `Layout #${randomLevel.seed}`,
      seed: randomLevel.seed,
      def,
      best: Math.round(randomBest),
      passed: !!(world && world.passed) || randomBest >= randomLevel.target,
      savedAt: Date.now(),
    };
    myLevels.unshift(entry);
    if (!saveMyLevels()) { myLevels.shift(); flash('Could not save (browser storage unavailable)'); return; }
    updateSaveButton();
    flash('Saved to My levels');
  }

  // Update the saved entry for the layout being played (a saved level, or a random
  // layout that was saved mid-session).
  function recordSavedResult(path, passed) {
    const entry = isSaved() ? savedEntry : isRandom() && randomLevel ? savedForSeed(randomLevel.seed, randomLevel.mask) : null;
    if (!entry) return;
    if (path > (entry.best || 0)) entry.best = Math.round(path);
    if (betterRun(entry.bestRun, path)) entry.bestRun = Object.assign({ len: path }, runOf(world));
    if (passed) entry.passed = true;
    saveMyLevels();
  }

  function flash(text) {
    ui.toast.textContent = text;
    ui.toast.classList.remove('show');
    void ui.toast.offsetWidth; // restart the CSS animation
    ui.toast.classList.add('show');
  }

  function renderMyLevels() {
    ui.myGrid.innerHTML = '';
    ui.myEmpty.hidden = myLevels.length > 0;
    for (const entry of myLevels) {
      const card = document.createElement('div');
      card.className = 'my-card' + (entry.passed ? ' done' : '');

      const play = document.createElement('button');
      play.className = 'my-play';
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = entry.name;
      const st = document.createElement('span'); st.className = 'st';
      st.textContent = (entry.custom ? 'custom · ' : `#${entry.seed} · `) + (entry.passed ? `✓ ${entry.best}` : entry.best ? `best ${entry.best} / ${entry.def.target}` : `target ${entry.def.target}`);
      play.append(nm, st);
      play.addEventListener('click', () => startSaved(entry));

      const rename = document.createElement('button');
      rename.className = 'my-icon'; rename.textContent = '✎'; rename.title = 'Edit / rename';
      rename.addEventListener('click', () => openEditor(entry.def, entry));

      // Two-step delete so a stray click can't lose a level.
      const del = document.createElement('button');
      del.className = 'my-icon del'; del.textContent = '✕'; del.title = 'Delete';
      del.addEventListener('click', () => {
        if (!del.classList.contains('confirm')) {
          del.classList.add('confirm'); del.textContent = 'Delete?';
          setTimeout(() => { del.classList.remove('confirm'); del.textContent = '✕'; }, 3000);
          return;
        }
        myLevels = myLevels.filter(e => e !== entry);
        saveMyLevels();
        renderMyLevels();
      });

      card.append(play, rename, del);
      ui.myGrid.appendChild(card);
    }
  }

  ui.seedForm.addEventListener('submit', e => {
    e.preventDefault();
    const seed = parseInt(ui.seedInput.value, 10);
    if (!Number.isFinite(seed) || seed < 1 || seed > MAX_SEED) {
      ui.seedInput.setCustomValidity(`Enter a whole number from 1 to ${MAX_SEED}`);
      ui.seedInput.reportValidity();
      return;
    }
    ui.seedInput.setCustomValidity('');
    const saved = savedForSeed(seed);
    if (saved) startSaved(saved); else startRandom(seed);
  });
  ui.seedInput.addEventListener('input', () => ui.seedInput.setCustomValidity(''));

  // ---------- editor ----------
  const editor = new NS.Editor({
    flash,
    onTest(def) {
      testDef = def;
      editor.close();
      ui.hudPlay.hidden = false;
      startLevel(TEST);
    },
    onSave(def, entry) {
      if (entry) {
        const changed = JSON.stringify(entry.def) !== JSON.stringify(def);
        entry.name = def.name;
        if (changed) Object.assign(entry, { def, best: 0, bestRun: null, passed: false, custom: true, seed: null });
        if (myLevels.indexOf(entry) === -1) myLevels.unshift(entry);
      } else {
        entry = {
          id: 'L' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
          name: def.name, seed: null, custom: true, def, best: 0, passed: false, savedAt: Date.now(),
        };
        myLevels.unshift(entry);
        stats.created++;
        saveStats();
      }
      if (!saveMyLevels()) { flash('Could not save (browser storage unavailable)'); return null; }
      flash('Saved to My levels');
      return entry;
    },
    onExit() {
      ui.hudPlay.hidden = false;
      showMenu();
    },
  });

  // Open the editor on a layout (null = blank). entry = saved level to update on save.
  function openEditor(def, entry, name) {
    state = 'editing';
    renderer.resetView();
    hideIntro();
    aim = null;
    ui.menu.hidden = true;
    ui.overlay.hidden = true;
    ui.paused.hidden = true;
    ui.toast.classList.remove('show');
    ui.hudPlay.hidden = true;
    editor.open(def, entry, name);
  }

  function backToEditor() {
    state = 'editing';
    renderer.resetView();
    ui.overlay.hidden = true;
    ui.paused.hidden = true;
    ui.toast.classList.remove('show');
    ui.hudPlay.hidden = true;
    editor.resume();
  }

  // E while playing: edit the current level (custom saved ones in place, others as a remix copy).
  function editCurrent() {
    if (isTest()) backToEditor();
    else if (isSaved() && savedEntry.custom) openEditor(savedEntry.def, savedEntry);
    else if (isSaved()) openEditor(savedEntry.def, null, 'Remix of ' + savedEntry.name);
    else openEditor(currentDef(), null, 'Remix of ' + currentDef().name);
  }

  ui.btnCreate.addEventListener('click', () => openEditor(null, null, `My level ${myLevels.length + 1}`));

  // ---------- options panel ----------
  let optionsPausedRun = false;

  function updateModeChip() {
    const parts = [];
    if (settings.difficulty !== 'normal') parts.push(DIFFICULTY[settings.difficulty].label);
    if (settings.timer !== 'normal') parts.push(TIMER[settings.timer].label);
    ui.modeChip.textContent = parts.join(' · ');
    ui.modeChip.hidden = !parts.length || isTest();
  }

  function syncOptions() {
    for (const k of ['master', 'sfx', 'hum', 'whoosh']) {
      $('opt-' + k).value = Math.round(settings[k] * 100);
      $('opt-' + k + '-val').textContent = Math.round(settings[k] * 100) + '%';
    }
    $('opt-clicks').checked = settings.uiClicks;
    document.querySelectorAll('#options [data-opt]').forEach(b => {
      b.setAttribute('aria-pressed', String(settings[b.dataset.opt] === b.dataset.val));
    });
    const d = DIFFICULTY[settings.difficulty].mult, tm = TIMER[settings.timer].mult;
    $('opt-diff-desc').textContent = d === 1 ? 'Targets as designed.' : `Every target × ${d} (e.g. 1000 → ${scaledTarget(1000)}).`;
    $('opt-timer-desc').textContent = tm === 1 ? 'Time limits as designed.' : isFinite(tm) ? 'Twice as long on every clock.' : 'No time limit — runs end only on a crash or escape.';
  }

  function openOptions() {
    if (state === 'editing' || state === 'generating') return;
    if (state === 'running' && !paused) { paused = true; optionsPausedRun = true; }
    syncOptions();
    ui.optNote.hidden = !(state === 'running' || state === 'over');
    ui.options.hidden = false;
    ui.optDone.focus();
  }

  // When a window closes, drop keyboard focus from its buttons: otherwise Space and Enter
  // keep going to a hidden button instead of pausing the game.
  function releaseFocus(box) {
    const a = document.activeElement;
    if (a && a !== document.body && (!box || box.contains(a))) a.blur();
  }

  function closeOptions() {
    ui.options.hidden = true;
    releaseFocus(ui.options);
    if (optionsPausedRun) { paused = false; optionsPausedRun = false; }
  }

  // Level options apply at once when nothing is in flight; otherwise from the next attempt.
  function applyLevelSettings() {
    saveSettings();
    syncOptions();
    updateModeChip();
    if (state === 'placing') startLevel(levelIndex, true);
    else if (state === 'menu') showMenu();
  }

  for (const k of ['master', 'sfx', 'hum', 'whoosh']) {
    const input = $('opt-' + k);
    input.addEventListener('input', () => {
      settings[k] = +input.value / 100;
      $('opt-' + k + '-val').textContent = input.value + '%';
      Sound.configure({ [k]: settings[k] });
      saveSettings();
    });
    // play a sample when the slider is released (or changed by keyboard)
    input.addEventListener('change', () => Sound.preview(k === 'master' ? 'sfx' : k));
  }
  $('opt-clicks').addEventListener('change', e => {
    settings.uiClicks = e.target.checked;
    Sound.configure({ uiClicks: settings.uiClicks });
    saveSettings();
    if (settings.uiClicks) Sound.preview('click');
  });
  document.querySelectorAll('#options [data-opt]').forEach(b => {
    b.addEventListener('click', () => {
      settings[b.dataset.opt] = b.dataset.val;
      applyLevelSettings();
    });
  });
  ui.btnOptions.addEventListener('click', e => { openOptions(); e.currentTarget.blur(); });
  ui.btnMenuOptions.addEventListener('click', () => openOptions());
  ui.optDone.addEventListener('click', closeOptions);

  // ---------- display options ----------
  function setGhost(on) {
    settings.ghost = on;
    saveSettings();
    $('opt-ghost').checked = on;
    if (state !== 'menu') flash(on ? 'Best-run ghost on' : 'Best-run ghost off');
  }
  $('opt-shake').checked = settings.shake;
  $('opt-ghost').checked = settings.ghost;
  $('opt-shake').addEventListener('change', e => {
    settings.shake = e.target.checked;
    renderer.shakeEnabled = settings.shake;
    saveSettings();
  });
  $('opt-ghost').addEventListener('change', e => setGhost(e.target.checked));
  // Random levels: one checkbox per feature (all on by default).
  document.querySelectorAll('#opt-random input[data-feature]').forEach(cb => {
    const bit = NS.RANDOM_FEATURES[cb.dataset.feature];
    cb.checked = (settings.random & bit) !== 0;
    cb.addEventListener('change', () => {
      settings.random = cb.checked ? settings.random | bit : settings.random & ~bit;
      saveSettings();
    });
  });
  $('opt-random-all').addEventListener('click', () => {
    const all = settings.random !== NS.RANDOM_ALL;
    settings.random = all ? NS.RANDOM_ALL : 0;
    document.querySelectorAll('#opt-random input[data-feature]').forEach(cb => { cb.checked = all; });
    saveSettings();
  });
  $('opt-slowmo').checked = settings.slowmo;
  $('opt-slowmo').addEventListener('change', e => { settings.slowmo = e.target.checked; saveSettings(); });
  $('opt-tips').addEventListener('click', () => {
    seen = {};
    try { localStorage.removeItem(SEEN_KEY); } catch (e) { /* ignore */ }
    flash('Intro cards will show again');
  });

  // ---------- intro cards ----------
  const INTROS = {
    zones: ['No-place zones', 'The red dashed circles are off limits: you can\'t drop the particle inside them. Gravity still works there.'],
    blackhole: ['Black hole', 'Very heavy and tiny. Only the black centre swallows you; the glowing disk is just hot gas, so you can skim right past it.'],
    comet: ['Comets', 'Small, fast visitors. Many come back every few seconds (watch for the arrows at the edge). Their tug can help, but a hit ends the run.'],
    wormhole: ['Wormholes', 'Two linked mouths of the same colour. Fly into one and you come out of the other, still moving the same way.'],
    pulsar: ['Pulsar', 'A tiny neutron star whose pull pulses: strong while it glows bright, weak while it dims. Time your pass to the beat.'],
    whitehole: ['White hole', 'The reverse of a black hole: it pushes you away instead of pulling you in. Bounce off it to bend your path. Touching it still ends the run.'],
    nebula: ['Nebula', 'A cloud of gas that slows you while you are inside it, most of all in the middle. Handy for settling into an orbit, bad for speed.'],
    thrust: ['Thrusters', 'While flying, an orange arrow from the particle follows your pointer: click (or tap) to fire a short burst that way. Arrow keys also work. You only get a few per run: the dots in the top bar show what is left.'],
    launch: ['Slingshot', 'Press where you want to start, drag in the direction to throw, and release. The dotted line shows the first second. A click without dragging still just drops.'],
  };
  let introQueue = [];
  let introKind = null;

  function featuresOf(def) {
    const f = [];
    if (def.noPlaceZones && def.noPlaceZones.length) f.push('zones');
    if (def.sources.some(s => s.kind === 'blackhole')) f.push('blackhole');
    if (def.sources.some(s => s.kind === 'comet')) f.push('comet');
    if (def.wormholes && def.wormholes.length) f.push('wormhole');
    if (def.launch) f.push('launch');
    if (def.sources.some(s => s.kind === 'pulsar')) f.push('pulsar');
    if (def.sources.some(s => s.kind === 'whitehole')) f.push('whitehole');
    if (def.nebulae && def.nebulae.length) f.push('nebula');
    if (def.thrust && def.thrust.count > 0) f.push('thrust');
    return f;
  }

  function showIntros(def) {
    introQueue = featuresOf(def).filter(k => !seen[k]);
    nextIntro(true);
  }

  // Show the next unseen card (first = opening the queue rather than dismissing a card).
  function nextIntro(first) {
    if (!first && introKind) {
      seen[introKind] = 1;
      try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch (e) { /* ignore */ }
    }
    introKind = introQueue.shift() || null;
    ui.intro.hidden = !introKind;
    if (!introKind) releaseFocus(ui.intro);
    if (!introKind) {
      if (autoReplay) startAutoReplay();
      return;
    }
    ui.introTitle.textContent = INTROS[introKind][0];
    ui.introMsg.textContent = INTROS[introKind][1];
    ui.introOk.focus();
  }
  ui.introOk.addEventListener('click', () => nextIntro());

  // ---------- stats ----------
  function fmtTime(s) {
    if (s < 60) return Math.round(s) + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + Math.round(s % 60) + 's';
    return Math.floor(s / 3600) + 'h ' + Math.round((s % 3600) / 60) + 'm';
  }
  function openStats() {
    const s = stats;
    const n = x => Math.round(x).toLocaleString();
    const cleared = { easy: 0, normal: 0, hard: 0 };
    Object.values(progress.cleared || {}).forEach(d => { if (cleared[d] != null) cleared[d]++; });
    const crashes = s.crashStar + s.crashHole + s.crashComet;
    const rows = [
      ['sec', 'Flying'],
      ['Runs', n(s.drops) + (s.launches ? ` <span class="sub">(${n(s.launches)} slingshot)</span>` : '')],
      ['Total distance', n(s.distance)],
      ['Time in flight', fmtTime(s.flightTime)],
      ['Longest run', s.longest ? `${n(s.longest)} <span class="sub">${escapeHtml(s.longestWhere)}</span>` : '–'],
      ['Average run', s.drops ? n(s.distance / s.drops) : '–'],
      ['Wormhole jumps', n(s.warps)],
      ['Thruster nudges', n(s.nudges)],
      ['Near misses', n(s.nearMisses)],
      ['sec', 'How runs ended'],
      ['Passed the target', n(s.passes)],
      ['Crashed', `${n(crashes)} <span class="sub">${n(s.crashStar)} star · ${n(s.crashHole)} black hole · ${n(s.crashComet)} comet</span>`],
      ['Escaped', n(s.escapes)],
      ['Steady orbit', n(s.orbits)],
      ['Out of time', n(s.timeouts)],
      ['sec', 'Progress'],
      ['Levels cleared', `${Object.keys(progress.cleared || {}).length} / ${LEVELS.length}`],
      ['…on Easy / Normal / Hard', `${cleared.easy} / ${cleared.normal} / ${cleared.hard}`],
      ['Random layouts played', n(s.randomPlayed)],
      ['Levels created', n(s.created)],
    ];
    ui.statsList.innerHTML = rows.map(([a, b]) => a === 'sec'
      ? `<div class="sec">${b}</div>` : `<dt>${a}</dt><dd>${b}</dd>`).join('');
    ui.statsReset.classList.remove('confirm');
    ui.statsReset.textContent = 'Reset stats';
    ui.stats.hidden = false;
    $('stats-done').focus();
  }
  function closeStats() { ui.stats.hidden = true; releaseFocus(ui.stats); }
  function escapeHtml(t) { return String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  $('btn-stats').addEventListener('click', openStats);
  $('stats-done').addEventListener('click', closeStats);
  ui.statsReset.addEventListener('click', () => {
    const b = ui.statsReset;
    if (!b.classList.contains('confirm')) {
      b.classList.add('confirm'); b.textContent = 'Reset all stats?';
      setTimeout(() => { b.classList.remove('confirm'); b.textContent = 'Reset stats'; }, 3000);
      return;
    }
    stats = Object.assign({}, STATS_DEFAULT, { since: Date.now() });
    saveStats();
    openStats();
    flash('Stats reset');
  });

  // ---------- sharing runs ----------
  // Link format: <page>#run=<base64url JSON>. The JSON names the level (campaign index,
  // random seed, or the full layout for custom levels) and the run's start + launch velocity.
  const b64enc = s => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const b64dec = s => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));

  // Which level a link should open: campaign index, random seed, or the full layout.
  function linkTarget() {
    if (isShared()) {
      const i = LEVELS.findIndex(L => L.sources === sharedDef.sources);
      if (i >= 0) return { l: i };
      if (sharedDef.seed) return { seed: sharedDef.seed, f: sharedDef.mask != null ? sharedDef.mask : NS.RANDOM_LEGACY };
    }
    if (isCampaign()) return { l: levelIndex };
    if (isRandom()) return { seed: randomLevel.seed, f: randomLevel.mask };
    if (isSaved() && !savedEntry.custom && savedEntry.seed) return { seed: savedEntry.seed, f: maskOf(savedEntry) };
    const d = JSON.parse(JSON.stringify(currentDef()));
    delete d.seed; delete d.kind;
    return { def: d };
  }

  function shareLink() {
    if (!lastRun) return null;
    const p = Object.assign({ v: 1 }, lastRun.run, lastRun.link);
    return location.href.split('#')[0] + '#run=' + b64enc(JSON.stringify(p));
  }

  ui.btnShare.addEventListener('click', e => {
    e.currentTarget.blur();
    const url = shareLink();
    if (!url) return;
    const show = () => { ui.shareLink.value = url; ui.shareLink.hidden = false; ui.shareLink.select(); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(() => flash('Link copied — send it to a friend'), () => { show(); flash('Copy the link below'); });
    } else { show(); flash('Copy the link below'); }
    if (location.protocol === 'file:') setTimeout(() => flash('Note: links to a local file only work on this computer'), 2200);
  });

  // Open a shared run from the page address, if there is one.
  function openSharedFromHash() {
    const m = /#run=([A-Za-z0-9_-]+)/.exec(location.hash);
    if (!m) return false;
    let p;
    try { p = JSON.parse(b64dec(m[1])); } catch (e) { p = null; }
    const num = v => typeof v === 'number' && isFinite(v);
    if (!p || !num(p.x) || !num(p.y)) { flash('That share link looks broken'); return false; }
    const run = { x: p.x, y: p.y, vx: num(p.vx) ? p.vx : 0, vy: num(p.vy) ? p.vy : 0 };
    if (Array.isArray(p.nudges) && p.nudges.length <= 9 && p.nudges.every(n => n && num(n.s) && n.s >= 0 && num(n.vx) && num(n.vy))) {
      run.nudges = p.nudges.map(n => ({ s: Math.round(n.s), vx: n.vx, vy: n.vy }));
    }
    const open = def => {
      sharedDef = def; sharedRun = run; sharedBest = 0;
      autoReplay = run;
      startLevel(SHARED);
    };
    if (num(p.l) && LEVELS[p.l]) { open(Object.assign({}, LEVELS[p.l], { name: `${p.l + 1}. ${LEVELS[p.l].name}` })); return true; }
    if (num(p.seed) && p.seed >= 1 && p.seed <= MAX_SEED) {
      state = 'generating';
      ui.menu.hidden = true;
      ui.paused.textContent = 'Generating…';
      ui.paused.hidden = false;
      setTimeout(() => { ui.paused.textContent = 'Paused'; ui.paused.hidden = true; open(NS.generateLevel(p.seed, num(p.f) && p.f >= 0 && p.f <= NS.RANDOM_ALL ? p.f : NS.RANDOM_LEGACY)); }, 30);
      return true;
    }
    if (p.def && Array.isArray(p.def.sources) && p.def.sources.length && p.def.sources.length <= 12 &&
        p.def.sources.every(s => num(s.x) && num(s.y) && num(s.mass) && num(s.radius))) {
      open(Object.assign({ name: 'Shared level', hint: '', target: 1000 }, p.def));
      return true;
    }
    flash('That share link looks broken');
    return false;
  }

  // ---------- menu ----------
  // Close the menu and carry on with the level it was opened over, exactly where it was.
  function resumeFromMenu() {
    const r = menuReturn;
    menuReturn = null;
    if (!r || state !== 'menu' || r.world !== world) return false;
    ui.menu.hidden = true;
    state = r.state;
    autoReplay = r.autoReplay;
    introQueue = r.introQueue;
    introKind = r.introKind;
    ui.intro.hidden = !introKind;
    if (state === 'over') ui.overlay.hidden = false;      // (also if its 1s delay was still pending)
    ui.paused.hidden = !(state === 'running' && paused);
    updateHud();
    if (autoReplay) startAutoReplay();
    return true;
  }

  function hideIntro() { introQueue = []; introKind = null; ui.intro.hidden = true; }

  function showMenu() {
    // Opened over a level: remember it, so clicking outside the menu (or Esc) goes back to it.
    const resumable = world && (state === 'placing' || state === 'aiming' || state === 'running' || state === 'over');
    menuReturn = resumable
      ? { world, state: state === 'aiming' ? 'placing' : state, autoReplay, introKind, introQueue: introQueue.slice() }
      : null;
    state = 'menu';
    aim = null;
    autoReplay = null;
    hideIntro();
    ui.overlay.hidden = true;
    ui.paused.hidden = true;
    ui.grid.innerHTML = '';
    LEVELS.forEach((L, i) => {
      const b = document.createElement('button');
      b.className = 'level-btn';
      const locked = i > progress.unlocked;
      const best = progress.best[i];
      const cleared = progress.cleared[i];
      const done = !!cleared;
      const tag = cleared && cleared !== 'normal' ? ' · ' + DIFFICULTY[cleared].label.toLowerCase() : '';
      b.disabled = locked;
      b.innerHTML = `<span class="num">${i + 1}</span><span class="nm">${locked ? 'Locked' : L.name}</span>` +
        `<span class="st">${done ? '✓ ' + Math.round(best) + tag : locked ? '' : 'target ' + scaledTarget(L.target)}</span>`;
      if (done) b.classList.add('done');
      b.addEventListener('click', () => startLevel(i));
      ui.grid.appendChild(b);
    });
    const rb = document.createElement('button');
    rb.className = 'level-btn random';
    rb.innerHTML = '<span class="num">∞</span><span class="nm">Random</span><span class="st">new layout every time</span>';
    rb.addEventListener('click', () => startRandom());
    ui.grid.appendChild(rb);
    renderMyLevels();
    ui.menu.hidden = false;
  }

  // ---------- run results ----------
  // Called once, the moment the particle reaches the target. The run keeps going.
  function onPassed() {
    passAnnounced = true;
    Sound.play('pass');
    if (isCampaign()) {
      if (progress.unlocked < levelIndex + 1) progress.unlocked = Math.min(LEVELS.length - 1, levelIndex + 1);
      const prev = progress.cleared[levelIndex];
      if (!prev || DIFF_RANK[settings.difficulty] > DIFF_RANK[prev]) progress.cleared[levelIndex] = settings.difficulty;
      saveProgress();
    }
    recordSavedResult(world.path, true);
    const last = isCampaign() && levelIndex === LEVELS.length - 1;
    if (world.status === 'running') flash(last ? 'All levels cleared! Keep going…' : 'Level passed! Keep going…');
    const p = world.particle;
    renderer.burst(p.x, p.y, '120,255,170', 26, 200);
    renderer.ring(p.x, p.y, '120,255,170', 24);
  }

  // Where and how a run started: enough to replay it exactly.
  // Should a run of this length replace the stored ghost run? (Old saves have bests but no
  // runs, and runs stored before lengths were kept count as length 0.)
  const betterRun = (stored, path) => !stored || path > (stored.len || 0);

  function runOf(w) {
    const s = w.start;
    // full precision: runs are chaotic, so even a rounded start could replay as a different path
    const run = { x: s.x, y: s.y, vx: s.vx || 0, vy: s.vy || 0 };
    if (w.nudges && w.nudges.length) run.nudges = w.nudges.map(n => ({ s: n.s, vx: n.vx, vy: n.vy }));
    return run;
  }

  function recordStats(w) {
    stats.distance += w.path;
    stats.flightTime += w.time;
    if (w.path > stats.longest) { stats.longest = w.path; stats.longestWhere = ui.levelName.textContent; }
    if (w.status === 'crashed') {
      const k = w.hit && w.hit.kind;
      if (k === 'blackhole') stats.crashHole++; else if (k === 'comet') stats.crashComet++; else stats.crashStar++;
    } else if (w.status === 'escaped') stats.escapes++;
    else if (w.status === 'timeout') stats.timeouts++;
    else if (w.status === 'orbit') stats.orbits++;
    if (w.passed) stats.passes++;
    stats.nudges += w.nudges ? w.nudges.length : 0;
    saveStats();
  }

  // Sparks (or a black-hole swirl) and a little shake where the run ended.
  function endEffects(w) {
    const p = w.particle;
    if (w.status !== 'crashed') return;
    const k = w.hit && w.hit.kind;
    if (k === 'blackhole') renderer.spiral(w.hit.x, w.hit.y, p);
    else renderer.burst(p.x, p.y, k === 'comet' ? '190,230,255' : k === 'pulsar' ? '170,205,255' : k === 'whitehole' ? '235,245,255' : '255,170,90', 46, 260);
    renderer.shake(k === 'blackhole' ? 5 : 9);
  }

  function endRun() {
    state = 'over';
    Sound.play({ crashed: 'crash', escaped: 'escape', orbit: 'orbit' }[world.status] || 'timeout');
    const passed = !!world.passed;
    const path = world.path;
    const replay = world.replay;
    const ownReplay = !!world.ownReplay;
    if (!ownReplay) marks.push({ x: world.start.x, y: world.start.y, frac: Math.min(1, path / world.target), won: passed });
    endEffects(world);
    if (!replay) recordStats(world);
    const run = runOf(world);
    if (replay) {
      // watching a shared run: nothing to record
    } else if (isShared()) {
      sharedBest = Math.max(sharedBest, path);
    } else if (isTest()) {
      if (path > testBest) { testBest = path; testBestRun = run; }
    } else if (isRandom() || isSaved()) {
      if (isRandom() && path > randomBest) { randomBest = path; randomBestRun = run; }
      recordSavedResult(path, passed);
    } else {
      if (!(progress.best[levelIndex] >= path)) progress.best[levelIndex] = path;
      progress.bestRun = progress.bestRun || {};
      if (betterRun(progress.bestRun[levelIndex], path)) progress.bestRun[levelIndex] = Object.assign({ len: path }, run);
      saveProgress();
    }
    lastRun = { run, path, link: linkTarget() };
    ui.shareLink.hidden = true;

    const last = isCampaign() && levelIndex === LEVELS.length - 1;
    const reasons = {
      crashed: world.hit && world.hit.kind === 'blackhole' ? 'Fell past the event horizon.'
        : world.hit && world.hit.kind === 'comet' ? 'Struck by a comet.'
        : world.hit && world.hit.kind === 'pulsar' ? 'Crushed against a pulsar.'
        : world.hit && world.hit.kind === 'whitehole' ? 'Burned up on a white hole.' : 'Swallowed by a gravity well.',
      escaped: 'Escaped into deep space.',
      timeout: 'Out of time.',
      orbit: 'Locked into a steady orbit' + (world.orbitPeriod ? ` (one lap every ${world.orbitPeriod.toFixed(1)}s).` : '.'),
    };
    if (ownReplay) {
      ui.oTitle.textContent = passed ? 'Replay: cleared' : 'Replay';
      ui.oMsg.textContent = `${reasons[world.status]} Total distance ${Math.round(path)} in ${world.time.toFixed(1)}s` +
        (passed ? ` (passed ${world.target} at ${world.passedAt.toFixed(1)}s).` : ` of ${world.target}.`);
    } else if (replay) {
      ui.oTitle.textContent = 'Shared run';
      ui.oMsg.textContent = `${reasons[world.status]} Your friend travelled ${Math.round(path)}` +
        (passed ? ` and passed ${world.target}.` : ` of ${world.target}.`) + ' Press R to try to beat it.';
    } else if (isShared()) {
      const theirs = ghostPath ? ghostPath.len : 0;
      ui.oTitle.textContent = path > theirs ? 'You beat it!' : 'Run over';
      ui.oMsg.textContent = `${reasons[world.status]} You travelled ${Math.round(path)}; the shared run reached ` +
        `${Math.round(theirs)} in its first ${GHOST_SECONDS}s.`;
    } else if (passed) {
      ui.oTitle.textContent = last ? 'All levels cleared!' : isCampaign() ? 'Level complete' : 'Layout cleared';
      ui.oMsg.textContent = `${reasons[world.status]} Total distance ${Math.round(path)} in ${world.time.toFixed(1)}s ` +
        (world.projectedPass
          ? `(the orbit would pass ${world.target} at ${world.passedAt.toFixed(1)}s, attempt ${attempts}).`
          : `(passed ${world.target} at ${world.passedAt.toFixed(1)}s, attempt ${attempts}).`);
    } else {
      ui.oTitle.textContent = 'Run over';
      ui.oMsg.textContent = `${reasons[world.status]} Travelled ${Math.round(path)} of ${world.target}` +
        (world.status === 'orbit' && world.projectedPath != null
          ? `; it would only reach ${Math.round(world.projectedPath)} before time runs out.`
          : '.');
    }
    if (world.topSpeed) ui.oMsg.textContent += ` Top speed ${Math.round(world.topSpeed)}.`;
    ui.oTitle.className = passed || (isShared() && !replay && ui.oTitle.textContent === 'You beat it!') ? 'win' : 'lose';
    ui.btnNext.hidden = isSaved() || isShared() || !(isRandom() || isTest() || (passed && !last));
    ui.btnReplay.hidden = !passed || (replay && !ownReplay);
    updateHud();
    // hold the result card back a moment so the crash / finish can be seen
    const ended = world;
    clearTimeout(overlayTimer);
    overlayTimer = setTimeout(() => {
      if (state !== 'over' || world !== ended) return;
      ui.overlay.hidden = false;
      (passed && !ui.btnNext.hidden ? ui.btnNext : ui.btnRetry).focus();
    }, RESULT_DELAY);
  }

  // ---------- HUD ----------
  function updateHud() {
    if (!world) return;
    const frac = Math.min(1, world.path / world.target);
    const out = world.outside && state === 'running';
    ui.dist.textContent = (world.passed
      ? `${Math.round(world.path)} · passed ${world.target} ✓`
      : `${Math.round(world.path)} / ${world.target}`) + (out ? ' · outside: not counting' : '');
    ui.bar.classList.toggle('outside', out);
    ui.barFill.style.width = (frac * 100).toFixed(1) + '%';
    ui.barFill.classList.toggle('full', frac >= 1);
    ui.attempts.textContent = attempts;
    const left = Math.max(0, world.timeLimit - world.time);
    ui.clock.textContent = world.passed || !isFinite(world.timeLimit) ? '∞' : left.toFixed(1) + 's';
    ui.speed.textContent = speed + '×';
    ui.thrustStat.hidden = !world.thrust;
    if (world.thrust) ui.thrust.textContent = '●'.repeat(Math.max(0, world.nudgesLeft)) + '○'.repeat(world.thrust.count - Math.max(0, world.nudgesLeft));
    const p = world.particle;
    ui.vel.textContent = state === 'over' && world.topSpeed ? 'top ' + Math.round(world.topSpeed)
      : p && state === 'running' ? Math.round(Math.hypot(p.vx, p.vy)) : '–';
    const best = isTest() ? testBest : isRandom() ? randomBest : isSaved() ? savedEntry.best : progress.best[levelIndex];
    ui.best.textContent = best ? Math.round(best) : '–';
  }

  // ---------- input ----------
  function toWorld(e) {
    const r = canvas.getBoundingClientRect();
    return renderer.screenToWorld((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  }

  // Start a run: drop at rest, or launch with a velocity (slingshot levels).
  // replay = playing back someone else's run, which isn't counted anywhere.
  function launchAt(x, y, vx, vy, replay, nudges) {
    if (!world.place(x, y, vx, vy)) return false;
    world.replay = !!replay;
    if (replay && nudges) world.scheduleNudges(nudges);
    nudgesSeen = 0;
    Sound.play(vx || vy ? 'launch' : 'place');
    if (!replay) {
      attempts++;
      stats.drops++;
      if (vx || vy) stats.launches++;
      saveStats();
    }
    state = 'running';
    aim = null;
    updateHud();
    return true;
  }

  // Thruster nudge toward (dx, dy) during a run (live play only, not replays).
  function thrustToward(dx, dy) {
    if (state !== 'running' || paused || !world.thrust || world.replay) return false;
    const v = world.nudge(dx, dy);
    if (!v) { if (world.thrust && world.nudgesLeft <= 0) Sound.play('invalid'); return false; }
    nudgesSeen = world.nudges.length;
    Sound.play('thrust');
    renderer.exhaust(world.particle.x, world.particle.y, v.vx, v.vy);
    updateHud();
    return true;
  }
  // Replays: show the exhaust when a recorded nudge fires.
  let nudgesSeen = 0;
  function showReplayNudges() {
    while (world.nudges.length > nudgesSeen) {
      const n = world.nudges[nudgesSeen++];
      Sound.play('thrust');
      renderer.exhaust(world.particle.x, world.particle.y, n.vx, n.vy);
    }
  }

  // Slingshot: velocity follows the drag (direction = throw direction), capped at the level's max.
  function updateAim(e) {
    const p = toWorld(e);
    const r = canvas.getBoundingClientRect();
    const dragPx = Math.hypot(e.clientX - aim.sx, e.clientY - aim.sy) / r.width * 1000;
    let vx = 0, vy = 0;
    if (dragPx >= 6) {
      vx = (p.x - aim.x) * LAUNCH_PULL; vy = (p.y - aim.y) * LAUNCH_PULL;
      const sp = Math.hypot(vx, vy);
      if (sp > aim.max) { vx *= aim.max / sp; vy *= aim.max / sp; }
    }
    if (Math.abs(vx - aim.vx) < 0.5 && Math.abs(vy - aim.vy) < 0.5 && aim.preview) return;
    aim.vx = vx; aim.vy = vy;
    aim.preview = predict(aim.x, aim.y, vx, vy, 1);
  }

  // The first `seconds` of a launch, as a list of points (for the aim preview).
  function predict(x, y, vx, vy, seconds) {
    const w = new NS.World(Object.assign({}, world.level, { target: Infinity }));
    if (!w.place(x, y, vx, vy)) return null;
    const pts = [x, y];
    const steps = Math.round(seconds / NS.DT);
    for (let i = 1; i <= steps && w.status === 'running'; i++) {
      w.step();
      if (w.warped) break;
      if (i % 6 === 0) pts.push(w.particle.x, w.particle.y);
    }
    return pts;
  }

  function cancelAim() {
    if (state !== 'aiming') return;
    aim = null;
    state = 'placing';
  }

  canvas.addEventListener('pointermove', e => {
    ghost = toWorld(e);
    const r = canvas.getBoundingClientRect();
    pointerAt = { fx: (e.clientX - r.left) / r.width, fy: (e.clientY - r.top) / r.height };
    if (state === 'editing') editor.pointerMove(ghost);
    else if (state === 'aiming') updateAim(e);
  });
  canvas.addEventListener('pointerleave', () => { ghost = null; pointerAt = null; });
  let pointerAt = null;    // last pointer position over the arena, as fractions of the canvas
  canvas.addEventListener('pointerup', e => {
    if (state === 'editing') editor.pointerUp();
    else if (state === 'aiming') {
      updateAim(e);
      launchAt(aim.x, aim.y, aim.vx, aim.vy);
    }
  });
  canvas.addEventListener('pointercancel', () => { if (state === 'editing') editor.pointerUp(); else cancelAim(); });
  canvas.addEventListener('contextmenu', e => { if (state === 'aiming') { e.preventDefault(); cancelAim(); } });
  canvas.addEventListener('wheel', e => {
    if (state === 'editing' && editor.wheel(toWorld(e), e.deltaY)) e.preventDefault();
  }, { passive: false });
  canvas.addEventListener('pointerdown', e => {
    ghost = toWorld(e);
    if (state === 'editing') {
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
      editor.pointerDown(ghost);
      return;
    }
    if (state === 'running') { if (e.button !== 2) thrustToward(ghost.x - world.particle.x, ghost.y - world.particle.y); return; }
    if (state !== 'placing' || !ui.intro.hidden) return;
    if (e.button === 2) return;
    if (!world.canPlace(ghost.x, ghost.y)) { Sound.play('invalid'); return; }
    if (world.level.launch) {
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
      aim = { x: ghost.x, y: ghost.y, vx: 0, vy: 0, max: world.level.launch.max || 260, sx: e.clientX, sy: e.clientY, preview: null };
      aim.preview = predict(aim.x, aim.y, 0, 0, 1);
      state = 'aiming';
      return;
    }
    launchAt(ghost.x, ghost.y, 0, 0);
  });

  const ARROWS = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
  window.addEventListener('keydown', e => {
    if (!ui.options.hidden) {
      if (e.key === 'Escape' || (e.key.toLowerCase() === 'o' && e.target.tagName !== 'INPUT')) { closeOptions(); e.preventDefault(); }
      return;
    }
    if (!ui.stats.hidden) {
      if (e.key === 'Escape') { closeStats(); e.preventDefault(); }
      return;
    }
    if (!ui.intro.hidden) {
      if (e.key === 'Enter' || e.key === 'Escape' || e.key === ' ') { nextIntro(); e.preventDefault(); }
      return;
    }
    // Space always pauses / resumes a run, wherever keyboard focus happens to be (a top-bar
    // button clicked earlier, or one inside a window that has since closed). Otherwise a
    // focused button would swallow it, or be pressed again, and the run would stay paused.
    if (e.key === ' ' && state === 'running' && !(e.target.tagName === 'INPUT' && /^(text|number|search)$/.test(e.target.type))) {
      releaseFocus();
      paused = !paused;
      ui.paused.hidden = !paused;
      e.preventDefault();
      return;
    }
    const hiddenTarget = e.target.closest && e.target.closest('[hidden]');
    if (e.target.tagName === 'INPUT' && !hiddenTarget) return;
    if (e.target.tagName === 'BUTTON' && !hiddenTarget && (e.key === ' ' || e.key === 'Enter')) return;
    const k = e.key.toLowerCase();
    if (state === 'generating') return;
    if (state === 'aiming') { if (k === 'escape') { cancelAim(); e.preventDefault(); } return; }
    if (k === 'h' && state !== 'editing') { setGhost(!settings.ghost); return; }
    if (k === 'm') { toggleMute(); return; }
    if (k === 'o' && state !== 'editing') { openOptions(); return; }
    if (state === 'editing') {
      if (!editor.key(e) && k === 'g') toggleField();
      return;
    }
    if (isTest() && state !== 'menu' && (k === 'e' || k === 'escape')) { backToEditor(); return; }
    if (k === 'w' && state === 'over') replayLast();
    else if (k === 'r' && state !== 'menu') retry();
    else if (k === 'n' && state !== 'menu') nextLevel();
    else if (k === 's' && state !== 'menu') saveCurrent();
    else if (k === 'e' && state !== 'menu') editCurrent();
    else if (k === 'g') toggleField();
    else if (k === 'f') cycleSpeed(e.shiftKey ? -1 : 1);
    else if (k === 'escape') { if (!(state === 'menu' && resumeFromMenu())) showMenu(); }
    else if (state === 'running' && ARROWS[e.key]) { thrustToward(ARROWS[e.key][0], ARROWS[e.key][1]); e.preventDefault(); }
  });

  $('btn-speed').addEventListener('click', e => { cycleSpeed(e.shiftKey ? -1 : 1); e.currentTarget.blur(); });
  ui.btnRetry.addEventListener('click', retry);
  ui.btnReplay.addEventListener('click', replayLast);
  ui.btnNext.addEventListener('click', nextLevel);
  ui.btnLevels.addEventListener('click', showMenu);
  ui.btnMenu.addEventListener('click', showMenu);
  // Clicking anywhere outside an open window closes it:
  //  - Options / Stats: anywhere outside the panel (the dimmed arena, the top bar, ⚙ again)
  //  - the levels menu: goes back to the level it was opened over
  // That click is swallowed so it doesn't also drop a particle or press a button underneath.
  function swallowClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const swallow = ev => { ev.stopPropagation(); ev.preventDefault(); };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, true), 400);
  }
  window.addEventListener('pointerdown', e => {
    for (const [box, close] of [[ui.options, closeOptions], [ui.stats, closeStats]]) {
      if (box.hidden) continue;
      if (!box.querySelector('.panel').contains(e.target)) { close(); swallowClick(e); }
      return;
    }
    if (ui.menu.hidden || state !== 'menu' || !menuReturn || ui.menu.contains(e.target)) return;
    if (resumeFromMenu()) swallowClick(e);
  }, true);
  ui.btnSave.addEventListener('click', e => { saveCurrent(); e.currentTarget.blur(); });

  // Through a wormhole: sound, a ring at each mouth, and a count for the stats.
  function onWarp() {
    Sound.play('warp');
    const lock = world.warpLock;
    if (lock) {
      const w = lock.w, hue = NS.Renderer.wormHue(world.wormholes.indexOf(w));
      const rgb = hue > 250 ? '210,150,255' : hue > 100 ? '120,255,220' : '255,210,120';
      renderer.ring(w.ax, w.ay, rgb, w.r);
      renderer.ring(w.bx, w.by, rgb, w.r);
    }
    if (!world.replay) stats.warps++;
  }

  // ---------- slow-mo near misses ----------
  // A run heading for a very close pass by a star or black hole briefly slows down
  // (time x0.2) while the camera leans in. Real-time phases: ease in, hold, ease out.
  const SLOWMO = { in: 0.15, hold: 0.5, out: 0.4, scale: 0.2, cool: 3, lookahead: 0.3, maxSpeed: 4 };
  let slowmo = { phase: 'idle', t: 0, k: 0, cool: 0, src: null };
  function resetSlowmo() { slowmo = { phase: 'idle', t: 0, k: 0, cool: 0, src: null }; renderer.focus(null, null, 0); }

  // How close counts as a near miss: the gap between the particle and the body's surface.
  const nearGap = s => Math.max(8, 0.5 * s.radius) * (s.kind === 'blackhole' ? 1.5 : 1);
  const solidBody = s => s.kind !== 'comet' && s.kind !== 'whitehole';

  // Slow-mo only for real close fly-bys. A cheap straight-line check finds candidates;
  // then the next PREDICT_S seconds are simulated with real gravity (bodies moving in
  // straight lines meanwhile). It fires only if the particle truly passes within nearGap
  // of a body's surface, soon, and doesn't hit anything (a crash is not a near miss).
  const PREDICT_S = 0.45;
  function detectNearMiss() {
    if (!settings.slowmo || speed > SLOWMO.maxSpeed || slowmo.phase !== 'idle' || slowmo.cool > 0) return;
    const p = world.particle;
    if (!p || world.time < 0.5) return;
    let candidate = false;
    for (const s of world.sources) {
      if (!solidBody(s)) continue;
      const rx = p.x - s.x, ry = p.y - s.y, vx = p.vx - s.vx, vy = p.vy - s.vy;
      const v2 = vx * vx + vy * vy;
      if (v2 < 1) continue;
      const ts = -(rx * vx + ry * vy) / v2;
      if (ts <= 0 || ts > PREDICT_S) continue;
      if (Math.hypot(rx + vx * ts, ry + vy * ts) - s.radius - p.radius < 4 * nearGap(s) + 20) { candidate = true; break; }
    }
    if (!candidate) return;
    const pass = predictPass(p, world.sources, PREDICT_S);
    if (pass && pass.t <= SLOWMO.lookahead) {
      slowmo = { phase: 'in', t: 0, k: 0, cool: 0, src: pass.src };
      Sound.play('slowmo');
    }
  }

  // Closest real approach to a solid body over the next `seconds`: { src, gap, t }, or null
  // if the particle would hit something, or never comes within nearGap of a surface.
  function predictPass(p0, sources, seconds) {
    const DT = NS.DT, SOFT2 = 16;
    let x = p0.x, y = p0.y, vx = p0.vx, vy = p0.vy;
    const acc = t => {
      let ax = 0, ay = 0;
      for (const s of sources) {
        const dx = s.x + s.vx * t - x, dy = s.y + s.vy * t - y;
        const r2 = dx * dx + dy * dy + SOFT2, f = s.mass / (r2 * Math.sqrt(r2));
        const sign = s.kind === 'whitehole' ? -1 : 1;
        ax += sign * dx * f; ay += sign * dy * f;
      }
      return [ax, ay];
    };
    let best = null;
    let [ax, ay] = acc(0);
    const steps = Math.round(seconds / DT);
    for (let i = 1; i <= steps; i++) {
      vx += 0.5 * ax * DT; vy += 0.5 * ay * DT;
      x += vx * DT; y += vy * DT;
      const t = i * DT;
      [ax, ay] = acc(t);
      vx += 0.5 * ax * DT; vy += 0.5 * ay * DT;
      for (const s of sources) {
        const gap = Math.hypot(x - (s.x + s.vx * t), y - (s.y + s.vy * t)) - s.radius - p0.radius;
        if (gap <= 0) return null;                       // heading into a crash
        if (solidBody(s) && gap < nearGap(s) && (!best || gap < best.gap)) best = { src: s, gap, t };
      }
    }
    return best;
  }

  function updateSlowmo(dt) {
    const m = slowmo;
    if (m.phase === 'idle') { if (m.cool > 0) m.cool -= dt; return; }
    if (state === 'running' && paused) return;
    m.t += dt;
    if (m.phase === 'in') { m.k = Math.min(1, m.t / SLOWMO.in); if (m.t >= SLOWMO.in) { m.phase = 'hold'; m.t = 0; } }
    else if (m.phase === 'hold') { m.k = 1; if (m.t >= SLOWMO.hold || state !== 'running') { m.phase = 'out'; m.t = 0; } }
    else {
      m.k = Math.max(0, 1 - m.t / SLOWMO.out);
      if (m.t >= SLOWMO.out) {
        // it counts as a near miss if the run didn't end on that body
        if (world && !world.replay && !(world.status === 'crashed' && world.hit === m.src)) { stats.nearMisses++; saveStats(); }
        slowmo = { phase: 'idle', t: 0, k: 0, cool: SLOWMO.cool, src: null };
        renderer.focus(null, null, 0);
        return;
      }
    }
    const p = world && world.particle, s = m.src;
    if (p && s) renderer.focus((p.x + s.x) / 2, (p.y + s.y) / 2, m.k * m.k * (3 - 2 * m.k));
  }

  // ---------- loop ----------
  function frame(now) {
    const dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;
    clockT += dt;

    updateSlowmo(dt);
    if (state === 'running' && !paused) {
      detectNearMiss();
      acc += dt * speed * (1 - (1 - SLOWMO.scale) * slowmo.k);
      let n = 0;
      while (acc >= NS.DT && n < MAX_STEPS_PER_FRAME * speed) {
        world.step();
        acc -= NS.DT;
        n++;
        if (world.status !== 'running') break;
        checkFlyby(); // per step: at high speed a whole fly-by can happen within one frame
        if (world.warped) onWarp();
      }
      if (world.replay && world.nudges.length > nudgesSeen) showReplayNudges();
      if (world.status === 'running') {
        if (world.outside !== wasOutside) { Sound.play(world.outside ? 'leave' : 'enter'); wasOutside = world.outside; }
      }
      if (world.passed && !passAnnounced) onPassed();
      if (world.status !== 'running') { acc = 0; endRun(); }
      else updateHud();
    }

    const flying = state === 'running' && !paused && world && world.particle;
    Sound.updateDrone(!!flying, flying ? Math.hypot(world.particle.vx, world.particle.vy) : 0);

    // Follow the particle while it flies (and hold the view after a run ends); otherwise frame the arena.
    const following = (state === 'running' || state === 'over') && world && world.particle;
    renderer.follow(following ? world.particle : null, dt);

    if (state === 'editing') {
      renderer.draw(editor.world, { time: clockT, showField, hideArrows: true });
      editor.drawOverlay(renderer.ctx, clockT);
      canvas.style.cursor = editor.cursor();
      requestAnimationFrame(frame);
      return;
    }
    // Thrust levels: while flying with nudges left, aim from the particle toward the pointer.
    let thrustAim = null;
    if (state === 'running' && world.thrust && world.nudgesLeft > 0 && !world.replay && world.particle && pointerAt) {
      const tp = renderer.screenToWorld(pointerAt.fx, pointerAt.fy);
      thrustAim = { x: world.particle.x, y: world.particle.y, tx: tp.x, ty: tp.y, dv: world.thrust.dv };
    }
    canvas.style.cursor = thrustAim ? 'crosshair' : '';

    const showGhost = (state === 'placing' && ghost) || state === 'aiming';
    const at = state === 'aiming' ? aim : ghost;
    renderer.draw(world, {
      time: clockT,
      marks,
      ghost: showGhost ? at : null,
      showField,
      ghostValid: state === 'aiming' || (showGhost ? world.canPlace(ghost.x, ghost.y) : false),
      aim: state === 'aiming' ? aim : null,
      ghostPath: settings.ghost || isShared() ? ghostPath : null,
      ghostTime: state === 'running' || state === 'over' ? world.time : null,
      vignette: slowmo.k,
      thrustAim,
    });
    if (!ui.intro.hidden && introKind) NS.Renderer.drawIcon(ui.introIcon, introKind, clockT);
    requestAnimationFrame(frame);
  }

  $('version').textContent = 'v' + VERSION;
  if (!openSharedFromHash()) showMenu();
  window.addEventListener('hashchange', () => { if (state !== 'editing') openSharedFromHash(); });
  requestAnimationFrame(frame);
})();
