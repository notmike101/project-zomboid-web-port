import { createBrowserClock } from './browser-clock.js';
import { keyboardNatives } from './keyboard.js';
import { createSpriteNatives } from './sprite-webgl.js';
import { installUnsafeShortRepair } from './unsafe-short-repair.js';

const canvas = document.querySelector('canvas');
const title = document.title;
const graphics = createSpriteNatives(canvas);
const clock = createBrowserClock();
const keyboard = keyboardNatives(canvas);
const events = keyboard.enableTextEvents();
const gl = canvas.getContext('webgl2');
const archives = ['qualification.jar', 'startup-input-view.jar', 'play-entry.jar', 'animation-entry.jar', 'animation-view.jar', 'animation-sdk-view.jar', 'path-view.jar', 'float-bridge.jar', 'memory-bridge.jar', 'world-entry.jar', 'atomic-view.jar'];

globalThis.backend = events;
globalThis.records = [];
events.focusText();

try {
    const ownedRoot = new URL(location.href).searchParams.get('root');

    if (!/^\/files\/display-init\/[a-f\d-]+$/u.test(ownedRoot)) {
        throw new Error('Fresh owned display startup path required');
    }

    await cheerpjInit({
        version: 17,
        status: 'none',
        javaProperties: [`user.home=${ownedRoot}/home`],
        natives: {
            ...graphics.natives,
            ...clock.natives,
            ...keyboard.natives,
            /**
             * Waits at the existing original queue qualification's input boundary.
             *
             * @param {object} _lib - Native library.
             * @param {number} phase - Ordered input phase.
             * @returns {Promise<void>} Owned driver completion.
             */
            Java_KeyboardEventsQualification_ready(_lib, phase) {
                globalThis.phase = phase;

                return new Promise((resolve) => {
                    globalThis.resume = resolve;
                });
            },
            /**
             * Records exact original queue observations.
             *
             * @param {object} _lib - Native library.
             * @param {string} text - Actual Java observation.
             */
            Java_KeyboardEventsQualification_report(_lib, text) {
                const row = JSON.parse(String(text));

                globalThis.records.push(row);

                if ('pass' in row) {
                    globalThis.queueResult = row;
                }
            },
            /**
             * Lets the Java startup fixture require the queue proof's actual result.
             *
             * @returns {boolean} Actual observed queue qualification result.
             */
            Java_DisplayInitQualification_queuePassed() {
                return globalThis.queueResult?.pass === true;
            },
            /**
             * Observes the real surface after original Display operations.
             *
             * @param {object} _lib - Native library.
             * @param {number} width - Expected original requested width.
             * @param {number} height - Expected original requested height.
             * @returns {boolean} Actual browser surface state.
             */
            Java_DisplayInitQualification_observe(_lib, width, height) {
                return canvas.width === width && canvas.height === height
                    && gl.drawingBufferWidth === width && gl.drawingBufferHeight === height
                    && document.title === 'Project Zomboid' && document.fullscreenElement === null
                    && !gl.isContextLost() && gl.getError() === 0;
            },
            /**
             * Records completed actual Java startup assertions.
             *
             * @param {object} _lib - Native library.
             * @param {string} text - Actual Java result.
             */
            Java_DisplayInitQualification_report(_lib, text) {
                globalThis.javaResult = JSON.parse(String(text));
            },
        },
    });
    const repair = installUnsafeShortRepair(globalThis.cj3Module);
    const exit = await cheerpjRunMain('DisplayInitQualification', archives.map((name) => `/app/${name}`).join(':'), ownedRoot);

    globalThis.result = {
        pass: exit === 0 && globalThis.javaResult?.pass === true && globalThis.queueResult?.pass === true,
        exit, java: globalThis.javaResult, queue: globalThis.queueResult, records: globalThis.records,
        clock: clock.snapshot(), repair, contextLost: gl.isContextLost(), resources: graphics.resources(),
    };
} catch (error) {
    globalThis.result = { pass: false, error: String(error.stack || error), records: globalThis.records };
} finally {
    keyboard.dispose();
    document.title = title;
    globalThis.result.inputDisposed = events.snapshot();
    globalThis.result.titleRestored = document.title === title;
    globalThis.completed = true;
}
