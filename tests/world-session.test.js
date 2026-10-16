import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createEngine } from '../src/engine.js';
import { stageCells } from '../src/world-session.js';

/**
 * Empty synthetic native-shape cell, no proprietary bytes.
 *
 * @param {string} name - Coordinate-bearing filename.
 * @returns {File} Selected cell.
 */
function cellFile(name) {
    const bytes = new Uint8Array(1_026);

    bytes[1] = 1;

    return new File([bytes], name);
}

test('first nonzero-cell import stages a passable spawn without changing live simulation', async () => {
    const engineSource = await readFile(new URL('../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url));
    const engine = await createEngine(engineSource);
    const before = engine.saveState();
    const staged = await stageCells({ engineSource, engine, cells: [], files: [cellFile('chunkdata_2_3.bin')] });
    const spawned = staged.engine.snapshot();

    assert.equal(spawned.x, 640.5);
    assert.equal(spawned.y, 896.5);
    assert.equal(staged.engine.navFlags(Math.floor(spawned.x), Math.floor(spawned.y)), 0);
    assert.deepEqual(engine.saveState(), before);
    assert.equal(engine.worldBounds().active, false);
});

test('a corrupt added cell leaves existing actor, world and retained sources intact', async () => {
    const engineSource = await readFile(new URL('../engine/target/wasm32-unknown-unknown/release/pz_engine.wasm', import.meta.url));
    const engine = await createEngine(engineSource);
    const initial = await stageCells({ engineSource, engine, cells: [], files: [cellFile('chunkdata_0_0.bin')] });
    const before = initial.engine.saveState();
    const retained = new Uint8Array(initial.cells[0].bytes);
    const malformed = new File([new Uint8Array([0, 1, 2])], 'chunkdata_1_0.bin');

    await assert.rejects(stageCells({ engineSource, engine: initial.engine, cells: initial.cells, files: [malformed] }), /cell|truncat/u);
    assert.deepEqual(initial.engine.saveState(), before);
    assert.deepEqual(initial.cells[0].bytes, retained);
    assert.equal(initial.engine.navFlags(300, 0), 0xFF_FF_FF_FF);
});
