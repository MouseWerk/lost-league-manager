const { invoke } = require('./helpers/fake-electron');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const state = require('../src/main/state');
const { weeklySummary, rankChart, scoreLabel, ladderScore } = require('../src/renderer/js/ui-lib.js');
require('../src/main/ipc/stats').register();

const DAY = 86400000;
const NOW = 100 * DAY;

test('the week starts from the last entry before it', () => {
    const history = [
        { ts: NOW - 10 * DAY, score: 1000, wins: 10, losses: 10 },
        { ts: NOW - 3 * DAY, score: 1040, wins: 12, losses: 10 },
        { ts: NOW - DAY, score: 1020, wins: 12, losses: 11 },
    ];
    assert.deepEqual(weeklySummary(history, NOW), { lp: 20, wins: 2, losses: 1 });
    assert.equal(weeklySummary(history.slice(0, 1), NOW), null);
    assert.equal(weeklySummary([], NOW), null);
});

test('the rank chart puts every account on one scale, with tier lines', () => {
    const a = [{ ts: NOW - 40 * DAY, score: ladderScore('GOLD I', 50) }, { ts: NOW - 5 * DAY, score: ladderScore('PLATINUM IV', 20) }];
    const b = [{ ts: NOW - 2 * DAY, score: ladderScore('SILVER II', 10) }];
    const c = [{ ts: NOW - 60 * DAY, score: 5 }].slice(0, 0);
    const chart = rankChart([{ key: 0, history: a }, { key: 1, history: b }, { key: 2, history: c }], NOW - 30 * DAY, NOW, 800, 240, 10);
    assert.equal(chart.series.length, 2, 'an account without entries is left out');
    const [sa, sb] = chart.series;
    assert.equal(sa.points[0].x, 10, 'the entry before the window starts at the left edge');
    assert.equal(sa.points[sa.points.length - 1].x, 790, 'and the line runs to now');
    assert.ok(sb.points.every((p) => p.y > sa.points[2].y), 'Silver sits below Platinum');
    assert.deepEqual(chart.ticks.map((t) => t.tier), ['Gold', 'Platinum']);
    assert.equal(rankChart([], 0, 1, 10, 10).series.length, 0);
});

test('a score reads as a rank again', () => {
    assert.equal(scoreLabel(ladderScore('GOLD II', 57)), 'Gold II 57 LP');
    assert.equal(scoreLabel(ladderScore('MASTER', 150)), 'Master 150 LP');
});

test('all histories come in one call, only for saved accounts', async () => {
    fs.writeFileSync(state.paths.accounts, JSON.stringify([{ username: 'a', password: 'x', riotId: 'One#EUW' }, { username: 'b', password: 'x' }]));
    fs.writeFileSync(state.paths.rankHistory, JSON.stringify({ 'one#euw': [{ ts: 1, score: 5, tier: 'IRON', division: 'IV', lp: 5 }], 'other#euw': [{ ts: 1, score: 9 }] }));
    const res = await invoke('get-all-rank-history');
    assert.deepEqual(Object.keys(res), ['one#euw']);
});

test('season review: peak, current, longest ranked win streak, champions', async (t) => {
    const matches = require('../src/main/services/matches');
    const opgg = require('../src/main/services/opgg-api');
    const championData = require('../src/main/services/champion-data');
    const { getSeasonReview, longestWinStreak } = require('../src/main/ipc/stats');
    const now = new Date(2026, 9, 31).getTime();
    fs.writeFileSync(state.paths.rankHistory, JSON.stringify({ 'season#euw': [
        { ts: new Date(2025, 11, 20).getTime(), tier: 'MASTER', division: null, lp: 50, score: 2850 }, // last season
        { ts: new Date(2026, 2, 1).getTime(), tier: 'GOLD', division: 'I', lp: 10, score: 1510 },
        { ts: new Date(2026, 6, 1).getTime(), tier: 'PLATINUM', division: 'III', lp: 40, score: 1740 },
        { ts: new Date(2026, 9, 20).getTime(), tier: 'PLATINUM', division: 'IV', lp: 5, score: 1605 },
    ] }));
    fs.rmSync(state.paths.matchStore, { force: true });
    const g = (d, win, queue = 'Ranked Solo') => ({ id: `g${d}`, createdAt: new Date(2026, 9, d).getTime(), win, queue, champion: `C${d}` });
    matches.mergeMatches('Season#EUW', [g(1, true), g(2, true), g(3, true), g(4, false), g(5, true), g(6, true, 'ARAM')]);
    t.mock.method(championData, 'whenReady', async () => {});
    t.mock.method(opgg, 'getProfile', async () => ({ winLose: '60W 40L', ratio: '60%', championPool: [{ id: 103, name: 'Ahri', games: 40, wins: 26 }] }));
    const r = await getSeasonReview('euw', 'Season#EUW', now);
    assert.equal(r.peak.tier, 'PLATINUM', 'last season does not count');
    assert.equal(r.current.division, 'IV');
    assert.equal(r.longestWinStreak, 3, 'ranked only');
    assert.deepEqual(r.champions.map((c) => [c.name, c.games, c.winRate]), [['Ahri', 40, 65]]);
    assert.equal(longestWinStreak([]), 0);
});

test('the summary band adds up the week of every account and their Blue Essence', () => {
    const { overviewTotals } = require('../src/renderer/js/ui-lib.js');
    const t = overviewTotals([
        { acc: { status: { wallet: { be: 100000 } } }, week: { lp: 134, wins: 7, losses: 3 } },
        { acc: { status: { wallet: { be: 41250 } } }, week: { lp: -10, wins: 4, losses: 2 } },
        { acc: {}, week: { lp: 18, wins: null, losses: null } },
        { acc: {}, week: null },
    ]);
    assert.deepEqual(t, { games: 16, wins: 11, losses: 5, winRate: 69, lp: 142, tracked: 3, be: 141250 });
    const none = overviewTotals([{ acc: {}, week: null }]);
    assert.equal(none.winRate, null);
    assert.equal(none.lp, null);
    assert.equal(none.be, null);
});

test('needs attention lists each account once, bans first, its warnings inside', () => {
    const { attentionList } = require('../src/renderer/js/ui-lib.js');
    const list = attentionList([
        { acc: { username: 'a', label: 'NA alt' }, warnings: [{ kind: 'inactive', text: 'Not played for 40 days', urgent: false }, { kind: 'decay', text: 'Decays in 2 days', urgent: true }] },
        { acc: { username: 'b', label: 'Fresh' }, warnings: [] },
        { acc: { username: 'c', label: 'Smurf' }, warnings: [{ kind: 'ban', text: 'Suspended, 1d 6h left', urgent: true }] },
    ]);
    assert.deepEqual(list.map(e => e.name), ['Smurf', 'NA alt']);
    assert.deepEqual(list[1].items.map(i => i.kind), ['decay', 'inactive'], 'the urgent warning first');
    assert.equal(list[1].kind, 'decay');
});

test('the Overview is cards and an attention list, no longer a table', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
    for (const id of ['overviewSummary', 'overviewAccounts', 'overviewAttention', 'overviewChart']) assert.match(html, new RegExp(`id="${id}"`), id);
    assert.doesNotMatch(html, /id="overviewTable"|id="overviewTiles"/);
});
