/* eslint-disable jsdoc/require-jsdoc -- Internal public-SDK boundary helpers are owned by the FMOD runtime. */
import { createDescriptorRegistry, createInstanceRegistry } from './fmod20309-identities.js';

// Public 2.03 compatibility boundary: every stored result comes from an actual public SDK call.
export function createFmod20309Compat(F, fileOwner) {
    const descriptors = createDescriptorRegistry(F);
    const instances = createInstanceRegistry(F, descriptors);
    const metadata = new WeakMap();
    const wrappers = new Map();
    let lastResult = F.OK;
    let next = 2 ** 40;
    let masterChannelGroup;
    const record = (result) => {
        if (result !== F.OK || lastResult === F.OK) {
            lastResult = result;
        }

        return result;
    };

    const raw = (value) => metadata.get(value)?.object ?? value;
    const scalar = new Set(['getTimelinePosition', 'getPlaybackState', 'getBankCount', 'getEventCount', 'getLength',
        'getParameterDescriptionCount', 'getInstanceCount', 'getVCACount', 'getPaused', 'getMute', 'isPlaying', 'hasSustainPoint']);
    const resultOnly = new Set(['initialize', 'update', 'setOutput', 'setSoftwareFormat', 'set3DSettings', 'start',
        'loadSampleData', 'setVolume', 'setParameterByName', 'stop', 'release', 'flushCommands', 'set3DLevel',
        'set3DOcclusion', 'setPriority', 'setProperty', 'setPaused', 'setCallback', 'set3DMinMaxDistance', 'setMode',
        'setPitch', 'setReverbProperties', 'set3DAttributes', 'setChannelGroup', 'setNumListeners', 'setListenerAttributes',
        'setParameterByID', 'keyOff', 'setTimelinePosition', 'setMute', 'stopAllEvents']);
    const objectKinds = {
        getCoreSystem: 'core', createChannelGroup: 'channelGroup', getEvent: 'event', getVCA: 'vca',
        getBus: 'bus', getMasterChannelGroup: 'channelGroup', createDSPByType: 'dsp', playSound: 'channel',
    };
    const wrap = (object, kind, knownId) => {
        if (!object) {
            return object;
        }

        let id = knownId;

        if (id === undefined && ['bank', 'event', 'bus', 'vca'].includes(kind)) {
            const retained = descriptors.retain(kind, object);

            record(retained.result);

            if (retained.result !== F.OK) {
                return undefined;
            }

            id = retained.id;
        }

        if (id === undefined) {
            if (!Number.isSafeInteger(next) || next >= 2 ** 48) {
                throw new Error('FMOD object identity exhausted');
            }

            id = next++;
        }

        const key = `${kind}:${id}`;

        if (wrappers.has(key)) {
            return wrappers.get(key);
        }

        const wrapper = new Proxy({}, {
            get(_target, method) {
                if (method === 'then') {
                    return undefined;
                }

                if (typeof method !== 'string') {
                    return undefined;
                }

                return (...args) => {
                    if (kind === 'instance') {
                        object = instances.use('instance', id);
                    }

                    if (['bank', 'event', 'bus', 'vca'].includes(kind)) {
                        object = descriptors.use(kind, id);
                    }

                    args = args.map(raw);
                    const out = {};

                    if (method === 'getVersion') {
                        const build = {};

                        record(object.getVersion(out, build));

                        return { version: out.val, build: build.val };
                    }

                    if (method === 'getRecordNumDrivers') {
                        const connected = {};

                        record(object.getRecordNumDrivers(out, connected));

                        return { numdrivers: out.val, numconnected: connected.val };
                    }

                    if (method === 'getRecordDriverInfo') {
                        const name = {};
                        const guid = {};
                        const rate = {};
                        const mode = {};
                        const channels = {};
                        const state = {};

                        record(object.getRecordDriverInfo(args[0], name, guid, rate, mode, channels, state));

                        return { name: name.val, guid: guid.val, systemrate: rate.val, speakermode: mode.val, speakermodechannels: channels.val, state: state.val };
                    }

                    if (method === 'getVolume' || method === 'getParameterByName') {
                        const final = {};

                        if (method === 'getVolume' && ['channel', 'channelGroup'].includes(kind)) {
                            record(object.getVolume(out));
                        } else {
                            record(object[method](...args, out, final));
                        }

                        return method === 'getVolume' ? { volume: out.val, finalvolume: final.val } : { value: out.val, finalvalue: final.val };
                    }

                    if (method === 'getPath' || method === 'getParameterLabelByIndex') {
                        const retrieved = {};
                        const prefix = method === 'getPath' ? [] : args;
                        const result = object[method](...prefix, null, 0, retrieved);

                        if (result !== F.OK && result !== F.ERR_TRUNCATED) {
                            record(result);

                            return undefined;
                        }

                        if (!Number.isSafeInteger(retrieved.val) || retrieved.val <= 0) {
                            throw new Error('Invalid FMOD string extent');
                        }

                        record(object[method](...prefix, out, retrieved.val, retrieved));

                        return out.val;
                    }

                    if (method === 'getPosition') {
                        record(object.getPosition(out, args[0]));

                        return out.val;
                    }

                    if (method === 'getID' || method === 'getParameterDescriptionByIndex') {
                        record(object[method](...args, out));

                        return out.val;
                    }

                    if (scalar.has(method)) {
                        record(object[method](...args, out));

                        return out.val;
                    }

                    if (method === 'getMasterChannelGroup' && masterChannelGroup) {
                        return masterChannelGroup;
                    }

                    if (objectKinds[method]) {
                        record(object[method](...args, out));
                        const wrapped = lastResult === F.OK ? wrap(out.val, objectKinds[method]) : undefined;

                        if (method === 'getMasterChannelGroup') {
                            masterChannelGroup = wrapped;
                        }

                        return wrapped;
                    }

                    if (method === 'createInstance') {
                        const created = instances.create(id);

                        record(created.result);

                        return created.result === F.OK ? wrap(instances.use('instance', created.id), 'instance', created.id) : undefined;
                    }

                    if (method === 'getInstanceList') {
                        const result = instances.enumerate(id, args[0]);

                        record(result.result);

                        return result.result === F.OK ? result.ids.map((instanceId) => wrap(instances.use('instance', instanceId), 'instance', instanceId)) : undefined;
                    }

                    const listKinds = { getBankList: 'bank', getEventList: 'event', getVCAList: 'vca' };

                    if (listKinds[method] || method === 'getParameterDescriptionList') {
                        const count = {};

                        record(object[method](out, args[0], count));

                        if (lastResult !== F.OK) {
                            return undefined;
                        }

                        if (!Array.isArray(out.val) || out.val.length !== count.val) {
                            throw new Error('FMOD public list extent mismatch');
                        }

                        return listKinds[method] ? out.val.map((entry) => wrap(entry, listKinds[method])) : out.val;
                    }

                    if (method === 'createSound') {
                        if ((args[1] & (F.NONBLOCKING | F.OPENONLY)) !== 0) {
                            throw new Error('Public20309 nonblocking/open-only unbanked sound creation is not qualified');
                        }

                        const staged = fileOwner.stageSound(args[0]);
                        let result;

                        try {
                            result = object.createSound(staged.path, args[1], null, out);
                            record(result);

                            if (result !== F.OK) {
                                throw new Error(`Public FMOD createSound: ${F.ErrorString(result)} (${result})`);
                            }
                        } catch (error) {
                            staged.release();
                            throw error;
                        }

                        const wrapped = wrap(out.val, 'sound');

                        if ((args[1] & F.CREATESTREAM) !== 0) {
                            metadata.get(wrapped).staged = staged;
                        } else {
                            staged.release();
                        }

                        return wrapped;
                    }

                    if (method === 'loadBankFile') {
                        const info = fileOwner.bankInfo(args[0]);

                        record(object.loadBankCustom(info, args[1], out));

                        return lastResult === F.OK ? wrap(out.val, 'bank') : undefined;
                    }

                    if (method === 'setListenerAttributes' && args.length === 2) {
                        args.push(null);
                    }

                    if (method === 'release' && kind === 'instance') {
                        const entry = metadata.get(wrapper);

                        if (entry.callbackMask && !entry.stopRequested) {
                            const state = {};
                            const result = object.getPlaybackState(state);

                            record(result);

                            if (result !== F.OK) {
                                return undefined;
                            }

                            if (state.val !== F.STUDIO_PLAYBACK_STOPPED) {
                                throw new Error('Public20309 callback instance release while playing requires a prior stop request');
                            }
                        }

                        record(instances.release(id));

                        return undefined;
                    }

                    if (resultOnly.has(method)) {
                        const result = object[method](...args);

                        record(result);

                        if (kind === 'instance' && result === F.OK) {
                            if (method === 'setCallback') {
                                metadata.get(wrapper).callbackMask = args[1];
                            }

                            if (method === 'stop') {
                                metadata.get(wrapper).stopRequested = true;
                            }

                            if (method === 'start') {
                                metadata.get(wrapper).stopRequested = false;
                            }
                        }

                        if (method === 'release' && ['sound', 'dsp', 'channelGroup'].includes(kind) && result === F.OK) {
                            metadata.get(wrapper).staged?.release();
                            wrappers.delete(key);
                            metadata.delete(wrapper);
                        }

                        if (method === 'release' && kind === 'system' && result === F.OK) {
                            fileOwner.dispose();
                            descriptors.clear();
                            instances.clear();
                            wrappers.clear();
                            masterChannelGroup = undefined;
                        }

                        return undefined;
                    }

                    throw new Error(`Unimplemented public20309 method: ${kind}.${method}`);
                };
            },
        });

        metadata.set(wrapper, { object, kind, id, callbackMask: 0, stopRequested: false });
        wrappers.set(key, wrapper);

        return wrapper;
    };

    return new Proxy(F, {
        get(target, name) {
            if (name === 'getLastError') {
                return () => lastResult;
            }

            if (name === 'setLastError') {
                return (result) => {
                    if (result !== F.OK) {
                        throw new Error('Only explicit bridge error acknowledgement is supported');
                    }

                    lastResult = F.OK;
                };
            }

            if (name === 'errorString') {
                return F.ErrorString;
            }

            if (name === 'retirePublicOwners') {
                return () => {
                    const retired = [];

                    for (const [key, wrapper] of wrappers) {
                        const entry = metadata.get(wrapper);
                        let invalid = entry.kind === 'instance' && !entry.object.isValid();

                        if (entry.kind === 'channel') {
                            const playing = {};
                            const result = entry.object.isPlaying(playing);

                            invalid = result === F.ERR_INVALID_HANDLE || result === F.ERR_CHANNEL_STOLEN;

                            if (result !== F.OK && !invalid) {
                                throw new Error(`FMOD channel lifetime query: ${F.ErrorString(result)}`);
                            }
                        }

                        if (invalid) {
                            wrappers.delete(key);
                            metadata.delete(wrapper);
                            retired.push({ kind: entry.kind, id: BigInt(entry.id) });
                        }
                    }

                    instances.prune();

                    return retired;
                };
            }

            if (name === 'publicOwnerId') {
                return (kind, object) => {
                    const entry = metadata.get(object);

                    if (!entry || entry.kind !== kind) {
                        throw new Error('Unknown public FMOD owner');
                    }

                    return BigInt(entry.id);
                };
            }

            if (name === 'Studio_System_Create') {
                return () => {
                    const out = {};

                    record(F.Studio_System_Create(out));

                    return lastResult === F.OK ? wrap(out.val, 'system') : undefined;
                };
            }

            return target[name];
        },
    });
}
