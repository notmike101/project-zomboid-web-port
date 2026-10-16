/** @file Bounded TDEF v1 ingestion; all work occurs at content load, never per frame. */

const MAX_STRING_BYTES = 4_096;
const TILE_TYPES = new Set([
    'normal', 'jukebox', 'wall', 'stairsTW', 'stairsTN', 'stairsMW', 'stairsMN', 'stairsBW', 'stairsBN',
    'UNUSED9', 'UNUSED10', 'doorW', 'doorN', 'lightswitch', 'radio', 'curtainN', 'curtainS', 'curtainW', 'curtainE',
    'doorFrW', 'doorFrN', 'tree', 'windowFN', 'windowFW', 'UNUSED24', 'WestRoofB', 'WestRoofM', 'WestRoofT', 'isMoveAbleObject',
]);

/** @typedef {[string,string]} TileProperty */
/** @typedef {{name:string,imagePath:string,metadata:number[],number:number,tiles:TileProperty[][]}} TileDefinitions */
/** @typedef {{name:string,id:number,tilesetName:string,tileSheetIndex:number,tileType:string,properties:Map<string,string>}} TileSprite */
/** @typedef {{buffer:ArrayBuffer,byteOffset:number,byteLength:number}} TileByteView */
/** @typedef {{path:string,fileId:number,buffer:ArrayBuffer|TileByteView}} TileDefinitionSource */

/**
 * Match Java String.trim, which does not remove Latin-1 nonbreaking spaces.
 *
 * @param {string} value - Native byte string.
 * @returns {string} Trimmed value.
 */
function trim(value) {
    let start = 0;
    let end = value.length;

    while (start < end && value.charCodeAt(start) <= 32) {
        start += 1;
    }

    while (end > start && value.charCodeAt(end - 1) <= 32) {
        end -= 1;
    }

    return value.slice(start, end);
}

/**
 * Parse a complete file before exposing any records. The two otherwise unused
 * tileset header integers are retained without inventing dimension semantics.
 * Strings map unsigned bytes directly to characters; CR and unterminated lines
 * fail closed. Bounds are ingestion limits, not claims about native EOF recovery.
 *
 * @param {ArrayBuffer|TileByteView} buffer - Complete privately supplied file.
 * @param {object} options - Native file identity.
 * @param {number} options.fileId - Positive signed native file number, or -1 for patches.
 * @param {boolean} [options.patch] - Allows the native patch sentinel file number.
 * @returns {TileDefinitions[]} Ordered tilesets and ordered property pairs.
 */
function parseTileDefinitions(buffer, { fileId, patch = false }) {
    if (!Number.isInteger(fileId) || fileId > 2_147_483_647 || (fileId < 1 && !(patch && fileId === -1))) {
        throw new Error(`Invalid tile definitions fileId ${fileId}`);
    }

    if (!(buffer instanceof ArrayBuffer) && !ArrayBuffer.isView(buffer)) {
        throw new TypeError('Tile definitions require an ArrayBuffer or byte view');
    }

    const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const limit = fileId === 1 ? 1_024 : 512;
    let position = 0;

    /**
     * Read one bounded signed little-endian field.
     *
     * @returns {number} Native integer.
     */
    function integer() {
        if (position + 4 > bytes.length) {
            throw new Error(`Truncated tile definitions integer at byte ${position}`);
        }

        const value = view.getInt32(position, true);

        position += 4;

        return value;
    }

    /**
     * Validate a count before allocating or entering its loop.
     *
     * @param {string} label - Field name.
     * @param {number} maximum - Allowed limit.
     * @param {number} minimumBytes - Smallest possible encoded record size.
     * @returns {number} Validated count.
     */
    function count(label, maximum, minimumBytes) {
        const value = integer();

        if (value < 0 || value > maximum || value > Math.floor((bytes.length - position) / minimumBytes)) {
            throw new Error(`Invalid tile definitions ${label} ${value} at byte ${position - 4}`);
        }

        return value;
    }

    /**
     * Read a bounded newline-terminated byte string.
     *
     * @returns {string} Exact untrimmed byte-to-character value.
     */
    function line() {
        let result = '';

        for (let length = 0; length <= MAX_STRING_BYTES; length += 1) {
            if (position === bytes.length) {
                throw new Error(`Truncated tile definitions string at byte ${position}`);
            }

            const byte = bytes[position++];

            if (byte === 10) {
                return result;
            }

            if (byte === 13 || length === MAX_STRING_BYTES) {
                throw new Error(`Invalid tile definitions string at byte ${position - 1}`);
            }

            result += String.fromCharCode(byte);
        }

        throw new Error('Invalid tile definitions string');
    }

    if (integer() !== 0x66_65_64_74) {
        throw new Error('Invalid tile definitions magic');
    }

    if (integer() !== 1) {
        throw new Error('Invalid tile definitions version');
    }

    const tilesetCount = count('tileset count', limit, 18);
    const tilesets = [];

    for (let index = 0; index < tilesetCount; index += 1) {
        const name = trim(line());
        const imagePath = line();
        const metadata = [integer(), integer()];
        const number = integer();

        if (number < 1 || number > limit) {
            throw new Error(`Invalid tile definitions tileset number ${number}`);
        }

        const tileCount = count('tile count', limit, 4);
        const tiles = [];

        for (let tile = 0; tile < tileCount; tile += 1) {
            const propertyCount = count('property count', 2_147_483_647, 2);
            const properties = [];

            for (let property = 0; property < propertyCount; property += 1) {
                properties.push([trim(line()), trim(line())]);
            }

            tiles.push(properties);
        }

        tilesets.push({ name, imagePath, metadata, number, tiles });
    }

    if (position !== bytes.length) {
        throw new Error(`Invalid tile definitions trailing bytes at byte ${position}`);
    }

    return tilesets;
}

/**
 * Parse the same signed decimal range used by native door thresholds.
 *
 * @param {string} value - Explicit native property.
 * @returns {number} Signed value or NaN when parsing fails.
 */
function doorNumber(value) {
    if (!/^[+-]?\d+$/.test(value)) {
        return Number.NaN;
    }

    const number = Number(value);

    return Number.isInteger(number) && number >= -2_147_483_648 && number <= 2_147_483_647 ? number : Number.NaN;
}

/**
 * Apply one ordered pair, retaining explicit metadata and deriving structural
 * flags. This Map is a string metadata projection, not native alias-table IDs
 * or renderer-only sprite fields.
 *
 * @param {TileSprite} sprite - Existing or newly registered sprite.
 * @param {string} key - Native trimmed property key.
 * @param {string} value - Native trimmed value.
 * @returns {void}
 */
function applyProperty(sprite, key, value) {
    const properties = sprite.properties;

    properties.set(key, value);

    if (TILE_TYPES.has(key)) {
        if (key !== 'wall' || (sprite.tileType !== 'doorN' && sprite.tileType !== 'doorW')) {
            sprite.tileType = key;
        }

        if (key === 'doorN' || key === 'doorW') {
            properties.set(key, 'true');
        }
    }

    if (key === 'tree') {
        const treeValue = sprite.name === 'e_riverbirch_1_1' ? '1' : value;
        const parsedSize = doorNumber(treeValue);

        if (Number.isNaN(parsedSize)) {
            throw new TypeError(`Invalid tile definitions tree size ${value}`);
        }

        const size = sprite.tilesetName.startsWith('vegetation_trees') ? 4 : parsedSize;

        properties.set('tree', treeValue);
        properties.set('MaterialType', 'Wood_Solid');

        if (size > 2) {
            properties.set('blocksight', 'true');
        } else {
            properties.delete('blocksight');
        }
    }

    if (key === 'interior' && value === 'false') {
        properties.set('exterior', 'true');
    }

    if (key === 'FloorHeight' && (value === 'OneThird' || value === 'TwoThirds')) {
        properties.set(`FloorHeight${value === 'OneThird' ? 'OneThird' : 'TwoThirds'}`, 'true');
    }

    for (const axis of ['N', 'W']) {
        if (key === `Hoppable${axis}`) {
            properties.set(`collide${axis}`, 'true');
            properties.set(`canPath${axis}`, 'true');
            properties.set(`transparent${axis}`, 'true');
        }

        if (key === `window${axis}`) {
            properties.set(`Window${axis}`, `Window${axis}`);
            properties.set(`transparent${axis}`, 'true');
        }

        if (key === `Window${axis}`) {
            sprite.tileType = `windowF${axis}`;
            properties.set(`canPath${axis}`, 'true');
            properties.set(`collide${axis}`, 'true');
            properties.set(`cut${axis}`, 'true');
            properties.set(`transparent${axis}`, 'true');
            properties.delete(`Hoppable${axis}`);
        }

        if (key === `DoorWall${axis}` || key === `DoorWall${axis}Trans`) {
            properties.set(`cut${axis}`, 'true');

            if (key.endsWith('Trans')) {
                properties.set(`transparent${axis}`, 'true');
            }
        }
    }

    const wall = /^Wall(NW|N|W)(Trans)?$/.exec(key) ?? /^UnbreakableWindow(NW|N|W)$/.exec(key);

    if (wall) {
        sprite.tileType = 'wall';

        for (const axis of ['N', 'W']) {
            if (wall[1].includes(axis)) {
                properties.set(`cut${axis}`, 'true');
                properties.set(`collide${axis}`, 'true');

                if (key.endsWith('Trans') || (key.startsWith('UnbreakableWindow') && (key !== 'UnbreakableWindowNW' || axis === 'N'))) {
                    properties.set(`transparent${axis}`, 'true');
                }

                if (key === `UnbreakableWindow${axis}`) {
                    properties.set(`canPath${axis}`, 'true');
                }
            }
        }
    }

    if (key === 'WallSE') {
        properties.set('cutW', 'true');
    }
}

/**
 * Native postprocessing runs once per tileset, not globally after all files.
 * Only loaded or successfully patched sprites participate in the pass.
 *
 * @param {Map<string,TileSprite>} registry - Name lookup.
 * @param {string} name - Current tileset name.
 * @param {TileSprite[]} sprites - Current tileset's accepted records.
 * @returns {void}
 */
function deriveOpenDoors(registry, name, sprites) {
    for (const sprite of sprites) {
        const properties = sprite.properties;

        if ((sprite.tileType !== 'doorN' && sprite.tileType !== 'doorW') || properties.has('open')) {
            continue;
        }

        if (properties.has('DoubleDoor')) {
            if (doorNumber(properties.get('DoubleDoor')) >= 5) {
                properties.set('open', 'true');
            }

            continue;
        }

        if (properties.has('GarageDoor')) {
            if (doorNumber(properties.get('GarageDoor')) >= 4) {
                properties.set('open', 'true');
            }

            continue;
        }

        const partner = registry.get(`${name}_${sprite.tileSheetIndex + 2}`);

        if (partner) {
            partner.tileType = sprite.tileType;
            partner.properties.set(sprite.tileType, 'true');
            partner.properties.set('open', 'true');
        }
    }
}

/**
 * Build a private ordered registry or throw without publishing partial state.
 * Duplicate non-patch names replace the record but retain the original ID;
 * patches mutate only existing names. Explicit strings remain available for
 * subsequent door/item/object mapping, independently of rendering assets.
 *
 * @param {TileDefinitionSource[]} sources - Native source load order.
 * @returns {Map<string,TileSprite>} Native name-to-sprite registry.
 */
function createTileRegistry(sources) {
    const registry = new Map();

    for (const source of sources) {
        if (!source || typeof source.path !== 'string') {
            throw new TypeError('Tile definition sources require a path');
        }

        const patch = source.path.endsWith('.patch.tiles');
        const tilesets = parseTileDefinitions(source.buffer, { fileId: source.fileId, patch });

        for (const tileset of tilesets) {
            const sprites = [];

            for (let index = 0; index < tileset.tiles.length; index += 1) {
                const name = `${tileset.name}_${index}`;
                let sprite = registry.get(name);

                if (patch && !sprite) {
                    continue;
                }

                if (!patch) {
                    const nativeId = source.fileId === 1
                        ? (tileset.number - 1) * 1_024 + index
                        : 1_048_576 + (source.fileId - 2) * 262_144 + (tileset.number - 1) * 512 + index;
                    // Native IDs require signed 32-bit overflow, not floating-point truncation.
                    // eslint-disable-next-line unicorn/prefer-math-trunc
                    const id = sprite ? sprite.id : nativeId | 0;

                    sprite = { name, id, tilesetName: tileset.name, tileSheetIndex: index, tileType: 'MAX', properties: new Map() };
                    registry.set(name, sprite);
                }

                sprites.push(sprite);

                if (name.includes('damaged') || name.includes('trash_')) {
                    sprite.properties.set('attachedFloor', 'true');
                }

                for (const [key, value] of tileset.tiles[index]) {
                    applyProperty(sprite, key, value);
                }
            }

            deriveOpenDoors(registry, tileset.name, sprites);

            for (const sprite of sprites) {
                if (sprite.properties.has('StopCar') && sprite.tileType !== 'tree') {
                    sprite.tileType = 'isMoveAbleObject';
                }
            }
        }
    }

    return registry;
}

export { parseTileDefinitions, createTileRegistry };
