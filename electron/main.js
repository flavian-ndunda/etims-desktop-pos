/**
 * Electron Main Process - eTIMS Desktop POS
 *
 * Wraps the Laravel POS web application in a desktop shell.
 * The Laravel app lives in a sibling folder configured via LARAVEL_PATH
 * environment variable or defaults to ../etims-pos relative to this file.
 */

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, shell } = require("electron");
const path   = require("path");
const log    = require("electron-log");
const Store  = require("electron-store");

const PhpServer           = require("./phpServer");
const QueueWorker         = require("./queueWorker");
const ConnectivityMonitor = require("./connectivityMonitor");

const PHP_PORT    = 8765;
const isDev       = process.env.NODE_ENV === "development";
const store       = new Store();

// Path to the Laravel app — sibling folder by default
const laravelPath = process.env.LARAVEL_PATH ||
    path.join(__dirname, "..", "..", "etims-pos");

let mainWindow, tray, phpServer, queueWorker, connectivityMon;
let isOnline    = false;
let pendingCount = 0;

log.transports.file.level    = "info";
log.transports.console.level = isDev ? "debug" : "warn";

app.whenReady().then(async () => {
    log.info("eTIMS Desktop POS starting...");
    log.info("Laravel path: " + laravelPath);

    const gotLock = app.requestSingleInstanceLock();
    if (!gotLock) { app.quit(); return; }

    try {
        await bootLaravel();
        createWindow();
        createTray();
        startConnectivityMonitor();
        setupIpcHandlers();
        log.info("eTIMS Desktop POS ready.");
    } catch (err) {
        log.error("Failed to start:", err);
        dialog.showErrorBox("Startup Failed", err.message);
        app.quit();
    }
});

app.on("second-instance", () => {
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    }
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") shutdownGracefully();
});

app.on("before-quit", () => shutdownGracefully());

// ─── Boot Laravel ─────────────────────────────────────────────────────────────

async function bootLaravel() {
    const phpBin = getPhpBinary();
    log.info("PHP binary: " + phpBin);

    phpServer = new PhpServer({
        phpBin, laravelPath, port: PHP_PORT,
        onError: (err) => { log.error("PHP server error:", err); },
        onReady: () => { log.info("PHP server ready on port " + PHP_PORT); },
    });

    await phpServer.start();

    queueWorker = new QueueWorker({
        phpBin, laravelPath,
        onJobProcessed: () => refreshPendingCount(),
        onJobFailed:    () => refreshPendingCount(),
    });

    await queueWorker.start({ paused: true }); // Start paused, resume when online
}

// ─── Window ───────────────────────────────────────────────────────────────────

function createWindow() {
    const bounds = store.get("windowBounds", { width: 1280, height: 800 });

    mainWindow = new BrowserWindow({
        ...bounds,
        minWidth: 1024, minHeight: 700,
        title: "eTIMS POS",
        backgroundColor: "#f3f4f6",
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, "preload.js"),
        },
        show: false,
    });

    mainWindow.on("resize", () => store.set("windowBounds", mainWindow.getBounds()));
    mainWindow.on("move",   () => store.set("windowBounds", mainWindow.getBounds()));

    mainWindow.loadURL("http://localhost:" + PHP_PORT + "/dashboard");

    mainWindow.once("ready-to-show", () => {
        mainWindow.show();
        if (isDev) mainWindow.webContents.openDevTools();
    });

    mainWindow.webContents.on("will-navigate", (event, url) => {
        if (!url.startsWith("http://localhost:" + PHP_PORT)) {
            event.preventDefault();
            shell.openExternal(url);
        }
    });

    mainWindow.on("closed", () => { mainWindow = null; });
}

// ─── Tray ─────────────────────────────────────────────────────────────────────

function createTray() {
    tray = new Tray(nativeImage.createEmpty());
    tray.setToolTip("eTIMS POS");
    updateTrayMenu();
    tray.on("double-click", () => {
        if (mainWindow) mainWindow.isVisible() ? mainWindow.focus() : mainWindow.show();
    });
}

function updateTrayMenu() {
    if (!tray) return;
    const status  = isOnline ? "Online" : "Offline";
    const icon    = isOnline ? "Online" : "Offline";
    const pending = pendingCount > 0 ? pendingCount + " pending" : "All synced";

    const menu = Menu.buildFromTemplate([
        { label: "eTIMS POS", enabled: false },
        { type: "separator" },
        { label: (isOnline ? "Online" : "Offline - working locally"), enabled: false },
        { label: pending, enabled: false },
        { type: "separator" },
        { label: "Open POS", click: () => { mainWindow?.show(); mainWindow?.loadURL("http://localhost:" + PHP_PORT + "/pos"); } },
        { label: "Dashboard", click: () => { mainWindow?.show(); mainWindow?.loadURL("http://localhost:" + PHP_PORT + "/dashboard"); } },
        { type: "separator" },
        { label: "Sync Now", enabled: isOnline && pendingCount > 0, click: triggerSync },
        { type: "separator" },
        { label: "Quit", click: () => app.quit() },
    ]);
    tray.setContextMenu(menu);
}

// ─── Connectivity ─────────────────────────────────────────────────────────────

function startConnectivityMonitor() {
    connectivityMon = new ConnectivityMonitor({
        checkInterval: 30000,
        checkUrl: "https://etims-api.kra.go.ke",
        onOnline: () => {
            if (!isOnline) {
                log.info("Online - resuming queue worker");
                isOnline = true;
                queueWorker?.resume();
                updateTrayMenu();
                notifyRenderer("connectivity:online");
                triggerSync();
            }
        },
        onOffline: () => {
            if (isOnline) {
                log.info("Offline - pausing queue worker");
                isOnline = false;
                queueWorker?.pause();
                updateTrayMenu();
                notifyRenderer("connectivity:offline");
            }
        },
    });
    connectivityMon.start();
}

async function triggerSync() {
    if (!isOnline) return;
    queueWorker?.resume();
    await refreshPendingCount();
    notifyRenderer("sync:started");
}

// ─── IPC ──────────────────────────────────────────────────────────────────────

function setupIpcHandlers() {
    ipcMain.handle("app:status",  () => ({ isOnline, pendingCount, phpPort: PHP_PORT }));
    ipcMain.handle("app:sync",    async () => { await triggerSync(); return { success: true }; });
    ipcMain.handle("app:version", () => app.getVersion());
    ipcMain.handle("shell:openExternal", (_, url) => shell.openExternal(url));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function refreshPendingCount() {
    try {
        const res  = await fetch("http://localhost:" + PHP_PORT + "/api/pending-count");
        const data = await res.json();
        if ((data.count ?? 0) !== pendingCount) {
            pendingCount = data.count ?? 0;
            updateTrayMenu();
            notifyRenderer("pending:updated", { count: pendingCount });
        }
    } catch {}
}

function notifyRenderer(channel, data = {}) {
    mainWindow?.webContents?.send(channel, data);
}

function getPhpBinary() {
    if (isDev) return process.platform === "win32" ? "php" : "php8.3";
    const res = process.resourcesPath;
    return process.platform === "win32"
        ? path.join(res, "php", "php.exe")
        : path.join(res, "php", "php");
}

async function shutdownGracefully() {
    connectivityMon?.stop();
    await queueWorker?.stop();
    await phpServer?.stop();
}