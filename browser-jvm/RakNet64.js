// CheerpJ imports descriptors as blob URLs, so the actual engine owner needs an absolute URL.
const { ensureRakNetOwner } = await import(`${globalThis.location.origin}/raknet-runtime.js`);

await ensureRakNetOwner();

// The shipped RakNet DLL has no JNI exports. Its real engine owner is already initialized above.
export default {};
