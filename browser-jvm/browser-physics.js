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
    const chunks = new Map();
    const maps = new Map();
    const collision = new Map();
    const populationChunks = new Set();
    const clippers = [];
    let clipperAllocations = 0;
    let clipperClears = 0;
    let world = null;
    let revision = 0;

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
            collision: [...collision].map(([square, flags]) => ({ square, flags })),
            populationChunks: [...populationChunks],
            clipperContainers: { allocations: clipperAllocations, clears: clipperClears },
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
        initialize, setLevels, submit, snapshot, setCollisionChunk, setCollisionSquares, collisionAt,
        natives: {
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
                world = null;
                revision++;
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
             * Polygon operations remain unavailable until implemented and qualified.
             *
             * @param {unknown} lib - Reserved CheerpJ library context.
             * @param {object} receiver - Original Clipper instance supplied by the JVM.
             */
            async Java_zombie_vehicles_Clipper_newInstance(lib, receiver) {
                await Promise.resolve();

                if (!receiver || await findClipper(receiver)) {
                    throw new Error('Invalid or duplicate Clipper allocation');
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

                state.paths.length = 0;
                state.polygons.length = 0;
                clipperClears++;
            },
        },
    };
}
