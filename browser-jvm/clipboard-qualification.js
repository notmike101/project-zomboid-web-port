import { installUnsafeShortRepair } from './unsafe-short-repair.js';

let systemCalls = 0;
const platform = navigator.clipboard;

// A failing guard proves this component never writes or reads the user's OS clipboard.
if (platform) {
    for (const method of ['read', 'write', 'readText', 'writeText']) {
        Object.defineProperty(platform, method, {
            configurable: true,
            /**
             * Rejects and records accidental browser system clipboard access.
             */
            value() {
                systemCalls++;
                throw new Error('System clipboard forbidden by application-local qualification');
            },
        });
    }
}

globalThis.result = { pass: false, ownerKind: 'java.awt.datatransfer.Clipboard', appLocalOnly: true };

try {
    await cheerpjInit({
        version: 17,
        status: 'none',
        clipboardMode: 'java',
        natives: {
            /**
             * Records actual Java consumer completion before VM termination.
             *
             * @param {object} _lib - Java native callback library.
             * @param {string} text - Authored consumer report.
             */
            Java_ClipboardQualification_report(_lib, text) {
                globalThis.result.java = JSON.parse(String(text));
            },
        },
    });
    globalThis.result.repair = installUnsafeShortRepair(globalThis.cj3Module);
    globalThis.result.exit = await cheerpjRunMain('ClipboardQualification', '/app/qualification.jar:/app/clipboard-view.jar:/app/atomic-view.jar');
    globalThis.result.pass = globalThis.result.exit === 0 && globalThis.result.java?.pass === true && systemCalls === 0;
} catch (error) {
    globalThis.result.error = String(error.stack || error);
} finally {
    globalThis.result.systemCalls = systemCalls;
    globalThis.completed = true;
}
