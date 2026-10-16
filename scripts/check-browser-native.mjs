/**
 * Exercise real UI bindings, lifecycle collection and native GPU stencil pixels together.
 * This self-contained function can be passed directly to an existing page.evaluate.
 *
 * @returns {Promise<object>} Synthetic pixel/input assertions and native adapter metadata only.
 */
export async function checkUIStencilPixelsInPage() {
    if (!navigator.gpu) {
        throw new Error('Native UI stencil proof requires WebGPU');
    }

    const adapter = await navigator.gpu.requestAdapter({ forceFallbackAdapter: false });

    if (!adapter) {
        throw new Error('Native UI stencil proof requires an available GPU adapter');
    }

    const fallback = adapter.info?.isFallbackAdapter ?? adapter.isFallbackAdapter ?? null;

    if (fallback === true) {
        throw new Error('Native UI stencil proof rejects a fallback adapter');
    }

    const { createGameUI, createUIRenderer } = await import(new URL('src/game-ui.js', document.baseURI).href);
    const device = await adapter.requestDevice();
    const cases = [];
    const owner = 'native-stencil-proof';
    let assertions = 0;
    let renderer;
    let ui;
    let elements;
    let failure;

    device.pushErrorScope('validation');

    /**
     * Invoke genuine producer bindings rather than authoring GPU commands.
     *
     * @param {number} id - Synthetic resident element.
     * @param {string} name - Native UI operation.
     * @param {...unknown} args - Native operation arguments.
     * @returns {unknown} Actual binding result.
     */
    function call(id, name, ...args) {
        return ui.bindings.call('element', owner, id, name, ...args);
    }

    /**
     * Draw through the existing null-texture white fallback.
     *
     * @param {number} id - Synthetic drawing element.
     * @param {number} x - Relative x.
     * @param {number} y - Relative y.
     * @param {number} width - Logical width.
     * @param {number} height - Logical height.
     * @param {number[]} color - Opaque normalized RGBA.
     */
    function draw(id, x, y, width, height, color) {
        call(id, 'DrawTextureScaledColor', null, x, y, width, height, ...color);
    }

    /**
     * Collect real lifecycle commands, submit them and inspect actual RGBA bytes.
     *
     * @param {string} name - Behavior under test.
     * @param {object} callbacks - Actual per-element prerender/render callbacks.
     * @param {Array} expected - Tuples of pixel x, y, expected bytes, and failure label.
     * @param {number} [width] - Physical target width.
     * @param {number} [height] - Physical target height.
     * @param {number} [scale] - Physical pixels per logical pixel.
     * @returns {Promise<void>} Completed readback assertions.
     */
    async function frame(name, callbacks, expected, width = 100, height = 80, scale = 1) {
        ui.setViewport(width / scale, height / scale);

        for (const id of elements) {
            ui.setCallbacks(id, callbacks[id] ?? {});
        }

        const commands = ui.render();
        const target = device.createTexture({ label: `stencil-proof-${name}`, size: [width, height], format: 'rgba8unorm', usage: globalThis.GPUTextureUsage.RENDER_ATTACHMENT | globalThis.GPUTextureUsage.COPY_SRC });
        const bytesPerRow = Math.ceil(width * 4 / 256) * 256;
        let readback;

        try {
            readback = device.createBuffer({ label: 'stencil-proof-readback', size: bytesPerRow * height, usage: globalThis.GPUBufferUsage.COPY_DST | globalThis.GPUBufferUsage.MAP_READ });
            const encoder = device.createCommandEncoder();
            const pass = encoder.beginRenderPass({
                colorAttachments: [{ view: target.createView(), loadOp: 'clear', clearValue: [0, 0, 0, 1], storeOp: 'store' }],
                depthStencilAttachment: renderer.stencilAttachment(width, height),
            });

            renderer.render(pass, commands, width, height, scale);
            pass.end();
            encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow, rowsPerImage: height }, [width, height]);
            device.queue.submit([encoder.finish()]);
            await readback.mapAsync(globalThis.GPUMapMode.READ);
            const bytes = new Uint8Array(readback.getMappedRange());

            for (const [x, y, color, label] of expected) {
                const offset = y * bytesPerRow + x * 4;
                const actual = Array.from(bytes.subarray(offset, offset + 4));

                if (actual.some((value, channel) => value !== color[channel])) {
                    throw new Error(`${name}: ${label} at ${x},${y}: expected ${color}, received ${actual}`);
                }

                assertions++;
            }

            cases.push(name);
        } finally {
            if (readback?.mapState === 'mapped') {
                readback.unmap();
            }

            readback?.destroy();
            target.destroy();
        }
    }

    try {
        renderer = await createUIRenderer(device, 'rgba8unorm', device.createSampler({ minFilter: 'nearest', magFilter: 'nearest' }));
        ui = createGameUI();
        ui.setViewport(100, 80);
        ui.initialize({
            textures: [{ path: 'synthetic-atlas', width: 1, height: 1 }],
            font: { atlasPath: 'synthetic-atlas', descriptor: 'info face="SyntheticStencil" size=1\ncommon lineHeight=1 base=1 scaleW=1 scaleH=1 pages=1 packed=0\npage id=0 file="synthetic.png"\nchars count=1\nchar id=32 x=0 y=0 width=0 height=0 xoffset=0 yoffset=0 xadvance=1 page=0 chnl=15' },
            translations: {},
            settings: { moodleSize: 1, fontSizeReal: 1, lockFPS: 60, gray: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, goodHighlight: { r: 0, g: 1, b: 0, a: 1 }, badHighlight: { r: 1, g: 0, b: 0, a: 1 } },
        });
        const root = ui.bindings.call('new', owner, {});
        const pane = ui.bindings.call('new', owner, {});
        const text = ui.bindings.call('new', owner, {});
        const border = ui.bindings.call('new', owner, {});

        elements = [root, pane, text, border];

        for (const [id, x, y, width, height] of [[root, 10.75, 8.5, 30, 25], [pane, 3.75, 4.5, 12, 10], [text, 2.75, 2.5, 4, 3], [border, 0, 0, 20, 20]]) {
            call(id, 'setX', x);
            call(id, 'setY', y);
            call(id, 'setWidth', width);
            call(id, 'setHeight', height);
        }

        call(pane, 'setXScroll', 0.75);
        call(pane, 'setYScroll', 1.25);
        call(root, 'AddChild', pane);
        call(pane, 'AddChild', text);
        ui.bindings.call('add', owner, root);
        ui.bindings.call('add', owner, border);
        call(border, 'setMaxDrawHeight', 15);
        call(border, 'setVisible', false);
        const black = [0, 0, 0, 255];
        const red = [255, 0, 0, 255];
        const green = [0, 255, 0, 255];
        const blue = [0, 0, 255, 255];
        const magenta = [255, 0, 255, 255];
        const cyan = [0, 255, 255, 255];
        const white = [255, 255, 255, 255];
        const full = [0, 1, 1, 1];

        /**
         * Reproduce nested inventory page/pane/text traversal with optional native repaints.
         *
         * @param {boolean} repaintText - Restore the text hole to the pane's reference.
         * @param {boolean} repaintParent - Restore the pane hole to the page's reference.
         * @returns {object} Actual lifecycle callbacks for the synthetic element tree.
         */
        function nested(repaintText, repaintParent) {
            return {
                [root]: {
                    /**
                     * Establish the page's global stencil reference before visiting children.
                     */
                    prerender: () => {
                        call(root, 'setStencilRect', 0.75, 0.75, 30.9, 25.9);
                    },
                    /**
                     * Exercise parent holes, global suspension and final depth-zero drawing.
                     */
                    render: () => {
                        draw(root, 5, 6, 9, 5, [1, 1, 0, 1]);

                        if (repaintParent) {
                            call(root, 'repaintStencilRect', 3, 4, 12, 10);
                            draw(root, 5, 6, 9, 5, [1, 0, 1, 1]);
                        }

                        call(root, 'suspendStencil');
                        draw(root, 65, 56, 9, 5, [0, 1, 0, 1]);
                        call(pane, 'resumeStencil');
                        draw(root, 65, 56, 9, 5, full);
                        call(root, 'clearStencilRect');
                        draw(root, 40, 40, 9, 5, [1, 1, 1, 1]);
                        call(root, 'repaintStencilRect', -10, -8, 100, 80);
                        draw(root, 70, 60, 9, 5, [1, 1, 1, 1]);
                        call(root, 'clearStencilRect');
                    },
                },
                [pane]: {
                    /**
                     * Nest the pane mask without applying its own drawing scroll.
                     */
                    prerender: () => {
                        call(pane, 'setStencilRect', 0, 0, 12, 10);
                    },
                    /**
                     * Keep the text hole until repaint, then leave a pane hole for the parent.
                     */
                    render: () => {
                        draw(pane, 1.25, 0.75, 9, 5, [0, 1, 0, 1]);

                        if (repaintText) {
                            call(pane, 'repaintStencilRect', 2.75, 2.5, 4.9, 3.9);
                            draw(pane, 1.25, 0.75, 9, 5, [0, 0, 1, 1]);
                        }

                        call(pane, 'clearStencilRect');
                    },
                },
                [text]: {
                    /**
                     * Establish the independently positioned text mask inside the pane.
                     */
                    prerender: () => {
                        call(text, 'setStencilRect', 0, 0, 4.9, 3.9);
                    },
                    /**
                     * Paint text reference pixels before clearing back to the pane reference.
                     */
                    render: () => {
                        draw(pane, 1.25, 0.75, 9, 5, [1, 0, 0, 1]);
                        call(text, 'clearStencilRect');
                    },
                },
            };
        }

        await frame('nested-clear-leaves-text-and-pane-holes', nested(false, false), [
            [16, 15, red, 'cleared text pixels retain their old color until repaint'],
            [20, 15, green, 'pane reference still draws outside its text hole'],
            [76, 65, green, 'suspend on page and resume on pane share global state'],
            [51, 49, white, 'final clear restores unmasked drawing outside the page'],
            [81, 70, white, 'depth-zero repaint is a no-op'],
            [1, 1, black, 'ordinary masks do not write color'],
        ]);
        await frame('text-repaint-restores-pane-reference', nested(true, false), [
            [16, 15, blue, 'text repaint restores the current pane reference'],
            [20, 15, blue, 'parent clear leaves the entire pane hole, not an intersected rectangle'],
        ]);
        await frame('parent-repaint-restores-page-reference', nested(true, true), [
            [16, 15, magenta, 'page repaint restores former pane and text pixels'],
            [20, 15, magenta, 'page reference can draw throughout the repainted pane'],
            [76, 65, green, 'resume still excludes the independent outside draw'],
        ]);
        await frame('repaint-can-expand-outside-original-mask', {
            [root]: {
                /**
                 * Establish the original page reference before expanding it with repaint.
                 */
                prerender: () => {
                    call(root, 'setStencilRect', 0, 0, 30, 25);
                },
                /**
                 * Repaint outside the original mask and draw through the resulting reference.
                 */
                render: () => {
                    call(root, 'repaintStencilRect', -10, -8, 8, 7);
                    draw(root, -10, -8, 100, 80, [1, 0, 1, 1]);
                },
            },
        }, [
            [1, 1, magenta, 'ALWAYS replace adds reference pixels outside the original rectangle'],
            [16, 15, magenta, 'original parent reference pixels remain paintable'],
            [76, 65, black, 'repaint does not alter unrelated stencil pixels'],
        ]);
        await frame('suspended-clear-and-repaint', {
            [root]: {
                /**
                 * Establish the page reference for the suspended nested-mask case.
                 */
                prerender: () => {
                    call(root, 'setStencilRect', 0, 0, 30, 25);
                },
                /**
                 * Clear the final page reference after the pane has finished.
                 */
                render: () => {
                    call(root, 'clearStencilRect');
                },
            },
            [pane]: {
                /**
                 * Establish the pane reference before its text child suspends stencil.
                 */
                prerender: () => {
                    call(pane, 'setStencilRect', 0, 0, 12, 10);
                },
                /**
                 * Draw while suspended, resume the pane comparison and clear its reference.
                 */
                render: () => {
                    draw(root, -10, -8, 100, 80, [1, 0, 0, 1]);
                    call(pane, 'resumeStencil');
                    draw(root, -10, -8, 100, 80, [0, 0, 1, 1]);
                    call(pane, 'clearStencilRect');
                },
            },
            [text]: {
                /**
                 * Establish text pixels at a deeper reference before suspension.
                 */
                prerender: () => {
                    call(text, 'setStencilRect', 0, 0, 4, 3);
                },
                /**
                 * Clear and repaint while suspended without changing the existing stencil pixels.
                 */
                render: () => {
                    call(text, 'suspendStencil');
                    call(text, 'clearStencilRect');
                    call(root, 'repaintStencilRect', -10, -8, 100, 80);
                },
            },
        }, [
            [76, 65, red, 'nested clear does not re-enable suspended stencil'],
            [20, 15, blue, 'resume restores the current pane comparison'],
            [16, 15, red, 'repaint while suspended does not overwrite the text hole'],
        ]);
        await frame('set-reenables-suspended-stencil', {
            [root]: {
                /**
                 * Suspend stencil after establishing the page reference.
                 */
                prerender: () => {
                    call(root, 'setStencilRect', 0, 0, 30, 25);
                    call(root, 'suspendStencil');
                },
                /**
                 * Clear the page reference after the pane tests set-induced re-enabling.
                 */
                render: () => {
                    call(root, 'clearStencilRect');
                },
            },
            [pane]: {
                /**
                 * Re-enable suspended stencil by setting the pane's nested rectangle.
                 */
                prerender: () => {
                    call(pane, 'setStencilRect', 0, 0, 12, 10);
                },
                /**
                 * Verify only pane-reference pixels draw after the nested set.
                 */
                render: () => {
                    draw(root, -10, -8, 100, 80, [0, 1, 0, 1]);
                    call(pane, 'clearStencilRect');
                },
            },
        }, [
            [76, 65, black, 'set re-enables stencil instead of leaving global drawing suspended'],
            [11, 10, black, 'nested set uses its new reference, not the page reference'],
            [16, 15, green, 'nested set remains visible inside the pane'],
        ]);
        await frame('midpass-full-reset-and-depth-zero-resume', {
            [root]: {
                /**
                 * Establish the page reference before the mid-pass full reset.
                 */
                prerender: () => {
                    call(root, 'setStencilRect', 0, 0, 30, 25);
                },
            },
            [pane]: {
                /**
                 * Establish the pane reference before the mid-pass full reset.
                 */
                prerender: () => {
                    call(pane, 'setStencilRect', 0, 0, 12, 10);
                },
            },
            [text]: {
                /**
                 * Establish the deepest reference so reset must remove nested holes.
                 */
                prerender: () => {
                    call(text, 'setStencilRect', 0, 0, 4, 3);
                },
                /**
                 * Reset all depths, resume at zero and establish a fresh pane-sized mask.
                 */
                render: () => {
                    call(text, 'clearStencilRect');
                    call(pane, 'clearStencilRect');
                    call(root, 'clearStencilRect');
                    call(root, 'resumeStencil');
                    draw(root, -10, -8, 100, 80, [1, 0, 0, 1]);
                    call(root, 'clearStencilRect');
                    call(root, 'resumeStencil');
                    call(root, 'repaintStencilRect', -10, -8, 100, 80);
                    call(root, 'setStencilRect', 3, 4, 12, 10);
                    draw(root, -10, -8, 100, 80, [0, 0, 1, 1]);
                },
            },
        }, [
            [76, 65, red, 'depth-zero resume permits drawing outside the old masks'],
            [16, 15, blue, 'full reset clears former nested holes before another set'],
            [20, 15, blue, 'depth-zero repaint does not repaint stencil pixels'],
        ]);
        await frame('next-frame-clears-native-stencil-and-global-depth', {
            [root]: {
                /**
                 * Start the new frame with a viewport-sized set at global depth zero.
                 */
                prerender: () => {
                    call(root, 'setStencilRect', -10, -8, 100, 80);
                },
                /**
                 * Reveal any stale previous-frame stencil values through opaque cyan pixels.
                 */
                render: () => {
                    draw(root, -10, -8, 100, 80, full);
                },
            },
        }, [
            [16, 15, cyan, 'attachment clears reference pixels left by the prior frame'],
            [76, 65, cyan, 'producer frame and consumer global depth reset together'],
        ]);
        call(border, 'setVisible', true);
        await frame('max-draw-height-does-not-clip-stencil-border', {
            [border]: {
                /**
                 * Establish a 17-pixel mask despite the shorter 15-pixel input boundary.
                 */
                prerender: () => {
                    call(border, 'setStencilRect', 0, 0, 17, 17);
                },
                /**
                 * Draw the complete native border without applying the input-only height clip.
                 */
                render: () => {
                    draw(border, 0, 0, 20, 20, [1, 1, 1, 1]);
                    call(border, 'clearStencilRect');
                },
            },
        }, [
            [1, 16, white, '17-pixel stencil border remains visible past the 15-pixel input height'],
            [16, 16, white, 'native stencil retains its entire bottom row'],
            [17, 16, black, 'native stencil excludes its right boundary'],
        ]);

        if (call(border, 'isPointOver', 1, 16) !== false) {
            throw new Error('Max draw height must reject input at the still-visible stencil border');
        }

        assertions++;
        call(border, 'setVisible', false);
        await frame('attachment-resize-and-logical-scale', {
            [root]: {
                /**
                 * Establish a small logical mask on the resized physical framebuffer.
                 */
                prerender: () => {
                    call(root, 'setStencilRect', 0, 0, 3, 2);
                },
                /**
                 * Paint across the scaled mask so its physical boundaries can be sampled.
                 */
                render: () => {
                    draw(root, 0, 0, 9, 5, [1, 1, 1, 1]);
                },
            },
        }, [
            [19, 16, black, 'mask coordinates remain logical after framebuffer resize'],
            [20, 16, white, 'scaled mask begins at the correct physical pixel'],
            [25, 19, white, 'resized attachment covers the physical mask interior'],
            [26, 19, black, 'scaled mask excludes its right boundary'],
        ], 200, 160, 2);

        await device.queue.onSubmittedWorkDone();
    } catch (error) {
        failure = { error };
    } finally {
        try {
            ui?.dispose();
        } catch (error) {
            failure ??= { error };
        }

        try {
            renderer?.destroy();
        } catch (error) {
            failure ??= { error };
        }

        try {
            const error = await device.popErrorScope();

            if (error) {
                failure ??= { error: new Error(`Native UI stencil WebGPU validation failed: ${error.message}`) };
            }
        } catch (error) {
            failure ??= { error };
        }

        try {
            device.destroy();
        } catch (error) {
            failure ??= { error };
        }
    }

    if (failure) {
        throw failure.error;
    }

    return { cases, assertions, validationError: null, adapter: { vendor: adapter.info?.vendor ?? '', architecture: adapter.info?.architecture ?? '', device: adapter.info?.device ?? '', description: adapter.info?.description ?? '', fallback } };
}

/**
 * Run the asset-free native pixel proof using an already-owned browser page.
 *
 * @param {object} context - Existing browser runner context.
 * @param {object} context.page - Puppeteer-compatible page on the application origin.
 * @returns {Promise<object>} Synthetic stencil evidence.
 */
export function checkNativeUIStencilPixels({ page }) {
    return page.evaluate(checkUIStencilPixelsInPage);
}

/**
 * Exercise the real app/manager/VM/save path with independently authored Lua.
 * Run on an owned disposable browser profile/origin with provisioned content and a known sourceBuild.
 * No original source, assets or pixels leave the page; only synthetic namespace metadata is returned.
 *
 * @param {object} context - Browser runner context.
 * @param {object} context.page - Puppeteer page on the provisioned application.
 * @param {function(boolean,string):void} context.assert - Assertion callback.
 * @returns {Promise<object>} Consumer-visible metadata evidence.
 */
export async function checkNativePackageReload({ page, assert }) {
    const stencilPixels = await checkNativeUIStencilPixels({ page });
    const originalUrl = page.url();
    const manifestUrl = new URL('content/manifest.json', originalUrl).href;
    const manifest = await page.evaluate(async (url) => (await fetch(url)).json(), manifestUrl);

    if (!/^\d+(?:\.\d+)*$/u.test(manifest.sourceBuild.version)) {
        throw new Error('Proof requires the observed sourceBuild already provisioned; it never invents a game version.');
    }

    const root = 'mods/NativeLoaderProof';
    const files = {
        [`${root}/mod.info`]: 'id=NativeLoaderProof\nname=Owned Native Loader Proof\nmodversion=proof-a\n',
        [`${root}/media/lua/client/Proof.lua`]: `
            local player = getPlayer()
            local data = player:getModData()
            local ready=false
            assert(require("NativeProofEngine"))
            data.NativeLoaderProof = data.NativeLoaderProof or {ticks=0, creates=0, loads=0, starts=0}
            Events.OnTick.Add(function() assert(ready, "committed closure initialization was lost"); data.NativeLoaderProof.ticks=data.NativeLoaderProof.ticks+1; player:walk(1,0) end)
            Events.OnCreatePlayer.Add(function() data.NativeLoaderProof.creates=data.NativeLoaderProof.creates+1 end)
            Events.OnLoad.Add(function() assert(not data.NativeLoaderProof.failLoad, "owned load failure"); data.NativeLoaderProof.loads=data.NativeLoaderProof.loads+1 end)
            Events.OnGameStart.Add(function() ready=true; data.NativeLoaderProof.starts=data.NativeLoaderProof.starts+1 end)
            Events.OnKeyPressed.Add(function(key)
                if key==119 then data.NativeLoaderProof.failLoad=true end
                if key==120 then data.NativeLoaderProof.failLoad=false end
            end)
        `,
        'media/lua/shared/NativeProofEngine.lua': 'return true',
    };

    manifest.mods.push({ root, kind: 'native-lua', files: Object.keys(files).filter((path) => path.startsWith(`${root}/`)) });
    manifest.files.push(...Object.entries(files).map(([path, source]) => ({ path, size: new TextEncoder().encode(source).length, lastModified: 0 })));
    const id = 'native-nativeloaderproof';
    const responses = new Map(Object.entries(files).map(([path, source]) => [new URL(path, new URL('./', manifestUrl)).href, new TextEncoder().encode(source)]));
    const engineUrl = new URL('media/lua/shared/NativeProofEngine.lua', new URL('./', manifestUrl)).href;
    let postponeEngine = false;
    let engineGate;
    let engineWaiter;
    let releaseEngine;

    /**
     * Serve only independently authored extra package bytes over the real range protocol.
     *
     * @param {object} request - Intercepted browser request.
     * @returns {Promise<void>} Completed request handling.
     */
    async function intercept(request) {
        if (request.url() === manifestUrl) {
            await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(manifest) });

            return;
        }

        const source = responses.get(request.url());

        if (source) {
            const match = /^bytes=(\d+)-(\d+)$/u.exec(request.headers().range ?? '');

            if (!match) {
                await request.respond({ status: 416 });

                return;
            }

            if (postponeEngine && request.url() === engineUrl) {
                engineWaiter();
                await engineGate;
            }

            const start = Number(match[1]);
            const end = Number(match[2]);

            await request.respond({ status: 206, headers: { 'content-range': `bytes ${start}-${end}/${source.length}` }, body: Buffer.from(source.slice(start, end + 1)) });

            return;
        }

        await request.continue();
    }

    /**
     * Wait for a ready game or an honestly blocked save/version mismatch.
     *
     * @returns {Promise<object>} Current metadata.
     */
    async function settled() {
        await page.waitForFunction(() => {
            const value = JSON.parse(document.querySelector('#diagnostics').textContent || '{}');

            return value.sessionReady || value.startup === 'blocked';
        }, { timeout: 120_000, polling: 100 });

        return page.$eval('#diagnostics', (element) => JSON.parse(element.textContent));
    }

    /**
     * Read the committed synthetic namespace, never original world bytes.
     *
     * @returns {Promise<object>} Save metadata.
     */
    function saved() {
        return page.evaluate(async (modId) => {
            const db = await new Promise((resolve, reject) => {
                const request = indexedDB.open('pz-web-saves', 1);

                request.addEventListener('success', () => resolve(request.result));
                request.addEventListener('error', () => reject(request.error));
            });

            try {
                return await new Promise((resolve, reject) => {
                    const request = db.transaction('saves').objectStore('saves').get('autosave');

                    request.addEventListener('success', () => {
                        const record = request.result?.current;

                        resolve(record ? { revision: record.revision, mods: record.mods, namespace: record.modState[modId]?.data.nativePlayerData.NativeLoaderProof } : null);
                    });
                    request.addEventListener('error', () => reject(request.error));
                });
            } finally {
                db.close();
            }
        }, id);
    }

    /**
     * Open only the existing hidden keyboard-accessible menu.
     *
     * @returns {Promise<void>} Menu readiness.
     */
    async function menu() {
        if (!await page.$eval('#pause-menu', (element) => element.open)) {
            await page.keyboard.press('Escape');
        }

        await page.waitForFunction(() => document.querySelector('#pause-menu').open, { polling: 100 });
    }

    /**
     * Change persisted consent through the actual existing checkbox.
     *
     * @param {boolean} value - Desired enabled flag.
     * @returns {Promise<void>} Persisted configuration.
     */
    async function enable(value) {
        await menu();
        await page.evaluate((desired) => {
            const item = [...document.querySelectorAll('#package-list li')].find((element) => element.textContent.includes('Owned Native Loader Proof'));
            const input = item?.querySelector('input');

            if (!input) {
                throw new Error('Native package enable checkbox was not discovered');
            }

            input.checked = desired;
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }, value);
        await page.waitForFunction((desired) => {
            const evidence = JSON.parse(document.querySelector('#diagnostics').textContent);

            return evidence.packages.packages.find((entry) => entry.id === 'native-nativeloaderproof')?.enabled === desired;
        }, { polling: 100 }, value);
    }

    /**
     * Capture live Lua data through the actual app Save action.
     *
     * @returns {Promise<object>} Committed namespace metadata.
     */
    async function commit() {
        await menu();
        const previous = (await saved())?.revision ?? 0;

        await page.click('#save-now');
        await page.waitForFunction((revision) => JSON.parse(document.querySelector('#diagnostics').textContent).savedRevision > revision, { polling: 100 }, previous);

        return saved();
    }

    await page.setRequestInterception(true);
    page.on('request', intercept);
    try {
        await page.reload({ waitUntil: 'domcontentloaded' });
        const discovered = await settled();

        assert(discovered.sessionReady && !discovered.failed, 'Default directory startup must remain playable');
        assert(discovered.packages.packages.find((entry) => entry.id === id)?.enabled === false, 'New native code must be discovered disabled on a disposable profile');
        assert(!discovered.mods.mods.some((entry) => entry.id === id), 'Discovery must not execute Lua');
        await enable(true);
        await page.reload({ waitUntil: 'domcontentloaded' });
        const activated = await settled();

        assert(activated.sessionReady && activated.mods.mods.some((entry) => entry.id === id), 'Enabling must activate unchanged Lua through the real host');
        await page.waitForFunction(() => JSON.parse(document.querySelector('#diagnostics').textContent).engine.action === 2, { polling: 100 });
        const before = await commit();

        assert(before.namespace.ticks > 0 && before.namespace.creates === 1 && before.namespace.starts === 1 && before.namespace.loads === 0, 'Native event must change real WASM action and live Lua tables must be committed');
        await page.reload({ waitUntil: 'domcontentloaded' });
        const restored = await settled();

        assert(restored.sessionReady, 'Exact native version save must reload');
        const after = await commit();

        assert(after.namespace.ticks >= before.namespace.ticks && after.namespace.creates === 2 && after.namespace.starts === 2 && after.namespace.loads === 1, 'Save reload must restore tables and bootstrap each real transition exactly once');

        // A delayed real engine-source fetch leaves consent controls locked throughout staging.
        await page.keyboard.press('Escape');
        await page.keyboard.press('F8');
        const failingSave = await commit();

        assert(failingSave.namespace.failLoad === true, 'Focused real key event must mark the owned load-failure fixture');
        postponeEngine = true;
        const engineArrived = new Promise((resolve) => {
            engineWaiter = resolve;
        });

        engineGate = new Promise((resolve) => {
            releaseEngine = resolve;
        });
        await page.click('#load-save');
        await engineArrived;
        const locked = await page.evaluate(() => {
            const controls = document.querySelector('#package-controls');
            const item = [...document.querySelectorAll('#package-list li')].find((element) => element.textContent.includes('Owned Native Loader Proof'));
            const input = item.querySelector('input');

            input.checked = false;
            input.dispatchEvent(new Event('change', { bubbles: true }));

            return controls.disabled;
        });

        assert(locked, 'Consent controls must be disabled while native activation is awaiting source data');
        releaseEngine();
        postponeEngine = false;
        await page.waitForFunction(() => !document.querySelector('#session-controls').disabled && document.querySelector('#save-status').textContent.includes('owned load failure'), { polling: 100 });
        const rollback = await page.$eval('#diagnostics', (element) => JSON.parse(element.textContent));

        assert(rollback.sessionReady && rollback.packages.packages.find((entry) => entry.id === 'native-nativeloaderproof').enabled === true, 'Rejected load must retain the old session and reject racing consent changes');
        assert((await saved()).revision === failingSave.revision, 'Failed target activation must not replace the committed save');
        await page.keyboard.press('Escape');
        await page.keyboard.press('F9');
        await page.waitForFunction(() => JSON.parse(document.querySelector('#diagnostics').textContent).engine.action === 2, { polling: 100 });
        const afterRollback = await commit();

        assert(afterRollback.namespace.starts === 2 && afterRollback.namespace.creates === 2 && afterRollback.namespace.loads === 1 && afterRollback.namespace.ticks > failingSave.namespace.ticks, 'Old initialized Lua closure and one set of callbacks must survive target failure without bootstrap replay');

        const safe = new URL(originalUrl);

        safe.searchParams.set('safe-mods', '1');
        await page.goto(safe.href, { waitUntil: 'domcontentloaded' });
        const safeState = await settled();

        assert(!safeState.lua && safeState.mods.mods.length === 0, 'Safe mode must execute no native or JavaScript package');
        assert((await saved()).revision === afterRollback.revision, 'Blocked safe-mode restore must retain the saved native namespace');
        await page.goto(originalUrl, { waitUntil: 'domcontentloaded' });
        await settled();
        await enable(false);
        await page.reload({ waitUntil: 'domcontentloaded' });
        const disabled = await settled();

        assert(disabled.startup === 'blocked' && !disabled.lua && disabled.mods.mods.length === 0, 'Disabled native callbacks must not survive; the exact saved-mod mismatch must not be bypassed');
        assert((await saved()).revision === afterRollback.revision, 'Disabled-package restore must not overwrite the retained save');

        return { id, nativeVersion: 'proof-a', stencilPixels, before, after, afterRollback, safeModeSkipped: true, disabledCleanup: true, retainedClosureRollback: true, racingConsentRejected: true };
    } finally {
        releaseEngine?.();
        page.off('request', intercept);
        await page.setRequestInterception(false);
    }
}
