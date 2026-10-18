const state = require('../state');
const { loadJson, saveJson } = require('./json-store');

// Per-account snapshot cap — a few hundred rank changes is years of history
// for any active player; keeps the file from growing unbounded.
const MAX_SNAPSHOTS_PER_ACCOUNT = 200;

const TIER_ORDER = [
    'IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD',
    'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER',
];
const DIVISION_ORDER = { IV: 0, III: 1, II: 2, I: 3 };
const APEX_TIERS = new Set(['MASTER', 'GRANDMASTER', 'CHALLENGER']);

// A single monotonic number for "how far up the ladder is this", so the
// sparkline reflects real progress across tier/division promotions instead of
// plotting raw LP (which resets to 0 on every promotion and would otherwise
// show a big misleading dip right when a player ranks up).
function rankScore(tier, division, lp) {
    const t = (tier || '').toUpperCase();
    const tierIdx = TIER_ORDER.indexOf(t);
    if (tierIdx === -1) return null;
    const divIdx = APEX_TIERS.has(t) ? 0 : (DIVISION_ORDER[division] ?? 0);
    return tierIdx * 400 + divIdx * 100 + (Number(lp) || 0);
}

// Keys are the trimmed, lower-cased Riot ID ("Name#EUW" and "name#euw" are
// the same player). Older files used the Riot ID as typed; such entries are
// merged into the normalized key when loaded.
function riotIdKey(riotId) {
    return typeof riotId === 'string' ? riotId.trim().toLowerCase() : '';
}

function loadRankHistory() {
    const raw = loadJson(state.paths.rankHistory, {}, 'rank history', (v) => v !== null && typeof v === 'object' && !Array.isArray(v));
    const history = {};
    for (const [id, entries] of Object.entries(raw)) {
        if (!Array.isArray(entries)) continue;
        const key = riotIdKey(id);
        if (!key) continue;
        if (history[key]) {
            // Two spellings of one Riot ID: interleave by time once.
            history[key] = history[key].concat(entries).sort((a, b) => (a.ts || 0) - (b.ts || 0)).slice(-MAX_SNAPSHOTS_PER_ACCOUNT);
        } else {
            history[key] = entries;
        }
    }
    return history;
}

function saveRankHistory(history) {
    // Best-effort: this is a side channel riding along on get-stats, whose
    // primary job is returning display data — a write failure here must
    // never surface as a failure of that unrelated primary operation.
    try {
        saveJson(state.paths.rankHistory, history, 'rank history');
    } catch { /* logged by saveJson already */ }
}

// OP.GG shows the last "renewed" profile, which often lags the League client
// and the Riot API. Within this window after an entry from one of those, an
// OP.GG snapshot is only recorded when the tier or division differs, so the
// sparkline does not show a drop and rise that never happened.
const OPGG_LAG_WINDOW_MS = 6 * 60 * 60 * 1000;
const FRESH_SOURCES = new Set(['lcu', 'riot-api']);

// Records a solo-queue rank snapshot for riotId, deduped against the last
// stored entry — only appended when the rank actually changed. Compares tier
// and division too, not just the numeric score: LP can briefly exceed 100
// within a division right after a big win, before the promotion is reflected
// in the tier/division fields, which can make two genuinely different ladder
// states (e.g. Gold IV @105 LP and the post-promotion Gold III @5 LP) land on
// the identical score — comparing score alone would silently drop the real
// promotion and leave the displayed label stuck on the stale pre-promotion tier.
//
// `source` ('lcu' | 'riot-api' | 'opgg') is optional and stored with the entry.
function recordRankSnapshot(riotId, tier, division, lp, source) {
    const key = riotIdKey(riotId);
    if (!key || !tier) return;
    const score = rankScore(tier, division, lp);
    if (score === null) return;

    const normTier = tier.toUpperCase();
    // Apex tiers have no division, but sources report it differently (LCU
    // "NA", Riot API and OP.GG "I"); comparing those would add a snapshot on
    // every source switch.
    const div = typeof division === 'string' ? division.toUpperCase() : '';
    const normDivision = APEX_TIERS.has(normTier) || !(div in DIVISION_ORDER) ? null : div;

    const history = loadRankHistory();
    const entries = history[key] || (history[key] = []);
    const last = entries[entries.length - 1];
    const sameRank = last && last.tier === normTier && last.division === normDivision;
    if (sameRank && last.score === score) return;
    if (source === 'opgg' && sameRank && FRESH_SOURCES.has(last.source)) {
        const age = Date.now() - (last.ts || 0);
        if (age >= 0 && age < OPGG_LAG_WINDOW_MS) return;
    }

    const entry = { ts: Date.now(), tier: normTier, division: normDivision, lp: Number(lp) || 0, score };
    if (source) entry.source = source;
    entries.push(entry);
    if (entries.length > MAX_SNAPSHOTS_PER_ACCOUNT) entries.splice(0, entries.length - MAX_SNAPSHOTS_PER_ACCOUNT);

    saveRankHistory(history);
}

function getRankHistory(riotId) {
    const key = riotIdKey(riotId);
    if (!key) return [];
    return loadRankHistory()[key] || [];
}

module.exports = { recordRankSnapshot, getRankHistory, rankScore };
