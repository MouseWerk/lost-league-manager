const { ipcMain, screen } = require('electron');
const lcu = require('../lcu');
const state = require('../state');
const championData = require('../services/champion-data');
const { getBuilds } = require('../services/builds-api');

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

function register() {
    // ── Window controls ────────────────────────────────────────────────────────
    ipcMain.on('overlay-interactive', (_, on) => {
        if (state.overlayWindow && !state.overlayWindow.isDestroyed()) {
            state.overlayWindow.setIgnoreMouseEvents(!on, { forward: true });
        }
    });

    ipcMain.on('overlay-start-dragging', () => {
        if (state.overlayWindow && !state.overlayWindow.isDestroyed() && typeof state.overlayWindow.startDragging === 'function') {
            state.overlayWindow.startDragging();
        }
    });

    ipcMain.on('overlay-move', (_, x, y) => {
        if (state.overlayWindow && !state.overlayWindow.isDestroyed()) {
            state.overlayWindow.setPosition(Math.round(x), Math.round(y));
        }
    });

    ipcMain.on('overlay-resize', (_, w, h) => {
        if (state.overlayWindow && !state.overlayWindow.isDestroyed()) {
            state.overlayWindow.setSize(Math.round(w), Math.round(h));
        }
    });

    ipcMain.handle('overlay-get-position', () => {
        if (!state.overlayWindow || state.overlayWindow.isDestroyed()) return { x: 0, y: 0 };
        const [x, y] = state.overlayWindow.getPosition();
        return { x, y };
    });

    ipcMain.handle('overlay-reset-position', () => {
        if (!state.overlayWindow || state.overlayWindow.isDestroyed()) return;
        const { width: sw } = screen.getPrimaryDisplay().workAreaSize;
        state.overlayWindow.setSize(480, 52);
        state.overlayWindow.setPosition(sw - 480 - 16, 16);
    });

    // ── Ranked bulk (for overlay ranked panel) ─────────────────────────────────
    ipcMain.handle('overlay-get-ranked-bulk', async (event, players) => {
        const results = {};
        if (!lcu.connected || !Array.isArray(players)) return results;

        for (const p of players) {
            const key = p.gameName || p.summonerName;
            if (!key) continue;
            try {
                let summoner = null;

                if (p.gameName && p.tagLine) {
                    try {
                        summoner = await lcu.request('GET',
                            `/lol-summoner/v2/summoners/by-riot-id/${encodeURIComponent(p.gameName)}/${encodeURIComponent(p.tagLine)}`
                        );
                    } catch { /* try fallback */ }
                }

                if (!summoner?.puuid && p.summonerName) {
                    try {
                        const res = await lcu.request('GET',
                            `/lol-summoner/v1/summoners?name=${encodeURIComponent(p.summonerName)}`
                        );
                        summoner = Array.isArray(res) ? res[0] : res;
                    } catch { /* skip */ }
                }

                if (summoner?.puuid) {
                    const ranked   = await lcu.request('GET', `/lol-ranked/v1/ranked-stats/${summoner.puuid}`);
                    const soloData = ranked?.RANKED_SOLO_5x5;
                    results[key]   = formatLcuRanked(soloData) || { tier: 'Unranked', lp: '', winLose: '', ratio: '' };
                } else {
                    results[key] = { tier: 'Unranked', lp: '', winLose: '', ratio: '' };
                }
            } catch (e) {
                console.log(`[Overlay Ranked] ${key}:`, e.message);
                results[key] = { tier: 'Unranked', lp: '', winLose: '', ratio: '' };
            }
        }
        return results;
    });

    // ── Build data (from OP.GG JSON API) ──────────────────────────────────────
    ipcMain.handle('overlay-get-builds', async (event, champKey) => {
        if (!champKey) return null;
        return await getBuilds(champKey);
    });

    // ── LCU overview (main window dashboard) ──────────────────────────────────
    ipcMain.handle('get-lcu-overview', async () => {
        if (!lcu.connected) return { connected: false };
        try {
            const results = await Promise.allSettled([
                lcu.request('GET', '/lol-summoner/v1/current-summoner'),
                lcu.request('GET', '/lol-ranked/v1/current-ranked-stats'),
                lcu.request('GET', '/lol-gameflow/v1/gameflow-phase'),
                lcu.request('GET', '/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=7'),
                lcu.request('GET', '/lol-champion-mastery/v1/top-champion-masteries/count/5'),
                lcu.request('GET', '/lol-honor-v2/v1/profiles'),
            ]);
            const [summoner, ranked, gameflow, matches, mastery, honor] = results.map(r => r.value ?? null);
            return {
                connected: true,
                summoner, ranked, gameflow, matches, mastery, honor,
                ddragonVersion: championData.getLatestVersion(),
                idToNameMap:    championData.getIdToNameMap(),
            };
        } catch (e) {
            console.error('[LCU Overview]', e.message);
            return { connected: false };
        }
    });
}

module.exports = { register };
