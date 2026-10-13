import { createEngine } from './engine.js';

/**
 * Stage selected navigation cells without mutating the live world.
 * Native chunkdata is ground-floor navigation, not geometry or a native save.
 * Initial placement selects passable terrain nearest the first cell centre;
 * it is a browser spawn approximation, not an original spawnpoint rule.
 *
 * @param {object} options - Current world and selected files.
 * @param {string|URL|Uint8Array} options.engineSource - WASM bytes or URL.
 * @param {object} options.engine - Current engine.
 * @param {object[]} options.cells - Existing {x,y,bytes} cells.
 * @param {File[]|FileList} options.files - Selected chunkdata files.
 * @returns {Promise<object>} Staged engine and detached cell sources.
 */
async function stageCells({ engineSource, engine, cells, files }) {
    const stagedCells = new Map(cells.map((cell) => [`${cell.x},${cell.y}`, {
        x: cell.x, y: cell.y, bytes: new Uint8Array(cell.bytes),
    }]));

    for (const file of files) {
        const match = /^chunkdata_(-?\d+)_(-?\d+)\.bin$/u.exec(file.name);

        if (!match || file.size > 66_562) {
            throw new TypeError('Select chunkdata_X_Y.bin navigation cells no larger than 66562 bytes each.');
        }

        const x = Number(match[1]);
        const y = Number(match[2]);

        // Sequential reads bound peak import memory to one cell.
        // eslint-disable-next-line no-await-in-loop
        stagedCells.set(`${x},${y}`, { x, y, bytes: new Uint8Array(await file.arrayBuffer()) });

        if (stagedCells.size > 64) {
            throw new RangeError('This browser slice supports at most 64 loaded navigation cells.');
        }
    }

    if (stagedCells.size === 0) {
        throw new TypeError('No navigation cells selected.');
    }

    const staged = await createEngine(engineSource);
    const imported = [...stagedCells.values()];

    for (const cell of imported) {
        staged.worldImportCell(cell.x, cell.y, cell.bytes);
    }

    const state = engine.saveState();
    let x = state.values[0];
    let y = state.values[1];
    const flags = staged.navFlags(Math.floor(x), Math.floor(y));

    if (state.values[9] !== 1 || flags === 0xFF_FF_FF_FF || (flags & 0x21) !== 0) {
        let nearest;
        let distance = Infinity;

        for (const cell of imported) {
            for (let index = 0; index < 65_536; index += 1) {
                const localX = index % 256;
                const localY = Math.floor(index / 256);
                const tileX = cell.x * 256 + localX;
                const tileY = cell.y * 256 + localY;
                const tileFlags = staged.navFlags(tileX, tileY);

                if ((tileFlags & 0x29) !== 0) {
                    continue;
                }

                const candidate = (localX - 128) ** 2 + (localY - 128) ** 2;

                if (candidate < distance) {
                    distance = candidate;
                    nearest = { x: tileX + 0.5, y: tileY + 0.5 };
                }
            }
        }

        if (!nearest) {
            throw new RangeError('Selected map cells contain no dry, passable spawn tile.');
        }

        x = nearest.x;
        y = nearest.y;
    }

    state.values = [x, y, state.values[2], x, y, 0, 0, 0, state.values[8], 1];
    staged.loadState(state);

    return { engine: staged, cells: imported };
}

export { stageCells };
