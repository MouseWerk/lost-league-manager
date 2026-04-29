const { ipcMain } = require('electron');
const state = require('../state');
const { saveConfig } = require('../services/storage');

function register() {
    ipcMain.handle('get-config', () => state.config);

    ipcMain.handle('set-config', (event, newConfig) => {
        Object.assign(state.config, newConfig);
        saveConfig();
        return { success: true };
    });
}

module.exports = { register };
