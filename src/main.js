import { createAudio } from './audio.js';
import { openContentDirectory } from './content.js';
import { createEngine } from './engine.js';
import { openMapCell } from './map-tiles.js';
import { createModManager, parseModPackage, readPackageFile, resolveModOrder } from './mod-manager.js';
import { createModHost } from './mods.js';
import { loadNativeGameResources, seedOriginalWearables } from './native-game-resources.js';
import { bindNativeSession, closeNativeSession, discoverNativePackages, nativePackageFiles, prepareNativeSession } from './native-mod-loader.js';
import { openPack } from './packs.js';
import { createRenderer, worldFromCanvas } from './renderer.js';
import { createSaveStore } from './saves.js';
import { createTileLayer } from './tile-renderer.js';
import { loadNativeTileRegistry, projectWorldObjects } from './world-objects.js';
import { stageCells } from './world-session.js';

const canvas = document.querySelector('#world');
const state = document.querySelector('#state');
const error = document.querySelector('#error');
const diagnostics = document.querySelector('#diagnostics');
const pauseButton = document.querySelector('#pause');
const pauseMenu = document.querySelector('#pause-menu');
const openPauseButton = document.querySelector('#open-pause');
const loading = document.querySelector('#loading');
const modCheckbox = document.querySelector('#mod');
const directionButtons = document.querySelectorAll('[data-walk]');
const packageControls = document.querySelector('#package-controls');
const packageList = document.querySelector('#package-list');
const packageStatus = document.querySelector('#package-status');
const packageError = document.querySelector('#package-error');
const packageActivation = document.querySelector('#package-activation');
const safeMods = new URL(globalThis.location.href).searchParams.has('safe-mods');
const FIXED_STEP_SECONDS = 1 / 60;
const held = new Set();
const keys = new Map([
    ['w', [0, -1]], ['arrowup', [0, -1]], ['s', [0, 1]], ['arrowdown', [0, 1]],
    ['a', [-1, 0]], ['arrowleft', [-1, 0]], ['d', [1, 0]], ['arrowright', [1, 0]],
]);
let engine;
let renderer;
let mods;
let packages;
const engineSource = new URL('../engine/pz_engine.wasm', import.meta.url);
let saves;
let worldCells = [];
let savedModState = Object.create(null);
let sessionBusy = false;
let autosave;
let sessionReady = false;
let content;
let startup = 'loading';
let savedRevision;
let retainedSave = false;
let tileLayer;
let importedPacks = [];
let geometryCells = [];
let nativePackages = [];
let luaSession;
let activeNativeDescriptors = [];
let gameUI;
let liveModContext;
let packageBusy = false;
let packagesActivated = false;
let paused = true;
let failed = false;
let lastFrame;
let accumulator = 0;
let lastAnnouncement = '';
let animation;
let toggledDirection;
let tileRegistry;
let audio;
let audioError;
let audioUnlocked = false;
let audioUnlock;
let audioResumeRequested = false;
let nextAudioSession = 1;
const baseAudioAssets = new Set();
let presentedX;
let presentedY;
let presentedFacing = 0;

/**
 * Keep optional decoder/autoplay failures visible without stopping committed gameplay.
 *
 * @param {unknown} cause - Real browser audio failure.
 * @returns {void} Retains diagnostic evidence.
 */
function reportAudioError(cause) {
    audioError = cause instanceof Error ? cause.message : String(cause);
}

/**
 * Stop voices synchronously; observe the browser's asynchronous suspend result.
 *
 * @returns {void} Stops optional playback.
 */
function pauseAudio() {
    audioUnlocked = false;
    audioResumeRequested = false;

    if (audio) {
        void audio.pause().catch(reportAudioError);
    }
}

/**
 * Resume only an already-created real context; creation belongs to trusted input.
 *
 * @returns {void} Observes asynchronous permission/native failures.
 */
function resumeAudio() {
    if (!audio || failed || paused || sessionBusy || document.hidden) {
        return;
    }

    if (audioUnlock) {
        audioResumeRequested = true;

        return;
    }

    audioUnlock = audio.unlock().then(() => {
        audioUnlocked = true;

        if (failed || paused || sessionBusy || document.hidden) {
            pauseAudio();
        }
    }).catch(reportAudioError).finally(() => {
        audioUnlock = undefined;

        if (audioResumeRequested) {
            audioResumeRequested = false;
            resumeAudio();
        }
    });
}

/**
 * Create the real AudioContext lazily, then decode only explicit original WAV roles.
 *
 * @param {Event} event - First or subsequent trusted keyboard/pointer gesture.
 * @returns {void} Unlocks optional presentation, never a fake backend.
 */
function unlockAudio(event) {
    if (!event.isTrusted || failed || !sessionReady) {
        return;
    }

    if (!audio) {
        try {
            audio = createAudio();
            setAudioListener(engine.snapshot());

            for (const role of ['footstep', 'doorOpen', 'doorClose']) {
                const path = content.manifest.startup.audio?.[role];

                if (!path) {
                    reportAudioError(new Error(`Original audio role ${role} is not provisioned.`));
                    continue;
                }

                void (async () => {
                    const bytes = await content.getFile(path).arrayBuffer();

                    await audio.load(`base:${role}`, bytes, { owner: 'base' });
                    baseAudioAssets.add(role);
                })().catch(reportAudioError);
            }
        } catch (cause) {
            reportAudioError(cause);
        }
    }

    resumeAudio();
}

/**
 * Match the rendered actor's retained horizontal facing and world position.
 *
 * @param {{x: number, y: number}} position - Current native actor coordinates.
 * @returns {void} Updates the real positional listener when present.
 */
function setAudioListener(position) {
    if (!audio) {
        return;
    }

    try {
        audio.setListener({
            x: position.x, y: position.y, z: 0,
            forwardX: Math.cos(presentedFacing), forwardY: Math.sin(presentedFacing),
        });
    } catch (cause) {
        reportAudioError(cause);
    }
}

/**
 * Isolate every mod owner across candidate activation and cutover, while sharing base cues.
 * Staged hosts cannot register/play; rollback cleanup addresses only their private namespace.
 *
 * @param {object} binding - Session-owned engine/context.
 * @returns {object} Real adapter forwarding, available after the first trusted gesture.
 */
function sessionAudio(binding) {
    const prefix = `session${nextAudioSession++}:`;
    const assets = new Map();
    /**
     * Preserve shared base cue ids and namespace every session-owned asset.
     *
     * @param {string} id - Qualified public asset identity.
     * @returns {string} Shared base identity or private session registration id.
     */
    const assetId = (id) => {
        if (id.startsWith('base:')) {
            return id;
        }

        if (!assets.has(id)) {
            assets.set(id, `${prefix}asset${assets.size + 1}`);
        }

        return assets.get(id);
    };

    /**
     * Isolate one mod owner's registrations and voices within this session.
     *
     * @param {string} owner - Exact public mod owner.
     * @returns {string} Private session owner identity.
     */
    const ownerId = (owner) => `${prefix}${owner}`;
    /**
     * Refuse staged or replaced sessions before forwarding to the real adapter.
     *
     * @returns {object} Committed session's real audio adapter.
     */
    const requireLive = () => {
        if (!audio || binding !== liveModContext) {
            throw new Error('Audio requires a committed session and a trusted user gesture.');
        }

        return audio;
    };

    return {
        /**
         * Decode into this session's private registry while returning public identities.
         *
         * @param {string} id - Qualified public asset identity.
         * @param {ArrayBuffer} bytes - Encoded audio consumed by native decoding.
         * @param {{owner: string, override?: boolean}} options - Public owner and replacement policy.
         * @returns {Promise<import('../types/mod-api').ModAudioAsset>} Decoded metadata with public ids.
         */
        load: async (id, bytes, options) => {
            const adapter = requireLive();
            const result = await adapter.load(assetId(id), bytes, { ...options, owner: ownerId(options.owner) });

            return { ...result, id, owner: options.owner };
        },
        /**
         * Play a local or shared cue with voices owned by this session's mod.
         *
         * @param {string} id - Qualified local or shared asset identity.
         * @param {import('../types/mod-api').ModAudioPosition & {owner: string}} options - Public voice owner and playback settings.
         * @returns {import('../types/mod-api').ModAudioVoice} Stoppable real audio voice.
         */
        play: (id, options) => requireLive().play(assetId(id), { ...options, owner: ownerId(options.owner) }),
        /**
         * Remove only this owner's registration from the session namespace.
         *
         * @param {string} id - Qualified public asset identity.
         * @param {{owner: string}} options - Exact public registration owner.
         * @returns {boolean} Whether a decoded or pending registration was removed.
         */
        unload: (id, options) => requireLive().unload(assetId(id), { owner: ownerId(options.owner) }),
        /**
         * Release this session owner's audio without touching shared base cues.
         *
         * @param {string} owner - Exact public mod owner.
         * @returns {void} Stops owned voices and cancels pending registrations when audio exists.
         */
        unloadOwner: (owner) => audio?.unloadOwner(ownerId(owner)),
    };
}

/**
 * Play only decoded base cues in the committed, running session.
 *
 * @param {object} binding - Engine owner.
 * @param {string} role - Explicit legacy original WAV role.
 * @param {{x: number, y: number, z?: number}} position - Native world position.
 * @returns {void} Reports real browser failures without mutating simulation.
 */
function playBaseCue(binding, role, position) {
    if (binding !== liveModContext || !audioUnlocked || paused || sessionBusy || failed || document.hidden
        || !baseAudioAssets.has(role)) {
        return;
    }

    try {
        audio.play(`base:${role}`, { owner: 'base', x: position.x, y: position.y, z: position.z ?? 0 });
    } catch (cause) {
        reportAudioError(cause);
    }
}

/**
 * Observe only committed native mutations, including mod-submitted and rewritten actions.
 *
 * @param {object} binding - Session-owned engine.
 * @param {object} action - Validated command after precommit hooks.
 * @returns {object} Authoritative command result.
 */
function sessionCommand(binding, action) {
    const before = action.type === 'toggleDoor' ? binding.engine.doors() : undefined;
    const result = binding.engine.command(action);

    if (before && binding === liveModContext) {
        const old = new Map(before.map((door) => [door.id, door]));

        for (const door of binding.engine.doors()) {
            if (old.get(door.id)?.open !== door.open) {
                playBaseCue(binding, door.open ? 'doorOpen' : 'doorClose', door);
            }
        }
    }

    return result;
}

/**
 * Accumulate only real accepted simulation displacement, not requested movement or wall contact.
 *
 * @param {object} binding - Session-owned engine.
 * @param {number} seconds - Accepted fixed step duration.
 * @returns {void} Advances native simulation and optional footsteps.
 */
function sessionStep(binding, seconds) {
    const before = binding.engine.snapshot();

    binding.engine.step(seconds);

    if (binding !== liveModContext) {
        return;
    }

    const after = binding.engine.snapshot();
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    const distance = Math.hypot(dx, dy);

    if (distance > 1e-6) {
        // Port presentation cadence: one legacy sample per 0.75 real world units.
        binding.stepDistance = (binding.stepDistance ?? 0) + distance;
        while (binding.stepDistance >= 0.75) {
            binding.stepDistance -= 0.75;
            playBaseCue(binding, 'footstep', after);
        }
    }
}

/**
 * Report failure without concealing unavailable WebGPU.
 *
 * @param {Error} cause - Failure to report.
 * @returns {void} Stops simulation.
 */
function report(cause) {
    if (failed) {
        return;
    }

    error.hidden = false;
    error.textContent = cause.message ?? String(cause);
    failed = true;
    paused = true;
    pauseAudio();
    held.clear();
    toggledDirection = undefined;

    if (pauseMenu.open) {
        pauseMenu.close();
    }

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
    loading.hidden = sessionReady || failed || startup === 'blocked';
    openPauseButton.hidden = startup === 'loading';
    openPauseButton.disabled = failed;
    openPauseButton.setAttribute('aria-expanded', String(pauseMenu.open));
    pauseButton.disabled = !sessionReady || sessionBusy || failed;

    if (!engine) {
        return;
    }

    const snapshot = engine.snapshot();

    for (const button of directionButtons) {
        button.setAttribute('aria-pressed', String(snapshot.action === 2 && toggledDirection === button.dataset.walk));
    }

    const tiles = tileLayer?.diagnostics();

    if (!failed && tiles?.errors.length > 0) {
        report(new Error(`Required original tile content is unavailable: ${tiles.errors.map(({ source, message }) => `${source}: ${message}`).join('; ')}. Provision the missing content and reload the page.`));

        return;
    }

    diagnostics.textContent = JSON.stringify({
        engine: snapshot, renderer: renderer?.diagnostics(), mods: mods?.diagnostics(),
        packages: packages?.diagnostics(), nativePackages, lua: luaSession?.diagnostics(), safeMods,
        startup, sessionReady, savedRevision, navigationCells: worldCells.map(({ x, y }) => ({ x, y })),
        tiles: tiles ? { cells: geometryCells.length, ...tiles } : null,
        audio: audio ? { ...audio.diagnostics(), integrationError: audioError } : { contextState: 'not-created', integrationError: audioError },
        paused, failed, hidden: document.hidden, fixedStepSeconds: 1 / 60,
    }, null, 2);
    const actionName = ['idle', 'traveling to destination', 'toggle/manual walking'][snapshot.action];
    let description;

    if (!sessionReady) {
        description = startup === 'blocked'
            ? 'Startup stopped. Resolve the reported issue or explicitly start a new session; retained saves are untouched.'
            : 'Loading local content and retained save; simulation is paused.';
    } else {
        description = `Position ${snapshot.x.toFixed(2)}, ${snapshot.y.toFixed(2)} · ${actionName} · speed ${snapshot.speed.toFixed(2)} units/s${paused ? ' · paused' : ''}${failed ? ' · stopped' : ''}`;
    }

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
    if (!mods || !sessionReady || sessionBusy || failed || (paused && action.type !== 'cancel')) {
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

    if (sessionReady && !sessionBusy && !paused && !document.hidden) {
        accumulator += elapsed;
        while (accumulator >= FIXED_STEP_SECONDS) {
            mods.step(FIXED_STEP_SECONDS);
            accumulator -= FIXED_STEP_SECONDS;
        }
    } else {
        accumulator = 0;
    }

    if (sessionReady && !sessionBusy) {
        try {
            const snapshot = engine.snapshot();
            const dx = presentedX === undefined ? 0 : snapshot.x - presentedX;
            const dy = presentedY === undefined ? 0 : snapshot.y - presentedY;

            renderer.render(snapshot);

            if (Math.hypot(dx, dy) > 1e-6) {
                presentedFacing = Math.atan2(dy, dx);
            }

            if (presentedX !== snapshot.x || presentedY !== snapshot.y) {
                setAudioListener(snapshot);
            }

            presentedX = snapshot.x;
            presentedY = snapshot.y;
            canvas.style.cursor = gameUI?.cursorVisible() ? 'default' : '';
        } catch (cause) {
            report(cause);

            return;
        }
    }

    if (Math.floor(time / 500) !== Math.floor((time - elapsed * 1_000) / 500)) {
        refresh();
    }

    animation = requestAnimationFrame(frame);
}

/**
 * Keep package/storage failures separate from fatal rendering failures.
 *
 * @param {unknown} cause - Recoverable package failure.
 * @returns {void} Shows persistent package feedback.
 */
function reportPackageError(cause) {
    packageError.hidden = false;
    packageError.textContent = cause instanceof Error ? cause.message : String(cause);
}

/**
 * Show persisted configuration without pretending it is the running set.
 *
 * @returns {Promise<void>} Refreshes accessible package controls and evidence.
 */
async function refreshPackages() {
    const installed = await packages.list();
    const evidence = packages.diagnostics();
    const activation = evidence.lastActivation;
    const activeIds = new Set(mods.diagnostics().mods.map((entry) => entry.id));
    const entries = installed.map((entry) => {
        const item = document.createElement('li');
        const name = document.createElement('p');
        const label = document.createElement('label');
        const enabled = document.createElement('input');

        const nativeVersion = entry.settings?.nativeLua ? entry.settings.nativeVersion ?? 'unspecified' : entry.version;

        let packageState = 'inactive';

        if (activeIds.has(entry.id)) {
            packageState = 'active';
        } else if (activation?.errors.some((failure) => failure.id === entry.id)) {
            packageState = 'error';
        }

        name.textContent = `${entry.name} · ${nativeVersion} · ${packageState}`;
        enabled.type = 'checkbox';
        enabled.checked = entry.enabled;
        enabled.addEventListener('change', () => {
            const desired = enabled.checked;

            enabled.checked = entry.enabled;

            void changePackage(() => packages.setEnabled(entry.id, desired), `${entry.name}: ${desired ? 'enabled' : 'disabled'} for the next reload.`);
        });
        label.append(enabled, document.createTextNode(` Enable ${entry.name} after reload`));
        item.append(name, label);

        return item;
    });

    packageList.replaceChildren(...entries);

    if (installed.length === 0 && nativePackages.length === 0) {
        const empty = document.createElement('li');

        empty.textContent = 'No local mod packages installed.';
        packageList.append(empty);
    }

    for (const entry of nativePackages) {
        const item = document.createElement('li');

        const active = mods.diagnostics().mods.some((mod) => mod.id === entry.id);
        const failure = evidence.errors.findLast((cause) => cause.id === entry.id);

        let nativeState = entry.blocked ?? 'inactive; enable the package above and reload';

        if (active) {
            nativeState = 'active';
        } else if (failure) {
            nativeState = `error: ${failure.message}`;
        }

        item.textContent = `${entry.nativeId} · ${entry.nativeVersion ?? 'version unspecified'} · ${entry.tree} · ${entry.fileCount} indexed files · ${nativeState}`;
        packageList.append(item);
    }

    document.querySelector('#package-reload-status').textContent = evidence.requiresReload
        ? 'Reload to apply your changes.'
        : 'Changes apply after reloading.';
    packageActivation.textContent = JSON.stringify(activation ?? null);
    refresh();
}

/**
 * Serialize configuration writes and make rejected package operations recoverable.
 *
 * @param {() => Promise<unknown>} change - Installation or configuration mutation.
 * @param {string} message - Honest next-reload result.
 * @returns {Promise<void>} Completes after visible feedback.
 */
async function changePackage(change, message) {
    if (!packages || packageBusy || sessionBusy || startup === 'loading') {
        return;
    }

    packageBusy = true;
    packageControls.disabled = true;
    try {
        await change();
        packageError.hidden = true;
        packageError.textContent = '';
        packageStatus.textContent = message;
        await refreshPackages();
    } catch (cause) {
        reportPackageError(cause);
        refresh();
    } finally {
        packageBusy = false;
        packageControls.disabled = false;
    }
}

/**
 * Give original gameplay UI first refusal using canvas CSS coordinates.
 *
 * @param {MouseEvent|PointerEvent|WheelEvent} event - Native canvas input.
 * @param {string} name - Original UI callback name.
 * @param {...number} args - Movement delta or wheel amount.
 * @returns {boolean} Whether UI consumed the input.
 */
function gameUIPointer(event, name, ...args) {
    if (!gameUI || !sessionReady || sessionBusy || failed || pauseMenu.open) {
        return false;
    }

    const bounds = canvas.getBoundingClientRect();
    const width = canvas.clientWidth || canvas.width;
    const height = canvas.clientHeight || canvas.height;
    const x = (event.clientX - bounds.left) * width / bounds.width;
    const y = (event.clientY - bounds.top) * height / bounds.height;

    try {
        gameUI.setViewport(width, height);
        gameUI.setMouse(x, y);
        const consumed = gameUI.input(name, x, y, ...args);

        canvas.style.cursor = gameUI.cursorVisible() ? 'default' : '';

        if (consumed) {
            event.preventDefault();
        }

        return consumed;
    } catch (cause) {
        reportPackageError(cause);

        return true;
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

    if (gameUIPointer(event, 'onMouseDown')) {
        return;
    }

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

    resumeGame();

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
    resumeGame();
    takeover({ type: 'moveTo', x: Number(document.querySelector('#target-x').value), y: Number(document.querySelector('#target-y').value) });
}

/**
 * Open the native modal menu and cancel all movement.
 *
 * @returns {void} Pauses without preserving input.
 */
function openPauseMenu() {
    if (failed || pauseMenu.open) {
        return;
    }

    stop();
    paused = true;
    pauseAudio();
    accumulator = 0;
    lastFrame = undefined;
    pauseMenu.showModal();
    refresh();
}

/**
 * Close the menu and restore gameplay focus without catch-up.
 *
 * @returns {void} Resumes a ready session.
 */
function resumeGame() {
    if (sessionBusy || failed) {
        return;
    }

    paused = !sessionReady;
    accumulator = 0;
    lastFrame = undefined;

    if (pauseMenu.open) {
        pauseMenu.close();
    }

    if (sessionReady) {
        canvas.focus({ preventScroll: true });
    }

    resumeAudio();
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

    if (sessionReady && !paused && !failed && document.activeElement === canvas) {
        try {
            if (gameUI?.keyInput(event.repeat ? 'onKeyRepeat' : 'onKeyPress', event.keyCode)) {
                event.preventDefault();

                return;
            }

            luaSession?.dispatch(event.repeat ? 'OnKeyKeepPressed' : 'OnKeyPressed', event.keyCode);
        } catch (cause) {
            reportPackageError(cause);

            return;
        }
    }

    if (key === 'escape') {
        event.preventDefault();

        if (!event.repeat) {
            if (pauseMenu.open) {
                resumeGame();
            } else {
                openPauseMenu();
            }
        }

        return;
    }

    if (key === ' ' && document.activeElement === canvas) {
        event.preventDefault();
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

    if (sessionReady && !paused && !failed && document.activeElement === canvas) {
        try {
            if (gameUI?.keyInput('onKeyRelease', event.keyCode)) {
                event.preventDefault();

                if (held.delete(key)) {
                    manual();
                }

                return;
            }

            luaSession?.dispatch('OnKeyReleased', event.keyCode);
        } catch (cause) {
            reportPackageError(cause);

            if (held.delete(key)) {
                manual();
            }

            return;
        }
    }

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

    if (document.hidden) {
        pauseAudio();
    } else {
        resumeAudio();
    }

    accumulator = 0;
    lastFrame = undefined;
}

/**
 * Enable or cleanly dispose the bundled trusted example mod.
 *
 * @returns {Promise<void>} Resolves after activation/cleanup or reported failure.
 */
async function toggleMod() {
    if (!mods || !sessionReady || sessionBusy || failed || mods.diagnostics().mods.some((entry) => entry.url !== new URL('../mods/accessible-walking/main.js', import.meta.url).href)) {
        return;
    }

    modCheckbox.disabled = true;
    stop();
    try {
        if (modCheckbox.checked) {
            await mods.load(new URL('../mods/accessible-walking/main.js', import.meta.url).href);
        } else {
            closeNativeSession();
            luaSession = undefined;
            mods.dispose();
        }

        clearRecoverableError();

        document.querySelector('#mod-status').textContent = modCheckbox.checked ? 'Active: walking speed 2.25.' : 'Disabled: walking speed 1.5.';
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
    pauseAudio();

    if (!event.persisted) {
        try {
            closeNativeSession();
        } catch (cause) {
            reportPackageError(cause);
            closeNativeSession({ discardSaveData: true });
        }

        luaSession = undefined;
        mods?.dispose();
        renderer?.destroy();
        clearInterval(autosave);
        saves?.close();

        if (audio) {
            void audio.dispose().catch(reportAudioError);
        }
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
        resumeAudio();
    }
}

/**
 * Publish a fully validated WASM session and its staged original geometry.
 *
 * @param {object} staged - Fresh engine and imported cell sources.
 * @returns {void} Replaces only the authoritative simulation instance.
 */
function publishSession(staged) {
    if (failed) {
        throw new Error('Renderer is no longer active.');
    }

    renderer.setWorldLayer(staged.geometry.layer);
    tileLayer = staged.geometry.layer;
    geometryCells = staged.geometry.cells;
    worldCells = staged.cells;
    engine = staged.engine;
    sessionReady = true;
    startup = 'ready';
    clearRecoverableError();
    pauseButton.disabled = false;
    document.querySelector('#save-now').disabled = false;
    modCheckbox.checked = mods.diagnostics().mods.some((entry) => entry.url === new URL('../mods/accessible-walking/main.js', import.meta.url).href);
    modCheckbox.disabled = mods.diagnostics().mods.some((entry) => entry.url !== new URL('../mods/accessible-walking/main.js', import.meta.url).href);
    renderer.setWorldMode(worldCells.length > 0);
    accumulator = 0;
    lastFrame = undefined;
    const bounds = engine.worldBounds();

    for (const [axis, min, max] of [['x', bounds.minCx, bounds.maxCx], ['y', bounds.minCy, bounds.maxCy]]) {
        const input = document.querySelector(`#target-${axis}`);

        input.min = bounds.active ? min * 256 : 0;
        input.max = bounds.active ? (max + 1) * 256 - 0.001 : 10;
        input.value = engine.snapshot()[axis];
    }

    loading.hidden = true;
    refresh();
}

/**
 * Reject restores unless every saved mod has the exact running identity.
 *
 * @param {object[]} required - Saved mod provenance.
 * @param {object} [host] - Candidate host when validating an uncommitted transition.
 * @returns {void} Allows only a matching running set.
 */
function requireSessionMods(required, host = mods) {
    const active = new Map(host.diagnostics().mods.map((entry) => [entry.id, entry]));

    for (const saved of required) {
        const running = active.get(saved.id);

        if (!running || running.version !== saved.version || running.apiVersion !== saved.apiVersion) {
            throw new Error(`Save requires mod ${saved.id} ${saved.version}; enable the matching version and reload. Saved namespaces are retained.`);
        }
    }

    if (active.size !== required.length) {
        throw new Error('Running mod set differs from this save. Adjust enabled packages and reload before restoring.');
    }
}

/**
 * Bind one host to its own engine and namespace backing throughout staging or rollback.
 *
 * @param {object} binding - Session-owned engine, cells and namespaces.
 * @returns {object} Existing public mod host.
 */
function createSessionModHost(binding) {
    // Each callback retains this binding, including while a different session is staged.
    return createModHost({
        /**
         * Read this host's own authoritative engine.
         *
         * @returns {object} Detached snapshot.
         */
        snapshot: () => binding.engine.snapshot(),
        /**
         * Submit through this session's authoritative engine, never a global replacement.
         *
         * @param {object} action - Validated mod action.
         * @returns {object} Post-command snapshot.
         */
        command: (action) => sessionCommand(binding, action),
        /**
         * Read detached door state from this host's authoritative engine.
         *
         * @returns {object[]} Stable native door identities and current state.
         */
        doors: () => binding.engine.doors(),
        /**
         * Query this session's authoritative source square.
         *
         * @param {number} x - Signed int32 tile x.
         * @param {number} y - Signed int32 tile y.
         * @param {number} z - Signed int32 elevation.
         * @returns {import('../types/mod-api').ModWorldSquare|null} Detached current facts or absent metadata.
         */
        getSquare: (x, y, z) => binding.engine.getSquare(x, y, z),
        /**
         * Read this session's native directional source-square relation.
         *
         * @param {import('../types/mod-api').ModWorldCoordinates} from - Calling source square.
         * @param {import('../types/mod-api').ModWorldCoordinates|null} to - Other square or null.
         * @returns {boolean} Actual current source blockage.
         */
        isBlockedTo: (from, to) => binding.engine.isBlockedTo(from, to),
        /**
         * Submit a door toggle through this session's shared command path.
         *
         * @param {string} id - Stable imported native door identity.
         * @returns {object} Authoritative command result after hook resolution.
         */
        toggleDoor: (id) => sessionCommand(binding, { type: 'toggleDoor', id }),
        /**
         * Register source metadata and numeric fields in this session's engine.
         *
         * @param {import('../types/mod-api').ModItemDefinitionInput} definition - Complete definition to register.
         * @param {{owner: string, override?: boolean}} options - Exact owner and explicit replacement policy.
         * @returns {import('../types/mod-api').ModItemDefinition} Resolved authoritative definition.
         */
        registerItemDefinition: (definition, options) => binding.engine.registerItemDefinition(definition, options),
        /**
         * Read this session's detached definitions with authoritative numeric fields.
         *
         * @returns {import('../types/mod-api').ModItemDefinition[]} Registered definitions in engine order.
         */
        itemDefinitions: () => binding.engine.itemDefinitions(),
        /**
         * Begin an owner-bound registration transaction in this session.
         *
         * @param {string} owner - Exact registering owner.
         * @returns {void} Starts transactional definition staging.
         */
        beginItemDefinitionRegistration: (owner) => binding.engine.beginItemDefinitionRegistration(owner),
        /**
         * Commit this session's successful owner-bound registration.
         *
         * @param {string} owner - Exact transaction owner.
         * @returns {void} Retains the registered definitions.
         */
        commitItemDefinitionRegistration: (owner) => binding.engine.commitItemDefinitionRegistration(owner),
        /**
         * Roll back numeric rows, owners and metadata after failed activation.
         *
         * @param {string} owner - Exact transaction owner.
         * @returns {void} Restores the prior definitions.
         */
        rollbackItemDefinitionRegistration: (owner) => binding.engine.rollbackItemDefinitionRegistration(owner),
        /**
         * Seal this session's definitions after activation.
         *
         * @returns {void} Refuses subsequent definition registration.
         */
        freezeItemDefinitions: () => binding.engine.freezeItemDefinitions(),
        /**
         * Read detached stable item records from this session's engine.
         *
         * @returns {import('../types/mod-api').ModItem[]} Authoritative item records.
         */
        items: () => binding.engine.items(),
        /**
         * Read this session's native inventory mass and independent capacity limits.
         *
         * @returns {import('../types/mod-api').ModInventoryState} Detached carry state.
         */
        inventoryState: () => binding.engine.inventoryState(),
        /**
         * Atomically restore explicit item identities in this session.
         *
         * @param {import('../types/mod-api').ModItem[]} records - Complete detached replacement records.
         * @returns {void} Replaces items after authoritative validation.
         */
        importItems: (records) => binding.engine.importItems(records),
        /**
         * Read equipment at an exact body-location identity.
         *
         * @param {string} bodyLocation - Exact equipment slot.
         * @returns {import('../types/mod-api').ModItem|null} Worn item or an empty slot.
         */
        wornItem: (bodyLocation) => binding.engine.wornItem(bodyLocation),
        /**
         * Query this session's actual native hands item and definition tag.
         *
         * @returns {boolean} Whether the current hands wearable is awkward.
         */
        isWearingAwkwardGloves: () => binding.engine.isWearingAwkwardGloves(),
        /**
         * Read this session's authoritative health scalar.
         *
         * @returns {number} Engine health within [0, 100].
         */
        getHealth: () => binding.engine.getHealth(),
        /**
         * Read this session's authoritative death state.
         *
         * @returns {boolean} Whether the actor is dead.
         */
        isDead: () => binding.engine.isDead(),
        /**
         * Require the original registry and read this session's ordered moodle levels.
         *
         * @returns {import('../types/mod-api').ModMoodle[]} Detached authoritative levels.
         */
        moodles: () => {
            if (typeof binding.engine.moodles !== 'function') {
                throw new TypeError('Unsupported engine capability: original moodle registry and WASM rules are not available.');
            }

            return binding.engine.moodles();
        },
        /**
         * Read numeric and boolean input validation metadata from this session's WASM.
         *
         * @returns {ReturnType<import('../types/mod-api').ModApi['character']['inputLimits']>} Detached authoritative limits.
         */
        moodleInputLimits: () => binding.engine.moodleInputLimits(),
        /**
         * Capture this session's exact character inputs and timed moodle state.
         *
         * @returns {{version: 1, inputs: Record<string, number|boolean>, painTimer: number, painLevel: number, cantSprintTimer: number}} Detached persistence state.
         */
        saveMoodleState: () => binding.engine.saveMoodleState(),
        /**
         * Read this session's real native injury and skin-node records.
         *
         * @returns {import('../types/mod-api').ModBodyPart[]} Detached canonical body parts.
         */
        bodyParts: () => binding.engine.bodyParts(),
        /**
         * Read native full-precision limits before any mod body mutation.
         *
         * @returns {import('../types/mod-api').ModBodyPartInputLimits} Detached field limits.
         */
        bodyPartInputLimits: () => binding.engine.bodyPartInputLimits(),
        /**
         * Derive action timing from this session's actual native skin nodes.
         *
         * @returns {number} Source float32 cold-hand/arm factor.
         */
        thermalActionModifier: () => binding.engine.thermalActionModifier(),
        /**
         * Apply mod speed changes to the current engine.
         *
         * @param {number} speed - Tiles per second.
         * @returns {void} Changes engine speed.
         */
        setSpeed: (speed) => binding.engine.setSpeed(speed),
        /**
         * Advance the current engine through the fixed-step contract.
         *
         * @param {number} seconds - Simulation step.
         * @returns {void} Advances simulation.
         */
        step: (seconds) => sessionStep(binding, seconds),
        /**
         * Reset the current session.
         *
         * @returns {void} Drops engine world and movement.
         */
        reset: () => binding.engine.reset(),
        /**
         * Query navigation extents belonging to this host's own session.
         *
         * @returns {object} Detached cell bounds.
         */
        worldBounds: () => binding.engine.worldBounds(),
        /**
         * Query an absolute navigation tile.
         *
         * @param {number} x - Integer world tile x.
         * @param {number} y - Integer world tile y.
         * @returns {number} Navigation flags or unloaded sentinel.
         */
        navFlags: (x, y) => binding.engine.navFlags(x, y),
        /**
         * Commit a validated mod cell and retain the exact source for saves.
         *
         * @param {number} x - Cell x.
         * @param {number} y - Cell y.
         * @param {Uint8Array} bytes - Full navigation cell.
         * @returns {void} Updates authoritative navigation and retained provenance.
         */
        worldImportCell: (x, y, bytes) => {
            binding.engine.worldImportCell(x, y, bytes);
            const retained = binding.cells.filter((cell) => cell.x !== x || cell.y !== y);

            retained.push({ x, y, bytes: bytes.slice() });
            binding.cells = retained;

            if (binding === liveModContext) {
                worldCells = retained;
                renderer?.setWorldMode(true);
            }
        },
    }, {
        audio: sessionAudio(binding),
        /**
         * Return only an explicitly saved namespace, never object prototypes.
         *
         * @param {string} id - Validated mod identifier.
         * @returns {object|undefined} Saved schema document.
         */
        readModState: (id) => Object.hasOwn(binding.namespaces, id) ? binding.namespaces[id] : undefined,
        /**
         * Retain a validated detached mod record in the session envelope.
         *
         * @param {string} id - Validated mod identifier.
         * @param {object} record - Schema version and JSON data.
         * @returns {void} Replaces only this namespace.
         */
        writeModState: (id, record) => {
            Object.defineProperty(binding.namespaces, id, { value: record, enumerable: true, configurable: true, writable: true });
        },
    });
}

/**
 * Activate against an isolated target host/VM while the committed session stays alive.
 * Failure discards only the target; Lua locals and prior hooks survive without bootstrap replay.
 *
 * @param {object} staged - Validated target engine and navigation.
 * @param {object} namespaces - Fresh or retained namespace documents.
 * @param {object[]} [required] - Exact saved mod identities, when restoring.
 * @returns {Promise<void>} Initializes the session's live mod handles.
 */
async function activateSession(staged, namespaces, required) {
    const running = mods.diagnostics().mods;

    // Capture mutable Lua tables while the old bound save APIs still own their namespaces.
    luaSession?.flushSaveData();
    const previous = { mods, lua: luaSession, native: activeNativeDescriptors, ui: gameUI };
    const installed = await packages.list();
    let selectedNative = previous.native;
    let activationOrder = running.map(({ id }) => id);

    if (!packagesActivated) {
        if (safeMods) {
            selectedNative = [];
        } else {
            // Missing dependencies and cycles fail before either JavaScript or Lua code runs.
            activationOrder = resolveModOrder(installed, mods.api.version);
            selectedNative = [];

            for (const entry of installed.filter((item) => item.enabled && item.settings?.nativeLua)) {
                // Read and validate descriptors in resolved order without retaining parallel file buffers.
                // eslint-disable-next-line no-await-in-loop
                const file = await readPackageFile(entry.id, entry.revision, 'native.json');

                if (!file) {
                    throw new Error(`Native package ${entry.id} is missing its stored descriptor.`);
                }

                const descriptor = JSON.parse(new TextDecoder().decode(file.bytes));

                if (descriptor.id !== entry.id || descriptor.manifest.version !== entry.version || descriptor.nativeId !== entry.settings.nativeId || descriptor.nativeVersion !== entry.settings.nativeVersion) {
                    throw new Error(`Native package ${entry.id} descriptor identity differs from its installed identity.`);
                }

                selectedNative.push(descriptor);
            }
        }
    }

    const nativeById = new Map(selectedNative.map((descriptor) => [descriptor.id, descriptor]));

    selectedNative = activationOrder.filter((id) => nativeById.has(id)).map((id) => nativeById.get(id));

    const targetContext = { engine: staged.engine, cells: staged.cells, namespaces: Object.assign(Object.create(null), namespaces) };
    const targetMods = createSessionModHost(targetContext);
    // After boot the committed manager is configuration/reporting only; later transitions load targetMods directly.
    const targetPackages = packagesActivated ? packages : createModManager(targetMods);
    let targetLua;
    let targetUI;

    try {
        await seedOriginalWearables(staged.engine, content);

        const resources = await loadNativeGameResources(content, selectedNative, 1 / FIXED_STEP_SECONDS);

        if (resources) {
            targetUI = renderer.createGameUI();
            await renderer.initializeGameUI({ ui: targetUI, ...resources });
        }

        targetLua = await prepareNativeSession(selectedNative, content, {
            staged: true,
            ui: targetUI,
            engineSources: resources?.engineSources,
            // Proven ResourceLocation normalization in the installed registry constructor.
            moodleTypes: { FOOD_EATEN: 'base:foodeaten' },
        });

        if (!packagesActivated) {
            const activation = await targetPackages.activateEnabled({ safeMode: safeMods });

            if (activation.errors.length > 0) {
                throw new Error(activation.errors.map((entry) => `${entry.id} [${entry.stage}]: ${entry.message}`).join('\n'));
            }

            if (!safeMods && required?.some(({ id }) => id === 'accessible-walking')) {
                await targetMods.load(new URL('../mods/accessible-walking/main.js', import.meta.url).href);
            }
        } else {
            for (const { url } of running) {
                // Reactivate the committed running set, not next-reload package configuration.
                // eslint-disable-next-line no-await-in-loop
                await targetMods.load(url);
            }
        }

        if (required) {
            requireSessionMods(required, targetMods);
        }

        if (failed) {
            throw new Error('Renderer is no longer active.');
        }

        // Reapply genuine restored option callbacks in every candidate; no synthetic menu transition.
        targetLua?.applyOptions();

        if (!packagesActivated) {
            // Initial native menu bootstrap precedes gameplay, not pause or subsequent session reloads.
            targetLua?.dispatch('OnMainMenuEnter');
        }

        if (required) {
            targetLua?.dispatch('OnLoad');
        }

        targetLua?.dispatch('OnCreatePlayer', 0);
        targetLua?.dispatch('OnGameStart');

        staged.engine.freezeItemDefinitions();
        // Flush can refuse; retain the committed VM/UI until every candidate operation succeeds.
        previous.lua?.flushSaveData();

        if (failed) {
            throw new Error('Renderer is no longer active.');
        }

        // Last fallible commit operation; global bindings change synchronously immediately afterward.
        renderer.setGameUI(targetUI ?? null);
    } catch (cause) {
        targetLua?.close({ discardSaveData: true });
        targetMods.dispose();
        targetUI?.dispose();
        bindNativeSession(previous.lua, previous.native);

        if (!failed) {
            reportPackageError(cause);
        }

        throw cause;
    }

    // No callbacks run between UI publication and these synchronous session-owned bindings.
    pauseAudio();
    liveModContext = targetContext;
    engine = targetContext.engine;
    worldCells = targetContext.cells;
    savedModState = targetContext.namespaces;
    mods = targetMods;
    setAudioListener(engine.snapshot());
    packages = targetPackages;
    luaSession = targetLua;
    activeNativeDescriptors = selectedNative;
    packagesActivated = true;
    gameUI = targetUI;
    previous.lua?.close({ discardSaveData: true });
    previous.mods.dispose();
    previous.ui?.dispose();
    packageStatus.textContent = safeMods ? 'Safe mode: no local JavaScript or Lua packages executed. Discovered new packages remain disabled.' : 'Directory packages discovered. New packages are disabled; only your enabled packages activate on reload.';
}

/**
 * Keep save/import failures recoverable and visible without stopping WebGPU.
 *
 * @param {() => Promise<void>} action - Session operation.
 * @returns {Promise<void>} Completes after operation feedback.
 */
async function sessionOperation(action) {
    if (sessionBusy || packageBusy || failed || !content || !saves) {
        return;
    }

    sessionBusy = true;
    const wasPaused = paused;

    paused = true;
    pauseAudio();
    document.querySelector('#session-controls').disabled = true;
    packageControls.disabled = true;
    try {
        await action();
    } catch (cause) {
        document.querySelector('#save-status').textContent = cause.message;

        if (!failed) {
            error.hidden = false;
            error.textContent = cause.message;
        }
    } finally {
        sessionBusy = false;
        paused = failed || !sessionReady || wasPaused || pauseMenu.open;
        resumeAudio();
        document.querySelector('#session-controls').disabled = false;
        packageControls.disabled = startup === 'loading';
        refresh();
    }
}

/**
 * Capture detached cells and current mod provenance for an atomic save.
 *
 * @returns {Promise<void>} Committed save feedback.
 */
async function saveSession() {
    if (!sessionReady) {
        throw new Error('No successfully loaded session to save. Retained browser saves have not been changed.');
    }

    luaSession?.flushSaveData();

    const record = await saves.save(engine, {
        cells: worldCells,
        mods: mods.diagnostics().mods.map(({ id, version, apiVersion }) => ({ id, version, apiVersion })),
        modState: savedModState,
    });

    savedRevision = record.revision;
    retainedSave = true;
    document.querySelector('#save-status').textContent = `Saved revision ${record.revision}. Export a backup to protect against browser storage loss.`;
}

/**
 * Load a validated backup only when its running mod versions match.
 *
 * @param {string} [id] - Save slot.
 * @param {object} [prepared] - Validated retained save staged before mod activation.
 * @returns {Promise<void>} Publishes the restored game after compatibility checks.
 */
async function loadSession(id, prepared) {
    stop();
    const staged = prepared ?? await saves.load(id);

    /* Boot activation validates identities after initialization; running restores
       reject incompatible packages before touching the previous scene or hooks. */
    if (packagesActivated) {
        requireSessionMods(staged.record.mods);
    }

    const cells = staged.record.world.cells.map((cell) => ({
        x: cell.x, y: cell.y, bytes: Uint8Array.from(atob(cell.bytes), (character) => character.charCodeAt(0)),
    }));

    const geometry = await loadGeometry(cells, staged.engine, staged.doorState);

    try {
        await activateSession({ engine: staged.engine, cells }, staged.record.modState, staged.record.mods);
        publishSession({ engine: staged.engine, cells: worldCells, geometry });
    } catch (cause) {
        geometry.layer.destroy();
        throw cause;
    }

    savedRevision = staged.record.revision;
    document.querySelector('#save-status').textContent = staged.recovered
        ? `Recovered previous committed revision ${staged.record.revision}: ${staged.recoveryReason}. The damaged current save has not been replaced.`
        : `Loaded revision ${staged.record.revision}.`;
}

/**
 * Download a validated backup without requiring persistence or a remote service.
 *
 * @returns {Promise<void>} Initiates a user-selected local download.
 */
async function exportSession() {
    if (sessionReady) {
        luaSession?.flushSaveData();
    }

    const blob = sessionReady
        ? await saves.exportLive(engine, {
                cells: worldCells,
                mods: mods.diagnostics().mods.map(({ id, version, apiVersion }) => ({ id, version, apiVersion })),
                modState: savedModState,
            })
        : await saves.exportSave();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = url;
    link.download = 'pz-web-save.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/**
 * Stage a visible original tile layer using deterministic pack precedence.
 *
 * @param {object[]} cells - Fully indexed staged geometry cells.
 * @param {object} candidateEngine - Staged authoritative engine, never the old scene.
 * @param {object} [doorState] - Exact persisted state; absent means normal source initialization.
 * @returns {Promise<object>} Validated layer/cells staged without replacing the scene.
 */
async function rebuildTileLayer(cells, candidateEngine, doorState) {
    if (importedPacks.length === 0 || cells.length === 0) {
        throw new Error('The local content directory must contain texture packs and matching lotheader/lotpack geometry.');
    }

    const snapshot = candidateEngine.snapshot();
    const projection = await projectWorldObjects(cells, tileRegistry);
    const seed = new Uint32Array(1);

    if (doorState) {
        seed[0] = doorState.seed;
    } else {
        do {
            crypto.getRandomValues(seed);
        } while (seed[0] === 0);
    }

    candidateEngine.importDoors(projection.doors, {
        squares: projection.squares, seed: seed[0], lockedHouses: 4,
        initializeLocks: !doorState,
    });

    if (doorState) {
        candidateEngine.loadDoorState(doorState);
    }

    const layer = createTileLayer({
        ...renderer.gpuResources(),
        packs: importedPacks,
        cells,
        doors: {
            visuals: projection.doorVisuals,
            /**
             * Read the authoritative native door mutation revision.
             *
             * @returns {number} Current imported door revision.
             */
            revision: () => candidateEngine.doorRevision(),
            /**
             * Read detached native door state for visual variant selection.
             *
             * @returns {object[]} Stable door identities and current native state.
             */
            read: () => candidateEngine.doors(),
        },
    });

    try {
        await layer.update({ x: snapshot.x, y: snapshot.y, width: canvas.width, height: canvas.height });
        const evidence = layer.diagnostics();

        if (evidence.errors.length > 0 || evidence.residentSprites === 0) {
            throw new Error(`Original tile startup failed: ${evidence.errors.map((entry) => entry.message).join('; ') || 'no original sprites loaded for this saved position'}. Provision matching geometry and texture packs.`);
        }

        return { layer, cells };
    } catch (cause) {
        layer.destroy();
        throw cause;
    }
}

/**
 * Import real atlas packs without reading complete texture banks into memory.
 *
 * @param {object[]} files - Lazy local-directory .pack sources.
 * @returns {Promise<void>} Indexes available tile art without materializing banks.
 */
async function importPacks(files) {
    const indexed = [];

    for (const file of files) {
        document.querySelector('#visual-status').textContent = `Indexing ${file.name} metadata…`;
        // Sequential index passes bound peak metadata/read-buffer allocation.
        // eslint-disable-next-line no-await-in-loop
        indexed.push(await openPack(file));
    }

    const next = new Map(importedPacks.map((pack) => [pack.source.name, pack]));

    for (const pack of indexed) {
        next.set(pack.source.name, pack);
    }

    importedPacks = [...next.values()].sort((left, right) => left.source.name.localeCompare(right.source.name));
}

/**
 * Import paired original map catalogue and compressed tile placements.
 *
 * @param {object[]} files - Lazy cell lotheader and lotpack sources.
 * @param {object} candidateEngine - Isolated authoritative engine.
 * @param {object} [doorState] - Exact validated restore state.
 * @returns {Promise<object>} Staged original geometry ready for atomic publication.
 */
async function importGeometry(files, candidateEngine, doorState) {
    const selected = new Map(files.map((file) => [file.name, file]));
    const next = new Map();

    for (const file of files) {
        const match = /^(-?\d+)_(-?\d+)\.lotheader$/u.exec(file.name);

        if (!match) {
            continue;
        }

        const lotpack = selected.get(`world_${match[1]}_${match[2]}.lotpack`);

        if (!lotpack) {
            throw new Error(`Missing world_${match[1]}_${match[2]}.lotpack for ${file.name}.`);
        }

        // Catalogue/index parsing is ordered so only one cell's buffers are live.
        // eslint-disable-next-line no-await-in-loop
        const cell = await openMapCell({ cellX: Number(match[1]), cellY: Number(match[2]), header: file, lotpack });

        next.set(`${cell.cellX},${cell.cellY}`, cell);
    }

    if (next.size === 0) {
        throw new Error('No matching original geometry for the saved navigation cells. Provision their lotheader and lotpack files in the content directory.');
    }

    return rebuildTileLayer([...next.values()], candidateEngine, doorState);
}

/**
 * Materialize only the small explicit character files, never texture banks.
 *
 * @returns {Promise<void>} Uploads the original animated character.
 */
async function importCharacter() {
    const files = {};
    const materialized = new Map();

    for (const [role, path] of Object.entries(content.manifest.startup.character)) {
        if (!materialized.has(path)) {
            // eslint-disable-next-line no-await-in-loop
            materialized.set(path, await content.getFile(path).toFile());
        }

        files[role] = materialized.get(path);
    }

    await renderer.importCharacter(files);
    refresh();
}

/**
 * Load only geometry matching authoritative navigation; do not merge worlds.
 *
 * @param {object[]} cells - New or retained navigation cells.
 * @param {object} candidateEngine - Isolated authoritative engine.
 * @param {object} [doorState] - Validated state to apply after matching source import.
 * @returns {Promise<object>} Staged geometry for every authoritative navigation cell.
 */
async function loadGeometry(cells, candidateEngine, doorState) {
    if (importedPacks.length === 0) {
        await importPacks(content.manifest.startup.packs.map((path) => content.getFile(path)));
    }

    if (!renderer.diagnostics().character) {
        await importCharacter();
    }

    const declared = new Map(content.manifest.startup.cells.map((cell) => [`${cell.x},${cell.y}`, cell]));
    const paths = new Set(content.manifest.files.map(({ path }) => path));
    const firstHeader = content.manifest.startup.cells[0].header;
    const root = firstHeader.slice(0, firstHeader.lastIndexOf('/') + 1);
    const files = [];

    for (const { x, y } of cells) {
        const cell = declared.get(`${x},${y}`);
        const header = cell?.header ?? `${root}${x}_${y}.lotheader`;
        const lotpack = cell?.lotpack ?? `${root}world_${x}_${y}.lotpack`;

        const missing = [header, lotpack].filter((path) => !paths.has(path));

        if (missing.length > 0) {
            throw new Error(`Saved navigation cell ${x},${y} is missing required original geometry: ${missing.join(', ')}. Provision every saved cell's lotheader and lotpack files.`);
        }

        files.push(content.getFile(header), content.getFile(lotpack));
    }

    return importGeometry(files, candidateEngine, doorState);
}

/**
 * Stage bounded startup navigation and use the manifest's passable spawn.
 *
 * @returns {Promise<void>} Publishes a real original-content new session.
 */
async function newSession() {
    stop();
    const files = content.manifest.startup.cells.map(({ navigation }) => content.getFile(navigation));
    const staged = await stageCells({ engineSource, engine, cells: [], files });
    const { spawn } = content.manifest.startup;
    const flags = staged.engine.navFlags(Math.floor(spawn.x), Math.floor(spawn.y));

    if (flags === 0xFF_FF_FF_FF || (flags & 0x29) !== 0) {
        throw new Error(`Content manifest spawn ${spawn.x}, ${spawn.y} is not dry, passable loaded navigation. Correct the manifest; no approximate or blank world was started.`);
    }

    const sessionState = staged.engine.saveState();

    sessionState.values = [spawn.x, spawn.y, sessionState.values[2], spawn.x, spawn.y, 0, 0, 0, 0, 1, ...sessionState.values.slice(10)];
    staged.engine.loadState(sessionState);
    const geometry = await loadGeometry(staged.cells, staged.engine);

    try {
        await activateSession(staged, Object.create(null));
        publishSession({ ...staged, cells: worldCells, geometry });
    } catch (cause) {
        geometry.layer.destroy();
        throw cause;
    }

    savedRevision = undefined;
    document.querySelector('#save-status').textContent = 'New session loaded. Autosave runs every 30 seconds.';
}

/**
 * Install static-directory JavaScript and native Lua adapters without enabling new code.
 *
 * @returns {Promise<void>} Completes discovery before any package activation.
 */
async function discoverPackages() {
    const installed = await packages.list();
    const storedNative = installed.filter((entry) => entry.settings?.nativeLua).map((entry) => ({
        id: entry.id, nativeId: entry.settings.nativeId, manifest: { version: entry.version },
    }));
    const discovered = await discoverNativePackages(content, [], storedNative);
    const stagedJavascript = [];
    const javascriptIds = new Set(installed.filter((entry) => !entry.settings?.nativeLua).map(({ id }) => id));
    const claimedJavascriptIds = new Set();

    nativePackages = discovered.map(({ id, nativeId, nativeVersion, root, tree, blocked, fileCount }) => ({
        id, nativeId, nativeVersion, root, tree, blocked, fileCount,
    }));

    for (const entry of content.manifest.mods.filter((item) => item.kind === 'javascript')) {
        const files = [];
        let total = 0;

        if (entry.files.length > 512) {
            throw new Error(`Mod package ${entry.root} exceeds the 512-file limit.`);
        }

        for (const path of entry.files) {
            const source = content.getFile(path);

            total += source.size;

            if (total > 64 * 1_024 * 1_024) {
                throw new Error(`Mod package ${entry.root} exceeds the 64 MiB limit.`);
            }

            // Sequential bounded materialization; preserve multifile ESM paths.
            // eslint-disable-next-line no-await-in-loop
            const file = await source.toFile();

            Object.defineProperty(file, 'webkitRelativePath', { value: path.slice(entry.root.length + 1) });
            files.push(file);
        }

        // Validate every identity before overwriting any installed package or its consent.
        // eslint-disable-next-line no-await-in-loop
        const parsed = await parseModPackage(files);
        const id = parsed.manifest.id;

        if (claimedJavascriptIds.has(id) || installed.some((record) => record.id === id && record.settings?.nativeLua)) {
            throw new Error(`Directory SDK id collision: JavaScript package ${id} has another owner.`);
        }

        claimedJavascriptIds.add(id);
        javascriptIds.add(id);
        stagedJavascript.push(files);
    }

    for (const descriptor of discovered) {
        if (javascriptIds.has(descriptor.id)) {
            throw new Error(`Native SDK id collision: ${descriptor.nativeId} maps to JavaScript package ${descriptor.id}`);
        }

        const previous = installed.find((entry) => entry.id === descriptor.id);

        if (previous?.settings?.nativeLua && previous.settings.nativeId !== descriptor.nativeId) {
            throw new Error(`Native SDK id collision: stored ${previous.settings.nativeId} and discovered ${descriptor.nativeId} both map to ${descriptor.id}`);
        }
    }

    for (const files of [...stagedJavascript, ...discovered.map(nativePackageFiles)]) {
        // New installations are atomically disabled; updates retain consent only after collision checks.
        // eslint-disable-next-line no-await-in-loop
        await packages.install(files);
    }
}

/**
 * Keep a failed restore stopped while leaving explicit recovery controls usable.
 *
 * @param {unknown} cause - Content or retained-save startup failure.
 * @returns {void} Reports the issue without committing any save.
 */
function blockStartup(cause) {
    startup = 'blocked';
    paused = true;
    sessionReady = false;

    if (!failed) {
        error.hidden = false;
        error.textContent = `${cause instanceof Error ? cause.message : String(cause)} Retained browser saves were not replaced. Provision the local content directory, correct enabled mods, or explicitly choose New session.`;
    }

    document.querySelector('#save-status').textContent = 'Automatic restoration stopped; autosave and movement remain disabled. Export the retained backup before choosing New session.';
    refresh();
}

try {
    engine = await createEngine(new URL('../engine/pz_engine.wasm', import.meta.url));
    saves = createSaveStore({ engineSource, appVersion: '0.1.0-preview.1' });
    content = await openContentDirectory(undefined, {
        /**
         * Show content transfer progress while the retained session remains paused.
         *
         * @param {{path: string, loaded: number, total: number|null}} progress - Current bounded content transfer.
         */
        onProgress: (progress) => {
            document.querySelector('#visual-status').textContent = `Loading local content: ${JSON.stringify(progress)}`;
        },
    });
    tileRegistry = await loadNativeTileRegistry(content);
    let prepared;
    let restoreError;

    try {
        retainedSave = (await saves.list()).some(({ id }) => id === 'autosave');

        if (retainedSave) {
            prepared = await saves.load();
        }
    } catch (cause) {
        retainedSave = true;
        restoreError = cause;
    }

    liveModContext = { engine, cells: worldCells, namespaces: savedModState };
    mods = createSessionModHost(liveModContext);
    try {
        packages = createModManager(mods);
        await discoverPackages();
    } catch (cause) {
        reportPackageError(cause);
        packageStatus.textContent = 'Local package startup failed; no further packages were activated. Correct the package configuration or reload in safe mode.';
        restoreError ??= cause;
    }

    renderer = await createRenderer(canvas, report);
    try {
        await importPacks(content.manifest.startup.packs.map((path) => content.getFile(path)));
        await importCharacter();

        if (restoreError) {
            throw restoreError;
        }

        if (prepared) {
            await loadSession(undefined, prepared);
        } else {
            await newSession();
        }

        paused = failed || pauseMenu.open;

        if (!pauseMenu.open) {
            canvas.focus({ preventScroll: true });
        }
    } catch (cause) {
        blockStartup(cause);
    }

    if (packages) {
        try {
            await refreshPackages();
        } catch (cause) {
            reportPackageError(cause);
        }

        packageControls.disabled = false;
    }

    document.querySelector('#session-controls').disabled = false;
    autosave = setInterval(() => {
        if (sessionReady && !sessionBusy && !failed && !document.hidden) {
            void sessionOperation(saveSession);
        }
    }, 30_000);
    // Restored browser form state must never claim an active mod before startup succeeded.
    modCheckbox.checked = mods.diagnostics().mods.some((entry) => entry.url === new URL('../mods/accessible-walking/main.js', import.meta.url).href);
    modCheckbox.disabled = !sessionReady || mods.diagnostics().mods.some((entry) => entry.url !== new URL('../mods/accessible-walking/main.js', import.meta.url).href);

    if (modCheckbox.checked) {
        document.querySelector('#mod-status').textContent = 'Active: restored with the save.';
    } else if (modCheckbox.disabled) {
        document.querySelector('#mod-status').textContent = 'Unavailable while other mods are active or the game is not ready.';
    }

    refresh();
    animation = requestAnimationFrame(frame);
} catch (cause) {
    startup = 'blocked';
    report(new Error(`${cause.message ?? String(cause)} Copy original files into content/ and run node scripts/provision-content.mjs --source "C:/Games/steam/steamapps/common/ProjectZomboid" --startup-only, then serve with the content server and reload. No session or save was started.`, { cause }));
}

document.querySelector('#new-session').addEventListener('click', () => {
    if ((retainedSave || sessionReady) && !globalThis.confirm('Start a new session at the content manifest spawn? This replaces the active world and subsequent saves will replace the retained autosave. Export a backup first to keep it.')) {
        return;
    }

    void sessionOperation(async () => {
        await newSession();
        await saveSession();
    });
});
document.querySelector('#save-now').addEventListener('click', () => {
    void sessionOperation(saveSession);
});
document.querySelector('#load-save').addEventListener('click', () => {
    void sessionOperation(() => loadSession());
});
document.querySelector('#export-save').addEventListener('click', () => {
    void sessionOperation(exportSession);
});
document.querySelector('#import-save').addEventListener('change', (event) => {
    const file = event.target.files[0];

    if (file) {
        void sessionOperation(async () => {
            const imported = await saves.importSave(file);

            await loadSession(imported.id);
        });
    }

    event.target.value = '';
});
document.querySelector('#package-reload').addEventListener('click', () => globalThis.location.reload());

const safeUrl = new URL(globalThis.location.href);
const normalUrl = new URL(globalThis.location.href);

safeUrl.searchParams.set('safe-mods', '1');
normalUrl.searchParams.delete('safe-mods');
document.querySelector('#package-safe-mode').href = safeUrl.href;
document.querySelector('#package-normal-mode').href = normalUrl.href;
canvas.addEventListener('pointerdown', pointDestination);
canvas.addEventListener('pointerup', (event) => {
    if (event.button === 0) {
        gameUIPointer(event, 'onMouseUp');
    }
});
canvas.addEventListener('pointermove', (event) => {
    gameUIPointer(event, 'onMouseMove', event.movementX, event.movementY);
});
canvas.addEventListener('dblclick', (event) => {
    if (event.button === 0) {
        gameUIPointer(event, 'onMouseDoubleClick');
    }
});
canvas.addEventListener('wheel', (event) => {
    gameUIPointer(event, 'onMouseWheel', Math.sign(event.deltaY));
}, { passive: false });

for (const button of directionButtons) {
    button.addEventListener('click', toggleWalking);
}

document.querySelector('#destination').addEventListener('submit', formDestination);
document.querySelector('#stop').addEventListener('click', stop);
pauseButton.addEventListener('click', resumeGame);
openPauseButton.addEventListener('click', openPauseMenu);
pauseMenu.addEventListener('cancel', (event) => {
    event.preventDefault();
    resumeGame();
});
document.addEventListener('keydown', keyDown);
document.addEventListener('keydown', unlockAudio, { capture: true });
document.addEventListener('pointerdown', unlockAudio, { capture: true });
document.addEventListener('keyup', keyUp);
globalThis.addEventListener('blur', stop);
document.addEventListener('visibilitychange', visibilityChanged);
modCheckbox.addEventListener('change', toggleMod);
globalThis.addEventListener('pagehide', pageHidden);
globalThis.addEventListener('pageshow', pageShown);
