# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An installable PWA metronome for uneven rhythms, aimed at Swedish folk traditions.
The defining idea: **a pattern is not evenly subdivided**. Each column owns a
`delay_ticks` value describing how long until the *next* column, so a groove is
written directly as `8 5 7 8 4 8`. `ticks_per_beat` gives a musical reference
without forcing equal spacing. Anything that assumes a uniform grid is wrong here.

Target is iOS Safari in home-screen mode, so WebKit is the deployment browser,
not an afterthought.

## Commands

```bash
./build.sh              # trunk build --release -> dist/
./serve.sh              # trunk serve --open, live reload
./deploy.sh             # build, then firebase deploy --only hosting

cargo test --bins       # Rust domain tests (see toolchain note)
npm test                # audio harnesses + Chromium browser tests
npm run test:audio      # no browser needed, fast
npm run test:browser    # Chromium; serves dist/ itself, so build first
npm run test:webkit     # same suite under WebKit -- run before shipping layout
node tests/audio/worklet-stall.mjs        # a single harness
node tests/browser/layout.mjs webkit      # a single browser test, one engine
```

**Toolchain trap.** Homebrew's `cargo`/`rustc` come first on PATH here and
cannot build wasm (`can't find crate for 'core'`). `build.sh` and `serve.sh`
prepend the rustup toolchain themselves; for bare cargo commands you must do it:

```bash
export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"
cargo test --bins
cargo check --target wasm32-unknown-unknown
```

`cargo test --lib` fails -- this is a binary crate, so use `--bins`. The pure
domain logic in `src/audio/pattern.rs` compiles and tests natively despite the
yew/web-sys dependencies, so no wasm test harness is needed for model work.

`./build.sh` occasionally prints `error writing JS loader file to stage dir`
when run immediately after a browser test released `dist/`. It still exits 0 and
produces correct output; re-running is clean. Check the exit code, not the log.

The browser tests start their own static server against `dist/`, so **rebuild
before running them** or you will test stale output. This has bitten before:
a shell left `cd`'d into `dist/` silently skipped `./build.sh`, and a
previously-failing check "passed" against the old bundle.

## Architecture

### The Rust/JS split

Rust owns the rhythm model, UI, and state. JavaScript owns everything touching
`AudioContext`. The seam is deliberate and worth preserving.

- `src/audio/pattern.rs` — `RhythmGrid`, `Step`, `Track`, `BeatModulator`. Pure
  logic, natively testable, no web-sys.
- `src/app.rs` — the entire Yew UI, one big function component (~1200 lines).
- `src/audio/playback.rs` — thin `wasm_bindgen` wrapper over the `window.fluidMetronome*`
  functions. Every Rust→JS audio call goes through here.
- `js/audio-engine.js` — voices, preset buffers, sample loading, master bus.
- `js/audio-worklet.js` — the transport clock.
- `js/firebase.js` — auth, pattern sync, sample upload. **Currently dead code:
  `index.html` does not load it and no Rust bindings exist.** See ROADMAP Phase 2.

The Rust→JS contract is the serialized `RhythmGrid` as JSON. Adding a field to
the grid means checking `js/audio-worklet.js` and `js/audio-engine.js` for
readers of it.

### Timing

The worklet owns the clock and posts a `trigger` message per step; the main
thread receives it and calls `source.start(when)` with an absolute AudioContext
time, which is sample-accurate *provided the main thread arrives before `when`*
(~300ms of lookahead slack). Moving mixing into the worklet is Phase 1 and would
remove the main thread from the playback path entirely.

Modulators displace `when` only — `nextStepFrame` advances unmodulated, so
modulation never accumulates drift. Preserve that.

**Sign convention: positive is later, negative is earlier.** A modulator value
of +2 at a column delays that column by 2 mini-ticks; -2 pulls it 2 earlier.
Measured, not assumed — `tests/audio/modulator-direction.mjs` reads real trigger
times out of the worklet.

Note what this is *not*: modulation does not edit a column's `delay_ticks`. Each
note is displaced independently, so the audible **gap** between two columns
changes by the *difference* of their offsets. A +2 on one column followed by 0
on the next shortens that gap by 2, and the following gap lengthens by 2 to
compensate. That is why the loop stays exactly in time.

**The modulator formula exists twice.** `modulatorOffsetTicks` in
`js/audio-worklet.js` is the authority — it is what you hear.
`BeatModulator::offset_ticks` in Rust is a line-for-line copy so the UI can draw
the curve. Change one and you must change the other:
`tests/browser/modulator-shape.mjs` reads the rendered SVG and compares it
against the worklet's own function, so a drift fails there rather than shipping
a diagram that looks authoritative and is wrong. The curve plots positive
upward, like the function on paper, not "later = down".

**The scheduling loop must always advance.** `while (nextStepFrame < horizon)`
runs on the audio render thread; a step that fails to move the transport hangs
the tab, not just the sound. Three layers guard this: `Step::new` clamps,
`RhythmGrid::sanitize()` runs over anything deserialized, and the worklet clamps
and bails with a `stalled` message. `tests/audio/worklet-stall.mjs` covers it.

**`sanitize()` is the deserialization boundary.** The editor's clamps
(`set_step_delay`, input `min="1"`) are bypassed by serde, so every grid arriving
from outside the editor must pass through it: localStorage on load, imported
files (`PatternFile::from_json` calls it), and Firestore once sync lands.

### Pattern files

`PatternFile` in `src/audio/pattern.rs` is the export envelope: a `format`
marker, a `version`, and **one** `pattern`. Export is scoped to the selected
pattern only, and the singular key keeps the file honest about that — an earlier
`"patterns": [...]` array read as if the whole library were inside.

Import is deliberately more lenient than export: it accepts the singular form, a
`patterns` list, or a bare `RhythmGrid` (so a hand-edited file still loads). It
rejects foreign or newer-versioned files, and never replaces the library —
patterns are appended, with a `(2)` suffix when the title already exists.

`src/file_io.rs` holds the browser glue. Saving text needs a Blob URL and a
synthetic anchor click — there is no "save this string" API — and the object URL
must be revoked or the blob is retained for the document's lifetime.

### Audio levels

Voice gains drifted ~8x apart at one point, leaving the two default presets the
quietest of the set and the app nearly inaudible. `PRESET_TRIM` / `METRONOME_TRIM`
at the top of `js/audio-engine.js` normalise every preset to a ~0.35 peak.
**Re-run `npm run test:audio` after changing any voice gain.** The trim is applied
in `renderPresetToDestination`, so pre-rendered buffers carry it and both the live
and buffered paths stay matched.

Noise voices (hi-hats) peak stochastically, which is why the test asserts a band
and a max spread rather than an exact target.

`metronome` is the only preset that takes its voice from the track's instrument,
so it needs a trim per instrument.

## CSS invariants that have broken before

Both of these shipped once and were only caught with a browser. `static/app.css`
is hand-written, no framework.

**Overflow clips popovers.** An `overflow` value other than `visible` clips
absolutely-positioned descendants regardless of `z-index`. `.sequencer-scroll`
once cropped the sound menu this way. Horizontal scrolling now lives on
`.board-scroll`, wrapping the grid alone, so the label rail — which owns the
menu — sits outside any clipping context. **Any new popover inside the sequencer
must escape `.board-scroll`.** The column menu renders at `.app-shell` level with
`position: fixed` for exactly this reason (`.app-shell` has no transform or
filter, so fixed is viewport-relative there; the cards use `backdrop-filter` and
would become its containing block).

**Fixed-position menus must be clamped to the viewport.** Pushed off screen, they
cannot be scrolled back. `column_menu_style()` in `src/app.rs` flips the menu
upward below the viewport midpoint and clamps horizontally.

**Cards create stacking contexts.** `backdrop-filter` on `.topbar-card`,
`.sequencer-card`, `.modulators-card` etc. means a later sibling paints over an
earlier one's escaping popover. `.sequencer-card` and `.modulators-card` carry
explicit `z-index` to order them.

**Label rail and grid must share one row pitch.** `--matrix-row-height` drives
both `.board-grid`'s `grid-auto-rows` and `.label-rail`'s. The rail must use no
row gap, or labels drift one gap per track. The heading offset (48px heading +
6px `.board-shell` gap + 1px `.board-grid` border) lives in the rail's first
track size — a `margin-bottom` cannot do this, because a margin on a grid item
in a fixed-size track shrinks the item instead of displacing rows below.
`tests/browser/layout.mjs` asserts zero drift.

## PWA, caching, and iOS

iOS Safari is the deployment target, and it broke in ways the laptop never
showed. The invariants below each cost a debugging session.

**Never serve the service worker (or stable-path assets) as `immutable`.** In
`firebase.json` the immutable, one-year `Cache-Control` is scoped to
`/fluidmetronome-*` — the Trunk-hashed bundle, whose name changes every build.
A broad `**/*.@(js|css|wasm)` glob used to catch `/static/sw.js`, `/js/*`, and
`app.css` too; iOS then pinned the service worker for a year and never picked up
a deploy. Anything at a stable path (sw.js, `/js/*`, app.css, index.html,
manifest) must be `no-cache` so it revalidates.

**The service worker uses stale-while-revalidate for stable paths**
(`static/sw.js`), cache-first only for the hashed bundle. Bump `CACHE_NAME` on
each release; `activate` purges every other cache. `js/sw-register.js` registers
the worker (not `main.rs` anymore) and shows the "new version — reload" banner
via `updatefound`.

**An already-installed PWA cannot receive the fix that repairs updates** — its
old `sw.js` is still pinned immutable on-device. After deploying a caching-header
change, the phone needs the PWA deleted and re-added once. Say so.

**The transport button is synced by the timing poll, not a JS callback.** The JS
engine can stop itself (worklet stall, iOS AudioContext suspension, an async
worklet-load failure where `start()` already returned `true`). There is no
JS→Rust "stopped" channel, so the 250ms `timing_status` poll in `src/app.rs`
treats a JS-reported `Idle` as authoritative and flips the button back.
`tests/browser/transport-recovery.mjs` forces the self-stop divergence;
`tests/browser/transport-button-stop.mjs` covers the manual-stop path.

`Unknown` state (no trigger for >1200 ms) is also treated as stopped after
six consecutive Unknown polls (~1.5 s). This handles the iOS case where the
AudioContext never resumes and the worklet never runs, so no `stalled` message
is ever posted. `timingSnapshot()` in `js/audio-engine.js` additionally returns
`idle` (not `unknown`) when `isRunning` is true but the AudioContext is
`suspended`, as a faster signal for that same scenario.

A `manual_stop` flag in `src/app.rs` distinguishes the two recovery paths: the
"engine stopped on its own" error is shown only when the user did NOT click Stop,
preventing the confusing message that appeared when the polling interval fired
one last time after a manual stop and saw the newly-idle engine.

**Inline SVGs need explicit `width`/`height`, not just a `viewBox`.** A
width-less `<svg>` as a flex item collapses to zero in iOS WebKit — this hid the
modulator graphs entirely. `modulator_shape` sets element dimensions and a
margin-inset viewBox so nothing relies on `overflow: visible` (also flaky on
iOS). `tests/browser/modulator-shape.mjs` asserts a non-zero rendered box.

**Touch has no hover.** A hover-gated or sub-15px control is invisible and
unreachable on a phone (the column `⋯` trigger was both). Keep such controls
steadily visible and give them a coarse-pointer touch size.

**`backdrop-filter` needs the `-webkit-` prefix** (iOS < 18), and
`env(safe-area-inset-*)` padding on `body` keeps content clear of the notch and
home indicator (requires `viewport-fit=cover` in the meta). The apple-touch-icon
is a real PNG (iOS ignores SVG manifest icons); regenerate it with
`node scripts/make-touch-icon.mjs`.

## Verification

Compiling proves very little here — the bugs live in CSS layout and audio
levels. Prefer measuring over assuming:

- Audio: render voices offline via `node-web-audio-api` and measure amplitude.
- Layout: drive the real app with Playwright, hit-test and read geometry.
- Screenshot when the question is "does this look right", not just "does it run".

Playwright has Chromium and WebKit installed. **Check WebKit before shipping
layout changes** — it is the iOS target and differs in compositing.

## Decisions already made

- **Sync conflict policy: last-write-wins**, guarded by a check that the remote
  copy has not been updated since the local last-sync timestamp. Not silent
  overwrite.
- **No sampled instruments or bodhrán sounds for now.** Sounds stay synthesized;
  this keeps the bundle small and the PWA caching story simple. Phase 3 in
  ROADMAP.md is deferred accordingly.

## Where to look next

`ROADMAP.md` holds the phased plan and the reasoning behind the sequencing.
Phase 0 (transport hardening) is done. Phase 1 (mixing into the worklet) is the
next substantial piece and unblocks the rest.

`docs/architecture.md` explains the domain model and runtime split.
`docs/build-plan.md` and `docs/vscode-handoff.md` predate the current code and
describe the original scaffold — treat them as history, not current state.
