const lcu = require('./lcu');
const state = require('./state');
const championData = require('./services/champion-data');

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

function registerLcuEvents() {
    lcu.onConnect(async () => {
        send(state.mainWindow, 'lcu-connected');
        try {
            const phase = await lcu.request('GET', '/lol-gameflow/v1/gameflow-phase');
            if (phase) {
                send(state.mainWindow, 'lcu-gameflow', phase);
                if (phase === 'InProgress' && state.config.overlayEnabled && state.overlayWindow && !state.overlayWindow.isDestroyed()) {
                    state.overlayWindow.show();
                }
            }
        } catch { /* client may not be ready yet */ }
    });

    lcu.onDisconnect(() => {
        send(state.mainWindow, 'lcu-disconnected');
    });

    lcu.onEvent(async (event) => {
        // Gameflow phase → overlay visibility + notify renderer
        if (event.uri === '/lol-gameflow/v1/gameflow-phase' && event.eventType === 'Update') {
            const phase = event.data;
            send(state.mainWindow, 'lcu-gameflow', phase);

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
                await lcu.request('POST', '/lol-matchmaking/v1/ready-check/accept');
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
            } else if (event.eventType === 'Delete') {
                send(state.mainWindow, 'champ-select-end');
            }
        }

        // Auto pick / ban / skin
        if (!state.currentAccount) return;
        if (event.uri !== '/lol-champ-select/v1/session' || event.eventType !== 'Update') return;

        const session      = event.data;
        const localCellId  = session.localPlayerCellId;
        const champMap     = championData.getChampionMap();

        const findMyAction = (type) => {
            for (const phase of session.actions) {
                for (const action of phase) {
                    if (action.actorCellId === localCellId && action.type === type && !action.completed && action.isInProgress) {
                        return action;
                    }
                }
            }
            return null;
        };

        if (state.currentAccount.autoBanChamp) {
            const banAction = findMyAction('ban');
            if (banAction) {
                const champId = champMap[state.currentAccount.autoBanChamp.toLowerCase()];
                if (champId) {
                    await lcu.request('PATCH', `/lol-champ-select/v1/session/actions/${banAction.id}`, { championId: champId, completed: true });
                }
            }
        }

        if (state.currentAccount.autoPickChamp) {
            const pickAction = findMyAction('pick');
            if (pickAction) {
                const champId = champMap[state.currentAccount.autoPickChamp.toLowerCase()];
                if (champId) {
                    await lcu.request('PATCH', `/lol-champ-select/v1/session/actions/${pickAction.id}`, { championId: champId, completed: true });
                }
            }
        }

        if (state.currentAccount.autoSkinRandom) {
            const myPick = session.actions.flat().find(a => a.actorCellId === localCellId && a.type === 'pick' && a.completed);
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
    });
}

module.exports = { registerLcuEvents };
