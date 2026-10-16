/**
 * Exercise the built UI with a real WASM instance and a vetoing public-API mod.
 * Run as a browser.tab.run callback; no private host state is exposed.
 *
 * @param {object} context - Browser runner context.
 * @param {object} context.page - Puppeteer-compatible page for the running app.
 * @param {(condition: boolean, message: string) => void} context.assert - Runner assertion.
 * @param {string} [mode] - Pointer, form, or direction-toggle takeover.
 * @returns {Promise<object>} Detached before/veto/release engine snapshots.
 */
export async function checkHeldVeto({ page, assert }, mode = 'pointer') {
    if (typeof assert !== 'function') {
        throw new TypeError('checkHeldVeto requires an assertion function.');
    }

    if (!['pointer', 'form', 'toggle'].includes(mode)) {
        throw new Error('Unknown takeover scenario.');
    }

    await page.setRequestInterception(true);
    page.on('request', (request) => {
        if (request.url().endsWith('/mods/accessible-walking/main.js')) {
            void request.respond({
                status: 200,
                contentType: 'text/javascript',
                body: 'export const manifest={id:\'held-veto\',name:\'Held veto regression\',version:\'0.1.0\',apiVersion:\'0.1.0\'}; export function activate(api){return api.hooks.beforeAction(a=>a.type===\'moveTo\'||(a.type===\'walk\'&&a.x!==0)?false:undefined);}',
            });
        } else {
            void request.continue();
        }
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.querySelector('#mod').disabled, { timeout: 120_000 });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('#pause-menu').open);

    if (!await page.$eval('#mod', (element) => element.closest('details').open)) {
        await page.click('#pause-menu details:has(#mod) > summary');
    }

    if (await page.$eval('#mod', (element) => element.checked)) {
        await page.click('#mod');
        await page.waitForFunction(() => JSON.parse(document.querySelector('#diagnostics').textContent).mods.mods.length === 0);
    }

    await page.click('#mod');
    await page.waitForFunction(() => JSON.parse(document.querySelector('#diagnostics').textContent).mods.mods.length === 1, { timeout: 5_000 });
    await page.click('#pause');
    const initial = await page.$eval('#diagnostics', (element) => JSON.parse(element.textContent).engine);

    await page.keyboard.down('w');
    await page.waitForFunction((y) => JSON.parse(document.querySelector('#diagnostics').textContent).engine.y < y - 0.05, { timeout: 5_000 }, initial.y);
    const before = await page.$eval('#diagnostics', (element) => JSON.parse(element.textContent).engine);

    if (mode === 'pointer') {
        const box = await (await page.$('#world')).boundingBox();

        await page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.4);
    } else {
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => document.querySelector('#pause-menu').open);
        const paused = await page.$eval('#diagnostics', (element) => JSON.parse(element.textContent));

        assert(paused.paused && paused.engine.action === 0, 'Opening movement assistance must pause and cancel held walking');

        if (!await page.$eval('#movement-settings', (element) => element.open)) {
            await page.click('#movement-settings summary');
        }

        if (mode === 'form') {
            await page.click('#destination button');
        } else {
            await page.click('[data-walk="-1,0"]');
        }
    }

    const veto = await page.$eval('#diagnostics', (element) => JSON.parse(element.textContent).engine);

    await page.keyboard.up('w');
    const released = await page.$eval('#diagnostics', (element) => JSON.parse(element.textContent).engine);

    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('#pause-menu').open);
    await page.click('#stop');
    assert(veto.action === (mode === 'pointer' ? 2 : 0), mode === 'pointer' ? 'A pointer veto must preserve the preceding manual walk.' : 'A vetoed menu action must leave the player idle.');
    assert(released.action === 0, 'Releasing the held key must not leave walking active after a veto.');
    await page.click('#pause');
    assert(await page.$eval('#world', (element) => document.activeElement === element), 'Resume must restore keyboard focus to the game');

    return { mode, before, veto, released };
}

/**
 * Exercise real keyboard, pointer, menu movement and safety cancellation.
 *
 * @param {object} context - Existing browser runner context.
 * @param {object} context.page - Puppeteer-compatible application page.
 * @param {function(boolean, string): void} context.assert - Assertion function.
 * @returns {Promise<object>} Metadata-only input evidence.
 */
export async function checkGameplay({ page, assert }) {
    if (typeof assert !== 'function') {
        throw new TypeError('checkGameplay requires an assertion function.');
    }

    await page.waitForFunction(() => {
        const text = document.querySelector('#diagnostics')?.textContent;

        return text && JSON.parse(text).sessionReady;
    }, { timeout: 120_000 });

    if (await page.$eval('#pause-menu', (element) => element.open)) {
        await page.click('#pause');
    }

    assert(await page.$eval('#world', (element) => document.activeElement === element), 'The ready world must already have keyboard focus');
    const initial = await page.$eval('#diagnostics', (element) => JSON.parse(element.textContent).engine);

    await page.keyboard.down('w');
    await page.waitForFunction((y) => JSON.parse(document.querySelector('#diagnostics').textContent).engine.y < y - 0.02, { timeout: 5_000 }, initial.y);
    await page.keyboard.press('Escape');
    await page.keyboard.up('w');
    const paused = await page.$eval('#diagnostics', (element) => JSON.parse(element.textContent));

    assert(paused.paused && paused.engine.action === 0 && await page.$eval('#pause-menu', (element) => element.open), 'Escape must cancel walking and open the pause menu');

    if (!await page.$eval('#movement-settings', (element) => element.open)) {
        await page.click('#movement-settings summary');
    }

    await page.click('[data-walk="0,-1"]');
    await page.waitForFunction((y) => JSON.parse(document.querySelector('#diagnostics').textContent).engine.y < y - 0.02, { timeout: 5_000 }, paused.engine.y);
    const assisted = await page.$eval('#diagnostics', (element) => JSON.parse(element.textContent));

    assert(!assisted.paused && assisted.engine.action === 2 && await page.$eval('#world', (element) => document.activeElement === element), 'Menu walking must resume and focus the game without a held key');
    await page.keyboard.press('Space');
    assert(await page.$eval('#diagnostics', (element) => JSON.parse(element.textContent).engine.action === 0), 'Space must stop movement without opening the menu');
    await page.keyboard.down('ArrowUp');
    assert(await page.$eval('#diagnostics', (element) => JSON.parse(element.textContent).engine.action === 2), 'Arrow keys must take manual control of the focused game');
    await page.keyboard.up('ArrowUp');
    assert(await page.$eval('#diagnostics', (element) => JSON.parse(element.textContent).engine.action === 0), 'Releasing an arrow key must stop manual walking');
    const box = await (await page.$('#world')).boundingBox();

    await page.mouse.click(box.x + box.width / 2 + 12, box.y + box.height / 2);
    await page.waitForFunction(() => JSON.parse(document.querySelector('#diagnostics').textContent).engine.action === 1, { timeout: 5_000 });
    const pointer = await page.$eval('#diagnostics', (element) => JSON.parse(element.textContent).engine);

    await page.evaluate(() => globalThis.dispatchEvent(new Event('blur')));
    assert(await page.$eval('#diagnostics', (element) => JSON.parse(element.textContent).engine.action === 0), 'Window blur must cancel pointer travel');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('#pause-menu').open);
    await page.$eval('#target-x', (element) => {
        element.value = String(Number(element.value) + 0.25);
    });
    await page.click('#destination button');
    const destination = await page.$eval('#diagnostics', (element) => JSON.parse(element.textContent));

    assert(!destination.paused && destination.engine.action === 1 && await page.$eval('#world', (element) => document.activeElement === element), 'A coordinate destination must close the menu, resume and focus the game');
    await page.keyboard.press('Escape');
    await page.click('#stop');
    await page.focus('#pause');
    await page.keyboard.press('Enter');
    assert(await page.$eval('#world', (element) => document.activeElement === element), 'Keyboard Resume must restore game focus');

    return { initial, paused: paused.engine, assisted: assisted.engine, pointer, destination: destination.engine };
}

/**
 * Round-trip one source binding through the visible editor and real save/reload.
 *
 * @param {object} context - Existing browser runner context.
 * @param {object} context.page - Puppeteer-compatible application page.
 * @param {function(boolean, string): void} context.assert - Assertion function.
 * @returns {Promise<object>} Binding values, revisions and round-trip metadata only.
 */
export async function checkKeyboardBindingPersistence({ page, assert }) {
    if (typeof assert !== 'function') {
        throw new TypeError('checkKeyboardBindingPersistence requires an assertion function.');
    }

    const action = 'Toggle Inventory';
    /**
     * Wait for a usable session or surface a reported startup failure.
     */
    const waitReady = async () => {
        await page.waitForFunction(() => {
            const text = document.querySelector('#diagnostics')?.textContent;
            const state = text && JSON.parse(text);

            return state?.failed || state?.startup === 'blocked'
                || (state?.sessionReady && !document.querySelector('#pause').matches(':disabled')
                    && !document.querySelector('#session-controls').disabled);
        }, { timeout: 120_000, polling: 100 });
        const state = await page.$eval('#diagnostics', (element) => JSON.parse(element.textContent));

        assert(state.sessionReady && !state.failed && state.startup !== 'blocked', 'Keyboard binding check requires a ready, nonfailed session');
    };

    /**
     * Open the genuine pause editor and select the existing source action.
     */
    const openEditor = async () => {
        await waitReady();

        if (!await page.$eval('#pause-menu', (element) => element.open)) {
            await page.keyboard.press('Escape');
        }

        await page.waitForFunction(() => document.querySelector('#pause-menu').open
            && !document.querySelector('#keyboard-apply').matches(':disabled'), { timeout: 10_000, polling: 100 });

        if (!await page.$eval('#keyboard-settings', (element) => element.open)) {
            await page.click('#keyboard-settings > summary');
        }

        const selected = await page.select('#keyboard-action', action);

        assert(selected.length === 1 && selected[0] === action, 'The editor must expose the existing Toggle Inventory binding');
    };

    /**
     * Read the five visible source binding fields.
     *
     * @returns {Promise<object>} The selected action's visible binding record.
     */
    const readRecord = () => page.evaluate(() => ({
        keyValue: Number(document.querySelector('#keyboard-primary').value),
        altKey: Number(document.querySelector('#keyboard-alternate').value),
        shift: document.querySelector('#keyboard-shift').checked,
        ctrl: document.querySelector('#keyboard-ctrl').checked,
        alt: document.querySelector('#keyboard-alt').checked,
    }));
    /**
     * Set a native checkbox through its actual click handler when needed.
     *
     * @param {string} modifier - Binding modifier control name.
     * @param {boolean} checked - Desired checked state.
     */
    const setCheckbox = async (modifier, checked) => {
        if (await page.$eval(`#keyboard-${modifier}`, (element) => element.checked) !== checked) {
            await page.click(`#keyboard-${modifier}`);
        }
    };

    /**
     * Apply a record and reopen the editor to observe the published map.
     *
     * @param {object} record - Exact five-field source binding record.
     */
    const applyRecord = async (record) => {
        const primary = await page.select('#keyboard-primary', String(record.keyValue));
        const alternate = await page.select('#keyboard-alternate', String(record.altKey));

        assert(primary.length === 1 && primary[0] === String(record.keyValue), `The editor must offer native key ${record.keyValue}`);
        assert(alternate.length === 1 && alternate[0] === String(record.altKey), `The editor must offer native key ${record.altKey}`);
        await setCheckbox('shift', record.shift);
        await setCheckbox('ctrl', record.ctrl);
        await setCheckbox('alt', record.alt);

        await page.click('#keyboard-apply');
        // Reopening reads the published map, not the unsaved form controls.
        await page.click('#pause');
        await openEditor();
        const actual = await readRecord();

        assert(Object.keys(record).every((field) => actual[field] === record[field]), 'Apply must publish all five binding fields to the active map');
    };

    /**
     * Commit through the Save control and wait for its completed revision.
     *
     * @returns {Promise<number>} The successfully committed save revision.
     */
    const save = async () => {
        await waitReady();
        const before = await page.$eval('#diagnostics', (element) => JSON.parse(element.textContent).savedRevision ?? 0);

        await page.click('#save-now');
        await page.waitForFunction((revision) => {
            const state = JSON.parse(document.querySelector('#diagnostics').textContent);

            return state.failed || (!document.querySelector('#save-now').matches(':disabled')
                && (state.savedRevision > revision || !document.querySelector('#error').hidden));
        }, { timeout: 120_000, polling: 100 }, before);
        const saved = await page.evaluate(() => ({
            revision: JSON.parse(document.querySelector('#diagnostics').textContent).savedRevision,
            failed: JSON.parse(document.querySelector('#diagnostics').textContent).failed,
            status: document.querySelector('#save-status').textContent,
        }));

        assert(!saved.failed && saved.revision > before && saved.status.startsWith(`Saved revision ${saved.revision}.`), `A genuine Save must finish with a newer committed revision: ${saved.status}`);

        return saved.revision;
    };

    await waitReady();
    const initiallyPaused = await page.$eval('#pause-menu', (element) => element.open);
    let original;
    let changed;
    let attempted = false;
    let failure;
    let evidence;

    try {
        await openEditor();
        original = await readRecord();
        changed = { keyValue: original.keyValue === 22 ? 23 : 22, altKey: 0, shift: false, ctrl: false, alt: false };
        attempted = true;
        await applyRecord(changed);
        const savedRevision = await save();

        await page.reload({ waitUntil: 'domcontentloaded' });
        await openEditor();
        const restored = await readRecord();
        const loadedRevision = await page.$eval('#diagnostics', (element) => JSON.parse(element.textContent).savedRevision);

        assert(loadedRevision === savedRevision, 'Immediate reload must restore the just-saved revision');
        assert(Object.keys(changed).every((field) => restored[field] === changed[field]), 'Save/reload must retain all five visible binding fields exactly');
        evidence = { action, original, changed, savedRevision, roundtrip: true };
    } catch (cause) {
        failure = cause;
    } finally {
        if (attempted) {
            try {
                await openEditor();
                await applyRecord(original);
                const restoredRevision = await save();

                if (evidence) {
                    evidence.restoredRevision = restoredRevision;
                    evidence.restored = true;
                }

                if (!initiallyPaused) {
                    await page.click('#pause');
                }
            } catch (cause) {
                const restoration = new Error(`Could not restore and save the original Toggle Inventory binding through the UI: ${cause.message}`, { cause });

                failure = failure ? new AggregateError([failure, restoration], 'Keyboard binding check failed and original binding restoration also failed') : restoration;
            }
        }
    }

    if (failure) {
        throw failure;
    }

    return evidence;
}
