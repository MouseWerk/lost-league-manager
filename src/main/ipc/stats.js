const { ipcMain } = require('electron');
const lcu = require('../lcu');
const { loadAccounts, saveAccounts } = require('../services/storage');
const riotApi = require('../services/riot-api');
const opgg = require('../services/opgg-api');
const championData = require('../services/champion-data');
const { recordRankSnapshot, getRankHistory } = require('../services/rank-history');

const CACHE_MAX_AGE_MS = 30 * 60 * 1000;

function capFirst(s) {
    return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : '';
}

function norm(s) {
    return String(s || '').trim().toLowerCase();
}

function formatLcuRanked(q) {
    if (!q || !q.tier || q.tier === 'NONE' || q.tier === 'UNRANKED') return null;
    const isApex = ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(q.tier);
    const tier   = isApex ? capFirst(q.tier) : `${capFirst(q.tier)} ${q.division || ''}`.trim();
    const w = q.wins   || 0;
    const l = q.losses || 0;
    return {
        tier,
        lp:      `${q.leaguePoints ?? 0} LP`,
        winLose: `${w}W ${l}L`,
        ratio:   w + l > 0 ? `${Math.round(w / (w + l) * 100)}%` : '',
        // Unformatted values for rank-history tracking.
        rawTier:     q.tier,
        rawDivision: q.division,
        rawLp:       q.leaguePoints,
    };
}

const EMPTY_RANK = { tier: 'Unranked', lp: '', winLose: '', ratio: '' };

function defaultIcon() {
    const v = championData.getLatestVersion();
    return `https://ddragon.leagueoflegends.com/cdn/${v}/img/profileicon/29.png`;
}

function profileIconUrl(iconId) {
    const v = championData.getLatestVersion();
    return iconId ? `https://ddragon.leagueoflegends.com/cdn/${v}/img/profileicon/${iconId}.png` : defaultIcon();
}

// LCU /riotclient/region-locale region → app region value.
// Note LA1 is LAN (Latin America North) and LA2 is LAS.
const LCU_REGION_TO_APP = {
    euw: 'euw', euw1: 'euw', eune: 'eune', eun1: 'eune', na: 'na', na1: 'na',
    kr: 'kr', jp: 'jp', jp1: 'jp', br: 'br', br1: 'br', tr: 'tr', tr1: 'tr', ru: 'ru',
    la1: 'lan', lan: 'lan', la2: 'las', las: 'las', oc1: 'oce', oce: 'oce',
    sg2: 'sg', sg: 'sg', ph2: 'ph', ph: 'ph', th2: 'th', th: 'th', tw2: 'tw', tw: 'tw',
    vn2: 'vn', vn: 'vn', me1: 'me', me: 'me', tencent: 'cn',
};

// The servers the old Garena SEA shard was split into; a legacy "sea" account
// can be on any of them.
const SEA_SPLIT = new Set(['sg', 'ph', 'th', 'tw', 'vn']);

function toAppRegion(region) {
    const r = norm(region);
    return LCU_REGION_TO_APP[r] || r;
}

function sameServer(accountRegion, clientRegion) {
    const a = toAppRegion(accountRegion);
    if (a === 'sea') return SEA_SPLIT.has(clientRegion);
    return a === clientRegion;
}

// Region of the running client, read once per LCU connection.
let clientRegion = null;
lcu.onDisconnect(() => { clientRegion = null; });

async function getClientRegion() {
    if (clientRegion) return clientRegion;
    try {
        const info = await lcu.request('GET', '/riotclient/region-locale');
        const raw = norm(info?.region || info?.webRegion);
        clientRegion = raw ? (LCU_REGION_TO_APP[raw] || `unknown:${raw}`) : null;
    } catch {
        clientRegion = null;
    }
    return clientRegion;
}

// The LCU resolves Riot IDs on its own shard only, so an account on another
// server would get that shard's (often empty) rank. Only use it for accounts
// on the client's server; without a region on the account, it's the only source.
async function lcuServes(region) {
    const server = await getClientRegion();
    if (!server) return false;
    if (!norm(region)) return true;
    return sameServer(region, server);
}

// Cached stats live on the account records, tagged with the region they were
// fetched for: after a region edit the old server's rank must not come back.
function readCachedStats(riotId, region) {
    try {
        const id = norm(riotId);
        const r  = norm(region);
        return loadAccounts().find(a => norm(a.riotId) === id && a._cachedStats?.region === r)?._cachedStats || null;
    } catch {
        return null;
    }
}

function isFresh(cached) {
    // A timestamp in the future (clock was ahead, then corrected) is not fresh.
    const age = Date.now() - cached.ts;
    return age >= 0 && age < CACHE_MAX_AGE_MS;
}

function saveCachedStats(riotId, region, result) {
    try {
        const id = norm(riotId);
        const r  = norm(region);
        const accs = loadAccounts();
        let changed = false;
        for (const a of accs) {
            if (norm(a.riotId) !== id) continue;
            if (norm(a.region) && norm(a.region) !== r) continue;
            a._cachedStats = { ...result, region: r, ts: Date.now() };
            changed = true;
        }
        if (changed) saveAccounts(accs);
    } catch { /* non-critical */ }
}

async function statsFromLcu(name, tag) {
    const summoner = await lcu.request('GET',
        `/lol-summoner/v2/summoners/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`
    );
    if (!summoner?.puuid) return null;
    const ranked = await lcu.request('GET', `/lol-ranked/v1/ranked-stats/${summoner.puuid}`);
    const solo   = formatLcuRanked(ranked?.RANKED_SOLO_5x5) || EMPTY_RANK;
    const flex   = formatLcuRanked(ranked?.RANKED_FLEX_SR)  || EMPTY_RANK;
    return {
        success: true,
        ...solo,
        flexTier:    flex.tier,
        flexLp:      flex.lp,
        flexWinLose: flex.winLose,
        flexRatio:   flex.ratio,
        // LCU mastery endpoints only reliably cover the logged-in summoner;
        // the caller keeps the badges the online sources found earlier.
        masteryChampions: [],
        iconSrc: profileIconUrl(summoner.profileIconId),
        level:   summoner.summonerLevel?.toString() || '',
        source:  'lcu',
    };
}

// Riot API when a key is configured, otherwise (or when the key is invalid /
// expired / rate limited) OP.GG — which needs no key at all. Identical
// concurrent lookups (card, profile modal, quick add) share one request.
const onlineInFlight = new Map();

function statsFromOnline(name, tag, region) {
    const key = `${norm(region)}|${norm(name)}#${norm(tag)}`;
    if (onlineInFlight.has(key)) return onlineInFlight.get(key);
    const p = lookupOnline(name, tag, region).finally(() => onlineInFlight.delete(key));
    onlineInFlight.set(key, p);
    return p;
}

async function lookupOnline(name, tag, region) {
    let riotError = null;
    if (riotApi.getApiKey() && norm(region) !== 'cn') {
        try {
            return await riotApi.getStats(name, tag, region);
        } catch (e) {
            riotError = e;
            console.log('[Stats] Riot API failed, trying OP.GG:', e.message);
        }
    }
    try {
        return await opgg.getProfile(name, tag, region);
    } catch (e) {
        // A "not found" from OP.GG is the more useful message; otherwise prefer
        // the Riot API's error if it ran (e.g. bad key) since that's actionable.
        if (riotError && !/not found/i.test(e.message)) throw riotError;
        throw e;
    }
}

async function getStats(region, riotId, force) {
    const parsed = opgg.parseRiotIdInput(riotId);
    if (!parsed) return { tier: 'N/A' };
    const { gameName: name, tagLine: tag } = parsed;
    await championData.whenReady();

    const cached = readCachedStats(riotId, region);

    // ── Strategy 1: LCU ────────────────────────────────────────────────────
    if (lcu.connected && await lcuServes(region)) {
        try {
            const lcuResult = await statsFromLcu(name, tag);
            if (lcuResult) {
                // Keep the champion badges from the last online lookup.
                const result = { ...lcuResult, masteryChampions: cached?.masteryChampions || [] };
                if (cached?.topChampions) result.topChampions = cached.topChampions;
                saveCachedStats(riotId, region, result);
                recordRankSnapshot(riotId, result.rawTier, result.rawDivision, result.rawLp);
                return result;
            }
        } catch (e) {
            console.log('[Stats] LCU lookup failed:', e.message);
        }
    }

    // ── Strategy 2: Cache (≤ 30 minutes old) ─────────────────────────────────
    if (!force && cached && isFresh(cached)) {
        return { ...cached, source: 'cache' };
    }

    // ── Strategy 3: Riot API / OP.GG ───────────────────────────────────────
    try {
        const result = await statsFromOnline(name, tag, region);
        console.log(`[Stats] ${riotId}: ${result.tier} ${result.lp} (${result.source})`);
        saveCachedStats(riotId, region, result);
        recordRankSnapshot(riotId, result.rawTier, result.rawDivision, result.rawLp);
        return result;
    } catch (e) {
        console.error('[Stats] lookup error:', e.message);
        // Stale data beats no data — show the last known stats with the error.
        if (cached) return { ...cached, source: 'cache', stale: true, error: e.message };
        return { tier: 'N/A', lp: '', winLose: '', ratio: '', iconSrc: defaultIcon(), level: '', error: e.message };
    }
}

async function getMatchHistory(region, riotId) {
    const parsed = opgg.parseRiotIdInput(riotId);
    if (!parsed) return { matches: [] };
    const { gameName: name, tagLine: tag } = parsed;
    await championData.whenReady();

    if (riotApi.getApiKey() && norm(region) !== 'cn') {
        try {
            const { account, platform } = await riotApi.getAccountByRiotId(name, tag, region);
            const matches = await riotApi.getMatchHistory(account.puuid, platform, 5);
            const idToName  = championData.getIdToNameMap();
            const idToImage = championData.getIdToImageMap();
            return {
                matches: matches.map((m) => {
                    // match-v5's championName is not always the DDragon key
                    // ("FiddleSticks"); the numeric id is reliable.
                    const key = idToName[m.championId] || m.championName;
                    return {
                        win: m.win,
                        kda: m.kda,
                        championName: key,
                        championIcon: idToImage[key] || null,
                    };
                }),
            };
        } catch (e) {
            console.log('[MatchHistory] Riot API failed, trying OP.GG:', e.message);
        }
    }
    try {
        return { matches: await opgg.getRecentMatches(name, tag, region, 5) };
    } catch (e) {
        return { error: e.message };
    }
}

function register() {
    // The account list re-renders while results arrive, and the profile modal
    // asks again for the card it was opened from: identical calls share one run.
    const inFlight = new Map();
    ipcMain.handle('get-stats', (event, { region, riotId, force } = {}) => {
        const key = `${norm(region)}|${norm(riotId)}|${force ? 1 : 0}`;
        if (inFlight.has(key)) return inFlight.get(key);
        const p = getStats(region, riotId, !!force).finally(() => inFlight.delete(key));
        inFlight.set(key, p);
        return p;
    });

    ipcMain.handle('get-rank-history', (event, riotId) => getRankHistory(riotId));

    // On-demand only (profile modal), not per-card.
    ipcMain.handle('get-match-history', (event, { region, riotId } = {}) => getMatchHistory(region, riotId));

    // Quick-add lookup: accepts "Name#TAG" or an OP.GG profile link, returns a
    // preview (icon, level, rank, top champions) plus the normalised Riot ID
    // and region so the form can be filled in one step.
    ipcMain.handle('lookup-summoner', async (event, { input, region } = {}) => {
        const parsed = opgg.parseRiotIdInput(input);
        if (!parsed) return { success: false, message: 'Enter a Riot ID like Name#TAG or paste an OP.GG profile link' };
        const useRegion = (parsed.region || region || '').toLowerCase();
        if (!useRegion) return { success: false, message: 'Pick a region first' };
        if (useRegion === 'cn') return { success: false, message: 'CN accounts can\'t be looked up online — enter the details manually' };
        await championData.whenReady();
        try {
            const profile = await statsFromOnline(parsed.gameName, parsed.tagLine, useRegion);
            const riotIdOut = profile.riotId || `${parsed.gameName}#${parsed.tagLine}`;
            return { success: true, region: useRegion, ...profile, riotId: riotIdOut };
        } catch (e) {
            return { success: false, message: e.message };
        }
    });

    // Reads Riot ID / region / login name of whoever is signed into the
    // running League client, for one-click "import from client".
    ipcMain.handle('get-client-summoner', async () => {
        if (!lcu.connected) return { success: false, message: 'League client is not running' };
        const [me, regionLocale, session] = await Promise.all([
            lcu.request('GET', '/lol-summoner/v1/current-summoner'),
            lcu.request('GET', '/riotclient/region-locale'),
            lcu.request('GET', '/lol-login/v1/session'),
        ]);
        if (!me?.gameName) return { success: false, message: 'Not signed in to the League client yet' };
        await championData.whenReady();
        const region = LCU_REGION_TO_APP[(regionLocale?.region || regionLocale?.webRegion || '').toLowerCase()] || '';
        return {
            success:  true,
            riotId:   `${me.gameName}#${me.tagLine}`,
            gameName: me.gameName,
            region,
            username: session?.username || '',
            iconSrc:  profileIconUrl(me.profileIconId),
            level:    me.summonerLevel?.toString() || '',
        };
    });
}

module.exports = { register, LCU_REGION_TO_APP, getClientRegion };
