import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseX, createSkin, sampleSkin } from '../src/models.js';

/* Independently authored two-bone triangle: parent translates 2, child another 3;
   offsets subtract their bind globals. No native game text or pixels are fixtures. */
const identity = '1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1';
/**
 * Builds a row-major 4x4 translation matrix string for one frame transform.
 *
 * @param {number} x - Translation along the x axis.
 * @returns {string} Row-major FrameTransformMatrix cell list.
 */
const translated = (x) => `1,0,0,0,0,1,0,0,0,0,1,0,${x},0,0,1`;
const source = `xof 0303txt 0032
Material Skin {1;1;1;1;;0;0;0;0;;0;0;0;;TextureFilename {"skin.png";}}
Frame Parent { FrameTransformMatrix {${translated(2)};;}
 Frame Child { FrameTransformMatrix {${translated(3)};;} }
}
Frame Body {FrameTransformMatrix {${identity};;}
 Mesh Triangle {3;0;0;0;,1;0;0;,0;1;0;;1;3;0,1,2;;
 MeshNormals {1;0;0;1;;1;3;0,0,0;;}
 MeshTextureCoords {3;0;0;,1;0;,0;1;;}
 MeshMaterialList {1;1;0;{Skin}}
 XSkinMeshHeader {2;2;2;}
 SkinWeights {"Parent";3;0,1,2;0.25,0.25,0.25;${translated(-2)};;}
 SkinWeights {"Child";3;0,1,2;0.75,0.75,0.75;${translated(-5)};;}
 }}
AnimTicksPerSecond {10;}
AnimationSet Motion {
 Animation {{Parent} AnimationKey T {2;2;0;3;2,0,0;;,10;3;4,0,0;;;}}
 Animation {{Child}
 AnimationKey R {0;2;0;4;1,0,0,0;;,10;4;0,0,0,-1;;;}
 AnimationKey S {1;2;0;3;1,1,1;;,10;3;3,3,3;;;}}
}`;

/**
 * Applies a row-major 4x4 matrix to a 3D point.
 *
 * @param {number[]} matrix - Sixteen row-major matrix cells.
 * @param {number[]} p - The [x, y, z] point.
 * @returns {number[]} Transformed [x, y, z] coordinates.
 */
function point(matrix, p) {
    return [0, 1, 2].map((r) => matrix[r] * p[0] + matrix[r + 4] * p[1] + matrix[r + 8] * p[2] + matrix[r + 12]);
}

/**
 * Asserts that two numeric arrays agree within 1e-5 per component.
 *
 * @param {number[]} actual - Values under test.
 * @param {number[]} wanted - Independently expected values.
 */
function near(actual, wanted) {
    for (const [i, v] of actual.entries()) {
        assert.ok(Math.abs(v - wanted[i]) < 1e-5, `${actual} != ${wanted}`);
    }
}

test('hierarchy and inverse bind offsets preserve weighted bind pose', () => {
    const model = parseX(source);

    assert.equal(model.textureNames[0], 'skin.png');
    const skin = createSkin(model);
    const palette = sampleSkin(skin, null, 0);

    near(point(palette.subarray(0, 16), [1, 2, 3]), [1, 2, 3]);
    near(point(palette.subarray(16, 32), [1, 2, 3]), [1, 2, 3]);
    assert.deepEqual([...skin.vertices.slice(8, 12)], [0.25, 0.75, 0, 0]);
    assert.deepEqual([...skin.indices], [0, 1, 2]);
});

test('zero-influence skin bones preserve palette order without inventing vertex weights', () => {
    const emptyBone = `SkinWeights {"Unused";0;;;${translated(-50)};;}`;
    const text = source.replace('Frame Body', `Frame Unused {FrameTransformMatrix {${translated(50)};;}} Frame Body`)
        .replace('XSkinMeshHeader {2;2;2;}', 'XSkinMeshHeader {2;2;3;}')
        .replace('SkinWeights {"Parent"', `${emptyBone} SkinWeights {"Parent"`);
    const model = parseX(text);

    assert.deepEqual(model.meshes[0].weights[0].indices, []);
    assert.deepEqual(model.meshes[0].weights[0].weights, []);
    const skin = createSkin(model);
    const palette = sampleSkin(skin, null, 0);

    assert.equal(skin.bones.length, 3);
    assert.deepEqual([...skin.vertices.slice(8, 16)], [0.25, 0.75, 0, 0, 1, 2, 0, 0]);
    assert.deepEqual([...skin.indices], [0, 1, 2]);
    near(point(palette.subarray(16, 32), [1, 2, 3]), [1, 2, 3]);
    near(point(palette.subarray(32, 48), [1, 2, 3]), [1, 2, 3]);
    const animated = sampleSkin(skin, model.animations[0], 0.5);

    near(point(animated.subarray(16, 32), [1, 0, 0]), [2, 0, 0]);
    near(point(animated.subarray(32, 48), [6, 0, 0]), [6, 2, 0]);
    assert.throws(() => parseX(text.replace('"Unused";0;', '"Unused";-1;')), /skin vertex/);
});

test('translation, quaternion slerp, scale, parent order and looping use declared ticks', () => {
    const model = parseX(source);
    const skin = createSkin(model);
    const clip = model.animations[0];
    const palette = sampleSkin(skin, clip, 0.5);

    near(point(palette.subarray(0, 16), [1, 0, 0]), [2, 0, 0]);
    /* At midpoint child origin is x6; 90-degree rotation and scale2 sends
       original x6 through inverse offset(-5), then to (6,2,0). */
    near(point(palette.subarray(16, 32), [6, 0, 0]), [6, 2, 0]);
    const looped = sampleSkin(skin, clip, 1.5);

    near(point(looped.subarray(0, 16), [1, 0, 0]), [2, 0, 0]);
    near(point(looped.subarray(16, 32), [6, 0, 0]), [6, 2, 0]);
});

test('missing tick metadata requires explicit diagnosed calibration', () => {
    const model = parseX(source.replace('AnimTicksPerSecond {10;}', ''));
    const skin = createSkin(model);

    assert.throws(() => sampleSkin(skin, model.animations[0], 0.5), /ticksPerSecond/);
    near(point(sampleSkin(skin, model.animations[0], 0.5, 10).subarray(0, 16), [1, 0, 0]), [2, 0, 0]);
});

test('malformed, oversized and deliberately unsupported X data fail explicitly', () => {
    for (const bad of [source.slice(0, -2), source.replace('xof 0303txt', 'xof 0303bin'),
        source.replace('3;0,1,2;;', '4;0,1,2,0;;'),
        source.replace('0;4;1,0,0,0', '0;4;0,0,0,0'),
        source.replace('10;3;4,0,0', '0;3;4,0,0'),
        source.replace('MeshNormals {1;', 'MeshNormals {1000001;'),
        source.replace('3;0,1,2;;', '3;0,1,3;;'),
        source.replace('XSkinMeshHeader {2;', 'XSkinMeshHeader {5;'),
        source.replace('AnimationKey T {2;', 'AnimationKey T {4;'),
        source.replace('MeshTextureCoords {3;0;0;,1;0;,0;1;;}', ''),
        source.replace('Frame Body', 'UnsupportedThing {} Frame Body')]) {
        assert.throws(() => parseX(bad));
    }

    const missingBone = parseX(source.replace('"Child";3;', '"Absent";3;'));

    assert.throws(() => createSkin(missingBone), /bone|frame/i);
    const badWeights = parseX(source.replace('0.75,0.75,0.75', '0,0,0').replace('0.25,0.25,0.25', '0,0,0'));

    assert.throws(() => createSkin(badWeights), /weight/i);
});

test('self-contained DeclData decodes float-bit normals and UVs, not DWORD magnitudes', () => {
    const decl = `DeclData {2;2;0;3;0;,1;0;5;0;;15;
        0,0,1065353216,0,0, 0,0,1065353216,1065353216,0, 0,0,1065353216,0,1065353216;}`;
    const model = parseX(source.replace('MeshNormals {1;0;0;1;;1;3;0,0,0;;}', '').replace('MeshTextureCoords {3;0;0;,1;0;,0;1;;}', decl));
    const skin = createSkin(model);

    assert.deepEqual([...skin.vertices.slice(3, 8)], [0, 0, 1, 0, 0]);
    assert.deepEqual([...skin.vertices.slice(19, 24)], [0, 0, 1, 1, 0]);
});

test('X clockwise wxyz quaternions agree with row-major bind matrices', () => {
    const text = `xof 0303txt 0032
template Frame {<3d82ab46-62da-11cf-ab39-0020af71e433> [...]}
Frame Root {FrameTransformMatrix {1,0,0,0,0,0,-1,0,0,1,0,0,0,0,0,1;;}}
Frame Body {Mesh Triangle {3;0;0;0;,1;0;0;,0;1;0;;1;3;0,1,2;;
MeshNormals {1;0;0;1;;1;3;0,0,0;;} MeshTextureCoords {3;0;0;,1;0;,0;1;;}
XSkinMeshHeader {1;1;1;}
SkinWeights {"Root";3;0,1,2;1,1,1;1,0,0,0,0,0,1,0,0,-1,0,0,0,0,0,1;;}}}
AnimTicksPerSecond {1;}
AnimationSet Idle {Animation {{Root} AnimationKey R {0;1;0;4;0.7071067811865476,0.7071067811865476,0,0;;;}}}`;
    const model = parseX(text);
    const skin = createSkin(model);

    near(point(sampleSkin(skin, null, 0), [0, 1, 0]), [0, 1, 0]);
    near(point(sampleSkin(skin, model.animations[0], 0), [0, 1, 0]), [0, 1, 0]);
});
