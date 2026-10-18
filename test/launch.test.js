const { userData } = require('./helpers/fake-electron');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const state = require('../src/main/state');
const { executeAccountLaunch } = require('../src/main/ipc/launch');

// With "minimize on launch" on, an unreadable saved password used to hide the
// window first and then fail, leaving the user with no window and no error.
test('an unreadable password fails before the window is hidden', async () => {
    fs.writeFileSync(path.join(userData, 'accounts.json'), JSON.stringify([{
        username: 'someone',
        password: 'v3:00:00', // not decryptable under any key
        minimizeOnLaunch: true,
    }]));

    let hidden = 0;
    const sent = [];
    state.mainWindow = {
        hide: () => { hidden++; },
        isDestroyed: () => false,
        webContents: { send: (channel) => sent.push(channel) },
    };

    const res = await executeAccountLaunch('someone');
    assert.equal(res.success, false);
    assert.match(res.message, /re-enter its password/);
    assert.equal(hidden, 0, 'window must stay visible so the error is seen');
    assert.ok(!sent.includes('login-status'), 'no launch progress for a launch that cannot start');
});

test('an unknown account is reported, nothing else happens', async () => {
    const res = await executeAccountLaunch('does-not-exist');
    assert.deepEqual(res, { success: false, message: 'Account not found' });
});
