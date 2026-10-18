const fx = require('./helpers/a-fakes');
const test = require('node:test');
const assert = require('node:assert/strict');
const state = require('../src/main/state');
const lcu = require('../src/main/lcu');
const { registerLcuEvents } = require('../src/main/lcu-events');

let win;
let calls;
let responses;

// Answers lcu.request from a table: value or (body) => value per "METHOD path".
function setup({ accounts = [], config = {}, routes = {} } = {}) {
    fx.writeAccounts(accounts);
    win = fx.fakeWindow();
    state.mainWindow = win;
    state.overlayWindow = null;
    state.currentAccount = null;
    Object.assign(state.config, {
        minimizeOnGameStart: false, autoAccept: false, toastOnQueuePop: false,
    }, config);
    calls = [];
    responses = routes;
    lcu.connected = true;
    lcu.request = async (method, endpoint, body) => {
        calls.push({ method, endpoint, body });
        const r = responses[`${method} ${endpoint}`];
        return typeof r === 'function' ? r(body) : (r === undefined ? null : r);
    };
    registerLcuEvents();
}

const connect = () => Promise.all(lcu.connectHandlers.map(h => h()));
const disconnect = () => lcu.disconnectHandlers.forEach(h => h());
const emit = (uri, eventType, data) => Promise.all(lcu.handlers.map(h => h({ uri, eventType, data })));
const count = (method, endpoint) => calls.filter(c => c.method === method && c.endpoint === endpoint).length;
const sentTo = (channel) => win.sent.filter(s => s.channel === channel).map(s => s.args[0]);

test('minimize on game start hides the window without an overlay, once per game', async () => {
    setup({ config: { minimizeOnGameStart: true } });
    await emit('/lol-gameflow/v1/gameflow-phase', 'Update', 'InProgress');
    assert.equal(win.counts.hide, 1);
    win.show(); // the user opens it again mid-game
    await emit('/lol-gameflow/v1/gameflow-phase', 'Update', 'InProgress');
    assert.equal(win.counts.hide, 1, 'not hidden again in the same game');
    await emit('/lol-gameflow/v1/gameflow-phase', 'Update', 'EndOfGame');
    await emit('/lol-gameflow/v1/gameflow-phase', 'Update', 'InProgress');
    assert.equal(win.counts.hide, 2, 'next game hides again');
});

test('minimize on game start also applies when connecting during a game', async () => {
    setup({
        config: { minimizeOnGameStart: true },
        routes: { 'GET /lol-gameflow/v1/gameflow-phase': 'InProgress', 'GET /lol-login/v1/session': { username: 'x' } },
    });
    await connect();
    assert.equal(win.counts.hide, 1);
});

test('the phase fetched on connect does not overwrite a newer event', async () => {
    let answerPhase;
    setup({ routes: {
        'GET /lol-login/v1/session': { username: 'x' },
        'GET /lol-gameflow/v1/gameflow-phase': () => new Promise(r => { answerPhase = r; }),
    } });
    const connecting = connect();
    await fx.waitFor(() => answerPhase, 'the phase request');
    await emit('/lol-gameflow/v1/gameflow-phase', 'Update', 'ReadyCheck');
    answerPhase('Matchmaking');
    await connecting;
    assert.deepEqual(sentTo('lcu-gameflow'), ['ReadyCheck']);
});

function champSelect(championId, completed = true) {
    return {
        localPlayerCellId: 1,
        actions: [[{ actorCellId: 1, type: 'pick', completed, championId }]],
    };
}

test('auto random skin picks once per champion pick, skipping disabled skins', async () => {
    setup({ routes: {
        'GET /lol-champ-select/v1/skin-carousel-skins': [
            { id: 1000, ownership: { owned: true } },
            { id: 1001, ownership: { owned: true }, disabled: true },
            { id: 1002, ownership: { owned: false } },
        ],
        'PATCH /lol-champ-select/v1/session/my-selection': '',
    } });
    state.currentAccount = { username: 'a', autoSkinRandom: true };
    const uri = '/lol-champ-select/v1/session';

    await emit(uri, 'Update', champSelect(1, false));
    await Promise.all([emit(uri, 'Update', champSelect(1)), emit(uri, 'Update', champSelect(1))]);
    await emit(uri, 'Update', champSelect(1));
    const patches = calls.filter(c => c.method === 'PATCH');
    assert.equal(patches.length, 1);
    assert.deepEqual(patches[0].body, { selectedSkinId: 1000 });

    await emit(uri, 'Delete', null);
    await emit(uri, 'Update', champSelect(1));
    assert.equal(calls.filter(c => c.method === 'PATCH').length, 2, 'new champ select rolls again');
});

test('connect replaces a stale current account with the signed-in one, and never links its Riot ID onto another', async () => {
    setup({
        accounts: [{ username: 'a', password: 'x' }, { username: 'b', password: 'y' }],
        routes: {
            'GET /lol-login/v1/session': { username: 'B' },
            'GET /lol-summoner/v1/current-summoner': { gameName: 'Bee', tagLine: 'EUW' },
            'GET /riotclient/region-locale': { region: 'EUW' },
        },
    });
    state.currentAccount = { username: 'a' }; // left over from an earlier launch
    await connect();
    assert.equal(state.currentAccount.username, 'b');
    assert.deepEqual(sentTo('active-account-detected'), ['b']);
    const saved = fx.readAccounts();
    assert.equal(saved.find(a => a.username === 'a').riotId, undefined);
    assert.equal(saved.find(a => a.username === 'b').riotId, 'Bee#EUW');
    assert.equal(saved.find(a => a.username === 'b').region, 'euw');
});

test('an unknown signed-in account clears the current account; disconnect clears it too', async () => {
    setup({ accounts: [{ username: 'a', password: 'x' }], routes: { 'GET /lol-login/v1/session': { username: 'stranger' } } });
    state.currentAccount = { username: 'a', appearOffline: true };
    await connect();
    assert.equal(state.currentAccount, null);
    assert.deepEqual(sentTo('active-account-detected'), [null]);
    assert.equal(count('PUT', '/lol-chat/v1/me'), 0, 'old account settings do not apply');

    state.currentAccount = { username: 'a' };
    disconnect();
    assert.equal(state.currentAccount, null);
    assert.deepEqual(sentTo('active-account-detected'), [null, null]);
});

test('appear offline is applied right after connecting', async () => {
    setup({
        accounts: [{ username: 'a', password: 'x', appearOffline: true, riotId: 'A#1', region: 'euw' }],
        routes: { 'GET /lol-login/v1/session': { username: 'a' } },
    });
    await connect();
    const put = calls.find(c => c.method === 'PUT' && c.endpoint === '/lol-chat/v1/me');
    assert.deepEqual(put?.body, { availability: 'offline' });
});

test('Riot ID linking patches the current file, not the list loaded before its waits', async () => {
    let answerSummoner;
    setup({
        accounts: [{ username: 'a', password: 'x' }],
        routes: {
            'GET /lol-login/v1/session': { username: 'a' },
            'GET /lol-summoner/v1/current-summoner': () => new Promise(r => { answerSummoner = r; }),
            'GET /riotclient/region-locale': { region: 'NA1' },
        },
    });
    const connecting = connect();
    await fx.waitFor(() => answerSummoner, 'the summoner request');
    // Meanwhile the user adds an account and edits the note of the first one.
    fx.writeAccounts([{ username: 'a', password: 'x', note: 'edited' }, { username: 'new', password: 'z' }]);
    answerSummoner({ gameName: 'Ay', tagLine: 'NA1' });
    await connecting;

    const saved = fx.readAccounts();
    assert.deepEqual(saved.map(a => a.username), ['a', 'new']);
    assert.equal(saved[0].note, 'edited');
    assert.equal(saved[0].riotId, 'Ay#NA1');
    assert.equal(saved[0].region, 'na');
});

test('auto-accept posts once per ready check', async () => {
    setup({ config: { autoAccept: true }, routes: { 'POST /lol-matchmaking/v1/ready-check/accept': '' } });
    const uri = '/lol-matchmaking/v1/ready-check';
    await emit(uri, 'Update', { state: 'InProgress', playerResponse: 'None' });
    await emit(uri, 'Update', { state: 'InProgress', playerResponse: 'None' });
    assert.equal(count('POST', '/lol-matchmaking/v1/ready-check/accept'), 1);
    await emit(uri, 'Update', { state: 'Invalid', playerResponse: 'None' });
    await emit(uri, 'Update', { state: 'InProgress', playerResponse: 'None' });
    assert.equal(count('POST', '/lol-matchmaking/v1/ready-check/accept'), 2, 'next ready check accepted again');
});
