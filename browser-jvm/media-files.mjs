import { createReadStream } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

/**
 * Checks that a canonical target remains inside the canonical media directory.
 *
 * @param {string} root - Canonical media directory.
 * @param {string} target - Canonical requested target.
 * @returns {boolean} Whether the target is contained.
 */
function contained(root, target) {
    const relative = path.relative(root, target);

    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * Parses one HTTP byte range without accepting unsafe numeric offsets.
 *
 * @param {string|undefined} header - Optional Range header.
 * @param {number} size - Actual file byte length.
 * @returns {number[]} Inclusive start and end, or an empty array for an invalid range.
 */
function byteRange(header, size) {
    if (!header) {
        return [0, size - 1];
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(header);

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
 * Creates a lazy, read-only HTTP view of one installed media directory.
 *
 * @param {string} mediaRoot - Existing media directory, never written by this handler.
 * @param {function(string): Promise<void>} beforeRead - Required asynchronous integrity callback receiving the canonical file path.
 * @returns {Promise<function(import('node:http').IncomingMessage, import('node:http').ServerResponse): Promise<boolean>>} Request handler returning whether the /media namespace was handled.
 */
export async function createMediaHandler(mediaRoot, beforeRead) {
    if (typeof beforeRead !== 'function') {
        throw new TypeError('Media integrity callback is required');
    }

    const root = await realpath(mediaRoot);

    if (!(await stat(root)).isDirectory()) {
        throw new TypeError('Media root must be a directory');
    }

    const checked = new Map();

    /**
     * Serves one validated media request, closing errors at the HTTP boundary.
     *
     * @param {import('node:http').IncomingMessage} request - Incoming HTTP request.
     * @param {import('node:http').ServerResponse} response - HTTP response to populate.
     * @returns {Promise<boolean>} Whether this handler owns the requested namespace.
     */
    return async function handleMedia(request, response) {
        const raw = request.url.split('?')[0];

        if (raw !== '/media' && !raw.startsWith('/media/')) {
            return false;
        }

        try {
            if (!['GET', 'HEAD'].includes(request.method)) {
                response.writeHead(405, { Allow: 'GET, HEAD' }).end();

                return true;
            }

            const decoded = decodeURIComponent(raw);
            const parts = decoded.slice('/media'.length).split('/').filter(Boolean);

            if (/[\0\\]/.test(decoded) || /%2f|%5c/i.test(raw) || parts.some((part) => part === '.' || part === '..' || part.includes(':'))) {
                response.writeHead(404).end();

                return true;
            }

            const metadata = parts.at(-1)?.toLowerCase() === 'index.list';
            const targetParts = metadata ? parts.slice(0, -1) : parts;
            const target = await realpath(path.join(root, ...targetParts));

            if (!contained(root, target)) {
                response.writeHead(404).end();

                return true;
            }

            const info = await stat(target);

            if (info.isDirectory()) {
                const children = await readdir(target);

                if (children.some((name) => name.toLowerCase() === 'index.list' || /[\n\r\\]/.test(name))) {
                    throw new Error('Media directory conflicts with reserved listing metadata');
                }

                if (!metadata && !raw.endsWith('/')) {
                    response.writeHead(301, { Location: `${raw}/`, 'Content-Length': 0 }).end();

                    return true;
                }

                const body = metadata ? `${children.join('\n')}${children.length ? '\n' : ''}` : '<html><head><title>Media directory</title></head><body>Media directory</body></html>\n';
                const bytes = Buffer.from(body);

                const range = byteRange(request.headers.range, bytes.length);

                if (!range.length) {
                    response.writeHead(416, { 'Content-Range': `bytes */${bytes.length}`, 'Content-Length': 0 }).end();

                    return true;
                }

                const [start, end] = range;
                const headers = { 'Accept-Ranges': 'bytes', 'Content-Type': metadata ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8', 'Content-Length': Math.max(0, end - start + 1) };

                if (request.headers.range) {
                    headers['Content-Range'] = `bytes ${start}-${end}/${bytes.length}`;
                }

                response.writeHead(request.headers.range ? 206 : 200, headers);
                response.end(request.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1));

                return true;
            }

            if (metadata || !info.isFile() || raw.endsWith('/')) {
                response.writeHead(404).end();

                return true;
            }

            const range = byteRange(request.headers.range, info.size);

            if (!range.length) {
                response.writeHead(416, { 'Content-Range': `bytes */${info.size}`, 'Content-Length': 0 }).end();

                return true;
            }

            const [start, end] = range;
            const headers = { 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream', 'Content-Length': Math.max(0, end - start + 1) };

            if (request.headers.range) {
                headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
            }

            if (request.method === 'HEAD' || !info.size) {
                response.writeHead(request.headers.range ? 206 : 200, headers).end();

                return true;
            }

            if (!checked.has(target)) {
                checked.set(target, Promise.resolve().then(() => beforeRead(target)));
            }

            await checked.get(target);
            response.writeHead(request.headers.range ? 206 : 200, headers);
            await pipeline(createReadStream(target, { start, end }), response);
        } catch {
            if (response.headersSent) {
                response.destroy();
            } else {
                response.writeHead(404).end();
            }
        }

        return true;
    };
}
