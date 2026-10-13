/** @file Chunk-bounded original map identity projection; gameplay and lock initialization belong to WASM. */
import { createTileRegistry } from './tile-definitions.js';

const nativeTileSources = Object.freeze([
    { path: 'media/newtiledefinitions.tiles', fileId: 1 },
    { path: 'media/tiledefinitions_erosion.tiles', fileId: 2 },
    { path: 'media/tiledefinitions_overlays.tiles', fileId: 4 },
    { path: 'media/tiledefinitions_b42chunkcaching.tiles', fileId: 5 },
    { path: 'media/tiledefinitions_noiseworks.patch.tiles', fileId: -1 },
    { path: 'media/jumbo_trees_big.tiles', fileId: 6 },
    { path: 'media/jumbo_trees.tiles', fileId: 8 },
].map((source) => Object.freeze(source)));

// IsoDoor static offsets: canonical closed position minus initially-open panel position.
const DOUBLE_NORTH_DX = [0, 1, -1, 0];
const DOUBLE_NORTH_DY = [0, -1, -1, 0];
const DOUBLE_WEST_DX = [0, -1, -1, 0];
const DOUBLE_WEST_DY = [0, -1, 1, 0];
const DOUBLE_NORTH_SPRITE_OFFSET = [5, 3, 4, 4];
const DOUBLE_WEST_SPRITE_OFFSET = [4, 4, 5, 3];
const STAIR_TYPES = new Set(['stairsTN', 'stairsMN', 'stairsBN', 'stairsTW', 'stairsMW', 'stairsBW']);
const SLOPE_DIRECTIONS = new Set(['N', 'NW', 'W', 'SW', 'S', 'SE', 'E', 'NE']);
const EARLY_OTHER_TYPES = new Set(['lightswitch', 'curtainN', 'curtainS', 'curtainE', 'curtainW']);
const FURNITURE_CONTAINERS = new Set(['barbecue', 'barbecuepropane', 'fireplace', 'clothingdryer', 'clothingwasher', 'woodstove', 'microwave']);
const CAMPING_SPRITES = new Set(['camping_01_04', 'camping_01_05', 'camping_01_06']);
const STOVE_CONTAINERS = new Set(['stove', 'toaster', 'coffeemaker']);

/**
 * Resolve exact original roles, preserving the actual manifest's portable casing.
 * Legacy format-1 manifests use their indexed file paths, never alternate aliases.
 *
 * @param {object} content - Content source with optional validated manifest.
 * @returns {Array<{path:string,fileId:number}>} Exact native load order.
 */
function tileSources(content) {
    const manifest = content.manifest;

    if (!manifest) {
        return nativeTileSources;
    }

    const inventory = manifest.files?.map((entry) => entry.path);
    const roles = manifest.startup?.tileDefinitions;

    if (!Array.isArray(inventory) || inventory.some((path) => typeof path !== 'string')
        || (roles !== undefined && (!Array.isArray(roles) || roles.some((source) => !source || typeof source !== 'object' || Array.isArray(source)
            || typeof source.path !== 'string' || !Number.isSafeInteger(source.fileId))))) {
        throw new TypeError('Required original tile definitions need manifest file paths and role records with fileId');
    }

    return nativeTileSources.map(({ path, fileId }) => {
        const indexed = inventory.filter((candidate) => candidate.toLowerCase() === path.toLowerCase());
        const matches = roles === undefined ? indexed : roles.filter((source) => source.path.toLowerCase() === path.toLowerCase());
        const matchedPath = roles === undefined ? matches[0] : matches[0]?.path;

        if (matches.length !== 1 || indexed.length !== 1 || matchedPath !== indexed[0]) {
            throw new Error(`Required original tile definition ${path} needs one unambiguous manifest source; found ${matches.length} roles and ${indexed.length} indexed files`);
        }

        if (roles !== undefined && matches[0].fileId !== fileId) {
            throw new Error(`Required original tile definition ${path} has incorrect fileId ${matches[0].fileId}; expected ${fileId}`);
        }

        return { path: matchedPath, fileId };
    });
}

/**
 * Read only the seven required metadata binaries; no texture banks are accessed.
 * Parsing publishes a registry only after every ordered source succeeds.
 *
 * @param {object} content - Lazy content directory.
 * @returns {Promise<Map>} Complete native tile registry.
 */
async function loadNativeTileRegistry(content) {
    if (!content || typeof content.getFile !== 'function') {
        throw new TypeError('Original tile registry requires content.getFile');
    }

    const sources = [];

    for (const { path, fileId } of tileSources(content)) {
        try {
            // eslint-disable-next-line no-await-in-loop -- Native source order is authoritative.
            const file = await content.getFile(path);

            if (!file || typeof file.arrayBuffer !== 'function') {
                throw new TypeError('Missing binary source');
            }

            // eslint-disable-next-line no-await-in-loop -- Native source order is authoritative.
            sources.push({ path, fileId, buffer: await file.arrayBuffer() });
        } catch (cause) {
            throw new Error(`Required original tile definition ${path} could not be read: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
        }
    }

    return createTileRegistry(sources);
}

/**
 * Validate coordinates before handing source identities to the int32 WASM ABI.
 *
 * @param {number} value - Coordinate.
 * @param {string} label - Diagnostic field.
 * @returns {number} Unchanged signed integer.
 */
function int32(value, label) {
    if (!Number.isInteger(value) || value < -2_147_483_648 || value > 2_147_483_647) {
        throw new TypeError(`World object ${label} must be an int32`);
    }

    return value;
}

/**
 * Normalize only native signed decimal special-door properties.
 *
 * @param {Map} properties - Original properties.
 * @param {string} key - Special kind.
 * @param {number} count - Closed panel count.
 * @returns {number} Canonical part number or zero for absent metadata.
 */
function specialPart(properties, key, count) {
    if (!properties.has(key)) {
        return 0;
    }

    const raw = properties.get(key);
    const value = typeof raw === 'string' && /^[+-]?\d+$/u.test(raw) ? Number(raw) : Number.NaN;

    if (!Number.isInteger(value) || value < 1 || value > count * 2) {
        throw new Error(`Unsupported original ${key} property ${String(raw)}`);
    }

    return value > count ? value - count : value;
}

/**
 * Preserve LOTH room identity without conflating cell-local room indices.
 * Detect conflicts even in empty rectangles before publishing any projection.
 *
 * @param {object[]} cells - Sorted original cells.
 * @returns {{rooms:object[],rectangles:Map<object,object[]>}} Source room mapping.
 */
function projectRooms(cells) {
    const rooms = [];
    const rectangles = new Map();

    for (const cell of cells) {
        const rects = [];
        const ids = new Set();

        for (const room of cell.rooms) {
            if (!Number.isSafeInteger(room.id) || room.id < 0 || ids.has(room.id) || !Number.isInteger(room.z) || !Array.isArray(room.rects)) {
                throw new TypeError('Invalid original LOTH room identity');
            }

            ids.add(room.id);
            const id = rooms.length;

            rooms.push({ id, originalRoomId: room.id, cellX: cell.cellX, cellY: cell.cellY, z: room.z, name: room.name });

            for (const rect of room.rects) {
                const { x, y, width, height } = rect;

                int32(x, 'room x');
                int32(y, 'room y');

                if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 0 || height < 0
                    || x < cell.cellX * cell.cellSize || y < cell.cellY * cell.cellSize
                    || x + width > (cell.cellX + 1) * cell.cellSize || y + height > (cell.cellY + 1) * cell.cellSize) {
                    throw new TypeError('Invalid original LOTH room rectangle');
                }

                if (!width || !height) {
                    continue;
                }

                const projected = { x, y, width, height, z: room.z, roomId: id };

                if (rects.some((other) => other.roomId !== id && other.z === room.z && x < other.x + other.width && other.x < x + width && y < other.y + other.height && other.y < y + height)) {
                    throw new Error(`Conflicting original room rectangles at cell ${cell.cellX},${cell.cellY}`);
                }

                rects.push(projected);
            }
        }

        rectangles.set(cell, rects);
    }

    return { rooms, rectangles };
}

/**
 * Identify a square by source LOTH rectangles, never a NAV bit or placement room.
 *
 * @param {object[]} rectangles - Candidate source rectangles.
 * @param {number} x - Original coordinate.
 * @param {number} y - Original coordinate.
 * @param {number} z - Original level.
 * @returns {number} Canonical room identity or outside -1.
 */
function roomAt(rectangles, x, y, z) {
    for (const rect of rectangles) {
        if (rect.z === z && x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height) {
            return rect.roomId;
        }
    }

    return -1;
}

/**
 * Require a native sheet-index partner with the opposite open flag and a door type.
 *
 * @param {object} sprite - Current original sprite.
 * @param {number} offset - Source-proven partner increment.
 * @param {Map} registry - Complete native registry.
 * @returns {object} Proven partner.
 */
function requirePartner(sprite, offset, registry) {
    const initiallyOpen = sprite.properties.has('open');
    const index = sprite.tileSheetIndex + (initiallyOpen ? -offset : offset);
    const name = `${sprite.tilesetName}_${index}`;
    const partner = registry.get(name);

    if (!partner || partner.tilesetName !== sprite.tilesetName || partner.tileSheetIndex !== index) {
        throw new Error(`Missing original door partner ${name} for ${sprite.name}`);
    }

    // Native special panels rotate doorN/doorW; the constructor preserves its own north field.
    if (partner.tileType !== 'doorN' && partner.tileType !== 'doorW') {
        throw new Error(`Original door partner ${name} has invalid non-door type`);
    }

    if (!(partner.properties instanceof Map) || partner.properties.has('open') === initiallyOpen) {
        throw new Error(`Original door partner ${name} has mismatched open flag`);
    }

    return partner;
}

/**
 * Validate original constructor partners without inventing a sprite or open state.
 *
 * @param {object} sprite - Actual placement sprite.
 * @param {Map} registry - Complete native registry.
 * @returns {{closed:object,open:object,toggledClosed:object,toggledOpen:object,doubleDoor:number,garageDoor:number}} Proven constructor and native toggle metadata.
 */
function doorPartners(sprite, registry) {
    const props = sprite.properties;
    const garageDoor = specialPart(props, 'GarageDoor', 3);
    const rawDoubleDoor = specialPart(props, 'DoubleDoor', 4);
    const doubleDoor = garageDoor ? 0 : rawDoubleDoor;
    let offset = 2;

    if (garageDoor) {
        offset = 8;
    } else if (doubleDoor) {
        offset = 4;
    }

    const initiallyOpen = props.has('open');
    const partner = requirePartner(sprite, offset, registry);
    const toggleOffset = doubleDoor ? (sprite.tileType === 'doorN' ? DOUBLE_NORTH_SPRITE_OFFSET : DOUBLE_WEST_SPRITE_OFFSET)[doubleDoor - 1] : offset;
    const toggledPartner = toggleOffset === offset ? partner : requirePartner(sprite, toggleOffset, registry);

    return {
        closed: initiallyOpen ? partner : sprite,
        open: initiallyOpen ? sprite : partner,
        toggledClosed: initiallyOpen ? toggledPartner : sprite,
        toggledOpen: initiallyOpen ? sprite : toggledPartner,
        doubleDoor,
        garageDoor,
    };
}

/**
 * Match the source object's north-first hoppable direction.
 *
 * @param {object} sprite - Actual resolved sprite.
 * @returns {number} Directed north or west edge, or zero.
 */
function hoppableEdges(sprite) {
    const props = sprite.properties;

    if (props.has('HoppableN')) {
        return 2;
    }

    return props.has('HoppableW') ? 4 : 0;
}

/**
 * Match the generic object's north-first uppercase window-frame direction.
 *
 * @param {object} sprite - Actual resolved sprite.
 * @returns {number} Directed north or west frame edge, or zero.
 */
function windowFrameEdges(sprite) {
    const props = sprite.properties;
    let window = 0;

    if (props.has('WindowN')) {
        window = 2;
    } else if (props.has('WindowW')) {
        window = 4;
    }

    return window;
}

/**
 * Preserve generic current-sprite hoppable/window-frame participation for doors.
 *
 * @param {object} sprite - Resolved constructor or toggle partner.
 * @returns {number} Union of source-directed standability edges.
 */
function standEdges(sprite) {
    return hoppableEdges(sprite) | windowFrameEdges(sprite);
}

/**
 * Validate the source enum direction using Java ASCII-trim semantics.
 *
 * @param {object} square - Source square for boundary diagnostics.
 * @param {string} value - Source SlopedSurfaceDirection property.
 * @returns {boolean} True for a nonnull native slope direction.
 */
function slopeFloor(square, value) {
    let start = 0;
    let end = value.length;

    // Match Java String.trim, not JavaScript's broader Unicode whitespace trimming.
    while (start < end && value.charCodeAt(start) <= 32) {
        start += 1;
    }

    while (end > start && value.charCodeAt(end - 1) <= 32) {
        end -= 1;
    }

    const direction = value.slice(start, end).toUpperCase();

    if (!SLOPE_DIRECTIONS.has(direction)) {
        throw new Error(`Unsupported original slope direction ${JSON.stringify(value)} at ${square.x},${square.y},${square.z}`);
    }

    return true;
}

/**
 * Apply the last merged static slope after native floor/stair short-circuiting.
 *
 * @param {object} square - Private projected square.
 * @param {string} value - Last static source direction.
 * @returns {void}
 */
function applySlopeFloor(square, value) {
    if (!square.solidFloor) {
        square.solidFloor = slopeFloor(square, value);
    }
}

/**
 * Preserve immutable square facts for each actual door replacement sprite.
 * Invalid needed partner slopes fail early at import, before native sprite replacement.
 *
 * @param {object} sprite - Resolved constructor or toggle partner.
 * @param {object} square - Source placement square for boundary diagnostics.
 * @returns {number} Source solid/trans/tree/floor flags.
 */
function doorSquareFlags(sprite, square) {
    const props = sprite.properties;

    if (props.has('blueprint')) {
        return 0;
    }

    let floor = props.has('solidfloor') || STAIR_TYPES.has(sprite.tileType);

    if (!floor && props.has('SlopedSurfaceDirection')) {
        floor = slopeFloor(square, props.get('SlopedSurfaceDirection'));
    }

    return (props.has('solid') ? 2 : 0) | (props.has('solidtrans') ? 4 : 0)
        | (props.has('tree') ? 8 : 0) | (floor ? 32 : 0);
}

/**
 * RecalcProperties skips blueprint before both current flags and cached type membership.
 *
 * @param {object} target - Source relation snapshot receiving positive facts.
 * @param {object} sprite - Final surviving shared current sprite.
 * @returns {object} The supplied snapshot.
 */
function addInteractionProperties(target, sprite) {
    const props = sprite.properties;

    if (!props.has('blueprint')) {
        for (const name of ['collideN', 'collideW', 'windowN', 'windowW']) {
            if (props.has(name)) {
                target[name] = true;
            }
        }

        if (sprite.tileType === 'stairsTN' || sprite.tileType === 'stairsTW') {
            target[sprite.tileType] = true;
        }
    }

    return target;
}

/**
 * Decode native sheet-relative window offsets, with the loader's tolerant remap scan.
 *
 * @param {object} sprite - Source definition.
 * @param {string} key - Offset property.
 * @param {boolean} [strict=true] - Constructor parsing rather than remap scanning.
 * @returns {number} Signed source offset or zero when absent.
 */
function windowOffset(sprite, key, strict = true) {
    const raw = sprite.properties.get(key);

    if (raw === undefined) {
        return 0;
    }

    const offset = /^[+-]?\d+$/u.test(raw) ? Number(raw) : Number.NaN;

    if (Number.isInteger(offset) && offset >= -2_147_483_648 && offset <= 2_147_483_647) {
        return offset;
    }

    if (strict) {
        throw new Error(`Unsupported original window ${key} ${JSON.stringify(raw)} on ${sprite.name}`);
    }

    return 0;
}

/**
 * Resolve an actual native window partner without inventing missing sprites.
 *
 * @param {object} sprite - Original definition.
 * @param {number} offset - Sheet-relative index.
 * @param {Map} registry - Private source definitions.
 * @returns {object|undefined} Actual partner if present.
 */
function windowPartner(sprite, offset, registry) {
    return registry.get(`${sprite.tilesetName}_${sprite.tileSheetIndex + offset}`);
}

/**
 * Isolate shared constructor mutations from caller-owned definitions.
 * Cached native sprite fields are separate from subsequently mutated flag properties.
 *
 * @param {Map} registry - Caller-owned definitions.
 * @returns {object} Private shared sprites and the loader's initial broken-window maps.
 */
function replayRegistry(registry) {
    const sprites = new Map();
    const smashed = new Map();
    const glass = new Map();

    for (const [name, sprite] of registry) {
        const props = sprite.properties;

        sprites.set(name, {
            ...sprite,
            properties: new Map(props),
            rawFloor: props.has('solidfloor'),
            cutMask: (props.has('cutN') ? 2 : 0) | (props.has('cutW') ? 4 : 0),
            wallOrder: props.has('TreatAsWallOrder'),
        });
    }

    for (const sprite of sprites.values()) {
        if (!sprite.properties.has('windowN') && !sprite.properties.has('windowW')) {
            continue;
        }

        for (const [key, variants] of [['SmashedTileOffset', smashed], ['GlassRemovedOffset', glass]]) {
            const offset = windowOffset(sprite, key, false);
            const partner = offset && windowPartner(sprite, offset, sprites);

            if (partner) {
                const previous = variants.get(partner.name);

                if (previous && previous !== sprite) {
                    throw new Error(`Ambiguous original ${key} window remap for ${partner.name}`);
                }

                variants.set(partner.name, sprite);
            }
        }
    }

    return { sprites, smashed, glass };
}

/**
 * Perform the window constructor's shared property merge, not cached-field copying.
 *
 * @param {object} closed - Actual constructor definition.
 * @param {Map} sprites - Private shared definitions.
 * @param {boolean} north - Constructor facing.
 * @returns {{smashed:object|undefined,glass:object|undefined}} Actual replacement sprites.
 */
function constructWindow(closed, sprites, north) {
    const props = closed.properties;
    const open = windowPartner(closed, windowOffset(closed, 'OpenTileOffset'), sprites);
    const smashed = windowPartner(closed, windowOffset(closed, 'SmashedTileOffset'), sprites);
    const glass = props.has('GlassRemovedOffset') ? windowPartner(closed, windowOffset(closed, 'GlassRemovedOffset'), sprites) : smashed;

    props.delete('cutN');
    props.delete('cutW');
    props.set(north ? 'cutN' : 'cutW', 'true');
    props.set(north ? 'windowN' : 'windowW', 'true');

    for (const partner of [smashed, open, glass]) {
        if (!partner || partner === closed) {
            continue;
        }

        for (const [key, value] of props) {
            partner.properties.set(key, value);
        }

        partner.tileType = closed.tileType;
    }

    return { smashed, glass };
}

/**
 * Recognize constructors that win before attachment and tree classification.
 *
 * @param {object} sprite - Current shared source definition.
 * @returns {boolean} Whether an earlier non-window object constructor wins.
 */
function beforeOverlays(sprite) {
    const props = sprite.properties;
    const container = props.get('container');

    return props.get('IsoType') === 'IsoCombinationWasherDryer' || container === 'brazier'
        || sprite.tileType === 'jukebox' || sprite.tileType === 'radio'
        || (props.has('container') && (FURNITURE_CONTAINERS.has(container)
            || STOVE_CONTAINERS.has(container?.toLowerCase())
            || (container === 'campfire' && !CAMPING_SPRITES.has(sprite.name))));
}

/**
 * Select an earlier actual wall/window/garage attachment target.
 *
 * @param {object[]} objects - Current actual object order.
 * @param {object} sprite - New wall overlay.
 * @returns {boolean} Whether the overlay attaches instead of creating an object.
 */
function wallOverlayTarget(objects, sprite) {
    const props = sprite.properties;

    if (props.has('attachedSE')) {
        return objects.some((object) => object.sprite.properties.has('WallSE'));
    }

    let edge = 0;

    if (props.has('attachedW')) {
        edge = 4;
    } else if (props.has('attachedN')) {
        edge = 2;
    }

    if (!edge) {
        return objects.some((object) => object.sprite.properties.has('cutN') || object.sprite.properties.has('cutW'));
    }

    const wall = objects.find((object) => !object.sprite.properties.has('WallSE') && (object.sprite.cutMask & edge));

    if (wall) {
        return true;
    }

    const window = objects.find((object) => object.kind === 'window' && object.special && (object.north ? 2 : 4) === edge);

    if (window?.sprite.properties.has(edge === 2 ? 'WindowN' : 'WindowW')) {
        return true;
    }

    return objects.some((object) => {
        if (object.kind !== 'door' || (object.north ? 2 : 4) !== edge || !object.sprite.properties.has('GarageDoor')) {
            return false;
        }

        const raw = object.sprite.properties.get('GarageDoor');
        const part = /^[+-]?\d+$/u.test(raw) ? Number(raw) : Number.NaN;

        if (!Number.isInteger(part) || part < -2_147_483_648 || part > 2_147_483_647) {
            throw new Error(`Unsupported original current GarageDoor ${JSON.stringify(raw)} on ${object.sprite.name}`);
        }

        return part >= 1 && part <= 6 && (!object.open || part >= 4);
    });
}

/**
 * Insert with cached wall-order fields and preserve actual special-object membership.
 *
 * @param {object[]} objects - Current actual object order.
 * @param {object} object - New actual object.
 * @param {boolean} special - AddSpecialObject rather than AddObject.
 * @returns {void}
 */
function insertObject(objects, object, special) {
    const { sprite } = object;
    const door = sprite.tileType === 'doorN' || sprite.tileType === 'doorW';
    const wallOrder = !door && (sprite.cutMask || sprite.wallOrder || sprite.tileType === 'doorFrN' || sprite.tileType === 'doorFrW');
    const index = wallOrder ? objects.findLastIndex((previous) => previous.sprite.tileType === 'doorN' || previous.sprite.tileType === 'doorW') : -1;

    object.special = special && index === -1;
    object.componentCandidate = sprite.properties.has('EntityScript')
        || (sprite.properties.has('IsMoveAble') && sprite.properties.has('CustomItem'));

    if (index === -1) {
        objects.push(object);
    } else {
        objects.splice(index, 0, object);
    }
}

/**
 * Replay one source factory placement using only retained metadata gates.
 * Generic texture fallback and later entity/runtime state are outside this metadata boundary.
 *
 * @param {object[]} objects - Current actual objects on this square.
 * @param {object} placement - Original visual placement, never modified.
 * @param {object} registry - Private shared replay definitions.
 * @param {object} square - Source square for boundary diagnostics.
 * @returns {void}
 */
function replayPlacement(objects, placement, registry, square) {
    const variant = registry.glass.get(placement.spriteName) || registry.smashed.get(placement.spriteName);
    const sprite = variant || registry.sprites.get(placement.spriteName);
    const props = sprite.properties;
    const floor = objects.find((object) => object.sprite.properties.has('solidfloor'));

    if (sprite.rawFloor && props.has('diamondFloor') && !props.has('transparentFloor') && floor?.sprite.properties.has('diamondFloor')) {
        if (floor.componentCandidate) {
            throw new Error(`Unsupported component floor replacement at ${square.x},${square.y},${square.z}`);
        }

        floor.sprite = sprite;

        return;
    }

    const object = { sprite, kind: 'other', north: false, special: false };
    let special = false;
    let replacement;

    if (sprite.tileType === 'doorN' || sprite.tileType === 'doorW') {
        object.kind = 'door';
        object.north = sprite.tileType === 'doorN';
        object.open = props.has('open');
        object.partners = doorPartners(sprite, registry.sprites);
        object.placement = placement;
        special = true;
    } else if (EARLY_OTHER_TYPES.has(sprite.tileType)) {
        special = sprite.tileType !== 'lightswitch';
    } else if (props.has('windowN') || props.has('windowW')) {
        object.kind = 'window';
        object.north = props.has('windowN');
        object.open = false;
        object.destroyed = false;
        object.glassRemoved = false;
        replacement = constructWindow(sprite, registry.sprites, object.north);
        special = true;
    } else if (props.has('WindowN') || props.has('WindowW')) {
        const overlay = objects.some((previous) => previous.sprite.tileType === 'wall'
            && ((previous.sprite.properties.has('cutN') && props.has('WindowN'))
                || (previous.sprite.properties.has('cutW') && props.has('WindowW'))));

        if (overlay) {
            return;
        }

        object.kind = 'frame';
        object.north = props.has('WindowN');
    } else if (!beforeOverlays(sprite)) {
        if (props.has('signal')) {
            if (props.get('signal') !== 'radio' && props.get('signal') !== 'tv') {
                throw new Error(`Unsupported original signal ${JSON.stringify(props.get('signal'))} on ${sprite.name}`);
            }
        } else if (props.has('Countertop')) {
            if (objects.some((previous) => previous.sprite.properties.has('CountertopAttach'))) {
                return;
            }
        } else if (props.has('WallOverlay')) {
            if (wallOverlayTarget(objects, sprite)) {
                return;
            }
        } else if (props.has('FloorOverlay')) {
            return;
        } else if (props.get('CustomName') !== 'Mannequin' && sprite.tileType === 'tree') {
            if (sprite.name.startsWith('vegetation_trees') && !floor?.sprite.name.startsWith('blends_natural')) {
                return;
            }

            const previous = objects.findIndex((candidate) => candidate.kind === 'tree');

            if (previous !== -1) {
                objects.splice(previous, 1);
            }

            object.kind = 'tree';
        }
    }

    insertObject(objects, object, special);

    if (replacement && variant) {
        // CellLoader calls setSmashed(true) before optional setGlassRemoved(true).
        object.destroyed = true;
        object.glassRemoved = registry.glass.has(placement.spriteName);
        object.sprite = object.glassRemoved ? replacement.glass : replacement.smashed;

        if (!object.sprite) {
            throw new Error(`Missing original current window sprite at ${square.x},${square.y},${square.z}`);
        }
    }
}

/**
 * Publish only an actual created door using its genuine constructor-resolved partners.
 *
 * @param {object} object - Actual door object.
 * @param {object} square - Original source placement square.
 * @param {object[]} doors - Native import rows.
 * @param {object[]} doorVisuals - Actual door visual replacements.
 * @param {Set} doorIds - Uniqueness guard.
 * @returns {void}
 */
function projectDoor(object, square, doors, doorVisuals, doorIds) {
    const { placement, north, open, partners, sprite } = object;
    const { closed, open: openSprite, toggledClosed, toggledOpen, doubleDoor, garageDoor } = partners;
    const props = sprite.properties;
    const initialClosed = open ? closed : sprite;
    const initialOpen = open ? sprite : openSprite;
    const part = doubleDoor - 1;
    const closedX = int32(placement.x + (open && doubleDoor ? (north ? DOUBLE_NORTH_DX : DOUBLE_WEST_DX)[part] : 0), 'closed door x');
    const closedY = int32(placement.y + (open && doubleDoor ? (north ? DOUBLE_NORTH_DY : DOUBLE_WEST_DY)[part] : 0), 'closed door y');
    const id = `door:${closedX}:${closedY}:${placement.z}:${placement.order}`;

    if (doorIds.has(id)) {
        throw new Error(`Duplicate original door identity ${id}`);
    }

    doorIds.add(id);
    doors.push({ id, x: closedX, y: closedY, z: placement.z, order: placement.order, north, open, locked: false, lockedByKey: false, forceLocked: props.has('forceLocked'), keyId: -1, roomId: -1, oppositeRoomId: -1, attachedE: toggledOpen.properties.has('attachedE'), attachedS: toggledOpen.properties.has('attachedS'), barricaded: false, independentWalls: 0, doubleDoor, garageDoor, interiorSide: props.has('InteriorSide'), hoppable: closed.properties.has('HoppableN') || closed.properties.has('HoppableW'), standEdges: [standEdges(initialClosed), standEdges(initialOpen), standEdges(toggledClosed), standEdges(toggledOpen)], squareFlags: [doorSquareFlags(initialClosed, square), doorSquareFlags(initialOpen, square), doorSquareFlags(toggledClosed, square), doorSquareFlags(toggledOpen, square)], interactionProperties: [initialClosed, initialOpen, toggledClosed, toggledOpen].map((current) => addInteractionProperties({}, current)), customLock: false });
    doorVisuals.push({ id, x: closedX, y: closedY, z: placement.z, order: placement.order, sourceX: placement.x, sourceY: placement.y, sourceSpriteName: placement.spriteName, closedSpriteName: closed.name, openSpriteName: openSprite.name, closedSpriteId: closed.id, openSpriteId: openSprite.id, closedSheetIndex: closed.tileSheetIndex, openSheetIndex: openSprite.tileSheetIndex, toggledClosedSpriteName: toggledClosed.name, toggledOpenSpriteName: toggledOpen.name });
}

/**
 * Aggregate final surviving objects after every shared source constructor mutation.
 *
 * @param {object} square - Private square facts.
 * @param {object[]} objects - Final actual object order.
 * @param {object[]} doors - Native import rows.
 * @param {object[]} doorVisuals - Actual door visual replacements.
 * @param {Set} doorIds - Uniqueness guard.
 * @returns {void}
 */
function projectSquareObjects(square, objects, doors, doorVisuals, doorIds) {
    let slope;

    square.interactionProperties = {};

    for (const object of objects) {
        const { sprite, kind, special, north, destroyed, open } = object;
        const props = sprite.properties;

        if (kind === 'door') {
            projectDoor(object, square, doors, doorVisuals, doorIds);
            continue;
        }

        addInteractionProperties(square.interactionProperties, sprite);

        // hasBlockedWindow searches actual objects, even blueprint/non-special windows.
        if (kind === 'window' && !destroyed && !open) {
            square.interactionProperties[north ? 'blockedWindowN' : 'blockedWindowW'] = true;
        }

        square.hoppableEdges |= hoppableEdges(sprite);
        square.windowEdges |= windowFrameEdges(sprite);

        if (kind === 'frame' || (kind === 'window' && special)) {
            square.windowEdges |= north ? 2 : 4;
        }

        if (props.has('blueprint')) {
            continue;
        }

        square.solid ||= props.has('solid');
        square.solidTrans ||= props.has('solidtrans');
        square.tree ||= sprite.tileType === 'tree' || props.has('tree');
        square.solidFloor ||= props.has('solidfloor') || STAIR_TYPES.has(sprite.tileType);

        if (props.has('SlopedSurfaceDirection')) {
            slope = props.get('SlopedSurfaceDirection');
        }
    }

    if (slope !== undefined) {
        applySlopeFloor(square, slope);
    }
}

/**
 * Preserve existing raw non-door collision masks independently of created-object facts.
 * Boolean native flags use property presence, including textual false values.
 *
 * @param {object} square - Private projected square.
 * @param {object} sprite - Resolved non-door sprite.
 * @returns {void}
 */
function aggregateCollision(square, sprite) {
    const props = sprite.properties;

    square.independentWalls |= (props.has('collideN') ? 2 : 0) | (props.has('collideW') ? 4 : 0);
    square.windows |= (props.has('WindowN') || sprite.tileType === 'windowFN' ? 2 : 0)
        | (props.has('WindowW') || sprite.tileType === 'windowFW' ? 4 : 0);
    square.doorWalls |= (props.has('DoorWallN') || props.has('DoorWallNTrans') ? 2 : 0)
        | (props.has('DoorWallW') || props.has('DoorWallWTrans') ? 4 : 0);
}

/**
 * Consume source chunks sequentially without retaining their visual placement lists.
 * Ephemeral actual-object metadata survives until all shared sprite mutations finish.
 * Rooms use deterministic dense identities plus their source cell/local mapping.
 *
 * @param {object[]} cells - Original openMapCell results.
 * @param {Map} registry - Complete source-backed tile registry.
 * @returns {Promise<{doors:object[],squares:object[],doorVisuals:object[],rooms:object[],coverage:object}>} Atomic projection.
 */
async function projectWorldObjects(cells, registry) {
    if (!Array.isArray(cells) || !(registry instanceof Map)) {
        throw new TypeError('World object projection requires map cells and a native tile registry');
    }

    const ordered = [...cells].sort((a, b) => a.cellX - b.cellX || a.cellY - b.cellY);
    const cellIndex = new Map();
    const chunkStarts = new Map();
    const doors = [];
    const squares = [];
    const doorVisuals = [];
    const doorIds = new Set();
    const replay = replayRegistry(registry);
    const actualSquares = new Map();

    for (const cell of ordered) {
        if (!Number.isInteger(cell.cellX) || !Number.isInteger(cell.cellY) || cell.cellSize !== 256 || cell.chunkSize !== 8 || cell.chunksPerAxis !== 32
            || !Number.isInteger(cell.minLevel) || !Number.isInteger(cell.maxLevel) || cell.minLevel < -32 || cell.maxLevel > 31 || cell.minLevel > cell.maxLevel
            || !Array.isArray(cell.rooms) || !Array.isArray(cell.chunks) || typeof cell.readChunk !== 'function') {
            throw new TypeError('World object projection requires original 256/8 map cell metadata');
        }

        int32(cell.cellX * 256, 'cell x');
        int32(cell.cellX * 256 + 255, 'cell x extent');
        int32(cell.cellY * 256, 'cell y');
        int32(cell.cellY * 256 + 255, 'cell y extent');
        const key = `${cell.cellX},${cell.cellY}`;

        if (cellIndex.has(key)) {
            throw new Error(`Duplicate original map cell ${key}`);
        }

        cellIndex.set(key, cell);
        chunkStarts.set(cell, new Map());
    }

    const { rooms, rectangles } = projectRooms(ordered);

    for (const cell of ordered) {
        const starts = chunkStarts.get(cell);
        const chunks = cell.chunks.filter((chunk) => chunk.present).sort((a, b) => a.chunkX - b.chunkX || a.chunkY - b.chunkY);

        for (const chunk of chunks) {
            const { chunkX, chunkY } = chunk;
            const start = squares.length;
            const x = cell.cellX * 256 + chunkX * 8;
            const y = cell.cellY * 256 + chunkY * 8;

            if (!Number.isInteger(chunkX) || !Number.isInteger(chunkY) || chunkX < 0 || chunkY < 0 || chunkX >= 32 || chunkY >= 32 || starts.has(chunkX * 32 + chunkY)) {
                throw new TypeError('Invalid or duplicate original present chunk');
            }

            starts.set(chunkX * 32 + chunkY, start);
            const rects = rectangles.get(cell).filter((rect) => rect.x < x + 8 && x < rect.x + rect.width && rect.y < y + 8 && y < rect.y + rect.height);

            for (let z = cell.minLevel; z <= cell.maxLevel; z += 1) {
                for (let index = 0; index < 64; index += 1) {
                    const dx = Math.floor(index / 8);
                    const dy = index % 8;
                    const roomId = roomAt(rects, x + dx, y + dy, z);

                    // Coverage: the current WASM world has no vehicle objects; this is not a native-map vehicle census.
                    squares.push({ x: x + dx, y: y + dy, z, roomId, outside: roomId === -1, solid: false, solidTrans: false, tree: false, solidFloor: false, hoppableEdges: 0, windowEdges: 0, independentWalls: 0, windows: 0, doorWalls: 0, vehicleObstructed: false });
                }
            }

            // eslint-disable-next-line no-await-in-loop -- Consume one present chunk, never retain a whole-map placement list.
            const placements = await cell.readChunk(chunkX, chunkY);

            for (const placement of placements) {
                int32(placement.x, 'placement x');
                int32(placement.y, 'placement y');

                if (!Number.isInteger(placement.z) || placement.z < cell.minLevel || placement.z > cell.maxLevel
                    || placement.x < x || placement.x >= x + 8 || placement.y < y || placement.y >= y + 8
                    || !Number.isInteger(placement.order) || placement.order < 0) {
                    throw new TypeError('Invalid original placement coordinate or order');
                }

                const sprite = registry.get(placement.spriteName);

                if (!sprite || !(sprite.properties instanceof Map)) {
                    throw new Error(`Unknown original sprite ${placement.spriteName} at ${placement.x},${placement.y},${placement.z}; cannot prove absence of world objects`);
                }

                const square = squares[start + (placement.z - cell.minLevel) * 64 + (placement.x - x) * 8 + placement.y - y];

                if (sprite.tileType !== 'doorN' && sprite.tileType !== 'doorW') {
                    aggregateCollision(square, sprite);
                }

                let objects = actualSquares.get(square);

                if (!objects) {
                    objects = [];
                    actualSquares.set(square, objects);
                }

                replayPlacement(objects, placement, replay, square);
            }
        }
    }

    for (const [square, objects] of actualSquares) {
        projectSquareObjects(square, objects, doors, doorVisuals, doorIds);
    }

    for (const door of doors) {
        const cell = cellIndex.get(`${Math.floor(door.x / 256)},${Math.floor(door.y / 256)}`);
        const chunkX = Math.floor((door.x - (cell?.cellX ?? 0) * 256) / 8);
        const chunkY = Math.floor((door.y - (cell?.cellY ?? 0) * 256) / 8);
        const start = cell && chunkStarts.get(cell).get(chunkX * 32 + chunkY);

        if (start === undefined || !cell || door.z < cell.minLevel || door.z > cell.maxLevel) {
            throw new Error(`Original closed door square is not loaded: ${door.id}`);
        }

        const square = squares[start + (door.z - cell.minLevel) * 64 + (door.x - cell.cellX * 256 - chunkX * 8) * 8 + door.y - cell.cellY * 256 - chunkY * 8];
        const oppositeX = door.x - (door.north ? 0 : 1);
        const oppositeY = door.y - (door.north ? 1 : 0);
        const oppositeCell = cellIndex.get(`${Math.floor(oppositeX / 256)},${Math.floor(oppositeY / 256)}`);

        door.roomId = square.roomId;
        door.oppositeRoomId = oppositeCell ? roomAt(rectangles.get(oppositeCell), oppositeX, oppositeY, door.z) : -1;
        door.independentWalls = square.independentWalls;
    }

    return { doors, squares, doorVisuals, rooms, coverage: { vehicles: 'absent-from-current-wasm-world', barricades: 'not-spawned-by-original-map-loader' } };
}

export { loadNativeTileRegistry, nativeTileSources, projectWorldObjects };
