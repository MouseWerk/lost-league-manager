// Today's LP and games, and progress toward a goal rank, from rank history.
require('./helpers/fake-electron');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const lib = require('../src/renderer/js/ui-lib.js');
const history = require('../src/main/services/rank-history');
const state = require('../src/main/state');

const at = (h, m = 0, day = 18) => new Date(2026, 9, day, h, m).getTime();
const e = (ts, score, wins, losses) => ({ ts, score, wins, losses });

test('the renderer ladder score matches the stored rank history score', () => {
    for (const [tier, div, lp] of [['GOLD', 'II', 40], ['IRON', 'IV', 0], ['DIAMOND', 'I', 99], ['MASTER', null, 250], ['CHALLENGER', null, 1200]]) {
        assert.equal(lib.ladderScore(`${tier} ${div || ''}`.trim(), lp), history.rankScore(tier, div, lp), `${tier} ${div}`);
    }
    assert.equal(lib.ladderScore('Unranked'), null);
});

test('today counts from the last entry before midnight', () => {
    const list = [e(at(22, 0, 17), 1240, 50, 40), e(at(10), 1258, 51, 40), e(at(12), 1241, 51, 41), e(at(15), 1262, 52, 41)];
    assert.deepEqual(lib.dailySummary(list, at(18)), { lp: 22, wins: 2, losses: 1 });
});

test('without an entry before today, the first one of the day is the start', () => {
    const list = [e(at(10), 1200, 10, 10), e(at(11), 1218, 11, 10)];
    assert.deepEqual(lib.dailySummary(list, at(18)), { lp: 18, wins: 1, losses: 0 });
});

test('no games today, no summary; a season reset leaves the games unknown', () => {
    assert.equal(lib.dailySummary([e(at(22, 0, 17), 1200, 5, 5)], at(18)), null);
    assert.equal(lib.dailySummary([], at(18)), null);
    const reset = [e(at(22, 0, 17), 1200, 80, 70), e(at(10), 800, 1, 0)];
    assert.deepEqual(lib.dailySummary(reset, at(18)), { lp: -400, wins: null, losses: null });
});

test('goal progress runs from the first entry to the goal', () => {
    const list = [e(1, lib.ladderScore('GOLD IV', 0)), e(2, lib.ladderScore('GOLD II', 50))];
    const g = lib.goalProgress(list, 'PLATINUM IV');
    assert.equal(g.left, 150);
    assert.equal(g.pct, 63);
    assert.equal(g.reached, false);
    assert.equal(lib.goalProgress(list, 'GOLD III').reached, true);
    assert.equal(lib.goalProgress([], 'GOLD III').current, null);
    assert.equal(lib.goalProgress(list, ''), null);
});

// A 0 LP loss (bottom of a division) changes nothing but the losses; it
// was not recorded, so the day missed that game.
test('a game that leaves the score unchanged is still recorded', () => {
    fs.rmSync(state.paths.rankHistory, { force: true });
    history.recordRankSnapshot('Me#EUW', 'GOLD', 'IV', 0, 'lcu', { wins: 3, losses: 2 });
    history.recordRankSnapshot('Me#EUW', 'GOLD', 'IV', 0, 'lcu', { wins: 3, losses: 2 });
    history.recordRankSnapshot('Me#EUW', 'GOLD', 'IV', 0, 'lcu', { wins: 3, losses: 3 });
    const list = history.getRankHistory('me#euw');
    assert.equal(list.length, 2);
    assert.deepEqual([list[1].wins, list[1].losses], [3, 3]);
});

test('win/loss text is parsed for the snapshots', () => {
    assert.deepEqual(history.parseRecord('12W 8L'), { wins: 12, losses: 8 });
    assert.equal(history.parseRecord(''), null);
    assert.equal(history.parseRecord('58%'), null);
});
