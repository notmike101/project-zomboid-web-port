/** @file Synthetic original-format map/tile projection regressions; no installed bytes. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createEngine } from '../src/engine.js';
import { openMapCell } from '../src/map-tiles.js';
import { createTileRegistry } from '../src/tile-definitions.js';
import { completeActions } from './queue-test-helpers.js';

/**
 * Encode one synthetic signed field.
 *
 * @param {number} value - Signed field.
 * @returns {Buffer} Native integer.
 */
function int(value) {
    const bytes = Buffer.alloc(4);

    bytes.writeInt32LE(value);

    return bytes;
}

/**
 * Encode one synthetic name.
 *
 * @param {string} value - Fixture string.
 * @returns {Buffer} Native line.
 */
function line(value) {
    return Buffer.from(`${value}\n`, 'latin1');
}

/**
 * Encode a synthetic native tileset.
 *
 * @param {Array<Array<[string,string]>>} tiles - Properties.
 * @param {string} [name] - Sheet.
 * @returns {Buffer} TDEF.
 */
function definitions(tiles, name = 'synthetic') {
    return Buffer.concat([
        Buffer.from('tdef'), int(1), int(1), line(name), line('not-a-texture.png'), int(8), int(8), int(1), int(tiles.length),
        ...tiles.flatMap((props) => [int(props.length), ...props.flatMap(([key, value]) => [line(key), line(value)])]),
    ]);
}

/**
 * Ingest synthetic definitions through the actual parser.
 *
 * @param {Array<Array<[string,string]>>} tiles - Synthetic metadata.
 * @returns {Map} Native registry.
 */
function registry(tiles) {
    return createTileRegistry([{ path: 'synthetic.tiles', fileId: 1, buffer: definitions(tiles) }]);
}

/**
 * Open synthetic bytes through the actual lazy map parser.
 *
 * @param {object} [options] - Fixture metadata.
 * @param {string[]} [options.names] - Catalogue.
 * @param {number[]} [options.records] - Chunk records.
 * @param {object[]} [options.rooms] - LOTH rectangles.
 * @param {number[][]} [options.buildings] - LOTH room memberships.
 * @param {number} [options.cellX] - Cell x.
 * @param {number} [options.cellY] - Cell y.
 * @returns {Promise<import('../src/map-tiles.js').MapCell>} Real lazy map cell.
 */
function cell({ names = ['synthetic_0'], records = [2, -1, 0, -1, 63], rooms = [], buildings = [], cellX = 0, cellY = 0 } = {}) {
    const header = Buffer.concat([
        Buffer.from('LOTH'), int(1), int(names.length), ...names.map(line), int(8), int(8), int(0), int(0), int(rooms.length),
        ...rooms.flatMap(({ z = 0, rects }) => [line('synthetic room'), int(z), int(rects.length), ...rects.flatMap((rect) => rect.map(int)), int(0)]),
        int(buildings.length), ...buildings.flatMap((roomIds) => [int(roomIds.length), ...roomIds.map(int)]), Buffer.alloc(1_024),
    ]);
    const table = Buffer.alloc(8_192);

    table.writeBigInt64LE(8_204n, 0);
    const lotpack = Buffer.concat([Buffer.from('LOTP'), int(1), int(8), table, ...records.map(int)]);

    return openMapCell({ cellX, cellY, header: new Blob([header]), lotpack: new Blob([lotpack]) });
}

/**
 * Require the implementation with an explicit RED assertion.
 *
 * @returns {Promise<object>} Production exports.
 */
async function projectionModule() {
    try {
        return await import('../src/world-objects.js');
    } catch (error) {
        if (error.code === 'ERR_MODULE_NOT_FOUND') {
            assert.fail('Missing source-backed world object projection implementation');
        }

        throw error;
    }
}

// Removing independent collision, trusting NAV room fields, or mutating the registry fails this check.
test('projects independent walls and canonical opposite rooms from LOTH without changing source identity', async () => {
    const { projectWorldObjects } = await projectionModule();
    const tiles = registry([
        [['doorN', 'false'], ['forceLocked', 'false'], ['attachedS', 'false'], ['HoppableN', 'false']],
        [['collideN', 'false'], ['WindowW', 'false'], ['DoorWallN', 'false'], ['solidtrans', 'false']],
        [['attachedE', 'false']],
    ]);
    const map = await cell({
        names: ['synthetic_0', 'synthetic_1'],
        records: [-1, 1, 3, -1, 0, 1, -1, 62],
        rooms: [{ rects: [[0, 1, 1, 1]] }, { rects: [[0, 0, 1, 1]] }],
    });
    const before = [...tiles].map(([name, sprite]) => [name, sprite.tileType, [...sprite.properties]]);
    const projected = await projectWorldObjects([map], tiles);
    const door = projected.doors[0];
    const square = projected.squares.find((row) => row.x === 0 && row.y === 1 && row.z === 0);

    assert.equal(door.id, 'door:0:1:0:0');
    assert.equal(door.roomId, 0);
    assert.equal(door.oppositeRoomId, 1);
    assert.equal(door.north, true);
    assert.equal(door.open, false);
    assert.equal(door.forceLocked, true);
    assert.equal(door.attachedE, true);
    assert.equal(door.attachedS, false);
    assert.equal(door.hoppable, true);
    assert.equal(door.customLock, false);
    assert.equal(door.locked, false);
    assert.equal(door.lockedByKey, false);
    assert.equal(door.keyId, -1);
    assert.equal(door.barricaded, false);
    assert.equal(door.independentWalls, 6);
    assert.equal(square.independentWalls, 6);
    assert.equal(square.windows, 4);
    assert.equal(square.doorWalls, 2);
    assert.equal(square.solidTrans, true);
    assert.equal(square.roomId, 0);
    assert.equal(square.outside, false);
    assert.equal(square.vehicleObstructed, false);
    assert.deepEqual(projected.doorVisuals.map(({ id, closedSpriteName, openSpriteName, order }) => ({ id, closedSpriteName, openSpriteName, order })), [
        { id: door.id, closedSpriteName: 'synthetic_0', openSpriteName: 'synthetic_2', order: 0 },
    ]);
    assert.deepEqual([...tiles].map(([name, sprite]) => [name, sprite.tileType, [...sprite.properties]]), before);
    assert.deepEqual(await projectWorldObjects([map], tiles), projected);
});

// Treating sparse raw IDs as dense indices or conflating local building IDs across cells breaks the relationship.
test('projects real ordered building members through sparse room ids with distinct cross-cell identity', async () => {
    const { projectWorldObjects } = await projectionModule();
    const tiles = registry([[]]);
    const first = await cell({
        records: [-1, 64],
        rooms: [{ rects: [[0, 0, 1, 1]] }, { rects: [[0, 1, 1, 1]] }, { rects: [[0, 2, 1, 1]] }],
        buildings: [[1, 0]],
    });
    const second = await cell({
        records: [-1, 64], cellX: 1,
        rooms: [{ rects: [[0, 0, 1, 1]] }], buildings: [[0]],
    });

    assert.deepEqual(first.buildings, [{ id: 0, roomIds: [1, 0] }]);
    const sparse = {
        ...first,
        rooms: first.rooms.map((room, index) => ({ ...room, id: [42, 7, 99][index] })),
        buildings: [{ id: 0, roomIds: [7, 42] }],
    };
    const projection = await projectWorldObjects([second, sparse], tiles);

    assert.deepEqual(projection.buildings, [
        { id: 0, originalBuildingId: 0, cellX: 0, cellY: 0, roomIds: [1, 0] },
        { id: 1, originalBuildingId: 0, cellX: 1, cellY: 0, roomIds: [3] },
    ]);
    assert.deepEqual(projection.rooms.map(({ id, originalRoomId, buildingId }) => ({ id, originalRoomId, buildingId })), [
        { id: 0, originalRoomId: 42, buildingId: 0 },
        { id: 1, originalRoomId: 7, buildingId: 0 },
        { id: 2, originalRoomId: 99, buildingId: null },
        { id: 3, originalRoomId: 0, buildingId: 1 },
    ]);
    assert.equal(projection.squares.find(({ x, y }) => x === 0 && y === 1).roomId, 1);
    assert.equal(projection.squares.find(({ x, y }) => x === 256 && y === 0).roomId, 3);
    assert.deepEqual(await projectWorldObjects([sparse, second], tiles), projection);
    sparse.buildings[0].roomIds.reverse();
    sparse.rooms[0].name = 'changed after projection';
    assert.deepEqual(projection.buildings[0].roomIds, [1, 0]);
    assert.equal(projection.rooms[0].name, 'synthetic room');
    assert.throws(() => projection.buildings[0].roomIds.push(2), TypeError);
    assert.throws(() => {
        projection.rooms[0].buildingId = 1;
    }, TypeError);
});

// No building is authoritative metadata; missing metadata and corrupt memberships must never become an empty fallback.
test('keeps genuine no-building rooms while refusing unknown or corrupt building metadata', async () => {
    const { projectWorldObjects } = await projectionModule();
    const tiles = registry([[]]);
    const map = await cell({ records: [-1, 64], rooms: [{ rects: [[0, 0, 1, 1]] }] });
    const projection = await projectWorldObjects([map], tiles);

    assert.deepEqual(projection.buildings, []);
    assert.equal(projection.rooms[0].buildingId, null);
    await assert.rejects(projectWorldObjects([{ ...map, buildings: undefined }], tiles), /building metadata.*unavailable/iu);
    await assert.rejects(projectWorldObjects([{ ...map, buildings: [{ id: 0, roomIds: [1] }] }], tiles), /building room reference/iu);
    await assert.rejects(projectWorldObjects([{ ...map, buildings: [{ id: 0, roomIds: [0, 0] }] }], tiles), /duplicate.*building room/iu);
    await assert.rejects(projectWorldObjects([{ ...map, buildings: [{ id: 0, roomIds: [0] }, { id: 1, roomIds: [0] }] }], tiles), /duplicate.*building room/iu);
    await assert.rejects(projectWorldObjects([{ ...map, buildings: [{ id: 0, roomIds: [] }, { id: 0, roomIds: [] }] }], tiles), /building identity/iu);
});

// Inventing a west frame edge from both uppercase flags makes the real native square west of that object standable.
test('native standability uses constructor window orientation and generic N-first frames from source bytes', async () => {
    const { projectWorldObjects } = await projectionModule();
    const subject = await createEngine(new Uint8Array(await readFile(new URL(
        '../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url,
    ))));
    const fixtures = await Promise.all([
        { properties: [['WindowN', 'false'], ['WindowW', 'false']], expected: false, label: 'N then W uppercase frame' },
        { properties: [['WindowW', 'false'], ['WindowN', 'false']], expected: false, label: 'W then N uppercase frame' },
        { properties: [['windowW', 'false'], ['WindowN', 'false']], expected: true, label: 'actual west window plus generic north frame' },
    ].map(async ({ properties, expected, label }) => {
        const tiles = registry([[['solidtrans', 'false']], properties]);
        const map = await cell({ names: ['synthetic_0', 'synthetic_1'], records: [2, -1, 0, -1, 7, 2, -1, 1, -1, 55] });
        const projection = await projectWorldObjects([map], tiles);

        return { projection, expected, label };
    }));

    for (const { projection, expected, label } of fixtures) {
        subject.importDoors(projection.doors, { squares: projection.squares });
        assert.equal(subject.getSquare(0, 0, 0).canStand, expected, label);
    }
});

// A constructor selected before actual windows still exposes generic N-first frame flags, not a lowercase west window.
test('native window edges follow source light and curtain constructor priority while windows precede trees', async () => {
    const { projectWorldObjects } = await projectionModule();
    const subject = await createEngine(new Uint8Array(await readFile(new URL(
        '../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url,
    ))));
    const navigation = new Uint8Array(1_026);

    navigation[1] = 1;
    subject.worldImportCell(0, 0, navigation);
    const fixtures = await Promise.all([
        { type: 'lightswitch', value: 'false', expected: false },
        { type: 'curtainN', value: 'false', expected: false },
        { type: 'tree', value: '1', expected: true },
    ].map(async ({ type, value, expected }) => {
        const tiles = registry([
            [['solidtrans', 'false']],
            [['windowW', 'false'], ['WindowN', 'false'], [type, value]],
        ]);
        const map = await cell({ names: ['synthetic_0', 'synthetic_1'], records: [2, -1, 0, -1, 7, 2, -1, 1, -1, 55] });
        const projection = await projectWorldObjects([map], tiles);

        return { projection, expected, type };
    }));

    for (const { projection, expected, type } of fixtures) {
        subject.importDoors(projection.doors, { squares: projection.squares });
        assert.equal(subject.getSquare(0, 0, 0).canStand, expected, type);
        assert.equal(subject.navFlags(1, 0) & 6, 6, `${type}: raw collision windows remain north and west`);
        subject.loadState({ version: 2, values: [0.5, 0.5, 1.5, 0.5, 0.5, 0, 0, 0, 0, 1, 100, 1] });
        assert.throws(() => subject.command({ type: 'walk', x: 1, y: 0 }), /blocked/iu, `${type}: west collision stays blocked`);
    }
});

// An uppercase frame attached to an earlier matching wall is visual-only, unlike a lowercase actual window.
test('native square facts exclude source frame overlays attached to earlier matching walls', async () => {
    const { projectWorldObjects } = await projectionModule();
    const subject = await createEngine(new Uint8Array(await readFile(new URL(
        '../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url,
    ))));
    const fixtures = await Promise.all([
        { flag: 'WindowW', order: [1, 2], expected: false, label: 'uppercase frame overlays an earlier wall' },
        { flag: 'windowW', order: [1, 2], expected: true, label: 'lowercase window creates an actual object' },
        { flag: 'WindowW', order: [2, 1], expected: true, label: 'a later wall cannot consume an earlier frame' },
    ].map(async ({ flag, order, expected, label }) => {
        const tiles = registry([
            [['solidtrans', 'false']],
            [['wall', 'false'], ['cutW', 'false']],
            [[flag, 'false'], ['solidfloor', 'false']],
        ]);
        const map = await cell({
            names: ['synthetic_0', 'synthetic_1', 'synthetic_2'],
            records: [2, -1, 0, -1, 7, 3, -1, ...order, -1, 55],
        });
        const projection = await projectWorldObjects([map], tiles);

        return { projection, expected, label };
    }));

    for (const { projection, expected, label } of fixtures) {
        subject.importDoors(projection.doors, { squares: projection.squares });
        assert.equal(subject.getSquare(0, 0, 0).canStand, expected, label);
        assert.equal(subject.getSquare(1, 0, 0).solidFloor, expected, `${label}: source floor facts`);
    }
});

// Raw placement aggregation invents floors on attachments and keeps facts from replaced actual trees.
test('native facts replay source attachment and actual tree membership without changing collision masks', async () => {
    const { projectWorldObjects } = await projectionModule();
    const subject = await createEngine(new Uint8Array(await readFile(new URL(
        '../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url,
    ))));
    const fixtures = await Promise.all([
        {
            tiles: [[['CountertopAttach', 'false']], [['Countertop', 'false'], ['SlopedSurfaceDirection', 'N']]],
            floor: false, solid: false, walls: 0, label: 'countertop attachment adds no slope',
        },
        {
            tiles: [[['Countertop', 'false'], ['SlopedSurfaceDirection', 'N']]],
            floor: true, solid: false, walls: 0, label: 'countertop without a target creates an object',
        },
        {
            tiles: [[['wall', 'false'], ['cutW', 'false']], [['WallOverlay', 'false'], ['attachedW', 'false'], ['solidfloor', 'false']]],
            floor: false, solid: false, walls: 0, label: 'wall attachment adds no floor',
        },
        {
            tiles: [[['FloorOverlay', 'false'], ['SlopedSurfaceDirection', 'N']]],
            floor: false, solid: false, walls: 0, label: 'floor overlay without a floor creates no object',
        },
        {
            tiles: [[['container', 'fireplace'], ['FloorOverlay', 'false'], ['solidfloor', 'false']]],
            floor: true, solid: false, walls: 0, label: 'earlier furniture constructor wins over overlays',
        },
        {
            tiles: [[['tree', '1'], ['solid', 'false'], ['solidfloor', 'false'], ['HoppableN', 'false']], [['tree', '1']]],
            floor: false, solid: false, walls: 2, label: 'new actual tree replaces the first actual tree',
        },
        {
            tiles: [[['tree', '1'], ['solid', 'false'], ['solidfloor', 'false']], [['tree', '1'], ['CustomName', 'Mannequin']]],
            floor: true, solid: true, walls: 0, label: 'mannequin tree-type sprite does not replace actual trees',
        },
    ].map(async ({ tiles, ...expected }) => {
        const map = await cell({
            names: tiles.map((_, index) => `synthetic_${index}`),
            records: [tiles.length + 1, -1, ...tiles.map((_, index) => index), -1, 63],
        });
        const projection = await projectWorldObjects([map], registry(tiles));

        return { projection, ...expected };
    }));

    for (const { projection, floor, solid, walls, label } of fixtures) {
        subject.importDoors(projection.doors, { squares: projection.squares });
        const square = subject.getSquare(0, 0, 0);

        assert.deepEqual({ solid: square.solid, solidFloor: square.solidFloor }, { solid, solidFloor: floor }, label);
        assert.equal(projection.squares[0].independentWalls, walls, `${label}: raw collision mask is unchanged`);
    }
});

// AddSpecialObject inserts cut-field windows before the last door without adding them to specialObjects.
test('native standability distinguishes actual windows inserted before doors from special windows', async () => {
    const { projectWorldObjects } = await projectionModule();
    const subject = await createEngine(new Uint8Array(await readFile(new URL(
        '../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url,
    ))));
    const tiles = registry([
        [['solidtrans', 'false']],
        [['doorN', 'false']],
        [['windowW', 'false'], ['WindowN', 'false']],
        [],
    ]);
    const map = await cell({
        names: ['synthetic_0', 'synthetic_1', 'synthetic_2'],
        records: [-1, 1, 2, -1, 0, -1, 7, 3, -1, 1, 2, -1, 54],
    });
    const projection = await projectWorldObjects([map], tiles);

    subject.importDoors(projection.doors, { squares: projection.squares });
    assert.equal(subject.getSquare(0, 1, 0).canStand, false);
    assert.equal(projection.squares[9].windowEdges, 2, 'generic north frame still participates outside specialObjects');
    assert.equal(subject.isBlockedTo({ x: 1, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }), true,
        'hasBlockedWindow searches all actual objects, not only specialObjects');
});

// Conditional diamond-floor replacement preserves the first object's class but replaces its contributing sprite.
test('native facts replace component-free diamond floors and reject unresolved component-bearing floor replacement', async () => {
    const { projectWorldObjects } = await projectionModule();
    const subject = await createEngine(new Uint8Array(await readFile(new URL(
        '../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url,
    ))));
    const first = [['solidfloor', 'false'], ['diamondFloor', 'false'], ['solid', 'false']];
    const second = [['solidfloor', 'false'], ['diamondFloor', 'false']];
    const map = await cell({ names: ['synthetic_0', 'synthetic_1'], records: [3, -1, 0, 1, -1, 63] });
    const replaced = await projectWorldObjects([map], registry([first, second]));

    subject.importDoors(replaced.doors, { squares: replaced.squares });
    assert.equal(subject.getSquare(0, 0, 0).solid, false);
    assert.equal(subject.getSquare(0, 0, 0).solidFloor, true);
    const transparent = await projectWorldObjects([map], registry([first, [...second, ['transparentFloor', 'false']]]));

    subject.importDoors(transparent.doors, { squares: transparent.squares });
    assert.equal(subject.getSquare(0, 0, 0).solid, true, 'transparent floors do not replace the prior floor');
    await assert.rejects(projectWorldObjects([map], registry([[...first, ['EntityScript', 'false']], second])),
        /unsupported.*component.*floor.*0,0,0/iu);
});

// Broken variants use the actual current partner after shared closed-property merges, without mutating the caller registry.
test('native broken-window facts use merged current sprites and current-property floor selection', async () => {
    const { projectWorldObjects } = await projectionModule();
    const subject = await createEngine(new Uint8Array(await readFile(new URL(
        '../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url,
    ))));
    const tiles = registry([
        [['windowW', 'false'], ['solidfloor', 'false'], ['diamondFloor', 'false'], ['SmashedTileOffset', '1'], ['GlassRemovedOffset', '2']],
        [['solid', 'false']],
        [['solidtrans', 'false']],
        [['solidfloor', 'false'], ['diamondFloor', 'false']],
    ]);
    const before = [...tiles].map(([name, sprite]) => [name, sprite.tileType, [...sprite.properties]]);
    const map = await cell({ names: ['synthetic_1', 'synthetic_2'], records: [2, -1, 0, 2, -1, 1, -1, 62] });
    const projection = await projectWorldObjects([map], tiles);

    subject.importDoors(projection.doors, { squares: projection.squares });
    const smashed = subject.getSquare(0, 0, 0);
    const glass = subject.getSquare(0, 1, 0);

    assert.deepEqual({ solid: smashed.solid, solidTrans: smashed.solidTrans, solidFloor: smashed.solidFloor },
        { solid: true, solidTrans: false, solidFloor: true });
    assert.deepEqual({ solid: glass.solid, solidTrans: glass.solidTrans, solidFloor: glass.solidFloor },
        { solid: false, solidTrans: true, solidFloor: true });
    const floorAfterVariant = await cell({ names: ['synthetic_1', 'synthetic_3'], records: [3, -1, 0, 1, -1, 63] });
    const retained = await projectWorldObjects([floorAfterVariant], tiles);

    subject.importDoors(retained.doors, { squares: retained.squares });
    assert.equal(subject.getSquare(0, 0, 0).solid, false,
        'copied solidfloor property makes the current broken window eligible as the existing floor target');
    assert.deepEqual([...tiles].map(([name, sprite]) => [name, sprite.tileType, [...sprite.properties]]), before);
});

// Source constructors mutate shared definition identities, including objects replayed in earlier chunks.
test('native facts include later window constructor mutations of earlier created objects across source cells', async () => {
    const { projectWorldObjects } = await projectionModule();
    const subject = await createEngine(new Uint8Array(await readFile(new URL(
        '../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url,
    ))));
    const tiles = registry([[['windowW', 'false'], ['solidfloor', 'false'], ['OpenTileOffset', '1']], []]);
    const earlier = await cell({ names: ['synthetic_1'], records: [2, -1, 0, -1, 63] });
    const later = await cell({ cellX: 1, records: [2, -1, 0, -1, 63] });
    const projection = await projectWorldObjects([later, earlier], tiles);

    subject.importDoors(projection.doors, { squares: projection.squares });
    assert.equal(subject.getSquare(0, 0, 0).solidFloor, true, 'earlier generic object observes its shared partner mutation');
    assert.equal(subject.getSquare(256, 0, 0).solidFloor, true);
    assert.deepEqual(await projectWorldObjects([later, earlier], tiles), projection, 'constructor mutations stay projection-private');
});

// Copied floor flags change properties but cannot change a new sprite's cached diamond-floor gate.
test('native replacement keeps cached new-floor fields separate from copied window properties', async () => {
    const { projectWorldObjects } = await projectionModule();
    const subject = await createEngine(new Uint8Array(await readFile(new URL(
        '../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url,
    ))));
    const tiles = registry([
        [['windowW', 'false'], ['solidfloor', 'false'], ['diamondFloor', 'false'], ['OpenTileOffset', '1']],
        [],
        [['solidfloor', 'false'], ['diamondFloor', 'false'], ['solid', 'false']],
    ]);
    const map = await cell({
        names: ['synthetic_0', 'synthetic_1', 'synthetic_2'],
        records: [2, -1, 0, 3, -1, 2, 1, -1, 62],
    });
    const projection = await projectWorldObjects([map], tiles);

    subject.importDoors(projection.doors, { squares: projection.squares });
    assert.equal(subject.getSquare(0, 1, 0).solid, true,
        'the copied-property window does not replace the earlier solid floor through a false cached-field gate');
});

// TreatAsWallOrder changes which actual floor is first, rather than changing raw visual placement order.
test('native first-floor selection observes exact TreatAsWallOrder insertion before doors', async () => {
    const { projectWorldObjects } = await projectionModule();
    const subject = await createEngine(new Uint8Array(await readFile(new URL(
        '../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url,
    ))));
    const tiles = registry([
        [['doorN', 'false'], ['solidfloor', 'false'], ['diamondFloor', 'false'], ['solid', 'false']],
        [['solidfloor', 'false'], ['TreatAsWallOrder', 'false']],
        [['solidfloor', 'false'], ['diamondFloor', 'false']],
    ]);
    const map = await cell({ names: ['synthetic_0', 'synthetic_1', 'synthetic_2'], records: [-1, 1, 4, -1, 0, 1, 2, -1, 62] });
    const projection = await projectWorldObjects([map], tiles);

    subject.importDoors(projection.doors, { squares: projection.squares });
    assert.equal(subject.getSquare(0, 1, 0).solid, true,
        'the inserted non-diamond floor is selected before the earlier diamond door floor');
});

// Garage attachment selection reads current shared sprite properties, not constructor group metadata.
test('native wall overlays use current garage properties added to an existing actual door', async () => {
    const { projectWorldObjects } = await projectionModule();
    const subject = await createEngine(new Uint8Array(await readFile(new URL(
        '../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url,
    ))));
    const tiles = registry([
        [['doorN', 'false']],
        [['WallOverlay', 'false'], ['attachedN', 'false'], ['solidfloor', 'false']],
        [],
        [['windowW', 'false'], ['GarageDoor', '1'], ['OpenTileOffset', '-3']],
    ]);
    const map = await cell({ names: ['synthetic_0', 'synthetic_1', 'synthetic_3'], records: [-1, 1, 4, -1, 0, 2, 1, -1, 62] });
    const projection = await projectWorldObjects([map], tiles);

    subject.importDoors(projection.doors, { squares: projection.squares });
    assert.equal(subject.getSquare(0, 1, 0).solidFloor, false, 'the garage-targeted overlay contributes no floor');
});

// Blueprint membership still supplies object edges, but RecalcProperties excludes its floor and solid flags.
test('native standability keeps blueprint object edges without inventing blueprint square facts', async () => {
    const { projectWorldObjects } = await projectionModule();
    const subject = await createEngine(new Uint8Array(await readFile(new URL(
        '../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url,
    ))));
    const tiles = registry([
        [['solidtrans', 'false']],
        [['blueprint', 'false'], ['HoppableW', 'false'], ['solidfloor', 'false'], ['solid', 'false']],
    ]);
    const map = await cell({ names: ['synthetic_0', 'synthetic_1'], records: [2, -1, 0, -1, 7, 2, -1, 1, -1, 55] });
    const projection = await projectWorldObjects([map], tiles);

    subject.importDoors(projection.doors, { squares: projection.squares });
    assert.equal(subject.getSquare(0, 0, 0).canStand, true);
    const blueprint = subject.getSquare(1, 0, 0);

    assert.deepEqual({ solid: blueprint.solid, solidFloor: blueprint.solidFloor }, { solid: false, solidFloor: false });
});

// Omitting door sprite properties or freezing them at import gives incorrect native square facts after replacement.
test('native square facts follow actual closed and open source door sprites', async () => {
    const { projectWorldObjects } = await projectionModule();
    const subject = await createEngine(new Uint8Array(await readFile(new URL(
        '../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url,
    ))));
    const navigation = new Uint8Array(1_026);

    navigation[1] = 1;
    subject.worldImportCell(0, 0, navigation);
    const tiles = registry([[['doorN', 'false'], ['solid', 'false'], ['solidfloor', 'false']], [], []]);
    const map = await cell({ records: [-1, 1, 2, -1, 0, -1, 62] });
    const projection = await projectWorldObjects([map], tiles);
    const door = projection.doors[0];

    const standing = projection.squares.filter((square) => square.x !== 0 || square.y !== 0);

    standing.push({
        x: 0, y: 0, z: 0, roomId: -1, outside: true, solid: false, solidTrans: false,
        tree: false, independentWalls: 0, vehicleObstructed: false, solidFloor: true,
    });
    subject.importDoors(projection.doors, { squares: standing });
    const closed = subject.getSquare(0, 1, 0);

    assert.deepEqual({ solid: closed.solid, solidFloor: closed.solidFloor, canStand: closed.canStand },
        { solid: true, solidFloor: true, canStand: false });
    subject.loadState({ version: 2, values: [0.5, 0.5, 1.5, 0.5, 0.5, 0, 0, 0, 0, 1, 100, 1] });
    subject.toggleDoor(door.id);
    completeActions(subject);
    const open = subject.getSquare(0, 1, 0);

    assert.deepEqual({ solid: open.solid, solidFloor: open.solidFloor, canStand: open.canStand },
        { solid: false, solidFloor: false, canStand: false });
    subject.toggleDoor(door.id);
    completeActions(subject);
    const toggledClosed = subject.getSquare(0, 1, 0);

    assert.deepEqual({ solid: toggledClosed.solid, solidFloor: toggledClosed.solidFloor, canStand: toggledClosed.canStand },
        { solid: true, solidFloor: true, canStand: false });
});

// Treating textual flags as booleans, OR-ing both hoppable directions, or freezing door edges fails these source-format fixtures.
test('projects property-presence floors and N-first static hoppable edges from actual placements', async () => {
    const { projectWorldObjects } = await projectionModule();
    const tiles = registry([
        [['HoppableN', 'false'], ['HoppableW', 'false'], ['solidfloor', 'false'], ['solidtrans', 'false']],
        [['HoppableW', '']],
        [['solidfloor', '']],
        [['doorN', 'false'], ['solidfloor', 'false'], ['HoppableN', 'false']],
        [],
        [['HoppableW', 'false']],
    ]);
    const map = await cell({
        names: ['synthetic_0', 'synthetic_1', 'synthetic_2', 'synthetic_3', 'synthetic_5'],
        records: [2, -1, 0, 3, -1, 0, 1, 2, -1, 1, 2, -1, 2, 2, -1, 3, 2, -1, 4, -1, 58],
        rooms: [{ rects: [[0, 0, 1, 6]] }],
    });
    const result = await projectWorldObjects([map], tiles);

    assert.deepEqual(result.squares.slice(0, 7).map(({ solidFloor, hoppableEdges, independentWalls, windows, roomId }) => (
        { solidFloor, hoppableEdges, independentWalls, windows, roomId }
    )), [
        { solidFloor: true, hoppableEdges: 2, independentWalls: 6, windows: 0, roomId: 0 },
        { solidFloor: true, hoppableEdges: 6, independentWalls: 6, windows: 0, roomId: 0 },
        { solidFloor: false, hoppableEdges: 4, independentWalls: 4, windows: 0, roomId: 0 },
        { solidFloor: true, hoppableEdges: 0, independentWalls: 0, windows: 0, roomId: 0 },
        { solidFloor: false, hoppableEdges: 0, independentWalls: 0, windows: 0, roomId: 0 },
        { solidFloor: false, hoppableEdges: 0, independentWalls: 0, windows: 0, roomId: 0 },
        { solidFloor: false, hoppableEdges: 0, independentWalls: 0, windows: 0, roomId: -1 },
    ]);
    assert.equal(result.squares[0].solidTrans, true);
    assert.deepEqual(result.doors.map(({ open, standEdges, squareFlags }) => ({ open, standEdges, squareFlags })), [
        { open: false, standEdges: [2, 4, 2, 4], squareFlags: [32, 0, 32, 0] },
        { open: true, standEdges: [2, 4, 2, 4], squareFlags: [32, 0, 32, 0] },
    ]);
});

// Freezing initial facts or folding door properties into static squares breaks source sprite replacement metadata.
test('projects independent solid, transparent, tree and slope floor facts for every door partner', async () => {
    const { projectWorldObjects } = await projectionModule();
    const tiles = Array.from({ length: 6 }, () => []);

    tiles[0] = [['doorN', 'false'], ['DoubleDoor', '1'], ['solid', 'false'], ['solidfloor', 'false']];
    tiles[4] = [['doorW', 'false'], ['DoubleDoor', '6'], ['solidtrans', 'false'], ['SlopedSurfaceDirection', ' ne ']];
    tiles[5] = [['tree', '1'], ['doorW', 'false'], ['DoubleDoor', '5']];
    const map = await cell({ records: [-1, 1, 2, -1, 0, -1, 62] });
    const result = await projectWorldObjects([map], registry(tiles));
    const square = result.squares[1];

    assert.deepEqual(result.doors[0].squareFlags, [34, 36, 34, 8]);
    assert.deepEqual({ solid: square.solid, solidTrans: square.solidTrans, tree: square.tree, solidFloor: square.solidFloor },
        { solid: false, solidTrans: false, tree: false, solidFloor: false });
    tiles[4] = [['doorW', 'false'], ['DoubleDoor', '6'], ['SlopedSurfaceDirection', 'invalid']];
    await assert.rejects(projectWorldObjects([map], registry(tiles)), /slope.*0,1,0/iu,
        'a needed future partner slope fails at the import boundary, not after toggling');
});

// Dropping a stair family member or inferring floors from arbitrary stair-like properties fails this parser-path check.
test('treats all six actual source stair types as solid floors without the raw floor flag', async () => {
    const { projectWorldObjects } = await projectionModule();
    const types = ['stairsTN', 'stairsMN', 'stairsBN', 'stairsTW', 'stairsMW', 'stairsBW'];
    const tiles = registry([...types.map((type) => [[type, 'false'], ['solidtrans', 'false']]), [['stairs', 'false']]]);
    const map = await cell({
        names: [...types.map((_, index) => `synthetic_${index}`), 'synthetic_6'],
        records: [2, -1, 0, 2, -1, 1, 2, -1, 2, 2, -1, 3, 2, -1, 4, 2, -1, 5, 2, -1, 6, -1, 57],
    });
    const result = await projectWorldObjects([map], tiles);

    assert.deepEqual(result.squares.slice(0, 8).map(({ solidFloor }) => solidFloor), [true, true, true, true, true, true, false, false]);
    assert.deepEqual(result.squares.slice(0, 6).map(({ solidTrans, hoppableEdges, windows }) => (
        { solidTrans, hoppableEdges, windows }
    )), Array.from({ length: 6 }, () => ({ solidTrans: true, hoppableEdges: 0, windows: 0 })));
});

// Accepting only cardinal directions or using slope height instead of the nonnull direction fails this fixture.
test('treats every source slope direction as a floor after ASCII trimming and uppercasing', async () => {
    const { projectWorldObjects } = await projectionModule();
    const directions = ['N', 'NW', 'W', 'SW', 'S', 'SE', 'E', 'NE'];
    const tiles = registry(directions.map((direction) => [['SlopedSurfaceDirection', ` \t${direction.toLowerCase()} \u001F`], ['solidtrans', 'false']]));
    const map = await cell({
        names: directions.map((_, index) => `synthetic_${index}`),
        records: [...directions.flatMap((_, index) => [2, -1, index]), -1, 56],
    });
    const result = await projectWorldObjects([map], tiles);

    assert.deepEqual(result.squares.slice(0, 9).map(({ solidFloor }) => solidFloor), [true, true, true, true, true, true, true, true, false]);
    assert.equal(result.squares[0].solidTrans, true);
});

test('preserves independently clamped source slope heights as native float values', async () => {
    const { projectWorldObjects } = await projectionModule();
    const heights = [['33', '67'], ['101', '-1'], ['2147483648', '1.5'], [' +25\u001F', '100']];
    const tiles = registry(heights.map(([min, max]) => [
        ['SlopedSurfaceDirection', 'N'],
        ['SlopedSurfaceHeightMin', min],
        ['SlopedSurfaceHeightMax', max],
    ]));
    const map = await cell({
        names: [...tiles.keys()],
        records: [...heights.flatMap((_, index) => [2, -1, index]), -1, 60],
    });
    const result = await projectWorldObjects([map], tiles);

    assert.deepEqual(result.squares.slice(0, 4).map(({ slopeMin, slopeMax }) => [slopeMin, slopeMax]), [
        [Math.fround(0.33), Math.fround(0.67)], [1, 0], [0, 0], [0.25, 1],
    ]);
});

// OR-ing per-placement slopes, broad Unicode trimming, or validating a short-circuited slope fails this parser-path check.
test('decodes only the last square slope property and skips slopes when raw floors or stairs already suffice', async () => {
    const { projectWorldObjects } = await projectionModule();
    const tiles = registry([
        [['SlopedSurfaceDirection', 'invalid']],
        [['SlopedSurfaceDirection', ' sw ']],
        [['solidfloor', 'false'], ['SlopedSurfaceDirection', 'invalid']],
        [['stairsBN', 'false'], ['SlopedSurfaceDirection', 'invalid']],
        [['SlopedSurfaceDirection', '\u00A0N\u00A0']],
        [['SlopedSurfaceDirection', '']],
    ]);
    const names = [...tiles.keys()];
    const accepted = await cell({ names, records: [3, -1, 0, 1, 2, -1, 2, 2, -1, 3, -1, 61] });
    const result = await projectWorldObjects([accepted], tiles);

    assert.deepEqual(result.squares.slice(0, 4).map(({ solidFloor }) => solidFloor), [true, true, true, false]);
    assert.deepEqual(result.squares.slice(0, 3).map(({ slopeDirection }) => slopeDirection), [6, 9, 9]);
    const invalid = await cell({ names, records: [2, -1, 0, -1, 63] });
    const overwritten = await cell({ names, records: [3, -1, 1, 0, -1, 63] });
    const unicodeTrim = await cell({ names, records: [2, -1, 4, -1, 63] });
    const empty = await cell({ names, records: [2, -1, 5, -1, 63] });

    await assert.rejects(projectWorldObjects([invalid], tiles), /slope.*0,0,0/iu);
    await assert.rejects(projectWorldObjects([overwritten], tiles), /slope.*0,0,0/iu);
    await assert.rejects(projectWorldObjects([unicodeTrim], tiles), /slope.*0,0,0/iu);
    await assert.rejects(projectWorldObjects([empty], tiles), /slope.*0,0,0/iu);
});

test('projects stand edges separately for all resolved constructor and toggled door sprites', async () => {
    const { projectWorldObjects } = await projectionModule();
    const tiles = Array.from({ length: 11 }, () => []);

    tiles[0] = [['WindowN', 'false'], ['WindowW', 'false'], ['HoppableW', 'false'], ['doorN', 'false'], ['DoubleDoor', '1']];
    tiles[4] = [['WindowN', 'false'], ['WindowW', 'false'], ['HoppableN', 'false'], ['HoppableW', 'false'], ['doorW', 'false'], ['DoubleDoor', '6']];
    tiles[5] = [['doorW', 'false'], ['DoubleDoor', '5']];
    tiles[6] = [['HoppableW', 'false'], ['doorN', 'false'], ['DoubleDoor', '2']];
    tiles[7] = [['WindowN', 'false'], ['HoppableW', 'false'], ['doorN', 'false'], ['DoubleDoor', '2']];
    tiles[10] = [['doorN', 'false'], ['DoubleDoor', '6']];
    const map = await cell({ names: ['synthetic_0', 'synthetic_10'], records: [2, -1, 0, 2, -1, 1, -1, 62] });
    const result = await projectWorldObjects([map], registry(tiles));

    assert.deepEqual(result.doors.map(({ x, y, open, hoppable, standEdges }) => ({ x, y, open, hoppable, standEdges })), [
        { x: 0, y: 0, open: false, hoppable: true, standEdges: [6, 2, 6, 0] },
        { x: 1, y: 0, open: true, hoppable: true, standEdges: [4, 0, 6, 0] },
    ]);
    assert.deepEqual(result.doorVisuals.map(({ closedSpriteName, openSpriteName, toggledClosedSpriteName, toggledOpenSpriteName }) => (
        [closedSpriteName, openSpriteName, toggledClosedSpriteName, toggledOpenSpriteName]
    )), [
        ['synthetic_0', 'synthetic_4', 'synthetic_0', 'synthetic_5'],
        ['synthetic_6', 'synthetic_10', 'synthetic_7', 'synthetic_10'],
    ]);
    assert.equal(result.squares[0].windows, 0);
    assert.equal(result.squares[0].hoppableEdges, 0);
});

// A missing partner must reject the complete projection, not expose partially imported doors.
test('rejects unknown placements, absent partners, mismatched partner type and conflicting room rectangles', async () => {
    const { projectWorldObjects } = await projectionModule();
    const map = await cell({ records: [2, -1, 0, -1, 63] });

    await assert.rejects(projectWorldObjects([map], registry([[['doorN', 'true']]])), /partner.*synthetic_2/i);
    await assert.rejects(projectWorldObjects([map], new Map()), /unknown.*synthetic_0/i);
    const wrong = registry([[['doorN', 'true']], [], []]);

    wrong.get('synthetic_2').tileType = 'tree';
    await assert.rejects(projectWorldObjects([map], wrong), /partner.*type/i);
    const wrongOpen = registry([[['doorN', 'true']], [], []]);

    wrongOpen.get('synthetic_2').properties.delete('open');
    await assert.rejects(projectWorldObjects([map], wrongOpen), /partner.*open/i);
    const conflict = await cell({ records: [2, -1, 0, -1, 63], rooms: [{ rects: [[0, 0, 1, 1]] }, { rects: [[0, 0, 1, 1]] }] });

    await assert.rejects(projectWorldObjects([conflict], registry([[['doorN', 'true']], [], []])), /conflicting.*room/i);
});

// Initial moved panels must reconstruct closed coordinates; partner rules are native sheet indices, not names guessed by texture.
test('projects ordinary, double and garage partner identities and initially open closed-base coordinates', async () => {
    const { projectWorldObjects } = await projectionModule();
    const tiles = Array.from({ length: 20 }, () => []);

    tiles[0] = [['doorW', 'true']];
    tiles[4] = [['doorN', 'true'], ['DoubleDoor', '2']];
    tiles[5] = [['doorN', 'true'], ['DoubleDoor', '2']];
    tiles[8] = [['doorN', 'true'], ['DoubleDoor', '6']];
    tiles[11] = [['doorW', 'true'], ['GarageDoor', '3']];
    tiles[19] = [['doorW', 'true'], ['GarageDoor', '6'], ['InteriorSide', 'false']];
    const map = await cell({ names: ['synthetic_2', 'synthetic_8', 'synthetic_19'], records: [2, -1, 0, 2, -1, 1, 2, -1, 2, -1, 61] });
    const result = await projectWorldObjects([map], registry(tiles));

    assert.deepEqual(result.doors.map(({ x, y, north, open, doubleDoor, garageDoor, interiorSide }) => ({ x, y, north, open, doubleDoor, garageDoor, interiorSide })), [
        { x: 0, y: 0, north: false, open: true, doubleDoor: 0, garageDoor: 0, interiorSide: false },
        { x: 1, y: 0, north: true, open: true, doubleDoor: 2, garageDoor: 0, interiorSide: false },
        { x: 0, y: 2, north: false, open: true, doubleDoor: 0, garageDoor: 3, interiorSide: true },
    ]);
    assert.deepEqual(result.doorVisuals.map(({ closedSpriteName, openSpriteName, sourceX, sourceY }) => [closedSpriteName, openSpriteName, sourceX, sourceY]), [
        ['synthetic_0', 'synthetic_2', 0, 0], ['synthetic_4', 'synthetic_8', 0, 1], ['synthetic_11', 'synthetic_19', 0, 2],
    ]);
    assert.equal(result.doorVisuals[1].toggledClosedSpriteName, 'synthetic_5');
    const moved = result.depthContexts['0,1,0,0'];

    assert.equal(moved.doorId, result.doors[1].id);
    assert.equal(moved.ownerId, '0,1,0,0');
    assert.equal(moved.sourceX, 0);
    assert.equal(moved.sourceY, 1);
    assert.equal(result.depthContexts['1,0,0,0'], undefined, 'canonical closed coordinates are not a placement lookup key');
    assert.equal(result.doorVisuals[1].toggledOpenSpriteName, 'synthetic_8');
});

// Native open double panels rotate N/W; requiring identical partner type rejects real source layouts.
test('accepts rotated native door partners while retaining closed-door orientation and actual open edge flags', async () => {
    const { projectWorldObjects } = await projectionModule();
    const tiles = registry([
        [['doorN', 'true'], ['DoubleDoor', '1']],
        [],
        [],
        [],
        [['doorW', 'true'], ['DoubleDoor', '6'], ['attachedE', 'true']],
        [['doorW', 'true'], ['DoubleDoor', '5'], ['attachedS', 'true']],
    ]);
    const map = await cell({ records: [2, -1, 0, -1, 63] });
    const result = await projectWorldObjects([map], tiles);

    assert.equal(result.doors[0].north, true);
    assert.equal(result.doors[0].open, false);
    assert.equal(result.doors[0].doubleDoor, 1);
    assert.equal(result.doors[0].attachedE, false);
    assert.equal(result.doors[0].attachedS, true);
    assert.equal(result.doorVisuals[0].closedSpriteName, 'synthetic_0');
    assert.equal(result.doorVisuals[0].openSpriteName, 'synthetic_4');
    assert.equal(result.doorVisuals[0].toggledOpenSpriteName, 'synthetic_5');
    assert.equal(tiles.get('synthetic_4').tileType, 'doorW');
});

// Eager Promise.all or absent-chunk reads fail the same production-facing API check.
test('reads only present chunks sequentially in deterministic cell/chunk order and keeps empty loaded squares', async () => {
    const { projectWorldObjects } = await projectionModule();
    const first = await cell({ records: [2, -1, 0, -1, 63] });
    const second = await cell({ records: [2, -1, 0, -1, 63], cellX: 1 });
    const reads = [];
    let active = false;
    /**
     * Wrap a parsed cell to observe sequential original chunk reads.
     *
     * @param {import('../src/map-tiles.js').MapCell} map - Source cell to observe.
     * @returns {import('../src/map-tiles.js').MapCell} Cell with an instrumented chunk reader.
     */
    const wrap = (map) => ({
        ...map,
        /**
         * Read a present chunk while detecting overlapping requests.
         *
         * @param {number} x - Cell-local chunk x.
         * @param {number} y - Cell-local chunk y.
         * @returns {Promise<import('../src/map-tiles.js').TilePlacement[]>} Original ordered placements.
         */
        readChunk: async (x, y) => {
            assert.equal(active, false);
            assert.equal(map.chunks[x * 32 + y].present, true);
            active = true;
            reads.push([map.cellX, x, y]);
            const rows = await map.readChunk(x, y);

            active = false;

            return rows;
        },
    });
    const result = await projectWorldObjects([wrap(second), wrap(first)], registry([[['normal', 'true']]]));

    assert.deepEqual(reads, [[0, 0, 0], [1, 0, 0]]);
    assert.equal(result.doors.length, 0);
    assert.equal(result.squares.length, 128);
    assert.equal(result.squares.filter(({ outside }) => outside).length, 128);
});

// Omitting a required source or changing source ordering must not silently invent a reduced registry.
test('loads every required original tile source in exact native order without reading texture banks', async () => {
    const { loadNativeTileRegistry } = await projectionModule();
    const paths = [
        'media/newtiledefinitions.tiles', 'media/tiledefinitions_erosion.tiles', 'media/tiledefinitions_overlays.tiles',
        'media/tiledefinitions_b42chunkcaching.tiles', 'media/tiledefinitions_noiseworks.patch.tiles', 'media/jumbo_trees_big.tiles', 'media/jumbo_trees.tiles',
    ];
    const requested = [];
    const sources = new Map(paths.map((path, index) => [path, new Blob([definitions([[['normal', 'true']]], `source${index}`)])]));
    const content = {
        /**
         * Resolve the exact synthetic native source, including missing entries.
         *
         * @param {string} path - Required native metadata path.
         * @returns {Promise<Blob|undefined>} Requested fixture or absent source.
         */
        getFile: (path) => {
            requested.push(path);

            return Promise.resolve(sources.get(path));
        },
    };
    const result = await loadNativeTileRegistry(content);

    assert.deepEqual(requested, paths);
    assert.equal(result.get('source0_0').id, 0);
    assert.equal(result.get('source1_0').id, 1_048_576);
    assert.equal(result.get('source2_0').id, 1_572_864);
    assert.equal(result.get('source3_0').id, 1_835_008);
    assert.equal(result.has('source4_0'), false);
    assert.equal(result.get('source5_0').id, 2_097_152);
    assert.equal(result.get('source6_0').id, 2_621_440);
    const casedPaths = paths.map((path) => path.replace('media/', 'Media/'));
    const casedSources = new Map(casedPaths.map((path, index) => [path, sources.get(paths[index])]));
    const fileIds = [1, 2, 4, 5, -1, 6, 8];
    const roleRows = casedPaths.map((path, index) => ({ path, fileId: fileIds[index] }));
    const cased = {
        manifest: { files: casedPaths.map((path) => ({ path })), startup: { tileDefinitions: [...roleRows].reverse() } },
        /**
         * Resolve metadata by the manifest's exact portable casing.
         *
         * @param {string} path - Manifest-indexed native metadata path.
         * @returns {Promise<Blob|undefined>} Requested fixture or absent source.
         */
        getFile: (path) => Promise.resolve(casedSources.get(path)),
    };

    assert.equal((await loadNativeTileRegistry(cased)).get('source6_0').id, 2_621_440);
    const legacy = { ...cased, manifest: { files: cased.manifest.files, startup: {} } };

    assert.equal((await loadNativeTileRegistry(legacy)).get('source6_0').id, 2_621_440);
    cased.manifest.startup.tileDefinitions[0].fileId = 99;
    await assert.rejects(loadNativeTileRegistry(cased), /required.*fileid/i);
    cased.manifest.startup.tileDefinitions[0].fileId = 8;
    const stringRoles = { ...cased, manifest: { ...cased.manifest, startup: { tileDefinitions: casedPaths } } };

    await assert.rejects(loadNativeTileRegistry(stringRoles), /required.*record/i);
    cased.manifest.files.push({ path: paths[0] });
    await assert.rejects(loadNativeTileRegistry(cased), /unambiguous.*source/i);
    cased.manifest.files.pop();
    cased.manifest.startup.tileDefinitions.pop();
    await assert.rejects(loadNativeTileRegistry(cased), /required.*newtiledefinitions/i);
    sources.delete(paths[3]);
    await assert.rejects(loadNativeTileRegistry(content), /required.*media\/tiledefinitions_b42chunkcaching\.tiles/i);
});

// Source property aggregation is separate from constructor class/state and raw collision.
test('blocked-square projection distinguishes lower flags, frames, destroyed windows and constructor priority', async () => {
    const { projectWorldObjects } = await projectionModule();
    const subject = await createEngine(await readFile(new URL(
        '../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url,
    )));
    const north = { x: 0, y: 0, z: 0 };
    const from = { x: 0, y: 1, z: 0 };
    const cases = [
        { tiles: [[['WindowN', 'false']]], placed: 0, blocked: true, window: false, actual: false, label: 'uppercase frame remains a wall, not an IsoWindow' },
        { tiles: [[['windowN', 'false'], ['collideN', 'false'], ['lightswitch', 'false']]], placed: 0, blocked: false, window: true, actual: false, label: 'earlier lightswitch constructor retains lower flag only' },
        { tiles: [[['windowN', 'false'], ['collideN', 'false'], ['open', 'false']]], placed: 0, blocked: true, window: true, actual: true, label: 'IsoWindow constructor starts closed despite sprite open flag' },
        { tiles: [[['windowN', 'false'], ['collideN', 'false'], ['SmashedTileOffset', '1'], ['GlassRemovedOffset', '2']], [], []], placed: 1, blocked: false, window: true, actual: false, label: 'setSmashed destroys actual window' },
        { tiles: [[['windowN', 'false'], ['collideN', 'false'], ['SmashedTileOffset', '1'], ['GlassRemovedOffset', '2']], [], []], placed: 2, blocked: false, window: true, actual: false, label: 'setSmashed then setGlassRemoved preserves destroyed state' },
        { tiles: [[['windowN', 'false'], ['blueprint', 'false']]], placed: 0, blocked: true, window: false, actual: true, label: 'blueprint skips square flags but not actual window lookup' },
    ];

    const projections = await Promise.all(cases.map(async ({ tiles, placed, ...expected }) => {
        const map = await cell({ names: [`synthetic_${placed}`], records: [-1, 1, 2, -1, 0, -1, 62] });
        const projection = await projectWorldObjects([map], registry(tiles));

        return { projection, ...expected };
    }));

    for (const { projection, blocked, window, actual, label } of projections) {
        const props = projection.squares.find((row) => row.x === 0 && row.y === 1).interactionProperties;

        assert.equal(props.windowN === true, window, label);
        assert.equal(props.blockedWindowN === true, actual, label);
        subject.importDoors(projection.doors, { squares: projection.squares });
        assert.equal(subject.isBlockedTo(from, north), blocked, label);
        assert.equal(subject.isBlockedTo(north, from), blocked, label);
    }
});

test('blocked-square projection reads final surviving shared properties and cached types after blueprint exclusion', async () => {
    const { projectWorldObjects } = await projectionModule();
    const subject = await createEngine(await readFile(new URL(
        '../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url,
    )));
    const tiles = registry([[['windowN', 'false'], ['collideN', 'false'], ['OpenTileOffset', '1']], []]);
    const earlier = await cell({ names: ['synthetic_1'], records: [-1, 1, 2, -1, 0, -1, 62] });
    const later = await cell({ cellX: 1, records: [2, -1, 0, -1, 63] });
    const projection = await projectWorldObjects([later, earlier], tiles);
    const earlierSquare = projection.squares.find((row) => row.x === 0 && row.y === 1);

    assert.equal(earlierSquare.independentWalls, 0, 'legacy raw placement collision is unchanged');
    assert.equal(earlierSquare.interactionProperties.collideN, true);
    assert.equal(earlierSquare.interactionProperties.windowN, true);
    assert.notEqual(earlierSquare.interactionProperties.blockedWindowN, true, 'later mutation cannot turn earlier generic class into a window');
    subject.importDoors(projection.doors, { squares: projection.squares });
    assert.equal(subject.isBlockedTo({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 0 }), false);

    const cases = [
        { properties: [['stairsTN', 'false']], blocked: true },
        { properties: [['stairsTN', 'false'], ['lightswitch', 'false']], blocked: false },
        { properties: [['stairsTN', 'false'], ['blueprint', 'false']], blocked: false },
    ];

    const stairProjections = await Promise.all(cases.map(async ({ properties, blocked }) => {
        const map = await cell({ records: [-1, 1, 2, -1, 0, -1, 62] });
        const projected = await projectWorldObjects([map], registry([properties]));

        return { projected, blocked };
    }));

    for (const { projected, blocked } of stairProjections) {
        subject.importDoors(projected.doors, { squares: projected.squares });
        assert.equal(subject.isBlockedTo({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 0 }), blocked);
        assert.equal(subject.isBlockedTo({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }), false);
    }

    const map = await cell({ names: ['synthetic_0', 'synthetic_1'], records: [-1, 1, 3, -1, 0, 1, -1, 62] });
    const replaced = await projectWorldObjects([map], registry([[['tree', '1'], ['collideN', 'false']], [['tree', '1']]]));

    assert.equal(replaced.squares.find((row) => row.x === 0 && row.y === 1).independentWalls, 2);
    subject.importDoors(replaced.doors, { squares: replaced.squares });
    assert.equal(subject.isBlockedTo({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 0 }), false, 'removed tree contributes no current collision properties');
});

test('blocked-square source door properties switch with native current sprite instead of stale base aggregation', async () => {
    const { projectWorldObjects } = await projectionModule();
    const subject = await createEngine(await readFile(new URL(
        '../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url,
    )));
    const navigation = new Uint8Array(1_026);

    navigation[1] = 1;
    subject.worldImportCell(0, 0, navigation);
    const tiles = registry([[['doorN', 'false'], ['collideW', 'false']], [], []]);
    const projection = await projectWorldObjects([await cell({ records: [-1, 1, 2, -1, 0, -1, 62] })], tiles);
    const from = { x: 0, y: 1, z: 0 };
    const west = { x: -1, y: 1, z: 0 };
    const extraSquare = { ...projection.squares[0], ...west };

    assert.deepEqual(projection.doors[0].interactionProperties.map((props) => props.collideW === true), [true, false, true, false]);
    assert.notEqual(projection.squares.find((row) => row.x === 0 && row.y === 1).interactionProperties.collideW, true);
    const standing = projection.squares.filter((square) => square.x !== 0 || square.y !== 0);

    standing.push({
        x: 0, y: 0, z: 0, roomId: -1, outside: true, solid: false, solidTrans: false,
        tree: false, independentWalls: 0, vehicleObstructed: false, solidFloor: true,
    });
    subject.importDoors(projection.doors, { squares: [...standing, extraSquare] });
    assert.equal(subject.isBlockedTo(from, west), true);
    subject.loadState({ version: 2, values: [0.5, 0.5, 1.5, 0.5, 0.5, 0, 0, 0, 0, 1, 100, 1] });
    subject.toggleDoor(projection.doors[0].id);
    completeActions(subject);
    assert.equal(subject.isBlockedTo(from, west), false, 'open door is unblocked and its actual open sprite has no west wall');
    subject.toggleDoor(projection.doors[0].id);
    completeActions(subject);
    assert.equal(subject.isBlockedTo(from, west), true);
});

test('four source door relation snapshots use genuine distinct initial and toggled partners without constructor merging', async () => {
    const { projectWorldObjects } = await projectionModule();
    const tiles = Array.from({ length: 11 }, () => []);

    tiles[0] = [['doorN', 'false'], ['DoubleDoor', '1'], ['collideN', 'false']];
    tiles[4] = [['doorW', 'false'], ['DoubleDoor', '6'], ['windowW', 'false']];
    tiles[5] = [['doorW', 'false'], ['DoubleDoor', '5'], ['WindowW', 'false'], ['doorW', 'false']];
    tiles[6] = [['doorN', 'false'], ['DoubleDoor', '2'], ['windowN', 'false']];
    tiles[7] = [['doorN', 'false'], ['DoubleDoor', '2'], ['collideW', 'false'], ['blueprint', 'false']];
    tiles[10] = [['doorN', 'false'], ['DoubleDoor', '6'], ['collideW', 'false']];
    const map = await cell({ names: ['synthetic_0', 'synthetic_10'], records: [2, -1, 0, 2, -1, 1, -1, 62] });
    const projected = await projectWorldObjects([map], registry(tiles));

    assert.deepEqual(projected.doors.map((door) => door.interactionProperties), [
        [{ collideN: true }, { windowW: true }, { collideN: true }, { collideW: true }],
        [{ windowN: true }, { collideW: true }, {}, { collideW: true }],
    ]);
    assert.deepEqual(projected.squares.slice(0, 2).map((square) => square.interactionProperties), [{}, {}],
        'base excludes every actual door contribution');
});

test('shared current type mutations rebuild source stair caches without changing an earlier object class', async () => {
    const { projectWorldObjects } = await projectionModule();
    const subject = await createEngine(await readFile(new URL(
        '../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url,
    )));
    const tiles = registry([[['windowN', 'false'], ['stairsTN', 'false'], ['OpenTileOffset', '1']], []]);
    const earlier = await cell({ names: ['synthetic_1'], records: [-1, 1, 2, -1, 0, -1, 62] });
    const later = await cell({ cellX: 1, records: [2, -1, 0, -1, 63] });
    const projected = await projectWorldObjects([earlier, later], tiles);
    const props = projected.squares.find((row) => row.x === 0 && row.y === 1).interactionProperties;

    assert.equal(props.stairsTN, true, 'RecalcProperties uses final shared getType, not creation-time type or property spelling');
    assert.notEqual(props.blockedWindowN, true, 'earlier generic object remains generic after shared mutation');
    subject.importDoors(projected.doors, { squares: projected.squares });
    assert.equal(subject.isBlockedTo({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 0 }), true);
    assert.equal(subject.isBlockedTo({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }), false);
});

test('actual window facing and blocked state survive unrelated current sprite replacement', async () => {
    const { projectWorldObjects } = await projectionModule();
    const subject = await createEngine(await readFile(new URL(
        '../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url,
    )));
    const both = await projectWorldObjects([await cell({ records: [-1, 9, 2, -1, 0, -1, 54] })],
        registry([[['windowN', 'false'], ['windowW', 'false'], ['collideN', 'false'], ['collideW', 'false']]]));
    const from = { x: 1, y: 1, z: 0 };

    subject.importDoors(both.doors, { squares: both.squares });
    assert.equal(subject.isBlockedTo(from, { x: 1, y: 0, z: 0 }), true, 'constructor is north-first');
    assert.equal(subject.isBlockedTo(from, { x: 0, y: 1, z: 0 }), false, 'opposite lower flag does not invent west actual blockage');
    const map = await cell({ names: ['synthetic_0', 'synthetic_1'], records: [-1, 9, 3, -1, 0, 1, -1, 54] });
    const replaced = await projectWorldObjects([map], registry([
        [['windowN', 'false'], ['solidfloor', 'false'], ['diamondFloor', 'false']],
        [['solidfloor', 'false'], ['diamondFloor', 'false']],
    ]));
    const props = replaced.squares.find((row) => row.x === 1 && row.y === 1).interactionProperties;

    assert.notEqual(props.windowN, true, 'final replacement sprite has no window resemblance');
    assert.equal(props.blockedWindowN, true, 'setSprite does not destroy or open the surviving actual IsoWindow');
    subject.importDoors(replaced.doors, { squares: replaced.squares });
    assert.equal(subject.isBlockedTo(from, { x: 1, y: 0, z: 0 }), true);
});

// Reach walls are surviving-object cut/Wall flags, not raw collision or ignored overlay placements.
test('reach wall facts preserve property presence while excluding door walls, southeast walls and discarded objects', async () => {
    const { projectWorldObjects } = await projectionModule();
    const tiles = registry([
        [['cutN', '']],
        [['WallW', 'false']],
        [['cutN', 'false'], ['DoorWallN', '']],
        [['WallW', ''], ['DoorWallW', 'false']],
        [['cutN', ''], ['WallSE', 'false']],
        [['collideN', 'false']],
        [['cutN', 'false'], ['blueprint', 'false']],
        [['cutN', ''], ['FloorOverlay', 'false']],
        [['cutN', ''], ['solidfloor', 'false'], ['diamondFloor', 'false']],
        [['solidfloor', 'false'], ['diamondFloor', 'false']],
    ]);
    const map = await cell({
        names: Array.from({ length: 10 }, (_, index) => `synthetic_${index}`),
        records: [...Array.from({ length: 8 }, (_, index) => [2, -1, index]).flat(), 3, -1, 8, 9, -1, 55],
    });
    const projection = await projectWorldObjects([map], tiles);

    assert.deepEqual(projection.squares.slice(0, 9).map((square) => square.reachWalls), [
        { north: true, west: false }, { north: false, west: true },
        { north: false, west: false }, { north: false, west: false },
        { north: false, west: false }, { north: false, west: false },
        { north: true, west: false }, { north: false, west: false },
        { north: false, west: false },
    ]);
    assert.deepEqual(projection.squares[9].reachWalls, { north: false, west: false }, 'loaded empty square is known empty');
    assert.throws(() => {
        projection.squares[0].reachWalls.north = false;
    }, TypeError);
    await assert.rejects(projectWorldObjects([map], new Map()), /unknown original sprite/iu);
});

// Four independent real partners, including initially-open special doors, must not share constructor facts.
test('door reach wall snapshots use actual four current sprites separately from non-door square facts', async () => {
    const { projectWorldObjects } = await projectionModule();
    const tiles = Array.from({ length: 11 }, () => []);

    tiles[0] = [['doorN', 'false'], ['DoubleDoor', '1'], ['cutN', '']];
    tiles[4] = [['doorW', 'false'], ['DoubleDoor', '6'], ['cutW', 'false']];
    tiles[5] = [['doorW', 'false'], ['DoubleDoor', '5'], ['cutN', ''], ['DoorWallN', 'false']];
    tiles[6] = [['doorN', 'false'], ['DoubleDoor', '2'], ['cutN', 'false'], ['DoorWallN', '']];
    tiles[7] = [['doorN', 'false'], ['DoubleDoor', '2'], ['cutW', ''], ['blueprint', 'false']];
    tiles[10] = [['doorN', 'false'], ['DoubleDoor', '6'], ['cutN', ''], ['WallSE', 'false']];
    const map = await cell({ names: ['synthetic_0', 'synthetic_10'], records: [2, -1, 0, 2, -1, 1, -1, 62] });
    const projected = await projectWorldObjects([map], registry(tiles));

    assert.deepEqual(projected.doors.map((door) => door.reachWalls), [
        [{ north: true, west: false }, { north: false, west: true }, { north: true, west: false }, { north: false, west: false }],
        [{ north: false, west: false }, { north: false, west: false }, { north: false, west: true }, { north: false, west: false }],
    ]);
    assert.deepEqual(projected.squares.slice(0, 2).map((square) => square.reachWalls),
        [{ north: false, west: false }, { north: false, west: false }], 'base excludes all actual doors');
    assert.throws(() => {
        projected.doors[0].reachWalls[0].north = false;
    }, TypeError);
    assert.throws(() => projected.doors[0].reachWalls.push({ north: false, west: false }), TypeError);
});

// Capability follows each current sprite's actual flags but always uses the constructor's fixed closed-sprite sound.
test('curtain capability snapshots distinguish transparency, garage presence and fixed closed-sprite sound across open states', async () => {
    const { projectWorldObjects } = await projectionModule();
    const cases = [
        {
            label: 'default WoodDoor and textual false transparency',
            tiles: [[['doorN', 'false'], ['doorTrans', 'false']], [], [['doorTrans', '']]],
            placed: 0, expected: [true, true, true, true],
        },
        {
            label: 'current sprite transparency is not copied from closed',
            tiles: [[['doorN', 'false'], ['doorTrans', '']], [], []],
            placed: 0, expected: [true, false, true, false],
        },
        {
            label: 'garage property presence excludes both real panels',
            tiles: [
                [['doorN', 'false'], ['GarageDoor', '1'], ['doorTrans', '']], [], [], [], [], [], [], [],
                [['doorN', 'false'], ['GarageDoor', '4'], ['doorTrans', 'false']],
            ],
            placed: 0, expected: [false, false, false, false],
        },
        {
            label: 'mixed-case SlidingGlassDoor sound on closed excludes an initially open door',
            tiles: [
                [['doorN', 'false'], ['doorTrans', ''], ['DoorSound', 'sLiDiNgGlAsSdOoR']], [],
                [['doorTrans', ''], ['DoorSound', 'WoodDoor']],
            ],
            placed: 2, expected: [false, false, false, false],
        },
        {
            label: 'open SlidingGlassDoor sound cannot replace fixed closed WoodDoor sound',
            tiles: [
                [['doorN', 'false'], ['doorTrans', ''], ['DoorSound', 'WoodDoor']], [],
                [['doorTrans', ''], ['DoorSound', 'SlidingGlassDoor']],
            ],
            placed: 2, expected: [true, true, true, true],
        },
        {
            label: 'opaque current sprites remain ineligible even with default sound',
            tiles: [[['doorN', 'false']], [], []],
            placed: 0, expected: [false, false, false, false],
        },
        {
            label: 'special toggled current partner changes capability without changing constructor sound',
            tiles: [
                [['doorN', 'false'], ['DoubleDoor', '1'], ['doorTrans', ''], ['DoorSound', 'WoodDoor']], [], [], [],
                [['doorW', 'false'], ['DoubleDoor', '6'], ['doorTrans', 'false'], ['DoorSound', 'SlidingGlassDoor']],
                [['doorW', 'false'], ['DoubleDoor', '5'], ['doorTrans', ''], ['GarageDoor', '1']],
            ],
            placed: 0, expected: [true, true, true, false],
        },
    ];
    const results = await Promise.all(cases.map(async ({ tiles, placed, expected, label }) => {
        const map = await cell({ names: [`synthetic_${placed}`], records: [2, -1, 0, -1, 63] });
        const projection = await projectWorldObjects([map], registry(tiles));

        return { projection, expected, label };
    }));

    for (const { projection, expected, label } of results) {
        assert.deepEqual(projection.doors[0].curtainCapabilities, expected, label);
        assert.throws(() => {
            projection.doors[0].curtainCapabilities[0] = false;
        }, TypeError);
    }
});

// Shared window property copies do not rewrite the source sprite's cached cut fields.
test('reach walls retain cached cuts across later shared window mutation and real smashed or glass current sprites', async () => {
    const { projectWorldObjects } = await projectionModule();
    const tiles = registry([
        [['windowN', 'false'], ['cutW', 'false'], ['OpenTileOffset', '1'], ['SmashedTileOffset', '2'], ['GlassRemovedOffset', '3']],
        [], [], [['cutW', 'false']],
    ]);
    const earlier = await cell({ names: ['synthetic_1'], records: [-1, 1, 2, -1, 0, -1, 62] });
    const later = await cell({
        cellX: 1, names: ['synthetic_0', 'synthetic_2', 'synthetic_3'],
        records: [2, -1, 0, 2, -1, 1, 2, -1, 2, -1, 61],
    });
    const projection = await projectWorldObjects([later, earlier], tiles);
    const earlierSquare = projection.squares.find(({ x, y }) => x === 0 && y === 1);

    assert.equal(earlierSquare.interactionProperties.windowN, true, 'later constructor really copied current properties onto the earlier generic sprite');
    assert.deepEqual(earlierSquare.reachWalls, { north: false, west: false }, 'copied cutN property is not a cached cut field');
    assert.deepEqual(projection.squares.filter(({ x, y }) => x === 256 && y <= 2).map(({ reachWalls }) => reachWalls), [
        { north: false, west: true }, { north: false, west: false }, { north: false, west: true },
    ]);
    assert.notEqual(projection.squares.find(({ x, y }) => x === 256 && y === 1).interactionProperties.blockedWindowN, true,
        'the smashed partner is the actual destroyed current sprite');
    assert.notEqual(projection.squares.find(({ x, y }) => x === 256 && y === 2).interactionProperties.blockedWindowN, true,
        'the glass-removed partner is the actual destroyed current sprite');

    const doorTiles = registry([
        [['doorN', 'false']], [], [],
        [['windowN', 'false'], ['OpenTileOffset', '-1']],
    ]);
    const doorCell = await cell({ records: [2, -1, 0, -1, 63] });
    const windowCell = await cell({ cellX: 1, names: ['synthetic_3'], records: [2, -1, 0, -1, 63] });
    const doorProjection = await projectWorldObjects([windowCell, doorCell], doorTiles);

    assert.equal(doorProjection.doors[0].interactionProperties[1].windowN, true, 'later window really mutates the retained open-door partner properties');
    assert.deepEqual(doorProjection.doors[0].reachWalls, [
        { north: false, west: false }, { north: false, west: false },
        { north: false, west: false }, { north: false, west: false },
    ], 'all four door snapshots use cached cuts rather than copied cut properties');
    const states = doorProjection.depthContexts['0,0,0,0'].doorSprites;

    assert.equal(states.synthetic_2.spriteProperties.windowN, 'true', 'dynamic door snapshots preserve later shared constructor mutations');
    assert.equal(states.synthetic_2.wallDirection, undefined, 'copied flags are not cached cuts on the substituted sprite');
    assert.equal(states.synthetic_0.wallDirection, 'N');
    assert.equal(Object.isFrozen(states.synthetic_2.spriteProperties), true);
});

// Class metadata comes from the ordered CellLoader constructor, not a property-name heuristic.
test('depth contexts preserve exact source constructors and excluded campfire names', async () => {
    const { projectWorldObjects } = await projectionModule();
    const fixtures = [
        { props: [['container', 'barbecue']], expected: 'IsoBarbecue' },
        { props: [['container', 'barbecuepropane']], expected: 'IsoBarbecue' },
        { props: [['container', 'Barbecue']], expected: 'IsoObject' },
        { props: [['container', 'fireplace'], ['tree', '1']], expected: 'IsoFireplace' },
        { props: [['container', 'woodstove']], expected: 'IsoFireplace' },
        { props: [['container', 'brazier']], expected: 'IsoFireplace' },
        { props: [['container', 'campfire']], expected: 'IsoFireplace' },
        { props: [['container', 'campfire']], name: 'camping_01_04', expected: 'IsoObject' },
        { props: [['container', 'campfire']], name: 'camping_01_05', expected: 'IsoObject' },
        { props: [['container', 'campfire']], name: 'camping_01_06', expected: 'IsoObject' },
        { props: [['container', 'campfire']], name: 'camping_01_4', expected: 'IsoFireplace' },
        { props: [['tree', '1']], expected: 'IsoTree' },
        { props: [['tree', '1'], ['CustomName', 'Mannequin']], expected: 'IsoMannequin' },
        { props: [['IsoType', 'IsoFire']], expected: 'IsoObject' },
        { props: [['lightswitch', 'true'], ['container', 'barbecue']], expected: 'IsoLightSwitch' },
        { props: [['windowN', 'true'], ['container', 'fireplace']], expected: 'IsoWindow' },
    ];

    await Promise.all(fixtures.map(async ({ props, name = 'synthetic_0', expected }) => {
        const tiles = registry([props]);

        if (name !== 'synthetic_0') {
            tiles.set(name, { ...tiles.get('synthetic_0'), name });
        }

        const projection = await projectWorldObjects([await cell({ names: [name] })], tiles);
        const context = projection.depthContexts['0,0,0,0'];

        assert.equal(context.objectClass, expected, name);
        assert.equal(context.sourceObjectClass, expected);
        assert.equal(context.isParentSprite, true);
        assert.equal(context.parentSpriteName, name);
        assert.equal(context.rendered, true);
        assert.deepEqual([context.scaleX, context.scaleY, context.soffX, context.soffY], [1, 1, 0, 0]);
        assert.equal(Object.isFrozen(context), true);
    }));
});

// Flattening by sprite name loses both attachment ownership and replaced placement identity.
test('depth contexts retain attachment hosts and retire replaced floors, attachments, and trees', async () => {
    const { projectWorldObjects } = await projectionModule();
    const tiles = registry([
        [['solidfloor', 'true'], ['diamondFloor', 'true'], ['container', 'fireplace']],
        [['FloorOverlay', 'true']],
        [['solidfloor', 'true'], ['diamondFloor', 'true']],
        [['FloorOverlay', 'true']],
        [['tree', '1']],
        [['tree', '1']],
        [['WallW', 'true']],
        [['WallOverlay', 'true'], ['attachedW', 'true']],
        [['WallOverlay', 'true'], ['attachedN', 'true']],
    ]);
    const map = await cell({
        names: [...tiles.keys()],
        records: [10, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, -1, 63],
    });
    const { depthContexts } = await projectWorldObjects([map], tiles);
    /**
     * Look up an original placement's final depth context.
     *
     * @param {number} order - Original placement order on the square.
     * @returns {object} Frozen projected depth context.
     */
    const context = (order) => depthContexts[`0,0,0,${order}`];

    assert.equal(Object.isFrozen(depthContexts), true);
    assert.equal(context(0).rendered, false, 'replaced floor placement is not independently drawn');
    assert.equal(context(1).rendered, false, 'setSprite clears old attached sprites');
    assert.equal(context(2).ownerId, context(0).ownerId, 'diamond replacement preserves the original owner class and identity');
    assert.equal(context(2).objectClass, 'IsoFireplace', 'replacement never reconstructs a generic owner from the new sprite');
    assert.equal(context(2).isParentSprite, true);
    assert.equal(context(3).rendered, true);
    assert.equal(context(3).isParentSprite, false);
    assert.equal(context(3).ownerId, context(2).ownerId);
    assert.equal(context(3).parentSpriteName, 'synthetic_2');
    assert.equal(context(4).rendered, false, 'second tree removes first actual tree');
    assert.equal(context(5).objectClass, 'IsoTree');
    assert.equal(context(7).ownerId, context(6).ownerId);
    assert.equal(context(7).isParentSprite, false);
    assert.equal(context(8).isParentSprite, true, 'unmatched wall overlay creates its own IsoObject');
    assert.equal(context(8).objectClass, 'IsoObject');
});

test('depth contexts use original placement identity for initially open door visuals', async () => {
    const { projectWorldObjects } = await projectionModule();
    const tiles = registry([[['doorN', 'true']], [], [['attachedS', 'true']]]);
    const map = await cell({ names: ['synthetic_2'] });
    const projection = await projectWorldObjects([map], tiles);
    const visual = projection.doorVisuals[0];
    const context = projection.depthContexts[`${visual.sourceX},${visual.sourceY},0,${visual.order}`];

    assert.equal(context.objectClass, 'IsoDoor');
    assert.equal(context.doorId, visual.id);
    assert.equal(context.isMainSprite, true);
    assert.equal(Object.isFrozen(context.doorSprites), true);
    assert.equal(context.doorSprites.synthetic_2.wallDirection, 'N');
    assert.equal(context.sourceSpriteName, visual.sourceSpriteName);
    assert.equal(context.ownerId, '0,0,0,0');
});

// A tree flag surviving a later object type is not an IsoTree; natural trees require a real natural floor.
test('depth class selection distinguishes tree types, natural-floor gates, and unattached floor overlays', async () => {
    const { projectWorldObjects } = await projectionModule();
    const tiles = registry([[['tree', '1'], ['wall', 'true']], [['FloorOverlay', 'true']]]);
    const map = await cell({ names: ['synthetic_0', 'synthetic_1'], records: [3, -1, 0, 1, -1, 63] });
    const projection = await projectWorldObjects([map], tiles);

    assert.equal(projection.depthContexts['0,0,0,0'].objectClass, 'IsoObject');
    assert.equal(projection.depthContexts['0,0,0,1'].rendered, false);
    assert.equal(Object.hasOwn(projection.depthContexts['0,0,0,1'], 'objectClass'), false);
    const natural = createTileRegistry([
        { path: 'floor.tiles', fileId: 1, buffer: definitions([[['solidfloor', 'true']]], 'blends_natural_01') },
        { path: 'tree.tiles', fileId: 2, buffer: definitions([[['tree', '1']]], 'vegetation_trees_01') },
    ]);

    await Promise.all([false, true].map(async (hasFloor) => {
        const names = hasFloor ? ['blends_natural_01_0', 'vegetation_trees_01_0'] : ['vegetation_trees_01_0'];
        const result = await projectWorldObjects([await cell({
            names, records: [names.length + 1, -1, ...names.map((_, index) => index), -1, 63],
        })], natural);

        assert.equal(result.depthContexts[`0,0,0,${names.length - 1}`].rendered, hasFloor);
    }));
});

// Chunk boundaries create extra native draws, never a replacement depth mode on every floor.
test('depth contexts select ordered floor and wall seam draws from actual neighbor objects', async () => {
    const { projectWorldObjects } = await projectionModule();
    const tiles = registry([
        [['solidfloor', 'true'], ['FloorHeightOneThird', 'true'], ['FloorHeightTwoThirds', 'true']],
        [['FloorOverlay', 'true']],
        [['WallNW', 'true']],
        [['solidfloor', 'true'], ['WallW', 'true']],
        [['solidfloor', 'true'], ['WallN', 'true']],
    ]);
    const base = await cell();
    const rows = [
        { x: 7, y: 7, z: 0, order: 0, spriteName: 'synthetic_0' },
        { x: 7, y: 7, z: 0, order: 1, spriteName: 'synthetic_1' },
        { x: 7, y: 7, z: 0, order: 2, spriteName: 'synthetic_2' },
        { x: 7, y: 8, z: 0, order: 0, spriteName: 'synthetic_3' },
        { x: 8, y: 7, z: 0, order: 0, spriteName: 'synthetic_4' },
    ];
    const scene = {
        ...base,
        chunks: [[0, 0], [0, 1], [1, 0]].map(([chunkX, chunkY]) => ({ chunkX, chunkY, present: true })),
        /**
         * Return the authored placements belonging to this native-size chunk.
         *
         * @param {number} x - Local chunk x coordinate.
         * @param {number} y - Local chunk y coordinate.
         * @returns {Promise<object[]>} Matching original placements.
         */
        readChunk: (x, y) => Promise.resolve(rows.filter((row) => Math.floor(row.x / 8) === x && Math.floor(row.y / 8) === y)),
    };
    const { depthContexts } = await projectWorldObjects([scene], tiles);

    assert.deepEqual(depthContexts['7,7,0,0'].seams, [
        { name: 'FloorSouthTwoThirds', screenOffset: { x: -6, y: 3 } },
        { name: 'FloorEastTwoThirds', screenOffset: { x: 6, y: 3 } },
    ]);
    assert.deepEqual(depthContexts['7,7,0,1'].seams, [], 'attached floor sprite is not getFloor()');
    assert.deepEqual(depthContexts['7,7,0,2'].seams, [
        { name: 'WallEast', screenOffset: { x: 6, y: 3 }, direction: 'NW' },
        { name: 'WallSouth', screenOffset: { x: -6, y: 3 }, direction: 'NW' },
    ]);
    assert.equal(depthContexts['7,7,0,2'].wallDirection, 'NW');
    assert.equal(Object.isFrozen(depthContexts['7,7,0,0'].seams[0].screenOffset), true);
});

test('depth seams reject orphan overlays as actual floor or wall neighbors', async () => {
    const { projectWorldObjects } = await projectionModule();
    const base = await cell();

    await Promise.all([[['WallW', 'true'], ['HoppableW', 'true']], [['WallW', 'true']]].map(async (props) => {
        const tiles = registry([props, [['FloorOverlay', 'true']]]);
        const scene = {
            ...base,
            chunks: [{ chunkX: 0, chunkY: 0, present: true }, { chunkX: 0, chunkY: 1, present: true }],
            /**
             * Return the authored wall or orphan overlay for this chunk.
             *
             * @param {number} x - Local chunk x coordinate.
             * @param {number} y - Local chunk y coordinate.
             * @returns {Promise<object[]>} Original chunk placements.
             */
            readChunk: (x, y) => Promise.resolve(y === 0
                ? [{ x: 0, y: 7, z: 0, order: 0, spriteName: 'synthetic_0' }]
                : [{ x: 0, y: 8, z: 0, order: 0, spriteName: 'synthetic_1' }]),
        };
        const projection = await projectWorldObjects([scene], tiles);

        assert.deepEqual(projection.depthContexts['0,7,0,0'].seams, [], 'an orphan overlay is neither a wall nor a floor');
    }));
});

test('depth wall seams honor exact hoppable and original sheet exclusions without prefix guesses', async () => {
    const { projectWorldObjects } = await projectionModule();
    const base = await cell();
    const cases = [
        { name: 'synthetic', index: 0, extra: [], expected: 1 },
        { name: 'synthetic', index: 0, extra: [['HoppableW', 'false']], expected: 0 },
        { name: 'walls_logs', index: 0, extra: [], expected: 0 },
        { name: 'walls_logs_extra', index: 0, extra: [], expected: 1 },
        { name: 'carpentry_02', index: 79, extra: [], expected: 1 },
        { name: 'carpentry_02', index: 80, extra: [], expected: 0 },
        { name: 'carpentry_02', index: 82, extra: [], expected: 0 },
        { name: 'carpentry_02', index: 83, extra: [], expected: 1 },
    ];

    await Promise.all(cases.map(async ({ name, index, extra, expected }) => {
        const rows = Array.from({ length: index + 1 }, () => []);

        rows[index] = [['WallW', 'true'], ...extra];
        const tiles = createTileRegistry([
            { path: 'subject.tiles', fileId: 1, buffer: definitions(rows, name) },
            { path: 'neighbor.tiles', fileId: 2, buffer: definitions([[['WallW', 'true']]], 'neighbor') },
        ]);
        const scene = {
            ...base,
            chunks: [{ chunkX: 0, chunkY: 0, present: true }, { chunkX: 0, chunkY: 1, present: true }],
            /**
             * Return the exact subject or neighboring wall sprite.
             *
             * @param {number} x - Local chunk x coordinate.
             * @param {number} y - Local chunk y coordinate.
             * @returns {Promise<object[]>} Original chunk placements.
             */
            readChunk: (x, y) => Promise.resolve([{
                x: 0, y: y === 0 ? 7 : 8, z: 0, order: 0, spriteName: y === 0 ? `${name}_${index}` : 'neighbor_0',
            }]),
        };
        const projection = await projectWorldObjects([scene], tiles);

        assert.equal(projection.depthContexts['0,7,0,0'].seams.length, expected, `${name}_${index}`);
    }));
});

test('future shoreline and water-neighbor scenes require actual native policy rather than guessing false', async () => {
    const { projectWorldObjects } = await projectionModule();
    const base = await cell();
    const tiles = createTileRegistry([
        { path: 'natural.tiles', fileId: 1, buffer: definitions([[['solidfloor', 'true']]], 'blends_natural_01') },
        { path: 'water.tiles', fileId: 2, buffer: definitions([[['solidfloor', 'true'], ['water', 'true']]], 'water') },
    ]);
    const scene = {
        ...base,
        chunks: [{ chunkX: 0, chunkY: 0, present: true }, { chunkX: 0, chunkY: 1, present: true }],
        /**
         * Return original natural-floor or neighboring water placements.
         *
         * @param {number} x - Local chunk x coordinate.
         * @param {number} y - Local chunk y coordinate.
         * @returns {Promise<object[]>} Original chunk placements.
         */
        readChunk: (x, y) => Promise.resolve([{
            x: 0, y: y === 0 ? 7 : 8, z: 0, order: 0, spriteName: y === 0 ? 'blends_natural_01_0' : 'water_0',
        }]),
    };

    await assert.rejects(projectWorldObjects([scene], tiles), /shoreline.*IsoWaterFlow.*shader policy/iu);
    const nonNatural = registry([[['solidfloor', 'true']], [['solidfloor', 'true'], ['water', 'true']]]);
    const waterNeighbor = {
        ...scene,
        /**
         * Return non-natural floor or neighboring water placements.
         *
         * @param {number} x - Local chunk x coordinate.
         * @param {number} y - Local chunk y coordinate.
         * @returns {Promise<object[]>} Original chunk placements.
         */
        readChunk: (x, y) => Promise.resolve([{
            x: 0, y: y === 0 ? 7 : 8, z: 0, order: 0, spriteName: y === 0 ? 'synthetic_0' : 'synthetic_1',
        }]),
    };

    await assert.rejects(projectWorldObjects([waterNeighbor], nonNatural), /water-neighbor.*waterQuality/iu);
});

test('attached overlays preserve garage and moving double-door owners with exact current partner geometry', async () => {
    const { projectWorldObjects } = await projectionModule();

    await Promise.all([false, true].map(async (double) => {
        const rows = Array.from({ length: 9 }, () => []);
        const openIndex = double ? 4 : 8;

        rows[0] = double
            ? [['doorW', 'true'], ['DoubleDoor', '1'], ['cutW', 'true']]
            : [['doorW', 'true'], ['GarageDoor', '1']];
        rows[1] = [['WallOverlay', 'true'], ['attachedW', 'true']];
        rows[openIndex] = double
            ? [['doorN', 'true'], ['DoubleDoor', '5']]
            : [['doorW', 'true'], ['GarageDoor', '4']];
        const projection = await projectWorldObjects([await cell({
            names: ['synthetic_0', 'synthetic_1'], records: [3, -1, 0, 1, -1, 63],
        })], registry(rows));
        const base = projection.depthContexts['0,0,0,0'];
        const attached = projection.depthContexts['0,0,0,1'];
        const open = attached.doorSprites[`synthetic_${openIndex}`];

        assert.equal(attached.objectClass, 'IsoDoor');
        assert.equal(attached.doorId, base.doorId);
        assert.equal(attached.isMainSprite, false);
        assert.equal(attached.isParentSprite, false);
        assert.equal(attached.wallDirection, 'W');
        assert.equal(attached.doorSprites, base.doorSprites);
        assert.equal(open.spriteProperties.open, 'true');
        assert.equal(open.wallDirection, double ? 'N' : 'W', 'current parent geometry is not the original closed orientation');
        assert.equal(attached.currentSpriteName, 'synthetic_1');
        assert.deepEqual(attached.seams, []);
    }));
});

test('rain blockers use final surviving non-blueprint flag presence rather than floor predicates or attachments', async () => {
    const { projectWorldObjects } = await projectionModule();
    const cases = [
        { rows: [[['solidfloor', 'false'], ['BlockRain', 'false']]], expected: 3 },
        { rows: [[['BlockRain', '']]], expected: 2 },
        { rows: [[['stairsTN', 'false']]], expected: 0 },
        { rows: [[['SlopedSurfaceDirection', 'N']]], expected: 0 },
        { rows: [[['blueprint', 'false'], ['solidfloor', 'false'], ['BlockRain', 'false']]], expected: 0 },
        { rows: [[['tree', '1'], ['BlockRain', 'false']], [['tree', '1']]], expected: 0 },
        { rows: [[['wall', 'false'], ['cutW', 'false']], [['WallOverlay', 'false'], ['attachedW', 'false'], ['BlockRain', 'false']]], expected: 0 },
        { rows: [[['solidfloor', 'false'], ['diamondFloor', 'false'], ['BlockRain', 'false']], [['solidfloor', 'false'], ['diamondFloor', 'false']]], expected: 1 },
    ];

    await Promise.all(cases.map(async ({ rows, expected }) => {
        const map = await cell({
            names: rows.map((_, index) => `synthetic_${index}`),
            records: [rows.length + 1, -1, ...rows.map((_, index) => index), -1, 63],
        });
        const projected = await projectWorldObjects([map], registry(rows));

        assert.equal(projected.squares[0].rainBlockers, expected, JSON.stringify(rows));
        assert.equal(projected.squares[1].rainBlockers, 0, 'present empty squares have known no blockers');
    }));
});

test('rain snapshots preserve all final constructor partners and moving attached door context', async () => {
    const { projectWorldObjects } = await projectionModule();
    const tiles = Array.from({ length: 11 }, () => []);

    tiles[0] = [['doorN', 'false'], ['DoubleDoor', '1'], ['solidfloor', 'false'], ['cutN', 'false']];
    tiles[4] = [['doorW', 'false'], ['DoubleDoor', '6'], ['BlockRain', 'false']];
    tiles[5] = [['doorW', 'false'], ['DoubleDoor', '5'], ['solidfloor', 'false'], ['BlockRain', 'false']];
    tiles[6] = [['doorN', 'false'], ['DoubleDoor', '2'], ['BlockRain', 'false']];
    tiles[7] = [['doorN', 'false'], ['DoubleDoor', '2'], ['solidfloor', 'false'], ['blueprint', 'false']];
    tiles[10] = [['doorN', 'false'], ['DoubleDoor', '6'], ['solidfloor', 'false']];
    tiles[1] = [['WallOverlay', 'false'], ['attachedN', 'false'], ['BlockRain', 'false']];
    const projected = await projectWorldObjects([await cell({
        names: ['synthetic_0', 'synthetic_1', 'synthetic_10'],
        records: [3, -1, 0, 1, 2, -1, 2, -1, 62],
    })], registry(tiles));

    assert.deepEqual(projected.doors.map((door) => door.rainBlockers), [[1, 2, 1, 3], [2, 1, 0, 1]]);
    assert.deepEqual(projected.squares.slice(0, 2).map((square) => square.rainBlockers), [0, 0],
        'base squares exclude actual doors and their visual-only attachments');
    const attached = projected.depthContexts['0,0,0,1'];

    assert.equal(attached.doorId, projected.depthContexts['0,0,0,0'].doorId);
    assert.equal(attached.isParentSprite, false);
    assert.equal(attached.doorSprites.synthetic_4.spriteProperties.BlockRain, 'false');
});

test('rain aggregation observes shared constructor mutations on objects created in earlier cells', async () => {
    const { projectWorldObjects } = await projectionModule();
    const tiles = registry([[['windowW', 'false'], ['solidfloor', 'false'], ['BlockRain', 'false'], ['OpenTileOffset', '1']], []]);
    const earlier = await cell({ names: ['synthetic_1'], records: [2, -1, 0, -1, 63] });
    const later = await cell({ cellX: 1, records: [2, -1, 0, -1, 63] });
    const projected = await projectWorldObjects([earlier, later], tiles);

    assert.equal(projected.squares.find(({ x, y }) => x === 0 && y === 0).rainBlockers, 3);
    assert.equal(projected.squares.find(({ x, y }) => x === 256 && y === 0).rainBlockers, 3);
});

test('native roofs consume projected moving door snapshots and rebuild from restored current geometry', async () => {
    const { projectWorldObjects } = await projectionModule();
    const subject = await createEngine(await readFile(new URL(
        '../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url,
    )));
    const tiles = Array.from({ length: 11 }, () => []);

    tiles[6] = [['doorN', 'false'], ['DoubleDoor', '2'], ['BlockRain', 'false']];
    tiles[7] = [['doorN', 'false'], ['DoubleDoor', '2'], ['solidfloor', 'false'], ['blueprint', 'false']];
    tiles[10] = [['doorN', 'false'], ['DoubleDoor', '6'], ['solidfloor', 'false']];
    const scene = {
        ...await cell(), minLevel: 0, maxLevel: 1,
        /**
         * Read the synthetic upper-floor panel placement.
         *
         * @returns {Promise<object[]>} Original-format records.
         */
        readChunk: () => Promise.resolve([{ x: 1, y: 2, z: 1, order: 0, spriteName: 'synthetic_10' }]),
    };
    const projected = await projectWorldObjects([scene], registry(tiles));

    subject.importDoors(projected.doors, { squares: projected.squares });
    assert.equal(subject.getSquare(1, 2, 1).haveRoof, false, 'blocker never roofs itself');
    assert.equal(subject.getSquare(1, 2, 0).haveRoof, true);
    assert.equal(subject.getSquare(2, 1, 0).haveRoof, false);
    const initial = subject.saveDoorState();
    const closed = {
        ...initial,
        doors: initial.doors.map((door) => ({ ...door, open: false, toggled: false, x: 2, y: 1 })),
    };

    subject.loadDoorState(closed);
    assert.equal(subject.getSquare(1, 2, 0).haveRoof, false, 'old column loses moved panel');
    assert.equal(subject.getSquare(2, 1, 0).haveRoof, true, 'new column receives current closed BlockRain');
    subject.loadDoorState({
        ...closed, doors: closed.doors.map((door) => ({ ...door, toggled: true })),
    });
    assert.equal(subject.getSquare(2, 1, 0).haveRoof, false, 'toggled closed blueprint contributes no blocker');
    assert.equal(subject.getSquare(1, 2, 0).haveRoof, false);
    subject.loadDoorState(initial);
    assert.equal(subject.getSquare(1, 2, 0).haveRoof, true, 'saved current open geometry restores its roof');
    assert.equal(subject.getSquare(2, 1, 0).haveRoof, false, 'restoring removes the moved closed column roof');
});
