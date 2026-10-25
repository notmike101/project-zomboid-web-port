import { createBulletNatives } from './bullet-natives.js';

/**
 * Creates the real vehicle JNI adapter with explicit qualification boundaries.
 *
 * @param {object} engine - Initialized real Bullet module.
 * @returns {object} Actual operation result.
 */
export function createVehicleWorldNatives(engine) {
    const base = createBulletNatives(engine, { registeredStaticMeshes: true });
    const definitions = new Map();
    const calls = [];
    const vehicleIds = new Set();
    let readbackCount = null;

    /**
     * Rejects unsupported input before changing engine state.
     *
     * @param {number|boolean} value - Original scalar or boolean argument.
     * @param {string} message - Boundary failure description.
     */
    // eslint-disable-next-line unicorn/consistent-function-scoping -- Keep native boundary helpers local to this adapter.
    const expect = (value, message) => {
        if (!value) {
            throw new Error(message);
        }
    };

    /**
     * Preserves original Java exceptions and translates authored host errors.
     *
     * @param {object} lib - Original Java namespace supplied by the runtime.
     * @param {function(): unknown} operation - Operation using the actual engine.
     * @returns {Promise<unknown>} Actual operation result.
     */
    // eslint-disable-next-line unicorn/consistent-function-scoping -- Keep Java exception translation beside the native adapter.
    async function checked(lib, operation) {
        try {
            return await operation();
        } catch (error) {
            // Preserve original Java exceptions from genuine callbacks.
            if (!(error instanceof Error)) {
                throw error;
            }

            const Exception = await lib.java.lang.UnsupportedOperationException;

            throw await new Exception(error.message);
        }
    }

    /**
     * Passes original typed values through an owned engine allocation.
     *
     * @param {Float32Array} values - Original typed parameter values.
     * @param {function(number): unknown} operation - Operation using the actual engine.
     * @returns {unknown} Actual operation result.
     */
    function floats(values, operation) {
        expect(values instanceof Float32Array && values.every(Number.isFinite), 'Expected actual finite original float array');

        const pointer = engine._malloc(values.byteLength);

        expect(pointer !== 0, 'Actual input allocation failed');

        try {
            engine.HEAPF32.set(values, pointer / 4);

            return operation(pointer);
        } finally {
            engine._free(pointer);
        }
    }

    /**
     * Decodes the complete original chunk command into actual geometry.
     *
     * @param {object} buffer - Original direct Java ByteBuffer.
     */
    async function command(buffer) {
        const length = await buffer.position();

        expect(Number.isInteger(length) && length >= 13 && length <= 4_096, 'Original command extent');

        const bytes = new Uint8Array(length);

        for (let i = 0; i < length; i++) {
            // eslint-disable-next-line no-await-in-loop -- Read the original ByteBuffer in command order.
            bytes[i] = await buffer.get(i) & 255;
        }

        const data = new DataView(bytes.buffer);

        expect(bytes[0] === 8, 'Unsupported original command');

        const [x, y, min, max, level] = [1, 3, 5, 7, 9].map((offset) => data.getInt16(offset, true));

        const cells = new Int32Array(256);
        const seen = new Set();
        let cursor = 11;
        let terminated = false;

        while (cursor < length) {
            expect(cursor + 2 <= length, 'Truncated command cell');
            const sx = bytes[cursor++];
            const sy = bytes[cursor++];

            if (sx === 255 && sy === 255) {
                terminated = true;
                break;
            }

            expect(sx < 8 && sy < 8 && cursor < length && !seen.has(sx * 8 + sy), 'Invalid or duplicate command cell');
            seen.add(sx * 8 + sy);

            const count = bytes[cursor++];

            expect(count <= 4 && cursor + count <= length, 'Invalid original shape count');

            for (let index = 0; index < count; index++) {
                const encoded = bytes[cursor++];

                expect(encoded >= 1 && (encoded <= 10 || engine._has_static_mesh(encoded - 11) === 1), `Unsupported original static geometry ID ${encoded}`);

                cells[(sx * 8 + sy) * 4 + index] = encoded;
            }
        }

        expect(terminated && cursor === length && seen.size === 64, 'Incomplete original level replacement');

        const pointer = engine._malloc(cells.byteLength);

        try {
            engine.HEAP32.set(cells, pointer / 4);
            expect(engine._replace_chunk_level(x, y, min, max, level, pointer) === 1, 'Real chunk level replacement rejected');
        } finally {
            engine._free(pointer);
        }

        calls.push({ method: 'ToBullet', x, y, min, max, level, cells: seen.size });
    }

    const raw = {
        /**
         * Registers an original typed definition.
         *
         * @param {object} lib - Original Java namespace supplied by the runtime.
         * @param {string} name - Original vehicle definition name.
         * @param {Float32Array} values - Original typed parameter values.
         */
        defineVehicleScript(lib, name, values) {
            name = String(name);
            expect(name.length > 0 && name.length <= 256, 'Unsupported definition name');

            expect(values instanceof Float32Array && values.length === 200, 'Original200-float definition required');

            const key = definitions.get(name)?.key ?? definitions.size + 1;

            floats(values, (pointer) => expect(engine._define_vehicle_named(key, pointer, 200) === 1, `Unsupported original typed definition ${name}`));
            definitions.set(name, { key, wheels: values[10] });
        },
        /**
         * Constructs the supported vehicle in the real engine.
         *
         * @param {object} lib - Original Java namespace supplied by the runtime.
         * @param {number} id - Original numeric native argument.
         * @param {number} x - Original numeric native argument.
         * @param {number} y - Original numeric native argument.
         * @param {number} z - Original numeric native argument.
         * @param {number} qx - Original numeric native argument.
         * @param {number} qy - Original numeric native argument.
         * @param {number} qz - Original numeric native argument.
         * @param {number} qw - Original numeric native argument.
         * @param {string} name - Original vehicle definition name.
         */
        addVehicle(lib, id, x, y, z, qx, qy, qz, qw, name) {
            const definition = definitions.get(String(name));

            expect(definition?.wheels === 4, 'Original owner component requires a registered four-wheel definition');

            expect(Number.isInteger(id) && !vehicleIds.has(id), 'Unsupported duplicate vehicle owner');

            expect(engine._select_vehicle_definition(definition.key) === 1 && engine._add_vehicle(id, x, y, z, qx, qy, qz, qw) === 1, 'Actual vehicle creation rejected');
            vehicleIds.add(id);
            readbackCount = null;
            calls.push({ method: 'addVehicle', id, name: String(name), x, y, z, qx, qy, qz, qw });
        },
        /**
         * Dispatches removeVehicle to the actual qualified engine operation.
         *
         * @param {object} lib - Original Java namespace supplied by the runtime.
         * @param {number} id - Original numeric native argument.
         */
        removeVehicle(lib, id) {
            expect(engine._remove_vehicle(id) === 1, 'Actual vehicle removal rejected');

            if (vehicleIds.delete(id)) {
                readbackCount = null;
            }
        },
        /**
         * Dispatches setVehicleActive to the actual qualified engine operation.
         *
         * @param {object} lib - Original Java namespace supplied by the runtime.
         * @param {number} id - Original numeric native argument.
         * @param {boolean} active - Requested original activation state.
         */
        setVehicleActive(lib, id, active) {
            expect(typeof active === 'boolean' && engine._set_vehicle_active(id, Number(active)) === 1, 'Actual vehicle activation rejected');
        },
        /**
         * Dispatches setVehicleStatic to the actual qualified engine operation.
         *
         * @param {object} lib - Original Java namespace supplied by the runtime.
         * @param {number} id - Original numeric native argument.
         * @param {number|boolean} value - Original scalar or boolean argument.
         * @returns {number} Actual operation result.
         */
        setVehicleStatic(lib, id, value) {
            expect(typeof value === 'boolean' && engine._set_vehicle_static(id, Number(value)) === 1, 'Actual mapped static transition rejected');

            return 1;
        },
        /**
         * Dispatches setVehicleMass to the actual qualified engine operation.
         *
         * @param {object} lib - Original Java namespace supplied by the runtime.
         * @param {number} id - Original numeric native argument.
         * @param {number|boolean} value - Original scalar or boolean argument.
         * @returns {number} Actual operation result.
         */
        setVehicleMass(lib, id, value) {
            expect(engine._set_vehicle_mass(id, value) === 1, 'Actual vehicle mass rejected');

            return 0;
        },
        /**
         * Dispatches setTireInflation to the actual qualified engine operation.
         *
         * @param {object} lib - Original Java namespace supplied by the runtime.
         * @param {number} id - Original numeric native argument.
         * @param {number} index - Original numeric native argument.
         * @param {number|boolean} value - Original scalar or boolean argument.
         */
        setTireInflation(lib, id, index, value) {
            expect(engine._set_tire_inflation(id, index, value) === 1, 'Actual tire inflation rejected');
        },
        /**
         * Dispatches setTireRemoved to the actual qualified engine operation.
         *
         * @param {object} lib - Original Java namespace supplied by the runtime.
         * @param {number} id - Original numeric native argument.
         * @param {number} index - Original numeric native argument.
         * @param {number|boolean} value - Original scalar or boolean argument.
         */
        setTireRemoved(lib, id, index, value) {
            expect(typeof value === 'boolean' && engine._set_tire_removed(id, index, Number(value)) === 1, 'Actual tire removal rejected');
        },
        /**
         * Looks up the real owner before reading its parameter array.
         *
         * @param {object} lib - Original Java namespace supplied by the runtime.
         * @param {number} id - Original numeric native argument.
         * @param {Float32Array} values - Original typed parameter values.
         * @returns {number} Actual operation result.
         */
        setVehicleParams(lib, id, values) {
            expect(Number.isInteger(id), 'Invalid original vehicle ID');

            const count = engine._registered_vehicle_count();

            expect(count >= 0, 'Physics world not initialized');

            expect(count === vehicleIds.size, 'Actual vehicle registry ownership mismatch');

            // Native 0x18000e390 looks up the owner before accessing even a null array.
            if (!vehicleIds.has(id)) {
                calls.push({ method: 'setVehicleParams', id, outcome: 'lookup-miss', result: -1 });

                return -1;
            }

            floats(values, (pointer) => expect(engine._set_vehicle_params(id, pointer, values.length) === 1, 'Actual wheel parameter update rejected'));

            return 0;
        },
        /**
         * Dispatches setVehicleVelocityMultiplier to the actual qualified engine operation.
         *
         * @param {object} lib - Original Java namespace supplied by the runtime.
         * @param {number} id - Original numeric native argument.
         * @param {number} threshold - Original numeric native argument.
         * @param {number} multiplier - Original numeric native argument.
         */
        setVehicleVelocityMultiplier(lib, id, threshold, multiplier) {
            expect(engine._set_vehicle_velocity_multiplier(id, threshold, multiplier) === 1, 'Unsupported actual velocity multiplier');
        },
        /**
         * Dispatches controlVehicle to the actual qualified engine operation.
         *
         * @param {object} lib - Original Java namespace supplied by the runtime.
         * @param {number} id - Original numeric native argument.
         * @param {number} force - Original numeric native argument.
         * @param {number} brake - Original numeric native argument.
         * @param {number} steering - Original numeric native argument.
         */
        controlVehicle(lib, id, force, brake, steering) {
            expect(engine._control_vehicle(id, force, brake, steering) === 1, 'Unsupported actual wheel controls');
        },
        /**
         * Dispatches applyCentralForceToVehicle to the actual qualified engine operation.
         *
         * @param {object} lib - Original Java namespace supplied by the runtime.
         * @param {number} id - Original numeric native argument.
         * @param {number} x - Original numeric native argument.
         * @param {number} y - Original numeric native argument.
         * @param {number} z - Original numeric native argument.
         */
        applyCentralForceToVehicle(lib, id, x, y, z) {
            expect(engine._apply_central_force(id, x, y, z) === 1, 'Unsupported actual vehicle force');
        },
        /**
         * Dispatches setChunkMinMaxLevel to the actual qualified engine operation.
         *
         * @param {object} lib - Original Java namespace supplied by the runtime.
         * @param {number} x - Original numeric native argument.
         * @param {number} y - Original numeric native argument.
         * @param {number} min - Original numeric native argument.
         * @param {number} max - Original numeric native argument.
         */
        setChunkMinMaxLevel(lib, x, y, min, max) {
            expect([x, y, min, max].every(Number.isInteger) && engine._set_chunk_levels(x, y, min, max) === 1, 'Unsupported original chunk extent');
        },
        /**
         * Scrolls the actual player's chunk map while retaining shared chunks and bodies.
         *
         * @param {object} lib - Original Java namespace supplied by the runtime.
         * @param {number} id - Original player map index.
         * @param {number} direction - Original left, right, up or down ordinal.
         */
        scrollChunkMap(lib, id, direction) {
            expect(Number.isInteger(id) && Number.isInteger(direction) && engine._scroll_map(id, direction) === 1, 'Unsupported original chunk-map scroll');
        },
        /**
         * Dispatches ToBullet to the actual qualified engine operation.
         *
         * @param {object} lib - Original Java namespace supplied by the runtime.
         * @param {object} buffer - Original direct Java ByteBuffer.
         */
        async ToBullet(lib, buffer) {
            await command(buffer);
        },
        /**
         * Invokes original Java callbacks before actual publication and simulation.
         *
         * @param {object} lib - Original Java namespace supplied by the runtime.
         * @param {number} delta - Original numeric native argument.
         * @param {number} maxSteps - Original numeric native argument.
         * @param {number} fixed - Original numeric native argument.
         */
        async stepSimulation(lib, delta, maxSteps, fixed) {
            expect(Math.fround(delta) === Math.fround(0.01) && maxSteps === 0 && fixed === 0, 'Unsupported original simulation interval');

            const pointer = engine._malloc(169 * 64 * 3 * 4);
            const mapInfo = engine._malloc(24);
            let publicationCallbacks = 0;

            try {
                expect(pointer !== 0 && mapInfo !== 0, 'Actual publication allocation failed');
                const Bullet = await lib.zombie.core.physics.Bullet;

                for (let id = 0; id < 4; id++) {
                    if (engine._map_info(id, mapInfo) !== 1) {
                        continue;
                    }

                    const count = engine._begin_vehicle_publication(pointer, 169 * 64, id);

                    expect(count >= 0 && count <= 169 * 64, 'Unsupported mapped publication domain');
                    const callbacks = Array.from(engine.HEAP32.subarray(pointer / 4, pointer / 4 + count * 3));

                    publicationCallbacks += count;

                    for (let i = 0; i < callbacks.length; i += 3) {
                        const [x, y, level] = callbacks.slice(i, i + 3);
                        // eslint-disable-next-line no-await-in-loop -- Original callbacks precede this map's actual body publication.
                        const uploaded = await Bullet.updatePhysicsForLevelIfNeeded(x, y, level);

                        calls.push({ method: 'original-level-callback', x, y, level, uploaded });
                    }

                    expect(engine._finish_vehicle_publication(id) === 1, 'Actual level body publication rejected');
                }
            } finally {
                engine._free(mapInfo);
                engine._free(pointer);
            }

            expect(engine._step_mapped_vehicle(delta) === 1, 'Actual mapped Dynamics step rejected');

            const state = engine._malloc(40);
            let dynamics;

            try {
                expect(engine._world_state(state) === 1, 'Actual stepped Dynamics world missing');
                dynamics = Array.from(engine.HEAPF64.subarray(state / 8, state / 8 + 5));
            } finally {
                engine._free(state);
            }

            calls.push({ method: 'stepSimulation', delta, callbacks: publicationCallbacks, dynamics, geometryBodies: engine._geometry_count(), registeredVehicles: engine._registered_vehicle_count() });
        },
        /**
         * Dispatches getVehicleCount to the actual qualified engine operation.
         *
         * @returns {number} Actual operation result.
         */
        getVehicleCount() {
            const count = engine._vehicle_count_snapshot();

            expect(count === vehicleIds.size, 'Actual vehicle snapshot ownership mismatch');
            readbackCount = count;

            return count;
        },
        /**
         * Copies an actual typed vehicle record.
         *
         * @param {object} lib - Original Java namespace supplied by the runtime.
         * @param {number} offset - Original numeric native argument.
         * @param {Float32Array} values - Original typed parameter values.
         * @returns {Promise<number>} Actual operation result.
         */
        async getVehiclePhysics(lib, offset, values) {
            expect(Number.isInteger(offset), 'Invalid original vehicle offset');

            if (offset < 0) {
                const Exception = await lib.java.lang.IllegalArgumentException;

                throw await new Exception('Invalid original vehicle offset');
            }

            expect(readbackCount !== null, 'Original vehicle count snapshot required after owner changes');

            if (offset >= readbackCount) {
                return 0;
            }

            expect(values instanceof Float32Array, 'Original typed readback array required');

            if (values.length < 30) {
                const Exception = await lib.java.lang.IllegalArgumentException;

                throw await new Exception('Original readback array too small');
            }

            const pointer = engine._malloc(values.byteLength);

            expect(pointer !== 0, 'Actual readback allocation failed');

            try {
                const written = engine._get_vehicle_physics_batch(offset, pointer, values.length);

                expect(written >= 0 && written <= Math.floor(values.length / 30), 'Actual ordered vehicle snapshot readback rejected');
                values.set(engine.HEAPF32.subarray(pointer / 4, pointer / 4 + written * 30));

                return written;
            } finally {
                engine._free(pointer);
            }
        },
        /**
         * Dispatches getObjectPhysics to the actual qualified engine operation.
         *
         * @returns {number} Actual operation result.
         */
        getObjectPhysics() {
            // Inspect actual world ownership; unrecognized addPhysicsObject remains an actual native failure.
            const count = engine._object_registry_count();

            expect(count === 0, 'Unqualified physics object owner');

            return count;
        },
        /**
         * Releases actual host-owned engine resources and definitions.
         *
         * @param {object} lib - Original Java namespace supplied by the runtime.
         */
        async destroyWorld(lib) {
            await base.natives.Java_zombie_core_physics_Bullet_destroyWorld(lib);
            definitions.clear();
            vehicleIds.clear();
            readbackCount = null;
        },
    };

    const natives = { ...base.natives };

    for (const [name, operation] of Object.entries(raw)) {
        /**
         * Dispatches original native arguments and preserves Java exception identity.
         *
         * @param {...unknown} args - Actual native arguments.
         * @returns {unknown} Actual operation result.
         */
        natives[`Java_zombie_core_physics_Bullet_${name}`] = (...args) => {
            calls.push({ enter: name, args: args.slice(1).filter((value) => ['number', 'boolean', 'string'].includes(typeof value)) });

            return checked(args[0], () => operation(...args));
        };
    }

    return {
        natives,
        /**
         * Copies read-only engine and ownership diagnostics.
         *
         * @returns {object} Actual operation result.
         */
        snapshot: () => {
            let observed;

            try {
                observed = base.snapshot();
            } catch (error) {
                const pointer = engine._malloc(48);

                try {
                    const initialized = engine._world_state(pointer) === 1;

                    const state = initialized ? Array.from(engine.HEAPF64.subarray(pointer / 8, pointer / 8 + 5)) : null;

                    const header = initialized && engine._world_header(pointer) === 1 ? Array.from(engine.HEAP32.subarray(pointer / 4, pointer / 4 + 6)) : null;

                    observed = { diagnosticError: String(error), maps: null, world: header, dynamics: state };
                } finally {
                    engine._free(pointer);
                }
            }

            return { ...observed, definitionCount: definitions.size, vehicleId: vehicleIds.size === 1 ? vehicleIds.values().next().value : null, vehicleIds: [...vehicleIds], calls: calls.slice() };
        },
    };
}
