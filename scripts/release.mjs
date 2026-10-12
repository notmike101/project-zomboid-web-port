import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, mkdir, cp, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const allowed = new Set(['.html', '.js', '.css', '.json', '.wasm']);
const files = [];

/**
 * Collect only application files; fail closed on unexpected content.
 *
 * @param {string} directory - Directory to audit.
 * @returns {Promise<void>} Completes after auditing the tree.
 */
async function inspect(directory) {
    /**
     * Validate and hash one entry in this directory.
     *
     * @param {import('node:fs').Dirent} entry - Filesystem entry to inspect.
     * @returns {Promise<void>} Completes after recording a file or traversing a directory.
     */
    async function inspectEntry(entry) {
        const path = join(directory, entry.name);

        if (entry.isSymbolicLink()) {
            throw new Error(`Release rejects symbolic link: ${path}`);
        }

        if (entry.isDirectory()) {
            await inspect(path);
        } else {
            if (!entry.isFile() || !allowed.has(extname(path))) {
                throw new Error(`Release rejects unknown content: ${path}`);
            }

            const bytes = await readFile(path);

            files.push({
                path: path.replaceAll('\\', '/').replace(/^dist\//u, ''), bytes: bytes.length,
                sha256: createHash('sha256').update(bytes).digest('hex'),
            });
        }
    }

    await Promise.all((await readdir(directory, { withFileTypes: true })).map(inspectEntry));
}

/**
 * Sort manifest entries independent of filesystem traversal completion order.
 *
 * @param {{path: string}} left - First file metadata entry.
 * @param {{path: string}} right - Second file metadata entry.
 * @returns {number} Lexicographic ordering of relative paths.
 */
function orderFiles(left, right) {
    return left.path < right.path ? -1 : Number(left.path > right.path);
}

await inspect('dist');
files.sort(orderFiles);
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });

if (revision.status !== 0) {
    throw new Error('Commit verified source before creating an identified release.');
}

const worktree = spawnSync('git', ['status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8' });

if (worktree.status !== 0 || worktree.stdout.trim() !== '') {
    throw new Error('Release requires a clean committed source checkout.');
}

const directory = `release/0.1.0-preview.1-${revision.stdout.trim().slice(0, 12)}`;

await mkdir('release', { recursive: true });
await mkdir(directory);
await cp('dist', directory, { recursive: true });
await writeFile(join(directory, 'release-manifest.json'), JSON.stringify({
    version: '0.1.0-preview.1', revision: revision.stdout.trim(), assetFree: true, files,
}, null, 2));
console.info(`Prepared ${files.length} audited application files at ${directory}`);
