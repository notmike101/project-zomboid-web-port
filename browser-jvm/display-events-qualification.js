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
const archives = ['qualification.jar', 'cursor-view.jar', 'display-events-view.jar', 'controller-view.jar', 'clipboard-view.jar', 'startup-input-view.jar', 'menu-mouse-view.jar', 'animation-entry.jar', 'animation-view.jar', 'animation-sdk-view.jar', 'path-view.jar', 'float-bridge.jar', 'memory-bridge.jar', 'world-entry.jar', 'atomic-view.jar'];
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
const cursorEvidence = { observations: [], pixelChecks: [] };

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
             * Records original cursor consumer completion.
             *
             * @param {object} lib - Current Java context.
             * @param {string} value - Java report JSON.
             */
            Java_CustomCursorQualification_report(lib, value) {
                cursorEvidence.java = JSON.parse(String(value));
            },
            /**
             * Observes actual CSS image selection and ownership.
             *
             * @param {object} lib - Current Java context.
             * @param {number} phase - Expected image lifecycle phase.
             * @returns {boolean} Actual observation.
             */
            Java_CustomCursorQualification_observe(lib, phase) {
                const state = display.cursorSnapshot();
                const computed = getComputedStyle(canvas).cursor;
                const images = state.images.map((image) => ({ url: image.url, width: image.width, height: image.height, x: image.x, y: image.y, bytes: image.pixels.length }));

                cursorEvidence.observations.push({ phase, ...state, images, computed });

                if (phase === 1) {
                    return state.mode === 212_993 && state.selected === images[1]?.url && computed.includes(state.selected) && images[1]?.x === 1 && images[1]?.y === 1 && images[1]?.width === 32 && images[1]?.height === 32;
                }

                if (phase === 2) {
                    return state.mode === 212_993 && state.selected === images[0]?.url && computed.includes(state.selected);
                }

                if (phase === 3) {
                    return state.mode === 212_994 && computed === 'none';
                }

                if (phase === 4) {
                    return state.selected === null && computed === 'default' && state.owned === 1 && state.revoked === 1;
                }

                if (phase === 5) {
                    return state.owned === 0 && state.revoked === 2 && computed === 'default';
                }

                if (phase === 6) {
                    return state.owned === 1 && state.selected === images[0]?.url && computed.includes(state.selected) && images[0]?.x === 0 && images[0]?.y === 0 && images[0]?.width === 2;
                }

                return state.owned === 0 && state.revoked === 3 && computed === 'default';
            },
            /**
             * Compares vendor pixels with browser image encoding.
             *
             * @param {object} lib - Current Java context.
             * @param {number} index - Pixel case index.
             * @param {number[]} expected - Original vendor RGBA.
             * @returns {Promise<boolean>} Actual observation.
             */
            async Java_CustomCursorQualification_pixels(lib, index, expected) {
                const item = index === 2 ? display.cursorSnapshot().images.find((value) => value.width === 2) : display.cursorSnapshot().images[index];
                const decoded = new Image();

                decoded.src = item.url;
                await decoded.decode();
                const observer = document.createElement('canvas');

                observer.width = item.width;
                observer.height = item.height;
                const observerContext = observer.getContext('2d');

                observerContext.drawImage(decoded, 0, 0);
                const decodedPixels = Array.from(observerContext.getImageData(0, 0, item.width, item.height).data);
                const actual = item?.pixels;
                const wanted = Uint8Array.from(expected);
                const rawMatch = actual?.length === wanted.length && actual.every((value, offset) => value === wanted[offset]);
                const decodedMatch = decodedPixels.length === wanted.length && decodedPixels.every((value, offset) => (offset % 4 === 3 || wanted[offset - offset % 4 + 3] === 255) ? value === wanted[offset] : true);
                const opaqueWhite = Array.from({ length: wanted.length / 4 }, (_, pixel) => pixel * 4).some((offset) => [0, 1, 2, 3].every((channel) => wanted[offset + channel] === 255));
                const match = rawMatch && decodedMatch && (index !== 2 || opaqueWhite);
                /**
                 * Hashes one pixel buffer.
                 *
                 * @param {number[]|Uint8Array} bytes - Actual pixel bytes.
                 * @returns {Promise<string>} Actual observation.
                 */
                const digest = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))), (value) => value.toString(16).padStart(2, '0')).join('');

                cursorEvidence.pixelChecks.push({ index, bytes: wanted.length, match, rawMatch, decodedMatch, opaqueWhite, expectedSHA: await digest(wanted), actualSHA: await digest(actual || []), decodedSHA: await digest(decodedPixels || []) });

                return match;
            },
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
        contextLost: gl.isContextLost(), trace: globalThis.trace, cursorEvidence, cursors: display.cursorSnapshot(),
    });
    globalThis.done = true;
}
