//! Authoritative movement rules for the M1 architecture proof.
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
            Some(byte) => byte as u32,
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
        let Some(from) = self.byte_at(tile) else {
            return false;
        };
        let Some(to) = self.byte_at(neighbour(tile, dx, dy)) else {
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
    static SCRATCH: RefCell<[f64; 10]> = const { RefCell::new([0.0; 10]) };
}

/// Base pointer for world_bounds/state_save/state_load, valid until instance
/// teardown. Hosts must reacquire memory views after calls that grow memory.
#[unsafe(no_mangle)]
pub extern "C" fn scratch_ptr() -> *mut u8 {
    SCRATCH.with(|scratch| scratch.as_ptr().cast())
}

/// Scratch capacity in bytes, shared by six i32 bounds or ten f64 state words.
#[unsafe(no_mangle)]
pub extern "C" fn scratch_size() -> u32 {
    80
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
    world_reset();
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

/// Assigns a destination. Without an imported world the destination must be
/// inside [0, 10]^2 (the M1 synthetic plane). Once any world cell is imported
/// the destination is checked against the tile grid and the engine plans an
/// A* path; outside, blocked or unreachable destinations are refused, never
/// clamped. A destination equal to the current position is already reached.
#[unsafe(no_mangle)]
pub extern "C" fn move_to(x: f64, y: f64) -> i32 {
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
    clear_world_path();
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
    clear_world_path();
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
        // Both buffers are valid and disjoint; the destination has 80 bytes
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
    10
}

/// Writes [x, y, speed, target_x, target_y, heading_x, heading_y, action,
/// tick, world-active] into scratch_ptr(). Other pointers are ignored.
#[unsafe(no_mangle)]
pub extern "C" fn state_save(out: *mut f64) {
    if out.cast::<u8>() != scratch_ptr() {
        return;
    }
    let engine = ENGINE.with(|engine| *engine.borrow());
    let values: [f64; 10] = [
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
    ];
    SCRATCH.with(|scratch| *scratch.borrow_mut() = values);
}

/// Restores all ten state words atomically from scratch_ptr(); other pointers
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
        OK
    })
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

    // ---- world grid + save-state rules ----

    fn pack_words(tiles: &[u8; 64]) -> [i64; 8] {
        let mut words = [0_i64; 8];
        for (i, byte) in tiles.iter().enumerate() {
            words[i / 8] |= (*byte as i64) << ((i % 8) * 8);
        }
        words
    }

    fn saved_state() -> [f64; 10] {
        state_save(scratch_ptr().cast());
        SCRATCH.with(|scratch| *scratch.borrow())
    }

    fn load_saved(values: [f64; 10]) -> i32 {
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
        assert_eq!(state_size(), 10);
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
        for index in 0..10 {
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
        assert_eq!(scratch_size(), 80);
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
        let mut foreign = [123.0_f64; 10];
        state_save(foreign.as_mut_ptr());
        assert_eq!(foreign, [123.0; 10]);
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
