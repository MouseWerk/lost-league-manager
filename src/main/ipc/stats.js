const { ipcMain } = require('electron');
const lcu = require('../lcu');
const state = require('../state');
const { loadAccounts, saveAccounts } = require('../services/storage');
const riotApi = require('../services/riot-api');
const championData = require('../services/champion-data');

function capFirst(s) {
    return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : '';
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
    };
}

function defaultIcon() {
    const v = championData.getLatestVersion();
    return `https://ddragon.leagueoflegends.com/cdn/${v}/img/profileicon/29.png`;
}

function register() {
    ipcMain.handle('get-stats', async (event, { region, riotId }) => {
        if (!riotId?.includes('#')) return { tier: 'N/A' };
        const [name, tag] = riotId.trim().split('#');

        // ── Strategy 1: LCU ────────────────────────────────────────────────────
        if (lcu.connected) {
            try {
                const summoner = await lcu.request('GET',
                    `/lol-summoner/v2/summoners/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`
                );
                if (summoner?.puuid) {
                    const ranked    = await lcu.request('GET', `/lol-ranked/v1/ranked-stats/${summoner.puuid}`);
                    const soloData  = ranked?.RANKED_SOLO_5x5;
                    const formatted = formatLcuRanked(soloData) || { tier: 'Unranked', lp: '', winLose: '', ratio: '' };
                    const v         = championData.getLatestVersion();
                    const result    = {
                        success: true,
                        ...formatted,
                        iconSrc: summoner.profileIconId
                            ? `https://ddragon.leagueoflegends.com/cdn/${v}/img/profileicon/${summoner.profileIconId}.png`
                            : defaultIcon(),
                        level:  summoner.summonerLevel?.toString() || '',
                        source: 'lcu',
                    };

                    // Cache result for offline fallback
                    try {
                        const accs = loadAccounts();
                        const idx  = accs.findIndex(a => a.riotId === riotId);
                        if (idx >= 0) {
                            accs[idx]._cachedStats = { ...result, ts: Date.now() };
                            saveAccounts(accs);
                        }
                    } catch { /* non-critical */ }

                    return result;
                }
            } catch (e) {
                console.log('[Stats] LCU lookup failed:', e.message);
            }
        }

        // ── Strategy 2: Cache (≤ 6 hours old) ─────────────────────────────────
        try {
            const acc    = loadAccounts().find(a => a.riotId === riotId);
            const cached = acc?._cachedStats;
            if (cached && Date.now() - cached.ts < 6 * 3600 * 1000) {
                console.log(`[Stats] ${riotId}: serving ${Math.round((Date.now() - cached.ts) / 60000)}min-old cache`);
                return { ...cached, source: 'cache' };
            }
        } catch { /* non-critical */ }

        // ── Strategy 3: Riot Games API ─────────────────────────────────────────
        try {
            const result = await riotApi.getStats(name, tag, region);
            console.log(`[Stats] ${riotId}: ${result.tier} ${result.lp} (riot-api)`);

            // Cache for next time
            try {
                const accs = loadAccounts();
                const idx  = accs.findIndex(a => a.riotId === riotId);
                if (idx >= 0) {
                    accs[idx]._cachedStats = { ...result, ts: Date.now() };
                    saveAccounts(accs);
                }
            } catch { /* non-critical */ }

            return result;
        } catch (e) {
            console.error('[Stats] Riot API error:', e.message);
        }

        return { tier: 'Unranked', lp: '', winLose: '', ratio: '', iconSrc: defaultIcon(), level: '' };
    });
}

module.exports = { register };
