import { createReadStream } from 'node:fs';
import { lstat, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { isContentPath } from './provision-content.mjs';

const root = resolve('dist');
const contentRoot = resolve(process.env.CONTENT_ROOT ?? 'content');
const mime = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.json': 'application/json',
    '.mjs': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
    '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.txt': 'text/plain; charset=utf-8',
    '.lua': 'text/plain; charset=utf-8', '.info': 'text/plain; charset=utf-8',
    '.xml': 'application/xml', '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.flac': 'audio/flac',
};
const port = Number(process.env.PORT ?? 4_173);
const host = process.env.HOST ?? '127.0.0.1';

/**
 * Test one resolved path for containment inside one resolved directory.
 *
 * @param {string} directory - Resolved root directory.
 * @param {string} path - Resolved path to test.
 * @returns {boolean} True when the path is that directory or below it.
 */
function contains(directory, path) {
    return path === directory || path.startsWith(directory + sep);
}

/**
 * Canonicalize content without treating Windows short names as directory links.
 *
 * @returns {Promise<string>} Separate content root with no linked ancestors.
 */
async function approvedContentRoot() {
    let directory = contentRoot;

    for (;;) {
        // eslint-disable-next-line no-await-in-loop -- Inspect every lexical ancestor before canonicalizing aliases.
        const info = await lstat(directory);

        if (info.isSymbolicLink() || !info.isDirectory()) {
            throw new Error('Content root has a linked or non-directory ancestor');
        }

        const parent = dirname(directory);

        if (parent === directory) {
            break;
        }

        directory = parent;
    }

    const realRoot = await realpath(contentRoot);
    const realApplicationRoot = await realpath(root);

    if (contains(realApplicationRoot, realRoot) || contains(realRoot, realApplicationRoot)) {
        throw new Error('Content and application roots overlap');
    }

    return realRoot;
}

/**
 * Resolve application or separately provisioned content without escaping either root.
 *
 * @param {string} pathname - Percent-encoded request pathname.
 * @returns {Promise<{path:string,size:number}>} Approved regular file metadata.
 */
async function resolveFile(pathname) {
    const requested = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);

    if (!requested.startsWith('/') || requested.includes('\\') || requested.includes('\0')
        || requested.split('/').some((part) => part === '..' || part === '.')
        || /\.(?:exe|jar|dll|class|lbc|so|dylib)$/iu.test(requested)) {
        throw new Error('Invalid static path');
    }

    const content = requested.startsWith('/content/');
    const realRoot = content ? await approvedContentRoot() : await realpath(root);
    const path = content ? requested.slice('/content/'.length) : requested.slice(1);

    if (content && path !== 'manifest.json' && !isContentPath(path)) {
        throw new Error('Content root or path is not approved');
    }

    const candidate = resolve(realRoot, path);

    if (!contains(realRoot, candidate)) {
        throw new Error('Request leaves the served root');
    }

    const resolved = await realpath(candidate);
    const info = await stat(resolved);

    if (!contains(realRoot, resolved) || !info.isFile()) {
        throw new Error('Request is not a served regular file');
    }

    return { path: resolved, size: info.size };
}

/**
 * Parse one HTTP bytes range; unsupported or unsatisfiable ranges return null.
 *
 * @param {string} value - Range header.
 * @param {number} size - Resource byte length.
 * @returns {{start:number,end:number}|null} Inclusive range or rejection.
 */
function byteRange(value, size) {
    const match = /^bytes=(\d*)-(\d*)$/u.exec(value);

    if (!match || (!match[1] && !match[2]) || size === 0) {
        return null;
    }

    const first = match[1] ? Number(match[1]) : undefined;
    const last = match[2] ? Number(match[2]) : undefined;

    if ((first !== undefined && !Number.isSafeInteger(first)) || (last !== undefined && !Number.isSafeInteger(last))) {
        return null;
    }

    const start = first ?? Math.max(0, size - last);
    const end = first === undefined ? size - 1 : Math.min(last ?? size - 1, size - 1);

    return start >= size || start > end ? null : { start, end };
}

/**
 * Stream static application/content files with real bounded single-range responses.
 *
 * @param {import('node:http').IncomingMessage} request - Static request.
 * @param {import('node:http').ServerResponse} response - Static response.
 * @returns {Promise<void>} Resolves after streaming or a rejected request.
 */
async function handleRequest(request, response) {
    try {
        if (!['GET', 'HEAD'].includes(request.method)) {
            response.writeHead(405, { Allow: 'GET, HEAD' }).end();

            return;
        }

        const url = new URL(request.url, 'http://localhost');
        const { path, size } = await resolveFile(url.pathname);
        const range = request.headers.range === undefined ? undefined : byteRange(request.headers.range, size);
        const headers = {
            'Content-Type': mime[extname(path).toLowerCase()] ?? 'application/octet-stream',
            'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes',
        };

        if (range === null) {
            response.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': 0 }).end();

            return;
        }

        headers['Content-Length'] = range ? range.end - range.start + 1 : size;

        if (range) {
            headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
        }

        response.writeHead(range ? 206 : 200, headers);

        if (request.method === 'HEAD' || size === 0) {
            response.end();

            return;
        }

        await pipeline(createReadStream(path, range ?? {}), response);
    } catch {
        if (response.headersSent) {
            response.destroy();
        } else {
            response.writeHead(404).end();
        }
    }
}

/**
 * Announce the ready local server at the address it actually bound.
 *
 * @returns {void} Logs the local preview address.
 */
function announce() {
    const bound = server.address();
    const address = typeof bound === 'object' && bound !== null ? `${bound.address}:${bound.port}` : `${host}:${port}`;

    console.info(`Preview http://${address} (static application and /content/; simulation runs in browser)`);
}

const server = createServer(handleRequest);

server.listen(port, host, announce);
