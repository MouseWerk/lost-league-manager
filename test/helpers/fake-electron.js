// Stands in for the `electron` module so main-process code can be required
// under plain Node. Require this file before any module under src/main.
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-test-'));
const handlers = new Map();

const fakeElectron = {
    app: {
        isPackaged: false,
        getPath: () => userData,
        getLoginItemSettings: () => ({ openAtLogin: false }),
        setLoginItemSettings: () => {},
        getVersion: () => '0.0.0-test',
        setUserTasks: () => {},
    },
    ipcMain: {
        handle: (channel, fn) => handlers.set(channel, fn),
        on: () => {},
    },
    shell: { openExternal: async () => {} },
    dialog: {},
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
    Notification: class { on() {} show() {} },
    BrowserWindow: class { static getAllWindows() { return []; } },
    Tray: class {},
    Menu: { buildFromTemplate: () => ({}) },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return fakeElectron;
    return originalLoad.call(this, request, parent, isMain);
};

// Calls an ipcMain.handle()-registered handler like the renderer would.
function invoke(channel, ...args) {
    const fn = handlers.get(channel);
    if (!fn) throw new Error(`No IPC handler registered for ${channel}`);
    return fn({}, ...args);
}

module.exports = { fakeElectron, userData, invoke };
