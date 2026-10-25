/**
 * Applies the existing intrinsic positive-certificate conditions without changing paths.
 *
 * @param {object} entry - Actual publication-derived certificate entry.
 * @returns {boolean} Whether every original intrinsic entry condition is met.
 */
export function isPositiveMetadataEntry(entry) {
    return typeof entry.path === 'string' && entry.path.startsWith('/media/')
        && /^[\x20-\x7E]+$/u.test(entry.path) && !/[\\:%?#~]/u.test(entry.path)
        && entry.path.split('/').slice(1).every((part) => part && part !== '.' && part !== '..' && !/[. ]$/u.test(part))
        && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && entry.bytes <= 0x7F_FF_FF_FF
        && /^[a-f0-9]{64}$/u.test(entry.sha256);
}

/**
 * Installs the pinned negative owner with optional verified-snapshot positive stat metadata.
 *
 * @param {object} host - Actual runtime global, or isolated authored mock.
 * @param {object} mount - Actual /app/ mount identity.
 * @param {object} certificate - Frozen source and individually certified absent spellings.
 * @param {object|null} [positiveCertificate] - Already-materialized verified snapshot metadata.
 * @returns {object} Scalar diagnostics and exact owned restoration.
 */
export function installNegativeStat(host, mount, certificate, positiveCertificate = null) {
    const descriptor = Object.getOwnPropertyDescriptor(host, 'webStatAsyncImpl');

    if (certificate.schema !== 'closed-media-negative-v1' || certificate.closedNamespace !== true
        || !descriptor || !descriptor.writable || typeof descriptor.value !== 'function'
        || Function.prototype.toString.call(descriptor.value) !== certificate.hookSource
        || !/^[a-f0-9]{64}$/u.test(certificate.namespaceSHA)
        || mount.mountPoint !== '/app/' || !host.cheerpjFSMounts.includes(mount)) {
        throw new Error('Unqualified original metadata hook/mount');
    }

    const absent = new Set(certificate.absent);

    if (absent.size !== certificate.absent.length || [...absent].some((name) => !/^\/media\/[\x20-\x7E]+\.(?:png|fbx|glb)$/u.test(name) || /[\\:%?#~]/u.test(name) || name.split('/').slice(1).some((part) => !part || part === '.' || part === '..' || /[. ]$/u.test(part)))) {
        throw new Error('Invalid exact negative certificate');
    }

    const original = descriptor.value;
    const positives = new Map();
    let inodeHelper;

    if (positiveCertificate !== null) {
        const helperDescriptor = Object.getOwnPropertyDescriptor(host, 'webGetInode');

        if (positiveCertificate.schema !== 'verified-owned-positive-v1'
            || positiveCertificate.namespaceSHA !== certificate.namespaceSHA
            || positiveCertificate.lastModified !== 0 || positiveCertificate.metadataOnly !== true
            || !helperDescriptor || typeof helperDescriptor.value !== 'function'
            || Function.prototype.toString.call(helperDescriptor.value) !== positiveCertificate.inodeHelperSource
            || host.CheerpJFileData?.S_IFREG !== 0x80_00 || !Array.isArray(positiveCertificate.files)) {
            throw new Error('Unqualified materialized positive metadata/helper');
        }

        inodeHelper = helperDescriptor.value;

        for (const entry of positiveCertificate.files) {
            if (!isPositiveMetadataEntry(entry) || positives.has(entry.path) || absent.has(entry.path)) {
                throw new Error('Invalid exact materialized file metadata');
            }

            positives.set(entry.path, entry.bytes);
        }
    }

    const pathCounts = new Map([...absent].map((name) => [name, 0]));
    let active = true;
    let intercepted = 0;
    let delegated = 0;
    let positiveStats = 0;

    /**
     * Preserves original calls except individually certified missing fixture paths.
     *
     * @param {...unknown} args - Exact native metadata arguments.
     * @returns {unknown} Exact callback or original return.
     */
    function wrapped(...args) {
        const [actualMount, name, fileRef, onData, callback] = args;

        if (active && actualMount === mount && absent.has(name) && mount.inodeMap[name] === undefined) {
            intercepted++;
            pathCounts.set(name, pathCounts.get(name) + 1);
            fileRef.permType = 0;
            fileRef.inodeId = 0;
            fileRef.lastModified = 0;

            return callback();
        }

        if (active && actualMount === mount && !mount.resTrace && onData === null && positives.has(name)
            && mount.inodeMap[name] === undefined) {
            if (host.webGetInode !== inodeHelper) {
                throw new Error('Pinned inode helper changed before positive stat');
            }

            const inode = Reflect.apply(inodeHelper, host, [mount, name]);

            inode.permType = host.CheerpJFileData.S_IFREG | 0o444;
            inode.fileLength = positives.get(name);
            fileRef.fileLength = inode.fileLength;
            fileRef.inodeId = Math.trunc(inode.inodeId);
            fileRef.permType = Math.trunc(inode.permType);
            fileRef.lastModified = 0;
            positiveStats++;

            return callback();
        }

        delegated++;

        return Reflect.apply(original, this, args);
    }

    Object.defineProperty(host, 'webStatAsyncImpl', { ...descriptor, value: wrapped });

    return {
        /**
         * Copies bounded owner diagnostics.
         *
         * @returns {object} Metadata path counts and lifetime.
         */
        snapshot() {
            return { intercepted, delegated, positiveStats, active, paths: Object.fromEntries(pathCounts) };
        },
        /** Restores only this owner's exact descriptor; a foreign replacement is an error. */
        dispose() {
            if (!active) {
                return;
            }

            if (Object.getOwnPropertyDescriptor(host, 'webStatAsyncImpl')?.value !== wrapped) {
                active = false;
                absent.clear();
                positives.clear();
                throw new Error('Metadata hook owner changed before disposal');
            }

            Object.defineProperty(host, 'webStatAsyncImpl', descriptor);
            active = false;
            absent.clear();
        },
    };
}
