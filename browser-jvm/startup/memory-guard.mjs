import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Samples one verified browser tree with one persistent Windows observer.
 *
 * @param {object} options - Actual browser owner and bounded callbacks.
 * @param {number} options.pid - Owned browser PID returned by Playwright.
 * @param {string} options.output - Private evidence directory.
 * @param {function(object): void} options.onPressure - Requests the original Stop path once.
 * @param {function(Error): void} options.onFailure - Terminates the run on guard failure.
 * @returns {object} Owned observer, readiness promise and bounded retained state.
 */
export function startMemoryGuard({ pid, output, onPressure, onFailure }) {
    if (process.platform !== 'win32') {
        throw new Error('The startup memory guard currently requires Windows');
    }

    const helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(import.meta.dirname, 'memory-watch.ps1'), '-RootProcessId', String(pid),
        '-MaxPrivateBytes', String(6 * 1_024 ** 3), '-MinAvailableBytes', String(4 * 1_024 ** 3)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let latest;
    let peakPrivateBytes = 0;
    let pressure;
    let disposed = false;
    let pending = '';
    let stderr = '';
    let lastSeen = Date.now();
    let terminal = false;
    let closed = false;
    let ready;
    let failed;
    const initialized = new Promise((resolve, reject) => {
        ready = resolve;
        failed = reject;
    });

    /**
     * Reports a terminal observer failure without losing the first ready rejection.
     *
     * @param {Error} error - Actual observer failure.
     */
    const fail = (error) => {
        failed(error);

        if (!disposed && !terminal) {
            terminal = true;
            onFailure(error);
        }
    };

    helper.stdout.on('data', (bytes) => {
        pending += bytes.toString();

        if (pending.length > 1_024 * 1_024) {
            fail(new Error('Memory observer record exceeded its bounded buffer'));

            return;
        }

        let newline;

        while ((newline = pending.indexOf('\n')) !== -1) {
            const line = pending.slice(0, newline).trim();

            pending = pending.slice(newline + 1);

            try {
                const value = JSON.parse(line);

                lastSeen = Date.now();
                appendFileSync(path.join(output, 'memory-samples.jsonl'), `${line}\n`);

                switch (value.event) {
                    case 'sample': {
                        latest = value;
                        peakPrivateBytes = Math.max(peakPrivateBytes, value.privateBytes);
                        ready();

                        if (value.reason && !pressure) {
                            pressure = value;
                            onPressure(value);
                        }

                        break;
                    }
                    case 'hard-close': {
                        closed = true;
                        onFailure(new Error(`Memory guard closed owned browser: ${value.reason || pressure?.reason}`));

                        break;
                    }
                    case 'closed': {
                        closed = true;

                        break;
                    }
                // No default
                }
            } catch (error) {
                fail(error);
            }
        }
    });
    helper.stderr.on('data', (bytes) => {
        stderr = `${stderr}${bytes}`.slice(-4_096);
    });
    helper.on('error', fail);
    helper.on('exit', (code) => {
        if (!disposed && (!closed || !latest)) {
            fail(new Error(`Memory observer failed (${code}): ${stderr}`));
        }
    });
    const heartbeat = setInterval(() => {
        if (Date.now() - lastSeen > 15_000) {
            fail(new Error('Memory observer stopped reporting'));
        }
    }, 5_000);

    return {
        ready: initialized,
        /**
         * Returns only the latest tree, peak and first budget violation.
         *
         * @returns {object} Bounded observer state.
         */
        snapshot() {
            return { latest, peakPrivateBytes, pressure, disposed };
        },
        /** Closes this observer after the owned browser has been stopped. */
        dispose() {
            disposed = true;
            clearInterval(heartbeat);
            helper.kill();
        },
    };
}
