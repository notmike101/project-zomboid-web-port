import { spawnSync } from 'node:child_process';
import { copyFile, lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * One approved delivery file, both paths relative to the checkout root.
 *
 * @typedef {{ source: string, target: string }} DeliveryFile
 */

/**
 * Every file the browser application ships; no directory is ever swept in.
 *
 * @type {DeliveryFile[]}
 */
const applicationFiles = [
    { source: 'index.html', target: 'dist/index.html' },
    { source: 'src/engine.js', target: 'dist/src/engine.js' },
    { source: 'src/main.js', target: 'dist/src/main.js' },
    { source: 'src/mods.js', target: 'dist/src/mods.js' },
    { source: 'src/mod-manager.js', target: 'dist/src/mod-manager.js' },
    { source: 'mod-worker.js', target: 'dist/mod-worker.js' },
    { source: 'src/saves.js', target: 'dist/src/saves.js' },
    { source: 'src/world-session.js', target: 'dist/src/world-session.js' },
    { source: 'src/content.js', target: 'dist/src/content.js' },
    { source: 'src/lua-runtime.js', target: 'dist/src/lua-runtime.js' },
    { source: 'src/lua-requires.js', target: 'dist/src/lua-requires.js' },
    { source: 'src/native-mod-loader.js', target: 'dist/src/native-mod-loader.js' },
    { source: 'src/native-game-resources.js', target: 'dist/src/native-game-resources.js' },
    { source: 'src/item-definitions.js', target: 'dist/src/item-definitions.js' },
    { source: 'src/fbx.js', target: 'dist/src/fbx.js' },
    { source: 'src/game-ui.js', target: 'dist/src/game-ui.js' },
    { source: 'node_modules/wasmoon/dist/index.js', target: 'dist/runtime/wasmoon.js' },
    { source: 'node_modules/wasmoon/dist/glue.wasm', target: 'dist/runtime/glue.wasm' },
    { source: 'node_modules/wasmoon/LICENSE', target: 'dist/licenses/wasmoon.txt' },
    { source: 'vendor/lua-5.4.5-LICENSE.txt', target: 'dist/licenses/lua.txt' },
    { source: 'src/packs.js', target: 'dist/src/packs.js' },
    { source: 'src/models.js', target: 'dist/src/models.js' },
    { source: 'src/map-tiles.js', target: 'dist/src/map-tiles.js' },
    { source: 'src/tile-renderer.js', target: 'dist/src/tile-renderer.js' },
    { source: 'src/renderer.js', target: 'dist/src/renderer.js' },
    { source: 'src/style.css', target: 'dist/src/style.css' },
    { source: 'mods/accessible-walking/main.js', target: 'dist/mods/accessible-walking/main.js' },
    { source: 'mods/accessible-walking/settings.js', target: 'dist/mods/accessible-walking/settings.js' },
    { source: 'engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', target: 'dist/engine/pz_engine.wasm' },
];

/**
 * Generated metadata shipped beside the staged application.
 *
 * @type {{ version: string, engineApi: number, modApi: string, assetFree: boolean }}
 */
const buildMetadata = { version: '0.1.0-preview.1', engineApi: 1, modApi: '0.1.0', assetFree: true };

/**
 * Test one resolved path for containment inside one resolved directory.
 *
 * @param {string} directory - Resolved root directory.
 * @param {string} path - Resolved path to test.
 * @returns {boolean} True when the path is that directory or below it.
 */
function contains(directory, path) {
    return path === directory || path.startsWith(directory + sep);
}

/**
 * Copy one approved delivery file, refusing links and ancestors that leave the root.
 *
 * @param {string} root - Checkout root the source has to stay inside.
 * @param {DeliveryFile} file - Approved source and target pair.
 * @returns {Promise<void>} Resolves once the verified bytes are staged.
 * @throws {Error} When the source is not a regular file inside the resolved root.
 */
async function copyApproved(root, file) {
    const source = join(root, file.source);
    const realRoot = await realpath(root);
    const info = await lstat(source);

    if (!info.isFile()) {
        throw new Error(`Build refuses a non-regular source: ${file.source}`);
    }

    const realSource = await realpath(source);

    if (!contains(realRoot, realSource)) {
        throw new Error(`Build refuses a source resolving outside the checkout: ${file.source}`);
    }

    const target = join(root, file.target);

    await mkdir(dirname(target), { recursive: true });
    await copyFile(realSource, target);
}

/**
 * Stage exactly the approved application files and generated metadata under `root`/dist.
 *
 * @param {string} root - Checkout or fixture root to read from and to write dist into.
 * @returns {Promise<void>} Resolves once the asset-free tree is complete.
 * @throws {Error} When any approved source is not a real file inside the root.
 */
async function stageApplication(root) {
    await rm(join(root, 'dist'), { recursive: true, force: true });
    const staged = await Promise.all(applicationFiles.map((file) => copyApproved(root, file).then(() => undefined, (cause) => cause)));
    const failure = staged.find((result) => result !== undefined);

    if (failure !== undefined) {
        throw failure;
    }

    await writeFile(join(root, 'dist', 'build.json'), JSON.stringify(buildMetadata, null, 2));
}

/**
 * Compile the pinned WASM engine, then stage the approved delivery files.
 *
 * @returns {Promise<void>} Completes once the browser application is built.
 */
async function buildApplication() {
    const result = spawnSync('cargo', ['build', '--manifest-path', 'engine/Cargo.toml', '--locked', '--release', '--target', 'wasm32-unknown-unknown'], { stdio: 'inherit' });

    if (result.status !== 0) {
        throw new Error('WASM build failed; install the pinned Rust toolchain and wasm32 target.');
    }

    await stageApplication(process.cwd());
    console.info('Built asset-free browser application in dist/');
}

/**
 * Report whether this module is the process entry point.
 *
 * @returns {Promise<boolean>} True when started as `node scripts/build.mjs`.
 */
async function isEntryPoint() {
    if (process.argv[1] === undefined) {
        return false;
    }

    return pathToFileURL(await realpath(process.argv[1])).href === import.meta.url;
}

if (await isEntryPoint()) {
    await buildApplication();
}

export { applicationFiles, stageApplication };
