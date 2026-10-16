/* Qualified against https://cjrtnc.leaningtech.com/4.3/cj3.js (666055 bytes),
   SHA-256 5bcf00711009cbb12b858dcbea865cfe0e9d652cfc95f55ad20a600724462644.
   Its b_ helper omits the two-byte store when the Java array is byte-addressed. */
const qualifiedSource = 'function agh(p,n,l,j,h,f){var c=-0.,a=null;if(n!==null){a="n";b_(n,a,j,h,2);}else{a=Q.a2;c=+Number(j);a=a.a11;a[~~c>>>1]=h|0;}}';
const installed = new WeakMap();

/**
 * Repairs the pinned Java17 runtime's aligned byte-array short/char store.
 * ByteBuffer performs its own bounds/read-only checks before this native call.
 * Other receivers retain the real runtime implementation and continuation.
 *
 * @param {object} runtime - Initialized CheerpJ4.3 runtime export map.
 * @returns {object} Live qualification counters for this runtime instance.
 */
export function installUnsafeShortRepair(runtime) {
    if (!runtime || typeof runtime !== 'object') {
        throw new TypeError('The qualified CheerpJ runtime is unavailable');
    }

    const key = 'Java_jdk_internal_misc_Unsafe_putShort';
    const existing = installed.get(runtime);

    if (existing) {
        if (runtime[key] !== existing.store) {
            throw new Error('CheerpJ Unsafe repair was replaced after installation');
        }

        return existing.counters;
    }

    const prior = runtime[key];

    if (typeof prior !== 'function' || prior.toString() !== qualifiedSource) {
        throw new Error('Unqualified CheerpJ4.3 Unsafe.putShort implementation');
    }

    const counters = { repaired: 0, delegated: 0 };

    /**
     * Preserves the six-argument native ABI, including opaque continuation data.
     *
     * @param {...unknown} args - Original runtime arguments.
     * @returns {void} Both original and repaired stores return no value.
     */
    function store(...args) {
        const array = args[1];
        const offset = args[3];
        const value = args[4];

        if (array instanceof Int8Array && array.E === 66 && array.BYTES_PER_ELEMENT === 1
            && typeof offset === 'bigint' && typeof value === 'number') {
            if (offset < 0n || offset > BigInt(Number.MAX_SAFE_INTEGER)) {
                throw new RangeError('Unsafe short offset outside qualified range');
            }

            const index = Number(offset);

            if (index + 2 > array.byteLength) {
                throw new RangeError('Unsafe short beyond byte array');
            }

            /* Java has already applied ByteOrder swapping. The runtime's native
               Uint16Array direct-memory branch establishes little-endian order. */
            new DataView(array.buffer, array.byteOffset, array.byteLength).setUint16(index, value & 65_535, true);
            counters.repaired++;

            return;
        }

        counters.delegated++;

        Reflect.apply(prior, this, args);
    }

    runtime[key] = store;
    installed.set(runtime, { counters, store });

    return counters;
}
