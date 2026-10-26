/**
 * Owns real mono Opus codec pairs with the shipped RakVoice encoder parameters.
 * Channel signaling, transport, and recording are separate owners.
 *
 * @param {object} engine - Pinned genuine Opus module.
 * @returns {object} Codec-pair allocation, encoding, decoding, and release.
 */
export function createOpusVoiceCodecs(engine) {
    const owners = new Map();

    /**
     * Allocates a real codec pair; the library validates its original sample rate and complexity.
     *
     * @param {number} sampleRate - Original negotiated mono sample rate.
     * @param {number} complexity - Original encoder complexity.
     * @returns {number} Actual owned codec identity.
     */
    function create(sampleRate, complexity) {
        if (!Number.isInteger(sampleRate) || sampleRate <= 0 || sampleRate > 48_000
            || !Number.isInteger(complexity) || complexity < 0 || complexity > 10) {
            throw new TypeError('Integer Opus parameters required');
        }

        const id = engine._voice_codec_create(sampleRate, complexity);

        if (!id) {
            throw new Error('Actual Opus codec creation rejected');
        }

        owners.set(id, sampleRate);

        return id;
    }

    /**
     * Allocates a genuine incoming decoder without an unused encoder for each remote player.
     *
     * @param {number} sampleRate - Original negotiated mono sample rate.
     * @returns {number} Actual owned decoder identity.
     */
    function createDecoder(sampleRate) {
        if (!Number.isInteger(sampleRate) || sampleRate <= 0 || sampleRate > 48_000) {
            throw new TypeError('Integer Opus sample rate required');
        }

        const id = engine._voice_decoder_create(sampleRate);

        if (!id) {
            throw new Error('Actual Opus decoder creation rejected');
        }

        owners.set(id, sampleRate);

        return id;
    }

    /**
     * Encodes one actual signed16 mono frame; no encoded bytes or readiness are synthesized.
     *
     * @param {number} id - Owned codec identity.
     * @param {Int16Array} samples - Original PCM samples.
     * @returns {Uint8Array} Actual Opus packet.
     */
    function encode(id, samples) {
        if (!owners.has(id) || !(samples instanceof Int16Array) || !samples.length || samples.length > owners.get(id) * 120 / 1_000) {
            throw new TypeError('Owned Opus codec and bounded PCM frame required');
        }

        const input = engine._malloc(samples.byteLength + 1_275);

        if (!input) {
            throw new Error('Actual Opus input allocation failed');
        }

        try {
            const output = input + samples.byteLength;

            engine.HEAP16.set(samples, input / 2);

            const count = engine._voice_codec_encode(id, input, samples.length, output, 1_275);

            if (count < 0 || count > 1_275) {
                throw new Error(`Actual Opus encode failed: ${count}`);
            }

            return engine.HEAPU8.slice(output, output + count);
        } finally {
            engine._free(input);
        }
    }

    /**
     * Decodes a genuine packet using its stateful codec owner.
     *
     * @param {number} id - Owned codec identity.
     * @param {Uint8Array} packet - Actual received Opus packet.
     * @param {number} [maximumSamples] - Original bounded output capacity when explicitly supplied.
     * @returns {Int16Array} Actual decoded mono PCM.
     */
    function decode(id, packet, maximumSamples) {
        if (!owners.has(id) || !(packet instanceof Uint8Array) || !packet.length || packet.length > 1_275) {
            throw new TypeError('Owned Opus codec and bounded packet required');
        }

        const capacity = maximumSamples ?? owners.get(id) * 120 / 1_000;

        if (!Number.isInteger(capacity) || capacity < 1 || capacity > 5_760) {
            throw new TypeError('Bounded actual Opus decode capacity required');
        }

        const offset = (packet.length + 1) & ~1;
        const input = engine._malloc(offset + capacity * 2);

        if (!input) {
            throw new Error('Actual Opus decode allocation failed');
        }

        try {
            const output = input + offset;

            engine.HEAPU8.set(packet, input);

            const count = engine._voice_codec_decode(id, input, packet.length, output, capacity);

            if (count < 0 || count > capacity) {
                throw new Error(`Actual Opus decode failed: ${count}`);
            }

            return engine.HEAP16.slice(output / 2, output / 2 + count);
        } finally {
            engine._free(input);
        }
    }

    /**
     * Releases both actual codec states exactly once.
     *
     * @param {number} id - Owned codec identity.
     */
    function destroy(id) {
        if (!owners.has(id) || engine._voice_codec_destroy(id) !== 0) {
            throw new Error('Foreign or released Opus codec');
        }

        owners.delete(id);
    }

    return { create, createDecoder, encode, decode, destroy };
}
