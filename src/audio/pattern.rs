use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Clone, Copy, PartialEq, Eq)]
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

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Step {
    pub delay_ticks: u8,
}

impl Step {
    pub fn new(delay_ticks: u8) -> Self {
        Self { delay_ticks }
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

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BeatModulator {
    pub id: u64,
    pub function: BeatModulatorFunction,
    pub amplitude_ticks: i16,
    pub wavelength_ticks: u16,
    pub phase_degrees: i16,
    pub muted: bool,
    pub restart_each_loop: bool,
}

impl BeatModulator {
    pub fn new(id: u64) -> Self {
        Self {
            id,
            function: BeatModulatorFunction::Sin,
            amplitude_ticks: 2,
            wavelength_ticks: 16,
            phase_degrees: 0,
            muted: false,
            restart_each_loop: true,
        }
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
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
            step.delay_ticks = delay_ticks.max(1);
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

    pub fn set_modulator_amplitude(&mut self, id: u64, amplitude_ticks: i16) {
        if let Some(modulator) = self.modulators.iter_mut().find(|modulator| modulator.id == id) {
            modulator.amplitude_ticks = amplitude_ticks.clamp(-64, 64);
        }
    }

    pub fn set_modulator_wavelength(&mut self, id: u64, wavelength_ticks: u16) {
        if let Some(modulator) = self.modulators.iter_mut().find(|modulator| modulator.id == id) {
            modulator.wavelength_ticks = wavelength_ticks.max(1);
        }
    }

    pub fn set_modulator_phase(&mut self, id: u64, phase_degrees: i16) {
        if let Some(modulator) = self.modulators.iter_mut().find(|modulator| modulator.id == id) {
            modulator.phase_degrees = phase_degrees.clamp(-360, 360);
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
