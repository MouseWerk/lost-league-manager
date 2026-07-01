const { ipcMain, screen } = require('electron');
const lcu = require('../lcu');
const state = require('../state');
const championData = require('../services/champion-data');
const riotApi = require('../services/riot-api');
const { getBuilds } = require('../services/builds-api');
const { saveConfig } = require('../services/storage');

// Cached for the lifetime of the LCU connection — cheap local lookup, no need
// to re-query it for every bulk ranked fetch.
let cachedLcuRegion = null;
lcu.onDisconnect(() => { cachedLcuRegion = null; });

async function getLcuRegion() {
    if (cachedLcuRegion) return cachedLcuRegion;
    try {
        const info = await lcu.request('GET', '/riotclient/region-locale');
        cachedLcuRegion = (info?.region || '').toLowerCase() || null;
    } catch {
        cachedLcuRegion = null;
    }
    return cachedLcuRegion;
}

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

    // ── Opacity ────────────────────────────────────────────────────────────────
    ipcMain.handle('overlay-set-opacity', (_, opacity) => {
        const val = Math.max(0.1, Math.min(1.0, Number(opacity) || 1.0));
        if (state.overlayWindow && !state.overlayWindow.isDestroyed()) {
            state.overlayWindow.setOpacity(val);
        }
        state.config.overlayOpacity = val;
        saveConfig();
    });

    // ── Settings ───────────────────────────────────────────────────────────────
    ipcMain.handle('overlay-save-settings', (_, settings) => {
        if (settings.hotkey !== undefined && settings.hotkey !== state.config.overlayHotkey) {
            try {
                const { registerOverlayHotkey } = require('../overlay-hotkey');
                registerOverlayHotkey(settings.hotkey);
                state.config.overlayHotkey = settings.hotkey;
                saveConfig();
            } catch (e) {
                console.error('[Overlay] Hotkey re-register failed:', e.message);
            }
        }
        if (settings.locked      !== undefined) state.config.overlayLocked      = settings.locked;
        if (settings.showRanked  !== undefined) state.config.overlayShowRanked  = settings.showRanked;
        if (settings.showBuilds  !== undefined) state.config.overlayShowBuilds  = settings.showBuilds;
        saveConfig();
        // Push UI updates back to the overlay
        if (state.overlayWindow && !state.overlayWindow.isDestroyed()) {
            state.overlayWindow.webContents.send('overlay-settings-update', {
                showRanked: state.config.overlayShowRanked !== false,
                showBuilds: state.config.overlayShowBuilds !== false,
                locked:     state.config.overlayLocked     || false,
            });
        }
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

        const EMPTY = { tier: 'Unranked', lp: '', winLose: '', ratio: '' };
        // Marks a lookup that couldn't be resolved (as opposed to a resolved-but-
        // actually-unranked player) so the overlay knows it's worth retrying.
        const FAILED = { ...EMPTY, failed: true };

        await Promise.allSettled(players.map(async (p) => {
            const name = p.gameName || p.summonerName;
            if (!name) return;
            // Key by full Riot ID (name#tag) so two players sharing a game name but
            // different taglines don't clobber each other's cached ranked data.
            const key = p.tagLine ? `${name}#${p.tagLine}` : name;
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
                    results[key]   = formatLcuRanked(soloData) || EMPTY;
                    return;
                }

                // The LCU hasn't cached this Riot ID locally yet (common for
                // lobby/champ-select opponents it hasn't looked up before). Fall
                // back to the Riot Developer API, same as the account-manager's
                // own stats lookup, instead of silently reporting "Unranked".
                if (p.gameName && p.tagLine && state.config.riotApiKey) {
                    try {
                        const region = await getLcuRegion();
                        const apiResult = await riotApi.getStats(p.gameName, p.tagLine, region);
                        results[key] = {
                            tier:    apiResult.tier,
                            lp:      apiResult.lp,
                            winLose: apiResult.winLose,
                            ratio:   apiResult.ratio,
                        };
                        return;
                    } catch (e) {
                        console.log(`[Overlay Ranked] ${key} API fallback failed:`, e.message);
                        results[key] = FAILED;
                        return;
                    }
                }

                results[key] = FAILED;
            } catch (e) {
                console.log(`[Overlay Ranked] ${key}:`, e.message);
                results[key] = FAILED;
            }
        }));

        return results;
    });

    // ── Build data (from OP.GG JSON API) ──────────────────────────────────────
    ipcMain.handle('overlay-get-builds', async (event, { champKey, gameMode, position } = {}) => {
        if (!champKey) return null;
        return await getBuilds(champKey, gameMode, position);
    });

    // ── LCU overview (main window dashboard) ──────────────────────────────────
    ipcMain.handle('get-lcu-overview', async () => {
        if (!lcu.connected) return { connected: false };
        try {
            const [summoner, ranked, gameflow, matches, honor] = await Promise.all([
                lcu.request('GET', '/lol-summoner/v1/current-summoner'),
                lcu.request('GET', '/lol-ranked/v1/current-ranked-stats'),
                lcu.request('GET', '/lol-gameflow/v1/gameflow-phase'),
                lcu.request('GET', '/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=9'),
                lcu.request('GET', '/lol-honor-v2/v1/profiles'),
            ]);

            // Mastery: try several endpoint variants; last resort fetches all and sorts
            let mastery = null;
            const masteryTries = [
                '/lol-champion-mastery/v1/local-player/top-champion-masteries?count=8',
                summoner?.puuid
                    ? `/lol-champion-mastery/v1/champion-masteries/by-puuid/${summoner.puuid}/top?count=8`
                    : null,
                summoner?.puuid
                    ? `/lol-champion-mastery/v1/players/${summoner.puuid}/champion-mastery/top?count=8`
                    : null,
                '/lol-champion-mastery/v1/champion-masteries/top?count=8',
            ].filter(Boolean);

            for (const ep of masteryTries) {
                const res = await lcu.request('GET', ep);
                if (Array.isArray(res) && res.length > 0) { mastery = res; break; }
            }

            // Last resort: fetch all masteries and sort manually
            if (!mastery || mastery.length === 0) {
                const all = await lcu.request('GET', '/lol-champion-mastery/v1/champion-masteries');
                if (Array.isArray(all) && all.length > 0) {
                    mastery = all
                        .sort((a, b) => (b.championPoints || 0) - (a.championPoints || 0))
                        .slice(0, 8);
                }
            }

            console.log(`[Mastery] fetched ${mastery?.length ?? 0} champions`);

            // Context data — depends on current phase
            let lobby = null, queueSearch = null, liveGame = null;
            if (gameflow === 'Lobby') {
                lobby = await lcu.request('GET', '/lol-lobby/v2/lobby');
            } else if (gameflow === 'Matchmaking') {
                queueSearch = await lcu.request('GET', '/lol-matchmaking/v1/search');
            } else if (gameflow === 'InProgress') {
                // Live client data runs on port 2999, no auth required
                try {
                    const axios = require('axios');
                    const r = await axios.get('http://127.0.0.1:2999/liveclientdata/activeplayer', { timeout: 2000 });
                    liveGame = r.data;
                } catch { /* client data not available yet */ }
            }

            return {
                connected: true,
                summoner, ranked, gameflow,
                matches: matches?.games?.games || [],
                mastery: Array.isArray(mastery) ? mastery : [],
                honor, lobby, queueSearch, liveGame,
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
