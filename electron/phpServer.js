/**
 * PhpServer
 *
 * Manages the embedded PHP development server that serves the Laravel app.
 * Works with Laravel 11+ on Windows, Linux and macOS.
 */

const { spawn } = require('child_process');
const path      = require('path');
const http      = require('http');
const fs        = require('fs');
const log       = require('electron-log');

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

    async start() {
        await this.spawn();
        await this.waitUntilReady();
        this.onReady();
    }

    async stop() {
        this.stopping = true;
        if (this.process) {
            this.process.kill('SIGTERM');
            this.process = null;
            log.info('PHP server stopped');
        }
    }

    async spawn() {
        const publicPath = path.join(this.laravelPath, 'public');

        // Laravel 10 uses server.php in root, Laravel 11+ uses the framework router
        const oldRouter = path.join(this.laravelPath, 'server.php');
        const newRouter = path.join(
            this.laravelPath,
            'vendor', 'laravel', 'framework',
            'src', 'Illuminate', 'Foundation', 'resources', 'server.php'
        );

        const routerPath = fs.existsSync(oldRouter) ? oldRouter : newRouter;

        log.info(`Laravel path: ${this.laravelPath}`);
        log.info(`Public path:  ${publicPath}`);
        log.info(`Router:       ${routerPath}`);
        log.info(`PHP binary:   ${this.phpBin}`);

        // Verify public path exists
        if (!fs.existsSync(publicPath)) {
            const err = new Error(`Laravel public directory not found: ${publicPath}`);
            log.error(err.message);
            this.onError(err);
            return;
        }

        // Verify router exists
        if (!fs.existsSync(routerPath)) {
            const err = new Error(`PHP router not found: ${routerPath}. Run composer install in your Laravel app.`);
            log.error(err.message);
            this.onError(err);
            return;
        }

        const args = [
            '-S', `127.0.0.1:${this.port}`,
            '-t', publicPath,
            routerPath,
        ];

        log.info(`Spawning: php ${args.join(' ')}`);

        this.process = spawn(this.phpBin, args, {
            // cwd MUST be the public directory for Laravel's router to find index.php
            cwd: publicPath,
            env: {
                ...process.env,
                APP_ENV:           'local',
                APP_DEBUG:         'true',
                LARAVEL_ROOT:      this.laravelPath,
                DOCUMENT_ROOT:     publicPath,
                PHP_CLI_SERVER_WORKERS: '1',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        this.process.stdout.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) log.debug(`[PHP stdout] ${msg}`);
        });

        this.process.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) log.info(`[PHP stderr] ${msg}`);
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
        const delay = Math.min(1000 * this.restarts, 10000);
        log.info(`Restarting PHP server in ${delay}ms (attempt ${this.restarts}/${this.maxRestarts})`);
        await sleep(delay);
        await this.spawn();
    }

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
                    log.info(`PHP server ready (took ${Date.now() - start}ms)`);
                    resolve();
                } catch {
                    // Still starting — keep polling every 500ms
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
