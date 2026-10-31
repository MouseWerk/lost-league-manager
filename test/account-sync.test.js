const fx = require('./helpers/a-fakes');
const test = require('node:test');
const assert = require('node:assert/strict');
const state = require('../src/main/state');
const lcu = require('../src/main/lcu');
const status = require('../src/main/services/account-status');
const matches = require('../src/main/services/matches');
const rankHistory = require('../src/main/services/rank-history');
const { renameAccountRiotId } = require('../src/main/services/riot-id-rename');
const { syncWithClient } = require('../src/main/lcu-events');

function fakeLcu(routes) {
    lcu.connected = true;
    lcu.request = async (method, endpoint) => {
        const r = routes[`${method} ${endpoint}`];
        return typeof r === 'function' ? r() : (r === undefined ? null : r);
    };
}

test('wallet: Blue Essence and RP from either client answer', () => {
    assert.deepEqual(status.parseWallet({ RP: 650 }, { lol_blue_essence: 12345 }, null), { rp: 650, be: 12345 });
    assert.deepEqual(status.parseWallet(null, null, { ip: 900, rp: 0 }), { rp: 0, be: 900 });
    assert.equal(status.parseWallet(null, null, null), null);
});

test('a renamed Riot ID moves the account, its rank history and its games', () => {
    fx.writeAccounts([{ username: 'a', password: 'x', riotId: 'Old#EUW', region: 'euw', _cachedStats: { tier: 'Gold I' } }]);
    rankHistory.recordRankSnapshot('Old#EUW', 'GOLD', 'I', 10, 'lcu');
    matches.mergeMatches('Old#EUW', [{ id: 'g1', createdAt: 5, champion: 'Ahri' }]);
    assert.deepEqual(renameAccountRiotId('Old#EUW', 'New#EUW'), ['a']);
    const acc = fx.readAccounts()[0];
    assert.equal(acc.riotId, 'New#EUW');
    assert.equal(acc._cachedStats, undefined, 'stats of the old name are dropped');
    assert.equal(rankHistory.getRankHistory('New#EUW').length, 1);
    assert.equal(rankHistory.getRankHistory('Old#EUW').length, 0);
    assert.equal(matches.getStoredMatches('New#EUW').length, 1);
    assert.equal(matches.getStoredMatches('Old#EUW').length, 0);
});

test('signed in: the PUUID is kept and a changed Riot ID is followed', async () => {
    fx.writeAccounts([{ username: 'main', password: 'x', riotId: 'Before#EUW', region: 'euw' }]);
    state.mainWindow = fx.fakeWindow();
    fakeLcu({ 'GET /lol-summoner/v1/current-summoner': { gameName: 'After', tagLine: 'EUW', puuid: 'p-1' } });
    await syncWithClient('main');
    const acc = fx.readAccounts()[0];
    assert.equal(acc.puuid, 'p-1');
    assert.equal(acc.riotId, 'After#EUW');
    const sent = state.mainWindow.sent.filter((s) => s.channel === 'riot-id-changed');
    assert.deepEqual(sent[0].args[0], { usernames: ['main'], oldId: 'Before#EUW', newId: 'After#EUW' });
});

test('an account that is not saved here is offered with its Riot ID and server', async () => {
    fx.writeAccounts([]);
    state.mainWindow = fx.fakeWindow();
    fakeLcu({
        'GET /lol-summoner/v1/current-summoner': { gameName: 'Fresh', tagLine: 'EUW', puuid: 'p-2', summonerLevel: 31 },
        'GET /lol-login/v1/session': { username: 'fresh.login' },
        'GET /riotclient/region-locale': { region: 'EUW' },
    });
    await syncWithClient(null);
    const sent = state.mainWindow.sent.filter((s) => s.channel === 'unknown-account-signed-in');
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].args[0], { username: 'fresh.login', riotId: 'Fresh#EUW', region: 'euw', profileIconId: null, level: 31 });
});

test('nothing is synced while the vault is locked', async () => {
    fx.writeAccounts([{ username: 'main', password: 'x', riotId: 'Before#EUW' }]);
    state.mainWindow = fx.fakeWindow();
    fx.fakeVault.locked = true;
    fakeLcu({ 'GET /lol-summoner/v1/current-summoner': { gameName: 'After', tagLine: 'EUW', puuid: 'p-1' } });
    await syncWithClient('main');
    assert.equal(fx.readAccounts()[0].riotId, 'Before#EUW');
    fx.fakeVault.locked = false;
});
