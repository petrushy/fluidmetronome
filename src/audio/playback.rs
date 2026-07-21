use crate::audio::pattern::{InstrumentKind, RhythmGrid};
use js_sys::Promise;
use serde::Deserialize;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;
use web_sys::File;

#[derive(Clone, PartialEq, Eq, Deserialize)]
pub enum TimingHealth {
    #[serde(rename = "idle")]
    Idle,
    #[serde(rename = "unknown")]
    Unknown,
    #[serde(rename = "tight")]
    Tight,
    #[serde(rename = "late")]
    Late,
}

#[derive(Clone, PartialEq, Deserialize)]
pub struct TimingStatus {
    pub state: TimingHealth,
    pub latest_lead_ms: Option<f64>,
    pub worst_lead_ms: Option<f64>,
    pub late_hits: u32,
    pub checked_at_ms: f64,
}

impl Default for TimingStatus {
    fn default() -> Self {
        Self {
            state: TimingHealth::Idle,
            latest_lead_ms: None,
            worst_lead_ms: None,
            late_hits: 0,
            checked_at_ms: 0.0,
        }
    }
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = window, js_name = fluidMetronomeStart)]
    fn fluid_metronome_start(pattern_json: &str) -> bool;

    #[wasm_bindgen(js_namespace = window, js_name = fluidMetronomeStop)]
    fn fluid_metronome_stop();

    #[wasm_bindgen(js_namespace = window, js_name = fluidMetronomeSetPattern)]
    fn fluid_metronome_set_pattern(pattern_json: &str);

    #[wasm_bindgen(js_namespace = window, js_name = fluidMetronomeLoadTrackSample)]
    fn fluid_metronome_load_track_sample(track_index: u32, file: JsValue) -> Promise;

    #[wasm_bindgen(js_namespace = window, js_name = fluidMetronomePreviewSound)]
    fn fluid_metronome_preview_sound(
        track_index: i32,
        preset: &str,
        instrument: &str,
        note: &str,
    ) -> Promise;

    #[wasm_bindgen(js_namespace = window, js_name = fluidMetronomeGetTimingStatus)]
    fn fluid_metronome_get_timing_status() -> String;
}

/// Audition one sound without running the transport.
///
/// Pass `None` for `track_index` to preview a preset that is not yet assigned
/// to a track; otherwise the track's loaded sample takes precedence, matching
/// what the grid would actually play.
pub async fn preview_sound(
    track_index: Option<usize>,
    preset: &str,
    instrument: InstrumentKind,
    note: &str,
) -> Result<(), String> {
    let index = track_index.map_or(-1, |value| value as i32);

    JsFuture::from(fluid_metronome_preview_sound(
        index,
        preset,
        instrument.as_label(),
        note,
    ))
    .await
    .map(|_| ())
    .map_err(|error| {
        error
            .as_string()
            .unwrap_or_else(|| "Could not play this sound.".into())
    })
}

pub fn sync_pattern(grid: &RhythmGrid) -> Result<(), String> {
    let payload = serde_json::to_string(grid).map_err(|err| err.to_string())?;
    fluid_metronome_set_pattern(&payload);
    Ok(())
}

pub fn start(grid: &RhythmGrid) -> Result<bool, String> {
    let payload = serde_json::to_string(grid).map_err(|err| err.to_string())?;
    Ok(fluid_metronome_start(&payload))
}

pub fn stop() {
    fluid_metronome_stop();
}

pub fn timing_status() -> Result<TimingStatus, String> {
    let payload = fluid_metronome_get_timing_status();
    serde_json::from_str(&payload).map_err(|err| err.to_string())
}

pub async fn load_track_sample(track_index: usize, file: File) -> Result<(), String> {
    JsFuture::from(fluid_metronome_load_track_sample(
        track_index as u32,
        file.into(),
    ))
    .await
    .map(|_| ())
    .map_err(|error| {
        error
            .as_string()
            .unwrap_or_else(|| "Failed to decode sample file.".into())
    })
}
