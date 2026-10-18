require('./helpers/fake-electron');
const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const riotApi = require('../src/main/services/riot-api');

const ACCOUNT = { puuid: 'puuid-0123456789', gameName: 'Name', tagLine: 'TAG' };

function httpError(status, extra = {}) {
    const err = new Error(`Request failed with status code ${status}`);
    err.response = { status, headers: {}, data: { status: { message: 'Forbidden', status_code: status } }, ...extra };
    return err;
}

// Answers like the Riot API for one account; `override(url)` may return a
// response or throw to simulate errors on specific endpoints.
function fakeRiot(t, override = () => undefined) {
    const urls = [];
    const get = t.mock.method(axios, 'get', async (url) => {
        urls.push(url);
        const res = override(url);
        if (res !== undefined) return res;
        if (url.includes('/riot/account/v1/')) return { data: ACCOUNT, headers: {} };
        if (url.includes('/summoner/v4/')) return { data: { profileIconId: 1, summonerLevel: 30 }, headers: {} };
        if (url.includes('/league/v4/')) return { data: [{ queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'II', leaguePoints: 57, wins: 10, losses: 5 }], headers: {} };
        if (url.includes('/champion-mastery/')) return { data: [], headers: {} };
        if (url.includes('/ids?')) return { data: ['M_1', 'M_2'], headers: {} };
        if (url.includes('/match/v5/matches/')) {
            return { data: { info: { participants: [{ puuid: ACCOUNT.puuid, win: true, championId: 9, championName: 'FiddleSticks', kills: 1, deaths: 2, assists: 3 }] } }, headers: {} };
        }
        throw new Error(`unexpected URL ${url}`);
    });
    return { urls, get };
}

test.beforeEach((t) => {
    riotApi._resetForTests();
    t.mock.method(riotApi, 'getApiKey', () => 'RGAPI-test');
});

// account-v1 is not served on the sea cluster; it answered 403, which was
// shown as "Invalid or expired Riot API key" for every OCE and SEA account.
test('account-v1 goes to americas, europe or asia, never sea', async (t) => {
    const { urls } = fakeRiot(t);
    const expected = {
        oce: 'asia', sg: 'asia', ph: 'asia', th: 'asia', tw: 'asia', vn: 'asia', sea: 'asia',
        kr: 'asia', jp: 'asia', euw: 'europe', eune: 'europe', tr: 'europe', ru: 'europe', me: 'europe',
        na: 'americas', br: 'americas', lan: 'americas', las: 'americas',
    };
    for (const [region, cluster] of Object.entries(expected)) {
        urls.length = 0;
        await riotApi.getAccountByRiotId('Name', 'TAG', region);
        assert.equal(urls[0], `https://${cluster}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/Name/TAG`, region);
    }
});

test('match-v5 for OCE and the SEA servers still uses the sea cluster', async (t) => {
    const { urls } = fakeRiot(t);
    await riotApi.getMatchHistory(ACCOUNT.puuid, 'oc1', 2);
    assert.ok(urls.every(u => u.startsWith('https://sea.api.riotgames.com/lol/match/v5/')), urls.join('\n'));
});

test('legacy SEA accounts are looked up on a real platform host', async (t) => {
    const { urls } = fakeRiot(t);
    await riotApi.getStats('Name', 'TAG', 'sea');
    const platformCalls = urls.filter(u => u.includes('/lol/'));
    assert.ok(platformCalls.length > 0);
    assert.ok(platformCalls.every(u => u.startsWith('https://sg2.api.riotgames.com/')), platformCalls.join('\n'));
});

test('a 403 from account-v1 is a rejected key, and the key is not retried on the next card', async (t) => {
    const { get } = fakeRiot(t, (url) => { if (url.includes('/account/v1/')) throw httpError(403); });
    await assert.rejects(riotApi.getStats('Name', 'TAG', 'euw'), /Invalid or expired Riot API key/);
    const calls = get.mock.callCount();
    await assert.rejects(riotApi.getStats('Other', 'TAG', 'euw'), /Invalid or expired Riot API key/);
    assert.equal(get.mock.callCount(), calls, 'second lookup must not hit the API');
});

test('a new key is tried right away after the old one was rejected', async (t) => {
    let key = 'RGAPI-old';
    t.mock.method(riotApi, 'getApiKey', () => key);
    fakeRiot(t, (url) => { if (key === 'RGAPI-old' && url.includes('/account/v1/')) throw httpError(401); });
    await assert.rejects(riotApi.getStats('Name', 'TAG', 'euw'), /Invalid or expired/);
    key = 'RGAPI-new';
    const res = await riotApi.getStats('Name', 'TAG', 'euw');
    assert.equal(res.tier, 'Gold II');
});

test('a 403 on another endpoint is reported as refused, not as a bad key', async (t) => {
    const { get } = fakeRiot(t, (url) => { if (url.includes('/summoner/v4/')) throw httpError(403); });
    await assert.rejects(riotApi.getStats('Name', 'TAG', 'euw'), (e) => {
        assert.match(e.message, /refused the request \(403\)/);
        assert.doesNotMatch(e.message, /Invalid or expired/);
        return true;
    });
    const before = get.mock.callCount();
    await riotApi.getStats('Name', 'TAG', 'euw').catch(() => {});
    assert.ok(get.mock.callCount() > before, 'the key must not be put on cooldown');
});

test('a 429 on match details fails the history and puts every caller on cooldown', async (t) => {
    const { get } = fakeRiot(t, (url) => {
        if (/\/matches\/M_/.test(url)) throw httpError(429, { headers: { 'retry-after': '12' } });
    });
    await assert.rejects(riotApi.getMatchHistory(ACCOUNT.puuid, 'euw1', 2), /rate limit reached — try again in 12s/);
    const calls = get.mock.callCount();
    await assert.rejects(riotApi.getStats('Name', 'TAG', 'euw'), /rate limit reached/);
    assert.equal(get.mock.callCount(), calls);
});

test('match history fails when no match detail could be read', async (t) => {
    fakeRiot(t, (url) => { if (/\/matches\/M_/.test(url)) throw httpError(500); });
    await assert.rejects(riotApi.getMatchHistory(ACCOUNT.puuid, 'euw1', 2), /no match details/);
});

test('match history carries the champion id (match-v5 names Fiddlesticks "FiddleSticks")', async (t) => {
    fakeRiot(t);
    const matches = await riotApi.getMatchHistory(ACCOUNT.puuid, 'euw1', 2);
    assert.equal(matches[0].championId, 9);
});

test('the rate-limit message does not promise an automatic retry', async (t) => {
    fakeRiot(t, (url) => { if (url.includes('/account/v1/')) throw httpError(429, { headers: {} }); });
    await assert.rejects(riotApi.getStats('Name', 'TAG', 'euw'), (e) => {
        assert.match(e.message, /try again in 30s/);
        assert.doesNotMatch(e.message, /retrying/);
        return true;
    });
});

test('no key: a clear message and no request', async (t) => {
    t.mock.method(riotApi, 'getApiKey', () => '');
    const { get } = fakeRiot(t);
    await assert.rejects(riotApi.getStats('Name', 'TAG', 'euw'), /No Riot API key/);
    assert.equal(get.mock.callCount(), 0);
});

// A development key allows 20 requests per second and 100 per 2 minutes.
test('the limiter keeps a development key under 20 requests per second', async () => {
    let now = 0;
    const starts = [];
    const limiter = riotApi.createRateLimiter({
        now: () => now,
        sleep: async (ms) => { now += ms; },
    });
    for (let i = 0; i < 60; i++) {
        await limiter.acquire();
        starts.push(now);
    }
    for (const s of starts) {
        const inSecond = starts.filter(x => x >= s && x < s + 1000).length;
        assert.ok(inSecond <= 18, `${inSecond} requests started within 1 s of ${s}`);
    }
});

test('the limiter fails fast once the 2-minute budget is used up', async () => {
    let now = 0;
    const limiter = riotApi.createRateLimiter({ now: () => now, sleep: async (ms) => { now += ms; } });
    let made = 0;
    await assert.rejects(async () => {
        for (;;) { await limiter.acquire(); made++; }
    }, /rate limit reached/);
    assert.equal(made, 95);
    assert.ok(now < 120000, 'must not wait out the long window');
});

test('the limiter adopts the key limits Riot reports', async () => {
    let now = 0;
    const limiter = riotApi.createRateLimiter({ now: () => now, sleep: async (ms) => { now += ms; } });
    limiter.updateFromHeader('500:10,30000:600');
    for (let i = 0; i < 200; i++) await limiter.acquire();
    assert.equal(now, 0, 'a production key needs no waiting for 200 requests');
});
