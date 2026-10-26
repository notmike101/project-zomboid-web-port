/**
 * Checks the actual unsigned64 channel identity without Number rounding.
 *
 * @param {bigint} guid - Original remote identity.
 */
function checkGuid(guid) {
    if (typeof guid !== 'bigint' || guid < 0n || guid > 0xFF_FF_FF_FF_FF_FF_FF_FFn) {
        throw new TypeError('Exact unsigned64 RakVoice identity required');
    }
}

/**
 * Processes the shipped client negotiation and outgoing PCM queue with genuine codec owners.
 * Returned packets require the same network peer; this component does not start or claim a transport.
 *
 * @param {object} codecs - Actual Opus codec owner.
 * @param {number} bufferBytes - Original RVInit buffer size.
 * @returns {object} Client negotiation, queue, packet preparation, and local disposal.
 */
export function createRakVoiceChannels(codecs, bufferBytes) {
    if (!Number.isInteger(bufferBytes) || bufferBytes <= 0 || bufferBytes % 2 !== 0 || bufferBytes > 21_474_836) {
        throw new TypeError('Bounded original voice buffer size required');
    }

    const channels = new Map();
    const capacity = bufferBytes * 100;
    const factors = new Map([[2, 1], [5, 2], [10, 4], [20, 8], [40, 16], [60, 32]]);
    let configuration;

    /**
     * Parses a genuine server reply and allocates its actual encoder/decoder pair before publication.
     *
     * @param {bigint} guid - Original remote identity.
     * @param {Uint8Array} packet - Original0x2D negotiation packet.
     */
    function openReply(guid, packet) {
        checkGuid(guid);

        if (!(packet instanceof Uint8Array) || packet.length !== 33 || packet[0] !== 0x2D) {
            throw new TypeError('Complete original RakVoice server negotiation required');
        }

        const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
        const pending = {
            enabled: view.getUint32(1) > 0,
            sampleRate: view.getInt32(5),
            period: view.getInt32(9),
            encoderComplexity: view.getInt32(13),
            buffering: view.getInt32(17),
            minDistance: view.getFloat32(21),
            maxDistance: view.getFloat32(25),
            is3D: view.getUint32(29) > 0,
        };

        if (!factors.has(pending.period) || !Number.isFinite(pending.minDistance) || !Number.isFinite(pending.maxDistance)) {
            throw new Error('Unsupported original RakVoice negotiation');
        }

        const ring = new Uint8Array(capacity);
        const codec = codecs.create(pending.sampleRate, pending.encoderComplexity);
        const previous = channels.get(guid);

        if (previous) {
            codecs.destroy(previous.codec);
        }

        channels.set(guid, { codec, ring, read: 0, write: 0, playerId: 0, sequence: 0, lastUpdate: 0 });
        configuration = pending;
    }

    /**
     * Copies the original capture block into its negotiated circular queue.
     *
     * @param {bigint} guid - Original remote identity.
     * @param {number} playerId - Original player identity stored for the next packet batch.
     * @param {Uint8Array} bytes - Actual signed16 PCM bytes in native little-endian order.
     * @returns {boolean} Original absent-channel false or real queue acceptance.
     */
    function queue(guid, playerId, bytes) {
        checkGuid(guid);

        const channel = channels.get(guid);

        if (!channel) {
            return false;
        }

        if (!Number.isInteger(playerId) || playerId < -2_147_483_648 || playerId > 2_147_483_647
            || !(bytes instanceof Uint8Array) || bytes.length !== bufferBytes) {
            throw new TypeError('Original bounded capture block and player identity required');
        }

        const available = (channel.write - channel.read + capacity) % capacity;

        // shortcut: Original overwrite behavior needs qualification before admitting a saturated capture queue.
        if (bytes.length >= capacity - available) {
            throw new Error('Unqualified RakVoice capture queue overflow');
        }

        if (channel.write + bytes.length > capacity) {
            throw new Error('Unqualified non-aligned original capture write');
        }

        channel.ring.set(bytes, channel.write);
        channel.write = (channel.write + bytes.length) % capacity;
        channel.playerId = playerId;

        return true;
    }

    /**
     * Prepares actual encoded packets at the original unsigned millisecond boundary.
     *
     * @param {number} now - Actual peer clock milliseconds.
     * @returns {Array<object>} Original wire frames awaiting the same peer's transport.
     */
    function prepareOutgoing(now) {
        if (!Number.isInteger(now) || now < 0 || now > 0xFF_FF_FF_FF) {
            throw new TypeError('Original unsigned peer clock required');
        }

        const packets = [];

        if (!configuration) {
            return packets;
        }

        const frameBytes = Math.trunc(configuration.sampleRate / 400) * factors.get(configuration.period);

        if (frameBytes <= 0 || frameBytes % 2 !== 0) {
            throw new Error('Original negotiated PCM frame is not supported');
        }

        for (const guid of [...channels.keys()].sort((a, b) => Number(a > b) - Number(a < b))) {
            const channel = channels.get(guid);

            if (((now - channel.lastUpdate) >>> 0) <= configuration.period) {
                continue;
            }

            let available = (channel.write - channel.read + capacity) % capacity;

            while (available >= frameBytes) {
                const samples = new Int16Array(frameBytes / 2);
                const view = new DataView(channel.ring.buffer);

                for (let index = 0; index < samples.length; index++) {
                    samples[index] = view.getInt16((channel.read + index * 2) % capacity, true);
                }

                channel.read = (channel.read + frameBytes) % capacity;
                available -= frameBytes;

                const encoded = codecs.encode(channel.codec, samples);

                if (channel.playerId < 0) {
                    continue;
                }

                const packet = new Uint8Array(7 + encoded.length);
                const header = new DataView(packet.buffer);

                packet[0] = 0x2F;
                header.setUint16(1, channel.sequence, true);
                header.setInt32(3, channel.playerId, true);
                packet.set(encoded, 7);
                channel.sequence = (channel.sequence + 1) & 0xFF_FF;
                channel.lastUpdate = now;
                packets.push({ guid, packet });
            }
        }

        return packets;
    }

    /**
     * Releases an actual local channel; network close signaling belongs to its shared peer.
     *
     * @param {bigint} guid - Original remote identity.
     */
    function close(guid) {
        checkGuid(guid);

        const channel = channels.get(guid);

        if (channel) {
            codecs.destroy(channel.codec);
            channels.delete(guid);
        }
    }

    /**
     * Releases every actual local codec and capture queue without claiming network close delivery.
     */
    function closeAll() {
        for (const guid of channels.keys()) {
            close(guid);
        }
    }

    /**
     * Copies negotiated fields and actual queue positions for bounded observation.
     *
     * @param {bigint} guid - Original remote identity.
     * @returns {object} Current real owner state.
     */
    function snapshot(guid) {
        const channel = channels.get(guid);
        let state = null;

        if (channel) {
            state = {
                read: channel.read, write: channel.write, sequence: channel.sequence,
                remaining: Array.from({ length: (channel.write - channel.read + capacity) % capacity },
                    (_, index) => channel.ring[(channel.read + index) % capacity]),
            };
        }

        return {
            configuration: configuration ? { ...configuration } : null,
            channel: state,
        };
    }

    return { openReply, queue, prepareOutgoing, close, closeAll, snapshot };
}
