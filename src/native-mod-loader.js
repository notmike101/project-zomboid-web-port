/** @file Native mod.info discovery and original-Lua adapters for the existing package manager. */
import { literalLuaRequires } from './lua-requires.js';
import { createLuaSession } from './lua-runtime.js';
import { MAX_FILES, MAX_FILE_BYTES, MAX_MANIFEST_BYTES, MAX_PACKAGE_BYTES } from './mod-manager.js';

const LUA_PATH = /^media\/lua\/(shared|client|server)\/.+\.lua$/u;
const TREE = /^\d+(?:\.\d+)*$/u;
let liveSession;
let liveDescriptors = new Map();

/**
 * Compare numeric build components without decimal-number rounding.
 *
 * @param {string} left - Build/version directory.
 * @param {string} right - Source build.
 * @returns {number} Ordering.
 */
function compareBuild(left, right) {
    const a = left.split('.').map(BigInt);
    const b = right.split('.').map(BigInt);

    for (let index = 0; index < Math.max(a.length, b.length); index++) {
        const difference = (a[index] ?? 0n) - (b[index] ?? 0n);

        if (difference) {
            return difference < 0n ? -1 : 1;
        }
    }

    return 0;
}

/**
 * Parse metadata only, never execute source during discovery.
 *
 * @param {string} text - Original mod.info text.
 * @returns {object} Native fields.
 */
function parseModInfo(text) {
    const fields = Object.create(null);

    for (const line of text.replace(/^\uFEFF/u, '').split(/\r?\n/u)) {
        const match = /^\s*([\w]+)\s*=\s*(.*?)\s*$/u.exec(line);

        if (match) {
            fields[match[1].toLowerCase()] = match[2];
        }
    }

    const lists = {};

    for (const key of ['require', 'loadafter', 'loadbefore']) {
        lists[key] = [...new Set((fields[key] ?? '').split(',').map((item) => item.trim()).filter(Boolean))];
    }

    return {
        id: fields.id, name: fields.name, version: fields.modversion ?? fields.version,
        versionMin: fields.versionmin, require: lists.require, loadAfter: lists.loadafter, loadBefore: lists.loadbefore,
    };
}

/**
 * Canonical SDK identity; exact case-sensitive native identity remains separate.
 *
 * @param {string} nativeId - Original mod.info id.
 * @returns {string} SDK-safe identity.
 */
function sdkId(nativeId) {
    const id = `native-${nativeId.toLowerCase().replaceAll(/[^\d._a-z-]/gu, '-')}`;

    if (!nativeId || id.length > 64) {
        throw new Error(`Native identity '${nativeId}' cannot fit the SDK id grammar`);
    }

    return id;
}

/**
 * Select common plus the highest compatible numeric overlay, or root-only files.
 *
 * @param {object} entry - Indexed package.
 * @param {string} build - Known source build, or unknown.
 * @returns {object} Selection and metadata candidates, without reading code.
 */
function selectNativeTree(entry, build) {
    const relative = entry.files.map((path) => ({ path, local: path.slice(entry.root.length + 1) }));
    const trees = [...new Set(relative.map(({ local }) => local.split('/')[0]).filter((part) => TREE.test(part)))].sort((left, right) => compareBuild(left, right) || Number(left > right) - Number(left < right));
    const known = typeof build === 'string' && TREE.test(build);
    const compatible = known ? trees.filter((tree) => compareBuild(tree, build) <= 0) : [];
    const selected = compatible.at(-1);
    const layered = trees.length > 0 || relative.some(({ local }) => local.startsWith('common/'));
    const selectedFiles = new Map();

    for (const prefix of layered ? ['common/', ...(selected ? [`${selected}/`] : [])] : ['']) {
        for (const item of relative) {
            if (item.local.startsWith(prefix)) {
                const local = item.local.slice(prefix.length);

                selectedFiles.set(local, { path: item.path, local });
            }
        }
    }

    // Metadata may live in an older compatible tree even when the latest code tree has no mod.info.
    const metadataTrees = compatible.length ? compatible.slice().reverse() : trees;
    const metadata = [...(selected ? [`${selected}/mod.info`] : []), ...metadataTrees.map((tree) => `${tree}/mod.info`), 'common/mod.info', 'mod.info'];
    let blocked;

    if (!known) {
        blocked = 'Native activation requires a known manifest sourceBuild.version; provision with --source-build matching the installed game.';
    } else if (layered && trees.length > 0 && !selected) {
        blocked = `No native code tree is compatible with sourceBuild ${build}`;
    }

    return {
        tree: layered ? selected ?? 'common' : 'root', files: [...selectedFiles.values()],
        metadata: [...new Set(metadata)].map((local) => relative.find((item) => item.local === local)).filter(Boolean),
        blocked,
    };
}

/**
 * Read text within the same file/package limits as SDK packages.
 *
 * @param {object} content - Private content directory.
 * @param {string} path - Manifest path.
 * @param {number} limit - Per-file bound.
 * @returns {Promise<string>} Original text.
 */
async function readText(content, path, limit = MAX_FILE_BYTES) {
    const file = content.getFile(path);

    if (file.size > limit) {
        throw new Error(`Native file ${path} exceeds the ${limit}-byte limit`);
    }

    const text = await file.text();

    if (new TextEncoder().encode(text).length > limit) {
        throw new Error(`Native file ${path} read beyond its ${limit}-byte limit`);
    }

    return text;
}

/**
 * Stage native metadata and unchanged selected Lua, without creating a VM.
 *
 * @param {object} content - Private content directory.
 * @param {string[]} [otherIds] - SDK ids claimed by JavaScript packages.
 * @param {object[]} [installedNative] - Stored native exact identities and SDK versions.
 * @returns {Promise<object[]>} Descriptors ready for disabled installation.
 */
async function discoverNativePackages(content, otherIds = [], installedNative = []) {
    const result = [];
    const identities = new Set();
    const ids = new Set(otherIds);
    const build = content.manifest.sourceBuild.version;

    for (const entry of content.manifest.mods.filter((item) => item.kind === 'native-lua')) {
        if (entry.files.length > MAX_FILES) {
            throw new Error(`Native package ${entry.root} exceeds the ${MAX_FILES}-file limit`);
        }

        let total = 0;

        for (const path of entry.files) {
            const size = content.getFile(path).size;

            if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) {
                throw new Error(`Native file ${path} has an invalid or oversized length`);
            }

            total += size;
        }

        if (total > MAX_PACKAGE_BYTES) {
            throw new Error(`Native package ${entry.root} exceeds the ${MAX_PACKAGE_BYTES}-byte limit`);
        }

        const selection = selectNativeTree(entry, build);

        if (!selection.metadata.length) {
            throw new Error(`Native package ${entry.root} has no compatible mod.info identity`);
        }

        const metadata = [];

        for (const item of selection.metadata) {
            // eslint-disable-next-line no-await-in-loop
            metadata.push(parseModInfo(await readText(content, item.path, MAX_MANIFEST_BYTES)));
        }

        const info = metadata[0];

        if (!info.id || metadata.some((item) => item.id !== info.id) || identities.has(info.id)) {
            throw new Error(`Native identity collision or inconsistent mod.info identity in ${entry.root}: ${info.id}`);
        }

        const id = sdkId(info.id);

        if (ids.has(id)) {
            throw new Error(`Native SDK id collision: ${info.id} maps to ${id}`);
        }

        identities.add(info.id);
        ids.add(id);
        const nativeVersion = info.version ?? null;

        if (nativeVersion !== null && (nativeVersion.length > 256 || !nativeVersion.length)) {
            throw new Error(`Native version for ${info.id} is empty or exceeds 256 characters`);
        }

        // Reserve 00.0.* for lossless non-SDK version identities; valid ordinary dotted versions stay unchanged.
        const ordinaryVersion = nativeVersion !== null && /^\d+\.\d+\.\d+$/u.test(nativeVersion) && !nativeVersion.startsWith('00.0.');
        const hex = nativeVersion === null || ordinaryVersion ? '' : [...new TextEncoder().encode(nativeVersion)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
        let version = '00.0.0';

        if (ordinaryVersion) {
            version = nativeVersion;
        } else if (nativeVersion !== null) {
            version = `00.0.${BigInt(`0x1${hex}`)}`;
        }

        let blocked = selection.blocked;

        if (info.versionMin && (!TREE.test(info.versionMin) || (TREE.test(build ?? '') && compareBuild(info.versionMin, build) > 0))) {
            blocked = `${info.id} requires game versionMin ${info.versionMin}; sourceBuild is ${build}`;
        }

        const sources = [];

        if (!blocked) {
            for (const item of selection.files.filter((file) => LUA_PATH.test(file.local))) {
                // eslint-disable-next-line no-await-in-loop
                sources.push({ path: item.local, source: await readText(content, item.path) });
            }
        }

        result.push({
            id, nativeId: info.id, nativeVersion, root: entry.root, tree: selection.tree, blocked, sources,
            sourceBuild: build, versionMin: info.versionMin ?? null,
            fileCount: entry.files.length, nativeRequire: info.require, nativeLoadAfter: info.loadAfter, nativeLoadBefore: info.loadBefore,
            manifest: { id, version, apiVersion: '0.1.0', name: info.name || info.id, entry: 'entry.js', dependencies: {}, optionalDependencies: {}, conflicts: [], loadAfter: [], loadBefore: [], settings: { nativeLua: true, nativeId: info.id, nativeVersion } },
        });
    }

    const native = new Map();

    for (const entry of installedNative) {
        if (sdkId(entry.nativeId) !== entry.id || native.has(entry.nativeId)) {
            throw new Error(`Stored native identity collision: ${entry.nativeId}`);
        }

        native.set(entry.nativeId, entry);
    }

    for (const entry of result) {
        const previous = installedNative.find((stored) => stored.id === entry.id);

        if (previous && previous.nativeId !== entry.nativeId) {
            throw new Error(`Native SDK id collision: stored ${previous.nativeId} and discovered ${entry.nativeId}`);
        }

        native.set(entry.nativeId, entry);
    }

    for (const entry of result) {
        for (const dependency of entry.nativeRequire) {
            const target = native.get(dependency);

            // An absent exact native id must not accidentally resolve to a differently-cased SDK id.
            entry.manifest.dependencies[target?.id ?? sdkId(dependency)] = target?.manifest.version ?? '00.0.1';
        }

        entry.manifest.loadAfter = entry.nativeLoadAfter.map((id) => native.get(id)?.id).filter(Boolean);
        entry.manifest.loadBefore = entry.nativeLoadBefore.map((id) => native.get(id)?.id).filter(Boolean);
    }

    return result;
}

/**
 * Build a tiny private SDK adapter; unchanged Lua remains data in native.json.
 *
 * @param {object} descriptor - Staged native package.
 * @returns {File[]} Manager-compatible files.
 */
function nativePackageFiles(descriptor) {
    const entry = `import { activateNativePackage } from ${JSON.stringify(new URL('./native-mod-loader.js', import.meta.url).href)};\nexport const manifest = ${JSON.stringify(descriptor.manifest)};\nexport function activate(api) { return activateNativePackage(${JSON.stringify(descriptor.id)}, api); }\n`;

    return Object.entries({ 'mod.json': JSON.stringify(descriptor.manifest), 'entry.js': entry, 'native.json': JSON.stringify(descriptor) }).map(([path, text]) => {
        const file = new File([text], path);

        Object.defineProperty(file, 'webkitRelativePath', { value: path });

        return file;
    });
}

/**
 * Fetch the literal require graph reachable from native packages and ordered engine startup seeds.
 *
 * @param {object[]} descriptors - Selected enabled packages.
 * @param {object} content - Private directory.
 * @param {{path:string,source:string,execute?:boolean}[]} [additionalSources] - Original startup text; execute defaults true.
 * @returns {Promise<object[]>} Startup seeds followed by require-only dependencies, installed once by module name.
 */
async function engineSources(descriptors, content, additionalSources = []) {
    const ownModules = new Set(descriptors.flatMap((entry) => entry.sources.map((item) => item.path.replace(/^media\/lua\/(shared|client|server)\//u, '').replace(/\.lua$/u, ''))));
    const available = new Map();

    for (const { path } of content.manifest.files.filter((item) => LUA_PATH.test(item.path))) {
        const name = path.replace(/^media\/lua\/(shared|client|server)\//u, '').replace(/\.lua$/u, '');
        const paths = available.get(name) ?? [];

        paths.push(path);
        available.set(name, paths);
    }

    const sources = [];
    const visited = new Set(ownModules);
    const queue = descriptors.flatMap((entry) => entry.sources.map((item) => item.source));
    const supplied = new Map();
    let bytes = 0;

    if (!Array.isArray(additionalSources)) {
        throw new TypeError('Engine startup sources must be an array');
    }

    for (const item of additionalSources) {
        if (!item || typeof item.path !== 'string' || !LUA_PATH.test(item.path) || item.path.includes('\\') || item.path.split('/').some((part) => part === '.' || part === '..') || typeof item.source !== 'string' || item.source.charCodeAt(0) === 27 || item.source.includes('\0') || (item.execute !== undefined && typeof item.execute !== 'boolean')) {
            throw new TypeError('Engine startup sources require original media/lua paths and Lua text');
        }

        const name = item.path.replace(/^media\/lua\/(shared|client|server)\//u, '').replace(/\.lua$/u, '');
        const previous = supplied.get(name);

        if (ownModules.has(name) || (previous && previous.path !== item.path)) {
            throw new Error(`Ambiguous engine Lua startup module name: ${name}`);
        }

        if (previous) {
            if (previous.source !== item.source) {
                throw new Error(`Engine Lua startup source changed within the graph: ${item.path}`);
            }

            previous.execute ||= item.execute !== false;
            continue;
        }

        const size = new TextEncoder().encode(item.source).length;

        bytes += size;

        if (size > MAX_FILE_BYTES || bytes > MAX_PACKAGE_BYTES || sources.length >= MAX_FILES) {
            throw new Error('Required engine Lua graph exceeds native package resource limits');
        }

        const source = { path: item.path, source: item.source, execute: item.execute !== false };

        supplied.set(name, source);
        visited.add(name);
        sources.push(source);
        queue.push(item.source);
    }

    for (let index = 0; index < queue.length; index++) {
        // ponytail: literal require graph only; dynamic engine module names fail truthfully until async VM require/resume exists.
        for (const moduleName of literalLuaRequires(queue[index])) {
            const name = moduleName.replaceAll('\\', '/').replace(/\.lua$/u, '');

            if (visited.has(name)) {
                continue;
            }

            visited.add(name);
            const paths = available.get(name);

            if (paths?.length > 1) {
                throw new Error(`Ambiguous engine Lua require name: ${name}`);
            }

            const path = paths?.[0];

            if (path) {
                // eslint-disable-next-line no-await-in-loop
                const source = await readText(content, path);

                bytes += new TextEncoder().encode(source).length;

                if (bytes > MAX_PACKAGE_BYTES || sources.length >= MAX_FILES) {
                    throw new Error('Required engine Lua graph exceeds native package resource limits');
                }

                sources.push({ path, source, execute: false });
                queue.push(source);
            }
        }
    }

    return sources;
}

/**
 * Prepare a fresh VM and all cross-package require ownership before any activation.
 *
 * @param {object[]} descriptors - Enabled or previously running native packages.
 * @param {object} content - Private directory.
 * @param {{staged?:boolean,ui?:object,moodleTypes?:{[name:string]:string},engineSources?:{path:string,source:string,execute?:boolean}[]}} [options] - Candidate resources and ordered original startup seeds; execute defaults true.
 * @returns {Promise<object|undefined>} New VM, or no VM when no native code is enabled.
 */
async function prepareNativeSession(descriptors, content, options = {}) {
    if (liveSession && !options.staged) {
        throw new Error('Close the prior native VM before preparing a session');
    }

    if (!descriptors.length) {
        bindNativeSession(undefined, []);

        return undefined;
    }

    const build = content.manifest.sourceBuild.version;

    if (typeof build !== 'string' || !TREE.test(build)) {
        throw new Error('Native activation requires a known current manifest sourceBuild.version.');
    }

    const nativeIds = new Set(descriptors.map((entry) => entry.nativeId));

    for (const entry of descriptors) {
        if (entry.sourceBuild !== build) {
            throw new Error(`${entry.nativeId}: cached sources selected for sourceBuild ${entry.sourceBuild}; current sourceBuild is ${build}. Rediscover matching original sources before activation.`);
        }

        if (entry.versionMin && (!TREE.test(entry.versionMin) || compareBuild(entry.versionMin, build) > 0)) {
            throw new Error(`${entry.nativeId} requires game versionMin ${entry.versionMin}; sourceBuild is ${build}`);
        }

        if (TREE.test(entry.tree) && compareBuild(entry.tree, build) > 0) {
            throw new Error(`${entry.nativeId}: selected code tree ${entry.tree} is newer than sourceBuild ${build}`);
        }

        if (entry.blocked) {
            throw new Error(`${entry.nativeId}: ${entry.blocked}`);
        }

        for (const dependency of entry.nativeRequire) {
            if (!nativeIds.has(dependency)) {
                throw new Error(`${entry.nativeId}: required exact native dependency '${dependency}' is not enabled`);
            }
        }
    }

    const sources = await engineSources(descriptors, content, options.engineSources);
    const session = await createLuaSession({
        ui: options.ui,
        moodleTypes: options.moodleTypes,
        engineStartup: sources.filter((item) => item.execute !== false).map(({ path }) => ({ id: 'engine-lua', path })),
    });

    try {
        if (sources.length) {
            session.preload({ id: 'engine-lua', nativeId: 'ProjectZomboid', engineSource: true, sources });
        }

        for (const entry of descriptors) {
            session.preload(entry);
        }
    } catch (cause) {
        session.close({ discardSaveData: true });
        throw cause;
    }

    bindNativeSession(session, descriptors);

    return session;
}

/**
 * Route adapters to a candidate or retained committed VM without changing either VM's hooks.
 *
 * @param {object|undefined} session - Already-owned VM, or no native VM.
 * @param {object[]} descriptors - Its exact preloaded native packages.
 * @returns {void} Changes only adapter activation routing.
 */
function bindNativeSession(session, descriptors) {
    liveSession = session;
    liveDescriptors = new Map(descriptors.map((entry) => [entry.id, entry]));
}

/**
 * Route the persisted adapter into the current VM, without global aliases.
 *
 * @param {string} id - Installed SDK identity.
 * @param {object} api - Host-bound public namespace.
 * @returns {()=>void} VM package cleanup.
 */
function activateNativePackage(id, api) {
    const descriptor = liveDescriptors.get(id);

    if (!liveSession || !descriptor) {
        throw new Error(`Native package ${id} was not prepared for this session`);
    }

    return liveSession.activatePackage({ ...descriptor, api });
}

/**
 * Flush while old namespace APIs are valid, then close before host disposal/rebinding.
 *
 * @param {{discardSaveData?:boolean}} [options] - Discard only failed, uncommitted target state.
 * @returns {void} Frees the prior VM and callbacks.
 */
function closeNativeSession(options = {}) {
    liveSession?.close(options);
    liveSession = undefined;
    liveDescriptors = new Map();
}

export { parseModInfo, selectNativeTree, discoverNativePackages, nativePackageFiles, engineSources, prepareNativeSession, activateNativePackage, closeNativeSession, bindNativeSession };
