import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createFileWatchService } from './file-watch-service.mjs';

const base = path.resolve(import.meta.dirname, '../target/browser-jvm/file-watch-service');

fs.mkdirSync(base, { recursive: true });
assert.ok(fs.realpathSync(base).startsWith(`${fs.realpathSync(path.resolve(import.meta.dirname, '..'))}${path.sep}`));
const root = path.join(base, randomUUID());

fs.mkdirSync(root);
assert.ok(fs.realpathSync(root).startsWith(`${fs.realpathSync(base)}${path.sep}`));
const services = [];
const servers = [];
const clients = [];
const result = { root, pass: false, startedUtc: new Date().toISOString(), checks: [] };
const source = path.join(import.meta.dirname, 'file-watch-service.mjs');
/**
 * Hashes the authored module or an owned sentinel without changing it.
 *
 * @param {string} file - Existing source or owned fixture file.
 * @returns {string} SHA-256 digest.
 */
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const before = hash(source);

/**
 * Records one assertion only after its actual condition succeeds.
 *
 * @param {unknown} value - Observed condition.
 * @param {string} label - Evidence description.
 */
function check(value, label) {
    assert.ok(value, label);
    result.checks.push(label);
}

/**
 * Waits for actual observations within one fixed deadline.
 *
 * @param {function(): unknown} predicate - Checks the received real events.
 * @param {string} label - Condition named in a timeout.
 * @param {number} [milliseconds] - Unchanged maximum observation interval.
 * @returns {Promise<unknown>} First successful observed value.
 */
function until(predicate, label, milliseconds = 4_000) {
    const deadline = Date.now() + milliseconds;

    /**
     * Checks received events again after yielding without moving the deadline.
     *
     * @returns {Promise<unknown>} The actual observation or a timeout error.
     */
    async function poll() {
        if (Date.now() >= deadline) {
            throw new Error(`Timed out waiting for ${label}`);
        }

        const value = predicate();

        if (value) {
            return value;
        }

        await new Promise((resolve) => {
            setTimeout(resolve, 10);
        });

        return poll();
    }

    return poll();
}

/**
 * Creates a media root inside this run's fresh owned fixture.
 *
 * @param {string} name - Fixture case directory name.
 * @returns {string} Absolute owned media directory.
 */
function media(name) {
    const directory = path.join(root, name, 'media');

    fs.mkdirSync(directory, { recursive: true });

    return directory;
}

/**
 * Creates an actual OS watcher for one owned test root.
 *
 * @param {string} directory - Existing owned physical media directory.
 * @returns {object} Service tracked for mandatory teardown.
 */
function service(directory) {
    const bridge = createFileWatchService({ mounts: [{ virtualPrefix: '/app/media', root: directory }] });

    services.push(bridge);

    return bridge;
}

/**
 * Starts a loopback HTTP owner for the actual SSE service.
 *
 * @param {object} bridge - Service under verification.
 * @returns {Promise<string>} Actual listening origin.
 */
async function listen(bridge) {
    const server = http.createServer((request, response) => {
        if (!bridge.handle(request, response)) {
            response.writeHead(404).end();
        }
    });

    servers.push(server);
    await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });

    return `http://127.0.0.1:${server.address().port}`;
}

/**
 * Reads real SSE frames from a fresh HTTP connection.
 *
 * @param {string} origin - Owned loopback server origin.
 * @returns {Promise<object>} Client with received frames and close state.
 */
async function connect(origin) {
    const client = { events: [], body: '', closed: false };

    clients.push(client);
    await new Promise((resolve, reject) => {
        client.request = http.get(`${origin}/watch-events`, (response) => {
            client.response = response;
            response.setEncoding('utf8');
            assert.equal(response.statusCode, 200);
            response.on('data', (chunk) => {
                client.body += chunk;
                let end;

                while ((end = client.body.indexOf('\n\n')) >= 0) {
                    const frame = client.body.slice(0, end);

                    client.body = client.body.slice(end + 2);
                    const data = frame.split('\n').find((line) => line.startsWith('data: '));

                    if (data) {
                        client.events.push(JSON.parse(data.slice(6)));
                    }
                }
            });
            response.on('close', () => {
                client.closed = true;
            });
            response.on('error', (error) => {
                client.error = error.code;
            });
            resolve();
        });
        client.request.on('error', reject);
    });
    await until(() => client.events.find((event) => event.type === 'ready'), 'SSE ready');

    return client;
}

/**
 * Tests an exact virtual path in the actual received events.
 *
 * @param {object} client - Real SSE client.
 * @param {string} type - Expected observed event kind.
 * @param {string} relative - Owned relative fixture path.
 * @returns {boolean} Whether that actual event has arrived.
 */
const has = (client, type, relative) => client.events.some((event) => event.type === type && event.path === `/app/media/${relative}`);

try {
    const directory = media('normal');

    fs.writeFileSync(path.join(directory, 'baseline.txt'), 'unchanged');
    const bridge = service(directory);
    const origin = await listen(bridge);
    const first = await connect(origin);
    const second = await connect(origin);

    check(first.events[0].prefixes.join() === '/app/media' && first.events[0].replay === false,
        'ready identifies actual active virtual mounts before changes');
    check(!JSON.stringify(first.events[0]).includes(root), 'ready exposes no physical root');
    check(bridge.diagnostics().watchers === 1 && bridge.diagnostics().clients === 2, 'one recursive watcher serves two SSE owners');
    const name = 'snow-雪 é.txt';

    fs.writeFileSync(path.join(directory, name), 'one');
    await until(() => has(first, 'create', name) && has(second, 'create', name), 'actual Unicode create');
    check(true, 'both clients received exact Unicode virtual create');
    fs.appendFileSync(path.join(directory, name), 'two');
    await until(() => has(first, 'modify', name), 'actual append modify');
    check(true, 'real append produced modify');
    fs.renameSync(path.join(directory, name), path.join(directory, 'renamed.txt'));
    await until(() => has(first, 'delete', name) && has(first, 'create', 'renamed.txt'), 'file rename delete/create');
    check(true, 'file rename reports observed disappearance and appearance without guessed move');
    fs.unlinkSync(path.join(directory, 'renamed.txt'));
    await until(() => has(first, 'delete', 'renamed.txt'), 'actual delete');
    check(true, 'real unlink produced delete');
    fs.mkdirSync(path.join(directory, 'folder'));
    await until(() => has(first, 'create', 'folder'), 'directory create');
    fs.renameSync(path.join(directory, 'folder'), path.join(directory, 'moved'));
    await until(() => first.events.some((event) => event.type === 'overflow' && event.reason === 'directory-removed-or-renamed'), 'directory rename ambiguity');
    check(true, 'directory rename produces explicit overflow');
    fs.writeFileSync(path.join(directory, 'moved/inside.txt'), 'nested');
    await until(() => has(first, 'create', 'moved/inside.txt'), 'recursive nested create');
    check(true, 'actual recursive nested create observed');
    fs.unlinkSync(path.join(directory, 'moved/inside.txt'));
    await until(() => has(first, 'delete', 'moved/inside.txt'), 'recursive nested delete');
    fs.rmdirSync(path.join(directory, 'moved'));
    await until(() => first.events.some((event) => event.type === 'overflow'
        && event.path === '/app/media/moved' && event.reason === 'directory-removed-or-renamed'), 'directory removal ambiguity');
    check(true, 'actual directory removal reports explicit overflow');
    first.response.destroy();
    await until(() => bridge.diagnostics().clients === 1, 'disconnected SSE owner cleanup');
    check(true, 'disconnect disposes only its SSE owner');
    check((await fetch(`${origin}/watch-events?root=../outside`)).status === 404, 'query paths cannot configure or select mounts');
    check((await fetch(`${origin}/watch-events`, { method: 'POST' })).status === 405, 'non-GET endpoint rejected');
    check((await fetch(`${origin}/watch-events`, { headers: { 'Last-Event-ID': '1' } })).status === 503, 'unsupported stream replay never silently succeeds');
    await Promise.all([bridge.close(), bridge.close()]);
    await until(() => second.closed, 'SSE closed with service');
    check(bridge.diagnostics().watchers === 0 && bridge.diagnostics().clients === 0 && !bridge.diagnostics().timerActive,
        'close disposes actual watcher, listeners, SSE owners and timer');
    await bridge.close();
    check(true, 'close is idempotent');

    const overflowRoot = media('backpressure');
    const slow = service(overflowRoot);
    const response = new EventEmitter();
    const frames = [];

    /**
     * Models header acceptance for the explicit non-draining Response boundary.
     *
     * @returns {object} The same controlled response.
     */
    response.writeHead = () => response;
    /**
     * Models header flushing without changing the actual filesystem event source.
     *
     * @returns {void} No socket is involved in this controlled response boundary.
     */
    response.flushHeaders = () => undefined;

    /**
     * Captures a real event frame while deliberately applying transport backpressure.
     *
     * @param {string} frame - Service-generated SSE frame.
     * @returns {boolean} False to keep the controlled response blocked.
     */
    response.write = (frame) => {
        frames.push(frame);

        return false;
    };

    /**
     * Closes this controlled owner through its actual registered listener.
     *
     * @returns {boolean} Whether a close listener was present.
     */
    response.destroy = () => response.emit('close');
    slow.handle({ method: 'GET', url: '/watch-events', headers: {} }, response);

    /**
     * Produces the same bounded sequence of real filesystem changes with OS yields.
     *
     * @param {number} [i] - Next owned filename index.
     * @returns {Promise<void>} Completion of all 350 real writes.
     */
    async function writePaced(i = 0) {
        if (i === 350) {
            return;
        }

        fs.writeFileSync(path.join(overflowRoot, `actual-${i}.txt`), 'x');
        /* Let the OS deliver observations; a synchronous burst can overflow its
           own notification buffer before testing our separate SSE queue limit. */
        await new Promise((resolve) => {
            setTimeout(resolve, 2);
        });

        return writePaced(i + 1);
    }

    await writePaced();
    await until(() => slow.diagnostics().backpressureOverflows > 0, 'actual event queue backpressure overflow');
    check(slow.diagnostics().queued <= slow.diagnostics().queueLimit, 'queue stays bounded under actual filesystem event backlog');
    /**
     * Releases backpressure while retaining the actual emitted frames.
     *
     * @param {string} frame - Service-generated SSE frame.
     * @returns {boolean} True to permit queued frames to drain.
     */
    response.write = (frame) => {
        frames.push(frame);

        return true;
    };

    response.emit('drain');
    check(frames.some((frame) => frame.includes('"reason":"client-backpressure"')), 'backpressure emits explicit lost-event overflow');
    await slow.close();
    check(response.listenerCount('drain') === 0 && response.listenerCount('close') === 0,
        'backpressure owner listeners disposed');

    const lostRoot = media('lost-root');
    const lost = service(lostRoot);
    const lostClient = await connect(await listen(lost));

    fs.renameSync(lostRoot, `${lostRoot}-renamed`);
    await until(() => lostClient.events.some((event) => event.type === 'error' && event.code === 'ROOT_UNAVAILABLE'), 'Windows root rename detection');
    check(lostClient.events.some((event) => event.type === 'overflow'), 'lost root emits overflow and error, never silent success');
    check(!lost.diagnostics().timerActive, 'invalidated last mount stops root identity timer');
    await lost.close();

    const outside = path.join(root, 'outside');

    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'sentinel');
    const outsideHash = hash(path.join(outside, 'secret.txt'));
    const linkedRoot = media('linked');
    const linked = service(linkedRoot);
    const linkedClient = await connect(await listen(linked));

    fs.symlinkSync(outside, path.join(linkedRoot, 'escape'), 'junction');
    await until(() => linkedClient.events.some((event) => event.type === 'error' && event.code === 'LINK_ESCAPE'), 'symlink escape invalidation');
    check(!linkedClient.events.some((event) => event.type === 'create' && event.path.includes('secret.txt')), 'linked external entries are never published');
    await linked.close();
    check(hash(path.join(outside, 'secret.txt')) === outsideHash, 'watcher never modifies external sentinel');
    assert.throws(() => service(linkedRoot), /linked/i);
    check(true, 'preexisting symlink mount entries rejected before readiness');
    assert.throws(() => createFileWatchService({ mounts: [{ virtualPrefix: '/app/media/../save', root: directory }] }));
    assert.throws(() => createFileWatchService({ mounts: [{ virtualPrefix: '/arbitrary', root: directory }] }));
    check(true, 'virtual traversal and unserved prefixes rejected');
    check(!JSON.stringify(second.events).includes(root), 'all SSE events expose virtual paths only');
    result.events = second.events;
    result.pass = true;
} catch (error) {
    result.error = String(error.stack || error);
} finally {
    for (const client of clients) {
        client.response?.destroy();
    }

    await Promise.all(services.map((bridge) => bridge.close()));
    await Promise.all(servers.map((server) => new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
    })));
    result.cleanup = services.map((bridge) => bridge.diagnostics());
    result.sourcesUnchanged = hash(source) === before;
    result.serverClosed = servers.every((server) => !server.listening);
    result.pass &&= result.sourcesUnchanged && result.serverClosed
        && result.cleanup.every((item) => item.closed && !item.watchers && !item.clients
            && !item.entries && !item.watcherListeners && !item.timerActive);
    result.finishedUtc = new Date().toISOString();
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
    console.info(JSON.stringify({ root, pass: result.pass, checks: result.checks.length, error: result.error, serverClosed: result.serverClosed }));
}

if (!result.pass) {
    process.exitCode = 1;
}
