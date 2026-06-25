# Scry Extensions

Extensions are **mini-apps** that extend Scry. They primarily enrich **desktop
mode** (the ✦ DESKTOP shell) — think dock widgets, focus tools, dashboards — and
can also lend a hand in **cockpit mode** (the normal tiling view).

An extension is just a folder with a manifest and an HTML entry point. Scry scans
an extensions directory at startup, validates each subfolder against the template
below, and surfaces the valid ones in the places their manifest asks for. No
rebuild, no recompile — drop a folder in, reload, and it appears.

> Status: **base framework (Phase 1).** Scry reads the folder, validates
> manifests, and surfaces `desktop.dock` extensions as dock buttons that open the
> mini-app in a panel. The host↔extension message bridge and the remaining
> surfaces are specified here but land in later phases — see [Roadmap](#roadmap).

---

## 1. Where extensions live

Scry scans two roots and merges them (a user extension overrides a bundled one
with the same `id`):

| Root | Path (Windows) | Writable | Purpose |
| --- | --- | --- | --- |
| **User** | `%LOCALAPPDATA%\com.enterscry.scry\extensions\` | yes | Where you install extensions. |
| **Bundled** | `<install>\resources\extensions\` | no | Examples shipped with Scry. |

The user root is the one you care about. To find it from inside Scry, use
**desktop mode → dock → ⊕ Extensions → "Open extensions folder"**, or call the
`open_extensions_dir` command. The folder is created automatically on first run.

This repo's `extensions/` folder is the **development source** for the bundled
examples (`_template/`, `clock/`). To try one without a full build, copy its
folder into the user root above and reload Scry (Ctrl+R).

Each immediate **subdirectory** of a root is one extension. Files loose in the
root are ignored. Subfolders are matched against the template; anything that
fails validation is reported as a broken extension (it still shows up, flagged,
so you can fix it) rather than silently dropped.

---

## 2. Anatomy of an extension

```
my-extension/
├── extension.json     ← REQUIRED — the manifest (see §3)
├── index.html         ← REQUIRED — the entry point (name set by manifest.entry)
├── icon.svg           ← optional — dock/launcher icon (declared by manifest.icon)
└── …                  ← any other assets (css, js, images) your mini-app needs
```

**Required to be recognized as a valid extension:**

1. `extension.json` exists and parses as JSON.
2. It has the required manifest fields (`id`, `name`, `version`, `entry`).
3. The file named by `entry` exists in the folder.
4. If `icon` is set, that file exists too.

Miss any of these and the folder is loaded as `valid: false` with an `error`
explaining why — useful while authoring.

---

## 3. The manifest — `extension.json`

```jsonc
{
  // REQUIRED -----------------------------------------------------------------
  "id": "com.enterscry.clock",      // globally unique, reverse-DNS recommended
  "name": "World Clock",            // display name (dock tooltip, launcher)
  "version": "1.0.0",               // semver
  "entry": "index.html",            // HTML file loaded in the mini-app frame

  // RECOMMENDED --------------------------------------------------------------
  "description": "Time across zones, on your desktop.",
  "author": "Frank Cefalu",
  "icon": "icon.svg",               // path (relative to the folder) to an icon

  // OPTIONAL -----------------------------------------------------------------
  "surfaces": ["desktop.dock"],     // where it appears — see §4. default: []
  "panel": {                        // default panel size when opened from a dock
    "width": 360,
    "height": 420,
    "resizable": true
  },
  "permissions": [],                // bridge capabilities it requests — see §6
  "engine": "iframe",               // render engine. only "iframe" today.
  "minScryVersion": "1.0.0"         // refuse to load on older Scry (advisory now)
}
```

Field reference:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | ✅ | Stable, unique. Reverse-DNS (`com.you.thing`). Used as the registry key and across roots for override. |
| `name` | string | ✅ | Human label. |
| `version` | string | ✅ | Semver. |
| `entry` | string | ✅ | Relative path to the HTML the frame loads. Must stay inside the folder. |
| `description` | string | — | One line; shown in tooltips/launcher. |
| `author` | string | — | Free text. |
| `icon` | string | — | Relative path to an icon (svg/png). Falls back to a generated glyph. |
| `surfaces` | string[] | — | Mount points — see §4. Empty ⇒ installed but not surfaced anywhere. |
| `panel` | object | — | `{ width, height, resizable }`. Defaults: 360×420, resizable. |
| `permissions` | string[] | — | Requested bridge capabilities (§6). Empty ⇒ a sandboxed frame with no host access. |
| `engine` | string | — | `"iframe"` (default, only supported). `"native"` is reserved. |
| `minScryVersion` | string | — | Advisory in Phase 1; enforced later. |

A machine-readable schema lives at [`extension.schema.json`](./extension.schema.json).
Point your editor at it (`"$schema": "../extension.schema.json"` in the manifest)
for completion and validation.

---

## 4. Surfaces — where an extension shows up

`surfaces` declares where Scry mounts the mini-app. An extension can list more
than one.

| Surface | Mode | Phase | What it does |
| --- | --- | --- | --- |
| `desktop.dock` | desktop | **1 (live)** | Adds a button to the desktop dock; clicking opens the mini-app in a floating panel sized by `panel`. |
| `desktop.widget` | desktop | 3 | Pin the mini-app directly on the desktop surface as an always-on widget. |
| `cockpit.dock` | cockpit | 2 | Adds a button to the right-edge `PaneDock`; opens the mini-app in a popover. |
| `command` | both | 2 | Contributes a Command Palette entry (Ctrl/Cmd+K) that opens the mini-app. |
| `pane` | both | 4 | Registers a new block **kind** so the mini-app can be a real, tileable pane. |

Phase-1 framework surfaces `desktop.dock`. The others are parsed and stored today
(so manifests are forward-compatible) but not yet rendered — see the
[Roadmap](#roadmap).

---

## 5. How a mini-app is rendered

`engine: "iframe"` (the only engine today) loads `entry` in a **sandboxed
iframe**. The frame:

- is served via Tauri's asset protocol (`convertFileSrc`) from the extension
  folder, so relative `<script>`/`<link>`/`<img>` paths resolve normally;
- runs with `sandbox="allow-scripts"` plus only the browser capabilities its
  `permissions` ask for (`downloads`, `popups`, `modals`, `clipboard`) — **no**
  same-origin access to the Scry app, no direct Tauri `invoke`;
- talks to Scry only through the **message bridge** (§6), gated by `permissions`.

This keeps third-party mini-apps from touching the PTYs, the workspace store, or
the filesystem unless explicitly granted. A mini-app that lists no `permissions`
is a pure, isolated widget (clock, calculator, etc.).

---

## 6. The host ↔ extension bridge (Phase 2)

> Not wired yet — specified here so manifests and mini-apps can be written
> against it.

Mini-apps communicate with Scry via `postMessage`. Every call is checked against
the extension's granted `permissions`; an ungranted call is rejected.

```js
// inside the mini-app
window.parent.postMessage(
  { scry: true, v: 1, id: "req-1", method: "workspaces.list", params: {} },
  "*",
);
window.addEventListener("message", (e) => {
  if (e.data?.scry && e.data.id === "req-1") {
    /* e.data.result / e.data.error */
  }
});
```

Planned permission → capability map:

| Permission | Grants |
| --- | --- |
| `workspaces.read` | list workspaces / blocks, read pane metadata |
| `workspaces.write` | spawn / focus / close panes |
| `terminal.write` | type text into a pane's PTY |
| `clipboard` | read/write the clipboard |
| `notifications` | raise Scry toasts |
| `storage` | a host-backed key/value store that persists across reloads |
| `downloads` | allow browser downloads from the sandboxed frame |
| `popups` | allow opening popups/new tabs from the sandboxed frame |
| `modals` | allow blocking browser modal dialogs from the sandboxed frame |

Permissions are requested in the manifest and (eventually) confirmed by the user
on first run. Until the bridge ships, treat mini-apps as self-contained web apps.

---

## 7. Authoring quickstart

1. Copy [`_template/`](./_template) to the user extensions folder (§1) and rename
   it.
2. Edit `extension.json` — set a unique `id`, `name`, and the `surfaces` you want.
3. Build your UI in `index.html` (and any assets beside it). It's a normal web
   page; no framework required.
4. Reload Scry (Ctrl+R). Open desktop mode — your dock button is there.
5. Iterate: edit files, reload. (A "Reload extensions" action lives in the
   Extensions dock menu so you don't need a full app reload.)

See [`clock/`](./clock) for a complete, working example.

---

## 8. Roadmap

- **Phase 1 — base framework (this).** Scan both roots, validate manifests
  against the template, expose the registry to the frontend, and surface
  `desktop.dock` extensions as dock buttons that open an iframe panel.
- **Phase 2 — bridge + more surfaces.** The `postMessage` capability bridge
  (§6), plus `cockpit.dock` and `command` surfaces.
- **Phase 3 — desktop widgets.** `desktop.widget` pinned to the surface; size +
  position persisted alongside the desktop icon layout.
- **Phase 4 — pane extensions.** `pane` surface: a mini-app as a first-class,
  tileable block kind in both modes.
- **Later.** Signed/verified extensions, an install flow (drop-a-zip), a small
  gallery, and per-extension settings.

---

## 9. Implementation map (for Scry developers)

| Concern | Location |
| --- | --- |
| Scan + validate + list (Rust) | `src-tauri/src/extensions.rs` |
| Tauri commands registered | `src-tauri/src/lib.rs` (`list_extensions`, `extensions_dir`, `open_extensions_dir`, `read_extension_file`) |
| Frontend registry + loader | `src/store/extensions.ts` |
| Manifest type (TS) | `src/store/extensions.ts` (`LoadedExtension`) |
| iframe host component | `src/components/ExtensionHost.tsx` |
| Desktop-dock surfacing | `src/components/DesktopShell.tsx` |
| Bundled examples | this folder (`_template/`, `clock/`) |
