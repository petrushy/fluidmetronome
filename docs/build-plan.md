# Build Plan

## Phase 1: Template

Goal: prove the app shell and data model.

- Rust/Yew single-page editor
- adjustable column count
- adjustable per-column delay values
- multiple instrument rows
- PWA manifest and service worker
- Firebase hosting config

Done in this scaffold.

## Phase 2: Real playback

Goal: accurate click playback.

- create `AudioContext` on first user interaction
- load one or more short click samples
- send rhythm state from Rust to JS
- schedule playback in an `AudioWorklet`
- add transport controls: play, stop, loop, tap tempo

Acceptance bar:

- playback remains stable while editing UI
- no obvious drift over several minutes
- works on iPhone Safari after explicit user gesture

## Phase 3: Musical usability

Goal: make the editor useful for real practice.

- pattern rename/save/delete
- duplicate and reorder columns
- accent and mute per track
- swing or feel tools if they map to your tradition
- preset library for common folk rhythm shapes

## Phase 4: Polish

Goal: make it feel like an installable instrument tool.

- onboarding hint for audio permission and install
- settings page or modal
- larger touch targets for iPhone
- keyboard shortcuts on desktop
- offline resilience improvements in service worker

## Suggested repo structure

```text
fluidmetronome/
  Cargo.toml
  Trunk.toml
  index.html
  firebase.json
  src/
    main.rs
    app.rs
    audio/
      mod.rs
      pattern.rs
  js/
    audio-worklet.js
  static/
    app.css
    manifest.webmanifest
    sw.js
    icons/
      icon.svg
  docs/
    architecture.md
    build-plan.md
```

## Immediate next implementation tasks

1. Add JS interop for `AudioContext` and worklet registration.
2. Replace the playback console stub with actual click scheduling.
3. Persist the current grid locally.
4. Add import/export for pattern JSON.
