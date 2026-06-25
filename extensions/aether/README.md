# Aether — Focus Sounds

A concentration-soundscape app, built as a Scry extension. Layer noise and
ambiences to settle into deep work and tune out distractions — designed with
ADHD-style focus in mind.

> Part of the **Scry** product line. Every sound is **generated at runtime**
> (Web Audio synthesis — noise shaping, filtered ambiences, drones), so Aether
> ships with **no audio files**, works fully offline, and never loops a clip.

## Install

1. Drop this `aether/` folder into `%LOCALAPPDATA%\com.enterscry.scry\extensions\`
   (desktop mode: **dock → ⊕ Extensions → Open folder**).
2. **⊕ Extensions → Reload**, then click the **Aether** app icon.

## Use

- Tap any sound card to layer it in; tap again to remove it.
- Each card has its own **volume**; the header has a **master volume** + a
  **play/pause** (Space) that suspends/resumes everything.
- **Stop all** clears the mix. A live visualizer shows the blend.
- **Mini player** (⊟ button or `M`): collapses to a compact strip of just the
  live sounds + the equalizer, and shrinks the window to match.

## Persistent player

Aether runs as a **singleton player** in Scry: it stays alive across a
desktop↔cockpit switch instead of stopping when you leave the desktop. It shows
as a slim **toolbar bar** (controls + equalizer) you can click to expand into a
hover popover, and keeps playing while you work in the terminal. (The host drives
this via `postMessage`: `{target:"aether", cmd:"mode", value:"bar"|"full"}`, and
Aether reports `{source:"aether", type:"audio-state", …}` back.)

## Sounds (v1)

Brown / Pink / White noise · Rain · Ocean · Wind · Fireplace · Drone.
All synthesized — noise is colour-shaped, ambiences are filtered noise driven by
slow LFOs (swells, gusts, shimmer), and the drone is detuned sines.

## Roadmap

- Focus **tones** (binaural beats + speaker-friendly isochronic pulses: alpha /
  beta / gamma).
- One-tap **presets** (Deep Focus, Rainy Study, Flow, Calm) + save your own mix.
- A **focus timer** (Pomodoro) with auto fade-out on break.
- More textures (cafe murmur, birds, night, train) and a master EQ/low-pass
  "muffle" for harsher rooms.
