/* global document: readonly */

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
    await page.waitForFunction(() => !document.querySelector('#mod').disabled, { timeout: 5_000 });
    await page.click('#mod');
    await page.waitForFunction(() => JSON.parse(document.querySelector('#diagnostics').textContent).mods.mods.length === 1, { timeout: 5_000 });
    await page.focus('#world');
    await page.keyboard.down('w');
    await page.waitForFunction(() => JSON.parse(document.querySelector('#diagnostics').textContent).engine.y < 4.95, { timeout: 5_000 });
    const before = await page.$eval('#diagnostics', (element) => JSON.parse(element.textContent).engine);

    if (mode === 'pointer') {
        const box = await (await page.$('#world')).boundingBox();

        await page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.4);
    } else if (mode === 'form') {
        await page.click('#destination button');
    } else {
        await page.click('[data-walk="-1,0"]');
    }

    const veto = await page.$eval('#diagnostics', (element) => JSON.parse(element.textContent).engine);

    await page.keyboard.up('w');
    const released = await page.$eval('#diagnostics', (element) => JSON.parse(element.textContent).engine);

    await page.click('#stop');
    assert(veto.action === 2, 'A veto must preserve the preceding manual walk.');
    assert(released.action === 0, 'Releasing the held key must stop after a vetoed takeover.');

    return { mode, before, veto, released };
}
