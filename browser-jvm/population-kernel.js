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
 * @param {function(number, number): number} [root0.globalFlags] - Original global square collision lookup.
 * @returns {object} Original target chunks, natural records and allocator totals.
 */
function generate({ rng, density, chunks, config, constants, directions, cellX, cellY, idStart = 1, age = 0, globalFlags }) {
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
    const dx = tx - x;
    const dy = ty - y;
    const horizontal = Math.abs(dy) < Math.abs(dx);
    const step = (horizontal ? dx : dy) < 0 ? -1 : 1;
    let position = f((horizontal ? y : x) + 0.5);

    while ((horizontal ? x !== tx : y !== ty) && limit-- > 0) {
        const before = Math.trunc(position);

        position = f(position + f(f((horizontal ? dy : dx) / (horizontal ? dx : dy)) * step));
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
 * Advances the original ordinary-game virtual leader; Last Stand uses a separate native path.
 *
 * @param {object} group - Original-derived records, targetX/targetY and alternation bit.
 * @param {number} multiplier - Actual original worker time multiplier.
 * @param {number[]} bounds - Original square bounds.
 * @param {function(number, number): number} flags - Actual original collision bits.
 * @returns {object} Next leader position and whether original fallback stopped movement.
 */
function advanceVirtual(group, multiplier, bounds, flags) {
    const record = group.records[0];
    const x = Math.floor(record.x);
    const y = Math.floor(record.y);

    if ((x === group.targetX && y === group.targetY)
        || !virtualLineClear(x, y, group.targetX, group.targetY, flags)) {
        return { x: record.x, y: record.y, alternate: Boolean(group.alternate), blocked: true };
    }

    const dx = f(f(group.targetX + 0.5) - record.x);
    const dy = f(f(group.targetY + 0.5) - record.y);
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
 * @returns {Array<number[]>} Reachable world squares in native output order.
 */
function redistributionSquares(x, y, flags) {
    const left = Math.trunc(x / 8) * 8;
    const top = Math.trunc(y / 8) * 8;
    const reached = new Uint8Array(64);
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
    const cross = (sx, sy, tx, ty) => tx >= left && tx < left + 8 && ty >= top && ty < top + 8
        && !reached[tx - left + (ty - top) * 8] && !populationBlocked(flags, sx, sy, tx, ty);

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
            if (squares.length === 64) {
                return squares;
            }

            squares.push([sx, sy]);
            reached[sx - left + (sy - top) * 8] = 1;

            for (const side of [-1, 1]) {
                const open = cross(sx, sy, sx + side, sy);
                const span = side === -1 ? spanLeft : spanRight;

                const enqueue = open && (!span || !cross(sx + side, sy, sx + side, sy - 1));

                if (enqueue && pending.length === 64) {
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

export { populationTarget, respawnClock, NativeMT, collision, generate, redistributionReachable, redistributionSquares, redistributionGroups, virtualLineClear, moveVirtual, advanceVirtual, scatterVirtual, soundTarget, worldSoundGroups, soundChunks };
