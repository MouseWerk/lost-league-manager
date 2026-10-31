const fx = require('./helpers/a-fakes');
const { invoke } = require('./helpers/fake-electron');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const state = require('../src/main/state');
const lcu = require('../src/main/lcu');
const status = require('../src/main/services/account-status');
const { registerLcuEvents } = require('../src/main/lcu-events');
const { statusWarnings } = require('../src/renderer/js/ui-lib.js');
require('../src/main/ipc/accounts').register();

const DAY = 86400000;

function fakeLcu(routes) {
    lcu.connected = true;
    lcu.request = async (method, endpoint) => {
        const r = routes[`${method} ${endpoint}`];
        return r === undefined ? null : r;
    };
}

function reset() {
    fs.rmSync(state.paths.accountStatus, { force: true });
}

test('decay is read from the queue warnings, the queue that decays first wins', () => {
    const ranked = { queues: [
        { queueType: 'RANKED_SOLO_5x5', tier: 'DIAMOND', warnings: { daysUntilDecay: 9, displayDecayWarning: false } },
        { queueType: 'RANKED_FLEX_SR', tier: 'MASTER', warnings: { apexDaysUntilDecay: 4 } },
        { queueType: 'RANKED_TFT', warnings: { daysUntilDecay: 1 } },
    ] };
    assert.deepEqual(status.parseDecay(ranked), { queue: 'RANKED_FLEX_SR', days: 4 });
    assert.equal(status.parseDecay({ queues: [{ queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', warnings: null }] }), null);
    assert.equal(status.parseDecay({ queues: [{ queueType: 'RANKED_SOLO_5x5', warnings: { daysUntilDecay: -1 } }] }), null);
    assert.equal(status.parseDecay(null), null);
});

test('a ranked restriction counts the games still to play', () => {
    assert.deepEqual(status.parseRestriction({ rankedRestrictedGamesRemaining: 5 }), { gamesLeft: 5 });
    assert.equal(status.parseRestriction({ rankedRestrictedGamesRemaining: 0 }), null);
    assert.equal(status.parseRestriction({}), null);
});

test('capturing keeps the old value when an endpoint is missing', async () => {
    reset();
    fakeLcu({ 'GET /lol-ranked/v1/current-ranked-stats': { queues: [{ queueType: 'RANKED_SOLO_5x5', warnings: { daysUntilDecay: 6 } }] } });
    await status.captureStatus('Main');
    const first = status.statusFor(status.getStatusMap(), 'main');
    assert.equal(first.decay.days, 6);
    assert.equal(first.restriction, undefined);
    fakeLcu({});
    await status.captureStatus('Main');
    assert.equal(status.statusFor(status.getStatusMap(), 'MAIN').decay.days, 6);
});

test('last played only moves forward', () => {
    reset();
    status.recordLastPlayed('a', 2000);
    status.recordLastPlayed('a', 1000);
    assert.equal(status.statusFor(status.getStatusMap(), 'a').lastPlayed, 2000);
});

test('the end of a game records last played and reads decay again for the signed-in account', async () => {
    reset();
    fx.writeAccounts([{ username: 'main', password: 'x' }]);
    state.mainWindow = fx.fakeWindow();
    fakeLcu({ 'GET /lol-ranked/v1/current-ranked-stats': { queues: [{ queueType: 'RANKED_SOLO_5x5', warnings: { daysUntilDecay: 28 } }] } });
    registerLcuEvents();
    state.currentAccount = { username: 'main' };
    const before = Date.now();
    await Promise.all(lcu.handlers.map(h => h({ uri: '/lol-gameflow/v1/gameflow-phase', eventType: 'Update', data: 'EndOfGame' })));
    await fx.waitFor(() => status.statusFor(status.getStatusMap(), 'main')?.decay);
    const rec = status.statusFor(status.getStatusMap(), 'main');
    assert.ok(rec.lastPlayed >= before);
    assert.equal(rec.decay.days, 28);
});

test('get-accounts carries the status, and deleting the account forgets it', async () => {
    reset();
    fx.writeAccounts([{ username: 'gone', password: 'x' }]);
    status.recordLastPlayed('gone', 5000);
    const list = await invoke('get-accounts');
    assert.equal(list[0].status.lastPlayed, 5000);
    await invoke('delete-account', 'gone');
    assert.equal(status.statusFor(status.getStatusMap(), 'gone'), null);
});

test('warnings: restriction, decay from the client, and inactivity', () => {
    const now = 100 * DAY;
    const w = statusWarnings({
        restriction: { gamesLeft: 1 },
        decay: { days: 5, checkedAt: now - 2 * DAY },
        lastPlayed: now - 40 * DAY,
    }, 'Diamond II', now);
    assert.deepEqual(w.map(x => x.text), ['Ranked restricted, 1 normal game left', 'Decays in 3 days', 'Not played for 40 days']);
    assert.equal(w[1].urgent, true);
});

test('warnings: a game after the decay check hides the old count', () => {
    const now = 100 * DAY;
    assert.deepEqual(statusWarnings({ decay: { days: 1, checkedAt: now - 3 * DAY }, lastPlayed: now - DAY }, 'Diamond I', now), []);
});

test('warnings: decay is only estimated for Diamond and above, and says "about"', () => {
    const now = 100 * DAY;
    const s = { lastPlayed: now - 24 * DAY };
    assert.deepEqual(statusWarnings(s, 'Diamond IV', now).map(x => x.text), ['Decay in about 4 days']);
    assert.deepEqual(statusWarnings(s, 'Master', now).map(x => x.text), ['May be decaying']);
    assert.deepEqual(statusWarnings(s, 'Emerald I', now), []);
    assert.deepEqual(statusWarnings(null, 'Diamond IV', now), []);
});
