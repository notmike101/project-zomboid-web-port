/* eslint-disable jsdoc/require-jsdoc -- Internal public-SDK boundary helpers are owned by the FMOD runtime. */
// Public Web Audio ownership boundary, scoped to the synchronous SDK initialization call.
export function createOwnedAudioContexts(surface = globalThis) {
    const contexts = new Set();
    let capturing = false;

    return {
        initialize(operation) {
            if (capturing) {
                throw new Error('Nested FMOD audio initialization');
            }

            const Original = surface.AudioContext;

            if (typeof Original !== 'function') {
                throw new TypeError('Public AudioContext constructor unavailable');
            }

            capturing = true;
            surface.AudioContext = new Proxy(Original, {
                construct(target, args, newTarget) {
                    const context = Reflect.construct(target, args, newTarget);
                    const close = context.close.bind(context);
                    let closing;

                    context.close = () => closing ??= close();
                    contexts.add(context);

                    return context;
                },
            });

            try {
                const result = operation();

                if (result && typeof result.then === 'function') {
                    throw new Error('Synchronous public SDK initialization required');
                }

                return result;
            } finally {
                surface.AudioContext = Original;
                capturing = false;
            }
        },
        snapshot() {
            return [...contexts].map((context) => ({ state: context.state, sampleRate: context.sampleRate }));
        },
        async resume() {
            await Promise.all([...contexts].filter((context) => context.state === 'suspended').map((context) => context.resume()));
        },
        async close() {
            if (!contexts.size) {
                throw new Error('No owned audio context captured');
            }

            await Promise.all([...contexts].map((context) => context.close()));
        },
    };
}
