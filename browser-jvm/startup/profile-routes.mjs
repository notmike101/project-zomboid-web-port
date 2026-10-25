import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createFileWatchService } from '../file-watch-service.mjs';
import { loadClosedMedia } from './closed-media.mjs';

const headers = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
const sourceModules = [
    'negative-stat.js', 'sprite-webgl.js', 'sprite-attrib.js', 'glsl-compat.js', 'keyboard.js', 'browser-mouse.js', 'display-events.js',
    'custom-cursor.js', 'controller-natives.js', 'browser-clock.js', 'browser-physics.js', 'ragdoll-definitions.js',
    'file-watch-natives.js', 'process-natives.js', 'native-library-loader.js', 'unsafe-short-repair.js', 'unsafe-float-volatile.js',
    'credentialless-runtime-helper.js', 'sqlite-namespace.js', 'scheduler-runtime.js', 'RakNet64.js', 'ZNetNoSteam64.js',
    'raknet-runtime.js', 'znet-natives.js', 'Lighting64.js', 'lighting-natives.js', 'lighting-kernel.js',
    'PZPopMan64.js', 'population-natives.js', 'population-kernel.js', 'population-save-codec.js',
    'sqlitejdbc.js', 'sqlite-natives.js', 'native-long-return.js',
    'PZClipper64.js', 'clipper-native-owner.js',
];
const generatedUrls = [
    '/raknet-engine.mjs', '/raknet-engine.wasm', '/sqlite3.mjs', '/sqlite3.wasm',
    '/browser-jvm/earcut/earcut-engine.mjs', '/browser-jvm/earcut/earcut-engine.wasm',
    '/scheduler-runtime/manifest.json', '/scheduler-runtime/cj3.js', '/scheduler-runtime/load-function.js',
    '/prepared/index.properties', '/media-negative-certificate.json',
];
// Exact existing graphics-profile package route list from browser-jvm/run.mjs.
const shaderParserModules = ['index.js', 'error.js', 'ast/index.js', 'ast/ast.js', 'ast/visit.js', 'ast/ast-types.js',
    'parser/index.js', 'parser/parser.js', 'parser/generator.js', 'parser/grammar.js', 'parser/scope.js', 'parser/utils.js',
    'preprocessor/index.js', 'preprocessor/preprocessor.js', 'preprocessor/preprocessor-parser.js', 'preprocessor/generator.js'];

/**
 * Requires the exact existing graphics parser module route closure.
 *
 * @param {Set<string>} urls - Actual immutable generated route identities.
 * @returns {void} Throws when any required package module is absent.
 */
function requireShaderParserRoutes(urls) {
    for (const name of shaderParserModules) {
        assert.ok(urls.has(`/node_modules/@shaderfrog/glsl-parser/${name}`), `Missing exact shader parser route: ${name}`);
    }
}

/**
 * Hashes one existing file as a stream; never retains installed pack bytes.
 *
 * @param {string} file - Exact existing canonical input.
 * @returns {Promise<string>} SHA-256 of its bytes.
 */
async function hash(file) {
    const digest = createHash('sha256');

    for await (const bytes of createReadStream(file)) {
        digest.update(bytes);
    }

    return digest.digest('hex');
}

/**
 * Reuses existing server owners after exact frozen route/input validation; starts no server or browser.
 *
 * @param {object} generation - Reviewed frozen route and original input ledger.
 * @returns {Promise<object>} Existing route/media/watch owners for the runner.
 */
async function createOriginalBootRoutes(generation) {
    assert.equal(generation?.executionAdmitted, true, 'Original boot execution is not admitted');
    assert.equal(generation.scope, 'original-frontend-setup');
    const root = await realpath(generation.root);
    const preparedRoot = await realpath(generation.importer.root);
    const mediaRoot = await realpath(generation.mediaRoot);
    const routes = new Map();

    requireShaderParserRoutes(new Set(generation.routes.map((record) => record.url)));
    const required = new Set(['/', '/index.list', '/prepared/', '/prepared/index.list', '/original-boot.html', '/original-boot.js', '/original-boot-admission.json', '/stdlib.lua',
        ...sourceModules.map((name) => `/${name}`), ...generatedUrls, ...generation.classpath.map((name) => name.slice(4)),
        ...shaderParserModules.map((name) => `/node_modules/@shaderfrog/glsl-parser/${name}`)]);

    // Hash sequentially to bound simultaneously open streams for thousands of importer snapshots.
    /* eslint-disable no-await-in-loop */
    for (const record of generation.routes) {
        assert.ok(required.has(record.url) || /^\/prepared\/[a-f0-9]{64}\.ais$/u.test(record.url)
            || /^\/raknet-engine\.[a-z.-]+$/u.test(record.url), 'Unexpected generated route');
        const file = await realpath(record.file);
        const ownerRoot = record.url.startsWith('/prepared/') ? preparedRoot : root;
        const relative = path.relative(ownerRoot, file);

        assert.ok(relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative), 'Frozen route escapes generation');
        assert.match(record.sha256, /^[a-f0-9]{64}$/u);
        assert.equal(await hash(file), record.sha256, record.url);
        assert.equal((await stat(file)).size, record.bytes, record.url);
        assert.equal(routes.has(record.url), false, 'Duplicate route');
        routes.set(record.url, { file, type: record.type, sha256: record.sha256, bytes: record.bytes });
        required.delete(record.url);
    }
    /* eslint-enable no-await-in-loop */

    assert.equal(required.size, 0, `Required routes absent: ${[...required]}`);
    assert.equal(generation.rootSourceInputs?.length, 1, 'Exact original root stdlib input is required');
    const stdlib = generation.rootSourceInputs[0];
    const originalStdlib = await realpath(path.join(mediaRoot, '..', 'stdlib.lua'));

    assert.equal(await realpath(stdlib.file), originalStdlib);
    assert.equal(stdlib.url, '/stdlib.lua');
    assert.equal(stdlib.sha256, routes.get('/stdlib.lua').sha256);
    assert.equal(await hash(originalStdlib), stdlib.sha256);
    assert.equal((await stat(originalStdlib)).size, stdlib.bytes);
    const servedAdmission = JSON.parse(await readFile(routes.get('/original-boot-admission.json').file, 'utf8'));

    assert.equal(servedAdmission.executionAdmitted, true);
    assert.deepEqual(servedAdmission.classpath, generation.classpath);
    const inventoryFile = await realpath(generation.importer.inventoryFile);
    const importerFile = routes.get('/prepared/index.properties').file;

    for (const file of [inventoryFile, importerFile]) {
        const ownerRoot = file === importerFile ? preparedRoot : root;
        const relative = path.relative(ownerRoot, file);

        assert.ok(relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative), 'Importer evidence escapes frozen generation');
    }

    assert.equal(await hash(inventoryFile), generation.importer.inventorySha256);
    const inventory = JSON.parse(await readFile(inventoryFile, 'utf8'));
    const importer = new Map();

    for (const line of (await readFile(importerFile, 'latin1')).split(/\r?\n/u).filter(Boolean)) {
        const match = /^([^=\\]+)=([^\\]*)$/u.exec(line);

        assert.ok(match, 'Unexpected index format outside the exact original manifest writer');
        assert.equal(importer.has(match[1]), false, 'Duplicate original index key');
        importer.set(match[1], match[2]);
    }

    assert.equal(inventory.entries.length, 6_034);
    assert.equal(importer.get('format'), 'original-jassimp-relative-flags-v1');
    assert.equal(importer.get('plan.sha256'), generation.importer.planSha256);
    assert.equal(importer.get('dll.sha256'), generation.importer.dllSha256);
    assert.equal(importer.size, 3 + inventory.entries.length * 4);

    for (const expected of inventory.entries) {
        const flags = [...expected.flags].sort().join(',');
        const key = createHash('sha256').update(`${expected.path.toLowerCase()}|${flags}`).digest('hex');

        assert.equal(`${key}.ais`, expected.snapshotIdentity);
        assert.equal(importer.get(`${key}.path`), expected.path);
        assert.equal(importer.get(`${key}.flags`), flags);
        assert.equal(importer.get(`${key}.source`), expected.sha256);
        const route = routes.get(`/prepared/${key}.ais`);

        assert.ok(route, 'Prepared importer snapshot is not served');
        assert.equal(route.sha256, importer.get(`${key}.snapshot`));
    }

    const media = new Map(generation.media.map((record) => [record.path, record]));
    const verifiedMedia = new Set();
    /**
     * Verifies each demanded installed file against its frozen source identity.
     *
     * @param {string} file - Actual canonical path selected by the existing media handler.
     * @returns {Promise<void>} Completion after both byte identity and size match.
     */
    const integrity = async (file) => {
        const relative = path.relative(mediaRoot, file).split(path.sep).join('/');
        const record = media.get(relative);

        assert.ok(record, 'Installed input missing from frozen original media inventory');
        assert.equal(await hash(file), record.sha256, relative);
        assert.equal((await stat(file)).size, record.bytes, relative);
        verifiedMedia.add(file);
    };

    assert.ok(generation.closedMedia, 'Exact reviewed closed-media descriptor is required');
    assert.equal(generation.closedMedia.ledgerSHA256, generation.mediaLedger.sha256);
    assert.equal(await realpath(generation.closedMedia.ledgerFile), await realpath(generation.mediaLedger.file));
    assert.deepEqual(JSON.parse(await readFile(generation.closedMedia.ledgerFile, 'utf8')), generation.media);
    assert.equal(routes.get('/media-negative-certificate.json').sha256, generation.closedMedia.certificateSHA256);
    const snapshotParent = await realpath(generation.closedMedia.snapshotParent);

    for (const protectedRoot of [path.dirname(mediaRoot), root, preparedRoot]) {
        const relative = path.relative(protectedRoot, snapshotParent);

        assert.ok(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), 'Snapshots must be outside installed and immutable input trees');
    }

    const closedMedia = await loadClosedMedia({ ...generation.closedMedia, mediaRoot, snapshotParent });

    try {
        const mediaHandler = closedMedia.handle;
        const watch = createFileWatchService({ mounts: [{ virtualPrefix: '/app/media', root: mediaRoot }] });

        return { routes, mediaHandler, watch, headers, integrity, verifiedMedia, closedMedia };
    } catch (error) {
        try {
            await closedMedia.dispose();
        } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], 'Route owner creation and media cleanup failed');
        }

        throw error;
    }
}

export { createOriginalBootRoutes, headers, sourceModules, generatedUrls, hash, shaderParserModules, requireShaderParserRoutes };
