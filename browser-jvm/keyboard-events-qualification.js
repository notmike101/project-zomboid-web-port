import { createBrowserClock } from './browser-clock.js';
import { keyboardNatives } from './keyboard.js';
import { createSpriteNatives } from './sprite-webgl.js';

const canvas = document.querySelector('canvas');
const graphics = createSpriteNatives(canvas);
const clock = createBrowserClock();
const keyboard = keyboardNatives(canvas);
const events = keyboard.enableTextEvents();

keyboard.enableTextEvents();

if (document.querySelectorAll('textarea').length !== 1) {
    throw new Error('Keyboard opt-in must reuse its one owned input sink');
}

const params = new URL(location.href).searchParams;
const ui = params.has('ui');
const unsupported = params.has('unsupported');
const name = ui ? 'KeyboardTextEntryQualification' : 'KeyboardEventsQualification';
const archives = ['keyboard-events-entry.jar', 'keyboard-events-view.jar', 'play-entry.jar', 'animation-entry.jar', 'animation-view.jar', 'animation-sdk-view.jar', 'path-view.jar', 'float-bridge.jar', 'memory-bridge.jar', 'world-entry.jar', 'atomic-view.jar'];

globalThis.backend = events;
globalThis.records = [];
events.focusText();

try {
    await cheerpjInit({
        version: 17,
        status: 'none',
        javaProperties: ['user.dir=/files/work'],
        natives: {
            ...graphics.natives,
            ...clock.natives,
            ...keyboard.natives,
            /**
             * Observes the original Java qualification lifecycle.
             *
             * @param {object} _lib - Java callback library.
             * @param {number} phase - Ordered input phase.
             */
            [`Java_${name}_ready`](_lib, phase) {
                globalThis.phase = phase;

                return new Promise((resolve) => {
                    globalThis.resume = resolve;
                });
            },
            /**
             * Observes the original Java qualification lifecycle.
             *
             * @param {object} _lib - Java callback library.
             * @param {string} text - Original Java result JSON.
             */
            [`Java_${name}_report`](_lib, text) {
                const row = JSON.parse(String(text));

                globalThis.records.push(row);

                if ('pass' in row) {
                    globalThis.result = row;
                }
            },
        },
    });
    globalThis.exit = await cheerpjRunMain(name, archives.map((n) => `/app/${n}`).join(':'), ...(unsupported ? ['unsupported'] : []));
} catch (error) {
    globalThis.result = { pass: false, error: String(error.stack || error) };
} finally {
    globalThis.snapshot = events.snapshot();
    keyboard.dispose();
    globalThis.disposedSnapshot = events.snapshot();
    globalThis.clock = clock.snapshot();
    canvas.getContext('webgl2').getExtension('WEBGL_lose_context')?.loseContext();
    globalThis.done = true;
}
