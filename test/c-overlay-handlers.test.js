const { invoke } = require('./helpers/fake-electron');
const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const lcu = require('../src/main/lcu');
const riotApi = require('../src/main/services/riot-api');
const opgg = require('../src/main/services/opgg-api');
require('../src/main/ipc/overlay-handlers').register();

// A client on `server` that doesn't know any lobby player yet.
function fakeClient(t, server, extra = () => undefined) {
    lcu.connected = true;
    return t.mock.method(lcu, 'request', async (method, url) => {
        const res = extra(url);
        if (res !== undefined) return res;
        if (url === '/riotclient/region-locale') return { region: server };
        return null;
    });
}

test.beforeEach((t) => {
    riotApi._resetForTests();
    opgg._resetForTests();
    t.mock.method(riotApi, 'getApiKey', () => 'RGAPI-test');
});

test.afterEach(() => {
    lcu.connected = false;
    for (const handler of lcu.disconnectHandlers) handler();
});

// PBE and other unmapped servers silently fell back to EUW lookups.
test('lobby players on a server the online sources do not cover are marked failed without a request', async (t) => {
    fakeClient(t, 'PBE');
    const get = t.mock.method(axios, 'get', async () => { throw new Error('no network in tests'); });
    const post = t.mock.method(axios, 'post', async () => { throw new Error('no network in tests'); });
    const res = await invoke('overlay-get-ranked-bulk', [{ gameName: 'Name', tagLine: 'TAG' }]);
    assert.equal(res['Name#TAG'].failed, true);
    assert.equal(get.mock.callCount(), 0);
    assert.equal(post.mock.callCount(), 0);
});

test('a lobby player costs two Riot API requests (account and league), not four', async (t) => {
    fakeClient(t, 'EUW1');
    const get = t.mock.method(axios, 'get', async (url) => {
        if (url.includes('/riot/account/v1/')) return { data: { puuid: 'puuid-0123456789' }, headers: {} };
        if (url.includes('/league/v4/')) return { data: [{ queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'II', leaguePoints: 57, wins: 1, losses: 1 }], headers: {} };
        throw new Error(`unexpected ${url}`);
    });
    const res = await invoke('overlay-get-ranked-bulk', [{ gameName: 'Name', tagLine: 'TAG' }]);
    assert.equal(res['Name#TAG'].tier, 'Gold II');
    assert.equal(get.mock.callCount(), 2);
    assert.ok(get.mock.calls[0].arguments[0].startsWith('https://europe.api.riotgames.com/'));
});

test('without a key, lobby players are looked up on OP.GG', async (t) => {
    t.mock.method(riotApi, 'getApiKey', () => '');
    fakeClient(t, 'NA1');
    const prof = t.mock.method(opgg, 'getProfile', async () => ({ tier: 'Silver I', lp: '5 LP', winLose: '1W 0L', ratio: '100%' }));
    const res = await invoke('overlay-get-ranked-bulk', [{ gameName: 'Name', tagLine: 'TAG' }]);
    assert.equal(res['Name#TAG'].tier, 'Silver I');
    assert.deepEqual(prof.mock.calls[0].arguments, ['Name', 'TAG', 'na']);
});

// activeplayer has no gameTime; the in-game clock never showed.
test('the live view gets the game clock from gamestats and HP from activeplayer', async (t) => {
    fakeClient(t, 'EUW1', (url) => (url === '/lol-gameflow/v1/gameflow-phase' ? 'InProgress' : undefined));
    t.mock.method(axios, 'get', async (url) => {
        if (url.endsWith('/liveclientdata/activeplayer')) return { data: { championStats: { currentHealth: 500, maxHealth: 900 } } };
        if (url.endsWith('/liveclientdata/gamestats')) return { data: { gameTime: 754.2, gameMode: 'CLASSIC' } };
        throw new Error(`unexpected ${url}`);
    });
    const res = await invoke('get-lcu-overview');
    assert.equal(res.connected, true);
    assert.equal(res.liveGame.gameTime, 754.2);
    assert.equal(res.liveGame.championStats.currentHealth, 500);
});
