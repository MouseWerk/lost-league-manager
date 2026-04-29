const { app } = require('electron');
const state = require('./state');
const { createOverlayWindow } = require('./windows');

function send(win, channel, ...args) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function initOverwolf() {
    if (!app.overwolf) {
        console.warn('[OW] app.overwolf not available — running outside ow-electron');
        createOverlayWindow(null);
        return;
    }

    app.overwolf.disableAnonymousAnalytics();
    const packages = app.overwolf.packages;

    packages.on('ready', async (e, packageName, version) => {
        console.log(`[OW] Package ready: ${packageName} v${version}`);

        if (packageName === 'gep') {
            const gep = packages.gep;

            gep.on('game-detected', async (event, gameId, name) => {
                if (gameId !== state.LOL_GEP_GAME_ID) return;
                console.log(`[GEP] Game detected: ${name} (${gameId})`);
                event.enable();

                try {
                    await gep.setRequiredFeatures(state.LOL_GEP_GAME_ID, [
                        'matchState', 'match_info', 'kill', 'death',
                        'live_client_data', 'summoner_info', 'teams',
                    ]);
                    console.log('[GEP] Features registered for LoL');
                } catch (err) {
                    console.error('[GEP] setRequiredFeatures failed:', err.message);
                }

                if (state.owOverlayPackage) {
                    try {
                        await state.owOverlayPackage.requestGameInjection(gameId);
                        console.log('[Overlay] requestGameInjection succeeded');
                    } catch (err) {
                        console.warn('[Overlay] requestGameInjection failed:', err.message);
                    }
                }

                if (state.config.overlayEnabled && state.overlayWindow && !state.overlayWindow.isDestroyed()) {
                    state.overlayWindow.show();
                }
            });

            gep.on('game-exit', (ev, gameId) => {
                if (gameId !== state.LOL_GEP_GAME_ID) return;
                if (state.overlayWindow && !state.overlayWindow.isDestroyed()) state.overlayWindow.hide();
            });

            gep.on('new-game-event', (ev, gameId, data) => {
                if (gameId !== state.LOL_GEP_GAME_ID) return;
                send(state.mainWindow, 'gep-game-event', data);
                send(state.overlayWindow, 'gep-game-event', data);
            });

            gep.on('new-info-update', (ev, gameId, data) => {
                if (gameId !== state.LOL_GEP_GAME_ID) return;
                send(state.mainWindow, 'gep-info-update', data);
                send(state.overlayWindow, 'gep-info-update', data);
                handleOverlayVisibility(data);
            });
        }

        if (packageName === 'overlay') {
            const owOverlay = packages.overlay;
            state.owOverlayPackage = owOverlay;

            owOverlay.on('game-launched', (first, second) => {
                const hasInject  = typeof first?.inject === 'function';
                const launchEvent = hasInject ? first  : second;
                const gameInfo    = hasInject ? second : first;
                const gid = gameInfo?.id ?? gameInfo?.gameId ?? gameInfo?.classId;

                console.log('[Overlay] game-launched: gameId=%s inject=%s', gid, hasInject);
                if (gid && gid !== state.LOL_GEP_GAME_ID && gid !== state.LOL_OVERLAY_CLASS_ID) return;

                try {
                    if (typeof launchEvent?.inject === 'function') {
                        launchEvent.inject();
                        console.log('[Overlay] inject() called successfully');
                    } else {
                        console.warn('[Overlay] game-launched: no inject() on event args');
                    }
                } catch (err) {
                    console.error('[Overlay] inject() threw:', err.message);
                }

                if (state.config.overlayEnabled && state.overlayWindow && !state.overlayWindow.isDestroyed()) {
                    state.overlayWindow.show();
                }
            });

            owOverlay.on('game-injected', (gameInfo) => {
                console.log('[Overlay] game-injected into game:', gameInfo?.id ?? gameInfo);
                if (state.config.overlayEnabled && state.overlayWindow && !state.overlayWindow.isDestroyed()) {
                    state.overlayWindow.show();
                }
            });

            owOverlay.on('game-injection-error', (err, gameInfo) => {
                console.error('[Overlay] injection error for game', gameInfo?.id, ':', err);
            });

            owOverlay.on('game-exit', () => {
                if (state.overlayWindow && !state.overlayWindow.isDestroyed()) state.overlayWindow.hide();
            });

            if (!state.overlayWindow || state.overlayWindow.isDestroyed()) {
                createOverlayWindow(owOverlay);
            }

            try {
                owOverlay.registerGames({ gameIds: [state.LOL_GEP_GAME_ID, state.LOL_OVERLAY_CLASS_ID] });
                console.log('[Overlay] registerGames done for LoL');
            } catch (err) {
                console.error('[Overlay] registerGames failed:', err.message);
            }
        }
    });

    packages.on('failed-to-initialize', (e, packageName) => {
        console.warn(`[OW] Package failed to initialize: ${packageName}`);
        if (packageName === 'overlay' && (!state.overlayWindow || state.overlayWindow.isDestroyed())) {
            createOverlayWindow(null);
        }
    });
}

function handleOverlayVisibility(data) {
    if (!state.overlayWindow || state.overlayWindow.isDestroyed()) return;
    if (data?.feature !== 'matchState' || data?.key !== 'matchState') return;
    const s = data.value;
    if (s === 'InProgress') {
        if (state.config.overlayEnabled) state.overlayWindow.show();
    } else if (s === 'EndOfGame' || s === 'PreGame') {
        state.overlayWindow.hide();
    }
}

module.exports = { initOverwolf };
