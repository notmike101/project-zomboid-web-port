import { createEngine } from './engine.js';
import { createModHost } from './mods.js';
import { createRenderer, worldFromCanvas } from './renderer.js';

const canvas = document.querySelector('#world');
const state = document.querySelector('#state');
const error = document.querySelector('#error');
const diagnostics = document.querySelector('#diagnostics');
const pauseButton = document.querySelector('#pause');
const modCheckbox = document.querySelector('#mod');
const imageInput = document.querySelector('#image');
const directionButtons = document.querySelectorAll('[data-walk]');
const held = new Set();
const keys = new Map([
    ['w', [0, -1]], ['arrowup', [0, -1]], ['s', [0, 1]], ['arrowdown', [0, 1]],
    ['a', [-1, 0]], ['arrowleft', [-1, 0]], ['d', [1, 0]], ['arrowright', [1, 0]],
]);
let engine;
let renderer;
let mods;
let paused = false;
let failed = false;
let lastFrame;
let accumulator = 0;
let lastAnnouncement = '';
let animation;
let toggledDirection;

/**
 * Report failure without concealing unavailable WebGPU.
 *
 * @param {Error} cause - Failure to report.
 * @returns {void} Stops simulation.
 */
function report(cause) {
    error.hidden = false;
    error.textContent = cause.message ?? String(cause);
    failed = true;
    engine?.command({ type: 'cancel' });
    state.textContent = 'Simulation stopped. See the error message.';
    refresh();
}

/**
 * Refresh detached engine/backend evidence and accessible status.
 *
 * @returns {void} Updates HTML status.
 */
function refresh() {
    if (!engine) {
        return;
    }

    const snapshot = engine.snapshot();

    for (const button of directionButtons) {
        button.setAttribute('aria-pressed', String(snapshot.action === 2 && toggledDirection === button.dataset.walk));
    }

    diagnostics.textContent = JSON.stringify({
        engine: snapshot, renderer: renderer?.diagnostics(), mods: mods?.diagnostics(),
        paused, failed, hidden: document.hidden, fixedStepSeconds: 1 / 60,
    }, null, 2);
    const actionName = ['idle', 'traveling to destination', 'toggle/manual walking'][snapshot.action];
    const description = `Position ${snapshot.x.toFixed(2)}, ${snapshot.y.toFixed(2)} · ${actionName} · speed ${snapshot.speed.toFixed(2)} units/s${paused ? ' · paused' : ''}${failed ? ' · stopped' : ''}`;

    if (description !== lastAnnouncement) {
        state.textContent = description;
        lastAnnouncement = description;
    }
}

/**
 * Clear resolved input/import errors without hiding a fatal backend failure.
 *
 * @returns {void} Removes obsolete recoverable feedback.
 */
function clearRecoverableError() {
    if (!failed) {
        error.hidden = true;
        error.textContent = '';
    }
}

/**
 * Dispatch the same mod-aware action for all input sources.
 *
 * @param {object} action - Structured movement action.
 * @returns {import('./mods.js').ModCommandResult | undefined} Outcome, or no command when unavailable.
 */
function submit(action) {
    if (!mods || failed || (paused && action.type !== 'cancel')) {
        return;
    }

    try {
        const result = mods.command(action);

        clearRecoverableError();
        refresh();

        return result;
    } catch (cause) {
        error.hidden = false;
        error.textContent = cause.message;
    }
}

/**
 * Replace input ownership only after a non-keyboard action commits.
 *
 * @param {object} action - Requested pointer, form or toggle action.
 * @param {string} [direction] - Toggle heading to announce when not replaced.
 * @returns {void} Preserves held keys and assistance when vetoed or rejected.
 */
function takeover(action, direction) {
    const result = submit(action);

    if (result?.committed) {
        held.clear();
        toggledDirection = result.modifiedBy.length === 0 ? direction : undefined;
        refresh();
    }
}

/**
 * Stop held/manual and assisted movement. Safety cancellation is never vetoed.
 *
 * @returns {void} Leaves the engine idle.
 */
function stop() {
    held.clear();
    toggledDirection = undefined;
    engine?.command({ type: 'cancel' });
    refresh();
}

/**
 * Submit normalized combined keyboard input.
 *
 * @returns {void} Changes movement direction.
 */
function manual() {
    let x = 0;
    let y = 0;

    for (const key of held) {
        const direction = keys.get(key);

        x += direction[0];
        y += direction[1];
    }

    if (held.size === 0) {
        stop();
    } else if (submit({ type: 'walk', x, y })?.committed) {
        toggledDirection = undefined;
        refresh();
    }
}

/**
 * Advance fixed-step simulation independently of presentation rate.
 *
 * @param {number} time - RAF timestamp in milliseconds.
 * @returns {void} Schedules the next presentation.
 */
function frame(time) {
    if (failed) {
        return;
    }

    const elapsed = lastFrame === undefined ? 0 : Math.min(0.1, Math.max(0, (time - lastFrame) / 1_000));

    lastFrame = time;

    if (!paused && !document.hidden) {
        accumulator += elapsed;
        while (accumulator >= 1 / 60) {
            engine.step(1 / 60);
            accumulator -= 1 / 60;
        }
    } else {
        accumulator = 0;
    }

    renderer.render(engine.snapshot());

    if (Math.floor(time / 500) !== Math.floor((time - elapsed * 1_000) / 500)) {
        refresh();
    }

    animation = requestAnimationFrame(frame);
}

/**
 * Decode selected local content without uploading or retaining it after reload.
 *
 * @returns {Promise<void>} Resolves after upload or a visible import error.
 */
async function importImage() {
    const file = imageInput.files[0];

    if (!file || !renderer || failed) {
        return;
    }

    imageInput.disabled = true;
    try {
        const asset = await renderer.importImage(file);

        clearRecoverableError();

        document.querySelector('#asset').textContent = `${asset.name} · ${asset.width} × ${asset.height} · ${asset.sourceBytes} source bytes · ${asset.textureBytes} texture bytes. Local memory only; reimport after reload.`;
        refresh();
    } catch (cause) {
        if (!failed) {
            error.hidden = false;
            error.textContent = cause.message;
        }
    } finally {
        imageInput.disabled = false;
        imageInput.value = '';
    }
}

/**
 * Translate mouse/touch coordinates into an engine destination.
 *
 * @param {PointerEvent} event - Primary pointer action.
 * @returns {void} Submits destination movement.
 */
function pointDestination(event) {
    if (event.button !== 0) {
        return;
    }

    canvas.focus();
    const point = worldFromCanvas(canvas, event.clientX, event.clientY);

    takeover({ type: 'moveTo', x: point.x, y: point.y });
}

/**
 * Toggle one direction or immediately take over a different direction.
 *
 * @param {MouseEvent} event - Direction button activation.
 * @returns {void} Changes assisted movement.
 */
function toggleWalking(event) {
    const button = event.currentTarget;
    const [x, y] = button.dataset.walk.split(',').map(Number);

    if (engine?.snapshot().action === 2 && toggledDirection === button.dataset.walk) {
        stop();
    } else {
        takeover({ type: 'walk', x, y }, button.dataset.walk);
    }
}

/**
 * Travel using keyboard-accessible coordinate controls instead of the canvas.
 *
 * @param {SubmitEvent} event - Destination form submission.
 * @returns {void} Submits destination movement.
 */
function formDestination(event) {
    event.preventDefault();
    takeover({ type: 'moveTo', x: Number(document.querySelector('#target-x').value), y: Number(document.querySelector('#target-y').value) });
}

/**
 * Pause without preserving an action or accumulating elapsed time.
 *
 * @returns {void} Updates the pause control.
 */
function togglePause() {
    stop();
    paused = !paused;
    accumulator = 0;
    lastFrame = undefined;
    pauseButton.setAttribute('aria-pressed', String(paused));
    pauseButton.textContent = paused ? 'Resume simulation' : 'Pause simulation';
    refresh();
}

/**
 * Cancel globally or take manual control when the canvas has keyboard focus.
 *
 * @param {KeyboardEvent} event - Keyboard press.
 * @returns {void} Submits keyboard movement or safety cancellation.
 */
function keyDown(event) {
    const key = event.key.toLowerCase();

    if (key === 'escape') {
        stop();

        return;
    }

    if (document.activeElement !== canvas || !keys.has(key)) {
        return;
    }

    event.preventDefault();

    if (!event.repeat) {
        held.add(key);
        manual();
    }
}

/**
 * Release a movement key without leaving manual travel active.
 *
 * @param {KeyboardEvent} event - Keyboard release.
 * @returns {void} Recomputes the held direction.
 */
function keyUp(event) {
    const key = event.key.toLowerCase();

    if (!held.has(key)) {
        return;
    }

    held.delete(key);
    manual();
}

/**
 * Discard background elapsed time and actions.
 *
 * @returns {void} Cancels travel on visibility transitions.
 */
function visibilityChanged() {
    stop();
    accumulator = 0;
    lastFrame = undefined;
}

/**
 * Enable or cleanly dispose the bundled trusted example mod.
 *
 * @returns {Promise<void>} Resolves after activation/cleanup or reported failure.
 */
async function toggleMod() {
    if (!mods || failed) {
        return;
    }

    modCheckbox.disabled = true;
    stop();
    try {
        if (modCheckbox.checked) {
            await mods.load(new URL('../mods/accessible-walking/main.js', import.meta.url).href);
        } else {
            mods.dispose();
        }

        clearRecoverableError();

        document.querySelector('#mod-status').textContent = modCheckbox.checked ? 'Active: movement speed changed inside WASM by the public mod API.' : 'Disabled: cleanup restored the base WASM speed.';
    } catch (cause) {
        modCheckbox.checked = false;

        if (!failed) {
            error.hidden = false;
            error.textContent = cause.message;
        }
    } finally {
        modCheckbox.disabled = false;
        refresh();
    }
}

/**
 * Stop presentation and release resources unless retained in the back/forward cache.
 *
 * @param {PageTransitionEvent} event - Page suspension/unload.
 * @returns {void} Stops the session or suspends it safely.
 */
function pageHidden(event) {
    cancelAnimationFrame(animation);
    stop();

    if (!event.persisted) {
        mods?.dispose();
        renderer?.destroy();
    }
}

/**
 * Resume a cached page without offline catch-up.
 *
 * @param {PageTransitionEvent} event - Page restoration.
 * @returns {void} Restarts cached presentation.
 */
function pageShown(event) {
    if (event.persisted && !failed && renderer) {
        accumulator = 0;
        lastFrame = undefined;
        animation = requestAnimationFrame(frame);
    }
}

try {
    engine = await createEngine(new URL('../engine/pz_engine.wasm', import.meta.url));
    mods = createModHost(engine);
    renderer = await createRenderer(canvas, report);
    // Restored browser form state must never claim an active mod before startup succeeded.
    modCheckbox.checked = false;
    modCheckbox.disabled = false;
    refresh();
    animation = requestAnimationFrame(frame);
} catch (cause) {
    report(cause);
}

imageInput.addEventListener('change', importImage);
canvas.addEventListener('pointerdown', pointDestination);

for (const button of directionButtons) {
    button.addEventListener('click', toggleWalking);
}

document.querySelector('#destination').addEventListener('submit', formDestination);
document.querySelector('#stop').addEventListener('click', stop);
pauseButton.addEventListener('click', togglePause);
document.addEventListener('keydown', keyDown);
document.addEventListener('keyup', keyUp);
globalThis.addEventListener('blur', stop);
document.addEventListener('visibilitychange', visibilityChanged);
modCheckbox.addEventListener('change', toggleMod);
document.querySelector('#refresh').addEventListener('click', refresh);
globalThis.addEventListener('pagehide', pageHidden);
globalThis.addEventListener('pageshow', pageShown);
