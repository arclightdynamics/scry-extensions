/* Tessera — an original falling-block puzzle. Single-file engine.
 * Mechanics follow the de-facto modern guideline (SRS, 7-bag, hold, lock delay,
 * T-spins, combos, back-to-back). All art + music are original. */
(() => {
  "use strict";

  // ============================================================ Storage
  // Sandboxed iframe: try host bridge -> localStorage -> in-memory.
  const Store = (() => {
    const mem = {};
    let ls = null;
    try { ls = window.localStorage; ls.setItem("__t", "1"); ls.removeItem("__t"); }
    catch { ls = null; }
    const get = (k, d) => {
      try {
        const raw = ls ? ls.getItem(k) : mem[k];
        return raw == null ? d : JSON.parse(raw);
      } catch { return d; }
    };
    const set = (k, v) => {
      const raw = JSON.stringify(v);
      try { if (ls) ls.setItem(k, raw); else mem[k] = raw; } catch { mem[k] = raw; }
      // Best-effort host bridge (Phase 2 storage permission), forward-compatible.
      try { window.parent.postMessage({ scry: true, v: 1, method: "storage.set", params: { key: k, value: raw } }, "*"); } catch {}
    };
    return { get, set, persistent: !!ls };
  })();

  // ============================================================ Config
  const COLS = 10, ROWS = 20;
  // CELL is now responsive (see layout()). All board math reads `CELL` at call time,
  // so reassigning it rescales the playfield. Mini canvases derive from it too.
  let CELL = 30, MINI = 22, NEXTSZ = 20;
  const LOCK_DELAY = 500, MAX_RESETS = 15, CLEAR_ANIM = 320, ARE = 0;

  // Piece spawn matrices (1 = filled). 4x4 for I, 2x2 for O, 3x3 for rest.
  const SHAPES = {
    I: [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]],
    O: [[1,1],[1,1]],
    T: [[0,1,0],[1,1,1],[0,0,0]],
    S: [[0,1,1],[1,1,0],[0,0,0]],
    Z: [[1,1,0],[0,1,1],[0,0,0]],
    J: [[1,0,0],[1,1,1],[0,0,0]],
    L: [[0,0,1],[1,1,1],[0,0,0]],
  };
  const ORDER = ["I", "O", "T", "S", "Z", "J", "L"];

  // Original, colorblind-conscious palette: [base, light, glow]
  // "Aurora" palette: [gradBottom, gradTop, glow] — colorblind-safe (hue + luminance separation).
  const COLORS = {
    I: ["#1B6FA0", "#6FCBF2", "#8FE0FF"],
    O: ["#B47C12", "#FFD37A", "#FFE6A8"],
    T: ["#6A3FBF", "#C4A6FF", "#D9C2FF"],
    S: ["#1A8463", "#6FE0BC", "#9CF2D6"],
    Z: ["#B43A28", "#FF9A85", "#FFB8A8"],
    J: ["#5A88AB", "#C2DCF0", "#DCEEFB"],
    L: ["#A82568", "#FF8AC2", "#FFB0D6"],
    G: ["#1a2730", "#243640", "#1a2730"],
  };
  const CB = { // colorblind-friendly alt (distinct lightness + hue spread)
    I: ["#2aa7d8","#8fd6f0","#5ee0d7"], O: ["#d8a13a","#f3cf86","#f5c98f"],
    T: ["#8050d0","#bda0f0","#8b7dff"], S: ["#3f9e52","#9fdca9","#7ed98a"],
    Z: ["#d23f5e","#f0909f","#ff6b6b"], J: ["#3566c0","#86a8ee","#6c9bff"],
    L: ["#d06a2f","#f0a472","#f0a060"], G: COLORS.G,
  };

  // SRS kick tables (x, y) with y up-positive; we convert y -> row (down) on use.
  const K_JLSTZ = {
    "0>1": [[0,0],[-1,0],[-1,1],[0,-2],[-1,-2]],
    "1>0": [[0,0],[1,0],[1,-1],[0,2],[1,2]],
    "1>2": [[0,0],[1,0],[1,-1],[0,2],[1,2]],
    "2>1": [[0,0],[-1,0],[-1,1],[0,-2],[-1,-2]],
    "2>3": [[0,0],[1,0],[1,1],[0,-2],[1,-2]],
    "3>2": [[0,0],[-1,0],[-1,-1],[0,2],[-1,2]],
    "3>0": [[0,0],[-1,0],[-1,-1],[0,2],[-1,2]],
    "0>3": [[0,0],[1,0],[1,1],[0,-2],[1,-2]],
  };
  const K_I = {
    "0>1": [[0,0],[-2,0],[1,0],[-2,-1],[1,2]],
    "1>0": [[0,0],[2,0],[-1,0],[2,1],[-1,-2]],
    "1>2": [[0,0],[-1,0],[2,0],[-1,2],[2,-1]],
    "2>1": [[0,0],[1,0],[-2,0],[1,-2],[-2,1]],
    "2>3": [[0,0],[2,0],[-1,0],[2,1],[-1,-2]],
    "3>2": [[0,0],[-2,0],[1,0],[-2,-1],[1,2]],
    "3>0": [[0,0],[1,0],[-2,0],[1,-2],[-2,1]],
    "0>3": [[0,0],[-1,0],[2,0],[-1,2],[2,-1]],
  };

  // Gravity: seconds per row by level (classic curve), then 20G beyond.
  const GRAV = [null,1.0,0.793,0.618,0.473,0.355,0.262,0.190,0.135,0.094,0.064,0.043,0.028,0.018,0.011,0.007,0.005,0.003,0.002,0.0013,0.0008];
  const gravFor = (lvl) => GRAV[Math.min(lvl, 20)] ?? 0.0005;

  const SCORE = { 1: 100, 2: 300, 3: 500, 4: 800 };          // line clears * level
  const TSPIN = { 0: 400, 1: 800, 2: 1200, 3: 1600 };        // full t-spin * level
  const TSPIN_MINI = { 0: 100, 1: 200, 2: 400 };
  const PERFECT = { 1: 800, 2: 1200, 3: 1800, 4: 2000 };

  const MODES = {
    marathon: { name: "Marathon", goalLines: 150, time: 0 },
    sprint: { name: "Sprint", goalLines: 40, time: 0, startLevel: 1, timeMetric: true },
    ultra: { name: "Ultra", goalLines: 0, time: 120000 },
    cheese: { name: "Cheese", goalLines: 0, time: 0, garbage: 10, garbageHole: 1, timeMetric: true },
    master: { name: "Master", goalLines: 150, time: 0, startLevel: 20, lockLevel: true },
    daily: { name: "Daily", goalLines: 40, time: 0, seeded: true, timeMetric: true },
    zen: { name: "Zen", goalLines: 0, time: 0, zen: true },
  };

  const DEF_SETTINGS = { music: 0.5, sfx: 0.6, ghost: true, das: 133, arr: 33, sdf: 20, colorblind: false, patterns: false, reducedMotion: false, shake: true, irsIhs: true, haptics: false, master: 0.9, touchSens: 1, leftHanded: false };
  let settings = Object.assign({}, DEF_SETTINGS, Store.get("tessera.settings", {}));
  { const num = (v, d, lo, hi) => { v = +v; return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; }; // coerce/clamp persisted numerics
    settings.music = num(settings.music, DEF_SETTINGS.music, 0, 1); settings.sfx = num(settings.sfx, DEF_SETTINGS.sfx, 0, 1);
    settings.das = num(settings.das, DEF_SETTINGS.das, 30, 300); settings.arr = num(settings.arr, DEF_SETTINGS.arr, 0, 80); settings.sdf = num(settings.sdf, DEF_SETTINGS.sdf, 5, 40); settings.master = num(settings.master, DEF_SETTINGS.master, 0, 1); settings.touchSens = num(settings.touchSens, DEF_SETTINGS.touchSens, 0.5, 2); }

  // Honor the OS "reduce motion" preference the first time (user can still override in Settings).
  try {
    const rm = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)");
    if (rm && rm.matches && Store.get("tessera.settings", null) === null) settings.reducedMotion = true;
  } catch {}

  const palette = () => (settings.colorblind ? CB : COLORS);
  // Reduced-motion is the single source of truth for "no shake / no particles / instant clears".
  const motionOK = () => !settings.reducedMotion;
  // Haptics: brief vibration on lock / line-clear / level-up; gated by `haptics` + reduced-motion. No-op without navigator.vibrate.
  const haptic = (ms) => { if (!settings.haptics || !motionOK()) return; try { if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(ms); } catch {} };
  // Reflect a11y flags onto <html> so CSS can react (pattern legend, animation gating).
  const applyA11y = () => {
    const r = document.documentElement;
    r.classList.toggle("rm", !!settings.reducedMotion);
    r.classList.toggle("cb", !!settings.colorblind);
    r.classList.toggle("pat", !!settings.patterns);
    r.classList.toggle("lefthand", !!settings.leftHanded);
  };

  // Distinct per-piece glyph drawn on each cell when "patterns" is on. Shape-coded
  // so the 7 pieces are separable without relying on hue (colorblind aid).
  // type: how to stroke the path inside the cell; each is visually unique.
  const GLYPH = {
    I: "bars",      // vertical bars
    O: "ring",      // hollow square
    T: "tri",       // triangle (point up)
    S: "slashF",    // forward diagonal
    Z: "slashB",    // back diagonal
    J: "dot",       // center dot
    L: "corner",    // L-corner notch
    G: null,
  };
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);
  const fmtTime = (ms) => { const t = Math.max(0, ms) / 1000; const m = Math.floor(t / 60); const s = Math.floor(t % 60); return `${m}:${String(s).padStart(2, "0")}`; };

  // ============================================================ Audio
  const Audio2 = (() => {
    let ctx = null, master = null, musicGain = null, sfxGain = null, musicTimer = null, step = 0, muted = false;
    const ensure = () => {
      if (ctx) return;
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain(); master.gain.value = (settings.master != null ? settings.master : 0.9);
      const lim = ctx.createDynamicsCompressor(); lim.threshold.value = -3; lim.ratio.value = 20; lim.attack.value = 0.003; lim.release.value = 0.1;
      master.connect(lim); lim.connect(ctx.destination);
      musicGain = ctx.createGain(); musicGain.gain.value = settings.music; musicGain.connect(master);
      sfxGain = ctx.createGain(); sfxGain.gain.value = settings.sfx; sfxGain.connect(master);
      // Dynamic-music layer buses — all under musicGain so the Music slider governs them.
      gShimmer = ctx.createGain(); gShimmer.gain.value = 0; gShimmer.connect(musicGain);
      gPad     = ctx.createGain(); gPad.gain.value     = 0; gPad.connect(musicGain);
      gDrone   = ctx.createGain(); gDrone.gain.value   = 0; gDrone.connect(musicGain);
      stingBus = ctx.createGain(); stingBus.gain.value = 0.9; stingBus.connect(musicGain);
    };
    const note = (freq, t, dur, type, gain, target) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.value = freq;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(gain, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(target); o.start(t); o.stop(t + dur + 0.02);
    };
    const noise = (t, dur, gain, target) => {
      const n = Math.floor(ctx.sampleRate * dur), buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
      const src = ctx.createBufferSource(); src.buffer = buf;
      const g = ctx.createGain(); g.gain.value = gain; src.connect(g); g.connect(target); src.start(t);
    };
    // Original loop: A-minor i-VI-III-VII arpeggio + bass. Not based on any existing tune.
    const NT = { A2:110,C3:130.8,E3:164.8,F3:174.6,G3:196,A3:220,C4:261.6,D4:293.7,E4:329.6,F4:349.2,G4:392,A4:440,B4:493.9,C5:523.3,E5:659.3 };
    const BASS = ["A2","A2","F3","F3","C3","C3","G3","G3"];
    const ARP = [
      ["A3","C4","E4","A4"],["A3","C4","E4","C5"],
      ["F3","A3","C4","F4"],["F3","A3","C4","A4"],
      ["C4","E4","G4","C5"],["C4","E4","G4","E5"],
      ["G3","B4","D4","G4"],["G3","B4","D4","B4"],
    ];
    // ---- Dynamic-music state ----
    let intensity = 0, danger = 0;
    let gShimmer = null, gPad = null, gDrone = null, stingBus = null;
    const setIntensity = (x) => { const v = Math.max(0, Math.min(1, x)); if (v === intensity) return; intensity = v; applyMix(); };
    const setDanger = (x) => { const v = Math.max(0, Math.min(1, x)); if (v === danger) return; danger = v; applyMix(); }; // skip per-frame AudioParam churn when unchanged
    const applyMix = () => {
      if (!ctx || !gShimmer) return;
      const t = ctx.currentTime, tau = 0.25;
      const duck = 1 - danger * 0.85;
      gShimmer.gain.setTargetAtTime(intensity * 0.9 * duck, t, tau);
      gPad.gain.setTargetAtTime(Math.max(0, intensity - 0.55) / 0.45 * 0.7 * duck, t, tau);
      gDrone.gain.setTargetAtTime(danger * 0.6, t, tau);
    };
    const stepDur = () => (0.30 - intensity * 0.09 - danger * 0.04);
    const scheduleStep = (t) => {
      const bar = Math.floor(step / 4) % 8;
      const beat = step % 4;
      note(NT[BASS[bar]] / 2 || 55, t, 0.22, "triangle", 0.5, musicGain);
      const arp = ARP[bar][beat];
      note(NT[arp], t, 0.15, "square", 0.17, musicGain);
      if (danger > 0.4) note(NT[arp] * 1.029, t, 0.10, "square", 0.06 * danger, musicGain);
      if (beat % 2 === 0) note(NT[arp] * 2, t, 0.09, "square", 0.12, gShimmer);
      if (beat === 0) note(NT[BASS[bar]] * 1.5, t, stepDur() * 4, "sine", 0.18, gPad);
      if (beat === 0) note((NT[BASS[bar]] / 2 || 55) * 1.4142, t, stepDur() * 4, "sawtooth", 0.2, gDrone);
      step++;
    };
    const LOOKAHEAD = 0.12;
    let nextStepTime = 0;
    const pump = () => {
      if (!ctx) return;
      if (muted) { if (nextStepTime < ctx.currentTime) nextStepTime = ctx.currentTime + 0.06; return; } // keep the clock current while muted
      if (nextStepTime < ctx.currentTime) nextStepTime = ctx.currentTime + 0.02; // guard against a past-dated backlog (resume / long stall)
      while (nextStepTime < ctx.currentTime + LOOKAHEAD) {
        scheduleStep(nextStepTime);
        nextStepTime += stepDur();
      }
    };
    const startMusic = () => {
      ensure();
      nextStepTime = ctx.currentTime + 0.06; // re-seed every start: no past-dated backlog regardless of entry path
      applyMix();
      if (musicTimer == null) { pump(); musicTimer = setInterval(pump, 25); }
    };
    const stopMusic = () => { if (musicTimer) { clearInterval(musicTimer); musicTimer = null; } };
    const sting = (kind) => {
      if (!ctx || muted || !stingBus) return;
      const barLen = stepDur() * 16;
      const stepsToBar = (16 - (step % 16)) % 16;
      const t0 = (nextStepTime || ctx.currentTime) + stepsToBar * stepDur();
      const seq = kind === "tspin"
        ? [[392,0],[523,0.12],[622,0.24],[784,0.36],[932,0.5]]
        : [[523,0],[659,0.1],[784,0.2],[1046,0.3],[784,0.46],[1046,0.6]];
      for (const [f, off] of seq) {
        note(f, t0 + off * (barLen / 0.7), 0.18, "triangle", 0.22, stingBus);
        note(f * 1.5, t0 + off * (barLen / 0.7), 0.16, "square", 0.08, stingBus);
      }
    };
    const sfx = (name) => {
      if (!ctx || muted) return;
      const t = ctx.currentTime;
      const g = sfxGain;
      switch (name) {
        case "move": note(330, t, 0.04, "square", 0.18, g); break;
        case "rotate": note(440, t, 0.05, "square", 0.18, g); break;
        case "soft": note(220, t, 0.03, "sine", 0.12, g); break;
        case "hard": noise(t, 0.07, 0.25, g); note(140, t, 0.09, "square", 0.2, g); break;
        case "lock": note(180, t, 0.06, "triangle", 0.2, g); break;
        case "hold": note(520, t, 0.06, "sine", 0.16, g); break;
        case "line1": note(523, t, 0.12, "square", 0.22, g); break;
        case "line2": note(523, t, 0.1, "square", 0.22, g); note(659, t + 0.06, 0.12, "square", 0.22, g); break;
        case "line3": [523,659,784].forEach((f,i)=>note(f,t+i*0.05,0.12,"square",0.22,g)); break;
        case "tetris": [523,659,784,1046].forEach((f,i)=>note(f,t+i*0.05,0.16,"square",0.26,g)); break;
        case "tspin": [392,523,659,880].forEach((f,i)=>note(f,t+i*0.04,0.16,"sawtooth",0.2,g)); break;
        case "level": [440,554,659,880].forEach((f,i)=>note(f,t+i*0.06,0.18,"triangle",0.24,g)); break;
        case "over": [440,392,330,262,196].forEach((f,i)=>note(f,t+i*0.12,0.22,"sawtooth",0.22,g)); break;
        case "cd": note(660, t, 0.1, "square", 0.22, g); break;
        case "go": [523,784].forEach((f,i)=>note(f,t+i*0.08,0.18,"square",0.26,g)); break;
      }
    };
    const setMute = (m) => { muted = m; if (m) stopMusic(); };
    const setVol = () => { if (master) master.gain.value = settings.master; if (musicGain) musicGain.gain.value = settings.music; if (sfxGain) sfxGain.gain.value = settings.sfx; };
    const resume = () => { try { ctx && ctx.resume(); } catch {} };
    return { startMusic, stopMusic, sfx, setIntensity, setDanger, sting, setMute, setVol, resume, ensure };
  })();

  // ============================================================ Piece helpers
  const rotateCW = (m) => {
    const n = m.length, r = m.map((row) => row.slice());
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) r[j][n - 1 - i] = m[i][j];
    return r;
  };
  // Precompute 4 rotation states (cell coords) for each piece.
  const STATES = {};
  for (const k of ORDER) {
    let m = SHAPES[k].map((r) => r.slice());
    const states = [];
    const count = (k === "O") ? 1 : 4;
    for (let s = 0; s < count; s++) {
      const cells = [];
      for (let i = 0; i < m.length; i++) for (let j = 0; j < m[i].length; j++) if (m[i][j]) cells.push([i, j]);
      states.push(cells);
      m = rotateCW(m);
    }
    STATES[k] = states;
  }
  const spawnFor = (k) => ({ k, rot: 0, x: (k === "I" || k === "O") ? 3 : 3, y: 0 });
  const cellsOf = (p) => STATES[p.k][p.k === "O" ? 0 : p.rot].map(([r, c]) => [p.y + r, p.x + c]);

  // Finesse heuristic: minimum directional+rotation inputs to place a piece at its
  // final (column, rotation) from spawn. Reported as a "fault" counter, not exact.
  const finesseMin = (p) => {
    if (!p) return 0;
    const rotCost = (p.k === "O" || p.rot === 0) ? 0 : 1;
    const cells = STATES[p.k][p.k === "O" ? 0 : p.rot];
    let minC = 9, maxC = 0;
    for (const [, c] of cells) { if (c < minC) minC = c; if (c > maxC) maxC = c; }
    const leftCol = p.x + minC;
    const rightCol = p.x + maxC;
    const spawnLeft = 3 + minC;
    let horiz;
    if (leftCol === 0 || rightCol === COLS - 1) horiz = (leftCol === spawnLeft) ? 0 : 1;
    else horiz = Math.abs(leftCol - spawnLeft);
    return rotCost + horiz;
  };

  // ============================================================ RNG (seeded bag)
  // Deterministic PRNG (mulberry32): a fixed 32-bit seed always yields the same
  // stream -> reproducible piece order. Used for the 7-bag and garbage gaps.
  const mulberry32 = (seed) => {
    let a = seed >>> 0;
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  // Fresh per-game 32-bit seed. Prefer crypto; fall back for sandboxed iframes.
  const resolveSeed = () => {
    try {
      const a = new Uint32Array(1);
      (window.crypto || window.msCrypto).getRandomValues(a);
      return a[0] >>> 0;
    } catch { return ((Math.random() * 2 ** 32) ^ Date.now()) >>> 0; }
  };
  // Daily seed: stable per UTC day so every player gets the same Daily sequence.
  const dailySeed = (d = new Date()) => {
    const key = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
    let h = 2166136261 >>> 0;
    for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  };
  // Daily challenge: one seeded run per UTC day, with an "already played" record + shareable result.
  const Daily = {
    key: (d = new Date()) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`,
    get: () => Store.get("tessera.daily", null),
    record: (g) => Store.set("tessera.daily", { key: g.dailyKey || Daily.key(), won: !!g.won, lines: g.lines, time: g.elapsed, score: g.score, seed: g.seed >>> 0 }),
    playedToday: () => { const r = Daily.get(); return (r && r.key === Daily.key()) ? r : null; },
    share: (g) => `Tessera Daily ${g.dailyKey || Daily.key()} — ${g.won ? `${g.lines}L in ${fmtTime(g.elapsed)}` : `${g.lines}L (DNF)`} · seed ${(g.seed >>> 0)}`,
  };

  // ============================================================ Bag
  const newBag = (rng = Math.random) => { const b = ORDER.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

  // ============================================================ Game
  class Game {
    constructor(mode) {
      this.mode = mode; this.cfg = MODES[mode];
      // Seeded RNG: Daily derives a per-day seed; everything else gets a fresh seed.
      // Must exist BEFORE the bag is filled so no piece comes from Math.random.
      const _now = new Date();
      this.seed = this.cfg.seeded ? dailySeed(_now) : resolveSeed();
      if (this.cfg.seeded) this.dailyKey = Daily.key(_now); // pin the day at start so a midnight-UTC crossing doesn't mislabel the run
      this.rng = mulberry32(this.seed);
      this.grid = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
      this.bag = []; this.queue = [];
      for (let i = 0; i < 7; i++) this.refillQueue();
      this.hold = null; this.holdUsed = false;
      this.startLevel = this.cfg.startLevel || 1;
      this.score = 0; this.lines = 0; this.level = this.startLevel; this.combo = -1; this.b2b = false;
      this.over = false; this.won = false; this.paused = false; this.pendingWin = false;
      this.softDropping = false; this.lastKick = null; this.lastWasRotate = false;
      this.lockTimer = 0; this.lockResets = 0; this.onGround = false;
      this.gravAccum = 0; this.clearing = null; this.clearTimer = 0;
      this.elapsed = 0; this.dropDist = 0;
      this.garbageLeft = 0;
      this.particles = [];
      this.stats = {
        pieces: 0, tetris: 0, tspins: 0, maxCombo: 0,
        single: 0, double: 0, triple: 0,
        tsMini: 0, tsSingle: 0, tsDouble: 0, tsTriple: 0,
        inputs: 0, finesseFaults: 0,
      };
      if (this.cfg.garbage) this.fillGarbage(this.cfg.garbage); // build the dig stack before the first piece
      this.spawn();
    }
    // Push `n` garbage rows up from the bottom, each solid "G" with one drifting gap.
    fillGarbage(n) {
      let hole = Math.floor(this.rng() * COLS);
      for (let i = 0; i < n; i++) {
        if (this.rng() < 0.65) { hole = (hole + 1 + Math.floor(this.rng() * (COLS - 1))) % COLS; }
        const row = Array.from({ length: COLS }, (_, c) => (c === hole ? null : "G"));
        this.grid.shift(); this.grid.push(row);
        this.garbageLeft++;
      }
    }
    refillQueue() { if (this.bag.length === 0) this.bag = newBag(this.rng); this.queue.push(this.bag.shift()); }
    spawn(fromHold) {
      if (!fromHold) { this.cur = spawnFor(this.queue.shift()); this.refillQueue(); }
      this.holdUsed = fromHold ? this.holdUsed : false;
      this.onGround = false; this.lockTimer = 0; this.lockResets = 0; this.lastWasRotate = false; this.gravAccum = 0; this.softDropping = false;
      this.stats.inputs = 0; // finesse: new piece, fresh input budget
      this.stats.pieces++;
      if (this.collides(this.cur)) { this.endGame(false); this.cur = null; return; }
      if (typeof Input !== "undefined" && Input.onSpawn) Input.onSpawn(this, fromHold); // IRS/IHS + held soft-drop re-arm
    }
    collides(p) {
      for (const [r, c] of cellsOf(p)) {
        if (c < 0 || c >= COLS || r >= ROWS) return true;
        if (r >= 0 && this.grid[r][c]) return true;
      }
      return false;
    }
    move(dx, dy) {
      const np = { ...this.cur, x: this.cur.x + dx, y: this.cur.y + dy };
      if (this.collides(np)) return false;
      this.cur = np; this.lastKick = null; if (dx !== 0) this.lastWasRotate = false; // translation invalidates prior kick; keep rotate-flag on vertical drops
      if (dx !== 0) this.stats.inputs++; // finesse: count horizontal moves (gravity uses dx=0)
      if (dx !== 0 && this.onGround) this.resetLock();
      return true;
    }
    rotate(dir) {
      if (this.cur.k === "O") return false;
      const from = this.cur.rot, to = (from + (dir > 0 ? 1 : 3)) % 4;
      const table = this.cur.k === "I" ? K_I : K_JLSTZ;
      const kicks = table[`${from}>${to}`] || [[0, 0]];
      for (const [kx, ky] of kicks) {
        const np = { ...this.cur, rot: to, x: this.cur.x + kx, y: this.cur.y - ky };
        if (!this.collides(np)) {
          this.cur = np; this.lastWasRotate = true; this.lastKick = [kx, ky];
          this.stats.inputs++; // finesse: count rotation
          if (this.onGround) this.resetLock();
          Audio2.sfx("rotate");
          return true;
        }
      }
      return false;
    }
    rotate180() {
      for (const [kx, ky] of [[0,0],[0,-1],[0,1],[1,0],[-1,0]]) {
        const np = { ...this.cur, rot: (this.cur.rot + 2) % 4, x: this.cur.x + kx, y: this.cur.y + ky };
        if (!this.collides(np)) { this.cur = np; this.lastWasRotate = true; this.lastKick = [kx, ky]; this.stats.inputs++; if (this.onGround) this.resetLock(); Audio2.sfx("rotate"); return true; }
      }
      return false;
    }
    resetLock() { if (this.lockResets < MAX_RESETS) { this.lockTimer = 0; this.lockResets++; } }
    ghost() {
      let p = { ...this.cur };
      while (!this.collides({ ...p, y: p.y + 1 })) p.y++;
      return p;
    }
    hardDrop() {
      let d = 0; while (this.move(0, 1)) d++;
      this.score += d * 2; this.dropDist = 0;
      Audio2.sfx("hard");
      this.lockPiece();
    }
    holdPiece() {
      if (this.holdUsed) return;
      const curK = this.cur.k;
      const fromQueue = this.hold == null;
      const incoming = spawnFor(fromQueue ? this.queue[0] : this.hold);
      // Test-spawn BEFORE committing: a hold that would top out must not corrupt hold/queue.
      if (this.collides(incoming)) { this.endGame(false); return; }
      Audio2.sfx("hold");
      this.hold = curK;
      if (fromQueue) { this.queue.shift(); this.refillQueue(); }
      this.cur = incoming;
      this.holdUsed = true; this.onGround = false; this.lockTimer = 0; this.lockResets = 0; this.lastWasRotate = false; this.gravAccum = 0; this.softDropping = false;
      this.stats.inputs = 0; // finesse: held piece gets a fresh input budget
    }
    isTSpin() {
      if (this.cur.k !== "T" || !this.lastWasRotate) return 0;
      const cx = this.cur.x + 1, cy = this.cur.y + 1; // T center
      const corners = [[cy-1,cx-1],[cy-1,cx+1],[cy+1,cx-1],[cy+1,cx+1]];
      const filled = corners.map(([r, c]) => (c < 0 || c >= COLS || r >= ROWS || (r >= 0 && this.grid[r][c])) ? 1 : 0);
      const sum = filled[0] + filled[1] + filled[2] + filled[3];
      if (sum < 3) return 0;
      // front corners depend on rotation; mini if only one front corner filled
      const front = { 0: [0, 1], 1: [1, 3], 2: [2, 3], 3: [0, 2] }[this.cur.rot];
      const frontFilled = filled[front[0]] + filled[front[1]];
      if (frontFilled === 2) return 2; // full T-spin
      if (this.lastKick && Math.abs(this.lastKick[1]) === 2) return 2; // big-kick promotion (TST / T-spin triple)
      return 1; // mini
    }
    lockPiece() {
      const tspin = this.isTSpin();
      const cells = cellsOf(this.cur);
      const lockOut = cells.every(([r]) => r < 0); // locked entirely above the field
      if (this.stats.inputs > finesseMin(this.cur)) this.stats.finesseFaults++; // finesse fault, before this.cur is cleared
      for (const [r, c] of cells) { if (r >= 0) this.grid[r][c] = this.cur.k; }
      this.cur = null; // freeze input/gravity during clear/spawn
      if (lockOut) { this.endGame(false); return; } // lock-out before any scoring: no phantom line credit
      this.lockElapsed = this.elapsed; // true finish time, captured before clear-animation accrues
      Audio2.sfx("lock"); haptic(12);
      const full = [];
      for (let r = 0; r < ROWS; r++) if (this.grid[r].every((c) => c)) full.push(r);
      this.scoreClear(full, tspin);
      const goalMet = this.cfg.goalLines && this.lines >= this.cfg.goalLines;
      if (goalMet && !full.length) { this.endGame(true); return; } // goal reached with no clear: end now
      if (full.length) {
        if (goalMet) this.pendingWin = true; // let the win clear play out, then end in finishClear
        // Reduced-motion: skip the line-flash dwell + particles so the field settles instantly.
        this.clearing = full; this.clearTimer = motionOK() ? CLEAR_ANIM : 0;
        if (motionOK()) for (const r of full) this.spawnParticles(r);
        Audio2.sfx(full.length >= 4 ? "tetris" : tspin === 2 ? "tspin" : "line" + Math.min(full.length, 3));
        haptic(full.length >= 4 ? [8, 30, 46] : 22);
        if (full.length >= 4) Audio2.sting("tetris"); else if (tspin === 2) Audio2.sting("tspin");
        if (settings.shake && motionOK() && (full.length >= 4 || tspin === 2)) this.doShake();
      } else {
        this.combo = -1;
        this.afterLock();
      }
    }
    scoreClear(full, tspin) {
      const n = full.length;
      const lvl = this.level;
      let pts = 0, label = "", difficult = false;
      if (tspin === 2) { pts = TSPIN[n] * lvl; label = ["T-SPIN","T-SPIN SINGLE","T-SPIN DOUBLE","T-SPIN TRIPLE"][n]; difficult = n > 0; this.stats.tspins++; if (n === 1) this.stats.tsSingle++; else if (n === 2) this.stats.tsDouble++; else if (n === 3) this.stats.tsTriple++; }
      else if (tspin === 1) { pts = (TSPIN_MINI[n] || 100) * lvl; label = n === 1 ? "T-SPIN MINI SINGLE" : n === 2 ? "T-SPIN MINI DOUBLE" : "T-SPIN MINI"; difficult = n > 0; this.stats.tspins++; this.stats.tsMini++; }
      else if (n > 0) { pts = SCORE[n] * lvl; label = ["","SINGLE","DOUBLE","TRIPLE","TETRIS"][n]; difficult = n === 4; if (n === 1) this.stats.single++; else if (n === 2) this.stats.double++; else if (n === 3) this.stats.triple++; else if (n === 4) this.stats.tetris++; }
      if (n > 0) {
        // perfect clear (compute first; a PC is itself B2B-eligible)
        const willClear = this.grid.map((row, r) => full.includes(r) ? Array(COLS).fill(null) : row);
        const perfect = willClear.every((row) => row.every((c) => !c));
        const b2bEligible = difficult || perfect;
        if (b2bEligible && this.b2b) { pts = Math.floor(pts * 1.5); label = "B2B " + label; }
        this.b2b = b2bEligible; // PC or difficult sustains/starts the chain; a plain clear breaks it
        this.combo++;
        if (this.combo > 0) { pts += 50 * this.combo * lvl; this.stats.maxCombo = Math.max(this.stats.maxCombo, this.combo); }
        if (perfect) { pts += (PERFECT[n] || 1000) * lvl; label = "PERFECT " + label; }
        this.score += pts;
        this.lines += n;
        this.popup(label, "+" + pts, (perfect || n >= 4 || tspin === 2) ? "var(--gold)" : "var(--cyan)");
        this.checkLevel();
      } else if (tspin) {
        pts = (tspin === 2 ? TSPIN[0] : TSPIN_MINI[0]) * lvl; this.score += pts;
        this.popup(tspin === 2 ? "T-SPIN" : "T-SPIN MINI", "+" + pts, "var(--violet)");
      }
    }
    checkLevel() {
      if (this.cfg.zen || this.cfg.lockLevel) return;
      const newLvl = Math.min(20, this.startLevel + Math.floor(this.lines / 10));
      if (newLvl > this.level) { this.level = newLvl; Audio2.sfx("level"); haptic([10, 40, 10]); Audio2.setIntensity((this.level - 1) / 19); this.popup("LEVEL " + this.level, "", "var(--green)"); }
    }
    afterLock() {
      this.cur = null;
      // brief entry delay possible; spawn immediately (ARE=0)
      if (!this.over) this.spawn();
    }
    finishClear() {
      const rows = this.clearing.sort((a, b) => a - b);
      let clearedGarbage = 0;
      for (const r of rows) if (this.grid[r].some((c) => c === "G")) clearedGarbage++;
      for (const r of rows) { this.grid.splice(r, 1); this.grid.unshift(Array(COLS).fill(null)); }
      this.clearing = null;
      if (this.cfg.garbage && clearedGarbage) {
        this.garbageLeft = Math.max(0, this.garbageLeft - clearedGarbage);
        if (this.garbageLeft <= 0) { if (this.lockElapsed != null) this.elapsed = this.lockElapsed; this.endGame(true); return; } // all garbage dug -> win
      }
      if (this.pendingWin) { this.pendingWin = false; if (this.lockElapsed != null) this.elapsed = this.lockElapsed; this.endGame(true); return; } // goal-line win, after the clear played
      this.afterLock();
    }
    spawnParticles(r) {
      const pal = palette();
      for (let c = 0; c < COLS; c++) {
        const k = this.grid[r][c] || "I"; const col = pal[k] ? pal[k][2] : "#fff";
        for (let i = 0; i < 3; i++) this.particles.push({ x: (c + 0.5) * CELL, y: (r + 0.5) * CELL, vx: (Math.random() - 0.5) * 4, vy: (Math.random() - 1.5) * 4, life: 1, col });
      }
    }
    doShake() { const b = $("#board"); b.classList.remove("shake"); void b.offsetWidth; b.classList.add("shake"); }
    popup(big, sm, col) {
      const el = document.createElement("div"); el.className = "popup"; el.style.color = col || "var(--cyan)";
      el.innerHTML = `<div class="big">${big}</div>${sm ? `<div class="sm">${sm}</div>` : ""}`;
      $("#popups").appendChild(el); setTimeout(() => el.remove(), 950);
    }
    endGame(won) {
      if (this.over) return;
      this.over = true; this.won = won;
      Audio2.sfx(won ? "go" : "over"); Audio2.stopMusic();
      UI.gameOver(this);
    }
    update(dt) {
      if (this.paused || this.over) return;
      // Danger feed: ramp over the top 6 rows so the music turns ominous before top-out.
      let topFilled = ROWS;
      for (let r = 0; r < ROWS; r++) { if (this.grid[r].some((c) => c)) { topFilled = r; break; } }
      const DANGER_ROWS = 6;
      Audio2.setDanger(Math.max(0, Math.min(1, (DANGER_ROWS - topFilled) / DANGER_ROWS)));
      this.elapsed += dt;
      if (this.cfg.time && this.elapsed >= this.cfg.time) { this.endGame(true); return; }
      if (this.clearing) { this.clearTimer -= dt; if (this.clearTimer <= 0) this.finishClear(); this.updateParticles(dt); return; }
      this.updateParticles(dt);
      if (!this.cur) return;
      // gravity
      const baseG = gravFor(this.level);
      // Soft drop only earns points when it is FASTER than natural gravity; at 20G it
      // isn't, so passive gravity steps must not pay per-row soft-drop points.
      const softActive = this.softDropping && (1 / settings.sdf) < baseG;
      const g = softActive ? (1 / settings.sdf) : baseG;
      this.gravAccum += dt / 1000;
      let stepped = false, guard = 0;
      while (this.gravAccum >= g && guard++ < ROWS) {
        this.gravAccum -= g;
        if (this.move(0, 1)) { stepped = true; if (softActive) this.score += 1; }
        else { this.gravAccum = 0; break; }
      }
      if (guard >= ROWS) this.gravAccum = 0; // drained the budget this tick; don't carry over
      // ground / lock delay
      const grounded = this.collides({ ...this.cur, y: this.cur.y + 1 });
      if (grounded) {
        if (!this.onGround) { this.onGround = true; this.lockTimer = 0; } // touchdown starts the timer; the 15-reset budget is spent only by move/rotate
        this.lockTimer += dt;
        if (this.lockTimer >= LOCK_DELAY) { this.lockPiece(); return; }
      } else { this.onGround = false; this.lockTimer = 0; }
    }
    updateParticles(dt) {
      const f = dt / 16.7;
      for (const p of this.particles) { p.x += p.vx * f; p.y += p.vy * f; p.vy += 0.25 * f; p.life -= 0.03 * f; }
      this.particles = this.particles.filter((p) => p.life > 0);
    }
  }

  // ============================================================ Render
  const board = $("#board"), bctx = board.getContext("2d");
  const holdC = $("#hold"), hctx = holdC.getContext("2d");
  const nextC = $("#next"), nctx = nextC.getContext("2d");

  // ---- Responsive sizing: fit the playfield + rails inside the panel ----
  // Picks the largest integer CELL such that the board (plus the two rails, gaps
  // and padding) fits the viewport, then rescales the board + mini canvases.
  // Backing store == CSS size (1:1), so every existing `board.width`-based read
  // keeps working unchanged. Re-runs on resize (coalesced via rAF).
  // Game state must be declared before layout() runs (layout reads `game`) — avoids a load-time TDZ ReferenceError.
  let game = null, raf = null, last = 0, acc = 0;
  let layoutRAF = 0;
  function layout() {
    // Portrait/narrow viewports restack the rails into a top strip (+ a bottom touch
    // bar on coarse pointers) so the board takes the full width. Desktop/landscape is
    // byte-identical to before.
    const availW = window.innerWidth, availH = window.innerHeight;
    const coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
    const portrait = availW <= 560 || (availH > availW && availW < 720);
    let wForBoard, hForBoard;
    if (portrait) {
      const cs = getComputedStyle(document.documentElement);
      const px = (name, def) => { const v = parseFloat(cs.getPropertyValue(name)); return Number.isFinite(v) ? v : def; };
      const stripH = px("--portrait-strip-h", 96);
      const touchbarH = coarse ? px("--touchbar-h", 72) : 0;
      const padP = 8;
      wForBoard = Math.min(availW - padP * 2, availW * 0.92);
      hForBoard = availH - stripH - touchbarH - padP * 2;
    } else {
      const railW = 150, gap = 18, pad = 18;     // landscape sizing (unchanged)
      wForBoard = availW - railW * 2 - gap * 2 - pad * 2;
      hForBoard = availH - pad * 2;
    }
    let cell = Math.floor(Math.min(wForBoard / COLS, hForBoard / ROWS));
    cell = Math.max(14, Math.min(40, Number.isFinite(cell) && cell > 0 ? cell : 30)); // clamp sane
    CELL = cell; MINI = Math.round(cell * 0.72); NEXTSZ = Math.round(cell * 0.66);
    board.width = COLS * CELL; board.height = ROWS * CELL;
    holdC.width = MINI * 4 + 8; holdC.height = MINI * 3 + 16;
    nextC.width = MINI * 4 + 8; nextC.height = (NEXTSZ * 2 + 10) * 5;
    if (game) render(game);
  }
  window.addEventListener("resize", () => { cancelAnimationFrame(layoutRAF); layoutRAF = requestAnimationFrame(layout); });
  window.addEventListener("orientationchange", () => { cancelAnimationFrame(layoutRAF); layoutRAF = requestAnimationFrame(() => { layout(); requestAnimationFrame(layout); }); });
  layout(); // establish initial responsive size (replaces the old fixed board.width/height)

  const drawCell = (ctx, x, y, size, k, opts = {}) => {
    const pal = palette(); const col = pal[k] || ["#888", "#aaa", "#ccc"];
    const pad = 1; const r = 4;
    ctx.save();
    if (opts.ghost) { ctx.globalAlpha = 0.22; }
    if (opts.glow) { ctx.shadowColor = col[2]; ctx.shadowBlur = 12; } // glow under the body fill
    const grad = ctx.createLinearGradient(x, y, x, y + size);
    grad.addColorStop(0, col[1]); grad.addColorStop(1, col[0]);
    ctx.fillStyle = grad;
    roundRect(ctx, x + pad, y + pad, size - pad * 2, size - pad * 2, r); ctx.fill();
    ctx.shadowBlur = 0; ctx.shadowColor = "transparent"; // bevel/glyph must not inherit the glow
    // bevel highlight
    ctx.globalAlpha = (opts.ghost ? 0.1 : 0.5);
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    roundRect(ctx, x + pad + 2, y + pad + 2, size - pad * 2 - 4, (size - pad * 2) * 0.32, r - 1); ctx.fill();
    // Colorblind pattern: stamp a per-piece glyph so pieces are separable by shape.
    if (settings.patterns && GLYPH[k]) {
      ctx.globalAlpha = opts.ghost ? 0.35 : 0.9;
      drawGlyph(ctx, x + pad, y + pad, size - pad * 2, k);
    }
    ctx.restore();
  };
  // Crisp, hue-independent glyph per piece. Drawn in cell-local coords (x,y,size).
  const drawGlyph = (ctx, x, y, s, k) => {
    const type = GLYPH[k];
    const lw = Math.max(1.5, s * 0.12);
    ctx.lineWidth = lw; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.fillStyle = "rgba(0,0,0,0.5)";
    const m = s * 0.26;                 // inset margin
    const x0 = x + m, y0 = y + m, x1 = x + s - m, y1 = y + s - m, cx = x + s / 2, cy = y + s / 2;
    ctx.beginPath();
    switch (type) {
      case "bars": // I — two vertical bars
        ctx.moveTo(x + s * 0.38, y0); ctx.lineTo(x + s * 0.38, y1);
        ctx.moveTo(x + s * 0.62, y0); ctx.lineTo(x + s * 0.62, y1); ctx.stroke(); break;
      case "ring": // O — hollow square
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0); break;
      case "tri": // T — triangle, point up
        ctx.moveTo(cx, y0); ctx.lineTo(x1, y1); ctx.lineTo(x0, y1); ctx.closePath(); ctx.stroke(); break;
      case "slashF": // S — forward diagonal
        ctx.moveTo(x0, y1); ctx.lineTo(x1, y0); ctx.stroke(); break;
      case "slashB": // Z — back diagonal
        ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); break;
      case "dot": // J — center dot
        ctx.arc(cx, cy, s * 0.17, 0, Math.PI * 2); ctx.fill(); break;
      case "corner": // L — corner notch
        ctx.moveTo(x0, y0); ctx.lineTo(x0, y1); ctx.lineTo(x1, y1); ctx.stroke(); break;
    }
  };
  const roundRect = (ctx, x, y, w, h, r) => {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  };

  const renderBoard = (g) => {
    bctx.clearRect(0, 0, board.width, board.height);
    // grid
    bctx.strokeStyle = "rgba(255,255,255,0.04)"; bctx.lineWidth = 1;
    for (let c = 1; c < COLS; c++) { bctx.beginPath(); bctx.moveTo(c * CELL, 0); bctx.lineTo(c * CELL, board.height); bctx.stroke(); }
    for (let r = 1; r < ROWS; r++) { bctx.beginPath(); bctx.moveTo(0, r * CELL); bctx.lineTo(board.width, r * CELL); bctx.stroke(); }
    // locked
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (g.grid[r][c]) {
      const flash = g.clearing && g.clearing.includes(r);
      drawCell(bctx, c * CELL, r * CELL, CELL, g.grid[r][c]);
      if (flash) { bctx.fillStyle = `rgba(255,255,255,${0.3 + 0.5 * (g.clearTimer / CLEAR_ANIM)})`; bctx.fillRect(c * CELL, r * CELL, CELL, CELL); }
    }
    if (g.cur && !g.clearing) {
      if (settings.ghost) for (const [r, c] of cellsOf(g.ghost())) if (r >= 0) drawCell(bctx, c * CELL, r * CELL, CELL, g.cur.k, { ghost: true });
      for (const [r, c] of cellsOf(g.cur)) if (r >= 0) drawCell(bctx, c * CELL, r * CELL, CELL, g.cur.k, { glow: true });
    }
    // particles
    for (const p of g.particles) { bctx.globalAlpha = Math.max(0, p.life); bctx.fillStyle = p.col; bctx.fillRect(p.x - 2, p.y - 2, 4, 4); }
    bctx.globalAlpha = 1;
  };
  const renderMini = (ctx, cvs, k, n) => {
    ctx.clearRect(0, 0, cvs.width, cvs.height);
    if (!k) return;
    const cells = STATES[k][0]; const sz = MINI;
    let minC = 9, maxC = 0, minR = 9, maxR = 0;
    for (const [r, c] of cells) { minC = Math.min(minC, c); maxC = Math.max(maxC, c); minR = Math.min(minR, r); maxR = Math.max(maxR, r); }
    const w = (maxC - minC + 1) * sz, h = (maxR - minR + 1) * sz;
    const ox = (cvs.width - w) / 2, oy = (n != null ? 8 : (cvs.height - h) / 2);
    for (const [r, c] of cells) drawCell(ctx, ox + (c - minC) * sz, oy + (r - minR) * sz, sz, k);
  };
  const renderNext = (g) => {
    nctx.clearRect(0, 0, nextC.width, nextC.height);
    const sz = NEXTSZ; const slotH = nextC.height / 5;
    for (let i = 0; i < 5; i++) {
      const k = g.queue[i]; if (!k) continue;
      const cells = STATES[k][0];
      let minC = 9, maxC = 0, minR = 9, maxR = 0;
      for (const [r, c] of cells) { minC = Math.min(minC, c); maxC = Math.max(maxC, c); minR = Math.min(minR, r); maxR = Math.max(maxR, r); }
      const w = (maxC - minC + 1) * sz, h = (maxR - minR + 1) * sz;
      const ox = (nextC.width - w) / 2, oy = i * slotH + (slotH - h) / 2;
      for (const [r, c] of cells) drawCell(nctx, ox + (c - minC) * sz, oy + (r - minR) * sz, sz, k);
    }
  };
  const renderHUD = (g) => {
    $("#score").textContent = g.score.toLocaleString();
    $("#lines").textContent = g.cfg.goalLines ? `${g.lines}/${g.cfg.goalLines}` : g.lines;
    $("#level").textContent = g.level;
    if (g.cfg.time) { $("#clock-k").textContent = "Time left"; $("#clock").textContent = fmtTime(g.cfg.time - g.elapsed); }
    else { $("#clock-k").textContent = "Time"; $("#clock").textContent = fmtTime(g.elapsed); }
    const b2b = $("#b2b"), combo = $("#combo");
    b2b.hidden = !g.b2b; combo.hidden = g.combo < 1; combo.textContent = `COMBO ×${g.combo}`;
    renderStatsPanel(g);
  };
  let _sxEls = null;
  const renderStatsPanel = (g) => {
    if (!_sxEls) _sxEls = { pps: $("#sx-pps"), single: $("#sx-single"), double: $("#sx-double"), triple: $("#sx-triple"), tetris: $("#sx-tetris"), ts: $("#sx-ts"), fin: $("#sx-fin") }; // cache static lookups (called every frame)
    const s = g.stats; const secs = g.elapsed / 1000;
    if (_sxEls.pps) _sxEls.pps.textContent = secs > 0 ? (s.pieces / secs).toFixed(2) : "0.00";
    if (_sxEls.single) _sxEls.single.textContent = s.single;
    if (_sxEls.double) _sxEls.double.textContent = s.double;
    if (_sxEls.triple) _sxEls.triple.textContent = s.triple;
    if (_sxEls.tetris) _sxEls.tetris.textContent = s.tetris;
    if (_sxEls.ts) _sxEls.ts.textContent = `${s.tsMini}/${s.tsSingle}/${s.tsDouble}/${s.tsTriple}`;
    if (_sxEls.fin) _sxEls.fin.textContent = s.finesseFaults;
  };
  const render = (g) => { renderBoard(g); renderMini(hctx, holdC, g.hold); renderNext(g); renderHUD(g); };

  // ============================================================ Input
  const Input = (() => {
    // Rebindable keymap keyed by event.code (layout-independent). settings.keys overrides defaults.
    const ACTIONS = ["left","right","softDrop","hardDrop","rotateCW","rotateCCW","rotate180","hold","pause","restart","mute"];
    const ACTION_LABEL = { left:"Move left", right:"Move right", softDrop:"Soft drop", hardDrop:"Hard drop", rotateCW:"Rotate CW", rotateCCW:"Rotate CCW", rotate180:"Rotate 180°", hold:"Hold", pause:"Pause", restart:"Restart", mute:"Mute" };
    const DEF_KEYS = {
      left:["ArrowLeft"], right:["ArrowRight"], softDrop:["ArrowDown"], hardDrop:["Space"],
      rotateCW:["ArrowUp","KeyX"], rotateCCW:["KeyZ","ControlLeft","ControlRight"], rotate180:["KeyA"],
      hold:["KeyC","ShiftLeft","ShiftRight"], pause:["Escape","KeyP"], restart:["KeyR"], mute:["KeyM"],
    };
    let CODE2ACTION = {};
    const rebuildMap = () => {
      CODE2ACTION = {};
      const km = (settings.keys && typeof settings.keys === "object") ? settings.keys : {};
      for (const a of ACTIONS) { const codes = (km[a] && km[a].length) ? km[a] : DEF_KEYS[a]; for (const code of (codes || [])) CODE2ACTION[code] = a; } // per-action fallback so old saves don't unbind
    };
    rebuildMap();

    const heldAct = {}; // actions currently physically held (drives IRS/IHS)
    const handle = (e, down) => {
      const action = CODE2ACTION[e.code];
      if (action) { if (down) heldAct[action] = true; else delete heldAct[action]; } // track even at title/over so keyup always clears (no phantom IRS next game)
      const ae = document.activeElement;
      const overlayTyping = !!(game && game.over && ae && ae.classList && ae.classList.contains("ini"));
      if (!overlayTyping && action) e.preventDefault();
      if (!game || game.over) {
        if (down && (e.code === "Enter" || e.code === "NumpadEnter" || e.code === "Space")) {
          if (game && game.over) {
            if (e.code === "Space" && overlayTyping) return; // let Space reach the initials field
            UI.submitScore(); UI.restart();
          } else UI.startFromTitle();
        }
        return;
      }
      if (!action) return;
      const g = game;
      if (down && action === "pause") { UI.togglePause(); return; }
      if (down && action === "restart") { UI.restart(); return; }
      if (down && action === "mute") { UI.toggleMute(); return; }
      const canAct = !g.paused && g.cur && !g.clearing;
      if (down) {
        if (!canAct) return;
        switch (action) {
          case "left": if (g.move(-1, 0)) Audio2.sfx("move"); break;
          case "right": if (g.move(1, 0)) Audio2.sfx("move"); break;
          case "softDrop": keySoft = true; g.softDropping = true; break;
          case "rotateCW": g.rotate(1); break;
          case "rotateCCW": g.rotate(-1); break;
          case "rotate180": g.rotate180(); break;
          case "hardDrop": g.hardDrop(); break;
          case "hold": g.holdPiece(); break;
        }
      } else {
        if (action === "softDrop") { keySoft = false; g.softDropping = false; }
      }
    };
    window.addEventListener("keydown", (e) => { if (!e.repeat) handle(e, true); });
    window.addEventListener("keyup", (e) => handle(e, false));

    // DAS/ARR for horizontal — keyboard AND gamepad feed this, keyed by "left"/"right".
    let touchSoft = false; // touch soft-drop, OR-merged into the gamepad poll (cleared by clearHeld)
    let keySoft = false;   // keyboard soft-drop, OR-merged into the gamepad poll
    const held = {};
    const downRaw = {};
    const pressDir = (a) => { const opp = a === "left" ? "right" : "left"; downRaw[a] = true; delete held[opp]; if (!held[a]) held[a] = { das: settings.das, arr: 0 }; };
    const releaseDir = (a) => { delete held[a]; delete downRaw[a]; };
    window.addEventListener("keydown", (e) => { const a = CODE2ACTION[e.code]; if (a === "left" || a === "right") pressDir(a); });
    window.addEventListener("keyup", (e) => { const a = CODE2ACTION[e.code]; if (a === "left" || a === "right") releaseDir(a); });
    const rearmHeld = () => { for (const key of ["left", "right"]) if (downRaw[key] && !held[key]) held[key] = { das: 0, arr: settings.arr }; };
    const clearHeld = () => { for (const kk in held) delete held[kk]; for (const kk in downRaw) delete downRaw[kk]; for (const kk in heldAct) delete heldAct[kk]; touchSoft = false; keySoft = false; if (game) game.softDropping = false; };
    window.addEventListener("blur", () => { clearHeld(); if (game && !game.paused && !game.over) UI.togglePause(); });
    document.addEventListener("visibilitychange", () => { if (document.hidden) { clearHeld(); if (game && !game.paused && !game.over) UI.togglePause(); } });
    const repeat = (dt) => {
      if (!game || game.paused || game.over) return;
      rearmHeld();
      const canMove = game.cur && !game.clearing; // during clear/entry, charge DAS but don't move
      for (const key of ["left", "right"]) {
        const h = held[key]; if (!h) continue;
        if (h.das > 0) { h.das -= dt; continue; } // DAS keeps charging through the line-clear/entry delay
        if (!canMove) continue;
        const dir = key === "left" ? -1 : 1;
        if (settings.arr <= 0) {
          let moved = false, guard = 0;
          while (guard++ < COLS && game.move(dir, 0)) moved = true;
          if (moved) Audio2.sfx("move");
        } else {
          h.arr -= dt;
          if (h.arr <= 0) { h.arr = settings.arr; if (game.move(dir, 0)) Audio2.sfx("move"); }
        }
      }
    };

    // IRS/IHS: a rotate/hold physically held at the spawn frame applies to the new piece.
    const onSpawn = (g, fromHold) => {
      if (!g || g.over || !g.cur) return;
      if (heldAct.softDrop) { keySoft = true; g.softDropping = true; } // re-arm a held soft-drop after lock/spawn (independent of IRS)
      if (!settings.irsIhs) return;
      if (!fromHold && heldAct.hold && !g.holdUsed) g.holdPiece(); // IHS
      if (g.over || !g.cur) return;
      if (heldAct.rotateCW) g.rotate(1);          // IRS
      else if (heldAct.rotateCCW) g.rotate(-1);
      else if (heldAct.rotate180) g.rotate180();
    };

    // ---- Gamepad: standard mapping, edge-detected, hot-plug-safe, inert without a pad. ----
    const padPrev = {}; const DEAD = 0.55;
    let padLeft = false, padRight = false;
    const padEdge = (p, i) => { const v = !!(p.buttons[i] && p.buttons[i].pressed); const was = padPrev[i]; padPrev[i] = v; return v && !was; };
    const padHeld = (p, i) => !!(p.buttons[i] && p.buttons[i].pressed);
    const poll = () => {
      if (typeof navigator === "undefined" || !navigator.getGamepads) return;
      if (!game || game.over) { padLeft = padRight = false; for (const k in padPrev) delete padPrev[k]; return; }
      const pads = navigator.getGamepads();
      let p = null; for (let i = 0; i < pads.length; i++) if (pads[i] && pads[i].connected !== false) { p = pads[i]; break; }
      if (!p) { if (padLeft) { releaseDir("left"); padLeft = false; } if (padRight) { releaseDir("right"); padRight = false; } if (game) game.softDropping = keySoft || touchSoft; return; } // no pad: preserve keyboard/touch soft-drop, release latched pad dirs
      const g = game;
      if (padEdge(p, 9)) { UI.togglePause(); return; } // Start = pause
      const canAct = !g.paused && g.cur && !g.clearing;
      if (!canAct) { g.softDropping = false; for (let i = 0; i < (p.buttons ? p.buttons.length : 0); i++) padEdge(p, i); return; }
      if (padEdge(p, 0)) g.rotate(1);                          // A
      if (padEdge(p, 2)) g.rotate(-1);                         // X
      if (padEdge(p, 3)) g.rotate180();                        // Y
      { const eB = padEdge(p, 1), eL = padEdge(p, 4), eR = padEdge(p, 5); if (eB || eL || eR) g.holdPiece(); } // B / shoulders (eval all edges)
      { const up = padEdge(p, 12), rt = padEdge(p, 7); if (up || rt) g.hardDrop(); }       // dpad-up / RT (eval all edges)
      g.softDropping = keySoft || touchSoft || padHeld(p, 13) || padHeld(p, 6) || (p.axes[1] || 0) > DEAD; // key + touch + dpad-down / LT / stick
      const ax = p.axes[0] || 0;
      const L = padHeld(p, 14) || ax < -DEAD, R = padHeld(p, 15) || ax > DEAD;
      if (L && !padLeft) pressDir("left"); else if (!L && padLeft) releaseDir("left"); padLeft = L;
      if (R && !padRight) pressDir("right"); else if (!R && padRight) releaseDir("right"); padRight = R;
    };

    // ---- Touch: additive, INERT on fine-pointer/desktop. Mirrors keyboard/gamepad
    // semantics without touching heldAct{} (IRS stays physical-key) or the DAS held{} maps. ----
    const TOUCH = (window.matchMedia && window.matchMedia("(pointer: coarse)").matches) || ("ontouchstart" in window);
    if (TOUCH) (() => {
      const wrap = document.querySelector(".board-wrap");
      if (!wrap) return;
      const TAP_MS = 220, TAP_SLOP = 14, FLICK_MS = 260, FLICK_UP = 60, SOFT_BIAS = 1.4;
      let active = false, startX = 0, startY = 0, lastX = 0, lastY = 0, startT = 0;
      let movedCells = 0, maxUp = 0, didSoft = false, didMove = false, twoFinger = false, pid = null;
      const softOn  = () => { if (game && !didSoft) { didSoft = true; touchSoft = true; game.softDropping = true; } };
      const softOff = () => { if (didSoft) { didSoft = false; touchSoft = false; if (game) game.softDropping = false; } };
      const canAct = () => !!(game && !game.over && !game.paused && game.cur && !game.clearing);
      const reset = () => { active = false; pid = null; twoFinger = false; movedCells = 0; maxUp = 0; didMove = false; softOff(); };
      wrap.addEventListener("touchstart", (e) => {
        if (e.touches.length > 1) { twoFinger = true; e.preventDefault(); return; }
        const t = e.changedTouches[0];
        pid = t.identifier; active = true; twoFinger = false;
        startX = lastX = t.clientX; startY = lastY = t.clientY; startT = performance.now();
        movedCells = 0; maxUp = 0; didMove = false; didSoft = false;
        e.preventDefault();
      }, { passive: false });
      wrap.addEventListener("touchmove", (e) => {
        if (!active) return;
        let t = null; for (const c of e.changedTouches) if (c.identifier === pid) { t = c; break; }
        if (!t) return;
        e.preventDefault();
        lastX = t.clientX; lastY = t.clientY;
        const dx = lastX - startX, dy = lastY - startY;
        const up = startY - lastY; if (up > maxUp) maxUp = up;
        if (!canAct()) return;
        const cell = ((typeof CELL === "number" && CELL > 0) ? CELL : 28) / (settings.touchSens || 1);
        const wantCells = Math.trunc(dx / cell);
        while (movedCells < wantCells) { if (game.move(1, 0)) { Audio2.sfx("move"); didMove = true; } movedCells++; }
        while (movedCells > wantCells) { if (game.move(-1, 0)) { Audio2.sfx("move"); didMove = true; } movedCells--; }
        if (dy > cell * 0.6 && dy > Math.abs(dx) * SOFT_BIAS) softOn(); else softOff();
      }, { passive: false });
      const onEnd = (e) => {
        let t = null; for (const c of e.changedTouches) if (c.identifier === pid) { t = c; break; }
        if (!active || !t) { if (!(e.touches.length === 0 && active)) return; }
        e.preventDefault();
        const dur = performance.now() - startT;
        const dx = lastX - startX, dy = lastY - startY;
        const dist = Math.hypot(dx, dy);
        if (canAct()) {
          if (twoFinger) { if (dur <= TAP_MS && dist <= TAP_SLOP && !didMove && !didSoft) game.rotate(-1); }
          else if (dur <= FLICK_MS && maxUp >= FLICK_UP && maxUp > Math.abs(dx)) game.hardDrop();
          else if (dur <= TAP_MS && dist <= TAP_SLOP && !didMove && !didSoft) game.rotate(1);
        }
        reset();
      };
      wrap.addEventListener("touchend", onEnd, { passive: false });
      wrap.addEventListener("touchcancel", (e) => { e.preventDefault(); reset(); }, { passive: false });
      document.addEventListener("visibilitychange", () => { if (document.hidden) reset(); });
      const bind = (sel, fn) => {
        const el = document.querySelector(sel);
        if (!el) return;
        el.addEventListener("click", (ev) => { ev.preventDefault(); fn(); });
        el.addEventListener("touchstart", (ev) => { ev.stopPropagation(); }, { passive: true });
      };
      bind("#tbtn-hard",  () => { if (canAct()) game.hardDrop(); });
      bind("#tbtn-hold",  () => { if (canAct()) game.holdPiece(); });
      bind("#tbtn-rot",   () => { if (canAct()) game.rotate(1); });
      bind("#tbtn-pause", () => UI.togglePause());
    })();

    return { repeat, poll, onSpawn, rebuildMap, clearHeld, ACTIONS, ACTION_LABEL, DEF_KEYS };
  })();

  // ============================================================ UI / flow
  // (game/raf/last/acc are declared earlier, before layout())
  const UI = {
    mode: "marathon",
    startFromTitle() { this.start(this.mode); },
    start(mode) {
      this.mode = mode;
      hideAll();
      Audio2.ensure(); Audio2.resume();
      this.countdown(() => {
        game = new Game(mode);
        Audio2.setIntensity(0); Audio2.startMusic();
        last = performance.now(); acc = 0;
        if (!raf) loop(last);
      });
    },
    countdown(done) {
      const el = $("#countdown"); el.classList.remove("hidden");
      let n = 3;
      const show = () => {
        if (n === 0) { el.innerHTML = `<span class="cd-num">GO</span>`; Audio2.sfx("go"); setTimeout(() => { el.classList.add("hidden"); done(); }, 500); return; }
        el.innerHTML = `<span class="cd-num">${n}</span>`; Audio2.sfx("cd"); n--; setTimeout(show, 700);
      };
      show();
    },
    togglePause() {
      if (!game || game.over) return;
      game.paused = !game.paused;
      $("#ov-pause").classList.toggle("hidden", !game.paused);
      if (game.paused) Audio2.stopMusic(); else { Audio2.startMusic(); last = performance.now(); acc = 0; }
    },
    resume() { if (game && game.paused) this.togglePause(); },
    restart() { if (!game) return; const m = game.mode; game = null; hideAll(); this.start(m); },
    quit() { game = null; Audio2.stopMusic(); hideAll(); $("#ov-title").classList.remove("hidden"); if (typeof refreshDailyBtn === "function") refreshDailyBtn(); },
    toggleMute() {
      this.muted = !this.muted; Audio2.setMute(this.muted);
      settings.muted = this.muted; Store.set("tessera.settings", settings); // persist mute across sessions
      $("#btn-mute").classList.toggle("off", this.muted);
      if (!this.muted && game && !game.paused && !game.over) Audio2.startMusic();
    },
    gameOver(g) {
      const board = Lead.get(g.mode);
      const isTime = !!(MODES[g.mode] && MODES[g.mode].timeMetric); // sprint/cheese/daily rank on time
      const metric = isTime ? g.elapsed : g.score;
      const qualifies = g.mode !== "zen" && Lead.qualifies(g.mode, metric, g);
      $("#over-title").textContent = g.won ? (isTime ? "Cleared!" : "Finished!") : "Game Over";
      const rows = [
        ["Score", g.score.toLocaleString()],
        ["Lines", g.lines],
        ["Level", g.level],
        [isTime ? "Time" : g.mode === "ultra" ? "Score in 2:00" : "Time", isTime ? fmtTime(g.elapsed) : (g.mode === "ultra" ? g.score.toLocaleString() : fmtTime(g.elapsed))],
        ["Tetrises", g.stats.tetris], ["T-spins", g.stats.tspins], ["Max combo", g.stats.maxCombo], ["Pieces", g.stats.pieces],
        ["PPS", (g.elapsed > 0 ? (g.stats.pieces / (g.elapsed / 1000)).toFixed(2) : "0.00")],
        ["Singles", g.stats.single], ["Doubles", g.stats.double], ["Triples", g.stats.triple],
        ["T-spin mini", g.stats.tsMini], ["TS single/dbl/tpl", `${g.stats.tsSingle}/${g.stats.tsDouble}/${g.stats.tsTriple}`],
        ["Finesse faults", g.stats.finesseFaults],
        ["Seed", (g.seed >>> 0).toString()],
      ];
      $("#over-stats").innerHTML = rows.map(([k, v]) => `<span class="ok">${k}</span><span class="ov">${v}</span>`).join("");
      const hs = $("#hs-entry"); hs.classList.toggle("hidden", !qualifies);
      this.pendingScore = qualifies ? { mode: g.mode, score: g.score, lines: g.lines, level: g.level, time: g.elapsed, metric } : null;
      if (qualifies) { $$(".ini").forEach((i) => (i.value = "")); const coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches; if (!coarse) setTimeout(() => $(".ini").focus(), 50); } // don't force the OSK open over the stats on touch
      if (g.mode === "daily") Daily.record(g);
      this.lastShare = g.mode === "daily" ? Daily.share(g) : null;
      const sb = $("#btn-over-share"); if (sb) { sb.hidden = !this.lastShare; sb.textContent = "Share result"; }
      $("#ov-over").classList.remove("hidden");
    },
    submitScore() {
      if (!this.pendingScore) return null;
      const ini = Array.from($$(".ini")).map((i) => (i.value || "").toUpperCase()).join("") || "AAA";
      const id = Lead.add(this.pendingScore.mode, { ini, ...this.pendingScore });
      this.pendingScore = null; return id;
    },
  };

  // ============================================================ Leaderboard
  const Lead = (() => {
    const key = "tessera.scores";
    let data = Store.get(key, {});
    const get = (mode) => (data[mode] || []).slice();
    const isTimeMode = (mode) => !!(MODES[mode] && MODES[mode].timeMetric);
    const better = (mode, a, b) => isTimeMode(mode) ? a < b : a > b; // time modes: lower better
    const qualifies = (mode, metric, g) => {
      if (isTimeMode(mode) && !g.won) return false; // only completed runs rank on time modes
      const list = get(mode); if (list.length < 10) return g.score > 0 || (isTimeMode(mode) && g.won);
      const worst = list[list.length - 1].metric;
      return better(mode, metric, worst);
    };
    const add = (mode, entry) => {
      const id = "s" + Date.now() + Math.floor(Math.random() * 999);
      const list = get(mode); list.push({ id, ...entry, at: Date.now() });
      list.sort((a, b) => { if (a.metric !== b.metric) return better(mode, a.metric, b.metric) ? -1 : 1; return (a.at || 0) - (b.at || 0); });
      data[mode] = list.slice(0, 10); Store.set(key, data); return id;
    };
    return { get, add, qualifies, better };
  })();

  // ============================================================ Overlay plumbing
  const hideAll = () => $$(".overlay").forEach((o) => o.classList.add("hidden"));
  const show = (id) => { hideAll(); $(id).classList.remove("hidden"); };

  function renderLeaderboard(highlightId) {
    const tabs = $("#board-tabs"); const modes = Object.keys(MODES);
    let active = renderLeaderboard.active || "marathon";
    tabs.innerHTML = modes.map((m) => `<button class="tab ${m === active ? "on" : ""}" data-m="${m}">${MODES[m].name}</button>`).join("");
    tabs.querySelectorAll(".tab").forEach((t) => t.onclick = () => { renderLeaderboard.active = t.dataset.m; renderLeaderboard(highlightId); });
    const list = Lead.get(active);
    const ol = $("#scores");
    if (!list.length) { ol.innerHTML = `<div class="empty">No scores yet — be the first.</div>`; return; }
    ol.innerHTML = list.map((e, i) => {
      const val = (MODES[active] && MODES[active].timeMetric) ? fmtTime(e.time) : e.score.toLocaleString();
      return `<li class="${e.id === highlightId ? "me" : ""}"><span class="rk">${i + 1}</span><span class="ini2">${e.ini}</span><span class="mt">Lv ${e.level} · ${e.lines}L</span><span class="sc">${val}</span></li>`;
    }).join("");
  }

  function renderSettings() {
    const body = $("#settings-body");
    const CODE_LABEL = { ArrowLeft:"←", ArrowRight:"→", ArrowUp:"↑", ArrowDown:"↓", Space:"Space", Escape:"Esc", ControlLeft:"Ctrl", ControlRight:"RCtrl", ShiftLeft:"Shift", ShiftRight:"RShift", Enter:"Enter" };
    const codeLabel = (c) => CODE_LABEL[c] || c.replace(/^Key/, "").replace(/^Digit/, "").replace(/^Numpad/, "Num");
    const curKeys = (a) => ((settings.keys && settings.keys[a]) || Input.DEF_KEYS[a] || []);
    const keyLabel = (a) => curKeys(a).map(codeLabel).join(" / ") || "—";
    const sliders = [
      ["master", "Master", 0, 1, 0.05, (v) => Math.round(v * 100) + "%"],
      ["music", "Music", 0, 1, 0.05, (v) => Math.round(v * 100) + "%"],
      ["sfx", "Sound FX", 0, 1, 0.05, (v) => Math.round(v * 100) + "%"],
      ["das", "DAS (delay)", 30, 300, 5, (v) => v + "ms"],
      ["arr", "ARR (repeat)", 0, 80, 1, (v) => v + "ms"],
      ["sdf", "Soft-drop speed", 5, 40, 1, (v) => v + "×"],
    ];
    const toggles = [
      ["ghost", "Ghost piece"],
      ["shake", "Screen shake"],
      ["colorblind", "Colorblind palette"],
      ["patterns", "Pattern fill (glyphs)"],
      ["reducedMotion", "Reduced motion"],
      ["irsIhs", "Initial rotate/hold (IRS)"],
      ["haptics", "Haptics (vibrate)"],
    ];
    const coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
    body.innerHTML =
      sliders.map(([k, label, mn, mx, st]) => `<div class="set-row"><label>${label}</label><span><input type="range" data-k="${k}" min="${mn}" max="${mx}" step="${st}" value="${settings[k]}"><span class="val" data-v="${k}"></span></span></div>`).join("") +
      toggles.map(([k, label]) => `<div class="set-row"><label>${label}</label><button class="switch ${settings[k] ? "on" : ""}" data-t="${k}"></button></div>`).join("") +
      (coarse ? `<div class="set-sep">Touch</div>` +
        `<div class="set-row"><label>Swipe sensitivity</label><span><input type="range" data-k="touchSens" min="0.5" max="2" step="0.1" value="${settings.touchSens}"><span class="val" data-v="touchSens">${(+settings.touchSens).toFixed(1)}×</span></span></div>` +
        `<div class="set-row"><label>Left-handed bar</label><button class="switch ${settings.leftHanded ? "on" : ""}" data-t="leftHanded"></button></div>` : "") +
      `<div class="set-row pat-note-row"><span class="pat-note">Pattern fill stamps a unique glyph on each piece (I bars · O ring · T triangle · S/Z slash · J dot · L corner) for color-independent recognition.</span></div>` +
      `<div class="set-sep set-coll-h ${renderSettings._keysOpen ? "open" : ""}" data-coll="keys">Controls · click to rebind<span class="coll-arrow">▸</span></div>` +
      `<div class="set-coll" data-collbody="keys"${renderSettings._keysOpen ? "" : " hidden"}>` +
      Input.ACTIONS.map((a) => `<div class="set-row"><label>${Input.ACTION_LABEL[a]}</label><button class="keybind" data-act="${a}">${keyLabel(a)}</button></div>`).join("") +
      `<div class="set-row"><label>Keyboard + gamepad + IRS</label><button class="keyreset">Reset keys</button></div></div>` +
      `<div class="set-row"><label>Storage</label><span class="val" style="min-width:auto">${Store.persistent ? "saved on disk" : "this session only"}</span></div>`;
    const updVals = () => sliders.forEach(([k, , , , , fmt]) => { const el = body.querySelector(`[data-v="${k}"]`); if (el) el.textContent = fmt(settings[k]); });
    updVals();
    body.querySelectorAll("input[type=range]").forEach((inp) => inp.oninput = () => {
      const k = inp.dataset.k; settings[k] = parseFloat(inp.value); updVals();
      if (k === "touchSens") { const tv = body.querySelector('[data-v="touchSens"]'); if (tv) tv.textContent = (+settings.touchSens).toFixed(1) + "×"; }
      Audio2.setVol(); Store.set("tessera.settings", settings);
    });
    body.querySelectorAll(".switch").forEach((sw) => sw.onclick = () => {
      const k = sw.dataset.t; settings[k] = !settings[k]; sw.classList.toggle("on", settings[k]);
      Store.set("tessera.settings", settings);
      applyA11y();                 // reflect colorblind/patterns/reduced-motion on <html>
      if (game) render(game);      // repaint so palette/glyph changes show immediately
    });
    // Key rebinding: click a chip, then press the new key (Esc cancels).
    const km0 = () => settings.keys ? settings.keys : JSON.parse(JSON.stringify(Input.DEF_KEYS));
    body.querySelectorAll(".keybind").forEach((btn) => btn.onclick = () => {
      const act = btn.dataset.act; btn.textContent = "press a key…"; btn.classList.add("capturing");
      const capUp = (e) => { e.preventDefault(); e.stopPropagation(); }; // swallow the matching keyup
      const disarm = () => { window.removeEventListener("keydown", cap, true); window.removeEventListener("keyup", capUp, true); renderSettings._cap = null; };
      const cap = (e) => {
        e.preventDefault(); e.stopPropagation();
        disarm();
        if (e.code !== "Escape") {
          const km = km0();
          for (const a of Input.ACTIONS) km[a] = (km[a] || []).filter((c) => c !== e.code); // unbind elsewhere
          km[act] = [e.code];
          settings.keys = km; Store.set("tessera.settings", settings); Input.rebuildMap();
          if (Input.clearHeld) Input.clearHeld(); // drop stale held state for the rebound key
        }
        renderSettings();
      };
      window.addEventListener("keydown", cap, true); // capture phase: don't let the game also act
      window.addEventListener("keyup", capUp, true);
      renderSettings._cap = disarm; // leaving Settings tears down an armed capture (no leaked rebind)
    });
    const kr = body.querySelector(".keyreset");
    if (kr) kr.onclick = () => { delete settings.keys; Store.set("tessera.settings", settings); Input.rebuildMap(); renderSettings(); };
    body.querySelectorAll(".set-coll-h").forEach((h) => h.onclick = () => {
      renderSettings._keysOpen = !renderSettings._keysOpen;
      const bod = body.querySelector(`[data-collbody="${h.dataset.coll}"]`);
      if (bod) bod.hidden = !renderSettings._keysOpen;
      h.classList.toggle("open", renderSettings._keysOpen);
    });
  }

  // wire buttons
  $$("#ov-title [data-mode]").forEach((b) => b.onclick = () => UI.start(b.dataset.mode));
  $("#btn-leaderboard").onclick = () => { renderLeaderboard(); show("#ov-board"); };
  $("#btn-settings").onclick = () => { renderSettings(); show("#ov-settings"); };
  $("#btn-howto").onclick = () => show("#ov-howto");
  $("#btn-board-back").onclick = () => { show("#ov-title"); if (typeof refreshDailyBtn === "function") refreshDailyBtn(); };
  $("#btn-settings-back").onclick = () => { if (renderSettings._cap) renderSettings._cap(); if (game && game.paused) show("#ov-pause"); else show("#ov-title"); };
  $("#btn-howto-back").onclick = () => show("#ov-title");
  $("#btn-resume").onclick = () => UI.resume();
  $("#btn-restart").onclick = () => UI.restart();
  $("#btn-pause-settings").onclick = () => { renderSettings(); show("#ov-settings"); };
  $("#btn-quit").onclick = () => UI.quit();
  $("#btn-pause").onclick = () => UI.togglePause();
  $("#btn-mute").onclick = () => UI.toggleMute();
  if (settings.muted) UI.toggleMute(); // restore persisted mute state
  $("#btn-again").onclick = () => { UI.submitScore(); UI.restart(); };
  $("#btn-over-menu").onclick = () => { UI.submitScore(); UI.quit(); };
  $("#btn-over-board").onclick = () => { const id = UI.submitScore(); renderLeaderboard.active = UI.mode; renderLeaderboard(id); show("#ov-board"); };
  $("#btn-over-share").onclick = () => {
    const s = UI.lastShare; if (!s) return; let ok = false;
    try { const ta = document.createElement("textarea"); ta.value = s; ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.focus(); ta.select(); ok = document.execCommand("copy"); ta.remove(); } catch {}
    const b = $("#btn-over-share");
    b.textContent = ok ? "Copied!" : ("Copy: " + s); // sync result drives the label; async clipboard is best-effort only
    setTimeout(() => { b.textContent = "Share result"; }, 1600);
    try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(s).then(() => { b.textContent = "Copied!"; }).catch(() => {}); } catch {}
  };
  const refreshDailyBtn = () => {
    const b = document.querySelector('#ov-title [data-mode="daily"]'); if (!b) return;
    const r = Daily.playedToday();
    b.textContent = r ? (r.won ? `Daily ✓ ${fmtTime(r.time)}` : "Daily · played today") : "Daily · 40L";
  };
  refreshDailyBtn();
  // initials auto-advance
  $$(".ini").forEach((inp) => {
    inp.oninput = () => { inp.value = inp.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); };
  });

  // ============================================================ Main loop
  // Fixed-timestep: logic runs at a constant 60Hz tick regardless of the
  // display refresh rate (60/144/240Hz). Rendering runs once per rAF frame.
  const TICK_MS = 1000 / 60;        // 16.666… ms logic step
  const MAX_STEPS = 5;              // clamp catch-up to avoid a spiral of death

  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (typeof Input !== "undefined" && Input.poll) Input.poll(now); // gamepad: once per displayed frame, before the catch-up loop
    let frame = now - last; last = now;
    if (frame > 250) frame = 250;   // tab-throttle / long-stall guard
    acc += frame;

    let steps = 0;
    while (acc >= TICK_MS && steps < MAX_STEPS) {
      acc -= TICK_MS;
      steps++;
      Input.repeat(TICK_MS);
      if (game && !game.paused && !game.over) game.update(TICK_MS);
    }
    // If we hit the step clamp with a backlog, drop it so we don't keep catching up.
    if (steps === MAX_STEPS && acc > TICK_MS) acc = 0;

    if (game) render(game);
  }

  // expose for inline handlers if needed
  window.Tessera = { UI, Audio2 };
  applyA11y();   // reflect persisted a11y flags on <html> at startup
  // start music context on first interaction (autoplay policy)
  window.addEventListener("pointerdown", () => Audio2.resume(), { once: true });
})();
