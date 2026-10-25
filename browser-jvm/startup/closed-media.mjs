import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdtemp, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Checks actual named/open source identity across a copy or enumeration.
 *
 * @param {object} first - Actual bigint metadata.
 * @param {object} last - Later actual bigint metadata.
 * @returns {boolean} Whether all relevant source identity fields match.
 */
function unchanged(first, last) {
    return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode'].every((name) => first[name] === last[name]);
}

/**
 * Admits only the reviewed unambiguous ASCII namespace, including reserved listing checks.
 *
 * @param {string} name - Actual media-relative path.
 * @returns {boolean} Whether a path has the supported exact spelling.
 */
function ordinary(name) {
    return /^[\x20-\x7E]+$/u.test(name) && !/[\\:?#~]/u.test(name)
        && name.split('/').every((part) => part && part !== '.' && part !== '..'
            && !/[. ]$/u.test(part) && part.toLowerCase() !== 'index.list');
}

/**
 * Preserves the existing single HTTP byte range policy, including zero-file416.
 *
 * @param {string|undefined} header - Actual Range header.
 * @param {number} size - Frozen selected representation size.
 * @returns {number[]} Inclusive range, or no valid range.
 */
function byteRange(header, size) {
    if (!header) {
        return [0, size - 1];
    }

    const match = /^bytes=(\d*)-(\d*)$/u.exec(header);

    if (!match || (!match[1] && !match[2]) || !size) {
        return [];
    }

    const first = Number(match[1]);
    const last = Number(match[2]);

    if (![first, last].every(Number.isSafeInteger)) {
        return [];
    }

    if (!match[1]) {
        return last > 0 ? [Math.max(0, size - last), size - 1] : [];
    }

    const end = match[2] ? Math.min(last, size - 1) : size - 1;

    return first <= end ? [first, end] : [];
}

/**
 * Freezes complete directory names/order and binds each file to its existing byte ledger.
 *
 * @param {string} root - Actual canonical media directory.
 * @param {Array<object>} ledger - Previously hashed file paths, sizes and SHA256s.
 * @returns {Promise<Map>} Private immutable-by-ownership entry table.
 */
async function directoryIndex(root, ledger) {
    const expected = new Map();

    for (const record of ledger) {
        assert.ok(ordinary(record.path));
        assert.ok(Number.isSafeInteger(record.bytes) && record.bytes >= 0);
        assert.match(record.sha256, /^[a-f0-9]{64}$/u);
        assert.equal(expected.has(record.path.toLowerCase()), false);
        expected.set(record.path.toLowerCase(), { ...record });
    }

    const entries = new Map();
    const directories = [];
    const stack = [''];
    const found = new Set();

    // Preserve actual readdir order; sorting would change original index.list semantics.
    /* eslint-disable no-await-in-loop */
    while (stack.length) {
        const relative = stack.pop();
        const actual = path.join(root, relative);
        const before = await lstat(actual, { bigint: true });

        assert.ok(before.isDirectory() && !before.isSymbolicLink());
        assert.equal(await realpath(actual), actual);
        const children = await readdir(actual);
        const directory = { relative, kind: 'directory', children: [...children] };

        assert.equal(entries.has(relative.toLowerCase()), false);
        entries.set(relative.toLowerCase(), directory);

        for (const child of children) {
            const childRelative = relative ? `${relative}/${child}` : child;

            assert.ok(ordinary(childRelative), childRelative);
            const file = path.join(root, childRelative);
            const info = await lstat(file, { bigint: true });

            assert.equal(info.isSymbolicLink(), false, childRelative);
            assert.equal(await realpath(file), file);

            if (info.isDirectory()) {
                // Check case collisions even before a deferred directory is visited.
                assert.equal(found.has(childRelative.toLowerCase()), false);
                found.add(childRelative.toLowerCase());
                stack.push(childRelative);
            } else {
                assert.ok(info.isFile(), childRelative);
                assert.equal(found.has(childRelative.toLowerCase()), false);
                found.add(childRelative.toLowerCase());
                const record = expected.get(childRelative.toLowerCase());

                assert.ok(record && record.path === childRelative, `File absent from exact ledger: ${childRelative}`);
                assert.equal(info.size, BigInt(record.bytes));
                entries.set(childRelative.toLowerCase(), { relative: childRelative, kind: 'file', ...record });
                expected.delete(childRelative.toLowerCase());
            }
        }

        assert.ok(unchanged(before, await lstat(actual, { bigint: true })));
        directories.push({ actual, before });
    }

    assert.equal(expected.size, 0, 'Ledger file missing during namespace freeze');

    for (const directory of directories) {
        assert.ok(unchanged(directory.before, await lstat(directory.actual, { bigint: true })));
    }
    /* eslint-enable no-await-in-loop */

    return entries;
}

/**
 * Creates one closed session namespace and lazy verified owned-byte snapshot owner.
 *
 * @param {object} options - Exact source/ledger/candidate identities.
 * @param {string} options.mediaRoot - Actual original media directory, never written.
 * @param {Array<object>} options.ledger - Existing complete file identity ledger.
 * @param {Array<string>} options.absent - Individually requested exact candidate spellings.
 * @param {string} options.hookSource - Pinned original runtime metadata function text.
 * @param {string} options.snapshotParent - Existing owned temporary-volume parent.
 * @returns {Promise<object>} HTTP owner, exact negative certificate and bounded diagnostics.
 */
async function createClosedMedia({ mediaRoot, ledger, absent, hookSource, snapshotParent }) {
    const root = await realpath(mediaRoot);

    assert.equal((await lstat(mediaRoot)).isSymbolicLink(), false);
    const entries = await directoryIndex(root, ledger);
    const names = new Set(absent);

    assert.equal(names.size, absent.length);

    /* eslint-disable no-await-in-loop */
    for (const name of names) {
        assert.ok(name.startsWith('/media/') && ordinary(name.slice(7)) && !name.includes('%'));
        assert.equal(entries.has(name.slice(7).toLowerCase()), false, name);
        // Prove this original Windows spelling did not resolve to a positive alias at freeze.
        await assert.rejects(lstat(path.join(root, name.slice(7))), { code: 'ENOENT' });
    }

    /* eslint-enable no-await-in-loop */

    const namespace = [...entries.values()].map((entry) => ({ ...entry }));
    const namespaceSHA = createHash('sha256').update(JSON.stringify(namespace)).digest('hex');
    const certificate = Object.freeze({
        schema: 'closed-media-negative-v1', closedNamespace: true,
        namespaceSHA, absent: Object.freeze([...names]), hookSource,
    });

    return createOwner({ root, entries, certificate, namespace, snapshotParent });
}

/**
 * Loads exact admitted metadata artifacts without enumerating or recertifying the source tree.
 *
 * @param {object} options - Exact prepared artifact paths and immutable SHA identities.
 * @param {string} options.mediaRoot - Actual original source root, never written.
 * @param {string} options.namespaceFile - Prepared complete file/directory index.
 * @param {string} options.namespaceSHA256 - Exact index artifact byte hash.
 * @param {string} options.certificateFile - Prepared negative certificate.
 * @param {string} options.certificateSHA256 - Exact certificate artifact byte hash.
 * @param {string} options.ledgerFile - Original complete file ledger.
 * @param {string} options.ledgerSHA256 - Original ledger byte hash.
 * @param {string} options.hookSource - Pinned original metadata function text.
 * @param {string} options.snapshotParent - Owned temporary-volume parent.
 * @returns {Promise<object>} Validated namespace owner with no source enumeration.
 */
async function loadClosedMedia({ mediaRoot, namespaceFile, namespaceSHA256, certificateFile, certificateSHA256, ledgerFile, ledgerSHA256, hookSource, snapshotParent }) {
    const artifacts = await Promise.all([
        [namespaceFile, namespaceSHA256], [certificateFile, certificateSHA256], [ledgerFile, ledgerSHA256],
    ].map(async ([file, expected]) => {
        assert.match(expected, /^[a-f0-9]{64}$/u);
        const bytes = await readFile(file);

        assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, file);

        return JSON.parse(bytes.toString('utf8'));
    }));
    const [namespace, certificate, ledger] = artifacts;

    assert.ok(Array.isArray(namespace) && Array.isArray(ledger));
    assert.deepEqual(Object.keys(certificate).sort(), ['absent', 'closedNamespace', 'hookSource', 'namespaceSHA', 'schema']);
    assert.equal(certificate.schema, 'closed-media-negative-v1');
    assert.equal(certificate.closedNamespace, true);
    assert.equal(certificate.hookSource, hookSource);
    assert.equal(certificate.namespaceSHA, createHash('sha256').update(JSON.stringify(namespace)).digest('hex'));
    const entries = new Map();
    const expected = new Map();

    for (const record of ledger) {
        assert.deepEqual(Object.keys(record).sort(), ['bytes', 'path', 'sha256']);
        assert.ok(ordinary(record.path) && Number.isSafeInteger(record.bytes) && record.bytes >= 0);
        assert.match(record.sha256, /^[a-f0-9]{64}$/u);
        assert.equal(expected.has(record.path.toLowerCase()), false);
        expected.set(record.path.toLowerCase(), record);
    }

    for (const entry of namespace) {
        assert.ok(entry && typeof entry === 'object' && typeof entry.relative === 'string');
        assert.ok(entry.relative === '' || ordinary(entry.relative));
        assert.equal(entries.has(entry.relative.toLowerCase()), false);

        if (entry.kind === 'directory') {
            assert.deepEqual(Object.keys(entry).sort(), ['children', 'kind', 'relative']);
            assert.ok(Array.isArray(entry.children));
        } else {
            assert.equal(entry.kind, 'file');
            assert.deepEqual(Object.keys(entry).sort(), ['bytes', 'kind', 'path', 'relative', 'sha256']);
            const record = expected.get(entry.relative.toLowerCase());

            assert.ok(record);
            assert.equal(entry.relative, record.path);
            assert.equal(entry.path, record.path);
            assert.equal(entry.bytes, record.bytes);
            assert.equal(entry.sha256, record.sha256);
            expected.delete(entry.relative.toLowerCase());
        }

        entries.set(entry.relative.toLowerCase(), entry);
    }

    assert.equal(expected.size, 0);
    assert.equal(entries.get('')?.kind, 'directory');
    const membership = new Set(['']);

    for (const entry of namespace.filter((item) => item.kind === 'directory')) {
        for (const child of entry.children) {
            assert.ok(typeof child === 'string' && ordinary(child) && !child.includes('/'));
            const relative = entry.relative ? `${entry.relative}/${child}` : child;
            const target = entries.get(relative.toLowerCase());

            assert.ok(target && target.relative === relative);
            assert.equal(membership.has(relative.toLowerCase()), false);
            membership.add(relative.toLowerCase());
        }
    }

    assert.equal(membership.size, entries.size, 'Every indexed entry has exactly one directory parent');
    assert.ok(Array.isArray(certificate.absent));
    assert.equal(new Set(certificate.absent).size, certificate.absent.length);

    for (const name of certificate.absent) {
        assert.ok(typeof name === 'string' && name.startsWith('/media/') && ordinary(name.slice(7)) && !name.includes('%'));
        assert.match(name, /\.(?:png|fbx|glb)$/u);
        assert.equal(entries.has(name.slice(7).toLowerCase()), false);
    }

    const root = await realpath(mediaRoot);

    assert.equal((await lstat(mediaRoot)).isSymbolicLink(), false);

    return createOwner({
        root, entries, namespace,
        certificate: Object.freeze({ ...certificate, absent: Object.freeze([...certificate.absent]) }), snapshotParent,
    });
}

/**
 * Owns serving and lazy byte copies for one already frozen namespace.
 *
 * @param {object} options - Privately validated namespace and source owner.
 * @param {string} options.root - Actual canonical source directory.
 * @param {Map} options.entries - Exact frozen index.
 * @param {object} options.certificate - Matching exact negatives.
 * @param {Array<object>} options.namespace - Immutable description.
 * @param {string} options.snapshotParent - Owned temporary-volume parent.
 * @returns {Promise<object>} One HTTP and payload owner.
 */
async function createOwner({ root, entries, certificate, namespace, snapshotParent }) {
    const namespaceSHA = certificate.namespaceSHA;
    const parent = await realpath(snapshotParent);
    const outside = path.relative(root, parent);

    assert.ok(outside === '..' || outside.startsWith(`..${path.sep}`) || path.isAbsolute(outside));
    const snapshots = await mkdtemp(path.join(parent, 'pz-media-verified-'));
    const copies = new Map();
    const requests = new Set();
    let active = true;
    let terminal;
    let published = 0;
    let publishedBytes = 0;
    let preparationDeadline = null;
    const publications = [];
    const cleanupFailures = [];
    const malformedRequests = [];
    const transportFailures = [];

    /**
     * Copies one actual source once and publishes only its verified complete byte identity.
     *
     * @param {object} record - Frozen canonical file identity.
     * @returns {Promise<string>} Actual owned verified snapshot path.
     */
    async function copy(record) {
        const source = path.join(root, record.relative);
        const before = await lstat(source, { bigint: true });

        assert.ok(before.isFile() && !before.isSymbolicLink());
        assert.equal(await realpath(source), source);
        const handle = await open(source, 'r');
        const output = path.join(snapshots, createHash('sha256').update(record.relative).digest('hex'));
        const pending = `${output}.pending`;
        const digest = createHash('sha256');
        let count = 0;
        let primary;
        const observe = new Transform({
            /**
             * Hashes exactly the bytes copied into this owner's pending snapshot.
             *
             * @param {Buffer} bytes - Actual read bytes.
             * @param {string} encoding - Stream encoding.
             * @param {function(Error|null, Buffer=):void} callback - Original stream completion.
             */
            transform(bytes, encoding, callback) {
                if (preparationDeadline !== null && Date.now() >= preparationDeadline) {
                    callback(new Error('Eager publication deadline'));

                    return;
                }

                count += bytes.length;
                digest.update(bytes);
                callback(null, bytes);
            },
        });

        try {
            assert.ok(unchanged(before, await handle.stat({ bigint: true })));
            await pipeline(handle.createReadStream({ autoClose: false }), observe, createWriteStream(pending, { flags: 'wx' }));
            assert.equal(count, record.bytes);
            assert.equal(digest.digest('hex'), record.sha256);
            assert.ok(unchanged(before, await handle.stat({ bigint: true })));
            assert.ok(unchanged(before, await lstat(source, { bigint: true })));
            assert.equal(await realpath(source), source);
            assert.ok(active, 'Closed media owner disposed before snapshot publication');
            await rename(pending, output);
            published++;
            publishedBytes += count;
            publications.push({ source, snapshot: output, bytes: count, sha256: record.sha256 });
        } catch (error) {
            primary = error;
        } finally {
            try {
                await handle.close();
            } catch (error) {
                cleanupFailures.push(String(error.stack ?? error));

                if (!primary) {
                    primary = error;
                }
            }

            try {
                await unlink(pending);
            } catch (error) {
                if (error.code !== 'ENOENT') {
                    cleanupFailures.push(String(error.stack ?? error));
                    primary ??= error;
                }
            }
        }

        if (primary) {
            throw primary;
        }

        return output;
    }

    /**
     * Reuses the existing single-owner verified copy promise.
     *
     * @param {object} entry - Actual frozen file record.
     * @returns {Promise<string>} Actual published snapshot path.
     */
    function ensurePublished(entry) {
        if (!copies.has(entry.relative)) {
            copies.set(entry.relative, copy(entry).catch((error) => {
                terminal ??= error;
                throw error;
            }));
        }

        return copies.get(entry.relative);
    }

    /**
     * Serves only indexed metadata and verified owned bytes; never discovers new names.
     *
     * @param {object} request - Actual HTTP request.
     * @param {object} response - Actual HTTP response.
     * @returns {Promise<boolean>} Whether this owner handled the namespace.
     */
    async function serve(request, response) {
        const raw = request.url.split('?')[0];

        if (raw !== '/media' && !raw.startsWith('/media/')) {
            return false;
        }

        try {
            if (!active) {
                response.writeHead(500, { 'Content-Length': 0 }).end();

                return true;
            }

            if (terminal) {
                throw terminal;
            }

            if (!['GET', 'HEAD'].includes(request.method)) {
                response.writeHead(405, { Allow: 'GET, HEAD' }).end();

                return true;
            }

            let decoded;

            try {
                decoded = decodeURIComponent(raw);
            } catch (error) {
                malformedRequests.push({ path: raw, error: String(error.stack ?? error) });
                response.writeHead(404).end();

                return true;
            }

            const parts = decoded.slice(6).split('/').filter(Boolean);

            if (/[\0\\]/u.test(decoded) || /%2f|%5c/iu.test(raw) || parts.some((part) => part === '.' || part === '..' || part.includes(':'))) {
                response.writeHead(404).end();

                return true;
            }

            const metadata = parts.at(-1)?.toLowerCase() === 'index.list';
            const relative = (metadata ? parts.slice(0, -1) : parts).join('/');
            const entry = entries.get(relative.toLowerCase());

            if ((relative && !ordinary(relative)) || !entry || (entry.kind === 'file' && (metadata || raw.endsWith('/')))) {
                response.writeHead(404).end();

                return true;
            }

            let body;
            let file;

            if (entry.kind === 'directory') {
                if (!metadata && !raw.endsWith('/')) {
                    response.writeHead(301, { Location: `${raw}/`, 'Content-Length': 0 }).end();

                    return true;
                }

                body = Buffer.from(metadata ? `${entry.children.join('\n')}${entry.children.length ? '\n' : ''}` : '<html><head><title>Media directory</title></head><body>Media directory</body></html>\n');
            }

            const size = body ? body.length : entry.bytes;
            const range = byteRange(request.headers.range, size);

            if (!range.length) {
                response.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Content-Length': 0 }).end();

                return true;
            }

            if (!body) {
                file = await ensurePublished(entry);

                if (!active) {
                    response.writeHead(500, { 'Content-Length': 0 }).end();

                    return true;
                }
            }

            const [start, end] = range;
            let type = 'application/octet-stream';

            if (body) {
                type = metadata ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8';
            }

            const headers = { 'Accept-Ranges': 'bytes', 'Content-Type': type, 'Content-Length': Math.max(0, end - start + 1) };

            if (request.headers.range) {
                headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
            }

            response.writeHead(request.headers.range ? 206 : 200, headers);

            if (request.method === 'HEAD' || !size) {
                response.end();
            } else if (body) {
                response.end(body.subarray(start, end + 1));
            } else {
                const stream = createReadStream(file, { start, end });

                // A verified owned-file read failure is not a client transport cancellation.
                stream.once('error', (error) => {
                    if (!response.destroyed) {
                        terminal ??= error;
                    }
                });
                await pipeline(stream, response);
            }
        } catch (error) {
            if (error !== terminal) {
                transportFailures.push({ path: raw, code: error.code ?? null, error: String(error.stack ?? error) });
            }

            if (response.headersSent) {
                response.destroy(error);
            } else {
                response.writeHead(500, { 'Content-Length': 0 }).end();
            }
        }

        return true;
    }

    return {
        /**
         * Publishes one fresh, uncopied namespace before Java using the same verified copy path.
         *
         * @param {object} bounds - Explicit admitted preparation bounds.
         * @param {number} bounds.deadlineAt - Actual host preparation deadline.
         * @param {number} bounds.maxBytes - Maximum admitted source bytes.
         * @returns {Promise<object>} Actual complete publication diagnostics.
         */
        async publishAll({ deadlineAt, maxBytes }) {
            assert.ok(active && terminal === undefined && requests.size === 0 && preparationDeadline === null && published === 0 && copies.size === 0);
            assert.ok(Number.isSafeInteger(deadlineAt) && deadlineAt > Date.now());
            assert.ok(Number.isSafeInteger(maxBytes) && maxBytes >= 0);
            const files = [...entries.values()].filter((entry) => entry.kind === 'file' && entry.bytes > 0);
            const expectedBytes = files.reduce((total, entry) => total + entry.bytes, 0);

            assert.ok(Number.isSafeInteger(expectedBytes) && expectedBytes <= maxBytes);
            preparationDeadline = deadlineAt;

            try {
                for (const entry of files) {
                    assert.ok(active && Date.now() < deadlineAt, 'Eager publication lifetime/deadline');
                    // eslint-disable-next-line no-await-in-loop -- One source and snapshot stream at a time.
                    await ensurePublished(entry);
                }

                assert.equal(published, files.length);
                assert.equal(publishedBytes, expectedBytes);

                return { published, publishedBytes, namespaceSHA };
            } catch (error) {
                terminal ??= error;
                throw error;
            } finally {
                preparationDeadline = null;
            }
        },
        /**
         * Owns each actual HTTP task until its streams and response are complete.
         *
         * @param {object} request - Actual request.
         * @param {object} response - Actual response.
         * @returns {Promise<boolean>} Actual namespace handling completion.
         */
        async handle(request, response) {
            const task = serve(request, response);

            requests.add(task);

            try {
                return await task;
            } finally {
                requests.delete(task);
            }
        },
        certificate,
        /**
         * Copies identities of actual fully verified and published source/snapshot pairs.
         *
         * @returns {Array<object>} Scalar audit records, never live maps or file handles.
         */
        publishedFiles() {
            return publications.map((record) => ({ ...record }));
        },
        namespace: Object.freeze(namespace.map((entry) => Object.freeze({ ...entry, children: entry.children && Object.freeze([...entry.children]) }))),
        /**
         * Reports only owned scalar progress, never mutable source/cache objects.
         *
         * @returns {object} Actual lifetime and snapshot counts.
         */
        diagnostics() {
            return { active, published, publishedBytes, pendingOrCompletedCopies: copies.size, requests: requests.size, namespaceSHA, terminalFailure: terminal?.message ?? null, terminalStack: terminal?.stack ?? null, cleanupFailures: [...cleanupFailures], malformedRequests: [...malformedRequests], transportFailures: [...transportFailures], snapshots };
        },
        /** Waits for actual in-flight copies and closes this namespace without deleting evidence. */
        async dispose() {
            active = false;
            await Promise.allSettled([...copies.values(), ...requests]);
        },
    };
}

export { createClosedMedia, loadClosedMedia };
