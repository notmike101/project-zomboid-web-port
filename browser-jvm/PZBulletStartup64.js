// CheerpJ imports native descriptors through blob URLs; resolve the already-created owner absolutely.
const { bulletStartupNatives } = await import(`${globalThis.location.origin}/bullet-startup.js`);

export default bulletStartupNatives();
