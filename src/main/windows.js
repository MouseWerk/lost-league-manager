const { app, BrowserWindow, Tray, Menu, screen } = require('electron');
const path = require('path');
const state = require('./state');

let _launchCallback = null;

function setLaunchCallback(fn) {
    _launchCallback = fn;
}

function createMainWindow() {
    const scale  = state.config.uiScale || 1.0;
    const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
    const width  = Math.min(scale !== 1.0 ? Math.round(1100 * scale) : 1100, sw);
    const height = Math.min(scale !== 1.0 ? Math.round(680  * scale) : 680,  sh);
    state.mainWindow = new BrowserWindow({
        width,
        height,
        frame: false,
        transparent: true,
        resizable: false,
        show: false,
        icon: path.join(__dirname, '../renderer/assets/logo.ico'),
        webPreferences: {
            preload: path.join(__dirname, '../preload/preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
        },
    });

    state.mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

    state.mainWindow.once('ready-to-show', () => {
        if (!state.config.startMinimized) state.mainWindow.show();
    });

    state.mainWindow.on('close', (e) => {
        if (!app.isQuiting) {
            e.preventDefault();
            state.mainWindow.hide();
        }
    });

    state.mainWindow.on('closed', () => {
        if (state.overlayWindow && !state.overlayWindow.isDestroyed()) {
            state.overlayWindow.destroy();
            state.overlayWindow = null;
        }
    });
}

function createOverlayWindow(owOverlay) {
    const { width: sw } = screen.getPrimaryDisplay().workAreaSize;
    const w = 480;
    const opts = {
        name: 'overlay',
        width: w,
        height: 52,
        x: sw - w - 16,
        y: 16,
        transparent: true,
        frame: false,
        resizable: false,
        skipTaskbar: true,
        focusable: true,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, '../preload/overlay-preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
        },
    };

    const finish = (rawWin) => {
        const bw = rawWin?.window ?? rawWin?.browserWindow ?? rawWin;
        if (!bw) throw new Error('[Overlay] Window handle missing after createWindow');

        state.overlayWindow = bw;
        if (!state.overlayWindow.startDragging && typeof rawWin?.startDragging === 'function') {
            state.overlayWindow.startDragging = rawWin.startDragging.bind(rawWin);
        }

        state.overlayWindow.setIgnoreMouseEvents(true, { forward: true });
        state.overlayWindow.loadFile(path.join(__dirname, '../renderer/overlay.html'));

        state.overlayWindow.webContents.on('did-finish-load', () => {
            if (!state.overlayWindow || state.overlayWindow.isDestroyed()) return;
            const championData = require('./services/champion-data');
            // Apply saved opacity
            const opacity = typeof state.config.overlayOpacity === 'number'
                ? state.config.overlayOpacity : 1.0;
            state.overlayWindow.setOpacity(opacity);
            state.overlayWindow.webContents.send('overlay-init', {
                ddragonVersion: championData.getLatestVersion(),
                champKeyMap: championData.getNameToKeyMap(),
                showRanked:  state.config.overlayShowRanked  !== false,
                showBuilds:  state.config.overlayShowBuilds  !== false,
                opacity,
                hotkey:  state.config.overlayHotkey  || 'Ctrl+Shift+H',
                locked:  state.config.overlayLocked  || false,
            });
        });
    };

    if (owOverlay) {
        owOverlay.createWindow(opts)
            .then(finish)
            .catch(e => {
                console.error('[Overlay] createWindow failed, using BrowserWindow fallback:', e.message);
                const fb = new BrowserWindow(opts);
                fb.setAlwaysOnTop(true, 'screen-saver');
                finish(fb);
            });
    } else {
        const fb = new BrowserWindow(opts);
        fb.setAlwaysOnTop(true, 'screen-saver');
        finish(fb);
    }
}

function updateTrayMenu() {
    if (!state.tray) return;
    const { loadAccounts } = require('./services/storage');
    const accounts = loadAccounts();
    const acctItems = accounts.slice(0, 10).map(acc => ({
        label: `${acc.label || acc.username}${acc.region ? '  ' + acc.region.toUpperCase() : ''}`,
        click: () => {
            if (_launchCallback) _launchCallback(acc.username);
            if (state.mainWindow) { state.mainWindow.show(); state.mainWindow.focus(); }
        },
    }));

    const menu = Menu.buildFromTemplate([
        { label: 'Lost League Manager', enabled: false },
        { type: 'separator' },
        ...acctItems,
        { type: 'separator' },
        { label: 'Open', click: () => { if (state.mainWindow) { state.mainWindow.show(); state.mainWindow.focus(); } } },
        { type: 'separator' },
        { label: 'Quit', click: () => { app.isQuiting = true; app.quit(); } },
    ]);
    state.tray.setContextMenu(menu);
}

function createTray() {
    const iconPath = path.join(__dirname, '../renderer/assets/logo.ico');
    state.tray = new Tray(iconPath);
    state.tray.setToolTip('Lost League Manager');
    const showMain = () => {
        if (state.mainWindow) { state.mainWindow.show(); state.mainWindow.focus(); }
    };
    state.tray.on('click',        showMain);
    state.tray.on('double-click', showMain);
    updateTrayMenu();
}

function updateJumpList() {
    if (process.platform !== 'win32') return;
    const { loadAccounts } = require('./services/storage');
    const accounts = loadAccounts();

    const tasks = accounts.slice(0, 5).map(acc => {
        let args = `--launch=${acc.username}`;
        if (!app.isPackaged) args = `. --launch=${acc.username}`;
        return {
            program: process.execPath,
            arguments: args,
            iconPath: process.execPath,
            iconIndex: 0,
            title: `Launch ${acc.label || acc.username}`,
            description: `Login to ${acc.label || acc.username}`,
        };
    });

    try {
        app.setUserTasks(tasks);
    } catch (e) {
        console.error('[JumpList] Failed to set tasks:', e.message);
    }
}

function broadcastAccountsUpdate() {
    BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) win.webContents.send('accounts-updated');
    });
    updateTrayMenu();
    updateJumpList();
}

module.exports = {
    createMainWindow,
    createOverlayWindow,
    createTray,
    updateTrayMenu,
    updateJumpList,
    broadcastAccountsUpdate,
    setLaunchCallback,
};
