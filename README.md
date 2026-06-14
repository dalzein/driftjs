# Drift.js

2D arcade drifting game written in native JavaScript using `HTML <canvas>` and loads of math.

Control the fastest, coolest car around — slide it sideways, lay down rubber, rack up a drift score. 😎

## Controls

- **Drive:** Arrow keys or `WASD`
- **Handbrake (drift):** `Space`
- **Mute:** `M` &nbsp;·&nbsp; **Reset car:** `R` &nbsp;·&nbsp; **Clear marks:** `C`
- **Mobile:** on-screen touch controls (incl. a dedicated DRIFT button)

## Features

- **Velocity-vector grip physics** — the car body points one way while its momentum slides another; lateral grip pulls them back together. Steer hard or yank the handbrake and the rear breaks loose into a catchable drift.
- **Fixed-timestep simulation** — identical feel on 60 / 120 / 144 Hz displays.
- **Drift scoring** — points build while you hold a slide, with a rising combo multiplier banked when the drift ends.
- **Juice** — continuous skid marks driven by real tire slip, tire-smoke particles, drift glow, and speed/slide screen shake.
- **Procedural audio** — engine pitch tied to speed and tire-screech tied to slip, fully synthesized with the Web Audio API (no audio files).

All handling lives in the `TUNING` block at the top of `public/drift.js` if you want to tweak the feel.

## Built with

- `JavaScript`
- `CSS`
- `HTML <canvas>`
- `Web Audio API`
