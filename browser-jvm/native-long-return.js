/* CheerpJ4.3 cj3.js SHA-256 provenance:
   5bcf00711009cbb12b858dcbea865cfe0e9d652cfc95f55ad20a600724462644.
   This adapter checks the exported restart function and continuation state.
   The standalone verifier also hashes the actual loaded runtime resource. */
const restartSource = 'function(a0,a1,a2){return am0(a0.this,a1,a2);}';
const installed = new WeakMap();

/**
 * Preserves exact native jlong results at the pinned runtime continuation seam.
 * Scalar JS-to-Java method argument conversion retains its existing behavior.
 *
 * @param {object} library - Actual CJ3Library supplied to a native callback.
 * @returns {object} Live counters belonging to this runtime constructor.
 */
export function installNativeLongReturnRepair(library) {
    const constructor = Object.getPrototypeOf(library)?.constructor;

    if (!constructor || typeof constructor.restart !== 'function') {
        throw new TypeError('The qualified CJ3Library.restart hook is unavailable');
    }

    const existing = installed.get(constructor);

    if (existing) {
        if (constructor.restart !== existing.wrapper) {
            throw new Error('The native long return repair was replaced');
        }

        return existing.counters;
    }

    const prior = constructor.restart;

    if (prior.toString() !== restartSource) {
        throw new Error('Unqualified CheerpJ4.3 native continuation implementation');
    }

    const counters = { repaired: 0, delegated: 0, wrapped: 0 };

    /**
     * Delegates normal conversion, then supplies the exact signed native word.
     *
     * @param {object} lib - Original callback library.
     * @param {number} method - Original runtime method descriptor pointer.
     * @param {unknown} value - Original native callback result.
     * @returns {unknown} The unchanged result or exact declared-jlong word.
     */
    function wrapper(lib, method, value) {
        const result = Reflect.apply(prior, this, [lib, method, value]);

        // A BigInt conversion result identifies an actual declared J return.
        if (typeof value === 'bigint' && typeof result === 'bigint') {
            const context = Object.getOwnPropertyDescriptor(lib, 'this')?.value;
            const thread = context?.a0;

            if (!thread || thread.a8 !== result || typeof thread.i20 !== 'number') {
                throw new Error('Unqualified CheerpJ native continuation state');
            }

            /* JNI jlong is a signed 64-bit word. Preserve its low 64 bits rather
               than routing the value through an imprecise JavaScript Number. */
            const word = BigInt.asIntN(64, value);

            thread.a8 = word;
            counters.repaired++;

            if (word !== value) {
                counters.wrapped++;
            }

            return word;
        }

        counters.delegated++;

        return result;
    }

    constructor.restart = wrapper;
    installed.set(constructor, { wrapper, counters });

    return counters;
}
