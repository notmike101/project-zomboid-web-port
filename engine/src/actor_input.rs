//! Transient current-player input, separate from movement and portable saves.
//!
//! Source nullifyAiming clears force aim, charging, then raw aim, not cached or
//! physical input. The admitted actor is local keyboard/mouse and on foot.
//! Attack timers, hostile animations, NPC control, network and vehicle aiming
//! remain unsupported domains: their effective-getter overrides are not false
//! facts to synthesize here, and must be admitted with their real producers.

use super::{ITEMS, OK, OUT_OF_RANGE, SCRATCH, UNSUPPORTED};
use std::cell::RefCell;

#[derive(Default)]
struct ActorInput {
    force_aim: bool,
    charging: bool,
    raw_aiming: bool,
    cached_aiming: bool,
    cached_charging: bool,
    aim_down: bool,
}

impl ActorInput {
    fn toggle_force_aim(&mut self) -> bool {
        self.force_aim = !self.force_aim;
        self.force_aim
    }
}

thread_local! {
    static INPUT: RefCell<ActorInput> = RefCell::new(ActorInput::default());
}

pub(super) fn reset() {
    INPUT.with(|input| *input.borrow_mut() = ActorInput::default());
}

fn admitted(player: u32) -> bool {
    player == 0 && ITEMS.with(|items| items.borrow().actor_vehicle == 0)
}

/// Field 3 is the effective getter for the admitted model, not a universal
/// assertion that raw false defeats source combat/animation/NPC overrides.
#[unsafe(no_mangle)]
pub extern "C" fn source_actor_input_get(player: u32, field: u32) -> i32 {
    if field > 6 {
        return OUT_OF_RANGE;
    }
    if !admitted(player) {
        return UNSUPPORTED;
    }
    INPUT.with(|input| {
        let input = input.borrow();
        i32::from(match field {
            0 => input.force_aim,
            1 => input.charging,
            2 | 3 => input.raw_aiming,
            4 => input.cached_aiming,
            5 => input.cached_charging,
            _ => input.aim_down,
        })
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn source_actor_input_read(player: u32) -> i32 {
    if !admitted(player) {
        return UNSUPPORTED;
    }
    INPUT.with(|input| {
        let input = input.borrow();
        SCRATCH.with(|scratch| {
            scratch.borrow_mut()[..7].copy_from_slice(&[
                u32::from(input.force_aim) as f64,
                u32::from(input.charging) as f64,
                u32::from(input.raw_aiming) as f64,
                u32::from(input.raw_aiming) as f64,
                u32::from(input.cached_aiming) as f64,
                u32::from(input.cached_charging) as f64,
                u32::from(input.aim_down) as f64,
            ]);
        });
    });
    OK
}

/// The genuine source setIsAiming and ECS setForceAim producers.
#[unsafe(no_mangle)]
pub extern "C" fn source_actor_input_set(player: u32, field: u32, value: u32) -> i32 {
    if field > 1 || value > 1 {
        return OUT_OF_RANGE;
    }
    if !admitted(player) {
        return UNSUPPORTED;
    }
    INPUT.with(|input| {
        let mut input = input.borrow_mut();
        if field == 0 {
            input.raw_aiming = value != 0;
        } else {
            input.force_aim = value != 0;
        }
    });
    OK
}

#[unsafe(no_mangle)]
pub extern "C" fn source_actor_toggle_force_aim(player: u32) -> i32 {
    if !admitted(player) {
        return UNSUPPORTED;
    }
    INPUT.with(|input| i32::from(input.borrow_mut().toggle_force_aim()))
}

#[unsafe(no_mangle)]
pub extern "C" fn source_actor_nullify_aiming(player: u32) -> i32 {
    if !admitted(player) {
        return UNSUPPORTED;
    }
    INPUT.with(|input| {
        let mut input = input.borrow_mut();
        if input.force_aim {
            input.toggle_force_aim();
        }
        input.charging = false;
        input.raw_aiming = false;
    });
    OK
}

/// Keyboard PrecisionAim aliases Aim. The host resolves the actual Core binding
/// and source inventory hit-test before supplying isKeyDownInWorld, not raw RMB.
/// UpdateInputState samples aim before running/sprinting clears force aim; then
/// updateInternal2 copies cached aiming/charging to the current player fields.
#[unsafe(no_mangle)]
pub extern "C" fn source_actor_input_refresh(
    player: u32,
    aim_down: u32,
    running: u32,
    sprinting: u32,
) -> i32 {
    if aim_down > 1 || running > 1 || sprinting > 1 {
        return OUT_OF_RANGE;
    }
    if !admitted(player) {
        return UNSUPPORTED;
    }
    INPUT.with(|input| {
        let mut input = input.borrow_mut();
        input.aim_down = aim_down != 0;
        let aiming = input.aim_down || input.force_aim;
        input.cached_aiming = aiming;
        input.cached_charging = aiming;
        if running != 0 || sprinting != 0 {
            input.force_aim = false;
        }
        input.raw_aiming = input.cached_aiming;
        input.charging = input.cached_charging;
    });
    OK
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_producers_clear_and_refresh_without_touching_other_native_state() {
        super::super::reset();
        assert_eq!(source_actor_input_set(0, 0, 1), OK);
        assert_eq!(source_actor_input_get(0, 3), 1);
        assert_eq!(source_actor_toggle_force_aim(0), 1);
        assert_eq!(source_actor_input_refresh(0, 1, 0, 0), OK);
        assert_eq!(source_actor_nullify_aiming(0), OK);
        for field in 0..=3 {
            assert_eq!(source_actor_input_get(0, field), 0);
        }
        for field in 4..=6 {
            assert_eq!(source_actor_input_get(0, field), 1);
        }
        assert_eq!(source_actor_input_refresh(0, 1, 0, 0), OK);
        assert_eq!(source_actor_input_get(0, 3), 1);
        assert_eq!(source_actor_input_refresh(0, 0, 0, 2), OUT_OF_RANGE);
        assert_eq!(source_actor_input_set(0, 0, 2), OUT_OF_RANGE);
        assert_eq!(source_actor_input_set(0, 2, 0), OUT_OF_RANGE);
        assert_eq!(source_actor_nullify_aiming(1), UNSUPPORTED);
        assert_eq!(source_actor_input_get(0, 3), 1);
        assert_eq!(source_actor_input_set(0, 1, 1), OK);
        assert_eq!(source_actor_input_refresh(0, 0, 1, 0), OK);
        assert_eq!(source_actor_input_get(0, 0), 0);
        assert_eq!(source_actor_input_get(0, 3), 1);
        assert_eq!(source_actor_input_refresh(0, 0, 0, 0), OK);
        assert_eq!(source_actor_input_get(0, 3), 0);
    }
}
