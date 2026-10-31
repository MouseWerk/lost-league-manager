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
    assert.match(src, /<span class="ov-player-name">\$\{escHtml\(name\)\}/);
    assert.match(src, /data-tip="\$\{escHtml\(\(itemNames\[id\] \|\| id\)/);
    // Every property put into the overlay's markup goes through escHtml.
    const member = /\$\{\s*[A-Za-z_$][\w$]*(?:\??\.[\w$]+|\[[^\]]+\])+\s*\}/;
    assert.deepEqual(src.split('\n').filter((l) => l.includes('<') && member.test(l)), []);
});

// 1.9 rework: the overlay sits over League only and never takes its focus.
test('the overlay shows only in a game, with League in front, and without taking focus', () => {
    const calls = [];
    state.config.overlayEnabled = true;
    state.overlayViaOverwolf = false;
    let visible = false;
    state.overlayWindow = {
        isDestroyed: () => false,
        isVisible: () => visible,
        showInactive: () => { visible = true; calls.push('showInactive'); },
        show: () => { visible = true; calls.push('show'); },
        hide: () => { visible = false; calls.push('hide'); },
        webContents: { send() {} },
    };
    state.gameflowPhase = 'InProgress';
    manager.onForegroundLine('1234|chrome');
    assert.equal(visible, false, 'another app in front: hidden');
    manager.onForegroundLine('5678|League of Legends');
    assert.equal(visible, true);
    assert.ok(!calls.includes('show'), 'never show(): that takes focus');
    manager.toggleByHotkey();
    assert.equal(visible, false, 'the hotkey hides it');
    manager.toggleByHotkey();
    manager.onGameflowPhase('EndOfGame');
    assert.equal(visible, false, 'gone after the game');
    state.overlayWindow = null;
    state.config.overlayEnabled = false;
});

test('the plain overlay window stays out of Alt+Tab and the taskbar', () => {
    const src = read('src', 'main', 'windows.js');
    assert.match(src, /new BrowserWindow\(\{ \.\.\.opts, type: 'toolbar' \}\)/);
    assert.match(src, /skipTaskbar: true/);
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

// More in the overlay: team numbers from the scoreboard and the event feed.
const stats = require('../src/renderer/js/overlay-stats.js');
const P = (name, team, position, k, d, a, items = []) => ({ riotIdGameName: name, team, position, scores: { kills: k, deaths: d, assists: a }, items });

test('game stats: kills, item gold, objectives, kill participation and the lane opponent', () => {
    const players = [
        P('Me', 'ORDER', 'MIDDLE', 3, 1, 1, [{ itemID: 3020, price: 1100, count: 1 }, { itemID: 2003, price: 50, count: 2 }]),
        P('Ally', 'ORDER', 'TOP', 2, 2, 1),
        P('Foe', 'CHAOS', 'MIDDLE', 1, 3, 0, [{ itemID: 1056, price: 400, count: 1 }]),
        P('Foe2', 'CHAOS', 'TOP', 4, 2, 0),
    ];
    assert.equal(stats.kills(players, 'ORDER'), 5);
    assert.equal(stats.itemGold(players, 'ORDER'), 1200);
    assert.equal(stats.killParticipation(players[0], players), 80); // (3 + 1) of 5 team kills
    assert.equal(stats.laneOpponent(players[0], players).riotIdGameName, 'Foe');
    assert.equal(stats.laneOpponent({ ...players[0], position: 'NONE' }, players), null, 'practice tool: no position');
    const events = [
        { EventName: 'TurretKilled', TurretKilled: 'Turret_T2_L_03_A', KillerName: 'Me' },
        { EventName: 'TurretKilled', TurretKilled: 'Turret_T1_C_05_A', KillerName: 'Foe' },
        { EventName: 'DragonKill', KillerName: 'Ally' },
        { EventName: 'DragonKill', KillerName: 'Me' },
        { EventName: 'BaronKill', KillerName: 'Foe2' },
        { EventName: 'HordeKill', KillerName: 'Me' },
        { EventName: 'ChampionKill', KillerName: 'Me' },
    ];
    const o = stats.objectives(events, players);
    assert.deepEqual([o.ORDER.towers, o.ORDER.dragons, o.ORDER.grubs, o.CHAOS.towers, o.CHAOS.barons], [1, 2, 1, 1, 1]);
});

test('the overlay is dragged by its bar, in both window modes, and the place is kept', () => {
    const src = read('src', 'renderer', 'js', 'overlay.js');
    assert.match(src, /ovBar\.setPointerCapture\(e\.pointerId\)/);
    assert.match(src, /window\.overlayAPI\.moveWindow\(/);
    assert.match(src, /window\.overlayAPI\.savePosition\(\)/);
    assert.doesNotMatch(src, /startDragging/, 'the Overwolf-only drag did nothing in the plain window');
});

test('the CS goal is one of the offered values', () => {
    assert.deepEqual(cleanOverlaySettings({ csGoal: 9 }), { csGoal: 9 });
    assert.deepEqual(cleanOverlaySettings({ csGoal: 99 }), {});
});
