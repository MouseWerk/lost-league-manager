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
  // Bonus attack speed per level is a percentage of the attack speed ratio
  // (from Community Dragon). Without it the base value stands in, which is
  // equal for most champions.
  function attackSpeedAt(base, perLevelPct, level, ratio) {
    const bonusPct = (perLevelPct || 0) * (level - 1) * statGrowthFactor(level);
    return (base || 0) + (ratio > 0 ? ratio : base || 0) * (bonusPct / 100);
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

  // ── Today and goal ─────────────────────────────────────────────────────────
  // Ladder position on the same scale as the main process's rank history
  // (src/main/services/rank-history.js): 400 per tier, 100 per division.
  const LADDER = ["iron", "bronze", "silver", "gold", "platinum", "emerald", "diamond", "master", "grandmaster", "challenger"];
  function ladderScore(tierText, lp = 0) {
    const parts = String(tierText || "").trim().toLowerCase().split(/\s+/);
    const idx = LADDER.indexOf(parts[0]);
    if (idx === -1) return null;
    const div = APEX_TIERS.has(parts[0]) ? 0 : (DIVISION_ORDER[parts[1]] || 1) - 1; // IV = 0 ... I = 3
    return idx * 400 + div * 100 + (Number(lp) || 0);
  }

  // LP and games since local midnight, from rank history entries
  // ({ ts, score, wins?, losses? }, oldest first). The day starts from the
  // last entry before midnight, or the first one of the day. null when the
  // day has no entries.
  function dailySummary(history, now = Date.now()) {
    if (!Array.isArray(history) || !history.length) return null;
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const start = midnight.getTime();
    const today = history.filter((e) => e.ts >= start && e.ts <= now);
    if (!today.length) return null;
    const before = history.filter((e) => e.ts < start);
    const base = before.length ? before[before.length - 1] : today[0];
    const last = today[today.length - 1];
    const out = { lp: last.score - base.score, wins: null, losses: null };
    if ([base.wins, base.losses, last.wins, last.losses].every(Number.isInteger)) {
      const w = last.wins - base.wins;
      const l = last.losses - base.losses;
      // A season reset makes the counts drop; then the day's games are unknown.
      if (w >= 0 && l >= 0) Object.assign(out, { wins: w, losses: l });
    }
    if (out.lp === 0 && !out.wins && !out.losses) return null;
    return out;
  }

  // Progress toward a goal rank ("DIAMOND IV", "MASTER"), from the first
  // history entry (or one tier below the goal) to the goal.
  function goalProgress(history, goalRank) {
    const goal = ladderScore(goalRank, 0);
    if (goal === null) return null;
    const list = Array.isArray(history) ? history : [];
    const current = list.length ? list[list.length - 1].score : null;
    if (current === null) return { goal, current: null, left: null, pct: 0, reached: false };
    let start = list[0].score;
    if (start >= goal) start = Math.min(current, goal - 400);
    const span = Math.max(1, goal - start);
    const pct = Math.max(0, Math.min(100, Math.round(((current - start) / span) * 100)));
    return { goal, current, left: Math.max(0, goal - current), pct, reached: current >= goal };
  }

  // ── Tags ───────────────────────────────────────────────────────────────────
  // An account's tags are one comma-separated string; the main process
  // normalizes it (accounts.js), this only splits it.
  function parseTags(text) {
    return String(text || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }

  // Every tag in use, with how many accounts carry it, sorted by name.
  function tagCounts(accounts) {
    const counts = new Map();
    for (const a of accounts || []) {
      for (const t of parseTags(a.tags)) {
        const key = t.toLowerCase();
        const cur = counts.get(key);
        counts.set(key, { tag: cur ? cur.tag : t, count: (cur ? cur.count : 0) + 1 });
      }
    }
    return [...counts.values()].sort((a, b) => a.tag.localeCompare(b.tag));
  }

  function hasTag(account, tag) {
    const want = String(tag || "").toLowerCase();
    return parseTags(account && account.tags).some((t) => t.toLowerCase() === want);
  }

  // ── Account status ─────────────────────────────────────────────────────────
  const DAY_MS = 86400000;
  // Decay banks when the client has not told us (other accounts): Diamond
  // holds 28 days, Master and above 14. Only an estimate, shown as "about".
  const DECAY_BANK_DAYS = { diamond: 28, master: 14, grandmaster: 14, challenger: 14 };
  const INACTIVE_DAYS = 30;

  // Warnings for an account row and panel, most urgent first:
  // [{ kind: 'restriction'|'decay'|'inactive', text, urgent }].
  // status is the record from account-status.js, tier the solo tier text.
  function statusWarnings(status, tier, now) {
    const out = [];
    const s = status || {};
    const days = (ms) => Math.floor(ms / DAY_MS);
    const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
    if (s.restriction && s.restriction.gamesLeft > 0) {
      out.push({ kind: "restriction", text: `Ranked restricted, ${plural(s.restriction.gamesLeft, "normal game")} left`, urgent: true });
    }
    const bank = DECAY_BANK_DAYS[String(tier || "").trim().toLowerCase().split(/\s+/)[0]];
    if (s.decay && typeof s.decay.days === "number" && s.decay.checkedAt) {
      // The bank only drains while the account does not play.
      const played = s.lastPlayed && s.lastPlayed > s.decay.checkedAt;
      const left = played ? null : Math.max(0, s.decay.days - days(now - s.decay.checkedAt));
      if (left !== null && left <= 7) {
        out.push({ kind: "decay", text: left === 0 ? "Decaying now" : `Decays in ${plural(left, "day")}`, urgent: left <= 3 });
      }
    } else if (bank && s.lastPlayed) {
      const left = bank - days(now - s.lastPlayed);
      if (left <= 7) {
        out.push({ kind: "decay", text: left <= 0 ? "May be decaying" : `Decay in about ${plural(left, "day")}`, urgent: left <= 3 });
      }
    }
    if (s.lastPlayed && days(now - s.lastPlayed) >= INACTIVE_DAYS) {
      out.push({ kind: "inactive", text: `Not played for ${days(now - s.lastPlayed)} days`, urgent: false });
    }
    return out;
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
    ladderScore,
    dailySummary,
    goalProgress,
    parseTags,
    tagCounts,
    statusWarnings,
    hasTag,
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
