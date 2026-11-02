const { ipcMain } = require('electron');
const lcu = require('../lcu');
const state = require('../state');
const championData = require('../services/champion-data');
const { getRankHistory } = require('../services/rank-history');

// Today's session of the signed-in account: games since midnight from the
// client's own match history, the streak, and today's LP from the rank
// history. A pause hint after two losses in a row.

const { QUEUE_NAMES: ALL_QUEUES } = require('../../renderer/js/ui-lib.js');
const QUEUE_NAMES = { ...ALL_QUEUES, 420: 'Ranked Solo', 440: 'Ranked Flex' };

// games: the LCU match history list (legacy shape, newest first).
function sessionFromGames(games, now = Date.now(), idToKey = {}) {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const today = (Array.isArray(games) ? games : [])
        .filter((g) => g?.gameCreation >= midnight.getTime() && g.gameCreation <= now)
        .map((g) => {
            const p = g.participants?.[0] || {};
            return {
                ts: g.gameCreation,
                win: !!p.stats?.win,
                remake: (g.gameDuration || 0) < 300,
                champion: idToKey[p.championId] || '',
                queue: QUEUE_NAMES[g.queueId] || 'Other',
            };
        })
        .filter((g) => !g.remake)
        .sort((a, b) => b.ts - a.ts);
    const wins = today.filter((g) => g.win).length;
    let streak = 0;
    for (const g of today) {
        if (g.win !== today[0].win) break;
        streak++;
    }
    return {
        games: today,
        wins,
        losses: today.length - wins,
        streak: today.length ? { win: today[0].win, count: streak } : null,
        // Two losses in a row: suggest a short break.
        pauseHint: !!today.length && !today[0].win && streak >= 2,
    };
}

async function getSession() {
    if (!lcu.connected) return { connected: false };
    if (require('../services/vault').isVaultLocked()) return { connected: true, locked: true };
    const res = await lcu.request('GET', '/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=19');
    const session = sessionFromGames(res?.games?.games, Date.now(), championData.getIdToNameMap());
    const riotId = state.currentAccount?.riotId;
    const history = riotId ? getRankHistory(riotId) : [];
    const { dailySummary } = require('../../renderer/js/ui-lib.js');
    const day = dailySummary(history);
    return { connected: true, version: championData.getLatestVersion(), label: state.currentAccount?.label || state.currentAccount?.username || '', lp: day ? day.lp : null, ...session };
}

function register() {
    ipcMain.handle('get-session', () => getSession());
}

module.exports = { register, sessionFromGames };
