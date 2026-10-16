// Derived weather mathematics. Source authority: retained static captures
// 2256, 2258, 2259 and 2261; no original classes execute in this implementation.

use jiff::{Span, Timestamp, civil::DateTime, tz::TimeZone};

const JAVA_MULTIPLIER: u64 = 0x5deece66d;
const JAVA_MASK: u64 = (1 << 48) - 1;

#[derive(Clone, Copy)]
pub(super) struct JavaRandom {
    state: u64,
}

impl JavaRandom {
    pub(super) fn new(seed: i64) -> Self {
        Self {
            state: ((seed as u64) ^ JAVA_MULTIPLIER) & JAVA_MASK,
        }
    }

    pub(super) fn set_seed(&mut self, seed: i64) {
        self.state = ((seed as u64) ^ JAVA_MULTIPLIER) & JAVA_MASK;
    }

    pub(super) fn state(&self) -> u64 {
        self.state
    }

    pub(super) fn from_state(state: u64) -> Self {
        Self {
            state: state & JAVA_MASK,
        }
    }

    fn next_bits(&mut self, bits: u32) -> u32 {
        self.state = self.state.wrapping_mul(JAVA_MULTIPLIER).wrapping_add(11) & JAVA_MASK;
        (self.state >> (48 - bits)) as u32
    }

    pub(super) fn next_float(&mut self) -> f32 {
        self.next_bits(24) as f32 / 16_777_216.0_f32
    }

    pub(super) fn next_int(&mut self, bound: i32) -> i32 {
        bounded_int(bound, || self.next_bits(31))
    }
}

// nextInt's signed-overflow rejection is important even for positive bounds.
fn bounded_int(bound: i32, mut bits: impl FnMut() -> u32) -> i32 {
    assert!(bound > 0);
    if bound & bound.wrapping_neg() == bound {
        return ((bound as i64 * bits() as i64) >> 31) as i32;
    }
    loop {
        let sample = bits() as i32;
        let value = sample % bound;
        if sample.wrapping_sub(value).wrapping_add(bound - 1) >= 0 {
            return value;
        }
    }
}

pub(super) struct CaRandom {
    pub(super) cells: [u8; 2056],
    pub(super) current_index: usize,
}

impl CaRandom {
    pub(super) fn new(seed: u32) -> Self {
        let mut random = Self {
            cells: [0; 2056],
            current_index: 2055,
        };
        // The native seed carrier is little-endian; BinaryUtils interprets
        // those four original entropy bytes as a big-endian signed word.
        let bytes = seed.to_le_bytes();
        for (index, byte) in bytes.iter().enumerate() {
            random.cells[2055 - index] = ((*byte as i8 as i32) + 128) as u8;
        }
        let source_word = i32::from_be_bytes(bytes);
        let word = if source_word == -1 {
            -1
        } else {
            source_word.wrapping_add(1)
        };
        for index in 0..2052 {
            random.cells[index] = (word >> (index % 32)) as u8;
        }
        for _ in 0..1_056_784 {
            random.next_bits(32);
        }
        random
    }

    fn next_bits(&mut self, bits: u32) -> u32 {
        let end = self.current_index;
        let start = end - 3;
        for index in (start + 1..=end).rev() {
            self.cells[index] =
                CA_RULE[(self.cells[index - 1] as usize + self.cells[index] as usize) & 255];
        }
        self.cells[start] = CA_RULE[if start == 0 {
            self.cells[start] as usize
        } else {
            (self.cells[start - 1] as usize + self.cells[start] as usize) & 255
        }];
        self.current_index = if start == 0 { 2055 } else { end - 4 };
        let value = u32::from_le_bytes([
            self.cells[start],
            self.cells[start + 1],
            self.cells[start + 2],
            self.cells[start + 3],
        ]);
        value >> (32 - bits)
    }

    pub(super) fn int_range(&mut self, a: i32, b: i32) -> i32 {
        if a == b {
            return a;
        }
        let (low, high) = if a > b { (b, a) } else { (a, b) };
        bounded_int(high.wrapping_sub(low), || self.next_bits(31)).wrapping_add(low)
    }
}

pub(super) fn climate_offsets(random: &mut CaRandom) -> [f64; 4] {
    [
        random.int_range(0, 8000) as f64,
        random.int_range(8000, 16000) as f64,
        random.int_range(0, -8000) as f64,
        random.int_range(-8000, -16000) as f64,
    ]
}

const CA_RULE: [u8; 256] = [
    100, 75, 16, 3, 229, 51, 197, 118, 24, 62, 198, 11, 141, 152, 241, 188, 2, 17, 71, 47, 179,
    177, 126, 231, 202, 243, 59, 25, 77, 196, 30, 134, 199, 163, 34, 216, 21, 84, 37, 182, 224,
    186, 64, 79, 225, 45, 143, 20, 48, 147, 209, 221, 125, 29, 99, 12, 46, 190, 102, 220, 80, 215,
    242, 105, 15, 53, 0, 67, 68, 69, 70, 89, 109, 195, 170, 78, 210, 131, 42, 110, 181, 145, 40,
    114, 254, 85, 107, 87, 72, 192, 90, 201, 162, 122, 86, 252, 94, 129, 98, 132, 193, 249, 156,
    172, 219, 230, 153, 54, 180, 151, 83, 214, 123, 88, 164, 167, 116, 117, 7, 27, 23, 213, 235, 5,
    65, 124, 60, 127, 236, 149, 44, 28, 58, 121, 191, 13, 250, 10, 232, 112, 101, 217, 183, 239, 8,
    32, 228, 174, 49, 113, 247, 158, 106, 218, 154, 66, 226, 157, 50, 26, 253, 93, 205, 41, 133,
    165, 61, 161, 187, 169, 6, 171, 81, 248, 56, 175, 246, 36, 178, 52, 57, 212, 39, 176, 184, 185,
    245, 63, 35, 189, 206, 76, 104, 233, 194, 19, 43, 159, 108, 55, 200, 155, 14, 74, 244, 255,
    222, 207, 208, 137, 128, 135, 96, 144, 18, 95, 234, 139, 173, 92, 1, 203, 115, 223, 130, 97,
    91, 227, 146, 4, 31, 120, 211, 38, 22, 138, 140, 237, 238, 251, 240, 160, 142, 119, 73, 103,
    166, 33, 148, 9, 111, 136, 168, 150, 82, 204,
];

// Shared fixed permutation used by the source's simplex and erosion noise.
const PERM: [u8; 256] = [
    151, 160, 137, 91, 90, 15, 131, 13, 201, 95, 96, 53, 194, 233, 7, 225, 140, 36, 103, 30, 69,
    142, 8, 99, 37, 240, 21, 10, 23, 190, 6, 148, 247, 120, 234, 75, 0, 26, 197, 62, 94, 252, 219,
    203, 117, 35, 11, 32, 57, 177, 33, 88, 237, 149, 56, 87, 174, 20, 125, 136, 171, 168, 68, 175,
    74, 165, 71, 134, 139, 48, 27, 166, 77, 146, 158, 231, 83, 111, 229, 122, 60, 211, 133, 230,
    220, 105, 92, 41, 55, 46, 245, 40, 244, 102, 143, 54, 65, 25, 63, 161, 1, 216, 80, 73, 209, 76,
    132, 187, 208, 89, 18, 169, 200, 196, 135, 130, 116, 188, 159, 86, 164, 100, 109, 198, 173,
    186, 3, 64, 52, 217, 226, 250, 124, 123, 5, 202, 38, 147, 118, 126, 255, 82, 85, 212, 207, 206,
    59, 227, 47, 16, 58, 17, 182, 189, 28, 42, 223, 183, 170, 213, 119, 248, 152, 2, 44, 154, 163,
    70, 221, 153, 101, 155, 167, 43, 172, 9, 129, 22, 39, 253, 19, 98, 108, 110, 79, 113, 224, 232,
    178, 185, 112, 104, 218, 246, 97, 228, 251, 34, 242, 193, 238, 210, 144, 12, 191, 179, 162,
    241, 81, 51, 145, 235, 249, 14, 239, 107, 49, 192, 214, 31, 181, 199, 106, 157, 184, 84, 204,
    176, 115, 121, 50, 45, 127, 4, 150, 254, 138, 236, 205, 93, 222, 114, 67, 29, 24, 72, 243, 141,
    128, 195, 78, 66, 215, 61, 156, 180,
];

fn perm(index: usize) -> usize {
    PERM[index & 255] as usize
}

fn fast_floor(value: f64) -> i32 {
    let integer = value as i32;
    if value < integer as f64 {
        integer.wrapping_sub(1)
    } else {
        integer
    }
}

pub(super) fn simplex_noise(x: f64, y: f64) -> f64 {
    // Exact f64 results of the source's sqrt(3)-based static initialization.
    let skew_factor = 0.3660254037844386_f64;
    let unskew_factor = 0.21132486540518713_f64;
    let skew = (x + y) * skew_factor;
    let i = fast_floor(x + skew);
    let j = fast_floor(y + skew);
    let unskew = i.wrapping_add(j) as f64 * unskew_factor;
    let x0 = x - (i as f64 - unskew);
    let y0 = y - (j as f64 - unskew);
    let (di, dj) = if x0 > y0 { (1, 0) } else { (0, 1) };
    let x1 = x0 - di as f64 + unskew_factor;
    let y1 = y0 - dj as f64 + unskew_factor;
    let x2 = x0 - 1.0 + 2.0 * unskew_factor;
    let y2 = y0 - 1.0 + 2.0 * unskew_factor;
    let ii = (i & 255) as usize;
    let jj = (j & 255) as usize;
    let a = simplex_corner(x0, y0, perm(ii + perm(jj)) % 12);
    let b = simplex_corner(x1, y1, perm(ii + di + perm(jj + dj)) % 12);
    let c = simplex_corner(x2, y2, perm(ii + 1 + perm(jj + 1)) % 12);
    70.0 * (a + b + c)
}

fn simplex_corner(x: f64, y: f64, gradient: usize) -> f64 {
    const GRADIENTS: [(f64, f64); 12] = [
        (1.0, 1.0),
        (-1.0, 1.0),
        (1.0, -1.0),
        (-1.0, -1.0),
        (1.0, 0.0),
        (-1.0, 0.0),
        (1.0, 0.0),
        (-1.0, 0.0),
        (0.0, 1.0),
        (0.0, -1.0),
        (0.0, 1.0),
        (0.0, -1.0),
    ];
    let attenuation = 0.5 - x * x - y * y;
    if attenuation < 0.0 {
        return 0.0;
    }
    let square = attenuation * attenuation;
    let (gx, gy) = GRADIENTS[gradient];
    square * square * (gx * x + gy * y)
}

struct Noise2D;

impl Noise2D {
    fn layered_noise(x: f32, y: f32) -> f32 {
        let mut total = 0.0_f32;
        let mut amplitude = 0.0_f32;
        for (seed, frequency, weight) in [(64, 8.0_f32, 2.0_f32), (128, 6.0, 4.0), (255, 4.0, 6.0)]
        {
            amplitude += weight;
            total += Self::noise(x * frequency, y * frequency, seed) * weight;
        }
        total / amplitude / 255.0_f32
    }

    fn noise(x: f32, y: f32, seed: usize) -> f32 {
        // Source erosion noise wraps coordinates at 255, not 256, before
        // indexing a seed-rotated 256-entry permutation.
        let ix = (x as f64 - ((x / 255.0_f32) as f64).floor() * 255.0).floor() as usize;
        let iy = (y as f64 - ((y / 255.0_f32) as f64).floor() * 255.0).floor() as usize;
        let u = fade(x - (x as f64).floor() as f32);
        let v = fade(y - (y as f64).floor() as f32);
        let shifted = |index: usize| perm(index.wrapping_sub(seed));
        let left = shifted(ix) + iy;
        let right = shifted(ix + 1) + iy;
        let lower = lerp(u, PERM[shifted(left)] as f32, PERM[shifted(right)] as f32);
        let upper = lerp(
            u,
            PERM[shifted(left + 1)] as f32,
            PERM[shifted(right + 1)] as f32,
        );
        lerp(v, lower, upper)
    }
}

fn fade(value: f32) -> f32 {
    value * value * value * (value * (value * 6.0_f32 - 15.0_f32) + 10.0_f32)
}

fn lerp(fraction: f32, start: f32, end: f32) -> f32 {
    start + fraction * (end - start)
}

fn cosine_lerp(fraction: f32, start: f64, end: f64) -> f64 {
    let weight = (1.0 - (fraction as f64 * std::f64::consts::PI).cos()) / 2.0;
    start * (1.0 - weight) + end * weight
}

type CalendarFields = (i32, i32, i32, i32, i32);

// One prior season year must remain within the supported post-1900 zone
// history. At the upper end, next-day construction can need a third later
// civil year when the cached December solstice receives its 31-day lag.
pub(super) fn supports_year(year: i32) -> bool {
    (1901..=i32::from(jiff::civil::Date::MAX.year()) - 3).contains(&year)
}

fn calendar_local((year, month, day, hour, minute): CalendarFields) -> Option<DateTime> {
    let year = i64::from(year) + i64::from(month).div_euclid(12);
    let month = i64::from(month).rem_euclid(12) + 1;
    let first = DateTime::new(year.try_into().ok()?, month.try_into().ok()?, 1, 0, 0, 0, 0).ok()?;
    let date = first
        .checked_add(Span::new().try_days(i64::from(day) - 1).ok()?)
        .ok()?;
    let minute_delta = i64::from(hour) * 60 + i64::from(minute);
    let local = date
        .checked_add(Span::new().try_minutes(minute_delta).ok()?)
        .ok()?;
    // Java's historical ZoneInfo fallback and Julian cutover are not modeled
    // by IANA civil time. Refuse that domain instead of inventing UTC weather.
    (local.year() >= 1900).then_some(local)
}

pub(super) fn calendar_at(time_zone: &TimeZone, fields: CalendarFields) -> Option<Timestamp> {
    time_zone
        .to_ambiguous_timestamp(calendar_local(fields)?)
        .later()
        .ok()
}

pub(super) fn calendar_date(time_zone: &TimeZone, instant: Timestamp) -> (i32, i32, i32) {
    let local = time_zone.to_datetime(instant);
    (
        i32::from(local.year()),
        i32::from(local.month()) - 1,
        i32::from(local.day()),
    )
}

pub(super) fn calendar_add_days(
    time_zone: &TimeZone,
    instant: Timestamp,
    days: i32,
) -> Option<Timestamp> {
    if days == 0 {
        return Some(instant);
    }
    let local = time_zone.to_datetime(instant);
    let target = local.checked_add(Span::new().try_days(days).ok()?).ok()?;
    if target.year() < 1900 {
        return None;
    }
    // GregorianCalendar.add(DATE) preserves the starting offset first. It
    // then compensates for an offset change only if the desired civil date
    // survives. Unlike constructor resolution, this can keep the earlier
    // occurrence of a fold, or the earlier side of an interior-hour gap.
    let old_offset = time_zone.to_offset(instant);
    let candidate = old_offset.to_timestamp(target).ok()?;
    let difference = old_offset.seconds() - time_zone.to_offset(candidate).seconds();
    if difference == 0 {
        return Some(candidate);
    }
    let adjusted = Timestamp::from_millisecond(
        candidate
            .as_millisecond()
            .checked_add(i64::from(difference) * 1000)?,
    )
    .ok()?;
    if time_zone.to_datetime(adjusted).date() == target.date() {
        Some(adjusted)
    } else {
        Some(candidate)
    }
}

pub(super) fn calendar_minutes_between(from: Timestamp, to: Timestamp) -> i64 {
    to.as_millisecond().wrapping_sub(from.as_millisecond()) / 60_000
}

fn day_diff(a: i64, b: i64) -> f32 {
    (a.wrapping_sub(b) / 86_400_000).wrapping_abs() as f32
}

fn epoch_float(instant: i64) -> f32 {
    instant as f32
}

#[derive(Clone, Copy, Default)]
struct SeasonYear {
    winter_solstice: i64,
    summer_solstice: i64,
    hottest_day: i64,
    coldest_day: i64,
    winter_start: i64,
    winter_end: i64,
    summer_start: i64,
    summer_end: i64,
    winter_strength: f32,
    summer_strength: f32,
}

impl SeasonYear {
    fn new(year: i32, time_zone: &TimeZone) -> Option<Self> {
        let winter_solstice = calendar_at(time_zone, (year, 11, 22, 0, 0))?;
        let summer_solstice = calendar_at(time_zone, (year, 5, 22, 0, 0))?;
        let winter_s = Noise2D::layered_noise(64_i32.wrapping_add(year) as f32, 64.0);
        let winter_e = Noise2D::layered_noise(64.0, 64_i32.wrapping_add(year) as f32);
        let summer_s = Noise2D::layered_noise(128_i32.wrapping_add(year) as f32, 128.0);
        let summer_e = Noise2D::layered_noise(128.0, 128_i32.wrapping_add(year) as f32);
        // ErosionConfig's default minimum is the Java zero field; maximum25
        // gives summerMod=0.5f, winterMod=-0.0f and lag31 civil days.
        Some(Self {
            winter_solstice: winter_solstice.as_millisecond(),
            summer_solstice: summer_solstice.as_millisecond(),
            hottest_day: calendar_add_days(time_zone, summer_solstice, 31)?.as_millisecond(),
            coldest_day: calendar_add_days(time_zone, winter_solstice, 31)?.as_millisecond(),
            winter_start: calendar_add_days(
                time_zone,
                winter_solstice,
                -(40.0_f32 + 20.0_f32 * winter_s).floor() as i32,
            )?
            .as_millisecond(),
            winter_end: calendar_add_days(
                time_zone,
                winter_solstice,
                (40.0_f32 + 20.0_f32 * winter_e).floor() as i32,
            )?
            .as_millisecond(),
            summer_start: calendar_add_days(
                time_zone,
                summer_solstice,
                -(60.0_f32 + 20.0_f32 * summer_s).floor() as i32,
            )?
            .as_millisecond(),
            summer_end: calendar_add_days(
                time_zone,
                summer_solstice,
                (60.0_f32 + 20.0_f32 * summer_e).floor() as i32,
            )?
            .as_millisecond(),
            winter_strength: winter_s + winter_e - 1.0_f32,
            summer_strength: summer_s + summer_e - 1.0_f32,
        })
    }
}

pub(super) struct WeatherMathSeason {
    year: Option<i32>,
    years: [SeasonYear; 3],
    time_zone: TimeZone,
    #[cfg(test)]
    zero_day: i64,
    summer_daylight: f64,
    winter_daylight: f64,
}

impl WeatherMathSeason {
    pub(super) fn new(time_zone: TimeZone) -> Self {
        let latitude = (38.0_f64 * 0.017453292519943295).tan();
        let tilt = (23.44_f64 * 0.017453292519943295).tan();
        Self {
            year: None,
            years: [SeasonYear::default(); 3],
            #[cfg(test)]
            zero_day: calendar_at(&time_zone, (1970, 0, 1, 0, 0))
                .expect("an IANA zone resolves the supported epoch")
                .as_millisecond(),
            time_zone,
            summer_daylight: 2.0 * ((-latitude * tilt).acos() * 57.29577951308232) / 15.0,
            winter_daylight: 2.0 * ((latitude * tilt).acos() * 57.29577951308232) / 15.0,
        }
    }
}

#[derive(Clone, Copy)]
pub(super) struct SeasonDay {
    #[cfg(test)]
    day_temperature: f32,
    pub(super) day_mean_temperature: f32,
    pub(super) season: i32,
    #[cfg(test)]
    season_progress: f32,
    #[cfg(test)]
    season_strength: f32,
    #[cfg(test)]
    cur_day_percent: f32,
    pub(super) dawn: f32,
    pub(super) dusk: f32,
    #[cfg(test)]
    daylight: f32,
    #[cfg(test)]
    high_noon: f32,
}

impl WeatherMathSeason {
    // day is one-based; month is zero-based, as in GregorianCalendar.
    pub(super) fn day(&mut self, day: i32, month: i32, year: i32) -> Option<SeasonDay> {
        let instant = calendar_at(&self.time_zone, (year, month, day, 0, 0))?;
        let (year, _, _) = calendar_date(&self.time_zone, instant);
        if year < 1901 {
            return None;
        }
        if self.year != Some(year) {
            self.years = [
                SeasonYear::new(year.wrapping_sub(1), &self.time_zone)?,
                SeasonYear::new(year, &self.time_zone)?,
                SeasonYear::new(year.wrapping_add(1), &self.time_zone)?,
            ];
            self.year = Some(year);
        }
        let now = instant.as_millisecond();
        let now_float = epoch_float(now);
        let [previous, current, next] = &self.years;
        let season = if now_float < epoch_float(previous.winter_end) {
            5
        } else if now_float < epoch_float(current.summer_start) {
            1
        } else if now_float < epoch_float(current.summer_end) {
            2
        } else if now_float < epoch_float(current.winter_start) {
            4
        } else {
            5
        };
        #[cfg(test)]
        let (start, end) = match season {
            1 => (previous.winter_end, current.summer_start),
            2 => (current.summer_start, current.summer_end),
            4 => (current.summer_end, current.winter_start),
            _ if now_float < epoch_float(previous.winter_end) => {
                (previous.winter_start, previous.winter_end)
            }
            _ => (current.winter_start, current.winter_end),
        };
        #[cfg(test)]
        let season_days = day_diff(start, end);
        let (from, to, temperature_start, temperature_end) = if now_float
            < epoch_float(previous.coldest_day)
            && now_float >= epoch_float(previous.hottest_day)
        {
            (
                previous.hottest_day,
                previous.coldest_day,
                25.0_f32 + 3.0_f32 * previous.summer_strength,
                0.0_f32 + 3.0_f32 * previous.winter_strength,
            )
        } else if now_float < epoch_float(current.hottest_day)
            && now_float >= epoch_float(previous.coldest_day)
        {
            (
                previous.coldest_day,
                current.hottest_day,
                0.0_f32 + 3.0_f32 * previous.winter_strength,
                25.0_f32 + 3.0_f32 * current.summer_strength,
            )
        } else if now_float < epoch_float(current.coldest_day)
            && now_float >= epoch_float(current.hottest_day)
        {
            (
                current.hottest_day,
                current.coldest_day,
                25.0_f32 + 3.0_f32 * current.summer_strength,
                0.0_f32 + 3.0_f32 * current.winter_strength,
            )
        } else {
            (
                current.coldest_day,
                next.hottest_day,
                0.0_f32 + 3.0_f32 * current.winter_strength,
                25.0_f32 + 3.0_f32 * next.summer_strength,
            )
        };
        let mean_temperature = cosine_lerp(
            day_diff(now, from) / day_diff(from, to),
            temperature_start as f64,
            temperature_end as f64,
        ) as f32;
        // The source computes dayTemperature too, but its ClimateValues
        // comparison result is never consumed by the precipitation chain.
        #[cfg(test)]
        let noise = Noise2D::layered_noise(day_diff(self.zero_day, now) / 20.0_f32, 0.0);
        let (first_half, solstice_start, solstice_end) =
            if now < current.winter_solstice && now >= current.summer_solstice {
                (false, current.summer_solstice, current.winter_solstice)
            } else if now >= current.winter_solstice {
                (true, current.winter_solstice, next.summer_solstice)
            } else {
                (true, previous.winter_solstice, current.summer_solstice)
            };
        let fraction = day_diff(now, solstice_start) / day_diff(solstice_start, solstice_end);
        let (daylight, cur_day_percent) = if first_half {
            (
                cosine_lerp(fraction, self.winter_daylight, self.summer_daylight) as f32,
                fraction,
            )
        } else {
            (
                cosine_lerp(fraction, self.summer_daylight, self.winter_daylight) as f32,
                1.0_f32 - fraction,
            )
        };
        let high_noon = 12.5_f32 + 2.0_f32 * cur_day_percent;
        Some(SeasonDay {
            #[cfg(test)]
            day_temperature: mean_temperature + 7.0_f32 * (noise * 2.0_f32 - 1.0_f32),
            day_mean_temperature: mean_temperature,
            season,
            #[cfg(test)]
            season_progress: day_diff(now, start) / season_days,
            #[cfg(test)]
            season_strength: season_days / 90.0_f32 - 1.0_f32,
            #[cfg(test)]
            cur_day_percent,
            dawn: high_noon - daylight / 2.0_f32,
            dusk: high_noon + daylight / 2.0_f32,
            #[cfg(test)]
            daylight,
            #[cfg(test)]
            high_noon,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn erosion_noise_keeps_nested_permutation_and_float_division() {
        assert_eq!(Noise2D::layered_noise(0.0, 0.0), 0.30522877_f32);
        let mut season = WeatherMathSeason::new(TimeZone::get("UTC").unwrap());
        assert_eq!(
            season.day(23, 6, 1993).unwrap().day_mean_temperature,
            25.327452_f32
        );
    }

    #[test]
    fn source_summer_boundaries_keep_progress_and_length() {
        let mut season = WeatherMathSeason::new(TimeZone::get("UTC").unwrap());
        assert_eq!(season.day(12, 3, 1993).unwrap().season, 1);
        let start = season.day(13, 3, 1993).unwrap();
        assert_eq!(start.season, 2);
        assert_eq!(start.season_progress, 0.0);
        assert_eq!(start.season_strength, 142.0_f32 / 90.0_f32 - 1.0_f32);
        assert_eq!(season.day(1, 8, 1993).unwrap().season, 2);
        let autumn = season.day(2, 8, 1993).unwrap();
        assert_eq!(autumn.season, 4);
        assert_eq!(autumn.season_progress, 0.0);
    }

    fn minutes(time_zone: &TimeZone, from: CalendarFields, to: CalendarFields) -> i64 {
        calendar_minutes_between(
            calendar_at(time_zone, from).unwrap(),
            calendar_at(time_zone, to).unwrap(),
        )
    }

    #[test]
    fn calendar_poll_minutes_preserve_signed_subday_delta() {
        let time_zone = TimeZone::get("America/Chicago").unwrap();
        assert_eq!(
            minutes(&time_zone, (1993, 6, 23, 9, 30), (1993, 6, 20, 0, 0)),
            -4890,
        );
        assert_eq!(
            minutes(&time_zone, (1999, 11, 31, 23, 45), (2000, 0, 1, 0, 15)),
            30,
        );
    }

    #[test]
    fn source_timezone_keeps_dst_truncation_fold_later_and_gap_forward() {
        let time_zone = TimeZone::get("America/Chicago").unwrap();
        assert_eq!(
            minutes(&time_zone, (1993, 3, 4, 0, 0), (1993, 3, 5, 0, 0)),
            1380
        );
        assert_eq!(
            minutes(&time_zone, (1993, 9, 31, 0, 0), (1993, 10, 1, 0, 0)),
            1500
        );
        assert_eq!(
            minutes(&time_zone, (1993, 9, 31, 1, 30), (1993, 9, 31, 2, 30)),
            60
        );
        assert_eq!(
            minutes(&time_zone, (1993, 3, 4, 2, 30), (1993, 3, 4, 3, 30)),
            0
        );
        let start = calendar_at(&time_zone, (1993, 3, 4, 0, 0)).unwrap();
        let end = calendar_at(&time_zone, (1993, 3, 5, 0, 0)).unwrap();
        assert_eq!(day_diff(start.as_millisecond(), end.as_millisecond()), 0.0);
        assert_eq!(
            minutes(&time_zone, (2200, 0, 1, 0, 0), (2200, 6, 1, 0, 0)),
            260580
        );
    }

    #[test]
    fn calendar_matches_independent_browser_epoch_and_elapsed_goldens() {
        let time_zone = TimeZone::get("America/Chicago").unwrap();
        // Independent Chromium Date/Intl observations, not original classes
        // or values obtained from the implementation under test.
        for (from, to, from_ms, to_ms, days, elapsed_minutes) in [
            (
                (1993, 2, 31, 0, 0),
                (1993, 3, 5, 0, 0),
                733_557_600_000_i64,
                733_986_000_000_i64,
                4.0_f32,
                7140,
            ),
            (
                (1993, 9, 29, 0, 0),
                (1993, 10, 1, 0, 0),
                751_870_800_000,
                752_133_600_000,
                3.0,
                4380,
            ),
            (
                (2101, 2, 1, 0, 0),
                (2101, 3, 1, 0, 0),
                4_139_100_000_000,
                4_141_774_800_000,
                30.0,
                44580,
            ),
        ] {
            let from = calendar_at(&time_zone, from).unwrap();
            let to = calendar_at(&time_zone, to).unwrap();
            assert_eq!(from.as_millisecond(), from_ms);
            assert_eq!(to.as_millisecond(), to_ms);
            assert_eq!(day_diff(from_ms, to_ms), days);
            assert_eq!(calendar_minutes_between(from, to), elapsed_minutes);
        }
    }

    #[test]
    fn calendar_add_keeps_prior_fold_offset_and_source_gap_adjustment() {
        let time_zone = TimeZone::get("America/Chicago").unwrap();
        let before_fold = calendar_at(&time_zone, (1993, 9, 30, 1, 30)).unwrap();
        let earlier_fold = calendar_add_days(&time_zone, before_fold, 1).unwrap();
        let later_fold = calendar_at(&time_zone, (1993, 9, 31, 1, 30)).unwrap();
        assert_eq!(calendar_minutes_between(earlier_fold, later_fold), 60);
        let before_gap = calendar_at(&time_zone, (1993, 3, 3, 2, 30)).unwrap();
        let added = calendar_add_days(&time_zone, before_gap, 1).unwrap();
        assert_eq!(calendar_date(&time_zone, added), (1993, 3, 4));
        assert_eq!(time_zone.to_datetime(added).hour(), 1);
        assert_eq!(time_zone.to_datetime(added).minute(), 30);
    }

    #[test]
    fn calendar_addition_preserves_gap_normalized_wall_clock() {
        let time_zone = TimeZone::get("America/Sao_Paulo").unwrap();
        let normalized = calendar_at(&time_zone, (2018, 10, 4, 0, 0)).unwrap();
        assert_eq!(calendar_date(&time_zone, normalized), (2018, 10, 4));
        assert_eq!(time_zone.to_datetime(normalized).hour(), 1);
        let previous = calendar_add_days(&time_zone, normalized, -3).unwrap();
        assert_eq!(calendar_date(&time_zone, previous), (2018, 10, 1));
        assert_eq!(time_zone.to_datetime(previous).hour(), 1);
        let apia = TimeZone::get("Pacific/Apia").unwrap();
        let skipped = calendar_at(&apia, (2011, 11, 30, 0, 0)).unwrap();
        let next = calendar_add_days(&apia, skipped, 1).unwrap();
        assert_eq!(calendar_date(&apia, next), (2012, 0, 1));
    }

    #[test]
    fn cellular_entropy_bytes_warmup_and_integer_offsets_match_static_fixture() {
        // Entropy bytes80 ff00 01, carried little-endian across the ABI.
        // Fixture calculated independently from the retained CA transition
        // and Java nextInt arithmetic, never by executing the original class.
        let mut random = CaRandom::new(0x0100_ff80);
        assert_eq!(
            climate_offsets(&mut random),
            [7076.0, 8284.0, -4758.0, -11188.0]
        );
        assert_eq!(random.current_index, 2039);
    }

    #[test]
    fn equal_random_range_does_not_consume_boundary_cells() {
        let mut random = CaRandom {
            cells: [255; 2056],
            current_index: 3,
        };
        assert_eq!(random.int_range(7, 7), 7);
        assert_eq!(random.next_bits(32), 0x5252_52cc);
        assert_eq!(random.current_index, 2055);
    }

    #[test]
    fn java_random_preserves_float_bits_and_internal_state() {
        let mut random = JavaRandom::new(0);
        assert_eq!(random.next_float(), 0.73096776_f32);
        let mut restored = JavaRandom::from_state(random.state());
        for bound in [1, 2, 100, 1_073_741_825, i32::MAX] {
            assert_eq!(random.next_int(bound), restored.next_int(bound));
        }
        random.set_seed(0);
        assert_eq!(random.next_int(100), 60);
        random.set_seed(0);
        assert_eq!(random.next_int(1_073_741_825), 516_548_029);
    }

    #[test]
    fn java_negative_seed_preserves_signed_long_scramble() {
        let mut random = JavaRandom::new(-1);
        assert_eq!(random.state(), 281_449_761_806_738);
        assert_eq!(random.next_int(100), 13);
        assert_eq!(random.state(), 75_700_622_266_165);
        random.set_seed(i64::MAX);
        assert_eq!(random.next_float(), 0.2689426_f32);
    }

    #[test]
    fn cellular_draw_updates_four_cells_and_wraps_at_zero() {
        let mut random = CaRandom {
            cells: [0; 2056],
            current_index: 3,
        };
        assert_eq!(random.next_bits(32), 0x6464_6464);
        assert_eq!(random.current_index, 2055);
        assert_eq!(random.next_bits(24), 0x646464);
        assert_eq!(random.current_index, 2051);
    }

    #[test]
    fn cellular_save_continues_across_a_complete_sweep() {
        let mut random = CaRandom::new(0x80ff_0001);
        let offsets = climate_offsets(&mut random);
        assert!((0.0..8000.0).contains(&offsets[0]));
        assert!((8000.0..16000.0).contains(&offsets[1]));
        assert!((-8000.0..0.0).contains(&offsets[2]));
        assert!((-16000.0..-8000.0).contains(&offsets[3]));
        let mut restored = CaRandom {
            cells: random.cells,
            current_index: random.current_index,
        };
        for _ in 0..600 {
            assert_eq!(random.int_range(0, 8000), restored.int_range(0, 8000));
            assert_eq!(random.next_bits(24), restored.next_bits(24));
        }
    }

    #[test]
    fn simplex_uses_signed_coordinates_and_double_precision() {
        assert_eq!(simplex_noise(0.0, 0.0), 0.0);
        assert!((simplex_noise(0.1, 0.2) - (-0.294107569872242)).abs() < 1e-14);
        assert!((simplex_noise(-0.1, -0.2) - 0.285282895159297).abs() < 1e-14);
    }

    #[test]
    fn calendar_keeps_lenient_source_dates_and_refuses_unmodeled_history() {
        let time_zone = TimeZone::get("UTC").unwrap();
        assert_eq!(
            minutes(&time_zone, (2000, 1, 28, 0, 0), (2000, 2, 1, 0, 0)),
            2880
        );
        assert_eq!(
            minutes(&time_zone, (1900, 1, 28, 0, 0), (1900, 2, 1, 0, 0)),
            1440
        );
        assert_eq!(
            calendar_date(
                &time_zone,
                calendar_at(&time_zone, (1993, 6, 0, 0, 0)).unwrap()
            ),
            (1993, 5, 30)
        );
        assert!(calendar_at(&time_zone, (1582, 9, 4, 0, 0)).is_none());
        assert!(!supports_year(1900));
        assert!(supports_year(1901));
        let mut season = WeatherMathSeason::new(time_zone);
        assert!(season.day(31, 11, 9996).is_some());
        assert!(season.day(1, 0, 9997).is_some());
        assert!(!supports_year(9997));
        assert!(season.day(1, 0, 9998).is_none());
    }

    #[test]
    fn season_restoration_keeps_solstice_and_day_temperature() {
        let mut season = WeatherMathSeason::new(TimeZone::get("UTC").unwrap());
        let summer = season.day(22, 5, 1993).unwrap();
        assert_eq!(summer.season, 2);
        assert_eq!(summer.cur_day_percent, 1.0);
        assert_eq!(summer.high_noon, 14.5);
        assert!((summer.daylight - 14.640019).abs() < 0.00001);
        let winter = season.day(22, 11, 1993).unwrap();
        assert_eq!(winter.season, 5);
        assert_eq!(winter.cur_day_percent, 0.0);
        assert_eq!(winter.high_noon, 12.5);
        assert!((winter.daylight - 9.359981).abs() < 0.00001);
        let mut restored = WeatherMathSeason::new(TimeZone::get("UTC").unwrap());
        let same = restored.day(22, 11, 1993).unwrap();
        assert_eq!(
            same.day_temperature.to_bits(),
            winter.day_temperature.to_bits()
        );
        assert_eq!(
            same.day_mean_temperature.to_bits(),
            winter.day_mean_temperature.to_bits()
        );
        assert_eq!(
            same.season_progress.to_bits(),
            winter.season_progress.to_bits()
        );
        assert!(summer.day_mean_temperature > winter.day_mean_temperature);
    }
}
