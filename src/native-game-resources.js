import { parseItemDefinitions } from './item-definitions.js';
import { engineSources, selectNativeTree } from './native-mod-loader.js';

const UI_STARTUP = ['env', 'ISBaseObject', 'ISUI/ISUIElement', 'ISUI/Layout/ISDock', 'ISUI/Style/UIHorizontalAlignment', 'ISUI/ISUITextureGetter'];
const FONT_DESCRIPTOR = 'media/fonts/zomboidSmall.fnt';
const FONT_ATLAS = 'media/fonts/zomboidSmall_0.png';

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
 * EN, 1x Small and 32px moodles are explicit port choices, not native defaults.
 *
 * @param {object} content - Validated external content directory.
 * @param {object[]} descriptors - Exact native subsequence of the full actual activation order.
 * @param {number} lockFPS - Actual fixed-step scheduler rate.
 * @returns {Promise<object|undefined>} Candidate resources, or no UI for movement-only mods.
 */
export async function loadNativeGameResources(content, descriptors, lockFPS) {
    if (!descriptors.some((entry) => entry.sources.some(({ source }) => /\bISUIElement\b|\bgetTexture\s*\(|PZAPI\.ModOptions/u.test(source)))) {
        return undefined;
    }

    const paths = new Set(content.manifest.files.map((entry) => entry.path));
    const startup = [];

    for (const name of UI_STARTUP) {
        const matches = [...paths].filter((path) => /^media\/lua\/(shared|client|server)\//u.test(path)
            && path.replace(/^media\/lua\/(shared|client|server)\//u, '').replace(/\.lua$/u, '') === name);

        if (matches.length !== 1) {
            throw new Error(`Original UI startup module ${name} requires one manifest source; found ${matches.length}.`);
        }

        const path = matches[0];

        // eslint-disable-next-line no-await-in-loop
        startup.push({ path, source: await content.getFile(path).text(), execute: true });
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

    for (const files of filesByPackage) {
        for (const file of files) {
            if (/^media\/.+\.png$/iu.test(file.local)) {
                inventory.set(file.local, file.path);
            }

            if (/^media\/ui\/.+\.png$/iu.test(file.local)) {
                textures.set(file.local, file.path);
            }
        }
    }

    for (const { source } of [...sources, ...descriptors.flatMap((entry) => entry.sources)]) {
        for (const match of source.matchAll(/\bgetTexture\s*\(\s*(["'])(media\/[^"']+\.png)\1\s*\)/gu)) {
            const path = inventory.get(match[2]);

            if (path) {
                textures.set(match[2], path);
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

    textures.set(FONT_ATLAS, FONT_ATLAS);
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

    const loaded = [];

    for (const [path, source] of textures) {
        // eslint-disable-next-line no-await-in-loop
        loaded.push({ path, file: await content.getFile(source).toFile() });
    }

    return {
        engineSources: sources,
        textures: loaded,
        indexedTextures: [...inventory.keys()],
        font: { descriptor: await content.getFile(FONT_DESCRIPTOR).text(), atlasPath: FONT_ATLAS },
        translations,
        settings: {
            moodleSize: 1, fontSizeReal: 1, lockFPS,
            gray: { r: 1, g: 1, b: 1, a: 1 },
            goodHighlight: { r: 0, g: 1, b: 0, a: 1 },
            badHighlight: { r: 1, g: 0, b: 0, a: 1 },
        },
    };
}
