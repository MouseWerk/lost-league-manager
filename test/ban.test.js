// Issue #12: the remaining suspension time of a banned account. The Riot
// Client reports the ban at sign-in; it can also be entered by hand.
const fx = require('./helpers/a-fakes');
const { fakeElectron, invoke } = require('./helpers/fake-electron');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const state = require('../src/main/state');
const lcu = require('../src/main/lcu');
const { encrypt } = require('../src/main/services/encryption');
const status = require('../src/main/services/account-status');
const sessions = require('../src/main/services/riot-sessions');
const launch = require('../src/main/ipc/launch');
const { statusWarnings, timeLeft, effectiveBan } = require('../src/renderer/js/ui-lib.js');

launch.register();
require('../src/main/ipc/accounts').register();

const HOUR = 3600000;
const NOW = Date.UTC(2026, 10, 3, 12);

test('a time ban and a permanent ban are read from the user info, other restrictions are not', () => {
    const until = NOW + 30 * HOUR;
    const info = { sub: 'x', ban: { restrictions: [
        { type: 'TEXT_CHAT_RESTRICTION', scope: 'lol', dat: { expirationMillis: NOW + 99 * HOUR } },
        { type: 'TIME_BAN', scope: 'valorant', dat: { expirationMillis: NOW + 500 * HOUR } },
        { type: 'TIME_BAN', scope: 'lol', dat: { expirationMillis: until } },
    ] } };
    assert.deepEqual(status.parseBan(info), { permanent: false, until });
    assert.deepEqual(status.parseBan(JSON.stringify(info)), { permanent: false, until }, 'as a JSON string');
    assert.deepEqual(status.parseBan({ userInfo: JSON.stringify(info) }), { permanent: false, until }, 'wrapped');
    const jwt = ['e30', Buffer.from(JSON.stringify(info)).toString('base64url'), 'sig'].join('.');
    assert.deepEqual(status.parseBan(jwt), { permanent: false, until }, 'as a token');
    assert.deepEqual(status.parseBan({ ban: { restrictions: [{ type: 'PERMANENT_BAN', scope: 'riot' }] } }), { permanent: true, until: null });
    assert.equal(status.parseBan({ ban: { restrictions: [] } }), null, 'not banned');
    assert.equal(status.parseBan({ sub: 'x' }), null, 'no ban block: not banned');
    assert.equal(status.parseBan(null), undefined, 'nothing read: unknown');
});

test('the remaining time is short and counts down', () => {
    assert.equal(timeLeft(30 * HOUR), '1d 6h');
    assert.equal(timeLeft(48 * HOUR), '2d');
    assert.equal(timeLeft(5 * HOUR + 20 * 60000), '5h 20m');
    assert.equal(timeLeft(12 * 60000), '12m');
    assert.equal(timeLeft(10), '1m');
});

test('a running ban comes first among the warnings; an expired one is gone', () => {
    const w = statusWarnings({ ban: { permanent: false, until: NOW + 30 * HOUR } }, 'Gold I', NOW);
    assert.equal(w[0].kind, 'ban');
    assert.equal(w[0].short, 'Banned 1d 6h');
    assert.equal(w[0].text, 'Suspended, 1d 6h left');
    assert.equal(w[0].urgent, true);
    assert.deepEqual(statusWarnings({ ban: { permanent: false, until: NOW - HOUR } }, 'Gold I', NOW), []);
    assert.equal(statusWarnings({ ban: { permanent: true } }, '', NOW)[0].text, 'Permanently banned');
});

test('a ban entered by hand counts until the client reports a later one', () => {
    const manual = new Date(NOW + 10 * HOUR).toISOString();
    assert.deepEqual(effectiveBan({ banUntil: manual }), { permanent: false, until: NOW + 10 * HOUR, manual: true });
    assert.equal(effectiveBan({ banUntil: manual, status: { ban: { permanent: false, until: NOW + 20 * HOUR } } }).until, NOW + 20 * HOUR);
    assert.equal(effectiveBan({ banUntil: manual, status: { ban: { permanent: true } } }).permanent, true);
    assert.equal(effectiveBan({}), null);
});

test('the hand-entered time is stored as ISO, anything else as empty', async () => {
    fx.fakeVault.locked = false;
    fx.writeAccounts([{ username: 'carol', password: encrypt('x') }]);
    await invoke('update-account', { username: 'carol', banUntil: '2026-11-05T18:00' });
    const t = fx.readAccounts()[0].banUntil;
    assert.equal(t, new Date('2026-11-05T18:00').toISOString());
    await invoke('update-account', { username: 'carol', banUntil: 'soon' });
    assert.equal(fx.readAccounts()[0].banUntil, '');
});

// ── At sign-in ───────────────────────────────────────────────────────────────

fakeElectron.safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from('DPAPI:' + Buffer.from(s, 'utf8').toString('hex')),
    decryptString: (buf) => Buffer.from(buf.toString().slice(6), 'hex').toString('utf8'),
};
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-ban-'));
process.env.ProgramData = path.join(sandbox, 'ProgramData');
process.env.LOCALAPPDATA = path.join(sandbox, 'LocalAppData');
const fakeLolPath = path.join(sandbox, 'League of Legends', 'LeagueClient.exe');
fs.mkdirSync(path.dirname(fakeLolPath), { recursive: true });
fs.writeFileSync(fakeLolPath, '');

test('signing in to a suspended account stores the ban and does not start League', async (t) => {
    launch.cancelLaunch();
    fx.spawned.length = 0;
    fx.fakeVault.locked = false;
    fx.setSpawnBehavior((child) => { if (child.isPowerShellCommand) child.exit(0); });
    state.config.lolPath = fakeLolPath;
    const win = fx.fakeWindow({ visible: true });
    state.mainWindow = win;
    fx.writeAccounts([{ username: 'alice', password: encrypt('pw') }]);
    lcu.connected = false;
    fs.rmSync(state.paths.accountStatus, { force: true });

    // A saved sign-in, so the launch goes straight to the signed-in check.
    const file = sessions.settingsFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'riot-login:\n    persist:\n        session:\n            cookies:\n            -   name: "ssid"\n                value: "s"\n');
    sessions.captureSignIn('alice');

    const until = Date.now() + 30 * HOUR;
    const calls = [];
    const server = http.createServer((req, res) => {
        calls.push(`${req.method} ${req.url}`);
        if (req.url === '/riot-client-auth/v1/userinfo') {
            res.end(JSON.stringify({ ban: { restrictions: [{ type: 'TIME_BAN', scope: 'lol', dat: { expirationMillis: until } }] } }));
        } else {
            res.end('{}');
        }
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const lockDir = path.join(process.env.LOCALAPPDATA, 'Riot Games', 'Riot Client', 'Config');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'lockfile'), `Riot Client:1:${server.address().port}:secret:http`);
    t.after(() => server.close());

    await launch.executeAccountLaunch('alice');
    await fx.waitFor(() => win.statuses().at(-1)?.error, 'an error status', 5000);
    const last = win.statuses().at(-1);
    assert.equal(last.kind, 'banned');
    assert.match(last.message, /suspended until/);
    assert.ok(!calls.some(c => c.includes('product-launcher')), 'League is not started');
    assert.equal(status.statusFor(status.getStatusMap(), 'alice').ban.until, until);
});
