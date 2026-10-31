const lcu = require('../lcu');
const state = require('../state');
const { loadJson, saveJson } = require('./json-store');

// What the League client tells about the signed-in account and the list
// shows as warnings: when it last played, its ranked decay and a ranked
// restriction. The client only answers for the account that is signed in,
// so each record is the state at the time it was read (checkedAt); the
// renderer counts the days from there (ui-lib.js statusWarnings).
//
// Keyed by lower-cased username, like honor-watch.json.

function userKey(username) {
    return typeof username === 'string' ? username.toLowerCase() : '';
}

function loadStatus() {
    return loadJson(state.paths.accountStatus, {}, 'account status', (v) => v !== null && typeof v === 'object' && !Array.isArray(v));
}

function saveStatus(data) {
    // Best effort: a failed write must not break the client event that led here.
    try {
        saveJson(state.paths.accountStatus, data, 'account status');
    } catch { /* logged by saveJson already */ }
}

function update(username, fn) {
    const key = userKey(username);
    if (!key) return;
    const data = loadStatus();
    const next = fn({ ...(data[key] || {}) });
    data[key] = { ...next, updatedAt: Date.now() };
    saveStatus(data);
}

const isCount = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

// Decay from /lol-ranked/v1/current-ranked-stats: each queue carries a
// `warnings` object. Decay only applies from Diamond up: Diamond reads
// daysUntilDecay, Master and above apexDaysUntilDecay; other tiers' values
// are ignored (the client can send 0 there). Returns { queue, days } for the
// queue that decays first, or null.
const APEX = ['MASTER', 'GRANDMASTER', 'CHALLENGER'];
function parseDecay(rankedStats) {
    const queues = Array.isArray(rankedStats?.queues) ? rankedStats.queues : [];
    let best = null;
    for (const q of queues) {
        if (q?.queueType !== 'RANKED_SOLO_5x5' && q?.queueType !== 'RANKED_FLEX_SR') continue;
        const tier = String(q.tier || '').toUpperCase();
        const w = q.warnings;
        if (!w || typeof w !== 'object') continue;
        const days = APEX.includes(tier) ? w.apexDaysUntilDecay : tier === 'DIAMOND' ? w.daysUntilDecay : undefined;
        if (!isCount(days)) continue;
        if (!best || days < best.days) best = { queue: q.queueType, days };
    }
    return best;
}

// Ranked restriction from /lol-player-behavior/v1/ranked-restriction: the
// number of normal games still to play before ranked opens again.
function parseRestriction(data) {
    if (!data || typeof data !== 'object') return null;
    const games = [data.rankedRestrictedGamesRemaining, data.punishedGamesRemaining].find((v) => isCount(v) && v > 0);
    return games ? { gamesLeft: games } : null;
}

// Blue Essence and RP from the client's wallet. Newer clients answer
// /lol-inventory/v1/wallet/<currency> with { <currency>: n }, older ones
// /lol-store/v1/wallet with { ip, rp }. null when neither answered.
function parseWallet(rpRes, beRes, storeRes) {
    const pick = (res, key) => (res && typeof res === 'object' && isCount(res[key]) ? res[key] : null);
    const rp = pick(rpRes, 'RP') ?? pick(storeRes, 'rp');
    const be = pick(beRes, 'lol_blue_essence') ?? pick(storeRes, 'ip');
    return rp === null && be === null ? null : { rp, be };
}

// Reads decay and restriction for the signed-in account. Endpoints that are
// missing return null and leave the old value untouched.
async function captureStatus(username) {
    if (!username) return;
    const [ranked, restriction, rpRes, beRes] = await Promise.all([
        lcu.request('GET', '/lol-ranked/v1/current-ranked-stats'),
        lcu.request('GET', '/lol-player-behavior/v1/ranked-restriction'),
        lcu.request('GET', '/lol-inventory/v1/wallet/RP'),
        lcu.request('GET', '/lol-inventory/v1/wallet/lol_blue_essence'),
    ]);
    const storeRes = rpRes === null && beRes === null ? await lcu.request('GET', '/lol-store/v1/wallet') : null;
    const wallet = parseWallet(rpRes, beRes, storeRes);
    if (ranked === null && restriction === null && !wallet) return;
    const now = Date.now();
    update(username, (rec) => {
        if (ranked !== null) rec.decay = (() => { const d = parseDecay(ranked); return d ? { ...d, checkedAt: now } : null; })();
        if (restriction !== null) rec.restriction = (() => { const r = parseRestriction(restriction); return r ? { ...r, checkedAt: now } : null; })();
        if (wallet) rec.wallet = { ...wallet, checkedAt: now };
        return rec;
    });
}

// Any game counts as played; only ranked games stop decay (lastRankedPlayed).
function recordLastPlayed(username, ts = Date.now(), { ranked = false } = {}) {
    if (!username || !isCount(ts)) return;
    update(username, (rec) => {
        if (!(rec.lastPlayed >= ts)) rec.lastPlayed = ts;
        if (ranked && !(rec.lastRankedPlayed >= ts)) rec.lastRankedPlayed = ts;
        return rec;
    });
}

function getStatusMap() {
    return loadStatus();
}

function statusFor(map, username) {
    return map[userKey(username)] || null;
}

// Called when an account is deleted.
function forgetStatus(username) {
    const data = loadStatus();
    const key = userKey(username);
    if (!(key in data)) return;
    delete data[key];
    saveStatus(data);
}

module.exports = { parseDecay, parseRestriction, parseWallet, captureStatus, recordLastPlayed, getStatusMap, statusFor, forgetStatus };
