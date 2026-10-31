const { invoke } = require('./helpers/fake-electron');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const axios = require('axios');
const state = require('../src/main/state');
const matches = require('../src/main/services/matches');
const opgg = require('../src/main/services/opgg-api');
const riotApi = require('../src/main/services/riot-api');
const championData = require('../src/main/services/champion-data');
const status = require('../src/main/services/account-status');
const { championStats } = require('../src/renderer/js/ui-lib.js');
require('../src/main/ipc/stats').register();

const MAPS = {
    idToName: { 3: 'Galio', 121: 'Khazix', 9: 'Fiddlesticks' },
    idToImage: { Galio: 'galio.png', Khazix: 'khazix.png', Fiddlesticks: 'fiddle.png' },
};

// Trimmed from real lol_list_summoner_matches and lol_get_summoner_game_detail
// answers (field order as OP.GG declares it).
const LIST_TEXT = [
    'class LolListSummonerMatches: data',
    'class Data: game_history',
    'class GameHistory: id,created_at,game_type,game_length_second,participants',
    'class Participant: summoner,champion_id,champion_name,team_key,position,items,stats',
    'class Summoner: game_name,tagline',
    'class Stats: total_damage_dealt_to_champions,kill,death,assist,minion_kill,neutral_minion_kill,gold_earned,result',
    '',
    'LolListSummonerMatches(Data([GameHistory("m_1","2026-10-17T01:53:14+09:00","SOLORANKED",1011,'
        + '[Participant(Summoner("Hide on bush","KR1"),3,"Galio","RED","MID",[3152,3173,0],Stats(13660,7,4,6,123,0,8205,"WIN"))]),'
        + 'GameHistory("m_2","2026-10-16T01:28:10+09:00","SOLORANKED",180,'
        + '[Participant(Summoner("Hide on bush","KR1"),3,"Galio","BLUE","MID",[],Stats(100,0,0,0,5,0,500,"UNKNOWN"))])]))',
].join('\n');

const DETAIL_TEXT = [
    'class LolGetSummonerGameDetail: data',
    'class Data: game_detail',
    'class GameDetail: id,created_at,game_type,game_length_second,teams',
    'class Team: key,participants',
    'class Participant: is_target,summoner,champion_id,champion_name,team_key,position,items,stats',
    'class Summoner: game_name,tagline',
    'class Stats: total_damage_dealt_to_champions,kill,death,assist,minion_kill,neutral_minion_kill,gold_earned,result',
    '',
    'LolGetSummonerGameDetail(Data(GameDetail("m_1","2026-10-17T01:53:14+09:00","SOLORANKED",1011,['
        + 'Team("BLUE",[Participant(false,Summoner("Enemy","111"),121,"Kha\'Zix","BLUE","JUNGLE",[1001],Stats(14251,4,6,7,9,110,9192,"LOSE"))]),'
        + 'Team("RED",[Participant(true,Summoner("Hide on bush","KR1"),3,"Galio","RED","MID",[3152],Stats(13660,7,4,6,123,0,8205,"WIN"))])])))',
].join('\n');

function mcp(text) {
    return { data: { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } } };
}

test.beforeEach(() => {
    opgg._resetForTests();
    fs.rmSync(state.paths.matchStore, { force: true });
});

test('OP.GG games: the player\'s own row, CS from lane and jungle, remakes dropped', async (t) => {
    t.mock.method(championData, 'getIdToNameMap', () => MAPS.idToName);
    t.mock.method(championData, 'getIdToImageMap', () => MAPS.idToImage);
    t.mock.method(axios, 'post', async () => mcp(LIST_TEXT));
    const list = await opgg.getRecentMatches('Hide on bush', 'KR1', 'kr', 10);
    assert.equal(list.length, 1);
    const m = list[0];
    assert.equal(m.id, 'm_1');
    assert.equal(m.queue, 'Ranked Solo');
    assert.equal(m.createdAt, Date.parse('2026-10-17T01:53:14+09:00'));
    assert.equal(m.duration, 1011);
    assert.equal(m.win, true);
    assert.equal(m.kda, '7/4/6');
    assert.equal(m.cs, 123);
    assert.equal(m.damage, 13660);
    assert.deepEqual(m.items, [3152, 3173]);
    assert.equal(m.championIcon, 'galio.png');
});

test('OP.GG game detail: both teams, the player marked', async (t) => {
    t.mock.method(axios, 'post', async () => mcp(DETAIL_TEXT));
    const m = await opgg.getGameDetail('Hide on bush', 'KR1', 'kr', 'm_1', '2026-10-17T01:53:14+09:00');
    assert.equal(m.players.length, 2);
    const me = m.players.find(p => p.isSelf);
    assert.equal(me.team, 'red');
    assert.equal(me.champion, 'Galio');
    assert.equal(m.players.find(p => !p.isSelf).cs, 119);
});

test('Riot API games keep all ten players and name the queue', () => {
    const info = {
        gameStartTimestamp: 5000, gameDuration: 1800, queueId: 440,
        participants: [
            { puuid: 'me', teamId: 100, championId: 9, championName: 'FiddleSticks', riotIdGameName: 'Me', riotIdTagline: 'EUW', kills: 3, deaths: 1, assists: 9, totalMinionsKilled: 20, neutralMinionsKilled: 150, goldEarned: 11000, totalDamageDealtToChampions: 15000, item0: 3020, item1: 0, win: true, teamPosition: 'JUNGLE' },
            { puuid: 'x', teamId: 200, championId: 3, riotIdGameName: 'Foe', riotIdTagline: 'EUW', kills: 1, deaths: 3, assists: 0, win: false },
        ],
    };
    const m = matches.fromRiotMatch('EUW1_1', info, 'me', MAPS);
    assert.equal(m.queue, 'Ranked Flex');
    assert.equal(m.champion, 'Fiddlesticks');
    assert.equal(m.cs, 170);
    assert.deepEqual(m.items, [3020]);
    assert.equal(m.players.length, 2);
    assert.equal(m.players[1].team, 'red');
    assert.equal(matches.fromRiotMatch('EUW1_1', info, 'nobody', MAPS), null);
});

test('the store keeps the newest games once each, and players once known', () => {
    const g = (id, createdAt, extra) => ({ id, createdAt, win: true, ...extra });
    matches.mergeMatches('Me#EUW', [g('a', 1, { players: [{ name: 'x' }] }), g('b', 2)]);
    const list = matches.mergeMatches('me#euw', [g('a', 1), g('c', 3)]);
    assert.deepEqual(list.map(m => m.id), ['c', 'b', 'a']);
    assert.equal(list[2].players.length, 1);
    const many = Array.from({ length: 40 }, (_, i) => g(`m${i}`, 100 + i));
    assert.equal(matches.mergeMatches('Me#EUW', many).length, matches.MAX_STORED);
});

test('loading games stores them and sets last played for the account', async (t) => {
    fs.writeFileSync(state.paths.accounts, JSON.stringify([{ username: 'main', password: 'x', riotId: 'Hide on bush#KR1', region: 'kr' }]));
    fs.rmSync(state.paths.accountStatus, { force: true });
    t.mock.method(riotApi, 'getApiKey', () => '');
    t.mock.method(championData, 'whenReady', async () => {});
    t.mock.method(axios, 'post', async () => mcp(LIST_TEXT));
    const res = await invoke('get-match-history', { region: 'kr', riotId: 'Hide on bush#KR1' });
    assert.equal(res.matches.length, 1);
    assert.equal(matches.getStoredMatches('hide on bush#kr1').length, 1);
    assert.equal(status.statusFor(status.getStatusMap(), 'main').lastPlayed, Date.parse('2026-10-17T01:53:14+09:00'));
});

test('a game in detail comes from the store, or OP.GG once', async (t) => {
    t.mock.method(championData, 'whenReady', async () => {});
    matches.mergeMatches('Hide on bush#KR1', [{ id: 'm_1', createdAt: 1, createdAtIso: '2026-10-17T01:53:14+09:00', win: true }]);
    const post = t.mock.method(axios, 'post', async () => mcp(DETAIL_TEXT));
    const first = await invoke('get-match-detail', { region: 'kr', riotId: 'Hide on bush#KR1', matchId: 'm_1' });
    assert.equal(first.success, true);
    assert.equal(first.match.players.length, 2);
    opgg._resetForTests();
    const again = await invoke('get-match-detail', { region: 'kr', riotId: 'Hide on bush#KR1', matchId: 'm_1' });
    assert.equal(again.match.players.length, 2);
    assert.equal(post.mock.callCount(), 1);
    assert.equal((await invoke('get-match-detail', { region: 'kr', riotId: 'Hide on bush#KR1', matchId: 'nope' })).success, false);
});

test('champion stats: games, win rate, KDA and CS per minute, most played first', () => {
    const list = [
        { champion: 'Galio', win: true, kills: 6, deaths: 2, assists: 4, cs: 200, duration: 1200 },
        { champion: 'Galio', win: false, kills: 2, deaths: 4, assists: 6, cs: 160, duration: 1200 },
        { champion: 'Annie', win: true, kills: 3, deaths: 0, assists: 3, cs: 100, duration: 600 },
    ];
    const s = championStats(list);
    assert.deepEqual(s.map(c => c.champion), ['Galio', 'Annie']);
    assert.equal(s[0].games, 2);
    assert.equal(s[0].winRate, 50);
    assert.equal(s[0].kda, 3);
    assert.equal(s[0].csPerMin, 9);
    assert.equal(s[1].kda, null); // no deaths: perfect
});
