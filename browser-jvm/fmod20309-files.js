/* eslint-disable jsdoc/require-jsdoc -- Internal public-SDK boundary helpers are owned by the FMOD runtime. */
// Public synchronous custom-file callbacks required by the supplied HTML5 2.03 SDK.
export function createFmod20309Files(publicSDK, files, isDisposed, onFailure) {
    let rangeBytes = 0;
    let rangeReads = 0;
    let maxRangeBytes = 0;
    let openFiles = 0;
    let deliveredBytes = 0;
    let cacheBytes = 0;
    let peakCacheBytes = 0;
    const fileOwners = new Set();
    const cache = new Map();
    const callbackOwners = new Map();
    const callbackInfos = [];
    let nextFileHandle = 1;
    const clearFileCache = () => {
        cache.clear();
        cacheBytes = 0;
    };

    const callbacks = {
        open(name, size, handle, userdata) {
            try {
                if (isDisposed()) {
                    return publicSDK.ERR_INVALID_HANDLE;
                }

                const path = String(userdata ?? name);
                const bytes = files.sizeSync(path);

                if (bytes === null) {
                    return publicSDK.ERR_FILE_NOTFOUND;
                }

                if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 0xFF_FF_FF_FF) {
                    throw new Error('Invalid actual FMOD file size');
                }

                if (!Number.isSafeInteger(nextFileHandle) || nextFileHandle > 0x7F_FF_FF_FF) {
                    throw new Error('FMOD file owner identity exhausted');
                }

                const owner = { path, position: 0, bytes };
                const id = nextFileHandle++;

                callbackOwners.set(id, owner);
                fileOwners.add(owner);
                openFiles++;
                size.val = bytes;
                handle.val = id;

                return publicSDK.OK;
            } catch (error) {
                onFailure(error);

                return publicSDK.ERR_FILE_BAD;
            }
        },
        close(handle) {
            const owner = callbackOwners.get(handle);

            if (!owner) {
                return publicSDK.ERR_INVALID_HANDLE;
            }

            callbackOwners.delete(handle);
            fileOwners.delete(owner);
            openFiles--;
            clearFileCache();

            return publicSDK.OK;
        },
        seek(handle, position) {
            const owner = callbackOwners.get(handle);

            if (!owner) {
                return publicSDK.ERR_INVALID_HANDLE;
            }

            if (!Number.isSafeInteger(position) || position < 0) {
                return publicSDK.ERR_FILE_COULDNOTSEEK;
            }

            owner.position = position;

            return publicSDK.OK;
        },
        read(handle, buffer, count, bytesread) {
            try {
                const owner = callbackOwners.get(handle);

                if (!owner || isDisposed()) {
                    return publicSDK.ERR_INVALID_HANDLE;
                }

                if (!Number.isSafeInteger(count) || count < 0) {
                    throw new Error('Invalid SDK read count');
                }

                const requested = Math.min(count, Math.max(0, owner.bytes - owner.position));
                let copied = 0;

                while (copied < requested) {
                    const position = owner.position + copied;
                    const start = Math.floor(position / 65_536) * 65_536;
                    const key = `${owner.path}:${start}`;
                    let bytes = cache.get(key);

                    if (bytes) {
                        cache.delete(key);
                    } else {
                        if (cache.size === 4) {
                            const oldest = cache.keys().next().value;

                            cacheBytes -= cache.get(oldest).byteLength;
                            cache.delete(oldest);
                        }

                        const size = Math.min(65_536, owner.bytes - start);

                        bytes = files.readSync(owner.path, start, size);

                        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== size) {
                            throw new Error('FMOD range provider extent mismatch');
                        }

                        rangeReads++;
                        rangeBytes += size;
                        maxRangeBytes = Math.max(maxRangeBytes, size);
                        cacheBytes += size;
                        peakCacheBytes = Math.max(peakCacheBytes, cacheBytes);
                    }

                    cache.set(key, bytes);
                    const offset = position - start;
                    const length = Math.min(requested - copied, bytes.byteLength - offset);

                    for (let index = 0; index < length; index++) {
                        publicSDK.setValue(buffer + copied + index, bytes[offset + index], 'i8');
                    }

                    copied += length;
                }

                owner.position += copied;
                deliveredBytes += copied;
                bytesread.val = copied;

                return copied === count ? publicSDK.OK : publicSDK.ERR_FILE_EOF;
            } catch (error) {
                onFailure(error);

                return publicSDK.ERR_FILE_BAD;
            }
        },
    };

    function bankInfo(path) {
        const info = new publicSDK.STUDIO_BANK_INFO();

        Object.assign(info, {
            opencallback: callbacks.open, closecallback: callbacks.close, readcallback: callbacks.read,
            seekcallback: callbacks.seek, userdata: String(path),
        });
        callbackInfos.push(info);

        return info;
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
        const data = new Uint8Array(length);

        for (let start = 0; start < length; start += 65_536) {
            const count = Math.min(65_536, length - start);
            const bytes = files.readSync(path, start, count);

            if (!(bytes instanceof Uint8Array) || bytes.byteLength !== count) {
                throw new Error('Unbanked source range extent mismatch');
            }

            data.set(bytes, start);
            rangeReads++;
            rangeBytes += count;
            maxRangeBytes = Math.max(maxRangeBytes, count);
        }

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
        bankInfo,
        stageSound,
        clear: clearFileCache,
        dispose() {
            if (callbackOwners.size || fileOwners.size || openFiles) {
                throw new Error('FMOD SDK release left open custom file owners');
            }

            for (const [path, bytes] of staged) {
                publicSDK.FS_unlink(path);
                stagedBytes -= bytes;
                staged.delete(path);
            }

            callbackInfos.length = 0;
            callbackOwners.clear();
            fileOwners.clear();
            clearFileCache();
        },
        snapshot: () => ({ rangeBytes, rangeReads, maxRangeBytes, openFiles, deliveredBytes, cacheBytes, peakCacheBytes, stagedBytes, peakStagedBytes, stagedFiles: staged.size, stagingBudget }),
    };
}
