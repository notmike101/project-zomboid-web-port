/**
 * Exercise provisioned content startup, real WebGPU and retained browser saves.
 * No asset choosers, proprietary fixtures or screenshots are used.
 *
 * @param {object} context - Existing browser runner context.
 * @param {object} context.page - Puppeteer page already on the application.
 * @param {function(boolean, string): void} context.assert - Assertion function.
 * @returns {Promise<object>} Metadata-only acceptance evidence.
 */
async function checkWorldReload({ page, assert }) {
    if (typeof assert !== 'function') {
        throw new TypeError('checkWorldReload requires an assertion function.');
    }

    /**
     * Check the playable surface, not just a canvas nested in page chrome.
     *
     * @returns {Promise<object>} Viewport and drawing-buffer metadata.
     */
    async function layout() {
        const surface = await page.evaluate(() => {
            const canvas = document.querySelector('#world');
            const box = canvas.getBoundingClientRect();
            const evidence = JSON.parse(document.querySelector('#diagnostics').textContent);

            return {
                x: box.x, y: box.y, width: box.width, height: box.height,
                viewportWidth: innerWidth, viewportHeight: innerHeight,
                scrollWidth: document.documentElement.scrollWidth,
                scrollHeight: document.documentElement.scrollHeight,
                bufferWidth: canvas.width, bufferHeight: canvas.height,
                pixelRatio: evidence.renderer.canvas.pixelRatio,
                chrome: document.querySelectorAll('header, aside, footer').length,
                loadingHidden: document.querySelector('#loading').hidden,
                errorHidden: document.querySelector('#error').hidden,
                menuOpen: document.querySelector('#pause-menu').open,
                diagnosticsHidden: document.querySelector('#diagnostics').hidden,
                focused: document.activeElement === canvas,
                backupInMenu: document.querySelector('#pause-menu #import-save') !== null,
            };
        });

        assert(surface.x === 0 && surface.y === 0 && surface.width === surface.viewportWidth && surface.height === surface.viewportHeight, 'The game must fill the browser viewport edge to edge');
        assert(surface.scrollWidth === surface.viewportWidth && surface.scrollHeight === surface.viewportHeight, 'Gameplay must not scroll the page');
        assert(surface.chrome === 0 && surface.loadingHidden && surface.errorHidden && !surface.menuOpen && surface.diagnosticsHidden, 'Ready gameplay must have no page chrome, debug panel, loading overlay or open menu');
        assert(surface.focused, 'Ready gameplay must focus the world without an initial click');
        assert(surface.backupInMenu, 'The only file input must belong to the in-game menu');
        assert(surface.bufferWidth === Math.round(surface.width * surface.pixelRatio) && surface.bufferHeight === Math.round(surface.height * surface.pixelRatio), 'The actual renderer buffer must track the viewport at its effective DPR');

        return surface;
    }

    /**
     * Open the real pause menu and verify safety cancellation.
     *
     * @returns {Promise<void>} Pauses gameplay.
     */
    async function openMenu() {
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => document.querySelector('#pause-menu').open);
        const evidence = await page.$eval('#diagnostics', (element) => JSON.parse(element.textContent));

        assert(evidence.paused && evidence.engine.action === 0, 'Opening the menu must pause and cancel movement');
    }

    /**
     * Resume through its keyboard-accessible control.
     *
     * @returns {Promise<void>} Returns focus to the game.
     */
    async function resume() {
        await page.focus('#pause');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => !document.querySelector('#pause-menu').open && document.activeElement === document.querySelector('#world'));
        const evidence = await page.$eval('#diagnostics', (element) => JSON.parse(element.textContent));

        assert(!evidence.paused, 'Resume must restart simulation');
    }

    /**
     * Read committed state fingerprints without exporting original cell bytes.
     *
     * @returns {Promise<object|undefined>} Retained slot metadata.
     */
    function slot() {
        return page.evaluate(async () => {
            const db = await new Promise((resolve, reject) => {
                const request = indexedDB.open('pz-web-saves', 1);

                request.addEventListener('success', () => resolve(request.result));
                request.addEventListener('error', () => reject(request.error));
            });

            try {
                const saved = await new Promise((resolve, reject) => {
                    const request = db.transaction('saves').objectStore('saves').get('autosave');

                    request.addEventListener('success', () => resolve(request.result));
                    request.addEventListener('error', () => reject(request.error));
                });

                if (!saved) {
                    return undefined;
                }

                const record = saved.current;
                const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(record.world)));

                return {
                    revision: record.revision,
                    x: record.engine.state.values[0], y: record.engine.state.values[1],
                    cells: record.world.cells.map(({ x, y }) => ({ x, y })),
                    worldHash: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join(''),
                    mods: record.mods, modState: record.modState,
                };
            } finally {
                db.close();
            }
        });
    }

    /**
     * Await a fully provisioned scene, failing promptly on explicit startup errors.
     *
     * @returns {Promise<object>} Detached application diagnostics.
     */
    async function ready() {
        await page.waitForFunction(() => {
            const text = document.querySelector('#diagnostics')?.textContent;
            const evidence = text ? JSON.parse(text) : undefined;

            return (evidence?.sessionReady && evidence.renderer?.frames > 0 && evidence.tiles?.renderedInstances > 0)
                || evidence?.failed || evidence?.startup === 'blocked';
        }, { timeout: 120_000 });
        const evidence = await page.evaluate(() => JSON.parse(document.querySelector('#diagnostics').textContent));

        assert(evidence.sessionReady === true, `Automatic startup must succeed: ${await page.$eval('#error', (element) => element.textContent)}`);
        assert(evidence.failed === false, 'The renderer must not conceal a fatal error');
        assert(evidence.renderer.backend === 'WebGPU', 'The scene must use actual WebGPU');
        assert(evidence.renderer.fallbackAdapter !== true && !evidence.renderer.stopped && !evidence.renderer.destroyed, 'The WebGPU renderer must be active and must not report a fallback adapter');
        assert(evidence.renderer.character !== null, 'Original animated character must be loaded automatically');
        assert(evidence.tiles?.cells > 0 && evidence.tiles?.renderedInstances > 0 && evidence.tiles?.residentSprites > 0, 'Original geometry and tiles must be loaded automatically');
        assert(evidence.tiles.errors.length === 0, 'Tile uploads and geometry reads must not conceal startup failures');
        assert(evidence.renderer.frames > 0, 'WebGPU must have presented the scene');

        return evidence;
    }

    const initial = await ready();
    const fullView = await layout();

    await openMenu();
    await resume();
    await openMenu();
    const selectors = await page.$$eval('input[type="file"]', (inputs) => inputs.map((input) => input.id));

    assert(selectors.length === 1 && selectors[0] === 'import-save', 'Only save backup import may expose a file selector');
    await page.click('#stop');
    const beforeSave = await slot();

    await page.click('#save-now');
    await page.waitForFunction((revision) => document.querySelector('#save-status').textContent.startsWith(`Saved revision ${revision}`), {}, (beforeSave?.revision ?? 0) + 1);
    const committed = await slot();

    await resume();

    assert(committed.cells.length > 0, 'A committed session must contain real navigation');
    // Observe every save write during reload, including writes before boot settles.
    await page.evaluateOnNewDocument(() => {
        globalThis.__worldSaveWrites = [];
        const original = IDBObjectStore.prototype.put;

        /**
         * Observe autosave writes before and after startup readiness.
         *
         * @param {object} value - Record being written to the object store.
         * @param {...(number|string|Date|ArrayBuffer|Array)} arguments_ - Optional explicit record key.
         * @returns {IDBRequest} Original IndexedDB write request.
         */
        IDBObjectStore.prototype.put = function put(value, ...arguments_) {
            if (this.name === 'saves' && value?.id === 'autosave') {
                globalThis.__worldSaveWrites.push({
                    revision: value.current.revision,
                    x: value.current.engine.state.values[0], y: value.current.engine.state.values[1],
                    cells: value.current.world.cells.length,
                    ready: JSON.parse(document.querySelector('#diagnostics')?.textContent || '{}').sessionReady === true,
                });
            }

            return original.call(this, value, ...arguments_);
        };
    });
    await page.reload({ waitUntil: 'networkidle0' });
    const restored = await ready();
    const afterBoot = await slot();

    await layout();

    assert(JSON.stringify(afterBoot) === JSON.stringify(committed), 'Boot must preserve the committed revision, player, world and mod state without writing a blank session');
    assert(restored.engine.x === committed.x && restored.engine.y === committed.y, 'Player position must restore automatically');
    assert(restored.savedRevision === committed.revision, 'Automatic restoration must identify the retained revision');
    // Two real autosave periods: prove later writes retain the loaded world too.
    await new Promise((resolve) => {
        setTimeout(resolve, 61_000);
    });
    const afterAutosave = await slot();
    const writes = await page.evaluate(() => globalThis.__worldSaveWrites);

    assert(afterAutosave.revision >= committed.revision + 2, 'Both real autosave cycles must commit later revisions');
    assert(afterAutosave.worldHash === committed.worldHash, 'Autosave must retain the authoritative saved navigation');
    assert(afterAutosave.x === committed.x && afterAutosave.y === committed.y, 'An idle restored player must not move during autosave');
    assert(writes.length >= 2, 'The two-period observation must exercise both real autosave writes');
    assert(JSON.stringify(afterAutosave.mods) === JSON.stringify(committed.mods) && JSON.stringify(afterAutosave.modState) === JSON.stringify(committed.modState), 'Autosave must retain saved mod provenance and namespaces');
    assert(writes.every((entry) => entry.ready && entry.cells === committed.cells.length && entry.x === committed.x && entry.y === committed.y), 'No preboot or blank-world overwrite is allowed');
    await openMenu();
    await page.click('#load-save');
    await page.waitForFunction(() => document.querySelector('#save-status').textContent.startsWith('Loaded revision'));
    await resume();
    await layout();

    return { fullView, initial: { backend: initial.renderer.backend, character: initial.renderer.character, tiles: initial.tiles }, committed, afterBoot, afterAutosave, writes, restored: restored.engine };
}

/**
 * Check real package activation/migration writes through the public save envelope.
 *
 * @param {object} context - Browser runner with page and assert.
 * @param {object} context.page - Puppeteer page.
 * @param {function(boolean, string): void} context.assert - Assertion callback.
 * @param {object} expected - Literal namespace documents for the provisioned mod.
 * @param {string} expected.id - Provisioned, enabled package id.
 * @param {object} expected.retained - Expected document after activation/migration.
 * @param {object} expected.fresh - Expected document initialized for a new session.
 * @returns {Promise<object>} Namespace documents committed by the application.
 */
async function checkSessionNamespaces({ page, assert }, { id, retained, fresh }) {
    /**
     * Save via the hidden menu and read the actual committed namespace.
     *
     * @param {object} expected - Independently specified namespace document.
     * @returns {Promise<object>} Persisted namespace.
     */
    async function commit(expected) {
        if (!await page.$eval('#pause-menu', (element) => element.open)) {
            await page.keyboard.press('Escape');
        }

        await page.waitForFunction(() => document.querySelector('#pause-menu').open);
        const previous = await page.$eval('#diagnostics', (element) => JSON.parse(element.textContent).savedRevision ?? 0);

        await page.click('#save-now');
        await page.waitForFunction((revision) => JSON.parse(document.querySelector('#diagnostics').textContent).savedRevision > revision, {}, previous);
        const namespace = await page.evaluate(async (modId) => {
            const db = await new Promise((resolve, reject) => {
                const request = indexedDB.open('pz-web-saves', 1);

                request.addEventListener('success', () => resolve(request.result));
                request.addEventListener('error', () => reject(request.error));
            });

            try {
                return await new Promise((resolve, reject) => {
                    const request = db.transaction('saves').objectStore('saves').get('autosave');

                    request.addEventListener('success', () => resolve(request.result.current.modState[modId]));
                    request.addEventListener('error', () => reject(request.error));
                });
            } finally {
                db.close();
            }
        }, id);

        assert(JSON.stringify(namespace) === JSON.stringify(expected), `${id}: activation and migration writes must survive session publication and saving`);

        return namespace;
    }

    await page.waitForFunction(() => JSON.parse(document.querySelector('#diagnostics').textContent || '{}').sessionReady, { timeout: 120_000 });
    const activated = await commit(retained);

    await page.click('#load-save');
    await page.waitForFunction(() => document.querySelector('#save-status').textContent.startsWith('Loaded revision'));
    const explicitlyLoaded = await commit(retained);

    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForFunction(() => JSON.parse(document.querySelector('#diagnostics').textContent || '{}').sessionReady, { timeout: 120_000 });
    const rebooted = await commit(retained);

    page.once('dialog', (dialog) => {
        void dialog.accept();
    });
    const beforeNew = await page.$eval('#diagnostics', (element) => JSON.parse(element.textContent).savedRevision);

    await page.click('#new-session');
    await page.waitForFunction((revision) => !document.querySelector('#session-controls').disabled
        && JSON.parse(document.querySelector('#diagnostics').textContent).savedRevision > revision, { timeout: 120_000 }, beforeNew);
    const initialized = await commit(fresh);

    return { activated, explicitlyLoaded, rebooted, initialized };
}

/**
 * Fault a real deferred geometry read after terminal loss of the actual GPU.
 *
 * @param {object} context - Browser runner with page and assert.
 * @param {object} context.page - Puppeteer page.
 * @param {function(boolean, string): void} context.assert - Assertion callback.
 * @param {string} geometryUrl - Provisioned lotheader URL read again by Load save.
 * @returns {Promise<object>} Fatal feedback and stopped simulation evidence.
 */
async function checkPendingGpuFailure({ page, assert }, geometryUrl) {
    await page.evaluateOnNewDocument(() => {
        const requestDevice = globalThis.GPUAdapter.prototype.requestDevice;

        /**
         * Retain the real device so the regression can cause actual GPU loss.
         *
         * @param {...object} arguments_ - Original requestDevice arguments.
         * @returns {Promise<object>} Real WebGPU device.
         */
        globalThis.GPUAdapter.prototype.requestDevice = async function captureDevice(...arguments_) {
            const device = await requestDevice.apply(this, arguments_);

            globalThis.__hostRegressionDevice = device;

            return device;
        };
    });
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForFunction(() => JSON.parse(document.querySelector('#diagnostics').textContent || '{}').sessionReady, { timeout: 120_000 });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('#pause-menu').open);
    await page.click('#save-now');
    await page.waitForFunction(() => document.querySelector('#save-status').textContent.startsWith('Saved revision'));
    let pending;
    const requested = new Promise((resolve) => {
        pending = resolve;
    });

    await page.setRequestInterception(true);
    /**
     * Hold the deferred geometry request until the actual GPU has been destroyed.
     *
     * @param {object} request - Actual held HTTP request.
     * @returns {void}
     */
    const intercept = (request) => {
        if (request.url() === geometryUrl) {
            pending(request);
        } else {
            void request.continue();
        }
    };

    page.on('request', intercept);
    try {
        await page.click('#load-save');
        const request = await requested;

        await page.evaluate(() => globalThis.__hostRegressionDevice.destroy());
        await page.waitForFunction(() => JSON.parse(document.querySelector('#diagnostics').textContent).failed);
        const fatal = await page.$eval('#error', (element) => element.textContent);

        assert(/WebGPU.*lost/iu.test(fatal) && /reload/iu.test(fatal), 'Actual GPU loss must show terminal recovery feedback');
        await request.respond({ status: 503, body: 'Deferred geometry unavailable' });
        await page.waitForFunction(() => !document.querySelector('#session-controls').disabled);
        const result = await page.evaluate(() => ({
            error: document.querySelector('#error').textContent,
            hidden: document.querySelector('#error').hidden,
            menu: document.querySelector('#pause-menu').open,
            ...JSON.parse(document.querySelector('#diagnostics').textContent),
        }));

        assert(result.error === fatal && !result.hidden && !result.menu, 'A failed pending load must not conceal or make fatal GPU feedback dismissible');
        assert(result.failed && result.paused && result.engine.action === 0, 'Fatal loss must keep failed operations paused and movement canceled');

        return result;
    } finally {
        page.off('request', intercept);
        await page.setRequestInterception(false);
    }
}

/**
 * Reject a real streamed tile read while moving the actual camera.
 *
 * @param {object} context - Browser runner with page and assert.
 * @param {object} context.page - Puppeteer page.
 * @param {function(boolean, string): void} context.assert - Assertion callback.
 * @param {object} fault - Required asset URL and a reachable camera destination.
 * @param {string} fault.assetUrl - Provisioned lotpack or pack URL to reject.
 * @param {{x: number, y: number}} fault.destination - Uncached passable location.
 * @returns {Promise<object>} Visible failure and safe simulation metadata.
 */
async function checkRuntimeTileFailure({ page, assert }, { assetUrl, destination }) {
    await page.waitForFunction(() => JSON.parse(document.querySelector('#diagnostics').textContent || '{}').sessionReady, { timeout: 120_000 });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('#pause-menu').open);
    await page.$eval('#movement-settings', (element) => {
        element.open = true;
    });
    await page.$eval('#target-x', (element, x) => {
        element.value = String(x);
    }, destination.x);
    await page.$eval('#target-y', (element, y) => {
        element.value = String(y);
    }, destination.y);
    let rejected = 0;
    /**
     * Reject the required streamed asset with a real 503 response.
     *
     * @param {object} request - Actual held HTTP request.
     * @returns {void}
     */
    const intercept = (request) => {
        if (request.url() === assetUrl) {
            rejected += 1;
            void request.respond({ status: 503, body: 'Required streamed art unavailable' });
        } else {
            void request.continue();
        }
    };

    await page.setRequestInterception(true);
    page.on('request', intercept);
    try {
        await page.click('#destination button');
        await page.waitForFunction(() => JSON.parse(document.querySelector('#diagnostics').textContent).tiles.errors.length > 0, { timeout: 120_000 });
        await page.waitForFunction(() => !document.querySelector('#error').hidden);
        const result = await page.evaluate(() => ({
            feedback: document.querySelector('#error').textContent,
            ...JSON.parse(document.querySelector('#diagnostics').textContent),
        }));

        assert(rejected > 0, 'The regression must exercise a real required-asset HTTP failure');
        assert(result.feedback.includes('503') && /reload|provision/iu.test(result.feedback), 'Streamed art failure must give visible actionable content feedback');
        assert(result.paused && result.engine.action === 0, 'Unavailable required art must stop travel and pause simulation');
        await page.keyboard.press('Escape');
        await page.keyboard.press('w');
        assert(await page.$eval('#diagnostics', (element) => JSON.parse(element.textContent).engine.action === 0), 'Input must not dismiss missing-art safety handling');

        return result;
    } finally {
        page.off('request', intercept);
        await page.setRequestInterception(false);
    }
}

/**
 * Restore a real multi-cell save with one non-player geometry pair absent.
 *
 * @param {object} context - Browser runner with page and assert.
 * @param {object} context.page - Puppeteer page.
 * @param {function(boolean, string): void} context.assert - Assertion callback.
 * @param {object} missing - Manifest URL and authoritative non-player cell.
 * @param {string} missing.manifestUrl - Actual provisioned content manifest URL.
 * @param {{x:number,y:number}} missing.cell - Saved cell whose geometry is removed.
 * @param {string[]} missing.paths - Header/lotpack manifest paths to remove.
 * @returns {Promise<object>} Visible blocked feedback and unchanged save hash.
 */
async function checkMissingSavedGeometry({ page, assert }, { manifestUrl, cell, paths }) {
    /**
     * Fingerprint the complete retained slot, not merely its revision.
     *
     * @returns {Promise<object>} Save hash and authoritative navigation metadata.
     */
    function retained() {
        return page.evaluate(async () => {
            const db = await new Promise((resolve, reject) => {
                const request = indexedDB.open('pz-web-saves', 1);

                request.addEventListener('success', () => resolve(request.result));
                request.addEventListener('error', () => reject(request.error));
            });

            try {
                const slot = await new Promise((resolve, reject) => {
                    const request = db.transaction('saves').objectStore('saves').get('autosave');

                    request.addEventListener('success', () => resolve(request.result));
                    request.addEventListener('error', () => reject(request.error));
                });
                const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(slot)));

                return {
                    hash: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join(''),
                    cells: slot.current.world.cells.map(({ x, y }) => ({ x, y })),
                    playerCell: { x: Math.floor(slot.current.engine.state.values[0] / 256), y: Math.floor(slot.current.engine.state.values[1] / 256) },
                };
            } finally {
                db.close();
            }
        });
    }

    const before = await retained();

    assert(before.cells.some(({ x, y }) => x === cell.x && y === cell.y) && (before.playerCell.x !== cell.x || before.playerCell.y !== cell.y), 'The missing geometry must belong to an authoritative saved cell away from the player');
    const manifest = await page.evaluate(async (url) => (await fetch(url)).json(), manifestUrl);

    manifest.files = manifest.files.filter((entry) => !paths.includes(entry.path));
    manifest.startup.cells = manifest.startup.cells.filter(({ x, y }) => x !== cell.x || y !== cell.y);
    /**
     * Serve the patched manifest with the missing geometry removed.
     *
     * @param {object} request - Actual held HTTP request.
     * @returns {void}
     */
    const intercept = (request) => {
        if (request.url() === manifestUrl) {
            void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(manifest) });
        } else {
            void request.continue();
        }
    };

    await page.setRequestInterception(true);
    page.on('request', intercept);
    try {
        await page.reload({ waitUntil: 'networkidle0' });
        await page.waitForFunction(() => {
            const evidence = JSON.parse(document.querySelector('#diagnostics').textContent || '{}');

            return evidence.startup === 'blocked' || evidence.sessionReady;
        }, { timeout: 120_000 });
        const result = await page.evaluate(() => ({
            feedback: document.querySelector('#error').textContent,
            hidden: document.querySelector('#error').hidden,
            ...JSON.parse(document.querySelector('#diagnostics').textContent),
        }));
        const after = await retained();

        assert(result.startup === 'blocked' && !result.sessionReady && result.paused && !result.hidden, 'One missing authoritative cell must reject restoration before gameplay');
        assert(result.feedback.includes(`${cell.x},${cell.y}`) && paths.every((path) => result.feedback.includes(path)), 'Missing-cell feedback must identify the cell and every required missing file');
        assert(after.hash === before.hash, 'A partial geometry restore must leave the entire retained save unchanged');

        return { feedback: result.feedback, beforeHash: before.hash, afterHash: after.hash };
    } finally {
        page.off('request', intercept);
        await page.setRequestInterception(false);
    }
}

export { checkWorldReload, checkSessionNamespaces, checkPendingGpuFailure, checkRuntimeTileFailure, checkMissingSavedGeometry };
