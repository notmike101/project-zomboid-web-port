import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const schedulerPins = Object.freeze({
    resourceBase: 'https://cjrtnc.leaningtech.com/4.3',
    runtimeInputSha: '5bcf00711009cbb12b858dcbea865cfe0e9d652cfc95f55ad20a600724462644',
    loaderInputSha: '5b0ec873d1ae97d184928041b5f97ecf36eb990dac3baec5836a90bd87fa7a9f',
    loadFunctionSha: '7dd431da5a167f01e4c1581e87c858e2bfbcace51ee46187e9d82e003fa54c7b',
});

const original = 'function an1(h){var f=null,c=0,a=null;a=Q;f=a.a7;c=a.i1|0;a.i1=c+1|0;a=a.a0;a[0+c|0]=f;return c|0;}';
const replacement = 'function an1(h){var f=null,c=0,a=null;a=Q;f=a.a7;c=a.i1|0;a.i1=c+1|0;a=a.a0;a[0+c|0]=f;if(+Date.now()- +$.d7>16){a1({p:h,f:7,pc:73,a:null,o:0});Q.a8=c;throw "CheerpJContinue";}return c|0;}';
const yieldOriginal = 'function anV(a){a1({p:a,f:7,pc:86,a:null,o:0});throw \'CheerpJContinue\';}';
// An immediately due scheduler event makes OL select another runnable thread without a Java sleep or interrupt change.
const yieldReplacement = 'function anV(a){Q.d16=+Date.now();Q.i20=Q.i20&65280|2;a1({p:a,f:7,pc:86,a:null,o:0});throw \'CheerpJContinue\';}';

/**
 * Computes a byte-exact digest.
 *
 * @param {Buffer|string} bytes - Source bytes.
 * @returns {string} SHA-256 digest.
 */
function digest(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Replaces exactly one qualified source occurrence.
 *
 * @param {string} source - Original source.
 * @param {string} before - Required single occurrence.
 * @param {string} after - Replacement source.
 * @returns {string} Derived source.
 */
function replaceOne(source, before, after) {
    if (source.split(before).length !== 2) {
        throw new Error('Scheduler source body guard failed');
    }

    return source.replace(before, after);
}

/**
 * Derives the narrowly qualified runtime without changing any other runtime body.
 *
 * @param {Buffer} runtime - Original pinned runtime bytes.
 * @param {Buffer} loader - Original pinned loader bytes.
 * @returns {object} Derived runtime, loader module, and provenance manifest.
 */
export function deriveSchedulerRuntime(runtime, loader) {
    if (digest(runtime) !== schedulerPins.runtimeInputSha || digest(loader) !== schedulerPins.loaderInputSha) {
        throw new Error('Unqualified scheduler runtime or loader SHA-256');
    }

    const loaderSource = loader.toString('utf8');
    const start = loaderSource.indexOf('function cj3LoadImpl(options)');
    const end = loaderSource.indexOf('\nfunction cj3StartApplets()', start);
    const loadFunction = loaderSource.slice(start, end).trim();

    if (digest(loadFunction) !== schedulerPins.loadFunctionSha) {
        throw new Error('Unqualified scheduler loader function');
    }

    const runtimeSource = replaceOne(replaceOne(runtime.toString('utf8'), original, replacement), yieldOriginal, yieldReplacement);
    const loaderModule = `// Copyright 2017-2022 Leaning Technologies Ltd\n// Derived from the pinned official CheerpJ 4.3 loader; only its runtime import URI changes.\nexport default ${replaceOne(loadFunction, 'import(cj3LoaderPath + "/cj3.js")', 'import("/scheduler-runtime/cj3.js")')}\n`;
    const manifest = { ...schedulerPins, runtimeOutputSha: digest(runtimeSource), loaderModuleSha: digest(loaderModule), modifiedBodies: ['an1', 'anV'] };

    return { runtimeSource, loaderModule, manifest };
}

/**
 * Downloads pinned official sources and writes deterministic ignored derived assets.
 * Validation completes before any output file is written.
 *
 * @param {string} outputDirectory - Owned ignored output directory.
 * @returns {Promise<object>} Source and derived digests.
 */
export async function prepareSchedulerRuntime(outputDirectory) {
    const responses = await Promise.all(['cj3.js', 'loader.js'].map((name) => fetch(`${schedulerPins.resourceBase}/${name}`, { signal: AbortSignal.timeout(30_000) })));

    if (responses.some((response) => !response.ok)) {
        throw new Error('Pinned scheduler source download failed');
    }

    const [runtime, loader] = await Promise.all(responses.map(async (response) => Buffer.from(await response.arrayBuffer())));
    const derived = deriveSchedulerRuntime(runtime, loader);

    await mkdir(outputDirectory, { recursive: true });
    await writeFile(path.join(outputDirectory, 'cj3.js'), derived.runtimeSource);
    await writeFile(path.join(outputDirectory, 'load-function.js'), derived.loaderModule);
    await writeFile(path.join(outputDirectory, 'manifest.json'), `${JSON.stringify(derived.manifest, null, 2)}\n`);

    return derived.manifest;
}

export { schedulerPins };
