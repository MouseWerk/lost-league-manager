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
    createOverlayWindow(state.owOverlayPackage || null, () => {
        creating = false;
        require('./overlay-hotkey').registerOverlayHotkey(state.config.overlayHotkey || 'Ctrl+Shift+H');
    });
}

// Switched off: the window and hotkey go away.
function destroyOverlay() {
    stopPolling();
    if (overlayAlive()) state.overlayWindow.destroy();
    state.overlayWindow = null;
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
    if (phase === 'InProgress') startPolling();
    else stopPolling();
}

module.exports = { ensureOverlay, destroyOverlay, liveDataToGepUpdates, markGepLive, onGameflowPhase, pollOnce, stopPolling };
