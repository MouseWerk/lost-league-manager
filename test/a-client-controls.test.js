const fx = require('./helpers/a-fakes');
const test = require('node:test');
const assert = require('node:assert/strict');
const lcu = require('../src/main/lcu');
const clientControls = require('../src/main/ipc/client-controls');

clientControls.register();

function fakeLcu(routes) {
    lcu.connected = true;
    lcu.request = async (method, endpoint) => {
        const r = routes[`${method} ${endpoint}`];
        return r === undefined ? null : r;
    };
}

function reset() {
    fx.spawned.length = 0;
    fx.setSpawnBehavior((child) => { if (child.isPowerShellCommand) child.exit(0); });
}

test('dodge after champ select ended closes nothing and says so', async () => {
    reset();
    fakeLcu({ 'GET /lol-gameflow/v1/gameflow-phase': 'InProgress' });
    const res = await fx.invoke('dodge-queue');
    assert.equal(res.success, false);
    assert.match(res.message, /Champ select is over/);
    assert.equal(fx.spawned.length, 0);
});

test('dodge in champ select closes only League, hidden, and waits for it', async () => {
    reset();
    fakeLcu({ 'GET /lol-gameflow/v1/gameflow-phase': 'ChampSelect' });
    assert.deepEqual(await fx.invoke('dodge-queue'), { success: true });
    const [kill] = fx.spawned;
    assert.equal(kill.options.windowsHide, true);
    assert.ok(kill.args.at(-1).includes("'LeagueClientUxRender'"));
    assert.ok(!kill.args.at(-1).includes('RiotClient'));
});

test('a kill that cannot start is reported, not swallowed as success', async () => {
    reset();
    fx.setSpawnBehavior((child) => setImmediate(() => child.emit('error', new Error('spawn powershell.exe ENOENT'))));
    fakeLcu({ 'GET /lol-gameflow/v1/gameflow-phase': 'ChampSelect' });
    assert.equal((await fx.invoke('dodge-queue')).success, false);
    assert.equal((await fx.invoke('fix-client')).success, false);
});

test('fix client closes the Riot Client UI too', async () => {
    reset();
    assert.deepEqual(await fx.invoke('fix-client'), { success: true });
    assert.ok(fx.spawned[0].args.at(-1).includes("'Riot Client'"));
});

test('status message and profile background report a failed LCU request', async () => {
    fakeLcu({ 'GET /lol-summoner/v1/current-summoner': { gameName: 'x' } });
    assert.equal((await fx.invoke('set-status-message', 'hi')).success, false);
    assert.equal((await fx.invoke('set-profile-background', { championName: 'x', skinId: 1000 })).success, false);

    fakeLcu({
        'GET /lol-summoner/v1/current-summoner': { gameName: 'x' },
        'PUT /lol-chat/v1/me': { statusMessage: 'hi' },
        'POST /lol-summoner/v1/current-summoner/summoner-profile': '',
    });
    assert.equal((await fx.invoke('set-status-message', 'hi')).success, true);
    assert.equal((await fx.invoke('set-profile-background', { championName: 'x', skinId: 1000 })).success, true);
});
