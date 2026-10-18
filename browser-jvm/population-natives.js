import { NativeMT, collision, generate } from './population-kernel.js';

import { decodeCell, encodeCell, decodeIDs, encodeIDs, decodeEmptyVirtual, encodeEmptyVirtual, encodeCollision, remapOutfit } from './population-save-codec.js';

/**
 * Reads an actual Java integer array through the qualified transport.
 *
 * @param {object} lib - Actual CheerpJ Java class namespace.
 * @param {object} array - Caller-owned original Java array.
 * @returns {Promise<Array<number>>} Actual original array contents.
 */
const ints = async (lib, array) => String(await (await helper(lib)).integers(array)).split(',').filter(Boolean).map(Number);

/**
 * Runs Java transport operations in original order without concurrent proxy calls.
 *
 * @param {Array<unknown>} items - Already validated original operations.
 * @param {function(unknown, number): Promise<unknown>} visit - One ordered operation.
 * @param {number} index - Next operation index.
 * @returns {Promise<void>} Completion of the complete ordered batch.
 */
async function sequence(items, visit, index = 0) {
    if (index === items.length) {
        return;
    }

    await visit(items[index], index);

    return sequence(items, visit, index + 1);
}

/**
 * Resolves the authored Java buffer and owned-file transport class.
 *
 * @param {object} lib - Actual CheerpJ Java class namespace.
 * @returns {Promise<object>} Actual authored Java transport class.
 */
const helper = async (lib) => await lib.port.host.PopulationBuffers;

/**
 * Forms the cell key without truncating negative coordinates.
 *
 * @param {number} x - Global x coordinate in the caller API units.
 * @param {number} y - Global y coordinate in the caller API units.
 * @returns {string} Stable global cell key.
 */
const key = (x, y) => `${x},${y}`;

/**
 * Rejects simulation times outside the qualified initial-age interval.
 *
 * @param {number} multiplier - Actual original time multiplier.
 * @param {number} age - Actual original world age in hours.
 */
function validateTime(multiplier, age) {
    finite(multiplier, 'multiplier');
    finite(age, 'age');

    if (multiplier < 0 || age < 0 || age > 2) {
        unsupported(`time outside qualified initial-age kernel: multiplier=${multiplier},age=${age}`);
    }
}

/**
 * Encodes transport bytes as lossless lowercase hexadecimal.
 *
 * @param {Uint8Array} bytes - Original wire or transport bytes.
 * @returns {string} Lossless lowercase hexadecimal.
 */
const hex = (bytes) => Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');

/**
 * Decodes the Java transport hexadecimal into bytes.
 *
 * @param {string} hex - Lossless Java transport hexadecimal.
 * @returns {Uint8Array} Decoded transport bytes.
 */
const decoder = (hex) => Uint8Array.from(String(hex).match(/../g) ?? [], (value) => Number.parseInt(value, 16));

/**
 * Adds the little-endian scalar readers used by the recovered native kernel.
 *
 * @param {Uint8Array} bytes - Original wire or transport bytes.
 * @returns {Uint8Array} Bytes with recovered native scalar readers.
 */
function binary(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    /**
     * Reads one original little-endian unsigned configuration word.
     *
     * @param {number} offset - Original byte offset.
     * @returns {number} Original unsigned word.
     */
    bytes.readUInt32LE = (offset) => view.getUint32(offset, true);
    /**
     * Reads one original big-endian wire tag.
     *
     * @param {number} offset - Original byte offset.
     * @returns {number} Original unsigned tag.
     */
    bytes.readUInt16BE = (offset) => view.getUint16(offset, false);
    /**
     * Reads one original little-endian configuration float.
     *
     * @param {number} offset - Original byte offset.
     * @returns {number} Original configuration float.
     */
    bytes.readFloatLE = (offset) => view.getFloat32(offset, true);

    return bytes;
}

/**
 * Encodes the original 33-byte Java publication record layout.
 *
 * @param {Array<object>} records - Original publication records in their existing order.
 * @returns {string} Original big-endian publication bytes as hexadecimal.
 */
function encoded(records) {
    const bytes = new Uint8Array(records.length * 33);
    const view = new DataView(bytes.buffer);

    for (const [i, r] of records.entries()) {
        const offset = i * 33;

        view.setFloat32(offset, r.x);
        view.setFloat32(offset + 4, r.y);
        view.setFloat32(offset + 8, r.z);
        view.setInt8(offset + 12, r.direction);

        for (const [j, key] of ['outfit', 'state', 'px', 'py', 'id'].entries()) {
            view.setInt32(offset + 13 + j * 4, r[key]);
        }
    }

    return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

/**
 * Rejects an input outside the source-qualified population closure.
 *
 * @param {string} message - Concrete unsupported platform boundary.
 * @returns {never} Always rejects this unsupported boundary.
 */
const unsupported = (message) => {
    throw new RangeError(`Unsupported population boundary: ${message}`);
};

/**
 * Validates an integer before changing owned population state.
 *
 * @param {number} value - Original scalar value.
 * @param {string} label - Original field name included in validation failures.
 * @returns {number} Validated original integer.
 */
const integer = (value, label) => {
    if (!Number.isInteger(value)) {
        unsupported(label);
    }

    return value;
};

/**
 * Rejects nonfinite coordinates or configuration before mutation.
 *
 * @param {number} value - Original scalar value.
 * @param {string} label - Original field name included in validation failures.
 * @returns {number} Validated original finite value.
 */
const finite = (value, label) => {
    if (!Number.isFinite(value)) {
        unsupported(label);
    }

    return value;
};

/**
 * Creates one owned source-derived population and collision JNI service.
 *
 * @returns {object} Owned JNI callbacks and read-only diagnostics.
 */
export function createPopulationNatives() {
    const state = {
        grid: null,
        mcd: false,
        pop: false,
        cells: new Map(),
        metadata: new Map(),
        gameState: new Map(),
        producer: [],
        worker: [],
        collisionProducer: [],
        collisionWorker: [],
        pendingOutput: [],
        front: [],
        consumed: new Set(),
        registry: new Map(),
        radar: { ready: false },
        nextID: 1,
        areas: [],
        time: null,
        workerTime: null,
        config: new Map(),
        outfits: [],
        trace: [],
        updates: 0,
    };

    let lock = Promise.resolve();
    let rng;

    /**
     * Initializes the native MT algorithm from actual browser crypto entropy.
     */
    const resetRng = () => {
        rng = NativeMT.fromSeed(crypto.getRandomValues(new Uint32Array(1))[0]);
        state.seedSource = 'crypto';
    };

    resetRng();

    /**
     * Requires original metadata initialization before cell access.
     */
    function requireGrid() {
        if (!state.grid) {
            unsupported('metadata not initialized');
        }
    }

    /**
     * Checks global cell coordinates against the actual initialized bounds.
     *
     * @param {number} x - Global x coordinate in the caller API units.
     * @param {number} y - Global y coordinate in the caller API units.
     * @returns {boolean} Whether the real cell lies inside the initialized world.
     */
    function inGrid(x, y) {
        requireGrid();
        const [mx, my, w, h] = state.grid;

        return x >= mx && y >= my && x < mx + w && y < my + h;
    }

    /**
     * Lazily allocates native-equivalent density and source state for one real cell.
     *
     * @param {number} x - Global x coordinate in the caller API units.
     * @param {number} y - Global y coordinate in the caller API units.
     * @returns {object} Owned lazy metadata cell.
     */
    function metadata(x, y) {
        if (!inGrid(x, y)) {
            unsupported('cell outside initialized bounds');
        }

        const name = key(x, y);

        if (!state.metadata.has(name)) {
            state.metadata.set(name, { density: new Uint8Array(1_024), filenames: [], collision: null, registered: new Set() });
        }

        return state.metadata.get(name);
    }

    /**
     * Enumerates real cells touched by the original loaded-area rectangles.
     *
     * @param {Array<number>} areas - Original packed x, y, width, height rectangles.
     * @returns {Array<Array<number>>} Ordered cell coordinates and their source rectangle.
     */
    function areaCells(areas) {
        const result = [];

        for (let i = 0; i < areas.length; i += 4) {
            const [x, y, w, h] = areas.slice(i, i + 4);

            for (let cy = Math.trunc(y / 32); cy <= Math.trunc((y + h - 1) / 32); cy++) {
                for (let cx = Math.trunc(x / 32); cx <= Math.trunc((x + w - 1) / 32); cx++) {
                    if (inGrid(cx, cy)) {
                        result.push([cx, cy, x, y, w, h]);
                    }
                }
            }
        }

        return result;
    }

    /**
     * Loads owned collision persistence or the qualified original source before use.
     *
     * @param {object} lib - Actual CheerpJ Java class namespace.
     * @param {number} x - Global x coordinate in the caller API units.
     * @param {number} y - Global y coordinate in the caller API units.
     * @returns {Promise<Array<Uint8Array>>} Owned decoded collision state.
     */
    async function cellCollision(lib, x, y) {
        const data = metadata(x, y);

        if (!data.collision) {
            const saved = state.pop ? String(await (await helper(lib)).readOwned(`chunkdata/chunkdata_${x}_${y}.bin`)) : '';

            if (!saved && data.filenames.length > 1) {
                unsupported('ordered collision layers decode not yet qualified');
            }

            if (saved) {
                data.collision = collision(binary(decoder(saved)));
            } else if (data.filenames.length) {
                const transport = await helper(lib);
                const bytes = await transport.fileHex(data.filenames[0]);

                data.collision = collision(binary(decoder(bytes)));
            } else {
                data.collision = Array.from({ length: 1_024 }, () => new Uint8Array(64));
            }

            data.sourceLoaded = Boolean(saved || data.filenames.length);
        }

        return data.collision;
    }

    /**
     * Resolves the collision cells that original spawn exclusions can query.
     * Neighbor loading does not create population cells or consume random values.
     *
     * @param {object} lib - Actual CheerpJ Java transport namespace.
     * @param {number} x - Population cell x coordinate.
     * @param {number} y - Population cell y coordinate.
     * @returns {Promise<Map<string, Array<Uint8Array>>>} Original decoded neighboring collision chunks.
     */
    async function collisionNeighborhood(lib, x, y) {
        const coordinates = [];
        const neighbors = new Map();

        for (let ny = y - 1; ny <= y + 1; ny++) {
            for (let nx = x - 1; nx <= x + 1; nx++) {
                if (inGrid(nx, ny)) {
                    coordinates.push([nx, ny]);
                }
            }
        }

        await sequence(coordinates, async ([nx, ny]) => {
            neighbors.set(key(nx, ny), await cellCollision(lib, nx, ny));
        });

        return neighbors;
    }

    const floatKeys = ['PopulationMultiplier', 'PopulationStartMultiplier', 'PopulationPeakMultiplier', 'RespawnHours', 'RespawnUnseenHours', 'RespawnMultiplier', 'RedistributeHours', 'MinZombiesPerChunk', 'MaxZombiesPerChunk', 'UniformZombiesPerChunk'];

    const intKeys = ['PopulationPeakDay', 'FollowSoundDistance'];

    /**
     * Packs the original population configuration structure for the native kernel.
     *
     * @param {Map<string, number>} configMap - Original worker configuration snapshot.
     * @returns {Uint8Array} Original native configuration layout.
     */
    function configBytes(configMap = state.config) {
        const bytes = new Uint8Array(44);
        const view = new DataView(bytes.buffer);
        const order = ['PopulationMultiplier', 'PopulationStartMultiplier', 'PopulationPeakMultiplier', 'PopulationPeakDay', 'RespawnHours', 'RespawnUnseenHours', 'RespawnMultiplier', 'FollowSoundDistance', 'MinZombiesPerChunk', 'MaxZombiesPerChunk', 'UniformZombiesPerChunk'];

        for (const [i, element] of order.entries()) {
            const value = configMap.get(element);

            if (value === undefined) {
                unsupported(`missing actual configuration ${element}`);
            }

            if (i === 3 || i === 7) {
                view.setInt32(i * 4, value, true);
            } else {
                view.setFloat32(i * 4, value, true);
            }
        }

        return binary(bytes);
    }

    const constants = binary(new Uint8Array(256));

    for (const [address, value] of [[0xF_A1_D8, 24], [0xF_A2_60, 0.5], [0xF_A2_64, 1], [0xF_A2_68, 100], [0xF_A2_6C, 255]]) {
        new DataView(constants.buffer).setFloat32(address - 0xF_A1_D8, value, true);
    }

    /**
     * Restores or generates initial cell state only inside the qualified algorithm boundary.
     *
     * @param {object} lib - Actual CheerpJ Java class namespace.
     * @param {number} cx - Original chunk x coordinate.
     * @param {number} cy - Original chunk y coordinate.
     * @returns {Promise<object>} Restored or naturally generated initial cell.
     */
    async function ensureCell(lib, cx, cy) {
        const x = Math.floor(cx / 32);
        const y = Math.floor(cy / 32);
        const name = key(x, y);

        if (state.cells.has(name)) {
            return state.cells.get(name);
        }

        if (!state.workerTime) {
            unsupported('worker time absent');
        }

        const data = metadata(x, y);
        const saved = String(await (await helper(lib)).readOwned(`zpop/zpop_${x}_${y}.bin`));

        if (saved) {
            const parsed = decodeCell(decoder(saved));
            const cell = {
                chunks: parsed.chunks.map((chunk) => chunk.records.map((record) => ({ ...record, outfit: remapOutfit(record.outfit, parsed.names, state.outfits), px: -2_147_483_648, py: -2_147_483_648 }))),
                loaded: new Set(),
                lastSeen: Float32Array.from(parsed.chunks, (chunk) => chunk.scalars[0]),
                lastRedistribution: parsed.scalars[1],
                createdAge: parsed.scalars[0],
                targets: Uint16Array.from(parsed.chunks, (chunk) => chunk.intensity),
                lastRespawn: Float32Array.from(parsed.chunks, (chunk) => chunk.scalars[1]),
                wire: parsed,
            };

            for (const record of cell.chunks.flat()) {
                if (record.id) {
                    state.nextID = Math.max(state.nextID, record.id + 1);
                }
            }

            state.cells.set(name, cell);

            return cell;
        }

        if (state.gameState.get('SandboxOptions.Distribution') === 2) {
            unsupported('uniform distribution target branch not qualified');
        }

        const chunks = await cellCollision(lib, x, y);
        const neighbors = await collisionNeighborhood(lib, x, y);
        /**
         * Reads the same global square flags as the original lazy collision grid.
         *
         * @param {number} sx - Global square x coordinate.
         * @param {number} sy - Global square y coordinate.
         * @returns {number} Original square collision bits, or outside-grid solidity.
         */
        const globalFlags = (sx, sy) => {
            const cx = Math.floor(sx / 256);
            const cy = Math.floor(sy / 256);

            if (!inGrid(cx, cy)) {
                return 1;
            }

            const neighbor = neighbors.get(key(cx, cy));

            if (!neighbor) {
                unsupported('unprepared global collision neighbor');
            }

            const lx = sx - cx * 256;
            const ly = sy - cy * 256;

            return neighbor[(ly >> 3) * 32 + (lx >> 3)][(ly & 7) * 8 + (lx & 7)];
        };

        const config = configBytes();
        const result = generate({
            globalFlags,
            cellX: x,
            cellY: y,
            rng,
            density: data.density,
            chunks,
            config,
            constants,
            directions: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
            idStart: state.nextID,
            age: state.workerTime[1],
        });

        state.nextID += result.generated;
        const cell = {
            chunks: Array.from({ length: 1_024 }, () => []),
            loaded: new Set(),
            lastSeen: new Float32Array(1_024),
            lastRedistribution: Math.fround(state.workerTime[1]),
            createdAge: Math.fround(state.workerTime[1]),
            targets: new Uint16Array(1_024),
            lastRespawn: new Float32Array(1_024).fill(Math.fround(state.workerTime[1])),
        };

        for (const entry of result.entries) {
            cell.chunks[entry.index] = entry.records;
            cell.targets[entry.index] = entry.target;
        }

        state.cells.set(name, cell);

        return cell;
    }

    /**
     * Rejects unqualified new generation before a worker batch changes game state.
     *
     * @param {object} lib - Actual CheerpJ Java namespace.
     * @param {Array<number>} coordinates - Original chunk x and y coordinates.
     * @returns {Promise<void>} Completion after real saved-state or generation validation.
     */
    async function validateGeneration(lib, coordinates) {
        const [cx, cy] = coordinates;
        const x = Math.floor(cx / 32);
        const y = Math.floor(cy / 32);
        const name = key(x, y);

        if (state.cells.has(name)) {
            return;
        }

        const uniform = state.gameState.get('SandboxOptions.Distribution') === 2;

        if (!uniform) {
            await collisionNeighborhood(lib, x, y);

            return;
        }

        const transport = await helper(lib);
        const saved = String(await transport.readOwned(`zpop/zpop_${x}_${y}.bin`));

        if (saved) {
            decodeCell(decoder(saved));

            return;
        }

        unsupported('uniform distribution target branch not qualified');
    }

    const collisionService = {
        /**
         * Initializes sparse metadata bounds after size and lifecycle validation.
         *
         * @param {object} lib - Actual CheerpJ Java class namespace.
         * @param {number} x - Global x coordinate in the caller API units.
         * @param {number} y - Global y coordinate in the caller API units.
         * @param {number} w - Actual metadata width or rectangle width.
         * @param {number} h - Actual metadata height or rectangle height.
         */
        initMetaGrid(lib, x, y, w, h) {
            for (const v of [x, y, w, h]) {
                integer(v, 'grid');
            }

            if (w < 1 || h < 1 || !Number.isSafeInteger(w * h) || w * h > 2_147_483_647 || state.mcd || state.pop) {
                unsupported('grid size/lifecycle');
            }

            state.grid = [x, y, w, h];
            state.metadata.clear();
            state.cells.clear();
        },
        /**
         * Registers original collision source order; null sources allocate nothing.
         *
         * @param {object} lib - Actual CheerpJ Java class namespace.
         * @param {number} x - Global x coordinate in the caller API units.
         * @param {number} y - Global y coordinate in the caller API units.
         * @param {string|null} filename - Original collision path, or its genuine null absence.
         */
        initMetaCell(lib, x, y, filename) {
            if (filename === null) {
                state.nullSources = (state.nullSources ?? 0) + 1;

                return;
            }

            if (!inGrid(x, y)) {
                return;
            }

            if (!String(filename).startsWith('/app/') && !String(filename).startsWith('/files/')) {
                unsupported('collision file mount');
            }

            metadata(x, y).filenames.push(String(filename));
        },
        /**
         * Stores one original density byte with a synchronous scalar fast path.
         *
         * @param {object} lib - Actual CheerpJ Java class namespace.
         * @param {number} x - Global x coordinate in the caller API units.
         * @param {number} y - Global y coordinate in the caller API units.
         * @param {number} cx - Original chunk x coordinate.
         * @param {number} cy - Original chunk y coordinate.
         * @param {number} value - Original scalar value.
         */
        initMetaChunk(lib, x, y, cx, cy, value) {
            for (const v of [cx, cy, value]) {
                integer(v, 'metadata chunk');
            }

            if (cx < 0 || cy < 0 || cx > 31 || cy > 31 || value < 0 || value > 255) {
                unsupported('metadata chunk range');
            }

            metadata(x, y).density[cx + cy * 32] = value;
        },
        /**
         * Initializes the original service bounds and owned lifecycle.
         *
         * @param {object} lib - Actual CheerpJ Java class namespace.
         * @param {number} x - Global x coordinate in the caller API units.
         * @param {number} y - Global y coordinate in the caller API units.
         * @param {number} w - Actual metadata width or rectangle width.
         * @param {number} h - Actual metadata height or rectangle height.
         */
        init(lib, x, y, w, h) {
            if (state.mcd || JSON.stringify(state.grid) !== JSON.stringify([x, y, w, h])) {
                unsupported('MCD init lifecycle/bounds');
            }

            state.mcd = true;
        },
        /**
         * Queues a complete original 64-byte collision chunk notification.
         *
         * @param {object} lib - Actual CheerpJ Java class namespace.
         * @param {number} x - Global x coordinate in the caller API units.
         * @param {number} y - Global y coordinate in the caller API units.
         * @param {object} array - Caller-owned original Java array.
         */
        async chunkUpdateTask(lib, x, y, array) {
            integer(x, 'chunk x');
            integer(y, 'chunk y');

            if (!inGrid(Math.floor(x / 32), Math.floor(y / 32))) {
                unsupported('collision chunk bounds');
            }

            const flags = decoder(await (await helper(lib)).byteHex(array));

            if (flags.length !== 64) {
                unsupported('collision byte length');
            }

            (state.collisionNotifications ??= []).push({ x, y, length: flags.length });
            state.collisionProducer.push({ x, y, flags });
        },
        /**
         * Validates and queues original nine-byte square notifications.
         *
         * @param {object} lib - Actual CheerpJ Java class namespace.
         * @param {number} count - Original record or rectangle count.
         * @param {object} buffer - Caller-owned Java direct ByteBuffer.
         */
        async squareUpdateTask(lib, count, buffer) {
            if (!Number.isInteger(count) || count < 0) {
                const E = await lib.java.lang.IllegalArgumentException;

                throw await new E('invalid count');
            }

            const bytes = decoder(await (await helper(lib)).bufferHex(buffer, count * 9));
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const records = [];

            for (let i = 0; i < count; i++) {
                const x = view.getInt32(i * 9);
                const y = view.getInt32(i * 9 + 4);
                const flags = view.getUint8(i * 9 + 8);

                if (!inGrid(Math.floor(x / 256), Math.floor(y / 256))) {
                    unsupported('square outside admitted metadata');
                }

                records.push({ x, y, flags, type: 'square' });
            }

            state.collisionProducer.push(...records);
            (state.squareNotifications ??= []).push({ count });
        },
        /**
         * Publishes the original producer queue to its worker owner.
         *
         * @returns {boolean} Whether original worker data is now available.
         */
        hasDataForThread() {
            if (!state.collisionProducer.length) {
                return false;
            }

            state.collisionWorker.push(state.collisionProducer.splice(0));

            return true;
        },
        /**
         * Applies queued collision notifications through the original ownership boundary.
         *
         * @param {object} lib - Actual CheerpJ Java class namespace.
         */
        async update(lib) {
            if (!state.mcd) {
                unsupported('MCD not initialized');
            }

            const batches = state.collisionWorker.slice();

            await sequence(batches.flat(), (task) => cellCollision(lib, Math.floor(task.x / (task.type === 'square' ? 256 : 32)), Math.floor(task.y / (task.type === 'square' ? 256 : 32))));

            state.collisionWorker.splice(0, batches.length);

            for (const batch of batches) {
                for (const task of batch) {
                    if (task.type !== 'square') {
                        const data = metadata(Math.floor(task.x / 32), Math.floor(task.y / 32));
                        const index = ((task.x % 32 + 32) % 32) + ((task.y % 32 + 32) % 32) * 32;

                        if (data.collision[index].some((value, i) => value !== task.flags[i])) {
                            data.dirty = true;
                        }

                        data.collision[index] = task.flags;
                    }
                }

                for (const task of batch) {
                    if (task.type === 'square') {
                        const cx = Math.floor(task.x / 8);
                        const cy = Math.floor(task.y / 8);
                        const data = metadata(Math.floor(task.x / 256), Math.floor(task.y / 256));

                        const chunk = data.collision[((cx % 32 + 32) % 32) + ((cy % 32 + 32) % 32) * 32];
                        const index = ((task.x % 8 + 8) % 8) + ((task.y % 8 + 8) % 8) * 8;

                        if (chunk[index] !== task.flags) {
                            data.dirty = true;
                        }

                        chunk[index] = task.flags;
                    }
                }
            }
        },
        /**
         * Writes the qualified original collision or population persistence through its Java owner.
         *
         * @param {object} lib - Actual CheerpJ Java class namespace.
         */
        async save(lib) {
            if (!state.mcd || !state.pop || state.gameState.get('Core.noSave')) {
                unsupported('collision save lifecycle/NoSave');
            }

            await sequence([...state.metadata].filter(([, data]) => data.dirty && data.sourceLoaded), async ([name, data]) => {
                const transport = await helper(lib);

                await transport.writeOwned(`chunkdata/chunkdata_${name.replace(',', '_')}.bin`, hex(encodeCollision(data.collision)), false);
                data.dirty = false;
            });
        },
        /**
         * Reports whether the original worker-owned queue is empty.
         *
         * @returns {boolean} Whether no worker batch is pending.
         */
        shouldWait() {
            return state.collisionWorker.length === 0;
        },
        /**
         * Releases owned queues and state at the original service stop boundary.
         */
        stop() {
            state.mcd = false;
            state.collisionProducer = [];
            state.collisionWorker = [];

            if (!state.pop) {
                state.metadata.clear();
                state.cells.clear();
            }
        },

    };

    const populationService = {
        /**
         * Initializes the original service bounds and owned lifecycle.
         *
         * @param {object} lib - Actual CheerpJ Java class namespace.
         * @param {boolean} client - Actual original client role.
         * @param {boolean} server - Actual original server role.
         * @param {number} x - Global x coordinate in the caller API units.
         * @param {number} y - Global y coordinate in the caller API units.
         * @param {number} w - Actual metadata width or rectangle width.
         * @param {number} h - Actual metadata height or rectangle height.
         */
        async init(lib, client, server, x, y, w, h) {
            if (client || server || state.pop || JSON.stringify(state.grid) !== JSON.stringify([x, y, w, h])) {
                unsupported('population role/init/bounds');
            }

            const mode = state.gameState.get('GameWindow.GameModeCacheDir');
            const world = state.gameState.get('Core.GameSaveWorld');

            if (typeof mode !== 'string' || !mode.startsWith('/files/') || typeof world !== 'string' || world.includes('/') || world.includes('\\') || world === '..') {
                unsupported('fresh browser save root required');
            }

            await (await helper(lib)).openOwnedRoot(`${mode}/${world}`);
            const ids = String(await (await helper(lib)).readOwned('zpop/zpop_ids.bin'));
            const virtual = String(await (await helper(lib)).readOwned('zpop/zpop_virtual.bin'));

            if (virtual) {
                decodeEmptyVirtual(decoder(virtual));
            }

            state.reopenID = ids ? decodeIDs(decoder(ids)) : 1;
            state.pop = true;
            state.autoSaveDeadline = performance.now() + 300_000;
            state.config.clear();
            state.nextID = state.reopenID;
            state.producer = [];
            state.worker = [];
            state.front = [];
            state.pendingOutput = [];
            state.consumed.clear();
            state.time = null;
            state.workerTime = null;
        },
        /**
         * Queues a supported original float option without rewriting game settings.
         *
         * @param {object} lib - Actual CheerpJ Java class namespace.
         * @param {string} name - Original native option or callback name.
         * @param {number} value - Original scalar value.
         */
        configFloat(lib, name, value) {
            name = String(name);
            finite(value, 'config float');

            if (!floatKeys.includes(name) || value < 0) {
                unsupported('config float key/range');
            }

            if (['RespawnHours', 'RespawnUnseenHours', 'RespawnMultiplier'].includes(name) && value !== 0) {
                unsupported('respawn/redistribution');
            }

            state.producer.push({ type: 'config', name, value: Math.fround(value) });
        },
        /**
         * Queues a supported original integer option without rewriting game settings.
         *
         * @param {object} lib - Actual CheerpJ Java class namespace.
         * @param {string} name - Original native option or callback name.
         * @param {number} value - Original scalar value.
         */
        configInt(lib, name, value) {
            name = String(name);
            integer(value, 'config int');

            if (!intKeys.includes(name) || value < 0) {
                unsupported('config int key/range');
            }

            state.producer.push({ type: 'config', name, value });
        },
        /**
         * Copies the actual original persistent-outfit dictionary.
         *
         * @param {object} lib - Actual CheerpJ Java class namespace.
         * @param {Array<string>} names - Actual persistent-outfit names in original order.
         */
        async setOutfitNames(lib, names) {
            state.outfits = String(await (await helper(lib)).names(names)).split('\n').filter(Boolean);
        },
        /**
         * Accepts the qualified empty-origin input and rejects unsupported nonempty origins.
         *
         * @param {object} lib - Actual CheerpJ Java class namespace.
         * @param {object} origins - Original Java spawn-origin array.
         */
        async setSpawnOrigins(lib, origins) {
            const values = await ints(lib, origins);

            if (values.length) {
                unsupported('nonempty spawn origins');
            }

            state.origins = [];
        },
        /**
         * Queues actual original loaded-area rectangles after input validation.
         *
         * @param {object} lib - Actual CheerpJ Java class namespace.
         * @param {number} count - Original record or rectangle count.
         * @param {object} array - Caller-owned original Java array.
         * @param {boolean} server - Actual original server role.
         */
        async loadedAreas(lib, count, array, server) {
            integer(count, 'area count');
            const values = await ints(lib, array);

            if (server || count < 0 || values.length < count * 4) {
                unsupported('loaded area bounds/role');
            }

            const areas = values.slice(0, count * 4);

            for (let i = 0; i < areas.length; i += 4) {
                if (areas[i + 2] < 1 || areas[i + 3] < 1) {
                    unsupported('loaded area dimensions');
                }
            }

            state.producer.push({ type: 'areas', areas });
        },
        /**
         * Queues the original chunk visibility transition.
         *
         * @param {object} lib - Actual CheerpJ Java class namespace.
         * @param {number} x - Global x coordinate in the caller API units.
         * @param {number} y - Global y coordinate in the caller API units.
         * @param {boolean} loaded - Original chunk loaded state.
         */
        loadChunk(lib, x, y, loaded) {
            integer(x, 'chunk x');
            integer(y, 'chunk y');

            if (!inGrid(Math.floor(x / 32), Math.floor(y / 32))) {
                unsupported('population chunk outside bounds');
            }

            (state.loadNotifications ??= []).push({ x, y, loaded });
            state.producer.push({ type: 'load', x, y, loaded });
        },
        /**
         * Publishes completed records and queues actual original simulation time.
         *
         * @param {object} lib - Actual CheerpJ Java class namespace.
         * @param {number} multiplier - Actual original time multiplier.
         * @param {number} age - Actual original world age in hours.
         */
        updateMain(lib, multiplier, age) {
            validateTime(multiplier, age);
            state.front = state.pendingOutput.splice(0);

            if (state.front.length) {
                state.lastPublishedIDs = state.front.map((record) => record.id).join(',');
            }

            state.consumed.clear();

            if (!state.time || state.time[0] !== multiplier || state.time[1] !== age) {
                state.producer.push({ type: 'time', multiplier, age });
                state.time = [multiplier, age];
            }
        },
        /**
         * Publishes the original producer queue to its worker owner.
         *
         * @returns {boolean} Whether original worker data is now available.
         */
        hasDataForThread() {
            if (state.producer.length) {
                state.worker.push(...state.producer.splice(0));
            }

            return state.worker.length > 0;
        },
        /**
         * Applies the source-qualified worker batch and rejects unsupported scheduling before mutation.
         *
         * @param {object} lib - Actual CheerpJ Java class namespace.
         */
        async updateThread(lib) {
            if (!state.pop) {
                unsupported('population not initialized');
            }

            if (performance.now() >= state.autoSaveDeadline) {
                unsupported('native automatic-save scheduling not yet qualified');
            }

            const batch = state.worker.slice();

            const nextConfig = new Map(state.config);

            for (const task of batch) {
                if (task.type === 'config') {
                    nextConfig.set(task.name, task.value);
                }
            }

            const nextTime = batch.filter((task) => task.type === 'time').at(-1) ?? (state.workerTime ? { multiplier: state.workerTime[0], age: state.workerTime[1] } : null);

            const interval = nextConfig.get('RedistributeHours');

            if (interval === undefined) {
                unsupported('missing actual RedistributeHours');
            }

            if (nextTime && interval > 0) {
                for (const cell of state.cells.values()) {
                    if (Math.fround(Math.min(cell.lastRedistribution, nextTime.age) + interval) < Math.fround(nextTime.age)) {
                        unsupported('redistribution due: virtual movement not yet ported');
                    }
                }
            }

            const areaTask = batch.filter((task) => task.type === 'areas').at(-1);
            const nextAreas = areaTask ? areaTask.areas : state.areas;

            if (nextAreas.length || batch.some((task) => task.type === 'load' || task.type === 'add')) {
                configBytes(nextConfig);
            }

            const generation = areaCells(nextAreas).map(([cx, cy]) => [cx * 32, cy * 32]);

            for (const task of batch) {
                if (task.type === 'load') {
                    generation.push([task.x, task.y]);
                } else if (task.type === 'add') {
                    generation.push([Math.floor(task.record.x / 8), Math.floor(task.record.y / 8)]);
                }
            }

            if (generation.length && !nextTime) {
                unsupported('worker time absent before generation');
            }

            await sequence(generation, (coordinates) => validateGeneration(lib, coordinates));

            await sequence(areaCells(nextAreas), ([cx, cy]) => cellCollision(lib, cx, cy));
            await sequence(batch.filter((task) => task.type === 'load' || task.type === 'add'), (task) => task.type === 'load'
                ? cellCollision(lib, Math.floor(task.x / 32), Math.floor(task.y / 32))
                : cellCollision(lib, Math.floor(task.record.x / 256), Math.floor(task.record.y / 256)));

            state.worker.splice(0);

            for (const task of batch) {
                if (task.type === 'time') {
                    state.workerTime = [task.multiplier, task.age];
                }
            }

            for (const task of batch) {
                if (task.type === 'config') {
                    state.config.set(task.name, task.value);
                }
            }

            for (const task of batch) {
                if (task.type === 'areas') {
                    state.areas = task.areas;
                }
            }

            /* Original1800218e0 clips seen chunks using the area's first cell,
               even while its generation loop advances to a neighboring cell. */
            await sequence(areaCells(state.areas), async ([cx, cy, x, y, w, h]) => {
                const cell = await ensureCell(lib, cx * 32, cy * 32);

                for (let ty = Math.max(y, Math.trunc(y / 32) * 32); ty < Math.min(y + h - 1, Math.trunc(y / 32) * 32 + 32); ty++) {
                    for (let tx = Math.max(x, Math.trunc(x / 32) * 32); tx < Math.min(x + w - 1, Math.trunc(x / 32) * 32 + 32); tx++) {
                        const lx = tx - cx * 32;
                        const ly = ty - cy * 32;

                        if (lx >= 0 && lx < 32 && ly >= 0 && ly < 32) {
                            cell.lastSeen[lx + ly * 32] = Math.fround(state.workerTime[1]);
                        }
                    }
                }
            });

            await sequence(batch.filter((task) => task.type === 'load'), async (task) => {
                const cell = await ensureCell(lib, task.x, task.y);
                const index = (task.x % 32 + 32) % 32 + ((task.y % 32 + 32) % 32) * 32;

                if (task.loaded) {
                    cell.loaded.add(index);
                    state.pendingOutput.push(...cell.chunks[index].splice(0));
                } else {
                    cell.loaded.delete(index);
                }
            });

            await sequence(batch.filter((task) => task.type === 'add'), async (task) => {
                const r = task.record;
                const cell = await ensureCell(lib, Math.floor(r.x / 8), Math.floor(r.y / 8));
                const index = ((Math.floor(r.x / 8) % 32 + 32) % 32) + ((Math.floor(r.y / 8) % 32 + 32) % 32) * 32;

                cell.chunks[index].push(r);
            });

            for (const task of batch) {
                if (task.type === 'register') {
                    const old = state.registry.get(task.record.id);

                    if (old) {
                        metadata(Math.floor(old.x / 256), Math.floor(old.y / 256)).registered.delete(old.id);
                    }

                    state.registry.set(task.record.id, task.record);
                    metadata(Math.floor(task.record.x / 256), Math.floor(task.record.y / 256)).registered.add(task.record.id);
                }
            }

            for (const task of batch) {
                if (task.type === 'release') {
                    const old = state.registry.get(task.id);

                    if (old) {
                        metadata(Math.floor(old.x / 256), Math.floor(old.y / 256)).registered.delete(old.id);
                        state.registry.delete(task.id);
                    }
                }
            }

            const realTask = batch.filter((task) => task.type === 'real').at(-1);

            if (realTask) {
                for (const value of realTask.records) {
                    const record = state.registry.get(value.id);

                    if (record) {
                        metadata(Math.floor(record.x / 256), Math.floor(record.y / 256)).registered.delete(record.id);
                        Object.assign(record, value);
                        metadata(Math.floor(record.x / 256), Math.floor(record.y / 256)).registered.add(record.id);
                    }
                }

                state.realCount = realTask.records.length;
            }

            if (interval > 0 && nextTime) {
                for (const cell of state.cells.values()) {
                    cell.lastRedistribution = Math.fround(Math.min(cell.lastRedistribution, nextTime.age));
                }
            }

            state.updates++;
        },
        /**
         * Writes the qualified original collision or population persistence through its Java owner.
         *
         * @param {object} lib - Actual CheerpJ Java class namespace.
         */
        async save(lib) {
            if (!state.pop || state.gameState.get('Core.noSave')) {
                unsupported('population save lifecycle/NoSave');
            }

            if (state.pendingOutput.length || state.front.some((r, i) => !state.consumed.has(i))) {
                unsupported('save with unconsumed publication');
            }

            if (state.producer.length) {
                state.worker.push(...state.producer.splice(0));
            }

            if (state.worker.length) {
                await populationService.updateThread(lib);
            }

            const cells = new Map();

            for (const [name, cell] of state.cells) {
                const chunks = cell.chunks.map((records, index) => ({ intensity: cell.targets[index], records: records.map((record) => ({ ...record })), scalars: [cell.lastSeen[index], cell.lastRespawn[index]] }));

                cells.set(name, { names: [...state.outfits], scalars: [cell.createdAge, cell.lastRedistribution], chunks });
            }

            for (const record of state.registry.values()) {
                const x = Math.floor(record.x / 256);
                const y = Math.floor(record.y / 256);
                const name = key(x, y);

                if (!cells.has(name)) {
                    cells.set(name, { names: [...state.outfits], scalars: [0, 0], chunks: Array.from({ length: 1_024 }, () => ({ intensity: 0, records: [], scalars: [0, 0] })) });
                }

                const index = ((Math.floor(record.x / 8) % 32 + 32) % 32) + ((Math.floor(record.y / 8) % 32 + 32) % 32) * 32;

                cells.get(name).chunks[index].records.push({ ...record });
            }

            const outputs = [...cells].map(([name, cell]) => [`zpop/zpop_${name.replace(',', '_')}.bin`, hex(encodeCell(cell))]);

            outputs.push(['zpop/zpop_virtual.bin', hex(encodeEmptyVirtual(state.outfits))], ['zpop/zpop_ids.bin', hex(encodeIDs(state.nextID))]);

            const transport = await helper(lib);

            await sequence(outputs, ([file, bytes]) => transport.writeOwned(file, bytes, file.endsWith('zpop_ids.bin')));

            state.successfulSaves = (state.successfulSaves ?? 0) + 1;
        },
        /**
         * Returns the count of the original published record buffer.
         *
         * @returns {number} Original published record count.
         */
        getAddZombieCount() {
            return state.front.length;
        },
        /**
         * Copies original publication records once into the caller-owned direct buffer.
         *
         * @param {object} lib - Actual CheerpJ Java class namespace.
         * @param {number} offset - Original byte offset or publication cursor.
         * @param {object} buffer - Caller-owned Java direct ByteBuffer.
         * @returns {Promise<number>} Number of original records copied.
         */
        async getAddZombieData(lib, offset, buffer) {
            integer(offset, 'record cursor');

            if (offset < 0 || offset >= state.front.length) {
                const E = await lib.java.lang.IllegalArgumentException;

                throw await new E('record offset outside result');
            }

            if (state.consumed.has(offset)) {
                unsupported('re-reading freed native record');
            }

            const count = await (await helper(lib)).writeRecords(buffer, encoded(state.front.slice(offset)));

            for (let i = 0; i < count; i++) {
                state.consumed.add(offset + i);
            }

            return count;
        },
        /**
         * Allocates or accepts a genuine persistent ID and queues real-zombie registration.
         *
         * @param {object} lib - Actual CheerpJ Java class namespace.
         * @param {number} x - Global x coordinate in the caller API units.
         * @param {number} y - Global y coordinate in the caller API units.
         * @param {number} z - Original zombie z coordinate.
         * @param {number} direction - Original native direction ordinal.
         * @param {number} outfit - Original outfit index and packed state bits.
         * @param {number} flags - Original packed zombie state flags.
         * @param {number} supplied - Original supplied persistent ID; zero requests allocation.
         * @returns {number} Original allocated or supplied persistent ID.
         */
        registerZombie(lib, x, y, z, direction, outfit, flags, supplied) {
            for (const value of [x, y, z]) {
                finite(value, 'register coordinate');
            }

            for (const value of [direction, outfit, flags, supplied]) {
                integer(value, 'register integer');
            }

            if (!state.pop || direction < 0 || direction > 7 || supplied < 0 || !inGrid(Math.floor(x / 256), Math.floor(y / 256))) {
                unsupported('registration lifecycle/coordinates/ID');
            }

            const id = supplied || state.nextID;

            if (id > 2_147_483_647) {
                unsupported('persistent ID overflow');
            }

            const record = { x: Math.fround(x), y: Math.fround(y), z: Math.fround(z), direction, outfit, state: flags, id, px: -2_147_483_648, py: -2_147_483_648 };

            if (!supplied) {
                state.nextID++;
            }

            state.producer.push({ type: 'register', record });

            return id;
        },
        /**
         * Queues original real-zombie release without inventing a replacement record.
         *
         * @param {object} lib - Actual CheerpJ Java class namespace.
         * @param {number} id - Original persistent ID to release.
         */
        releaseZombie(lib, id) {
            integer(id, 'release ID');

            if (!state.pop) {
                unsupported('release before population init');
            }

            state.producer.push({ type: 'release', id });
        },
        /**
         * Validates and queues original real-zombie positions and state flags.
         *
         * @param {object} lib - Actual CheerpJ Java class namespace.
         * @param {number} count - Original record or rectangle count.
         * @param {object} counts - Original Java ID and state integer array.
         * @param {object} xy - Original Java position float array.
         */
        async updateRealZombies(lib, count, counts, xy) {
            if (count < 0) {
                const E = await lib.java.lang.IllegalArgumentException;

                throw await new E('count < 0');
            }

            integer(count, 'real count');
            const ids = await ints(lib, counts);
            const positions = String(await (await helper(lib)).floats(xy)).split(',').filter(Boolean).map((value) => Math.fround(Number(value)));

            if (ids.length < count * 2 || positions.length < count * 3) {
                const E = await lib.java.lang.IllegalArgumentException;

                throw await new E('native real-zombie array bounds');
            }

            const records = [];

            for (let i = 0; i < count; i++) {
                const [x, y, z] = positions.slice(i * 3, i * 3 + 3).map(Math.fround);

                for (const value of [x, y, z]) {
                    finite(value, 'real position');
                }

                if (!inGrid(Math.floor(x / 256), Math.floor(y / 256))) {
                    unsupported('real zombie outside admitted cell');
                }

                records.push({ id: ids[i * 2], state: ids[i * 2 + 1], x, y, z });
            }

            state.producer = state.producer.filter((task) => task.type !== 'real');
            state.producer.push({ type: 'real', records });
        },
        /**
         * Reports completion of the original queued radar request.
         *
         * @returns {boolean} Whether the queued original radar result is ready.
         */
        hasRadarData() {
            return state.radar.ready;
        },
        /**
         * Reports whether the original worker-owned queue is empty.
         *
         * @returns {boolean} Whether no worker batch is pending.
         */
        shouldWait() {
            return state.worker.length === 0;
        },
        /**
         * Releases owned queues and state at the original service stop boundary.
         */
        stop() {
            state.pop = false;
            state.producer = [];
            state.worker = [];
            state.front = [];
            state.pendingOutput = [];
            state.registry.clear();
            state.consumed.clear();
            state.config.clear();
            state.outfits = [];
            state.areas = [];
            state.time = null;
            state.workerTime = null;

            if (!state.mcd) {
                state.cells.clear();
                state.metadata.clear();
            }
        },

    };

    const stringState = ['Core.GameMode', 'GameWindow.CacheDir', 'GameWindow.GameModeCacheDir', 'GameWindow.SaveDir', 'Core.GameSaveWorld', 'SavefileNaming.SUBDIR_ZPOP', 'SavefileNaming.SUBDIR_CHUNKDATA'];

    const boolState = ['Core.bLastStand', 'Core.noSave', 'World.ZombiesDisabled', 'PAUSED'];

    const intState = ['SandboxOptions.Distribution', 'SandboxOptions.Zombies'];

    const signatures = { Ljava_lang_String_2Ljava_lang_String_2: stringState, Ljava_lang_String_2Z: boolState, Ljava_lang_String_2I: intState };

    const natives = {};

    /**
     * Serializes JNI calls and transports unsupported inputs as real Java exceptions.
     *
     * @param {string} name - Original native option or callback name.
     * @param {function(object, ...unknown): unknown} method - Source-qualified native operation.
     */
    const install = (name, method) => {
        /**
         * Queues this original JNI invocation on the owned service serializer.
         *
         * @param {object} lib - Actual CheerpJ Java namespace.
         * @param {...unknown} args - Original JNI arguments in descriptor order.
         * @returns {Promise<unknown>} Actual native result or transported Java failure.
         */
        natives[name] = (lib, ...args) => {
            /**
             * Executes one serialized original JNI request with Java exception transport.
             *
             * @returns {Promise<unknown>} Actual native result or transported Java failure.
             */
            const run = async () => {
                state.callCounts ??= {};
                state.callCounts[name] = (state.callCounts[name] ?? 0) + 1;
                state.trace.push(name);

                if (state.trace.length > 64) {
                    state.trace.shift();
                }

                if (name.includes('setGameState')) {
                    state.stateCalls ??= [];

                    if (state.stateCalls.length < 31) {
                        state.stateCalls.push(args.map((value) => ({ type: typeof value, value: ['string', 'number', 'boolean'].includes(typeof value) ? value : null })));
                    }
                }

                try {
                    return await method(lib, ...args);
                } catch (error) {
                    if (!(error instanceof RangeError)) {
                        throw error;
                    }

                    const E = await lib.java.lang.UnsupportedOperationException;

                    throw await new E(error.message);
                }
            };

            const promise = lock.then(run);

            lock = promise.catch(() => {
                // The caller retains its rejected promise; later calls still need the lock.
            });

            return promise;
        };
    };

    const exportNames = ['chunkUpdateTask', 'hasDataForThread', 'init', 'initMetaCell', 'initMetaChunk', 'initMetaGrid', 'pathTask', 'save', 'shouldWait', 'squareUpdateTask', 'stop', 'update'];

    for (const name of exportNames) {
        install(`Java_zombie_MapCollisionData_n_1${name}`, collisionService[name] ?? (() => unsupported(`MCD ${name}`)));
    }

    /* The original initialization owner invokes this scalar setter millions of
       times. It performs no Java calls or IO: successful calls stay synchronous. */
    /**
     * Writes an original scalar density synchronously without a Java proxy lookup.
     *
     * @param {object} lib - Actual CheerpJ Java namespace for error transport only.
     * @param {...unknown} args - Original cell, chunk and density arguments.
     * @returns {undefined|Promise<never>} Immediate completion or actual Java rejection.
     */
    natives.Java_zombie_MapCollisionData_n_1initMetaChunk = (lib, ...args) => {
        const name = 'Java_zombie_MapCollisionData_n_1initMetaChunk';

        state.callCounts ??= {};
        state.callCounts[name] = (state.callCounts[name] ?? 0) + 1;

        try {
            return collisionService.initMetaChunk(lib, ...args);
        } catch (error) {
            if (!(error instanceof RangeError)) {
                throw error;
            }

            return (async () => {
                const E = await lib.java.lang.UnsupportedOperationException;

                throw await new E(error.message);
            })();
        }
    };

    for (const suffix of ['Ljava_lang_String_2D', 'Ljava_lang_String_2F', 'Ljava_lang_String_2I', 'Ljava_lang_String_2Ljava_lang_String_2', 'Ljava_lang_String_2Z']) {
        install(`Java_zombie_MapCollisionData_n_1setGameState__${suffix}`, (lib, name, value) => {
            name = String(name);

            if (!signatures[suffix]?.includes(name)) {
                unsupported(`game state ${name}/${suffix}`);
            }

            if (suffix.endsWith('_2Z') && ['World.ZombiesDisabled', 'Core.bLastStand'].includes(name) && value) {
                unsupported('disabled population');
            }

            state.gameState.set(name, value);
        });
    }

    install('Java_zombie_MapCollisionData_n_1setGameState', (lib, name, value) => {
        name = String(name);

        if (intState.includes(name) && Number.isInteger(value)) {
            state.gameState.set(name, value);

            return;
        }

        if (stringState.includes(name) && typeof value === 'string') {
            state.gameState.set(name, value);

            return;
        }

        if (boolState.includes(name) && typeof value === 'boolean') {
            if (['World.ZombiesDisabled', 'Core.bLastStand'].includes(name) && value) {
                unsupported('disabled/laststand population');
            }

            state.gameState.set(name, value);

            return;
        }

        unsupported(`ambiguous or unqualified game state overload ${name}`);
    });

    const popNames = ['addZombie', 'aggroTarget', 'config', 'configFloat', 'configInt', 'getAddZombieCount', 'getAddZombieData', 'getRadarZombieData', 'hasDataForThread', 'hasRadarData', 'init', 'loadChunk', 'loadedAreas', 'readyToPause', 'registerZombie', 'releaseZombie', 'requestRadarData', 'save', 'saveCell', 'setOutfitNames', 'setSpawnOrigins', 'shouldWait', 'spawnHorde', 'stop', 'updateMain', 'updateRealZombies', 'updateThread', 'worldSound'];

    for (const name of popNames) {
        install(`Java_zombie_popman_ZombiePopulationManager_n_1${name}`, populationService[name] ?? (() => unsupported(`population ${name}`)));
    }

    /**
     * Copies service ownership and queue counters without exposing mutable state.
     *
     * @returns {object} Current host lifecycle and initialization counters.
     */
    function diagnostics() {
        return {

            callbacks: Object.keys(natives).filter((name) => name !== 'Java_zombie_MapCollisionData_n_1setGameState').length,

            transportCallbacks: Object.keys(natives).length,

            bounds: state.grid ? [...state.grid] : null,

            metadataCells: state.metadata.size,

            densityBytes: state.metadata.size * 1_024,

            cells: state.cells.size,

            registered: state.registry.size,

            successfulSaves: state.successfulSaves ?? 0,

            nextID: state.nextID,

            seedSource: state.seedSource,

            pending: state.producer.length + state.worker.length + state.collisionProducer.length + state.collisionWorker.length,

            updates: state.updates,

            live: state.mcd || state.pop,

            callCounts: { ...state.callCounts },

        };
    }

    return { natives, diagnostics };
}
