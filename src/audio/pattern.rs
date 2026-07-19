use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoteVelocity {
    Off,
    Soft,
    Medium,
    Hard,
}

impl NoteVelocity {
    pub fn next(self) -> Self {
        match self {
            Self::Off => Self::Soft,
            Self::Soft => Self::Medium,
            Self::Medium => Self::Hard,
            Self::Hard => Self::Off,
        }
    }

    pub fn as_u8(self) -> u8 {
        match self {
            Self::Off => 0,
            Self::Soft => 1,
            Self::Medium => 2,
            Self::Hard => 3,
        }
    }

    pub fn css_class(self) -> Option<&'static str> {
        match self {
            Self::Off => None,
            Self::Soft => Some("is-soft"),
            Self::Medium => Some("is-medium"),
            Self::Hard => Some("is-hard"),
        }
    }
}

impl Serialize for NoteVelocity {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_u8(self.as_u8())
    }
}

impl<'de> Deserialize<'de> for NoteVelocity {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct NoteVelocityVisitor;

        impl<'de> serde::de::Visitor<'de> for NoteVelocityVisitor {
            type Value = NoteVelocity;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a bool or an integer note velocity between 0 and 3")
            }

            fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                Ok(if value {
                    NoteVelocity::Hard
                } else {
                    NoteVelocity::Off
                })
            }

            fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                match value {
                    0 => Ok(NoteVelocity::Off),
                    1 => Ok(NoteVelocity::Soft),
                    2 => Ok(NoteVelocity::Medium),
                    3 => Ok(NoteVelocity::Hard),
                    _ => Err(E::custom("note velocity must be between 0 and 3")),
                }
            }
        }

        deserializer.deserialize_any(NoteVelocityVisitor)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum InstrumentKind {
    Click,
    Accent,
    Low,
}

impl InstrumentKind {
    pub fn as_label(self) -> &'static str {
        match self {
            Self::Click => "Click",
            Self::Accent => "Accent",
            Self::Low => "Low",
        }
    }
}

/// A step must advance the transport by at least one tick. A zero here stalls
/// the worklet's scheduling loop, so it is clamped at every entry point.
pub const MIN_DELAY_TICKS: u8 = 1;
pub const DEFAULT_DELAY_TICKS: u8 = 8;
pub const MIN_BPM: u16 = 30;
pub const MAX_BPM: u16 = 280;
pub const MIN_TICKS_PER_BEAT: u8 = 1;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Step {
    pub delay_ticks: u8,
}

impl Step {
    pub fn new(delay_ticks: u8) -> Self {
        Self {
            delay_ticks: delay_ticks.max(MIN_DELAY_TICKS),
        }
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Track {
    pub name: String,
    pub instrument: InstrumentKind,
    #[serde(default = "default_note")]
    pub note: String,
    #[serde(default = "default_sound_preset")]
    pub sound_preset: String,
    #[serde(default, skip_serializing)]
    pub sample_name: Option<String>,
    #[serde(default)]
    pub sample_download_url: Option<String>,
    #[serde(default)]
    pub sample_storage_path: Option<String>,
    #[serde(alias = "enabled_steps")]
    pub step_velocities: Vec<NoteVelocity>,
}

impl Track {
    pub fn new(name: impl Into<String>, instrument: InstrumentKind, step_count: usize) -> Self {
        Self {
            name: name.into(),
            instrument,
            note: default_note(),
            sound_preset: default_sound_preset(),
            sample_name: None,
            sample_download_url: None,
            sample_storage_path: None,
            step_velocities: vec![NoteVelocity::Off; step_count],
        }
    }

    pub fn resize(&mut self, step_count: usize) {
        self.step_velocities.resize(step_count, NoteVelocity::Off);
    }
}

fn default_note() -> String {
    "C4".into()
}

fn default_sound_preset() -> String {
    "metronome".into()
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BeatModulatorFunction {
    Sin,
    Cos,
    Raise,
    Drop,
    Rnd,
}

impl BeatModulatorFunction {
    pub fn as_label(self) -> &'static str {
        match self {
            Self::Sin => "Sin",
            Self::Cos => "Cos",
            Self::Raise => "Raise",
            Self::Drop => "Drop",
            Self::Rnd => "Rnd",
        }
    }
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct BeatModulator {
    pub id: u64,
    pub function: BeatModulatorFunction,
    pub amplitude_ticks: f64,
    pub wavelength_ticks: f64,
    pub phase_degrees: f64,
    pub muted: bool,
    pub restart_each_loop: bool,
}

impl BeatModulator {
    pub fn new(id: u64) -> Self {
        Self {
            id,
            function: BeatModulatorFunction::Sin,
            amplitude_ticks: 2.0,
            wavelength_ticks: 16.0,
            phase_degrees: 0.0,
            muted: false,
            restart_each_loop: true,
        }
    }
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct RhythmGrid {
    pub title: String,
    pub bpm: u16,
    pub ticks_per_beat: u8,
    pub steps: Vec<Step>,
    pub tracks: Vec<Track>,
    #[serde(default)]
    pub modulators: Vec<BeatModulator>,
}

impl RhythmGrid {
    pub fn blank(title: impl Into<String>) -> Self {
        let steps = vec![Step::new(8); 8];
        let step_count = steps.len();

        Self {
            title: title.into(),
            bpm: 108,
            ticks_per_beat: 8,
            steps,
            tracks: vec![default_track("Pulse", InstrumentKind::Click, step_count), default_track("Accent", InstrumentKind::Accent, step_count)],
            modulators: Vec::new(),
        }
    }

    pub fn demo() -> Self {
        let steps = vec![
            Step::new(8),
            Step::new(5),
            Step::new(7),
            Step::new(8),
            Step::new(4),
            Step::new(8),
        ];

        let step_count = steps.len();
        let mut pulse = default_track("Pulse", InstrumentKind::Click, step_count);
        let mut accent = default_track("Accent", InstrumentKind::Accent, step_count);

        for idx in 0..step_count {
            pulse.step_velocities[idx] = NoteVelocity::Hard;
        }

        accent.step_velocities[0] = NoteVelocity::Medium;
        accent.step_velocities[3] = NoteVelocity::Medium;

        Self {
            title: "Värmland Groove".into(),
            bpm: 108,
            ticks_per_beat: 8,
            steps,
            tracks: vec![pulse, accent],
            modulators: Vec::new(),
        }
    }

    /// Force a grid into a shape the audio worklet can safely play.
    ///
    /// `Step::new` and the editor callbacks both clamp their inputs, but
    /// `Deserialize` bypasses them entirely — so every grid that arrives from
    /// localStorage, and later from Firestore, must pass through here before it
    /// reaches the transport.
    pub fn sanitize(&mut self) {
        self.bpm = self.bpm.clamp(MIN_BPM, MAX_BPM);
        self.ticks_per_beat = self.ticks_per_beat.max(MIN_TICKS_PER_BEAT);

        if self.steps.is_empty() {
            self.steps.push(Step::new(DEFAULT_DELAY_TICKS));
        }

        for step in &mut self.steps {
            step.delay_ticks = step.delay_ticks.max(MIN_DELAY_TICKS);
        }

        // A track whose velocity count disagrees with the step count leaves the
        // grid renderer and the scheduler reading different lengths.
        let step_count = self.steps.len();
        for track in &mut self.tracks {
            track.resize(step_count);
        }
    }

    pub fn step_count(&self) -> usize {
        self.steps.len()
    }

    pub fn add_step(&mut self, delay_ticks: u8) {
        self.steps.push(Step::new(delay_ticks));
        let new_len = self.steps.len();
        for track in &mut self.tracks {
            track.resize(new_len);
        }
    }

    /// Insert an empty column at `index`, carrying the neighbour's spacing so
    /// the groove keeps its feel until the new column is edited.
    pub fn insert_step(&mut self, index: usize, neighbour: usize) {
        let index = index.min(self.steps.len());
        let delay_ticks = self
            .steps
            .get(neighbour)
            .map_or(DEFAULT_DELAY_TICKS, |step| step.delay_ticks);

        self.steps.insert(index, Step::new(delay_ticks));
        for track in &mut self.tracks {
            let at = index.min(track.step_velocities.len());
            track.step_velocities.insert(at, NoteVelocity::Off);
        }
    }

    /// Copy column `source` -- spacing and every track's hit -- to `index`.
    pub fn duplicate_step(&mut self, source: usize, index: usize) {
        let Some(step) = self.steps.get(source).cloned() else {
            return;
        };

        let index = index.min(self.steps.len());
        self.steps.insert(index, step);
        for track in &mut self.tracks {
            let velocity = track
                .step_velocities
                .get(source)
                .copied()
                .unwrap_or(NoteVelocity::Off);
            let at = index.min(track.step_velocities.len());
            track.step_velocities.insert(at, velocity);
        }
    }

    /// Remove column `index`. The last remaining column is kept, since a
    /// pattern with no steps cannot be played.
    pub fn remove_step(&mut self, index: usize) {
        if self.steps.len() <= 1 || index >= self.steps.len() {
            return;
        }

        self.steps.remove(index);
        for track in &mut self.tracks {
            if index < track.step_velocities.len() {
                track.step_velocities.remove(index);
            }
        }
    }

    pub fn remove_last_step(&mut self) {
        if self.steps.len() <= 1 {
            return;
        }

        self.steps.pop();
        let new_len = self.steps.len();
        for track in &mut self.tracks {
            track.resize(new_len);
        }
    }

    pub fn set_step_delay(&mut self, index: usize, delay_ticks: u8) {
        if let Some(step) = self.steps.get_mut(index) {
            step.delay_ticks = delay_ticks.max(MIN_DELAY_TICKS);
        }
    }

    pub fn cycle_cell(&mut self, track_index: usize, step_index: usize) {
        if let Some(track) = self.tracks.get_mut(track_index) {
            if let Some(cell) = track.step_velocities.get_mut(step_index) {
                *cell = cell.next();
            }
        }
    }

    pub fn add_track(&mut self, name: impl Into<String>, instrument: InstrumentKind) {
        self.tracks
            .push(default_track(name, instrument, self.step_count()));
    }

    pub fn set_track_note(&mut self, track_index: usize, note: String) {
        if let Some(track) = self.tracks.get_mut(track_index) {
            track.note = note;
        }
    }

    pub fn set_track_sound_preset(&mut self, track_index: usize, sound_preset: String) {
        if let Some(track) = self.tracks.get_mut(track_index) {
            track.sound_preset = sound_preset;
            track.sample_name = None;
            track.sample_download_url = None;
            track.sample_storage_path = None;
        }
    }

    pub fn set_track_sample_source(
        &mut self,
        track_index: usize,
        sample_name: Option<String>,
        sample_download_url: Option<String>,
        sample_storage_path: Option<String>,
    ) {
        if let Some(track) = self.tracks.get_mut(track_index) {
            track.sample_name = sample_name;
            track.sample_download_url = sample_download_url;
            track.sample_storage_path = sample_storage_path;
        }
    }

    pub fn add_modulator(&mut self, id: u64) {
        self.modulators.push(BeatModulator::new(id));
    }

    pub fn remove_modulator(&mut self, id: u64) {
        self.modulators.retain(|modulator| modulator.id != id);
    }

    pub fn duplicate_modulator(&mut self, id: u64, new_id: u64) {
        if let Some(existing) = self.modulators.iter().find(|modulator| modulator.id == id) {
            let mut duplicated = existing.clone();
            duplicated.id = new_id;
            self.modulators.push(duplicated);
        }
    }

    pub fn set_modulator_function(
        &mut self,
        id: u64,
        function: BeatModulatorFunction,
    ) {
        if let Some(modulator) = self.modulators.iter_mut().find(|modulator| modulator.id == id) {
            modulator.function = function;
        }
    }

    pub fn set_modulator_amplitude(&mut self, id: u64, amplitude_ticks: f64) {
        if let Some(modulator) = self.modulators.iter_mut().find(|modulator| modulator.id == id) {
            modulator.amplitude_ticks = amplitude_ticks.clamp(-64.0, 64.0);
        }
    }

    pub fn set_modulator_wavelength(&mut self, id: u64, wavelength_ticks: f64) {
        if let Some(modulator) = self.modulators.iter_mut().find(|modulator| modulator.id == id) {
            modulator.wavelength_ticks = wavelength_ticks.max(0.001);
        }
    }

    pub fn set_modulator_phase(&mut self, id: u64, phase_degrees: f64) {
        if let Some(modulator) = self.modulators.iter_mut().find(|modulator| modulator.id == id) {
            modulator.phase_degrees = phase_degrees.clamp(-360.0, 360.0);
        }
    }

    pub fn set_modulator_muted(&mut self, id: u64, muted: bool) {
        if let Some(modulator) = self.modulators.iter_mut().find(|modulator| modulator.id == id) {
            modulator.muted = muted;
        }
    }

    pub fn set_modulator_restart(&mut self, id: u64, restart_each_loop: bool) {
        if let Some(modulator) = self.modulators.iter_mut().find(|modulator| modulator.id == id) {
            modulator.restart_each_loop = restart_each_loop;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid_from_json(json: &str) -> RhythmGrid {
        serde_json::from_str(json).expect("fixture should deserialize")
    }

    #[test]
    fn step_new_clamps_zero_delay() {
        assert_eq!(Step::new(0).delay_ticks, MIN_DELAY_TICKS);
        assert_eq!(Step::new(5).delay_ticks, 5);
    }

    #[test]
    fn deserialization_preserves_zero_delay_until_sanitized() {
        // This is the reason sanitize() has to exist: serde bypasses Step::new.
        let mut grid = grid_from_json(
            r#"{"title":"t","bpm":108,"ticks_per_beat":8,
                "steps":[{"delay_ticks":8},{"delay_ticks":0}],"tracks":[]}"#,
        );
        assert_eq!(grid.steps[1].delay_ticks, 0);

        grid.sanitize();
        assert_eq!(grid.steps[1].delay_ticks, MIN_DELAY_TICKS);
    }

    #[test]
    fn sanitize_clamps_tempo_fields() {
        let mut grid = grid_from_json(
            r#"{"title":"t","bpm":0,"ticks_per_beat":0,
                "steps":[{"delay_ticks":8}],"tracks":[]}"#,
        );
        grid.sanitize();

        assert_eq!(grid.bpm, MIN_BPM);
        assert_eq!(grid.ticks_per_beat, MIN_TICKS_PER_BEAT);

        let mut fast = grid_from_json(
            r#"{"title":"t","bpm":65535,"ticks_per_beat":8,
                "steps":[{"delay_ticks":8}],"tracks":[]}"#,
        );
        fast.sanitize();
        assert_eq!(fast.bpm, MAX_BPM);
    }

    #[test]
    fn sanitize_fills_empty_step_list() {
        let mut grid = grid_from_json(
            r#"{"title":"t","bpm":108,"ticks_per_beat":8,"steps":[],"tracks":[]}"#,
        );
        grid.sanitize();

        assert_eq!(grid.steps.len(), 1);
        assert_eq!(grid.steps[0].delay_ticks, DEFAULT_DELAY_TICKS);
    }

    #[test]
    fn sanitize_aligns_track_length_with_steps() {
        let mut grid = grid_from_json(
            r#"{"title":"t","bpm":108,"ticks_per_beat":8,
                "steps":[{"delay_ticks":8},{"delay_ticks":8},{"delay_ticks":8}],
                "tracks":[
                  {"name":"short","instrument":"Click","step_velocities":[3]},
                  {"name":"long","instrument":"Click","step_velocities":[3,3,3,3,3]}
                ]}"#,
        );
        grid.sanitize();

        assert_eq!(grid.tracks[0].step_velocities.len(), 3);
        assert_eq!(grid.tracks[1].step_velocities.len(), 3);
        // Padding is silent, and truncation keeps the surviving hits.
        assert_eq!(grid.tracks[0].step_velocities[2], NoteVelocity::Off);
        assert_eq!(grid.tracks[1].step_velocities[2], NoteVelocity::Hard);
    }

    fn grid_with_columns() -> RhythmGrid {
        let mut grid = RhythmGrid::demo();
        grid.tracks[0].step_velocities = vec![
            NoteVelocity::Hard,
            NoteVelocity::Soft,
            NoteVelocity::Off,
            NoteVelocity::Medium,
            NoteVelocity::Off,
            NoteVelocity::Hard,
        ];
        grid
    }

    #[test]
    fn insert_step_adds_an_empty_column_and_keeps_tracks_in_step() {
        let mut grid = grid_with_columns();
        let before = grid.steps.len();

        // "Add to right" of column 1.
        grid.insert_step(2, 1);

        assert_eq!(grid.steps.len(), before + 1);
        assert_eq!(grid.steps[2].delay_ticks, grid.steps[1].delay_ticks);
        assert_eq!(grid.tracks[0].step_velocities[2], NoteVelocity::Off);
        // The column that was at 2 shifted right, not overwritten.
        assert_eq!(grid.tracks[0].step_velocities[3], NoteVelocity::Off);
        for track in &grid.tracks {
            assert_eq!(track.step_velocities.len(), grid.steps.len());
        }
    }

    #[test]
    fn duplicate_step_copies_spacing_and_hits() {
        let mut grid = grid_with_columns();
        let source_delay = grid.steps[1].delay_ticks;

        // "Duplicate to left" of column 1.
        grid.duplicate_step(1, 1);

        assert_eq!(grid.steps[1].delay_ticks, source_delay);
        assert_eq!(grid.steps[2].delay_ticks, source_delay);
        assert_eq!(grid.tracks[0].step_velocities[1], NoteVelocity::Soft);
        assert_eq!(grid.tracks[0].step_velocities[2], NoteVelocity::Soft);
        for track in &grid.tracks {
            assert_eq!(track.step_velocities.len(), grid.steps.len());
        }
    }

    #[test]
    fn duplicate_step_to_the_right_lands_after_the_source() {
        let mut grid = grid_with_columns();
        grid.duplicate_step(0, 1);

        assert_eq!(grid.tracks[0].step_velocities[0], NoteVelocity::Hard);
        assert_eq!(grid.tracks[0].step_velocities[1], NoteVelocity::Hard);
        assert_eq!(grid.tracks[0].step_velocities[2], NoteVelocity::Soft);
    }

    #[test]
    fn remove_step_drops_the_column_from_every_track() {
        let mut grid = grid_with_columns();
        let before = grid.steps.len();

        grid.remove_step(1);

        assert_eq!(grid.steps.len(), before - 1);
        assert_eq!(grid.tracks[0].step_velocities[1], NoteVelocity::Off);
        for track in &grid.tracks {
            assert_eq!(track.step_velocities.len(), grid.steps.len());
        }
    }

    #[test]
    fn remove_step_keeps_the_last_column() {
        let mut grid = grid_with_columns();
        while grid.steps.len() > 1 {
            grid.remove_step(0);
        }

        grid.remove_step(0);
        assert_eq!(grid.steps.len(), 1);
    }

    #[test]
    fn column_edits_ignore_out_of_range_indices() {
        let mut grid = grid_with_columns();
        let before = grid.clone();

        grid.remove_step(99);
        grid.duplicate_step(99, 0);
        assert!(grid == before);

        // An insert past the end clamps rather than panicking.
        grid.insert_step(99, 99);
        assert_eq!(grid.steps.len(), before.steps.len() + 1);
    }

    #[test]
    fn pattern_file_round_trips() {
        let grid = RhythmGrid::demo();
        let json = PatternFile::new(vec![grid.clone()]).to_json().unwrap();
        let back = PatternFile::from_json(&json).unwrap();

        assert_eq!(back.len(), 1);
        assert!(back[0] == grid);
    }

    #[test]
    fn pattern_file_accepts_a_bare_grid() {
        let grid = RhythmGrid::demo();
        let json = serde_json::to_string(&grid).unwrap();
        let back = PatternFile::from_json(&json).unwrap();

        assert_eq!(back.len(), 1);
        assert_eq!(back[0].title, grid.title);
    }

    #[test]
    fn pattern_file_sanitizes_imported_grids() {
        // A zero delay would stall the worklet, so import must not pass it through.
        let json = r#"{"format":"fluidmetronome.patterns","version":1,"patterns":[
            {"title":"bad","bpm":0,"ticks_per_beat":0,
             "steps":[{"delay_ticks":0}],"tracks":[]}]}"#;

        let back = PatternFile::from_json(json).unwrap();
        assert_eq!(back[0].steps[0].delay_ticks, MIN_DELAY_TICKS);
        assert_eq!(back[0].bpm, MIN_BPM);
        assert_eq!(back[0].ticks_per_beat, MIN_TICKS_PER_BEAT);
    }

    #[test]
    fn pattern_file_rejects_foreign_and_newer_files() {
        let foreign = r#"{"format":"something.else","version":1,"patterns":[]}"#;
        assert!(PatternFile::from_json(foreign).is_err());

        let newer = format!(
            r#"{{"format":"{PATTERN_FILE_FORMAT}","version":{},"patterns":[]}}"#,
            PATTERN_FILE_VERSION + 1
        );
        assert!(PatternFile::from_json(&newer).is_err());

        assert!(PatternFile::from_json("not json at all").is_err());
        assert!(PatternFile::from_json(
            r#"{"format":"fluidmetronome.patterns","version":1,"patterns":[]}"#
        )
        .is_err());
    }

    #[test]
    fn title_slug_is_filename_safe() {
        assert_eq!(title_slug("Värmland Groove"), "varmland-groove");
        assert_eq!(title_slug("Slängpolska på Öland"), "slangpolska-pa-oland");
        assert_eq!(title_slug("Polska  /  16"), "polska-16");
        assert_eq!(title_slug("   "), "pattern");
        assert_eq!(title_slug("Already-Fine"), "already-fine");
    }

    #[test]
    fn sanitize_leaves_a_healthy_grid_untouched() {
        let mut grid = RhythmGrid::demo();
        let before = grid.clone();
        grid.sanitize();
        assert!(grid == before);
    }
}

pub const PATTERN_FILE_FORMAT: &str = "fluidmetronome.patterns";
pub const PATTERN_FILE_VERSION: u32 = 1;

/// On-disk envelope for exported patterns.
///
/// Versioned from the start so a later format change can still read these, and
/// a list rather than a single grid so "export everything" needs no new format.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct PatternFile {
    pub format: String,
    pub version: u32,
    pub patterns: Vec<RhythmGrid>,
}

impl PatternFile {
    pub fn new(patterns: Vec<RhythmGrid>) -> Self {
        Self {
            format: PATTERN_FILE_FORMAT.into(),
            version: PATTERN_FILE_VERSION,
            patterns,
        }
    }

    pub fn to_json(&self) -> Result<String, String> {
        serde_json::to_string_pretty(self).map_err(|error| error.to_string())
    }

    /// Read an exported file, tolerating a bare grid so a hand-written or
    /// hand-edited pattern still imports.
    ///
    /// Every grid is sanitised here: this is untrusted input arriving from
    /// outside the editor's clamps, exactly like localStorage and Firestore.
    pub fn from_json(payload: &str) -> Result<Vec<RhythmGrid>, String> {
        let mut patterns = if let Ok(file) = serde_json::from_str::<PatternFile>(payload) {
            if file.format != PATTERN_FILE_FORMAT {
                return Err(format!("Not a Fluid Metronome pattern file ({}).", file.format));
            }

            if file.version > PATTERN_FILE_VERSION {
                return Err(format!(
                    "This file was written by a newer version (format v{}, this build reads v{PATTERN_FILE_VERSION}).",
                    file.version
                ));
            }

            file.patterns
        } else if let Ok(grid) = serde_json::from_str::<RhythmGrid>(payload) {
            vec![grid]
        } else {
            return Err("Could not read this file as a pattern.".into());
        };

        if patterns.is_empty() {
            return Err("That file contains no patterns.".into());
        }

        for grid in &mut patterns {
            grid.sanitize();
        }

        Ok(patterns)
    }
}

/// Filename-safe form of a pattern title, e.g. "Värmland Groove" -> "varmland-groove".
///
/// Accented letters are transliterated rather than dropped -- titles in this app
/// are routinely Swedish, and "v-rmland" would be a poor filename.
pub fn title_slug(title: &str) -> String {
    let mut slug = String::with_capacity(title.len());
    let mut pending_dash = false;

    let push = |slug: &mut String, text: &str, pending: &mut bool| {
        if *pending && !slug.is_empty() {
            slug.push('-');
        }
        *pending = false;
        slug.push_str(text);
    };

    for raw in title.chars().flat_map(|ch| ch.to_lowercase()) {
        let mapped = match raw {
            'a'..='z' | '0'..='9' => Some(raw.to_string()),
            'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' => Some("a".into()),
            'è' | 'é' | 'ê' | 'ë' => Some("e".into()),
            'ì' | 'í' | 'î' | 'ï' => Some("i".into()),
            'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' => Some("o".into()),
            'ù' | 'ú' | 'û' | 'ü' => Some("u".into()),
            'ý' | 'ÿ' => Some("y".into()),
            'ñ' => Some("n".into()),
            'ç' => Some("c".into()),
            'æ' => Some("ae".into()),
            'ß' => Some("ss".into()),
            _ => None,
        };

        match mapped {
            Some(text) => push(&mut slug, &text, &mut pending_dash),
            None => pending_dash = true,
        }
    }

    if slug.is_empty() {
        "pattern".into()
    } else {
        slug
    }
}

fn default_track(name: impl Into<String>, instrument: InstrumentKind, step_count: usize) -> Track {
    let mut track = Track::new(name, instrument, step_count);
    track.note = match instrument {
        InstrumentKind::Click => "C4",
        InstrumentKind::Accent => "D4",
        InstrumentKind::Low => "E3",
    }
    .into();
    track.sound_preset = match instrument {
        InstrumentKind::Click => "metronome",
        InstrumentKind::Accent => "bright-click",
        InstrumentKind::Low => "thump",
    }
    .into();
    track
}
