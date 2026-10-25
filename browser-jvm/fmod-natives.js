/* eslint-disable jsdoc/require-jsdoc -- JNI table names retain the installed Java signatures; the owner contract is documented below. */
const handleKey = (kind, id) => `${kind}:${BigInt(id)}`;
const arrayLength = async (lib, destination) => destination instanceof BigInt64Array
    ? destination.length
    : (await lib.port.host.FmodArrays).arrayLength(destination);

/**
 * Owns actual FMOD Studio objects behind the original javafmod JNI identities.
 * Unimplemented original entry points remain absent; no silent audio replacement.
 *
 * @param {object} FMOD - Initialized supplied official HTML5 FMOD module.
 * @param {object} files - Actual bounded file-range provider.
 * @param {function(string): Promise<number|null>} files.size - Actual length, or certified file absence.
 * @param {function(string, number, number): Promise<Uint8Array>} files.read - Actual requested bytes.
 * @param {number|null} [output] - Explicit data-only oracle output; browser default is unchanged.
 * @param {Array<object>|null} [reverbPresets] - Verified original-compatible SDK preset definitions.
 * @returns {object} Original JNI callbacks and owned engine teardown.
 */
export function createFmodNatives(FMOD, files, output = null, reverbPresets = null) {
    const handles = new Map();
    const deliveries = new Set();
    let next = 1n << 32n;
    let system;
    let core;
    let lock = Promise.resolve();
    let initialized = false;
    let version;
    let rangeBytes = 0;
    let rangeReads = 0;
    let maxRangeBytes = 0;
    let openFiles = 0;
    let ioFailure;
    let disposed = false;
    const ownedDSPs = [];
    let masterChannelGroup;
    const pendingCallbacks = [];
    let deliveredCallbacks = 0;
    // Original integration 0x18000b7b0..b85e keeps the last listener attributes globally.
    let listenerAttributes = {
        position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 },
        forward: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 0, z: 0 },
    };

    const drop = (kind, id) => {
        const key = handleKey(kind, id);
        const entry = handles.get(key);

        if (entry?.object.$$) {
            entry.object.delete();
        }

        handles.delete(key);
    };

    const expiredChannel = (object) => {
        object.isPlaying();
        const error = FMOD.getLastError();

        if (error === FMOD.ERR_INVALID_HANDLE || error === FMOD.ERR_CHANNEL_STOLEN) {
            FMOD.setLastError(FMOD.OK);

            return true;
        }

        if (error !== FMOD.OK) {
            throw new Error(`FMOD channel lifetime query: ${FMOD.errorString(error)} (${error})`);
        }

        return false;
    };

    const retain = (kind, object) => {
        if (!object) {
            throw new Error(`FMOD returned no ${kind}: ${FMOD.getLastError()}`);
        }

        const valueCopy = ['guid', 'parameter', 'parameterID'].includes(kind);
        const wrapper = object.$$?.ptr;

        if (!valueCopy && (!Number.isSafeInteger(wrapper) || wrapper <= 0)) {
            throw new Error(`FMOD ${kind} has no actual SDK wrapper pointer`);
        }

        /* In the pinned 2.04 SDK, Embind points to a wrapper whose first uint32 is
         * the real FMOD handle. Repeated enumeration allocates different wrappers
         * for the same handle. GUID/parameter structs remain separately owned copies. */
        const id = valueCopy ? next++ : BigInt(FMOD.getValue(wrapper, 'i32') >>> 0);
        const key = handleKey(kind, id);
        const existing = handles.get(key);

        if (existing) {
            if (object !== existing.object) {
                object.delete();
            }
        } else {
            handles.set(key, { kind, id, object });
        }

        return id;
    };

    const use = (id, kind) => {
        const entry = handles.get(handleKey(kind, id));

        if (!entry) {
            throw new Error(`Unknown FMOD ${kind} identity ${id}`);
        }

        return entry.object;
    };

    const requireSystem = () => {
        if (!system) {
            throw new Error('Original FMOD system creation required');
        }

        return system;
    };

    const writeHandles = async (lib, destination, objects, kind) => {
        const ids = objects.map((object) => retain(kind, object));

        if (destination instanceof BigInt64Array) {
            if (destination.length < ids.length) {
                throw new Error('FMOD output array extent');
            }

            destination.set(ids);
        } else {
            await (await lib.port.host.FmodArrays).write(destination, ids.join(','));
        }

        return ids.length;
    };

    const fileCallbacks = async (path) => {
        const length = await files.size(path);

        if (length !== null && (!Number.isSafeInteger(length) || length < 0 || length > 0xFF_FF_FF_FF)) {
            throw new Error('Invalid actual FMOD file length');
        }

        return {
            userdata: path,
            opencallback() {
                if (length === null) {
                    return { filesize: 0, handle: null, result: FMOD.ERR_FILE_NOTFOUND };
                }

                openFiles++;

                return { filesize: length, handle: { position: 0, closed: false }, result: FMOD.OK };
            },
            closecallback(handle) {
                if (!handle.closed) {
                    handle.closed = true;
                    openFiles--;
                }
            },
            seekcallback(handle, position) {
                if (handle.closed || position < 0 || position > length) {
                    return FMOD.ERR_FILE_COULDNOTSEEK;
                }

                handle.position = position;

                return FMOD.OK;
            },
            async readcallback(handle, pointer, count) {
                try {
                    if (handle.closed) {
                        return { bytesread: 0, result: FMOD.ERR_INVALID_HANDLE };
                    }

                    const requested = Math.min(count, length - handle.position);
                    let copied = 0;

                    while (copied < requested) {
                        const chunk = Math.min(1_024 * 1_024, requested - copied);
                        // eslint-disable-next-line no-await-in-loop -- Keep one bounded source range active for this native read.
                        const bytes = await files.read(path, handle.position + copied, chunk);

                        if (bytes.byteLength !== chunk) {
                            throw new Error('FMOD range provider returned the wrong byte count');
                        }

                        FMOD.copyToPtr(pointer + copied, bytes, bytes.byteLength);
                        copied += bytes.byteLength;
                        rangeBytes += bytes.byteLength;
                        maxRangeBytes = Math.max(maxRangeBytes, bytes.byteLength);
                        rangeReads++;
                    }

                    handle.position += copied;

                    return { bytesread: copied, result: copied === count ? FMOD.OK : FMOD.ERR_FILE_EOF };
                } catch (error) {
                    ioFailure ??= error;

                    return { bytesread: 0, result: FMOD.ERR_FILE_BAD };
                }
            },
        };
    };

    const operations = {
        FMOD_System_Create() {
            if (system) {
                throw new Error('FMOD system already owned');
            }

            system = FMOD.Studio_System_Create();
            core = system.getCoreSystem();
            core.setFileSystem(async (name) => {
                try {
                    const callbacks = await fileCallbacks(String(name));
                    const opened = callbacks.opencallback();

                    if (opened.result === FMOD.OK) {
                        opened.handle.callbacks = callbacks;
                    }

                    return opened;
                } catch (error) {
                    ioFailure ??= error;

                    return { filesize: 0, handle: null, result: FMOD.ERR_FILE_NOTFOUND };
                }
            }, (handle) => handle.callbacks.closecallback(handle),
            (handle, pointer, count) => handle.callbacks.readcallback(handle, pointer, count),
            (handle, position) => handle.callbacks.seekcallback(handle, position), undefined, undefined, -1);
            version = core.getVersion();

            if (version.version !== 0x00_02_04_00) {
                throw new Error('Unexpected admitted FMOD engine version');
            }

            if (output !== null) {
                core.setOutput(output);
            }

            return FMOD.OK;
        },
        async FMOD_System_Init(_lib, channels, studioFlags, coreFlags) {
            // Original integration 0x18000db6f..dbb5 selects 32 kHz / 5.1 before Studio initialize.
            core.setSoftwareFormat(32_000, FMOD.SPEAKERMODE_5POINT1, 0);
            await requireSystem().initialize(channels, Number(studioFlags), Number(coreFlags), null);
            initialized = true;

            return FMOD.OK;
        },
        async FMOD_System_Update() {
            await requireSystem().update();

            return FMOD.OK;
        },
        FMOD_System_Set3DSettings(_lib, doppler, distance, rolloff) {
            core.set3DSettings(doppler, distance, rolloff);

            return FMOD.OK;
        },
        FMOD_System_CreateChannelGroup(_lib, name) {
            return retain('channelGroup', core.createChannelGroup(String(name)));
        },
        async FMOD_Studio_LoadBankFile(_lib, name) {
            const path = String(name);
            const info = await fileCallbacks(path);
            const bank = await requireSystem().loadBankCustom(info, FMOD.STUDIO_LOAD_BANK_NORMAL);
            const result = FMOD.getLastError();

            // Original JNI 0x18000b922..b92b returns negated FMOD_RESULT, not a Java exception.
            if (result !== FMOD.OK) {
                FMOD.setLastError(FMOD.OK);

                return -BigInt(result);
            }

            return retain('bank', bank);
        },
        FMOD_Studio_GetEvent(_lib, path) {
            return retain('event', requireSystem().getEvent(String(path)));
        },
        async FMOD_Studio_CreateEventInstance(_lib, id) {
            const instance = await use(id, 'event').createInstance();

            return retain('instance', instance);
        },
        async FMOD_Studio_StartEvent(_lib, id) {
            await use(id, 'instance').start();
        },
        async FMOD_Studio_LoadSampleData(_lib, id) {
            await use(id, 'bank').loadSampleData();

            return FMOD.OK;
        },
        async FMOD_Studio_LoadEventSampleData(_lib, id) {
            await use(id, 'event').loadSampleData();

            return FMOD.OK;
        },
        FMOD_Studio_GetTimelinePosition(_lib, id) {
            return BigInt(use(id, 'instance').getTimelinePosition());
        },
        FMOD_Studio_GetPlaybackState(_lib, id) {
            return use(id, 'instance').getPlaybackState();
        },
        FMOD_Studio_EventInstance_SetVolume(_lib, id, value) {
            use(id, 'instance').setVolume(value);

            return FMOD.OK;
        },
        FMOD_Studio_EventInstance_GetVolume(_lib, id) {
            return use(id, 'instance').getVolume().volume;
        },
        FMOD_Studio_EventInstance_SetParameterByName(_lib, id, name, value) {
            use(id, 'instance').setParameterByName(String(name), value, false);

            return FMOD.OK;
        },
        FMOD_Studio_GetParameter(_lib, id, name) {
            return use(id, 'instance').getParameterByName(String(name)).value;
        },
        async FMOD_Studio_EventInstance_Stop(_lib, id, immediate) {
            await use(id, 'instance').stop(immediate ? FMOD.STUDIO_STOP_IMMEDIATE : FMOD.STUDIO_STOP_ALLOWFADEOUT);

            return FMOD.OK;
        },
        async FMOD_Studio_ReleaseEventInstance(_lib, id) {
            await use(id, 'instance').release();
            drop('instance', id);

            return FMOD.OK;
        },
        async FMOD_Studio_System_FlushCommands() {
            await requireSystem().flushCommands();
        },
        FMOD_Studio_System_GetBankCount() {
            return requireSystem().getBankCount();
        },
        FMOD_Studio_Bank_GetEventCount(_lib, id) {
            return use(id, 'bank').getEventCount();
        },
        async FMOD_Studio_Bank_GetEventList(lib, id, destination) {
            const length = await arrayLength(lib, destination);

            return writeHandles(lib, destination, use(id, 'bank').getEventList(length), 'event');
        },
        async FMOD_Studio_System_GetBankList(lib, destination) {
            const length = await arrayLength(lib, destination);

            return writeHandles(lib, destination, requireSystem().getBankList(length), 'bank');
        },
        FMOD_Studio_EventDescription_GetPath(_lib, id) {
            return use(id, 'event').getPath();
        },
        FMOD_Studio_EventDescription_GetLength(_lib, id) {
            return BigInt(use(id, 'event').getLength());
        },
        FMOD_Studio_EventDescription_GetParameterDescriptionCount(_lib, id) {
            return use(id, 'event').getParameterDescriptionCount();
        },
        FMOD_Studio_System_GetParameterDescriptionCount() {
            return requireSystem().getParameterDescriptionCount();
        },
        FMOD_Studio_System_SetParameterByName(_lib, name, value, ignore) {
            requireSystem().setParameterByName(String(name), value, ignore);

            return FMOD.OK;
        },
        FMOD_Studio_System_GetVCA(_lib, path) {
            return retain('vca', requireSystem().getVCA(String(path)));
        },
        FMOD_Studio_VCA_GetPath(_lib, id) {
            return use(id, 'vca').getPath();
        },
        FMOD_Studio_VCA_GetVolume(_lib, id) {
            return use(id, 'vca').getVolume().volume;
        },
        FMOD_Studio_VCA_SetVolume(_lib, id, value) {
            use(id, 'vca').setVolume(value);

            return FMOD.OK;
        },
    };

    Object.assign(operations, {
        FMOD_Channel_Set3DLevel(_lib, id, level) {
            use(id, 'channel').set3DLevel(level);

            return FMOD.OK;
        },
        FMOD_Channel_Set3DOcclusion(_lib, id, direct, reverb) {
            use(id, 'channel').set3DOcclusion(direct, reverb);

            return FMOD.OK;
        },
        FMOD_Channel_SetPriority(_lib, id, priority) {
            use(id, 'channel').setPriority(priority);

            return FMOD.OK;
        },
        FMOD_Studio_EventInstance_SetProperty(_lib, id, property, value) {
            use(id, 'instance').setProperty(property, value);
        },
        FMOD_System_GetMasterChannelGroup() {
            return retain('channelGroup', core.getMasterChannelGroup());
        },
        FMOD_ChannelGroup_SetPaused(_lib, id, value) {
            use(id, 'channelGroup').setPaused(Boolean(value));

            return FMOD.OK;
        },
        FMOD_ChannelGroup_Stop(_lib, id) {
            use(id, 'channelGroup').stop();

            return FMOD.OK;
        },
        FMOD_Channel_GetPosition(_lib, id, unit) {
            return BigInt(use(id, 'channel').getPosition(Number(unit)));
        },
        FMOD_Studio_EventDescription_GetInstanceCount(_lib, id) {
            return use(id, 'event').getInstanceCount();
        },
        async FMOD_Studio_EventDescription_GetInstanceList(lib, id, destination) {
            const length = await arrayLength(lib, destination);

            return writeHandles(lib, destination, use(id, 'event').getInstanceList(length), 'instance');
        },
        FMOD_Studio_EventInstance_SetCallback(_lib, id, callback, mask) {
            const supported = FMOD.STUDIO_EVENT_CALLBACK_STARTED | FMOD.STUDIO_EVENT_CALLBACK_STOPPED | FMOD.STUDIO_EVENT_CALLBACK_TIMELINE_MARKER;

            if ((mask & ~supported) !== 0) {
                throw new Error('Original FMOD Java callback type not supported');
            }

            use(id, 'instance').setCallback(callback === null
                ? null
                : (type, _event, parameters) => {
                        if (disposed) {
                            return FMOD.OK;
                        }

                        switch (type) {
                            case FMOD.STUDIO_EVENT_CALLBACK_STARTED: {
                                pendingCallbacks.push({ callback, method: 'started', args: [BigInt(id)] });
                                break;
                            }
                            case FMOD.STUDIO_EVENT_CALLBACK_STOPPED: {
                                pendingCallbacks.push({ callback, method: 'stopped', args: [BigInt(id)] });
                                break;
                            }
                            case FMOD.STUDIO_EVENT_CALLBACK_TIMELINE_MARKER: {
                                pendingCallbacks.push({ callback, method: 'timelineMarker', args: [BigInt(id), String(parameters.name), parameters.position] });
                                // No default
                            }

                                break;
                        }

                        return FMOD.OK;
                    }, mask);

            return FMOD.OK;
        },

        async FMOD_System_CreateSound(_lib, path, mode) {
            const sound = await core.createSound(String(path), Number(mode));

            // Original CreateSound 0x18000d230..d249 applies these modes after loading.
            sound.setMode(FMOD.LOOP_OFF);
            sound.setMode(FMOD._3D_LINEARSQUAREROLLOFF);

            return retain('sound', sound);
        },
        async FMOD_System_PlaySound(_lib, id, paused) {
            // Retire wrappers only after the SDK confirms invalid/stolen native handles.
            for (const entry of handles.values()) {
                if (entry.kind === 'channel' && expiredChannel(entry.object)) {
                    drop('channel', entry.id);
                }
            }

            const channel = await core.playSound(use(id, 'sound'), null, Boolean(paused));

            return retain('channel', channel);
        },
        async FMOD_Sound_Release(_lib, id) {
            await use(id, 'sound').release();
            drop('sound', id);

            return FMOD.OK;
        },
        FMOD_Sound_Set3DMinMaxDistance(_lib, id, min, max) {
            use(id, 'sound').set3DMinMaxDistance(min, max);

            return FMOD.OK;
        },
        FMOD_Sound_SetMode(_lib, id, mode) {
            use(id, 'sound').setMode(Number(mode));

            return FMOD.OK;
        },
        FMOD_Channel_IsPlaying(_lib, id) {
            const entry = handles.get(handleKey('channel', id));

            // Original JNI initializes false for invalid handles, including retired channels.
            if (!entry) {
                return false;
            }

            const playing = entry.object.isPlaying();
            const error = FMOD.getLastError();

            /* Original JNI 0x180007bb0 returns the initialized bool and ignores FMOD_RESULT.
             * Only expected channel expiry/stealing is normalized; I/O failures stay fatal. */
            if (error === FMOD.ERR_INVALID_HANDLE || error === FMOD.ERR_CHANNEL_STOLEN) {
                FMOD.setLastError(FMOD.OK);

                return false;
            }

            return playing;
        },
        async FMOD_Channel_Stop(_lib, id) {
            await use(id, 'channel').stop();

            return FMOD.OK;
        },
        FMOD_Channel_SetPaused(_lib, id, paused) {
            use(id, 'channel').setPaused(Boolean(paused));

            return FMOD.OK;
        },
        FMOD_Channel_SetVolume(_lib, id, volume) {
            use(id, 'channel').setVolume(volume);

            return FMOD.OK;
        },
        FMOD_Channel_SetPitch(_lib, id, pitch) {
            use(id, 'channel').setPitch(pitch);

            return FMOD.OK;
        },
        FMOD_Channel_SetReverbProperties(_lib, id, instance, wet) {
            use(id, 'channel').setReverbProperties(instance, wet);

            return FMOD.OK;
        },
        FMOD_Channel_Set3DAttributes(_lib, id, x, y, z, vx, vy, vz) {
            use(id, 'channel').set3DAttributes({ x, y, z }, { x: vx, y: vy, z: vz });

            return FMOD.OK;
        },
        FMOD_Channel_SetChannelGroup(_lib, id, group) {
            use(id, 'channel').setChannelGroup(use(group, 'channelGroup'));

            return FMOD.OK;
        },
        FMOD_Channel_Set3DMinMaxDistance(_lib, id, min, max) {
            use(id, 'channel').set3DMinMaxDistance(min, max);

            return FMOD.OK;
        },
        FMOD_Channel_SetMode(_lib, id, mode) {
            use(id, 'channel').setMode(Number(mode));

            return FMOD.OK;
        },
        FMOD_System_SetReverbDefault(_lib, instance, preset) {
            if (!Array.isArray(reverbPresets) || reverbPresets.length !== 24) {
                throw new Error('Verified supplied SDK reverb presets required');
            }

            // Native default switch data is HALLWAY (index 13), not OFF.
            const selected = reverbPresets[preset] ?? reverbPresets[13];

            core.setReverbProperties(instance, selected.properties);
        },
        FMOD_System_PlayDSP() {
            // Original 0x18000de20 creates lowpass/highpass/echo and captures the master group.
            for (const type of [FMOD.DSP_TYPE_LOWPASS, FMOD.DSP_TYPE_HIGHPASS, FMOD.DSP_TYPE_ECHO]) {
                ownedDSPs.push(core.createDSPByType(type));
            }

            masterChannelGroup = core.getMasterChannelGroup();

            return FMOD.OK;
        },

        FMOD_Studio_SetNumListeners(_lib, count) {
            requireSystem().setNumListeners(count);

            return FMOD.OK;
        },
        FMOD_Studio_Listener3D(_lib, listener, x, y, z, vx, vy, vz, fx, fy, fz, ux, uy, uz) {
            listenerAttributes = {
                position: { x, y, z }, velocity: { x: vx, y: vy, z: vz },
                forward: { x: fx, y: fy, z: fz }, up: { x: ux, y: uy, z: uz },
            };
            requireSystem().setListenerAttributes(listener, listenerAttributes);
        },
        FMOD_Studio_EventInstance3D(_lib, id, x, y, z) {
            // Native 0x18000b03a..b08a copies last-listener velocity/orientation, replacing position.
            use(id, 'instance').set3DAttributes({ ...listenerAttributes, position: { x, y, z } });

            return FMOD.OK;
        },

        FMOD_Studio_Bank_GetVCACount(_lib, id) {
            return use(id, 'bank').getVCACount();
        },
        async FMOD_Studio_Bank_GetVCAList(lib, id, destination) {
            const length = await arrayLength(lib, destination);

            return writeHandles(lib, destination, use(id, 'bank').getVCAList(length), 'vca');
        },

        async FMOD_Studio_System_GetParameterDescriptionList(lib, destination) {
            const length = await arrayLength(lib, destination);

            return writeHandles(lib, destination, requireSystem().getParameterDescriptionList(length), 'parameter');
        },
        FMOD_Studio_EventDescription_GetParameterDescriptionByIndex(_lib, id, index) {
            return retain('parameter', use(id, 'event').getParameterDescriptionByIndex(index));
        },
        FMOD_Studio_ParameterDescription_GetName(_lib, id) {
            return use(id, 'parameter').name;
        },
        FMOD_Studio_ParameterDescription_GetFlags(_lib, id) {
            return use(id, 'parameter').flags;
        },
        FMOD_Studio_ParameterDescription_GetID(_lib, id) {
            return retain('parameterID', use(id, 'parameter').id);
        },
        FMOD_Studio_ParameterDescription_Free(_lib, id) {
            use(id, 'parameter');
            drop('parameter', id);
        },
        FMOD_Studio_System_SetParameterByID(_lib, id, value, ignore) {
            requireSystem().setParameterByID(use(id, 'parameterID'), value, ignore);

            return FMOD.OK;
        },
        FMOD_Studio_EventInstance_SetParameterByID(_lib, instance, id, value, ignore) {
            use(instance, 'instance').setParameterByID(use(id, 'parameterID'), value, ignore);

            return FMOD.OK;
        },
        FMOD_Studio_EventDescription_GetID(_lib, id) {
            return retain('guid', use(id, 'event').getID());
        },
        FMOD_Studio_EventDescription_GetParameterLabelByIndex(_lib, id, parameter, label) {
            return use(id, 'event').getParameterLabelByIndex(parameter, label);
        },
        FMOD_Studio_EventDescription_HasSustainPoint(_lib, id) {
            return use(id, 'event').hasSustainPoint();
        },
        FMOD_Studio_EventInstance_GetPaused(_lib, id) {
            return use(id, 'instance').getPaused();
        },
        FMOD_Studio_EventInstance_SetPaused(_lib, id, paused) {
            use(id, 'instance').setPaused(paused);
        },
        FMOD_Studio_EventInstance_KeyOff(_lib, id) {
            use(id, 'instance').keyOff();

            return FMOD.OK;
        },
        FMOD_Studio_EventInstance_SetTimelinePosition(_lib, id, position) {
            use(id, 'instance').setTimelinePosition(position);

            return FMOD.OK;
        },
        FMOD_Studio_System_GetBus(_lib, path) {
            return retain('bus', requireSystem().getBus(String(path)));
        },
        FMOD_Studio_Bus_GetMute(_lib, id) {
            return use(id, 'bus').getMute();
        },
        FMOD_Studio_Bus_GetPaused(_lib, id) {
            return use(id, 'bus').getPaused();
        },
        FMOD_Studio_Bus_GetVolume(_lib, id) {
            return use(id, 'bus').getVolume().volume;
        },
        FMOD_Studio_Bus_SetMute(_lib, id, value) {
            use(id, 'bus').setMute(value);

            return FMOD.OK;
        },
        FMOD_Studio_Bus_SetPaused(_lib, id, value) {
            use(id, 'bus').setPaused(value);

            return FMOD.OK;
        },
        FMOD_Studio_Bus_SetVolume(_lib, id, value) {
            use(id, 'bus').setVolume(value);

            return FMOD.OK;
        },
        FMOD_Studio_Bus_StopAllEvents(_lib, id, immediate) {
            use(id, 'bus').stopAllEvents(immediate ? FMOD.STUDIO_STOP_IMMEDIATE : FMOD.STUDIO_STOP_ALLOWFADEOUT);

            return FMOD.OK;
        },
    });
    const natives = {};

    for (const [name, operation] of Object.entries(operations)) {
        natives[`Java_fmod_javafmodJNI_${name.replaceAll('_', '_1')}`] = (...args) => {
            if (disposed) {
                throw new Error('FMOD owner disposed');
            }

            const result = lock.then(async () => {
                try {
                    if (ioFailure) {
                        throw ioFailure;
                    }

                    FMOD.setLastError(FMOD.OK);
                    const value = await operation(...args);

                    if (ioFailure) {
                        throw ioFailure;
                    }

                    const error = FMOD.getLastError();

                    if (error !== FMOD.OK) {
                        throw new Error(`Original ${name}: ${FMOD.errorString(error)} (${error})`);
                    }

                    return { value, callbacks: pendingCallbacks.splice(0) };
                } catch (error) {
                    return { error, callbacks: pendingCallbacks.splice(0) };
                }
            });

            lock = result.catch(() => undefined);

            const delivery = result.then(async ({ value, callbacks, error }) => {
                const failures = error ? [error] : [];

                // Java callbacks run after the SDK lock is released, permitting genuine reentrant calls.
                for (const entry of callbacks) {
                    try {
                        // eslint-disable-next-line no-await-in-loop -- Preserve actual native callback order.
                        await entry.callback[entry.method](...entry.args);
                        deliveredCallbacks++;
                    } catch (failure) {
                        failures.push(failure);
                    }
                }

                if (failures.length === 1) {
                    throw failures[0];
                }

                if (failures.length) {
                    throw new AggregateError(failures, 'FMOD operation/callback delivery failed');
                }

                return value;
            });

            deliveries.add(delivery);
            delivery.then(() => deliveries.delete(delivery), () => deliveries.delete(delivery));

            return delivery;
        };
    }

    return {
        natives,
        snapshot: () => ({ initialized, disposed, version, dspObjects: ownedDSPs.length, masterChannelGroup: Boolean(masterChannelGroup), handles: handles.size, rangeBytes, rangeReads, maxRangeBytes, openFiles, pendingCallbacks: pendingCallbacks.length, activeDeliveries: deliveries.size, deliveredCallbacks, audibleVerified: false }),
        async dispose() {
            /* The host calls teardown after the original VM has joined. Drain complete JNI
             * deliveries (including callbacks outside the SDK lock) before releasing the engine. */
            await Promise.allSettled([...deliveries]);
            disposed = true;
            await lock;

            for (const dsp of ownedDSPs) {
                dsp.release();
            }

            ownedDSPs.length = 0;
            masterChannelGroup = undefined;

            if (system) {
                await system.release();
            }

            system = undefined;
            core = undefined;
            initialized = false;

            for (const entry of handles.values()) {
                drop(entry.kind, entry.id);
            }

            pendingCallbacks.length = 0;
        },
    };
}
