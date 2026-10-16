/**
 * Supplies CheerpJ4.3 Java17's missing C import through its existing real loader.
 * Built-in native loading and original Java library bookkeeping remain intact.
 *
 * @param {object} runtime - Initialized CheerpJ runtime export/import map.
 * @returns {boolean} Whether the missing import was installed.
 */
export function installNativeLibraryLoader(runtime) {
    if (!runtime || typeof runtime.cj3LoadLibrary !== 'function') {
        throw new TypeError('The qualified CheerpJ native library loader is unavailable');
    }

    if (runtime.JVM_LoadLibrary !== undefined) {
        if (typeof runtime.JVM_LoadLibrary !== 'function') {
            throw new TypeError('Invalid existing JVM_LoadLibrary import');
        }

        return false;
    }

    /**
     * Delegates a NUL-terminated native path and its original continuation.
     *
     * @param {number} pointer - Original native path pointer.
     * @param {...unknown} args - Original exception flag and continuation.
     * @returns {number} Real loader handle, with runtime-managed suspension.
     */
    runtime.JVM_LoadLibrary = (pointer, ...args) => runtime.cj3LoadLibrary(pointer, -1, args[1]);

    return true;
}
