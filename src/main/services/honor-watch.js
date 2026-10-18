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

// Keys are lower-cased usernames (Riot logins are case-insensitive). Files
// written by older versions used the username as typed; those entries are
// merged into the lower-cased key when loaded.
function userKey(username) {
    return typeof username === 'string' ? username.toLowerCase() : '';
}

function mergeRecords(a, b) {
    const newer = (b.updatedAt || 0) >= (a.updatedAt || 0) ? b : a;
    return { peak: Math.max(a.peak ?? 0, b.peak ?? 0), current: newer.current, updatedAt: newer.updatedAt };
}

function loadHonorWatch() {
    const raw = loadJson(state.paths.honorWatch, {}, 'honor watch data', (v) => v !== null && typeof v === 'object' && !Array.isArray(v));
    const data = {};
    for (const [name, rec] of Object.entries(raw)) {
        if (!rec || typeof rec !== 'object') continue;
        const key = userKey(name);
        data[key] = data[key] ? mergeRecords(data[key], rec) : rec;
    }
    return data;
}

function saveHonorWatch(data) {
    // Best-effort: this rides along on get-lcu-overview, whose primary job is
    // returning live overlay data — a write failure here must never surface
    // as a failure of that unrelated primary operation.
    try {
        saveJson(state.paths.honorWatch, data, 'honor watch data');
    } catch { /* logged by saveJson already */ }
}

function getHonorRecord(data, username) {
    return data[userKey(username)];
}

function recordHonorLevel(username, honorLevel) {
    if (!username || typeof honorLevel !== 'number') return;
    const data = loadHonorWatch();
    const key = userKey(username);
    const prev = data[key];
    if (prev && prev.current === honorLevel) return; // unchanged — skip the write
    const peak = Math.max(prev?.peak ?? honorLevel, honorLevel);
    data[key] = { peak, current: honorLevel, updatedAt: Date.now() };
    saveHonorWatch(data);
}

// Called when an account is deleted.
function forgetHonor(username) {
    const data = loadHonorWatch();
    const key = userKey(username);
    if (!(key in data)) return;
    delete data[key];
    saveHonorWatch(data);
}

function isFlaggedRecord(rec) {
    return !!rec && rec.current < rec.peak;
}

function isHonorFlagged(username) {
    return isFlaggedRecord(getHonorRecord(loadHonorWatch(), username));
}

module.exports = { recordHonorLevel, isHonorFlagged, loadHonorWatch, getHonorRecord, forgetHonor, isFlaggedRecord };
