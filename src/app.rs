use crate::audio::pattern::{BeatModulatorFunction, InstrumentKind, RhythmGrid};
use crate::audio::playback;
use js_sys::{Date, Math};
use serde::{Deserialize, Serialize};
use wasm_bindgen_futures::spawn_local;
use web_sys::{Element, HtmlInputElement, HtmlSelectElement};
use yew::prelude::*;

const PATTERN_LIBRARY_KEY: &str = "fluidmetronome.pattern_library";
const DEFAULT_DISPLAY_ROWS: usize = 1;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
struct PatternEntry {
    id: String,
    title: String,
    grid: RhythmGrid,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
struct PatternLibrary {
    current_pattern_id: String,
    patterns: Vec<PatternEntry>,
}

impl PatternLibrary {
    fn demo() -> Self {
        let grid = RhythmGrid::demo();
        let entry = PatternEntry {
            id: next_pattern_id(),
            title: grid.title.clone(),
            grid,
        };

        Self {
            current_pattern_id: entry.id.clone(),
            patterns: vec![entry],
        }
    }

    fn current_pattern(&self) -> &PatternEntry {
        self.patterns
            .iter()
            .find(|pattern| pattern.id == self.current_pattern_id)
            .unwrap_or(&self.patterns[0])
    }

    fn current_pattern_mut(&mut self) -> &mut PatternEntry {
        let index = self
            .patterns
            .iter()
            .position(|pattern| pattern.id == self.current_pattern_id)
            .unwrap_or(0);
        &mut self.patterns[index]
    }
}

fn next_pattern_id() -> String {
    format!("pattern-{}-{}", Date::now() as u64, (Math::random() * 1_000_000.0) as u64)
}

fn next_entity_id() -> u64 {
    Date::now() as u64 + (Math::random() * 1_000_000.0) as u64
}

fn local_storage() -> Option<web_sys::Storage> {
    let window = web_sys::window()?;
    let Ok(Some(storage)) = window.local_storage() else {
        return None;
    };
    Some(storage)
}

fn persist_pattern_library(pattern_library: &PatternLibrary) {
    let Some(storage) = local_storage() else {
        return;
    };

    let Ok(payload) = serde_json::to_string(pattern_library) else {
        return;
    };

    let _ = storage.set_item(PATTERN_LIBRARY_KEY, &payload);
}

fn load_pattern_library() -> PatternLibrary {
    let Some(storage) = local_storage() else {
        return PatternLibrary::demo();
    };

    let Ok(Some(payload)) = storage.get_item(PATTERN_LIBRARY_KEY) else {
        return PatternLibrary::demo();
    };

    serde_json::from_str(&payload).unwrap_or_else(|_| PatternLibrary::demo())
}

fn step_sections(step_count: usize, requested_rows: usize) -> Vec<(usize, usize)> {
    if step_count == 0 {
        return Vec::new();
    }

    let row_count = requested_rows.clamp(1, step_count);
    let base = step_count / row_count;
    let remainder = step_count % row_count;
    let mut start = 0;
    let mut sections = Vec::with_capacity(row_count);

    for row_index in 0..row_count {
        let len = base + usize::from(row_index < remainder);
        let end = start + len;
        sections.push((start, end));
        start = end;
    }

    sections
}

fn board_columns_style(column_count: usize) -> String {
    format!(
        "grid-template-columns: repeat({}, minmax(30px, 1fr));",
        column_count
    )
}

fn next_pattern_name(pattern_count: usize) -> String {
    format!("Pattern {}", pattern_count + 1)
}

const SOUND_PRESETS: [(&str, &str); 8] = [
    ("metronome", "Metronome"),
    ("bright-click", "Bright Click"),
    ("soft-click", "Soft Click"),
    ("hihat-closed", "Hi-Hat Closed"),
    ("hihat-open", "Hi-Hat Open"),
    ("cowbell", "Cowbell"),
    ("woodblock", "Woodblock"),
    ("thump", "Thump"),
];

// ── Tempo wheel ──────────────────────────────────────────────────────────────

fn pointer_angle(event: &web_sys::PointerEvent, el: &Element) -> f64 {
    let rect = el.get_bounding_client_rect();
    let cx = rect.x() + rect.width() / 2.0;
    let cy = rect.y() + rect.height() / 2.0;
    (event.client_y() as f64 - cy).atan2(event.client_x() as f64 - cx)
}

fn angle_delta(from: f64, to: f64) -> f64 {
    let d = to - from;
    if d > std::f64::consts::PI {
        d - std::f64::consts::TAU
    } else if d < -std::f64::consts::PI {
        d + std::f64::consts::TAU
    } else {
        d
    }
}

#[derive(Properties, PartialEq)]
struct TempoWheelProps {
    bpm: u16,
    on_change: Callback<u16>,
}

#[function_component(TempoWheel)]
fn tempo_wheel(props: &TempoWheelProps) -> Html {
    use std::f64::consts::TAU;

    let svg_ref = use_node_ref();
    // use_mut_ref: immediately visible mutations, no re-render — for physics state.
    let dragging = use_mut_ref(|| false);
    let last_angle = use_mut_ref(|| 0.0_f64);
    let remainder = use_mut_ref(|| 0.0_f64);
    // use_state: triggers re-render for the spinning visual.
    let display_rotation = use_state(|| 0.0_f64);

    let bpm = props.bpm;
    let on_change = props.on_change.clone();

    // Pre-compute 12 tick mark line endpoints in the SVG viewBox (200×200).
    // The group containing them will be rotated by display_rotation.
    let tick_lines: Html = (0..12)
        .map(|i| {
            let angle = i as f64 / 12.0 * TAU;
            // 4 major ticks (every 90°), 8 minor ticks.
            let (r_inner, r_outer, stroke_w, opacity): (f64, f64, &str, &str) =
                if i % 3 == 0 {
                    (60.0, 88.0, "2.5", "0.85")
                } else {
                    (67.0, 83.0, "1.5", "0.6")
                };
            let x1 = format!("{:.2}", 100.0 + r_inner * angle.cos());
            let y1 = format!("{:.2}", 100.0 + r_inner * angle.sin());
            let x2 = format!("{:.2}", 100.0 + r_outer * angle.cos());
            let y2 = format!("{:.2}", 100.0 + r_outer * angle.sin());
            let style = format!(
                "stroke:#ddd8ce;stroke-width:{stroke_w};stroke-linecap:round;opacity:{opacity}"
            );
            html! { <line {x1} {y1} {x2} {y2} {style} /> }
        })
        .collect::<Html>();

    let rot_transform = format!("rotate({:.2} 100 100)", *display_rotation);

    let onpointerdown = {
        let svg_ref = svg_ref.clone();
        let dragging = dragging.clone();
        let last_angle = last_angle.clone();
        let remainder = remainder.clone();
        Callback::from(move |e: web_sys::PointerEvent| {
            if *dragging.borrow() {
                return;
            }
            if let Some(el) = svg_ref.cast::<Element>() {
                let rect = el.get_bounding_client_rect();
                let half_w = rect.width() / 2.0;
                let cx = rect.x() + half_w;
                let cy = rect.y() + rect.height() / 2.0;
                let dx = e.client_x() as f64 - cx;
                let dy = e.client_y() as f64 - cy;
                // Don't start a drag when the tap lands inside the center hub —
                // let it fall through to the overlaid <input>.
                if (dx * dx + dy * dy).sqrt() <= half_w * 0.50 {
                    return;
                }
                e.prevent_default();
                let _ = el.set_pointer_capture(e.pointer_id());
                *last_angle.borrow_mut() = pointer_angle(&e, &el);
                *remainder.borrow_mut() = 0.0;
                *dragging.borrow_mut() = true;
            }
        })
    };

    let onpointermove = {
        let svg_ref = svg_ref.clone();
        let dragging = dragging.clone();
        let last_angle = last_angle.clone();
        let remainder = remainder.clone();
        let display_rotation = display_rotation.clone();
        let on_change = on_change.clone();
        Callback::from(move |e: web_sys::PointerEvent| {
            if !*dragging.borrow() {
                return;
            }
            if let Some(el) = svg_ref.cast::<Element>() {
                let prev = *last_angle.borrow();
                let new_angle = pointer_angle(&e, &el);
                let delta = angle_delta(prev, new_angle);
                *last_angle.borrow_mut() = new_angle;

                // Spin the tick marks visually.
                display_rotation.set(*display_rotation + delta.to_degrees());

                // One full rotation = 100 BPM change.
                let raw = delta / TAU * 100.0 + *remainder.borrow();
                let steps = raw.trunc() as i32;
                *remainder.borrow_mut() = raw.fract();

                if steps != 0 {
                    let new_bpm = (bpm as i32 + steps).clamp(30, 280) as u16;
                    on_change.emit(new_bpm);
                }
            }
        })
    };

    let on_drag_end = {
        let dragging = dragging.clone();
        Callback::from(move |_: web_sys::PointerEvent| {
            *dragging.borrow_mut() = false;
        })
    };

    // Direct BPM text entry: only update when value is in the valid range while
    // typing, clamp on blur so a partial value gets resolved.
    let on_bpm_input = {
        let on_change = on_change.clone();
        Callback::from(move |e: InputEvent| {
            let input: HtmlInputElement = e.target_unchecked_into();
            if let Ok(n) = input.value().parse::<u16>() {
                if (30..=280).contains(&n) {
                    on_change.emit(n);
                }
            }
        })
    };

    let on_bpm_change_committed = {
        let on_change = on_change.clone();
        Callback::from(move |e: Event| {
            let input: HtmlInputElement = e.target_unchecked_into();
            let clamped = input.value().parse::<u16>().unwrap_or(bpm).clamp(30, 280);
            on_change.emit(clamped);
        })
    };

    html! {
        <div class="tempo-control">
            <svg
                ref={svg_ref}
                viewBox={"0 0 200 200"}
                class="tempo-wheel"
                onpointerdown={onpointerdown}
                onpointermove={onpointermove}
                onpointerup={on_drag_end.clone()}
                onpointercancel={on_drag_end}
            >
                // Outer disc — inline style so color is guaranteed even without CSS.
                <circle cx="100" cy="100" r="96" style="fill:#c4bfb4;" />
                // Rotating tick marks.
                <g transform={rot_transform}>
                    { tick_lines }
                </g>
                // Center hub — pointer-events:none lets the overlaid <input> win.
                <circle cx="100" cy="100" r="50"
                    style="fill:#eceae3;filter:drop-shadow(0 1px 4px rgba(43,49,59,0.18));pointer-events:none;" />
            </svg>
            // HTML input overlaid on the hub — type=text avoids iOS number-input quirks.
            <input
                type="text"
                inputmode="numeric"
                pattern="[0-9]*"
                class="tempo-bpm-input"
                value={bpm.to_string()}
                oninput={on_bpm_input}
                onchange={on_bpm_change_committed}
                aria-label="Tempo BPM"
            />
        </div>
    }
}

// ── App ───────────────────────────────────────────────────────────────────────

#[function_component(App)]
pub fn app() -> Html {
    let pattern_library = use_state(load_pattern_library);
    let is_playing = use_state(|| false);
    let audio_error = use_state(|| Option::<String>::None);

    let current_pattern = pattern_library.current_pattern().clone();
    let grid = current_pattern.grid.clone();

    {
        let pattern_library = pattern_library.clone();
        use_effect_with(pattern_library.clone(), move |pattern_library| {
            persist_pattern_library(pattern_library);
            || ()
        });
    }

    {
        let grid = grid.clone();
        let is_playing = is_playing.clone();
        let audio_error = audio_error.clone();
        use_effect_with(grid.clone(), move |grid| {
            if *is_playing {
                if let Err(error) = playback::sync_pattern(grid) {
                    audio_error.set(Some(error));
                } else {
                    audio_error.set(None);
                }
            }

            || ()
        });
    }

    let on_pattern_select = {
        let pattern_library = pattern_library.clone();
        Callback::from(move |event: Event| {
            let input: HtmlSelectElement = event.target_unchecked_into();
            let mut next = (*pattern_library).clone();
            next.current_pattern_id = input.value();
            pattern_library.set(next);
        })
    };

    let on_new_pattern = {
        let pattern_library = pattern_library.clone();
        Callback::from(move |_| {
            let mut next = (*pattern_library).clone();
            let title = next_pattern_name(next.patterns.len());
            let grid = RhythmGrid::blank(title.clone());
            let entry = PatternEntry {
                id: next_pattern_id(),
                title: title.clone(),
                grid,
            };
            next.current_pattern_id = entry.id.clone();
            next.patterns.push(entry);
            pattern_library.set(next);
        })
    };

    let on_copy_pattern = {
        let pattern_library = pattern_library.clone();
        Callback::from(move |_| {
            let mut next = (*pattern_library).clone();
            let current = next.current_pattern().clone();
            let mut copied_grid = current.grid.clone();
            let title = format!("{} Copy", current.title);
            copied_grid.title = title.clone();
            let entry = PatternEntry {
                id: next_pattern_id(),
                title,
                grid: copied_grid,
            };
            next.current_pattern_id = entry.id.clone();
            next.patterns.push(entry);
            pattern_library.set(next);
        })
    };

    let on_delete_pattern = {
        let pattern_library = pattern_library.clone();
        Callback::from(move |_| {
            let mut next = (*pattern_library).clone();
            if next.patterns.len() <= 1 {
                return;
            }

            let current = next.current_pattern().clone();
            next.patterns.retain(|pattern| pattern.id != current.id);
            next.current_pattern_id = next.patterns[0].id.clone();
            pattern_library.set(next);
        })
    };

    let on_bpm_change = {
        let pattern_library = pattern_library.clone();
        Callback::from(move |new_bpm: u16| {
            let mut next = (*pattern_library).clone();
            next.current_pattern_mut().grid.bpm = new_bpm;
            pattern_library.set(next);
        })
    };

    let on_ticks_per_beat_input = {
        let pattern_library = pattern_library.clone();
        Callback::from(move |event: Event| {
            let input: HtmlSelectElement = event.target_unchecked_into();
            if let Ok(value) = input.value().parse::<u8>() {
                let mut next = (*pattern_library).clone();
                next.current_pattern_mut().grid.ticks_per_beat = value.max(1);
                pattern_library.set(next);
            }
        })
    };

    let on_add_step = {
        let pattern_library = pattern_library.clone();
        Callback::from(move |_| {
            let mut next = (*pattern_library).clone();
            next.current_pattern_mut().grid.add_step(8);
            pattern_library.set(next);
        })
    };

    let on_remove_step = {
        let pattern_library = pattern_library.clone();
        Callback::from(move |_| {
            let mut next = (*pattern_library).clone();
            next.current_pattern_mut().grid.remove_last_step();
            pattern_library.set(next);
        })
    };

    let on_add_track = {
        let pattern_library = pattern_library.clone();
        Callback::from(move |_| {
            let mut next = (*pattern_library).clone();
            let current = next.current_pattern_mut();
            let name = format!("Track {}", current.grid.tracks.len() + 1);
            current.grid.add_track(name, InstrumentKind::Click);
            pattern_library.set(next);
        })
    };

    let on_add_modulator = {
        let pattern_library = pattern_library.clone();
        Callback::from(move |_| {
            let mut next = (*pattern_library).clone();
            next.current_pattern_mut().grid.add_modulator(next_entity_id());
            pattern_library.set(next);
        })
    };

    let on_toggle_play = {
        let grid = grid.clone();
        let is_playing = is_playing.clone();
        let audio_error = audio_error.clone();
        Callback::from(move |_| {
            if *is_playing {
                playback::stop();
                audio_error.set(None);
                is_playing.set(false);
                return;
            }

            match playback::start(&grid) {
                Ok(true) => {
                    audio_error.set(None);
                    is_playing.set(true);
                }
                Ok(false) => {
                    audio_error.set(Some("Audio engine was not available.".into()));
                    is_playing.set(false);
                }
                Err(error) => {
                    audio_error.set(Some(error));
                    is_playing.set(false);
                }
            }
        })
    };

    let visible_sections = step_sections(grid.step_count(), DEFAULT_DISPLAY_ROWS);

    html! {
        <main class="app-shell">
            <section class="topbar-card">
                <div class="brand-block">
                    <p class="eyebrow">{ "Fluid Metronome" }</p>
                    <h1>{ "Uneven rhythm grid" }</h1>
                    <p class="lead">
                        { "A clean sketchpad for pulse spacing, custom sounds, and reusable rhythm patterns across devices." }
                    </p>
                </div>

                <div class="transport-panel">
                    <button class={classes!("transport-button", (*is_playing).then_some("is-playing"))} onclick={on_toggle_play}>
                        { if *is_playing { "Stop" } else { "Start" } }
                    </button>

                    if let Some(error) = &*audio_error {
                        <p class="status-error">{ error }</p>
                    } else {
                        <p class="status-hint">
                            { "Patterns and sounds stay local in the browser. Firebase is only used for hosting so the app can be reached from mobile." }
                        </p>
                    }
                </div>
            </section>

            <section class="pattern-card">
                <label class="control-field pattern-select-field">
                    <span>{ "Pattern" }</span>
                    <select onchange={on_pattern_select} value={current_pattern.id.clone()}>
                        { for pattern_library.patterns.iter().map(|pattern| html! {
                            <option value={pattern.id.clone()}>{ &pattern.title }</option>
                        })}
                    </select>
                </label>
                <button class="secondary-button" onclick={on_new_pattern}>{ "New" }</button>
                <button class="secondary-button" onclick={on_copy_pattern}>{ "Copy" }</button>
                <button class="secondary-button" onclick={on_delete_pattern}>{ "Delete" }</button>
            </section>

            <section class="control-card">
                <TempoWheel bpm={grid.bpm} on_change={on_bpm_change} />
                <label class="control-field">
                    <span>{ "Mini-ticks / beat" }</span>
                    <select onchange={on_ticks_per_beat_input} value={grid.ticks_per_beat.to_string()}>
                        <option value="4">{ "4" }</option>
                        <option value="6">{ "6" }</option>
                        <option value="8">{ "8" }</option>
                        <option value="12">{ "12" }</option>
                    </select>
                </label>
                <button class="secondary-button" onclick={on_add_step}>{ "Add Column" }</button>
                <button class="secondary-button" onclick={on_remove_step}>{ "Remove Column" }</button>
                <button class="secondary-button" onclick={on_add_track}>{ "Add Instrument" }</button>
            </section>

            <section class="sequencer-card">
                <div class="sequencer-scroll">
                    <div class="sequencer-stack">
                        {
                            for visible_sections.iter().map(|&(start, end)| {
                                let section_len = end - start;

                                html! {
                                    <div class="sequencer-layout">
                                        <div class="label-rail">
                                            <div class="label-headings">
                                                <span>{ "Instrument" }</span>
                                                <span>{ "Note" }</span>
                                            </div>
                                            {
                                                for grid.tracks.iter().enumerate().map(|(track_index, track)| {
                                                    let sample_label = track
                                                        .sample_name
                                                        .as_deref()
                                                        .or(track.sample_storage_path.as_deref())
                                                        .or_else(|| {
                                                            SOUND_PRESETS
                                                                .iter()
                                                                .find(|(id, _)| *id == track.sound_preset)
                                                                .map(|(_, label)| *label)
                                                        })
                                                        .unwrap_or(track.instrument.as_label());
                                                    let pattern_library_for_sample = pattern_library.clone();
                                                    let audio_error = audio_error.clone();
                                                    let onchange = Callback::from(move |event: Event| {
                                                        let input: HtmlInputElement = event.target_unchecked_into();
                                                        let Some(files) = input.files() else {
                                                            return;
                                                        };
                                                        let Some(file) = files.get(0) else {
                                                            return;
                                                        };

                                                        let file_name = file.name();
                                                        let local_file = file.clone();
                                                        let pattern_library = pattern_library_for_sample.clone();
                                                        let audio_error = audio_error.clone();

                                                        spawn_local(async move {
                                                            match playback::load_track_sample(track_index, local_file).await {
                                                                Ok(()) => {
                                                                    let mut next = (*pattern_library).clone();
                                                                    next.current_pattern_mut().grid.set_track_sample_source(
                                                                        track_index,
                                                                        Some(file_name.clone()),
                                                                        None,
                                                                        None,
                                                                    );
                                                                    pattern_library.set(next);
                                                                    audio_error.set(None);
                                                                }
                                                                Err(error) => {
                                                                    audio_error.set(Some(error));
                                                                    return;
                                                                }
                                                            }
                                                        });

                                                        input.set_value("");
                                                    });

                                                    let pattern_library_for_note = pattern_library.clone();
                                                    let on_note_input = Callback::from(move |event: InputEvent| {
                                                        let input: HtmlInputElement = event.target_unchecked_into();
                                                        let mut next = (*pattern_library_for_note).clone();
                                                        next.current_pattern_mut().grid.set_track_note(track_index, input.value());
                                                        pattern_library_for_note.set(next);
                                                    });

                                                    let preset_buttons = SOUND_PRESETS.iter().map(|(preset_id, preset_label)| {
                                                        let pattern_library = pattern_library.clone();
                                                        let preset_id = (*preset_id).to_string();
                                                        let preset_label = *preset_label;
                                                        let onclick = Callback::from(move |_| {
                                                            let mut next = (*pattern_library).clone();
                                                            next.current_pattern_mut().grid.set_track_sound_preset(track_index, preset_id.clone());
                                                            pattern_library.set(next);
                                                        });

                                                        html! {
                                                            <button type="button" class="sound-option" {onclick}>{ preset_label }</button>
                                                        }
                                                    });

                                                    html! {
                                                        <div class="label-row">
                                                            <div class="instrument-name">
                                                                <strong>{ &track.name }</strong>
                                                                <small>{ sample_label }</small>
                                                                <details class="sound-menu">
                                                                    <summary class="sample-picker">{ "Sound" }</summary>
                                                                    <div class="sound-menu-popover">
                                                                        <div class="sound-options">
                                                                            { for preset_buttons }
                                                                        </div>
                                                                        <label class="sound-file-option">
                                                                            <span>{ "Load File" }</span>
                                                                            <input type="file" accept=".wav,.mp3,audio/wav,audio/mpeg" onchange={onchange} />
                                                                        </label>
                                                                    </div>
                                                                </details>
                                                            </div>
                                                            <label class="note-name note-input-wrap">
                                                                <input
                                                                    class="note-input"
                                                                    type="text"
                                                                    value={track.note.clone()}
                                                                    oninput={on_note_input}
                                                                    placeholder="C4 or 60"
                                                                    spellcheck="false"
                                                                />
                                                            </label>
                                                        </div>
                                                    }
                                                })
                                            }
                                        </div>

                                        <div class="board-shell">
                                            <div class="board-header" style={board_columns_style(section_len)}>
                                                {
                                                    for grid.steps[start..end].iter().enumerate().map(|(offset, step)| {
                                                        let step_index = start + offset;
                                                        let pattern_library = pattern_library.clone();
                                                        let oninput = Callback::from(move |event: InputEvent| {
                                                            let input: HtmlInputElement = event.target_unchecked_into();
                                                            if let Ok(value) = input.value().parse::<u8>() {
                                                                let mut next = (*pattern_library).clone();
                                                                next.current_pattern_mut().grid.set_step_delay(step_index, value);
                                                                pattern_library.set(next);
                                                            }
                                                        });

                                                        html! {
                                                            <label class="delay-chip">
                                                                <input type="number" min="1" max="32" value={step.delay_ticks.to_string()} oninput={oninput} />
                                                            </label>
                                                        }
                                                    })
                                                }
                                            </div>

                                            <div class="board-grid" style={board_columns_style(section_len)}>
                                                {
                                                    for grid.tracks.iter().enumerate().flat_map(|(track_index, track)| {
                                                        let pattern_library = pattern_library.clone();
                                                        track.step_velocities[start..end]
                                                            .iter()
                                                            .copied()
                                                            .enumerate()
                                                            .map(move |(offset, velocity)| {
                                                                let step_index = start + offset;
                                                                let pattern_library = pattern_library.clone();
                                                                let onclick = Callback::from(move |_| {
                                                                    let mut next = (*pattern_library).clone();
                                                                    next.current_pattern_mut().grid.cycle_cell(track_index, step_index);
                                                                    pattern_library.set(next);
                                                                });

                                                                html! {
                                                                    <button class={classes!("grid-cell", velocity.css_class())} {onclick}>
                                                                        <span class={classes!("grid-mark", velocity.css_class())}></span>
                                                                    </button>
                                                                }
                                                            })
                                                    })
                                                }
                                            </div>
                                        </div>
                                    </div>
                                }
                            })
                        }
                    </div>
                </div>
            </section>

            <section class="modulators-card">
                <div class="modulators-header">
                    <div>
                        <p class="eyebrow">{ "Beat Manipulators" }</p>
                        <p class="modulators-lead">
                            { "Mathematical timing offsets are summed and applied to note start time in ticks." }
                        </p>
                    </div>
                    <button class="secondary-button" onclick={on_add_modulator}>{ "Add Modulator" }</button>
                </div>

                <div class="modulators-list">
                    {
                        if grid.modulators.is_empty() {
                            html! {
                                <p class="modulators-empty">
                                    { "No beat manipulators yet. Add one to start bending note timing with a function such as sin." }
                                </p>
                            }
                        } else {
                            html! {
                                <>
                                    { for grid.modulators.iter().map(|modulator| {
                                        let modulator_id = modulator.id;

                                        let pattern_library_for_function = pattern_library.clone();
                                        let on_function_change = Callback::from(move |event: Event| {
                                            let input: HtmlSelectElement = event.target_unchecked_into();
                                            let mut next = (*pattern_library_for_function).clone();
                                            let function = match input.value().as_str() {
                                                "Sin" => BeatModulatorFunction::Sin,
                                                "Cos" => BeatModulatorFunction::Cos,
                                                "Raise" => BeatModulatorFunction::Raise,
                                                "Drop" => BeatModulatorFunction::Drop,
                                                "Rnd" => BeatModulatorFunction::Rnd,
                                                _ => BeatModulatorFunction::Sin,
                                            };
                                            next.current_pattern_mut().grid.set_modulator_function(modulator_id, function);
                                            pattern_library_for_function.set(next);
                                        });

                                        let pattern_library_for_amplitude = pattern_library.clone();
                                        let on_amplitude_input = Callback::from(move |event: InputEvent| {
                                            let input: HtmlInputElement = event.target_unchecked_into();
                                            if let Ok(value) = input.value().parse::<i16>() {
                                                let mut next = (*pattern_library_for_amplitude).clone();
                                                next.current_pattern_mut().grid.set_modulator_amplitude(modulator_id, value);
                                                pattern_library_for_amplitude.set(next);
                                            }
                                        });

                                        let pattern_library_for_wavelength = pattern_library.clone();
                                        let on_wavelength_input = Callback::from(move |event: InputEvent| {
                                            let input: HtmlInputElement = event.target_unchecked_into();
                                            if let Ok(value) = input.value().parse::<u16>() {
                                                let mut next = (*pattern_library_for_wavelength).clone();
                                                next.current_pattern_mut().grid.set_modulator_wavelength(modulator_id, value);
                                                pattern_library_for_wavelength.set(next);
                                            }
                                        });

                                        let pattern_library_for_phase = pattern_library.clone();
                                        let on_phase_input = Callback::from(move |event: InputEvent| {
                                            let input: HtmlInputElement = event.target_unchecked_into();
                                            if let Ok(value) = input.value().parse::<i16>() {
                                                let mut next = (*pattern_library_for_phase).clone();
                                                next.current_pattern_mut().grid.set_modulator_phase(modulator_id, value);
                                                pattern_library_for_phase.set(next);
                                            }
                                        });

                                        let pattern_library_for_restart = pattern_library.clone();
                                        let on_restart_toggle = Callback::from(move |event: Event| {
                                            let input: HtmlInputElement = event.target_unchecked_into();
                                            let mut next = (*pattern_library_for_restart).clone();
                                            next.current_pattern_mut().grid.set_modulator_restart(modulator_id, input.checked());
                                            pattern_library_for_restart.set(next);
                                        });

                                        let pattern_library_for_mute = pattern_library.clone();
                                        let on_mute_toggle = Callback::from(move |_| {
                                            let mut next = (*pattern_library_for_mute).clone();
                                            let next_muted = next
                                                .current_pattern()
                                                .grid
                                                .modulators
                                                .iter()
                                                .find(|modulator| modulator.id == modulator_id)
                                                .map(|modulator| !modulator.muted)
                                                .unwrap_or(false);
                                            next.current_pattern_mut().grid.set_modulator_muted(modulator_id, next_muted);
                                            pattern_library_for_mute.set(next);
                                        });

                                        let pattern_library_for_duplicate = pattern_library.clone();
                                        let on_duplicate = Callback::from(move |_| {
                                            let mut next = (*pattern_library_for_duplicate).clone();
                                            next.current_pattern_mut().grid.duplicate_modulator(modulator_id, next_entity_id());
                                            pattern_library_for_duplicate.set(next);
                                        });

                                        let pattern_library_for_remove = pattern_library.clone();
                                        let on_remove = Callback::from(move |_| {
                                            let mut next = (*pattern_library_for_remove).clone();
                                            next.current_pattern_mut().grid.remove_modulator(modulator_id);
                                            pattern_library_for_remove.set(next);
                                        });

                                        html! {
                                            <div class="modulator-item">
                                                <label class="control-field modulator-field">
                                                    <span>{ "Function" }</span>
                                                    <select onchange={on_function_change} value={modulator.function.as_label()}>
                                                        <option value="Sin">{ "Sin" }</option>
                                                        <option value="Cos">{ "Cos" }</option>
                                                        <option value="Raise">{ "Raise" }</option>
                                                        <option value="Drop">{ "Drop" }</option>
                                                        <option value="Rnd">{ "Rnd" }</option>
                                                    </select>
                                                </label>

                                                <label class="control-field modulator-field">
                                                    <span>{ "Amplitude" }</span>
                                                    <input type="number" min="-64" max="64" value={modulator.amplitude_ticks.to_string()} oninput={on_amplitude_input} />
                                                </label>

                                                <label class="control-field modulator-field">
                                                    <span>{ "Wavelength" }</span>
                                                    <input type="number" min="1" max="256" value={modulator.wavelength_ticks.to_string()} oninput={on_wavelength_input} />
                                                </label>

                                                <label class="control-field modulator-field">
                                                    <span>{ "Start Phase" }</span>
                                                    <input type="number" min="-360" max="360" value={modulator.phase_degrees.to_string()} oninput={on_phase_input} />
                                                </label>

                                                <label class="modulator-toggle">
                                                    <input type="checkbox" checked={modulator.restart_each_loop} onchange={on_restart_toggle} />
                                                    <span>{ "Restart at grid start" }</span>
                                                </label>

                                                <div class="modulator-actions">
                                                    <button class={classes!("secondary-button", modulator.muted.then_some("is-active-toggle"))} onclick={on_mute_toggle}>
                                                        { if modulator.muted { "Unmute" } else { "Mute" } }
                                                    </button>
                                                    <button class="secondary-button" onclick={on_duplicate}>{ "Duplicate" }</button>
                                                    <button class="secondary-button" onclick={on_remove}>{ "Remove" }</button>
                                                </div>
                                            </div>
                                        }
                                    })}
                                </>
                            }
                        }
                    }
                </div>
            </section>
        </main>
    }
}
