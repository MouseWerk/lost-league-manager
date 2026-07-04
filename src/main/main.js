const { app, globalShortcut, dialog } = require('electron');
const lcu = require('./lcu');

// ── Shared state must be required before anything that imports it ────────────
const state = require('./state');

// ── Core modules ─────────────────────────────────────────────────────────────
const { loadConfig, migratePasswords } = require('./services/storage');
const { fetchChampionData }            = require('./services/champion-data');
const { fetchItemData }                = require('./services/item-data');
const { registerLcuEvents }            = require('./lcu-events');
const { initAutoUpdater }              = require('./ipc/updater');
const { registerAll: registerIpc }     = require('./ipc/index');
const { executeAccountLaunch } = require('./ipc/launch');
const windows = require('./windows');
const { initOverwolf } = require('./overwolf');
const { registerOverlayHotkey } = require('./overlay-hotkey');
const discordRpc = require('./services/discord-rpc');

// ── Single-instance lock ──────────────────────────────────────────────────────
app.isQuiting = false;
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', (event, commandLine) => {
        if (state.mainWindow) {
            state.mainWindow.show();
            if (state.mainWindow.isMinimized()) state.mainWindow.restore();
            state.mainWindow.focus();
        }
        const arg = commandLine.find(a => a.startsWith('--launch='));
        if (arg) executeAccountLaunch(arg.split('=')[1]);
    });
}

// ── App ready ─────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
    // These touch disk (config/accounts.json) or the network (Data Dragon) and
    // can throw — previously an unhandled rejection here (e.g. accounts.json
    // locked by AV/OneDrive, or a full disk) would silently kill the entire
    // boot sequence with no window, no tray, and no visible error.
    try {
        loadConfig();
        migratePasswords();
    } catch (e) {
        console.error('[Boot] Failed to load/migrate account data:', e.message);
        dialog.showErrorBox('Lost League Manager',
            `Failed to read your saved accounts/settings:\n${e.message}\n\n` +
            'The app will still start, but your data may not load or save correctly ' +
            'until this is resolved (check that accounts.json/config.json aren\'t locked ' +
            'by another program).');
    }
    try {
        await fetchChampionData();
    } catch (e) {
        console.error('[Boot] fetchChampionData failed:', e.message);
    }
    fetchItemData(); // non-blocking: item list populates shortly after startup

    try {
        windows.createMainWindow();
        windows.createTray();
        windows.setLaunchCallback(executeAccountLaunch);
        windows.updateJumpList();

        registerIpc();
        registerLcuEvents();
        initAutoUpdater();
        initOverwolf();
        registerOverlayHotkey(state.config.overlayHotkey);
        discordRpc.init();
    } catch (e) {
        console.error('[Boot] Failed to initialize application window:', e.message);
        dialog.showErrorBox('Lost League Manager', `Failed to start:\n${e.message}`);
        app.quit();
        return;
    }

    // Handle --launch= argument on first run
    const launchArg = process.argv.find(a => a.startsWith('--launch='));
    if (launchArg) executeAccountLaunch(launchArg.split('=')[1]);

    // Poll for LCU connection
    setInterval(() => lcu.connect(state.config.lolPath), 5000);

    app.on('activate', () => {
        if (!state.mainWindow) windows.createMainWindow();
    });
});

app.on('window-all-closed', () => {
    lcu.stop();
    globalShortcut.unregisterAll();
    if (app.isQuiting && process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
    discordRpc.shutdown();
});
