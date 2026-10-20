/**
 * Uses the runtime filesystem path normalization.
 *
 * @param {string} value - Original virtual path supplied by the JVM.
 * @returns {string} Canonical runtime path.
 */
const canonical = (value) => globalThis.cheerpjNormalizePath(String(value));

/**
 * Drops stale HTTP file/stat snapshots before original Java receives a change.
 *
 * @param {string} path - Canonical virtual filesystem path.
 * @param {boolean} subtree - Whether descendants must also lose cached HTTP snapshots.
 */
function invalidateWeb(path, subtree = false) {
    const mount = globalThis.cheerpjGetFSMountForPath(`${path}/`);

    if (mount.mountPoint !== '/app/' || !mount.inodeMap) {
        throw new Error('Unqualified HTTP filesystem mount');
    }

    const relative = path.slice(mount.mountPoint.length - 1);

    for (const name of Object.keys(mount.fileCache)) {
        if (name === relative || (subtree && name.startsWith(`${relative}/`))) {
            mount.clearCached(name);
        }
    }

    for (const name of Object.keys(mount.inodeMap)) {
        if (name === relative || (subtree && name.startsWith(`${relative}/`))) {
            delete mount.inodeMap[name];
        }
    }
}

const PACKET_LIMIT = 1_024;
const OVERFLOW_MASK = 16_384;

/**
 * Encodes the actual Linux inotify header and aligned UTF-8 name.
 *
 * @param {number} wd - Original watch descriptor, or -1 for queue overflow.
 * @param {number} mask - Original inotify event bits.
 * @param {string} [name] - Literal event entry name.
 * @returns {Uint8Array} One complete little-endian native record.
 */
function encodePacket(wd, mask, name = '') {
    const text = new TextEncoder().encode(name);
    const length = name ? Math.ceil((text.length + 1) / 4) * 4 : 0;
    const packet = new Uint8Array(16 + length);
    const view = new DataView(packet.buffer);

    if (packet.length > 8_192) {
        throw new Error('Watch event exceeds original read buffer');
    }

    view.setInt32(0, wd, true);
    view.setUint32(4, mask, true);
    view.setUint32(12, length, true);
    packet.set(text, 16);

    return packet;
}

/**
 * Bounds pending packets and retains one real IN_Q_OVERFLOW record on loss.
 *
 * @param {object} state - Owned packet array and overflow-presence flag.
 * @param {Uint8Array} packet - Complete original-format event record.
 * @returns {number} Number of ordinary records discarded by this append.
 */
function appendPacket(state, packet) {
    const isOverflow = (new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint32(4, true) & OVERFLOW_MASK) !== 0;

    if (isOverflow && state.overflowQueued) {
        return 0;
    }

    if (state.packets.length < PACKET_LIMIT) {
        state.packets.push(packet);

        if (isOverflow) {
            state.overflowQueued = true;
        }

        return 0;
    }

    let lost = isOverflow ? 0 : 1;

    if (!state.overflowQueued) {
        state.packets.pop();
        state.packets.push(encodePacket(-1, OVERFLOW_MASK));
        state.overflowQueued = true;
        lost++;
    }

    return lost;
}

/**
 * Implements missing JDK watch natives over actual browser descriptors and observed filesystem changes.
 *
 * @returns {object} Native handlers, installation, disposal and copied diagnostics.
 */
export function createFileWatchNatives() {
    let descriptors;

    let nextWatch = 1;

    const owned = new Map();

    const trace = [];

    const callCounts = {};

    let packetLosses = 0;

    let vmExitDisposal;

    let vmExited = false;

    let cancelledSubscriptions = 0;

    let unsettledNativePromises = 0;

    /**
     * Counts every operation while retaining only a copied, bounded recent trace.
     *
     * @param {object} event - One operation and its primitive diagnostic fields.
     */
    function record(event) {
        callCounts[event.op] = (callCounts[event.op] || 0) + 1;
        trace.push({ ...event });

        if (trace.length > 64) {
            trace.shift();
        }
    }

    const readiness = new Set();

    const pendingPolls = new Map();

    const paths = new WeakMap();

    const originals = new Map();

    let remote;

    let remoteReady;

    let remoteEpoch;

    let remoteSequence;

    let remotePrefixes = [];

    let remoteEvents = 0;

    let remoteFailure;

    /**
     * Signals actual notification loss through the original JDK overflow protocol.
     */
    function overflow() {
        for (const state of owned.values()) {
            if (state.kind === 'inotify') {
                enqueue(state, -1, 16_384);
            }
        }
    }

    /**
     * Invalidates registered directories affected by an actual observer failure.
     *
     * @param {string} path - Failed canonical directory and its affected subtree.
     */
    function invalidateWatches(path) {
        for (const state of owned.values()) {
            for (const [wd, watch] of state.watches) {
                if (watch.path === path || watch.path.startsWith(`${path}/`)) {
                    enqueue(state, wd, 32_768);
                    state.watches.delete(wd);
                }
            }
        }
    }

    /**
     * Waits for the real server watcher readiness before admitting an HTTP watch.
     *
     * @returns {Promise<void>} Completion of the non-replaying event stream handshake.
     */
    function connectRemote() {
        if (remoteReady) {
            return remoteReady;
        }

        remoteReady = new Promise((resolve, reject) => {
            remote = new EventSource('/watch-events');

            const timeout = setTimeout(() => {
                remoteFailure = 'Watch readiness deadline';
                remote.close();
                reject(new Error(remoteFailure));
            }, 5_000);

            remote.addEventListener('ready', (event) => {
                try {
                    const data = JSON.parse(event.data);

                    if (remoteEpoch || typeof data.epoch !== 'string' || !Number.isSafeInteger(data.sequence) || data.sequence < 0
                        || !Array.isArray(data.prefixes) || !data.prefixes.length || data.replay !== false
                        || !data.prefixes.every((prefix) => typeof prefix === 'string' && (prefix === '/app/media' || prefix.startsWith('/app/media/')) && canonical(prefix) === prefix)) {
                        throw new Error('Invalid actual watch readiness');
                    }

                    remoteEpoch = data.epoch;
                    remoteSequence = data.sequence;
                    remotePrefixes = data.prefixes;

                    clearTimeout(timeout);
                    resolve();
                } catch (error) {
                    remoteFailure = String(error);
                    remote.close();
                    clearTimeout(timeout);
                    reject(error);
                }
            });

            /**
             * Validates real server event order and refreshes caches before signaling Java.
             *
             * @param {MessageEvent} event - Actual SSE frame from the allowlisted loopback service.
             */
            const receive = (event) => {
                if (!(event instanceof MessageEvent)) {
                    return;
                }

                try {
                    const data = JSON.parse(event.data);

                    if (!remoteEpoch || data.epoch !== remoteEpoch || !Number.isSafeInteger(data.sequence) || data.sequence <= remoteSequence) {
                        throw new Error('Invalid watch event ordering');
                    }

                    if (data.sequence !== remoteSequence + 1) {
                        overflow();
                    }

                    remoteSequence = data.sequence;
                    remoteEvents++;

                    if (event.type === 'overflow') {
                        overflow();

                        return;
                    }

                    if (typeof data.path !== 'string' || canonical(data.path) !== data.path
                        || !remotePrefixes.some((prefix) => data.path === prefix || data.path.startsWith(`${prefix}/`))) {
                        throw new Error('Outside configured watch mount');
                    }

                    invalidateWeb(data.path, !!data.directory);

                    if (event.type === 'error') {
                        overflow();
                        remoteFailure = data.code || 'Native file watcher failed';

                        invalidateWatches(data.path);

                        remote.close();

                        return;
                    }

                    notify(data.path, { create: 256, modify: 2, delete: 512 }[event.type]);
                } catch (error) {
                    remoteFailure = String(error);
                    overflow();
                    remote.close();
                }
            };

            for (const type of ['create', 'modify', 'delete', 'overflow', 'error']) {
                remote.addEventListener(type, receive);
            }

            remote.addEventListener('error', () => {
                if (remoteFailure) {
                    return;
                }

                remoteFailure = 'HTTP file event stream disconnected';
                overflow();
                remote.close();
                clearTimeout(timeout);
                reject(new Error(remoteFailure));
            });
        });

        return remoteReady;
    }

    /**
     * Checks whether a mutation can affect an actual registered directory.
     *
     * @param {string} path - Canonical virtual filesystem path.
     * @returns {boolean} Whether pre-write metadata is needed.
     */
    const interested = (path) => [...owned.values()].some((state) => [...state.watches.values()].some((watch) => path.startsWith(`${watch.path}/`)));

    /**
     * Preserves an original OS function while installing one mutation observer.
     *
     * @param {string} name - Native service name or original relative entry name.
     * @param {function(function(...unknown): unknown): function(...unknown): unknown} replacement - Installs one observer around the unchanged OS operation.
     */
    function replace(name, replacement) {
        const original = globalThis[name];

        if (typeof original !== 'function') {
            throw new TypeError(`Missing OS function ${name}`);
        }

        originals.set(name, original);

        globalThis[name] = replacement(original);
    }

    /**
     * Filters a successful actual mutation through original watch masks.
     *
     * @param {string} path - Canonical virtual filesystem path.
     * @param {number} mask - Original inotify event bits.
     */
    function notify(path, mask) {
        const slash = path.lastIndexOf('/');
        const parent = path.slice(0, slash);
        const name = path.slice(slash + 1);

        for (const state of owned.values()) {
            if (state.kind !== 'inotify') {
                continue;
            }

            for (const [wd, watch] of state.watches) {
                if (watch.path !== parent || !(watch.mask & mask)) {
                    continue;
                }

                enqueue(state, wd, mask, name);
            }
        }
    }

    /**
     * Encodes one complete little-endian inotify record for the original Java decoder.
     *
     * @param {object} state - Owned actual descriptor queue.
     * @param {number} wd - Original watch descriptor identity.
     * @param {number} mask - Original inotify event bits.
     * @param {string} name - Native service name or original relative entry name.
     */
    function enqueue(state, wd, mask, name = '') {
        packetLosses += appendPacket(state, encodePacket(wd, mask, name));

        record({ op: 'event', wd, mask, name });

        changed();
    }

    /**
     * Observes successful runtime file mutations without replacing their storage operations.
     */
    function install() {
        replace('cheerpOSOpen', (open) => function (fds, path_, mode, callback) {
            if (descriptors && descriptors !== fds) {
                throw new Error('Unqualified second descriptor namespace');
            }

            descriptors = fds;

            const path = canonical(path_);

            /**
             * Completes the original open and signals only a successful watched write.
             *
             * @param {boolean|undefined} existed - Actual pre-open existence, when a watched write requires it.
             * @returns {unknown} Unchanged runtime open result.
             */
            const perform = (existed) => open(fds, path_, mode, (fd) => {
                if (fd >= 0) {
                    paths.set(fds[fd].fileData, path);

                    if (mode !== 'r' && existed !== undefined) {
                        notify(path, existed ? 2 : 256);
                    }
                }

                callback(fd);
            });

            if (mode === 'r' || !interested(path)) {
                return perform(undefined);
            }

            const ref = {};

            return globalThis.cheerpOSStat(path, ref, () => perform(!!ref.permType));
        });

        replace('cheerpOSWrite', (write) => function (fds, fd, buffer, offset, length, callback) {
            const path = fds[fd] && paths.get(fds[fd].fileData);

            return write(fds, fd, buffer, offset, length, (result) => {
                if (result > 0 && path) {
                    notify(path, 2);
                }

                callback(result);
            });
        });

        replace('cheerpOSCreateDir', (create) => function (path_, ref, mode, callback) {
            const path = canonical(path_);

            const before = {};

            return globalThis.cheerpOSStat(path, before, () => create(path_, ref, mode, (result) => {
                if (!before.permType && ref.exists === 5) {
                    notify(path, 256);
                }

                callback(result);
            }));
        });

        replace('cheerpOSUnlink', (unlink) => function (path_, callback) {
            const path = canonical(path_);

            return unlink(path_, (result) => {
                if (result === true) {
                    notify(path, 512);

                    for (const state of owned.values()) {
                        for (const [wd, watch] of state.watches) {
                            if (watch.path === path) {
                                enqueue(state, wd, 32_768);
                                state.watches.delete(wd);
                            }
                        }
                    }
                }

                callback(result);
            });
        });

        replace('cheerpOSRename', (rename) => function (source_, target_, callback) {
            const source = canonical(source_);
            const target = canonical(target_);

            return rename(source_, target_, (result) => {
                if (result === 1) {
                    notify(source, 64);
                    notify(target, 128);

                    for (const state of owned.values()) {
                        for (const watch of state.watches.values()) {
                            if (watch.path === source || watch.path.startsWith(`${source}/`)) {
                                watch.path = target + watch.path.slice(source.length);
                            }
                        }
                    }

                    for (const descriptor of descriptors ?? []) {
                        if (descriptor) {
                            const path = paths.get(descriptor.fileData);

                            if (path && (path === source || path.startsWith(`${source}/`))) {
                                paths.set(descriptor.fileData, target + path.slice(source.length));
                            }
                        }
                    }
                }

                callback(result);
            });
        });
    }

    /**
     * Resumes native polls whose actual queues became readable.
     */
    const changed = () => {
        for (const wake of [...readiness]) {
            wake();
        }
    };

    /**
     * Allocates an actual runtime descriptor backed by its owned byte queue.
     *
     * @param {string} kind - Inotify queue or socket endpoint role.
     * @returns {object} New queue owner and actual descriptor identity.
     */
    function allocate(kind) {
        if (vmExited) {
            throw new Error('Watch allocation after VM exit');
        }

        if (!descriptors) {
            throw new Error('No actual descriptor namespace');
        }

        const queue = [];

        const state = { kind, queue, packets: [], overflowQueued: false, closed: false, watches: new Map() };

        const mount = {
            /**
             * Reads complete event records or wakeup bytes into the actual caller buffer.
             *
             * @param {object} fileData - Actual CheerpOS file-data owner.
             * @param {number} offset - Original descriptor byte offset, unused by queue endpoints.
             * @param {Int8Array} buffer - Original JVM-backed I/O buffer.
             * @param {number} start - First caller buffer byte.
             * @param {number} length - Caller requested byte count.
             * @param {number} flags - Actual descriptor flags.
             * @param {function(number=): void} callback - Original OS completion callback.
             */
            readAsync(fileData, offset, buffer, start, length, flags, callback) {
                let count = 0;

                if (kind === 'inotify') {
                    while (state.packets.length && count + state.packets[0].length <= length) {
                        const packet = state.packets.shift();

                        buffer.set(packet, start + count);
                        count += packet.length;

                        if (new DataView(packet.buffer).getUint32(4, true) & OVERFLOW_MASK) {
                            state.overflowQueued = false;
                        }
                    }
                } else {
                    count = Math.min(length, queue.length);

                    for (let i = 0; i < count; i++) {
                        buffer[start + i] = queue.shift();
                    }
                }

                record({ op: 'read', fd, length, count });

                callback(count === 0 && (flags & 0x8_00) ? -11 : count);
            },
            /**
             * Writes real wakeup bytes to the paired socket queue.
             *
             * @param {object} fileData - Actual CheerpOS file-data owner.
             * @param {number} offset - Original descriptor byte offset, unused by queue endpoints.
             * @param {Int8Array} buffer - Original JVM-backed I/O buffer.
             * @param {number} start - First caller buffer byte.
             * @param {number} length - Caller requested byte count.
             * @param {function(number=): void} callback - Original OS completion callback.
             */
            writeAsync(fileData, offset, buffer, start, length, callback) {
                if (!state.peer || state.peer.closed) {
                    throw new Error('Closed watch socket');
                }

                for (let i = 0; i < length; i++) {
                    state.peer.queue.push(buffer[start + i]);
                }

                record({ op: 'write', fd, length });

                changed();

                callback(length);
            },
            /**
             * Releases this actual descriptor owner and its registered watches.
             *
             * @param {object} fileData - Actual CheerpOS file-data owner.
             * @param {function(number=): void} callback - Original OS completion callback.
             */
            close(fileData, callback) {
                state.closed = true;

                state.watches.clear();

                owned.delete(fd);

                record({ op: 'close', fd });

                changed();

                callback();
            },
        };

        if (typeof globalThis.cheerpOSAllocateFd !== 'function') {
            throw new TypeError('Missing actual OS descriptor allocator');
        }

        const fileData = { mount, refCount: 1, length: 0, dirty: 0 };
        const fd = globalThis.cheerpOSAllocateFd(descriptors, fileData);

        state.fd = fd;
        state.fileData = fileData;

        owned.set(fd, state);

        record({ op: 'allocate', fd, kind });

        return state;
    }

    /**
     * Requires a live descriptor belonging to this service.
     *
     * @param {number} fd - Actual runtime descriptor number.
     * @returns {object} Actual live queue owner.
     */
    const requireFd = (fd) => {
        if (vmExited) {
            throw new Error('Watch native call after VM exit');
        }

        const state = owned.get(fd);

        if (!state || state.closed) {
            throw new Error(`Unknown watch descriptor ${fd}`);
        }

        return state;
    };

    return {
        install,
        /**
         * Restores OS observers after original Java closes all watch services.
         */
        dispose() {
            if (owned.size || readiness.size || pendingPolls.size) {
                throw new Error('Original watch owners remain');
            }

            remote?.close();

            for (const [name, fn] of originals) {
                globalThis[name] = fn;
            }

            originals.clear();
        },
        /**
         * Releases actual host descriptors after the sole page VM has exited.
         * The caller must first observe cheerpjRunMain resolution; this is not Java watch closure.
         * Detached native promises stay unsettled until this VM's page is destroyed.
         *
         * @returns {Promise<void>} Actual descriptor closure and strict observer disposal.
         */
        disposeAfterVmExit() {
            vmExitDisposal ??= (async () => {
                vmExited = true;

                if (typeof globalThis.cheerpOSClose !== 'function') {
                    throw new TypeError('Missing actual OS descriptor close');
                }

                const fileData = new Set([...owned.values()].map((state) => state.fileData));
                const slots = [];

                for (const [wake] of pendingPolls) {
                    readiness.delete(wake);
                    pendingPolls.delete(wake);
                    cancelledSubscriptions++;
                    unsettledNativePromises++;
                    record({ op: 'vm-exit-poll-abandoned' });
                }

                for (const [fd, descriptor] of (descriptors ?? []).entries()) {
                    if (descriptor && fileData.has(descriptor.fileData)) {
                        slots.push({ fd, fileData: descriptor.fileData });
                    }
                }

                for (const { fd, fileData: expected } of slots) {
                    if (descriptors[fd]?.fileData !== expected) {
                        throw new Error(`Watch descriptor owner changed at VM exit: ${fd}`);
                    }

                    // eslint-disable-next-line no-await-in-loop -- Close aliases in descriptor order before checking their actual slots.
                    await new Promise((resolve) => {
                        globalThis.cheerpOSClose(descriptors, fd, resolve);
                    });

                    if (descriptors[fd] !== null) {
                        throw new Error(`Watch descriptor remains after actual close: ${fd}`);
                    }
                }

                if ((descriptors ?? []).some((descriptor) => descriptor && fileData.has(descriptor.fileData))) {
                    throw new Error('Owned watch descriptor alias remains after VM exit');
                }

                this.dispose();
                record({ op: 'vm-exit-dispose', descriptors: slots.length });
            })();

            return vmExitDisposal;
        },
        /**
         * Copies lifecycle counters without exposing mutable owner state.
         *
         * @returns {object} Actual descriptor, poll and server event state.
         */
        diagnostics: () => ({
            owned: owned.size,
            polls: readiness.size,
            cancelledSubscriptions,
            unsettledNativePromises,
            remoteEvents,
            remoteFailure,
            remoteState: remote?.readyState,
            remotePrefixes: [...remotePrefixes],
            callCounts: { ...callCounts },
            trace: trace.map((event) => ({ ...event })),
            packetLimit: PACKET_LIMIT,
            packetLosses,
            queuedPackets: [...owned.values()].reduce((sum, state) => sum + state.packets.length, 0),
        }),
        natives: {
            /**
             * Creates a real readable notification descriptor.
             *
             * @returns {number} Actual allocated file descriptor.
             */
            Java_sun_nio_fs_LinuxWatchService_inotifyInit() {
                return allocate('inotify').fd;
            },
            /**
             * Supplies the actual encoded native event header width.
             *
             * @returns {number} Sixteen-byte inotify header size.
             */
            Java_sun_nio_fs_LinuxWatchService_eventSize() {
                return 16;
            },
            /**
             * Supplies field offsets used by the original JDK event decoder.
             *
             * @returns {Int32Array} Original wd, mask, cookie, length and name offsets.
             */
            Java_sun_nio_fs_LinuxWatchService_eventOffsets() {
                return new Int32Array([0, 4, 8, 12, 16]);
            },
            /**
             * Records the original descriptor blocking policy.
             *
             * @param {object} lib - Current native call Java class namespace.
             * @param {number} fd - Actual runtime descriptor number.
             * @param {boolean} blocking - Original requested blocking mode.
             */
            async Java_sun_nio_fs_LinuxWatchService_configureBlocking(lib, fd, blocking) {
                requireFd(fd);

                if (blocking) {
                    const UnixException = await lib.sun.nio.fs.UnixException;

                    throw await new UnixException(95);
                }

                descriptors[fd].flags |= 0x8_00;
                descriptors[fd].fileData.flags = (descriptors[fd].fileData.flags || 0) | 0x8_00;
            },
            /**
             * Creates paired real queue descriptors used by original request and shutdown logic.
             *
             * @param {object} lib - Current native call Java class namespace.
             * @param {Int32Array} pair - Original two-element Java socket descriptor array.
             */
            Java_sun_nio_fs_LinuxWatchService_socketpair(lib, pair) {
                if (!(pair instanceof Int32Array) || pair.length !== 2) {
                    throw new Error('Unexpected actual socketpair Java array');
                }

                const read = allocate('socket-read');
                const write = allocate('socket-write');

                read.peer = write;
                write.peer = read;

                pair[0] = read.fd;
                pair[1] = write.fd;
            },
            /**
             * Registers an actual directory only after its event source is ready.
             *
             * @param {object} lib - Current native call Java class namespace.
             * @param {number} fd - Actual runtime descriptor number.
             * @param {bigint} address - Original JDK-owned UTF-8 native buffer address.
             * @param {number} mask - Original inotify event bits.
             * @returns {Promise<number>} Stable descriptor for this directory and updated event mask.
             */
            async Java_sun_nio_fs_LinuxWatchService_inotifyAddWatch(lib, fd, address, mask) {
                record({ op: 'add-begin', fd, addressType: typeof address });

                if (typeof address !== 'bigint' || address < 0n || address > BigInt(Number.MAX_SAFE_INTEGER - 4_096)) {
                    throw new Error('Unrepresentable original watch path address');
                }

                const Unsafe = await lib.jdk.internal.misc.Unsafe;

                const unsafe = await Unsafe.getUnsafe();

                const bytes = [];

                /**
                 * Reads the next original native-buffer byte in address order.
                 *
                 * @param {number} index - Current bounded path byte offset.
                 * @returns {Promise<void>} Completion at the original NUL terminator.
                 */
                async function readPath(index) {
                    if (index === 4_096) {
                        throw new Error('Unterminated original watch path');
                    }

                    const value = await unsafe.getByte(null, Number(address) + index);

                    if (value !== 0) {
                        bytes.push(value & 255);
                        await readPath(index + 1);
                    }
                }

                await readPath(0);

                const state = requireFd(fd);
                const path = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));

                if (canonical(path) !== path || !(path === '/files' || path.startsWith('/files/') || path === '/app' || path.startsWith('/app/'))) {
                    const UnixException = await lib.sun.nio.fs.UnixException;

                    throw await new UnixException(95);
                }

                if (path === '/app' || path.startsWith('/app/')) {
                    try {
                        await connectRemote();

                        if (remoteFailure || !remotePrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
                            throw new Error('Unsupported HTTP watch path');
                        }
                    } catch (error) {
                        record({ op: 'remote-failure', error: String(error) });

                        const UnixException = await lib.sun.nio.fs.UnixException;

                        throw await new UnixException(38);
                    }
                }

                const existing = [...state.watches.entries()].find(([,watch]) => watch.path === path);

                const wd = existing ? existing[0] : nextWatch++;

                state.watches.set(wd, { path, mask });
                record({ op: 'add', fd, wd, path, mask });

                return wd;
            },
            /**
             * Cancels original directory observation for this watch descriptor.
             *
             * @param {object} lib - Current native call Java class namespace.
             * @param {number} fd - Actual runtime descriptor number.
             * @param {number} wd - Original watch descriptor identity.
             */
            Java_sun_nio_fs_LinuxWatchService_inotifyRmWatch(lib, fd, wd) {
                requireFd(fd).watches.delete(wd);
                record({ op: 'remove', fd, wd });
            },
            /**
             * Waits for actual notification or wakeup bytes.
             *
             * @param {object} lib - Current native call Java class namespace.
             * @param {number} ifd - Original inotify descriptor.
             * @param {number} socketfd - Original wakeup socket read descriptor.
             * @returns {Promise<number>} Number of ready original descriptors.
             */
            Java_sun_nio_fs_LinuxWatchService_poll(lib, ifd, socketfd) {
                const state = requireFd(ifd);
                const socket = requireFd(socketfd);

                let wake;
                const promise = new Promise((resolve, reject) => {
                    /**
                     * Resolves a blocked native poll only when a real descriptor is readable.
                     */
                    wake = () => {
                        if (state.closed || socket.closed) {
                            readiness.delete(wake);
                            pendingPolls.delete(wake);
                            record({ op: 'poll-closed', ifd, socketfd });
                            reject(new Error('Poll descriptors closed'));

                            return;
                        }

                        const ready = (state.packets.length ? 1 : 0) + (socket.queue.length ? 1 : 0);

                        if (ready) {
                            readiness.delete(wake);
                            pendingPolls.delete(wake);
                            resolve(ready);
                        }
                    };
                });

                pendingPolls.set(wake, promise);
                readiness.add(wake);
                wake();

                return promise;
            },
        },
    };
}
