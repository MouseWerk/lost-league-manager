require('./helpers/fake-electron');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const state = require('../src/main/state');
const manager = require('../src/main/overlay-manager');
const windows = require('../src/main/windows');
const { cleanOverlaySettings } = require('../src/main/ipc/overlay-handlers');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

test('Live Client data reaches the overlay in the shape of GEP updates', () => {
    const all = { gameData: { gameTime: 61.5 }, activePlayer: { riotIdGameName: 'Me', level: 3 }, allPlayers: [{ riotIdGameName: 'Me', scores: { kills: 1 } }] };
    const updates = manager.liveDataToGepUpdates(all);
    assert.deepEqual(updates.map(u => `${u.feature}:${u.key}`), ['matchState:matchState', 'live_client_data:game_data', 'live_client_data:active_player', 'live_client_data:all_players']);
    assert.equal(updates[0].value, 'InProgress');
    assert.deepEqual(JSON.parse(updates[3].value), all.allPlayers);
    assert.deepEqual(manager.liveDataToGepUpdates(null), []);
});

test('Live Client data is not read while GEP delivers', async (t) => {
    const sent = [];
    state.overlayWindow = { isDestroyed: () => false, webContents: { send: (...a) => sent.push(a) } };
    const live = require('../src/main/services/live-client');
    const get = t.mock.method(live, 'liveClientGet', async () => ({ gameData: {} }));
    manager.markGepLive();
    await manager.pollOnce();
    assert.equal(get.mock.callCount(), 0);
    assert.equal(sent.length, 0);
    state.lastGepLiveAt = 0;
    await manager.pollOnce();
    assert.equal(get.mock.callCount(), 1);
    assert.equal(sent.length, 2); // match state and game data
    state.overlayWindow = null;
    manager.stopPolling();
});

test('the overlay window is only created while it is switched on, and once', (t) => {
    const create = t.mock.method(windows, 'createOverlayWindow', () => {});
    state.overlayWindow = null;
    state.config.overlayEnabled = false;
    manager.ensureOverlay();
    assert.equal(create.mock.callCount(), 0);
    state.config.overlayEnabled = true;
    manager.ensureOverlay();
    manager.ensureOverlay(); // still being created
    assert.equal(create.mock.callCount(), 1);
    state.config.overlayEnabled = false;
});

test('a game already running when the overlay is ready shows it, in any mode', async (t) => {
    const shown = [];
    const injected = [];
    state.config.overlayEnabled = true;
    state.owOverlayPackage = { requestGameInjection: (id) => { injected.push(id); return Promise.resolve(); } };
    state.overlayViaOverwolf = true;
    state.overlayWindow = { isDestroyed: () => false, show: () => shown.push(1), webContents: { send() {} } };
    t.mock.method(windows, 'createOverlayWindow', () => {});
    manager.onGameflowPhase('Lobby');
    manager.showIfInGame();
    assert.equal(shown.length, 0, 'not outside a game');
    manager.onGameflowPhase('InProgress');
    assert.equal(shown.length, 1);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(injected, [state.LOL_GEP_GAME_ID]);
    manager.stopPolling();
    state.overlayWindow = null;
    state.owOverlayPackage = null;
    state.config.overlayEnabled = false;
});

test('when Overwolf cannot inject into the game, the overlay becomes a plain window', async (t) => {
    let destroyed = 0;
    state.config.overlayEnabled = true;
    state.overlayInjectionFailed = false;
    state.overlayViaOverwolf = true;
    state.owOverlayPackage = { requestGameInjection: () => Promise.reject(new Error('game 5426 not running')) };
    state.overlayWindow = { isDestroyed: () => false, show() {}, destroy: () => { destroyed++; }, webContents: { send() {} } };
    const create = t.mock.method(windows, 'createOverlayWindow', () => {});
    manager.onGameflowPhase('InProgress');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(destroyed, 1);
    assert.equal(create.mock.callCount(), 1);
    assert.equal(create.mock.calls[0].arguments[0], null, 'no Overwolf package: a plain window');
    manager.stopPolling();
    state.overlayWindow = null;
    state.owOverlayPackage = null;
    state.overlayInjectionFailed = false;
    state.config.overlayEnabled = false;
});

test('overlay settings from its page: only known hotkeys and real booleans', () => {
    assert.deepEqual(cleanOverlaySettings({ hotkey: 'F9', locked: true, showRanked: 'yes', extra: 1 }), { hotkey: 'F9', locked: true });
    assert.deepEqual(cleanOverlaySettings({ hotkey: 'Ctrl+Alt+Delete' }), {});
    assert.deepEqual(cleanOverlaySettings(null), {});
});

test('player names, ranks and item names are escaped in the overlay', () => {
    const src = read('src', 'renderer', 'js', 'overlay.js');
    assert.match(src, /<span class="ov-rp-name">\$\{escHtml\(name\)\}<\/span>/);
    assert.match(src, /<span class="ov-rp-wr">\$\{escHtml\(wr\)\}<\/span>/);
    assert.match(src, /data-tooltip="\$\{escHtml\(itemNames\[id\] \|\| id\)\}"/);
});

test('opacity is applied once, by the page', () => {
    assert.doesNotMatch(read('src', 'main', 'windows.js'), /setOpacity\(/);
    assert.doesNotMatch(read('src', 'main', 'ipc', 'overlay-handlers.js'), /setOpacity\(/);
});

test('the overlay starts at the place it was dragged to', () => {
    const src = read('src', 'main', 'windows.js');
    assert.match(src, /x: saved \? state\.config\.overlayX/);
    assert.match(src, /on\?\.\('moved'/);
});
