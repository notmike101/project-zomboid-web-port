use jiff::tz::TimeZone;
use std::cell::RefCell;

use crate::{BAD_FORMAT, NONFINITE, OK, OUT_OF_RANGE, UNSUPPORTED};

#[path = "weather_math.rs"]
mod math;
use math::{
    CaRandom, JavaRandom, SeasonDay, WeatherMathSeason, calendar_add_days, calendar_at,
    calendar_date, calendar_minutes_between, climate_offsets, simplex_noise, supports_year,
};

#[derive(Clone, Copy)]
pub(crate) struct ClockSample {
    pub world_age_hours: f64,
    pub time_of_day: f32,
    pub year: i32,
    pub month: i32,
    pub day: i32,
    pub minute_stamp: i64,
}

fn lerp(t: f32, a: f32, b: f32) -> f32 {
    a + t * (b - a)
}
fn clerp(t: f32, a: f32, b: f32) -> f32 {
    let weight = (1.0 - ((t as f64) * std::f64::consts::PI).cos()) as f32 / 2.0;
    a * (1.0 - weight) + b * weight
}
fn source_hour(time: f32) -> i32 {
    (((time * 3600.0) as f64).floor() / 3600.0).floor() as i32
}

#[derive(Default)]
struct ClimateFloat {
    internal: f32,
    final_value: f32,
    override_value: Option<(f32, f32)>,
    override_internal: Option<f32>,
    modded: Option<(f32, f32)>,
    admin: Option<f32>,
}
impl ClimateFloat {
    fn finalize(&mut self) -> f32 {
        self.final_value = if let Some(value) = self.admin {
            value
        } else {
            if let Some((value, t)) = self.modded
                && t > 0.0
            {
                self.internal = lerp(t, self.internal, value);
            }
            match self.override_value {
                Some((value, t)) if t > 0.0 => {
                    lerp(t, self.override_internal.unwrap_or(self.internal), value)
                }
                _ => self.internal,
            }
        };
        self.final_value
    }
}
#[derive(Default)]
struct ClimateBool {
    internal: bool,
    final_value: bool,
    overridden: Option<bool>,
    modded: Option<bool>,
    admin: Option<bool>,
}
impl ClimateBool {
    fn finalize(&mut self) -> bool {
        self.final_value = self
            .admin
            .or(self.modded)
            .or(self.overridden)
            .unwrap_or(self.internal);
        self.final_value
    }
}

#[derive(Clone, Copy)]
struct Front {
    kind: i32,
    days: f32,
    max: f32,
    total: f32,
    strength: f32,
    wind: f32,
    cache: [f32; 2],
}
impl Front {
    const fn new() -> Self {
        Self {
            kind: 0,
            days: 0.0,
            max: 0.0,
            total: 0.0,
            strength: 0.0,
            wind: 0.0,
            cache: [-1.0; 2],
        }
    }
    fn change(&mut self, kind: i32) {
        *self = Self {
            kind,
            ..Self::new()
        };
    }
    fn sample(&mut self, noise: f32) {
        self.days += 1.0;
        if (self.kind == 1 && noise <= 0.0) || (self.kind == -1 && noise >= 0.0) {
            self.strength = 0.0;
            return;
        }
        let value = noise.abs();
        self.max = self.max.max(value);
        self.total += value;
        let recent = self.cache[0].max(self.cache[1]).max(value).max(0.0);
        self.cache[1] = self.cache[0];
        self.cache[0] = value;
        self.strength = recent * 0.75 + self.max * 0.25;
    }
}

#[derive(Clone, Copy, PartialEq)]
#[repr(u8)]
enum Lerp {
    None,
    Entry,
    Target,
    Next,
}
impl Lerp {
    fn from_byte(value: u8) -> Result<Self, i32> {
        match value {
            0 => Ok(Self::None),
            1 => Ok(Self::Entry),
            2 => Ok(Self::Target),
            3 => Ok(Self::Next),
            _ => Err(BAD_FORMAT),
        }
    }
}
#[derive(Clone, Copy)]
struct Stage {
    id: u8,
    start: f64,
    duration: f64,
    entry: f32,
    exit: f32,
    target: f32,
    mid: Lerp,
    end: Lerp,
    fog: f32,
    cloud_started: bool,
}
impl Stage {
    const EMPTY: Self = Self {
        id: 0,
        start: 0.0,
        duration: 1.0,
        entry: 0.0,
        exit: 0.0,
        target: 0.0,
        mid: Lerp::None,
        end: Lerp::None,
        fog: 0.0,
        cloud_started: false,
    };
    fn plain(id: u8, duration: f64, target: f32, mid: Lerp, end: Lerp) -> Self {
        Self {
            id,
            duration: duration.max(1.0),
            target,
            mid,
            end,
            ..Self::EMPTY
        }
    }
    fn value(&self, choice: Lerp, next: f32) -> f32 {
        match choice {
            Lerp::None => 0.0,
            Lerp::Entry => self.entry,
            Lerp::Target => self.target,
            Lerp::Next => next,
        }
    }
    fn progress(&self, now: f64) -> f32 {
        if now < self.start {
            0.0
        } else if now > self.start + self.duration {
            1.0
        } else {
            ((now - self.start) / self.duration) as f32
        }
    }
    fn strength(&self, linear: f32, next: f32) -> f32 {
        if self.mid == Lerp::None {
            clerp(linear, self.entry, self.value(self.end, next))
        } else if linear < 0.5 {
            clerp(linear * 2.0, self.entry, self.value(self.mid, next))
        } else {
            clerp(
                2.0 - linear * 2.0,
                self.value(self.end, next),
                self.value(self.mid, next),
            )
        }
    }
}

// At source strength <=1, generation needs at most48 one-hour content stages,
// two separators per gap, plus entry/exit. Fixed storage avoids tick allocation.
const STAGE_CAPACITY: usize = 160;
struct Period {
    rng: JavaRandom,
    running: bool,
    front: Front,
    stages: [Stage; STAGE_CAPACITY],
    count: usize,
    index: usize,
    current_time: f64,
    start_time: f64,
    duration: f64,
    strength: f32,
    threshold: f32,
    noise: f32,
    precipitation: f32,
    temperature_influence: f32,
    total_progress: f32,
    stage_progress: f32,
    thunder: bool,
    tropical: bool,
    blizzard: bool,
}
impl Period {
    fn new() -> Self {
        Self {
            rng: JavaRandom::new(1984),
            running: false,
            front: Front::new(),
            stages: [Stage::EMPTY; STAGE_CAPACITY],
            count: 0,
            index: 0,
            current_time: 0.0,
            start_time: 0.0,
            duration: 0.0,
            strength: 0.0,
            threshold: 0.0,
            noise: 0.0,
            precipitation: 0.0,
            total_progress: 0.0,
            temperature_influence: 0.0,
            stage_progress: 0.0,
            thunder: false,
            tropical: false,
            blizzard: false,
        }
    }
    fn random(&mut self, low: f32, high: f32) -> f32 {
        if low == high {
            low
        } else {
            low + self.rng.next_float() * (high - low)
        }
    }
    fn make_stage(&mut self, id: u8, duration: f64) -> Stage {
        let strength = self.front.strength;
        let (target, mid, end) = match id {
            0 => (0.0, Lerp::None, Lerp::Next),
            1 | 5 => (strength * 0.5, Lerp::Target, Lerp::Next),
            2 | 3 => (strength, Lerp::Target, Lerp::Target),
            4 => (strength * 0.25, Lerp::Target, Lerp::None),
            6 => (strength * 0.25, Lerp::Target, Lerp::Next),
            7 | 8 => (1.0, Lerp::Target, Lerp::Target),
            9 => (0.0, Lerp::Target, Lerp::Next),
            _ => unreachable!(),
        };
        let mut stage = Stage::plain(id, duration, target, mid, end);
        stage.fog = match id {
            8 => 0.6 + self.random(0.0, 0.4),
            7 => 0.55 + self.random(0.0, 0.2),
            3 if self.rng.next_int(100) < 33 => 0.1 + self.random(0.0, 0.4),
            _ => 0.0,
        };
        stage
    }
    fn add(&mut self, id: u8, duration: f32) {
        let stage = self.make_stage(id, duration as f64);
        self.stages[self.count] = stage;
        self.count += 1;
    }
    fn init(
        &mut self,
        front: Front,
        clock: ClockSample,
        offsets: [f64; 4],
        season: SeasonDay,
        winter: bool,
    ) {
        // Source reseeds even when startInit refuses an already-running period.
        self.rng.set_seed(date_seed(
            clock.year,
            clock.month,
            clock.day + 1,
            offsets[0],
            offsets[1],
        ));
        if self.running || front.strength < 0.1 {
            return;
        }
        self.front = front;
        self.start_time = clock.world_age_hours;
        self.count = 0;
        self.index = 0;
        let mut contents = [Stage::EMPTY; 48];
        let mut content_count = 0usize;
        let color_roll = self.random(0.0, 100.0);
        let mut season_id = season.season;
        if winter {
            season_id = 5;
        }
        let (storm_chance, tropical_chance, mut blizzard_chance, mut time_multiplier) =
            match season_id {
                1 => (75.0, 10.0, 0.0, 1.25_f32),
                2 => (60.0, 55.0, 0.0, 1.0),
                3 => (75.0, 80.0, 0.0, 1.15),
                4 => (100.0, 25.0, 0.0, 1.35),
                5 => {
                    let temperature = season.day_mean_temperature;
                    let mut chance = if temperature < 5.5 {
                        ((5.5 - temperature) * 3.0).clamp(0.0, 85.0) + 25.0
                    } else {
                        0.0
                    };
                    if temperature < 5.5 {
                        if temperature < 2.5 {
                            chance += 55.0;
                        } else if temperature < 0.0 {
                            chance += 75.0;
                        }
                        if chance > 95.0 {
                            chance = 95.0;
                        }
                    }
                    (10.0, 0.0, chance, 1.0)
                }
                _ => (0.0, 0.0, 0.0, 1.0),
            };
        let strength = front.strength;
        if winter {
            blizzard_chance = if strength > 0.75 { 100.0 } else { 75.0 };
            if strength > 0.5 {
                time_multiplier = 1.45;
            }
        }
        // Color itself is not a precipitation dependency, but a cold-front
        // reddish-color replacement consumes a source random draw.
        let reddish = match season_id {
            2 => color_roll >= 25.0,
            3 => true,
            4 => color_roll < 50.0,
            _ => false,
        };
        if front.kind == 1 {
            let mut tropical = false;
            let mut blizzard = false;
            let mut thunder = false;
            if strength > 0.75 {
                if tropical_chance > 0.0 && self.random(0.0, 100.0) < tropical_chance {
                    tropical = true;
                } else if blizzard_chance > 0.0 && self.random(0.0, 100.0) < blizzard_chance {
                    blizzard = true;
                }
            }
            if !blizzard
                && !tropical
                && strength > 0.5
                && storm_chance > 0.0
                && self.random(0.0, 100.0) < storm_chance
            {
                thunder = true;
            }
            let target_duration = self.random(24.0, 48.0) * strength;
            if tropical {
                let duration = 8.0 + self.random(0.0, 16.0 * strength);
                contents[content_count] = self.make_stage(8, duration as f64);
                content_count += 1;
                for chance in [60.0, 30.0] {
                    if self.random(0.0, 100.0) < chance * strength {
                        let duration = 5.0 + self.random(0.0, 5.0 * strength);
                        contents[content_count] = self.make_stage(3, duration as f64);
                        content_count += 1;
                    }
                }
            } else if blizzard {
                let duration = 24.0 + self.random(0.0, 24.0 * strength);
                contents[content_count] = self.make_stage(7, duration as f64);
                content_count += 1;
            } else if thunder {
                let duration = 5.0 + self.random(0.0, 5.0 * strength);
                contents[content_count] = self.make_stage(3, duration as f64);
                content_count += 1;
                for (chance, range) in [(70.0, 4.0), (50.0, 4.0), (25.0, 3.0), (12.5, 2.0)] {
                    if self.random(0.0, 100.0) < chance * strength {
                        let duration = 4.0 + self.random(0.0, range * strength);
                        contents[content_count] = self.make_stage(3, duration as f64);
                        content_count += 1;
                    }
                }
            }
            let mut length = 0.0f32;
            for stage in &contents[..content_count] {
                length = (length as f64 + stage.duration) as f32;
            }
            while length < target_duration {
                let choice = self.rng.next_int(10);
                let (id, low, range) = match choice {
                    0 => (5, 1.0, 3.0),
                    1..=3 => (1, 2.0, 4.0),
                    _ => (2, 2.0, 4.0),
                };
                let duration = low + self.random(0.0, range * strength);
                let stage = self.make_stage(id, duration as f64);
                length = (length as f64 + stage.duration) as f32;
                contents[content_count] = stage;
                content_count += 1;
            }
        } else {
            if reddish {
                self.random(0.0, 100.0);
            }
            let target_duration = self.random(12.0, 24.0) * strength;
            let mut length = 0.0f32;
            while length < target_duration {
                let choice = self.rng.next_int(10);
                let id = match choice {
                    0 => 1,
                    1..=4 => 6,
                    _ => 5,
                };
                let duration = 2.0 + self.random(0.0, 3.0 * strength);
                let stage = self.make_stage(id, duration as f64);
                length = (length as f64 + stage.duration) as f32;
                contents[content_count] = stage;
                content_count += 1;
            }
        }
        // java.util.Collections.shuffle's backwards Fisher-Yates order.
        for remaining in (2..=content_count).rev() {
            let selected = self.rng.next_int(remaining as i32) as usize;
            contents.swap(remaining - 1, selected);
        }
        let mut gap_chance = self.random(30.0, 60.0);
        let entry_duration = 1.0 + self.random(0.0, 2.0 * strength);
        self.add(0, entry_duration);
        for (index, stage) in contents[..content_count].iter().enumerate() {
            self.stages[self.count] = *stage;
            self.count += 1;
            if index + 1 < content_count && self.random(0.0, 100.0) < gap_chance {
                let duration = 1.0 + self.random(0.0, 2.0 * strength);
                self.add(4, duration);
                let duration = 1.0 + self.random(0.0, 3.0 * strength);
                self.add(9, duration);
                gap_chance = self.random(30.0, 60.0);
            }
        }
        if self.stages[self.count - 1].id != 9 {
            let duration = 2.0 + self.random(0.0, 3.0 * strength);
            self.add(4, duration);
        }
        self.duration = 0.0;
        let mut start = self.start_time;
        for stage in &mut self.stages[..self.count] {
            stage.duration *= time_multiplier as f64;
            stage.start = start;
            start += stage.duration;
            self.duration += stage.duration;
        }
        self.strength = 0.0;
        self.total_progress = 0.0;
        self.stage_progress = 0.0;
        self.running = true;
    }

    fn update(
        &mut self,
        now: f64,
        temperature: (f32, f32),
        season: i32,
        winter: bool,
        rain: &mut ClimateFloat,
        snow: &mut ClimateBool,
    ) {
        let (internal_temperature, previous_temperature) = temperature;
        if !self.running {
            return;
        }
        // Source intentionally compares the preceding sample, not `now`.
        if self.current_time > self.stages[self.index].start + self.stages[self.index].duration {
            self.index += 1;
            if self.index >= self.count {
                self.running = false;
                rain.override_value = None;
                snow.overridden = None;
                return;
            }
            self.stages[self.index - 1].exit = self.strength;
            self.stages[self.index].entry = self.strength;
            self.stages[self.index].start = now;
            self.stages[self.index].cloud_started = false;
        }
        self.current_time = now;
        let base_noise = simplex_noise(now, 24000.0) as f32;
        self.noise = 0.3 * self.front.strength + base_noise * (1.0 - 0.3 * self.front.strength);
        self.noise = (self.noise + 1.0) * 0.5;
        let stage = &self.stages[self.index];
        let linear = stage.progress(now);
        self.stage_progress = linear;
        self.total_progress =
            ((now - self.stages[0].start) as f32 / self.duration as f32).clamp(0.0, 1.0);
        let next = if self.index + 1 < self.count {
            self.stages[self.index + 1].target
        } else {
            0.0
        };
        self.strength = stage.strength(linear, next);
        self.thunder = stage.id == 3;
        self.tropical = stage.id == 8;
        self.blizzard = stage.id == 7;
        if stage.id == 0 {
            self.threshold = 0.35 - self.front.strength * 0.2;
        }
        if matches!(stage.id, 2 | 3 | 7 | 8) {
            let maximum = self.front.strength * 0.5;
            let adjustment = if linear < 0.1 {
                clerp(
                    ((now - stage.start) / (stage.duration * 0.1)) as f32,
                    0.0,
                    maximum,
                )
            } else if linear > 0.9 {
                clerp(
                    1.0 - ((stage.start + stage.duration - now) / (stage.duration * 0.1)) as f32,
                    maximum,
                    0.0,
                )
            } else {
                maximum
            };
            self.noise = adjustment + self.noise * (1.0 - adjustment);
        }
        self.temperature_influence = if self.front.kind == 1 {
            internal_temperature - (self.strength * 2.0).clamp(-1.0, 1.0) * 7.0
        } else {
            internal_temperature + (self.strength * 2.0).clamp(-1.0, 1.0) * 7.0
        };
        self.precipitation = if self.noise > self.threshold {
            ((self.noise - self.threshold) / (1.0 - self.threshold)) * self.strength
        } else {
            0.0
        };
        rain.override_value = Some((self.precipitation, 1.0));
        snow.overridden = if (previous_temperature < 0.0 && season == 5) || winter {
            Some(true)
        } else {
            None
        };
    }
}

fn date_seed(year: i32, month: i32, day: i32, first: f64, second: f64) -> i64 {
    let relative = year.wrapping_sub(1990);
    relative.wrapping_mul(100000) as i64
        + month.wrapping_mul(day).wrapping_mul(1234) as i64
        + relative.wrapping_mul(month).wrapping_mul(10000) as i64
        + (second as i32).wrapping_sub(first as i32).wrapping_mul(day) as i64
}
fn month_days(year: i32, month: i32) -> i32 {
    match month {
        1 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        1 => 28,
        3 | 5 | 8 | 10 => 30,
        _ => 31,
    }
}
#[cfg(test)]
fn date_after(mut year: i32, mut month: i32, mut day: i32, mut delta: i32) -> (i32, i32, i32) {
    while delta > 0 {
        let available = month_days(year, month) - day;
        if delta <= available {
            day += delta;
            break;
        }
        delta -= available + 1;
        day = 1;
        month += 1;
        if month == 12 {
            month = 0;
            year += 1;
        }
    }
    while delta < 0 {
        if day + delta > 0 {
            day += delta;
            break;
        }
        delta += day;
        month -= 1;
        if month < 0 {
            month = 11;
            year -= 1;
        }
        day = month_days(year, month);
    }
    (year, month, day)
}
fn time_lerp(hour: f32, start: f32, end: f32) -> f32 {
    let time = (hour / 24.0).clamp(0.0, 1.0);
    let start = (start / 24.0).clamp(0.0, 1.0);
    let end = (end / 24.0).clamp(0.0, 1.0);
    let (elapsed, length) = if start > end {
        if time < start && time > end {
            return 0.0;
        }
        let rest = 1.0 - start;
        (
            if time >= start {
                time - start
            } else {
                time + rest
            },
            end + rest,
        )
    } else {
        if time < start || time > end {
            return 0.0;
        }
        (time - start, end - start)
    };
    let half = length * 0.5;
    if elapsed < half {
        clerp(elapsed / half, 0.0, 1.0)
    } else {
        clerp((elapsed - half) / half, 1.0, 0.0)
    }
}

struct Weather {
    seed: u32,
    offsets: [f64; 4],
    random: CaRandom,
    time_zone: TimeZone,
    time_zone_id: Vec<u8>,
    season: WeatherMathSeason,
    clock: ClockSample,
    last_minute: i64,
    last_hour: i32,
    winter: bool,
    rain: ClimateFloat,
    snow: ClimateBool,
    internal_temperature: f32,
    final_temperature: f32,
    air_mass: f32,
    front: Front,
    period: Period,
    day_cache: Option<(i32, i32, i32, SeasonDay, SeasonDay)>,
}
impl Weather {
    fn day_values(&mut self, clock: ClockSample) -> Option<(SeasonDay, SeasonDay)> {
        if let Some((year, month, day, current, next)) = self.day_cache
            && (year, month, day) == (clock.year, clock.month, clock.day)
        {
            return Some((current, next));
        }
        let stamp = calendar_at(
            &self.time_zone,
            (clock.year, clock.month, clock.day + 1, 0, 0),
        )?;
        let date = calendar_date(&self.time_zone, stamp);
        let current = self.season.day(date.2, date.1, date.0)?;
        let stamp = calendar_add_days(&self.time_zone, stamp, 1)?;
        let date = calendar_date(&self.time_zone, stamp);
        let next = self.season.day(date.2, date.1, date.0)?;
        self.day_cache = Some((clock.year, clock.month, clock.day, current, next));
        Some((current, next))
    }
    fn tick(&mut self, clock: ClockSample) -> i32 {
        if self.last_minute != clock.minute_stamp {
            let Some((day, next)) = self.day_values(clock) else {
                return UNSUPPORTED;
            };
            let age = clock.world_age_hours;
            let air_mass = simplex_noise(self.offsets[0], age / 166.0) as f32;
            let hour = source_hour(clock.time_of_day);
            let kind = if air_mass < 0.0 { -1 } else { 1 };
            let front_change = self.last_hour != hour && self.front.kind != kind;
            let generate = front_change && (!self.winter || age > 96.0);
            let mut history = [0.0_f32; 4];
            // Validate every calendar result before changing producer authority.
            if generate {
                let minute = ((clock.time_of_day - clock.time_of_day.trunc()) * 60.0) as i32;
                let Some(from) = calendar_at(
                    &self.time_zone,
                    (clock.year, clock.month, clock.day + 1, hour, minute),
                ) else {
                    return UNSUPPORTED;
                };
                let Some(base) = calendar_at(
                    &self.time_zone,
                    (clock.year, clock.month, clock.day + 1, 0, 0),
                ) else {
                    return UNSUPPORTED;
                };
                let Some(mut date) = calendar_add_days(&self.time_zone, base, -3) else {
                    return UNSUPPORTED;
                };
                for (index, sample) in history.iter_mut().enumerate() {
                    let minutes = calendar_minutes_between(from, date);
                    let sampled_age = age + minutes as f64 / 60.0;
                    *sample =
                        simplex_noise(self.offsets[0], (sampled_age.floor() + 12.0) / 166.0) as f32;
                    if index != 3 {
                        let Some(next_date) = calendar_add_days(&self.time_zone, date, 1) else {
                            return UNSUPPORTED;
                        };
                        date = next_date;
                    }
                }
            }
            self.air_mass = air_mass;
            let air_temperature = simplex_noise(self.offsets[0], (age - 48.0) / 166.0) as f32;
            let day_mean = clerp(
                clock.time_of_day / 24.0,
                day.day_mean_temperature,
                next.day_mean_temperature,
            );
            let base = day_mean + air_temperature * 8.0;
            let mut dusk_lagged = day.dusk + 4.0;
            if dusk_lagged >= 24.0 {
                dusk_lagged -= 24.0;
            }
            let daylight = time_lerp(clock.time_of_day, day.dawn + 4.0, dusk_lagged);
            let night = time_lerp(clock.time_of_day, dusk_lagged, day.dawn + 4.0);
            let loss = 5.0 * (1.0 - daylight);
            let loss = loss + 5.0 * night;
            self.internal_temperature = base + 1.0 - loss;
            self.snow.internal = self.internal_temperature < 0.0 || self.winter;
            self.rain.internal = 0.0;
            if self.last_hour != hour {
                if self.front.kind != kind {
                    if !self.winter || age > 96.0 {
                        for sample in history {
                            let sampled_kind = if sample < 0.0 { -1 } else { 1 };
                            if sampled_kind == self.front.kind {
                                self.front.sample(sample);
                            }
                        }
                        let pattern_winter =
                            crate::timing::with_game_mode(|mode| mode == b"Winter is Coming");
                        self.period
                            .init(self.front, clock, self.offsets, day, pattern_winter);
                    }
                    self.front.change(kind);
                }
                if !self.winter && (72.0..=96.0).contains(&age) && !self.period.running {
                    self.random.int_range(0, 1000);
                }
                self.last_hour = hour;
            }
            let wind_noise = simplex_noise(age / 40.0, self.offsets[3]) as f32;
            self.front.wind = 360.0 * ((wind_noise + 1.0) * 0.5);
            self.period.update(
                age,
                (self.internal_temperature, self.final_temperature),
                day.season,
                self.winter,
                &mut self.rain,
                &mut self.snow,
            );
            self.last_minute = clock.minute_stamp;
        }
        self.rain.finalize();
        self.snow.finalize();
        // The source period's snow decision reads the previous final temperature.
        self.final_temperature = if self.period.running {
            lerp(
                self.period.strength,
                self.internal_temperature,
                self.period.temperature_influence,
            )
        } else {
            self.internal_temperature
        };
        self.clock = clock;
        OK
    }
}
thread_local! {
    static STATE: RefCell<Option<Weather>> = const { RefCell::new(None) };
}
fn validate_clock(clock: ClockSample) -> i32 {
    if !clock.world_age_hours.is_finite() || !clock.time_of_day.is_finite() {
        return NONFINITE;
    }
    if !supports_year(clock.year) {
        return UNSUPPORTED;
    }
    if clock.world_age_hours < 0.0
        || !(0.0..24.0).contains(&clock.time_of_day)
        || !(0..12).contains(&clock.month)
        || clock.day < 0
        || clock.day >= month_days(clock.year, clock.month)
    {
        return OUT_OF_RANGE;
    }
    OK
}
pub(crate) fn initialize(seed: u32, clock: ClockSample, game_mode: &[u8], time_zone: &[u8]) -> i32 {
    let valid = validate_clock(clock);
    if valid != OK {
        return valid;
    }
    if game_mode == b"The Descending Fog" {
        return UNSUPPORTED;
    }
    if time_zone.is_empty() || time_zone.len() > 128 {
        return OUT_OF_RANGE;
    }
    let Ok(name) = std::str::from_utf8(time_zone) else {
        return BAD_FORMAT;
    };
    let Ok(zone) = TimeZone::get(name) else {
        return UNSUPPORTED;
    };
    let mut random = CaRandom::new(seed);
    let offsets = climate_offsets(&mut random);
    let mut weather = Weather {
        seed,
        offsets,
        random,
        time_zone: zone.clone(),
        time_zone_id: time_zone.to_vec(),
        season: WeatherMathSeason::new(zone),
        clock,
        last_minute: -1,
        last_hour: -1,
        winter: game_mode == b"Winter is Coming",
        rain: ClimateFloat::default(),
        snow: ClimateBool::default(),
        internal_temperature: 0.0,
        final_temperature: 0.0,
        air_mass: 0.0,
        front: Front::new(),
        period: Period::new(),
        day_cache: None,
    };
    let status = weather.tick(clock);
    if status != OK {
        return status;
    }
    STATE.with(|state| *state.borrow_mut() = Some(weather));
    OK
}
pub(crate) fn advance(clock: ClockSample) -> i32 {
    STATE.with(|state| {
        let mut state = state.borrow_mut();
        if let Some(weather) = state.as_mut() {
            let valid = validate_clock(clock);
            if valid != OK {
                return valid;
            }
            return weather.tick(clock);
        }
        OK
    })
}
pub(crate) fn precipitation() -> Option<(f32, bool)> {
    STATE.with(|state| {
        state
            .borrow()
            .as_ref()
            .map(|state| (state.rain.final_value, state.snow.final_value))
    })
}
pub(crate) fn reset() {
    STATE.with(|state| *state.borrow_mut() = None);
}
pub(crate) fn configured() -> bool {
    STATE.with(|state| state.borrow().is_some())
}

// Independent port wire format; no source save bytes are imported or emitted.
// All values are staged before the single live-state replacement.
struct Encoder(Vec<u8>);
impl Encoder {
    fn u8(&mut self, value: u8) {
        self.0.push(value);
    }
    fn bool(&mut self, value: bool) {
        self.u8(u8::from(value));
    }
    fn u32(&mut self, value: u32) {
        self.0.extend_from_slice(&value.to_le_bytes());
    }
    fn i32(&mut self, value: i32) {
        self.u32(value as u32);
    }
    fn u64(&mut self, value: u64) {
        self.0.extend_from_slice(&value.to_le_bytes());
    }
    fn i64(&mut self, value: i64) {
        self.u64(value as u64);
    }
    fn f32(&mut self, value: f32) {
        self.u32(value.to_bits());
    }
    fn f64(&mut self, value: f64) {
        self.u64(value.to_bits());
    }
    fn optional_float(&mut self, value: Option<f32>) {
        self.bool(value.is_some());
        if let Some(value) = value {
            self.f32(value);
        }
    }
    fn optional_bool(&mut self, value: Option<bool>) {
        self.bool(value.is_some());
        if let Some(value) = value {
            self.bool(value);
        }
    }
    fn pair(&mut self, value: Option<(f32, f32)>) {
        self.bool(value.is_some());
        if let Some((value, t)) = value {
            self.f32(value);
            self.f32(t);
        }
    }
    fn climate_float(&mut self, value: &ClimateFloat) {
        self.f32(value.internal);
        self.f32(value.final_value);
        self.pair(value.override_value);
        self.optional_float(value.override_internal);
        self.pair(value.modded);
        self.optional_float(value.admin);
    }
    fn climate_bool(&mut self, value: &ClimateBool) {
        self.bool(value.internal);
        self.bool(value.final_value);
        self.optional_bool(value.overridden);
        self.optional_bool(value.modded);
        self.optional_bool(value.admin);
    }
    fn front(&mut self, value: Front) {
        self.i32(value.kind);
        self.f32(value.days);
        self.f32(value.max);
        self.f32(value.total);
        self.f32(value.strength);
        self.f32(value.wind);
        for value in value.cache {
            self.f32(value);
        }
    }
    fn clock(&mut self, value: ClockSample) {
        self.f64(value.world_age_hours);
        self.f32(value.time_of_day);
        self.i32(value.year);
        self.i32(value.month);
        self.i32(value.day);
        self.i64(value.minute_stamp);
    }
}
struct Decoder<'a> {
    bytes: &'a [u8],
    position: usize,
}
impl<'a> Decoder<'a> {
    fn bytes<const N: usize>(&mut self) -> Result<[u8; N], i32> {
        let end = self.position.checked_add(N).ok_or(BAD_FORMAT)?;
        let bytes = self.bytes.get(self.position..end).ok_or(BAD_FORMAT)?;
        self.position = end;
        bytes.try_into().map_err(|_| BAD_FORMAT)
    }
    fn u8(&mut self) -> Result<u8, i32> {
        Ok(self.bytes::<1>()?[0])
    }
    fn bool(&mut self) -> Result<bool, i32> {
        match self.u8()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(BAD_FORMAT),
        }
    }
    fn u32(&mut self) -> Result<u32, i32> {
        Ok(u32::from_le_bytes(self.bytes()?))
    }
    fn i32(&mut self) -> Result<i32, i32> {
        Ok(self.u32()? as i32)
    }
    fn u64(&mut self) -> Result<u64, i32> {
        Ok(u64::from_le_bytes(self.bytes()?))
    }
    fn i64(&mut self) -> Result<i64, i32> {
        Ok(self.u64()? as i64)
    }
    fn f32(&mut self) -> Result<f32, i32> {
        let value = f32::from_bits(self.u32()?);
        if value.is_finite() {
            Ok(value)
        } else {
            Err(BAD_FORMAT)
        }
    }
    fn f64(&mut self) -> Result<f64, i32> {
        let value = f64::from_bits(self.u64()?);
        if value.is_finite() {
            Ok(value)
        } else {
            Err(BAD_FORMAT)
        }
    }
    fn unit(&mut self) -> Result<f32, i32> {
        let value = self.f32()?;
        if (0.0..=1.0).contains(&value) {
            Ok(value)
        } else {
            Err(BAD_FORMAT)
        }
    }
    fn optional_float(&mut self) -> Result<Option<f32>, i32> {
        if self.bool()? {
            Ok(Some(self.unit()?))
        } else {
            Ok(None)
        }
    }
    fn optional_bool(&mut self) -> Result<Option<bool>, i32> {
        if self.bool()? {
            Ok(Some(self.bool()?))
        } else {
            Ok(None)
        }
    }
    fn pair(&mut self) -> Result<Option<(f32, f32)>, i32> {
        if self.bool()? {
            Ok(Some((self.unit()?, self.unit()?)))
        } else {
            Ok(None)
        }
    }
    fn climate_float(&mut self) -> Result<ClimateFloat, i32> {
        Ok(ClimateFloat {
            internal: self.unit()?,
            final_value: self.unit()?,
            override_value: self.pair()?,
            override_internal: self.optional_float()?,
            modded: self.pair()?,
            admin: self.optional_float()?,
        })
    }
    fn climate_bool(&mut self) -> Result<ClimateBool, i32> {
        Ok(ClimateBool {
            internal: self.bool()?,
            final_value: self.bool()?,
            overridden: self.optional_bool()?,
            modded: self.optional_bool()?,
            admin: self.optional_bool()?,
        })
    }
    fn front(&mut self) -> Result<Front, i32> {
        let value = Front {
            kind: self.i32()?,
            days: self.f32()?,
            max: self.unit()?,
            total: self.f32()?,
            strength: self.unit()?,
            wind: self.f32()?,
            cache: [self.f32()?, self.f32()?],
        };
        if !(-1..=1).contains(&value.kind)
            || value.days < 0.0
            || value.total < 0.0
            || !(0.0..=360.0).contains(&value.wind)
            || value
                .cache
                .iter()
                .any(|value| !(-1.0..=1.0).contains(value))
        {
            return Err(BAD_FORMAT);
        }
        Ok(value)
    }
    fn clock(&mut self) -> Result<ClockSample, i32> {
        let value = ClockSample {
            world_age_hours: self.f64()?,
            time_of_day: self.f32()?,
            year: self.i32()?,
            month: self.i32()?,
            day: self.i32()?,
            minute_stamp: self.i64()?,
        };
        if validate_clock(value) != OK {
            return Err(BAD_FORMAT);
        }
        Ok(value)
    }
}

pub(crate) fn save() -> Vec<u8> {
    STATE.with(|state| {
        let state = state.borrow();
        let capacity = state
            .as_ref()
            .map_or(9, |weather| 2689 + weather.period.count * 36);
        let mut out = Encoder(Vec::with_capacity(capacity));
        out.0.extend_from_slice(b"ZWTH");
        out.u32(1);
        out.bool(state.is_some());
        let Some(weather) = state.as_ref() else {
            return out.0;
        };
        out.u32(weather.seed);
        for value in weather.offsets {
            out.f64(value);
        }
        out.0.extend_from_slice(&weather.random.cells);
        out.u32(weather.random.current_index as u32);
        out.clock(weather.clock);
        out.i64(weather.last_minute);
        out.i32(weather.last_hour);
        out.bool(weather.winter);
        out.climate_float(&weather.rain);
        out.climate_bool(&weather.snow);
        out.f32(weather.internal_temperature);
        out.f32(weather.final_temperature);
        out.f32(weather.air_mass);
        out.front(weather.front);
        let period = &weather.period;
        out.u64(period.rng.state());
        out.bool(period.running);
        out.front(period.front);
        out.u32(period.count as u32);
        out.u32(period.index as u32);
        out.f64(period.current_time);
        out.f64(period.start_time);
        out.f64(period.duration);
        out.f32(period.strength);
        out.f32(period.threshold);
        out.f32(period.noise);
        out.f32(period.precipitation);
        out.f32(period.total_progress);
        out.f32(period.stage_progress);
        out.f32(period.temperature_influence);
        out.bool(period.thunder);
        out.bool(period.tropical);
        out.bool(period.blizzard);
        for stage in &period.stages[..period.count] {
            out.u8(stage.id);
            out.f64(stage.start);
            out.f64(stage.duration);
            out.f32(stage.entry);
            out.f32(stage.exit);
            out.f32(stage.target);
            out.u8(stage.mid as u8);
            out.u8(stage.end as u8);
            out.f32(stage.fog);
            out.bool(stage.cloud_started);
        }
        out.u8(weather.time_zone_id.len() as u8);
        out.0.extend_from_slice(&weather.time_zone_id);
        out.0
    })
}

fn decode(bytes: &[u8]) -> Result<Option<Weather>, i32> {
    let mut input = Decoder { bytes, position: 0 };
    if input.bytes::<4>()? != *b"ZWTH" || input.u32()? != 1 {
        return Err(BAD_FORMAT);
    }
    if !input.bool()? {
        return if input.position == bytes.len() {
            Ok(None)
        } else {
            Err(BAD_FORMAT)
        };
    }
    let seed = input.u32()?;
    let offsets = [input.f64()?, input.f64()?, input.f64()?, input.f64()?];
    if !(0.0..8000.0).contains(&offsets[0])
        || !(8000.0..16000.0).contains(&offsets[1])
        || !(-8000.0..0.0).contains(&offsets[2])
        || !(-16000.0..-8000.0).contains(&offsets[3])
        || offsets.iter().any(|value| value.fract() != 0.0)
    {
        return Err(BAD_FORMAT);
    }
    let cells = input.bytes::<2056>()?;
    let current_index = input.u32()? as usize;
    if current_index >= 2056 || current_index % 4 != 3 {
        return Err(BAD_FORMAT);
    }
    let clock = input.clock()?;
    let last_minute = input.i64()?;
    let last_hour = input.i32()?;
    let winter = input.bool()?;
    if last_minute > clock.minute_stamp || !(-1..24).contains(&last_hour) {
        return Err(BAD_FORMAT);
    }
    let rain = input.climate_float()?;
    let snow = input.climate_bool()?;
    let internal_temperature = input.f32()?;
    let final_temperature = input.f32()?;
    let air_mass = input.f32()?;
    if !(-1.0..=1.0).contains(&air_mass) {
        return Err(BAD_FORMAT);
    }
    let front = input.front()?;
    let random_state = input.u64()?;
    if random_state >= 1 << 48 {
        return Err(BAD_FORMAT);
    }
    let mut period = Period::new();
    period.rng = JavaRandom::from_state(random_state);
    period.running = input.bool()?;
    period.front = input.front()?;
    period.count = input.u32()? as usize;
    period.index = input.u32()? as usize;
    if period.count > STAGE_CAPACITY
        || period.index > period.count
        || (period.running && (period.count == 0 || period.index >= period.count))
    {
        return Err(BAD_FORMAT);
    }
    period.current_time = input.f64()?;
    period.start_time = input.f64()?;
    period.duration = input.f64()?;
    period.strength = input.unit()?;
    period.threshold = input.unit()?;
    period.noise = input.unit()?;
    period.precipitation = input.unit()?;
    period.total_progress = input.unit()?;
    period.stage_progress = input.unit()?;
    period.temperature_influence = input.f32()?;
    period.thunder = input.bool()?;
    period.tropical = input.bool()?;
    period.blizzard = input.bool()?;
    if period.current_time < 0.0 || period.start_time < 0.0 || period.duration < 0.0 {
        return Err(BAD_FORMAT);
    }
    for stage in &mut period.stages[..period.count] {
        *stage = Stage {
            id: input.u8()?,
            start: input.f64()?,
            duration: input.f64()?,
            entry: input.unit()?,
            exit: input.unit()?,
            target: input.unit()?,
            mid: Lerp::from_byte(input.u8()?)?,
            end: Lerp::from_byte(input.u8()?)?,
            fog: input.unit()?,
            cloud_started: input.bool()?,
        };
        if stage.id > 9
            || stage.start < 0.0
            || stage.duration < 1.0
            || !(stage.start + stage.duration).is_finite()
        {
            return Err(BAD_FORMAT);
        }
    }
    let duration = period.stages[..period.count]
        .iter()
        .fold(0.0_f64, |sum, stage| sum + stage.duration);
    if duration.to_bits() != period.duration.to_bits() || (period.running && period.duration <= 0.0)
    {
        return Err(BAD_FORMAT);
    }
    let zone_length = input.u8()? as usize;
    if zone_length == 0 || zone_length > 128 {
        return Err(BAD_FORMAT);
    }
    let end = input.position.checked_add(zone_length).ok_or(BAD_FORMAT)?;
    let zone_name = std::str::from_utf8(input.bytes.get(input.position..end).ok_or(BAD_FORMAT)?)
        .map_err(|_| BAD_FORMAT)?;
    let time_zone = TimeZone::get(zone_name).map_err(|_| BAD_FORMAT)?;
    let time_zone_id = zone_name.as_bytes().to_vec();
    input.position = end;
    if input.position != bytes.len() {
        return Err(BAD_FORMAT);
    }
    let mut weather = Weather {
        seed,
        offsets,
        random: CaRandom {
            cells,
            current_index,
        },
        season: WeatherMathSeason::new(time_zone.clone()),
        time_zone,
        time_zone_id,
        clock,
        last_minute,
        last_hour,
        winter,
        rain,
        snow,
        internal_temperature,
        final_temperature,
        air_mass,
        front,
        period,
        day_cache: None,
    };
    if weather.day_values(clock).is_none() {
        return Err(BAD_FORMAT);
    }
    Ok(Some(weather))
}
pub(crate) fn load(bytes: &[u8]) -> i32 {
    match decode(bytes) {
        Ok(staged) => {
            STATE.with(|state| *state.borrow_mut() = staged);
            OK
        }
        Err(status) => status,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clock(age: f64, year: i32, month: i32, day: i32, hour: f32) -> ClockSample {
        ClockSample {
            world_age_hours: age,
            time_of_day: hour,
            year,
            month,
            day,
            minute_stamp: (age * 60.0) as i64,
        }
    }

    #[test]
    fn source_clock_discontinuities_advance_and_restore_resident_weather() {
        reset();
        let time = 6.999_926_f32;
        let before_seven = clock(f64::from(time + 17.0), 1993, 0, 0, time);
        assert_eq!(initialize(0x12345678, before_seven, b"Sandbox", b"UTC"), OK);
        let at_seven = clock(0.0, 1993, 0, 0, 7.0);
        assert_eq!(advance(at_seven), OK);
        assert!(precipitation().is_some());
        let at_boundary = save();
        assert_eq!(load(&at_boundary), OK);
        assert_eq!(save(), at_boundary);

        let mut had_period = false;
        let mut inactive = false;
        for hour in 1..(366 * 24) {
            let (year, month, day) = date_after(1993, 0, 1, (hour + 7) / 24);
            let sample = clock(hour as f64, year, month, day - 1, ((hour + 7) % 24) as f32);
            assert_eq!(advance(sample), OK);
            let running = STATE.with(|state| state.borrow().as_ref().unwrap().period.running);
            had_period |= running;
            if had_period && !running && hour % 24 == 0 {
                inactive = true;
                break;
            }
        }
        assert!(
            inactive,
            "a genuinely generated period must finish before the restore boundary"
        );
        let resident_time =
            STATE.with(|state| state.borrow().as_ref().unwrap().period.current_time);
        assert!(resident_time > 0.0);

        // Original inactive periods retain their last update time when the
        // canonical clock moves backwards; that cache is not a validity bound.
        assert_eq!(advance(at_seven), OK);
        assert_eq!(
            STATE.with(|state| state.borrow().as_ref().unwrap().period.current_time),
            resident_time
        );
        let rewound = save();
        assert_eq!(load(&rewound), OK);
        assert_eq!(save(), rewound);
        let next = clock(1.0, 1993, 0, 0, 8.0);
        assert_eq!(advance(next), OK);
        let continued = save();
        assert_eq!(load(&rewound), OK);
        assert_eq!(advance(next), OK);
        assert_eq!(save(), continued);
    }

    #[test]
    fn absent_weather_does_not_restrict_the_existing_world_clock_domain() {
        reset();
        let absent = save();
        let historical = clock(0.0, 1500, 1, 28, 0.0);
        let single_rollover = clock(43.0, 1994, 0, 0, 48.0);

        for sample in [historical, single_rollover] {
            assert_eq!(advance(sample), OK);
            assert_eq!(precipitation(), None);
            assert_eq!(save(), absent);
        }

        let initial = clock(0.0, 1993, 6, 22, 9.0);
        assert_eq!(initialize(7, initial, b"Sandbox", b"America/Chicago"), OK);
        let configured = save();
        assert_eq!(advance(historical), UNSUPPORTED);
        assert_eq!(advance(single_rollover), OUT_OF_RANGE);
        assert_eq!(save(), configured);
        assert!(precipitation().is_some());
    }

    #[test]
    fn front_strength_uses_recent_peak_and_retains_historic_maximum() {
        let mut front = Front::new();
        front.change(1);
        for sample in [0.4, 0.8, 0.1, 0.15, 0.05] {
            front.sample(sample);
        }
        assert!((front.strength - 0.3125).abs() < 0.000001);
        let cache = front.cache;
        front.sample(-0.5);
        assert_eq!(front.days, 6.0);
        assert_eq!(front.strength, 0.0);
        assert_eq!(front.cache, cache);
        front.change(-1);
        front.sample(-0.6);
        assert!((front.strength - 0.6).abs() < 0.000001);
    }

    #[test]
    fn period_strength_and_delayed_stage_transition_reach_precipitation() {
        let mut period = Period::new();
        period.running = true;
        period.front.strength = 0.8;
        period.front.kind = 1;
        period.count = 2;
        period.stages[0] = Stage::plain(2, 2.0, 0.8, Lerp::Target, Lerp::Target);
        period.stages[0].start = 10.0;
        period.stages[0].entry = 0.8;
        period.stages[1] = Stage::plain(4, 2.0, 0.2, Lerp::Target, Lerp::None);
        period.stages[1].start = 12.0;
        period.current_time = 11.0;
        let mut rain = ClimateFloat::default();
        let mut snow = ClimateBool::default();
        period.update(13.0, (15.0, 15.0), 2, false, &mut rain, &mut snow);
        assert_eq!(
            period.index, 0,
            "source compares previous currentTime before assigning new time"
        );
        assert!(rain.finalize() > 0.0);
        period.update(13.1, (15.0, 15.0), 2, false, &mut rain, &mut snow);
        assert_eq!(period.index, 1);
        assert_eq!(period.stages[1].start, 13.1);
        assert_eq!(period.stages[1].entry.to_bits(), 0.8f32.to_bits());
        period.update(16.0, (15.0, 15.0), 2, false, &mut rain, &mut snow);
        period.update(16.1, (15.0, 15.0), 2, false, &mut rain, &mut snow);
        assert!(!period.running);
        assert_eq!(rain.finalize(), 0.0);
    }

    #[test]
    fn source_override_precedence_controls_rain_and_snow() {
        let mut rain = ClimateFloat {
            internal: 0.2,
            modded: Some((0.6, 0.5)),
            override_value: Some((0.8, 0.5)),
            ..ClimateFloat::default()
        };
        assert!((rain.finalize() - 0.6).abs() < 0.000001);
        rain.admin = Some(0.9);
        assert_eq!(rain.finalize(), 0.9);
        rain.admin = None;
        rain.override_internal = Some(0.1);
        assert!((rain.finalize() - 0.45).abs() < 0.000001);
        let mut snow = ClimateBool {
            internal: false,
            overridden: Some(true),
            modded: Some(false),
            admin: None,
            final_value: false,
        };
        assert!(!snow.finalize());
        snow.admin = Some(true);
        assert!(snow.finalize());
    }

    #[test]
    fn generated_precipitation_evolves_and_restore_continues_exactly() {
        reset();
        assert_eq!(precipitation(), None);
        let empty = save();
        assert!(!empty.is_empty());
        assert_eq!(
            initialize(
                0x12345678,
                clock(0.0, 1993, 0, 0, 0.0),
                b"Sandbox",
                b"America/Chicago"
            ),
            OK
        );
        let mut rainy = false;
        let mut snowy = false;
        for hour in 1..(366 * 24) {
            let (year, month, day) = date_after(1993, 0, 1, hour / 24);
            assert_eq!(
                advance(clock(hour as f64, year, month, day - 1, (hour % 24) as f32)),
                OK
            );
            let (intensity, snow) = precipitation().unwrap();
            assert!((0.0..=1.0).contains(&intensity));
            rainy |= intensity >= 0.1 && !snow;
            snowy |= intensity > 0.0 && snow;
            if rainy && snowy {
                break;
            }
        }
        assert!(
            rainy,
            "generated stages must produce real rain, not a dry baseline"
        );
        assert!(snowy, "winter generation must reach actual snow");
        let saved = save();
        let last = STATE.with(|state| state.borrow().as_ref().unwrap().clock);
        let next = ClockSample {
            world_age_hours: last.world_age_hours + 0.02,
            minute_stamp: last.minute_stamp + 1,
            ..last
        };
        assert_eq!(advance(next), OK);
        let continued = save();
        assert_eq!(load(&saved), OK);
        assert_eq!(
            save(),
            saved,
            "loading must not consume random values or progress stages"
        );
        assert_eq!(advance(next), OK);
        assert_eq!(save(), continued);
        assert_eq!(initialize(9, last, b"Sandbox", b"UTC"), OK);
        assert_eq!(load(&saved), OK);
        assert_eq!(advance(next), OK);
        assert_eq!(
            save(),
            continued,
            "restoration must retain the saved zone, not the new host zone"
        );
        for truncated in [0, 1, saved.len() / 2, saved.len() - 1] {
            assert_eq!(load(&saved[..truncated]), BAD_FORMAT);
            assert_eq!(
                save(),
                continued,
                "failed imports must leave all live state untouched"
            );
        }
        let mut corrupt = saved.clone();
        corrupt.push(0);
        assert_eq!(load(&corrupt), BAD_FORMAT);
        assert_eq!(save(), continued);
        let mut bad_tag = saved.clone();
        bad_tag[8] = 2;
        assert_eq!(load(&bad_tag), BAD_FORMAT);
        let mut nonfinite = saved.clone();
        nonfinite[13..21].copy_from_slice(&f64::NAN.to_bits().to_le_bytes());
        assert_eq!(load(&nonfinite), BAD_FORMAT);
        let mut bad_cursor = saved.clone();
        bad_cursor[2101..2105].copy_from_slice(&0u32.to_le_bytes());
        assert_eq!(load(&bad_cursor), BAD_FORMAT);
        assert_eq!(save(), continued);
        assert_eq!(load(&empty), OK);
        assert!(!configured());
        assert_eq!(precipitation(), None);
    }

    #[test]
    fn rejected_clock_and_modes_do_not_replace_weather() {
        reset();
        let initial = clock(0.0, 1993, 6, 22, 9.0);
        assert_eq!(initialize(7, initial, b"Sandbox", b"America/Chicago"), OK);
        let before = save();
        assert_eq!(
            advance(ClockSample {
                world_age_hours: f64::NAN,
                ..initial
            }),
            NONFINITE
        );
        assert_eq!(
            advance(ClockSample {
                month: 12,
                ..initial
            }),
            OUT_OF_RANGE
        );
        assert_eq!(
            initialize(3, initial, b"The Descending Fog", b"America/Chicago"),
            UNSUPPORTED
        );
        assert_eq!(
            initialize(3, initial, b"Sandbox", b"Not/A_Timezone"),
            UNSUPPORTED
        );
        assert_eq!(save(), before);
    }
}
