const { ensureRakNetOwner } = await import(`${globalThis.location.origin}/raknet-runtime.js`);
const { createZNetNatives } = await import(`${globalThis.location.origin}/znet-natives.js`);

await ensureRakNetOwner();

const logger = createZNetNatives();

export { logger };
export default logger.natives;
