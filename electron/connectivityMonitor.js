/**
 * ConnectivityMonitor
 *
 * Monitors internet connectivity and notifies the app when
 * the connection is gained or lost.
 *
 * Why not use Electron's net.isOnline()?
 * Electron's built-in check only verifies if there's a network interface
 * with an IP address — it does NOT verify if the KRA API is reachable.
 * A device can be connected to a local network with no internet, or
 * connected to internet but KRA's API is down. We need to know specifically
 * whether KRA is reachable, not just whether there's a network interface.
 *
 * So we do an actual HTTP HEAD request to the KRA API endpoint every
 * 30 seconds. If it succeeds → online. If it fails → offline.
 *
 * This is the correct approach for a fiscal compliance system in Kenya
 * where "internet" ≠ "KRA API is up".
 */

const https  = require('https');
const http   = require('http');
const log    = require('electron-log');

class ConnectivityMonitor {
    constructor({ checkInterval, checkUrl, onOnline, onOffline }) {
        this.checkInterval = checkInterval || 30000;
        this.checkUrl      = checkUrl || 'https://etims-api.kra.go.ke';
        this.onOnline      = onOnline  || (() => {});
        this.onOffline     = onOffline || (() => {});
        this.isOnline      = false;
        this.timer         = null;
        this.checking      = false;
    }

    /**
     * Start monitoring. Does an immediate check then polls on interval.
     */
    start() {
        log.info(`Connectivity monitor started (interval=${this.checkInterval}ms, url=${this.checkUrl})`);

        // Immediate check
        this.check();

        // Periodic check
        this.timer = setInterval(() => this.check(), this.checkInterval);
    }

    /**
     * Stop monitoring.
     */
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        log.info('Connectivity monitor stopped');
    }

    /**
     * Force an immediate connectivity check.
     */
    async forceCheck() {
        await this.check();
    }

    // =========================================================================
    // Private
    // =========================================================================

    async check() {
        if (this.checking) return; // Prevent concurrent checks
        this.checking = true;

        try {
            const reachable = await this.testConnectivity();

            if (reachable && !this.isOnline) {
                this.isOnline = true;
                log.info('Connectivity: ONLINE (KRA API reachable)');
                this.onOnline();
            } else if (!reachable && this.isOnline) {
                this.isOnline = false;
                log.info('Connectivity: OFFLINE (KRA API unreachable)');
                this.onOffline();
            }
        } catch (err) {
            log.debug('Connectivity check error:', err.message);
            if (this.isOnline) {
                this.isOnline = false;
                this.onOffline();
            }
        } finally {
            this.checking = false;
        }
    }

    /**
     * Test if the KRA API endpoint is reachable.
     *
     * Uses a HEAD request with a 5-second timeout.
     * A 4xx response still means the server is reachable (good enough).
     * Only network errors / timeouts mean offline.
     */
    testConnectivity() {
        return new Promise((resolve) => {
            const url      = new URL(this.checkUrl);
            const protocol = url.protocol === 'https:' ? https : http;
            const timeout  = 5000;

            const req = protocol.request(
                {
                    hostname: url.hostname,
                    port:     url.port || (url.protocol === 'https:' ? 443 : 80),
                    path:     '/',
                    method:   'HEAD',
                    timeout,
                },
                (res) => {
                    // Any HTTP response (even 4xx) means the server is reachable
                    resolve(true);
                    req.destroy();
                }
            );

            req.on('timeout', () => {
                resolve(false);
                req.destroy();
            });

            req.on('error', () => {
                resolve(false);
            });

            req.setTimeout(timeout);
            req.end();
        });
    }
}

module.exports = ConnectivityMonitor;
