/**
 * Owns actual browser image cursors and their normal/hidden mode.
 *
 * @param {HTMLCanvasElement} canvas - Existing graphics surface.
 * @returns {object} Native callbacks, cursor mode ownership and bounded diagnostics.
 */
export function createCustomCursors(canvas) {
    // shortcut: static images up to 32 pixels; qualify larger or animated cursors before extending.
    const previous = canvas.style.cursor;
    const images = new Map();
    const gl = canvas.getContext('webgl2');
    let selected = null;
    let mode = 212_993;
    let closed = false;
    let created = 0;
    let revoked = 0;

    /**
     * Rejects closed surfaces and unqualified pointer lock.
     *
     * @param {object} lib - Current Java callback context.
     */
    async function live(lib) {
        if (closed || !canvas.isConnected || gl.isContextLost()) {
            throw await new (await lib.java.lang.IllegalStateException)('Cursor surface is closed');
        }

        if (document.pointerLockElement) {
            throw await new (await lib.java.lang.UnsupportedOperationException)('Relative image cursors are unqualified');
        }
    }

    /**
     * Computes CSS for an existing image or default cursor.
     *
     * @param {string|null} url - Owned image URL.
     * @param {number} value - Requested cursor mode.
     * @returns {string} CSS image URL with hotspot, hidden state or default fallback.
     */
    function style(url, value) {
        if (value === 212_994) {
            return 'none';
        }

        const image = images.get(url);

        return image ? `url("${url}") ${image.x} ${image.y}, default` : 'default';
    }

    /**
     * Applies actual CSS before publishing state.
     *
     * @param {object} lib - Current Java callback context.
     * @param {string|null} url - Owned image URL.
     * @param {number} value - Requested cursor mode.
     */
    async function apply(lib, url, value) {
        await live(lib);
        const before = canvas.style.cursor;
        const desired = style(url, value);

        canvas.style.cursor = desired;
        const actual = getComputedStyle(canvas).cursor;

        if ((value === 212_994 && actual !== 'none') || (value === 212_993 && url && !actual.includes(url))
            || (value === 212_993 && !url && actual !== 'default')) {
            canvas.style.cursor = before;
            throw await new (await lib.java.lang.UnsupportedOperationException)('Browser rejected actual image cursor style');
        }
    }

    return {
        natives: {
            /**
             * Encodes and decodes vendor RGBA into an owned image.
             *
             * @param {object} lib - Current Java callback context.
             * @param {number} width - Image width.
             * @param {number} height - Image height.
             * @param {number} x - Hotspot column.
             * @param {number} y - Hotspot row.
             * @param {number[]} rgba - Signed Java pixel bytes.
             * @returns {Promise<string>} Successfully decoded owned blob image URL.
             */
            async Java_port_host_BrowserCustomCursor_createImage(lib, width, height, x, y, rgba) {
                await live(lib);

                if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 32 || height > 32
                    || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height || rgba.length !== width * height * 4) {
                    throw await new (await lib.java.lang.IllegalArgumentException)('Invalid cursor dimensions/hotspot/pixel range');
                }

                // Java bytes are signed: wrap their bits before constructing ImageData's clamped view.
                const unsigned = Uint8Array.from(rgba);
                const pixels = new Uint8ClampedArray(unsigned.buffer, unsigned.byteOffset, unsigned.byteLength);
                const imageCanvas = document.createElement('canvas');

                imageCanvas.width = width;
                imageCanvas.height = height;
                imageCanvas.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
                const blob = await new Promise((resolve) => {
                    imageCanvas.toBlob(resolve, 'image/png');
                });

                if (!blob) {
                    throw await new (await lib.java.lang.IllegalStateException)('PNG cursor encoding failed');
                }

                const url = URL.createObjectURL(blob);

                try {
                    const image = new Image();

                    image.src = url;
                    await image.decode();
                    await live(lib);

                    if (image.naturalWidth !== width || image.naturalHeight !== height) {
                        throw new Error('Decoded cursor dimensions differ');
                    }

                    images.set(url, { width, height, x, y, pixels: Array.from(pixels), image });
                    created++;

                    return url;
                } catch (error) {
                    URL.revokeObjectURL(url);
                    throw await new (await lib.java.lang.IllegalStateException)(`Cursor image load failed: ${String(error)}`);
                }
            },
            /**
             * Selects an owned image while retaining hidden mode.
             *
             * @param {object} lib - Current Java callback context.
             * @param {string|null} url - Owned image URL.
             */
            async Java_port_host_BrowserCustomCursor_selectImage(lib, url) {
                url = String(url);

                if (!images.has(url)) {
                    throw await new (await lib.java.lang.IllegalStateException)('Foreign or released image cursor');
                }

                await apply(lib, url, mode);
                selected = url;
            },
            /**
             * Revokes one image and detaches its selection.
             *
             * @param {object} lib - Current Java callback context.
             * @param {string|null} url - Owned image URL.
             */
            async Java_port_host_BrowserCustomCursor_releaseImage(lib, url) {
                url = String(url);

                if (!images.has(url)) {
                    throw await new (await lib.java.lang.IllegalStateException)('Foreign or released image cursor');
                }

                if (selected === url) {
                    await apply(lib, null, mode);
                    selected = null;
                }

                images.delete(url);
                URL.revokeObjectURL(url);
                revoked++;
            },
        },
        /**
         * Changes mode while retaining image selection.
         *
         * @param {object} lib - Current Java callback context.
         * @param {number} value - Requested cursor mode.
         */
        async setMode(lib, value) {
            if (![212_993, 212_994].includes(value)) {
                throw await new (await lib.java.lang.UnsupportedOperationException)('Only normal/hidden image cursor modes admitted');
            }

            await apply(lib, selected, value);
            mode = value;
        },
        /**
         * Copies bounded image ownership diagnostics.
         *
         * @returns {object} Current image ownership, selection, mode and raw vendor pixels.
         */
        snapshot: () => ({
            created, revoked, owned: images.size, selected, mode, closed, style: canvas.style.cursor,
            images: [...images].map(([url, image]) => ({ url, width: image.width, height: image.height, x: image.x, y: image.y, pixels: [...image.pixels] })),
        }),
        /**
         * Revokes every URL and restores prior CSS.
         *
         */
        dispose() {
            if (closed) {
                return;
            }

            for (const url of images.keys()) {
                URL.revokeObjectURL(url);
                revoked++;
            }

            images.clear();
            selected = null;
            closed = true;
            canvas.style.cursor = previous;
        },
    };
}
