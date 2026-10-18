const { app, globalShortcut, dialog } = require('electron');
const lcu = require('./lcu');

// ── Shared state must be required before anything that imports it ────────────
const state = require('./state');

// ── Core modules ─────────────────────────────────────────────────────────────
const { loadConfig, saveConfig, migratePasswords } = require('./services/storage');
const { resolveLolPath }               = require('./services/league-path');
const { fetchChampionData }            = require('./services/champion-data');
const { fetchItemData }                = require('./services/item-data');
const { registerLcuEvents }            = require('./lcu-events');
const { initAutoUpdater }              = require('./ipc/updater');
const { registerAll: registerIpc }     = require('./ipc/index');
const { launchFromOutside } = require('./ipc/launch');
const windows = require('./windows');
const { initOverwolf } = require('./overwolf');
const discordRpc = require('./services/discord-rpc');

// Jump-list entries pass `--launch=<username>`; usernames may contain '='.
function launchArgUsername(argv) {
    const arg = argv.find(a => a.startsWith('--launch='));
    return arg ? arg.slice('--launch='.length) : null;
}

// ── Single-instance lock ──────────────────────────────────────────────────────
app.isQuiting = false;
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', (event, commandLine) => {
        const username = launchArgUsername(commandLine);
        // launchFromOutside shows the window itself (lock screen while the
        // vault is locked) unless the account minimizes on launch.
        if (username) {
            launchFromOutside(username);
        } else if (state.mainWindow) {
            state.mainWindow.show();
            if (state.mainWindow.isMinimized()) state.mainWindow.restore();
            state.mainWindow.focus();
        }
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

    // Heal a stale/wrong lolPath (moved drive, reinstalled, first run) before
    // anything starts polling for the LCU connection.
    const resolvedLolPath = resolveLolPath(state.config.lolPath);
    if (resolvedLolPath && resolvedLolPath !== state.config.lolPath) {
        console.log(`[Boot] League install auto-detected at ${resolvedLolPath}`);
        state.config.lolPath = resolvedLolPath;
        saveConfig();
    }

    // Non-blocking: the window shows immediately instead of waiting on Data
    // Dragon. Handlers that need the champion maps await championData.whenReady().
    fetchChampionData()
        .catch(e => console.error('[Boot] fetchChampionData failed:', e.message))
        .then(() => fetchItemData());

    try {
        windows.createMainWindow();
        windows.createTray();
        windows.setLaunchCallback(launchFromOutside);
        windows.updateJumpList();

        registerIpc();
        registerLcuEvents();
        initAutoUpdater();
        initOverwolf();
        // No overlay hotkey: the overlay is disabled (see overlay-hotkey.js).
        discordRpc.init();
    } catch (e) {
        console.error('[Boot] Failed to initialize application window:', e.message);
        dialog.showErrorBox('Lost League Manager', `Failed to start:\n${e.message}`);
        app.quit();
        return;
    }

    // Handle --launch= argument on first run, once the page is loaded: the
    // launch's first messages were sent before the renderer listened, and
    // its result (errors included) was dropped.
    const launchUsername = launchArgUsername(process.argv);
    if (launchUsername) {
        state.mainWindow.webContents.once('did-finish-load', () => launchFromOutside(launchUsername));
    }

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
    // Every quit (installer, OS shutdown, app.quit()) must get past the
    // window's hide-to-tray close handler, not only the tray's Quit item.
    app.isQuiting = true;
    discordRpc.shutdown();
});

module.exports = { launchArgUsername };
