const MAX_VOICES = 32;
const MAX_ENCODED_BYTES = 16 * 1_024 * 1_024;
const MAX_DECODED_BYTES = 64 * 1_024 * 1_024;

/**
 * Return detached registration metadata without exposing the decoded buffer.
 *
 * @param {string} id - Registered asset identity.
 * @param {{owner: string, encodedBytes: number, decodedBytes: number, buffer: AudioBuffer}} entry - Decoded registry entry.
 * @returns {object} Asset identity, ownership, sizes and decoded format.
 */
function metadata(id, entry) {
    return {
        id, owner: entry.owner, encodedBytes: entry.encodedBytes, decodedBytes: entry.decodedBytes,
        duration: entry.buffer.duration, channels: entry.buffer.numberOfChannels,
        frames: entry.buffer.length, sampleRate: entry.buffer.sampleRate,
    };
}

/**
 * PORT presentation policy, not native FMOD event/parameter parity:
 * equal-power positional mono cues, linear attenuation from 1 to 32 world units
 * (rolloff 1), silent at/beyond 32. One world unit is one audio metre; world
 * (x,y,z) maps to audio (x,z,y), including vertical distance. Listener heading
 * is horizontal and normalized; up is audio +Y. Sources are omnidirectional.
 * Legacy loose footsteps/door samples are selected by the caller, not here.
 * No audio bytes, FMOD banks, timers, movement inference, or event dispatch.
 *
 * Lazily call this factory from a user gesture to create an owned native
 * AudioContext, never during preload. Inject an existing native AudioContext
 * or OfflineAudioContext for decoding/testing. Injected contexts are never
 * closed or disconnected as a whole.
 *
 * @param {{context?: AudioContext|OfflineAudioContext}} [options] - Native context injection; omission creates a context on the calling user gesture.
 * @returns {object} Audio registry, stoppable voices, lifecycle and detached diagnostics.
 */
export function createAudio({ context } = {}) {
    const owned = context === undefined;

    if (owned) {
        if (!globalThis.navigator?.userActivation?.isActive) {
            throw new Error('Audio creation requires a user gesture or an injected context');
        }

        context = new AudioContext();
    }

    const offline = typeof OfflineAudioContext !== 'undefined' && context instanceof OfflineAudioContext;

    if (!offline && !(typeof AudioContext !== 'undefined' && context instanceof AudioContext)) {
        throw new TypeError('Audio requires a native AudioContext or OfflineAudioContext');
    }

    const assets = new Map();
    const pending = new Map();
    const voices = new Map();
    const errors = [];
    let decodedBytes = 0;
    let decodingBytes = 0;
    let decodingCount = 0;
    let disposed = false;
    let paused = false;
    let lifecycle = 0;
    let nextVoice = 1;
    let disposal;
    let listener = { x: 0, y: 0, z: 0, forwardX: 0, forwardY: -1 };

    /**
     * Record an attributed failure and retain its native cause.
     *
     * @param {string} stage - Failed operation.
     * @param {string} [id] - Affected asset identity.
     * @param {string} [owner] - Responsible owner.
     * @param {string} message - Failure detail.
     * @param {unknown} [cause] - Original native failure.
     * @returns {Error} Error carrying the operation and ownership attributes.
     */
    function fail(stage, id, owner, message, cause) {
        const error = new Error(`Audio ${stage}${id ? ` [${id}]` : ''}: ${message}`, cause === undefined ? undefined : { cause });

        Object.assign(error, { stage, assetId: id, owner });
        errors.push({ stage, assetId: id, owner, message: error.message });

        if (errors.length > 32) {
            errors.shift();
        }

        return error;
    }

    /**
     * Reject operations after adapter disposal or native context closure.
     *
     * @param {string} stage - Requested operation.
     * @param {string} [id] - Affected asset identity.
     * @param {string} [owner] - Responsible owner.
     * @returns {void} Nothing on a live adapter.
     */
    function live(stage, id, owner) {
        if (disposed) {
            throw fail(stage, id, owner, 'adapter is disposed');
        }

        if (context.state === 'closed') {
            throw fail(stage, id, owner, 'context is closed');
        }
    }

    /**
     * Validate a bounded nonempty asset or owner identity.
     *
     * @param {unknown} value - Identity to validate.
     * @param {string} label - Identity name for failure messages.
     * @param {string} stage - Requested operation.
     * @param {string} [id] - Affected asset identity.
     * @param {string} [owner] - Responsible owner.
     * @returns {void} Nothing on valid input.
     */
    function identity(value, label, stage, id, owner) {
        if (typeof value !== 'string' || !value.trim() || value.length > 256) {
            throw fail(stage, id, owner, `${label} must be a nonempty string of at most 256 characters`);
        }
    }

    /**
     * Reject nonfinite positional or gain values before native writes.
     *
     * @param {unknown} value - Numeric input to validate.
     * @param {string} label - Input name for failure messages.
     * @param {string} stage - Requested operation.
     * @param {string} [id] - Affected asset identity.
     * @param {string} [owner] - Responsible owner.
     * @returns {void} Nothing on valid input.
     */
    function finite(value, label, stage, id, owner) {
        if (!Number.isFinite(value)) {
            throw fail(stage, id, owner, `${label} must be finite`);
        }
    }

    /**
     * Unregister a voice, remove its owned ended handler and release its nodes.
     *
     * @param {{id: number, source: AudioBufferSourceNode, gain: GainNode, panner: PannerNode, ended: function():void}} voice - Owned active voice.
     * @returns {void} Nothing; repeated completion is harmless.
     */
    function finish(voice) {
        if (!voices.delete(voice.id)) {
            return;
        }

        voice.source.removeEventListener('ended', voice.ended);
        voice.source.disconnect();
        voice.gain.disconnect();
        voice.panner.disconnect();
        voice.source.buffer = null;
    }

    /**
     * Stop an active source and synchronously release its owned nodes.
     *
     * @param {{id: number, source: AudioBufferSourceNode, gain: GainNode, panner: PannerNode, ended: function():void}} voice - Owned active voice.
     * @returns {void} Nothing; repeated stops are harmless.
     */
    function stop(voice) {
        if (!voices.has(voice.id)) {
            return;
        }

        voice.source.stop();
        finish(voice);
    }

    /**
     * Stop every voice using one registered asset, regardless of voice owner.
     *
     * @param {string} id - Asset identity to stop.
     * @returns {void} Nothing.
     */
    function stopAsset(id) {
        for (const voice of voices.values()) {
            if (voice.assetId === id) {
                stop(voice);
            }
        }
    }

    /**
     * Decode and register bytes; decodeAudioData consumes/detaches the input.
     * Same-owner replacement needs explicit override. Cross-owner replacement
     * is denied, including pending loads. Replacing stops that asset's voices.
     * Cache budget is decoded float PCM, not encoded file size; no eviction.
     * Cancellation cannot abort the browser decoder but forbids late admission.
     *
     * @param {string} id - Asset identity to register.
     * @param {ArrayBuffer} bytes - Encoded audio consumed and detached by the native decoder.
     * @param {object} [options] - Registration ownership and replacement policy.
     * @param {string} [options.owner='app'] - Owner authorized to replace or unload this asset.
     * @param {boolean} [options.override=false] - Explicit same-owner replacement permission.
     * @returns {Promise<object>} Detached metadata for the admitted decoded asset.
     */
    async function load(id, bytes, { owner = 'app', override = false } = {}) {
        live('load', id, owner);
        identity(id, 'asset id', 'load', id, owner);
        identity(owner, 'owner', 'load', id, owner);

        if (typeof override !== 'boolean') {
            throw fail('load', id, owner, 'override must be boolean');
        }

        if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0 || bytes.byteLength > MAX_ENCODED_BYTES) {
            throw fail('load', id, owner, 'encoded input must be a nonempty ArrayBuffer of at most 16 MiB');
        }

        const existing = assets.get(id);
        const loading = pending.get(id);

        if ((existing && existing.owner !== owner) || (loading && loading.owner !== owner)) {
            throw fail('load', id, owner, 'asset belongs to another owner');
        }

        if ((existing || loading) && !override) {
            throw fail('load', id, owner, 'asset exists; explicit override required');
        }

        if (decodingCount >= MAX_VOICES || decodingBytes + bytes.byteLength > MAX_DECODED_BYTES) {
            throw fail('load', id, owner, 'in-flight decode budget exceeded (32 decodes / 64 MiB encoded)');
        }

        const token = { owner, encodedBytes: bytes.byteLength };

        pending.set(id, token);
        decodingCount++;
        decodingBytes += token.encodedBytes;
        try {
            let buffer;

            try {
                buffer = await context.decodeAudioData(bytes);
            } catch (cause) {
                throw fail('decode', id, owner, cause.message || String(cause), cause);
            }

            if (disposed || pending.get(id) !== token || context.state === 'closed') {
                throw fail('load', id, owner, 'decode completed after cancellation or context closure');
            }

            const size = buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
            const previous = assets.get(id);

            if (!Number.isSafeInteger(size) || size < 4 || decodedBytes - (previous?.decodedBytes ?? 0) + size > MAX_DECODED_BYTES) {
                throw fail('load', id, owner, 'decoded cache budget exceeded (64 MiB)');
            }

            stopAsset(id);
            const entry = { owner, buffer, encodedBytes: token.encodedBytes, decodedBytes: size };

            assets.set(id, entry);
            decodedBytes += size - (previous?.decodedBytes ?? 0);

            return metadata(id, entry);
        } finally {
            decodingCount--;
            decodingBytes -= token.encodedBytes;

            if (pending.get(id) === token) {
                pending.delete(id);
            }
        }
    }

    /**
     * Start immediately; returned handle has stable numeric id and idempotent stop().
     *
     * @param {string} id - Registered asset identity.
     * @param {object} [options] - Position, gain and voice ownership.
     * @param {number} [options.x=0] - World X coordinate.
     * @param {number} [options.y=0] - World Y coordinate.
     * @param {number} [options.z=0] - World height.
     * @param {number} [options.volume=1] - Gain between zero and one.
     * @param {string} [options.owner='app'] - Owner of this voice, independent of asset ownership.
     * @param {boolean} [options.loop=false] - Whether to repeat the decoded buffer.
     * @returns {{id: number, stop: function(): void}} Frozen handle for this voice.
     */
    function play(id, { x = 0, y = 0, z = 0, volume = 1, owner = 'app', loop = false } = {}) {
        live('play', id, owner);
        identity(id, 'asset id', 'play', id, owner);
        identity(owner, 'owner', 'play', id, owner);

        for (const [label, value] of Object.entries({ x, y, z, volume })) {
            finite(value, label, 'play', id, owner);
        }

        if (volume < 0 || volume > 1) {
            throw fail('play', id, owner, 'volume must be between 0 and 1');
        }

        if (typeof loop !== 'boolean') {
            throw fail('play', id, owner, 'loop must be boolean');
        }

        const asset = assets.get(id);

        if (!asset) {
            throw fail('play', id, owner, 'unknown asset');
        }

        if (paused || (!offline && context.state !== 'running')) {
            throw fail('play', id, owner, 'context is paused or not running; unlock on a user gesture');
        }

        if (voices.size >= MAX_VOICES) {
            throw fail('play', id, owner, 'voice limit exceeded (32)');
        }

        let source;
        let gain;
        let panner;
        let voice;

        try {
            source = context.createBufferSource();
            gain = context.createGain();
            panner = context.createPanner();
            source.buffer = asset.buffer;
            source.loop = loop;
            gain.gain.value = volume;
            panner.panningModel = 'equalpower';
            panner.distanceModel = 'linear';
            panner.refDistance = 1;
            panner.maxDistance = 32;
            panner.rolloffFactor = 1;
            panner.coneInnerAngle = 360;
            panner.coneOuterAngle = 360;
            panner.positionX.value = x;
            panner.positionY.value = z;
            panner.positionZ.value = y;
            panner.orientationX.value = 1;
            panner.orientationY.value = 0;
            panner.orientationZ.value = 0;
            source.connect(gain);
            gain.connect(panner);
            panner.connect(context.destination);
            voice = {
                id: nextVoice++, assetId: id, owner, x, y, z, volume, loop, source, gain, panner,
                /**
                 * Release this voice after native playback ends.
                 *
                 * @returns {void} Nothing.
                 */
                ended() {
                    finish(voice);
                },
            };
            const handle = Object.freeze({
                id: voice.id,
                /**
                 * Stop and release this voice once.
                 *
                 * @returns {void} Nothing.
                 */
                stop: () => stop(voice),
            });

            source.addEventListener('ended', voice.ended);
            source.start();
            voices.set(voice.id, voice);

            return handle;
        } catch (cause) {
            if (voice) {
                source.removeEventListener('ended', voice.ended);
            }

            source?.disconnect();
            gain?.disconnect();
            panner?.disconnect();
            throw fail('play', id, owner, cause.message || String(cause), cause);
        }
    }

    /**
     * Normalize horizontal heading; zero heading is rejected before any writes.
     *
     * @param {object} position - Listener position and horizontal heading.
     * @param {number} position.x - World X coordinate.
     * @param {number} position.y - World Y coordinate.
     * @param {number} position.z - World height.
     * @param {number} [position.forwardX=0] - Horizontal heading X component.
     * @param {number} [position.forwardY=-1] - Horizontal heading Y component.
     * @returns {void} Nothing after updating the native listener.
     */
    function setListener({ x, y, z, forwardX = 0, forwardY = -1 }) {
        live('listener');

        for (const [label, value] of Object.entries({ x, y, z, forwardX, forwardY })) {
            finite(value, label, 'listener');
        }

        const magnitude = Math.hypot(forwardX, forwardY);

        if (!Number.isFinite(magnitude) || magnitude === 0) {
            throw fail('listener', undefined, undefined, 'heading must have finite nonzero length');
        }

        const next = { x, y, z, forwardX: forwardX / magnitude, forwardY: forwardY / magnitude };

        try {
            const native = context.listener;

            native.positionX.value = x;
            native.positionY.value = z;
            native.positionZ.value = y;
            native.forwardX.value = next.forwardX;
            native.forwardY.value = 0;
            native.forwardZ.value = next.forwardY;
            native.upX.value = 0;
            native.upY.value = 1;
            native.upZ.value = 0;
            listener = next;
        } catch (cause) {
            throw fail('listener', undefined, undefined, cause.message || String(cause), cause);
        }
    }

    /**
     * Resume realtime audio, surfacing permission/native errors instead of a fallback.
     *
     * @returns {Promise<void>} Resolves when the context is running and unpaused.
     */
    async function unlock() {
        live('unlock');

        if (offline) {
            throw fail('unlock', undefined, undefined, 'OfflineAudioContext must be rendered explicitly');
        }

        const activation = globalThis.navigator?.userActivation;

        if (context.state !== 'running' && activation && !activation.isActive && !activation.hasBeenActive) {
            throw fail('unlock', undefined, undefined, 'resume requires a user gesture');
        }

        const version = lifecycle;

        try {
            await context.resume();
        } catch (cause) {
            throw fail('unlock', undefined, undefined, cause.message || String(cause), cause);
        }

        if (disposed || lifecycle !== version) {
            throw fail('unlock', undefined, undefined, 'resume cancelled by pause/disposal');
        }

        if (context.state !== 'running') {
            throw fail('unlock', undefined, undefined, `resume did not run context (${context.state})`);
        }

        paused = false;
    }

    /**
     * Stop voices immediately, then suspend realtime audio; offline rendering is caller-owned.
     *
     * @returns {Promise<void>} Resolves after owned voices stop and realtime suspension completes.
     */
    async function pause() {
        live('pause');
        paused = true;
        lifecycle++;

        for (const voice of voices.values()) {
            stop(voice);
        }

        if (!offline) {
            try {
                await context.suspend();
            } catch (cause) {
                throw fail('pause', undefined, undefined, cause.message || String(cause), cause);
            }
        }
    }

    /**
     * Owner must match both loaded and pending registrations. Stops all voices using this asset.
     *
     * @param {string} id - Asset identity to withdraw.
     * @param {object} [options] - Asset ownership.
     * @param {string} [options.owner='app'] - Owner required for loaded and pending registrations.
     * @returns {boolean} Whether a loaded or pending registration existed.
     */
    function unload(id, { owner = 'app' } = {}) {
        live('unload', id, owner);
        identity(id, 'asset id', 'unload', id, owner);
        identity(owner, 'owner', 'unload', id, owner);
        const asset = assets.get(id);
        const loading = pending.get(id);

        if ((asset && asset.owner !== owner) || (loading && loading.owner !== owner)) {
            throw fail('unload', id, owner, 'asset belongs to another owner');
        }

        pending.delete(id);
        stopAsset(id);

        if (asset) {
            assets.delete(id);
            decodedBytes -= asset.decodedBytes;
        }

        return Boolean(asset || loading);
    }

    /**
     * Mod cleanup withdraws pending loads, owned assets and owned voices synchronously.
     *
     * @param {string} owner - Owner whose registrations and voices are withdrawn.
     * @returns {void} Nothing after synchronous owner cleanup.
     */
    function unloadOwner(owner) {
        live('owner cleanup', undefined, owner);
        identity(owner, 'owner', 'owner cleanup', undefined, owner);

        for (const [id, token] of pending) {
            if (token.owner === owner) {
                pending.delete(id);
            }
        }

        for (const [id, asset] of assets) {
            if (asset.owner === owner) {
                unload(id, { owner });
            }
        }

        for (const voice of voices.values()) {
            if (voice.owner === owner) {
                stop(voice);
            }
        }
    }

    /**
     * Idempotently release this adapter; only its owned realtime context is closed.
     *
     * @returns {Promise<void>} Shared completion promise, including native close failures.
     */
    function dispose() {
        if (disposed) {
            return disposal;
        }

        disposed = true;
        paused = true;
        lifecycle++;

        for (const voice of voices.values()) {
            stop(voice);
        }

        pending.clear();
        assets.clear();
        decodedBytes = 0;
        disposal = (async () => {
            if (owned && context.state !== 'closed') {
                try {
                    await context.close();
                } catch (cause) {
                    throw fail('dispose', undefined, undefined, cause.message || String(cause), cause);
                }
            }
        })();

        return disposal;
    }

    /**
     * Return detached metadata, including failures attributed to asset, owner and operation.
     *
     * @returns {object} Context lifecycle, limits, registration and voice metadata, and failures.
     */
    function diagnostics() {
        return {
            contextState: context.state, ownedContext: owned, offline, paused, disposed,
            listener: { ...listener }, decodedBytes, decodingBytes, decodingCount,
            limits: {
                voices: MAX_VOICES, encodedBytesPerAsset: MAX_ENCODED_BYTES,
                decodedBytes: MAX_DECODED_BYTES, decodingBytes: MAX_DECODED_BYTES, concurrentDecodes: MAX_VOICES,
            },
            policy: {
                coordinates: 'world(x,y,z) -> audio(x,z,y)', metresPerWorldUnit: 1,
                panningModel: 'equalpower', distanceModel: 'linear', refDistance: 1, maxDistance: 32, rolloffFactor: 1,
                nativeFmodParity: false,
            },
            loaded: [...assets].map(([id, entry]) => metadata(id, entry)),
            pending: [...pending].map(([id, token]) => ({ id, owner: token.owner, encodedBytes: token.encodedBytes })),
            activeVoices: [...voices.values()].map(({ id, assetId, owner, x, y, z, volume, loop }) => ({ id, assetId, owner, x, y, z, volume, loop })),
            errors: errors.map((error) => ({ ...error })),
        };
    }

    setListener(listener);

    return Object.freeze({ load, play, setListener, unlock, pause, dispose, unload, unloadOwner, diagnostics });
}
