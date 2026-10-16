//! Optional door extension. Source geometry is re-imported before saved state.
//! Actor elevation is currently zero; no key objects or vehicles are simulated.
use super::{
    BAD_FORMAT, BLOCKED, ENGINE, NAV_WALL_NORTH, NAV_WALL_WEST, OK, OUT_OF_RANGE, SCRATCH,
};
use std::{
    cell::{Cell, RefCell},
    collections::{HashMap, HashSet},
};

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
const REACH_UNKNOWN: u32 = 1 << 19;

const RAIN_SHIFT: u32 = 20;
const RAIN_UNKNOWN: u8 = 4;
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
    reach_properties: [u8; 4],
    reach_known: bool,
    rain_blockers: [u8; 4],
    rain_known: bool,
    has_curtain: bool,
    curtain_open: bool,
    curtain_inside: bool,
    curtain_capabilities: u8,
    curtain_known: bool,
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
    fn reach_properties(self) -> u8 {
        self.reach_properties
            [if self.flags & TOGGLED != 0 { 2 } else { 0 } + usize::from(self.open())]
    }
    fn rain_blockers(self) -> u8 {
        self.rain_blockers[if self.flags & TOGGLED != 0 { 2 } else { 0 } + usize::from(self.open())]
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
    reach_walls: u8,
    reach_known: bool,
    floor: Option<Floor>,
    rain_blockers: u8,
    have_roof: Option<bool>,
}
impl Square {
    fn solid(self) -> bool {
        self.flags & (2 | 4 | 8) != 0
    }
    fn vehicle(self) -> bool {
        self.flags & 16 != 0
    }
}
#[derive(Clone, Copy, PartialEq)]
struct Floor {
    flags: u32,
    stairs: u32,
    direction: u32,
    min: f32,
    max: f32,
}
struct Doors {
    rows: Vec<Door>,
    squares: HashMap<SquareKey, Square>,
    roof_columns: HashSet<(i32, i32)>,
    rain_version: bool,
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
            roof_columns: HashSet::new(),
            rain_version: false,
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
            let reach = if door.reach_known {
                (door.reach_properties() as u32) << 16
            } else {
                REACH_UNKNOWN
            };
            let sprite_facts = door.sprite_facts() as u32
                | ((door.interaction_properties() as u32) << 7)
                | reach
                | ((door.rain_blockers() as u32) << RAIN_SHIFT);
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
    fn rebuild_roof_column(
        squares: &mut HashMap<SquareKey, Square>,
        sprite_facts: &HashMap<SquareKey, u32>,
        x: i32,
        y: i32,
    ) {
        let mut roof = Some(false);
        for z in (0..=31).rev() {
            let key = (x, y, z);
            let Some(square) = squares.get_mut(&key) else {
                continue;
            };
            square.have_roof = roof;
            let blockers = square.rain_blockers
                | ((sprite_facts.get(&key).copied().unwrap_or(0) >> RAIN_SHIFT) as u8);
            if blockers & 3 != 0 {
                roof = Some(true);
            } else if blockers & RAIN_UNKNOWN != 0 && roof != Some(true) {
                roof = None;
            }
        }
    }
    fn rebuild_roofs(&mut self) {
        for &(x, y) in &self.roof_columns {
            Self::rebuild_roof_column(&mut self.squares, &self.sprite_facts, x, y);
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
            square.interaction_properties |= ((facts >> 7) & INTERACTION_PROPERTIES_MASK) as u16;
            square.reach_walls |= ((facts >> 16) as u8) & WALLS;
            square.reach_known &= facts & REACH_UNKNOWN == 0;
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
    fn source_edge_relation(&self, key: SquareKey, north: bool, parts: u8) -> bool {
        let Some(square) = self.query_square(key) else {
            return false;
        };
        let (collide, window, blocked_window, door_edge) = if north {
            (2, 8, 32, NAV_WALL_NORTH)
        } else {
            (4, 16, 64, NAV_WALL_WEST)
        };
        let properties = square.interaction_properties;
        (parts & 1 != 0 && properties & collide != 0 && properties & window == 0)
            || (parts & 2 != 0 && properties & blocked_window != 0)
            || (parts & 4 != 0 && self.edges.get(&key).copied().unwrap_or(0) & door_edge != 0)
    }
    fn source_blocked_to(&self, from: SquareKey, to: SquareKey) -> bool {
        self.source_relation_to(from, to, false)
    }
    fn source_relation_to(&self, from: SquareKey, to: SquareKey, wall_only: bool) -> bool {
        self.source_relation_parts(from, to, if wall_only { 1 } else { 15 })
    }
    fn source_relation_parts(&self, from: SquareKey, to: SquareKey, parts: u8) -> bool {
        if from == to {
            return false;
        }
        let dx = from.0 as i64 - to.0 as i64;
        let dy = from.1 as i64 - to.1 as i64;
        // Source isEdgeElementTo tests both endpoint-facing edges, even far apart
        // or on different elevations. It does not trace the intermediate path.
        let edge = |key, north| self.source_edge_relation(key, north, parts);
        let next = |(x, y, z): SquareKey, north: bool| match (
            x.checked_add(i32::from(!north)),
            y.checked_add(i32::from(north)),
        ) {
            (Some(x), Some(y)) => edge((x, y, z), north),
            _ => false,
        };
        (dx > 0 && (edge(from, false) || next(to, false)))
            || (dx < 0 && (edge(to, false) || next(from, false)))
            || (dy > 0 && (edge(from, true) || next(to, true)))
            || (dy < 0 && (edge(to, true) || next(from, true)))
            || (parts & 8 != 0
                && self.query_square(from).is_some_and(|square| {
                    (dx > 0 && square.interaction_properties & 256 != 0)
                        || (dy > 0 && square.interaction_properties & 128 != 0)
                }))
    }
    fn can_reach(&self, from: SquareKey, to: SquareKey) -> Result<bool, i32> {
        if from == to {
            return Ok(true);
        }
        let dx = to.0 as i64 - from.0 as i64;
        let dy = to.1 as i64 - from.1 as i64;
        if from.2 != to.2 || dx.abs() > 1 || dy.abs() > 1 {
            return Ok(false);
        }
        if self.squares.is_empty() && !super::world_extents().0 {
            return Ok(
                super::item_position_valid(from.0 as f64 + 0.5, from.1 as f64 + 0.5)
                    && super::item_position_valid(to.0 as f64 + 0.5, to.1 as f64 + 0.5),
            );
        }
        let a = self.query_square(from).ok_or(OUT_OF_RANGE)?;
        let b = self.query_square(to).ok_or(OUT_OF_RANGE)?;
        // Original windows/doors reject before getWallExcludingList's object query.
        if self.source_relation_parts(from, to, 6) {
            return Ok(false);
        }
        for (needed, square, bit) in [
            (dy != 0, if dy < 0 { a } else { b }, NAV_WALL_NORTH),
            (dx != 0, if dx < 0 { a } else { b }, NAV_WALL_WEST),
        ] {
            if needed {
                if !square.reach_known {
                    return Err(OUT_OF_RANGE);
                }
                if square.reach_walls & bit != 0 {
                    return Ok(false);
                }
            }
        }
        Ok(!self.source_relation_parts(from, to, 9))
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
    fn can_be_open_from_inside(&self, door: Door, actor: SquareKey) -> Result<bool, i32> {
        let actor = self.square(actor).ok_or(OUT_OF_RANGE)?;
        if actor.flags & 1 != 0 || door.flags & FORCE != 0 {
            return Ok(false);
        }
        let (x, y, z) = door.position();
        let room = self.square((x, y, z)).ok_or(OUT_OF_RANGE)?.room;
        if actor.room == room {
            return Ok(true);
        }
        let opposite = if door.north() {
            (x, y - 1, z)
        } else {
            (x - 1, y, z)
        };
        Ok(actor.room == self.square(opposite).ok_or(OUT_OF_RANGE)?.room)
    }
    fn could_be_open(&self, door: Door, actor: SquareKey) -> Result<bool, i32> {
        // The standalone actor is the supported IsoPlayer, never an IsoAnimal.
        // Source MENU permission is not the stricter ToggleDoorActual commit guard.
        if door.flags & BARRICADED != 0 {
            return Ok(false);
        }
        if self.can_be_open_from_inside(door, actor)? {
            return Ok(true); // Original inside permission precedes obstruction.
        }
        if door.flags & (KEY_LOCKED | CUSTOM_LOCK) != 0 {
            // Native Key identity/ownership and the cheat-unlock branch are not
            // supported; do not manufacture an empty source key inventory.
            return Err(OUT_OF_RANGE);
        }
        // Plain locked and forceLocked alone are not source MENU exclusions.
        // Tutorial's final exclusion is keyed, already unsupported above.
        Ok(!self.obstructed(door))
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
    fn door_reach(&self, id: u32, actor: SquareKey, target: SquareKey) -> i32 {
        let (x, y, z) = target;
        if actor.2 != z
            || (actor.0 as i64 - x as i64).abs() > 1
            || (actor.1 as i64 - y as i64).abs() > 1
            || self.square(actor).is_none()
        {
            return OUT_OF_RANGE;
        }
        for (from, to) in [
            (actor, (x, actor.1, z)),
            ((x, actor.1, z), target),
            (actor, (actor.0, y, z)),
            ((actor.0, y, z), target),
        ] {
            if from == to {
                continue;
            }
            let (Some(a), Some(b)) = (self.square(from), self.square(to)) else {
                return OUT_OF_RANGE;
            };
            let bit = if from.0 == to.0 {
                NAV_WALL_NORTH
            } else {
                NAV_WALL_WEST
            };
            let (wall_square, wall_key) = if to.0 > from.0 || to.1 > from.1 {
                (b, to)
            } else {
                (a, from)
            };
            if (wall_square.walls | wall_square.windows) & bit != 0
                || b.solid()
                || self
                    .rows
                    .iter()
                    .any(|row| row.id != id && row.blocked() && row.edge() == (wall_key, bit))
            {
                return BLOCKED;
            }
        }
        OK
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
    static SOURCE_CHUNK_GENERATION: Cell<u32> = const { Cell::new(1) };
}
pub(super) fn rng_state() -> u64 {
    DOORS.with(|state| state.borrow().rng)
}
pub(super) fn restore_rng(state: u64) {
    DOORS.with(|doors| doors.borrow_mut().rng = state);
}
pub(super) fn random(bound: u64) -> u64 {
    DOORS.with(|state| state.borrow_mut().random(bound))
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
pub(super) fn has_square(x: i32, y: i32, z: i32) -> bool {
    DOORS.with(|state| state.borrow().squares.contains_key(&(x, y, z)))
}
/// Derived source roof authority exists only for resident source z31..0 columns.
pub(crate) fn source_have_roof(x: i32, y: i32, z: i32) -> Result<bool, ()> {
    DOORS.with(|state| {
        state
            .borrow()
            .squares
            .get(&(x, y, z))
            .and_then(|square| square.have_roof)
            .ok_or(())
    })
}
fn retire_source_chunks() {
    SOURCE_CHUNK_GENERATION.with(|generation| {
        generation.set(
            generation
                .get()
                .checked_add(1)
                .expect("source chunk generation exhausted"),
        );
    });
}
pub(super) fn reset() {
    DOORS.with(|state| *state.borrow_mut() = Doors::new(1, 4));
    retire_source_chunks();
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
/// Opt into blocker metadata before staging any geometry; legacy reserved zero is unknown.
#[unsafe(no_mangle)]
pub extern "C" fn door_import_rain_blockers_version(version: u32) -> i32 {
    if version != 1 {
        return BAD_FORMAT;
    }
    STAGING.with(|stage| {
        let mut stage = stage.borrow_mut();
        let Some((state, _)) = stage.as_mut() else {
            return BAD_FORMAT;
        };
        if state.rain_version || !state.rows.is_empty() || !state.squares.is_empty() {
            return BAD_FORMAT;
        }
        state.rain_version = true;
        OK
    })
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
        reach_properties: [0; 4],
        reach_known: false,
        rain_blockers: [RAIN_UNKNOWN; 4],
        rain_known: false,
        // Actual new-blueprint IsoDoor constructors leave these JVM fields zero.
        has_curtain: false,
        curtain_open: false,
        curtain_inside: false,
        curtain_capabilities: 0,
        curtain_known: false,
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
pub extern "C" fn door_import_rain_blockers(
    id: u32,
    initial_closed: u32,
    initial_open: u32,
    toggled_closed: u32,
    toggled_open: u32,
) -> i32 {
    let masks = [initial_closed, initial_open, toggled_closed, toggled_open];
    if masks.iter().any(|mask| *mask > RAIN_UNKNOWN as u32) {
        return BAD_FORMAT;
    }
    STAGING.with(|stage| {
        let mut stage = stage.borrow_mut();
        let Some((state, _)) = stage.as_mut() else {
            return BAD_FORMAT;
        };
        if !state.rain_version {
            return BAD_FORMAT;
        }
        let index = if state.rows.last().is_some_and(|door| door.id == id) {
            state.rows.len() - 1
        } else {
            let Some(index) = state.rows.iter().position(|door| door.id == id) else {
                return BAD_FORMAT;
            };
            index
        };
        let door = &mut state.rows[index];
        if door.rain_known {
            return BAD_FORMAT;
        }
        door.rain_blockers = masks.map(|mask| mask as u8);
        door.rain_known = true;
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
        || !integer(w[11], 0.0, RAIN_UNKNOWN as f64)
    {
        return BAD_FORMAT;
    }
    STAGING.with(|state| {
        let mut state = state.borrow_mut();
        let Some((state, _)) = state.as_mut() else {
            return BAD_FORMAT;
        };
        if !state.rain_version && w[11] != 0.0 {
            return BAD_FORMAT;
        }
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
                reach_walls: 0,
                reach_known: false,
                floor: None,
                rain_blockers: if state.rain_version {
                    w[11] as u8
                } else {
                    RAIN_UNKNOWN
                },
                have_roof: None,
            },
        );
        if key.2 >= 0 {
            state.roof_columns.insert((key.0, key.1));
        }
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn door_square_reach_stage(x: i32, y: i32, z: i32, mask: u32) -> i32 {
    if mask & !(WALLS as u32) != 0 {
        return BAD_FORMAT;
    }
    STAGING.with(|stage| {
        let mut stage = stage.borrow_mut();
        let Some((state, _)) = stage.as_mut() else {
            return BAD_FORMAT;
        };
        let Some(square) = state.squares.get_mut(&(x, y, z)) else {
            return BAD_FORMAT;
        };
        if square.reach_known {
            return BAD_FORMAT;
        }
        square.reach_walls = mask as u8;
        square.reach_known = true;
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn door_square_floor_stage(
    x: i32,
    y: i32,
    z: i32,
    flags: u32,
    stairs: u32,
    direction: u32,
    min: f64,
    max: f64,
) -> i32 {
    if flags & !31 != 0
        || stairs & !63 != 0
        || direction > 9
        || !min.is_finite()
        || !max.is_finite()
        || !(0.0..=1.0).contains(&min)
        || !(0.0..=1.0).contains(&max)
    {
        return BAD_FORMAT;
    }
    STAGING.with(|stage| {
        let mut stage = stage.borrow_mut();
        let Some((state, _)) = stage.as_mut() else {
            return BAD_FORMAT;
        };
        let Some(square) = state.squares.get_mut(&(x, y, z)) else {
            return BAD_FORMAT;
        };
        if square.floor.is_some() {
            return BAD_FORMAT;
        }
        square.floor = Some(Floor {
            flags,
            stairs,
            direction,
            min: min as f32,
            max: max as f32,
        });
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn source_square_floor_read(x: i32, y: i32, z: i32) -> i32 {
    DOORS.with(|state| {
        let state = state.borrow();
        let Some(floor) = state
            .squares
            .get(&(x, y, z))
            .and_then(|square| square.floor)
        else {
            return OUT_OF_RANGE;
        };
        let sprite = state.sprite_facts.get(&(x, y, z)).copied().unwrap_or(0);
        let flags = floor.flags | ((sprite & 24) >> 2) | ((sprite & 64) >> 6);
        super::actions::row(&[
            flags as f64,
            floor.stairs as f64,
            floor.direction as f64,
            floor.min as f64,
            floor.max as f64,
        ]);
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn door_import_reach_properties(
    id: u32,
    initial_closed: u32,
    initial_open: u32,
    toggled_closed: u32,
    toggled_open: u32,
) -> i32 {
    let masks = [initial_closed, initial_open, toggled_closed, toggled_open];
    if masks.iter().any(|mask| mask & !(WALLS as u32) != 0) {
        return BAD_FORMAT;
    }
    STAGING.with(|stage| {
        let mut stage = stage.borrow_mut();
        let Some((state, _)) = stage.as_mut() else {
            return BAD_FORMAT;
        };
        let index = if state.rows.last().is_some_and(|door| door.id == id) {
            state.rows.len() - 1
        } else {
            let Some(index) = state.rows.iter().position(|door| door.id == id) else {
                return BAD_FORMAT;
            };
            index
        };
        let door = &mut state.rows[index];
        if door.reach_known {
            return BAD_FORMAT;
        }
        door.reach_properties = masks.map(|mask| mask as u8);
        door.reach_known = true;
        OK
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn door_import_curtain_eligibility(id: u32, mask: u32) -> i32 {
    if mask > 15 {
        return BAD_FORMAT;
    }
    STAGING.with(|stage| {
        let mut stage = stage.borrow_mut();
        let Some((state, _)) = stage.as_mut() else {
            return BAD_FORMAT;
        };
        let index = if state.rows.last().is_some_and(|door| door.id == id) {
            state.rows.len() - 1
        } else {
            let Some(index) = state.rows.iter().position(|door| door.id == id) else {
                return BAD_FORMAT;
            };
            index
        };
        let door = &mut state.rows[index];
        if door.curtain_known {
            return BAD_FORMAT;
        }
        door.curtain_capabilities = mask as u8;
        door.curtain_known = true;
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
        state.rebuild_roofs();
        DOORS.with(|live| *live.borrow_mut() = state);
        retire_source_chunks();
        super::actions::invalidate();
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
            (square.flags
                | match square.have_roof {
                    Some(true) => 64 | 128,
                    Some(false) => 64,
                    None => 0,
                }) as f64,
            if state.can_stand(key, square) {
                1.0
            } else {
                0.0
            },
        ]);
        OK
    })
}
/// Original IsoGridSquare.getChunk owns an 8x8 chunk (IsoCell.getChunkForGridSquare).
/// Source-square import replaces the resident domain atomically; staging and saved door
/// state do not replace it. A chunk handle is meaningful only for a resident square.
#[unsafe(no_mangle)]
pub extern "C" fn source_square_chunk_read(x: i32, y: i32, z: i32) -> i32 {
    if !has_square(x, y, z) {
        return OUT_OF_RANGE;
    }
    put(&[
        x.div_euclid(8) as f64,
        y.div_euclid(8) as f64,
        SOURCE_CHUNK_GENERATION.with(|generation| generation.get()) as f64,
    ]);
    OK
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
pub(super) fn position(id: u32) -> Option<SquareKey> {
    DOORS.with(|state| {
        state
            .borrow()
            .rows
            .iter()
            .find(|row| row.id == id)
            .map(|row| row.position())
    })
}
pub(super) fn blocked_to(from: SquareKey, to: SquareKey) -> bool {
    DOORS.with(|state| state.borrow().source_blocked_to(from, to))
}
pub(super) fn can_reach(from: SquareKey, to: SquareKey) -> Result<bool, i32> {
    DOORS.with(|state| state.borrow().can_reach(from, to))
}
pub(super) fn stand_room(key: SquareKey) -> Option<i64> {
    DOORS.with(|state| {
        let state = state.borrow();
        state
            .query_square(key)
            .filter(|square| state.can_stand(key, *square))
            .map(|square| square.room)
    })
}
pub(super) fn reach_door(id: u32, actor: SquareKey) -> bool {
    DOORS.with(|state| {
        let state = state.borrow();
        state
            .rows
            .iter()
            .find(|row| row.id == id)
            .is_some_and(|door| state.door_reach(id, actor, door.position()) == OK)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn source_door_could_be_open(id: u32) -> i32 {
    let actor = ENGINE.with(|engine| {
        let engine = engine.borrow();
        (engine.x.floor() as i32, engine.y.floor() as i32, 0)
    });
    DOORS.with(|state| {
        let state = state.borrow();
        let Some(door) = state.rows.iter().find(|door| door.id == id).copied() else {
            return OUT_OF_RANGE;
        };
        state
            .could_be_open(door, actor)
            .map_or_else(|error| error, i32::from)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn source_door_curtain_read(id: u32) -> i32 {
    DOORS.with(|state| {
        let state = state.borrow();
        let Some(door) = state.rows.iter().find(|door| door.id == id) else {
            return OUT_OF_RANGE;
        };
        let index = if door.flags & TOGGLED != 0 { 2 } else { 0 } + usize::from(door.open());
        super::actions::row(&[
            u32::from(door.has_curtain) as f64,
            u32::from(door.curtain_open) as f64,
            u32::from(door.curtain_inside) as f64,
            if door.curtain_known {
                u32::from(door.curtain_capabilities & (1 << index) != 0) as f64
            } else {
                OUT_OF_RANGE as f64
            },
        ]);
        OK
    })
}
pub(super) fn room(key: SquareKey) -> Option<i64> {
    DOORS.with(|state| state.borrow().query_square(key).map(|s| s.room))
}
pub(super) fn north(id: u32) -> Option<bool> {
    DOORS.with(|state| {
        state
            .borrow()
            .rows
            .iter()
            .find(|d| d.id == id)
            .map(|d| d.north())
    })
}
pub(super) fn adjacent_allowed(from: SquareKey, to: SquareKey, window: bool) -> bool {
    DOORS.with(|state| {
        let state = state.borrow();
        fn walls(state: &Doors, a: SquareKey, b: SquareKey) -> bool {
            let (Some(sa), Some(sb)) = (state.query_square(a), state.query_square(b)) else {
                return false;
            };
            if a.2 != b.2 {
                return false;
            }
            if a.0 != b.0 && a.1 != b.1 {
                let p = (b.0, a.1, a.2);
                let q = (a.0, b.1, a.2);
                return walls(state, a, p)
                    && walls(state, a, q)
                    && walls(state, b, p)
                    && walls(state, b, q);
            }
            let (square, key, bit, property) = if a.0 != b.0 {
                if a.0 < b.0 {
                    (sb, b, NAV_WALL_WEST, 4)
                } else {
                    (sa, a, NAV_WALL_WEST, 4)
                }
            } else if a.1 < b.1 {
                (sb, b, NAV_WALL_NORTH, 2)
            } else {
                (sa, a, NAV_WALL_NORTH, 2)
            };
            if a == b {
                return true;
            }
            if square.door_walls & bit != 0
                && state.edges.get(&key).copied().unwrap_or(0) & bit == 0
            {
                return true;
            }
            square.walls & bit == 0 && square.interaction_properties & property == 0
        }
        let Some(square) = state.query_square(to) else {
            return false;
        };
        if !state.can_stand(to, square) || from.2 != to.2 {
            return false;
        }
        (window && (from.0 == to.0 || from.1 == to.1)) || walls(&state, from, to)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn square_wall_to(
    fx: i32,
    fy: i32,
    fz: i32,
    tx: i32,
    ty: i32,
    tz: i32,
    has_to: u32,
) -> i32 {
    if has_to > 1 {
        return OUT_OF_RANGE;
    }
    DOORS.with(|state| {
        let state = state.borrow();
        if state.query_square((fx, fy, fz)).is_none()
            || (has_to == 1 && state.query_square((tx, ty, tz)).is_none())
        {
            return OUT_OF_RANGE;
        }
        i32::from(has_to == 1 && state.source_relation_to((fx, fy, fz), (tx, ty, tz), true))
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn source_square_has(x: i32, y: i32, z: i32, index: u32) -> i32 {
    if index > 1 {
        return OUT_OF_RANGE;
    }
    DOORS.with(|state| {
        state
            .borrow()
            .query_square((x, y, z))
            .map_or(OUT_OF_RANGE, |square| {
                i32::from(square.interaction_properties & (if index == 0 { 2 } else { 4 }) != 0)
            })
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn square_can_reach_to(
    fx: i32,
    fy: i32,
    fz: i32,
    tx: i32,
    ty: i32,
    tz: i32,
    has_to: u32,
) -> i32 {
    if has_to > 1 {
        return OUT_OF_RANGE;
    }
    if has_to == 0 {
        return 0;
    }
    can_reach((fx, fy, fz), (tx, ty, tz)).map_or_else(|error| error, i32::from)
}
#[unsafe(no_mangle)]
pub extern "C" fn door_count() -> u32 {
    DOORS.with(|state| state.borrow().rows.len() as u32)
}

#[unsafe(no_mangle)]
pub extern "C" fn source_square_door_count(x: i32, y: i32, z: i32) -> u32 {
    DOORS.with(|state| {
        state
            .borrow()
            .rows
            .iter()
            .filter(|door| door.position() == (x, y, z))
            .count() as u32
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn source_square_door_get(x: i32, y: i32, z: i32, index: u32) -> f64 {
    DOORS.with(|state| {
        state
            .borrow()
            .rows
            .iter()
            .filter(|door| door.position() == (x, y, z))
            .nth(index as usize)
            .map_or(OUT_OF_RANGE as f64, |door| door.id as f64)
    })
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
    super::actions::queue_request_door(id)
}
/// Original context-key ToggleDoor calls ToggleDoorActual directly, not a timed
/// action or the menu's couldBeOpen predicate (retained javap 687:10474-10480).
/// Returns OK on mutation, BLOCKED on a valid refusal, OUT_OF_RANGE otherwise.
#[unsafe(no_mangle)]
pub extern "C" fn source_context_toggle_door(id: u32) -> i32 {
    if super::health() <= 0.0 {
        return OUT_OF_RANGE;
    }
    commit_toggle(id)
}
pub(super) fn commit_toggle(id: u32) -> i32 {
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
        let reach = state.door_reach(id, actor, (x, y, z));
        if reach != OK {
            return reach;
        }
        if door.flags & BARRICADED != 0 || state.obstructed(door) {
            return BLOCKED;
        }
        let inside = match state.can_be_open_from_inside(door, actor) {
            Ok(inside) => inside,
            Err(error) => return error,
        };
        let hoppable = !door.open() && door.flags & HOPPABLE != 0;
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
            row.flags &= !(KEY_LOCKED | LOCKED);
        }
        state.revision += 1;
        state.rebuild();
        for i in 0..state.rows.len() {
            let row = state.rows[i];
            if row.flags & SELECTED == 0 {
                continue;
            }
            let old = Door {
                flags: row.flags ^ OPEN,
                ..row
            }
            .position();
            let new = row.position();
            let state = &mut *state;
            Doors::rebuild_roof_column(&mut state.squares, &state.sprite_facts, old.0, old.1);
            if (old.0, old.1) != (new.0, new.1) {
                Doors::rebuild_roof_column(&mut state.squares, &state.sprite_facts, new.0, new.1);
            }
            state.rows[i].flags &= !SELECTED;
        }
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
            state.rebuild_roofs();
            super::actions::invalidate();
            OK
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stage_square(key: SquareKey, properties: f64) -> i32 {
        stage_square_facts(key, properties, Some(0))
    }
    fn stage_square_facts((x, y, z): SquareKey, properties: f64, reach: Option<u32>) -> i32 {
        put(&[
            x as f64, y as f64, z as f64, -1.0, 32.0, 0.0, 0.0, 0.0, 0.0, 0.0, properties, 0.0,
        ]);
        let result = door_square_stage();
        if result == OK {
            reach.map_or(OK, |mask| door_square_reach_stage(x, y, z, mask))
        } else {
            result
        }
    }
    fn stage_rain_square((x, y, z): SquareKey, blockers: f64) -> i32 {
        put(&[
            x as f64, y as f64, z as f64, -1.0, 32.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, blockers,
        ]);
        door_square_stage()
    }
    #[test]
    fn rain_wire_requires_explicit_per_import_admission_before_any_rows() {
        reset();
        assert_eq!(door_import_rain_blockers_version(1), BAD_FORMAT);
        assert_eq!(door_import_begin(1, 1, 0), OK);
        assert_eq!(door_import_rain_blockers_version(0), BAD_FORMAT);
        assert_eq!(door_import_rain_blockers_version(2), BAD_FORMAT);
        assert_eq!(stage_rain_square((0, 0, 1), 1.0), BAD_FORMAT);
        assert_eq!(stage_rain_square((0, 0, 1), 4.0), BAD_FORMAT);
        assert_eq!(stage_rain_square((0, 0, 1), 0.0), OK);
        assert_eq!(door_import_rain_blockers_version(1), BAD_FORMAT);
        assert_eq!(stage_rain_square((0, 0, 0), 0.0), OK);
        assert_eq!(door_import_commit(), OK);
        assert_eq!(source_have_roof(0, 0, 1), Ok(false));
        assert_eq!(
            source_have_roof(0, 0, 0),
            Err(()),
            "legacy reserved zero and solidFloor predicate establish no blocker authority"
        );
        assert_eq!(door_import_begin(1, 1, 0), OK);
        assert_eq!(door_import_rain_blockers_version(99), BAD_FORMAT);
        assert_eq!(source_have_roof(0, 0, 0), Err(()));
        assert_eq!(door_import_rain_blockers_version(1), OK);
        assert_eq!(door_import_rain_blockers_version(1), BAD_FORMAT);
        assert_eq!(stage_rain_square((0, 0, 1), 0.0), OK);
        assert_eq!(stage_rain_square((0, 0, 0), 0.0), OK);
        assert_eq!(source_have_roof(0, 0, 0), Err(()));
        assert_eq!(door_import_commit(), OK);
        assert_eq!(source_have_roof(0, 0, 0), Ok(false));
        assert_eq!(door_import_begin(1, 1, 0), OK);
        stage_door(NORTH, 0);
        assert_eq!(door_import_rain_blockers_version(1), BAD_FORMAT);
        assert_eq!(door_import_rain_blockers(1, 0, 0, 0, 0), BAD_FORMAT);
        door_import_abort();
        assert_eq!(source_have_roof(0, 0, 0), Ok(false));
        // Each new import returns to the legacy wire, independent of live metadata.
        assert_eq!(door_import_begin(1, 1, 0), OK);
        assert_eq!(stage_rain_square((0, 0, 1), 0.0), OK);
        assert_eq!(stage_rain_square((0, 0, 0), 0.0), OK);
        assert_eq!(door_import_commit(), OK);
        assert_eq!(source_have_roof(0, 0, 0), Err(()));
    }
    #[test]
    fn roof_columns_assign_prior_blockers_across_gaps_and_keep_unknown_authority() {
        reset();
        assert_eq!(door_import_begin(1, 1, 0), OK);
        assert_eq!(door_import_rain_blockers_version(1), OK);
        assert_eq!(stage_rain_square((0, 0, 32), 1.0), BAD_FORMAT);
        for (key, blockers) in [
            ((0, 0, 31), 1.0),
            ((0, 0, 7), 0.0),
            ((0, 0, 0), 0.0),
            ((0, 0, -1), 1.0),
            ((1, 0, 31), 4.0),
            ((1, 0, 20), 0.0),
            ((1, 0, 10), 2.0),
            ((1, 0, 0), 0.0),
            ((2, 0, 0), 0.0),
        ] {
            assert_eq!(stage_rain_square(key, blockers), OK);
        }
        assert_eq!(source_have_roof(0, 0, 0), Err(()));
        assert_eq!(door_import_commit(), OK);
        for (key, roof) in [
            ((0, 0, 31), Ok(false)),
            ((0, 0, 7), Ok(true)),
            ((0, 0, 0), Ok(true)),
            ((0, 0, -1), Err(())),
            ((0, 0, 32), Err(())),
            ((0, 0, 1), Err(())),
            ((1, 0, 31), Ok(false)),
            ((1, 0, 20), Err(())),
            ((1, 0, 10), Err(())),
            ((1, 0, 0), Ok(true)),
            ((2, 0, 0), Ok(false)),
        ] {
            assert_eq!(source_have_roof(key.0, key.1, key.2), roof, "{key:?}");
        }
        assert_eq!(square_read(0, 0, 31), OK);
        assert_eq!(words()[4] as u32, 32 | 64);
        assert_eq!(square_read(0, 0, 0), OK);
        assert_eq!(words()[4] as u32, 32 | 64 | 128);
        assert_eq!(square_read(1, 0, 20), OK);
        assert_eq!(words()[4] as u32, 32);
        assert_eq!(door_import_begin(1, 1, 0), OK);
        assert_eq!(door_import_rain_blockers_version(1), OK);
        assert_eq!(stage_rain_square((0, 0, 0), 0.0), OK);
        for invalid in [-1.0, 5.0, 0.5, f64::NAN] {
            assert_eq!(stage_rain_square((0, 0, 1), invalid), BAD_FORMAT);
        }
        assert_eq!(source_have_roof(0, 0, 0), Ok(true));
        door_import_abort();
        assert_eq!(source_have_roof(0, 0, 0), Ok(true));
        reset();
        assert_eq!(source_have_roof(0, 0, 0), Err(()));
    }
    #[test]
    fn moving_door_rain_snapshots_refresh_both_columns_and_restore_geometry_metadata() {
        reset();
        assert_eq!(door_import_begin(1, 1, 0), OK);
        assert_eq!(door_import_rain_blockers_version(1), OK);
        for key in [
            (0, 0, 0),
            (0, -1, 0),
            (-1, 1, 0),
            (-1, 0, 0),
            (0, 0, 1),
            (-1, 1, 1),
        ] {
            assert_eq!(stage_rain_square(key, 0.0), OK);
        }
        put(&[
            1.0,
            0.0,
            0.0,
            1.0,
            NORTH as f64,
            -1.0,
            -1.0,
            -1.0,
            0.0,
            2.0,
            0.0,
            0.0,
        ]);
        assert_eq!(door_import_stage(), OK);
        assert_eq!(door_import_rain_blockers(1, 1, 2, 0, 2), OK);
        assert_eq!(door_import_rain_blockers(1, 0, 0, 0, 0), BAD_FORMAT);
        assert_eq!(door_import_commit(), OK);
        assert_eq!(source_have_roof(0, 0, 0), Ok(true));
        assert_eq!(source_have_roof(-1, 1, 0), Ok(false));
        // Restore is the same admitted geometry-state transition used by web saves.
        assert_eq!(door_restore_begin(1, 1, 1, 0, 1), OK);
        put(&[1.0, 1.0, 0.0, 0.0, -1.0, -1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0]);
        assert_eq!(door_restore_stage(), OK);
        assert_eq!(door_restore_commit(), OK);
        assert_eq!(source_have_roof(0, 0, 0), Ok(false));
        assert_eq!(source_have_roof(-1, 1, 0), Ok(true));
        assert_eq!(source_have_roof(-1, 1, 1), Ok(false));
        assert_eq!(door_restore_begin(2, 1, 1, 0, 1), OK);
        put(&[1.0, 0.0, 0.0, 0.0, -1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0]);
        assert_eq!(door_restore_stage(), OK);
        assert_eq!(door_restore_commit(), OK);
        assert_eq!(source_have_roof(0, 0, 0), Ok(false));
        assert_eq!(source_have_roof(-1, 1, 0), Ok(false));
    }
    #[test]
    fn unknown_door_blockers_do_not_erase_known_positive_blockers() {
        reset();
        assert_eq!(door_import_begin(1, 1, 0), OK);
        assert_eq!(door_import_rain_blockers_version(1), OK);
        for key in [(0, 0, 0), (0, -1, 0), (0, 0, 2), (0, 0, 1)] {
            assert_eq!(
                stage_rain_square(key, if key.2 == 1 { 2.0 } else { 0.0 }),
                OK
            );
        }
        put(&[
            1.0,
            0.0,
            0.0,
            2.0,
            NORTH as f64,
            -1.0,
            -1.0,
            -1.0,
            0.0,
            0.0,
            0.0,
            0.0,
        ]);
        assert_eq!(door_import_stage(), OK);
        assert_eq!(door_import_commit(), OK);
        assert_eq!(source_have_roof(0, 0, 2), Ok(false));
        assert_eq!(source_have_roof(0, 0, 1), Err(()));
        assert_eq!(source_have_roof(0, 0, 0), Ok(true));
    }
    #[test]
    fn source_chunk_identity_follows_atomic_square_residency() {
        reset();
        assert_eq!(source_square_chunk_read(5, 5, 0), OUT_OF_RANGE);
        assert_eq!(door_import_begin(1, 1, 0), OK);
        for key in [(5, 5, 0), (7, 7, 1), (8, 5, 0), (-1, -2, 0)] {
            assert_eq!(stage_square(key, 0.0), OK);
        }
        assert_eq!(source_square_chunk_read(5, 5, 0), OUT_OF_RANGE);
        assert_eq!(door_import_commit(), OK);
        assert_eq!(source_square_chunk_read(5, 5, 0), OK);
        let first = words();
        assert_eq!(&first[..2], &[0.0, 0.0]);
        assert_eq!(source_square_chunk_read(7, 7, 1), OK);
        assert_eq!(&words()[..3], &first[..3]);
        assert_eq!(source_square_chunk_read(8, 5, 0), OK);
        assert_eq!(&words()[..2], &[1.0, 0.0]);
        assert_eq!(source_square_chunk_read(-1, -2, 0), OK);
        assert_eq!(&words()[..2], &[-1.0, -1.0]);
        assert_eq!(source_square_chunk_read(6, 5, 0), OUT_OF_RANGE);
        assert_eq!(door_import_begin(1, 1, 0), OK);
        assert_eq!(stage_square((5, 5, 0), 0.0), OK);
        assert_eq!(source_square_chunk_read(5, 5, 0), OK);
        assert_eq!(&words()[..3], &first[..3]);
        door_import_abort();
        assert_eq!(source_square_chunk_read(5, 5, 0), OK);
        assert_eq!(&words()[..3], &first[..3]);
        assert_eq!(door_import_begin(1, 1, 0), OK);
        assert_eq!(stage_square((5, 5, 0), 0.0), OK);
        assert_eq!(door_import_commit(), OK);
        assert_eq!(source_square_chunk_read(5, 5, 0), OK);
        assert_ne!(words()[2], first[2]);
        reset();
        assert_eq!(source_square_chunk_read(5, 5, 0), OUT_OF_RANGE);
        assert_eq!(door_import_begin(1, 1, 0), OK);
        assert_eq!(stage_square((5, 5, 0), 0.0), OK);
        assert_eq!(door_import_commit(), OK);
        assert_eq!(source_square_chunk_read(5, 5, 0), OK);
        assert_ne!(words()[2], first[2]);
    }
    #[test]
    fn floor_facts_publish_atomically_and_preserve_source_float_heights() {
        reset();
        assert_eq!(source_square_floor_read(0, 0, 0), OUT_OF_RANGE);
        assert_eq!(door_import_begin(1, 1, 0), OK);
        assert_eq!(stage_square((0, 0, 0), 0.0), OK);
        assert_eq!(
            door_square_floor_stage(0, 0, 0, 32, 0, 0, 0.0, 0.0),
            BAD_FORMAT
        );
        assert_eq!(
            door_square_floor_stage(0, 0, 0, 0, 64, 0, 0.0, 0.0),
            BAD_FORMAT
        );
        assert_eq!(
            door_square_floor_stage(0, 0, 0, 0, 0, 10, 0.0, 0.0),
            BAD_FORMAT
        );
        assert_eq!(
            door_square_floor_stage(0, 0, 0, 0, 0, 0, f64::NAN, 0.0),
            BAD_FORMAT
        );
        assert_eq!(
            door_square_floor_stage(1, 0, 0, 0, 0, 0, 0.0, 0.0),
            BAD_FORMAT
        );
        assert_eq!(door_square_floor_stage(0, 0, 0, 25, 33, 8, 0.13, 0.97), OK);
        assert_eq!(
            door_square_floor_stage(0, 0, 0, 0, 0, 0, 0.0, 0.0),
            BAD_FORMAT
        );
        assert_eq!(source_square_floor_read(0, 0, 0), OUT_OF_RANGE);
        assert_eq!(door_import_commit(), OK);
        assert_eq!(source_square_floor_read(0, 0, 0), OK);
        let values = unsafe {
            std::slice::from_raw_parts(super::super::actions::queue_scratch_ptr().cast::<f64>(), 5)
        };
        assert_eq!(values, &[25.0, 33.0, 8.0, 0.13_f32 as f64, 0.97_f32 as f64]);
        assert_eq!(source_square_floor_read(1, 0, 0), OUT_OF_RANGE);
    }

    fn import_squares(squares: &[(SquareKey, u16)]) {
        reset();
        assert_eq!(door_import_begin(1, 1, 0), OK);
        for &(key, properties) in squares {
            assert_eq!(stage_square(key, properties as f64), OK);
        }
        assert_eq!(door_import_commit(), OK);
    }
    fn source_menu_scene(actor: SquareKey, outside: bool, flags: u32, door_square_flags: u32) {
        super::super::reset();
        assert_eq!(door_import_begin(1, 1, 0), OK);
        for (key, room) in [
            ((0, 0, 0), 7),
            ((0, -1, 0), 9),
            ((1, 0, 0), 11),
            ((5, 5, 0), 11),
        ] {
            let square_flags = 32
                | if key == actor { u32::from(outside) } else { 0 }
                | if key == (0, 0, 0) {
                    door_square_flags
                } else {
                    0
                };
            put(&[
                key.0 as f64,
                key.1 as f64,
                key.2 as f64,
                room as f64,
                square_flags as f64,
                0.0,
                0.0,
                0.0,
                0.0,
                0.0,
                0.0,
                0.0,
            ]);
            assert_eq!(door_square_stage(), OK);
            assert_eq!(door_square_reach_stage(key.0, key.1, key.2, 0), OK);
        }
        // Deliberately different cached import rooms: the predicate must use
        // current square identities, not these old door-row room values.
        stage_door(flags, 0);
        assert_eq!(door_import_commit(), OK);
        ENGINE.with(|engine| {
            let mut engine = engine.borrow_mut();
            engine.x = actor.0 as f32 + 0.5;
            engine.y = actor.1 as f32 + 0.5;
        });
    }
    #[test]
    fn source_context_toggle_door_is_direct_live_and_preserves_refusals() {
        use crate::actions::{queue_commit_door, queue_current, queue_event_read, queue_length};

        source_menu_scene((0, 0, 0), false, NORTH | LOCKED | KEY_LOCKED, 0);
        assert_eq!(queue_commit_door(1, 1, 1), OUT_OF_RANGE);
        assert_eq!(source_context_toggle_door(1), OK);
        assert!(DOORS.with(|state| state.borrow().rows[0].open()));
        assert_eq!(source_context_toggle_door(1), OK);
        assert!(!DOORS.with(|state| state.borrow().rows[0].open()));
        assert_eq!(DOORS.with(|state| state.borrow().revision), 2);
        assert_eq!(queue_length(), 0);
        assert_eq!(queue_current(), 0);
        assert_eq!(queue_event_read(), 0);
        assert_eq!(queue_commit_door(1, 1, 1), OUT_OF_RANGE);

        for (actor, outside, flags, obstruction, alive, id, expected) in [
            ((0, 0, 0), true, NORTH | LOCKED, 0, true, 1, BLOCKED),
            ((0, 0, 0), true, NORTH | KEY_LOCKED, 0, true, 1, BLOCKED),
            ((0, 0, 0), true, NORTH | CUSTOM_LOCK, 0, true, 1, BLOCKED),
            ((0, 0, 0), false, NORTH | BARRICADED, 0, true, 1, BLOCKED),
            ((0, 0, 0), false, NORTH, 16, true, 1, BLOCKED),
            ((5, 5, 0), false, NORTH, 0, true, 1, OUT_OF_RANGE),
            ((0, 0, 0), false, NORTH, 0, false, 1, OUT_OF_RANGE),
            ((0, 0, 0), false, NORTH, 0, true, 999, OUT_OF_RANGE),
        ] {
            source_menu_scene(actor, outside, flags, obstruction);
            if !alive {
                ENGINE.with(|engine| engine.borrow_mut().health = 0.0);
            }
            let before = DOORS.with(|state| {
                let state = state.borrow();
                (state.rows[0], state.revision)
            });
            assert_eq!(source_context_toggle_door(id), expected);
            assert!(DOORS.with(|state| {
                let state = state.borrow();
                (state.rows[0], state.revision) == before
            }));
            assert_eq!(queue_length(), 0);
            assert_eq!(queue_current(), 0);
            assert_eq!(queue_event_read(), 0);
        }
    }
    #[test]
    fn source_menu_permission_uses_live_inside_rooms_without_mutating_door() {
        for actor in [(0, 0, 0), (0, -1, 0)] {
            source_menu_scene(actor, false, NORTH | LOCKED | KEY_LOCKED, 0);
            let before = DOORS.with(|state| {
                let state = state.borrow();
                (state.rows[0], state.revision)
            });
            assert_eq!(source_door_could_be_open(1), 1);
            assert!(DOORS.with(|state| {
                let state = state.borrow();
                (state.rows[0], state.revision) == before
            }));
            assert_eq!(commit_toggle(1), OK);
            assert!(DOORS.with(|state| state.borrow().rows[0].open()));
        }
    }
    #[test]
    fn source_menu_permission_distinguishes_locks_obstruction_and_commit() {
        for (actor, outside, flags, obstruction, permission) in [
            ((0, 0, 0), true, NORTH | LOCKED, 0, 1),
            ((1, 0, 0), false, NORTH | LOCKED, 0, 1),
            ((0, 0, 0), false, NORTH | LOCKED | FORCE, 0, 1),
            ((0, -1, 0), false, NORTH | LOCKED, 16, 1), // Inside beats obstruction.
            ((0, 0, 0), false, NORTH | LOCKED | BARRICADED, 0, 0),
            ((0, 0, 0), true, NORTH | LOCKED, 16, 0),
            ((1, 0, 0), false, NORTH | KEY_LOCKED, 0, OUT_OF_RANGE),
            ((1, 0, 0), false, NORTH | CUSTOM_LOCK, 0, OUT_OF_RANGE),
        ] {
            source_menu_scene(actor, outside, flags, obstruction);
            let before = DOORS.with(|state| {
                let state = state.borrow();
                (state.rows[0], state.revision)
            });
            assert_eq!(source_door_could_be_open(1), permission);
            assert_eq!(commit_toggle(1), BLOCKED);
            assert!(DOORS.with(|state| {
                let state = state.borrow();
                (state.rows[0], state.revision) == before
            }));
        }
    }
    #[test]
    fn source_menu_permission_preserves_early_barricade_and_unknown_actor_refusal() {
        source_menu_scene((5, 5, 0), true, NORTH | LOCKED, 0);
        assert_eq!(source_door_could_be_open(1), 1); // MENU has no reach guard.
        assert_eq!(commit_toggle(1), OUT_OF_RANGE);
        source_menu_scene((0, 0, 0), false, NORTH | LOCKED, 0);
        assert_eq!(source_door_could_be_open(999), OUT_OF_RANGE);
        ENGINE.with(|engine| {
            engine.borrow_mut().x = 8.5;
        });
        assert_eq!(source_door_could_be_open(1), OUT_OF_RANGE);
        source_menu_scene((0, 0, 0), false, NORTH | BARRICADED, 0);
        ENGINE.with(|engine| {
            engine.borrow_mut().x = 8.5;
        });
        assert_eq!(source_door_could_be_open(1), 0);
    }
    #[test]
    fn source_reach_distinguishes_wall_objects_exclusions_and_unknown_facts() {
        for (reach, expected) in [(Some(4), 0), (Some(0), 1), (None, OUT_OF_RANGE)] {
            super::super::reset();
            assert_eq!(door_import_begin(1, 1, 0), OK);
            assert_eq!(stage_square_facts((0, 0, 0), 0.0, Some(0)), OK);
            assert_eq!(stage_square_facts((1, 0, 0), 0.0, reach), OK);
            assert_eq!(door_import_commit(), OK);
            assert_eq!(square_blocked_to(0, 0, 0, 1, 0, 0, 1), 0);
            assert_eq!(square_wall_to(0, 0, 0, 1, 0, 0, 1), 0);
            assert_eq!(square_can_reach_to(0, 0, 0, 1, 0, 0, 1), expected);
            assert_eq!(square_can_reach_to(1, 0, 0, 0, 0, 0, 1), expected);
            // Missing directional metadata is not needed by these original early returns.
            assert_eq!(square_can_reach_to(1, 0, 0, 1, 0, 0, 1), 1);
            assert_eq!(square_can_reach_to(1, 0, 0, 9, 9, 0, 1), 0);
            assert_eq!(square_can_reach_to(1, 0, 0, 1, 0, 1, 1), 0);
        }
    }
    #[test]
    fn source_north_wall_rejects_before_unknown_west_in_query_and_pickup_consumer() {
        for (north, west, reach, pickup) in [
            (Some(2), None, 0, BLOCKED),
            (None, Some(4), OUT_OF_RANGE, OUT_OF_RANGE),
            (Some(0), None, OUT_OF_RANGE, OUT_OF_RANGE),
        ] {
            super::super::reset();
            assert_eq!(door_import_begin(1, 1, 0), OK);
            assert_eq!(stage_square_facts((0, 1, 0), 0.0, north), OK);
            assert_eq!(stage_square_facts((1, 0, 0), 0.0, west), OK);
            assert_eq!(door_import_commit(), OK);
            assert_eq!(square_can_reach_to(0, 1, 0, 1, 0, 0, 1), reach);
            assert_eq!(square_can_reach_to(1, 0, 0, 0, 1, 0, 1), reach);
            ENGINE.with(|engine| {
                let mut engine = engine.borrow_mut();
                engine.x = 0.5;
                engine.y = 1.5;
            });
            assert_eq!(
                crate::item_definition_register(0, 1, 100, 0, 1, 0, 0, 0, 1.0, 0),
                OK
            );
            assert_eq!(crate::item_spawn(0, 1.5, 0.5, 1, 100), OK);
            assert_eq!(crate::item_read_id(crate::item_last_id()), OK);
            let owner = SCRATCH.with(|scratch| scratch.borrow()[2]);
            assert_eq!(
                crate::actions::queue_request_pickup(crate::item_last_id()),
                pickup
            );
            assert_eq!(crate::actions::queue_length(), 0);
            assert_eq!(crate::item_read_id(crate::item_last_id()), OK);
            SCRATCH.with(|scratch| {
                let item = scratch.borrow();
                assert_eq!(item[2], owner);
                assert_eq!(item[11], 1.0);
            });
        }
    }
    #[test]
    fn live_door_reach_snapshots_share_cache_and_missing_open_facts_refuse() {
        for known in [true, false] {
            super::super::reset();
            assert_eq!(door_import_begin(1, 1, 0), OK);
            for key in [(0, 0, 0), (0, -1, 0), (-1, 0, 0)] {
                assert_eq!(stage_square(key, 0.0), OK);
            }
            put(&[
                1.0,
                0.0,
                0.0,
                0.0,
                NORTH as f64,
                -1.0,
                -1.0,
                -1.0,
                0.0,
                0.0,
                0.0,
                0.0,
            ]);
            assert_eq!(door_import_stage(), OK);
            if known {
                assert_eq!(door_import_reach_properties(1, 0, 4, 0, 4), OK);
            }
            assert_eq!(door_import_commit(), OK);
            assert_eq!(square_can_reach_to(0, -1, 0, 0, 0, 0, 1), 0); // actual closed door rejects first
            assert_eq!(square_can_reach_to(0, 0, 0, 0, 0, 0, 1), 1);
            ENGINE.with(|e| {
                let mut e = e.borrow_mut();
                e.x = 0.5;
                e.y = 0.5;
            });
            assert_eq!(commit_toggle(1), OK);
            assert_eq!(square_blocked_to(-1, 0, 0, 0, 0, 0, 1), 0);
            assert_eq!(
                square_can_reach_to(-1, 0, 0, 0, 0, 0, 1),
                if known { 0 } else { OUT_OF_RANGE }
            );
            assert_eq!(commit_toggle(1), OK);
            assert_eq!(
                square_can_reach_to(-1, 0, 0, 0, 0, 0, 1),
                if known { 1 } else { OUT_OF_RANGE }
            );
        }
    }
    #[test]
    fn blueprint_curtain_own_state_and_eligibility_survive_port_door_restore() {
        super::super::reset();
        assert_eq!(door_import_begin(1, 1, 0), OK);
        for key in [(0, 0, 0), (0, -1, 0)] {
            assert_eq!(stage_square(key, 0.0), OK);
        }
        stage_door(NORTH, 0);
        assert_eq!(door_import_commit(), OK);
        assert_eq!(source_door_curtain_read(1), OK);
        assert_eq!(
            crate::actions::queue_words_for_test(),
            [0.0, 0.0, 0.0, -2.0]
        );
        assert_eq!(source_door_curtain_read(999), OUT_OF_RANGE);
        assert_eq!(door_import_begin(1, 1, 0), OK);
        for key in [(0, 0, 0), (0, -1, 0)] {
            assert_eq!(stage_square(key, 0.0), OK);
        }
        stage_door(NORTH, 0);
        assert_eq!(door_import_curtain_eligibility(1, 16), BAD_FORMAT);
        assert_eq!(door_import_curtain_eligibility(1, 9), OK);
        assert_eq!(door_import_commit(), OK);
        assert_eq!(source_door_curtain_read(1), OK);
        assert_eq!(crate::actions::queue_words_for_test(), [0.0, 0.0, 0.0, 1.0]);
        assert_eq!(door_restore_begin(9, 1, 1, 0, 1), OK);
        put(&[1.0, 1.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
        assert_eq!(door_restore_stage(), OK);
        assert_eq!(door_restore_commit(), OK);
        assert_eq!(source_door_curtain_read(1), OK);
        assert_eq!(crate::actions::queue_words_for_test(), [0.0, 0.0, 0.0, 0.0]);
        assert!(DOORS.with(|s| s.borrow().rows[0].curtain_known));
    }
    #[test]
    fn source_queued_door_requires_exact_perform_token_and_commits_once() {
        super::super::reset();
        assert_eq!(door_import_begin(1, 1, 0), OK);
        for key in [(0, 0, 0), (0, -1, 0)] {
            assert_eq!(stage_square(key, 0.0), OK);
        }
        stage_door(NORTH, 0);
        assert_eq!(door_import_commit(), OK);
        ENGINE.with(|e| {
            let mut e = e.borrow_mut();
            e.x = 0.5;
            e.y = 0.5;
        });
        use crate::actions::*;
        let id = queue_action_new(2, 1, 1, 0, 0, 0, 0.0) as u32;
        assert_eq!(queue_insert(0, id), OK);
        assert_eq!(queue_start(id, 0.0, 1), OK);
        for result in [1, 0, 0] {
            assert_eq!(queue_event_read(), 1);
            let row = crate::actions::event_row_for_test();
            assert_eq!(queue_event_reply(id, row.0, row.1, result), OK);
        }
        assert_eq!(crate::step(0.0), OK);
        let validate = crate::actions::event_row_for_test();
        assert_eq!(queue_event_reply(id, validate.0, validate.1, 1), OK);
        let perform = crate::actions::event_row_for_test();
        assert_eq!(perform.0, 5);
        assert_eq!(queue_commit_door(id, 1, perform.1 + 1), OUT_OF_RANGE);
        assert_eq!(queue_commit_door(id, 1, perform.1), OK);
        assert_eq!(queue_commit_door(id, 1, perform.1), OUT_OF_RANGE);
        assert_eq!(DOORS.with(|s| s.borrow().revision), 1);
        assert_eq!(queue_remove(0), id as i32);
        assert_eq!(queue_event_reply(id, 5, perform.1, 0), OK);
        assert_eq!(queue_current(), 0);
        assert_eq!(queue_action_read(id), OUT_OF_RANGE);
    }
    #[test]
    fn source_finder_is_cardinal_first_and_reuses_blocked_stair_orientation() {
        super::super::reset();
        for index in 0..1024 {
            assert_eq!(
                crate::world_import_chunk(0, 0, index, 0, 0, 0, 0, 0, 0, 0, 0, 0),
                OK
            );
        }
        assert_eq!(door_import_begin(1, 1, 0), OK);
        for key in [
            (5, 5, 0),
            (4, 5, 0),
            (6, 5, 0),
            (5, 4, 0),
            (5, 6, 0),
            (4, 4, 0),
        ] {
            assert_eq!(stage_square(key, 0.0), OK);
        }
        assert_eq!(door_import_commit(), OK);
        ENGINE.with(|e| {
            let mut e = e.borrow_mut();
            e.x = 3.5;
            e.y = 3.5;
        });
        assert_eq!(crate::actions::source_adjacent_read(1, 0, 5, 5, 0), 1);
        assert_eq!(crate::actions::adjacent_row_for_test(), (4, 5, 0));
        assert_eq!(can_reach((4, 5, 0), (5, 5, 0)), Ok(true));
        DOORS.with(|s| {
            s.borrow_mut()
                .squares
                .get_mut(&(5, 5, 0))
                .unwrap()
                .interaction_properties |= 256
        });
        assert!(blocked_to((5, 5, 0), (4, 5, 0)));
        assert_eq!(can_reach((5, 5, 0), (4, 5, 0)), Ok(false));
        assert_eq!(can_reach((4, 5, 0), (5, 5, 0)), Ok(true));
        let walk = crate::actions::queue_request_walk(4, 5, 0);
        assert!(walk > 0);
        assert_eq!(crate::walk(1.0, 0.0), OK);
        assert_eq!(crate::step(0.0), OK);
        assert_eq!(crate::actions::queue_action_read(walk as u32), OUT_OF_RANGE);
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
            assert_eq!(&words()[..6], &[1.0, 0.0, 0.0, -1.0, 96.0, 1.0]);
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
        assert_eq!(door_import_reach_properties(1, 0, 0, 0, 0), OK);
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
        assert_eq!(commit_toggle(1), OK);
        assert_eq!(blocked((0, 0, 0), (0, -1, 0)), 0);
        assert_eq!(blocked((0, 0, 0), (-1, 0, 0)), 1);
        assert_eq!(commit_toggle(1), OK);
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
        assert_eq!(commit_toggle(1), OK);
        assert_eq!(blocked((0, 0, 0), (-1, 0, 0)), 1);
        assert_eq!(commit_toggle(1), OK);
        assert_eq!(blocked((0, 0, 0), (-1, 0, 0)), 1);
    }

    #[test]
    fn source_floor_queries_follow_current_door_sprites_without_changing_raw_windows() {
        reset();
        assert_eq!(door_import_begin(1, 1, 0), OK);
        for key in [(0, 0, 0), (0, -1, 0), (-1, 0, 0)] {
            assert_eq!(stage_square(key, 0.0), OK);
        }
        assert_eq!(door_square_floor_stage(0, 0, 0, 24, 0, 0, 0.0, 0.0), OK);
        put(&[
            1.0,
            0.0,
            0.0,
            0.0,
            NORTH as f64,
            -1.0,
            -1.0,
            -1.0,
            0.0,
            0.0,
            0.0,
            88.0,
        ]);
        assert_eq!(door_import_stage(), OK);
        assert_eq!(door_import_reach_properties(1, 0, 0, 0, 0), OK);
        assert_eq!(door_import_commit(), OK);
        assert_eq!(source_square_floor_read(0, 0, 0), OK);
        assert_eq!(
            unsafe { *super::super::actions::queue_scratch_ptr().cast::<f64>() },
            31.0
        );
        ENGINE.with(|engine| {
            let mut engine = engine.borrow_mut();
            engine.x = 0.5;
            engine.y = 0.5;
        });
        assert_eq!(commit_toggle(1), OK);
        assert_eq!(source_square_floor_read(0, 0, 0), OK);
        assert_eq!(
            unsafe { *super::super::actions::queue_scratch_ptr().cast::<f64>() },
            24.0
        );
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
        put(&[2.0, 0.0, 0.0, -1.0, 32.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 5.0]);
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
