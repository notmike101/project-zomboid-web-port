/** @file Synthetic original-format map/tile projection regressions; no installed bytes. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openMapCell } from '../src/map-tiles.js';
import { createTileRegistry } from '../src/tile-definitions.js';

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
 * @param {number} [options.cellX] - Cell x.
 * @param {number} [options.cellY] - Cell y.
 * @returns {Promise<import('../src/map-tiles.js').MapCell>} Real lazy map cell.
 */
function cell({ names = ['synthetic_0'], records = [2, -1, 0], rooms = [], cellX = 0, cellY = 0 } = {}) {
    const header = Buffer.concat([
        Buffer.from('LOTH'), int(1), int(names.length), ...names.map(line), int(8), int(8), int(0), int(0), int(rooms.length),
        ...rooms.flatMap(({ z = 0, rects }) => [line('synthetic room'), int(z), int(rects.length), ...rects.flatMap((rect) => rect.map(int)), int(0)]),
        int(0), Buffer.alloc(1_024),
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
