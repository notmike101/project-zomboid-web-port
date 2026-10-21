const expectedFloat = 'function agJ(p,n,l,j,h){var f=null,c=-0.,a=null;if(n!==null){a="d";f=cf(n,a,j,4);return f;}a=Q.a2;c=+Number(j);a=a.a14;return  +a[~~c>>>2];}';
const installed = new WeakMap();

/**
 * Publishes only the absent volatile getter using the pinned real runtime accessor.
 *
 * @param {object} runtime - Actual initialized cj3Module export object.
 * @returns {void} No field or native memory is changed.
 */
export function installUnsafeFloatVolatile(runtime) {
    if (!runtime || typeof runtime !== 'object') {
        throw new TypeError('Actual initialized runtime exports required');
    }

    const key = 'Java_jdk_internal_misc_Unsafe_getFloatVolatile';
    const prior = installed.get(runtime);

    if (prior) {
        if (runtime[key] !== prior) {
            throw new Error('Installed float accessor was replaced');
        }

        return;
    }

    if (key in runtime) {
        throw new Error('An existing float volatile implementation requires separate review');
    }

    const getter = runtime.Java_jdk_internal_misc_Unsafe_getFloat;

    if (typeof getter !== 'function' || getter.toString() !== expectedFloat) {
        throw new Error('Unqualified real Unsafe float accessor');
    }

    Object.defineProperty(runtime, key, { value: getter, writable: true, enumerable: true, configurable: true });
    installed.set(runtime, getter);
}
