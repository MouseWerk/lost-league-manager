// Tray, jump list, second instance (`--launch=`), quitting and the overlay
// hotkey: the ways into the app that do not go through the renderer.
const fx = require('./helpers/a-fakes');
const Module = require('module');
const { EventEmitter } = require('events');
const test = require('node:test');
const assert = require('node:assert/strict');

const { fakeElectron } = fx;

// ── Extra electron stubs, installed before the modules under test load ──────
const appHandlers = {};
const userTasks = [];
Object.assign(fakeElectron.app, {
    requestSingleInstanceLock: () => true,
    on: (event, fn) => { appHandlers[event] = fn; },
    whenReady: () => new Promise(() => {}), // boot itself is not under test
    quit: () => {},
    setUserTasks: (tasks) => { userTasks.push(tasks); },
});
fakeElectron.Menu.buildFromTemplate = (template) => ({ template });
fakeElectron.Tray = class extends EventEmitter {
    setToolTip() {}
    popUpContextMenu(menu) { this.popped = menu; }
};
fakeElectron.BrowserWindow = class extends EventEmitter {
    static getAllWindows() { return []; }
    constructor() {
        super();
        this.shown = 0;
        this.webContents = new EventEmitter();
        this.webContents.send = () => {};
    }
    loadFile() {}
    show() { this.shown++; }
    hide() {}
    isDestroyed() { return false; }
    isVisible() { return this.shown > 0; }
};
const registered = [];
fakeElectron.globalShortcut = {
    register: (key) => { registered.push(key); return true; },
    unregister: () => {},
    unregisterAll: () => {},
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron-updater') return { autoUpdater: new EventEmitter() };
    return originalLoad.call(this, request, parent, isMain);
};

const state = require('../src/main/state');
const { encrypt } = require('../src/main/services/encryption');
const windows = require('../src/main/windows');
const launch = require('../src/main/ipc/launch');
const { registerOverlayHotkey } = require('../src/main/overlay-hotkey');
const { launchArgUsername } = require('../src/main/main');

function setup({ locked = false, accounts } = {}) {
    launch.cancelLaunch();
    fx.spawned.length = 0;
    fx.fakeVault.locked = locked;
    fx.writeAccounts(accounts || [{ username: 'alice', label: 'Main', password: encrypt('x') }]);
    state.mainWindow = fx.fakeWindow({ visible: false });
}

function trayMenu() {
    windows.createTray();
    state.tray.emit('right-click');
    return state.tray.popped.template;
}

test('the tray lists no accounts while the vault is locked', () => {
    setup({ locked: true });
    const labels = trayMenu().map(i => i.label).filter(Boolean);
    assert.ok(!labels.some(l => l.includes('Main')));
    assert.ok(labels.includes('Unlock to see your accounts'));
});

test('the tray menu is built when opened, with the current accounts', () => {
    setup();
    const launched = [];
    windows.setLaunchCallback((u) => launched.push(u));
    const item = trayMenu().find(i => i.label === 'Main');
    assert.ok(item, 'account listed once unlocked');
    item.click();
    assert.deepEqual(launched, ['alice']);
    assert.equal(state.mainWindow.counts.show, 0, 'showing is left to the launch (minimize on launch)');
});

test('the jump list names no accounts while the vault is locked', () => {
    setup({ locked: true });
    windows.updateJumpList();
    assert.deepEqual(userTasks.at(-1), []);
    fx.fakeVault.locked = false;
    windows.updateJumpList();
    assert.equal(userTasks.at(-1)[0].title, 'Launch Main');
});

test('a jump-list launch while the vault is locked only opens the lock screen', async () => {
    setup({ locked: true });
    await appHandlers['second-instance']({}, ['app.exe', '--launch=alice']);
    assert.equal(state.mainWindow.visible, true);
    assert.equal(fx.spawned.length, 0);
});

test('a second start without --launch just shows the window', () => {
    setup();
    appHandlers['second-instance']({}, ['app.exe']);
    assert.equal(state.mainWindow.visible, true);
});

test('--launch= keeps usernames that contain =', () => {
    assert.equal(launchArgUsername(['app.exe', '--launch=a=b']), 'a=b');
    assert.equal(launchArgUsername(['app.exe']), null);
});

test('every quit gets past the hide-to-tray close handler', () => {
    fakeElectron.app.isQuiting = false;
    appHandlers['before-quit']();
    assert.equal(fakeElectron.app.isQuiting, true);
    fakeElectron.app.isQuiting = false;
});

test('the first ready-to-show does not undo minimize on launch', async () => {
    setup({ accounts: [{ username: 'alice', password: encrypt('x'), minimizeOnLaunch: true }] });
    let kill;
    fx.setSpawnBehavior((child) => { if (child.isPowerShellCommand) kill = child; });
    state.config.startMinimized = false;
    windows.createMainWindow();
    const win = state.mainWindow; // the fake BrowserWindow
    const pending = launch.executeAccountLaunch('alice');
    await fx.waitFor(() => kill, 'the launch to hide the window');
    assert.equal(launch.isWindowHiddenByLaunch(), true);
    win.emit('ready-to-show');
    assert.equal(win.shown, 0);
    launch.cancelLaunch();
    kill.exit(0);
    await pending;

    windows.createMainWindow();
    state.mainWindow.emit('ready-to-show');
    assert.equal(state.mainWindow.shown, 1, 'normal start still shows the window');
});

test('the overlay hotkey is not registered while the overlay does not exist', () => {
    state.overlayWindow = null;
    registerOverlayHotkey('Ctrl+Shift+H');
    assert.deepEqual(registered, []);
    state.overlayWindow = { isDestroyed: () => false };
    registerOverlayHotkey('Ctrl+Shift+H');
    assert.deepEqual(registered, ['Ctrl+Shift+H']);
    state.overlayWindow = null;
});
