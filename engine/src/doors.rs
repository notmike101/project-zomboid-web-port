//! Optional door extension. Source geometry is re-imported before saved state.
//! Actor elevation is currently zero; no key objects or vehicles are simulated.
use super::{
    BAD_FORMAT, BLOCKED, ENGINE, NAV_WALL_NORTH, NAV_WALL_WEST, OK, OUT_OF_RANGE, SCRATCH,
};
use std::{cell::RefCell, collections::HashMap};

type SquareKey = (i32, i32, i32);
const NORTH: u32 = 1;
const OPEN: u32 = 2;
const LOCKED: u32 = 4;
const KEY_LOCKED: u32 = 8;
const FORCE: u32 = 16;
const EAST: u32 = 32;
const SOUTH: u32 = 64;
const BARRICADED: u32 = 128;
const INTERIOR: u32 = 256;
const HOPPABLE: u32 = 512;
const CUSTOM_LOCK: u32 = 1024;
const SELECTED: u32 = 2048;
const TOGGLED: u32 = 4096;
const WALLS: u8 = NAV_WALL_NORTH | NAV_WALL_WEST;
const SPRITE_FACTS_MASK: u32 = 126 | (126 << 7) | (126 << 14) | (126 << 21);
const INTERACTION_PROPERTIES_MASK: u32 = 510;
const DOOR_INTERACTION_PROPERTIES_MASK: u32 = INTERACTION_PROPERTIES_MASK & !(32 | 64);
const LIMIT: usize = 65_536;

#[derive(Clone, Copy, PartialEq)]
struct Door {
    id: u32,
    origin: SquareKey,
    flags: u32,
    key: i32,
    room: i64,
    opposite_room: i64,
    walls: u8,
    double: u32,
    garage: u32,
    sprite_facts: u32,
    interaction_properties: [u16; 4],
}
impl Door {
    fn open(self) -> bool {
        self.flags & OPEN != 0
    }
    fn sprite_facts(self) -> u8 {
        let shift =
            if self.flags & TOGGLED != 0 { 14 } else { 0 } + if self.open() { 7 } else { 0 };
        ((self.sprite_facts >> shift) & 126) as u8
    }
    fn interaction_properties(self) -> u16 {
        let index = if self.flags & TOGGLED != 0 { 2 } else { 0 } + usize::from(self.open());
        self.interaction_properties[index]
    }
    fn blocked(self) -> bool {
        !self.open() || self.flags & BARRICADED != 0
    }
    fn north(self) -> bool {
        self.flags & NORTH != 0
    }
    fn position(self) -> SquareKey {
        let (mut x, mut y, z) = self.origin;
        if self.open() && self.double != 0 {
            let i = (self.double - 1) as usize;
            if self.north() {
                x += [0, -1, 1, 0][i];
                y += [0, 1, 1, 0][i];
            } else {
                x += [0, 1, 1, 0][i];
                y += [0, 1, -1, 0][i];
            }
        }
        (x, y, z)
    }
    fn sprite_edge(self) -> (SquareKey, u8) {
        let (mut x, mut y, z) = self.position();
        let bit = if !self.open() || self.garage != 0 {
            if self.north() {
                NAV_WALL_NORTH
            } else {
                NAV_WALL_WEST
            }
        } else if self.flags & EAST != 0 {
            x += 1;
            NAV_WALL_WEST
        } else if self.flags & SOUTH != 0 {
            y += 1;
            NAV_WALL_NORTH
        } else if self.north() {
            NAV_WALL_WEST
        } else {
            NAV_WALL_NORTH
        };
        ((x, y, z), bit)
    }
    fn edge(self) -> (SquareKey, u8) {
        // GridSquareEdgeElement facing depends only on getNorth(), not on
        // open state, sprite rotation or attachedE/S render flags.
        (
            self.position(),
            if self.north() {
                NAV_WALL_NORTH
            } else {
                NAV_WALL_WEST
            },
        )
    }
    fn base(self) -> SquareKey {
        let (x, y, z) = self.origin;
        if self.double != 0 {
            if self.north() {
                (x - self.double as i32 + 1, y, z)
            } else {
                (x, y + self.double as i32 - 1, z)
            }
        } else {
            self.origin
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
struct Square {
    room: i64,
    flags: u32,
    walls: u8,
    windows: u8,
    door_walls: u8,
    hoppable_edges: u8,
    window_edges: u8,
    interaction_properties: u16,
}
impl Square {
    fn solid(self) -> bool {
        self.flags & (2 | 4 | 8) != 0
    }
    fn vehicle(self) -> bool {
        self.flags & 16 != 0
    }
}
struct Doors {
    rows: Vec<Door>,
    squares: HashMap<SquareKey, Square>,
    removed: HashMap<SquareKey, u8>,
    edges: HashMap<SquareKey, u8>,
    // Low seven bits retain legacy stand/square facts; upper bits are source facts.
    sprite_facts: HashMap<SquareKey, u32>,
    revision: u32,
    seed: u32,
    rng: u64,
    houses: u32,
}
impl Doors {
    fn new(seed: u32, houses: u32) -> Self {
        Self {
            rows: Vec::new(),
            squares: HashMap::new(),
            removed: HashMap::new(),
            edges: HashMap::new(),
            sprite_facts: HashMap::new(),
            revision: 0,
            seed,
            rng: seed as u64,
            houses,
        }
    }
    fn rebuild(&mut self) {
        self.edges.clear();
        self.sprite_facts.clear();
        for door in &self.rows {
            let sprite_facts =
                door.sprite_facts() as u32 | ((door.interaction_properties() as u32) << 7);
            if sprite_facts != 0 {
                *self.sprite_facts.entry(door.position()).or_default() |= sprite_facts;
            }
            if !door.blocked() {
                continue;
            }
            let (key, bit) = door.edge();
            *self.edges.entry(key).or_default() |= bit;
        }
    }
    // SplitMix64 is a port-owned saved RNG, NOT native CellularAutomaton parity.
    fn random(&mut self, bound: u64) -> u64 {
        let threshold = bound.wrapping_neg() % bound;
        loop {
            self.rng = self.rng.wrapping_add(0x9e3779b97f4a7c15);
            let mut n = self.rng;
            n = (n ^ (n >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
            n = (n ^ (n >> 27)).wrapping_mul(0x94d049bb133111eb);
            n ^= n >> 31;
            if n >= threshold {
                return n % bound;
            }
        }
    }
    fn initialize(&mut self) {
        let chance = [0, 5, 10, 50, 60, 70][(self.houses - 1) as usize];
        for i in 0..self.rows.len() {
            let locked = self.houses != 1 && self.random(100) < chance;
            let keyed = locked && self.random(3) == 0;
            let row = &mut self.rows[i];
            row.flags &= !(LOCKED | KEY_LOCKED);
            if locked {
                row.flags |= LOCKED;
            }
            if keyed {
                row.flags |= KEY_LOCKED;
            }
            if row.flags & FORCE != 0 {
                row.flags |= LOCKED | KEY_LOCKED;
            }
            if row.open() {
                row.flags &= !(LOCKED | KEY_LOCKED);
            }
        }
    }
    fn coupled(&self, a: Door, b: Door) -> bool {
        if a.id == b.id {
            return true;
        }
        if a.north() != b.north() || a.origin.2 != b.origin.2 || a.open() != b.open() {
            return false;
        }
        if a.double != 0 {
            return b.double != 0 && a.base() == b.base();
        }
        if a.garage == 0 || b.garage == 0 {
            return false;
        }
        // Original prev/next chains join consecutive coordinates and increasing
        // panel indices; middle index 2 may repeat for wide garage doors.
        let mut current = a;
        for direction in [-1, 1] {
            loop {
                if (direction == -1 && current.garage == 1)
                    || (direction == 1 && current.garage == 3)
                {
                    break;
                }
                let (x, y, z) = current.origin;
                let key = if a.north() {
                    (x + direction, y, z)
                } else {
                    (x, y - direction, z)
                };
                let Some(next) = self.rows.iter().find(|row| {
                    row.origin == key
                        && row.garage != 0
                        && row.north() == a.north()
                        && row.open() == a.open()
                        && if direction == -1 {
                            row.garage <= current.garage
                        } else {
                            row.garage >= current.garage
                        }
                }) else {
                    break;
                };
                if next.id == b.id {
                    return true;
                }
                current = *next;
            }
            current = a;
        }
        false
    }
    fn square(&self, key: SquareKey) -> Option<Square> {
        self.squares.get(&key).copied()
    }
    // Query facts include current door sprites; obstruction keeps stored base facts.
    fn query_square(&self, key: SquareKey) -> Option<Square> {
        self.square(key).map(|mut square| {
            let facts = self.sprite_facts.get(&key).copied().unwrap_or(0);
            square.flags |= ((facts & 24) >> 2) | (facts & 32) | ((facts & 64) >> 3);
            square.interaction_properties |= (facts >> 7) as u16;
            square
        })
    }
    fn stand_edges(&self, key: SquareKey) -> u8 {
        self.square(key).map_or(0, |square| {
            square.window_edges
                | square.hoppable_edges
                | (self.sprite_facts.get(&key).copied().unwrap_or(0) as u8 & WALLS)
        })
    }
    fn source_edge_blocked(&self, key: SquareKey, north: bool) -> bool {
        let Some(square) = self.query_square(key) else {
            return false;
        };
        let (collide, window, blocked_window, door_edge) = if north {
            (2, 8, 32, NAV_WALL_NORTH)
        } else {
            (4, 16, 64, NAV_WALL_WEST)
        };
        let properties = square.interaction_properties;
        (properties & collide != 0 && properties & window == 0)
            || properties & blocked_window != 0
            || self.edges.get(&key).copied().unwrap_or(0) & door_edge != 0
    }
    fn source_neighbor_edge_blocked(&self, (x, y, z): SquareKey, north: bool) -> bool {
        // SOUTH/EAST look up the next square, not a second facing on this square.
        let x = x as i64 + i64::from(!north);
        let y = y as i64 + i64::from(north);
        match (i32::try_from(x), i32::try_from(y)) {
            (Ok(x), Ok(y)) => self.source_edge_blocked((x, y, z), north),
            _ => false,
        }
    }
    fn source_blocked_to(&self, from: SquareKey, to: SquareKey) -> bool {
        if from == to {
            return false;
        }
        let dx = from.0 as i64 - to.0 as i64;
        let dy = from.1 as i64 - to.1 as i64;
        // Source isEdgeElementTo tests both endpoint-facing edges, even far apart
        // or on different elevations. It does not trace the intermediate path.
        (dx > 0
            && (self.source_edge_blocked(from, false)
                || self.source_neighbor_edge_blocked(to, false)))
            || (dx < 0
                && (self.source_edge_blocked(to, false)
                    || self.source_neighbor_edge_blocked(from, false)))
            || (dy > 0
                && (self.source_edge_blocked(from, true)
                    || self.source_neighbor_edge_blocked(to, true)))
            || (dy < 0
                && (self.source_edge_blocked(to, true)
                    || self.source_neighbor_edge_blocked(from, true)))
            || self.query_square(from).is_some_and(|square| {
                (dx > 0 && square.interaction_properties & 256 != 0)
                    || (dy > 0 && square.interaction_properties & 128 != 0)
            })
    }
    fn can_stand(&self, (x, y, z): SquareKey, square: Square) -> bool {
        if square.flags & 2 != 0 {
            return false;
        }
        if square.flags & 4 != 0 {
            return self.stand_edges((x, y, z)) != 0
                || y.checked_add(1)
                    .is_some_and(|sy| self.stand_edges((x, sy, z)) & NAV_WALL_NORTH != 0)
                || x.checked_add(1)
                    .is_some_and(|sx| self.stand_edges((sx, y, z)) & NAV_WALL_WEST != 0);
        }
        square.flags & 32 != 0
    }
    fn something_to(&self, from: SquareKey, to: SquareKey) -> bool {
        let Some(a) = self.square(from) else {
            return false;
        };
        let Some(b) = self.square(to) else {
            return false;
        };
        let dx = to.0 - from.0;
        let dy = to.1 - from.1;
        let mut blocked = (b.walls | b.windows | b.door_walls)
            & (if dx > 0 { NAV_WALL_WEST } else { 0 } | if dy > 0 { NAV_WALL_NORTH } else { 0 })
            != 0;
        blocked |= (a.walls | a.windows | a.door_walls)
            & (if dx < 0 { NAV_WALL_WEST } else { 0 } | if dy < 0 { NAV_WALL_NORTH } else { 0 })
            != 0;
        for row in &self.rows {
            if row.open() {
                continue;
            }
            let (key, bit) = row.edge();
            blocked |= (key == to
                && ((dx > 0 && bit == NAV_WALL_WEST) || (dy > 0 && bit == NAV_WALL_NORTH)))
                || (key == from
                    && ((dx < 0 && bit == NAV_WALL_WEST) || (dy < 0 && bit == NAV_WALL_NORTH)));
        }
        blocked
    }
    fn obstructed(&self, door: Door) -> bool {
        if door.garage != 0 {
            return door.open()
                && self
                    .rows
                    .iter()
                    .filter(|row| self.coupled(door, **row))
                    .any(|row| self.square(row.position()).is_some_and(Square::vehicle));
        }
        if door.double == 0 {
            return self
                .square(door.position())
                .is_none_or(|square| square.solid() || square.vehicle());
        }
        let (x, y, z) = door.base();
        let first = self
            .rows
            .iter()
            .any(|row| row.double == 1 && self.coupled(door, *row));
        let last = self
            .rows
            .iter()
            .any(|row| row.double == 4 && self.coupled(door, *row));
        for (present, offset) in [(first, 0), (last, 2)] {
            if !present {
                continue;
            }
            let (left, top) = if door.north() {
                (x + offset, y)
            } else {
                (x, y - offset - 1)
            };
            let corners = [
                (left, top, z),
                (left + 1, top, z),
                (left + 1, top + 1, z),
                (left, top + 1, z),
            ];
            if corners
                .iter()
                .any(|key| self.square(*key).is_none_or(Square::solid))
                || corners[1..]
                    .iter()
                    .any(|key| self.something_to(corners[0], *key))
            {
                return true;
            }
        }
        let (min_x, min_y, max_x, max_y) = if door.north() {
            (
                x + if first { 0 } else { 2 },
                y,
                x + if last { 4 } else { 2 },
                y + 2,
            )
        } else {
            (
                x,
                y - if last { 3 } else { 1 },
                x + 2,
                y + if first { 1 } else { -1 },
            )
        };
        (min_x..max_x).any(|tx| {
            (min_y..max_y).any(|ty| self.square((tx, ty, z)).is_some_and(Square::vehicle))
        })
    }
}
struct DoorRestore {
    rows: Vec<Door>,
    revision: u32,
    seed: u32,
    rng: u64,
    houses: u32,
}
thread_local! {
    static DOORS: RefCell<Doors> = RefCell::new(Doors::new(1, 4));
    static STAGING: RefCell<Option<(Doors, bool)>> = const { RefCell::new(None) };
    static RESTORE: RefCell<Option<DoorRestore>> = const { RefCell::new(None) };
}
fn integer(value: f64, min: f64, max: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && (min..=max).contains(&value)
}
fn words() -> [f64; 12] {
    SCRATCH.with(|scratch| *scratch.borrow())
}
fn put(values: &[f64]) {
    SCRATCH.with(|scratch| scratch.borrow_mut()[..values.len()].copy_from_slice(values));
}
pub(super) fn flags(x: i32, y: i32, base: u8) -> u8 {
    DOORS.with(|state| {
        let state = state.borrow();
        let key = (x, y, 0);
        (base & !state.removed.get(&key).copied().unwrap_or(0))
            | state
                .squares
                .get(&key)
                .map_or(0, |square| square.walls | square.windows)
            | state.edges.get(&key).copied().unwrap_or(0)
    })
}
pub(super) fn reset() {
    DOORS.with(|state| *state.borrow_mut() = Doors::new(1, 4));
    door_import_abort();
    door_restore_abort();
}
#[unsafe(no_mangle)]
pub extern "C" fn door_import_begin(seed: u32, houses: u32, initialize: u32) -> i32 {
    if seed == 0 || !(1..=6).contains(&houses) || initialize > 1 {
        return OUT_OF_RANGE;
    }
    STAGING.with(|state| *state.borrow_mut() = Some((Doors::new(seed, houses), initialize != 0)));
    OK
}
#[unsafe(no_mangle)]
pub extern "C" fn door_import_abort() {
    STAGING.with(|state| *state.borrow_mut() = None);
}
#[unsafe(no_mangle)]
pub extern "C" fn door_import_stage() -> i32 {
    let w = words();
    if !integer(w[0], 1.0, u32::MAX as f64)
        || !integer(w[1], -25_600.0, 25_855.0)
        || !integer(w[2], -25_600.0, 25_855.0)
        || !integer(w[3], -32.0, 31.0)
        || !integer(w[4], 0.0, 2047.0)
        || !integer(w[5], -1.0, i32::MAX as f64)
        || !integer(w[6], -1.0, 9_007_199_254_740_991.0)
        || !integer(w[7], -1.0, 9_007_199_254_740_991.0)
        || !integer(w[8], 0.0, WALLS as f64)
        || w[8] as u8 & !WALLS != 0
        || !integer(w[9], 0.0, 4.0)
        || !integer(w[10], 0.0, 3.0)
        || !integer(w[11], 0.0, SPRITE_FACTS_MASK as f64)
        || w[11] as u32 & !SPRITE_FACTS_MASK != 0
        || (w[9] != 0.0 && w[10] != 0.0)
    {
        return BAD_FORMAT;
    }
    let door = Door {
        id: w[0] as u32,
        origin: (w[1] as i32, w[2] as i32, w[3] as i32),
        flags: w[4] as u32,
        key: w[5] as i32,
        room: w[6] as i64,
        opposite_room: w[7] as i64,
        walls: w[8] as u8,
        double: w[9] as u32,
        garage: w[10] as u32,
        sprite_facts: w[11] as u32,
        interaction_properties: [0; 4],
    };
    STAGING.with(|state| {
        let mut state = state.borrow_mut();
        let Some((state, _)) = state.as_mut() else {
            return BAD_FORMAT;
        };
        if state.rows.len() >= LIMIT || state.rows.iter().any(|row| row.id == door.id) {
            return BAD_FORMAT;
        }
        state.rows.push(door);
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn door_import_interaction_properties(
    id: u32,
    initial_closed: u32,
    initial_open: u32,
    toggled_closed: u32,
    toggled_open: u32,
) -> i32 {
    let properties = [initial_closed, initial_open, toggled_closed, toggled_open];
    if id == 0
        || properties
            .iter()
            .any(|mask| mask & !DOOR_INTERACTION_PROPERTIES_MASK != 0)
    {
        return BAD_FORMAT;
    }
    STAGING.with(|state| {
        let mut state = state.borrow_mut();
        let Some((state, _)) = state.as_mut() else {
            return BAD_FORMAT;
        };
        let Some(door) = state.rows.iter_mut().find(|row| row.id == id) else {
            return BAD_FORMAT;
        };
        door.interaction_properties = properties.map(|mask| mask as u16);
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn door_square_stage() -> i32 {
    let w = words();
    if !integer(w[0], -25_600.0, 25_855.0)
        || !integer(w[1], -25_600.0, 25_855.0)
        || !integer(w[2], -32.0, 31.0)
        || !integer(w[3], -1.0, 9_007_199_254_740_991.0)
        || !integer(w[4], 0.0, 63.0)
        || w[5..10]
            .iter()
            .any(|v| !integer(*v, 0.0, WALLS as f64) || *v as u8 & !WALLS != 0)
        || !integer(w[10], 0.0, INTERACTION_PROPERTIES_MASK as f64)
        || w[10] as u32 & !INTERACTION_PROPERTIES_MASK != 0
        || w[11] != 0.0
    {
        return BAD_FORMAT;
    }
    STAGING.with(|state| {
        let mut state = state.borrow_mut();
        let Some((state, _)) = state.as_mut() else {
            return BAD_FORMAT;
        };
        let key = (w[0] as i32, w[1] as i32, w[2] as i32);
        if state.squares.len() >= 1_048_576 || state.squares.contains_key(&key) {
            return BAD_FORMAT;
        }
        state.squares.insert(
            key,
            Square {
                room: w[3] as i64,
                flags: w[4] as u32,
                walls: w[5] as u8,
                windows: w[6] as u8,
                door_walls: w[7] as u8,
                hoppable_edges: w[8] as u8,
                window_edges: w[9] as u8,
                interaction_properties: w[10] as u16,
            },
        );
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn door_import_commit() -> i32 {
    STAGING.with(|stage| {
        let Some((mut state, initialize)) = stage.borrow_mut().take() else {
            return BAD_FORMAT;
        };
        for door in &state.rows {
            let closed = Door {
                flags: door.flags & !OPEN,
                ..*door
            };
            let (key, bit) = closed.edge();
            *state.removed.entry(key).or_default() |= bit;
            // Remove the supplied initial sprite's collision contribution only;
            // genuinely independent walls are reinstated from source squares.
            let (key, bit) = door.sprite_edge();
            *state.removed.entry(key).or_default() |= bit;
            if let Some(square) = state.squares.get_mut(&door.origin) {
                square.walls |= door.walls;
            } else if door.origin.2 == 0 {
                return BAD_FORMAT;
            }
            if door.origin.2 == 0 {
                let (x, y, z) = door.position();
                if !state.squares.contains_key(&(x, y, z)) {
                    return BAD_FORMAT;
                }
                let opposite = if door.north() {
                    (x, y - 1, z)
                } else {
                    (x - 1, y, z)
                };
                if !state.squares.contains_key(&opposite) {
                    return BAD_FORMAT;
                }
            }
        }
        if initialize {
            state.initialize();
        }
        state.rebuild();
        DOORS.with(|live| *live.borrow_mut() = state);
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn square_read(x: i32, y: i32, z: i32) -> i32 {
    DOORS.with(|state| {
        let state = state.borrow();
        let key = (x, y, z);
        let Some(square) = state.query_square(key) else {
            return OUT_OF_RANGE;
        };
        put(&[
            x as f64,
            y as f64,
            z as f64,
            square.room as f64,
            square.flags as f64,
            if state.can_stand(key, square) {
                1.0
            } else {
                0.0
            },
        ]);
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn square_blocked_to(
    from_x: i32,
    from_y: i32,
    from_z: i32,
    to_x: i32,
    to_y: i32,
    to_z: i32,
    has_to: u32,
) -> i32 {
    if has_to > 1 {
        return OUT_OF_RANGE;
    }
    DOORS.with(|state| {
        let state = state.borrow();
        let from = (from_x, from_y, from_z);
        if state.square(from).is_none() {
            return OUT_OF_RANGE;
        }
        let to = (to_x, to_y, to_z);
        if has_to == 0 || state.square(to).is_none() {
            return 0;
        }
        i32::from(state.source_blocked_to(from, to))
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn door_count() -> u32 {
    DOORS.with(|state| state.borrow().rows.len() as u32)
}
#[unsafe(no_mangle)]
pub extern "C" fn door_read(index: u32) -> i32 {
    DOORS.with(|state| {
        let state = state.borrow();
        let Some(row) = state.rows.get(index as usize) else {
            return OUT_OF_RANGE;
        };
        let (x, y, z) = row.position();
        put(&[
            row.id as f64,
            x as f64,
            y as f64,
            z as f64,
            row.flags as f64,
            row.key as f64,
            row.room as f64,
            row.opposite_room as f64,
            row.walls as f64,
            row.double as f64,
            row.garage as f64,
            0.0,
        ]);
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn door_header_read() {
    DOORS.with(|state| {
        let state = state.borrow();
        put(&[
            state.revision as f64,
            state.seed as f64,
            state.rng as u32 as f64,
            (state.rng >> 32) as u32 as f64,
            state.houses as f64,
        ]);
    });
}
#[unsafe(no_mangle)]
pub extern "C" fn door_toggle(id: u32) -> i32 {
    let (ax, ay) = ENGINE.with(|engine| {
        let engine = engine.borrow();
        (engine.x, engine.y)
    });
    DOORS.with(|state| {
        let mut state = state.borrow_mut();
        let Some(door) = state.rows.iter().find(|row| row.id == id).copied() else {
            return OUT_OF_RANGE;
        };
        let (x, y, z) = door.position();
        let actor = (ax.floor() as i32, ay.floor() as i32, 0);
        if z != 0 || (actor.0 - x).abs() > 1 || (actor.1 - y).abs() > 1 {
            return OUT_OF_RANGE;
        }
        let Some(square) = state.square(actor) else {
            return OUT_OF_RANGE;
        };
        // Reach never passes an independent wall or a different door. The
        // target's own portal/wing is deliberately not a reach obstruction.
        for (from, to) in [
            (actor, (x, actor.1, z)),
            ((x, actor.1, z), (x, y, z)),
            (actor, (actor.0, y, z)),
            ((actor.0, y, z), (x, y, z)),
        ] {
            if from == to {
                continue;
            }
            let Some(a) = state.square(from) else {
                return OUT_OF_RANGE;
            };
            let Some(b) = state.square(to) else {
                return OUT_OF_RANGE;
            };
            let bit = if from.0 == to.0 {
                NAV_WALL_NORTH
            } else {
                NAV_WALL_WEST
            };
            let wall_square = if to.0 > from.0 || to.1 > from.1 { b } else { a };
            let wall_key = if to.0 > from.0 || to.1 > from.1 {
                to
            } else {
                from
            };
            if (wall_square.walls | wall_square.windows) & bit != 0
                || b.solid()
                || state
                    .rows
                    .iter()
                    .any(|row| row.id != id && row.blocked() && row.edge() == (wall_key, bit))
            {
                return BLOCKED;
            }
        }
        if door.flags & BARRICADED != 0 || state.obstructed(door) {
            return BLOCKED;
        }
        let opposite = if door.north() {
            (x, y - 1, z)
        } else {
            (x - 1, y, z)
        };
        let room = state.square((x, y, z)).map_or(door.room, |s| s.room);
        let other = state
            .square(opposite)
            .map_or(door.opposite_room, |s| s.room);
        let hoppable = !door.open() && door.flags & HOPPABLE != 0;
        let inside = square.flags & 1 == 0
            && (square.room == room || square.room == other)
            && door.flags & FORCE == 0;
        let keyed = door.flags & (KEY_LOCKED | CUSTOM_LOCK) != 0
            || (door.flags & LOCKED != 0 && door.key != -1);
        if !door.open() && !inside && !hoppable {
            // No native inventory Key objects exist yet: fail closed, never
            // synthesize a key or clear locks on a rejected interaction.
            if keyed {
                return BLOCKED;
            }
            let garage_side = door.garage != 0
                && ((if door.north() {
                    ay >= y as f32
                } else {
                    ax >= x as f32
                }) == (door.flags & INTERIOR != 0));
            if door.flags & LOCKED != 0 && !garage_side {
                return BLOCKED;
            }
        }
        if state.revision == u32::MAX {
            return OUT_OF_RANGE;
        }
        // Validate every coupled panel before mutating any of them.
        if state
            .rows
            .iter()
            .filter(|row| state.coupled(door, **row))
            .any(|row| {
                row.flags & BARRICADED != 0
                    || state.square(row.position()).is_none()
                    || state
                        .square(
                            Door {
                                flags: row.flags ^ OPEN,
                                ..*row
                            }
                            .position(),
                        )
                        .is_none()
            })
        {
            return BLOCKED;
        }
        for i in 0..state.rows.len() {
            if state.coupled(door, state.rows[i]) {
                state.rows[i].flags |= SELECTED;
            }
        }
        for row in &mut state.rows {
            if row.flags & SELECTED == 0 {
                continue;
            }
            row.flags ^= OPEN;
            row.flags |= TOGGLED;
            // Native setLockedByKey(false) also calls setIsLocked(false).
            row.flags &= !(SELECTED | KEY_LOCKED | LOCKED);
        }
        state.revision += 1;
        state.rebuild();
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn door_restore_begin(
    revision: u32,
    seed: u32,
    lo: u32,
    hi: u32,
    houses: u32,
) -> i32 {
    if seed == 0 || !(1..=6).contains(&houses) {
        return OUT_OF_RANGE;
    }
    RESTORE.with(|state| {
        *state.borrow_mut() = Some(DoorRestore {
            rows: Vec::new(),
            revision,
            seed,
            rng: (hi as u64) << 32 | lo as u64,
            houses,
        })
    });
    OK
}
#[unsafe(no_mangle)]
pub extern "C" fn door_restore_abort() {
    RESTORE.with(|state| *state.borrow_mut() = None);
}
#[unsafe(no_mangle)]
pub extern "C" fn door_restore_stage() -> i32 {
    let w = words();
    if !integer(w[0], 1.0, u32::MAX as f64)
        || !integer(w[1], 0.0, 1.0)
        || !integer(w[2], 0.0, 1.0)
        || !integer(w[3], 0.0, 1.0)
        || !integer(w[4], -1.0, i32::MAX as f64)
        || !integer(w[8], 0.0, 1.0)
        || w[9..].iter().any(|v| *v != 0.0)
    {
        return BAD_FORMAT;
    }
    let row = DOORS.with(|state| {
        state
            .borrow()
            .rows
            .iter()
            .find(|row| row.id == w[0] as u32)
            .copied()
    });
    let Some(mut row) = row else {
        return BAD_FORMAT;
    };
    row.flags = (row.flags & !(OPEN | LOCKED | KEY_LOCKED | TOGGLED))
        | if w[1] == 1.0 { OPEN } else { 0 }
        | if w[2] == 1.0 { LOCKED } else { 0 }
        | if w[3] == 1.0 { KEY_LOCKED } else { 0 }
        | if w[8] == 1.0 { TOGGLED } else { 0 };
    row.key = w[4] as i32;
    let (x, y, z) = row.position();
    if w[5] != x as f64 || w[6] != y as f64 || w[7] != z as f64 {
        return BAD_FORMAT;
    }
    RESTORE.with(|state| {
        let mut state = state.borrow_mut();
        let Some(state) = state.as_mut() else {
            return BAD_FORMAT;
        };
        if state.rows.iter().any(|old| old.id == row.id) {
            return BAD_FORMAT;
        }
        state.rows.push(row);
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn door_restore_commit() -> i32 {
    RESTORE.with(|restore| {
        let Some(DoorRestore {
            rows,
            revision,
            seed,
            rng,
            houses,
        }) = restore.borrow_mut().take()
        else {
            return BAD_FORMAT;
        };
        DOORS.with(|state| {
            let mut state = state.borrow_mut();
            if rows.len() != state.rows.len()
                || rows.iter().any(|row| {
                    !state.rows.iter().any(|old| old.id == row.id)
                        || (row.origin.2 == 0 && !state.squares.contains_key(&row.position()))
                })
            {
                return BAD_FORMAT;
            }
            for row in rows {
                let target = state.rows.iter_mut().find(|old| old.id == row.id).unwrap();
                *target = row;
            }
            state.revision = revision;
            state.seed = seed;
            state.rng = rng;
            state.houses = houses;
            state.rebuild();
            OK
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stage_square((x, y, z): SquareKey, properties: f64) -> i32 {
        put(&[
            x as f64, y as f64, z as f64, -1.0, 32.0, 0.0, 0.0, 0.0, 0.0, 0.0, properties, 0.0,
        ]);
        door_square_stage()
    }

    fn import_squares(squares: &[(SquareKey, u16)]) {
        reset();
        assert_eq!(door_import_begin(1, 1, 0), OK);
        for &(key, properties) in squares {
            assert_eq!(stage_square(key, properties as f64), OK);
        }
        assert_eq!(door_import_commit(), OK);
    }

    fn blocked(from: SquareKey, to: SquareKey) -> i32 {
        square_blocked_to(from.0, from.1, from.2, to.0, to.1, to.2, 1)
    }

    #[test]
    fn source_wall_excludes_only_raw_window_and_actual_window_blocks_independently() {
        for (properties, expected) in [
            (0, 0),
            (4, 1),
            (16, 0),
            (4 | 16, 0),
            (64, 1),
            (4 | 16 | 64, 1),
        ] {
            import_squares(&[((0, 0, 0), 0), ((1, 0, 0), properties)]);
            assert_eq!(blocked((0, 0, 0), (1, 0, 0)), expected);
            assert_eq!(blocked((1, 0, 0), (0, 0, 0)), expected);
            assert_eq!(square_read(1, 0, 0), OK);
            assert_eq!(&words()[..6], &[1.0, 0.0, 0.0, -1.0, 32.0, 1.0]);
            assert_eq!(flags(1, 0, 0), 0);
        }
        for (properties, expected) in [(2, 1), (2 | 8, 0), (32, 1)] {
            import_squares(&[((0, 0, 0), 0), ((0, 1, 0), properties)]);
            assert_eq!(blocked((0, 0, 0), (0, 1, 0)), expected);
            assert_eq!(blocked((0, 1, 0), (0, 0, 0)), expected);
        }
    }

    #[test]
    fn source_relation_checks_both_endpoint_edges_and_their_east_south_neighbors() {
        // A distant diagonal still tests each endpoint, not intermediate path squares.
        for (endpoint, neighbor) in [(4, 0), (0, 4)] {
            import_squares(&[((0, 0, 0), 0), ((3, 3, 0), endpoint), ((1, 0, 0), neighbor)]);
            assert_eq!(blocked((0, 0, 0), (3, 3, 0)), 1);
            assert_eq!(blocked((3, 3, 0), (0, 0, 0)), 1);
        }
        import_squares(&[((0, 0, 0), 0), ((3, 3, 0), 0), ((0, 1, 0), 32)]);
        assert_eq!(blocked((0, 0, 0), (3, 3, 0)), 1);
        assert_eq!(blocked((3, 3, 0), (0, 0, 0)), 1);
        import_squares(&[((0, 0, 0), 0), ((3, 3, 0), 0), ((2, 2, 0), 6)]);
        assert_eq!(blocked((0, 0, 0), (3, 3, 0)), 0);
        import_squares(&[((0, 0, 0), 0), ((3, 0, 1), 4)]);
        assert_eq!(blocked((0, 0, 0), (3, 0, 1)), 1);
    }

    #[test]
    fn source_relation_does_not_infer_properties_from_legacy_collision_or_stand_edges() {
        reset();
        assert_eq!(door_import_begin(1, 1, 0), OK);
        assert_eq!(stage_square((0, 0, 0), 0.0), OK);
        put(&[
            1.0,
            1.0,
            0.0,
            -1.0,
            32.0,
            WALLS as f64,
            WALLS as f64,
            WALLS as f64,
            WALLS as f64,
            WALLS as f64,
            0.0,
            0.0,
        ]);
        assert_eq!(door_square_stage(), OK);
        assert_eq!(door_import_commit(), OK);
        assert_eq!(blocked((0, 0, 0), (1, 1, 0)), 0);
        assert_eq!(blocked((1, 1, 0), (0, 0, 0)), 0);
        assert_eq!(flags(1, 1, 0), WALLS);
    }

    #[test]
    fn source_stairs_are_directional_and_null_other_does_not_hide_missing_from() {
        import_squares(&[((0, 0, 0), 0), ((1, 0, 0), 256), ((0, 1, 0), 128)]);
        assert_eq!(blocked((1, 0, 0), (0, 0, 0)), 1);
        assert_eq!(blocked((0, 0, 0), (1, 0, 0)), 0);
        assert_eq!(blocked((0, 1, 0), (0, 0, 0)), 1);
        assert_eq!(blocked((0, 0, 0), (0, 1, 0)), 0);
        assert_eq!(blocked((1, 0, 0), (1, 0, 0)), 0);
        assert_eq!(blocked((1, 0, 0), (i32::MIN, i32::MAX, i32::MAX)), 0);
        assert_eq!(square_blocked_to(1, 0, 0, 0, 0, 0, 0), 0);
        assert_eq!(square_blocked_to(9, 9, 0, 0, 0, 0, 0), OUT_OF_RANGE);
        assert_eq!(square_blocked_to(0, 0, 0, 0, 0, 0, 2), OUT_OF_RANGE);
        assert_eq!(blocked((0, 0, i32::MAX), (0, 0, 0)), OUT_OF_RANGE);
    }

    #[test]
    fn source_edge_offsets_do_not_wrap_extreme_signed_coordinates() {
        import_squares(&[((0, 0, 0), 0)]);
        DOORS.with(|state| {
            let mut state = state.borrow_mut();
            let square = state.squares[&(0, 0, 0)];
            state.squares.insert(
                (i32::MIN, 0, 0),
                Square {
                    interaction_properties: 4,
                    ..square
                },
            );
            state.squares.insert((i32::MAX, 0, 0), square);
            state.squares.insert(
                (0, i32::MIN, 0),
                Square {
                    interaction_properties: 2,
                    ..square
                },
            );
            state.squares.insert((0, i32::MAX, 0), square);
        });
        assert_eq!(blocked((i32::MIN, 0, 0), (i32::MAX, 0, 0)), 0);
        assert_eq!(blocked((0, i32::MIN, 0), (0, i32::MAX, 0)), 0);
    }

    fn stage_door(flags: u32, double: u32) {
        put(&[
            1.0,
            0.0,
            0.0,
            0.0,
            flags as f64,
            -1.0,
            -1.0,
            -1.0,
            0.0,
            double as f64,
            0.0,
            0.0,
        ]);
        assert_eq!(door_import_stage(), OK);
    }

    #[test]
    fn source_door_current_snapshots_toggle_restore_and_reset_without_metadata_in_save() {
        reset();
        assert_eq!(door_import_begin(1, 1, 0), OK);
        for key in [(0, 0, 0), (0, -1, 0), (-1, 0, 0)] {
            assert_eq!(stage_square(key, 0.0), OK);
        }
        stage_door(NORTH, 0);
        assert_eq!(door_import_interaction_properties(1, 4, 0, 0, 4), OK);
        assert_eq!(door_import_commit(), OK);
        ENGINE.with(|engine| {
            let mut engine = engine.borrow_mut();
            engine.x = 0.5;
            engine.y = 0.5;
        });
        assert_eq!(blocked((0, 0, 0), (0, -1, 0)), 1);
        assert_eq!(blocked((0, 0, 0), (-1, 0, 0)), 1);
        assert_eq!(door_toggle(1), OK);
        assert_eq!(blocked((0, 0, 0), (0, -1, 0)), 0);
        assert_eq!(blocked((0, 0, 0), (-1, 0, 0)), 1);
        assert_eq!(door_toggle(1), OK);
        assert_eq!(blocked((0, 0, 0), (0, -1, 0)), 1);
        assert_eq!(blocked((0, 0, 0), (-1, 0, 0)), 0);
        assert_eq!(door_restore_begin(9, 1, 1, 0, 1), OK);
        put(&[1.0, 1.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
        assert_eq!(door_restore_stage(), OK);
        assert_eq!(door_restore_commit(), OK);
        assert_eq!(blocked((0, 0, 0), (0, -1, 0)), 0);
        assert_eq!(blocked((0, 0, 0), (-1, 0, 0)), 0);
        reset();
        assert_eq!(blocked((0, 0, 0), (-1, 0, 0)), OUT_OF_RANGE);
    }

    #[test]
    fn source_current_door_properties_union_with_base_and_remove_stale_sprite_flags() {
        reset();
        assert_eq!(door_import_begin(1, 1, 0), OK);
        assert_eq!(stage_square((0, 0, 0), 4.0), OK);
        for key in [(0, -1, 0), (-1, 0, 0)] {
            assert_eq!(stage_square(key, 0.0), OK);
        }
        stage_door(NORTH | OPEN, 0);
        assert_eq!(door_import_interaction_properties(1, 0, 16, 0, 0), OK);
        assert_eq!(door_import_commit(), OK);
        ENGINE.with(|engine| {
            let mut engine = engine.borrow_mut();
            engine.x = 0.5;
            engine.y = 0.5;
        });
        assert_eq!(blocked((0, 0, 0), (-1, 0, 0)), 0);
        assert_eq!(door_toggle(1), OK);
        assert_eq!(blocked((0, 0, 0), (-1, 0, 0)), 1);
        assert_eq!(door_toggle(1), OK);
        assert_eq!(blocked((0, 0, 0), (-1, 0, 0)), 1);
    }

    #[test]
    fn source_barricaded_open_double_panel_blocks_at_current_position_not_origin() {
        reset();
        assert_eq!(door_import_begin(1, 1, 0), OK);
        for key in [(0, 0, 0), (-1, 0, 0), (-1, 1, 0), (0, -1, 0)] {
            assert_eq!(stage_square(key, 0.0), OK);
        }
        stage_door(NORTH | OPEN | BARRICADED, 2);
        assert_eq!(door_import_commit(), OK);
        assert_eq!(blocked((-1, 1, 0), (-1, 0, 0)), 1);
        assert_eq!(blocked((0, 0, 0), (0, -1, 0)), 0);
    }

    #[test]
    fn source_metadata_staging_refusals_leave_live_and_previous_staged_facts_unchanged() {
        import_squares(&[((0, 0, 0), 0), ((1, 0, 0), 4)]);
        assert_eq!(
            door_import_interaction_properties(1, 0, 0, 0, 0),
            BAD_FORMAT
        );
        assert_eq!(door_import_begin(1, 1, 0), OK);
        assert_eq!(stage_square((0, 0, 0), 0.0), OK);
        assert_eq!(stage_square((1, 0, 0), 0.0), OK);
        for mask in [1.0, 512.0, -2.0, 2.5, f64::NAN] {
            assert_eq!(stage_square((2, 0, 0), mask), BAD_FORMAT);
            assert_eq!(blocked((0, 0, 0), (1, 0, 0)), 1);
        }
        put(&[2.0, 0.0, 0.0, -1.0, 32.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0]);
        assert_eq!(door_square_stage(), BAD_FORMAT);
        stage_door(0, 0);
        assert_eq!(door_import_interaction_properties(1, 4, 0, 4, 0), OK);
        for (id, masks) in [
            (0, [0, 0, 0, 0]),
            (2, [0, 0, 0, 0]),
            (1, [0, 0, 0, 1]),
            (1, [0, 32, 0, 0]),
            (1, [0, 0, 64, 0]),
            (1, [512, 0, 0, 0]),
        ] {
            assert_eq!(
                door_import_interaction_properties(id, masks[0], masks[1], masks[2], masks[3]),
                BAD_FORMAT
            );
            assert_eq!(blocked((0, 0, 0), (1, 0, 0)), 1);
        }
        assert_eq!(door_import_commit(), BAD_FORMAT); // Missing west opposite square.
        assert_eq!(blocked((0, 0, 0), (1, 0, 0)), 1);
        assert_eq!(door_import_begin(1, 1, 0), OK);
        for key in [(0, 0, 0), (-1, 0, 0), (0, -1, 0)] {
            assert_eq!(stage_square(key, 0.0), OK);
        }
        stage_door(NORTH | OPEN, 0);
        assert_eq!(door_import_interaction_properties(1, 0, 4, 0, 0), OK);
        assert_eq!(
            door_import_interaction_properties(1, 0, 0, 0, 32),
            BAD_FORMAT
        );
        assert_eq!(door_import_commit(), OK);
        assert_eq!(blocked((0, 0, 0), (-1, 0, 0)), 1);
        // Re-import with omitted snapshots establishes empty facts, not old facts.
        assert_eq!(door_import_begin(1, 1, 0), OK);
        for key in [(0, 0, 0), (-1, 0, 0), (0, -1, 0)] {
            assert_eq!(stage_square(key, 0.0), OK);
        }
        stage_door(NORTH | OPEN, 0);
        assert_eq!(door_import_commit(), OK);
        assert_eq!(blocked((0, 0, 0), (-1, 0, 0)), 0);
    }
}
