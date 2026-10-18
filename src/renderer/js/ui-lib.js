// Pure helpers shared by app.js. No DOM, no IPC: loaded by a <script> tag
// before app.js (exposed as window.UiLib) and required by the unit tests in
// test/d-*.test.js through module.exports.
(function (root) {
  "use strict";

  function escapeHtml(str) {
    return String(str ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  }

  // ── Rank sorting ───────────────────────────────────────────────────────────
  const TIER_ORDER = {
    challenger: 10,
    grandmaster: 9,
    master: 8,
    diamond: 7,
    emerald: 6,
    platinum: 5,
    gold: 4,
    silver: 3,
    bronze: 2,
    iron: 1,
    unranked: 0,
  };
  const APEX_TIERS = new Set(["master", "grandmaster", "challenger"]);
  // Tier text from the main process uses Roman numerals ("Gold IV"); digits
  // are accepted too in case a source ever sends "Gold 4".
  const DIVISION_ORDER = { i: 4, ii: 3, iii: 2, iv: 1, 1: 4, 2: 3, 3: 2, 4: 1 };

  // One number per solo queue rank: tier, then division, then LP. LP gets the
  // low four digits (apex LP can pass 1000, division LP never passes 100), so
  // Gold IV 99 LP < Gold III 0 LP and Grandmaster 0 LP > Master 1500 LP.
  // Accepts a stats object ({ tier: "Gold IV", lp: "45 LP" }) or tier text.
  // Returns -1 for anything that is not a rank (loading, N/A, errors).
  function rankScore(stats) {
    const tierText = typeof stats === "string" ? stats : stats?.tier;
    if (!tierText || typeof tierText !== "string") return -1;
    const parts = tierText.trim().toLowerCase().split(/\s+/);
    const tier = TIER_ORDER[parts[0]];
    if (tier === undefined) return -1;
    if (tier === 0) return 0;
    const division = APEX_TIERS.has(parts[0]) ? 0 : DIVISION_ORDER[parts[1]] || 0;
    const lpRaw = typeof stats === "object" ? stats.lp : undefined;
    const lp = Math.max(0, Math.min(9999, parseInt(String(lpRaw ?? ""), 10) || 0));
    return tier * 100000 + division * 10000 + lp;
  }

  // ── Drag-and-drop reorder ──────────────────────────────────────────────────
  // Moves the item at srcIdx so it takes the place of the item at tgtIdx:
  // dropping on a card above lands before it, on a card below lands after it.
  function reorderList(list, srcIdx, tgtIdx) {
    const out = list.slice();
    if (srcIdx < 0 || tgtIdx < 0 || srcIdx >= out.length || tgtIdx >= out.length) return out;
    const [moved] = out.splice(srcIdx, 1);
    out.splice(tgtIdx, 0, moved);
    return out;
  }

  // ── Renderer stats cache ───────────────────────────────────────────────────
  // The main process keeps its own 30-minute cache; the renderer asks again
  // after 10 minutes so a game played in the meantime shows up.
  const STATS_TTL_MS = 10 * 60 * 1000;

  function statsKey(acc) {
    const region = String(acc?.region || "").trim().toLowerCase();
    const riotId = String(acc?.riotId || "").trim().toLowerCase();
    return `${region}|${riotId}`;
  }

  // Errors and "N/A" (Riot ID could not be parsed) are never cached, so the
  // next render asks again instead of showing the failure all session.
  function shouldCacheStats(stats) {
    return !!stats && typeof stats === "object" && !stats.error && stats.tier !== "N/A";
  }

  function makeStatsEntry(stats, acc, now) {
    return { stats, key: statsKey(acc), at: now };
  }

  // 'missing': nothing usable (no entry, or it belongs to another Riot ID or
  // region). 'stale': show it but fetch again. 'fresh': show it, no fetch.
  // A timestamp in the future (clock moved back) counts as stale.
  function statsEntryState(entry, acc, now, ttl = STATS_TTL_MS) {
    if (!entry || entry.key !== statsKey(acc)) return "missing";
    const age = now - entry.at;
    return age >= 0 && age < ttl ? "fresh" : "stale";
  }

  // ── Stat viewer ────────────────────────────────────────────────────────────
  // Riot's per-level growth: base + growth * (L - 1) * (0.7025 + 0.0175 * (L - 1)).
  function statGrowthFactor(level) {
    return 0.7025 + 0.0175 * (level - 1);
  }
  function growStat(base, perLevel, level) {
    return (base || 0) + (perLevel || 0) * (level - 1) * statGrowthFactor(level);
  }
  // Bonus attack speed per level is a percentage of the attack speed ratio.
  // Data Dragon only has the base value, which equals the ratio for most
  // champions, so it stands in for the ratio (a few champions differ slightly).
  function attackSpeedAt(base, perLevelPct, level) {
    const bonusPct = (perLevelPct || 0) * (level - 1) * statGrowthFactor(level);
    return (base || 0) * (1 + bonusPct / 100);
  }

  // ── Rank sparkline ─────────────────────────────────────────────────────────
  // history: [{ score }], oldest first. Fills the whole w x h box minus pad.
  function sparklinePoints(history, w, h, pad = 3) {
    if (!Array.isArray(history) || history.length === 0) return [];
    const scores = history.map((e) => Number(e.score) || 0);
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const range = max - min || 1;
    const n = history.length;
    return scores.map((score, i) => ({
      x: pad + (n === 1 ? 0 : (i / (n - 1)) * (w - pad * 2)),
      y: max === min ? h / 2 : h - pad - ((score - min) / range) * (h - pad * 2),
    }));
  }

  // ── Live view ──────────────────────────────────────────────────────────────
  // Lobby members carry gameName/tagLine since the Riot ID migration; the old
  // summoner name fields are often empty.
  function lobbyMemberLabel(m) {
    if (!m) return "?";
    if (m.gameName) return m.tagLine ? `${m.gameName}#${m.tagLine}` : m.gameName;
    return m.summonerName || m.summonerInternalName || "?";
  }

  // ── Launch status ──────────────────────────────────────────────────────────
  const LAUNCH_ATTENTION_KINDS = ["failed", "wrong-account", "needs-action"];

  // Normalizes a login-status payload. Older main processes send no `kind`:
  // `error: true` means failed and progress 100 means done.
  function normalizeLoginStatus(data) {
    if (data == null || data === "") return { clear: true };
    if (typeof data === "string") return { clear: false, message: data, progress: 0, kind: null };
    const message = typeof data.message === "string" ? data.message : "";
    if (!message && !data.kind) return { clear: true };
    let kind = typeof data.kind === "string" ? data.kind : null;
    if (!kind && data.error) kind = "failed";
    if (!kind && data.progress === 100) kind = "done";
    const progress = Math.max(0, Math.min(100, Number(data.progress) || 0));
    return { clear: false, message, progress, kind };
  }

  function needsLaunchAttention(kind) {
    return LAUNCH_ATTENTION_KINDS.includes(kind);
  }

  // ── Passphrases ────────────────────────────────────────────────────────────
  // Never trimmed: a leading or trailing space is part of the passphrase.
  const MIN_PASSPHRASE_LENGTH = 8;
  function validateNewPassphrase(first, second, min = MIN_PASSPHRASE_LENGTH) {
    const a = String(first ?? "");
    if (a.length < min) return `Use at least ${min} characters`;
    if (a !== String(second ?? "")) return "The two entries do not match";
    return null;
  }

  function secondsUntil(ms) {
    return Math.max(1, Math.ceil((Number(ms) || 0) / 1000));
  }

  const api = {
    escapeHtml,
    TIER_ORDER,
    rankScore,
    reorderList,
    STATS_TTL_MS,
    statsKey,
    shouldCacheStats,
    makeStatsEntry,
    statsEntryState,
    statGrowthFactor,
    growStat,
    attackSpeedAt,
    sparklinePoints,
    lobbyMemberLabel,
    normalizeLoginStatus,
    needsLaunchAttention,
    MIN_PASSPHRASE_LENGTH,
    validateNewPassphrase,
    secondsUntil,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.UiLib = api;
})(this);
