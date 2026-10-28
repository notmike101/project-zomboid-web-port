const expectedFloat = 'function agJ(p,n,l,j,h){var f=null,c=-0.,a=null;if(n!==null){a="d";f=cf(n,a,j,4);return f;}a=Q.a2;c=+Number(j);a=a.a14;return  +a[~~c>>>2];}';
const expectedBoolean = 'function agN(p,n,l,j,h){var f=null,c=-0.,a=null;if(n!==null){a="n";f=cf(n,a,j,1);return f;}a=Q.a2;c=+Number(j);a=a.a10;return (a[~~c]|0);}';
const installed = new WeakMap();

/**
 * Publishes the absent float/boolean volatile getters using pinned real runtime accessors.
 *
 * @param {object} runtime - Actual initialized cj3Module export object.
 * @returns {void} No field or native memory is changed.
 */
export function installUnsafeFloatVolatile(runtime) {
    if (!runtime || typeof runtime !== 'object') {
        throw new TypeError('Actual initialized runtime exports required');
    }

    const key = 'Java_jdk_internal_misc_Unsafe_getFloatVolatile';
    const booleanKey = 'Java_jdk_internal_misc_Unsafe_getBooleanVolatile';
    const prior = installed.get(runtime);

    if (prior) {
        if (runtime[key] !== prior.getter || runtime[booleanKey] !== prior.booleanGetter) {
            throw new Error('Installed volatile accessor was replaced');
        }

        return;
    }

    if (key in runtime || booleanKey in runtime) {
        throw new Error('An existing volatile implementation requires separate review');
    }

    const getter = runtime.Java_jdk_internal_misc_Unsafe_getFloat;
    const booleanGetter = runtime.Java_jdk_internal_misc_Unsafe_getBoolean;

    if (typeof getter !== 'function' || getter.toString() !== expectedFloat) {
        throw new Error('Unqualified real Unsafe float accessor');
    }

    if (typeof booleanGetter !== 'function' || booleanGetter.toString() !== expectedBoolean) {
        throw new Error('Unqualified real Unsafe boolean accessor');
    }

    Object.defineProperty(runtime, key, { value: getter, writable: true, enumerable: true, configurable: true });
    Object.defineProperty(runtime, booleanKey, { value: booleanGetter, writable: true, enumerable: true, configurable: true });
    installed.set(runtime, { getter, booleanGetter });
}
