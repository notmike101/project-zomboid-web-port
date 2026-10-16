/** @file Synthetic TDEF records only; no installed game data. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTileRegistry, parseTileDefinitions } from '../src/tile-definitions.js';

/**
 * Encode one signed native integer.
 *
 * @param {number} value - Field value.
 * @returns {Buffer} Little-endian bytes.
 */
function int(value) {
    const bytes = Buffer.alloc(4);

    bytes.writeInt32LE(value);

    return bytes;
}

/**
 * Encode a native byte-to-character line, not UTF-8.
 *
 * @param {string} value - String value.
 * @returns {Buffer} Terminated bytes.
 */
function line(value) {
    return Buffer.from(`${value}\n`, 'latin1');
}

/**
 * Encode complete native-format tilesets.
 *
 * @param {object[]} sets - Synthetic tilesets.
 * @returns {Buffer} Complete TDEF v1.
 */
function definitions(sets) {
    return Buffer.concat([
        Buffer.from('tdef'), int(1), int(sets.length),
        ...sets.flatMap(({ name = 'test', imagePath = 'image.png', metadata = [8, 16], number = 1, tiles = [] }) => [
            line(name), line(imagePath), ...metadata.map(int), int(number), int(tiles.length),
            ...tiles.flatMap((properties) => [int(properties.length), ...properties.flatMap(([key, value]) => [line(key), line(value)])]),
        ]),
    ]);
}

/**
 * Build one source in supplied native load order.
 *
 * @param {object[]} sets - Tilesets.
 * @param {string} [path] - Determines patch mode.
 * @param {number} [fileId] - Native file number.
 * @returns {object} Registry source.
 */
function source(sets, path = 'base.tiles', fileId = 1) {
    return { path, fileId, buffer: definitions(sets) };
}

test('parses extra header integers, ordered pairs and Java byte/trim semantics from a bounded view', () => {
    const bytes = definitions([{
        name: ' \0sheet\t ', imagePath: ' image\x80.png ', metadata: [-3, 27], number: 2,
        tiles: [[[' name ', ' first '], ['name', '\xA0last\xA0'], ['\x80key', '\x80value']]],
    }]);
    const padded = Buffer.concat([Buffer.alloc(7), bytes, Buffer.alloc(9)]);
    const parsed = parseTileDefinitions(new DataView(padded.buffer, padded.byteOffset + 7, bytes.length), { fileId: 1 });

    assert.deepEqual(parsed, [{
        name: 'sheet', imagePath: ' image\x80.png ', metadata: [-3, 27], number: 2,
        tiles: [[['name', 'first'], ['name', '\xA0last\xA0'], ['\x80key', '\x80value']]],
    }]);
    assert.deepEqual(parseTileDefinitions(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), { fileId: 1 }), parsed);
});

test('registers exact underscore names, native IDs, sheet indices and final property values', () => {
    const registry = createTileRegistry([
        source([{ name: 'sheet', number: 2, tiles: [[['name', 'first'], ['name', 'last']], []] }]),
        source([{ name: 'later', number: 3, tiles: [[]] }], 'later.tiles', 4),
    ]);

    assert.deepEqual([...registry.keys()], ['sheet_0', 'sheet_1', 'later_0']);
    assert.deepEqual(registry.get('sheet_0'), {
        name: 'sheet_0', id: 1_024, tilesetName: 'sheet', tileSheetIndex: 0,
        tileType: 'MAX', properties: new Map([['name', 'last']]),
    });
    assert.equal(registry.get('sheet_1').id, 1_025);
    assert.equal(registry.get('later_0').id, 1_573_888);
});

test('recognizes the native case-sensitive type inventory and protects doors only against lowercase wall', () => {
    const types = ['normal', 'jukebox', 'wall', 'stairsTW', 'stairsTN', 'stairsMW', 'stairsMN', 'stairsBW', 'stairsBN',
        'UNUSED9', 'UNUSED10', 'doorW', 'doorN', 'lightswitch', 'radio', 'curtainN', 'curtainS', 'curtainW', 'curtainE',
        'doorFrW', 'doorFrN', 'tree', 'windowFN', 'windowFW', 'UNUSED24', 'WestRoofB', 'WestRoofM', 'WestRoofT', 'isMoveAbleObject'];
    const registry = createTileRegistry([
        source(types.map((type, number) => ({
            name: `type${number}`, number: number + 1,
            tiles: [[[type, type === 'tree' ? '3' : 'ignored']]],
        }))),
        source([{
            name: 'ordered', number: 31,
            tiles: [
                [['doorN', ''], ['wall', ''], ['open', 'false']],
                [['doorW', ''], ['radio', '']], [['DoorN', ''], ['MAX', '']],
                [['doorN', ''], ['WallN', '']],
            ],
        }]),
    ]);

    for (const [index, type] of types.entries()) {
        assert.equal(registry.get(`type${index}_0`).tileType, type);
    }

    assert.equal(registry.get('ordered_0').tileType, 'doorN');
    assert.equal(registry.get('ordered_0').properties.get('doorN'), 'true');
    assert.equal(registry.get('ordered_1').tileType, 'radio');
    assert.equal(registry.get('ordered_2').tileType, 'MAX');
    assert.equal(registry.get('ordered_2').properties.get('DoorN'), '');
    assert.equal(registry.get('ordered_3').tileType, 'wall');
});

test('patches existing targets in order without creating missing names or changing IDs', () => {
    const registry = createTileRegistry([
        source([{ name: 'door', tiles: [[['doorW', ''], ['CustomName', 'Old']]] }]),
        source([{ name: 'missing', number: 2, tiles: [[['doorN', '']]] },
            { name: 'door', number: 3, tiles: [[['wall', ''], ['CustomName', 'New']], [['doorN', '']]] }], 'sounds.patch.tiles', -1),
    ]);

    assert.deepEqual([...registry.keys()], ['door_0']);
    assert.equal(registry.get('door_0').id, 0);
    assert.equal(registry.get('door_0').tileType, 'doorW');
    assert.equal(registry.get('door_0').properties.get('CustomName'), 'New');
});

test('duplicate non-patch registration retains the original ID but replaces type and properties', () => {
    const registry = createTileRegistry([
        source([{ name: 'same', number: 2, tiles: [[['doorN', ''], ['old', 'value']]] }]),
        source([{ name: 'same', number: 4, tiles: [[['new', 'value']]] }], 'replacement.tiles', 4),
    ]);

    assert.deepEqual(registry.get('same_0'), {
        name: 'same_0', id: 1_024, tilesetName: 'same', tileSheetIndex: 0,
        tileType: 'MAX', properties: new Map([['new', 'value']]),
    });
});

test('derives ordinary open partners after all records in each tileset, without recursive propagation', () => {
    const registry = createTileRegistry([source([{ name: 'ordinary', tiles: [[['doorN', '']], [], [['wall', ''], ['keep', 'value']], [], []] }])]);

    assert.equal(registry.get('ordinary_2').tileType, 'doorN');
    assert.equal(registry.get('ordinary_2').properties.get('doorN'), 'true');
    assert.equal(registry.get('ordinary_2').properties.get('open'), 'true');
    assert.equal(registry.get('ordinary_2').properties.get('keep'), 'value');
    assert.equal(registry.get('ordinary_4').tileType, 'MAX');
});

test('postprocessing does not revisit untouched doors when partners arrive in later files or tilesets', () => {
    const registry = createTileRegistry([
        source([{ name: 'earlier', tiles: [[['doorW', '']]] }, { name: 'other', number: 2, tiles: [[], [], []] }]),
        source([{ name: 'earlier', tiles: [[], [], []] }], 'later.patch.tiles', -1),
    ]);

    assert.equal(registry.has('earlier_2'), false);
    assert.equal(registry.get('other_2').tileType, 'MAX');
});

test('open, double and garage doors obey presence, thresholds, integer parsing and double precedence', () => {
    const records = [
        [['doorW', ''], ['DoubleDoor', '4']], [['doorN', ''], ['DoubleDoor', '+5']], [],
        [['doorN', ''], ['GarageDoor', '3']], [['doorW', ''], ['GarageDoor', '4']], [],
        [['doorW', ''], ['DoubleDoor', 'bad'], ['GarageDoor', '8']], [], [],
        [['doorW', ''], ['DoubleDoor', '5suffix']], [], [],
        [['doorW', ''], ['DoubleDoor', '2147483648']], [], [],
        [['doorN', ''], ['open', 'false']], [], [],
    ];
    const registry = createTileRegistry([source([{ name: 'multi', tiles: records }])]);

    for (const index of [1, 4]) {
        assert.equal(registry.get(`multi_${index}`).properties.get('open'), 'true');
    }

    for (const index of [0, 2, 3, 5, 6, 8, 9, 11, 12, 14, 17]) {
        assert.equal(registry.get(`multi_${index}`).properties.has('open'), false);
    }

    assert.equal(registry.get('multi_15').properties.get('open'), 'false');
});

test('tileset and file postprocessing happens before subsequent duplicate registrations', () => {
    const first = { name: 'timing', tiles: [[['doorW', '']], [], []] };
    const replacement = { name: 'timing', tiles: [[]] };
    const perSet = createTileRegistry([source([first, replacement])]);
    const perFile = createTileRegistry([source([first]), source([replacement], 'later.tiles', 2)]);

    for (const registry of [perSet, perFile]) {
        assert.equal(registry.get('timing_0').tileType, 'MAX');
        assert.equal(registry.get('timing_2').tileType, 'doorW');
        assert.equal(registry.get('timing_2').properties.get('open'), 'true');
    }
});

test('structural orientation dispatch does not mistake the W in Wall for a west edge', () => {
    const registry = createTileRegistry([source([{ name: 'walls', tiles: [[['WallN', '']], [['WallW', '']], [['WallNWTrans', '']]] }])]);

    assert.equal(registry.get('walls_0').properties.get('collideN'), 'true');
    assert.equal(registry.get('walls_0').properties.has('collideW'), false);
    assert.equal(registry.get('walls_1').properties.has('collideN'), false);
    assert.equal(registry.get('walls_2').properties.get('transparentN'), 'true');
    assert.equal(registry.get('walls_2').properties.get('transparentW'), 'true');
});

test('unsupported unbreakable-window Trans keys preserve ordinary door identity and open partners', () => {
    const registry = createTileRegistry([source(['N', 'W', 'NW'].map((axis, index) => ({
        name: `unsupported${axis}`, number: index + 1,
        tiles: [[['doorN', ''], [`UnbreakableWindow${axis}Trans`, 'retained']], [], []],
    })))]);

    for (const axis of ['N', 'W', 'NW']) {
        const closed = registry.get(`unsupported${axis}_0`);
        const open = registry.get(`unsupported${axis}_2`);

        assert.equal(closed.tileType, 'doorN');
        assert.equal(closed.properties.get(`UnbreakableWindow${axis}Trans`), 'retained');
        assert.equal(closed.properties.has('collideN'), false);
        assert.equal(closed.properties.has('collideW'), false);
        assert.equal(open.tileType, 'doorN');
        assert.equal(open.properties.get('doorN'), 'true');
        assert.equal(open.properties.get('open'), 'true');
    }
});

test('unbreakable northwest windows derive only north transparency and retain independent west metadata', () => {
    const registry = createTileRegistry([source([{
        name: 'corners',
        tiles: [
            [['UnbreakableWindowNW', '']],
            [['transparentW', 'explicit'], ['UnbreakableWindowNW', '']],
            [['UnbreakableWindowNW', ''], ['transparentW', 'later']],
        ],
    }])]);

    assert.equal(registry.get('corners_0').tileType, 'wall');
    assert.deepEqual(registry.get('corners_0').properties, new Map([
        ['UnbreakableWindowNW', ''], ['cutN', 'true'], ['collideN', 'true'],
        ['transparentN', 'true'], ['cutW', 'true'], ['collideW', 'true'],
    ]));
    assert.equal(registry.get('corners_1').properties.get('transparentW'), 'explicit');
    assert.equal(registry.get('corners_2').properties.get('transparentW'), 'later');
});

test('tree size dispatch accepts signed native integers and rejects malformed values', () => {
    const registry = createTileRegistry([source([{ name: 'sizes', tiles: [[['tree', '-1']], [['tree', '0']], [['tree', '4']]] }])]);

    assert.equal(registry.get('sizes_0').properties.has('blocksight'), false);
    assert.equal(registry.get('sizes_1').properties.has('blocksight'), false);
    assert.equal(registry.get('sizes_2').properties.get('blocksight'), 'true');
    assert.throws(() => createTileRegistry([source([{ name: 'bad', tiles: [[['tree', 'junk']]] }])]), /Invalid/);
});

test('preserves object mapping metadata and derives grounded structural flags and types', () => {
    const registry = createTileRegistry([source([{
        name: 'objects',
        tiles: [
            [['DoorWallNTrans', ''], ['container', 'crate'], ['IsMoveAble', 'true'], ['PickUpWeight', '12']],
            [['HoppableW', ''], ['WindowW', '']], [['StopCar', '']], [['tree', '1']],
        ],
    }])]);
    const doorWall = registry.get('objects_0').properties;

    assert.equal(doorWall.get('container'), 'crate');
    assert.equal(doorWall.get('PickUpWeight'), '12');
    assert.equal(doorWall.get('cutN'), 'true');
    assert.equal(doorWall.get('transparentN'), 'true');
    assert.equal(registry.get('objects_1').tileType, 'windowFW');
    assert.equal(registry.get('objects_1').properties.has('HoppableW'), false);
    assert.equal(registry.get('objects_2').tileType, 'isMoveAbleObject');
    assert.equal(registry.get('objects_3').properties.has('blocksight'), false);
    assert.equal(registry.get('objects_3').properties.get('MaterialType'), 'Wood_Solid');
});

test('rejects each truncated boundary, CR, invalid header/count/number and unconsumed trailing bytes', () => {
    const bytes = definitions([{ name: 'x', imagePath: 'i', tiles: [[['key', 'value']]] }]);

    for (let end = 0; end < bytes.length; end += 1) {
        assert.throws(() => parseTileDefinitions(bytes.subarray(0, end), { fileId: 1 }), /Truncated|Invalid/);
    }

    const badFields = [[0, 0], [4, 2], [8, -1], [8, 1_025], [24, 0], [24, 1_025], [28, -1], [28, 1_025], [32, -1], [32, 2_147_483_647]];

    for (const [offset, value] of badFields) {
        const invalid = Buffer.from(bytes);

        invalid.writeInt32LE(value, offset);
        assert.throws(() => parseTileDefinitions(invalid, { fileId: 1 }), /Invalid/);
    }

    assert.throws(() => parseTileDefinitions(definitions([{ name: 'x\r', tiles: [] }]), { fileId: 1 }), /Invalid/);
    assert.throws(() => parseTileDefinitions(Buffer.concat([bytes, Buffer.from([0])]), { fileId: 1 }), /Invalid/);
    assert.throws(() => parseTileDefinitions(bytes, { fileId: 0 }), /Invalid/);
    assert.throws(() => parseTileDefinitions(bytes, { fileId: -1 }), /Invalid/);
    assert.throws(() => parseTileDefinitions('tdef', { fileId: 1 }), TypeError);
    assert.throws(() => parseTileDefinitions(definitions([{ name: 'x'.repeat(4_097) }]), { fileId: 1 }), /Invalid/);
    assert.equal(parseTileDefinitions(definitions([{ name: 'x'.repeat(4_096) }]), { fileId: 1 })[0].name.length, 4_096);
    const skipped = source([{ name: 'missing', tiles: [[['key', 'value']]] }], 'bad.patch.tiles', -1);

    skipped.buffer = skipped.buffer.subarray(0, -1);
    assert.throws(() => createTileRegistry([skipped]), /Truncated/);
});

test('enforces the file-1 versus other-file count and tileset-number limits', () => {
    for (const [fileId, limit, expectedId] of [[1, 1_024, 1_047_552], [2, 512, 1_310_208]]) {
        const bytes = definitions([{ name: 'limit', number: limit, tiles: Array.from({ length: limit }, () => []) }]);

        assert.equal(parseTileDefinitions(bytes, { fileId })[0].tiles.length, limit);
        assert.equal(createTileRegistry([{ path: 'limit.tiles', fileId, buffer: bytes }]).get('limit_0').id, expectedId);
        assert.throws(() => parseTileDefinitions(definitions([{ number: limit + 1 }]), { fileId }), /Invalid/);
        assert.throws(() => parseTileDefinitions(definitions([{ tiles: Array.from({ length: limit + 1 }, () => []) }]), { fileId }), /Invalid/);
    }

    assert.deepEqual(parseTileDefinitions(definitions([]), { fileId: 8 }), []);
});

test('malformed later sources throw atomically without changing buffers or a previously returned registry', () => {
    const first = source([{ name: 'stable', tiles: [[['doorN', '']]] }]);
    const existing = createTileRegistry([first]);
    const before = Buffer.from(first.buffer);
    const invalidPatch = source([{ name: 'stable', tiles: [[['new', 'value']]], number: 1 }], 'bad.patch.tiles', -1);

    invalidPatch.buffer = invalidPatch.buffer.subarray(0, -1);
    assert.throws(() => createTileRegistry([first, invalidPatch]), /Truncated/);
    assert.equal(existing.get('stable_0').properties.has('new'), false);
    assert.deepEqual(first.buffer, before);
    assert.throws(() => createTileRegistry([{ ...first, path: null }]), TypeError);
});
