const { Notification } = require('electron');
const path  = require('path');
const lcu   = require('./lcu');
const state = require('./state');
const discordRpc = require('./services/discord-rpc');

// The login/summoner endpoints 404 for a few seconds while the client boots.
const BOOT_RETRIES = 6;
const BOOT_RETRY_MS = 5000;

const GAME_PHASES = new Set(['GameStart', 'InProgress', 'Reconnect']);
const OVERLAY_HIDE_PHASES = new Set(['None', 'Lobby', 'EndOfGame', 'WaitingForStats', 'PreEndOfGame']);

// Bumped on every connect and disconnect: work started for one connection
// (account detection, Riot ID linking) is dropped once it is stale.
let connectionSeq = 0;
// Bumped on every gameflow Update event, so the phase fetched on connect
// never overwrites a newer phase that arrived while it was in flight.
let phaseEventSeq = 0;
// Champion the random skin was rolled for in the current champ select.
let skinRolledFor = null;
// Set once auto-accept has answered the current ready check.
let readyCheckAccepted = false;
// Set once "minimize on game start" has hidden the window for this game.
let minimizedThisGame = false;

function send(win, channel, ...args) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function later(ms) {
    return new Promise((r) => {
        const t = setTimeout(r, ms);
        if (typeof t?.unref === 'function') t.unref();
    });
}

function sameUsername(a, b) {
    return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

async function setAppearOffline() {
    if (state.currentAccount?.appearOffline) {
        const result = await lcu.request('PUT', '/lol-chat/v1/me', { availability: 'offline' });
        if (result === null) console.error('[LCU] setAppearOffline failed');
    }
}

// Reads which account the client is signed in with and makes it the current
// account (or none, when it is not saved here). Done on every connect: the
// previous value can belong to an account that was launched earlier, failed,
// or was replaced by a manual sign-in, and its settings must not apply.
async function detectSignedInAccount(conn) {
    let session = null;
    for (let i = 0; i < BOOT_RETRIES; i++) {
        session = await lcu.request('GET', '/lol-login/v1/session');
        if (conn !== connectionSeq) return null;
        if (session?.username) break;
        await later(BOOT_RETRY_MS);
        if (conn !== connectionSeq) return null;
    }
    const { loadAccounts } = require('./services/storage');
    const matched = session?.username
        ? loadAccounts().find(a => sameUsername(a.username, session.username))
        : null;
    state.currentAccount = matched ? { ...matched } : null;
    send(state.mainWindow, 'active-account-detected', matched?.username ?? null);
    return matched?.username ?? null;
}

// If the signed-in account is saved here without a Riot ID/region, fill them
// in from the client so its card gets rank/icon/stats with no manual setup.
async function linkRiotIdFromClient(username, conn = connectionSeq) {
    if (!username) return;
    const { loadAccounts, saveAccounts } = require('./services/storage');
    const { broadcastAccountsUpdate } = require('./windows');
    const { LCU_REGION_TO_APP } = require('./ipc/stats');
    const findIn = (list) => list.find(a => sameUsername(a.username, username));
    const needsLink = (a) => a && (!a.riotId || !a.region);

    if (!needsLink(findIn(loadAccounts()))) return;

    let me = null;
    for (let i = 0; i < BOOT_RETRIES && !me?.gameName; i++) {
        me = await lcu.request('GET', '/lol-summoner/v1/current-summoner');
        if (conn !== connectionSeq) return;
        if (!me?.gameName) await later(BOOT_RETRY_MS);
        if (conn !== connectionSeq) return;
    }
    if (!me?.gameName) return;
    const rl = await lcu.request('GET', '/riotclient/region-locale');
    if (conn !== connectionSeq) return;
    const region = LCU_REGION_TO_APP[(rl?.region || rl?.webRegion || '').toLowerCase()] || '';

    // Re-read after the awaits (up to 30 s): saving the list loaded before
    // them reverted every add, delete, edit or reorder made in the meantime.
    const accounts = loadAccounts();
    const acc = findIn(accounts);
    if (!needsLink(acc)) return;
    if (!acc.riotId) acc.riotId = `${me.gameName}#${me.tagLine}`;
    if (!acc.region && region) acc.region = region;
    saveAccounts(accounts);
    if (sameUsername(state.currentAccount?.username, acc.username)) {
        state.currentAccount = { ...state.currentAccount, riotId: acc.riotId, region: acc.region };
    }
    broadcastAccountsUpdate();
    console.log(`[LCU] Linked ${acc.username} → ${acc.riotId} (${acc.region || '?'})`);
}

function applyGameflowPhase(phase, { fromEvent = false } = {}) {
    send(state.mainWindow, 'lcu-gameflow', phase);
    discordRpc.setGameflowPhase(phase);

    // Queue-pop toast notification (only for a live change, not on connect)
    if (fromEvent && phase === 'ReadyCheck' && state.config.toastOnQueuePop !== false) {
        try {
            const n = new Notification({
                title: 'Match Found!',
                body: 'Your queue has popped — ready to accept?',
                icon: path.join(__dirname, '../renderer/assets/logo.png'),
            });
            n.on('click', () => {
                if (state.mainWindow) { state.mainWindow.show(); state.mainWindow.focus(); }
            });
            n.show();
        } catch (e) {
            console.error('[Notify] Toast failed:', e.message);
        }
    }

    // Independent of the overlay (which is disabled and never created): this
    // used to sit inside the overlay branch and so never ran. Once per game,
    // so a window the user reopens mid-game stays open.
    if (phase === 'InProgress') {
        const win = state.mainWindow;
        if (state.config.minimizeOnGameStart && !minimizedThisGame && win && !win.isDestroyed()) {
            win.hide();
            minimizedThisGame = true;
        }
    } else if (!GAME_PHASES.has(phase)) {
        minimizedThisGame = false;
    }

    if (state.overlayWindow && !state.overlayWindow.isDestroyed()) {
        if (phase === 'InProgress') {
            if (state.config.overlayEnabled) state.overlayWindow.show();
        } else if (OVERLAY_HIDE_PHASES.has(phase)) {
            state.overlayWindow.hide();
        }
    }
}

async function onConnect() {
    const conn = ++connectionSeq;
    skinRolledFor = null;
    readyCheckAccepted = false;
    send(state.mainWindow, 'lcu-connected');

    const accountWork = (async () => {
        const username = await detectSignedInAccount(conn);
        if (conn !== connectionSeq) return;
        // Right away, not only when the next chat update arrives.
        await setAppearOffline();
        await linkRiotIdFromClient(username, conn);
    })().catch(e => console.log('[LCU] Account detection skipped:', e.message));

    const phaseWork = (async () => {
        const seqBefore = phaseEventSeq;
        const phase = await lcu.request('GET', '/lol-gameflow/v1/gameflow-phase');
        if (conn !== connectionSeq || !phase) return;
        if (phaseEventSeq !== seqBefore) return; // a newer Update event already applied
        applyGameflowPhase(phase);
    })().catch(e => console.log('[LCU] Gameflow phase skipped:', e.message));

    await Promise.all([accountWork, phaseWork]);
}

function onDisconnect() {
    connectionSeq++;
    skinRolledFor = null;
    readyCheckAccepted = false;
    state.currentAccount = null;
    send(state.mainWindow, 'lcu-disconnected');
    send(state.mainWindow, 'active-account-detected', null);
    discordRpc.setIdle();
}

async function rollRandomSkin(session) {
    const localCellId = session?.localPlayerCellId;
    const allActions  = Array.isArray(session?.actions) ? session.actions.flat() : [];
    const myPick      = allActions.find(
        a => a.actorCellId === localCellId && a.type === 'pick' && a.completed
    );
    // Once per pick: champ select keeps sending updates (timer, other
    // players' picks, trades) and each one used to roll a new skin,
    // overwriting the user's own choice a second later.
    if (!myPick?.championId || skinRolledFor === myPick.championId) return;
    skinRolledFor = myPick.championId;

    const skins = await lcu.request('GET', '/lol-champ-select/v1/skin-carousel-skins');
    const usable = Array.isArray(skins) ? skins.filter(s => s.ownership?.owned && !s.disabled) : [];
    if (!usable.length) return;
    const randomSkin = usable[Math.floor(Math.random() * usable.length)];
    const result = await lcu.request('PATCH', '/lol-champ-select/v1/session/my-selection', { selectedSkinId: randomSkin.id });
    if (result === null) console.error('[LCU] autoSkinRandom: selecting the skin failed');
}

async function onEvent(event) {
    try {
        // Gameflow phase → overlay visibility + notify renderer
        if (event.uri === '/lol-gameflow/v1/gameflow-phase' && event.eventType === 'Update') {
            phaseEventSeq++;
            applyGameflowPhase(event.data, { fromEvent: true });
        }

        // Auto-accept ready check, once per ready check: its updates repeat
        // (timer) until the response flips, and each one used to POST again.
        if (event.uri === '/lol-matchmaking/v1/ready-check') {
            const data = event.data;
            if (data?.state !== 'InProgress') {
                readyCheckAccepted = false;
            } else if (state.config.autoAccept && data.playerResponse === 'None' && !readyCheckAccepted) {
                readyCheckAccepted = true;
                console.log('[LCU] Auto-accepting match...');
                // lcu.request() never throws; it returns null on failure.
                const result = await lcu.request('POST', '/lol-matchmaking/v1/ready-check/accept', null, { verbose: true });
                if (result === null) {
                    console.error('[LCU] Auto-accept failed — ready check may have already expired');
                }
            }
        }

        // Appear offline enforcement
        if (event.uri === '/lol-chat/v1/me' && event.eventType === 'Update') {
            if (state.currentAccount?.appearOffline && event.data?.availability !== 'offline') {
                await setAppearOffline();
            }
        }

        if (event.uri === '/lol-champ-select/v1/session') {
            if (event.eventType === 'Update' || event.eventType === 'Create') {
                send(state.mainWindow, 'champ-select-update', event.data);
                // Auto champ lock is intentionally not implemented: instant-locking
                // through the LCU API is not permitted under the Riot ToS.
                if (state.currentAccount?.autoSkinRandom) await rollRandomSkin(event.data);
            } else if (event.eventType === 'Delete') {
                skinRolledFor = null;
                send(state.mainWindow, 'champ-select-end');
            }
        }
    } catch (e) {
        console.error('[LCU] Event handler error:', e.message);
    }
}

function registerLcuEvents() {
    // Drop only our own handlers if called again: clearHandlers() also wiped
    // other modules' handlers (stats.js resets its client region on disconnect).
    lcu.offConnect(onConnect);
    lcu.offDisconnect(onDisconnect);
    lcu.offEvent(onEvent);
    skinRolledFor = null;
    readyCheckAccepted = false;
    minimizedThisGame = false;
    lcu.onConnect(onConnect);
    lcu.onDisconnect(onDisconnect);
    lcu.onEvent(onEvent);
}

module.exports = { registerLcuEvents, linkRiotIdFromClient };
