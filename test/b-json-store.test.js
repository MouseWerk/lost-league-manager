const { userData, invoke, file, writeJson, readJson } = require('./helpers/b-fakes');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const state = require('../src/main/state');
const jsonStore = require('../src/main/services/json-store');
const storage = require('../src/main/services/storage');
require('../src/main/ipc/accounts').register();

function corruptCopies(name) {
    return fs.readdirSync(userData).filter(f => f.startsWith(`${name}.corrupt-`));
}

function clearCorruptCopies() {
    for (const f of fs.readdirSync(userData)) if (f.includes('.corrupt-')) fs.rmSync(file(f));
}

test.beforeEach(() => {
    clearCorruptCopies();
    jsonStore.takeCorruptNotices();
    state.config.vaultEnabled = false;
});

test('a damaged accounts.json is copied aside before anything overwrites it', async () => {
    const broken = '[{"username":"main","password":"v3:aa:bb"},{"username":"smurf"';
    writeJson('accounts.json', broken);

    assert.deepEqual(storage.loadAccounts(), []);
    const copies = corruptCopies('accounts.json');
    assert.equal(copies.length, 1);
    assert.equal(fs.readFileSync(file(copies[0]), 'utf8'), broken);

    // Saving after the copy exists is allowed; the original content survives in the copy.
    const res = await invoke('add-account', { username: 'new', password: 'pw' });
    assert.equal(res.success, true);
    assert.equal(readJson('accounts.json').length, 1);
    assert.equal(fs.readFileSync(file(copies[0]), 'utf8'), broken);
});

test('loading the same damaged file repeatedly keeps a single copy', () => {
    writeJson('accounts.json', '{"not":"an array"}');
    storage.loadAccounts();
    storage.loadAccounts();
    storage.loadAccounts();
    assert.equal(corruptCopies('accounts.json').length, 1);
});

test('when no copy can be kept, the damaged file is never overwritten', (t) => {
    const broken = '{"broken';
    writeJson('accounts.json', broken);
    t.mock.method(fs, 'copyFileSync', () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); });

    assert.deepEqual(storage.loadAccounts(), []);
    assert.throws(() => storage.saveAccounts([{ username: 'x', password: '' }]), /not overwritten/);
    assert.equal(fs.readFileSync(file('accounts.json'), 'utf8'), broken);
});

test('the user is told at boot which file was damaged and where the copy is', () => {
    writeJson('config.json', '{"vaultEnabled": tru');
    writeJson('accounts.json', []);
    storage.loadConfig();
    assert.throws(() => storage.migratePasswords(), /config\.json could not be read\. A copy was kept as config\.json\.corrupt-\d+/);
    // Reported once.
    assert.doesNotThrow(() => storage.migratePasswords());
});

test('saves are flushed to disk before the rename', (t) => {
    const order = [];
    t.mock.method(fs, 'fsyncSync', () => order.push('fsync'));
    const rename = fs.renameSync;
    t.mock.method(fs, 'renameSync', (a, b) => { order.push('rename'); return rename(a, b); });
    jsonStore.saveJson(file('flush.json'), { a: 1 }, 'flush test');
    assert.deepEqual(order, ['fsync', 'rename']);
    assert.deepEqual(readJson('flush.json'), { a: 1 });
});

test('a rename blocked once by another program is retried', (t) => {
    const rename = fs.renameSync;
    let calls = 0;
    t.mock.method(fs, 'renameSync', (a, b) => {
        calls++;
        if (calls === 1) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
        return rename(a, b);
    });
    jsonStore.saveJson(file('retry.json'), { ok: true }, 'retry test');
    assert.equal(calls, 2);
    assert.deepEqual(readJson('retry.json'), { ok: true });
    assert.equal(fs.existsSync(file('retry.json.tmp')), false);
});

test('updateAccounts patches the current file, not an older snapshot', () => {
    writeJson('accounts.json', [{ username: 'a', password: '' }]);
    const stale = storage.loadAccounts();
    // Another handler adds an account meanwhile.
    writeJson('accounts.json', [{ username: 'a', password: '' }, { username: 'b', password: '' }]);
    storage.updateAccounts((accounts) => {
        accounts.find(x => x.username === 'a').riotId = 'A#1';
    });
    const now = readJson('accounts.json');
    assert.equal(stale.length, 1);
    assert.deepEqual(now.map(x => x.username), ['a', 'b']);
    assert.equal(now[0].riotId, 'A#1');
});
