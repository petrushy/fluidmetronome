# Fluid Metronome — Roadmap

Status as of 2026-07-18. Written after a full review of the audio path, Rust UI,
and Firebase glue following a multi-month pause.

## Where the project actually is

The initial commit plus a large body of uncommitted work gives us:

- A working rhythm model built on per-column `delay_ticks` rather than uniform
  subdivision — this is the core idea and it holds up.
- An `AudioWorklet` that owns the transport clock and posts scheduled triggers
  to the main thread, which plays them with sample-accurate `start(when)`.
- Beat modulators (Sin/Cos/Raise/Drop/Rnd) applied as displacements.
- Four velocity levels per cell.
- Eight synthesized sound presets, pre-rendered to buffers via
  `OfflineAudioContext`.
- A timing-health indicator that watches scheduling lead time.

The one surprise: **`js/firebase.js` is a complete sync implementation that
never runs.** It has Google auth, per-user pattern documents, and sample upload
to Storage — but `index.html` never loads the file and `src/app.rs` declares no
bindings to it. The Rust types were clearly built for it (`Track` already
carries `sample_download_url` and `sample_storage_path`). The work stopped one
wiring step short of working.

## Guiding principle

The three goals — cloud sync, more drum sounds, tighter timing — are not three
separate projects. They converge on a single change to where audio mixing
happens. Sequencing them in the order below means each one makes the next
cheaper.

## Phase 0 — Preserve and stabilise

**Goal: nothing is lost, and the audio thread cannot hang.**

- [x] Commit the outstanding work so the review baseline is recoverable.
- [x] Fix the unbounded scheduling loop in `js/audio-worklet.js`.

The loop `while (this.nextStepFrame < horizonFrame) this.scheduleCurrentStep()`
never terminates if a step has `delay_ticks === 0`, because `nextStepFrame`
stops advancing. This runs on the audio render thread, so it hangs the tab
rather than just stopping sound.

In-app editing cannot produce a zero — `set_step_delay` clamps to `max(1)` and
the number input sets `min="1"` — but **deserialization bypasses both**.
`Step::new` does not clamp, so a malformed pattern from localStorage reaches the
worklet intact. Once Phase 2 lands, patterns arrive from the network, where the
data cannot be trusted at all. This is therefore a prerequisite for sync, not a
cleanup task.

Defence belongs at three layers:

1. `Step::new` clamps `delay_ticks` to at least 1.
2. A `RhythmGrid::sanitize()` runs after every deserialization.
3. The worklet loop guards its own advancement and bails out rather than
   spinning, so no upstream bug can ever lock the audio thread again.

Two notes from doing the work:

- Degenerate tempo values (`bpm: 0`, `ticks_per_beat: 0`) did not hang — they
  made the scheduling horizon `NaN`, so the loop silently never ran and
  playback produced nothing with no diagnostic. The worklet now detects a
  non-finite horizon and reports a `stalled` message, which the engine turns
  into a clean stop.
- **The crate's pure logic is testable natively.** `cargo test --bins` compiles
  and runs on the host toolchain despite the yew/web-sys dependencies, so
  domain tests need no wasm harness. Six tests now cover `sanitize()`.
  The worklet loop itself is covered by driving `process()` in Node with the
  AudioWorklet globals stubbed — worth promoting into the repo as a JS test.

## Phase 1 — Move mixing into the worklet

**Goal: playback timing stops depending on the main thread.**

Today the worklet emits silence and posts a message per hit; the main thread
builds the nodes. Because `start(when)` takes an absolute AudioContext time,
this is sample-accurate *as long as the main thread arrives before `when`* —
roughly 300ms of slack. On desktop that is comfortable. On mobile Safari a GC
pause or a re-render of a large grid can consume it.

Worse, when the deadline is missed, `audio-engine.js` currently does
`Math.max(when, currentTime + 0.0005)`, which shifts the hit later instead of
dropping it. An audible flam is a worse failure than a silent miss, and the
timing indicator cannot tell the two apart.

The fix: the preset buffers are *already* pre-rendered to `Float32Array` via
`OfflineAudioContext`. Transfer them into the worklet and let it mix voices into
its own output at exact frame offsets.

- [ ] Transfer rendered preset buffers into the worklet.
- [ ] Implement a small polyphonic mixer inside `process()`.
- [ ] Keep the message port for UI feedback (playhead, timing) only — never for
      triggering sound.
- [ ] Rework timing health to report *dropped* voices distinctly from late ones.

This eliminates the main thread from the playback path entirely and makes
"very very tight" a structural property rather than a tuning exercise.

## Phase 2 — Wire up cloud sync

**Goal: rhythms follow you between phone and desktop.**

The JavaScript already exists and is well built. The remaining work is Rust-side
binding plus the UI, mirroring how `src/audio/playback.rs` wraps the audio
engine.

- [ ] Load `js/firebase.js` from `index.html`.
- [ ] Add `src/cloud.rs` with `wasm_bindgen` externs for the five
      `window.fluidMetronomeFirebase*` entry points.
- [ ] Auth UI — sign in/out, signed-in identity, and a clear signed-out state.
- [ ] Pattern library UI showing local and cloud patterns together.
- [ ] Replace the "patterns stay local" copy in `src/app.rs`.
- [ ] Tighten `firestore.rules` and `storage.rules` to the per-user paths the
      client actually writes.

**Open design question — conflict policy.** Patterns live in localStorage and
would also live in Firestore. When both hold edits (phone offline, desktop
online), something must win. Last-write-wins on `updatedAt` is simplest and
probably correct for single-user rhythm patterns, but it can silently discard
work. The alternative is an explicit save/load library rather than background
sync — more friction, no surprises. **To be matched against how folkfinder
solves this.**

## Phase 3 — Sound library

**Goal: real percussion, bodhrán first.**

Phase 1 makes this cheap: to the worklet mixer a decoded sample and a rendered
preset are both just a `Float32Array`, so new sounds need no special path.

- [ ] Decide synthesized vs. sampled. A convincing bodhrán depends on the pitch
      bend from hand pressure behind the skin, plus distinct low/high tone and
      rim articulations — hard to synthesize honestly. Sampling is the likely
      answer, at the cost of shipped audio assets and a PWA caching story.
- [ ] Curate a small set: bodhrán low tone, high tone, rim; then a general kit.
- [ ] Per-track sound picker with articulation variants.
- [ ] Service-worker caching strategy for sample assets.
- [ ] Round-robin or velocity-layered variants so repeated hits do not sound
      mechanically identical.

## Phase 4 — Mobile layout

**Goal: usable on the device it was designed for.**

The visual language is coherent — warm paper palette, consistent radius scale,
a genuinely nice tempo wheel. Responsiveness is the gap.

- [ ] `static/app.css` has a single breakpoint at 980px. Below it the sequencer
      keeps a fixed `168px` label rail, leaving very little for the grid on a
      phone and pushing it into horizontal scroll.
- [ ] Grid cells are ~30px wide (`minmax(30px, 1fr)` with a 58px row height),
      under the 44px touch-target guideline — on the one surface you touch most
      while playing.
- [ ] Add a real phone breakpoint; consider collapsing the label rail to icons.
- [ ] Verify iOS home-screen mode, which is the stated deployment target.

## Deferred

- Persist local-only sample files across reloads (IndexedDB).
- Pattern sharing between users.
- Import/export as a portable file format.
