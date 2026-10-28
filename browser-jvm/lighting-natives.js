import { calculateLighting } from './lighting-kernel.js';

/** Native argument failure that original Java callers can catch without losing cleanup. */
class NativeArgumentError extends Error {
    name = 'NativeArgumentError';
}

/**
 * Rejects host inputs outside the genuine native-reference closure.
 *
 * @param {string} reason - Unsupported input or lifecycle description.
 * @throws {RangeError} Always, with the unsupported boundary.
 */
function unsupported(reason) {
    throw new RangeError(`Unsupported lighting boundary: ${reason}`);
}

/**
 * Returns a real Java failure so the original caller can catch it and clean up.
 *
 * @param {object} lib - Calling Java library namespace.
 * @param {Error} error - Explicit unsupported boundary or protocol failure.
 * @returns {Promise<never>} Rejected with the corresponding Java exception.
 */
async function throwJavaFailure(lib, error) {
    let name = 'IllegalStateException';

    if (error instanceof NativeArgumentError) {
        name = 'IllegalArgumentException';
    } else if (error instanceof RangeError) {
        name = 'UnsupportedOperationException';
    }

    const Exception = await lib.java.lang[name];

    throw await new Exception(error.message);
}

/**
 * Validates one bounded integer before mutating backend state.
 *
 * @param {number} value - Native integer argument.
 * @param {number} minimum - Inclusive minimum.
 * @param {number} maximum - Inclusive maximum.
 * @param {string} name - Input description.
 */
function integer(value, minimum, maximum, name) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        unsupported(name);
    }
}

/**
 * Requires finite native float arguments.
 *
 * @param {number[]} values - Values to validate together.
 * @param {string} name - Input description.
 */
function finite(values, name) {
    if (!values.every(Number.isFinite)) {
        unsupported(name);
    }
}

/**
 * Validates an original static light's RGB channels.
 *
 * @param {number[]} color - Original float32 RGB triple.
 */
function validateColor(color) {
    finite(color, 'light RGB');

    if (color.some((value) => value < 0 || value > 1)) {
        unsupported('light RGB');
    }
}

/**
 * Finds genuine center/vertex changes and newly submitted square geometry.
 *
 * @param {object} state - Retained region coordinates.
 * @param {number[][]|null} previous - Previous worker output.
 * @param {number[][]} next - New worker output.
 * @param {Set<string>} submitted - Actually submitted world chunk keys.
 * @returns {Set<number>} Square indices marked by this calculation.
 */
function changedSquares(state, previous, next, submitted) {
    const dirty = new Set();

    for (const [index, element] of next.entries()) {
        if (element === null) {
            continue;
        }

        const planeIndex = index % (state.width * state.height * 64);
        const x = Math.floor(index % (state.width * 8) / 8) + state.x;
        const y = Math.floor(planeIndex / (state.width * 64)) + state.y;

        const z = Math.floor(index / (state.width * state.height * 64));

        if (previous === null || submitted.has(`${x},${y}`) || submitted.has(`${x},${y},${z}`)
            || previous[index] === null || element.slice(0, 14).some((value, word) => value !== previous[index][word])) {
            dirty.add(index);
        }
    }

    return dirty;
}

/**
 * Identifies changed native chunk payloads for the worker's next publication.
 *
 * @param {object} state - Retained player region.
 * @param {Set<number>} squares - Squares newly marked by the calculation.
 * @returns {Set<string>} World chunk keys whose result changed.
 */
function changedChunks(state, squares) {
    const dirty = new Set();

    for (const index of squares) {
        const plane = state.width * state.height * 64;
        const x = Math.floor(index % (state.width * 8) / 8) + state.x;
        const y = Math.floor(index % plane / (state.width * 64)) + state.y;
        const z = Math.floor(index / plane);

        dirty.add(`${x},${y},${z}`);
    }

    return dirty;
}

/**
 * Restores world coordinates to native result-light records after local calculation.
 *
 * @param {object} state - Retained player region.
 * @param {number[][]} output - Owned local output payloads.
 */
function restoreCoordinates(state, output) {
    for (const payload of output) {
        if (payload === null) {
            continue;
        }

        for (let record = 0; record < payload[13]; record++) {
            payload[15 + record * 6] += state.x * 8;
            payload[16 + record * 6] += state.y * 8;
        }
    }
}

/**
 * Initializes actual newly allocated native level readback without inventing square geometry.
 *
 * @param {object} state - Owning region and dirty maps.
 * @param {Set<string>} allocations - Newly admitted world chunk levels.
 * @param {Array} output - Existing physical readback slots.
 * @param {object} origin - Origin belonging to this particular readback buffer.
 * @param {boolean} dirty - Whether main allocation exposes initial dirty bytes.
 */
function allocateLevelReadback(state, allocations, output, origin, dirty) {
    if (!output) {
        return;
    }

    for (const key of allocations) {
        const [x, y, z] = key.split(',').map(Number);

        if (x < origin.x || y < origin.y || x >= origin.x + state.width || y >= origin.y + state.height) {
            continue;
        }

        const first = z * state.width * state.height * 64 + (y - origin.y) * 64 * state.width + (x - origin.x) * 8;

        for (let cell = 0; cell < 64; cell++) {
            const index = first + Math.floor(cell / 8) * state.width * 8 + cell % 8;

            if (output[index] === null) {
                output[index] = Array.from({ length: 49 }, () => 0);

                if (dirty) {
                    state.squareDirty.add(index);
                    state.chunkDirty.add(key);
                }

                if (dirty && state.workerReady) {
                    state.computedSquareDirty.add(index);
                    state.computedChunkDirty.add(key);
                }
            }
        }
    }
}

/**
 * Retires allocation rights once no retained native chunk owner remains.
 *
 * @param {object} state - Working, computed and published chunk owners.
 * @param {Map<string, number[]>} main - Current main queue's world chunk ranges.
 */
function retainReadbackOwners(state, main) {
    if (!state.allocatedLevels) {
        return;
    }

    const owned = new Set([main, state.ranges, state.computedRanges, state.publishedRanges, state.deferred?.ranges]
        .flatMap((ranges) => [...(ranges?.keys() ?? [])]));

    state.allocatedLevels = new Set([...state.allocatedLevels].filter((key) => owned.has(key.slice(0, key.lastIndexOf(',')))));
}

/**
 * Initializes native0xd460's two whole-region dirty banks once for each physical level.
 * Geometry and readable-payload admission remain separate.
 *
 * @param {object} state - Fixed-size native region owner.
 * @param {Map<string, number[]>} ranges - Main's actual allocated chunk level ranges.
 */
function allocateDirtyLevels(state, ranges) {
    const plane = state.width * state.height * 64;
    const chunks = state.width * state.height;

    if (!state.physicalLevels) {
        state.physicalLevels = new Set();
        state.readSquareDirty = new Uint8Array(plane * 64);
        state.writeSquareDirty = new Uint8Array(plane * 64);
        state.readChunkDirty = new Uint8Array(chunks * 64);
        state.writeChunkDirty = new Uint8Array(chunks * 64);
    }

    for (const [minimum, maximum] of ranges.values()) {
        for (let z = minimum; z <= maximum; z++) {
            if (state.physicalLevels.has(z)) {
                continue;
            }

            state.physicalLevels.add(z);
            state.readSquareDirty.fill(1, z * plane, (z + 1) * plane);
            state.writeSquareDirty.fill(1, z * plane, (z + 1) * plane);
            state.readChunkDirty.fill(1, z * chunks, (z + 1) * chunks);
            state.writeChunkDirty.fill(1, z * chunks, (z + 1) * chunks);
        }
    }
}

/**
 * Retains only overlapping world squares when the native chunk-pointer grid moves.
 *
 * @param {Array} values - Original region-indexed storage.
 * @param {object} from - Original chunk origin and extent.
 * @param {object} to - Destination chunk origin and extent.
 * @returns {Array} Destination storage with absent incoming strips.
 */
function moveRegion(values, from, to) {
    if (!values) {
        return values;
    }

    const width = to.width * 8;
    const height = to.height * 8;
    const plane = width * height;
    const result = Array.from({ length: values.length }, () => null);
    const dx = (to.x - from.x) * 8;
    const dy = (to.y - from.y) * 8;

    for (let z = 0; z < 64; z++) {
        for (let y = Math.max(0, -dy); y < Math.min(height, height - dy); y++) {
            for (let x = Math.max(0, -dx); x < Math.min(width, width - dx); x++) {
                result[z * plane + y * width + x] = values[z * plane + (y + dy) * width + x + dx];
            }
        }
    }

    return result;
}

/**
 * Applies ordered native worker commands to a private geometry/history projection.
 *
 * @param {object} state - Committed main/worker state.
 * @returns {object} Projected state without changing published buffers.
 */
function projectMovement(state) {
    const { deferred, computed, computedX, computedY, x, y, cells, ranges, movements = [] } = state;
    let projected = {
        ...state, x: deferred?.x ?? x, y: deferred?.y ?? y,
        cells: deferred?.cells ?? cells, ranges: deferred?.ranges ?? ranges,
    };
    let history = computed;
    let historyOrigin = { ...state, x: computedX ?? x, y: computedY ?? y };

    if (deferred?.movementRevisions?.some((revision, index) => revision !== movements[index]?.revision)) {
        let destination = { ...state };

        for (const command of movements.slice(0, deferred.movementCount)) {
            destination = {
                ...destination,
                x: command.x ?? destination.x + command.dx, y: command.y ?? destination.y + command.dy,
            };
        }

        // Coalescing changes the earlier teleport, not the world coordinates of later queued geometry.
        projected.cells = moveRegion(projected.cells, projected, destination);
        projected = { ...projected, x: destination.x, y: destination.y };
        projected.ranges = new Map([...projected.ranges].filter(([key]) => {
            const [chunkX, chunkY] = key.split(',').map(Number);

            return chunkX >= destination.x && chunkY >= destination.y
                && chunkX < destination.x + destination.width && chunkY < destination.y + destination.height;
        }));
    }

    for (const [commandIndex, command] of movements.entries()) {
        const historyNext = {
            ...historyOrigin,
            x: command.x ?? historyOrigin.x + command.dx, y: command.y ?? historyOrigin.y + command.dy,
        };

        history = command.teleport ? history?.map(() => null) : moveRegion(history, historyOrigin, historyNext);
        historyOrigin = historyNext;

        if (commandIndex < (deferred?.movementCount ?? 0)) {
            continue;
        }

        const next = { ...projected, x: command.x ?? projected.x + command.dx, y: command.y ?? projected.y + command.dy };

        projected.cells = command.teleport
            ? projected.cells?.map(() => null)
            : moveRegion(projected.cells, projected, next);
        projected = { ...next, cells: projected.cells };
        projected.ranges = new Map([...projected.ranges].filter(([key]) => {
            const [x, y] = key.split(',').map(Number);

            return !command.teleport && x >= next.x && y >= next.y && x < next.x + next.width && y < next.y + next.height;
        }));
    }

    projected.history = history;
    projected.moved = true;

    if (deferred) {
        projected.deferred = {
            ...deferred, x: projected.x, y: projected.y, cells: projected.cells, ranges: projected.ranges,
            movementCount: movements.length,
            movementRevisions: movements.map((command) => command.revision),
        };
    }

    return projected;
}

/**
 * Marks native indexed readback bytes when a worker consumes a moved map.
 *
 * @param {object} state - Player buffers and dirty bytes.
 */
function markMovedReadback(state) {
    for (const [index, payload] of (state.published ?? []).entries()) {
        if (payload !== null) {
            state.squareDirty.add(index);
        }
    }
}

/**
 * Calculates only the actual loaded level span while retaining the native64-level indices.
 * Sparse region slots remain absent and are never exposed as invented square payloads.
 *
 * @param {object} scene - Staged native region.
 * @returns {number[][]} Owned64-level payload array with explicit absent slots.
 */
function calculateRetainedLighting(scene) {
    const plane = scene.width * scene.height;
    let minimum = 64;
    let maximum = -1;

    for (let index = 0; index < scene.cells.length; index++) {
        if (scene.cells[index] !== null) {
            const z = Math.floor(index / plane);

            minimum = Math.min(minimum, z);
            maximum = Math.max(maximum, z);
        }
    }

    if (maximum < minimum) {
        return Array.from({ length: scene.cells.length }, () => null);
    }

    const compact = calculateLighting({
        ...scene, minimum, maximum, cells: scene.cells.slice(minimum * plane, (maximum + 1) * plane),
        seen: scene.seen?.slice(minimum * plane, (maximum + 1) * plane),
    });
    const output = Array.from({ length: scene.cells.length }, () => null);

    for (const [index, element] of compact.entries()) {
        output[minimum * plane + index] = element;
    }

    return output;
}

/**
 * Builds native0x41a0's LOS-visible room set using its unsigned64-bit tree ordering.
 *
 * @param {object[]} cells - Geometry belonging to the computed buffer.
 * @param {number[][]} payloads - Completed worker payloads.
 * @returns {bigint[]} Ordered native room identifiers.
 */
function visibleRooms(cells, payloads) {
    const identifiers = new Set();

    for (const [index, payload] of payloads.entries()) {
        if (cells[index] && (payload?.[0] & 4)) {
            const room = BigInt(cells[index].room ?? -1);

            if (room !== -1n) {
                identifiers.add(room);
            }
        }
    }

    return [...identifiers].sort((first, second) => BigInt.asUintN(64, first) < BigInt.asUintN(64, second) ? -1 : 1);
}

/**
 * Detects geometry that changes native cached rays, including newly admitted objects.
 *
 * @param {object[]} cells - Staged geometry.
 * @param {object[]} previous - Retained geometry.
 * @returns {boolean} Whether LOS invalidation is required.
 */
function visionChanged(cells, previous) {
    return cells.some((cell, index) => {
        const old = previous[index];

        return cell !== old && (cell?.vision !== old?.vision || cell?.stairs !== old?.stairs
            || JSON.stringify(cell?.objects ?? []) !== JSON.stringify(old?.objects ?? []));
    });
}

/**
 * Creates a native lighting service for the qualified static sparse-world closure.
 * Registration does not load a library or change original LightingJNI.init fields.
 * See lighting-provenance.md for evidence and unsupported engine boundaries.
 *
 * @returns {object} Native handlers, direct protocol methods and detached diagnostics.
 */
export function createLightingNatives() {
    let configured = false;
    let active = null;
    let chunk = null;
    let square = null;
    let level = null;
    const states = new Map();
    const lights = new Map();
    const roomLights = new Map();
    const torches = new Map();
    let lastUpdate = null;

    /**
     * Requires the original native update transaction.
     *
     * @returns {object} Current staged update.
     */
    function requireUpdate() {
        if (!active) {
            throw new Error('LightingJNI: missing stateBeginUpdate');
        }

        return active;
    }

    /**
     * Stages an admitted native object without changing published geometry.
     *
     * @param {string} type - Original native method name.
     * @param {Array<number|boolean>} args - Literal original arguments.
     */
    function stageObject(type, args) {
        if (!square || square.mask === undefined) {
            unsupported('object square lifecycle');
        }

        const curtain = type === 'squareAddCurtain';
        const extended = type === 'squareAddThumpable' || type === 'squareAddWindow' || type === 'squareAddDoor';

        if ((curtain && (![4, 8, 16, 32].includes(args[0]) || typeof args[1] !== 'boolean'))
            || (extended && (args.length !== (type === 'squareAddThumpable' ? 4 : 3)
                || args.some((value) => typeof value !== 'boolean')))
            || (!curtain && !extended && (typeof args[0] !== 'boolean' || args[1] !== false || args[2] !== false))) {
            unsupported(`${type} state`);
        }

        square.objects ??= [];
        square.objects.push({ type, args: [...args] });
    }

    /**
     * Resolves the one qualified player without fabricating an initialized state.
     *
     * @param {number} player - Original player index.
     * @returns {object|undefined} Retained player state, when created.
     */
    function playerState(player) {
        if (player !== 0) {
            unsupported('multiple players');
        }

        return states.get(player);
    }

    /**
     * Queues native movement without changing the currently published region.
     *
     * @param {number} player - Original player index.
     * @param {object} command - Ordered chunk movement or coalesced teleport.
     */
    function queueMovement(player, command) {
        const state = playerState(player);

        if (!state) {
            if (command.teleport) {
                unsupported('teleport before region initialization');
            }

            return;
        }

        state.movements ??= [];
        state.movementRevision = (state.movementRevision ?? 0) + 1;

        const previous = command.teleport && state.movements.find((movement) => movement.teleport);
        const revised = { ...command, revision: state.movementRevision };

        if (previous) {
            Object.assign(previous, revised);
        } else {
            state.movements.push(revised);
        }
    }

    /**
     * Resolves an actual published square inside the fixed region.
     *
     * @param {number} player - Original player index.
     * @param {number} x - World square X.
     * @param {number} y - World square Y.
     * @param {number} z - Native level, including the original32 offset.
     * @returns {object|null} State and row-major index, or null outside the region.
     */
    function lookup(player, x, y, z) {
        const state = playerState(player);

        integer(x, -2_147_483_648, 2_147_483_647, 'square X');
        integer(y, -2_147_483_648, 2_147_483_647, 'square Y');
        integer(z, 0, 63, 'square level');

        const originX = state?.publishedX ?? state?.x;
        const originY = state?.publishedY ?? state?.y;

        if (!state || x < originX * 8 || y < originY * 8
            || x >= (originX + state.width) * 8 || y >= (originY + state.height) * 8) {
            return null;
        }

        const index = z * state.width * state.height * 64 + (y - originY * 8) * state.width * 8 + x - originX * 8;
        const cells = state.publishedCells ?? state.cells;
        const ranges = state.readbackRanges ?? state.publishedRanges ?? state.ranges;

        // Bootstrap native readback exposes uninitialized words; keep the explicit publication guard.
        if (!cells || ranges.size === 0) {
            return { state, index };
        }

        const allocatedRange = ranges.get(`${Math.floor(x / 8)},${Math.floor(y / 8)}`);

        if (allocatedRange && z >= allocatedRange[0] && z <= allocatedRange[1]
            && state.allocatedLevels?.has(`${Math.floor(x / 8)},${Math.floor(y / 8)},${z}`)
            && state.published?.[index] !== null && state.published?.[index] !== undefined) {
            return { state, index };
        }

        if (cells[index] === null) {
            const range = ranges.get(`${Math.floor(x / 8)},${Math.floor(y / 8)}`);

            if (range && z >= range[0] && z <= range[1]) {
                unsupported('absent-square readback');
            }

            return null;
        }

        return { state, index };
    }

    const methods = {
        /**
         * Queues the native westward chunk-grid shift.
         *
         * @param {number} player - Original player index.
         */
        scrollLeft(player) {
            queueMovement(player, { dx: -1, dy: 0 });
        },
        /**
         * Queues the native eastward chunk-grid shift.
         *
         * @param {number} player - Original player index.
         */
        scrollRight(player) {
            queueMovement(player, { dx: 1, dy: 0 });
        },
        /**
         * Queues the native northward chunk-grid shift.
         *
         * @param {number} player - Original player index.
         */
        scrollUp(player) {
            queueMovement(player, { dx: 0, dy: -1 });
        },
        /**
         * Queues the native southward chunk-grid shift.
         *
         * @param {number} player - Original player index.
         */
        scrollDown(player) {
            queueMovement(player, { dx: 0, dy: 1 });
        },
        /**
         * Replaces the queued teleport destination without reordering the command.
         *
         * @param {number} player - Original player index.
         * @param {number} x - New minimum world chunk X.
         * @param {number} y - New minimum world chunk Y.
         */
        teleport(player, x, y) {
            integer(x, 0, 65_535, 'region X');
            integer(y, 0, 65_535, 'region Y');
            queueMovement(player, { x, y, teleport: true });
        },
        /**
         * Stores the genuine native solver's qualified configuration value.
         *
         * @param {number} value - Original solver interval.
         */
        configure(value) {
            finite([value], 'configure interval');

            if (Math.fround(value) !== Math.fround(0.005)) {
                unsupported('configure interval');
            }

            configured = true;
        },
        /**
         * Stages geometry updates against the retained region.
         *
         * @param {number} player - Original player index.
         * @param {number} x - Minimum world chunk X.
         * @param {number} y - Minimum world chunk Y.
         * @param {number} width - Region width in chunks.
         * @param {number} height - Region height in chunks.
         */
        stateBeginUpdate(player, x, y, width, height) {
            if (!configured) {
                throw new Error('Lighting backend is not configured');
            }

            if (active) {
                throw new Error('LightingJNI: missing stateEndUpdate');
            }

            integer(x, 0, 65_535, 'region X');
            integer(y, 0, 65_535, 'region Y');
            integer(width, 1, 13, 'region width');
            integer(height, 1, 13, 'region height');

            let state = playerState(player);
            const baseState = state;

            if (state && (state.width !== width || state.height !== height)) {
                unsupported('region resize');
            }

            if (state?.movements?.length) {
                state = projectMovement(state);
            }

            if (state && (state.x !== x || state.y !== y)) {
                unsupported('region origin without queued movement');
            }

            if (!state) {
                state = {
                    x, y, width, height, counter: 0, cells: null, published: null, computed: null,
                    pending: null, deferred: null, workerReady: false, playerInitialized: false,
                    registeredLights: new Set(), previousPlayer: null, ranges: new Map(),
                    squareDirty: new Set(), computedSquareDirty: new Set(), chunkDirty: new Set(), computedChunkDirty: new Set(),
                    recycledChunkDirty: new Set(),
                };
            }

            let cells = Array.from({ length: width * height * 64 * 64 }, () => null);

            if (state.cells) {
                cells = [...state.cells];
            }

            if (state.deferred) {
                cells = [...state.deferred.cells];
            }

            active = {
                state, baseState, player, cells, chunks: new Set(state.deferred?.chunks), cleared: state.deferred?.cleared,
                ranges: new Map(state.deferred?.ranges ?? state.ranges),
                playerPosition: state.deferred?.playerPosition, worldPlayer: state.deferred?.worldPlayer,
                perception: state.deferred?.perception, sky: state.deferred?.sky,
                sourceUpdate: state.deferred?.sourceUpdate, frameCount: state.deferred?.frameCount ?? 0,
                levelSubmissions: new Set(state.deferred?.levelSubmissions), allocations: new Set(state.deferred?.allocations),
            };
        },
        /**
         * Stages one player's position and view while retaining computed visibility history.
         *
         * @param {number} x - World player X.
         * @param {number} y - World player Y.
         * @param {number} z - Native level32.
         * @param {number} directionX - Original look-vector X.
         * @param {number} directionY - Original look-vector Y.
         * @param {boolean} flagA - Original perception flag.
         * @param {boolean} flagB - Original perception flag.
         * @param {boolean} flagC - Original perception flag.
         * @param {boolean} flagD - Original perception flag.
         * @param {number} fatigue - Original player fatigue.
         * @param {number} range - Original near-detection radius.
         * @param {number} cone - Original vision-cone threshold.
         */
        playerSet(x, y, z, directionX, directionY, flagA, flagB, flagC, flagD, fatigue, range, cone) {
            const update = requireUpdate();
            const { state } = update;

            finite([x, y, z, directionX, directionY, fatigue, range, cone], 'player input');

            z = Math.fround(z);
            integer(Math.floor(z), 0, 63, 'player native level');

            if (x < state.x * 8 || y < state.y * 8
                || x >= (state.x + state.width) * 8 || y >= (state.y + state.height) * 8) {
                unsupported('player outside qualified region');
            }

            if (flagA !== false || flagB !== false || flagC !== false || flagD !== false
                || fatigue !== 0 || range < 0 || range > 20 || cone < -1 || cone > 1) {
                unsupported('player flags or perception');
            }

            update.playerPosition = [x - state.x * 8, y - state.y * 8, z];
            update.worldPlayer = [x, y, z];
            update.perception = { directionX, directionY, range, fatigue, cone };
        },
        /**
         * Stages original frame settings and LOS invalidation.
         *
         * @param {number} red - Original red modifier.
         * @param {number} green - Original green modifier.
         * @param {number} blue - Original blue modifier.
         * @param {number} ambient - Original ambient strength.
         * @param {number} night - Original night modifier.
         * @param {number} view - Original view distance.
         * @param {number} maximumView - Original maximum view distance.
         * @param {boolean} cleared - Original LOS cache invalidation flag.
         * @param {number} sourceUpdate - Original light-source update value.
         * @param {number} sky - Original skylight level.
         */
        stateEndFrame(red, green, blue, ambient, night, view, maximumView, cleared, sourceUpdate, sky) {
            const update = requireUpdate();

            finite([red, green, blue, ambient, night, view, maximumView, sourceUpdate, sky], 'frame input');

            if ([red, green, blue, ambient, night].some((value) => value < 0 || value > 1)
                || view <= 0 || maximumView < view || maximumView > 256 || typeof cleared !== 'boolean'
                || ![0, 100].includes(sourceUpdate)) {
                unsupported('ambient, sunlight or frame settings');
            }

            integer(sky, 0, 0xFF_FF_FF, 'skylight');
            // eslint-disable-next-line unicorn/prefer-math-trunc -- Original frame command increments a signed int32.
            update.frameCount = (update.frameCount + 1) | 0;
            update.sky = sky;
            update.sourceUpdate = sourceUpdate;

            update.cleared = Boolean(update.cleared || cleared);
        },
        /**
         * Opens one changed original chunk without discarding retained neighbors.
         *
         * @param {number} x - World chunk X.
         * @param {number} y - World chunk Y.
         * @param {number} minimum - Minimum native level.
         * @param {number} maximum - Maximum native level.
         */
        chunkBeginUpdate(x, y, minimum, maximum) {
            const update = requireUpdate();
            const { state, cells, chunks, ranges, allocations } = update;

            integer(x, state.x, state.x + state.width - 1, 'chunk X');
            integer(y, state.y, state.y + state.height - 1, 'chunk Y');

            integer(minimum, 0, 63, 'chunk minimum level');
            integer(maximum, minimum, 63, 'chunk maximum level');

            if (chunk || square) {
                unsupported('chunk lifecycle');
            }

            const previous = ranges.get(`${x},${y}`);

            if (previous && (previous[0] !== minimum || previous[1] !== maximum)) {
                const plane = state.width * state.height * 64;
                const row = state.width * 8;
                const first = (y - state.y) * 8 * row + (x - state.x) * 8;

                for (let z = minimum; z <= maximum; z++) {
                    if (z < previous[0] || z > previous[1]) {
                        allocations.add(`${x},${y},${z}`);
                    }
                }

                for (let z = previous[0]; z <= previous[1]; z++) {
                    if (z >= minimum && z <= maximum) {
                        continue;
                    }

                    for (let index = 0; index < 64; index++) {
                        cells[z * plane + first + Math.floor(index / 8) * row + index % 8] = null;
                    }
                }
            }

            chunk = { x, y, minimum, maximum };
            chunks.add(`${x},${y}`);
            ranges.set(`${x},${y}`, [minimum, maximum]);
        },
        /**
         * Opens the one qualified native chunk level.
         *
         * @param {number} z - Native level32.
         */
        chunkLevelBeginUpdate(z) {
            if (!chunk || level !== null || !Number.isInteger(z) || z < chunk.minimum || z > chunk.maximum) {
                unsupported('chunk-level lifecycle');
            }

            level = z;
            requireUpdate().levelSubmissions.add(`${chunk.x},${chunk.y},${z}`);
        },
        /**
         * Opens one actual chunk-local square.
         *
         * @param {number} x - Chunk-local square X.
         * @param {number} y - Chunk-local square Y.
         * @param {number} z - Native level32.
         */
        squareBeginUpdate(x, y, z) {
            integer(x, 0, 7, 'local square X');
            integer(y, 0, 7, 'local square Y');

            if (!chunk || square || level === null || z !== level) {
                unsupported('square lifecycle');
            }

            square = { x: chunk.x * 8 + x, y: chunk.y * 8 + y, z };
        },
        /**
         * Stages genuine adjacency and vision data; unsupported world features reject.
         *
         * @param {number} mask - Original eight directional adjacency bits.
         * @param {boolean} up - Original upward adjacency.
         * @param {boolean} down - Original downward adjacency.
         * @param {boolean} stairs - Original stair flag.
         * @param {number} vision - Original vision matrix.
         * @param {bigint} building - Original building identifier.
         * @param {bigint} room - Original room identifier.
         * @param {number} lightLevel - Original ambient square level.
         * @param {boolean} openAir - Original outdoors flag.
         */
        squareSet(mask, up, down, stairs, vision, building, room, lightLevel, openAir) {
            if (!square) {
                throw new Error('LightingJNI: missing squareBeginUpdate');
            }

            integer(mask, 0, 255, 'flat adjacency');
            integer(vision, 0, 0x7_FF_FF_FF, 'vision matrix');
            integer(lightLevel, 0, 0xFF_FF_FF, 'square ambient');

            if (typeof up !== 'boolean' || typeof down !== 'boolean' || typeof stairs !== 'boolean'
                || typeof building !== 'bigint' || typeof room !== 'bigint' || typeof openAir !== 'boolean') {
                unsupported('vertical flags, rooms, buildings, ambient or outdoors');
            }

            // Retain the JNI input for diagnostics; native worker 0x180008650 resets lightLevel before seeding ambient.
            Object.assign(square, { mask, vision, up, down, stairs, building, room, lightLevel, openAir });
        },
        /**
         * Stages the native four RGB/transmission/coefficient endpoint tuples.
         *
         * @param {...number} values - Four original RGB/transmission/coefficient tuples.
         */
        squareSetLightTransmission(...values) {
            if (!square || values.length !== 20 || values.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
                unsupported('colored or translucent edges');
            }

            square.transmission = [...values];
        },
        /**
         * Stages an original open or closed curtain on its actual attached side.
         *
         * @param {number} mask - Original curtain attachment bits.
         * @param {boolean} open - Original open flag.
         */
        squareAddCurtain(mask, open) {
            stageObject('squareAddCurtain', [mask, open]);
        },
        /**
         * Stages an original door and its actual open/transparency crossing state.
         *
         * @param {boolean} north - Original north-facing flag.
         * @param {boolean} open - Original open flag.
         * @param {boolean} transparent - Original transparent-door flag.
         */
        squareAddDoor(north, open, transparent) {
            stageObject('squareAddDoor', [north, open, transparent]);
        },
        /**
         * Stages the original thumpable edge and its literal native flags.
         *
         * @param {boolean} north - Original north-facing flag.
         * @param {boolean} open - Original open flag.
         * @param {boolean} door - Original door classification.
         * @param {boolean} transparent - Original doorTrans/open-door flag.
         */
        squareAddThumpable(north, open, door, transparent) {
            stageObject('squareAddThumpable', [north, open, door, transparent]);
        },
        /**
         * Stages the original window edge, including the thumpable companion record.
         *
         * @param {boolean} north - Original north-facing flag.
         * @param {boolean} open - Original open flag.
         * @param {boolean} opaque - Original visibility-blocking flag.
         */
        squareAddWindow(north, open, opaque) {
            stageObject('squareAddWindow', [north, open, opaque]);
        },
        /**
         * Commits one validated square only to the staged update.
         */
        squareEndUpdate() {
            if (!square || !square.transmission || square.mask === undefined) {
                unsupported('incomplete square');
            }

            const update = requireUpdate();
            const { state, cells } = update;
            const index = square.z * state.width * state.height * 64
                + (square.y - state.y * 8) * state.width * 8 + square.x - state.x * 8;

            cells[index] = {
                mask: square.mask, vision: square.vision, up: square.up, down: square.down, stairs: square.stairs,
                building: square.building, room: square.room === -1n ? -1 : square.room,
                lightLevel: square.lightLevel, openAir: square.openAir,
                transmission: square.transmission, objects: square.objects ?? [],
            };
            square = null;
        },
        /**
         * Stages the original explicitly absent square without creating geometry.
         *
         * @param {number} x - Chunk-local square X.
         * @param {number} y - Chunk-local square Y.
         * @param {number} z - Native level in the current chunk.
         */
        squareSetNull(x, y, z) {
            const update = requireUpdate();

            integer(x, 0, 7, 'null local square X');
            integer(y, 0, 7, 'null local square Y');

            if (!chunk || square || z !== level) {
                unsupported('null square lifecycle');
            }

            const { state, cells } = update;
            const index = z * state.width * state.height * 64
                + ((chunk.y - state.y) * 8 + y) * state.width * 8 + (chunk.x - state.x) * 8 + x;

            cells[index] = null;
        },
        /**
         * Closes an original chunk-level update.
         */
        chunkLevelEndUpdate() {
            if (level === null || square) {
                unsupported('level lifecycle');
            }

            level = null;
        },
        /**
         * Closes an original changed-chunk update.
         */
        chunkEndUpdate() {
            if (!chunk || level !== null || square) {
                unsupported('chunk lifecycle');
            }

            chunk = null;
        },
        /**
         * Reports whether this actual chunk has a published calculation.
         *
         * @param {number} x - World chunk X.
         * @param {number} y - World chunk Y.
         * @returns {boolean} Native publication readiness.
         */
        chunkLightingDone(x, y) {
            const { state } = requireUpdate();
            const originX = state.publishedX ?? state.x;
            const originY = state.publishedY ?? state.y;
            const ranges = state.publishedRanges ?? state.ranges;

            integer(x, -2_147_483_648, 2_147_483_647, 'chunk X');
            integer(y, -2_147_483_648, 2_147_483_647, 'chunk Y');

            return state.published !== null && x >= originX && y >= originY
                && x < originX + state.width && y < originY + state.height && ranges.has(`${x},${y}`);
        },
        /**
         * Registers a genuine bounded static point light.
         *
         * @param {number} id - Original light identifier.
         * @param {number} x - World square X.
         * @param {number} y - World square Y.
         * @param {number} z - Native level32.
         * @param {number} radius - Original byte-sized radius.
         * @param {number} red - Original red channel.
         * @param {number} green - Original green channel.
         * @param {number} blue - Original blue channel.
         * @param {number} building - Original building restriction.
         * @param {boolean} on - Original active flag.
         */
        addLight(id, x, y, z, radius, red, green, blue, building, on) {
            integer(id, -2_147_483_648, 2_147_483_647, 'light identifier');
            integer(x, 0, 524_303, 'light X');
            integer(y, 0, 524_295, 'light Y');
            integer(radius, 1, 255, 'light radius');
            validateColor([red, green, blue]);

            integer(z, 0, 63, 'light native level');
            integer(building, -2_147_483_648, 2_147_483_647, 'light building identifier');

            if (typeof on !== 'boolean') {
                unsupported('static-light type, extent or registration');
            }

            if (lights.has(id)) {
                throw new Error('duplicate light id');
            }

            lights.set(id, { id, x, y, z, radius, color: [red, green, blue], on });
        },
        /**
         * Registers the original finite-life point light; life counts submitted main frames.
         *
         * @param {number} id - Original identifier.
         * @param {number} x - World X.
         * @param {number} y - World Y.
         * @param {number} z - Native level.
         * @param {number} radius - Original radius.
         * @param {number} red - Red channel.
         * @param {number} green - Green channel.
         * @param {number} blue - Blue channel.
         * @param {number} life - Original frame budget.
         */
        addTempLight(id, x, y, z, radius, red, green, blue, life) {
            integer(life, 1, 2_147_483_647, 'temporary-light life');
            methods.addLight(id, x, y, z, radius, red, green, blue, -1, true);
            Object.assign(lights.get(id), { initialLife: life, remainingLife: life });
        },
        /**
         * Removes the registry entry while queued references retain their owned light.
         *
         * @param {number} id - Original light identifier.
         */
        removeLight(id) {
            integer(id, -2_147_483_648, 2_147_483_647, 'light identifier');

            if (!lights.delete(id)) {
                throw new Error('unknown light id');
            }
        },
        /**
         * Sets the active flag copied by the next original main update.
         *
         * @param {number} id - Original light identifier.
         * @param {boolean} on - Original active flag.
         */
        setLightActive(id, on) {
            integer(id, -2_147_483_648, 2_147_483_647, 'light identifier');
            const light = lights.get(id);

            if (typeof on !== 'boolean') {
                unsupported('static-light active flag');
            }

            if (!light) {
                throw new Error('unknown light id');
            }

            light.on = on;
        },
        /**
         * Updates the actual registered static-light color.
         *
         * @param {number} id - Original light identifier.
         * @param {number} red - Original red channel.
         * @param {number} green - Original green channel.
         * @param {number} blue - Original blue channel.
         */
        setLightColor(id, red, green, blue) {
            const light = lights.get(id);

            validateColor([red, green, blue]);

            if (!light) {
                unsupported('unregistered static light');
            }

            light.color = [red, green, blue];
        },
        /**
         * Registers the original room rectangle and its full metadata identifiers.
         *
         * @param {number} id - Original room-light identifier.
         * @param {bigint} buildingId - Original building identifier.
         * @param {bigint} roomId - Original room identifier.
         * @param {number} x - Minimum world square X.
         * @param {number} y - Minimum world square Y.
         * @param {number} z - Original native level.
         * @param {number} width - Rectangle width.
         * @param {number} height - Rectangle height.
         * @param {boolean} on - Original active flag.
         */
        addRoomLight(id, buildingId, roomId, x, y, z, width, height, on) {
            integer(id, -2_147_483_648, 2_147_483_647, 'room-light identifier');
            integer(x, -2_147_483_648, 2_147_483_647, 'room-light X');
            integer(y, -2_147_483_648, 2_147_483_647, 'room-light Y');
            integer(z, 0, 63, 'room-light level');
            integer(width, 1, 2_147_483_647, 'room-light width');
            integer(height, 1, 2_147_483_647, 'room-light height');

            if ([buildingId, roomId].some((value) => typeof value !== 'bigint' || BigInt.asIntN(64, value) !== value)
                || typeof on !== 'boolean') {
                unsupported('room-light metadata or active flag');
            }

            if (roomLights.has(id)) {
                throw new Error('duplicate room-light id');
            }

            roomLights.set(id, { id, buildingId, roomId, x, y, z, width, height, on });
        },
        /**
         * Removes a room registration without changing its already queued main snapshot.
         *
         * @param {number} id - Original room-light identifier.
         */
        removeRoomLight(id) {
            integer(id, -2_147_483_648, 2_147_483_647, 'room-light identifier');

            if (!roomLights.delete(id)) {
                throw new Error('unknown room-light id');
            }
        },
        /**
         * Sets the room flag copied by the next original main transaction.
         *
         * @param {number} id - Original room-light identifier.
         * @param {boolean} on - Original active flag.
         */
        setRoomLightActive(id, on) {
            integer(id, -2_147_483_648, 2_147_483_647, 'room-light identifier');
            const light = roomLights.get(id);

            if (typeof on !== 'boolean') {
                unsupported('room-light active flag');
            }

            if (!light) {
                throw new Error('unknown room-light id');
            }

            light.on = on;
        },
        /**
         * Updates the actual shared handheld beam read by the native worker.
         *
         * @param {number} id - Original torch identifier.
         * @param {number} x - World float32 X.
         * @param {number} y - World float32 Y.
         * @param {number} z - World level with original32 offset.
         * @param {number} r - Original red strength.
         * @param {number} g - Original green strength.
         * @param {number} b - Original blue strength.
         * @param {number} angleX - Original look-vector X.
         * @param {number} angleY - Original look-vector Y.
         * @param {number} dist - Original beam range.
         * @param {number} strength - Original intensity.
         * @param {boolean} cone - Original cone flag.
         * @param {number} dot - Original cone threshold.
         * @param {number} focusing - Original signed vehicle focusing value; handheld sources use zero.
         */
        updateTorch(id, x, y, z, r, g, b, angleX, angleY, dist, strength, cone, dot, focusing) {
            integer(id, -2_147_483_648, 2_147_483_647, 'torch identifier');
            integer(focusing, -2_147_483_648, 2_147_483_647, 'torch focusing');

            if ([x, y, z, r, g, b, angleX, angleY, dist, strength, dot]
                .some((value) => !Number.isFinite(value) || !Number.isFinite(Math.fround(value)))
                || typeof cone !== 'boolean' || dist < 0) {
                unsupported('torch fields');
            }

            const floats = [x, y, z, r, g, b, angleX, angleY, dist, strength, dot].map(Math.fround);
            const value = {
                id, x: floats[0], y: floats[1], z: floats[2], color: floats.slice(3, 6),
                angleX: floats[6], angleY: floats[7], dist: floats[8], strength: floats[9],
                cone, dot: floats[10], focusing,
            };

            if (torches.has(id)) {
                Object.assign(torches.get(id), value);
            } else {
                torches.set(id, value);
            }
        },
        /**
         * Retires the shared ID immediately; queued references remain alive but dark.
         *
         * @param {number} id - Original torch identifier; an unknown identifier is ignored.
         */
        removeTorch(id) {
            integer(id, -2_147_483_648, 2_147_483_647, 'torch identifier');
            const torch = torches.get(id);

            if (torch) {
                torch.id = 0;
                torches.delete(id);
            }
        },
        /**
         * Publishes the previous worker buffer and queues the validated retained scene.
         */
        stateEndUpdate() {
            const update = requireUpdate();
            const { state, baseState, cells, chunks, player, ranges, perception, sky, sourceUpdate, frameCount, levelSubmissions, allocations } = update;
            const playerPosition = update.playerPosition ?? state.pending?.player;
            const cleared = update.cleared ?? state.pending?.cleared;
            const worldPlayer = update.worldPlayer ?? state.previousPlayer;
            const pendingSourceUpdate = sourceUpdate ?? state.pending?.sourceUpdate;

            if (chunk || square || level !== null || cells.includes(undefined)
                || cleared === undefined || pendingSourceUpdate === undefined
                || ranges.size > state.width * state.height) {
                unsupported(`incomplete region update: ${JSON.stringify({
                    openChunk: Boolean(chunk), openSquare: Boolean(square), level,
                    undefinedCells: cells.includes(undefined), playerPresent: Boolean(playerPosition),
                    clearedPresent: cleared !== undefined, sourceUpdatePresent: pendingSourceUpdate !== undefined,
                    ranges: ranges.size, width: state.width, height: state.height, lights: lights.size, roomLights: roomLights.size,
                })}`);
            }

            if (!playerPosition) {
                // Original loading submits geometry and frame settings before creating its player.
                state.deferred = {
                    cells: [...cells], chunks: new Set(chunks), ranges: new Map(ranges), cleared,
                    perception, sky, sourceUpdate: pendingSourceUpdate, frameCount,
                    levelSubmissions, allocations,
                    x: state.x, y: state.y, movementCount: state.movements?.length ?? 0,
                    movementRevisions: state.movements?.map((command) => command.revision) ?? [],
                };

                if (baseState && baseState !== state) {
                    baseState.deferred = state.deferred;
                }

                states.set(player, baseState ?? state);
                active = null;

                return;
            }

            // Native main removes expired temporary owners, preserving queued object references.
            for (const [id, light] of lights) {
                if (light.initialLife > 0 && light.remainingLife <= 0 && light.on) {
                    lights.delete(id);
                }
            }

            if (!cleared && state.cells?.some((cell) => cell !== null) && visionChanged(cells, state.cells)) {
                unsupported('changed vision geometry without LOS invalidation');
            }

            const lightReferences = [...lights.values()].filter((light) => {
                const x = light.x - state.x * 8;
                const y = light.y - state.y * 8;
                const index = light.z * state.width * state.height * 64 + y * state.width * 8 + x;

                return (state.registeredLights.has(light) || (light.initialLife > 0 && state.playerInitialized))
                    && x >= 0 && y >= 0
                    && x < state.width * 8 && y < state.height * 8 && cells[index] !== null;
            })
                .map((light) => ({ light, on: light.on, color: [...light.color] }));
            const sceneLights = lightReferences.filter((reference) => reference.on && !(reference.light.initialLife > 0 && reference.light.remainingLife <= 0)).map(({ light }) => ({
                ...light, x: light.x - state.x * 8, y: light.y - state.y * 8, color: [...light.color],
            }));
            const torchReferences = state.playerInitialized ? [...torches.values()] : [];

            const pending = {
                width: state.width * 8, height: state.height * 8, minimum: 0, maximum: 63, cells,
                player: playerPosition, seen: (state.history ?? state.computed)?.map((payload) => Boolean(payload?.[0] & 1)),
                lights: sceneLights, cleared, submitted: new Set(levelSubmissions),
                roomLights: state.playerInitialized
                    ? [...roomLights.values()].map((light) => ({
                            ...light, x: light.x - state.x * 8, y: light.y - state.y * 8,
                        }))
                    : [],
                lightReferences, lightRegistrations: new Set(lights.values()),
                torchReferences, torches: torchReferences.map((torch) => ({ ...torch, color: [...torch.color] })),
                origin: [state.x * 8, state.y * 8, 0],
                perception: perception ?? state.pending?.perception,
                sky: sky ?? state.pending?.sky,
                sourceUpdate: pendingSourceUpdate, frameCount,
                allocations,
                previous: state.history ?? state.computed,
                moved: Boolean(state.moved),
            };
            const [playerX, playerY, playerZ] = playerPosition;
            const playerIndex = Math.floor(playerZ) * pending.width * pending.height + Math.floor(playerY) * pending.width + Math.floor(playerX);

            if (cells[playerIndex] === null && cells.some((cell) => cell !== null)) {
                unsupported('player on absent square');
            }

            // Validate and calculate before committing any retained geometry or publication.
            const calculated = calculateRetainedLighting(pending);

            restoreCoordinates(state, calculated);
            allocateDirtyLevels(state, ranges);

            // Native allocates physical readback on main independently from nullable geometry.
            state.readbackRanges = new Map((state.workerReady ? state.computedRanges : state.publishedRanges) ?? state.ranges);

            for (const [key, range] of ranges) {
                const old = state.readbackRanges.get(key);

                if (old) {
                    state.readbackRanges.set(key, [Math.min(old[0], range[0]), Math.max(old[1], range[1])]);
                }
            }

            if (state.published && allocations.size > 0) {
                state.published = [...state.published];
                state.allocatedLevels = new Set([...(state.allocatedLevels ?? []), ...allocations]);
                allocateLevelReadback(state, allocations, state.published,
                    { x: state.publishedX ?? state.x, y: state.publishedY ?? state.y }, true);

                if (state.workerReady) {
                    state.computed = [...state.computed];
                    allocateLevelReadback(state, allocations, state.computed,
                        { x: state.computedX ?? state.x, y: state.computedY ?? state.y }, false);
                }
            }

            // The native write queue accumulates while its separate worker buffer is pending.
            if (state.pending && !state.workerReady) {
                state.deferred = {
                    cells: [...cells], chunks: new Set(chunks), ranges: new Map(ranges), cleared,
                    playerPosition, worldPlayer, perception: pending.perception, sky: pending.sky,
                    sourceUpdate: pending.sourceUpdate, frameCount,
                    levelSubmissions, allocations,
                    x: state.x, y: state.y, movementCount: state.movements?.length ?? 0,
                    movementRevisions: state.movements?.map((command) => command.revision) ?? [],
                };

                if (baseState && baseState !== state) {
                    baseState.deferred = state.deferred;
                    baseState.published = state.published;
                    baseState.computed = state.computed;
                    baseState.allocatedLevels = state.allocatedLevels;
                    baseState.readbackRanges = state.readbackRanges;
                }

                retainReadbackOwners(baseState ?? state, ranges);
                active = null;

                return;
            }

            if (state.workerReady) {
                // Native0xea50 swaps dirty-map buffers; unread old readback flags become the next worker buffer.
                state.recycledChunkDirty = new Set(state.chunkDirty);
                state.published = state.computed;
                state.publishedRooms = state.computedRooms;
                state.publishedX = state.computedX ?? baseState?.x ?? state.x;
                state.publishedY = state.computedY ?? baseState?.y ?? state.y;
                state.publishedCells = state.computedCells ?? baseState?.cells ?? state.cells;
                state.publishedRanges = state.computedRanges ?? baseState?.ranges ?? state.ranges;
                [state.readSquareDirty, state.writeSquareDirty] = [state.writeSquareDirty, state.readSquareDirty];
                [state.readChunkDirty, state.writeChunkDirty] = [state.writeChunkDirty, state.readChunkDirty];
                state.counter++;
                state.squareDirty = new Set(state.computedSquareDirty);
                state.chunkDirty = new Set(state.computedChunkDirty);
            } else {
                state.chunkDirty = changedChunks(state, changedSquares(state, null, calculated, chunks));
            }

            state.cells = [...cells];
            state.ranges = new Map(ranges);
            state.previousPlayer = worldPlayer;
            state.pending = pending;
            state.pendingResult = calculated;
            state.movements = [];
            delete state.history;
            delete state.moved;
            state.deferred = null;
            state.workerReady = false;
            retainReadbackOwners(state, ranges);
            states.set(player, state);
            active = null;
        },
        /**
         * Completes the queued calculation without publishing its readback prematurely.
         *
         * @param {bigint} time - Original worker timestamp.
         * @param {boolean} dirty - Original global-light invalidation flag.
         */
        DoLightingUpdateNew(time, dirty) {
            if (typeof time !== 'bigint' || time < 0n || typeof dirty !== 'boolean') {
                unsupported('worker timestamp or global-light invalidation');
            }

            // Native 0x180009c30 uses global invalidation to request the full calculation at 0x180008650.
            if (!dirty && [...states.values()].some((state) => state.pending && !state.workerReady && state.pending.sourceUpdate === 0)) {
                unsupported('retained source update without global invalidation');
            }

            for (const state of states.values()) {
                if (state.pending && !state.workerReady) {
                    const previous = state.pending.previous;

                    // Active state belongs to the main snapshot; native RGB is read from the shared light at worker time.
                    const colorChanged = state.pending.lightReferences.some(({ light, on, color }) => on
                        && color.some((value, channel) => value !== light.color[channel]));

                    if (colorChanged || state.pending.torchReferences.length > 0
                        || state.pending.lightReferences.some(({ light }) => light.initialLife > 0)) {
                        state.computed = calculateRetainedLighting({
                            ...state.pending,
                            lights: state.pending.lightReferences.filter((reference) => reference.on
                                && !(reference.light.initialLife > 0 && reference.light.remainingLife <= 0)).map(({ light }) => ({
                                ...light, x: light.x - state.x * 8, y: light.y - state.y * 8, color: [...light.color],
                            })),
                            torches: state.pending.torchReferences.filter((torch) => torch.id !== 0),
                        });
                        restoreCoordinates(state, state.computed);
                    } else {
                        state.computed = state.pendingResult;
                    }

                    // Native seeds before subtracting the coalesced frame command's count.
                    for (const light of state.pending.lightRegistrations) {
                        if (state.playerInitialized && light.initialLife > 0 && light.remainingLife > 0) {
                            // eslint-disable-next-line unicorn/prefer-math-trunc -- Native lifetime subtraction uses signed int32 before clamping.
                            light.remainingLife = Math.max(0, (light.remainingLife - state.pending.frameCount) | 0);
                        }
                    }

                    // Physical per-position readback/seen history outlives retired geometry levels.
                    state.computed = state.computed.map((payload, index) => {
                        /* Calculated geometry owns changed/unread bytes in the existing dirty sets.
                         * Physical initial defaults remain necessary for unprocessed, absent positions. */
                        if (payload !== null) {
                            state.writeSquareDirty[index] = 0;
                        }

                        return payload ?? previous?.[index] ?? null;
                    });
                    allocateLevelReadback(state, state.pending.allocations, state.computed, state, false);
                    state.pendingResult = state.computed;
                    state.registeredLights = state.pending.lightRegistrations;
                    state.playerInitialized = true;
                    state.computedRooms = visibleRooms(state.pending.cells, state.computed);
                    state.computedX = state.x;
                    state.computedY = state.y;
                    state.computedCells = state.pending.cells;
                    state.computedRanges = new Map(state.ranges);
                    const submitted = state.pending.moved ? new Set(state.ranges.keys()) : state.pending.submitted;
                    const changed = changedSquares(state, previous, state.computed, submitted);

                    if (state.pending.moved) {
                        // Native0xa109..a11a marks every indexed readback dirty while its moved map is dirty.
                        markMovedReadback(state);
                    }

                    // Native ready chunks inherit readback dirty bytes at worker time, before marking changes.
                    state.computedSquareDirty = new Set([...state.squareDirty, ...changed]);
                    state.computedChunkDirty = new Set([...state.recycledChunkDirty, ...changedChunks(state, changed)]);

                    if (state.pending.moved) {
                        state.computedChunkDirty = new Set([...state.computedChunkDirty].filter((key) => {
                            const [x, y] = key.split(',').map(Number);

                            return x >= state.x && y >= state.y && x < state.x + state.width && y < state.y + state.height;
                        }));
                    }

                    state.workerReady = true;
                    lastUpdate = { counter: state.counter, cells: state.computed.length };
                }
            }
        },
        /**
         * Reports actual completion of any queued worker buffer.
         *
         * @returns {boolean} Whether a completed buffer awaits original Java publication.
         */
        WaitingForMain() {
            return [...states.values()].some((state) => state.workerReady);
        },
        /**
         * Reads the original published update counter.
         *
         * @param {number} player - Original player index.
         * @returns {number} Published counter, or minus one before region creation.
         */
        stateUpdateCounter(player) {
            return playerState(player)?.counter ?? -1;
        },
        /**
         * Reads and consumes the actual published chunk dirty bit.
         *
         * @param {number} player - Original player index.
         * @param {number} x - World chunk X.
         * @param {number} y - World chunk Y.
         * @param {number} z - Native level32.
         * @returns {boolean} Previously published dirty state.
         */
        getChunkDirty(player, x, y, z) {
            if (active) {
                throw new Error('LightingJNI: missing stateEndUpdate');
            }

            const state = playerState(player);

            integer(x, -2_147_483_648, 2_147_483_647, 'chunk X');
            integer(y, -2_147_483_648, 2_147_483_647, 'chunk Y');
            integer(z, 0, 63, 'chunk level');

            if (!state) {
                return false;
            }

            const originX = state.publishedX ?? state.x;
            const originY = state.publishedY ?? state.y;

            if (x < originX || y < originY || x >= originX + state.width || y >= originY + state.height) {
                return false;
            }

            const key = `${x},${y},${z}`;
            const physical = z * state.width * state.height + (y - originY) * state.width + x - originX;
            const dirty = state.chunkDirty.has(key) || Boolean(state.readChunkDirty?.[physical]);

            state.chunkDirty.delete(key);

            if (state.readChunkDirty) {
                state.readChunkDirty[physical] = 0;
            }

            return dirty;
        },
        /**
         * Reads the actual square dirty bit without consuming it.
         *
         * @param {number} player - Original player index.
         * @param {number} x - World square X.
         * @param {number} y - World square Y.
         * @param {number} z - Native level32.
         * @returns {boolean} Published square dirty state.
         */
        getSquareDirty(player, x, y, z) {
            const resolved = lookup(player, x, y, z);

            return resolved !== null && (resolved.state.squareDirty.has(resolved.index)
                || Boolean(resolved.state.readSquareDirty?.[resolved.index]));
        },
        /**
         * Copies actual packed native output and consumes only its square dirty bit.
         *
         * @param {number} player - Original player index.
         * @param {number} x - World square X.
         * @param {number} y - World square Y.
         * @param {number} z - Native level32.
         * @param {Int32Array} output - Actual Java int-array storage.
         * @returns {boolean} Whether this square belongs to the initialized region.
         */
        getSquareLighting(player, x, y, z, output) {
            const resolved = lookup(player, x, y, z);

            if (!resolved) {
                return false;
            }

            if (!resolved.state.published) {
                unsupported('unpublished lighting readback');
            }

            if (!(output instanceof Int32Array) || output.length < 49) {
                unsupported('49-int Java output storage');
            }

            const payload = resolved.state.published[resolved.index];

            if (payload === null) {
                unsupported('unpublished square geometry');
            }

            output.set(payload.slice(0, 14 + payload[13] * 6));
            resolved.state.squareDirty.delete(resolved.index);

            if (resolved.state.readSquareDirty) {
                resolved.state.readSquareDirty[resolved.index] = 0;
            }

            return true;
        },
        /**
         * Reads the room count belonging to the actual published worker buffer.
         *
         * @param {number} player - Original player index.
         * @returns {number} Number of published LOS-visible rooms.
         */
        getVisibleRoomCount(player) {
            return playerState(player)?.publishedRooms?.length ?? 0;
        },
        /**
         * Copies native unsigned-tree room order while preserving the Java array tail.
         *
         * @param {number} player - Original player index.
         * @param {BigInt64Array} output - Original Java long-array storage.
         * @returns {number} Number of copied room identifiers.
         */
        getVisibleRooms(player, output) {
            const rooms = playerState(player)?.publishedRooms ?? [];

            if (!(output instanceof BigInt64Array)) {
                unsupported('Java long output storage');
            }

            if (output.length < rooms.length) {
                throw new NativeArgumentError('output array is too small');
            }

            output.set(rooms);

            return rooms.length;
        },
        /**
         * Releases all backend-owned state without modifying the original Java classes.
         */
        destroy() {
            states.clear();
            lights.clear();
            roomLights.clear();
            torches.clear();
            active = null;
            chunk = null;
            square = null;
            level = null;
            lastUpdate = null;
        },
    };

    for (const name of [
        'getVertLight', 'getLightInfo', 'getDarkMulti', 'getTargetDarkMulti', 'getSeen', 'getCanSee', 'getCouldSee',
    ]) {
        /**
         * Rejects an explicitly unqualified original native method.
         *
         * @returns {never} Always throws the unsupported boundary.
         */
        methods[name] = () => {
            unsupported(name);
        };
    }

    const natives = Object.fromEntries(Object.entries(methods).map(([name, method]) => [
        `Java_zombie_iso_LightingJNI_${name}`,
        (lib, ...args) => {
            try {
                return method(...args);
            } catch (error) {
                return throwJavaFailure(lib, error);
            }
        },
    ]));

    return {
        natives, methods,
        /**
         * Copies diagnostics without exposing retained mutable backend state.
         *
         * @returns {object} Configuration status and completed worker updates.
         */
        snapshot() {
            let updates = [];

            if (lastUpdate) {
                updates = [{ ...lastUpdate }];
            }

            return { configured, updates };
        },
    };
}
