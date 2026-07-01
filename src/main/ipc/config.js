const { ipcMain, app } = require('electron');
const state = require('../state');
const { saveConfig } = require('../services/storage');

// Whitelist of keys the renderer is allowed to set, with a type check for
// each — set-config used to Object.assign() the raw payload straight into
// live config, so any bug (or compromised renderer) could inject unknown
// keys or overwrite sensitive ones (e.g. riotApiKey, vaultPasswordHash) with
// the wrong shape.
const ALLOWED_CONFIG_KEYS = {
    autoAccept:            v => typeof v === 'boolean',
    checkUpdatesOnStartup: v => typeof v === 'boolean',
    lolPath:               v => typeof v === 'string',
    minimizeOnGameStart:   v => typeof v === 'boolean',
    overlayEnabled:        v => typeof v === 'boolean',
    overlayHotkey:         v => typeof v === 'string',
    overlayLocked:         v => typeof v === 'boolean',
    overlayShowBuilds:     v => typeof v === 'boolean',
    overlayShowRanked:     v => typeof v === 'boolean',
    riotApiKey:            v => typeof v === 'string',
    startMinimized:        v => typeof v === 'boolean',
    startWithWindows:      v => typeof v === 'boolean',
    toastOnQueuePop:       v => typeof v === 'boolean',
    uiScale:               v => typeof v === 'number',
    vaultEnabled:          v => typeof v === 'boolean',
    vaultPasswordHash:     v => typeof v === 'string',
};

function pushOverlaySettings() {
    const ow = state.overlayWindow;
    if (!ow || ow.isDestroyed()) return;
    ow.webContents.send('overlay-settings-update', {
        showRanked: state.config.overlayShowRanked !== false,
        showBuilds: state.config.overlayShowBuilds !== false,
        locked:     state.config.overlayLocked     || false,
    });
}

function register() {
    ipcMain.handle('get-config', () => {
        state.config.startWithWindows = app.getLoginItemSettings().openAtLogin;
        return state.config;
    });

    ipcMain.handle('set-config', (event, newConfig) => {
        if (!newConfig || typeof newConfig !== 'object') return { success: false, message: 'Invalid config payload' };

        const prev = { ...state.config };
        for (const [key, value] of Object.entries(newConfig)) {
            const isValid = ALLOWED_CONFIG_KEYS[key];
            if (!isValid) { console.warn(`[Config] Rejected unknown config key: ${key}`); continue; }
            if (!isValid(value)) { console.warn(`[Config] Rejected invalid value for config key: ${key}`); continue; }
            state.config[key] = value;
        }
        saveConfig();

        // Compare against what was actually applied to state.config (post-validation),
        // not the raw payload — a rejected/invalid value must not trigger side effects.
        const ow = state.overlayWindow;
        if (ow && !ow.isDestroyed()) {
            // Live-toggle overlay visibility when overlayEnabled changes
            if (state.config.overlayEnabled !== prev.overlayEnabled) {
                if (!state.config.overlayEnabled) {
                    ow.hide();
                }
                // When re-enabled, show only if a game is currently in progress (handled by lcu-events)
            }

            // Push panel visibility / lock changes live
            const panelKeys = ['overlayShowRanked', 'overlayShowBuilds', 'overlayLocked'];
            if (panelKeys.some(k => state.config[k] !== prev[k])) {
                pushOverlaySettings();
            }
        }

        if (state.config.startWithWindows !== prev.startWithWindows) {
            app.setLoginItemSettings({ openAtLogin: !!state.config.startWithWindows });
        }

        // Setting the vault password/toggle from Settings requires already being
        // in an authenticated session — treat that as implicitly unlocking the
        // vault for the rest of this run (next app launch will require it again).
        if ('vaultEnabled' in newConfig || 'vaultPasswordHash' in newConfig) {
            state.vaultUnlocked = true;
        }

        return { success: true };
    });
}

module.exports = { register };
