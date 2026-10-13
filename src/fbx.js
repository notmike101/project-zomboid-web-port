/* eslint-disable no-await-in-loop -- Binary node offsets and streaming decompression require sequential reads. */
// Static binary FBX only. Source data stays local; axes, units and UVs are not guessed.

/**
 * Native byte views accepted by ArrayBuffer.isView, including DataView.
 *
 * @typedef {DataView|Int8Array|Uint8Array|Uint8ClampedArray|Int16Array|Uint16Array|Int32Array|Uint32Array|globalThis.Float16Array|Float32Array|Float64Array|BigInt64Array|BigUint64Array} ArrayBufferView
 */

const MAX_BYTES = 64 * 1_024 * 1_024;
const MAX_ARRAY = 2_000_000;
const MAX_CORNERS = 600_000;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const READ_METHODS = {
    Y: 'getInt16', C: 'getUint8', I: 'getInt32', F: 'getFloat32', D: 'getFloat64', L: 'getBigInt64',
    f: 'getFloat32', d: 'getFloat64', i: 'getInt32', l: 'getBigInt64', b: 'getUint8', c: 'getInt8',
};
/**
 * Reject invalid or unsupported source data.
 *
 * @param {string} message - Diagnostic reason.
 * @returns {never} Always throws.
 */
const fail = (message) => {
    throw new TypeError(`FBX: ${message}`);
};

/**
 * Inflate into a pre-bounded allocation, cancelling excess output immediately.
 *
 * @param {Uint8Array} bytes - Encoded zlib/deflate array.
 * @param {number} length - Validated declared output byte count.
 * @returns {Promise<Uint8Array>} Exactly the declared decoded bytes.
 */
async function inflate(bytes, length) {
    const input = new ReadableStream({
        /**
         * Enqueue the one bounded compressed byte extent.
         *
         * @param {ReadableStreamDefaultController} controller - Owned stream controller.
         * @returns {void} Closes after the source extent.
         */
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        },
    });
    const reader = input.pipeThrough(new DecompressionStream('deflate')).getReader();
    const result = new Uint8Array(length);
    let at = 0;

    try {
        for (;;) {
            const { value, done } = await reader.read();

            if (done) {
                break;
            }

            if (value.length > length - at) {
                fail('Decompressed array exceeds declared length.');
            }

            result.set(value, at);
            at += value.length;
        }

        if (at !== length) {
            fail('Decompressed array length mismatch.');
        }
    } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }

    return result;
}

/**
 * Check a byte extent against its enclosing property/node extent.
 *
 * @param {number} at - Starting offset.
 * @param {number} size - Required byte count.
 * @param {number} end - Exclusive parent end.
 * @returns {void} Throws on invalid bounds.
 */
const check = (at, size, end) => {
    if (!Number.isSafeInteger(at) || !Number.isSafeInteger(size) || size < 0 || at < 0 || at > end || size > end - at) {
        fail(`Truncated or out-of-bounds data at offset ${at}.`);
    }
};

/**
 * Read checked 32/64-bit node offsets and every declared property/array.
 *
 * @param {ArrayBuffer|ArrayBufferView} bytes - Bounded original binary input.
 * @returns {Promise<object>} Parsed node roots and declared version.
 */
async function binary(bytes) {
    if (bytes instanceof ArrayBuffer) {
        bytes = new Uint8Array(bytes);
    } else if (ArrayBuffer.isView(bytes)) {
        bytes = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    } else {
        fail('Expected binary bytes.');
    }

    if (bytes.length < 27 || bytes.length > MAX_BYTES || UTF8.decode(bytes.subarray(0, 23)) !== 'Kaydara FBX Binary  \0\x1A\0') {
        fail('Invalid binary header or byte limit.');
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = view.getUint32(23, true);

    if (version < 7_000 || version > 7_700) {
        fail(`Unsupported binary version ${version}.`);
    }

    const wide = version >= 7_500;
    const header = wide ? 25 : 13;
    let nodes = 0;
    let properties = 0;
    let arrayBytes = 0;
    /**
     * Convert a uint64 size only after proving exact Number representation.
     *
     * @param {number} at - Checked field offset.
     * @returns {number} Safe unsigned size/offset.
     */
    const size64 = (at) => {
        const value = view.getBigUint64(at, true);

        if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
            fail('64-bit size/offset exceeds safe bounds.');
        }

        return Number(value);
    };

    /**
     * Decode one node and its bounded children in source order.
     *
     * @param {number} start - Node header offset.
     * @param {number} parentEnd - Enclosing exclusive end.
     * @param {number} depth - Current recursion depth.
     * @returns {Promise<Array>} Node (or null terminator) and next offset.
     */
    async function node(start, parentEnd, depth) {
        if (++nodes > 100_000 || depth > 64) {
            fail('Node count/depth limit exceeded.');
        }

        check(start, header, parentEnd);
        const end = wide ? size64(start) : view.getUint32(start, true);
        const count = wide ? size64(start + 8) : view.getUint32(start + 4, true);
        const length = wide ? size64(start + 16) : view.getUint32(start + 8, true);
        const nameLength = bytes[start + header - 1];

        if (!end) {
            if (count || length || nameLength || bytes.subarray(start, start + header).some((v) => v !== 0)) {
                fail('Malformed null node.');
            }

            return [null, start + header];
        }

        if (end <= start + header || end > parentEnd || count > 100_000 || (properties += count) > 1_000_000) {
            fail('Invalid node offset/count bounds.');
        }

        let at = start + header;

        check(at, nameLength, end);
        const name = UTF8.decode(bytes.subarray(at, at + nameLength));

        at += nameLength;
        check(at, length, end);
        const propertyEnd = at + length;
        const values = [];

        for (let i = 0; i < count; i++) {
            check(at, 1, propertyEnd);
            const type = String.fromCharCode(bytes[at++]);
            const scalarSize = { Y: 2, C: 1, I: 4, F: 4, D: 8, L: 8 }[type];
            let value;

            if (scalarSize) {
                check(at, scalarSize, propertyEnd);
                value = view[READ_METHODS[type]](at, true);
                at += scalarSize;

                if (typeof value === 'number' && !Number.isFinite(value)) {
                    fail('Nonfinite scalar property.');
                }
                // FBX SDK exports C flags as byte characters too (observed Shading='T'); retain the byte.
            } else if (type === 'S' || type === 'R') {
                check(at, 4, propertyEnd);
                const size = view.getUint32(at, true);

                at += 4;
                check(at, size, propertyEnd);
                value = type === 'S' ? UTF8.decode(bytes.subarray(at, at + size)) : bytes.subarray(at, at + size);
                at += size;
            } else {
                const size = { f: 4, d: 8, i: 4, l: 8, b: 1, c: 1 }[type];

                if (!size) {
                    fail(`Unsupported property type ${type}.`);
                }

                check(at, 12, propertyEnd);
                const elements = view.getUint32(at, true);
                const encoding = view.getUint32(at + 4, true);
                const encodedLength = view.getUint32(at + 8, true);

                at += 12;
                const decodedLength = elements * size;

                if (elements > MAX_ARRAY || (arrayBytes += decodedLength) > MAX_BYTES || ![0, 1].includes(encoding)) {
                    fail('Array allocation/encoding limit exceeded.');
                }

                check(at, encodedLength, propertyEnd);

                if (!encoding && encodedLength !== decodedLength) {
                    fail('Uncompressed array length mismatch.');
                }

                const data = encoding ? await inflate(bytes.subarray(at, at + encodedLength), decodedLength) : bytes.subarray(at, at + encodedLength);

                at += encodedLength;
                const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);
                const Constructor = { f: Float32Array, d: Float64Array, i: Int32Array, l: BigInt64Array, b: Uint8Array, c: Int8Array }[type];

                value = new Constructor(elements);

                for (let j = 0; j < elements; j++) {
                    const offset = j * size;
                    const v = dataView[READ_METHODS[type]](offset, true);

                    if (typeof v === 'number' && !Number.isFinite(v)) {
                        fail('Nonfinite geometry/array value.');
                    }

                    value[j] = v;
                }
            }

            values.push(value);
        }

        if (at !== propertyEnd) {
            fail('Property list length mismatch.');
        }

        const children = [];
        let childrenTerminated = false;

        while (at < end) {
            const [child, next] = await node(at, end, depth + 1);

            at = next;

            if (!child) {
                childrenTerminated = true;

                if (at !== end) {
                    fail('Null node does not terminate its parent offset.');
                }

                break;
            }

            children.push(child);
        }

        if (at !== end || (children.length && !childrenTerminated)) {
            fail('Node end offset or child terminator mismatch.');
        }

        return [{ name, values, children }, end];
    }

    const roots = [];
    let at = 27;
    let terminated = false;

    while (at < bytes.length) {
        const [n, next] = await node(at, bytes.length, 0);

        at = next;

        if (!n) {
            terminated = true;
            break;
        }

        roots.push(n);
    }

    if (!terminated) {
        fail('Truncated root terminator.');
    }

    return { roots, version };
}

/**
 * Retrieve an unambiguous child; mandatory geometry cannot be defaulted.
 *
 * @param {object|null|undefined} node - Parent node.
 * @param {string} name - Source child name.
 * @param {boolean} [required] - Reject missing data when true.
 * @returns {object|undefined} Matching node.
 */
function child(node, name, required = false) {
    const matches = node?.children.filter((n) => n.name === name) ?? [];

    if (matches.length > 1 || (required && !matches.length)) {
        fail(`Missing or duplicate ${name}.`);
    }

    return matches[0];
}

/**
 * Preserve Properties70 values without synthesizing source defaults.
 *
 * @param {object|undefined} node - FBX object with optional Properties70.
 * @returns {object} Detached property values, 64-bit integers as exact decimal strings.
 */
function props(node) {
    const result = Object.create(null);

    for (const p of child(node, 'Properties70')?.children ?? []) {
        if (p.name !== 'P' || typeof p.values[0] !== 'string' || p.values.length < 4 || Object.hasOwn(result, p.values[0])) {
            fail('Malformed or duplicate Properties70 entry.');
        }

        const values = p.values.slice(4).map((v) => typeof v === 'bigint' ? v.toString() : v);

        result[p.values[0]] = values.length === 1 ? values[0] : values;
    }

    return result;
}

/**
 * Construct a column-major identity transform.
 *
 * @returns {Float64Array} Identity matrix.
 */
const identity = () => new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/**
 * Column-major affine matrix product.
 *
 * @param {Float64Array} a - Left matrix.
 * @param {Float64Array} b - Right matrix.
 * @returns {Float64Array} Product.
 */
function multiply(a, b) {
    const out = new Float64Array(16);

    for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
            for (let k = 0; k < 4; k++) {
                out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
            }
        }
    }

    return out;
}

/**
 * FBX Euler XYZ applies X, then Y, then Z; other rotation orders are unsupported.
 *
 * @param {number[]} v - XYZ angles in source degrees.
 * @param {boolean} [inverse] - Transpose the orthogonal rotation for PostRotation.
 * @returns {Float64Array} Rotation matrix.
 */
function rotation(v, inverse = false) {
    let result = identity();

    for (const axis of [0, 1, 2]) {
        const angle = v[axis] * Math.PI / 180;
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        const m = identity();
        const a = (axis + 1) % 3;
        const b = (axis + 2) % 3;

        m[a * 4 + a] = c;
        m[b * 4 + b] = c;
        m[a * 4 + b] = s;
        m[b * 4 + a] = -s;
        result = multiply(m, result);
    }

    if (inverse) {
        return new Float64Array(Array.from({ length: 16 }, (_, i) => result[(i % 4) * 4 + Math.floor(i / 4)]));
    }

    return result;
}

/**
 * Full observed local/pivot/pre/post/geometric transform; specification defaults only.
 *
 * @param {object} properties - Original model Properties70.
 * @returns {Float64Array} Baked column-major mesh transform in source axes/units.
 */
function transform(properties) {
    /**
     * Read a finite source transform vector or the FBX specification default.
     *
     * @param {string} name - Property name.
     * @param {number[]} [fallback] - FBX identity vector.
     * @returns {number[]} Source vector.
     */
    const vector = (name, fallback = [0, 0, 0]) => {
        const v = properties[name] ?? fallback;

        if (!Array.isArray(v) || v.length !== 3 || v.some((x) => typeof x !== 'number' || !Number.isFinite(x))) {
            fail(`Invalid ${name} transform.`);
        }

        return v;
    };

    /**
     * Build a translation, negating pivots when requested.
     *
     * @param {number[]} v - Source translation.
     * @param {number} [sign] - Pivot inversion multiplier.
     * @returns {Float64Array} Translation matrix.
     */
    const translation = (v, sign = 1) => {
        const m = identity();

        for (let i = 0; i < 3; i++) {
            m[12 + i] = v[i] * sign;
        }

        return m;
    };

    /**
     * Build non-singular source scaling.
     *
     * @param {number[]} v - XYZ source scales.
     * @returns {Float64Array} Scaling matrix.
     */
    const scaling = (v) => {
        if (v.some((x) => x === 0)) {
            fail('Singular scaling transform.');
        }

        const m = identity();

        for (let i = 0; i < 3; i++) {
            m[i * 5] = v[i];
        }

        return m;
    };

    if ((properties.RotationOrder ?? 0) !== 0) {
        fail('Unsupported non-XYZ rotation order.');
    }

    const rp = vector('RotationPivot');
    const sp = vector('ScalingPivot');
    const active = properties.RotationActive ?? 1;

    if (![0, 1].includes(active)) {
        fail('Invalid RotationActive.');
    }

    const matrices = [translation(vector('Lcl Translation')), translation(vector('RotationOffset')), translation(rp),
        rotation(active ? vector('PreRotation') : [0, 0, 0]), rotation(vector('Lcl Rotation')), rotation(active ? vector('PostRotation') : [0, 0, 0], true), translation(rp, -1),
        translation(vector('ScalingOffset')), translation(sp), scaling(vector('Lcl Scaling', [1, 1, 1])), translation(sp, -1),
        translation(vector('GeometricTranslation')), rotation(vector('GeometricRotation')), scaling(vector('GeometricScaling', [1, 1, 1]))];
    let result = identity();

    for (const matrix of matrices) {
        result = multiply(result, matrix);
    }

    return result;
}

/**
 * Extract a typed source array and require its intended element representation.
 *
 * @param {object} node - Parent source node.
 * @param {string} name - Array child name.
 * @param {boolean} [integer] - Require signed int32 indices.
 * @returns {Float32Array|Float64Array|Int32Array} Source array.
 */
function array(node, name, integer = false) {
    const values = child(node, name, true).values;
    const value = values[0];

    if (values.length !== 1 || (integer ? !(value instanceof Int32Array) : !(value instanceof Float32Array || value instanceof Float64Array))) {
        fail(`Invalid ${name} array type.`);
    }

    return value;
}

/**
 * Validate one normal/UV layer and map polygon corners to direct source values.
 *
 * @param {object} geometry - Mesh source node.
 * @param {string} name - Layer node name.
 * @param {string} dataName - Direct array name.
 * @param {string} indexName - Indirect array name.
 * @param {number} width - Vector component count.
 * @param {number} vertexCount - Control point count.
 * @param {number} corners - Polygon corner count.
 * @param {number} polygons - Polygon count.
 * @returns {object} Checked source mapping and corner reader.
 */
function layer(geometry, name, dataName, indexName, width, vertexCount, corners, polygons) {
    const n = child(geometry, name, true);
    const mapping = child(n, 'MappingInformationType', true).values[0];
    const reference = child(n, 'ReferenceInformationType', true).values[0];

    if (!['ByPolygonVertex', 'ByVertice', 'ByVertex', 'ByPolygon', 'AllSame'].includes(mapping) || !['Direct', 'IndexToDirect', 'Index'].includes(reference)) {
        fail(`Unsupported ${name} mapping/reference.`);
    }

    const data = array(n, dataName);

    if (!data.length || data.length % width) {
        fail(`Invalid ${name} vector length.`);
    }

    const count = { ByPolygonVertex: corners, ByVertice: vertexCount, ByVertex: vertexCount, ByPolygon: polygons, AllSame: 1 }[mapping];
    const indices = reference === 'Direct' ? null : array(n, indexName, true);

    if (reference === 'Direct' && child(n, indexName)) {
        fail(`Unexpected ${name} indices for Direct mapping.`);
    }

    if ((indices ? indices.length : data.length / width) !== count) {
        fail(`Invalid ${name} mapping array length.`);
    }

    if (indices && indices.some((i) => i < 0 || i >= data.length / width)) {
        fail(`Invalid ${name} index.`);
    }

    return {
        name: child(n, 'Name')?.values[0], mapping, reference,
        /**
         * Read a checked source vector for one expanded polygon corner.
         *
         * @param {number} corner - Expanded corner index.
         * @param {number} vertex - Source control point index.
         * @param {number} polygon - Source polygon index.
         * @param {Float32Array} out - Destination array.
         * @param {number} at - Destination component offset.
         * @returns {void} Writes the source vector.
         */
        read(corner, vertex, polygon, out, at) {
            let i = 0;

            if (mapping === 'ByPolygonVertex') {
                i = corner;
            } else if (['ByVertice', 'ByVertex'].includes(mapping)) {
                i = vertex;
            } else if (mapping === 'ByPolygon') {
                i = polygon;
            }

            i = indices ? indices[i] : i;

            for (let j = 0; j < width; j++) {
                out[at + j] = data[i * width + j];
            }
        },
    };
}

/**
 * Compute the signed doubled triangle area in the projection.
 *
 * @param {number[]} a - First projected point.
 * @param {number[]} b - Second projected point.
 * @param {number[]} c - Third projected point.
 * @returns {number} Signed area.
 */
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

/**
 * Ear clipping in the polygon's dominant plane, retaining winding and concavity.
 *
 * @param {number} start - First expanded corner.
 * @param {number} count - Number of corners.
 * @param {Float32Array} positions - Expanded transformed positions.
 * @returns {number[]} Triangle corner indices in source winding.
 */
function triangulate(start, count, positions) {
    if (count === 3) {
        return [start, start + 1, start + 2];
    }

    const normal = [0, 0, 0];

    for (let i = 0; i < count; i++) {
        const a = (start + i) * 3;
        const b = (start + (i + 1) % count) * 3;

        normal[0] += (positions[a + 1] - positions[b + 1]) * (positions[a + 2] + positions[b + 2]);
        normal[1] += (positions[a + 2] - positions[b + 2]) * (positions[a] + positions[b]);
        normal[2] += (positions[a] - positions[b]) * (positions[a + 1] + positions[b + 1]);
    }

    const drop = normal.map(Math.abs).indexOf(Math.max(...normal.map(Math.abs)));
    const axes = [0, 1, 2].filter((i) => i !== drop);
    /**
     * Project an expanded source corner onto the dominant polygon plane.
     *
     * @param {number} i - Corner index.
     * @returns {number[]} Projected XY point.
     */
    const point = (i) => [positions[i * 3 + axes[0]], positions[i * 3 + axes[1]]];
    let area = 0;

    for (let i = 0; i < count; i++) {
        const a = point(start + i);
        const b = point(start + (i + 1) % count);

        area += a[0] * b[1] - b[0] * a[1];
    }

    if (!Number.isFinite(area) || Math.abs(area) < 1e-20) {
        fail('Degenerate polygon.');
    }

    for (let i = 0; i < count; i++) {
        const a = point(start + i);
        const b = point(start + (i + 1) % count);

        if (a[0] === b[0] && a[1] === b[1]) {
            fail('Degenerate polygon edge.');
        }

        for (let j = i + 2; j < count; j++) {
            if (i === 0 && j === count - 1) {
                continue;
            }

            const c = point(start + j);
            const d = point(start + (j + 1) % count);
            const overlap = [0, 1].every((axis) => Math.max(Math.min(a[axis], b[axis]), Math.min(c[axis], d[axis])) <= Math.min(Math.max(a[axis], b[axis]), Math.max(c[axis], d[axis])));

            if (overlap && cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0) {
                fail('Non-simple polygon has intersecting edges.');
            }
        }
    }

    const sign = Math.sign(area);
    const remaining = Array.from({ length: count }, (_, i) => start + i);
    const result = [];

    while (remaining.length > 3) {
        let clipped = false;

        for (let i = 0; i < remaining.length; i++) {
            const a = remaining[(i + remaining.length - 1) % remaining.length];
            const b = remaining[i];
            const c = remaining[(i + 1) % remaining.length];
            const pa = point(a);
            const pb = point(b);
            const pc = point(c);

            if (sign * cross(pa, pb, pc) <= 1e-20 || remaining.some((v) => v !== a && v !== b && v !== c && sign * cross(pa, pb, point(v)) >= -1e-20 && sign * cross(pb, pc, point(v)) >= -1e-20 && sign * cross(pc, pa, point(v)) >= -1e-20)) {
                continue;
            }

            result.push(a, b, c);
            remaining.splice(i, 1);
            clipped = true;
            break;
        }

        if (!clipped) {
            fail('Degenerate or non-simple polygon cannot be triangulated.');
        }
    }

    result.push(...remaining);

    return result;
}

/**
 * Read the source object name before the FBX class suffix.
 *
 * @param {{values: unknown[]}} o - Source object with its original property values.
 * @returns {string} Unmodified source name.
 */
const sourceName = (o) => String(o.values[1] ?? '').split('\0')[0];

/**
 * Decode one bounded static binary mesh in source axes/units, with baked local and geometric transforms.
 * Source polygon corners expand to separate vertices, preserving normal/UV seams.
 * Reject deformers, skinning, animated transforms, multi-mesh scenes, non-XYZ rotation
 * orders and nonidentity texture UV transforms; never silently substitute geometry.
 *
 * @param {ArrayBuffer|ArrayBufferView} bytes - Original binary FBX bytes, at most 64 MiB.
 * @returns {Promise<{positions: Float32Array, normals: Float32Array, uvs: Float32Array, indices: Uint32Array, materials: object[], metadata: object}>} Triangulated geometry; connected materials/textures; source axes/units, properties, transform, bounds, counts and triangleMaterials.
 */
export async function parseStaticFbx(bytes) {
    const { roots, version } = await binary(bytes);
    const objects = child({ children: roots }, 'Objects', true).children;

    if (objects.some((o) => ['Deformer', 'AnimationCurve', 'AnimationCurveNode', 'Pose', 'LayeredTexture'].includes(o.name))) {
        fail('Unsupported deformer/skinning, animation or layered texture.');
    }

    const byId = new Map();

    for (const o of objects) {
        if (typeof o.values[0] !== 'bigint' || o.values[0] === 0n || byId.has(o.values[0].toString())) {
            fail('Invalid or duplicate object ID.');
        }

        byId.set(o.values[0].toString(), o);
    }

    const connections = child({ children: roots }, 'Connections', true).children.map((c) => {
        if (c.name !== 'C' || !['OO', 'OP'].includes(c.values[0]) || c.values.length !== (c.values[0] === 'OP' ? 4 : 3) || c.children.length || typeof c.values[1] !== 'bigint' || typeof c.values[2] !== 'bigint' || (c.values[0] === 'OP' && typeof c.values[3] !== 'string')) {
            fail('Malformed object connection.');
        }

        const from = c.values[1].toString();
        const to = c.values[2].toString();

        if (!byId.has(from) || (to !== '0' && !byId.has(to))) {
            fail('Connection references missing object.');
        }

        return { kind: c.values[0], from, to, property: c.values[3] };
    });
    const geometries = objects.filter((o) => o.name === 'Geometry');
    const models = objects.filter((o) => o.name === 'Model');

    if (geometries.length !== 1 || geometries[0].values[2] !== 'Mesh' || models.length !== 1 || models[0].values[2] !== 'Mesh') {
        fail('Only one static geometry and one mesh model are supported.');
    }

    const geometry = geometries[0];
    const model = models[0];
    const geometryId = geometry.values[0].toString();
    const modelId = model.values[0].toString();
    const owners = connections.filter((c) => c.kind === 'OO' && c.from === geometryId);

    if (owners.length !== 1 || owners[0].to !== modelId || !connections.some((c) => c.kind === 'OO' && c.from === modelId && c.to === '0')) {
        fail('Unsupported mesh ownership/hierarchy.');
    }

    const materials = connections.filter((c) => c.kind === 'OO' && c.to === modelId && byId.get(c.from).name === 'Material').map((c) => {
        const material = byId.get(c.from);
        const textures = connections.filter((link) => link.kind === 'OP' && link.to === c.from).map((link) => {
            const texture = byId.get(link.from);

            if (texture.name !== 'Texture') {
                fail('Unsupported material connection.');
            }

            const properties = props(texture);
            const translation = child(texture, 'ModelUVTranslation')?.values;
            const scaling = child(texture, 'ModelUVScaling')?.values;
            const cropping = child(texture, 'Cropping')?.values;

            if ((translation && (translation.length !== 2 || translation.some((v) => v !== 0))) || (scaling && (scaling.length !== 2 || scaling.some((v) => v !== 1))) || (cropping && (cropping.length !== 4 || cropping.some((v) => v !== 0)))) {
                fail('Unsupported texture UV transform/cropping.');
            }

            const result = { id: link.from, name: sourceName(texture), property: link.property, properties };

            if (translation) {
                result.uvTranslation = [...translation];
            }

            if (scaling) {
                result.uvScaling = [...scaling];
            }

            if (cropping) {
                result.cropping = [...cropping];
            }

            const alphaSource = child(texture, 'Texture_Alpha_Source')?.values[0];

            if (alphaSource !== undefined) {
                if (typeof alphaSource !== 'string') {
                    fail('Invalid texture alpha source.');
                }

                result.alphaSource = alphaSource;
            }

            const videoLinks = connections.filter((v) => v.kind === 'OO' && v.to === link.from && byId.get(v.from).name === 'Video');

            if (videoLinks.length > 1) {
                fail('Ambiguous texture video.');
            }

            const video = videoLinks.length ? byId.get(videoLinks[0].from) : null;

            for (const [nodeName, key] of [['FileName', 'fileName'], ['RelativeFilename', 'relativeFilename']]) {
                const value = child(texture, nodeName)?.values[0] ?? child(video, nodeName)?.values[0];

                if (value !== undefined) {
                    if (typeof value !== 'string') {
                        fail('Invalid texture filename.');
                    }

                    result[key] = value;
                }
            }

            if (properties.UVSet !== undefined) {
                result.uvSet = properties.UVSet;
            }

            return result;
        });

        return { id: c.from, name: sourceName(material), properties: props(material), textures };
    });
    const sourcePositions = array(geometry, 'Vertices');
    const polygonIndices = array(geometry, 'PolygonVertexIndex', true);
    const vertexCount = sourcePositions.length / 3;

    if (!sourcePositions.length || sourcePositions.length % 3 || vertexCount > 100_000 || !polygonIndices.length || polygonIndices.length > MAX_CORNERS) {
        fail('Geometry vertex/corner count limit exceeded.');
    }

    const polygons = [];
    let start = 0;
    let triangles = 0;
    let triangulationWork = 0;

    for (const [i, polygonIndex] of polygonIndices.entries()) {
        const index = polygonIndex < 0 ? -polygonIndex - 1 : polygonIndex;

        if (index >= vertexCount) {
            fail('Polygon vertex index out of bounds.');
        }

        if (i - start >= 256) {
            fail('Polygon corner limit exceeded.');
        }

        if (polygonIndex < 0) {
            const count = i - start + 1;

            if (count < 3 || (triangles += count - 2) > 200_000) {
                fail('Invalid polygon triangle count/limit.');
            }

            // Bound the cubic worst case of ear clipping, not just its output allocation.
            if (count > 3 && (triangulationWork += count ** 3) > 32_000_000) {
                fail('Polygon triangulation work limit exceeded.');
            }

            polygons.push({ start, count });
            start = i + 1;
        }
    }

    if (start !== polygonIndices.length) {
        fail('Unterminated polygon.');
    }

    const normalLayer = layer(geometry, 'LayerElementNormal', 'Normals', 'NormalsIndex', 3, vertexCount, polygonIndices.length, polygons.length);
    const uvLayer = layer(geometry, 'LayerElementUV', 'UV', 'UVIndex', 2, vertexCount, polygonIndices.length, polygons.length);
    const edges = child(geometry, 'Edges') ? array(geometry, 'Edges', true) : null;

    if (edges?.some((edge) => edge < 0 || edge >= polygonIndices.length)) {
        fail('Edge corner index out of bounds.');
    }

    for (const [layerName, dataName, indexName] of [['LayerElementTangent', 'Tangents', 'TangentsIndex'], ['LayerElementBinormal', 'Binormals', 'BinormalsIndex']]) {
        if (child(geometry, layerName)) {
            layer(geometry, layerName, dataName, indexName, 3, vertexCount, polygonIndices.length, polygons.length);
        }
    }

    for (const material of materials) {
        for (const texture of material.textures) {
            if (texture.uvSet && texture.uvSet !== uvLayer.name) {
                fail('Texture references unsupported UV set.');
            }
        }
    }

    const materialLayer = child(geometry, 'LayerElementMaterial', true);
    const materialMapping = child(materialLayer, 'MappingInformationType', true).values[0];
    const materialReference = child(materialLayer, 'ReferenceInformationType', true).values[0];
    const materialIndices = array(materialLayer, 'Materials', true);

    if (!['AllSame', 'ByPolygon'].includes(materialMapping) || !['IndexToDirect', 'Direct'].includes(materialReference) || materialIndices.length !== (materialMapping === 'AllSame' ? 1 : polygons.length) || materialIndices.some((i) => i < 0 || i >= materials.length)) {
        fail('Unsupported or invalid material mapping/index.');
    }

    const modelProperties = props(model);
    const matrix = transform(modelProperties);
    const [a, b, c, d, e, f, g, h, i] = [matrix[0], matrix[4], matrix[8], matrix[1], matrix[5], matrix[9], matrix[2], matrix[6], matrix[10]];
    const cofactors = [e * i - f * h, f * g - d * i, d * h - e * g, c * h - b * i, a * i - c * g, b * g - a * h, b * f - c * e, c * d - a * f, a * e - b * d];
    const determinant = a * cofactors[0] + b * cofactors[1] + c * cofactors[2];

    if (!Number.isFinite(determinant) || determinant === 0 || matrix.some((v) => !Number.isFinite(v))) {
        fail('Nonfinite or singular mesh transform.');
    }

    const positions = new Float32Array(polygonIndices.length * 3);
    const normals = new Float32Array(positions.length);
    const uvs = new Float32Array(polygonIndices.length * 2);
    const indices = new Uint32Array(triangles * 3);
    const triangleMaterials = new Uint32Array(triangles);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    let at = 0;

    for (const [polygon, face] of polygons.entries()) {
        for (let corner = face.start; corner < face.start + face.count; corner++) {
            const vertex = polygonIndices[corner] < 0 ? -polygonIndices[corner] - 1 : polygonIndices[corner];
            const x = sourcePositions[vertex * 3];
            const y = sourcePositions[vertex * 3 + 1];
            const z = sourcePositions[vertex * 3 + 2];

            for (let axis = 0; axis < 3; axis++) {
                const v = matrix[axis] * x + matrix[4 + axis] * y + matrix[8 + axis] * z + matrix[12 + axis];

                positions[corner * 3 + axis] = v;

                if (!Number.isFinite(positions[corner * 3 + axis])) {
                    fail('Nonfinite transformed geometry.');
                }

                min[axis] = Math.min(min[axis], v);
                max[axis] = Math.max(max[axis], v);
            }

            normalLayer.read(corner, vertex, polygon, normals, corner * 3);
            const nx = normals[corner * 3];
            const ny = normals[corner * 3 + 1];
            const nz = normals[corner * 3 + 2];
            const transformed = [0, 1, 2].map((axis) => (cofactors[axis * 3] * nx + cofactors[axis * 3 + 1] * ny + cofactors[axis * 3 + 2] * nz) / determinant);
            const length = Math.hypot(...transformed);

            if (!Number.isFinite(length) || length === 0) {
                fail('Invalid zero/nonfinite normal.');
            }

            for (let axis = 0; axis < 3; axis++) {
                normals[corner * 3 + axis] = transformed[axis] / length;
            }

            uvLayer.read(corner, vertex, polygon, uvs, corner * 2);

            if (!Number.isFinite(uvs[corner * 2]) || !Number.isFinite(uvs[corner * 2 + 1])) {
                fail('Nonfinite UV geometry.');
            }
        }

        const faceTriangles = triangulate(face.start, face.count, positions);

        for (let t = 0; t < faceTriangles.length; t += 3) {
            const v0 = faceTriangles[t];
            const v1 = faceTriangles[t + 1];
            const v2 = faceTriangles[t + 2];
            const p0 = v0 * 3;
            const p1 = v1 * 3;
            const p2 = v2 * 3;
            const ab = [0, 1, 2].map((axis) => positions[p1 + axis] - positions[p0 + axis]);
            const ac = [0, 1, 2].map((axis) => positions[p2 + axis] - positions[p0 + axis]);

            if (Math.hypot(ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]) === 0) {
                fail('Degenerate triangle geometry.');
            }

            indices.set(determinant < 0 ? [v0, v2, v1] : [v0, v1, v2], at);
            triangleMaterials[at / 3] = materialIndices[materialMapping === 'AllSame' ? 0 : polygon];
            at += 3;
        }
    }

    const globalSettings = props(child({ children: roots }, 'GlobalSettings'));

    return {
        positions, normals, uvs, indices, materials, metadata: {
            version, geometryId, modelId, geometryName: sourceName(geometry), modelName: sourceName(model), sourceVertexCount: vertexCount,
            polygonCount: polygons.length, triangleCount: triangles, bounds: { min, max }, transform: matrix,
            modelProperties, globalSettings, triangleMaterials, uvOrientation: 'source-unmodified',
            normalMapping: normalLayer.mapping, normalReference: normalLayer.reference, uvMapping: uvLayer.mapping, uvReference: uvLayer.reference,
        },
    };
}
