const { invoke } = require('./helpers/fake-electron');
const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const lcu = require('../src/main/lcu');
const lobbyCheck = require('../src/main/ipc/lobby-check');
const { opggMultisearchUrl } = require('../src/main/ipc/client-controls');
const { LIVE_CLIENT_BASE } = require('../src/main/services/live-client');
lobbyCheck.register();

test.afterEach(() => {
    lcu.connected = false;
    for (const handler of lcu.disconnectHandlers) handler();
});

test('lobby members with names are listed, the local player marked', () => {
    const players = lobbyCheck.playersFromLobby({ members: [
        { gameName: 'Nightfall', tagLine: 'EUW', puuid: 'p1' },
        { gameName: 'Quietstep', tagLine: 'EUW', puuid: 'p2' },
        { puuid: 'p3' },
    ] }, 'p2');
    assert.deepEqual(players.map(p => [p.gameName, p.isSelf]), [['Nightfall', false], ['Quietstep', true]]);
});

// Ranked champion select hides teammates' names; they must stay hidden.
test('hidden champion select players stay hidden', () => {
    const session = { localPlayerCellId: 1, myTeam: [
        { cellId: 0, puuid: '', obfuscatedPuuid: 'x', nameVisibilityType: 'HIDDEN' },
        { cellId: 1, puuid: 'me', nameVisibilityType: 'VISIBLE' },
        { cellId: 2, puuid: 'p2', nameVisibilityType: 'HIDDEN' },
        { cellId: 3, puuid: 'p3', nameVisibilityType: 'VISIBLE' },
    ] };
    const names = { me: { gameName: 'Me', tagLine: 'EUW' }, p2: { gameName: 'Secret', tagLine: 'EUW' }, p3: { gameName: 'Shown', tagLine: 'EUW' } };
    const players = lobbyCheck.playersFromChampSelect(session, names, 'me');
    assert.deepEqual(players.map(p => p.hidden ? 'hidden' : p.gameName), ['hidden', 'Me', 'hidden', 'Shown']);
    assert.equal(players[1].isSelf, true);
});

test('in game, players are split into your team and the enemy team', () => {
    const list = [
        { riotId: 'Me#EUW', riotIdGameName: 'Me', riotIdTagLine: 'EUW', team: 'ORDER', championName: 'Ahri' },
        { riotId: 'Ally#EUW', riotIdGameName: 'Ally', riotIdTagLine: 'EUW', team: 'ORDER', championName: 'Jinx' },
        { riotId: 'Foe#KR1', riotIdGameName: 'Foe', riotIdTagLine: 'KR1', team: 'CHAOS', championName: 'Zed' },
    ];
    const players = lobbyCheck.playersFromLiveGame(list, 'me#euw');
    assert.deepEqual(players.map(p => [p.gameName, p.team, p.isSelf]), [['Me', 'mine', true], ['Ally', 'mine', false], ['Foe', 'enemy', false]]);
});

test('the OP.GG multi-search link holds valid Riot IDs only', () => {
    assert.equal(opggMultisearchUrl('euw', ['A#EUW', 'B c#1234']),
        'https://www.op.gg/lol/multisearch/euw?summoners=A%23EUW%2CB%20c%231234');
    assert.equal(opggMultisearchUrl('euw', ['no-tag', 'x#y#z']), null);
    assert.equal(opggMultisearchUrl('mars', ['A#EUW']), null);
    assert.equal(opggMultisearchUrl('euw', 'A#EUW'), null);
});

// Riot's live client API is HTTPS only; the http URL never answered.
test('the live client API is called over HTTPS', () => {
    assert.match(LIVE_CLIENT_BASE, /^https:\/\/127\.0\.0\.1:2999\//);
});

test('get-lobby-check ranks the visible players of the lobby', async (t) => {
    lcu.connected = true;
    t.mock.method(lcu, 'request', async (method, url) => {
        if (url === '/lol-gameflow/v1/gameflow-phase') return 'Lobby';
        if (url === '/lol-summoner/v1/current-summoner') return { puuid: 'me' };
        if (url === '/lol-lobby/v2/lobby') return { members: [{ gameName: 'Me', tagLine: 'EUW', puuid: 'me' }, { gameName: 'Duo', tagLine: 'EUW', puuid: 'd' }] };
        if (url === '/riotclient/region-locale') return { region: 'EUW' };
        if (url.startsWith('/lol-summoner/v2/summoners/by-riot-id/Duo/')) return { puuid: 'd' };
        if (url.startsWith('/lol-summoner/v2/summoners/by-riot-id/Me/')) return { puuid: 'me' };
        if (url === '/lol-ranked/v1/ranked-stats/d') return { RANKED_SOLO_5x5: { tier: 'GOLD', division: 'II', leaguePoints: 40, wins: 6, losses: 4 } };
        if (url === '/lol-ranked/v1/ranked-stats/me') return { RANKED_SOLO_5x5: { tier: 'NONE' } };
        return null;
    });
    t.mock.method(axios, 'get', async () => { throw new Error('no network in tests'); });
    const res = await invoke('get-lobby-check');
    assert.equal(res.phase, 'Lobby');
    assert.equal(res.region, 'euw');
    assert.deepEqual(res.players.map(p => [p.gameName, p.tier, p.isSelf]), [['Me', 'Unranked', true], ['Duo', 'Gold II', false]]);
});
