import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

// Only this authored selection is exposed, never the installation or saves as a directory server.
const selection = ['lua/shared/ISBaseObject.lua', 'lua/shared/Util/LuaTableUtil.lua'];

/**
 * Reads the selected installed assets into a bounded, immutable browser mount.
 *
 * @param {string} mediaRoot - Installed media directory.
 * @param {boolean|string} profile - Fixed asset selection required by the probe.
 * @returns {Promise<{manifest: object[], files: Map<string, Buffer>}>} Verified bytes and their identities.
 */
export async function loadAssets(mediaRoot, profile = false) {
    if (![false, true, 'sandbox', 'menu-image', 'default-shader', 'sprite-renderer'].includes(profile)) {
        throw new Error('Unknown asset selection');
    }

    const root = await realpath(mediaRoot);
    let selected;

    if (profile === 'default-shader' || profile === 'sprite-renderer') {
        selected = ['default.vert', 'default.frag'].map((name) => ({ name: `shaders/${name}`, root, virtual: `/media/shaders/${name}` }));
    } else if (profile === 'menu-image') {
        selected = [{ name: 'ui/avatarBackgroundWhite.png', root, virtual: '/media/ui/avatarBackgroundWhite.png' }];
    } else if (profile) {
        selected = [{ name: 'stdlib.lua', root: dirname(root), virtual: '/stdlib.lua' }];
    } else {
        selected = selection.map((name) => ({ name, root, virtual: `/media/${name}` }));
    }

    if (profile === 'sprite-renderer') {
        selected.push({ name: 'ui/avatarBackgroundWhite.png', root, virtual: '/media/ui/avatarBackgroundWhite.png' });
    }

    if (profile === 'sandbox') {
        for (const name of ['lua/shared/defines.lua', 'lua/shared/Sandbox/Apocalypse.lua']) {
            selected.push({ name, root, virtual: `/media/${name}` });
        }
    }

    const loaded = await Promise.all(selected.map(async (asset) => {
        const path = await realpath(resolve(asset.root, asset.name));
        const local = relative(asset.root, path);

        if (!local || isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`)) {
            throw new Error('Selected asset escapes the configured media root');
        }

        const info = await stat(path);

        if (!info.isFile() || info.size > 1_024 * 1_024) {
            throw new Error('Selected asset is not a bounded regular file');
        }

        const bytes = await readFile(path);

        if (bytes.length !== info.size) {
            throw new Error('Selected asset changed while reading');
        }

        const virtual = asset.virtual;
        const sha256 = createHash('sha256').update(bytes).digest('hex');

        return { metadata: { path: virtual, size: bytes.length, mtime: Math.trunc(info.mtimeMs), sha256 }, bytes };
    }));

    return {
        manifest: loaded.map((asset) => asset.metadata),
        files: new Map(loaded.map((asset) => [asset.metadata.path, asset.bytes])),
    };
}
