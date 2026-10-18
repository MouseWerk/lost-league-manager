const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const opgg = require('../src/main/services/opgg-api');

test.beforeEach(() => opgg._resetForTests());

// Shape of a real lol_get_summoner_profile response (trimmed), including an
// escaped slash, nulls, nested constructors and lists.
const PROFILE_TEXT = [
    'class LolGetSummonerProfile: data',
    'class Data: summoner',
    'class Summoner: puuid,game_name,tagline,profile_image_url,level,league_stats,most_champions',
    'class LeagueStat: game_type,tier_info,win,lose',
    'class TierInfo: tier,division,lp',
    'class MostChampions: champion_stats',
    'class ChampionStat: id,play,win,champion_name',
    '',
    'LolGetSummonerProfile(Data(Summoner("abc","Hide on bush","KR1","https:\\/\\/opgg-static.akamaized.net\\/p.jpg",946,'
        + '[LeagueStat("SOLORANKED",TierInfo("GOLD",2,57),10,5),LeagueStat("FLEXRANKED",TierInfo(null,null,null),null,null)],'
        + 'MostChampions([ChampionStat(777,63,31,"Yone"),ChampionStat(1,26,18,"Annie")]))))',
].join('\n');

function mcpResult(text) {
    return { data: { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } } };
}

test('parseToolText maps positional constructor args to the declared field names', () => {
    const parsed = opgg.parseToolText(PROFILE_TEXT);
    const s = parsed.data.summoner;
    assert.equal(s.game_name, 'Hide on bush');
    assert.equal(s.profile_image_url, 'https://opgg-static.akamaized.net/p.jpg');
    assert.equal(s.level, 946);
    assert.equal(s.league_stats[0].tier_info.division, 2);
    assert.equal(s.league_stats[1].tier_info.tier, null);
    assert.deepEqual(s.most_champions.champion_stats.map(c => c.champion_name), ['Yone', 'Annie']);
});

test('parseToolText keeps unicode and escaped quotes in strings', () => {
    const parsed = opgg.parseToolText('class A: name,other\n\nA("Müller \\"Zé\\" ルフィ",[])');
    assert.equal(parsed.name, 'Müller "Zé" ルフィ');
    assert.deepEqual(parsed.other, []);
});

test('parseRiotIdInput accepts Riot IDs and OP.GG links', () => {
    assert.deepEqual(opgg.parseRiotIdInput('Hide on bush #KR1'), { gameName: 'Hide on bush', tagLine: 'KR1', region: null });
    assert.deepEqual(opgg.parseRiotIdInput('Müller#EUW'), { gameName: 'Müller', tagLine: 'EUW', region: null });
    assert.deepEqual(opgg.parseRiotIdInput('https://op.gg/lol/summoners/euw/Caps-45555'), { gameName: 'Caps', tagLine: '45555', region: 'euw' });
    assert.deepEqual(opgg.parseRiotIdInput('https://www.op.gg/summoners/kr/Hide%20on%20bush-KR1?queue=solo'), { gameName: 'Hide on bush', tagLine: 'KR1', region: 'kr' });
    // A dash inside the game name: the tag is after the last dash.
    assert.deepEqual(opgg.parseRiotIdInput('op.gg/lol/summoners/na/Jean-Luc-NA1'), { gameName: 'Jean-Luc', tagLine: 'NA1', region: 'na' });
});

test('parseRiotIdInput rejects incomplete input', () => {
    for (const bad of ['', '   ', 'NoTag', '#TAG', 'Name#', 'https://op.gg/lol/summoners/euw/NoDash']) {
        assert.equal(opgg.parseRiotIdInput(bad), null, bad);
    }
});

test('toOpggRegion maps app and platform values, excludes CN', () => {
    assert.equal(opgg.toOpggRegion('euw'), 'EUW');
    assert.equal(opgg.toOpggRegion('eun1'), 'EUNE');
    assert.equal(opgg.toOpggRegion('la1'), 'LAN');
    assert.equal(opgg.toOpggRegion('oc1'), 'OCE');
    assert.equal(opgg.toOpggRegion('cn'), null);
    assert.equal(opgg.toOpggRegion(''), null);
});

test('getProfile formats ranks and top champions', async (t) => {
    t.mock.method(axios, 'post', async () => mcpResult(PROFILE_TEXT));
    const p = await opgg.getProfile('Hide on bush', 'KR1', 'kr');
    assert.equal(p.source, 'opgg');
    assert.equal(p.riotId, 'Hide on bush#KR1');
    assert.equal(p.tier, 'Gold II');
    assert.equal(p.lp, '57 LP');
    assert.equal(p.ratio, '67%');
    assert.equal(p.flexTier, 'Unranked');
    assert.equal(p.level, '946');
    assert.equal(p.topChampions.length, 2);
});

test('getProfile turns "Summoner not found" into an actionable message', async (t) => {
    t.mock.method(axios, 'post', async () => ({ data: { jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'Summoner not found' } } }));
    await assert.rejects(opgg.getProfile('Nobody', '0000', 'euw'), /check the Riot ID and region/);
});

test('at most 4 OP.GG requests run at the same time', async (t) => {
    let active = 0;
    let peak = 0;
    t.mock.method(axios, 'post', async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise(r => setImmediate(r));
        active--;
        return mcpResult(PROFILE_TEXT);
    });
    await Promise.all(Array.from({ length: 12 }, (_, i) => opgg.getProfile(`Player${i}`, 'TAG', 'euw')));
    assert.ok(peak <= 4, `peak concurrency was ${peak}`);
});

test('identical concurrent lookups share one request', async (t) => {
    const post = t.mock.method(axios, 'post', async () => mcpResult(PROFILE_TEXT));
    await Promise.all([opgg.getProfile('Same', 'ONE', 'na'), opgg.getProfile('same', 'one', 'na')]);
    assert.equal(post.mock.callCount(), 1);
});

test('toOpggRegion: LAS is la2, legacy SEA is SG, every app region is covered', () => {
    assert.equal(opgg.toOpggRegion('la2'), 'LAS');
    assert.equal(opgg.toOpggRegion('las'), 'LAS');
    assert.equal(opgg.toOpggRegion('sea'), 'SG');
    const appRegions = ['euw', 'eune', 'na', 'kr', 'jp', 'br', 'lan', 'las', 'oce', 'tr', 'ru', 'me', 'vn', 'tw', 'sg', 'ph', 'th', 'sea'];
    for (const r of appRegions) assert.ok(opgg.toOpggRegion(r), r);
    assert.equal(opgg.toOpggRegion('pbe'), null);
});

test('a busy OP.GG gets a readable message and a short break', async (t) => {
    const post = t.mock.method(axios, 'post', async () => {
        const err = new Error('Request failed with status code 429');
        err.response = { status: 429 };
        throw err;
    });
    await assert.rejects(opgg.getProfile('Busy', 'ONE', 'euw'), /OP\.GG is busy, try again in a minute/);
    await assert.rejects(opgg.getProfile('Busy', 'TWO', 'euw'), /OP\.GG is busy/);
    assert.equal(post.mock.callCount(), 1);
});

test('an OP.GG server error also pauses requests', async (t) => {
    const post = t.mock.method(axios, 'post', async () => {
        const err = new Error('Request failed with status code 503');
        err.response = { status: 503 };
        throw err;
    });
    await assert.rejects(opgg.getRecentMatches('Down', 'ONE', 'euw'), /OP\.GG is busy/);
    await assert.rejects(opgg.getProfile('Down', 'TWO', 'euw'), /OP\.GG is busy/);
    assert.equal(post.mock.callCount(), 1);
});

test('the concurrency cap holds while slots are handed over', async (t) => {
    let active = 0;
    let peak = 0;
    let n = 0;
    const spawned = [];
    // New lookups arrive at every point of the release sequence.
    const spawnAfter = async (hops) => {
        for (let i = 0; i < hops; i++) await null;
        spawned.push(opgg.getProfile(`Late${n++}`, 'TAG', 'euw'));
    };
    t.mock.method(axios, 'post', () => {
        active++;
        peak = Math.max(peak, active);
        return new Promise(r => setImmediate(() => {
            active--;
            r(mcpResult(PROFILE_TEXT));
            if (n < 40) for (let hops = 0; hops < 12; hops++) spawnAfter(hops);
        }));
    });
    await Promise.all(Array.from({ length: 5 }, (_, i) => opgg.getProfile(`First${i}`, 'TAG', 'euw')));
    while (spawned.length) await spawned.shift();
    assert.ok(peak <= 4, `peak concurrency was ${peak}`);
});
