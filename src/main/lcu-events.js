const { Notification } = require('electron');
const path  = require('path');
const lcu   = require('./lcu');
const state = require('./state');
const { getChampionMap } = require('./services/champion-data');
const discordRpc = require('./services/discord-rpc');

let autoLockAttempted = false;

function send(win, channel, ...args) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

async function setAppearOffline() {
    if (state.currentAccount?.appearOffline) {
        try {
            await lcu.request('PUT', '/lol-chat/v1/me', { availability: 'offline' });
        } catch (e) {
            console.error('[LCU] setAppearOffline error:', e.message);
        }
    }
}

// If the signed-in account is saved here without a Riot ID/region, fill them
// in from the client so its card gets rank/icon/stats with no manual setup.
async function linkRiotIdFromClient() {
    const { loadAccounts, saveAccounts } = require('./services/storage');
    const { broadcastAccountsUpdate } = require('./windows');
    const { LCU_REGION_TO_APP } = require('./ipc/stats');

    const username = state.currentAccount?.username
        || (await lcu.request('GET', '/lol-login/v1/session'))?.username;
    if (!username) return;

    const accounts = loadAccounts();
    const acc = accounts.find(a => a.username.toLowerCase() === username.toLowerCase());
    if (!acc || (acc.riotId && acc.region)) return;

    // The summoner endpoint 404s for a few seconds while the client boots.
    let me = null;
    for (let i = 0; i < 6 && !me?.gameName; i++) {
        me = await lcu.request('GET', '/lol-summoner/v1/current-summoner');
        if (!me?.gameName) await new Promise(r => setTimeout(r, 5000));
        if (!lcu.connected) return;
    }
    if (!me?.gameName) return;
    const rl = await lcu.request('GET', '/riotclient/region-locale');
    const region = LCU_REGION_TO_APP[(rl?.region || rl?.webRegion || '').toLowerCase()] || '';

    if (!acc.riotId) acc.riotId = `${me.gameName}#${me.tagLine}`;
    if (!acc.region && region) acc.region = region;
    saveAccounts(accounts);
    broadcastAccountsUpdate();
    console.log(`[LCU] Linked ${acc.username} → ${acc.riotId} (${acc.region || '?'})`);
}

function registerLcuEvents() {
    lcu.clearHandlers(); // prevent accumulation if called more than once

    lcu.onConnect(async () => {
        send(state.mainWindow, 'lcu-connected');

        // Detect which account is logged in so the UI can highlight it even if
        // the user launched League externally (not through this app).
        try {
            const session = await lcu.request('GET', '/lol-login/v1/session');
            if (session?.username && !state.currentAccount) {
                const { loadAccounts } = require('./services/storage');
                const matched = loadAccounts().find(
                    a => a.username.toLowerCase() === session.username.toLowerCase()
                );
                if (matched) {
                    state.currentAccount = { ...matched };
                    send(state.mainWindow, 'active-account-detected', matched.username);
                }
            }
        } catch { /* not critical */ }

        linkRiotIdFromClient().catch(e => console.log('[LCU] Riot ID auto-link skipped:', e.message));

        try {
            const phase = await lcu.request('GET', '/lol-gameflow/v1/gameflow-phase');
            if (phase) {
                send(state.mainWindow, 'lcu-gameflow', phase);
                discordRpc.setGameflowPhase(phase);
                if (phase === 'InProgress' && state.config.overlayEnabled && state.overlayWindow && !state.overlayWindow.isDestroyed()) {
                    state.overlayWindow.show();
                }
            }
        } catch { /* client may not be ready yet */ }
    });

    lcu.onDisconnect(() => {
        send(state.mainWindow, 'lcu-disconnected');
        autoLockAttempted = false;
        discordRpc.setIdle();
    });

    lcu.onEvent(async (event) => {
        try {
            // Gameflow phase → overlay visibility + notify renderer
            if (event.uri === '/lol-gameflow/v1/gameflow-phase' && event.eventType === 'Update') {
                const phase = event.data;
                send(state.mainWindow, 'lcu-gameflow', phase);
                discordRpc.setGameflowPhase(phase);

                // Queue-pop toast notification
                if (phase === 'ReadyCheck' && state.config.toastOnQueuePop !== false) {
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

                if (state.overlayWindow && !state.overlayWindow.isDestroyed()) {
                    if (phase === 'InProgress') {
                        if (state.config.overlayEnabled) state.overlayWindow.show();
                        if (state.config.minimizeOnGameStart && state.mainWindow && !state.mainWindow.isDestroyed()) {
                            state.mainWindow.hide();
                        }
                    } else if (['None', 'Lobby', 'EndOfGame', 'WaitingForStats', 'PreEndOfGame'].includes(phase)) {
                        state.overlayWindow.hide();
                    }
                }
            }

            // Auto-accept ready check
            if (state.config.autoAccept && event.uri === '/lol-matchmaking/v1/ready-check') {
                const data = event.data;
                if (data?.state === 'InProgress' && data?.playerResponse === 'None') {
                    console.log('[LCU] Auto-accepting match...');
                    // lcu.request() never throws (it catches internally and returns
                    // null on failure) — the try/catch this replaced could never
                    // actually catch anything, so a failed auto-accept (e.g. the
                    // ready check already expired) went completely unlogged.
                    const result = await lcu.request('POST', '/lol-matchmaking/v1/ready-check/accept', null, { verbose: true });
                    if (result === null) {
                        console.error('[LCU] Auto-accept failed — ready check may have already expired');
                    }
                }
            }

            // Appear offline enforcement
            if (event.uri === '/lol-chat/v1/me' && event.eventType === 'Update') {
                if (state.currentAccount?.appearOffline && event.data.availability !== 'offline') {
                    setAppearOffline();
                }
            }

            // Champ select → notify renderer
            if (event.uri === '/lol-champ-select/v1/session') {
                if (event.eventType === 'Update' || event.eventType === 'Create') {
                    send(state.mainWindow, 'champ-select-update', event.data);
                    if (event.eventType === 'Create') autoLockAttempted = false;
                } else if (event.eventType === 'Delete') {
                    send(state.mainWindow, 'champ-select-end');
                    autoLockAttempted = false;
                }
            }

            // Auto skin / auto lock — runs on both Create and Update
            if (!state.currentAccount) return;
            if (event.uri !== '/lol-champ-select/v1/session') return;
            if (event.eventType !== 'Update' && event.eventType !== 'Create') return;

            // AUTO CHAMP LOCK — DISABLED (violates Riot ToS, insta-locking via API is not permitted)
            // if (state.currentAccount.autoChampLock && !autoLockAttempted) {
            //     const session     = event.data;
            //     const localCellId = session.localPlayerCellId;
            //     const allActions  = Array.isArray(session.actions) ? session.actions.flat() : [];
            //     const activeCells = session.activeCellIds;
            //     const myTurnActive =
            //         !Array.isArray(activeCells) || activeCells.length === 0 ||
            //         activeCells.includes(localCellId) ||
            //         allActions.some(a => a.actorCellId === localCellId && a.isInProgress);
            //     const myPickAction = allActions.find(
            //         a => a.actorCellId === localCellId && a.type === 'pick' && !a.completed && myTurnActive
            //     );
            //     if (myPickAction) {
            //         autoLockAttempted = true;
            //         const champName = state.currentAccount.autoChampLock.trim().toLowerCase();
            //         const champId   = getChampionMap()[champName];
            //         if (champId) {
            //             await lcu.request('PATCH', `/lol-champ-select/v1/session/actions/${myPickAction.id}`, { championId: champId });
            //             await lcu.request('POST', `/lol-champ-select/v1/session/actions/${myPickAction.id}/complete`);
            //         }
            //     }
            // }

            if (state.currentAccount.autoSkinRandom) {
                const session     = event.data;
                const localCellId = session.localPlayerCellId;
                const allActions  = Array.isArray(session.actions) ? session.actions.flat() : [];
                const myPick      = allActions.find(
                    a => a.actorCellId === localCellId && a.type === 'pick' && a.completed
                );
                if (myPick) {
                    try {
                        const skins = await lcu.request('GET', '/lol-champ-select/v1/skin-carousel-skins');
                        if (skins?.length) {
                            const owned = skins.filter(s => s.ownership.owned);
                            if (owned.length) {
                                const randomSkin = owned[Math.floor(Math.random() * owned.length)];
                                await lcu.request('PATCH', '/lol-champ-select/v1/session/my-selection', { selectedSkinId: randomSkin.id });
                            }
                        }
                    } catch (e) {
                        console.error('[LCU] autoSkinRandom error:', e.message);
                    }
                }
            }
        } catch (e) {
            console.error('[LCU] Event handler error:', e.message);
        }
    });
}

module.exports = { registerLcuEvents };
