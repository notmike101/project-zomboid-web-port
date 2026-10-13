/**
 * @file Application-root service worker that serves stored mod packages.
 *
 * It intercepts `/__mods__/<id>/<revision>/<path>` and nothing else: the app shell,
 * the WASM engine, imported art and every other request go to the network exactly as
 * they did before this worker existed. Package bytes are read straight from the
 * IndexedDB store the manager writes, so an update is visible on the next import
 * instead of being hidden behind an HTTP cache — responses are `no-store` by design.
 *
 * `src/mod-manager.js` registers this file as a module worker, which is why it can
 * reuse the manager's schema and path validation instead of restating them here.
 */

import { MOD_URL_PREFIX, readPackageFile, splitModPath } from './src/mod-manager.js';

/* The repository ESLint config declares browser globals for `src/**` only, so this
   root-level worker reaches its own global scope through one documented alias. */
const workerScope = globalThis;

/**
 * Plain-text error body for a request the worker can answer but will not.
 *
 * @param {string} message - Reason to hand back.
 * @param {number} status - HTTP status to use.
 * @returns {object} Response with no-store and nosniff headers.
 */
function refusal(message, status) {
    return new workerScope.Response(message, {
        status,
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
        },
    });
}

/**
 * Answers one package-file request from IndexedDB.
 *
 * @param {URL} url - Request URL under the package prefix.
 * @returns {Promise<object>} Stored bytes with their recorded type, or a 404 when the
 * id, revision or path is malformed or absent. No path is ever resolved on disk.
 */
async function packageResponse(url) {
    const parts = splitModPath(url.pathname);

    if (!parts) {
        return refusal('malformed package request', 404);
    }

    const file = await readPackageFile(parts.id, parts.revision, parts.path);

    if (!file) {
        return refusal(`no stored file '${parts.path}' for '${parts.id}' at revision ${parts.revision}`, 404);
    }

    return new workerScope.Response(file.bytes, {
        status: 200,
        headers: {
            'Content-Type': file.mime,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
        },
    });
}

workerScope.addEventListener('install', (event) => {
    event.waitUntil(workerScope.skipWaiting());
});

workerScope.addEventListener('activate', (event) => {
    /* Claiming clients is what lets the page load a stored package in the same
       session it installed it, instead of waiting for a reload. */
    event.waitUntil(workerScope.clients.claim());
});

workerScope.addEventListener('fetch', (event) => {
    const url = new workerScope.URL(event.request.url);

    if (url.origin !== new workerScope.URL(workerScope.registration.scope).origin || !url.pathname.startsWith(MOD_URL_PREFIX)) {
        return;
    }

    if (event.request.method !== 'GET' && event.request.method !== 'HEAD') {
        event.respondWith(Promise.resolve(refusal('package files are read-only', 405)));

        return;
    }

    event.respondWith(packageResponse(url));
});
