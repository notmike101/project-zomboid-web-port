// Official combined FMOD Studio binary includes both original Core and Studio libraries.
const { getFmodOwner } = await import(`${location.origin}/fmod-runtime.js`);
const audio = await getFmodOwner();

export default audio.natives;
