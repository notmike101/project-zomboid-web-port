//! Source awake standalone clock and supported pickup/transfer trait entries.
//! Empty selected traits are the new port actor policy, not original startup.

use std::cell::RefCell;

use crate::{BAD_FORMAT, F32_MAX, NONFINITE, OK, OUT_OF_RANGE};

// ponytail: 128 UTF-8 bytes matches this ABI; revise it only with a versioned ABI.
const MODE_BYTES: usize = 128;
const CONTEXT_HEADER: usize = 12;

pub(super) struct TimingContext {
    pub multiplier: f32,
    pub bias: f32,
    pub per_object: f32,
    pub fps: f32,
    pub elapsed: f32,
    pub slow: [bool; 3],
    pub instant: bool,
    pub traits: [bool; 3],
    pub game_mode: Vec<u8>,
}

impl TimingContext {
    fn initial() -> Self {
        Self {
            multiplier: 1.0,
            bias: 1.0,
            per_object: 1.0,
            fps: 1.0,
            elapsed: 0.0,
            slow: [false; 3],
            instant: false,
            traits: [false; 3],
            game_mode: b"Sandbox".to_vec(),
        }
    }

    fn slow_multiplier(&self) -> f32 {
        let ordinal =
            (u32::from(self.slow[0]) + 2 * u32::from(self.slow[1]) + 3 * u32::from(self.slow[2]))
                .min(6);
        // All source enum powers are exactly representable in f32.
        1.0 / (1_u32 << ordinal) as f32
    }

    fn game_multiplier(&self) -> f32 {
        // Java rounds at each f32 multiply, including its final 0.8f factor.
        let mut value = 1.0_f32;
        value *= self.multiplier;
        value *= self.fps;
        value *= self.bias;
        value *= self.per_object;
        value *= self.slow_multiplier();
        value *= 0.8_f32;
        value
    }
}

struct ModeStaging {
    bytes: [u8; MODE_BYTES],
    length: usize,
    next: usize,
}

thread_local! {
    static TIMING: RefCell<TimingContext> = RefCell::new(TimingContext::initial());
    static MODE_STAGING: RefCell<Option<ModeStaging>> = const { RefCell::new(None) };
    static SCRATCH: RefCell<[f64; 16]> = const { RefCell::new([0.0; 16]) };
}

pub(super) fn reset() {
    restore_validated(TimingContext::initial());
}

pub(super) fn frame(elapsed_seconds: f64) {
    TIMING.with(|state| {
        let mut state = state.borrow_mut();
        state.elapsed = elapsed_seconds as f32;
        if elapsed_seconds > 0.0 {
            state.fps = ((60.0 / (1.0 / elapsed_seconds)) as f32).min(5.0);
        }
    });
}

pub(super) fn multiplier() -> f32 {
    TIMING.with(|state| state.borrow().game_multiplier())
}

#[cfg(test)]
pub(super) fn elapsed_seconds() -> f32 {
    TIMING.with(|state| state.borrow().elapsed)
}

pub(super) fn has_trait(index: u32) -> Result<bool, i32> {
    TIMING.with(|state| {
        state
            .borrow()
            .traits
            .get(index as usize)
            .copied()
            .ok_or(OUT_OF_RANGE)
    })
}

pub(super) fn pickup_base(weight: f32, carried: f32, max_weight: i32, awkward_gloves: bool) -> f64 {
    TIMING.with(|state| {
        let state = state.borrow();
        let mut time =
            120.0 * (weight as f64).min(3.0) * ((carried as f64) / max_weight as f64).max(0.4);
        if state.game_mode == b"LastStand" {
            time *= 0.3;
        }
        if state.traits[0] {
            time *= 0.5;
        }
        if state.traits[1] || awkward_gloves {
            time *= 2.0;
        }
        if state.instant { 1.0 } else { time }
    })
}

/// Original ISInventoryTransferAction transfer time; retain Lua-double operation
/// order and its conditional delta clamp, including NaN and favorite-last policy.
pub(super) fn transfer_base(
    weight: f32,
    base: f64,
    capacity_delta: f64,
    floor_factor: f64,
    awkward_gloves: bool,
    favorite_leaving: bool,
) -> f64 {
    TIMING.with(|state| {
        let state = state.borrow();
        let weight = weight as f64;
        let weight = if weight > 3.0 { 3.0 } else { weight };
        let delta = if capacity_delta < 0.4 {
            0.4
        } else {
            capacity_delta
        };
        let mut time = base * weight * delta;
        if state.game_mode == b"LastStand" {
            time *= 0.3;
        }
        time *= floor_factor;
        if state.traits[0] {
            time *= 0.5;
        }
        if state.traits[1] || awkward_gloves {
            time *= 2.0;
        }
        if state.instant {
            time = 1.0;
        }
        if favorite_leaving {
            time = 0.0;
        }
        time
    })
}

pub(super) fn adjust_initial(
    base: f64,
    unhappy: u32,
    drunk: u32,
    hand_forearm_pain: [f32; 4],
    thermal: f32,
) -> i32 {
    let mut time = base;
    if time > 1.0 {
        time *= 1.0 + unhappy as f64 / 4.0;
        time *= 1.0 + drunk as f64 / 4.0;
        let pain = hand_forearm_pain[0] as f64
            + hand_forearm_pain[1] as f64
            + hand_forearm_pain[2] as f64
            + hand_forearm_pain[3] as f64;
        time *= 1.0 + pain / 300.0;
        time *= thermal as f64;
    }
    // Java narrowing: truncate, saturate infinities/overflow, NaN becomes zero.
    time as i32
}

#[unsafe(no_mangle)]
pub extern "C" fn source_timing_scratch_ptr() -> *mut u8 {
    SCRATCH.with(|scratch| scratch.as_ptr().cast())
}

#[unsafe(no_mangle)]
pub extern "C" fn source_timing_scratch_size() -> u32 {
    std::mem::size_of::<[f64; 16]>() as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn source_timing_read() -> i32 {
    TIMING.with(|state| {
        let state = state.borrow();
        let row = [
            state.multiplier as f64,
            state.bias as f64,
            state.per_object as f64,
            state.fps as f64,
            state.elapsed as f64,
            state.slow_multiplier() as f64,
            u32::from(state.slow[0]) as f64,
            u32::from(state.slow[1]) as f64,
            u32::from(state.slow[2]) as f64,
            u32::from(state.instant) as f64,
            u32::from(state.traits[0]) as f64,
            u32::from(state.traits[1]) as f64,
            state.game_mode.len() as f64,
            state.game_multiplier() as f64,
            u32::from(state.traits[2]) as f64,
            0.0,
        ];
        SCRATCH.with(|scratch| *scratch.borrow_mut() = row);
    });
    OK
}

#[unsafe(no_mangle)]
pub extern "C" fn source_timing_set(field: u32, value: f64) -> i32 {
    if field > 6 {
        return OUT_OF_RANGE;
    }
    if !value.is_finite() {
        return NONFINITE;
    }
    if (field <= 2 && !(-F32_MAX..=F32_MAX).contains(&value))
        || (field >= 3 && value != 0.0 && value != 1.0)
    {
        return OUT_OF_RANGE;
    }
    TIMING.with(|state| {
        let mut state = state.borrow_mut();
        match field {
            0 => state.multiplier = value as f32,
            1 => state.bias = value as f32,
            2 => state.per_object = value as f32,
            3..=5 => state.slow[field as usize - 3] = value != 0.0,
            6 => state.instant = value != 0.0,
            _ => unreachable!(),
        }
    });
    OK
}

#[unsafe(no_mangle)]
pub extern "C" fn source_trait_get(index: u32) -> i32 {
    match has_trait(index) {
        Ok(value) => i32::from(value),
        Err(code) => code,
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn source_trait_set(index: u32, enabled: u32) -> i32 {
    if index >= 3 || enabled > 1 {
        return OUT_OF_RANGE;
    }
    TIMING.with(|state| state.borrow_mut().traits[index as usize] = enabled != 0);
    OK
}

#[unsafe(no_mangle)]
pub extern "C" fn source_mode_begin(byte_count: u32) -> i32 {
    MODE_STAGING.with(|staging| {
        let mut staging = staging.borrow_mut();
        *staging = None;
        if byte_count as usize > MODE_BYTES {
            return OUT_OF_RANGE;
        }
        *staging = Some(ModeStaging {
            bytes: [0; MODE_BYTES],
            length: byte_count as usize,
            next: 0,
        });
        OK
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn source_mode_byte(index: u32, byte: u32) -> i32 {
    MODE_STAGING.with(|staging| {
        let mut staging = staging.borrow_mut();
        if byte > 255 {
            *staging = None;
            return OUT_OF_RANGE;
        }
        if let Some(candidate) = staging.as_mut()
            && index as usize == candidate.next
            && candidate.next < candidate.length
        {
            candidate.bytes[candidate.next] = byte as u8;
            candidate.next += 1;
            return OK;
        }
        *staging = None;
        BAD_FORMAT
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn source_mode_commit() -> i32 {
    MODE_STAGING.with(|staging| {
        let Some(candidate) = staging.borrow_mut().take() else {
            return BAD_FORMAT;
        };
        let bytes = &candidate.bytes[..candidate.length];
        if candidate.next != candidate.length || std::str::from_utf8(bytes).is_err() {
            return BAD_FORMAT;
        }
        TIMING.with(|state| {
            let mut state = state.borrow_mut();
            state.game_mode.clear();
            state.game_mode.extend_from_slice(bytes);
        });
        OK
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn source_mode_get_byte(index: u32) -> i32 {
    TIMING.with(|state| {
        state
            .borrow()
            .game_mode
            .get(index as usize)
            .map_or(OUT_OF_RANGE, |&byte| byte as i32)
    })
}

/// Five raw f32 words, three slow flags, instant, dextrous/hemophobic bits,
/// allthumbs, byte count, then UTF-8 bytes. Queue v1 permits only dextrous bit0.
pub(super) fn snapshot_words() -> Vec<u32> {
    TIMING.with(|state| {
        let state = state.borrow();
        let mut words = Vec::with_capacity(CONTEXT_HEADER + state.game_mode.len());
        words.extend_from_slice(&[
            state.multiplier.to_bits(),
            state.bias.to_bits(),
            state.per_object.to_bits(),
            state.fps.to_bits(),
            state.elapsed.to_bits(),
            u32::from(state.slow[0]),
            u32::from(state.slow[1]),
            u32::from(state.slow[2]),
            u32::from(state.instant),
            u32::from(state.traits[0]) | (u32::from(state.traits[2]) << 1),
            u32::from(state.traits[1]),
            state.game_mode.len() as u32,
        ]);
        words.extend(state.game_mode.iter().map(|&byte| byte as u32));
        words
    })
}

pub(super) fn validate_words(words: &[u32]) -> Result<TimingContext, i32> {
    if words.len() < CONTEXT_HEADER {
        return Err(BAD_FORMAT);
    }
    let length = words[11] as usize;
    if length > MODE_BYTES || words.len() != CONTEXT_HEADER + length {
        return Err(BAD_FORMAT);
    }
    let multiplier = f32::from_bits(words[0]);
    let bias = f32::from_bits(words[1]);
    let per_object = f32::from_bits(words[2]);
    let fps = f32::from_bits(words[3]);
    let elapsed = f32::from_bits(words[4]);
    if !multiplier.is_finite()
        || !bias.is_finite()
        || !per_object.is_finite()
        || !fps.is_finite()
        || !(0.0..=5.0).contains(&fps)
        || elapsed.is_nan()
        || elapsed == f32::NEG_INFINITY
        || words[5..9].iter().any(|&value| value > 1)
        || words[9] & !3 != 0
        || words[10] > 1
        || words[CONTEXT_HEADER..].iter().any(|&byte| byte > 255)
    {
        return Err(BAD_FORMAT);
    }
    // Positive elapsed overflow is a legitimate f64 -> f32 frame cast.
    let game_mode: Vec<u8> = words[CONTEXT_HEADER..]
        .iter()
        .map(|&byte| byte as u8)
        .collect();
    if std::str::from_utf8(&game_mode).is_err() {
        return Err(BAD_FORMAT);
    }
    Ok(TimingContext {
        multiplier,
        bias,
        per_object,
        fps,
        elapsed,
        slow: [words[5] != 0, words[6] != 0, words[7] != 0],
        instant: words[8] != 0,
        traits: [words[9] & 1 != 0, words[10] != 0, words[9] & 2 != 0],
        game_mode,
    })
}

pub(super) fn restore_validated(context: TimingContext) {
    MODE_STAGING.with(|staging| *staging.borrow_mut() = None);
    TIMING.with(|state| *state.borrow_mut() = context);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set_mode(mode: &str) {
        assert_eq!(source_mode_begin(mode.len() as u32), OK);
        for (index, byte) in mode.bytes().enumerate() {
            assert_eq!(source_mode_byte(index as u32, byte as u32), OK);
        }
        assert_eq!(source_mode_commit(), OK);
    }

    fn row() -> [f64; 16] {
        assert_eq!(source_timing_read(), OK);
        SCRATCH.with(|scratch| *scratch.borrow())
    }

    #[test]
    fn pickup_traits_and_awkward_gloves_apply_one_or_factor() {
        reset();
        assert_eq!(pickup_base(2.0, 0.0, 8, false), 96.0);
        assert_eq!(source_trait_set(1, 1), OK);
        assert_eq!(pickup_base(2.0, 0.0, 8, false), 192.0);
        assert_eq!(pickup_base(2.0, 0.0, 8, true), 192.0);
        assert_eq!(source_trait_set(0, 1), OK);
        assert_eq!(pickup_base(2.0, 0.0, 8, true), 96.0);
        assert_eq!(source_trait_set(1, 0), OK);
        assert_eq!(pickup_base(2.0, 0.0, 8, false), 48.0);
        assert_eq!(pickup_base(2.0, 0.0, 8, true), 96.0);
        assert_eq!(source_trait_set(3, 1), OUT_OF_RANGE);
        assert_eq!(source_trait_get(3), OUT_OF_RANGE);
        assert_eq!(source_trait_set(0, 2), OUT_OF_RANGE);
        assert_eq!(has_trait(0), Ok(true));
    }

    #[test]
    fn transfer_source_timing_keeps_floor_modifier_order_and_favorite_override_last() {
        reset();
        assert_eq!(transfer_base(2.0, 50.0, -0.1, 1.0, false, false), 40.0);
        assert_eq!(transfer_base(4.0, 50.0, 1.0, 0.5, false, false), 75.0);
        assert!(transfer_base(2.0, 50.0, f64::NAN, 1.0, false, false).is_nan());
        set_mode("LastStand");
        assert_eq!(source_trait_set(0, 1), OK);
        assert_eq!(source_trait_set(1, 1), OK);
        assert_eq!(transfer_base(2.0, 50.0, 0.8, 0.5, true, false), 12.0);
        assert_eq!(source_timing_set(6, 1.0), OK);
        assert_eq!(transfer_base(2.0, 50.0, f64::NAN, 1.0, false, false), 1.0);
        assert_eq!(transfer_base(2.0, 50.0, 0.8, 0.5, true, true), 0.0);
    }

    #[test]
    fn pickup_uses_exact_mode_native_weight_and_instant_override() {
        reset();
        assert_eq!(pickup_base(9.0, 8.0, 8, false), 360.0);
        set_mode("LastStand");
        assert_eq!(pickup_base(2.0, 0.0, 8, false), 28.799999999999997);
        set_mode("laststand");
        assert_eq!(pickup_base(2.0, 0.0, 8, false), 96.0);
        assert_eq!(pickup_base(0.1, 0.0, 8, false), 4.800000071525574);
        assert_eq!(source_timing_set(6, 1.0), OK);
        assert_eq!(pickup_base(f32::MAX, f32::INFINITY, 8, true), 1.0);
        assert_eq!(
            adjust_initial(pickup_base(2.0, 8.0, 8, false), 4, 4, [100.0; 4], 8.0),
            1
        );
    }

    #[test]
    fn initial_modifiers_skip_base_one_and_promote_pains_separately() {
        reset();
        assert_eq!(
            adjust_initial(1.0, 4, 4, [f32::INFINITY; 4], f32::INFINITY),
            1
        );
        assert_eq!(adjust_initial(-1.0, 4, 4, [100.0; 4], 2.0), -1);
        assert_eq!(
            adjust_initial(100.0, 2, 1, [75.0, 75.0, 0.0, 0.0], 2.0),
            562
        );
        assert_eq!(
            adjust_initial(100.0, 0, 0, [16_777_216.0, 1.0, 1.0, 1.0], 1.0),
            5_592_506
        );
        assert_eq!(adjust_initial(f64::NAN, 0, 0, [0.0; 4], 1.0), 0);
        assert_eq!(adjust_initial(f64::INFINITY, 0, 0, [0.0; 4], 1.0), i32::MAX);
        assert_eq!(
            adjust_initial(f64::NEG_INFINITY, 0, 0, [0.0; 4], 1.0),
            i32::MIN
        );
        assert_eq!(adjust_initial(2.0, 0, 0, [f32::MAX; 4], f32::MAX), i32::MAX);
        assert_eq!(
            adjust_initial(2.0, 0, 0, [f32::INFINITY, f32::NEG_INFINITY, 0.0, 0.0], 1.0),
            0
        );
    }

    #[test]
    fn source_frame_caps_fps_and_holds_it_for_nonpositive_elapsed() {
        reset();
        frame(1.0 / 120.0);
        assert_eq!(row()[3], 0.5);
        assert_eq!(multiplier(), 0.4);
        frame(0.0);
        assert_eq!(row()[3], 0.5);
        assert_eq!(elapsed_seconds(), 0.0);
        frame(-1.0);
        assert_eq!(row()[3], 0.5);
        assert_eq!(elapsed_seconds(), -1.0);
        frame(1.0);
        assert_eq!(row()[3], 5.0);
        frame(f64::MIN_POSITIVE);
        assert_eq!(row()[3], 0.0);
        frame(f64::MAX);
        assert_eq!(row()[3], 5.0);
        assert_eq!(elapsed_seconds(), f32::INFINITY);
    }

    #[test]
    fn live_fields_and_slow_flags_drive_sequential_float_clock() {
        reset();
        for (flags, expected) in [
            ([1.0, 0.0, 0.0], 0.5),
            ([0.0, 1.0, 0.0], 0.25),
            ([0.0, 0.0, 1.0], 0.125),
            ([1.0, 1.0, 0.0], 0.125),
            ([1.0, 0.0, 1.0], 0.0625),
            ([0.0, 1.0, 1.0], 0.03125),
            ([1.0, 1.0, 1.0], 0.015625),
        ] {
            for (index, enabled) in flags.into_iter().enumerate() {
                assert_eq!(source_timing_set(index as u32 + 3, enabled), OK);
            }
            assert_eq!(row()[5], expected);
        }
        frame(0.025);
        assert_eq!(source_timing_set(0, -2.0), OK);
        assert_eq!(source_timing_set(1, 3.0), OK);
        assert_eq!(source_timing_set(2, 4.0), OK);
        for field in 3..=5 {
            assert_eq!(source_timing_set(field, 1.0), OK);
        }
        assert_eq!(multiplier().to_bits(), 0xbee6_6667);
        let state = row();
        assert_eq!(&state[..4], &[-2.0, 3.0, 4.0, 1.5]);
        assert_eq!(&state[5..9], &[1.0 / 64.0, 1.0, 1.0, 1.0]);
        assert_eq!(state[13], -0.45000001788139343);
        assert_eq!(source_timing_set(0, 0.0), OK);
        assert_eq!(multiplier(), 0.0);
        assert_eq!(source_timing_set(0, f64::NAN), NONFINITE);
        assert_eq!(source_timing_set(1, f64::INFINITY), NONFINITE);
        assert_eq!(source_timing_set(2, f32::MAX as f64 * 2.0), OUT_OF_RANGE);
        assert_eq!(source_timing_set(3, 0.5), OUT_OF_RANGE);
        assert_eq!(source_timing_set(7, 1.0), OUT_OF_RANGE);
        assert_eq!(row()[0], 0.0);
        assert_eq!(row()[1], 3.0);
        assert_eq!(source_timing_scratch_size(), 128);
        assert_eq!(source_timing_scratch_ptr() as usize % 8, 0);

        reset();
        assert_eq!(source_timing_set(0, 0.1), OK);
        assert_eq!(source_timing_set(1, 0.2), OK);
        assert_eq!(source_timing_set(2, 0.3), OK);
        // Deferring all rounding until the end differs from the Java f32 pipeline.
        let widened = (0.1_f32 as f64 * 0.2_f32 as f64 * 0.3_f32 as f64 * 0.8_f32 as f64) as f32;
        assert_ne!(multiplier().to_bits(), widened.to_bits());
    }

    #[test]
    fn malformed_mode_staging_aborts_without_changing_live_utf8() {
        reset();
        set_mode("模式🌍");
        let original = snapshot_words();
        assert_eq!(source_mode_begin(129), OUT_OF_RANGE);
        assert_eq!(source_mode_commit(), BAD_FORMAT);
        assert_eq!(source_mode_begin(2), OK);
        assert_eq!(source_mode_byte(1, b'a' as u32), BAD_FORMAT);
        assert_eq!(source_mode_byte(0, b'a' as u32), BAD_FORMAT);
        assert_eq!(source_mode_begin(2), OK);
        assert_eq!(source_mode_byte(0, b'a' as u32), OK);
        assert_eq!(source_mode_byte(0, b'b' as u32), BAD_FORMAT);
        assert_eq!(source_mode_commit(), BAD_FORMAT);
        assert_eq!(source_mode_begin(1), OK);
        assert_eq!(source_mode_byte(0, 256), OUT_OF_RANGE);
        assert_eq!(source_mode_commit(), BAD_FORMAT);
        assert_eq!(source_mode_begin(1), OK);
        assert_eq!(source_mode_byte(0, 0xff), OK);
        assert_eq!(source_mode_commit(), BAD_FORMAT);
        assert_eq!(source_mode_begin(2), OK);
        assert_eq!(source_mode_byte(0, b'a' as u32), OK);
        assert_eq!(source_mode_commit(), BAD_FORMAT);
        assert_eq!(snapshot_words(), original);
        assert_eq!(source_mode_get_byte(0), 0xe6);
        assert_eq!(source_mode_get_byte(99), OUT_OF_RANGE);
        set_mode(&"a".repeat(128));
        assert_eq!(row()[12], 128.0);
        set_mode("");
        assert_eq!(row()[12], 0.0);
    }

    #[test]
    fn snapshot_validation_is_atomic_and_restore_preserves_raw_float_bits() {
        reset();
        assert_eq!(source_timing_set(0, f32::MAX as f64), OK);
        assert_eq!(source_timing_set(1, -0.0), OK);
        assert_eq!(source_timing_set(2, f32::MAX as f64), OK);
        assert_eq!(source_trait_set(1, 1), OK);
        set_mode("LastStand");
        frame(f64::MAX);
        let saved = snapshot_words();
        assert!(multiplier().is_nan());
        let mut bad = saved.clone();
        bad[0] = f32::INFINITY.to_bits();
        assert!(validate_words(&bad).is_err());
        bad = saved.clone();
        bad[3] = 6.0_f32.to_bits();
        assert!(validate_words(&bad).is_err());
        bad = saved.clone();
        bad[5] = 2;
        assert!(validate_words(&bad).is_err());
        bad = saved.clone();
        bad[11] = 129;
        assert!(validate_words(&bad).is_err());
        bad = saved.clone();
        bad[12] = 0xff;
        assert!(validate_words(&bad).is_err());
        bad = saved.clone();
        bad[12] = 256;
        assert!(validate_words(&bad).is_err());
        assert!(validate_words(&saved[..11]).is_err());
        assert!(validate_words(&saved[..saved.len() - 1]).is_err());
        assert_eq!(snapshot_words(), saved);
        reset();
        assert_eq!(source_mode_begin(1), OK);
        restore_validated(validate_words(&saved).unwrap());
        assert_eq!(source_mode_commit(), BAD_FORMAT);
        assert_eq!(snapshot_words(), saved);
        assert_eq!(source_trait_get(1), 1);
        assert_eq!(row()[1].to_bits(), (-0.0_f64).to_bits());
    }

    #[test]
    fn transfer_hemophobic_trait_has_native_identity_and_roundtrips_without_changing_pickup_time() {
        reset();
        assert_eq!(source_trait_get(2), 0);
        assert_eq!(source_trait_set(2, 1), OK);
        assert_eq!(source_trait_get(2), 1);
        assert_eq!(pickup_base(2.0, 0.0, 8, false), 96.0);
        assert_eq!(row()[14], 1.0);
        let saved = snapshot_words();
        assert_eq!(saved[9], 2);
        assert_eq!(saved[10], 0);
        reset();
        restore_validated(validate_words(&saved).unwrap());
        assert_eq!(source_trait_get(2), 1);
        let mut legacy = saved.clone();
        legacy[9] = 1;
        restore_validated(validate_words(&legacy).unwrap());
        assert_eq!(source_trait_get(0), 1);
        assert_eq!(source_trait_get(2), 0);
        let mut invalid = saved;
        invalid[9] = 4;
        assert!(validate_words(&invalid).is_err());
        assert_eq!(source_trait_get(2), 0);
    }
}
