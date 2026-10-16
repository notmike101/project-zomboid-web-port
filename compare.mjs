import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {resolve, join, delimiter} from 'node:path';
import {parseArgs} from 'node:util';
import {chromium} from 'playwright-core';

const {values} = parseArgs({options: {...Object.fromEntries(
    ['game-jar', 'java', 'jdk', 'maven-home', 'browser', 'probe'].map(key => [key, {type: 'string'}])),
    'compile-only': {type: 'boolean', default: false}}});
const probeName = values.probe || 'angles';
const probes = {
    angles: {mainClass: 'probe.AngleProbe', cases: 8, comparisons: 16,
        classes: ['zombie.core.math.PZMath'],
        symbols: ['PZMath::lerpAngle', 'PZMath::getClosestAngle']},
    weather: {mainClass: 'probe.WeatherProbe', cases: 16, comparisons: 40,
        classes: ['zombie.iso.weather.SimplexNoise', 'zombie.iso.weather.SimplexNoise$Grad', 'zombie.iso.weather.fx.SteppedUpdateFloat'],
        symbols: ['SteppedUpdateFloat::update', 'SteppedUpdateFloat::setTarget', 'SimplexNoise::noise']},
    airfront: {mainClass: 'probe.AirFrontProbe', cases: 8, comparisons: 112,
        classes: ['zombie.iso.weather.ClimateManager$AirFront'],
        symbols: ['ClimateManager$AirFront::addDaySample', 'ClimateManager$AirFront::save', 'ClimateManager$AirFront::load']},
    erosion: {mainClass: 'probe.ErosionProbe', cases: 16, comparisons: 16,
        classes: ['zombie.erosion.utils.Noise2D', 'zombie.erosion.utils.Noise2D$Layer'],
        symbols: ['Noise2D::addLayer', 'Noise2D::layeredNoise', 'Noise2D::reset']},
    colors: {mainClass: 'probe.ColorProbe', cases: 8, comparisons: 128,
        classes: ['zombie.core.Color', 'zombie.core.math.PZMath', 'zombie.iso.weather.ClimateColorInfo'],
        symbols: ['ClimateColorInfo::interp', 'ClimateColorInfo::scale', 'ClimateColorInfo::save', 'ClimateColorInfo::load']},
    'browser-save': {mainClass: 'probe.BrowserSaveProbe', cases: 8, comparisons: 112,
        classes: ['zombie.iso.weather.ClimateManager$AirFront'],
        symbols: ['ClimateManager$AirFront::addDaySample', 'ClimateManager$AirFront::save', 'ClimateManager$AirFront::load']},
    reader: {mainClass: 'probe.ReaderProbe', category: 'runtime-compatibility', cases: 8, comparisons: 16,
        classes: [], symbols: []},
    paths: {mainClass: 'probe.PathProbe', category: 'runtime-compatibility', cases: 19, comparisons: 38,
        classes: [], symbols: []},
    linkage: {mainClass: 'probe.LinkageProbe', category: 'runtime-compatibility', cases: 8, comparisons: 16,
        classes: [], symbols: []},
    'legacy-string': {mainClass: 'probe.LegacyStringProbe', category: 'runtime-compatibility', cases: 16, comparisons: 32,
        classes: [], symbols: []},
    queue: {mainClass: 'probe.QueueProbe', category: 'runtime-compatibility', cases: 8, comparisons: 16,
        classes: [], symbols: []},
    'file-stream': {mainClass: 'probe.FileStreamProbe', category: 'runtime-compatibility', cases: 8, comparisons: 16,
        classes: [], symbols: []},
    graphics: {mainClass: 'probe.GraphicsProbe', category: 'browser-graphics', browserOnly: true, webgl: true,
        cases: 4, comparisons: 34, symbols: ['Color::scale']},
    'core-webgl': {mainClass: 'probe.CoreBoundaryProbe', compileOnly: true, webgl: true, symbols: ['Core::<clinit>']},
    season: {mainClass: 'probe.SeasonBoundaryProbe', compileOnly: true, symbols: ['ErosionSeason::<init>']},
    core: {mainClass: 'probe.CoreBoundaryProbe', compileOnly: true, symbols: ['Core::<clinit>']}
};
if (!Object.hasOwn(probes, probeName)) throw new Error('Unknown probe: ' + probeName);
const probe = probes[probeName];
if (probe.compileOnly && !values['compile-only']) throw new Error('This boundary is not qualified for execution. Use --compile-only.');
const outputDir = join('target', probeName);
const prerequisiteKeys = ['game-jar', 'jdk', 'maven-home', ...(!values['compile-only'] ? [...(!probe.browserOnly ? ['java'] : []), 'browser'] : [])];
for (const key of prerequisiteKeys) {
    if (!values[key]) throw new Error('Required explicit prerequisite: --' + key);
}
const paths = Object.fromEntries(Object.entries(values).filter(([key]) => !['probe', 'compile-only'].includes(key)).map(([key, value]) => [key, resolve(value)]));
const java = join(paths.jdk, 'bin', 'java.exe');
const evidence = {schema: 1, pass: false, probe: probeName, category: probe.category || 'original-code', compiler: 'TeaVM 0.16.0', backend: 'WEBASSEMBLY_GC',
    rule: 'exact-f32-raw-bits', measurement: 'performance.now before loader until loader resolves; includes fetch, compilation, instantiation and initialization; excludes loader JS and baseline fetch',
    prerequisites: paths, errors: []};
let browser;
let server;

async function sha256(path) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex');
}

async function run(label, executable, args) {
    const result = spawnSync(executable, args, {encoding: 'utf8', timeout: 300000,
        maxBuffer: 32 * 1024 * 1024, windowsHide: true,
        env: {...process.env, JAVA_HOME: paths.jdk}});
    await writeFile(join(outputDir, label + '.log'), (result.stdout || '') + (result.stderr || ''));
    if (result.error || result.status !== 0) throw new Error(label + ' failed: ' + (result.error?.message || result.status) + '; see ' + join(outputDir, label + '.log'));
    return (result.stdout || '') + (result.stderr || '');
}

// Decode only the standard WASM name section. This is metadata, not a VM.
function functionNames(bytes) {
    let p = 8;
    const number = () => { let n = 0, shift = 0, b; do { b = bytes[p++]; n |= (b & 127) << shift; shift += 7; } while (b & 128); return n >>> 0; };
    const text = () => { const length = number(); const value = bytes.toString('utf8', p, p + length); p += length; return value; };
    const names = [];
    while (p < bytes.length) {
        const section = bytes[p++];
        const sectionLength = number();
        const end = p + sectionLength;
        if (section === 0 && text() === 'name') {
            while (p < end) {
                const type = bytes[p++];
                const length = number();
                const subEnd = p + length;
                if (type === 1) {
                    const count = number();
                    for (let i = 0; i < count; i++) { number(); names.push(text()); }
                }
                p = subEnd;
            }
        }
        p = end;
    }
    return names;
}

try {
    // Remove only this runner's generated directory. Never clean an input tree.
    const output = resolve(outputDir);
    for (const path of Object.values(paths)) {
        if (path.toLowerCase() === output.toLowerCase() || path.toLowerCase().startsWith(output.toLowerCase() + '\\')) {
            throw new Error('Prerequisites must remain outside target');
        }
    }
    await rm(output, {recursive: true, force: true});
    await mkdir(output, {recursive: true});
    evidence.jarSha256Before = await sha256(paths['game-jar']);
    evidence.executionRequested = !values['compile-only'];
    if (evidence.executionRequested && !probe.browserOnly) evidence.jvmVersion = (await run('jvm-version', paths.java, ['-version'])).trim();
    evidence.jdkVersion = (await run('jdk-version', java, ['-version'])).trim();
    const boot = (await readdir(join(paths['maven-home'], 'boot'))).filter(name => /^plexus-classworlds-.*\.jar$/.test(name));
    if (boot.length !== 1) throw new Error('Expected one Maven classworlds boot JAR');
    const mavenArgs = ['-Dport.webgl=' + !!probe.webgl, '-Dmaven.home=' + paths['maven-home'], '-Dmaven.multiModuleProjectDirectory=' + resolve('.'),
        '-Dclassworlds.conf=' + join(paths['maven-home'], 'bin', 'm2.conf'),
        '-cp', join(paths['maven-home'], 'boot', boot[0]), 'org.codehaus.plexus.classworlds.launcher.Launcher',
        '-Dprobe.mainClass=' + probe.mainClass, '-Dprobe.output=' + output];
    evidence.mavenVersion = (await run('maven-version', java, [...mavenArgs, '--version'])).trim();
    await run('compile-adapter', java, [...mavenArgs, '-B', '-Dmaven.repo.local=' + resolve('.m2'),
        '-Dgame.jar=' + paths['game-jar'], 'compiler:compile']);
    await run('compile-wasm', java, [...mavenArgs, '-B', '-Dmaven.repo.local=' + resolve('.m2'),
        '-Dgame.jar=' + paths['game-jar'], 'process-classes']);
    const wasm = await readFile(join(outputDir, 'wasm/probe.wasm'));
    if (wasm.subarray(0, 4).toString('hex') !== '0061736d') throw new Error('Compiler did not emit WASM');
    evidence.wasmBytes = wasm.length;
    evidence.wasmSha256 = createHash('sha256').update(wasm).digest('hex');
    evidence.originalSymbols = functionNames(wasm).filter(name => name.startsWith('zombie.'));
    if (!probe.symbols.every(symbol => evidence.originalSymbols.some(name => name.includes(symbol)))) {
        throw new Error('Expected original method symbols absent from WASM name section');
    }
    evidence.sourceMapSources = JSON.parse(await readFile(join(outputDir, 'wasm/probe.wasm.map'), 'utf8')).sources;
    evidence.compilationSucceeded = true;
    if (evidence.executionRequested) {
    if (!probe.browserOnly) {
    const baselineText = await run('baseline', paths.java, ['-Xlog:class+load=info:file=' + join(outputDir, 'baseline-classload.log').replaceAll('\\', '/'),
        '-cp', [join(outputDir, 'classes'), paths['game-jar']].join(delimiter), probe.mainClass]);
    const baseline = JSON.parse(baselineText.trim());
    const classLog = await readFile(join(outputDir, 'baseline-classload.log'), 'utf8');
    evidence.loadedGameClasses = [...classLog.matchAll(/\[class,load\] (zombie\.[^ ]+) source:/g)].map(match => match[1]).sort();
    if (JSON.stringify(evidence.loadedGameClasses) !== JSON.stringify([...probe.classes].sort())) {
        throw new Error('JVM game-class closure differs from the inspected probe contract');
    }
    if (baseline.cases.length !== probe.cases || baseline.cases.reduce((n, c) => n + Object.keys(c.outputs).length, 0) !== probe.comparisons) {
        throw new Error('Baseline case/output count differs from the selected probe contract');
    }
    evidence.rule = baseline.rule;
    await writeFile(join(outputDir, 'baseline.json'), JSON.stringify(baseline, null, 2) + '\n');
    } else {
        evidence.rule = 'framebuffer-readback-and-WebGL-errors';
        evidence.jvmBaselineExecuted = false;
        evidence.measurement = 'Browser-only framebuffer and error-state assertions, followed by real input controls; no JVM graphics baseline or timing benchmark';
    }
    const routes = new Map([
        ['/', [probe.browserOnly ? 'src/main/webapp/graphics.html' : 'src/main/webapp/index.html', 'text/html; charset=utf-8']],
        ['/save-host.js', ['src/main/webapp/save-host.js', 'text/javascript']],
        ['/baseline.json', [join(outputDir, 'baseline.json'), 'application/json']],
        ['/wasm/probe.wasm', [join(outputDir, 'wasm/probe.wasm'), 'application/wasm']],
        ['/wasm/classes.wasm-runtime.js', [join(outputDir, 'wasm/classes.wasm-runtime.js'), 'text/javascript']],
        ['/favicon.ico', [null, 'image/x-icon']]
    ]);
    server = createServer(async (request, response) => {
        const route = routes.get(request.url);
        if (!route) { response.writeHead(404); response.end(); return; }
        try {
            const body = route[0] ? await readFile(route[0]) : Buffer.alloc(0);
            response.writeHead(200, {'Content-Type': route[1], 'Cache-Control': 'no-store'});
            response.end(body);
        } catch (error) { response.writeHead(500); response.end(String(error)); }
    });
    await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
    browser = await chromium.launch({executablePath: paths.browser, headless: true});
    evidence.browserVersion = browser.version();
    const page = await browser.newPage();
    let pageLoads = 0;
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) pageLoads++; });
    const browserErrors = [];
    page.on('pageerror', error => browserErrors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text()); });
    page.on('requestfailed', request => browserErrors.push(request.url() + ': ' + request.failure()?.errorText));
    await page.goto('http://127.0.0.1:' + server.address().port + '/', {waitUntil: 'load', timeout: 30000});
    await page.waitForFunction(() => window.probeResult !== undefined, null, {timeout: 30000});
    if (probe.browserOnly && await page.evaluate(() => window.probeResult.pass)) {
        await page.locator('#red').fill('127');
        await page.locator('#green').fill('64');
        await page.locator('#blue').fill('255');
        await page.locator('#brightness').fill('75');
        const rendered = JSON.parse(await page.locator('#details').innerText());
        if (JSON.stringify(rendered.pixels) !== JSON.stringify([95, 48, 191, 191]) || rendered.error !== 0) {
            throw new Error('Browser input did not produce the expected original Color framebuffer');
        }
        evidence.interactiveFramebuffer = rendered;
    }
    evidence.browser = await page.evaluate(() => window.probeResult);
    evidence.visibleStatus = await page.locator('#status').innerText();
    evidence.browserErrors = browserErrors;
    evidence.browserPageLoads = pageLoads;
    if (probe.browserOnly && (!evidence.browser.webgl2 || evidence.browser.errors.length || !evidence.interactiveFramebuffer)) {
        throw new Error('Expected real WebGL2 and verified browser input');
    }
    if (probeName === 'colors' && !evidence.browser.directExport) throw new Error('Expected direct JavaScript color export execution');
    if (probeName === 'browser-save' && (pageLoads !== 8 || evidence.browser.hostStorage?.pageLoads !== 8 || evidence.browser.hostStorage?.writes !== 8 || evidence.browser.hostStorage?.readbacks !== 8)) {
        throw new Error('Expected eight original-state OPFS cycles across fresh page loads');
    }
    if (evidence.browser.hostStorage) {
        evidence.measurement = 'Initialization sums eight module fetch/compile/instantiate/load calls; execution sums original adapter calls plus OPFS write/readback; excludes navigation and loader JS downloads';
    }
    await writeFile(join(outputDir, 'browser.json'), JSON.stringify(evidence.browser, null, 2) + '\n');
    if (!evidence.browser.pass || browserErrors.length || evidence.browser.comparisons !== probe.comparisons || !evidence.visibleStatus.startsWith('PASS')) {
        throw new Error('Browser comparison failed; see ' + join(outputDir, 'browser.json'));
    }
    evidence.pass = true;
    }
} catch (error) {
    evidence.errors.push(String(error.stack || error));
    process.exitCode = 1;
} finally {
    if (browser) await browser.close().catch(error => { evidence.errors.push(String(error)); evidence.pass = false; process.exitCode = 1; });
    if (server) await new Promise(accept => server.close(accept));
    try {
        evidence.jarSha256After = await sha256(paths['game-jar']);
        if (evidence.jarSha256Before !== evidence.jarSha256After) throw new Error('Original JAR changed');
    } catch (error) { evidence.errors.push(String(error)); evidence.pass = false; process.exitCode = 1; }
    evidence.ownedBrowserClosed = !browser || !browser.isConnected();
    evidence.ownedServerClosed = !server || !server.listening;
    evidence.recordedAt = new Date().toISOString();
    await mkdir(outputDir, {recursive: true});
    await writeFile(join(outputDir, 'comparison.json'), JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify({pass: evidence.pass, compilationSucceeded: evidence.compilationSucceeded || false,
        executionRequested: evidence.executionRequested, cases: evidence.browser?.cases || 0,
        comparisons: evidence.browser?.comparisons || 0, matched: evidence.browser?.matched || 0,
        mismatches: evidence.browser?.mismatches || [], errors: evidence.errors,
        evidence: join(outputDir, 'comparison.json')}, null, 2));
}
