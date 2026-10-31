const state = require('./state');
const liveClient = require('./services/live-client');

// The in-game overlay window, its hotkey, and its data when Overwolf's game
// events (GEP) are missing: then the Live Client Data API is read every two
// seconds and sent in the same shape GEP uses, so overlay.js reads one format.

const POLL_MS = 2000;
// GEP counts as delivering while its last live data is this recent.
const GEP_FRESH_MS = 6000;

let creating = false;
let pollTimer = null;

function overlayAlive() {
    return !!state.overlayWindow && !state.overlayWindow.isDestroyed();
}

// Creates the window when the overlay is switched on (Settings > Game
// overlay); safe to call again. The hotkey is registered once it exists.
function ensureOverlay() {
    if (!state.config.overlayEnabled || overlayAlive() || creating) return;
    creating = true;
    const { createOverlayWindow } = require('./windows');
    // After Overwolf could not inject into the game, a plain window it is.
    const ow = state.overlayInjectionFailed ? null : state.owOverlayPackage || null;
    createOverlayWindow(ow, () => {
        creating = false;
        require('./overlay-hotkey').registerOverlayHotkey(state.config.overlayHotkey || 'Ctrl+Shift+H');
        showIfInGame();
    });
}

// Shows the overlay in a running game, any mode (practice tool included).
// A game that was already running when the app started never sends
// Overwolf's game-launched, so injection is asked for here as well.
function showIfInGame() {
    if (!state.config.overlayEnabled || !overlayAlive() || state.gameflowPhase !== 'InProgress') return;
    const ow = state.owOverlayPackage;
    if (state.overlayViaOverwolf && ow && typeof ow.requestGameInjection === 'function') {
        Promise.resolve()
            .then(() => ow.requestGameInjection(state.LOL_GEP_GAME_ID))
            .catch((e) => {
                console.warn('[Overlay] requestGameInjection failed:', e?.message || e);
                useWindowFallback();
            });
    }
    state.overlayWindow.show();
}

// Overwolf did not get into the game (its game service is missing or does
// not see the game): its window would stay invisible. Open the overlay as a
// plain always-on-top window instead (borderless or windowed game).
function useWindowFallback() {
    if (state.overlayInjectionFailed || !state.config.overlayEnabled) return;
    state.overlayInjectionFailed = true;
    console.log('[Overlay] Using a plain window instead of Overwolf injection');
    if (overlayAlive()) state.overlayWindow.destroy();
    state.overlayWindow = null;
    creating = false;
    ensureOverlay();
}

// Switched off: the window and hotkey go away.
function destroyOverlay() {
    stopPolling();
    if (overlayAlive()) state.overlayWindow.destroy();
    state.overlayWindow = null;
    creating = false;
    require('./overlay-hotkey').registerOverlayHotkey(null);
}

// Live Client Data (allgamedata) as GEP info updates.
function liveDataToGepUpdates(all) {
    if (!all || typeof all !== 'object') return [];
    const out = [{ feature: 'matchState', key: 'matchState', value: 'InProgress' }];
    const add = (key, value) => {
        if (value !== undefined && value !== null) out.push({ feature: 'live_client_data', key, value: JSON.stringify(value) });
    };
    add('game_data', all.gameData);
    add('active_player', all.activePlayer);
    add('all_players', Array.isArray(all.allPlayers) ? all.allPlayers : undefined);
    return out;
}

function markGepLive() {
    state.lastGepLiveAt = Date.now();
}

async function pollOnce() {
    if (!overlayAlive()) return stopPolling();
    if (Date.now() - (state.lastGepLiveAt || 0) < GEP_FRESH_MS) return;
    let all;
    try {
        all = await liveClient.liveClientGet('allgamedata');
    } catch {
        return; // still loading, or the game just ended
    }
    if (!overlayAlive()) return;
    for (const update of liveDataToGepUpdates(all)) state.overlayWindow.webContents.send('gep-info-update', update);
}

function startPolling() {
    if (pollTimer || !overlayAlive()) return;
    pollTimer = setInterval(pollOnce, POLL_MS);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
}

function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
}

// From the gameflow phase (lcu-events.js): read live data only in a game.
function onGameflowPhase(phase) {
    state.gameflowPhase = phase;
    if (phase === 'InProgress') {
        ensureOverlay();
        showIfInGame();
        startPolling();
    } else {
        stopPolling();
    }
}

module.exports = { ensureOverlay, showIfInGame, useWindowFallback, destroyOverlay, liveDataToGepUpdates, markGepLive, onGameflowPhase, pollOnce, stopPolling };
