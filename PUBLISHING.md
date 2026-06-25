# Publishing extensions — runbook

How the Scry extension catalog works and exactly how to add / publish an
extension. Written so a human **or an AI agent** can follow it end to end.

## The two repos (and the two `extensions/` folders — don't confuse them)

| Repo | Role |
|------|------|
| **`arclightdynamics/scry-extensions`** (this repo, public, MIT) | Extension **source** + the generated **catalog**. This is what end users install from. |
| **`arclightdynamics/scry`** (the app, private) | Consumes the catalog. `src/store/extensions.ts` → `CATALOG_URL` points at the latest release's `index.json` asset. |

There are **two `extensions/` folders**, for two different purposes:

- **`scry-extensions/extensions/`** (here) → the **published catalog**. To ship an
  extension to users, it goes here and you cut a release.
- **`scry/extensions/`** (in the app repo) → a **debug-only dev scan**. In debug
  builds the app also scans this folder so in-progress extensions appear live
  while you author them (e.g. `aether`). These are NOT published — they show as
  source `"dev"`. Release builds ship **empty** and never scan this folder.

> Rule of thumb: **develop** locally in `scry/extensions/`, **publish** from
> `scry-extensions/extensions/` + a release tag.

## How distribution works

1. Extension source lives in `extensions/<id-folder>/` in this repo.
2. On a **tagged release**, CI (`.github/workflows/publish.yml`) zips each
   extension, computes its `sha256`, and:
   - uploads each `<id>-<version>.zip` **and** a generated `index.json` as
     **release assets**, and
   - commits the regenerated `index.json` back to `main` (a browsable mirror).
3. The Scry app fetches the catalog from the **latest release's `index.json`
   asset** (the reliable source of truth — not raw `main`), downloads a zip on
   Install, **verifies the sha256**, and extracts into the user extensions folder.

## Anatomy of an extension

```
extensions/<id-folder>/
  extension.json   manifest (validated against ../../extension.schema.json)
  index.html       entry point
  icon.svg         icon (must exist if the manifest declares one)
  …assets          css / js / images (relative paths only)
```

Manifest required: `id`, `name`, `version`, `entry`. Common: `description`,
`author`, `icon`, `surfaces`, `permissions`, `panel`, `minScryVersion`. Full
spec: [`extension.schema.json`](./extension.schema.json).

Key rules:
- **`id`** = the install folder name + the catalog key. Use reverse-DNS, e.g.
  `com.enterscry.notes`. **Never `com.example.*`** — those are templates,
  excluded from the catalog (CI) and hidden in the app UI.
- **`surfaces`**: list **`"pane"`** (opens as a cockpit pane) **and**
  **`"desktop.dock"`** (appears on the desktop). Most extensions should list both.
- **`version`**: bump it whenever you change an extension, so already-installed
  users see an **Update** in the browser.
- **Self-contained + sandboxed**: relative paths only; the extension runs in an
  iframe with no Tauri/IPC access and shouldn't assume network access.

## Add a new extension

```sh
cp -r extensions/_template extensions/<your-id-folder>
# edit extensions/<your-id-folder>/extension.json  (unique id, name, version…)
# build index.html + assets + icon.svg
```

Validate before committing:

```sh
# manifest parses + has required fields
node -e "const j=require('./extensions/<id-folder>/extension.json'); if(!j.id||!j.entry) throw 'missing fields'; console.log('ok',j.id)"
# (optional) balanced <script> tags in index.html
```

## Publish (cut a release)

Publishing = push `main` **and** push a new version tag. Pushing `main` alone
does **not** publish.

```sh
git add -A && git commit -m "Add <name> extension"
git pull --rebase origin main          # CI commits index.json to main → rebase first
git push origin main                   # main must have the source (icon URLs resolve from raw main)
git tag v<N> && git push origin v<N>   # v1, v2, v3, … → triggers the Publish catalog workflow
```

You can also run the workflow manually: **Actions → Publish catalog → Run
workflow** (`workflow_dispatch`).

## Verify it went live

```sh
# the catalog the app actually reads (latest release's asset):
curl -sL https://github.com/arclightdynamics/scry-extensions/releases/latest/download/index.json
# confirm your <id> + version appear, each with a `url`, `sha256`, and `iconUrl`.
```

Optionally download a zip and confirm its SHA-256 matches the catalog entry.

## Gotchas / lessons learned

- **Zip layout:** CI zips the folder **contents**, so `extension.json` sits at
  the **zip root**. Don't nest the manifest inside a subfolder.
- **iconUrl** points at `raw.githubusercontent.com/.../main/extensions/<folder>/<icon>`
  — so **`main` must contain the source**. Push `main`, not just the tag, or
  icons 404.
- **main-commit step** can fail with a non-fast-forward if something pushed
  `main` at the same time. The workflow **retries** and is `continue-on-error`
  (the release asset is authoritative regardless). If your own
  `git push origin main` is rejected: `git pull --rebase` then push.
- **`com.example.*`** ids are excluded from the catalog and hidden in the app
  (launcher / desktop dock / Installed tab). Real extensions use a real
  reverse-DNS id.
- **One tag per release** (`v1`, `v2`, …). Re-tagging or pushing `main` alone
  won't cut a new release.

## App side (reference)

- `src/store/extensions.ts` → `CATALOG_URL` (the release-asset `index.json`) and
  the install actions.
- Rust (`src-tauri/src/extensions.rs`): `ext_fetch_catalog` (fetch the catalog),
  `ext_install` (download → verify sha256 → zip-slip-safe extract into the user
  folder), `ext_remove`.
- The app ships with **no bundled extensions**; everything is installed from the
  catalog into the user folder (`%LOCALAPPDATA%\com.enterscry.scry\extensions`).
