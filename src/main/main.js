const { app, globalShortcut } = require('electron');
const lcu = require('./lcu');

// ── Shared state must be required before anything that imports it ────────────
const state = require('./state');

// ── Core modules ─────────────────────────────────────────────────────────────
const { loadConfig, migratePasswords } = require('./services/storage');
const { fetchChampionData }            = require('./services/champion-data');
const { registerLcuEvents }            = require('./lcu-events');
const { initAutoUpdater }              = require('./ipc/updater');
const { registerAll: registerIpc }     = require('./ipc/index');
const { executeAccountLaunch, checkGameFlowAndQueue } = require('./ipc/launch');
const windows = require('./windows');
const { initOverwolf } = require('./overwolf');
const { registerOverlayHotkey } = require('./overlay-hotkey');

// ── Single-instance lock ──────────────────────────────────────────────────────
app.isQuiting = false;
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', (event, commandLine) => {
        if (state.mainWindow) {
            if (state.mainWindow.isMinimized()) state.mainWindow.restore();
            state.mainWindow.focus();
        }
        const arg = commandLine.find(a => a.startsWith('--launch='));
        if (arg) executeAccountLaunch(arg.split('=')[1]);
    });
}

// ── App ready ─────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
    loadConfig();
    migratePasswords();
    await fetchChampionData();

    windows.createMainWindow();
    windows.createTray();
    windows.setLaunchCallback(executeAccountLaunch);
    windows.updateJumpList();

    registerIpc();
    registerLcuEvents();
    initAutoUpdater();
    initOverwolf();
    registerOverlayHotkey(state.config.overlayHotkey);

    // Handle --launch= argument on first run
    const launchArg = process.argv.find(a => a.startsWith('--launch='));
    if (launchArg) executeAccountLaunch(launchArg.split('=')[1]);

    // Poll for LCU connection and auto-queue
    setInterval(() => lcu.connect(state.config.lolPath), 5000);
    setInterval(checkGameFlowAndQueue, 3000);

    app.on('activate', () => {
        if (!state.mainWindow) windows.createMainWindow();
    });
});

app.on('window-all-closed', () => {
    lcu.stop();
    globalShortcut.unregisterAll();
    if (app.isQuiting && process.platform !== 'darwin') app.quit();
});
