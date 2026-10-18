// A data file that goes bad while the app runs must not be replaced by the
// next save: an add-account after the list read as empty used to leave only
// the new account in accounts.json.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../src/main/services/json-store');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-store-'));
const notices = [];
store.setNoticeListener((n) => notices.push(n));
store.markBooted();

const copiesOf = (file) => fs.readdirSync(dir).filter(f => f.startsWith(path.basename(file) + '.corrupt-'));

test('a file damaged at runtime is kept, reported, and not overwritten', () => {
    const file = path.join(dir, 'accounts.json');
    fs.writeFileSync(file, JSON.stringify([{ username: 'a' }, { username: 'b' }]));
    assert.equal(store.loadJson(file, [], 'accounts', Array.isArray).length, 2);

    fs.writeFileSync(file, '[{"username":"a"},{"user'); // truncated by a crash or sync conflict
    assert.deepEqual(store.loadJson(file, [], 'accounts', Array.isArray), []);
    assert.equal(copiesOf(file).length, 1, 'a copy of the damaged file is kept');
    assert.deepEqual(notices.map(n => n.kind), ['damaged']);

    assert.throws(() => store.saveJson(file, [{ username: 'new' }], 'accounts'), /not overwritten/);
    assert.equal(fs.readFileSync(file, 'utf8'), '[{"username":"a"},{"user', 'the damaged file is untouched');
});

test('a briefly unreadable file is not treated as damaged and saves resume once it reads again', (t) => {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ autoAccept: true }));
    notices.length = 0;

    const realRead = fs.readFileSync;
    const busy = t.mock.method(fs, 'readFileSync', function (p, ...rest) {
        if (p === file) { const e = new Error('resource busy or locked'); e.code = 'EBUSY'; throw e; }
        return realRead.call(this, p, ...rest);
    });
    assert.deepEqual(store.loadJson(file, {}, 'config'), {});
    assert.equal(copiesOf(file).length, 0, 'no corrupt copy for a locked file');
    assert.deepEqual(notices.map(n => n.kind), ['unreadable']);
    assert.throws(() => store.saveJson(file, {}, 'config'), /not overwritten/);
    assert.deepEqual(JSON.parse(realRead(file, 'utf8')), { autoAccept: true });

    busy.mock.restore();
    assert.deepEqual(store.loadJson(file, {}, 'config'), { autoAccept: true });
    store.saveJson(file, { autoAccept: false }, 'config');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { autoAccept: false });
});
