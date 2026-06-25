/* ============================================================================
 * Aether — focus soundscapes (original implementation).
 * Pure Web Audio: every sound is generated/synthesized at runtime (no audio
 * files), so it works offline in the sandboxed Scry extension frame. Layer
 * noise + ambiences; each channel has its own volume, all fed through a master.
 * ==========================================================================*/
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ---- audio context (lazy; created/resumed on first user gesture) ---------
  let ctx = null, master = null, masterLP = null, analyser = null;
  // Warmth slider (0..100) → low-pass cutoff on a log scale (muffled..open).
  function warmthFreq() {
    const el = $("#ae-warmth");
    const v = el ? +el.value : 100;
    return 320 * Math.pow(20000 / 320, v / 100);
  }
  function ensureCtx() {
    if (ctx) return ctx;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = +$("#ae-master").value / 100;
    masterLP = ctx.createBiquadFilter();
    masterLP.type = "lowpass";
    masterLP.frequency.value = warmthFreq();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    master.connect(masterLP);
    masterLP.connect(analyser);
    analyser.connect(ctx.destination);
    startViz();
    return ctx;
  }

  // ---- noise buffers -------------------------------------------------------
  function noiseBuffer(type) {
    const len = Math.floor(ctx.sampleRate * 3);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    if (type === "white") {
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    } else if (type === "pink") {
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      }
    } else { // brown
      let last = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      }
    }
    return buf;
  }
  function noiseSource(type) {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuffer(type);
    s.loop = true;
    s.start();
    return s;
  }
  // An LFO driving an AudioParam between min..max at `freq` Hz. Returns the osc
  // so it can be stopped on teardown.
  function lfo(freq, min, max, param) {
    const o = ctx.createOscillator();
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = (max - min) / 2;
    o.connect(g);
    g.connect(param);
    param.value = (min + max) / 2;
    o.start();
    return o;
  }
  function filter(type, freq, q) {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    if (q != null) f.Q.value = q;
    return f;
  }

  // ---- channel builders ----------------------------------------------------
  // Each returns { entry, stop } — entry connects to the channel gain; stop()
  // tears down all generated nodes. Built fresh each time a channel turns on.
  const BUILDERS = {
    brown: () => { const s = noiseSource("brown"); return { entry: s, stop: () => stopAll([s]) }; },
    pink: () => { const s = noiseSource("pink"); return { entry: s, stop: () => stopAll([s]) }; },
    white: () => { const s = noiseSource("white"); return { entry: s, stop: () => stopAll([s]) }; },
    rain: () => {
      const s = noiseSource("white");
      const hp = filter("highpass", 700);
      const lp = filter("lowpass", 4800);
      const sh = filter("lowpass", 2600); // body
      s.connect(hp); hp.connect(lp); lp.connect(sh);
      const o = lfo(0.4, 2200, 3200, sh.frequency); // subtle shimmer
      return { entry: sh, stop: () => stopAll([s, o]) };
    },
    waves: () => {
      const s = noiseSource("brown");
      const lp = filter("lowpass", 500);
      const g = ctx.createGain(); g.gain.value = 0.5;
      s.connect(lp); lp.connect(g);
      const o1 = lfo(0.07, 0.12, 0.95, g.gain);      // slow swell
      const o2 = lfo(0.07, 280, 760, lp.frequency);  // brightens on the crest
      return { entry: g, stop: () => stopAll([s, o1, o2]) };
    },
    wind: () => {
      const s = noiseSource("pink");
      const bp = filter("bandpass", 500, 1.4);
      s.connect(bp);
      const o = lfo(0.1, 320, 900, bp.frequency);
      return { entry: bp, stop: () => stopAll([s, o]) };
    },
    fire: () => {
      // Low body + random crackle via a noise source gated by a fast random LFO.
      const body = noiseSource("brown");
      const blp = filter("lowpass", 380);
      body.connect(blp);
      const bg = ctx.createGain(); bg.gain.value = 0.7; blp.connect(bg);
      const crk = noiseSource("white");
      const chp = filter("highpass", 1500);
      crk.connect(chp);
      const cg = ctx.createGain(); cg.gain.value = 0.0; chp.connect(cg);
      const o = lfo(7, -0.15, 0.5, cg.gain); // bursty crackle
      const mix = ctx.createGain();
      bg.connect(mix); cg.connect(mix);
      return { entry: mix, stop: () => stopAll([body, crk, o]) };
    },
    hum: () => {
      // Warm low drone — two slightly detuned sines + a soft fifth.
      const mk = (f, g) => { const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = f; const gn = ctx.createGain(); gn.gain.value = g; o.connect(gn); o.start(); return { o, gn }; };
      const a = mk(72, 0.5), b = mk(72.4, 0.4), c = mk(108, 0.18);
      const lp = filter("lowpass", 600);
      a.gn.connect(lp); b.gn.connect(lp); c.gn.connect(lp);
      const o = lfo(0.12, 0.7, 1.0, lp.frequency);
      return { entry: lp, stop: () => stopAll([a.o, b.o, c.o, o]) };
    },
    cafe: () => {
      // Low room murmur: band-limited noise that swells like background chatter.
      const s = noiseSource("pink");
      const bp = filter("bandpass", 600, 0.7);
      const g = ctx.createGain(); g.gain.value = 0.6;
      s.connect(bp); bp.connect(g);
      const o1 = lfo(0.25, 0.4, 0.85, g.gain);
      const o2 = lfo(0.13, 360, 820, bp.frequency);
      return { entry: g, stop: () => stopAll([s, o1, o2]) };
    },
    night: () => {
      // Soft low bed + a high cricket trill (gated tone).
      const bed = noiseSource("brown");
      const blp = filter("lowpass", 340);
      const bg = ctx.createGain(); bg.gain.value = 0.4;
      bed.connect(blp); blp.connect(bg);
      const chirp = ctx.createOscillator(); chirp.type = "sine"; chirp.frequency.value = 4600;
      const cg = ctx.createGain(); cg.gain.value = 0; chirp.connect(cg);
      const pulse = ctx.createOscillator(); pulse.type = "square"; pulse.frequency.value = 2.4;
      const pg = ctx.createGain(); pg.gain.value = 0.05; pulse.connect(pg); pg.connect(cg.gain);
      const off = ctx.createConstantSource(); off.offset.value = 0.05; off.connect(cg.gain);
      const mix = ctx.createGain(); bg.connect(mix); cg.connect(mix);
      chirp.start(); pulse.start(); off.start();
      return { entry: mix, stop: () => stopAll([bed, chirp, pulse, off]) };
    },
    train: () => {
      // Distant rumble that sways + a soft rhythmic clack.
      const s = noiseSource("brown");
      const lp = filter("lowpass", 320);
      const g = ctx.createGain(); g.gain.value = 0.7;
      s.connect(lp); lp.connect(g);
      const o = lfo(0.05, 0.5, 0.9, g.gain);
      const clack = noiseSource("white");
      const chp = filter("bandpass", 1800, 1);
      clack.connect(chp);
      const cg = ctx.createGain(); cg.gain.value = 0; chp.connect(cg);
      const pulse = ctx.createOscillator(); pulse.type = "square"; pulse.frequency.value = 1.6;
      const pg = ctx.createGain(); pg.gain.value = 0.045; pulse.connect(pg); pg.connect(cg.gain);
      const off = ctx.createConstantSource(); off.offset.value = 0.045; off.connect(cg.gain);
      const mix = ctx.createGain(); g.connect(mix); cg.connect(mix);
      pulse.start(); off.start();
      return { entry: mix, stop: () => stopAll([s, clack, o, pulse, off]) };
    },
  };
  function stopAll(nodes) { for (const n of nodes) { try { n.stop(); } catch (e) {} try { n.disconnect(); } catch (e) {} } }

  // ---- focus tones (binaural / isochronic) --------------------------------
  // Brainwave-band beats. Binaural = two near-pitches panned L/R (needs
  // headphones). Isochronic = one carrier pulsed at the beat rate (works on
  // speakers). Carrier kept low/soft so it sits under the soundscape.
  let toneMode = "isochronic";
  function toneGraph(beat) {
    const carrier = 196;
    if (toneMode === "binaural") {
      const oL = ctx.createOscillator(); oL.type = "sine"; oL.frequency.value = carrier;
      const oR = ctx.createOscillator(); oR.type = "sine"; oR.frequency.value = carrier + beat;
      const pL = ctx.createStereoPanner(); pL.pan.value = -1;
      const pR = ctx.createStereoPanner(); pR.pan.value = 1;
      const g = ctx.createGain(); g.gain.value = 0.6;
      oL.connect(pL); pL.connect(g); oR.connect(pR); pR.connect(g);
      oL.start(); oR.start();
      return { entry: g, stop: () => stopAll([oL, oR]) };
    }
    // isochronic: carrier amplitude-gated by a square LFO at the beat rate
    const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = carrier;
    const g = ctx.createGain(); g.gain.value = 0; o.connect(g);
    const pulse = ctx.createOscillator(); pulse.type = "square"; pulse.frequency.value = beat;
    const pg = ctx.createGain(); pg.gain.value = 0.4; pulse.connect(pg); pg.connect(g.gain);
    const off = ctx.createConstantSource(); off.offset.value = 0.4; off.connect(g.gain);
    o.start(); pulse.start(); off.start();
    return { entry: g, stop: () => stopAll([o, pulse, off]) };
  }
  const TONES = [
    { id: "tone-theta", name: "Theta 6 Hz", icon: "🌙", desc: "Calm, day-dreamy", beat: 6 },
    { id: "tone-alpha", name: "Alpha 10 Hz", icon: "🌀", desc: "Relaxed focus", beat: 10 },
    { id: "tone-beta", name: "Beta 18 Hz", icon: "⚡", desc: "Alert, engaged", beat: 18 },
    { id: "tone-gamma", name: "Gamma 40 Hz", icon: "✦", desc: "Deep concentration", beat: 40 },
  ];
  const toneBeat = Object.fromEntries(TONES.map((t) => [t.id, t.beat]));
  // Build any channel's node graph by id (noise/ambience builders or a tone).
  function buildChannel(id) {
    return BUILDERS[id] ? BUILDERS[id]() : toneGraph(toneBeat[id]);
  }

  // ---- recorded ambience samples ------------------------------------------
  // Real ambiences (generated with the ElevenLabs sound-effects API and bundled
  // as loops) sound far better than synthesis for anything with structure —
  // voices, birds, crackle. These channel ids play a looped sample; noise +
  // tones + drone stay synthesized. If a sample fails to load we fall back to
  // the synth builder so the channel still produces sound.
  const SAMPLE_IDS = { rain: "rain", waves: "ocean", wind: "wind", fire: "fire", cafe: "cafe", forest: "forest", night: "night", train: "train" };
  const bufferCache = {};
  function loadBuffer(file) {
    if (bufferCache[file]) return Promise.resolve(bufferCache[file]);
    return fetch(`sounds/${file}.mp3`)
      .then((r) => { if (!r.ok) throw new Error("http " + r.status); return r.arrayBuffer(); })
      .then((arr) => ctx.decodeAudioData(arr))
      .then((buf) => { bufferCache[file] = buf; return buf; });
  }

  // ---- sound registry ------------------------------------------------------
  const SOUNDS = [
    { id: "brown", name: "Brown Noise", icon: "🟤", desc: "Deep low rumble" },
    { id: "pink", name: "Pink Noise", icon: "🌸", desc: "Balanced, soft" },
    { id: "white", name: "White Noise", icon: "⚪", desc: "Bright static" },
    { id: "rain", name: "Rain", icon: "🌧", desc: "Steady rainfall" },
    { id: "waves", name: "Ocean", icon: "🌊", desc: "Rolling waves" },
    { id: "wind", name: "Wind", icon: "🍃", desc: "Soft gusts" },
    { id: "fire", name: "Fireplace", icon: "🔥", desc: "Warm crackle" },
    { id: "hum", name: "Drone", icon: "🎚", desc: "Low warm pad" },
    { id: "cafe", name: "Café", icon: "☕", desc: "Room murmur" },
    { id: "forest", name: "Forest", icon: "🌲", desc: "Birdsong & leaves" },
    { id: "night", name: "Night", icon: "🌌", desc: "Crickets & calm" },
    { id: "train", name: "Train", icon: "🚆", desc: "Distant rhythm" },
  ];
  const channels = {}; // id -> { gain, vol, live }

  function setChannel(id, on) {
    ensureCtx();
    if (ctx.state === "suspended") ctx.resume();
    const ch = channels[id];
    if (on && !ch.live) {
      ch.gain.gain.cancelScheduledValues(ctx.currentTime);
      ch.gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      ch.gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, ch.vol), ctx.currentTime + 0.5);
      if (SAMPLE_IDS[id]) {
        // Async: fade the gain up now; the looped source joins once decoded.
        const live = {
          source: null, synthStop: null, stopped: false,
          stop() { this.stopped = true; if (this.source) stopAll([this.source]); if (this.synthStop) this.synthStop(); },
        };
        ch.live = live;
        loadBuffer(SAMPLE_IDS[id]).then((buf) => {
          if (live.stopped) return;
          const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
          src.connect(ch.gain); src.start();
          live.source = src;
        }).catch(() => {
          // sample unavailable → use the synth builder as a fallback
          if (live.stopped || !BUILDERS[id]) return;
          const built = buildChannel(id); built.entry.connect(ch.gain);
          live.synthStop = built.stop;
        });
      } else {
        const built = buildChannel(id);
        built.entry.connect(ch.gain);
        ch.live = built;
      }
    } else if (!on && ch.live) {
      const live = ch.live; ch.live = null;
      ch.gain.gain.cancelScheduledValues(ctx.currentTime);
      ch.gain.gain.setValueAtTime(ch.gain.gain.value, ctx.currentTime);
      ch.gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
      setTimeout(() => live.stop(), 450);
    }
    updateStatus();
  }
  function setVol(id, v) {
    const ch = channels[id]; ch.vol = v;
    if (ch.live && ctx) ch.gain.gain.setTargetAtTime(Math.max(0.0001, v), ctx.currentTime, 0.05);
  }
  const anyActive = () => Object.values(channels).some((c) => c.live);

  // ---- UI ------------------------------------------------------------------
  function render() {
    renderGrid(SOUNDS, "#ae-grid", 0.6);
    renderGrid(TONES, "#ae-tonegrid", 0.25);
  }
  function renderGrid(list, sel, defVol) {
    const grid = $(sel);
    grid.innerHTML = "";
    for (const s of list) {
      channels[s.id] = channels[s.id] || { gain: null, vol: defVol, live: null };
      const card = document.createElement("div");
      card.className = "ae-card" + (channels[s.id].live ? " on" : "");
      card.dataset.id = s.id;
      card.innerHTML = `
        <div class="ae-card-top">
          <div class="ae-ic">${s.icon}</div>
          <div><div class="nm">${s.name}</div><div class="ds">${s.desc}</div></div>
        </div>
        <input class="lvl" type="range" min="0" max="100" value="${Math.round(channels[s.id].vol * 100)}" />`;
      const lvl = card.querySelector(".lvl");
      card.addEventListener("click", (e) => {
        if (e.target === lvl) return;
        toggle(s.id, card);
      });
      lvl.addEventListener("input", () => setVol(s.id, +lvl.value / 100));
      lvl.addEventListener("pointerdown", (e) => e.stopPropagation());
      grid.appendChild(card);
    }
  }
  function toggle(id, card) {
    // lazily create the channel gain on first use
    ensureCtx();
    if (!channels[id].gain) { channels[id].gain = ctx.createGain(); channels[id].gain.gain.value = 0.0001; channels[id].gain.connect(master); }
    const on = !channels[id].live;
    setChannel(id, on);
    card.classList.toggle("on", on);
    syncPlay();
  }
  function stopAllChannels() {
    for (const s of [...SOUNDS, ...TONES]) {
      if (channels[s.id] && channels[s.id].live) setChannel(s.id, false);
      const card = document.querySelector(`.ae-card[data-id="${s.id}"]`);
      if (card) card.classList.remove("on");
    }
    document.querySelectorAll(".ae-preset.on").forEach((p) => p.classList.remove("on"));
    syncPlay();
  }

  // ---- presets -------------------------------------------------------------
  const PRESETS = [
    { name: "Deep Focus", mix: { brown: 0.7, hum: 0.3 } },
    { name: "Rainy Study", mix: { rain: 0.6, hum: 0.22 } },
    { name: "Flow", mix: { pink: 0.5, "tone-alpha": 0.25 } },
    { name: "Calm", mix: { waves: 0.6, wind: 0.3 } },
    { name: "Energize", mix: { white: 0.3, "tone-beta": 0.3 } },
    { name: "Cozy", mix: { fire: 0.6, brown: 0.3 } },
    { name: "Gamma Lock", mix: { brown: 0.5, "tone-gamma": 0.22 } },
  ];
  function applyPreset(preset, chip) {
    stopAllChannels();
    ensureCtx();
    if (ctx.state === "suspended") ctx.resume();
    for (const [id, vol] of Object.entries(preset.mix)) {
      if (!channels[id]) continue;
      if (!channels[id].gain) { channels[id].gain = ctx.createGain(); channels[id].gain.gain.value = 0.0001; channels[id].gain.connect(master); }
      channels[id].vol = vol;
      setChannel(id, true);
      const card = document.querySelector(`.ae-card[data-id="${id}"]`);
      if (card) { card.classList.add("on"); const lvl = card.querySelector(".lvl"); if (lvl) lvl.value = Math.round(vol * 100); }
    }
    document.querySelectorAll(".ae-preset.on").forEach((p) => p.classList.remove("on"));
    if (chip) chip.classList.add("on");
    syncPlay();
  }
  function renderPresets() {
    const wrap = $("#ae-presets");
    wrap.innerHTML = "";
    for (const p of PRESETS) {
      const chip = document.createElement("button");
      chip.className = "ae-preset";
      chip.textContent = p.name;
      chip.addEventListener("click", () => applyPreset(p, chip));
      wrap.appendChild(chip);
    }
  }
  $("#ae-tonemode").addEventListener("change", (e) => {
    toneMode = e.target.value;
    // rebuild any live tone with the new mode
    for (const t of TONES) {
      if (channels[t.id] && channels[t.id].live) { setChannel(t.id, false); setTimeout(() => setChannel(t.id, true), 480); }
    }
  });
  function syncPlay() {
    const playing = ctx && ctx.state === "running" && anyActive();
    $("#ae-play").textContent = playing ? "⏸" : "▶";
    $("#ae-play").classList.toggle("on", playing);
    notifyHost();
  }
  function updateStatus() {
    const n = Object.values(channels).filter((c) => c.live).length;
    $("#ae-status").textContent = n ? `${n} sound${n === 1 ? "" : "s"} layered` : "Tap a sound to begin";
    renderMiniActive();
    notifyHost();
  }

  // ---- mini player ---------------------------------------------------------
  const META = Object.fromEntries([...SOUNDS, ...TONES].map((s) => [s.id, s]));
  let mini = false;
  const FULL_H = 640; // matches the manifest panel height
  // Layout mode: "full" (panel), "mini" (compact panel), or "bar" (slim toolbar
  // row used by the singleton player). Host drives "bar"/"full"; the ⊟ button
  // drives "mini"/"full" for the desktop window.
  function applyMode(m) {
    const app = document.querySelector(".ae-app");
    app.classList.toggle("bar", m === "bar");
    app.classList.toggle("mini", m === "mini");
    mini = m === "mini";
    const b = $("#ae-mini"); if (b) { b.textContent = m === "full" ? "⊟" : "⊞"; b.title = m === "full" ? "Mini player" : "Expand"; }
    renderMiniActive();
    notifyHost();
  }
  function setMini(v) {
    applyMode(v ? "mini" : "full");
    // ask the host to shrink/restore the panel window to fit the mini layout
    try { parent.postMessage({ source: "aether", type: "request-resize", height: v ? 188 : FULL_H }, "*"); } catch (e) {}
  }
  function renderMiniActive() {
    const wrap = $("#ae-mini-active"); if (!wrap) return;
    const live = [...SOUNDS, ...TONES].filter((s) => channels[s.id] && channels[s.id].live);
    wrap.innerHTML = "";
    if (!live.length) {
      const h = document.createElement("span"); h.className = "ae-mini-empty"; h.textContent = "Nothing playing";
      wrap.appendChild(h);
    }
    for (const s of live) {
      const chip = document.createElement("button");
      chip.className = "ae-mini-chip";
      chip.innerHTML = `<span class="ic">${s.icon}</span><span class="nm">${s.name}</span><i>✕</i>`;
      chip.title = `Turn off ${s.name}`;
      chip.onclick = () => {
        setChannel(s.id, false);
        const card = document.querySelector(`.ae-card[data-id="${s.id}"]`); if (card) card.classList.remove("on");
        renderMiniActive(); syncPlay();
      };
      wrap.appendChild(chip);
    }
    const add = document.createElement("button");
    add.className = "ae-mini-chip add"; add.textContent = "＋ Add sounds";
    add.onclick = () => setMini(false);
    wrap.appendChild(add);
  }
  // Tell the host (Scry) about audio state — lets it keep a persistent mini
  // player alive across a desktop→cockpit switch instead of tearing the frame
  // (and the sound) down. Harmless no-op until the host listens.
  function notifyHost() {
    try {
      parent.postMessage({
        source: "aether", type: "audio-state",
        playing: !!(ctx && ctx.state === "running" && anyActive()),
        count: Object.values(channels).filter((c) => c.live).length,
        mini,
      }, "*");
    } catch (e) {}
  }

  // master play/pause: suspend/resume the whole context
  $("#ae-play").addEventListener("click", async () => {
    ensureCtx();
    if (!anyActive()) return; // nothing to play yet
    if (ctx.state === "running") await ctx.suspend();
    else await ctx.resume();
    syncPlay();
  });
  $("#ae-master").addEventListener("input", (e) => {
    $("#ae-master-v").textContent = e.target.value;
    if (master) master.gain.setTargetAtTime(+e.target.value / 100, ctx.currentTime, 0.05);
  });
  $("#ae-warmth").addEventListener("input", () => {
    if (masterLP && ctx) masterLP.frequency.setTargetAtTime(warmthFreq(), ctx.currentTime, 0.05);
  });
  $("#ae-stopall").addEventListener("click", stopAllChannels);
  $("#ae-mini").addEventListener("click", () => setMini(!mini));
  window.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    if (e.code === "Space") { e.preventDefault(); $("#ae-play").click(); }
    else if (e.key === "m" || e.key === "M") setMini(!mini);
  });
  // Host (Scry) → Aether commands, for a cockpit-mode mini player chrome.
  window.addEventListener("message", (e) => {
    const d = e.data; if (!d || d.target !== "aether") return;
    if (d.cmd === "mode") applyMode(d.value);
    else if (d.cmd === "hostchrome") document.body.classList.toggle("hosted", !!d.value);
    else if (d.cmd === "mini") setMini(!!d.value);
    else if (d.cmd === "toggle-play") $("#ae-play").click();
    else if (d.cmd === "stop") stopAllChannels();
    else if (d.cmd === "ping") notifyHost();
  });

  // ---- visualizer ----------------------------------------------------------
  const vc = $("#ae-viz"), vctx = vc.getContext("2d");
  let vizRAF = 0;
  function startViz() {
    if (vizRAF) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    const draw = () => {
      vizRAF = requestAnimationFrame(draw);
      const w = vc.width, h = vc.height;
      vctx.clearRect(0, 0, w, h);
      analyser.getByteFrequencyData(data);
      const bars = 48, step = Math.floor(data.length / bars);
      const bw = w / bars;
      for (let i = 0; i < bars; i++) {
        const v = data[i * step] / 255;
        const bh = Math.max(2, v * h);
        const x = i * bw;
        const grad = vctx.createLinearGradient(0, h, 0, h - bh);
        grad.addColorStop(0, "rgba(34,211,238,0.9)");
        grad.addColorStop(1, "rgba(139,125,255,0.5)");
        vctx.fillStyle = grad;
        vctx.fillRect(x + 1, h - bh, bw - 2, bh);
      }
    };
    draw();
  }

  // ---- focus timer (Pomodoro) ---------------------------------------------
  const timer = { running: false, phase: "focus", remaining: 25 * 60, focusMin: 25, breakMin: 5, intervalId: 0 };
  const fmtT = (s) => Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  function renderTimer() {
    $("#ae-t-time").textContent = fmtT(Math.max(0, timer.remaining));
    const ph = $("#ae-t-phase");
    ph.textContent = timer.phase; ph.classList.toggle("break", timer.phase === "break");
    $("#ae-t-start").textContent = timer.running ? "Pause" : "Start";
    $("#ae-t-start").classList.toggle("on", timer.running);
  }
  function setDurations() { const [f, b] = $("#ae-t-preset").value.split(",").map(Number); timer.focusMin = f; timer.breakMin = b; }
  function resetTimer() { stopTick(); timer.running = false; setDurations(); timer.phase = "focus"; timer.remaining = timer.focusMin * 60; renderTimer(); }
  function startTick() { if (timer.intervalId) return; timer.intervalId = setInterval(tick, 1000); }
  function stopTick() { clearInterval(timer.intervalId); timer.intervalId = 0; }
  function fadeMaster(to) { if (master && ctx) master.gain.setTargetAtTime(to, ctx.currentTime, 1.5); }
  function tick() {
    timer.remaining--;
    if (timer.remaining <= 0) {
      if (timer.phase === "focus") { timer.phase = "break"; timer.remaining = timer.breakMin * 60; fadeMaster(0); }
      else { timer.phase = "focus"; timer.remaining = timer.focusMin * 60; fadeMaster(+$("#ae-master").value / 100); }
    }
    renderTimer();
  }
  $("#ae-t-start").addEventListener("click", () => {
    timer.running = !timer.running;
    if (timer.running) { if (timer.remaining <= 0) { setDurations(); timer.remaining = timer.focusMin * 60; } startTick(); }
    else stopTick();
    renderTimer();
  });
  $("#ae-t-reset").addEventListener("click", () => { resetTimer(); fadeMaster(+$("#ae-master").value / 100); });
  $("#ae-t-preset").addEventListener("change", () => { if (!timer.running) resetTimer(); });

  // ---- boot ----------------------------------------------------------------
  render();
  renderPresets();
  renderTimer();
  updateStatus();
})();
