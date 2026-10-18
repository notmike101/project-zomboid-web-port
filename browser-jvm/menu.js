import { createBrowserClock } from './browser-clock.js';
import { createBrowserMouse } from './browser-mouse.js';
import { createBrowserPhysics } from './browser-physics.js';
import { createFileWatchNatives } from './file-watch-natives.js';
import { keyboardNatives } from './keyboard.js';
import { installNativeLibraryLoader } from './native-library-loader.js';
import { createProcessNatives } from './process-natives.js';
import { startSchedulerRuntime } from './scheduler-runtime.js';
import { createSpriteNatives } from './sprite-webgl.js';
import { reserveSqliteNamespace } from './sqlite-namespace.js';
import { installUnsafeShortRepair } from './unsafe-short-repair.js';

const canvas = document.querySelector('canvas');
const graphics = createSpriteNatives(canvas);
const keyboard = keyboardNatives(canvas);
const mouse = createBrowserMouse(canvas);
const clock = createBrowserClock();
const physics = createBrowserPhysics();
const watch = createFileWatchNatives();
const processes = createProcessNatives();
const stop = document.querySelector('#stop');
const status = document.querySelector('#status');
const events = keyboard.enableTextEvents();

/**
 * Focuses text input after the actual mouse owner has queued the final release.
 *
 * @param {MouseEvent} event - Completed canvas mouse release.
 */
function focusKeyboard(event) {
    if (event.target === canvas && mouse.snapshot().held.length === 0) {
        events.focusText();
    }
}

globalThis.addEventListener('mouseup', focusKeyboard);
let stopping = false;
let releaseCapture;

globalThis.menuCaptureRequested = false;
globalThis.menuCaptureHeld = false;
/** Releases the browser owner's completed-frame observation barrier. */
globalThis.releaseMenuCapture = () => {
    globalThis.menuCaptureRequested = false;
    globalThis.menuCaptureHeld = false;
    releaseCapture?.();
    releaseCapture = undefined;
};

globalThis.stageResults = [];
stop.addEventListener('click', () => {
    globalThis.releaseMenuCapture();
    stopping = true;
    stop.disabled = true;
    status.textContent = 'Finishing original menu exit';
});

try {
    await reserveSqliteNamespace();
    await startSchedulerRuntime({
        version: 17,
        status: 'none',
        javaProperties: ['user.dir=/files/work', 'user.home=/files/menu-home'],
        natives: {
            ...graphics.natives,
            ...keyboard.natives,
            ...mouse.natives,
            ...clock.natives,
            ...physics.natives,
            ...watch.natives,
            ...processes.natives,
            /**
             * Reads the explicit browser owner's stop request.
             *
             * @returns {boolean} Whether the user requested session cleanup.
             */
            Java_BrowserMenu_stopping() {
                return stopping;
            },
            /**
             * Receives actual original front-end lifecycle observations.
             *
             * @param {object} _library - Native library context.
             * @param {string} text - Authored JSON observation.
             * @returns {Promise<void>|undefined} A requested completed-frame capture barrier.
             */
            Java_BrowserMenu_report(_library, text) {
                const value = JSON.parse(String(text));

                if (value.snapshot) {
                    globalThis.menuSnapshot = value;
                    stop.disabled = false;
                    status.textContent = `Original menu frame ${value.frames}`;

                    if (globalThis.menuCaptureRequested) {
                        globalThis.menuCaptureHeld = true;

                        return new Promise((resolve) => {
                            releaseCapture = resolve;
                        });
                    }
                } else {
                    globalThis.stageResults.push(value);

                    if (value.progress) {
                        status.textContent = value.progress;
                        console.info(`MENU_STAGE ${value.progress}`);
                    }

                    if ('pass' in value) {
                        globalThis.probeResult = value;
                    }
                }
            },
        },
    });
    installUnsafeShortRepair(globalThis.cj3Module);
    installNativeLibraryLoader(globalThis.cj3Module);
    watch.install();
    const archives = ['menu-entry.jar', 'menu-clipboard-view.jar', 'clipper2.jar', 'menu-mouse-view.jar', 'menu-input-view.jar', 'animation-entry.jar', 'animation-view.jar', 'animation-sdk-view.jar', 'path-view.jar', 'float-bridge.jar', 'memory-bridge.jar', 'world-entry.jar', 'atomic-view.jar'];

    globalThis.exit = await cheerpjRunMain('BrowserMenu', archives.map((name) => `/app/${name}`).join(':'), `/files/sqlite-owned/${crypto.randomUUID()}`);
} catch (error) {
    globalThis.probeResult = { pass: false, error: String(error.stack || error) };
} finally {
    try {
        watch.dispose();
        globalThis.menuWatch = { ...watch.diagnostics(), disposed: true };
    } catch (error) {
        globalThis.menuWatch = { ...watch.diagnostics(), disposed: false, error: String(error) };
        globalThis.probeResult = { pass: false, error: `Original watch cleanup failed: ${error}` };
    }

    globalThis.removeEventListener('mouseup', focusKeyboard);
    globalThis.menuProcesses = processes.diagnostics();
    keyboard.dispose();
    mouse.dispose();
    globalThis.menuInput = { keyboard: events.snapshot(), mouse: mouse.snapshot() };
    globalThis.menuGraphics = graphics.resources();
    const gl = canvas.getContext('webgl2');

    gl.getExtension('WEBGL_lose_context')?.loseContext();
    globalThis.menuContextLost = gl.isContextLost();
    globalThis.menuCompleted = true;
    stop.disabled = true;
    status.textContent = globalThis.probeResult?.pass ? 'Original menu exited' : 'Original menu boundary failed';
}
