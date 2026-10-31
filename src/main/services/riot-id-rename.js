const { loadAccounts, saveAccounts } = require('./storage');

// A player changed their Riot ID: the accounts that had the old one get the
// new one, and the rank history and saved games follow, so nothing is lost.
// Returns the usernames that changed.

function norm(s) {
    return String(s || '').trim().toLowerCase();
}

function renameAccountRiotId(oldId, newId) {
    if (!norm(oldId) || !norm(newId) || norm(oldId) === norm(newId)) return [];
    const accounts = loadAccounts();
    const changed = [];
    for (const a of accounts) {
        if (norm(a.riotId) !== norm(oldId)) continue;
        a.riotId = newId;
        delete a._cachedStats; // keyed by the old name
        changed.push(a.username);
    }
    if (!changed.length) return [];
    saveAccounts(accounts);
    require('./rank-history').renameRankHistory(oldId, newId);
    require('./matches').renameMatches(oldId, newId);
    return changed;
}

module.exports = { renameAccountRiotId };
