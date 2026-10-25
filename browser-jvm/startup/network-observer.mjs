/**
 * Selects the byte range without retaining credentials or unrelated headers.
 *
 * @param {object} headers - Actual transport headers.
 * @returns {string|null} Requested range.
 */
const range = (headers) => Object.entries(headers).find(([name]) => name.toLowerCase() === 'range')?.[1] || null;

/**
 * Retains bounded in-flight identities and all bounded failures, with fixed successful samples.
 *
 * @param {object} context - Owned browser context or authored fixture emitter.
 * @param {object} page - Owned page supplied to its actual CDP session.
 * @returns {Promise<object>} Read-only observation owner.
 */
export async function createGateNetworkObserver(context, page) {
    const started = performance.now();
    const limit = 20_000;
    const identities = new WeakMap();
    const active = new Map();
    const failures = new Map();
    const firstSuccesses = [];
    const lastSuccesses = [];
    const cdpActive = new Map();
    const cdpFailures = new Map();
    const cdpSuccesses = [];
    const counts = {
        started: 0, finished: 0, failed: 0, httpErrors: 0, activePeak: 0,
        cdpStarted: 0, cdpFinished: 0, cdpFailed: 0, cdpHttpErrors: 0, cdpActivePeak: 0, unmatchedCdpFailures: 0,
    };
    let dropped = 0;
    let closing = false;

    /**
     * Preserves bounded failures without evicting earlier evidence.
     *
     * @param {Map} records - Actual failure owner.
     * @param {string|number} key - Exact identity within this transport.
     * @param {object} value - Selected metadata.
     */
    const retain = (records, key, value) => {
        if (!records.has(key) && records.size >= limit) {
            dropped++;
        } else {
            records.set(key, value);
        }
    };

    /**
     * Resolves actual Request identity once, bounded only by concurrent requests.
     *
     * @param {object} request - Actual request.
     * @returns {object|undefined} Selected identity metadata.
     */
    const record = (request) => {
        if (identities.has(request)) {
            return identities.get(request);
        }

        const id = ++counts.started;

        if (active.size >= limit) {
            dropped++;
            identities.set(request, undefined);

            return undefined;
        }

        const value = {
            id, url: request.url(), method: request.method(), resourceType: request.resourceType(),
            range: range(request.headers()), startedMilliseconds: performance.now() - started, closingAtStart: closing,
        };

        identities.set(request, value);
        active.set(request, value);
        counts.activePeak = Math.max(counts.activePeak, active.size);

        return value;
    };

    context.on('request', record);
    context.on('response', (response) => {
        const value = record(response.request());

        if (!value) {
            return;
        }

        const headers = response.headers();

        Object.assign(value, {
            responseMilliseconds: performance.now() - started, status: response.status(),
            contentRange: headers['content-range'] || null, contentLength: headers['content-length'] || null,
        });

        if (value.status >= 400) {
            counts.httpErrors++;
            retain(failures, value.id, value);
        }
    });
    context.on('requestfailed', (request) => {
        counts.failed++;
        const value = record(request);

        active.delete(request);

        if (!value) {
            return;
        }

        Object.assign(value, {
            failedMilliseconds: performance.now() - started,
            failure: request.failure()?.errorText, closingAtFailure: closing,
        });
        retain(failures, value.id, value);
    });
    context.on('requestfinished', (request) => {
        counts.finished++;
        const value = record(request);

        active.delete(request);

        if (!value) {
            return;
        }

        value.finishedMilliseconds = performance.now() - started;

        if (value.status >= 400 || value.failure) {
            return;
        }

        if (firstSuccesses.length < 32) {
            firstSuccesses.push(value);
        }

        lastSuccesses.push(value);

        if (lastSuccesses.length > 32) {
            lastSuccesses.shift();
        }
    });
    const session = await context.newCDPSession(page);

    await session.send('Network.enable');
    session.on('Network.requestWillBeSent', (event) => {
        counts.cdpStarted++;

        if (!cdpActive.has(event.requestId) && cdpActive.size >= limit) {
            dropped++;

            return;
        }

        const frames = event.initiator?.stack?.callFrames?.slice(0, 24).map((frame) => ({
            functionName: frame.functionName, url: frame.url, lineNumber: frame.lineNumber, columnNumber: frame.columnNumber,
        }));

        cdpActive.set(event.requestId, {
            requestId: event.requestId, url: event.request.url, method: event.request.method,
            resourceType: event.type, range: range(event.request.headers), timestamp: event.timestamp,
            frameId: event.frameId, loaderId: event.loaderId, closingAtStart: closing,
            initiator: { type: event.initiator?.type, url: event.initiator?.url, lineNumber: event.initiator?.lineNumber, frames },
        });
        counts.cdpActivePeak = Math.max(counts.cdpActivePeak, cdpActive.size);
    });
    session.on('Network.responseReceived', (event) => {
        const value = cdpActive.get(event.requestId);

        if (!value) {
            return;
        }

        Object.assign(value, {
            status: event.response.status, responseTimestamp: event.timestamp,
            contentRange: event.response.headers['content-range'] || event.response.headers['Content-Range'] || null,
            contentLength: event.response.headers['content-length'] || event.response.headers['Content-Length'] || null,
        });

        if (value.status >= 400) {
            counts.cdpHttpErrors++;
            retain(cdpFailures, event.requestId, value);
        }
    });
    session.on('Network.loadingFinished', (event) => {
        counts.cdpFinished++;
        const value = cdpActive.get(event.requestId);

        cdpActive.delete(event.requestId);

        if (!value) {
            return;
        }

        value.finishedTimestamp = event.timestamp;

        if (value.status >= 400) {
            return;
        }

        if (cdpSuccesses.length < 32) {
            cdpSuccesses.push(value);
        }
    });
    session.on('Network.loadingFailed', (event) => {
        counts.cdpFailed++;
        const value = cdpActive.get(event.requestId) || cdpFailures.get(event.requestId);

        cdpActive.delete(event.requestId);

        if (!value) {
            counts.unmatchedCdpFailures++;
        }

        retain(cdpFailures, event.requestId, {
            ...value, requestId: event.requestId, initiatorMissing: !value,
            failedTimestamp: event.timestamp, errorText: event.errorText, canceled: event.canceled,
            blockedReason: event.blockedReason, type: event.type, closingAtFailure: closing,
        });
    });

    return {
        /** Marks real host teardown without changing browser behavior. */
        markClosing() {
            closing = true;
        },
        /**
         * Publishes bounded diagnostics; successful samples are not complete traffic history.
         *
         * @returns {object} Actual failures, samples, concurrency and coverage observations.
         */
        snapshot() {
            return {
                requests: [...failures.values()], cdpFailures: [...cdpFailures.values()],
                successfulSamples: { first: [...firstSuccesses], last: [...lastSuccesses], cdpFirst: [...cdpSuccesses] },
                counts: { ...counts }, active: active.size, cdpActive: cdpActive.size, dropped, limit, closing,
                cdpScope: 'Owned main-page Network session; OOPIF coverage is not guaranteed',
                cdpRedirectHopHistoryComplete: false,
                successfulHistoryComplete: false, elapsedMilliseconds: performance.now() - started,
            };
        },
    };
}
