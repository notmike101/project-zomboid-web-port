/* eslint-disable import/no-unresolved -- Served at the frozen generation root with its sibling adapter routes. */
import { createBrowserClock } from './browser-clock.js';
import { createBrowserMouse } from './browser-mouse.js';
import { createBrowserPhysics } from './browser-physics.js';
import { publishClipperOwner } from './clipper-native-owner.js';
import { createControllerNatives } from './controller-natives.js';
import { installCredentiallessRuntimeHelper } from './credentialless-runtime-helper.js';
import { createDisplayEvents } from './display-events.js';
import { createFileWatchNatives } from './file-watch-natives.js';
import { keyboardNatives } from './keyboard.js';
import { installNativeLibraryLoader } from './native-library-loader.js';
import { installNegativeStat } from './negative-stat.js';
import { createProcessNatives } from './process-natives.js';
import { rakNetDiagnostics, disposeRakNetOwner } from './raknet-runtime.js';
import { startSchedulerRuntime } from './scheduler-runtime.js';
import { createSpriteNatives } from './sprite-webgl.js';
import { reserveSqliteNamespace } from './sqlite-namespace.js';
import { installUnsafeFloatVolatile } from './unsafe-float-volatile.js';
import { installUnsafeShortRepair } from './unsafe-short-repair.js';

const canvas = document.querySelector('canvas');
const status = document.querySelector('#status');
const stop = document.querySelector('#stop');
const observations = [];
const failures = [];
const hostReports = [];
let stopped = false;
let vmExitObserved = false;
let exitCode;
let helper;
let owners;
let metadataOwner;
let metadataDescriptor;
let audioOwner;

globalThis.originalBoot = { observations, failures, hostReports, completed: false, vmExitObserved: false };
/**
 * Reads actual metadata owner counters for the existing host observation boundary.
 *
 * @returns {object|null} Current real owner snapshot, or no installed owner.
 */
globalThis.originalBoot.mediaNegativeStatSnapshot = () => metadataOwner?.snapshot() ?? null;
stop.addEventListener('click', () => {
    stopped = true;
    stop.disabled = true;
});

try {
    const response = await fetch('/original-boot-admission.json', { cache: 'no-store' });
    const admission = await response.json();

    if (admission.noVoip !== undefined && typeof admission.noVoip !== 'boolean') {
        throw new Error('Original -novoip selection must be an explicit boolean');
    }

    if (admission.texture2x !== undefined && typeof admission.texture2x !== 'boolean') {
        throw new Error('Original texture2x selection must be an explicit boolean');
    }

    globalThis.originalBoot.startupOptions = {
        audio: Boolean(admission.audioRuntime), noVoip: admission.noVoip === true, texture2x: admission.texture2x ?? null,
    };

    if (!response.ok || admission.executionAdmitted !== true || admission.scope !== 'original-frontend-setup'
        || !Array.isArray(admission.classpath) || !admission.classpath.every((name) => /^\/app\/[a-z0-9-]+\.jar$/u.test(name))) {
        throw new Error('Original startup has no reviewed complete importer/resource generation');
    }

    if (!crossOriginIsolated || typeof SharedArrayBuffer !== 'function') {
        throw new Error('Actual isolated origin/shared memory required before owner initialization');
    }

    const certificateResponse = await fetch('/media-negative-certificate.json', { cache: 'no-store' });

    if (!certificateResponse.ok) {
        throw new Error('Frozen media certificate route failed');
    }

    const mediaCertificate = await certificateResponse.json();
    const positiveResponse = await fetch('/media-positive-certificate.json', { cache: 'no-store' });

    if (!positiveResponse.ok) {
        throw new Error('Same-owner positive metadata certificate route failed');
    }

    const positiveCertificate = await positiveResponse.json();

    if (positiveCertificate.schema !== 'verified-owned-positive-v1' || positiveCertificate.namespaceSHA !== mediaCertificate.namespaceSHA) {
        throw new Error('Positive metadata certificate namespace mismatch');
    }

    helper = installCredentiallessRuntimeHelper();
    const graphics = createSpriteNatives(canvas, (json) => {
        const value = JSON.parse(String(json));

        hostReports.push(value);
        failures.push({ unexpectedGraphicsQualificationReport: value });
    });

    /**
     * Returns scalar host resource counts and Chromium's optional JS heap counters.
     *
     * @returns {object} Actual resource counts, not a total-memory estimate.
     */
    globalThis.originalBoot.resourceTelemetrySnapshot = () => {
        const directBuffers = globalThis.originalBoot.resourceTelemetry?.directBuffers ?? null;

        return {
            graphics: graphics.resources(), directBuffers, audio: audioOwner?.snapshot() ?? null,
            jsHeap: performance.memory
                ? {
                        usedBytes: performance.memory.usedJSHeapSize,
                        totalBytes: performance.memory.totalJSHeapSize,
                        limitBytes: performance.memory.jsHeapSizeLimit,
                    }
                : null,
        };
    };

    const presentation = { markers: [], presents: [], failures: [], observationErrors: [], actualPresents: 0 };
    /**
     * Reads optional raster diagnostics without changing the original game result.
     *
     * @returns {object} Actual state or an explicit unavailable diagnostic.
     */
    const inspectPresentationState = () => {
        try {
            if (typeof graphics.inspectState !== 'function') {
                throw new TypeError('Optional graphics.inspectState is unavailable');
            }

            return graphics.inspectState();
        } catch (error) {
            const unavailable = { diagnosticUnavailable: true, error: String(error.stack || error) };

            if (presentation.observationErrors.length < 3) {
                presentation.observationErrors.push(unavailable);
            }

            return unavailable;
        }
    };

    globalThis.originalBoot.presentation = presentation;
    let latestAppearanceMarker;
    const actualPresent = graphics.natives.Java_port_host_SpriteGraphics_present;

    /**
     * Delegate the exact native call before recording bounded presentation evidence.
     *
     * @param {...unknown} args - Original native arguments.
     * @returns {Promise<unknown>} Original native result.
     */
    graphics.natives.Java_port_host_SpriteGraphics_present = async function (...args) {
        const result = await Reflect.apply(actualPresent, this, args);

        presentation.actualPresents++;

        if (latestAppearanceMarker && presentation.observationErrors.length < 3 && presentation.presents.length < 3
            && !presentation.presents.some((sample) => sample.sequence === latestAppearanceMarker.originalUiConsumed)) {
            try {
                presentation.presents.push({
                    sequence: latestAppearanceMarker.originalUiConsumed,
                    observedUtc: new Date().toISOString(), state: inspectPresentationState(),
                    png: canvas.toDataURL('image/png'),
                });
            } catch (error) {
                const failure = { presentationObservationFailed: String(error.stack || error) };

                if (presentation.observationErrors.length < 3) {
                    presentation.observationErrors.push(failure);
                }
            }
        }

        return result;
    };

    const keyboard = keyboardNatives(canvas);
    const text = keyboard.enableTextEvents();
    const mouse = createBrowserMouse(canvas);
    const display = createDisplayEvents(canvas, text);
    const controllers = createControllerNatives();
    const clock = createBrowserClock();
    const physics = createBrowserPhysics();

    publishClipperOwner(physics);
    const watch = createFileWatchNatives();
    const processes = createProcessNatives();

    owners = { graphics, keyboard, text, mouse, display, controllers, clock, physics, watch, processes };
    await reserveSqliteNamespace();
    let root = `/files/sqlite-owned/${crypto.randomUUID()}`;

    if (globalThis.originalBootOwnedHome !== undefined) {
        if (!/^\/files\/sqlite-owned\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(globalThis.originalBootOwnedHome)) {
            throw new Error('Invalid persistent owned home');
        }

        root = globalThis.originalBootOwnedHome;
    }

    if (admission.audioRuntime) {
        const { loadFmodRuntime } = await import('./fmod-runtime.js');

        audioOwner = await loadFmodRuntime(admission.audioRuntime.manifestSHA,
            positiveCertificate.files.filter((entry) => /\.bank$/iu.test(entry.path))
                .map(({ path, bytes }) => ({ path, bytes })));
        globalThis.originalBoot.audio = audioOwner.snapshot();
    }

    await startSchedulerRuntime({
        version: 17,
        status: 'none',
        javaProperties: ['user.dir=/app', `user.home=${root}`, 'java.library.path=/app/',
            `pz.browser.audio=${Boolean(audioOwner)}`, `pz.browser.novoip=${admission.noVoip === true}`,
            ...(admission.texture2x === undefined ? [] : [`pz.browser.texture2x=${admission.texture2x}`])],
        natives: {
            ...graphics.natives, ...keyboard.natives, ...mouse.natives, ...display.natives,
            ...controllers.natives, ...clock.natives, ...physics.natives, ...watch.natives, ...processes.natives,
            /**
             * Retains actual original owner and render observations.
             *
             * @param {unknown} _library - Original native callback namespace.
             * @param {string} json - Java observation serialized by its actual owner.
             */
            Java_zombie_BrowserOriginalBoot_report(_library, json) {
                const value = JSON.parse(String(json));

                observations.push(value);

                if (observations.length > 240) {
                    observations.shift();
                }

                globalThis.originalBoot.latest = value;

                if (value.resourceTelemetry) {
                    globalThis.originalBoot.resourceTelemetry = value.resourceTelemetry;
                }

                if (value.loadingWitness) {
                    globalThis.originalBoot.loading = { ...value, actualPresentsAtObservation: presentation.actualPresents };
                }

                if (value.originalState) {
                    globalThis.originalBoot.currentOriginalState = {
                        name: value.originalState, actualPresentsAtObservation: presentation.actualPresents,
                    };
                }

                if (value.bootPhase) {
                    globalThis.originalBoot.bootPhase = value.bootPhase;
                }

                if (value.termsControl) {
                    globalThis.originalBoot.termsControl = value;
                }

                if (value.frontend) {
                    globalThis.originalBoot.frontend = value;
                }

                if (value.javaBoundaryCompleted) {
                    globalThis.originalBoot.javaBoundary = value;
                }

                if (value.ownerEvent === 'actual-original-main-owner-joined; failed=false') {
                    globalThis.originalBoot.ownerJoined = true;
                }

                if (value.originalUiConsumed) {
                    globalThis.originalBoot.lastConsumedUi = value;

                    if (value.appearanceVisible) {
                        latestAppearanceMarker = value;

                        if (presentation.observationErrors.length < 3 && presentation.markers.length < 3) {
                            try {
                                presentation.markers.push({
                                    sequence: value.originalUiConsumed,
                                    observedUtc: new Date().toISOString(), state: inspectPresentationState(),
                                });
                            } catch (error) {
                                const failure = { presentationObservationFailed: String(error.stack || error) };

                                if (presentation.observationErrors.length < 3) {
                                    presentation.observationErrors.push(failure);
                                }
                            }
                        }
                    }
                }

                status.textContent = value.originalState || value.ownerEvent || 'Original startup progressing';

                if (value.javaFailed || value.renderFailed || value.assetDrainObservationFailed || value.glError || value.ownerEvent?.startsWith('original-game-owner-failed')) {
                    failures.push(value);
                }
            },
            /**
             * Reads the browser owner's pending close request.
             *
             * @returns {boolean} Whether the user requested closure.
             */
            Java_zombie_BrowserOriginalBoot_stopRequested() {
                return stopped;
            },
        },
    });
    const appMounts = globalThis.cheerpjFSMounts.filter((mount) => mount.mountPoint === '/app/');

    if (appMounts.length !== 1) {
        throw new Error('Ambiguous actual app mount for frozen media metadata');
    }

    metadataDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'webStatAsyncImpl');
    metadataOwner = installNegativeStat(globalThis, appMounts[0], mediaCertificate, positiveCertificate);
    installUnsafeShortRepair(globalThis.cj3Module);
    installUnsafeFloatVolatile(globalThis.cj3Module);
    installNativeLibraryLoader(globalThis.cj3Module);
    watch.install();
    exitCode = await cheerpjRunMain('zombie.BrowserOriginalBoot', admission.classpath.join(':'), root);
    vmExitObserved = true;
    const javaCompleted = globalThis.originalBoot.javaBoundary?.mainMenuConsumed > 0;
    const joined = globalThis.originalBoot.ownerJoined === true;

    if (exitCode !== 0 || !javaCompleted || !joined || failures.length) {
        throw new Error('Original Java boundary/result/actual join/VM exit evidence is incomplete or failed');
    }
} catch (error) {
    failures.push({ browserError: String(error.stack || error) });
} finally {
    if (owners) {
        globalThis.originalBoot.beforeDispose = {
            graphics: owners.graphics.resources(), physics: owners.physics.snapshot(),
            watch: owners.watch.diagnostics(), processes: owners.processes.diagnostics(), raknet: rakNetDiagnostics(),
        };

        try {
            if (vmExitObserved) {
                globalThis.originalBoot.watchDisposal = 'actual-VM-exit-host-descriptor-close';
                await owners.watch.disposeAfterVmExit();
            } else {
                globalThis.originalBoot.watchDisposal = 'strict-live-service-dispose';
                owners.watch.dispose();
            }
        } catch (error) {
            failures.push({ watchDisposeError: String(error.stack || error) });
        }

        for (const owner of [owners.controllers, owners.display, owners.mouse, owners.keyboard]) {
            try {
                owner.dispose();
            } catch (error) {
                failures.push({ disposeError: String(error.stack || error) });
            }
        }

        try {
            globalThis.originalBoot.raknetWorkers = disposeRakNetOwner();
        } catch (error) {
            failures.push({ raknetDisposeError: String(error.stack || error) });
        }

        const gl = canvas.getContext('webgl2');

        gl.getExtension('WEBGL_lose_context')?.loseContext();
        globalThis.originalBoot.afterDispose = {
            keyboard: owners.text.snapshot(), mouse: owners.mouse.snapshot(), display: owners.display.snapshot(),
            controllers: owners.controllers.diagnostics(), watch: owners.watch.diagnostics(),
            cursor: owners.display.cursorSnapshot(), physics: owners.physics.snapshot(), processes: owners.processes.diagnostics(),
            graphics: owners.graphics.resources(), contextLost: gl.isContextLost(),
        };
    }

    if (audioOwner) {
        try {
            await audioOwner.dispose();
            globalThis.originalBoot.audioAfterDispose = audioOwner.snapshot();
        } catch (error) {
            failures.push({ audioDisposeError: String(error.stack || error) });
        }
    }

    if (metadataOwner) {
        try {
            globalThis.originalBoot.beforeMetadataDispose = metadataOwner.snapshot();
            metadataOwner.dispose();
            globalThis.originalBoot.afterMetadataDispose = metadataOwner.snapshot();
            const restored = Object.getOwnPropertyDescriptor(globalThis, 'webStatAsyncImpl');

            globalThis.originalBoot.metadataDescriptorRestored = Boolean(restored && Object.keys(metadataDescriptor).every((key) => metadataDescriptor[key] === restored[key]));

            if (!globalThis.originalBoot.metadataDescriptorRestored) {
                failures.push({ metadataDisposeError: 'Original metadata descriptor was not restored' });
            }
        } catch (error) {
            failures.push({ metadataDisposeError: String(error.stack || error) });
        }
    }

    try {
        helper?.dispose();
    } catch (error) {
        failures.push({ helperDisposeError: String(error.stack || error) });
    }

    Object.assign(globalThis.originalBoot, { vmExitObserved, exitCode, completed: true, originalFullShutdownQualified: false });
    stop.disabled = true;
    status.textContent = failures.length ? 'Original startup boundary failed; retained diagnostics.' : 'Java boundary ended; external resource/input/pixel/hash review required.';
}
