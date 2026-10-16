import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {parseArgs} from 'node:util';
import {chromium} from 'playwright-core';

const {values} = parseArgs({options: {browser: {type: 'string'}}});
if (!values.browser) throw new Error('Supply --browser with an absolute Chromium executable path');
const baseline = JSON.parse(await readFile('target/browser-save/baseline.json', 'utf8'));
const html = await readFile('src/main/webapp/index.html');
const host = await readFile('src/main/webapp/save-host.js', 'utf8');
const wasm = await readFile('target/browser-save/wasm/probe.wasm');
const runtime = await readFile('target/browser-save/wasm/classes.wasm-runtime.js');
let scenario;
let browser;
const checks = [];
const faults = {
    pass: '',
    mismatch: '',
    'corrupt-read': "const read = saveHost.read.bind(saveHost); saveHost.read = async () => 'ff' + (await read()).slice(2);",
    'quota-failure': "saveHost.write = async () => { throw new DOMException('Injected quota failure', 'QuotaExceededError'); };",
    'truncated-file': `const write = saveHost.write.bind(saveHost); saveHost.write = async hex => {
        await write(hex);
        const file = await (await navigator.storage.getDirectory()).getFileHandle('climate-front.bin');
        const writer = await file.createWritable({keepExistingData: true});
        await writer.truncate(35);
        await writer.close();
    };`
};
const server = createServer((request, response) => {
    const expected = structuredClone(baseline);
    if (scenario === 'mismatch') expected.cases[0].outputs.days.bits = '00000000';
    const files = {
        '/': ['text/html', html],
        '/baseline.json': ['application/json', JSON.stringify(expected)],
        '/save-host.js': ['text/javascript', host + '\n' + faults[scenario]],
        '/wasm/probe.wasm': ['application/wasm', wasm],
        '/wasm/classes.wasm-runtime.js': ['text/javascript', runtime],
        '/favicon.ico': ['image/x-icon', '']
    };
    const file = files[request.url];
    response.writeHead(file ? 200 : 404, {'Content-Type': file?.[0] || 'text/plain', 'Cache-Control': 'no-store'});
    response.end(file?.[1] || '');
});
try {
    await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
    browser = await chromium.launch({executablePath: values.browser, headless: true});
    for (scenario of Object.keys(faults)) {
        const context = await browser.newContext();
        try {
            const page = await context.newPage();
            let pageLoads = 0;
            page.on('framenavigated', frame => { if (frame === page.mainFrame()) pageLoads++; });
            await page.goto('http://127.0.0.1:' + server.address().port + '/');
            await page.waitForFunction(() => window.probeResult !== undefined, null, {timeout: 30000});
            const result = await page.evaluate(() => window.probeResult);
            assert.equal(result.pass, scenario === 'pass', scenario);
            if (scenario === 'mismatch') assert.equal(result.mismatches.length, 1);
            if (scenario === 'pass') {
                assert.equal(pageLoads, 8);
                assert.equal(result.matched, 112);
                const rejected = await page.evaluate(async () => {
                    const module = await TeaVM.wasmGC.load('/wasm/probe.wasm');
                    const valid = module.exports.initialSnapshot();
                    const invalid = ['', 'g'.repeat(72), '0'.repeat(72)];
                    let count = 0;
                    for (const snapshot of invalid) {
                        try { module.exports.advanceSnapshot(snapshot, 0); } catch { count++; }
                    }
                    for (const index of [-1, 8]) {
                        try { module.exports.advanceSnapshot(valid, index); } catch { count++; }
                    }
                    const before = await saveHost.read();
                    try { await saveHost.write('invalid'); } catch { count++; }
                    if (before !== await saveHost.read()) throw new Error('Rejected write changed stored data');
                    return count;
                });
                assert.equal(rejected, 6);
            } else if (scenario !== 'mismatch') {
                assert.ok(result.errors.length, scenario);
            }
            checks.push({scenario, pass: true, observedComparisonPass: result.pass, pageLoads,
                status: await page.locator('#status').innerText()});
        } finally {
            await context.close();
        }
    }
} finally {
    try {
        if (browser) await browser.close();
    } finally {
        await new Promise(accept => server.close(accept));
    }
}
assert.ok(!browser.isConnected() && !server.listening);
await writeFile('target/host-check.json', JSON.stringify({checks, invalidInputsRejected: 6,
    browserClosed: true, serverClosed: true}, null, 2) + '\n');
console.log(JSON.stringify(checks, null, 2));
