/**
 * Evaluates original 0x18000b470 with float32 arithmetic and signed native count input.
 *
 * @param {number} sum - Original signed cell target sum.
 * @param {number} start - Actual start multiplier.
 * @param {number} peak - Actual peak multiplier.
 * @param {number} peakDay - Actual peak day.
 * @param {number} age - Original world age hours.
 * @returns {number} Native age-scaled target count.
 */
function populationTarget(sum, start, peak, peakDay, age) {
    const days = Math.fround(Math.fround(age) / 24);
    const f = Math.fround;

    return days < peakDay ? Math.trunc(f(f(f(f(sum * peak) - f(sum * start)) * f(days / peakDay)) + f(sum * start))) : Math.trunc(f(sum * peak));
}

/**
 * Runs the source-qualified pre-spawn branch of native 0x180020e70.
 *
 * @param {object} input - Actual cell counts and configuration.
 * @param {number} input.target - Age-scaled original target.
 * @param {number} input.count - Ordinary plus grouped original population.
 * @param {number} input.excess - Eight-neighbor excess population.
 * @param {number} input.last - Original saved cell respawn clock.
 * @param {number} input.age - Actual original world age.
 * @param {number} input.hours - Actual configured respawn interval.
 * @returns {object} Exact updated clock and actual due-operation indication.
 */
function respawnClock({ target, count, excess, last, age, hours }) {
    const f = Math.fround;

    age = f(age);

    if (Math.max(0, target - count) - excess < 10) {
        return { last: age, due: false };
    }

    last = f(Math.min(age, last));

    return { last, due: f(last + hours) < age };
}

/**
 * Applies the original respawn/initial-generation square exclusions (0x18001cdd0).
 *
 * @param {function(number, number): number} flags - Actual collision flags.
 * @param {number} x - World square x.
 * @param {number} y - World square y.
 * @returns {boolean} Whether the original square is eligible for population placement.
 */
function populationSpawnable(flags, x, y) {
    /**
     * Tests the original directional collision edge.
     *
     * @param {number} sx - Original native sx coordinate or status.
     * @param {number} sy - Original native sy coordinate or status.
     * @param {number} tx - Original native tx coordinate or status.
     * @param {number} ty - Original native ty coordinate or status.
     * @returns {boolean} Actual native operation result.
     */
    const blocked = (sx, sy, tx, ty) => {
        const a = flags(sx, sy);
        const b = flags(tx, ty);

        return Boolean((b & 0x19) || (ty < sy && (a & 2)) || (tx < sx && (a & 4))
            || (sy < ty && (b & 2)) || (sx < tx && (b & 4)));
    };

    /**
     * Classifies the original square opening.
     *
     * @param {number} sx - Original native sx coordinate or status.
     * @param {number} sy - Original native sy coordinate or status.
     * @returns {number} Actual native operation result.
     */
    const shape = (sx, sy) => {
        if (flags(sx, sy) & 0x19) {
            return -1;
        }

        const edges = [blocked(sx, sy, sx, sy - 1), blocked(sx, sy, sx, sy + 1),
            blocked(sx - 1, sy, sx, sy), blocked(sx + 1, sy, sx, sy)];

        if (edges.every(Boolean)) {
            return 4;
        }

        return edges.filter(Boolean).length === 3 ? edges.findIndex((value) => !value) : -1;
    };

    return !(flags(x, y) & 0x19) && shape(x, y) !== 4 && !(shape(x, y) === 3 && shape(x + 1, y) === 2)
        && !(shape(x - 1, y) === 3 && shape(x, y) === 2) && !(shape(x, y) === 1 && shape(x, y + 1) === 0)
        && !(shape(x, y - 1) === 1 && shape(x, y) === 0);
}

/**
 * Plans the original due-respawn path request; placement still requires its actual result.
 *
 * @param {object} input - Native cell/chunk state, world bounds, configuration and RNG.
 * @returns {object} Updated native clocks/budget and the genuine requested path, if any.
 */
function respawnRequest(input) {
    const {
        chunks, targets, seen, lastSpawn, age, hours, unseen, multiplier, rng, bounds, cellX, cellY,
        start, peak, peakDay, deficit, valid, loaded, last, origins = [],
    } = input;
    const clocks = Float32Array.from(lastSpawn, (last) => Math.min(age, last));
    const eligible = [];

    for (let i = 0; i < 1_024; i++) {
        const x = cellX * 256 + i % 32 * 8;
        const y = cellY * 256 + (i >> 5) * 8;

        if (!loaded(x, y) && f(f(seen[i]) + unseen) < f(age)
            && chunks[i].length < populationTarget((targets[i] << 16) >> 16, start, peak, peakDay, age)
            && f(clocks[i] + hours) < f(age)) {
            eligible.push(i);
        }
    }

    let { quota = 0, budget = -1, spawned = 0 } = input;

    if (budget === -1) {
        const target = populationTarget((targets.reduce((sum, value) => sum + value, 0) << 16) >> 16, start, peak, peakDay, age);

        quota = Math.trunc(f(f(target * multiplier) / 100));
        budget = Math.imul(Math.trunc(f(f(age - last) / hours)), quota);
        spawned = 0;
    }

    const count = Math.min(deficit, Math.max(10, Math.trunc(quota / 36)));
    const [left, top, width, height] = bounds;

    while (eligible.length) {
        const selected = rng.bounded(eligible.length);
        const index = eligible[selected];

        clocks[index] = f(age);
        let origin;

        for (let attempt = 0; attempt < 100; attempt++) {
            let x;
            let y;

            if (origins.length) {
                const [ox, oy, w, h] = origins[rng.bounded(origins.length)];

                x = ox + rng.bounded(w);
                y = oy + rng.bounded(h);
            } else {
                switch (rng.bounded(4)) {
                    case 0: {
                        x = 0;
                        y = rng.bounded(height);
                        break;
                    }
                    case 1: {
                        x = rng.bounded(width);
                        y = 0;
                        break;
                    }
                    case 2: {
                        x = width - 1;
                        y = rng.bounded(height);
                        break;
                    }

                    default: {
                        x = rng.bounded(width);
                        y = height - 1;
                    }
                }

                x += left;
                y += top;
            }

            if (valid(x, y)) {
                origin = [x, y];
                break;
            }
        }

        if (origin) {
            for (let attempt = 0; attempt < 20; attempt++) {
                const x = cellX * 256 + index % 32 * 8 + rng.bounded(8);
                const y = cellY * 256 + (index >> 5) * 8 + rng.bounded(8);

                if (valid(x, y)) {
                    return {
                        last, clocks, quota, budget, spawned,
                        request: { startX: origin[0], startY: origin[1], targetX: x, targetY: y, count },
                    };
                }
            }
        }

        eligible.splice(selected, 1);
    }

    return { last: f(age), clocks, quota, budget: -1, spawned, request: null };
}

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

/**
 * Reproduces the source-qualified native MT layout and unsigned arithmetic.
 */
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

    /**
     * Reproduces the native 24-bit float draw over the selected range.
     *
     * @param {number} min - Original lower bound.
     * @param {number} max - Original upper bound.
     * @returns {number} Original float32 random value.
     */
    real(min, max) {
        if (min === max) {
            return min;
        }

        const fraction = f((this.next() >>> 8) * 2 ** -24);

        return f(f(fraction * f(max - min)) + min);
    }
}

/**
 * Decodes the original v1 collision tags into 1024 square-flag chunks.
 *
 * @param {Uint8Array} bytes - Original wire or transport bytes.
 * @param {Array<Uint8Array>|null} [previous] - Higher-priority source flags, with exact 32 indicating unset squares.
 * @returns {Array<Uint8Array>} Decoded original square flags.
 */
function collision(bytes, previous = null) {
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

    if (previous) {
        for (const [i, chunk] of chunks.entries()) {
            for (let j = 0; j < 64; j++) {
                if (previous[i][j] === 32) {
                    previous[i][j] = chunk[j];
                }
            }
        }
    }

    return previous ?? chunks;
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
 * @param {boolean} [root0.uniform] - Original Distribution=2 density substitution.
 * @param {function(number, number): number} [root0.globalFlags] - Original global square collision lookup.
 * @returns {object} Original target chunks, natural records and allocator totals.
 */
function generate({ rng, density, chunks, config, constants, directions, cellX, cellY, idStart = 1, age = 0, globalFlags, uniform = false }) {
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
     * Reads original global collision flags, or the qualified isolated-cell fallback.
     *
     * @param {number} x - Global x coordinate in the caller API units.
     * @param {number} y - Global y coordinate in the caller API units.
     * @returns {number} Original packed square flags.
     */
    const flags = globalFlags ?? ((x, y) => {
        x -= cellX * 256;

        y -= cellY * 256;

        if (x < 0 || y < 0 || x >= 256 || y >= 256) {
            return 1;
        }

        return chunks[(y >> 3) * 32 + (x >> 3)][(y & 7) * 8 + (x & 7)];
    });

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
            let value = uniform ? at(0x1_90) : density[i];

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

/**
 * Finds the original redistribution group's reachable squares inside its 8-by-8 chunk.
 *
 * @param {number} x - Original integer source square x.
 * @param {number} y - Original integer source square y.
 * @param {function(number, number): number} flags - Actual original collision bits.
 * @returns {Uint8Array} Reachability in source-chunk square order.
 */
function redistributionReachable(x, y, flags) {
    const left = Math.trunc(x / 8) * 8;
    const top = Math.trunc(y / 8) * 8;
    const reached = new Uint8Array(64);

    for (const [sx, sy] of redistributionSquares(x, y, flags)) {
        reached[sx - left + (sy - top) * 8] = 1;
    }

    return reached;
}

/**
 * Plans original redistribution groups without removing records before movement is supported.
 *
 * @param {object} input - Actual cell population and collision inputs.
 * @param {Array<Array<object>>} input.chunks - Original virtual records in 1024 chunk order.
 * @param {number} input.cellX - Original cell x.
 * @param {number} input.cellY - Original cell y.
 * @param {NativeMT} input.rng - Original native random selection state.
 * @param {function(number, number): number} input.flags - Actual original collision bits.
 * @returns {Array<object>} Ordered groups and their actual target chunk centers.
 */
function redistributionGroups({ chunks, cellX, cellY, rng, flags }) {
    const destinations = [];
    const groups = [];

    for (const [index, records] of chunks.entries()) {
        if (records.length) {
            continue;
        }

        const x = cellX * 256 + index % 32 * 8;
        const y = cellY * 256 + Math.floor(index / 32) * 8;
        let blocked = 0;

        for (let square = 0; square < 64; square++) {
            if (flags(x + square % 8, y + Math.floor(square / 8)) & 0x19) {
                blocked++;
            }
        }

        if (blocked !== 64) {
            destinations.push([x + 4, y + 4]);
        }
    }

    if (!destinations.length) {
        return groups;
    }

    for (const records of chunks) {
        if (records.length <= 5) {
            continue;
        }

        const eligible = records.filter((record) => Math.floor(record.z) === 0 && !(record.state & 8)
            && !(flags(Math.floor(record.x), Math.floor(record.y)) & 0x19));

        if (eligible.length <= 5) {
            continue;
        }

        while (eligible.length) {
            const first = eligible.shift();
            const [targetX, targetY] = destinations[rng.bounded(destinations.length)];
            const x = Math.floor(first.x);
            const y = Math.floor(first.y);
            const reachable = redistributionReachable(x, y, flags);
            const left = Math.trunc(x / 8) * 8;
            const top = Math.trunc(y / 8) * 8;
            const members = [first];

            for (let i = 0; i < eligible.length && members.length < 5; i++) {
                const dx = Math.floor(eligible[i].x) - left;
                const dy = Math.floor(eligible[i].y) - top;

                if (dx >= 0 && dx < 8 && dy >= 0 && dy < 8 && reachable[dx + dy * 8]) {
                    members.push(...eligible.splice(i--, 1));
                }
            }

            groups.push({ records: members, targetX, targetY });
        }
    }

    return groups;
}

/**
 * Applies the original virtual-population edge and diagonal collision rules.
 *
 * @param {function(number, number): number} flags - Actual collision bits.
 * @param {number} x - Source square x.
 * @param {number} y - Source square y.
 * @param {number} tx - Destination square x.
 * @param {number} ty - Destination square y.
 * @returns {boolean} Whether the original collision edge is blocked.
 */
function populationBlocked(flags, x, y, tx, ty) {
    const a = flags(x, y);
    const b = flags(tx, ty);

    return Boolean((b & 0x19) || (ty < y && (a & 2)) || (tx < x && (a & 4))
        || (y < ty && (b & 2)) || (x < tx && (b & 4))
        || (x !== tx && y !== ty && (populationBlocked(flags, x, y, x, ty)
            || populationBlocked(flags, x, y, tx, y) || populationBlocked(flags, tx, ty, x, ty)
            || populationBlocked(flags, tx, ty, tx, y))));
}

/**
 * Executes the original MCD wall-follower query (native 0x180017870/17a80).
 *
 * @param {number} startX - Original source x.
 * @param {number} startY - Original source y.
 * @param {number} targetX - Original target x.
 * @param {number} targetY - Original target y.
 * @param {function(number, number): number} flags - Actual global collision flags.
 * @param {number[][]|null} [waypoints] - Optional owner receiving the native pre-move path coordinates.
 * @returns {object} Native status, endpoint, movement count and worker ticks.
 */
function mapCollisionPath(startX, startY, targetX, targetY, flags, waypoints = null) {
    let x = startX;
    let y = startY;
    let anchor = null;
    let wall;
    let wallSteps = 0;
    let loops = 0;
    let steps = 0;
    let ticks = 0;
    /**
     * Tests the original directional collision edge.
     *
     * @param {number} sx - Original native sx coordinate or status.
     * @param {number} sy - Original native sy coordinate or status.
     * @param {number} tx - Original native tx coordinate or status.
     * @param {number} ty - Original native ty coordinate or status.
     * @returns {boolean} Actual native operation result.
     */
    const blocked = (sx, sy, tx, ty) => populationBlocked(flags, sx, sy, tx, ty);
    /**
     * Publishes the original path query result.
     *
     * @param {number} status - Original native status coordinate or status.
     * @returns {object} Actual native operation result.
     */
    const result = (status) => ({ status, x, y, steps, ticks });
    /**
     * Advances actual path movement and its native counter.
     *
     * @param {number} tx - Original native tx coordinate or status.
     * @param {number} ty - Original native ty coordinate or status.
     * @returns {void} Actual native operation result.
     */
    const move = (tx, ty) => {
        waypoints?.push([x, y]);
        x = tx;
        y = ty;
        steps++;
    };

    /**
     * Tests the exact float32 anchor-to-target grid line.
     *
     * @returns {boolean} Actual native operation result.
     */
    const lineContains = () => {
        const [ax, ay] = anchor;
        const dx = targetX - ax;
        const dy = targetY - ay;

        if (Math.abs(dx) > Math.abs(dy)) {
            const sign = dx < 0 ? -1 : 1;
            const slope = f(f(dy / dx) * sign);
            let minor = f(ay + 0.5);

            for (let major = ax; major !== targetX;) {
                major += sign;
                minor = f(minor + slope);

                if (major === x && Math.floor(minor) === y) {
                    return true;
                }
            }
        } else {
            const sign = dy < 0 ? -1 : 1;
            const slope = f(f(dx / dy) * sign);
            let minor = f(ax + 0.5);

            for (let major = ay; major !== targetY;) {
                major += sign;
                minor = f(minor + slope);

                if (Math.floor(minor) === x && major === y) {
                    return true;
                }
            }
        }

        return false;
    };

    for (;;) {
        ticks++;

        if (flags(x, y) & 0x19) {
            return result(1);
        }

        if (x === targetX && y === targetY) {
            return result(3);
        }

        if (steps >= 90_000) {
            return result(1);
        }

        if (!anchor) {
            const dx = targetX - x;
            const dy = targetY - y;
            const tx = Math.abs(dx) > Math.abs(dy)
                ? x + (dx < 0 ? -1 : 1)
                : Math.floor(f(f(x + 0.5) + f(f(dx / dy) * (dy < 0 ? -1 : 1))));
            const ty = Math.abs(dx) > Math.abs(dy)
                ? Math.floor(f(f(y + 0.5) + f(f(dy / dx) * (dx < 0 ? -1 : 1))))
                : y + (dy < 0 ? -1 : 1);

            if (blocked(x, y, tx, ty)) {
                anchor = [x, y];
                wall = [tx, ty];
                wallSteps = 0;
                loops = 0;

                if (tx > x && ty < y && !blocked(x + 1, y, tx, ty)) {
                    wall[0]--;
                } else if (tx > x && ty > y && !blocked(x, y + 1, tx, ty)) {
                    wall[1]--;
                } else if (tx < x && ty < y && !blocked(x, y - 1, tx, ty)) {
                    wall[1]++;
                } else if (tx < x && ty > y && !blocked(x - 1, y, tx, ty)) {
                    wall[0]++;
                }
            } else {
                move(tx, ty);
            }

            if (steps && x === startX && y === startY) {
                return result(2);
            }
        } else {
            const oldSteps = steps;
            const dx = wall[0] - x;
            const dy = wall[1] - y;
            let tx = x;
            let ty = y;
            let corner = false;
            let wallBit = false;

            if ((dx === 1 && dy === -1) || (dx === 0 && dy === -1)) {
                tx++;
                corner = dx === 0;
                wallBit = Boolean(flags(x, y) & 2);
            } else if ((dx === 1 && dy === 0) || (dx === 1 && dy === 1)) {
                ty++;
                corner = dy === 0;
                wallBit = Boolean(flags(x + 1, y) & 4);
            } else if ((dx === 0 && dy === 1) || (dx === -1 && dy === 1)) {
                tx--;
                corner = dx === 0;
                wallBit = Boolean(flags(x, y + 1) & 2);
            } else if ((dx === -1 && dy === 0) || (dx === -1 && dy === -1)) {
                ty--;
                corner = dy === 0;
                wallBit = Boolean(flags(x, y) & 4);
            }

            if (tx !== x || ty !== y) {
                if (blocked(x, y, tx, ty)) {
                    wall = [tx, ty];
                } else {
                    if (corner && wallBit && !blocked(x, y, tx + dx, ty + dy)) {
                        wall = [x, y];
                    }

                    move(tx, ty);
                }
            }

            if (steps > oldSteps) {
                wallSteps++;
            }

            if ((x !== anchor[0] || y !== anchor[1]) && lineContains()) {
                anchor = null;
            }

            if (anchor && wallSteps && x === anchor[0] && y === anchor[1] && ++loops >= 2) {
                return result(2);
            }
        }

        if ((flags(x, y) & 0x19) || [[x - 1, y], [x, y - 1], [x + 1, y], [x, y + 1]]
            .every(([tx, ty]) => blocked(x, y, tx, ty))) {
            return result(1);
        }

        if (x === targetX && y === targetY) {
            return result(3);
        }
    }
}

/**
 * Performs the original bounded virtual-agent straight-line fallback probe.
 *
 * @param {number} x - Source integer x.
 * @param {number} y - Source integer y.
 * @param {number} tx - Destination integer x.
 * @param {number} ty - Destination integer y.
 * @param {function(number, number): number} flags - Actual collision bits.
 * @param {number} limit - Original maximum probe steps.
 * @returns {boolean} Whether the inspected prefix is clear.
 */
function virtualLineClear(x, y, tx, ty, flags, limit = 10) {
    /* Original016570 subtracts and takes absolute values in signed int32, including overflow. */
    /* eslint-disable unicorn/prefer-math-trunc */
    const dx = (tx - x) | 0;
    const dy = (ty - y) | 0;
    const horizontal = (Math.abs(dy) | 0) < (Math.abs(dx) | 0);
    /* eslint-enable unicorn/prefer-math-trunc */
    const step = (horizontal ? dx : dy) < 0 ? -1 : 1;
    const slope = f(f(horizontal ? dy : dx) / f(horizontal ? dx : dy));
    let position = f((horizontal ? y : x) + 0.5);

    while ((horizontal ? x !== tx : y !== ty) && limit-- > 0) {
        const before = Math.trunc(position);

        position = f(position + f(slope * step));
        const after = Math.trunc(position);

        if (populationBlocked(flags, horizontal ? x : before, horizontal ? before : y,
            horizontal ? x + step : after, horizontal ? after : y + step)) {
            return false;
        }

        if (horizontal) {
            x += step;
        } else {
            y += step;
        }
    }

    return true;
}

/**
 * Advances one original virtual-agent displacement with its alternating collision slide.
 *
 * @param {object} record - Original record containing float x and y.
 * @param {number} dx - Original accumulated x displacement.
 * @param {number} dy - Original accumulated y displacement.
 * @param {boolean} alternate - Original collision-axis alternation bit.
 * @param {number[]} bounds - Original minimum x/y and exclusive maximum x/y in squares.
 * @param {function(number, number): number} flags - Actual collision bits.
 * @returns {object} Resulting position, alternation bit and original blocked marker.
 */
function moveVirtual(record, dx, dy, alternate, bounds, flags) {
    const ox = f(record.x);
    const oy = f(record.y);
    let x = f(Math.max(f(ox + dx), bounds[0]));
    let y = f(Math.max(f(oy + dy), bounds[1]));
    const length = f(Math.sqrt(f(f(f(y - oy) * f(y - oy)) + f(f(x - ox) * f(x - ox)))));

    if (length > 1) {
        x = f(ox + f(f(x - ox) / length));
        y = f(oy + f(f(y - oy) / length));
    }

    const desiredX = x;
    const desiredY = y;
    const hit = { x: false, y: false, blocked: false };
    /**
     * Tests original exclusive metadata bounds.
     *
     * @param {number} sx - Square x.
     * @param {number} sy - Square y.
     * @returns {boolean} Whether the square is outside metadata.
     */
    const outside = (sx, sy) => sx < bounds[0] || sy < bounds[1] || sx >= bounds[2] || sy >= bounds[3];

    /**
     * Applies native180015980's half-square lookahead and selected collision axis.
     *
     * @param {number} axis - Original first/second collision axis.
     */
    function collide(axis) {
        const sx = Math.floor(ox);
        const sy = Math.floor(oy);
        const tx = Math.floor(x);
        const ty = Math.floor(y);
        const out = outside(tx, ty);

        if ((tx === sx && ty === sy) || out) {
            if (x === ox && y === oy) {
                return;
            }

            if (out) {
                hit.x ||= x !== ox;
                hit.y ||= y !== oy;
                x = ox;
                y = oy;
                hit.blocked = true;

                return;
            }

            const cx = f(x - ox);
            const cy = f(y - oy);
            const distance = f(Math.sqrt(f(f(cy * cy) + f(cx * cx))));
            const px = Math.floor(f(f((distance >= 0.001 ? f(cx / distance) : 0) * 0.5) + ox));
            const py = Math.floor(f(f((distance >= 0.001 ? f(cy / distance) : 0) * 0.5) + oy));

            if (outside(px, py) || (px === tx && py === ty) || !populationBlocked(flags, tx, ty, px, py)) {
                return;
            }

            hit.x ||= tx !== px;
            hit.y ||= ty !== py;
        } else {
            if (!populationBlocked(flags, sx, sy, tx, ty)) {
                return;
            }

            hit.x ||= sx !== tx;
            hit.y ||= sy !== ty;
        }

        if (axis === 2 && hit.x) {
            hit.y = false;
        } else if (axis === 1 && hit.y) {
            hit.x = false;
        }

        hit.blocked = true;
    }

    collide(alternate ? 2 : 1);

    if (hit.y) {
        y = oy;
    }

    if (hit.x) {
        x = ox;
    }

    collide(alternate ? 1 : 2);
    alternate = !alternate;
    let blocked = false;

    if (hit.y) {
        y = oy;
        blocked = true;
    }

    if (hit.x) {
        x = ox;
        blocked = true;
    }

    const firstX = x;
    const firstY = y;

    x = desiredX;
    y = desiredY;

    if (blocked) {
        collide(alternate ? 2 : 1);

        if (hit.y) {
            y = oy;
        }

        if (hit.x) {
            x = ox;
        }

        collide(alternate ? 1 : 2);

        if (hit.y) {
            y = oy;
        }

        if (hit.x) {
            x = ox;
        }

        if (f(Math.abs(f(y - oy)) + Math.abs(f(x - ox))) < f(Math.abs(f(firstY - oy)) + Math.abs(f(firstX - ox)))) {
            x = firstX;
            y = firstY;
        }
    }

    return { x: f(f(x - ox) + ox), y: f(f(y - oy) + oy), alternate, blocked: hit.blocked };
}

/**
 * Advances the original virtual leader using the selected original direction algorithm.
 *
 * @param {object} group - Original-derived records, targetX/targetY and alternation bit.
 * @param {number} multiplier - Actual original worker time multiplier.
 * @param {number[]} bounds - Original square bounds.
 * @param {function(number, number): number} flags - Actual original collision bits.
 * @param {boolean} [lastStand] - Actual original Core.bLastStand state.
 * @returns {object} Next leader position and whether original fallback stopped movement.
 */
function advanceVirtual(group, multiplier, bounds, flags, lastStand = false) {
    const record = group.records[0];
    const x = Math.floor(record.x);
    const y = Math.floor(record.y);

    if (x === group.targetX && y === group.targetY) {
        return { x: record.x, y: record.y, alternate: Boolean(group.alternate), blocked: true };
    }

    let destination = null;

    if (lastStand && !(flags(x, y) & 0x19)) {
        const waypoints = [];
        const path = mapCollisionPath(x, y, group.targetX, group.targetY, flags, waypoints);

        if (path.status === 3) {
            const later = waypoints.findIndex((point, index) => index > 0 && point[0] === x && point[1] === y);
            const current = later === -1 ? 0 : later;

            if (waypoints.length - current > 1) {
                destination = waypoints[current + 1];
            }
        }
    }

    if (!destination && !virtualLineClear(x, y, group.targetX, group.targetY, flags)) {
        return { x: record.x, y: record.y, alternate: Boolean(group.alternate), blocked: true };
    }

    const dx = f(f((destination?.[0] ?? group.targetX) + 0.5) - record.x);
    const dy = f(f((destination?.[1] ?? group.targetY) + 0.5) - record.y);
    const length = f(Math.sqrt(f(f(dx * dx) + f(dy * dy))));

    return moveVirtual(record, f(f(f(dx / length) * f(0.06)) * multiplier), f(f(f(dy / length) * f(0.06)) * multiplier),
        Boolean(group.alternate), bounds, flags);
}

/**
 * Preserves original scanline output order for group scatter RNG indices.
 *
 * @param {number} x - Source square x.
 * @param {number} y - Source square y.
 * @param {function(number, number): number} flags - Actual collision bits.
 * @param {object|null} [region] - Actual native flood bounds, or the original 8-by-8 chunk.
 * @returns {Array<number[]>} Reachable world squares in native output order.
 */
function redistributionSquares(x, y, flags, region = null) {
    const left = region?.left ?? Math.trunc(x / 8) * 8;
    const top = region?.top ?? Math.trunc(y / 8) * 8;
    const width = region?.width ?? 8;
    const reached = new Uint8Array(width * width);
    const pending = [[x, y]];
    const squares = [];
    /**
     * Tests the native bounded unvisited-edge callback.
     *
     * @param {number} sx - Source x.
     * @param {number} sy - Source y.
     * @param {number} tx - Destination x.
     * @param {number} ty - Destination y.
     * @returns {boolean} Whether the edge is open and unvisited.
     */
    const cross = (sx, sy, tx, ty) => tx >= left && tx < left + width && ty >= top && ty < top + width
        && !reached[tx - left + (ty - top) * width] && !populationBlocked(flags, sx, sy, tx, ty);

    while (pending.length) {
        const next = pending.pop();
        const sx = next[0];
        let sy = next[1];

        if (sx - left === -1) {
            break;
        }

        while (cross(sx, sy, sx, sy - 1)) {
            sy--;
        }

        let spanLeft = false;
        let spanRight = false;
        let down;

        do {
            if (squares.length === width * width) {
                return squares;
            }

            squares.push([sx, sy]);
            reached[sx - left + (sy - top) * width] = 1;

            for (const side of [-1, 1]) {
                const open = cross(sx, sy, sx + side, sy);
                const span = side === -1 ? spanLeft : spanRight;

                const enqueue = open && (!span || !cross(sx + side, sy, sx + side, sy - 1));

                if (enqueue && pending.length === width * width) {
                    return squares;
                }

                if (enqueue) {
                    pending.push([sx + side, sy]);
                }

                if (side === -1) {
                    spanLeft = open;
                } else {
                    spanRight = open;
                }
            }

            down = cross(sx, sy, sx, sy + 1);
            sy++;
        } while (down);
    }

    return squares;
}

/**
 * Applies the original successful respawn callback's bounded flood and record allocation.
 *
 * @param {object} input - Actual path endpoint, cell state, RNG and allocation identity.
 * @param {number} input.x - Actual path endpoint x.
 * @param {number} input.y - Actual path endpoint y.
 * @param {number} input.cellX - Original owning cell x.
 * @param {number} input.cellY - Original owning cell y.
 * @param {number} input.count - Actual requested allocation count.
 * @param {number} input.idStart - Original next record identity.
 * @param {NativeMT} input.rng - Original native random owner.
 * @param {function(number, number): number} input.flags - Actual global collision flags.
 * @param {function(number, number): boolean} input.loaded - Actual loaded-area mask.
 * @returns {object} Actual allocated records, covered chunk clocks and next identity.
 */
function respawnPlacement({ x, y, cellX, cellY, count, idStart, rng, flags, loaded }) {
    const left = Math.max(cellX * 256, Math.min((cellX + 1) * 256 - 40, Math.trunc(x / 8) * 8 - 16));
    const top = Math.max(cellY * 256, Math.min((cellY + 1) * 256 - 40, Math.trunc(y / 8) * 8 - 16));
    const squares = redistributionSquares(x, y, (sx, sy) => flags(sx, sy) | (loaded(sx, sy) ? 1 : 0), { left, top, width: 40 });
    const records = [];
    const chunks = [];
    let nextID = idStart;

    if (squares.length) {
        for (let cy = 0; cy < 5; cy++) {
            for (let cx = 0; cx < 5; cx++) {
                chunks.push(Math.trunc(left / 8) + cx - cellX * 32 + (Math.trunc(top / 8) + cy - cellY * 32) * 32);
            }
        }

        for (let i = 0; i < Math.min(count, squares.length); i++) {
            const square = squares[rng.bounded(squares.length)];
            const direction = rng.bounded(8);

            records.push({
                x: square[0] + 0.5, y: square[1] + 0.5, z: 0, direction, outfit: 0, state: 4,
                px: -2_147_483_648, py: -2_147_483_648, id: nextID++,
            });
        }
    }

    return { records, chunks, nextID };
}

/**
 * Reconstructs original grouped members at reachable square centers on completion/publication.
 *
 * @param {object} group - Actual moving records with current leader position.
 * @param {NativeMT} rng - Original random state.
 * @param {function(number, number): number} flags - Actual collision bits.
 * @returns {Array<object>} Ordered records with original scatter positions.
 */
function scatterVirtual(group, rng, flags) {
    if (group.records.length === 1) {
        return group.records.map((record) => ({ ...record }));
    }

    const leader = group.records[0];
    const squares = redistributionSquares(Math.floor(leader.x), Math.floor(leader.y), flags);

    return group.records.map((record) => {
        const [x, y] = squares[rng.bounded(squares.length)];

        return { ...record, x: f(x + 0.5), y: f(y + 0.5) };
    });
}

/**
 * Selects the original distance-scaled jitter around a heard sound.
 *
 * @param {object} sound - Original integer x/y/radius/volume event.
 * @param {number} x - Original source center x.
 * @param {number} y - Original source center y.
 * @param {NativeMT} rng - Actual native random state.
 * @returns {number[]} Original integer target x/y.
 */
function soundTarget(sound, x, y, rng) {
    const distance = f(Math.abs(f(f(sound.y + 0.5) - y)) + Math.abs(f(f(sound.x + 0.5) - x)));

    return [Math.floor(f(sound.x + f(rng.real(-distance, distance) * 0.25))),
        Math.floor(f(sound.y + f(rng.real(-distance, distance) * 0.25)))];
}

/**
 * Forms original sound-following groups from ordered affected global chunks.
 *
 * @param {Array<object>} chunks - Actual cx/cy and records in native y/x order.
 * @param {object} sound - Actual original sound event.
 * @param {NativeMT} rng - Actual native random state.
 * @param {function(number, number): number} flags - Actual collision bits.
 * @returns {Array<object>} Original groups of up to26 connected ground records.
 */
function worldSoundGroups(chunks, sound, rng, flags) {
    const groups = [];

    for (const chunk of chunks) {
        const centerX = chunk.cx * 8 + 4;
        const centerY = chunk.cy * 8 + 4;
        const dx = f(f(sound.x + 0.5) - centerX);
        const dy = f(f(sound.y + 0.5) - centerY);
        const distance = f(f(dy * dy) + f(dx * dx));

        if (distance > Math.imul(sound.radius, sound.radius) || distance < 100) {
            continue;
        }

        const eligible = chunk.records.filter((record) => Math.floor(record.z) === 0 && !(record.state & 8)
            && !(flags(Math.floor(record.x), Math.floor(record.y)) & 0x19));

        while (eligible.length) {
            const [targetX, targetY] = soundTarget(sound, centerX, centerY, rng);
            const first = eligible.shift();
            const x = Math.floor(first.x);
            const y = Math.floor(first.y);
            const left = Math.trunc(x / 8) * 8;
            const top = Math.trunc(y / 8) * 8;
            const reachable = redistributionReachable(x, y, flags);
            const records = [first];

            for (let i = 0; i < eligible.length && records.length < 26; i++) {
                const dx = Math.floor(eligible[i].x) - left;
                const dy = Math.floor(eligible[i].y) - top;

                if (dx >= 0 && dx < 8 && dy >= 0 && dy < 8 && reachable[dx + dy * 8]) {
                    records.push(...eligible.splice(i--, 1));
                }
            }

            groups.push({ records, targetX, targetY, sound, followSteps: 0, alternate: false });
        }
    }

    return groups;
}

/**
 * Enumerates original affected chunks in worker y/x order, excluding the inner10-square region.
 *
 * @param {object} sound - Original integer sound fields.
 * @returns {Array<number[]>} Original affected global chunk coordinates.
 */
function soundChunks(sound) {
    const chunks = [];

    /* eslint-disable unicorn/prefer-math-trunc -- Native int32 addition wraps before chunk division. */
    for (let cy = Math.trunc(((sound.y - sound.radius) | 0) / 8); cy <= Math.trunc(((sound.y + sound.radius) | 0) / 8); cy++) {
        for (let cx = Math.trunc(((sound.x - sound.radius) | 0) / 8); cx <= Math.trunc(((sound.x + sound.radius) | 0) / 8); cx++) {
            const dx = f(f(sound.x + 0.5) - f(cx * 8 + 4));
            const dy = f(f(sound.y + 0.5) - f(cy * 8 + 4));
            const squared = f(f(dy * dy) + f(dx * dx));

            if (squared >= 100 && squared <= Math.imul(sound.radius, sound.radius)) {
                chunks.push([cx, cy]);
            }
        }
    }
    /* eslint-enable unicorn/prefer-math-trunc */

    return chunks;
}

/**
 * Applies original0203a0's ordered per-player target update, including first cancellation insertion.
 *
 * @param {number[][]} targets - Worker-owned triples in native insertion order.
 * @param {number[]} request - Original signed player ID, x and y.
 */
function applyAggroTarget(targets, request) {
    const index = targets.findIndex((target) => target[0] === request[0]);

    if (index === -1) {
        targets.push([...request]);
    } else if (request[1] === -1 && request[2] === -1) {
        targets.splice(index, 1);
    } else {
        targets[index][1] = request[1];
        targets[index][2] = request[2];
    }
}

/**
 * Places original00dca0 point-horde records in bounded flood/perimeter and quarter-square order.
 *
 * @param {object} request - Original x/y, targetX/targetY and positive count.
 * @param {number[]} bounds - Actual square minX/minY/maxX/maxY.
 * @param {function(number, number): number} flags - Original global collision owner.
 * @param {NativeMT} rng - Actual original random owner.
 * @param {number} idStart - Actual next persistent identity.
 * @returns {object} Actual allocated records and next persistent identity.
 */
function pointHorde(request, bounds, flags, rng, idStart) {
    const { x, y, targetX, targetY, count } = request;
    const records = [];
    let nextID = idStart;

    if (!populationSpawnable(flags, x, y)) {
        return { records, nextID };
    }

    const width = 40;
    const left = Math.min(Math.max(Math.trunc(x / 8) * 8 - 16, bounds[0]), bounds[2] - width);
    const top = Math.min(Math.max(Math.trunc(y / 8) * 8 - 16, bounds[1]), bounds[3] - width);
    const reached = new Set(redistributionSquares(x, y, flags, { left, top, width }).map((point) => `${point[0]},${point[1]}`));
    /**
     * Allocates at most four actual records at one reached native square.
     *
     * @param {number} sx - Original candidate square x.
     * @param {number} sy - Original candidate square y.
     */
    const place = (sx, sy) => {
        if (!reached.has(`${sx},${sy}`)) {
            return;
        }

        for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
            if (records.length === count) {
                return;
            }

            records.push({
                x: sx + ox, y: sy + oy, z: 0, direction: rng.bounded(8), outfit: 0, state: 4,
                px: Math.floor(targetX), py: Math.floor(targetY), id: nextID++,
            });
        }
    };

    place(x, y);

    for (let radius = 1; radius < width && records.length < count; radius++) {
        for (const sy of [y - radius, y + radius]) {
            if (sy >= top && sy < top + width) {
                for (let sx = Math.max(x - radius, left); sx < Math.min(x + radius + 1, left + width); sx++) {
                    place(sx, sy);
                }
            }
        }

        for (const sx of [x - radius, x + radius]) {
            if (sx >= left && sx < left + width) {
                for (let sy = Math.max(y - radius + 1, top); sy < Math.min(y + radius, top + width); sy++) {
                    place(sx, sy);
                }
            }
        }
    }

    return { records, nextID };
}

/**
 * Selects original01d240's first nearest target below 300 using signed-int arithmetic.
 *
 * @param {number[][]} targets - Ordered actual worker target triples.
 * @param {number} x - Original floored square x.
 * @param {number} y - Original floored square y.
 * @returns {number[]|null} Borrowed winning triple, or no target.
 */
function nearestAggroTarget(targets, x, y) {
    let best = 2_147_483_647;
    let selected = null;

    for (const target of targets) {
        /* Native signed-int overflow is observable here; truncation would change selection. */
        /* eslint-disable unicorn/prefer-math-trunc */
        const dx = (target[1] - x) | 0;
        const dy = (target[2] - y) | 0;
        const distance = ((dx < 0 ? -dx : dx) + (dy < 0 ? -dy : dy)) | 0;
        /* eslint-enable unicorn/prefer-math-trunc */

        if (distance < best && distance < 300) {
            best = distance;
            selected = target;
        }
    }

    return selected;
}

export { pointHorde, applyAggroTarget, nearestAggroTarget, populationSpawnable, populationTarget, respawnClock, respawnRequest, respawnPlacement, mapCollisionPath, NativeMT, collision, generate, redistributionReachable, redistributionSquares, redistributionGroups, virtualLineClear, moveVirtual, advanceVirtual, scatterVirtual, soundTarget, worldSoundGroups, soundChunks };
