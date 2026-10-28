/* eslint-disable jsdoc/require-jsdoc -- Internal public-SDK boundary helpers are owned by the FMOD runtime. */
// Owns adopted encoded VFS buffers; bank backings live until successful SDK system release.
export function createFmod20309Files(publicSDK, files) {
    let rangeBytes = 0;
    let rangeReads = 0;
    let maxRangeBytes = 0;
    const bankBackings = new Map();
    let bankBytes = 0;
    let pendingBankBytes = 0;
    let peakBankBytes = 0;
    let nextBank = 1;
    const bankBudget = files.bankBudget;
    const keyFor = (path) => files.canonicalPath
        ? files.canonicalPath(path).toLowerCase()
        : new URL(String(path).replace(/^\/app(?=\/media\/)/u, ''), 'https://fmod-owned.invalid/').pathname.toLowerCase();

    function readSource(path, length) {
        const data = new Uint8Array(length);

        for (let start = 0; start < length; start += 65_536) {
            const count = Math.min(65_536, length - start);
            const bytes = files.readSync(path, start, count);

            if (!(bytes instanceof Uint8Array) || bytes.byteLength !== count) {
                throw new Error('Encoded audio source range extent mismatch');
            }

            data.set(bytes, start);
            rangeReads++;
            rangeBytes += count;
            maxRangeBytes = Math.max(maxRangeBytes, count);
        }

        return data;
    }

    async function readBankSource(path, length) {
        const data = new Uint8Array(length);
        let next = 0;
        let failed = false;
        let failure;
        const worker = async () => {
            try {
                while (next < length && !failed) {
                    const start = next;
                    const count = Math.min(65_536, length - start);

                    next += count;
                    // eslint-disable-next-line no-await-in-loop -- Four workers bound the pending source reads.
                    const bytes = files.read ? await files.read(path, start, count) : files.readSync(path, start, count);

                    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== count) {
                        throw new Error('Encoded bank range extent mismatch');
                    }

                    data.set(bytes, start);
                    rangeReads++;
                    rangeBytes += count;
                    maxRangeBytes = Math.max(maxRangeBytes, count);
                }
            } catch (error) {
                if (!failed) {
                    failure = error;
                }

                failed = true;
            }
        };

        await Promise.allSettled(Array.from({ length: 4 }, worker));

        if (failed) {
            throw failure;
        }

        return data;
    }

    // The JNI owner serializes bank staging; no SDK call is active while source reads await.
    async function stageBank(path) {
        const key = keyFor(path);
        const existing = bankBackings.get(key);

        if (existing) {
            return { path: existing.path };
        }

        const length = files.sizeSync(path);

        // Actual missing VFS path is still passed to the SDK so its real error is preserved.
        if (length === null) {
            return { path: String(path) };
        }

        if (!Number.isSafeInteger(bankBudget) || bankBudget < 0 || !Number.isSafeInteger(length) || length <= 0
            || bankBytes + pendingBankBytes + length > bankBudget) {
            throw new Error('Bank staging exceeds the verified bank namespace byte budget');
        }

        const name = `fmod-bank-owned-${nextBank++}.bank`;

        pendingBankBytes += length;
        peakBankBytes = Math.max(peakBankBytes, bankBytes + pendingBankBytes);

        let data;

        try {
            data = await readBankSource(path, length);
        } finally {
            pendingBankBytes -= length;
        }

        publicSDK.FS_createDataFile('/', name, data, true, false, true);
        const backing = { path: `/${name}`, bytes: length, loaded: false };

        bankBackings.set(key, backing);
        bankBytes += length;
        peakBankBytes = Math.max(peakBankBytes, bankBytes);

        return {
            path: backing.path,
            commit() {
                backing.loaded = true;
            },
            rollback() {
                if (!backing.loaded && bankBackings.get(key) === backing) {
                    publicSDK.FS_unlink(backing.path);
                    bankBackings.delete(key);
                    bankBytes -= backing.bytes;
                }
            },
        };
    }

    // Largest supplied unbanked sound is 45,508,652 bytes; stage one file at a time, never the catalog.
    const stagingBudget = 64 * 1_024 * 1_024;
    const staged = new Map();
    let stagedBytes = 0;
    let peakStagedBytes = 0;
    let nextStaged = 1;

    function stageSound(path) {
        const length = files.sizeSync(path);

        if (!Number.isSafeInteger(length) || length <= 0) {
            throw new Error('Missing or invalid certified unbanked sound');
        }

        if (length > stagingBudget || stagedBytes + length > stagingBudget) {
            throw new Error('FMOD active unbanked staging exceeds 64MiB budget');
        }

        const extension = /\.(ogg|wav|mp3|flac)$/iu.exec(String(path))?.[1];

        if (!extension) {
            throw new Error('Unbanked sound format is outside the certified audio namespace');
        }

        const name = `fmod-owned-${nextStaged++}.${extension}`;
        const data = readSource(path, length);

        publicSDK.FS_createDataFile('/', name, data, true, false, true);
        const virtualPath = `/${name}`;

        staged.set(virtualPath, length);
        stagedBytes += length;
        peakStagedBytes = Math.max(peakStagedBytes, stagedBytes);

        return {
            path: virtualPath,
            release() {
                if (!staged.has(virtualPath)) {
                    return;
                }

                publicSDK.FS_unlink(virtualPath);
                stagedBytes -= staged.get(virtualPath);
                staged.delete(virtualPath);
            },
        };
    }

    return {
        stageBank,
        stageSound,
        dispose() {
            for (const [key, backing] of bankBackings) {
                publicSDK.FS_unlink(backing.path);
                bankBackings.delete(key);
                bankBytes -= backing.bytes;
            }

            for (const [path, bytes] of staged) {
                publicSDK.FS_unlink(path);
                stagedBytes -= bytes;
                staged.delete(path);
            }
        },
        snapshot: () => ({ rangeBytes, rangeReads, maxRangeBytes, openFiles: 0, deliveredBytes: 0, cacheBytes: 0, peakCacheBytes: 0, stagedBytes, peakStagedBytes, stagedFiles: staged.size, stagingBudget, bankBytes, pendingBankBytes, peakBankBytes, bankBudget, bankBackings: bankBackings.size }),
    };
}
