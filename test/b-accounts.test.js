const { invoke, fakeElectron, machine, userData, file, writeJson, readJson, legacy } = require('./helpers/b-fakes');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const state = require('../src/main/state');
const encryption = require('../src/main/services/encryption');
const { encrypt, decrypt } = encryption;
const { recordHonorLevel, loadHonorWatch } = require('../src/main/services/honor-watch');
require('../src/main/ipc/accounts').register();

const PASS = 'correct horse battery';
const backupPath = path.join(userData, 'backup.llem');

function chooseSave(filePath) {
    fakeElectron.dialog.showSaveDialog = async () => ({ canceled: false, filePath });
}

let openCalls = 0;
function chooseOpen(filePath) {
    fakeElectron.dialog.showOpenDialog = async () => { openCalls++; return { canceled: false, filePaths: [filePath] }; };
}

test.beforeEach(() => {
    state.config.vaultEnabled = false;
    state.currentAccount = null;
    machine.regFails = false;
    encryption._resetKeyCache();
    openCalls = 0;
    writeJson('accounts.json', []);
    writeJson('honor-watch.json', {});
    fs.rmSync(backupPath, { force: true });
});

// ── Backups ───────────────────────────────────────────────────────────────────

test('backup v2 round-trips only with its passphrase, and each export has its own salt', async () => {
    const data = { version: 1, accounts: [{ username: 'ü', password: 'plain-text-pw' }] };
    const a = await encryption.encryptExport(data, PASS);
    const b = await encryption.encryptExport(data, PASS);
    assert.notEqual(JSON.parse(a).kdf.salt, JSON.parse(b).kdf.salt);
    assert.equal(a.includes('plain-text-pw'), false);
    assert.deepEqual((await encryption.decryptExport(a, PASS)).data, data);
    assert.deepEqual(await encryption.decryptExport(a, 'wrong passphrase'), { ok: false, reason: 'wrong-passphrase' });

    const tampered = JSON.parse(a);
    tampered.kdf.N = 2 ** 30;
    assert.deepEqual(await encryption.decryptExport(JSON.stringify(tampered), PASS), { ok: false, reason: 'invalid' });
});

test('export needs a passphrase of at least 8 characters, not trimmed', async () => {
    chooseSave(backupPath);
    assert.equal((await invoke('export-accounts')).success, false);
    assert.equal((await invoke('export-accounts', 'short')).success, false);
    assert.equal((await invoke('export-accounts', '   abc   ')).success, true);
    assert.equal(fs.existsSync(backupPath), true);
});

test('export then import with the passphrase restores accounts; the file holds no readable password', async () => {
    writeJson('accounts.json', [
        { username: 'main', password: encrypt('s3cret-pw'), label: 'Main', notes: 'n', _cachedStats: { tier: 'Gold' }, lastUsed: 5 },
    ]);
    chooseSave(backupPath);
    const exp = await invoke('export-accounts', PASS);
    assert.deepEqual(exp, { success: true, count: 1, unreadable: 0 });
    assert.equal(fs.readFileSync(backupPath, 'utf8').includes('s3cret-pw'), false);

    writeJson('accounts.json', []);
    chooseOpen(backupPath);
    const first = await invoke('import-accounts');
    assert.deepEqual(first, { success: false, needsPassphrase: true });

    const wrong = await invoke('import-accounts', { passphrase: 'not the passphrase' });
    assert.deepEqual(wrong, { success: false, needsPassphrase: true, wrongPassphrase: true });

    const ok = await invoke('import-accounts', { passphrase: PASS });
    assert.equal(ok.success, true);
    assert.equal(ok.added, 1);
    assert.equal(openCalls, 1, 'the pending file is reused, the dialog opens once');

    const [acc] = readJson('accounts.json');
    assert.equal(acc.username, 'main');
    assert.equal(acc.label, 'Main');
    assert.equal(decrypt(acc.password), 's3cret-pw');
    assert.equal('_cachedStats' in acc, false);
    assert.equal('lastUsed' in acc, false);
});

test('old fixed-key backups still import without a passphrase', async () => {
    fs.writeFileSync(backupPath, legacy.exportV1({ version: 1, accounts: [{ username: 'old', password: 'pw1', region: 'euw' }] }));
    chooseOpen(backupPath);
    const res = await invoke('import-accounts');
    assert.equal(res.success, true);
    assert.equal(res.added, 1);
    assert.equal(decrypt(readJson('accounts.json')[0].password), 'pw1');
});

test('import validates entries, copies only known fields and reports skips', async () => {
    writeJson('accounts.json', [{ username: 'Existing', password: encrypt('x') }]);
    fs.writeFileSync(backupPath, legacy.exportV1({ version: 1, accounts: [
        { username: 123, password: 'x' },
        { username: 'a', password: {} },
        null,
        { username: 'existing', password: 'dup' },
        { username: 'good', password: 'b', _cachedStats: { tier: '<img src=x>' }, honorFlagged: true, extra: 1 },
    ] }));
    chooseOpen(backupPath);
    const res = await invoke('import-accounts');
    assert.equal(res.success, true);
    assert.equal(res.added, 1);
    assert.equal(res.skipped, 4);
    assert.equal(res.duplicates, 1);
    assert.equal(res.invalid, 3);
    const good = readJson('accounts.json').find(a => a.username === 'good');
    assert.deepEqual(Object.keys(good).filter(k => k.startsWith('_') || k === 'extra' || k === 'honorFlagged'), []);
});

test('a backup from a newer version is refused', async () => {
    fs.writeFileSync(backupPath, legacy.exportV1({ version: 2, accounts: [] }));
    chooseOpen(backupPath);
    const res = await invoke('import-accounts');
    assert.equal(res.success, false);
    assert.match(res.message, /newer version/);
});

test('a huge file is not read', async () => {
    fs.writeFileSync(backupPath, Buffer.alloc(6 * 1024 * 1024, 0x61));
    chooseOpen(backupPath);
    const res = await invoke('import-accounts');
    assert.equal(res.success, false);
    assert.match(res.message, /too large/);
});

test('an account with an unreadable password survives export and import with its details', async () => {
    writeJson('accounts.json', [
        { username: 'broken', password: 'v2:00:00', label: 'Smurf', riotId: 'Smurf#EUW' },
        { username: 'fine', password: encrypt('ok') },
    ]);
    chooseSave(backupPath);
    const exp = await invoke('export-accounts', PASS);
    assert.equal(exp.unreadable, 1);

    writeJson('accounts.json', []);
    chooseOpen(backupPath);
    await invoke('import-accounts');
    const res = await invoke('import-accounts', { passphrase: PASS });
    assert.equal(res.added, 2);
    assert.equal(res.withoutPassword, 1);
    const accounts = await invoke('get-accounts');
    const broken = accounts.find(a => a.username === 'broken');
    assert.equal(broken.label, 'Smurf');
    assert.equal(broken.passwordOk, false);
});

test('an export that cannot be written reports the error', async () => {
    chooseSave(path.join(userData, 'no-such-dir', 'x.llem'));
    const res = await invoke('export-accounts', PASS);
    assert.equal(res.success, false);
    assert.ok(res.message);
});

test('without the machine key an import saves nothing and says why', async () => {
    fs.writeFileSync(backupPath, legacy.exportV1({ version: 1, accounts: [{ username: 'a', password: 'b' }] }));
    chooseOpen(backupPath);
    machine.regFails = true;
    const res = await invoke('import-accounts');
    assert.equal(res.success, false);
    assert.match(res.message, /machine key/);
    assert.deepEqual(readJson('accounts.json'), []);
});

// ── Account handlers ──────────────────────────────────────────────────────────

test('add-account reports a missing machine key instead of throwing', async () => {
    machine.regFails = true;
    const res = await invoke('add-account', { username: 'a', password: 'b' });
    assert.equal(res.success, false);
    assert.match(res.message, /machine key/);
});

test('add-account rejects missing passwords and wrong field types', async () => {
    assert.equal((await invoke('add-account', { username: 'a' })).success, false);
    assert.equal((await invoke('add-account', { username: '  ', password: 'b' })).success, false);
    assert.equal((await invoke('add-account', { username: 'a', password: 'b', notes: { x: 1 } })).success, false);
    assert.equal((await invoke('add-account', { username: 'a', password: 'b', _cachedStats: {} })).success, true);
    assert.equal('_cachedStats' in readJson('accounts.json')[0], false);
});

test('usernames match case-insensitively for update, delete, password and reorder', async () => {
    writeJson('accounts.json', [
        { username: 'Player1', password: encrypt('one') },
        { username: 'Second', password: encrypt('two') },
    ]);
    assert.equal((await invoke('update-account', { username: 'player1', label: 'L' })).success, true);
    assert.equal(readJson('accounts.json')[0].label, 'L');
    assert.equal(await invoke('get-account-password', 'PLAYER1'), 'one');
    assert.equal((await invoke('reorder-accounts', ['second', 'player1'])).success, true);
    assert.deepEqual(readJson('accounts.json').map(a => a.username), ['Second', 'Player1']);
    assert.equal((await invoke('delete-account', 'player1')).success, true);
    assert.deepEqual(readJson('accounts.json').map(a => a.username), ['Second']);
});

test('delete-account: unknown name fails, honor flag and active account are cleared', async () => {
    writeJson('accounts.json', [{ username: 'Main', password: encrypt('x') }]);
    recordHonorLevel('Main', 4);
    recordHonorLevel('Main', 2);
    state.currentAccount = { username: 'main' };

    assert.equal((await invoke('delete-account', 'ghost')).success, false);
    assert.equal((await invoke('delete-account', 'Main')).success, true);
    assert.deepEqual(loadHonorWatch(), {});
    assert.equal(state.currentAccount, null);
});

test('honor records written under another spelling of the username are found', async () => {
    writeJson('honor-watch.json', { Main: { peak: 4, current: 2, updatedAt: 1 } });
    writeJson('accounts.json', [{ username: 'main', password: encrypt('x') }]);
    const [acc] = await invoke('get-accounts');
    assert.equal(acc.honorFlagged, true);
});

test('a reorder that cannot be saved reports the error', async (t) => {
    writeJson('accounts.json', [{ username: 'a', password: '' }, { username: 'b', password: '' }]);
    t.mock.method(fs, 'openSync', () => { throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }); });
    const res = await invoke('reorder-accounts', ['b', 'a']);
    assert.equal(res.success, false);
    assert.match(res.message, /EBUSY/);
});
