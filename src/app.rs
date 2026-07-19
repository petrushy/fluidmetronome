use crate::audio::pattern::{
    title_slug, BeatModulatorFunction, InstrumentKind, PatternFile, RhythmGrid,
    MAX_TICKS_PER_BEAT, MIN_TICKS_PER_BEAT,
};
use crate::audio::playback;
use crate::audio::playback::{TimingHealth, TimingStatus};
use gloo::timers::callback::Interval;
use js_sys::{Date, Math};
use serde::{Deserialize, Serialize};
use wasm_bindgen_futures::spawn_local;
use web_sys::{Element, HtmlInputElement, HtmlSelectElement};
use yew::prelude::*;

const PATTERN_LIBRARY_KEY: &str = "fluidmetronome.pattern_library";
const DEFAULT_DISPLAY_ROWS: usize = 1;

#[derive(Clone, PartialEq, Serialize, Deserialize)]
struct PatternEntry {
    id: String,
    title: String,
    grid: RhythmGrid,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
struct PatternLibrary {
    current_pattern_id: String,
    patterns: Vec<PatternEntry>,
}

impl PatternLibrary {
    /// Rename the selected pattern.
    ///
    /// The title lives in two places -- `PatternEntry::title` drives the picker,
    /// `grid.title` is what an export writes into the file -- so both move
    /// together or the exported filename stops matching its contents.
    fn rename_current(&mut self, title: &str) {
        let title = match title.trim() {
            "" => return,
            trimmed => trimmed.to_string(),
        };

        let entry = self.current_pattern_mut();
        entry.title = title.clone();
        entry.grid.title = title;
    }

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

    let Ok(mut library) = serde_json::from_str::<PatternLibrary>(&payload) else {
        return PatternLibrary::demo();
    };

    // Stored JSON has not been through the editor's clamps.
    if library.patterns.is_empty() {
        return PatternLibrary::demo();
    }

    for pattern in &mut library.patterns {
        pattern.grid.sanitize();
    }

    library
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

/// Narrowest a column may get, whatever its spacing. Below this the cell stops
/// being a usable target and the delay field stops being readable.
const MIN_COLUMN_PX: u8 = 34;

/// Size each column in proportion to its own `delay_ticks`, so the uneven
/// spacing of a pattern is visible in the grid rather than only in the numbers.
///
/// `minmax(MIN, Nfr)` keeps a short column usable: the fr share distributes the
/// free space proportionally, but never below the floor. A pattern with one very
/// long column therefore compresses the rest only until they hit that floor.
fn board_columns_style(delays: &[u8]) -> String {
    let mut style = String::from("grid-template-columns:");

    for delay in delays {
        style.push_str(&format!(
            " minmax({MIN_COLUMN_PX}px, {}fr)",
            (*delay).max(1)
        ));
    }

    style.push(';');
    style
}

/// An open column menu, with the viewport coordinates of the button that
/// opened it. The menu renders at .app-shell level rather than inside the
/// column header, because .board-scroll is a scroll container and would clip
/// it -- the same trap that cropped the sound menu.
#[derive(Clone, PartialEq)]
struct ColumnMenu {
    step_index: usize,
    /// Ready-made CSS placement, resolved against the viewport at click time.
    style: String,
}

/// Matches .column-menu's min-width; used to keep the menu on screen.
const COLUMN_MENU_WIDTH: f64 = 200.0;
const COLUMN_MENU_MARGIN: f64 = 12.0;

/// Place the menu next to its button without letting it leave the viewport.
///
/// The menu is fixed-position, so anything pushed off screen stays off screen
/// -- scrolling will not bring it back. Below the midpoint it therefore opens
/// upward instead of downward.
fn column_menu_style(rect: &web_sys::DomRect) -> String {
    let window = web_sys::window();
    let viewport_width = window
        .as_ref()
        .and_then(|w| w.inner_width().ok())
        .and_then(|v| v.as_f64())
        .unwrap_or(1024.0);
    let viewport_height = window
        .as_ref()
        .and_then(|w| w.inner_height().ok())
        .and_then(|v| v.as_f64())
        .unwrap_or(768.0);

    let left = rect
        .left()
        .min(viewport_width - COLUMN_MENU_WIDTH - COLUMN_MENU_MARGIN)
        .max(COLUMN_MENU_MARGIN);

    if rect.bottom() > viewport_height * 0.55 {
        let bottom = (viewport_height - rect.top() + 6.0).max(COLUMN_MENU_MARGIN);
        format!("left: {left}px; bottom: {bottom}px;")
    } else {
        format!("left: {left}px; top: {}px;", rect.bottom() + 6.0)
    }
}

#[derive(Clone, Copy, PartialEq)]
enum ColumnAction {
    AddLeft,
    AddRight,
    DuplicateLeft,
    DuplicateRight,
    Delete,
}

impl ColumnAction {
    fn label(self) -> &'static str {
        match self {
            Self::AddLeft => "Add column to left",
            Self::AddRight => "Add column to right",
            Self::DuplicateLeft => "Duplicate to left",
            Self::DuplicateRight => "Duplicate to right",
            Self::Delete => "Delete column",
        }
    }

    fn apply(self, grid: &mut RhythmGrid, step_index: usize) {
        match self {
            Self::AddLeft => grid.insert_step(step_index, step_index),
            Self::AddRight => grid.insert_step(step_index + 1, step_index),
            Self::DuplicateLeft => grid.duplicate_step(step_index, step_index),
            Self::DuplicateRight => grid.duplicate_step(step_index, step_index + 1),
            Self::Delete => grid.remove_step(step_index),
        }
    }
}

const COLUMN_ACTIONS: [ColumnAction; 5] = [
    ColumnAction::AddLeft,
    ColumnAction::AddRight,
    ColumnAction::DuplicateLeft,
    ColumnAction::DuplicateRight,
    ColumnAction::Delete,
];

/// Keep an imported title distinct from what is already in the library, so a
/// re-import is visibly a second copy rather than an apparent duplicate.
fn unique_pattern_title(desired: &str, patterns: &[PatternEntry]) -> String {
    let base = match desired.trim() {
        "" => "Imported pattern",
        trimmed => trimmed,
    };

    let taken = |candidate: &str| patterns.iter().any(|entry| entry.title == candidate);
    if !taken(base) {
        return base.to_string();
    }

    for suffix in 2..1000 {
        let candidate = format!("{base} ({suffix})");
        if !taken(&candidate) {
            return candidate;
        }
    }

    format!("{base} ({})", next_pattern_id())
}

const SHAPE_WIDTH: f64 = 128.0;
const SHAPE_HEIGHT: f64 = 44.0;
const SHAPE_SAMPLES: usize = 96;

/// Draw one loop of a modulator's curve.
///
/// The domain is the pattern's own cycle starting at tick 0, so the diagram
/// shows what the modulator actually does to this pattern from the loop start,
/// not an idealised single period. Values come from `BeatModulator::offset_ticks`,
/// the same arithmetic the worklet runs.
///
/// The curve is normalised to the modulator's own amplitude so the shape stays
/// visible at any depth; the sign is preserved, so a negative amplitude flips
/// the picture as it flips the timing.
fn modulator_shape(
    modulator: &crate::audio::pattern::BeatModulator,
    cycle_ticks: f64,
    column_ticks: &[f64],
) -> Html {
    let domain = if cycle_ticks > 0.0 {
        cycle_ticks
    } else {
        modulator.wavelength_ticks.max(1.0)
    };

    let scale = modulator.amplitude_ticks.abs().max(f64::EPSILON);
    let mid = SHAPE_HEIGHT / 2.0;
    let reach = mid - 4.0;

    let mut points = String::with_capacity(SHAPE_SAMPLES * 12);
    let mut start_y = mid;

    for index in 0..=SHAPE_SAMPLES {
        let progress = index as f64 / SHAPE_SAMPLES as f64;
        let tick = progress * domain;
        let value = modulator.offset_ticks(tick, cycle_ticks);
        // Plotted the way the function would be on paper: positive up. SVG y
        // grows downward, hence the subtraction. Sin therefore rises first and
        // Cos starts at the top, which is what makes the shape recognisable.
        let y = mid - (value / scale).clamp(-1.0, 1.0) * reach;

        if index == 0 {
            start_y = y;
        } else {
            points.push(' ');
        }

        points.push_str(&format!("{:.2},{:.2}", progress * SHAPE_WIDTH, y));
    }

    let label = format!(
        "{} over {} ticks, amplitude {}",
        modulator.function.as_label(),
        format_beats(domain),
        modulator.amplitude_ticks,
    );

    // One bar per column, at the tick where that column fires. These are the
    // only points the modulator is actually sampled at -- the curve between
    // them is never heard.
    let columns = column_ticks
        .iter()
        .filter(|tick| **tick <= domain)
        .map(|tick| {
            let x = (tick / domain) * SHAPE_WIDTH;
            html! {
                <line
                    class="shape-column"
                    x1={format!("{x:.2}")}
                    y1="0"
                    x2={format!("{x:.2}")}
                    y2={SHAPE_HEIGHT.to_string()}
                />
            }
        })
        .collect::<Html>();

    html! {
        <svg
            class="modulator-shape"
            // Rnd is seeded from the id, so the curve cannot be reproduced
            // without it.
            data-modulator-id={modulator.id.to_string()}
            viewBox={format!("0 0 {SHAPE_WIDTH} {SHAPE_HEIGHT}")}
            preserveAspectRatio="none"
            role="img"
            aria-label={label.clone()}
        >
            <title>{ label }</title>
            { columns }
            <line class="shape-axis" x1="0" y1={mid.to_string()} x2={SHAPE_WIDTH.to_string()} y2={mid.to_string()} />
            <polyline class="shape-curve" points={points} />
            // Marks the value at tick 0, where the first column sits.
            <circle class="shape-start" cx="0" cy={format!("{start_y:.2}")} r="2.6" />
        </svg>
    }
}

/// Beats per loop, shown whole when the pattern closes on a beat and to two
/// trimmed decimals when it does not -- which, for uneven rhythms, is normal.
fn format_beats(beats: f64) -> String {
    if (beats - beats.round()).abs() < 1e-9 {
        return format!("{}", beats.round() as i64);
    }

    let text = format!("{beats:.2}");
    text.trim_end_matches('0').trim_end_matches('.').to_string()
}

fn next_pattern_name(pattern_count: usize) -> String {
    format!("Pattern {}", pattern_count + 1)
}

/// A `<select>` ignores a `value` attribute -- the chosen option is marked with
/// `selected` on the option itself. Binding these lists keeps that in one place.
const TICKS_PER_BEAT_OPTIONS: [u8; 6] = [4, 6, 8, 12, 16, 32];

/// Accept a typed mini-ticks/beat entry, or `None` when it is not yet a usable
/// number ("", "-", "0", "abc") so partial input is never treated as a value.
///
/// "7." parses as 7.0 and is accepted; the draft text keeps showing "7." so the
/// decimals can still be typed.
fn parse_ticks_per_beat(text: &str) -> Option<f64> {
    let value = text.trim().parse::<f64>().ok()?;
    if !value.is_finite() || value <= 0.0 {
        return None;
    }

    Some(value.clamp(MIN_TICKS_PER_BEAT, MAX_TICKS_PER_BEAT))
}

/// Show a whole number without a trailing ".0", and a fraction as typed.
fn format_ticks_per_beat(value: f64) -> String {
    if (value - value.round()).abs() < 1e-9 {
        return format!("{}", value.round() as i64);
    }

    format!("{value}")
}

const MODULATOR_FUNCTIONS: [&str; 5] = ["Sin", "Cos", "Raise", "Drop", "Rnd"];

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
    let timing_status = use_state(TimingStatus::default);
    let column_menu = use_state(|| Option::<ColumnMenu>::None);
    // Some(draft) while the pattern name is being edited.
    let renaming = use_state(|| Option::<String>::None);
    let ticks_draft = use_state(|| Option::<String>::None);

    let current_pattern = pattern_library.current_pattern().clone();
    let grid = current_pattern.grid.clone();
    // Where each column falls in the loop; used to mark them on modulator plots.
    let column_ticks = grid.step_tick_offsets();

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

    {
        let is_playing = is_playing.clone();
        let timing_status = timing_status.clone();
        use_effect_with(*is_playing, move |is_playing| {
            let interval = if !*is_playing {
                timing_status.set(TimingStatus::default());
                None
            } else {
                let timing_status_now = timing_status.clone();
                let _ = playback::timing_status().map(|status| timing_status_now.set(status));

                Some(Interval::new(250, move || {
                    if let Ok(status) = playback::timing_status() {
                        timing_status.set(status);
                    }
                }))
            };

            move || drop(interval)
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

    let on_start_rename = {
        let renaming = renaming.clone();
        let pattern_library = pattern_library.clone();
        Callback::from(move |_| {
            renaming.set(Some(pattern_library.current_pattern().title.clone()));
        })
    };

    let on_rename_input = {
        let renaming = renaming.clone();
        Callback::from(move |event: InputEvent| {
            let input: HtmlInputElement = event.target_unchecked_into();
            renaming.set(Some(input.value()));
        })
    };

    let on_commit_rename = {
        let renaming = renaming.clone();
        let pattern_library = pattern_library.clone();
        Callback::from(move |_| {
            if let Some(draft) = (*renaming).clone() {
                let mut next = (*pattern_library).clone();
                next.rename_current(&draft);
                pattern_library.set(next);
            }
            renaming.set(None);
        })
    };

    let on_cancel_rename = {
        let renaming = renaming.clone();
        Callback::from(move |_| renaming.set(None))
    };

    let on_rename_key = {
        let renaming = renaming.clone();
        let pattern_library = pattern_library.clone();
        Callback::from(move |event: KeyboardEvent| match event.key().as_str() {
            "Enter" => {
                if let Some(draft) = (*renaming).clone() {
                    let mut next = (*pattern_library).clone();
                    next.rename_current(&draft);
                    pattern_library.set(next);
                }
                renaming.set(None);
            }
            "Escape" => renaming.set(None),
            _ => {}
        })
    };

    let on_export_pattern = {
        let pattern_library = pattern_library.clone();
        let audio_error = audio_error.clone();
        Callback::from(move |_| {
            let current = pattern_library.current_pattern();
            // Only the selected pattern, never the whole library.
            let file = PatternFile::new(current.grid.clone());

            let result = file.to_json().and_then(|json| {
                crate::file_io::download_text(
                    &format!("{}.fluidmetronome.json", title_slug(&current.title)),
                    &json,
                    "application/json",
                )
            });

            audio_error.set(result.err());
        })
    };

    let on_import_pattern = {
        let pattern_library = pattern_library.clone();
        let audio_error = audio_error.clone();
        Callback::from(move |event: Event| {
            let input: HtmlInputElement = event.target_unchecked_into();
            let Some(file) = input.files().and_then(|files| files.get(0)) else {
                return;
            };

            // Clear the input so picking the same file twice still fires onchange.
            input.set_value("");

            let pattern_library = pattern_library.clone();
            let audio_error = audio_error.clone();
            spawn_local(async move {
                let grids = match crate::file_io::read_text(file).await {
                    Ok(text) => match PatternFile::from_json(&text) {
                        Ok(grids) => grids,
                        Err(error) => {
                            audio_error.set(Some(error));
                            return;
                        }
                    },
                    Err(error) => {
                        audio_error.set(Some(error));
                        return;
                    }
                };

                let mut next = (*pattern_library).clone();

                for grid in grids {
                    // Imported patterns are added, never replacing what is here.
                    let title = unique_pattern_title(&grid.title, &next.patterns);
                    let mut grid = grid;
                    grid.title = title.clone();

                    let entry = PatternEntry {
                        id: next_pattern_id(),
                        title,
                        grid,
                    };
                    next.current_pattern_id = entry.id.clone();
                    next.patterns.push(entry);
                }

                pattern_library.set(next);
                audio_error.set(None);
            });
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

    // While the field is being typed in, the raw text is held here. Without it,
    // each re-render would rewrite the input from the model and an intermediate
    // value like "7." could never be typed.
    let on_ticks_per_beat_input = {
        let pattern_library = pattern_library.clone();
        let ticks_draft = ticks_draft.clone();
        Callback::from(move |event: InputEvent| {
            let input: HtmlInputElement = event.target_unchecked_into();
            let text = input.value();

            if let Some(value) = parse_ticks_per_beat(&text) {
                let mut next = (*pattern_library).clone();
                next.current_pattern_mut().grid.ticks_per_beat = value;
                pattern_library.set(next);
            }

            ticks_draft.set(Some(text));
        })
    };

    // On leaving the field, drop the draft so the display returns to the value
    // actually in use -- which also shows the clamp if the entry was out of range.
    let on_ticks_per_beat_blur = {
        let ticks_draft = ticks_draft.clone();
        Callback::from(move |_: FocusEvent| ticks_draft.set(None))
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
    let timing_class = match timing_status.state {
        TimingHealth::Tight => "is-tight",
        TimingHealth::Late => "is-late",
        TimingHealth::Unknown => "is-unknown",
        TimingHealth::Idle => "is-idle",
    };
    let timing_copy = match timing_status.state {
        TimingHealth::Tight => "Timing tight",
        TimingHealth::Late => "Timing off",
        TimingHealth::Unknown => "Checking timing",
        TimingHealth::Idle => "Timing idle",
    };
    let timing_detail = match timing_status.state {
        TimingHealth::Tight => timing_status
            .latest_lead_ms
            .map(|lead| format!("{lead:.1} ms lead"))
            .unwrap_or_else(|| "healthy headroom".into()),
        TimingHealth::Late => timing_status
            .latest_lead_ms
            .map(|lead| format!("{lead:.1} ms lead"))
            .unwrap_or_else(|| "late trigger detected".into()),
        TimingHealth::Unknown => "warming up transport".into(),
        TimingHealth::Idle => "press start to monitor".into(),
    };

    // Rendered at .app-shell level, outside .board-scroll, so the scroll
    // container cannot clip it.
    let column_menu_view: Html = match (*column_menu).clone() {
        None => Html::default(),
        Some(menu) => {
            let step_index = menu.step_index;
            let can_delete = grid.step_count() > 1;
            let close = {
                let column_menu = column_menu.clone();
                Callback::from(move |_: MouseEvent| column_menu.set(None))
            };

            let items = COLUMN_ACTIONS.iter().copied().map(|action| {
                let is_delete = action == ColumnAction::Delete;
                let pattern_library = pattern_library.clone();
                let column_menu = column_menu.clone();
                let onclick = Callback::from(move |_| {
                    let mut next = (*pattern_library).clone();
                    action.apply(&mut next.current_pattern_mut().grid, step_index);
                    pattern_library.set(next);
                    column_menu.set(None);
                });

                html! {
                    <button
                        type="button"
                        role="menuitem"
                        class={classes!("column-menu-item", is_delete.then_some("is-danger"))}
                        disabled={is_delete && !can_delete}
                        {onclick}
                    >{ action.label() }</button>
                }
            });

            html! {
                <>
                    // Any click outside the menu dismisses it.
                    <div class="column-menu-backdrop" onclick={close}></div>
                    <div class="column-menu" role="menu" style={menu.style.clone()}>
                        <p class="column-menu-title">{ format!("Column {}", step_index + 1) }</p>
                        { for items }
                    </div>
                </>
            }
        }
    };

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

                    <div class="timing-pill">
                        <span class={classes!("timing-diode", timing_class)}></span>
                        <div class="timing-copy">
                            <strong>{ timing_copy }</strong>
                            <span>{ timing_detail }</span>
                        </div>
                    </div>

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
                if let Some(draft) = (*renaming).clone() {
                    <label class="control-field pattern-select-field">
                        <span>{ "Rename pattern" }</span>
                        <input
                            class="rename-input"
                            type="text"
                            value={draft}
                            oninput={on_rename_input}
                            onkeydown={on_rename_key}
                            autofocus=true
                            spellcheck="false"
                        />
                    </label>
                    <button class="secondary-button is-active-toggle" onclick={on_commit_rename}>{ "Save" }</button>
                    <button class="secondary-button" onclick={on_cancel_rename}>{ "Cancel" }</button>
                } else {
                    <label class="control-field pattern-select-field">
                        <span>{ "Pattern" }</span>
                        <select onchange={on_pattern_select}>
                            { for pattern_library.patterns.iter().map(|pattern| html! {
                                <option
                                    value={pattern.id.clone()}
                                    selected={pattern.id == current_pattern.id}
                                >{ &pattern.title }</option>
                            })}
                        </select>
                    </label>
                    <button class="secondary-button" onclick={on_start_rename}>{ "Rename" }</button>
                }
                <button class="secondary-button" onclick={on_new_pattern}>{ "New" }</button>
                <button class="secondary-button" onclick={on_copy_pattern}>{ "Copy" }</button>
                <button class="secondary-button" onclick={on_delete_pattern}>{ "Delete" }</button>
                <button class="secondary-button" onclick={on_export_pattern}>{ "Export" }</button>
                <label class="secondary-button file-button">
                    <span>{ "Import" }</span>
                    <input
                        type="file"
                        accept=".json,application/json"
                        onchange={on_import_pattern}
                    />
                </label>
            </section>

            <section class="control-card">
                <TempoWheel bpm={grid.bpm} on_change={on_bpm_change} />
                <label class="control-field">
                    <span>{ "Mini-ticks / beat" }</span>
                    <input
                        class="ticks-input"
                        type="number"
                        inputmode="decimal"
                        step="any"
                        min="0.01"
                        max="512"
                        list="ticks-per-beat-options"
                        value={(*ticks_draft).clone().unwrap_or_else(|| format_ticks_per_beat(grid.ticks_per_beat))}
                        oninput={on_ticks_per_beat_input}
                        onblur={on_ticks_per_beat_blur}
                    />
                    <datalist id="ticks-per-beat-options">
                        { for TICKS_PER_BEAT_OPTIONS.iter().map(|ticks| html! {
                            <option value={ticks.to_string()}></option>
                        })}
                    </datalist>
                </label>
                <button class="secondary-button" onclick={on_add_step}>{ "Add Column" }</button>
                <button class="secondary-button" onclick={on_remove_step}>{ "Remove Column" }</button>
                <button class="secondary-button" onclick={on_add_track}>{ "Add Instrument" }</button>

                <dl class="pattern-stats">
                    <div class="pattern-stat">
                        <dt>{ "Columns" }</dt>
                        <dd>{ grid.step_count() }</dd>
                    </div>
                    <div class="pattern-stat">
                        <dt>{ "Mini-ticks" }</dt>
                        <dd>{ grid.total_ticks() }</dd>
                    </div>
                    <div class="pattern-stat">
                        <dt>{ "Full beats" }</dt>
                        <dd>{ format_beats(grid.total_beats()) }</dd>
                    </div>
                </dl>
            </section>

            <section class="sequencer-card">
                <div class="sequencer-scroll">
                    <div class="sequencer-stack">
                        {
                            for visible_sections.iter().map(|&(start, end)| {
                                // Column widths follow each column's own spacing.
                                let section_delays: Vec<u8> = grid.steps[start..end]
                                    .iter()
                                    .map(|step| step.delay_ticks)
                                    .collect();

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
                                                    // Taken before the shadowing clone below, which the file
                                                    // picker closure consumes.
                                                    let audio_error_for_previews = audio_error.clone();
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

                                                    let track_instrument = track.instrument;
                                                    let track_note = track.note.clone();
                                                    let track_preset = track.sound_preset.clone();

                                                    // Play the track exactly as the grid would, sample included.
                                                    let audio_error_for_preview = audio_error_for_previews.clone();
                                                    let on_preview_track = {
                                                        let preset = track_preset.clone();
                                                        let note = track_note.clone();
                                                        Callback::from(move |_| {
                                                            let preset = preset.clone();
                                                            let note = note.clone();
                                                            let audio_error = audio_error_for_preview.clone();
                                                            spawn_local(async move {
                                                                match playback::preview_sound(
                                                                    Some(track_index),
                                                                    &preset,
                                                                    track_instrument,
                                                                    &note,
                                                                )
                                                                .await
                                                                {
                                                                    Ok(()) => audio_error.set(None),
                                                                    Err(error) => audio_error.set(Some(error)),
                                                                }
                                                            });
                                                        })
                                                    };

                                                    let preset_buttons = SOUND_PRESETS.iter().map(|(preset_id, preset_label)| {
                                                        let pattern_library = pattern_library.clone();
                                                        let preset_id = (*preset_id).to_string();
                                                        let preset_label = *preset_label;

                                                        let audition_preset = preset_id.clone();
                                                        let audition_note = track_note.clone();
                                                        let audio_error = audio_error_for_previews.clone();
                                                        // Audition without adopting the preset, so browsing the
                                                        // menu never overwrites the track's current sound.
                                                        let on_audition = Callback::from(move |event: MouseEvent| {
                                                            event.stop_propagation();
                                                            let preset = audition_preset.clone();
                                                            let note = audition_note.clone();
                                                            let audio_error = audio_error.clone();
                                                            spawn_local(async move {
                                                                match playback::preview_sound(
                                                                    None,
                                                                    &preset,
                                                                    track_instrument,
                                                                    &note,
                                                                )
                                                                .await
                                                                {
                                                                    Ok(()) => audio_error.set(None),
                                                                    Err(error) => audio_error.set(Some(error)),
                                                                }
                                                            });
                                                        });

                                                        let onclick = Callback::from(move |_| {
                                                            let mut next = (*pattern_library).clone();
                                                            next.current_pattern_mut().grid.set_track_sound_preset(track_index, preset_id.clone());
                                                            pattern_library.set(next);
                                                        });

                                                        html! {
                                                            <div class="sound-option-row">
                                                                <button type="button" class="sound-option" {onclick}>{ preset_label }</button>
                                                                <button
                                                                    type="button"
                                                                    class="preview-button is-inline"
                                                                    title={format!("Preview {preset_label}")}
                                                                    aria-label={format!("Preview {preset_label}")}
                                                                    onclick={on_audition}
                                                                >{ "▶" }</button>
                                                            </div>
                                                        }
                                                    });

                                                    html! {
                                                        <div class="label-row">
                                                            <div class="instrument-name">
                                                                <div class="instrument-title">
                                                                    <button
                                                                        type="button"
                                                                        class="preview-button"
                                                                        title="Preview this sound"
                                                                        aria-label={format!("Preview {}", &track.name)}
                                                                        onclick={on_preview_track}
                                                                    >{ "▶" }</button>
                                                                    <strong>{ &track.name }</strong>
                                                                </div>
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

                                        // Only the board scrolls sideways. Keeping the label
                                        // rail outside this container lets the sound menu
                                        // escape the clipping box, and pins the instrument
                                        // names while the grid moves.
                                        <div class="board-scroll">
                                        <div class="board-shell">
                                            <div class="board-header" style={board_columns_style(&section_delays)}>
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

                                                        let column_menu = column_menu.clone();
                                                        let is_open = column_menu
                                                            .as_ref()
                                                            .is_some_and(|menu| menu.step_index == step_index);
                                                        let on_menu_open = Callback::from(move |event: MouseEvent| {
                                                            event.stop_propagation();
                                                            // Anchor to the button so the menu tracks its
                                                            // column even after the board is scrolled.
                                                            let rect = event
                                                                .target_unchecked_into::<Element>()
                                                                .get_bounding_client_rect();

                                                            if column_menu
                                                                .as_ref()
                                                                .is_some_and(|menu| menu.step_index == step_index)
                                                            {
                                                                column_menu.set(None);
                                                            } else {
                                                                column_menu.set(Some(ColumnMenu {
                                                                    step_index,
                                                                    style: column_menu_style(&rect),
                                                                }));
                                                            }
                                                        });

                                                        html! {
                                                            <div class="delay-chip">
                                                                <label class="delay-value">
                                                                    <input type="number" min="1" max="32" value={step.delay_ticks.to_string()} oninput={oninput} />
                                                                </label>
                                                                <button
                                                                    type="button"
                                                                    class={classes!("column-menu-button", is_open.then_some("is-open"))}
                                                                    title="Column options"
                                                                    aria-label={format!("Options for column {}", step_index + 1)}
                                                                    aria-expanded={is_open.to_string()}
                                                                    onclick={on_menu_open}
                                                                >{ "⋯" }</button>
                                                            </div>
                                                        }
                                                    })
                                                }
                                            </div>

                                            <div class="board-grid" style={board_columns_style(&section_delays)}>
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
                                            if let Ok(value) = input.value().parse::<f64>() {
                                                let mut next = (*pattern_library_for_amplitude).clone();
                                                next.current_pattern_mut().grid.set_modulator_amplitude(modulator_id, value);
                                                pattern_library_for_amplitude.set(next);
                                            }
                                        });

                                        let pattern_library_for_wavelength = pattern_library.clone();
                                        let on_wavelength_input = Callback::from(move |event: InputEvent| {
                                            let input: HtmlInputElement = event.target_unchecked_into();
                                            if let Ok(value) = input.value().parse::<f64>() {
                                                let mut next = (*pattern_library_for_wavelength).clone();
                                                next.current_pattern_mut().grid.set_modulator_wavelength(modulator_id, value);
                                                pattern_library_for_wavelength.set(next);
                                            }
                                        });

                                        let pattern_library_for_phase = pattern_library.clone();
                                        let on_phase_input = Callback::from(move |event: InputEvent| {
                                            let input: HtmlInputElement = event.target_unchecked_into();
                                            if let Ok(value) = input.value().parse::<f64>() {
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
                                            <div class={classes!("modulator-item", modulator.muted.then_some("is-muted"))}>
                                                <label class="control-field modulator-field">
                                                    <span>{ "Function" }</span>
                                                    <select onchange={on_function_change}>
                                                        { for MODULATOR_FUNCTIONS.iter().map(|label| html! {
                                                            <option
                                                                value={*label}
                                                                selected={modulator.function.as_label() == *label}
                                                            >{ *label }</option>
                                                        })}
                                                    </select>
                                                </label>

                                                <label class="control-field modulator-field">
                                                    <span>{ "Amplitude" }</span>
                                                    <input type="number" min="-64" max="64" step="0.1" value={modulator.amplitude_ticks.to_string()} oninput={on_amplitude_input} />
                                                </label>

                                                <label class="control-field modulator-field">
                                                    <span>{ "Wavelength" }</span>
                                                    <input type="number" min="0.001" max="256" step="0.1" value={modulator.wavelength_ticks.to_string()} oninput={on_wavelength_input} />
                                                </label>

                                                <label class="control-field modulator-field">
                                                    <span>{ "Start Phase" }</span>
                                                    <input type="number" min="-360" max="360" step="0.1" value={modulator.phase_degrees.to_string()} oninput={on_phase_input} />
                                                </label>

                                                <label class="modulator-toggle">
                                                    <input type="checkbox" checked={modulator.restart_each_loop} onchange={on_restart_toggle} />
                                                    <span>{ "Restart at grid start" }</span>
                                                </label>

                                                { modulator_shape(modulator, grid.total_ticks() as f64, &column_ticks) }

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

            { column_menu_view }
        </main>
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticks_per_beat_accepts_floats_and_clamps() {
        assert_eq!(parse_ticks_per_beat("8"), Some(8.0));
        assert_eq!(parse_ticks_per_beat("7.5"), Some(7.5));
        assert_eq!(parse_ticks_per_beat("  6.25 "), Some(6.25));
        assert_eq!(parse_ticks_per_beat("100000"), Some(MAX_TICKS_PER_BEAT));
        assert_eq!(parse_ticks_per_beat("0.0001"), Some(MIN_TICKS_PER_BEAT));
    }

    #[test]
    fn ticks_per_beat_rejects_entries_that_are_not_usable_numbers() {
        for text in ["", "  ", "-", "-4", "0", "abc", "NaN", "inf"] {
            assert_eq!(parse_ticks_per_beat(text), None, "should reject {text:?}");
        }
    }

    #[test]
    fn ticks_per_beat_accepts_a_trailing_decimal_point() {
        // "7." is a stage of typing "7.5". It commits 7.0 while the draft text
        // keeps the point visible, so the decimals can still be entered.
        assert_eq!(parse_ticks_per_beat("7."), Some(7.0));
    }

    #[test]
    fn ticks_per_beat_displays_without_a_trailing_zero() {
        assert_eq!(format_ticks_per_beat(8.0), "8");
        assert_eq!(format_ticks_per_beat(7.5), "7.5");
        assert_eq!(format_ticks_per_beat(6.25), "6.25");
    }

    #[test]
    fn beats_format_trims_trailing_zeros() {
        assert_eq!(format_beats(5.0), "5");
        assert_eq!(format_beats(4.875), "4.88");
        assert_eq!(format_beats(4.5), "4.5");
    }
}
