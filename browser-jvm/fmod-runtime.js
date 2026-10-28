/* eslint-disable jsdoc/require-jsdoc -- Private callbacks are owned by the documented runtime loader. */
import { createFmodNatives } from './fmod-natives.js';
import { createOwnedAudioContexts } from './fmod-owned-audio.js';

let owner;
const digest = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (value) => value.toString(16).padStart(2, '0')).join('');

/**
 * Returns the already admitted real combined Studio/Core native owner.
 *
 * @returns {Promise<object>} Actual admitted owner.
 */
export function getFmodOwner() {
    if (!owner) {
        throw new Error('FMOD runtime must be admitted before original native-library loading');
    }

    return owner;
}

/**
 * Loads only the explicitly admitted official runtime, without changing its output backend.
 *
 * @param {string} manifestSHA - Frozen generation's SDK manifest identity.
 * @param {Array<object>|null} [bankFiles] - Audio entries from the verified complete media namespace.
 * @returns {Promise<object>} Real FMOD JNI owner.
 */
export function loadFmodRuntime(manifestSHA, bankFiles = null) {
    if (owner) {
        return owner;
    }

    owner = (async () => {
        const get = async (name) => {
            const response = await fetch(`/fmod-runtime/${name}`, { cache: 'no-store' });

            if (!response.ok) {
                throw new Error(`FMOD runtime file unavailable: ${name}`);
            }

            return new Uint8Array(await response.arrayBuffer());
        };

        const manifestBytes = await get('manifest.json');

        if (await digest(manifestBytes) !== manifestSHA) {
            throw new Error('FMOD manifest identity mismatch');
        }

        const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));

        if (manifest.schema !== 'fmod-html5-runtime-v1') {
            throw new Error('Unsupported FMOD runtime manifest');
        }

        const expectedVersion = manifest.versionHex ?? (manifest.version === '2.04.00' ? 0x2_04_00 : undefined);
        const is203 = manifest.version === '2.03.09' && expectedVersion === 0x2_03_09;

        if (!is203 && !(manifest.version === '2.04.00' && expectedVersion === 0x2_04_00)) {
            throw new Error('Unadmitted FMOD version pair');
        }

        if (is203 && !Array.isArray(bankFiles)) {
            throw new Error('Public20309 requires the complete verified audio namespace');
        }

        const audioContexts = is203 ? createOwnedAudioContexts() : null;

        const script = await get('fmodstudioL.js');
        const wasm = await get('fmodstudioL.wasm');

        if (await digest(script) !== manifest.scriptSHA || await digest(wasm) !== manifest.wasmSHA) {
            throw new Error('FMOD SDK identity mismatch');
        }

        const url = URL.createObjectURL(new Blob([script], { type: 'text/javascript' }));
        let FMOD;

        try {
            const { default: createFMOD } = await import(url);

            const options = {
                wasmBinary: wasm,
                INITIAL_MEMORY: 64 * 1_024 * 1_024,
                locateFile(name) {
                    if (name !== 'fmodstudioL.wasm') {
                        throw new Error(`Unadmitted FMOD runtime file: ${name}`);
                    }

                    return new URL(`/fmod-runtime/${name}`, location.origin).href;
                },
            };

            if (is203) {
                FMOD = await new Promise((resolve, reject) => {
                    options.onRuntimeInitialized = () => resolve(options);
                    options.onAbort = (reason) => reject(new Error(String(reason)));
                    const created = createFMOD(options);

                    if (typeof created?.then === 'function') {
                        created.then(undefined, reject);
                    }
                });
            } else {
                FMOD = await createFMOD(options);
            }
        } finally {
            URL.revokeObjectURL(url);
        }

        const presetBytes = await get('reverb-presets.json');

        if (await digest(presetBytes) !== manifest.presetSHA) {
            throw new Error('FMOD preset identity mismatch');
        }

        const presets = JSON.parse(new TextDecoder().decode(presetBytes));
        const bankCatalog = bankFiles === null ? null : new Map(bankFiles.map(({ path, bytes }) => [path.toLowerCase(), { path, bytes }]));
        const bankURL = (name) => {
            const path = String(name).replace(/^\/app(?=\/media\/)/u, '');

            if (!/^\/?media\/(?:sound|music)\/[A-Za-z0-9_./ -]+\.(?:bank|ogg|wav|mp3|flac)$/iu.test(path) || path.split('/').includes('..')) {
                throw new Error('Unowned FMOD bank path');
            }

            const url = new URL(path.startsWith('/') ? path : `/${path}`, location.origin);
            const known = bankCatalog?.get(decodeURIComponent(url.pathname).toLowerCase());

            return known ? new URL(known.path, location.origin).href : url.href;
        };

        const knownAudio = (name) => {
            const url = bankURL(name);

            return { url, entry: bankCatalog.get(decodeURIComponent(new URL(url).pathname).toLowerCase()) };
        };

        const bankBudget = bankCatalog
            ? [...bankCatalog.values()].filter((entry) => /\.bank$/iu.test(entry.path))
                    .reduce((sum, entry) => sum + entry.bytes, 0)
            : 0;
        const audio = createFmodNatives(FMOD, {
            bankBudget,
            canonicalPath(name) {
                return decodeURIComponent(new URL(bankURL(name)).pathname);
            },
            sizeSync(name) {
                return knownAudio(name).entry?.bytes ?? null;
            },
            readSync(name, start, length) {
                const { url, entry } = knownAudio(name);

                if (!entry || !Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length <= 0
                    || length > 65_536 || start + length > entry.bytes) {
                    throw new Error('Unowned public20309 audio range');
                }

                const xhr = new XMLHttpRequest();

                xhr.open('GET', url, false);
                xhr.overrideMimeType('text/plain; charset=x-user-defined');
                xhr.setRequestHeader('Range', `bytes=${start}-${start + length - 1}`);
                xhr.send();

                if (xhr.status !== 206 || xhr.getResponseHeader('Content-Range') !== `bytes ${start}-${start + length - 1}/${entry.bytes}`
                    || xhr.responseText.length !== length) {
                    throw new Error('Public20309 audio range response mismatch');
                }

                return Uint8Array.from(xhr.responseText, (character) => character.charCodeAt(0) & 255);
            },
            async size(name) {
                const url = bankURL(name);
                const path = decodeURIComponent(new URL(url).pathname);
                const known = bankCatalog?.get(path.toLowerCase());

                /* The already-verified complete namespace distinguishes missing optional banks
                 * from a present bank whose route/read has actually failed. */
                if (bankCatalog && path.toLowerCase().endsWith('.bank') && !known) {
                    return null;
                }

                const response = await fetch(url, { method: 'HEAD', cache: 'no-store' });

                if (!response.ok) {
                    throw new Error(`Original bank metadata unavailable: ${name}`);
                }

                const length = Number(response.headers.get('Content-Length'));

                if (known && length !== known.bytes) {
                    throw new Error('Original bank metadata differs from the verified namespace');
                }

                return length;
            },
            async read(name, start, length) {
                const response = await fetch(bankURL(name), { headers: { Range: `bytes=${start}-${start + length - 1}` }, cache: 'no-store' });
                const range = response.headers.get('Content-Range');

                if (response.status !== 206 || !range?.startsWith(`bytes ${start}-${start + length - 1}/`)) {
                    throw new Error('Original bank range response mismatch');
                }

                return new Uint8Array(await response.arrayBuffer());
            },
        }, null, presets, expectedVersion, audioContexts);
        let resumeFailure = null;
        let trustedResumeAt = null;
        const resume = (event) => {
            if (is203) {
                if (event.isTrusted) {
                    try {
                        if (audio.resumeAudio() !== false) {
                            trustedResumeAt = Date.now();
                        }
                    } catch (error) {
                        resumeFailure = String(error);
                    }
                }

                return;
            }

            // The pinned SDK uses mContext for AudioWorklet and context for ScriptProcessor.
            const context = FMOD.mContext ?? FMOD.context;

            if (event.isTrusted && context && (context.state === 'suspended' || FMOD.mInputRegistered)) {
                trustedResumeAt = Date.now();
                const resumeDriver = FMOD.OutputAudioWorklet_resumeAudio ?? FMOD.OutputWebAudio_resumeAudio;

                // The SDK hook also installs/connects its actual output processor.
                resumeDriver?.();
                void context.resume().catch((error) => {
                    resumeFailure = String(error);
                });
            }
        };

        globalThis.addEventListener('pointerdown', resume);
        globalThis.addEventListener('keydown', resume);
        const snapshot = audio.snapshot;
        const dispose = audio.dispose;

        audio.snapshot = () => ({
            ...snapshot(),
            ...(is203
                ? {
                        audioContexts: audioContexts.snapshot(),
                        audioContextState: audioContexts.snapshot().findLast((context) => context.state !== 'closed')?.state ?? 'uninitialized',
                        audioBackend: snapshot().outputType === FMOD.OUTPUTTYPE_AUDIOWORKLET ? 'AudioWorklet' : 'uninitialized',
                        workletReady: null,
                        trustedResumeAt,
                        resumeFailure,
                    }
                : {}),
            ...(!is203
                ? {
                        audioContextState: (FMOD.mContext ?? FMOD.context)?.state ?? 'uninitialized',
                        audioBackend: (FMOD.mContext && 'AudioWorklet') || (FMOD.context && 'ScriptProcessor') || 'uninitialized',
                        workletReady: Boolean(FMOD.mWorkletNode) && !FMOD.mModulePolling,
                        trustedResumeAt,
                        resumeFailure,
                    }
                : {}),
        });
        audio.dispose = async () => {
            globalThis.removeEventListener('pointerdown', resume);
            globalThis.removeEventListener('keydown', resume);
            await dispose();
        };

        return audio;
    })();

    return owner;
}
