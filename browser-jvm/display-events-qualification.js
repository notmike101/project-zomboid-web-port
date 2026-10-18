import { createBrowserClock } from './browser-clock.js';
import { createBrowserMouse } from './browser-mouse.js';
import { createControllerNatives } from './controller-natives.js';
import { createDisplayEvents } from './display-events.js';
import { keyboardNatives } from './keyboard.js';
import { createSpriteNatives } from './sprite-webgl.js';
import { installUnsafeShortRepair } from './unsafe-short-repair.js';

const canvas = document.querySelector('canvas');
const oldTitle = document.title;
const oldCursor = canvas.style.cursor;
const graphics = createSpriteNatives(canvas);
const clock = createBrowserClock();
const keyboard = keyboardNatives(canvas);
const events = keyboard.enableTextEvents();
const mouse = createBrowserMouse(canvas);
const display = createDisplayEvents(canvas, events);
const controllers = createControllerNatives();
const gl = canvas.getContext('webgl2');
const archives = ['qualification.jar', 'display-events-view.jar', 'controller-view.jar', 'clipboard-view.jar', 'startup-input-view.jar', 'menu-mouse-view.jar', 'animation-entry.jar', 'animation-view.jar', 'animation-sdk-view.jar', 'path-view.jar', 'float-bridge.jar', 'memory-bridge.jar', 'world-entry.jar', 'atomic-view.jar'];
let systemCalls = 0;

if (navigator.clipboard) {
    for (const name of ['read', 'write', 'readText', 'writeText']) {
        Object.defineProperty(navigator.clipboard, name, {
            configurable: true,
            /** Rejects accidental OS clipboard access during this app-local component. */
            value() {
                systemCalls++;
                throw new Error('OS clipboard forbidden');
            },
        });
    }
}

globalThis.events = events;
globalThis.trace = [];
globalThis.result = { pass: false };

try {
    const ownedRoot = new URL(location.href).searchParams.get('root');

    if (!/^\/files\/display-events\/[a-f\d-]+$/u.test(ownedRoot)) {
        throw new Error('Fresh owned display event root required');
    }

    await cheerpjInit({
        version: 17,
        status: 'none',
        clipboardMode: 'java',
        javaProperties: [`user.home=${ownedRoot}/home`, `user.dir=${ownedRoot}`],
        natives: {
            ...graphics.natives, ...clock.natives, ...keyboard.natives, ...mouse.natives, ...display.natives, ...controllers.natives,
            /**
             * Pauses at a real input boundary without altering original state.
             *
             * @param {object} _lib - Java library.
             * @param {number} phase - Ordered driver phase.
             * @returns {Promise<void>} Driver action completion.
             */
            Java_DisplayEventsQualification_phase(_lib, phase) {
                globalThis.phase = phase;
                globalThis.trace.push({ phase });

                return new Promise((resolve) => {
                    globalThis.resume = resolve;
                });
            },
            /**
             * Observes the actual CSS cursor after an original platform call.
             *
             * @param {object} _lib - Java library.
             * @param {string} expected - Expected cursor mode.
             * @returns {boolean} Actual browser observation.
             */
            Java_DisplayEventsQualification_cursor(_lib, expected) {
                return getComputedStyle(canvas).cursor === expected;
            },
            /**
             * Records actual original consumer completion before VM exit.
             *
             * @param {object} _lib - Java library.
             * @param {string} json - Authored Java result.
             */
            Java_DisplayEventsQualification_report(_lib, json) {
                globalThis.java = JSON.parse(String(json));
            },
        },
    });
    const repair = installUnsafeShortRepair(globalThis.cj3Module);
    const exit = await cheerpjRunMain('DisplayEventsQualification', archives.map((name) => `/app/${name}`).join(':'), ownedRoot);

    globalThis.result = { pass: exit === 0 && globalThis.java?.pass === true, exit, java: globalThis.java, repair };
} catch (error) {
    globalThis.result = { pass: false, error: String(error.stack || error) };
} finally {
    const beforeControllers = controllers.diagnostics();

    controllers.dispose();
    globalThis.result.controllers = { before: beforeControllers, after: controllers.diagnostics() };
    display.dispose();
    keyboard.dispose();
    mouse.dispose();
    document.title = oldTitle;
    Object.assign(globalThis.result, {
        display: display.snapshot(), keyboard: events.snapshot(), mouse: mouse.snapshot(), systemCalls,
        titleRestored: document.title === oldTitle, cursorRestored: canvas.style.cursor === oldCursor,
        contextLost: gl.isContextLost(), trace: globalThis.trace,
    });
    globalThis.done = true;
}
