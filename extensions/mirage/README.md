# Mirage — Video Studio

A social-video studio, built as a Scry extension. Drop in clips, arrange a
timeline, add titles and captions/subtitles, and export straight to the right
size for TikTok, Reels, Shorts, YouTube and more — all in a sandboxed frame,
no upload, no account.

> Part of the **Scry** product line. Mirage is original software implementing the
> common feature set of a short-form video editor; it is not a copy of any
> specific product's code or assets.

## Install

1. Download / clone this `mirage/` folder.
2. Drop it into your Scry extensions directory:
   `%LOCALAPPDATA%\com.enterscry.scry\extensions\`
   (in desktop mode: **dock → ⊕ Extensions → Open folder**).
3. **⊕ Extensions → Reload**, then click the **Mirage** app icon.

## Workflow

1. **Import** video / image / audio (button or drag-and-drop onto the panel).
2. Click a media item to **add it to the timeline**. Images get a default
   duration; videos come in full and can be trimmed.
3. **Arrange**: drag clips on the main track to reorder; click a clip to edit
   it. Per-clip controls: trim, Cover/Contain fit, **speed** (0.25×–4×),
   volume, **transform** (zoom + X/Y reposition), **Ken Burns** slow-zoom,
   **adjust** (brightness / contrast / saturation / blur), **fade in/out**, and
   a **transition to the next clip** (crossfade / dip-to-background).
4. **Titles & captions**: `T Text` for a title, `⌷ Caption` for a bottom caption.
   Edit text/timing/style in the properties panel; **drag the text on the
   preview** to position it; pick a **motion** preset (fade / pop / slide /
   typewriter).
4b. **Overlays / PiP / logo**: `▣ PiP / Logo` adds an image or video on its own
   **overlay track** above the main video — for picture-in-picture, a webcam
   inset, or a logo/watermark. Drag it on the preview to position; set size,
   opacity, corner rounding, drop shadow, and time range (video overlays also
   have trim + volume).
4c. **Audio (music + voiceover)**: import audio and click it to drop a clip on the
   **audio track** — add as many as you like (a music bed plus a voiceover, say).
   Each audio clip is independently positioned, trimmed, volume-controlled, and
   has fade-in / fade-out. They mix together in preview and export.
5. **Pick a format** (top-right) for your target platform, set a **background**
   color for letterboxed footage, and toggle **⊞ Guides** (rule-of-thirds +
   safe area) while you frame.
6. **Export** → choose container + quality → the file downloads.

## Platform presets

| Preset | Size | For |
| --- | --- | --- |
| TikTok / Reels / Shorts | 1080×1920 (9:16) | vertical short-form |
| Instagram feed | 1080×1080 (1:1) | square |
| Instagram portrait | 1080×1350 (4:5) | portrait feed |
| YouTube | 1920×1080 (16:9) | landscape |
| X / Twitter | 1280×720 (16:9) | landscape |

## Captions / subtitles

- Add captions one at a time with **⌷ Caption**, or **⤓ SRT** (timeline header)
  to import an `.srt` file — each cue becomes a styled, time-ranged caption you
  can restyle and reposition. **⤒ SRT** exports your captions back to `.srt`.
- Captions render with an auto-wrapping, outlined/boxed style at the lower third
  (Veed-style), fully editable (font, size, color, background, alignment).

## Export notes

Two export modes (picked in the Export dialog):

- **Precise — frame-exact MP4 (H.264)** *(default when supported)*: renders every
  frame through a **WebCodecs** `VideoEncoder` and writes a real **MP4** with the
  vendored `mp4-muxer`. Audio is mixed offline (`OfflineAudioContext`) and encoded
  to AAC (or Opus if AAC isn't available). No dropped frames, and it's typically
  faster than the video's length for short-form content.
- **Fast — real-time recording**: the original **MediaRecorder** path — records the
  live preview in real time with mixed audio. Container is **MP4 (H.264)** when the
  WebView2 build supports it, otherwise **WebM (VP9/VP8)**.

> Bundled dependency: `vendor/mp4-muxer.js` ([mp4-muxer](https://github.com/Vanilagy/mp4-muxer),
> MIT) is vendored verbatim so precise export works offline with no build step. It
> is the only third-party file in Mirage.

## Projects, undo & history

- **💾 Save** writes a self-contained `.mirage` project file (media embedded), and
  **📂 Open** restores it — handy since the sandbox has no filesystem link, so the
  file carries its own media. Large videos make large project files.
- Full **undo / redo** (`Ctrl+Z` / `Ctrl+Shift+Z`, 60 steps) across timeline and
  property edits. (Media imported to the library is not part of undo.)

## Shortcuts

`Space` play/pause · `S` split clip at playhead · `Ctrl+D` duplicate selected ·
`Ctrl+Z` undo · `Ctrl+Shift+Z` / `Ctrl+Y` redo · `Ctrl+S` save · `Ctrl+O` open ·
`Delete` remove selected · `← / →` step one frame · click the timeline to seek.

## Roadmap

- Keyframed motion (animate transform/opacity over time).
- AI auto-captions (speech-to-text) and a music library — via the Scry host
  bridge / a backend service.
- Multiple overlay tracks and overlay transitions/animation.
