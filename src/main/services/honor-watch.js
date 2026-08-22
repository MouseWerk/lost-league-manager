const state = require('../state');
const { loadJson, saveJson } = require('./json-store');

// Tracks each account's peak honor level so a drop can be flagged and the
// flag auto-clears once honor recovers back to where it was. Keyed by
// username (not riotId) — honor-v2 data is only available for whichever
// account is currently signed into the League client, captured at that
// moment via state.currentAccount.
//
// Chat/ranked restriction status isn't tracked here: the LCU honor-v2
// endpoint doesn't expose a verified, stable field for that (unlike
// honorLevel, which this app already reads elsewhere), and guessing at a
// field name would silently never fire rather than actually detect anything.

function loadHonorWatch() {
    return loadJson(state.paths.honorWatch, {}, 'honor watch data', (v) => v !== null && typeof v === 'object' && !Array.isArray(v));
}

function saveHonorWatch(data) {
    // Best-effort: this rides along on get-lcu-overview, whose primary job is
    // returning live overlay data — a write failure here must never surface
    // as a failure of that unrelated primary operation.
    try {
        saveJson(state.paths.honorWatch, data, 'honor watch data');
    } catch { /* logged by saveJson already */ }
}

function recordHonorLevel(username, honorLevel) {
    if (!username || typeof honorLevel !== 'number') return;
    const data = loadHonorWatch();
    const prev = data[username];
    if (prev && prev.current === honorLevel) return; // unchanged — skip the write
    const peak = Math.max(prev?.peak ?? honorLevel, honorLevel);
    data[username] = { peak, current: honorLevel, updatedAt: Date.now() };
    saveHonorWatch(data);
}

function isFlaggedRecord(rec) {
    return !!rec && rec.current < rec.peak;
}

function isHonorFlagged(username) {
    return isFlaggedRecord(loadHonorWatch()[username]);
}

module.exports = { recordHonorLevel, isHonorFlagged, loadHonorWatch, isFlaggedRecord };
