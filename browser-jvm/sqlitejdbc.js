const origin = globalThis.location.origin;
const { requireSqliteNamespace } = await import(
    `${origin}/sqlite-namespace.js`
);

requireSqliteNamespace();
const { default: initialize } = await import(`${origin}/sqlite3.mjs`);
const { createNativeDb } = await import(`${origin}/sqlite-natives.js`);
const sqlite = await initialize({
    print: console.info,
    printErr: console.error,
});
const backend = createNativeDb(sqlite);

export const snapshot = backend.snapshot;
export default backend.natives;
