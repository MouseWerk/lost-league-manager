const axios = require('axios');
const state = require('../state');
const championData = require('./champion-data');

// Maps user-facing region strings → Riot platform routing values
const REGION_TO_PLATFORM = {
    na: 'na1', na1: 'na1',
    euw: 'euw1', euw1: 'euw1',
    eune: 'eun1', eun1: 'eun1',
    kr: 'kr',
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
};

// Maps platform → regional routing host for account-v1
const PLATFORM_TO_REGIONAL = {
    na1: 'americas', br1: 'americas', la1: 'americas', la2: 'americas',
    euw1: 'europe', eun1: 'europe', tr1: 'europe', ru: 'europe',
    kr: 'asia', jp1: 'asia',
    oc1: 'sea', ph2: 'sea', sg2: 'sea', th2: 'sea', tw2: 'sea', vn2: 'sea',
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

function handleAxiosError(e, context) {
    const status = e.response?.status;
    if (status === 401 || status === 403) throw new Error('Invalid or expired Riot API key — update it in Settings');
    if (status === 404)                   throw new Error(`Not found (${context})`);
    if (status === 429)                   throw new Error('Riot API rate limit hit — try again in a moment');
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
    };
}

async function getStats(gameName, tagLine, region) {
    if (!state.config.riotApiKey) {
        throw new Error('No Riot API key set — add one in Settings → Riot API Key');
    }

    const { account, platform } = await getAccountByRiotId(gameName, tagLine, region);
    const summoner = await getSummonerByPuuid(account.puuid, platform);
    const entries  = await getRankedEntriesByPuuid(account.puuid, platform);

    const solo   = entries.find(e => e.queueType === 'RANKED_SOLO_5x5');
    const ranked = formatEntry(solo) || { tier: 'Unranked', lp: '', winLose: '', ratio: '' };
    const version = championData.getLatestVersion();

    return {
        success: true,
        ...ranked,
        iconSrc: summoner.profileIconId
            ? `https://ddragon.leagueoflegends.com/cdn/${version}/img/profileicon/${summoner.profileIconId}.png`
            : `https://ddragon.leagueoflegends.com/cdn/${version}/img/profileicon/29.png`,
        level:  summoner.summonerLevel?.toString() || '',
        source: 'riot-api',
    };
}

module.exports = { getStats, getPlatform };
