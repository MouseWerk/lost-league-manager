// Checks for the seams between the main-process areas (stats, rank history,
// windows) that no single area's tests cover.
const { userData, invoke } = require('./helpers/fake-electron');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const opgg = require('../src/main/services/opgg-api');
const championData = require('../src/main/services/champion-data');
const { getRankHistory } = require('../src/main/services/rank-history');
require('../src/main/ipc/stats').register();

// Rank history skips OP.GG snapshots that lag a fresher LCU/Riot entry, but
// only when stats.js tells it where a snapshot came from.
test('stats lookups record where each rank snapshot came from', async (t) => {
    fs.writeFileSync(path.join(userData, 'accounts.json'), JSON.stringify([]));
    t.mock.method(championData, 'whenReady', async () => {});
    t.mock.method(opgg, 'getProfile', async () => ({
        success: true, source: 'opgg', tier: 'Gold II', lp: '57 LP',
        rawTier: 'GOLD', rawDivision: 'II', rawLp: 57,
    }));
    await invoke('get-stats', { region: 'euw', riotId: 'Seam#TEST' });
    const history = getRankHistory('Seam#TEST');
    assert.equal(history.length, 1);
    assert.equal(history[0].source, 'opgg');
});

// Boot order: stats.js registers its client-region reset when it loads, then
// main.js calls registerLcuEvents(). That used to clear every module's LCU
// handlers, so the first client's region stuck for the whole session and
// accounts were looked up through a client on another server.
test('the client region is read again after the League client reconnects', async (t) => {
    const lcu = require('../src/main/lcu');
    const { registerLcuEvents } = require('../src/main/lcu-events');
    registerLcuEvents();

    fs.writeFileSync(path.join(userData, 'accounts.json'), JSON.stringify([]));
    t.mock.method(championData, 'whenReady', async () => {});
    t.mock.method(opgg, 'getProfile', async () => ({ success: true, source: 'opgg', tier: 'Unranked', lp: '' }));
    let region = 'EUW';
    let regionReads = 0;
    t.mock.method(lcu, 'request', async (method, endpoint) => {
        if (endpoint === '/riotclient/region-locale') { regionReads++; return { region }; }
        return null; // summoner lookups miss, so stats fall through to OP.GG
    });
    const wasConnected = lcu.connected;
    lcu.connected = true;
    t.after(() => { lcu.connected = wasConnected; });

    await invoke('get-stats', { region: 'euw', riotId: 'Region#ONE', force: true });
    assert.equal(regionReads, 1);

    // The user signs into an NA account: the client goes away and comes back.
    lcu.disconnectHandlers.forEach(h => h());
    region = 'NA';
    await invoke('get-stats', { region: 'na', riotId: 'Region#TWO', force: true });
    assert.equal(regionReads, 2, 'region must be read again after a reconnect');
});

// The DevTools console can call every IPC method the preload exposes.
test('no window opens DevTools in an installed build', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'windows.js'), 'utf8');
    const prefs = src.match(/webPreferences:\s*\{[^}]*\}/g) || [];
    assert.ok(prefs.length >= 2, 'expected the main and overlay window options');
    for (const p of prefs) assert.match(p, /devTools:\s*!app\.isPackaged/);
});
