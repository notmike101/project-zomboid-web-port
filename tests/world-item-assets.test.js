import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseItemDefinitions } from '../src/item-definitions.js';
import { createWorldItemAssets } from '../src/world-item-assets.js';

/**
 * Create an authored FBX node for the binary fixture encoder.
 *
 * @param {string} name - FBX node name.
 * @param {Array} [values] - Scalar and array properties in source order.
 * @param {object[]} [children] - Nested fixture nodes.
 * @returns {object} Fixture node with its properties and children.
 */
const n = (name, values = [], children = []) => ({ name, values, children });
/**
 * Describe an uncompressed numeric FBX array property.
 *
 * @param {string} type - FBX array tag, either d or i.
 * @param {number[]} values - Numeric elements to encode.
 * @returns {object} Tagged array property.
 */
const a = (type, values) => ({ type, values });

/**
 * Create a direct per-polygon-vertex attribute layer.
 *
 * @param {string} name - FBX layer node name.
 * @param {object} data - Encoded attribute data node.
 * @returns {object} Attribute layer fixture node.
 */
const layer = (name, data) => n(name, [0], [n('MappingInformationType', ['ByPolygonVertex']), n('ReferenceInformationType', ['Direct']), data]);

/**
 * Encode a wholly authored FBX triangle without original asset bytes.
 *
 * @param {object} [root0] - Optional unsupported-feature fixture controls.
 * @param {boolean} [root0.deformer] - Include a skin deformer to exercise rejection.
 * @returns {Buffer} Binary FBX fixture.
 */
function mesh({ deformer = false } = {}) {
    const nodes = [n('Objects', [], [
        n('Geometry', [1n, 'Triangle', 'Mesh'], [n('Vertices', [a('d', [0, 0, 1, 2, 0, 1, 0, 2, 1])]), n('PolygonVertexIndex', [a('i', [0, 1, -3])]),
            layer('LayerElementNormal', n('Normals', [a('d', [0, 0, 1, 0, 0, 1, 0, 0, 1])])),
            layer('LayerElementUV', n('UV', [a('d', [0, 0, 1, 0, 0, 1])])),
            n('LayerElementMaterial', [0], [n('MappingInformationType', ['AllSame']), n('ReferenceInformationType', ['IndexToDirect']), n('Materials', [a('i', [0])])]),
        ]),
        n('Model', [2n, 'Triangle', 'Mesh'], [n('Properties70', [], [n('P', ['Lcl Translation', '', '', '', 3, 0, 0])])]),
        n('Material', [3n, 'Authored', '']), ...(deformer ? [n('Deformer', [4n, 'Skin', 'Skin'])] : []),
    ]), n('Connections', [], [n('C', ['OO', 1n, 2n]), n('C', ['OO', 2n, 0n]), n('C', ['OO', 3n, 2n])])];

    /**
     * Encode one scalar or uncompressed numeric FBX property.
     *
     * @param {string|number|bigint|object} value - Fixture property to serialize.
     * @returns {Buffer} Property tag and encoded payload.
     */
    function property(value) {
        if (typeof value === 'string') {
            const b = Buffer.from(value);
            const h = Buffer.alloc(5);

            h[0] = 83;
            h.writeUInt32LE(b.length, 1);

            return Buffer.concat([h, b]);
        }

        if (typeof value === 'bigint' || typeof value === 'number') {
            const b = Buffer.alloc(9);

            b[0] = typeof value === 'bigint' ? 76 : 68;

            if (typeof value === 'bigint') {
                b.writeBigInt64LE(value, 1);
            } else {
                b.writeDoubleLE(value, 1);
            }

            return b;
        }

        const size = value.type === 'd' ? 8 : 4;
        const b = Buffer.alloc(13 + size * value.values.length);

        b[0] = value.type.charCodeAt(0);
        b.writeUInt32LE(value.values.length, 1);
        b.writeUInt32LE(size * value.values.length, 9);

        for (const [i, v] of value.values.entries()) {
            size === 8 ? b.writeDoubleLE(v, 13 + i * size) : b.writeInt32LE(v, 13 + i * size);
        }

        return b;
    }

    /**
     * Encode a node and its children using absolute FBX end offsets.
     *
     * @param {object} node - Fixture node with name, values and children.
     * @param {number} offset - Absolute byte offset of the node header.
     * @returns {Buffer} Encoded node and optional child terminator.
     */
    function encode(node, offset) {
        const name = Buffer.from(node.name);
        const props = Buffer.concat(node.values.map(property));
        let end = offset + 13 + name.length + props.length;
        const children = node.children.map((child) => {
            const b = encode(child, end);

            end += b.length;

            return b;
        });

        if (children.length) {
            children.push(Buffer.alloc(13));
            end += 13;
        }

        const h = Buffer.alloc(13);

        h.writeUInt32LE(end);
        h.writeUInt32LE(node.values.length, 4);
        h.writeUInt32LE(props.length, 8);
        h[12] = name.length;

        return Buffer.concat([h, name, props, ...children]);
    }

    const h = Buffer.alloc(27);

    Buffer.from('Kaydara FBX Binary  \0\x1A\0').copy(h);
    h.writeUInt32LE(7_300, 23);
    let offset = 27;

    return Buffer.concat([h, ...nodes.map((node) => {
        const b = encode(node, offset);

        offset += b.length;

        return b;
    }), Buffer.alloc(13)]);
}

/**
 * Create an authored PNG header for dimension-only fixture reads.
 *
 * @param {number} [width] - Declared PNG width.
 * @param {number} [height] - Declared PNG height.
 * @returns {Buffer} PNG signature and IHDR bytes without pixel data.
 */
function png(width = 20, height = 40) {
    const b = Buffer.alloc(33);

    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b);
    b.writeUInt32BE(13, 8);
    b.write('IHDR', 12);
    b.writeUInt32BE(width, 16);
    b.writeUInt32BE(height, 20);
    b[24] = 8;
    b[25] = 6;

    return b;
}

/**
 * Provide manifest-bounded Blob access to authored fixture files.
 *
 * @param {{[key:string]:string|Uint8Array}} [files] - Fixture bytes keyed by manifest path.
 * @returns {object} Minimal original-content API used by the resolver.
 */
function content(files = {}) {
    const all = new Map(Object.entries(files).map(([path, bytes]) => [path, new Blob([bytes])]));

    return {
        manifest: { files: [...all.keys()].map((path) => ({ path })) },
        /**
         * Read one fixture Blob by its exact manifest path.
         *
         * @param {string} path - Manifest resource path.
         * @returns {Blob} Authored file bytes.
         */
        getFile(path) {
            assert.ok(all.has(path), `nonmanifest request ${path}`);

            return all.get(path);
        },
    };
}

/**
 * Parse one authored item definition with caller-supplied fields.
 *
 * @param {string} [fields] - Additional item script fields.
 * @returns {object} Parsed Test.Thing item definition.
 */
const definition = (fields = '') => parseItemDefinitions(`module Test { item Thing { ItemType = base:normal, Icon = Authored, ${fields} } }`, 'authored-items.txt')[0];
/**
 * Assemble a complete authored model, mesh and texture fixture.
 *
 * @param {string} [model] - Fields for the Test.Ground model script.
 * @param {{[key:string]:string|Uint8Array}} [extra] - Additional or replacement fixture files.
 * @returns {object} Manifest-bounded fixture content API.
 */
const assets = (model = 'mesh = WorldItems/Triangle, texture = WorldItems/Paint, scale = 2,', extra = {}) => content({
    'media/scripts/generated/models_authored.txt': `module Test { model Ground { ${model} } }`,
    'media/models_X/WorldItems/Triangle.FBX': mesh(),
    'media/textures/WorldItems/Paint.png': png(),
    'media/textures/Item_Authored.png': png(), ...extra,
});

test('genuine comma-bearing translation manifest paths do not block original model resolution', async () => {
    const resolver = await createWorldItemAssets(assets(undefined, {
        'media/lua/shared/Translate/AR/Brandenburg, KY.json': '{}',
        'media/lua/shared/Translate/FR/Équipement (d\'origine).json': '{}',
    }));
    const rep = await resolver.resolve({ definition: definition('WorldStaticModel = Ground,') });

    assert.equal(rep.kind, 'model');
    assert.equal(rep.source.status, 'Ready');
    assert.equal(rep.source.mesh, 'media/models_X/WorldItems/Triangle.FBX');
    assert.equal(rep.source.texture, 'media/textures/WorldItems/Paint.png');
    assert.deepEqual([...rep.positions], [0, 0, -1, 2, 0, -1, 0, 2, -1]);
});

test('world manifest paths still reject traversal, absolute paths, URLs and control characters', async () => {
    await Promise.all([
        '../outside.txt', 'media/../outside.txt', 'media/./file.txt', 'media//file.txt',
        '/absolute/file.txt', 'C:/absolute/file.txt', '\\\\host\\share\\file.txt',
        'https://host/file.txt', 'media/%2e%2e/file.txt', 'media/file.txt?query', 'media/file.txt#fragment',
        'media/null\0file.txt', 'media/line\nfile.txt', 'media/delete\u007Ffile.txt',
    ].map((path) => assert.rejects(createWorldItemAssets(content({ [path]: '' })), /Invalid original world asset path/u)));
});

test('NoModel clothing sprites preserve persisted native tint with shared source residency identity', async () => {
    const resolver = await createWorldItemAssets(assets(undefined, {
        'media/clothing/clothingItems/Worn.xml': '<clothingItem><m_AllowRandomTint>true</m_AllowRandomTint></clothingItem>',
    }));
    const d = definition('ItemType = base:clothing, ClothingItem = Worn,');
    const red = await resolver.resolve({ definition: d, visual: { tint: [0.8, 0.1, 0.2, 1] } });
    const green = await resolver.resolve({ definition: d, visual: { tint: [0.1, 0.7, 0.2, 1] } });
    const white = await resolver.resolve({ definition: d });

    assert.equal(red.kind, 'sprite');
    assert.deepEqual(red.tint, [0.8, 0.1, 0.2, 1]);
    assert.deepEqual(green.tint, [0.1, 0.7, 0.2, 1]);
    assert.deepEqual(white.tint, [1, 1, 1, 1]);
    assert.equal(red.key, green.key);
    assert.strictEqual(red.texture, green.texture);
    assert.notStrictEqual(red, green);
});

test('model tint stays per item while shared geometry and texture determine GPU residency identity', async () => {
    const resolver = await createWorldItemAssets(assets('mesh = WorldItems/Triangle,', {
        'media/clothing/clothingItems/Worn.xml': '<clothingItem><m_BaseTextures>WorldItems/Paint</m_BaseTextures><m_BaseTextures>WorldItems/Other</m_BaseTextures><m_AllowRandomTint>true</m_AllowRandomTint></clothingItem>',
        'media/textures/WorldItems/Other.png': png(),
    }));
    const d = definition('ItemType = base:clothing, ClothingItem = Worn, WorldStaticModel = Ground,');
    const redVisual = { baseTexture: 0, tint: [0.8, 0.1, 0.2, 1] };
    const red = await resolver.resolve({ definition: d, visual: redVisual });
    const green = await resolver.resolve({ definition: d, visual: { baseTexture: 0, tint: [0.1, 0.7, 0.2, 1] } });
    const otherTexture = await resolver.resolve({ definition: d, visual: { ...redVisual, baseTexture: 1 } });

    assert.equal(red.kind, 'model');
    assert.deepEqual(red.tint, redVisual.tint);
    assert.deepEqual(green.tint, [0.1, 0.7, 0.2, 1]);
    assert.equal(red.key, green.key);
    assert.strictEqual(red.positions, green.positions);
    assert.strictEqual(red.texture, green.texture);
    assert.notStrictEqual(red, green);
    assert.strictEqual(await resolver.resolve({ definition: d, visual: redVisual }), red);
    assert.notEqual(red.key, otherTexture.key);
    assert.equal(otherTexture.source.texture, 'media/textures/WorldItems/Other.png');
});

test('genuine same-file duplicate model declarations resolve without treating the registry as ambiguous', async () => {
    const block = 'model NecklaceLongSilverSapphire_Ground { mesh = WorldItems/Triangle, texture = WorldItems/Paint, scale = .5, }';
    const resolver = await createWorldItemAssets(assets(undefined, {
        'media/scripts/generated/models_clothes.txt': `module Base { ${block} ${block} }`,
    }));
    const rep = await resolver.resolve({ definition: definition('WorldStaticModel = Base.NecklaceLongSilverSapphire_Ground,') });

    assert.equal(rep.kind, 'model');
    assert.equal(rep.transform[0], 0.5);
    assert.equal(rep.source.model.path, 'media/scripts/generated/models_clothes.txt');
    assert.equal(rep.source.mesh, 'media/models_X/WorldItems/Triangle.FBX');
});

test('source model files use template-first lowercase path ordering rather than manifest insertion order', async () => {
    const resolver = await createWorldItemAssets(assets(undefined, {
        'media/scripts/a/models_ground.txt': 'module Test { model Ground { mesh = WorldItems/Triangle, texture = WorldItems/Paint, scale = 3, } }',
        'media/scripts/z/TEMPLATE_ground.txt': 'module Test { model Ground { mesh = WorldItems/Triangle, texture = WorldItems/Paint, scale = 4, } }',
    }));
    const rep = await resolver.resolve({ definition: definition('WorldStaticModel = Ground,') });

    assert.equal(rep.kind, 'model');
    assert.equal(rep.transform[0], 2);
    assert.equal(rep.source.model.path, 'media/scripts/generated/models_authored.txt');
});

test('later model bodies reset ordinary fields but update retained attachment fields in source order', async () => {
    const resolver = await createWorldItemAssets(assets('mesh = WorldItems/Triangle, texture = WorldItems/Paint, scale = 4, shader = CustomGlass, static = false, invertX = true, cullFace = back, attachment world { offset = 1 0 0, scale = 2, }'
        + '} model Ground { mesh = WorldItems/Triangle, texture = WorldItems/Paint, attachment world { rotate = 0 0 90, }'));
    const rep = await resolver.resolve({ definition: definition('WorldStaticModel = Ground,') });

    assert.equal(rep.kind, 'model');
    assert.equal(rep.cullFace, 'none');
    assert.ok(Math.abs(rep.transform[0]) < 1e-6);
    assert.ok(Math.abs(rep.transform[1] + 0.5) < 1e-6);
    assert.ok(Math.abs(rep.transform[13] + 1) < 1e-6);
    const unsupported = await createWorldItemAssets(assets('mesh = WorldItems/Triangle, texture = WorldItems/Paint, postProcess = +FLIP_UVS,'
        + '} model Ground { mesh = WorldItems/Triangle, texture = WorldItems/Paint,'));

    await assert.rejects(unsupported.resolve({ definition: definition('WorldStaticModel = Ground,') }), /postprocess/i);
});

test('source model resolves exact manifest case, one baked mesh transform, native handedness and script scale without per-item transforms', async () => {
    const resolver = await createWorldItemAssets(assets('mesh = WorldItems/Triangle, texture = WorldItems/Paint, scale = 2, attachment world { offset = 1 0 0, }'));
    const item = { id: 1, definition: definition('WorldStaticModel = Ground,'), worldScale: 99, worldZRotation: 45 };
    const rep = await resolver.resolve(item);

    assert.equal(rep.kind, 'model');
    assert.deepEqual([...rep.positions], [0, 0, -1, 2, 0, -1, 0, 2, -1]);
    assert.deepEqual([...rep.normals], [0, 0, -1, 0, 0, -1, 0, 0, -1]);
    assert.deepEqual([...rep.indices], [2, 1, 0]);
    assert.deepEqual([...rep.uvs], [0, 1, 1, 1, 0, 0]);
    assert.equal(rep.transform[0], 2);
    assert.equal(rep.transform[12], 2);
    assert.equal(rep.source.mesh, 'media/models_X/WorldItems/Triangle.FBX');
    assert.equal(rep.source.texture, 'media/textures/WorldItems/Paint.png');
    assert.strictEqual(await resolver.resolve({ ...item, id: 2, worldScale: 1 }), rep);
});

test('NoModel source status alone enables normal icon fallback at native ScaleWorldIcon geometry; hidden is not sprite', async () => {
    const resolver = await createWorldItemAssets(assets());
    const sprite = await resolver.resolve({ definition: definition('ScaleWorldIcon = .5,') });

    assert.equal(sprite.kind, 'sprite');
    assert.equal(sprite.source.status, 'NoModel');
    assert.deepEqual(sprite.quad, { left: -5, top: -15, width: 10, height: 20 });
    assert.equal((await resolver.resolve({ definition: definition('WorldRender = false,') })).kind, 'hidden');
    await assert.rejects(resolver.resolve({ definition: definition('WorldStaticModel = Missing,') }), /model.*missing|missing.*model/i);
});

test('unsupported shader, parser errors, missing meshes and missing textures never masquerade as source NoModel', async () => {
    await Promise.all([
        [assets('mesh = WorldItems/Triangle, texture = WorldItems/Paint, shader = CustomGlass,'), /shader/i],
        [assets(undefined, { 'media/models_X/WorldItems/Triangle.FBX': mesh({ deformer: true }) }), /deformer|skin/i],
        [assets('mesh = WorldItems/Absent, texture = WorldItems/Paint,'), /mesh.*missing|missing.*mesh/i],
        [assets('mesh = WorldItems/Triangle, texture = Missing,'), /texture.*missing|missing.*texture/i],
        [assets('mesh = WorldItems/Triangle, texture = WorldItems/Paint, postProcess = +FLIP_UVS,'), /postprocess/i],
        [assets('mesh = WorldItems/Triangle, texture = WorldItems/Paint, scale = 1e40,'), /transform/i],
    ].map(async ([files, message]) => {
        const resolver = await createWorldItemAssets(files);

        await assert.rejects(resolver.resolve({ definition: definition('WorldStaticModel = Ground,') }), message);
    }));
});

test('world clothing model may use only deterministic single base texture and source white tint without ItemVisual', async () => {
    const xml = '<clothingItem><m_BaseTextures>WorldItems/Paint</m_BaseTextures><m_AllowRandomTint>false</m_AllowRandomTint></clothingItem>';
    const resolver = await createWorldItemAssets(assets('mesh = WorldItems/Triangle, scale = .33,', { 'media/clothing/clothingItems/Worn.xml': xml }));
    const rep = await resolver.resolve({ definition: definition('ItemType = base:clothing, ClothingItem = Worn, WorldStaticModel = Ground,') });

    assert.equal(rep.kind, 'model');
    assert.deepEqual(rep.tint, [1, 1, 1, 1]);
    assert.equal(rep.source.visualSelection, 'deterministic-source');
    const ambiguous = await createWorldItemAssets(assets('mesh = WorldItems/Triangle,', { 'media/clothing/clothingItems/Worn.xml': xml.replace('</clothingItem>', '<m_BaseTextures>Other</m_BaseTextures></clothingItem>') }));

    await assert.rejects(ambiguous.resolve({ definition: definition('ItemType = base:clothing, ClothingItem = Worn, WorldStaticModel = Ground,') }), /visual|texture.*selection/i);
});

test('head clothing requires real visual, permits cosmetic eyes only, and does not use weapon StaticModel for ordinary items', async () => {
    const xml = '<clothingItem><m_MaleModel>WorldItems/Triangle</m_MaleModel><m_Static>true</m_Static><m_AttachBone>Bip01_Head</m_AttachBone><textureChoices>WorldItems/Paint</textureChoices></clothingItem>';
    const resolver = await createWorldItemAssets(assets(undefined, { 'media/clothing/clothingItems/Hat.xml': xml }));
    const d = definition('ItemType = base:clothing, ClothingItem = Hat, Cosmetic = true, BodyLocation = base:eyes,');

    assert.equal((await resolver.resolve({ definition: d })).kind, 'sprite');
    const rep = await resolver.resolve({ definition: d, visual: { textureChoice: 0, tint: [1, 1, 1, 1], hue: 0 } });

    assert.equal(rep.kind, 'model');
    assert.equal(rep.source.selection, 'head-clothing');
    assert.equal((await resolver.resolve({ definition: { ...d, bodyLocation: 'base:hat' }, visual: { textureChoice: 0 } })).kind, 'sprite');
    assert.equal((await resolver.resolve({ definition: definition('StaticModel = Ground,') })).kind, 'sprite');
    assert.equal((await resolver.resolve({ definition: definition('ItemType = base:weapon, StaticModel = Ground,') })).kind, 'model');
});

test('unsupported per-item visual effects remain explicit instead of showing pristine geometry', async () => {
    const resolver = await createWorldItemAssets(assets());

    await Promise.all([{ fluidLevel: 0.5 }, { bloodLevel: 0.5 }, { hue: 0.25 }, { weaponParts: ['Scope'] }].map((visual) => assert.rejects(
        resolver.resolve({ definition: definition('WorldStaticModel = Ground,'), visual }), /unsupported/i,
    )));
});

test('native visual rules retain both authored lists and selected persisted variant rather than choosing the first', async () => {
    const resolver = await createWorldItemAssets(assets('mesh = WorldItems/Triangle,', {
        'media/clothing/clothingItems/Worn.xml': '<clothingItem><m_BaseTextures>Other</m_BaseTextures><m_BaseTextures>WorldItems/Paint</m_BaseTextures><m_AllowRandomTint>true</m_AllowRandomTint><m_AllowRandomHue>false</m_AllowRandomHue></clothingItem>',
    }));
    const d = definition('ItemType = base:clothing, ClothingItem = Worn, WorldStaticModel = Ground,');
    const rules = await resolver.visualRules(d);

    assert.deepEqual(rules, { baseTextureCount: 2, textureChoiceCount: 0, allowRandomTint: true, allowRandomHue: false, provenance: { path: 'media/clothing/clothingItems/Worn.xml' } });
    assert.equal(await resolver.visualRules(definition()), null);
    const rep = await resolver.resolve({ definition: d, visual: { baseTexture: 1, tint: [0.2, 0.3, 0.4, 1], hue: 0 } });

    assert.deepEqual(rep.tint, [0.2, 0.3, 0.4, 1]);
    assert.equal(rep.source.texture, 'media/textures/WorldItems/Paint.png');
    await assert.rejects(resolver.resolve({ definition: d, visual: { baseTexture: 2, tint: [1, 1, 1, 1] } }), /selection/i);
});

test('food variants use original Cooked Burnt Rotten priority and require exact variant source', async () => {
    const script = 'mesh = WorldItems/Triangle, texture = WorldItems/Paint,';
    const resolver = await createWorldItemAssets(assets(script, {
        'media/scripts/generated/models_food.txt': `module Test { model GroundCooked { ${script} scale = 2, } model GroundBurnt { ${script} scale = 3, } model GroundRotten { ${script} scale = 4, } }`,
    }));
    const d = definition('ItemType = base:food, WorldStaticModel = Ground,');
    const rep = await resolver.resolve({ definition: d, visual: { cooked: true, burnt: true, rotten: true } });

    assert.equal(rep.transform[0], 4);
    const noVariant = await createWorldItemAssets(assets(script));

    await assert.rejects(noVariant.resolve({ definition: d, visual: { rotten: true } }), /variant.*source|source.*variant/i);
    await assert.rejects(noVariant.resolve({ definition: definition('component FluidContainer { Capacity = 1, }') }), /unsupported/i);
});

test('source UseWorldItem alone selects world icon; missing world image returns the proven normal icon', async () => {
    const resolver = await createWorldItemAssets(assets(undefined, { 'media/inventory/world/WItem_Authored.png': png(10, 12) }));
    const world = await resolver.resolve({ definition: definition('UseWorldItem = true,') });

    assert.equal(world.source.texture, 'media/inventory/world/WItem_Authored.png');
    assert.deepEqual(world.quad, { left: -5, top: -9, width: 10, height: 12 });
    assert.equal((await resolver.resolve({ definition: definition() })).source.texture, 'media/textures/Item_Authored.png');
    const missing = await createWorldItemAssets(assets());

    assert.equal((await missing.resolve({ definition: definition('UseWorldItem = true,') })).source.texture, 'media/textures/Item_Authored.png');
});

test('source world attachment inversion preserves offset rotateXYZ and scale before the mesh transform', async () => {
    const resolver = await createWorldItemAssets(assets('mesh = WorldItems/Triangle, texture = WorldItems/Paint, scale = 2, attachment world { offset = 1 2 3, rotate = 0 0 90, scale = 2, }'));
    const rep = await resolver.resolve({ definition: definition('WorldStaticModel = Ground,') });
    const expected = [0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, -1, -1, -1.5, 1];

    for (const [i, element] of expected.entries()) {
        assert.ok(Math.abs(rep.transform[i] - element) < 1e-6);
    }
});

test('packed normal icons win loose paths and preserve source trim in the native sprite quad', async () => {
    /**
     * Encode a little-endian unsigned integer in the authored pack fixture.
     *
     * @param {number} value - Unsigned 32-bit field value.
     * @returns {Buffer} Four encoded bytes.
     */
    const integer = (value) => {
        const b = Buffer.alloc(4);

        b.writeUInt32LE(value);

        return b;
    };

    /**
     * Encode a length-prefixed UTF-8 string in the authored pack fixture.
     *
     * @param {string} value - Fixture string to encode.
     * @returns {Buffer} Byte length followed by UTF-8 bytes.
     */
    const string = (value) => Buffer.concat([integer(Buffer.byteLength(value)), Buffer.from(value)]);
    const end = Buffer.alloc(12);

    end.write('IEND', 4);
    // Header-only image framing: this test indexes source rectangles, never decodes pixels.
    const image = Buffer.concat([png(), end]);
    const pack = Buffer.concat([Buffer.from('PZPK'), integer(1), integer(1), string('AuthoredPage'), integer(1), integer(1),
        string('Item_Authored'), ...[2, 3, 4, 6, 1, 2, 10, 12].map(integer), integer(image.length), image]);
    const resolver = await createWorldItemAssets(assets(undefined, { 'media/texturepacks/UI2.pack': pack }));
    const rep = await resolver.resolve({ definition: definition() });

    assert.equal(rep.source.texture, 'media/texturepacks/UI2.pack');
    assert.deepEqual(rep.crop, { x: 2, y: 3, width: 4, height: 6 });
    assert.deepEqual(rep.quad, { left: -4, top: -7, width: 4, height: 6 });
});
