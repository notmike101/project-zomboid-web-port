/**
 * Exercise the real app/manager/VM/save path with independently authored Lua.
 * Run on an owned disposable browser profile/origin with provisioned content and a known sourceBuild.
 * No original source, assets or pixels leave the page; only synthetic namespace metadata is returned.
 *
 * @param {object} context - Browser runner context.
 * @param {object} context.page - Puppeteer page on the provisioned application.
 * @param {function(boolean,string):void} context.assert - Assertion callback.
 * @returns {Promise<object>} Consumer-visible metadata evidence.
 */
export async function checkNativePackageReload({ page, assert }) {
    const originalUrl = page.url();
    const manifestUrl = new URL('content/manifest.json', originalUrl).href;
    const manifest = await page.evaluate(async (url) => (await fetch(url)).json(), manifestUrl);

    if (!/^\d+(?:\.\d+)*$/u.test(manifest.sourceBuild.version)) {
        throw new Error('Proof requires the observed sourceBuild already provisioned; it never invents a game version.');
    }

    const root = 'mods/NativeLoaderProof';
    const files = {
        [`${root}/mod.info`]: 'id=NativeLoaderProof\nname=Owned Native Loader Proof\nmodversion=proof-a\n',
        [`${root}/media/lua/client/Proof.lua`]: `
            local player = getPlayer()
            local data = player:getModData()
            local ready=false
            assert(require("NativeProofEngine"))
            data.NativeLoaderProof = data.NativeLoaderProof or {ticks=0, creates=0, loads=0, starts=0}
            Events.OnTick.Add(function() assert(ready, "committed closure initialization was lost"); data.NativeLoaderProof.ticks=data.NativeLoaderProof.ticks+1; player:walk(1,0) end)
            Events.OnCreatePlayer.Add(function() data.NativeLoaderProof.creates=data.NativeLoaderProof.creates+1 end)
            Events.OnLoad.Add(function() assert(not data.NativeLoaderProof.failLoad, "owned load failure"); data.NativeLoaderProof.loads=data.NativeLoaderProof.loads+1 end)
            Events.OnGameStart.Add(function() ready=true; data.NativeLoaderProof.starts=data.NativeLoaderProof.starts+1 end)
            Events.OnKeyPressed.Add(function(key)
                if key==119 then data.NativeLoaderProof.failLoad=true end
                if key==120 then data.NativeLoaderProof.failLoad=false end
            end)
        `,
        'media/lua/shared/NativeProofEngine.lua': 'return true',
    };

    manifest.mods.push({ root, kind: 'native-lua', files: Object.keys(files).filter((path) => path.startsWith(`${root}/`)) });
    manifest.files.push(...Object.entries(files).map(([path, source]) => ({ path, size: new TextEncoder().encode(source).length, lastModified: 0 })));
    const id = 'native-nativeloaderproof';
    const responses = new Map(Object.entries(files).map(([path, source]) => [new URL(path, new URL('./', manifestUrl)).href, new TextEncoder().encode(source)]));
    const engineUrl = new URL('media/lua/shared/NativeProofEngine.lua', new URL('./', manifestUrl)).href;
    let postponeEngine = false;
    let engineGate;
    let engineWaiter;
    let releaseEngine;

    /**
     * Serve only independently authored extra package bytes over the real range protocol.
     *
     * @param {object} request - Intercepted browser request.
     * @returns {Promise<void>} Completed request handling.
     */
    async function intercept(request) {
        if (request.url() === manifestUrl) {
            await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(manifest) });

            return;
        }

        const source = responses.get(request.url());

        if (source) {
            const match = /^bytes=(\d+)-(\d+)$/u.exec(request.headers().range ?? '');

            if (!match) {
                await request.respond({ status: 416 });

                return;
            }

            if (postponeEngine && request.url() === engineUrl) {
                engineWaiter();
                await engineGate;
            }

            const start = Number(match[1]);
            const end = Number(match[2]);

            await request.respond({ status: 206, headers: { 'content-range': `bytes ${start}-${end}/${source.length}` }, body: Buffer.from(source.slice(start, end + 1)) });

            return;
        }

        await request.continue();
    }

    /**
     * Wait for a ready game or an honestly blocked save/version mismatch.
     *
     * @returns {Promise<object>} Current metadata.
     */
    async function settled() {
        await page.waitForFunction(() => {
            const value = JSON.parse(document.querySelector('#diagnostics').textContent || '{}');

            return value.sessionReady || value.startup === 'blocked';
        }, { timeout: 120_000, polling: 100 });

        return page.$eval('#diagnostics', (element) => JSON.parse(element.textContent));
    }

    /**
     * Read the committed synthetic namespace, never original world bytes.
     *
     * @returns {Promise<object>} Save metadata.
     */
    function saved() {
        return page.evaluate(async (modId) => {
            const db = await new Promise((resolve, reject) => {
                const request = indexedDB.open('pz-web-saves', 1);

                request.addEventListener('success', () => resolve(request.result));
                request.addEventListener('error', () => reject(request.error));
            });

            try {
                return await new Promise((resolve, reject) => {
                    const request = db.transaction('saves').objectStore('saves').get('autosave');

                    request.addEventListener('success', () => {
                        const record = request.result?.current;

                        resolve(record ? { revision: record.revision, mods: record.mods, namespace: record.modState[modId]?.data.nativePlayerData.NativeLoaderProof } : null);
                    });
                    request.addEventListener('error', () => reject(request.error));
                });
            } finally {
                db.close();
            }
        }, id);
    }

    /**
     * Open only the existing hidden keyboard-accessible menu.
     *
     * @returns {Promise<void>} Menu readiness.
     */
    async function menu() {
        if (!await page.$eval('#pause-menu', (element) => element.open)) {
            await page.keyboard.press('Escape');
        }

        await page.waitForFunction(() => document.querySelector('#pause-menu').open, { polling: 100 });
    }

    /**
     * Change persisted consent through the actual existing checkbox.
     *
     * @param {boolean} value - Desired enabled flag.
     * @returns {Promise<void>} Persisted configuration.
     */
    async function enable(value) {
        await menu();
        await page.evaluate((desired) => {
            const item = [...document.querySelectorAll('#package-list li')].find((element) => element.textContent.includes('Owned Native Loader Proof'));
            const input = item?.querySelector('input');

            if (!input) {
                throw new Error('Native package enable checkbox was not discovered');
            }

            input.checked = desired;
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }, value);
        await page.waitForFunction((desired) => {
            const evidence = JSON.parse(document.querySelector('#diagnostics').textContent);

            return evidence.packages.packages.find((entry) => entry.id === 'native-nativeloaderproof')?.enabled === desired;
        }, { polling: 100 }, value);
    }

    /**
     * Capture live Lua data through the actual app Save action.
     *
     * @returns {Promise<object>} Committed namespace metadata.
     */
    async function commit() {
        await menu();
        const previous = (await saved())?.revision ?? 0;

        await page.click('#save-now');
        await page.waitForFunction((revision) => JSON.parse(document.querySelector('#diagnostics').textContent).savedRevision > revision, { polling: 100 }, previous);

        return saved();
    }

    await page.setRequestInterception(true);
    page.on('request', intercept);
    try {
        await page.reload({ waitUntil: 'domcontentloaded' });
        const discovered = await settled();

        assert(discovered.sessionReady && !discovered.failed, 'Default directory startup must remain playable');
        assert(discovered.packages.packages.find((entry) => entry.id === id)?.enabled === false, 'New native code must be discovered disabled on a disposable profile');
        assert(!discovered.mods.mods.some((entry) => entry.id === id), 'Discovery must not execute Lua');
        await enable(true);
        await page.reload({ waitUntil: 'domcontentloaded' });
        const activated = await settled();

        assert(activated.sessionReady && activated.mods.mods.some((entry) => entry.id === id), 'Enabling must activate unchanged Lua through the real host');
        await page.waitForFunction(() => JSON.parse(document.querySelector('#diagnostics').textContent).engine.action === 2, { polling: 100 });
        const before = await commit();

        assert(before.namespace.ticks > 0 && before.namespace.creates === 1 && before.namespace.starts === 1 && before.namespace.loads === 0, 'Native event must change real WASM action and live Lua tables must be committed');
        await page.reload({ waitUntil: 'domcontentloaded' });
        const restored = await settled();

        assert(restored.sessionReady, 'Exact native version save must reload');
        const after = await commit();

        assert(after.namespace.ticks >= before.namespace.ticks && after.namespace.creates === 2 && after.namespace.starts === 2 && after.namespace.loads === 1, 'Save reload must restore tables and bootstrap each real transition exactly once');

        // A delayed real engine-source fetch leaves consent controls locked throughout staging.
        await page.keyboard.press('Escape');
        await page.keyboard.press('F8');
        const failingSave = await commit();

        assert(failingSave.namespace.failLoad === true, 'Focused real key event must mark the owned load-failure fixture');
        postponeEngine = true;
        const engineArrived = new Promise((resolve) => {
            engineWaiter = resolve;
        });

        engineGate = new Promise((resolve) => {
            releaseEngine = resolve;
        });
        await page.click('#load-save');
        await engineArrived;
        const locked = await page.evaluate(() => {
            const controls = document.querySelector('#package-controls');
            const item = [...document.querySelectorAll('#package-list li')].find((element) => element.textContent.includes('Owned Native Loader Proof'));
            const input = item.querySelector('input');

            input.checked = false;
            input.dispatchEvent(new Event('change', { bubbles: true }));

            return controls.disabled;
        });

        assert(locked, 'Consent controls must be disabled while native activation is awaiting source data');
        releaseEngine();
        postponeEngine = false;
        await page.waitForFunction(() => !document.querySelector('#session-controls').disabled && document.querySelector('#save-status').textContent.includes('owned load failure'), { polling: 100 });
        const rollback = await page.$eval('#diagnostics', (element) => JSON.parse(element.textContent));

        assert(rollback.sessionReady && rollback.packages.packages.find((entry) => entry.id === 'native-nativeloaderproof').enabled === true, 'Rejected load must retain the old session and reject racing consent changes');
        assert((await saved()).revision === failingSave.revision, 'Failed target activation must not replace the committed save');
        await page.keyboard.press('Escape');
        await page.keyboard.press('F9');
        await page.waitForFunction(() => JSON.parse(document.querySelector('#diagnostics').textContent).engine.action === 2, { polling: 100 });
        const afterRollback = await commit();

        assert(afterRollback.namespace.starts === 2 && afterRollback.namespace.creates === 2 && afterRollback.namespace.loads === 1 && afterRollback.namespace.ticks > failingSave.namespace.ticks, 'Old initialized Lua closure and one set of callbacks must survive target failure without bootstrap replay');

        const safe = new URL(originalUrl);

        safe.searchParams.set('safe-mods', '1');
        await page.goto(safe.href, { waitUntil: 'domcontentloaded' });
        const safeState = await settled();

        assert(!safeState.lua && safeState.mods.mods.length === 0, 'Safe mode must execute no native or JavaScript package');
        assert((await saved()).revision === afterRollback.revision, 'Blocked safe-mode restore must retain the saved native namespace');
        await page.goto(originalUrl, { waitUntil: 'domcontentloaded' });
        await settled();
        await enable(false);
        await page.reload({ waitUntil: 'domcontentloaded' });
        const disabled = await settled();

        assert(disabled.startup === 'blocked' && !disabled.lua && disabled.mods.mods.length === 0, 'Disabled native callbacks must not survive; the exact saved-mod mismatch must not be bypassed');
        assert((await saved()).revision === afterRollback.revision, 'Disabled-package restore must not overwrite the retained save');

        return { id, nativeVersion: 'proof-a', before, after, afterRollback, safeModeSkipped: true, disabledCleanup: true, retainedClosureRollback: true, racingConsentRejected: true };
    } finally {
        releaseEngine?.();
        page.off('request', intercept);
        await page.setRequestInterception(false);
    }
}
