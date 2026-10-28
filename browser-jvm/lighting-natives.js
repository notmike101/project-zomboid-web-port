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

        if (previous === null || submitted.has(`${x},${y}`)
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
        if (payload?.[0] & 4) {
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

        if ((curtain && (![4, 8].includes(args[0]) || args[1] !== true))
            || (!curtain && (typeof args[0] !== 'boolean' || args[1] !== false || args[2] !== false))) {
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

        if (!state || x < state.x * 8 || y < state.y * 8
            || x >= (state.x + state.width) * 8 || y >= (state.y + state.height) * 8) {
            return null;
        }

        const index = z * state.width * state.height * 64 + (y - state.y * 8) * state.width * 8 + x - state.x * 8;

        // Bootstrap native readback exposes uninitialized words; keep the explicit publication guard.
        if (!state.cells || state.ranges.size === 0) {
            return { state, index };
        }

        if (state.cells[index] === null) {
            const range = state.ranges.get(`${Math.floor(x / 8)},${Math.floor(y / 8)}`);

            if (range && z >= range[0] && z <= range[1]) {
                unsupported('absent-square readback');
            }

            return null;
        }

        return { state, index };
    }

    const methods = {
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

            if (state && (state.x !== x || state.y !== y || state.width !== width || state.height !== height)) {
                unsupported('region scroll or resize');
            }

            if (!state) {
                state = {
                    x, y, width, height, counter: 0, cells: null, published: null, computed: null,
                    pending: null, deferred: null, workerReady: false, lightsRegistered: false, previousPlayer: null, ranges: new Map(),
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
                state, player, cells, chunks: new Set(state.deferred?.chunks), cleared: state.deferred?.cleared,
                ranges: new Map(state.deferred?.ranges ?? state.ranges),
                playerPosition: state.deferred?.playerPosition, worldPlayer: state.deferred?.worldPlayer,
                perception: state.deferred?.perception, sky: state.deferred?.sky,
                sourceUpdate: state.deferred?.sourceUpdate,
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

            integer(z, 0, 63, 'player native level');

            if (x < state.x * 8 || y < state.y * 8
                || x >= (state.x + state.width) * 8 || y >= (state.y + state.height) * 8) {
                unsupported('player outside qualified region');
            }

            if (flagA !== false || flagB !== false || flagC !== false || flagD !== false
                || fatigue !== 0 || range < 0 || range > 20 || cone < -1 || cone > 1) {
                unsupported('player flags or perception');
            }

            if (state.previousPlayer && state.previousPlayer[2] !== z) {
                unsupported('moving-player level transition');
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
            const { state, chunks, ranges } = update;

            integer(x, state.x, state.x + state.width - 1, 'chunk X');
            integer(y, state.y, state.y + state.height - 1, 'chunk Y');

            integer(minimum, 0, 63, 'chunk minimum level');
            integer(maximum, minimum, 63, 'chunk maximum level');

            if (chunk || square) {
                unsupported('chunk lifecycle');
            }

            const previous = ranges.get(`${x},${y}`);

            if (previous && (previous[0] !== minimum || previous[1] !== maximum)) {
                unsupported('changed chunk level extent');
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
         * Stages an original open curtain in its qualified north or west orientation.
         *
         * @param {number} mask - Original curtain attachment bits.
         * @param {boolean} open - Original open flag.
         */
        squareAddCurtain(mask, open) {
            stageObject('squareAddCurtain', [mask, open]);
        },
        /**
         * Stages an original closed door and its actual ray-blocking plane.
         *
         * @param {boolean} north - Original north-facing flag.
         * @param {boolean} open - Original open flag.
         * @param {boolean} transparent - Original transparent-door flag.
         */
        squareAddDoor(north, open, transparent) {
            stageObject('squareAddDoor', [north, open, transparent]);
        },
        /**
         * Stages an original intact unbarricaded window.
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

            integer(x, -2_147_483_648, 2_147_483_647, 'chunk X');
            integer(y, -2_147_483_648, 2_147_483_647, 'chunk Y');

            return state.published !== null && x >= state.x && y >= state.y
                && x < state.x + state.width && y < state.y + state.height;
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

            if (building !== -1 || on !== true || lights.has(id) || lights.size >= 7) {
                unsupported('static-light type, extent or registration');
            }

            lights.set(id, { id, x, y, z, radius, color: [red, green, blue] });
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
         * Publishes the previous worker buffer and queues the validated retained scene.
         */
        stateEndUpdate() {
            const update = requireUpdate();
            const { state, cells, chunks, player, ranges, perception, sky, sourceUpdate } = update;
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
                    ranges: ranges.size, width: state.width, height: state.height, lights: lights.size,
                })}`);
            }

            if (!playerPosition) {
                // Original loading submits geometry and frame settings before creating its player.
                state.deferred = {
                    cells: [...cells], chunks: new Set(chunks), ranges: new Map(ranges), cleared,
                    perception, sky, sourceUpdate: pendingSourceUpdate,
                };
                states.set(player, state);
                active = null;

                return;
            }

            for (const light of lights.values()) {
                if (light.x < state.x * 8 || light.y < state.y * 8
                    || light.x >= (state.x + state.width) * 8 || light.y >= (state.y + state.height) * 8) {
                    unsupported('static light outside qualified region');
                }
            }

            if (!cleared && state.cells?.some((cell) => cell !== null) && visionChanged(cells, state.cells)) {
                unsupported('changed vision geometry without LOS invalidation');
            }

            let sceneLights = [];

            if (state.lightsRegistered) {
                sceneLights = [...lights.values()].map((light) => ({
                    ...light, x: light.x - state.x * 8, y: light.y - state.y * 8, color: [...light.color],
                }));
            }

            const pending = {
                width: state.width * 8, height: state.height * 8, minimum: 0, maximum: 63, cells,
                player: playerPosition, seen: state.computed?.map((payload) => Boolean(payload?.[0] & 1)),
                lights: sceneLights, cleared, submitted: new Set(chunks),
                origin: [state.x * 8, state.y * 8, 0],
                perception: perception ?? state.pending?.perception,
                sky: sky ?? state.pending?.sky,
                sourceUpdate: pendingSourceUpdate,
            };
            const [playerX, playerY, playerZ] = playerPosition;
            const playerIndex = playerZ * pending.width * pending.height + Math.floor(playerY) * pending.width + Math.floor(playerX);

            if (cells[playerIndex] === null && cells.some((cell) => cell !== null)) {
                unsupported('player on absent square');
            }

            // Validate and calculate before committing any retained geometry or publication.
            const calculated = calculateRetainedLighting(pending);

            restoreCoordinates(state, calculated);

            // The native write queue accumulates while its separate worker buffer is pending.
            if (state.pending && !state.workerReady) {
                state.deferred = {
                    cells: [...cells], chunks: new Set(chunks), ranges: new Map(ranges), cleared,
                    playerPosition, worldPlayer, perception: pending.perception, sky: pending.sky,
                    sourceUpdate: pending.sourceUpdate,
                };
                active = null;

                return;
            }

            if (state.workerReady) {
                // Native0xea50 swaps dirty-map buffers; unread old readback flags become the next worker buffer.
                state.recycledChunkDirty = new Set(state.chunkDirty);
                state.published = state.computed;
                state.publishedRooms = state.computedRooms;
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
            state.deferred = null;
            state.lightsRegistered = true;
            state.workerReady = false;
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
                    const previous = state.computed;

                    state.computed = state.pendingResult;
                    state.computedRooms = visibleRooms(state.pending.cells, state.computed);
                    const changed = changedSquares(state, previous, state.computed, state.pending.submitted);

                    // Native ready chunks inherit readback dirty bytes at worker time, before marking changes.
                    state.computedSquareDirty = new Set([...state.squareDirty, ...changed]);
                    state.computedChunkDirty = new Set([...state.recycledChunkDirty, ...changedChunks(state, changed)]);
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

            const key = `${x},${y},${z}`;
            const dirty = state.chunkDirty.has(key);

            state.chunkDirty.delete(key);

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

            return resolved !== null && resolved.state.squareDirty.has(resolved.index);
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
            active = null;
            chunk = null;
            square = null;
            level = null;
            lastUpdate = null;
        },
    };

    for (const name of [
        'scrollLeft', 'scrollRight', 'scrollUp', 'scrollDown', 'teleport',
        'squareAddThumpable',
        'addTempLight', 'removeLight', 'setLightActive', 'addRoomLight', 'removeRoomLight',
        'setRoomLightActive', 'updateTorch', 'removeTorch',
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
