import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createMediaHandler } from './media-files.mjs';

/**
 * Makes an HTTP request without URL-normalizing traversal segments before transmission.
 *
 * @param {number} port - Local fixture server port.
 * @param {string} target - Exact HTTP request target.
 * @param {object} options - Optional method and headers.
 * @returns {Promise<object>} Status, headers, and received body.
 */
function get(port, target, options = {}) {
    return new Promise((resolve, reject) => {
        const pending = request({ hostname: '127.0.0.1', port, path: target, ...options }, (response) => {
            const chunks = [];

            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
            response.on('error', reject);
        });

        pending.on('error', reject);
        pending.end();
    });
}

const fixture = await mkdtemp(path.join(tmpdir(), 'zomboid-media-test-'));
const fixtureRoot = await realpath(fixture);
const media = path.join(fixture, 'media');
const checks = new Map();
let server;

try {
    await mkdir(path.join(media, 'nested'), { recursive: true });
    await writeFile(path.join(media, 'alpha.txt'), '0123456789');
    await writeFile(path.join(media, 'empty.bin'), '');
    await writeFile(path.join(media, 'denied.txt'), 'must not be served');
    await writeFile(path.join(media, 'nested', 'payload.bin'), 'nested payload');
    await writeFile(path.join(fixture, 'secret.txt'), 'outside secret');
    await symlink(fixture, path.join(media, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const alpha = await realpath(path.join(media, 'alpha.txt'));
    const before = createHash('sha256').update(await readFile(alpha)).digest('hex');
    const handle = await createMediaHandler(media, async (file) => {
        checks.set(file, (checks.get(file) || 0) + 1);

        if (file.endsWith('denied.txt')) {
            throw new Error('Integrity check failed');
        }

        await readFile(file);
    });

    server = createServer(async (incoming, outgoing) => {
        if (!await handle(incoming, outgoing)) {
            outgoing.writeHead(418).end();
        }
    });
    await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    const redirect = await get(port, '/media');

    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.location, '/media/');
    assert.match((await get(port, '/media/')).headers['content-type'], /^text\/html/);
    const directoryProbe = await get(port, '/media/', { headers: { Range: 'bytes=0-0' } });

    assert.equal(directoryProbe.status, 206);
    assert.equal(directoryProbe.body.toString(), '<');
    const listing = await get(port, '/media/index.list');

    assert.equal(listing.status, 200);
    assert.match(listing.headers['content-type'], /^text\/plain; charset=utf-8$/);
    assert.deepEqual(listing.body.toString().trim().split('\n').sort(), ['alpha.txt', 'denied.txt', 'empty.bin', 'escape', 'nested']);
    assert.equal(checks.size, 0);
    assert.equal((await get(port, '/media/nested/index.list')).body.toString(), 'payload.bin\n');
    const head = await get(port, '/media/alpha.txt', { method: 'HEAD' });

    assert.equal(head.status, 200);
    assert.equal(head.headers['content-length'], '10');
    assert.equal(head.body.length, 0);
    assert.equal(checks.size, 0);
    const concurrent = await Promise.all(Array.from({ length: 3 }, () => get(port, '/media/alpha.txt')));

    assert.ok(concurrent.every((result) => result.body.toString() === '0123456789'));
    assert.equal(checks.get(alpha), 1);
    const bounded = await get(port, '/media/alpha.txt', { headers: { Range: 'bytes=2-4' } });

    assert.equal(bounded.status, 206);
    assert.equal(bounded.headers['content-range'], 'bytes 2-4/10');
    assert.equal(bounded.body.toString(), '234');
    assert.equal((await get(port, '/media/alpha.txt', { headers: { Range: 'bytes=8-' } })).body.toString(), '89');
    assert.equal((await get(port, '/media/alpha.txt', { headers: { Range: 'bytes=-3' } })).body.toString(), '789');
    assert.equal((await get(port, '/media/alpha.txt', { headers: { Range: 'bytes=7-100' } })).body.toString(), '789');
    const rangeHead = await get(port, '/media/alpha.txt', { method: 'HEAD', headers: { Range: 'bytes=2-4' } });

    assert.equal(rangeHead.status, 206);
    assert.equal(rangeHead.headers['content-length'], '3');
    assert.equal(rangeHead.body.length, 0);
    await Promise.all(['bytes=10-', 'bytes=5-2', 'bytes=-0', 'bytes=1-2,4-5', 'bytes=9007199254740992-'].map(async (range) => {
        const invalid = await get(port, '/media/alpha.txt', { headers: { Range: range } });

        assert.equal(invalid.status, 416);
        assert.equal(invalid.headers['content-range'], 'bytes */10');
    }));
    assert.equal((await get(port, '/media/denied.txt')).status, 404);
    assert.equal((await get(port, '/media/denied.txt')).status, 404);
    assert.equal(checks.get(await realpath(path.join(media, 'denied.txt'))), 1);
    assert.equal((await get(port, '/media/empty.bin')).body.length, 0);
    assert.equal((await get(port, '/media/empty.bin', { headers: { Range: 'bytes=0-' } })).status, 416);
    assert.equal((await get(port, '/media/nested/payload.bin')).body.toString(), 'nested payload');
    assert.equal((await get(port, '/other')).status, 418);
    assert.equal((await get(port, '/media/alpha.txt', { method: 'POST' })).status, 405);
    await Promise.all(['/media/../secret.txt', '/media/%2e%2e/secret.txt', '/media/%2e%2e%2fsecret.txt', '/media/%00', '/media/%5c..%5csecret.txt', '/media/%zz', '/media/C:/secret.txt', '/media/escape/secret.txt', '/media/missing'].map(async (target) => {
        assert.equal((await get(port, target)).status, 404, target);
    }));
    await writeFile(path.join(media, 'nested', 'index.list'), 'collision');
    assert.equal((await get(port, '/media/nested/index.list')).status, 404);
    assert.equal((await get(port, '/media/nested/')).status, 404);
    assert.equal(createHash('sha256').update(await readFile(alpha)).digest('hex'), before);
    assert.equal(checks.get(alpha), 1);
    console.info('Media HTTP fixture: lazy listing, integrity memoization, ranges, methods, traversal, junction escape and unchanged source hash passed.');
} finally {
    if (server) {
        server.closeAllConnections();
        await new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
    }

    const cleanup = await realpath(fixture);

    assert.equal(cleanup, fixtureRoot);
    assert.equal(path.dirname(cleanup), await realpath(tmpdir()));
    assert.ok(path.basename(cleanup).startsWith('zomboid-media-test-'));
    await rm(cleanup, { recursive: true, force: true });
}
