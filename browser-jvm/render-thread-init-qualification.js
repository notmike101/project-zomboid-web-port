import { createBrowserClock } from './browser-clock.js';
import { createControllerNatives } from './controller-natives.js';
import { keyboardNatives } from './keyboard.js';
import { createSpriteNatives } from './sprite-webgl.js';
import { installUnsafeShortRepair } from './unsafe-short-repair.js';

const canvas = document.querySelector('canvas');
const graphics = createSpriteNatives(canvas);
const keyboard = keyboardNatives(canvas);
const keyboardEvents = keyboard.enableTextEvents();
const clock = createBrowserClock();
const controllers = createControllerNatives();
const archives = ['qualification.jar', 'controller-view.jar', 'startup-input-view.jar', 'play-entry.jar', 'animation-entry.jar', 'animation-view.jar', 'animation-sdk-view.jar', 'path-view.jar', 'float-bridge.jar', 'memory-bridge.jar', 'world-entry.jar', 'atomic-view.jar'];

globalThis.result = { pass: false, fullShutdownQualified: false };

try {
    const root = new URL(location.href).searchParams.get('root');

    if (!/^\/files\/render-thread-init\/[a-f\d-]+$/u.test(root)) {
        throw new Error('Fresh owned render startup path required');
    }

    await cheerpjInit({
        version: 17, status: 'none', javaProperties: [`user.dir=${root}`, `user.home=${root}/home`],
        natives: {
            ...graphics.natives, ...keyboard.natives, ...clock.natives, ...controllers.natives,
            /** Dispatches an explicitly authored untrusted event; never fabricates a Gamepad device. */
            Java_RenderThreadInitQualification_triggerUntrustedEvent() {
                dispatchEvent(new Event('gamepadconnected'));
            },
            /**
             * Records original Java completion before the fresh VM terminates.
             *
             * @param {object} _lib - Current Java native namespace.
             * @param {string} text - Authored report from actual original execution.
             */
            Java_RenderThreadInitQualification_report(_lib, text) {
                globalThis.result.java = JSON.parse(String(text));
            },
        },
    });
    globalThis.result.repair = installUnsafeShortRepair(globalThis.cj3Module);
    globalThis.result.exit = await cheerpjRunMain('RenderThreadInitQualification', archives.map((name) => `/app/${name}`).join(':'), root);
    globalThis.result.pass = globalThis.result.exit === 0 && globalThis.result.java?.pass === true;
} catch (error) {
    globalThis.result.error = String(error.stack || error);
} finally {
    const beforeCleanup = controllers.diagnostics();

    if (beforeCleanup.listeners) {
        globalThis.result.pass = false;
    }

    controllers.dispose();
    keyboard.dispose();
    globalThis.result.controllers = controllers.diagnostics();
    globalThis.result.keyboard = keyboardEvents.snapshot();
    globalThis.completed = true;
}
