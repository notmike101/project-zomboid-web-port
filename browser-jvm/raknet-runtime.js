let pending;
let engine;
let disposed = false;
let initializations = 0;

/**
 * Loads the genuine full upstream engine once; no peers or codec fixtures execute here.
 *
 * @returns {Promise<object>} Actual initialized Emscripten module.
 */
function ensureRakNetOwner() {
    if (disposed) {
        return Promise.reject(new Error('RakNet owner has been disposed'));
    }

    pending ??= initialize();

    return pending;
}

/**
 * Checks the actual pthread platform before publishing the module owner.
 *
 * @returns {Promise<object>} Full engine after its real static constructors.
 */
async function initialize() {
    if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer !== 'function') {
        throw new Error('RakNet requires an isolated origin and real shared memory');
    }

    const moduleUrl = new URL('./raknet-engine.mjs', import.meta.url).href;
    const { default: factory } = await import(moduleUrl);
    const candidate = await factory();

    if (!(candidate.HEAPU8.buffer instanceof SharedArrayBuffer) || candidate._pthread_self() === 0
        || typeof candidate.PThread?.terminateAllThreads !== 'function') {
        throw new Error('RakNet full-engine pthread initialization failed');
    }

    engine = candidate;
    initializations++;

    return engine;
}

/**
 * Copies initialization state without exposing peer creation or mutable engine internals.
 *
 * @returns {object} Current owner and actual worker counts.
 */
function rakNetDiagnostics() {
    return {
        ready: Boolean(engine) && !disposed,
        initializations,
        disposed,
        runningWorkers: engine?.PThread.runningWorkers.length ?? 0,
        unusedWorkers: engine?.PThread.unusedWorkers.length ?? 0,
    };
}

/**
 * Releases actual worker owners at JVM disposal; global C++ destruction remains unqualified.
 *
 * @returns {object} Worker counts after termination.
 */
function disposeRakNetOwner() {
    if (pending && !engine) {
        throw new Error('Cannot dispose RakNet while initialization is pending or failed');
    }

    if (engine?._bs_live() !== undefined && engine._bs_live() !== 0) {
        throw new Error('Cannot dispose RakNet with live BitStream owners');
    }

    engine?._rn_voice_destroy?.();

    if (engine?._rn_shared_peer_destroy && engine._rn_shared_peer_destroy() !== 0) {
        throw new Error('Cannot dispose RakNet with an attached voice owner');
    }

    engine?.PThread.terminateAllThreads();
    disposed = true;

    return { running: engine?.PThread.runningWorkers.length ?? 0, unused: engine?.PThread.unusedWorkers.length ?? 0 };
}

export { ensureRakNetOwner, rakNetDiagnostics, disposeRakNetOwner };
