/** @file Synthetic HTTP content fixtures; no game assets are retained. */
import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { test } from 'node:test';
import { openContentDirectory } from '../src/content.js';

const MANIFEST_URL = 'https://example.test/content/manifest.json';
const PATH = 'media/texturepacks/Tiles 2x, floor.pack';

/**
 * Construct a synthetic manifest naming one shared fixture source.
 *
 * @param {number} [size] - Source size.
 * @returns {object} Synthetic manifest.
 */
function manifest(size = 32) {
    return {
        format: 'pz-web-content-directory', formatVersion: 1, sourceBuild: { version: 'unknown' },
        files: [{ path: PATH, size, lastModified: 1_234 }],
        startup: {
            packs: [PATH], cells: [{ x: 0, y: 0, navigation: PATH, header: PATH, lotpack: PATH }],
            character: { model: PATH, idle: PATH, walk: PATH, texture: PATH }, spawn: { x: 190.5, y: 190.5 },
        },
        mods: [],
    };
}

/**
 * Replace only the network boundary; real Response streams enforce byte checks.
 *
 * @param {object} t - Node test context.
 * @param {object} document - Synthetic manifest.
 * @param {(url:URL,options:object)=>object} asset - Asset response callback.
 * @returns {void}
 */
function serve(t, document, asset) {
    t.mock.method(globalThis, 'fetch', (url, options) => {
        if (String(url) === MANIFEST_URL) {
            return Promise.resolve(new Response(JSON.stringify(document)));
        }

        return Promise.resolve(asset(url, options));
    });
}

test('directory range reads preserve literal paths and return only the requested byte window', async (t) => {
    const bytes = Uint8Array.from({ length: 32 }, (_, index) => index);
    const events = [];

    serve(t, manifest(), (url, options) => {
        assert.equal(String(url), 'https://example.test/content/media/texturepacks/Tiles%202x%2C%20floor.pack');
        assert.equal(options.headers.Range, 'bytes=7-11');
        assert.equal(options.redirect, 'error');

        return new Response(bytes.subarray(7, 12), { status: 206, headers: { 'Content-Range': 'bytes 7-11/32', 'Content-Length': '5' } });
    });
    const directory = await openContentDirectory(MANIFEST_URL, {
        /**
         * Record progress for the requested byte window.
         *
         * @param {{path:string,loaded:number,total:number|null}} event - Completed byte count for this source.
         * @returns {number} Number of recorded progress events.
         */
        onProgress: (event) => events.push(event),
    });
    const source = directory.getFile(PATH);

    assert.equal(source.name, 'Tiles 2x, floor.pack');
    assert.equal(source.relativePath, PATH);
    assert.equal(source.size, 32);
    assert.equal(source.lastModified, 1_234);
    assert.deepEqual([...new Uint8Array(await source.slice(7, 12).arrayBuffer())], [7, 8, 9, 10, 11]);
    assert.ok(events.some((event) => event.path === PATH && event.loaded === 5 && event.total === 5));
    assert.throws(() => directory.getFile('missing.pack'), /content missing/i);
});

test('untrusted interaction and audio roles are rejected before any private asset request', async (t) => {
    for (const roles of [
        { tileDefinitions: [{ path: '../private.tiles', fileId: 1 }] },
        { tileDefinitions: [{ path: PATH, fileId: null }] },
        { audio: { footstep: PATH, doorOpen: 'media/missing.wav', doorClose: PATH } },
    ]) {
        const document = manifest();

        Object.assign(document.startup, roles);
        serve(t, document, () => assert.fail('Invalid roles must not request private assets'));
        // eslint-disable-next-line no-await-in-loop -- Each manifest boundary is independently rejected.
        await assert.rejects(openContentDirectory(MANIFEST_URL), /path|source|fileId|manifest|audio|tile/u);
    }
});

test('ignored ranges cancel their body without consuming a whole asset bank', async (t) => {
    let canceled = false;
    let read = false;

    serve(t, manifest(1_024 ** 3), () => ({
        status: 200, headers: new Headers(),
        body: {
            /**
             * Mark the ignored response body as canceled.
             *
             * @returns {Promise<void>} Completed cancellation.
             */
            cancel: () => {
                canceled = true;

                return Promise.resolve();
            },
        },
        /**
         * Reject any attempt to allocate the ignored asset body.
         *
         * @returns {Promise<never>} Rejected forbidden allocation.
         */
        arrayBuffer: () => {
            read = true;

            return Promise.reject(new Error('full allocation forbidden'));
        },
    }));
    const directory = await openContentDirectory(MANIFEST_URL);

    await assert.rejects(directory.getFile(PATH).slice(0, 16_384).arrayBuffer(), /range.*206|ignored/i);
    assert.equal(canceled, true);
    assert.equal(read, false);
});

test('malformed range coordinates, stale totals and short or oversized bodies are refused', async (t) => {
    const variants = [
        { range: 'bytes 1-4/32', bytes: [0, 1, 2, 3], error: /content-range/i },
        { range: 'bytes 0-3/33', bytes: [0, 1, 2, 3], error: /stale manifest/i },
        { range: 'bytes 0-3/*', bytes: [0, 1, 2, 3], error: /content-range/i },
        { range: 'bytes 0-3/32', bytes: [0, 1, 2], error: /truncated/i },
        { range: 'bytes 0-3/32', bytes: [0, 1, 2, 3, 4], error: /length|oversized/i },
        { range: 'bytes 0-3/32', bytes: [0, 1, 2, 3], length: '5', error: /length/i },
    ];
    let variant;

    serve(t, manifest(), () => new Response(Uint8Array.from(variant.bytes), {
        status: 206, headers: { 'Content-Range': variant.range, ...(variant.length ? { 'Content-Length': variant.length } : {}) },
    }));
    const directory = await openContentDirectory(MANIFEST_URL);

    for (variant of variants) {
        // eslint-disable-next-line no-await-in-loop -- Each fixture replaces the same synthetic HTTP response.
        await assert.rejects(directory.getFile(PATH).slice(0, 4).arrayBuffer(), variant.error);
    }
});

test('invalid manifest paths and versions never reach asset fetches', async (t) => {
    let document;

    t.mock.method(globalThis, 'fetch', (url) => {
        assert.equal(String(url), MANIFEST_URL, 'invalid manifests must not issue asset requests');

        return Promise.resolve(new Response(JSON.stringify(document)));
    });

    for (const path of ['../escape', '/absolute', 'media/../escape', 'media/./x', 'media\\x', 'https://remote.test/x', 'media/%2e%2e/x', 'media/x?y', 'media/x#y', 'media//x', 'media/\u0000x', 'media/\u001Fx', 'media/\u007Fx']) {
        document = manifest();
        document.files[0].path = path;
        // eslint-disable-next-line no-await-in-loop -- Validate each manifest before replacing the shared response.
        await assert.rejects(openContentDirectory(MANIFEST_URL), /path/i);
    }

    document = manifest();
    document.formatVersion = 2;
    await assert.rejects(openContentDirectory(MANIFEST_URL), /version/i);
    document = manifest();
    document.files.push({ ...document.files[0] });
    await assert.rejects(openContentDirectory(MANIFEST_URL), /duplicate/i);
    document = manifest();
    document.startup.character.model = 'missing.x';
    await assert.rejects(openContentDirectory(MANIFEST_URL), /missing/i);
    document = manifest();
    document.files[0].size = -1;
    await assert.rejects(openContentDirectory(MANIFEST_URL), /size/i);
});

test('small sources materialize decoder Files automatically, while large full reads are refused', async (t) => {
    serve(t, manifest(4), (_url, options) => {
        assert.equal(options.headers.Range, 'bytes=0-3');

        return new Response(Uint8Array.from([65, 66, 67, 68]), { status: 206, headers: { 'Content-Range': 'bytes 0-3/4' } });
    });
    const directory = await openContentDirectory(MANIFEST_URL);
    const source = directory.getFile(PATH);

    assert.equal(await source.text(), 'ABCD');
    const file = await source.toFile();

    assert.ok(file instanceof File);
    assert.equal(file.name, 'Tiles 2x, floor.pack');
    assert.equal(file.lastModified, 1_234);
    assert.equal(await file.text(), 'ABCD');
    assert.equal((await source.blob()).size, 4);
});

test('read bounds reject large allocations and invalid windows before any asset request', async (t) => {
    serve(t, manifest(1_024 ** 3), () => {
        throw new Error('oversized fetch forbidden');
    });
    const source = (await openContentDirectory(MANIFEST_URL)).getFile(PATH);

    await assert.rejects(source.arrayBuffer(), /16 mib|limit/i);
    await assert.rejects(source.blob(), /16 mib|limit/i);
    await assert.rejects(source.text(), /16 mib|limit/i);
    await assert.rejects(source.toFile(), /16 mib|limit/i);
    await assert.rejects(source.slice(0, 16 * 1_024 * 1_024 + 1).arrayBuffer(), /limit/i);
    assert.throws(() => source.slice(-1, 4), /range/i);
    assert.throws(() => source.slice(4, 3), /range/i);
    assert.throws(() => source.slice(0, Number.NaN), /range/i);
    assert.throws(() => source.slice(0, source.size + 1), /range/i);
    assert.equal((await source.slice(4, 4).arrayBuffer()).byteLength, 0);
});

test('abort signals prevent further reads and cancel an active streamed response', async (t) => {
    const controller = new AbortController();
    let canceled = false;

    serve(t, manifest(), (_url, options) => {
        assert.equal(options.signal, controller.signal);

        return new Response(new ReadableStream({
            /** Abort when the reader requests the synthetic response. */
            pull() {
                controller.abort();
            },
            /** Record whether the rejected/aborted stream was canceled. */
            cancel() {
                canceled = true;
            },
        }), { status: 206, headers: { 'Content-Range': 'bytes 0-3/32' } });
    });
    const source = (await openContentDirectory(MANIFEST_URL, { signal: controller.signal })).getFile(PATH);

    await assert.rejects(source.slice(0, 4).arrayBuffer(), { name: 'AbortError' });
    assert.equal(canceled, true);
    await assert.rejects(source.slice(4, 8).arrayBuffer(), { name: 'AbortError' });
});

test('missing manifest and missing range assets produce actionable content errors', async (t) => {
    t.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response(null, { status: 404 })));
    await assert.rejects(openContentDirectory(MANIFEST_URL), /content missing/i);
    serve(t, manifest(), () => new Response(null, { status: 404 }));
    const source = (await openContentDirectory(MANIFEST_URL)).getFile(PATH);

    await assert.rejects(source.slice(0, 4).arrayBuffer(), /content missing/i);
});

test('manifest URL credentials and non-HTTP schemes are refused before fetching', async (t) => {
    t.mock.method(globalThis, 'fetch', () => Promise.reject(new Error('unexpected network request')));
    await assert.rejects(openContentDirectory('data:application/json,{}'), /approved/i);
    await assert.rejects(openContentDirectory('https://user:password@example.test/content/manifest.json'), /approved/i);
    await assert.rejects(openContentDirectory(`${MANIFEST_URL}#other`), /approved/i);
});

test('oversized streamed ranges cancel before retaining bytes beyond the requested window', async (t) => {
    let canceled = false;

    serve(t, manifest(), () => new Response(new ReadableStream({
        /**
         * Supply more than the four bytes requested by the actual source.
         *
         * @param {ReadableStreamDefaultController<Uint8Array>} controller - Synthetic response stream controller.
         */
        start(controller) {
            controller.enqueue(Uint8Array.from([1, 2, 3, 4, 5]));
        },
        /** Observe cancellation by the bounded reader. */
        cancel() {
            canceled = true;
        },
    }), { status: 206, headers: { 'Content-Range': 'bytes 0-3/32' } }));
    const source = (await openContentDirectory(MANIFEST_URL)).getFile(PATH);

    await assert.rejects(source.slice(0, 4).arrayBuffer(), /oversized|limit/i);
    assert.equal(canceled, true);
});
