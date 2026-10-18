// Fakes for the launch/LCU tests: child_process.spawn, the vault gate, the
// main window and notifications. Require this before any module under src/main.
const { fakeElectron, userData, invoke } = require('./fake-electron');
const Module = require('module');
const childProcess = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

// ── Vault gate (src/main/services/vault.js) ──────────────────────────────────
// A locked vault is an enabled one; the jump list empties for any enabled vault.
const fakeVault = { locked: false, isVaultLocked() { return this.locked; }, isVaultEnabled() { return this.locked; } };
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (/(^|[\\/])services[\\/]vault(\.js)?$/.test(request)) return fakeVault;
    return originalLoad.call(this, request, parent, isMain);
};

// ── Notifications ────────────────────────────────────────────────────────────
const notifications = [];
fakeElectron.Notification = class {
    constructor(opts) { this.opts = opts; }
    on() {}
    show() { notifications.push(this.opts); }
};

// ── child_process.spawn ──────────────────────────────────────────────────────
class FakeChild extends EventEmitter {
    constructor(command, args, options) {
        super();
        this.command = command;
        this.args = args;
        this.options = options || {};
        this.stdinData = '';
        this.stdin = new EventEmitter();
        this.stdin.write = (d) => { this.stdinData += d; return true; };
        this.stdin.end = () => {};
        this.stdout = new EventEmitter();
        this.stderr = new EventEmitter();
        this.killed = false;
        this.exited = false;
    }
    unref() {}
    kill() {
        this.killed = true;
        this.exit(null, 'SIGTERM');
        return true;
    }
    exit(code, signal = null) {
        if (this.exited) return;
        this.exited = true;
        setImmediate(() => this.emit('close', code, signal));
    }
    print(text) { this.stdout.emit('data', Buffer.from(text)); }
    get isLoginScript() { return this.args.some(a => String(a).endsWith('login.ps1')); }
    get isPowerShellCommand() { return this.command === 'powershell.exe' && this.args.includes('-Command'); }
}

const spawned = [];
// Decides what a spawned process does; tests replace it. Default: PowerShell
// commands finish at once, everything else keeps running until told.
let spawnBehavior = (child) => { if (child.isPowerShellCommand) child.exit(0); };
childProcess.spawn = (command, args = [], options) => {
    const child = new FakeChild(command, args, options);
    spawned.push(child);
    spawnBehavior(child);
    return child;
};

function setSpawnBehavior(fn) { spawnBehavior = fn; }
function loginScripts() { return spawned.filter(c => c.isLoginScript); }

// ── Main window ──────────────────────────────────────────────────────────────
function fakeWindow({ visible = true } = {}) {
    const win = {
        visible,
        sent: [],
        counts: { show: 0, hide: 0, focus: 0 },
        isDestroyed: () => false,
        isVisible: () => win.visible,
        isMinimized: () => false,
        restore: () => {},
        show: () => { win.counts.show++; win.visible = true; },
        hide: () => { win.counts.hide++; win.visible = false; },
        focus: () => { win.counts.focus++; },
        webContents: { send: (channel, ...args) => win.sent.push({ channel, args }) },
        statuses: () => win.sent.filter(s => s.channel === 'login-status').map(s => s.args[0]),
    };
    return win;
}

function writeAccounts(accounts) {
    fs.writeFileSync(path.join(userData, 'accounts.json'), JSON.stringify(accounts));
}

function readAccounts() {
    return JSON.parse(fs.readFileSync(path.join(userData, 'accounts.json'), 'utf8'));
}

async function waitFor(cond, what, timeoutMs = 3000) {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
        await new Promise(r => setTimeout(r, 5));
    }
}

const tick = () => new Promise(r => setImmediate(r));

module.exports = {
    fakeElectron, userData, invoke,
    fakeVault, notifications,
    spawned, setSpawnBehavior, loginScripts, FakeChild,
    fakeWindow, writeAccounts, readAccounts, waitFor, tick,
};
