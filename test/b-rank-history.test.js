const { writeJson, readJson } = require('./helpers/b-fakes');
const test = require('node:test');
const assert = require('node:assert/strict');
const { recordRankSnapshot, getRankHistory } = require('../src/main/services/rank-history');

test.beforeEach(() => writeJson('rank-history.json', {}));

test('apex tiers are one snapshot no matter how the source spells the division', () => {
    for (let i = 0; i < 3; i++) {
        recordRankSnapshot('Apex#EUW', 'MASTER', 'NA', 120, 'lcu');
        recordRankSnapshot('Apex#EUW', 'MASTER', 'I', 120, 'riot-api');
        recordRankSnapshot('Apex#EUW', 'MASTER', '', 120);
        recordRankSnapshot('Apex#EUW', 'MASTER', undefined, 120);
    }
    assert.equal(getRankHistory('Apex#EUW').length, 1);
    recordRankSnapshot('Apex#EUW', 'MASTER', 'I', 150, 'riot-api');
    assert.equal(getRankHistory('Apex#EUW').length, 2);
});

test('lagging OP.GG data right after a client reading adds no fake drop', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000_000 });
    recordRankSnapshot('Lag#EUW', 'GOLD', 'II', 57, 'lcu');
    recordRankSnapshot('Lag#EUW', 'GOLD', 'II', 40, 'opgg');
    recordRankSnapshot('Lag#EUW', 'GOLD', 'II', 57, 'lcu');
    assert.deepEqual(getRankHistory('Lag#EUW').map(e => e.lp), [57]);

    // A different division from OP.GG is a real change and is recorded.
    recordRankSnapshot('Lag#EUW', 'GOLD', 'I', 10, 'opgg');
    assert.equal(getRankHistory('Lag#EUW').length, 2);

    // Hours later OP.GG is trusted again.
    t.mock.timers.tick(7 * 60 * 60 * 1000);
    recordRankSnapshot('Lag#EUW', 'GOLD', 'I', 30, 'riot-api');
    t.mock.timers.tick(7 * 60 * 60 * 1000);
    recordRankSnapshot('Lag#EUW', 'GOLD', 'I', 45, 'opgg');
    assert.deepEqual(getRankHistory('Lag#EUW').map(e => e.lp), [57, 10, 30, 45]);
});

test('Riot IDs that differ only in case share one history', () => {
    recordRankSnapshot('Name#EUW', 'SILVER', 'IV', 10);
    recordRankSnapshot('name#euw', 'SILVER', 'IV', 30);
    assert.equal(getRankHistory(' NAME#EUW ').length, 2);
});

test('old files keyed by the typed Riot ID are merged in time order', () => {
    writeJson('rank-history.json', {
        'Name#EUW': [{ ts: 1, tier: 'GOLD', division: 'IV', lp: 1, score: 1201 }, { ts: 3, tier: 'GOLD', division: 'IV', lp: 3, score: 1203 }],
        'name#euw': [{ ts: 2, tier: 'GOLD', division: 'IV', lp: 2, score: 1202 }],
    });
    assert.deepEqual(getRankHistory('name#EUW').map(e => e.ts), [1, 2, 3]);
    recordRankSnapshot('Name#EUW', 'GOLD', 'IV', 9);
    assert.deepEqual(Object.keys(readJson('rank-history.json')), ['name#euw']);
});
