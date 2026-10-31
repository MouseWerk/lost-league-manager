// --- State ---
let isEditing = false;
let currentView = "accountsView";
let previousView = "accountsView";
let champListCache = null; // loaded once, reused
let isLaunching = false;
let lastLaunchedUsername = null;
// Bumped on every launchAccount() call and on cancel — lets a stale in-flight
// launch promise recognize it's been superseded (by Cancel, or by launching a
// different account) and skip applying its result.
let _launchToken = 0;
let allAccounts = [];
let activeAccountUsername = null;
let currentQuery = "";
let currentSort = "default";
// username → { stats, key, at } (makeStatsEntry in ui-lib.js). An entry is
// only used while its key still matches the account's region|Riot ID, and it
// is fetched again after STATS_TTL_MS. Errors are never stored here.
const statsCache = {};
// username → { key, at, stats } of the last failed lookup: shown on the card
// and not retried for STATS_RETRY_MS, so a re-render (rank resort, search)
// does not turn one failure into a request loop.
const statsFailures = {};
const STATS_RETRY_MS = 60 * 1000;
const statsInFlight = new Map(); // username → key of the request in flight
// Error text → when it was last shown, so the same failure toasts once per
// STATS_ERROR_TOAST_GAP_MS instead of on every render.
const shownStatErrors = new Map();
const STATS_ERROR_TOAST_GAP_MS = 10 * 60 * 1000;
// Riot API development keys allow 20 requests per second; each card costs
// several, so card lookups start this far apart.
const STATS_STAGGER_MS = 150;

// Small "OP" monogram badge standing in for the OP.GG logo on the opgg-btn —
// not their actual mark (avoids hotlinking/trademark-asset copying), but
// reads as a distinct brand badge rather than a generic external-link arrow.
// currentColor so it inherits .icon-btn's color/hover transitions like the
// FontAwesome glyphs next to it.
const OPGG_ICON_SVG = `<svg viewBox="0 0 16 16" width="1em" height="1em" aria-hidden="true">
    <rect x="0.75" y="3" width="14.5" height="10" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.3"/>
    <text x="8" y="10.4" text-anchor="middle" font-size="6.4" font-weight="800" font-family="Arial, Helvetica, sans-serif" fill="currentColor">OP</text>
</svg>`;

// Shown once per version, on the first launch after an update — see the
// "Got it"/X handlers in DOMContentLoaded, which stamp
// config.lastSeenPatchNotesVersion so it doesn't show again for this version.
// Keyed by exact package.json version string; a version with no entry here
// (or one the user has already seen) shows nothing.
const PATCH_NOTES = {
  "1.9.0": [
    {
      icon: "fas fa-chart-line",
      title: "Overview",
      body: "A new page with the week of all your accounts: games, win rate, LP, a 30-day rank chart and each account's goal and warnings.",
    },
    {
      icon: "fas fa-list",
      title: "Games and champions",
      body: "Click a game in the account panel to see both teams, items, CS and damage, plus a table of your champions with win rate and KDA.",
    },
    {
      icon: "fas fa-hourglass-half",
      title: "Decay and restriction warnings",
      body: "Accounts warn before ranked decay, show a ranked restriction with the games left, and mark accounts you have not played for a while.",
    },
    {
      icon: "fas fa-tag",
      title: "Tags",
      body: "Tag accounts as Main, Duo, Smurf or anything else in Edit, then filter the list by tag.",
    },
    {
      icon: "fas fa-book-open",
      title: "Runes and items in champion select",
      body: "The Live view shows the OP.GG runes and items for your champion and imports them into the client with one click, or automatically when you lock in.",
    },
    {
      icon: "fas fa-window-maximize",
      title: "In-game overlay (beta)",
      body: "Switch it on in Settings > Game overlay: your score, both teams with ranks and tags on the loading screen and on Tab, game stats, objective timers and your OP.GG build over the game.",
    },
    {
      icon: "fas fa-up-right-and-down-left-from-center",
      title: "Roomy layout",
      body: "Prefer the larger buttons of 1.7? Choose Roomy in Settings > Appearance.",
    },
  ],
  "1.8.0": [
    {
      icon: "fas fa-palette",
      title: "A new look",
      body: "Lost League Manager has a calmer, clearer design with new type and colors from the logo.",
    },
    {
      icon: "fas fa-circle-half-stroke",
      title: "Light and dark",
      body: "Choose Light, Dark or System in Settings > Appearance. System follows Windows.",
    },
    {
      icon: "fas fa-users",
      title: "Lobby check",
      body: "The Live view shows the ranks of your party, your champion select and, once the game starts, all ten players, with one click to OP.GG multi-search.",
    },
    {
      icon: "fas fa-bullseye",
      title: "Today and your goal",
      body: "Each account shows the LP and games of today. Set a goal rank in Edit and watch the progress beside the account.",
    },
    {
      icon: "fas fa-medal",
      title: "Ranked emblems",
      body: "Ranks show the emblems from the League client, in the account list, the account panel and the Live view.",
    },
    {
      icon: "fas fa-calculator",
      title: "More exact stat viewer",
      body: "Attack speed per level uses each champion's real ratio, and item gold value now counts ability haste, lethality, penetration and more.",
    },
    {
      icon: "fas fa-table-list",
      title: "Your accounts at a glance",
      body: "Accounts are a list now. Pick one to see its rank, recent games and notes beside it, and play it from there. Filter by server with one click.",
    },
    {
      icon: "fas fa-sliders",
      title: "Easier settings",
      body: "Settings are grouped into sections you can jump to, and Discord, the website and What's new live under About.",
    },
  ],
  "1.7.0": [
    {
      icon: "fas fa-bolt",
      title: "Quick add",
      body: "Paste a Riot ID or OP.GG link when adding an account. Rank, icon, region and label fill in automatically, or import straight from the running League client.",
    },
    {
      icon: "fas fa-key",
      title: "No Riot API key needed",
      body: "Ranked stats and match history now come from OP.GG when you have no key (or it expired). Accounts signed into the client get their Riot ID linked automatically.",
    },
    {
      icon: "fas fa-right-to-bracket",
      title: "Safer launching",
      body: "One launch at a time, Cancel works in every step, and the app checks which account actually signed in. Passwords with umlauts work.",
    },
    {
      icon: "fas fa-lock",
      title: "Stronger vault and backups",
      body: "Your Riot API key is stored encrypted by Windows, the vault blocks the tray and shortcuts while locked, and backups are protected with a password you choose.",
    },
    {
      icon: "fas fa-gauge-high",
      title: "Faster and steadier",
      body: "The window opens without waiting on downloads, the Live view follows the game phase, ranks refresh, and sort by rank, drag-and-drop and the Stat Viewer slider work as they should.",
    },
  ],
  "1.6.0": [
    {
      icon: "fas fa-layer-group",
      title: "Tooltips never get clipped",
      body: "Tooltips now always render on top, even for cards at the edge of a scrolling list — they used to get sliced off by the list's own edge.",
    },
    {
      icon: "fas fa-arrow-up-right-from-square",
      title: "OP.GG button on every account",
      body: "One click opens that account's OP.GG page.",
    },
    {
      icon: "fas fa-chart-line",
      title: "Match history glance",
      body: "The profile view now shows your last 5 games as a quick win/loss strip.",
    },
    {
      icon: "fas fa-star",
      title: "Mastery badges",
      body: "Account cards now show your top 3 mastery champions at a glance.",
    },
  ],
};

// Region values stored on accounts (lowercase) → display label. Shared by the
// account form's region select and the quick-add lookup.
const REGIONS = [
  ["euw", "EUW"],
  ["eune", "EUNE"],
  ["na", "NA"],
  ["kr", "KR"],
  ["jp", "JP"],
  ["br", "BR"],
  ["lan", "LAN"],
  ["las", "LAS"],
  ["oce", "OCE"],
  ["tr", "TR"],
  ["ru", "RU"],
  ["me", "ME"],
  ["vn", "VN"],
  ["tw", "TW"],
  ["sg", "SG"],
  ["ph", "PH"],
  ["th", "TH"],
  ["sea", "SEA (legacy)"],
  ["cn", "CN"],
];

let lcuConnected = false;

// Pure helpers (escaping, rank order, cache freshness, ...) live in
// js/ui-lib.js so the unit tests can load them; index.html loads it first.
const {
  escapeHtml,
  TIER_ORDER,
  rankScore,
  reorderList,
  statsKey,
  shouldCacheStats,
  makeStatsEntry,
  statsEntryState,
  growStat,
  attackSpeedAt,
  sparklinePoints,
  dailySummary,
  goalProgress,
  parseTags,
  tagCounts,
  hasTag,
  statusWarnings,
  championStats,
  matchupStats,
  weeklySummary,
  rankChart,
  scoreLabel,
  ladderScore,
  lobbyMemberLabel,
  normalizeLoginStatus,
  needsLaunchAttention,
  MIN_PASSPHRASE_LENGTH,
  validateNewPassphrase,
  secondsUntil,
} = window.UiLib;

// Cached stats for an account, fresh or stale, or null when there is nothing
// usable (never fetched, or the Riot ID/region changed since).
function getCachedStats(acc) {
  if (!acc) return null;
  const entry = statsCache[acc.username];
  return statsEntryState(entry, acc, Date.now()) === "missing"
    ? null
    : entry.stats;
}

function cacheStats(acc, stats) {
  if (shouldCacheStats(stats)) {
    statsCache[acc.username] = makeStatsEntry(stats, acc, Date.now());
    delete statsFailures[acc.username];
  } else if (stats) {
    statsFailures[acc.username] = { key: statsKey(acc), at: Date.now(), stats };
  }
}

// Drops cache entries of deleted accounts and of accounts whose Riot ID or
// region changed (edit, LCU auto-link, import), so a card never shows the
// previous summoner's rank.
function pruneStatsCache() {
  const byName = new Map(allAccounts.map((a) => [a.username, a]));
  for (const store of [statsCache, statsFailures]) {
    for (const username of Object.keys(store)) {
      const acc = byName.get(username);
      if (!acc || store[username].key !== statsKey(acc)) delete store[username];
    }
  }
}

function recentStatsFailure(acc) {
  const f = statsFailures[acc.username];
  if (!f || f.key !== statsKey(acc)) return null;
  const age = Date.now() - f.at;
  return age >= 0 && age < STATS_RETRY_MS ? f : null;
}

function toastStatError(message) {
  const last = shownStatErrors.get(message);
  if (last && Date.now() - last < STATS_ERROR_TOAST_GAP_MS) return;
  shownStatErrors.set(message, Date.now());
  showToast(message, "error");
}

function findAccountCard(username) {
  for (const card of document.querySelectorAll("#accountsList .account-card")) {
    if (card.dataset.username === username) return card;
  }
  return null;
}

// Asks the main process for one account's stats unless a request for the
// same region|Riot ID is already running. The result is cached even when the
// list was re-rendered in the meantime, and applied to whichever card shows
// that account now.
function requestCardStats(acc, delay) {
  const username = acc.username;
  const key = statsKey(acc);
  if (statsInFlight.get(username) === key) return;
  statsInFlight.set(username, key);
  const done = () => {
    if (statsInFlight.get(username) === key) statsInFlight.delete(username);
  };
  const current = () => {
    const a = allAccounts.find((x) => x.username === username);
    return a && statsKey(a) === key ? a : null;
  };
  setTimeout(() => {
    const target = current();
    if (!target) return done(); // deleted or edited while waiting
    window.electronAPI
      .getStats(target.region, target.riotId)
      .then((stats) => {
        done();
        const acc2 = current();
        if (!acc2 || !stats) return;
        if (stats.error) toastStatError(stats.error);
        cacheStats(acc2, stats);
        const card = findAccountCard(username);
        if (card) applyStatsToCard(card, stats);
        if (currentSort === "rank") scheduleRankResort();
      })
      .catch((err) => {
        done();
        console.error("[Stats]", username, err);
      });
  }, delay);
}

// Images that fail to load fall back to the logo or hide themselves, per their
// data-fallback attribute. Inline onerror handlers are blocked by the CSP.
document.addEventListener(
  "error",
  (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.dataset.fallback) return;
    if (img.dataset.fallback === "hide") img.style.display = "none";
    else if (!img.src.endsWith("assets/logo.png")) img.src = "assets/logo.png";
  },
  true,
);

// Only allow http(s) URLs (or the app's own bundled assets) for a custom
// avatar — blocks javascript:/data:/file: schemes that a crafted or imported
// account record could otherwise use as an XSS/local-file-probing vector.
function safeAvatarUrl(url) {
  if (!url) return null;
  if (url.startsWith("assets/")) return url;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? url
      : null;
  } catch {
    return null;
  }
}

function timeAgo(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function getFilteredSorted() {
  let list = [...allAccounts];
  if (currentRegion) {
    list = list.filter((a) => (a.region || "").toLowerCase() === currentRegion);
  }
  if (currentTag) list = list.filter((a) => hasTag(a, currentTag));
  if (currentQuery) {
    const q = currentQuery.toLowerCase();
    list = list.filter(
      (a) =>
        (a.label || "").toLowerCase().includes(q) ||
        a.username.toLowerCase().includes(q) ||
        (a.riotId || "").toLowerCase().includes(q) ||
        (a.region || "").toLowerCase().includes(q) ||
        (a.tags || "").toLowerCase().includes(q),
    );
  }
  switch (currentSort) {
    case "favourite":
      list.sort((a, b) => (b.isFavourite ? 1 : 0) - (a.isFavourite ? 1 : 0));
      break;
    case "name":
      list.sort((a, b) =>
        (a.label || a.username).localeCompare(b.label || b.username),
      );
      break;
    case "region":
      list.sort((a, b) => (a.region || "").localeCompare(b.region || ""));
      break;
    case "lastUsed":
      list.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
      break;
    case "lastPlayed":
      list.sort((a, b) => (b.status?.lastPlayed || 0) - (a.status?.lastPlayed || 0));
      break;
    case "rank":
      // Tier, then division, then LP (rankScore in ui-lib.js); stable sort
      // keeps the saved order for equal ranks.
      list.sort(
        (a, b) =>
          rankScore(getCachedStats(b)) - rankScore(getCachedStats(a)),
      );
      break;
  }
  return list;
}

// Vault state from the main process; config.vaultEnabled is the fallback if
// the call fails.
async function readVaultState(config) {
  try {
    const s = await window.electronAPI.getVaultState();
    if (s && typeof s.enabled === "boolean") return s;
  } catch {
    /* fall back to the config flag */
  }
  return { enabled: !!config.vaultEnabled, unlocked: false };
}

// Text for a failed vault password check (unlock, change, turn off).
function vaultErrorText(res, fallback = "Incorrect password") {
  if (res?.retryAfterMs > 0) {
    return `Too many attempts. Try again in ${secondsUntil(res.retryAfterMs)} s.`;
  }
  return res?.message || fallback;
}

async function initVault(config) {
  const api = window.electronAPI;
  const vault = await readVaultState(config);
  if (!vault.enabled || vault.unlocked) return;

  return new Promise((resolve) => {
    const lockEl = document.getElementById("vaultLock");
    const input = document.getElementById("vaultPasswordInput");
    const btn = document.getElementById("vaultUnlockBtn");
    const errorEl = document.getElementById("vaultError");
    openLayer(lockEl, {
      show: (el) => (el.style.display = "flex"),
      focus: input,
    });

    function showError(text) {
      errorEl.textContent = text;
      errorEl.style.display = "block";
    }

    // The main process limits attempts; while it asks us to wait, the
    // input is disabled and the remaining time counts down.
    let lockoutTimer = null;
    function lockOut(ms) {
      const until = Date.now() + ms;
      input.disabled = true;
      btn.disabled = true;
      const tick = () => {
        const left = until - Date.now();
        if (left <= 0) {
          clearInterval(lockoutTimer);
          lockoutTimer = null;
          input.disabled = false;
          btn.disabled = false;
          errorEl.style.display = "none";
          input.focus();
          return;
        }
        showError(`Too many attempts. Try again in ${secondsUntil(left)} s.`);
      };
      clearInterval(lockoutTimer);
      tick();
      lockoutTimer = setInterval(tick, 250);
    }

    let busy = false;
    async function tryUnlock() {
      // The password goes to the main process exactly as typed (no trimming,
      // no hashing here): main checks it against its salted scrypt hash.
      if (busy || input.disabled || !input.value) return;
      busy = true;
      btn.disabled = true;
      let result;
      try {
        result = await api.unlockVault(input.value);
      } catch {
        result = { success: false, message: "Could not check the password. Try again." };
      }
      busy = false;
      btn.disabled = false;
      if (result?.success) {
        input.value = "";
        lockEl.classList.add("vault-unlocking");
        setTimeout(() => {
          closeLayer(lockEl, { hide: (el) => (el.style.display = "none") });
          resolve();
        }, 220);
        return;
      }
      input.value = "";
      if (result?.retryAfterMs > 0) {
        lockOut(result.retryAfterMs);
        return;
      }
      showError(vaultErrorText(result));
      const c = lockEl.querySelector(".vault-lock-content");
      c.classList.add("shake");
      setTimeout(() => {
        c.classList.remove("shake");
        input.focus();
      }, 500);
    }

    // Properties, not listeners: the lock can be shown again (lockAgain).
    btn.onclick = tryUnlock;
    input.onkeydown = (e) => {
      if (e.key === "Enter") tryUnlock();
    };
  });
}

// The main process answered "locked" (e.g. a tray launch while locked):
// show the lock screen again and reload the accounts once unlocked.
let _relocking = false;
async function lockAgain() {
  if (_relocking) return;
  _relocking = true;
  try {
    await initVault({ vaultEnabled: true });
    await loadAccounts();
  } finally {
    _relocking = false;
  }
}

// ── Vault settings ────────────────────────────────────────────────────────
// Passwords go to the main process as typed; it hashes and stores them.
// Turning the vault on asks for the new password twice, turning it off or
// changing the password asks for the current one first.
async function initVaultSettings(config) {
  const api = window.electronAPI;
  const toggle = document.getElementById("vaultEnabledToggle");
  const section = document.getElementById("vaultPasswordSection");
  if (!toggle) return;
  let enabled = (await readVaultState(config)).enabled;

  const render = () => {
    toggle.checked = enabled;
    section.style.display = enabled ? "block" : "none";
  };
  render();

  const newPasswordError = (next, confirm) => {
    if (!next) return "Enter a password";
    if (next !== confirm) return "The two entries do not match";
    return null;
  };

  toggle.addEventListener("change", async () => {
    render(); // the switch follows the saved state, not the click
    if (!enabled) {
      const done = await showFormDialog({
        title: "Turn on the vault",
        message:
          "Choose a password. The app asks for it every time it opens.",
        fields: [
          { name: "next", label: "Password", autocomplete: "new-password" },
          { name: "confirm", label: "Repeat password", autocomplete: "new-password" },
        ],
        confirmLabel: "Turn on",
        onSubmit: async (v) => {
          const err = newPasswordError(v.next, v.confirm);
          if (err) return err;
          const res = await api.setVaultPassword({ current: "", next: v.next });
          return res?.success ? null : vaultErrorText(res, "Could not set the password");
        },
      });
      if (done) {
        enabled = true;
        showToast("Vault turned on", "success");
      }
    } else {
      const done = await showFormDialog({
        title: "Turn off the vault",
        message: "Enter the current vault password to turn the lock off.",
        fields: [
          { name: "current", label: "Current password", autocomplete: "current-password" },
        ],
        confirmLabel: "Turn off",
        danger: true,
        onSubmit: async (v) => {
          if (!v.current) return "Enter the current password";
          const res = await api.disableVault(v.current);
          return res?.success ? null : vaultErrorText(res);
        },
      });
      if (done) {
        enabled = false;
        showToast("Vault turned off", "info");
      }
    }
    // Trust main, not the dialog result: a dialog replaced while its submit
    // was in flight resolves null even though main already applied it.
    enabled = (await readVaultState(config)).enabled;
    render();
  });

  document
    .getElementById("changeVaultPasswordBtn")
    ?.addEventListener("click", async () => {
      const done = await showFormDialog({
        title: "Change vault password",
        fields: [
          { name: "current", label: "Current password", autocomplete: "current-password" },
          { name: "next", label: "New password", autocomplete: "new-password" },
          { name: "confirm", label: "Repeat new password", autocomplete: "new-password" },
        ],
        confirmLabel: "Change password",
        onSubmit: async (v) => {
          if (!v.current) return "Enter the current password";
          const err = newPasswordError(v.next, v.confirm);
          if (err) return err;
          const res = await api.setVaultPassword({ current: v.current, next: v.next });
          return res?.success ? null : vaultErrorText(res);
        },
      });
      if (done) showToast("Vault password changed", "success");
    });
}

// ── Theme (Settings > Appearance) ───────────────────────────────────────
// The main process applies it through nativeTheme, which every window's
// prefers-color-scheme follows, so the page needs no class of its own.
function initThemeSettings(config) {
  const radios = document.querySelectorAll('input[name="theme"]');
  let current = ["system", "light", "dark"].includes(config.theme) ? config.theme : "system";
  const render = () => radios.forEach((r) => (r.checked = r.value === current));
  render();
  radios.forEach((r) =>
    r.addEventListener("change", async () => {
      if (!r.checked) return;
      const previous = current;
      current = r.value;
      const res = await window.electronAPI.setConfig({ theme: current });
      if (res && res.success === false) {
        current = previous;
        render();
        showToast(res.message || "Could not change the theme", "error");
      }
    }),
  );
}

// Section links on the left of Settings: scroll to the section and mark the
// one in view.
function initSettingsNav() {
  const content = document.getElementById("settingsContent");
  const links = [...document.querySelectorAll(".settings-nav-link")];
  if (!content || !links.length) return;
  const mark = (id) =>
    links.forEach((l) => {
      const on = l.getAttribute("href") === `#${id}`;
      l.classList.toggle("active", on);
      if (on) l.setAttribute("aria-current", "true");
      else l.removeAttribute("aria-current");
    });
  links.forEach((l) =>
    l.addEventListener("click", (e) => {
      e.preventDefault();
      const target = document.querySelector(l.getAttribute("href"));
      if (!target) return;
      content.scrollTo({ top: target.offsetTop - content.offsetTop, behavior: "smooth" });
      mark(target.id);
    }),
  );
  content.addEventListener("scroll", () => {
    const top = content.scrollTop + content.offsetTop + 40;
    let currentId = links[0].getAttribute("href").slice(1);
    for (const l of links) {
      const sec = document.querySelector(l.getAttribute("href"));
      if (sec && sec.offsetTop <= top) currentId = sec.id;
    }
    // At the very end the last section may be too short to reach the top.
    if (content.scrollTop + content.clientHeight >= content.scrollHeight - 2) {
      currentId = links[links.length - 1].getAttribute("href").slice(1);
    }
    mark(currentId);
  });
}

// ── Riot API key ──────────────────────────────────────────────────────────
// The key is stored encrypted by the main process and never comes back to
// the renderer: the card only knows whether one is saved.
function initRiotApiKeySettings(config) {
  const api = window.electronAPI;
  const input = document.getElementById("riotApiKeyInput");
  const editRow = document.getElementById("riotApiKeyEditRow");
  const savedRow = document.getElementById("riotApiKeySavedRow");
  const saveBtn = document.getElementById("saveRiotApiKeyBtn");
  const cancelBtn = document.getElementById("cancelRiotApiKeyBtn");
  if (!input || !editRow || !savedRow) return;
  // The key itself never reaches the renderer, only whether one is saved.
  let keySet = !!config.riotApiKeySet;

  const render = (editing = false) => {
    input.value = "";
    savedRow.style.display = keySet && !editing ? "" : "none";
    editRow.style.display = !keySet || editing ? "" : "none";
    cancelBtn.style.display = keySet && editing ? "" : "none";
  };
  render();

  const store = async (key) => {
    try {
      return await api.setRiotApiKey(key);
    } catch (err) {
      return { success: false, message: err.message };
    }
  };

  const save = async () => {
    const key = input.value.trim();
    if (!key) {
      showToast("Paste a Riot API key first", "error");
      input.focus();
      return;
    }
    saveBtn.disabled = true;
    const res = await store(key);
    saveBtn.disabled = false;
    if (!res?.success) {
      showToast(res?.message || "Could not save the API key", "error");
      return;
    }
    keySet = true;
    render();
    showToast("API key saved", "success");
    document.getElementById("replaceRiotApiKeyBtn")?.focus();
  };

  saveBtn.addEventListener("click", save);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") save();
  });
  cancelBtn.addEventListener("click", () => {
    render();
    document.getElementById("replaceRiotApiKeyBtn")?.focus();
  });
  document.getElementById("replaceRiotApiKeyBtn").addEventListener("click", () => {
    render(true);
    input.focus();
  });
  document.getElementById("clearRiotApiKeyBtn").addEventListener("click", async () => {
    const res = await store("");
    if (!res?.success) {
      showToast(res?.message || "Could not clear the API key", "error");
      return;
    }
    keySet = false;
    render();
    showToast("API key cleared", "info");
    input.focus();
  });
}

// ── Backup (export / import) ──────────────────────────────────────────────
function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// Export asks for a passphrase twice (at least MIN_PASSPHRASE_LENGTH
// characters, never trimmed); the main process encrypts the file with it.
async function exportAccountsFlow(btn, usernames = null) {
  const values = await showFormDialog({
    title: "Export accounts",
    message:
      "The backup contains your account passwords. Choose a passphrase to encrypt it; you need it again to import the file.",
    fields: [
      { name: "passphrase", label: "Passphrase", autocomplete: "new-password" },
      { name: "confirm", label: "Repeat passphrase", autocomplete: "new-password" },
    ],
    confirmLabel: "Export",
    onSubmit: (v) => validateNewPassphrase(v.passphrase, v.confirm, MIN_PASSPHRASE_LENGTH),
  });
  if (!values) return;
  btn.disabled = true;
  let res;
  try {
    res = await window.electronAPI.exportAccounts(values.passphrase, usernames);
  } catch (err) {
    res = { success: false, message: err.message };
  } finally {
    btn.disabled = false;
  }
  if (res?.canceled) return;
  if (res?.success) {
    const unreadable =
      res.unreadable > 0
        ? ` ${plural(res.unreadable, "password")} could not be read and were left empty.`
        : "";
    showToast(`${plural(res.count ?? 0, "account")} exported.${unreadable}`, "success");
  } else {
    showToast("Export failed: " + (res?.message || "unknown error"), "error");
  }
}

// Import opens the file dialog in the main process. A protected backup
// answers needsPassphrase; the file stays pending there while the
// passphrase dialog asks (and asks again after a wrong one).
async function importAccountsFlow(btn) {
  const api = window.electronAPI;
  btn.disabled = true;
  try {
    let res = await api.importAccounts();
    if (res?.needsPassphrase) {
      let finalRes = null;
      const values = await showFormDialog({
        title: "Import accounts",
        message:
          "This backup is protected. Enter the passphrase that was used to export it.",
        fields: [{ name: "passphrase", label: "Passphrase", autocomplete: "off" }],
        confirmLabel: "Import",
        onSubmit: async (v) => {
          if (!v.passphrase) return "Enter the passphrase";
          const r = await api.importAccounts({ passphrase: v.passphrase });
          if (r?.wrongPassphrase || r?.needsPassphrase) {
            return "Wrong passphrase. Check it and try again.";
          }
          finalRes = r;
          return null;
        },
      });
      if (!values) return;
      res = finalRes;
    }
    if (res?.canceled) return;
    if (res?.success) {
      const added = res.added || 0;
      const skipped = res.skipped || 0;
      // Why entries were skipped, when the main process says so.
      const reasons = [
        res.duplicates ? `${res.duplicates} already in the list` : "",
        res.invalid ? `${res.invalid} invalid` : "",
      ].filter(Boolean);
      const skippedText = reasons.length
        ? `skipped: ${reasons.join(", ")}`
        : `${skipped} skipped`;
      // Accounts without a password in the backup are imported; the user
      // enters it with Edit before launching them.
      const noPw = res.withoutPassword
        ? ` ${plural(res.withoutPassword, "account")} without a saved password: add it with Edit.`
        : "";
      const msg =
        added > 0
          ? `${plural(added, "account")} imported${skipped ? `, ${skippedText}` : ""}.${noPw}`
          : skipped
            ? `No new accounts (${skippedText}).`
            : "The backup contains no accounts.";
      showToast(msg, added > 0 ? "success" : "info");
      if (added > 0) loadAccounts();
    } else {
      showToast("Import failed: " + (res?.message || "unknown error"), "error");
    }
  } catch (err) {
    showToast("Import failed: " + err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

// ── Tooltips ──────────────────────────────────────────────────────────────
// [data-tooltip] used to be a pure-CSS ::after/::before pseudo-element anchored
// to the hovered element. That reads great in isolation, but it's still a normal
// descendant box of whatever container it lives in — so a card near the top of
// .accounts-grid (which scrolls via overflow-y: auto) gets its tooltip sliced
// off by the grid's own edge, no matter how high the z-index is set. z-index
// only wins stacking fights; it can't escape an ancestor's overflow clip.
// Rendering a single tooltip element directly on <body> with position: fixed,
// positioned via getBoundingClientRect() at show-time, sidesteps that entirely.
let _tooltipEl = null;
let _tooltipShowTimer = null;
let _tooltipTarget = null;

function hideTooltip() {
  _tooltipTarget = null;
  clearTimeout(_tooltipShowTimer);
  _tooltipEl?.classList.remove("is-visible");
}

function placeTooltip(target) {
  const tip = _tooltipEl;
  const pos = target.getAttribute("data-tooltip-pos") || "top";
  tip.textContent = target.getAttribute("data-tooltip") || "";
  tip.dataset.pos = pos;
  tip.classList.add("is-visible");

  const rect = target.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  const gap = 9;
  const margin = 6;
  let top, left;

  if (pos === "left") {
    left = rect.left - tipRect.width - gap;
    top = rect.top + rect.height / 2 - tipRect.height / 2;
  } else if (pos === "right") {
    left = rect.right + gap;
    top = rect.top + rect.height / 2 - tipRect.height / 2;
  } else if (pos === "bottom") {
    left = rect.left + rect.width / 2 - tipRect.width / 2;
    top = rect.bottom + gap;
  } else {
    // top (default)
    left = rect.left + rect.width / 2 - tipRect.width / 2;
    top = rect.top - tipRect.height - gap;
  }

  const clampedLeft = Math.max(
    margin,
    Math.min(left, window.innerWidth - tipRect.width - margin),
  );
  const clampedTop = Math.max(
    margin,
    Math.min(top, window.innerHeight - tipRect.height - margin),
  );

  // Arrow stays pointed at the target's center even when the box itself got
  // clamped away from its "ideal" centered position near a viewport edge.
  if (pos === "left" || pos === "right") {
    const targetCenterY = rect.top + rect.height / 2;
    const arrowTop = Math.max(
      10,
      Math.min(targetCenterY - clampedTop, tipRect.height - 10),
    );
    tip.style.setProperty("--tip-arrow-offset", `${arrowTop}px`);
  } else {
    const targetCenterX = rect.left + rect.width / 2;
    const arrowLeft = Math.max(
      10,
      Math.min(targetCenterX - clampedLeft, tipRect.width - 10),
    );
    tip.style.setProperty("--tip-arrow-offset", `${arrowLeft}px`);
  }

  tip.style.left = `${clampedLeft}px`;
  tip.style.top = `${clampedTop}px`;
}

function showTooltip(target) {
  _tooltipTarget = target;
  clearTimeout(_tooltipShowTimer);
  _tooltipShowTimer = setTimeout(() => {
    if (_tooltipTarget !== target || !document.body.contains(target)) return;
    placeTooltip(target);
  }, 250);
}

function initTooltips() {
  _tooltipEl = document.createElement("div");
  _tooltipEl.className = "js-tooltip";
  document.body.appendChild(_tooltipEl);

  document.addEventListener("mouseover", (e) => {
    const target = e.target.closest("[data-tooltip]");
    if (target && target !== _tooltipTarget) showTooltip(target);
  });
  document.addEventListener("mouseout", (e) => {
    const target = e.target.closest("[data-tooltip]");
    if (target && !target.contains(e.relatedTarget)) hideTooltip();
  });
  // A scroll or click can move/invalidate the anchor faster than the mouse
  // leaves it (e.g. scrolling the accounts grid while hovering a button).
  document.addEventListener("scroll", hideTooltip, true);
  document.addEventListener("mousedown", hideTooltip);
  window.addEventListener("resize", hideTooltip);
  window.addEventListener("blur", hideTooltip);
}

// ── Patch notes modal ───────────────────────────────────────────────────────
function showPatchNotesModal(version) {
  const items = PATCH_NOTES[version];
  if (!items || items.length === 0) return;

  document.getElementById("patchNotesVersion").textContent =
    `Version ${version}`;
  // items are hardcoded above; escaped anyway so the markup guard stays simple.
  document.getElementById("patchNotesList").innerHTML = items
    .map(
      (item) => `
        <li>
            <i class="${escapeHtml(item.icon)}"></i>
            <div>
                <div class="patch-notes-item-title">${escapeHtml(item.title)}</div>
                <div class="patch-notes-item-body">${escapeHtml(item.body)}</div>
            </div>
        </li>
    `,
    )
    .join("");
  openLayer(document.getElementById("patchNotesModal"), {
    onEscape: () => dismissPatchNotesModal(version),
    focus: "#patchNotesGotItBtn",
  });
}

function dismissPatchNotesModal(version) {
  closeLayer(document.getElementById("patchNotesModal"));
  window.electronAPI.setConfig({ lastSeenPatchNotesVersion: version });
}

document.addEventListener("DOMContentLoaded", async () => {
  initDragAndDrop();
  initRegionFilters();
  initTagFilters();
  initTagSuggestions();
  initGamesDialog();
  initOverview();
  initBulkActions();
  initSeasonReview();
  initChampBuild();
  initAccountDetail();
  initTooltips();

  // Launch events are registered before the first await: a cold start with
  // --launch= begins as soon as the page has loaded.
  // Account info sent when a launch begins (window, tray, jump list).
  window.electronAPI.onLaunchAccountInfo((info) => {
    document.getElementById("launchAccLabel").textContent = info.label;
    document.getElementById("launchAccMeta").textContent = [
      info.region,
      info.username,
    ]
      .filter(Boolean)
      .join(" · ");
    const icon = document.getElementById("launchAccIcon");
    const cached = getCachedStats(
      allAccounts.find((a) => a.username === info.username),
    );
    if (cached?.iconSrc) icon.src = cached.iconSrc;
    else icon.src = "assets/logo.png";
    _launchInfoUsername = info.username;
    isLaunching = true;
    resetLaunchOverlay();
  });
  window.electronAPI.onLoginStatus(handleLoginStatus);
  // Which account is signed into the client (null when none or unknown).
  window.electronAPI.onActiveAccountDetected((username) =>
    setActiveAccount(username || null),
  );

  // Version
  const version = await window.electronAPI.getVersion();
  const versionEl = document.getElementById("appVersion");
  if (versionEl) versionEl.textContent = version;

  try {
    // Load config
    const config = await window.electronAPI.getConfig();

    // Vault lock — must resolve before anything is shown
    await initVault(config);

    // First start: the setup dialog instead of What's new (a new user has
    // nothing to compare against), so this version's notes count as seen.
    const firstStart = await shouldShowOnboarding(config);
    if (firstStart) {
      window.electronAPI.setConfig({ lastSeenPatchNotesVersion: version });
      openOnboarding(config);
    }
    // Patch notes — after the vault lock so it never covers/precedes it.
    // Shows once per version: missing/mismatched lastSeenPatchNotesVersion
    // means this version hasn't been acknowledged yet on this machine.
    else if (PATCH_NOTES[version] && config.lastSeenPatchNotesVersion !== version) {
      showPatchNotesModal(version);
    }
    document
      .getElementById("closePatchNotesBtn")
      ?.addEventListener("click", () => dismissPatchNotesModal(version));
    document
      .getElementById("patchNotesGotItBtn")
      ?.addEventListener("click", () => dismissPatchNotesModal(version));
    document
      .getElementById("patchNotesDiscordBtn")
      ?.addEventListener("click", () => {
        window.electronAPI.openExternal("https://discord.gg/ZyfUMWTPFe");
      });

    if (config.lolPath) {
      const pathEl = document.getElementById("lolPathDisplay");
      if (pathEl) pathEl.innerText = config.lolPath;
    }

    // Initialize Auto-Accept Toggle (header)
    const autoAcceptToggle = document.getElementById("autoAcceptToggle");
    if (autoAcceptToggle) {
      autoAcceptToggle.checked = config.autoAccept || false;
      autoAcceptToggle.addEventListener("change", async (e) => {
        await window.electronAPI.setConfig({ autoAccept: e.target.checked });
        const s = document.getElementById("autoAcceptSettingsToggle");
        if (s) s.checked = e.target.checked;
      });
    }

    // Initialize all Settings toggles
    // defaultOn = true means the setting is ON unless explicitly set false
    function bindSettingToggle(id, configKey, defaultOn) {
      const el = document.getElementById(id);
      if (!el) return;
      el.checked = defaultOn
        ? config[configKey] !== false
        : !!config[configKey];
      el.addEventListener("change", async (e) => {
        const value = e.target.checked;
        const res = await window.electronAPI
          .setConfig({ [configKey]: value })
          .catch((err) => ({ success: false, message: err.message }));
        // A rejected change must not leave the switch showing it as applied.
        if (res && res.success === false) {
          el.checked = !value;
          showToast(res.message || "Could not save the setting", "error");
        }
      });
    }

    bindSettingToggle("overlayEnabledToggle", "overlayEnabled", false);
    bindSettingToggle("overlayShowRankedToggle", "overlayShowRanked", true);
    bindSettingToggle("overlayShowBuildsToggle", "overlayShowBuilds", true);
    bindSettingToggle(
      "minimizeOnGameStartToggle",
      "minimizeOnGameStart",
      false,
    );
    bindSettingToggle("startWithWindowsToggle", "startWithWindows", false);
    bindSettingToggle("startMinimizedToggle", "startMinimized", false);
    bindSettingToggle(
      "checkUpdatesOnStartupToggle",
      "checkUpdatesOnStartup",
      true,
    );
    bindSettingToggle("toastOnQueuePopToggle", "toastOnQueuePop", true);
    bindSettingToggle("autoImportBuildToggle", "autoImportBuild", false);
    bindSettingToggle("discordRpcEnabledToggle", "discordRpcEnabled", true);

    // UI Scale — only apply if non-default; let ow-electron manage native DPI at 1.0
    const savedScale = config.uiScale ?? 1.0;
    if (savedScale !== 1.0) applyUiScale(savedScale);
    document.querySelectorAll("#scaleBtns .scale-btn").forEach((btn) => {
      const s = parseFloat(btn.dataset.scale);
      btn.classList.toggle("active", s === savedScale);
      btn.setAttribute("aria-pressed", String(s === savedScale));
      btn.addEventListener("click", async () => {
        document.querySelectorAll("#scaleBtns .scale-btn").forEach((b) => {
          b.classList.toggle("active", b === btn);
          b.setAttribute("aria-pressed", String(b === btn));
        });
        applyUiScale(s);
        await window.electronAPI.setConfig({ uiScale: s });
      });
    });

    initThemeSettings(config);
    initDensitySettings(config);
    initSettingsNav();

    // Vault settings
    await initVaultSettings(config);

    // Auto-accept in settings synced with header toggle
    const autoAcceptSettings = document.getElementById(
      "autoAcceptSettingsToggle",
    );
    if (autoAcceptSettings) {
      autoAcceptSettings.checked = config.autoAccept || false;
      autoAcceptSettings.addEventListener("change", async (e) => {
        await window.electronAPI.setConfig({ autoAccept: e.target.checked });
        if (autoAcceptToggle) autoAcceptToggle.checked = e.target.checked;
      });
    }

    document
      .getElementById("resetOverlayPosBtn")
      ?.addEventListener("click", async () => {
        await window.electronAPI.resetOverlayPosition();
        showToast("Overlay position reset", "success");
      });

    // Riot API Key
    initRiotApiKeySettings(config);

    // Load accounts
    await loadAccounts();

    // The startup update check runs in the main process (one check, and a
    // failed background check is not toasted).

    // Auto-update event listeners
    window.electronAPI.onUpdateAvailable((data) => {
      showUpdateCard(data.version, "downloading");
    });

    window.electronAPI.onUpdateProgress((data) => {
      updateDownloadProgress(data.percent);
    });

    window.electronAPI.onUpdateDownloaded((data) => {
      showUpdateCard(data.version, "ready");
    });

    window.electronAPI.onUpdateError((message) => {
      // A manual check reports its own result; this event matters for a
      // download that was running.
      if (_updateState === "downloading") {
        showToast("Update failed: " + message, "error");
      } else {
        console.warn("[Update]", message);
      }
      // Reset everything, or the pill kept offering a download that died.
      document.getElementById("updateCard").classList.remove("active");
      document.getElementById("updatePill").classList.remove("active");
      _updateVersion = "";
      _updateState = "";
    });

    // Update card controls
    document.getElementById("closeUpdateCard").addEventListener("click", () => {
      document.getElementById("updateCard").classList.remove("active");
      if (_updateVersion)
        document.getElementById("updatePill").classList.add("active");
    });

    document.getElementById("laterUpdateBtn").addEventListener("click", () => {
      document.getElementById("updateCard").classList.remove("active");
      if (_updateVersion)
        document.getElementById("updatePill").classList.add("active");
    });

    document
      .getElementById("installUpdateBtn")
      .addEventListener("click", () => {
        // Show custom install screen, then silently install after it renders
        document.getElementById("installOverlayVersion").textContent =
          `v${_updateVersion}`;
        document.getElementById("updateCard").classList.remove("active");
        document.getElementById("updatePill").classList.remove("active");
        document.getElementById("installOverlay").classList.add("active");
        setTimeout(() => window.electronAPI.installUpdate(), 900);
      });

    const updatePill = document.getElementById("updatePill");
    const openUpdatePill = () => {
      updatePill.classList.remove("active");
      if (_updateVersion) showUpdateCard(_updateVersion, _updateState);
    };
    updatePill.addEventListener("click", openUpdatePill);
    updatePill.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openUpdatePill();
      }
    });
  } catch (err) {
    console.error("Initialization error:", err);
  }

  // LCU connect / disconnect
  window.electronAPI.onLcuConnected(() => {
    lcuConnected = true;
    document.getElementById("quickAddClientBtn").style.display = "";
    document.getElementById("lcuNavDot").classList.add("visible");
    loadLiveView();
  });
  window.electronAPI.onLcuDisconnected(() => {
    lcuConnected = false;
    document.getElementById("quickAddClientBtn").style.display = "none";
    document.getElementById("lcuNavDot").classList.remove("visible");
    setLcuOffline();
    setActiveAccount(null); // nobody is signed in without a client
  });
  window.electronAPI.onLcuGameflow(handleGameflowEvent);
  // Champion select changes (a player joins, swaps): refresh the lobby check.
  window.electronAPI.onChampSelectUpdate?.((session) => {
    const me = (session?.myTeam || []).find((m) => m.cellId === session?.localPlayerCellId);
    const champ = me?.championId || me?.championPickIntent || 0;
    const enemyKey = (session?.theirTeam || []).map((m) => m.championId || 0).join(",");
    if ((champ !== _buildChampion || enemyKey !== _enemyKey) && currentView === "liveView") {
      if (champ !== _buildChampion) _buildPosition = null;
      _buildChampion = champ;
      _enemyKey = enemyKey;
      clearTimeout(_buildTimer);
      _buildTimer = setTimeout(loadChampBuild, 600);
    }
    const key = (session?.myTeam || []).map((m) => `${m.cellId}:${m.puuid || ""}`).join(",");
    if (key !== _lobbyCheckTeamKey && currentView === "liveView") {
      _lobbyCheckTeamKey = key;
      clearTimeout(_lobbyCheckTimer);
      _lobbyCheckTimer = setTimeout(loadLobbyCheck, 1200);
    }
  });
  document.getElementById("ovPlayersOpgg").addEventListener("click", () => {
    const ids = _lobbyCheck?.players?.filter((p) => !p.hidden && p.tagLine).map((p) => `${p.gameName}#${p.tagLine}`) || [];
    window.electronAPI.openOpggMultisearch(_lobbyCheck?.region, ids).then((res) => {
      if (!res?.success) showToast("OP.GG has no page for this server.", "error");
    });
  });

  // Dodge / Accept buttons
  document.getElementById("ovDodgeBtn").addEventListener("click", async () => {
    const info = await window.electronAPI.getDodgeInfo().catch(() => ({}));
    let warningMsg = info.isRanked
      ? "Dodging ranked will cost LP (−3 first dodge, −10 second in 16 hours) and apply a queue cooldown."
      : "Dodging will apply a queue cooldown (5 min first, 30 min second in 16 hours).";
    if (info.hasActivePenalty && info.penaltyMinutesRemaining) {
      warningMsg += `\n\nNote: you already have an active dodge penalty (${info.penaltyMinutesRemaining} min remaining) — this will extend it.`;
    }
    const ok = await showConfirm("Dodge Queue?", warningMsg, "danger", "Dodge");
    if (!ok) return;
    // The game may have started while the confirmation was open.
    if (_lastGameflowPhase && _lastGameflowPhase !== "ChampSelect") {
      showToast("Champ select is over, nothing to dodge", "info");
      return;
    }
    const res = await window.electronAPI.dodgeQueue();
    if (res?.success) {
      showToast("Queue dodged", "info");
    } else {
      showToast(res?.message || "Failed to dodge queue", "error");
    }
  });
  document
    .getElementById("ovAcceptBtn")
    .addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const res = await window.electronAPI.acceptMatch();
        // The "Match accepted!" toast used to show unconditionally, even when
        // the LCU request failed (e.g. ready check already expired) — telling
        // the user it worked while League still dodged them.
        if (res.success) {
          showToast("Match accepted!", "success");
        } else {
          showToast(res.message || "Failed to accept match", "error");
        }
      } finally {
        btn.disabled = false;
      }
    });

  // Live view tab switching
  document.querySelectorAll(".ov-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document
        .querySelectorAll(".ov-tab")
        .forEach((t) => t.classList.remove("active"));
      document
        .querySelectorAll(".ov-panel")
        .forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(tab.dataset.tab).classList.add("active");
    });
  });

  // Listen for external account updates
  // The client is signed in with an account that is not saved: offer to add
  // it with the Riot ID and server filled in (only the password is missing).
  const dismissedUnknown = new Set();
  let unknownAccount = null;
  window.electronAPI.onUnknownAccount?.((info) => {
    if (!info?.username || dismissedUnknown.has(info.username.toLowerCase())) return;
    if (allAccounts.some((a) => a.username.toLowerCase() === info.username.toLowerCase())) return;
    unknownAccount = info;
    document.getElementById("unknownAccountText").textContent =
      `The League client is signed in as ${info.riotId}, which is not saved here. Add it?`;
    document.getElementById("unknownAccountBanner").hidden = false;
  });
  document.getElementById("unknownAccountDismiss").addEventListener("click", () => {
    if (unknownAccount) dismissedUnknown.add(unknownAccount.username.toLowerCase());
    unknownAccount = null;
    document.getElementById("unknownAccountBanner").hidden = true;
  });
  document.getElementById("unknownAccountAdd").addEventListener("click", () => {
    const info = unknownAccount;
    document.getElementById("unknownAccountBanner").hidden = true;
    if (!info) return;
    openModal(null);
    document.getElementById("newUsername").value = info.username;
    document.getElementById("newRiotId").value = info.riotId;
    if (info.region) document.getElementById("newRegion").value = info.region;
    if (!document.getElementById("newLabel").value) document.getElementById("newLabel").value = info.riotId.split("#")[0];
    document.getElementById("newPassword").focus();
    showToast("Enter the password of this account, then Save.", "info");
  });
  window.electronAPI.onRiotIdChanged?.((info) => {
    if (info?.oldId && info?.newId) showToast(`Riot ID changed: ${info.oldId} is now ${info.newId}`, "info");
  });

  window.electronAPI.onAccountsUpdated(async () => {
    await loadAccounts();
    if (unknownAccount && allAccounts.some((a) => a.username.toLowerCase() === unknownAccount.username.toLowerCase())) {
      unknownAccount = null;
      document.getElementById("unknownAccountBanner").hidden = true;
    }
    if (currentView === "overviewView") renderOverview();
  });

  // A data file became damaged or unreadable while the app ran; saving it
  // is paused in main so nothing is overwritten.
  window.electronAPI.onDataFileProblem((message) => {
    showToast(message, "error");
  });

  // Overwolf GEP events (fired while a LoL session is running)
  window.electronAPI.onGepGameEvent((data) => {
    console.log("[GEP] Game event:", data);
  });
  window.electronAPI.onGepInfoUpdate((data) => {
    console.log("[GEP] Info update:", data);
  });

  // Cancel Launch (reads "Close" while a failed launch is shown)
  document
    .getElementById("cancelLaunchBtn")
    .addEventListener("click", cancelOrCloseLaunch);

  // Retry Launch
  document.getElementById("retryLaunchBtn").addEventListener("click", () => {
    const username = _launchInfoUsername || lastLaunchedUsername;
    if (username) launchAccount(username);
  });

  document.getElementById("patchNotesBtn").addEventListener("click", (e) => {
    e.preventDefault();
    window.electronAPI.openPatchNotes();
  });

  document
    .getElementById("launchLeagueBtn")
    .addEventListener("click", async (e) => {
      const btn = e.target.closest("button");
      btn.disabled = true;
      const res = await window.electronAPI.launchLeagueClient();
      btn.disabled = false;
      if (!res.success)
        showToast(res.message || "Failed to launch League", "error");
    });

  // Tools
  document
    .getElementById("fixClientBtn")
    .addEventListener("click", async () => {
      const confirm = await showConfirm(
        "Emergency Fix",
        "This will close all League of Legends and Riot Games processes. Continue?",
        "danger",
        "Close processes",
      );
      if (confirm) {
        const res = await window.electronAPI.fixClient();
        if (res.success) showToast("Client processes killed!", "success");
      }
    });

  document
    .getElementById("repairClientBtn")
    .addEventListener("click", async (e) => {
      const btn = e.target;
      btn.disabled = true;
      const res = await window.electronAPI.repairClient();
      btn.disabled = false;
      if (res.success) {
        showToast(
          res.removed
            ? "Lockfile removed — client repaired!"
            : "No lockfile found (already clean)",
          res.removed ? "success" : "info",
        );
      } else {
        showToast("Repair failed: " + res.message, "error");
      }
    });

  document
    .getElementById("clearCacheBtn")
    .addEventListener("click", async (e) => {
      const ok = await showConfirm(
        "Clear Cache",
        "This will delete the Riot Client cache. The client will re-download it on next launch.",
        "info",
        "Clear cache",
      );
      if (!ok) return;
      const btn = e.target;
      btn.disabled = true;
      const res = await window.electronAPI.clearClientCache();
      btn.disabled = false;
      if (res.success) {
        showToast(
          res.cleared > 0 ? "Cache cleared!" : "Cache already empty",
          res.cleared > 0 ? "success" : "info",
        );
      } else {
        showToast("Failed: " + res.message, "error");
      }
    });

  document
    .getElementById("openDataFolderBtn")
    .addEventListener("click", async () => {
      await window.electronAPI.openDataFolder();
    });

  // Backup
  document
    .getElementById("exportAccountsBtn")
    .addEventListener("click", (e) =>
      exportAccountsFlow(e.target.closest("button")),
    );
  document
    .getElementById("importAccountsBtn")
    .addEventListener("click", (e) =>
      importAccountsFlow(e.target.closest("button")),
    );

  // Manual update check
  document
    .getElementById("manualUpdateBtn")
    .addEventListener("click", async (e) => {
      const btn = e.target;
      btn.innerText = "Checking...";
      btn.disabled = true;
      try {
        const update = await window.electronAPI.checkForUpdates();
        if (update && update.updateAvailable) {
          showToast(`v${update.latestVersion} found — downloading…`, "info");
        } else if (update && update.error) {
          showToast("Update check failed: " + update.error, "error");
        } else {
          showToast("You're on the latest version!", "success");
        }
      } catch (err) {
        showToast("Failed to check for updates.", "error");
      } finally {
        btn.innerText = "Check for Updates";
        btn.disabled = false;
      }
    });

  // Search & Sort
  const searchInput = document.getElementById("accountSearch");
  const clearBtn = document.getElementById("searchClearBtn");
  const sortSelect = document.getElementById("accountSort");

  // Rebuilding every card per keystroke is wasted work while typing.
  let searchTimer = null;
  searchInput.addEventListener("input", () => {
    clearBtn.style.display = searchInput.value.trim() ? "block" : "none";
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      currentQuery = searchInput.value.trim();
      renderAccounts();
    }, 150);
  });

  clearBtn.addEventListener("click", () => {
    clearTimeout(searchTimer);
    searchInput.value = "";
    currentQuery = "";
    clearBtn.style.display = "none";
    searchInput.focus();
    renderAccounts();
  });

  sortSelect.addEventListener("change", () => {
    currentSort = sortSelect.value;
    renderAccounts();
  });

  // Sidebar Nav
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll(".nav-btn")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      showView(btn.dataset.view);
      if (btn.dataset.view === "liveView") loadLiveView();
      if (btn.dataset.view === "statsView") initStatsView();
      if (btn.dataset.view === "overviewView") renderOverview();
    });
  });

  // Window Controls
  document
    .getElementById("minimizeAppBtn")
    .addEventListener("click", () => window.electronAPI.minimizeWindow());
  document
    .getElementById("closeAppBtn")
    .addEventListener("click", () => window.electronAPI.closeWindow());

  // Add Account
  document.getElementById("addAccountBtn").addEventListener("click", openModal);

  // External links
  document.getElementById("discordBtn").addEventListener("click", (e) => {
    e.preventDefault();
    window.electronAPI.openExternal("https://discord.gg/ZyfUMWTPFe");
  });
  document.getElementById("websiteBtn").addEventListener("click", (e) => {
    e.preventDefault();
    window.electronAPI.openExternal("https://www.lostleague.com/");
  });

  // Modal Controls
  document.getElementById("cancelAddBtn").addEventListener("click", closeModal);
  document
    .getElementById("saveAccountBtn")
    .addEventListener("click", saveAccount);
  initQuickAdd();
  initOnboarding();

  // Change League Client path
  document
    .getElementById("changePathBtn")
    .addEventListener("click", async () => {
      const result = await window.electronAPI.openFileDialog({
        title: "Select LeagueClient.exe",
        filters: [{ name: "Executables", extensions: ["exe"] }],
        properties: ["openFile"],
      });
      if (!result.canceled && result.filePaths.length > 0) {
        const newPath = result.filePaths[0];
        const res = await window.electronAPI.setConfig({ lolPath: newPath });
        if (res.success) {
          document.getElementById("lolPathDisplay").innerText = newPath;
          showToast("League path updated!", "success");
        } else {
          showToast(res.message || "Failed to update League path", "error");
        }
      }
    });

  // Change client language
  document
    .getElementById("changeLocaleBtn")
    .addEventListener("click", async () => {
      const locale = document.getElementById("localeSelect").value;
      const res = await window.electronAPI.changeLanguage(locale);
      if (res.success) {
        showToast("Language changed! Restart the client to apply.", "success");
      } else {
        showToast("Failed: " + res.message, "error");
      }
    });
});

// ── Layout density (Settings > Appearance) ──────────────────────────────
// "roomy" swaps the control and row sizes in tokens.css for the larger ones of 1.7.
function applyDensity(density) {
  document.documentElement.dataset.density = density === "roomy" ? "roomy" : "compact";
}

function initDensitySettings(config) {
  let current = config.density === "roomy" ? "roomy" : "compact";
  const btns = document.querySelectorAll("#densityBtns .scale-btn");
  const render = () =>
    btns.forEach((b) => {
      b.classList.toggle("active", b.dataset.density === current);
      b.setAttribute("aria-pressed", String(b.dataset.density === current));
    });
  applyDensity(current);
  render();
  btns.forEach((btn) =>
    btn.addEventListener("click", async () => {
      const previous = current;
      current = btn.dataset.density;
      applyDensity(current);
      render();
      const res = await window.electronAPI.setConfig({ density: current });
      if (res && res.success === false) {
        current = previous;
        applyDensity(current);
        render();
        showToast(res.message || "Could not change the layout", "error");
      }
    }),
  );
}

function applyUiScale(scale) {
  window.electronAPI.setZoomFactor(scale);
}

function showView(viewId) {
  document
    .querySelectorAll(".view")
    .forEach((v) => v.classList.remove("active"));
  document.getElementById(viewId).classList.add("active");
  // Live timers only tick while the Live view is shown; opening it again
  // reloads the view and restarts them.
  if (currentView === "liveView" && viewId !== "liveView") stopLiveTimers();
  currentView = viewId;
}

/**
 * Shows a premium toast notification
 */
function showToast(message, type = "info") {
  const container = document.getElementById("toastContainer");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;

  let icon = '<i class="fas fa-info-circle"></i>';
  if (type === "success") icon = '<i class="fas fa-check-circle"></i>';
  if (type === "error") icon = '<i class="fas fa-exclamation-circle"></i>';

  // icon is always one of the fixed strings above, but message can originate
  // from IO (backend error text, etc.) — keep it out of innerHTML.
  toast.innerHTML = `
        <span class="toast-icon">${icon}</span>
        <span class="toast-msg"></span>
    `;
  toast.querySelector(".toast-msg").textContent = message;

  // The same text already on screen is not repeated, and at most
  // MAX_TOASTS stay visible (the oldest goes first).
  const visible = [...container.querySelectorAll(".toast:not(.removing)")];
  if (visible.some((t) => t.querySelector(".toast-msg")?.textContent === message)) return;
  while (visible.length >= MAX_TOASTS) visible.shift().remove();

  container.appendChild(toast);

  // Auto-remove after 4s
  setTimeout(() => {
    toast.classList.add("removing");
    setTimeout(() => toast.remove(), 400);
  }, 4000);
}
const MAX_TOASTS = 3;

// ── Dialog layers ─────────────────────────────────────────────────────────
// ── First start ──────────────────────────────────────────────────────────────
// Four steps: welcome, League install, first account, a few settings. Shown
// once, when no account is saved yet; Skip, Escape and Finish all end it.
let _obStep = 0;
let _obProfile = null; // the looked-up Riot ID, if any
let _obToken = 0;

async function shouldShowOnboarding(config) {
  if (config.onboardingDone) return false;
  const accounts = await window.electronAPI.getAccounts().catch(() => null);
  const list = Array.isArray(accounts) ? accounts : accounts?.accounts;
  if (Array.isArray(list) && list.length) {
    // Someone who already has accounts never needs it.
    window.electronAPI.setConfig({ onboardingDone: true });
    return false;
  }
  return Array.isArray(list);
}

function showObStep(n) {
  _obStep = n;
  const box = document.getElementById("onboarding");
  box.querySelectorAll(".ob-step").forEach((s) => (s.hidden = Number(s.dataset.step) !== n));
  box.querySelectorAll(".ob-steps span").forEach((d, i) => d.classList.toggle("is-done", i <= n));
  const first = box.querySelector(`.ob-step[data-step="${n}"]`).querySelector("input:not([type=checkbox]), .primary-btn");
  first?.focus();
}

function renderObPath(config) {
  const found = !!config.lolPathFound;
  document.getElementById("obPathBox").classList.toggle("is-missing", !found);
  document.getElementById("obPathIcon").className = `fas ${found ? "fa-circle-check" : "fa-triangle-exclamation"}`;
  document.getElementById("obPathStatus").textContent = found ? "League found" : "League not found";
  document.getElementById("obPath").textContent = found
    ? config.lolPath
    : "Choose LeagueClient.exe in your League of Legends folder.";
  document.getElementById("obPathBtn").textContent = found ? "Change" : "Choose";
}

function openOnboarding(config) {
  const box = document.getElementById("onboarding");
  document.getElementById("obRegion").innerHTML = REGIONS.map(
    ([v, label]) => `<option value="${v}">${label}</option>`,
  ).join("");
  document.getElementById("obRegion").value = "euw";
  document.getElementById("obClientBtn").hidden = !lcuConnected;
  document.getElementById("obAutoAccept").checked = !!config.autoAccept;
  document.getElementById("obQueueToast").checked = config.toastOnQueuePop !== false;
  document.getElementById("obStartWithWindows").checked = !!config.startWithWindows;
  renderObPath(config);
  openLayer(box, { onEscape: () => finishOnboarding(false) });
  showObStep(0);
}

async function finishOnboarding(applySettings) {
  const box = document.getElementById("onboarding");
  const patch = { onboardingDone: true };
  if (applySettings) {
    patch.autoAccept = document.getElementById("obAutoAccept").checked;
    patch.toastOnQueuePop = document.getElementById("obQueueToast").checked;
    patch.startWithWindows = document.getElementById("obStartWithWindows").checked;
  }
  await window.electronAPI.setConfig(patch).catch(() => null);
  if (applySettings) {
    const toggle = document.getElementById("autoAcceptToggle");
    if (toggle) toggle.checked = patch.autoAccept;
    ["toastOnQueuePop", "startWithWindows"].forEach((k) => {
      const el = document.getElementById(`${k}Toggle`);
      if (el) el.checked = patch[k];
    });
  }
  closeLayer(box);
}

function renderObFound(p) {
  const el = document.getElementById("obFound");
  el.hidden = false;
  el.className = "ob-found";
  const emblem = tierEmblemSrc(p.tier);
  // Name and rank come from OP.GG or the Riot API: escaped.
  el.innerHTML = `
      <img src="${escapeHtml(p.iconSrc || "assets/logo.png")}" alt="">
      <div><div class="ob-found-name">${escapeHtml(p.riotId)}</div>
      <div class="ob-found-rank ${tierClass((p.tier || "").split(" ")[0])}">${escapeHtml([p.tier || "Unranked", p.lp].filter(Boolean).join(" "))}</div></div>
      ${emblem ? `<img class="ob-found-emblem" src="${emblem}" alt="">` : ""}`;
  const img = el.querySelector("img");
  img.addEventListener("error", () => (img.src = "assets/logo.png"));
}

async function obFind() {
  const input = document.getElementById("obRiotId").value.trim();
  if (!input) return document.getElementById("obRiotId").focus();
  const token = ++_obToken;
  const btn = document.getElementById("obFindBtn");
  btn.disabled = true;
  const res = await window.electronAPI
    .lookupSummoner(input, document.getElementById("obRegion").value)
    .catch((e) => ({ success: false, message: e.message }));
  btn.disabled = false;
  if (token !== _obToken) return;
  const el = document.getElementById("obFound");
  if (!res?.success) {
    _obProfile = null;
    el.hidden = false;
    el.className = "ob-found is-error";
    el.textContent = res?.message || "No player found with that Riot ID.";
    return;
  }
  _obProfile = res;
  document.getElementById("obRegion").value = res.region;
  renderObFound(res);
  document.getElementById("obUsername").focus();
}

async function obFromClient() {
  const res = await window.electronAPI.getClientSummoner().catch(() => null);
  if (!res?.success) return;
  if (res.username) document.getElementById("obUsername").value = res.username;
  document.getElementById("obRiotId").value = res.riotId;
  if (res.region) document.getElementById("obRegion").value = res.region;
  await obFind();
  if (res.username) document.getElementById("obPassword").focus();
}

async function obSaveAccount() {
  const username = document.getElementById("obUsername").value.trim();
  const password = document.getElementById("obPassword").value;
  const errEl = document.getElementById("obAccountError");
  errEl.textContent = "";
  if (!username || !password) {
    errEl.textContent = "Enter the login name and password you use in the Riot Client.";
    return;
  }
  const p = _obProfile;
  const typed = document.getElementById("obRiotId").value.trim();
  const data = {
    username,
    password,
    riotId: p?.riotId || (/^[^#]+#[^#]+$/.test(typed) ? typed : ""),
    region: p?.region || document.getElementById("obRegion").value,
    label: p?.gameName || (p?.riotId || typed).split("#")[0] || username,
  };
  const btn = document.getElementById("obSaveBtn");
  btn.disabled = true;
  const res = await window.electronAPI.addAccount(data).catch((e) => ({ success: false, message: e.message }));
  btn.disabled = false;
  if (!res?.success) {
    errEl.textContent = res?.message || "The account could not be saved.";
    return;
  }
  document.getElementById("obPassword").value = "";
  await loadAccounts();
  selectAccount(username);
  showObStep(3);
}

function initOnboarding() {
  const box = document.getElementById("onboarding");
  box.addEventListener("click", (e) => {
    const action = e.target.closest("[data-ob]")?.dataset.ob;
    if (action === "next") showObStep(_obStep + 1);
    else if (action === "back") showObStep(_obStep - 1);
    else if (action === "later") showObStep(3);
    else if (action === "skip") finishOnboarding(false);
    else if (action === "finish") finishOnboarding(true);
  });
  document.getElementById("obPathBtn").addEventListener("click", async () => {
    const result = await window.electronAPI.openFileDialog({
      title: "Select LeagueClient.exe",
      filters: [{ name: "Executables", extensions: ["exe"] }],
      properties: ["openFile"],
    });
    if (result.canceled || !result.filePaths.length) return;
    const res = await window.electronAPI.setConfig({ lolPath: result.filePaths[0] });
    if (!res?.success) return showToast(res?.message || "That is not LeagueClient.exe.", "error");
    document.getElementById("lolPathDisplay").innerText = result.filePaths[0];
    renderObPath({ lolPathFound: true, lolPath: result.filePaths[0] });
  });
  document.getElementById("obFindBtn").addEventListener("click", obFind);
  document.getElementById("obClientBtn").addEventListener("click", obFromClient);
  document.getElementById("obSaveBtn").addEventListener("click", obSaveAccount);
  const riotInput = document.getElementById("obRiotId");
  riotInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      obFind();
    }
  });
  riotInput.addEventListener("paste", () => setTimeout(() => /op\.gg\//i.test(riotInput.value) && obFind(), 0));
  ["obUsername", "obPassword"].forEach((id) =>
    document.getElementById(id).addEventListener("input", () => (document.getElementById("obAccountError").textContent = "")),
  );
  document.getElementById("obPassword").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      obSaveAccount();
    }
  });
}

// One stack of open layers (modals, the launch overlay, the vault lock).
// The topmost one gets focus and Escape; everything behind it is inert (no
// Tab, no clicks), and focus returns to where it was when the layer closes.
const _layers = [];
const LAYER_ROOTS =
  ".app-container, #updateCard, #updatePill, #launchOverlay, .modal, #vaultLock";
const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function syncLayerInert() {
  const top = _layers[_layers.length - 1]?.el || null;
  document.querySelectorAll(LAYER_ROOTS).forEach((el) => {
    el.inert = !!top && el !== top;
  });
}

function isLayerOpen(el) {
  return _layers.some((l) => l.el === el);
}

// show: called to make the element visible (default: add .active).
function openLayer(el, { onEscape = null, focus = null, show = null } = {}) {
  if (!isLayerOpen(el)) {
    _layers.push({ el, onEscape, returnFocus: document.activeElement });
  } else {
    const layer = _layers.find((l) => l.el === el);
    layer.onEscape = onEscape;
  }
  if (show) show(el);
  else el.classList.add("active");
  syncLayerInert();
  const target =
    (typeof focus === "string" ? el.querySelector(focus) : focus) ||
    el.querySelector(FOCUSABLE);
  target?.focus();
}

function closeLayer(el, { hide = null } = {}) {
  if (hide) hide(el);
  else el.classList.remove("active");
  const i = _layers.findIndex((l) => l.el === el);
  if (i === -1) return;
  const wasTop = i === _layers.length - 1;
  const [layer] = _layers.splice(i, 1);
  syncLayerInert();
  const back = layer.returnFocus;
  if (wasTop && back?.isConnected && !back.closest("[inert]")) back.focus();
}

// Escape closes the topmost thing only: an open layer, then the champion
// search inside the account form, then the account form itself.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented) return;
  const top = _layers[_layers.length - 1];
  if (top) {
    if (top.onEscape) {
      e.preventDefault();
      top.onEscape();
    }
    return;
  }
  if (currentView === "accountFormView") {
    e.preventDefault();
    closeModal();
  }
});

/**
 * Confirmation modal. Starts on Cancel, so Enter never confirms a
 * destructive action by accident; Escape and a backdrop click cancel.
 * type "danger" colors the confirm button red; confirmLabel names the action.
 */
let _confirmFinish = null;
function showConfirm(title, message, type = "info", confirmLabel = "Confirm") {
  return new Promise((resolve) => {
    // A second confirm replaces an open one instead of orphaning its promise.
    if (_confirmFinish) _confirmFinish(false);

    const modal = document.getElementById("confirmModal");
    const content = modal.querySelector(".modal-content");
    const titleEl = document.getElementById("confirmTitle");
    const msgEl = document.getElementById("confirmMessage");
    const yesBtn = document.getElementById("confirmYesBtn");
    const cancelBtn = document.getElementById("confirmCancelBtn");

    // Reset and apply type
    content.classList.remove("danger", "info", "success");
    content.classList.add(type);
    yesBtn.textContent = confirmLabel;
    yesBtn.classList.toggle("danger", type === "danger");

    titleEl.innerText = title;
    msgEl.innerText = message;

    const finish = (value) => {
      if (_confirmFinish !== finish) return;
      _confirmFinish = null;
      yesBtn.onclick = null;
      cancelBtn.onclick = null;
      modal.onclick = null;
      closeLayer(modal);
      resolve(value);
    };
    _confirmFinish = finish;

    yesBtn.onclick = () => finish(true);
    cancelBtn.onclick = () => finish(false);
    modal.onclick = (e) => {
      if (e.target === modal) finish(false);
    };
    openLayer(modal, { onEscape: () => finish(false), focus: cancelBtn });
  });
}

/**
 * In-app form dialog (passwords, passphrases). fields: [{ name, label,
 * type = "password", autocomplete }]. onSubmit(values) may return an error
 * text (the dialog stays open and shows it) or nothing (the dialog closes).
 * Resolves with the values, or null when cancelled. Values are never trimmed.
 */
let _formDialogFinish = null;
function showFormDialog({
  title,
  message = "",
  fields,
  confirmLabel = "OK",
  danger = false,
  onSubmit = null,
}) {
  return new Promise((resolve) => {
    if (_formDialogFinish) _formDialogFinish(null);

    const modal = document.getElementById("formDialog");
    const form = document.getElementById("formDialogForm");
    const fieldsEl = document.getElementById("formDialogFields");
    const errorEl = document.getElementById("formDialogError");
    const submitBtn = document.getElementById("formDialogSubmitBtn");
    const cancelBtn = document.getElementById("formDialogCancelBtn");

    document.getElementById("formDialogTitle").textContent = title;
    const msgEl = document.getElementById("formDialogMessage");
    msgEl.textContent = message;
    msgEl.style.display = message ? "" : "none";
    errorEl.textContent = "";
    submitBtn.textContent = confirmLabel;
    submitBtn.classList.toggle("danger", danger);
    submitBtn.disabled = false;

    fieldsEl.innerHTML = "";
    const inputs = fields.map((f, i) => {
      const group = document.createElement("div");
      group.className = "form-group";
      const label = document.createElement("label");
      label.htmlFor = `formDialogField${i}`;
      label.textContent = f.label;
      const input = document.createElement("input");
      input.id = label.htmlFor;
      input.type = f.type || "password";
      input.autocomplete = f.autocomplete || "off";
      input.spellcheck = false;
      group.append(label, input);
      fieldsEl.appendChild(group);
      return input;
    });

    let busy = false;
    const finish = (value) => {
      if (_formDialogFinish !== finish) return;
      _formDialogFinish = null;
      form.onsubmit = null;
      cancelBtn.onclick = null;
      inputs.forEach((input) => (input.value = "")); // no secrets left in the DOM
      closeLayer(modal);
      resolve(value);
    };
    _formDialogFinish = finish;

    form.onsubmit = async (e) => {
      e.preventDefault();
      if (busy) return;
      const values = Object.fromEntries(
        fields.map((f, i) => [f.name, inputs[i].value]),
      );
      busy = true;
      submitBtn.disabled = true;
      let error = null;
      try {
        error = onSubmit ? await onSubmit(values) : null;
      } catch (err) {
        error = err?.message || String(err);
      }
      busy = false;
      submitBtn.disabled = false;
      if (_formDialogFinish !== finish) return;
      if (error) {
        errorEl.textContent = error;
        inputs[0]?.focus();
        inputs[0]?.select();
      } else {
        finish(values);
      }
    };
    cancelBtn.onclick = () => {
      if (!busy) finish(null);
    };
    openLayer(modal, {
      onEscape: () => {
        if (!busy) finish(null);
      },
      focus: inputs[0],
    });
  });
}

async function loadAccounts() {
  [allAccounts, activeAccountUsername] = await Promise.all([
    window.electronAPI.getAccounts(),
    window.electronAPI.getCurrentAccount(),
  ]);
  if (!Array.isArray(allAccounts)) allAccounts = [];
  pruneStatsCache();
  renderAccounts();
}

function renderAccounts() {
  hideTooltip(); // the hovered element is about to be torn out from under the cursor
  // A drag in progress loses its source card here; its dragend would fire on
  // the detached node and never clear the state.
  if (_dragUsername) endDrag();

  const listEl = document.getElementById("accountsList");
  listEl.innerHTML = "";

  const countEl = document.getElementById("accountCount");
  if (countEl) countEl.textContent = allAccounts.length;
  renderRegionFilters();
  renderTagFilters();
  if (bulkMode) updateBulkBar();
  renderAccountsSummary();

  const filtered = getFilteredSorted();

  if (allAccounts.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `
            <div class="empty-icon"><i class="fas fa-user-plus"></i></div>
            <p>Add your first League account</p>
            <span>Save a login once, then switch accounts in one click.</span>
            <button class="primary-btn empty-add-btn">Add account</button>
        `;
    empty
      .querySelector(".empty-add-btn")
      .addEventListener("click", () => openModal());
    listEl.appendChild(empty);
    ensureSelection([]);
    return;
  }

  if (filtered.length === 0) {
    const noRes = document.createElement("div");
    noRes.className = "empty-state";
    noRes.innerHTML = `<div class="empty-icon"><i class="fas fa-magnifying-glass"></i></div><p>No accounts match.</p>`;
    listEl.appendChild(noRes);
    ensureSelection([]);
    return;
  }

  let staggerIndex = 0;
  const now = Date.now();

  for (const acc of filtered) {
    const el = createAccountCard(acc);
    listEl.appendChild(el);

    if (!acc.riotId || !acc.region) continue;
    const entry = statsCache[acc.username];
    const state = statsEntryState(entry, acc, now);
    if (state !== "missing") {
      applyStatsToCard(el, entry.stats); // stale entries stay visible while refetching
      if (state === "fresh") continue;
    } else {
      const failure = recentStatsFailure(acc);
      if (failure) {
        applyStatsToCard(el, failure.stats);
        continue;
      }
    }
    // Only requests that actually start take a stagger slot.
    if (statsInFlight.get(acc.username) !== statsKey(acc)) {
      requestCardStats(acc, staggerIndex++ * STATS_STAGGER_MS);
    }
  }
  ensureSelection(filtered);
}

// Stats arrive one card at a time; re-sorting by rank after each one used to
// rebuild the whole list N times. Coalesce into a single re-render.
let _resortTimer = null;
function scheduleRankResort() {
  clearTimeout(_resortTimer);
  _resortTimer = setTimeout(() => {
    if (currentSort === "rank") renderAccounts();
  }, 400);
}

function applyStatsToCard(cardEl, stats) {
  const acc = allAccounts.find((a) => a.username === cardEl.dataset.username);
  // Decay estimates need the tier, which arrives here.
  const statusEl = cardEl.querySelector(".status-badges");
  if (statusEl && acc) statusEl.innerHTML = statusWarnings(acc.status, stats?.tier, Date.now()).map(warningBadge).join("");

  const rankEl = cardEl.querySelector(".rank");
  if (rankEl && !acc?.customRank) {
    const tierName = (stats.tier || "unranked").split(" ")[0].toLowerCase();
    const cls = TIERS.includes(tierName) ? `rank-${tierName}` : "rank-unranked";
    rankEl.className = `rank card-rank ${cls}`;
    const unavailable = stats.tier === "N/A";
    const tierDisplay = unavailable
      ? "Rank unavailable"
      : stats.tier && stats.tier !== "Unranked"
        ? stats.tier
        : "Unranked";
    if (unavailable && stats.error) rankEl.dataset.tooltip = stats.error;
    else delete rankEl.dataset.tooltip;
    // Tier/LP can come from OP.GG or an imported backup's cached stats.
    const emblem = unavailable ? "" : tierEmblemSrc(stats.tier);
    rankEl.innerHTML = `${emblem ? `<img class="card-emblem" src="${emblem}" alt="">` : ""}<span class="card-rank-text"><span class="card-tier">${escapeHtml(tierDisplay)}</span>${stats.lp ? `<span class="card-lp">${escapeHtml(stats.lp)}</span>` : ""}</span>`;
  }
  if (acc && cardEl.dataset.username === _profileUsername) populateProfileModal(acc, stats);
  const iconEl = cardEl.querySelector(".summoner-icon");
  if (iconEl && stats.iconSrc && !acc?.customAvatar) iconEl.src = stats.iconSrc;

  const levelEl = cardEl.querySelector(".level-badge");
  if (levelEl && stats.level) {
    levelEl.innerText = stats.level;
    levelEl.style.display = "block";
  }

  const masteryEl = cardEl.querySelector(".card-mastery");
  const badges = championBadges(stats);
  if (masteryEl && badges.length) {
    // Names can come from OP.GG (external) — escape everything interpolated.
    masteryEl.innerHTML = badges
      .map(
        (b) => `
            <div class="mastery-badge" data-tooltip="${escapeHtml(b.tip)}">
                ${b.icon ? `<img src="${escapeHtml(b.icon)}" alt="" loading="lazy">` : ""}
            </div>
        `,
      )
      .join("");
  }
}

// Mastery (Riot API) when available, otherwise most-played this season (OP.GG).
function championBadges(stats) {
  if (Array.isArray(stats?.masteryChampions) && stats.masteryChampions.length) {
    return stats.masteryChampions.map((c) => ({
      icon: c.icon,
      tip: `${c.name} — ${formatMasteryPoints(c.points)} pts (Mastery ${c.level})`,
    }));
  }
  if (Array.isArray(stats?.topChampions) && stats.topChampions.length) {
    return stats.topChampions.map((c) => ({
      icon: c.icon,
      tip: `${c.name} — ${c.games} games, ${c.games ? Math.round((c.wins / c.games) * 100) : 0}% WR this season`,
    }));
  }
  return [];
}

function formatMasteryPoints(n) {
  if (!n) return "0";
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return `${n}`;
}

// ── Profile Modal ─────────────────────────────────────────────────────────────

// The ranked emblems from the League client (assets/ranks, see README there).
const TIERS = ["iron", "bronze", "silver", "gold", "platinum", "emerald", "diamond", "master", "grandmaster", "challenger"];

// "Gold II", "GOLD", "gold" -> "assets/ranks/gold.png"; "" for anything else.
function tierEmblemSrc(tier) {
  const t = String(tier || "").toLowerCase().split(" ")[0];
  return TIERS.includes(t) ? `assets/ranks/${t}.png` : "";
}

function setTierEmblem(el, tier, fallback = "—") {
  const src = tierEmblemSrc(tier);
  if (!src) {
    el.textContent = fallback;
    el.removeAttribute("aria-label");
    return;
  }
  el.innerHTML = `<img class="tier-emblem" src="${src}" alt="">`;
  el.setAttribute("aria-label", String(tier).split(" ")[0].toLowerCase());
}

let _profileUsername = null;

function fillProfileRank(
  tierEl,
  lpEl,
  recordEl,
  emblemEl,
  tierCls,
  tier,
  lp,
  winLose,
  ratio,
) {
  // "N/A" is a failed lookup; the list row says "Rank unavailable" for it too.
  tierEl.textContent = tier === "N/A" ? "Rank unavailable" : tier || "Unranked";
  tierEl.className = `profile-rank-tier ${tierCls(tier)}`;
  lpEl.textContent = lp || "";
  recordEl.textContent = winLose
    ? `${winLose}${ratio ? "  ·  " + ratio : ""}`
    : "";
  setTierEmblem(emblemEl, tier, "");
}

function populateProfileModal(acc, stats) {
  const defaultIcon = "assets/logo.png";
  // Mirror applyStatsToCard()'s precedence — a custom avatar should win here too,
  // otherwise the profile modal shows a different icon than the account card.
  document.getElementById("profileIcon").src =
    safeAvatarUrl(acc.customAvatar) || stats?.iconSrc || defaultIcon;
  document.getElementById("profileLabel").textContent =
    acc.label || acc.username;
  document.getElementById("profileLevel").textContent = stats?.level || "";
  document.getElementById("profileLevel").style.display = stats?.level
    ? "block"
    : "none";

  document.getElementById("profileMeta").textContent = detailMeta(acc);
  document.getElementById("profileLoading").style.display = "none";
  setLpBar(stats);

  fillProfileRank(
    document.getElementById("profileSoloTier"),
    document.getElementById("profileSoloLp"),
    document.getElementById("profileSoloRecord"),
    document.getElementById("profileSoloEmblem"),
    tierClass,
    stats?.tier,
    stats?.lp,
    stats?.winLose,
    stats?.ratio,
  );
  fillProfileRank(
    document.getElementById("profileFlexTier"),
    document.getElementById("profileFlexLp"),
    document.getElementById("profileFlexRecord"),
    document.getElementById("profileFlexEmblem"),
    tierClass,
    stats?.flexTier,
    stats?.flexLp,
    stats?.flexWinLose,
    stats?.flexRatio,
  );

  const notesWrap = document.getElementById("profileNotesWrap");
  const notesEl = document.getElementById("profileNotes");
  if (acc.notes) {
    notesEl.textContent = acc.notes;
    notesWrap.style.display = "block";
  } else {
    notesWrap.style.display = "none";
  }
}

function formatRankHistoryLabel(entry) {
  // Matches capFirst() in the main process (stats.js/riot-api.js) — tier is
  // always uppercase when stored (see rank-history.js), so .toUpperCase()
  // here is a no-op today, but kept so this doesn't silently mis-format if
  // that ever changes or this helper gets reused elsewhere.
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : "");
  return entry.division
    ? `${cap(entry.tier)} ${entry.division}`
    : cap(entry.tier);
}

// history entries are { ts, tier, division, lp, score }, oldest first, already
// deduped server-side (see rank-history.js) so each point is a real change.
// "DIAMOND IV" -> "Diamond IV"
function goalLabel(goalRank) {
  return String(goalRank || "").toLowerCase().replace(/^\w/, (c) => c.toUpperCase()).replace(/\b(i{1,3}|iv)\b/g, (d) => d.toUpperCase());
}

// The goal-rank options: every division up to Diamond, then the apex tiers.
function goalRankOptions() {
  const opts = ['<option value="">No goal</option>'];
  for (const t of TIERS) {
    const name = t.toUpperCase();
    const divs = ["master", "grandmaster", "challenger"].includes(t) ? [""] : ["IV", "III", "II", "I"];
    for (const d of divs) {
      const value = `${name} ${d}`.trim();
      opts.push(`<option value="${value}">${goalLabel(value)}</option>`);
    }
  }
  return opts.join("");
}

// LP and games since midnight, as far as the app has seen them.
// ── Several accounts at once ────────────────────────────────────────────────
let bulkMode = false;
const bulkPicked = new Set();

function setBulkMode(on) {
  bulkMode = on;
  if (!on) bulkPicked.clear();
  const btn = document.getElementById("selectModeBtn");
  btn.setAttribute("aria-pressed", String(on));
  btn.classList.toggle("active", on);
  document.getElementById("accountsList").classList.toggle("is-selecting", on);
  document.querySelectorAll("#accountsList .account-card").forEach((c) => c.classList.toggle("is-picked", bulkPicked.has(c.dataset.username)));
  updateBulkBar();
}

function toggleBulkPick(username) {
  if (bulkPicked.has(username)) bulkPicked.delete(username);
  else bulkPicked.add(username);
  findAccountCard(username)?.classList.toggle("is-picked", bulkPicked.has(username));
  updateBulkBar();
}

function updateBulkBar() {
  // Accounts deleted meanwhile drop out of the selection.
  for (const u of [...bulkPicked]) if (!allAccounts.some((a) => a.username === u)) bulkPicked.delete(u);
  document.getElementById("bulkBar").hidden = !bulkMode;
  document.getElementById("bulkCount").textContent = bulkPicked.size ? `${plural(bulkPicked.size, "account")} selected` : "Click accounts to select them";
  for (const id of ["bulkTagBtn", "bulkRefreshBtn", "bulkExportBtn", "bulkDeleteBtn"]) document.getElementById(id).disabled = !bulkPicked.size;
}

function pickedAccounts() {
  return allAccounts.filter((a) => bulkPicked.has(a.username));
}

async function bulkAddTag() {
  const values = await showFormDialog({
    title: "Add a tag",
    message: `For ${plural(bulkPicked.size, "account")}. Separate several tags with commas.`,
    fields: [{ name: "tag", label: "Tag", type: "text" }],
    confirmLabel: "Add tag",
    onSubmit: (v) => (parseTags(v.tag).length ? null : "Enter a tag"),
  });
  if (!values) return;
  const add = parseTags(values.tag);
  let failed = 0;
  for (const acc of pickedAccounts()) {
    const res = await window.electronAPI.updateAccount({ username: acc.username, tags: [...parseTags(acc.tags), ...add].join(", ") }).catch(() => null);
    if (!res || res.success === false) failed++;
  }
  await loadAccounts();
  showToast(failed ? `${plural(failed, "account")} could not be tagged` : `Tag added to ${plural(bulkPicked.size, "account")}`, failed ? "error" : "success");
}

async function bulkRefresh() {
  const accounts = pickedAccounts().filter((a) => a.riotId && a.region);
  if (!accounts.length) return showToast("None of these accounts has a Riot ID and server", "info");
  showToast(`Refreshing ${plural(accounts.length, "rank")}...`, "info");
  let failed = 0;
  // One after another: OP.GG and the Riot API limit how fast they answer.
  for (const acc of accounts) {
    const stats = await window.electronAPI.getStats(acc.region, acc.riotId, true).catch(() => null);
    if (!stats || stats.error) { failed++; continue; }
    cacheStats(acc, stats);
    const card = findAccountCard(acc.username);
    if (card) applyStatsToCard(card, stats);
  }
  showToast(failed ? `${plural(failed, "rank")} could not be refreshed` : "Ranks refreshed", failed ? "error" : "success");
}

async function bulkDelete() {
  const accounts = pickedAccounts();
  const ok = await showConfirm(
    "Delete accounts",
    `Delete ${plural(accounts.length, "account")}? This cannot be undone.`,
    "danger",
    "Delete",
  );
  if (!ok) return;
  let failed = 0;
  for (const acc of accounts) {
    const res = await window.electronAPI.deleteAccount(acc.username).catch(() => null);
    if (!res || res.success === false) failed++;
    else {
      delete statsCache[acc.username];
      delete statsFailures[acc.username];
    }
  }
  setBulkMode(false);
  await loadAccounts();
  showToast(failed ? `${plural(failed, "account")} could not be deleted` : "Accounts deleted", failed ? "error" : "success");
}

function initBulkActions() {
  document.getElementById("selectModeBtn").addEventListener("click", () => setBulkMode(!bulkMode));
  document.getElementById("bulkAllBtn").addEventListener("click", () => {
    for (const a of getFilteredSorted()) bulkPicked.add(a.username);
    setBulkMode(true);
  });
  document.getElementById("bulkTagBtn").addEventListener("click", bulkAddTag);
  document.getElementById("bulkRefreshBtn").addEventListener("click", bulkRefresh);
  document.getElementById("bulkExportBtn").addEventListener("click", (e) => exportAccountsFlow(e.currentTarget, [...bulkPicked]));
  document.getElementById("bulkDeleteBtn").addEventListener("click", bulkDelete);
}

// ── Status warnings (decay, restriction, inactivity) ──────────────────────
const WARNING_ICONS = { restriction: "fa-ban", decay: "fa-hourglass-half", inactive: "fa-moon" };

function accountWarnings(account) {
  return statusWarnings(account.status, getCachedStats(account)?.tier, Date.now());
}

function warningBadge(w) {
  const cls = w.kind === "inactive" ? "account-info-badge" : "account-warning-badge";
  return `<span class="${cls}" data-tooltip="${escapeHtml(w.text)}" aria-label="${escapeHtml(w.text)}"><i class="fas ${escapeHtml(WARNING_ICONS[w.kind])}" aria-hidden="true"></i></span>`;
}

// Panel: the warnings in words, and when the account last played.
function renderStatus(acc) {
  const wrap = document.getElementById("profileStatusWrap");
  const list = document.getElementById("profileStatusList");
  if (!wrap || !list) return;
  const warnings = accountWarnings(acc);
  const lastPlayed = acc.status?.lastPlayed;
  list.textContent = "";
  for (const w of warnings) {
    const row = document.createElement("div");
    row.className = `profile-status-row${w.urgent ? " is-urgent" : ""}`;
    row.innerHTML = `<i class="fas ${escapeHtml(WARNING_ICONS[w.kind])}" aria-hidden="true"></i><span></span>`;
    row.querySelector("span").textContent = w.text;
    list.appendChild(row);
  }
  if (lastPlayed && !warnings.some((w) => w.kind === "inactive")) {
    const row = document.createElement("div");
    row.className = "profile-status-row is-quiet";
    row.innerHTML = '<i class="fas fa-clock" aria-hidden="true"></i><span></span>';
    row.querySelector("span").textContent = `Last played ${timeAgo(lastPlayed)}`;
    list.appendChild(row);
  }
  wrap.hidden = list.childElementCount === 0;
}

// Blue Essence and RP as the client showed them at the last sign-in.
function renderWallet(acc) {
  const wrap = document.getElementById("profileWalletWrap");
  const w = acc.status?.wallet;
  if (!wrap || !w || (w.be == null && w.rp == null)) {
    if (wrap) wrap.hidden = true;
    return;
  }
  const n = (v) => (v == null ? "-" : Number(v).toLocaleString());
  document.getElementById("profileWalletBe").textContent = n(w.be);
  document.getElementById("profileWalletRp").textContent = n(w.rp);
  document.getElementById("profileWalletWhen").textContent = w.checkedAt ? `at last sign-in, ${timeAgo(w.checkedAt)}` : "";
  wrap.hidden = false;
}

function renderToday(history) {
  const wrap = document.getElementById("profileTodayWrap");
  const day = dailySummary(history);
  wrap.hidden = !day;
  if (!day) return;
  const lpEl = document.getElementById("profileTodayLp");
  lpEl.textContent = `${day.lp > 0 ? "+" : ""}${day.lp} LP`;
  lpEl.className = `profile-today-lp${day.lp > 0 ? " is-up" : day.lp < 0 ? " is-down" : ""}`;
  document.getElementById("profileTodayRecord").textContent =
    day.wins === null ? "" : `${day.wins}W ${day.losses}L`;
  wrap.title = "Counted from the ranks the app has loaded today.";
}

function renderGoal(acc, history) {
  const wrap = document.getElementById("profileGoalWrap");
  const g = acc.goalRank ? goalProgress(history, acc.goalRank) : null;
  wrap.hidden = !g;
  if (!g) return;
  document.getElementById("profileGoalRank").textContent = goalLabel(acc.goalRank);
  document.getElementById("profileGoalRank").className = `profile-goal-rank ${tierClass(acc.goalRank.split(" ")[0])}`;
  document.getElementById("profileGoalLeft").textContent =
    g.current === null ? "No rank yet" : g.reached ? "Reached" : `${g.left} LP to go`;
  document.getElementById("profileGoalBar").style.width = `${g.reached ? 100 : g.pct}%`;
  wrap.classList.toggle("is-reached", g.reached);
}

function renderRankSparkline(history) {
  const wrap = document.getElementById("profileRankHistoryWrap");
  const svg = document.getElementById("profileRankSparkline");
  const rangeEl = document.getElementById("profileRankHistoryRange");

  if (!Array.isArray(history) || history.length < 2) {
    wrap.style.display = "none";
    svg.innerHTML = "";
    return;
  }
  wrap.style.display = "block";

  // Use the SVG's own viewBox so the line spans the whole box (it used a
  // fixed 44 of the 60 units, which flattened a falling rank).
  const box = svg.viewBox?.baseVal;
  const w = box?.width || 300;
  const h = box?.height || 60;
  const points = sparklinePoints(history, w, h, 3);

  const first = history[0];
  const last = history[history.length - 1];
  const rising = last.score >= first.score;
  const strokeColor = rising ? "var(--primary)" : "var(--danger)";
  const lastPoint = points[points.length - 1];
  const pointsAttr = points
    .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(" ");

  svg.innerHTML = `
        <polyline points="${pointsAttr}" style="fill:none;stroke:${strokeColor};stroke-width:2;stroke-linejoin:round;stroke-linecap:round" />
        <circle cx="${lastPoint.x.toFixed(1)}" cy="${lastPoint.y.toFixed(1)}" r="2.5" style="fill:${strokeColor}" />
    `;

  rangeEl.textContent = `${formatRankHistoryLabel(first)} → ${formatRankHistoryLabel(last)}`;
}

function renderMatchHistory(res) {
  const wrap = document.getElementById("profileMatchHistoryWrap");
  const strip = document.getElementById("profileMatchHistoryStrip");
  const matches = res?.matches;

  if (!Array.isArray(matches) || matches.length === 0) {
    wrap.style.display = "none";
    strip.innerHTML = "";
    return;
  }
  wrap.style.display = "block";
  // Matches can come from OP.GG (external), so the icon URL and KDA text are
  // escaped like any other outside string.
  strip.innerHTML = matches
    .slice(0, 5)
    .map((m) => {
      const tip = `${m.win ? "Victory" : "Defeat"}${m.kda ? `, ${m.kda} KDA` : ""}${m.champion ? ` on ${m.champion}` : ""}`;
      return `
        <button type="button" class="match-pill ${m.win ? "win" : "loss"}" data-match-id="${escapeHtml(m.id || "")}" data-tooltip="${escapeHtml(tip)}" aria-label="${escapeHtml(tip)}">
            ${m.championIcon ? `<img src="${escapeHtml(m.championIcon)}" alt="">` : ""}
        </button>
    `;
    })
    .join("");
}

// ── Season review ─────────────────────────────────────────────────────────
function seasonTile(label, value, sub = "", tier = "") {
  const emblem = tier && tierEmblemSrc(tier) ? `<img src="${escapeHtml(tierEmblemSrc(tier))}" alt="">` : "";
  return `<div class="season-tile"><div class="season-tile-label">${escapeHtml(label)}</div><div class="season-tile-value ${escapeHtml(tierClass(tier))}">${emblem}${escapeHtml(value)}</div>${sub ? `<div class="season-tile-sub">${escapeHtml(sub)}</div>` : ""}</div>`;
}

async function openSeasonReview(acc) {
  if (!acc?.riotId) return;
  document.getElementById("seasonAccount").textContent = acc.label || acc.riotId;
  const body = document.getElementById("seasonBody");
  body.innerHTML = '<p class="season-note">Loading the season...</p>';
  openLayer(document.getElementById("seasonModal"), { onEscape: closeSeasonReview });
  const r = await window.electronAPI.getSeasonReview(acc.region, acc.riotId).catch(() => null);
  if (!r) {
    body.innerHTML = '<p class="season-note">The season could not be loaded.</p>';
    return;
  }
  const label = (e) => (e ? `${formatRankHistoryLabel(e)} ${e.lp} LP` : "-");
  const tiles =
    seasonTile("Peak rank", label(r.peak), r.peak ? new Date(r.peak.ts).toLocaleDateString() : "no rank saved yet", r.peak?.tier || "") +
    seasonTile("Now", label(r.current), "", r.current?.tier || "") +
    seasonTile("Season", r.seasonRecord || "-", r.seasonRatio ? `${r.seasonRatio} win rate (solo/duo)` : "") +
    seasonTile("Longest win streak", r.longestWinStreak ? plural(r.longestWinStreak, "win") : "-", `in ${plural(r.rankedGamesSaved, "saved ranked game")}`);
  let chart = "";
  if (r.history.length > 1) {
    const from = r.history[0].ts;
    const to = Date.now();
    const c = rankChart([{ key: 0, history: r.history }], from, to, 560, 120, 6);
    const pts = c.series[0].points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    chart = `<svg class="season-chart" viewBox="0 0 560 120" preserveAspectRatio="none" role="img" aria-label="Rank over the season">${c.ticks.map((t) => `<line x1="0" x2="560" y1="${t.y.toFixed(1)}" y2="${t.y.toFixed(1)}"></line>`).join("")}<polyline points="${pts}"></polyline></svg>`;
  }
  const champs = r.champions.length
    ? `<p class="ov-label season-note">Most played this season (OP.GG)</p><div class="season-champs">${r.champions
        .map((c) => `<div class="season-champ">${c.icon ? `<img src="${escapeHtml(c.icon)}" alt="">` : ""}<span><b>${escapeHtml(c.name)}</b>${escapeHtml(plural(c.games, "game"))}${c.winRate == null ? "" : escapeHtml(", " + c.winRate + "%")}</span></div>`)
        .join("")}</div>`
    : "";
  body.innerHTML = `<div class="season-tiles">${tiles}</div>${chart}${champs}<p class="season-note">Season ${escapeHtml(r.season)}. Peak and curve come from the ranks the app saved; the longest streak from the saved games.</p>`;
}

function closeSeasonReview() {
  closeLayer(document.getElementById("seasonModal"));
}

function initSeasonReview() {
  document.getElementById("profileSeasonBtn")?.addEventListener("click", () => {
    const acc = selectedAccount();
    if (acc) openSeasonReview(acc);
  });
  document.getElementById("closeSeasonBtn")?.addEventListener("click", closeSeasonReview);
  document.getElementById("seasonModal")?.addEventListener("click", (e) => {
    if (e.target.id === "seasonModal") closeSeasonReview();
  });
}

// ── Games dialog: stored games, one in detail, and champion stats ─────────
let _games = null; // { acc, matches, version, selected }

function itemIcons(items, version) {
  return (items || [])
    .map((id) => `<img class="match-item-icon" src="https://ddragon.leagueoflegends.com/cdn/${escapeHtml(version)}/img/item/${escapeHtml(id)}.png" alt="" data-fallback="hide">`)
    .join("");
}

function kdaRatio(m) {
  return m.deaths ? ((m.kills + m.assists) / m.deaths).toFixed(2) : "Perfect";
}

async function openGamesDialog(acc, matchId = null) {
  if (!acc?.riotId) return;
  const res = await window.electronAPI.getStoredMatches(acc.riotId);
  const list = (res?.matches || []).filter((m) => !m.remake);
  _games = { acc, matches: list, version: res?.version || "", selected: matchId || list[0]?.id || null };
  document.getElementById("gamesAccount").textContent = acc.label || acc.riotId;
  showGamesTab("games");
  renderGamesList();
  renderGameDetail();
  renderChampionStats();
  openLayer(document.getElementById("gamesModal"), { onEscape: closeGamesDialog });
}

function closeGamesDialog() {
  closeLayer(document.getElementById("gamesModal"));
  _games = null;
}

function showGamesTab(tab) {
  document.querySelectorAll("[data-games-tab]").forEach((b) => {
    const on = b.dataset.gamesTab === tab;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
  document.getElementById("gamesPane").hidden = tab !== "games";
  document.getElementById("championsPane").hidden = tab !== "champions";
  document.getElementById("matchupsPane").hidden = tab !== "matchups";
  if (tab === "matchups") loadMatchups();
}

// Matchups need both teams of a game; games saved from OP.GG get them when
// opened, so the missing ones are loaded here (one after another).
let _matchupLoad = 0;
async function loadMatchups() {
  if (!_games) return;
  const run = ++_matchupLoad;
  const missing = _games.matches.filter((m) => !m.players);
  renderMatchups(missing.length ? `Loading both teams of ${plural(missing.length, "game")}...` : "");
  for (const m of missing) {
    const res = await window.electronAPI.getMatchDetail(_games.acc.region, _games.acc.riotId, m.id).catch(() => null);
    if (run !== _matchupLoad || !_games) return;
    if (res?.success && res.match?.players) m.players = res.match.players;
  }
  renderMatchups("");
}

function renderMatchups(note) {
  const stats = matchupStats(_games.matches);
  const known = _games.matches.filter((m) => m.players).length;
  document.getElementById("matchupsNote").textContent =
    note || (stats.length ? `Your lane opponents in ${plural(known, "game")} that list both teams.` : "No lane opponents known yet: the games need positions (Summoner's Rift).");
  document.getElementById("matchupStatsTable").innerHTML = stats.length
    ? `<div class="champion-stats-head"><span></span><span>Against</span><span>Games</span><span>Win rate</span><span>You played</span><span></span></div>` +
      stats
        .map(
          (s) => `
        <div class="champion-stats-row">
            ${s.icon ? `<img src="${escapeHtml(s.icon)}" alt="">` : "<span></span>"}
            <span class="champion-stats-name">${escapeHtml(s.opponent)}</span>
            <span>${escapeHtml(s.games)}</span>
            <span class="${s.winRate >= 50 ? "is-good" : "is-bad"}">${escapeHtml(s.winRate + "%")}</span>
            <span class="matchup-as">${escapeHtml(s.as.join(", "))}</span>
            <span></span>
        </div>`,
        )
        .join("")
    : "";
}

function renderGamesList() {
  const el = document.getElementById("gamesList");
  if (!_games.matches.length) {
    el.innerHTML = '<p class="games-empty">No games stored yet. They are saved each time the account is opened.</p>';
    return;
  }
  el.innerHTML = _games.matches
    .map((m) => {
      const on = m.id === _games.selected;
      return `
        <button type="button" class="games-row ${m.win ? "is-win" : "is-loss"}${on ? " active" : ""}" data-match-id="${escapeHtml(m.id)}" aria-pressed="${on}">
            ${m.championIcon ? `<img class="games-row-icon" src="${escapeHtml(m.championIcon)}" alt="">` : '<span class="games-row-icon"></span>'}
            <span class="games-row-main">
                <span class="games-row-kda">${escapeHtml(m.kda || "")}</span>
                <span class="games-row-sub">${escapeHtml(m.queue || "")}${m.createdAt ? `, ${escapeHtml(timeAgo(m.createdAt))}` : ""}</span>
            </span>
            <span class="games-row-result">${m.win ? "Win" : "Loss"}</span>
        </button>`;
    })
    .join("");
}

function playerRow(p, version) {
  return `
    <div class="game-player${p.isSelf ? " is-self" : ""}">
        ${p.championIcon ? `<img class="game-player-icon" src="${escapeHtml(p.championIcon)}" alt="" data-tooltip="${escapeHtml(p.champion)}">` : '<span class="game-player-icon"></span>'}
        <span class="game-player-name">${escapeHtml(p.name || "Unknown")}${p.tag ? `<span class="game-player-tag">#${escapeHtml(p.tag)}</span>` : ""}</span>
        <span class="game-player-kda">${escapeHtml([p.kills, p.deaths, p.assists].join("/"))}</span>
        <span class="game-player-num">${escapeHtml(p.cs)} CS</span>
        <span class="game-player-num">${escapeHtml(Math.round(p.damage / 100) / 10)}k</span>
        <span class="game-player-items">${itemIcons(p.items, version)}</span>
    </div>`;
}

async function renderGameDetail() {
  const el = document.getElementById("gameDetail");
  const m = _games?.matches.find((x) => x.id === _games.selected);
  if (!m) {
    el.innerHTML = "";
    return;
  }
  const head = `
    <div class="game-detail-head">
        <span class="game-result ${m.win ? "is-win" : "is-loss"}">${m.win ? "Victory" : "Defeat"}</span>
        <span>${escapeHtml(m.queue || "")}</span>
        <span>${escapeHtml(formatDuration(m.duration))}</span>
        <span class="game-detail-date">${m.createdAt ? escapeHtml(new Date(m.createdAt).toLocaleString()) : ""}</span>
    </div>
    <div class="game-self">
        ${m.championIcon ? `<img class="game-self-icon" src="${escapeHtml(m.championIcon)}" alt="">` : ""}
        <div class="game-self-stats">
            <div class="game-self-kda">${escapeHtml(m.kda || "")} <span>${escapeHtml(kdaRatio(m))} KDA</span></div>
            <div class="game-self-sub">${escapeHtml(m.champion || "")}, ${escapeHtml(m.cs)} CS${m.duration ? ` (${escapeHtml((m.cs / (m.duration / 60)).toFixed(1))}/min)` : ""}, ${escapeHtml(Math.round(m.gold / 100) / 10)}k gold, ${escapeHtml(Math.round(m.damage / 100) / 10)}k damage</div>
            <div class="game-self-items">${itemIcons(m.items, _games.version)}</div>
        </div>
    </div>`;
  const teams = (players) => {
    const side = (team, title) => {
      const rows = players.filter((p) => p.team === team);
      if (!rows.length) return "";
      const won = rows[0].win;
      return `<div class="game-team"><div class="game-team-title">${title}, ${won ? "won" : "lost"}</div>${rows.map((p) => playerRow(p, _games.version)).join("")}</div>`;
    };
    return side("blue", "Blue team") + side("red", "Red team");
  };
  if (m.players) {
    el.innerHTML = head + teams(m.players);
    return;
  }
  el.innerHTML = head + '<div class="game-teams-loading">Loading both teams...</div>';
  const res = await window.electronAPI.getMatchDetail(_games.acc.region, _games.acc.riotId, m.id);
  if (!_games || _games.selected !== m.id) return;
  if (res?.success && res.match?.players) {
    m.players = res.match.players;
    el.innerHTML = head + teams(m.players);
  } else {
    el.querySelector(".game-teams-loading").textContent = res?.message || "The teams for this game could not be loaded.";
  }
}

function renderChampionStats() {
  const el = document.getElementById("championStatsTable");
  const stats = championStats(_games.matches);
  document.getElementById("championsNote").textContent = _games.matches.length
    ? `From the last ${_games.matches.length} stored games.`
    : "No games stored yet.";
  el.innerHTML = stats.length
    ? `<div class="champion-stats-head"><span></span><span>Champion</span><span>Games</span><span>Win rate</span><span>KDA</span><span>CS/min</span></div>` +
      stats
        .map(
          (c) => `
        <div class="champion-stats-row">
            ${c.icon ? `<img src="${escapeHtml(c.icon)}" alt="">` : "<span></span>"}
            <span class="champion-stats-name">${escapeHtml(c.champion)}</span>
            <span>${escapeHtml(c.games)}</span>
            <span class="${c.winRate >= 50 ? "is-good" : "is-bad"}">${escapeHtml(c.winRate)}%</span>
            <span>${c.kda === null ? "Perfect" : escapeHtml(c.kda.toFixed(2))}</span>
            <span>${c.csPerMin === null ? "" : escapeHtml(c.csPerMin.toFixed(1))}</span>
        </div>`,
        )
        .join("")
    : "";
}

function initGamesDialog() {
  document.getElementById("profileMatchHistoryStrip")?.addEventListener("click", (e) => {
    const pill = e.target.closest(".match-pill");
    const acc = selectedAccount();
    if (pill && acc) openGamesDialog(acc, pill.dataset.matchId || null);
  });
  document.getElementById("profileGamesBtn")?.addEventListener("click", () => {
    const acc = selectedAccount();
    if (acc) openGamesDialog(acc);
  });
  document.getElementById("closeGamesBtn")?.addEventListener("click", closeGamesDialog);
  document.getElementById("gamesModal")?.addEventListener("click", (e) => {
    if (e.target.id === "gamesModal") closeGamesDialog();
  });
  document.querySelectorAll("[data-games-tab]").forEach((b) =>
    b.addEventListener("click", () => showGamesTab(b.dataset.gamesTab)),
  );
  document.getElementById("gamesList")?.addEventListener("click", (e) => {
    const row = e.target.closest(".games-row");
    if (!row || !_games) return;
    _games.selected = row.dataset.matchId;
    renderGamesList();
    renderGameDetail();
  });
}

// Shows one account in the panel beside the list: rank, history, recent
// games and its actions. Rank history, recent games and stale stats are
// fetched here, on selection, not for every row.
async function selectAccount(username) {
  _profileUsername = username;
  const acc = allAccounts.find((a) => a.username === username);
  if (!acc) return;

  document.getElementById("accountDetailEmpty").hidden = true;
  document.getElementById("accountDetailBody").hidden = false;
  markSelectedRow();
  updateDetailActions(acc);

  // Rank history is a cheap local read (no rate limit / network concerns),
  // so it's always fetched fresh rather than reusing statsCache below.
  document.getElementById("profileRankHistoryWrap").style.display = "none";
  document.getElementById("profileTodayWrap").hidden = true;
  renderGoal(acc, []);
  renderStatus(acc);
  renderWallet(acc);
  if (acc.riotId) {
    window.electronAPI.getRankHistory(acc.riotId).then((history) => {
      if (_profileUsername !== username) return;
      renderRankSparkline(history);
      renderToday(history);
      renderGoal(acc, history);
    });
  }

  // Match history hits the Riot API fresh every open (6 requests) rather than
  // being folded into statsCache — too heavy to run for every card on every
  // render, so it's on-demand here instead (see get-match-history in stats.js).
  document.getElementById("profileMatchHistoryWrap").style.display = "none";
  if (acc.riotId && acc.region) {
    window.electronAPI.getMatchHistory(acc.region, acc.riotId).then((res) => {
      if (_profileUsername === username) renderMatchHistory(res);
    });
  }

  const cached = getCachedStats(acc);
  const isFresh =
    statsEntryState(statsCache[username], acc, Date.now()) === "fresh";
  if (cached) {
    populateProfileModal(acc, cached);
  } else {
    // Show skeleton while fetching
    document.getElementById("profileIcon").src = "assets/logo.png";
    document.getElementById("profileLabel").textContent =
      acc.label || acc.username;
    document.getElementById("profileLevel").style.display = "none";
    document.getElementById("profileMeta").textContent = detailMeta(acc);
    setLpBar(null);
    document.getElementById("profileLoading").style.display = "flex";
    ["profileSoloTier", "profileFlexTier"].forEach((id) => {
      document.getElementById(id).textContent = "—";
      document.getElementById(id).className = "profile-rank-tier rank-unranked";
    });
    [
      "profileSoloLp",
      "profileFlexLp",
      "profileSoloRecord",
      "profileFlexRecord",
      "profileSoloEmblem",
      "profileFlexEmblem",
    ].forEach((id) => {
      document.getElementById(id).textContent = "";
    });
    const notesEl = document.getElementById("profileNotes");
    notesEl.textContent = acc.notes || "";
    document.getElementById("profileNotesWrap").style.display = acc.notes
      ? "block"
      : "none";
    if (!acc.riotId || !acc.region) {
      document.getElementById("profileLoading").style.display = "none";
    }
  }

  // Stale or missing: fetch now; a stale entry stays on screen meanwhile.
  if (acc.riotId && acc.region && !isFresh) {
    const key = statsKey(acc);
    try {
      const stats = await window.electronAPI.getStats(acc.region, acc.riotId);
      const current = allAccounts.find((a) => a.username === username);
      if (stats && current && statsKey(current) === key) {
        cacheStats(current, stats);
        if (_profileUsername === username) populateProfileModal(current, stats);
      }
    } catch {
      /* keep what is shown */
    }
    if (_profileUsername === username) {
      document.getElementById("profileLoading").style.display = "none";
    }
  }
}

function createAccountCard(account) {
  const card = document.createElement("div");
  const isActive = account.username === activeAccountUsername;
  card.className = `account-card${isActive ? " is-active" : ""}${account.isFavourite ? " is-favourite" : ""}`;
  card.dataset.username = account.username;
  card.draggable = canReorder();
  card.tabIndex = 0;
  card.setAttribute("role", "listitem");

  const defaultIcon = "assets/logo.png";
  const iconSrc = safeAvatarUrl(account.customAvatar) || defaultIcon;
  const region = (account.region || "").toUpperCase();
  const rankDisplay =
    account.customRank ||
    (account.riotId && account.region ? "Loading" : "No Riot ID");

  // customAvatar/customRank/label are free-text user input (and can arrive
  // via an imported .llem backup): set through .src/.textContent below,
  // never interpolated into innerHTML.
  card.innerHTML = `
        <div class="summoner-icon-container">
            <img class="summoner-icon" alt="">
            <span class="level-badge" style="display:none"></span>
            <span class="select-mark" aria-hidden="true"><i class="fas fa-check"></i></span>
        </div>
        <div class="text-content">
            <div class="card-title-row">
                <h3 class="card-label"></h3>
                ${account.isFavourite ? '<span class="fav-mark" aria-label="Favourite"><i class="fas fa-star" aria-hidden="true"></i></span>' : ""}
                ${isActive ? '<span class="active-dot" data-tooltip="Signed in to the League client" aria-label="Signed in"></span>' : ""}
                ${account.passwordOk === false ? '<span class="account-warning-badge" data-tooltip="Saved password could not be read (often after a Windows update). Click Edit and enter it again."><i class="fas fa-triangle-exclamation"></i></span>' : ""}
                ${account.honorFlagged ? '<span class="account-warning-badge" data-tooltip="Honor level has dropped since it was last seen"><i class="fas fa-arrow-trend-down"></i></span>' : ""}
                <span class="status-badges">${accountWarnings(account).map(warningBadge).join("")}</span>
            </div>
            <div class="card-meta"><span class="card-username"></span><span class="card-tags"></span></div>
        </div>
        <span class="region-badge card-region"></span>
        <div class="rank card-rank"></div>
        <div class="mastery-badges card-mastery"></div>
        <div class="card-actions">
            <button class="icon-btn play-btn" data-tooltip="Play" data-tooltip-pos="left"><i class="fas fa-play"></i></button>
        </div>
    `;

  const iconEl = card.querySelector(".summoner-icon");
  iconEl.src = iconSrc;
  iconEl.addEventListener("error", () => {
    iconEl.src = defaultIcon;
  });

  const label = account.label || account.username;
  card.querySelector(".card-label").textContent = label;
  card.querySelector(".card-username").textContent = account.riotId || account.username;
  const tagsEl = card.querySelector(".card-tags");
  for (const t of parseTags(account.tags).slice(0, 2)) {
    const chip = document.createElement("span");
    chip.className = "card-tag";
    chip.textContent = t;
    tagsEl.appendChild(chip);
  }
  const regionEl = card.querySelector(".card-region");
  if (region) regionEl.textContent = region;
  else regionEl.remove();
  card.querySelector(".card-rank").textContent = rankDisplay;
  card.setAttribute("aria-label", label);
  card.querySelector(".play-btn").setAttribute("aria-label", `Play as ${label}`);

  card.classList.toggle("is-picked", bulkPicked.has(account.username));
  card.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    if (bulkMode) return toggleBulkPick(account.username);
    selectAccount(account.username);
  });
  card.addEventListener("dblclick", (e) => {
    if (e.target.closest("button") || bulkMode) return;
    launchAccount(account.username);
  });
  card.addEventListener("keydown", (e) => {
    if (e.target !== card) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      selectAccount(account.username);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = e.key === "ArrowDown" ? card.nextElementSibling : card.previousElementSibling;
      if (next?.classList.contains("account-card")) {
        next.focus();
        selectAccount(next.dataset.username);
      }
    }
  });
  card.querySelector(".play-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    launchAccount(account.username);
  });

  return card;
}

// ── Server filter, summary, selected account ────────────────────────────────
let currentRegion = ""; // "" = every server
let currentTag = ""; // "" = no tag filter

function renderRegionFilters() {
  const el = document.getElementById("regionFilters");
  if (!el) return;
  const counts = new Map();
  for (const a of allAccounts) {
    const r = (a.region || "").toLowerCase();
    if (r) counts.set(r, (counts.get(r) || 0) + 1);
  }
  if (currentRegion && !counts.has(currentRegion)) currentRegion = "";
  // One server: nothing to filter by.
  el.hidden = counts.size < 2;
  const chips = [["", `All ${allAccounts.length}`]];
  for (const [r, n] of [...counts].sort()) chips.push([r, `${r.toUpperCase()} ${n}`]);
  el.innerHTML = chips
    .map(([r, text]) => {
      const on = r === currentRegion;
      return `<button class="region-chip${on ? " active" : ""}" data-region="${escapeHtml(r)}" aria-pressed="${on}">${escapeHtml(text)}</button>`;
    })
    .join("");
}

function initRegionFilters() {
  document.getElementById("regionFilters")?.addEventListener("click", (e) => {
    const chip = e.target.closest(".region-chip");
    if (!chip) return;
    currentRegion = chip.dataset.region || "";
    renderAccounts();
  });
}

// Tag chips beside the server chips; hidden while no account has a tag.
function renderTagFilters() {
  const el = document.getElementById("tagFilters");
  if (!el) return;
  const tags = tagCounts(allAccounts);
  if (currentTag && !tags.some((t) => t.tag.toLowerCase() === currentTag)) currentTag = "";
  el.hidden = tags.length === 0;
  el.innerHTML = tags
    .map(({ tag, count }) => {
      const on = tag.toLowerCase() === currentTag;
      return `<button class="region-chip tag-chip${on ? " active" : ""}" data-tag="${escapeHtml(tag.toLowerCase())}" aria-pressed="${on}"><i class="fas fa-tag" aria-hidden="true"></i> ${escapeHtml(tag)} ${count}</button>`;
    })
    .join("");
}

function initTagFilters() {
  document.getElementById("tagFilters")?.addEventListener("click", (e) => {
    const chip = e.target.closest(".tag-chip");
    if (!chip) return;
    // A second click on the active tag clears the filter.
    currentTag = chip.dataset.tag === currentTag ? "" : chip.dataset.tag;
    renderAccounts();
  });
}

// Tags other accounts use, as chips under the form field; a click adds one.
function renderTagSuggestions() {
  const el = document.getElementById("tagSuggestions");
  const input = document.getElementById("newTags");
  if (!el || !input) return;
  const have = new Set(parseTags(input.value).map((t) => t.toLowerCase()));
  const tags = tagCounts(allAccounts).filter((t) => !have.has(t.tag.toLowerCase()));
  el.hidden = tags.length === 0;
  el.innerHTML = tags
    .map(({ tag }) => `<button type="button" class="region-chip tag-suggestion" data-tag="${escapeHtml(tag)}"><i class="fas fa-plus" aria-hidden="true"></i> ${escapeHtml(tag)}</button>`)
    .join("");
}

function initTagSuggestions() {
  const input = document.getElementById("newTags");
  document.getElementById("tagSuggestions")?.addEventListener("click", (e) => {
    const chip = e.target.closest(".tag-suggestion");
    if (!chip || !input) return;
    input.value = [...parseTags(input.value), chip.dataset.tag].join(", ");
    renderTagSuggestions();
  });
  input?.addEventListener("input", renderTagSuggestions);
}

// ── Overview ────────────────────────────────────────────────────────────
// Series colors follow the account (its place in your order), at most six
// lines; the table below lists every account.
const OVERVIEW_SERIES = 6;
const CHART_DAYS = 30;
let _overview = null; // { chart, accounts } for the hover layer

function overviewRows(histories, now) {
  return allAccounts.map((acc) => {
    const history = (acc.riotId && histories[acc.riotId.trim().toLowerCase()]) || [];
    const stats = getCachedStats(acc);
    return {
      acc,
      history,
      stats,
      week: weeklySummary(history, now),
      goal: acc.goalRank ? goalProgress(history, acc.goalRank) : null,
      warnings: accountWarnings(acc),
    };
  });
}

function overviewTile(label, value, sub = "") {
  return `<div class="overview-tile"><div class="overview-tile-label">${escapeHtml(label)}</div><div class="overview-tile-value">${escapeHtml(value)}</div>${sub ? `<div class="overview-tile-sub">${escapeHtml(sub)}</div>` : ""}</div>`;
}

function signed(n) {
  return n > 0 ? `+${n}` : String(n);
}

async function renderOverview() {
  const now = Date.now();
  const histories = (await window.electronAPI.getAllRankHistory()) || {};
  const rows = overviewRows(histories, now);

  // Tiles
  let wins = 0, losses = 0, lp = 0, counted = 0;
  for (const r of rows) {
    if (!r.week) continue;
    lp += r.week.lp;
    counted += 1;
    if (r.week.wins !== null) {
      wins += r.week.wins;
      losses += r.week.losses;
    }
  }
  const games = wins + losses;
  const attention = rows.filter((r) => r.warnings.some((w) => w.kind !== "inactive")).length;
  document.getElementById("overviewTiles").innerHTML =
    overviewTile("Ranked games this week", String(games), games ? `${wins} won, ${losses} lost (solo/duo)` : "solo/duo") +
    overviewTile("Ranked win rate", games ? `${Math.round((wins / games) * 100)}%` : "-", "solo/duo") +
    overviewTile("LP this week", counted ? signed(lp) : "-", counted ? `over ${plural(counted, "account")}` : "") +
    overviewTile("Need attention", String(attention), attention ? "decay or restriction" : "nothing to do");

  // Chart: the accounts in your order that have a rank saved, at most six.
  const svg = document.getElementById("overviewChart");
  const box = svg.viewBox.baseVal;
  const charted = rows.filter((r) => r.history.length).slice(0, OVERVIEW_SERIES);
  const from = now - CHART_DAYS * 86400000;
  const chart = rankChart(charted.map((r, i) => ({ key: i, history: r.history })), from, now, box.width, box.height, 10);
  const empty = !chart.series.length;
  document.getElementById("overviewChartEmpty").hidden = !empty;
  svg.style.display = empty ? "none" : "";
  const ticks = chart.ticks
    .map((t) => `<line class="overview-grid" x1="0" x2="${escapeHtml(box.width)}" y1="${t.y.toFixed(1)}" y2="${t.y.toFixed(1)}"></line>`)
    .join("");
  const lines = chart.series
    .map((s) => `<polyline class="overview-line series-${s.key + 1}" points="${s.points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}"></polyline>`)
    .join("");
  svg.innerHTML = ticks + lines + '<line id="overviewCross" class="overview-cross" y1="0" y2="240" x1="0" x2="0" visibility="hidden"></line>';
  // Tier names sit in HTML beside the chart, so they do not stretch with it.
  const wrap = svg.parentElement;
  wrap.querySelectorAll(".overview-tick").forEach((n) => n.remove());
  for (const t of chart.ticks) {
    const label = document.createElement("span");
    label.className = "overview-tick";
    label.style.top = `${(t.y / box.height) * 100}%`;
    label.textContent = t.tier;
    wrap.appendChild(label);
  }
  document.getElementById("overviewLegend").innerHTML = charted
    .map((r, i) => `<span class="overview-legend-item"><i class="series-dot series-${i + 1}"></i>${escapeHtml(r.acc.label || r.acc.riotId || r.acc.username)}</span>`)
    .join("");
  _overview = { chart, rows: charted, from, now, box };

  // Table: every account.
  document.getElementById("overviewTable").innerHTML =
    `<div class="overview-row overview-head"><span></span><span>Account</span><span>Rank</span><span>LP</span><span>Games</span><span>Goal</span><span></span></div>` +
    rows
      .map((r) => {
        // Without fresh stats, the last saved rank.
        const last = r.history[r.history.length - 1];
        const tier = r.stats?.tier || (last ? formatRankHistoryLabel(last) : "");
        const rankLp = r.stats?.lp || (last ? `${last.lp} LP` : "");
        const lpText = r.week ? signed(r.week.lp) : "-";
        const lpCls = r.week ? (r.week.lp > 0 ? "is-up" : r.week.lp < 0 ? "is-down" : "") : "";
        const gamesText = r.week && r.week.wins !== null ? `${r.week.wins}W ${r.week.losses}L` : "-";
        const goal = r.goal
          ? `<span class="overview-goal"><span class="overview-goal-bar"><span style="width:${escapeHtml(r.goal.pct)}%"></span></span>${escapeHtml(r.goal.reached ? "Reached" : r.goal.pct + "%")}</span>`
          : '<span class="overview-muted">-</span>';
        return `
        <button type="button" class="overview-row" data-username="${escapeHtml(r.acc.username)}">
            <span class="overview-emblem" data-tier="${escapeHtml(tier)}"></span>
            <span class="overview-name">${escapeHtml(r.acc.label || r.acc.username)}<span class="overview-sub">${escapeHtml(r.acc.riotId || "")}</span></span>
            <span class="overview-rank ${escapeHtml(tierClass(tier))}">${escapeHtml(tier || "Unknown")}${rankLp ? ` <span class="overview-muted">${escapeHtml(rankLp)}</span>` : ""}</span>
            <span class="overview-lp ${lpCls}">${escapeHtml(lpText)}</span>
            <span>${escapeHtml(gamesText)}</span>
            ${goal}
            <span class="overview-flags">${r.warnings.map(warningBadge).join("")}</span>
        </button>`;
      })
      .join("");
  document.querySelectorAll("#overviewTable .overview-emblem").forEach((el) => setTierEmblem(el, el.dataset.tier, ""));
}

// Crosshair and tooltip: every charted account's rank at the hovered day.
function overviewHover(e) {
  const tip = document.getElementById("overviewChartTip");
  const cross = document.getElementById("overviewCross");
  if (!_overview || !_overview.chart.series.length || !cross) return;
  const svg = document.getElementById("overviewChart");
  const rect = svg.getBoundingClientRect();
  const fx = (e.clientX - rect.left) / rect.width;
  const x = fx * _overview.box.width;
  const ts = _overview.from + fx * (_overview.now - _overview.from);
  cross.setAttribute("visibility", "visible");
  cross.setAttribute("x1", x.toFixed(1));
  cross.setAttribute("x2", x.toFixed(1));
  const lines = _overview.chart.series.map((s) => {
    const at = s.points.filter((p) => p.ts <= ts).pop() || s.points[0];
    const acc = _overview.rows[s.key].acc;
    return `<div class="overview-tip-row"><i class="series-dot series-${s.key + 1}"></i><span>${escapeHtml(acc.label || acc.username)}</span><b>${escapeHtml(scoreLabel(at.score))}</b></div>`;
  });
  tip.innerHTML = `<div class="overview-tip-date">${escapeHtml(new Date(ts).toLocaleDateString())}</div>${lines.join("")}`;
  tip.hidden = false;
  const left = Math.min(e.clientX - rect.left + 14, rect.width - tip.offsetWidth - 4);
  tip.style.left = `${Math.max(4, left)}px`;
}

function initOverview() {
  const svg = document.getElementById("overviewChart");
  svg?.addEventListener("mousemove", overviewHover);
  svg?.addEventListener("mouseleave", () => {
    document.getElementById("overviewChartTip").hidden = true;
    document.getElementById("overviewCross")?.setAttribute("visibility", "hidden");
  });
  // A row opens that account in the Accounts view.
  document.getElementById("overviewTable")?.addEventListener("click", (e) => {
    const row = e.target.closest(".overview-row[data-username]");
    if (!row) return;
    // A server, tag or search filter could hide the account in the list.
    currentRegion = "";
    currentTag = "";
    currentQuery = "";
    const search = document.getElementById("accountSearch");
    if (search) search.value = "";
    document.querySelector('.nav-btn[data-view="accountsView"]')?.click();
    renderAccounts();
    selectAccount(row.dataset.username);
  });
}

function renderAccountsSummary() {
  const el = document.getElementById("accountsSummary");
  if (!el) return;
  const n = allAccounts.length;
  if (!n) {
    el.textContent = "Save your League logins and switch between them in one click.";
    return;
  }
  const servers = new Set(
    allAccounts.map((a) => (a.region || "").toLowerCase()).filter(Boolean),
  ).size;
  const active = allAccounts.find((a) => a.username === activeAccountUsername);
  let text = `${plural(n, "account")}${servers > 1 ? ` on ${servers} servers` : ""}.`;
  if (active) text += ` ${active.label || active.username} is signed in.`;
  el.textContent = text;
}

function markSelectedRow() {
  for (const row of document.querySelectorAll("#accountsList .account-card")) {
    const on = row.dataset.username === _profileUsername;
    row.classList.toggle("is-selected", on);
    row.setAttribute("aria-current", on ? "true" : "false");
  }
}

// Keeps a visible account selected after the list changes: the current one
// if it is still shown, else the signed-in account, else the first.
function ensureSelection(visible) {
  if (!visible.length) {
    _profileUsername = null;
    document.getElementById("accountDetailBody").hidden = true;
    document.getElementById("accountDetailEmpty").hidden = false;
    return;
  }
  const current = visible.find((a) => a.username === _profileUsername);
  if (!current) {
    const pick = visible.find((a) => a.username === activeAccountUsername) || visible[0];
    selectAccount(pick.username);
    return;
  }
  // Same account: refresh label, notes and actions without refetching.
  markSelectedRow();
  updateDetailActions(current);
  const cached = getCachedStats(current);
  if (cached) populateProfileModal(current, cached);
}

function detailMeta(acc) {
  const region = (acc.region || "").toUpperCase();
  const id = acc.riotId || "No Riot ID yet";
  return region ? `${id}, ${region}` : id;
}

// LP within the division; apex tiers have no ceiling, so the bar is full.
function setLpBar(stats) {
  const bar = document.getElementById("profileSoloLpBar");
  if (!bar) return;
  const lp = parseInt(stats?.lp, 10);
  const apex = /master|grandmaster|challenger/i.test(stats?.tier || "");
  const pct = Number.isFinite(lp) ? (apex ? 100 : Math.max(0, Math.min(lp, 100))) : 0;
  bar.style.width = `${pct}%`;
  bar.className = `profile-lp-fill ${tierClass(stats?.tier)}`;
}

function updateDetailActions(acc) {
  const label = acc.label || acc.username;
  document.getElementById("profileLaunchLabel").textContent = `Play as ${label}`;
  document.getElementById("profileOpggBtn").hidden = !acc.riotId;
  const fav = document.getElementById("profileFavBtn");
  const isFav = !!acc.isFavourite;
  fav.classList.toggle("is-fav", isFav);
  fav.setAttribute("aria-pressed", String(isFav));
  fav.dataset.tooltip = isFav ? "Remove from favourites" : "Add to favourites";
  fav.setAttribute("aria-label", fav.dataset.tooltip);
}

function selectedAccount() {
  return allAccounts.find((a) => a.username === _profileUsername) || null;
}

function initAccountDetail() {
  const on = (id, fn) => document.getElementById(id).addEventListener("click", fn);
  on("profileLaunchBtn", () => {
    if (_profileUsername) launchAccount(_profileUsername);
  });
  on("profileEditBtn", () => {
    if (_profileUsername) editAccount(_profileUsername);
  });
  on("profileDeleteBtn", () => {
    if (_profileUsername) deleteAccount(_profileUsername);
  });
  on("profileCopyUserBtn", (e) => {
    const acc = selectedAccount();
    if (!acc) return;
    navigator.clipboard.writeText(acc.username);
    flashCopied(e.currentTarget);
  });
  on("profileCopyPassBtn", async (e) => {
    const btn = e.currentTarget;
    const acc = selectedAccount();
    if (!acc) return;
    const pw = await window.electronAPI.getAccountPassword(acc.username);
    if (pw) {
      navigator.clipboard.writeText(pw);
      flashCopied(btn);
    } else {
      showToast("Could not read the saved password", "error");
    }
  });
  on("profileOpggBtn", () => {
    const acc = selectedAccount();
    if (!acc) return;
    window.electronAPI.openOpgg(acc.region, acc.riotId).then((res) => {
      if (!res?.success) showToast("Could not open OP.GG. Check the server and Riot ID.", "error");
    });
  });
  on("profileFavBtn", async (e) => {
    const btn = e.currentTarget;
    const acc = selectedAccount();
    if (!acc || btn.dataset.saving) return;
    btn.dataset.saving = "1";
    const newFav = !acc.isFavourite;
    acc.isFavourite = newFav; // optimistic, reverted if saving fails
    updateDetailActions(acc);
    let res;
    try {
      res = await window.electronAPI.updateAccount({ username: acc.username, isFavourite: newFav });
    } catch (err) {
      res = { success: false, message: err.message };
    } finally {
      delete btn.dataset.saving;
    }
    if (res && res.success === false) {
      acc.isFavourite = !newFav;
      updateDetailActions(acc);
      showToast(res.message || "Could not save the favourite", "error");
      return;
    }
    renderAccounts();
  });
}

// Username of the card being dragged (module scope so renderAccounts can
// reset it: a re-render mid-drag detaches the card, and its dragend never
// reaches the list).
let _dragUsername = null;

function canReorder() {
  return currentSort === "default" && !currentQuery && !currentRegion && !currentTag;
}

function endDrag() {
  _dragUsername = null;
  document
    .querySelectorAll("#accountsList .dragging, #accountsList .drag-over")
    .forEach((el) => el.classList.remove("dragging", "drag-over"));
}

function initDragAndDrop() {
  const listEl = document.getElementById("accountsList");

  listEl.addEventListener("dragstart", (e) => {
    const card = e.target.closest(".account-card");
    if (!card) return;
    // Sorted or filtered lists have no stable order to drop into; without
    // preventDefault the card still showed a drag ghost that could not drop.
    if (!canReorder()) {
      e.preventDefault();
      return;
    }
    _dragUsername = card.dataset.username;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", card.dataset.username);
    requestAnimationFrame(() => card.classList.add("dragging"));
  });

  listEl.addEventListener("dragover", (e) => {
    if (!_dragUsername) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const card = e.target.closest(".account-card");
    if (!card || card.dataset.username === _dragUsername) return;
    listEl
      .querySelectorAll(".drag-over")
      .forEach((el) => el.classList.remove("drag-over"));
    card.classList.add("drag-over");
  });

  listEl.addEventListener("dragleave", (e) => {
    const card = e.target.closest(".account-card");
    // Only clear the highlight when the mouse actually leaves the card,
    // not when it enters a child element inside it.
    if (card && !card.contains(e.relatedTarget))
      card.classList.remove("drag-over");
  });

  listEl.addEventListener("drop", async (e) => {
    const srcUsername = _dragUsername;
    if (!srcUsername) return;
    e.preventDefault();
    endDrag();
    if (!canReorder()) return;
    const card = e.target.closest(".account-card");
    if (!card || card.dataset.username === srcUsername) return;

    const srcIdx = allAccounts.findIndex((a) => a.username === srcUsername);
    const tgtIdx = allAccounts.findIndex(
      (a) => a.username === card.dataset.username,
    );
    if (srcIdx === -1 || tgtIdx === -1) return;

    // Dropping on a card above puts the dragged card before it, on a card
    // below puts it after it (reorderList in ui-lib.js).
    allAccounts = reorderList(allAccounts, srcIdx, tgtIdx);
    renderAccounts();
    let res;
    try {
      res = await window.electronAPI.reorderAccounts(
        allAccounts.map((a) => a.username),
      );
    } catch (err) {
      res = { success: false, message: err.message };
    }
    if (!res?.success) {
      showToast(res?.message || "Could not save the new order", "error");
      loadAccounts(); // show the order that is actually saved
    }
  });

  // On document, not the list: a card detached by a re-render mid-drag
  // fires dragend on itself, outside the list.
  document.addEventListener("dragend", endDrag);
}

let _updateVersion = "";
let _updateState = ""; // 'downloading' | 'ready'

function showUpdateCard(version, state) {
  _updateVersion = version;
  _updateState = state;

  const card = document.getElementById("updateCard");
  const pill = document.getElementById("updatePill");
  const progSec = document.getElementById("updateProgressSection");
  const actions = document.getElementById("updateCardActions");
  const pillLbl = document.getElementById("updatePillLabel");

  document.getElementById("updateCardVersion").textContent = `v${version}`;

  if (state === "downloading") {
    progSec.style.display = "flex";
    actions.style.display = "none";
    pillLbl.textContent = "Downloading update…";
  } else {
    // ready to install
    progSec.style.display = "none";
    actions.style.display = "flex";
    document.getElementById("updateProgressBar").style.width = "100%";
    pillLbl.textContent = "Update ready — click to install";
  }

  pill.classList.remove("active");
  card.classList.remove("active");
  void card.offsetWidth; // force reflow so animation replays
  card.classList.add("active");
}

function updateDownloadProgress(percent) {
  document.getElementById("updateProgressBar").style.width = `${percent}%`;
  document.getElementById("updateProgressPct").textContent = `${percent}%`;
}

// Account Form View Functions
function openModal(account = null) {
  // Coming from the form itself (sidebar Add while editing) keeps the view
  // the form was first opened from.
  if (currentView !== "accountFormView") previousView = currentView;
  isEditing = false;

  if (account && account.username) {
    isEditing = true;
    document.getElementById("modalTitle").innerText = "Edit account";
    document.getElementById("newUsername").value = account.username;
    document.getElementById("newPassword").value = "";
    document.getElementById("newPassword").placeholder = "Unchanged";
    document.getElementById("newLabel").value = account.label || "";
    document.getElementById("newNotes").value = account.notes || "";
    document.getElementById("newRiotId").value = account.riotId || "";
    document.getElementById("newRegion").value = account.region || "";

    document.getElementById("appearOfflineToggle").checked =
      account.appearOffline || false;
    document.getElementById("autoSkinToggle").checked =
      account.autoSkinRandom || false;
    document.getElementById("minimizeOnLaunchToggle").checked =
      account.minimizeOnLaunch || false;
    document.getElementById("isFavouriteToggle").checked =
      account.isFavourite || false;
    document.getElementById("newCustomRank").value = account.customRank || "";
    document.getElementById("newGoalRank").value = account.goalRank || "";
    document.getElementById("newTags").value = account.tags || "";
    document.getElementById("newCustomAvatar").value =
      account.customAvatar || "";

    document.getElementById("newUsername").disabled = true;
  } else {
    isEditing = false;
    document.getElementById("modalTitle").innerText = "New account";
    document.getElementById("newUsername").value = "";
    document.getElementById("newPassword").value = "";
    document.getElementById("newPassword").placeholder = "Password";
    document.getElementById("newLabel").value = "";
    document.getElementById("newNotes").value = "";
    document.getElementById("newRiotId").value = "";
    document.getElementById("newRegion").value = "";

    document.getElementById("appearOfflineToggle").checked = false;
    document.getElementById("autoSkinToggle").checked = false;
    document.getElementById("minimizeOnLaunchToggle").checked = false;
    document.getElementById("isFavouriteToggle").checked = false;
    document.getElementById("newCustomRank").value = "";
    document.getElementById("newGoalRank").value = "";
    document.getElementById("newTags").value = "";
    document.getElementById("newCustomAvatar").value = "";

    document.getElementById("newUsername").disabled = false;

    // Most people keep accounts on one server — preselect the last one used.
    const lastRegion = allAccounts.map((a) => a.region).filter(Boolean).pop();
    if (lastRegion) document.getElementById("newRegion").value = lastRegion;
  }

  renderTagSuggestions();
  document.getElementById("passwordKeepHint").style.display = isEditing
    ? ""
    : "none";
  resetQuickAdd();

  // The form isn't a nav destination — don't leave the previous tab lit.
  document
    .querySelectorAll(".nav-btn")
    .forEach((b) => b.classList.remove("active"));
  showView("accountFormView");
  if (!isEditing) document.getElementById("quickAddInput").focus();
}

// ── Quick add (OP.GG / Riot API lookup) ─────────────────────────────────────

let quickAddProfile = null; // last successful lookup — seeds the stats cache on save
let _quickAddToken = 0;

function populateRegionSelects() {
  const opts = REGIONS.map(
    ([v, label]) => `<option value="${v}">${label}</option>`,
  ).join("");
  document.getElementById("newRegion").innerHTML =
    `<option value="" disabled>Select region…</option>${opts}`;
  document.getElementById("quickAddRegion").innerHTML = opts;
  document.getElementById("newGoalRank").innerHTML = goalRankOptions();
}

function resetQuickAdd() {
  _quickAddToken++;
  quickAddProfile = null;
  const input = document.getElementById("quickAddInput");
  input.value = isEditing ? document.getElementById("newRiotId").value : "";
  document.getElementById("quickAddResult").innerHTML = "";
  document.getElementById("quickAddResult").className = "quick-add-result";
  document.getElementById("quickAddTitle").textContent = isEditing
    ? "Link summoner"
    : "Quick add";
  document.getElementById("quickAddRegion").value =
    document.getElementById("newRegion").value || "euw";
  document.getElementById("quickAddClientBtn").style.display = lcuConnected
    ? ""
    : "none";
  setQuickAddBusy(false);
}

function setQuickAddBusy(busy) {
  const btn = document.getElementById("quickAddBtn");
  btn.disabled = busy;
  btn.innerHTML = busy ? '<i class="fas fa-spinner fa-spin"></i>' : "Find";
}

function renderQuickAddResult(p) {
  const el = document.getElementById("quickAddResult");
  el.className = "quick-add-result is-found";
  const tierName = (p.tier || "unranked").split(" ")[0].toLowerCase();
  const rankCls = TIER_ORDER[tierName] ? `rank-${tierName}` : "rank-unranked";
  const champs = championBadges(p)
    .map(
      (b) =>
        `<div class="mastery-badge" data-tooltip="${escapeHtml(b.tip)}">${b.icon ? `<img src="${escapeHtml(b.icon)}" alt="">` : ""}</div>`,
    )
    .join("");
  const [name, tag] = (p.riotId || "").split("#");
  el.innerHTML = `
      <div class="qa-icon-wrap">
          <img class="qa-icon" src="${escapeHtml(p.iconSrc || "assets/logo.png")}" alt="">
          ${p.level ? `<span class="qa-level">${escapeHtml(p.level)}</span>` : ""}
      </div>
      <div class="qa-main">
          <div class="qa-name">${escapeHtml(name)}<span class="qa-tag">#${escapeHtml(tag)}</span>
              <span class="region-badge">${escapeHtml((p.region || "").toUpperCase())}</span></div>
          <div class="qa-rank"><span class="${rankCls}">${escapeHtml(p.tier || "Unranked")}</span>${p.lp ? ` · ${escapeHtml(p.lp)}` : ""}${p.ratio ? `<span class="qa-wr">${escapeHtml(p.winLose)} · ${escapeHtml(p.ratio)}</span>` : ""}</div>
      </div>
      <div class="mastery-badges qa-champs">${champs}</div>
      <div class="qa-filled"><i class="fas fa-check"></i> Filled in</div>`;
  const img = el.querySelector(".qa-icon");
  img.addEventListener("error", () => (img.src = "assets/logo.png"));
}

function renderQuickAddError(message) {
  const el = document.getElementById("quickAddResult");
  el.className = "quick-add-result is-error";
  el.innerHTML = `<i class="fas fa-circle-exclamation"></i><span></span>`;
  el.querySelector("span").textContent = message;
}

async function quickAddFind() {
  const input = document.getElementById("quickAddInput").value.trim();
  if (!input) {
    document.getElementById("quickAddInput").focus();
    return;
  }
  const region = document.getElementById("quickAddRegion").value;
  const token = ++_quickAddToken;
  setQuickAddBusy(true);
  const resultEl = document.getElementById("quickAddResult");
  resultEl.className = "quick-add-result is-loading";
  resultEl.innerHTML = `<div class="qa-skeleton"></div><span>Looking up on OP.GG…</span>`;

  let res;
  try {
    res = await window.electronAPI.lookupSummoner(input, region);
  } catch (e) {
    res = { success: false, message: e.message };
  }
  if (token !== _quickAddToken) return; // superseded by a newer search / reset
  setQuickAddBusy(false);

  if (!res?.success) {
    quickAddProfile = null;
    renderQuickAddError(res?.message || "Lookup failed");
    return;
  }

  quickAddProfile = res;
  document.getElementById("quickAddRegion").value = res.region;
  document.getElementById("newRiotId").value = res.riotId;
  document.getElementById("newRegion").value = res.region;
  const labelEl = document.getElementById("newLabel");
  if (!labelEl.value.trim()) labelEl.value = res.gameName || res.riotId.split("#")[0];
  renderQuickAddResult(res);

  const userEl = document.getElementById("newUsername");
  if (!isEditing && !userEl.value) userEl.focus();
}

async function quickAddFromClient() {
  const btn = document.getElementById("quickAddClientBtn");
  btn.disabled = true;
  try {
    const res = await window.electronAPI.getClientSummoner();
    if (!res?.success) {
      renderQuickAddError(res?.message || "Could not read the League client");
      return;
    }
    const userEl = document.getElementById("newUsername");
    if (!isEditing && res.username && !userEl.value) userEl.value = res.username;
    document.getElementById("quickAddInput").value = res.riotId;
    if (res.region) document.getElementById("quickAddRegion").value = res.region;
    await quickAddFind();
  } finally {
    btn.disabled = false;
  }
}

function initQuickAdd() {
  populateRegionSelects();
  const input = document.getElementById("quickAddInput");
  document.getElementById("quickAddBtn").addEventListener("click", quickAddFind);
  document
    .getElementById("quickAddClientBtn")
    .addEventListener("click", quickAddFromClient);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      quickAddFind();
    }
  });
  // A pasted OP.GG link carries its own region — search straight away.
  input.addEventListener("paste", () => {
    setTimeout(() => {
      if (/op\.gg\//i.test(input.value)) quickAddFind();
    }, 0);
  });
  // Pasting an OP.GG link into the plain Riot ID field works too.
  document.getElementById("newRiotId").addEventListener("change", (e) => {
    if (/op\.gg\//i.test(e.target.value)) {
      input.value = e.target.value;
      quickAddFind();
    }
  });
}

function closeModal() {
  showView(previousView || "accountsView");
  // Re-highlight the correct nav button
  document.querySelectorAll(".nav-btn").forEach((b) => {
    b.classList.toggle(
      "active",
      b.dataset.view === (previousView || "accountsView"),
    );
  });
}

// One save at a time: a double click used to add the account and then
// report the second call as a duplicate on a form that was already closed.
let _saving = false;
async function saveAccount() {
  if (_saving) return;
  _saving = true;
  const btn = document.getElementById("saveAccountBtn");
  btn.disabled = true;
  try {
    await saveAccountForm();
  } finally {
    _saving = false;
    btn.disabled = false;
  }
}

async function saveAccountForm() {
  const username = document.getElementById("newUsername").value.trim();
  const password = document.getElementById("newPassword").value;
  const label = document.getElementById("newLabel").value.trim();
  const note = document.getElementById("newNotes").value;
  const riotId = document
    .getElementById("newRiotId")
    .value.trim()
    .replace(/\s*#\s*/, "#");
  const region = document.getElementById("newRegion").value;

  if (riotId && !/^[^#]+#[^#]+$/.test(riotId)) {
    showToast("Riot ID must look like Name#TAG (or use Quick add above)", "error");
    shakeModal();
    return;
  }

  const appearOffline = document.getElementById("appearOfflineToggle").checked;
  const autoSkin = document.getElementById("autoSkinToggle").checked;
  const minimizeOnLaunch = document.getElementById(
    "minimizeOnLaunchToggle",
  ).checked;

  if (!username) {
    showToast("Username required!", "error");
    shakeModal();
    return;
  }

  if (riotId && !region) {
    showToast("Select a region for this Riot ID!", "error");
    shakeModal();
    return;
  }

  const data = {
    username,
    password,
    label,
    notes: note,
    riotId,
    region,
    appearOffline,
    autoSkinRandom: autoSkin,
    minimizeOnLaunch,
    isFavourite: document.getElementById("isFavouriteToggle").checked,
    customRank: document.getElementById("newCustomRank").value.trim(),
    goalRank: document.getElementById("newGoalRank").value,
    tags: document.getElementById("newTags").value,
    customAvatar: document.getElementById("newCustomAvatar").value.trim(),
  };

  if (!isEditing && !password) {
    showToast("Password required for new account!", "error");
    shakeModal();
    return;
  }

  let res;
  try {
    res = isEditing
      ? await window.electronAPI.updateAccount(data)
      : await window.electronAPI.addAccount(data);
  } catch (e) {
    showToast("Error saving account: " + e.message, "error");
    shakeModal();
    return;
  }

  if (res?.success) {
    // Show the looked-up rank/icon immediately instead of refetching it.
    // Only when the form still holds the looked-up Riot ID and region: a
    // region changed after the lookup is a different summoner.
    const saved = { username, riotId, region };
    if (
      quickAddProfile &&
      statsKey(quickAddProfile) === statsKey(saved)
    ) {
      cacheStats(saved, quickAddProfile);
    } else {
      delete statsCache[username];
      delete statsFailures[username];
    }
    showToast(isEditing ? "Account updated!" : "Account added!", "success");
    closeModal();
    loadAccounts();
  } else {
    showToast("Error: " + (res?.message || "could not save"), "error");
    shakeModal();
  }
}

function flashCopied(btn) {
  if (!btn) return;
  const icon = btn.querySelector("i");
  const prev = icon.className;
  icon.className = "fas fa-check";
  btn.classList.add("copied");
  setTimeout(() => {
    icon.className = prev;
    btn.classList.remove("copied");
  }, 1500);
}

function shakeModal() {
  const view = document.getElementById("accountFormView");
  view.classList.add("shake");
  setTimeout(() => view.classList.remove("shake"), 500);
}

async function deleteAccount(username) {
  const ok = await showConfirm(
    "Delete Account",
    `Are you sure you want to delete ${username}? This action cannot be undone.`,
    "danger",
    "Delete",
  );
  if (ok) {
    let res;
    try {
      res = await window.electronAPI.deleteAccount(username);
    } catch (err) {
      res = { success: false, message: err.message };
    }
    if (res && res.success === false) {
      showToast(res.message || "Could not delete the account", "error");
      loadAccounts();
      return;
    }
    // Otherwise a new account later reusing this username would briefly
    // render with this deleted account's stale cached tier/icon/level.
    delete statsCache[username];
    delete statsFailures[username];
    showToast("Account deleted", "success");
    loadAccounts();
  }
}

async function editAccount(username) {
  const accounts = await window.electronAPI.getAccounts();
  const acc = accounts.find((a) => a.username === username);
  if (acc) {
    openModal(acc);
  }
}

// ── Launch overlay ────────────────────────────────────────────────────────
// The overlay is a dialog layer while a launch runs. On a failure, a wrong
// account or a step the user must finish in the Riot Client it stays open
// with Try Again and Close until the user picks one (the main process's
// later "clear" message no longer hides it).
let _launchAttention = false;
// Set after the user cancels, so late status messages of that launch do not
// bring the overlay back. Cleared when the next launch starts.
let _launchSuppressed = false;
let _launchDoneShown = false; // one success toast per launch
let _launchInfoUsername = null; // account of the launch in progress

// The highlighted (signed-in) account comes only from the main process
// (active-account-detected, get-current-account), never from a launch click.
function setActiveAccount(username) {
  if (activeAccountUsername === username) return;
  activeAccountUsername = username;
  renderAccounts();
}

function launchOverlayEl() {
  return document.getElementById("launchOverlay");
}

function showLaunchOverlay() {
  const overlay = launchOverlayEl();
  if (isLayerOpen(overlay)) return;
  openLayer(overlay, {
    onEscape: () => {
      if (_launchAttention) hideLaunchOverlay();
    },
    focus: "#cancelLaunchBtn",
  });
}

function setLaunchAttention(on) {
  _launchAttention = on;
  const retry = document.getElementById("retryLaunchBtn");
  retry.style.display = on ? "inline-flex" : "none";
  document.getElementById("cancelLaunchBtn").textContent = on ? "Close" : "Cancel";
  launchOverlayEl().classList.toggle("needs-attention", on);
  if (on) retry.focus();
}

function hideLaunchOverlay() {
  closeLayer(launchOverlayEl());
  setLaunchAttention(false);
  setTimeout(() => {
    if (!isLayerOpen(launchOverlayEl())) {
      document.getElementById("launchProgress").style.width = "0%";
    }
  }, 500);
}

function resetLaunchOverlay() {
  _launchSuppressed = false;
  _launchDoneShown = false;
  setLaunchAttention(false);
  document.getElementById("launchProgress").style.width = "0%";
  document.getElementById("launchStatus").textContent = "Preparing...";
}

// Shows a failure that ends the launch, with Try Again and Close.
function showLaunchFailure(message, toastType = "error") {
  document.getElementById("launchStatus").textContent = message;
  showLaunchOverlay();
  setLaunchAttention(true);
  showToast(message, toastType);
}

// login-status from the main process: { message, progress, error?, kind? }
// or null once the flow has ended (normalizeLoginStatus in ui-lib.js).
function handleLoginStatus(data) {
  const status = normalizeLoginStatus(data);
  if (status.clear) {
    isLaunching = false;
    if (!_launchAttention) hideLaunchOverlay();
    return;
  }
  if (_launchSuppressed) return;
  if (status.kind === "cancelled") {
    isLaunching = false;
    hideLaunchOverlay();
    return;
  }

  if (status.progress > 0) {
    document.getElementById("launchProgress").style.width = `${status.progress}%`;
  }
  if (needsLaunchAttention(status.kind)) {
    isLaunching = false;
    showLaunchFailure(
      status.message || "Login did not complete",
      status.kind === "needs-action" ? "info" : "error",
    );
    return;
  }
  document.getElementById("launchStatus").textContent = status.message;
  showLaunchOverlay();
  if (status.kind === "done") {
    if (!_launchDoneShown) {
      _launchDoneShown = true;
      showToast("League launched successfully!", "success");
    }
  }
}

async function cancelOrCloseLaunch() {
  if (_launchAttention) {
    hideLaunchOverlay(); // the launch already ended; this only dismisses it
    return;
  }
  hideLaunchOverlay();
  isLaunching = false;
  _launchToken++; // invalidate the in-flight launchAccount() call, if any
  _launchSuppressed = true;
  let res;
  try {
    res = await window.electronAPI.cancelLaunch();
  } catch (err) {
    res = { success: false, message: err.message };
  }
  if (!res?.success) {
    // The launch may still be running: let its next status show it again.
    _launchSuppressed = false;
    showToast(
      res?.message ? `Could not cancel: ${res.message}` : "Could not cancel the launch",
      "error",
    );
  }
}

async function launchAccount(username, options) {
  if (isLaunching) {
    // The overlay can be hidden (heads-up already dismissed) while the login
    // script still runs; say why the click does nothing.
    showToast("A launch is already in progress", "info");
    return;
  }
  isLaunching = true;
  lastLaunchedUsername = username;
  const myToken = ++_launchToken;
  resetLaunchOverlay();
  try {
    const res = options
      ? await window.electronAPI.launchAccount(username, options)
      : await window.electronAPI.launchAccount(username);
    // If Cancel was clicked (or a different launch started) while this was
    // in flight, _launchToken has moved on — applying this stale result
    // would overwrite the newer launch's UI state.
    if (myToken !== _launchToken) return;
    if (res?.busy) {
      // Another launch (tray, jump list) is running in the main process; its
      // status messages own the overlay and clear isLaunching at the end.
      showToast("A launch is already in progress", "info");
      return;
    }
    if (res?.cancelled) return;
    if (res?.locked) {
      isLaunching = false;
      lockAgain();
      return;
    }
    if (res?.needsConfirm) {
      // e.g. a game is running: relaunching would close it.
      isLaunching = false;
      const ok = await showConfirm(
        "Launch anyway?",
        res.message || "League is busy. Launching closes the running client.",
        "danger",
        "Launch",
      );
      if (ok) launchAccount(username, { confirmed: true });
      return;
    }
    if (!res?.success) {
      // Immediate failure (bad account/password) — no login-status stream
      // follows, so this is the only place that clears isLaunching.
      isLaunching = false;
      // reported: the main process already showed it through login-status.
      if (!res?.reported) showLaunchFailure(res?.message || "Launch failed.");
    }
    // On success isLaunching stays true: the login script can run for up to
    // ~150s after this call resolved; handleLoginStatus clears it at the end.
  } catch (e) {
    console.error(e);
    if (myToken !== _launchToken) return;
    isLaunching = false;
    showLaunchFailure(`Launch failed: ${e.message}`);
  }
}

// ─────────────────────────────────────────────
// Live View
// ─────────────────────────────────────────────

const QUEUE_NAMES = {
  420: "Ranked Solo/Duo",
  440: "Ranked Flex",
  450: "ARAM",
  400: "Normal Draft",
  430: "Normal Blind",
  900: "URF",
  1020: "One for All",
  1900: "URF",
  76: "URF",
  830: "Co-op vs AI",
  840: "Co-op vs AI",
  850: "Co-op vs AI",
  700: "Clash",
  600: "Blood Hunt",
  1400: "Ultimate Spellbook",
  1700: "Arena",
  1710: "Arena",
};

const PHASE_CONFIG = {
  None: { label: "Idle", cls: "gameflow-idle" },
  Lobby: { label: "In lobby", cls: "gameflow-lobby" },
  Matchmaking: { label: "In queue", cls: "gameflow-queue" },
  ReadyCheck: { label: "Match found", cls: "gameflow-ready" },
  ChampSelect: { label: "Champ select", cls: "gameflow-champselect" },
  InProgress: { label: "In game", cls: "gameflow-ingame" },
  WaitingForStats: { label: "After the game", cls: "gameflow-postgame" },
  PreEndOfGame: { label: "After the game", cls: "gameflow-postgame" },
  EndOfGame: { label: "After the game", cls: "gameflow-postgame" },
};

// null: no League client is connected ("Offline", not "Idle").
function updateGameflowBadge(phase) {
  const badge = document.getElementById("gameflowBadge");
  if (!badge) return;
  const cfg = phase == null
    ? { label: "Offline", cls: "gameflow-offline" }
    : PHASE_CONFIG[phase] || { label: phase, cls: "gameflow-idle" };
  badge.textContent = cfg.label;
  badge.className = `gameflow-badge ${cfg.cls}`;
}

function updateContextButtons(phase) {
  const bar = document.getElementById("ovActionBar");
  const dodgeBtn = document.getElementById("ovDodgeBtn");
  const acceptBtn = document.getElementById("ovAcceptBtn");
  if (!bar || !dodgeBtn || !acceptBtn) return;
  const showDodge = phase === "ChampSelect";
  const showAccept = phase === "ReadyCheck";
  dodgeBtn.style.display = showDodge ? "inline-flex" : "none";
  acceptBtn.style.display = showAccept ? "inline-flex" : "none";
  bar.style.display = showDodge || showAccept ? "flex" : "none";
}

// ── Lobby check ──────────────────────────────────────────────────────────────
// Ranks of the players around you, where the game shows their names: your
// party in the lobby, champion select of queues with visible names, and all
// ten players once the game runs. Ranked champion select hides names, and
// they stay hidden here (Riot policy).
const LOBBY_CHECK_PHASES = ["Lobby", "ChampSelect", "GameStart", "InProgress"];
const POSITION_NAMES = {
  TOP: "Top", JUNGLE: "Jungle", MIDDLE: "Mid", BOTTOM: "Bot", UTILITY: "Support",
  top: "Top", jungle: "Jungle", middle: "Mid", bottom: "Bot", utility: "Support",
};
let _lobbyCheck = null;
let _lobbyCheckGen = 0;
let _lobbyCheckTimer = null;
let _lobbyCheckTeamKey = "";
let _lobbyCheckRetries = 0;

// ── Champ select build (OP.GG runes and items) ────────────────────────────
let _buildChampion = 0;
let _buildPosition = null; // a position the player chose over the assigned one
let _buildTimer = null;
let _buildGen = 0;

function hideChampBuild() {
  clearTimeout(_buildTimer);
  _buildChampion = 0;
  _buildPosition = null;
  document.getElementById("ovBuild").hidden = true;
}

async function loadChampBuild() {
  const gen = ++_buildGen;
  const res = await window.electronAPI.getChampBuild(_buildPosition).catch(() => null);
  if (gen !== _buildGen) return;
  if (!res?.success) {
    // Outside champ select or before a hover there is nothing to show.
    if (!res?.waiting) return hideChampBuild();
    document.getElementById("ovBuild").hidden = true;
    return;
  }
  renderChampBuild(res);
}

function renderChampBuild(res) {
  const b = res.build;
  const el = document.getElementById("ovBuild");
  const icon = document.getElementById("ovBuildIcon");
  icon.src = res.icon || "assets/logo.png";
  document.getElementById("ovBuildTitle").textContent = res.champion;
  const where = b.mode === "aram" ? "ARAM" : { top: "Top", jungle: "Jungle", mid: "Mid", adc: "Bot", support: "Support" }[b.position] || "";
  document.getElementById("ovBuildSub").textContent = [where, b.runes?.winRate != null ? `${b.runes.winRate}% win rate` : "", "OP.GG"].filter(Boolean).join(", ");
  document.querySelectorAll("#ovBuildPositions .scale-btn").forEach((btn) => {
    const on = btn.dataset.position === b.position;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-pressed", String(on));
  });
  document.getElementById("ovBuildPositions").hidden = b.mode === "aram";

  const runes = document.getElementById("ovBuildRunes");
  runes.textContent = "";
  if (b.runes) {
    const head = document.createElement("div");
    head.className = "ov-build-label";
    head.textContent = `Runes: ${b.runes.primaryName || "Primary"} and ${b.runes.secondaryName || "secondary"}`;
    const list = document.createElement("div");
    list.className = "ov-build-rune-list";
    for (const name of b.runes.names) {
      const chip = document.createElement("span");
      chip.className = "ov-build-rune";
      chip.textContent = name;
      list.appendChild(chip);
    }
    runes.append(head, list);
  }

  const items = document.getElementById("ovBuildItems");
  const group = (label, ids) =>
    ids.length
      ? `<div class="ov-build-group"><div class="ov-build-label">${escapeHtml(label)}</div><div class="ov-build-item-row">${itemIcons(ids, res.version)}</div></div>`
      : "";
  items.innerHTML =
    group("Start", b.items.starter) + group("Boots", b.items.boots) + group("Core", b.items.core) + group("Later", b.items.late);
  document.getElementById("ovBuildNote").textContent = b.skills.length ? `Skill order ${b.skills.join(" > ")}` : "";
  document.getElementById("ovImportRunes").disabled = !b.runes;
  el.hidden = false;
  renderMatchupChips(res);
  loadDuo();
}

// ── Matchup and duo (champion select) ──────────────────────────────────────
let _matchupWith = null; // enemy champion key shown in the matchup
let _matchupGen = 0;
let _enemyKey = "";

function renderMatchupChips(res) {
  const wrap = document.getElementById("ovMatchup");
  const enemies = res.enemies || [];
  if (!enemies.length || res.build?.mode === "aram") {
    wrap.hidden = true;
    _matchupWith = null;
    return;
  }
  if (!_matchupWith || !enemies.some((e) => e.key === _matchupWith)) _matchupWith = res.laneOpponent || enemies[0].key;
  document.getElementById("ovMatchupChips").innerHTML = enemies
    .map((e) => `<button type="button" class="ov-matchup-chip" data-key="${escapeHtml(e.key)}" aria-pressed="${String(e.key === _matchupWith)}">${e.icon ? `<img src="${escapeHtml(e.icon)}" alt="">` : ""}${escapeHtml(e.name)}</button>`)
    .join("");
  wrap.hidden = false;
  loadMatchup();
}

async function loadMatchup() {
  const gen = ++_matchupGen;
  const body = document.getElementById("ovMatchupBody");
  body.innerHTML = '<span class="ov-matchup-sub">Loading the matchup from OP.GG...</span>';
  const res = await window.electronAPI.getMatchup(_matchupWith, _buildPosition).catch(() => null);
  if (gen !== _matchupGen) return;
  if (!res?.success) {
    body.innerHTML = `<span class="ov-matchup-sub">${escapeHtml(res?.message || "No matchup data")}</span>`;
    return;
  }
  const g = res.guide;
  const wrCls = g.winRate == null ? "" : g.winRate >= 50 ? "is-good" : "is-bad";
  const mine = res.mine ? `You: ${plural(res.mine.games, "game")}, ${res.mine.winRate}% won` : "";
  const items = [...g.items.starter, ...g.items.boots, ...g.items.core];
  const matchupLine = `${res.champion} against ${res.opponent}, ${Number(g.games || 0).toLocaleString()} games on OP.GG`;
  body.innerHTML = `
    <div class="ov-matchup-head">
        <span class="ov-matchup-wr ${wrCls}">${g.winRate == null ? "-" : escapeHtml(g.winRate + "%")}</span>
        <span class="ov-matchup-sub">${escapeHtml(matchupLine)}</span>
        ${mine ? `<span class="ov-matchup-sub">${escapeHtml(mine)}</span>` : ""}
    </div>
    ${g.runes ? `<div class="ov-matchup-line">Runes <b>${escapeHtml(g.runes.names.slice(0, 1).join(""))}</b> ${escapeHtml(g.runes.names.slice(1).join(", "))}</div>` : ""}
    ${items.length ? `<div class="ov-matchup-line">Items <span class="ov-build-item-row">${itemIcons(items, res.version)}</span></div>` : ""}
    ${g.spells.length || g.skills.length ? `<div class="ov-matchup-line">${g.spells.length ? `Spells <b>${escapeHtml(g.spells.join(" + "))}</b>` : ""}${g.skills.length ? ` Max <b>${escapeHtml(g.skills.join(" > "))}</b>` : ""}</div>` : ""}`;
}

async function loadDuo() {
  const el = document.getElementById("ovDuo");
  const res = await window.electronAPI.getDuoSynergy().catch(() => null);
  const d = res?.duo?.[0];
  if (!res?.success || !d) {
    el.hidden = true;
    return;
  }
  const where = { top: "top", jungle: "jungle", mid: "mid", adc: "bot", support: "support" }[d.position] || d.position;
  el.innerHTML = d.winRate != null
    ? `With your duo <b>${escapeHtml(d.champion)}</b> (${escapeHtml(where)}): ${escapeHtml(d.winRate + "%")} win rate together${d.rank ? `, #${escapeHtml(d.rank)} for ${escapeHtml(res.champion)}` : ""}.`
    : `Your duo's <b>${escapeHtml(d.champion)}</b> is not among the best partners for ${escapeHtml(res.champion)}${d.best.length ? ` (best: ${escapeHtml(d.best.join(", "))})` : ""}.`;
  el.hidden = false;
}

async function importChampBuild(what) {
  const btn = document.getElementById(what === "runes" ? "ovImportRunes" : "ovImportItems");
  btn.disabled = true;
  try {
    let res = await window.electronAPI.importChampBuild({ what, position: _buildPosition });
    if (res?.runes?.needsConfirm) {
      const ok = await showConfirm("Replace the current rune page?", "All your rune pages are in use. The page you have selected now is replaced by the OP.GG runes.", "warning", "Replace");
      if (!ok) return;
      res = await window.electronAPI.importChampBuild({ what, position: _buildPosition, replaceCurrent: true });
    }
    const part = what === "runes" ? res?.runes : res?.items;
    if (part?.success) showToast(`${what === "runes" ? "Rune page" : "Item set"} "${part.name}" added to the client`, "success");
    else showToast(part?.message || res?.message || "Import failed", "error");
  } finally {
    btn.disabled = false;
  }
}

function initChampBuild() {
  document.getElementById("ovImportRunes")?.addEventListener("click", () => importChampBuild("runes"));
  document.getElementById("ovImportItems")?.addEventListener("click", () => importChampBuild("items"));
  document.getElementById("ovMatchupChips")?.addEventListener("click", (e) => {
    const chip = e.target.closest(".ov-matchup-chip");
    if (!chip) return;
    _matchupWith = chip.dataset.key;
    document.querySelectorAll("#ovMatchupChips .ov-matchup-chip").forEach((c) => c.setAttribute("aria-pressed", String(c === chip)));
    loadMatchup();
  });
  document.getElementById("ovBuildPositions")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".scale-btn");
    if (!btn) return;
    _buildPosition = btn.dataset.position;
    loadChampBuild();
  });
  window.electronAPI.onChampSelectEnd?.(hideChampBuild);
  window.electronAPI.onBuildImported?.((r) => {
    if (r.error) return showToast(`No build for ${r.champion}: ${r.error}`, "error");
    const done = [r.runes?.success && "runes", r.items?.success && "item set"].filter(Boolean);
    if (done.length) showToast(`Imported ${done.join(" and ")} for ${r.champion}`, "success");
    if (r.runes?.needsConfirm) showToast("All rune pages are in use: open Live to replace the current page.", "info");
  });
}

function hideLobbyCheck() {
  clearTimeout(_lobbyCheckTimer);
  _lobbyCheck = null;
  _lobbyCheckTeamKey = "";
  document.getElementById("ovPlayers").hidden = true;
}

async function loadLobbyCheck() {
  const gen = ++_lobbyCheckGen;
  const res = await window.electronAPI.getLobbyCheck().catch(() => null);
  if (gen !== _lobbyCheckGen) return;
  if (!res?.connected || !LOBBY_CHECK_PHASES.includes(res.phase)) return hideLobbyCheck();
  // The game publishes its player list a few seconds into loading.
  if (!res.players.length && (res.phase === "InProgress" || res.phase === "GameStart") && _lobbyCheckRetries < 6) {
    _lobbyCheckRetries++;
    clearTimeout(_lobbyCheckTimer);
    _lobbyCheckTimer = setTimeout(loadLobbyCheck, 8000);
  } else if (res.players.length) {
    _lobbyCheckRetries = 0;
  }
  _lobbyCheck = res;
  renderLobbyCheck(res);
}

function lobbyPlayerRow(p) {
  const row = document.createElement("div");
  row.className = `ov-player${p.isSelf ? " is-self" : ""}${p.hidden ? " is-hidden" : ""}`;
  const src = p.hidden ? "" : tierEmblemSrc(p.tier);
  // Names, champions and ranks come from the client or OP.GG: textContent only.
  row.innerHTML = `
      ${src ? `<img class="ov-player-emblem" src="${src}" alt="">` : '<span class="ov-player-emblem is-empty"></span>'}
      <div class="ov-player-name"><span class="ov-player-game"></span><span class="ov-player-tag"></span>
        <div class="ov-player-sub"></div></div>
      <div class="ov-player-rank"></div>
      <div class="ov-player-wr"></div>`;
  const sub = [p.isSelf ? "You" : "", p.champion || "", POSITION_NAMES[p.position] || ""].filter(Boolean).join(", ");
  if (p.hidden) {
    row.querySelector(".ov-player-game").textContent = "Hidden player";
    row.querySelector(".ov-player-sub").textContent = POSITION_NAMES[p.position] || "";
    return row;
  }
  row.querySelector(".ov-player-game").textContent = p.gameName;
  row.querySelector(".ov-player-tag").textContent = p.tagLine ? `#${p.tagLine}` : "";
  row.querySelector(".ov-player-sub").textContent = sub;
  const rankEl = row.querySelector(".ov-player-rank");
  rankEl.textContent = p.failed ? "Not found" : [p.tier || "Unranked", p.lp].filter(Boolean).join(" ");
  rankEl.className = `ov-player-rank ${p.failed ? "rank-unranked" : tierClass((p.tier || "").split(" ")[0])}`;
  row.querySelector(".ov-player-wr").textContent = p.ratio ? `${p.ratio} WR` : "";
  return row;
}

function renderLobbyCheck(res) {
  const box = document.getElementById("ovPlayers");
  const mine = res.players.filter((p) => p.team !== "enemy");
  const enemy = res.players.filter((p) => p.team === "enemy");
  if (!res.players.length) {
    box.hidden = res.phase === "Lobby";
  } else {
    box.hidden = false;
  }
  const inGame = res.phase === "InProgress" || res.phase === "GameStart";
  document.getElementById("ovPlayersTitle").textContent =
    res.phase === "Lobby" ? "Your party" : inGame ? "Your team" : "Champion select";
  const hidden = res.players.some((p) => p.hidden);
  document.getElementById("ovPlayersNote").textContent = hidden
    ? "Ranked champion select hides names. Ranks show once the game starts."
    : !res.players.length && inGame ? "Waiting for the game to load the players." : "";
  const fill = (el, list) => {
    el.innerHTML = "";
    list.forEach((p) => el.appendChild(lobbyPlayerRow(p)));
  };
  fill(document.getElementById("ovPlayersMine"), mine);
  fill(document.getElementById("ovPlayersEnemy"), enemy);
  document.getElementById("ovPlayersEnemyWrap").hidden = !enemy.length;
  document.getElementById("ovPlayersOpgg").hidden = !res.players.some((p) => !p.hidden && p.tagLine);
}

function setLcuOffline() {
  hideLobbyCheck();
  document.getElementById("lcuOffline").style.display = "";
  document.getElementById("lcuOnline").style.display = "none";
  updateGameflowBadge(null);
  _lastGameflowPhase = null;
  // If the client disconnects mid-queue/game, loadLiveView()'s own cleanup
  // branch (phase !== Matchmaking/InProgress) never runs — clear here too,
  // otherwise these keep ticking forever after the client closes/crashes.
  stopLiveTimers();
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// "GOLD", "Gold" or "Gold II" -> "rank-gold". Full tier text ("Diamond II")
// used to fall through to rank-unranked, so the account panel showed every
// rank and its LP bar in grey.
function tierClass(tier) {
  const t = String(tier || "").trim().toLowerCase().split(/\s+/)[0];
  return TIERS.includes(t) ? `rank-${t}` : "rank-unranked";
}

// ── Live view refresh ─────────────────────────────────────────────────────
let _queueTimerInterval = null;
let _gameTimerInterval = null;
let _liveGen = 0; // newest loadLiveView call; older results are dropped
let _gameflowSeq = 0; // bumped by every gameflow event
let _lastGameflowPhase = null;
let _liveRefreshTimer = null;
// Phases can flip quickly (ready check declined -> queue again): one reload
// after things settle instead of one per event.
const LIVE_REFRESH_DEBOUNCE_MS = 500;

function stopLiveTimers() {
  clearInterval(_queueTimerInterval);
  clearInterval(_gameTimerInterval);
  _queueTimerInterval = null;
  _gameTimerInterval = null;
}

// ── Today's session ─────────────────────────────────────────────────────────
let _sessionHintShownFor = 0; // newest game the break toast was shown for

async function loadSession() {
  const card = document.getElementById("sessionCard");
  const s = await window.electronAPI.getSession().catch(() => null);
  if (!s?.connected || s.locked || !s.games?.length) {
    card.hidden = true;
    return;
  }
  document.getElementById("sessionGames").textContent = plural(s.games.length, "game");
  document.getElementById("sessionRecord").textContent = `${s.wins}W ${s.losses}L${s.streak && s.streak.count > 1 ? `, ${s.streak.count} ${s.streak.win ? "wins" : "losses"} in a row` : ""}`;
  const lpEl = document.getElementById("sessionLp");
  lpEl.textContent = s.lp == null ? "" : `${s.lp > 0 ? "+" : ""}${s.lp} LP`;
  lpEl.className = `session-lp${s.lp > 0 ? " is-up" : s.lp < 0 ? " is-down" : ""}`;
  const version = s.version || "";
  document.getElementById("sessionStrip").innerHTML = [...s.games]
    .reverse()
    .map((g) => {
      const tip = `${g.win ? "Win" : "Loss"}, ${g.champion || "?"}, ${g.queue}`;
      const img = g.champion && version ? `<img src="https://ddragon.leagueoflegends.com/cdn/${escapeHtml(version)}/img/champion/${escapeHtml(g.champion)}.png" alt="">` : "";
      return `<span class="session-dot ${g.win ? "is-win" : "is-loss"}" data-tooltip="${escapeHtml(tip)}">${img}</span>`;
    })
    .join("");
  const hint = document.getElementById("sessionHint");
  hint.hidden = !s.pauseHint;
  hint.textContent = s.pauseHint ? `${s.streak.count} losses in a row. A short break before the next game often helps.` : "";
  card.hidden = false;
  // Once per new loss streak game, also as a message (the window may be hidden).
  if (s.pauseHint && s.games[0].ts !== _sessionHintShownFor) {
    _sessionHintShownFor = s.games[0].ts;
    showToast(hint.textContent, "info");
  }
}

function handleGameflowEvent(phase) {
  _gameflowSeq++;
  // The game's result shows up in the client's history shortly after it ends.
  if (phase === "EndOfGame" || (phase === "None" && _lastGameflowPhase === "EndOfGame")) setTimeout(loadSession, 4000);
  _lastGameflowPhase = phase;
  updateGameflowBadge(phase);
  updateContextButtons(phase);
  if (phase !== "Matchmaking") {
    clearInterval(_queueTimerInterval);
    _queueTimerInterval = null;
  }
  if (phase !== "InProgress") {
    clearInterval(_gameTimerInterval);
    _gameTimerInterval = null;
  }
  // The context panel, ranked LP and history follow the phase while the
  // view is visible; opening the view later loads it anyway.
  if (currentView === "liveView") {
    clearTimeout(_liveRefreshTimer);
    _liveRefreshTimer = setTimeout(loadLiveView, LIVE_REFRESH_DEBOUNCE_MS);
  }
}

async function loadLiveView() {
  loadSession();
  const gen = ++_liveGen;
  const seqAtStart = _gameflowSeq;
  let data;
  try {
    data = await window.electronAPI.getLcuOverview();
  } catch (err) {
    console.error("[Live]", err);
    return;
  }
  if (gen !== _liveGen) return; // a newer load started meanwhile
  if (!data?.connected) {
    setLcuOffline();
    return;
  }

  document.getElementById("lcuOffline").style.display = "none";
  document.getElementById("lcuOnline").style.display = "";

  const {
    summoner,
    ranked,
    gameflow,
    matches,
    mastery,
    honor,
    ddragonVersion,
    idToNameMap,
  } = data;

  // ── Summoner banner ────────────────────────────────────────────────────────
  if (summoner) {
    document.getElementById("ovName").textContent =
      summoner.displayName || summoner.gameName || summoner.internalName || "—";
    document.getElementById("ovLevel").textContent =
      summoner.summonerLevel || "?";
    const iconId = summoner.profileIconId;
    if (iconId)
      document.getElementById("ovIcon").src =
        `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/profileicon/${iconId}.png`;
  }

  // Honor badge
  const honorBadge = document.getElementById("ovHonorBadge");
  if (honor?.honorLevel > 0) {
    honorBadge.innerHTML = `<i class="fas fa-star" aria-hidden="true"></i> Honor ${escapeHtml(honor.honorLevel)}`;
    honorBadge.style.display = "";
  } else {
    honorBadge.style.display = "none";
  }

  // ── Ranked stats ───────────────────────────────────────────────────────────
  const soloData =
    ranked?.RANKED_SOLO_5x5 ||
    ranked?.queues?.find?.((q) => q.queueType === "RANKED_SOLO_5x5");
  const flexData =
    ranked?.RANKED_FLEX_SR ||
    ranked?.queues?.find?.((q) => q.queueType === "RANKED_FLEX_SR");

  function fillRanked(qd, ids, emblemId, primaryBadgeId) {
    const tierEl = document.getElementById(ids.tier);
    const lpEl = document.getElementById(ids.lp);
    const barEl = ids.lpBar ? document.getElementById(ids.lpBar) : null;
    const recEl = document.getElementById(ids.record);
    const emblemEl = document.getElementById(emblemId);
    const primary = primaryBadgeId
      ? document.getElementById(primaryBadgeId)
      : null;

    const unranked =
      !qd || !qd.tier || qd.tier === "NONE" || qd.tier === "UNRANKED";
    if (unranked) {
      if (tierEl) {
        tierEl.textContent = "Unranked";
        tierEl.className = "ov-ranked-tier rank-unranked";
      }
      if (lpEl) lpEl.textContent = "—";
      if (barEl) barEl.style.width = "0%";
      if (recEl) recEl.textContent = "—";
      if (emblemEl) emblemEl.textContent = "—";
      if (primary) {
        primary.textContent = "Unranked";
        primary.className = "summoner-banner-rank rank-unranked";
      }
      return;
    }
    const t = cap(qd.tier),
      div = qd.division || "";
    const tierStr = `${t} ${div}`.trim();
    const rawLp = qd.leaguePoints ?? 0;
    const lpStr = `${rawLp} LP`;
    const w = qd.wins || 0,
      l = qd.losses || 0;
    const wr = w + l > 0 ? ` · ${Math.round((w / (w + l)) * 100)}% WR` : "";
    const cls = tierClass(qd.tier);
    const isApex = ["MASTER", "GRANDMASTER", "CHALLENGER"].includes(
      qd.tier.toUpperCase(),
    );
    if (tierEl) {
      tierEl.textContent = tierStr;
      tierEl.className = `ov-ranked-tier ${cls}`;
    }
    if (lpEl) lpEl.textContent = lpStr;
    if (barEl) barEl.style.width = isApex ? "100%" : `${Math.min(rawLp, 100)}%`;
    if (recEl) recEl.textContent = `${w}W / ${l}L${wr}`;
    if (emblemEl) setTierEmblem(emblemEl, qd.tier, "?");
    if (primary) {
      primary.textContent = `${tierStr} · ${lpStr}`;
      primary.className = `summoner-banner-rank ${cls}`;
    }
  }

  fillRanked(
    soloData,
    {
      tier: "ovSoloTier",
      lp: "ovSoloLP",
      lpBar: "ovSoloLpBar",
      record: "ovSoloRecord",
    },
    "ovSoloEmblem",
    "ovPrimaryRank",
  );
  fillRanked(
    flexData,
    {
      tier: "ovFlexTier",
      lp: "ovFlexLP",
      lpBar: "ovFlexLpBar",
      record: "ovFlexRecord",
    },
    "ovFlexEmblem",
    null,
  );

  // ── Gameflow ───────────────────────────────────────────────────────────────
  // A gameflow event that arrived while this overview was loading is newer
  // than the phase in it: keep the event's badge and leave the context to
  // the refresh that event scheduled.
  const phaseChanged = _gameflowSeq !== seqAtStart;
  if (gameflow && !phaseChanged) {
    _lastGameflowPhase = gameflow;
    updateGameflowBadge(gameflow);
    updateContextButtons(gameflow);
  }

  // ── Context panel (lobby / queue / in-game) ────────────────────────────────
  const ctxEl = document.getElementById("ovContext");
  const ctxLobby = document.getElementById("ovCtxLobby");
  const ctxQueue = document.getElementById("ovCtxQueue");
  const ctxGame = document.getElementById("ovCtxGame");
  [ctxLobby, ctxQueue, ctxGame].forEach(
    (el) => el && (el.style.display = "none"),
  );
  // Timers of the previous phase stop here, whatever the new phase is; they
  // only start while the Live view is visible.
  stopLiveTimers();
  const visible = currentView === "liveView";
  const phase = phaseChanged ? null : gameflow;

  if (phase === "Lobby" && data.lobby) {
    ctxEl.style.display = "";
    ctxLobby.style.display = "";
    const qName = QUEUE_NAMES[data.lobby.gameConfig?.queueId] || "Custom Game";
    document.getElementById("ovCtxLobbyQueue").textContent = qName;
    const membersEl = document.getElementById("ovCtxLobbyMembers");
    membersEl.innerHTML = "";
    (data.lobby.members || []).forEach((m) => {
      const chip = document.createElement("span");
      chip.className = "ov-ctx-member-chip";
      chip.textContent = lobbyMemberLabel(m);
      membersEl.appendChild(chip);
    });
  } else if (phase === "Matchmaking" && data.queueSearch) {
    ctxEl.style.display = "";
    ctxQueue.style.display = "";
    const qName = QUEUE_NAMES[data.queueSearch.queueId] || "Queue";
    document.getElementById("ovCtxQueueName").textContent = qName;
    const elapsed = Math.floor(data.queueSearch.timeInQueue || 0);
    const timerEl = document.getElementById("ovCtxQueueTimer");
    timerEl.textContent = formatDuration(elapsed);
    // tick the timer locally
    let secs = elapsed;
    if (visible) {
      _queueTimerInterval = setInterval(() => {
        timerEl.textContent = formatDuration(++secs);
      }, 1000);
    }
    const est = data.queueSearch.estimatedQueueTime;
    document.getElementById("ovCtxQueueEst").textContent = est
      ? `Estimated wait: ~${Math.round(est)}s`
      : "";
  } else if (phase === "InProgress") {
    ctxEl.style.display = "";
    ctxGame.style.display = "";
    const gameTimerEl = document.getElementById("ovCtxGameTimer");
    const live = data.liveGame;
    if (live?.gameTime != null) {
      let secs = Math.floor(live.gameTime);
      gameTimerEl.textContent = formatDuration(secs);
      if (visible) {
        _gameTimerInterval = setInterval(() => {
          gameTimerEl.textContent = formatDuration(++secs);
        }, 1000);
      }
    } else {
      gameTimerEl.textContent = "";
    }
    // HP does not depend on the game clock being available.
    const hp = live?.championStats;
    document.getElementById("ovCtxGameStats").textContent =
      hp?.currentHealth != null
        ? `${Math.round(hp.currentHealth)} / ${Math.round(hp.maxHealth ?? 0)} HP`
        : "";
  } else {
    ctxEl.style.display = "none";
  }
  if (LOBBY_CHECK_PHASES.includes(phase)) loadLobbyCheck();
  else hideLobbyCheck();
  if (phase === "ChampSelect") loadChampBuild();
  else hideChampBuild();

  // ── Champion mastery ───────────────────────────────────────────────────────
  const masteryEl = document.getElementById("ovMastery");
  masteryEl.innerHTML = "";
  const masteryList = Array.isArray(mastery) ? mastery : [];
  if (masteryList.length === 0) {
    masteryEl.innerHTML = `<div class="empty-state" style="padding:30px 0;grid-column:1/-1">
            <div class="empty-icon"><i class="fas fa-hat-wizard"></i></div>
            <p>No mastery data found.</p></div>`;
  } else {
    for (const m of masteryList) {
      const champKey = idToNameMap?.[m.championId];
      const iconSrc = champKey
        ? `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/champion/${champKey}.png`
        : "assets/logo.png";
      const lv = m.championLevel || 0;
      const lvCls =
        lv >= 10
          ? "mastery-lv10"
          : lv >= 7
            ? "mastery-lv7"
            : lv >= 6
              ? "mastery-lv6"
              : lv >= 5
                ? "mastery-lv5"
                : "mastery-lv-other";
      const pts =
        m.championPoints >= 1000
          ? (m.championPoints / 1000).toFixed(1) + "k"
          : (m.championPoints || 0).toString();
      const card = document.createElement("div");
      card.className = "mastery-card";
      card.innerHTML = `
                <img class="mastery-champ-icon" src="${escapeHtml(iconSrc)}" data-fallback="logo">
                <div class="mastery-champ-name">${escapeHtml(champKey || "Unknown")}</div>
                <div class="mastery-level-badge ${lvCls}">M${lv}</div>
                <div class="mastery-pts">${pts}</div>
            `;
      masteryEl.appendChild(card);
    }
  }

  // ── Match history ──────────────────────────────────────────────────────────
  const matchesEl = document.getElementById("ovMatches");
  matchesEl.innerHTML = "";
  const games = Array.isArray(matches) ? matches : [];
  const myAccountId = summoner?.accountId;
  const myPuuid = summoner?.puuid;

  if (games.length === 0) {
    matchesEl.innerHTML = `<div class="empty-state" style="padding:40px 0">
            <div class="empty-icon"><i class="fas fa-gamepad"></i></div>
            <p>No recent games found.</p></div>`;
  } else {
    // Summary row
    let totalW = 0,
      totalL = 0,
      totalK = 0,
      totalD = 0,
      totalA = 0,
      counted = 0;
    const summaryEl = document.createElement("div");
    summaryEl.className = "match-summary-row";
    matchesEl.appendChild(summaryEl);

    for (const game of games) {
      let myPId = null;
      const identity = game.participantIdentities?.find(
        (pi) =>
          pi.player?.puuid === myPuuid ||
          pi.player?.currentAccountId === myAccountId ||
          pi.player?.accountId === myAccountId,
      );
      if (identity) myPId = identity.participantId;
      const participant = myPId
        ? game.participants?.find((p) => p.participantId === myPId)
        : game.participants?.[0];
      if (!participant) continue;

      const s = participant.stats || {};
      const win = s.win === true;
      const k = s.kills || 0,
        d = s.deaths || 0,
        a = s.assists || 0;
      const cs = (s.totalMinionsKilled || 0) + (s.neutralMinionsKilled || 0);
      const dur = game.gameDuration ? formatDuration(game.gameDuration) : "—";
      const csMin =
        game.gameDuration > 0
          ? (cs / (game.gameDuration / 60)).toFixed(1)
          : null;
      const queue = QUEUE_NAMES[game.queueId] || "Custom";
      if (win) totalW++;
      else totalL++;
      totalK += k;
      totalD += d;
      totalA += a;
      counted++;

      const champKey = idToNameMap?.[participant.championId];
      const champSrc = champKey
        ? `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/champion/${champKey}.png`
        : "assets/logo.png";

      // Items (slots 0-6, 6 = trinket)
      const itemSlots = [
        s.item0,
        s.item1,
        s.item2,
        s.item3,
        s.item4,
        s.item5,
        s.item6,
      ];
      const itemsHtml = itemSlots
        .map((id) =>
          id
            ? `<img class="match-item-icon" src="https://ddragon.leagueoflegends.com/cdn/${escapeHtml(ddragonVersion)}/img/item/${escapeHtml(id)}.png" data-fallback="hide">`
            : `<span class="match-item-icon empty"></span>`,
        )
        .join("");

      // Multi-kill badge
      const mk = s.largestMultiKill || 0;
      const mkLabels = ["", "", "Double", "Triple", "Quadra", "Penta"];
      const mkHtml =
        mk >= 2
          ? `<span class="match-multikill ${mk >= 5 ? "penta" : ""}">${mkLabels[mk] || mk + "x"} Kill</span>`
          : "";

      // Vision + damage
      const vs = s.visionScore != null ? `${s.visionScore} VS` : "";
      const dmg = s.totalDamageDealtToChampions
        ? (s.totalDamageDealtToChampions >= 1000
            ? (s.totalDamageDealtToChampions / 1000).toFixed(1) + "k"
            : s.totalDamageDealtToChampions) + " dmg"
        : "";

      const item = document.createElement("div");
      item.className = `match-item ${win ? "win" : "loss"}`;
      item.innerHTML = `
                <img class="match-champ-icon" src="${escapeHtml(champSrc)}" data-fallback="logo">
                <span class="match-result-badge">${win ? "Win" : "Loss"}</span>
                <div class="match-main">
                    <div class="match-kda-row">
                        <span class="match-kda">${k} / <span class="kda-d">${d}</span> / ${a}</span>
                        ${mkHtml}
                    </div>
                    <div class="match-sub">
                        <span>${cs} CS${csMin ? ` (${csMin}/m)` : ""}</span>
                        ${vs ? `<span class="match-sub-sep">·</span><span>${vs}</span>` : ""}
                        ${dmg ? `<span class="match-sub-sep">·</span><span>${dmg}</span>` : ""}
                    </div>
                    <div class="match-items">${itemsHtml}</div>
                </div>
                <div class="match-right">
                    <span class="match-queue">${escapeHtml(queue)}</span>
                    <span class="match-duration">${dur}</span>
                </div>
            `;
      matchesEl.appendChild(item);
    }

    if (counted > 0) {
      const avgK = (totalK / counted).toFixed(1);
      const avgD = (totalD / counted).toFixed(1);
      const avgA = (totalA / counted).toFixed(1);
      const wr = Math.round((totalW / counted) * 100);
      summaryEl.innerHTML = `
                <span class="ms-stat ${totalW > totalL ? "ms-win" : "ms-loss"}">${totalW}W ${totalL}L — ${wr}% WR</span>
                <span class="ms-sep">·</span>
                <span class="ms-stat">Avg ${avgK} / ${avgD} / ${avgA}</span>
            `;
    }
  }
}

function cap(str) {
  if (!str) return "";
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

// ═══════════════════════════════════════════════════════════════════════════
// Stat Viewer — champion base stats (RPG-style sheet) & item gold efficiency
// ═══════════════════════════════════════════════════════════════════════════
let statsViewInitialized = false;
let statsChampList = null;
let statsItemList = null;
let currentStatsChamp = null; // { champ, fullData }
let currentStatsLevel = 1;
let currentStatsItemId = null;
let _statsChampToken = 0; // newest champion click; older loads are dropped
// Data Dragon can be unreachable at start; the main process keeps retrying
// in the background, so an empty list is asked for again at these delays
// while the Stat Viewer is open (and on every open).
const STATS_LIST_RETRY_MS = [5000, 15000, 45000];
let _statsChampRetry = null;
let _statsItemRetry = null;

function initStatsView() {
  if (statsViewInitialized) {
    // Lists that were empty last time (offline start) are asked for again.
    if (!statsChampList?.length) loadStatsChamps();
    if (!statsItemList?.length) loadStatsItems();
    return;
  }
  statsViewInitialized = true;

  document.querySelectorAll(".stats-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document
        .querySelectorAll(".stats-tab")
        .forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      document
        .querySelectorAll(".stats-tab-panel")
        .forEach((p) => p.classList.remove("active"));
      document.getElementById(tab.dataset.statsTab).classList.add("active");
    });
  });

  document.getElementById("statsChampSearch").addEventListener("input", (e) => {
    renderStatsChampGrid(e.target.value);
  });
  document.getElementById("statsItemSearch").addEventListener("input", (e) => {
    renderStatsItemGrid(e.target.value);
  });

  loadStatsChamps();
  loadStatsItems();
}

// "Could not load" state with a Retry button, for an empty champion/item list.
function renderStatsListUnavailable(grid, what, onRetry) {
  grid.innerHTML = `<div class="stats-empty stats-unavailable"><p></p><button type="button" class="action-btn">Retry</button></div>`;
  grid.querySelector("p").textContent = `Could not load ${what} from Data Dragon yet. Check your connection; the app keeps trying.`;
  grid.querySelector("button").addEventListener("click", onRetry);
}

// Calls load() until it reports a non-empty list, at STATS_LIST_RETRY_MS.
function scheduleStatsListRetry(attempt, load, setTimer) {
  const delay = STATS_LIST_RETRY_MS[attempt];
  if (delay === undefined) return;
  setTimer(setTimeout(async () => {
    if (currentView !== "statsView") return; // the next open asks again
    if (!(await load())) scheduleStatsListRetry(attempt + 1, load, setTimer);
  }, delay));
}

// ── Champions ────────────────────────────────────────────────────────────────

// Returns true when a non-empty list is shown. An empty answer is never
// cached (champListCache stays null), so the next call asks again.
async function fetchStatsChamps() {
  if (!champListCache?.length) {
    const list = await window.electronAPI.getChampionList().catch(() => null);
    if (Array.isArray(list) && list.length) champListCache = list;
  }
  statsChampList = champListCache;
  const grid = document.getElementById("statsChampGrid");
  if (!statsChampList?.length) {
    document.getElementById("statsChampCount").textContent = "";
    renderStatsListUnavailable(grid, "champions", () => loadStatsChamps());
    return false;
  }
  renderStatsChampGrid(document.getElementById("statsChampSearch").value);
  return true;
}

async function loadStatsChamps() {
  clearTimeout(_statsChampRetry);
  if (!(await fetchStatsChamps())) {
    scheduleStatsListRetry(0, fetchStatsChamps, (t) => (_statsChampRetry = t));
  }
}

function renderStatsChampGrid(query) {
  const grid = document.getElementById("statsChampGrid");
  if (!statsChampList?.length) return;
  grid.innerHTML = "";
  const q = (query || "").trim().toLowerCase();
  const list = q
    ? statsChampList.filter((c) => c.name.toLowerCase().includes(q))
    : statsChampList;

  const count = document.getElementById("statsChampCount");
  if (count) count.textContent = list.length;

  list.forEach((champ) => {
    const item = document.createElement("div");
    item.className =
      "stats-grid-item" +
      (currentStatsChamp?.champ.key === champ.key ? " selected" : "");
    const img = document.createElement("img");
    img.src = champ.iconUrl;
    img.alt = champ.name;
    img.loading = "lazy";
    img.decoding = "async";
    img.onerror = () => {
      img.style.display = "none";
    };
    const span = document.createElement("span");
    span.textContent = champ.name;
    item.appendChild(img);
    item.appendChild(span);
    item.addEventListener("click", () => selectStatsChampion(champ));
    grid.appendChild(item);
  });
}

async function selectStatsChampion(champ) {
  const token = ++_statsChampToken;
  const detail = document.getElementById("statsChampDetail");
  detail.innerHTML = `
        <div class="stats-empty">
            <div class="empty-icon"><i class="fas fa-spinner fa-spin"></i></div>
            <p>Loading ${escapeHtml(champ.name)}…</p>
        </div>`;

  const fullData = await window.electronAPI
    .getChampionFullData(champ.key)
    .catch(() => null);
  // A later click won while this one loaded: its result is not shown.
  if (token !== _statsChampToken) return;
  if (!fullData) {
    currentStatsChamp = null; // the grid must not keep the old selection
    renderStatsChampGrid(document.getElementById("statsChampSearch").value);
    detail.innerHTML = `
            <div class="stats-empty">
                <div class="empty-icon"><i class="fas fa-triangle-exclamation"></i></div>
                <p>No stat data available for ${escapeHtml(champ.name)}.</p>
            </div>`;
    return;
  }

  currentStatsLevel = 1;
  currentStatsChamp = { champ, fullData };
  renderStatsChampGrid(document.getElementById("statsChampSearch").value);
  renderStatsChampDetail();
}

const INFO_BARS = [
  { key: "attack", label: "Attack", icon: "fa-khanda" },
  { key: "defense", label: "Defense", icon: "fa-shield-halved" },
  { key: "magic", label: "Magic", icon: "fa-wand-sparkles" },
  { key: "difficulty", label: "Difficulty", icon: "fa-brain" },
];

// Stat cards are grouped under these headers to give the sheet a clearer
// visual hierarchy than one flat grid of equally-weighted numbers.
const STAT_GROUPS = [
  { key: "vitality", title: "Vitality", icon: "fa-heart" },
  { key: "offense", title: "Offense", icon: "fa-khanda" },
  { key: "defense", title: "Defense", icon: "fa-shield-halved" },
  { key: "mobility", title: "Mobility", icon: "fa-shoe-prints" },
];

function updateSliderFill(slider) {
  const min = Number(slider.min),
    max = Number(slider.max),
    val = Number(slider.value);
  slider.style.setProperty("--pct", `${((val - min) / (max - min)) * 100}%`);
}

// The stat cards for one level; `id` ties each value to its element so a
// level change only rewrites the numbers (growStat in ui-lib.js).
function computeStatCards(fullData, level) {
  const { partype, stats } = fullData;
  const hasResource =
    (stats.mp > 0 || stats.mpperlevel > 0) && partype && partype !== "None";
  const as = attackSpeedAt(stats.attackspeed, stats.attackspeedperlevel, level, fullData.attackSpeedRatio);
  return [
    { id: "hp", group: "vitality", icon: "fa-heart", label: "Health", primary: true,
      value: Math.round(growStat(stats.hp, stats.hpperlevel, level)) },
    { id: "hpregen", group: "vitality", icon: "fa-heart-pulse", label: "HP Regen / 5s",
      value: growStat(stats.hpregen, stats.hpregenperlevel, level).toFixed(1) },
    ...(hasResource
      ? [
          { id: "mp", group: "vitality", icon: "fa-droplet", label: partype,
            value: Math.round(growStat(stats.mp, stats.mpperlevel, level)) },
          { id: "mpregen", group: "vitality", icon: "fa-arrow-rotate-left", label: `${partype} Regen / 5s`,
            value: growStat(stats.mpregen, stats.mpregenperlevel, level).toFixed(1) },
        ]
      : []),
    { id: "ad", group: "offense", icon: "fa-gavel", label: "Attack Damage", primary: true,
      value: growStat(stats.attackdamage, stats.attackdamageperlevel, level).toFixed(1) },
    { id: "as", group: "offense", icon: "fa-bolt", label: "Attack Speed",
      value: `${as.toFixed(3)} / sec` },
    { id: "crit", group: "offense", icon: "fa-star", label: "Crit Chance",
      value: `${Math.round((stats.crit || 0) + (stats.critperlevel || 0) * (level - 1))}%` },
    { id: "armor", group: "defense", icon: "fa-shield-halved", label: "Armor", primary: true,
      value: growStat(stats.armor, stats.armorperlevel, level).toFixed(1) },
    { id: "mr", group: "defense", icon: "fa-hat-wizard", label: "Magic Resist",
      value: growStat(stats.spellblock, stats.spellblockperlevel, level).toFixed(1) },
    { id: "ms", group: "mobility", icon: "fa-shoe-prints", label: "Move Speed", primary: true,
      value: Math.round(stats.movespeed) },
    { id: "range", group: "mobility", icon: "fa-crosshairs", label: "Attack Range",
      value: Math.round(stats.attackrange) },
  ];
}

// Builds the sheet once per champion. The level slider only updates the
// numbers: rebuilding it on every input destroyed the slider being dragged
// and dropped keyboard focus after one arrow press.
function renderStatsChampDetail() {
  const { champ, fullData } = currentStatsChamp;
  const { title, tags, info } = fullData;
  const level = currentStatsLevel;
  const statCards = computeStatCards(fullData, level);

  const detail = document.getElementById("statsChampDetail");
  detail.innerHTML = `
        <div class="champ-detail-header">
            <img class="champ-detail-icon" src="${escapeHtml(champ.iconUrl)}" data-fallback="hide">
            <div class="champ-detail-info">
                <div class="champ-detail-name">${escapeHtml(champ.name)}</div>
                <div class="champ-detail-title">${escapeHtml(title || "")}</div>
                <div class="champ-tags">
                    ${(tags || []).map((t) => `<span class="champ-tag">${escapeHtml(t)}</span>`).join("")}
                </div>
            </div>
        </div>

        <div class="info-bars">
            ${INFO_BARS.map(
              (b) => `
                <div class="info-bar-row">
                    <span class="info-bar-label"><i class="fas ${escapeHtml(b.icon)}"></i> ${escapeHtml(b.label)}</span>
                    <div class="info-bar-track"><div class="info-bar-fill" style="width:${((Number(info?.[b.key]) || 0) / 10) * 100}%"></div></div>
                    <span class="info-bar-val">${escapeHtml(info?.[b.key] ?? "—")}/10</span>
                </div>
            `,
            ).join("")}
        </div>

        <div class="level-slider-row">
            <label for="statsLevelSlider">Level</label>
            <span class="level-slider-end">1</span>
            <input type="range" id="statsLevelSlider" min="1" max="18" step="1" value="${level}">
            <span class="level-slider-end">18</span>
            <span class="level-slider-val" aria-hidden="true">${level}</span>
        </div>

        ${STAT_GROUPS.map((g) => {
          const cards = statCards.filter((c) => c.group === g.key);
          if (!cards.length) return "";
          return `
                <div class="stat-group">
                    <div class="stat-group-header ${escapeHtml(g.key)}"><i class="fas ${escapeHtml(g.icon)}"></i> ${escapeHtml(g.title)}</div>
                    <div class="stat-cards-grid">
                        ${cards
                          .map(
                            (c) => `
                            <div class="stat-card ${escapeHtml(g.key)}${c.primary ? " primary" : ""}">
                                <div class="stat-card-icon"><i class="fas ${escapeHtml(c.icon)}"></i></div>
                                <div class="stat-card-label">${escapeHtml(c.label)}</div>
                                <div class="stat-card-value" data-stat="${escapeHtml(c.id)}">${escapeHtml(c.value)}</div>
                            </div>
                        `,
                          )
                          .join("")}
                    </div>
                </div>
            `;
        }).join("")}
        ${fullData.attackSpeedRatio ? "" : `<p class="stats-note">The attack speed ratio could not be loaded, so attack speed per level uses the base value; for a few champions the real value differs slightly.</p>`}
    `;

  const slider = document.getElementById("statsLevelSlider");
  updateSliderFill(slider);
  slider.addEventListener("input", (e) => {
    currentStatsLevel = parseInt(e.target.value, 10) || 1;
    updateStatsChampValues();
  });
}

function updateStatsChampValues() {
  if (!currentStatsChamp) return;
  const detail = document.getElementById("statsChampDetail");
  const level = currentStatsLevel;
  for (const card of computeStatCards(currentStatsChamp.fullData, level)) {
    const el = detail.querySelector(`.stat-card-value[data-stat="${card.id}"]`);
    if (el) el.textContent = card.value;
  }
  detail.querySelector(".level-slider-val").textContent = level;
  const slider = document.getElementById("statsLevelSlider");
  if (slider) updateSliderFill(slider);
}

// ── Items ────────────────────────────────────────────────────────────────────

// Returns true when a non-empty list is shown; an empty one is not kept.
async function fetchStatsItems() {
  const list = await window.electronAPI.getItemList().catch(() => null);
  if (Array.isArray(list) && list.length) statsItemList = list;
  if (!statsItemList?.length) {
    document.getElementById("statsItemCount").textContent = "";
    renderStatsListUnavailable(
      document.getElementById("statsItemGrid"),
      "items",
      () => loadStatsItems(),
    );
    return false;
  }
  renderStatsItemGrid(document.getElementById("statsItemSearch").value);
  return true;
}

async function loadStatsItems() {
  clearTimeout(_statsItemRetry);
  if (!(await fetchStatsItems())) {
    scheduleStatsListRetry(0, fetchStatsItems, (t) => (_statsItemRetry = t));
  }
}

function renderStatsItemGrid(query) {
  const grid = document.getElementById("statsItemGrid");
  const count = document.getElementById("statsItemCount");
  if (!statsItemList?.length) return;
  const q = (query || "").trim().toLowerCase();
  const list = q
    ? statsItemList.filter((i) => i.name.toLowerCase().includes(q))
    : statsItemList;

  if (count) count.textContent = list.length;

  grid.innerHTML = "";
  list.forEach((item) => {
    const el = document.createElement("div");
    el.className =
      "stats-grid-item" + (currentStatsItemId === item.id ? " selected" : "");
    const img = document.createElement("img");
    img.src = item.icon;
    img.alt = item.name;
    img.loading = "lazy";
    img.decoding = "async";
    img.onerror = () => {
      img.style.display = "none";
    };
    const span = document.createElement("span");
    span.textContent = item.name;
    el.appendChild(img);
    el.appendChild(span);
    el.addEventListener("click", () => selectStatsItem(item));
    grid.appendChild(el);
  });
}

function effClass(pct) {
  if (pct >= 100) return "eff-good";
  if (pct >= 70) return "eff-ok";
  return "eff-low";
}

function selectStatsItem(item) {
  currentStatsItemId = item.id;
  renderStatsItemGrid(document.getElementById("statsItemSearch").value);

  const detail = document.getElementById("statsItemDetail");
  const pct = item.efficiency;

  const statRows = item.stats
    .map(
      (s) => `
        <div class="item-stat-row">
            <span class="item-stat-label">${escapeHtml(s.label)}</span>
            <span class="item-stat-value">+${escapeHtml(s.value)}${escapeHtml(s.unit)}</span>
            <span class="item-stat-gold">${escapeHtml(s.goldValue)}g</span>
        </div>
    `,
    )
    .join("");

  detail.innerHTML = `
        <div class="item-detail-header">
            <img class="item-detail-icon" src="${escapeHtml(item.icon)}" data-fallback="hide">
            <div class="item-detail-info">
                <div class="item-detail-name">${escapeHtml(item.name)}</div>
                <div class="item-gold-row">
                    <span class="gold-badge"><i class="fas fa-coins"></i> ${escapeHtml(item.gold.total)}</span>
                    ${item.gold.sell ? `<span class="gold-badge sell"><i class="fas fa-arrow-right-arrow-left"></i> ${escapeHtml(item.gold.sell)}</span>` : ""}
                </div>
                ${
                  item.tags.length
                    ? `
                    <div class="champ-tags item-tags">
                        ${item.tags.map((t) => `<span class="champ-tag">${escapeHtml(t)}</span>`).join("")}
                    </div>
                `
                    : ""
                }
            </div>
        </div>

        <div class="efficiency-block">
            <div class="efficiency-label-row">
                <span>Gold Efficiency</span>
                <span class="efficiency-pct ${effClass(pct)}">${escapeHtml(pct)}%${item.efficiencyIncomplete ? "+" : ""}</span>
            </div>
            <div class="efficiency-bar-track">
                <div class="efficiency-bar-fill ${effClass(pct)}" style="width:${Math.min(pct, 100)}%"></div>
            </div>
            <div class="efficiency-note">Based on stat value (${escapeHtml(item.statsGoldValue)}g) vs. item cost (${escapeHtml(item.gold.total)}g). Active/passive effects add value beyond raw stats.${item.efficiencyIncomplete ? " Some of its stats (such as adaptive force or gold per 10 seconds) have no gold value, so the real efficiency is higher." : ""}</div>
        </div>

        ${
          item.stats.length
            ? `
            <div class="item-stats-table">
                ${statRows}
            </div>
        `
            : ""
        }

        ${
          item.descriptionLines.length
            ? `
            <div class="item-description">
                ${item.descriptionLines
                  .map((l) => {
                    const isHeader = l.startsWith("@@") && l.endsWith("@@");
                    return `<div class="${isHeader ? "item-description-header" : "item-description-line"}"></div>`;
                  })
                  .join("")}
            </div>
        `
            : ""
        }
    `;

  // Description lines are inserted as text content to avoid any markup injection
  if (item.descriptionLines.length) {
    const lines = detail.querySelectorAll(
      ".item-description-header, .item-description-line",
    );
    item.descriptionLines.forEach((line, i) => {
      const isHeader = line.startsWith("@@") && line.endsWith("@@");
      lines[i].textContent = isHeader ? line.slice(2, -2) : line;
    });
  }
}

// Expose
window.launchAccount = launchAccount;
window.editAccount = editAccount;
window.deleteAccount = deleteAccount;
