import { calculateLighting } from './lighting-kernel.js';

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
    const name = error instanceof RangeError ? 'UnsupportedOperationException' : 'IllegalStateException';
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
 * Creates a native lighting service for the qualified indoor opaque closure.
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
            integer(width, 1, 3, 'region width');
            integer(height, 1, 3, 'region height');

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
            };
        },
        /**
         * Accepts the original player input inside the qualified near-detection region.
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

            if (flagA !== false || flagB !== false || flagC !== false || flagD !== false
                || fatigue !== 0 || range !== 20 || Math.fround(cone) !== Math.fround(-0.2)) {
                unsupported('player flags or perception');
            }

            if (state.previousPlayer && (state.previousPlayer[0] !== x || state.previousPlayer[1] !== y || state.previousPlayer[2] !== z)) {
                unsupported('moving-player history');
            }

            update.playerPosition = [x - state.x * 8, y - state.y * 8, z];
            update.worldPlayer = [x, y, z];
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

            if (red !== 1 || green !== 1 || blue !== 1 || Math.fround(ambient) !== Math.fround(0.1)
                || night !== 1 || view !== 20 || maximumView !== 20 || typeof cleared !== 'boolean'
                || sourceUpdate !== 100 || sky !== 0) {
                unsupported('ambient, sunlight or frame settings');
            }

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

            if (typeof up !== 'boolean' || typeof down !== 'boolean' || typeof stairs !== 'boolean'
                || building !== -1n || room !== -1n || lightLevel !== 0 || openAir !== false) {
                unsupported('vertical flags, rooms, buildings, ambient or outdoors');
            }

            Object.assign(square, { mask, vision, up, down, stairs });
        },
        /**
         * Admits only the original no-object opaque-edge transmission tuples.
         *
         * @param {...number} values - Four original RGB/transmission/coefficient tuples.
         */
        squareSetLightTransmission(...values) {
            if (!square || values.length !== 20 || values.some((value, index) => value !== Number(index % 5 < 3))) {
                unsupported('colored or translucent edges');
            }

            square.transmission = true;
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

            cells[index] = { mask: square.mask, vision: square.vision, up: square.up, down: square.down, stairs: square.stairs };
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
            const { state, cells, playerPosition, cleared, chunks, worldPlayer, player, ranges } = update;

            if (chunk || square || level !== null || cells.includes(undefined)
                || !playerPosition || cleared === undefined || ranges.size !== state.width * state.height) {
                unsupported('incomplete region update');
            }

            for (const light of lights.values()) {
                if (light.x < state.x * 8 || light.y < state.y * 8
                    || light.x >= (state.x + state.width) * 8 || light.y >= (state.y + state.height) * 8) {
                    unsupported('static light outside qualified region');
                }
            }

            if (!cleared && state.cells && cells.some((cell, index) => cell?.vision !== state.cells[index]?.vision)) {
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
            };

            // Validate and calculate before committing any retained geometry or publication.
            const calculated = calculateLighting(pending);

            restoreCoordinates(state, calculated);

            // The native write queue accumulates while its separate worker buffer is pending.
            if (state.pending && !state.workerReady) {
                state.deferred = { cells: [...cells], chunks: new Set(chunks), ranges: new Map(ranges), cleared };
                active = null;

                return;
            }

            if (state.workerReady) {
                // Native0xea50 swaps dirty-map buffers; unread old readback flags become the next worker buffer.
                state.recycledChunkDirty = new Set(state.chunkDirty);
                state.published = state.computed;
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
            if (typeof time !== 'bigint' || time < 0n || dirty !== false) {
                unsupported('worker timestamp or global-light invalidation');
            }

            for (const state of states.values()) {
                if (state.pending && !state.workerReady) {
                    const previous = state.computed;

                    state.computed = state.pendingResult;
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
        'squareAddCurtain', 'squareAddDoor', 'squareAddThumpable', 'squareAddWindow',
        'addTempLight', 'removeLight', 'setLightActive', 'addRoomLight', 'removeRoomLight',
        'setRoomLightActive', 'updateTorch', 'removeTorch', 'getVisibleRoomCount', 'getVisibleRooms',
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
