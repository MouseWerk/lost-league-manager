const { ipcMain } = require('electron');
const state = require('../state');
const { saveConfig } = require('../services/storage');

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
    ipcMain.handle('get-config', () => state.config);

    ipcMain.handle('set-config', (event, newConfig) => {
        const prev = { ...state.config };
        Object.assign(state.config, newConfig);
        saveConfig();

        const ow = state.overlayWindow;
        if (ow && !ow.isDestroyed()) {
            // Live-toggle overlay visibility when overlayEnabled changes
            if (newConfig.overlayEnabled !== undefined && newConfig.overlayEnabled !== prev.overlayEnabled) {
                if (!newConfig.overlayEnabled) {
                    ow.hide();
                }
                // When re-enabled, show only if a game is currently in progress (handled by lcu-events)
            }

            // Push panel visibility / lock changes live
            const panelKeys = ['overlayShowRanked', 'overlayShowBuilds', 'overlayLocked'];
            if (panelKeys.some(k => newConfig[k] !== undefined && newConfig[k] !== prev[k])) {
                pushOverlaySettings();
            }
        }

        return { success: true };
    });
}

module.exports = { register };
