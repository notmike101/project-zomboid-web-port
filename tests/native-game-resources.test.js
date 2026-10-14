import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { createGameUI } from '../src/game-ui.js';
import { loadNativeGameResources } from '../src/native-game-resources.js';
import { openPack } from '../src/packs.js';
import { parsePngHeader } from '../src/renderer.js';

/**
 * Build independently authored source declarations behind the real content resolver.
 *
 * @returns {object} Content directory, selected package and mutable authored inputs.
 */
function fixture() {
    const entries = new Map([
        ...['env', 'ISBaseObject', 'ISUI/ISUIElement', 'ISUI/Layout/ISDock', 'ISUI/Style/UIHorizontalAlignment', 'ISUI/ISUITextureGetter'].map((name) => [`media/lua/client/${name}.lua`, '']),
        ...['TimedActions/ISBaseTimedAction', 'TimedActions/ISTimedActionQueue', 'TimedActions/ISGrabItemAction', 'TimedActions/ISOpenCloseDoor', 'TimedActions/WalkToTimedAction', 'TimedActions/ISWaitWhileGettingUp', 'luautils', 'ISUI/ISContextMenu', 'ISUI/ISPanelJoypad', 'ISUI/ISScrollingListBox', 'ISUI/ISTradingUI', 'ISUI/ISWorldObjectContextMenu', 'ISUI/ISToolTip', 'ISUI/ISToolTipInv', 'ISUI/ISInventoryItem', 'ISUI/ISInventoryPage', 'ISUI/ISRichTextPanel'].map((name) => [`media/lua/client/${name}.lua`, '']),
        ...['ISUI/PlayerData/ISPlayerDataObject', 'ISUI/PlayerData/ISPlayerData', 'BuildingObjects/ISMoveableCursor', 'RadioCom/ISRadioWindow'].map((name) => [`media/lua/client/${name}.lua`, '']),
        ['media/fonts/EN/fonts.txt', 'VERSION = 1,\nfont Small { fnt = tiny.fnt, img = tiny.png, }\nfont Medium { fnt = middle.fnt, img = middle.png, }\nfont Large { fnt = big.fnt, img = big.png, }\nfont NewSmall { fnt = tiny.fnt, img = tiny.png, }'],
        ...[['tiny', 10, 12], ['middle', 17, 19], ['big', 24, 28]].flatMap(([name, size, height]) => [
            [`media/fonts/${name}.fnt`, `info face="Authored" size=${size}\ncommon lineHeight=${height} base=9 scaleW=32 scaleH=16 pages=1 packed=0\npage id=0 file="${name}.png"\nchars count=1\nchar id=65 x=0 y=0 width=6 height=8 xoffset=1 yoffset=2 xadvance=7 page=0 chnl=15`],
            [`media/fonts/${name}.png`, name],
        ]),
    ]);
    const content = {
        manifest: { sourceBuild: { version: '42.21.0' }, files: [...entries.keys()].map((path) => ({ path })), mods: [{ root: 'mods/Authored', kind: 'native-lua', files: [] }] },
        /**
         * Resolve authored text and atlas bytes; absent indexed files are integrity errors.
         *
         * @param {string} path - Exact indexed resource.
         * @returns {object} Text and file resource readers.
         */
        getFile(path) {
            if (!entries.has(path)) {
                throw new Error(`Unavailable indexed source: ${path}`);
            }

            const bytes = new Blob([entries.get(path)]);

            return {
                /**
                 * Return authored text.
                 *
                 * @returns {Promise<string>} Source text.
                 */
                text: () => Promise.resolve(entries.get(path)),
                /**
                 * Return authored texture payload.
                 *
                 * @returns {Promise<File>} Source atlas file.
                 */
                toFile: () => new Promise((resolve) => {
                    resolve(new File([entries.get(path)], path, { type: 'image/png' }));
                }),
                size: bytes.size,
                /**
                 * Read actual authored pack bytes through the bounded source interface.
                 *
                 * @param {number} start - Slice start.
                 * @param {number} end - Slice end.
                 * @returns {Blob} Requested original test bytes.
                 */
                slice: (start, end) => bytes.slice(start, end),
            };
        },
    };
    const descriptors = [{ root: 'mods/Authored', nativeId: 'Authored', tree: 'root', sources: [{ path: 'media/lua/client/Authored.lua', source: 'ISUIElement = ISUIElement; getTexture("media/ui/optional-absent.png")' }] }];

    return { content, descriptors, entries };
}

test('native UI font closure follows actual declarations rather than assumed filenames', async () => {
    const { content, descriptors } = fixture();
    const result = await loadNativeGameResources(content, descriptors, 60);

    assert.equal(result.fonts.Small.atlasPath, 'media/fonts/tiny.png');
    assert.equal(result.fonts.Medium.atlasPath, 'media/fonts/middle.png');
    assert.equal(result.fonts.Large.atlasPath, 'media/fonts/big.png');
    assert.deepEqual({ ...result.fontSize }, { Small: 10, Medium: 17, Large: 24 });
    assert.deepEqual({ ...result.fontLineHeight }, { Small: 12, Medium: 19, Large: 28 });
    assert.equal(result.fontData.Medium.glyphs.get(65).xadvance, 7);
    assert.deepEqual(result.textures.map(({ path }) => path), ['media/fonts/tiny.png', 'media/fonts/middle.png', 'media/fonts/big.png']);
});

test('missing mandatory Medium descriptor or mismatched source atlas never falls back to Small', async () => {
    const { content, descriptors, entries } = fixture();

    entries.delete('media/fonts/middle.fnt');
    await assert.rejects(loadNativeGameResources(content, descriptors, 60), /Unavailable indexed source.*middle/);
    entries.set('media/fonts/middle.fnt', entries.get('media/fonts/tiny.fnt'));
    await assert.rejects(loadNativeGameResources(content, descriptors, 60), /Medium.*atlas/);
    entries.set('media/fonts/EN/fonts.txt', 'font Small { fnt = tiny.fnt, img = tiny.png, }');
    await assert.rejects(loadNativeGameResources(content, descriptors, 60), /Medium.*declaration/);
});

test('selected native font overlay supplies its actual metrics and bytes in activation order', async () => {
    const { content, descriptors, entries } = fixture();
    const path = 'mods/Authored/media/fonts/middle.fnt';

    entries.set(path, entries.get('media/fonts/middle.fnt').replace('size=17', 'size=21').replace('lineHeight=19', 'lineHeight=25'));
    content.manifest.files.push({ path });
    content.manifest.mods[0].files.push(path);
    const result = await loadNativeGameResources(content, descriptors, 60);

    assert.equal(result.fontSize.Medium, 21);
    assert.equal(result.fontLineHeight.Medium, 25);
    assert.equal(result.fontSize.Small, 10);
    assert.equal(result.fontData.Medium.page, 'middle.png');
});

test('vanilla source UI activation loads actual fonts without requiring any installed mod', async () => {
    const { content } = fixture();

    assert.equal(await loadNativeGameResources(content, [], 60), undefined);
    const resources = await loadNativeGameResources(content, [], 60, { requireUI: true });

    assert.equal(resources.fontSize.Medium, 17);
    assert.equal(resources.fontLineHeight.Large, 28);
    assert.equal(resources.fontData.Small.glyphs.get(65).xadvance, 7);
});

test('vanilla source UI rejects an unindexed genuine context dependency before resource activation', async () => {
    const { content } = fixture();

    content.manifest.files = content.manifest.files.filter(({ path }) => path !== 'media/lua/client/ISUI/ISContextMenu.lua');
    await assert.rejects(loadNativeGameResources(content, [], 60, { requireUI: true }), /ISUI\/ISContextMenu.*found 0/);
});

test('lazy original UI seeds traverse exact transitive literal paths without executing unrelated modules', async () => {
    const { content, entries } = fixture();
    const page = 'media/lua/client/ISUI/ISInventoryPage.lua';
    const body = 'media/lua/shared/Body/Storage.lua';
    const vehicle = 'media/lua/client/Vehicles/ISUI/Vehicle.lua';
    const leaf = 'media/lua/shared/TimedActions/Leaf.lua';
    const unrelated = 'media/lua/client/Vehicles/ISUI/MissingSibling.lua';

    entries.set(page, 'require "body/storage"');
    entries.set(body, 'require "ISUI/MissingSibling"; require --[[gap]] ("vehicles/isui/vehicle.lua")');
    entries.set(vehicle, 'require [[TimedActions/Leaf]]');
    entries.set(leaf, 'require "isui/isinventorypage"');
    entries.set(unrelated, 'error("not an exact required path")');
    content.manifest.files.push(...[body, vehicle, leaf, unrelated].map((path) => ({ path })));
    const resources = await loadNativeGameResources(content, [], 60, { requireUI: true });

    for (const path of [page, body, vehicle, leaf]) {
        const source = resources.engineSources.find((entry) => entry.path === path);

        assert.equal(source?.source, entries.get(path));
        assert.equal(source?.execute, false);
    }

    assert.equal(resources.engineSources.some(({ path }) => path === unrelated), false);
    assert.deepEqual(resources.engineSources.filter(({ execute }) => execute).map(({ path }) => path), [
        'media/lua/client/env.lua', 'media/lua/client/ISBaseObject.lua', 'media/lua/client/ISUI/ISUIElement.lua',
        'media/lua/client/ISUI/Layout/ISDock.lua', 'media/lua/client/ISUI/Style/UIHorizontalAlignment.lua',
        'media/lua/client/ISUI/ISUITextureGetter.lua',
    ]);
});

test('original startup lookup preserves manifest path casing under native case-insensitive identity', async () => {
    const { content, entries } = fixture();
    const original = 'media/lua/client/ISUI/ISUIElement.lua';
    const actual = 'media/lua/client/isui/isuiElement.lua';

    entries.set(actual, entries.get(original));
    entries.delete(original);
    content.manifest.files.find(({ path }) => path === original).path = actual;
    const resources = await loadNativeGameResources(content, [], 60, { requireUI: true });

    assert.equal(resources.engineSources.some(({ path }) => path === original), false);
    assert.equal(resources.engineSources.find(({ path }) => path === actual)?.execute, true);
});

/**
 * Encode a valid independently authored PNG and real PZPK sprite geometry.
 *
 * @param {boolean} [duplicate=false] - Include a second genuine occurrence of the same sprite name.
 * @param {number} [width=8] - Actual source PNG width.
 * @param {number} [height=8] - Actual source PNG height.
 * @returns {Buffer} One-page pack with a trimmed named inventory icon.
 */
function itemIconPack(duplicate = false, width = 8, height = 8) {
    /**
     * Encode a little-endian pack field.
     *
     * @param {number} value - Field value.
     * @returns {Buffer} Encoded field.
     */
    function integer(value) {
        const bytes = Buffer.alloc(4);

        bytes.writeUInt32LE(value);

        return bytes;
    }

    /**
     * Encode a pack string.
     *
     * @param {string} value - Source string.
     * @returns {Buffer} Encoded string.
     */
    function string(value) {
        const bytes = Buffer.from(value);

        return Buffer.concat([integer(bytes.length), bytes]);
    }

    /**
     * Encode a valid PNG chunk with independently computed CRC.
     *
     * @param {string} kind - Chunk kind.
     * @param {Buffer} bytes - Chunk payload.
     * @returns {Buffer} Encoded chunk.
     */
    function chunk(kind, bytes) {
        const body = Buffer.concat([Buffer.from(kind), bytes]);
        let crc = 0xFF_FF_FF_FF;

        for (const byte of body) {
            crc ^= byte;

            for (let bit = 0; bit < 8; bit++) {
                crc = (crc >>> 1) ^ ((crc & 1) ? 0xED_B8_83_20 : 0);
            }
        }

        const length = Buffer.alloc(4);
        const checksum = Buffer.alloc(4);

        length.writeUInt32BE(bytes.length);
        checksum.writeUInt32BE((crc ^ 0xFF_FF_FF_FF) >>> 0);

        return Buffer.concat([length, body, checksum]);
    }

    const header = Buffer.alloc(13);

    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 6;
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc(height * (width * 4 + 1), 0))), chunk('IEND', Buffer.alloc(0))]);

    const sprite = Buffer.concat([string('Item_Authored'), ...[2, 1, 3, 4, 1, 2, 5, 7].map(integer)]);

    return Buffer.concat([Buffer.from('PZPK'), integer(1), integer(1), string('AuthoredItems'), integer(duplicate ? 2 : 1), integer(1),
        sprite, ...(duplicate ? [sprite] : []), integer(png.length), png]);
}

test('original declared item icons preserve real pack aliases, crop, trim and deferred definition resolution', async () => {
    const { content, descriptors, entries } = fixture();
    const path = 'media/texturepacks/UI2.pack';

    entries.set(path, itemIconPack());
    content.manifest.files.push({ path });
    const definitions = [{ fullType: 'Authored.Clothing', rawFields: [{ name: 'Icon', value: 'Authored', offset: 0 }] }];
    const resources = await loadNativeGameResources(content, descriptors, 60, { itemDefinitions: definitions });
    const icon = resources.textures.find((entry) => entry.path === 'Item_Authored');

    assert.deepEqual(icon.aliases, ['media/textures/Item_Authored.png']);
    assert.deepEqual(icon.crop, { x: 2, y: 1, width: 3, height: 4 });
    assert.deepEqual([icon.widthOrig, icon.heightOrig, icon.offsetX, icon.offsetY], [5, 7, 1, 2]);
    assert.equal(icon.file.type, 'image/png');
    const later = await resources.resolveItemTextures(definitions);

    assert.equal(later[0].file, icon.file);
    assert.deepEqual(later[0].crop, { x: 2, y: 1, width: 3, height: 4 });
    await assert.rejects(resources.resolveItemTextures([{ fullType: 'Authored.Absent', rawFields: [{ name: 'Icon', value: 'NotThere' }] }]), /Required.*Item_NotThere/);
    await assert.rejects(resources.resolveItemTextures([{ fullType: 'Authored.Invalid', rawFields: [{ name: 'Icon', value: '../Authored' }] }]), /Invalid.*Icon/);
});

test('original NewSmall enum is aliased only by matching actual source descriptor and atlas declarations', async () => {
    const { content, descriptors, entries } = fixture();
    const resources = await loadNativeGameResources(content, descriptors, 60, { requireUI: true });

    assert.deepEqual({ ...resources.fontAliases }, { NewSmall: 'Small' });
    entries.set('media/fonts/EN/fonts.txt', entries.get('media/fonts/EN/fonts.txt').replace('font NewSmall { fnt = tiny.fnt, img = tiny.png, }', 'font NewSmall { fnt = middle.fnt, img = middle.png, }'));
    await assert.rejects(loadNativeGameResources(content, descriptors, 60, { requireUI: true }), /NewSmall.*declaration.*Small/);
});

test('packed item sprites take precedence over same-name loose PNGs and genuine pack misses use real loose dimensions', async () => {
    const { content, descriptors, entries } = fixture();
    const packPath = 'media/texturepacks/UI2.pack';
    const sharedLoose = 'media/textures/Item_Authored.png';
    const absentLoose = 'media/textures/Item_LooseOnly.png';
    const packBytes = itemIconPack();
    const page = await (await openPack(new Blob([packBytes]))).pageBlob(0);

    // The actual loose PNG is 8x8; the same-name packed crop is 3x4 with a 5x7 canvas.
    entries.set(packPath, packBytes);
    entries.set(sharedLoose, page);
    entries.set(absentLoose, page);
    content.manifest.files.push({ path: packPath }, { path: sharedLoose }, { path: absentLoose });
    const resources = await loadNativeGameResources(content, descriptors, 60, {
        itemDefinitions: [
            { fullType: 'Authored.Packed', rawFields: [{ name: 'Icon', value: 'Authored' }] },
            { fullType: 'Authored.Loose', rawFields: [{ name: 'IconsForTexture', value: 'LooseOnly;UnusedChoice' }] },
        ],
    });
    const uploaded = Object.values(resources.fonts).map(({ atlasPath }) => ({ path: atlasPath, width: 32, height: 16 }));
    let destroyed = 0;

    uploaded.push(...await Promise.all(resources.textures.filter(({ path }) => path.includes('Item_')).map(async (entry) => {
        const source = parsePngHeader(new Uint8Array(await entry.file.slice(0, 33).arrayBuffer()));

        return {
            ...entry, width: entry.crop?.width ?? source.width, height: entry.crop?.height ?? source.height,
            /**
             * Release the chosen physical image independently of its two aliases.
             *
             * @returns {number} Previous physical release count.
             */
            destroy: () => destroyed++,
        };
    })));

    const ui = createGameUI();

    ui.setViewport(100, 80);
    ui.initialize({ textures: uploaded, fonts: resources.fonts, fontAliases: resources.fontAliases, translations: {}, settings: resources.settings });
    const b = ui.bindings;
    const packed = b.call('texture', 'source', 'Item_Authored');
    const loose = b.call('texture', 'source', absentLoose);

    assert.equal(b.call('texture', 'source', sharedLoose), packed);
    assert.equal(b.call('texture', 'source', absentLoose), loose);
    assert.equal(b.call('texture', 'source', 'Item_LooseOnly'), null);
    const id = b.call('new', 'source', {});

    b.call('add', 'source', id);
    ui.setCallbacks(id, {
        /** Consume selected source geometry through genuine native aspect drawing. */
        render: () => {
            b.call('element', 'source', id, 'DrawTextureScaledAspect', packed, 10, 10, 10, 14, 1, 1, 1, 1);
            b.call('element', 'source', id, 'DrawTextureScaledAspect', loose, 30, 10, 10, 14, 1, 1, 1, 1);
        },
    });
    try {
        assert.deepEqual(ui.render().map(({ x, y, width, height }) => [x, y, width, height]), [
            [12, 13, 6, 8], [30, 12, 10, 10],
        ]);
    } finally {
        ui.dispose();
    }

    assert.equal(destroyed, 2);
});

test('indexed packed icon ambiguity and damaged bytes refuse rather than falling through to a valid loose image', async () => {
    const { content, descriptors, entries } = fixture();
    const packPath = 'media/texturepacks/UI2.pack';
    const loosePath = 'media/textures/Item_Authored.png';
    const image = await (await openPack(new Blob([itemIconPack()]))).pageBlob(0);

    entries.set(packPath, itemIconPack(true));
    entries.set(loosePath, image);
    content.manifest.files.push({ path: packPath }, { path: loosePath });
    const options = { itemDefinitions: [{ fullType: 'Authored.Clothing', rawFields: [{ name: 'Icon', value: 'Authored' }] }] };

    await assert.rejects(loadNativeGameResources(content, descriptors, 60, options), /Item_Authored.*found 2/);
    entries.set(packPath, Buffer.from('damaged authored pack'));
    await assert.rejects(loadNativeGameResources(content, descriptors, 60, options), /pack|PZPK|truncated/iu);
});

test('startup literal item aliases and later definitions retain one packed selection instead of resident loose pixels', async () => {
    const { content, descriptors, entries } = fixture();
    const packPath = 'media/texturepacks/UI2.pack';
    const loosePath = 'media/textures/Item_Authored.png';
    const otherPath = 'media/variant/Item_Authored.png';
    const packBytes = itemIconPack();
    const image = await (await openPack(new Blob([packBytes]))).pageBlob(0);

    entries.set(packPath, packBytes);
    entries.set(loosePath, image);
    content.manifest.files.push({ path: packPath }, { path: loosePath });
    descriptors[0].sources[0].source += `; getTexture("${loosePath}"); getTexture("Item_Authored"); getTexture("${otherPath}"); getTexture("Item_GenuinelyAbsent")`;
    const resources = await loadNativeGameResources(content, descriptors, 60);
    const selected = resources.textures.find(({ path }) => path === 'Item_Authored');
    const source = parsePngHeader(new Uint8Array(await selected.file.slice(0, 33).arrayBuffer()));
    let destroyed = 0;
    const ui = createGameUI();

    ui.setViewport(100, 80);
    ui.initialize({
        textures: [
            ...Object.values(resources.fonts).map(({ atlasPath }) => ({ path: atlasPath, width: 32, height: 16 })),
            {
                ...selected, width: selected.crop?.width ?? source.width, height: selected.crop?.height ?? source.height,
                /**
                 * Release the single chosen sprite despite literal and definition aliases.
                 *
                 * @returns {number} Previous physical release count.
                 */
                destroy: () => destroyed++,
            },
        ],
        fonts: resources.fonts, fontAliases: resources.fontAliases, translations: {}, settings: resources.settings,
    });
    const later = await resources.resolveItemTextures([{ fullType: 'Authored.Later', rawFields: [{ name: 'Icon', value: 'Authored' }] }]);

    assert.equal(later.find(({ path }) => path === 'Item_Authored'), selected);
    assert.deepEqual(selected.crop, { x: 2, y: 1, width: 3, height: 4 });
    const b = ui.bindings;
    const id = b.call('new', 'source', {});
    const packed = b.call('texture', 'source', 'Item_Authored');

    assert.equal(b.call('texture', 'source', loosePath), packed);
    assert.equal(b.call('texture', 'source', otherPath), packed);
    assert.equal(ui.hasTexture(later[0].path), true);
    assert.equal(b.call('texture', 'source', 'Item_GenuinelyAbsent'), null);
    await assert.rejects(resources.resolveItemTextures([{ fullType: 'Authored.Missing', rawFields: [{ name: 'Icon', value: 'GenuinelyAbsent' }] }]), /Required.*Item_GenuinelyAbsent/);
    b.call('add', 'source', id);
    ui.setCallbacks(id, {
        /** Draw both normalized source requests after the later definition reuses residency. */
        render: () => {
            b.call('element', 'source', id, 'DrawTextureScaledAspect', b.call('texture', 'source', loosePath), 10, 10, 10, 14, 1, 1, 1, 1);
            b.call('element', 'source', id, 'DrawTextureScaledAspect', b.call('texture', 'source', otherPath), 30, 10, 10, 14, 1, 1, 1, 1);
        },
    });
    try {
        assert.deepEqual(ui.render().map(({ x, y, width, height }) => [x, y, width, height]), [
            [12, 13, 6, 8], [32, 13, 6, 8],
        ]);
    } finally {
        ui.dispose();
    }

    assert.equal(destroyed, 1);
});

test('genuine packed misses preserve exact loose literal paths, canonical Icon fallback and independent image ownership', async () => {
    const { content, descriptors, entries } = fixture();
    const packPath = 'media/texturepacks/UI2.pack';
    const canonical = 'media/textures/Item_Custom.png';
    const variant = 'media/variant/Item_Custom.png';
    const missingAlternative = 'media/absent/Item_Custom.png';
    const variantOnly = 'media/variant/Item_VariantOnly.png';
    const bytes = itemIconPack();
    const square = await (await openPack(new Blob([bytes]))).pageBlob(0);
    const wide = await (await openPack(new Blob([itemIconPack(false, 12, 6)]))).pageBlob(0);

    // UI2 contains Item_Authored only; neither requested basename has a packed match.
    entries.set(packPath, bytes);
    entries.set(canonical, square);
    entries.set(variant, wide);
    entries.set(variantOnly, wide);
    content.manifest.files.push({ path: packPath }, { path: canonical }, { path: variant }, { path: variantOnly });
    descriptors[0].sources[0].source += `; getTexture("${canonical}"); getTexture("${variant}"); getTexture("${missingAlternative}"); getTexture("${variantOnly}"); getTexture("Item_Custom")`;
    const resources = await loadNativeGameResources(content, descriptors, 60);
    const canonicalRecord = resources.textures.find(({ path }) => path === canonical);
    const later = await resources.resolveItemTextures([{ fullType: 'Authored.Custom', rawFields: [{ name: 'Icon', value: 'Custom' }] }]);

    assert.equal(later.find(({ path }) => path === canonical), canonicalRecord);
    const uploaded = Object.values(resources.fonts).map(({ atlasPath }) => ({ path: atlasPath, width: 32, height: 16 }));
    const destroyed = new Map();

    uploaded.push(...await Promise.all(resources.textures.filter(({ path }) => path.includes('Item_')).map(async (entry) => {
        const header = parsePngHeader(new Uint8Array(await entry.file.slice(0, 33).arrayBuffer()));

        return {
            ...entry, ...header,
            /** Dispose each exact source image once, not each same-basename request. */
            destroy: () => {
                destroyed.set(entry.path, (destroyed.get(entry.path) ?? 0) + 1);
            },
        };
    })));

    const ui = createGameUI();

    ui.setViewport(100, 80);
    ui.initialize({ textures: uploaded, fonts: resources.fonts, fontAliases: resources.fontAliases, translations: {}, settings: resources.settings });
    const b = ui.bindings;
    const canonicalTexture = b.call('texture', 'source', canonical);
    const variantTexture = b.call('texture', 'source', variant);

    assert.notEqual(canonicalTexture, variantTexture);
    assert.equal(b.call('texture', 'source', missingAlternative), null);
    assert.equal(b.call('texture', 'source', 'Item_Custom'), null);
    assert.equal(b.call('texture', 'source', 'media/textures/Item_VariantOnly.png'), null);
    await assert.rejects(resources.resolveItemTextures([{ fullType: 'Authored.VariantOnly', rawFields: [{ name: 'Icon', value: 'VariantOnly' }] }]), /Required.*Item_VariantOnly/);
    const id = b.call('new', 'source', {});

    b.call('add', 'source', id);
    ui.setCallbacks(id, {
        /** Consume each chosen loose file's real dimensions independently. */
        render: () => {
            b.call('element', 'source', id, 'DrawTexture', canonicalTexture, 0, 5, 1);
            b.call('element', 'source', id, 'DrawTexture', variantTexture, 20, 5, 1);
            b.call('element', 'source', id, 'DrawTexture', b.call('texture', 'source', variantOnly), 40, 5, 1);
        },
    });
    try {
        assert.deepEqual(ui.render().map(({ x, y, width, height }) => [x, y, width, height]), [
            [0, 5, 8, 8], [20, 5, 12, 6], [40, 5, 12, 6],
        ]);
    } finally {
        ui.dispose();
    }

    assert.deepEqual([...destroyed], [[canonical, 1], [variant, 1], [variantOnly, 1]]);
});
