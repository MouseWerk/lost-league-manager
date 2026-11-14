// Compatibility bridge: gives the existing renderer the `window.electronAPI`
// it was written against, backed by Tauri commands and events.
//
// Injected as an initialization script, so it runs before any page script and
// `src/renderer/` needs no changes at all — the same HTML/CSS/JS still runs
// under Electron if you go back to it.
(function () {
  const tauri = window.__TAURI__;
  if (!tauri) {
    console.error("[bridge] Tauri API missing — the UI will not work");
    return;
  }
  const invoke = tauri.core.invoke;
  const listen = tauri.event.listen;

  // Commands return a plain value or throw; the Electron API mostly resolved
  // with `{ success, message }`. Failures come back in that shape rather than
  // rejecting, because most call sites never attached a .catch().
  const call = (cmd, args) =>
    invoke(cmd, args).catch((error) => {
      const message = typeof error === "string" ? error : error?.message || String(error);
      console.error(`[bridge] ${cmd}:`, message);
      return { success: false, message };
    });

  // Fire-and-forget: the caller doesn't look at the result.
  const send = (cmd, args) => {
    invoke(cmd, args).catch((e) => console.error(`[bridge] ${cmd}:`, e));
  };

  const on = (event, cb) => {
    listen(event, (e) => cb(e.payload));
  };

  window.electronAPI = {
    // ── Window ───────────────────────────────────────────────────────────────
    closeWindow: () => call("close_window"),
    minimizeWindow: () => call("minimize_window"),
    setZoomFactor: (factor) => call("set_zoom_factor", { factor }),

    // ── Accounts ─────────────────────────────────────────────────────────────
    getAccounts: () => call("get_accounts"),
    addAccount: (data) => call("add_account", { input: data }),
    updateAccount: (data) => call("update_account", { input: data }),
    deleteAccount: (username) => call("delete_account", { username }),
    reorderAccounts: (usernames) => call("reorder_accounts", { usernames }),
    unlockVault: (passwordHash) => call("unlock_vault", { passwordHash }),
    getAccountPassword: (username) => call("get_account_password", { username }),
    exportAccounts: () => call("export_accounts"),
    importAccounts: () => call("import_accounts"),
    getCurrentAccount: () => call("get_current_account"),

    // ── Config ───────────────────────────────────────────────────────────────
    getConfig: () => call("get_config"),
    setConfig: (config) => call("set_config", { patch: config }),

    // ── Launching ────────────────────────────────────────────────────────────
    launchAccount: (username) => call("launch_account", { username }),
    launchLeagueClient: () => call("launch_league_client"),
    cancelLaunch: () => call("cancel_launch"),

    // ── Stats ────────────────────────────────────────────────────────────────
    getStats: (region, riotId) => call("get_stats", { region, riotId }),
    getMatchHistory: (region, riotId) => call("get_match_history", { region, riotId }),
    getRankHistory: (riotId) => call("get_rank_history", { riotId }),

    // ── League client ────────────────────────────────────────────────────────
    acceptMatch: () => call("accept_match"),
    dodgeQueue: () => call("dodge_queue"),
    getDodgeInfo: () => call("get_dodge_info"),
    getLobbyMembers: () => call("get_lobby_members"),
    getLcuOverview: () => call("get_lcu_overview"),
    setProfileBackground: (championName, skinId) =>
      call("set_profile_background", { championName, skinId }),
    setStatusMessage: (message) => call("set_status_message", { message }),
    changeLanguage: (locale) => call("change_language", { locale }),

    // ── Client maintenance ───────────────────────────────────────────────────
    fixClient: () => call("fix_client"),
    repairClient: () => call("repair_client"),
    clearClientCache: () => call("clear_client_cache"),
    openDataFolder: () => call("open_data_folder"),
    openFileDialog: (options) => call("open_file_dialog", { options: options || {} }),

    // ── Reference data ───────────────────────────────────────────────────────
    getChampionList: () => call("get_champion_list"),
    getChampionFullData: (champKey) => call("get_champion_full_data", { champKey }),
    getItemList: () => call("get_item_list"),

    // ── Build paths ──────────────────────────────────────────────────────────
    getBuildPaths: () => call("get_build_paths"),
    saveBuildPath: (champKey, steps) => call("save_build_path", { champKey, steps }),
    deleteBuildPath: (champKey) => call("delete_build_path", { champKey }),
    importBuildPath: (champKey, position) => call("import_build_path", { champKey, position }),
    resolveBuildPath: (champKey) => call("resolve_build_path", { champKey }),
    previewBuildReminder: () => call("preview_build_reminder"),

    // ── Links ────────────────────────────────────────────────────────────────
    openExternal: (url) => call("open_external", { url }),
    openOpgg: (region, riotId) => call("open_opgg", { region, riotId }),
    openPatchNotes: () => call("open_patch_notes"),

    // ── Updates ──────────────────────────────────────────────────────────────
    getVersion: () => call("get_version"),
    checkForUpdates: () => call("check_for_updates"),
    installUpdate: () => call("install_update"),

    // ── Overlay (not part of this build; see the notes in main.rs) ───────────
    resetOverlayPosition: () => call("reset_overlay_position"),

    // ── Events ───────────────────────────────────────────────────────────────
    onLcuConnected: (cb) => on("lcu-connected", () => cb()),
    onLcuDisconnected: (cb) => on("lcu-disconnected", () => cb()),
    onLcuGameflow: (cb) => on("lcu-gameflow", cb),
    onChampSelectUpdate: (cb) => on("champ-select-update", cb),
    onChampSelectEnd: (cb) => on("champ-select-end", () => cb()),
    onLoginStatus: (cb) => on("login-status", cb),
    onAccountsUpdated: (cb) => on("accounts-updated", () => cb()),
    onLaunchAccountInfo: (cb) => on("launch-account-info", cb),
    onActiveAccountDetected: (cb) => on("active-account-detected", cb),
    onBuildReminder: (cb) => on("build-reminder", cb),
    onUpdateAvailable: (cb) => on("update-available", cb),
    onUpdateProgress: (cb) => on("update-progress", cb),
    onUpdateDownloaded: (cb) => on("update-downloaded", cb),
    onUpdateError: (cb) => on("update-error", cb),

    // Overwolf's game-events provider was Electron-only and has no Rust
    // equivalent. Nothing emits these; the build reminder reads Riot's own
    // Live Client Data API instead, which needs no third-party runtime.
    onGepGameEvent: () => {},
    onGepInfoUpdate: () => {},
  };

  // ── Window dragging ────────────────────────────────────────────────────────
  // The renderer marks its drag areas with `-webkit-app-region: drag`, which
  // Chromium only honours inside Electron. WebView2 ignores it, so the same
  // declaration is read back from the computed style and turned into a real
  // drag here — no markup changes needed.
  document.addEventListener("mousedown", async (e) => {
    if (e.button !== 0) return;
    for (let el = e.target; el && el !== document; el = el.parentElement) {
      const style = getComputedStyle(el);
      const region = style.webkitAppRegion || style.getPropertyValue("-webkit-app-region");
      if (region === "no-drag") return;
      if (region === "drag") {
        e.preventDefault();
        try {
          await tauri.window.getCurrentWindow().startDragging();
        } catch (err) {
          console.error("[bridge] startDragging:", err);
        }
        return;
      }
    }
  });

  // The app is frameless, so the browser's own shortcuts are the only way to
  // open devtools; keep F12 working for debugging.
  window.addEventListener("keydown", (e) => {
    if (e.key === "F12") send("toggle_devtools");
  });
})();
