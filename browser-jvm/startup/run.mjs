import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, writeFileSync } from 'node:fs';
import { readFile, writeFile, stat, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { certifyPublished } from './certify-published.mjs';
import { isPositiveMetadataEntry } from './negative-stat.js';
import { createGateNetworkObserver } from './network-observer.mjs';
import { createOriginalBootRoutes, hash } from './profile-routes.mjs';

const ownerStartedAt = Date.now();
const outerDeadlineAt = ownerStartedAt + 2_640_000;
let ownerPhase = 'admission-preflight';
let browserServer;
let rejectHostFailure;
let evidence = null;
let output = null;
const deadlineRecord = { establishedAt: ownerStartedAt, deadlineAt: outerDeadlineAt, firedAt: null };
const deadline = setTimeout(() => {
    deadlineRecord.firedAt = Date.now();
    deadlineRecord.phase = ownerPhase;

    if (evidence) {
        evidence.deadlineExceeded = true;
    }

    const record = JSON.stringify({ ...deadlineRecord, event: 'owner-deadline-fired' });

    process.stderr.write(`${record}\n`);

    if (output) {
        try {
            writeFileSync(path.join(output, 'deadline-fired.json'), record);
        } catch (error) {
            process.stderr.write(`${String(error.stack ?? error)}\n`);
        }
    }

    rejectHostFailure?.(new Error('Original total owner deadline exceeded'));

    if (browserServer) {
        void browserServer.kill().catch((error) => process.stderr.write(`${String(error.stack ?? error)}\n`));
    }
}, Math.max(0, outerDeadlineAt - Date.now()));

process.stderr.write(`${JSON.stringify({ ...deadlineRecord, event: 'owner-deadline-established' })}\n`);

// Admission is checked before HTTP, browser, or filesystem-watch owners are created.
const generationFile = process.argv[2];
const executablePath = process.argv[3];

assert.ok(generationFile && executablePath, 'Usage: node first-gate.mjs GENERATION_JSON CHROMIUM_EXECUTABLE');
const generation = JSON.parse(await readFile(generationFile, 'utf8'));

assert.equal(generation.executionAdmitted, true, 'Root review must explicitly admit the exact frozen generation');
assert.equal(generation.hostSources.length, 7);

for (const record of generation.hostSources) {
    // These small source identities precede all owner creation.
    // eslint-disable-next-line no-await-in-loop
    const bytes = await readFile(record.file);

    assert.equal(createHash('sha256').update(bytes).digest('hex'), record.sha256, record.file);
}

assert.equal(generation.closedMediaInputs?.length, 3, 'Exact namespace, certificate and original ledger inputs are required');

for (const record of generation.closedMediaInputs) {
    // eslint-disable-next-line no-await-in-loop -- Validate each exact artifact before any owner is created.
    const bytes = await readFile(record.file);

    assert.equal(bytes.length, record.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), record.sha256);
}

for (const prefix of ['namespace', 'certificate', 'ledger']) {
    const record = generation.closedMediaInputs.find((item) => item.file === generation.closedMedia[`${prefix}File`]);

    assert.ok(record);
    assert.equal(record.sha256, generation.closedMedia[`${prefix}SHA256`]);
}

let owners;
let routes;
let mediaHandler;
let closedMedia;
let fileWatchService;
const logs = [];
const requests = [];
const denied = [];
const hostFailure = new Promise((resolve, reject) => {
    rejectHostFailure = reject;
});

// Retain early event failures even if they arrive before the first awaited browser condition.
void hostFailure.catch(() => undefined);
const activeMediaRequests = new Set();

evidence = { pass: false, fullGamePlayable: false, originalFullShutdownQualified: false, generationFile };
let server;
let browser;
let page;
let networkObserver;
let checkpointTimer;
let checkpointPending;
const checkpointErrors = [];

output = await mkdtemp(path.join(tmpdir(), 'pz-original-first-gate-'));
writeFileSync(path.join(output, 'deadline-established.json'), JSON.stringify(deadlineRecord));
process.stdout.write(`${JSON.stringify({ output, generationFile, phase: 'startup-preflight' })}\n`);

/**
 * Bounds an actual owner operation while retaining its failure.
 *
 * @param {Promise<unknown>} promise - Actual owner operation.
 * @param {number} milliseconds - Deadline for this operation.
 * @param {string} label - Actual bounded operation name.
 * @returns {Promise<unknown>} Actual result or rejected deadline.
 */
async function bounded(promise, milliseconds, label = 'owner-operation') {
    let timer;

    try {
        return await Promise.race([promise, new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} deadline exceeded`)), milliseconds);
        })]);
    } finally {
        clearTimeout(timer);
    }
}

try {
    ownerPhase = 'route-owner-creation';
    owners = await createOriginalBootRoutes(generation);
    ({ routes, mediaHandler, closedMedia, watch: fileWatchService } = owners);
    const specification = generation.eagerMedia;

    assert.equal(specification?.schema, 'same-owner-eager-metadata-v1');
    assert.equal(specification.namespaceSHA, closedMedia.certificate.namespaceSHA);
    const files = closedMedia.namespace.filter((entry) => entry.kind === 'file');
    const nonempty = files.filter((entry) => entry.bytes > 0);
    const sourceBytes = files.reduce((total, entry) => total + entry.bytes, 0);

    assert.equal(files.length, 47_417);
    assert.equal(nonempty.length, 47_416);
    assert.equal(sourceBytes, 10_044_025_029);
    assert.equal(specification.files, files.length);
    assert.equal(specification.nonempty, nonempty.length);
    assert.equal(specification.sourceBytes, sourceBytes);
    ownerPhase = 'eager-publication';
    evidence.eagerStartedAt = Date.now();
    evidence.eagerPublication = await closedMedia.publishAll({ deadlineAt: outerDeadlineAt, maxBytes: sourceBytes });
    ownerPhase = 'positive-certificate';
    evidence.certificateAudit = { handles: [] };
    const rawCertificate = await certifyPublished({
        owner: closedMedia, namespace: closedMedia.namespace, namespaceSHA: closedMedia.certificate.namespaceSHA,
        sourceRoot: generation.mediaRoot, inodeHelperSource: specification.inodeHelperSource,
        deadlineAt: outerDeadlineAt, audit: evidence.certificateAudit,
    });
    const eligible = rawCertificate.files.filter(isPositiveMetadataEntry);
    const excluded = rawCertificate.files.filter((entry) => !isPositiveMetadataEntry(entry));
    const subsetSHA = createHash('sha256').update(JSON.stringify(eligible)).digest('hex');

    assert.equal(eligible.length, 47_414);
    assert.equal(excluded.length, 2);
    assert.equal(subsetSHA, specification.eligibleOrderedRecordsSHA256);
    assert.deepEqual(excluded, specification.excluded);
    const positiveCertificate = { ...rawCertificate, files: eligible };
    const certificateBytes = Buffer.from(JSON.stringify(positiveCertificate));
    const certificateFile = path.join(output, 'media-positive-certificate.json');

    await writeFile(certificateFile, certificateBytes, { flag: 'wx' });
    evidence.positiveCertificateRoute = {
        file: certificateFile, bytes: certificateBytes.length,
        sha256: createHash('sha256').update(certificateBytes).digest('hex'), type: 'application/json',
    };
    evidence.positiveEligibility = { eligible: eligible.length, excluded, subsetSHA };
    evidence.eagerFinishedAt = Date.now();
    assert.equal(routes.has('/media-positive-certificate.json'), false);
    routes.set('/media-positive-certificate.json', evidence.positiveCertificateRoute);
    assert.ok(Date.now() < outerDeadlineAt, 'Preparation exhausted original owner deadline');
    ownerPhase = 'http-server';
    server = createServer(async (request, response) => {
        try {
            for (const [name, value] of Object.entries(owners.headers)) {
                response.setHeader(name, value);
            }

            if (fileWatchService?.handle(request, response)) {
                return;
            }

            if (!['GET', 'HEAD'].includes(request.method)) {
                response.writeHead(405).end();

                return;
            }

            // Prepared routes take precedence; the media fallback validates its canonical root.
            const route = routes.get(request.url);

            if (!route) {
                const pending = mediaHandler(request, response);

                activeMediaRequests.add(pending);

                try {
                    if (await pending) {
                        return;
                    }
                } finally {
                    activeMediaRequests.delete(pending);
                }

                response.writeHead(404).end();

                return;
            }

            const size = (await stat(route.file)).size;
            const headers = { 'Content-Type': route.type, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
            let start = 0;
            let end = size - 1;
            let status = 200;

            if (request.headers.range) {
                const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);

                if (!match || (!match[1] && !match[2])) {
                    response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();

                    return;
                }

                if (!match[1]) {
                    start = Math.max(0, size - Number(match[2]));
                } else {
                    start = Number(match[1]);
                    end = match[2] ? Math.min(Number(match[2]), end) : end;
                }

                if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || end >= size) {
                    response.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();

                    return;
                }

                status = 206;
                headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
            }

            headers['Content-Length'] = end - start + 1;
            response.writeHead(status, headers);

            if (request.method === 'HEAD') {
                response.end();
            } else {
                const stream = createReadStream(route.file, { start, end });

                stream.on('error', (error) => response.destroy(error));
                response.on('close', () => stream.destroy());
                stream.pipe(response);
            }
        } catch (error) {
            if (!response.headersSent) {
                response.writeHead(500);
            }

            response.end('Local artifact unavailable');
            logs.push(`HTTP: ${error.message}`);
        }
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;

    evidence.origin = origin;
    browserServer = await chromium.launchServer({ executablePath, headless: false });
    ownerPhase = 'original-browser';
    assert.ok(Date.now() < outerDeadlineAt, 'Original owner deadline already elapsed');
    browser = await chromium.connect(browserServer.wsEndpoint());
    const context = await browser.newContext({ serviceWorkers: 'block' });

    await context.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const item = { url: request.url(), method: request.method(), range: request.headers().range ?? null, postDataBytes: request.postDataBuffer()?.length || 0 };

        requests.push(item);
        const local = url.origin === origin && !url.search && (routes.has(url.pathname) || url.pathname === '/media' || url.pathname.startsWith('/media/') || url.pathname === '/watch-events');
        const runtime = url.origin === 'https://cjrtnc.leaningtech.com' && url.pathname.startsWith('/4.3/');

        if (!['GET', 'HEAD'].includes(request.method()) || item.postDataBytes || (!local && !runtime)) {
            denied.push(item);
            rejectHostFailure(new Error(`Denied unexpected request: ${request.url()}`));
            await route.abort();

            return;
        }

        await route.continue();
    });
    page = await context.newPage();
    networkObserver = await createGateNetworkObserver(context, page);
    page.on('console', (message) => logs.push(`${message.type()}: ${message.text()}`));
    page.on('pageerror', (error) => {
        logs.push(`PAGEERROR: ${error.stack}`);
        rejectHostFailure(error);
    });
    page.on('requestfailed', (request) => {
        const message = `REQUESTFAILED: ${request.url()} ${request.failure()?.errorText}`;

        logs.push(message);
    });
    page.on('response', (response) => {
        if (response.status() >= 400) {
            logs.push(`HTTPSTATUS: ${response.status()} ${response.url()}`);
        }
    });
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    checkpointTimer = setInterval(() => {
        if (checkpointPending) {
            return;
        }

        checkpointPending = bounded(page.evaluate(() => globalThis.originalBoot || null), 2_000, 'checkpoint-evaluate')
            .then((originalBoot) => {
                const network = networkObserver.snapshot();

                return writeFile(path.join(output, 'checkpoint.json'), JSON.stringify({
                    observedAt: new Date().toISOString(), originalBoot, logs: logs.slice(-2_000), network: {
                        ...network, requests: network.requests.slice(-16), cdpFailures: network.cdpFailures.slice(-16),
                        successfulSamples: Object.fromEntries(Object.entries(network.successfulSamples).map(([name, values]) => [name, values.slice(-16)])),
                        checkpointHistoryComplete: false, checkpointSampleLimit: 16,
                    },
                    latestFailure: logs.findLast((line) => /PAGEERROR:|REQUESTFAILED:|HTTPSTATUS:|ERROR:|Exception|Missing import:/u.test(line)) || null,
                }, null, 2));
            })
            .catch((error) => checkpointErrors.push(String(error.stack || error)))
            .finally(() => {
                checkpointPending = null;
            });
    }, 5_000);
    // Original logo timers proceed naturally; only the real visible original terms accept control is clicked.
    await Promise.race([hostFailure, page.waitForFunction(() => globalThis.originalBoot?.completed || globalThis.originalBoot?.failures?.length
        || globalThis.originalBoot?.termsControl?.visible
        || (globalThis.originalBoot?.termsControl?.visible === false
            && globalThis.originalBoot?.lastConsumedUi?.producerState === 'zombie.gameStates.MainScreenState'
            && globalThis.originalBoot.lastConsumedUi.mainMenuConsumed >= 3), undefined, { timeout: 2_400_000 })]);
    const initial = await page.evaluate(() => globalThis.originalBoot);

    assert.equal(initial.completed, false, 'Original startup completed before menu admission');
    assert.equal(initial.failures.length, 0);
    assert.ok(initial.termsControl?.visible || (initial.termsControl?.visible === false
        && initial.lastConsumedUi?.producerState === 'zombie.gameStates.MainScreenState' && initial.lastConsumedUi.mainMenuConsumed >= 3));
    const terms = await page.evaluate(() => globalThis.originalBoot.termsControl);
    const consumedBeforeInput = await page.evaluate(() => globalThis.originalBoot.lastConsumedUi?.mainMenuConsumed || 0);

    const termsDeadline = Date.now() + 60_000;
    /**
     * Returns the remaining shared terms input and transition budget.
     *
     * @returns {number} Remaining milliseconds, rejecting an exhausted phase.
     */
    const termsRemaining = () => {
        const milliseconds = termsDeadline - Date.now();

        assert.ok(milliseconds > 0, 'Shared original terms input deadline exceeded');

        return milliseconds;
    };

    if (terms.visible) {
        assert.equal(terms.identity, 'ISTermsOfServiceUI.instance.buttonAccept');
        assert.equal(terms.enabled, true);
        assert.ok(Number.isInteger(terms.buttonIdentity));
        assert.ok([terms.x, terms.y, terms.width, terms.height, terms.screenWidth, terms.screenHeight].every(Number.isFinite));
        assert.ok(terms.width > 0 && terms.height > 0 && terms.x >= 0 && terms.y >= 0
            && terms.x + terms.width <= terms.screenWidth && terms.y + terms.height <= terms.screenHeight);
        const box = await page.locator('#graphics-canvas').boundingBox();

        assert.ok(box && box.width > 0 && box.height > 0);
        evidence.trustedTermsInput = { control: terms, canvas: box, phaseStartedUtc: new Date(termsDeadline - 60_000).toISOString(), moveIssuedUtc: new Date().toISOString() };
        await bounded(page.mouse.move(box.x + (terms.x + terms.width / 2) * box.width / terms.screenWidth,
            box.y + (terms.y + terms.height / 2) * box.height / terms.screenHeight), termsRemaining(), 'trusted-terms-move');
        await Promise.race([hostFailure, page.waitForFunction(({ after, buttonIdentity }) => {
            const boot = globalThis.originalBoot;
            const value = boot?.termsControl;

            return boot?.completed || boot?.failures?.length || (value?.visible && value.enabled === true && value.sequence > after && value.buttonIdentity === buttonIdentity
                && value.mouseX > value.x + 1 && value.mouseX < value.x + value.width - 1
                && value.mouseY > value.y + 1 && value.mouseY < value.y + value.height - 1);
        }, { after: terms.sequence, buttonIdentity: terms.buttonIdentity }, { timeout: termsRemaining() })]);
        const moved = await page.evaluate(() => globalThis.originalBoot);

        assert.equal(moved.completed, false);
        assert.equal(moved.failures.length, 0);
        assert.equal(moved.termsControl.buttonIdentity, terms.buttonIdentity);
        assert.equal(moved.termsControl.enabled, true);
        assert.ok(moved.termsControl.mouseX > moved.termsControl.x + 1
            && moved.termsControl.mouseX < moved.termsControl.x + moved.termsControl.width - 1
            && moved.termsControl.mouseY > moved.termsControl.y + 1
            && moved.termsControl.mouseY < moved.termsControl.y + moved.termsControl.height - 1);
        evidence.trustedTermsInput.browserVisibilityBeforeDown = await page.evaluate(() => ({
            documentHidden: document.hidden, documentHasFocus: document.hasFocus(),
            activeElementId: document.activeElement?.id || null,
        }));
        evidence.trustedTermsInput.moveObserved = moved.termsControl;
        evidence.trustedTermsInput.moveObservedUtc = new Date().toISOString();
        let inputFailure;

        try {
            evidence.trustedTermsInput.downIssuedUtc = new Date().toISOString();
            await bounded(page.mouse.down(), termsRemaining(), 'trusted-terms-down');
            await Promise.race([hostFailure, page.waitForFunction(({ after, buttonIdentity }) => {
                const boot = globalThis.originalBoot;
                const value = boot?.termsControl;

                return boot?.completed || boot?.failures?.length || (value?.visible && value.enabled === true && value.sequence > after && value.buttonIdentity === buttonIdentity
                    && value.mouseX > value.x + 1 && value.mouseX < value.x + value.width - 1
                    && value.mouseY > value.y + 1 && value.mouseY < value.y + value.height - 1
                    && value.leftDown === true && value.buttonPressed === true);
            }, { after: moved.termsControl.sequence, buttonIdentity: terms.buttonIdentity }, { timeout: termsRemaining() })]);
            const pressed = await page.evaluate(() => globalThis.originalBoot);

            assert.equal(pressed.completed, false);
            assert.equal(pressed.failures.length, 0);
            assert.equal(pressed.termsControl.leftDown, true);
            assert.equal(pressed.termsControl.buttonPressed, true);
            assert.equal(pressed.termsControl.buttonIdentity, terms.buttonIdentity);
            evidence.trustedTermsInput.downObserved = pressed.termsControl;
            evidence.trustedTermsInput.downObservedUtc = new Date().toISOString();
        } catch (error) {
            inputFailure = error;
        } finally {
            try {
                // A real release is attempted even if a prior observation or transport fails.
                evidence.trustedTermsInput.releaseIssuedUtc = new Date().toISOString();
                // Release cleanup has its existing owner-close bound; it does not extend input observation.
                await bounded(page.mouse.up(), 5_000, 'trusted-terms-release-cleanup');
                evidence.trustedTermsInput.releaseCompleted = true;
                evidence.trustedTermsInput.releaseCompletedUtc = new Date().toISOString();
            } catch (error) {
                evidence.trustedTermsInput.releaseError = String(error.stack || error);

                inputFailure ??= error;
            }
        }

        if (inputFailure) {
            throw inputFailure;
        }
    }

    await Promise.race([hostFailure, page.waitForFunction((minimum) => globalThis.originalBoot?.completed || globalThis.originalBoot?.failures?.length
        || (globalThis.originalBoot?.termsControl?.visible === false
            && globalThis.originalBoot?.lastConsumedUi?.producerState === 'zombie.gameStates.MainScreenState'
            && globalThis.originalBoot.lastConsumedUi.mainMenuConsumed >= minimum), consumedBeforeInput + 3, { timeout: termsRemaining() })]);
    evidence.beforeStop = await page.evaluate(() => globalThis.originalBoot);
    evidence.termsTransitionObservedUtc = new Date().toISOString();
    assert.equal(evidence.beforeStop.completed, false);
    assert.equal(evidence.beforeStop.failures.length, 0);
    assert.equal(evidence.beforeStop.termsControl.visible, false);
    assert.equal(evidence.beforeStop.lastConsumedUi.producerState, 'zombie.gameStates.MainScreenState');
    assert.ok(evidence.beforeStop.lastConsumedUi.mainMenuConsumed >= consumedBeforeInput + 3);
    await page.locator('#graphics-canvas').screenshot({ path: path.join(output, 'initial-main-menu.png') });
    /**
     * Uses only the remaining original outer owner budget; never resets its deadline.
     *
     * @returns {number} Remaining owner time.
     */
    const loadingRemaining = () => {
        const remaining = outerDeadlineAt - Date.now();

        assert.ok(remaining > 0, 'Original owner deadline exceeded');

        return remaining;
    };

    const frontendDeadline = Date.now() + 60_000;

    evidence.frontendInput = [];
    /**
     * Bounds the genuine frontend setup phase independently of the preserved Terms phase.
     *
     * @returns {number} Remaining setup time.
     */
    const frontendRemaining = () => {
        const remaining = frontendDeadline - Date.now();

        assert.ok(remaining > 0, 'Original frontend setup deadline exceeded');

        return remaining;
    };

    /**
     * Waits for an actual visible original control without invoking Lua code.
     *
     * @param {string[]} ids - Original panel controls accepted at this branch.
     * @returns {Promise<object>} Original observation and selected control.
     */
    const waitFrontend = async (ids) => {
        await Promise.race([hostFailure, page.waitForFunction((wanted) => {
            const boot = globalThis.originalBoot;

            return boot?.completed || boot?.failures?.length || boot?.frontend?.controls.some((control) => wanted.includes(control.id) && control.enabled);
        }, ids, { timeout: frontendRemaining() })]);
        const boot = await page.evaluate(() => globalThis.originalBoot);

        assert.equal(boot.completed, false);
        assert.equal(boot.failures.length, 0);
        const control = boot.frontend.controls.find((value) => ids.includes(value.id) && value.enabled);

        assert.ok(control, 'Original enabled frontend control required');

        return { observation: boot.frontend, control };
    };

    /**
     * Uses trusted input and fresh original samples; final appearance Play is excluded.
     *
     * @param {object} selected - Actual original control and observation.
     * @param {object} selected.observation - Actual original post-UI observation.
     * @param {object} selected.control - Actual visible original control.
     * @param {string[]} next - Expected original next-screen controls.
     * @returns {Promise<object>} Actual next screen.
     */
    const pressFrontend = async ({ observation, control }, next) => {
        if (['spawn', 'appearance'].includes(control.id)) {
            assert.equal(observation.ownedPaths?.valid, true);
            assert.equal(observation.ownedPaths.noSave, false);

            if (control.id === 'spawn') {
                assert.ok(observation.prospectiveSave?.name);
                assert.equal(observation.prospectiveSave.exists, false);
            }
        }

        const canvas = await page.locator('#graphics-canvas').boundingBox();

        assert.ok(canvas && control.width > 2 && control.height > 2);
        const action = { control, before: observation, issuedUtc: new Date().toISOString() };

        evidence.frontendInput.push(action);
        await bounded(page.mouse.move(canvas.x + (control.x + control.width / 2) * canvas.width / control.screenWidth,
            canvas.y + (control.y + control.height / 2) * canvas.height / control.screenHeight), frontendRemaining());
        await Promise.race([hostFailure, page.waitForFunction(({ id, identity, after }) => {
            const boot = globalThis.originalBoot;
            const value = boot?.frontend;
            const target = value?.controls.find((item) => item.id === id && item.identity === identity && item.enabled);

            return boot?.completed || boot?.failures?.length || (target && value.sequence > after
                && value.mouseX > target.x + 1 && value.mouseX < target.x + target.width - 1
                && value.mouseY > target.y + 1 && value.mouseY < target.y + target.height - 1);
        }, { id: control.id, identity: control.identity, after: observation.sequence }, { timeout: frontendRemaining() })]);
        const moved = await page.evaluate(() => globalThis.originalBoot);

        assert.equal(moved.completed, false);
        assert.equal(moved.failures.length, 0);
        action.moveObserved = moved.frontend;
        let primary;

        try {
            await bounded(page.mouse.down(), frontendRemaining());

            if (control.button) {
                await Promise.race([hostFailure, page.waitForFunction(({ id, identity, after }) => {
                    const boot = globalThis.originalBoot;
                    const value = boot?.frontend;
                    const target = value?.controls.find((item) => item.id === id && item.identity === identity && item.enabled);

                    return boot?.completed || boot?.failures?.length || (target?.pressed && value.leftDown && value.sequence > after
                        && value.mouseX > target.x + 1 && value.mouseX < target.x + target.width - 1
                        && value.mouseY > target.y + 1 && value.mouseY < target.y + target.height - 1);
                }, { id: control.id, identity: control.identity, after: moved.frontend.sequence }, { timeout: frontendRemaining() })]);
                const pressed = await page.evaluate(() => globalThis.originalBoot);

                assert.equal(pressed.completed, false);
                assert.equal(pressed.failures.length, 0);
                action.downObserved = pressed.frontend;
            } else {
                // Original Solo is an ISLabel whose genuine action runs on mouse down.
                action.downObserved = (await waitFrontend(next)).observation;
            }
        } catch (error) {
            primary = error;
        } finally {
            try {
                await bounded(page.mouse.up(), 5_000);
                action.releaseCompleted = true;
            } catch (error) {
                action.releaseError = String(error.stack || error);
                primary ??= error;
            }
        }

        if (primary) {
            throw primary;
        }

        if (control.id === 'appearance') {
            action.finalPlayReleased = true;

            return { observation, control };
        }

        const result = await waitFrontend(next);

        action.nextObserved = result;

        return result;
    };

    let setup = await pressFrontend(await waitFrontend(['solo']), ['mode']);

    setup = await pressFrontend(setup, ['world', 'spawn']);

    if (setup.control.id === 'world') {
        setup = await pressFrontend(setup, ['spawn']);
    }

    setup = await pressFrontend(setup, ['profession']);
    const appearanceBefore = await page.evaluate(() => globalThis.originalBoot.lastConsumedUi?.appearanceConsumed || 0);

    setup = await pressFrontend(setup, ['appearance']);
    await Promise.race([hostFailure, page.waitForFunction(({ after, before }) => {
        const boot = globalThis.originalBoot;

        return boot?.completed || boot?.failures?.length || (boot?.lastConsumedUi?.originalUiConsumed > after
            && boot.lastConsumedUi.appearanceVisible === true && boot.lastConsumedUi.appearanceConsumed >= before + 3);
    }, { after: setup.observation.sequence, before: appearanceBefore }, { timeout: frontendRemaining() })]);
    await Promise.race([hostFailure, page.waitForFunction(() => {
        const boot = globalThis.originalBoot;

        return boot?.completed || boot?.failures?.length || boot?.presentation?.presents?.length === 3;
    }, undefined, { timeout: frontendRemaining() })]);
    const appearance = await page.evaluate(() => globalThis.originalBoot);

    assert.equal(appearance.completed, false);
    assert.equal(appearance.failures.length, 0);
    assert.ok(appearance.frontend.controls.some((control) => control.id === 'appearance' && control.identity === setup.control.identity));
    evidence.frontendAppearance = setup;
    evidence.frontendAppearanceConsumed = appearance.lastConsumedUi;
    evidence.actualPresentation = appearance.presentation;

    for (const [index, sample] of appearance.presentation.presents.entries()) {
        assert.match(sample.png, /^data:image\/png;base64,/u);
        // Write the three bounded PNG samples sequentially to keep output ordering explicit.
        // eslint-disable-next-line no-await-in-loop
        await writeFile(path.join(output, `appearance-present-${index + 1}.png`), Buffer.from(sample.png.split(',')[1], 'base64'));
    }

    evidence.finalPlayUnpressed = false;
    await page.locator('#graphics-canvas').screenshot({ path: path.join(output, 'original-character-creation.png') });
    evidence.pixelReviewRequired = true;
    await pressFrontend(await waitFrontend(['appearance']), []);
    await Promise.race([hostFailure, page.waitForFunction(() => {
        const boot = globalThis.originalBoot;
        const loading = boot?.loading;

        return boot?.completed || boot?.failures?.length || (loading?.readyForPhysicalClick
            && boot.presentation.actualPresents > loading.actualPresentsAtObservation);
    }, undefined, { timeout: loadingRemaining() })]);
    const loadingBoot = await page.evaluate(() => globalThis.originalBoot);

    assert.equal(loadingBoot.completed, false);
    assert.equal(loadingBoot.failures.length, 0);
    evidence.loadingReady = loadingBoot.loading;
    assert.equal(evidence.loadingReady.readyForPhysicalClick, true);
    await page.locator('#graphics-canvas').screenshot({ path: path.join(output, 'original-loading-ready.png') });
    let loadingPrimary;

    try {
        await bounded(page.mouse.down(), loadingRemaining());
        await Promise.race([hostFailure, page.waitForFunction(() => {
            const boot = globalThis.originalBoot;

            return boot?.completed || boot?.failures?.length
                || boot?.currentOriginalState?.name === 'zombie.gameStates.IngameState';
        }, undefined, { timeout: loadingRemaining() })]);
        evidence.loadingClickObserved = await page.evaluate(() => globalThis.originalBoot.observations.slice(-20));
    } catch (error) {
        loadingPrimary = error;
    } finally {
        try {
            await bounded(page.mouse.up(), 5_000);
        } catch (error) {
            loadingPrimary ??= error;
        }
    }

    if (loadingPrimary) {
        throw loadingPrimary;
    }

    await Promise.race([hostFailure, page.waitForFunction(() => {
        const boot = globalThis.originalBoot;

        return boot?.completed || boot?.failures?.length
            || (boot?.currentOriginalState?.name === 'zombie.gameStates.IngameState'
                && boot.presentation.actualPresents > boot.currentOriginalState.actualPresentsAtObservation);
    }, undefined, { timeout: loadingRemaining() })]);
    const entered = await page.evaluate(() => globalThis.originalBoot);

    assert.equal(entered.completed, false);
    assert.equal(entered.failures.length, 0);
    assert.ok(entered.currentOriginalState?.name === 'zombie.gameStates.IngameState');
    evidence.originalIngameObserved = true;
    await page.locator('#graphics-canvas').screenshot({ path: path.join(output, 'original-ingame.png') });
    await page.locator('#stop').click();
    await page.waitForFunction(() => globalThis.originalBoot?.completed, undefined, { timeout: 30_000 });
    evidence.result = await page.evaluate(() => ({ ...globalThis.originalBoot, mediaNegativeStat: globalThis.originalBoot?.mediaNegativeStatSnapshot?.() }));
    assert.equal(evidence.result.metadataDescriptorRestored, true);
    assert.equal(evidence.result.afterMetadataDispose?.active, false);
    const result = evidence.result;

    assert.equal(result.vmExitObserved, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.ownerJoined, true);
    assert.ok(result.javaBoundary?.mainMenuConsumed > 0);
    assert.equal(result.javaBoundary?.exceptionCount, 0);
    assert.equal(result.failures.length, 0);
    assert.equal(result.afterDispose?.contextLost, true);
    assert.equal(result.afterDispose?.keyboard.disposed, true);
    assert.equal(result.afterDispose?.keyboard.held.length, 0);
    assert.equal(result.afterDispose?.keyboard.pending, 0);
    assert.equal(result.afterDispose?.mouse.disposed, true);
    assert.equal(result.afterDispose?.mouse.held.length, 0);
    assert.equal(result.afterDispose?.mouse.pending, 0);
    assert.equal(result.afterDispose?.display.closed, true);
    assert.equal(result.afterDispose?.cursor.closed, true);
    assert.equal(result.afterDispose?.cursor.owned, 0);
    assert.equal(result.afterDispose?.processes.rejected, 0);
    assert.equal(result.afterDispose?.physics.chunks.length, 0);
    assert.equal(result.afterDispose?.physics.dynamicBodies.vehicles, 0);
    assert.equal(result.afterDispose?.physics.dynamicBodies.objects, 0);
    assert.equal(result.afterDispose?.controllers.listeners, 0);
    assert.equal(result.afterDispose?.watch.owned, 0);
    assert.equal(result.afterDispose?.watch.polls, 0);
    assert.equal(result.afterDispose?.watch.queuedPackets, 0);
    assert.equal(result.raknetWorkers?.running, 0);
    assert.equal(result.raknetWorkers?.unused, 0);
    assert.equal(denied.length, 0);
    assert.equal(logs.filter((line) => /ERROR:|Exception|PAGEERROR:|Missing import:|REQUESTFAILED:|HTTPSTATUS:|HTTP:|SEVERE|Error found in|flushErrorMessage/u.test(line)).length, 0);
    const observedNetwork = networkObserver.snapshot();

    assert.equal(observedNetwork.dropped, 0);
    assert.equal(observedNetwork.requests.filter((request) => request.failure || request.status >= 400).length, 0);
    assert.equal(observedNetwork.cdpFailures.length, 0);
    evidence.runtimeAssertionsPassed = true;
} catch (error) {
    evidence.error = String(error.stack || error);

    if (page && !page.isClosed()) {
        try {
            evidence.failureState = await bounded(page.evaluate(() => ({ ...globalThis.originalBoot, mediaNegativeStat: globalThis.originalBoot?.mediaNegativeStatSnapshot?.() })), 5_000);

            if (!evidence.failureState?.completed) {
                await bounded(page.locator('#stop').click(), 5_000);
                await bounded(page.waitForFunction(() => globalThis.originalBoot?.completed, undefined, { timeout: 30_000 }), 31_000);
                evidence.failureCleanupState = await bounded(page.evaluate(() => ({ ...globalThis.originalBoot, mediaNegativeStat: globalThis.originalBoot?.mediaNegativeStatSnapshot?.() })), 5_000);
            }
        } catch (failure) {
            evidence.failureObservationError = String(failure);
        }
    }
} finally {
    clearTimeout(deadline);
    clearInterval(checkpointTimer);
    ownerPhase = 'checkpoint-drain';

    try {
        writeFileSync(path.join(output, 'partial-cleanup-entry.json'), JSON.stringify({
            timing: { ...deadlineRecord, phase: ownerPhase, elapsedMilliseconds: Date.now() - ownerStartedAt },
            error: evidence.error ?? null, browserPid: browserServer?.process().pid ?? null, fullAuditCompleted: false,
        }));
        await bounded(checkpointPending, 5_000, 'checkpoint-drain');
    } catch (error) {
        checkpointErrors.push(String(error.stack ?? error));
    }

    ownerPhase = 'browser-cleanup';
    networkObserver?.markClosing();
    evidence.checkpointErrors = [...checkpointErrors];

    if (checkpointErrors.length) {
        evidence.runtimeAssertionsPassed = false;
    }

    const cleanupErrors = [];

    if (browserServer) {
        try {
            await bounded(browserServer.close(), 5_000);
        } catch (error) {
            cleanupErrors.push(String(error));
        }

        const ownedProcess = browserServer.process();

        if (ownedProcess.exitCode === null && ownedProcess.signalCode === null) {
            try {
                await bounded(browserServer.kill(), 5_000);
            } catch (error) {
                cleanupErrors.push(String(error));
            }
        }

        evidence.browserProcess = { exitCode: ownedProcess.exitCode, signalCode: ownedProcess.signalCode };

        if (ownedProcess.exitCode === null && ownedProcess.signalCode === null) {
            cleanupErrors.push('Owned browser still alive');
        }
    }

    if (fileWatchService) {
        try {
            await bounded(fileWatchService.close(), 5_000);
            evidence.watchClosed = fileWatchService.diagnostics();
            const closed = evidence.watchClosed;

            assert.ok(closed.closed && !closed.watchers && !closed.clients && !closed.queued
                && !closed.entries && !closed.watcherListeners && !closed.timerActive);
        } catch (error) {
            cleanupErrors.push(String(error));
        }
    }

    if (server) {
        try {
            await bounded(new Promise((resolve, reject) => {
                server.close((error) => {
                    if (error) {
                        reject(error);
                    } else {
                        resolve();
                    }
                });
            }), 5_000);
        } catch (error) {
            cleanupErrors.push(String(error));
        }
    }

    await bounded(Promise.allSettled([...activeMediaRequests]), 5_000).catch((error) => cleanupErrors.push(String(error)));

    const browserDead = !browserServer || browserServer.process().exitCode !== null || browserServer.process().signalCode !== null;

    if (closedMedia && browserDead) {
        try {
            evidence.closedMediaBeforeDispose = closedMedia.diagnostics();
            await bounded(closedMedia.dispose(), 5_000, 'closed-media-dispose');
            evidence.closedMediaAfterDispose = closedMedia.diagnostics();
            assert.equal(evidence.closedMediaAfterDispose.active, false);
            assert.equal(evidence.closedMediaAfterDispose.requests, 0);
            assert.equal(evidence.closedMediaAfterDispose.terminalFailure, null);
            assert.deepEqual(evidence.closedMediaAfterDispose.cleanupFailures, []);
        } catch (error) {
            cleanupErrors.push(String(error.stack ?? error));
        }
    } else if (closedMedia) {
        cleanupErrors.push('Browser death unconfirmed; actual media owner retained');
    }

    try {
        const certifiedPaths = new Set(closedMedia?.certificate.absent ?? []);

        evidence.certifiedMediaHttpRequests = requests.filter((item) => certifiedPaths.has(decodeURIComponent(new URL(item.url).pathname)));
        assert.deepEqual(evidence.certifiedMediaHttpRequests, [], 'Certified missing paths must not reach HTTP');
    } catch (error) {
        cleanupErrors.push(String(error.stack ?? error));
    }

    ownerPhase = 'immutable-posthash-audit';
    evidence.ownerTiming = { ...deadlineRecord, phase: ownerPhase, elapsedMilliseconds: Date.now() - ownerStartedAt };

    try {
        writeFileSync(path.join(output, 'logs-before-audit.json'), JSON.stringify(logs));
        writeFileSync(path.join(output, 'requests-before-audit.json'), JSON.stringify(requests));
        writeFileSync(path.join(output, 'partial-terminal-before-audit.json'), JSON.stringify({
            timing: evidence.ownerTiming, error: evidence.error ?? null, cleanupErrors,
            browserProcess: evidence.browserProcess ?? null, browserDead,
            media: closedMedia?.diagnostics() ?? null,
            latestOriginal: evidence.failureState?.latest ?? evidence.beforeStop?.latest ?? null,
            runtimeAssertionsPassed: evidence.runtimeAssertionsPassed ?? false,
            fullAuditCompleted: false,
        }, null, 2));
    } catch (error) {
        cleanupErrors.push(String(error.stack ?? error));
    }

    evidence.mediaAfterHashes = [];
    evidence.frozenAfterHashes = [];
    const frozen = new Map([...generation.routes, ...generation.hostSources, ...generation.rootSourceInputs, ...generation.closedMediaInputs,
        ...generation.hostSources.map((record) => ({ ...record, file: record.evidenceFile })),
        ...(evidence.positiveCertificateRoute ? [evidence.positiveCertificateRoute] : [])].map((record) => [record.file, record]));

    for (const [file, record] of frozen) {
        try {
            // Bound immutable post-runtime verification to one stream at a time.
            // eslint-disable-next-line no-await-in-loop
            assert.equal(await hash(file), record.sha256, file);
            // eslint-disable-next-line no-await-in-loop
            assert.equal((await stat(file)).size, record.bytes, file);
            evidence.frozenAfterHashes.push({ file, sha256: record.sha256, bytes: record.bytes, unchanged: true });
        } catch (error) {
            cleanupErrors.push(String(error));
        }
    }

    const publications = closedMedia?.publishedFiles() ?? [];
    const verifiedMedia = new Set(publications.map((record) => record.source));

    evidence.ownedSnapshotAfterHashes = [];

    for (const record of publications) {
        try {
            // eslint-disable-next-line no-await-in-loop -- Preserve one actual snapshot stream owner at a time.
            assert.equal(await hash(record.snapshot), record.sha256, record.snapshot);
            // eslint-disable-next-line no-await-in-loop
            assert.equal((await stat(record.snapshot)).size, record.bytes, record.snapshot);
            evidence.ownedSnapshotAfterHashes.push({ ...record, unchanged: true });
        } catch (error) {
            cleanupErrors.push(String(error.stack ?? error));
        }
    }

    for (const file of verifiedMedia) {
        try {
            // Hash sequentially to bound actual installed-media stream owners.
            // eslint-disable-next-line no-await-in-loop
            await owners.integrity(file);
            evidence.mediaAfterHashes.push({ file, unchanged: true });
        } catch (error) {
            cleanupErrors.push(String(error));
        }
    }

    evidence.fullAuditCompleted = evidence.frozenAfterHashes.length === frozen.size
        && evidence.ownedSnapshotAfterHashes.length === publications.length && evidence.mediaAfterHashes.length === verifiedMedia.size;
    evidence.ownerTiming = { ...deadlineRecord, phase: 'terminal', elapsedMilliseconds: Date.now() - ownerStartedAt };
    evidence.cleanupErrors = cleanupErrors;
    evidence.network = networkObserver?.snapshot();

    if (evidence.network?.dropped) {
        cleanupErrors.push('Network observation limit exceeded');
    }

    evidence.logs = logs;
    evidence.requests = requests;
    evidence.denied = denied;
    // Independent real screenshot review and exact owner diagnostic review are still mandatory.
    evidence.pass = false;
    evidence.reviewRequired = true;
    await writeFile(path.join(output, 'result.json'), JSON.stringify(evidence, null, 2));
    process.stdout.write(`${JSON.stringify({ output, runtimeAssertionsPassed: evidence.runtimeAssertionsPassed || false, checkpointErrors, cleanupErrors, pass: false, reviewRequired: true })}\n`);
    process.exitCode = 1;
}
