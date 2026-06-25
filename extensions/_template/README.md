# Template Extension

The minimal shape of a Scry extension. Copy this folder, rename it, and edit.

```
_template/
├── extension.json   ← manifest (give it a unique id + name)
├── index.html       ← your mini-app (entry point)
├── icon.svg         ← dock/launcher icon
└── README.md        ← this file (optional)
```

1. Copy this folder into `%LOCALAPPDATA%\com.enterscry.scry\extensions\` and
   rename it. (Tip: in desktop mode, **dock → ⊕ Extensions → Open folder** takes
   you straight there.)
2. In `extension.json`, change `id`, `name`, `description`, and `author`.
3. Build your UI in `index.html`. It's a normal sandboxed web page.
4. Reload Scry → desktop mode → look for your button in the dock.

See `../README.md` for the full manifest reference, surfaces, and the planned
host bridge.
