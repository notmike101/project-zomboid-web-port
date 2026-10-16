// CheerpJ imports native modules as blob URLs, so dependencies need an absolute URL.
const { createLightingNatives } = await import(`${globalThis.location.origin}/lighting-natives.js`);
const lighting = createLightingNatives();

export default lighting.natives;
