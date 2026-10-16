/* eslint-disable no-await-in-loop -- Both binary header variants must be exercised sequentially. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { parseStaticFbx } from '../src/fbx.js';

// Entirely authored geometry, node names and texture links; no original fixture bytes.
/**
 * Encode an authored scalar or bounded/compressed array property.
 *
 * @param {string|number|bigint|object} value - Synthetic property description.
 * @returns {Buffer} Binary property bytes.
 */
function property(value) {
    if (typeof value === 'string') {
        const data = Buffer.from(value);
        const prefix = Buffer.alloc(5);

        prefix[0] = 83;
        prefix.writeUInt32LE(data.length, 1);

        return Buffer.concat([prefix, data]);
    }

    if (typeof value === 'bigint') {
        const data = Buffer.alloc(9);

        data[0] = 76;
        data.writeBigInt64LE(value, 1);

        return data;
    }

    if (typeof value === 'number') {
        const data = Buffer.alloc(9);

        data[0] = 68;
        data.writeDoubleLE(value, 1);

        return data;
    }

    if (value.type === 'C') {
        return Buffer.from([67, value.value]);
    }

    const size = value.type === 'd' ? 8 : 4;
    const raw = Buffer.alloc(value.values.length * size);

    for (const [i, v] of value.values.entries()) {
        if (value.type === 'd') {
            raw.writeDoubleLE(v, i * size);
        } else {
            raw.writeInt32LE(v, i * size);
        }
    }

    const data = value.compressed === false ? raw : deflateSync(raw);
    const header = Buffer.alloc(13);

    header[0] = value.type.charCodeAt(0);
    header.writeUInt32LE(value.count ?? value.values.length, 1);
    header.writeUInt32LE(value.compressed === false ? 0 : 1, 5);
    header.writeUInt32LE(data.length, 9);

    return Buffer.concat([header, data]);
}

/**
 * Describe one authored FBX node.
 *
 * @param {string} name - Node name.
 * @param {Array} [properties] - Authored source properties.
 * @param {object[]} [children] - Authored child nodes.
 * @returns {object} Fixture-only node description.
 */
function node(name, properties = [], children = []) {
    return { name, properties, children };
}

/**
 * Build a wholly synthetic FBX with source-style connections and compressed arrays.
 *
 * @param {object} [options] - Synthetic valid and malformed source choices.
 * @param {number} [options.version] - 32-bit or 64-bit header version.
 * @param {number[]} [options.polygon] - FBX terminated polygon indices.
 * @param {number[]} [options.positions] - Source control points.
 * @param {object[]} [options.extra] - Additional objects.
 * @param {number[]} [options.uvIndices] - Corner UV references.
 * @param {number} [options.arrayCount] - Override declared vertex array count.
 * @param {boolean} [options.transform] - Include authored local/geometric transform.
 * @param {number[]} [options.normal] - Source corner normal.
 * @param {boolean} [options.compressed] - Compress typed arrays when true.
 * @returns {Buffer} Authored binary source, never native bytes.
 */
function fixture({ version = 7_500, polygon = [0, 1, 2, -4], positions = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], extra = [], uvIndices = [3, 2, 1, 0], arrayCount, transform = true, normal = [0, 0, 1], compressed = true } = {}) {
    /**
     * Describe a synthetic typed array with independent declared count.
     *
     * @param {string} type - FBX array type.
     * @param {number[]} values - Authored data.
     * @param {number} count - Optional declared count override.
     * @returns {object} Fixture array description.
     */
    const array = (type, values, count) => ({ type, values, count, compressed });
    /**
     * Describe a source-style geometry layer.
     *
     * @param {string} name - Layer node name.
     * @param {string} mapping - Mapping mode.
     * @param {string} reference - Reference mode.
     * @param {object[]} data - Direct array and source layer name.
     * @param {object[]} index - Optional indirect indices.
     * @returns {object} Authored layer node.
     */
    const layer = (name, mapping, reference, data, index) => node(name, [0], [node('MappingInformationType', [mapping]), node('ReferenceInformationType', [reference]), ...data, ...(index ?? [])]);
    /**
     * Describe one source Properties70 entry.
     *
     * @param {string} name - Property name.
     * @param {Array} values - Source property values.
     * @returns {object} Authored property node.
     */
    const p = (name, values) => node('P', [name, '', '', '', ...values]);
    const objects = node('Objects', [], [
        node('Geometry', [1n, 'Authored\0\u0001Geometry', 'Mesh'], [
            node('Vertices', [array('d', positions, arrayCount)]), node('PolygonVertexIndex', [array('i', polygon)]),
            layer('LayerElementNormal', 'ByPolygonVertex', 'Direct', [node('Normals', [array('d', polygon.flatMap(() => normal))])]),
            layer('LayerElementUV', 'ByPolygonVertex', 'IndexToDirect', [node('Name', ['UV0']), node('UV', [array('d', [0, 0, 1, 0, 1, 1, 0, 1])])], [node('UVIndex', [array('i', uvIndices)])]),
            layer('LayerElementMaterial', 'AllSame', 'IndexToDirect', [node('Materials', [array('i', [0])])]),
        ]),
        node('Model', [2n, 'Authored\0\u0001Model', 'Mesh'], [node('Shading', [{ type: 'C', value: 84 }]), node('Properties70', [], transform ? [p('Lcl Translation', [10, 0, 0]), p('Lcl Rotation', [0, 0, 90]), p('Lcl Scaling', [2, 3, 4]), p('GeometricTranslation', [1, 0, 0])] : [])]),
        node('Material', [3n, 'Paint\0\u0001Material', ''], [node('Properties70', [], [p('DiffuseColor', [1, 0.5, 0])])]),
        node('Texture', [4n, 'Ink\0\u0001Texture', ''], [node('RelativeFilename', ['authored.png']), node('Properties70', [], [p('UVSet', ['UV0'])])]),
        ...extra,
    ]);
    const nodes = [node('GlobalSettings', [], [node('Properties70', [], [p('UpAxis', [1]), p('UnitScaleFactor', [100])])]), objects, node('Connections', [], [node('C', ['OO', 1n, 2n]), node('C', ['OO', 2n, 0n]), node('C', ['OO', 3n, 2n]), node('C', ['OP', 4n, 3n, 'DiffuseColor'])])];
    const headerSize = version >= 7_500 ? 25 : 13;

    /**
     * Encode one node using absolute offsets, including its trailing child sentinel.
     *
     * @param {object} n - Authored node.
     * @param {number} start - Absolute binary node offset.
     * @returns {Buffer} Encoded node bytes.
     */
    function encode(n, start) {
        const name = Buffer.from(n.name);
        const props = Buffer.concat(n.properties.map(property));
        let end = start + headerSize + name.length + props.length;
        const kids = n.children.map((child) => {
            const bytes = encode(child, end);

            end += bytes.length;

            return bytes;
        });

        if (kids.length) {
            kids.push(Buffer.alloc(headerSize));
            end += headerSize;
        }

        const header = Buffer.alloc(headerSize);

        if (version >= 7_500) {
            header.writeBigUInt64LE(BigInt(end), 0);
            header.writeBigUInt64LE(BigInt(n.properties.length), 8);
            header.writeBigUInt64LE(BigInt(props.length), 16);
        } else {
            header.writeUInt32LE(end, 0);
            header.writeUInt32LE(n.properties.length, 4);
            header.writeUInt32LE(props.length, 8);
        }

        header[headerSize - 1] = name.length;

        return Buffer.concat([header, name, props, ...kids]);
    }

    const header = Buffer.alloc(27);

    Buffer.from('Kaydara FBX Binary  \0\x1A\0').copy(header);
    header.writeUInt32LE(version, 23);
    let start = 27;
    const encoded = nodes.map((n) => {
        const bytes = encode(n, start);

        start += bytes.length;

        return bytes;
    });

    return Buffer.concat([header, ...encoded, Buffer.alloc(headerSize)]);
}

/**
 * Compare against independently specified coordinates and normals.
 *
 * @param {number[]} actual - Decoded components.
 * @param {number[]} expected - Hand-derived expected components.
 * @returns {void} Asserts a tight tolerance.
 */
function near(actual, expected) {
    assert.equal(actual.length, expected.length);

    for (const [i, v] of actual.entries()) {
        assert.ok(Math.abs(v - expected[i]) < 1e-5, `${v} != ${expected[i]}`);
    }
}

test('32-bit and 64-bit binary mesh headers decode compressed polygon-corner UVs, materials and baked local transforms', async () => {
    for (const version of [7_300, 7_500]) {
        const mesh = await parseStaticFbx(fixture({ version }));

        near([...mesh.positions], [10, 2, 0, 10, 4, 0, 7, 4, 0, 7, 2, 0]);
        near([...mesh.normals], [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
        assert.deepEqual([...mesh.uvs], [0, 1, 1, 1, 1, 0, 0, 0]);
        assert.equal(mesh.indices.length, 6);
        assert.deepEqual([...mesh.metadata.triangleMaterials], [0, 0]);
        assert.equal(mesh.materials[0].name, 'Paint');
        assert.equal(mesh.materials[0].textures[0].relativeFilename, 'authored.png');
        assert.equal(mesh.materials[0].textures[0].property, 'DiffuseColor');
        assert.equal(mesh.metadata.globalSettings.UnitScaleFactor, 100);
        assert.equal(mesh.metadata.uvOrientation, 'source-unmodified');
    }
});

test('malformed offset, unsafe 64-bit size, truncated geometry and compressed length/bomb claims reject', async () => {
    const invalidOffset = fixture();

    invalidOffset.writeBigUInt64LE(28n, 27);
    await assert.rejects(parseStaticFbx(invalidOffset), /offset|node|bounds/i);
    const unsafe = fixture();

    unsafe.writeBigUInt64LE(9_007_199_254_740_993n, 27);
    await assert.rejects(parseStaticFbx(unsafe), /size|offset|bounds/i);
    await assert.rejects(parseStaticFbx(fixture().subarray(0, 300)), /truncat|bounds|offset/i);
    await assert.rejects(parseStaticFbx(fixture({ arrayCount: 1 })), /array|decompress|length/i);
    await assert.rejects(parseStaticFbx(fixture({ arrayCount: 0xFF_FF_FF_FF })), /limit|array|bound/i);
    await assert.rejects(parseStaticFbx(fixture({ polygon: [0, 1, -999] })), /index|vertex/i);
    await assert.rejects(parseStaticFbx(fixture({ positions: [0, 0, Number.NaN] })), /finite|geometry/i);
});

test('unsupported skinning, unclosed polygons and invalid UV references are not discarded', async () => {
    await assert.rejects(parseStaticFbx(fixture({ extra: [node('Deformer', [9n, 'Skin', 'Skin'])] })), /skin|deformer|unsupported/i);
    await assert.rejects(parseStaticFbx(fixture({ polygon: [0, 1, 2] })), /polygon/i);
    await assert.rejects(parseStaticFbx(fixture({ uvIndices: [0, 1, 2, 200] })), /uv|index/i);
});

test('concave static polygons triangulate without filling the concavity', async () => {
    const mesh = await parseStaticFbx(fixture({ transform: false, positions: [0, 0, 0, 2, 0, 0, 1, 1, 0, 2, 2, 0, 0, 2, 0], polygon: [0, 1, 2, 3, -5], uvIndices: [0, 1, 2, 3, 0] }));
    let area = 0;

    for (let i = 0; i < mesh.indices.length; i += 3) {
        const [a, b, c] = [...mesh.indices.subarray(i, i + 3)].map((v) => mesh.positions.subarray(v * 3, v * 3 + 3));

        area += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
    }

    assert.equal(mesh.indices.length, 9);
    assert.equal(area, 3);
});

test('inverse-transpose normals remain faithful under nonuniform scale and raw arrays', async () => {
    const mesh = await parseStaticFbx(fixture({ normal: [1, 1, 0], compressed: false }));

    near([...mesh.normals.subarray(0, 3)], [-0.554_700_196, 0.832_050_294, 0]);
});

test('self-intersecting nonzero-area polygons reject instead of manufacturing triangles', async () => {
    await assert.rejects(parseStaticFbx(fixture({ transform: false, positions: [0, 0, 0, 2, 2, 0, 0, 2, 0, 2, 0, 0, 1, -1, 0], polygon: [0, 1, 2, 3, -5], uvIndices: [0, 1, 2, 3, 0] })), /polygon|intersect/i);
});
