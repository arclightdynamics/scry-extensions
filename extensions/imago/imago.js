/* ============================================================================
 * Imago — a layered raster image editor (original implementation).
 * Pure vanilla JS + Canvas2D; runs sandboxed in the Scry extension frame.
 *
 * Model:  doc { width, height, layers[], active, selection }
 *         layer { id, name, canvas, ctx, visible, opacity(0..1), blend }
 * View:   two stacked canvases at doc resolution inside .sg-stage, CSS-scaled
 *         by `zoom`. `composite` shows the flattened image; `overlay` shows
 *         selection ants and live tool previews.
 * ==========================================================================*/
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ---- DOM ----------------------------------------------------------------
  const stageWrap = $("#sg-stagewrap");
  const stage = $("#sg-stage");
  const composite = $("#sg-composite");
  const cctx = composite.getContext("2d");
  const overlay = $("#sg-overlay");
  const octx = overlay.getContext("2d");

  // ---- editor state -------------------------------------------------------
  const doc = { width: 1000, height: 700, layers: [], active: 0, selection: null };
  let zoom = 1;
  let tool = "brush";
  let fg = "#22d3ee";
  let bg = "#0a0e1a";
  const opt = { size: 14, opacity: 1, shapeFill: "fill", tolerance: 24, font: 48, fontFam: "system-ui", cropAspect: null, textOutline: false, textShadow: false, textAlign: "left", gradType: "fg-transparent" };
  let nextLayerId = 1;

  // ---- tools registry -----------------------------------------------------
  const TOOLS = [
    { id: "move", icon: "✣", key: "V", name: "Move" },
    { id: "marquee", icon: "▭", key: "M", name: "Rect Select" },
    { id: "lasso", icon: "◌", key: "L", name: "Lasso" },
    { id: "sep" },
    { id: "brush", icon: "🖌", key: "B", name: "Brush" },
    { id: "pencil", icon: "✏", key: "N", name: "Pencil" },
    { id: "eraser", icon: "🩹", key: "E", name: "Eraser" },
    { id: "bucket", icon: "🪣", key: "G", name: "Bucket" },
    { id: "gradient", icon: "▤", key: "D", name: "Gradient" },
    { id: "picker", icon: "💉", key: "I", name: "Eyedropper" },
    { id: "sep" },
    { id: "line", icon: "╱", key: "U", name: "Line" },
    { id: "rect", icon: "□", key: "R", name: "Rectangle" },
    { id: "ellipse", icon: "◯", key: "O", name: "Ellipse" },
    { id: "text", icon: "T", key: "T", name: "Text" },
    { id: "sep" },
    { id: "hand", icon: "✋", key: "H", name: "Hand" },
  ];
  // Which option rows a tool shows.
  const usesSize = (t) => ["brush", "pencil", "eraser", "line", "rect", "ellipse"].includes(t);
  const usesOpacity = (t) => ["brush", "pencil", "eraser", "bucket", "line", "rect", "ellipse", "text", "gradient"].includes(t);

  // =========================================================================
  // Layers
  // =========================================================================
  function makeLayer(name, fill) {
    const c = document.createElement("canvas");
    c.width = doc.width;
    c.height = doc.height;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (fill) { ctx.fillStyle = fill; ctx.fillRect(0, 0, c.width, c.height); }
    return { id: nextLayerId++, name: name || `Layer ${nextLayerId}`, canvas: c, ctx, visible: true, opacity: 1, blend: "source-over", locked: false };
  }
  const activeLayer = () => doc.layers[doc.active];

  function resizeAllLayers(w, h) {
    for (const l of doc.layers) {
      const tmp = document.createElement("canvas");
      tmp.width = w; tmp.height = h;
      tmp.getContext("2d").drawImage(l.canvas, 0, 0);
      l.canvas.width = w; l.canvas.height = h;
      l.ctx = l.canvas.getContext("2d", { willReadFrequently: true });
      l.ctx.drawImage(tmp, 0, 0);
    }
  }

  // =========================================================================
  // Rendering
  // =========================================================================
  function syncStageSize() {
    for (const cv of [composite, overlay]) { cv.width = doc.width; cv.height = doc.height; }
    stage.style.width = doc.width + "px";
    stage.style.height = doc.height + "px";
    applyZoom();
  }
  function applyZoom() {
    stage.style.transform = `scale(${zoom})`;
    // reserve scaled space so the scroll container can pan
    stage.style.marginRight = doc.width * (zoom - 1) + "px";
    stage.style.marginBottom = doc.height * (zoom - 1) + "px";
    $("#sg-zoom-pct").textContent = Math.round(zoom * 100) + "%";
  }
  function recomposite() {
    cctx.clearRect(0, 0, doc.width, doc.height);
    for (const l of doc.layers) {
      if (!l.visible || l.opacity <= 0) continue;
      cctx.globalAlpha = l.opacity;
      cctx.globalCompositeOperation = l.blend;
      cctx.drawImage(l.canvas, 0, 0);
    }
    cctx.globalAlpha = 1;
    cctx.globalCompositeOperation = "source-over";
  }

  // ---- overlay: selection marching ants + tool preview --------------------
  let antsOffset = 0;
  let showGuides = false;
  function drawGuides() {
    const W = doc.width, H = doc.height;
    octx.save();
    octx.lineWidth = 1 / zoom;
    // rule of thirds
    octx.strokeStyle = "rgba(255,255,255,0.5)";
    octx.beginPath();
    for (let i = 1; i <= 2; i++) {
      octx.moveTo((W * i) / 3, 0); octx.lineTo((W * i) / 3, H);
      octx.moveTo(0, (H * i) / 3); octx.lineTo(W, (H * i) / 3);
    }
    octx.stroke();
    // safe area (90%) — keep key content inside for social crops
    octx.strokeStyle = "rgba(34,211,238,0.7)";
    octx.setLineDash([6 / zoom, 5 / zoom]);
    octx.strokeRect(W * 0.05, H * 0.05, W * 0.9, H * 0.9);
    octx.restore();
  }
  function drawOverlay(preview) {
    octx.clearRect(0, 0, doc.width, doc.height);
    if (preview) preview(octx);
    if (showGuides) drawGuides();
    const s = doc.selection;
    if (s) {
      octx.save();
      octx.lineWidth = 1 / zoom;
      octx.setLineDash([4 / zoom, 4 / zoom]);
      octx.lineDashOffset = -antsOffset / zoom;
      octx.strokeStyle = "#000";
      octx.strokeRect(s.x + 0.5, s.y + 0.5, s.w, s.h);
      octx.strokeStyle = "#fff";
      octx.lineDashOffset = (-antsOffset + 4) / zoom;
      octx.strokeRect(s.x + 0.5, s.y + 0.5, s.w, s.h);
      octx.restore();
    }
  }
  (function antsLoop() {
    antsOffset = (antsOffset + 1) % 8;
    if (doc.selection && !livePreview) drawOverlay();
    requestAnimationFrame(antsLoop);
  })();
  let livePreview = null; // a function while a tool drags

  // =========================================================================
  // History (undo / redo) — full-document snapshots, capped.
  // =========================================================================
  const HIST_MAX = 18;
  let history = [];
  let histIndex = -1;
  function snapshot() {
    return {
      width: doc.width, height: doc.height, active: doc.active,
      selection: doc.selection ? { ...doc.selection } : null,
      layers: doc.layers.map((l) => ({
        id: l.id, name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend, locked: !!l.locked,
        data: l.ctx.getImageData(0, 0, l.canvas.width, l.canvas.height),
      })),
    };
  }
  function pushHistory() {
    history = history.slice(0, histIndex + 1);
    history.push(snapshot());
    if (history.length > HIST_MAX) history.shift();
    histIndex = history.length - 1;
  }
  function restore(state) {
    doc.width = state.width; doc.height = state.height;
    doc.selection = state.selection ? { ...state.selection } : null;
    doc.layers = state.layers.map((s) => {
      const c = document.createElement("canvas");
      c.width = state.width; c.height = state.height;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.putImageData(s.data, 0, 0);
      return { id: s.id, name: s.name, canvas: c, ctx, visible: s.visible, opacity: s.opacity, blend: s.blend, locked: !!s.locked };
    });
    doc.active = clamp(state.active, 0, doc.layers.length - 1);
    nextLayerId = Math.max(nextLayerId, ...doc.layers.map((l) => l.id + 1));
    syncStageSize(); recomposite(); renderLayers(); drawOverlay(); updateStatus();
  }
  function undo() { if (histIndex > 0) restore(history[--histIndex]); }
  function redo() { if (histIndex < history.length - 1) restore(history[++histIndex]); }

  // =========================================================================
  // Coordinates
  // =========================================================================
  function toDoc(e) {
    const r = composite.getBoundingClientRect();
    return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom };
  }
  // Wrap layer drawing in the active selection clip, when present.
  function withSelectionClip(ctx, fn) {
    const s = doc.selection;
    ctx.save();
    if (s) { ctx.beginPath(); ctx.rect(s.x, s.y, s.w, s.h); ctx.clip(); }
    fn(ctx);
    ctx.restore();
  }

  // =========================================================================
  // Pointer handling — dispatch to the active tool
  // =========================================================================
  let drag = null;
  composite.addEventListener("pointerdown", onDown);
  overlay.addEventListener("pointerdown", onDown);
  // Tools that write pixels into the active layer — blocked when it's locked.
  const EDIT_TOOLS = ["brush", "pencil", "eraser", "bucket", "line", "rect", "ellipse", "text", "move", "gradient", "clone", "smudge"];
  function onDown(e) {
    if (e.button !== 0) return;
    const a = activeLayer();
    if (a && a.locked && EDIT_TOOLS.includes(tool)) { updateStatus(); $("#sg-selinfo").textContent = "layer locked 🔒"; return; }
    const p = toDoc(e);
    e.target.setPointerCapture(e.pointerId);
    drag = { start: p, last: p, ptr: e.pointerId, target: e.target, moved: false };
    (handlers[tool] || handlers.brush).down(p, e);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }
  function onMove(e) {
    const p = toDoc(e);
    updateCursor(p);
    if (!drag) return;
    drag.moved = true;
    (handlers[tool] || handlers.brush).move(p, drag.last, e);
    drag.last = p;
  }
  function onUp(e) {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    if (drag) (handlers[tool] || handlers.brush).up(toDoc(e), e);
    drag = null;
    livePreview = null;
    drawOverlay();
  }

  // ---- brush / pencil / eraser (stroke-layer for clean alpha) -------------
  let strokeCanvas = null, strokeCtx = null;
  function beginStroke() {
    strokeCanvas = document.createElement("canvas");
    strokeCanvas.width = doc.width; strokeCanvas.height = doc.height;
    strokeCtx = strokeCanvas.getContext("2d");
    strokeCtx.lineCap = "round"; strokeCtx.lineJoin = "round";
    strokeCtx.strokeStyle = fg; strokeCtx.fillStyle = fg;
  }
  function strokeSeg(a, b, hard) {
    strokeCtx.lineWidth = opt.size;
    strokeCtx.imageSmoothingEnabled = !hard;
    strokeCtx.beginPath();
    strokeCtx.moveTo(a.x, a.y); strokeCtx.lineTo(b.x, b.y);
    strokeCtx.stroke();
    // round dab at the new point so dots/clicks register
    strokeCtx.beginPath();
    strokeCtx.arc(b.x, b.y, opt.size / 2, 0, Math.PI * 2);
    strokeCtx.fill();
  }
  function paintHandler(kind) {
    return {
      down(p) { beginStroke(); strokeSeg(p, p, kind === "pencil"); previewStroke(); },
      move(p, last) { strokeSeg(last, p, kind === "pencil"); previewStroke(); },
      up() {
        const a = activeLayer();
        withSelectionClip(a.ctx, (ctx) => {
          ctx.globalAlpha = kind === "pencil" ? 1 : opt.opacity;
          ctx.globalCompositeOperation = kind === "eraser" ? "destination-out" : "source-over";
          ctx.drawImage(strokeCanvas, 0, 0);
          ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
        });
        strokeCanvas = null;
        recomposite(); pushHistory();
      },
    };
  }
  function previewStroke() {
    const op = strokeTool() === "eraser" ? 1 : (strokeTool() === "pencil" ? 1 : opt.opacity);
    livePreview = (ctx) => { ctx.globalAlpha = op; ctx.drawImage(strokeCanvas, 0, 0); ctx.globalAlpha = 1; };
    drawOverlay(livePreview);
  }
  const strokeTool = () => tool;

  // ---- constrain helpers (Shift = square / 45°, aspect-lock for marquee) ---
  function squareEnd(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, m = Math.max(Math.abs(dx), Math.abs(dy));
    return { x: a.x + (dx < 0 ? -m : m), y: a.y + (dy < 0 ? -m : m) };
  }
  function angleSnap(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    const step = Math.PI / 4, ang = Math.round(Math.atan2(dy, dx) / step) * step;
    return { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
  }
  function ratioEnd(a, b, ratio) {
    let w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    if (w / Math.max(h, 1) > ratio) h = w / ratio; else w = h * ratio;
    return { x: a.x + (b.x < a.x ? -w : w), y: a.y + (b.y < a.y ? -h : h) };
  }
  function shapeEnd(kind, a, b, e) {
    if (!e || !e.shiftKey) return b;
    if (kind === "line") return angleSnap(a, b);
    if (kind === "rect" || kind === "ellipse") return squareEnd(a, b);
    return b;
  }
  function marqueeEnd(a, b, e) {
    if (opt.cropAspect) return ratioEnd(a, b, opt.cropAspect);
    if (e && e.shiftKey) return squareEnd(a, b);
    return b;
  }

  // ---- shapes (line / rect / ellipse) -------------------------------------
  function shapeHandler(kind) {
    return {
      down() {},
      move(p, last, e) {
        const end = shapeEnd(kind, drag.start, p, e);
        livePreview = (ctx) => drawShape(ctx, kind, drag.start, end, true);
        drawOverlay(livePreview);
      },
      up(p, e) {
        const end = shapeEnd(kind, drag.start, p, e);
        const a = activeLayer();
        withSelectionClip(a.ctx, (ctx) => {
          ctx.globalAlpha = opt.opacity;
          drawShape(ctx, kind, drag.start, end, false);
          ctx.globalAlpha = 1;
        });
        recomposite(); pushHistory();
      },
    };
  }
  function drawShape(ctx, kind, a, b, preview) {
    ctx.save();
    ctx.strokeStyle = fg; ctx.fillStyle = fg;
    ctx.lineWidth = opt.size;
    const filled = opt.shapeFill === "fill" && kind !== "line";
    if (preview) { ctx.globalAlpha = (ctx.globalAlpha || 1) * 0.8; }
    if (kind === "line") {
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineCap = "round"; ctx.stroke();
    } else if (kind === "rect") {
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
      if (filled) ctx.fillRect(x, y, w, h); else ctx.strokeRect(x, y, w, h);
    } else if (kind === "ellipse") {
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2, rx = Math.abs(b.x - a.x) / 2, ry = Math.abs(b.y - a.y) / 2;
      ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      if (filled) ctx.fill(); else ctx.stroke();
    }
    ctx.restore();
  }

  // ---- marquee select -----------------------------------------------------
  const marqueeHandler = {
    down() {},
    move(p, last, e) {
      const s = rectOf(drag.start, marqueeEnd(drag.start, p, e));
      livePreview = (ctx) => {
        ctx.save(); ctx.setLineDash([4 / zoom, 4 / zoom]); ctx.lineWidth = 1 / zoom;
        ctx.strokeStyle = "#22d3ee"; ctx.strokeRect(s.x + 0.5, s.y + 0.5, s.w, s.h); ctx.restore();
      };
      drawOverlay(livePreview);
    },
    up(p, e) {
      const s = rectOf(drag.start, marqueeEnd(drag.start, p, e));
      doc.selection = s.w > 2 && s.h > 2 ? s : null;
      drawOverlay(); updateStatus();
    },
  };
  function rectOf(a, b) {
    const x = clamp(Math.min(a.x, b.x), 0, doc.width), y = clamp(Math.min(a.y, b.y), 0, doc.height);
    const w = clamp(Math.abs(b.x - a.x), 0, doc.width - x), h = clamp(Math.abs(b.y - a.y), 0, doc.height - y);
    return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  }

  // ---- lasso (freehand) → bounding selection ------------------------------
  const lassoHandler = {
    pts: [],
    down(p) { this.pts = [p]; },
    move(p) {
      this.pts.push(p);
      const pts = this.pts;
      livePreview = (ctx) => {
        ctx.save(); ctx.setLineDash([4 / zoom, 4 / zoom]); ctx.lineWidth = 1 / zoom; ctx.strokeStyle = "#e879f9";
        ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y); pts.forEach((q) => ctx.lineTo(q.x, q.y)); ctx.stroke(); ctx.restore();
      };
      drawOverlay(livePreview);
    },
    up() {
      const xs = this.pts.map((p) => p.x), ys = this.pts.map((p) => p.y);
      const s = rectOf({ x: Math.min(...xs), y: Math.min(...ys) }, { x: Math.max(...xs), y: Math.max(...ys) });
      doc.selection = s.w > 2 && s.h > 2 ? s : null;
      drawOverlay(); updateStatus();
    },
  };

  // ---- move (whole active layer) ------------------------------------------
  let moveSnap = null;
  const moveHandler = {
    down() { const a = activeLayer(); moveSnap = document.createElement("canvas"); moveSnap.width = doc.width; moveSnap.height = doc.height; moveSnap.getContext("2d").drawImage(a.canvas, 0, 0); },
    move(p) {
      const dx = p.x - drag.start.x, dy = p.y - drag.start.y;
      const a = activeLayer();
      a.ctx.clearRect(0, 0, doc.width, doc.height);
      a.ctx.drawImage(moveSnap, dx, dy);
      recomposite();
    },
    up() { moveSnap = null; pushHistory(); },
  };

  // ---- bucket fill --------------------------------------------------------
  const bucketHandler = {
    down(p) { floodFill(Math.floor(p.x), Math.floor(p.y)); },
    move() {}, up() {},
  };
  function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function floodFill(sx, sy) {
    if (sx < 0 || sy < 0 || sx >= doc.width || sy >= doc.height) return;
    const a = activeLayer();
    const img = a.ctx.getImageData(0, 0, doc.width, doc.height);
    const d = img.data, W = doc.width, H = doc.height;
    const sel = doc.selection;
    const idx = (x, y) => (y * W + x) * 4;
    const s0 = idx(sx, sy);
    const target = [d[s0], d[s0 + 1], d[s0 + 2], d[s0 + 3]];
    const [fr, fgg, fb] = hexToRgb(fg);
    const fa = Math.round(opt.opacity * 255);
    const tol = opt.tolerance;
    const match = (i) => {
      const dr = d[i] - target[0], dg = d[i + 1] - target[1], db = d[i + 2] - target[2], da = d[i + 3] - target[3];
      return dr * dr + dg * dg + db * db + da * da <= tol * tol * 4;
    };
    if (match(s0) && fr === target[0] && fgg === target[1] && fb === target[2] && fa === target[3]) return;
    const stack = [[sx, sy]];
    const inSel = (x, y) => !sel || (x >= sel.x && x < sel.x + sel.w && y >= sel.y && y < sel.y + sel.h);
    const seen = new Uint8Array(W * H);
    while (stack.length) {
      const [x, y] = stack.pop();
      if (x < 0 || y < 0 || x >= W || y >= H || !inSel(x, y)) continue;
      const pi = y * W + x;
      if (seen[pi]) continue;
      const i = pi * 4;
      if (!match(i)) continue;
      seen[pi] = 1;
      d[i] = fr; d[i + 1] = fgg; d[i + 2] = fb; d[i + 3] = fa;
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
    a.ctx.putImageData(img, 0, 0);
    recomposite(); pushHistory();
  }

  // ---- eyedropper ---------------------------------------------------------
  const pickerHandler = {
    down(p) {
      const x = clamp(Math.floor(p.x), 0, doc.width - 1), y = clamp(Math.floor(p.y), 0, doc.height - 1);
      const d = cctx.getImageData(x, y, 1, 1).data;
      if (d[3] === 0) return;
      setFg("#" + [d[0], d[1], d[2]].map((n) => n.toString(16).padStart(2, "0")).join(""));
    },
    move() {}, up() {},
  };

  // ---- hand (pan) ---------------------------------------------------------
  const handHandler = {
    down(_, e) { this.sx = e.clientX; this.sy = e.clientY; this.l = stageWrap.scrollLeft; this.t = stageWrap.scrollTop; },
    move(_, __, e) { stageWrap.scrollLeft = this.l - (e.clientX - this.sx); stageWrap.scrollTop = this.t - (e.clientY - this.sy); },
    up() {},
  };

  // ---- text ---------------------------------------------------------------
  const textHandler = {
    down(p, e) { openTextEditor(p, e); },
    move() {}, up() {},
  };
  function openTextEditor(p, e) {
    // Multi-line: a textarea so captions/quotes/titles can wrap. Enter = newline,
    // Ctrl/Cmd+Enter or clicking away commits, Escape cancels.
    const ed = document.createElement("textarea");
    ed.className = "sg-textedit";
    ed.rows = 1;
    ed.wrap = "off";
    ed.style.left = e.clientX - stage.getBoundingClientRect().left + "px";
    ed.style.top = e.clientY - stage.getBoundingClientRect().top - opt.font * 0.5 * zoom + "px";
    ed.style.fontSize = opt.font * zoom + "px";
    ed.style.fontFamily = opt.fontFam;
    ed.style.color = fg;
    ed.style.textAlign = opt.textAlign;
    ed.style.resize = "none";
    ed.style.overflow = "hidden";
    ed.style.lineHeight = "1.2";
    ed.style.whiteSpace = "pre";
    const autosize = () => { ed.style.height = "auto"; ed.style.height = ed.scrollHeight + "px"; ed.style.width = "auto"; ed.style.width = Math.max(40, ed.scrollWidth + 4) + "px"; };
    stage.appendChild(ed);
    autosize();
    ed.focus();
    let done = false;
    const commit = () => {
      if (done) return; done = true;
      const text = ed.value;
      ed.remove();
      if (!text.trim()) { recomposite(); return; }
      const a = activeLayer();
      withSelectionClip(a.ctx, (ctx) => {
        ctx.globalAlpha = opt.opacity;
        ctx.textBaseline = "top";
        ctx.textAlign = opt.textAlign;
        ctx.font = `${opt.font}px ${opt.fontFam}`;
        const lh = opt.font * 1.2;
        const lines = text.split("\n");
        // Anchor x by alignment so multi-line blocks align as a group.
        const tx = opt.textAlign === "left" ? p.x : opt.textAlign === "right" ? p.x : p.x;
        let ty = p.y - opt.font * 0.5;
        for (const line of lines) {
          if (opt.textShadow) {
            ctx.shadowColor = "rgba(0,0,0,0.55)";
            ctx.shadowBlur = opt.font * 0.14;
            ctx.shadowOffsetX = opt.font * 0.04;
            ctx.shadowOffsetY = opt.font * 0.05;
          }
          if (opt.textOutline) {
            ctx.lineWidth = Math.max(1, opt.font * 0.1);
            ctx.lineJoin = "round";
            ctx.strokeStyle = bg;
            ctx.strokeText(line, tx, ty);
            ctx.shadowColor = "transparent";
          }
          ctx.fillStyle = fg;
          ctx.fillText(line, tx, ty);
          ctx.shadowColor = "transparent";
          ty += lh;
        }
        ctx.globalAlpha = 1;
        ctx.textAlign = "left";
      });
      recomposite(); pushHistory();
    };
    ed.addEventListener("input", autosize);
    ed.addEventListener("keydown", (k) => {
      if (k.key === "Enter" && (k.ctrlKey || k.metaKey)) { k.preventDefault(); commit(); }
      else if (k.key === "Escape") { done = true; ed.remove(); }
      k.stopPropagation();
    });
    ed.addEventListener("blur", commit);
  }

  // ---- gradient -----------------------------------------------------------
  function drawGradient(ctx, a, b, preview) {
    const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
    const [r, g, bl] = hexToRgb(fg);
    if (opt.gradType === "fg-bg") {
      grad.addColorStop(0, fg); grad.addColorStop(1, bg);
    } else {
      grad.addColorStop(0, fg); grad.addColorStop(1, `rgba(${r},${g},${bl},0)`);
    }
    ctx.save();
    ctx.globalAlpha = opt.opacity * (preview ? 0.85 : 1);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, doc.width, doc.height);
    ctx.restore();
  }
  const gradientHandler = {
    down() {},
    move(p, last, e) {
      const end = e && e.shiftKey ? angleSnap(drag.start, p) : p;
      livePreview = (ctx) => drawGradient(ctx, drag.start, end, true);
      drawOverlay(livePreview);
    },
    up(p, e) {
      const end = e && e.shiftKey ? angleSnap(drag.start, p) : p;
      const a = activeLayer();
      withSelectionClip(a.ctx, (ctx) => drawGradient(ctx, drag.start, end, false));
      recomposite(); pushHistory();
    },
  };

  const handlers = {
    brush: paintHandler("brush"), pencil: paintHandler("pencil"), eraser: paintHandler("eraser"),
    line: shapeHandler("line"), rect: shapeHandler("rect"), ellipse: shapeHandler("ellipse"),
    marquee: marqueeHandler, lasso: lassoHandler, move: moveHandler, bucket: bucketHandler,
    gradient: gradientHandler, picker: pickerHandler, hand: handHandler, text: textHandler,
  };

  // =========================================================================
  // Adjustments & filters (pixel ops on active layer, within selection)
  // =========================================================================
  let adjBase = null; // ImageData cached before live adjustment
  function selBounds() {
    const s = doc.selection;
    return s ? s : { x: 0, y: 0, w: doc.width, h: doc.height };
  }
  function ensureAdjBase() {
    const b = selBounds();
    adjBase = activeLayer().ctx.getImageData(b.x, b.y, b.w, b.h);
  }
  function applyAdjLive() {
    if (activeLayer().locked) { $("#sg-selinfo").textContent = "layer locked 🔒"; return; }
    if (!adjBase) ensureAdjBase();
    const b = selBounds();
    const src = adjBase.data;
    const out = new ImageData(new Uint8ClampedArray(src), adjBase.width, adjBase.height);
    const d = out.data;
    const bright = +$("#sg-bright").value;
    const contrast = +$("#sg-contrast").value;
    const sat = +$("#sg-sat").value / 100;
    const hue = +$("#sg-hue").value;
    const cf = (259 * (contrast + 255)) / (255 * (259 - contrast)); // contrast factor
    for (let i = 0; i < d.length; i += 4) {
      let r = src[i], g = src[i + 1], bl = src[i + 2];
      // brightness
      r += bright; g += bright; bl += bright;
      // contrast
      r = cf * (r - 128) + 128; g = cf * (g - 128) + 128; bl = cf * (bl - 128) + 128;
      if (sat !== 0 || hue !== 0) {
        let [h, s, l] = rgbToHsl(r, g, bl);
        h = (h + hue / 360 + 1) % 1;
        s = clamp(s * (1 + sat), 0, 1);
        [r, g, bl] = hslToRgb(h, s, l);
      }
      d[i] = clamp(r, 0, 255); d[i + 1] = clamp(g, 0, 255); d[i + 2] = clamp(bl, 0, 255);
    }
    activeLayer().ctx.putImageData(out, b.x, b.y);
    recomposite();
  }
  function adjApply() { if (adjBase) { adjBase = null; resetAdjSliders(); pushHistory(); } }
  function adjReset() {
    if (adjBase) { const b = selBounds(); activeLayer().ctx.putImageData(adjBase, b.x, b.y); adjBase = null; recomposite(); }
    resetAdjSliders();
  }
  function resetAdjSliders() {
    for (const id of ["bright", "contrast", "sat", "hue"]) { $("#sg-" + id).value = 0; $("#sg-" + id + "-v").textContent = "0"; }
  }
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b); let h, s, l = (max + min) / 2;
    if (max === min) { h = s = 0; }
    else { const dd = max - min; s = l > 0.5 ? dd / (2 - max - min) : dd / (max + min);
      h = max === r ? (g - b) / dd + (g < b ? 6 : 0) : max === g ? (b - r) / dd + 2 : (r - g) / dd + 4; h /= 6; }
    return [h, s, l];
  }
  function hslToRgb(h, s, l) {
    let r, g, b;
    if (s === 0) { r = g = b = l; }
    else { const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
      const hk = (t) => { t = (t + 1) % 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
      r = hk(h + 1 / 3); g = hk(h); b = hk(h - 1 / 3); }
    return [r * 255, g * 255, b * 255];
  }
  // instant filters
  function filterPixels(fn) {
    const b = selBounds(), a = activeLayer();
    if (a.locked) { $("#sg-selinfo").textContent = "layer locked 🔒"; return; }
    const img = a.ctx.getImageData(b.x, b.y, b.w, b.h);
    fn(img.data, img.width, img.height);
    a.ctx.putImageData(img, b.x, b.y);
    recomposite(); pushHistory();
  }
  const fGrayscale = () => filterPixels((d) => { for (let i = 0; i < d.length; i += 4) { const v = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114; d[i] = d[i + 1] = d[i + 2] = v; } });
  const fInvert = () => filterPixels((d) => { for (let i = 0; i < d.length; i += 4) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; } });
  function convolve(d, w, h, kernel, divisor, bias) {
    const src = new Uint8ClampedArray(d); const k = kernel, side = 3, half = 1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let ky = 0; ky < side; ky++) for (let kx = 0; kx < side; kx++) {
        const px = clamp(x + kx - half, 0, w - 1), py = clamp(y + ky - half, 0, h - 1);
        const o = (py * w + px) * 4, kv = k[ky * side + kx];
        r += src[o] * kv; g += src[o + 1] * kv; b += src[o + 2] * kv;
      }
      const o = (y * w + x) * 4;
      d[o] = r / divisor + bias; d[o + 1] = g / divisor + bias; d[o + 2] = b / divisor + bias;
    }
  }
  const fBlur = () => filterPixels((d, w, h) => convolve(d, w, h, [1, 2, 1, 2, 4, 2, 1, 2, 1], 16, 0));
  const fSharpen = () => filterPixels((d, w, h) => convolve(d, w, h, [0, -1, 0, -1, 5, -1, 0, -1, 0], 1, 0));

  // ---- one-click looks (quick colour grades for content) ------------------
  const luma = (r, g, b) => r * 0.299 + g * 0.587 + b * 0.114;
  function applyLook(name) {
    filterPixels((d) => {
      for (let i = 0; i < d.length; i += 4) {
        let r = d[i], g = d[i + 1], b = d[i + 2];
        if (name === "bw") { const v = luma(r, g, b), c = 1.12; r = g = b = (v - 128) * c + 128; }
        else if (name === "noir") { const v = luma(r, g, b), c = 1.4; r = g = b = (v - 128) * c + 124; }
        else if (name === "sepia") { const tr = 0.393 * r + 0.769 * g + 0.189 * b, tg = 0.349 * r + 0.686 * g + 0.168 * b, tb = 0.272 * r + 0.534 * g + 0.131 * b; r = tr; g = tg; b = tb; }
        else if (name === "warm") { r = r * 1.08 + 8; g = g * 1.02; b = b * 0.9; }
        else if (name === "cool") { r = r * 0.9; g = g; b = b * 1.1 + 8; }
        else if (name === "fade") { r = r * 0.82 + 30; g = g * 0.82 + 30; b = b * 0.82 + 24; }
        else if (name === "punch") { const c = 1.28; r = (r - 128) * c + 128; g = (g - 128) * c + 128; b = (b - 128) * c + 128; const l = luma(r, g, b), s = 1.25; r = l + (r - l) * s; g = l + (g - l) * s; b = l + (b - l) * s; }
        else if (name === "matte") { const f = (v) => v < 128 ? v * 0.85 + 20 : 128 * 0.85 + 20 + (v - 128) * 0.78; r = f(r); g = f(g); b = f(b); }
        d[i] = clamp(r, 0, 255); d[i + 1] = clamp(g, 0, 255); d[i + 2] = clamp(b, 0, 255);
      }
    });
  }
  // Radial darkening; source-atop keeps transparency intact. Repeat for stronger.
  function applyVignette() {
    const b = selBounds(), a = activeLayer(), g = a.ctx;
    g.save();
    if (doc.selection) { g.beginPath(); g.rect(b.x, b.y, b.w, b.h); g.clip(); }
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2, rad = Math.hypot(b.w, b.h) / 2;
    const grad = g.createRadialGradient(cx, cy, rad * 0.5, cx, cy, rad);
    grad.addColorStop(0, "rgba(0,0,0,0)");
    grad.addColorStop(1, "rgba(0,0,0,0.55)");
    g.globalCompositeOperation = "source-atop";
    g.fillStyle = grad;
    g.fillRect(b.x, b.y, b.w, b.h);
    g.restore();
    recomposite(); pushHistory();
  }

  // Remove background: make pixels matching the background colour transparent on
  // the active layer. No ML — this is a colour-similarity removal that works
  // best on flat/solid backgrounds. "From edges" floods transparency inward from
  // the canvas border (keeps same-colour pixels inside the subject); "all"
  // clears every matching pixel. Edges are feathered for a soft, anti-aliased
  // cutout. Operates on the whole active layer and is undoable.
  function removeBackground() {
    const a = activeLayer();
    if (!a) return;
    const W = doc.width, H = doc.height;
    const img = a.ctx.getImageData(0, 0, W, H);
    const d = img.data;
    const tol = +($("#sg-bgtol")?.value ?? 50);
    const mode = $("#sg-bgmode")?.value || "edges";
    const sample = $("#sg-bgsample")?.value || "corners";
    const idx = (x, y) => (y * W + x) * 4;

    // Target background colour.
    let tr, tg, tb;
    if (sample === "fg") {
      [tr, tg, tb] = hexToRgb(fg);
    } else {
      const pts = [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1], [(W >> 1), 0], [(W >> 1), H - 1], [0, (H >> 1)], [W - 1, (H >> 1)]];
      let rs = 0, gs = 0, bs = 0, n = 0;
      for (const [x, y] of pts) { const i = idx(x, y); if (d[i + 3] > 8) { rs += d[i]; gs += d[i + 1]; bs += d[i + 2]; n++; } }
      if (!n) { if (typeof toast === "function") toast("Nothing to sample on this layer", "error"); return; }
      tr = rs / n; tg = gs / n; tb = bs / n;
    }

    const hard = tol * tol * 3 * 0.25; // fully transparent below this squared distance
    const soft = tol * tol * 3;        // feather between hard..soft; subject beyond
    // Returns the new alpha for a pixel, or -1 if it's the subject (no change).
    const newAlpha = (i) => {
      const dr = d[i] - tr, dg = d[i + 1] - tg, db = d[i + 2] - tb;
      const dist2 = dr * dr + dg * dg + db * db;
      if (dist2 <= hard) return 0;
      if (dist2 <= soft) return Math.round(((dist2 - hard) / (soft - hard)) * d[i + 3]);
      return -1;
    };

    if (mode === "all") {
      for (let i = 0; i < d.length; i += 4) { const na = newAlpha(i); if (na >= 0) d[i + 3] = na; }
    } else {
      // Contiguous flood from every border pixel inward.
      const seen = new Uint8Array(W * H);
      const stack = [];
      for (let x = 0; x < W; x++) { stack.push(x, 0, x, H - 1); }
      for (let y = 0; y < H; y++) { stack.push(0, y, W - 1, y); }
      while (stack.length) {
        const y = stack.pop(), x = stack.pop();
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const p = y * W + x;
        if (seen[p]) continue;
        seen[p] = 1;
        const na = newAlpha(p * 4);
        if (na < 0) continue; // hit the subject edge — stop spreading here
        d[p * 4 + 3] = na;
        stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
      }
    }
    a.ctx.putImageData(img, 0, 0);
    recomposite(); pushHistory();
    if (typeof toast === "function") toast("Background removed", "success");
  }

  // =========================================================================
  // UI wiring
  // =========================================================================
  function buildTools() {
    const wrap = $("#sg-tools");
    wrap.innerHTML = "";
    for (const t of TOOLS) {
      if (t.id === "sep") { const s = document.createElement("div"); s.className = "sg-tool-sep"; wrap.appendChild(s); continue; }
      const b = document.createElement("button");
      b.className = "sg-tool" + (t.id === tool ? " on" : "");
      b.dataset.tool = t.id;
      b.title = `${t.name} (${t.key})`;
      b.innerHTML = `${t.icon}<span class="kbd">${t.key}</span>`;
      b.onclick = () => setTool(t.id);
      wrap.appendChild(b);
    }
  }
  function setTool(id) {
    tool = id;
    document.querySelectorAll(".sg-tool").forEach((b) => b.classList.toggle("on", b.dataset.tool === id));
    const meta = TOOLS.find((t) => t.id === id);
    $("#sg-tool-name").textContent = meta ? meta.name : "";
    $("#sg-shape-row").style.display = ["rect", "ellipse"].includes(id) ? "" : "none";
    $("#sg-tol-row").style.display = id === "bucket" ? "" : "none";
    $("#sg-font-row").style.display = id === "text" ? "" : "none";
    $("#sg-textstyle-row").style.display = id === "text" ? "" : "none";
    $("#sg-aspect-row").style.display = id === "marquee" ? "" : "none";
    $("#sg-grad-row").style.display = id === "gradient" ? "" : "none";
    $("#sg-size").parentElement.style.display = usesSize(id) ? "" : "none";
    $("#sg-opacity").parentElement.style.display = usesOpacity(id) ? "" : "none";
    stageWrap.style.cursor = id === "hand" ? "grab" : id === "text" ? "text" : "crosshair";
  }

  function renderLayers() {
    const wrap = $("#sg-layers"); wrap.innerHTML = "";
    doc.layers.forEach((l, i) => {
      const row = document.createElement("div");
      row.className = "sg-layer" + (i === doc.active ? " on" : "");
      row.dataset.idx = i;
      row.onclick = () => { doc.active = i; renderLayers(); syncLayerControls(); };
      row.oncontextmenu = (e) => openLayerMenu(e, i);
      enableLayerReorder(row, l);
      const eye = document.createElement("span");
      eye.className = "eye" + (l.visible ? "" : " off"); eye.textContent = l.visible ? "👁" : "—";
      eye.onclick = (e) => { e.stopPropagation(); l.visible = !l.visible; recomposite(); renderLayers(); };
      const thumb = document.createElement("canvas");
      thumb.className = "thumb"; thumb.width = 38; thumb.height = 38;
      // draw the layer fit inside the square thumb, preserving the doc aspect
      const tctx = thumb.getContext("2d");
      const ts = Math.min(38 / doc.width, 38 / doc.height);
      const tw = doc.width * ts, th = doc.height * ts;
      tctx.drawImage(l.canvas, (38 - tw) / 2, (38 - th) / 2, tw, th);
      const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = l.name;
      nm.ondblclick = (e) => { e.stopPropagation(); editLayerName(nm, l); };
      const lock = document.createElement("span");
      lock.className = "lock" + (l.locked ? " on" : "");
      lock.textContent = l.locked ? "🔒" : "🔓";
      lock.title = l.locked ? "Locked — click to unlock" : "Lock layer";
      lock.onclick = (e) => { e.stopPropagation(); l.locked = !l.locked; renderLayers(); pushHistory(); };
      row.append(eye, thumb, nm, lock);
      wrap.appendChild(row);
    });
    syncLayerControls();
  }
  function editLayerName(nm, l) {
    const inp = document.createElement("input"); inp.type = "text"; inp.value = l.name;
    nm.textContent = ""; nm.appendChild(inp); inp.focus(); inp.select();
    const done = () => { l.name = inp.value.trim() || l.name; renderLayers(); };
    inp.onblur = done; inp.onkeydown = (e) => { if (e.key === "Enter") done(); e.stopPropagation(); };
  }

  // ---- layer drag-to-reorder (Photoshop-style restacking) ----------------
  let dropLine = null;
  function layerRows(excludeIdx) {
    const wrap = $("#sg-layers");
    return [...wrap.children].filter((el) => el.classList.contains("sg-layer")).map((el) => {
      const r = el.getBoundingClientRect();
      return { el, idx: +el.dataset.idx, top: r.top, h: r.height };
    }).filter((r) => excludeIdx == null || r.idx !== excludeIdx).sort((a, b) => a.top - b.top); // visual top→bottom
  }
  // Visual slot (#rows whose mid is above the pointer) → array index.
  function dropSlot(clientY, from) {
    const others = layerRows(from);
    let slot = 0; for (const r of others) if (clientY > r.top + r.h / 2) slot++;
    return { slot, others };
  }
  function positionDropLine(clientY, from) {
    const wrap = $("#sg-layers"), wr = wrap.getBoundingClientRect();
    const { slot, others } = dropSlot(clientY, from);
    let y = 0;
    if (others.length) {
      if (slot === 0) y = others[0].top - wr.top;
      else if (slot >= others.length) { const last = others[others.length - 1]; y = last.top + last.h - wr.top; }
      else y = others[slot].top - wr.top;
    }
    if (!dropLine) { dropLine = document.createElement("div"); dropLine.className = "sg-drop-line"; wrap.appendChild(dropLine); }
    dropLine.style.top = (y + wrap.scrollTop) + "px";
  }
  function enableLayerReorder(row, layer) {
    row.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest(".eye") || e.target.closest("input")) return;
      const startY = e.clientY; let dragging = false;
      const from = doc.layers.indexOf(layer);
      const onMove = (ev) => {
        if (!dragging) { if (Math.abs(ev.clientY - startY) < 5) return; dragging = true; row.classList.add("dragging"); row.onclick = null; }
        positionDropLine(ev.clientY, from);
      };
      const onUp = (ev) => {
        window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp);
        if (dropLine) { dropLine.remove(); dropLine = null; }
        if (!dragging) return;
        const { slot, others } = dropSlot(ev.clientY, from);
        const target = clamp(others.length - slot, 0, doc.layers.length - 1);
        if (target !== from) {
          const [m] = doc.layers.splice(from, 1);
          doc.layers.splice(target, 0, m);
          doc.active = doc.layers.indexOf(m);
          recomposite(); renderLayers(); syncLayerControls(); pushHistory();
        } else renderLayers();
      };
      window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
    });
  }

  // ---- layer right-click context menu ------------------------------------
  function closeLayerMenu() { const m = $("#sg-ctx"); if (m) m.remove(); }
  function openLayerMenu(e, i) {
    e.preventDefault();
    doc.active = i; renderLayers(); syncLayerControls();
    closeLayerMenu();
    const menu = document.createElement("div"); menu.className = "sg-ctx"; menu.id = "sg-ctx";
    const items = [
      ["layer-dup", "Duplicate Layer"], ["layer-del", "Delete Layer"], ["sep"],
      ["layer-merge", "Merge Down"], ["layer-mergevis", "Merge Visible"], ["layer-flatten", "Flatten Image"], ["sep"],
      ["rename", "Rename…"],
    ];
    for (const it of items) {
      if (it[0] === "sep") { const s = document.createElement("div"); s.className = "sg-ctx-sep"; menu.appendChild(s); continue; }
      const b = document.createElement("button"); b.textContent = it[1];
      if (it[0] === "rename") b.onclick = () => { closeLayerMenu(); const nm = document.querySelector(`#sg-layers .sg-layer[data-idx="${doc.active}"] .nm`); if (nm) editLayerName(nm, doc.layers[doc.active]); };
      else { b.dataset.act = it[0]; b.onclick = () => closeLayerMenu(); } // global click handler runs the action
      menu.appendChild(b);
    }
    document.body.appendChild(menu);
    menu.style.left = Math.min(e.clientX, window.innerWidth - menu.offsetWidth - 6) + "px";
    menu.style.top = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 6) + "px";
  }
  window.addEventListener("pointerdown", (e) => { if (!e.target.closest("#sg-ctx")) closeLayerMenu(); }, true);
  function syncLayerControls() {
    const l = activeLayer(); if (!l) return;
    $("#sg-layer-opacity").value = Math.round(l.opacity * 100);
    $("#sg-layer-opacity-v").textContent = Math.round(l.opacity * 100);
    $("#sg-blend").value = l.blend;
  }

  function setFg(hex) { fg = hex; $("#sg-fg").style.background = hex; $("#sg-hex").value = hex; $("#sg-colorpick").value = hex; pushRecent(hex); }
  function setBg(hex) { bg = hex; $("#sg-bg").style.background = hex; }
  const recents = [];
  function pushRecent(hex) {
    if (recents.includes(hex)) return;
    recents.unshift(hex); if (recents.length > 16) recents.pop();
    const pal = $("#sg-palette"); pal.innerHTML = "";
    const base = ["#000000", "#ffffff", "#ff4d4d", "#ffa64d", "#ffe14d", "#7ed98a", "#22d3ee", "#5b8cff", "#b06bff", "#e879f9"];
    [...recents, ...base].slice(0, 24).forEach((c) => {
      const i = document.createElement("i"); i.style.background = c; i.title = c;
      i.onclick = () => setFg(c); pal.appendChild(i);
    });
  }

  function updateStatus() {
    $("#sg-docsize").textContent = `${doc.width} × ${doc.height}`;
    const s = doc.selection;
    $("#sg-selinfo").textContent = s ? `sel ${s.w}×${s.h}` : "";
  }
  function updateCursor(p) {
    $("#sg-cursorpos").textContent = `${clamp(Math.floor(p.x), 0, doc.width)}, ${clamp(Math.floor(p.y), 0, doc.height)}`;
  }

  // =========================================================================
  // File: new / open / export
  // =========================================================================
  function newDoc(w, h, bgFill) {
    doc.width = w; doc.height = h; doc.selection = null;
    doc.layers = [makeLayer("Background", bgFill || "#ffffff")];
    doc.active = 0;
    syncStageSize(); recomposite(); renderLayers(); drawOverlay(); updateStatus();
    history = []; histIndex = -1; pushHistory();
    zoomFit();
  }
  function openImage(file) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      newDoc(img.naturalWidth, img.naturalHeight, null);
      activeLayer().name = file.name.replace(/\.[^.]+$/, "");
      activeLayer().ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      recomposite(); renderLayers(); history = []; histIndex = -1; pushHistory();
    };
    img.src = url;
  }
  // ---- flatten + download helpers -----------------------------------------
  // Flatten all visible layers to a fresh canvas at doc resolution. `opaqueBg`
  // paints a solid backdrop first (needed for formats without alpha, e.g. JPEG).
  function flattenCanvas(opaqueBg) {
    const out = document.createElement("canvas"); out.width = doc.width; out.height = doc.height;
    const o = out.getContext("2d");
    if (opaqueBg) { o.fillStyle = opaqueBg; o.fillRect(0, 0, doc.width, doc.height); }
    for (const l of doc.layers) {
      if (!l.visible || l.opacity <= 0) continue;
      o.globalAlpha = l.opacity; o.globalCompositeOperation = l.blend;
      o.drawImage(l.canvas, 0, 0);
    }
    return out;
  }
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    // fallback: also open in a new tab in case the sandbox blocks the download
    setTimeout(() => { try { window.open(url, "_blank"); } catch (e) {} URL.revokeObjectURL(url); }, 1500);
  }
  // Quick PNG export (Ctrl+S) — no dialog.
  function exportQuick() {
    flattenCanvas().toBlob((b) => { downloadBlob(b, "imago-export.png"); toast("Exported PNG"); }, "image/png");
  }

  // ---- clipboard ----------------------------------------------------------
  function blobToImage(blob) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = (e) => { URL.revokeObjectURL(url); rej(e); };
      img.src = url;
    });
  }
  // Try the async Clipboard API. Returns an Image or null (denied / empty /
  // unsupported). Needs the iframe `allow="clipboard-read"` + a user gesture.
  async function readClipboardImage() {
    try {
      if (!navigator.clipboard || !navigator.clipboard.read) return null;
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const type = it.types.find((t) => t.startsWith("image/"));
        if (type) return await blobToImage(await it.getType(type));
      }
    } catch (e) { /* needs gesture / permission / focus — caller falls back */ }
    return null;
  }
  // Drop an image onto a fresh layer, centered in the doc, and select it.
  function placeImageAsLayer(img, name) {
    const layer = makeLayer(name || "Pasted");
    const x = Math.round((doc.width - img.naturalWidth) / 2);
    const y = Math.round((doc.height - img.naturalHeight) / 2);
    layer.ctx.drawImage(img, x, y);
    doc.layers.splice(doc.active + 1, 0, layer);
    doc.active++;
    recomposite(); renderLayers(); pushHistory();
  }
  // New document sized to exactly contain `img`, with the image as its content.
  function docFromImage(img, name) {
    newDoc(img.naturalWidth, img.naturalHeight, null);
    activeLayer().name = name || "Clipboard";
    activeLayer().ctx.drawImage(img, 0, 0);
    recomposite(); renderLayers(); history = []; histIndex = -1; pushHistory();
  }
  async function newFromClipboard() {
    const img = await readClipboardImage();
    if (!img) return toast("No image on the clipboard. Copy an image first, then try again.");
    docFromImage(img, "Clipboard");
    toast(`New ${img.naturalWidth} × ${img.naturalHeight} document from clipboard`);
  }
  async function pasteFromClipboard() {
    const img = await readClipboardImage();
    if (!img) return toast("No image on the clipboard. Copy an image, then Paste (or press Ctrl+V).");
    placeImageAsLayer(img, "Pasted");
    toast(`Pasted ${img.naturalWidth} × ${img.naturalHeight}`);
  }
  async function copyToClipboard() {
    try {
      const blob = await new Promise((r) => flattenCanvas().toBlob(r, "image/png"));
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast("Image copied to clipboard");
    } catch (e) { toast("Couldn't copy to clipboard: " + ((e && e.message) || e)); }
  }

  // Ctrl+V anywhere (except while editing a text field) pastes a clipboard image
  // as a new layer. This path works even when the async Clipboard API is blocked.
  window.addEventListener("paste", (e) => {
    const tag = e.target && e.target.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.type && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) {
          e.preventDefault();
          blobToImage(f).then((img) => { placeImageAsLayer(img, "Pasted"); toast(`Pasted ${img.naturalWidth} × ${img.naturalHeight}`); });
          return;
        }
      }
    }
  });

  // ---- drag & drop an image file onto the canvas --------------------------
  stageWrap.addEventListener("dragover", (e) => { e.preventDefault(); });
  stageWrap.addEventListener("drop", (e) => {
    e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && f.type.startsWith("image/")) openImage(f);
  });

  // hidden file input
  const fileInput = document.createElement("input");
  fileInput.type = "file"; fileInput.accept = "image/*"; fileInput.style.display = "none";
  fileInput.onchange = () => { if (fileInput.files[0]) openImage(fileInput.files[0]); fileInput.value = ""; };
  document.body.appendChild(fileInput);

  // =========================================================================
  // Modal + toast (vanilla, styled in imago.css)
  // =========================================================================
  function openModal(title) {
    const overlay = document.createElement("div");
    overlay.className = "sg-modal-overlay";
    const card = document.createElement("div");
    card.className = "sg-modal";
    const head = document.createElement("div");
    head.className = "sg-modal-h";
    const t = document.createElement("span"); t.textContent = title;
    const x = document.createElement("button"); x.className = "sg-modal-x"; x.textContent = "✕";
    head.append(t, x);
    const body = document.createElement("div"); body.className = "sg-modal-body";
    card.append(head, body); overlay.appendChild(card);
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    x.onclick = close;
    overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) close(); });
    const onEsc = (e) => { if (e.key === "Escape") { close(); window.removeEventListener("keydown", onEsc, true); } };
    window.addEventListener("keydown", onEsc, true);
    return { overlay, body, close };
  }
  let toastT = null;
  function toast(msg) {
    let el = $("#sg-toast");
    if (!el) { el = document.createElement("div"); el.id = "sg-toast"; el.className = "sg-toast"; document.body.appendChild(el); }
    el.textContent = msg; el.classList.add("show");
    clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove("show"), 2600);
  }

  // =========================================================================
  // Size presets (standard + social) — shared by the New and Resize dialogs.
  // =========================================================================
  const SIZE_PRESETS = [
    { group: "Standard", items: [
      ["Full HD — 1920 × 1080", 1920, 1080],
      ["HD — 1280 × 720", 1280, 720],
      ["4K UHD — 3840 × 2160", 3840, 2160],
      ["Square — 1080 × 1080", 1080, 1080],
      ["A4 @ 150dpi — 1240 × 1754", 1240, 1754],
    ] },
    { group: "Instagram", items: [
      ["Post · Square — 1080 × 1080", 1080, 1080],
      ["Post · Portrait — 1080 × 1350", 1080, 1350],
      ["Post · Landscape — 1080 × 566", 1080, 566],
      ["Story / Reel — 1080 × 1920", 1080, 1920],
      ["Profile — 320 × 320", 320, 320],
    ] },
    { group: "Facebook", items: [
      ["Feed post — 1200 × 630", 1200, 630],
      ["Story — 1080 × 1920", 1080, 1920],
      ["Cover — 820 × 312", 820, 312],
      ["Event — 1200 × 628", 1200, 628],
      ["Profile — 170 × 170", 170, 170],
    ] },
    { group: "X / Twitter", items: [
      ["Post — 1600 × 900", 1600, 900],
      ["Header — 1500 × 500", 1500, 500],
      ["Profile — 400 × 400", 400, 400],
    ] },
    { group: "YouTube", items: [
      ["Thumbnail — 1280 × 720", 1280, 720],
      ["Channel art — 2560 × 1440", 2560, 1440],
    ] },
    { group: "TikTok", items: [
      ["Video — 1080 × 1920", 1080, 1920],
    ] },
    { group: "LinkedIn", items: [
      ["Post — 1200 × 627", 1200, 627],
      ["Cover — 1584 × 396", 1584, 396],
    ] },
    { group: "Pinterest", items: [
      ["Pin — 1000 × 1500", 1000, 1500],
    ] },
  ];
  function presetOptionsHtml() {
    return SIZE_PRESETS.map((cat) =>
      `<optgroup label="${cat.group}">` +
      cat.items.map(([n, w, h]) => `<option value="${w}x${h}">${n}</option>`).join("") +
      `</optgroup>`).join("");
  }

  // =========================================================================
  // Image ops — resize (resample), crop to selection, rotate, flip.
  // All rebuild every layer's backing canvas at the new dimensions.
  // =========================================================================
  function remapLayers(nw, nh, draw) {
    for (const l of doc.layers) {
      const tmp = document.createElement("canvas");
      tmp.width = nw; tmp.height = nh;
      const t = tmp.getContext("2d");
      t.imageSmoothingEnabled = true; t.imageSmoothingQuality = "high";
      draw(t, l);
      l.canvas.width = nw; l.canvas.height = nh;
      l.ctx = l.canvas.getContext("2d", { willReadFrequently: true });
      l.ctx.drawImage(tmp, 0, 0);
    }
    doc.width = nw; doc.height = nh; doc.selection = null;
    syncStageSize(); recomposite(); renderLayers(); drawOverlay(); updateStatus();
    pushHistory(); zoomFit();
  }
  function resampleDoc(w, h) { remapLayers(w, h, (t, l) => t.drawImage(l.canvas, 0, 0, w, h)); }
  function cropToSelection() {
    const s = doc.selection;
    if (!s || s.w < 1 || s.h < 1) return toast("Make a selection first (M / L), then crop.");
    remapLayers(s.w, s.h, (t, l) => t.drawImage(l.canvas, -s.x, -s.y));
    toast(`Cropped to ${s.w} × ${s.h}`);
  }
  function transformDoc(kind) {
    const rot = kind === "cw" || kind === "ccw";
    const nw = rot ? doc.height : doc.width, nh = rot ? doc.width : doc.height;
    remapLayers(nw, nh, (t, l) => {
      t.save();
      if (kind === "cw") { t.translate(nw, 0); t.rotate(Math.PI / 2); }
      else if (kind === "ccw") { t.translate(0, nh); t.rotate(-Math.PI / 2); }
      else if (kind === "fl-h") { t.translate(nw, 0); t.scale(-1, 1); }
      else if (kind === "fl-v") { t.translate(0, nh); t.scale(1, -1); }
      t.drawImage(l.canvas, 0, 0);
      t.restore();
    });
  }

  // =========================================================================
  // Layer merges — merge down, merge visible, flatten.
  // =========================================================================
  function drawLayerInto(ctx, l) {
    ctx.save();
    ctx.globalAlpha = l.opacity; ctx.globalCompositeOperation = l.blend;
    ctx.drawImage(l.canvas, 0, 0);
    ctx.restore();
  }
  function mergeDown() {
    if (doc.active <= 0) return toast("No layer below to merge into.");
    const top = doc.layers[doc.active], bottom = doc.layers[doc.active - 1];
    drawLayerInto(bottom.ctx, top);
    doc.layers.splice(doc.active, 1); doc.active--;
    recomposite(); renderLayers(); pushHistory();
  }
  function flatten(onlyVisible) {
    const merged = makeLayer(onlyVisible ? "Merged" : "Flattened");
    for (const l of doc.layers) {
      if (onlyVisible && (!l.visible || l.opacity <= 0)) continue;
      drawLayerInto(merged.ctx, l);
    }
    if (onlyVisible) {
      doc.layers = doc.layers.filter((l) => !(l.visible && l.opacity > 0));
      doc.layers.push(merged);
    } else {
      doc.layers = [merged];
    }
    doc.active = doc.layers.length - 1;
    recomposite(); renderLayers(); pushHistory();
  }

  // ---- New dialog ---------------------------------------------------------
  function openNewDialog() {
    const { body, close } = openModal("New image");
    body.innerHTML = `
      <div class="sg-mrow"><label>Preset</label>
        <select id="sg-npreset" style="flex:1"><option value="">Custom…</option>${presetOptionsHtml()}</select>
      </div>
      <div class="sg-mrow"><label>Width</label><input type="number" id="sg-nw" min="1" max="8000" value="${doc.width}"><span class="sg-unit">px</span></div>
      <div class="sg-mrow"><label>Height</label><input type="number" id="sg-nh" min="1" max="8000" value="${doc.height}"><span class="sg-unit">px</span></div>
      <div class="sg-mrow"><label>Background</label>
        <select id="sg-nbg" style="flex:1">
          <option value="#ffffff">White</option>
          <option value="transparent">Transparent</option>
          <option value="__bg">Background color</option>
        </select>
      </div>
      <div class="sg-mpresets">
        <button class="sg-btn" data-x="clip" title="Create a new document from the clipboard image at its exact size">⧉ From clipboard</button>
      </div>
      <div class="sg-mactions">
        <span class="sg-mhint">Tip: paste with Ctrl+V to drop an image onto the current canvas.</span>
        <button class="sg-btn" data-x="cancel">Cancel</button>
        <button class="sg-btn prim" data-x="create">Create</button>
      </div>`;
    const wEl = body.querySelector("#sg-nw"), hEl = body.querySelector("#sg-nh");
    body.querySelector("#sg-npreset").onchange = (e) => {
      if (!e.target.value) return;
      const [w, h] = e.target.value.split("x"); wEl.value = w; hEl.value = h;
    };
    body.querySelector('[data-x="clip"]').onclick = () => { close(); newFromClipboard(); };
    body.querySelector('[data-x="cancel"]').onclick = close;
    body.querySelector('[data-x="create"]').onclick = () => {
      const w = clamp(+wEl.value || doc.width, 1, 8000), h = clamp(+hEl.value || doc.height, 1, 8000);
      const sel = body.querySelector("#sg-nbg").value;
      const fill = sel === "transparent" ? null : sel === "__bg" ? bg : "#ffffff";
      newDoc(w, h, fill); close();
    };
  }

  // ---- Resize dialog ------------------------------------------------------
  function openResizeDialog() {
    const { body, close } = openModal("Resize image");
    body.innerHTML = `
      <div class="sg-mrow"><label>Preset</label>
        <select id="sg-rpreset" style="flex:1"><option value="">Custom…</option>${presetOptionsHtml()}</select>
      </div>
      <div class="sg-mrow"><label>Width</label><input type="number" id="sg-rw" min="1" max="8000" value="${doc.width}"><span class="sg-unit">px</span></div>
      <div class="sg-mrow"><label>Height</label><input type="number" id="sg-rh" min="1" max="8000" value="${doc.height}"><span class="sg-unit">px</span></div>
      <div class="sg-mrow"><label>Lock ratio</label><input type="checkbox" id="sg-rlock" checked style="margin-right:auto"></div>
      <div class="sg-mactions">
        <span class="sg-mhint">Resamples all layers. Use Crop (toolbar) to change canvas without scaling.</span>
        <button class="sg-btn" data-x="cancel">Cancel</button>
        <button class="sg-btn prim" data-x="apply">Resize</button>
      </div>`;
    const wEl = body.querySelector("#sg-rw"), hEl = body.querySelector("#sg-rh"), lock = body.querySelector("#sg-rlock");
    const aspect = doc.width / doc.height;
    wEl.oninput = () => { if (lock.checked) hEl.value = Math.max(1, Math.round(+wEl.value / aspect)); };
    hEl.oninput = () => { if (lock.checked) wEl.value = Math.max(1, Math.round(+hEl.value * aspect)); };
    body.querySelector("#sg-rpreset").onchange = (e) => {
      if (!e.target.value) return;
      const [w, h] = e.target.value.split("x"); wEl.value = w; hEl.value = h; lock.checked = false;
    };
    body.querySelector('[data-x="cancel"]').onclick = close;
    body.querySelector('[data-x="apply"]').onclick = () => {
      const w = clamp(+wEl.value || doc.width, 1, 8000), h = clamp(+hEl.value || doc.height, 1, 8000);
      resampleDoc(w, h); close(); toast(`Resized to ${w} × ${h}`);
    };
  }

  // ---- Export dialog ------------------------------------------------------
  function openExportDialog() {
    const { body, close } = openModal("Export image");
    body.innerHTML = `
      <div class="sg-mrow"><label>Format</label>
        <select id="sg-xfmt" style="flex:1">
          <option value="png">PNG — lossless, transparency</option>
          <option value="jpeg">JPEG — photos, smaller</option>
          <option value="webp">WebP — modern, small</option>
        </select>
      </div>
      <div class="sg-mrow" id="sg-xq-row"><label>Quality</label><input type="range" id="sg-xq" min="10" max="100" value="92"><span class="val" id="sg-xq-v">92</span></div>
      <div class="sg-mrow"><label>Resize</label>
        <select id="sg-xresize" style="flex:1">
          <option value="">Keep original (${doc.width} × ${doc.height})</option>
          ${presetOptionsHtml()}
        </select>
      </div>
      <div class="sg-mrow" id="sg-xfit-row" style="display:none"><label>Fit</label>
        <select id="sg-xfit" style="flex:1">
          <option value="cover">Fill &amp; crop</option>
          <option value="contain">Fit (letterbox)</option>
          <option value="stretch">Stretch</option>
        </select>
      </div>
      <div class="sg-mactions">
        <button class="sg-btn" data-x="copy" title="Copy the flattened image to the clipboard">⧉ Copy</button>
        <span style="flex:1"></span>
        <button class="sg-btn" data-x="cancel">Cancel</button>
        <button class="sg-btn prim" data-x="save">Download</button>
      </div>`;
    const fmtEl = body.querySelector("#sg-xfmt"), qEl = body.querySelector("#sg-xq");
    const qRow = body.querySelector("#sg-xq-row");
    const resizeEl = body.querySelector("#sg-xresize"), fitRow = body.querySelector("#sg-xfit-row"), fitEl = body.querySelector("#sg-xfit");
    const syncQ = () => { qRow.style.display = fmtEl.value === "png" ? "none" : ""; };
    syncQ(); fmtEl.onchange = syncQ;
    resizeEl.onchange = () => { fitRow.style.display = resizeEl.value ? "" : "none"; };
    qEl.oninput = () => { body.querySelector("#sg-xq-v").textContent = qEl.value; };
    const finalCanvas = (fmt) => {
      const bgFill = fmt === "jpeg" ? "#ffffff" : null;
      let cv = flattenCanvas(bgFill);
      if (resizeEl.value) {
        const [tw, th] = resizeEl.value.split("x").map(Number);
        cv = exportCanvasResized(cv, tw, th, fitEl.value, bgFill);
      }
      return cv;
    };
    body.querySelector('[data-x="cancel"]').onclick = close;
    body.querySelector('[data-x="copy"]').onclick = () => {
      const cv = finalCanvas("png");
      cv.toBlob(async (b) => {
        try { await navigator.clipboard.write([new ClipboardItem({ "image/png": b })]); toast("Image copied to clipboard"); }
        catch (e) { toast("Couldn't copy to clipboard: " + ((e && e.message) || e)); }
      }, "image/png");
      close();
    };
    body.querySelector('[data-x="save"]').onclick = () => {
      const fmt = fmtEl.value;
      const mime = fmt === "jpeg" ? "image/jpeg" : fmt === "webp" ? "image/webp" : "image/png";
      const q = +qEl.value / 100;
      const cv = finalCanvas(fmt);
      cv.toBlob((b) => { downloadBlob(b, "imago-export." + (fmt === "jpeg" ? "jpg" : fmt)); toast("Exported " + fmt.toUpperCase()); }, mime, fmt === "png" ? undefined : q);
      close();
    };
  }
  // Scale a flattened canvas into a target size for export (no change to the doc).
  function exportCanvasResized(src, tw, th, fit, bgFill) {
    const out = document.createElement("canvas"); out.width = tw; out.height = th;
    const o = out.getContext("2d");
    if (bgFill) { o.fillStyle = bgFill; o.fillRect(0, 0, tw, th); }
    o.imageSmoothingEnabled = true; o.imageSmoothingQuality = "high";
    const sw = src.width, sh = src.height;
    let dw, dh, dx, dy;
    if (fit === "stretch") { dw = tw; dh = th; dx = 0; dy = 0; }
    else { const sc = fit === "cover" ? Math.max(tw / sw, th / sh) : Math.min(tw / sw, th / sh); dw = sw * sc; dh = sh * sc; dx = (tw - dw) / 2; dy = (th - dh) / 2; }
    o.drawImage(src, dx, dy, dw, dh);
    return out;
  }

  // =========================================================================
  // Zoom
  // =========================================================================
  function setZoom(z, focus) {
    z = clamp(z, 0.05, 32);
    zoom = z; applyZoom();
  }
  function zoomFit() {
    const pad = 48;
    const zw = (stageWrap.clientWidth - pad) / doc.width;
    const zh = (stageWrap.clientHeight - pad) / doc.height;
    setZoom(Math.min(zw, zh, 1));
  }
  stageWrap.addEventListener("wheel", (e) => {
    if (e.ctrlKey) { e.preventDefault(); setZoom(zoom * (e.deltaY < 0 ? 1.12 : 0.89)); }
  }, { passive: false });

  // =========================================================================
  // Menu / panel events
  // =========================================================================
  document.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    switch (act) {
      case "new": openNewDialog(); break;
      case "open": fileInput.click(); break;
      case "paste": pasteFromClipboard(); break;
      case "export": openExportDialog(); break;
      case "img-resize": openResizeDialog(); break;
      case "img-crop": cropToSelection(); break;
      case "img-rcw": transformDoc("cw"); break;
      case "img-rccw": transformDoc("ccw"); break;
      case "img-flh": transformDoc("fl-h"); break;
      case "img-flv": transformDoc("fl-v"); break;
      case "undo": undo(); break;
      case "redo": redo(); break;
      case "zoom-in": setZoom(zoom * 1.2); break;
      case "zoom-out": setZoom(zoom / 1.2); break;
      case "zoom-100": setZoom(1); break;
      case "zoom-fit": zoomFit(); break;
      case "layer-add": doc.layers.splice(doc.active + 1, 0, makeLayer("Layer " + nextLayerId)); doc.active++; recomposite(); renderLayers(); pushHistory(); break;
      case "layer-dup": { const l = activeLayer(); const c = makeLayer(l.name + " copy"); c.ctx.drawImage(l.canvas, 0, 0); c.opacity = l.opacity; c.blend = l.blend; doc.layers.splice(doc.active + 1, 0, c); doc.active++; recomposite(); renderLayers(); pushHistory(); break; }
      case "layer-del": if (doc.layers.length > 1) { doc.layers.splice(doc.active, 1); doc.active = clamp(doc.active, 0, doc.layers.length - 1); recomposite(); renderLayers(); pushHistory(); } break;
      case "layer-up": if (doc.active < doc.layers.length - 1) { [doc.layers[doc.active], doc.layers[doc.active + 1]] = [doc.layers[doc.active + 1], doc.layers[doc.active]]; doc.active++; recomposite(); renderLayers(); pushHistory(); } break;
      case "layer-down": if (doc.active > 0) { [doc.layers[doc.active], doc.layers[doc.active - 1]] = [doc.layers[doc.active - 1], doc.layers[doc.active]]; doc.active--; recomposite(); renderLayers(); pushHistory(); } break;
      case "layer-merge": mergeDown(); break;
      case "layer-mergevis": flatten(true); break;
      case "layer-flatten": flatten(false); break;
      case "adj-apply": adjApply(); break;
      case "adj-reset": adjReset(); break;
      case "f-grayscale": fGrayscale(); break;
      case "f-invert": fInvert(); break;
      case "f-blur": fBlur(); break;
      case "f-sharpen": fSharpen(); break;
      case "f-removebg": removeBackground(); break;
      case "look-bw": case "look-noir": case "look-sepia": case "look-warm":
      case "look-cool": case "look-punch": case "look-fade": case "look-matte":
        applyLook(act.slice(5)); break;
      case "f-vignette": applyVignette(); break;
      case "guides": showGuides = !showGuides; $("#sg-guides-btn")?.classList.toggle("on", showGuides); drawOverlay(); break;
    }
  });

  // sliders / inputs
  const bind = (id, fn) => { const el = $("#" + id); el.addEventListener("input", () => fn(el.value, el)); };
  bind("sg-size", (v) => { opt.size = +v; $("#sg-size-v").textContent = v; });
  bind("sg-opacity", (v) => { opt.opacity = +v / 100; $("#sg-opacity-v").textContent = v; });
  bind("sg-tol", (v) => { opt.tolerance = +v; $("#sg-tol-v").textContent = v; });
  bind("sg-font", (v) => { opt.font = +v; });
  $("#sg-font-fam").addEventListener("change", (e) => { opt.fontFam = e.target.value; });
  $("#sg-shape-fill").addEventListener("change", (e) => { opt.shapeFill = e.target.value; });

  bind("sg-layer-opacity", (v) => { activeLayer().opacity = +v / 100; $("#sg-layer-opacity-v").textContent = v; recomposite(); });
  $("#sg-layer-opacity").addEventListener("change", pushHistory);
  $("#sg-blend").addEventListener("change", (e) => { activeLayer().blend = e.target.value; recomposite(); pushHistory(); });

  for (const id of ["bright", "contrast", "sat", "hue"]) bind("sg-" + id, (v) => { $("#sg-" + id + "-v").textContent = v; applyAdjLive(); });
  bind("sg-bgtol", (v) => { $("#sg-bgtol-v").textContent = v; });
  $("#sg-aspect").addEventListener("change", (e) => { opt.cropAspect = e.target.value === "free" ? null : +e.target.value; });
  $("#sg-textalign").addEventListener("change", (e) => { opt.textAlign = e.target.value; });
  $("#sg-textoutline").addEventListener("change", (e) => { opt.textOutline = e.target.checked; });
  $("#sg-textshadow").addEventListener("change", (e) => { opt.textShadow = e.target.checked; });
  $("#sg-gradtype").addEventListener("change", (e) => { opt.gradType = e.target.value; });

  $("#sg-colorpick").addEventListener("input", (e) => setFg(e.target.value));
  $("#sg-hex").addEventListener("change", (e) => { const v = e.target.value.trim(); if (/^#?[0-9a-fA-F]{6}$/.test(v)) setFg(v[0] === "#" ? v : "#" + v); });
  $("#sg-fg").addEventListener("click", () => $("#sg-colorpick").click());
  $("#sg-swap").addEventListener("click", () => { const t = fg; setFg(bg); setBg(t); });

  // =========================================================================
  // Keyboard shortcuts
  // =========================================================================
  window.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); redo(); return; }
    if ((e.ctrlKey || e.metaKey) && k === "s") { e.preventDefault(); exportQuick(); return; }
    if ((e.ctrlKey || e.metaKey) && k === "n") { e.preventDefault(); openNewDialog(); return; }
    if ((e.ctrlKey || e.metaKey) && k === "o") { e.preventDefault(); fileInput.click(); return; }
    if ((e.ctrlKey || e.metaKey) && k === "e") { e.preventDefault(); openExportDialog(); return; }
    if ((e.ctrlKey || e.metaKey) && k === "d") { e.preventDefault(); doc.selection = null; drawOverlay(); updateStatus(); return; }
    if ((e.ctrlKey || e.metaKey) && k === "a") { e.preventDefault(); doc.selection = { x: 0, y: 0, w: doc.width, h: doc.height }; drawOverlay(); updateStatus(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === "delete" || k === "backspace") { e.preventDefault(); if (activeLayer().locked) { $("#sg-selinfo").textContent = "layer locked 🔒"; return; } const b = selBounds(); activeLayer().ctx.clearRect(b.x, b.y, b.w, b.h); recomposite(); pushHistory(); return; }
    if (k === "[") { opt.size = clamp(opt.size - 2, 1, 400); $("#sg-size").value = opt.size; $("#sg-size-v").textContent = opt.size; return; }
    if (k === "]") { opt.size = clamp(opt.size + 2, 1, 400); $("#sg-size").value = opt.size; $("#sg-size-v").textContent = opt.size; return; }
    if (k === "x") { const t = fg; setFg(bg); setBg(t); return; }
    const t = TOOLS.find((t) => t.key && t.key.toLowerCase() === k);
    if (t) setTool(t.id);
  });

  // =========================================================================
  // Boot
  // =========================================================================
  buildTools();
  setTool("brush");
  setFg(fg); setBg(bg);
  newDoc(1000, 700, "#ffffff");
  window.addEventListener("resize", () => {});
})();
