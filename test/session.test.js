require('./helpers/fake-electron');
const test = require('node:test');
const assert = require('node:assert/strict');
const { sessionFromGames } = require('../src/main/ipc/session');

const at = (h, m = 0) => new Date(2026, 9, 31, h, m).getTime();
const game = (ts, win, champ = 103, queue = 420, duration = 1800) => ({ gameCreation: ts, gameDuration: duration, queueId: queue, participants: [{ championId: champ, stats: { win } }] });

test('today: games since midnight, record and the current streak', () => {
    const s = sessionFromGames([
        game(at(21), false), game(at(20), false), game(at(19), true), game(at(18), true),
        game(at(17), true, 103, 420, 120), // remake
        game(new Date(2026, 9, 30, 23).getTime(), true), // yesterday
    ], at(22), { 103: 'Ahri' });
    assert.equal(s.games.length, 4);
    assert.deepEqual([s.wins, s.losses], [2, 2]);
    assert.deepEqual(s.streak, { win: false, count: 2 });
    assert.equal(s.pauseHint, true, 'two losses in a row');
    assert.equal(s.games[0].champion, 'Ahri');
    assert.equal(s.games[0].queue, 'Ranked Solo');
});

test('no break hint after a win or a single loss', () => {
    assert.equal(sessionFromGames([game(at(20), false), game(at(19), true)], at(21)).pauseHint, false);
    assert.equal(sessionFromGames([game(at(20), true), game(at(19), false), game(at(18), false)], at(21)).pauseHint, false);
    assert.deepEqual(sessionFromGames([], at(21)), { games: [], wins: 0, losses: 0, streak: null, pauseHint: false });
});
