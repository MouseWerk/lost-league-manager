// Play with Valorant selected: the same sign-in as League, then the Riot
// Client starts Valorant and says who is signed in (there is no League
// client to ask).
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

fakeElectron.safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from('DPAPI:' + Buffer.from(s, 'utf8').toString('hex')),
    decryptString: (buf) => Buffer.from(buf.toString().slice(6), 'hex').toString('utf8'),
};

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-val-'));
process.env.ProgramData = path.join(sandbox, 'ProgramData');
process.env.LOCALAPPDATA = path.join(sandbox, 'LocalAppData');
// A Riot Client install (spawn is faked: nothing starts).
const fakeRiotClient = path.join(sandbox, 'Riot Client', 'RiotClientServices.exe');
fs.mkdirSync(path.dirname(fakeRiotClient), { recursive: true });
fs.writeFileSync(fakeRiotClient, '');
fs.mkdirSync(path.join(process.env.ProgramData, 'Riot Games'), { recursive: true });
fs.writeFileSync(path.join(process.env.ProgramData, 'Riot Games', 'RiotClientInstalls.json'), JSON.stringify({ rc_default: fakeRiotClient }));

const kept = (who) => `riot-login:
    persist:
        region: "EUW"
        session:
            cookies:
            -   domain: "auth.riotgames.com"
                hostOnly: true
                name: "ssid"
                path: "/"
                value: "ssid-of-${who}"
`;
const settingsFile = () => sessions.settingsFilePath();
function writeSettings(text) {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), text);
}

// A fake Riot Client: signed in as `user`, Valorant up once it was started.
async function riotClient(t, user) {
    const calls = [];
    let valorantUp = false;
    const server = http.createServer((req, res) => {
        calls.push(`${req.method} ${req.url}`);
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/rso-auth/v1/authorization') return res.end('{}');
        if (req.url === '/riot-client-auth/v1/userinfo') return res.end(JSON.stringify({ preferred_username: user, acct: { game_name: 'Name', tag_line: 'TAG' } }));
        if (req.url === '/product-launcher/v1/products/valorant/patchlines/live') { valorantUp = true; return res.end('{}'); }
        if (req.url === '/product-session/v1/external-sessions') {
            return res.end(JSON.stringify(valorantUp ? { s: { productId: 'valorant', launchConfiguration: { arguments: [] } } } : {}));
        }
        res.statusCode = 404;
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

let win;
const lastStatus = () => win.statuses().at(-1);

function setup() {
    launch.cancelLaunch();
    fs.rmSync(state.paths.riotSessions, { force: true });
    fx.spawned.length = 0;
    fx.fakeVault.locked = false;
    fx.setSpawnBehavior((child) => { if (child.isPowerShellCommand) child.exit(0); });
    win = fx.fakeWindow({ visible: true });
    state.mainWindow = win;
    fx.writeAccounts([{ username: 'alice', password: encrypt('pw-a') }, { username: 'bob', password: encrypt('pw-b') }]);
    lcu.connected = false;
    lcu.request = async () => null;
}

test('with Valorant selected and a saved sign-in, Play starts Valorant without typing', async (t) => {
    setup();
    writeSettings(kept('alice'));
    sessions.captureSignIn('alice');
    const calls = await riotClient(t, 'alice');
    const res = await launch.executeAccountLaunch('alice', { game: 'valorant' });
    assert.equal(res.success, true);
    await fx.waitFor(() => lastStatus()?.kind === 'done', 'the launch to finish', 8000);
    assert.equal(fx.loginScripts().length, 0, 'no password typed');
    assert.ok(calls.includes('POST /product-launcher/v1/products/valorant/patchlines/live'), 'Valorant started');
    assert.ok(!calls.some((c) => c.includes('league_of_legends')), 'League not started');
    assert.ok(fx.notifications.some((n) => /Valorant Launched/.test(n.title)));
});

test('signed in as someone else, the Valorant launch stops and forgets that sign-in', async (t) => {
    setup();
    writeSettings(kept('alice'));
    sessions.captureSignIn('alice');
    await riotClient(t, 'bob');
    await launch.executeAccountLaunch('alice', { game: 'valorant' });
    await fx.waitFor(() => lastStatus()?.kind === 'wrong-account', 'the wrong-account stop', 8000);
    assert.equal(sessions.hasSignIn('alice'), false);
});

test('the login script gets the Valorant product and process', async (t) => {
    setup();
    await riotClient(t, 'alice');
    fx.setSpawnBehavior(() => {});
    await launch.executeAccountLaunch('bob', { game: 'valorant' });
    await fx.waitFor(() => fx.loginScripts().length === 1, 'the login script', 5000);
    const args = fx.loginScripts()[0].args;
    assert.equal(args[args.indexOf('-Product') + 1], 'valorant');
    assert.equal(args[args.indexOf('-GameProcess') + 1], 'VALORANT-Win64-Shipping');
    launch.cancelLaunch();
});

test('Valorant processes are closed with the Riot Client when switching accounts', () => {
    assert.ok(launch.CLIENT_PROCESS_NAMES.includes('VALORANT-Win64-Shipping'));
    assert.equal(launch.GAMES.valorant.product, 'valorant');
});
