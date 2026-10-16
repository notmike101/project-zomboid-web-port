// Only the experiment's private browser storage. Native game saves are never opened.
globalThis.saveHost = {
    /**
     * Commits a validated original snapshot to the private browser file.
     *
     * @param {string} hex - The validated 36-byte snapshot encoded as hexadecimal.
     */
    async write(hex) {
        if (!/^[\da-f]{72}$/.test(hex)) {
            throw new Error('Expected a 36-byte hexadecimal snapshot');
        }

        const bytes = Uint8Array.from(hex.match(/../g), (byte) => Number.parseInt(byte, 16));
        const root = await navigator.storage.getDirectory();
        const file = await root.getFileHandle('climate-front.bin', { create: true });
        const writer = await file.createWritable();

        try {
            await writer.write(bytes);
            await writer.close();
        } catch (error) {
            await writer.abort().catch(() => {
                // Preserve the original write error if aborting also fails.
            });
            throw error;
        }
    },
    /**
     * Reads and validates the original snapshot from the private browser file.
     *
     * @returns {Promise<string>} The validated snapshot encoded as hexadecimal.
     */
    async read() {
        const root = await navigator.storage.getDirectory();
        const handle = await root.getFileHandle('climate-front.bin');
        const file = await handle.getFile();

        if (file.size !== 36) {
            throw new Error('Stored snapshot has an invalid size');
        }

        const bytes = new Uint8Array(await file.arrayBuffer());

        return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    },
};
