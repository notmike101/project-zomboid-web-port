// CheerpJ imports native descriptors through blob URLs; resolve the shared original owner absolutely.
const { clipperNativeExports } = await import(`${globalThis.location.origin}/clipper-native-owner.js`);

export default clipperNativeExports();
