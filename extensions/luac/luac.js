/* Luac — a Lua syntax validator mini-app for Scry.
 *
 * Pure client-side: vendored `luaparse` (UMD global `luaparse`) parses the
 * editor contents on every change (debounced) and we surface either a green
 * "valid" state or the first syntax error with line/column + a source preview.
 * The AST tab shows the parse tree when the code is valid.
 *
 * Sandbox notes (see extensions/README.md §5): the frame is `allow-scripts`
 * with NO `allow-same-origin`, so `localStorage` throws — we keep all state in
 * memory and don't persist. The `clipboard` permission grants the async
 * Clipboard API for the Copy button (with an execCommand fallback). */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var code = $("code");
  var gutter = $("gutter");
  var dialect = $("dialect");
  var sampleSel = $("sample");
  var statusEl = $("status");
  var problemsEl = $("problems");
  var problemCount = $("problem-count");
  var astEl = $("ast");
  var sbPos = $("sb-pos");
  var sbLines = $("sb-lines");
  var sbTime = $("sb-time");
  var sbSep = $("sb-sep");

  // ---- Sample snippets ---------------------------------------------------
  var SAMPLES = {
    "Hello world": [
      'local function greet(name)',
      '  return "Hello, " .. (name or "world") .. "!"',
      'end',
      '',
      'print(greet("Scry"))',
      '',
    ].join("\n"),
    "Table + iteration": [
      'local fruits = { "apple", "pear", "fig" }',
      '',
      'for i, name in ipairs(fruits) do',
      '  print(i, name)',
      'end',
      '',
      'local counts = {}',
      'for _, name in ipairs(fruits) do',
      '  counts[name] = (counts[name] or 0) + 1',
      'end',
      '',
    ].join("\n"),
    "OOP (metatables)": [
      'local Animal = {}',
      'Animal.__index = Animal',
      '',
      'function Animal.new(name, sound)',
      '  return setmetatable({ name = name, sound = sound }, Animal)',
      'end',
      '',
      'function Animal:speak()',
      '  return self.name .. " says " .. self.sound',
      'end',
      '',
      'print(Animal.new("Cat", "meow"):speak())',
      '',
    ].join("\n"),
    "Coroutines": [
      'local function producer()',
      '  for i = 1, 3 do',
      '    coroutine.yield(i * i)',
      '  end',
      'end',
      '',
      'local co = coroutine.create(producer)',
      'while true do',
      '  local ok, value = coroutine.resume(co)',
      '  if not value then break end',
      '  print(value)',
      'end',
      '',
    ].join("\n"),
    "5.3 integer division / bitwise": [
      '-- Requires the Lua 5.3 dialect',
      'local a = 17 // 5      -- floor division',
      'local b = 0xF0 & 0x0F  -- bitwise and',
      'local c = 1 << 4       -- shift',
      'print(a, b, c)',
      '',
    ].join("\n"),
    "Has a syntax error": [
      'local function broken(x)',
      '  if x > 0',
      '    return "positive"',
      '  end',
      'end',
      '',
    ].join("\n"),
  };

  Object.keys(SAMPLES).forEach(function (label) {
    var opt = document.createElement("option");
    opt.value = label;
    opt.textContent = label;
    sampleSel.appendChild(opt);
  });

  // ---- Editor: line-number gutter + cursor tracking ----------------------
  var lineCount = 1;

  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function renderGutter(errLine) {
    var n = lineCount;
    var html = "";
    for (var i = 1; i <= n; i++) {
      html += '<span class="gl' + (i === errLine ? " err" : "") + '">' + i + "</span>\n";
    }
    gutter.innerHTML = html;
    gutter.scrollTop = code.scrollTop;
  }

  function updateCursor() {
    var upto = code.value.slice(0, code.selectionStart);
    var nl = upto.lastIndexOf("\n");
    var line = (upto.match(/\n/g) || []).length + 1;
    var col = upto.length - nl; // 1-based (nl is -1 when on first line)
    sbPos.textContent = "Ln " + line + ", Col " + col;
  }

  function updateLineCount() {
    var n = (code.value.match(/\n/g) || []).length + 1;
    if (n !== lineCount) {
      lineCount = n;
    }
    sbLines.textContent = lineCount + (lineCount === 1 ? " line" : " lines");
  }

  // ---- Validation --------------------------------------------------------
  var lastErrLine = 0;

  function setStatus(state, text) {
    statusEl.dataset.state = state;
    statusEl.textContent = text;
  }

  function sourcePreview(src, line, column) {
    var lines = src.split("\n");
    var text = lines[line - 1] || "";
    var col = Math.max(0, Math.min(column, text.length));
    var before = escapeHtml(text.slice(0, col));
    var atRaw = text.slice(col, col + 1);
    var at = atRaw ? escapeHtml(atRaw) : "█"; // block glyph marks EOL/EOF
    var after = escapeHtml(text.slice(col + 1));
    return before + "<b>" + at + "</b>" + after;
  }

  function showValid(ast, ms) {
    setStatus("ok", "Valid Lua");
    problemCount.textContent = "0";
    problemCount.classList.remove("has");
    problemsEl.innerHTML =
      '<li class="ok-row"><span class="dot"></span>No syntax errors.</li>';
    lastErrLine = 0;
    renderGutter(0);
    renderAst(ast);
    sbTime.textContent = "parsed in " + ms + " ms";
    sbSep.hidden = false;
  }

  function showError(err, src, ms) {
    setStatus("err", "1 error");
    problemCount.textContent = "1";
    problemCount.classList.add("has");

    var line = err.line || 1;
    var column = typeof err.column === "number" ? err.column : 0;
    // luaparse prefixes the message with "[line:col] " — drop it; we render
    // the location ourselves.
    var msg = String(err.message || "Syntax error").replace(/^\[\d+:\d+\]\s*/, "");

    var li = document.createElement("li");
    li.className = "prob";
    li.innerHTML =
      '<span class="loc">' + line + ":" + (column + 1) + "</span>" +
      '<span class="msg">' + escapeHtml(msg) + "</span>" +
      '<span class="src">' + sourcePreview(src, line, column) + "</span>";
    li.addEventListener("click", function () {
      jumpTo(typeof err.index === "number" ? err.index : null, line, column);
    });
    problemsEl.innerHTML = "";
    problemsEl.appendChild(li);

    lastErrLine = line;
    renderGutter(line);
    renderAstUnavailable();
    sbTime.textContent = "failed in " + ms + " ms";
    sbSep.hidden = false;
  }

  function jumpTo(index, line, column) {
    code.focus();
    var pos = index;
    if (pos == null) {
      // Fall back to line/column → absolute offset.
      var lines = code.value.split("\n");
      pos = 0;
      for (var i = 0; i < line - 1 && i < lines.length; i++) pos += lines[i].length + 1;
      pos += column;
    }
    code.setSelectionRange(pos, pos);
    updateCursor();
  }

  function validate() {
    var src = code.value;
    updateLineCount();

    if (!src.trim()) {
      setStatus("empty", "Ready");
      problemCount.textContent = "0";
      problemCount.classList.remove("has");
      problemsEl.innerHTML =
        '<li class="empty-row">Type or paste Lua to validate it.</li>';
      lastErrLine = 0;
      renderGutter(0);
      renderAstUnavailable("Nothing to parse yet.");
      sbTime.textContent = "";
      sbSep.hidden = true;
      return;
    }

    var t0 = performance.now();
    try {
      var ast = luaparse.parse(src, {
        luaVersion: dialect.value,
        comments: false,
        locations: true,
        ranges: false,
        scope: false,
      });
      showValid(ast, (performance.now() - t0).toFixed(1));
    } catch (err) {
      showError(err, src, (performance.now() - t0).toFixed(1));
    }
  }

  // ---- AST tree ----------------------------------------------------------
  function renderAstUnavailable(text) {
    astEl.innerHTML =
      '<div class="ast-empty">' +
      escapeHtml(text || "AST is shown when the code parses without errors.") +
      "</div>";
  }

  function valueSpan(v) {
    if (typeof v === "string") {
      return '<span class="val str">"' + escapeHtml(v) + '"</span>';
    }
    return '<span class="val">' + escapeHtml(String(v)) + "</span>";
  }

  // Build a collapsible tree node for any AST value.
  function buildNode(key, value, depth) {
    var item = document.createElement("div");
    var isArr = Array.isArray(value);
    var isObj = value && typeof value === "object";

    if (!isObj) {
      var leaf = document.createElement("div");
      leaf.className = "twig";
      leaf.innerHTML =
        '<span class="caret"></span>' +
        (key != null ? '<span class="key">' + escapeHtml(String(key)) + ":</span> " : "") +
        valueSpan(value);
      item.appendChild(leaf);
      return item;
    }

    var entries = isArr
      ? value.map(function (v, i) { return [i, v]; })
      : Object.keys(value).map(function (k) { return [k, value[k]]; });

    var label =
      (key != null ? '<span class="key">' + escapeHtml(String(key)) + ":</span> " : "") +
      (isArr
        ? '<span class="meta">[' + value.length + "]</span>"
        : '<span class="type">' + escapeHtml(value.type || "{}") + "</span>" +
          (value.type ? '<span class="meta"> {' + entries.length + "}</span>" : ""));

    var twig = document.createElement("div");
    twig.className = "twig toggleable";
    twig.innerHTML = '<span class="caret">▾</span>' + label;

    var children = document.createElement("div");
    children.className = "node";
    entries.forEach(function (e) {
      // Skip the noisy `type` field — it's already in the label.
      if (!isArr && e[0] === "type") return;
      children.appendChild(buildNode(e[0], e[1], depth + 1));
    });

    twig.addEventListener("click", function () {
      var collapsed = item.classList.toggle("collapsed");
      twig.querySelector(".caret").textContent = collapsed ? "▸" : "▾";
    });

    item.appendChild(twig);
    item.appendChild(children);

    // Deep nodes start collapsed so the tree opens to a readable depth.
    if (depth >= 2) {
      item.classList.add("collapsed");
      twig.querySelector(".caret").textContent = "▸";
    }
    return item;
  }

  function renderAst(ast) {
    astEl.innerHTML = "";
    astEl.appendChild(buildNode(null, ast, 0));
  }

  function setAllCollapsed(collapsed) {
    var items = astEl.querySelectorAll(".twig.toggleable");
    items.forEach(function (twig) {
      var item = twig.parentElement;
      item.classList.toggle("collapsed", collapsed);
      twig.querySelector(".caret").textContent = collapsed ? "▸" : "▾";
    });
  }

  // ---- Clipboard ---------------------------------------------------------
  function copyCode() {
    var text = code.value;
    var btn = $("btn-copy");
    var done = function () {
      var old = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(function () { btn.textContent = old; }, 1100);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
    function fallback() {
      code.focus();
      code.select();
      try { document.execCommand("copy"); } catch (e) {}
      code.setSelectionRange(code.value.length, code.value.length);
      done();
    }
  }

  // ---- Tabs --------------------------------------------------------------
  function activateTab(tabId, panelId) {
    document.querySelectorAll(".tab").forEach(function (t) {
      t.classList.toggle("active", t.id === tabId);
    });
    document.querySelectorAll(".panel").forEach(function (p) {
      p.classList.toggle("active", p.id === panelId);
    });
  }

  // ---- Wiring ------------------------------------------------------------
  var debounceTimer = 0;
  function scheduleValidate() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(validate, 160);
  }

  code.addEventListener("input", function () {
    updateLineCount();
    renderGutter(lastErrLine);
    updateCursor();
    scheduleValidate();
  });
  code.addEventListener("scroll", function () { gutter.scrollTop = code.scrollTop; });
  code.addEventListener("keyup", updateCursor);
  code.addEventListener("click", updateCursor);

  // Tab key inserts two spaces instead of moving focus out of the editor.
  code.addEventListener("keydown", function (e) {
    if (e.key === "Tab") {
      e.preventDefault();
      var s = code.selectionStart, en = code.selectionEnd;
      code.value = code.value.slice(0, s) + "  " + code.value.slice(en);
      code.selectionStart = code.selectionEnd = s + 2;
      updateLineCount();
      renderGutter(lastErrLine);
      scheduleValidate();
    }
  });

  dialect.addEventListener("change", validate);

  sampleSel.addEventListener("change", function () {
    var key = sampleSel.value;
    if (key && SAMPLES[key]) {
      code.value = SAMPLES[key];
      sampleSel.value = "";
      updateLineCount();
      updateCursor();
      validate();
      code.focus();
    }
  });

  $("btn-copy").addEventListener("click", copyCode);
  $("btn-clear").addEventListener("click", function () {
    code.value = "";
    updateLineCount();
    updateCursor();
    validate();
    code.focus();
  });

  $("tab-problems").addEventListener("click", function () {
    activateTab("tab-problems", "panel-problems");
  });
  $("tab-ast").addEventListener("click", function () {
    activateTab("tab-ast", "panel-ast");
  });
  $("btn-ast-expand").addEventListener("click", function () { setAllCollapsed(false); });
  $("btn-ast-collapse").addEventListener("click", function () { setAllCollapsed(true); });

  // ---- Boot --------------------------------------------------------------
  code.value = SAMPLES["Hello world"];
  updateLineCount();
  updateCursor();
  validate();
})();
