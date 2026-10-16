// Only the experiment's private browser storage. Native game saves are never opened.
window.saveHost = {
    async write(hex) {
        if (!/^[0-9a-f]{72}$/.test(hex)) throw new Error('Expected a 36-byte hexadecimal snapshot');
        const bytes = Uint8Array.from(hex.match(/../g), byte => parseInt(byte, 16));
        const root = await navigator.storage.getDirectory();
        const file = await root.getFileHandle('climate-front.bin', {create: true});
        const writer = await file.createWritable();
        try {
            await writer.write(bytes);
            await writer.close();
        } catch (error) {
            await writer.abort().catch(() => {});
            throw error;
        }
    },
    async read() {
        const root = await navigator.storage.getDirectory();
        const handle = await root.getFileHandle('climate-front.bin');
        const file = await handle.getFile();
        if (file.size !== 36) throw new Error('Stored snapshot has an invalid size');
        const bytes = new Uint8Array(await file.arrayBuffer());
        return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    }
};
