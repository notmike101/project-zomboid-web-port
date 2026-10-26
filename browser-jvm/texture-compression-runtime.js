/* eslint-disable jsdoc/require-jsdoc -- Private pinned codec loader and synchronous upload owner. */
const digest = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    (value) => value.toString(16).padStart(2, '0')).join('');

/**
 * Loads the pinned real BC3 encoder; no GL capability is advertised by this loader alone.
 *
 * @param {string} manifestSHA - Admitted manifest identity.
 * @returns {Promise<object>} One owned verified codec.
 */
export async function loadTextureCompression(manifestSHA) {
    const get = async (name) => {
        const response = await fetch(`/texture-compression/${name}`, { cache: 'no-store' });

        if (!response.ok) {
            throw new Error(`Texture compression artifact unavailable: ${name}`);
        }

        return new Uint8Array(await response.arrayBuffer());
    };

    const manifestBytes = await get('manifest.json');

    if (await digest(manifestBytes) !== manifestSHA) {
        throw new Error('Texture compression manifest changed');
    }

    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));

    if (manifest.schema !== 'texture-compression-runtime-v1') {
        throw new Error('Unqualified texture compression schema');
    }

    const script = await get('texture-compression-engine.mjs');
    const wasm = await get('texture-compression-engine.wasm');

    if (await digest(script) !== manifest.moduleSHA || await digest(wasm) !== manifest.wasmSHA) {
        throw new Error('Texture compression codec identity changed');
    }

    const url = URL.createObjectURL(new Blob([script], { type: 'text/javascript' }));

    try {
        const { default: create } = await import(url);

        return createTextureCompressionOwner(await create({
            wasmBinary: wasm, locateFile(name) {
                if (name !== 'texture-compression-engine.wasm') {
                    throw new Error('Unexpected texture codec resource');
                }

                return new URL(`/texture-compression/${name}`, location.origin).href;
            },
        }));
    } finally {
        URL.revokeObjectURL(url);
    }
}

/**
 * Uses one four-row scratch strip and returns only the compressed upload bytes.
 *
 * @param {object} module - Actual Emscripten encoder.
 * @returns {object} Synchronous bounded encoder owner.
 */
export function createTextureCompressionOwner(module) {
    let disposed = false;

    return {
        encodeBC3(width, height, pixels, layout) {
            if (disposed) {
                throw new Error('Texture compression owner disposed');
            }

            if (![width, height].every((size) => Number.isInteger(size) && size > 0 && size <= 32_768)) {
                throw new RangeError('Invalid compression dimensions');
            }

            const { stride, skipRows, skipPixels } = layout;

            if (![stride, skipRows, skipPixels].every((size) => Number.isSafeInteger(size) && size >= 0)
                || stride < width * 4 || skipRows * stride + skipPixels * 4 + (height - 1) * stride + width * 4 > pixels.byteLength) {
                throw new RangeError('Compressed upload pixel extent exceeds source');
            }

            const rowBytes = Math.ceil(width / 4) * 16;
            const output = new Uint8Array(rowBytes * Math.ceil(height / 4));
            const source = module._malloc(width * 16);
            const destination = module._malloc(rowBytes);

            if (!source || !destination) {
                if (source) {
                    module._free(source);
                }

                if (destination) {
                    module._free(destination);
                }

                throw new Error('Texture codec scratch allocation failed');
            }

            try {
                for (let y = 0; y < height; y += 4) {
                    const rows = Math.min(4, height - y);

                    for (let row = 0; row < rows; row++) {
                        const start = (skipRows + y + row) * stride + skipPixels * 4;

                        module.HEAPU8.set(pixels.subarray(start, start + width * 4), source + row * width * 4);
                    }

                    if (module._tc_encode_row(source, width, rows, destination) !== rowBytes) {
                        throw new Error('Texture codec rejected actual pixel strip');
                    }

                    output.set(module.HEAPU8.subarray(destination, destination + rowBytes), y / 4 * rowBytes);
                }

                return output;
            } finally {
                module._free(destination);
                module._free(source);
            }
        },
        dispose() {
            disposed = true;
            module = null;
        },
    };
}
