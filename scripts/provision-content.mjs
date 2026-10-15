import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, link, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { nativeTileSources } from '../src/world-objects.js';

const extensions = new Set(['.pack', '.png', '.jpg', '.jpeg', '.dds', '.x', '.fbx', '.ogg', '.wav', '.bank', '.bin', '.lotheader', '.lotpack', '.tiles', '.txt', '.fnt', '.lua', '.xml', '.json', '.info', '.js', '.mjs', '.vert', '.frag', '.glsl', '.tmx', '.tga', '.bmp', '.gif', '.ini', '.cfg', '.properties', '.mesh', '.anim', '.ttf', '.otf', '.woff', '.woff2', '.csv', '.css', '.svg', '.html', '.webp', '.mp3', '.flac']);
const mapRoot = 'media/maps/challengemaps/Tutorial';
const startup = {
    packs: ['Tiles2x', 'Tiles2x.floor', 'Overlays2x', 'Overlays2x.floor', 'JumboTreesBigs2x'].map((name) => `media/texturepacks/${name}.pack`),
    cells: [[0, 0], [0, 1], [1, 0], [1, 1]].map(([x, y]) => ({
        x, y, navigation: `${mapRoot}/chunkdata_${x}_${y}.bin`,
        header: `${mapRoot}/${x}_${y}.lotheader`, lotpack: `${mapRoot}/world_${x}_${y}.lotpack`,
    })),
    character: {
        model: 'media/models_X/Skinned/MaleBody.x', idle: 'media/anims_X/Bob/Bob_Idle.x',
        walk: 'media/anims_X/Bob/Bob_Walk.x', texture: 'media/textures/Body/MaleBody02a.png',
    },
    tileDefinitions: nativeTileSources,
    audio: {
        footstep: 'media/sound/PZ_FootSteps_Concrete_01.wav',
        doorOpen: 'media/sound/dooropen.wav', doorClose: 'media/sound/doorclose.wav',
    },
    spawn: { x: 190.5, y: 190.5 },
};
const startupPaths = new Set([
    ...startup.packs, ...startup.cells.flatMap(({ navigation, header, lotpack }) => [navigation, header, lotpack]),
    ...Object.values(startup.character), ...startup.tileDefinitions.map(({ path }) => path), ...Object.values(startup.audio),
    'media/scripts/generated/items/clothing.txt', 'media/scripts/generated/items/container.txt',
]);

/**
 * Match startup roles against actual inventory spelling, rejecting case collisions.
 *
 * @param {{path:string}[]} files - Approved source or copied inventory.
 * @returns {Map<string,string>} Expected role paths mapped to original paths.
 */
function matchStartupPaths(files) {
    const byCase = new Map([...startupPaths].map((path) => [path.toLowerCase(), []]));

    for (const { path } of files) {
        byCase.get(path.toLowerCase())?.push(path);
    }

    const matched = new Map();

    for (const expected of startupPaths) {
        const candidates = byCase.get(expected.toLowerCase()) ?? [];

        if (candidates.length > 1) {
            throw new Error(`Ambiguous startup content for ${expected}: ${candidates.join(', ')}`);
        }

        if (candidates.length === 1) {
            matched.set(expected, candidates[0]);
        }
    }

    return matched;
}

/**
 * Reject any linked ancestor before reading or writing a directory.
 *
 * @param {string} path - Absolute path to inspect.
 * @returns {Promise<void>} Resolves when existing ancestors are real directories.
 */
async function noLinkedAncestors(path) {
    let current = parse(path).root;

    for (const part of relative(current, path).split(sep).filter(Boolean)) {
        current = join(current, part);
        let info;

        try {
            // eslint-disable-next-line no-await-in-loop -- Ancestors must be checked before descendants.
            info = await lstat(current);
        } catch (error) {
            if (error.code === 'ENOENT') {
                return;
            }

            throw error;
        }

        if (info.isSymbolicLink() || !info.isDirectory()) {
            throw new Error(`Refusing linked or non-directory ancestor: ${current}`);
        }
    }
}

/**
 * Enumerate a real tree without following links or loading asset bytes.
 *
 * @param {string} root - Absolute approved tree root.
 * @param {string} prefix - Content manifest prefix.
 * @returns {Promise<{path: string, full: string}[]>} Allowed regular files.
 */
async function inventory(root, prefix) {
    await noLinkedAncestors(root);
    let entries;

    try {
        entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
        if (error.code === 'ENOENT') {
            return [];
        }

        throw error;
    }

    const files = [];

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
        const path = `${prefix}/${entry.name}`;
        const full = join(root, entry.name);

        if (entry.isSymbolicLink()) {
            throw new Error(`Refusing link in content tree: ${full}`);
        }

        if (entry.isDirectory()) {
            // eslint-disable-next-line no-await-in-loop -- Bound memory and do not copy until the tree is approved.
            files.push(...await inventory(full, path));
        } else if (entry.isFile() && isContentPath(path)) {
            files.push({ path, full });
        }
    }

    return files;
}

/**
 * Include an optional plain-text root Lua standard library, never binary .lbc.
 *
 * @param {string} root - Installation or copied content directory.
 * @returns {Promise<{path: string, full: string}[]>} Optional source file entry.
 */
async function standardLibrary(root) {
    const full = join(root, 'stdlib.lua');
    let info;

    try {
        info = await lstat(full);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return [];
        }

        throw error;
    }

    if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(`Refusing linked or non-regular stdlib.lua: ${full}`);
    }

    return [{ path: 'stdlib.lua', full }];
}

/**
 * Group native Build 42 common/version roots and discover browser mod packages.
 *
 * @param {{path:string}[]} files - Copied inventory.
 * @returns {{root:string, kind:string, files:string[]}[]} Mod package descriptors.
 */
function discoverMods(files) {
    const roots = new Map();

    for (const { path } of files) {
        if (!path.startsWith('mods/') || !/(?:^|\/)(?:mod\.json|mod\.info)$/u.test(path)) {
            continue;
        }

        const javascript = path.endsWith('/mod.json');
        let root = path.slice(0, path.lastIndexOf('/'));

        if (!javascript) {
            root = root.replace(/\/(?:common|\d+(?:\.\d+)*)$/u, '');
        }

        if (!roots.has(root) || javascript) {
            roots.set(root, javascript ? 'javascript' : 'native-lua');
        }
    }

    return [...roots].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([root, kind]) => ({
        root, kind, files: files.filter(({ path }) => path.startsWith(`${root}/`)).map(({ path }) => path),
    }));
}

/**
 * Stage new assets outside indexed trees, then publish complete copies without overwriting.
 *
 * @param {{path:string,full:string}[]} files - Source inventory.
 * @param {string} output - Separate destination directory.
 * @returns {Promise<void>} Resolves after conservative copying.
 */
async function copyAbsent(files, output) {
    let temporary;

    try {
        for (const file of files) {
            const destination = join(output, file.path);

            // eslint-disable-next-line no-await-in-loop -- Copy one asset at a time, never buffer a whole bank.
            await noLinkedAncestors(dirname(destination));
            // eslint-disable-next-line no-await-in-loop -- Ancestors have been approved.
            await mkdir(dirname(destination), { recursive: true });

            try {
                // eslint-disable-next-line no-await-in-loop -- Reruns preserve existing bytes without recopying assets.
                const info = await lstat(destination);

                if (info.isSymbolicLink() || !info.isFile()) {
                    throw new Error(`Refusing linked or non-regular destination: ${destination}`);
                }

                continue;
            } catch (error) {
                if (error.code !== 'ENOENT') {
                    throw error;
                }
            }

            if (!temporary) {
                // Root staging is never inventoried; hard-aborted leftovers are safely ignored on rerun.
                // eslint-disable-next-line no-await-in-loop -- Own a unique staging directory on the output filesystem.
                temporary = await mkdtemp(join(output, '.copy-'));
            }

            const staged = join(temporary, randomUUID());

            // eslint-disable-next-line no-await-in-loop -- Copy only into our owned unpublished file, never link the original.
            await copyFile(file.full, staged, constants.COPYFILE_EXCL);

            try {
                // eslint-disable-next-line no-await-in-loop -- A hard link publishes complete bytes atomically without replacement.
                await link(staged, destination);
            } catch (error) {
                if (error.code !== 'EEXIST') {
                    throw new Error(`Cannot publish content atomically; output filesystem must support hard links (${error.code}): ${destination}`, { cause: error });
                }

                // eslint-disable-next-line no-await-in-loop -- A competing destination must still be regular, never a link.
                const info = await lstat(destination);

                if (info.isSymbolicLink() || !info.isFile()) {
                    throw new Error(`Refusing linked or non-regular destination: ${destination}`);
                }
            }

            // eslint-disable-next-line no-await-in-loop -- Keep only one pending asset on disk.
            await rm(staged);
        }
    } finally {
        if (temporary) {
            await rm(temporary, { recursive: true, force: true });
        }
    }
}

/**
 * Produce file metadata without whole-file asset reads; optional hashes stream.
 *
 * @param {{path:string,full:string}} file - Approved inventory entry.
 * @param {boolean} hash - Whether to stream SHA-256.
 * @returns {Promise<object>} Portable metadata with no original absolute path.
 */
async function metadata(file, hash) {
    const info = await stat(file.full);
    const record = { path: file.path, size: info.size, lastModified: Math.trunc(info.mtimeMs) };

    if (!Number.isSafeInteger(record.size) || record.size < 0
        || !Number.isSafeInteger(record.lastModified) || record.lastModified < 0) {
        throw new Error(`Unsupported file size or timestamp: ${file.path}`);
    }

    if (hash) {
        const digest = createHash('sha256');

        for await (const chunk of createReadStream(file.full)) {
            digest.update(chunk);
        }

        record.sha256 = digest.digest('hex');
    }

    return record;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const { values } = parseArgs({
            options: {
                source: { type: 'string' }, output: { type: 'string' }, 'mods-source': { type: 'string' },
                'index-only': { type: 'boolean' }, 'startup-only': { type: 'boolean' }, hash: { type: 'boolean' },
                'source-build': { type: 'string' }, help: { type: 'boolean' },
            },
        });

        if (values.help) {
            console.info('node scripts/provision-content.mjs [--source INSTALL] [--output content] [--mods-source USER_MODS] [--startup-only] [--hash] [--source-build OBSERVED_VERSION]\nnode scripts/provision-content.mjs --index-only [--output content] [--hash]');
        } else {
            const manifest = await provisionContent({ source: values.source, output: values.output, modsSource: values['mods-source'], indexOnly: values['index-only'], startupOnly: values['startup-only'], hash: values.hash, sourceBuild: values['source-build'] });

            console.info(`Indexed ${manifest.files.length} approved content files in ${resolve(values.output ?? 'content')}; original installation unchanged.`);
        }
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

/**
 * Allow data and mod source only, never executables, bytecode, saves or arbitrary root files.
 *
 * @param {string} path - Content-root relative path.
 * @returns {boolean} Whether the path is approved content.
 */
export function isContentPath(path) {
    for (let index = 0; index < path.length; index++) {
        const code = path.codePointAt(index);

        if (code <= 0x1F || code === 0x7F) {
            return false;
        }
    }

    const parts = path.split('/');

    if (parts.some((part) => !part || part === '.' || part === '..' || /[:%?#\\]/u.test(part))
        || parts.some((part) => /^(?:saves?|logs?|private|\.git)$/iu.test(part))) {
        return false;
    }

    return path === 'stdlib.lua' || (['media', 'mods'].includes(parts[0]) && extensions.has(extname(path).toLowerCase()));
}

/**
 * Provision or index separate private content. Never mutate the original installation.
 *
 * @param {object} options - CLI-equivalent directory options.
 * @param {string} [options.source] - Installation directory containing media/.
 * @param {string} [options.output] - Separate content directory.
 * @param {string} [options.modsSource] - Optional separately chosen user mod directory.
 * @param {boolean} [options.indexOnly] - Index existing copied content without copying.
 * @param {boolean} [options.startupOnly] - Copy only bounded startup assets (and optional stdlib).
 * @param {boolean} [options.hash] - Stream hashes instead of stat-only indexing.
 * @param {string} [options.sourceBuild] - Explicit observed version label, otherwise unknown.
 * @returns {Promise<object>} Manifest written into the content root.
 */
export async function provisionContent(options = {}) {
    const output = resolve(options.output ?? 'content');
    const source = resolve(options.source ?? 'C:/Games/steam/steamapps/common/ProjectZomboid');
    const modsSource = options.modsSource ? resolve(options.modsSource) : undefined;
    const outputKey = process.platform === 'win32' ? output.toLowerCase() : output;
    const checkout = resolve('.');
    const checkoutKey = process.platform === 'win32' ? checkout.toLowerCase() : checkout;

    if (outputKey === parse(outputKey).root || outputKey === checkoutKey || checkoutKey.startsWith(outputKey + sep)
        || ['dist', 'release'].some((directory) => {
            const root = join(checkoutKey, directory);

            return outputKey === root || outputKey.startsWith(root + sep);
        })) {
        throw new Error('Output must be separate from the application checkout, dist and release roots');
    }

    if (options.indexOnly && (options.source || modsSource || options.startupOnly)) {
        throw new Error('--index-only cannot be combined with copying options');
    }

    for (const input of options.indexOnly ? [] : [source, modsSource].filter(Boolean)) {
        const inputKey = process.platform === 'win32' ? input.toLowerCase() : input;

        if (inputKey === outputKey || inputKey.startsWith(outputKey + sep) || outputKey.startsWith(inputKey + sep)) {
            throw new Error('Source and output directories must not overlap');
        }

        // eslint-disable-next-line no-await-in-loop -- Approve all roots before writing.
        await noLinkedAncestors(input);
    }

    await noLinkedAncestors(output);
    const manifestPath = join(output, 'manifest.json');

    try {
        const info = await lstat(manifestPath);

        if (!info.isFile() || info.isSymbolicLink()) {
            throw new Error('Refusing non-regular manifest.json');
        }

        const previous = JSON.parse(await readFile(manifestPath, 'utf8'));

        if (previous.format !== 'pz-web-content-directory' || previous.formatVersion !== 1) {
            throw new Error('Refusing to replace unrelated manifest.json');
        }
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
    }

    // Approve existing copied trees before any writes, including on restart.
    await inventory(join(output, 'media'), 'media');
    await inventory(join(output, 'mods'), 'mods');
    await standardLibrary(output);

    if (!options.indexOnly) {
        let files = [...await inventory(join(source, 'media'), 'media'), ...await standardLibrary(source)];
        const sourceMatches = matchStartupPaths(files);

        if (options.startupOnly) {
            const selected = new Set(sourceMatches.values());

            files = files.filter(({ path }) => selected.has(path) || path === 'stdlib.lua');
        }

        if (modsSource) {
            files.push(...await inventory(modsSource, 'mods'));
        }

        await copyAbsent(files, output);
    }

    const copied = [...await inventory(join(output, 'media'), 'media'), ...await inventory(join(output, 'mods'), 'mods'), ...await standardLibrary(output)]
        .sort((a, b) => a.path.localeCompare(b.path, 'en'));
    const matched = matchStartupPaths(copied);
    const missing = [...startupPaths].filter((path) => !matched.has(path));

    if (missing.length) {
        throw new Error(`Startup content missing: ${missing.join(', ')}`);
    }

    const resolvedStartup = {
        ...startup,
        packs: startup.packs.map((path) => matched.get(path)),
        cells: startup.cells.map((cell) => ({
            ...cell, navigation: matched.get(cell.navigation), header: matched.get(cell.header), lotpack: matched.get(cell.lotpack),
        })),
        character: Object.fromEntries(Object.entries(startup.character).map(([role, path]) => [role, matched.get(path)])),
        tileDefinitions: startup.tileDefinitions.map(({ path, fileId }) => ({ path: matched.get(path), fileId })),
        audio: Object.fromEntries(Object.entries(startup.audio).map(([role, path]) => [role, matched.get(path)])),
    };
    const files = [];

    for (const file of copied) {
        // eslint-disable-next-line no-await-in-loop -- Stat/hash one file at a time; bank bytes never accumulate.
        files.push(await metadata(file, options.hash === true));
    }

    const manifest = {
        format: 'pz-web-content-directory', formatVersion: 1,
        sourceBuild: { version: options.sourceBuild ?? 'unknown' }, files, startup: resolvedStartup, mods: discoverMods(files),
    };

    await mkdir(output, { recursive: true });
    const temporary = join(output, `.manifest-${randomUUID()}.tmp`);

    try {
        await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
        await rename(temporary, manifestPath);
    } finally {
        await rm(temporary, { force: true });
    }

    return manifest;
}
