# Fluid Metronome

Starter template for a Progressive Web App metronome aimed at uneven rhythmic structures common in Swedish folk traditions, including patterns built from variable step lengths rather than only uniform beats.

## Stack

- Rust for rhythm/state logic
- Yew for the single-page UI
- WASM via `trunk`
- JavaScript `AudioWorklet` placeholder for sample-accurate scheduling
- Firebase Hosting for free-tier deployment

## Why this structure

Browser timing is the hard part. The UI and pattern editing can comfortably live in Rust/WASM, but playback timing should not depend on `setTimeout` on the main thread. This template therefore keeps a seam for an `AudioWorklet`, which is the right place to move click scheduling once real audio playback is implemented.

## Project layout

- `src/`: Rust UI and rhythm domain logic
- `js/`: JavaScript glue for audio worklets
- `static/`: PWA assets, service worker, CSS, icons
- `docs/`: architecture and build plan

## Local development

1. Install Rust and the WASM target:
   `rustup target add wasm32-unknown-unknown`
2. Install Trunk:
   `cargo install trunk`
3. Run the app:
   `./serve.sh`

If your shell picks up Homebrew `cargo`/`rustc` before the rustup-managed toolchain, use the bundled build script:

`./build.sh`

## Firebase deployment

1. Install Firebase CLI:
   `npm install -g firebase-tools`
2. Log in:
   `firebase login`
3. Replace the project id in [.firebaserc](/Users/sepehy/Development/GitHub/fluidmetronome/.firebaserc:1) if needed.
4. Build and deploy:
   `./deploy.sh`

Firebase is used only for Hosting so the app can be reached from desktop and mobile browsers.

## Tests

```
cargo test --bins    # rhythm model (needs the rustup toolchain on PATH)
npm test             # audio measurement + Chromium browser tests
npm run test:webkit  # same browser suite under WebKit, the iOS target
```

Browser tests serve `dist/`, so run `./build.sh` first.

## Next steps

See [ROADMAP.md](ROADMAP.md) for the phased plan. [CLAUDE.md](CLAUDE.md) holds
the architectural invariants worth knowing before changing timing, audio levels,
or sequencer layout.
