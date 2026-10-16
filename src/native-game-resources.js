import { parseBitmapFont } from './game-ui.js';
import { normalItemIcon, parseItemDefinitions } from './item-definitions.js';
import { engineSources, selectNativeTree } from './native-mod-loader.js';
import { openPack } from './packs.js';

const UI_STARTUP = ['env', 'ISBaseObject', 'ISUI/ISUIElement', 'ISUI/Layout/ISDock', 'ISUI/Style/UIHorizontalAlignment', 'ISUI/ISUITextureGetter'];
const SOURCE_UI_MODULES = [
    'TimedActions/ISBaseTimedAction', 'TimedActions/ISTimedActionQueue', 'TimedActions/ISGrabItemAction',
    'TimedActions/ISInventoryTransferAction', 'TimedActions/ISTransferAction',
    'TimedActions/ISOpenCloseDoor', 'TimedActions/WalkToTimedAction', 'TimedActions/ISWaitWhileGettingUp', 'luautils',
    'ISUI/ISContextMenu', 'ISUI/ISPanelJoypad', 'ISUI/ISScrollingListBox', 'ISUI/ISTradingUI',
    'ISUI/ISWorldObjectContextMenu', 'ISUI/ISToolTip', 'ISUI/ISToolTipInv', 'ISUI/ISInventoryItem', 'ISUI/ISInventoryPage',
    'ISUI/ISRichTextPanel', 'ISUI/ISUIHandler',
    'ISUI/PlayerData/ISPlayerDataObject', 'ISUI/PlayerData/ISPlayerData',
    'BuildingObjects/ISMoveableCursor', 'RadioCom/ISRadioWindow',
    'ISUI/ISResizeableButton', 'ISUI/ISScrollBar',
    'Entity/ISEntityUI',
    'Entity/ISUI/BuildRecipe/ISBuildPanel', 'Entity/ISUI/CraftRecipe/ISHandCraftPanel',
    'Camping/CCampfireSystem',
];
const FONT_DECLARATIONS = 'media/fonts/EN/fonts.txt';
const FONT_NAMES = ['Small', 'Medium', 'Large'];

/**
 * Seed missing authored shoes, hands wearables and bags from the exact provisioned manifest.
 * Verified script Item constructor defaults precede explicitly authored source fields.
 *
 * @param {object} engine - Uncommitted candidate engine, fresh or restored.
 * @param {object} content - Validated external content directory.
 * @returns {Promise<void>} Registers source-ordered original definitions, retaining existing owners.
 */
export async function seedOriginalWearables(engine, content) {
    const build = content.manifest.sourceBuild;

    if (!build || !/^\d+\.\d+(?:\.\d+)?$/u.test(build.version) || !Array.isArray(content.manifest.files)) {
        throw new Error('Original item seeding requires a known manifest sourceBuild and authored file inventory.');
    }

    const paths = content.manifest.files.map(({ path }) => path)
        .filter((path) => /^media\/scripts\/generated\/items\/.+\.txt$/iu.test(path));
    const definitions = [];

    for (const path of paths) {
        const source = content.getFile(path);
        // eslint-disable-next-line no-await-in-loop
        const parsed = parseItemDefinitions(await source.text(), {
            path, sourceBuild: structuredClone(build), size: source.size, lastModified: source.lastModified,
        });

        for (const definition of parsed) {
            if (definition.bodyLocation === 'base:shoes' || definition.bodyLocation === 'base:hands'
                || definition.type?.toLowerCase() === 'container' || definition.type?.toLowerCase() === 'base:container') {
                definitions.push(definition);
            }
        }
    }

    for (const fullType of ['Base.Shoes_ArmyBoots', 'Base.Shoes_FlipFlop']) {
        if (!definitions.some((definition) => definition.fullType === fullType)) {
            throw new Error(`Original footwear definition missing from manifest-authored item scripts: ${fullType}`);
        }
    }

    if (!definitions.some((definition) => definition.type?.toLowerCase().replace(/^base:/u, '') === 'container')) {
        throw new Error('Original bag definitions are missing from manifest-authored item scripts.');
    }

    const existing = new Set(engine.itemDefinitions().map((definition) => definition.fullType));

    for (const definition of definitions) {
        if (existing.has(definition.fullType)) {
            continue;
        }

        const isBag = definition.type?.toLowerCase().replace(/^base:/u, '') === 'container';

        // Port policy: one clothing/bag instance per stack; constructor defaults are source-backed.
        engine.registerItemDefinition({
            conditionMax: 10, conditionLowerChanceOneIn: 10, weight: 1, runSpeedModifier: 1, removeOnBroken: true,
            bodyLocation: null, ...definition, isBag, stackLimit: 1,
            unsupportedSubtype: Boolean(definition.ammoType
                || definition.rawFields.some((field) => field.name.toLowerCase() === 'fluidcontainer')),
        }, { owner: 'ProjectZomboid' });
    }
}

/**
 * Resolve the actual selected original resource closure from the manifest inventory.
 * The unchanged root stdlib.lua must execute before every original game module.
 * EN, 1x Small/Medium/Large and 32px moodles are explicit port choices, not native defaults.
 *
 * @param {object} content - Validated external content directory.
 * @param {object[]} descriptors - Exact native subsequence of the full actual activation order.
 * @param {number} lockFPS - Actual fixed-step scheduler rate.
 * @param {{requireUI?:boolean,itemDefinitions?:object[]}} [options] - Explicit original UI demand and source-backed item definitions needing icons.
 * @returns {Promise<object>} Candidate equipment source closure and optional UI resources.
 */
export async function loadNativeGameResources(content, descriptors, lockFPS, { requireUI = false, itemDefinitions = [] } = {}) {
    const ui = requireUI || descriptors.some((entry) => entry.sources.some(({ source }) => /\bISUIElement\b|\bISContextMenu\b|\bUIFont\b|\bgetTextManager\s*\(|\b(?:getTexture|getImageButtonControl)\s*\(|PZAPI\.ModOptions/u.test(source)));

    const paths = new Set(content.manifest.files.map((entry) => entry.path));
    const stdlib = content.manifest.files.filter(({ path }) => path === 'stdlib.lua');

    if (stdlib.length !== 1) {
        throw new Error(`Original startup stdlib.lua requires one exact manifest source; found ${stdlib.length}.`);
    }

    const startup = [{ path: 'stdlib.lua', source: await content.getFile('stdlib.lua').text(), execute: true }];

    for (const name of ['NPCs/BodyLocations', ...(ui ? UI_STARTUP : []), ...(requireUI ? SOURCE_UI_MODULES : [])]) {
        const matches = [...paths].filter((path) => /^media\/lua\/(shared|client|server)\//u.test(path)
            && path.replace(/^media\/lua\/(shared|client|server)\//u, '').replace(/\.lua$/u, '').toLowerCase() === name.toLowerCase());

        if (matches.length !== 1) {
            throw new Error(`Original startup module ${name} requires one manifest source; found ${matches.length}.`);
        }

        const path = matches[0];

        // eslint-disable-next-line no-await-in-loop
        startup.push({ path, source: await content.getFile(path).text(), execute: name === 'NPCs/BodyLocations' || UI_STARTUP.includes(name) });
    }

    const sources = await engineSources(descriptors, content, startup);

    if (!ui) {
        return { engineSources: sources, ui: false, sourceFboRenderChunk: true };
    }

    const textures = new Map();
    const translations = Object.create(null);
    const filesByPackage = [];

    for (const descriptor of descriptors) {
        const entry = content.manifest.mods.find((item) => item.root === descriptor.root && item.kind === 'native-lua');

        if (!entry) {
            throw new Error(`Original native resource inventory is missing for ${descriptor.nativeId}.`);
        }

        const tree = selectNativeTree(entry, content.manifest.sourceBuild.version);

        if (tree.blocked || tree.tree !== descriptor.tree) {
            throw new Error(`Original resource tree differs from prepared Lua for ${descriptor.nativeId}.`);
        }

        filesByPackage.push(tree.files);
    }

    // Engine resources first; native common/tree overlays follow actual package activation order.
    const inventory = new Map([...paths].filter((path) => /^media\/.+\.png$/iu.test(path)).map((path) => [path, path]));
    const fontInventory = new Map([...paths].filter((path) => /^media\/fonts\/.+\.(?:txt|fnt|png)$/iu.test(path)).map((path) => [path, path]));

    for (const files of filesByPackage) {
        for (const file of files) {
            if (/^media\/.+\.png$/iu.test(file.local)) {
                inventory.set(file.local, file.path);
            }

            if (/^media\/fonts\/.+\.(?:txt|fnt|png)$/iu.test(file.local)) {
                fontInventory.set(file.local, file.path);
            }

            if (/^media\/ui\/.+\.png$/iu.test(file.local)) {
                textures.set(file.local, file.path);
            }
        }
    }

    let uiPack;
    const packedTextures = new Map();
    const uiPageFiles = new Map();
    const looseTextures = new Map();
    const literalTextureRequests = new Map();

    /**
     * Resolve literal UI/item requests and canonical declared Icon fallbacks through UI2.
     * Native Texture.getSharedTextureInternal tries the packed basename before the loose path.
     *
     * @param {object[]} definitions - Current source-backed item definition metadata.
     * @returns {Promise<object[]>} Actual image files and source crop/trim metadata.
     */
    async function resolveItemTextures(definitions) {
        if (!Array.isArray(definitions)) {
            throw new TypeError('Item texture definitions must be an array');
        }

        const names = new Set(literalTextureRequests.keys());
        const requiredNames = new Set();

        for (const definition of definitions) {
            const icon = normalItemIcon(definition);

            if (icon === null) {
                continue;
            }

            const name = `Item_${icon}`;

            names.add(name);
            requiredNames.add(name);
        }

        const result = [];

        for (const name of names) {
            if (packedTextures.has(name)) {
                result.push(packedTextures.get(name));
                continue;
            }

            const canonical = `media/textures/${name}.png`;
            const packPath = 'media/texturepacks/UI2.pack';
            let pack;

            if (paths.has(packPath)) {
                uiPack ??= openPack(content.getFile(packPath));
                // eslint-disable-next-line no-await-in-loop
                pack = await uiPack;
            }

            const matches = pack?.lookupAll(name) ?? [];

            if (matches.length > 1) {
                throw new Error(`Required original texture ${name} requires one UI2 sprite; found ${matches.length}`);
            }

            if (matches.length === 0) {
                const requests = new Set(literalTextureRequests.get(name) ?? []);

                if (requiredNames.has(name)) {
                    requests.add(canonical);
                }

                for (const requested of requests) {
                    const source = inventory.get(requested);

                    if (!source && requested === canonical && requiredNames.has(name)) {
                        throw new Error(`Required original item texture ${name} has no indexed packed sprite or canonical loose PNG`);
                    }

                    if (!source) {
                        continue;
                    }

                    if (!looseTextures.has(requested)) {
                        // eslint-disable-next-line no-await-in-loop
                        const file = await content.getFile(source).toFile();

                        looseTextures.set(requested, { path: requested, aliases: [], file });
                    }

                    result.push(looseTextures.get(requested));
                }

                continue;
            }

            const sprite = matches[0];

            if (!sprite.w || !sprite.h) {
                throw new Error(`Required original texture ${name} has no drawable source rectangle`);
            }

            if (!uiPageFiles.has(sprite.pageIndex)) {
                // eslint-disable-next-line no-await-in-loop
                const blob = await pack.pageBlob(sprite.pageIndex);

                uiPageFiles.set(sprite.pageIndex, new File([blob], `UI2_${sprite.pageIndex}.png`, { type: 'image/png' }));
            }

            const entry = {
                path: name,
                aliases: [...new Set([...(name.startsWith('Item_') ? [canonical] : []), ...(literalTextureRequests.get(name) ?? [])])].filter((value) => value !== name),
                file: uiPageFiles.get(sprite.pageIndex),
                crop: { x: sprite.x, y: sprite.y, width: sprite.w, height: sprite.h },
                widthOrig: sprite.totalW, heightOrig: sprite.totalH, offsetX: sprite.xoff, offsetY: sprite.yoff,
            };

            packedTextures.set(name, entry);
            result.push(entry);
        }

        return result;
    }

    for (const { source } of [...sources, ...descriptors.flatMap((entry) => entry.sources)]) {
        // Original image-button controls forward their literal image path to getTexture.
        for (const match of source.matchAll(/\b(?:getTexture|getImageButtonControl)\s*\(\s*(["'])([^"'\r\n]+)\1\s*\)/gu)) {
            const requested = match[2];
            const normalized = requested.replaceAll('\\', '/').replace(/\.png$/u, '');
            const name = normalized.slice(normalized.lastIndexOf('/') + 1);

            if ((name.startsWith('Item_') || /^media\/ui\/.+\.png$/u.test(requested))
                && !normalized.includes('/mods/') && !normalized.endsWith('.txt')) {
                const requests = literalTextureRequests.get(name) ?? new Set();

                requests.add(requested);
                literalTextureRequests.set(name, requests);
                continue;
            }

            // Other literal textures retain their existing exact media/PNG selection.
            if (/^media\/[^"']+\.png$/u.test(requested)) {
                const path = inventory.get(requested);

                if (path) {
                    textures.set(requested, path);
                }
            }
        }
    }

    if (descriptors.some((entry) => entry.nativeId === 'MoodleFramework')) {
        // MF_ISMoodle updateTextures/handleCacheOverride: dynamic 32px frame and four literal chevrons.
        for (const path of ['media/ui/Moodles/32/_Moodles_BGoutline.png', 'media/ui/Moodles/32/_Moodles_BGsolid.png',
            'media/ui/Moodle_chevron_up.png', 'media/ui/Moodle_chevron_up_border.png',
            'media/ui/Moodle_chevron_down.png', 'media/ui/Moodle_chevron_down_border.png']) {
            const selectedPath = inventory.get(path);

            if (!selectedPath) {
                throw new Error(`Required original MoodleFramework texture missing from manifest: ${path}`);
            }

            textures.set(path, selectedPath);
        }
    }

    const declarationPath = fontInventory.get(FONT_DECLARATIONS);

    if (!declarationPath) {
        throw new Error(`Required original font declarations missing from manifest: ${FONT_DECLARATIONS}`);
    }

    const declarations = await content.getFile(declarationPath).text();

    if (typeof declarations !== 'string' || declarations.length > 1_024 * 1_024) {
        throw new Error('Original font declarations exceed the supported text bound');
    }

    const fonts = Object.create(null);
    const fontData = Object.create(null);
    const fontSize = Object.create(null);
    const fontLineHeight = Object.create(null);
    const fontAliases = Object.create(null);
    const fontSourcePaths = new Map();

    for (const name of FONT_NAMES) {
        const matches = [...declarations.matchAll(/\bfont\s+(\w+)\s*\{([^{}]*)\}/gu)].filter((match) => match[1] === name);

        if (matches.length !== 1) {
            throw new Error(`Original ${name} font requires one declaration; found ${matches.length}`);
        }

        const body = matches[0][2];
        const fnt = /\bfnt\s*=\s*([A-Za-z0-9_.-]+\.fnt)\s*,/u.exec(body)?.[1];
        const img = /\bimg\s*=\s*([A-Za-z0-9_.-]+\.png)\s*,/u.exec(body)?.[1];

        if (!fnt || !img) {
            throw new Error(`Unsupported original ${name} font declaration`);
        }

        const descriptorPath = fontInventory.get(`media/fonts/${fnt}`);
        const atlasPath = `media/fonts/${img}`;
        const atlasSource = fontInventory.get(atlasPath);

        if (!descriptorPath || !atlasSource) {
            throw new Error(`Required original ${name} font descriptor/atlas missing from manifest`);
        }

        // eslint-disable-next-line no-await-in-loop
        const descriptor = await content.getFile(descriptorPath).text();
        const parsed = parseBitmapFont(descriptor);

        if (parsed.page !== img) {
            throw new Error(`Original ${name} font atlas declaration disagrees with descriptor page`);
        }

        fonts[name] = { descriptor, atlasPath };
        fontSourcePaths.set(name, descriptorPath);
        fontData[name] = parsed;
        fontSize[name] = parsed.size;
        fontLineHeight[name] = parsed.lineHeight;
        textures.set(atlasPath, atlasSource);
    }

    const newSmall = [...declarations.matchAll(/\bfont\s+NewSmall\s*\{([^{}]*)\}/gu)];

    if ((requireUI && newSmall.length !== 1) || newSmall.length > 1) {
        throw new Error('Original NewSmall tooltip font requires one source declaration');
    }

    if (newSmall.length === 1) {
        const fnt = /\bfnt\s*=\s*([A-Za-z0-9_.-]+\.fnt)\s*,/u.exec(newSmall[0][1])?.[1];
        const img = /\bimg\s*=\s*([A-Za-z0-9_.-]+\.png)\s*,/u.exec(newSmall[0][1])?.[1];

        if (fontInventory.get(`media/fonts/${fnt}`) !== fontSourcePaths.get('Small')
            || `media/fonts/${img}` !== fonts.Small.atlasPath) {
            throw new Error('Original NewSmall declaration must resolve the actual Small descriptor and atlas');
        }

        fontAliases.NewSmall = 'Small';
    }

    const translationFiles = [...paths].filter((path) => /^media\/lua\/shared\/Translate\/EN\/[^/]+\.json$/u.test(path));

    for (const files of filesByPackage) {
        translationFiles.push(...files.filter((file) => /^media\/lua\/shared\/Translate\/EN\/[^/]+\.json$/u.test(file.local)).map((file) => file.path));
    }

    for (const path of translationFiles) {
        // eslint-disable-next-line no-await-in-loop
        const document = JSON.parse(await content.getFile(path).text());

        if (!document || typeof document !== 'object' || Array.isArray(document)
            || Object.values(document).some((value) => typeof value !== 'string')) {
            throw new TypeError(`Original EN translation document must contain exact string keys: ${path}`);
        }

        for (const [key, value] of Object.entries(document)) {
            translations[key] = value;
        }
    }

    const resolvedTextures = await resolveItemTextures(itemDefinitions);

    for (const entry of resolvedTextures) {
        for (const alias of [entry.path, ...entry.aliases]) {
            textures.delete(alias);
        }
    }

    const loaded = [];

    for (const [path, source] of textures) {
        // eslint-disable-next-line no-await-in-loop
        loaded.push({ path, file: await content.getFile(source).toFile() });
    }

    loaded.push(...resolvedTextures);

    return {
        ui: true,
        // Source-build-bound mutable baseline from original PerformanceSettings; not inferred from WebGPU.
        sourceFboRenderChunk: true,
        engineSources: sources,
        textures: loaded,
        indexedTextures: [...new Set([...inventory.keys(), ...resolvedTextures.flatMap((entry) => [entry.path, ...entry.aliases])])],
        fonts, fontData, fontSize, fontLineHeight, fontAliases,
        translations,
        resolveItemTextures,
        settings: {
            // Explicit standalone UI presentation choices, not inferred source defaults.
            moodleSize: 1, fontSizeReal: 1, inventoryFont: 'Medium', tooltipFont: 'Small', cycleContainerKey: 'shift', lockFPS,
            gray: { r: 1, g: 1, b: 1, a: 1 },
            goodHighlight: { r: 0, g: 1, b: 0, a: 1 },
            badHighlight: { r: 1, g: 0, b: 0, a: 1 },
        },
    };
}
