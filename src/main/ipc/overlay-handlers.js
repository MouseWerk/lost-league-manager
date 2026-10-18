const { ipcMain, screen } = require('electron');
const lcu = require('../lcu');
const state = require('../state');
const championData = require('../services/champion-data');
const axios = require('axios');
const riotApi = require('../services/riot-api');
const opgg = require('../services/opgg-api');
const { getBuilds } = require('../services/builds-api');
const { saveConfig } = require('../services/storage');
const { recordHonorLevel } = require('../services/honor-watch');
// App region of the running client (cached per LCU connection), or null /
// "unknown:<raw>" when it can't be mapped (PBE, ...).
const { getClientRegion } = require('./stats');

const ONLINE_REGION = /^[a-z]+$/;

// Solo rank for a lobby player the LCU doesn't know yet: Riot API (2 requests)
// when a key is set, otherwise or on failure OP.GG.
async function onlineSoloRank(gameName, tagLine, region) {
    if (riotApi.getApiKey()) {
        try {
            return await riotApi.getSoloRank(gameName, tagLine, region);
        } catch (e) {
            console.log(`[Overlay Ranked] ${gameName}#${tagLine} Riot API failed:`, e.message);
        }
    }
    const profile = await opgg.getProfile(gameName, tagLine, region);
    return { tier: profile.tier, lp: profile.lp, winLose: profile.winLose, ratio: profile.ratio };
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
                // back to the online sources instead of silently reporting
                // "Unranked" — but only for a server they cover.
                if (p.gameName && p.tagLine) {
                    const region = await getClientRegion();
                    if (!region || !ONLINE_REGION.test(region) || region === 'cn') {
                        results[key] = FAILED;
                        return;
                    }
                    try {
                        results[key] = await onlineSoloRank(p.gameName, p.tagLine, region);
                    } catch (e) {
                        console.log(`[Overlay Ranked] ${key} online fallback failed:`, e.message);
                        results[key] = FAILED;
                    }
                    return;
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

            // Mastery: try several endpoint variants (they differ by LCU/client
            // version — see git history for this file); last resort fetches
            // everything and sorts client-side. Candidates within each group are
            // fetched concurrently (order of `endpoints` still decides which
            // result wins if more than one succeeds) rather than one at a time,
            // since they're independent GETs to the same local server and only
            // the first valid one is used.
            const isMasteryList = (res) =>
                Array.isArray(res) && res.length > 0 && res.every(m => m && typeof m.championId === 'number');

            async function firstValidMasteryList(endpoints) {
                if (endpoints.length === 0) return null;
                const results = await Promise.all(endpoints.map(ep => lcu.request('GET', ep)));
                return results.find(isMasteryList) || null;
            }

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

            let mastery = await firstValidMasteryList(masteryTries);

            // Last resort: these two return everything for the current summoner
            // (unsorted, unfiltered), so there's no path-shape to get wrong —
            // just sort client-side and take the top 8.
            if (!mastery) {
                const all = await firstValidMasteryList([
                    '/lol-champion-mastery/v1/local-player/champion-mastery',
                    '/lol-champion-mastery/v1/champion-masteries',
                ]);
                if (all) {
                    mastery = [...all].sort((a, b) => (b.championPoints || 0) - (a.championPoints || 0)).slice(0, 8);
                }
            }

            // Every candidate above is a guess at the real endpoint for this
            // client version — individual 404s are expected and not logged, but
            // if every single one failed that's worth knowing about.
            if (!mastery) {
                console.warn('[Mastery] all candidate endpoints failed or returned no usable data for this client version');
            }
            console.log(`[Mastery] fetched ${mastery?.length ?? 0} champions`);

            // Context data — depends on current phase
            let lobby = null, queueSearch = null, liveGame = null;
            if (gameflow === 'Lobby') {
                lobby = await lcu.request('GET', '/lol-lobby/v2/lobby');
            } else if (gameflow === 'Matchmaking') {
                queueSearch = await lcu.request('GET', '/lol-matchmaking/v1/search');
            } else if (gameflow === 'InProgress') {
                // Live client data runs on port 2999, no auth required. The
                // game clock is in gamestats, HP in activeplayer.
                try {
                    const [player, stats] = await Promise.all([
                        axios.get('http://127.0.0.1:2999/liveclientdata/activeplayer', { timeout: 2000 }),
                        axios.get('http://127.0.0.1:2999/liveclientdata/gamestats', { timeout: 2000 }),
                    ]);
                    liveGame = { ...player.data, gameTime: stats.data?.gameTime };
                } catch { /* client data not available yet */ }
            }

            // state.currentAccount is only ever set by launching an account
            // through this app and is never corrected afterward — if the user
            // manually switches to a different account directly in the Riot
            // Client, it silently goes stale. Verify it against the summoner we
            // actually just fetched before trusting it, so a stale value can't
            // attribute one account's honor data to a different account's record.
            const loggedInRiotId = summoner?.gameName && summoner?.tagLine
                ? `${summoner.gameName}#${summoner.tagLine}`.toLowerCase()
                : null;
            const isCurrentAccountReallyLoggedIn = loggedInRiotId
                && state.currentAccount?.riotId?.toLowerCase() === loggedInRiotId;
            if (typeof honor?.honorLevel === 'number' && isCurrentAccountReallyLoggedIn) {
                recordHonorLevel(state.currentAccount.username, honor.honorLevel);
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
