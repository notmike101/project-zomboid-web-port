import { createBrowserPhysics as createPlatformPhysics } from './browser-physics.js';
import { createVehicleWorldNatives } from './bullet-vehicle-natives.js';

let owner;
const bulletPrefix = 'Java_zombie_core_physics_Bullet_';
const retainedDefinitions = new Set(['defineRagdollBodyDynamics', 'defineRagdollConstraints', 'defineRagdollAnchors', 'defineRagdollBodyPartInfo']);

/**
 * Composes one real Bullet world with the existing Clipper, collision and ragdoll-definition owner.
 *
 * @returns {Promise<object>} The one native owner for this browser VM.
 */
export async function createBrowserPhysics() {
    if (owner) {
        throw new Error('Real Bullet startup owner already exists');
    }

    const platform = createPlatformPhysics();
    // eslint-disable-next-line import/no-unresolved -- The preparer freezes the real compiled engine at this route.
    const { default: createEngine } = await import('./bullet-engine.mjs');
    const response = await fetch('./bullet-engine.wasm');

    if (!response.ok) {
        throw new Error('Prepared real Bullet startup engine is unavailable');
    }

    const engine = await createEngine({ wasmBinary: new Uint8Array(await response.arrayBuffer()) });
    const bullet = createVehicleWorldNatives(engine);
    const natives = Object.fromEntries(Object.entries(platform.natives).filter(([name]) => !name.startsWith(bulletPrefix)
        || retainedDefinitions.has(name.slice(bulletPrefix.length))));

    Object.assign(natives, bullet.natives, {
        /**
         * Identifies the selected engine; the installed revision remains unknown.
         *
         * @returns {string} Actual selected engine identity.
         */
        Java_zombie_core_physics_Bullet_getPZBulletVersion() {
            return 'browser-bullet-3.25-double/vehicle';
        },
    });
    owner = {
        ...platform, natives,
        /**
         * Keeps platform diagnostics separate from the actual real-engine state.
         *
         * @returns {object} Both actual owners' detached observations.
         */
        snapshot: () => ({ ...platform.snapshot(), realBullet: bullet.snapshot() }),
    };

    return owner;
}

/**
 * Resolves the original native-library descriptor against the already-created owner.
 *
 * @returns {object} The same owner's actual Bullet callbacks.
 */
export function bulletStartupNatives() {
    if (!owner) {
        throw new Error('Original Bullet descriptor imported before its startup owner');
    }

    return Object.fromEntries(Object.entries(owner.natives).filter(([name]) => name.startsWith(bulletPrefix)));
}
