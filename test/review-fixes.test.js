// Fixes from the review of the merged quality pass. Uses the real vault
// module (services/vault.js), not a stand-in.
const { fakeElectron, userData, invoke } = require('./helpers/fake-electron');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const state = require('../src/main/state');
const lcu = require('../src/main/lcu');
const vault = require('../src/main/services/vault');
const { looksLikePassword } = require('../src/main/services/storage');

require('../src/main/ipc/launch').register();
require('../src/main/ipc/stats').register();
require('../src/main/ipc/accounts').register();

const onWindows = process.platform === 'win32';
const LOGIN_PS1 = path.join(__dirname, '..', 'resources', 'scripts', 'login.ps1');

// Turns the vault on (as after a restart: enabled, not yet unlocked).
function lockVault(t) {
    const saved = { ...state.config };
    const savedUnlocked = state.vaultUnlocked;
    Object.assign(state.config, { vaultEnabled: true, vaultKdf: 'scrypt', vaultSalt: '00', vaultHash: '00' });
    state.vaultUnlocked = false;
    t.after(() => {
        for (const k of ['vaultEnabled', 'vaultKdf', 'vaultSalt', 'vaultHash']) delete state.config[k];
        Object.assign(state.config, saved);
        state.vaultUnlocked = savedUnlocked;
    });
    assert.equal(vault.isVaultLocked(), true);
}

test('while locked, the signed-in login name is not handed out', async (t) => {
    lockVault(t);
    state.currentAccount = { username: 'secret-login' };
    t.after(() => { state.currentAccount = null; });
    assert.equal(await invoke('get-current-account'), null);

    const wasConnected = lcu.connected;
    lcu.connected = true;
    t.after(() => { lcu.connected = wasConnected; });
    const res = await invoke('get-client-summoner');
    assert.equal(res.success, false);
    assert.equal(res.locked, true);
});

test('with the vault on, the jump list shows no accounts, even while unlocked', (t) => {
    lockVault(t);
    state.vaultUnlocked = true; // unlocked in this session; the jump list outlives it
    fs.writeFileSync(path.join(userData, 'accounts.json'), JSON.stringify([{ username: 'alice', label: 'Main' }]));
    let tasks = null;
    t.mock.method(fakeElectron.app, 'setUserTasks', (list) => { tasks = list; });
    require('../src/main/windows').updateJumpList();
    if (process.platform === 'win32') assert.deepEqual(tasks, []);
});

test('a passphrase for a backup that is no longer pending says so', async () => {
    const res = await invoke('import-accounts', { passphrase: 'long enough pass' });
    assert.equal(res.success, false);
    assert.equal(res.expired, true);
    assert.match(res.message, /Choose the file again/);
});

test('password migration skips decrypts that cannot be a typed password', () => {
    assert.equal(looksLikePassword('Passwört 1!'), true);
    assert.equal(looksLikePassword('ab\u0000c'), false);
    assert.equal(looksLikePassword('\u0007\u0003x'), false);
    assert.equal(looksLikePassword('a�b'), false);
    assert.equal(looksLikePassword(''), false);
});

function runLoginScript(stdin) {
    return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', LOGIN_PS1,
        '-Username', 'tester', '-RiotClientPath', '', '-NotBefore', '0'], { input: stdin, encoding: 'utf8', timeout: 60000, windowsHide: true });
}

// The real -File call, as launch.js makes it.
test('login.ps1 without a password exits with 4', { skip: !onWindows && 'needs powershell.exe' }, () => {
    const r = runLoginScript('\n');
    assert.equal(r.status, 4, r.stdout + r.stderr);
});

// An unexpected error used to exit with 1, which reads as "window not found".
test('an unexpected error in login.ps1 exits with its own code 5', { skip: !onWindows && 'needs powershell.exe' }, () => {
    const r = runLoginScript('this is not base64!!\n');
    assert.equal(r.status, 5, r.stdout + r.stderr);
    assert.match(r.stdout, /ERROR:/);
});
