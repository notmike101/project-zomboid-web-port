import { createRagdollDefinitions } from './ragdoll-definitions.js';

/**
 * Copies absolute bytes from an original Java transport buffer.
 *
 * @param {object} buffer - Actual Java ByteBuffer proxy.
 * @param {number} capacity - Qualified maximum transport extent.
 * @returns {Promise<Uint8Array>} Detached command bytes.
 */
async function copyBuffer(buffer, capacity) {
    const length = await buffer.position();

    if (!Number.isInteger(length) || length < 0 || length > capacity) {
        throw new RangeError('Original command buffer extent exceeded');
    }

    const bytes = new Uint8Array(length);

    /**
     * Serializes calls into the single browser JVM without concurrent proxy execution.
     *
     * @param {number} index - Next absolute byte index.
     * @returns {Promise<void>} Completion of the remaining copy.
     */
    async function next(index) {
        if (index < length) {
            bytes[index] = await buffer.get(index) & 255;
            await next(index + 1);
        }
    }

    await next(0);

    return bytes;
}

/**
 * Checks a signed integer transport value.
 *
 * @param {number} value - Value supplied by the original caller.
 * @param {string} name - Diagnostic argument name.
 */
function integer(value, name) {
    if (!Number.isInteger(value) || value < -2_147_483_648 || value > 2_147_483_647) {
        throw new TypeError(`${name} must be a signed Java integer`);
    }
}

/**
 * Creates the bounded static chunk geometry transport for the original physics ABI.
 * Dynamic bodies and other Bullet commands are deliberately not registered.
 *
 * @returns {object} Native callbacks and inspectable owned geometry state.
 */
export function createBrowserPhysics() {
    let earcutEngine;
    const triangulation = { loaded: false, calls: 0, transportAllocations: 0, transportBytes: 0, peakTransportBytes: 0 };

    /**
     * Runs the genuine upstream triangulator with owned WASM transport allocations.
     *
     * @param {object} lib - Current Java native class namespace.
     * @param {Float64Array} coordinates - Original exact integer coordinates, flattened by Java.
     * @param {Int32Array} ends - Exclusive vertex ends of the outer ring and holes.
     * @returns {Promise<Int32Array>} Detached original vertex indices.
     */
    async function triangulateEarcut(lib, coordinates, ends) {
        if (!(coordinates instanceof Float64Array) || !(ends instanceof Int32Array)
            || coordinates.length % 2 || coordinates.length < 6 || coordinates.length > 65_534
            || ends.length < 1 || ends.length > coordinates.length / 6) {
            const Exception = await lib.java.lang.IllegalArgumentException;

            throw await new Exception('Invalid original Earcut arrays');
        }

        const count = coordinates.length / 2;
        let start = 0;
        let invalidRing = false;

        for (const end of ends) {
            if (end < start + 3 || end > count) {
                invalidRing = true;
                break;
            }

            start = end;
        }

        if (invalidRing) {
            const Exception = await lib.java.lang.IllegalArgumentException;

            throw await new Exception('Invalid original Earcut ring bounds');
        }

        if (start !== count || !coordinates.every((value) => Number.isFinite(value) && Number.isInteger(value) && Math.abs(value) <= 2 ** 53)) {
            const Exception = await lib.java.lang.IllegalArgumentException;

            throw await new Exception('Inexact original Earcut coordinate');
        }

        const owned = [];
        let engine;

        try {
            const moduleUrl = new URL('/browser-jvm/earcut/earcut-engine.mjs', globalThis.location.href).href;

            earcutEngine ||= import(moduleUrl).then((module) => module.default());
            engine = await earcutEngine;
            triangulation.loaded = true;
            const capacity = (count + 2 * (ends.length - 1) - 2) * 3;

            /**
             * Allocates actual WASM storage and records its owner before use.
             *
             * @param {number} size - Required transport bytes.
             * @returns {number} Actual WASM address.
             */
            function allocate(size) {
                const address = engine._malloc(size);

                if (!address) {
                    throw new Error('Earcut malloc failed');
                }

                owned.push({ address, size });
                triangulation.transportAllocations++;
                triangulation.transportBytes += size;
                triangulation.peakTransportBytes = Math.max(triangulation.peakTransportBytes, triangulation.transportBytes);

                return address;
            }

            const xy = allocate(coordinates.length * 8);
            const rings = allocate(ends.length * 4);
            const output = allocate((capacity + 2) * 4);

            engine.HEAPF64.set(coordinates, xy / 8);
            engine.HEAP32.set(ends, rings / 4);
            engine.HEAP32.fill(0x5A_5A_5A_5A, output / 4, output / 4 + capacity + 2);
            const returned = engine._triangulate(xy, count, rings, ends.length, output, capacity);

            if (returned < 0 || returned > capacity || returned % 3) {
                throw new Error(`Earcut rejected original polygon: ${returned}`);
            }

            if (engine.HEAP32[output / 4 + capacity] !== 0x5A_5A_5A_5A || engine.HEAP32[output / 4 + capacity + 1] !== 0x5A_5A_5A_5A) {
                throw new Error('Earcut wrote outside declared output');
            }

            const result = engine.HEAP32.slice(output / 4, output / 4 + returned);

            if (!result.every((index) => index >= 0 && index < count)) {
                throw new Error('Earcut index outside original table');
            }

            triangulation.calls++;

            return result;
        } catch (error) {
            const Exception = await lib.java.lang.IllegalStateException;

            throw await new Exception(`Upstream Earcut failure: ${String(error)}`);
        } finally {
            for (const allocation of owned.reverse()) {
                engine._free(allocation.address);
                triangulation.transportAllocations--;
                triangulation.transportBytes -= allocation.size;
            }
        }
    }

    const ragdolls = createRagdollDefinitions();
    const chunks = new Map();
    const maps = new Map();
    const collision = new Map();
    const populationChunks = new Set();
    const clippers = [];
    const clipperHelpers = new WeakMap();
    const vehicles = new Map();
    const vehicleDefinitions = new Map();
    const dynamicObjects = new Map();
    let simulation = null;
    let clipperAllocations = 0;
    let clipperClears = 0;
    let world = null;
    let revision = 0;

    /**
     * Retains the original fixed-size vehicle ABI without inventing vehicle dynamics.
     * Definitions precede world creation and therefore survive world destruction.
     *
     * @param {string} name - Original fully qualified vehicle script name.
     * @param {Float32Array} values - Original VehicleScript.toBullet payload.
     */
    function defineVehicleScript(name, values) {
        if (typeof name !== 'string' || name.length === 0 || !(values instanceof Float32Array) || values.length !== 200) {
            throw new TypeError('Vehicle definition requires its name and original 200-float payload');
        }

        if (!values.every(Number.isFinite)) {
            throw new RangeError('Vehicle definition contains nonfinite values');
        }

        const wheelCount = values[10];
        let cursor = 11;

        if (!Number.isInteger(wheelCount) || wheelCount < 0 || cursor + wheelCount * 5 >= values.length) {
            throw new RangeError('Invalid vehicle wheel count');
        }

        for (let index = 0; index < wheelCount; index++) {
            if (values[cursor] !== 0 && values[cursor] !== 1) {
                throw new RangeError('Invalid vehicle wheel front flag');
            }

            cursor += 5;
        }

        const shapeCount = values[cursor++];

        if (!Number.isInteger(shapeCount) || shapeCount < 1 || shapeCount > values.length - cursor) {
            throw new RangeError('Invalid vehicle shape count');
        }

        for (let index = 0; index < shapeCount; index++) {
            const type = values[cursor];
            const width = new Map([[1, 10], [2, 5], [3, 4]]).get(type) ?? 0;

            if (width === 0 || cursor + width > values.length) {
                throw new RangeError('Invalid or truncated vehicle shape');
            }

            cursor += width;
        }

        if (values.subarray(cursor).some((value) => value !== 0)) {
            throw new RangeError('Unexpected data after vehicle shape payload');
        }

        vehicleDefinitions.set(name, new Float32Array(values));
        revision++;
    }

    /**
     * Finds the actual Java object across freshly wrapped native-call proxies.
     * Clipper inherits Object.equals, so the comparison preserves JVM identity.
     *
     * @param {object} receiver - Original Java Clipper instance.
     * @param {number} index - Next owned allocation to examine.
     * @returns {Promise<object|null>} The matching owned container.
     */
    async function findClipper(receiver, index = 0) {
        if (index >= clippers.length) {
            return null;
        }

        if (await receiver.equals(clippers[index].receiver)) {
            return clippers[index];
        }

        return findClipper(receiver, index + 1);
    }

    /**
     * Resolves one Java helper per runtime; polygon buffers stay inside the JVM.
     *
     * @param {object} lib - Actual CheerpJ library supplied to the native callback.
     * @returns {Promise<object>} Qualified Java Clipper2 adapter.
     */
    async function clipperSupport(lib) {
        if (!lib || !['object', 'function'].includes(typeof lib)) {
            throw new TypeError('Polygon operations require the browser JVM');
        }

        if (!clipperHelpers.has(lib)) {
            clipperHelpers.set(lib, lib.port.host.ClipperSupport);
        }

        return await clipperHelpers.get(lib);
    }

    /**
     * Requires a world and checks coordinates against its real metadata bounds.
     *
     * @param {number} x - World chunk X coordinate.
     * @param {number} y - World chunk Y coordinate.
     * @returns {string} Stable coordinate key.
     */
    function chunkKey(x, y) {
        integer(x, 'chunk X');
        integer(y, 'chunk Y');

        if (!world) {
            throw new Error('Physics world has not been initialized');
        }

        if (x < world.minX * 32 || x >= (world.maxX + 1) * 32 || y < world.minY * 32 || y >= (world.maxY + 1) * 32) {
            throw new RangeError(`Chunk ${x},${y} is outside the initialized world`);
        }

        return `${x},${y}`;
    }

    /**
     * Replaces the owned world, clearing all previous collider data.
     *
     * @param {number} minX - Inclusive minimum metadata cell X.
     * @param {number} minY - Inclusive minimum metadata cell Y.
     * @param {number} maxX - Inclusive maximum metadata cell X.
     * @param {number} maxY - Inclusive maximum metadata cell Y.
     * @param {number} offsetX - Original world simulation X offset in squares.
     * @param {number} offsetY - Original world simulation Y offset in squares.
     * @param {boolean} server - Original server mode flag.
     */
    function initialize(minX, minY, maxX, maxY, offsetX, offsetY, server) {
        for (const value of [minX, minY, maxX, maxY, offsetX, offsetY]) {
            integer(value, 'world coordinate');
        }

        if (minX > maxX || minY > maxY) {
            throw new RangeError('Inverted world bounds');
        }

        if (server) {
            throw new Error('Server physics is outside this static client geometry backend');
        }

        world = { minX, minY, maxX, maxY, offsetX, offsetY };
        vehicles.clear();
        dynamicObjects.clear();
        simulation = { calls: 0, requestedSeconds: 0, simulatedSeconds: 0, remainder: 0, substeps: 0, droppedSeconds: 0 };
        chunks.clear();
        maps.clear();
        collision.clear();
        populationChunks.clear();
        revision++;
    }

    /**
     * Stores a chunk's actual height extent and removes data outside a changed extent.
     *
     * @param {number} x - World chunk X coordinate.
     * @param {number} y - World chunk Y coordinate.
     * @param {number} min - Inclusive minimum level.
     * @param {number} max - Inclusive maximum level.
     */
    function setLevels(x, y, min, max) {
        const key = chunkKey(x, y);

        integer(min, 'minimum level');
        integer(max, 'maximum level');

        if (min < -32 || max > 31 || min > max) {
            throw new RangeError('Invalid chunk height extent');
        }

        const levels = new Map(chunks.get(key)?.levels);

        for (const level of levels.keys()) {
            if (level < min || level > max) {
                levels.delete(level);
            }
        }

        chunks.set(key, { x, y, min, max, levels });
        revision++;
    }

    /**
     * Parses an entire original command8 packet before committing its level replacement.
     * Shape IDs are retained losslessly; this does not substitute a rigid body solver.
     *
     * @param {Uint8Array} bytes - Command bytes through the original buffer position.
     */
    function submit(bytes) {
        if (!(bytes instanceof Uint8Array) || bytes.length < 13 || bytes[0] !== 8) {
            throw new Error('Only original static chunk command8 is supported');
        }

        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const x = view.getInt16(1, true);
        const y = view.getInt16(3, true);
        const min = view.getInt16(5, true);
        const max = view.getInt16(7, true);
        const level = view.getInt16(9, true);
        const key = chunkKey(x, y);
        const chunk = chunks.get(key);

        if (!chunk || min !== chunk.min || max !== chunk.max || level < min || level > max) {
            throw new RangeError('Chunk packet does not match its registered height extent');
        }

        const squares = new Map();
        let cursor = 11;
        let terminated = false;

        while (cursor < bytes.length) {
            if (cursor + 2 > bytes.length) {
                throw new Error('Truncated chunk record');
            }

            const sx = bytes[cursor++];
            const sy = bytes[cursor++];

            if (sx === 255 && sy === 255) {
                terminated = true;
                break;
            }

            if (sx > 7 || sy > 7 || cursor >= bytes.length) {
                throw new RangeError('Invalid chunk square');
            }

            const count = bytes[cursor++];
            const squareKey = sy * 8 + sx;

            if (count > 4 || cursor + count > bytes.length || squares.has(squareKey)) {
                throw new Error('Invalid or duplicate chunk shape record');
            }

            const shapes = [];

            for (let index = 0; index < count; index++) {
                const encoded = bytes[cursor++];

                if (encoded === 0) {
                    throw new RangeError('Zero is not an encoded shape ID');
                }

                shapes.push(encoded - 1);
            }

            squares.set(squareKey, Object.freeze(shapes));
        }

        if (!terminated || cursor !== bytes.length || squares.size !== 64) {
            throw new Error('Incomplete chunk level replacement');
        }

        const levels = new Map(chunk.levels);

        levels.set(level, squares);
        chunks.set(key, { ...chunk, levels });
        revision++;
    }

    /**
     * Reads a detached snapshot without exposing mutable backend storage.
     *
     * @returns {object} World, chunk, map, and revision data.
     */
    function snapshot() {
        return {
            world: world && { ...world }, revision,
            simulation: simulation && { ...simulation },
            dynamicBodies: { vehicles: vehicles.size, objects: dynamicObjects.size },
            vehicleDefinitions: [...vehicleDefinitions].map(([name, values]) => ({ name, values: [...values] })),
            ragdollDefinitions: ragdolls.snapshot(),
            collision: [...collision].map(([square, flags]) => ({ square, flags })),
            populationChunks: [...populationChunks],
            clipperContainers: { allocations: clipperAllocations, clears: clipperClears },
            triangulation: { ...triangulation },
            maps: [...maps.values()].map((value) => ({ ...value })),
            chunks: [...chunks.values()].map((chunk) => ({
                x: chunk.x, y: chunk.y, min: chunk.min, max: chunk.max,
                levels: [...chunk.levels].map(([level, squares]) => ({
                    level, squares: [...squares].map(([square, shapes]) => ({ square, shapes: [...shapes] })),
                })),
            })),
        };
    }

    /**
     * Requires an initialized static-only solver state.
     * No body-registration native is installed, so a dynamic request fails at its actual boundary.
     */
    function requireStaticWorld() {
        if (!world || !simulation) {
            throw new Error('Physics world has not been initialized');
        }

        if (vehicles.size !== 0 || dynamicObjects.size !== 0) {
            throw new Error('Dynamic physics is outside this static-only backend');
        }
    }

    /**
     * Advances owned static-world time with variable or bounded fixed substeps.
     * Static shapes are invariant under integration; no dynamic solver behavior is claimed.
     *
     * @param {number} timeStep - Requested elapsed seconds.
     * @param {number} maxSubSteps - Zero for variable steps, otherwise the fixed-step execution cap.
     * @param {number} fixedTimeStep - Positive interval when fixed stepping is selected.
     */
    function stepSimulation(timeStep, maxSubSteps, fixedTimeStep) {
        requireStaticWorld();
        integer(maxSubSteps, 'maximum substeps');

        if (!Number.isFinite(timeStep) || timeStep < 0 || maxSubSteps < 0
            || !Number.isFinite(fixedTimeStep) || fixedTimeStep < 0
            || (maxSubSteps > 0 && fixedTimeStep === 0)) {
            throw new RangeError('Invalid simulation step parameters');
        }

        let remainder = 0;
        let count = timeStep > 0 ? 1 : 0;
        let executed = timeStep;
        let dropped = 0;

        if (maxSubSteps > 0) {
            const accumulated = simulation.remainder + timeStep;
            const requested = Math.floor(accumulated / fixedTimeStep);

            if (!Number.isSafeInteger(requested)) {
                throw new RangeError('Simulation substep count exceeds exact host range');
            }

            count = Math.min(requested, maxSubSteps);
            remainder = accumulated - requested * fixedTimeStep;
            executed = count * fixedTimeStep;
            dropped = (requested - count) * fixedTimeStep;
        }

        const requestedSeconds = simulation.requestedSeconds + timeStep;
        const simulatedSeconds = simulation.simulatedSeconds + executed;
        const droppedSeconds = simulation.droppedSeconds + dropped;
        const substeps = simulation.substeps + count;

        if (![requestedSeconds, simulatedSeconds, droppedSeconds].every(Number.isFinite)
            || !Number.isSafeInteger(substeps) || !Number.isSafeInteger(simulation.calls + 1)) {
            throw new RangeError('Simulation clock exceeds host range');
        }

        simulation = { calls: simulation.calls + 1, requestedSeconds, simulatedSeconds, remainder, substeps, droppedSeconds };
        revision++;
    }

    /**
     * Stores original ground-level flags for a complete real chunk.
     *
     * @param {number} x - World chunk X.
     * @param {number} y - World chunk Y.
     * @param {Int8Array|Uint8Array} bytes - Original64 square flag bytes.
     */
    function setCollisionChunk(x, y, bytes) {
        chunkKey(x, y);

        if (bytes.length !== 64) {
            throw new RangeError('Collision chunk must contain64 square flags');
        }

        const flags = Array.from(bytes, (value) => value & 255);

        if (flags.some((value) => (value & ~31) !== 0)) {
            throw new RangeError('Unknown collision flag');
        }

        for (let sy = 0; sy < 8; sy++) {
            for (let sx = 0; sx < 8; sx++) {
                collision.set(`${x * 8 + sx},${y * 8 + sy}`, flags[sy * 8 + sx]);
            }
        }

        revision++;
    }

    /**
     * Applies original big-endian square-update records as one validated transaction.
     *
     * @param {number} count - Number of nine-byte records.
     * @param {Uint8Array} bytes - Original buffer bytes.
     */
    function setCollisionSquares(count, bytes) {
        integer(count, 'square update count');

        if (count < 0 || bytes.length !== count * 9) {
            throw new RangeError('Invalid collision square buffer extent');
        }

        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const updates = [];

        for (let index = 0; index < count; index++) {
            const x = view.getInt32(index * 9);
            const y = view.getInt32(index * 9 + 4);
            const flags = view.getUint8(index * 9 + 8);

            chunkKey(Math.floor(x / 8), Math.floor(y / 8));

            if ((flags & ~31) !== 0) {
                throw new RangeError('Unknown collision square flag');
            }

            updates.push([`${x},${y}`, flags]);
        }

        for (const [key, flags] of updates) {
            collision.set(key, flags);
        }

        revision++;
    }

    /**
     * Reads actual ground flags while distinguishing absent data from empty space.
     *
     * @param {number} x - World square X.
     * @param {number} y - World square Y.
     * @returns {number|null} Original flags, or null if no update supplied this square.
     */
    function collisionAt(x, y) {
        integer(x, 'square X');
        integer(y, 'square Y');
        chunkKey(Math.floor(x / 8), Math.floor(y / 8));

        return collision.get(`${x},${y}`) ?? null;
    }

    return {
        initialize, setLevels, submit, snapshot, setCollisionChunk, setCollisionSquares, collisionAt, stepSimulation, defineVehicleScript,
        natives: {
            Java_port_host_ClipperSupport_triangulateNative: triangulateEarcut,
            ...ragdolls.natives,
            /**
             * Identifies the implemented host backend in the original version labels.
             *
             * @returns {string} Browser static-geometry implementation and version.
             */
            Java_zombie_core_physics_Bullet_getPZBulletVersion() {
                return 'browser-static-geometry/1';
            },
            /**
             * Registers genuine original script metadata independently of dynamic bodies.
             *
             * @param {unknown} lib - Reserved CheerpJ library context.
             * @param {string} name - Original script name.
             * @param {Float32Array} values - Original Java float-array storage.
             */
            Java_zombie_core_physics_Bullet_defineVehicleScript(lib, name, values) {
                defineVehicleScript(name, values);
            },
            /**
             * Creates the world from the original WorldSimulation call.
             *
             * @param {unknown} lib - Reserved CheerpJ library context.
             * @param {...unknown} values - Original typed native arguments.
             */
            async Java_zombie_core_physics_Bullet_initWorld(lib, ...values) {
                await Promise.resolve();
                initialize(...values);
            },
            /**
             * Reports the actual lifecycle state of this owned backend.
             *
             * @returns {boolean} Whether a world is currently initialized.
             */
            async Java_zombie_core_physics_Bullet_isWorldInit() {
                await Promise.resolve();

                return world !== null;
            },
            /**
             * Releases all geometry owned by this world.
             */
            async Java_zombie_core_physics_Bullet_destroyWorld() {
                await Promise.resolve();
                chunks.clear();
                maps.clear();
                collision.clear();
                populationChunks.clear();
                vehicles.clear();
                dynamicObjects.clear();
                simulation = null;
                world = null;
                revision++;
            },
            /**
             * Advances the initialized world without fabricating dynamic bodies.
             *
             * @param {unknown} lib - Reserved CheerpJ library context.
             * @param {number} timeStep - Actual original elapsed seconds.
             * @param {number} maxSubSteps - Original substep cap.
             * @param {number} fixedTimeStep - Original fixed-step interval.
             */
            Java_zombie_core_physics_Bullet_stepSimulation(lib, timeStep, maxSubSteps, fixedTimeStep) {
                stepSimulation(timeStep, maxSubSteps, fixedTimeStep);
            },
            /**
             * Reports the real owned vehicle registry size.
             * Vehicle registration and dynamics remain unsupported native boundaries.
             *
             * @returns {number} Actual registered vehicle count.
             */
            Java_zombie_core_physics_Bullet_getVehicleCount() {
                requireStaticWorld();

                return vehicles.size;
            },
            /**
             * Reads the empty dynamic-object result set into the actual caller array.
             * With zero registered objects no floats are written and all capacity is preserved.
             *
             * @param {unknown} lib - Reserved CheerpJ library context.
             * @param {Float32Array} values - Original Java float-array output storage.
             * @returns {number} Actual registered dynamic-object count.
             */
            Java_zombie_core_physics_Bullet_getObjectPhysics(lib, values) {
                requireStaticWorld();

                if (!(values instanceof Float32Array)) {
                    throw new TypeError('Object physics output must be actual Java float-array storage');
                }

                if (values.length < dynamicObjects.size * 4) {
                    throw new RangeError('Object physics result exceeds output capacity');
                }

                return dynamicObjects.size;
            },
            /**
             * Registers an active original player chunk map.
             *
             * @param {unknown} lib - Reserved CheerpJ library context.
             * @param {number} id - Original player map index.
             * @param {number} x - Minimum active world chunk X.
             * @param {number} y - Minimum active world chunk Y.
             * @param {number} width - Original square chunk-map width.
             */
            async Java_zombie_core_physics_Bullet_activateChunkMap(lib, id, x, y, width) {
                await Promise.resolve();
                integer(id, 'map index');
                integer(width, 'map width');

                if (!world || id < 0 || id > 3 || width <= 0) {
                    throw new RangeError('Invalid active chunk map');
                }

                integer(x, 'map X');
                integer(y, 'map Y');
                maps.set(id, { id, x, y, width });
                revision++;
            },
            /**
             * Removes an original player map registration.
             *
             * @param {unknown} lib - Reserved CheerpJ library context.
             * @param {number} id - Previously registered player map index.
             */
            async Java_zombie_core_physics_Bullet_deactivateChunkMap(lib, id) {
                await Promise.resolve();

                if (!maps.delete(id)) {
                    throw new Error(`Chunk map ${id} is not active`);
                }

                revision++;
            },
            /**
             * Stores the height bounds supplied by the original chunk update.
             *
             * @param {unknown} lib - Reserved CheerpJ library context.
             * @param {...number} values - Original chunk coordinates and level bounds.
             */
            async Java_zombie_core_physics_Bullet_setChunkMinMaxLevel(lib, ...values) {
                await Promise.resolve();
                setLevels(...values);
            },
            /**
             * Copies the original direct-buffer command without changing its position.
             *
             * @param {unknown} lib - Reserved CheerpJ library context.
             * @param {object} buffer - Actual Java ByteBuffer proxy.
             */
            async Java_zombie_core_physics_Bullet_ToBullet(lib, buffer) {
                submit(await copyBuffer(buffer, 4_096));
            },
            /**
             * Stores flags generated by original MapCollisionData.addChunkToWorld.
             *
             * @param {unknown} lib - Reserved CheerpJ library context.
             * @param {number} x - Original chunk X.
             * @param {number} y - Original chunk Y.
             * @param {Int8Array} bytes - Original Java byte array.
             */
            async Java_zombie_MapCollisionData_n_1chunkUpdateTask(lib, x, y, bytes) {
                await Promise.resolve();
                setCollisionChunk(x, y, bytes);
            },
            /**
             * Applies original queued ground-level collision changes.
             *
             * @param {unknown} lib - Reserved CheerpJ library context.
             * @param {number} count - Original update count.
             * @param {object} buffer - Actual Java ByteBuffer proxy.
             */
            async Java_zombie_MapCollisionData_n_1squareUpdateTask(lib, count, buffer) {
                setCollisionSquares(count, await copyBuffer(buffer, 1_024));
            },
            /**
             * Tracks actual chunk ownership notifications without claiming population simulation.
             * Population updates, spawning, saving, and queries remain unavailable.
             *
             * @param {unknown} lib - Reserved CheerpJ library context.
             * @param {number} x - Original loaded chunk X.
             * @param {number} y - Original loaded chunk Y.
             * @param {boolean} loaded - Whether the original chunk entered the world.
             */
            async Java_zombie_popman_ZombiePopulationManager_n_1loadChunk(lib, x, y, loaded) {
                await Promise.resolve();
                const key = chunkKey(x, y);

                if (loaded) {
                    populationChunks.add(key);
                } else {
                    populationChunks.delete(key);
                }

                revision++;
            },
            /**
             * Allocates an actual empty polygon container owned by the Java Clipper instance.
             *
             * @param {unknown} lib - Reserved CheerpJ library context.
             * @param {object} receiver - Original Clipper instance supplied by the JVM.
             */
            async Java_zombie_vehicles_Clipper_newInstance(lib, receiver) {
                await Promise.resolve();

                if (!receiver || await findClipper(receiver)) {
                    throw new Error('Invalid or duplicate Clipper allocation');
                }

                if (lib) {
                    await (await clipperSupport(lib)).allocate(receiver);
                }

                clippers.push({ receiver, paths: [], polygons: [] });
                clipperAllocations++;
            },
            /**
             * Removes all paths and results from an owned Clipper container.
             *
             * @param {unknown} lib - Reserved CheerpJ library context.
             * @param {object} receiver - Previously allocated Java Clipper instance.
             */
            async Java_zombie_vehicles_Clipper_clear(lib, receiver) {
                await Promise.resolve();
                const state = await findClipper(receiver);

                if (!state) {
                    throw new Error('Unknown Clipper container');
                }

                if (lib) {
                    await (await clipperSupport(lib)).clear(receiver);
                }

                state.paths.length = 0;
                state.polygons.length = 0;
                clipperClears++;
            },
            /**
             * Passes a closed path through the qualified fixed-endian Java buffer adapter.
             *
             * @param {object} lib - Actual browser JVM library.
             * @param {object} receiver - Original owned Clipper instance.
             * @param {number} count - Original point count.
             * @param {object} buffer - Original direct ByteBuffer.
             * @param {boolean} isClip - Whether this is a clipping path.
             * @param {boolean} closed - Whether the original path is closed.
             */
            async Java_zombie_vehicles_Clipper_addPath(lib, receiver, count, buffer, isClip, closed) {
                await (await clipperSupport(lib)).addPath(receiver, count, buffer, isClip, closed);
            },
            /**
             * Forwards native-qualified polygon coordinates without changing winding.
             *
             * @param {object} lib - Actual browser JVM library.
             * @param {object} receiver - Original owned Clipper instance.
             * @param {number} left - Original coordinate.
             * @param {number} top - Original coordinate.
             * @param {number} right - Original coordinate.
             * @param {number} bottom - Original coordinate.
             */
            async Java_zombie_vehicles_Clipper_addAABB(lib, receiver, left, top, right, bottom) {
                await (await clipperSupport(lib)).addAABB(receiver, left, top, right, bottom);
            },
            /**
             * Forwards native-qualified polygon coordinates without changing winding.
             *
             * @param {object} lib - Actual browser JVM library.
             * @param {object} receiver - Original owned Clipper instance.
             * @param {number} x1 - Original coordinate.
             * @param {number} y1 - Original coordinate.
             * @param {number} x2 - Original coordinate.
             * @param {number} y2 - Original coordinate.
             * @param {number} x3 - Original coordinate.
             * @param {number} y3 - Original coordinate.
             * @param {number} x4 - Original coordinate.
             * @param {number} y4 - Original coordinate.
             */
            async Java_zombie_vehicles_Clipper_addPolygon(lib, receiver, x1, y1, x2, y2, x3, y3, x4, y4) {
                await (await clipperSupport(lib)).addPolygon(receiver, x1, y1, x2, y2, x3, y3, x4, y4);
            },
            /**
             * Forwards native-qualified polygon coordinates without changing winding.
             *
             * @param {object} lib - Actual browser JVM library.
             * @param {object} receiver - Original owned Clipper instance.
             * @param {number} left - Original coordinate.
             * @param {number} top - Original coordinate.
             * @param {number} right - Original coordinate.
             * @param {number} bottom - Original coordinate.
             */
            async Java_zombie_vehicles_Clipper_clipAABB(lib, receiver, left, top, right, bottom) {
                await (await clipperSupport(lib)).clipAABB(receiver, left, top, right, bottom);
            },
            /**
             * Executes the real Clipper2 engine for native-qualified operations.
             *
             * @param {object} lib - Actual browser JVM library.
             * @param {object} receiver - Original owned Clipper instance.
             * @param {number} operation - Original clipping operation enum.
             * @param {number} offset - Original requested offset.
             * @param {number} join - Original join enum.
             * @returns {Promise<number>} Actual number of resulting polygons.
             */
            async Java_zombie_vehicles_Clipper_generatePolygons(lib, receiver, operation, offset, join) {
                return await (await clipperSupport(lib)).generate(receiver, operation, offset, join);
            },
            /**
             * Serializes a real polygon after atomic capacity validation in Java.
             *
             * @param {object} lib - Actual browser JVM library.
             * @param {object} receiver - Original owned Clipper instance.
             * @param {number} index - Original polygon index.
             * @param {object} buffer - Original direct output ByteBuffer.
             * @returns {Promise<number>} Native-qualified success code.
             */
            async Java_zombie_vehicles_Clipper_getPolygon(lib, receiver, index, buffer) {
                return await (await clipperSupport(lib)).getPolygon(receiver, index, buffer);
            },
            /**
             * Tessellates a real generated polygon into its original indexed buffer ABI.
             *
             * @param {object} lib - Actual browser JVM library.
             * @param {object} receiver - Original owned Clipper instance.
             * @param {number} index - Original polygon index.
             * @param {object} buffer - Original direct output ByteBuffer.
             * @returns {Promise<number>} Actual triangle index count.
             */
            async Java_zombie_vehicles_Clipper_triangulate2(lib, receiver, index, buffer) {
                return await (await clipperSupport(lib)).triangulate2(receiver, index, buffer);
            },
        },
    };
}
