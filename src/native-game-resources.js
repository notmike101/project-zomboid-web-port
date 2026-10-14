import { parseBitmapFont } from './game-ui.js';
import { normalItemIcon, parseItemDefinitions } from './item-definitions.js';
import { engineSources, selectNativeTree } from './native-mod-loader.js';
import { openPack } from './packs.js';

const UI_STARTUP = ['env', 'ISBaseObject', 'ISUI/ISUIElement', 'ISUI/Layout/ISDock', 'ISUI/Style/UIHorizontalAlignment', 'ISUI/ISUITextureGetter'];
const SOURCE_UI_MODULES = [
    'TimedActions/ISBaseTimedAction', 'TimedActions/ISTimedActionQueue', 'TimedActions/ISGrabItemAction',
    'TimedActions/ISOpenCloseDoor', 'TimedActions/WalkToTimedAction', 'TimedActions/ISWaitWhileGettingUp', 'luautils',
    'ISUI/ISContextMenu', 'ISUI/ISPanelJoypad', 'ISUI/ISScrollingListBox', 'ISUI/ISTradingUI',
    'ISUI/ISWorldObjectContextMenu', 'ISUI/ISToolTip', 'ISUI/ISToolTipInv', 'ISUI/ISInventoryItem', 'ISUI/ISInventoryPage',
    'ISUI/ISRichTextPanel',
    'ISUI/PlayerData/ISPlayerDataObject', 'ISUI/PlayerData/ISPlayerData',
    'BuildingObjects/ISMoveableCursor', 'RadioCom/ISRadioWindow',
];
const FONT_DECLARATIONS = 'media/fonts/EN/fonts.txt';
const FONT_NAMES = ['Small', 'Medium', 'Large'];

/**
 * Seed missing original shoes and hands wearables, retaining present definitions and owners.
 * Verified script Item constructor defaults precede explicitly authored source fields.
 *
 * @param {object} engine - Uncommitted candidate engine, fresh or restored.
 * @param {object} content - Validated external content directory.
 * @returns {Promise<void>} Registers source-ordered shoes and hands wearables.
 */
export async function seedOriginalWearables(engine, content) {
    const path = 'media/scripts/generated/items/clothing.txt';
    const source = content.getFile(path);
    const definitions = parseItemDefinitions(await source.text(), {
        path, sourceBuild: content.manifest.sourceBuild, size: source.size, lastModified: source.lastModified,
    }).filter((definition) => definition.bodyLocation === 'base:shoes' || definition.bodyLocation === 'base:hands');

    for (const fullType of ['Base.Shoes_ArmyBoots', 'Base.Shoes_FlipFlop']) {
        if (!definitions.some((definition) => definition.fullType === fullType)) {
            throw new Error(`Original footwear definition missing from ${path}: ${fullType}`);
        }
    }

    const existing = new Set(engine.itemDefinitions().map((definition) => definition.fullType));

    for (const definition of definitions) {
        if (existing.has(definition.fullType)) {
            continue;
        }

        // Project clothing policy: one wearable instance per stack, not a native default claim.
        engine.registerItemDefinition({
            conditionMax: 10, conditionLowerChanceOneIn: 10, weight: 1, runSpeedModifier: 1, removeOnBroken: true,
            ...definition, stackLimit: 1,
        }, { owner: 'ProjectZomboid' });
    }
}

/**
 * Resolve the actual selected original resource closure from the manifest inventory.
 * EN, 1x Small/Medium/Large and 32px moodles are explicit port choices, not native defaults.
 *
 * @param {object} content - Validated external content directory.
 * @param {object[]} descriptors - Exact native subsequence of the full actual activation order.
 * @param {number} lockFPS - Actual fixed-step scheduler rate.
 * @param {{requireUI?:boolean,itemDefinitions?:object[]}} [options] - Explicit original UI demand and source-backed item definitions needing icons.
 * @returns {Promise<object|undefined>} Candidate resources, or no UI for movement-only mods.
 */
export async function loadNativeGameResources(content, descriptors, lockFPS, { requireUI = false, itemDefinitions = [] } = {}) {
    if (!requireUI && !descriptors.some((entry) => entry.sources.some(({ source }) => /\bISUIElement\b|\bISContextMenu\b|\bUIFont\b|\bgetTextManager\s*\(|\bgetTexture\s*\(|PZAPI\.ModOptions/u.test(source)))) {
        return undefined;
    }

    const paths = new Set(content.manifest.files.map((entry) => entry.path));
    const startup = [];

    for (const name of [...UI_STARTUP, ...(requireUI ? SOURCE_UI_MODULES : [])]) {
        const matches = [...paths].filter((path) => /^media\/lua\/(shared|client|server)\//u.test(path)
            && path.replace(/^media\/lua\/(shared|client|server)\//u, '').replace(/\.lua$/u, '').toLowerCase() === name.toLowerCase());

        if (matches.length !== 1) {
            throw new Error(`Original UI startup module ${name} requires one manifest source; found ${matches.length}.`);
        }

        const path = matches[0];

        // eslint-disable-next-line no-await-in-loop
        startup.push({ path, source: await content.getFile(path).text(), execute: UI_STARTUP.includes(name) });
    }

    const sources = await engineSources(descriptors, content, startup);
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

    let itemPack;
    const packedItemTextures = new Map();
    const itemPageFiles = new Map();
    const looseItemTextures = new Map();
    const literalItemRequests = new Map();

    /**
     * Resolve actual packed names, exact literal paths and canonical declared Icon fallbacks.
     * Basename sharing applies only to a packed hit; loose resources retain request identity.
     *
     * @param {object[]} definitions - Current source-backed item definition metadata.
     * @returns {Promise<object[]>} Actual image files and source crop/trim metadata.
     */
    async function resolveItemTextures(definitions) {
        if (!Array.isArray(definitions)) {
            throw new TypeError('Item texture definitions must be an array');
        }

        const names = new Set(literalItemRequests.keys());
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
            if (packedItemTextures.has(name)) {
                result.push(packedItemTextures.get(name));
                continue;
            }

            const canonical = `media/textures/${name}.png`;
            const packPath = 'media/texturepacks/UI2.pack';
            let pack;

            if (paths.has(packPath)) {
                itemPack ??= openPack(content.getFile(packPath));
                // eslint-disable-next-line no-await-in-loop
                pack = await itemPack;
            }

            const matches = pack?.lookupAll(name) ?? [];

            if (matches.length > 1) {
                throw new Error(`Required original item texture ${name} requires one UI2 sprite; found ${matches.length}`);
            }

            if (matches.length === 0) {
                const requests = new Set(literalItemRequests.get(name) ?? []);

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

                    if (!looseItemTextures.has(requested)) {
                        // eslint-disable-next-line no-await-in-loop
                        const file = await content.getFile(source).toFile();

                        looseItemTextures.set(requested, { path: requested, aliases: [], file });
                    }

                    result.push(looseItemTextures.get(requested));
                }

                continue;
            }

            const sprite = matches[0];

            if (!sprite.w || !sprite.h) {
                throw new Error(`Required original item texture ${name} has no drawable source rectangle`);
            }

            if (!itemPageFiles.has(sprite.pageIndex)) {
                // eslint-disable-next-line no-await-in-loop
                const blob = await pack.pageBlob(sprite.pageIndex);

                itemPageFiles.set(sprite.pageIndex, new File([blob], `UI2_${sprite.pageIndex}.png`, { type: 'image/png' }));
            }

            const entry = {
                path: name,
                aliases: [...new Set([canonical, ...(literalItemRequests.get(name) ?? [])])].filter((value) => value !== name),
                file: itemPageFiles.get(sprite.pageIndex),
                crop: { x: sprite.x, y: sprite.y, width: sprite.w, height: sprite.h },
                widthOrig: sprite.totalW, heightOrig: sprite.totalH, offsetX: sprite.xoff, offsetY: sprite.yoff,
            };

            packedItemTextures.set(name, entry);
            result.push(entry);
        }

        return result;
    }

    for (const { source } of [...sources, ...descriptors.flatMap((entry) => entry.sources)]) {
        for (const match of source.matchAll(/\bgetTexture\s*\(\s*(["'])([^"'\r\n]+)\1\s*\)/gu)) {
            const requested = match[2];
            const normalized = requested.replaceAll('\\', '/').replace(/\.png$/u, '');
            const name = normalized.slice(normalized.lastIndexOf('/') + 1);

            if (name.startsWith('Item_') && !normalized.includes('/mods/') && !normalized.endsWith('.txt')) {
                const requests = literalItemRequests.get(name) ?? new Set();

                requests.add(requested);
                literalItemRequests.set(name, requests);
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

    const itemTextures = await resolveItemTextures(itemDefinitions);

    for (const entry of itemTextures) {
        for (const alias of [entry.path, ...entry.aliases]) {
            textures.delete(alias);
        }
    }

    const loaded = [];

    for (const [path, source] of textures) {
        // eslint-disable-next-line no-await-in-loop
        loaded.push({ path, file: await content.getFile(source).toFile() });
    }

    loaded.push(...itemTextures);

    return {
        engineSources: sources,
        textures: loaded,
        indexedTextures: [...new Set([...inventory.keys(), ...itemTextures.flatMap((entry) => [entry.path, ...entry.aliases])])],
        fonts, fontData, fontSize, fontLineHeight, fontAliases,
        translations,
        resolveItemTextures,
        settings: {
            moodleSize: 1, fontSizeReal: 1, lockFPS,
            gray: { r: 1, g: 1, b: 1, a: 1 },
            goodHighlight: { r: 0, g: 1, b: 0, a: 1 },
            badHighlight: { r: 1, g: 0, b: 0, a: 1 },
        },
    };
}
