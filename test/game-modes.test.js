// Every game mode is named, not "Other" or "Custom": ARAM Mayhem, Arena,
// Swarm, Brawl, ... One table in ui-lib.js serves the Live view, saved games,
// today's session and Discord.
const fx = require('./helpers/a-fakes');
const test = require('node:test');
const assert = require('node:assert/strict');
const lcu = require('../src/main/lcu');
const { queueName, gameModeName, buildModeFor } = require('../src/renderer/js/ui-lib.js');
const matches = require('../src/main/services/matches');
const champBuild = require('../src/main/ipc/champ-build');

const MAPS = { idToName: { 9: 'Fiddlesticks' }, idToImage: { Fiddlesticks: 'fiddle.png' } };

test('queues are named by id, with the game mode as fallback', () => {
    assert.equal(queueName(2400), 'ARAM Mayhem');
    assert.equal(queueName(450), 'ARAM');
    assert.equal(queueName(720), 'ARAM Clash');
    assert.equal(queueName(1700), 'Arena');
    assert.equal(queueName(1830), 'Swarm');
    assert.equal(queueName(2300), 'Brawl');
    assert.equal(queueName(480), 'Swiftplay');
    assert.equal(queueName(1300), 'Nexus Blitz');
    assert.equal(queueName(9999, 'KIWI'), 'ARAM Mayhem');
    assert.equal(queueName(9999, 'BRAND_NEW_MODE'), 'Brand New Mode', 'a new mode still gets a readable name');
    assert.equal(queueName(undefined), 'Other');
});

test('game modes from the client get their names', () => {
    assert.equal(gameModeName('KIWI'), 'ARAM Mayhem');
    assert.equal(gameModeName('CHERRY'), 'Arena');
    assert.equal(gameModeName('STRAWBERRY'), 'Swarm');
    assert.equal(gameModeName('PRACTICETOOL'), 'Practice Tool');
    assert.equal(gameModeName(''), '');
});

test('ARAM Mayhem uses the ARAM builds; modes without OP.GG builds get none', () => {
    assert.equal(buildModeFor('CLASSIC'), 'ranked');
    assert.equal(buildModeFor('ARAM'), 'aram');
    assert.equal(buildModeFor('KIWI'), 'aram');
    assert.equal(buildModeFor('CHERRY'), null);
    assert.equal(buildModeFor('URF'), null);
    assert.equal(buildModeFor(undefined), 'ranked');
});

test('champion select in ARAM Mayhem asks for the ARAM build', async () => {
    lcu.connected = true;
    lcu.request = async (method, endpoint) =>
        (endpoint === '/lol-gameflow/v1/session' ? { gameData: { queue: { gameMode: 'KIWI' } } } : null);
    const pick = await champBuild.currentPick({ localPlayerCellId: 0, myTeam: [{ cellId: 0, championId: 103 }], actions: [] });
    assert.equal(pick.mode, 'aram');
});

test('saved games name every queue, and OP.GG game types too', () => {
    const info = {
        gameStartTimestamp: 5000, gameDuration: 900, queueId: 2400, gameMode: 'KIWI',
        participants: [{ puuid: 'me', teamId: 100, championId: 9, championName: 'Annie', kills: 1, deaths: 1, assists: 1, win: true }],
    };
    assert.equal(matches.fromRiotMatch('EUW1_2', info, 'me', MAPS).queue, 'ARAM Mayhem');
    assert.equal(matches.fromRiotMatch('EUW1_3', { ...info, queueId: 420 }, 'me', MAPS).queue, 'Ranked Solo');
    const g = matches.fromOpggGame({ game_type: 'ARAM_MAYHEM', participants: [{ summoner: { game_name: 'Me', tagline: 'EUW' }, champion_id: 9, stats: {} }] }, 'Me#EUW', MAPS);
    assert.equal(g.queue, 'ARAM Mayhem');
});

void fx;
