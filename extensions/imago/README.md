# Imago — Image Editor

A layered raster image editor, built as a Scry extension. Brushes, selections,
shapes, text, layers with blend modes, non-destructive-style adjustments, and
filters — running entirely in a sandboxed frame, no network, no build step.

> Part of the **Scry** product line. `Imago` is original software; it implements
> the common feature set of a professional raster editor, not any specific
> product's code or assets.

## Install

Imago ships as a standalone extension folder, so it can live in its own git repo
and be downloaded independently.

1. Download / clone this folder.
2. Drop the whole `imago/` folder into your Scry extensions directory:
   `%LOCALAPPDATA%\com.enterscry.scry\extensions\`
   (in Scry desktop mode: **dock → ⊕ Extensions → Open folder**).
3. **⊕ Extensions → Reload** (or relaunch Scry).
4. Click the **Imago** icon in the desktop dock.

## Features

**Tools** — Move, Rectangular Select, Lasso, Brush, Pencil, Eraser, Paint
Bucket (flood fill w/ tolerance), Eyedropper, Line, Rectangle, Ellipse, Text,
Hand (pan).

**Layers** — add / duplicate / delete / reorder, merge down, merge visible,
flatten, per-layer visibility, opacity, rename, live thumbnails, and 15 blend
modes (Normal, Multiply, Screen, Overlay, Darken, Lighten, Dodge, Burn,
Hard/Soft Light, Difference, Hue, Saturation, Color, Luminosity).

**Image** — Resize (resample, with lock-ratio and the same preset list), Crop to
selection, Rotate 90° CW/CCW, Flip horizontal/vertical.

**Color** — foreground/background swatches, swap, native color picker, hex
entry, recent-color palette.

**Brush options** — size, opacity; pencil (hard) vs brush (soft alpha) via a
stroke-buffer so opacity doesn't compound mid-stroke.

**Selections** — marquee + lasso bounding selection; all painting, fills, text,
adjustments and filters are clipped to the active selection. Select All
(Ctrl+A), Deselect (Ctrl+D), clear selection (Delete).

**Adjustments** (live preview, Apply/Reset) — Brightness, Contrast, Saturation,
Hue. **Filters** — Grayscale, Invert, Blur, Sharpen.

**Document** — New (custom size dialog with a categorized preset list, transparent
option, and "⧉ From clipboard" → a new doc at the clipboard image's exact size).
Open an image (file picker or drag-and-drop onto the canvas). Undo/redo history
(Ctrl+Z / Ctrl+Y, 18 steps). Zoom: fit / 100% / in-out / Ctrl+wheel.

**Size presets** — both the New and Resize dialogs share a grouped preset menu:
Standard (Full HD, HD, 4K, square, A4) plus ready social-media canvases for
Instagram (post / portrait / landscape / story / profile), Facebook (feed /
story / cover / event / profile), X·Twitter, YouTube (thumbnail / channel art),
TikTok, LinkedIn, and Pinterest.

**Clipboard** — Paste a copied image as a new layer (Paste button or Ctrl+V),
or copy the flattened image back out (Export → ⧉ Copy).

**Export** — dialog with PNG / JPEG / WebP, a quality slider for the lossy
formats, and Download or Copy-to-clipboard. Ctrl+S is a quick PNG export.

## Shortcuts

`V` move · `M` marquee · `L` lasso · `B` brush · `N` pencil · `E` eraser ·
`G` bucket · `I` eyedropper · `U` line · `R` rect · `O` ellipse · `T` text ·
`H` hand · `X` swap colors · `[` / `]` brush size · `Ctrl+Z/Y` undo/redo ·
`Ctrl+A/D` select all / deselect · `Ctrl+N` new · `Ctrl+O` open ·
`Ctrl+V` paste image · `Ctrl+S` quick PNG export · `Ctrl+E` export dialog ·
`Delete` clear selection.

## Roadmap (when the host bridge lands)

- Native Save / Open dialogs and "open file in a Scry terminal" via the
  extension `permissions` bridge.
- More tools (gradient, clone stamp, smudge), per-layer masks, and `.imago`
  project save/load.
