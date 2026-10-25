/* eslint-disable jsdoc/require-jsdoc -- JNI table names retain the installed Java signatures; the owner contract is documented below. */
const arrayLength = async (lib, destination) => destination instanceof BigInt64Array
    ? destination.length
    : (await lib.port.host.FmodArrays).arrayLength(destination);

/**
 * Owns actual FMOD Studio objects behind the original javafmod JNI identities.
 * Unimplemented original entry points remain absent; no silent audio replacement.
 *
 * @param {object} FMOD - Initialized supplied official HTML5 FMOD module.
 * @param {object} files - Actual bounded file-range provider.
 * @param {function(string): Promise<number>} files.size - Actual original file length.
 * @param {function(string, number, number): Promise<Uint8Array>} files.read - Actual requested bytes.
 * @param {number|null} [output] - Explicit data-only oracle output; browser default is unchanged.
 * @returns {object} Original JNI callbacks and owned engine teardown.
 */
export function createFmodNatives(FMOD, files, output = null) {
    const handles = new Map();
    let next = 1n;
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
    // Original integration 0x18000b7b0..b85e keeps the last listener attributes globally.
    let listenerAttributes = {
        position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 },
        forward: { x: 0, y: 0, z: 0 }, up: { x: 0, y: 0, z: 0 },
    };

    const retain = (kind, object) => {
        if (!object) {
            throw new Error(`FMOD returned no ${kind}: ${FMOD.getLastError()}`);
        }

        const id = next++;

        handles.set(id, { kind, object });

        return id;
    };

    const use = (id, kind) => {
        const entry = handles.get(BigInt(id));

        if (!entry || entry.kind !== kind) {
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

    const operations = {
        FMOD_System_Create() {
            if (system) {
                throw new Error('FMOD system already owned');
            }

            system = FMOD.Studio_System_Create();
            core = system.getCoreSystem();
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
            const length = await files.size(path);

            if (!Number.isSafeInteger(length) || length < 0 || length > 0xFF_FF_FF_FF) {
                throw new Error('Invalid actual FMOD file length');
            }

            const info = {
                userdata: path,
                opencallback() {
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
            const bank = await requireSystem().loadBankCustom(info, FMOD.STUDIO_LOAD_BANK_NORMAL);

            return retain('bank', bank);
        },
        FMOD_Studio_GetEvent(_lib, path) {
            return retain('event', requireSystem().getEvent(String(path)));
        },
        FMOD_Studio_CreateEventInstance(_lib, id) {
            return retain('instance', use(id, 'event').createInstance());
        },
        FMOD_Studio_StartEvent(_lib, id) {
            use(id, 'instance').start();
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
        FMOD_Studio_EventInstance_Stop(_lib, id, immediate) {
            use(id, 'instance').stop(immediate ? FMOD.STUDIO_STOP_IMMEDIATE : FMOD.STUDIO_STOP_ALLOWFADEOUT);

            return FMOD.OK;
        },
        FMOD_Studio_ReleaseEventInstance(_lib, id) {
            use(id, 'instance').release();
            handles.delete(BigInt(id));

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
            handles.delete(BigInt(id));
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

                return value;
            });

            lock = result.catch(() => undefined);

            return result;
        };
    }

    return {
        natives,
        snapshot: () => ({ initialized, disposed, version, handles: handles.size, rangeBytes, rangeReads, maxRangeBytes, openFiles, audibleVerified: false }),
        async dispose() {
            disposed = true;
            await lock;

            if (system) {
                await system.release();
            }

            system = undefined;
            core = undefined;
            initialized = false;
            handles.clear();
        },
    };
}
