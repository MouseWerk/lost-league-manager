const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const APP_DATA_PATH = app.getPath('userData');

let RESOURCES_PATH;
if (app.isPackaged) {
    const nested = path.join(process.resourcesPath, 'resources');
    RESOURCES_PATH = fs.existsSync(path.join(nested, 'scripts', 'login.ps1'))
        ? nested
        : process.resourcesPath;
} else {
    RESOURCES_PATH = path.join(__dirname, '../../resources');
}

const state = {
    mainWindow: null,
    overlayWindow: null,
    tray: null,
    currentAccount: null,
    owOverlayPackage: null,

    config: {
        lolPath: 'C:\\Riot Games\\League of Legends\\LeagueClient.exe',
        autoAccept: false,
        overlayEnabled: true,
        overlayShowRanked: true,
        overlayShowBuilds: true,
        overlayOpacity: 1.0,
        overlayHotkey: 'Ctrl+Shift+H',
        overlayLocked: false,
        startMinimized: false,
        minimizeOnGameStart: false,
        checkUpdatesOnStartup: true,
        riotApiKey: '',
    },

    paths: {
        accounts: path.join(APP_DATA_PATH, 'accounts.json'),
        config:   path.join(APP_DATA_PATH, 'config.json'),
    },

    RESOURCES_PATH,
    LOL_GEP_GAME_ID:     5426,
    LOL_OVERLAY_CLASS_ID: 54261,
};

module.exports = state;
