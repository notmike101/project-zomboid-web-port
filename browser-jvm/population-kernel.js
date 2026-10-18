/**
 * Combines the native MT recurrence words without signed overflow.
 *
 * @param {number} a - First native recurrence word.
 * @param {number} b - Second native recurrence word.
 * @param {number} c - Third native recurrence word.
 * @returns {number} Unsigned native recurrence result.
 */
const twist = (a, b, c) => ((c ^ ((((a ^ b) & 0x7F_FF_FF_FF) ^ a) >>> 1) ^ ((b & 1) ? 0x99_08_B0_DF : 0)) >>> 0);
const f = Math.fround;

/** Reproduces the source-qualified native MT layout and unsigned arithmetic. */
class NativeMT {
    /**
     * Restores the original native MT state layout from little-endian words.
     *
     * @param {Uint8Array} bytes - Original wire or transport bytes.
     * @returns {void} Completes native state initialization.
     */
    constructor(bytes) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

        if (bytes.byteLength !== 5_000) {
            throw new Error('MT state size');
        }

        this.state = new Uint32Array(1_250);

        for (let i = 0; i < 1_250; i++) {
            this.state[i] = view.getUint32(i * 4, true);
        }

        this.draws = 0;
    }

    /**
     * Seeds the original MT recurrence using one unsigned entropy word.
     *
     * @param {number} seed - Unsigned 32-bit seed from browser entropy.
     * @returns {NativeMT} Native state seeded by the original recurrence.
     */
    static fromSeed(seed) {
        if (!Number.isInteger(seed) || seed < 0 || seed > 0xFF_FF_FF_FF) {
            throw new Error('uint32 seed');
        }

        const bytes = new Uint8Array(5_000);

        const view = new DataView(bytes.buffer);

        view.setUint32(0, 624, true);

        view.setUint32(4, seed, true);

        let value = seed;

        for (let i = 1; i < 624; i++) {
            value = (Math.imul(value ^ (value >>> 30), 0x6C_07_89_65) + i) >>> 0;

            view.setUint32((i + 1) * 4, value, true);
        }

        view.setUint32(4_996, 0xFF_FF_FF_FF, true);

        return new NativeMT(bytes);
    }

    /**
     * Advances the native MT state and returns its next unsigned word.
     *
     * @returns {number} Next unsigned native random word.
     */
    next() {
        const s = this.state;

        let index = s[0];

        if (index === 624) {
            for (let i = 2; i < 626; i++) {
                s[i + 623] = twist(s[i - 1], s[i], s[i + 396]);
            }
        } else if (index > 1_247) {
            for (let i = 626; i < 853; i++) {
                s[i - 625] = twist(s[i - 1], s[i], s[i + 396]);
            }

            for (let i = 853; i < 1_249; i++) {
                s[i - 625] = twist(s[i - 1], s[i], s[i - 852]);
            }

            s[624] = twist(s[1_248], s[1], s[397]);

            index = 0;

            s[0] = 0;
        }

        let value = s[index + 1];

        s[0] = index + 1;

        value ^= (value >>> 11) & s[1_249];

        value ^= (value & 0xFF_3A_58_AD) << 7;

        value ^= (value & 0xFF_FF_DF_8C) << 15;

        this.draws++;

        return (value ^ (value >>> 18)) >>> 0;
    }

    /**
     * Uses the native rejection sampler for an unbiased bounded integer.
     *
     * @param {number} bound - Exclusive positive random bound.
     * @returns {number} Original unbiased random selection.
     */
    bounded(bound) {
        if (bound < 1) {
            return bound;
        }

        const width = BigInt(bound >>> 0);

        const threshold = ((1n << 32n) - width) % width;

        let product;

        do {
            product = BigInt(this.next()) * width;
        } while ((product & 0xFF_FF_FF_FFn) < threshold);

        return Number(product >> 32n);
    }
}

/**
 * Decodes the original v1 collision tags into 1024 square-flag chunks.
 *
 * @param {Uint8Array} bytes - Original wire or transport bytes.
 * @returns {Array<Uint8Array>} Decoded original square flags.
 */
function collision(bytes) {
    const version = bytes.readUInt16BE(0);

    if (version >= 2) {
        throw new Error('unsupported collision version');
    }

    const chunks = [];

    let offset = 2;

    const uniform = new Map([[0, 0], [1, 1], [3, 8], [4, 16], [5, 32]]);

    for (let i = 0; i < 1_024; i++) {
        const tag = bytes[offset++];

        if (uniform.has(tag)) {
            chunks.push(new Uint8Array(64).fill(uniform.get(tag)));
        } else {
            chunks.push(Uint8Array.from(bytes.subarray(offset, offset + 64)));

            offset += 64;
        }
    }

    if (offset !== bytes.length) {
        throw new Error('collision EOF mismatch');
    }

    return chunks;
}

/**
 * Runs the recovered initial population target and spawn-distribution algorithm.
 *
 * @param {object} root0 - Source-qualified initial-generation inputs.
 * @param {NativeMT} root0.rng - Original native random generator.
 * @param {Uint8Array} root0.density - Actual original 1024 chunk density bytes.
 * @param {Array<Uint8Array>} root0.chunks - Original 1024 collision chunks.
 * @param {Uint8Array} root0.config - Original native configuration structure.
 * @param {Uint8Array} root0.constants - Recovered original float constants.
 * @param {Uint8Array} root0.directions - Original native direction lookup.
 * @param {number} root0.cellX - Global x coordinate in the caller API units.
 * @param {number} root0.cellY - Global y coordinate in the caller API units.
 * @param {number} root0.idStart - Original starting persistent-ID allocator.
 * @param {number} root0.age - Actual original world age in hours.
 * @returns {object} Original target chunks, natural records and allocator totals.
 */
function generate({ rng, density, chunks, config, constants, directions, cellX, cellY, idStart = 1, age = 0 }) {
    if (!Number.isInteger(cellX) || !Number.isInteger(cellY)) {
        throw new TypeError('cell coordinates required');
    }

    /**
     * Reads one original configuration float at its recovered structure offset.
     *
     * @param {number} offset - Original byte offset or publication cursor.
     * @returns {number} Original configuration float.
     */
    const at = (offset) => config.readFloatLE(offset - 0x1_68);

    /**
     * Reads a recovered native float constant by its original address.
     *
     * @param {number} address - Recovered native constant address.
     * @returns {number} Recovered constant float.
     */
    const constant = (address) => constants.readFloatLE(address - 0xF_A1_D8);

    /**
     * Reads collision flags inside the current cell; its unqualified neighbors remain blocked.
     *
     * @param {number} x - Global x coordinate in the caller API units.
     * @param {number} y - Global y coordinate in the caller API units.
     * @returns {number} Original packed square flags.
     */
    const flags = (x, y) => {
        x -= cellX * 256;

        y -= cellY * 256;

        if (x < 0 || y < 0 || x >= 256 || y >= 256) {
            return 1;
        }

        return chunks[(y >> 3) * 32 + (x >> 3)][(y & 7) * 8 + (x & 7)];
    };

    /**
     * Tests square solidity and the original directional wall bits.
     *
     * @param {number} x - Global x coordinate in the caller API units.
     * @param {number} y - Global y coordinate in the caller API units.
     * @param {number} tx - Target square x coordinate.
     * @param {number} ty - Target square y coordinate.
     * @returns {boolean} Whether native collision rules block this edge.
     */
    const blocked = (x, y, tx, ty) => {
        const a = flags(x, y);

        const b = flags(tx, ty);

        return Boolean((b & 0x19) || (ty < y && (a & 2)) || (tx < x && (a & 4)) || (y < ty && (b & 2)) || (x < tx && (b & 4)));
    };

    /**
     * Classifies the original four directional openings around a square.
     *
     * @param {number} x - Global x coordinate in the caller API units.
     * @param {number} y - Global y coordinate in the caller API units.
     * @returns {number} Native opening classification or minus one.
     */
    const shape = (x, y) => {
        if (flags(x, y) & 0x19) {
            return -1;
        }

        const edges = [blocked(x, y, x, y - 1), blocked(x, y, x, y + 1), blocked(x - 1, y, x, y), blocked(x + 1, y, x, y)];

        if (edges.every(Boolean)) {
            return 4;
        }

        const open = edges.findIndex((v) => !v);

        return edges.filter(Boolean).length === 3 ? open : -1;
    };

    /**
     * Applies the original corner and corridor exclusions to a spawn square.
     *
     * @param {number} x - Global x coordinate in the caller API units.
     * @param {number} y - Global y coordinate in the caller API units.
     * @returns {boolean} Whether original spawn exclusions permit this square.
     */
    const spawnable = (x, y) => !(flags(x, y) & 0x19) && shape(x, y) !== 4 && !(shape(x, y) === 3 && shape(x + 1, y) === 2) && !(shape(x - 1, y) === 3 && shape(x, y) === 2) && !(shape(x, y) === 1 && shape(x, y + 1) === 0) && !(shape(x, y - 1) === 1 && shape(x, y) === 0);

    const entries = [];

    let sum = 0;

    let nextID = idStart;

    for (let i = 0; i < 1_024; i++) {
        let target = 0;

        if (!chunks[i].every((value) => (value & 0x19) !== 0)) {
            let value = density[i];

            value = value === 0 ? 0 : f(f(f(f(value * at(0x1_68)) / constant(0xF_A2_6C)) * f(at(0x1_8C) - at(0x1_88))) + at(0x1_88));

            if (value >= constant(0xF_A2_64)) {
                if (Math.trunc(value) !== 1) {
                    target = Math.trunc(value);
                } else if (rng.bounded(100) <= 49) {
                    target = 1;
                }
            } else if (f(value * constant(0xF_A2_68)) > rng.bounded(100)) {
                target = 1;
            }
        }

        if (target > 0) {
            entries.push({ index: i, target, records: [] });

            sum += target;
        }
    }

    const start = at(0x1_6C);

    const peak = at(0x1_70);

    const peakDay = config.readUInt32LE(0x1_74 - 0x1_68);

    const days = f(f(age) / constant(0xF_A1_D8));

    const total = days < peakDay ? Math.trunc(f(f(f(f(sum * peak) - f(sum * start)) * f(days / peakDay)) + f(sum * start))) : Math.trunc(f(sum * peak));

    let generated = 0;

    /**
     * Attempts the original bounded random placement in one target chunk.
     *
     * @param {object} entry - Original target chunk and its generated records.
     * @returns {boolean} Whether an original bounded placement succeeded.
     */
    function spawn(entry) {
        const cx = cellX * 32 + entry.index % 32;

        const cy = cellY * 32 + (entry.index >> 5);

        for (let tries = 0; tries < 100; tries++) {
            const x = cx * 8 + rng.bounded(8);

            const y = cy * 8 + rng.bounded(8);

            if (spawnable(x, y)) {
                const direction = rng.bounded(8);

                entry.records.push({
                    x: x + constant(0xF_A2_60),
                    y: y + constant(0xF_A2_60),
                    z: 0,
                    direction: direction === 0 ? 0 : directions[direction - 1],
                    outfit: 0,
                    state: 4,
                    px: -2_147_483_648,
                    py: -2_147_483_648,
                    id: nextID++,
                });

                return true;
            }
        }

        return false;
    }

    for (const entry of entries) {
        let allocation = Math.trunc(f(f(entry.target / sum) * total));

        if (sum <= total && allocation < 1) {
            allocation = 1;
        }

        for (let i = 0; i < allocation; i++) {
            if (spawn(entry)) {
                generated++;
            }
        }
    }

    for (let left = total - generated; left > 0; left--) {
        for (let tries = 0; tries < 900; tries++) {
            if (spawn(entries[rng.bounded(entries.length)])) {
                break;
            }
        }
    }

    return { entries, generated: nextID - idStart, sum, total };
}

export { NativeMT, collision, generate };
