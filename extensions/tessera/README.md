# Tessera

An original falling-block puzzle for Scry — a polished, genre-faithful block
stacker. **Not Tetris**, not affiliated with or endorsed by The Tetris Company;
all art, music, and code here are original. It implements the standard modern
guideline mechanics (which are functional, not copyrightable): the seven
tetromino shapes, SRS rotation with wall kicks, a 7-bag randomizer, hold, ghost
piece, lock delay, T-spins (incl. big-kick promotion), combos, and back-to-back.

Built and hardened over a multi-agent design → review → verify → feature → QA loop
(~260 agents across a dozen 30-agent passes). A headless DOM-stub smoke test —
which loads the game and drives ~2000 frames across all modes with keyboard,
gamepad, **and** simulated touch (desktop + coarse-pointer passes) — gates every
change.

## Features (v1.11.3)

- **7 modes:** Marathon (150 lines), Sprint (40-line race), Ultra (2-minute
  score attack), **Cheese** (dig garbage), **Master** (20G), **Daily** (per-UTC-day
  seeded 40-line race, with an *already-played-today* indicator and a *shareable
  result* code), Zen.
- **Mechanics:** SRS + wall kicks, **seeded** 7-bag (deterministic; seed shown on
  game-over), hold, 5-piece next, ghost, soft/hard drop, lock delay with reset
  cap, T-spin + mini with big-kick promotion, block-out + lock-out.
- **Scoring:** guideline line/T-spin/combo/back-to-back ×1.5/perfect-clear
  (sustains B2B), level-scaled; goal-line wins play their clear before ending.
- **Levels:** speed ramps every 10 lines to 20G (Master starts locked at 20G).
- **Input:** rebindable keys (any `event.code`), **gamepad** (standard mapping),
  **touch** (swipe move/soft, tap rotate, flick hard, two-finger CCW, on-screen
  control bar), **IRS/IHS** (initial rotate/hold buffered at spawn), DAS that
  charges *through* line-clears, ARR-0 instant slam, optional **haptics**, plus
  touch **sensitivity** and a **left-handed** control-bar option.
- **Responsive:** a real **portrait/mobile layout** (rails restack into a top
  strip, board takes full width, safe-area-aware touch bar) plus the desktop
  landscape layout — switches automatically by viewport/pointer.
- **Audio:** original procedural **dynamic** chiptune ("Cascade") on a drift-free
  look-ahead scheduler — intensifies by level, danger override near top-out,
  tetris/T-spin reward stings — plus a full SFX set through a limiter and
  **master / music / SFX** volume sliders. No external files, no copyrighted melodies.
- **Stats:** live PPS, single/double/triple/tetris + T-spin breakdown, finesse
  faults (rail panel + game-over).
- **Leaderboard:** per-mode top-10 with initials; time modes rank on time and
  only accept completed runs.
- **Juice:** gradient/bevel/glow blocks, line-clear flash + particles, screen
  shake on tetrises/T-spins, level-up flashes, combo popups, countdown.
- **Accessibility / UX:** colorblind-safe "Aurora" palette + shape patterns,
  reduced-motion, screen-shake toggle, configurable DAS/ARR/soft-drop, responsive
  scaling, and a scrollable Settings panel with the key-rebind list collapsed by
  default so it stays compact.

## Controls

**Keyboard (rebindable in Settings → Controls):** ← → move · ↓ soft · Space hard ·
↑/X CW · Z/Ctrl CCW · A 180° · C/Shift hold · Esc/P pause · M mute · R restart.
A held direction keeps repeating across piece locks and line-clears.
**Gamepad:** A rotate · X counter-rotate · Y 180° · B/shoulders hold · D-up/RT
hard · D-down/LT/stick soft · D-pad/stick move · Start pause.
**Touch:** swipe ◀▶ move · swipe ▼ soft · flick ▲ hard · tap rotate · two-finger
tap counter-rotate · on-screen Hold/Rotate/Drop/Pause bar (gesture legend in How-to).

## Quality

Two adversarial multi-agent QA passes (one mid-build, one on the late additions)
found and fixed **21 real defects** — among them a critical soft-drop regression
that broke keyboard/touch play whenever a gamepad was merely connected, plus
T-spin detection, lock-delay/gravity edge cases, audio scheduling, and several
input/leaderboard correctness bugs. Every fix was re-verified by the dual
(desktop + touch) smoke test. Current build: **v1.11.3**, clean.

## Notes / scope

- Leaderboard + settings persist via `localStorage` when available; inside Scry's
  sandboxed iframe the origin is opaque, so persistence falls back to in-memory
  for the session until the host **`storage`** bridge (Phase 2) is wired — the
  code already calls it best-effort.
- Touch + portrait are gated to be 100% inert on fine-pointer desktops — keyboard
  and gamepad behavior are unchanged. The one honest caveat: the touch gesture
  thresholds and the portrait cell-size clamp are tuned by static analysis + the
  headless touch smoke test; they'd benefit from a tuning pass on a real
  390×844 / 360×800 phone before a mobile launch.
