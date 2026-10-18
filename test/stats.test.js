const { userData, invoke } = require('./helpers/fake-electron');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const state = require('../src/main/state');
const riotApi = require('../src/main/services/riot-api');
const opgg = require('../src/main/services/opgg-api');
const championData = require('../src/main/services/champion-data');
require('../src/main/ipc/stats').register();

const OPGG_STATS = { success: true, tier: 'Gold II', lp: '57 LP', source: 'opgg', riotId: 'Name#TAG', gameName: 'Name' };
const RIOT_STATS = { success: true, tier: 'Gold II', lp: '57 LP', source: 'riot-api' };

function writeAccounts(accounts) {
    fs.writeFileSync(path.join(userData, 'accounts.json'), JSON.stringify(accounts));
}

test.beforeEach((t) => {
    writeAccounts([]);
    state.config.riotApiKey = '';
    t.mock.method(championData, 'whenReady', async () => {});
});

test('without a Riot API key, stats come from OP.GG', async (t) => {
    const riot = t.mock.method(riotApi, 'getStats', async () => RIOT_STATS);
    t.mock.method(opgg, 'getProfile', async () => OPGG_STATS);
    const res = await invoke('get-stats', { region: 'euw', riotId: 'Name#TAG' });
    assert.equal(res.source, 'opgg');
    assert.equal(riot.mock.callCount(), 0);
});

test('with a key, the Riot API goes first', async (t) => {
    state.config.riotApiKey = 'RGAPI-test';
    t.mock.method(riotApi, 'getStats', async () => RIOT_STATS);
    const op = t.mock.method(opgg, 'getProfile', async () => OPGG_STATS);
    const res = await invoke('get-stats', { region: 'euw', riotId: 'Name#TAG' });
    assert.equal(res.source, 'riot-api');
    assert.equal(op.mock.callCount(), 0);
});

test('an expired key falls back to OP.GG', async (t) => {
    state.config.riotApiKey = 'RGAPI-expired';
    t.mock.method(riotApi, 'getStats', async () => { throw new Error('Invalid or expired Riot API key — update it in Settings'); });
    t.mock.method(opgg, 'getProfile', async () => OPGG_STATS);
    const res = await invoke('get-stats', { region: 'euw', riotId: 'Name#TAG' });
    assert.equal(res.source, 'opgg');
});

test('when every source fails, the last known stats are shown with the error', async (t) => {
    writeAccounts([{ username: 'u', riotId: 'Name#TAG', _cachedStats: { tier: 'Silver I', lp: '10 LP', ts: Date.now() - 2 * 60 * 60 * 1000 } }]);
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
    const saved = JSON.parse(fs.readFileSync(path.join(userData, 'accounts.json'), 'utf8'));
    assert.equal(saved[0]._cachedStats.tier, 'Gold II');
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
