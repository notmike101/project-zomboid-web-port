const resourceBase = 'https://cjrtnc.leaningtech.com/4.3';
const runtimeSha = '6b87e309d08bef334783b7e663f5e7a40cad1a740cc594401ec6fb26f2766a17';
const moduleSha = 'd59f0db67d1fc1e9f0c36046e75f47c663024ecfd87e508032084c38ecb07577';
const functionSha = '7dd431da5a167f01e4c1581e87c858e2bfbcace51ee46187e9d82e003fa54c7b';
let startPromise;
let startOptions;

/**
 * Computes a browser SHA-256 digest before evaluating derived runtime code.
 *
 * @param {ArrayBuffer|Uint8Array} bytes - Exact source bytes.
 * @returns {Promise<string>} Hex digest.
 */
async function digest(bytes) {
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (value) => value.toString(16).padStart(2, '0')).join('');
}

/**
 * Fetches a required same-origin derived asset.
 *
 * @param {string} name - Fixed derived file name.
 * @returns {Promise<Response>} Successful HTTP response.
 */
async function required(name) {
    const response = await fetch(`/scheduler-runtime/${name}`, { cache: 'no-store' });

    if (!response.ok) {
        throw new Error(`Derived scheduler asset missing before VM startup: ${name}`);
    }

    return response;
}

/**
 * Validates the real loader state and derived assets, then executes its original
 * initialization body with the single qualified runtime import substitution.
 *
 * @param {object} options - Unmodified CheerpJ initialization options.
 * @returns {Promise<void>} Actual runtime initialization completion.
 */
async function initialize(options) {
    const manifest = await (await required('manifest.json')).json();
    const [runtime, loader] = await Promise.all(['cj3.js', 'load-function.js'].map(async (name) => (await required(name)).arrayBuffer()));
    const actualFunction = globalThis.cj3LoadImpl;

    if (manifest.resourceBase !== resourceBase || manifest.loadFunctionSha !== functionSha || typeof actualFunction !== 'function' || await digest(new TextEncoder().encode(actualFunction.toString())) !== functionSha || globalThis.cj3LoaderPath !== resourceBase || globalThis.cj3Module !== null || globalThis.cj3Loaded !== 0) {
        throw new Error('Unqualified scheduler loader state before VM startup');
    }

    if (await digest(runtime) !== runtimeSha || manifest.runtimeOutputSha !== runtimeSha || await digest(loader) !== moduleSha || manifest.loaderModuleSha !== moduleSha || JSON.stringify(manifest.modifiedBodies) !== '["an1","anV","e5"]') {
        throw new Error('Derived scheduler asset mismatch before VM startup');
    }

    const moduleUrl = '/scheduler-runtime/load-function.js';
    const derived = await import(moduleUrl);

    if (globalThis.window) {
        globalThis.cj3AttachBodyObserver(false, globalThis.cj3InitOptions);
    }

    await derived.default(options);
}

/**
 * Starts the pinned scheduler runtime once, retaining actual loader exports and
 * CDN WASM/JRE loading. Install existing runtime repairs after this resolves.
 *
 * @param {object} options - Actual CheerpJ initialization options.
 * @returns {Promise<void>} Shared initialization promise.
 */
export function startSchedulerRuntime(options) {
    if (startPromise) {
        if (options !== startOptions) {
            throw new Error('Scheduler runtime already started with different options');
        }

        return startPromise;
    }

    startOptions = options;
    startPromise = initialize(options);

    return startPromise;
}
