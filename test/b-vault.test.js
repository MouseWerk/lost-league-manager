const { invoke, fakeElectron, file, writeJson, readJson, legacy } = require('./helpers/b-fakes');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const state = require('../src/main/state');
const vault = require('../src/main/services/vault');
const { encrypt } = require('../src/main/services/encryption');
require('../src/main/ipc/accounts').register();
require('../src/main/ipc/config').register();

const VAULT_KEYS = ['vaultEnabled', 'vaultKdf', 'vaultSalt', 'vaultHash', 'vaultPasswordHash'];

function resetVault(extra = {}) {
    for (const k of VAULT_KEYS) delete state.config[k];
    state.config.vaultEnabled = false;
    Object.assign(state.config, extra);
    state.vaultUnlocked = false;
    vault._resetAttempts();
    vault._setClock(null);
}

// Old versions: SHA-256 of the password, computed in the renderer.
function legacyVault(password) {
    resetVault({ vaultEnabled: true, vaultPasswordHash: legacy.sha256(password) });
}

async function scryptVault(password) {
    resetVault();
    assert.equal((await invoke('set-vault-password', { next: password })).success, true);
    state.vaultUnlocked = false;
}

test.beforeEach(() => {
    resetVault();
    writeJson('accounts.json', [{ username: 'main', password: encrypt('secret-pw'), notes: 'private' }]);
    fakeElectron.dialog.showOpenDialog = async () => { throw new Error('dialog must not open while locked'); };
    fakeElectron.dialog.showSaveDialog = async () => { throw new Error('dialog must not open while locked'); };
});

test('set-config cannot switch the vault off or re-key it while locked', async () => {
    legacyVault('summer1');
    const res = await invoke('set-config', { vaultEnabled: false, vaultPasswordHash: legacy.sha256('x') });
    assert.equal(res.success, false);
    assert.equal(vault.isVaultLocked(), true);
    assert.equal(state.config.vaultPasswordHash, legacy.sha256('summer1'));
    assert.equal(await invoke('get-account-password', 'main'), null);
});

test('get-config never returns the vault verifier', async () => {
    await scryptVault('summer1');
    const cfg = await invoke('get-config');
    for (const k of ['vaultPasswordHash', 'vaultHash', 'vaultSalt', 'vaultKdf']) assert.equal(k in cfg, false, k);
    assert.equal(cfg.vaultEnabled, true);
    legacyVault('summer1');
    assert.equal('vaultPasswordHash' in (await invoke('get-config')), false);
});

test('the stored hash is not accepted as the password', async () => {
    legacyVault('summer1');
    const res = await invoke('unlock-vault', legacy.sha256('summer1'));
    assert.equal(res.success, false);
    assert.equal(vault.isVaultLocked(), true);
});

test('a legacy SHA-256 vault unlocks with the password and is upgraded to salted scrypt', async () => {
    legacyVault('summer1');
    assert.equal((await invoke('unlock-vault', 'summer1')).success, true);
    assert.equal(vault.isVaultLocked(), false);

    const onDisk = readJson('config.json');
    assert.equal(onDisk.vaultKdf, 'scrypt');
    assert.match(onDisk.vaultSalt, /^[0-9a-f]{32}$/);
    assert.match(onDisk.vaultHash, /^[0-9a-f]{64}$/);
    assert.equal('vaultPasswordHash' in onDisk, false);

    state.vaultUnlocked = false;
    assert.equal((await invoke('unlock-vault', 'summer1')).success, true);
    state.vaultUnlocked = false;
    assert.equal((await invoke('unlock-vault', 'summer2')).success, false);
});

test('the same password gets a different salt and hash each time', async () => {
    await scryptVault('same-password');
    const first = { salt: state.config.vaultSalt, hash: state.config.vaultHash };
    await scryptVault('same-password');
    assert.notEqual(state.config.vaultSalt, first.salt);
    assert.notEqual(state.config.vaultHash, first.hash);
});

test('passwords are not trimmed: " pass " set is " pass " to unlock', async () => {
    await scryptVault(' pass ');
    assert.equal((await invoke('unlock-vault', 'pass')).success, false);
    assert.equal((await invoke('unlock-vault', ' pass ')).success, true);
});

test('a legacy password that was trimmed when set still unlocks as typed', async () => {
    // The old renderer hashed "pass" for " pass " but compared the untrimmed input.
    legacyVault('pass');
    assert.equal((await invoke('unlock-vault', ' pass ')).success, true);
});

test('wrong passwords are limited with a growing wait', async () => {
    await scryptVault('right-one');
    let now = 1_000_000;
    vault._setClock(() => now);
    for (let i = 0; i < 4; i++) {
        const r = await invoke('unlock-vault', `wrong-${i}`);
        assert.equal(r.success, false);
        assert.equal(r.retryAfterMs, undefined);
    }
    const fifth = await invoke('unlock-vault', 'wrong-4');
    assert.equal(fifth.retryAfterMs, 30_000);

    // Even the right password is refused during the wait.
    const blocked = await invoke('unlock-vault', 'right-one');
    assert.equal(blocked.success, false);
    assert.ok(blocked.retryAfterMs > 0);

    now += 30_000;
    assert.equal((await invoke('unlock-vault', 'wrong-5')).retryAfterMs, 60_000);
    now += 60_000;
    assert.equal((await invoke('unlock-vault', 'right-one')).success, true);
});

test('parallel guesses cannot get around the limit', async () => {
    await scryptVault('right-one');
    vault._setClock(() => 5_000_000);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => invoke('unlock-vault', `wrong-${i}`)));
    assert.equal(results.filter(r => r.retryAfterMs > 0).length, 4);
});

test('changing the password needs the current one; disabling too', async () => {
    await scryptVault('first-pw');
    state.vaultUnlocked = true;
    assert.equal((await invoke('set-vault-password', { current: 'nope', next: 'second-pw' })).success, false);
    assert.equal((await invoke('set-vault-password', { current: 'first-pw', next: 'second-pw' })).success, true);
    assert.equal((await invoke('disable-vault', 'first-pw')).success, false);
    assert.equal((await invoke('disable-vault', 'second-pw')).success, true);
    assert.deepEqual(await invoke('get-vault-state'), { enabled: false, unlocked: true });
    assert.equal(readJson('config.json').vaultHash, undefined);
});

test('an empty new password is refused', async () => {
    const r = await invoke('set-vault-password', { next: '' });
    assert.equal(r.success, false);
    assert.equal(vault.isVaultEnabled(), false);
});

test('while locked, account IPC refuses and changes nothing', async () => {
    await scryptVault('summer1');
    const before = fs.readFileSync(file('accounts.json'), 'utf8');
    const locked = { success: false, locked: true, message: 'Vault is locked' };

    assert.deepEqual(await invoke('get-accounts'), []);
    assert.equal(await invoke('get-account-password', 'main'), null);
    assert.deepEqual(await invoke('add-account', { username: 'x', password: 'y' }), locked);
    assert.deepEqual(await invoke('update-account', { username: 'main', password: 'changed' }), locked);
    assert.deepEqual(await invoke('delete-account', 'main'), locked);
    assert.deepEqual(await invoke('reorder-accounts', ['main']), locked);
    assert.deepEqual(await invoke('export-accounts', 'long enough passphrase'), locked);
    assert.deepEqual(await invoke('import-accounts', {}), locked);
    assert.equal(fs.readFileSync(file('accounts.json'), 'utf8'), before);

    assert.equal((await invoke('unlock-vault', 'summer1')).success, true);
    assert.equal(await invoke('get-account-password', 'main'), 'secret-pw');
    assert.equal((await invoke('get-accounts')).length, 1);
});

test('tray and jump list are rebuilt after unlock, enable and disable', async (t) => {
    const sent = [];
    const win = { isDestroyed: () => false, webContents: { send: (ch) => sent.push(ch) } };
    t.mock.method(fakeElectron.BrowserWindow, 'getAllWindows', () => [win]);

    await invoke('set-vault-password', { next: 'pw-123' });
    assert.equal(sent.length, 1);
    state.vaultUnlocked = false;
    await invoke('unlock-vault', 'wrong');
    assert.equal(sent.length, 1);
    await invoke('unlock-vault', 'pw-123');
    assert.equal(sent.length, 2);
    await invoke('disable-vault', 'pw-123');
    assert.deepEqual(sent, ['accounts-updated', 'accounts-updated', 'accounts-updated']);
});

test('without a vault password nothing is locked', async () => {
    resetVault({ vaultEnabled: true, vaultPasswordHash: '' });
    assert.equal(vault.isVaultLocked(), false);
    assert.equal((await invoke('get-accounts')).length, 1);
});
