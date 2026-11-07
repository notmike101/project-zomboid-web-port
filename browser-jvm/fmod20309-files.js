/* eslint-disable jsdoc/require-jsdoc -- Internal public-SDK boundary helpers are owned by the FMOD runtime. */
// Owns bounded encoded bank ranges and staged unbanked sounds until SDK release.
export function createFmod20309Files(publicSDK, files) {
    let rangeBytes = 0;
    let rangeReads = 0;
    let maxRangeBytes = 0;
    const bankBackings = new Map();
    let bankSourceBytes = 0;
    const cacheBudget = 8 * 1_024 * 1_024;
    const cache = new Map();
    let cacheBytes = 0;
    let peakCacheBytes = 0;
    let deliveredBytes = 0;
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

    function bankChunk(path, key, start, length) {
        const id = `${key}:${start}`;
        let bytes = cache.get(id);

        if (bytes) {
            cache.delete(id);
        } else {
            bytes = files.readSync(path, start, Math.min(65_536, length - start));

            if (!(bytes instanceof Uint8Array) || bytes.byteLength !== Math.min(65_536, length - start)) {
                throw new Error('Encoded bank range extent mismatch');
            }

            rangeReads++;
            rangeBytes += bytes.byteLength;
            maxRangeBytes = Math.max(maxRangeBytes, bytes.byteLength);

            while (cacheBytes + bytes.byteLength > cacheBudget) {
                const oldest = cache.keys().next().value;

                cacheBytes -= cache.get(oldest).byteLength;
                cache.delete(oldest);
            }

            cacheBytes += bytes.byteLength;
            peakCacheBytes = Math.max(peakCacheBytes, cacheBytes);
        }

        cache.set(id, bytes);

        return bytes;
    }

    function mountBank(path, name, length) {
        const node = publicSDK.FS_createDevice('/', name, () => null, null);
        const getattr = node.node_ops.getattr;

        // The SDK exports device creation; its returned node supplies seekable range reads.
        node.node_ops = {
            ...node.node_ops,
            getattr(file) {
                return { ...getattr(file), size: length, blocks: Math.ceil(length / 4_096) };
            },
        };
        node.stream_ops = {
            llseek(stream, offset, whence) {
                let position = offset;

                if (whence === 1) {
                    position += stream.position;
                }

                if (whence === 2) {
                    position += length;
                }

                if (!Number.isSafeInteger(position) || position < 0 || ![0, 1, 2].includes(whence)) {
                    throw new Error('Invalid encoded bank seek');
                }

                return position;
            },
            read(_stream, buffer, offset, count, position) {
                const available = Math.max(0, Math.min(count, length - position));

                for (let done = 0; done < available;) {
                    const start = Math.floor((position + done) / 65_536) * 65_536;
                    const bytes = bankChunk(path, name, start, length);
                    const within = position + done - start;
                    const copied = Math.min(available - done, bytes.byteLength - within);

                    buffer.set(bytes.subarray(within, within + copied), offset + done);
                    done += copied;
                }

                deliveredBytes += available;

                return available;
            },
        };
    }

    // Bank nodes retain metadata only; the shared range cache owns encoded bytes.
    function stageBank(path) {
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
            || bankSourceBytes + length > bankBudget) {
            throw new Error('Bank staging exceeds the verified bank namespace byte budget');
        }

        const name = `fmod-bank-owned-${nextBank++}.bank`;

        mountBank(path, name, length);
        const backing = { path: `/${name}`, bytes: length, loaded: false };

        bankBackings.set(key, backing);
        bankSourceBytes += length;

        return {
            path: backing.path,
            commit() {
                backing.loaded = true;
            },
            rollback() {
                if (!backing.loaded && bankBackings.get(key) === backing) {
                    publicSDK.FS_unlink(backing.path);
                    bankBackings.delete(key);
                    bankSourceBytes -= backing.bytes;
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
                bankSourceBytes -= backing.bytes;
            }

            cache.clear();
            cacheBytes = 0;

            for (const [path, bytes] of staged) {
                publicSDK.FS_unlink(path);
                stagedBytes -= bytes;
                staged.delete(path);
            }
        },
        snapshot: () => ({ rangeBytes, rangeReads, maxRangeBytes, openFiles: 0, deliveredBytes, cacheBytes, peakCacheBytes, cacheBudget, stagedBytes, peakStagedBytes, stagedFiles: staged.size, stagingBudget, bankBytes: 0, pendingBankBytes: 0, peakBankBytes: 0, bankSourceBytes, bankBudget, bankBackings: bankBackings.size }),
    };
}
