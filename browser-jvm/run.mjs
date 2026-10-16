import {createServer} from 'node:http';
import {createReadStream} from 'node:fs';
import {mkdir, readFile, writeFile, stat, realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {chromium} from 'playwright-core';

const source = fileURLToPath(new URL('./', import.meta.url));
const repository = path.resolve(source, '..');
const output = path.join(repository, 'target', 'browser-jvm');
const names = new Set(['game-jar', 'media-root', 'jdk', 'browser']);
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i]?.replace(/^--/, '');
  if (!names.has(name) || !process.argv[i].startsWith('--') || !process.argv[i + 1] || options[name])
    throw new Error('Usage: node browser-jvm/run.mjs --game-jar PATH --media-root PATH --jdk JDK25_DIRECTORY --browser CHROMIUM_EXECUTABLE');
  options[name] = path.resolve(process.argv[i + 1]);
}
if (Object.keys(options).length !== names.size)
  throw new Error('Required: --game-jar PATH --media-root PATH --jdk JDK25_DIRECTORY --browser CHROMIUM_EXECUTABLE');

const classes = path.join(output, 'classes');
const tools = path.join(output, 'tools');
const gameJar = options['game-jar'];
const png = path.join(options['media-root'], 'ui', 'avatarBackgroundWhite.png');
const executable = name => path.join(options.jdk, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
function contained(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
async function canonical(file) {
  try {return await realpath(file);} catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(await canonical(parent), path.basename(file));
  }
}
// These checks deliberately precede every generated directory/file write.
const actualRepository = await realpath(repository);
const actualTarget = await canonical(path.join(repository, 'target'));
const actualOutput = await canonical(output);
if (!contained(actualRepository, actualTarget) || actualTarget === actualRepository
    || !contained(actualTarget, actualOutput) || actualOutput === actualTarget)
  throw new Error('Generated output must remain inside the workspace target directory; escaping junctions are rejected');
for (const prerequisite of [...Object.values(options), png, executable('java'), executable('javac')]) {
  if (contained(output, prerequisite) || contained(actualOutput, await canonical(prerequisite)))
    throw new Error('Prerequisite is inside generated output: ' + prerequisite);
}
for (const destination of [classes, tools, ...['view.jar', 'class-manifest.json', 'result.json', 'build.json'].map(name => path.join(output, name))])
  if (!contained(actualOutput, await canonical(destination))) throw new Error('Generated destination escapes output: ' + destination);
await mkdir(output, {recursive: true});
await mkdir(classes, {recursive: true});
await mkdir(tools, {recursive: true});
async function hash(file) {
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  return digest.digest('hex');
}
const requests = [], denied = [], logs = [], build = [];
let browser, server;
const evidence = {pass: false, runtime: 'CheerpJ 4.3 Java17', closed: false};
function command(binary, args) {
  const result = spawnSync(binary, args, {cwd: repository, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024});
  build.push({binary, args, status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message});
  if (result.error || result.status !== 0) throw new Error('Build failed: ' + binary + '\n' + (result.error?.message || result.stderr || result.stdout));
}
try {
  for (const file of [gameJar, png, options.browser, executable('javac'), executable('java')])
    if (!(await stat(file)).isFile()) throw new Error('Expected file: ' + file);
  evidence.originalJarSha256Before = await hash(gameJar);
  evidence.pngSha256Before = await hash(png);
  command(executable('javac'), ['--release', '17', '-classpath', gameJar, '-d', classes, path.join(source, 'CheerpJGL.java')]);
  command(executable('javac'), ['-d', tools, path.join(source, 'PrepareBrowserJvm.java')]);
  command(executable('java'), ['-cp', tools, 'PrepareBrowserJvm', gameJar, output, classes]);
  evidence.viewJarSha256 = await hash(path.join(output, 'view.jar'));
  const manifest = JSON.parse(await readFile(path.join(output, 'class-manifest.json'), 'utf8'));
  evidence.classes = manifest.classes;
  evidence.headerLoweredClasses = manifest.headerLoweredClasses;
  evidence.adaptedVendorClasses = manifest.adaptedVendorClasses;
  evidence.gameMethodBodiesUnchanged = manifest.gameMethodBodiesUnchanged;

  const routes = new Map([
    ['/', {file: path.join(source, 'index.html'), type: 'text/html; charset=utf-8'}],
    ['/index.html', {file: path.join(source, 'index.html'), type: 'text/html; charset=utf-8'}],
    ['/view.jar', {file: path.join(output, 'view.jar'), type: 'application/java-archive'}],
    ['/menu.png', {file: png, type: 'image/png'}],
  ]);
  server = createServer(async (request, response) => {
    try {
      if (!['GET', 'HEAD'].includes(request.method)) {response.writeHead(405).end(); return;}
      // Match the raw path. Never resolve a request path against the filesystem.
      const route = routes.get(request.url);
      if (!route) {response.writeHead(404).end(); return;}
      const size = (await stat(route.file)).size;
      const headers = {'Content-Type': route.type, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes'};
      let start = 0, end = size - 1, status = 200;
      if (request.headers.range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
        if (!match || (!match[1] && !match[2])) {response.writeHead(416, {'Content-Range': `bytes */${size}`}).end(); return;}
        if (!match[1]) start = Math.max(0, size - Number(match[2]));
        else {start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), end) : end;}
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || end >= size) {
          response.writeHead(416, {'Content-Range': `bytes */${size}`}).end(); return;
        }
        status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      }
      headers['Content-Length'] = end - start + 1;
      response.writeHead(status, headers);
      if (request.method === 'HEAD') response.end();
      else {
        const stream = createReadStream(route.file, {start, end});
        stream.on('error', error => response.destroy(error));
        response.on('close', () => stream.destroy());
        stream.pipe(response);
      }
    } catch (error) {
      if (!response.headersSent) response.writeHead(500);
      response.end('Local artifact unavailable');
      logs.push('HTTP: ' + error.message);
    }
  });
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  const origin = `http://127.0.0.1:${server.address().port}`;
  evidence.origin = origin;
  browser = await chromium.launch({executablePath: options.browser, headless: true});
  const context = await browser.newContext({serviceWorkers: 'block'});
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const item = {url: request.url(), method: request.method(), postDataBytes: request.postDataBuffer()?.length || 0};
    requests.push(item);
    const local = url.origin === origin && routes.has(url.pathname) && !url.search;
    const runtime = url.origin === 'https://cjrtnc.leaningtech.com' && url.pathname.startsWith('/4.3/');
    if (!['GET', 'HEAD'].includes(request.method()) || item.postDataBytes || (!local && !runtime)) {
      denied.push(item); await route.abort(); return;
    }
    await route.continue();
  });
  const page = await context.newPage();
  page.on('console', message => logs.push(message.type() + ': ' + message.text()));
  page.on('pageerror', error => logs.push('PAGEERROR: ' + error.stack));
  await page.goto(origin, {waitUntil: 'domcontentloaded', timeout: 60000});
  await page.waitForFunction(() => window.probeResult, undefined, {timeout: 180000});
  evidence.result = await page.evaluate(() => window.probeResult);
  evidence.pass = evidence.result.pass === true && denied.length === 0;
} catch (error) {
  evidence.error = String(error.stack || error);
} finally {
  const cleanupErrors = [];
  if (browser) try {await browser.close();} catch (error) {cleanupErrors.push('browser: ' + error.message);}
  if (server) try {await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));} catch (error) {cleanupErrors.push('server: ' + error.message);}
  evidence.closed = cleanupErrors.length === 0;
  if (cleanupErrors.length) {evidence.cleanupErrors = cleanupErrors; evidence.pass = false;}
  for (const [label, file] of [['originalJar', gameJar], ['png', png]]) {
    try {
      evidence[label + 'Sha256After'] = await hash(file);
      if (!evidence[label + 'Sha256Before'] || evidence[label + 'Sha256After'] !== evidence[label + 'Sha256Before']) evidence.pass = false;
    } catch (error) {evidence.pass = false; logs.push('Hash verification: ' + error.message);}
  }
  evidence.requests = requests;
  evidence.denied = denied;
  evidence.logs = logs;
  evidence.externalNonReadRequests = requests.filter(r => !r.url.startsWith(evidence.origin || 'http://127.0.0.1/') && (!['GET', 'HEAD'].includes(r.method) || r.postDataBytes));
  await writeFile(path.join(output, 'build.json'), JSON.stringify(build, null, 2) + '\n');
  await writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({...evidence, requests: requests.length, logs: logs.length, resultFile: path.join(output, 'result.json')}, null, 2));
  if (!evidence.pass) process.exitCode = 1;
}
