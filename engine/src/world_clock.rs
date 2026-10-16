//! Source standalone GameTime fields. Calendar setters assign directly; only
//! reached calendar indexing and nonfinite advancement are refused atomically.
use crate::{F32_MAX, NONFINITE, OK, OUT_OF_RANGE};
use std::cell::RefCell;

#[derive(Clone, Copy)]
struct WorldClock {
    year: i32,
    month: i32,
    day: i32,
    time_of_day: f32,
    last_time_of_day: f32,
    nights_survived: i32,
    minutes_per_day: f32,
}
impl WorldClock {
    const fn initial() -> Self {
        Self {
            year: 1993,
            month: 6,
            day: 22,
            time_of_day: 9.0,
            last_time_of_day: 9.0,
            nights_survived: 0,
            minutes_per_day: 90.0,
        }
    }
    fn values(self) -> [f64; 7] {
        [
            self.year as f64,
            self.month as f64,
            self.day as f64,
            self.time_of_day as f64,
            self.last_time_of_day as f64,
            self.nights_survived as f64,
            self.minutes_per_day as f64,
        ]
    }
    fn from_values(values: [f64; 7]) -> Result<Self, i32> {
        for (index, value) in values.into_iter().enumerate() {
            if !value.is_finite() {
                return Err(NONFINITE);
            }
            if matches!(index, 0 | 1 | 2 | 5) {
                if value.fract() != 0.0 || !(i32::MIN as f64..=i32::MAX as f64).contains(&value) {
                    return Err(OUT_OF_RANGE);
                }
            } else if value.abs() > F32_MAX {
                return Err(OUT_OF_RANGE);
            }
        }
        Ok(Self {
            year: values[0] as i32,
            month: values[1] as i32,
            day: values[2] as i32,
            time_of_day: values[3] as f32,
            last_time_of_day: values[4] as f32,
            nights_survived: values[5] as i32,
            minutes_per_day: values[6] as f32,
        })
    }
    fn age(self) -> f32 {
        let base = self.nights_survived as f32 * 24.0_f32;
        let hours = if self.time_of_day >= 7.0 {
            self.time_of_day - 7.0_f32
        } else {
            self.time_of_day + 17.0_f32
        };
        base + hours
    }
}
thread_local! {
    static CLOCK: RefCell<WorldClock> = const { RefCell::new(WorldClock::initial()) };
}
pub(super) fn reset() {
    CLOCK.with(|state| *state.borrow_mut() = WorldClock::initial());
}
pub(super) fn age() -> f32 {
    CLOCK.with(|state| state.borrow().age())
}
pub(crate) fn sample() -> crate::weather::ClockSample {
    CLOCK.with(|state| {
        let clock = *state.borrow();
        let age = clock.age() as f64;
        let minutes = ((clock.time_of_day - (clock.time_of_day as i32) as f32) * 60.0_f32) as i32;
        crate::weather::ClockSample {
            world_age_hours: age,
            time_of_day: clock.time_of_day,
            year: clock.year,
            month: clock.month,
            day: clock.day,
            minute_stamp: (age as i64).wrapping_mul(60).wrapping_add(minutes as i64),
        }
    })
}
pub(super) fn advance_frame(multiplier: f32) -> i32 {
    let previous = CLOCK.with(|state| *state.borrow());
    let result = advance(multiplier);
    if result != OK {
        return result;
    }
    let result = crate::weather::advance(sample());
    if result != OK {
        CLOCK.with(|state| *state.borrow_mut() = previous);
    }
    result
}
pub(super) fn check_hours(last: f32, now: f32) -> f32 {
    if last < 0.0 || last > now { now } else { last }
}
pub(super) fn advance(multiplier: f32) -> i32 {
    CLOCK.with(|state| {
        let mut next = *state.borrow();
        let old = next.time_of_day;
        let delta = (((1.0_f32 / next.minutes_per_day) / 60.0_f32) * multiplier) / 2.0_f32;
        next.time_of_day += delta;
        if !next.time_of_day.is_finite() {
            return NONFINITE;
        }
        if old <= 7.0 && next.time_of_day > 7.0 {
            next.nights_survived = next.nights_survived.wrapping_add(1);
        }
        if next.time_of_day >= 24.0 {
            let days = match days_in_month(next.year, next.month) {
                Ok(days) => days,
                Err(code) => return code,
            };
            next.time_of_day -= 24.0_f32;
            next.day = next.day.wrapping_add(1);
            if next.day >= days {
                next.day = 0;
                next.month = next.month.wrapping_add(1);
                if next.month >= 12 {
                    next.month = 0;
                    next.year = next.year.wrapping_add(1);
                }
            }
        }
        if !next.age().is_finite() {
            return NONFINITE;
        }
        *state.borrow_mut() = next;
        OK
    })
}
fn days_in_month(year: i32, month: i32) -> Result<i32, i32> {
    let days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let Some(&days) = days.get(month as usize) else {
        return Err(OUT_OF_RANGE);
    };
    // PZCalendar delegates to the unmodified default GregorianCalendar cutover.
    let leap = year & 3 == 0 && (year <= 1582 || year % 100 != 0 || year % 400 == 0);
    Ok(days + i32::from(month == 1 && leap))
}
#[unsafe(no_mangle)]
pub extern "C" fn world_clock_get(field: u32) -> f64 {
    CLOCK.with(|state| {
        let clock = *state.borrow();
        match field {
            0..=6 => clock.values()[field as usize],
            7 => clock.age() as f64,
            8 => (((clock.time_of_day * 3600.0_f32) as f64).floor() / 3600.0).floor() as i32 as f64,
            9 => ((clock.time_of_day - (clock.time_of_day as i32) as f32) * 60.0_f32) as i32 as f64,
            _ => f64::NAN,
        }
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn world_clock_import(
    year: f64,
    month: f64,
    day: f64,
    time: f64,
    last: f64,
    nights: f64,
    minutes: f64,
) -> i32 {
    match WorldClock::from_values([year, month, day, time, last, nights, minutes]) {
        Ok(clock) => {
            CLOCK.with(|state| *state.borrow_mut() = clock);
            OK
        }
        Err(code) => code,
    }
}
#[unsafe(no_mangle)]
pub extern "C" fn world_clock_set(field: u32, value: f64) -> i32 {
    if field > 6 {
        return OUT_OF_RANGE;
    }
    let mut values = CLOCK.with(|state| state.borrow().values());
    values[field as usize] = value;
    match WorldClock::from_values(values) {
        Ok(clock) => {
            CLOCK.with(|state| *state.borrow_mut() = clock);
            OK
        }
        Err(code) => code,
    }
}
#[unsafe(no_mangle)]
pub extern "C" fn world_clock_days_in_month(year: i32, month: i32) -> i32 {
    days_in_month(year, month).unwrap_or_else(|code| code)
}
#[unsafe(no_mangle)]
pub extern "C" fn world_clock_check_hours(last: f64, now: f64) -> f64 {
    if !last.is_finite() || !now.is_finite() || last.abs() > F32_MAX || now.abs() > F32_MAX {
        return f64::NAN;
    }
    check_hours(last as f32, now as f32) as f64
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn malformed_reached_calendar_and_overflow_refuse_atomically() {
        reset();
        assert_eq!(world_clock_set(1, 37.0), OK);
        assert_eq!(world_clock_set(3, 24.0), OK);
        assert_eq!(advance(0.8), OUT_OF_RANGE);
        assert_eq!(world_clock_get(3), 24.0);
        assert_eq!(world_clock_set(6, 0.0), OK);
        assert_eq!(advance(0.8), NONFINITE);
        assert_eq!(world_clock_get(3), 24.0);
        assert_eq!(
            world_clock_import(1993.0, 6.0, 22.0, 9.0, 9.0, 0.0, f64::NAN),
            NONFINITE
        );
        assert_eq!(world_clock_get(1), 37.0);
        assert_eq!(days_in_month(1500, 1), Ok(29));
        assert_eq!(days_in_month(1700, 1), Ok(28));
        assert_eq!(days_in_month(-100, 1), Ok(29));
    }
}
