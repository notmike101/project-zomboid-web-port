import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, stat, realpath, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const source = fileURLToPath(new URL('./', import.meta.url));
const repository = path.resolve(source, '..');
const names = new Set(['game-jar', 'media-root', 'jdk', 'browser', 'profile']);
const options = {};

for (let i = 2; i < process.argv.length; i += 2) {
    const name = process.argv[i]?.replace(/^--/, '');

    if (!names.has(name) || !process.argv[i].startsWith('--') || !process.argv[i + 1] || options[name]) {
        throw new Error('Usage: node browser-jvm/run.mjs --game-jar PATH --media-root PATH --jdk JDK25_DIRECTORY --browser CHROMIUM_EXECUTABLE');
    }

    options[name] = name === 'profile' ? process.argv[i + 1] : path.resolve(process.argv[i + 1]);
}

if (!['game-jar', 'media-root', 'jdk', 'browser'].every((name) => options[name])) {
    throw new Error('Required: --game-jar PATH --media-root PATH --jdk JDK25_DIRECTORY --browser CHROMIUM_EXECUTABLE');
}

const profile = options.profile || 'graphics';

if (!['graphics', 'lua', 'input', 'sprite', 'world', 'character-shader', 'animation', 'food'].includes(profile)) {
    throw new Error('Profile must be graphics, lua, input, sprite, world, character-shader, animation or food');
}

const output = path.join(repository, 'target', 'browser-jvm', profile);
const runtimeProfile = ['lua', 'sprite', 'world', 'character-shader', 'animation', 'food'].includes(profile);
const graphicsProfile = ['sprite', 'character-shader', 'animation'].includes(profile);
const worldSdkProfile = ['world', 'animation', 'food'].includes(profile);
const animationInputs = ['models_X/skinned/MaleBody.x', 'models_X/skinned/FemaleBody.x', 'models_X/skinned/Male_Skeleton.X', 'models_X/skinned/Female_Skeleton.X', 'anims_X/Bob/Bob_Idle.X', 'anims_X/Bob/Bob_Walk.x', 'anims_X/Bob/Bob_Run.X'];

const classes = path.join(output, 'classes');
const tools = path.join(output, 'tools');
const gameJar = options['game-jar'];
const png = path.join(options['media-root'], 'ui', 'avatarBackgroundWhite.png');
/**
 * Performs the executable operation for the owned browser runtime.
 *
 * @param {number} name - Numeric name argument for the declared operation.
 * @returns {unknown} Result of the declared browser or runtime operation.
 */
const executable = (name) => path.join(options.jdk, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));

/**
 * Checks whether a resolved path stays inside its declared root.
 *
 * @param {string} parent - Containing filesystem root.
 * @param {string} child - Resolved candidate filesystem path.
 * @returns {boolean} Whether the candidate remains within the root.
 */
function contained(parent, child) {
    const relative = path.relative(parent, child);

    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/**
 * Resolves existing ancestors before accepting a generated destination.
 *
 * @param {string} file - Filesystem path to read.
 * @returns {Promise<string>} Canonical path resolved through existing ancestors.
 */
async function canonical(file) {
    try {
        return await realpath(file);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }

        const parent = path.dirname(file);

        if (parent === file) {
            throw error;
        }

        return path.join(await canonical(parent), path.basename(file));
    }
}

// These checks deliberately precede every generated directory/file write.
const actualRepository = await realpath(repository);
const actualTarget = await canonical(path.join(repository, 'target'));
const actualOutput = await canonical(output);

if (!contained(actualRepository, actualTarget) || actualTarget === actualRepository
    || !contained(actualTarget, actualOutput) || actualOutput === actualTarget) {
    throw new Error('Generated output must remain inside the workspace target directory; escaping junctions are rejected');
}

await boundedReadOnly([...Object.entries(options).filter(([name]) => name !== 'profile').map(([,value]) => value), png, executable('java'), executable('javac')], async (prerequisite) => {
    if (contained(output, prerequisite) || contained(actualOutput, await canonical(prerequisite))) {
        throw new Error(`Prerequisite is inside generated output: ${prerequisite}`);
    }
});

await boundedReadOnly([classes, tools, ...['host-classes', 'bridge-classes', 'GeneratedFloatBridge.java', 'runtime-view.jar', 'full-entry.jar', 'float-bridge.jar', 'memory-bridge.jar', 'generated-float-members.tsv', 'float-bridge-summary.json', 'view.jar', 'class-manifest.json', 'result.json', 'build.json'].map((name) => path.join(output, name))], async (destination) => {
    if (!contained(actualOutput, await canonical(destination))) {
        throw new Error(`Generated destination escapes output: ${destination}`);
    }
});

/**
 * Rejects links and escaping entries in generated output.
 *
 * @param {string} directory - Generated directory to validate.
 */
async function validateExisting(directory) {
    let entries;

    try {
        entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
        if (error.code === 'ENOENT') {
            return;
        }

        throw error;
    }

    await boundedReadOnly(entries, async (entry) => {
        const file = path.join(directory, entry.name);

        if (!contained(actualOutput, await canonical(file))) {
            throw new Error(`Existing generated entry escapes output: ${file}`);
        }

        if (entry.isSymbolicLink()) {
            throw new Error(`Generated output may not contain links: ${file}`);
        }

        if (entry.isDirectory()) {
            await validateExisting(file);
        }
    });
}

await validateExisting(output);
await mkdir(output, { recursive: true });
await mkdir(classes, { recursive: true });
await mkdir(tools, { recursive: true });

/**
 * Hashes a file through a bounded streaming reader.
 *
 * @param {string} file - Filesystem path to read.
 * @returns {Promise<string>} SHA256 digest of the source file.
 */
async function hash(file) {
    const digest = createHash('sha256');

    for await (const bytes of createReadStream(file)) {
        digest.update(bytes);
    }

    return digest.digest('hex');
}

/**
 * Runs independent filesystem checks with a bounded number of simultaneous file handles.
 *
 * @param {unknown[]} items - Sources or destinations to inspect.
 * @param {function(unknown):Promise<unknown>} operation - Read-only check applied to each entry.
 * @returns {Promise<void>} Completion of all read-only checks.
 */
async function boundedReadOnly(items, operation) {
    for (let offset = 0; offset < items.length; offset += 32) {
        // eslint-disable-next-line no-await-in-loop -- Limit open files while completing each batch before the next.
        await Promise.all(items.slice(offset, offset + 32).map(operation));
    }
}

const requests = [];
const denied = [];
const logs = [];
const build = [];
let browser;
let server;
const evidence = { pass: false, runtime: 'CheerpJ 4.3 Java17', closed: false };
const assetHashes = [];

/**
 * Runs a compiler or preparation tool and records its result.
 *
 * @param {string} binary - Compiler or preparation executable.
 * @param {unknown[]} args - Arguments forwarded to the declared runtime operation.
 */
function command(binary, args) {
    const result = spawnSync(binary, args, { cwd: repository, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1_024 * 1_024 });

    build.push({ binary, args, status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message });

    if (result.error || result.status !== 0) {
        throw new Error(`Build failed: ${binary}\n${result.error?.message || result.stderr || result.stdout}`);
    }
}

try {
    await boundedReadOnly([gameJar, png, options.browser, executable('javac'), executable('java')], async (file) => {
        if (!(await stat(file)).isFile()) {
            throw new Error(`Expected file: ${file}`);
        }
    });

    evidence.originalJarSha256Before = await hash(gameJar);
    evidence.pngSha256Before = await hash(png);

    if (runtimeProfile) {
        await boundedReadOnly(['stdlib.lua', 'media/lua/shared/defines.lua', 'media/lua/shared/Sandbox/Apocalypse.lua'], async (name) => {
            const file = path.join(options['media-root'], '..', name);

            assetHashes.push({ name, file, sha256Before: await hash(file) });
        });
    }

    if (profile === 'sprite' || profile === 'character-shader') {
        await boundedReadOnly(profile === 'character-shader' ? ['basicEffect.vert', 'basicEffect.frag', 'util/math.h', 'util/math.glsl', 'util/hueShift.h', 'util/hueShift.glsl'].map((name) => `shaders/${name}`) : ['shaders/default.vert', 'shaders/default.frag'], async (name) => {
            const file = path.join(options['media-root'], name);

            assetHashes.push({ name, file, sha256Before: await hash(file) });
        });
    }

    command(executable('javac'), ['--release', '17', '-classpath', gameJar, '-d', classes, path.join(source, 'CheerpJGL.java')]);
    command(executable('javac'), ['-d', tools, path.join(source, 'PrepareBrowserJvm.java')]);
    command(executable('java'), ['-cp', tools, 'PrepareBrowserJvm', gameJar, output, classes]);

    if (runtimeProfile) {
        const hostClasses = path.join(output, 'host-classes');

        await mkdir(hostClasses, { recursive: true });
        command(executable('javac'), ['--release', '17', '-d', hostClasses,
            path.join(source, 'host/org/lwjgl/glfw/GLFWGamepadState.java'), path.join(source, 'host/port/host/BrowserBuffers.java')]);
        /* The bootstrap entry references generated getter declarations. Generate once for javac,
           then regenerate against the actual authored fixture fields, never loading game classes. */
        command(executable('javac'), ['-d', tools, path.join(source, 'PrepareRuntime.java')]);
        const bridgeSource = path.join(output, 'GeneratedFloatBridge.java');

        await writeFile(bridgeSource, 'package port.host; public final class GeneratedFloatBridge { public static native Object get(java.lang.reflect.Field f,Object o)throws IllegalAccessException; }');
        const bridgeClasses = path.join(output, 'bridge-classes');

        command(executable('javac'), ['--release', '17', '-d', bridgeClasses, bridgeSource]);
        command(executable('javac'), ['--release', '17', '-cp', [hostClasses, bridgeClasses, gameJar].join(path.delimiter), '-d', classes, path.join(source, 'CheerpJFull.java')]);
        command(executable('java'), ['-cp', tools, 'PrepareRuntime', output, classes]);
        command(executable('javac'), ['--release', '17', '-cp', bridgeClasses, '-d', bridgeClasses, bridgeSource]);
        command(executable('jar'), ['--create', '--file', path.join(output, 'full-entry.jar'), '-C', classes, 'probe/CheerpJFull.class']);
        command(executable('jar'), ['--create', '--file', path.join(output, 'float-bridge.jar'), '-C', bridgeClasses, '.']);
        command(executable('jar'), ['--create', '--file', path.join(output, 'memory-bridge.jar'), '-C', hostClasses, '.']);
    }

    if (profile === 'input') {
        command(executable('javac'), ['--release', '17', '-cp', gameJar, '-d', classes, path.join(source, 'CheerpJInput.java'), path.join(source, 'host/port/host/BrowserKeyboard.java')]);
        command(executable('javac'), ['-d', tools, path.join(source, 'PrepareInput.java')]);
        command(executable('java'), ['-cp', tools, 'PrepareInput', path.join(output, 'view.jar'), path.join(output, 'input-view.jar')]);
        command(executable('jar'), ['--create', '--file', path.join(output, 'input-entry.jar'), '-C', classes, 'probe/CheerpJInput.class', '-C', classes, 'port/host/BrowserKeyboard.class']);
    }

    if (graphicsProfile) {
        const spriteClasses = path.join(output, 'sprite-classes');

        await mkdir(spriteClasses, { recursive: true });
        command(executable('javac'), ['--release', '17', '-cp', [gameJar, classes].join(path.delimiter), '-d', spriteClasses, ...['CheerpJSprite.java', 'CheerpJCharacterShader.java', 'host/port/host/SpriteGraphics.java', 'host/port/host/SpriteBuffers.java', 'host/port/host/CharacterFrame.java'].map((name) => path.join(source, name))]);
        command(executable('javac'), ['-d', tools, path.join(source, 'PrepareSpriteGraphics.java')]);
        command(executable('java'), ['-cp', tools, 'PrepareSpriteGraphics', path.join(output, 'runtime-view.jar'), output, spriteClasses]);

        if (profile === 'character-shader') {
            await writeFile(path.join(output, 'character-shader.html'), (await readFile(path.join(source, 'sprite.html'), 'utf8')).replace('probe.CheerpJSprite', 'probe.CheerpJCharacterShader'));
        }
    }

    if (worldSdkProfile) {
        const worldClasses = path.join(output, 'world-classes');

        await mkdir(worldClasses, { recursive: true });
        command(executable('javac'), ['--release', '17', '-cp', gameJar, '-d', worldClasses, ...['CheerpJWorld.java', 'host/port/host/BrowserWorldBootstrap.java', 'host/port/host/PoolListSupport.java', 'host/port/host/BrowserKeyboard.java'].map((name) => path.join(source, name))]);
        command(executable('javac'), ['-d', tools, ...['PrepareInput.java', 'PrepareWorld.java', 'PrepareWorldAssets.java'].map((name) => path.join(source, name))]);
        command(executable('java'), ['-cp', tools, 'PrepareWorldAssets', options['media-root'], path.join(output, 'player-assets.jar'), path.join(output, 'player-assets-manifest.json')]);
        command(executable('java'), ['-cp', tools, 'PrepareInput', path.join(output, profile === 'animation' ? 'sprite-view.jar' : 'runtime-view.jar'), path.join(output, 'input-view.jar')]);
        command(executable('java'), ['-cp', tools, 'PrepareWorld', path.join(output, 'input-view.jar'), path.join(output, 'world-view.jar'), path.join(output, 'world-sdk-manifest.json')]);
        command(executable('jar'), ['--create', '--file', path.join(output, 'world-entry.jar'), '-C', worldClasses, '.']);
        const worldManifest = JSON.parse(await readFile(path.join(output, 'player-assets-manifest.json'), 'utf8'));

        evidence.worldAssets = { files: worldManifest.files, bytes: worldManifest.bytes };

        await boundedReadOnly(worldManifest.entries, async (asset) => {
            const file = path.join(options['media-root'], '..', asset.path);

            if (await hash(file) !== asset.sha256) {
                throw new Error(`Asset changed while preparing: ${asset.path}`);
            }

            assetHashes.push({ name: asset.path, file, sha256Before: asset.sha256 });
        });
    }

    if (profile === 'animation') {
        const animationClasses = path.join(output, 'animation-classes');
        const data = path.join(output, 'animation-data');

        await mkdir(animationClasses, { recursive: true });
        await mkdir(data, { recursive: true });
        command(executable('javac'), ['-cp', gameJar, '-d', tools, ...['animation/PrepareScenes.java', 'animation/AiSceneSnapshot.java', 'animation/PrepareAnimationAssets.java', 'animation/PrepareVendor.java', 'animation/PreparePath.java', 'animation/PrepareAnimationSdk.java', 'PrepareAtomic.java'].map((name) => path.join(source, name))]);
        const importer = path.join(path.dirname(gameJar), 'jassimp64.dll');

        assetHashes.push({ name: 'jassimp64.dll', file: importer, sha256Before: await hash(importer) });
        command(executable('java'), ['-cp', [tools, gameJar].join(path.delimiter), 'PrepareScenes', data, importer, ...animationInputs.map((name) => path.join(options['media-root'], name))]);
        command(executable('java'), ['-cp', tools, 'PrepareAnimationAssets', options['media-root'], path.join(output, 'animation-assets.jar'), path.join(output, 'animation-assets-manifest.json')]);
        command(executable('java'), ['-cp', tools, 'PrepareAtomic', path.join(output, 'world-view.jar'), path.join(output, 'atomic-view.jar'), path.join(output, 'atomic-adaptation.json')]);
        command(executable('java'), ['-cp', tools, 'PreparePath', path.join(output, 'atomic-view.jar'), path.join(output, 'path-view.jar'), path.join(output, 'path-adaptation.json')]);
        command(executable('java'), ['-cp', tools, 'PrepareVendor', gameJar, path.join(output, 'animation-view.jar')]);
        command(executable('java'), ['-cp', tools, 'PrepareAnimationSdk', path.join(output, 'atomic-view.jar'), path.join(output, 'animation-sdk-view.jar'), path.join(output, 'animation-sdk-adaptation.json')]);
        command(executable('javac'), ['--release', '17', '-cp', [gameJar, path.join(output, 'sprite-classes'), path.join(output, 'world-classes')].join(path.delimiter), '-d', animationClasses, ...['animation/BrowserClientAnimation.java', 'animation/AiSceneSnapshot.java', 'animation/PreparedSceneLoader.java', 'animation/PathCompat.java', 'host/port/host/ReferenceExchange.java', 'host/port/host/ListFirstSupport.java', 'host/port/host/CharacterFrame.java', 'host/port/host/ScriptBootstrap.java'].map((name) => path.join(source, name))]);
        command(executable('jar'), ['--create', '--file', path.join(output, 'animation-entry.jar'), '-C', animationClasses, '.']);
        const manifest = JSON.parse(await readFile(path.join(output, 'animation-assets-manifest.json'), 'utf8'));

        evidence.animationAssets = { files: manifest.files, bytes: manifest.bytes };
        evidence.preparedScenes = JSON.parse(await readFile(path.join(data, 'manifest.json'), 'utf8'));
        evidence.animationSdkAdaptation = JSON.parse(await readFile(path.join(output, 'animation-sdk-adaptation.json'), 'utf8'));
        evidence.legacyCompatibility = { atomic: JSON.parse(await readFile(path.join(output, 'atomic-adaptation.json'), 'utf8')), filesystem: JSON.parse(await readFile(path.join(output, 'path-adaptation.json'), 'utf8')) };

        await boundedReadOnly(manifest.entries, async (asset) => {
            const file = path.join(options['media-root'], '..', asset.path);

            if (await hash(file) !== asset.sha256) {
                throw new Error(`Animation asset changed while preparing: ${asset.path}`);
            }

            assetHashes.push({ name: asset.path, file, sha256Before: asset.sha256 });
        });
    }

    if (profile === 'food') {
        const foodClasses = path.join(output, 'food-classes');

        await mkdir(foodClasses, { recursive: true });
        command(executable('javac'), ['-d', tools, path.join(source, 'PrepareAtomic.java'), path.join(source, 'animation/PreparePath.java')]);
        command(executable('java'), ['-cp', tools, 'PrepareAtomic', path.join(output, 'world-view.jar'), path.join(output, 'atomic-view.jar'), path.join(output, 'atomic-adaptation.json')]);
        command(executable('java'), ['-cp', tools, 'PreparePath', path.join(output, 'atomic-view.jar'), path.join(output, 'path-view.jar'), path.join(output, 'path-adaptation.json')]);
        command(executable('javac'), ['--release', '17', '-cp', [gameJar, path.join(output, 'world-classes')].join(path.delimiter), '-d', foodClasses, ...['CheerpJFood.java', 'host/port/host/BrowserFoodBootstrap.java', 'host/port/host/ScriptBootstrap.java', 'host/port/host/ReferenceExchange.java', 'animation/PathCompat.java'].map((name) => path.join(source, name))]);
        command(executable('jar'), ['--create', '--file', path.join(output, 'food-entry.jar'), '-C', foodClasses, '.']);
        evidence.legacyCompatibility = { atomic: JSON.parse(await readFile(path.join(output, 'atomic-adaptation.json'), 'utf8')), filesystem: JSON.parse(await readFile(path.join(output, 'path-adaptation.json'), 'utf8')) };
        await writeFile(path.join(output, 'food.html'), (await readFile(path.join(source, 'world.html'), 'utf8')).replaceAll('CheerpJWorld', 'CheerpJFood').replace('Original player input qualification', 'Original player food qualification').replace('This qualification reads original player input. It does not move or render the player.', 'This qualification runs original inventory and food consumption. It does not move or render the player.').replace('/app/world-entry.jar:', '/app/food-entry.jar:/app/path-view.jar:/app/atomic-view.jar:/app/world-entry.jar:'));
    }

    evidence.viewJarSha256 = await hash(path.join(output, 'view.jar'));
    const manifest = JSON.parse(await readFile(path.join(output, 'class-manifest.json'), 'utf8'));

    evidence.classes = manifest.classes;
    evidence.headerLoweredClasses = manifest.headerLoweredClasses;
    evidence.adaptedVendorClasses = manifest.adaptedVendorClasses;
    evidence.gameMethodBodiesUnchanged = manifest.gameMethodBodiesUnchanged;

    const entryPages = { graphics: path.join(source, 'index.html'), lua: path.join(source, 'lua.html'), input: path.join(source, 'input.html'), sprite: path.join(source, 'sprite.html'), world: path.join(source, 'world.html'), animation: path.join(source, 'animation.html'), food: path.join(output, 'food.html'), 'character-shader': path.join(output, 'character-shader.html') };
    const entryPage = entryPages[profile];
    const routes = new Map([
        ['/', { file: entryPage, type: 'text/html; charset=utf-8' }],
        ['/index.html', { file: path.join(source, 'index.html'), type: 'text/html; charset=utf-8' }],
        ['/view.jar', { file: path.join(output, 'view.jar'), type: 'application/java-archive' }],
        ['/menu.png', { file: png, type: 'image/png' }],
    ]);

    if (runtimeProfile) {
        for (const name of ['full-entry.jar', 'float-bridge.jar', 'memory-bridge.jar', 'runtime-view.jar']) {
            routes.set(`/${name}`, { file: path.join(output, name), type: 'application/java-archive' });
        }

        for (const name of ['stdlib.lua', 'media/lua/shared/defines.lua', 'media/lua/shared/Sandbox/Apocalypse.lua']) {
            routes.set(`/${name}`, { file: path.join(options['media-root'], '..', name), type: 'text/plain' });
        }

        evidence.runtimeViewJarSha256 = await hash(path.join(output, 'runtime-view.jar'));
    }

    if (profile === 'input') {
        routes.set('/keyboard.js', { file: path.join(source, 'keyboard.js'), type: 'text/javascript' });

        for (const name of ['input-view.jar', 'input-entry.jar']) {
            routes.set(`/${name}`, { file: path.join(output, name), type: 'application/java-archive' });
        }
    }

    if (graphicsProfile) {
        routes.set('/sprite-webgl.js', { file: path.join(source, 'sprite-webgl.js'), type: 'text/javascript' });
        routes.set('/sprite-view.jar', { file: path.join(output, 'sprite-view.jar'), type: 'application/java-archive' });

        if (profile !== 'animation') {
            for (const name of (profile === 'character-shader' ? ['basicEffect.vert', 'basicEffect.frag', 'util/math.h', 'util/math.glsl', 'util/hueShift.h', 'util/hueShift.glsl'].map((name) => `shaders/${name}`) : ['ui/avatarBackgroundWhite.png', 'shaders/default.vert', 'shaders/default.frag'])) {
                routes.set(`/media/${name}`, { file: path.join(options['media-root'], name), type: name.endsWith('.png') ? 'image/png' : 'text/plain' });
            }
        }

        evidence.spriteAdaptations = JSON.parse(await readFile(path.join(output, 'sprite-graphics-manifest.json'), 'utf8'));
    }

    if (worldSdkProfile) {
        routes.set('/keyboard.js', { file: path.join(source, 'keyboard.js'), type: 'text/javascript' });

        for (const name of ['world-entry.jar', 'world-view.jar', 'player-assets.jar']) {
            routes.set(`/${name}`, { file: path.join(output, name), type: 'application/java-archive' });
        }

        evidence.sdkAdaptations = JSON.parse(await readFile(path.join(output, 'world-sdk-manifest.json'), 'utf8'));
        evidence.gameMethodBodiesUnchanged = false;
        evidence.originalGameAlgorithmsPreserved = true;
    }

    if (profile === 'animation') {
        for (const name of ['animation-entry.jar', 'animation-view.jar', 'animation-sdk-view.jar', 'path-view.jar', 'atomic-view.jar', 'animation-assets.jar']) {
            routes.set(`/${name}`, { file: path.join(output, name), type: 'application/java-archive' });
        }

        for (const name of ['prepared.properties', ...animationInputs.map((name) => `${path.basename(name)}.ais`)]) {
            routes.set(`/${name}`, { file: path.join(output, 'animation-data', name), type: 'application/octet-stream' });
        }
    }

    if (profile === 'food') {
        for (const name of ['food-entry.jar', 'path-view.jar', 'atomic-view.jar']) {
            routes.set(`/${name}`, { file: path.join(output, name), type: 'application/java-archive' });
        }

        await boundedReadOnly(['scripts/generated/items/food.txt', 'scripts/generated/evolvedrecipes.txt', 'scripts/generated/recipes/recipes_fishing_evolvedrecipe.txt'], async (name) => {
            const file = path.join(options['media-root'], name);

            assetHashes.push({ name: `media/${name}`, file, sha256Before: await hash(file) });
            routes.set(`/media/${name}`, { file, type: 'text/plain' });
        });
    }

    evidence.profile = profile;

    if (runtimeProfile) {
        evidence.runtimeAdaptations = JSON.parse(await readFile(path.join(output, 'float-bridge-summary.json'), 'utf8'));
    }

    server = createServer(async (request, response) => {
        try {
            if (!['GET', 'HEAD'].includes(request.method)) {
                response.writeHead(405).end();

                return;
            }

            // Match the raw path. Never resolve a request path against the filesystem.
            const route = routes.get(request.url);

            if (!route) {
                response.writeHead(404).end();

                return;
            }

            const size = (await stat(route.file)).size;
            const headers = { 'Content-Type': route.type, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
            let start = 0;
            let end = size - 1;
            let status = 200;

            if (request.headers.range) {
                const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);

                if (!match || (!match[1] && !match[2])) {
                    response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();

                    return;
                }

                if (!match[1]) {
                    start = Math.max(0, size - Number(match[2]));
                } else {
                    start = Number(match[1]);
                    end = match[2] ? Math.min(Number(match[2]), end) : end;
                }

                if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || end >= size) {
                    response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();

                    return;
                }

                status = 206;
                headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
            }

            headers['Content-Length'] = end - start + 1;
            response.writeHead(status, headers);

            if (request.method === 'HEAD') {
                response.end();
            } else {
                const stream = createReadStream(route.file, { start, end });

                stream.on('error', (error) => response.destroy(error));
                response.on('close', () => stream.destroy());
                stream.pipe(response);
            }
        } catch (error) {
            if (!response.headersSent) {
                response.writeHead(500);
            }

            response.end('Local artifact unavailable');
            logs.push(`HTTP: ${error.message}`);
        }
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;

    evidence.origin = origin;
    browser = await chromium.launch({ executablePath: options.browser, headless: true });
    const context = await browser.newContext({ serviceWorkers: 'block' });

    await context.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const item = { url: request.url(), method: request.method(), postDataBytes: request.postDataBuffer()?.length || 0 };

        requests.push(item);
        const local = url.origin === origin && routes.has(url.pathname) && !url.search;
        const runtime = url.origin === 'https://cjrtnc.leaningtech.com' && url.pathname.startsWith('/4.3/');

        if (!['GET', 'HEAD'].includes(request.method()) || item.postDataBytes || (!local && !runtime)) {
            denied.push(item);
            await route.abort();

            return;
        }

        await route.continue();
    });
    const page = await context.newPage();

    page.on('console', (message) => logs.push(`${message.type()}: ${message.text()}`));
    page.on('pageerror', (error) => logs.push(`PAGEERROR: ${error.stack}`));
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    if (profile === 'input') {
        for (const [phase, action] of [['press', () => page.keyboard.down('w')], ['release', () => page.keyboard.up('w')], ['focus-press', () => page.keyboard.down('w')], ['blur', () => page.locator('#outside').focus()]]) {
            // eslint-disable-next-line no-await-in-loop -- Each key action must follow its matching original Java input phase.
            await page.waitForFunction((expected) => globalThis.inputPhase === expected, phase, { timeout: 60_000 });
            // eslint-disable-next-line no-await-in-loop -- Each key action must follow its matching original Java input phase.
            await action();
        }

        await page.keyboard.up('w');
    }

    if (profile === 'world') {
        for (const [phase, action] of [['press', () => page.keyboard.down('w')], ['release', () => page.keyboard.up('w')]]) {
            // eslint-disable-next-line no-await-in-loop -- Each key action must follow its matching original Java input phase.
            await page.waitForFunction((expected) => globalThis.inputPhase === expected, phase, { timeout: 60_000 });
            // eslint-disable-next-line no-await-in-loop -- Each key action must follow its matching original Java input phase.
            await action();
        }
    }

    await page.waitForFunction(() => globalThis.probeResult, undefined, { timeout: 180_000 });
    evidence.result = await page.evaluate(() => globalThis.probeResult);

    if (runtimeProfile) {
        evidence.stages = await page.evaluate(() => globalThis.stageResults);
    }

    evidence.pass = evidence.result.pass === true && denied.length === 0;

    if (profile === 'animation' && evidence.pass) {
        const screenshot = path.join(output, 'character-frame.png');

        await page.locator('#graphics-canvas').screenshot({ path: screenshot });
        evidence.characterScreenshot = screenshot;
    }
} catch (error) {
    evidence.error = String(error.stack || error);
} finally {
    const cleanupErrors = [];

    if (browser) {
        try {
            await browser.close();
        } catch (error) {
            cleanupErrors.push(`browser: ${error.message}`);
        }
    }

    if (server) {
        try {
            await new Promise((resolve, reject) => {
                server.close((error) => {
                    if (error) {
                        reject(error);
                    } else {
                        resolve();
                    }
                });
            });
        } catch (error) {
            cleanupErrors.push(`server: ${error.message}`);
        }
    }

    evidence.closed = cleanupErrors.length === 0;

    if (cleanupErrors.length) {
        evidence.cleanupErrors = cleanupErrors;
        evidence.pass = false;
    }

    await boundedReadOnly([['originalJar', gameJar], ['png', png]], async ([label, file]) => {
        try {
            evidence[`${label}Sha256After`] = await hash(file);

            if (!evidence[`${label}Sha256Before`] || evidence[`${label}Sha256After`] !== evidence[`${label}Sha256Before`]) {
                evidence.pass = false;
            }
        } catch (error) {
            evidence.pass = false;
            logs.push(`Hash verification: ${error.message}`);
        }
    });

    evidence.requests = requests;
    evidence.denied = denied;
    evidence.logs = logs;
    evidence.externalNonReadRequests = requests.filter((r) => !r.url.startsWith(evidence.origin || 'http://127.0.0.1/') && (!['GET', 'HEAD'].includes(r.method) || r.postDataBytes));

    await boundedReadOnly(assetHashes, async (asset) => {
        try {
            asset.sha256After = await hash(asset.file);

            if (asset.sha256After !== asset.sha256Before) {
                evidence.pass = false;
            }
        } catch (error) {
            asset.error = String(error);
            evidence.pass = false;
        }
    });

    if (assetHashes.length) {
        evidence.assets = assetHashes;
    }

    await writeFile(path.join(output, 'build.json'), `${JSON.stringify(build, null, 2)}\n`);
    await writeFile(path.join(output, 'result.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    await writeFile(path.join(output, `result-${profile}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ ...evidence, requests: requests.length, logs: logs.length, resultFile: path.join(output, 'result.json') }, null, 2)}\n`);

    if (!evidence.pass) {
        process.exitCode = 1;
    }
}
