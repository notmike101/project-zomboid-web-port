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
