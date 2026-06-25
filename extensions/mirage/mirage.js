/* ============================================================================
 * Mirage — a social video studio (original implementation).
 * Vanilla JS; runs sandboxed in the Scry extension frame.
 *
 * Model:
 *   proj.clips[]  main video/image track, played sequentially
 *   proj.texts[]  time-ranged text + caption overlays
 *   proj.audios   audio clips (music + voiceover): placed, trimmed, faded
 * Preview renders the active clip + overlays to a <canvas> on a master clock.
 * Export records that same render in real time via MediaRecorder (canvas
 * captureStream + a WebAudio mix), then downloads the file.
 * ==========================================================================*/
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const uid = (() => { let n = 0; return () => "x" + (++n); })();

  // ---- project state ------------------------------------------------------
  const proj = {
    w: 1080, h: 1920, fps: 30,
    bg: "#000000",
    clips: [],   // {id,type:'video'|'image',name,url,el,natW,natH,fit,trimIn,trimOut,dur,volume}
    texts: [],   // {id,kind:'text'|'caption',text,start,end,xr,yr,size,color,bg,font,weight,align}
    overlays: [],// {id,type:'video'|'image',name,url,el,natW,natH,start,end,xr,yr,scale,opacity,rounded,shadow,trimIn,volume}
    audios: [],  // {id,name,url,el,start,trimIn,trimOut,duration,volume,fadeIn,fadeOut} — music + voiceover
  };
  let library = []; // imported assets {id,type,name,url,el,natW,natH,duration}
  let cur = 0;      // playhead seconds
  let playing = false;
  let sel = null;   // {kind:'clip'|'text'|'audio', id}
  let pxPerSec = 60;

  // ---- audio graph (built lazily; preview + export share it) --------------
  let actx = null, streamDest = null;
  const wiredEls = new WeakSet();
  function audioCtx() {
    if (!actx) {
      actx = new (window.AudioContext || window.webkitAudioContext)();
      streamDest = actx.createMediaStreamDestination();
    }
    return actx;
  }
  /** Route a media element's audio through the graph: to speakers AND to the
   * export stream. Done once per element (createMediaElementSource is one-shot). */
  function wireAudio(el, gainRef) {
    if (wiredEls.has(el)) return;
    const ctx = audioCtx();
    let src;
    try { src = ctx.createMediaElementSource(el); } catch (e) { return; }
    const gain = ctx.createGain();
    gain.gain.value = gainRef ? gainRef() : 1;
    src.connect(gain);
    gain.connect(ctx.destination);
    gain.connect(streamDest);
    el._gain = gain;
    wiredEls.add(el);
  }

  // ---- canvas -------------------------------------------------------------
  const canvas = $("#mi-canvas");
  const ctx = canvas.getContext("2d");

  function applyFormat(wh) {
    const [w, h] = wh.split("x").map(Number);
    proj.w = w; proj.h = h;
    canvas.width = w; canvas.height = h;
    // CSS: fit within the wrap while preserving aspect
    fitCanvasCss();
    drawFrame(cur);
  }
  function fitCanvasCss() {
    const wrap = $(".mi-canvas-wrap");
    const aw = wrap.clientWidth - 28, ah = wrap.clientHeight - 28;
    const s = Math.min(aw / proj.w, ah / proj.h);
    canvas.style.width = Math.max(40, proj.w * s) + "px";
    canvas.style.height = Math.max(40, proj.h * s) + "px";
  }

  // ---- timeline math ------------------------------------------------------
  const IMG_DEFAULT = 4; // seconds for a still image
  // Default visual-effect fields stamped onto every new clip.
  const clipFx = () => ({ scale: 1, ox: 0, oy: 0, brightness: 100, contrast: 100, saturate: 100, hue: 0, sepia: 0, grayscale: 0, blur: 0, look: "None", fadeIn: 0, fadeOut: 0, kenBurns: false, trans: { type: "none", dur: 0.5 } });
  // One-click colour grades (set the underlying adjust fields).
  const LOOKS = {
    None:    { brightness: 100, contrast: 100, saturate: 100, hue: 0, sepia: 0, grayscale: 0 },
    Vivid:   { brightness: 103, contrast: 110, saturate: 135, hue: 0, sepia: 0, grayscale: 0 },
    Punch:   { brightness: 100, contrast: 125, saturate: 120, hue: 0, sepia: 0, grayscale: 0 },
    Warm:    { brightness: 104, contrast: 102, saturate: 110, hue: 0, sepia: 25, grayscale: 0 },
    Cool:    { brightness: 102, contrast: 102, saturate: 112, hue: -12, sepia: 0, grayscale: 0 },
    Vintage: { brightness: 105, contrast: 90, saturate: 85, hue: 0, sepia: 45, grayscale: 0 },
    Fade:    { brightness: 108, contrast: 85, saturate: 90, hue: 0, sepia: 10, grayscale: 0 },
    "B&W":   { brightness: 100, contrast: 112, saturate: 100, hue: 0, sepia: 0, grayscale: 100 },
    Noir:    { brightness: 95, contrast: 138, saturate: 100, hue: 0, sepia: 0, grayscale: 100 },
  };
  function applyLook(c, name) { const L = LOOKS[name]; if (!L) return; Object.assign(c, L); c.look = name; }
  // Video playback length honours speed: a 10s source at 2× lasts 5s.
  function clipDur(c) { return c.type === "image" ? c.dur : Math.max(0.05, (c.trimOut - c.trimIn) / (c.speed || 1)); }
  // Audio-clip helpers (placed segment on the audio track).
  const audioLen = (a) => Math.max(0.05, (a.trimOut ?? a.duration ?? 0) - (a.trimIn || 0));
  const audioEnd = (a) => (a.start || 0) + audioLen(a);
  // Volume multiplier at timeline time t (per-clip fade in/out envelope).
  function audioGain(a, t) {
    const lt = t - (a.start || 0), len = audioLen(a);
    let g = a.volume ?? 1;
    const fi = a.fadeIn || 0, fo = a.fadeOut || 0;
    if (fi > 0 && lt < fi) g *= clamp(lt / fi, 0, 1);
    if (fo > 0 && lt > len - fo) g *= clamp((len - lt) / fo, 0, 1);
    return g;
  }
  /** Overlap (s) between clip i and i+1 caused by clip i's outgoing transition.
   *  Capped so it can't exceed either neighbour's length. 0 when no transition. */
  function overlapAfter(i) {
    const c = proj.clips[i], n = proj.clips[i + 1];
    if (!c || !n || !c.trans || c.trans.type === "none") return 0;
    return clamp(c.trans.dur || 0, 0, Math.min(clipDur(c), clipDur(n)) - 0.05);
  }
  /** Cumulative start time of every clip, with transitions pulling the next clip
   *  back by the overlap. Returns an array parallel to proj.clips. */
  function clipStarts() {
    const out = []; let t = 0;
    for (let i = 0; i < proj.clips.length; i++) { out[i] = t; t += clipDur(proj.clips[i]) - overlapAfter(i); }
    return out;
  }
  function clipStart(i) { return clipStarts()[i] || 0; }
  function timelineEnd() {
    const starts = clipStarts(); const n = proj.clips.length;
    return n ? starts[n - 1] + clipDur(proj.clips[n - 1]) : 0;
  }
  function totalDur() {
    let t = timelineEnd();
    for (const tx of proj.texts) t = Math.max(t, tx.end);
    for (const ov of proj.overlays) t = Math.max(t, ov.end);
    for (const a of proj.audios) t = Math.max(t, audioEnd(a));
    return t;
  }
  /** All clips visible at time t (one normally; two inside a transition). */
  function activeClips(t) {
    const starts = clipStarts(), out = [];
    for (let i = 0; i < proj.clips.length; i++) {
      const s = starts[i], d = clipDur(proj.clips[i]), last = i === proj.clips.length - 1;
      if (t >= s && (t < s + d || (last && t <= s + d))) out.push({ clip: proj.clips[i], i, local: clamp(t - s, 0, d) });
    }
    return out;
  }
  /** Topmost (latest-starting) clip at t — used by split. */
  function clipAt(t) { const a = activeClips(t); return a.length ? a[a.length - 1] : null; }
  /** Opacity for clip i at time t: per-clip fade envelope × transition envelope. */
  function clipAlpha(i, t, starts) {
    const c = proj.clips[i], s = starts[i], d = clipDur(c), e = s + d;
    let a = clipFadeAlpha(c, t - s, d);
    const ovIn = overlapAfter(i - 1); // shared with previous clip
    if (ovIn > 0 && t < s + ovIn) {
      const type = proj.clips[i - 1].trans.type, p = clamp((t - s) / ovIn, 0, 1);
      a *= type === "dip" ? clamp((t - (s + ovIn / 2)) / (ovIn / 2), 0, 1) : p;
    }
    const ovOut = overlapAfter(i);
    if (ovOut > 0 && t > e - ovOut) {
      const type = c.trans.type, p = clamp((e - t) / ovOut, 0, 1);
      a *= type === "dip" ? clamp(((e - ovOut / 2) - t) / (ovOut / 2), 0, 1) : p;
    }
    return clamp(a, 0, 1);
  }

  // ---- rendering ----------------------------------------------------------
  const easeOut = (p) => 1 - Math.pow(1 - p, 3);
  let showGuides = false; // rule-of-thirds + safe-area overlay (preview only)
  let exporting = false;  // suppresses guides while recording

  // CSS filter string for a clip's colour adjustments, or "none".
  function clipFilter(c) {
    const f = [];
    if ((c.brightness ?? 100) !== 100) f.push(`brightness(${c.brightness}%)`);
    if ((c.contrast ?? 100) !== 100) f.push(`contrast(${c.contrast}%)`);
    if ((c.saturate ?? 100) !== 100) f.push(`saturate(${c.saturate}%)`);
    if ((c.hue ?? 0) !== 0) f.push(`hue-rotate(${c.hue}deg)`);
    if ((c.sepia ?? 0) > 0) f.push(`sepia(${c.sepia}%)`);
    if ((c.grayscale ?? 0) > 0) f.push(`grayscale(${c.grayscale}%)`);
    if ((c.blur ?? 0) > 0) f.push(`blur(${c.blur}px)`);
    return f.length ? f.join(" ") : "none";
  }
  // Fade-in/out envelope (toward the background) for the active clip.
  function clipFadeAlpha(c, localT, dur) {
    let a = 1;
    const fi = c.fadeIn ?? 0, fo = c.fadeOut ?? 0;
    if (fi > 0 && localT < fi) a = Math.min(a, localT / fi);
    if (fo > 0 && localT > dur - fo) a = Math.min(a, (dur - localT) / fo);
    return clamp(a, 0, 1);
  }
  function drawClip(c, localT, dur) {
    const media = c.el;
    const mw = c.type === "image" ? c.natW : (c.natW || media.videoWidth);
    const mh = c.type === "image" ? c.natH : (c.natH || media.videoHeight);
    if (!mw || !mh) return;
    const cw = proj.w, ch = proj.h;
    let sc = c.fit === "contain" ? Math.min(cw / mw, ch / mh) : Math.max(cw / mw, ch / mh);
    // user zoom + Ken Burns (a slow zoom across the clip's life)
    let kb = 1;
    if (c.kenBurns) kb = 1 + 0.2 * clamp(localT / Math.max(0.1, dur), 0, 1);
    sc *= (c.scale || 1) * kb;
    const w = mw * sc, h = mh * sc;
    const ox = (c.ox || 0) * cw, oy = (c.oy || 0) * ch;
    ctx.save();
    ctx.filter = clipFilter(c);
    ctx.drawImage(media, (cw - w) / 2 + ox, (ch - h) / 2 + oy, w, h);
    ctx.restore();
  }
  function drawGuides() {
    ctx.save();
    ctx.lineWidth = Math.max(1, proj.w / 540);
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    for (let i = 1; i < 3; i++) {
      const x = (proj.w * i) / 3, y = (proj.h * i) / 3;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, proj.h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(proj.w, y); ctx.stroke();
    }
    ctx.strokeStyle = "rgba(34,211,238,0.5)";
    const mx = proj.w * 0.05, my = proj.h * 0.05;
    ctx.strokeRect(mx, my, proj.w - 2 * mx, proj.h - 2 * my);
    ctx.restore();
  }
  function drawFrame(t) {
    ctx.fillStyle = proj.bg;
    ctx.fillRect(0, 0, proj.w, proj.h);
    // active clips, drawn outgoing→incoming so the incoming one lands on top
    const starts = clipStarts();
    for (const { clip: c, i, local } of activeClips(t)) {
      const a = clipAlpha(i, t, starts);
      if (a <= 0) continue;
      ctx.save();
      ctx.globalAlpha = a;
      try {
        if (c.type === "image" || c.el.readyState >= 2) drawClip(c, local, clipDur(c));
      } catch (e) { /* not decoded yet */ }
      ctx.restore();
    }
    // PiP / logo overlays (above the main track, below text)
    for (const ov of proj.overlays) {
      if (t >= ov.start && t < ov.end) drawOverlay(ov);
    }
    // text + captions on top
    for (const tx of proj.texts) {
      if (t >= tx.start && t < tx.end) drawText(tx, t);
    }
    if (showGuides && !exporting) drawGuides();
  }
  function drawOverlay(ov) {
    const el = ov.el;
    const mw = ov.type === "image" ? ov.natW : (ov.natW || el.videoWidth);
    const mh = ov.type === "image" ? ov.natH : (ov.natH || el.videoHeight);
    if (!mw || !mh) return;
    if (ov.type === "video" && el.readyState < 2) return;
    const w = (ov.scale || 0.35) * proj.w, h = w * (mh / mw);
    const x = (ov.xr ?? 0.5) * proj.w - w / 2, y = (ov.yr ?? 0.5) * proj.h - h / 2;
    const r = ov.rounded > 0 ? Math.min(w, h) * ov.rounded : 0;
    ctx.save();
    ctx.globalAlpha = ov.opacity ?? 1;
    if (ov.shadow) {
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.45)"; ctx.shadowBlur = Math.max(8, w * 0.04); ctx.shadowOffsetY = h * 0.02;
      ctx.fillStyle = "#000"; roundRect(x, y, w, h, r); ctx.fill();
      ctx.restore();
    }
    if (r > 0) { roundRect(x, y, w, h, r); ctx.clip(); }
    try { ctx.drawImage(el, x, y, w, h); } catch (e) {}
    ctx.restore();
  }
  function drawText(tx, t) {
    const x = tx.xr * proj.w, y = tx.yr * proj.h;
    const size = tx.size * proj.h / 1000; // size is per-1000px of height
    // intro/outro animation envelope
    const dur = Math.max(0.001, tx.end - tx.start);
    const local = t == null ? dur : t - tx.start;
    const anim = tx.anim || "none";
    const ad = Math.min(tx.animDur ?? 0.45, dur / 2);
    let alpha = 1, scale = 1, dy = 0, typeP = 1;
    if (anim !== "none" && ad > 0) {
      const pin = clamp(local / ad, 0, 1), pout = clamp((dur - local) / ad, 0, 1);
      const p = Math.min(pin, pout);
      if (anim === "fade") alpha = p;
      else if (anim === "pop") { alpha = p; scale = 0.7 + 0.3 * easeOut(p); }
      else if (anim === "slide") { alpha = p; dy = (1 - easeOut(pin)) * proj.h * 0.05; }
      else if (anim === "type") { typeP = pin; }
    }
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.translate(x, y + dy);
    if (scale !== 1) ctx.scale(scale, scale);
    ctx.font = `${tx.weight} ${size}px ${tx.font}`;
    ctx.textAlign = tx.align;
    ctx.textBaseline = "middle";
    const shown = anim === "type" ? tx.text.slice(0, Math.ceil(tx.text.length * typeP)) : tx.text;
    const lines = wrapText(shown, proj.w * 0.9, size);
    const lh = size * 1.18;
    const totalH = lines.length * lh;
    let yy = -totalH / 2 + lh / 2;
    for (const line of lines) {
      const m = ctx.measureText(line);
      if (tx.bg && tx.bg !== "none") {
        const padX = size * 0.32, padY = size * 0.16;
        let bx = 0;
        if (tx.align === "center") bx = -m.width / 2;
        else if (tx.align === "right") bx = -m.width;
        ctx.fillStyle = tx.bg;
        roundRect(bx - padX, yy - lh / 2 - padY + (lh - size) / 2, m.width + padX * 2, size + padY * 2, size * 0.18);
        ctx.fill();
      }
      ctx.fillStyle = tx.color;
      ctx.lineWidth = size * 0.12;
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      if (!tx.bg || tx.bg === "none") ctx.strokeText(line, 0, yy);
      ctx.fillText(line, 0, yy);
      yy += lh;
    }
    ctx.restore();
  }
  function wrapText(text, maxW, size) {
    const words = String(text).split(/\s+/);
    const lines = []; let line = "";
    for (const w of words) {
      const test = line ? line + " " + w : w;
      if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = w; }
      else line = test;
    }
    if (line) lines.push(line);
    return lines.length ? lines : [""];
  }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ---- playback -----------------------------------------------------------
  let rafId = 0, wallStart = 0, projStart = 0;
  function syncMediaTo(t, playState) {
    const active = activeClips(t); // 1, or 2 during a transition
    // drive every active video; pause the rest
    for (const c of proj.clips) {
      if (c.type !== "video") continue;
      const a = active.find((x) => x.clip === c);
      if (a) {
        const sp = c.speed || 1;
        if (c.el.playbackRate !== sp) { try { c.el.playbackRate = sp; } catch (e) {} }
        const want = c.trimIn + a.local * sp;
        if (Math.abs(c.el.currentTime - want) > 0.25 * sp) { try { c.el.currentTime = want; } catch (e) {} }
        if (playState && c.el.paused) c.el.play().catch(() => {});
        if (!playState && !c.el.paused) c.el.pause();
      } else if (!c.el.paused) c.el.pause();
    }
    // overlay videos: play within their time range, seek to local time
    for (const ov of proj.overlays) {
      if (ov.type !== "video" || !ov.el) continue;
      const on = t >= ov.start && t < ov.end;
      if (on) {
        const want = (ov.trimIn || 0) + (t - ov.start);
        if (Math.abs(ov.el.currentTime - want) > 0.25) { try { ov.el.currentTime = want; } catch (e) {} }
        if (playState && ov.el.paused) ov.el.play().catch(() => {});
        if (!playState && !ov.el.paused) ov.el.pause();
      } else if (!ov.el.paused) ov.el.pause();
    }
    // audio clips: music + voiceover, each placed/trimmed, with live fade gain
    for (const a of proj.audios) {
      const el = a.el; if (!el) continue;
      const on = t >= (a.start || 0) && t < audioEnd(a);
      if (on) {
        if (el._gain) el._gain.gain.value = audioGain(a, t);
        const want = (a.trimIn || 0) + (t - (a.start || 0));
        if (Math.abs(el.currentTime - want) > 0.3) { try { el.currentTime = Math.min(want, el.duration || want); } catch (e) {} }
        if (playState && el.paused) el.play().catch(() => {});
        if (!playState && !el.paused) el.pause();
      } else if (!el.paused) el.pause();
    }
  }
  function tick() {
    const dur = totalDur();
    cur = projStart + (performance.now() - wallStart) / 1000;
    if (cur >= dur) { cur = dur; stop(); drawFrame(cur); updateTime(); return; }
    syncMediaTo(cur, true);
    drawFrame(cur);
    updateTime();
    rafId = requestAnimationFrame(tick);
  }
  function play() {
    if (playing) return;
    if (totalDur() <= 0) return;
    if (cur >= totalDur() - 0.01) cur = 0;
    if (actx && actx.state === "suspended") actx.resume();
    playing = true;
    $("#mi-play").textContent = "⏸";
    wallStart = performance.now(); projStart = cur;
    syncMediaTo(cur, true);
    rafId = requestAnimationFrame(tick);
  }
  function stop() {
    playing = false;
    $("#mi-play").textContent = "▶";
    cancelAnimationFrame(rafId);
    syncMediaTo(cur, false);
  }
  function seek(t) {
    cur = clamp(t, 0, totalDur());
    if (playing) { wallStart = performance.now(); projStart = cur; }
    syncMediaTo(cur, playing);
    drawFrame(cur);
    updateTime();
  }
  function updateTime() {
    $("#mi-cur").textContent = fmt(cur);
    $("#mi-dur").textContent = fmt(totalDur());
    $("#mi-scrub").value = String(Math.round((cur / Math.max(0.001, totalDur())) * 1000));
    const ph = $("#mi-playhead");
    ph.style.left = cur * pxPerSec + "px";
    renderRuler();
  }
  function fmt(s) {
    s = Math.max(0, s);
    const m = Math.floor(s / 60), sec = Math.floor(s % 60), d = Math.floor((s * 10) % 10);
    return `${m}:${String(sec).padStart(2, "0")}.${d}`;
  }

  // ---- import -------------------------------------------------------------
  const fileInput = document.createElement("input");
  fileInput.type = "file"; fileInput.accept = "video/*,image/*,audio/*"; fileInput.multiple = true; fileInput.style.display = "none";
  document.body.appendChild(fileInput);
  fileInput.onchange = () => { [...fileInput.files].forEach(importFile); fileInput.value = ""; };

  function importFile(file) {
    const url = URL.createObjectURL(file);
    const kind = file.type.startsWith("video") ? "video" : file.type.startsWith("audio") ? "audio" : "image";
    const asset = { id: uid(), type: kind, name: file.name, url, el: null, natW: 0, natH: 0, duration: 0, thumb: null };
    if (kind === "image") {
      const img = new Image();
      img.onload = () => { asset.el = img; asset.natW = img.naturalWidth; asset.natH = img.naturalHeight; asset.thumb = url; renderLibrary(); };
      img.src = url;
    } else if (kind === "video") {
      const v = document.createElement("video");
      v.src = url; v.preload = "auto"; v.muted = false; v.playsInline = true;
      v.onloadedmetadata = () => { asset.natW = v.videoWidth; asset.natH = v.videoHeight; asset.duration = v.duration; makeVideoThumb(v, asset); renderLibrary(); };
      asset.el = v;
    } else {
      const a = document.createElement("audio");
      a.src = url; a.preload = "auto";
      a.onloadedmetadata = () => { asset.duration = a.duration; renderLibrary(); };
      asset.el = a;
    }
    library.push(asset);
    renderLibrary();
  }

  // ---- overlays (PiP / logo / watermark) ----------------------------------
  const overlayFx = () => ({ scale: 0.32, xr: 0.74, yr: 0.24, opacity: 1, rounded: 0.06, shadow: true });
  const overlayInput = document.createElement("input");
  overlayInput.type = "file"; overlayInput.accept = "video/*,image/*"; overlayInput.style.display = "none";
  document.body.appendChild(overlayInput);
  overlayInput.onchange = () => { const f = overlayInput.files[0]; if (f) addOverlayFromFile(f); overlayInput.value = ""; };
  function addOverlayFromFile(file) {
    if (file.type.startsWith("audio")) { toast("Overlays must be image or video", "err"); return; }
    const url = URL.createObjectURL(file);
    const type = file.type.startsWith("video") ? "video" : "image";
    const dur = totalDur();
    const ov = { id: uid(), type, name: file.name, url, el: null, natW: 0, natH: 0,
      start: cur, end: Math.min(dur > 0 ? dur : cur + 5, cur + 5) || cur + 5, trimIn: 0, volume: 0, ...overlayFx() };
    if (ov.end <= ov.start) ov.end = ov.start + 5;
    if (type === "image") {
      const img = new Image();
      img.onload = () => { ov.natW = img.naturalWidth; ov.natH = img.naturalHeight; refreshAll(); };
      img.src = url; ov.el = img;
    } else {
      const v = document.createElement("video"); v.src = url; v.preload = "auto"; v.playsInline = true; v.crossOrigin = "anonymous";
      ov.el = v;
      v.onloadedmetadata = () => { ov.natW = v.videoWidth; ov.natH = v.videoHeight; if (!ov.end || ov.end <= ov.start) ov.end = ov.start + Math.min(v.duration || 5, 5); wireAudio(v, () => ov.volume); refreshAll(); };
      wireAudio(v, () => ov.volume);
    }
    proj.overlays.push(ov);
    select("overlay", ov.id);
    refreshAll(); commit();
    toast(`Added ${type} overlay`, "ok");
  }
  function makeVideoThumb(v, asset) {
    const grab = () => {
      const c = document.createElement("canvas"); c.width = 92; c.height = 60;
      try { c.getContext("2d").drawImage(v, 0, 0, 92, 60); asset.thumb = c.toDataURL(); renderLibrary(); } catch (e) {}
      v.removeEventListener("seeked", grab);
    };
    v.addEventListener("seeked", grab);
    try { v.currentTime = Math.min(0.1, (v.duration || 1) / 2); } catch (e) {}
  }

  function addLibraryToTimeline(asset) {
    if (asset.type === "audio") {
      const a = document.createElement("audio"); a.src = asset.url; a.preload = "auto"; a.crossOrigin = "anonymous";
      const clip = { id: uid(), name: asset.name, url: asset.url, el: a, start: cur, trimIn: 0, trimOut: asset.duration || 0, duration: asset.duration || 0, volume: 1, fadeIn: 0, fadeOut: 0 };
      a.onloadedmetadata = () => { if (!clip.trimOut) { clip.trimOut = a.duration; clip.duration = a.duration; } wireAudio(a, () => clip.volume); refreshAll(); };
      wireAudio(a, () => clip.volume);
      proj.audios.push(clip);
      select("audio", clip.id);
      toast(`Added audio: ${asset.name}`, "ok");
    } else if (asset.type === "image") {
      proj.clips.push({ id: uid(), type: "image", name: asset.name, url: asset.url, el: asset.el, natW: asset.natW, natH: asset.natH, fit: "cover", dur: IMG_DEFAULT, ...clipFx() });
    } else {
      // fresh <video> per clip so the same source can appear multiple times / be trimmed independently
      const v = document.createElement("video"); v.src = asset.url; v.preload = "auto"; v.playsInline = true; v.crossOrigin = "anonymous";
      const clip = { id: uid(), type: "video", name: asset.name, url: asset.url, el: v, natW: asset.natW, natH: asset.natH, fit: "cover", trimIn: 0, trimOut: asset.duration || 5, volume: 1, speed: 1, ...clipFx() };
      v.onloadedmetadata = () => { clip.natW = v.videoWidth; clip.natH = v.videoHeight; if (!clip.trimOut) clip.trimOut = v.duration; wireAudio(v, () => clip.volume); refreshAll(); };
      wireAudio(v, () => clip.volume);
      proj.clips.push(clip);
    }
    refreshAll();
    commit();
  }

  // ---- library / timeline rendering --------------------------------------
  function renderLibrary() {
    const box = $("#mi-media"); box.innerHTML = "";
    $("#mi-lib-count").textContent = library.length ? `(${library.length})` : "";
    for (const a of library) {
      const el = document.createElement("div");
      el.className = "mi-item";
      const thumb = a.thumb ? `<img class="thumb" src="${a.thumb}">` : `<div class="thumb" style="display:grid;place-items:center;color:#6a7799">${a.type === "audio" ? "♪" : "▦"}</div>`;
      const sub = a.type === "audio" || a.type === "video" ? `${a.type} · ${a.duration ? a.duration.toFixed(1) + "s" : "…"}` : `image · ${a.natW}×${a.natH}`;
      el.innerHTML = `${thumb}<div class="meta"><div class="nm">${esc(a.name)}</div><div class="sub">${sub}</div></div><span class="add">＋</span>`;
      el.onclick = () => addLibraryToTimeline(a);
      box.appendChild(el);
    }
  }
  function renderRuler() {
    const ruler = $("#mi-ruler"); const dur = Math.max(totalDur(), 4);
    const step = pxPerSec < 40 ? 5 : pxPerSec < 90 ? 2 : 1;
    let html = "";
    for (let s = 0; s <= dur + step; s += step) {
      html += `<span class="mi-tick" style="left:${s * pxPerSec}px">${s}s<i></i></span>`;
    }
    ruler.innerHTML = html;
    $("#mi-tracks").style.minWidth = (dur + 4) * pxPerSec + "px";
  }
  function renderTracks() {
    const main = $("#mi-track-main"), text = $("#mi-track-text"), audio = $("#mi-track-audio"), over = $("#mi-track-overlay");
    main.querySelectorAll(".mi-clip").forEach((e) => e.remove());
    text.querySelectorAll(".mi-clip").forEach((e) => e.remove());
    audio.querySelectorAll(".mi-clip").forEach((e) => e.remove());
    if (over) over.querySelectorAll(".mi-clip").forEach((e) => e.remove());
    proj.clips.forEach((c, i) => {
      const d = document.createElement("div");
      d.className = `mi-clip ${c.type}${sel && sel.kind === "clip" && sel.id === c.id ? " on" : ""}`;
      d.style.left = clipStart(i) * pxPerSec + "px";
      d.style.width = Math.max(18, clipDur(c) * pxPerSec - 2) + "px";
      d.innerHTML = `<span class="cn">${esc(c.name)}</span>`;
      d.onclick = (e) => { e.stopPropagation(); select("clip", c.id); };
      enableClipDrag(d, c);
      addTrimHandles(d, c, "clip");
      main.appendChild(d);
    });
    for (const tx of proj.texts) {
      const d = document.createElement("div");
      d.className = `mi-clip text${sel && sel.kind === "text" && sel.id === tx.id ? " on" : ""}`;
      d.style.left = tx.start * pxPerSec + "px";
      d.style.width = Math.max(18, (tx.end - tx.start) * pxPerSec - 2) + "px";
      d.innerHTML = `<span class="cn">${tx.kind === "caption" ? "⌷ " : "T "}${esc(tx.text.slice(0, 18))}</span>`;
      d.onclick = (e) => { e.stopPropagation(); select("text", tx.id); };
      enableTextDrag(d, tx);
      addTrimHandles(d, tx, "text");
      text.appendChild(d);
    }
    if (over) for (const ov of proj.overlays) {
      const d = document.createElement("div");
      d.className = `mi-clip overlay${sel && sel.kind === "overlay" && sel.id === ov.id ? " on" : ""}`;
      d.style.left = ov.start * pxPerSec + "px";
      d.style.width = Math.max(18, (ov.end - ov.start) * pxPerSec - 2) + "px";
      d.innerHTML = `<span class="cn">▣ ${esc(ov.name.slice(0, 16))}</span>`;
      d.onclick = (e) => { e.stopPropagation(); select("overlay", ov.id); };
      enableOverlayDrag(d, ov);
      addTrimHandles(d, ov, "overlay");
      over.appendChild(d);
    }
    for (const a of proj.audios) {
      const d = document.createElement("div");
      d.className = `mi-clip audio${sel && sel.kind === "audio" && sel.id === a.id ? " on" : ""}`;
      d.style.left = (a.start || 0) * pxPerSec + "px";
      d.style.width = Math.max(18, audioLen(a) * pxPerSec - 2) + "px";
      d.innerHTML = `<span class="cn">♪ ${esc(a.name.slice(0, 16))}</span>`;
      d.onclick = (e) => { e.stopPropagation(); select("audio", a.id); };
      enableAudioDrag(d, a);
      addTrimHandles(d, a, "audio");
      audio.appendChild(d);
    }
  }
  // drag a main clip left/right to reorder (snaps by position)
  function enableClipDrag(d, c) {
    let sx = 0, moved = false;
    d.addEventListener("pointerdown", (e) => {
      sx = e.clientX; moved = false; d.setPointerCapture(e.pointerId);
      const move = (ev) => {
        if (Math.abs(ev.clientX - sx) > 6) moved = true;
        if (!moved) return;
        const idx = proj.clips.indexOf(c);
        const dx = ev.clientX - sx;
        if (dx > pxPerSec * clipDur(c) * 0.6 && idx < proj.clips.length - 1) { swapClips(idx, idx + 1); sx = ev.clientX; }
        else if (dx < -pxPerSec * clipDur(c) * 0.6 && idx > 0) { swapClips(idx, idx - 1); sx = ev.clientX; }
      };
      const up = (ev) => { d.removeEventListener("pointermove", move); d.removeEventListener("pointerup", up); try { d.releasePointerCapture(ev.pointerId); } catch (e) {} if (moved) commit(); };
      d.addEventListener("pointermove", move);
      d.addEventListener("pointerup", up);
    });
  }
  function swapClips(a, b) { const t = proj.clips[a]; proj.clips[a] = proj.clips[b]; proj.clips[b] = t; refreshAll(); }
  // drag a text/caption block to move its time
  function enableTextDrag(d, tx) {
    d.addEventListener("pointerdown", (e) => {
      const sx = e.clientX, s0 = tx.start, len = tx.end - tx.start; d.setPointerCapture(e.pointerId);
      const move = (ev) => { const ns = snapTime(Math.max(0, s0 + (ev.clientX - sx) / pxPerSec), tx.id); tx.start = ns; tx.end = ns + len; renderTracks(); if (sel && sel.id === tx.id) renderProps(); };
      const up = (ev) => { d.removeEventListener("pointermove", move); d.removeEventListener("pointerup", up); try { d.releasePointerCapture(ev.pointerId); } catch (e) {} drawFrame(cur); commit(); };
      d.addEventListener("pointermove", move); d.addEventListener("pointerup", up);
    });
  }
  // drag an overlay block to move its time range
  function enableOverlayDrag(d, ov) {
    d.addEventListener("pointerdown", (e) => {
      const sx = e.clientX, s0 = ov.start, len = ov.end - ov.start; d.setPointerCapture(e.pointerId);
      const move = (ev) => { const ns = snapTime(Math.max(0, s0 + (ev.clientX - sx) / pxPerSec), ov.id); ov.start = ns; ov.end = ns + len; renderTracks(); if (sel && sel.id === ov.id) renderProps(); };
      const up = (ev) => { d.removeEventListener("pointermove", move); d.removeEventListener("pointerup", up); try { d.releasePointerCapture(ev.pointerId); } catch (e) {} drawFrame(cur); commit(); };
      d.addEventListener("pointermove", move); d.addEventListener("pointerup", up);
    });
  }
  // drag an audio clip to move its start time
  function enableAudioDrag(d, a) {
    d.addEventListener("pointerdown", (e) => {
      const sx = e.clientX, s0 = a.start || 0; d.setPointerCapture(e.pointerId);
      const move = (ev) => { a.start = snapTime(Math.max(0, s0 + (ev.clientX - sx) / pxPerSec), a.id); renderTracks(); if (sel && sel.id === a.id) renderProps(); };
      const up = (ev) => { d.removeEventListener("pointermove", move); d.removeEventListener("pointerup", up); try { d.releasePointerCapture(ev.pointerId); } catch (e) {} updateTime(); commit(); };
      d.addEventListener("pointermove", move); d.addEventListener("pointerup", up);
    });
  }

  // ---- snapping ------------------------------------------------------------
  // Significant times other blocks can snap to: 0, the playhead, and every
  // clip / overlay / audio / text edge (excluding the item being dragged).
  function snapPoints(excludeId) {
    const pts = [0, cur];
    const starts = clipStarts();
    proj.clips.forEach((c, i) => { pts.push(starts[i], starts[i] + clipDur(c)); });
    proj.overlays.forEach((o) => { if (o.id !== excludeId) pts.push(o.start, o.end); });
    proj.audios.forEach((a) => { if (a.id !== excludeId) pts.push(a.start || 0, audioEnd(a)); });
    proj.texts.forEach((t) => { if (t.id !== excludeId) pts.push(t.start, t.end); });
    return pts;
  }
  function snapTime(t, excludeId) {
    const thresh = 8 / pxPerSec; // ~8px magnet
    let best = t, bd = thresh;
    for (const p of snapPoints(excludeId)) { const d = Math.abs(p - t); if (d < bd) { bd = d; best = p; } }
    return Math.max(0, best);
  }

  // ---- timeline trim handles (drag a clip's edges) ------------------------
  function addTrimHandles(d, item, type) {
    for (const side of ["l", "r"]) {
      const h = document.createElement("div");
      h.className = "mi-handle " + side;
      h.addEventListener("pointerdown", (e) => { e.stopPropagation(); startTrim(e, item, type, side, h); });
      d.appendChild(h);
    }
  }
  function startTrim(e, item, type, side, h) {
    try { h.setPointerCapture(e.pointerId); } catch (err) {}
    const sx = e.clientX;
    const o = { trimIn: item.trimIn, trimOut: item.trimOut, dur: item.dur, start: item.start, end: item.end };
    const srcDur = item.el && item.el.duration ? item.el.duration : null;
    const move = (ev) => {
      const dt = (ev.clientX - sx) / pxPerSec;
      if (type === "clip" && item.type === "video") {
        const sp = item.speed || 1;
        if (side === "l") item.trimIn = clamp(o.trimIn + dt * sp, 0, item.trimOut - 0.1);
        else item.trimOut = clamp(o.trimOut + dt * sp, item.trimIn + 0.1, srcDur || o.trimOut + dt * sp);
      } else if (type === "clip") { // image
        item.dur = clamp((side === "l" ? o.dur - dt : o.dur + dt), 0.2, 120);
      } else if (type === "audio") {
        if (side === "l") {
          const ns = snapTime(Math.max(0, o.start + dt), item.id), shift = ns - o.start;
          item.start = ns; item.trimIn = clamp(o.trimIn + shift, 0, o.trimOut - 0.1);
        } else { item.trimOut = clamp(o.trimOut + dt, item.trimIn + 0.1, srcDur || o.trimOut + dt); }
      } else { // overlay or text — move start/end edges
        if (side === "l") item.start = clamp(snapTime(o.start + dt, item.id), 0, o.end - 0.2);
        else item.end = Math.max(item.start + 0.2, snapTime(o.end + dt, item.id));
      }
      renderTracks(); if (sel && sel.id === item.id) renderProps(); updateTime(); drawFrame(cur);
    };
    const up = (ev) => { h.removeEventListener("pointermove", move); h.removeEventListener("pointerup", up); try { h.releasePointerCapture(ev.pointerId); } catch (err) {} commit(); };
    h.addEventListener("pointermove", move); h.addEventListener("pointerup", up);
  }

  function refreshAll() { renderLibrary(); renderTracks(); updateTime(); drawFrame(cur); renderProps(); }

  // ---- selection + properties --------------------------------------------
  function select(kind, id) { sel = { kind, id }; renderTracks(); renderProps(); }
  function selectedClip() { return sel && sel.kind === "clip" ? proj.clips.find((c) => c.id === sel.id) : null; }
  function selectedText() { return sel && sel.kind === "text" ? proj.texts.find((t) => t.id === sel.id) : null; }
  function selectedOverlay() { return sel && sel.kind === "overlay" ? proj.overlays.find((o) => o.id === sel.id) : null; }
  function selectedAudio() { return sel && sel.kind === "audio" ? proj.audios.find((a) => a.id === sel.id) : null; }

  function renderProps() {
    const body = $("#mi-prop-body");
    const c = selectedClip(), tx = selectedText(), ov = selectedOverlay();
    if (c) { body.innerHTML = clipProps(c); bindClipProps(c); }
    else if (tx) { body.innerHTML = textProps(tx); bindTextProps(tx); }
    else if (ov) { body.innerHTML = overlayProps(ov); bindOverlayProps(ov); }
    else if (selectedAudio()) { const a = selectedAudio(); body.innerHTML = audioProps(a); bindAudioProps(a); }
    else body.innerHTML = `<div class="mi-empty">Select a clip, text, caption, or overlay to edit it.<br><br>Import media, click it to add to the timeline, then drag clips to reorder. Add captions with the ⌷ button, and a picture-in-picture / logo with the ▣ button.</div>`;
  }
  function clipProps(c) {
    const trim = c.type === "video" ? `
      <div class="mi-seg">Trim (video)</div>
      <div class="mi-row"><label>In</label><input type="range" id="p-in" min="0" max="${(c.el.duration || c.trimOut).toFixed(2)}" step="0.05" value="${c.trimIn}"><span class="val" id="p-in-v">${c.trimIn.toFixed(1)}s</span></div>
      <div class="mi-row"><label>Out</label><input type="range" id="p-out" min="0" max="${(c.el.duration || c.trimOut).toFixed(2)}" step="0.05" value="${c.trimOut}"><span class="val" id="p-out-v">${c.trimOut.toFixed(1)}s</span></div>
      <div class="mi-row"><label>Speed</label><input type="range" id="p-speed" min="0.25" max="4" step="0.05" value="${c.speed || 1}"><span class="val" id="p-speed-v">${(c.speed || 1).toFixed(2)}×</span></div>
      <div class="mi-row"><label>Volume</label><input type="range" id="p-vol" min="0" max="100" value="${Math.round(c.volume * 100)}"><span class="val" id="p-vol-v">${Math.round(c.volume * 100)}</span></div>` : `
      <div class="mi-seg">Still image</div>
      <div class="mi-row"><label>Duration</label><input type="range" id="p-dur" min="0.5" max="20" step="0.1" value="${c.dur}"><span class="val" id="p-dur-v">${c.dur.toFixed(1)}s</span></div>`;
    return `
      <div class="mi-row"><label>Clip</label><span style="color:var(--fg-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.name)}</span></div>
      <div class="mi-row"><label>Fit</label><select id="p-fit"><option value="cover"${c.fit === "cover" ? " selected" : ""}>Cover (fill)</option><option value="contain"${c.fit === "contain" ? " selected" : ""}>Contain (fit)</option></select></div>
      ${trim}
      <div class="mi-seg">Transform</div>
      <div class="mi-row"><label>Zoom</label><input type="range" id="p-scale" min="50" max="300" value="${Math.round((c.scale || 1) * 100)}"><span class="val" id="p-scale-v">${Math.round((c.scale || 1) * 100)}%</span></div>
      <div class="mi-row"><label>X</label><input type="range" id="p-ox" min="-50" max="50" value="${Math.round((c.ox || 0) * 100)}"><span class="val" id="p-ox-v">${Math.round((c.ox || 0) * 100)}</span></div>
      <div class="mi-row"><label>Y</label><input type="range" id="p-oy" min="-50" max="50" value="${Math.round((c.oy || 0) * 100)}"><span class="val" id="p-oy-v">${Math.round((c.oy || 0) * 100)}</span></div>
      <div class="mi-row"><label>Ken Burns</label><label style="width:auto"><input type="checkbox" id="p-kb" ${c.kenBurns ? "checked" : ""}> slow zoom</label></div>
      <div class="mi-seg">Look &amp; adjust</div>
      <div class="mi-row"><label>Look</label><select id="p-look">${Object.keys(LOOKS).map((n) => `<option${(c.look || "None") === n ? " selected" : ""}>${n}</option>`).join("")}</select></div>
      <div class="mi-row"><label>Bright</label><input type="range" id="p-br" min="0" max="200" value="${c.brightness ?? 100}"><span class="val" id="p-br-v">${c.brightness ?? 100}</span></div>
      <div class="mi-row"><label>Contrast</label><input type="range" id="p-co" min="0" max="200" value="${c.contrast ?? 100}"><span class="val" id="p-co-v">${c.contrast ?? 100}</span></div>
      <div class="mi-row"><label>Saturate</label><input type="range" id="p-sa" min="0" max="200" value="${c.saturate ?? 100}"><span class="val" id="p-sa-v">${c.saturate ?? 100}</span></div>
      <div class="mi-row"><label>Hue</label><input type="range" id="p-hue" min="-180" max="180" value="${c.hue ?? 0}"><span class="val" id="p-hue-v">${c.hue ?? 0}°</span></div>
      <div class="mi-row"><label>Blur</label><input type="range" id="p-bl" min="0" max="40" value="${c.blur ?? 0}"><span class="val" id="p-bl-v">${c.blur ?? 0}</span></div>
      <div class="mi-seg">Fade</div>
      <div class="mi-row"><label>In</label><input type="range" id="p-fi" min="0" max="3" step="0.1" value="${c.fadeIn ?? 0}"><span class="val" id="p-fi-v">${(c.fadeIn ?? 0).toFixed(1)}s</span></div>
      <div class="mi-row"><label>Out</label><input type="range" id="p-fo" min="0" max="3" step="0.1" value="${c.fadeOut ?? 0}"><span class="val" id="p-fo-v">${(c.fadeOut ?? 0).toFixed(1)}s</span></div>
      ${clipTransSection(c)}`;
  }
  function clipTransSection(c) {
    const idx = proj.clips.indexOf(c), isLast = idx === proj.clips.length - 1;
    const tr = c.trans || { type: "none", dur: 0.5 };
    if (isLast) return `<div class="mi-seg">Transition</div><div class="mi-row"><span class="mi-note">Last clip — add another clip after it to set a transition.</span></div>`;
    return `
      <div class="mi-seg">Transition → next</div>
      <div class="mi-row"><label>Type</label><select id="p-tr">
        <option value="none"${tr.type === "none" ? " selected" : ""}>None (cut)</option>
        <option value="crossfade"${tr.type === "crossfade" ? " selected" : ""}>Crossfade</option>
        <option value="dip"${tr.type === "dip" ? " selected" : ""}>Dip to background</option>
      </select></div>
      <div class="mi-row"><label>Length</label><input type="range" id="p-trd" min="0.2" max="2" step="0.1" value="${tr.dur || 0.5}"><span class="val" id="p-trd-v">${(tr.dur || 0.5).toFixed(1)}s</span></div>`;
  }
  function bindClipProps(c) {
    const fit = $("#p-fit"); if (fit) fit.onchange = () => { c.fit = fit.value; drawFrame(cur); };
    bindRange("p-dur", "p-dur-v", (v) => { c.dur = +v; refreshAll(); }, (v) => (+v).toFixed(1) + "s");
    bindRange("p-in", "p-in-v", (v) => { c.trimIn = Math.min(+v, c.trimOut - 0.1); refreshAll(); }, (v) => (+v).toFixed(1) + "s");
    bindRange("p-out", "p-out-v", (v) => { c.trimOut = Math.max(+v, c.trimIn + 0.1); refreshAll(); }, (v) => (+v).toFixed(1) + "s");
    bindRange("p-speed", "p-speed-v", (v) => { c.speed = +v; refreshAll(); }, (v) => (+v).toFixed(2) + "×");
    bindRange("p-vol", "p-vol-v", (v) => { c.volume = +v / 100; if (c.el._gain) c.el._gain.gain.value = c.volume; }, (v) => v);
    // transform
    bindRange("p-scale", "p-scale-v", (v) => { c.scale = +v / 100; drawFrame(cur); }, (v) => v + "%");
    bindRange("p-ox", "p-ox-v", (v) => { c.ox = +v / 100; drawFrame(cur); }, (v) => v);
    bindRange("p-oy", "p-oy-v", (v) => { c.oy = +v / 100; drawFrame(cur); }, (v) => v);
    const kb = $("#p-kb"); if (kb) kb.onchange = () => { c.kenBurns = kb.checked; drawFrame(cur); };
    // look + adjust
    const look = $("#p-look"); if (look) look.onchange = () => { applyLook(c, look.value); renderProps(); drawFrame(cur); };
    bindRange("p-br", "p-br-v", (v) => { c.brightness = +v; drawFrame(cur); }, (v) => v);
    bindRange("p-co", "p-co-v", (v) => { c.contrast = +v; drawFrame(cur); }, (v) => v);
    bindRange("p-sa", "p-sa-v", (v) => { c.saturate = +v; drawFrame(cur); }, (v) => v);
    bindRange("p-hue", "p-hue-v", (v) => { c.hue = +v; drawFrame(cur); }, (v) => v + "°");
    bindRange("p-bl", "p-bl-v", (v) => { c.blur = +v; drawFrame(cur); }, (v) => v);
    // fade
    bindRange("p-fi", "p-fi-v", (v) => { c.fadeIn = +v; drawFrame(cur); }, (v) => (+v).toFixed(1) + "s");
    bindRange("p-fo", "p-fo-v", (v) => { c.fadeOut = +v; drawFrame(cur); }, (v) => (+v).toFixed(1) + "s");
    // transition to next clip
    if (!c.trans) c.trans = { type: "none", dur: 0.5 };
    const tr = $("#p-tr"); if (tr) tr.onchange = () => { c.trans.type = tr.value; refreshAll(); };
    bindRange("p-trd", "p-trd-v", (v) => { c.trans.dur = +v; refreshAll(); }, (v) => (+v).toFixed(1) + "s");
  }
  function textProps(tx) {
    return `
      <div class="mi-row"><label>Text</label><textarea id="t-text" rows="2">${esc(tx.text)}</textarea></div>
      <div class="mi-row"><label>Start</label><input type="number" id="t-start" step="0.1" min="0" value="${tx.start.toFixed(1)}"><label style="width:auto">End</label><input type="number" id="t-end" step="0.1" min="0" value="${tx.end.toFixed(1)}"></div>
      <div class="mi-seg">Style</div>
      <div class="mi-row"><label>Size</label><input type="range" id="t-size" min="20" max="160" value="${tx.size}"><span class="val" id="t-size-v">${tx.size}</span></div>
      <div class="mi-row"><label>Color</label><input type="color" id="t-color" value="${tx.color}"><label style="width:auto">BG</label><select id="t-bg"><option value="none"${tx.bg === "none" ? " selected" : ""}>None</option><option value="#000000cc"${tx.bg === "#000000cc" ? " selected" : ""}>Black</option><option value="#22d3eecc"${tx.bg === "#22d3eecc" ? " selected" : ""}>Cyan</option><option value="#e879f9cc"${tx.bg === "#e879f9cc" ? " selected" : ""}>Pink</option></select></div>
      <div class="mi-row"><label>Font</label><select id="t-font"><option ${tx.font.includes("system") ? "selected" : ""}>system-ui</option><option ${tx.font.includes("Impact") ? "selected" : ""}>Impact</option><option ${tx.font.includes("Georgia") ? "selected" : ""}>Georgia</option><option ${tx.font.includes("Courier") ? "selected" : ""}>"Courier New"</option><option ${tx.font.includes("Arial") ? "selected" : ""}>Arial Black</option></select></div>
      <div class="mi-row"><label>Align</label><select id="t-align"><option value="center"${tx.align === "center" ? " selected" : ""}>Center</option><option value="left"${tx.align === "left" ? " selected" : ""}>Left</option><option value="right"${tx.align === "right" ? " selected" : ""}>Right</option></select><label style="width:auto"><input type="checkbox" id="t-bold" ${tx.weight === "700" ? "checked" : ""}> Bold</label></div>
      <div class="mi-seg">Motion</div>
      <div class="mi-row"><label>Animate</label><select id="t-anim">
        <option value="none"${(tx.anim || "none") === "none" ? " selected" : ""}>None</option>
        <option value="fade"${tx.anim === "fade" ? " selected" : ""}>Fade in / out</option>
        <option value="pop"${tx.anim === "pop" ? " selected" : ""}>Pop</option>
        <option value="slide"${tx.anim === "slide" ? " selected" : ""}>Slide up</option>
        <option value="type"${tx.anim === "type" ? " selected" : ""}>Typewriter</option>
      </select></div>
      <div class="mi-row"><label>Speed</label><input type="range" id="t-animd" min="0.15" max="1.2" step="0.05" value="${tx.animDur ?? 0.45}"><span class="val" id="t-animd-v">${(tx.animDur ?? 0.45).toFixed(2)}s</span></div>
      <div class="mi-row"><label>Position</label><span class="mi-note">drag the text on the preview</span></div>`;
  }
  function bindTextProps(tx) {
    const upd = () => { renderTracks(); drawFrame(cur); };
    $("#t-text").oninput = (e) => { tx.text = e.target.value; upd(); };
    $("#t-start").onchange = (e) => { tx.start = Math.max(0, +e.target.value); upd(); };
    $("#t-end").onchange = (e) => { tx.end = Math.max(tx.start + 0.2, +e.target.value); upd(); };
    bindRange("t-size", "t-size-v", (v) => { tx.size = +v; drawFrame(cur); }, (v) => v);
    $("#t-color").oninput = (e) => { tx.color = e.target.value; drawFrame(cur); };
    $("#t-bg").onchange = (e) => { tx.bg = e.target.value; drawFrame(cur); };
    $("#t-font").onchange = (e) => { tx.font = e.target.value; drawFrame(cur); };
    $("#t-align").onchange = (e) => { tx.align = e.target.value; drawFrame(cur); };
    $("#t-bold").onchange = (e) => { tx.weight = e.target.checked ? "700" : "400"; drawFrame(cur); };
    $("#t-anim").onchange = (e) => { tx.anim = e.target.value; drawFrame(cur); };
    bindRange("t-animd", "t-animd-v", (v) => { tx.animDur = +v; drawFrame(cur); }, (v) => (+v).toFixed(2) + "s");
  }
  function audioProps(a) {
    const maxd = ((a.el && a.el.duration) || a.duration || a.trimOut || 30).toFixed(2);
    return `<div class="mi-row"><label>Audio</label><span style="color:var(--fg-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.name)}</span></div>
      <div class="mi-row"><label>Start</label><input type="number" id="a-start" step="0.1" min="0" value="${(a.start || 0).toFixed(1)}"><span class="mi-note">on timeline</span></div>
      <div class="mi-seg">Trim</div>
      <div class="mi-row"><label>In</label><input type="range" id="a-in" min="0" max="${maxd}" step="0.05" value="${a.trimIn || 0}"><span class="val" id="a-in-v">${(a.trimIn || 0).toFixed(1)}s</span></div>
      <div class="mi-row"><label>Out</label><input type="range" id="a-out" min="0" max="${maxd}" step="0.05" value="${a.trimOut || maxd}"><span class="val" id="a-out-v">${(a.trimOut || +maxd).toFixed(1)}s</span></div>
      <div class="mi-seg">Levels</div>
      <div class="mi-row"><label>Volume</label><input type="range" id="a-vol" min="0" max="100" value="${Math.round((a.volume ?? 1) * 100)}"><span class="val" id="a-vol-v">${Math.round((a.volume ?? 1) * 100)}</span></div>
      <div class="mi-row"><label>Fade in</label><input type="range" id="a-fi" min="0" max="5" step="0.1" value="${a.fadeIn || 0}"><span class="val" id="a-fi-v">${(a.fadeIn || 0).toFixed(1)}s</span></div>
      <div class="mi-row"><label>Fade out</label><input type="range" id="a-fo" min="0" max="5" step="0.1" value="${a.fadeOut || 0}"><span class="val" id="a-fo-v">${(a.fadeOut || 0).toFixed(1)}s</span></div>
      <div class="mi-row"><button class="mi-btn danger" id="a-del">Remove audio</button></div>`;
  }
  function bindAudioProps(a) {
    $("#a-start").onchange = (e) => { a.start = Math.max(0, +e.target.value); renderTracks(); updateTime(); };
    bindRange("a-in", "a-in-v", (v) => { a.trimIn = Math.min(+v, (a.trimOut || 1) - 0.1); renderTracks(); updateTime(); }, (v) => (+v).toFixed(1) + "s");
    bindRange("a-out", "a-out-v", (v) => { a.trimOut = Math.max(+v, (a.trimIn || 0) + 0.1); renderTracks(); updateTime(); }, (v) => (+v).toFixed(1) + "s");
    bindRange("a-vol", "a-vol-v", (v) => { a.volume = +v / 100; if (a.el && a.el._gain) a.el._gain.gain.value = a.volume; }, (v) => v);
    bindRange("a-fi", "a-fi-v", (v) => { a.fadeIn = +v; }, (v) => (+v).toFixed(1) + "s");
    bindRange("a-fo", "a-fo-v", (v) => { a.fadeOut = +v; }, (v) => (+v).toFixed(1) + "s");
    $("#a-del").onclick = () => { if (a.el) try { a.el.pause(); } catch (e) {} proj.audios = proj.audios.filter((x) => x.id !== a.id); sel = null; refreshAll(); commit(); };
  }
  function overlayProps(ov) {
    const vid = ov.type === "video" ? `
      <div class="mi-row"><label>Trim in</label><input type="range" id="o-trim" min="0" max="${((ov.el && ov.el.duration) || 30).toFixed(2)}" step="0.05" value="${ov.trimIn || 0}"><span class="val" id="o-trim-v">${(ov.trimIn || 0).toFixed(1)}s</span></div>
      <div class="mi-row"><label>Volume</label><input type="range" id="o-vol" min="0" max="100" value="${Math.round((ov.volume || 0) * 100)}"><span class="val" id="o-vol-v">${Math.round((ov.volume || 0) * 100)}</span></div>` : "";
    return `
      <div class="mi-row"><label>Overlay</label><span style="color:var(--fg-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(ov.name)}</span></div>
      <div class="mi-row"><label>Start</label><input type="number" id="o-start" step="0.1" min="0" value="${ov.start.toFixed(1)}"><label style="width:auto">End</label><input type="number" id="o-end" step="0.1" min="0" value="${ov.end.toFixed(1)}"></div>
      <div class="mi-seg">Layout</div>
      <div class="mi-row"><label>Size</label><input type="range" id="o-scale" min="8" max="100" value="${Math.round((ov.scale || 0.32) * 100)}"><span class="val" id="o-scale-v">${Math.round((ov.scale || 0.32) * 100)}%</span></div>
      <div class="mi-row"><label>Opacity</label><input type="range" id="o-op" min="0" max="100" value="${Math.round((ov.opacity ?? 1) * 100)}"><span class="val" id="o-op-v">${Math.round((ov.opacity ?? 1) * 100)}</span></div>
      <div class="mi-row"><label>Corners</label><input type="range" id="o-round" min="0" max="50" value="${Math.round((ov.rounded || 0) * 100)}"><span class="val" id="o-round-v">${Math.round((ov.rounded || 0) * 100)}</span></div>
      <div class="mi-row"><label>Shadow</label><label style="width:auto"><input type="checkbox" id="o-shadow" ${ov.shadow ? "checked" : ""}> drop shadow</label></div>
      <div class="mi-row"><label>Place</label>
        <select id="o-place"><option value="">Custom…</option><option value="tl">Top-left</option><option value="tr">Top-right</option><option value="bl">Bottom-left</option><option value="br">Bottom-right</option><option value="c">Center</option></select>
      </div>
      <div class="mi-row"><span class="mi-note">drag the overlay on the preview to position it</span></div>
      ${vid}`;
  }
  function bindOverlayProps(ov) {
    const upd = () => { renderTracks(); drawFrame(cur); };
    $("#o-start").onchange = (e) => { ov.start = Math.max(0, +e.target.value); if (ov.end <= ov.start) ov.end = ov.start + 0.5; upd(); };
    $("#o-end").onchange = (e) => { ov.end = Math.max(ov.start + 0.2, +e.target.value); upd(); };
    bindRange("o-scale", "o-scale-v", (v) => { ov.scale = +v / 100; drawFrame(cur); }, (v) => v + "%");
    bindRange("o-op", "o-op-v", (v) => { ov.opacity = +v / 100; drawFrame(cur); }, (v) => v);
    bindRange("o-round", "o-round-v", (v) => { ov.rounded = +v / 100; drawFrame(cur); }, (v) => v);
    $("#o-shadow").onchange = (e) => { ov.shadow = e.target.checked; drawFrame(cur); };
    $("#o-place").onchange = (e) => {
      const m = { tl: [0.2, 0.16], tr: [0.8, 0.16], bl: [0.2, 0.84], br: [0.8, 0.84], c: [0.5, 0.5] }[e.target.value];
      if (m) { ov.xr = m[0]; ov.yr = m[1]; drawFrame(cur); commit(); }
    };
    if (ov.type === "video") {
      bindRange("o-trim", "o-trim-v", (v) => { ov.trimIn = +v; seek(cur); }, (v) => (+v).toFixed(1) + "s");
      bindRange("o-vol", "o-vol-v", (v) => { ov.volume = +v / 100; if (ov.el && ov.el._gain) ov.el._gain.gain.value = ov.volume; }, (v) => v);
    }
  }
  function bindRange(id, vid, fn, fmtv) {
    const el = $("#" + id); if (!el) return;
    el.oninput = () => { fn(el.value); if (vid) $("#" + vid).textContent = fmtv ? fmtv(el.value) : el.value; };
  }

  // ---- add text / caption -------------------------------------------------
  function addText(kind) {
    const isCap = kind === "caption";
    const t = {
      id: uid(), kind, text: isCap ? "Your caption here" : "Your Title",
      start: cur, end: cur + (isCap ? 2.5 : 3),
      xr: 0.5, yr: isCap ? 0.82 : 0.5,
      size: isCap ? 52 : 84, color: "#ffffff",
      bg: isCap ? "#000000cc" : "none",
      font: isCap ? "system-ui" : "Impact", weight: "700", align: "center",
      anim: isCap ? "none" : "pop", animDur: 0.45,
    };
    proj.texts.push(t);
    select("text", t.id);
    refreshAll();
  }

  // ---- text & sticker templates (one-click styled, animated graphics) -----
  const TEXT_TEMPLATES = [
    { name: "Bold Title", s: { text: "YOUR TITLE", size: 96, font: "Impact", color: "#ffffff", bg: "none", align: "center", xr: 0.5, yr: 0.42, anim: "pop", animDur: 0.4 } },
    { name: "Lower Third", s: { text: "Name · Subtitle", size: 46, font: "system-ui", color: "#ffffff", bg: "#000000cc", align: "left", xr: 0.08, yr: 0.8, anim: "slide", animDur: 0.5 } },
    { name: "Headline Bar", s: { text: "BREAKING", size: 52, font: "system-ui", color: "#0a0e1a", bg: "#22d3eecc", align: "center", xr: 0.5, yr: 0.12, anim: "slide", animDur: 0.4 } },
    { name: "Caption", s: { text: "caption text", size: 50, font: "system-ui", color: "#ffffff", bg: "#000000cc", align: "center", xr: 0.5, yr: 0.85, anim: "none" } },
    { name: "Hook / CTA", s: { text: "Follow for more 👉", size: 58, font: "system-ui", color: "#ffffff", bg: "#e879f9cc", align: "center", xr: 0.5, yr: 0.8, anim: "pop", animDur: 0.4 } },
    { name: "Typewriter", s: { text: "Type your line...", size: 60, font: '"Courier New"', color: "#22d3ee", bg: "none", align: "center", xr: 0.5, yr: 0.5, anim: "type", animDur: 0.6 } },
  ];
  const STICKERS = ["🔥", "😂", "❤️", "👍", "✨", "🎉", "💯", "👀", "😮", "🙌", "⭐", "➡️"];
  function addTextTemplate(s) {
    const t = { id: uid(), kind: "text", start: cur, end: cur + 3, xr: 0.5, yr: 0.5, size: 60, color: "#ffffff", bg: "none", font: "system-ui", weight: "700", align: "center", anim: "none", animDur: 0.45, ...s };
    proj.texts.push(t); select("text", t.id); refreshAll(); commit(); toast("Added template", "ok");
  }
  function addSticker(emoji) {
    const t = { id: uid(), kind: "text", text: emoji, start: cur, end: cur + 2.5, xr: 0.5, yr: 0.4, size: 170, color: "#ffffff", bg: "none", font: "system-ui", weight: "700", align: "center", anim: "pop", animDur: 0.35 };
    proj.texts.push(t); select("text", t.id); refreshAll(); commit(); toast("Added sticker", "ok");
  }
  function openTemplates() {
    const ov = document.createElement("div"); ov.className = "mi-modal";
    const card = document.createElement("div"); card.className = "mi-card";
    card.innerHTML = `<h2>Text templates</h2>
      <div class="mi-tpl-grid">${TEXT_TEMPLATES.map((t, i) => `<button class="mi-btn" data-tpl="${i}">${esc(t.name)}</button>`).join("")}</div>
      <h2 style="margin-top:14px">Stickers &amp; emoji</h2>
      <div class="mi-tpl-grid emoji">${STICKERS.map((e) => `<button class="mi-btn" data-emoji="${e}">${e}</button>`).join("")}</div>
      <div style="display:flex;margin-top:14px"><button class="mi-btn" id="mi-tpl-close" style="margin-left:auto">Close</button></div>`;
    ov.appendChild(card); document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.addEventListener("pointerdown", (e) => { if (e.target === ov) close(); });
    card.querySelectorAll("[data-tpl]").forEach((b) => b.onclick = () => { addTextTemplate(TEXT_TEMPLATES[+b.dataset.tpl].s); close(); });
    card.querySelectorAll("[data-emoji]").forEach((b) => b.onclick = () => { addSticker(b.dataset.emoji); close(); });
    $("#mi-tpl-close").onclick = close;
  }

  // ---- drag the selected text OR overlay on the preview canvas ------------
  canvas.addEventListener("pointerdown", (e) => {
    const item = selectedText() || selectedOverlay(); if (!item) return;
    const r = canvas.getBoundingClientRect();
    const move = (ev) => {
      item.xr = clamp((ev.clientX - r.left) / r.width, 0, 1);
      item.yr = clamp((ev.clientY - r.top) / r.height, 0, 1);
      drawFrame(cur);
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); commit(); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  });

  // ---- split / delete -----------------------------------------------------
  function splitAtPlayhead() {
    const at = clipAt(cur); if (!at) return;
    const c = at.clip;
    if (c.type === "video") {
      const cutLocal = at.local; if (cutLocal < 0.1 || cutLocal > clipDur(c) - 0.1) return;
      // displayed seconds → source seconds (speed-adjusted)
      const cutSrc = c.trimIn + cutLocal * (c.speed || 1);
      const v2 = document.createElement("video"); v2.src = c.url; v2.preload = "auto"; v2.playsInline = true;
      const c2 = { ...c, id: uid(), el: v2, trimIn: cutSrc };
      c.trimOut = cutSrc;
      v2.onloadedmetadata = () => { wireAudio(v2, () => c2.volume); };
      wireAudio(v2, () => c2.volume);
      proj.clips.splice(at.i + 1, 0, c2);
    } else {
      const cutLocal = at.local; if (cutLocal < 0.1 || cutLocal > c.dur - 0.1) return;
      const c2 = { ...c, id: uid(), dur: c.dur - cutLocal };
      c.dur = cutLocal;
      proj.clips.splice(at.i + 1, 0, c2);
    }
    refreshAll();
  }
  function deleteSelected() {
    if (!sel) return;
    if (sel.kind === "clip") proj.clips = proj.clips.filter((c) => c.id !== sel.id);
    else if (sel.kind === "text") proj.texts = proj.texts.filter((t) => t.id !== sel.id);
    else if (sel.kind === "overlay") { const o = selectedOverlay(); if (o && o.el && o.el.pause) try { o.el.pause(); } catch (e) {} proj.overlays = proj.overlays.filter((o) => o.id !== sel.id); }
    else if (sel.kind === "audio") { const a = selectedAudio(); if (a && a.el) try { a.el.pause(); } catch (e) {} proj.audios = proj.audios.filter((x) => x.id !== sel.id); }
    sel = null; refreshAll();
  }
  function duplicateSelected() {
    const c = selectedClip();
    if (c) {
      let copy;
      if (c.type === "video") {
        const v = document.createElement("video"); v.src = c.url; v.preload = "auto"; v.playsInline = true; v.crossOrigin = "anonymous";
        copy = { ...c, id: uid(), el: v };
        v.onloadedmetadata = () => { wireAudio(v, () => copy.volume); refreshAll(); };
        wireAudio(v, () => copy.volume);
      } else {
        copy = { ...c, id: uid() };
      }
      proj.clips.splice(proj.clips.indexOf(c) + 1, 0, copy);
      select("clip", copy.id); refreshAll(); return;
    }
    const tx = selectedText();
    if (tx) {
      const len = tx.end - tx.start;
      const copy = { ...tx, id: uid(), start: tx.end, end: tx.end + len };
      proj.texts.push(copy); select("text", copy.id); refreshAll(); return;
    }
    const ov = selectedOverlay();
    if (ov) {
      const copy = { ...ov, id: uid(), xr: clamp((ov.xr ?? 0.5) + 0.04, 0, 1), yr: clamp((ov.yr ?? 0.5) + 0.04, 0, 1) };
      if (ov.type === "video") {
        const v = document.createElement("video"); v.src = ov.url; v.preload = "auto"; v.playsInline = true; v.crossOrigin = "anonymous";
        copy.el = v; v.onloadedmetadata = () => { wireAudio(v, () => copy.volume); refreshAll(); }; wireAudio(v, () => copy.volume);
      } else { const img = new Image(); img.src = ov.url; copy.el = img; }
      proj.overlays.push(copy); select("overlay", copy.id); refreshAll(); return;
    }
    const au = selectedAudio();
    if (au) {
      const el = document.createElement("audio"); el.src = au.url; el.preload = "auto"; el.crossOrigin = "anonymous";
      const copy = { ...au, id: uid(), el, start: audioEnd(au) };
      el.onloadedmetadata = () => { wireAudio(el, () => copy.volume); refreshAll(); }; wireAudio(el, () => copy.volume);
      proj.audios.push(copy); select("audio", copy.id); refreshAll(); return;
    }
    toast("Select a clip, text, overlay, or audio to duplicate", "err");
  }

  // ---- SRT import / export (captions) ------------------------------------
  function importSrt(text) {
    const blocks = text.replace(/\r/g, "").trim().split(/\n\n+/);
    let n = 0;
    for (const b of blocks) {
      const m = b.match(/(\d\d):(\d\d):(\d\d)[,.](\d\d\d)\s*-->\s*(\d\d):(\d\d):(\d\d)[,.](\d\d\d)/);
      if (!m) continue;
      const start = +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
      const end = +m[5] * 3600 + +m[6] * 60 + +m[7] + +m[8] / 1000;
      const body = b.split("\n").slice(b.split("\n")[0].match(/^\d+$/) ? 2 : 1).join(" ").trim();
      proj.texts.push({ id: uid(), kind: "caption", text: body, start, end, xr: 0.5, yr: 0.82, size: 52, color: "#ffffff", bg: "#000000cc", font: "system-ui", weight: "700", align: "center", anim: "none", animDur: 0.45 });
      n++;
    }
    refreshAll();
    commit();
    toast(`Imported ${n} captions`, "ok");
  }
  function exportSrt() {
    const caps = proj.texts.filter((t) => t.kind === "caption").sort((a, b) => a.start - b.start);
    if (!caps.length) { toast("No captions to export", "err"); return; }
    const srtTime = (s) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60), ms = Math.round((s % 1) * 1000); return `${p(h)}:${p(m)}:${p(sec)},${String(ms).padStart(3, "0")}`; };
    const p = (n) => String(n).padStart(2, "0");
    const out = caps.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}`).join("\n\n");
    download(new Blob([out], { type: "text/plain" }), "captions.srt");
  }
  const srtInput = document.createElement("input");
  srtInput.type = "file"; srtInput.accept = ".srt,text/plain"; srtInput.style.display = "none";
  document.body.appendChild(srtInput);
  srtInput.onchange = () => { const f = srtInput.files[0]; if (f) f.text().then(importSrt); srtInput.value = ""; };

  // ---- export (MediaRecorder, real time) ---------------------------------
  function pickMime() {
    const cands = [
      ["video/mp4;codecs=h264,aac", "mp4"],
      ["video/mp4", "mp4"],
      ["video/webm;codecs=vp9,opus", "webm"],
      ["video/webm;codecs=vp8,opus", "webm"],
      ["video/webm", "webm"],
    ];
    return cands.filter(([m]) => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
  }
  // Frame-exact path needs WebCodecs + the vendored muxer.
  const HAS_WEBCODECS = typeof window.VideoEncoder === "function" && typeof window.AudioData === "function" &&
    typeof window.VideoFrame === "function" && typeof window.OfflineAudioContext === "function" &&
    typeof window.Mp4Muxer === "object" && !!window.Mp4Muxer.Muxer;

  function syncExportMode() {
    const precise = $("#mi-exp-mode").value === "precise";
    $("#mi-exp-container-row").style.display = precise ? "none" : "";
    $("#mi-exp-note").textContent = precise
      ? "Precise mode renders every frame through a video encoder — faster than the clip and frame-exact, output is MP4 (H.264). Audio is mixed offline."
      : "Fast mode records the live preview in real time (~the length of the video) with mixed audio.";
  }
  function openExport() {
    const dur = totalDur();
    if (dur <= 0) { toast("Add at least one clip first", "err"); return; }
    // mode select
    const modeSel = $("#mi-exp-mode"); modeSel.innerHTML = "";
    if (HAS_WEBCODECS) { const o = document.createElement("option"); o.value = "precise"; o.textContent = "Precise — frame-exact MP4 (H.264)"; modeSel.appendChild(o); }
    const ro = document.createElement("option"); ro.value = "realtime"; ro.textContent = "Fast — real-time recording"; modeSel.appendChild(ro);
    modeSel.value = HAS_WEBCODECS ? "precise" : "realtime";
    modeSel.onchange = syncExportMode;
    // container options (real-time only)
    const sel = $("#mi-exp-container"); sel.innerHTML = "";
    pickMime().forEach(([m, ext]) => { const o = document.createElement("option"); o.value = m; o.textContent = `${ext.toUpperCase()} — ${m.replace("video/", "")}`; sel.appendChild(o); });
    $("#mi-exp-fmt").textContent = `${proj.w}×${proj.h} · ${proj.fps}fps · ${fmt(dur)}`;
    $("#mi-exp-bar").style.width = "0%";
    syncExportMode();
    $("#mi-export-modal").classList.remove("hidden");
  }
  function startExport() { return $("#mi-exp-mode").value === "precise" ? runPreciseExport() : runExport(); }
  // Export the current frame as a still (thumbnail / poster / cover image).
  function exportPoster() {
    if (totalDur() <= 0) { toast("Add a clip first", "err"); return; }
    exporting = true; drawFrame(cur);
    canvas.toBlob((b) => {
      exporting = false; drawFrame(cur);
      if (b) { download(b, `mirage-frame-${Math.round(cur * 1000)}ms.png`); toast("Saved frame as PNG ✓", "ok"); }
    }, "image/png");
  }
  async function runExport() {
    const mime = $("#mi-exp-container").value;
    const ext = mime.includes("mp4") ? "mp4" : "webm";
    const bitrate = +$("#mi-exp-quality").value;
    const dur = totalDur();
    const startBtn = $("#mi-exp-start"); startBtn.disabled = true; startBtn.textContent = "Rendering…";

    if (actx && actx.state === "suspended") await actx.resume();
    const vStream = canvas.captureStream(proj.fps);
    const tracks = [...vStream.getVideoTracks()];
    if (streamDest) tracks.push(...streamDest.stream.getAudioTracks());
    const stream = new MediaStream(tracks);
    const chunks = [];
    let rec;
    try { rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate }); }
    catch (e) { toast("Recorder init failed: " + e, "err"); startBtn.disabled = false; startBtn.textContent = "Start export"; return; }
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      exporting = false;
      const blob = new Blob(chunks, { type: mime });
      download(blob, `mirage-${proj.w}x${proj.h}.${ext}`);
      $("#mi-export-modal").classList.add("hidden");
      startBtn.disabled = false; startBtn.textContent = "Start export";
      toast("Exported ✓ — check your downloads", "ok");
    };

    // drive a clean playback pass from 0 (guides hidden while recording)
    exporting = true;
    stop(); cur = 0; seek(0);
    rec.start(100);
    playing = true; $("#mi-play").textContent = "⏸";
    const wall0 = performance.now();
    const renderLoop = () => {
      cur = (performance.now() - wall0) / 1000;
      const pct = Math.min(100, (cur / dur) * 100);
      $("#mi-exp-bar").style.width = pct + "%";
      if (cur >= dur) { drawFrame(dur); syncMediaTo(dur, false); setTimeout(() => rec.stop(), 200); playing = false; $("#mi-play").textContent = "▶"; return; }
      syncMediaTo(cur, true);
      drawFrame(cur);
      updateTime();
      requestAnimationFrame(renderLoop);
    };
    requestAnimationFrame(renderLoop);
  }

  // ---- precise export (WebCodecs + mp4-muxer, frame-exact) ----------------
  async function pickVideoCodec(w, h, fps, bitrate) {
    for (const codec of ["avc1.640028", "avc1.4d0028", "avc1.42e01e"]) {
      try { const s = await VideoEncoder.isConfigSupported({ codec, width: w, height: h, bitrate, framerate: fps }); if (s.supported) return codec; } catch (e) {}
    }
    return null;
  }
  async function pickAudioCodec() {
    for (const [codec, muxName] of [["mp4a.40.2", "aac"], ["opus", "opus"]]) {
      try { const s = await AudioEncoder.isConfigSupported({ codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 }); if (s.supported) return { codec, muxName }; } catch (e) {}
    }
    return null;
  }
  // Seek a media element to `time` and resolve once the frame is ready.
  function awaitSeek(el, time) {
    return new Promise((res) => {
      let done = false; const fin = () => { if (done) return; done = true; el.removeEventListener("seeked", fin); res(); };
      el.addEventListener("seeked", fin);
      try { if (Math.abs(el.currentTime - time) < 1e-3) return fin(); el.currentTime = time; } catch (e) { return fin(); }
      setTimeout(fin, 250); // safety
    });
  }
  // Mix the whole timeline's audio to one buffer, deterministically.
  async function renderAudioOffline(dur) {
    const sr = 48000, oc = new OfflineAudioContext(2, Math.max(1, Math.ceil(dur * sr)), sr);
    const cache = {};
    const buf = async (url) => { if (cache[url] !== undefined) return cache[url]; try { const ab = await fetch(url).then((r) => r.arrayBuffer()); cache[url] = await oc.decodeAudioData(ab); } catch (e) { cache[url] = null; } return cache[url]; };
    const starts = clipStarts();
    for (let i = 0; i < proj.clips.length; i++) {
      const c = proj.clips[i]; if (c.type !== "video" || (c.volume || 0) <= 0) continue;
      const b = await buf(c.url); if (!b) continue;
      try { const s = oc.createBufferSource(); s.buffer = b; s.playbackRate.value = c.speed || 1; const g = oc.createGain(); g.gain.value = c.volume; s.connect(g).connect(oc.destination); s.start(starts[i], c.trimIn, Math.max(0.01, c.trimOut - c.trimIn)); } catch (e) {}
    }
    for (const ov of proj.overlays) {
      if (ov.type !== "video" || (ov.volume || 0) <= 0) continue;
      const b = await buf(ov.url); if (!b) continue;
      try { const s = oc.createBufferSource(); s.buffer = b; const g = oc.createGain(); g.gain.value = ov.volume; s.connect(g).connect(oc.destination); s.start(ov.start, ov.trimIn || 0, Math.max(0.01, ov.end - ov.start)); } catch (e) {}
    }
    for (const a of proj.audios) {
      if ((a.volume || 0) <= 0) continue;
      const b = await buf(a.url); if (!b) continue;
      try {
        const s = oc.createBufferSource(); s.buffer = b;
        const g = oc.createGain(); const vol = a.volume ?? 1, len = audioLen(a), st = a.start || 0;
        // fade in/out as gain automation
        const fi = a.fadeIn || 0, fo = a.fadeOut || 0;
        if (fi > 0) { g.gain.setValueAtTime(0, st); g.gain.linearRampToValueAtTime(vol, st + fi); } else g.gain.setValueAtTime(vol, st);
        if (fo > 0) { g.gain.setValueAtTime(vol, Math.max(st, st + len - fo)); g.gain.linearRampToValueAtTime(0, st + len); }
        s.connect(g).connect(oc.destination); s.start(st, a.trimIn || 0, len);
      } catch (e) {}
    }
    return await oc.startRendering();
  }
  async function runPreciseExport() {
    const dur = totalDur(), fps = proj.fps, bitrate = +$("#mi-exp-quality").value;
    const startBtn = $("#mi-exp-start");
    const vcodec = await pickVideoCodec(proj.w, proj.h, fps, bitrate);
    if (!vcodec) { toast("No H.264 encoder here — using Fast mode", "err"); return runExport(); }
    startBtn.disabled = true; startBtn.textContent = "Rendering…";
    exporting = true; stop();
    let acodec = null;
    try { acodec = await pickAudioCodec(); } catch (e) {}
    try {
      const muxer = new Mp4Muxer.Muxer({
        target: new Mp4Muxer.ArrayBufferTarget(),
        video: { codec: "avc", width: proj.w, height: proj.h },
        audio: acodec ? { codec: acodec.muxName, sampleRate: 48000, numberOfChannels: 2 } : undefined,
        fastStart: "in-memory",
        firstTimestampBehavior: "offset",
      });
      const venc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => console.error(e) });
      venc.configure({ codec: vcodec, width: proj.w, height: proj.h, bitrate, framerate: fps });
      const total = Math.max(1, Math.ceil(dur * fps));
      for (let i = 0; i < total; i++) {
        const t = i / fps;
        const seeks = activeClips(t)
          .filter((a) => a.clip.type === "video" && a.clip.el.readyState >= 1)
          .map((a) => awaitSeek(a.clip.el, a.clip.trimIn + a.local * (a.clip.speed || 1)));
        for (const ov of proj.overlays) {
          if (ov.type === "video" && ov.el && ov.el.readyState >= 1 && t >= ov.start && t < ov.end)
            seeks.push(awaitSeek(ov.el, (ov.trimIn || 0) + (t - ov.start)));
        }
        await Promise.all(seeks);
        drawFrame(t);
        const frame = new VideoFrame(canvas, { timestamp: Math.round(t * 1e6), duration: Math.round(1e6 / fps) });
        venc.encode(frame, { keyFrame: i % (fps * 2) === 0 });
        frame.close();
        if (venc.encodeQueueSize > fps) await new Promise((r) => setTimeout(r, 0));
        if (i % 5 === 0) { $("#mi-exp-bar").style.width = (i / total * 100).toFixed(1) + "%"; updateTime(); }
      }
      await venc.flush();
      // audio
      if (acodec) {
        try {
          const aenc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (e) => console.error(e) });
          aenc.configure({ codec: acodec.codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 });
          const rendered = await renderAudioOffline(dur);
          const ch0 = rendered.getChannelData(0), ch1 = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : rendered.getChannelData(0);
          const block = 2048, sr = 48000;
          for (let i = 0; i < rendered.length; i += block) {
            const n = Math.min(block, rendered.length - i);
            const data = new Float32Array(n * 2);
            data.set(ch0.subarray(i, i + n), 0); data.set(ch1.subarray(i, i + n), n); // f32-planar: [L…][R…]
            const ad = new AudioData({ format: "f32-planar", sampleRate: sr, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((i / sr) * 1e6), data });
            aenc.encode(ad); ad.close();
          }
          await aenc.flush();
        } catch (e) { console.error("audio encode failed", e); toast("Exported without audio (encode failed)", "err"); }
      }
      muxer.finalize();
      download(new Blob([muxer.target.buffer], { type: "video/mp4" }), `mirage-${proj.w}x${proj.h}.mp4`);
      $("#mi-exp-bar").style.width = "100%";
      $("#mi-export-modal").classList.add("hidden");
      toast("Exported MP4 ✓ — check your downloads", "ok");
    } catch (e) {
      console.error(e); toast("Precise export failed: " + (e.message || e), "err");
    } finally {
      exporting = false; startBtn.disabled = false; startBtn.textContent = "Start export";
      seek(0);
    }
  }

  // ---- helpers ------------------------------------------------------------
  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  let toastT = 0;
  function toast(msg, kind) {
    let el = document.querySelector(".mi-toast");
    if (!el) { el = document.createElement("div"); el.className = "mi-toast"; document.body.appendChild(el); }
    el.className = "mi-toast " + (kind || "");
    el.textContent = msg;
    clearTimeout(toastT); toastT = setTimeout(() => el.remove(), 2600);
  }

  // ---- history (undo/redo) + project save/load ---------------------------
  // Serialize the timeline to plain JSON (drops live media elements; clips keep
  // their `url` so elements can be rebuilt). Library imports are NOT in history.
  function serialize() {
    const stripEl = (o) => { const { el, ...rest } = o; return rest; };
    return {
      version: 1, w: proj.w, h: proj.h, fps: proj.fps, bg: proj.bg,
      clips: proj.clips.map(stripEl),
      texts: proj.texts.map((t) => ({ ...t })),
      overlays: proj.overlays.map(stripEl),
      audios: proj.audios.map(stripEl),
    };
  }
  // Rebuild project state from a serialized object (rebuilds media elements from
  // their urls — blob: urls for undo, data: urls for a loaded .mirage file).
  function deserialize(s) {
    for (const a of proj.audios) if (a.el) { try { a.el.pause(); } catch (e) {} }
    proj.w = s.w; proj.h = s.h; proj.fps = s.fps || 30; proj.bg = s.bg || "#000000";
    proj.clips = (s.clips || []).map((cs) => {
      const c = { ...cs, id: uid() };
      if (!c.trans) c.trans = { type: "none", dur: 0.5 };
      if (c.type === "image") { const img = new Image(); img.src = c.url; c.el = img; }
      else {
        const v = document.createElement("video"); v.src = c.url; v.preload = "auto"; v.playsInline = true; v.crossOrigin = "anonymous";
        c.el = v; v.onloadedmetadata = () => { wireAudio(v, () => c.volume); drawFrame(cur); }; wireAudio(v, () => c.volume);
      }
      return c;
    });
    proj.texts = (s.texts || []).map((t) => ({ ...t, id: uid() }));
    proj.overlays = (s.overlays || []).map((os) => {
      const o = { ...os, id: uid() };
      if (o.type === "image") { const img = new Image(); img.src = o.url; o.el = img; }
      else {
        const v = document.createElement("video"); v.src = o.url; v.preload = "auto"; v.playsInline = true; v.crossOrigin = "anonymous";
        o.el = v; v.onloadedmetadata = () => { wireAudio(v, () => o.volume); drawFrame(cur); }; wireAudio(v, () => o.volume);
      }
      return o;
    });
    // audios[] (current) with back-compat for the old single `audio` field
    const audioList = s.audios || (s.audio ? [{ ...s.audio, start: 0, trimIn: 0, trimOut: s.audio.duration || 0, fadeIn: 0, fadeOut: 0 }] : []);
    proj.audios = audioList.map((as) => {
      const a = document.createElement("audio"); a.src = as.url; a.preload = "auto"; a.crossOrigin = "anonymous";
      const clip = { ...as, id: uid(), el: a };
      a.onloadedmetadata = () => { if (!clip.trimOut) { clip.trimOut = a.duration; clip.duration = a.duration; } wireAudio(a, () => clip.volume); updateTime(); };
      wireAudio(a, () => clip.volume);
      return clip;
    });
    sel = null;
    canvas.width = proj.w; canvas.height = proj.h; fitCanvasCss();
    const fEl = $("#mi-format"); if (fEl) fEl.value = `${proj.w}x${proj.h}`;
    const bEl = $("#mi-bg"); if (bEl) bEl.value = /^#[0-9a-f]{6}$/i.test(proj.bg) ? proj.bg : "#000000";
    refreshAll();
  }

  let history = [], hi = -1, restoring = false;
  const HIST_MAX = 60;
  function updateHistUI() {
    const u = $("#mi-undo"), r = $("#mi-redo");
    if (u) u.disabled = hi <= 0;
    if (r) r.disabled = hi >= history.length - 1;
  }
  // Commit current state to the undo stack (skips no-op duplicates).
  function commit() {
    if (restoring) return;
    const snap = JSON.stringify(serialize());
    if (hi >= 0 && history[hi] === snap) return;
    history = history.slice(0, hi + 1);
    history.push(snap);
    if (history.length > HIST_MAX) history.shift();
    hi = history.length - 1;
    updateHistUI();
  }
  function applyHist() { restoring = true; try { deserialize(JSON.parse(history[hi])); } finally { restoring = false; } updateHistUI(); }
  function undo() { if (hi > 0) { hi--; applyHist(); toast("Undo", "ok"); } }
  function redo() { if (hi < history.length - 1) { hi++; applyHist(); toast("Redo", "ok"); } }

  // Save: embed each unique media asset as a data URL so the .mirage file is
  // fully self-contained (no host filesystem bridge available in the sandbox).
  async function urlToDataURL(url) {
    const blob = await fetch(url).then((r) => r.blob());
    return await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });
  }
  async function saveProject() {
    if (!proj.clips.length && !proj.overlays.length && !proj.audios.length) { toast("Nothing to save yet", "err"); return; }
    toast("Packing project…", "ok");
    const urls = new Set();
    proj.clips.forEach((c) => urls.add(c.url));
    proj.overlays.forEach((o) => urls.add(o.url));
    proj.audios.forEach((a) => urls.add(a.url));
    const map = {};
    for (const u of urls) { try { map[u] = await urlToDataURL(u); } catch (e) { map[u] = u; } }
    const data = serialize();
    data.clips.forEach((c) => { c.url = map[c.url] || c.url; });
    data.overlays.forEach((o) => { o.url = map[o.url] || o.url; });
    data.audios.forEach((a) => { a.url = map[a.url] || a.url; });
    const json = JSON.stringify(data);
    if (json.length > 220 * 1024 * 1024) { toast("Project too large to save in one file (>220MB)", "err"); return; }
    download(new Blob([json], { type: "application/json" }), "project.mirage");
    toast("Project saved ✓", "ok");
  }
  const projInput = document.createElement("input");
  projInput.type = "file"; projInput.accept = ".mirage,application/json"; projInput.style.display = "none";
  document.body.appendChild(projInput);
  projInput.onchange = () => { const f = projInput.files[0]; if (f) loadProject(f); projInput.value = ""; };
  function loadProject(file) {
    file.text().then((txt) => {
      let data; try { data = JSON.parse(txt); } catch (e) { toast("Not a valid .mirage file", "err"); return; }
      stop(); cur = 0;
      deserialize(data);
      history = []; hi = -1; commit();
      toast("Project loaded ✓", "ok");
    });
  }

  // ---- clipboard (copy / paste a selected item) --------------------------
  let clipboard = null; // { kind, data }
  function copySelected() {
    const strip = (o) => { const { el, ...rest } = o; return rest; };
    if (selectedClip()) clipboard = { kind: "clip", data: strip(selectedClip()) };
    else if (selectedText()) clipboard = { kind: "text", data: { ...selectedText() } };
    else if (selectedOverlay()) clipboard = { kind: "overlay", data: strip(selectedOverlay()) };
    else if (selectedAudio()) clipboard = { kind: "audio", data: strip(selectedAudio()) };
    else return;
    toast("Copied", "ok");
  }
  function pasteClipboard() {
    if (!clipboard) return;
    const d = { ...clipboard.data, id: uid() };
    if (clipboard.kind === "clip") {
      if (d.type === "image") { const img = new Image(); img.src = d.url; d.el = img; }
      else { const v = document.createElement("video"); v.src = d.url; v.preload = "auto"; v.playsInline = true; v.crossOrigin = "anonymous"; d.el = v; v.onloadedmetadata = () => { wireAudio(v, () => d.volume); refreshAll(); }; wireAudio(v, () => d.volume); }
      proj.clips.push(d); select("clip", d.id);
    } else if (clipboard.kind === "text") {
      const len = d.end - d.start; d.start = cur; d.end = cur + len; proj.texts.push(d); select("text", d.id);
    } else if (clipboard.kind === "overlay") {
      const len = d.end - d.start; d.start = cur; d.end = cur + len;
      if (d.type === "image") { const img = new Image(); img.src = d.url; d.el = img; }
      else { const v = document.createElement("video"); v.src = d.url; v.preload = "auto"; v.playsInline = true; v.crossOrigin = "anonymous"; d.el = v; v.onloadedmetadata = () => { wireAudio(v, () => d.volume); refreshAll(); }; wireAudio(v, () => d.volume); }
      proj.overlays.push(d); select("overlay", d.id);
    } else if (clipboard.kind === "audio") {
      d.start = cur; const a = document.createElement("audio"); a.src = d.url; a.preload = "auto"; a.crossOrigin = "anonymous"; d.el = a;
      a.onloadedmetadata = () => { wireAudio(a, () => d.volume); refreshAll(); }; wireAudio(a, () => d.volume);
      proj.audios.push(d); select("audio", d.id);
    }
    refreshAll(); commit(); toast("Pasted", "ok");
  }

  // ---- events -------------------------------------------------------------
  document.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    if (act === "import") fileInput.click();
    else if (act === "add-overlay") overlayInput.click();
    else if (act === "add-text") { addText("text"); commit(); }
    else if (act === "add-caption") { addText("caption"); commit(); }
    else if (act === "templates") openTemplates();
    else if (act === "split") { splitAtPlayhead(); commit(); }
    else if (act === "del") { deleteSelected(); commit(); }
    else if (act === "dup") { duplicateSelected(); commit(); }
    else if (act === "srt-import") srtInput.click();
    else if (act === "srt-export") exportSrt();
    else if (act === "guides") { showGuides = !showGuides; e.target.closest("[data-act]").classList.toggle("on", showGuides); drawFrame(cur); }
    else if (act === "undo") undo();
    else if (act === "redo") redo();
    else if (act === "save") saveProject();
    else if (act === "open") projInput.click();
    else if (act === "poster") exportPoster();
    else if (act === "export") openExport();
  });
  // Any committed property edit (range release, select/checkbox/color change)
  // takes an undo snapshot. Bubble phase + id match so it runs AFTER the
  // control's own handler has applied the change (the props panel may rebuild,
  // detaching e.target — its .id still identifies it).
  document.addEventListener("change", (e) => {
    if (restoring) return;
    const id = e.target.id || "";
    if (/^[ptao]-/.test(id) || id === "mi-bg" || id === "mi-format") commit();
  });
  $("#mi-play").onclick = () => (playing ? stop() : play());
  $("#mi-scrub").oninput = (e) => seek((+e.target.value / 1000) * totalDur());
  $("#mi-format").onchange = (e) => applyFormat(e.target.value);
  $("#mi-bg").oninput = (e) => { proj.bg = e.target.value; drawFrame(cur); };
  $("#mi-zoom").oninput = (e) => { pxPerSec = +e.target.value; renderTracks(); updateTime(); };
  $("#mi-exp-start").onclick = startExport;
  $("#mi-exp-cancel").onclick = () => $("#mi-export-modal").classList.add("hidden");

  // timeline click → seek
  $("#mi-tracks").addEventListener("pointerdown", (e) => {
    if (e.target.closest(".mi-clip")) return;
    const r = $("#mi-tracks").getBoundingClientRect();
    seek((e.clientX - r.left + $("#mi-tracks").scrollLeft) / pxPerSec);
  });

  // drag-drop import
  const drop = $("#mi-drop");
  ["dragenter", "dragover"].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("hot"); }));
  ["dragleave", "drop"].forEach((ev) => document.addEventListener(ev, (e) => { e.preventDefault(); if (ev !== "drop" && e.relatedTarget) return; drop.classList.remove("hot"); }));
  document.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("hot"); [...(e.dataTransfer?.files || [])].forEach(importFile); });

  // keyboard
  window.addEventListener("keydown", (e) => {
    if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
      if (k === "y") { e.preventDefault(); redo(); return; }
      if (k === "d") { e.preventDefault(); duplicateSelected(); commit(); return; }
      if (k === "s") { e.preventDefault(); saveProject(); return; }
      if (k === "o") { e.preventDefault(); projInput.click(); return; }
      if (k === "c") { e.preventDefault(); copySelected(); return; }
      if (k === "v") { e.preventDefault(); pasteClipboard(); return; }
      return;
    }
    if (e.altKey) return;
    if (e.code === "Space") { e.preventDefault(); playing ? stop() : play(); }
    else if (e.key === "s" || e.key === "S") splitAtPlayhead();
    else if (e.key === "Delete" || e.key === "Backspace") deleteSelected();
    else if (e.key === "ArrowRight" || e.key === ".") seek(cur + 1 / proj.fps);
    else if (e.key === "ArrowLeft" || e.key === ",") seek(cur - 1 / proj.fps);
    else if (e.key === "Home") seek(0);
    else if (e.key === "End") seek(totalDur());
    else if (e.key === "+" || e.key === "=") { pxPerSec = clamp(pxPerSec * 1.25, 20, 200); $("#mi-zoom").value = pxPerSec; renderTracks(); updateTime(); }
    else if (e.key === "-" || e.key === "_") { pxPerSec = clamp(pxPerSec / 1.25, 20, 200); $("#mi-zoom").value = pxPerSec; renderTracks(); updateTime(); }
  });

  window.addEventListener("resize", () => { fitCanvasCss(); drawFrame(cur); });

  // captions toolbar shortcuts on the props "Captions" segment (SRT)
  // expose SRT actions via the Caption button context: shift+click = import srt
  $("[data-act='add-caption']").addEventListener("contextmenu", (e) => { e.preventDefault(); srtInput.click(); });

  // ---- boot ---------------------------------------------------------------
  applyFormat("1080x1920");
  refreshAll();
  commit();          // seed the undo stack with the empty project
  updateHistUI();
  toast("Mirage ready — Import media to start", "ok");
})();
