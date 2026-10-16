import {createHash} from 'node:crypto';
import {readFile, realpath, stat} from 'node:fs/promises';
import {dirname, isAbsolute, relative, resolve, sep} from 'node:path';

// Only this authored selection is exposed, never the installation or saves as a directory server.
const selection = ['lua/shared/ISBaseObject.lua', 'lua/shared/Util/LuaTableUtil.lua'];

export async function loadAssets(mediaRoot, profile = false) {
    if (![false, true, 'sandbox', 'menu-image', 'default-shader', 'sprite-renderer'].includes(profile)) throw new Error('Unknown asset selection');
    const root = await realpath(mediaRoot);
    const manifest = [];
    const files = new Map();
    const selected = (profile === 'default-shader' || profile === 'sprite-renderer')
        ? ['default.vert', 'default.frag'].map(name => ({name: 'shaders/' + name, root, virtual: '/media/shaders/' + name}))
        : profile === 'menu-image'
        ? [{name: 'ui/avatarBackgroundWhite.png', root, virtual: '/media/ui/avatarBackgroundWhite.png'}]
        : profile ? [{name: 'stdlib.lua', root: dirname(root), virtual: '/stdlib.lua'}]
        : selection.map(name => ({name, root, virtual: '/media/' + name}));
    if (profile === 'sprite-renderer') selected.push({name: 'ui/avatarBackgroundWhite.png', root, virtual: '/media/ui/avatarBackgroundWhite.png'});
    if (profile === 'sandbox') {
        for (const name of ['lua/shared/defines.lua', 'lua/shared/Sandbox/Apocalypse.lua'])
            selected.push({name, root, virtual: '/media/' + name});
    }
    for (const asset of selected) {
        const path = await realpath(resolve(asset.root, asset.name));
        const local = relative(asset.root, path);
        if (!local || isAbsolute(local) || local === '..' || local.startsWith('..' + sep)) {
            throw new Error('Selected asset escapes the configured media root');
        }
        const info = await stat(path);
        if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Selected asset is not a bounded regular file');
        const bytes = await readFile(path);
        if (bytes.length !== info.size) throw new Error('Selected asset changed while reading');
        const virtual = asset.virtual;
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        manifest.push({path: virtual, size: bytes.length, mtime: Math.trunc(info.mtimeMs), sha256});
        files.set(virtual, bytes);
    }
    return {manifest, files};
}

