import { installNativeLongReturnRepair } from './native-long-return.js';

/**
 * Adds SQLite's rollback-journal lock protocol to the pinned unix-none memory VFS.
 * File bytes, journals, sync and close still use the supplied engine's native I/O.
 * The outer browser namespace lease excludes other VMs; this registry covers its connections.
 *
 * @param {object} sqlite - Pinned initialized SQLite WASM API.
 * @returns {string} Named VFS selected only for this host's owned connections.
 */
function installOwnedSqliteVfs(sqlite) {
    const { capi: c, wasm: w, __pzOwnedVfs: existing } = sqlite;

    if (existing) {
        if (existing.vfs.pointer !== c.sqlite3_vfs_find('pz-owned-locks')) {
            throw new Error('Owned SQLite VFS registration was replaced');
        }

        return 'pz-owned-locks';
    }

    const base = new c.sqlite3_vfs(c.sqlite3_vfs_find(null));

    if (w.cstrToJs(base.$zName) !== 'unix-none') {
        throw new Error('Owned SQLite locking requires the pinned unix-none VFS');
    }

    const vfs = new c.sqlite3_vfs();

    w.heap8u().set(w.heap8u().subarray(base.pointer, base.pointer + c.sqlite3_vfs.structInfo.sizeof), vfs.pointer);
    vfs.$zName = w.allocCString('pz-owned-locks');
    const originalOpen = w.functionEntry(base.$xOpen);
    const files = new Map();
    const tables = new Map();
    /**
     * Finds other actual open handles for this canonical POSIX filename.
     *
     * @param {object} file - Lock owner.
     * @param {number} pointer - Current sqlite3_file pointer.
     * @returns {Array} Other file owners.
     */
    const peers = (file, pointer) => [...files.entries()].filter(([key, value]) => key !== pointer && value.name === file.name);

    vfs.installMethods({
        /**
         * Delegates native open and installs only this file's lock methods.
         *
         * @param {number} _vfs - Registered VFS pointer.
         * @param {number} name - Native canonical filename.
         * @param {number} pointer - Native sqlite3_file.
         * @param {number} flags - Original open flags.
         * @param {number} outputFlags - Original output flags pointer.
         * @returns {number} SQLite result.
         */
        xOpen(_vfs, name, pointer, flags, outputFlags) {
            const rc = originalOpen(base.pointer, name, pointer, flags, outputFlags);

            if (rc !== c.SQLITE_OK) {
                return rc;
            }

            const file = new c.sqlite3_file(pointer);
            const originalPointer = file.$pMethods;
            let table = tables.get(originalPointer);

            if (!table) {
                const original = new c.sqlite3_io_methods(originalPointer);
                const close = w.functionEntry(original.$xClose);

                table = new c.sqlite3_io_methods();
                w.heap8u().set(w.heap8u().subarray(originalPointer, originalPointer + c.sqlite3_io_methods.structInfo.sizeof), table.pointer);
                table.installMethods({
                    /**
                     * Upgrades this owner's lock, retaining PENDING on a busy exclusive upgrade.
                     *
                     * @param {number} pFile - Native file.
                     * @param {number} requested - SQLite lock level.
                     * @returns {number} SQLite result.
                     */
                    xLock(pFile, requested) {
                        const owned = files.get(pFile);

                        if (!owned || requested < c.SQLITE_LOCK_SHARED || requested > c.SQLITE_LOCK_EXCLUSIVE) {
                            return c.SQLITE_IOERR_LOCK;
                        }

                        if (requested <= owned.lock) {
                            return c.SQLITE_OK;
                        }

                        const others = peers(owned, pFile);

                        if (requested === c.SQLITE_LOCK_SHARED) {
                            if (others.some(([, other]) => other.lock >= c.SQLITE_LOCK_PENDING)) {
                                return c.SQLITE_BUSY;
                            }
                        } else {
                            if (others.some(([, other]) => other.lock >= c.SQLITE_LOCK_RESERVED)) {
                                return c.SQLITE_BUSY;
                            }

                            if (requested === c.SQLITE_LOCK_EXCLUSIVE) {
                                owned.lock = c.SQLITE_LOCK_PENDING;

                                if (others.some(([, other]) => other.lock >= c.SQLITE_LOCK_SHARED)) {
                                    return c.SQLITE_BUSY;
                                }
                            }
                        }

                        owned.lock = requested;

                        return c.SQLITE_OK;
                    },
                    /**
                     * Downgrades only this file owner.
                     *
                     * @param {number} pFile - Native file.
                     * @param {number} requested - NONE or SHARED.
                     * @returns {number} SQLite result.
                     */
                    xUnlock(pFile, requested) {
                        const owned = files.get(pFile);

                        if (!owned || ![c.SQLITE_LOCK_NONE, c.SQLITE_LOCK_SHARED].includes(requested)) {
                            return c.SQLITE_IOERR_UNLOCK;
                        }

                        if (requested >= owned.lock) {
                            return c.SQLITE_OK;
                        }

                        owned.lock = requested;

                        return c.SQLITE_OK;
                    },
                    /**
                     * Reports an actual reserved or stronger lock from any owner.
                     *
                     * @param {number} pFile - Native file.
                     * @param {number} output - Native boolean output.
                     * @returns {number} SQLite result.
                     */
                    xCheckReservedLock(pFile, output) {
                        const owned = files.get(pFile);

                        if (!owned) {
                            return c.SQLITE_IOERR_CHECKRESERVEDLOCK;
                        }

                        w.poke32(output, [...files.values()].some((other) => other.name === owned.name && other.lock >= c.SQLITE_LOCK_RESERVED) ? 1 : 0);

                        return c.SQLITE_OK;
                    },
                    /**
                     * Delegates native close and releases only its lock owner.
                     *
                     * @param {number} pFile - Native file.
                     * @returns {number} SQLite result.
                     */
                    xClose(pFile) {
                        try {
                            return close(pFile);
                        } finally {
                            files.delete(pFile);
                        }
                    },
                });
                tables.set(originalPointer, table);
            }

            // Null-named temporary files cannot alias another SQLite file.
            files.set(pointer, { name: name ? w.cstrToJs(name) : `temporary:${pointer}`, lock: c.SQLITE_LOCK_NONE });
            file.$pMethods = table.pointer;

            return c.SQLITE_OK;
        },
    });
    vfs.registerVfs(false);
    // Keep registered native structs and installed function-table entries alive for this VM.
    sqlite.__pzOwnedVfs = { vfs, base, tables, files };

    return 'pz-owned-locks';
}

/**
 * Preserves a Java throwable while JavaScript performs engine cleanup.
 */
class JavaFailure {
    /**
     * Carries an actual Java exception through engine cleanup.
     *
     * @param {object} exception - Actual Java throwable proxy.
     */
    constructor(exception) {
        this.exception = exception;
    }
}
/**
 * Encodes bulk binary transport without scalar Java byte calls.
 *
 * @param {Uint8Array} b - Raw bytes.
 * @returns {string} Operation result.
 */
const hex = (b) =>
    Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
/**
 * Decodes bulk binary transport preserving null and empty arrays.
 *
 * @param {string|null} s - Hexadecimal bytes or null.
 * @returns {Uint8Array|null} Operation result.
 */
const unhex = (s) =>
    s === null
        ? null
        : Uint8Array.from(String(s).match(/../g) || [], (x) =>
                Number.parseInt(x, 16),
            );
/**
 * Resolves the Java transport helper in the current callback library.
 *
 * @param {object} lib - Current CheerpJ native callback library.
 * @returns {Promise<object>} Operation result.
 */
const helpers = async (lib) => ({
    support: await lib.port.host.SqliteSupport,
});

/**
 * Unwraps filesystem status without losing the original Java cause.
 *
 * @param {object} lib - Current CheerpJ native callback library.
 * @param {string} method - Java file helper method.
 * @param {...unknown} args - Native or Java helper arguments.
 * @returns {Promise<string>} Operation result.
 */
async function fileCall(lib, method, ...args) {
    const support = (await helpers(lib)).support;
    const status = String(await support[method](...args));

    if (status.startsWith('error:')) {
        throw new JavaFailure(await support.takeFailure(status.slice(6)));
    }

    if (!status.startsWith('ok:')) {
        throw new Error('Invalid Java file-operation result');
    }

    return status.slice(3);
}

/**
 * Looks up an existing receiver identity without allocating a new owner.
 *
 * @param {object} lib - Current CheerpJ native callback library.
 * @param {object} receiver - Original NativeDB receiver.
 * @returns {Promise<string>} Operation result.
 */
const id = async (lib, receiver) =>
    String(await (await helpers(lib)).support.identity(receiver));
let activeBackend;

/**
 * Reports resource ownership for qualification and shutdown diagnostics.
 *
 * @returns {object|null} Detached counters and resource counts, or null before initialization.
 */
export function getSqliteSnapshot() {
    return activeBackend?.snapshot() ?? null;
}

/**
 * Adapts the qualified Xerial operations to the real pinned SQLite engine.
 * Java paths are trusted owned-cache inputs; this is not an arbitrary JDBC URL sandbox.
 * All operations serialize through one queue; Java helpers cannot reenter SQL.
 *
 * @param {object} sqlite3 - Initialized pinned SQLite WASM API.
 * @returns {object} Operation result.
 */
export function createNativeDb(sqlite3) {
    if (activeBackend) {
        throw new Error('SQLite backend is already initialized');
    }

    if (sqlite3.capi.sqlite3_libversion() !== '3.48.0') {
        throw new Error('SQLite 3.48.0 is required');
    }

    const { capi: c, wasm: w } = sqlite3;
    const ownedVfs = installOwnedSqliteVfs(sqlite3);
    const databases = new Map();
    const images = new Map();
    const statements = new Map();
    const workingFiles = new Set();

    // Pinned 3.48 engine exports also used by its official worker close/unlink.
    for (const name of ['sqlite3__wasm_vfs_unlink', 'sqlite3__wasm_db_vfs']) {
        if (typeof w.exports[name] !== 'function') {
            throw new TypeError(`Missing real SQLite export: ${name}`);
        }
    }

    const unlink = w.xWrap('sqlite3__wasm_vfs_unlink', 'int', ['*', 'string']);
    const dbVfs = w.xWrap('sqlite3__wasm_db_vfs', '*', ['*', 'string']);

    /**
     * Deletes only the engine-owned POSIX image and its rollback journal after close.
     *
     * @param {object} state - Closed connection state.
     */
    function discardWorkingFile(state) {
        state.image.connections.delete(state);

        if (state.image.connections.size) {
            return;
        }

        for (const suffix of ['', '-journal']) {
            const result = unlink(state.vfs, state.posix + suffix);

            if (result !== c.SQLITE_OK && result !== c.SQLITE_IOERR_DELETE_NOENT) {
                throw new Error(`SQLite working-file cleanup failed: ${result}`);
            }
        }

        workingFiles.delete(state.posix);
        images.delete(String(state.lease));
    }

    const calls = {};
    let serial = 0;
    let pending = Promise.resolve();

    /**
     * Requires an open owned connection and rejects poisoned query operations.
     *
     * @param {object} lib - Current CheerpJ native callback library.
     * @param {object} receiver - Original NativeDB receiver.
     * @param {boolean} allowPoison - Allow cleanup after publication failure.
     * @returns {Promise<object>} Operation result.
     */
    const db = async (lib, receiver, allowPoison = false) => {
        const value = databases.get(await id(lib, receiver));

        if (!value) {
            throw new Error('The database has been closed');
        }

        if ((value.poison || value.image.poison) && !allowPoison) {
            throw new Error('SQLite connection poisoned by publication failure');
        }

        return value;
    };

    /**
     * Checks exact statement ownership and finalization state.
     *
     * @param {object} state - Owned connection state.
     * @param {bigint|number} handle - Actual WASM statement pointer.
     * @returns {object} Operation result.
     */
    const stmt = (state, handle) => {
        const p = Number(handle);
        const value = statements.get(p);

        if (!Number.isSafeInteger(p) || !value || value.db !== state) {
            throw new Error('Unknown, finalized or cross-database statement');
        }

        return value;
    };

    /**
     * Creates the original driver SQLException from the engine diagnostic.
     *
     * @param {object} lib - Current CheerpJ native callback library.
     * @param {object} state - Owned connection state.
     * @param {number} code - SQLite result code.
     */
    const engineError = async (lib, state, code) => {
        throw new JavaFailure(
            await (
                await lib.org.sqlite.core.DB
            ).newSQLException(code, c.sqlite3_errmsg(state.ptr)),
        );
    };

    /**
     * Executes the current native callback.
     *
     * @param {object} lib - Current CheerpJ native callback library.
     * @param {object} state - Owned connection state.
     * @returns {object|Promise<unknown>|string|Uint8Array|null} Operation result.
     */
    async function publish(lib, state) {
        if (
            state.poison || state.image.poison
            || [...state.image.connections].some((connection) => !c.sqlite3_get_autocommit(connection.ptr))
            || [...statements.values()].some(
                (s) => s.db.image === state.image && s.write && s.active,
            )
        ) {
            return;
        }

        try {
            const image = c.sqlite3_js_db_export(state.ptr);

            await fileCall(lib, 'publishHexLease', String(state.lease), hex(image));
            state.publishes++;
        } catch (error) {
            state.poison = true;
            state.image.poison = true;
            throw error;
        }
    }

    /**
     * Copies exact UTF-8 column bytes including embedded NUL.
     *
     * @param {number} p - Actual statement pointer.
     * @param {number} index - Column index.
     * @returns {Uint8Array|null} Operation result.
     */
    const rawText = (p, index) => {
        const ptr = w.exports.sqlite3_column_text(p, index);

        if (!ptr) {
            return null;
        }

        const size = c.sqlite3_column_bytes(p, index);

        return w.heap8u().slice(ptr, ptr + size);
    };

    const functions = {};
    /**
     * Registers one serialized native callback with genuine Java failures.
     *
     * @param {string} name - Original native method name.
     * @param {(...args: unknown[]) => Promise<unknown>} fn - Qualified implementation.
     */
    const add = (name, fn) => {
    /**
     * Registers one serialized native callback with genuine Java failures.
     *
     * @param {object} lib - Current CheerpJ native callback library.
     * @param {object} receiver - Original NativeDB receiver.
     * @param {...unknown} args - Native or Java helper arguments.
     * @returns {Promise<unknown>} Native result after serialized execution.
     */
        functions[`Java_org_sqlite_core_NativeDB_${name.replaceAll('_', '_1')}`] = (
            lib,
            receiver,
            ...args
        ) => {
            /**
             * Executes one native operation without interleaving WASM stack allocations.
             *
             * @returns {Promise<unknown>} Operation result.
             */
            const operation = async () => {
                calls[name] = (calls[name] || 0) + 1;

                try {
                    installNativeLongReturnRepair(lib);

                    return await fn(lib, receiver, ...args);
                } catch (error) {
                    if (error instanceof JavaFailure) {
                        throw error.exception;
                    }

                    if (!(error instanceof Error)) {
                        throw error;
                    }

                    const E = await lib.java.sql.SQLException;

                    throw await new E(String(error.message || error));
                }
            };

            const result = pending.then(operation);

            pending = result.catch(() => undefined);

            return result;
        };
    };

    add('_open_utf8', async (lib, receiver, bytes, flags) => {
        /* Original SQLiteConfig(): READWRITE | CREATE | OPEN_URI = 70.
           OPEN_URI is admitted only with an ordinary owned filesystem path. */
        if (flags !== 70) {
            throw new JavaFailure(await new (await lib.java.lang.UnsupportedOperationException)(
                `SQLite open flags are not qualified: ${flags}`,
            ));
        }

        const { support } = await helpers(lib);
        const filename = new TextDecoder().decode(unhex(await support.hex(bytes)));

        if (filename.startsWith('file:') || filename.includes('\0') || filename === ':memory:') {
            throw new JavaFailure(await new (await lib.java.lang.UnsupportedOperationException)(
                'SQLite URI and memory paths are not qualified',
            ));
        }

        const key = String(
            await (await helpers(lib)).support.openIdentity(receiver),
        );

        if (databases.has(key)) {
            throw new Error('DB already open');
        }

        let lease;
        let ptr = 0;
        let working;

        try {
            lease = await fileCall(lib, 'acquireLease', filename);
            const encoded = await fileCall(lib, 'readHexLease', String(lease));
            const image = unhex(encoded === 'missing' ? null : encoded);

            if (image && image.length >= 100
                && new TextDecoder().decode(image.subarray(0, 16)) === 'SQLite format 3\0'
                && (image[18] === 2 || image[19] === 2)) {
                throw new JavaFailure(await new (await lib.java.lang.UnsupportedOperationException)(
                    'SQLite WAL-format images require checkpointing before import',
                ));
            }

            let shared = images.get(String(lease));
            const posix = shared?.posix ?? `/owned-${++serial}.db`;

            const created = !shared;

            if (!shared) {
                shared = { posix, connections: new Set(), poison: false };
                images.set(String(lease), shared);
            }

            working = { ptr: 0, lease, key, posix, image: shared, vfs: c.sqlite3_vfs_find(ownedVfs), poison: false, publishes: 0 };
            workingFiles.add(posix);

            if (created && image) {
                c.sqlite3_js_posix_create_file(posix, image);
            }

            w.scopedAllocPush();

            try {
                const out = w.scopedAllocPtr();
                const rc = c.sqlite3_open_v2(posix, out, flags, ownedVfs);

                ptr = w.peekPtr(out);
                const state = working;

                state.ptr = ptr;
                state.vfs = ptr ? dbVfs(ptr, 0) : state.vfs;

                if (rc) {
                    await engineError(lib, state, c.sqlite3_extended_errcode(ptr));
                }

                c.sqlite3_extended_result_codes(ptr, 1);
                const auth = c.sqlite3_set_authorizer(
                    ptr,
                    (_ctx, op, a, b) => {
                        if (op === c.SQLITE_ATTACH || op === c.SQLITE_DETACH) {
                            return c.SQLITE_DENY;
                        }

                        if (
                            op === c.SQLITE_FUNCTION
                            && String(b).toLowerCase() === 'load_extension'
                        ) {
                            return c.SQLITE_DENY;
                        }

                        if (op === c.SQLITE_PRAGMA) {
                            const name = String(a).toLowerCase();
                            const value = b ? String(b).toLowerCase() : null;

                            if (
                                ['temp_store_directory', 'data_store_directory'].includes(name)
                            ) {
                                return c.SQLITE_DENY;
                            }

                            if (
                                value
                                && ((name === 'journal_mode' && value !== 'truncate')
                                    || ['locking_mode', 'writable_schema'].includes(name))
                            ) {
                                return c.SQLITE_DENY;
                            }
                        }

                        return c.SQLITE_OK;
                    },
                    0,
                );

                if (auth) {
                    await engineError(lib, state, auth);
                }

                databases.set(key, state);
                shared.connections.add(state);
            } finally {
                w.scopedAllocPop();
            }
        } catch (error) {
            if (ptr) {
                c.sqlite3_close_v2(ptr);
            }

            if (working) {
                try {
                    discardWorkingFile(working);
                } catch (cleanup) {
                    console.error('SQLITE_WORKING_FILE_FAILURE', String(cleanup));
                }
            }

            await support.forget(receiver);

            try {
                if (lease !== undefined) {
                    await fileCall(lib, 'releaseLease', String(lease));
                }
            } catch (cleanup) {
                console.error('SQLITE_RELEASE_FAILURE', String(cleanup));
            }

            throw error;
        }
    });
    add('_close', async (lib, receiver) => {
        const key = await id(lib, receiver);
        const state = databases.get(key);

        if (!state) {
            return;
        }

        if ([...statements.values()].some((s) => s.db === state)) {
            throw new Error('Close with unfinalized statements is unqualified');
        }

        let failure;

        try {
            /* Closing a JDBC connection rolls back its uncommitted transaction. Do it
               before the final export so other connections' committed data is not lost. */
            if (!c.sqlite3_get_autocommit(state.ptr)) {
                const rollback = c.sqlite3_exec(state.ptr, 'ROLLBACK', 0, 0, 0);

                if (rollback) {
                    await engineError(lib, state, rollback);
                }
            }

            if (!state.poison) {
                await publish(lib, state);
            }
        } catch (error) {
            failure = error;
        }

        const rc = c.sqlite3_close_v2(state.ptr);

        if (rc) {
            throw failure || new Error(`Real SQLite close_v2 failed ${rc}`);
        }

        try {
            discardWorkingFile(state);
        } catch (error) {
            failure ||= error;
        }

        databases.delete(key);
        await (await helpers(lib)).support.forget(receiver);

        try {
            await fileCall(lib, 'releaseLease', String(state.lease));
        } catch (error) {
            failure ||= error;
        }

        if (failure) {
            throw failure;
        }
    });
    add('_exec_utf8', async (lib, r, bytes) => {
        const state = await db(lib, r);
        const sql = new TextDecoder().decode(
            unhex(await (await helpers(lib)).support.hex(bytes)),
        );
        const rc = c.sqlite3_exec(state.ptr, sql, 0, 0, 0);
        const message = rc ? c.sqlite3_errmsg(state.ptr) : null;

        await publish(lib, state);

        if (rc) {
            throw new JavaFailure(
                await (await lib.org.sqlite.core.DB).newSQLException(rc, message),
            );
        }

        return rc;
    });
    add('prepare_utf8', async (lib, r, bytes) => {
        const state = await db(lib, r);
        const sql = unhex(await (await helpers(lib)).support.hex(bytes));

        w.scopedAllocPush();

        try {
            const p = w.scopedAlloc(sql.length + 1);

            w.heap8u().set(sql, p);
            w.heap8u()[p + sql.length] = 0;
            const out = w.scopedAllocPtr();
            const rc = c.sqlite3_prepare_v2(state.ptr, p, sql.length, out, 0);
            const ptr = w.peekPtr(out);

            if (rc) {
                await engineError(lib, state, rc);
            }

            if (!ptr) {
                throw new Error('Empty prepared statement is unqualified');
            }

            statements.set(ptr, {
                ptr,
                db: state,
                write: !c.sqlite3_stmt_readonly(ptr),
                active: false,
            });

            return BigInt(ptr);
        } finally {
            w.scopedAllocPop();
        }
    });
    add('step', async (lib, r, handle) => {
        const state = await db(lib, r);
        const s = stmt(state, handle);

        state.lastError = null;
        const rc = c.sqlite3_step(s.ptr);

        if (rc !== c.SQLITE_ROW && rc !== c.SQLITE_DONE && rc !== c.SQLITE_OK) {
            state.lastError = c.sqlite3_errmsg(state.ptr);
        }

        s.active = rc === c.SQLITE_ROW;

        if (rc !== c.SQLITE_ROW) {
            await publish(lib, state);
        }

        return rc;
    });

    for (const name of ['reset', 'finalize']) {
        add(name, async (lib, r, handle) => {
            const state = await db(lib, r, true);
            const s = stmt(state, handle);
            const rc = c[`sqlite3_${name}`](s.ptr);

            s.active = false;

            if (name === 'finalize') {
                statements.delete(s.ptr);
            }

            await publish(lib, state);

            return rc;
        });
    }

    for (const name of [
        'clear_bindings',
        'bind_parameter_count',
        'column_count',
    ]) {
        add(name, async (lib, r, h) =>
            c[`sqlite3_${name}`](stmt(await db(lib, r), h).ptr),
        );
    }

    for (const name of ['column_type', 'column_int', 'column_double']) {
        add(name, async (lib, r, h, i) =>
            c[`sqlite3_${name}`](stmt(await db(lib, r), h).ptr, i),
        );
    }

    add('column_long', async (lib, r, h, i) =>
        c.sqlite3_column_int64(stmt(await db(lib, r), h).ptr, i),
    );
    add('column_text_utf8', async (lib, r, h, i) => {
        const value = rawText(stmt(await db(lib, r), h).ptr, i);

        return await (
            await helpers(lib)
        ).support.buffer(value === null ? null : hex(value));
    });

    for (const name of ['column_name', 'column_decltype']) {
        add(`${name}_utf8`, async (lib, r, h, i) => {
            const value = c[`sqlite3_${name}`](stmt(await db(lib, r), h).ptr, i);

            return await (
                await helpers(lib)
            ).support.buffer(
                value === null ? null : hex(new TextEncoder().encode(value)),
            );
        });
    }

    add('column_blob', async (lib, r, h, i) => {
        const p = stmt(await db(lib, r), h).ptr;

        if (c.sqlite3_column_type(p, i) === c.SQLITE_NULL) {
            return null;
        }

        const ptr = w.exports.sqlite3_column_blob(p, i);
        const size = c.sqlite3_column_bytes(p, i);

        return await (
            await helpers(lib)
        ).support.bytes(hex(w.heap8u().slice(ptr, ptr + size)));
    });

    for (const name of ['bind_null', 'bind_int', 'bind_double']) {
        add(name, async (lib, r, h, ...args) =>
            c[`sqlite3_${name}`](stmt(await db(lib, r), h).ptr, ...args),
        );
    }

    add('bind_long', async (lib, r, h, i, value) =>
        c.sqlite3_bind_int64(stmt(await db(lib, r), h).ptr, i, BigInt(value)),
    );

    for (const name of ['bind_text_utf8', 'bind_blob']) {
        add(name, async (lib, r, h, i, array) => {
            const p = stmt(await db(lib, r), h).ptr;

            if (array === null) {
                return c.sqlite3_bind_null(p, i);
            }

            const bytes = unhex(await (await helpers(lib)).support.hex(array));
            const mem = w.alloc(Math.max(1, bytes.length));

            try {
                w.heap8u().set(bytes, mem);

                return (
                    name === 'bind_blob'
                        ? w.exports.sqlite3_bind_blob
                        : w.exports.sqlite3_bind_text
                )(p, i, mem, bytes.length, -1);
            } finally {
                w.dealloc(mem);
            }
        });
    }

    for (const name of ['changes', 'total_changes']) {
        add(name, async (lib, r) => c[`sqlite3_${name}64`]((await db(lib, r)).ptr));
    }

    add('limit', async (lib, r, ...args) =>
        c.sqlite3_limit((await db(lib, r)).ptr, ...args),
    );
    add('busy_timeout', async (lib, r, value) => {
        const state = await db(lib, r);
        const rc = c.sqlite3_busy_timeout(state.ptr, value);

        if (rc) {
            await engineError(lib, state, rc);
        }
    });
    add('enable_load_extension', async (lib, r, enabled) => {
        if (enabled) {
            throw new Error('Enabling extensions is unsupported');
        }

        return c.sqlite3_db_config(
            (await db(lib, r)).ptr,
            c.SQLITE_DBCONFIG_ENABLE_LOAD_EXTENSION,
            0,
            0,
        );
    });
    add(
        'errmsg_utf8',
        async (lib, r) =>
            await (
                await helpers(lib)
            ).support.buffer(
                hex(
                    new TextEncoder().encode(
                        await (async () => {
                            const state = await db(lib, r, true);

                            return state.lastError || c.sqlite3_errmsg(state.ptr);
                        })(),
                    ),
                ),
            ),
    );
    add(
        'libversion_utf8',
        async (lib) =>
            await (
                await helpers(lib)
            ).support.buffer(hex(new TextEncoder().encode(c.sqlite3_libversion()))),
    );

    for (const name of [
        '_open_utf8',
        '_close',
        '_exec_utf8',
        'shared_cache',
        'enable_load_extension',
        'interrupt',
        'busy_timeout',
        'busy_handler',
        'prepare_utf8',
        'errmsg_utf8',
        'changes',
        'total_changes',
        'finalize',
        'step',
        'reset',
        'clear_bindings',
        'bind_parameter_count',
        'column_count',
        'column_type',
        'column_decltype_utf8',
        'column_table_name_utf8',
        'column_name_utf8',
        'column_text_utf8',
        'column_blob',
        'column_double',
        'column_long',
        'column_int',
        'bind_null',
        'bind_int',
        'bind_long',
        'bind_double',
        'bind_text_utf8',
        'bind_blob',
        'result_null',
        'result_text_utf8',
        'result_blob',
        'result_double',
        'result_long',
        'result_int',
        'result_error_utf8',
        'value_text_utf8',
        'value_blob',
        'value_double',
        'value_long',
        'value_int',
        'value_type',
        'create_function_utf8',
        'destroy_function_utf8',
        'create_collation_utf8',
        'destroy_collation_utf8',
        'limit',
        'backup',
        'restore',
        'column_metadata',
        'set_commit_listener',
        'set_update_listener',
        'register_progress_handler',
        'clear_progress_handler',
        'serialize',
        'deserialize',
    ]) {
        const key = `Java_org_sqlite_core_NativeDB_${name.replaceAll('_', '_1')}`;

        if (!functions[key]) {
            add(name, async (lib) => {
                throw new JavaFailure(
                    await new (await lib.java.lang.UnsupportedOperationException)(
                        `SQLite JNI operation is not qualified: ${name}`,
                    ),
                );
            });
        }
    }

    activeBackend = {
        natives: functions,
        /**
         * Reports the live connection and statement registry.
         *
         * @returns {object} Operation result.
         */
        snapshot: () => ({
            databases: databases.size,
            statements: statements.size,
            calls: { ...calls },
            nativeEntries: Object.keys(functions).length,
            workingFiles: workingFiles.size,
            sharedImages: images.size,
            states: [...databases.values()].map((s) => ({
                poison: s.poison,
                publishes: s.publishes,
            })),
        }),
    };

    return activeBackend;
}

export { installOwnedSqliteVfs };
