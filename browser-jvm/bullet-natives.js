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
 * Orders coordinate keys by the native reference's Java string ordering.
 *
 * @param {string} left - First key.
 * @param {string} right - Second key.
 * @returns {number} Comparison sign.
 */
function compareKeys(left, right) {
    if (left === right) {
        return 0;
    }

    return left < right ? -1 : 1;
}

/**
 * Checks one actual chunk record and its identity shared between maps.
 *
 * @param {object} engine - Initialized WASM module.
 * @param {number} id - Player map identifier.
 * @param {number} x - Actual chunk X.
 * @param {number} y - Actual chunk Y.
 * @param {number} output - Owned scratch pointer.
 * @param {Map<string, number>} identities - Observed coordinate/pointer identities.
 * @returns {Array<number>} Actual coordinates and player ownership mask.
 */
function readChunk(engine, id, x, y, output, identities) {
    const pointer = engine._map_chunk(id, x, y, output);
    const [wx, wy, mask, min, max, records, nonzero, parent] = Array.from(engine.HEAP32.subarray(output / 4, output / 4 + 8));

    if (!pointer || wx !== x || wy !== y || !(mask & (1 << id)) || min !== 0 || max !== 0 || records !== 1 || nonzero !== 0 || parent !== 1) {
        throw new Error('Actual initial chunk/record storage');
    }

    const key = `${wx},${wy}`;

    if (identities.has(key) && identities.get(key) !== pointer) {
        throw new Error('Actual shared chunk identity');
    }

    identities.set(key, pointer);

    return [wx, wy, mask];
}

/**
 * Copies real map ownership and initialized geometry records from the WASM core.
 *
 * @param {object} engine - Initialized double-precision engine.
 * @param {Array<number|boolean>|null} world - Original initialized header, or null.
 * @returns {object} Detached world header, map and chunk observations.
 */
function readMaps(engine, world) {
    const output = engine._malloc(64);
    const maps = [];
    const chunks = new Map();
    const identities = new Map();
    let references = 0;

    try {
        for (let player = 0; player < 4; player++) {
            if (engine._map_info(player, output) !== 1) {
                continue;
            }

            const [id, x, y, width, clipMin, clipMax] = Array.from(engine.HEAP32.subarray(output / 4, output / 4 + 6));

            if (clipMin !== Math.max(Math.trunc(width / 2) - 1, 0) || clipMax !== Math.min(Math.trunc(width / 2) + 1, width)) {
                throw new Error('Actual clip range');
            }

            maps.push([id, x, y, width]);

            for (let dx = 0; dx < width; dx++) {
                for (let dy = 0; dy < width; dy++) {
                    const row = readChunk(engine, id, x + dx, y + dy, output, identities);

                    chunks.set(`${row[0]},${row[1]}`, row);
                    references++;
                }
            }
        }

        let header = null;

        // Legacy shape-only initialization does not allocate mapped-header storage.
        if (world && world[4] === world[0] * 256 && world[5] === world[1] * 256
            && engine._world_header(output) === 1) {
            header = Array.from(engine.HEAP32.subarray(output / 4, output / 4 + 6));
        }

        return { header, maps, chunks: Array.from(chunks).sort(([left], [right]) => compareKeys(left, right)).map(([,row]) => row), distinct: chunks.size, shared: references - chunks.size };
    } finally {
        engine._free(output);
    }
}

/**
 * Creates the explicitly selected real Bullet mesh/empty-world JNI component.
 * PZ's embedded upstream revision and dynamic simulation remain unqualified.
 *
 * @param {object} engine - Actual initialized double-precision WASM module.
 * @param {object} [options] - Explicit engine profile capabilities.
 * @param {boolean} [options.registeredStaticMeshes] - Require actual shared registered-mesh consumers.
 * @returns {object} Original JNI callbacks and detached diagnostic snapshots.
 */
export function createBulletNatives(engine, { registeredStaticMeshes = false } = {}) {
    if (registeredStaticMeshes && ['_bind_static_mesh', '_has_static_mesh', '_registered_mesh_references'].some((name) => typeof engine[name] !== 'function')) {
        throw new Error('Actual registered-mesh consumer engine exports are required');
    }

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
        if (registeredStaticMeshes && engine._registered_mesh_references(0) !== 0) {
            throw new Error('Registered Bullet meshes still have actual chunk or body consumers');
        }

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
            const legacy = [0, 0, 0, 0, 1, 1, false];
            const isLegacy = values.length === legacy.length && values.every((value, index) => value === legacy[index]);

            if (world || values.length !== 7 || values[6] !== false
                || !values.slice(0, 6).every((value) => Number.isInteger(value) && value >= -2_147_483_648 && value <= 2_147_483_647)) {
                throw new Error('Unqualified Bullet world header');
            }

            const pointer = engine._malloc(24);

            try {
                engine.HEAP32.set(values.slice(0, 6), pointer / 4);

                if ((isLegacy ? engine._create_world() : engine._create_mapped_world(pointer)) !== 1) {
                    throw new Error('Unqualified Bullet world header or Dynamics creation failure');
                }
            } finally {
                engine._free(pointer);
            }

            world = values.slice();
        },
        /**
         * Allocates initial chunk records and shares actual overlapping chunk ownership.
         *
         * @param {object} lib - Original Java namespace.
         * @param {number} id - Player map index, zero through three.
         * @param {number} x - Actual minimum chunk X.
         * @param {number} y - Actual minimum chunk Y.
         * @param {number} width - Qualified original thirteen-chunk width.
         */
        activateChunkMap(lib, id, x, y, width) {
            requireWorld();

            if (world[4] !== world[0] * 256 || world[5] !== world[1] * 256
                || ![id, x, y, width].every((value) => Number.isInteger(value) && value >= -2_147_483_648 && value <= 2_147_483_647)
                || engine._activate_map(id, x, y, width) !== 1) {
                throw new Error('Unsupported initial chunk-map activation');
            }
        },
        /**
         * Releases this player's actual chunk references, preserving other owners.
         *
         * @param {object} lib - Original Java namespace.
         * @param {number} id - Player map index, zero through three.
         */
        deactivateChunkMap(lib, id) {
            requireWorld();

            if (!Number.isInteger(id) || engine._deactivate_map(id) !== 1) {
                throw new Error('Unsupported chunk-map deactivation');
            }
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

                if (registeredStaticMeshes && engine._bind_static_mesh(index, handle) !== 1) {
                    throw new Error('Actual Bullet mesh registry binding failed');
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
            if (!registeredStaticMeshes) {
                clearMeshes();
            }

            if (world) {
                if (engine._destroy_mapped_world() !== 1) {
                    throw new Error('Actual Bullet Dynamics destruction failed');
                }

                if (registeredStaticMeshes) {
                    clearMeshes();
                }

                world = null;
            } else if (registeredStaticMeshes) {
                clearMeshes();
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
                    ...readMaps(engine, world),
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
