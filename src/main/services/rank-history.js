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

function loadRankHistory() {
    return loadJson(state.paths.rankHistory, {}, 'rank history', (v) => v !== null && typeof v === 'object' && !Array.isArray(v));
}

function saveRankHistory(history) {
    // Best-effort: this is a side channel riding along on get-stats, whose
    // primary job is returning display data — a write failure here must
    // never surface as a failure of that unrelated primary operation.
    try {
        saveJson(state.paths.rankHistory, history, 'rank history');
    } catch { /* logged by saveJson already */ }
}

// Records a solo-queue rank snapshot for riotId, deduped against the last
// stored entry — only appended when the rank actually changed. Compares tier
// and division too, not just the numeric score: LP can briefly exceed 100
// within a division right after a big win, before the promotion is reflected
// in the tier/division fields, which can make two genuinely different ladder
// states (e.g. Gold IV @105 LP and the post-promotion Gold III @5 LP) land on
// the identical score — comparing score alone would silently drop the real
// promotion and leave the displayed label stuck on the stale pre-promotion tier.
function recordRankSnapshot(riotId, tier, division, lp) {
    if (!riotId || !tier) return;
    const score = rankScore(tier, division, lp);
    if (score === null) return;

    const normTier = tier.toUpperCase();
    const normDivision = division || null;

    const history = loadRankHistory();
    const entries = history[riotId] || (history[riotId] = []);
    const last = entries[entries.length - 1];
    if (last && last.score === score && last.tier === normTier && last.division === normDivision) return;

    entries.push({ ts: Date.now(), tier: normTier, division: normDivision, lp: Number(lp) || 0, score });
    if (entries.length > MAX_SNAPSHOTS_PER_ACCOUNT) entries.splice(0, entries.length - MAX_SNAPSHOTS_PER_ACCOUNT);

    saveRankHistory(history);
}

function getRankHistory(riotId) {
    if (!riotId) return [];
    return loadRankHistory()[riotId] || [];
}

module.exports = { recordRankSnapshot, getRankHistory, rankScore };
