import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const QUEUE_LIMIT = 256;
const INDEX_LIMIT = 250_000;

/**
 * Tests canonical physical containment without accepting a neighboring prefix.
 *
 * @param {string} root - Canonical configured directory.
 * @param {string} file - Canonical candidate path.
 * @returns {boolean} Whether the path belongs to this mount.
 */
const inside = (root, file) => file === root || file.startsWith(`${root}${path.sep}`);
/**
 * Retains the exact filesystem identity used to detect root replacement.
 *
 * @param {import('node:fs').BigIntStats} stat - Actual bigint metadata.
 * @returns {string} Stable device and inode identity.
 */
const identity = (stat) => `${stat.dev}:${stat.ino}`;
/**
 * Maps a verified relative observation to its literal public namespace.
 *
 * @param {object} mount - Trusted configured mount.
 * @param {string} relative - Verified relative path.
 * @returns {string} Virtual path without a physical directory disclosure.
 */
const virtual = (mount, relative) => relative ? `${mount.virtualPrefix}/${relative}` : mount.virtualPrefix;

/**
 * Reads one entry only after checking its canonical mount ancestry.
 *
 * @param {object} mount - Trusted mount and its canonical root.
 * @param {string} relative - Mount-relative path to inspect.
 * @returns {object} Actual entry kind and filesystem identity.
 */
function entry(mount, relative) {
    const file = path.join(mount.root, ...relative.split('/'));

    if (relative && !inside(mount.root, fs.realpathSync(path.dirname(file)))) {
        throw Object.assign(new Error('Unsupported linked mount ancestor'), { code: 'LINK_ESCAPE' });
    }

    const stat = fs.lstatSync(file, { bigint: true });

    if (stat.isSymbolicLink() || !inside(mount.root, fs.realpathSync(file))) {
        throw Object.assign(new Error('Unsupported linked mount entry'), { code: 'LINK_ESCAPE' });
    }

    return { kind: stat.isDirectory() ? 'directory' : 'file', identity: identity(stat) };
}

/**
 * Indexes real metadata without opening source content or following links.
 *
 * @param {object} mount - Owned mount index.
 * @param {string} [start] - Existing relative subtree, or the mount root.
 */
function scan(mount, start = '') {
    const pending = [start];

    while (pending.length) {
        const relative = pending.pop();
        const current = entry(mount, relative);

        mount.index.set(relative, current);

        if (mount.index.size > INDEX_LIMIT) {
            throw Object.assign(new Error('Mount index limit exceeded'), { code: 'INDEX_LIMIT' });
        }

        if (current.kind === 'directory') {
            for (const name of fs.readdirSync(path.join(mount.root, ...relative.split('/')))) {
                pending.push(relative ? `${relative}/${name}` : name);
            }
        }
    }
}

/**
 * Observes trusted, explicitly configured read-only media mounts.
 * Browser requests cannot add mounts or choose physical paths. This is an event
 * bridge, not an OS access-control boundary against concurrent hostile changes.
 *
 * @param {{mounts: Array<{virtualPrefix: string, root: string}>}} options - Server-owned mounts.
 * @returns {object} Exact SSE handler, bounded shutdown and copied diagnostics.
 */
export function createFileWatchService({ mounts }) {
    if (!Array.isArray(mounts) || !mounts.length || mounts.length > 8) {
        throw new TypeError('Configure between one and eight media mounts');
    }

    const epoch = randomUUID();
    const owners = new Set();
    const watchers = new Set();
    const configured = [];
    let closed = false;
    let sequence = 0;
    let overflows = 0;
    let backpressureOverflows = 0;
    let errors = 0;
    const overflowReasons = new Map();
    let timer;

    /**
     * Removes only this SSE owner and the listeners installed by this service.
     *
     * @param {object} owner - Owned response, queue and listener references.
     */
    function removeOwner(owner) {
        if (!owners.delete(owner)) {
            return;
        }

        owner.response.off('drain', owner.drain);
        owner.response.off('close', owner.close);
        owner.response.off('error', owner.close);
        owner.queue.length = 0;
    }

    /**
     * Writes queued frames until the response applies real backpressure.
     *
     * @param {object} owner - SSE owner whose response is writable.
     */
    function flush(owner) {
        while (!owner.blocked && owner.queue.length && owners.has(owner)) {
            const event = owner.queue.shift();

            if (event === owner.overflow) {
                owner.overflow = undefined;
            }

            const frame = `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

            try {
                owner.blocked = !owner.response.write(frame);
            } catch {
                removeOwner(owner);
                owner.response.destroy();
            }
        }
    }

    /**
     * Bounds an owner backlog and reports loss instead of accumulating memory.
     *
     * @param {object} owner - SSE owner receiving this observation.
     * @param {object} event - Verified event or explicit readiness/loss frame.
     */
    function enqueue(owner, event) {
        if (owner.overflow) {
            owner.overflow.lost++;
            owner.overflow.sequence = event.sequence;
        } else if (owner.queue.length >= QUEUE_LIMIT) {
            overflows++;
            backpressureOverflows++;
            owner.overflow = {
                type: 'overflow', sequence: event.sequence, epoch,
                reason: 'client-backpressure', lost: owner.queue.length + 1,
                paths: configured.map((mount) => mount.virtualPrefix),
            };
            owner.queue = [owner.overflow];
        } else {
            owner.queue.push(event);
        }

        flush(owner);
    }

    /**
     * Publishes one verified virtual observation to the current SSE owners.
     *
     * @param {string} type - Protocol event kind.
     * @param {object} mount - Configured source mount.
     * @param {string} relative - Verified relative event scope.
     * @param {object} [detail] - Safe event fields without physical paths.
     */
    function emit(type, mount, relative, detail = {}) {
        if (closed) {
            return;
        }

        const event = { type, sequence: ++sequence, epoch, path: virtual(mount, relative), ...detail };

        if (type === 'overflow') {
            overflows++;
            overflowReasons.set(detail.reason, (overflowReasons.get(detail.reason) || 0) + 1);
        }

        if (type === 'error') {
            errors++;
        }

        for (const owner of owners) {
            enqueue(owner, event);
        }
    }

    /**
     * Reports lost observation and closes the affected physical watch.
     *
     * @param {object} mount - Mount whose observation can no longer be trusted.
     * @param {string} code - Safe error code to send to the browser.
     */
    function invalidate(mount, code) {
        if (!mount.active) {
            return;
        }

        mount.active = false;
        emit('overflow', mount, '', { reason: 'watch-invalidated' });
        emit('error', mount, '', { code });
        mount.watcher.close();
        mount.index.clear();

        if (configured.every((item) => !item.active)) {
            clearInterval(timer);
            timer = undefined;
        }
    }

    /**
     * Checks only root identity to detect Windows silent root moves.
     *
     * @param {object} mount - Active configured mount.
     * @returns {boolean} Whether the original root is still observable.
     */
    function rootAvailable(mount) {
        try {
            const current = entry(mount, '');

            if (current.kind !== 'directory' || current.identity !== mount.identity) {
                invalidate(mount, 'ROOT_REPLACED');

                return false;
            }

            return true;
        } catch (error) {
            invalidate(mount, error.code === 'LINK_ESCAPE' ? error.code : 'ROOT_UNAVAILABLE');

            return false;
        }
    }

    /**
     * Reconciles an actual native notification with the real current entry.
     *
     * @param {object} mount - Mount that produced the OS notification.
     * @param {string} eventType - Actual Node rename or change event.
     * @param {string|null} filename - Actual optional Node relative filename.
     */
    function observed(mount, eventType, filename) {
        if (closed || !mount.active || !rootAvailable(mount)) {
            return;
        }

        if (typeof filename !== 'string' || !filename) {
            emit('overflow', mount, '', { reason: 'filename-unavailable' });

            try {
                mount.index.clear();
                scan(mount);
            } catch (error) {
                invalidate(mount, error.code || 'WATCH_RESCAN');
            }

            return;
        }

        const relative = filename.replaceAll('\\', '/');

        if (relative.length > 4_096 || relative.includes('\0') || relative.includes(':')
            || relative.split('/').some((part) => !part || part === '.' || part === '..')) {
            emit('overflow', mount, '', { reason: 'invalid-native-filename' });

            return;
        }

        try {
            const before = mount.index.get(relative);
            let after;

            try {
                after = entry(mount, relative);
            } catch (error) {
                if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
                    throw error;
                }
            }

            if (!before && !after) {
                emit('overflow', mount, relative, { reason: 'transient-entry' });
            } else if (!before) {
                scan(mount, relative);
                emit('create', mount, relative, { directory: after.kind === 'directory' });
            } else if (!after && before.kind === 'file') {
                mount.index.delete(relative);
                emit('delete', mount, relative, { directory: false });
            } else if (!after) {
                for (const name of mount.index.keys()) {
                    if (name === relative || name.startsWith(`${relative}/`)) {
                        mount.index.delete(name);
                    }
                }

                emit('overflow', mount, relative, { reason: 'directory-removed-or-renamed' });
            } else if (before.identity !== after.identity || before.kind !== after.kind
                || (eventType === 'rename' && after.kind === 'directory')) {
                emit('overflow', mount, relative, { reason: 'entry-replaced-or-ambiguous-rename' });
                scan(mount, relative);
            } else if (eventType === 'change') {
                emit('modify', mount, relative, { directory: after.kind === 'directory' });
            } else {
                emit('overflow', mount, relative, { reason: 'unclassified-native-event' });
            }
        } catch (error) {
            if (error.code === 'LINK_ESCAPE') {
                invalidate(mount, 'LINK_ESCAPE');
            } else {
                emit('overflow', mount, relative, { reason: 'reconciliation-failed', code: error.code || 'WATCH_RECONCILE' });
            }
        }
    }

    try {
        for (const input of mounts) {
            const prefix = input.virtualPrefix;

            if (typeof prefix !== 'string' || !/^\/app\/media(?:\/[^/]+)*$/.test(prefix)
                || prefix.split('/').some((part) => part === '.' || part === '..' || (/[#%:?\\]/.test(part) || [...part].some((character) => character.charCodeAt(0) < 32)))) {
                throw new TypeError('Mount needs a canonical /app/media prefix');
            }

            if (typeof input.root !== 'string' || !path.isAbsolute(input.root)) {
                throw new TypeError('Mount root must be an explicit absolute directory');
            }

            const root = fs.realpathSync(input.root);

            if (root.toLowerCase() !== path.resolve(input.root).toLowerCase()
                || fs.lstatSync(input.root).isSymbolicLink()) {
                throw new TypeError('Linked mount roots are unsupported');
            }

            if (configured.some((mount) => inside(mount.root, root) || inside(root, mount.root)
                || prefix === mount.virtualPrefix || prefix.startsWith(`${mount.virtualPrefix}/`)
                || mount.virtualPrefix.startsWith(`${prefix}/`))) {
                throw new TypeError('Overlapping mounts are unsupported');
            }

            const mount = { root, virtualPrefix: prefix, index: new Map(), active: true };
            const initial = entry(mount, '');

            if (initial.kind !== 'directory') {
                throw new TypeError('Mount root must be a directory');
            }

            mount.identity = initial.identity;
            mount.watcher = fs.watch(root, { recursive: true, encoding: 'utf8' }, (type, name) => observed(mount, type, name));
            mount.whenClosed = new Promise((resolve) => {
                mount.watcher.once('close', () => {
                    watchers.delete(mount.watcher);
                    mount.watcher.removeAllListeners();
                    resolve();
                });
            });
            watchers.add(mount.watcher);
            mount.watcher.on('error', (error) => invalidate(mount, error.code || 'WATCH_ERROR'));
            configured.push(mount);
            scan(mount);
        }
    } catch (error) {
        for (const watcher of watchers) {
            watcher.close();
        }

        throw error;
    }

    /* Windows can silently lose a watch when its root is moved. This checks only
       root identity; ordinary file changes are observed through recursive fs.watch. */
    timer = setInterval(() => {
        for (const mount of configured) {
            if (mount.active) {
                rootAvailable(mount);
            }
        }
    }, 1_000);
    timer.unref();

    /**
     * Serves only the exact read-only SSE endpoint for configured mounts.
     *
     * @param {import('node:http').IncomingMessage} request - Actual server request.
     * @param {import('node:http').ServerResponse} response - Response owned by this request.
     * @returns {boolean} Whether this service handled the request.
     */
    function handle(request, response) {
        if (request.url !== '/watch-events') {
            return false;
        }

        if (request.method !== 'GET') {
            response.writeHead(405, { Allow: 'GET' }).end();

            return true;
        }

        if (closed || configured.some((mount) => !mount.active) || owners.size >= 8 || request.headers['last-event-id']) {
            response.writeHead(503).end();

            return true;
        }

        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        response.flushHeaders();
        const owner = { response, queue: [], blocked: false };

        /**
         * Resumes queued writes only after the response signals drain.
         */
        owner.drain = () => {
            owner.blocked = false;
            flush(owner);
        };

        /**
         * Releases the service listeners when this SSE response closes.
         *
         * @returns {void} Completion of this owner's listener removal.
         */
        owner.close = () => removeOwner(owner);
        response.on('drain', owner.drain);
        response.on('close', owner.close);
        response.on('error', owner.close);
        owners.add(owner);
        enqueue(owner, { type: 'ready', sequence, epoch, prefixes: configured.map((mount) => mount.virtualPrefix), replay: false });

        return true;
    }

    /**
     * Closes all owned resources and waits for actual watcher close events.
     *
     * @returns {Promise<void>} Completion of watcher and SSE teardown.
     */
    async function close() {
        if (!closed) {
            closed = true;
            clearInterval(timer);

            for (const owner of [...owners]) {
                removeOwner(owner);
                owner.response.destroy();
            }

            for (const mount of configured) {
                mount.active = false;
                mount.watcher.close();
                mount.index.clear();
            }
        }

        await Promise.all(configured.map((mount) => mount.whenClosed));
    }

    /**
     * Copies bounded operational counters without exposing physical mount paths.
     *
     * @returns {object} Resource ownership, queue and observation counters.
     */
    function diagnostics() {
        return {
            closed, watchers: watchers.size, clients: owners.size, sequence, overflows, backpressureOverflows, errors,
            queueLimit: QUEUE_LIMIT, queued: [...owners].reduce((sum, owner) => sum + owner.queue.length, 0),
            overflowReasons: Object.fromEntries(overflowReasons),
            entries: configured.reduce((sum, mount) => sum + mount.index.size, 0),
            watcherListeners: configured.reduce((sum, mount) => sum
                + mount.watcher.eventNames().reduce((count, name) => count + mount.watcher.listenerCount(name), 0), 0),
            prefixes: configured.map((mount) => mount.virtualPrefix), timerActive: Boolean(timer) && !closed,
        };
    }

    return { handle, close, diagnostics };
}
