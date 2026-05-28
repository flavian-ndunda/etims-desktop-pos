/**
 * QueueWorker
 *
 * Manages the Laravel queue worker process that processes KRA invoice submissions.
 *
 * This is the offline-sync engine of the desktop app.
 *
 * How it works:
 *   1. Runs `php artisan queue:work` as a background child process
 *   2. The worker processes jobs from the SQLite `jobs` table
 *   3. When offline: worker is PAUSED (process suspended or stopped)
 *   4. When online: worker RESUMES and processes all queued jobs
 *   5. Each job = one invoice submitted to KRA via the eTIMS SDK
 *
 * The queue driver is `database` (SQLite). This means:
 *   - Jobs survive power cuts and crashes (they're in the DB)
 *   - No Redis required — runs entirely on the local machine
 *   - Jobs are FIFO within priority, with exponential backoff on failure
 *
 * Architecture Decision: We use `queue:work` (not `queue:listen`) in production
 * mode for better performance. The worker runs with `--stop-when-empty` in
 * manual sync mode, or continuously in auto mode.
 */

const { spawn } = require('child_process');
const path      = require('path');
const log       = require('electron-log');

class QueueWorker {
    constructor({ phpBin, laravelPath, onJobProcessed, onJobFailed }) {
        this.phpBin          = phpBin;
        this.laravelPath     = laravelPath;
        this.onJobProcessed  = onJobProcessed || (() => {});
        this.onJobFailed     = onJobFailed    || (() => {});
        this.process         = null;
        this.paused          = false;
        this.stopping        = false;
    }

    /**
     * Start the queue worker.
     *
     * @param {Object} options
     * @param {boolean} options.paused - Start in paused state (offline mode)
     */
    async start({ paused = false } = {}) {
        this.paused = paused;

        if (!paused) {
            await this.spawn();
        }

        log.info(`Queue worker started (paused=${paused})`);
    }

    /**
     * Resume the queue worker after being offline.
     * Spawns the worker process if not already running.
     */
    async resume() {
        if (!this.paused && this.process) return;

        this.paused = false;
        await this.spawn();
        log.info('Queue worker resumed — processing pending invoices');
    }

    /**
     * Pause the queue worker (internet lost).
     * Stops the process — jobs remain safely in SQLite.
     */
    pause() {
        this.paused = true;
        if (this.process) {
            this.process.kill('SIGTERM');
            this.process = null;
        }
        log.info('Queue worker paused (offline)');
    }

    /**
     * Stop the queue worker permanently (app shutdown).
     */
    async stop() {
        this.stopping = true;
        this.pause();
        log.info('Queue worker stopped');
    }

    // =========================================================================
    // Private
    // =========================================================================

    async spawn() {
        if (this.process) return; // Already running

        const args = [
            'artisan', 'queue:work',
            '--queue=etims,default',
            '--tries=5',
            '--backoff=10,30,60,120,300',
            '--timeout=60',
            '--sleep=3',
            '--memory=128',
            '--max-jobs=100', // Restart worker every 100 jobs to prevent memory leaks
        ];

        log.info(`Starting queue worker: ${this.phpBin} ${args.join(' ')}`);

        this.process = spawn(this.phpBin, args, {
            cwd: this.laravelPath,
            env: {
                ...process.env,
                APP_ENV:          'production',
                DB_CONNECTION:    'sqlite',
                QUEUE_CONNECTION: 'database',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        this.process.stdout.on('data', (data) => {
            const lines = data.toString().trim().split('\n');
            lines.forEach(line => {
                if (!line.trim()) return;
                log.info(`[Queue] ${line}`);

                // Parse job events from the worker output
                if (line.includes('Processed')) {
                    const jobName = this.extractJobName(line);
                    this.onJobProcessed({ job: jobName, line });
                } else if (line.includes('Failed')) {
                    const jobName = this.extractJobName(line);
                    this.onJobFailed({ job: jobName, line });
                }
            });
        });

        this.process.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) log.warn(`[Queue Error] ${msg}`);
        });

        this.process.on('exit', (code, signal) => {
            this.process = null;

            if (!this.stopping && !this.paused) {
                log.warn(`Queue worker exited (code=${code}). Restarting in 5s...`);
                setTimeout(() => {
                    if (!this.stopping && !this.paused) {
                        this.spawn();
                    }
                }, 5000);
            }
        });

        this.process.on('error', (err) => {
            log.error('Queue worker error:', err.message);
            this.process = null;
        });
    }

    extractJobName(line) {
        // Extract job class name from Laravel queue output
        // Format: "Processed: Flavytech\Etims\Jobs\SubmitInvoiceJob"
        const match = line.match(/(?:Processed|Failed):\s+(.+)/);
        return match ? match[1].trim() : 'Unknown';
    }
}

module.exports = QueueWorker;
