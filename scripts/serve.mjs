import { readFile, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';

const root = resolve('dist');
const mime = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.json': 'application/json',
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
 * Resolve a request to a real regular file inside the served root.
 *
 * The lexical prefix check rejects written traversal; the resolved check rejects links,
 * junctions and any ancestor that points outside the root. The root is resolved per
 * request so the server may start before `dist` exists.
 *
 * @param {string} pathname - Requested pathname, still percent-encoded.
 * @returns {Promise<string>} Resolved path of the file that may be served.
 * @throws {Error} When the root is absent or the request is not an approvable file.
 */
async function resolveFile(pathname) {
    const realRoot = await realpath(root);
    const requested = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    const candidate = resolve(realRoot, `.${requested}`);

    if (!contains(realRoot, candidate)) {
        throw new Error(`Request leaves the served root: ${pathname}`);
    }

    const resolved = await realpath(candidate);
    const info = await stat(resolved);

    if (!contains(realRoot, resolved) || !info.isFile()) {
        throw new Error(`Request is not a served regular file: ${pathname}`);
    }

    return resolved;
}

/**
 * Serve application files only, never private installation/content directories.
 *
 * @param {import('node:http').IncomingMessage} request - Incoming static-file request.
 * @param {import('node:http').ServerResponse} response - Outgoing HTTP response.
 * @returns {Promise<void>} Resolves after a bounded static response.
 */
async function handleRequest(request, response) {
    try {
        if (!['GET', 'HEAD'].includes(request.method)) {
            response.writeHead(405).end();

            return;
        }

        const url = new URL(request.url, 'http://localhost');
        const path = await resolveFile(url.pathname);
        const body = await readFile(path);

        response.writeHead(200, {
            'Content-Type': mime[extname(path)] ?? 'application/octet-stream',
            'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        });
        response.end(request.method === 'HEAD' ? undefined : body);
    } catch {
        response.writeHead(404).end();
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

    console.info(`Preview http://${address} (application only; no simulation or asset service)`);
}

const server = createServer(handleRequest);

server.listen(port, host, announce);
