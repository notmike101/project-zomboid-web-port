// CheerpJ imports native modules as blob URLs; dependencies require absolute URLs.
const { createVehicleWorldNatives } = await import(`${globalThis.location.origin}/bullet-vehicle-natives.js`);
const { default: createEngine } = await import(`${globalThis.location.origin}/bullet-engine.mjs`);
const response = await fetch(`${globalThis.location.origin}/bullet-engine.wasm`);

if (!response.ok) {
    throw new Error('Prepared real Bullet engine is unavailable');
}

const engine = await createEngine({ wasmBinary: new Uint8Array(await response.arrayBuffer()) });
const bullet = createVehicleWorldNatives(engine);

export { bullet };
export default bullet.natives;
