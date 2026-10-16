import {createServer} from 'node:http';
import {createReadStream} from 'node:fs';
import {mkdir, readFile, writeFile, stat, realpath, readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {chromium} from 'playwright-core';

const source = fileURLToPath(new URL('./', import.meta.url));
const repository = path.resolve(source, '..');
const output = path.join(repository, 'target', 'browser-jvm');
const names = new Set(['game-jar', 'media-root', 'jdk', 'browser', 'profile']);
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const name = process.argv[i]?.replace(/^--/, '');
  if (!names.has(name) || !process.argv[i].startsWith('--') || !process.argv[i + 1] || options[name])
    throw new Error('Usage: node browser-jvm/run.mjs --game-jar PATH --media-root PATH --jdk JDK25_DIRECTORY --browser CHROMIUM_EXECUTABLE');
  options[name] = name === 'profile' ? process.argv[i + 1] : path.resolve(process.argv[i + 1]);
}
if (!['game-jar','media-root','jdk','browser'].every(name => options[name]))
  throw new Error('Required: --game-jar PATH --media-root PATH --jdk JDK25_DIRECTORY --browser CHROMIUM_EXECUTABLE');
const profile = options.profile || 'graphics';
if (!['graphics','lua','input','sprite','world','character-shader'].includes(profile)) throw new Error('Profile must be graphics, lua, input, sprite, world or character-shader');

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
for (const prerequisite of [...Object.entries(options).filter(([name]) => name !== 'profile').map(([,value]) => value), png, executable('java'), executable('javac')]) {
  if (contained(output, prerequisite) || contained(actualOutput, await canonical(prerequisite)))
    throw new Error('Prerequisite is inside generated output: ' + prerequisite);
}
for (const destination of [classes, tools, ...['host-classes','bridge-classes','GeneratedFloatBridge.java','runtime-view.jar','full-entry.jar','float-bridge.jar','memory-bridge.jar','generated-float-members.tsv','float-bridge-summary.json','view.jar', 'class-manifest.json', 'result.json', 'build.json'].map(name => path.join(output, name))])
  if (!contained(actualOutput, await canonical(destination))) throw new Error('Generated destination escapes output: ' + destination);
async function validateExisting(directory) {
  let entries; try {entries=await readdir(directory,{withFileTypes:true});} catch(error) {if(error.code==='ENOENT')return;throw error;}
  for(const entry of entries) {
    const file=path.join(directory,entry.name);
    if(!contained(actualOutput,await canonical(file)))throw new Error('Existing generated entry escapes output: '+file);
    if(entry.isSymbolicLink())throw new Error('Generated output may not contain links: '+file);
    if(entry.isDirectory())await validateExisting(file);
  }
}
await validateExisting(output);
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
const assetHashes = [];
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
  if (['lua','sprite','world','character-shader'].includes(profile)) for (const name of ['stdlib.lua','media/lua/shared/defines.lua','media/lua/shared/Sandbox/Apocalypse.lua']) {
    const file=path.join(options['media-root'],'..',name);
    assetHashes.push({name,file,sha256Before:await hash(file)});
  }
  if (profile === 'sprite' || profile === 'character-shader') for(const name of (profile==='character-shader'?['basicEffect.vert','basicEffect.frag','util/math.h','util/math.glsl','util/hueShift.h','util/hueShift.glsl'].map(name=>'shaders/'+name):['shaders/default.vert','shaders/default.frag'])) {const file=path.join(options['media-root'],name);assetHashes.push({name,file,sha256Before:await hash(file)});}
  command(executable('javac'), ['--release', '17', '-classpath', gameJar, '-d', classes, path.join(source, 'CheerpJGL.java')]);
  command(executable('javac'), ['-d', tools, path.join(source, 'PrepareBrowserJvm.java')]);
  command(executable('java'), ['-cp', tools, 'PrepareBrowserJvm', gameJar, output, classes]);
  if (['lua','sprite','world','character-shader'].includes(profile)) {
    const hostClasses = path.join(output, 'host-classes');
    await mkdir(hostClasses, {recursive:true});
    command(executable('javac'), ['--release','17','-d',hostClasses,
      path.join(source,'host/org/lwjgl/glfw/GLFWGamepadState.java'),path.join(source,'host/port/host/BrowserBuffers.java')]);
    // The bootstrap entry references generated getter declarations. Generate once for javac,
    // then regenerate against the actual authored fixture fields, never loading game classes.
    command(executable('javac'), ['-d',tools,path.join(source,'PrepareRuntime.java')]);
    const bridgeSource = path.join(output,'GeneratedFloatBridge.java');
    await writeFile(bridgeSource,'package port.host; public final class GeneratedFloatBridge { public static native Object get(java.lang.reflect.Field f,Object o)throws IllegalAccessException; }');
    const bridgeClasses = path.join(output,'bridge-classes');
    command(executable('javac'), ['--release','17','-d',bridgeClasses,bridgeSource]);
    command(executable('javac'), ['--release','17','-cp',[hostClasses,bridgeClasses,gameJar].join(path.delimiter),'-d',classes,path.join(source,'CheerpJFull.java')]);
    command(executable('java'), ['-cp',tools,'PrepareRuntime',output,classes]);
    command(executable('javac'), ['--release','17','-cp',bridgeClasses,'-d',bridgeClasses,bridgeSource]);
    command(executable('jar'), ['--create','--file',path.join(output,'full-entry.jar'),'-C',classes,'probe/CheerpJFull.class']);
    command(executable('jar'), ['--create','--file',path.join(output,'float-bridge.jar'),'-C',bridgeClasses,'.']);
    command(executable('jar'), ['--create','--file',path.join(output,'memory-bridge.jar'),'-C',hostClasses,'.']);
  }
  if (profile === 'input') {
    command(executable('javac'), ['--release','17','-cp',gameJar,'-d',classes,path.join(source,'CheerpJInput.java'),path.join(source,'host/port/host/BrowserKeyboard.java')]);
    command(executable('javac'), ['-d',tools,path.join(source,'PrepareInput.java')]);
    command(executable('java'), ['-cp',tools,'PrepareInput',path.join(output,'view.jar'),path.join(output,'input-view.jar')]);
    command(executable('jar'), ['--create','--file',path.join(output,'input-entry.jar'),'-C',classes,'probe/CheerpJInput.class','-C',classes,'port/host/BrowserKeyboard.class']);
  }
  if (profile === 'sprite' || profile === 'character-shader') {
    const spriteClasses=path.join(output,'sprite-classes'); await mkdir(spriteClasses,{recursive:true});
    command(executable('javac'),['--release','17','-cp',[gameJar,classes].join(path.delimiter),'-d',spriteClasses,...['CheerpJSprite.java','CheerpJCharacterShader.java','host/port/host/SpriteGraphics.java','host/port/host/SpriteBuffers.java'].map(name=>path.join(source,name))]);
    command(executable('javac'),['-d',tools,path.join(source,'PrepareSpriteGraphics.java')]);
    command(executable('java'),['-cp',tools,'PrepareSpriteGraphics',path.join(output,'runtime-view.jar'),output,spriteClasses]);
    if(profile==='character-shader')await writeFile(path.join(output,'character-shader.html'),(await readFile(path.join(source,'sprite.html'),'utf8')).replace('probe.CheerpJSprite','probe.CheerpJCharacterShader'));
  }
  if (profile === 'world') {
    const worldClasses=path.join(output,'world-classes');await mkdir(worldClasses,{recursive:true});
    command(executable('javac'),['--release','17','-cp',gameJar,'-d',worldClasses,...['CheerpJWorld.java','host/port/host/BrowserWorldBootstrap.java','host/port/host/PoolListSupport.java','host/port/host/BrowserKeyboard.java'].map(name=>path.join(source,name))]);
    command(executable('javac'),['-d',tools,...['PrepareInput.java','PrepareWorld.java','PrepareWorldAssets.java'].map(name=>path.join(source,name))]);
    command(executable('java'),['-cp',tools,'PrepareWorldAssets',options['media-root'],path.join(output,'player-assets.jar'),path.join(output,'player-assets-manifest.json')]);
    command(executable('java'),['-cp',tools,'PrepareInput',path.join(output,'runtime-view.jar'),path.join(output,'input-view.jar')]);
    command(executable('java'),['-cp',tools,'PrepareWorld',path.join(output,'input-view.jar'),path.join(output,'world-view.jar'),path.join(output,'world-sdk-manifest.json')]);
    command(executable('jar'),['--create','--file',path.join(output,'world-entry.jar'),'-C',worldClasses,'.']);
    const worldManifest=JSON.parse(await readFile(path.join(output,'player-assets-manifest.json'),'utf8'));
    evidence.worldAssets={files:worldManifest.files,bytes:worldManifest.bytes};
    for(const asset of worldManifest.entries){const file=path.join(options['media-root'],'..',asset.path);if(await hash(file)!==asset.sha256)throw new Error('Asset changed while preparing: '+asset.path);assetHashes.push({name:asset.path,file,sha256Before:asset.sha256});}
  }
  evidence.viewJarSha256 = await hash(path.join(output, 'view.jar'));
  const manifest = JSON.parse(await readFile(path.join(output, 'class-manifest.json'), 'utf8'));
  evidence.classes = manifest.classes;
  evidence.headerLoweredClasses = manifest.headerLoweredClasses;
  evidence.adaptedVendorClasses = manifest.adaptedVendorClasses;
  evidence.gameMethodBodiesUnchanged = manifest.gameMethodBodiesUnchanged;

  const routes = new Map([
    ['/', {file: profile==='character-shader'?path.join(output,'character-shader.html'):path.join(source, profile === 'lua' ? 'lua.html' : profile === 'world' ? 'world.html' : profile === 'sprite' ? 'sprite.html' : profile === 'input' ? 'input.html' : 'index.html'), type: 'text/html; charset=utf-8'}],
    ['/index.html', {file: path.join(source, 'index.html'), type: 'text/html; charset=utf-8'}],
    ['/view.jar', {file: path.join(output, 'view.jar'), type: 'application/java-archive'}],
    ['/menu.png', {file: png, type: 'image/png'}],
  ]);
  if (['lua','sprite','world','character-shader'].includes(profile)) {
    for (const name of ['full-entry.jar','float-bridge.jar','memory-bridge.jar','runtime-view.jar'])
      routes.set('/'+name,{file:path.join(output,name),type:'application/java-archive'});
    for (const name of ['stdlib.lua','media/lua/shared/defines.lua','media/lua/shared/Sandbox/Apocalypse.lua'])
      routes.set('/'+name,{file:path.join(options['media-root'],'..',name),type:'text/plain'});
    evidence.runtimeViewJarSha256=await hash(path.join(output,'runtime-view.jar'));
  }
  if (profile === 'input') {
    routes.set('/keyboard.js',{file:path.join(source,'keyboard.js'),type:'text/javascript'});
    for(const name of ['input-view.jar','input-entry.jar']) routes.set('/'+name,{file:path.join(output,name),type:'application/java-archive'});
  }
  if (profile === 'sprite' || profile === 'character-shader') {
    routes.set('/sprite-webgl.js',{file:path.join(source,'sprite-webgl.js'),type:'text/javascript'});
    routes.set('/sprite-view.jar',{file:path.join(output,'sprite-view.jar'),type:'application/java-archive'});
    for(const name of (profile==='character-shader'?['basicEffect.vert','basicEffect.frag','util/math.h','util/math.glsl','util/hueShift.h','util/hueShift.glsl'].map(name=>'shaders/'+name):['ui/avatarBackgroundWhite.png','shaders/default.vert','shaders/default.frag'])) routes.set('/media/'+name,{file:path.join(options['media-root'],name),type:name.endsWith('.png')?'image/png':'text/plain'});
    evidence.spriteAdaptations=JSON.parse(await readFile(path.join(output,'sprite-graphics-manifest.json'),'utf8'));
  }
  if(profile==='world'){
    routes.set('/keyboard.js',{file:path.join(source,'keyboard.js'),type:'text/javascript'});
    for(const name of ['world-entry.jar','world-view.jar','player-assets.jar'])routes.set('/'+name,{file:path.join(output,name),type:'application/java-archive'});
    evidence.sdkAdaptations=JSON.parse(await readFile(path.join(output,'world-sdk-manifest.json'),'utf8'));evidence.gameMethodBodiesUnchanged=false;evidence.originalGameAlgorithmsPreserved=true;
  }
  evidence.profile=profile;
  if (['lua','sprite','world','character-shader'].includes(profile)) evidence.runtimeAdaptations=JSON.parse(await readFile(path.join(output,'float-bridge-summary.json'),'utf8'));
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
  if (profile === 'input') {
    for(const [phase,action] of [['press',()=>page.keyboard.down('w')],['release',()=>page.keyboard.up('w')],['focus-press',()=>page.keyboard.down('w')],['blur',()=>page.locator('#outside').focus()]]) {
      await page.waitForFunction(expected=>window.inputPhase===expected,phase,{timeout:60000}); await action();
    }
    await page.keyboard.up('w');
  }
  if(profile==='world'){for(const [phase,action] of [['press',()=>page.keyboard.down('w')],['release',()=>page.keyboard.up('w')]]){await page.waitForFunction(expected=>window.inputPhase===expected,phase,{timeout:60000});await action();}}
  await page.waitForFunction(() => window.probeResult, undefined, {timeout: 180000});
  evidence.result = await page.evaluate(() => window.probeResult);
  if (['lua','sprite','world','character-shader'].includes(profile)) evidence.stages=await page.evaluate(() => window.stageResults);
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
  for (const asset of assetHashes) {
    try {asset.sha256After=await hash(asset.file);if(asset.sha256After!==asset.sha256Before)evidence.pass=false;}
    catch(error){asset.error=String(error);evidence.pass=false;}
  }
  if(assetHashes.length)evidence.assets=assetHashes;
  await writeFile(path.join(output, 'build.json'), JSON.stringify(build, null, 2) + '\n');
  await writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2) + '\n');
  await writeFile(path.join(output, 'result-'+profile+'.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({...evidence, requests: requests.length, logs: logs.length, resultFile: path.join(output, 'result.json')}, null, 2));
  if (!evidence.pass) process.exitCode = 1;
}






