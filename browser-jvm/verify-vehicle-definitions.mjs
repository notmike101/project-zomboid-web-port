import assert from 'node:assert/strict';
import { createBrowserPhysics } from './browser-physics.js';

const physics = createBrowserPhysics();
const define = physics.natives.Java_zombie_core_physics_Bullet_defineVehicleScript;
const payload = new Float32Array(200);

payload.set([1, 800, 0.1, 20, 4, 4, 500, 0.3, 1, 1, 1]);
payload.set([1, 0, 0.3, 1, 0.4], 11);
payload.set([3, 1, 0, 0, 0, 1, 2, 3, 0, 0, 0, 2, 0, 0, 0, 1, 3, 0, 0, 0], 16);
define(null, 'Base.Qualification', payload);
const original = physics.snapshot().vehicleDefinitions;

assert.equal(original.length, 1);
assert.deepEqual(original[0].values, [...payload]);
payload[1] = 900;
assert.equal(physics.snapshot().vehicleDefinitions[0].values[1], 800);
original[0].values[1] = 0;
assert.equal(physics.snapshot().vehicleDefinitions[0].values[1], 800);
define(null, 'Base.Qualification', payload);
assert.equal(physics.snapshot().vehicleDefinitions.length, 1);
assert.equal(physics.snapshot().vehicleDefinitions[0].values[1], 900);

for (const [index, value] of [[10, -1], [10, 0.5], [11, 2], [16, 0], [17, 4], [199, 1], [1, Number.NaN]]) {
    const invalid = new Float32Array(payload);

    invalid[index] = value;
    const before = physics.snapshot();

    assert.throws(() => define(null, 'Base.Qualification', invalid));
    assert.deepEqual(physics.snapshot(), before);
}

assert.throws(() => define(null, '', payload));
assert.throws(() => define(null, 'Base.Qualification', [...payload]));
assert.throws(() => define(null, 'Base.Qualification', new Float32Array(199)));
physics.initialize(0, 0, 1, 1, 0, 0, false);
assert.equal(physics.snapshot().vehicleDefinitions.length, 1);
assert.equal(physics.snapshot().dynamicBodies.vehicles, 0);
await physics.natives.Java_zombie_core_physics_Bullet_destroyWorld();
assert.equal(physics.snapshot().vehicleDefinitions.length, 1);
assert.equal(physics.snapshot().world, null);
console.info('Vehicle metadata transport passed; vehicle dynamics remain unimplemented.');
