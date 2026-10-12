//! Authoritative movement rules for the M1 architecture proof.
//!
//! One simulation owns coordinates, destination/heading state, speed, world
//! bounds, tick count and cancellation. The JavaScript host may only read state
//! and submit commands through the flat C ABI below; it never sees memory. The
//! crate builds as a `cdylib` for `wasm32-unknown-unknown` and as an `rlib` for
//! native rule tests, with no crate dependencies.
//!
//! Command intake is 64-bit and every range rule is applied to that original
//! value, so a value just outside a documented range can never be rounded into
//! it by the calling convention. Simulation state stays 32-bit: positions and
//! speed are stored and advanced as `f32`, which is why the getters expose about
//! seven decimal digits of precision.
//!
//! Command status codes: [`OK`] (0) means the state changed as requested,
//! [`NONFINITE`] (-1) means a NaN or infinity arrived and nothing changed, and
//! [`OUT_OF_RANGE`] (-2) means a finite value was refused and nothing changed.

use std::cell::RefCell;

/// Engine ABI version; the host refuses any other value.
const API_VERSION: u32 = 1;

const WORLD_MIN: f32 = 0.0;
const WORLD_MAX: f32 = 10.0;
const START: f32 = 5.0;
const DEFAULT_SPEED: f32 = 1.5;
/// Accepted speed band. The thresholds are 64-bit because commands arrive in
/// 64-bit: widening an `f32` 0.1 would reject the legal minimum speed.
const MIN_SPEED: f64 = 0.1;
const MAX_SPEED: f64 = 10.0;
/// Host frames may never ask for more than this much simulated time, so a
/// paused or hidden tab cannot bank up offline catch-up work. Same 64-bit
/// reason: the accepted window must end at exactly 0.1 s.
const MAX_STEP_SECONDS: f64 = 0.1;
/// A destination at this distance is already reached.
const EPSILON: f32 = 1.0e-6;

const ACTION_IDLE: u32 = 0;
const ACTION_DESTINATION: u32 = 1;
const ACTION_WALKING: u32 = 2;

const OK: i32 = 0;
const NONFINITE: i32 = -1;
const OUT_OF_RANGE: i32 = -2;

#[derive(Clone, Copy)]
struct Engine {
    x: f32,
    y: f32,
    speed: f32,
    target_x: f32,
    target_y: f32,
    heading_x: f32,
    heading_y: f32,
    action: u32,
    tick: u32,
}

impl Engine {
    const fn initial() -> Engine {
        Engine {
            x: START,
            y: START,
            speed: DEFAULT_SPEED,
            target_x: START,
            target_y: START,
            heading_x: 0.0,
            heading_y: 0.0,
            action: ACTION_IDLE,
            tick: 0,
        }
    }

    fn cancel(&mut self) {
        self.action = ACTION_IDLE;
        self.target_x = self.x;
        self.target_y = self.y;
        self.heading_x = 0.0;
        self.heading_y = 0.0;
    }

    fn advance(&mut self, dt: f32) {
        match self.action {
            ACTION_DESTINATION => self.advance_to_target(dt),
            ACTION_WALKING => self.advance_to_heading(dt),
            _ => {}
        }
    }

    /// Moves toward the stored destination, snapping exactly onto it so a
    /// reached destination never leaves rounding residue behind.
    fn advance_to_target(&mut self, dt: f32) {
        let delta_x = self.target_x - self.x;
        let delta_y = self.target_y - self.y;
        let distance = (delta_x * delta_x + delta_y * delta_y).sqrt();
        let travel = self.speed * dt;
        if distance <= travel.max(EPSILON) {
            self.x = self.target_x;
            self.y = self.target_y;
            self.action = ACTION_IDLE;
            return;
        }
        let scale = travel / distance;
        self.x += delta_x * scale;
        self.y += delta_y * scale;
    }

    /// Moves along the stored unit heading and ends the action at a world edge.
    fn advance_to_heading(&mut self, dt: f32) {
        let next_x = self.x + self.heading_x * self.speed * dt;
        let next_y = self.y + self.heading_y * self.speed * dt;
        self.x = next_x.clamp(WORLD_MIN, WORLD_MAX);
        self.y = next_y.clamp(WORLD_MIN, WORLD_MAX);
        if self.outside_world(next_x, next_y) {
            self.action = ACTION_IDLE;
        }
    }

    fn outside_world(&self, x: f32, y: f32) -> bool {
        !(WORLD_MIN..=WORLD_MAX).contains(&x) || !(WORLD_MIN..=WORLD_MAX).contains(&y)
    }

    /// True when the position already sits within [`EPSILON`] of the point.
    fn is_at(&self, x: f32, y: f32) -> bool {
        (x - self.x).abs() <= EPSILON && (y - self.y).abs() <= EPSILON
    }
}

// Per-thread state: one instance per thread on wasm and one per libtest thread
// natively, with no mutable-static aliasing and no per-update allocation.
thread_local! {
    static ENGINE: RefCell<Engine> = const { RefCell::new(Engine::initial()) };
}

fn mutate<R>(update: impl FnOnce(&mut Engine) -> R) -> R {
    ENGINE.with(|engine| update(&mut engine.borrow_mut()))
}

/// World bounds are whole numbers, so widening them for the 64-bit comparison
/// is exact and cannot move the boundary.
fn in_world(value: f64) -> bool {
    (WORLD_MIN as f64..=WORLD_MAX as f64).contains(&value)
}

/// Returns a unit direction, or (0, 0) for an exactly zero direction.
/// Scaling first prevents finite huge or tiny components from overflowing
/// or underflowing during normalization.
fn unit_direction(x: f64, y: f64) -> (f32, f32) {
    let scale = x.abs().max(y.abs());
    if scale == 0.0 {
        return (0.0, 0.0);
    }
    let scaled_x = x / scale;
    let scaled_y = y / scale;
    let length = (scaled_x * scaled_x + scaled_y * scaled_y).sqrt();

    ((scaled_x / length) as f32, (scaled_y / length) as f32)
}

/// Reports the engine ABI version.
#[unsafe(no_mangle)]
pub extern "C" fn api_version() -> u32 {
    API_VERSION
}

/// Restores the initial position, speed, action and tick.
#[unsafe(no_mangle)]
pub extern "C" fn reset() {
    mutate(|engine| *engine = Engine::initial());
}

/// Sets movement speed in world units per second; only [0.1, 10] is accepted.
#[unsafe(no_mangle)]
pub extern "C" fn set_speed(speed: f64) -> i32 {
    if !speed.is_finite() {
        return NONFINITE;
    }
    if !(MIN_SPEED..=MAX_SPEED).contains(&speed) {
        return OUT_OF_RANGE;
    }
    mutate(|engine| {
        engine.speed = speed as f32;
        OK
    })
}

/// Assigns a destination inside [0, 10]^2. Destinations are refused, never
/// clamped. A destination equal to the current position is already reached.
#[unsafe(no_mangle)]
pub extern "C" fn move_to(x: f64, y: f64) -> i32 {
    if !x.is_finite() || !y.is_finite() {
        return NONFINITE;
    }
    if !in_world(x) || !in_world(y) {
        return OUT_OF_RANGE;
    }
    mutate(|engine| {
        engine.target_x = x as f32;
        engine.target_y = y as f32;
        engine.heading_x = 0.0;
        engine.heading_y = 0.0;
        if engine.is_at(x as f32, y as f32) {
            engine.action = ACTION_IDLE;
        } else {
            engine.action = ACTION_DESTINATION;
        }
        OK
    })
}

/// Sets a persistent heading; the direction is normalised in 64-bit arithmetic,
/// so the magnitude a consumer submits cannot change the distance travelled. A
/// zero direction cancels movement instead of inventing a heading.
#[unsafe(no_mangle)]
pub extern "C" fn walk(x: f64, y: f64) -> i32 {
    if !x.is_finite() || !y.is_finite() {
        return NONFINITE;
    }
    let (unit_x, unit_y) = unit_direction(x, y);
    if unit_x == 0.0 && unit_y == 0.0 {
        return mutate(|engine| {
            engine.cancel();
            OK
        });
    }
    mutate(|engine| {
        engine.heading_x = unit_x;
        engine.heading_y = unit_y;
        engine.action = ACTION_WALKING;
        OK
    })
}

/// Cancels any destination or heading, leaving the current position intact.
#[unsafe(no_mangle)]
pub extern "C" fn cancel() {
    mutate(|engine| engine.cancel());
}

/// Advances the simulation by `dt` seconds. Only (0, 0.1] is accepted; the
/// tick counter moves only on an accepted step.
#[unsafe(no_mangle)]
pub extern "C" fn step(dt: f64) -> i32 {
    if !dt.is_finite() {
        return NONFINITE;
    }
    if dt <= 0.0 {
        return OUT_OF_RANGE;
    }
    if dt > MAX_STEP_SECONDS {
        return OUT_OF_RANGE;
    }
    mutate(|engine| {
        // ponytail: wraps after ~2.3 years at 60 Hz; reset() re-zeroes it.
        engine.tick = engine.tick.wrapping_add(1);
        engine.advance(dt as f32);
        OK
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn position_x() -> f32 {
    ENGINE.with(|engine| engine.borrow().x)
}

#[unsafe(no_mangle)]
pub extern "C" fn position_y() -> f32 {
    ENGINE.with(|engine| engine.borrow().y)
}

#[unsafe(no_mangle)]
pub extern "C" fn speed() -> f32 {
    ENGINE.with(|engine| engine.borrow().speed)
}

/// 0 idle, 1 moving to a destination, 2 walking a heading.
#[unsafe(no_mangle)]
pub extern "C" fn action() -> u32 {
    ENGINE.with(|engine| engine.borrow().action)
}

#[unsafe(no_mangle)]
pub extern "C" fn tick() -> u32 {
    ENGINE.with(|engine| engine.borrow().tick)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DT: f64 = 1.0 / 60.0;

    fn near(actual: f32, expected: f32) -> bool {
        (actual - expected).abs() < 1.0e-4
    }

    /// Steps until the engine reports idle, failing rather than hanging.
    fn run_until_idle() -> u32 {
        let mut steps = 0;
        while action() != ACTION_IDLE {
            assert_eq!(step(DT), OK);
            steps += 1;
            assert!(steps < 2_000, "movement never finished");
        }
        steps
    }

    /// Distance travelled from the initial position, in world units.
    fn travelled() -> f32 {
        let offset_x = position_x() - START;
        let offset_y = position_y() - START;

        (offset_x * offset_x + offset_y * offset_y).sqrt()
    }

    #[test]
    fn initial_state_matches_the_contract() {
        reset();
        assert_eq!(api_version(), 1);
        assert!(near(position_x(), 5.0));
        assert!(near(position_y(), 5.0));
        assert!(near(speed(), 1.5));
        assert_eq!(action(), ACTION_IDLE);
        assert_eq!(tick(), 0);
    }

    #[test]
    fn destination_is_reached_exactly() {
        reset();
        assert_eq!(move_to(2.0, 8.0), OK);
        assert_eq!(action(), ACTION_DESTINATION);
        // sqrt(18) units at 1.5 units/s needs about 170 steps.
        assert!(run_until_idle() >= 165);
        assert_eq!(position_x(), 2.0);
        assert_eq!(position_y(), 8.0);
        assert_eq!(action(), ACTION_IDLE);
    }

    #[test]
    fn cancel_prevents_any_further_movement() {
        reset();
        assert_eq!(move_to(9.0, 5.0), OK);
        for _ in 0..20 {
            assert_eq!(step(DT), OK);
        }
        let midway = position_x();
        assert!((5.0..9.0).contains(&midway));
        cancel();
        assert_eq!(action(), ACTION_IDLE);
        for _ in 0..60 {
            assert_eq!(step(DT), OK);
        }
        assert_eq!(position_x(), midway);
        assert_eq!(position_y(), 5.0);
        assert_eq!(tick(), 80);
    }

    #[test]
    fn diagonal_heading_is_normalised() {
        reset();
        assert_eq!(walk(1.0, 1.0), OK);
        assert_eq!(action(), ACTION_WALKING);
        for _ in 0..60 {
            assert_eq!(step(DT), OK);
        }
        assert!(near(travelled(), 1.5), "unnormalised diagonal");
        assert!(near(position_x() - START, position_y() - START));
    }

    #[test]
    fn extreme_headings_still_normalise_to_one_second_of_travel() {
        reset();
        assert_eq!(walk(f64::MAX, f64::MAX), OK);
        assert_eq!(action(), ACTION_WALKING);
        for _ in 0..60 {
            assert_eq!(step(DT), OK);
        }
        assert!(near(travelled(), 1.5), "huge heading stalled");
        reset();
        assert_eq!(walk(1.0e300, -1.0e300), OK);
        for _ in 0..60 {
            assert_eq!(step(DT), OK);
        }
        let unit = 1.5 / (2.0_f32).sqrt();
        assert!(near(position_x() - START, unit));
        assert!(near(START - position_y(), unit));
        assert!(near(travelled(), 1.5), "scaled heading stalled");
    }

    #[test]
    fn walking_stops_at_the_world_edge() {
        reset();
        assert_eq!(walk(1.0, 1.0), OK);
        run_until_idle();
        assert_eq!(position_x(), position_y());
        assert!(position_x() <= WORLD_MAX);
        assert_eq!(action(), ACTION_IDLE);
        cancel();
        assert_eq!(move_to(10.0, 5.0), OK);
        run_until_idle();
        assert_eq!(position_x(), WORLD_MAX);
        for _ in 0..60 {
            assert_eq!(step(DT), OK);
        }
        assert_eq!(position_x(), WORLD_MAX);
    }

    #[test]
    fn zero_direction_cancels_rather_than_moving() {
        reset();
        assert_eq!(walk(3.0, 0.0), OK);
        assert_eq!(step(DT), OK);
        let moved = position_x();
        assert!(moved > 5.0);
        assert_eq!(walk(0.0, 0.0), OK);
        assert_eq!(action(), ACTION_IDLE);
        assert_eq!(position_x(), moved);
    }

    #[test]
    fn a_heading_command_replaces_the_previous_destination() {
        reset();
        assert_eq!(move_to(0.0, 0.0), OK);
        assert_eq!(walk(1.0, 0.0), OK);
        assert_eq!(action(), ACTION_WALKING);
        for _ in 0..10 {
            assert_eq!(step(DT), OK);
        }
        assert!(position_x() > 5.0);
        assert_eq!(position_y(), 5.0);
    }

    #[test]
    fn rejected_speed_changes_the_distance_covered() {
        reset();
        assert_eq!(walk(0.0, 1.0), OK);
        for _ in 0..60 {
            assert_eq!(step(DT), OK);
        }
        let slow = position_y() - START;
        reset();
        assert_eq!(set_speed(3.0), OK);
        assert!(near(speed(), 3.0));
        assert_eq!(walk(0.0, 1.0), OK);
        for _ in 0..60 {
            assert_eq!(step(DT), OK);
        }
        let fast = position_y() - START;
        assert!(near(slow, 1.5));
        assert!(near(fast, 3.0));
    }

    #[test]
    fn intake_is_validated_before_any_rounding_can_rescue_it() {
        reset();
        assert_eq!(move_to(10.0000001, 5.0), OUT_OF_RANGE);
        assert_eq!(move_to(5.0, 10.0000001), OUT_OF_RANGE);
        assert_eq!(set_speed(0.099_999_999), OUT_OF_RANGE);
        assert_eq!(set_speed(10.000_000_1), OUT_OF_RANGE);
        assert_eq!(set_speed(f64::NAN), NONFINITE);
        assert_eq!(step(0.100_000_000_1), OUT_OF_RANGE);
        assert_eq!(action(), ACTION_IDLE);
        assert_eq!(tick(), 0);
        assert_eq!(position_x(), START);
        assert!(near(speed(), DEFAULT_SPEED));
    }

    #[test]
    fn invalid_input_never_mutates_state() {
        reset();
        assert_eq!(move_to(7.0, 5.0), OK);
        assert_eq!(step(DT), OK);
        let x = position_x();
        let y = position_y();
        let current_speed = speed();
        let action_code = action();
        let ticks = tick();
        assert_eq!(move_to(f64::NAN, 5.0), NONFINITE);
        assert_eq!(move_to(5.0, f64::INFINITY), NONFINITE);
        assert_eq!(move_to(11.0, 5.0), OUT_OF_RANGE);
        assert_eq!(move_to(5.0, -0.5), OUT_OF_RANGE);
        assert_eq!(walk(f64::NAN, 1.0), NONFINITE);
        assert_eq!(walk(f64::INFINITY, f64::INFINITY), NONFINITE);
        assert_eq!(set_speed(0.05), OUT_OF_RANGE);
        assert_eq!(set_speed(10.5), OUT_OF_RANGE);
        assert_eq!(set_speed(f64::NAN), NONFINITE);
        assert_eq!(step(0.0), OUT_OF_RANGE);
        assert_eq!(step(-DT), OUT_OF_RANGE);
        assert_eq!(step(0.11), OUT_OF_RANGE);
        assert_eq!(step(f64::NAN), NONFINITE);
        assert_eq!(position_x(), x);
        assert_eq!(position_y(), y);
        assert_eq!(speed(), current_speed);
        assert_eq!(action(), action_code);
        assert_eq!(tick(), ticks);
    }

    #[test]
    fn step_window_is_half_open_and_bounded_above() {
        reset();
        assert_eq!(step(1.0e-9), OK);
        assert_eq!(step(MAX_STEP_SECONDS), OK);
        assert_eq!(tick(), 2);
    }

    #[test]
    fn every_documented_edge_value_is_accepted() {
        reset();
        assert_eq!(set_speed(MIN_SPEED), OK);
        assert!(near(speed(), 0.1));
        assert_eq!(set_speed(MAX_SPEED), OK);
        assert!(near(speed(), 10.0));
        assert_eq!(move_to(WORLD_MAX as f64, WORLD_MIN as f64), OK);
        assert_eq!(action(), ACTION_DESTINATION);
        run_until_idle();
        assert_eq!(position_x(), WORLD_MAX);
        assert_eq!(position_y(), WORLD_MIN);
        assert_eq!(step(MAX_STEP_SECONDS), OK);
    }

    #[test]
    fn a_destination_at_the_current_position_is_already_reached() {
        reset();
        assert_eq!(move_to(5.0, 5.0), OK);
        assert_eq!(action(), ACTION_IDLE);
        assert_eq!(step(DT), OK);
        assert_eq!(position_x(), 5.0);
        assert_eq!(tick(), 1);
    }

    #[test]
    fn reset_clears_movement_and_counters() {
        reset();
        assert_eq!(set_speed(8.0), OK);
        assert_eq!(walk(-1.0, -1.0), OK);
        for _ in 0..30 {
            assert_eq!(step(DT), OK);
        }
        reset();
        assert!(near(position_x(), START));
        assert!(near(position_y(), START));
        assert!(near(speed(), DEFAULT_SPEED));
        assert_eq!(action(), ACTION_IDLE);
        assert_eq!(tick(), 0);
        assert_eq!(step(DT), OK);
        assert!(near(position_x(), START));
    }
}
