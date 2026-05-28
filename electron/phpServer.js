/**
 * PhpServer
 *
 * Manages the embedded PHP development server that serves the Laravel app.
 *
 * We use PHP's built-in server (`php -S localhost:8765`) rather than
 * a full web server (nginx/apache) to keep the desktop package simple.
 * For a production-grade deployment, replace this with PHP-FPM + nginx
 * bundled in the Electron app — but for the vast majority of POS use
 * cases, the built-in server handles the load fine (one cashier terminal
 * = low concurrency = PHP's built-in server is perfectly adequate).
 *
 * The server process is monitored and automatically restarted if it
 * crashes, with a maximum of 5 restart attempts before giving up.
 */

const { spawn }  = require('child_process');
const path       = require('path');
const http       = require('http');
const log        = require('electron-log');

class PhpServer {
    constructor({ phpBin, laravelPath, port, onError, onReady }) {
        this.phpBin      = phpBin;
        this.laravelPath = laravelPath;
        this.port        = port;
        this.onError     = onError || (() => {});
        this.onReady     = onReady || (() => {});
        this.process     = null;
        this.restarts    = 0;
        this.maxRestarts = 5;
        this.stopping    = false;
    }

    /**
     * Start the PHP server and wait until it accepts connections.
     */
    async start() {
        await this.spawn();
        await this.waitUntilReady();
        this.onReady();
    }

    /**
     * Stop the PHP server.
     */
    async stop() {
        this.stopping = true;
        if (this.process) {
            this.process.kill('SIGTERM');
            this.process = null;
            log.info('PHP server stopped');
        }
    }

    // =========================================================================
    // Private
    // =========================================================================

    async spawn() {
        const publicPath = path.join(this.laravelPath, 'public');
        const routerPath = path.join(this.laravelPath, 'server.php');

        const args = [
            '-S', `127.0.0.1:${this.port}`,
            '-t', publicPath,
            routerPath,
        ];

        log.info(`Starting PHP server: ${this.phpBin} ${args.join(' ')}`);

        this.process = spawn(this.phpBin, args, {
            cwd: this.laravelPath,
            env: {
                ...process.env,
                APP_ENV:          'production',
                APP_DEBUG:        'false',
                DB_CONNECTION:    'sqlite',
                QUEUE_CONNECTION: 'database',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        this.process.stdout.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) log.debug(`[PHP] ${msg}`);
        });

        this.process.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) log.info(`[PHP] ${msg}`);
        });

        this.process.on('exit', (code, signal) => {
            if (!this.stopping) {
                log.warn(`PHP server exited (code=${code}, signal=${signal}). Restarting...`);
                this.handleCrash();
            }
        });

        this.process.on('error', (err) => {
            log.error('PHP server process error:', err.message);
            this.onError(err);
        });
    }

    async handleCrash() {
        if (this.restarts >= this.maxRestarts) {
            const err = new Error(`PHP server crashed ${this.maxRestarts} times. Giving up.`);
            log.error(err.message);
            this.onError(err);
            return;
        }

        this.restarts++;
        const delay = Math.min(1000 * this.restarts, 10000); // max 10s delay
        log.info(`Restarting PHP server in ${delay}ms (attempt ${this.restarts}/${this.maxRestarts})`);

        await sleep(delay);
        await this.spawn();
    }

    /**
     * Poll the server until it accepts HTTP connections.
     * Times out after 30 seconds.
     */
    waitUntilReady(timeout = 30000) {
        return new Promise((resolve, reject) => {
            const start    = Date.now();
            const interval = setInterval(async () => {
                if (Date.now() - start > timeout) {
                    clearInterval(interval);
                    reject(new Error('PHP server did not start within 30 seconds.'));
                    return;
                }

                try {
                    await httpGet(`http://127.0.0.1:${this.port}/ping`);
                    clearInterval(interval);
                    log.info(`PHP server is ready (took ${Date.now() - start}ms)`);
                    resolve();
                } catch {
                    // Not ready yet — keep polling
                }
            }, 500);
        });
    }
}

function httpGet(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            if (res.statusCode < 500) resolve(res.statusCode);
            else reject(new Error(`HTTP ${res.statusCode}`));
        }).on('error', reject);
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = PhpServer;
