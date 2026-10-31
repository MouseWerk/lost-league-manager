const path = require('path');
const childProcess = require('child_process');
const state = require('./state');
const liveClient = require('./services/live-client');

// The in-game overlay: its window, its hotkey, when it is visible, and its
// data when Overwolf's game events (GEP) are missing (then the Live Client
// Data API is read every two seconds and sent in the same shape GEP uses).
//
// Visible only while a game runs, the overlay is switched on, the player has
// not hidden it with the hotkey, and the game is in front: Overwolf draws its
// window inside the game; the plain-window fallback follows the foreground
// window (foreground-watch.ps1), so it never floats over other apps. It is
// shown without taking the focus from the game.

const POLL_MS = 2000;
// GEP counts as delivering while its last live data is this recent.
const GEP_FRESH_MS = 6000;
const GAME_PROCESS = 'League of Legends';

let creating = false;
let pollTimer = null;
let userHidden = false;   // hidden with the hotkey until the next game
let gameInFront = false;  // plain-window mode: League is the foreground window
let overlayFocused = false;
let watcher = null;

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
        trackOverlayFocus();
        require('./overlay-hotkey').registerOverlayHotkey(state.config.overlayHotkey || 'Ctrl+Shift+H');
        showIfInGame();
    });
}

// Switched off: the window and hotkey go away.
function destroyOverlay() {
    stopPolling();
    stopWatcher();
    if (overlayAlive()) state.overlayWindow.destroy();
    state.overlayWindow = null;
    creating = false;
    require('./overlay-hotkey').registerOverlayHotkey(null);
}

function inGame() {
    return state.gameflowPhase === 'InProgress';
}

// Whether the overlay should be on screen now.
function shouldShow() {
    if (!state.config.overlayEnabled || !overlayAlive() || !inGame() || userHidden) return false;
    if (state.overlayViaOverwolf) return true; // drawn inside the game only
    return gameInFront || overlayFocused;
}

function applyVisibility() {
    if (!overlayAlive()) return;
    const win = state.overlayWindow;
    if (shouldShow()) {
        if (!win.isVisible?.()) {
            // showInactive keeps the keyboard and mouse with the game.
            if (typeof win.showInactive === 'function') win.showInactive();
            else win.show();
        }
    } else if (win.isVisible?.() !== false) {
        win.hide?.();
    }
}

// A game is running (any mode, practice tool included): ask Overwolf to get
// into it, or follow the foreground window in plain-window mode.
function showIfInGame() {
    if (!state.config.overlayEnabled || !overlayAlive() || !inGame()) return applyVisibility();
    const ow = state.owOverlayPackage;
    if (state.overlayViaOverwolf && ow && typeof ow.requestGameInjection === 'function') {
        Promise.resolve()
            .then(() => ow.requestGameInjection(state.LOL_GEP_GAME_ID))
            .catch((e) => {
                console.warn('[Overlay] requestGameInjection failed:', e?.message || e);
                useWindowFallback();
            });
    }
    if (!state.overlayViaOverwolf) startWatcher();
    applyVisibility();
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

// The hotkey hides and shows it; hidden stays hidden for the rest of the game.
function toggleByHotkey() {
    userHidden = !userHidden;
    applyVisibility();
}

// ── Foreground window (plain-window mode) ───────────────────────────────────

// One line of foreground-watch.ps1: "<pid>|<name>".
function isGameInFront(line) {
    const name = String(line).split('|')[1] || '';
    return name.trim() === GAME_PROCESS;
}

function onForegroundLine(line) {
    gameInFront = isGameInFront(line);
    applyVisibility();
}

function startWatcher() {
    if (watcher) return;
    const script = path.join(state.RESOURCES_PATH, 'scripts', 'foreground-watch.ps1');
    try {
        watcher = childProcess.spawn('powershell.exe', [
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-ParentPid', String(process.pid),
        ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch (e) {
        console.warn('[Overlay] Foreground watch could not start:', e.message);
        gameInFront = true; // better shown over everything than never
        return;
    }
    let buffer = '';
    watcher.stdout?.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        for (const line of lines) if (line.trim()) onForegroundLine(line);
    });
    watcher.on('error', (e) => {
        console.warn('[Overlay] Foreground watch failed:', e.message);
        watcher = null;
        gameInFront = true;
        applyVisibility();
    });
    watcher.on('close', () => { watcher = null; });
}

function stopWatcher() {
    if (watcher) {
        try { watcher.kill(); } catch { /* already gone */ }
    }
    watcher = null;
    gameInFront = false;
}

// Clicking the overlay brings it to the front; it stays while it has focus.
function trackOverlayFocus() {
    const win = state.overlayWindow;
    if (typeof win?.on !== 'function') return;
    win.on('focus', () => { overlayFocused = true; applyVisibility(); });
    win.on('blur', () => { overlayFocused = false; setTimeout(applyVisibility, 50); });
}

// ── Live Client data ────────────────────────────────────────────────────────

// Live Client data (allgamedata) as GEP info updates.
function liveDataToGepUpdates(all) {
    if (!all || typeof all !== 'object') return [];
    const out = [{ feature: 'matchState', key: 'matchState', value: 'InProgress' }];
    const add = (key, value) => {
        if (value !== undefined && value !== null) out.push({ feature: 'live_client_data', key, value: JSON.stringify(value) });
    };
    add('game_data', all.gameData);
    add('active_player', all.activePlayer);
    add('all_players', Array.isArray(all.allPlayers) ? all.allPlayers : undefined);
    add('events', all.events);
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

// From the gameflow phase (lcu-events.js).
function onGameflowPhase(phase) {
    const wasInGame = inGame();
    state.gameflowPhase = phase;
    if (inGame()) {
        if (!wasInGame) userHidden = false; // a new game shows it again
        ensureOverlay();
        showIfInGame();
        startPolling();
    } else {
        stopPolling();
        stopWatcher();
        applyVisibility();
        if (overlayAlive() && wasInGame) {
            state.overlayWindow.webContents.send('gep-info-update', { feature: 'matchState', key: 'matchState', value: 'EndOfGame' });
        }
    }
}

module.exports = {
    ensureOverlay, destroyOverlay, showIfInGame, applyVisibility, shouldShow, useWindowFallback, toggleByHotkey,
    isGameInFront, onForegroundLine, liveDataToGepUpdates, markGepLive, onGameflowPhase, pollOnce, stopPolling,
};
