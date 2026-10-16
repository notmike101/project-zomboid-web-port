/**
 * Reserves SQLite's Java filesystem namespace before a browser VM can cache it.
 * The lock intentionally lasts until this browsing context is destroyed.
 * Concurrent browser VMs are unsupported, even when they open different files.
 */
let reservation;
let held = false;
const name = 'pz-browser-sqlite-owned-files-v1';

/**
 * Takes the exclusive namespace lease before Java filesystem initialization.
 *
 * @returns {Promise<object>} Held lease information.
 */
export function reserveSqliteNamespace() {
    if (reservation) {
        return reservation;
    }

    if (globalThis.cj3Module) {
        throw new Error('Reserve SQLite before initializing the Java VM');
    }

    if (!globalThis.navigator?.locks?.request) {
        throw new Error('SQLite requires the Web Locks API');
    }

    reservation = new Promise((resolve, reject) => {
        navigator.locks
            .request(name, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
                if (!lock) {
                    reject(
                        new Error(
                            'SQLite filesystem namespace is already owned by another browser VM',
                        ),
                    );

                    return;
                }

                held = true;
                resolve(Object.freeze({ name, lifetime: 'browsing-context' }));
                await new Promise(() => {
                    // The browsing context owns this lock until destruction.
                });
            })
            .catch(reject);
    });

    return reservation;
}

/** Requires an actual held namespace lease. */
export function requireSqliteNamespace() {
    if (!held) {
        throw new Error('SQLite requires a pre-VM exclusive namespace reservation');
    }
}
