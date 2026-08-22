const axios = require('axios');
const state = require('../state');
const championData = require('./champion-data');

// Maps user-facing region strings → Riot platform routing values
// cn is not on the Riot Developer API (Tencent operates CN servers separately)
const REGION_TO_PLATFORM = {
    na: 'na1', na1: 'na1',
    euw: 'euw1', euw1: 'euw1',
    eune: 'eun1', eun1: 'eun1',
    kr: 'kr',
    sea: 'sea',
    br: 'br1', br1: 'br1',
    las: 'la1', la1: 'la1',
    lan: 'la2', la2: 'la2',
    oce: 'oc1', oc1: 'oc1',
    tr: 'tr1', tr1: 'tr1',
    ru: 'ru',
    jp: 'jp1', jp1: 'jp1',
    ph: 'ph2', ph2: 'ph2',
    sg: 'sg2', sg2: 'sg2',
    th: 'th2', th2: 'th2',
    tw: 'tw2', tw2: 'tw2',
    vn: 'vn2', vn2: 'vn2',
    cn: 'cn',
};

// Maps platform → regional routing host for account-v1
const PLATFORM_TO_REGIONAL = {
    na1: 'americas', br1: 'americas', la1: 'americas', la2: 'americas',
    euw1: 'europe', eun1: 'europe', tr1: 'europe', ru: 'europe',
    kr: 'asia', jp1: 'asia',
    sea: 'sea', oc1: 'sea', ph2: 'sea', sg2: 'sea', th2: 'sea', tw2: 'sea', vn2: 'sea',
};

function getPlatform(region) {
    return REGION_TO_PLATFORM[(region || '').toLowerCase()] || 'euw1';
}

function getRegional(platform) {
    return PLATFORM_TO_REGIONAL[platform] || 'europe';
}

function headers() {
    return { 'X-Riot-Token': state.config.riotApiKey };
}

// Module-wide cooldown after a 429 — the API key's rate limit is shared across
// every caller (account cards + overlay's per-lobby fan-out), so once we're
// limited, every other in-flight/queued call should back off too instead of
// immediately retrying and getting 429'd again.
let rateLimitedUntil = 0;

function assertNotRateLimited() {
    const remaining = rateLimitedUntil - Date.now();
    if (remaining > 0) {
        throw new Error(`Riot API rate limit hit — retrying in ${Math.ceil(remaining / 1000)}s`);
    }
}

function handleAxiosError(e, context) {
    const status = e.response?.status;
    if (status === 401 || status === 403) throw new Error('Invalid or expired Riot API key — update it in Settings');
    if (status === 404)                   throw new Error(`Not found (${context})`);
    if (status === 429) {
        const retryAfterSecs = parseInt(e.response?.headers?.['retry-after'], 10);
        const cooldownMs = (Number.isFinite(retryAfterSecs) ? retryAfterSecs : 30) * 1000;
        rateLimitedUntil = Date.now() + cooldownMs;
        throw new Error(`Riot API rate limit hit — try again in ${Math.ceil(cooldownMs / 1000)}s`);
    }
    throw e;
}

async function getAccountByRiotId(gameName, tagLine, region) {
    const platform = getPlatform(region);
    const regional = getRegional(platform);
    const url = `https://${regional}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
    try {
        const res = await axios.get(url, { headers: headers(), timeout: 8000 });
        return { account: res.data, platform };
    } catch (e) { handleAxiosError(e, `${gameName}#${tagLine}`); }
}

async function getSummonerByPuuid(puuid, platform) {
    const url = `https://${platform}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${puuid}`;
    try {
        const res = await axios.get(url, { headers: headers(), timeout: 8000 });
        return res.data; // returns: puuid, profileIconId, revisionDate, summonerLevel
    } catch (e) { handleAxiosError(e, `puuid ${puuid.slice(0, 8)}…`); }
}

// Riot removed summonerId from summoner-v4 responses; use the PUUID-based endpoint instead.
async function getRankedEntriesByPuuid(puuid, platform) {
    const url = `https://${platform}.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}`;
    try {
        const res = await axios.get(url, { headers: headers(), timeout: 8000 });
        return res.data;
    } catch (e) { handleAxiosError(e, `puuid ${puuid.slice(0, 8)}…`); }
}

async function getTopMastery(puuid, platform, count = 3) {
    const url = `https://${platform}.api.riotgames.com/lol/champion-mastery/v4/champion-masteries/by-puuid/${puuid}/top?count=${count}`;
    try {
        const res = await axios.get(url, { headers: headers(), timeout: 8000 });
        return res.data;
    } catch (e) { handleAxiosError(e, `mastery for puuid ${puuid.slice(0, 8)}…`); }
}

// count is capped by Riot at match-v5 (start/count both required); 5 keeps this
// to 6 total requests (1 id list + 5 match details) per profile-modal open.
async function getMatchHistory(puuid, platform, count = 5) {
    const regional = getRegional(platform);
    const idsUrl = `https://${regional}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=${count}`;
    let ids;
    try {
        ids = (await axios.get(idsUrl, { headers: headers(), timeout: 8000 })).data;
    } catch (e) { handleAxiosError(e, `match ids for puuid ${puuid.slice(0, 8)}…`); }

    const matches = await Promise.all(ids.map(async (matchId) => {
        try {
            const res = await axios.get(
                `https://${regional}.api.riotgames.com/lol/match/v5/matches/${matchId}`,
                { headers: headers(), timeout: 8000 }
            );
            const p = res.data.info.participants.find(pp => pp.puuid === puuid);
            if (!p) return null;
            return {
                matchId,
                win: !!p.win,
                championName: p.championName, // DDragon key, e.g. "MonkeyKing"
                kda: `${p.kills}/${p.deaths}/${p.assists}`,
            };
        } catch (e) {
            // One bad match (e.g. a remake the API still lists) shouldn't sink
            // the whole strip — skip it rather than failing the batch.
            console.log('[MatchHistory]', matchId, e.message);
            return null;
        }
    }));
    return matches.filter(Boolean);
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

async function getStats(gameName, tagLine, region) {
    if (!state.config.riotApiKey) {
        throw new Error('No Riot API key set — add one in Settings → Riot API Key');
    }

    if ((region || '').toLowerCase() === 'cn') {
        throw new Error('CN server stats require the League client to be running (Tencent servers are not on the Riot API)');
    }

    assertNotRateLimited();

    const { account, platform } = await getAccountByRiotId(gameName, tagLine, region);
    const summoner = await getSummonerByPuuid(account.puuid, platform);
    const entries  = await getRankedEntriesByPuuid(account.puuid, platform);

    const EMPTY = { tier: 'Unranked', lp: '', winLose: '', ratio: '' };
    const solo   = formatEntry(entries.find(e => e.queueType === 'RANKED_SOLO_5x5')) || EMPTY;
    const flex   = formatEntry(entries.find(e => e.queueType === 'RANKED_FLEX_SR'))  || EMPTY;
    const version = championData.getLatestVersion();

    // Best-effort — a mastery hiccup shouldn't fail the whole card's stats.
    let masteryChampions = [];
    try {
        const top = await getTopMastery(account.puuid, platform, 3);
        const idToName  = championData.getIdToNameMap();
        const idToImage = championData.getIdToImageMap();
        masteryChampions = (top || []).map(c => {
            const key  = idToName[c.championId];
            const full = key ? championData.getChampionFullData(key) : null;
            return {
                name:   full?.name || key || `Champion ${c.championId}`,
                icon:   key ? idToImage[key] : null,
                points: c.championPoints,
                level:  c.championLevel,
            };
        });
    } catch (e) {
        console.log('[Stats] mastery lookup failed:', e.message);
    }

    return {
        success: true,
        ...solo,
        flexTier:    flex.tier,
        flexLp:      flex.lp,
        flexWinLose: flex.winLose,
        flexRatio:   flex.ratio,
        masteryChampions,
        iconSrc: summoner.profileIconId
            ? `https://ddragon.leagueoflegends.com/cdn/${version}/img/profileicon/${summoner.profileIconId}.png`
            : `https://ddragon.leagueoflegends.com/cdn/${version}/img/profileicon/29.png`,
        level:  summoner.summonerLevel?.toString() || '',
        source: 'riot-api',
    };
}

module.exports = { getStats, getPlatform, getMatchHistory, getAccountByRiotId };
