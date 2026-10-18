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

// The DevTools console can call every IPC method the preload exposes.
test('no window opens DevTools in an installed build', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'windows.js'), 'utf8');
    const prefs = src.match(/webPreferences:\s*\{[^}]*\}/g) || [];
    assert.ok(prefs.length >= 2, 'expected the main and overlay window options');
    for (const p of prefs) assert.match(p, /devTools:\s*!app\.isPackaged/);
});
