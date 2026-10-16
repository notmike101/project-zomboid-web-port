import assert from 'node:assert/strict';
import { createRagdollDefinitions } from './ragdoll-definitions.js';

const store = createRagdollDefinitions();
const cases = [
    ['BodyDynamics', 8, [3, 0.1, 0.2, 2, 0.4, 0.5, 0.6, -0]],
    ['Constraints', 22, [1, 2, 3, 4, ...Array.from({ length: 18 }).fill(0.25)]],
    ['Anchors', 5, [1, 2, 0, 1, 1]],
    ['BodyPartInfo', 10, [1, 1, 0.1, 1, 0.2, 2, 5, 0, -0, 0]],
];

for (const [suffix, stride, fields] of cases) {
    const callback = store.natives[`Java_zombie_core_physics_Bullet_defineRagdoll${suffix}`];
    const payload = new Float32Array(fields);

    assert.equal(callback(null, payload, false), true);
    const saved = store.snapshot().find((item) => item.stride === stride);

    assert.deepEqual(saved.values, [...payload]);
    assert.equal(saved.records, 1);
    payload[0] = 99;
    saved.values[0] = 88;
    assert.equal(store.snapshot().find((item) => item.stride === stride).values[0], fields[0]);
    const before = store.snapshot();

    for (const invalid of [new Float32Array(stride - 1), new Float32Array(stride).fill(Number.NaN), fields]) {
        assert.throws(() => callback(null, invalid, false));
        assert.deepEqual(store.snapshot(), before);
    }

    assert.throws(() => callback(null, payload, true), /Live ragdoll mutation/);
    assert.deepEqual(store.snapshot(), before);
    payload[0] = 1.5;
    assert.throws(() => callback(null, payload, false), /identifier/);
    assert.deepEqual(store.snapshot(), before);
}

assert.equal(store.snapshot().length, 4);
assert(Object.is(store.snapshot()[0].values[7], -0));
assert.throws(() => store.natives.Java_zombie_core_physics_Bullet_defineRagdollAnchors(
    null, new Float32Array([1, 2, 2, 1, 1]), false), /boolean/);
console.info('Ragdoll definition transport passed; no bodies, simulation or live mutation implemented.');
