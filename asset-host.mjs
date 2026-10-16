import {createHash} from 'node:crypto';
import {readFile, realpath, stat} from 'node:fs/promises';
import {isAbsolute, relative, resolve, sep} from 'node:path';

// Only this authored selection is exposed, never the installation or saves as a directory server.
const selection = ['lua/shared/ISBaseObject.lua', 'lua/shared/Util/LuaTableUtil.lua'];

export async function loadAssets(mediaRoot) {
    const root = await realpath(mediaRoot);
    const manifest = [];
    const files = new Map();
    for (const name of selection) {
        const path = await realpath(resolve(root, name));
        const local = relative(root, path);
        if (!local || isAbsolute(local) || local === '..' || local.startsWith('..' + sep)) {
            throw new Error('Selected asset escapes the configured media root');
        }
        const info = await stat(path);
        if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Selected asset is not a bounded regular file');
        const bytes = await readFile(path);
        if (bytes.length !== info.size) throw new Error('Selected asset changed while reading');
        const virtual = '/media/' + name;
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        manifest.push({path: virtual, size: bytes.length, mtime: Math.trunc(info.mtimeMs), sha256});
        files.set(virtual, bytes);
    }
    return {manifest, files};
}
