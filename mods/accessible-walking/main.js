/**
 * @file Built-in sample mod: raises the real WASM movement speed and puts it
 * back. It is the M1 proof that uncompiled JavaScript changes authoritative
 * engine rules, not a shipped gameplay feature.
 *
 * Contract: export `manifest` and `activate(api)`. `activate` runs once,
 * synchronously, and returns a synchronous cleanup function the host calls when
 * the mod is unloaded. See docs/modding/README.md.
 */

import { speed } from './settings.js';

/**
 * Detached engine state. `action`: 0 idle, 1 destination, 2 walking.
 *
 * @typedef {{ apiVersion: number, tick: number, x: number, y: number, speed: number, action: 0|1|2 }} Snapshot
 */
/**
 * The mod API surface this sample uses.
 *
 * @typedef {{ version: string, movement: { getState: () => Snapshot, setSpeed: (speed: number) => void } }} MovementApi
 */

/**
 * Mod identity. `apiVersion` must match the host's mod API exactly, or the host
 * refuses to activate this module.
 *
 * @type {{ id: string, version: string, apiVersion: string, name: string }}
 */
export const manifest = {
    id: 'accessible-walking',
    version: '0.1.0',
    apiVersion: '0.1.0',
    name: 'Accessible walking',
};

/**
 * Applies the sample speed through the public API only.
 *
 * @param {MovementApi} api - Per-mod handle from the host.
 * @returns {() => void} Cleanup that restores the speed found at activation, so
 * disabling the mod cannot leave a speed the user never asked for.
 */
export function activate(api) {
    const previousSpeed = api.movement.getState().speed;

    api.movement.setSpeed(speed);

    return () => {
        api.movement.setSpeed(previousSpeed);
    };
}
