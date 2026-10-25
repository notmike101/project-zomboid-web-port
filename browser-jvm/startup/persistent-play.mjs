import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Fixed origin is part of the owned browser storage identity. */
export const playPort = 38_479;

/**
 * Opens only this port's dedicated persistent Chromium profile and root identity.
 *
 * @param {string} executable - Supplied Chromium executable.
 * @returns {Promise<object>} Real child-process owner, endpoint and stable Java home.
 */
export async function launchPersistentPlay(executable) {
    const directory = path.resolve(import.meta.dirname, '../../.local/persistent-play');
    const profile = path.join(directory, 'playwright_chromiumdev_profile-pz-port');

    await mkdir(profile, { recursive: true });
    assert.equal(await realpath(directory), directory, 'Persistent owner must not use directory aliases');
    assert.equal(await realpath(profile), profile, 'Persistent profile must not use directory aliases');
    const identityFile = path.join(directory, 'identity.json');
    let identity;

    try {
        identity = JSON.parse(await readFile(identityFile, 'utf8'));
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }

        identity = { schema: 'pz-port-persistent-home-v1', uuid: randomUUID() };
        await writeFile(identityFile, JSON.stringify(identity), { flag: 'wx' });
    }

    assert.equal(identity.schema, 'pz-port-persistent-home-v1');
    assert.match(identity.uuid, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
    const child = spawn(executable, [`--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', 'about:blank'],
    { windowsHide: false, stdio: ['ignore', 'ignore', 'pipe'] });
    let browser;
    let ownerIdentity;
    let stderr = '';
    const endpoint = new Promise((resolve, reject) => {
        child.on('error', reject);
        child.once('exit', () => reject(new Error(`Owned persistent browser exited before connection: ${stderr}`)));
        child.stderr.on('data', (bytes) => {
            stderr = `${stderr}${bytes}`.slice(-8_192);
            const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/u.exec(stderr);

            if (match) {
                resolve(match[1]);
            }
        });
    });

    // The runner always awaits this promise; retain startup errors before its guard is ready.
    void endpoint.catch(() => undefined);

    return {
        root: `/files/sqlite-owned/${identity.uuid}`, profile, endpoint,
        /**
         * Returns the actual spawned child, including its PID and exit state.
         *
         * @returns {object} Actual Node child process.
         */
        process: () => child,
        /**
         * Binds the public CDP connection for graceful browser shutdown.
         *
         * @param {object} value - Actual Playwright Browser connection.
         */
        attach(value) {
            browser = value;
        },
        /**
         * Retains the first verified memory-guard root identity for exact termination checks.
         *
         * @param {object} sample - Actual verified browser tree sample.
         */
        bindIdentity(sample) {
            assert.equal(sample.rootPid, child.pid);
            assert.equal(sample.profile, profile);
            ownerIdentity = {
                creation: sample.rootCreation,
                commandLine: sample.processes.find((entry) => entry.pid === child.pid)?.commandLine,
            };
            assert.equal(typeof ownerIdentity.commandLine, 'string');
        },
        /** Closes the owned browser through CDP and waits for its real child exit. */
        async close() {
            if (child.exitCode !== null || child.signalCode !== null) {
                return;
            }

            assert.ok(browser, 'Persistent browser connection required for graceful close');
            const session = await browser.newBrowserCDPSession();

            await session.send('Browser.close').catch(() => undefined);

            if (child.exitCode === null && child.signalCode === null) {
                await new Promise((resolve) => {
                    child.once('exit', resolve);
                });
            }
        },
        /** Force-closes only the verified owned profile tree after graceful cleanup fails. */
        async kill() {
            if (child.exitCode !== null || child.signalCode !== null) {
                return;
            }

            // Recheck the actual dedicated profile immediately before tree termination.
            const script = String.raw`
$ErrorActionPreference='Stop'
$idValue=[int]$env:PZ_PLAY_PID
$handle=Get-Process -Id $idValue -ErrorAction SilentlyContinue
if(!$handle){exit 0}
$null=$handle.Handle
try {
    $root=Get-CimInstance Win32_Process -Filter "ProcessId = $idValue"
    if(!$root){exit 0}
    $match=[regex]::Match($root.CommandLine, '--user-data-dir=(?:"([^"]+)"|(\S+))')
    $actualProfile=if($match.Groups[1].Success){$match.Groups[1].Value}else{$match.Groups[2].Value}
    if($root.Name -ne 'chrome.exe' -or !$match.Success -or $actualProfile -cne $env:PZ_PLAY_PROFILE){throw 'Unowned browser'}
    if($env:PZ_PLAY_CREATION -and ($root.CreationDate.ToString('o') -cne $env:PZ_PLAY_CREATION -or $root.CommandLine -cne $env:PZ_PLAY_COMMAND)){throw 'Browser identity changed'}
    & taskkill.exe /PID $idValue /T /F
    exit $LASTEXITCODE
} finally {$handle.Dispose()}`;
            const killer = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
                {
                    windowsHide: true, stdio: 'ignore', env: {
                        ...process.env, PZ_PLAY_PID: String(child.pid), PZ_PLAY_PROFILE: profile,
                        PZ_PLAY_CREATION: ownerIdentity?.creation ?? '', PZ_PLAY_COMMAND: ownerIdentity?.commandLine ?? '',
                    },
                });

            await new Promise((resolve, reject) => {
                killer.once('error', reject);
                killer.once('exit', (code) => code === 0 || child.exitCode !== null || child.signalCode !== null
                    ? resolve()
                    : reject(new Error(`Owned persistent browser termination failed: ${code}`)));
            });

            if (child.exitCode === null && child.signalCode === null) {
                await new Promise((resolve) => {
                    child.once('exit', resolve);
                });
            }
        },
    };
}
