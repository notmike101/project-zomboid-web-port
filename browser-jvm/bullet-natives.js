/**
 * Delivers argument failures through real Java exceptions so original finally blocks run.
 *
 * @param {object} lib - Actual CheerpJ Java namespace.
 * @param {Error} error - Rejected input or unsupported operation.
 * @returns {Promise<never>} Throws the corresponding Java exception.
 */
async function throwJavaFailure(lib, error) {
    const Exception = await lib.java.lang.IllegalArgumentException;

    throw await new Exception(error.message);
}

/**
 * Serializes the native's 35 Java name/ordinal round trips into its calling JVM.
 *
 * @param {object} SkeletonBone - Original Java enum class proxy.
 * @returns {Promise<Array<string>>} Validated original bone names.
 */
async function validateBoneNames(SkeletonBone) {
    const names = [];

    /**
     * Validates the next bounded enum entry without concurrent Java proxy calls.
     *
     * @param {number} index - Next original enum ordinal.
     * @returns {Promise<void>} Completion of all remaining original entries.
     */
    async function next(index) {
        if (index === 35) {
            return;
        }

        const name = String(await SkeletonBone.getBoneName(index));

        if (await SkeletonBone.getBoneOrdinal(name) !== index) {
            throw new Error(`SkeletonBone ordinal mismatch at ${index}`);
        }

        names.push(name);
        await next(index + 1);
    }

    await next(0);

    return names;
}

/**
 * Reads one actual hull's retained double vectors through the real core API.
 *
 * @param {object} engine - Initialized WASM module.
 * @param {number} handle - Owned mesh handle.
 * @param {number} child - Compound child or sole hull index.
 * @param {number} pointer - Caller-owned output scratch storage.
 * @returns {Array<number>} Flattened actual XYZ point coordinates.
 */
function readHullPoints(engine, handle, child, pointer) {
    const points = [];

    for (let point = 0; point < engine._point_count(handle, child); point++) {
        if (engine._get_point(handle, child, point, pointer) !== 1) {
            throw new Error('Actual Bullet point query failed');
        }

        points.push(...engine.HEAPF64.subarray(pointer / 8, pointer / 8 + 3));
    }

    return points;
}

/**
 * Creates the explicitly selected real Bullet mesh/empty-world JNI component.
 * PZ's embedded upstream revision and dynamic simulation remain unqualified.
 *
 * @param {object} engine - Actual initialized double-precision WASM module.
 * @returns {object} Original JNI callbacks and detached diagnostic snapshots.
 */
export function createBulletNatives(engine) {
    if (engine._scalar_bytes() !== 8) {
        throw new Error('Bullet requires the qualified double-precision core');
    }

    const meshes = new Map();
    let world = null;
    let bootstrap = null;

    /** Requires an actual initialized owned native world. */
    function requireWorld() {
        if (!world) {
            throw new Error('Bullet world is not initialized');
        }
    }

    /** Destroys every owned shape, including compound children. */
    function clearMeshes() {
        for (const handle of meshes.values()) {
            if (engine._clear_mesh(handle) !== 1) {
                throw new Error('Actual Bullet shape destruction failed');
            }
        }

        meshes.clear();
    }

    const methods = {
        /**
         * Binds real Java callbacks and validates the original native enum ABI.
         *
         * @param {object} lib - Actual Java namespace retained for native callbacks.
         * @returns {Promise<void>} Completion of original Java enum validation.
         */
        async initPZBullet(lib) {
            if (bootstrap) {
                return;
            }

            const DebugLog = await lib.zombie.debug.DebugLog;
            const SkeletonBone = await lib.zombie.core.skinnedmodel.model.SkeletonBone;

            // Native 0x180033a70 enumerates 0..34; 0x180033d30 round-trips Java names.
            if (await SkeletonBone.count() !== 35) {
                throw new Error('Unqualified SkeletonBone ABI count');
            }

            const names = await validateBoneNames(SkeletonBone);

            await DebugLog.nativeLog('PZBullet', 'Debug', 'Browser Bullet host validated 35 original SkeletonBone ordinals; candidate core 3.25, double precision.');
            bootstrap = { lib, DebugLog, SkeletonBone, names };
        },
        /**
         * Creates the qualified real empty Dynamics world and stores its original header.
         *
         * @param {object} lib - Original Java namespace.
         * @param {...unknown} values - Actual original six integers and server flag.
         */
        initWorld(lib, ...values) {
            const header = [0, 0, 0, 0, 1, 1, false];

            if (world || values.length !== header.length || values.some((value, index) => value !== header[index])) {
                throw new Error('Unqualified Bullet world header');
            }

            if (engine._create_world() !== 1) {
                throw new Error('Actual Bullet Dynamics world creation failed');
            }

            world = values.slice();
        },
        /**
         * Queries actual engine lifecycle state rather than a Java readiness flag.
         *
         * @returns {boolean} Whether the actual Dynamics world exists.
         */
        isWorldInit() {
            const pointer = engine._malloc(48);

            try {
                return engine._world_state(pointer) === 1;
            } finally {
                engine._free(pointer);
            }
        },
        /**
         * Sends original float-array storage into real Bullet hull construction.
         *
         * @param {object} lib - Original Java namespace.
         * @param {number} index - Original shape registry index.
         * @param {boolean} compound - Whether several hulls belong to this index.
         * @param {Float32Array} values - Actual original Java float-array storage.
         */
        definePhysicsMesh(lib, index, compound, values) {
            requireWorld();

            if (!Number.isInteger(index) || index < 0 || index > 10_000 || !(values instanceof Float32Array)
                || values.length === 0 || values.length % 3 !== 0 || values.length > 30_000 || !values.every(Number.isFinite)) {
                throw new Error('Invalid original Bullet mesh input');
            }

            if (meshes.has(index) && !compound) {
                throw new Error('Replacing an owned single Bullet mesh is unqualified');
            }

            const pointer = engine._malloc(values.byteLength);
            let handle = meshes.get(index);
            let created = false;

            try {
                engine.HEAPF32.set(values, pointer / 4);

                if (!handle) {
                    handle = engine._create_mesh(Number(compound));
                    created = true;
                }

                if (engine._add_hull(handle, pointer, values.length / 3) !== 1) {
                    throw new Error('Actual Bullet hull registration failed');
                }

                meshes.set(index, handle);
            } catch (error) {
                if (created) {
                    engine._clear_mesh(handle);
                }

                throw error;
            } finally {
                engine._free(pointer);
            }
        },
        /** Destroys the actual registered mesh shapes and their owned children. */
        clearPhysicsMeshes() {
            requireWorld();
            clearMeshes();
        },
        /** Destroys owned shapes and the actual empty Dynamics world. */
        destroyWorld() {
            clearMeshes();

            if (world) {
                if (engine._destroy_world() !== 1) {
                    throw new Error('Actual Bullet Dynamics destruction failed');
                }

                world = null;
            }
        },
    };

    const natives = Object.fromEntries(Object.entries(methods).map(([name, method]) => [
        `Java_zombie_core_physics_Bullet_${name}`,
        (lib, ...args) => {
            try {
                return Promise.resolve(method(lib, ...args)).catch((error) => throwJavaFailure(lib, error));
            } catch (error) {
                return throwJavaFailure(lib, error);
            }
        },
    ]));

    return {
        natives,
        /**
         * Copies actual engine results without exposing mutable native ownership.
         *
         * @returns {object} Bootstrap, world and mesh diagnostics.
         */
        snapshot() {
            const pointer = engine._malloc(48);

            try {
                const shapes = [];

                for (const [index, handle] of meshes) {
                    if (engine._get_aabb(handle, pointer) !== 1) {
                        throw new Error('Actual Bullet AABB query failed');
                    }

                    const aabb = Array.from(engine.HEAPF64.subarray(pointer / 8, pointer / 8 + 6));
                    const children = engine._child_count(handle);
                    const points = [];

                    for (let child = 0; child < children; child++) {
                        points.push(readHullPoints(engine, handle, child, pointer));
                    }

                    shapes.push({ index, children, aabb, points });
                }

                const ready = engine._world_state(pointer) === 1;

                return {
                    bootstrap: bootstrap ? { validatedBones: bootstrap.names.slice(), callbackStored: true } : null,
                    world: world?.slice() ?? null, dynamics: ready ? Array.from(engine.HEAPF64.subarray(pointer / 8, pointer / 8 + 5)) : null,
                    meshes: shapes, liveMeshes: engine._live_meshes(), scalarBytes: engine._scalar_bytes(),
                };
            } finally {
                engine._free(pointer);
            }
        },
    };
}
