# Scry Extensions

The official extension library for **[Scry](https://enterscry.com)** — small,
self-contained mini-apps that extend the Scry desktop. Each extension is a folder
with a manifest (`extension.json`) and an HTML entry point; Scry runs it
**sandboxed in an iframe** (no system or IPC access).

Install them from the in-app **⊞ Extensions** browser, or drop a folder into your
local extensions directory to side-load.

> This repository is **MIT-licensed** (see [LICENSE](./LICENSE)). The Scry
> application itself is proprietary — this repo holds only extension source and
> the catalog.

## Using extensions

In Scry, open the **⊞ Extensions** launcher (status bar, or the desktop dock).
Browse, **Install**, update, or remove from there. An installed extension can be
opened as a cockpit pane or a desktop window.

To **side-load** one locally, drop its folder into your user extensions directory
(`Extensions → Open folder`, or `%LOCALAPPDATA%\com.enterscry.scry\extensions`)
and reload.

## What's here

| Extension | Description |
|-----------|-------------|
| **World Clock** (`clock`) | Live time across a few time zones. |
| **Notes** (`notes`) | Markdown scratchpad with live preview, multi-note sidebar, autosave. |
| **Pomodoro** (`pomodoro`) | Focus timer with work/break cycles, progress ring, session count. |
| **Convert** (`convert`) | Two-way unit converter — length, mass, temp, data, time, speed. |
| **Palette** (`palette`) | Color companion — hex/RGB/HSL, tints/shades, harmony, copy. |
| **JSON** (`json`) | Format / validate / minify JSON with error locations + copy. |
| **Luac** (`luac`) | Validate Lua as you type — line/column errors, 5.1/5.2/5.3/LuaJIT dialects, AST inspector. |
| **Aether** (`aether`) | Focus soundscapes — layer ambiences, noise, and tones for deep work. |
| **Mirage** (`mirage`) | Social video studio — clip timeline, captions, export presets. |
| **Imago** (`imago`) | Layered raster image editor — brushes, selections, filters. |
| `_template` | Starter you copy to build your own (not published to the catalog). |

## How hosting works

- Extension **source** lives in `extensions/<id>/` in this repo (public, browsable).
- On each release, CI zips every extension, computes its `sha256`, and publishes
  the zips **as GitHub Release assets**.
- It regenerates **`index.json`** at the repo root — the catalog the Scry app
  fetches (from `https://raw.githubusercontent.com/arclightdynamics/scry-extensions/main/index.json`).
- The app downloads a zip on Install, **verifies the sha256**, and extracts it
  into your user extensions folder.

## Building an extension

1. Copy `extensions/_template/` to `extensions/<your-id>/`.
2. Edit `extension.json` (validated against [`extension.schema.json`](./extension.schema.json) —
   point your editor at it for autocomplete) and build your `index.html` + assets.
3. Keep it self-contained: only relative paths, no external network needs assumed.
   The frame gets `allow-scripts` (plus downloads/clipboard where declared) and
   **cannot** reach Scry or the OS.

See [`docs/FRAMEWORK.md`](./docs/FRAMEWORK.md) for the full manifest spec,
surfaces, and the sandbox model.

## Publishing / contributing

**Full runbook: [`PUBLISHING.md`](./PUBLISHING.md)** — how the catalog works and
the exact steps to add + ship an extension (written for humans and AI agents).

Extensions are **curated**. To propose one, open a pull request adding your
`extensions/<id>/` folder. CI validates it against the schema; once merged, a
maintainer cuts a release and your extension appears in the in-app catalog.

By contributing you agree your submission is released under this repository's
MIT license.

To cut a release (maintainers): `git tag v<n> && git push --tags`, or run the
**Publish catalog** workflow from the Actions tab.
