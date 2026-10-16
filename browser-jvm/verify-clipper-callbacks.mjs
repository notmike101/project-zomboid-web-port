import assert from 'node:assert/strict';
import { createBrowserPhysics } from './browser-physics.js';

const physics = createBrowserPhysics();
/**
 * Invokes the actual native callback registry.
 *
 * @param {string} name - Original native method suffix.
 * @param {...unknown} args - Original native arguments.
 * @returns {Promise<unknown>} Callback result.
 */
const call = (name, ...args) => physics.natives[`Java_zombie_vehicles_Clipper_${name}`](...args);

/**
 * Models Java identity across fresh wrappers of the same object.
 *
 * @this {object}
 * @param {object} other - Other Java wrapper.
 * @returns {Promise<boolean>} Whether both wrappers represent the same object.
 */
function sameOwner(other) {
    return Promise.resolve(other.id === this.id);
}

const owner = { id: 1, equals: sameOwner };

await call('newInstance', null, owner);
await call('clear', null, { ...owner });
await assert.rejects(call('newInstance', null, { ...owner }), /duplicate/);
await assert.rejects(call('clear', null, { id: 2, equals: sameOwner }), /Unknown/);
await assert.rejects(call('generatePolygons', null, owner, 1, 0, 0), /require the browser JVM/);

const forwarded = [];
let lookups = 0;
const helper = Object.fromEntries(['allocate', 'clear', 'addPath', 'addAABB', 'addPolygon', 'clipAABB', 'generate', 'getPolygon'].map((name) => [name, async (...args) => {
    await Promise.resolve();
    forwarded.push([name, ...args]);

    if (name === 'generate') {
        if (args[1] !== 1) {
            throw new Error('Unqualified operation');
        }

        return 2;
    }

    return name === 'getPolygon' ? 0 : undefined;
}]));
const host = {};

Object.defineProperty(host, 'ClipperSupport', { /**
                                                 * Counts actual helper class resolutions.
                                                 *
                                                 * @returns {Promise<object>} Java helper proxy.
                                                 */
    get: () => {
        lookups++;

        return Promise.resolve(helper);
    },
});
const lib = { port: { host } };
const nextOwner = { id: 3, equals: sameOwner };
const buffer = {};

await call('newInstance', lib, nextOwner);
await call('clear', lib, nextOwner);
await call('addPath', lib, nextOwner, 6, buffer, false, true);
await call('addAABB', lib, nextOwner, 0, 1, 2, 3);
await call('addPolygon', lib, nextOwner, 0, 1, 2, 3, 4, 5, 6, 7);
await call('clipAABB', lib, nextOwner, 4, 3, 2, 1);
assert.equal(await call('generatePolygons', lib, nextOwner, 1, 0, 0), 2);
assert.equal(await call('getPolygon', lib, nextOwner, 1, buffer), 0);
await assert.rejects(call('generatePolygons', lib, nextOwner, 2, 0, 0), /Unqualified/);
assert.equal(lookups, 1);
assert.deepEqual(forwarded, [
    ['allocate', nextOwner],
    ['clear', nextOwner],
    ['addPath', nextOwner, 6, buffer, false, true],
    ['addAABB', nextOwner, 0, 1, 2, 3],
    ['addPolygon', nextOwner, 0, 1, 2, 3, 4, 5, 6, 7],
    ['clipAABB', nextOwner, 4, 3, 2, 1],
    ['generate', nextOwner, 1, 0, 0],
    ['getPolygon', nextOwner, 1, buffer],
    ['generate', nextOwner, 2, 0, 0],
]);
assert.deepEqual(physics.snapshot().clipperContainers, { allocations: 2, clears: 2 });
console.info('Clipper callbacks preserve container checks and cache one Java helper per library.');
