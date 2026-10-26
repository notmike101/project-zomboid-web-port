import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [gameArgument, jdkArgument, clipperArgument, outputArgument] = process.argv.slice(2);

assert.ok(outputArgument && process.argv.length === 6,
    'Usage: node prepare-base-jars.mjs INSTALLED_GAME_JAR JDK25_DIRECTORY CLIPPER2_JAR NEW_OUTPUT_DIRECTORY');
const game = path.resolve(gameArgument);
const jdk = path.resolve(jdkArgument);
const clipper = path.resolve(clipperArgument);
const output = path.resolve(outputArgument);
const source = path.resolve(import.meta.dirname, '..');
const inputs = new Map();
/**
 * Identifies exact file bytes.
 *
 * @param {Buffer} bytes - File contents.
 * @returns {string} SHA-256 identity.
 */
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

assert.ok(output.startsWith(path.resolve(source, '../target') + path.sep), 'Output must be inside workspace target');
assert.ok(!game.startsWith(output + path.sep) && !clipper.startsWith(output + path.sep));
const workspace = await realpath(path.resolve(source, '..'));
const target = await realpath(path.resolve(source, '../target'));
const outputParent = await realpath(path.dirname(output));

assert.ok(target.startsWith(workspace + path.sep), 'Target junction escapes workspace');
assert.ok(outputParent === target || outputParent.startsWith(target + path.sep), 'Output parent junction escapes target');
// Fresh owned directory only; never reuse or overwrite a generation.
await mkdir(output);
const tools = path.join(output, 'tools');

await mkdir(tools);

/**
 * Runs JDK tools only: preparers parse classfiles without initializing game classes.
 *
 * @param {string} tool - JDK executable.
 * @param {string[]} args - Tool arguments.
 * @param {string} cwd - Owned working directory.
 * @returns {string} Tool output.
 */
function command(tool, args, cwd = path.resolve(source, '..')) {
    const result = spawnSync(path.join(jdk, 'bin', `${tool}${process.platform === 'win32' ? '.exe' : ''}`), args,
        { cwd, encoding: 'utf8', maxBuffer: 8 * 1_024 * 1_024 });

    assert.ifError(result.error);
    assert.equal(result.status, 0, `${tool}: ${result.stderr || result.stdout}`);

    return result.stdout;
}

/**
 * Records an immutable source input.
 *
 * @param {string} file - Input to include in provenance.
 */
async function remember(file) {
    const bytes = await readFile(file);
    const record = { file, bytes: bytes.length, sha256: digest(bytes) };
    const previous = inputs.get(file);

    if (previous) {
        assert.deepEqual(record, previous, `Input changed between compilations: ${file}`);
    } else {
        inputs.set(file, record);
    }
}

/**
 * Compiles maintained authored sources.
 *
 * @param {string} directory - Owned class output name.
 * @param {string[]} names - Repository source paths.
 * @param {string[]} classpath - Ordered compile inputs.
 * @param {boolean} release - Whether to target Java17 rather than the JDK25 classfile API.
 */
async function compile(directory, names, classpath = [], release = true) {
    await mkdir(path.join(output, directory), { recursive: true });
    const files = names.map((name) => path.resolve(source, name));

    await Promise.all(files.map(remember));
    command('javac', ['-J-Xmx256m', ...(release ? ['--release', '17'] : []),
        ...(classpath.length ? ['-cp', classpath.join(path.delimiter)] : []),
        '-d', path.join(output, directory), ...files]);
}

/**
 * Applies an existing source-preserving preparer.
 *
 * @param {string} name - Parse-only preparer.
 * @param {string[]} args - Input/output paths.
 */
function prepare(name, args) {
    command('java', ['-Xmx256m', '-cp', [tools, game].join(path.delimiter), name,
        ...args.map((value) => path.resolve(output, value))]);
}

/**
 * Packages authored classes.
 *
 * @param {string} name - Archive output name.
 * @param {string} directory - Authored classes.
 */
function archive(name, directory) {
    command('jar', ['--create', '--file', path.join(output, name), '-C', path.join(output, directory), '.']);
}

await Promise.all([game, clipper, import.meta.filename].map(remember));
assert.equal(inputs.get(clipper).sha256, 'f143c550014a15a45884b4506a5ed984c7467bd080880aa9cb80bb9aaabdf2ff',
    'Use the qualified Clipper2 2.0.1b archive');
await compile('classes', ['CheerpJGL.java'], [game]);
await compile('tools', ['PrepareBrowserJvm.java', 'PrepareRuntime.java', 'PrepareSpriteGraphics.java',
    'PrepareInput.java', 'PrepareWorld.java', 'PrepareAtomic.java', 'animation/PreparePath.java',
    'animation/PrepareVendor.java', 'animation/PrepareAnimationSdk.java', 'PrepareKeyboardEvents.java',
    'PrepareMouse.java', 'PrepareClipboard.java', 'PrepareControllers.java', 'PrepareDisplayEvents.java',
    'PrepareCustomCursor.java'], [], false);
prepare('PrepareBrowserJvm', [game, output, 'classes']);
await compile('host-classes', ['host/org/lwjgl/glfw/GLFWGamepadState.java', 'host/port/host/BrowserBuffers.java']);
await mkdir(path.join(output, 'bridge-classes'));
const bridge = path.join(output, 'GeneratedFloatBridge.java');

await writeFile(bridge, 'package port.host; public final class GeneratedFloatBridge { public static native Object get(java.lang.reflect.Field f,Object o)throws IllegalAccessException; }\n');
command('javac', ['--release', '17', '-d', path.join(output, 'bridge-classes'), bridge]);
await compile('classes', ['CheerpJFull.java'], [path.join(output, 'host-classes'), path.join(output, 'bridge-classes'), game]);
prepare('PrepareRuntime', [output, 'classes']);
command('javac', ['--release', '17', '-cp', path.join(output, 'bridge-classes'), '-d', path.join(output, 'bridge-classes'), bridge]);
archive('float-bridge.jar', 'bridge-classes');
archive('memory-bridge.jar', 'host-classes');
await compile('sprite-classes', ['CheerpJSprite.java', 'CheerpJCharacterShader.java',
    ...['SpriteGraphics', 'SpriteBuffers', 'CharacterFrame'].map((name) => `host/port/host/${name}.java`)], [game, path.join(output, 'classes')]);
prepare('PrepareSpriteGraphics', ['runtime-view.jar', output, 'sprite-classes']);
await compile('world-classes', ['CheerpJWorld.java', ...['BrowserWorldBootstrap', 'PoolListSupport', 'BrowserKeyboard']
    .map((name) => `host/port/host/${name}.java`)], [game]);
prepare('PrepareInput', ['sprite-view.jar', 'input-view.jar']);
prepare('PrepareWorld', ['input-view.jar', 'world-view.jar', 'world-sdk-manifest.json']);
archive('world-entry.jar', 'world-classes');
prepare('PrepareAtomic', ['world-view.jar', 'atomic-view.jar', 'atomic-adaptation.json']);
prepare('PreparePath', ['atomic-view.jar', 'path-view.jar', 'path-adaptation.json']);
prepare('PrepareVendor', [game, 'animation-view.jar']);
prepare('PrepareAnimationSdk', ['atomic-view.jar', 'animation-sdk-view.jar', 'animation-sdk-adaptation.json']);
await compile('animation-classes', ['animation/BrowserClientAnimation.java', 'animation/AiSceneSnapshot.java',
    'animation/PreparedSceneLoader.java', 'animation/PathCompat.java', ...['ReferenceExchange', 'BrowserClock',
        'ListFirstSupport', 'StackFirstSupport', 'ArrayListFirstSupport', 'CharacterFrame', 'ScriptBootstrap']
        .map((name) => `host/port/host/${name}.java`)], [game, path.join(output, 'sprite-classes'), path.join(output, 'world-classes')]);
archive('animation-entry.jar', 'animation-classes');
prepare('PrepareKeyboardEvents', ['atomic-view.jar', 'play-input-view.jar', 'keyboard.json']);
prepare('PrepareMouse', ['atomic-view.jar', 'play-mouse-view.jar', 'mouse.json']);
prepare('PrepareClipboard', ['atomic-view.jar', 'play-clipboard-view.jar', 'clipboard.json']);
prepare('PrepareControllers', ['atomic-view.jar', 'play-controller-view.jar', 'controllers.json', 'play-clipboard-view.jar', 'play-input-view.jar']);
prepare('PrepareDisplayEvents', ['runtime-view.jar', 'play-input-view.jar', 'play-display-view.jar', 'display.json']);
prepare('PrepareCustomCursor', ['atomic-view.jar', 'play-mouse-view.jar', 'cursor-view.jar', 'cursor.json']);

// Compose the first facade from freshly qualified output, never raw SpriteGraphics javac output.
await mkdir(path.join(output, 'facade'));
command('jar', ['--extract', '--file', path.join(output, 'sprite-view.jar'),
    'port/host/SpriteGraphics.class'], path.join(output, 'facade'));
// The first archive must retain both controller UTF-8 and sprite copy adaptations.
command('jar', ['--extract', '--file', path.join(output, 'play-controller-view.jar'),
    'org/lwjgl/system/MemoryUtil.class'], path.join(output, 'facade'));
archive('apng-copy-overlay.jar', 'facade');
await copyFile(clipper, path.join(output, 'clipper2.jar'));
const helperNames = ['BrowserAvatarDiagnostics', 'BrowserClipboard', 'BrowserClock', 'BrowserControllers',
    'BrowserCustomCursor', 'BrowserDisplayEvents', 'BrowserKeyboardEvents', 'BrowserMouse', 'BrowserZNet',
    'ClipperSupport', 'FmodArrays', 'PopulationBuffers', 'SpriteBuffers', 'SqliteFiles', 'SqliteSupport'];

await compile('entry-classes', ['startup/java/zombie/BrowserLifecycleBoot.java', 'startup/java/zombie/BrowserLifecycleController.java',
    'startup/java/zombie/BrowserOriginalBoot.java', 'host/org/lwjgl/stb/STBImage.java', 'animation/AiSceneSnapshot.java',
    'animation/manifest/ManifestSceneLoader.java', 'animation/manifest/PrepareManifestScenes.java',
    ...helperNames.map((name) => `host/port/host/${name}.java`)],
[game, clipper, path.join(output, 'sprite-classes'), path.join(output, 'world-classes'), path.join(output, 'animation-classes')]);
const forwarder = path.join(output, 'PreparedSceneLoader.java');

await writeFile(forwarder, 'public final class PreparedSceneLoader { public static jassimp.AiScene importFile(String file,java.util.Set<jassimp.AiPostProcessSteps> flags)throws java.io.IOException { return ManifestSceneLoader.importFile(file,flags); } }\n');
command('javac', ['--release', '17', '-cp', [game, path.join(output, 'entry-classes')].join(path.delimiter),
    '-d', path.join(output, 'entry-classes'), forwarder]);
archive('original-boot-entry.jar', 'entry-classes');
const order = ['apng-copy-overlay', 'original-boot-entry', 'cursor-view', 'play-display-view', 'play-controller-view',
    'play-clipboard-view', 'play-input-view', 'play-mouse-view', 'clipper2', 'animation-entry', 'animation-view',
    'animation-sdk-view', 'path-view', 'float-bridge', 'memory-bridge', 'world-entry', 'atomic-view'];
const archives = await Promise.all(order.map(async (name) => {
    const file = path.join(output, `${name}.jar`);
    const bytes = await readFile(file);

    return { url: `/${name}.jar`, file, bytes: bytes.length, sha256: digest(bytes) };
}));

await Promise.all([...inputs.values()].map(async (record) => {
    assert.equal(digest(await readFile(record.file)), record.sha256, `Input changed: ${record.file}`);
}));

await writeFile(path.join(output, 'base-jars.json'), JSON.stringify({
    schema: 'original-startup-source-jars-v1',
    executionAdmitted: false, scope: 'Source-built ordered archives only; supplied scene/media/runtime assembly remains required',
    inputs: [...inputs.values()].sort((a, b) => a.file.localeCompare(b.file)),
    classpath: archives.map((record) => `/app${record.url}`), routes: archives,
}, null, 2));
console.info(JSON.stringify({ output, archives: archives.length, executionAdmitted: false }));
