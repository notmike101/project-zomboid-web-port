import { createBulletNatives } from './bullet-natives.js';

/**
 * Creates the real vehicle JNI adapter with explicit qualification boundaries.
 *
 * @param {object} engine - Initialized real Bullet module.
 * @param {object} [options] - Same-owner definition access.
 * @param {function(): object[]} [options.ragdollDefinitions] - Detached original ragdoll definitions.
 * @returns {object} Actual operation result.
 */
export function createVehicleWorldNatives(engine, { ragdollDefinitions = () => [] } = {}) {
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

    /**
     * Copies original skeletal/rigid output prefixes from the owned real bodies.
     *
     * @param {number} id - Original ragdoll identity.
     * @param {Float32Array} values - Original local bone output buffer.
     * @param {Float32Array|null} bodies - Optional original body output buffer.
     * @returns {number} Original bone count, or minus one for absent ownership.
     */
    function readRagdoll(id, values, bodies) {
        const count = engine._ragdoll_bone_count(id);

        if (count === -1) {
            return -1;
        }

        expect(values instanceof Float32Array && values.length >= count * 7
            && (bodies === null || (bodies instanceof Float32Array && bodies.length >= 77)), 'Original contained ragdoll output buffers required');

        const bones = engine._malloc(count * 28);
        const rigid = bodies === null ? 0 : engine._malloc(308);

        try {
            expect(bones !== 0 && (bodies === null || rigid !== 0), 'Actual ragdoll output allocation failed');
            expect(engine._read_ragdoll(id, bones, count * 7, rigid) === count, 'Actual original ragdoll reconstruction rejected');
            values.set(engine.HEAPF32.subarray(bones / 4, bones / 4 + count * 7));

            if (bodies !== null) {
                bodies.set(engine.HEAPF32.subarray(rigid / 4, rigid / 4 + 77));
            }

            return count;
        } finally {
            engine._free(rigid);
            engine._free(bones);
        }
    }

    /**
     * Obtains the original target owner without attaching its collision box.
     *
     * @param {number} id - Original character identity.
     */
    function ensureBallisticsTarget(id) {
        const definitions = ragdollDefinitions();
        const parts = definitions.find((entry) => entry.kind === 'bodyParts');
        const dynamics = definitions.find((entry) => entry.kind === 'bodyDynamics');
        const constraints = definitions.find((entry) => entry.kind === 'constraints');

        expect(parts?.values.length === 110 && dynamics?.values.length === 88 && constraints?.values.length === 220,
            'Complete original ballistics body/constraint definitions required');
        floats(new Float32Array(parts.values), (bodyParts) => floats(new Float32Array(dynamics.values), (bodyDynamics) => floats(new Float32Array(constraints.values), (joints) => {
            expect(engine._ensure_ballistics_target(id, bodyParts, bodyDynamics, joints) === 0, 'Actual target allocation rejected');
        })));
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
         * Accumulates original world-axis torque without changing activation.
         *
         * @param {object} lib - Original Java namespace supplied by the runtime.
         * @param {number} id - Original vehicle identity.
         * @param {number} x - World-axis X torque.
         * @param {number} y - World-axis Y torque.
         * @param {number} z - World-axis Z torque.
         */
        applyTorqueToVehicle(lib, id, x, y, z) {
            expect(engine._apply_torque(id, x, y, z) === 1, 'Unsupported actual vehicle torque');
        },
        /**
         * Relocates the owned body through the original detach/COM/reattach sequence.
         *
         * @param {object} lib - Original Java namespace supplied by the runtime.
         * @param {number} id - Original vehicle identity.
         * @param {number} x - Original world X.
         * @param {number} y - Original world Y.
         * @param {number} z - Original physics height.
         * @param {number} qx - Quaternion X.
         * @param {number} qy - Quaternion Y.
         * @param {number} qz - Quaternion Z.
         * @param {number} qw - Quaternion W.
         */
        teleportVehicle(lib, id, x, y, z, qx, qy, qz, qw) {
            expect(engine._teleport_vehicle(id, x, y, z, qx, qy, qz, qw) === 1, 'Unsupported actual vehicle relocation');
        },
        /**
         * Creates the original generic six-axis towing constraint.
         *
         * @param {object} lib - Original Java namespace.
         * @param {number} first - First vehicle identity.
         * @param {number} second - Second vehicle identity.
         * @param {...number} values - Original pivots and axis limits.
         * @returns {number} Actual constraint identity.
         */
        add6DofConstraint(lib, first, second, ...values) {
            expect(values.length === 18, 'Original six-axis constraint extent');

            return floats(new Float32Array(values), (pointer) => {
                const id = engine._add_vehicle_constraint(first, second, pointer, 0);

                expect(id > 0, 'Actual six-axis constraint creation rejected');

                return id;
            });
        },
        /**
         * Creates original rope towing as a generic constraint with cubic linear bounds.
         *
         * @param {object} lib - Original Java namespace.
         * @param {number} first - First vehicle identity.
         * @param {number} second - Second vehicle identity.
         * @param {...number} values - Original pivots and length.
         * @returns {number} Actual constraint identity.
         */
        addRopeConstraint(lib, first, second, ...values) {
            expect(values.length === 7, 'Original rope constraint extent');

            return floats(new Float32Array(values), (pointer) => {
                const id = engine._add_vehicle_constraint(first, second, pointer, 1);

                expect(id > 0, 'Actual rope constraint creation rejected');

                return id;
            });
        },
        /**
         * Sets the original stop ERP for one towing axis.
         *
         * @param {object} lib - Original Java namespace.
         * @param {number} id - Constraint identity.
         * @param {number} value - Original ERP.
         * @param {number} axis - Axis zero through five.
         */
        setConstraintERP(lib, id, value, axis) {
            expect(engine._set_vehicle_constraint_erp(id, value, axis) === 1, 'Actual constraint ERP rejected');
        },
        /**
         * Removes the owned towing constraint before releasing its storage.
         *
         * @param {object} lib - Original Java namespace.
         * @param {number} id - Constraint identity.
         */
        removeConstraint(lib, id) {
            expect(engine._remove_vehicle_constraint(id) === 1, 'Actual constraint removal rejected');
        },
        /**
         * Constructs original bone transforms and owned template collision shapes.
         *
         * @param {object} lib - Original Java namespace.
         * @param {number} count - Original bone count.
         * @param {Float32Array} values - Original seven-float local bone records.
         * @param {number} qx - Root quaternion X.
         * @param {number} qy - Root quaternion Y.
         * @param {number} qz - Root quaternion Z.
         * @param {number} qw - Root quaternion W.
         */
        initializeRagdollPose(lib, count, values, qx, qy, qz, qw) {
            const definitions = ragdollDefinitions();
            const skeleton = definitions.find((entry) => entry.kind === 'skeleton');
            const bodyParts = definitions.find((entry) => entry.kind === 'bodyParts');

            expect(Number.isInteger(count) && count >= 27 && count <= 4_096 && skeleton?.values.length === count
                && bodyParts?.values.length === 110 && values instanceof Float32Array && values.length >= count * 7,
            'Original ragdoll template prerequisites missing');

            const parents = engine._malloc(count * 4);

            try {
                expect(parents !== 0, 'Actual ragdoll parent allocation failed');
                engine.HEAP32.set(skeleton.values, parents / 4);
                floats(new Float32Array(bodyParts.values), (records) => floats(values.subarray(0, count * 7), (pose) => {
                    expect(engine._initialize_ragdoll_template(parents, count, pose, qx, qy, qz, qw, records, 11) === 1,
                        'Actual original ragdoll template construction rejected');
                }));
            } finally {
                engine._free(parents);
            }
        },
        /**
         * Stores the original radian axis rotation for the target skeleton root.
         *
         * @param {object} lib - Original Java namespace.
         * @param {number} id - Original character identity.
         * @param {number} x - Original X rotation.
         * @param {number} y - Original Y rotation.
         * @param {number} z - Original Z rotation.
         */
        setBallisticsTargetAxis(lib, id, x, y, z) {
            expect(engine._set_ballistics_target_axis(id, x, y, z) === 1, 'Actual ballistics target axis rejected');
        },
        /**
         * Applies original animation bones to the target's separate detached bodies.
         *
         * @param {object} lib - Original Java namespace.
         * @param {number} id - Original character identity.
         * @param {number} count - Original bone prefix count.
         * @param {Float32Array} values - Original local translation/quaternion records.
         */
        updateBallisticsTargetSkeleton(lib, id, count, values) {
            expect(values instanceof Float32Array && Number.isInteger(count) && count > 0 && count * 7 <= values.length,
                'Original ballistics skeleton prefix required');

            ensureBallisticsTarget(id);

            const anchors = ragdollDefinitions().find((entry) => entry.kind === 'anchors');

            expect(anchors?.values.length % 5 === 0, 'Original target anchor definition required');
            floats(values.subarray(0, count * 7), (records) => floats(new Float32Array(anchors.values), (definitions) => {
                expect(engine._update_ballistics_target_skeleton(id, count, records, definitions, anchors.values.length / 5) === 1,
                    'Actual ballistics skeleton update rejected');
            }));
        },
        /**
         * Publishes the original world-relative target origin and fits its real aggregate box.
         *
         * @param {object} lib - Original Java namespace.
         * @param {number} id - Original character identity.
         * @param {...number|boolean} transform - Original XYZ, quaternion and mode arguments.
         */
        updateBallisticsTarget(lib, id, ...transform) {
            expect(transform.length === 8 && transform.slice(0, 7).every(Number.isFinite), 'Original target transform required');
            ensureBallisticsTarget(id);
            expect(engine._update_ballistics_target(id, ...transform.slice(0, 3)) === 1, 'Actual ballistics aggregate update rejected');
        },
        /**
         * Owns the original separate target box and detached eleven-body controller.
         *
         * @param {object} lib - Original Java namespace.
         * @param {number} id - Original character identity.
         * @returns {number} Original zero added or one already attached result.
         */
        addBallisticsTarget(lib, id) {
            const definitions = ragdollDefinitions();
            const parts = definitions.find((entry) => entry.kind === 'bodyParts');
            const dynamics = definitions.find((entry) => entry.kind === 'bodyDynamics');
            const constraints = definitions.find((entry) => entry.kind === 'constraints');

            expect(parts?.values.length === 110 && dynamics?.values.length === 88 && constraints?.values.length === 220,
                'Complete original ballistics body/constraint definitions required');

            let result;

            floats(new Float32Array(parts.values), (bodyParts) => floats(new Float32Array(dynamics.values), (bodyDynamics) => floats(new Float32Array(constraints.values), (joints) => {
                result = engine._add_ballistics_target(id, bodyParts, bodyDynamics, joints);
                expect(result === 0 || result === 1, 'Actual ballistics target construction rejected');
            })));

            return result;
        },
        /**
         * Detaches the original aggregate target and returns its owner to the reusable pool.
         *
         * @param {object} lib - Original Java namespace.
         * @param {number} id - Original character identity.
         * @returns {number} Original absent or removed result.
         */
        removeBallisticsTarget(lib, id) {
            const result = engine._remove_ballistics_target(id);

            expect(result === 0 || result === 1, 'Actual ballistics target removal rejected');

            return result;
        },
        /**
         * Allocates real off-world body/joint ownership from the original template.
         *
         * @param {object} lib - Original Java namespace.
         * @param {number} id - Original ragdoll identity.
         * @param {...number} transform - Original position/quaternion arguments; native attachment applies the root separately.
         */
        addRagdoll(lib, id, ...transform) {
            expect(transform.length === 7 && transform.every(Number.isFinite)
                && transform.slice(3).some((value) => value !== 0), 'Original finite ragdoll transform required');

            const definitions = ragdollDefinitions();
            const parts = definitions.find((entry) => entry.kind === 'bodyParts');
            const dynamics = definitions.find((entry) => entry.kind === 'bodyDynamics');
            const constraints = definitions.find((entry) => entry.kind === 'constraints');

            expect(parts?.values.length === 110 && dynamics?.values.length === 88 && constraints?.values.length === 220,
                'Complete original ragdoll body/constraint definitions required');
            floats(new Float32Array(parts.values), (bodyParts) => floats(new Float32Array(dynamics.values), (bodyDynamics) => floats(new Float32Array(constraints.values), (joints) => {
                expect(engine._add_ragdoll(id, bodyParts, bodyDynamics, joints, 10) === 1, 'Actual ragdoll body construction rejected');
            })));
        },
        /**
         * Stores the original world-relative ragdoll root transform.
         *
         * @param {object} lib - Original Java namespace.
         * @param {number} id - Original ragdoll identity.
         * @param {...number} transform - Original position/quaternion.
         */
        updateRagdoll(lib, id, ...transform) {
            expect(transform.length === 7 && transform.every(Number.isFinite), 'Original ragdoll root required');
            expect(engine._update_ragdoll_root(id, ...transform) === 1, 'Actual ragdoll root rejected');
        },
        /**
         * Places real bodies through original hierarchy and enabled anchor frames.
         *
         * @param {object} lib - Original Java namespace.
         * @param {number} id - Original ragdoll identity.
         * @param {number} count - Original bone count.
         * @param {Float32Array} values - Original local position/quaternion records.
         */
        updateRagdollSkeletonTransforms(lib, id, count, values) {
            expect(Number.isInteger(count) && count >= 27 && count <= 4_096
                && values instanceof Float32Array && values.length >= count * 7, 'Original skeleton pose required');

            if (engine._ragdoll_simulation_state(id) === -1) {
                return;
            }

            const anchors = ragdollDefinitions().find((entry) => entry.kind === 'anchors');

            expect(anchors && anchors.values.length % 5 === 0, 'Original anchor definitions required');
            floats(new Float32Array(anchors.values), (records) => {
                expect(engine._configure_ragdoll_anchors(id, records, anchors.values.length / 5) === 1,
                    'Actual original anchor construction rejected');
            });
            floats(values.subarray(0, count * 7), (records) => {
                expect(engine._update_ragdoll_pose(id, count, records) === 1, 'Actual original body pose rejected');
            });
        },
        /**
         * Reconstructs original local bones from actual simulated rigid bodies.
         *
         * @param {object} lib - Original Java namespace.
         * @param {number} id - Original ragdoll identity.
         * @param {Float32Array} values - Original bone output buffer.
         * @returns {number} Original bone count or minus one for absent ownership.
         */
        simulateRagdoll(lib, id, values) {
            return readRagdoll(id, values, null);
        },
        /**
         * Reads bones and bodies, then applies the original linear-speed limit.
         *
         * @param {object} lib - Original Java namespace.
         * @param {number} id - Original ragdoll identity.
         * @param {Float32Array} values - Original bone output buffer.
         * @param {Float32Array} bodies - Original rigid-body output buffer.
         * @returns {number} Original bone count or minus one for absent ownership.
         */
        simulateRagdollWithRigidBodyOutput(lib, id, values, bodies) {
            return readRagdoll(id, values, bodies);
        },
        /**
         * Derives original starting impulses from the previous animation pose.
         *
         * @param {object} lib - Original Java namespace.
         * @param {number} id - Original ragdoll identity.
         * @param {number} count - Original bone count.
         * @param {number} seconds - Positive original animation pose interval.
         * @param {Float32Array} values - Original previous local position/quaternion records.
         */
        updateRagdollSkeletonPreviousTransforms(lib, id, count, seconds, values) {
            expect(Number.isInteger(count) && count >= 27 && count <= 4_096
                && values instanceof Float32Array && values.length >= count * 7
                && Number.isFinite(seconds) && seconds > 0, 'Original previous pose and positive interval required');
            floats(values.subarray(0, count * 7), (records) => {
                expect(engine._update_ragdoll_previous_pose(id, count, seconds, records) === 1,
                    'Actual original starting impulses rejected');
            });
        },
        /**
         * Sets the original root local-pose postrotation.
         *
         * @param {object} lib - Original Java namespace.
         * @param {number} id - Original ragdoll identity.
         * @param {...number} rotation - Original quaternion XYZW.
         */
        setRagdollLocalTransformRotation(lib, id, ...rotation) {
            expect(rotation.length === 4 && rotation.every(Number.isFinite), 'Original finite quaternion required');
            expect(engine._set_ragdoll_local_rotation(id, ...rotation) === 1, 'Actual ragdoll local rotation rejected');
        },
        /**
         * Applies the original vehicle-contact tuning to every owned ragdoll body.
         *
         * @param {object} lib - Original Java namespace.
         * @param {number} id - Original ragdoll identity.
         * @param {Float32Array} values - Original eight-float override record.
         * @returns {boolean} Original JNI success result, including an absent identity.
         */
        setRagdollBodyDynamics(lib, id, values) {
            expect(values instanceof Float32Array && values.length === 8, 'Original eight-float dynamics override required');
            floats(values, (record) => {
                expect(engine._set_ragdoll_body_dynamics(id, record) === 1, 'Actual ragdoll dynamics override rejected');
            });

            return true;
        },
        /**
         * Restores the current original per-part definition without waking the bodies.
         *
         * @param {object} lib - Original Java namespace.
         * @param {number} id - Original ragdoll identity.
         * @returns {boolean} Whether the original identity exists.
         */
        resetRagdollBodyDynamics(lib, id) {
            const definition = ragdollDefinitions().find((entry) => entry.kind === 'bodyDynamics');

            expect(definition?.values.length === 88, 'Original per-part dynamics definition required');
            let result;

            floats(new Float32Array(definition.values), (records) => {
                result = engine._reset_ragdoll_body_dynamics(id, records);
                expect(result === 1 || result === 2, 'Actual ragdoll dynamics reset rejected');
            });

            return result === 1;
        },
        /**
         * Accumulates actual body force and its original relative-position torque.
         *
         * @param {object} lib - Original Java namespace.
         * @param {number} id - Original ragdoll identity.
         * @param {number} part - Original body part.
         * @param {Float32Array} values - Force XYZ and relative position XYZ.
         */
        applyForce(lib, id, part, values) {
            expect(values instanceof Float32Array && values.length >= 6, 'Original six-float force record required');
            floats(values.subarray(0, 6), (record) => {
                expect(engine._apply_ragdoll_force(id, part, record, 0) === 1, 'Actual ragdoll force rejected');
            });
        },
        /**
         * Applies the original linear-factor and inertia-scaled body impulse.
         *
         * @param {object} lib - Original Java namespace.
         * @param {number} id - Original ragdoll identity.
         * @param {number} part - Original body part.
         * @param {Float32Array} values - Impulse XYZ and relative position XYZ.
         */
        applyImpulse(lib, id, part, values) {
            expect(values instanceof Float32Array && values.length >= 6, 'Original six-float impulse record required');
            floats(values.subarray(0, 6), (record) => {
                expect(engine._apply_ragdoll_force(id, part, record, 1) === 1, 'Actual ragdoll impulse rejected');
            });
        },
        /**
         * Disables the original joint while preserving its world attachment.
         *
         * @param {object} lib - Original Java namespace.
         * @param {number} id - Original ragdoll identity.
         * @param {number} joint - Original constraint identity.
         */
        detachConstraint(lib, id, joint) {
            expect(engine._detach_ragdoll_constraint(id, joint) === 1, 'Actual ragdoll joint disable rejected');
        },
        /**
         * Attaches or detaches the actual bodies and linked constraints.
         *
         * @param {object} lib - Original Java namespace.
         * @param {number} id - Original ragdoll identity.
         * @param {boolean} active - Original attachment flag.
         */
        setRagdollActive(lib, id, active) {
            expect(engine._set_ragdoll_active(id, active ? 1 : 0) === 1, 'Actual ragdoll activation rejected');
        },
        /**
         * Detaches before releasing owned bodies, motion states and constraints.
         *
         * @param {object} lib - Original Java namespace.
         * @param {number} id - Original ragdoll identity.
         */
        removeRagdoll(lib, id) {
            expect(engine._remove_ragdoll(id) === 1, 'Actual ragdoll removal rejected');
        },
        /**
         * Reads original aggregate activation state, zero for mixed states and minus one for absent ownership.
         *
         * @param {object} lib - Original Java namespace.
         * @param {number} id - Original ragdoll identity.
         * @returns {number} Actual aggregate body activation state.
         */
        getRagdollSimulationState(lib, id) {
            return engine._ragdoll_simulation_state(id);
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

            const constraintCount = engine._vehicle_constraint_count();

            expect(constraintCount >= 0, 'Actual constraint owner missing');

            if (constraintCount > 0) {
                const feedbackPointer = engine._malloc(constraintCount * 4 * 8);
                let feedback;

                try {
                    expect(feedbackPointer !== 0, 'Actual constraint feedback allocation failed');

                    const count = engine._vehicle_constraint_feedback(feedbackPointer, constraintCount);

                    expect(count >= 0 && count <= constraintCount, 'Actual constraint feedback extent');
                    feedback = Array.from(engine.HEAPF64.subarray(feedbackPointer / 8, feedbackPointer / 8 + count * 4));
                } finally {
                    engine._free(feedbackPointer);
                }

                const Bullet = await lib.zombie.core.physics.Bullet;

                for (let offset = 0; offset < feedback.length; offset += 4) {
                    // eslint-disable-next-line no-await-in-loop -- Original positive feedback reaches Java in constraint identity order.
                    await Bullet.onVehicleConstraintImpulse(...feedback.slice(offset, offset + 4));
                }
            }

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
