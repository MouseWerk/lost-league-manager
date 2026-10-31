const { app, BrowserWindow, Tray, Menu, screen } = require('electron');
const path = require('path');
const state = require('./state');

let _launchCallback = null;

function setLaunchCallback(fn) {
    _launchCallback = fn;
}

// Required lazily: ipc/launch requires this module.
const launchModule = () => require('./ipc/launch');

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
            // No DevTools in installed builds: its console can call every
            // exposed IPC method, the vault gate in main notwithstanding.
            devTools: !app.isPackaged,
        },
    });

    state.mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

    state.mainWindow.once('ready-to-show', () => {
        // A `--launch=` of a minimize-on-launch account may already have
        // hidden the window; showing it here undid that.
        if (state.config.startMinimized || launchModule().isWindowHiddenByLaunch()) return;
        state.mainWindow.show();
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

function createOverlayWindow(owOverlay, onReady = null) {
    const { width: sw } = screen.getPrimaryDisplay().workAreaSize;
    const w = 480;
    // The last place the player dragged it to, else the top right.
    const saved = Number.isInteger(state.config.overlayX) && Number.isInteger(state.config.overlayY);
    const opts = {
        name: 'overlay',
        width: w,
        height: 52,
        x: saved ? state.config.overlayX : sw - w - 16,
        y: saved ? state.config.overlayY : 16,
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
            devTools: !app.isPackaged,
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
        // Keep the place the player dragged it to (Lock in the overlay
        // stops dragging; Reset position forgets it).
        let moveTimer = null;
        state.overlayWindow.on?.('moved', () => {
            clearTimeout(moveTimer);
            moveTimer = setTimeout(() => {
                if (!state.overlayWindow || state.overlayWindow.isDestroyed()) return;
                const [x, y] = state.overlayWindow.getPosition();
                state.config.overlayX = x;
                state.config.overlayY = y;
                require('./services/storage').saveConfig();
            }, 400);
        });
        state.overlayWindow.loadFile(path.join(__dirname, '../renderer/overlay.html'));

        state.overlayWindow.webContents.on('did-finish-load', () => {
            if (!state.overlayWindow || state.overlayWindow.isDestroyed()) return;
            const championData = require('./services/champion-data');
            const itemData = require('./services/item-data');
            // Opacity is applied by the page (CSS); setOpacity does not work on
            // transparent windows and doubled it where it did.
            const opacity = typeof state.config.overlayOpacity === 'number'
                ? state.config.overlayOpacity : 1.0;
            const itemNames = {};
            for (const it of itemData.getItemList?.() || []) if (it?.id && it?.name) itemNames[it.id] = it.name;
            state.overlayWindow.webContents.send('overlay-init', {
                itemNames,
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

    // viaOverwolf: an Overwolf overlay window is drawn only inside the game
    // it was injected into; the fallback is a plain window on top of it.
    const done = (rawWin, viaOverwolf) => {
        finish(rawWin);
        state.overlayViaOverwolf = viaOverwolf;
        if (onReady) onReady();
    };
    const fallback = () => {
        const fb = new BrowserWindow(opts);
        fb.setAlwaysOnTop(true, 'screen-saver');
        done(fb, false);
    };
    if (owOverlay) {
        owOverlay.createWindow(opts)
            .then((w) => done(w, true))
            .catch(e => {
                console.error('[Overlay] createWindow failed, using BrowserWindow fallback:', e.message);
                fallback();
            });
    } else {
        fallback();
    }
}

// Built when the menu opens, so it always matches the vault state and the
// account list without every unlock or edit having to rebuild it. While the
// vault is locked it names no accounts; the launch itself (launchFromOutside)
// shows the window, or keeps it hidden for minimize-on-launch accounts.
function buildTrayMenu() {
    const showMain = () => { if (state.mainWindow) { state.mainWindow.show(); state.mainWindow.focus(); } };
    let acctItems;
    if (launchModule().isVaultLocked()) {
        acctItems = [{ label: 'Unlock to see your accounts', enabled: false }];
    } else {
        const { loadAccounts } = require('./services/storage');
        acctItems = loadAccounts().slice(0, 10).map(acc => ({
            label: `${acc.label || acc.username}${acc.region ? '  ' + acc.region.toUpperCase() : ''}`,
            click: () => { if (_launchCallback) _launchCallback(acc.username); },
        }));
    }

    return Menu.buildFromTemplate([
        { label: 'Lost League Manager', enabled: false },
        { type: 'separator' },
        ...acctItems,
        { type: 'separator' },
        { label: 'Open', click: showMain },
        { type: 'separator' },
        { label: 'Quit', click: () => { app.isQuiting = true; app.quit(); } },
    ]);
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
    state.tray.on('right-click',  () => state.tray.popUpContextMenu(buildTrayMenu()));
}

// Windows keeps the jump list after the app exits, so it lists no accounts
// while the vault is locked; it is rebuilt on the next accounts update.
function updateJumpList() {
    if (process.platform !== 'win32') return;
    const { loadAccounts } = require('./services/storage');
    const accounts = require('./services/vault').isVaultEnabled() ? [] : loadAccounts();

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
    updateJumpList();
}

module.exports = {
    createMainWindow,
    createOverlayWindow,
    createTray,
    buildTrayMenu,
    updateJumpList,
    broadcastAccountsUpdate,
    setLaunchCallback,
};
