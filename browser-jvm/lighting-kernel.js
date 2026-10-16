const directions = [[0, -1, 0], [-1, -1, 0], [-1, 0, 0], [-1, 1, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0], [1, -1, 0], [0, 0, 1], [0, 0, -1]];
const propagationOrder = [2, 6, 0, 4, 1, 7, 5, 3, 8, 9];
const cornerNeighbors = [
    [[1, 2], [0, 3], [2, 1]],
    [[7, 3], [0, 2], [6, 0]],
    [[5, 0], [4, 1], [6, 3]],
    [[3, 1], [4, 0], [2, 2]],
];

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
 * Validates the loaded indoor levels and opaque geometry before calculation begins.
 *
 * @param {object} scene - Geometry and lights from the JNI transport.
 */
function validate(scene) {
    if (!scene || typeof scene !== 'object') {
        unsupported('scene');
    }

    const { width, height, cells, lights, player, seen, minimum, maximum } = scene;

    integer(width, 8, 24, 'region width');
    integer(height, 8, 24, 'region height');
    integer(minimum, 0, 63, 'minimum level');
    integer(maximum, minimum, 63, 'maximum level');

    if (width % 8 || height % 8 || !Array.isArray(cells) || cells.length !== width * height * (maximum - minimum + 1)
        || !Array.isArray(lights) || lights.length > 7 || !Array.isArray(player) || player.length !== 3) {
        unsupported('complete chunk geometry, player or static-light extent');
    }

    for (const cell of cells) {
        if (cell === null) {
            continue;
        }

        if (!cell || typeof cell !== 'object') {
            unsupported('initially missing square');
        }

        integer(cell.mask, 0, 255, 'flat adjacency');
        integer(cell.vision, 0, 0x7_FF_FF_FF, 'vision matrix');

        for (const name of ['up', 'down', 'stairs']) {
            if (cell[name] !== undefined && typeof cell[name] !== 'boolean') {
                unsupported('vertical adjacency flags');
            }
        }
    }

    if (!Array.from(player).every(Number.isFinite) || player[0] < 0 || player[1] < 0
        || player[0] >= width || player[1] >= height || player[2] < minimum || player[2] > maximum) {
        unsupported('player position');
    }

    integer(player[2], minimum, maximum, 'player native level');

    if (scene.origin !== undefined) {
        if (!Array.isArray(scene.origin) || scene.origin.length !== 3 || scene.origin[2] !== 0) {
            unsupported('world origin');
        }

        for (const coordinate of scene.origin.slice(0, 2)) {
            integer(coordinate, 0, 65_535 * 8, 'world origin');

            if (coordinate % 8 !== 0) {
                unsupported('world chunk origin');
            }
        }
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
        integer(light.z, minimum, maximum, 'light level');
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
 * Resolves a level-major square without crossing the loaded region.
 *
 * @param {object} scene - Validated region.
 * @param {number} x - Local X.
 * @param {number} y - Local Y.
 * @param {number} z - Native level.
 * @returns {number} Level-major index, or minus one for an absent square.
 */
function squareIndex(scene, x, y, z) {
    const flat = indexAt(scene.width, scene.height, x, y);

    if (flat < 0 || z < scene.minimum || z > scene.maximum) {
        return -1;
    }

    const index = (z - scene.minimum) * scene.width * scene.height + flat;

    return scene.cells[index] === null ? -1 : index;
}

/**
 * Decodes one level-major square index.
 *
 * @param {object} scene - Validated region.
 * @param {number} index - Square index.
 * @returns {number[]} Local X, local Y and native level.
 */
function coordinates(scene, index) {
    const plane = scene.width * scene.height;

    return [index % scene.width, Math.floor(index % plane / scene.width), scene.minimum + Math.floor(index / plane)];
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
    const [dx, dy, dz] = directions[direction];
    const [x, y, z] = coordinates(scene, index);

    return squareIndex(scene, x + dx, y + dy, z + dz);
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
    const cell = scene.cells[index];

    if (!cell || neighbor(scene, index, direction) < 0) {
        return false;
    }

    if (direction === 8) {
        return Boolean(cell.up);
    }

    if (direction === 9) {
        return Boolean(cell.down);
    }

    return (cell.mask & 1 << direction) !== 0;
}

/**
 * Tests the native combined edge, including either endpoint's cardinal bit.
 * Native0x5d80/0x5d60 builds this union for propagation and vertex neighbors.
 * Diagonal edges and darkness averaging retain the original directed mask.
 *
 * @param {object} scene - Validated scene.
 * @param {number} index - Source square index.
 * @param {number} direction - Original direction ordinal.
 * @returns {boolean} Whether the native combined adjacency admits this edge.
 */
function propagationAllowed(scene, index, direction) {
    if (allowed(scene, index, direction)) {
        return true;
    }

    if (direction >= 8 || direction % 2 !== 0) {
        return false;
    }

    const adjacent = neighbor(scene, index, direction);

    return adjacent >= 0 && allowed(scene, adjacent, (direction + 4) % 8);
}

/**
 * Builds the native chunk and local-X/local-Y traversal order.
 *
 * @param {object} scene - Validated scene.
 * @param {boolean} [descending] - Whether native source seeding visits upper levels first.
 * @returns {number[]} Square indices in native processing order.
 */
function traversalOrder(scene, descending = false) {
    const order = [];

    for (let chunkY = 0; chunkY < scene.height; chunkY += 8) {
        for (let chunkX = 0; chunkX < scene.width; chunkX += 8) {
            order.push(...chunkOrder(scene, chunkX, chunkY, descending));
        }
    }

    return order;
}

/**
 * Visits one native chunk's levels and local squares in their original order.
 *
 * @param {object} scene - Validated region.
 * @param {number} chunkX - Local chunk origin X.
 * @param {number} chunkY - Local chunk origin Y.
 * @param {boolean} descending - Whether source seeding visits upper levels first.
 * @returns {number[]} Present square indices.
 */
function chunkOrder(scene, chunkX, chunkY, descending) {
    const order = [];

    for (let step = 0; step <= scene.maximum - scene.minimum; step++) {
        let z = scene.minimum + step;

        if (descending) {
            z = scene.maximum - step;
        }

        for (let x = chunkX; x < chunkX + 8; x++) {
            for (let y = chunkY; y < chunkY + 8; y++) {
                const index = squareIndex(scene, x, y, z);

                if (index >= 0) {
                    order.push(index);
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
        } else if (target.length < 5) {
            target.push({ ...record, distance });
        } else {
            let worst = 0;

            for (let candidate = 1; candidate < target.length; candidate++) {
                if (Math.fround(target[candidate].distance / target[candidate].light.radius)
                    > Math.fround(target[worst].distance / target[worst].light.radius)) {
                    worst = candidate;
                }
            }

            if (Math.fround(distance / record.light.radius)
                >= Math.fround(target[worst].distance / target[worst].light.radius)) {
                continue;
            }

            target[worst] = { ...record, distance };
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
            if (squareIndex(scene, light.x, light.y, light.z) === index) {
                if (records[index].length >= 5) {
                    unsupported('more than five coincident source lights');
                }

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
                if (!propagationAllowed(scene, index, direction)) {
                    continue;
                }

                const adjacent = neighbor(scene, index, direction);
                let cost = 1;

                if (direction >= 8) {
                    cost = 3;
                } else if (direction % 2 !== 0) {
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
 * Tests one entry of the original 27-bit vision matrix.
 *
 * @param {object} scene - Validated region.
 * @param {number} index - Matrix-owning square, or minus one when absent.
 * @param {number} dx - Neighbor X delta.
 * @param {number} dy - Neighbor Y delta.
 * @param {number} dz - Neighbor level delta.
 * @returns {boolean} Whether this matrix entry is clear.
 */
function clearVision(scene, index, dx, dy, dz) {
    return index < 0 || (scene.cells[index].vision & 1 << dx + 1 + (dy + 1) * 3 + (dz + 1) * 9) === 0;
}

/**
 * Applies native stair-level adjustment and bidirectional diagonal vision checks.
 *
 * @param {object} scene - Validated region.
 * @param {number[]} current - New ray square coordinates.
 * @param {number[]} previous - Previous ray square coordinates.
 * @returns {boolean} Whether this native LOS step is clear.
 */
function visibleStep(scene, current, previous) {
    let index = squareIndex(scene, ...current);
    const oldIndex = squareIndex(scene, ...previous);

    if (index < 0 || oldIndex < 0) {
        return true;
    }

    const dx = previous[0] - current[0];
    const dy = previous[1] - current[1];
    let dz = previous[2] - current[2];

    if (dx || dy) {
        if (dz === 1 && scene.cells[index].stairs) {
            index = squareIndex(scene, current[0], current[1], current[2] + 1);
            dz = 0;
        } else if (dz === -1 && scene.cells[oldIndex].stairs) {
            dz = 0;
        }
    }

    if (!clearVision(scene, index, dx, dy, dz)) {
        return false;
    }

    if (dx && dy) {
        return clearVision(scene, index, dx, 0, dz) && clearVision(scene, index, 0, dy, dz)
            && clearVision(scene, oldIndex, -dx, -dy, -dz) && clearVision(scene, oldIndex, -dx, 0, -dz)
            && clearVision(scene, oldIndex, 0, -dy, -dz);
    }

    return true;
}

/**
 * Traces the native float32 three-axis DDA and caches intermediate squares.
 *
 * @param {object} scene - Validated region.
 * @param {Map<number, boolean>} cache - Original per-player LOS cache.
 * @param {number} target - Target square index.
 * @returns {boolean} Whether native LOS reaches this square.
 */
function visible(scene, cache, target) {
    const destination = coordinates(scene, target);

    if (destination[2] === scene.player[2] - 1 && scene.cells[target].stairs) {
        destination[2] = scene.player[2];
    }

    const cacheIndex = (destination[2] - scene.minimum) * scene.width * scene.height
        + destination[1] * scene.width + destination[0];

    if (cache.has(cacheIndex)) {
        return cache.get(cacheIndex);
    }

    const current = scene.player.map(Math.floor);
    const delta = destination.map((value, axis) => value - current[axis]);
    const absolute = delta.map(Math.abs);
    let axis = 2;

    if (absolute[0] > absolute[1] && absolute[0] > absolute[2]) {
        axis = 0;
    } else if (absolute[1] >= absolute[0] && absolute[1] > absolute[2]) {
        axis = 1;
    }

    const sign = Math.sign(delta[axis]);
    // Native0xde50 accumulates float32 ray fractions in world coordinates.
    const fraction = current.map((value, dimension) => Math.fround(value + 0.5 + (scene.origin?.[dimension] ?? 0)));
    const slope = delta.map((value) => Math.fround(Math.fround(value / delta[axis]) * sign));
    let previous = [...current];
    let unblocked = true;

    while (current[axis] !== destination[axis]) {
        for (let dimension = 0; dimension < 3; dimension++) {
            if (dimension === axis) {
                current[dimension] += sign;
            } else {
                fraction[dimension] = Math.fround(fraction[dimension] + slope[dimension]);
                current[dimension] = Math.floor(fraction[dimension]) - (scene.origin?.[dimension] ?? 0);
            }
        }

        unblocked = unblocked && visibleStep(scene, current, previous);
        const index = (current[2] - scene.minimum) * scene.width * scene.height
            + current[1] * scene.width + current[0];

        if (!cache.has(index)) {
            cache.set(index, unblocked);
        }

        previous = [...current];
    }

    cache.set(cacheIndex, unblocked);

    return unblocked;
}

/**
 * Processes ascending levels with the native top-half and bottom-half row order.
 *
 * @param {object} scene - Validated region.
 * @returns {boolean[]} Visibility, including false for absent squares.
 */
function visibility(scene) {
    const cache = new Map();
    const output = scene.cells.map(() => false);

    for (let z = scene.minimum; z <= scene.maximum; z++) {
        for (let row = 0; row < scene.height; row++) {
            let y = row;

            if (row >= scene.height / 2) {
                y = scene.height - 1 - (row - scene.height / 2);
            }

            for (let x = 0; x < scene.width; x++) {
                const index = squareIndex(scene, x, y, z);

                if (index >= 0) {
                    output[index] = visible(scene, cache, index);
                }
            }
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

    for (const [direction, adjacentCorner] of cornerNeighbors[corner % 4]) {
        if (propagationAllowed(scene, index, direction)) {
            color = maximumColor(color, work[neighbor(scene, index, direction)][adjacentCorner + Math.floor(corner / 4) * 4]);
        }
    }

    return color;
}

/**
 * Calculates native-reference lighting for retained indoor opaque levels.
 * The bounded closure and native function provenance are in lighting-provenance.md.
 *
 * @param {object} scene - Complete local geometry, static lights, player and optional seen history.
 * @returns {number[][]} One49-int native payload for every row-major square.
 */
export function calculateLighting(scene) {
    scene = {
        ...scene, minimum: scene?.minimum ?? 32, maximum: scene?.maximum ?? 32,
        player: scene?.player?.length === 2 ? [...scene.player, 32] : scene?.player,
        lights: Array.isArray(scene?.lights) ? scene.lights.map((light) => ({ ...light, z: light?.z ?? 32 })) : scene?.lights,
    };
    validate(scene);

    const order = traversalOrder(scene);
    const records = propagate(scene, traversalOrder(scene, true));
    const canSee = visibility(scene);
    const seen = canSee.map((value, index) => value || Boolean(scene.seen?.[index]));
    const darkness = darknessMultipliers(scene, seen);
    const colors = centerColors(records, darkness);
    const work = scene.cells.map(() => []);
    const lower = colors.map((color, index) => allowed(scene, index, 9)
        ? maximumColor(color, colors[neighbor(scene, index, 9)])
        : color);
    const upper = colors.map((color, index) => allowed(scene, index, 8)
        ? maximumColor(color, colors[neighbor(scene, index, 8)])
        : color);

    for (const index of order) {
        for (let corner = 0; corner < 8; corner++) {
            const seeds = corner < 4 ? lower : upper;
            let color = seeds[index];

            for (const [direction] of cornerNeighbors[corner % 4]) {
                if (propagationAllowed(scene, index, direction)) {
                    color = maximumColor(color, seeds[neighbor(scene, index, direction)]);
                }
            }

            work[index][corner] = color;
        }
    }

    for (const index of order) {
        for (let corner = 0; corner < 8; corner++) {
            work[index][corner] = sharedCorner(scene, work, index, corner);
        }
    }

    const output = scene.cells.map((cell) => cell === null ? null : new Int32Array(49));

    for (const index of order) {
        const payload = output[index];

        payload[0] = Number(seen[index]) | Number(canSee[index]) * 6;
        payload[1] = pack(colors[index]);
        payload[2] = Math.trunc(Math.fround(darkness[index] * 100_000));
        payload[3] = Number(seen[index]) * 100_000;

        for (let corner = 0; corner < 8; corner++) {
            const color = sharedCorner(scene, work, index, corner);

            payload[5 + corner] = pack(color) | 0xFF_00_00_00;
        }

        payload[13] = records[index].length;

        for (const [recordIndex, record] of records[index].entries()) {
            const { light, color } = record;

            payload.set([light.id, light.x, light.y, light.z, light.radius, pack(color)], 14 + recordIndex * 6);
        }
    }

    return output.map((payload) => payload === null ? null : [...payload]);
}
