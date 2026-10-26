const { ensureRakNetOwner } = await import(`${globalThis.location.origin}/raknet-runtime.js`);
const { createZNetNatives } = await import(`${globalThis.location.origin}/znet-natives.js`);
const { createRakVoiceNatives } = await import(`${globalThis.location.origin}/rakvoice-natives.js`);

const engine = await ensureRakNetOwner();

const logger = createZNetNatives();
const voice = createRakVoiceNatives(engine);

export { logger, voice };
export default { ...logger.natives, ...voice.natives };
