const directions = [[0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1]];
const propagationOrder = [2, 6, 0, 4, 1, 7, 5, 3];
const cornerNeighbors = [
    [[1, 2], [0, 3], [2, 1]],
    [[7, 3], [0, 2], [6, 0]],
    [[5, 0], [4, 1], [6, 3]],
    [[3, 1], [4, 0], [2, 2]],
];
const flatVisionBits = 0x3_FE_00;

/**
 * Rejects inputs outside the native-reference qualification.
 *
 * @param {string} reason - Unsupported input description.
 * @throws {RangeError} Always, with the unsupported boundary.
 */
function unsupported(reason) {
    throw new RangeError(`Unsupported lighting boundary: ${reason}`);
}

/**
 * Requires an integer within an inclusive range.
 *
 * @param {number} value - Caller-supplied value.
 * @param {number} minimum - Smallest admitted integer.
 * @param {number} maximum - Largest admitted integer.
 * @param {string} name - Input description for failures.
 */
function integer(value, minimum, maximum, name) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        unsupported(name);
    }
}

/**
 * Validates a complete flat indoor scene before calculation begins.
 *
 * @param {object} scene - Geometry and lights from the JNI transport.
 */
function validate(scene) {
    if (!scene || typeof scene !== 'object') {
        unsupported('scene');
    }

    const { width, height, cells, lights, player, seen } = scene;

    integer(width, 8, 24, 'region width');
    integer(height, 8, 16, 'region height');

    if (width % 8 || height % 8 || !Array.isArray(cells) || cells.length !== width * height
        || !Array.isArray(lights) || lights.length > 5 || !Array.isArray(player) || player.length !== 2) {
        unsupported('complete chunk geometry, player or static-light extent');
    }

    for (const cell of cells) {
        if (!cell || typeof cell !== 'object') {
            unsupported('initially missing square');
        }

        integer(cell.mask, 0, 255, 'flat adjacency');
        integer(cell.vision, 0, flatVisionBits, 'vision matrix');

        if ((cell.vision & ~flatVisionBits) !== 0) {
            unsupported('vertical vision matrix');
        }
    }

    if (!Array.from(player).every(Number.isFinite) || player[0] < 0 || player[1] < 0
        || player[0] >= width || player[1] >= height) {
        unsupported('player position');
    }

    for (const x of [0.5, width - 0.5]) {
        for (const y of [0.5, height - 0.5]) {
            if (Math.hypot(x - player[0], y - player[1]) >= 20) {
                unsupported('far-field vision cone');
            }
        }
    }

    if (seen !== undefined && (!Array.isArray(seen) || seen.length !== cells.length
        || Array.from(seen).some((value) => typeof value !== 'boolean'))) {
        unsupported('seen history');
    }

    const identifiers = new Set();

    for (const light of lights) {
        if (!light || typeof light !== 'object') {
            unsupported('static light');
        }

        integer(light.id, -2_147_483_648, 2_147_483_647, 'light identifier');
        integer(light.x, 0, width - 1, 'light X');
        integer(light.y, 0, height - 1, 'light Y');
        integer(light.radius, 1, 255, 'light radius');

        if (identifiers.has(light.id) || !Array.isArray(light.color) || light.color.length !== 3
            || Array.from(light.color).some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
            unsupported('unique static-light identifier or RGB');
        }

        identifiers.add(light.id);
    }
}

/**
 * Resolves a local coordinate without admitting cells outside the loaded region.
 *
 * @param {number} width - Region width in squares.
 * @param {number} height - Region height in squares.
 * @param {number} x - Local square X.
 * @param {number} y - Local square Y.
 * @returns {number} Row-major index, or minus one outside the region.
 */
function indexAt(width, height, x, y) {
    if (x < 0 || y < 0 || x >= width || y >= height) {
        return -1;
    }

    return y * width + x;
}

/**
 * Finds one directional neighbor.
 *
 * @param {object} scene - Validated scene.
 * @param {number} index - Current square index.
 * @param {number} direction - Original IsoDirections ordinal.
 * @returns {number} Neighbor index, or minus one outside the region.
 */
function neighbor(scene, index, direction) {
    const [dx, dy] = directions[direction];

    return indexAt(scene.width, scene.height, index % scene.width + dx, Math.floor(index / scene.width) + dy);
}

/**
 * Tests the original directional adjacency bit and loaded neighbor.
 *
 * @param {object} scene - Validated scene.
 * @param {number} index - Current square index.
 * @param {number} direction - Original IsoDirections ordinal.
 * @returns {boolean} Whether this propagation edge is admitted.
 */
function allowed(scene, index, direction) {
    return neighbor(scene, index, direction) >= 0 && (scene.cells[index].mask & 1 << direction) !== 0;
}

/**
 * Builds the native chunk and local-X/local-Y traversal order.
 *
 * @param {object} scene - Validated scene.
 * @returns {number[]} Square indices in native processing order.
 */
function traversalOrder(scene) {
    const order = [];

    for (let chunkY = 0; chunkY < scene.height; chunkY += 8) {
        for (let chunkX = 0; chunkX < scene.width; chunkX += 8) {
            for (let x = chunkX; x < chunkX + 8; x++) {
                for (let y = chunkY; y < chunkY + 8; y++) {
                    order.push(y * scene.width + x);
                }
            }
        }
    }

    return order;
}

/**
 * Takes the native per-channel maximum of two RGB triples.
 *
 * @param {number[]} first - First integer RGB triple.
 * @param {number[]} second - Second integer RGB triple.
 * @returns {number[]} Detached maximum RGB triple.
 */
function maximumColor(first, second) {
    return first.map((value, channel) => Math.max(value, second[channel]));
}

/**
 * Packs native low-byte-red RGB into an integer.
 *
 * @param {number[]} color - Integer RGB triple.
 * @returns {number} Packed signed integer.
 */
function pack(color) {
    return color[0] | color[1] << 8 | color[2] << 16;
}

/**
 * Updates one neighbor's ordered records only when a source reaches it sooner.
 *
 * @param {object[]} source - Source records.
 * @param {object[]} target - Mutable target records.
 * @param {number} cost - Native float32 edge cost.
 * @returns {boolean} Whether any record improved.
 */
function relax(source, target, cost) {
    let improved = false;

    for (const record of source) {
        const distance = Math.fround(record.distance + cost);

        if (distance > Math.fround(record.light.radius + 0.01)) {
            continue;
        }

        const existing = target.find((candidate) => candidate.light.id === record.light.id);

        if (existing && existing.distance <= distance) {
            continue;
        }

        if (existing) {
            existing.distance = distance;
        } else {
            target.push({ ...record, distance });
        }

        improved = true;
    }

    return improved;
}

/**
 * Relaxes native static-light records through arbitrary admitted opaque geometry.
 * Native0x8650 drains each seed FIFO separately;0x4800 retains the shortest record.
 *
 * @param {object} scene - Validated scene.
 * @param {number[]} order - Native square traversal.
 * @returns {object[][]} Ordered light records for every square.
 */
function propagate(scene, order) {
    const records = scene.cells.map(() => []);
    const seeds = [];

    for (const index of order) {
        for (const light of scene.lights) {
            if (light.y * scene.width + light.x === index) {
                const color = light.color.map((value) => Math.trunc(Math.fround(Math.fround(value) * 255)));

                records[index].push({ light, distance: 0, color });

                if (!seeds.includes(index)) {
                    seeds.push(index);
                }
            }
        }
    }

    for (const seed of seeds) {
        const queue = [seed];

        for (let cursor = 0; cursor < queue.length; cursor++) {
            const index = queue[cursor];

            for (const direction of propagationOrder) {
                if (!allowed(scene, index, direction)) {
                    continue;
                }

                const adjacent = neighbor(scene, index, direction);
                let cost = 1;

                if (direction % 2 !== 0) {
                    cost = Math.fround(Math.sqrt(2));
                }

                if (relax(records[index], records[adjacent], cost)) {
                    queue.push(adjacent);
                }
            }
        }
    }

    return records;
}

/**
 * Tests one original flat vision-matrix entry.
 *
 * @param {object} scene - Validated scene.
 * @param {number} index - Square owning the matrix.
 * @param {number} dx - Neighbor X delta.
 * @param {number} dy - Neighbor Y delta.
 * @returns {boolean} Whether the matrix permits this step.
 */
function clearVision(scene, index, dx, dy) {
    return (scene.cells[index].vision & 1 << dx + 1 + (dy + 1) * 3 + 9) === 0;
}

/**
 * Applies0x60e0/0x46b0 cardinal and bidirectional diagonal vision checks.
 *
 * @param {object} scene - Validated scene.
 * @param {number} x - New square X.
 * @param {number} y - New square Y.
 * @param {number} oldX - Previous square X.
 * @param {number} oldY - Previous square Y.
 * @returns {boolean} Whether the native LOS step remains visible.
 */
function visibleStep(scene, x, y, oldX, oldY) {
    const index = indexAt(scene.width, scene.height, x, y);
    const previous = indexAt(scene.width, scene.height, oldX, oldY);
    const dx = oldX - x;
    const dy = oldY - y;

    if (index < 0 || previous < 0) {
        return true;
    }

    if (!clearVision(scene, index, dx, dy)) {
        return false;
    }

    if (dx && dy) {
        return clearVision(scene, index, dx, 0) && clearVision(scene, index, 0, dy)
            && clearVision(scene, previous, -dx, -dy) && clearVision(scene, previous, -dx, 0)
            && clearVision(scene, previous, 0, -dy);
    }

    return true;
}

/**
 * Traces a native float32 DDA ray and caches every intermediate result.
 *
 * @param {object} scene - Validated scene.
 * @param {Map<number, boolean>} cache - Per-player LOS cache for this geometry.
 * @param {number} target - Target square index.
 * @returns {boolean} Whether the target has unblocked LOS.
 */
function visible(scene, cache, target) {
    if (cache.has(target)) {
        return cache.get(target);
    }

    const targetX = target % scene.width;
    const targetY = Math.floor(target / scene.width);
    const playerX = Math.floor(scene.player[0]);
    const playerY = Math.floor(scene.player[1]);
    const dx = targetX - playerX;
    const dy = targetY - playerY;
    let x = playerX;
    let y = playerY;
    let previousX = x;
    let previousY = y;
    let unblocked = true;

    if (Math.abs(dx) > Math.abs(dy)) {
        const sign = Math.sign(dx);
        const slope = Math.fround(Math.fround(dy / dx) * sign);
        let fractionalY = Math.fround(playerY + 0.5);

        while (x !== targetX) {
            x += sign;
            fractionalY = Math.fround(fractionalY + slope);
            y = Math.floor(fractionalY);
            unblocked = unblocked && visibleStep(scene, x, y, previousX, previousY);

            const index = indexAt(scene.width, scene.height, x, y);

            if (!cache.has(index)) {
                cache.set(index, unblocked);
            }

            previousX = x;
            previousY = y;
        }
    } else if (dy) {
        const sign = Math.sign(dy);
        const slope = Math.fround(Math.fround(dx / dy) * sign);
        let fractionalX = Math.fround(playerX + 0.5);

        while (y !== targetY) {
            y += sign;
            fractionalX = Math.fround(fractionalX + slope);
            x = Math.floor(fractionalX);
            unblocked = unblocked && visibleStep(scene, x, y, previousX, previousY);

            const index = indexAt(scene.width, scene.height, x, y);

            if (!cache.has(index)) {
                cache.set(index, unblocked);
            }

            previousX = x;
            previousY = y;
        }
    }

    cache.set(target, unblocked);

    return unblocked;
}

/**
 * Processes LOS in the native top-half/bottom-half order, which affects its cache.
 *
 * @param {object} scene - Validated scene.
 * @returns {boolean[]} Visibility for every square.
 */
function visibility(scene) {
    const cache = new Map();
    const output = Array.from({ length: scene.cells.length });

    for (let y = 0; y < scene.height / 2; y++) {
        for (let x = 0; x < scene.width; x++) {
            const index = y * scene.width + x;

            output[index] = visible(scene, cache, index);
        }
    }

    for (let y = scene.height - 1; y >= scene.height / 2; y--) {
        for (let x = 0; x < scene.width; x++) {
            const index = y * scene.width + x;

            output[index] = visible(scene, cache, index);
        }
    }

    return output;
}

/**
 * Averages darker squares with admitted brighter seen cardinal neighbors.
 *
 * @param {object} scene - Validated scene.
 * @param {boolean[]} seen - Current and retained seen state.
 * @returns {number[]} Native float32 darkness multipliers.
 */
function darknessMultipliers(scene, seen) {
    return scene.cells.map((cell, index) => {
        const own = Number(seen[index]);
        let sum = own;
        let count = 1;

        for (const direction of [0, 2, 4, 6]) {
            if (allowed(scene, index, direction)) {
                const adjacent = neighbor(scene, index, direction);
                const brightness = Number(seen[adjacent]);

                if (brightness > own) {
                    sum += brightness;
                    count++;
                }
            }
        }

        return Math.fround(sum / count);
    });
}

/**
 * Applies native integer attenuation, channel maxima, and float32 darkness.
 *
 * @param {object[][]} records - Per-square native light records.
 * @param {number[]} darkness - Per-square darkness multipliers.
 * @returns {number[][]} Per-square integer center RGB.
 */
function centerColors(records, darkness) {
    return records.map((squareRecords, index) => {
        let color = [0, 0, 0];

        for (const record of squareRecords) {
            const attenuation = Math.fround(1 - Math.fround(record.distance / record.light.radius));
            const attenuated = record.color.map((value) => Math.trunc(Math.fround(value * attenuation)));

            color = maximumColor(color, attenuated);
        }

        return color.map((value) => Math.trunc(Math.fround(Math.fround(Math.fround(value / 255) * darkness[index]) * 255)));
    });
}

/**
 * Takes a shared-corner maximum from the current three admitted neighbors.
 *
 * @param {object} scene - Validated scene.
 * @param {number[][][]} work - Per-square corner colors.
 * @param {number} index - Current square index.
 * @param {number} corner - Current corner index.
 * @returns {number[]} Shared-corner maximum RGB.
 */
function sharedCorner(scene, work, index, corner) {
    let color = work[index][corner];

    for (const [direction, adjacentCorner] of cornerNeighbors[corner]) {
        if (allowed(scene, index, direction)) {
            color = maximumColor(color, work[neighbor(scene, index, direction)][adjacentCorner]);
        }
    }

    return color;
}

/**
 * Calculates native-reference lighting for one retained flat indoor opaque region.
 * The bounded closure and native function provenance are in lighting-provenance.md.
 *
 * @param {object} scene - Complete local geometry, static lights, player and optional seen history.
 * @returns {number[][]} One49-int native payload for every row-major square.
 */
export function calculateLighting(scene) {
    validate(scene);

    const order = traversalOrder(scene);
    const records = propagate(scene, order);
    const canSee = visibility(scene);
    const seen = canSee.map((value, index) => value || Boolean(scene.seen?.[index]));
    const darkness = darknessMultipliers(scene, seen);
    const colors = centerColors(records, darkness);
    const work = scene.cells.map(() => []);

    for (const index of order) {
        for (let corner = 0; corner < 4; corner++) {
            let color = colors[index];

            for (const [direction] of cornerNeighbors[corner]) {
                if (allowed(scene, index, direction)) {
                    color = maximumColor(color, colors[neighbor(scene, index, direction)]);
                }
            }

            work[index][corner] = color;
        }
    }

    for (const index of order) {
        for (let corner = 0; corner < 4; corner++) {
            work[index][corner] = sharedCorner(scene, work, index, corner);
        }
    }

    const output = scene.cells.map(() => new Int32Array(49));

    for (const index of order) {
        const payload = output[index];

        payload[0] = Number(seen[index]) | Number(canSee[index]) * 6;
        payload[1] = pack(colors[index]);
        payload[2] = Math.trunc(Math.fround(darkness[index] * 100_000));
        payload[3] = Number(seen[index]) * 100_000;

        for (let corner = 0; corner < 4; corner++) {
            const color = sharedCorner(scene, work, index, corner);

            payload[5 + corner] = pack(color) | 0xFF_00_00_00;
            payload[9 + corner] = payload[5 + corner];
        }

        payload[13] = records[index].length;

        for (const [recordIndex, record] of records[index].entries()) {
            const { light, color } = record;

            payload.set([light.id, light.x, light.y, 32, light.radius, pack(color)], 14 + recordIndex * 6);
        }
    }

    return output.map((payload) => [...payload]);
}
