// Sign-in without typing: the Riot Client's kept sign-in ("Stay signed in")
// is saved per account, encrypted, and put back before the next start.
const fx = require('./helpers/a-fakes');
const { fakeElectron } = require('./helpers/fake-electron');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const state = require('../src/main/state');
const lcu = require('../src/main/lcu');
const { encrypt } = require('../src/main/services/encryption');
const sessions = require('../src/main/services/riot-sessions');
const launch = require('../src/main/ipc/launch');

launch.register();

// Reversible, and the ciphertext never contains the plaintext.
fakeElectron.safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from('DPAPI:' + Buffer.from(s, 'utf8').toString('hex')),
    decryptString: (buf) => {
        const t = buf.toString();
        if (!t.startsWith('DPAPI:')) throw new Error('Error while decrypting the ciphertext');
        return Buffer.from(t.slice(6), 'hex').toString('utf8');
    },
};

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-sessions-'));
process.env.ProgramData = path.join(sandbox, 'ProgramData');
process.env.LOCALAPPDATA = path.join(sandbox, 'LocalAppData');
const fakeLolPath = path.join(sandbox, 'League of Legends', 'LeagueClient.exe');
fs.mkdirSync(path.dirname(fakeLolPath), { recursive: true });
fs.writeFileSync(fakeLolPath, '');

const kept = (who) => `psl:
    authorization:
        riot-client: null
riot-login:
    persist:
        region: "EUW"
        session:
            cookies:
            -   domain: "auth.riotgames.com"
                hostOnly: true
                name: "ssid"
                path: "/"
                value: "ssid-of-${who}"
rso-authenticator:
    tdid:
        name: "tdid"
        value: "device"
`;
const notKept = `psl:
    authorization:
        riot-client: null
riot-login:
    persist: null
rso-authenticator:
    tdid:
        name: "tdid"
        value: "device"
`;

const settingsFile = () => sessions.settingsFilePath();
function writeSettings(text) {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), text);
}
const readSettings = () => (fs.existsSync(settingsFile()) ? fs.readFileSync(settingsFile(), 'utf8') : null);

function reset() {
    fs.rmSync(state.paths.riotSessions, { force: true });
    fs.rmSync(settingsFile(), { force: true });
}

test('a kept sign-in is recognized only with a persisted ssid cookie', () => {
    assert.equal(sessions.hasKeptSignIn(kept('alice')), true);
    assert.equal(sessions.hasKeptSignIn(kept('alice').replace(/\n/g, '\r\n')), true);
    assert.equal(sessions.hasKeptSignIn(notKept), false);
    assert.equal(sessions.hasKeptSignIn(kept('alice').replace('value: "ssid-of-alice"', 'value: ""')), false);
    assert.equal(sessions.hasKeptSignIn(null), false);
});

test('the saved sign-in is encrypted and comes back for the same account only', () => {
    reset();
    writeSettings(kept('alice'));
    assert.equal(sessions.captureSignIn('Alice'), true);
    const stored = fs.readFileSync(state.paths.riotSessions, 'utf8');
    assert.doesNotMatch(stored, /ssid-of-alice/, 'never stored in plain text');
    assert.equal(sessions.hasSignIn('alice'), true);

    // Bob has none: Alice's kept sign-in is removed so the client cannot
    // sign in as Alice when Bob is launched.
    writeSettings(kept('alice'));
    assert.equal(sessions.restoreSignIn('bob'), false);
    assert.equal(readSettings(), null);

    assert.equal(sessions.restoreSignIn('alice'), true);
    assert.equal(readSettings(), kept('alice'));

    sessions.forgetSignIn('ALICE');
    assert.equal(sessions.hasSignIn('alice'), false);
});

test('nothing is saved when Stay signed in was not ticked, and other settings stay', () => {
    reset();
    writeSettings(notKept);
    assert.equal(sessions.captureSignIn('alice'), false);
    assert.equal(sessions.hasSignIn('alice'), false);
    assert.equal(sessions.restoreSignIn('alice'), false);
    assert.equal(readSettings(), notKept, 'a file without a kept sign-in is left alone');
});

// ── Launch ──────────────────────────────────────────────────────────────────

let win;
const lastStatus = () => win.statuses().at(-1);

// A fake Riot Client local API: `signedIn()` decides the auth answer.
async function riotClient(t, signedIn) {
    const calls = [];
    const server = http.createServer((req, res) => {
        calls.push(`${req.method} ${req.url}`);
        if (req.url === '/rso-auth/v1/authorization') {
            res.statusCode = signedIn() ? 200 : 404;
        } else {
            res.statusCode = 200;
        }
        res.end('{}');
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const lockDir = path.join(process.env.LOCALAPPDATA, 'Riot Games', 'Riot Client', 'Config');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'lockfile'), `Riot Client:1:${server.address().port}:secret:http`);
    t.after(() => {
        server.close();
        fs.rmSync(path.join(lockDir, 'lockfile'), { force: true });
    });
    return calls;
}

function setup({ session = null } = {}) {
    launch.cancelLaunch();
    reset();
    fx.spawned.length = 0;
    fx.notifications.length = 0;
    fx.fakeVault.locked = false;
    fx.setSpawnBehavior((child) => { if (child.isPowerShellCommand) child.exit(0); });
    state.config.lolPath = fakeLolPath;
    win = fx.fakeWindow({ visible: true });
    state.mainWindow = win;
    fx.writeAccounts([
        { username: 'alice', password: encrypt('pw-a') },
        { username: 'bob', password: encrypt('pw-b') },
    ]);
    lcu.connected = false;
    lcu.request = async (method, endpoint) => {
        if (endpoint === '/lol-login/v1/session') return typeof session === 'function' ? session() : session;
        if (endpoint === '/lol-gameflow/v1/gameflow-phase') return 'None';
        return null;
    };
}

test('with a saved sign-in, Play signs in without typing and starts League', async (t) => {
    setup();
    writeSettings(kept('alice'));
    sessions.captureSignIn('alice');
    writeSettings(kept('bob')); // the client was last signed in as Bob

    const calls = await riotClient(t, () => true);
    lcu.request = async (method, endpoint) => {
        if (endpoint === '/lol-login/v1/session') return { username: 'alice' };
        return null;
    };
    const res = await launch.executeAccountLaunch('alice');
    assert.equal(res.success, true);
    lcu.connected = true;
    await fx.waitFor(() => lastStatus()?.kind === 'done', 'the launch to finish', 5000);

    assert.equal(fx.loginScripts().length, 0, 'no password typed');
    assert.ok(calls.includes('POST /product-launcher/v1/products/league_of_legends/patchlines/live'), 'League started');
    assert.match(readSettings(), /ssid-of-alice/, "Alice's sign-in was put in place");
});

test('an expired saved sign-in is dropped and the password is typed instead', async (t) => {
    setup();
    writeSettings(kept('alice'));
    sessions.captureSignIn('alice');
    await riotClient(t, () => false);
    const before = launch.SIGNIN_TIMEOUTS.saved;
    launch.SIGNIN_TIMEOUTS.saved = 300;
    t.after(() => { launch.SIGNIN_TIMEOUTS.saved = before; });

    await launch.executeAccountLaunch('alice');
    await fx.waitFor(() => fx.loginScripts().length === 1, 'the login script', 5000);
    assert.equal(sessions.hasSignIn('alice'), false, 'the expired copy is forgotten');
});

test('a saved sign-in of the wrong account is never used again', async (t) => {
    setup();
    writeSettings(kept('alice'));
    sessions.captureSignIn('alice');
    await riotClient(t, () => true);
    lcu.request = async (method, endpoint) => (endpoint === '/lol-login/v1/session' ? { username: 'bob' } : null);
    await launch.executeAccountLaunch('alice');
    lcu.connected = true;
    await fx.waitFor(() => lastStatus()?.error, 'an error status', 5000);
    assert.equal(lastStatus().kind, 'wrong-account');
    assert.equal(sessions.hasSignIn('alice'), false);
});

test('a typed login keeps the sign-in when Stay signed in was ticked', async () => {
    setup({ session: { username: 'alice' } });
    const res = await launch.executeAccountLaunch('alice');
    assert.equal(res.success, true);
    const script = fx.loginScripts().at(-1);
    writeSettings(kept('alice')); // the user ticked "Stay signed in"
    lcu.connected = true;
    script.exit(0);
    await fx.waitFor(() => lastStatus()?.kind === 'done', 'the launch to finish', 5000);
    assert.equal(sessions.hasSignIn('alice'), true);
});

test('Sign in yourself clears the kept sign-in, waits for the user and saves theirs', async (t) => {
    setup();
    writeSettings(kept('bob'));
    let signedIn = false;
    await riotClient(t, () => signedIn);
    lcu.request = async (method, endpoint) => (endpoint === '/lol-login/v1/session' ? { username: 'alice' } : null);

    const res = await launch.executeAccountLaunch('alice', { manual: true });
    assert.equal(res.success, true);
    assert.equal(readSettings(), null, "Bob's sign-in is not reused");
    assert.match(lastStatus().message, /Stay signed in/);
    assert.equal(fx.loginScripts().length, 0, 'nothing is typed');

    writeSettings(kept('alice'));
    signedIn = true;
    lcu.connected = true;
    await fx.waitFor(() => lastStatus()?.kind === 'done', 'the launch to finish', 5000);
    assert.equal(sessions.hasSignIn('alice'), true);
});

test('deleting an account forgets its saved sign-in', async () => {
    reset();
    fx.writeAccounts([{ username: 'alice', password: encrypt('x') }]);
    writeSettings(kept('alice'));
    sessions.captureSignIn('alice');
    require('../src/main/ipc/accounts').register();
    const { invoke } = require('./helpers/fake-electron');
    const accounts = await invoke('get-accounts');
    assert.equal(accounts[0].savedSignIn, true);
    await invoke('delete-account', 'alice');
    assert.equal(sessions.hasSignIn('alice'), false);
});
