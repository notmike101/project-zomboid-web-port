/**
 * Matches the exact public runtime helper without changing native coercion of other values.
 *
 * @param {unknown} value - Native iframe source argument.
 * @returns {boolean} Whether this is the pinned public download helper.
 */
function isHelper(value) {
    if (typeof value !== 'string') {
        return false;
    }

    try {
        return new URL(value, document.baseURI).href === 'https://cjrtnc.leaningtech.com/4.3/c.html';
    } catch {
        return false;
    }
}

/**
 * Enables native credentialless mode only for the official public CheerpJ 4.3 downloader frame.
 *
 * @returns {object} Owned descriptor restoration and copied frame diagnostics.
 */
export function installCredentiallessRuntimeHelper() {
    const prototype = HTMLIFrameElement.prototype;
    const source = Object.getOwnPropertyDescriptor(prototype, 'src');
    const credentials = Object.getOwnPropertyDescriptor(prototype, 'credentialless');

    if (!source?.configurable || typeof source.set !== 'function' || typeof source.get !== 'function'
        || typeof credentials?.set !== 'function' || typeof credentials.get !== 'function') {
        throw new Error('This browser lacks native credentialless iframe support');
    }

    const frames = new Set();
    let matches = 0;
    let disposed = false;

    /**
     * Activates the real browser property before delegating to its original source setter.
     *
     * @this {HTMLIFrameElement}
     * @param {unknown} value - Unmodified source argument.
     * @returns {unknown} Original native setter result.
     */
    function setSource(value) {
        if (this instanceof HTMLIFrameElement && isHelper(value)) {
            Reflect.apply(credentials.set, this, [true]);

            if (Reflect.apply(credentials.get, this, []) !== true) {
                throw new Error('Native credentialless activation failed');
            }

            frames.add(this);
            matches++;
        }

        return Reflect.apply(source.set, this, [value]);
    }

    Object.defineProperty(prototype, 'src', { ...source, set: setSource });

    return {
        /**
         * Reads actual native properties without publishing mutable frame owners.
         *
         * @returns {object} Match count and native frame states.
         */
        snapshot() {
            return {
                supported: true, matches, disposed,
                frames: [...frames].map((frame) => ({ source: Reflect.apply(source.get, frame, []), credentialless: Reflect.apply(credentials.get, frame, []), connected: frame.isConnected })),
            };
        },
        /**
         * Restores the exact owned native descriptor; runtime-owned frames remain runtime-owned.
         *
         * @returns {void} Nothing.
         */
        dispose() {
            if (disposed) {
                return;
            }

            const current = Object.getOwnPropertyDescriptor(prototype, 'src');

            if (current?.set !== setSource || current.get !== source.get) {
                throw new Error('Runtime helper source descriptor ownership changed');
            }

            Object.defineProperty(prototype, 'src', source);
            disposed = true;
            frames.clear();
        },
    };
}
