# Architecture

## Product target

One installable PWA that runs in:

- desktop browsers
- iOS Safari home-screen mode
- macOS Safari or Chromium app mode

The first release should stay single-page and editing-focused: fast pattern entry, reliable playback, and low UI complexity.

## Core model

The rhythm model is not a classic evenly divided sequencer.

- Each column is a pulse point.
- Each column owns a `delay_ticks` value describing how long until the next column.
- Tracks decide whether a sound should fire at that pulse point.
- `ticks_per_beat` provides a musical reference without forcing equal subdivisions.

This gives you patterns like `8 5 7 8 4 8` directly, which is closer to the musical idea you described.

## Recommended runtime split

### Rust/WASM

Own in Rust:

- rhythm grid data model
- pattern transforms
- serialization for presets
- UI state
- validation

### Browser audio engine

Own in browser audio code:

- AudioContext lifecycle
- user-gesture audio unlock
- sample loading
- click scheduling
- drift monitoring

Do not rely on UI-thread timers for final playback accuracy. That will work for demos and then fail under load, especially on mobile Safari.

## Timing approach

Recommended order:

1. Start with a Rust domain model and UI editor.
2. Add a thin JS bridge that sends the current pattern to an `AudioWorklet`.
3. In the worklet, convert `delay_ticks` into sample-time offsets using:
   `seconds_per_tick = 60.0 / bpm / ticks_per_beat`
4. Trigger click samples slightly ahead of playback time.
5. Keep the lookahead logic out of the UI thread as much as possible.

## Persistence

Start with browser local storage for:

- last opened pattern
- audio preferences
- UI preferences

Move to IndexedDB only when presets or sample packs become larger.

## Routing

Keep routing simple:

- `/` main editor/playback page
- preferences panel as modal or slide-over first
- only add full routes once there are enough separate workflows

## Deployment

Firebase Hosting free tier is a good fit for the static bundle.

- `trunk build --release` outputs to `dist/`
- Firebase serves the static assets
- rewrite all routes to `index.html`

No backend is required for the first version.

