const { userData, invoke } = require('./helpers/fake-electron');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const lcu = require('../src/main/lcu');
const riotApi = require('../src/main/services/riot-api');
const opgg = require('../src/main/services/opgg-api');
const championData = require('../src/main/services/champion-data');
require('../src/main/ipc/stats').register();

const OPGG_STATS = { success: true, tier: 'Gold II', lp: '57 LP', source: 'opgg', riotId: 'Name#TAG', gameName: 'Name' };
const RIOT_STATS = { success: true, tier: 'Gold II', lp: '57 LP', source: 'riot-api' };

let apiKey = '';

function writeAccounts(accounts) {
    fs.writeFileSync(path.join(userData, 'accounts.json'), JSON.stringify(accounts));
}

function readAccounts() {
    return JSON.parse(fs.readFileSync(path.join(userData, 'accounts.json'), 'utf8'));
}

function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}

// Fakes a running League client on `server` (region-locale value) that knows
// the summoner and reports Platinum IV for it.
function fakeClient(t, server) {
    lcu.connected = true;
    return t.mock.method(lcu, 'request', async (method, url) => {
        if (url === '/riotclient/region-locale') return { region: server };
        if (url.startsWith('/lol-summoner/v2/summoners/by-riot-id/')) return { puuid: 'p1', profileIconId: 1, summonerLevel: 100 };
        if (url.startsWith('/lol-ranked/v1/ranked-stats/')) {
            return { RANKED_SOLO_5x5: { tier: 'PLATINUM', division: 'IV', leaguePoints: 12, wins: 1, losses: 1 } };
        }
        return null;
    });
}

test.beforeEach((t) => {
    writeAccounts([]);
    apiKey = '';
    riotApi._resetForTests();
    t.mock.method(riotApi, 'getApiKey', () => apiKey);
    t.mock.method(championData, 'whenReady', async () => {});
});

test.afterEach(() => {
    lcu.connected = false;
    // A disconnect forgets the client's region.
    for (const handler of lcu.disconnectHandlers) handler();
});

test('without a Riot API key, stats come from OP.GG', async (t) => {
    const riot = t.mock.method(riotApi, 'getStats', async () => RIOT_STATS);
    t.mock.method(opgg, 'getProfile', async () => OPGG_STATS);
    const res = await invoke('get-stats', { region: 'euw', riotId: 'Name#TAG' });
    assert.equal(res.source, 'opgg');
    assert.equal(riot.mock.callCount(), 0);
});

test('with a key, the Riot API goes first', async (t) => {
    apiKey = 'RGAPI-test';
    t.mock.method(riotApi, 'getStats', async () => RIOT_STATS);
    const op = t.mock.method(opgg, 'getProfile', async () => OPGG_STATS);
    const res = await invoke('get-stats', { region: 'euw', riotId: 'Name#TAG' });
    assert.equal(res.source, 'riot-api');
    assert.equal(op.mock.callCount(), 0);
});

test('an expired key falls back to OP.GG', async (t) => {
    apiKey = 'RGAPI-expired';
    t.mock.method(riotApi, 'getStats', async () => { throw new Error('Invalid or expired Riot API key — update it in Settings'); });
    t.mock.method(opgg, 'getProfile', async () => OPGG_STATS);
    const res = await invoke('get-stats', { region: 'euw', riotId: 'Name#TAG' });
    assert.equal(res.source, 'opgg');
});

test('when every source fails, the last known stats are shown with the error', async (t) => {
    writeAccounts([{ username: 'u', riotId: 'Name#TAG', region: 'euw', _cachedStats: { tier: 'Silver I', lp: '10 LP', region: 'euw', ts: Date.now() - 2 * 60 * 60 * 1000 } }]);
    t.mock.method(opgg, 'getProfile', async () => { throw new Error('OP.GG: down'); });
    const res = await invoke('get-stats', { region: 'euw', riotId: 'Name#TAG' });
    assert.equal(res.tier, 'Silver I');
    assert.equal(res.stale, true);
    assert.equal(res.error, 'OP.GG: down');
});

test('fresh stats are cached on every account with that Riot ID', async (t) => {
    writeAccounts([{ username: 'u', riotId: 'Name#TAG' }]);
    t.mock.method(opgg, 'getProfile', async () => OPGG_STATS);
    await invoke('get-stats', { region: 'euw', riotId: 'Name#TAG' });
    const saved = readAccounts();
    assert.equal(saved[0]._cachedStats.tier, 'Gold II');
    assert.equal(saved[0]._cachedStats.region, 'euw');
});

test('identical concurrent get-stats calls share one lookup', async (t) => {
    apiKey = 'RGAPI-test';
    const gate = deferred();
    const riot = t.mock.method(riotApi, 'getStats', () => gate.promise);
    const calls = [1, 2, 3].map(() => invoke('get-stats', { region: 'euw', riotId: 'Name#TAG' }));
    // Same account from the quick-add form at the same time.
    const quick = invoke('lookup-summoner', { input: 'name#tag', region: 'EUW' });
    // Let every call reach its lookup before the first one finishes.
    await new Promise(r => setImmediate(r));
    gate.resolve(RIOT_STATS);
    const results = await Promise.all(calls);
    await quick;
    assert.equal(riot.mock.callCount(), 1);
    for (const r of results) assert.equal(r.source, 'riot-api');
});

test('a finished lookup is not reused for the next forced refresh', async (t) => {
    let n = 0;
    t.mock.method(opgg, 'getProfile', async () => {
        n++;
        if (n === 1) throw new Error('OP.GG: down');
        return OPGG_STATS;
    });
    const first = await invoke('get-stats', { region: 'euw', riotId: 'Name#TAG', force: true });
    assert.equal(first.tier, 'N/A');
    const second = await invoke('get-stats', { region: 'euw', riotId: 'Name#TAG', force: true });
    assert.equal(second.tier, 'Gold II');
});

test('cached stats of another region are never served, not even as stale data', async (t) => {
    writeAccounts([{ username: 'u', riotId: 'Name#TAG', region: 'na', _cachedStats: { tier: 'Diamond I', lp: '1 LP', region: 'euw', ts: Date.now() } }]);
    const op = t.mock.method(opgg, 'getProfile', async () => { throw new Error('OP.GG: down'); });
    const res = await invoke('get-stats', { region: 'na', riotId: 'Name#TAG' });
    assert.equal(op.mock.callCount(), 1, 'the EUW cache must not count as fresh');
    assert.equal(res.tier, 'N/A');
    assert.notEqual(res.stale, true);
});

test('the cache matches Riot IDs case-insensitively', async (t) => {
    writeAccounts([{ username: 'u', riotId: 'name#tag', region: 'euw', _cachedStats: { tier: 'Silver I', lp: '10 LP', region: 'euw', ts: Date.now() } }]);
    const op = t.mock.method(opgg, 'getProfile', async () => OPGG_STATS);
    const res = await invoke('get-stats', { region: 'EUW', riotId: 'Name#TAG' });
    assert.equal(res.source, 'cache');
    assert.equal(op.mock.callCount(), 0);
});

test('a cache entry from the future (clock was ahead) is not treated as fresh', async (t) => {
    writeAccounts([{ username: 'u', riotId: 'Name#TAG', region: 'euw', _cachedStats: { tier: 'Silver I', region: 'euw', ts: Date.now() + 24 * 60 * 60 * 1000 } }]);
    t.mock.method(opgg, 'getProfile', async () => OPGG_STATS);
    const res = await invoke('get-stats', { region: 'euw', riotId: 'Name#TAG' });
    assert.equal(res.source, 'opgg');
});

test('the League client is not asked about accounts on another server', async (t) => {
    const req = fakeClient(t, 'NA1');
    t.mock.method(opgg, 'getProfile', async () => OPGG_STATS);
    const res = await invoke('get-stats', { region: 'euw', riotId: 'Name#TAG' });
    assert.equal(res.source, 'opgg');
    assert.ok(!req.mock.calls.some(c => c.arguments[1].startsWith('/lol-ranked/')), 'ranked endpoint must not be called');
});

test('the League client is used for accounts on its own server', async (t) => {
    fakeClient(t, 'EUW1');
    const op = t.mock.method(opgg, 'getProfile', async () => OPGG_STATS);
    const res = await invoke('get-stats', { region: 'euw', riotId: 'Name#TAG' });
    assert.equal(res.source, 'lcu');
    assert.equal(res.tier, 'Platinum IV');
    assert.equal(op.mock.callCount(), 0);
});

test('stats from the League client keep the champion badges found online', async (t) => {
    const mastery = [{ name: 'Ahri', icon: null, points: 1000, level: 7 }];
    const top = [{ name: 'Yone', icon: null, games: 10, wins: 6 }];
    writeAccounts([{ username: 'u', riotId: 'Name#TAG', region: 'euw', _cachedStats: { tier: 'Gold II', region: 'euw', masteryChampions: mastery, topChampions: top, ts: Date.now() } }]);
    fakeClient(t, 'EUW1');
    const res = await invoke('get-stats', { region: 'euw', riotId: 'Name#TAG' });
    assert.equal(res.source, 'lcu');
    assert.deepEqual(res.masteryChampions, mastery);
    assert.deepEqual(res.topChampions, top);
    const saved = readAccounts()[0]._cachedStats;
    assert.equal(saved.tier, 'Platinum IV');
    assert.deepEqual(saved.masteryChampions, mastery);
    assert.deepEqual(saved.topChampions, top);
});

test('quick add: an OP.GG link brings its own region', async (t) => {
    const op = t.mock.method(opgg, 'getProfile', async () => OPGG_STATS);
    const res = await invoke('lookup-summoner', { input: 'https://op.gg/lol/summoners/kr/Name-TAG', region: 'euw' });
    assert.equal(res.success, true);
    assert.equal(res.region, 'kr');
    assert.deepEqual(op.mock.calls[0].arguments, ['Name', 'TAG', 'kr']);
});

test('quick add: helpful errors for bad input and CN', async () => {
    assert.match((await invoke('lookup-summoner', { input: 'NoTag', region: 'euw' })).message, /Name#TAG/);
    assert.match((await invoke('lookup-summoner', { input: 'Name#TAG', region: '' })).message, /region/);
    assert.match((await invoke('lookup-summoner', { input: 'Name#TAG', region: 'cn' })).message, /manually/);
});

test('match history falls back to OP.GG without a key', async (t) => {
    t.mock.method(opgg, 'getRecentMatches', async () => [{ win: true, kda: '1/2/3', championIcon: null }]);
    const res = await invoke('get-match-history', { region: 'euw', riotId: 'Name#TAG' });
    assert.equal(res.matches.length, 1);
});

test('match history falls back to OP.GG when match details are rate limited', async (t) => {
    apiKey = 'RGAPI-test';
    t.mock.method(axios, 'get', async (url) => {
        if (url.includes('/riot/account/v1/')) return { data: { puuid: 'puuid-0123456789' }, headers: {} };
        if (url.includes('/ids?')) return { data: ['M_1', 'M_2'], headers: {} };
        const err = new Error('Request failed with status code 429');
        err.response = { status: 429, headers: { 'retry-after': '20' } };
        throw err;
    });
    const op = t.mock.method(opgg, 'getRecentMatches', async () => [{ win: false, kda: '0/1/0', championIcon: null }]);
    const res = await invoke('get-match-history', { region: 'euw', riotId: 'Name#TAG' });
    assert.equal(op.mock.callCount(), 1);
    assert.equal(res.matches.length, 1);
    assert.equal(res.matches[0].kda, '0/1/0');
});

test('Riot match history icons come from the champion id', async (t) => {
    apiKey = 'RGAPI-test';
    t.mock.method(championData, 'getIdToNameMap', () => ({ 9: 'Fiddlesticks' }));
    t.mock.method(championData, 'getIdToImageMap', () => ({ Fiddlesticks: 'https://example.test/Fiddlesticks.png' }));
    t.mock.method(riotApi, 'getAccountByRiotId', async () => ({ account: { puuid: 'p' }, platform: 'euw1' }));
    t.mock.method(riotApi, 'getMatchHistory', async () => [{ win: true, kda: '1/2/3', championId: 9, championName: 'FiddleSticks' }]);
    const res = await invoke('get-match-history', { region: 'euw', riotId: 'Name#TAG' });
    assert.equal(res.matches[0].championIcon, 'https://example.test/Fiddlesticks.png');
    assert.equal(res.matches[0].championName, 'Fiddlesticks');
});
