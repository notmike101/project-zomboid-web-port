/* eslint-disable jsdoc/require-jsdoc -- Private callbacks are owned by the documented runtime loader. */
import { createFmodNatives } from './fmod-natives.js';

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
 * @returns {Promise<object>} Real FMOD JNI owner.
 */
export function loadFmodRuntime(manifestSHA) {
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

        const script = await get('fmodstudioL.js');
        const wasm = await get('fmodstudioL.wasm');

        if (await digest(script) !== manifest.scriptSHA || await digest(wasm) !== manifest.wasmSHA) {
            throw new Error('FMOD SDK identity mismatch');
        }

        const url = URL.createObjectURL(new Blob([script], { type: 'text/javascript' }));
        let FMOD;

        try {
            const { default: createFMOD } = await import(url);

            FMOD = await createFMOD({ wasmBinary: wasm, INITIAL_MEMORY: 64 * 1_024 * 1_024 });
        } finally {
            URL.revokeObjectURL(url);
        }

        const presetBytes = await get('reverb-presets.json');

        if (await digest(presetBytes) !== manifest.presetSHA) {
            throw new Error('FMOD preset identity mismatch');
        }

        const presets = JSON.parse(new TextDecoder().decode(presetBytes));
        const bankURL = (name) => {
            const path = String(name).replace(/^\/app(?=\/media\/)/u, '');

            if (!/^\/?media\/(?:sound|music)\/[A-Za-z0-9_./ -]+\.(?:bank|ogg|wav|mp3|flac)$/iu.test(path) || path.split('/').includes('..')) {
                throw new Error('Unowned FMOD bank path');
            }

            return new URL(path.startsWith('/') ? path : `/${path}`, location.origin).href;
        };

        const audio = createFmodNatives(FMOD, {
            async size(name) {
                const response = await fetch(bankURL(name), { method: 'HEAD', cache: 'no-store' });

                if (!response.ok) {
                    throw new Error(`Original bank metadata unavailable: ${name}`);
                }

                return Number(response.headers.get('Content-Length'));
            },
            async read(name, start, length) {
                const response = await fetch(bankURL(name), { headers: { Range: `bytes=${start}-${start + length - 1}` }, cache: 'no-store' });
                const range = response.headers.get('Content-Range');

                if (response.status !== 206 || !range?.startsWith(`bytes ${start}-${start + length - 1}/`)) {
                    throw new Error('Original bank range response mismatch');
                }

                return new Uint8Array(await response.arrayBuffer());
            },
        }, null, presets);
        let resumeFailure = null;
        let trustedResumeAt = null;
        const resume = (event) => {
            // context is the actual AudioContext exposed by this pinned supplied SDK.
            if (event.isTrusted && FMOD.context?.state === 'suspended') {
                trustedResumeAt = Date.now();
                void FMOD.context.resume().catch((error) => {
                    resumeFailure = String(error);
                });
            }
        };

        globalThis.addEventListener('pointerdown', resume);
        globalThis.addEventListener('keydown', resume);
        const snapshot = audio.snapshot;
        const dispose = audio.dispose;

        audio.snapshot = () => ({ ...snapshot(), audioContextState: FMOD.context?.state ?? 'uninitialized', trustedResumeAt, resumeFailure });
        audio.dispose = async () => {
            globalThis.removeEventListener('pointerdown', resume);
            globalThis.removeEventListener('keydown', resume);
            await dispose();
        };

        return audio;
    })();

    return owner;
}
