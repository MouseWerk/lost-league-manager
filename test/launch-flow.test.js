const fx = require('./helpers/a-fakes');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const state = require('../src/main/state');
const lcu = require('../src/main/lcu');
const { encrypt } = require('../src/main/services/encryption');
const launch = require('../src/main/ipc/launch');

launch.register();

// Keep the tests away from the machine's real Riot install records.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-launch-'));
process.env.ProgramData = path.join(sandbox, 'ProgramData');
process.env.LOCALAPPDATA = path.join(sandbox, 'LocalAppData');
const fakeLolPath = path.join(sandbox, 'League of Legends', 'LeagueClient.exe');
fs.mkdirSync(path.dirname(fakeLolPath), { recursive: true });
fs.writeFileSync(fakeLolPath, '');

let win;

function setup({ accounts, lcuConnected = false, session = null, phase = 'None', visible = true } = {}) {
    launch.cancelLaunch(); // no launch left over from a previous test
    fx.spawned.length = 0;
    fx.notifications.length = 0;
    fx.fakeVault.locked = false;
    fx.setSpawnBehavior((child) => { if (child.isPowerShellCommand) child.exit(0); });
    state.config.lolPath = fakeLolPath;
    win = fx.fakeWindow({ visible });
    state.mainWindow = win;
    fx.writeAccounts(accounts || [
        { username: 'alice', password: encrypt('pw-a') },
        { username: 'bob', password: encrypt('pw-b') },
    ]);
    lcu.connected = lcuConnected;
    lcu.request = async (method, endpoint) => {
        if (endpoint === '/lol-login/v1/session') return typeof session === 'function' ? session() : session;
        if (endpoint === '/lol-gameflow/v1/gameflow-phase') return phase;
        return null;
    };
}

// Starts a launch and returns its login script once it has been spawned.
async function startUntilScript(username, opts) {
    const res = await launch.executeAccountLaunch(username, opts);
    assert.equal(res.success, true, `launch of ${username} should start: ${JSON.stringify(res)}`);
    const script = fx.loginScripts().at(-1);
    assert.ok(script, 'login script spawned');
    return script;
}

const lastStatus = () => win.statuses().at(-1);

test('a second launch while one runs is refused, from the window and from the tray', async () => {
    setup();
    let killChild;
    fx.setSpawnBehavior((child) => { if (child.isPowerShellCommand) killChild = child; });

    const first = launch.executeAccountLaunch('alice');
    await fx.waitFor(() => killChild, 'the kill command');

    assert.deepEqual(
        { ...(await launch.executeAccountLaunch('bob')), message: undefined },
        { success: false, busy: true, message: undefined });
    const fromTray = await launch.launchFromOutside('bob');
    assert.equal(fromTray.busy, true);

    killChild.exit(0);
    assert.equal((await first).success, true);
    const scripts = fx.loginScripts();
    assert.equal(scripts.length, 1, 'exactly one login script');
    assert.ok(scripts[0].args.includes('alice'));
    assert.ok(!scripts[0].args.includes('bob'));
});

test('cancel while the clients are being closed stops the launch before any credentials', async () => {
    setup();
    let killChild;
    fx.setSpawnBehavior((child) => { if (child.isPowerShellCommand) killChild = child; });

    const pending = launch.executeAccountLaunch('alice');
    await fx.waitFor(() => killChild, 'the kill command');
    assert.deepEqual(launch.cancelLaunch(), { success: true });
    assert.equal(lastStatus(), null, 'cancel clears the overlay');
    const sentAfterCancel = win.sent.length;

    killChild.exit(0);
    assert.equal((await pending).cancelled, true);
    assert.equal(fx.loginScripts().length, 0, 'no login script after cancel');
    assert.equal(fx.spawned.filter(c => c.command !== 'powershell.exe').length, 0, 'no Riot Client started');
    assert.equal(win.sent.length, sentAfterCancel, 'nothing sent after cancel');

    // And the next launch is not blocked by the cancelled one.
    fx.setSpawnBehavior((child) => { if (child.isPowerShellCommand) child.exit(0); });
    await startUntilScript('bob');
});

test('cancel while the login script runs kills it and reports nothing afterwards', async () => {
    setup();
    const script = await startUntilScript('alice');
    assert.deepEqual(await fx.invoke('cancel-launch'), { success: true });
    assert.equal(script.killed, true);
    await fx.waitFor(() => script.listenerCount('close') && script.exited, 'the script to close');
    await fx.tick();
    assert.equal(lastStatus(), null);
    assert.ok(!win.statuses().some(s => s?.error || s?.progress === 100));
    assert.deepEqual(launch.cancelLaunch(), { success: false, message: 'No launch in progress' });
});

test('the password reaches the script as base64 UTF-8 on stdin, never in argv', async () => {
    const password = 'pä§wörd€ "x" & y';
    setup({ accounts: [{ username: 'alice', password: encrypt(password) }] });
    const script = await startUntilScript('alice');
    assert.equal(script.stdinData.endsWith('\n'), true);
    assert.equal(Buffer.from(script.stdinData.trim(), 'base64').toString('utf8'), password);
    assert.ok(!script.args.some(a => String(a).includes('wörd')));
    const nb = script.args[script.args.indexOf('-NotBefore') + 1];
    assert.match(nb, /^\d{13}$/, 'start time passed for the window check');
    assert.equal(script.options.windowsHide, true);
});

test('a different signed-in account is reported instead of Done', async () => {
    setup({ lcuConnected: true, session: { username: 'someoneelse' } });
    const script = await startUntilScript('alice');
    script.exit(0);
    await fx.waitFor(() => lastStatus()?.error, 'an error status');
    assert.equal(lastStatus().kind, 'wrong-account');
    assert.match(lastStatus().message, /someoneelse/);
    assert.ok(!win.statuses().some(s => s?.progress === 100));
});

test('the right signed-in account ends in Done with one 100 % status', async () => {
    setup();
    const script = await startUntilScript('alice');
    script.print('League client detected - done!\r\nLogin script complete\r\n');
    lcu.connected = true;
    lcu.request = async (m, ep) => (ep === '/lol-login/v1/session' ? { username: 'ALICE' } : null);
    script.exit(0);
    await fx.waitFor(() => lastStatus()?.kind === 'done', 'done');
    assert.equal(win.statuses().filter(s => s?.progress === 100).length, 1);
    assert.equal(fx.notifications.length, 1);
    assert.equal(launch.isLaunchInProgress(), false);
});

test('exit code 3 is not reported as logged in and offers a retry', async () => {
    setup();
    const script = await startUntilScript('alice');
    script.exit(3);
    await fx.waitFor(() => lastStatus()?.error, 'an error status');
    assert.equal(lastStatus().kind, 'needs-action');
    assert.doesNotMatch(lastStatus().message, /Logged in/i);
});

test('exit code 3 with a signed-out Riot Client says the sign-in did not complete', async (t) => {
    setup();
    const server = http.createServer((req, res) => {
        res.statusCode = req.url === '/rso-auth/v1/authorization' ? 404 : 500;
        res.end('{}');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    t.after(() => server.close());
    const lockDir = path.join(process.env.LOCALAPPDATA, 'Riot Games', 'Riot Client', 'Config');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'lockfile'), `Riot Client:1:${server.address().port}:secret:http`);
    t.after(() => fs.rmSync(path.join(lockDir, 'lockfile'), { force: true }));

    const script = await startUntilScript('alice');
    script.exit(3);
    await fx.waitFor(() => lastStatus()?.error, 'an error status');
    assert.match(lastStatus().message, /Sign-in did not complete/);
});

test('with minimize on launch, a failed login brings the window back and notifies', async () => {
    setup({ accounts: [{ username: 'alice', password: encrypt('x'), minimizeOnLaunch: true }] });
    const script = await startUntilScript('alice');
    assert.equal(win.counts.hide, 1);
    assert.equal(launch.isWindowHiddenByLaunch(), true);
    script.exit(2);
    await fx.waitFor(() => lastStatus()?.error, 'an error status');
    assert.equal(win.visible, true);
    assert.ok(win.counts.show >= 1);
    assert.equal(fx.notifications.length, 1);
    assert.match(fx.notifications[0].body, /front/);
});

test('a login script killed from outside is a failure, not success', async () => {
    setup();
    const script = await startUntilScript('alice');
    script.exit(null, 'SIGTERM');
    await fx.waitFor(() => lastStatus()?.error, 'an error status');
    assert.match(lastStatus().message, /interrupted/);
    assert.equal(fx.notifications.length, 0, 'visible window: no notification');
});

test('a login script that cannot start is reported, and the next launch works', async () => {
    setup();
    const script = await startUntilScript('alice');
    script.emit('error', Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' }));
    script.stdin.emit('error', new Error('EPIPE'));
    assert.equal(lastStatus().error, true);
    assert.equal(launch.isLaunchInProgress(), false);
    await startUntilScript('bob');
});

test('a Riot Client that fails to start ends the launch with an error', async () => {
    setup();
    const script = await startUntilScript('alice');
    const rc = fx.spawned.find(c => c.command !== 'powershell.exe');
    rc.emit('error', Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    assert.equal(lastStatus().error, true);
    assert.match(lastStatus().message, /EACCES/);
    assert.equal(script.killed, true, 'login script stopped');
});

test('all client processes are closed and gone before the Riot Client starts', async () => {
    setup();
    let killChild;
    fx.setSpawnBehavior((child) => { if (child.isPowerShellCommand) killChild = child; });
    const pending = launch.executeAccountLaunch('alice');
    await fx.waitFor(() => killChild, 'the kill command');
    const command = killChild.args.at(-1);
    for (const name of ['LeagueClient', 'LeagueClientUxRender', 'RiotClientServices', 'Riot Client', 'RiotClientUx']) {
        assert.ok(command.includes(`'${name}'`), `kills ${name}`);
    }
    assert.match(command, /for \(\$i = 0/, 'waits for the processes to exit');
    assert.equal(killChild.options.windowsHide, true);
    await fx.tick();
    assert.equal(fx.spawned.length, 1, 'nothing else starts before the kill finished');
    killChild.exit(0);
    await pending;
    assert.ok(fx.spawned.some(c => c.command !== 'powershell.exe'), 'Riot Client started after');
});

test('launching another account during a game asks first', async () => {
    setup({ lcuConnected: true, session: { username: 'bob' }, phase: 'InProgress' });
    const res = await launch.executeAccountLaunch('alice');
    assert.equal(res.needsConfirm, true);
    assert.equal(fx.spawned.length, 0, 'nothing killed');
    assert.equal(launch.isLaunchInProgress(), false);
    await startUntilScript('alice', { confirmed: true });
});

test('while the vault is locked nothing launches, the tray path shows the lock screen', async () => {
    setup({ visible: false });
    fx.fakeVault.locked = true;
    assert.deepEqual(await launch.executeAccountLaunch('alice'),
        { success: false, locked: true, message: 'Vault is locked' });
    const res = await launch.launchFromOutside('alice');
    assert.equal(res.locked, true);
    assert.equal(win.visible, true);
    assert.equal(fx.spawned.length, 0);
    assert.equal(win.sent.length, 0);
});

test('a tray launch of a minimize-on-launch account does not show the window', async () => {
    setup({ visible: false, accounts: [{ username: 'alice', password: encrypt('x'), minimizeOnLaunch: true }] });
    await launch.launchFromOutside('alice');
    assert.equal(win.counts.show, 0);
});

test('a tray launch that cannot start shows the error', async () => {
    setup({ visible: false });
    const res = await launch.launchFromOutside('nobody');
    assert.equal(res.success, false);
    assert.equal(win.visible, true);
    assert.equal(lastStatus().error, true, 'the overlay shows the error');
    assert.equal(fx.notifications.length, 1, 'the window was hidden: notify too');
    assert.match(fx.notifications[0].body, /not found/);
});

test('progress follows the script line by line, ignores other lines and never goes back', async () => {
    setup();
    const script = await startUntilScript('alice');
    const before = win.statuses().length;
    script.print('Found window: \'Riot Client\' - wait');
    script.print('ing for UI to load...\r\nRiot Client window focused\r\nCredentials submitted\r\n');
    script.print('Transcript started, output file is x\r\nERROR: something\r\nWaiting for Riot Client window...\r\n');
    const got = win.statuses().slice(before);
    assert.deepEqual(got.map(s => s.progress), [65, 80]);
    assert.ok(!got.some(s => /Logging in/.test(s.message)));
});

test('statusForLine maps script lines and ignores unknown ones', () => {
    assert.equal(launch.statusForLine('Polling for League client launch...').progress, 82);
    assert.equal(launch.statusForLine('Login script complete'), null, 'only the close handler reports 100');
    assert.equal(launch.statusForLine('ERROR: Lost focus'), null);
});

test('verifyLoggedInAccount compares usernames case-insensitively', () => {
    assert.deepEqual(launch.verifyLoggedInAccount('Alice', { username: 'alice' }), { ok: true });
    assert.deepEqual(launch.verifyLoggedInAccount('alice', { username: 'bob' }), { ok: false, actual: 'bob' });
    assert.deepEqual(launch.verifyLoggedInAccount('alice', null), { ok: null });
});
