import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve, join, delimiter } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import { loadAssets } from './asset-host.mjs';

const { values } = parseArgs({
    options: {
        ...Object.fromEntries(
            ['game-jar', 'java', 'jdk', 'maven-home', 'browser', 'probe', 'media-root'].map((key) => [key, { type: 'string' }])),
        'compile-only': { type: 'boolean', default: false },
    },
});
const probeName = values.probe || 'angles';
const probes = {
    angles: {
        mainClass: 'probe.AngleProbe', cases: 8, comparisons: 16,
        classes: ['zombie.core.math.PZMath'],
        symbols: ['PZMath::lerpAngle', 'PZMath::getClosestAngle'],
    },
    weather: {
        mainClass: 'probe.WeatherProbe', cases: 16, comparisons: 40,
        classes: ['zombie.iso.weather.SimplexNoise', 'zombie.iso.weather.SimplexNoise$Grad', 'zombie.iso.weather.fx.SteppedUpdateFloat'],
        symbols: ['SteppedUpdateFloat::update', 'SteppedUpdateFloat::setTarget', 'SimplexNoise::noise'],
    },
    airfront: {
        mainClass: 'probe.AirFrontProbe', cases: 8, comparisons: 112,
        classes: ['zombie.iso.weather.ClimateManager$AirFront'],
        symbols: ['ClimateManager$AirFront::addDaySample', 'ClimateManager$AirFront::save', 'ClimateManager$AirFront::load'],
    },
    erosion: {
        mainClass: 'probe.ErosionProbe', cases: 16, comparisons: 16,
        classes: ['zombie.erosion.utils.Noise2D', 'zombie.erosion.utils.Noise2D$Layer'],
        symbols: ['Noise2D::addLayer', 'Noise2D::layeredNoise', 'Noise2D::reset'],
    },
    colors: {
        mainClass: 'probe.ColorProbe', cases: 8, comparisons: 128,
        classes: ['zombie.core.Color', 'zombie.core.math.PZMath', 'zombie.iso.weather.ClimateColorInfo'],
        symbols: ['ClimateColorInfo::interp', 'ClimateColorInfo::scale', 'ClimateColorInfo::save', 'ClimateColorInfo::load'],
    },
    'browser-save': {
        mainClass: 'probe.BrowserSaveProbe', cases: 8, comparisons: 112,
        classes: ['zombie.iso.weather.ClimateManager$AirFront'],
        symbols: ['ClimateManager$AirFront::addDaySample', 'ClimateManager$AirFront::save', 'ClimateManager$AirFront::load'],
    },
    reader: {
        mainClass: 'probe.ReaderProbe', category: 'runtime-compatibility', cases: 8, comparisons: 16,
        classes: [], symbols: [],
    },
    paths: {
        mainClass: 'probe.PathProbe', category: 'runtime-compatibility', cases: 19, comparisons: 38,
        classes: [], symbols: [],
    },
    linkage: {
        mainClass: 'probe.LinkageProbe', category: 'runtime-compatibility', cases: 8, comparisons: 16,
        classes: [], symbols: [],
    },
    'legacy-string': {
        mainClass: 'probe.LegacyStringProbe', category: 'runtime-compatibility', cases: 16, comparisons: 32,
        classes: [], symbols: [],
    },
    queue: {
        mainClass: 'probe.QueueProbe', category: 'runtime-compatibility', cases: 8, comparisons: 16,
        classes: [], symbols: [],
    },
    'file-stream': {
        mainClass: 'probe.FileStreamProbe', category: 'runtime-compatibility', cases: 8, comparisons: 16,
        classes: [], symbols: [],
    },
    deque: {
        mainClass: 'probe.DequeProbe', category: 'runtime-compatibility', cases: 8, comparisons: 16,
        classes: [], symbols: [],
    },
    fma: {
        mainClass: 'probe.FmaProbe', category: 'runtime-compatibility', cases: 128, comparisons: 128,
        classes: [], symbols: [],
    },
    'field-handles': {
        mainClass: 'probe.FieldHandleProbe', category: 'runtime-compatibility', fieldHandles: true,
        cases: 8, comparisons: 16, classes: [], symbols: [],
    },
    'lazy-value': {
        mainClass: 'probe.LazyValueProbe', fieldHandles: true, cases: 8, comparisons: 16,
        classes: ['zombie.util.LazyValue'], symbols: ['LazyValue::get', 'LazyValue::<init>'],
    },
    resources: {
        mainClass: 'probe.ResourceProbe', category: 'runtime-compatibility', resources: true,
        cases: 18, comparisons: 36, classes: [], symbols: [],
    },
    future: {
        mainClass: 'probe.FutureProbe', category: 'runtime-compatibility', cases: 16, comparisons: 32,
        classes: [], symbols: [],
    },
    executors: {
        mainClass: 'probe.ExecutorProbe', category: 'runtime-compatibility', cases: 8, comparisons: 16,
        classes: [], symbols: [],
    },
    'time-units': {
        mainClass: 'probe.TimeUnitProbe', category: 'runtime-compatibility', cases: 16, comparisons: 112,
        classes: [], symbols: [],
    },
    digest: {
        mainClass: 'probe.DigestProbe', category: 'runtime-compatibility', cases: 16, comparisons: 96,
        classes: [], symbols: [],
    },
    locks: {
        mainClass: 'probe.LockProbe', category: 'runtime-compatibility', cases: 16, comparisons: 32,
        classes: [], symbols: [],
    },
    rectangles: {
        mainClass: 'probe.RectangleProbe', category: 'runtime-compatibility', cases: 16, comparisons: 80,
        classes: [], symbols: [],
    },
    channels: {
        mainClass: 'probe.ChannelProbe', category: 'runtime-compatibility', cases: 16, comparisons: 32,
        classes: [], symbols: [],
    },
    'format-exception': { mainClass: 'probe.FormatExceptionProbe', category: 'runtime-compatibility', cases: 8, comparisons: 16, classes: [], symbols: [] },
    watch: { mainClass: 'probe.WatchProbe', category: 'runtime-compatibility', watchService: true, cases: 8, comparisons: 16, classes: [], symbols: [] },
    libraries: {
        mainClass: 'probe.LibraryProbe', category: 'runtime-compatibility', nativeLibraries: true, cases: 8, comparisons: 16,
        classes: [], symbols: [],
    },
    regex: {
        mainClass: 'probe.RegexProbe', category: 'runtime-compatibility', regex: true, cases: 16, comparisons: 32,
        classes: [], symbols: [],
    },
    memory: {
        mainClass: 'probe.MemoryProbe', category: 'browser-memory', browserOnly: true, memory: true,
        cases: 9, comparisons: 59, symbols: [],
    },
    joml: {
        mainClass: 'probe.JomlProbe', category: 'vendor-compatibility', joml: true, cases: 8, comparisons: 128,
        classes: [], symbols: [], vendorSymbols: ['org.joml.Matrix4f::setOrtho', 'org.joml.MemUtil$MemUtilNIO::put'],
    },
    'shader-parameter': {
        mainClass: 'probe.ShaderParameterBoundaryProbe', compileOnly: true, webgl: true, memory: true,
        symbols: ['ShaderParameter::<init>'],
    },
    graphics: {
        mainClass: 'probe.GraphicsProbe', category: 'browser-graphics', browserOnly: true, webgl: true, memory: true,
        cases: 4, comparisons: 50, symbols: ['Color::scale'],
    },
    'graphics-worker': {
        nativeCapabilities: true, mainClass: 'probe.GraphicsProbe', category: 'browser-graphics', browserOnly: true, webgl: true, memory: true,
        cases: 4, comparisons: 50, symbols: ['Color::scale'], worker: true,
    },
    exit: {
        mainClass: 'probe.WorkerExitProbe', category: 'browser-process', browserOnly: true, workerProcess: true,
        cases: 1, comparisons: 2, symbols: [],
    },
    'native-capabilities': { mainClass: 'probe.NativeCapabilitiesProbe', category: 'browser-native-capabilities', fixture: 'engine', browserOnly: true, webgl: true, resources: true, nativeCapabilities: true, cases: 1, comparisons: 2, symbols: [] },
    generics: { mainClass: 'probe.GenericProbe', category: 'runtime-compatibility', generics: true, cases: 8, comparisons: 16, classes: [], symbols: [] },
    'anonymous-class': { mainClass: 'probe.AnonymousClassProbe', category: 'runtime-compatibility', cases: 8, comparisons: 16, classes: [], symbols: [] },
    'package-name': { mainClass: 'probe.PackageNameProbe', category: 'runtime-compatibility', cases: 8, comparisons: 16, classes: [], symbols: [] },
    'module-token': { mainClass: 'probe.ModuleDescriptorProbe', category: 'runtime-compatibility', cases: 1, comparisons: 2, classes: [], symbols: [] },
    'thread-groups': { mainClass: 'probe.ThreadGroupProbe', category: 'runtime-compatibility', threadGroups: true, cases: 4, comparisons: 8, classes: [], symbols: [] },
    'audio-capability': { mainClass: 'probe.AudioCapabilityProbe', category: 'browser-audio-capability', fixture: 'engine', browserOnly: true, resources: true, nativeCapabilities: true, cases: 1, comparisons: 2, symbols: [] },
    management: { mainClass: 'probe.ManagementProbe', category: 'browser-management', fixture: 'engine', browserOnly: true, resources: true, cases: 1, comparisons: 2, symbols: [] },
    'serialization-boundary': { mainClass: 'probe.SerializationBoundaryProbe', category: 'browser-serialization-capability', fixture: 'engine', browserOnly: true, resources: true, cases: 2, comparisons: 4, symbols: [] },
    subprocess: { mainClass: 'probe.ProcessBoundaryProbe', category: 'browser-subprocess', fixture: 'engine', browserOnly: true, resources: true, cases: 1, comparisons: 2, symbols: [] },
    'reflection-exposure': { generics: true, reflectionExposure: true, assets: true, standardLibrary: true, nativeCapabilities: true, mainClass: 'probe.ReflectionExposureProbe', category: 'browser-reflection-exposure', fixture: 'engine', browserOnly: true, webgl: true, memory: true, joml: true, fieldHandles: true, resources: true, workerProcess: true, nativeLibraries: true, regex: true, watchService: true, cases: 3, comparisons: 6, symbols: ['GameVersion::getMajor'] },
    'standard-environment': { assets: true, standardLibrary: true, nativeCapabilities: true, mainClass: 'probe.StandardEnvironmentProbe', category: 'browser-assets', fixture: 'engine', browserOnly: true, webgl: true, memory: true, joml: true, fieldHandles: true, resources: true, workerProcess: true, nativeLibraries: true, regex: true, watchService: true, cases: 2, comparisons: 4, symbols: [] },
    'lua-manager-init': { threadGroups: true, generics: true, nativeCapabilities: true, mainClass: 'probe.LuaManagerInitBoundaryProbe', compileOnly: true, webgl: true, memory: true, joml: true, fieldHandles: true, resources: true, workerProcess: true, nativeLibraries: true, regex: true, watchService: true, symbols: ['LuaManager::init'] },
    'game-keyboard': { mainClass: 'probe.GameKeyboardProbe', category: 'browser-game-keyboard', fixture: 'keyboard', browserOnly: true, keyboard: true, gameInput: true, nativeCapabilities: true, webgl: true, memory: true, joml: true, fieldHandles: true, resources: true, workerProcess: true, nativeLibraries: true, regex: true, watchService: true, cases: 8, comparisons: 16, symbols: ['GameKeyboard::update'] },
    keyboard: { mainClass: 'probe.KeyboardProbe', category: 'browser-keyboard', browserOnly: true, keyboard: true, cases: 8, comparisons: 16, symbols: [] },
    'filesystem-runtime': { assets: true, nativeCapabilities: true, mainClass: 'probe.FilesystemRuntimeProbe', category: 'browser-core', browserOnly: true, webgl: true, memory: true, joml: true, fieldHandles: true, resources: true, workerProcess: true, nativeLibraries: true, regex: true, watchService: true, cases: 2, comparisons: 6, symbols: ['ZomboidFileSystem::init'] },
    'asset-lua': { assets: true, nativeCapabilities: true, mainClass: 'probe.AssetLuaProbe', category: 'browser-assets', fixture: 'engine', browserOnly: true, webgl: true, memory: true, joml: true, fieldHandles: true, resources: true, workerProcess: true, nativeLibraries: true, regex: true, watchService: true, cases: 4, comparisons: 8, symbols: [] },
    'lua-runtime': { nativeCapabilities: true, mainClass: 'probe.LuaRuntimeProbe', category: 'browser-lua-runtime', fixture: 'engine', browserOnly: true, webgl: true, memory: true, joml: true, fieldHandles: true, resources: true, workerProcess: true, nativeLibraries: true, regex: true, watchService: true, cases: 2, comparisons: 4, symbols: [] },
    'season-runtime': { nativeCapabilities: true, mainClass: 'probe.SeasonRuntimeProbe', category: 'browser-core', browserOnly: true, webgl: true, memory: true, joml: true, fieldHandles: true, resources: true, workerProcess: true, nativeLibraries: true, regex: true, watchService: true, cases: 2, comparisons: 20, symbols: ['ErosionSeason::setDay'] },
    'core-boot': { nativeCapabilities: true, mainClass: 'probe.CoreBootProbe', category: 'browser-core', browserOnly: true, webgl: true, memory: true, joml: true, fieldHandles: true, resources: true, workerProcess: true, nativeLibraries: true, regex: true, watchService: true, cases: 1, comparisons: 4, symbols: ['Core::<clinit>'] },
    'core-webgl': { nativeCapabilities: true, mainClass: 'probe.CoreBoundaryProbe', compileOnly: true, watchService: true, webgl: true, memory: true, joml: true, fieldHandles: true, resources: true, workerProcess: true, nativeLibraries: true, regex: true, symbols: ['Core::<clinit>'] },
    season: { mainClass: 'probe.SeasonBoundaryProbe', compileOnly: true, symbols: ['ErosionSeason::<init>'] },
    core: { mainClass: 'probe.CoreBoundaryProbe', compileOnly: true, symbols: ['Core::<clinit>'] },
};

probes['reflection-manifest'] = { ...probes['reflection-exposure'], reflectionExposure: false, reflectionManifest: 'game-version' };
probes['reflection-vectors'] = { ...probes['reflection-manifest'], mainClass: 'probe.ReflectionVectorDirectionProbe', reflectionManifest: 'vectors', cases: 5, comparisons: 10 };
probes['game-lua-exposure'] = { ...probes['lua-manager-init'], reflectionManifest: 'all' };
probes['game-lua-exposure-fast'] = { ...probes['game-lua-exposure'], fastAnalysis: true };
probes['season-bootstrap'] = { ...probes['standard-environment'], mainClass: 'probe.SeasonBootstrapProbe', category: 'browser-core', threadGroups: true, assetProfile: 'sandbox', cases: 5, comparisons: 26 };
probes['menu-png'] = { ...probes['standard-environment'], mainClass: 'probe.MenuPngProbe', category: 'browser-assets', assetProfile: 'menu-image', cases: 3, comparisons: 8 };
probes['menu-png'].inflater = true;
probes['image-texture'] = { ...probes['menu-png'], mainClass: 'probe.ImageTextureProbe', category: 'browser-core', cases: 2, comparisons: 8 };
probes['default-shader'] = { ...probes['standard-environment'], mainClass: 'probe.DefaultShaderProbe', category: 'browser-core', assetProfile: 'default-shader', cases: 3, comparisons: 10 };
probes['sprite-renderer'] = { ...probes['default-shader'], mainClass: 'probe.SpriteRendererProbe', assetProfile: 'sprite-renderer', inflater: true, webglVbo: true, cases: 5, comparisons: 14 };
probes['gpu-buffers'] = { ...probes['native-capabilities'], mainClass: 'probe.BufferBackendProbe', category: 'browser-core', memory: true, cases: 2, comparisons: 8 };
probes.inflater = { mainClass: 'probe.InflaterProbe', category: 'runtime-compatibility', inflater: true, cases: 8, comparisons: 16, classes: [], symbols: [] };
probes['output-channel'] = { mainClass: 'probe.FileOutputChannelProbe', category: 'runtime-compatibility', outputChannels: true, cases: 8, comparisons: 16, classes: [], symbols: [] };
probes['game-boot'] = { ...probes['lua-manager-init'], mainClass: 'zombie.gameStates.MainScreenState', keyboard: true, symbols: ['MainScreenState::main'] };

if (!Object.hasOwn(probes, probeName)) {
    throw new Error(`Unknown probe: ${probeName}`);
}

const probe = probes[probeName];

if (probe.compileOnly && !values['compile-only']) {
    throw new Error('This boundary is not qualified for execution. Use --compile-only.');
}

const outputDir = join('target', probeName);
const prerequisiteKeys = ['game-jar', 'jdk', 'maven-home', ...(!values['compile-only'] ? [...(!probe.browserOnly ? ['java'] : []), 'browser'] : [])];

if (probe.assets) {
    prerequisiteKeys.push('media-root');
}

for (const key of prerequisiteKeys) {
    if (!values[key]) {
        throw new Error(`Required explicit prerequisite: --${key}`);
    }
}

const paths = Object.fromEntries(Object.entries(values).filter(([key]) => !['probe', 'compile-only'].includes(key)).map(([key, value]) => [key, resolve(value)]));
const java = join(paths.jdk, 'bin', 'java.exe');
const evidence = {
    schema: 1, pass: false, probe: probeName, category: probe.category || 'original-code', compiler: 'TeaVM 0.16.0', backend: 'WEBASSEMBLY_GC',
    rule: 'exact-f32-raw-bits', measurement: 'performance.now before loader until loader resolves; includes fetch, compilation, instantiation and initialization; excludes loader JS and baseline fetch',
    prerequisites: paths, errors: [],
};
let browser;
let server;

/**
 * Hashes an input or generated artifact without buffering the whole file.
 *
 * @param {string} path - File whose bytes identify the current run.
 * @returns {Promise<string>} SHA-256 hexadecimal digest.
 */
async function sha256(path) {
    const hash = createHash('sha256');

    for await (const chunk of createReadStream(path)) {
        hash.update(chunk);
    }

    return hash.digest('hex');
}

/**
 * Runs one bounded build or JVM command and preserves its diagnostic output.
 *
 * @param {string} label - Evidence log name and output contract.
 * @param {string} executable - Explicit tool executable.
 * @param {string[]} args - Literal process arguments.
 * @returns {Promise<string>} Requested process output after successful completion.
 */
async function run(label, executable, args) {
    const result = spawnSync(executable, args, {
        encoding: 'utf8', timeout: 300_000,
        maxBuffer: 32 * 1_024 * 1_024, windowsHide: true,
        env: { ...process.env, JAVA_HOME: paths.jdk },
    });

    await writeFile(join(outputDir, `${label}.log`), (result.stdout || '') + (result.stderr || ''));

    if (result.error || result.status !== 0) {
        throw new Error(`${label} failed: ${result.error?.message || result.status}; see ${join(outputDir, `${label}.log`)}`);
    }

    return ['baseline', 'resource-index', 'package-metadata'].includes(label) ? (result.stdout || '') : (result.stdout || '') + (result.stderr || '');
}

// Decode only the standard WASM name section. This is metadata, not a VM.
/**
 * Extracts function names from the standard WebAssembly name section.
 *
 * @param {Buffer} bytes - Compiled WebAssembly module.
 * @returns {string[]} Retained function names in section order.
 */
function functionNames(bytes) {
    let p = 8;
    /**
     * Decodes one unsigned LEB128 value at the shared cursor.
     *
     * @returns {number} Decoded unsigned integer.
     */
    const number = () => {
        let n = 0;
        let shift = 0;
        let b;

        do {
            b = bytes[p++];
            n |= (b & 127) << shift;
            shift += 7;
        } while (b & 128);

        return n >>> 0;
    };

    /**
     * Reads a length-prefixed UTF-8 name at the shared cursor.
     *
     * @returns {string} Decoded name.
     */
    const text = () => {
        const length = number();
        const value = bytes.toString('utf8', p, p + length);

        p += length;

        return value;
    };

    const names = [];

    while (p < bytes.length) {
        const section = bytes[p++];
        const sectionLength = number();
        const end = p + sectionLength;

        if (section !== 0 || text() !== 'name') {
            p = end;
            continue;
        }

        while (p < end) {
            const type = bytes[p++];
            const length = number();
            const subEnd = p + length;

            if (type !== 1) {
                p = subEnd;
                continue;
            }

            const count = number();

            for (let i = 0; i < count; i++) {
                number();
                names.push(text());
            }

            p = subEnd;
        }

        p = end;
    }

    return names;
}

/**
 * Records the verified original members for one retained reflection class.
 *
 * @param {string[]} lines - Manifest records being assembled.
 * @param {string} name - Binary class name.
 * @param {object} cls - Parsed original class inventory.
 */
function appendReflectionRecords(lines, name, cls) {
    if (!cls || !Array.isArray(cls.methods) || !Array.isArray(cls.fields)) {
        throw new Error(`Incomplete reflection inventory: ${name}`);
    }

    if (cls.origin === 'jdk-resource') {
        lines.push(`J\t${name}`);

        for (const method of cls.declaredPublicMethodCandidates) {
            lines.push(`M\t${name}\t${method}`);
        }

        for (const field of cls.declaredPublicFieldCandidates) {
            lines.push(`F\t${name}\t${field.split(':')[0]}`);
        }

        return;
    }

    if (cls.origin !== 'original-jar') {
        throw new Error(`Unknown reflection inventory origin: ${name}`);
    }

    for (const method of cls.methods) {
        if (method.name !== '<clinit>') {
            lines.push(`M\t${name}\t${method.name}${method.descriptor}`);
        }
    }

    for (const field of cls.fields) {
        lines.push(`F\t${name}\t${field.name}`);
    }
}

/**
 * Checks one physical key's original press, hold, release and idle transitions.
 *
 * @param {import('playwright-core').Page} page - Owned browser probe page.
 * @param {string} physical - Browser key name.
 * @param {number} original - Original game's key code.
 * @param {boolean} gameInput - Whether to check original cached transitions as well.
 * @returns {Promise<object>} Observed key states for persisted evidence.
 */
async function checkKeyboardKey(page, physical, original, gameInput) {
    await page.keyboard.down(physical);
    const pressed = await page.evaluate((key) => globalThis.queryOriginalKey(key), original);

    if (gameInput) {
        const edge = await page.evaluate((key) => globalThis.queryOriginalState(key), original);

        await page.evaluate(() => globalThis.advanceOriginalInput(1));
        const held = await page.evaluate((key) => globalThis.queryOriginalState(key), original);

        if (edge !== 3 || held !== 1) {
            throw new Error(`Original press/held transition differs: ${physical}`);
        }
    }

    await page.keyboard.up(physical);
    const released = await page.evaluate((key) => globalThis.queryOriginalKey(key), original);

    if (gameInput) {
        const edge = await page.evaluate((key) => globalThis.queryOriginalState(key), original);

        await page.evaluate(() => globalThis.advanceOriginalInput(1));
        const idle = await page.evaluate((key) => globalThis.queryOriginalState(key), original);

        if (edge !== 4 || idle !== 0) {
            throw new Error(`Original release/idle transition differs: ${physical}`);
        }
    }

    if (pressed !== 1 || released !== 0) {
        throw new Error(`Original keyboard did not follow DOM input: ${physical}`);
    }

    return { physical, original, pressed, released };
}

/**
 * Compares original Java file reads with the verified host mount byte for byte by hash.
 *
 * @param {{manifest: object[], files: Map<string, Buffer>}} assets - Verified installed asset selection.
 * @param {object} result - Original browser probe results.
 */
function verifyMountedAssets(assets, result) {
    for (const entry of assets.manifest) {
        const item = result.actual?.cases.find((candidate) => candidate.id === entry.path);
        let hash = 1;

        for (const value of assets.files.get(entry.path)) {
            // Java content hashes require signed 32-bit wrapping, not truncation.
            // eslint-disable-next-line unicorn/prefer-math-trunc
            hash = (Math.imul(31, hash) + (value > 127 ? value - 256 : value)) | 0;
        }

        if (item?.outputs.size.value !== entry.size || item?.outputs.contentHash.value !== hash) {
            throw new Error('Mounted Java file differs from the verified host bytes');
        }
    }
}

try {
    // Remove only this runner's generated directory. Never clean an input tree.
    const output = resolve(outputDir);

    for (const path of Object.values(paths)) {
        if (path.toLowerCase() === output.toLowerCase() || path.toLowerCase().startsWith(`${output.toLowerCase()}\\`)) {
            throw new Error('Prerequisites must remain outside target');
        }
    }

    await rm(output, { recursive: true, force: true });
    await mkdir(output, { recursive: true });
    evidence.jarSha256Before = await sha256(paths['game-jar']);
    evidence.executionRequested = !values['compile-only'];

    if (evidence.executionRequested && !probe.browserOnly) {
        evidence.jvmVersion = (await run('jvm-version', paths.java, ['-version'])).trim();
    }

    evidence.jdkVersion = (await run('jdk-version', java, ['-version'])).trim();
    let reflectionManifestPath;
    let reflectionGenericNames = [];

    if (probe.reflectionManifest) {
        const inventoryPath = join(outputDir, 'exposure-inventory.json');

        await run('exposure-inventory', java, ['tools/ExposureManifestTool.java', paths['game-jar'], inventoryPath]);
        const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));

        if (inventory.jarSha256 !== evidence.jarSha256Before) {
            throw new Error('Reflection inventory original JAR hash differs');
        }

        let selected = probe.reflectionManifest === 'game-version'
            ? ['java.lang.Object', 'zombie.core.GameVersion']
            : Object.keys(inventory.classes).sort();
        const nameOnly = probe.reflectionManifest === 'vectors' ? ['java.lang.String', 'java.lang.CloneNotSupportedException'] : [];

        if (probe.reflectionManifest === 'vectors') {
            const hierarchy = new Set();
            /**
             * Includes an original exposed class and its complete inheritance chain.
             *
             * @param {string|null} name - Original metadata class name, if present.
             */
            const visit = (name) => {
                if (!name || hierarchy.has(name)) {
                    return;
                }

                const cls = inventory.classes[name];

                if (!cls) {
                    throw new Error(`Missing vector exposure hierarchy metadata: ${name}`);
                }

                hierarchy.add(name);
                visit(cls.superclass);

                for (const parent of cls.interfaces) {
                    visit(parent);
                }
            };

            for (const root of ['zombie.core.GameVersion', 'zombie.iso.Vector2', 'zombie.iso.IsoDirections']) {
                visit(root);
            }

            selected = [...hierarchy].sort();
        }

        reflectionGenericNames = [...new Set([...selected, ...nameOnly])];
        const lines = reflectionGenericNames.map((name) => `C\t${name}`);

        for (const name of nameOnly) {
            if (!selected.includes(name)) {
                lines.push(`J\t${name}`);
            }
        }

        for (const name of selected) {
            appendReflectionRecords(lines, name, inventory.classes[name]);
        }

        reflectionManifestPath = resolve(outputDir, 'reflection-manifest.tsv');
        await writeFile(reflectionManifestPath, `${lines.join('\n')}\n`);
        evidence.reflectionManifest = {
            path: reflectionManifestPath, sha256: await sha256(reflectionManifestPath),
            scope: probe.reflectionManifest, classes: reflectionGenericNames.length, nameOnlyClasses: nameOnly, records: lines.length,
            inventoryStats: inventory.stats, originalJdkPublicApiOnly: true,
        };
    }

    const boot = (await readdir(join(paths['maven-home'], 'boot'))).filter((name) => /^plexus-classworlds-.*\.jar$/.test(name));

    if (boot.length !== 1) {
        throw new Error('Expected one Maven classworlds boot JAR');
    }

    const mavenArgs = ['-Xss16m', `-Dport.threadGroups=${!!probe.threadGroups}`, `-Dport.generics=${!!probe.generics}`, `-Dport.reflectionExposure=${!!probe.reflectionExposure}`, `-Dport.browserKeyboard=${!!probe.keyboard}`, `-Dport.nativeCapabilities=${!!probe.nativeCapabilities}`, `-Dport.watchService=${!!probe.watchService}`, `-Dport.webgl=${!!probe.webgl}`, `-Dport.webglVbo=${!!probe.webglVbo}`, `-Dport.browserMemory=${!!probe.memory}`, `-Dport.joml=${!!probe.joml}`, `-Dport.fieldHandles=${!!probe.fieldHandles}`, `-Dport.resources=${!!probe.resources}`, `-Dport.regex=${!!probe.regex}`, `-Dport.workerProcess=${!!probe.workerProcess}`, `-Dport.nativeLibraries=${!!probe.nativeLibraries}`, `-Dmaven.home=${paths['maven-home']}`, `-Dmaven.multiModuleProjectDirectory=${resolve('.')}`,
        `-Dclassworlds.conf=${join(paths['maven-home'], 'bin', 'm2.conf')}`,
        '-cp', join(paths['maven-home'], 'boot', boot[0]), 'org.codehaus.plexus.classworlds.launcher.Launcher',
        `-Dprobe.mainClass=${probe.mainClass}`, `-Dprobe.output=${output}`];

    if (reflectionManifestPath) {
        mavenArgs.unshift(`-Dport.reflectionManifest=${reflectionManifestPath}`);
    }

    if (probe.fastAnalysis) {
        mavenArgs.unshift('-Dteavm.fastGlobalAnalysis=true');
    }

    mavenArgs.unshift(`-Dport.inflater=${!!probe.inflater}`);
    mavenArgs.unshift(`-Dport.outputChannels=${!!probe.outputChannels}`);
    evidence.fastGlobalAnalysis = !!probe.fastAnalysis;
    evidence.mavenVersion = (await run('maven-version', java, [...mavenArgs, '--version'])).trim();
    await run('compile-adapter', java, [...mavenArgs, '-B', `-Dmaven.repo.local=${resolve('.m2')}`,
        `-Dgame.jar=${paths['game-jar']}`, 'compiler:compile']);
    await run('compile-wasm', java, [...mavenArgs, '-B', `-Dmaven.repo.local=${resolve('.m2')}`,
        `-Dgame.jar=${paths['game-jar']}`, 'process-classes']);
    const wasm = await readFile(join(outputDir, 'wasm/probe.wasm'));

    if (wasm.subarray(0, 4).toString('hex') !== '0061736d') {
        throw new Error('Compiler did not emit WASM');
    }

    evidence.wasmBytes = wasm.length;
    evidence.wasmSha256 = createHash('sha256').update(wasm).digest('hex');
    evidence.originalSymbols = functionNames(wasm).filter((name) => name.startsWith('zombie.'));

    if (probe.vendorSymbols) {
        evidence.vendorSymbols = functionNames(wasm).filter((name) => name.startsWith('org.joml.'));

        if (!probe.vendorSymbols.every((symbol) => evidence.vendorSymbols.some((name) => name.includes(symbol)))) {
            throw new Error('Expected original vendor method symbols absent from WASM');
        }
    }

    if (!probe.symbols.every((symbol) => evidence.originalSymbols.some((name) => name.includes(symbol)))) {
        throw new Error('Expected original method symbols absent from WASM name section');
    }

    evidence.sourceMapSources = JSON.parse(await readFile(join(outputDir, 'wasm/probe.wasm.map'), 'utf8')).sources;
    evidence.compilationSucceeded = true;

    if (evidence.executionRequested) {
        if (!probe.browserOnly) {
            const baselineText = await run('baseline', paths.java, [`-Xlog:class+load=info:file=${join(outputDir, 'baseline-classload.log').replaceAll('\\', '/')}`,
                '-cp', [join(outputDir, 'classes'), paths['game-jar']].join(delimiter), probe.mainClass]);
            const baseline = JSON.parse(baselineText.trim());
            const classLog = await readFile(join(outputDir, 'baseline-classload.log'), 'utf8');

            evidence.loadedGameClasses = [...classLog.matchAll(/\[class,load] (zombie\.[^ ]+) source:/g)].map((match) => match[1]).sort();

            if (JSON.stringify(evidence.loadedGameClasses) !== JSON.stringify([...probe.classes].sort())) {
                throw new Error('JVM game-class closure differs from the inspected probe contract');
            }

            if (baseline.cases.length !== probe.cases || baseline.cases.reduce((n, c) => n + Object.keys(c.outputs).length, 0) !== probe.comparisons) {
                throw new Error('Baseline case/output count differs from the selected probe contract');
            }

            evidence.rule = baseline.rule;
            await writeFile(join(outputDir, 'baseline.json'), `${JSON.stringify(baseline, null, 2)}\n`);
        } else {
            evidence.rule = {
                'browser-graphics': 'framebuffer-readback-and-WebGL-errors',
                'browser-process': 'owned-worker-exit',
                'browser-memory': 'direct-memory-contract',
            }[probe.category] || `${probe.category}-contract`;
            evidence.jvmBaselineExecuted = false;
            evidence.measurement = `Browser-only ${probe.category} assertions; no native JVM baseline or timing benchmark`;
        }

        let resourceNames;
        const resourceToolArgs = ['-cp', join(outputDir, 'classes'), 'port.tool.ResourceTool', paths['game-jar']];

        if (probe.resources) {
            const encodedNames = await run('resource-index', java, [...resourceToolArgs, 'list']);

            resourceNames = new Set(encodedNames.trim().split(/\r?\n/).filter(Boolean).map((name) => Buffer.from(name, 'base64').toString('utf8')));
            const encodedMetadata = await run('package-metadata', java, [...resourceToolArgs, 'packages']);
            const packageMetadata = encodedMetadata.split(/\r?\n/).filter(Boolean).map((line) => line.split('\t').map((value) => Buffer.from(value, 'base64').toString('utf8')));
            const packages = [...new Set([...resourceNames].filter((name) => name.endsWith('.class') && !name.startsWith('META-INF/') && name.includes('/'))
                .map((name) => name.slice(0, name.lastIndexOf('/')).replaceAll('/', '.')))];

            await writeFile(join(outputDir, 'resource-host.js'), `window.portResources = new Set(${JSON.stringify([...resourceNames])});\nwindow.portPackageMetadata = new Map(${JSON.stringify(packageMetadata)});\nwindow.portArchivePackages = new Set(${JSON.stringify(packages)});\n`);
            evidence.classpathResourceCount = resourceNames.size;
        }

        let fixture = probeName;

        if (probe.worker) {
            fixture = 'graphics';
        } else if (probe.category === 'browser-core') {
            fixture = 'engine';
        }

        const fixturePath = probe.browserOnly ? `src/main/webapp/${probe.fixture || fixture}.html` : 'src/main/webapp/index.html';
        const routes = new Map([
            ['/', [fixturePath, 'text/html; charset=utf-8']],
            ['/graphics-worker.js', ['src/main/webapp/graphics-worker.js', 'text/javascript']],
            ['/keyboard-worker.js', ['src/main/webapp/keyboard-worker.js', 'text/javascript']],
            ['/engine-worker.js', ['src/main/webapp/engine-worker.js', 'text/javascript']],
            ['/exit-worker.js', ['src/main/webapp/exit-worker.js', 'text/javascript']],
            ['/save-host.js', ['src/main/webapp/save-host.js', 'text/javascript']],
            ['/resource-host.js', [join(outputDir, 'resource-host.js'), 'text/javascript']],
            ['/generic-host.js', [join(outputDir, 'generic-host.js'), 'text/javascript']],
            ['/baseline.json', [join(outputDir, 'baseline.json'), 'application/json']],
            ['/wasm/probe.wasm', [join(outputDir, 'wasm/probe.wasm'), 'application/wasm']],
            ['/wasm/classes.wasm-runtime.js', [join(outputDir, 'wasm/classes.wasm-runtime.js'), 'text/javascript']],
            ['/favicon.ico', [null, 'image/x-icon']],
        ]);
        let genericMetadata = {};

        if (probe.generics) {
            const names = [...new Set([...reflectionGenericNames, 'zombie.core.GameVersion', 'java.lang.Object', 'probe.GenericProbe', 'probe.GenericProbe$Base',
                'probe.GenericProbe$Concrete', 'probe.GenericProbe$Variable', 'probe.GenericProbe$Throws', 'probe.GenericProbe$Plain'])];
            const namesPath = join(outputDir, 'generic-names.txt');

            await writeFile(namesPath, `${names.join('\n')}\n`);
            await run('generic-metadata', java, ['tools/GenericMetadataTool.java', paths['game-jar'],
                join(outputDir, 'classes'), join(outputDir, 'generic-metadata.json'), `@${namesPath}`]);
            genericMetadata = JSON.parse(await readFile(join(outputDir, 'generic-metadata.json'), 'utf8'));

            if (!Object.values(genericMetadata).every((value) => typeof value === 'string')) {
                throw new Error('Invalid generic metadata');
            }

            evidence.genericMetadataKeys = Object.keys(genericMetadata).length;
        }

        await writeFile(join(outputDir, 'generic-host.js'), `globalThis.portGenericMetadata = ${JSON.stringify(genericMetadata)};\n`);
        const assets = probe.assets ? await loadAssets(paths['media-root'], probe.assetProfile || probe.standardLibrary) : { manifest: [], files: new Map() };

        if (probe.assets) {
            evidence.assets = assets.manifest;
        }

        server = createServer(async (request, response) => {
            if (request.url === '/asset-manifest.json') {
                if (request.method !== 'GET') {
                    response.writeHead(405);
                    response.end();

                    return;
                }

                response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
                response.end(JSON.stringify(assets.manifest));

                return;
            }

            if (request.url.startsWith('/asset?')) {
                const name = new URL(request.url, 'http://127.0.0.1').searchParams.get('path');
                const bytes = assets.files.get(name);

                if (request.method !== 'GET' || !bytes) {
                    response.writeHead(404);
                    response.end();

                    return;
                }

                response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
                response.end(bytes);

                return;
            }

            if (resourceNames && request.url.startsWith('/classpath?')) {
                const name = new URL(request.url, 'http://127.0.0.1').searchParams.get('name');

                if (request.method !== 'GET' || !resourceNames.has(name)) {
                    response.writeHead(404);
                    response.end();

                    return;
                }

                const result = spawnSync(java, [...resourceToolArgs, 'read', name], { timeout: 30_000, maxBuffer: 64 * 1_024 * 1_024, windowsHide: true });

                if (result.error || result.status !== 0) {
                    response.writeHead(500);
                    response.end('Archive read failed');

                    return;
                }

                response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
                response.end(result.stdout);

                return;
            }

            const route = routes.get(request.url.split('?')[0]);

            if (!route) {
                response.writeHead(404);
                response.end();

                return;
            }

            try {
                let body = route[0] ? await readFile(route[0]) : Buffer.alloc(0);

                if (probeName === 'sprite-renderer' && request.url === '/') {
                    body = Buffer.from(body.toString('utf8').replace('width="96" height="96"', 'width="128" height="128"'));
                }

                if (probe.generics && request.url === '/') {
                    body = Buffer.from(body.toString('utf8').replace('<script src="/wasm/', '<script src="/generic-host.js"></script>\n<script src="/wasm/'));
                }

                if (probe.resources && request.url === '/') {
                    body = Buffer.from(body.toString('utf8').replace('<script src="/wasm/', '<script src="/resource-host.js"></script>\n<script src="/wasm/'));
                }

                response.writeHead(200, { 'Content-Type': route[1], 'Cache-Control': 'no-store' });
                response.end(body);
            } catch (error) {
                response.writeHead(500);
                response.end(String(error));
            }
        });
        await new Promise((accept, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', accept);
        });
        browser = await chromium.launch({ executablePath: paths.browser, headless: true });
        evidence.browserVersion = browser.version();
        const page = await browser.newPage();
        let pageLoads = 0;

        page.on('framenavigated', (frame) => {
            if (frame === page.mainFrame()) {
                pageLoads++;
            }
        });
        const browserErrors = [];

        page.on('pageerror', (error) => browserErrors.push(String(error)));
        page.on('console', (message) => {
            if (message.type() === 'error') {
                browserErrors.push(message.text());
            }
        });
        page.on('requestfailed', (request) => browserErrors.push(`${request.url()}: ${request.failure()?.errorText}`));
        let query = probe.gameInput ? '?game-input' : '';

        if (probe.worker) {
            query = '?worker';
        }

        await page.goto(`http://127.0.0.1:${server.address().port}/${query}`, { waitUntil: 'load', timeout: 30_000 });
        await page.waitForFunction(() => globalThis.probeResult !== undefined, null, { timeout: 30_000 });

        if (probe.category === 'browser-graphics' && await page.evaluate(() => globalThis.probeResult.pass)) {
            await page.locator('#red').fill('127');
            await page.locator('#green').fill('64');
            await page.locator('#blue').fill('255');
            await page.locator('#brightness').fill('75');
            await page.waitForFunction(() => JSON.parse(document.getElementById('details').textContent).pixels?.join(',') === '95,48,191,191', null, { timeout: 10_000 });
            const rendered = JSON.parse(await page.locator('#details').textContent());

            if (JSON.stringify(rendered.pixels) !== JSON.stringify([95, 48, 191, 191]) || rendered.error !== 0) {
                throw new Error('Browser input did not produce the expected original Color framebuffer');
            }

            evidence.interactiveFramebuffer = rendered;
        }

        evidence.browser = await page.evaluate(() => globalThis.probeResult);
        evidence.visibleStatus = await page.locator('#status').textContent();
        evidence.browserErrors = browserErrors;
        evidence.browserPageLoads = pageLoads;

        if (probeName === 'keyboard' || probe.gameInput) {
            const states = [];

            for (const [physical, original] of [['KeyW', 17], ['KeyA', 30], ['KeyS', 31], ['KeyD', 32], ['ArrowUp', 200], ['ArrowLeft', 203], ['ShiftLeft', 42], ['Space', 57]]) {
                // Each key must finish its release transition before the next key is pressed.
                // eslint-disable-next-line no-await-in-loop
                states.push(await checkKeyboardKey(page, physical, original, probe.gameInput));
            }

            await page.keyboard.down('KeyW');
            await page.keyboard.down('KeyA');
            const chord = await page.evaluate(async () => [await globalThis.queryOriginalKey(17), await globalThis.queryOriginalKey(30)]);

            await page.locator('#leave-input').click();
            const cleared = await page.evaluate(async () => [await globalThis.queryOriginalKey(17), await globalThis.queryOriginalKey(30)]);

            await page.keyboard.up('KeyW');
            await page.keyboard.up('KeyA');

            if (JSON.stringify(chord) !== '[1,1]' || JSON.stringify(cleared) !== '[0,0]') {
                throw new Error('Original keyboard chord or blur state differs');
            }

            evidence.liveKeyboard = { states, chord, cleared, actualDomInput: true };
        }

        await writeFile(join(outputDir, 'browser.json'), `${JSON.stringify(evidence.browser, null, 2)}\n`);

        if (!evidence.browser.pass) {
            throw new Error(`Browser execution failed; see ${join(outputDir, 'browser.json')}`);
        }

        if (probeName === 'menu-png' || probeName === 'image-texture') {
            const reference = await page.evaluate(async (padded) => {
                const response = await fetch(`/asset?path=${encodeURIComponent('/media/ui/avatarBackgroundWhite.png')}`);

                if (!response.ok) {
                    throw new Error('Menu PNG reference fetch failed');
                }

                const image = await createImageBitmap(new Blob([await response.arrayBuffer()], { type: 'image/png' }),
                    { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });

                try {
                    const width = padded ? 128 : image.width;
                    const height = padded ? 128 : image.height;
                    const canvas = new OffscreenCanvas(width, height);
                    const context = canvas.getContext('2d');

                    context.drawImage(image, 0, 0);
                    let hash = 1;

                    for (const value of context.getImageData(0, 0, width, height).data) {
                        // Java content hashes require signed 32-bit wrapping, not truncation.
                    // eslint-disable-next-line unicorn/prefer-math-trunc
                        hash = (Math.imul(31, hash) + (value > 127 ? value - 256 : value)) | 0;
                    }

                    return { width: image.width, height: image.height, ...(padded ? { widthHw: width, heightHw: height } : {}), pixelHash: hash };
                } finally {
                    image.close();
                }
            }, probeName === 'image-texture');
            const decoded = evidence.browser.actual.cases.find((item) => item.id
                === (probeName === 'image-texture' ? 'original-image-texture-upload' : 'original-png-decoder')).outputs;

            if (Object.entries(reference).some(([name, value]) => decoded[name]?.value !== value)) {
                throw new Error('Original PNG decoder differs from independent browser decoding');
            }

            evidence.independentPngDecode = reference;
        }

        if (probe.assets) {
            verifyMountedAssets(assets, evidence.browser);
            const deniedPaths = ['/media/../projectzomboid.jar', '../save', '/media/unlisted.lua'];
            const denials = await Promise.all(deniedPaths.map((name) => page.request.get(`http://127.0.0.1:${server.address().port}/asset?path=${encodeURIComponent(name)}`)));

            if (denials.some((response) => response.status() !== 404)) {
                throw new Error('Asset allowlist accepted an unknown path');
            }

            if ((await page.request.post(`http://127.0.0.1:${server.address().port}/asset-manifest.json`)).status() !== 405) {
                throw new Error('Asset manifest accepted a write request');
            }

            const after = await loadAssets(paths['media-root'], probe.assetProfile || probe.standardLibrary);

            if (JSON.stringify(after.manifest) !== JSON.stringify(assets.manifest)) {
                throw new Error('Installed asset changed during probe');
            }

            evidence.assetBoundaryChecks = { exactJavaBytes: true, rejectedUnknownPaths: 3, rejectedWrite: true, installedInputsUnchanged: true };
        }

        if (probe.category === 'browser-graphics' && (!evidence.browser.webgl2 || evidence.browser.errors.length || !evidence.interactiveFramebuffer)) {
            throw new Error('Expected real WebGL2 and verified browser input');
        }

        if (probe.category === 'browser-graphics' && !evidence.browser.actual.cases.every((result) => result.originalParameter && result.shaderDraw)) {
            throw new Error('Expected original ShaderParameter dispatch and real shader drawing');
        }

        if (probe.worker && !evidence.browser.workerMode) {
            throw new Error('Expected dedicated worker execution');
        }

        if (probeName === 'memory' && (!evidence.browser.linearMemory || evidence.browser.allocationsRemaining !== 0)) {
            throw new Error('Expected real linear-memory checks and no retained allocations');
        }

        if (probeName === 'exit' && (!evidence.browser.worker || !evidence.browser.workerTerminated || !evidence.browser.wasmInstance || evidence.browser.exitCode !== 7 || evidence.browser.observationMs < 200)) {
            throw new Error('Expected owned-worker termination and post-exit observation');
        }

        if (probeName === 'colors' && !evidence.browser.directExport) {
            throw new Error('Expected direct JavaScript color export execution');
        }

        if (probeName === 'browser-save' && (pageLoads !== 8 || evidence.browser.hostStorage?.pageLoads !== 8 || evidence.browser.hostStorage?.writes !== 8 || evidence.browser.hostStorage?.readbacks !== 8)) {
            throw new Error('Expected eight original-state OPFS cycles across fresh page loads');
        }

        if (evidence.browser.hostStorage) {
            evidence.measurement = 'Initialization sums eight module fetch/compile/instantiate/load calls; execution sums original adapter calls plus OPFS write/readback; excludes navigation and loader JS downloads';
        }

        if (!evidence.browser.pass || browserErrors.length || evidence.browser.cases !== probe.cases
            || evidence.browser.comparisons !== probe.comparisons || !evidence.visibleStatus.startsWith('PASS')) {
            throw new Error(`Browser comparison failed; see ${join(outputDir, 'browser.json')}`);
        }

        evidence.pass = true;
    }
} catch (error) {
    evidence.errors.push(String(error.stack || error));
    process.exitCode = 1;
} finally {
    if (evidence.reflectionManifest) {
        try {
            evidence.reflectionManifest.diagnostics = JSON.parse(await readFile(`${evidence.reflectionManifest.path}.diagnostics.json`, 'utf8'));
        } catch (error) {
            evidence.reflectionManifest.diagnosticsReadError = String(error);
        }
    }

    if (browser) {
        await browser.close().catch((error) => {
            evidence.errors.push(String(error));
            evidence.pass = false;
            process.exitCode = 1;
        });
    }

    if (server) {
        await new Promise((accept) => {
            server.close(accept);
        });
    }

    try {
        evidence.jarSha256After = await sha256(paths['game-jar']);

        if (evidence.jarSha256Before !== evidence.jarSha256After) {
            evidence.errors.push('Original JAR changed');
            evidence.pass = false;
            process.exitCode = 1;
        }
    } catch (error) {
        evidence.errors.push(String(error));
        evidence.pass = false;
        process.exitCode = 1;
    }

    evidence.ownedBrowserClosed = !browser || !browser.isConnected();
    evidence.ownedServerClosed = !server || !server.listening;
    evidence.recordedAt = new Date().toISOString();
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, 'comparison.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    console.info(JSON.stringify({
        pass: evidence.pass, compilationSucceeded: evidence.compilationSucceeded || false,
        executionRequested: evidence.executionRequested, cases: evidence.browser?.cases || 0,
        comparisons: evidence.browser?.comparisons || 0, matched: evidence.browser?.matched || 0,
        mismatches: evidence.browser?.mismatches || [], errors: evidence.errors,
        evidence: join(outputDir, 'comparison.json'),
    }, null, 2));
}
