const axios = require('axios');
const state = require('../state');
const championData = require('./champion-data');

// The key is kept encrypted (safeStorage) by ./secrets. Older builds without
// that module keep it in config, so fall back to that.
let readStoredKey;
try {
    readStoredKey = require('./secrets').getRiotApiKey;
    if (typeof readStoredKey !== 'function') throw new Error('secrets.getRiotApiKey missing');
} catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND') console.error('[RiotAPI] secrets module failed to load:', e.message);
    readStoredKey = () => state.config.riotApiKey;
}

// Every key read goes through module.exports.getApiKey so callers (and tests)
// see one source of truth.
function getApiKey() {
    return String(readStoredKey() || '').trim();
}

function currentKey() {
    return module.exports.getApiKey();
}

// Maps user-facing region strings → Riot platform routing values
// cn is not on the Riot Developer API (Tencent operates CN servers separately)
const REGION_TO_PLATFORM = {
    na: 'na1', na1: 'na1',
    euw: 'euw1', euw1: 'euw1',
    eune: 'eun1', eun1: 'eun1',
    kr: 'kr',
    // The old Garena SEA shard was split into SG/PH/TH/TW/VN; there is no
    // "sea" platform host. Legacy accounts are looked up on SG, the same server
    // the op.gg link for them opens.
    sea: 'sg2',
    br: 'br1', br1: 'br1',
    lan: 'la1', la1: 'la1', // LA1 = Latin America North
    las: 'la2', la2: 'la2', // LA2 = Latin America South
    oce: 'oc1', oc1: 'oc1',
    tr: 'tr1', tr1: 'tr1',
    ru: 'ru',
    jp: 'jp1', jp1: 'jp1',
    ph: 'ph2', ph2: 'ph2',
    sg: 'sg2', sg2: 'sg2',
    th: 'th2', th2: 'th2',
    tw: 'tw2', tw2: 'tw2',
    vn: 'vn2', vn2: 'vn2',
    me: 'me1', me1: 'me1',
    cn: 'cn',
};

// Maps platform → regional routing host for match-v5
const PLATFORM_TO_REGIONAL = {
    na1: 'americas', br1: 'americas', la1: 'americas', la2: 'americas',
    euw1: 'europe', eun1: 'europe', tr1: 'europe', ru: 'europe', me1: 'europe',
    kr: 'asia', jp1: 'asia',
    oc1: 'sea', ph2: 'sea', sg2: 'sea', th2: 'sea', tw2: 'sea', vn2: 'sea',
};

// account-v1 is served only on americas, asia and europe (Riot retired the sea
// cluster for it, and answers there with 403). Account data is global, so the
// nearest of the three answers for every account.
const ACCOUNT_CLUSTER = { americas: 'americas', europe: 'europe', asia: 'asia', sea: 'asia' };

function getPlatform(region) {
    return REGION_TO_PLATFORM[(region || '').toLowerCase()] || 'euw1';
}

function getRegional(platform) {
    return PLATFORM_TO_REGIONAL[platform] || 'europe';
}

function getAccountCluster(platform) {
    return ACCOUNT_CLUSTER[getRegional(platform)];
}

// ── Cooldowns ────────────────────────────────────────────────────────────────
// Module-wide cooldown after a 429 — the API key's rate limit is shared across
// every caller (account cards + overlay's per-lobby fan-out), so once we're
// limited, every other in-flight/queued call should back off too instead of
// immediately retrying and getting 429'd again.
let rateLimitedUntil = 0;

// Same idea for a rejected key: one 401/403 is enough to know, so the other
// cards don't each spend a request on it. Cleared when the key changes.
const REJECTED_KEY_COOLDOWN_MS = 5 * 60 * 1000;
const INVALID_KEY_MESSAGE = 'Invalid or expired Riot API key — update it in Settings';
let rejectedKey = null;
let rejectedKeyUntil = 0;

// Errors that apply to every following call (not just this one request).
function blockingError(message) {
    const err = new Error(message);
    err.riotBlocking = true;
    return err;
}

function rateLimitMessage(ms) {
    return `Riot API rate limit reached — try again in ${Math.max(1, Math.ceil(ms / 1000))}s`;
}

function assertUsable() {
    const key = currentKey();
    if (!key) throw new Error('No Riot API key set — add one in Settings → Riot API Key');
    if (rejectedKey === key && Date.now() < rejectedKeyUntil) throw blockingError(INVALID_KEY_MESSAGE);
    const remaining = rateLimitedUntil - Date.now();
    if (remaining > 0) throw blockingError(rateLimitMessage(remaining));
}

function rejectKey() {
    rejectedKey = currentKey();
    rejectedKeyUntil = Date.now() + REJECTED_KEY_COOLDOWN_MS;
    return blockingError(INVALID_KEY_MESSAGE);
}

// `authProbe` marks a request whose path and host are known to be valid for
// every key (account-v1 on its own cluster), so a 403 there can only mean the
// key. Elsewhere Riot also answers 403 for a path the host doesn't serve.
function handleAxiosError(e, context, authProbe = false) {
    const status = e.response?.status;
    if (status === 401) throw rejectKey();
    if (status === 403) {
        const msg = String(e.response?.data?.status?.message || '');
        if (authProbe || /api ?key/i.test(msg)) throw rejectKey();
        throw new Error(`Riot API refused the request (403) for ${context}`);
    }
    if (status === 404) throw new Error(`Not found (${context})`);
    if (status === 429) {
        const retryAfterSecs = parseInt(e.response?.headers?.['retry-after'], 10);
        const cooldownMs = (Number.isFinite(retryAfterSecs) ? retryAfterSecs : 30) * 1000;
        rateLimitedUntil = Date.now() + cooldownMs;
        throw blockingError(rateLimitMessage(cooldownMs));
    }
    if (status) throw new Error(`Riot API error ${status} for ${context}`);
    throw e;
}

// ── Request pacing ───────────────────────────────────────────────────────────
// Development keys allow 20 requests per second and 100 per 2 minutes. Stay a
// little under that, and adopt the key's real limits from X-App-Rate-Limit
// (e.g. "20:1,100:120"; production keys allow far more). Short waits are
// absorbed; when the budget is gone for longer, the call fails fast so the
// caller can use OP.GG instead of leaving a card loading for minutes.
const DEFAULT_LIMITS = [[18, 1000], [95, 120000]];

function createRateLimiter({ limits = DEFAULT_LIMITS, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), maxWaitMs = 3000 } = {}) {
    let windows = limits;
    const starts = []; // request start times, ascending

    function waitNeeded(t) {
        let wait = 0;
        for (const [count, span] of windows) {
            let inWindow = 0;
            for (let i = starts.length - 1; i >= 0 && starts[i] > t - span; i--) inWindow++;
            if (inWindow >= count) {
                const oldestToExpire = starts[starts.length - count];
                wait = Math.max(wait, oldestToExpire + span - t + 1);
            }
        }
        return wait;
    }

    return {
        async acquire() {
            for (;;) {
                const t = now();
                const longest = Math.max(...windows.map(w => w[1]));
                while (starts.length && starts[0] <= t - longest) starts.shift();
                const wait = waitNeeded(t);
                if (wait <= 0) { starts.push(t); return; }
                if (wait > maxWaitMs) throw blockingError(rateLimitMessage(wait));
                await sleep(wait);
            }
        },
        updateFromHeader(header) {
            const parsed = String(header || '').split(',').map(pair => pair.split(':').map(Number))
                .filter(([count, secs]) => count > 0 && secs > 0);
            if (!parsed.length) return;
            windows = parsed.map(([count, secs]) => [Math.max(1, Math.floor(count * 0.9)), secs * 1000]);
        },
    };
}

let limiter = createRateLimiter();

async function riotGet(url, context, { authProbe = false } = {}) {
    assertUsable();
    await limiter.acquire();
    try {
        const res = await axios.get(url, { headers: { 'X-Riot-Token': currentKey() }, timeout: 8000 });
        limiter.updateFromHeader(res.headers?.['x-app-rate-limit']);
        return res.data;
    } catch (e) { handleAxiosError(e, context, authProbe); }
}

// ── Endpoints ────────────────────────────────────────────────────────────────

async function getAccountByRiotId(gameName, tagLine, region) {
    const platform = getPlatform(region);
    const cluster = getAccountCluster(platform);
    const url = `https://${cluster}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
    const account = await riotGet(url, `${gameName}#${tagLine}`, { authProbe: true });
    return { account, platform };
}

function getSummonerByPuuid(puuid, platform) {
    // returns: puuid, profileIconId, revisionDate, summonerLevel
    return riotGet(`https://${platform}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${puuid}`,
        `puuid ${puuid.slice(0, 8)}…`);
}

// Riot removed summonerId from summoner-v4 responses; use the PUUID-based endpoint instead.
function getRankedEntriesByPuuid(puuid, platform) {
    return riotGet(`https://${platform}.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}`,
        `puuid ${puuid.slice(0, 8)}…`);
}

function getTopMastery(puuid, platform, count = 3) {
    return riotGet(`https://${platform}.api.riotgames.com/lol/champion-mastery/v4/champion-masteries/by-puuid/${puuid}/top?count=${count}`,
        `mastery for puuid ${puuid.slice(0, 8)}…`);
}

// count is capped by Riot at match-v5 (start/count both required); 5 keeps this
// to 6 total requests (1 id list + 5 match details) per profile-modal open.
async function getMatchHistory(puuid, platform, count = 5) {
    const regional = getRegional(platform);
    const ids = await riotGet(
        `https://${regional}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=${count}`,
        `match ids for puuid ${puuid.slice(0, 8)}…`);
    if (!Array.isArray(ids) || ids.length === 0) return [];

    let blocking = null;
    const matches = await Promise.all(ids.map(async (matchId) => {
        try {
            const data = await riotGet(`https://${regional}.api.riotgames.com/lol/match/v5/matches/${matchId}`, matchId);
            const p = data?.info?.participants?.find(pp => pp.puuid === puuid);
            if (!p) return null;
            return {
                matchId,
                win: !!p.win,
                championId: p.championId,
                championName: p.championName, // close to the DDragon key, but not always (FiddleSticks)
                kda: `${p.kills}/${p.deaths}/${p.assists}`,
            };
        } catch (e) {
            // A rate limit or rejected key sinks every remaining call, so it
            // has to reach the caller (which then uses OP.GG). One bad match
            // (e.g. a remake the API still lists) is just skipped.
            if (e.riotBlocking) blocking = blocking || e;
            else console.log('[MatchHistory]', matchId, e.message);
            return null;
        }
    }));
    if (blocking) throw blocking;
    const found = matches.filter(Boolean);
    if (found.length === 0) throw new Error('Riot API returned no match details');
    return found;
}

function capFirst(s) {
    return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : '';
}

function formatEntry(entry) {
    if (!entry || !entry.tier || entry.tier === 'UNRANKED') return null;
    const isApex = ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(entry.tier);
    const tier   = isApex ? capFirst(entry.tier) : `${capFirst(entry.tier)} ${entry.rank}`;
    const w = entry.wins   || 0;
    const l = entry.losses || 0;
    return {
        tier,
        lp:      `${entry.leaguePoints ?? 0} LP`,
        winLose: `${w}W ${l}L`,
        ratio:   w + l > 0 ? `${Math.round(w / (w + l) * 100)}%` : '',
        // Unformatted values for rank-history tracking — Riot's ranked-entries
        // API uses `rank` for the division letter (e.g. "II"), unlike the LCU's
        // `division` field for the same concept.
        rawTier:     entry.tier,
        rawDivision: entry.rank,
        rawLp:       entry.leaguePoints,
    };
}

const EMPTY = { tier: 'Unranked', lp: '', winLose: '', ratio: '' };

function assertRegionSupported(region) {
    if ((region || '').toLowerCase() === 'cn') {
        throw new Error('CN server stats require the League client to be running (Tencent servers are not on the Riot API)');
    }
}

async function getStats(gameName, tagLine, region) {
    assertRegionSupported(region);
    assertUsable();

    const { account, platform } = await getAccountByRiotId(gameName, tagLine, region);
    // Best-effort — a mastery hiccup shouldn't fail the whole card's stats.
    const masteryPromise = getTopMastery(account.puuid, platform, 3).catch((e) => {
        console.log('[Stats] mastery lookup failed:', e.message);
        return [];
    });
    const [summoner, entries, top] = await Promise.all([
        getSummonerByPuuid(account.puuid, platform),
        getRankedEntriesByPuuid(account.puuid, platform),
        masteryPromise,
    ]);

    const list   = Array.isArray(entries) ? entries : [];
    const solo   = formatEntry(list.find(e => e.queueType === 'RANKED_SOLO_5x5')) || EMPTY;
    const flex   = formatEntry(list.find(e => e.queueType === 'RANKED_FLEX_SR'))  || EMPTY;
    const version = championData.getLatestVersion();

    const idToName  = championData.getIdToNameMap();
    const idToImage = championData.getIdToImageMap();
    const masteryChampions = (top || []).map(c => {
        const key  = idToName[c.championId];
        const full = key ? championData.getChampionFullData(key) : null;
        return {
            name:   full?.name || key || `Champion ${c.championId}`,
            icon:   key ? idToImage[key] : null,
            points: c.championPoints,
            level:  c.championLevel,
        };
    });

    return {
        success: true,
        ...solo,
        flexTier:    flex.tier,
        flexLp:      flex.lp,
        flexWinLose: flex.winLose,
        flexRatio:   flex.ratio,
        masteryChampions,
        iconSrc: summoner?.profileIconId
            ? `https://ddragon.leagueoflegends.com/cdn/${version}/img/profileicon/${summoner.profileIconId}.png`
            : `https://ddragon.leagueoflegends.com/cdn/${version}/img/profileicon/29.png`,
        level:  summoner?.summonerLevel?.toString() || '',
        source: 'riot-api',
    };
}

// Solo queue rank only (account + league: 2 requests instead of 4), for the
// overlay's per-lobby fan-out.
async function getSoloRank(gameName, tagLine, region) {
    assertRegionSupported(region);
    assertUsable();
    const { account, platform } = await getAccountByRiotId(gameName, tagLine, region);
    const entries = await getRankedEntriesByPuuid(account.puuid, platform);
    const list = Array.isArray(entries) ? entries : [];
    return formatEntry(list.find(e => e.queueType === 'RANKED_SOLO_5x5')) || EMPTY;
}

module.exports = {
    getStats, getSoloRank, getPlatform, getMatchHistory, getAccountByRiotId, getApiKey,
    createRateLimiter,
    // Clears cooldowns and pacing state between tests.
    _resetForTests() {
        rateLimitedUntil = 0;
        rejectedKey = null;
        rejectedKeyUntil = 0;
        limiter = createRateLimiter();
    },
};
