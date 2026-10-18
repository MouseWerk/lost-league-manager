const { fakeElectron, invoke } = require('./helpers/b-fakes');
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const { EventEmitter } = require('events');
const state = require('../src/main/state');

// Stand-in for electron-updater.
const autoUpdater = new EventEmitter();
autoUpdater.checkForUpdates = async () => null;
autoUpdater.quitAndInstall = () => {};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron-updater') return { autoUpdater };
    return originalLoad.call(this, request, parent, isMain);
};

const updater = require('../src/main/ipc/updater');
updater.register();

const sent = [];
state.mainWindow = { isDestroyed: () => false, webContents: { send: (ch, ...args) => sent.push([ch, ...args]) } };
fakeElectron.app.isPackaged = true;
state.config.checkUpdatesOnStartup = false;
updater.initAutoUpdater();

test.beforeEach(() => {
    sent.length = 0;
    fakeElectron.app.isQuiting = false;
});

test('install-update lets the window close before quitAndInstall runs', async (t) => {
    let quitingWhenCalled;
    t.mock.method(autoUpdater, 'quitAndInstall', () => { quitingWhenCalled = fakeElectron.app.isQuiting; });
    await invoke('install-update');
    assert.equal(quitingWhenCalled, true);
});

test('an older version in the feed is not reported as an update', async (t) => {
    t.mock.method(autoUpdater, 'checkForUpdates', async () => ({ isUpdateAvailable: false, updateInfo: { version: '0.0.1' } }));
    const res = await invoke('check-for-updates');
    assert.equal(res.updateAvailable, false);
});

test('a newer version is reported', async (t) => {
    t.mock.method(autoUpdater, 'checkForUpdates', async () => ({ isUpdateAvailable: true, updateInfo: { version: '9.9.9' } }));
    const res = await invoke('check-for-updates');
    assert.equal(res.updateAvailable, true);
    assert.equal(res.latestVersion, '9.9.9');
});

test('a failed background check is logged, not shown; a failed download is shown', () => {
    autoUpdater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
    assert.deepEqual(sent, []);

    autoUpdater.emit('update-available', { version: '9.9.9' });
    autoUpdater.emit('error', new Error('download failed'));
    assert.deepEqual(sent.map(s => s[0]), ['update-available', 'update-error']);
});
