const { ipcMain, app } = require('electron');
const { autoUpdater } = require('electron-updater');
const state = require('../state');

function send(channel, ...args) {
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
        state.mainWindow.webContents.send(channel, ...args);
    }
}

function initAutoUpdater() {
    if (!app.isPackaged) return;

    autoUpdater.autoDownload        = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger              = console;

    autoUpdater.on('checking-for-update', () => console.log('[Updater] Checking...'));

    autoUpdater.on('update-available', (info) => {
        console.log('[Updater] Update available:', info.version);
        send('update-available', { version: info.version, releaseNotes: info.releaseNotes });
    });

    autoUpdater.on('update-not-available', (info) => {
        console.log('[Updater] Up to date:', info.version);
    });

    autoUpdater.on('download-progress', (progress) => {
        send('update-progress', {
            percent:     Math.round(progress.percent),
            transferred: progress.transferred,
            total:       progress.total,
        });
    });

    autoUpdater.on('update-downloaded', (info) => {
        console.log('[Updater] Downloaded:', info.version);
        send('update-downloaded', { version: info.version });
    });

    autoUpdater.on('error', (err) => {
        console.error('[Updater] Error:', err.message);
        send('update-error', err.message);
    });

    if (state.config.checkUpdatesOnStartup !== false) {
        setTimeout(() => {
            autoUpdater.checkForUpdates().catch(e =>
                console.error('[Updater] startup check failed:', e.message)
            );
        }, 10000);
    }
}

function register() {
    ipcMain.handle('check-for-updates', async () => {
        if (!app.isPackaged) return { updateAvailable: false, currentVersion: app.getVersion() };
        try {
            const result  = await autoUpdater.checkForUpdates();
            const latest  = result?.updateInfo?.version;
            return {
                updateAvailable: !!latest && latest !== app.getVersion(),
                latestVersion:   latest,
                currentVersion:  app.getVersion(),
            };
        } catch (e) {
            console.error('[Updater] check-for-updates failed:', e.message);
            return { updateAvailable: false, error: e.message, currentVersion: app.getVersion() };
        }
    });

    ipcMain.handle('install-update', () => {
        if (app.isPackaged) autoUpdater.quitAndInstall(false, true);
    });

    ipcMain.handle('get-version', () => app.getVersion());
}

module.exports = { register, initAutoUpdater };
