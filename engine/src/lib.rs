//! Authoritative movement, world, item and project health rules.
//!
//! One simulation owns coordinates, destination/heading state, speed, world
//! bounds, tick count and cancellation. The JavaScript host may only read state
//! and submit commands through the flat C ABI below; only a bounded scratch
//! buffer is exposed for world bounds and save-state transfer. The
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
//! World rules use the per-tile navigation bytes verified from shipped
//! `chunkdata_X_Y.bin` files: tile bitfields `NAV_SOLID`/`NAV_VOID` block
//! entry, and the `NAV_WALL_NORTH`/`NAV_WALL_WEST` bits block the tile edge
//! shared with the neighbour. These flag semantics (wall bits live on the wall
//! tile itself rather than on each adjacent floor) are the verified-format
//! interim model; real imported towns must be validated visually.

use std::cell::RefCell;

mod actions;
mod body;
mod doors;
mod timing;

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
/// A finite command was refused because the world grid blocks it (a blocked
/// destination, an unreachable path or a heading into a wall).
const BLOCKED: i32 = -3;
/// A streaming world import was malformed; no partial cell state survives.
const BAD_FORMAT: i32 = -4;
/// A requested original facility has no provisioned native backend.
const UNSUPPORTED: i32 = -5;

// MoodleStat/Moodle.Update thresholds from retained original bytecode.
// Inputs are genuine port-owned state; this does not supply native survival,
// inventory mass, weather/corpse dynamics, voice, wiggles or thermal chevrons.
const MOODLE_INPUTS: usize = 34;
const MOODLE_WORDS: usize = MOODLE_INPUTS + 3;
const F32_MAX: f64 = f32::MAX as f64;

// min, max, source/project default, kind (0 float, 1 integer, 2 boolean).
const MOODLE_LIMITS: [(f64, f64, f64, u32); MOODLE_INPUTS] = [
    (0.0, 1.0, 1.0, 0),                // endurance
    (0.0, 1.0, 0.0, 0),                // fatigue
    (0.0, 1.0, 0.0, 0),                // hunger
    (0.0, 100.0, 0.0, 0),              // panic
    (0.0, 1.0, 0.0, 0),                // sickness
    (0.0, 100.0, 0.0, 0),              // boredom
    (0.0, 100.0, 0.0, 0),              // unhappiness
    (0.0, 100.0, 0.0, 0),              // wetness
    (0.0, 1.0, 0.0, 0),                // anger
    (0.0, 1.0, 0.0, 0),                // stress
    (0.0, 0.51, 0.0, 0),               // nicotine withdrawal
    (0.0, 1.0, 0.0, 0),                // thirst
    (0.0, 100.0, 0.0, 0),              // pain
    (0.0, 100.0, 0.0, 0),              // intoxication
    (20.0, 40.0, 37.0, 0),             // temperature: source clamp makes >40 unreachable
    (0.0, 100.0, 0.0, 0),              // zombie infection
    (0.0, 100.0, 0.0, 0),              // zombie fever
    (0.0, 100.0, 0.0, 0),              // food sickness
    (0.0, 100.0, 0.0, 0),              // discomfort
    (0.0, 100.0, 0.0, 0),              // cold strength; progression remains unmodeled
    (0.0, 1.0, 0.0, 2),                // has cold
    (0.0, 1.0, 0.0, 2),                // fake infected
    (0.0, 17.0, 0.0, 1),               // bleeding body parts
    (0.0, 1.0, 0.0, 2),                // neck bleeding
    (0.0, F32_MAX, 0.0, 0),            // capacity weight: explicit empty-load port policy
    (1.0, i32::MAX as f64, 8.0, 1),    // max weight: explicit port baseline, not native dynamics
    (0.0, F32_MAX, 0.0, 0),            // wind chill: bounded world has no weather
    (0.0, F32_MAX, 0.0, 0),            // corpse sickness rate: no corpse simulation
    (0.0, 1.0, 0.0, 2),                // toxic building: no toxic-building simulation
    (0.0, 1.0, 0.0, 2),                // protection from toxic exposure
    (0.0, 1.0, 0.0, 2),                // corpse impact enabled: explicit bounded-world policy
    (0.0, 1.0, 0.0, 2),                // can't sprint
    (0.0, F32_MAX, 0.0, 0),            // health from food timer; survival decay unmodeled
    (1.0, i32::MAX as f64, 1600.0, 1), // standard health from food time
];

#[derive(Clone, Copy)]
struct MoodleState {
    inputs: [f64; MOODLE_INPUTS],
    pain_timer: u32,
    pain_level: u32,
    cant_sprint_timer: u32,
}

impl MoodleState {
    fn initial() -> Self {
        Self {
            inputs: MOODLE_LIMITS.map(|(_, _, default, _)| default),
            pain_timer: 0,
            pain_level: 0,
            cant_sprint_timer: 300,
        }
    }

    fn advance(&mut self, health: f64) {
        // Original counters count updates, not elapsed seconds. Dead's generic
        // gate precedes both counters; queries never advance either counter.
        if health == 0.0 {
            self.pain_level = 0;
            return;
        }
        self.pain_timer += 1;
        if self.pain_timer == 120 {
            self.pain_timer = 0;
            self.pain_level = above(self.inputs[12] as f32, [10.0, 20.0, 50.0, 75.0]);
        }
        if self.inputs[31] != 0.0 {
            self.cant_sprint_timer -= 1;
            if self.cant_sprint_timer == 0 {
                self.cant_sprint_timer = 300;
                self.inputs[31] = 0.0;
            }
        }
    }

    fn level(&self, index: u32, health: f64) -> u32 {
        let s = &self.inputs;
        if health == 0.0 {
            let zombie = s[21] == 0.0 && s[15] as f32 >= 0.001_f32;
            return match index {
                17 if !zombie => 4,
                18 if zombie => 4,
                _ => 0,
            };
        }
        let v = |i: usize| s[i] as f32;
        match index {
            0 => {
                let endurance = v(0);
                if endurance > 0.75 {
                    0
                } else if endurance > 0.5 {
                    1
                } else if endurance > 0.25 {
                    2
                } else if endurance > 0.1 {
                    3
                } else {
                    4
                }
            }
            1 => above(v(1), [0.6, 0.7, 0.8, 0.9]),
            2 => above(v(2), [0.15, 0.25, 0.45, 0.7]),
            3 => above(v(3), [6.0, 30.0, 65.0, 80.0]),
            4 => above(
                v(4) + v(15).max(v(16)).max(v(17)) / 100.0,
                [0.25, 0.5, 0.75, 0.9],
            ),
            5 => above(v(5), [25.0, 50.0, 75.0, 90.0]),
            6 => above(v(6), [20.0, 45.0, 60.0, 80.0]),
            7 => {
                if s[23] != 0.0 {
                    4
                } else {
                    (s[22] as u32).min(4)
                }
            }
            8 => above(v(7), [15.0, 40.0, 70.0, 90.0]),
            9 => above(
                if s[20] != 0.0 { v(19) } else { 0.0 },
                [20.0, 40.0, 60.0, 75.0],
            ),
            10 => above(v(8), [0.1, 0.25, 0.5, 0.75]),
            11 => above((v(9) + v(10)).clamp(0.0, 1.0), [0.25, 0.5, 0.75, 0.9]),
            12 => above(v(11), [0.12, 0.25, 0.7, 0.84]),
            13 => above(100.0 - health as f32, [20.0, 40.0, 60.0, 75.0]),
            14 => self.pain_level,
            15 => {
                let ratio = v(24) / v(25);
                if ratio >= 1.75 {
                    4
                } else if ratio >= 1.5 {
                    3
                } else if ratio >= 1.25 {
                    2
                } else if ratio > 1.0 {
                    1
                } else {
                    0
                }
            }
            16 => above(v(13), [10.0, 30.0, 50.0, 70.0]),
            17 | 18 => 0, // genuine alive gate, not missing rules
            19 => above(v(14), [37.5, 39.0, 40.0, 41.0]),
            20 => {
                let temp = v(14);
                let mut level = 0;
                if temp < 36.5 && v(13) <= 30.0 {
                    level = 1;
                }
                if temp < 35.0 && v(13) <= 70.0 {
                    level = 2;
                }
                if temp < 30.0 {
                    level = 3;
                }
                if temp < 25.0 {
                    level = 4;
                }
                level
            }
            21 => {
                // Preserve original repeated highest-threshold branch:
                // >15 initially sets1, >10 overrides2, >15 overrides3.
                if v(26) > 20.0 {
                    4
                } else if v(26) > 15.0 {
                    3
                } else if v(26) > 10.0 {
                    2
                } else {
                    0
                }
            }
            22 => u32::from(s[31] != 0.0),
            23 => [20.0, 40.0, 60.0, 80.0]
                .iter()
                .filter(|&&t| v(18) >= t)
                .count() as u32,
            24 => {
                if s[28] != 0.0 && s[29] == 0.0 {
                    4
                } else if s[30] == 0.0 || v(27) <= 0.0 {
                    0
                } else if v(27) > 0.002 {
                    3
                } else if v(27) > 0.001 {
                    2
                } else {
                    1
                }
            }
            25 => above(v(32), [0.0, v(33), v(33) * 2.0, v(33) * 3.0]),
            _ => 0,
        }
    }
}

fn above(value: f32, thresholds: [f32; 4]) -> u32 {
    thresholds
        .iter()
        .filter(|&&threshold| value > threshold)
        .count() as u32
}

thread_local! {
    static MOODLES: RefCell<MoodleState> = RefCell::new(MoodleState::initial());
    static MOODLE_STAGING: RefCell<Option<([f64; MOODLE_WORDS], usize)>> = const { RefCell::new(None) };
}

fn moodle_value_valid(index: usize, value: f64) -> bool {
    let (min, max, _, kind) = if index < MOODLE_INPUTS {
        MOODLE_LIMITS[index]
    } else {
        match index {
            34 => (0.0, 119.0, 0.0, 1),
            35 => (0.0, 4.0, 0.0, 1),
            36 => (1.0, 300.0, 300.0, 1),
            _ => return false,
        }
    };
    value.is_finite() && (min..=max).contains(&value) && (kind == 0 || value.fract() == 0.0)
}

#[unsafe(no_mangle)]
pub extern "C" fn moodle_input_limit(index: u32, field: u32) -> f64 {
    match MOODLE_LIMITS.get(index as usize) {
        Some(&(min, max, default, kind)) => match field {
            0 => min,
            1 => max,
            2 => default,
            3 => kind as f64,
            _ => f64::NAN,
        },
        None => f64::NAN,
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn moodle_state_value(index: u32) -> f64 {
    MOODLES.with(|state| {
        let state = state.borrow();
        match index as usize {
            i if i < MOODLE_INPUTS => state.inputs[i],
            34 => state.pain_timer as f64,
            35 => state.pain_level as f64,
            36 => state.cant_sprint_timer as f64,
            _ => f64::NAN,
        }
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn set_character_stat(index: u32, value: f64) -> i32 {
    if index >= 19 || !moodle_value_valid(index as usize, value) {
        return OUT_OF_RANGE;
    }
    MOODLES.with(|state| state.borrow_mut().inputs[index as usize] = value);
    OK
}

#[unsafe(no_mangle)]
pub extern "C" fn moodle_import_begin() {
    MOODLE_STAGING.with(|staging| *staging.borrow_mut() = Some(([0.0; MOODLE_WORDS], 0)));
}

#[unsafe(no_mangle)]
pub extern "C" fn moodle_import_abort() {
    MOODLE_STAGING.with(|staging| *staging.borrow_mut() = None);
}

#[unsafe(no_mangle)]
pub extern "C" fn moodle_import_stage(index: u32, value: f64) -> i32 {
    MOODLE_STAGING.with(|staging| {
        let mut staging = staging.borrow_mut();
        if let Some((values, next)) = staging.as_mut()
            && index as usize == *next
            && moodle_value_valid(*next, value)
        {
            values[*next] = value;
            *next += 1;
            return OK;
        }
        *staging = None;
        BAD_FORMAT
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn moodle_import_commit() -> i32 {
    MOODLE_STAGING.with(|staging| {
        let Some((values, count)) = staging.borrow_mut().take() else {
            return BAD_FORMAT;
        };
        if count != MOODLE_WORDS {
            return BAD_FORMAT;
        }
        let mut inputs = [0.0; MOODLE_INPUTS];
        inputs.copy_from_slice(&values[..MOODLE_INPUTS]);
        MOODLES.with(|state| {
            *state.borrow_mut() = MoodleState {
                inputs,
                pain_timer: values[34] as u32,
                pain_level: values[35] as u32,
                cant_sprint_timer: values[36] as u32,
            }
        });
        OK
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn moodle_reset() {
    MOODLES.with(|state| *state.borrow_mut() = MoodleState::initial());
    moodle_import_abort();
}

#[unsafe(no_mangle)]
pub extern "C" fn moodle_level(index: u32) -> u32 {
    MOODLES.with(|state| state.borrow().level(index, health()))
}

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
    // Project health scalar, not the native survival simulation.
    health: f64,
    next_item_id: u64,
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
            health: 100.0,
            next_item_id: 1,
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
    /// reached destination never leaves rounding residue behind. With an
    /// active world the engine follows the planned path tile by tile.
    fn advance_to_target(&mut self, dt: f32) {
        if world_extents().0 {
            self.advance_to_world(dt);
            return;
        }
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

    /// Follows the planned waypoint path, then the exact destination,
    /// consuming the frame's travel leg by leg: each leg is a segment the
    /// search (or a pre-verified straight line) proved legal, so a fast step
    /// snaps onto waypoints instead of cutting across the next boundary.
    fn advance_to_world(&mut self, dt: f32) {
        let mut travel = self.speed * dt;
        loop {
            let waypoint = WORLD.with(|world| {
                let world = world.borrow();
                if world.path_index < world.path.len() {
                    Some(world.path[world.path_index])
                } else {
                    None
                }
            });
            let aim = waypoint.unwrap_or((self.target_x, self.target_y));
            let aim_x = aim.0 - self.x;
            let aim_y = aim.1 - self.y;
            let distance = (aim_x * aim_x + aim_y * aim_y).sqrt();
            if distance > travel {
                let scale = travel / distance;
                let next = (self.x + aim_x * scale, self.y + aim_y * scale);
                if !line_passable((self.x, self.y), next) {
                    self.cancel();
                    clear_world_path();
                    return;
                }
                self.x = next.0;
                self.y = next.1;
                return;
            }
            if !line_passable((self.x, self.y), aim) {
                self.cancel();
                clear_world_path();
                return;
            }
            self.x = aim.0;
            self.y = aim.1;
            travel -= distance;
            match waypoint {
                None => {
                    self.action = ACTION_IDLE;
                    clear_world_path();
                    return;
                }
                Some(_) => WORLD.with(|world| world.borrow_mut().path_index += 1),
            }
        }
    }

    /// Moves along the stored unit heading and ends the action at a world
    /// edge (or, with an active grid, at the first blocked tile edge).
    fn advance_to_heading(&mut self, dt: f32) {
        let next_x = self.x + self.heading_x * self.speed * dt;
        let next_y = self.y + self.heading_y * self.speed * dt;
        if world_extents().0 {
            if line_passable((self.x, self.y), (next_x, next_y)) {
                self.x = next_x;
                self.y = next_y;
                return;
            }
            if next_x != self.x && line_passable((self.x, self.y), (next_x, self.y)) {
                self.x = next_x;
                return;
            }
            if next_y != self.y && line_passable((self.x, self.y), (self.x, next_y)) {
                self.y = next_y;
                return;
            }
            self.action = ACTION_IDLE;
            return;
        }
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

/// Navigation bits verified byte-by-byte across all 4065 shipped
/// `chunkdata_X_Y.bin` cell files (sub-chunk records: tag byte, then 64 tile
/// bytes for tag 2). Bit 5 (`NAV_VOID`) was observed only in north-edge cells
/// and is treated as impassable.
const NAV_SOLID: u8 = 0x01;
const NAV_WALL_NORTH: u8 = 0x02;
const NAV_WALL_WEST: u8 = 0x04;
const NAV_WATER: u8 = 0x08;
const NAV_ROOM: u8 = 0x10;
const NAV_VOID: u8 = 0x20;
const NAV_KNOWN_BITS: u8 =
    NAV_SOLID | NAV_WALL_NORTH | NAV_WALL_WEST | NAV_WATER | NAV_ROOM | NAV_VOID;

const TAG_EMPTY: u8 = 0;
const TAG_SOLID: u8 = 1;
const TAG_REGULAR: u8 = 2;
const TAG_WATER: u8 = 3;
const TAG_ROOM: u8 = 4;
const TAG_UNUSED: u8 = 5;

/// One map cell is 256x256 tiles (map.info: "Cell size is 256x256"), stored
/// as 1024 sub-chunk records of 8x8 tiles in row-major order.
const CELL_TILES: i64 = 256;
const CHUNK_TILES: i64 = 8;
/// 256 tiles per cell / 8 tiles per sub-chunk = 32x32 records per cell.
const CHUNKS_PER_AXIS: i64 = 32;
const CHUNK_RECORDS: i64 = 1024;
const CHUNK_BYTES: usize = 64;
const CELL_BYTES: usize = 65_536;
/// Cell-grid indices stay well inside i32 after the x256 multiply.
const MAX_CELL: i64 = 100;

/// A* work bound per destination; past it the engine refuses rather than
/// blocking a frame. Pathfinding over a few town cells stays far below.
const MAX_EXPANSIONS: u32 = 200_000;

/// Tile coordinate in a cell-local 256x256 grid.
#[derive(Clone, Copy, PartialEq, Eq)]
struct Tile {
    cx: i64,
    cy: i64,
    lx: i64,
    ly: i64,
}

fn tile_at(x: i64, y: i64) -> Tile {
    Tile {
        cx: x.div_euclid(CELL_TILES),
        cy: y.div_euclid(CELL_TILES),
        lx: x.rem_euclid(CELL_TILES),
        ly: y.rem_euclid(CELL_TILES),
    }
}

fn tile_key(tile: Tile) -> u64 {
    (((tile.cx as u32) as u64) << 32) | (tile.cy as u32) as u64
}

fn neighbour(tile: Tile, dx: i64, dy: i64) -> Tile {
    tile_at(
        tile.lx + dx + tile.cx * CELL_TILES,
        tile.ly + dy + tile.cy * CELL_TILES,
    )
}

/// Absolute tile coordinates; node keys for path search must be per-tile,
/// never per-cell.
fn tile_abs_x(tile: Tile) -> i64 {
    tile.cx * CELL_TILES + tile.lx
}

fn tile_abs_y(tile: Tile) -> i64 {
    tile.cy * CELL_TILES + tile.ly
}

fn tile_center(tile: Tile) -> (f32, f32) {
    (tile_abs_x(tile) as f32 + 0.5, tile_abs_y(tile) as f32 + 0.5)
}

/// Authoritative world grid plus the destination path the engine follows.
/// Cells arrive through the streaming per-sub-chunk import below; the host
/// sees only the dedicated scratch buffer, not the world's storage.
struct World {
    cells: std::collections::HashMap<u64, Vec<u8>>,
    min_x: i64,
    min_y: i64,
    max_x: i64,
    max_y: i64,
    active: bool,
    path: Vec<(f32, f32)>,
    path_index: usize,
    staging: Option<(i64, i64, i64, Vec<u8>)>,
}

impl World {
    fn new() -> World {
        World {
            cells: std::collections::HashMap::new(),
            min_x: 0,
            min_y: 0,
            max_x: 0,
            max_y: 0,
            active: false,
            path: Vec::new(),
            path_index: 0,
            staging: None,
        }
    }

    fn in_bounds(&self, tile: Tile) -> bool {
        self.active
            && (self.min_x..=self.max_x).contains(&tile.cx)
            && (self.min_y..=self.max_y).contains(&tile.cy)
    }

    fn byte_at(&self, tile: Tile) -> Option<u8> {
        self.cells
            .get(&tile_key(tile))
            .map(|cell| cell[(tile.ly * CELL_TILES + tile.lx) as usize])
    }

    fn flags_at(&self, tile: Tile) -> u32 {
        match self.byte_at(tile) {
            Some(byte) => {
                doors::flags(tile_abs_x(tile) as i32, tile_abs_y(tile) as i32, byte) as u32
            }
            None => 0xFFFF_FFFF,
        }
    }
    fn passable(&self, tile: Tile) -> bool {
        match self.byte_at(tile) {
            Some(byte) => byte & (NAV_SOLID | NAV_VOID) == 0,
            None => false,
        }
    }

    fn edge_clear(&self, tile: Tile, dx: i64, dy: i64) -> bool {
        let Some(from) = self
            .byte_at(tile)
            .map(|byte| doors::flags(tile_abs_x(tile) as i32, tile_abs_y(tile) as i32, byte))
        else {
            return false;
        };
        let next = neighbour(tile, dx, dy);
        let Some(to) = self
            .byte_at(next)
            .map(|byte| doors::flags(tile_abs_x(next) as i32, tile_abs_y(next) as i32, byte))
        else {
            return false;
        };
        if dx == 1 {
            return to & NAV_WALL_WEST == 0;
        }
        if dx == -1 {
            return from & NAV_WALL_WEST == 0;
        }
        if dy == 1 {
            return to & NAV_WALL_NORTH == 0;
        }
        from & NAV_WALL_NORTH == 0
    }
}

thread_local! {
    static WORLD: RefCell<World> = RefCell::new(World::new());
}

fn in_active_world(tile: Tile) -> bool {
    WORLD.with(|world| world.borrow().in_bounds(tile))
}

fn tile_passable(tile: Tile) -> bool {
    WORLD.with(|world| world.borrow().passable(tile))
}

/// Conservative straight-line check: samples every tile boundary crossing and
/// applies the same edge rules as the grid search.
fn line_passable(from: (f32, f32), to: (f32, f32)) -> bool {
    if ![from.0, from.1, to.0, to.1]
        .iter()
        .all(|value| value.is_finite())
    {
        return false;
    }
    let mut tile = tile_at(from.0.floor() as i64, from.1.floor() as i64);
    let end = tile_at(to.0.floor() as i64, to.1.floor() as i64);
    let dx = f64::from(to.0) - f64::from(from.0);
    let dy = f64::from(to.1) - f64::from(from.1);
    let sx = if dx > 0.0 { 1 } else { -1 };
    let sy = if dy > 0.0 { 1 } else { -1 };
    WORLD.with(|world| {
        let world = world.borrow();
        if !world.in_bounds(tile)
            || !world.passable(tile)
            || !world.in_bounds(end)
            || !world.passable(end)
        {
            return false;
        }
        while tile != end {
            // Absolute segment parameters, never accumulated distances.
            // At a negative-going integer endpoint, floor selects the tile
            // before that crossing; do not inspect an edge beyond the segment.
            let tx = if tile_abs_x(tile) == tile_abs_x(end) {
                f64::INFINITY
            } else {
                let boundary = tile_abs_x(tile) + i64::from(sx > 0);
                (boundary as f64 - f64::from(from.0)) / dx
            };
            let ty = if tile_abs_y(tile) == tile_abs_y(end) {
                f64::INFINITY
            } else {
                let boundary = tile_abs_y(tile) + i64::from(sy > 0);
                (boundary as f64 - f64::from(from.1)) / dy
            };
            if tx.min(ty) > 1.0 {
                return false;
            }
            if tx == ty {
                // Both routes around a touched corner must be clear: a
                // diagonal must not squeeze between solids or wall edges.
                let across_x = neighbour(tile, sx, 0);
                let across_y = neighbour(tile, 0, sy);
                let next = neighbour(tile, sx, sy);
                if !world.passable(across_x)
                    || !world.passable(across_y)
                    || !world.passable(next)
                    || !world.edge_clear(tile, sx, 0)
                    || !world.edge_clear(tile, 0, sy)
                    || !world.edge_clear(across_x, 0, sy)
                    || !world.edge_clear(across_y, sx, 0)
                {
                    return false;
                }
                tile = next;
            } else {
                let (step_x, step_y) = if tx < ty { (sx, 0) } else { (0, sy) };
                let next = neighbour(tile, step_x, step_y);
                if !world.passable(next) || !world.edge_clear(tile, step_x, step_y) {
                    return false;
                }
                tile = next;
            }
        }
        true
    })
}

/// Axis-aligned A* over the cell grids; exact integer costs avoid float
/// tie-breaks.
fn find_path(start: (f32, f32), goal: (f32, f32)) -> Option<Vec<(f32, f32)>> {
    let start_tile = tile_at(start.0.floor() as i64, start.1.floor() as i64);
    let goal_tile = tile_at(goal.0.floor() as i64, goal.1.floor() as i64);
    if !in_active_world(start_tile)
        || !tile_passable(start_tile)
        || !in_active_world(goal_tile)
        || !tile_passable(goal_tile)
    {
        return None;
    }
    if start_tile == goal_tile {
        return Some(Vec::new());
    }

    let pack = |tile: Tile| -> u64 {
        ((tile_abs_x(tile) as u32 as u64) << 32) | tile_abs_y(tile) as u32 as u64
    };
    let unpack = |packed: u64| tile_at((packed >> 32) as i32 as i64, packed as i32 as i64);
    let heuristic = |tile: Tile| {
        (tile_abs_x(tile) - tile_abs_x(goal_tile)).abs()
            + (tile_abs_y(tile) - tile_abs_y(goal_tile)).abs()
    };

    let mut open: std::collections::BinaryHeap<std::cmp::Reverse<(i64, u64)>> =
        std::collections::BinaryHeap::new();
    let mut cost: std::collections::HashMap<u64, i64> = std::collections::HashMap::new();
    let mut came_from: std::collections::HashMap<u64, u64> = std::collections::HashMap::new();
    let start_packed = pack(start_tile);

    cost.insert(start_packed, 0);
    open.push(std::cmp::Reverse((heuristic(start_tile), start_packed)));

    let mut expansions = 0_u32;
    let mut found = false;
    while let Some(std::cmp::Reverse((_, packed))) = open.pop() {
        let tile = unpack(packed);
        if tile == goal_tile {
            found = true;
            break;
        }
        let Some(best) = cost.get(&packed).copied() else {
            continue;
        };
        expansions += 1;
        if expansions > MAX_EXPANSIONS {
            return None;
        }
        for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
            let next = neighbour(tile, dx, dy);
            if !in_active_world(next) || !tile_passable(next) {
                continue;
            }
            if !WORLD.with(|world| world.borrow().edge_clear(tile, dx, dy)) {
                continue;
            }
            let next_packed = pack(next);
            let candidate = best + 1;
            if cost
                .get(&next_packed)
                .is_none_or(|existing| candidate < *existing)
            {
                cost.insert(next_packed, candidate);
                came_from.insert(next_packed, packed);
                open.push(std::cmp::Reverse((
                    candidate + heuristic(next),
                    next_packed,
                )));
            }
        }
    }
    if !found {
        return None;
    }

    let mut path = Vec::new();
    let mut cursor = pack(goal_tile);
    while cursor != start_packed {
        path.push(tile_center(unpack(cursor)));
        cursor = *came_from.get(&cursor)?;
    }
    // An off-centre start must first reach its own centre; aiming directly
    // at a neighbour centre can cross a different edge near a corner.
    path.push(tile_center(start_tile));
    path.reverse();
    Some(path)
}

fn clear_world_path() {
    WORLD.with(|world| {
        let mut world = world.borrow_mut();
        world.path.clear();
        world.path_index = 0;
    });
}

fn world_extents() -> (bool, i32, i32, i32, i32, u32) {
    WORLD.with(|world| {
        let world = world.borrow();
        let cells = world.cells.len().min(u32::MAX as usize) as u32;
        (
            world.active,
            world.min_x as i32,
            world.min_y as i32,
            world.max_x as i32,
            world.max_y as i32,
            cells,
        )
    })
}

// Per-thread state: one instance per thread on wasm and one per libtest thread
// natively, with no mutable-static aliasing and no per-update allocation.
thread_local! {
    static ENGINE: RefCell<Engine> = const { RefCell::new(Engine::initial()) };
}

// A single stable, eight-byte-aligned host transfer buffer; no allocator ABI
// and no arbitrary pointers into the engine's world or simulation storage.
thread_local! {
    static SCRATCH: RefCell<[f64; 12]> = const { RefCell::new([0.0; 12]) };
}

/// Base pointer for world_bounds/state_save/state_load, valid until instance
/// teardown. Hosts must reacquire memory views after calls that grow memory.
#[unsafe(no_mangle)]
pub extern "C" fn scratch_ptr() -> *mut u8 {
    SCRATCH.with(|scratch| scratch.as_ptr().cast())
}

/// Scratch capacity in bytes, shared by bounds, item rows and twelve state words.
#[unsafe(no_mangle)]
pub extern "C" fn scratch_size() -> u32 {
    96
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

/// Restores the initial position, speed, action and tick, and drops every
/// imported world cell: `reset` returns the engine to its complete initial
/// state, so a host restoring a save re-imports cells before `state_load`.
#[unsafe(no_mangle)]
pub extern "C" fn reset() {
    actions::full_reset();
    ANIMAL_ZONES.with(|zones| zones.borrow_mut().clear());
    world_reset();
    mutate(|engine| *engine = Engine::initial());
    ITEMS.with(|items| items.borrow_mut().reset());
    BODY_LOCATIONS.with(|registry| *registry.borrow_mut() = BodyRegistry::new());
    moodle_reset();
    body::reset();
    timing::reset();
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

/// Assigns a destination. Without an imported world the destination must be
/// inside [0, 10]^2 (the M1 synthetic plane). Once any world cell is imported
/// the destination is checked against the tile grid and the engine plans an
/// A* path; outside, blocked or unreachable destinations are refused, never
/// clamped. A destination equal to the current position is already reached.
#[unsafe(no_mangle)]
pub extern "C" fn move_to(x: f64, y: f64) -> i32 {
    let status = move_to_internal(x, y);
    if status == OK {
        return actions::movement_requested();
    }
    status
}
fn move_to_internal(x: f64, y: f64) -> i32 {
    if !x.is_finite() || !y.is_finite() {
        return NONFINITE;
    }
    if !world_extents().0 {
        if !in_world(x) || !in_world(y) {
            return OUT_OF_RANGE;
        }
        clear_world_path();
        return mutate(|engine| {
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
        });
    }
    let goal = tile_at(x.floor() as i64, y.floor() as i64);
    if !in_active_world(goal) || !tile_passable(goal) {
        return OUT_OF_RANGE;
    }
    let start = mutate(|engine| (engine.x, engine.y));
    let target = (x as f32, y as f32);
    if !tile_passable(tile_at(target.0.floor() as i64, target.1.floor() as i64)) {
        return OUT_OF_RANGE;
    }
    let path = if line_passable(start, target) {
        Vec::new()
    } else {
        match find_path(start, target) {
            Some(path) => path,
            None => return BLOCKED,
        }
    };
    WORLD.with(|world| {
        let mut world = world.borrow_mut();
        world.path = path;
        world.path_index = 0;
    });
    mutate(|engine| {
        engine.target_x = target.0;
        engine.target_y = target.1;
        engine.heading_x = 0.0;
        engine.heading_y = 0.0;
        if engine.is_at(target.0, target.1) {
            engine.action = ACTION_IDLE;
        } else {
            engine.action = ACTION_DESTINATION;
        }
        OK
    })
}
/// Sets a persistent heading; the direction is normalised in 64-bit arithmetic,
/// so the magnitude a consumer submits cannot change the distance travelled. A
/// zero direction cancels movement instead of inventing a heading. With an
/// active world, a heading that leaves the loaded grid or enters a blocked
/// tile is refused.
#[unsafe(no_mangle)]
pub extern "C" fn walk(x: f64, y: f64) -> i32 {
    if !x.is_finite() || !y.is_finite() {
        return NONFINITE;
    }
    let (unit_x, unit_y) = unit_direction(x, y);
    if unit_x == 0.0 && unit_y == 0.0 {
        clear_world_path();
        return mutate(|engine| {
            engine.cancel();
            OK
        });
    }
    if world_extents().0 {
        let start = mutate(|engine| (engine.x, engine.y));
        let probe = (start.0 + unit_x, start.1 + unit_y);
        if !line_passable(start, probe) {
            return BLOCKED;
        }
    }
    let queue_status = actions::movement_requested();
    clear_world_path();
    mutate(|engine| {
        engine.heading_x = unit_x;
        engine.heading_y = unit_y;
        engine.action = ACTION_WALKING;
    });
    queue_status
}
/// Cancels any destination or heading, leaving the current position intact.
#[unsafe(no_mangle)]
pub extern "C" fn cancel() {
    // ABI1 is deliberately void. Source-aware callers precheck queue_clear's
    // typed result and still invoke this hard primitive cancellation in finally.
    // This is the sole compatibility boundary that cannot return callback errors.
    let _ = actions::cancel_queue();
    clear_world_path();
    mutate(|engine| engine.cancel());
}
/// Advances one logical source frame; movement time accepts [0, 0.1].
#[unsafe(no_mangle)]
pub extern "C" fn step(dt: f64) -> i32 {
    if !dt.is_finite() {
        return NONFINITE;
    }
    if !(0.0..=MAX_STEP_SECONDS).contains(&dt) {
        return OUT_OF_RANGE;
    }
    advance_frame(dt, dt)
}
#[unsafe(no_mangle)]
pub extern "C" fn frame_step(raw_elapsed_seconds: f64) -> i32 {
    if !raw_elapsed_seconds.is_finite() {
        return NONFINITE;
    }
    if raw_elapsed_seconds < 0.0 {
        return OUT_OF_RANGE;
    }
    advance_frame(
        raw_elapsed_seconds.min(MAX_STEP_SECONDS),
        raw_elapsed_seconds,
    )
}
fn advance_frame(movement: f64, raw: f64) -> i32 {
    timing::frame(raw);
    mutate(|engine| {
        // ponytail: wraps after ~2.3 years at 60 Hz; reset() re-zeroes it.
        engine.tick = engine.tick.wrapping_add(1);
        engine.advance(movement as f32);
        MOODLES.with(|state| state.borrow_mut().advance(engine.health));
    });
    actions::frame()
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

/// Streams one 8x8 navigation sub-chunk of a map cell, mirroring the record
/// layout verified in shipped `chunkdata_X_Y.bin` files: a tag byte (0 empty,
/// 1 solid, 2 regular, 3 water, 4 room, 5 unused) followed, for tag 2 only,
/// by 64 tile bitfield bytes packed little-endian into eight i64 words.
/// Records arrive in row-major order over the 32x32 sub-chunk grid, `index`
/// in 0..1024. Index 0 starts staging a cell (replacing any half-imported
/// cell); all 1024 consecutive records are required before an atomic commit.
/// Invalid tags, flag bits, indexes or ordering discard staging, not live cells.
/// A committed cell cancels movement because the prior route may be obsolete.
#[unsafe(no_mangle)]
pub extern "C" fn world_import_chunk(
    cell_x: i32,
    cell_y: i32,
    index: i32,
    tag: u32,
    t0: i64,
    t1: i64,
    t2: i64,
    t3: i64,
    t4: i64,
    t5: i64,
    t6: i64,
    t7: i64,
) -> i32 {
    let cell_x = cell_x as i64;
    let cell_y = cell_y as i64;
    let index = index as i64;
    if !(-MAX_CELL..=MAX_CELL).contains(&cell_x) || !(-MAX_CELL..=MAX_CELL).contains(&cell_y) {
        WORLD.with(|world| world.borrow_mut().staging = None);
        return OUT_OF_RANGE;
    }
    if !(0..CHUNK_RECORDS).contains(&index) || tag > TAG_UNUSED as u32 {
        WORLD.with(|world| world.borrow_mut().staging = None);
        return BAD_FORMAT;
    }
    let fill = match tag as u8 {
        TAG_EMPTY => Some(0),
        TAG_SOLID => Some(NAV_SOLID),
        TAG_WATER => Some(NAV_WATER),
        TAG_ROOM => Some(NAV_ROOM),
        TAG_UNUSED => Some(NAV_VOID),
        TAG_REGULAR => None,
        _ => unreachable!(),
    };
    let mut tiles = [0_u8; CHUNK_BYTES];
    if let Some(fill) = fill {
        tiles.fill(fill);
    } else {
        for (bytes, word) in tiles
            .chunks_exact_mut(8)
            .zip([t0, t1, t2, t3, t4, t5, t6, t7])
        {
            bytes.copy_from_slice(&word.to_le_bytes());
        }
        if tiles.iter().any(|byte| byte & !NAV_KNOWN_BITS != 0) {
            WORLD.with(|world| world.borrow_mut().staging = None);
            return BAD_FORMAT;
        }
    }
    WORLD.with(|world| {
        let mut world = world.borrow_mut();
        if index == 0 {
            world.staging = Some((cell_x, cell_y, 0, vec![0; CELL_BYTES]));
        }
        let Some((staged_x, staged_y, next_index, mut cell)) = world.staging.take() else {
            return BAD_FORMAT;
        };
        if staged_x != cell_x || staged_y != cell_y || index != next_index {
            return BAD_FORMAT;
        }
        let chunk_x = index % CHUNKS_PER_AXIS;
        let chunk_y = index / CHUNKS_PER_AXIS;
        for row in 0..CHUNK_TILES {
            let dest =
                ((chunk_y * CHUNK_TILES + row) * CELL_TILES + chunk_x * CHUNK_TILES) as usize;
            cell[dest..dest + CHUNK_TILES as usize]
                .copy_from_slice(&tiles[(row * CHUNK_TILES) as usize..][..CHUNK_TILES as usize]);
        }
        if index == CHUNK_RECORDS - 1 {
            world.cells.insert(
                tile_key(Tile {
                    cx: cell_x,
                    cy: cell_y,
                    lx: 0,
                    ly: 0,
                }),
                cell,
            );
            if !world.active {
                world.active = true;
                world.min_x = cell_x;
                world.min_y = cell_y;
                world.max_x = cell_x;
                world.max_y = cell_y;
            } else {
                world.min_x = world.min_x.min(cell_x);
                world.min_y = world.min_y.min(cell_y);
                world.max_x = world.max_x.max(cell_x);
                world.max_y = world.max_y.max(cell_y);
            }
            world.path.clear();
            world.path_index = 0;
            // A replaced cell invalidates any prior route. Never leave a
            // destination active with an empty path (an illegal direct leg).
            mutate(|engine| engine.cancel());
            actions::invalidate();
        } else {
            world.staging = Some((cell_x, cell_y, index + 1, cell));
        }
        OK
    })
}

/// Drops every imported world cell and returns the engine to the M1
/// synthetic plane. Cancels movement, preserving position, speed and tick;
/// use reset() to also restore the initial actor state.
#[unsafe(no_mangle)]
pub extern "C" fn world_reset() {
    actions::invalidate();
    WORLD.with(|world| {
        let mut world = world.borrow_mut();
        world.cells.clear();
        world.staging = None;
        world.active = false;
        world.min_x = 0;
        world.min_y = 0;
        world.max_x = 0;
        world.max_y = 0;
        world.path.clear();
        world.path_index = 0;
    });
    doors::reset();
    mutate(|engine| engine.cancel());
}

/// Navigation flags for one absolute tile; 0xFFFFFFFF for unloaded tiles,
/// so the host can render and probe without engine memory access.
#[unsafe(no_mangle)]
pub extern "C" fn nav_flags(x: i32, y: i32) -> u32 {
    WORLD.with(|world| world.borrow().flags_at(tile_at(x as i64, y as i64)))
}

/// Writes [active, min_cell_x, min_cell_y, max_cell_x, max_cell_y, cell_count]
/// as six i32 words at scratch_ptr(). Other pointers are ignored.
#[unsafe(no_mangle)]
pub extern "C" fn world_bounds(out: *mut i32) {
    if out.cast::<u8>() != scratch_ptr() {
        return;
    }
    let (active, min_x, min_y, max_x, max_y, cells) = world_extents();
    let values = [i32::from(active), min_x, min_y, max_x, max_y, cells as i32];
    SCRATCH.with(|scratch| {
        let mut scratch = scratch.borrow_mut();
        // Both buffers are valid and disjoint; the destination has 96 bytes
        // and eight-byte alignment. Never dereference the caller's pointer.
        unsafe {
            std::ptr::copy_nonoverlapping(
                values.as_ptr(),
                scratch.as_mut_ptr().cast(),
                values.len(),
            );
        }
    });
}

/// Number of f64 words [`state_save`] writes and [`state_load`] reads.
#[unsafe(no_mangle)]
pub extern "C" fn state_size() -> u32 {
    12
}

/// Writes [x, y, speed, target_x, target_y, heading_x, heading_y, action,
/// tick, world-active, health, next-item-ID] into scratch_ptr().
#[unsafe(no_mangle)]
pub extern "C" fn state_save(out: *mut f64) {
    if out.cast::<u8>() != scratch_ptr() {
        return;
    }
    let engine = ENGINE.with(|engine| *engine.borrow());
    let values: [f64; 12] = [
        engine.x as f64,
        engine.y as f64,
        engine.speed as f64,
        engine.target_x as f64,
        engine.target_y as f64,
        engine.heading_x as f64,
        engine.heading_y as f64,
        engine.action as f64,
        engine.tick as f64,
        i32::from(world_extents().0) as f64,
        engine.health,
        engine.next_item_id as f64,
    ];
    SCRATCH.with(|scratch| *scratch.borrow_mut() = values);
}

/// Restores all twelve state words atomically from scratch_ptr(); other pointers
/// return OUT_OF_RANGE without being read. Destination paths are reconstructed
/// against the currently imported world before either state or route changes.
#[unsafe(no_mangle)]
pub extern "C" fn state_load(values: *const f64) -> i32 {
    if values.cast::<u8>() != scratch_ptr().cast_const() {
        return OUT_OF_RANGE;
    }
    let values = SCRATCH.with(|scratch| *scratch.borrow());
    let [
        x,
        y,
        speed,
        target_x,
        target_y,
        heading_x,
        heading_y,
        action,
        tick,
        world_active,
        health,
        next_item_id,
    ] = values;
    if !values.iter().all(|value| value.is_finite()) {
        return NONFINITE;
    }
    if !(MIN_SPEED..=MAX_SPEED).contains(&speed) {
        return OUT_OF_RANGE;
    }
    if action.fract() != 0.0
        || !(0.0..=2.0).contains(&action)
        || tick.fract() != 0.0
        || !(0.0..=u32::MAX as f64).contains(&tick)
    {
        return OUT_OF_RANGE;
    }
    if !(0.0..=100.0).contains(&health)
        || next_item_id.fract() != 0.0
        || !(1.0..=u32::MAX as f64 + 1.0).contains(&next_item_id)
        || ITEMS.with(|items| {
            items
                .borrow()
                .live
                .iter()
                .any(|item| item.id as f64 >= next_item_id)
        })
    {
        return OUT_OF_RANGE;
    }
    let action = action as u32;
    let heading_length = heading_x.hypot(heading_y);
    let zero_heading = heading_x == 0.0 && heading_y == 0.0;
    let unit_heading = (heading_length - 1.0).abs() <= 1.0e-6;
    if (action == ACTION_WALKING || !zero_heading) && !unit_heading
        || (action == ACTION_DESTINATION && !zero_heading)
    {
        return OUT_OF_RANGE;
    }
    let active = world_extents().0;
    if world_active != i32::from(active) as f64 {
        return OUT_OF_RANGE;
    }
    if active {
        for (px, py) in [
            (x, y),
            (target_x, target_y),
            (x as f32 as f64, y as f32 as f64),
            (target_x as f32 as f64, target_y as f32 as f64),
        ] {
            let tile = tile_at(px.floor() as i64, py.floor() as i64);
            if !in_active_world(tile) || !tile_passable(tile) {
                return OUT_OF_RANGE;
            }
        }
    } else if !in_world(x) || !in_world(y) || !in_world(target_x) || !in_world(target_y) {
        return OUT_OF_RANGE;
    }
    let path = if active && action == ACTION_DESTINATION {
        let start = (x as f32, y as f32);
        let goal = (target_x as f32, target_y as f32);
        if line_passable(start, goal) {
            Vec::new()
        } else {
            match find_path(start, goal) {
                Some(path) => path,
                None => return BLOCKED,
            }
        }
    } else {
        Vec::new()
    };
    WORLD.with(|world| {
        let mut world = world.borrow_mut();
        world.path = path;
        world.path_index = 0;
    });
    actions::invalidate();
    mutate(|engine| {
        engine.x = x as f32;
        engine.y = y as f32;
        engine.speed = speed as f32;
        engine.target_x = target_x as f32;
        engine.target_y = target_y as f32;
        engine.heading_x = heading_x as f32;
        engine.heading_y = heading_y as f32;
        engine.action = action;
        engine.tick = tick as u32;
        engine.health = health;
        if health == 0.0 {
            MOODLES.with(|state| state.borrow_mut().pain_level = 0);
        }
        engine.next_item_id = next_item_id as u64;
        OK
    })
}

// Ordered bounded native item/container ownership and source carry rules.
const MAX_ITEMS: usize = 4096;
const MAX_DEFS: usize = 4096;
const INVENTORY_CAPACITY: f32 = 50.0;
const MOODLE_MAX_WEIGHT: usize = 25;
const PLAYER_INVENTORY: u32 = 1;
const MAX_CONTAINERS: usize = MAX_ITEMS * 2 + 1;

// Identities are independent of group declaration/render order.
const BODY_LOCATION_CONSTANTS: &[(&str, &str)] = &[
    ("AMMO_STRAP", "AmmoStrap"),
    ("ANKLE_HOLSTER", "AnkleHolster"),
    ("BACK", "Back"),
    ("BANDAGE", "Bandage"),
    ("BATH_ROBE", "BathRobe"),
    ("BELLY_BUTTON", "BellyButton"),
    ("BELT", "Belt"),
    ("BELT_EXTRA", "BeltExtra"),
    ("BODY_COSTUME", "BodyCostume"),
    ("BOILERSUIT", "Boilersuit"),
    ("CALF_LEFT", "Calf_Left"),
    ("CALF_LEFT_TEXTURE", "Calf_Left_Texture"),
    ("CALF_RIGHT", "Calf_Right"),
    ("CALF_RIGHT_TEXTURE", "Calf_Right_Texture"),
    ("CODPIECE", "Codpiece"),
    ("CUIRASS", "Cuirass"),
    ("DRESS", "Dress"),
    ("EARS", "Ears"),
    ("EAR_TOP", "EarTop"),
    ("ELBOW_LEFT", "Elbow_Left"),
    ("ELBOW_RIGHT", "Elbow_Right"),
    ("EYES", "Eyes"),
    ("FANNY_PACK_BACK", "FannyPackBack"),
    ("FANNY_PACK_FRONT", "FannyPackFront"),
    ("FORE_ARM_LEFT", "ForeArm_Left"),
    ("FORE_ARM_RIGHT", "ForeArm_Right"),
    ("FULL_HAT", "FullHat"),
    ("FULL_ROBE", "FullRobe"),
    ("FULL_SUIT", "FullSuit"),
    ("FULL_SUIT_HEAD", "FullSuitHead"),
    ("FULL_SUIT_HEAD_SCBA", "FullSuitHeadSCBA"),
    ("FULL_TOP", "FullTop"),
    ("GAITER_LEFT", "Gaiter_Left"),
    ("GAITER_RIGHT", "Gaiter_Right"),
    ("GORGET", "Gorget"),
    ("HANDS", "Hands"),
    ("HANDS_LEFT", "HandsLeft"),
    ("HANDS_RIGHT", "HandsRight"),
    ("HAT", "Hat"),
    ("JACKET", "Jacket"),
    ("JACKET_BULKY", "Jacket_Bulky"),
    ("JACKET_DOWN", "Jacket_Down"),
    ("JACKET_HAT", "JacketHat"),
    ("JACKET_HAT_BULKY", "JacketHat_Bulky"),
    ("JACKET_SUIT", "JacketSuit"),
    ("JERSEY", "Jersey"),
    ("KNEE_LEFT", "Knee_Left"),
    ("KNEE_RIGHT", "Knee_Right"),
    ("LEFT_MIDDLE_FINGER", "Left_MiddleFinger"),
    ("LEFT_RING_FINGER", "Left_RingFinger"),
    ("LEFT_ARM", "LeftArm"),
    ("LEFT_EYE", "LeftEye"),
    ("LEFT_WRIST", "LeftWrist"),
    ("LEGS1", "Legs1"),
    ("LEGS5", "Legs5"),
    ("LONG_DRESS", "LongDress"),
    ("LONG_SKIRT", "LongSkirt"),
    ("MAKE_UP_EYES", "MakeUp_Eyes"),
    ("MAKE_UP_EYES_SHADOW", "MakeUp_EyesShadow"),
    ("MAKE_UP_FULL_FACE", "MakeUp_FullFace"),
    ("MAKE_UP_LIPS", "MakeUp_Lips"),
    ("MASK", "Mask"),
    ("MASK_EYES", "MaskEyes"),
    ("MASK_FULL", "MaskFull"),
    ("NECK", "Neck"),
    ("NECK_TEXTURE", "Neck_Texture"),
    ("NECKLACE", "Necklace"),
    ("NECKLACE_LONG", "Necklace_Long"),
    ("NOSE", "Nose"),
    ("PANTS", "Pants"),
    ("PANTS_SKINNY", "Pants_Skinny"),
    ("PANTS_EXTRA", "PantsExtra"),
    ("RIGHT_MIDDLE_FINGER", "Right_MiddleFinger"),
    ("RIGHT_RING_FINGER", "Right_RingFinger"),
    ("RIGHT_ARM", "RightArm"),
    ("RIGHT_EYE", "RightEye"),
    ("RIGHT_WRIST", "RightWrist"),
    ("SATCHEL", "Satchel"),
    ("SCARF", "Scarf"),
    ("SCBA", "SCBA"),
    ("SCBANOTANK", "SCBAnotank"),
    ("SHIRT", "Shirt"),
    ("SHOES", "Shoes"),
    ("SHORT_PANTS", "ShortPants"),
    ("SHORT_SLEEVE_SHIRT", "ShortSleeveShirt"),
    ("SHORTS_SHORT", "ShortsShort"),
    ("SHOULDER_HOLSTER", "ShoulderHolster"),
    ("SHOULDERPAD_LEFT", "ShoulderpadLeft"),
    ("SHOULDERPAD_RIGHT", "ShoulderpadRight"),
    ("SKIRT", "Skirt"),
    ("SOCKS", "Socks"),
    ("SPORT_SHOULDERPAD", "SportShoulderpad"),
    ("SPORT_SHOULDERPAD_ON_TOP", "SportShoulderpadOnTop"),
    ("SWEATER", "Sweater"),
    ("SWEATER_HAT", "SweaterHat"),
    ("TAIL", "Tail"),
    ("TANK_TOP", "TankTop"),
    ("THIGH_LEFT", "Thigh_Left"),
    ("THIGH_RIGHT", "Thigh_Right"),
    ("TORSO1LEGS1", "Torso1Legs1"),
    ("TORSO1", "Torso1"),
    ("TORSO_EXTRA", "TorsoExtra"),
    ("TORSO_EXTRA_VEST", "TorsoExtraVest"),
    ("TORSO_EXTRA_VEST_BULLET", "TorsoExtraVestBullet"),
    ("TSHIRT", "Tshirt"),
    ("UNDERWEAR", "Underwear"),
    ("UNDERWEAR_BOTTOM", "UnderwearBottom"),
    ("UNDERWEAR_EXTRA1", "UnderwearExtra1"),
    ("UNDERWEAR_EXTRA2", "UnderwearExtra2"),
    ("UNDERWEAR_TOP", "UnderwearTop"),
    ("VEST_TEXTURE", "VestTexture"),
    ("WEBBING", "Webbing"),
    ("WOUND", "Wound"),
    ("ZED_DMG", "ZedDmg"),
];

struct BodyLocationIdentity {
    canonical: String,
    translation: String,
    constant: &'static str,
}

struct BodyGroupLocation {
    id: u32,
    multi: bool,
    relations: [Vec<u32>; 3],
}

struct BodyGroup {
    name: String,
    locations: Vec<BodyGroupLocation>,
    active: bool,
}

impl BodyGroup {
    fn index(&self, location: u32) -> Option<usize> {
        self.locations
            .iter()
            .position(|member| member.id == location)
    }
}

struct BodyRegistry {
    identities: Vec<BodyLocationIdentity>,
    groups: Vec<BodyGroup>,
    initialized: bool,
}

impl BodyRegistry {
    fn new() -> Self {
        Self {
            identities: BODY_LOCATION_CONSTANTS
                .iter()
                .map(|(constant, translation)| BodyLocationIdentity {
                    canonical: format!("base:{}", translation.to_lowercase()),
                    translation: (*translation).to_owned(),
                    constant,
                })
                .collect(),
            groups: vec![BodyGroup {
                name: "Human".to_owned(),
                locations: Vec::new(),
                active: true,
            }],
            initialized: false,
        }
    }

    fn group(&self, token: u32) -> Option<&BodyGroup> {
        token
            .checked_sub(1)
            .and_then(|index| self.groups.get(index as usize))
    }

    fn group_mut(&mut self, token: u32) -> Option<&mut BodyGroup> {
        token
            .checked_sub(1)
            .and_then(|index| self.groups.get_mut(index as usize))
    }

    fn identity_valid(&self, token: u32) -> bool {
        token != 0 && token as usize <= self.identities.len()
    }

    fn lookup(&self, name: &str) -> Option<u32> {
        let (namespace, path) = name.split_once(':').unwrap_or(("base", name));
        if namespace.is_empty() || path.is_empty() {
            return None;
        }
        let namespace = body_lowercase(namespace);
        let path = body_lowercase(path);
        self.identities
            .iter()
            .position(|identity| {
                let (registered_namespace, registered_path) =
                    identity.canonical.split_once(':').unwrap();
                namespace.eq_ignore_ascii_case(registered_namespace)
                    && path.eq_ignore_ascii_case(registered_path)
            })
            .map(|index| index as u32 + 1)
    }
}

fn body_lowercase(value: &str) -> std::borrow::Cow<'_, str> {
    if value.is_ascii() {
        std::borrow::Cow::Borrowed(value)
    } else {
        std::borrow::Cow::Owned(value.to_lowercase())
    }
}

thread_local! {
    static BODY_LOCATIONS: RefCell<BodyRegistry> = RefCell::new(BodyRegistry::new());
}

fn with_body_text(length: u32, operation: impl FnOnce(&str) -> i32) -> i32 {
    if length == 0 || length > scratch_size() {
        return OUT_OF_RANGE;
    }
    SCRATCH.with(|scratch| {
        let words = scratch.borrow();
        let bytes =
            unsafe { std::slice::from_raw_parts(words.as_ptr().cast::<u8>(), length as usize) };
        match std::str::from_utf8(bytes) {
            Ok(text) => operation(text),
            Err(_) => BAD_FORMAT,
        }
    })
}

fn write_body_text(text: &str) -> i32 {
    if text.len() > scratch_size() as usize {
        return OUT_OF_RANGE;
    }
    SCRATCH.with(|scratch| {
        let mut words = scratch.borrow_mut();
        let bytes = unsafe { std::slice::from_raw_parts_mut(words.as_mut_ptr().cast::<u8>(), 96) };
        bytes[..text.len()].copy_from_slice(text.as_bytes());
    });
    text.len() as i32
}

#[unsafe(no_mangle)]
pub extern "C" fn body_location_lookup(length: u32) -> i32 {
    with_body_text(length, |name| {
        BODY_LOCATIONS.with(|registry| registry.borrow().lookup(name).unwrap_or(0) as i32)
    })
}

/// ResourceLocation.of without registration; lowercases namespace/path, never trims.
#[unsafe(no_mangle)]
pub extern "C" fn body_location_canonical(length: u32) -> i32 {
    let mut output = [0_u8; 96];
    let count = with_body_text(length, |name| {
        let (namespace, path) = name.split_once(':').unwrap_or(("base", name));
        if namespace.is_empty() || path.is_empty() {
            return OUT_OF_RANGE;
        }
        let namespace = body_lowercase(namespace);
        let path = body_lowercase(path);
        let mut count = 0;
        for byte in namespace
            .bytes()
            .chain(std::iter::once(b':'))
            .chain(path.bytes())
        {
            if count == output.len() {
                return OUT_OF_RANGE;
            }
            output[count] = byte.to_ascii_lowercase();
            count += 1;
        }
        count as i32
    });
    if count < 0 {
        return count;
    }
    write_body_text(std::str::from_utf8(&output[..count as usize]).unwrap())
}

#[unsafe(no_mangle)]
pub extern "C" fn body_location_register(length: u32) -> i32 {
    with_body_text(length, |name| {
        let (namespace, path) = name.split_once(':').unwrap_or(("base", name));
        if namespace.is_empty() || path.is_empty() || namespace.eq_ignore_ascii_case("base") {
            return OUT_OF_RANGE;
        }
        BODY_LOCATIONS.with(|registry| {
            let mut registry = registry.borrow_mut();
            if registry.lookup(name).is_some() {
                return BAD_FORMAT;
            }
            let canonical = format!("{}:{}", namespace.to_lowercase(), path.to_lowercase());
            if canonical.len() > 96 || registry.identities.len() >= MAX_DEFS {
                return OUT_OF_RANGE;
            }
            registry.identities.push(BodyLocationIdentity {
                canonical,
                translation: name.to_owned(),
                constant: "",
            });
            registry.identities.len() as i32
        })
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn body_location_count() -> u32 {
    BODY_LOCATIONS.with(|registry| registry.borrow().identities.len() as u32)
}

/// UTF-8 scratch fields: canonical ID, original translation spelling, constant field.
#[unsafe(no_mangle)]
pub extern "C" fn body_location_read(token: u32, field: u32) -> i32 {
    BODY_LOCATIONS.with(|registry| {
        let registry = registry.borrow();
        let Some(identity) = token
            .checked_sub(1)
            .and_then(|index| registry.identities.get(index as usize))
        else {
            return OUT_OF_RANGE;
        };
        write_body_text(match field {
            0 => &identity.canonical,
            1 => &identity.translation,
            2 => identity.constant,
            _ => return OUT_OF_RANGE,
        })
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn body_group_get(length: u32, create: u32) -> i32 {
    if create > 1 {
        return OUT_OF_RANGE;
    }
    with_body_text(length, |name| {
        BODY_LOCATIONS.with(|registry| {
            let mut registry = registry.borrow_mut();
            if let Some(index) = registry
                .groups
                .iter()
                .position(|group| group.active && group.name == name)
            {
                return index as i32 + 1;
            }
            if create == 0 {
                return 0;
            }
            if registry.groups.len() >= MAX_DEFS {
                return OUT_OF_RANGE;
            }
            registry.groups.push(BodyGroup {
                name: name.to_owned(),
                locations: Vec::new(),
                active: true,
            });
            registry.groups.len() as i32
        })
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn body_group_count() -> u32 {
    BODY_LOCATIONS.with(|registry| {
        registry
            .borrow()
            .groups
            .iter()
            .filter(|group| group.active)
            .count() as u32
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn body_group_at(index: u32) -> u32 {
    BODY_LOCATIONS.with(|registry| {
        registry
            .borrow()
            .groups
            .iter()
            .enumerate()
            .filter(|(_, group)| group.active)
            .nth(index as usize)
            .map(|(index, _)| index as u32 + 1)
            .unwrap_or(0)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn body_group_total_count() -> u32 {
    BODY_LOCATIONS.with(|registry| registry.borrow().groups.len() as u32)
}

#[unsafe(no_mangle)]
pub extern "C" fn body_group_active(group: u32) -> i32 {
    BODY_LOCATIONS.with(|registry| {
        registry
            .borrow()
            .group(group)
            .map(|group| i32::from(group.active))
            .unwrap_or(OUT_OF_RANGE)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn body_group_detach(group: u32) -> i32 {
    BODY_LOCATIONS.with(|registry| {
        let mut registry = registry.borrow_mut();
        let Some(group) = registry.group_mut(group) else {
            return OUT_OF_RANGE;
        };
        group.active = false;
        OK
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn body_group_name(group: u32) -> i32 {
    BODY_LOCATIONS.with(|registry| {
        registry
            .borrow()
            .group(group)
            .map(|group| write_body_text(&group.name))
            .unwrap_or(OUT_OF_RANGE)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn body_group_location_count(group: u32) -> i32 {
    BODY_LOCATIONS.with(|registry| {
        registry
            .borrow()
            .group(group)
            .map(|group| group.locations.len() as i32)
            .unwrap_or(OUT_OF_RANGE)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn body_group_location_at(group: u32, index: u32) -> u32 {
    BODY_LOCATIONS.with(|registry| {
        registry
            .borrow()
            .group(group)
            .and_then(|group| group.locations.get(index as usize))
            .map(|member| member.id)
            .unwrap_or(0)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn body_group_location_index(group: u32, location: u32) -> i32 {
    BODY_LOCATIONS.with(|registry| {
        registry
            .borrow()
            .group(group)
            .and_then(|group| group.index(location))
            .map(|index| index as i32)
            .unwrap_or(-1)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn body_group_location_add(group: u32, location: u32) -> i32 {
    BODY_LOCATIONS.with(|registry| {
        let mut registry = registry.borrow_mut();
        if !registry.identity_valid(location) {
            return OUT_OF_RANGE;
        }
        let Some(group) = registry.group_mut(group) else {
            return OUT_OF_RANGE;
        };
        if group.index(location).is_none() {
            group.locations.push(BodyGroupLocation {
                id: location,
                multi: false,
                relations: std::array::from_fn(|_| Vec::new()),
            });
        }
        OK
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn body_group_multi_set(group: u32, location: u32, enabled: u32) -> i32 {
    if enabled > 1 {
        return OUT_OF_RANGE;
    }
    BODY_LOCATIONS.with(|registry| {
        let mut registry = registry.borrow_mut();
        let Some(group) = registry.group_mut(group) else {
            return OUT_OF_RANGE;
        };
        let Some(index) = group.index(location) else {
            return OUT_OF_RANGE;
        };
        group.locations[index].multi = enabled != 0;
        OK
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn body_group_multi_get(group: u32, location: u32) -> i32 {
    BODY_LOCATIONS.with(|registry| {
        let registry = registry.borrow();
        let Some(group) = registry.group(group) else {
            return OUT_OF_RANGE;
        };
        group
            .index(location)
            .map(|index| i32::from(group.locations[index].multi))
            .unwrap_or(OUT_OF_RANGE)
    })
}

/// Kinds: 0 symmetric exclusive, 1 hide, 2 alternate, 3 directional exclusive.
#[unsafe(no_mangle)]
pub extern "C" fn body_group_relation_set(group: u32, from: u32, to: u32, kind: u32) -> i32 {
    BODY_LOCATIONS.with(|registry| {
        let mut registry = registry.borrow_mut();
        if kind > 3 || !registry.identity_valid(to) {
            return OUT_OF_RANGE;
        }
        let Some(group) = registry.group_mut(group) else {
            return OUT_OF_RANGE;
        };
        let Some(index) = group.index(from) else {
            return OUT_OF_RANGE;
        };
        let relations =
            &mut group.locations[index].relations[(if kind == 3 { 0 } else { kind }) as usize];
        if !relations.contains(&to) {
            relations.push(to);
        }
        if kind == 0 {
            // Original group setter mutates the source before a missing target fails.
            let Some(index) = group.index(to) else {
                return OUT_OF_RANGE;
            };
            let relations = &mut group.locations[index].relations[0];
            if !relations.contains(&from) {
                relations.push(from);
            }
        }
        OK
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn body_group_relation_get(group: u32, from: u32, to: u32, kind: u32) -> i32 {
    BODY_LOCATIONS.with(|registry| {
        let registry = registry.borrow();
        let Some(group) = registry.group(group) else {
            return OUT_OF_RANGE;
        };
        let Some(index) = group.index(from) else {
            return OUT_OF_RANGE;
        };
        let Some(relations) = group.locations[index]
            .relations
            .get((if kind == 3 { 0 } else { kind }) as usize)
        else {
            return OUT_OF_RANGE;
        };
        i32::from(relations.contains(&to))
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn body_group_relation_count(group: u32, from: u32, kind: u32) -> i32 {
    BODY_LOCATIONS.with(|registry| {
        let registry = registry.borrow();
        let Some(group) = registry.group(group) else {
            return OUT_OF_RANGE;
        };
        group
            .index(from)
            .and_then(|index| {
                group.locations[index]
                    .relations
                    .get((if kind == 3 { 0 } else { kind }) as usize)
            })
            .map(|relations| relations.len() as i32)
            .unwrap_or(OUT_OF_RANGE)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn body_group_relation_at(group: u32, from: u32, kind: u32, index: u32) -> u32 {
    BODY_LOCATIONS.with(|registry| {
        let registry = registry.borrow();
        registry
            .group(group)
            .and_then(|group| {
                group.index(from).and_then(|member| {
                    group.locations[member]
                        .relations
                        .get((if kind == 3 { 0 } else { kind }) as usize)
                })
            })
            .and_then(|relations| relations.get(index as usize))
            .copied()
            .unwrap_or(0)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn body_group_move(group: u32, location: u32, target: i32) -> i32 {
    BODY_LOCATIONS.with(|registry| {
        let mut registry = registry.borrow_mut();
        let Some(group) = registry.group_mut(group) else {
            return OUT_OF_RANGE;
        };
        if target >= 0
            && (target as usize) < group.locations.len()
            && let Some(index) = group.index(location)
        {
            let member = group.locations.remove(index);
            group.locations.insert(target as usize, member);
        }
        OK
    })
}

/// Detached group objects remain queryable, as do their bound WornItems.
#[unsafe(no_mangle)]
pub extern "C" fn body_locations_reset() -> i32 {
    BODY_LOCATIONS.with(|registry| {
        let mut registry = registry.borrow_mut();
        for group in &mut registry.groups {
            group.active = false;
        }
        registry.initialized = false;
    });
    OK
}

#[unsafe(no_mangle)]
pub extern "C" fn body_registry_initialized() -> u32 {
    BODY_LOCATIONS.with(|registry| u32::from(registry.borrow().initialized))
}

#[unsafe(no_mangle)]
pub extern "C" fn body_registry_set_initialized(enabled: u32) -> i32 {
    if enabled > 1 {
        return OUT_OF_RANGE;
    }
    BODY_LOCATIONS.with(|registry| registry.borrow_mut().initialized = enabled != 0);
    OK
}

#[derive(Clone, Copy)]
struct ItemDefinition {
    owner: u32,
    condition_max: i32,
    slot: u32,
    stack_limit: u32,
    remove_on_broken: bool,
    condition_lower_chance_one_in: u32,
    weight: f32,
    awkward_gloves: bool,
    can_equip: u32,
    bag: bool,
    capacity: i32,
    reduction: i32,
    max_item_size: f32,
    type_token: u32,
    category: u32,
    only_category: u32,
    accept_function: u32,
    graph_flags: u32,
}

#[derive(Clone, Copy)]
struct Item {
    id: u32,
    definition: u32,
    owner_container: u32,
    internal_container: u32,
    world_object: bool,
    x: f64,
    y: f64,
    condition: i32,
    count: u32,
    slot: u32,
    weight: f32,
    actual_weight: f32,
    source_flags: u32,
}

#[derive(Clone, Copy)]
struct Container {
    id: u32,
    kind: u32,
    parent_kind: u32,
    parent_id: u32,
    containing_item: u32,
    capacity: i32,
    reduction: i32,
    xyz: (i32, i32, i32),
    flags: u32,
    definition: u32,
    type_token: u32,
    only_category: u32,
    accept_function: u32,
}

impl Container {
    fn actor() -> Self {
        Self {
            id: PLAYER_INVENTORY,
            kind: 1,
            parent_kind: 1,
            parent_id: 1,
            containing_item: 0,
            capacity: 50,
            reduction: 0,
            xyz: (0, 0, 0),
            flags: 0,
            definition: 0,
            type_token: 1,
            only_category: 0,
            accept_function: 0,
        }
    }
}

struct Items {
    definitions: Vec<ItemDefinition>,
    journal: Vec<(usize, ItemDefinition)>,
    transaction_owner: u32,
    transaction_start: usize,
    frozen: bool,
    live: Vec<Item>,
    staged: Vec<Item>,
    containers: Vec<Container>,
    staged_containers: Vec<Container>,
    next_container: u64,
    staged_next_container: u64,
    organized: bool,
    disorganized: bool,
    equipped_multiplier: f32,
    staged_policy: (bool, bool, f32),
    drop_items_center: bool,
    staged_drop_items_center: bool,
    actor_turn_target: u32,
    actor_furniture: u32,
    actor_vehicle: u32,
    retired_source_flags: Vec<(u32, u32)>,
    worn: Vec<u32>,
    staged_worn: Vec<u32>,
    explicit_worn: bool,
    worn_group: u32,
    importing: bool,
    source_transfer: bool,
    actor_overlay: u32,
    attached: Vec<u32>,
    last_id: u32,
    hands_slot: u32,
    transaction_hands_slot: u32,
    held: [u32; 2],
}

impl Items {
    fn new() -> Self {
        Self {
            definitions: Vec::with_capacity(MAX_DEFS),
            journal: Vec::with_capacity(MAX_DEFS),
            transaction_owner: 0,
            transaction_start: 0,
            frozen: false,
            live: Vec::with_capacity(MAX_ITEMS),
            staged: Vec::with_capacity(MAX_ITEMS),
            containers: {
                let mut rows = Vec::with_capacity(MAX_CONTAINERS);
                rows.push(Container::actor());
                rows
            },
            staged_containers: Vec::with_capacity(MAX_CONTAINERS),
            next_container: 2,
            staged_next_container: 2,
            organized: false,
            disorganized: false,
            equipped_multiplier: 0.3,
            staged_policy: (false, false, 0.3),
            drop_items_center: false,
            staged_drop_items_center: false,
            actor_turn_target: 0,
            actor_furniture: 0,
            actor_vehicle: 0,
            retired_source_flags: Vec::with_capacity(MAX_ITEMS * 3),
            worn: Vec::with_capacity(MAX_ITEMS),
            staged_worn: Vec::with_capacity(MAX_ITEMS),
            explicit_worn: false,
            worn_group: 1,
            importing: false,
            source_transfer: false,
            actor_overlay: 0,
            attached: Vec::new(),
            last_id: 0,
            hands_slot: 36, // Canonical base:hands, independent of Human declaration order.
            transaction_hands_slot: 36,
            held: [0; 2],
        }
    }

    fn reset(&mut self) {
        self.definitions.clear();
        self.journal.clear();
        self.transaction_owner = 0;
        self.transaction_start = 0;
        self.frozen = false;
        self.live.clear();
        self.staged.clear();
        self.containers.clear();
        self.containers.push(Container::actor());
        self.staged_containers.clear();
        self.next_container = 2;
        self.staged_next_container = 2;
        self.organized = false;
        self.disorganized = false;
        self.equipped_multiplier = 0.3;
        self.staged_policy = (false, false, 0.3);
        self.drop_items_center = false;
        self.staged_drop_items_center = false;
        self.actor_turn_target = 0;
        self.actor_furniture = 0;
        self.actor_vehicle = 0;
        self.retired_source_flags.clear();
        self.worn.clear();
        self.staged_worn.clear();
        self.explicit_worn = false;
        self.worn_group = 1;
        self.importing = false;
        self.source_transfer = false;
        self.actor_overlay = 0;
        self.attached.clear();
        self.last_id = 0;
        self.hands_slot = 36;
        self.transaction_hands_slot = 36;
        self.held = [0; 2];
    }

    fn abort_import(&mut self) {
        self.staged.clear();
        self.staged_containers.clear();
        self.staged_worn.clear();
        self.explicit_worn = false;
        self.importing = false;
    }

    fn valid(&self, item: &Item) -> bool {
        let Some(definition) = self.definitions.get(item.definition as usize) else {
            return false;
        };
        item.id != 0
            && item.owner_container != 0
            && item.x.is_finite()
            && item.y.is_finite()
            && item.condition >= 0
            && item.condition <= definition.condition_max
            && item.count > 0
            && item.count <= definition.stack_limit
            && item.weight.is_finite()
            && item.weight >= 0.0
            && item.actual_weight.is_finite()
            && item.actual_weight >= 0.0
            && (item.slot == 0
                || (item.owner_container == PLAYER_INVENTORY
                    && BODY_LOCATIONS.with(|registry| {
                        registry
                            .borrow()
                            .group(self.worn_group)
                            .is_some_and(|group| group.index(item.slot).is_some())
                    })))
            && (!item.world_object || item_position_valid(item.x, item.y))
    }

    fn valid_held(&self, id: u32) -> bool {
        id == 0
            || self.live.iter().any(|item| {
                item.id == id && item.owner_container == PLAYER_INVENTORY && self.valid(item)
            })
    }

    fn clear_held(&mut self, id: u32) {
        for held in &mut self.held {
            if *held == id {
                *held = 0;
            }
        }
    }

    fn remove_worn(&mut self, id: u32) {
        self.worn.retain(|old| *old != id);
        if let Some(item) = self.live.iter_mut().find(|item| item.id == id) {
            item.slot = 0;
        }
    }

    fn set_worn(&mut self, location: u32, id: u32) -> i32 {
        if self.importing
            || self.source_transfer
            || self.transaction_owner != 0
            || (id != 0
                && !self
                    .live
                    .iter()
                    .any(|item| item.id == id && item.owner_container == PLAYER_INVENTORY))
        {
            return OUT_OF_RANGE;
        }
        BODY_LOCATIONS.with(|registry| {
            let registry = registry.borrow();
            let Some(group) = registry.group(self.worn_group) else {
                return OUT_OF_RANGE;
            };
            let Some(location_index) = group.index(location) else {
                return OUT_OF_RANGE;
            };
            let member = &group.locations[location_index];
            if !member.multi
                && let Some(old_id) = self.worn.iter().copied().find(|old_id| {
                    self.live
                        .iter()
                        .any(|item| item.id == *old_id && item.slot == location)
                })
            {
                self.remove_worn(old_id);
            }
            let mut index = 0;
            while index < self.worn.len() {
                let old_id = self.worn[index];
                let slot = self
                    .live
                    .iter()
                    .find(|item| item.id == old_id)
                    .unwrap()
                    .slot;
                if member.relations[0].contains(&slot) {
                    self.remove_worn(old_id);
                } else {
                    index += 1;
                }
            }
            if id == 0 {
                return OK;
            }
            self.remove_worn(id);
            let index = self
                .worn
                .iter()
                .position(|old_id| {
                    let slot = self
                        .live
                        .iter()
                        .find(|item| item.id == *old_id)
                        .unwrap()
                        .slot;
                    group
                        .index(slot)
                        .is_some_and(|index| index > location_index)
                })
                .unwrap_or(self.worn.len());
            self.live
                .iter_mut()
                .find(|item| item.id == id)
                .unwrap()
                .slot = location;
            self.worn.insert(index, id);
            OK
        })
    }

    fn valid_worn(&self, rows: &[Item], worn: &[u32]) -> bool {
        if rows.iter().filter(|item| item.slot != 0).count() != worn.len() {
            return false;
        }
        BODY_LOCATIONS.with(|registry| {
            let registry = registry.borrow();
            let Some(group) = registry.group(self.worn_group) else {
                return worn.is_empty();
            };
            for (position, id) in worn.iter().enumerate() {
                let Some(item) = rows.iter().find(|item| {
                    item.id == *id && item.slot != 0 && item.owner_container == PLAYER_INVENTORY
                }) else {
                    return false;
                };
                if group.index(item.slot).is_none() {
                    return false;
                }
                if worn[..position].contains(id) {
                    return false;
                }
            }
            // A snapshot preserves records, not a replay against today's mutable group rules.
            if self.explicit_worn {
                return true;
            }
            for member in &group.locations {
                let count = rows.iter().filter(|item| item.slot == member.id).count();
                if count == 0 {
                    continue;
                }
                if count > 1 && !member.multi {
                    return false;
                }
                for exclusive in &member.relations[0] {
                    if (*exclusive == member.id && count > 1)
                        || (*exclusive != member.id
                            && rows.iter().any(|item| item.slot == *exclusive))
                    {
                        return false;
                    }
                }
            }
            true
        })
    }

    fn capacity_weight(&self) -> f32 {
        self.container_capacity_weight(PLAYER_INVENTORY)
    }

    fn container(&self, id: u32) -> Option<&Container> {
        self.containers.iter().find(|row| row.id == id)
    }

    fn parent_container(&self, id: u32) -> Option<u32> {
        let row = self.container(id)?;
        self.live
            .iter()
            .find(|item| item.id == row.containing_item)
            .and_then(|item| (item.owner_container != 0).then_some(item.owner_container))
    }

    fn outermost(&self, mut id: u32) -> Option<u32> {
        self.container(id)?;
        for _ in 0..=self.containers.len() {
            match self.parent_container(id) {
                Some(parent) => id = parent,
                None => return Some(id),
            }
        }
        None
    }

    fn inside(&self, mut container: u32, item: u32) -> bool {
        for _ in 0..self.containers.len() {
            let Some(row) = self.container(container) else {
                return false;
            };
            if row.containing_item == item {
                return true;
            }
            let Some(parent) = self.parent_container(container) else {
                return false;
            };
            container = parent;
        }
        false
    }

    fn contains(&self, container: u32, id: u32, recurse: bool) -> bool {
        let Some(item) = self.live.iter().find(|item| item.id == id) else {
            return false;
        };
        let mut owner = item.owner_container;
        for _ in 0..=self.containers.len() {
            if owner == container {
                return true;
            }
            if !recurse {
                return false;
            }
            let Some(parent) = self.parent_container(owner) else {
                return false;
            };
            owner = parent;
        }
        false
    }

    fn contents_weight(&self, container: u32) -> f32 {
        // ponytail: bounded 4096-row ordered scans; index only if profiling demands it.
        self.live
            .iter()
            .filter(|item| item.owner_container == container)
            .fold(0.0_f32, |sum, item| sum + self.unequipped_weight(item))
    }

    fn item_contents_weight(&self, item: &Item) -> f32 {
        if item.internal_container == 0 {
            0.0
        } else {
            self.contents_weight(item.internal_container)
        }
    }

    fn unequipped_weight(&self, item: &Item) -> f32 {
        item.actual_weight + self.item_contents_weight(item)
    }

    fn equipped_weight(&self, item: &Item) -> f32 {
        let contents = self.item_contents_weight(item);
        if item.internal_container != 0 {
            let reduction = self.container(item.internal_container).unwrap().reduction;
            let multiplier = if reduction > 0 {
                1.0 - reduction as f32 / 100.0
            } else {
                1.0
            };
            item.actual_weight * self.equipped_multiplier + contents * multiplier
        } else {
            (item.actual_weight + contents) * self.equipped_multiplier
        }
    }

    fn container_capacity_weight(&self, id: u32) -> f32 {
        if id != PLAYER_INVENTORY {
            return self.contents_weight(id);
        }
        self.live
            .iter()
            .filter(|item| item.owner_container == id)
            .fold(0.0_f32, |sum, item| {
                let flags = self.definitions[item.definition as usize].graph_flags;
                sum + if item.slot != 0 || self.held.contains(&item.id) || flags & 2 != 0 {
                    self.equipped_weight(item)
                } else {
                    self.unequipped_weight(item)
                }
            })
    }

    fn source_capacity(row: &Container) -> i32 {
        row.capacity.min(if row.kind == 3 { 50 } else { 100 })
    }

    fn effective_capacity(&self, row: &Container, actor: u32) -> i32 {
        let capacity = Self::source_capacity(row);
        if actor == 0 || row.parent_kind == 1 || row.type_token == 2 {
            return capacity;
        }
        if self.organized {
            (capacity as f32 * 1.3).max(capacity.wrapping_add(1) as f32) as i32
        } else if self.disorganized {
            (capacity as f32 * 0.7).max(1.0) as i32
        } else {
            capacity
        }
    }

    fn direct_world_item(&self, row: &Container) -> Option<&Item> {
        self.live
            .iter()
            .find(|item| item.id == row.containing_item && item.world_object)
    }

    fn item_allowed(&self, container: u32, item: &Item, policy: i32) -> Result<bool, i32> {
        let row = self.container(container).ok_or(OUT_OF_RANGE)?;
        let definition = self.definitions[item.definition as usize];
        if definition.graph_flags & 4 != 0 {
            return Err(UNSUPPORTED);
        }
        if self.inside(container, item.id) {
            return Ok(false);
        }
        if row.only_category != 0 && row.only_category != definition.category {
            return Ok(false);
        }
        if row.accept_function != 0 {
            if policy < 0 {
                return Err(UNSUPPORTED);
            }
            if policy != 1 {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn has_room_weight(
        &self,
        container: u32,
        actor: u32,
        weight: f32,
        floor_delta: f32,
    ) -> Result<bool, i32> {
        if actor > 1 {
            return Err(UNSUPPORTED);
        }
        let row = self.container(container).ok_or(OUT_OF_RANGE)?;
        if row.kind == 3 {
            let max_size = self.definitions[row.definition as usize].max_item_size;
            if max_size > 0.0 && weight > max_size {
                return Ok(false);
            }
        }
        if actor != 0
            && self.outermost(container) != Some(PLAYER_INVENTORY)
            && let Some(world) = self.direct_world_item(row)
        {
            let floor = world.owner_container;
            if self.contents_weight(floor) + floor_delta > 50.0 {
                return Ok(false);
            }
        }
        Ok(
            floating_point_correction(self.container_capacity_weight(container)) + weight
                <= self.effective_capacity(row, actor) as f32,
        )
    }

    fn has_room_item(
        &self,
        container: u32,
        actor: u32,
        item: &Item,
        policy: i32,
    ) -> Result<bool, i32> {
        if !self.item_allowed(container, item, policy)? {
            return Ok(false);
        }
        let row = self.container(container).unwrap();
        let weight = self.unequipped_weight(item);
        if row.containing_item != 0
            && self.held.contains(&row.containing_item)
            && item.owner_container != PLAYER_INVENTORY
        {
            if actor == 0 || floating_point_correction(self.capacity_weight()) + weight > 50.0 {
                return Ok(false);
            }
            return self.has_room_weight(container, actor, weight, weight);
        }
        let mut delta = weight;
        if let Some(world) = self.direct_world_item(row)
            && self.outermost(item.owner_container) == Some(world.owner_container)
        {
            delta = 0.0;
        }
        self.has_room_weight(container, actor, weight, delta)
    }

    fn floor(&mut self, xyz: (i32, i32, i32)) -> Result<u32, i32> {
        if xyz.2 != 0 {
            return Err(UNSUPPORTED);
        }
        if !item_position_valid(xyz.0 as f64, xyz.1 as f64) {
            return Err(OUT_OF_RANGE);
        }
        if let Some(row) = self
            .containers
            .iter()
            .find(|row| row.kind == 2 && row.xyz == xyz)
        {
            return Ok(row.id);
        }
        if self.next_container > u32::MAX as u64 || self.containers.len() == MAX_CONTAINERS {
            return Err(OUT_OF_RANGE);
        }
        let id = self.next_container as u32;
        self.next_container += 1;
        self.containers.push(Container {
            id,
            kind: 2,
            parent_kind: 2,
            parent_id: 0,
            containing_item: 0,
            capacity: 50,
            reduction: 0,
            xyz,
            flags: 0,
            definition: 0,
            type_token: 2,
            only_category: 0,
            accept_function: 0,
        });
        Ok(id)
    }

    fn valid_graph(&self, rows: &[Item], containers: &[Container], next: u64) -> bool {
        if next < 2
            || next > u32::MAX as u64 + 1
            || containers.len() > MAX_CONTAINERS
            || containers.iter().filter(|row| row.kind == 1).count() != 1
        {
            return false;
        }
        for (index, row) in containers.iter().enumerate() {
            if row.id == 0
                || row.id as u64 >= next
                || containers[..index].iter().any(|old| old.id == row.id)
                || !(0..=100).contains(&row.reduction)
                || row.flags & !3 != 0
            {
                return false;
            }
            match row.kind {
                1 => {
                    if row.id != PLAYER_INVENTORY
                        || row.parent_kind != 1
                        || row.parent_id != 1
                        || row.containing_item != 0
                        || row.capacity != 50
                    {
                        return false;
                    }
                }
                2 => {
                    if row.parent_kind != 2
                        || row.parent_id != 0
                        || row.containing_item != 0
                        || row.xyz.2 != 0
                        || row.capacity != 50
                        || !item_position_valid(row.xyz.0 as f64, row.xyz.1 as f64)
                        || containers[..index]
                            .iter()
                            .any(|old| old.kind == 2 && old.xyz == row.xyz)
                    {
                        return false;
                    }
                }
                3 => {
                    if row.parent_kind != 0 || row.parent_id != 0 {
                        return false;
                    }
                    let Some(shell) = rows.iter().find(|item| item.id == row.containing_item)
                    else {
                        return false;
                    };
                    if shell.internal_container != row.id
                        || shell.definition != row.definition
                        || self
                            .definitions
                            .get(row.definition as usize)
                            .is_none_or(|def| !def.bag)
                    {
                        return false;
                    }
                }
                _ => return false,
            }
        }
        for (index, item) in rows.iter().enumerate() {
            if !self.valid(item) || rows[..index].iter().any(|old| old.id == item.id) {
                return false;
            }
            let Some(owner) = containers.iter().find(|row| row.id == item.owner_container) else {
                return false;
            };
            if item.world_object != (owner.kind == 2)
                || (item.world_object
                    && owner.xyz != (item.x.floor() as i32, item.y.floor() as i32, 0))
                || (self.definitions[item.definition as usize].bag
                    != (item.internal_container != 0))
                || (item.internal_container != 0
                    && !containers.iter().any(|row| {
                        row.id == item.internal_container
                            && row.kind == 3
                            && row.containing_item == item.id
                    }))
            {
                return false;
            }
            let mut cursor = item.owner_container;
            let mut root = false;
            for _ in 0..containers.len() {
                let Some(row) = containers.iter().find(|row| row.id == cursor) else {
                    return false;
                };
                if row.kind != 3 {
                    root = true;
                    break;
                }
                let Some(shell) = rows.iter().find(|shell| shell.id == row.containing_item) else {
                    return false;
                };
                if shell.id == item.id {
                    return false;
                }
                cursor = shell.owner_container;
            }
            if !root {
                return false;
            }
        }
        true
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn player_inventory_id() -> u32 {
    PLAYER_INVENTORY
}
#[unsafe(no_mangle)]
pub extern "C" fn container_count() -> u32 {
    ITEMS.with(|state| state.borrow().containers.len() as u32)
}
#[unsafe(no_mangle)]
pub extern "C" fn container_next_id() -> f64 {
    ITEMS.with(|state| state.borrow().next_container as f64)
}
#[unsafe(no_mangle)]
pub extern "C" fn container_config_read() {
    ITEMS.with(|state| {
        let state = state.borrow();
        SCRATCH.with(|scratch| {
            scratch.borrow_mut()[..4].copy_from_slice(&[
                u32::from(state.organized) as f64,
                u32::from(state.disorganized) as f64,
                state.equipped_multiplier as f64,
                u32::from(state.drop_items_center) as f64,
            ])
        });
    });
}

fn write_container(row: &Container) {
    SCRATCH.with(|scratch| {
        scratch.borrow_mut()[..12].copy_from_slice(&[
            row.id as f64,
            row.kind as f64,
            row.parent_kind as f64,
            row.parent_id as f64,
            row.containing_item as f64,
            row.capacity as f64,
            row.reduction as f64,
            row.xyz.0 as f64,
            row.xyz.1 as f64,
            row.xyz.2 as f64,
            row.flags as f64,
            row.definition as f64,
        ])
    });
}
#[unsafe(no_mangle)]
pub extern "C" fn container_read(index: u32) -> i32 {
    ITEMS.with(|state| {
        let state = state.borrow();
        let Some(row) = state.containers.get(index as usize) else {
            return OUT_OF_RANGE;
        };
        write_container(row);
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn container_read_id(id: u32) -> i32 {
    ITEMS.with(|state| {
        let state = state.borrow();
        let Some(row) = state.container(id) else {
            return OUT_OF_RANGE;
        };
        write_container(row);
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn container_policy_read(id: u32) -> i32 {
    ITEMS.with(|state| {
        let state = state.borrow();
        let Some(row) = state.container(id) else {
            return OUT_OF_RANGE;
        };
        SCRATCH.with(|scratch| {
            scratch.borrow_mut()[..3].copy_from_slice(&[
                row.type_token as f64,
                row.only_category as f64,
                row.accept_function as f64,
            ])
        });
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn container_flags_set(id: u32, field: u32, value: u32) -> i32 {
    ITEMS.with(|state| {
        let mut state = state.borrow_mut();
        if field > 1 || value > 1 || state.importing || state.transaction_owner != 0 {
            return OUT_OF_RANGE;
        }
        let Some(row) = state.containers.iter_mut().find(|row| row.id == id) else {
            return OUT_OF_RANGE;
        };
        row.flags = (row.flags & !(1 << field)) | (value << field);
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn source_floor_container(x: i32, y: i32, z: i32) -> f64 {
    ITEMS.with(|state| {
        let mut state = state.borrow_mut();
        if state.importing || state.transaction_owner != 0 {
            return OUT_OF_RANGE as f64;
        }
        state
            .floor((x, y, z))
            .map_or_else(|code| code as f64, |id| id as f64)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn container_item_count(id: u32) -> i32 {
    ITEMS.with(|state| {
        let state = state.borrow();
        if state.container(id).is_none() {
            return OUT_OF_RANGE;
        }
        state
            .live
            .iter()
            .filter(|item| item.owner_container == id)
            .count() as i32
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn container_item_get(id: u32, index: u32) -> f64 {
    ITEMS.with(|state| {
        state
            .borrow()
            .live
            .iter()
            .filter(|item| item.owner_container == id)
            .nth(index as usize)
            .map_or(OUT_OF_RANGE as f64, |item| item.id as f64)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn container_contains(id: u32, item: u32, recurse: u32) -> i32 {
    ITEMS.with(|state| {
        let state = state.borrow();
        if recurse > 1 || state.container(id).is_none() {
            return OUT_OF_RANGE;
        }
        i32::from(state.contains(id, item, recurse != 0))
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn container_is_inside(id: u32, item: u32) -> i32 {
    ITEMS.with(|state| {
        let state = state.borrow();
        if state.container(id).is_none() {
            return OUT_OF_RANGE;
        }
        i32::from(state.inside(id, item))
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn container_outermost(id: u32) -> f64 {
    ITEMS.with(|state| {
        state
            .borrow()
            .outermost(id)
            .map_or(OUT_OF_RANGE as f64, |id| id as f64)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn item_outermost_container(id: u32) -> f64 {
    ITEMS.with(|state| {
        let state = state.borrow();
        let Some(item) = state.live.iter().find(|item| item.id == id) else {
            return OUT_OF_RANGE as f64;
        };
        let mut owner = item.owner_container;
        if owner == 0
            || state
                .container(owner)
                .is_some_and(|row| row.type_token == 2)
        {
            return 0.0;
        }
        for _ in 0..=state.containers.len() {
            match state.parent_container(owner) {
                Some(parent) if parent != 0 => {
                    if state
                        .container(parent)
                        .is_some_and(|row| row.type_token == 2)
                    {
                        return owner as f64;
                    }
                    owner = parent;
                }
                _ => return owner as f64,
            }
        }
        OUT_OF_RANGE as f64
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn container_actor_owner(id: u32) -> u32 {
    ITEMS.with(|state| u32::from(state.borrow().outermost(id) == Some(PLAYER_INVENTORY)))
}
#[unsafe(no_mangle)]
pub extern "C" fn source_floating_point_correction(weight: f64) -> f64 {
    if weight.is_nan() {
        return f64::NAN;
    }
    floating_point_correction(weight as f32) as f64
}
#[unsafe(no_mangle)]
pub extern "C" fn container_state_read(id: u32, actor: u32) -> i32 {
    ITEMS.with(|state| {
        let state = state.borrow();
        if actor > 1 {
            return UNSUPPORTED;
        }
        let Some(row) = state.container(id) else {
            return OUT_OF_RANGE;
        };
        let max = if row.kind == 1 {
            MOODLES.with(|m| m.borrow().inputs[MOODLE_MAX_WEIGHT] as i32 as f64)
        } else {
            Items::source_capacity(row) as f64
        };
        SCRATCH.with(|scratch| {
            scratch.borrow_mut()[..5].copy_from_slice(&[
                Items::source_capacity(row) as f64,
                state.effective_capacity(row, actor) as f64,
                state.contents_weight(id) as f64,
                state.container_capacity_weight(id) as f64,
                max,
            ])
        });
        OK
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn item_container_capacity(id: u32, actor: u32, effective: u32) -> i32 {
    if actor > 1 {
        return UNSUPPORTED;
    }
    if effective > 1 {
        return OUT_OF_RANGE;
    }
    ITEMS.with(|state| {
        let state = state.borrow();
        let Some(item) = state.live.iter().find(|item| item.id == id) else {
            return OUT_OF_RANGE;
        };
        let Some(container) = state.container(item.internal_container) else {
            return OUT_OF_RANGE;
        };
        let capacity = if effective == 1 {
            state.effective_capacity(container, actor)
        } else {
            Items::source_capacity(container)
        };
        let capacity = capacity.min((50.0_f32 - item.actual_weight) as i32);
        SCRATCH.with(|scratch| scratch.borrow_mut()[0] = capacity as f64);
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn item_weights_read(id: u32) -> i32 {
    ITEMS.with(|state| {
        let state = state.borrow();
        let Some(item) = state.live.iter().find(|item| item.id == id) else {
            return OUT_OF_RANGE;
        };
        let definition = state.definitions[item.definition as usize];
        if definition.graph_flags & 4 != 0 {
            return UNSUPPORTED;
        }
        let unequipped = state.unequipped_weight(item);
        let wrapper = state.container(item.internal_container).map_or(0, |row| {
            state
                .effective_capacity(row, 1)
                .min((50.0 - item.actual_weight) as i32)
        });
        SCRATCH.with(|scratch| {
            scratch.borrow_mut()[..6].copy_from_slice(&[
                item.actual_weight as f64,
                state.item_contents_weight(item) as f64,
                unequipped as f64,
                state.equipped_weight(item) as f64,
                (unequipped
                    * if definition.graph_flags & 1 != 0 {
                        state.equipped_multiplier
                    } else {
                        0.7
                    }) as f64,
                wrapper as f64,
            ])
        });
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn item_inventory_weight_read(id: u32) -> i32 {
    ITEMS.with(|state| {
        let state = state.borrow();
        let Some(item) = state.live.iter().find(|item| item.id == id) else {
            return OUT_OF_RANGE;
        };
        if item.internal_container == 0 {
            return UNSUPPORTED;
        }
        let flags = state.definitions[item.definition as usize].graph_flags;
        let equipped = item.owner_container == PLAYER_INVENTORY
            && (item.slot != 0 || state.held.contains(&item.id) || flags & 2 != 0);
        let mut weight = 0.0_f32;
        for child in state
            .live
            .iter()
            .filter(|child| child.owner_container == item.internal_container)
        {
            if state.definitions[child.definition as usize].graph_flags & 4 != 0 {
                return UNSUPPORTED;
            }
            weight += if equipped {
                state.equipped_weight(child)
            } else {
                state.unequipped_weight(child)
            };
        }
        SCRATCH.with(|scratch| scratch.borrow_mut()[0] = weight as f64);
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn container_item_allowed(id: u32, item: u32, policy: i32) -> i32 {
    ITEMS.with(|state| {
        let state = state.borrow();
        let Some(item) = state.live.iter().find(|row| row.id == item) else {
            return OUT_OF_RANGE;
        };
        state
            .item_allowed(id, item, policy)
            .map_or_else(|code| code, i32::from)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn container_has_room_item(id: u32, actor: u32, item: u32, policy: i32) -> i32 {
    ITEMS.with(|state| {
        let state = state.borrow();
        let Some(item) = state.live.iter().find(|row| row.id == item) else {
            return OUT_OF_RANGE;
        };
        state
            .has_room_item(id, actor, item, policy)
            .map_or_else(|code| code, i32::from)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn container_has_room_weight(id: u32, actor: u32, weight: f64, delta: f64) -> i32 {
    if !weight.is_finite() || !delta.is_finite() {
        return NONFINITE;
    }
    if weight.abs() > F32_MAX || delta.abs() > F32_MAX {
        return OUT_OF_RANGE;
    }
    let (weight, delta) = (weight as f32, delta as f32);
    ITEMS.with(|state| {
        state
            .borrow()
            .has_room_weight(id, actor, weight, delta)
            .map_or_else(|code| code, i32::from)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn container_remove_allowed(id: u32, item: u32) -> i32 {
    ITEMS.with(|state| {
        let state = state.borrow();
        if state.container(id).is_none() {
            return OUT_OF_RANGE;
        }
        let Some(item) = state.live.iter().find(|row| row.id == item) else {
            return OUT_OF_RANGE;
        };
        if state.definitions[item.definition as usize].graph_flags & 4 != 0 {
            return UNSUPPORTED;
        }
        1
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn item_definition_container_set(
    id: u32,
    owner: u32,
    bag: u32,
    capacity: i32,
    reduction: i32,
    max_size: f64,
    type_token: u32,
    category: u32,
    only_category: u32,
    accept_function: u32,
    flags: u32,
) -> i32 {
    if !max_size.is_finite() {
        return NONFINITE;
    }
    if max_size.abs() > F32_MAX || bag > 1 || flags & !7 != 0 {
        return OUT_OF_RANGE;
    }
    ITEMS.with(|state| {
        let mut state = state.borrow_mut();
        let index = id as usize;
        if owner == 0
            || state.frozen
            || state.importing
            || state.source_transfer
            || (state.transaction_owner != 0 && state.transaction_owner != owner)
            || state
                .definitions
                .get(index)
                .is_none_or(|row| row.owner != owner)
            || state.live.iter().any(|item| {
                item.definition == id
                    && (state.definitions[index].bag != (bag == 1) || flags & 4 != 0)
            })
        {
            return OUT_OF_RANGE;
        }
        if state.transaction_owner != 0
            && index < state.transaction_start
            && !state.journal.iter().any(|(old, _)| *old == index)
        {
            let row = state.definitions[index];
            state.journal.push((index, row));
        }
        let row = &mut state.definitions[index];
        row.bag = bag == 1;
        row.capacity = capacity;
        row.reduction = reduction.clamp(0, 100);
        row.max_item_size = max_size as f32;
        row.type_token = type_token;
        row.category = category;
        row.only_category = only_category;
        row.accept_function = accept_function;
        row.graph_flags = flags;
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn item_definition_container_read(id: u32) -> i32 {
    ITEMS.with(|state| {
        let state = state.borrow();
        let Some(row) = state.definitions.get(id as usize) else {
            return OUT_OF_RANGE;
        };
        SCRATCH.with(|scratch| {
            scratch.borrow_mut()[..9].copy_from_slice(&[
                u32::from(row.bag) as f64,
                row.capacity as f64,
                row.reduction as f64,
                row.max_item_size as f64,
                row.type_token as f64,
                row.category as f64,
                row.only_category as f64,
                row.accept_function as f64,
                row.graph_flags as f64,
            ])
        });
        OK
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn container_import_stage() -> i32 {
    let w = SCRATCH.with(|scratch| *scratch.borrow());
    for index in [0, 1, 2, 3, 4, 10, 11] {
        if !w[index].is_finite()
            || w[index].fract() != 0.0
            || !(0.0..=u32::MAX as f64).contains(&w[index])
        {
            item_import_abort();
            return BAD_FORMAT;
        }
    }
    for index in [5, 6, 7, 8, 9] {
        if !w[index].is_finite()
            || w[index].fract() != 0.0
            || !(i32::MIN as f64..=i32::MAX as f64).contains(&w[index])
        {
            item_import_abort();
            return BAD_FORMAT;
        }
    }
    if w[1] > 3.0 || w[2] > 2.0 || w[9] != 0.0 {
        item_import_abort();
        return UNSUPPORTED;
    }
    ITEMS.with(|state| {
        let mut state = state.borrow_mut();
        if !state.importing
            || state.staged_containers.len() == MAX_CONTAINERS
            || state
                .staged_containers
                .iter()
                .any(|row| row.id == w[0] as u32)
        {
            state.abort_import();
            return BAD_FORMAT;
        }
        state.staged_containers.push(Container {
            id: w[0] as u32,
            kind: w[1] as u32,
            parent_kind: w[2] as u32,
            parent_id: w[3] as u32,
            containing_item: w[4] as u32,
            capacity: w[5] as i32,
            reduction: w[6] as i32,
            xyz: (w[7] as i32, w[8] as i32, w[9] as i32),
            flags: w[10] as u32,
            definition: w[11] as u32,
            type_token: 0,
            only_category: 0,
            accept_function: 0,
        });
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn container_import_policy_stage(
    id: u32,
    token: u32,
    category: u32,
    function: u32,
) -> i32 {
    ITEMS.with(|state| {
        let mut state = state.borrow_mut();
        if !state.importing {
            return OUT_OF_RANGE;
        }
        let Some(index) = state.staged_containers.iter().position(|row| row.id == id) else {
            state.abort_import();
            return BAD_FORMAT;
        };
        let row = &mut state.staged_containers[index];
        row.type_token = token;
        row.only_category = category;
        row.accept_function = function;
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn container_import_allocator(
    next: f64,
    organized: u32,
    disorganized: u32,
    multiplier: f64,
    drop_center: u32,
) -> i32 {
    if !next.is_finite()
        || next.fract() != 0.0
        || !(2.0..=u32::MAX as f64 + 1.0).contains(&next)
        || organized > 1
        || disorganized > 1
        || drop_center > 1
        || !multiplier.is_finite()
        || !(0.0..=F32_MAX).contains(&multiplier)
    {
        item_import_abort();
        return BAD_FORMAT;
    }
    ITEMS.with(|state| {
        let mut state = state.borrow_mut();
        if !state.importing {
            return OUT_OF_RANGE;
        }
        state.staged_next_container = next as u64;
        state.staged_policy = (organized != 0, disorganized != 0, multiplier as f32);
        state.staged_drop_items_center = drop_center != 0;
        OK
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn container_trait_get(index: u32) -> i32 {
    ITEMS.with(|state| {
        let state = state.borrow();
        match index {
            0 => i32::from(state.organized),
            1 => i32::from(state.disorganized),
            _ => OUT_OF_RANGE,
        }
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn container_trait_set(index: u32, value: u32) -> i32 {
    ITEMS.with(|state| {
        let mut state = state.borrow_mut();
        if index > 1 || value > 1 || state.importing || state.transaction_owner != 0 {
            return OUT_OF_RANGE;
        }
        if index == 0 {
            state.organized = value != 0;
        } else {
            state.disorganized = value != 0;
        }
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn item_source_state_read(id: u32) -> i32 {
    ITEMS.with(|state| {
        let state = state.borrow();
        let flags = state
            .live
            .iter()
            .find(|item| item.id == id)
            .map(|item| item.source_flags)
            .or_else(|| {
                state
                    .retired_source_flags
                    .iter()
                    .find(|(old, _)| *old == id)
                    .map(|(_, flags)| *flags)
            });
        let Some(flags) = flags else {
            return OUT_OF_RANGE;
        };
        SCRATCH.with(|scratch| {
            scratch.borrow_mut()[..2]
                .copy_from_slice(&[(flags & 1) as f64, ((flags >> 1) & 1) as f64])
        });
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn item_source_state_set(id: u32, field: u32, value: u32) -> i32 {
    if field > 1 || value > 1 {
        return OUT_OF_RANGE;
    }
    change_item(id, |state, index| {
        state.live[index].source_flags =
            (state.live[index].source_flags & !(1 << field)) | (value << field);
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn item_import_source_state(id: u32, flags: u32) -> i32 {
    ITEMS.with(|state| {
        let mut state = state.borrow_mut();
        if !state.importing || flags & !3 != 0 {
            return BAD_FORMAT;
        }
        let Some(item) = state.staged.iter_mut().find(|item| item.id == id) else {
            return BAD_FORMAT;
        };
        item.source_flags = flags;
        OK
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn source_actor_overlay_get() -> u32 {
    ITEMS.with(|state| state.borrow().actor_overlay)
}
#[unsafe(no_mangle)]
pub extern "C" fn item_equipment_state_read(id: u32) -> i32 {
    ITEMS.with(|state| {
        let state = state.borrow();
        let Some(item) = state.live.iter().find(|item| item.id == id) else {
            return OUT_OF_RANGE;
        };
        SCRATCH.with(|scratch| {
            scratch.borrow_mut()[..3].copy_from_slice(&[
                u32::from(item.slot != 0) as f64,
                u32::from(state.held.contains(&id)) as f64,
                u32::from(state.attached.contains(&id)) as f64,
            ])
        });
        OK
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn source_actor_transfer_state_read() -> i32 {
    ITEMS.with(|state| {
        let state = state.borrow();
        SCRATCH.with(|scratch| {
            scratch.borrow_mut()[..4].copy_from_slice(&[
                u32::from(state.actor_turn_target != 0) as f64,
                u32::from(state.actor_furniture != 0) as f64,
                u32::from(state.actor_vehicle != 0) as f64,
                u32::from(state.drop_items_center) as f64,
            ])
        });
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn source_drop_items_center_set(value: u32) -> i32 {
    if value > 1 {
        return OUT_OF_RANGE;
    }
    ITEMS.with(|state| {
        let mut state = state.borrow_mut();
        if state.source_transfer || state.importing {
            return OUT_OF_RANGE;
        }
        state.drop_items_center = value != 0;
        OK
    })
}

struct AnimalZone {
    id: u32,
    x: i32,
    y: i32,
    z: i32,
    width: i32,
    height: i32,
}
thread_local! {
    // Original DesignationZoneAnimal static initialization/Reset establishes an empty registry.
    static ANIMAL_ZONES: RefCell<Vec<AnimalZone>> = const { RefCell::new(Vec::new()) };
}
#[unsafe(no_mangle)]
pub extern "C" fn source_animal_zone_count() -> u32 {
    ANIMAL_ZONES.with(|zones| zones.borrow().len() as u32)
}
#[unsafe(no_mangle)]
pub extern "C" fn source_animal_zone_for_square(x: i32, y: i32, z: i32) -> f64 {
    ANIMAL_ZONES.with(|zones| {
        zones
            .borrow()
            .iter()
            .find(|zone| {
                x >= zone.x
                    && x < zone.x.wrapping_add(zone.width)
                    && y >= zone.y
                    && y < zone.y.wrapping_add(zone.height)
                    && z == zone.z
            })
            .map_or(0.0, |zone| zone.id as f64)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn source_animal_zone_import(count: u32) -> i32 {
    if count != 0 {
        return UNSUPPORTED;
    }
    ANIMAL_ZONES.with(|zones| zones.borrow_mut().clear());
    OK
}

#[unsafe(no_mangle)]
pub extern "C" fn worn_group_get() -> u32 {
    ITEMS.with(|items| items.borrow().worn_group)
}

#[unsafe(no_mangle)]
pub extern "C" fn worn_group_set(group: u32) -> i32 {
    if !BODY_LOCATIONS.with(|registry| registry.borrow().group(group).is_some()) {
        return OUT_OF_RANGE;
    }
    ITEMS.with(|items| {
        let mut items = items.borrow_mut();
        if !items.worn.is_empty()
            || items.importing
            || items.source_transfer
            || items.transaction_owner != 0
        {
            return OUT_OF_RANGE;
        }
        items.worn_group = group;
        OK
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn worn_count() -> u32 {
    ITEMS.with(|items| items.borrow().worn.len() as u32)
}

/// Scratch: exact uint32 item ID and canonical body-location token, as f64.
#[unsafe(no_mangle)]
pub extern "C" fn worn_read(index: u32) -> i32 {
    ITEMS.with(|items| {
        let items = items.borrow();
        let Some(id) = items.worn.get(index as usize) else {
            return OUT_OF_RANGE;
        };
        let item = items.live.iter().find(|item| item.id == *id).unwrap();
        SCRATCH.with(|scratch| {
            scratch.borrow_mut()[..2].copy_from_slice(&[*id as f64, item.slot as f64])
        });
        OK
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn worn_item_get(location: u32) -> f64 {
    ITEMS.with(|items| {
        let items = items.borrow();
        items
            .worn
            .iter()
            .find(|id| {
                items
                    .live
                    .iter()
                    .any(|item| item.id == **id && item.slot == location)
            })
            .copied()
            .map(f64::from)
            .unwrap_or(0.0)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn worn_item_set(location: u32, id: u32) -> i32 {
    ITEMS.with(|items| items.borrow_mut().set_worn(location, id))
}

#[unsafe(no_mangle)]
pub extern "C" fn worn_remove(id: u32) -> i32 {
    ITEMS.with(|items| {
        let mut items = items.borrow_mut();
        if items.importing || items.source_transfer || items.transaction_owner != 0 {
            return OUT_OF_RANGE;
        }
        items.remove_worn(id);
        OK
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn worn_clear() -> i32 {
    ITEMS.with(|items| {
        let mut items = items.borrow_mut();
        if items.importing || items.source_transfer || items.transaction_owner != 0 {
            return OUT_OF_RANGE;
        }
        for item in &mut items.live {
            item.slot = 0;
        }
        items.worn.clear();
        OK
    })
}

/// Exact f64 IDs avoid signed i32 aliases at the JS/WASM boundary; zero is nil.
#[unsafe(no_mangle)]
pub extern "C" fn hand_item_get(slot: u32) -> f64 {
    ITEMS.with(|items| {
        items
            .borrow()
            .held
            .get(slot as usize)
            .copied()
            .map(f64::from)
            .unwrap_or(-1.0)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn hand_item_set(slot: u32, id: u32) -> i32 {
    ITEMS.with(|items| {
        let mut items = items.borrow_mut();
        if slot > 1
            || items.importing
            || items.source_transfer
            || items.transaction_owner != 0
            || !items.valid_held(id)
        {
            return OUT_OF_RANGE;
        }
        items.held[slot as usize] = id;
        OK
    })
}

/// Silent all-or-nothing restore, after definitions and complete live items.
#[unsafe(no_mangle)]
pub extern "C" fn hand_items_restore(primary: u32, secondary: u32) -> i32 {
    ITEMS.with(|items| {
        let mut items = items.borrow_mut();
        if items.importing
            || items.source_transfer
            || items.transaction_owner != 0
            || !items.valid_held(primary)
            || !items.valid_held(secondary)
        {
            return OUT_OF_RANGE;
        }
        items.held = [primary, secondary];
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn source_hands_slot_set(slot: u32) -> i32 {
    ITEMS.with(|items| {
        let mut items = items.borrow_mut();
        // The host forwards a native canonical identity token.
        items.hands_slot = slot;
        OK
    })
}

thread_local! {
    static ITEMS: RefCell<Items> = RefCell::new(Items::new());
}

fn item_position_valid(x: f64, y: f64) -> bool {
    if !x.is_finite() || !y.is_finite() {
        return false;
    }
    if world_extents().0 {
        // Membership alone: solid/walled tiles can hold dropped objects.
        let tile = tile_at(x.floor() as i64, y.floor() as i64);
        in_active_world(tile) && WORLD.with(|world| world.borrow().byte_at(tile).is_some())
    } else {
        in_world(x) && in_world(y)
    }
}

fn item_weight(value: f64) -> Result<f32, i32> {
    if !value.is_finite() {
        return Err(NONFINITE);
    }
    if !(0.0..=F32_MAX).contains(&value) {
        return Err(OUT_OF_RANGE);
    }
    Ok(value as f32)
}

fn floating_point_correction(weight: f32) -> f32 {
    let mut scaled = weight * 100.0;
    if scaled.fract() >= 0.5 {
        scaled += 1.0;
    }
    (scaled as i32) as f32 / 100.0
}

/// Scratch: source inventory capacityWeight, hard capacity, stored MaxWeight.
#[unsafe(no_mangle)]
pub extern "C" fn inventory_state_read() {
    let weight = ITEMS.with(|items| items.borrow().capacity_weight());
    let max_weight = MOODLES.with(|state| state.borrow().inputs[MOODLE_MAX_WEIGHT]);
    SCRATCH.with(|scratch| {
        scratch.borrow_mut()[..3].copy_from_slice(&[
            weight as f64,
            INVENTORY_CAPACITY as f64,
            max_weight,
        ]);
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn item_definition_count() -> u32 {
    ITEMS.with(|items| items.borrow().definitions.len() as u32)
}

/// Dense ordinal registration; numeric rows and their owner live only in WASM.
#[unsafe(no_mangle)]
pub extern "C" fn item_definition_register(
    id: u32,
    owner: u32,
    condition_max: i32,
    slot: u32,
    stack_limit: u32,
    remove_on_broken: u32,
    chance: u32,
    override_existing: u32,
    weight: f64,
    awkward_gloves: u32,
) -> i32 {
    let weight = match item_weight(weight) {
        Ok(weight) => weight,
        Err(code) => return code,
    };
    if slot != 0 && !BODY_LOCATIONS.with(|registry| registry.borrow().identity_valid(slot)) {
        return OUT_OF_RANGE;
    }
    ITEMS.with(|items| {
        let mut items = items.borrow_mut();
        let index = id as usize;
        if items.frozen
            || owner == 0
            || condition_max <= 0
            || stack_limit == 0
            || remove_on_broken > 1
            || override_existing > 1
            || awkward_gloves > 1
            || (items.transaction_owner != 0 && items.transaction_owner != owner)
            || index > items.definitions.len()
            || (index == items.definitions.len() && index >= MAX_DEFS)
            || (index < items.definitions.len() && override_existing == 0)
            || items.live.iter().any(|item| {
                item.definition == id
                    && (item.condition > condition_max || item.count > stack_limit)
            })
        {
            return OUT_OF_RANGE;
        }
        let old = items.definitions.get(index);
        let row = ItemDefinition {
            owner,
            condition_max,
            slot,
            stack_limit,
            remove_on_broken: remove_on_broken != 0,
            condition_lower_chance_one_in: chance,
            weight,
            awkward_gloves: awkward_gloves != 0,
            can_equip: 0,
            bag: old.is_some_and(|row| row.bag),
            capacity: old.map_or(0, |row| row.capacity),
            reduction: old.map_or(0, |row| row.reduction),
            max_item_size: old.map_or(0.0, |row| row.max_item_size),
            type_token: old.map_or(0, |row| row.type_token),
            category: old.map_or(0, |row| row.category),
            only_category: old.map_or(0, |row| row.only_category),
            accept_function: old.map_or(0, |row| row.accept_function),
            graph_flags: old.map_or(0, |row| row.graph_flags),
        };
        if index == items.definitions.len() {
            items.definitions.push(row);
        } else {
            if items.transaction_owner != 0
                && index < items.transaction_start
                && !items
                    .journal
                    .iter()
                    .any(|(old_index, _)| *old_index == index)
            {
                let old = items.definitions[index];
                items.journal.push((index, old));
            }
            items.definitions[index] = row;
        }
        OK
    })
}

/// Scratch: owner, conditionMax, slot, stackLimit, removeOnBroken, chance, weight, awkwardGloves, canBeEquipped.
#[unsafe(no_mangle)]
pub extern "C" fn item_definition_read(id: u32) -> i32 {
    ITEMS.with(|items| {
        let items = items.borrow();
        let Some(row) = items.definitions.get(id as usize) else {
            return OUT_OF_RANGE;
        };
        SCRATCH.with(|scratch| {
            let mut scratch = scratch.borrow_mut();
            scratch[..9].copy_from_slice(&[
                row.owner as f64,
                row.condition_max as f64,
                row.slot as f64,
                row.stack_limit as f64,
                u32::from(row.remove_on_broken) as f64,
                row.condition_lower_chance_one_in as f64,
                row.weight as f64,
                u32::from(row.awkward_gloves) as f64,
                row.can_equip as f64,
            ]);
        });
        OK
    })
}

/// Separate preferred non-clothing equip location; definition registration arity stays unchanged.
#[unsafe(no_mangle)]
pub extern "C" fn item_definition_equip_set(id: u32, owner: u32, location: u32) -> i32 {
    if location != 0 && !BODY_LOCATIONS.with(|registry| registry.borrow().identity_valid(location))
    {
        return OUT_OF_RANGE;
    }
    ITEMS.with(|items| {
        let mut items = items.borrow_mut();
        let index = id as usize;
        if owner == 0
            || items.frozen
            || items.importing
            || items.source_transfer
            || (items.transaction_owner != 0 && items.transaction_owner != owner)
            || items
                .definitions
                .get(index)
                .is_none_or(|row| row.owner != owner)
        {
            return OUT_OF_RANGE;
        }
        if items.transaction_owner != 0
            && index < items.transaction_start
            && !items
                .journal
                .iter()
                .any(|(old_index, _)| *old_index == index)
        {
            let row = items.definitions[index];
            items.journal.push((index, row));
        }
        items.definitions[index].can_equip = location;
        OK
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn item_definition_begin(owner: u32) -> i32 {
    ITEMS.with(|items| {
        let mut items = items.borrow_mut();
        if owner == 0
            || items.frozen
            || items.transaction_owner != 0
            || items.importing
            || items.source_transfer
        {
            return OUT_OF_RANGE;
        }
        items.transaction_owner = owner;
        items.transaction_start = items.definitions.len();
        items.transaction_hands_slot = items.hands_slot;
        items.journal.clear();
        OK
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn item_definition_commit(owner: u32) -> i32 {
    ITEMS.with(|items| {
        let mut items = items.borrow_mut();
        if owner == 0 || items.transaction_owner != owner {
            return OUT_OF_RANGE;
        }
        items.transaction_owner = 0;
        items.journal.clear();
        OK
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn item_definition_rollback(owner: u32) -> i32 {
    ITEMS.with(|items| {
        let mut items = items.borrow_mut();
        if owner == 0 || items.transaction_owner != owner {
            return OUT_OF_RANGE;
        }
        while let Some((index, row)) = items.journal.pop() {
            items.definitions[index] = row;
        }
        let start = items.transaction_start;
        items.definitions.truncate(start);
        items.transaction_owner = 0;
        items.hands_slot = items.transaction_hands_slot;
        actions::invalidate();
        OK
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn item_definition_freeze() -> i32 {
    ITEMS.with(|items| {
        let mut items = items.borrow_mut();
        if items.transaction_owner != 0 {
            return OUT_OF_RANGE;
        }
        items.frozen = true;
        OK
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn item_count() -> u32 {
    ITEMS.with(|items| items.borrow().live.len() as u32)
}

/// Scratch: id, definition, owner, x, y, condition, count, slot, weight, actualWeight, internalContainer, worldObject.
fn write_item(item: &Item) {
    SCRATCH.with(|scratch| {
        scratch.borrow_mut()[..12].copy_from_slice(&[
            item.id as f64,
            item.definition as f64,
            item.owner_container as f64,
            item.x,
            item.y,
            item.condition as f64,
            item.count as f64,
            item.slot as f64,
            item.weight as f64,
            item.actual_weight as f64,
            item.internal_container as f64,
            u32::from(item.world_object) as f64,
        ]);
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn item_read(index: u32) -> i32 {
    ITEMS.with(|items| {
        let items = items.borrow();
        let Some(item) = items.live.get(index as usize) else {
            return OUT_OF_RANGE;
        };
        write_item(item);
        OK
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn item_read_id(id: u32) -> i32 {
    ITEMS.with(|items| {
        let items = items.borrow();
        let Some(item) = items.live.iter().find(|item| item.id == id) else {
            return OUT_OF_RANGE;
        };
        write_item(item);
        OK
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn source_world_item_count(x: i32, y: i32, z: i32) -> u32 {
    ITEMS.with(|items| {
        items
            .borrow()
            .live
            .iter()
            .filter(|item| {
                z == 0
                    && item.world_object
                    && item.x.floor() == x as f64
                    && item.y.floor() == y as f64
            })
            .count() as u32
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn source_world_item_get(x: i32, y: i32, z: i32, index: u32) -> f64 {
    ITEMS.with(|items| {
        items
            .borrow()
            .live
            .iter()
            .filter(|item| {
                z == 0
                    && item.world_object
                    && item.x.floor() == x as f64
                    && item.y.floor() == y as f64
            })
            .nth(index as usize)
            .map_or(OUT_OF_RANGE as f64, |item| item.id as f64)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn item_last_id() -> u32 {
    ITEMS.with(|items| items.borrow().last_id)
}

#[unsafe(no_mangle)]
pub extern "C" fn item_spawn(definition: u32, x: f64, y: f64, count: u32, condition: i32) -> i32 {
    if !x.is_finite() || !y.is_finite() {
        return NONFINITE;
    }
    if !item_position_valid(x, y) {
        return OUT_OF_RANGE;
    }
    let next = ENGINE.with(|engine| engine.borrow().next_item_id);
    ITEMS.with(|items| {
        let mut items = items.borrow_mut();
        let Some(row) = items.definitions.get(definition as usize).copied() else {
            return OUT_OF_RANGE;
        };
        if next > u32::MAX as u64
            || items.live.len() >= MAX_ITEMS
            || items.transaction_owner != 0
            || items.importing
            || items.source_transfer
            || condition < 0
            || condition > row.condition_max
            || count == 0
            || count > row.stack_limit
            || items.containers.len() + 2 > MAX_CONTAINERS
            || items.next_container + u64::from(row.bag) > u32::MAX as u64
        {
            return OUT_OF_RANGE;
        }
        if row.graph_flags & 4 != 0 {
            return UNSUPPORTED;
        }
        let floor = match items.floor((x.floor() as i32, y.floor() as i32, 0)) {
            Ok(id) => id,
            Err(code) => return code,
        };
        let internal = if row.bag {
            let id = items.next_container as u32;
            items.next_container += 1;
            items.containers.push(Container {
                id,
                kind: 3,
                parent_kind: 0,
                parent_id: 0,
                containing_item: next as u32,
                capacity: row.capacity,
                reduction: row.reduction,
                xyz: (0, 0, 0),
                flags: 0,
                definition,
                type_token: row.type_token,
                only_category: row.only_category,
                accept_function: row.accept_function,
            });
            id
        } else {
            0
        };
        let item = Item {
            id: next as u32,
            definition,
            owner_container: floor,
            internal_container: internal,
            world_object: true,
            x,
            y,
            condition,
            count,
            slot: 0,
            weight: row.weight,
            actual_weight: row.weight,
            source_flags: 0,
        };
        items.live.push(item);
        items.last_id = item.id;
        mutate(|engine| engine.next_item_id += 1);
        OK
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn item_pickup(id: u32) -> i32 {
    actions::queue_request_pickup(id)
}

fn change_item(id: u32, change: impl FnOnce(&mut Items, usize) -> i32) -> i32 {
    ITEMS.with(|items| {
        let mut items = items.borrow_mut();
        if items.importing || items.source_transfer || items.transaction_owner != 0 {
            return OUT_OF_RANGE;
        }
        let Some(index) = items.live.iter().position(|item| item.id == id) else {
            return OUT_OF_RANGE;
        };
        change(&mut items, index)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn item_wear(id: u32) -> i32 {
    change_item(id, |items, index| {
        let definition = items.definitions[items.live[index].definition as usize];
        let slot = if definition.slot != 0 {
            definition.slot
        } else {
            definition.can_equip
        };
        items.set_worn(slot, id)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn item_wearing_awkward_gloves(hands_slot: u32) -> u32 {
    if hands_slot == 0 {
        return 0;
    }
    ITEMS.with(|items| {
        let items = items.borrow();
        u32::from(
            items
                .worn
                .iter()
                .find_map(|id| {
                    items
                        .live
                        .iter()
                        .find(|item| item.id == *id && item.slot == hands_slot)
                })
                .is_some_and(|item| items.definitions[item.definition as usize].awkward_gloves),
        )
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn item_unequip(id: u32) -> i32 {
    change_item(id, |items, index| {
        if items.live[index].slot == 0 {
            return OUT_OF_RANGE;
        }
        items.remove_worn(id);
        OK
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn item_drop(id: u32, x: f64, y: f64) -> i32 {
    if !x.is_finite() || !y.is_finite() {
        return NONFINITE;
    }
    if !item_position_valid(x, y) {
        return OUT_OF_RANGE;
    }
    change_item(id, |items, index| {
        if items.live[index].owner_container != PLAYER_INVENTORY {
            return OUT_OF_RANGE;
        }
        let floor = match items.floor((x.floor() as i32, y.floor() as i32, 0)) {
            Ok(id) => id,
            Err(code) => return code,
        };
        let item = &mut items.live[index];
        item.owner_container = floor;
        item.world_object = true;
        item.slot = 0;
        item.x = x;
        item.y = y;
        items.clear_held(id);
        items.remove_worn(id);
        OK
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn item_set_condition(id: u32, condition: i32) -> i32 {
    change_item(id, |items, index| {
        let definition = items.definitions[items.live[index].definition as usize];
        if condition < 0 || condition > definition.condition_max {
            return OUT_OF_RANGE;
        }
        if condition == 0 && definition.remove_on_broken {
            if items.live[index].internal_container != 0 {
                return UNSUPPORTED;
            }
            items
                .retired_source_flags
                .retain(|(old, _)| actions::source_flags_needed(*old));
            if actions::source_flags_needed(id) {
                if items.retired_source_flags.len() == MAX_ITEMS * 3 {
                    return OUT_OF_RANGE;
                }
                let flags = items.live[index].source_flags;
                items.retired_source_flags.push((id, flags));
            }
            items.live.remove(index);
            items.clear_held(id);
            items.remove_worn(id);
        } else {
            items.live[index].condition = condition;
        }
        OK
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn item_set_weight(id: u32, weight: f64) -> i32 {
    let weight = match item_weight(weight) {
        Ok(weight) => weight,
        Err(code) => return code,
    };
    change_item(id, |items, index| {
        items.live[index].weight = weight;
        OK
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn item_set_actual_weight(id: u32, actual_weight: f64) -> i32 {
    let actual_weight = match item_weight(actual_weight) {
        Ok(weight) => weight,
        Err(code) => return code,
    };
    change_item(id, |items, index| {
        items.live[index].actual_weight = actual_weight;
        OK
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn item_import_begin() -> i32 {
    ITEMS.with(|items| {
        let mut items = items.borrow_mut();
        if items.importing || items.source_transfer || items.transaction_owner != 0 {
            return OUT_OF_RANGE;
        }
        items.staged.clear();
        items.staged_containers.clear();
        items.staged_next_container = items.next_container;
        items.staged_policy = (
            items.organized,
            items.disorganized,
            items.equipped_multiplier,
        );
        items.staged_drop_items_center = items.drop_items_center;
        items.staged_worn.clear();
        items.explicit_worn = false;
        items.importing = true;
        OK
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn item_import_abort() {
    ITEMS.with(|items| {
        let mut items = items.borrow_mut();
        items.staged.clear();
        items.staged_containers.clear();
        items.staged_worn.clear();
        items.explicit_worn = false;
        items.importing = false;
    });
}

#[unsafe(no_mangle)]
pub extern "C" fn item_import_stage(
    id: u32,
    definition: u32,
    owner_container: u32,
    x: f64,
    y: f64,
    condition: i32,
    count: u32,
    slot: u32,
    weight: f64,
    actual_weight: f64,
    internal_container: u32,
    world_object: u32,
) -> i32 {
    ITEMS.with(|items| {
        let mut items = items.borrow_mut();
        let (Ok(weight), Ok(actual_weight)) = (item_weight(weight), item_weight(actual_weight))
        else {
            items.staged.clear();
            items.staged_worn.clear();
            items.explicit_worn = false;
            items.importing = false;
            return BAD_FORMAT;
        };
        let item = Item {
            id,
            definition,
            owner_container,
            internal_container,
            world_object: world_object == 1,
            x,
            y,
            condition,
            count,
            slot,
            weight,
            actual_weight,
            source_flags: 0,
        };
        if items
            .definitions
            .get(definition as usize)
            .is_some_and(|row| row.graph_flags & 4 != 0)
        {
            items.abort_import();
            return UNSUPPORTED;
        }
        if !items.importing
            || items.staged.len() >= MAX_ITEMS
            || world_object > 1
            || !items.valid(&item)
            || items.staged.iter().any(|old| old.id == id)
        {
            items.abort_import();
            return BAD_FORMAT;
        }
        items.staged.push(item);
        OK
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn item_import_worn_begin() -> i32 {
    ITEMS.with(|items| {
        let mut items = items.borrow_mut();
        if !items.importing || items.explicit_worn {
            return OUT_OF_RANGE;
        }
        items.explicit_worn = true;
        items.staged_worn.clear();
        OK
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn item_import_worn_stage(id: u32) -> i32 {
    ITEMS.with(|items| {
        let mut items = items.borrow_mut();
        if !items.importing || !items.explicit_worn {
            return OUT_OF_RANGE;
        }
        if items.staged_worn.len() >= MAX_ITEMS
            || items.staged_worn.contains(&id)
            || !items
                .staged
                .iter()
                .any(|item| item.id == id && item.slot != 0)
        {
            items.staged.clear();
            items.staged_worn.clear();
            items.explicit_worn = false;
            items.importing = false;
            return BAD_FORMAT;
        }
        items.staged_worn.push(id);
        OK
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn item_import_commit() -> i32 {
    ITEMS.with(|items| {
        let mut items = items.borrow_mut();
        if !items.importing {
            return OUT_OF_RANGE;
        }
        if !items.valid_graph(
            &items.staged,
            &items.staged_containers,
            items.staged_next_container,
        ) {
            return BAD_FORMAT;
        }
        if !items.explicit_worn {
            items.staged_worn.clear();
            BODY_LOCATIONS.with(|registry| {
                let registry = registry.borrow();
                let group = registry.group(items.worn_group).unwrap();
                let Items {
                    staged,
                    staged_worn,
                    ..
                } = &mut *items;
                for member in &group.locations {
                    for item in staged.iter().filter(|item| item.slot == member.id) {
                        staged_worn.push(item.id);
                    }
                }
            });
        }
        if !items.valid_worn(&items.staged, &items.staged_worn) {
            return BAD_FORMAT;
        }
        let next = items
            .staged
            .iter()
            .map(|item| item.id as u64 + 1)
            .max()
            .unwrap_or(1);
        let Items {
            live,
            staged,
            worn,
            containers,
            staged_containers,
            staged_worn,
            ..
        } = &mut *items;
        std::mem::swap(live, staged);
        std::mem::swap(containers, staged_containers);
        std::mem::swap(worn, staged_worn);
        items.staged.clear();
        items.staged_containers.clear();
        items.next_container = items.staged_next_container;
        (
            items.organized,
            items.disorganized,
            items.equipped_multiplier,
        ) = items.staged_policy;
        items.drop_items_center = items.staged_drop_items_center;
        items.retired_source_flags.clear();
        items.attached.clear();
        items.staged_worn.clear();
        items.explicit_worn = false;
        items.importing = false;
        items.held = [0; 2];
        mutate(|engine| engine.next_item_id = engine.next_item_id.max(next));
        actions::invalidate();
        OK
    })
}

#[cfg(test)]
fn begin_actor_container_fixture() -> i32 {
    let status = item_import_begin();
    if status == OK {
        ITEMS.with(|items| {
            items
                .borrow_mut()
                .staged_containers
                .push(Container::actor())
        });
    }
    status
}

#[cfg(test)]
fn stage_floor_container_fixture(id: u32, x: i32, y: i32) {
    SCRATCH.with(|scratch| {
        *scratch.borrow_mut() = [
            id as f64, 2.0, 2.0, 0.0, 0.0, 50.0, 0.0, x as f64, y as f64, 0.0, 0.0, 0.0,
        ];
    });
    assert_eq!(container_import_stage(), OK);
    assert_eq!(container_import_policy_stage(id, 2, 0, 0), OK);
    let (next, (organized, disorganized, multiplier), drop_center) = ITEMS.with(|items| {
        let items = items.borrow();
        (
            items.staged_next_container.max(id as u64 + 1),
            items.staged_policy,
            items.staged_drop_items_center,
        )
    });
    assert_eq!(
        container_import_allocator(
            next as f64,
            u32::from(organized),
            u32::from(disorganized),
            multiplier as f64,
            u32::from(drop_center),
        ),
        OK
    );
}

#[unsafe(no_mangle)]
pub extern "C" fn health() -> f64 {
    ENGINE.with(|engine| engine.borrow().health)
}

#[unsafe(no_mangle)]
pub extern "C" fn is_dead() -> u32 {
    u32::from(health() == 0.0)
}

#[unsafe(no_mangle)]
pub extern "C" fn set_health(health: f64) -> i32 {
    if !health.is_finite() {
        return NONFINITE;
    }
    if !(0.0..=100.0).contains(&health) {
        return OUT_OF_RANGE;
    }
    mutate(|engine| engine.health = health);
    if health == 0.0 {
        MOODLES.with(|state| state.borrow_mut().pain_level = 0);
        actions::invalidate();
    }
    OK
}

#[cfg(test)]
mod tests {
    use super::*;

    const DT: f64 = 1.0 / 60.0;

    #[test]
    fn synthetic_upper_edge_floor_items_spawn_import_and_drop_at_inclusive_bounds() {
        for (x, y) in [(10.0, 5.0), (5.0, 10.0), (10.0, 10.0)] {
            reset();
            assert_eq!(
                item_definition_register(0, 1, 100, 0, 1, 0, 0, 0, 1.0, 0),
                OK
            );
            assert_eq!(item_spawn(0, x, y, 1, 100), OK);
            let id = item_last_id();
            let floor = ITEMS.with(|items| items.borrow().live[0].owner_container);
            assert_eq!(source_world_item_get(x as i32, y as i32, 0, 0), id as f64);
            assert_eq!(begin_actor_container_fixture(), OK);
            stage_floor_container_fixture(floor, x as i32, y as i32);
            assert_eq!(
                item_import_stage(id, 0, floor, x, y, 100, 1, 0, 1.0, 1.0, 0, 1),
                OK
            );
            assert_eq!(item_import_commit(), OK);
            ITEMS.with(|items| {
                let mut items = items.borrow_mut();
                items.live[0].owner_container = PLAYER_INVENTORY;
                items.live[0].world_object = false;
            });
            assert_eq!(item_drop(id, 10.01, y), OUT_OF_RANGE);
            assert_eq!(item_drop(id, x, 10.01), OUT_OF_RANGE);
            assert_eq!(item_drop(id, x, y), OK);
            assert_eq!(source_world_item_get(x as i32, y as i32, 0, 0), id as f64);
            ITEMS.with(|items| {
                let items = items.borrow();
                assert_eq!((items.live[0].x, items.live[0].y), (x, y));
            });
            assert_eq!(item_spawn(0, 10.01, y, 1, 100), OUT_OF_RANGE);
        }
    }

    #[test]
    fn graph_import_rejects_cycles_atomically_and_preserves_overcapacity_order() {
        reset();
        assert_eq!(
            item_definition_register(0, 1, 100, 0, 1, 0, 0, 0, 1.0, 0),
            OK
        );
        assert_eq!(
            item_definition_container_set(0, 1, 1, 1, 50, 0.0, 1, 1, 0, 0, 0),
            OK
        );
        assert_eq!(item_spawn(0, 5.0, 5.0, 1, 100), OK);
        let shell = item_last_id();
        let (floor, bag) = ITEMS.with(|state| {
            let state = state.borrow();
            let item = state.live[0];
            (item.owner_container, item.internal_container)
        });
        assert!(bag > floor && floor > PLAYER_INVENTORY);
        assert_eq!(item_import_begin(), OK);
        ITEMS.with(|state| {
            let mut state = state.borrow_mut();
            state.staged_containers = state.containers.clone();
            state.staged = state.live.clone();
            state.staged[0].owner_container = bag;
        });
        assert_eq!(item_import_commit(), BAD_FORMAT);
        assert_eq!(container_item_get(floor, 0), shell as f64);
        item_import_abort();
        assert_eq!(item_import_begin(), OK);
        ITEMS.with(|state| {
            let mut state = state.borrow_mut();
            state.staged_containers = state.containers.clone();
            state.staged = state.live.clone();
            let mut child = state.staged[0];
            child.id = shell + 1;
            child.internal_container = bag + 1;
            child.owner_container = bag;
            child.world_object = false;
            child.actual_weight = 100.0;
            state.staged.push(child);
            let mut inner = *state.container(bag).unwrap();
            inner.id = bag + 1;
            inner.containing_item = child.id;
            state.staged_containers.push(inner);
            state.staged_next_container = bag as u64 + 2;
        });
        assert_eq!(item_import_commit(), OK);
        assert_eq!(container_item_get(bag, 0), (shell + 1) as f64);
        assert_eq!(container_contains(floor, shell + 1, 0), 0);
        assert_eq!(container_contains(floor, shell + 1, 1), 1);
        assert_eq!(container_is_inside(bag + 1, shell), 1);
        assert_eq!(source_world_item_count(5, 5, 0), 1);
        assert_eq!(container_next_id(), (bag + 2) as f64);
    }

    #[test]
    fn graph_weights_discount_outer_contents_once_and_admission_rounds_old_load() {
        reset();
        assert_eq!(
            item_definition_register(0, 1, 100, 0, 1, 0, 0, 0, 1.0, 0),
            OK
        );
        assert_eq!(
            item_definition_container_set(0, 1, 1, 10, 50, 2.0, 1, 1, 0, 0, 0),
            OK
        );
        assert_eq!(
            item_definition_register(1, 1, 100, 0, 1, 0, 0, 0, 0.005, 0),
            OK
        );
        for definition in [0, 0, 1] {
            assert_eq!(item_spawn(definition, 5.0, 5.0, 1, 100), OK);
        }
        ITEMS.with(|state| {
            let mut state = state.borrow_mut();
            let outer = state.live[0].internal_container;
            let inner = state.live[1].internal_container;
            state.live[0].owner_container = PLAYER_INVENTORY;
            state.live[0].world_object = false;
            state.live[1].owner_container = outer;
            state.live[1].world_object = false;
            state.live[2].owner_container = inner;
            state.live[2].world_object = false;
            state.held[0] = state.live[0].id;
            assert_eq!(state.contents_weight(outer), 1.0_f32 + 0.005_f32);
            assert_eq!(
                state.capacity_weight(),
                1.0_f32 * 0.3 + (1.0_f32 + 0.005_f32) * 0.5
            );
            assert!(state.has_room_weight(inner, 1, 2.0, 2.0).unwrap());
            assert!(!state.has_room_weight(inner, 1, 2.00001, 2.00001).unwrap());
        });
    }

    fn body_text(value: &str) {
        assert!(value.len() <= 96);
        SCRATCH.with(|scratch| {
            let mut words = scratch.borrow_mut();
            let bytes =
                unsafe { std::slice::from_raw_parts_mut(words.as_mut_ptr().cast::<u8>(), 96) };
            bytes[..value.len()].copy_from_slice(value.as_bytes());
        });
    }

    fn location(value: &str) -> u32 {
        body_text(value);
        let token = body_location_lookup(value.len() as u32);
        assert!(token > 0);
        token as u32
    }

    #[test]
    fn canonical_registry_and_group_rules_preserve_original_identity_and_direction() {
        reset();
        let belt = location("BeltExtra");
        assert_eq!(location("BASE:BELTEXTRA"), belt);
        let forearm = location("ForeArm_Left");
        assert_eq!(body_location_read(forearm, 0), 17);
        assert_eq!(body_location_count(), 114);
        body_text("MakeUp_EyesShadow");
        assert!(body_location_lookup(17) > 0);
        body_text("mod:");
        assert_eq!(body_location_canonical(4), OUT_OF_RANGE);
        assert_eq!(body_location_canonical(97), OUT_OF_RANGE);
        body_text("FOO:Mixed:PATH");
        assert_eq!(body_location_canonical(14), 14);
        body_text("mod:Custom");
        let custom = body_location_register(10) as u32;
        assert!(custom > 114);
        assert_eq!(location("MOD:CUSTOM"), custom);
        assert_eq!(body_group_location_index(1, belt), -1);
        assert_eq!(body_group_multi_get(1, belt), OUT_OF_RANGE);
        assert_eq!(worn_item_set(belt, 0), OUT_OF_RANGE);
        assert_eq!(body_group_location_add(1, belt), OK);
        assert_eq!(body_group_location_add(1, forearm), OK);
        assert_eq!(body_group_location_add(1, belt), OK);
        assert_eq!(body_group_location_count(1), 2);
        assert_eq!(body_group_relation_set(1, belt, custom, 1), OK);
        assert_eq!(body_group_relation_get(1, belt, custom, 1), 1);
        assert_eq!(body_group_relation_set(1, belt, custom, 2), OK);
        assert_eq!(body_group_relation_get(1, belt, custom, 2), 1);
        assert_eq!(body_group_relation_set(1, forearm, belt, 3), OK);
        assert_eq!(body_group_relation_get(1, forearm, belt, 0), 1);
        assert_eq!(body_group_relation_get(1, belt, forearm, 0), 0);
        assert_eq!(body_group_relation_set(1, belt, forearm, 0), OK);
        assert_eq!(body_group_relation_get(1, forearm, belt, 0), 1);
        assert_eq!(body_group_relation_get(1, forearm, belt, 1), 0);
        assert_eq!(body_group_move(1, forearm, 0), OK);
        assert_eq!(body_group_location_at(1, 0), forearm);
        assert_eq!(body_group_move(1, belt, -1), OK);
        assert_eq!(body_locations_reset(), OK);
        assert_eq!(body_group_count(), 0);
        assert_eq!(body_group_location_at(1, 0), forearm);
        assert_eq!(worn_group_get(), 1);
        assert_eq!(body_group_total_count(), 1);
        assert_eq!(body_group_active(1), 0);
        body_text("Human");
        let fresh = body_group_get(5, 1);
        assert!(fresh > 1);
        assert_eq!(body_group_location_count(fresh as u32), 0);
    }

    #[test]
    fn worn_order_is_distinct_from_inventory_and_nil_evicts_exclusives() {
        reset();
        let shoes = location("Shoes");
        let hands = location("Hands");
        assert_eq!(body_group_location_add(1, shoes), OK);
        assert_eq!(body_group_location_add(1, hands), OK);
        assert_eq!(body_group_multi_set(1, shoes, 1), OK);
        assert_eq!(
            item_definition_register(0, 1, 10, hands, 1, 1, 1, 0, 10.0, 1),
            OK
        );
        assert_eq!(begin_actor_container_fixture(), OK);
        for id in [1, 2, 3] {
            assert_eq!(
                item_import_stage(id, 0, 1, 5.0, 5.0, 10, 1, 0, 10.0, 10.0, 0, 0),
                OK
            );
        }
        assert_eq!(item_import_commit(), OK);
        assert_eq!(worn_item_set(shoes, 1), OK);
        assert_eq!(worn_item_set(shoes, 2), OK);
        assert_eq!(worn_item_set(shoes, 1), OK);
        assert_eq!(worn_item_get(shoes), 2.0);
        assert_eq!(ITEMS.with(|s| s.borrow().worn.clone()), vec![2, 1]);
        assert_eq!(
            ITEMS.with(|s| s.borrow().live.iter().map(|i| i.id).collect::<Vec<_>>()),
            vec![1, 2, 3]
        );
        assert_eq!(worn_item_set(shoes, 0), OK);
        assert_eq!(worn_count(), 2);
        assert_eq!(item_wear(3), OK);
        assert_eq!(body_group_relation_set(1, shoes, hands, 0), OK);
        assert_eq!(worn_item_set(shoes, 0), OK);
        assert_eq!(worn_count(), 2);
        assert_eq!(worn_item_get(hands), 0.0);
        assert_eq!(item_unequip(2), OK);
        assert_eq!(item_set_condition(1, 0), OK);
        assert_eq!(worn_count(), 0);
        assert_eq!(item_wear(3), OK);
        assert_eq!(item_drop(3, 5.0, 5.0), OK);
        assert_eq!(worn_count(), 0);
    }

    #[test]
    fn preferred_equip_location_rolls_back_and_single_slots_replace_in_render_order() {
        reset();
        let shoes = location("Shoes");
        let hands = location("Hands");
        assert_eq!(
            BODY_LOCATIONS.with(|r| r.borrow().lookup("base:hands")),
            Some(36)
        );
        assert_eq!(ITEMS.with(|items| items.borrow().hands_slot), hands);
        assert_eq!(body_group_location_add(1, shoes), OK);
        assert_eq!(body_group_location_add(1, hands), OK);
        assert_eq!(
            item_definition_register(0, 1, 10, 0, 1, 0, 0, 0, 1.0, 1),
            OK
        );
        assert_eq!(item_definition_equip_set(0, 1, hands), OK);
        assert_eq!(item_definition_begin(1), OK);
        assert_eq!(item_definition_equip_set(0, 1, shoes), OK);
        assert_eq!(item_definition_rollback(1), OK);
        assert_eq!(item_definition_read(0), OK);
        assert_eq!(SCRATCH.with(|s| s.borrow()[8]), hands as f64);
        assert_eq!(begin_actor_container_fixture(), OK);
        for id in [1, 2, 3] {
            assert_eq!(
                item_import_stage(id, 0, 1, 5.0, 5.0, 10, 1, 0, 1.0, 1.0, 0, 0),
                OK
            );
        }
        assert_eq!(item_import_commit(), OK);
        assert_eq!(item_wear(1), OK);
        assert_eq!(worn_item_set(shoes, 2), OK);
        assert_eq!(worn_read(0), OK);
        assert_eq!(SCRATCH.with(|s| s.borrow()[0]), 2.0);
        assert_eq!(item_wear(3), OK);
        assert_eq!(worn_item_get(hands), 3.0);
        assert_eq!(worn_item_get(shoes), 2.0);
        assert_eq!(worn_count(), 2);
        assert_eq!(item_wearing_awkward_gloves(hands), 1);
        assert_eq!(worn_remove(99), OK);
        assert_eq!(worn_clear(), OK);
        assert_eq!(worn_count(), 0);
        assert_eq!(item_wearing_awkward_gloves(hands), 0);
    }

    #[test]
    fn legacy_import_orders_slots_stably_and_explicit_order_survives_group_move() {
        reset();
        let shoes = location("Shoes");
        let hands = location("Hands");
        assert_eq!(body_group_location_add(1, shoes), OK);
        assert_eq!(body_group_location_add(1, hands), OK);
        assert_eq!(body_group_multi_set(1, shoes, 1), OK);
        assert_eq!(
            item_definition_register(0, 1, 10, hands, 1, 0, 0, 0, 1.0, 0),
            OK
        );
        assert_eq!(begin_actor_container_fixture(), OK);
        for (id, slot) in [(3, hands), (2, shoes), (1, shoes)] {
            assert_eq!(
                item_import_stage(id, 0, 1, 5.0, 5.0, 10, 1, slot, 1.0, 1.0, 0, 0),
                OK
            );
        }
        assert_eq!(item_import_commit(), OK);
        assert_eq!(
            ITEMS.with(|items| items.borrow().worn.clone()),
            vec![2, 1, 3]
        );
        assert_eq!(body_group_move(1, hands, 0), OK);
        assert_eq!(body_group_location_at(1, 0), hands);
        assert_eq!(begin_actor_container_fixture(), OK);
        for (id, slot) in [(3, hands), (2, shoes), (1, shoes)] {
            assert_eq!(
                item_import_stage(id, 0, 1, 5.0, 5.0, 10, 1, slot, 1.0, 1.0, 0, 0),
                OK
            );
        }
        assert_eq!(item_import_worn_begin(), OK);
        for id in [2, 1, 3] {
            assert_eq!(item_import_worn_stage(id), OK);
        }
        assert_eq!(item_import_commit(), OK);
        assert_eq!(
            ITEMS.with(|items| items.borrow().worn.clone()),
            vec![2, 1, 3]
        );
        assert_eq!(worn_item_get(shoes), 2.0);
        assert_eq!(body_locations_reset(), OK);
        assert_eq!(item_unequip(2), OK);
        assert_eq!(worn_item_get(shoes), 1.0);
    }

    #[test]
    fn explicit_snapshots_preserve_directional_and_changed_registry_rule_states() {
        reset();
        let shoes = location("Shoes");
        let hands = location("Hands");
        assert_eq!(body_group_location_add(1, shoes), OK);
        assert_eq!(body_group_location_add(1, hands), OK);
        assert_eq!(body_group_relation_set(1, shoes, hands, 3), OK);
        assert_eq!(
            item_definition_register(0, 1, 10, shoes, 1, 0, 0, 0, 1.0, 0),
            OK
        );
        assert_eq!(begin_actor_container_fixture(), OK);
        for id in [1, 2, 3] {
            assert_eq!(
                item_import_stage(id, 0, 1, 5.0, 5.0, 10, 1, 0, 1.0, 1.0, 0, 0),
                OK
            );
        }
        assert_eq!(item_import_commit(), OK);
        assert_eq!(worn_item_set(shoes, 1), OK);
        assert_eq!(worn_item_set(hands, 2), OK);
        for pass in 0..2 {
            if pass == 1 {
                assert_eq!(body_group_multi_set(1, shoes, 1), OK);
                assert_eq!(worn_item_set(shoes, 3), OK);
                assert_eq!(worn_item_set(hands, 2), OK);
                assert_eq!(body_group_multi_set(1, shoes, 0), OK);
                assert_eq!(body_group_relation_set(1, shoes, hands, 0), OK);
            }
            let (rows, order) = ITEMS.with(|items| {
                let items = items.borrow();
                (items.live.clone(), items.worn.clone())
            });
            assert_eq!(begin_actor_container_fixture(), OK);
            for item in rows {
                assert_eq!(
                    item_import_stage(
                        item.id,
                        item.definition,
                        item.owner_container,
                        item.x,
                        item.y,
                        item.condition,
                        item.count,
                        item.slot,
                        item.weight as f64,
                        item.actual_weight as f64,
                        item.internal_container,
                        u32::from(item.world_object),
                    ),
                    OK
                );
            }
            assert_eq!(item_import_worn_begin(), OK);
            for id in &order {
                assert_eq!(item_import_worn_stage(*id), OK);
            }
            assert_eq!(item_import_commit(), OK);
            assert_eq!(ITEMS.with(|items| items.borrow().worn.clone()), order);
            assert_eq!(worn_item_get(shoes), 1.0);
            assert_eq!(worn_item_get(hands), 2.0);
            assert_eq!(worn_count(), if pass == 0 { 2 } else { 3 });
        }
    }

    #[test]
    fn explicit_worn_import_is_atomic_and_enforces_group_not_definition_slot() {
        reset();
        let shoes = location("Shoes");
        let hands = location("Hands");
        assert_eq!(body_group_location_add(1, shoes), OK);
        assert_eq!(body_group_location_add(1, hands), OK);
        assert_eq!(body_group_multi_set(1, shoes, 1), OK);
        assert_eq!(
            item_definition_register(0, 1, 10, hands, 1, 0, 1, 0, 1.0, 0),
            OK
        );
        assert_eq!(begin_actor_container_fixture(), OK);
        for id in [1, u32::MAX] {
            assert_eq!(
                item_import_stage(id, 0, 1, 5.0, 5.0, 10, 1, shoes, 1.0, 1.0, 0, 0),
                OK
            );
        }
        assert_eq!(item_import_worn_begin(), OK);
        assert_eq!(item_import_worn_stage(u32::MAX), OK);
        assert_eq!(item_import_worn_stage(1), OK);
        assert_eq!(item_import_commit(), OK);
        assert_eq!(worn_item_get(shoes), u32::MAX as f64);
        assert_eq!(begin_actor_container_fixture(), OK);
        assert_eq!(
            item_import_stage(2, 0, 1, 5.0, 5.0, 10, 1, shoes, 1.0, 1.0, 0, 0),
            OK
        );
        assert_eq!(item_import_worn_begin(), OK);
        assert_eq!(item_import_commit(), BAD_FORMAT);
        assert_eq!(worn_item_get(shoes), u32::MAX as f64);
        item_import_abort();
        assert_eq!(body_group_multi_set(1, shoes, 0), OK);
        assert_eq!(begin_actor_container_fixture(), OK);
        for id in [2, 3] {
            assert_eq!(
                item_import_stage(id, 0, 1, 5.0, 5.0, 10, 1, shoes, 1.0, 1.0, 0, 0),
                OK
            );
        }
        assert_eq!(item_import_commit(), BAD_FORMAT);
        assert_eq!(item_count(), 2);
        item_import_abort();
        assert_eq!(body_group_multi_set(1, shoes, 1), OK);
        assert_eq!(body_group_relation_set(1, shoes, hands, 0), OK);
        assert_eq!(begin_actor_container_fixture(), OK);
        assert_eq!(
            item_import_stage(2, 0, 1, 5.0, 5.0, 10, 1, shoes, 1.0, 1.0, 0, 0),
            OK
        );
        assert_eq!(
            item_import_stage(3, 0, 1, 5.0, 5.0, 10, 1, hands, 1.0, 1.0, 0, 0),
            OK
        );
        assert_eq!(item_import_commit(), BAD_FORMAT);
        item_import_abort();
        assert_eq!(begin_actor_container_fixture(), OK);
        assert_eq!(
            item_import_stage(2, 0, 1, 5.0, 5.0, 10, 1, shoes, 1.0, 1.0, 0, 0),
            OK
        );
        assert_eq!(item_import_worn_begin(), OK);
        assert_eq!(item_import_worn_stage(9), BAD_FORMAT);
        assert_eq!(item_import_commit(), OUT_OF_RANGE);
        assert_eq!(worn_item_get(shoes), u32::MAX as f64);
        reset();
        assert_eq!(worn_count(), 0);
    }

    #[test]
    fn held_items_preserve_full_ids_validate_pairs_and_clear_removed_refs() {
        reset();
        assert_eq!(
            item_definition_register(0, 1, 10, 1, 1, 1, 1, 0, 10.0, 0),
            OK
        );
        assert_eq!(begin_actor_container_fixture(), OK);
        let floor = container_next_id() as u32;
        stage_floor_container_fixture(floor, 5, 5);
        assert_eq!(
            item_import_stage(u32::MAX, 0, 1, 5.0, 5.0, 10, 1, 0, 10.0, 10.0, 0, 0),
            OK
        );
        assert_eq!(
            item_import_stage(1, 0, floor, 5.0, 5.0, 10, 1, 0, 10.0, 10.0, 0, 1),
            OK
        );
        assert_eq!(item_import_commit(), OK);
        assert_eq!(hand_item_set(0, u32::MAX), OK);
        assert_eq!(hand_item_set(1, u32::MAX), OK);
        assert_eq!(hand_item_get(0), u32::MAX as f64);
        assert_eq!(hand_item_set(0, u32::MAX), OK);
        assert_eq!(hand_item_set(2, 0), OUT_OF_RANGE);
        assert_eq!(hand_items_restore(0, 1), OUT_OF_RANGE);
        assert_eq!(hand_item_get(0), u32::MAX as f64);
        assert_eq!(hand_item_get(1), u32::MAX as f64);
        assert_eq!(item_definition_begin(1), OK);
        assert_eq!(hand_item_set(0, 0), OUT_OF_RANGE);
        assert_eq!(hand_items_restore(0, 0), OUT_OF_RANGE);
        assert_eq!(item_definition_rollback(1), OK);
        assert_eq!(hand_item_get(0), u32::MAX as f64);
        assert_eq!(ITEMS.with(|items| items.borrow().capacity_weight()), 3.0);
        assert_eq!(item_drop(u32::MAX, f64::NAN, 5.0), NONFINITE);
        assert_eq!(hand_item_get(0), u32::MAX as f64);
        assert_eq!(item_drop(u32::MAX, 5.0, 5.0), OK);
        assert_eq!(hand_item_get(0), 0.0);
        assert_eq!(hand_item_get(1), 0.0);
        assert_eq!(hand_items_restore(u32::MAX, 0), OUT_OF_RANGE);
        assert_eq!(begin_actor_container_fixture(), OK);
        assert_eq!(
            item_import_stage(u32::MAX, 0, 1, 5.0, 5.0, 10, 1, 0, 10.0, 10.0, 0, 0),
            OK
        );
        assert_eq!(hand_item_set(0, 0), OUT_OF_RANGE);
        assert_eq!(item_import_commit(), OK);
        assert_eq!(hand_items_restore(u32::MAX, u32::MAX), OK);
        assert_eq!(item_set_condition(u32::MAX, 0), OK);
        assert_eq!(hand_item_get(0), 0.0);
        assert_eq!(hand_item_get(1), 0.0);
        reset();
        assert_eq!(hand_item_get(0), 0.0);
    }

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
    fn step_window_includes_zero_and_is_bounded_above() {
        reset();
        assert_eq!(step(0.0), OK);
        assert_eq!(step(1.0e-9), OK);
        assert_eq!(step(MAX_STEP_SECONDS), OK);
        assert_eq!(tick(), 3);
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

    // ---- world grid + save-state rules ----

    fn pack_words(tiles: &[u8; 64]) -> [i64; 8] {
        let mut words = [0_i64; 8];
        for (i, byte) in tiles.iter().enumerate() {
            words[i / 8] |= (*byte as i64) << ((i % 8) * 8);
        }
        words
    }

    fn saved_state() -> [f64; 12] {
        state_save(scratch_ptr().cast());
        SCRATCH.with(|scratch| *scratch.borrow())
    }

    fn load_saved(values: [f64; 12]) -> i32 {
        SCRATCH.with(|scratch| *scratch.borrow_mut() = values);
        state_load(scratch_ptr().cast())
    }

    fn spawn_at(x: f32, y: f32) {
        let mut state = saved_state();
        state[0] = x as f64;
        state[1] = y as f64;
        state[3] = x as f64;
        state[4] = y as f64;
        state[5] = 0.0;
        state[6] = 0.0;
        state[7] = ACTION_IDLE as f64;
        assert_eq!(load_saved(state), OK);
    }

    /// Streams a full 1024-record cell as regular chunks, tiles from a fn.
    fn import_cell(cell_x: i64, cell_y: i64, tile: impl Fn(i64, i64) -> u8) {
        for index in 0..CHUNK_RECORDS {
            let chunk_x = index % CHUNKS_PER_AXIS;
            let chunk_y = index / CHUNKS_PER_AXIS;
            let mut tiles = [0_u8; 64];
            for row in 0..CHUNK_TILES {
                for col in 0..CHUNK_TILES {
                    let tx = cell_x * CELL_TILES + chunk_x * CHUNK_TILES + col;
                    let ty = cell_y * CELL_TILES + chunk_y * CHUNK_TILES + row;
                    tiles[(row * CHUNK_TILES + col) as usize] = tile(tx, ty);
                }
            }
            let words = pack_words(&tiles);
            let status = world_import_chunk(
                cell_x as i32,
                cell_y as i32,
                index as i32,
                2,
                words[0],
                words[1],
                words[2],
                words[3],
                words[4],
                words[5],
                words[6],
                words[7],
            );
            assert_eq!(status, OK, "import record {index} failed");
        }
    }

    fn tile_flags(x: i64, y: i64) -> u32 {
        nav_flags(x as i32, y as i32)
    }

    #[test]
    fn import_commits_atomically_and_rejects_malformed_cells() {
        reset();
        import_cell(3, 4, |_, _| 0);
        assert_eq!(tile_flags(3 * 256 + 5, 4 * 256 + 5), 0);

        // Half-imported cell must never become live: start it, break it.
        for index in 0..5 {
            assert_eq!(
                world_import_chunk(9, 9, index, 0, 0, 0, 0, 0, 0, 0, 0, 0),
                OK
            );
        }
        assert_eq!(
            world_import_chunk(9, 9, 5, 7, 0, 0, 0, 0, 0, 0, 0, 0),
            BAD_FORMAT
        );
        // Staging was discarded by the bad tag; the next record cannot resume.
        assert_eq!(
            world_import_chunk(9, 9, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0),
            BAD_FORMAT
        );
        assert_eq!(tile_flags(9 * 256, 9 * 256), 0xFFFF_FFFF);
        assert_eq!(
            world_import_chunk(101, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
            OUT_OF_RANGE
        );

        // A second full cell extends the loaded bounds.
        import_cell(4, 4, |_, _| NAV_WATER);
        assert_eq!(tile_flags(4 * 256, 4 * 256), NAV_WATER as u32);
    }

    #[test]
    fn solid_blocks_entry_and_wall_blocks_the_shared_edge() {
        reset();
        import_cell(0, 0, |tx, ty| {
            if tx == 10 && ty == 10 {
                NAV_SOLID
            } else if tx == 11 && ty == 5 {
                NAV_WALL_WEST
            } else {
                0
            }
        });
        assert_eq!(move_to(10.5, 10.5), OUT_OF_RANGE);

        assert_eq!(move_to(10.5, 5.5), OK);
        run_until_idle();
        assert_eq!(walk(1.0, 0.0), BLOCKED);
        assert_eq!(walk(-1.0, 0.0), OK);
        assert_eq!(step(0.1), OK);
        assert!(position_x() < 10.5);
    }

    #[test]
    fn paths_route_around_walls_in_nonzero_cells() {
        reset();
        let (cx, cy) = (2_i64, 1_i64);
        import_cell(cx, cy, |tx, ty| {
            let wall_x = cx * CELL_TILES + 20;
            if tx == wall_x && (cy * CELL_TILES + 20..cy * CELL_TILES + 30).contains(&ty) {
                NAV_SOLID | NAV_WALL_WEST
            } else {
                0
            }
        });
        let start = (cx as f32 * 256.0 + 18.5, cy as f32 * 256.0 + 22.5);
        let goal = (cx as f32 * 256.0 + 22.5, cy as f32 * 256.0 + 22.5);
        spawn_at(start.0, start.1);
        assert_eq!(move_to(f64::from(goal.0), f64::from(goal.1)), OK);
        let mut steps = 0;
        while action() != ACTION_IDLE {
            assert_eq!(step(DT), OK);
            steps += 1;
            assert!(steps < 5_000, "detour never finished");
            let flags = tile_flags(position_x().floor() as i64, position_y().floor() as i64);
            assert_eq!(flags & NAV_SOLID as u32, 0, "path entered a solid tile");
        }
        // The straight line is blocked, so the path must have left the row.
        assert!(!line_passable(start, goal));
        assert!(near(position_x(), goal.0));
        assert!(near(position_y(), goal.1));
    }

    #[test]
    fn fast_steps_follow_waypoints_without_cutting_corners() {
        reset();
        import_cell(0, 0, |tx, ty| {
            if tx == 10 && (5..15).contains(&ty) {
                NAV_SOLID | NAV_WALL_WEST
            } else {
                0
            }
        });
        assert_eq!(set_speed(10.0), OK);
        assert_eq!(move_to(5.5, 8.5), OK);
        assert_eq!(move_to(15.5, 8.5), OK);
        let mut previous = (position_x(), position_y());
        let mut steps = 0;
        while action() != ACTION_IDLE {
            assert_eq!(step(0.1), OK);
            steps += 1;
            assert!(steps < 5_000);
            let current = (position_x(), position_y());
            assert!(
                line_passable(previous, current),
                "step from {:?} to {:?} crossed a blocked boundary",
                previous,
                current
            );
            previous = current;
        }
        assert!(near(position_x(), 15.5));
        assert!(near(position_y(), 8.5));
    }

    #[test]
    fn state_roundtrip_restores_hidden_movement() {
        reset();
        import_cell(0, 0, |_, _| 0);
        assert_eq!(move_to(50.5, 40.5), OK);
        for _ in 0..10 {
            assert_eq!(step(DT), OK);
        }
        let saved = saved_state();
        assert_eq!(move_to(1.5, 1.5), OK);
        cancel();
        assert_eq!(action(), ACTION_IDLE);
        assert_eq!(load_saved(saved), OK);
        assert!(near(position_x(), saved[0] as f32));
        assert!(near(position_y(), saved[1] as f32));
        assert_eq!(action(), ACTION_DESTINATION);
        let after = saved_state();
        assert!(near(after[3] as f32, saved[3] as f32));
        assert_eq!(tick(), saved[8] as u32);
    }

    #[test]
    fn state_load_refusals_change_nothing() {
        reset();
        import_cell(
            0,
            0,
            |tx, ty| {
                if tx == 7 && ty == 7 { NAV_SOLID } else { 0 }
            },
        );
        assert_eq!(move_to(20.5, 20.5), OK);
        for _ in 0..5 {
            assert_eq!(step(DT), OK);
        }
        let saved = saved_state();
        let x = position_x();
        let y = position_y();
        let tick_before = tick();

        let mut bad_speed = saved;
        bad_speed[2] = 0.0;
        assert_eq!(load_saved(bad_speed), OUT_OF_RANGE);

        let mut bad_position = saved;
        bad_position[0] = 7.5;
        bad_position[1] = 7.5;
        assert_eq!(load_saved(bad_position), OUT_OF_RANGE);

        let mut not_finite = saved;
        not_finite[0] = f64::NAN;
        assert_eq!(load_saved(not_finite), NONFINITE);

        let mut flag_mismatch = saved;
        flag_mismatch[9] = 0.0;
        assert_eq!(load_saved(flag_mismatch), OUT_OF_RANGE);

        let mut bad_action = saved;
        bad_action[7] = 3.0;
        assert_eq!(load_saved(bad_action), OUT_OF_RANGE);

        assert!(near(position_x(), x) && near(position_y(), y));
        assert_eq!(tick(), tick_before);
        assert_eq!(action(), ACTION_DESTINATION);
    }

    #[test]
    fn world_reset_returns_to_the_synthetic_plane() {
        reset();
        import_cell(1, 0, |_, _| 0);
        world_reset();
        assert_eq!(tile_flags(300, 10), 0xFFFF_FFFF);
        assert_eq!(move_to(6.0, 6.0), OK);
        run_until_idle();
        assert!(near(position_x(), 6.0));
    }

    #[test]
    fn missing_duplicate_and_invalid_records_discard_staging() {
        reset();
        import_cell(0, 0, |_, _| NAV_ROOM);
        for (index, tag) in [(1023, 0), (2, 0), (1, 256), (-1, 0), (1024, 0)] {
            assert_eq!(world_import_chunk(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), OK);
            assert_eq!(
                world_import_chunk(0, 0, index, tag, 0, 0, 0, 0, 0, 0, 0, 0),
                BAD_FORMAT
            );
            assert_eq!(
                world_import_chunk(0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0),
                BAD_FORMAT
            );
            assert_eq!(nav_flags(0, 0), NAV_ROOM as u32);
        }
        assert_eq!(world_import_chunk(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), OK);
        assert_eq!(world_import_chunk(0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0), OK);
        assert_eq!(
            world_import_chunk(0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0),
            BAD_FORMAT
        );
        assert_eq!(nav_flags(0, 0), NAV_ROOM as u32);
        assert_eq!(world_import_chunk(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), OK);
        assert_eq!(
            world_import_chunk(0, 0, 1, 2, 0x40, 0, 0, 0, 0, 0, 0, 0),
            BAD_FORMAT
        );
        assert_eq!(
            world_import_chunk(0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0),
            BAD_FORMAT
        );
        assert_eq!(nav_flags(0, 0), NAV_ROOM as u32);
    }

    #[test]
    fn line_checks_stop_at_endpoint_and_reject_corner_cutting() {
        reset();
        import_cell(0, 0, |x, y| {
            if (x == 11 && y == 10) || (x == 21 && y == 20) {
                NAV_SOLID
            } else if x == 31 && y == 30 {
                NAV_WALL_WEST
            } else {
                0
            }
        });
        assert!(line_passable((10.1, 10.5), (10.9, 10.5)));
        assert!(!line_passable((10.1, 10.5), (11.0, 10.5)));
        assert!(!line_passable((20.5, 20.5), (21.5, 21.5)));
        assert!(!line_passable((30.5, 30.5), (31.0, 30.5)));
        assert!(line_passable((30.0, 30.5), (29.5, 30.5)));
        assert!(!line_passable((31.0, 30.5), (30.5, 30.5)));
        assert!(line_passable((255.5, 10.5), (255.9, 10.5)));
        assert!(!line_passable((255.5, 10.5), (256.0, 10.5)));
    }

    #[test]
    fn signed_tile_keys_and_offcenter_route_legs_are_legal() {
        reset();
        import_cell(-1, -1, |x, y| {
            if x == -6 && (-10..-3).contains(&y) {
                NAV_SOLID
            } else {
                0
            }
        });
        spawn_at(-8.01, -8.01);
        let start = (position_x(), position_y());
        let goal = (-4.99, -8.99);
        let path = find_path(start, goal).expect("negative-coordinate detour");
        let mut previous = start;
        for waypoint in path {
            assert!(line_passable(previous, waypoint));
            previous = waypoint;
        }
        assert!(line_passable(previous, goal));
        assert_eq!(move_to(goal.0 as f64, goal.1 as f64), OK);
        run_until_idle();
        assert_eq!((position_x(), position_y()), goal);
    }

    #[test]
    fn restored_destination_replans_and_unreachable_load_is_atomic() {
        reset();
        import_cell(0, 0, |x, y| {
            if x == 10 && (0..15).contains(&y) {
                NAV_SOLID
            } else {
                0
            }
        });
        assert_eq!(move_to(15.5, 8.5), OK);
        let saved = saved_state();
        cancel();
        assert_eq!(load_saved(saved), OK);
        assert!(WORLD.with(|world| !world.borrow().path.is_empty()));
        for _ in 0..20 {
            let previous = (position_x(), position_y());
            assert_eq!(step(0.1), OK);
            assert!(line_passable(previous, (position_x(), position_y())));
        }
        import_cell(0, 0, |x, _| if x == 10 { NAV_SOLID } else { 0 });
        let before = saved_state();
        assert_eq!(load_saved(saved), BLOCKED);
        assert_eq!(saved_state(), before);
        assert_eq!(
            action(),
            ACTION_IDLE,
            "cell replacement must not leave a direct route"
        );
    }

    #[test]
    fn blocked_axis_heading_stops_instead_of_sliding_zero_distance() {
        reset();
        import_cell(0, 0, |x, _| if x == 10 { NAV_WALL_WEST } else { 0 });
        assert_eq!(walk(1.0, 0.0), OK);
        run_until_idle();
        assert!(position_x() < 10.0);
        assert_eq!(position_y(), 5.0);
    }

    #[test]
    fn every_state_word_and_scratch_pointer_is_validated() {
        reset();
        assert_eq!(walk(1.0, 1.0), OK);
        assert_eq!(step(DT), OK);
        let saved = saved_state();
        for index in 0..12 {
            for invalid in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
                let mut values = saved;
                values[index] = invalid;
                assert_eq!(load_saved(values), NONFINITE);
                assert_eq!(saved_state(), saved);
            }
        }
        for (index, invalid) in [
            (7, 1.5),
            (8, 1.5),
            (8, -1.0),
            (8, u32::MAX as f64 + 1.0),
            (5, 2.0),
            (6, 0.0),
            (9, 0.5),
        ] {
            let mut values = saved;
            values[index] = invalid;
            assert_eq!(load_saved(values), OUT_OF_RANGE);
            assert_eq!(saved_state(), saved);
        }
        assert_eq!((scratch_ptr() as usize) % 8, 0);
        assert_eq!(state_load(std::ptr::null()), OUT_OF_RANGE);
        assert_eq!(
            state_load(std::ptr::NonNull::<f64>::dangling().as_ptr()),
            OUT_OF_RANGE
        );
        assert_eq!(
            state_load(scratch_ptr().wrapping_add(8).cast()),
            OUT_OF_RANGE
        );
        let mut foreign = [123.0_f64; 12];
        state_save(foreign.as_mut_ptr());
        assert_eq!(foreign, [123.0; 12]);
        let mut bounds = [123_i32; 6];
        world_bounds(bounds.as_mut_ptr());
        assert_eq!(bounds, [123; 6]);
        assert_eq!(state_load(foreign.as_ptr()), OUT_OF_RANGE);
        state_save(std::ptr::NonNull::<f64>::dangling().as_ptr());
        world_bounds(std::ptr::NonNull::<i32>::dangling().as_ptr());
        world_bounds(scratch_ptr().cast());
        SCRATCH.with(|scratch| {
            let words = scratch.borrow();
            let bounds = unsafe { std::slice::from_raw_parts(words.as_ptr().cast::<i32>(), 6) };
            assert_eq!(bounds, &[0, 0, 0, 0, 0, 0]);
        });
    }
}
