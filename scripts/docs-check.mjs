import { readdir, readFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

const failures = [];

/**
 * Collect maintained Markdown documents.
 *
 * @param {string} directory - Documentation directory.
 * @returns {Promise<string[]>} Markdown file paths.
 */
async function markdown(directory) {
    /**
     * Select documents or descend into a child directory.
     *
     * @param {import('node:fs').Dirent} entry - Child filesystem entry.
     * @returns {Promise<string[]>|string[]} Markdown paths beneath this entry.
     */
    function collectEntry(entry) {
        const path = resolve(directory, entry.name);

        if (entry.isDirectory()) {
            return markdown(path);
        }

        return entry.name.endsWith('.md') ? [path] : [];
    }

    const entries = await readdir(directory, { withFileTypes: true });

    return (await Promise.all(entries.map(collectEntry))).flat();
}

/**
 * Check relative file links without contacting external URLs.
 *
 * @param {string} file - Markdown document to validate.
 * @returns {Promise<void>} Completes after recording missing targets.
 */
async function checkFile(file) {
    /**
     * Resolve one Markdown target relative to the owning document.
     *
     * @param {string[]} match - Markdown link match with captured target.
     * @returns {Promise<void>} Completes after checking a local target.
     */
    async function checkTarget(match) {
        const target = match[1];

        if (/^(?:https?:|mailto:|#)/u.test(target)) {
            return;
        }

        const path = resolve(dirname(file), target.split('#')[0]);

        try {
            await access(path);
        } catch {
            failures.push(`${file}: missing linked file ${target}`);
        }
    }

    const text = await readFile(file, 'utf8');

    await Promise.all([...text.matchAll(/\]\(([^\s)]+)\)/gu)].map(checkTarget));
}

const files = ['README.md', ...await markdown('docs')];

await Promise.all(files.map(checkFile));

if (failures.length > 0) {
    throw new Error(failures.join('\n'));
}

console.info(`Verified relative links in ${files.length} maintained documents.`);
