/**
 * Owns the compiled RakPeer/voice plugin initialization boundary. Channel codecs are separate.
 *
 * @param {object} engine - Genuine prepared RakNet engine.
 * @returns {object} Qualified original initialization native callbacks.
 */
export function createRakVoiceNatives(engine) {
    return {
        natives: {
            /**
             * Attaches the real compiled plugin to its owned RakPeer without starting a socket.
             *
             * @param {object} lib - Original Java namespace.
             * @param {number} bytes - Original voice buffer size.
             */
            Java_zombie_core_raknet_RakVoice_RVInit(lib, bytes) {
                if (!Number.isInteger(bytes) || bytes < 0 || bytes > 0xFF_FF_FF_FF || engine._rn_voice_init(bytes) !== 0) {
                    throw new Error('Actual RakVoice plugin initialization rejected');
                }
            },
            /**
             * Stores the original complexity in the compiled, currently channel-free owner.
             *
             * @param {object} lib - Original Java namespace.
             * @param {number} value - Original encoder complexity.
             */
            Java_zombie_core_raknet_RakVoice_SetComplexity(lib, value) {
                if (engine._rn_voice_set_complexity(value) !== 0) {
                    throw new Error('RakVoice complexity requires the actual plugin owner');
                }
            },
            /**
             * Detaches the real plugin while preserving its original static configuration.
             *
             */
            Java_zombie_core_raknet_RakVoice_RVDeinit() {
                if (engine._rn_voice_deinit() !== 0) {
                    throw new Error('RakVoice disposal requires the actual plugin owner');
                }
            },
        },
    };
}
