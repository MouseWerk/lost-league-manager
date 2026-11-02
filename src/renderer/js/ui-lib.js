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

  // A ladder score back to words: 1257 -> "Gold IV 57 LP", 2950 -> "Master 150 LP".
  function scoreLabel(score) {
    const s = Math.max(0, Math.round(score || 0));
    const idx = Math.min(LADDER.length - 1, Math.floor(s / 400));
    const tier = LADDER[idx].charAt(0).toUpperCase() + LADDER[idx].slice(1);
    const rest = s - idx * 400;
    if (APEX_TIERS.has(LADDER[idx])) return `${tier} ${rest} LP`;
    return `${tier} ${["IV", "III", "II", "I"][Math.floor(rest / 100)]} ${rest % 100} LP`;
  }

  // LP and games over the last seven days, like dailySummary: the week starts
  // from the last entry before it, or its first one. null without entries.
  const WEEK_MS = 7 * 86400000;
  function weeklySummary(history, now = Date.now()) {
    if (!Array.isArray(history) || !history.length) return null;
    const start = now - WEEK_MS;
    const week = history.filter((e) => e.ts >= start && e.ts <= now);
    if (!week.length) return null;
    const before = history.filter((e) => e.ts < start);
    const base = before.length ? before[before.length - 1] : week[0];
    const last = week[week.length - 1];
    const out = { lp: last.score - base.score, wins: null, losses: null };
    if ([base.wins, base.losses, last.wins, last.losses].every(Number.isInteger)) {
      const w = last.wins - base.wins;
      const l = last.losses - base.losses;
      if (w >= 0 && l >= 0) Object.assign(out, { wins: w, losses: l });
    }
    return out;
  }

  // Several rank histories on one chart from `from` to `to`, on one shared
  // ladder scale. Each series starts at its last entry before `from` (drawn
  // at the left edge) and ends at `to` with its latest score. ticks are the
  // tier lines (every 400) inside the range, with the tier name.
  function rankChart(histories, from, to, w, h, pad = 6) {
    const span = Math.max(1, to - from);
    const series = [];
    let min = Infinity;
    let max = -Infinity;
    for (const { key, history } of histories) {
      const list = Array.isArray(history) ? history : [];
      const inside = list.filter((e) => e.ts >= from && e.ts <= to);
      const before = list.filter((e) => e.ts < from).pop();
      const pts = [];
      if (before) pts.push({ ts: from, score: before.score });
      pts.push(...inside.map((e) => ({ ts: e.ts, score: e.score })));
      if (!pts.length) continue;
      pts.push({ ts: to, score: pts[pts.length - 1].score });
      for (const p of pts) {
        min = Math.min(min, p.score);
        max = Math.max(max, p.score);
      }
      series.push({ key, pts });
    }
    if (!series.length) return { series: [], ticks: [], min: 0, max: 0 };
    min = Math.floor(min / 100) * 100;
    max = Math.ceil(max / 100) * 100;
    if (max - min < 400) {
      const mid = (min + max) / 2;
      min = Math.max(0, Math.floor((mid - 200) / 100) * 100);
      max = min + 400;
    }
    const x = (ts) => pad + ((ts - from) / span) * (w - pad * 2);
    const y = (s) => h - pad - ((s - min) / (max - min)) * (h - pad * 2);
    const ticks = [];
    for (let s = Math.ceil(min / 400) * 400; s <= max; s += 400) {
      const tier = LADDER[Math.floor(s / 400)];
      if (tier) ticks.push({ y: y(s), score: s, tier: tier.charAt(0).toUpperCase() + tier.slice(1) });
    }
    return {
      min,
      max,
      ticks,
      series: series.map((s) => ({ key: s.key, points: s.pts.map((p) => ({ x: x(p.ts), y: y(p.score), ts: p.ts, score: p.score })) })),
    };
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
    // Only ranked games stop decay; normals, ARAM and practice do not.
    const lastRanked = s.lastRankedPlayed;
    if (s.decay && typeof s.decay.days === "number" && s.decay.checkedAt) {
      // The bank only drains while the account does not play ranked.
      const played = lastRanked && lastRanked > s.decay.checkedAt;
      const left = played ? null : Math.max(0, s.decay.days - days(now - s.decay.checkedAt));
      if (left !== null && left <= 7) {
        out.push({ kind: "decay", text: left === 0 ? "Decaying now" : `Decays in ${plural(left, "day")}`, urgent: left <= 3 });
      }
    } else if (bank && lastRanked) {
      const left = bank - days(now - lastRanked);
      if (left <= 7) {
        out.push({ kind: "decay", text: left <= 0 ? "May be decaying" : `Decay in about ${plural(left, "day")}`, urgent: left <= 3 });
      }
    }
    if (s.lastPlayed && days(now - s.lastPlayed) >= INACTIVE_DAYS) {
      out.push({ kind: "inactive", text: `Not played for ${days(now - s.lastPlayed)} days`, urgent: false });
    }
    return out;
  }

  // ── Games ──────────────────────────────────────────────────────────────────
  // Per champion over the stored games (matches.js shape), most played first.
  // kda is null for a champion without deaths ("perfect").
  function championStats(matches) {
    const by = new Map();
    for (const m of matches || []) {
      if (!m || !m.champion) continue;
      const c = by.get(m.champion) || { champion: m.champion, icon: m.championIcon || null, games: 0, wins: 0, k: 0, d: 0, a: 0, cs: 0, seconds: 0 };
      c.games += 1;
      c.wins += m.win ? 1 : 0;
      c.k += m.kills || 0;
      c.d += m.deaths || 0;
      c.a += m.assists || 0;
      c.cs += m.cs || 0;
      c.seconds += m.duration || 0;
      by.set(m.champion, c);
    }
    return [...by.values()]
      .map((c) => ({
        champion: c.champion,
        icon: c.icon,
        games: c.games,
        wins: c.wins,
        winRate: Math.round((c.wins / c.games) * 100),
        kda: c.d ? Math.round(((c.k + c.a) / c.d) * 100) / 100 : null,
        csPerMin: c.seconds ? Math.round((c.cs / (c.seconds / 60)) * 10) / 10 : null,
      }))
      .sort((a, b) => b.games - a.games || b.winRate - a.winRate);
  }

  // Your record against each lane opponent (the enemy in your position) over
  // games that know both teams. Most played first.
  function matchupStats(matches) {
    const by = new Map();
    for (const m of matches || []) {
      const players = Array.isArray(m && m.players) ? m.players : [];
      const me = players.find((p) => p.isSelf);
      if (!me || !me.position) continue;
      const opp = players.find((p) => p.team !== me.team && p.position === me.position);
      if (!opp || !opp.champion) continue;
      const row = by.get(opp.champion) || { opponent: opp.champion, icon: opp.championIcon || null, games: 0, wins: 0, as: new Set() };
      row.games += 1;
      row.wins += m.win ? 1 : 0;
      if (me.champion) row.as.add(me.champion);
      by.set(opp.champion, row);
    }
    return [...by.values()]
      .map((r) => ({ opponent: r.opponent, icon: r.icon, games: r.games, wins: r.wins, winRate: Math.round((r.wins / r.games) * 100), as: [...r.as] }))
      .sort((a, b) => b.games - a.games || a.winRate - b.winRate);
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

  // ── Game modes ─────────────────────────────────────────────────────────────
  // One table for every place that names a queue: the Live view, saved games,
  // today's session, Discord. Queue ids from Riot's queues.json, game modes as
  // the client reports them (gameData.queue.gameMode).
  const QUEUE_NAMES = {
    0: "Custom",
    400: "Normal Draft",
    420: "Ranked Solo/Duo",
    430: "Normal Blind",
    440: "Ranked Flex",
    450: "ARAM",
    480: "Swiftplay",
    490: "Quickplay",
    600: "Blood Hunt",
    700: "Clash",
    720: "ARAM Clash",
    76: "URF",
    830: "Co-op vs AI",
    840: "Co-op vs AI",
    850: "Co-op vs AI",
    870: "Co-op vs AI",
    880: "Co-op vs AI",
    890: "Co-op vs AI",
    900: "ARURF",
    1010: "Snow ARURF",
    1020: "One for All",
    1090: "Teamfight Tactics",
    1300: "Nexus Blitz",
    1400: "Ultimate Spellbook",
    1700: "Arena",
    1710: "Arena",
    1810: "Swarm",
    1820: "Swarm",
    1830: "Swarm",
    1840: "Swarm",
    1900: "URF",
    2000: "Tutorial",
    2010: "Tutorial",
    2020: "Tutorial",
    2300: "Brawl",
    2400: "ARAM Mayhem",
    3100: "Custom",
  };

  const GAME_MODE_NAMES = {
    CLASSIC: "Summoner's Rift",
    ARAM: "ARAM",
    KIWI: "ARAM Mayhem",
    CHERRY: "Arena",
    URF: "URF",
    ARURF: "ARURF",
    ONEFORALL: "One for All",
    NEXUSBLITZ: "Nexus Blitz",
    ULTBOOK: "Ultimate Spellbook",
    STRAWBERRY: "Swarm",
    BRAWL: "Brawl",
    SWIFTPLAY: "Swiftplay",
    PRACTICETOOL: "Practice Tool",
    TUTORIAL: "Tutorial",
    TUTORIAL_MODULE_1: "Tutorial",
    TUTORIAL_MODULE_2: "Tutorial",
    TUTORIAL_MODULE_3: "Tutorial",
    DOOMBOTSTEEMO: "Doom Bots",
    ODYSSEY: "Odyssey",
    NEXUSBLITZ_2: "Nexus Blitz",
    TFT: "Teamfight Tactics",
  };

  // "Ranked Solo/Duo" for a queue id; the game mode's name or, for a queue
  // the table does not know yet, "Other".
  function queueName(queueId, gameMode) {
    const id = Number(queueId);
    if (Number.isInteger(id) && QUEUE_NAMES[id]) return QUEUE_NAMES[id];
    return gameModeName(gameMode) || "Other";
  }

  // The name of a client game mode; unknown modes are shown readable
  // ("NEW_MODE" -> "New Mode") rather than hidden.
  function gameModeName(gameMode) {
    const key = String(gameMode || "").toUpperCase();
    if (!key) return "";
    if (GAME_MODE_NAMES[key]) return GAME_MODE_NAMES[key];
    return key.toLowerCase().split(/[_\s]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
  }

  // Which OP.GG builds fit a game mode: 'ranked' on Summoner's Rift, 'aram'
  // for ARAM and ARAM Mayhem (same map and items), null where OP.GG has none.
  function buildModeFor(gameMode) {
    const key = String(gameMode || "").toUpperCase();
    if (!key || key === "CLASSIC" || key === "SWIFTPLAY" || key === "PRACTICETOOL") return "ranked";
    if (key === "ARAM" || key === "KIWI") return "aram";
    return null;
  }

  const api = {
    escapeHtml,
    QUEUE_NAMES,
    queueName,
    gameModeName,
    buildModeFor,
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
    championStats,
    matchupStats,
    weeklySummary,
    rankChart,
    scoreLabel,
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
