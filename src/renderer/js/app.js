// --- State ---
let isEditing = false;
let currentView = "accountsView";
let previousView = "accountsView";
let selectedChampion = null; // { id, name, key, iconUrl } | null
let currentAutoLockName = ""; // raw saved name, used as fallback before list loads
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
      icon: "fas fa-gauge-high",
      title: "Faster and steadier",
      body: "The window opens without waiting on downloads, scrolling is lighter, LAN/LAS stats point at the right server, and a stale League lockfile no longer resets your Discord status every few seconds.",
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
  if (currentQuery) {
    const q = currentQuery.toLowerCase();
    list = list.filter(
      (a) =>
        (a.label || "").toLowerCase().includes(q) ||
        a.username.toLowerCase().includes(q) ||
        (a.riotId || "").toLowerCase().includes(q) ||
        (a.region || "").toLowerCase().includes(q),
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

// Vault state from the main process. Older main processes have no
// getVaultState; their config still says vaultEnabled.
async function readVaultState(config) {
  const api = window.electronAPI;
  if (typeof api.getVaultState === "function") {
    try {
      const s = await api.getVaultState();
      if (s && typeof s.enabled === "boolean") return { ...s, legacy: false };
    } catch {
      /* fall back to the config flag */
    }
  }
  return { enabled: !!config.vaultEnabled, unlocked: false, legacy: true };
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
  if (!vault.enabled) {
    // Older main processes treat a session as locked until told otherwise.
    if (vault.legacy) await api.unlockVault(null);
    return;
  }
  if (vault.unlocked) return;

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
  // riotApiKeySet from current main processes; older ones still sent the key.
  let keySet = !!(config.riotApiKeySet ?? config.riotApiKey);

  const render = (editing = false) => {
    input.value = "";
    savedRow.style.display = keySet && !editing ? "" : "none";
    editRow.style.display = !keySet || editing ? "" : "none";
    cancelBtn.style.display = keySet && editing ? "" : "none";
  };
  render();

  const store = async (key) => {
    try {
      return typeof api.setRiotApiKey === "function"
        ? await api.setRiotApiKey(key)
        : await api.setConfig({ riotApiKey: key });
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
async function exportAccountsFlow(btn) {
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
    res = await window.electronAPI.exportAccounts(values.passphrase);
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
        res.withoutPassword ? `${res.withoutPassword} without a password` : "",
      ].filter(Boolean);
      const skippedText = reasons.length
        ? `skipped: ${reasons.join(", ")}`
        : `${skipped} skipped`;
      const msg =
        added > 0
          ? `${plural(added, "account")} imported${skipped ? `, ${skippedText}` : ""}.`
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

// ── Compact / grid view ───────────────────────────────────────────────────────
let compactView = localStorage.getItem("llm-view") === "compact";

function applyViewMode() {
  const grid = document.getElementById("accountsList");
  const gridBtn = document.getElementById("viewGridBtn");
  const listBtn = document.getElementById("viewListBtn");
  if (!grid) return;
  grid.classList.toggle("compact", compactView);
  gridBtn?.classList.toggle("active", !compactView);
  listBtn?.classList.toggle("active", compactView);
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
  applyViewMode();
  initDragAndDrop();
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

  document.getElementById("viewGridBtn")?.addEventListener("click", () => {
    compactView = false;
    localStorage.setItem("llm-view", "grid");
    applyViewMode();
  });
  document.getElementById("viewListBtn")?.addEventListener("click", () => {
    compactView = true;
    localStorage.setItem("llm-view", "compact");
    applyViewMode();
  });

  // Version
  const version = await window.electronAPI.getVersion();
  const versionEl = document.getElementById("appVersion");
  if (versionEl) versionEl.innerText = `v${version}`;

  try {
    // Load config
    const config = await window.electronAPI.getConfig();

    // Vault lock — must resolve before anything is shown
    await initVault(config);

    // Patch notes — after the vault lock so it never covers/precedes it.
    // Shows once per version: missing/mismatched lastSeenPatchNotesVersion
    // means this version hasn't been acknowledged yet on this machine.
    if (PATCH_NOTES[version] && config.lastSeenPatchNotesVersion !== version) {
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

    bindSettingToggle("overlayEnabledToggle", "overlayEnabled", true);
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
    bindSettingToggle("discordRpcEnabledToggle", "discordRpcEnabled", true);

    // UI Scale — only apply if non-default; let ow-electron manage native DPI at 1.0
    const savedScale = config.uiScale ?? 1.0;
    if (savedScale !== 1.0) applyUiScale(savedScale);
    document.querySelectorAll(".scale-btn").forEach((btn) => {
      const s = parseFloat(btn.dataset.scale);
      if (s === savedScale) btn.classList.add("active");
      btn.addEventListener("click", async () => {
        document
          .querySelectorAll(".scale-btn")
          .forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        applyUiScale(s);
        await window.electronAPI.setConfig({ uiScale: s });
      });
    });

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
  window.electronAPI.onAccountsUpdated(() => {
    loadAccounts();
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
    });
  });

  // Window Controls
  document
    .getElementById("minimizeAppBtn")
    .addEventListener("click", () => window.electronAPI.minimizeWindow());
  document
    .getElementById("closeAppBtn")
    .addEventListener("click", () => window.electronAPI.closeWindow());

  // Profile modal
  document
    .getElementById("closeProfileModal")
    .addEventListener("click", closeProfileModal);
  document.getElementById("profileModal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeProfileModal(); // backdrop
  });
  document.getElementById("profileLaunchBtn").addEventListener("click", () => {
    closeProfileModal();
    if (_profileUsername) launchAccount(_profileUsername);
  });
  document.getElementById("profileEditBtn").addEventListener("click", () => {
    const u = _profileUsername;
    closeProfileModal();
    if (u) editAccount(u);
  });

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
  initChampionPicker();
  initQuickAdd();

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
  const champSearch = document.getElementById("champSearchOverlay");
  if (champSearch?.classList.contains("open")) {
    e.preventDefault();
    closeChampionSearch();
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

  const filtered = getFilteredSorted();

  if (allAccounts.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `
            <div class="empty-icon"><i class="fas fa-folder-open"></i></div>
            <p>No accounts added yet.</p>
            <button class="primary-btn empty-add-btn">Add Your First Account</button>
        `;
    empty
      .querySelector(".empty-add-btn")
      .addEventListener("click", () => openModal());
    listEl.appendChild(empty);
    return;
  }

  if (filtered.length === 0) {
    const noRes = document.createElement("div");
    noRes.className = "empty-state";
    noRes.innerHTML = `<div class="empty-icon"><i class="fas fa-search"></i></div><p>No accounts match your search.</p>`;
    listEl.appendChild(noRes);
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

  const rankEl = cardEl.querySelector(".rank");
  if (rankEl && !acc?.customRank) {
    const tierName = (stats.tier || "unranked").split(" ")[0].toLowerCase();
    const valid = [
      "iron",
      "bronze",
      "silver",
      "gold",
      "platinum",
      "emerald",
      "diamond",
      "master",
      "grandmaster",
      "challenger",
    ];
    const cls = valid.includes(tierName) ? `rank-${tierName}` : "rank-unranked";
    rankEl.className = `rank card-rank ${cls}`;
    const tierDisplay =
      stats.tier && stats.tier !== "Unranked" ? stats.tier : "Unranked";
    // Tier/LP can come from OP.GG or an imported backup's cached stats.
    rankEl.innerHTML = `<span>${escapeHtml(tierDisplay)}</span>${stats.lp ? ` • <span>${escapeHtml(stats.lp)}</span>` : ""}`;
  }
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

// Tier → Font Awesome icon, colored by the matching .rank-<tier> class.
const TIER_ICONS = {
  iron: "fa-shield-halved",
  bronze: "fa-shield-halved",
  silver: "fa-shield-halved",
  gold: "fa-shield-halved",
  platinum: "fa-shield-halved",
  emerald: "fa-shield-halved",
  diamond: "fa-gem",
  master: "fa-crown",
  grandmaster: "fa-crown",
  challenger: "fa-trophy",
};

function setTierEmblem(el, tier, fallback = "—") {
  const t = (tier || "").toLowerCase().split(" ")[0];
  const icon = TIER_ICONS[t];
  if (!icon) {
    el.textContent = fallback;
    el.removeAttribute("aria-label");
    return;
  }
  el.innerHTML = `<i class="fas ${icon} rank-${t}" aria-hidden="true"></i>`;
  el.setAttribute("aria-label", t);
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
  tierEl.textContent = tier || "Unranked";
  tierEl.className = `profile-rank-tier ${tierCls(tier)}`;
  lpEl.textContent = lp || "";
  recordEl.textContent = winLose
    ? `${winLose}${ratio ? "  ·  " + ratio : ""}`
    : "";
  setTierEmblem(emblemEl, tier);
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

  const meta = [acc.riotId, (acc.region || "").toUpperCase()]
    .filter(Boolean)
    .join("  ·  ");
  document.getElementById("profileMeta").textContent = meta;
  document.getElementById("profileLoading").style.display = "none";

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
    .map((m) => {
      const tip = `${m.win ? "Victory" : "Defeat"}${m.kda ? ` — ${m.kda} KDA` : ""}`;
      return `
        <div class="match-pill ${m.win ? "win" : "loss"}" data-tooltip="${escapeHtml(tip)}">
            ${m.championIcon ? `<img src="${escapeHtml(m.championIcon)}" alt="">` : ""}
        </div>
    `;
    })
    .join("");
}

async function showProfileModal(username) {
  _profileUsername = username;
  const acc = allAccounts.find((a) => a.username === username);
  if (!acc) return;

  const modal = document.getElementById("profileModal");
  openLayer(modal, { onEscape: closeProfileModal, focus: "#closeProfileModal" });

  // Rank history is a cheap local read (no rate limit / network concerns),
  // so it's always fetched fresh rather than reusing statsCache below.
  document.getElementById("profileRankHistoryWrap").style.display = "none";
  if (acc.riotId) {
    window.electronAPI.getRankHistory(acc.riotId).then((history) => {
      if (_profileUsername === username) renderRankSparkline(history);
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
    document.getElementById("profileMeta").textContent = [
      acc.riotId,
      (acc.region || "").toUpperCase(),
    ]
      .filter(Boolean)
      .join("  ·  ");
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

function closeProfileModal() {
  closeLayer(document.getElementById("profileModal"));
  _profileUsername = null;
}

function createAccountCard(account) {
  const card = document.createElement("div");
  const isActive = account.username === activeAccountUsername;
  card.className = `account-card${isActive ? " is-active" : ""}${account.isFavourite ? " is-favourite" : ""}`;
  card.dataset.username = account.username;
  card.draggable = canReorder();

  const defaultIcon = "assets/logo.png";
  const iconSrc = safeAvatarUrl(account.customAvatar) || defaultIcon;
  const region = (account.region || "").toUpperCase();
  const lastUsedText = timeAgo(account.lastUsed);
  const rankDisplay =
    account.customRank ||
    (account.riotId && account.region ? "Loading stats..." : "—");

  // customAvatar/customRank are free-text user input (and can arrive via an
  // imported .llem backup) — never interpolate them into innerHTML directly.
  // The icon src and rank text are set below via .src/.textContent instead.
  card.innerHTML = `
        <div class="account-info">
            <div class="summoner-icon-container">
                <img class="summoner-icon">
                <span class="level-badge" style="display:none">1</span>
                <button class="fav-btn${account.isFavourite ? " is-fav" : ""}" data-tooltip="${account.isFavourite ? "Remove from Favourites" : "Add to Favourites"}" aria-label="${account.isFavourite ? "Remove from Favourites" : "Add to Favourites"}" aria-pressed="${account.isFavourite ? "true" : "false"}"><i class="fas fa-star"></i></button>
            </div>
            <div class="text-content">
                <div class="card-title-row">
                    <h3 class="card-label"></h3>
                    ${isActive ? '<span class="active-dot" data-tooltip="Active account"></span>' : ""}
                    ${account.passwordOk === false ? '<span class="account-warning-badge" data-tooltip="Saved password could not be read (often after a Windows update) — click Edit and re-enter it"><i class="fas fa-triangle-exclamation"></i></span>' : ""}
                    ${account.honorFlagged ? '<span class="account-warning-badge" data-tooltip="Honor level has dropped since it was last observed"><i class="fas fa-arrow-trend-down"></i></span>' : ""}
                </div>
                <div class="card-meta">
                    <span class="username card-username"></span>
                    ${region ? `<span class="region-badge">${escapeHtml(region)}</span>` : ""}
                    ${lastUsedText ? `<span class="last-used">${lastUsedText}</span>` : ""}
                </div>
                <div class="rank card-rank"></div>
                <div class="mastery-badges card-mastery"></div>
                ${account.notes ? '<div class="notes-preview card-notes"></div>' : ""}
            </div>
        </div>
        <div class="card-actions">
            <button class="icon-btn info-btn"      data-tooltip="View Profile" aria-label="View Profile"><i class="fas fa-chart-bar"></i></button>
            ${account.riotId ? `<button class="icon-btn opgg-btn" data-tooltip="Open on OP.GG" aria-label="Open on OP.GG">${OPGG_ICON_SVG}</button>` : ""}
            <button class="icon-btn copy-user-btn" data-tooltip="Copy Username" aria-label="Copy Username"><i class="fas fa-user"></i></button>
            <button class="icon-btn copy-pass-btn" data-tooltip="Copy Password" aria-label="Copy Password"><i class="fas fa-key"></i></button>
            <button class="icon-btn play-btn"      data-tooltip="Launch" aria-label="Launch"><i class="fas fa-play"></i></button>
            <button class="icon-btn edit-btn"      data-tooltip="Edit" aria-label="Edit"><i class="fas fa-pen"></i></button>
            <button class="icon-btn delete-btn"    data-tooltip="Delete" aria-label="Delete" data-tooltip-pos="left"><i class="fas fa-trash"></i></button>
        </div>
    `;

  const iconEl = card.querySelector(".summoner-icon");
  iconEl.src = iconSrc;
  iconEl.addEventListener("error", () => {
    iconEl.src = defaultIcon;
  });

  card.querySelector(".card-rank").textContent = rankDisplay;
  card.querySelector(".card-label").textContent = account.label || "Account";
  card.querySelector(".card-username").textContent = account.username;
  if (account.notes)
    card.querySelector(".card-notes").textContent = account.notes;

  card.querySelector(".fav-btn").addEventListener("click", async (e) => {
    e.stopPropagation();
    const btn = e.currentTarget;
    if (btn.dataset.saving) return;
    btn.dataset.saving = "1";
    const newFav = !account.isFavourite;
    // Optimistic update — flip state immediately, revert if saving fails
    const applyFav = (fav) => {
      account.isFavourite = fav;
      const i = allAccounts.findIndex((a) => a.username === account.username);
      if (i !== -1) allAccounts[i].isFavourite = fav;
      btn.classList.toggle("is-fav", fav);
      // Tooltips read data-tooltip (a title attribute showed a second one).
      btn.dataset.tooltip = fav ? "Remove from Favourites" : "Add to Favourites";
      btn.setAttribute("aria-label", btn.dataset.tooltip);
      btn.setAttribute("aria-pressed", String(fav));
      card.classList.toggle("is-favourite", fav);
    };
    applyFav(newFav);
    let res;
    try {
      res = await window.electronAPI.updateAccount({
        username: account.username,
        isFavourite: newFav,
      });
    } catch (err) {
      res = { success: false, message: err.message };
    } finally {
      delete btn.dataset.saving;
    }
    if (res && res.success === false) {
      applyFav(!newFav);
      showToast(res.message || "Could not save favourite", "error");
      return;
    }
    if (currentSort === "favourite") renderAccounts();
  });

  card
    .querySelector(".account-info")
    .addEventListener("click", () => launchAccount(account.username));
  card.querySelector(".info-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    showProfileModal(account.username);
  });
  card.querySelector(".opgg-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    window.electronAPI.openOpgg(account.region, account.riotId).then((res) => {
      if (!res?.success)
        showToast(
          "Could not open OP.GG — check the region and Riot ID",
          "error",
        );
    });
  });
  card.querySelector(".copy-user-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(account.username);
    flashCopied(card.querySelector(".copy-user-btn"));
  });
  card.querySelector(".copy-pass-btn").addEventListener("click", async (e) => {
    e.stopPropagation();
    const pw = await window.electronAPI.getAccountPassword(account.username);
    if (pw) {
      navigator.clipboard.writeText(pw);
      flashCopied(card.querySelector(".copy-pass-btn"));
    } else {
      showToast("Could not retrieve password", "error");
    }
  });
  card.querySelector(".play-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    launchAccount(account.username);
  });
  card.querySelector(".edit-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    editAccount(account.username);
  });
  card.querySelector(".delete-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    deleteAccount(account.username);
  });

  return card;
}

// Username of the card being dragged (module scope so renderAccounts can
// reset it: a re-render mid-drag detaches the card, and its dragend never
// reaches the list).
let _dragUsername = null;

function canReorder() {
  return currentSort === "default" && !currentQuery;
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
  // Leaving the form through the sidebar skips closeModal(), so an open
  // champion search would otherwise cover the next form.
  closeChampionSearch();
  // Coming from the form itself (sidebar Add while editing) keeps the view
  // the form was first opened from.
  if (currentView !== "accountFormView") previousView = currentView;
  isEditing = false;

  if (account && account.username) {
    isEditing = true;
    document.getElementById("modalTitle").innerText = "Edit Account";
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
    setSelectedChampionByName(account.autoChampLock || "");
    document.getElementById("autoSpellsToggle").checked = false;
    document.getElementById("minimizeOnLaunchToggle").checked =
      account.minimizeOnLaunch || false;
    document.getElementById("isFavouriteToggle").checked =
      account.isFavourite || false;
    document.getElementById("newCustomRank").value = account.customRank || "";
    document.getElementById("newCustomAvatar").value =
      account.customAvatar || "";

    document.getElementById("newUsername").disabled = true;
  } else {
    isEditing = false;
    document.getElementById("modalTitle").innerText = "New Account";
    document.getElementById("newUsername").value = "";
    document.getElementById("newPassword").value = "";
    document.getElementById("newPassword").placeholder = "Password";
    document.getElementById("newLabel").value = "";
    document.getElementById("newNotes").value = "";
    document.getElementById("newRiotId").value = "";
    document.getElementById("newRegion").value = "";

    document.getElementById("appearOfflineToggle").checked = false;
    document.getElementById("autoSkinToggle").checked = false;
    setSelectedChampion(null);
    document.getElementById("autoSpellsToggle").checked = false;
    document.getElementById("minimizeOnLaunchToggle").checked = false;
    document.getElementById("isFavouriteToggle").checked = false;
    document.getElementById("newCustomRank").value = "";
    document.getElementById("newCustomAvatar").value = "";

    document.getElementById("newUsername").disabled = false;

    // Most people keep accounts on one server — preselect the last one used.
    const lastRegion = allAccounts.map((a) => a.region).filter(Boolean).pop();
    if (lastRegion) document.getElementById("newRegion").value = lastRegion;
  }

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
  closeChampionSearch();
  showView(previousView || "accountsView");
  // Re-highlight the correct nav button
  document.querySelectorAll(".nav-btn").forEach((b) => {
    b.classList.toggle(
      "active",
      b.dataset.view === (previousView || "accountsView"),
    );
  });
}

// ── Champion Picker ──────────────────────────────────────────────────────────

function setSelectedChampion(champ) {
  selectedChampion = champ;
  currentAutoLockName = champ ? champ.name : "";
  const preview = document.getElementById("champPickerPreview");
  const placeholder = document.getElementById("champPickerPlaceholder");
  preview
    .querySelectorAll("img, .champ-picker-name")
    .forEach((el) => el.remove());
  if (champ) {
    placeholder.style.display = "none";
    const img = document.createElement("img");
    img.src = champ.iconUrl;
    img.alt = champ.name;
    img.onerror = () => {
      img.style.display = "none";
    };
    const nameEl = document.createElement("span");
    nameEl.className = "champ-picker-name";
    nameEl.textContent = champ.name;
    preview.appendChild(img);
    preview.appendChild(nameEl);
  } else {
    placeholder.style.display = "";
  }
}

function setSelectedChampionByName(name) {
  currentAutoLockName = name || "";
  if (!name) {
    setSelectedChampion(null);
    return;
  }
  if (champListCache) {
    const found = champListCache.find(
      (c) => c.name.toLowerCase() === name.toLowerCase(),
    );
    if (found) {
      setSelectedChampion(found);
      return;
    }
  }
  // List not yet loaded — show name text only, no icon
  selectedChampion = null;
  const preview = document.getElementById("champPickerPreview");
  const placeholder = document.getElementById("champPickerPlaceholder");
  placeholder.style.display = "none";
  preview
    .querySelectorAll("img, .champ-picker-name")
    .forEach((el) => el.remove());
  const nameEl = document.createElement("span");
  nameEl.className = "champ-picker-name";
  nameEl.textContent = name;
  preview.appendChild(nameEl);
}

function openChampionSearch() {
  document.getElementById("champSearchOverlay").classList.add("open");
  const input = document.getElementById("champSearchInput");
  input.value = "";
  renderChampionGrid("");
  input.focus();
}

function closeChampionSearch() {
  document.getElementById("champSearchOverlay")?.classList.remove("open");
}

function renderChampionGrid(query) {
  const grid = document.getElementById("champSearchGrid");
  if (!champListCache || champListCache.length === 0) {
    grid.innerHTML =
      '<div style="color:var(--text-dim);font-size:12px;padding:16px;grid-column:1/-1;text-align:center;">Loading champions…</div>';
    return;
  }
  const q = query.toLowerCase().trim();
  const list = q
    ? champListCache.filter((c) => c.name.toLowerCase().includes(q))
    : champListCache;
  grid.innerHTML = "";
  if (list.length === 0) {
    grid.innerHTML =
      '<div style="color:var(--text-dim);font-size:12px;padding:16px;grid-column:1/-1;text-align:center;">No champions found</div>';
    return;
  }
  list.forEach((champ) => {
    const item = document.createElement("div");
    item.className =
      "champ-search-item" +
      (selectedChampion?.id === champ.id ? " selected" : "");
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
    item.addEventListener("click", () => {
      setSelectedChampion(champ);
      closeChampionSearch();
    });
    grid.appendChild(item);
  });
}

function initChampionPicker() {
  document
    .getElementById("champPickerOpenBtn")
    .addEventListener("click", async () => {
      if (!champListCache?.length) {
        document.getElementById("champSearchGrid").innerHTML =
          '<div style="color:var(--text-dim);font-size:12px;padding:16px;grid-column:1/-1;text-align:center;">Loading champions…</div>';
        document.getElementById("champSearchOverlay").classList.add("open");
        // An empty answer (Data Dragon unreachable) is not cached.
        const list = await window.electronAPI.getChampionList().catch(() => null);
        if (Array.isArray(list) && list.length) champListCache = list;
        // Resolve pending name now that the list is available
        if (champListCache && currentAutoLockName && !selectedChampion) {
          const found = champListCache.find(
            (c) => c.name.toLowerCase() === currentAutoLockName.toLowerCase(),
          );
          if (found) setSelectedChampion(found);
        }
      }
      openChampionSearch();
    });
  document
    .getElementById("champSearchBack")
    .addEventListener("click", closeChampionSearch);
  document
    .getElementById("champSearchClearSel")
    .addEventListener("click", () => {
      setSelectedChampion(null);
      closeChampionSearch();
    });
  document.getElementById("champSearchInput").addEventListener("input", (e) => {
    renderChampionGrid(e.target.value);
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
  const autoChampLock = selectedChampion
    ? selectedChampion.name
    : currentAutoLockName;
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
    autoChampLock,
    minimizeOnLaunch,
    isFavourite: document.getElementById("isFavouriteToggle").checked,
    customRank: document.getElementById("newCustomRank").value.trim(),
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
  Lobby: { label: "In Lobby", cls: "gameflow-lobby" },
  Matchmaking: { label: "In Queue", cls: "gameflow-queue" },
  ReadyCheck: { label: "Match Found!", cls: "gameflow-ready" },
  ChampSelect: { label: "Champ Select", cls: "gameflow-champselect" },
  InProgress: { label: "In Game", cls: "gameflow-ingame" },
  WaitingForStats: { label: "Post Game", cls: "gameflow-postgame" },
  PreEndOfGame: { label: "Post Game", cls: "gameflow-postgame" },
  EndOfGame: { label: "Post Game", cls: "gameflow-postgame" },
};

function updateGameflowBadge(phase) {
  const badge = document.getElementById("gameflowBadge");
  if (!badge) return;
  const cfg = PHASE_CONFIG[phase] || {
    label: phase || "Idle",
    cls: "gameflow-idle",
  };
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

function setLcuOffline() {
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

function tierClass(tier) {
  if (!tier) return "rank-unranked";
  const t = tier.toLowerCase();
  const valid = [
    "iron",
    "bronze",
    "silver",
    "gold",
    "platinum",
    "emerald",
    "diamond",
    "master",
    "grandmaster",
    "challenger",
  ];
  return valid.includes(t) ? `rank-${t}` : "rank-unranked";
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

function handleGameflowEvent(phase) {
  _gameflowSeq++;
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
                <span class="match-result-badge">${win ? "WIN" : "LOSS"}</span>
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
  const as = attackSpeedAt(stats.attackspeed, stats.attackspeedperlevel, level);
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
        <p class="stats-note">Attack speed uses the base value as the attack speed ratio; for a few champions the real level 18 value differs slightly.</p>
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
            <div class="efficiency-note">Based on stat value (${escapeHtml(item.statsGoldValue)}g) vs. item cost (${escapeHtml(item.gold.total)}g). Active/passive effects add value beyond raw stats.${item.efficiencyIncomplete ? " Some of its stats (such as ability haste, lethality or penetration) have no gold value in Data Dragon, so the real efficiency is higher." : ""}</div>
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
