// CheerpJ imports native modules as blob URLs; dependencies need absolute URLs.
const { createPopulationNatives } = await import(`${globalThis.location.origin}/population-natives.js`);
const population = createPopulationNatives();

export { population };
export default population.natives;
