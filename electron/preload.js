/**
 * Preload Script
 *
 * Runs in the renderer process but has access to Node.js APIs.
 * Exposes a safe, limited API to the web content via contextBridge.
 *
 * Security: contextIsolation=true means the web content (Laravel Blade views)
 * cannot access Node.js or Electron APIs directly. Everything must go through
 * this explicitly defined bridge. This prevents XSS attacks from escalating
 * to full system access.
 *
 * The web content calls window.electronAPI.xxx() to communicate with
 * the main process via ipcRenderer.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {

    /**
     * Get current app status (online state, pending count).
     * @returns {Promise<{isOnline: boolean, pendingCount: number}>}
     */
    getStatus: () => ipcRenderer.invoke('app:status'),

    /**
     * Trigger a manual sync (re-processes pending invoices).
     * @returns {Promise<{success: boolean}>}
     */
    triggerSync: () => ipcRenderer.invoke('app:sync'),

    /**
     * Get the app version string.
     * @returns {Promise<string>}
     */
    getVersion: () => ipcRenderer.invoke('app:version'),

    /**
     * Open a URL in the system browser.
     */
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

    /**
     * Listen for connectivity changes from the main process.
     * @param {Function} callback
     */
    onConnectivityChange: (callback) => {
        ipcRenderer.on('connectivity:online',  () => callback({ isOnline: true }));
        ipcRenderer.on('connectivity:offline', () => callback({ isOnline: false }));
    },

    /**
     * Listen for pending invoice count updates.
     * @param {Function} callback
     */
    onPendingUpdate: (callback) => {
        ipcRenderer.on('pending:updated', (_, data) => callback(data));
    },

    /**
     * Listen for sync events.
     * @param {Function} callback
     */
    onSyncEvent: (callback) => {
        ipcRenderer.on('sync:started', () => callback({ status: 'started' }));
    },

    /**
     * Remove all event listeners (cleanup on component unmount).
     */
    removeAllListeners: () => {
        ipcRenderer.removeAllListeners('connectivity:online');
        ipcRenderer.removeAllListeners('connectivity:offline');
        ipcRenderer.removeAllListeners('pending:updated');
        ipcRenderer.removeAllListeners('sync:started');
    },
});
