// Official combined FMOD Studio binary includes both original Core and Studio libraries.
const { getFmodOwner } = await import(`${location.origin}/fmod-runtime.js`);
const audio = await getFmodOwner();

// The original Core/Studio DLLs export no Java JNI functions; integration owns them.
if (!audio.natives) {
    throw new Error('Actual FMOD engine owner required');
}

export default {};
