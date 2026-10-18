const { machine, writeJson, readJson, legacy } = require('./helpers/b-fakes');
const test = require('node:test');
const assert = require('node:assert/strict');
const encryption = require('../src/main/services/encryption');
const storage = require('../src/main/services/storage');

test.beforeEach(() => {
    machine.regFails = false;
    machine.wmicUuid = null;
    encryption._resetKeyCache();
});

test('without the machine key, encrypt refuses instead of using the public fallback key', () => {
    machine.regFails = true;
    assert.throws(() => encryption.encrypt('hunter2'), /machine key could not be read/);
});

test('a failed MachineGuid read is not cached for the session', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
    machine.regFails = true;
    assert.throws(() => encryption.encrypt('x'));

    machine.regFails = false;
    t.mock.timers.tick(31 * 1000);
    const value = encryption.encrypt('hunter2');
    assert.equal(legacy.decryptV3(value), 'hunter2');
});

test('v2 passwords are re-encrypted with the machine key while wmic still works', () => {
    machine.wmicUuid = '4C4C4544-0042-3010-8052-B4C04F4E3732';
    writeJson('accounts.json', [{ username: 'old', password: legacy.v2('p@ss wörd', machine.wmicUuid) }]);

    storage.migratePasswords();
    const stored = readJson('accounts.json')[0].password;
    assert.ok(stored.startsWith('v3:'));
    assert.equal(legacy.decryptV3(stored), 'p@ss wörd');

    // wmic removed by a Windows update afterwards: the password still reads.
    machine.wmicUuid = null;
    encryption._resetKeyCache();
    assert.equal(encryption.decrypt(stored), 'p@ss wörd');
});

test('v3 values written with the static fallback key and unprefixed values are re-encrypted', () => {
    writeJson('accounts.json', [
        { username: 'a', password: legacy.v3StaticKey('first') },
        { username: 'b', password: legacy.unprefixed('second') },
        { username: 'c', password: legacy.v3('third') },
    ]);
    const before = readJson('accounts.json');

    storage.migratePasswords();
    const after = readJson('accounts.json');
    assert.equal(legacy.decryptV3(after[0].password), 'first');
    assert.equal(legacy.decryptV3(after[1].password), 'second');
    // Already current: left untouched.
    assert.equal(after[2].password, before[2].password);
});

test('nothing is re-encrypted while the machine key is unavailable', () => {
    const accounts = [
        { username: 'a', password: legacy.v3StaticKey('first') },
        { username: 'b', password: legacy.unprefixed('second') },
    ];
    writeJson('accounts.json', accounts);
    machine.regFails = true;
    storage.migratePasswords();
    assert.deepEqual(readJson('accounts.json'), accounts);
});
