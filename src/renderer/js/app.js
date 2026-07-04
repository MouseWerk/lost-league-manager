// --- State ---
let isEditing = false;
let currentView        = 'accountsView';
let previousView       = 'accountsView';
let selectedChampion   = null;  // { id, name, key, iconUrl } | null
let currentAutoLockName = '';   // raw saved name, used as fallback before list loads
let champListCache     = null;  // loaded once, reused
let isLaunching = false;
let lastLaunchedUsername = null;
// Bumped on every launchAccount() call and on cancel — lets a stale in-flight
// launch promise recognize it's been superseded (by Cancel, or by launching a
// different account) and skip applying its result.
let _launchToken = 0;
let allAccounts = [];
let activeAccountUsername = null;
let currentQuery = '';
let currentSort = 'default';
const statsCache = {}; // username → { tier, lp, iconSrc, level }
let _renderGen = 0;         // incremented each renderAccounts() call; cancels stale stat callbacks
let _shownStatErrors = new Set(); // deduplicates error toasts within a render cycle

// Rank tier → numeric for sorting
const TIER_ORDER = {
    challenger: 10, grandmaster: 9, master: 8,
    diamond: 7, emerald: 6, platinum: 5, gold: 4,
    silver: 3, bronze: 2, iron: 1, unranked: 0
};

function rankToNumber(tierText) {
    if (!tierText || tierText === 'Loading stats...' || tierText === 'N/A' || tierText === 'Err') return -1;
    const parts = tierText.toLowerCase().split(' ');
    const tier = TIER_ORDER[parts[0]];
    if (tier === undefined) return -1;
    const div = parts[1] ? (5 - (parseInt(parts[1]) || 0)) : 0;
    return tier * 10 + div;
}

// Only allow http(s) URLs (or the app's own bundled assets) for a custom
// avatar — blocks javascript:/data:/file: schemes that a crafted or imported
// account record could otherwise use as an XSS/local-file-probing vector.
function safeAvatarUrl(url) {
    if (!url) return null;
    if (url.startsWith('assets/')) return url;
    try {
        const parsed = new URL(url);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? url : null;
    } catch {
        return null;
    }
}

function timeAgo(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
}

function getFilteredSorted() {
    let list = [...allAccounts];
    if (currentQuery) {
        const q = currentQuery.toLowerCase();
        list = list.filter(a =>
            (a.label || '').toLowerCase().includes(q) ||
            a.username.toLowerCase().includes(q) ||
            (a.riotId || '').toLowerCase().includes(q) ||
            (a.region || '').toLowerCase().includes(q)
        );
    }
    switch (currentSort) {
        case 'favourite':
            list.sort((a, b) => (b.isFavourite ? 1 : 0) - (a.isFavourite ? 1 : 0));
            break;
        case 'name':
            list.sort((a, b) => (a.label || a.username).localeCompare(b.label || b.username));
            break;
        case 'region':
            list.sort((a, b) => (a.region || '').localeCompare(b.region || ''));
            break;
        case 'lastUsed':
            list.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
            break;
        case 'rank':
            list.sort((a, b) => rankToNumber(statsCache[b.username]?.tier) - rankToNumber(statsCache[a.username]?.tier));
            break;
    }
    return list;
}

async function sha256(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function initVault(config) {
    if (!config.vaultEnabled || !config.vaultPasswordHash) {
        // Nothing to unlock, but the main process still needs to know this
        // session is allowed to read passwords (it defaults to locked).
        await window.electronAPI.unlockVault(null);
        return;
    }
    return new Promise((resolve) => {
        const lockEl  = document.getElementById('vaultLock');
        const input   = document.getElementById('vaultPasswordInput');
        const errorEl = document.getElementById('vaultError');
        lockEl.style.display = 'flex';
        setTimeout(() => input.focus(), 80);

        async function tryUnlock() {
            if (!input.value) return;
            const hash = await sha256(input.value);
            // Verified server-side too — the main process gates get-account-password
            // on this, so a DOM/JS-only bypass of this lock screen can't leak passwords.
            const result = await window.electronAPI.unlockVault(hash);
            if (result?.success) {
                lockEl.classList.add('vault-unlocking');
                setTimeout(() => { lockEl.style.display = 'none'; resolve(); }, 220);
            } else {
                input.value = '';
                errorEl.style.display = 'block';
                const c = lockEl.querySelector('.vault-lock-content');
                c.classList.add('shake');
                setTimeout(() => { c.classList.remove('shake'); input.focus(); }, 500);
            }
        }

        document.getElementById('vaultUnlockBtn').addEventListener('click', tryUnlock);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(); });
    });
}

// ── Compact / grid view ───────────────────────────────────────────────────────
let compactView = localStorage.getItem('llm-view') === 'compact';

function applyViewMode() {
    const grid    = document.getElementById('accountsList');
    const gridBtn = document.getElementById('viewGridBtn');
    const listBtn = document.getElementById('viewListBtn');
    if (!grid) return;
    grid.classList.toggle('compact', compactView);
    gridBtn?.classList.toggle('active', !compactView);
    listBtn?.classList.toggle('active',  compactView);
}

document.addEventListener('DOMContentLoaded', async () => {
    applyViewMode();
    initDragAndDrop();

    document.getElementById('viewGridBtn')?.addEventListener('click', () => {
        compactView = false;
        localStorage.setItem('llm-view', 'grid');
        applyViewMode();
    });
    document.getElementById('viewListBtn')?.addEventListener('click', () => {
        compactView = true;
        localStorage.setItem('llm-view', 'compact');
        applyViewMode();
    });

    // Version
    const version = await window.electronAPI.getVersion();
    const versionEl = document.getElementById('appVersion');
    if (versionEl) versionEl.innerText = `v${version}`;


    try {
        // Load config
        const config = await window.electronAPI.getConfig();

        // Vault lock — must resolve before anything is shown
        await initVault(config);

        if (config.lolPath) {
            const pathEl = document.getElementById('lolPathDisplay');
            if (pathEl) pathEl.innerText = config.lolPath;
        }

        // Initialize Auto-Accept Toggle (header)
        const autoAcceptToggle = document.getElementById('autoAcceptToggle');
        if (autoAcceptToggle) {
            autoAcceptToggle.checked = config.autoAccept || false;
            autoAcceptToggle.addEventListener('change', async (e) => {
                await window.electronAPI.setConfig({ autoAccept: e.target.checked });
                const s = document.getElementById('autoAcceptSettingsToggle');
                if (s) s.checked = e.target.checked;
            });
        }

        // Initialize all Settings toggles
        // defaultOn = true means the setting is ON unless explicitly set false
        function bindSettingToggle(id, configKey, defaultOn) {
            const el = document.getElementById(id);
            if (!el) return;
            el.checked = defaultOn ? config[configKey] !== false : !!config[configKey];
            el.addEventListener('change', async (e) => {
                await window.electronAPI.setConfig({ [configKey]: e.target.checked });
            });
        }

        bindSettingToggle('overlayEnabledToggle',        'overlayEnabled',          true);
        bindSettingToggle('overlayShowRankedToggle',     'overlayShowRanked',       true);
        bindSettingToggle('overlayShowBuildsToggle',     'overlayShowBuilds',       true);
        bindSettingToggle('minimizeOnGameStartToggle',   'minimizeOnGameStart',     false);
        bindSettingToggle('startWithWindowsToggle',      'startWithWindows',        false);
        bindSettingToggle('startMinimizedToggle',        'startMinimized',          false);
        bindSettingToggle('checkUpdatesOnStartupToggle', 'checkUpdatesOnStartup',   true);
        bindSettingToggle('toastOnQueuePopToggle',       'toastOnQueuePop',         true);
        bindSettingToggle('discordRpcEnabledToggle',     'discordRpcEnabled',       true);

        // UI Scale — only apply if non-default; let ow-electron manage native DPI at 1.0
        const savedScale = config.uiScale ?? 1.0;
        if (savedScale !== 1.0) applyUiScale(savedScale);
        document.querySelectorAll('.scale-btn').forEach(btn => {
            const s = parseFloat(btn.dataset.scale);
            if (s === savedScale) btn.classList.add('active');
            btn.addEventListener('click', async () => {
                document.querySelectorAll('.scale-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                applyUiScale(s);
                await window.electronAPI.setConfig({ uiScale: s });
            });
        });

        // Vault settings
        const vaultToggle  = document.getElementById('vaultEnabledToggle');
        const vaultSection = document.getElementById('vaultPasswordSection');
        if (vaultToggle) {
            vaultToggle.checked = config.vaultEnabled || false;
            vaultSection.style.display = config.vaultEnabled ? 'block' : 'none';
            vaultToggle.addEventListener('change', async (e) => {
                if (!e.target.checked) {
                    await window.electronAPI.setConfig({ vaultEnabled: false, vaultPasswordHash: '' });
                    vaultSection.style.display = 'none';
                    showToast('Vault disabled', 'info');
                } else {
                    vaultSection.style.display = 'block';
                    showToast('Set a password below to activate the vault', 'info');
                }
            });
        }
        document.getElementById('saveVaultPasswordBtn')?.addEventListener('click', async () => {
            const pw = document.getElementById('vaultPasswordSet')?.value?.trim();
            if (!pw) { showToast('Enter a password first', 'error'); return; }
            const hash = await sha256(pw);
            await window.electronAPI.setConfig({ vaultEnabled: true, vaultPasswordHash: hash });
            document.getElementById('vaultPasswordSet').value = '';
            if (vaultToggle) vaultToggle.checked = true;
            showToast('Vault password set!', 'success');
        });

        // Auto-accept in settings synced with header toggle
        const autoAcceptSettings = document.getElementById('autoAcceptSettingsToggle');
        if (autoAcceptSettings) {
            autoAcceptSettings.checked = config.autoAccept || false;
            autoAcceptSettings.addEventListener('change', async (e) => {
                await window.electronAPI.setConfig({ autoAccept: e.target.checked });
                if (autoAcceptToggle) autoAcceptToggle.checked = e.target.checked;
            });
        }

        document.getElementById('resetOverlayPosBtn')?.addEventListener('click', async () => {
            await window.electronAPI.resetOverlayPosition();
            showToast('Overlay position reset', 'success');
        });

        // Riot API Key
        const riotApiKeyInput  = document.getElementById('riotApiKeyInput');
        const riotApiKeyNotice = document.getElementById('riotApiKeyNotice');

        function updateApiKeyNotice(key) {
            if (riotApiKeyNotice) {
                riotApiKeyNotice.style.display = key ? 'none' : 'flex';
            }
        }

        if (riotApiKeyInput) {
            riotApiKeyInput.value = config.riotApiKey || '';
            updateApiKeyNotice(config.riotApiKey);

            document.getElementById('saveRiotApiKeyBtn')?.addEventListener('click', async () => {
                const key = riotApiKeyInput.value.trim();
                await window.electronAPI.setConfig({ riotApiKey: key });
                updateApiKeyNotice(key);
                showToast(key ? 'API key saved!' : 'API key cleared', key ? 'success' : 'info');
            });
        }

        // Load accounts
        await loadAccounts();

        // Check for updates on startup
        if (config.checkUpdatesOnStartup !== false) {
            setTimeout(() => {
                window.electronAPI.checkForUpdates();
            }, 2000);
        }

        // Auto-update event listeners
        window.electronAPI.onUpdateAvailable((data) => {
            showUpdateCard(data.version, 'downloading');
        });

        window.electronAPI.onUpdateProgress((data) => {
            updateDownloadProgress(data.percent);
        });

        window.electronAPI.onUpdateDownloaded((data) => {
            showUpdateCard(data.version, 'ready');
        });

        window.electronAPI.onUpdateError((message) => {
            showToast('Update failed: ' + message, 'error');
            document.getElementById('updateCard').classList.remove('active');
        });

        // Update card controls
        document.getElementById('closeUpdateCard').addEventListener('click', () => {
            document.getElementById('updateCard').classList.remove('active');
            if (_updateVersion) document.getElementById('updatePill').classList.add('active');
        });

        document.getElementById('laterUpdateBtn').addEventListener('click', () => {
            document.getElementById('updateCard').classList.remove('active');
            if (_updateVersion) document.getElementById('updatePill').classList.add('active');
        });

        document.getElementById('installUpdateBtn').addEventListener('click', () => {
            // Show custom install screen, then silently install after it renders
            document.getElementById('installOverlayVersion').textContent = `v${_updateVersion}`;
            document.getElementById('updateCard').classList.remove('active');
            document.getElementById('updatePill').classList.remove('active');
            document.getElementById('installOverlay').classList.add('active');
            setTimeout(() => window.electronAPI.installUpdate(), 900);
        });

        document.getElementById('updatePill').addEventListener('click', () => {
            document.getElementById('updatePill').classList.remove('active');
            showUpdateCard(_updateVersion, _updateState);
        });

    } catch (err) {
        console.error("Initialization error:", err);
    }

    // Account info sent when launch begins — populate overlay header
    window.electronAPI.onLaunchAccountInfo((info) => {
        document.getElementById('launchAccLabel').textContent = info.label;
        document.getElementById('launchAccMeta').textContent = [info.region, info.username].filter(Boolean).join(' · ');
        const icon = document.getElementById('launchAccIcon');
        const cached = statsCache[info.username];
        if (cached?.iconSrc) icon.src = cached.iconSrc;
        else icon.src = 'assets/logo.png';
        // Reset retry button on each new launch
        document.getElementById('retryLaunchBtn').style.display = 'none';
    });

    // LCU connect / disconnect
    window.electronAPI.onLcuConnected(() => {
        document.getElementById('lcuNavDot').classList.add('visible');
        loadLiveView();
    });
    window.electronAPI.onLcuDisconnected(() => {
        document.getElementById('lcuNavDot').classList.remove('visible');
        setLcuOffline();
    });
    window.electronAPI.onLcuGameflow((phase) => {
        updateGameflowBadge(phase);
        updateContextButtons(phase);
    });

    // When LCU reveals which account is currently logged in (external launch)
    window.electronAPI.onActiveAccountDetected((username) => {
        if (activeAccountUsername !== username) {
            activeAccountUsername = username;
            renderAccounts();
        }
    });

    // Dodge / Accept buttons
    document.getElementById('ovDodgeBtn').addEventListener('click', async () => {
        const info = await window.electronAPI.getDodgeInfo().catch(() => ({}));
        let warningMsg = info.isRanked
            ? 'Dodging ranked will cost LP (−3 first dodge, −10 second in 16 hours) and apply a queue cooldown.'
            : 'Dodging will apply a queue cooldown (5 min first, 30 min second in 16 hours).';
        if (info.hasActivePenalty && info.penaltyMinutesRemaining) {
            warningMsg += `\n\n⚠ You already have an active dodge penalty (${info.penaltyMinutesRemaining} min remaining) — this will extend it.`;
        }
        const ok = await showConfirm('Dodge Queue?', warningMsg, 'danger');
        if (!ok) return;
        await window.electronAPI.dodgeQueue();
        showToast('Queue dodged', 'info');
    });
    document.getElementById('ovAcceptBtn').addEventListener('click', async () => {
        await window.electronAPI.acceptMatch();
        showToast('Match accepted!', 'success');
    });

    // Live view tab switching
    document.querySelectorAll('.ov-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.ov-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.ov-panel').forEach(p => p.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById(tab.dataset.tab).classList.add('active');
        });
    });

    // Login Progress (Overlay)
    window.electronAPI.onLoginStatus((data) => {
        const overlay = document.getElementById('launchOverlay');
        const statusEl = document.getElementById('launchStatus');
        const progressEl = document.getElementById('launchProgress');

        let msg = "";
        let pct = 0;

        if (typeof data === 'string') {
            msg = data;
        } else if (data && typeof data === 'object') {
            msg = data.message;
            pct = data.progress || 0;
        }

        if (msg) {
            statusEl.textContent = msg;
            overlay.classList.add('active');
            if (pct > 0) progressEl.style.width = pct + '%';
            if (pct === 100) showToast('League launched successfully!', 'success');
        } else {
            overlay.classList.remove('active');
            setTimeout(() => { progressEl.style.width = '0%'; }, 500);
        }
    });

    // Listen for external account updates
    window.electronAPI.onAccountsUpdated(() => {
        loadAccounts();
    });

    // Overwolf GEP events (fired while a LoL session is running)
    window.electronAPI.onGepGameEvent((data) => {
        console.log('[GEP] Game event:', data);
    });
    window.electronAPI.onGepInfoUpdate((data) => {
        console.log('[GEP] Info update:', data);
    });

    // Cancel Launch
    document.getElementById('cancelLaunchBtn').addEventListener('click', async () => {
        document.getElementById('launchOverlay').classList.remove('active');
        document.getElementById('retryLaunchBtn').style.display = 'none';
        isLaunching = false;
        _launchToken++; // invalidate the in-flight launchAccount() call, if any
        await window.electronAPI.cancelLaunch();
    });

    // Retry Launch
    document.getElementById('retryLaunchBtn').addEventListener('click', () => {
        if (lastLaunchedUsername) launchAccount(lastLaunchedUsername);
    });

    document.getElementById('patchNotesBtn').addEventListener('click', (e) => {
        e.preventDefault();
        window.electronAPI.openPatchNotes();
    });

    // Tools
    document.getElementById('fixClientBtn').addEventListener('click', async () => {
        const confirm = await showConfirm("Emergency Fix", "This will close all League of Legends and Riot Games processes. Continue?", "danger");
        if (confirm) {
            const res = await window.electronAPI.fixClient();
            if (res.success) showToast("Client processes killed!", "success");
        }
    });

    document.getElementById('repairClientBtn').addEventListener('click', async (e) => {
        const btn = e.target;
        btn.disabled = true;
        const res = await window.electronAPI.repairClient();
        btn.disabled = false;
        if (res.success) {
            showToast(res.removed ? 'Lockfile removed — client repaired!' : 'No lockfile found (already clean)', res.removed ? 'success' : 'info');
        } else {
            showToast('Repair failed: ' + res.message, 'error');
        }
    });

    document.getElementById('clearCacheBtn').addEventListener('click', async (e) => {
        const ok = await showConfirm('Clear Cache', 'This will delete the Riot Client cache. The client will re-download it on next launch.', 'info');
        if (!ok) return;
        const btn = e.target;
        btn.disabled = true;
        const res = await window.electronAPI.clearClientCache();
        btn.disabled = false;
        if (res.success) {
            showToast(res.cleared > 0 ? 'Cache cleared!' : 'Cache already empty', res.cleared > 0 ? 'success' : 'info');
        } else {
            showToast('Failed: ' + res.message, 'error');
        }
    });

    document.getElementById('openDataFolderBtn').addEventListener('click', async () => {
        await window.electronAPI.openDataFolder();
    });

    // Backup
    document.getElementById('exportAccountsBtn').addEventListener('click', async (e) => {
        const btn = e.target.closest('button');
        btn.disabled = true;
        const res = await window.electronAPI.exportAccounts();
        btn.disabled = false;
        if (res.canceled) return;
        if (res.success) {
            showToast(`${res.count} account(s) exported!`, 'success');
        } else {
            showToast('Export failed: ' + (res.message || 'unknown error'), 'error');
        }
    });

    document.getElementById('importAccountsBtn').addEventListener('click', async (e) => {
        const btn = e.target.closest('button');
        btn.disabled = true;
        const res = await window.electronAPI.importAccounts();
        btn.disabled = false;
        if (res.canceled) return;
        if (res.success) {
            const msg = res.added > 0
                ? `${res.added} account(s) imported${res.skipped > 0 ? `, ${res.skipped} skipped (already exist)` : ''}!`
                : `No new accounts — all ${res.skipped} already exist`;
            showToast(msg, res.added > 0 ? 'success' : 'info');
            if (res.added > 0) loadAccounts();
        } else {
            showToast('Import failed: ' + (res.message || 'unknown error'), 'error');
        }
    });

    // Manual update check
    document.getElementById('manualUpdateBtn').addEventListener('click', async (e) => {
        const btn = e.target;
        btn.innerText = "Checking...";
        btn.disabled = true;
        try {
            const update = await window.electronAPI.checkForUpdates();
            if (update && update.updateAvailable) {
                showToast(`v${update.latestVersion} found — downloading…`, 'info');
            } else if (update && update.error) {
                showToast('Update check failed: ' + update.error, 'error');
            } else {
                showToast('You\'re on the latest version!', 'success');
            }
        } catch (err) {
            showToast("Failed to check for updates.", "error");
        } finally {
            btn.innerText = "Check for Updates";
            btn.disabled = false;
        }
    });

    // Search & Sort
    const searchInput = document.getElementById('accountSearch');
    const clearBtn = document.getElementById('searchClearBtn');
    const sortSelect = document.getElementById('accountSort');

    searchInput.addEventListener('input', () => {
        currentQuery = searchInput.value.trim();
        clearBtn.style.display = currentQuery ? 'block' : 'none';
        renderAccounts();
    });

    clearBtn.addEventListener('click', () => {
        searchInput.value = '';
        currentQuery = '';
        clearBtn.style.display = 'none';
        searchInput.focus();
        renderAccounts();
    });

    sortSelect.addEventListener('change', () => {
        currentSort = sortSelect.value;
        renderAccounts();
    });

    // Sidebar Nav
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            showView(btn.dataset.view);
            if (btn.dataset.view === 'liveView') loadLiveView();
            if (btn.dataset.view === 'statsView') initStatsView();
        });
    });

    // Window Controls
    document.getElementById('minimizeAppBtn').addEventListener('click', () => window.electronAPI.minimizeWindow());
    document.getElementById('closeAppBtn').addEventListener('click', () => window.electronAPI.closeWindow());

    // Profile modal
    document.getElementById('closeProfileModal').addEventListener('click', closeProfileModal);
    document.getElementById('profileLaunchBtn').addEventListener('click', () => {
        closeProfileModal();
        if (_profileUsername) launchAccount(_profileUsername);
    });
    document.getElementById('profileEditBtn').addEventListener('click', () => {
        const u = _profileUsername;
        closeProfileModal();
        if (u) editAccount(u);
    });

    // Add Account
    document.getElementById('addAccountBtn').addEventListener('click', openModal);

    // External links
    document.getElementById('discordBtn').addEventListener('click', (e) => {
        e.preventDefault();
        window.electronAPI.openExternal('https://discord.gg/ZyfUMWTPFe');
    });
    document.getElementById('websiteBtn').addEventListener('click', (e) => {
        e.preventDefault();
        window.electronAPI.openExternal('https://www.lostleague.com/');
    });

    // Modal Controls
    document.getElementById('cancelAddBtn').addEventListener('click', closeModal);
    document.getElementById('saveAccountBtn').addEventListener('click', saveAccount);
    initChampionPicker();

    // Change League Client path
    document.getElementById('changePathBtn').addEventListener('click', async () => {
        const result = await window.electronAPI.openFileDialog({
            title: 'Select LeagueClient.exe',
            filters: [{ name: 'Executables', extensions: ['exe'] }],
            properties: ['openFile']
        });
        if (!result.canceled && result.filePaths.length > 0) {
            const newPath = result.filePaths[0];
            await window.electronAPI.setConfig({ lolPath: newPath });
            document.getElementById('lolPathDisplay').innerText = newPath;
            showToast('League path updated!', 'success');
        }
    });

    // Change client language
    document.getElementById('changeLocaleBtn').addEventListener('click', async () => {
        const locale = document.getElementById('localeSelect').value;
        const res = await window.electronAPI.changeLanguage(locale);
        if (res.success) {
            showToast('Language changed! Restart the client to apply.', 'success');
        } else {
            showToast('Failed: ' + res.message, 'error');
        }
    });
});

function applyUiScale(scale) {
    window.electronAPI.setZoomFactor(scale);
}

function showView(viewId) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');
    currentView = viewId;
}

/**
 * Shows a premium toast notification
 */
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    let icon = '<i class="fas fa-info-circle"></i>';
    if (type === 'success') icon = '<i class="fas fa-check-circle"></i>';
    if (type === 'error') icon = '<i class="fas fa-exclamation-circle"></i>';

    // icon is always one of the fixed strings above, but message can originate
    // from IO (backend error text, etc.) — keep it out of innerHTML.
    toast.innerHTML = `
        <span class="toast-icon">${icon}</span>
        <span class="toast-msg"></span>
    `;
    toast.querySelector('.toast-msg').textContent = message;

    container.appendChild(toast);

    // Auto-remove after 4s
    setTimeout(() => {
        toast.classList.add('removing');
        setTimeout(() => toast.remove(), 400);
    }, 4000);
}
/**
 * Custom confirmation modal
 */
function showConfirm(title, message, type = 'info') {
    return new Promise((resolve) => {
        const modal = document.getElementById('confirmModal');
        const content = modal.querySelector('.modal-content');
        const titleEl = document.getElementById('confirmTitle');
        const msgEl = document.getElementById('confirmMessage');
        const yesBtn = document.getElementById('confirmYesBtn');
        const cancelBtn = document.getElementById('confirmCancelBtn');

        // Reset and apply type
        content.classList.remove('danger', 'info', 'success');
        content.classList.add(type);

        titleEl.innerText = title;
        msgEl.innerText = message;
        modal.classList.add('active');

        const cleanup = (value) => {
            modal.classList.remove('active');
            yesBtn.onclick = null;
            cancelBtn.onclick = null;
            resolve(value);
        };

        yesBtn.onclick = () => cleanup(true);
        cancelBtn.onclick = () => cleanup(false);
    });
}

async function loadAccounts() {
    [allAccounts, activeAccountUsername] = await Promise.all([
        window.electronAPI.getAccounts(),
        window.electronAPI.getCurrentAccount()
    ]);
    renderAccounts();
}

function renderAccounts() {
    const gen = ++_renderGen; // any callback from a previous render is now stale
    _shownStatErrors = new Set();

    const listEl = document.getElementById('accountsList');
    listEl.innerHTML = '';

    const countEl = document.getElementById('accountCount');
    if (countEl) countEl.textContent = allAccounts.length;

    const filtered = getFilteredSorted();

    if (allAccounts.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.innerHTML = `
            <div class="empty-icon"><i class="fas fa-folder-open"></i></div>
            <p>No accounts added yet.</p>
            <button class="primary-btn" onclick="document.getElementById('addAccountBtn').click()">Add Your First Account</button>
        `;
        listEl.appendChild(empty);
        return;
    }

    if (filtered.length === 0) {
        const noRes = document.createElement('div');
        noRes.className = 'empty-state';
        noRes.innerHTML = `<div class="empty-icon"><i class="fas fa-search"></i></div><p>No accounts match your search.</p>`;
        listEl.appendChild(noRes);
        return;
    }

    let staggerIndex = 0;

    for (const acc of filtered) {
        const el = createAccountCard(acc);
        listEl.appendChild(el);

        if (acc.riotId && acc.region) {
            const cached = statsCache[acc.username];
            if (cached) {
                applyStatsToCard(el, cached);
            } else {
                // Stagger uncached fetches by 150ms each to stay under Riot API rate limits.
                // The generation check discards callbacks that belong to a superseded render.
                const delay = staggerIndex++ * 150;
                setTimeout(() => {
                    if (_renderGen !== gen) return; // render was superseded, abort
                    window.electronAPI.getStats(acc.region, acc.riotId).then(stats => {
                        if (_renderGen !== gen || !stats) return;
                        if (stats.error) {
                            // Only show each unique error once per render cycle
                            if (!_shownStatErrors.has(stats.error)) {
                                _shownStatErrors.add(stats.error);
                                showToast(stats.error, 'error');
                            }
                        }
                        statsCache[acc.username] = stats;
                        applyStatsToCard(el, stats);
                        if (currentSort === 'rank') renderAccounts();
                    }).catch(err => {
                        if (_renderGen !== gen) return;
                        console.error('[Stats]', acc.username, err);
                    });
                }, delay);
            }
        }
    }
}

function applyStatsToCard(cardEl, stats) {
    const acc = allAccounts.find(a => a.username === cardEl.dataset.username);

    const rankEl = cardEl.querySelector('.rank');
    if (rankEl && !acc?.customRank) {
        const tierName = (stats.tier || 'unranked').split(' ')[0].toLowerCase();
        const valid = ['iron','bronze','silver','gold','platinum','emerald','diamond','master','grandmaster','challenger'];
        const cls = valid.includes(tierName) ? `rank-${tierName}` : 'rank-unranked';
        rankEl.className = `rank ${cls}`;
        const tierDisplay = stats.tier && stats.tier !== 'Unranked' ? stats.tier : 'Unranked';
        rankEl.innerHTML = `<span>${tierDisplay}</span>${stats.lp ? ` • <span>${stats.lp}</span>` : ''}`;
    }
    const iconEl = cardEl.querySelector('.summoner-icon');
    if (iconEl && stats.iconSrc && !acc?.customAvatar) iconEl.src = stats.iconSrc;

    const levelEl = cardEl.querySelector('.level-badge');
    if (levelEl && stats.level) {
        levelEl.innerText = stats.level;
        levelEl.style.display = 'block';
    }
}

// ── Profile Modal ─────────────────────────────────────────────────────────────

const TIER_EMBLEMS = {
    iron: '🩶', bronze: '🟤', silver: '⚪', gold: '🟡',
    platinum: '🩵', emerald: '🟢', diamond: '💎',
    master: '💜', grandmaster: '🔴', challenger: '🏆',
};

let _profileUsername = null;

function fillProfileRank(tierEl, lpEl, recordEl, emblemEl, tierCls, tier, lp, winLose, ratio) {
    const t = (tier || 'Unranked').toLowerCase().split(' ')[0];
    tierEl.textContent  = tier || 'Unranked';
    tierEl.className    = `profile-rank-tier ${tierCls(tier)}`;
    lpEl.textContent    = lp     || '';
    recordEl.textContent = winLose ? `${winLose}${ratio ? '  ·  ' + ratio : ''}` : '';
    emblemEl.textContent = TIER_EMBLEMS[t] || '—';
}

function populateProfileModal(acc, stats) {
    const defaultIcon = 'assets/logo.png';
    // Mirror applyStatsToCard()'s precedence — a custom avatar should win here too,
    // otherwise the profile modal shows a different icon than the account card.
    document.getElementById('profileIcon').src =
        safeAvatarUrl(acc.customAvatar) || stats?.iconSrc || defaultIcon;
    document.getElementById('profileLabel').textContent = acc.label || acc.username;
    document.getElementById('profileLevel').textContent = stats?.level || '';
    document.getElementById('profileLevel').style.display = stats?.level ? 'block' : 'none';

    const meta = [acc.riotId, (acc.region || '').toUpperCase()].filter(Boolean).join('  ·  ');
    document.getElementById('profileMeta').textContent = meta;
    document.getElementById('profileLoading').style.display = 'none';

    fillProfileRank(
        document.getElementById('profileSoloTier'),
        document.getElementById('profileSoloLp'),
        document.getElementById('profileSoloRecord'),
        document.getElementById('profileSoloEmblem'),
        tierClass,
        stats?.tier, stats?.lp, stats?.winLose, stats?.ratio
    );
    fillProfileRank(
        document.getElementById('profileFlexTier'),
        document.getElementById('profileFlexLp'),
        document.getElementById('profileFlexRecord'),
        document.getElementById('profileFlexEmblem'),
        tierClass,
        stats?.flexTier, stats?.flexLp, stats?.flexWinLose, stats?.flexRatio
    );

    const notesWrap = document.getElementById('profileNotesWrap');
    const notesEl   = document.getElementById('profileNotes');
    if (acc.notes) {
        notesEl.textContent = acc.notes;
        notesWrap.style.display = 'block';
    } else {
        notesWrap.style.display = 'none';
    }
}

async function showProfileModal(username) {
    _profileUsername = username;
    const acc = allAccounts.find(a => a.username === username);
    if (!acc) return;

    const modal = document.getElementById('profileModal');
    modal.classList.add('active');

    const cached = statsCache[username];
    if (cached) {
        populateProfileModal(acc, cached);
    } else {
        // Show skeleton while fetching
        document.getElementById('profileIcon').src    = 'assets/logo.png';
        document.getElementById('profileLabel').textContent = acc.label || acc.username;
        document.getElementById('profileLevel').style.display = 'none';
        document.getElementById('profileMeta').textContent   = [acc.riotId, (acc.region || '').toUpperCase()].filter(Boolean).join('  ·  ');
        document.getElementById('profileLoading').style.display = 'flex';
        ['profileSoloTier','profileFlexTier'].forEach(id => {
            document.getElementById(id).textContent = '—';
            document.getElementById(id).className   = 'profile-rank-tier rank-unranked';
        });
        ['profileSoloLp','profileFlexLp','profileSoloRecord','profileFlexRecord',
         'profileSoloEmblem','profileFlexEmblem'].forEach(id => {
            document.getElementById(id).textContent = '';
        });
        document.getElementById('profileNotesWrap').style.display = 'none';

        if (acc.riotId && acc.region) {
            try {
                const stats = await window.electronAPI.getStats(acc.region, acc.riotId);
                if (stats) {
                    statsCache[username] = stats;
                    if (_profileUsername === username) populateProfileModal(acc, stats);
                }
            } catch { /* show skeleton */ }
        }
        if (_profileUsername === username) {
            document.getElementById('profileLoading').style.display = 'none';
        }
    }
}

function closeProfileModal() {
    document.getElementById('profileModal').classList.remove('active');
    _profileUsername = null;
}

function createAccountCard(account) {
    const card = document.createElement('div');
    const isActive = account.username === activeAccountUsername;
    card.className = `account-card${isActive ? ' is-active' : ''}${account.isFavourite ? ' is-favourite' : ''}`;
    card.dataset.username = account.username;
    card.draggable = true;

    const defaultIcon = 'assets/logo.png';
    const iconSrc = safeAvatarUrl(account.customAvatar) || defaultIcon;
    const region = (account.region || '').toUpperCase();
    const lastUsedText = timeAgo(account.lastUsed);
    const rankDisplay = account.customRank || (account.riotId && account.region ? 'Loading stats...' : '—');

    // customAvatar/customRank are free-text user input (and can arrive via an
    // imported .llem backup) — never interpolate them into innerHTML directly.
    // The icon src and rank text are set below via .src/.textContent instead.
    card.innerHTML = `
        <div class="account-info">
            <div class="summoner-icon-container">
                <img class="summoner-icon">
                <span class="level-badge" style="display:none">1</span>
                <button class="fav-btn${account.isFavourite ? ' is-fav' : ''}" title="${account.isFavourite ? 'Remove from Favourites' : 'Add to Favourites'}"><i class="fas fa-star"></i></button>
            </div>
            <div class="text-content">
                <div class="card-title-row">
                    <h3 class="card-label"></h3>
                    ${isActive ? '<span class="active-dot" title="Active account"></span>' : ''}
                </div>
                <div class="card-meta">
                    <span class="username card-username"></span>
                    ${region ? `<span class="region-badge">${region}</span>` : ''}
                    ${lastUsedText ? `<span class="last-used">${lastUsedText}</span>` : ''}
                </div>
                <div class="rank card-rank"></div>
                ${account.notes ? '<div class="notes-preview card-notes"></div>' : ''}
            </div>
        </div>
        <div class="card-actions">
            <button class="icon-btn info-btn"      title="View Profile"><i class="fas fa-chart-bar"></i></button>
            <button class="icon-btn copy-user-btn" title="Copy Username"><i class="fas fa-user"></i></button>
            <button class="icon-btn copy-pass-btn" title="Copy Password"><i class="fas fa-key"></i></button>
            <button class="icon-btn play-btn"      title="Launch"><i class="fas fa-play"></i></button>
            <button class="icon-btn edit-btn"      title="Edit"><i class="fas fa-pen"></i></button>
            <button class="icon-btn delete-btn"    title="Delete"><i class="fas fa-trash"></i></button>
        </div>
    `;

    const iconEl = card.querySelector('.summoner-icon');
    iconEl.src = iconSrc;
    iconEl.addEventListener('error', () => { iconEl.src = defaultIcon; });

    card.querySelector('.card-rank').textContent = rankDisplay;
    card.querySelector('.card-label').textContent = account.label || 'Account';
    card.querySelector('.card-username').textContent = account.username;
    if (account.notes) card.querySelector('.card-notes').textContent = account.notes;

    card.querySelector('.fav-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        const btn = e.currentTarget;
        if (btn.dataset.saving) return;
        btn.dataset.saving = '1';
        const newFav = !account.isFavourite;
        // Optimistic update — flip state immediately before the async call
        account.isFavourite = newFav;
        const idx = allAccounts.findIndex(a => a.username === account.username);
        if (idx !== -1) allAccounts[idx].isFavourite = newFav;
        btn.classList.toggle('is-fav', newFav);
        btn.title = newFav ? 'Remove from Favourites' : 'Add to Favourites';
        card.classList.toggle('is-favourite', newFav);
        try {
            await window.electronAPI.updateAccount({ username: account.username, isFavourite: newFav });
        } finally {
            delete btn.dataset.saving;
        }
        if (currentSort === 'favourite') renderAccounts();
    });

    card.querySelector('.account-info').addEventListener('click', () => launchAccount(account.username));
    card.querySelector('.info-btn').addEventListener('click',   (e) => { e.stopPropagation(); showProfileModal(account.username); });
    card.querySelector('.copy-user-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(account.username);
        flashCopied(card.querySelector('.copy-user-btn'));
    });
    card.querySelector('.copy-pass-btn').addEventListener('click', async (e) => {
        e.stopPropagation();
        const pw = await window.electronAPI.getAccountPassword(account.username);
        if (pw) {
            navigator.clipboard.writeText(pw);
            flashCopied(card.querySelector('.copy-pass-btn'));
        } else {
            showToast('Could not retrieve password', 'error');
        }
    });
    card.querySelector('.play-btn').addEventListener('click',   (e) => { e.stopPropagation(); launchAccount(account.username); });
    card.querySelector('.edit-btn').addEventListener('click',   (e) => { e.stopPropagation(); editAccount(account.username); });
    card.querySelector('.delete-btn').addEventListener('click', (e) => { e.stopPropagation(); deleteAccount(account.username); });

    return card;
}




function initDragAndDrop() {
    const listEl = document.getElementById('accountsList');
    let dragSrc = null;

    listEl.addEventListener('dragstart', (e) => {
        if (currentSort !== 'default' || currentQuery) return;
        const card = e.target.closest('.account-card');
        if (!card) return;
        dragSrc = card;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', card.dataset.username);
        requestAnimationFrame(() => card.classList.add('dragging'));
    });

    listEl.addEventListener('dragover', (e) => {
        if (!dragSrc) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const card = e.target.closest('.account-card');
        if (!card || card === dragSrc) return;
        listEl.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        card.classList.add('drag-over');
    });

    listEl.addEventListener('dragleave', (e) => {
        const card = e.target.closest('.account-card');
        // Only clear the highlight when the mouse actually leaves the card,
        // not when it enters a child element inside it.
        if (card && !card.contains(e.relatedTarget)) card.classList.remove('drag-over');
    });

    listEl.addEventListener('drop', async (e) => {
        e.preventDefault();
        if (!dragSrc || currentSort !== 'default' || currentQuery) return;
        const card = e.target.closest('.account-card');
        if (!card || card === dragSrc) return;

        const srcIdx = allAccounts.findIndex(a => a.username === dragSrc.dataset.username);
        const tgtIdx = allAccounts.findIndex(a => a.username === card.dataset.username);

        if (srcIdx !== -1 && tgtIdx !== -1) {
            const [moved] = allAccounts.splice(srcIdx, 1);
            // tgtIdx was computed before the removal above; once the source item
            // is spliced out, everything after it shifts left by one, so when
            // dragging forward (srcIdx < tgtIdx) the insertion point must shift
            // back by one too, or the card lands one slot past the drop target.
            const insertIdx = srcIdx < tgtIdx ? tgtIdx - 1 : tgtIdx;
            allAccounts.splice(insertIdx, 0, moved);
            await window.electronAPI.reorderAccounts(allAccounts.map(a => a.username));
            renderAccounts();
        }
    });

    listEl.addEventListener('dragend', () => {
        if (dragSrc) dragSrc.classList.remove('dragging');
        listEl.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
        dragSrc = null;
    });
}

let _updateVersion = '';
let _updateState   = ''; // 'downloading' | 'ready'

function showUpdateCard(version, state) {
    _updateVersion = version;
    _updateState   = state;

    const card     = document.getElementById('updateCard');
    const pill     = document.getElementById('updatePill');
    const progSec  = document.getElementById('updateProgressSection');
    const actions  = document.getElementById('updateCardActions');
    const pillLbl  = document.getElementById('updatePillLabel');

    document.getElementById('updateCardVersion').textContent = `v${version}`;

    if (state === 'downloading') {
        progSec.style.display  = 'flex';
        actions.style.display  = 'none';
        pillLbl.textContent    = 'Downloading update…';
    } else {
        // ready to install
        progSec.style.display  = 'none';
        actions.style.display  = 'flex';
        document.getElementById('updateProgressBar').style.width = '100%';
        pillLbl.textContent    = 'Update ready — click to install';
    }

    pill.classList.remove('active');
    card.classList.remove('active');
    void card.offsetWidth; // force reflow so animation replays
    card.classList.add('active');
}

function updateDownloadProgress(percent) {
    document.getElementById('updateProgressBar').style.width = `${percent}%`;
    document.getElementById('updateProgressPct').textContent = `${percent}%`;
}

// Account Form View Functions
function openModal(account = null) {
    previousView = currentView;
    isEditing = false;

    if (account && account.username) {
        isEditing = true;
        document.getElementById('modalTitle').innerText = "Edit Account";
        document.getElementById('newUsername').value = account.username;
        document.getElementById('newPassword').value = "";
        document.getElementById('newPassword').placeholder = "Unchanged";
        document.getElementById('newLabel').value = account.label || "";
        document.getElementById('newNotes').value = account.notes || "";
        document.getElementById('newRiotId').value = account.riotId || "";
        document.getElementById('newRegion').value = account.region || "";

        document.getElementById('appearOfflineToggle').checked = account.appearOffline || false;
        document.getElementById('autoSkinToggle').checked = account.autoSkinRandom || false;
        setSelectedChampionByName(account.autoChampLock || '');
        document.getElementById('autoSpellsToggle').checked = false;
        document.getElementById('minimizeOnLaunchToggle').checked = account.minimizeOnLaunch || false;
        document.getElementById('isFavouriteToggle').checked = account.isFavourite || false;
        document.getElementById('newCustomRank').value = account.customRank || '';
        document.getElementById('newCustomAvatar').value = account.customAvatar || '';

        document.getElementById('newUsername').disabled = true;
    } else {
        isEditing = false;
        document.getElementById('modalTitle').innerText = "New Account";
        document.getElementById('newUsername').value = "";
        document.getElementById('newPassword').value = "";
        document.getElementById('newPassword').placeholder = "Password";
        document.getElementById('newLabel').value = "";
        document.getElementById('newNotes').value = "";
        document.getElementById('newRiotId').value = "";
        document.getElementById('newRegion').value = "";

        document.getElementById('appearOfflineToggle').checked = false;
        document.getElementById('autoSkinToggle').checked = false;
        setSelectedChampion(null);
        document.getElementById('autoSpellsToggle').checked = false;
        document.getElementById('minimizeOnLaunchToggle').checked = false;
        document.getElementById('isFavouriteToggle').checked = false;
        document.getElementById('newCustomRank').value = '';
        document.getElementById('newCustomAvatar').value = '';

        document.getElementById('newUsername').disabled = false;
    }
    showView('accountFormView');
}

function closeModal() {
    closeChampionSearch();
    showView(previousView || 'accountsView');
    // Re-highlight the correct nav button
    document.querySelectorAll('.nav-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.view === (previousView || 'accountsView'));
    });
}

// ── Champion Picker ──────────────────────────────────────────────────────────

function setSelectedChampion(champ) {
    selectedChampion    = champ;
    currentAutoLockName = champ ? champ.name : '';
    const preview     = document.getElementById('champPickerPreview');
    const placeholder = document.getElementById('champPickerPlaceholder');
    preview.querySelectorAll('img, .champ-picker-name').forEach(el => el.remove());
    if (champ) {
        placeholder.style.display = 'none';
        const img = document.createElement('img');
        img.src = champ.iconUrl;
        img.alt = champ.name;
        img.onerror = () => { img.style.display = 'none'; };
        const nameEl = document.createElement('span');
        nameEl.className = 'champ-picker-name';
        nameEl.textContent = champ.name;
        preview.appendChild(img);
        preview.appendChild(nameEl);
    } else {
        placeholder.style.display = '';
    }
}

function setSelectedChampionByName(name) {
    currentAutoLockName = name || '';
    if (!name) { setSelectedChampion(null); return; }
    if (champListCache) {
        const found = champListCache.find(c => c.name.toLowerCase() === name.toLowerCase());
        if (found) { setSelectedChampion(found); return; }
    }
    // List not yet loaded — show name text only, no icon
    selectedChampion = null;
    const preview     = document.getElementById('champPickerPreview');
    const placeholder = document.getElementById('champPickerPlaceholder');
    placeholder.style.display = 'none';
    preview.querySelectorAll('img, .champ-picker-name').forEach(el => el.remove());
    const nameEl = document.createElement('span');
    nameEl.className = 'champ-picker-name';
    nameEl.textContent = name;
    preview.appendChild(nameEl);
}

function openChampionSearch() {
    document.getElementById('champSearchOverlay').classList.add('open');
    const input = document.getElementById('champSearchInput');
    input.value = '';
    renderChampionGrid('');
    input.focus();
}

function closeChampionSearch() {
    document.getElementById('champSearchOverlay')?.classList.remove('open');
}

function renderChampionGrid(query) {
    const grid = document.getElementById('champSearchGrid');
    if (!champListCache || champListCache.length === 0) {
        grid.innerHTML = '<div style="color:var(--text-dim);font-size:12px;padding:16px;grid-column:1/-1;text-align:center;">Loading champions…</div>';
        return;
    }
    const q = query.toLowerCase().trim();
    const list = q ? champListCache.filter(c => c.name.toLowerCase().includes(q)) : champListCache;
    grid.innerHTML = '';
    if (list.length === 0) {
        grid.innerHTML = '<div style="color:var(--text-dim);font-size:12px;padding:16px;grid-column:1/-1;text-align:center;">No champions found</div>';
        return;
    }
    list.forEach(champ => {
        const item = document.createElement('div');
        item.className = 'champ-search-item' + (selectedChampion?.id === champ.id ? ' selected' : '');
        const img = document.createElement('img');
        img.src = champ.iconUrl;
        img.alt = champ.name;
        img.loading = 'lazy';
        img.decoding = 'async';
        img.onerror = () => { img.style.display = 'none'; };
        const span = document.createElement('span');
        span.textContent = champ.name;
        item.appendChild(img);
        item.appendChild(span);
        item.addEventListener('click', () => { setSelectedChampion(champ); closeChampionSearch(); });
        grid.appendChild(item);
    });
}

function initChampionPicker() {
    document.getElementById('champPickerOpenBtn').addEventListener('click', async () => {
        if (!champListCache) {
            document.getElementById('champSearchGrid').innerHTML =
                '<div style="color:var(--text-dim);font-size:12px;padding:16px;grid-column:1/-1;text-align:center;">Loading champions…</div>';
            document.getElementById('champSearchOverlay').classList.add('open');
            champListCache = await window.electronAPI.getChampionList();
            // Resolve pending name now that the list is available
            if (currentAutoLockName && !selectedChampion) {
                const found = champListCache.find(c => c.name.toLowerCase() === currentAutoLockName.toLowerCase());
                if (found) setSelectedChampion(found);
            }
        }
        openChampionSearch();
    });
    document.getElementById('champSearchBack').addEventListener('click', closeChampionSearch);
    document.getElementById('champSearchClearSel').addEventListener('click', () => {
        setSelectedChampion(null);
        closeChampionSearch();
    });
    document.getElementById('champSearchInput').addEventListener('input', e => {
        renderChampionGrid(e.target.value);
    });
}

async function saveAccount() {
    const username = document.getElementById('newUsername').value;
    const password = document.getElementById('newPassword').value;
    const label = document.getElementById('newLabel').value;
    const note = document.getElementById('newNotes').value;
    const riotId = document.getElementById('newRiotId').value;
    const region = document.getElementById('newRegion').value;

    const appearOffline  = document.getElementById('appearOfflineToggle').checked;
    const autoSkin       = document.getElementById('autoSkinToggle').checked;
    const autoChampLock  = selectedChampion ? selectedChampion.name : currentAutoLockName;
    const minimizeOnLaunch = document.getElementById('minimizeOnLaunchToggle').checked;

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
        isFavourite:  document.getElementById('isFavouriteToggle').checked,
        customRank:   document.getElementById('newCustomRank').value.trim(),
        customAvatar: document.getElementById('newCustomAvatar').value.trim(),
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

    if (res.success) {
        showToast(isEditing ? "Account updated!" : "Account added!", "success");
        closeModal();
        loadAccounts();
    } else {
        showToast("Error: " + res.message, "error");
        shakeModal();
    }
}

function flashCopied(btn) {
    if (!btn) return;
    const icon = btn.querySelector('i');
    const prev = icon.className;
    icon.className = 'fas fa-check';
    btn.classList.add('copied');
    setTimeout(() => {
        icon.className = prev;
        btn.classList.remove('copied');
    }, 1500);
}

function shakeModal() {
    const view = document.getElementById('accountFormView');
    view.classList.add('shake');
    setTimeout(() => view.classList.remove('shake'), 500);
}

async function deleteAccount(username) {
    const ok = await showConfirm(
        "Delete Account",
        `Are you sure you want to delete ${username}? This action cannot be undone.`,
        'danger'
    );
    if (ok) {
        await window.electronAPI.deleteAccount(username);
        // Otherwise a new account later reusing this username would briefly
        // render with this deleted account's stale cached tier/icon/level.
        delete statsCache[username];
        showToast("Account deleted", "success");
        loadAccounts();
    }
}

async function editAccount(username) {
    const accounts = await window.electronAPI.getAccounts();
    const acc = accounts.find(a => a.username === username);
    if (acc) {
        openModal(acc);
    }
}

async function launchAccount(username) {
    if (isLaunching) return;
    isLaunching = true;
    lastLaunchedUsername = username;
    const myToken = ++_launchToken;
    document.getElementById('retryLaunchBtn').style.display = 'none';
    try {
        const res = await window.electronAPI.launchAccount(username);
        // If Cancel was clicked (or a different launch started) while this was
        // in flight, _launchToken has moved on — applying this stale result
        // would overwrite the newer launch's UI state.
        if (myToken !== _launchToken) return;
        if (!res.success) {
            showToast(res.message || "Error launching account", "error");
            document.getElementById('launchStatus').textContent = res.message || 'Launch failed.';
            document.getElementById('retryLaunchBtn').style.display = 'inline-flex';
        } else {
            activeAccountUsername = username;
            renderAccounts();
        }
    } catch (e) {
        console.error(e);
        if (myToken === _launchToken) document.getElementById('retryLaunchBtn').style.display = 'inline-flex';
    } finally {
        if (myToken === _launchToken) isLaunching = false;
    }
}

// ─────────────────────────────────────────────
// Live View
// ─────────────────────────────────────────────

const QUEUE_NAMES = {
    420: 'Ranked Solo/Duo', 440: 'Ranked Flex', 450: 'ARAM',
    400: 'Normal Draft', 430: 'Normal Blind', 900: 'URF',
    1020: 'One for All', 1900: 'URF', 76: 'URF',
    830: 'Co-op vs AI', 840: 'Co-op vs AI', 850: 'Co-op vs AI',
    700: 'Clash', 600: 'Blood Hunt', 1400: 'Ultimate Spellbook',
    1700: 'Arena', 1710: 'Arena',
};

const PHASE_CONFIG = {
    None:             { label: 'Idle',         cls: 'gameflow-idle' },
    Lobby:            { label: 'In Lobby',      cls: 'gameflow-lobby' },
    Matchmaking:      { label: 'In Queue',      cls: 'gameflow-queue' },
    ReadyCheck:       { label: 'Match Found!',  cls: 'gameflow-ready' },
    ChampSelect:      { label: 'Champ Select',  cls: 'gameflow-champselect' },
    InProgress:       { label: 'In Game',       cls: 'gameflow-ingame' },
    WaitingForStats:  { label: 'Post Game',     cls: 'gameflow-postgame' },
    PreEndOfGame:     { label: 'Post Game',     cls: 'gameflow-postgame' },
    EndOfGame:        { label: 'Post Game',     cls: 'gameflow-postgame' },
};

function updateGameflowBadge(phase) {
    const badge = document.getElementById('gameflowBadge');
    if (!badge) return;
    const cfg = PHASE_CONFIG[phase] || { label: phase || 'Idle', cls: 'gameflow-idle' };
    badge.textContent = cfg.label;
    badge.className = `gameflow-badge ${cfg.cls}`;
}

function updateContextButtons(phase) {
    const bar       = document.getElementById('ovActionBar');
    const dodgeBtn  = document.getElementById('ovDodgeBtn');
    const acceptBtn = document.getElementById('ovAcceptBtn');
    if (!bar || !dodgeBtn || !acceptBtn) return;
    const showDodge  = phase === 'ChampSelect';
    const showAccept = phase === 'ReadyCheck';
    dodgeBtn.style.display  = showDodge  ? 'inline-flex' : 'none';
    acceptBtn.style.display = showAccept ? 'inline-flex' : 'none';
    bar.style.display = (showDodge || showAccept) ? 'flex' : 'none';
}

function setLcuOffline() {
    document.getElementById('lcuOffline').style.display = '';
    document.getElementById('lcuOnline').style.display  = 'none';
    updateGameflowBadge(null);
    // If the client disconnects mid-queue/game, loadLiveView()'s own cleanup
    // branch (phase !== Matchmaking/InProgress) never runs — clear here too,
    // otherwise these keep ticking forever after the client closes/crashes.
    clearInterval(window._queueTimerInterval);
    clearInterval(window._gameTimerInterval);
}

function formatDuration(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
}

function tierClass(tier) {
    if (!tier) return 'rank-unranked';
    const t = tier.toLowerCase();
    const valid = ['iron','bronze','silver','gold','platinum','emerald','diamond','master','grandmaster','challenger'];
    return valid.includes(t) ? `rank-${t}` : 'rank-unranked';
}


async function loadLiveView() {
    const data = await window.electronAPI.getLcuOverview();
    if (!data?.connected) { setLcuOffline(); return; }

    document.getElementById('lcuOffline').style.display = 'none';
    document.getElementById('lcuOnline').style.display  = '';

    const { summoner, ranked, gameflow, matches, mastery, honor, ddragonVersion, idToNameMap } = data;

    // ── Summoner banner ────────────────────────────────────────────────────────
    if (summoner) {
        document.getElementById('ovName').textContent  = summoner.displayName || summoner.gameName || summoner.internalName || '—';
        document.getElementById('ovLevel').textContent = summoner.summonerLevel || '?';
        const iconId = summoner.profileIconId;
        if (iconId)
            document.getElementById('ovIcon').src =
                `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/profileicon/${iconId}.png`;
    }

    // Honor badge
    const honorBadge = document.getElementById('ovHonorBadge');
    if (honor?.honorLevel > 0) {
        honorBadge.textContent = `⭐ Honor ${honor.honorLevel}`;
        honorBadge.style.display = '';
    } else {
        honorBadge.style.display = 'none';
    }

    // ── Ranked stats ───────────────────────────────────────────────────────────
    const soloData = ranked?.RANKED_SOLO_5x5
        || ranked?.queues?.find?.(q => q.queueType === 'RANKED_SOLO_5x5');
    const flexData = ranked?.RANKED_FLEX_SR
        || ranked?.queues?.find?.(q => q.queueType === 'RANKED_FLEX_SR');

    function fillRanked(qd, ids, emblemId, primaryBadgeId) {
        const tierEl   = document.getElementById(ids.tier);
        const lpEl     = document.getElementById(ids.lp);
        const barEl    = ids.lpBar ? document.getElementById(ids.lpBar) : null;
        const recEl    = document.getElementById(ids.record);
        const emblemEl = document.getElementById(emblemId);
        const primary  = primaryBadgeId ? document.getElementById(primaryBadgeId) : null;

        const unranked = !qd || !qd.tier || qd.tier === 'NONE' || qd.tier === 'UNRANKED';
        if (unranked) {
            if (tierEl)   { tierEl.textContent = 'Unranked'; tierEl.className = 'ov-ranked-tier rank-unranked'; }
            if (lpEl)     lpEl.textContent = '—';
            if (barEl)    barEl.style.width = '0%';
            if (recEl)    recEl.textContent = '—';
            if (emblemEl) emblemEl.textContent = '—';
            if (primary)  { primary.textContent = 'Unranked'; primary.className = 'summoner-banner-rank rank-unranked'; }
            return;
        }
        const t = cap(qd.tier), div = qd.division || '';
        const tierStr = `${t} ${div}`.trim();
        const rawLp   = qd.leaguePoints ?? 0;
        const lpStr   = `${rawLp} LP`;
        const w = qd.wins || 0, l = qd.losses || 0;
        const wr = w + l > 0 ? ` · ${Math.round(w / (w + l) * 100)}% WR` : '';
        const cls = tierClass(qd.tier);
        const isApex = ['MASTER','GRANDMASTER','CHALLENGER'].includes(qd.tier.toUpperCase());
        if (tierEl)   { tierEl.textContent = tierStr; tierEl.className = `ov-ranked-tier ${cls}`; }
        if (lpEl)     lpEl.textContent = lpStr;
        if (barEl)    barEl.style.width = isApex ? '100%' : `${Math.min(rawLp, 100)}%`;
        if (recEl)    recEl.textContent = `${w}W / ${l}L${wr}`;
        if (emblemEl) emblemEl.textContent = TIER_EMBLEMS[qd.tier.toLowerCase()] || '?';
        if (primary)  { primary.textContent = `${tierStr} · ${lpStr}`; primary.className = `summoner-banner-rank ${cls}`; }
    }

    fillRanked(soloData,
        { tier: 'ovSoloTier', lp: 'ovSoloLP', lpBar: 'ovSoloLpBar', record: 'ovSoloRecord' },
        'ovSoloEmblem', 'ovPrimaryRank');
    fillRanked(flexData,
        { tier: 'ovFlexTier', lp: 'ovFlexLP', lpBar: 'ovFlexLpBar', record: 'ovFlexRecord' },
        'ovFlexEmblem', null);

    // ── Gameflow ───────────────────────────────────────────────────────────────
    if (gameflow) { updateGameflowBadge(gameflow); updateContextButtons(gameflow); }

    // ── Context panel (lobby / queue / in-game) ────────────────────────────────
    const ctxEl      = document.getElementById('ovContext');
    const ctxLobby   = document.getElementById('ovCtxLobby');
    const ctxQueue   = document.getElementById('ovCtxQueue');
    const ctxGame    = document.getElementById('ovCtxGame');
    [ctxLobby, ctxQueue, ctxGame].forEach(el => el && (el.style.display = 'none'));

    if (gameflow === 'Lobby' && data.lobby) {
        ctxEl.style.display = '';
        ctxLobby.style.display = '';
        const qName = QUEUE_NAMES[data.lobby.gameConfig?.queueId] || 'Custom Game';
        document.getElementById('ovCtxLobbyQueue').textContent = qName;
        const membersEl = document.getElementById('ovCtxLobbyMembers');
        membersEl.innerHTML = '';
        (data.lobby.members || []).forEach(m => {
            const chip = document.createElement('span');
            chip.className = 'ov-ctx-member-chip';
            chip.textContent = m.summonerInternalName || m.summonerName || '?';
            membersEl.appendChild(chip);
        });
    } else if (gameflow === 'Matchmaking' && data.queueSearch) {
        ctxEl.style.display = '';
        ctxQueue.style.display = '';
        const qName = QUEUE_NAMES[data.queueSearch.queueId] || 'Queue';
        document.getElementById('ovCtxQueueName').textContent = qName;
        const elapsed = Math.floor(data.queueSearch.timeInQueue || 0);
        const timerEl = document.getElementById('ovCtxQueueTimer');
        timerEl.textContent = formatDuration(elapsed);
        // tick the timer locally
        let secs = elapsed;
        clearInterval(window._queueTimerInterval);
        window._queueTimerInterval = setInterval(() => {
            timerEl.textContent = formatDuration(++secs);
        }, 1000);
        const est = data.queueSearch.estimatedQueueTime;
        document.getElementById('ovCtxQueueEst').textContent =
            est ? `Estimated wait: ~${Math.round(est)}s` : '';
    } else if (gameflow === 'InProgress') {
        ctxEl.style.display = '';
        ctxGame.style.display = '';
        const gameTimerEl = document.getElementById('ovCtxGameTimer');
        if (data.liveGame?.gameTime != null) {
            let secs = Math.floor(data.liveGame.gameTime);
            gameTimerEl.textContent = formatDuration(secs);
            clearInterval(window._gameTimerInterval);
            window._gameTimerInterval = setInterval(() => {
                gameTimerEl.textContent = formatDuration(++secs);
            }, 1000);
            const stats = data.liveGame;
            document.getElementById('ovCtxGameStats').textContent =
                stats ? `${stats.championStats?.currentHealth ?? '?'} / ${stats.championStats?.maxHealth ?? '?'} HP` : '';
        }
    } else {
        ctxEl.style.display = 'none';
        clearInterval(window._queueTimerInterval);
        clearInterval(window._gameTimerInterval);
    }

    // ── Champion mastery ───────────────────────────────────────────────────────
    const masteryEl   = document.getElementById('ovMastery');
    masteryEl.innerHTML = '';
    const masteryList   = Array.isArray(mastery) ? mastery : [];
    if (masteryList.length === 0) {
        masteryEl.innerHTML = `<div class="empty-state" style="padding:30px 0;grid-column:1/-1">
            <div class="empty-icon"><i class="fas fa-hat-wizard"></i></div>
            <p>No mastery data found.</p></div>`;
    } else {
        for (const m of masteryList) {
            const champKey = idToNameMap?.[m.championId];
            const iconSrc  = champKey
                ? `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/champion/${champKey}.png`
                : 'assets/logo.png';
            const lv    = m.championLevel || 0;
            const lvCls = lv >= 10 ? 'mastery-lv10' : lv >= 7 ? 'mastery-lv7' : lv >= 6 ? 'mastery-lv6' : lv >= 5 ? 'mastery-lv5' : 'mastery-lv-other';
            const pts   = m.championPoints >= 1000
                ? (m.championPoints / 1000).toFixed(1) + 'k'
                : (m.championPoints || 0).toString();
            const card = document.createElement('div');
            card.className = 'mastery-card';
            card.innerHTML = `
                <img class="mastery-champ-icon" src="${iconSrc}" onerror="this.src='assets/logo.png'">
                <div class="mastery-champ-name">${champKey || 'Unknown'}</div>
                <div class="mastery-level-badge ${lvCls}">M${lv}</div>
                <div class="mastery-pts">${pts}</div>
            `;
            masteryEl.appendChild(card);
        }
    }

    // ── Match history ──────────────────────────────────────────────────────────
    const matchesEl    = document.getElementById('ovMatches');
    matchesEl.innerHTML = '';
    const games         = Array.isArray(matches) ? matches : [];
    const myAccountId   = summoner?.accountId;
    const myPuuid       = summoner?.puuid;

    if (games.length === 0) {
        matchesEl.innerHTML = `<div class="empty-state" style="padding:40px 0">
            <div class="empty-icon"><i class="fas fa-gamepad"></i></div>
            <p>No recent games found.</p></div>`;
    } else {
        // Summary row
        let totalW = 0, totalL = 0, totalK = 0, totalD = 0, totalA = 0, counted = 0;
        const summaryEl = document.createElement('div');
        summaryEl.className = 'match-summary-row';
        matchesEl.appendChild(summaryEl);

        for (const game of games) {
            let myPId = null;
            const identity = game.participantIdentities?.find(pi =>
                pi.player?.puuid === myPuuid ||
                pi.player?.currentAccountId === myAccountId ||
                pi.player?.accountId === myAccountId
            );
            if (identity) myPId = identity.participantId;
            const participant = myPId
                ? game.participants?.find(p => p.participantId === myPId)
                : game.participants?.[0];
            if (!participant) continue;

            const s   = participant.stats || {};
            const win = s.win === true;
            const k = s.kills || 0, d = s.deaths || 0, a = s.assists || 0;
            const cs  = (s.totalMinionsKilled || 0) + (s.neutralMinionsKilled || 0);
            const dur = game.gameDuration ? formatDuration(game.gameDuration) : '—';
            const csMin = game.gameDuration > 0 ? (cs / (game.gameDuration / 60)).toFixed(1) : null;
            const queue = QUEUE_NAMES[game.queueId] || 'Custom';
            if (win) totalW++; else totalL++;
            totalK += k; totalD += d; totalA += a; counted++;

            const champKey = idToNameMap?.[participant.championId];
            const champSrc = champKey
                ? `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/champion/${champKey}.png`
                : 'assets/logo.png';

            // Items (slots 0-6, 6 = trinket)
            const itemSlots = [s.item0,s.item1,s.item2,s.item3,s.item4,s.item5,s.item6];
            const itemsHtml = itemSlots.map(id =>
                id ? `<img class="match-item-icon" src="https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/item/${id}.png" onerror="this.style.display='none'">`
                   : `<span class="match-item-icon empty"></span>`
            ).join('');

            // Multi-kill badge
            const mk = s.largestMultiKill || 0;
            const mkLabels = ['','','Double','Triple','Quadra','Penta'];
            const mkHtml = mk >= 2
                ? `<span class="match-multikill ${mk >= 5 ? 'penta' : ''}">${mkLabels[mk] || mk+'x'} Kill</span>`
                : '';

            // Vision + damage
            const vs  = s.visionScore != null ? `${s.visionScore} VS` : '';
            const dmg = s.totalDamageDealtToChampions
                ? (s.totalDamageDealtToChampions >= 1000
                    ? (s.totalDamageDealtToChampions / 1000).toFixed(1) + 'k'
                    : s.totalDamageDealtToChampions) + ' dmg'
                : '';

            const item = document.createElement('div');
            item.className = `match-item ${win ? 'win' : 'loss'}`;
            item.innerHTML = `
                <img class="match-champ-icon" src="${champSrc}" onerror="this.src='assets/logo.png'">
                <span class="match-result-badge">${win ? 'WIN' : 'LOSS'}</span>
                <div class="match-main">
                    <div class="match-kda-row">
                        <span class="match-kda">${k} / <span class="kda-d">${d}</span> / ${a}</span>
                        ${mkHtml}
                    </div>
                    <div class="match-sub">
                        <span>${cs} CS${csMin ? ` (${csMin}/m)` : ''}</span>
                        ${vs ? `<span class="match-sub-sep">·</span><span>${vs}</span>` : ''}
                        ${dmg ? `<span class="match-sub-sep">·</span><span>${dmg}</span>` : ''}
                    </div>
                    <div class="match-items">${itemsHtml}</div>
                </div>
                <div class="match-right">
                    <span class="match-queue">${queue}</span>
                    <span class="match-duration">${dur}</span>
                </div>
            `;
            matchesEl.appendChild(item);
        }

        if (counted > 0) {
            const avgK = (totalK / counted).toFixed(1);
            const avgD = (totalD / counted).toFixed(1);
            const avgA = (totalA / counted).toFixed(1);
            const wr   = Math.round(totalW / counted * 100);
            summaryEl.innerHTML = `
                <span class="ms-stat ${totalW > totalL ? 'ms-win' : 'ms-loss'}">${totalW}W ${totalL}L — ${wr}% WR</span>
                <span class="ms-sep">·</span>
                <span class="ms-stat">Avg ${avgK} / ${avgD} / ${avgA}</span>
            `;
        }
    }
}

function cap(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

// ═══════════════════════════════════════════════════════════════════════════
// Stat Viewer — champion base stats (RPG-style sheet) & item gold efficiency
// ═══════════════════════════════════════════════════════════════════════════
let statsViewInitialized = false;
let statsChampList = null;
let statsItemList  = null;
let currentStatsChamp  = null; // { champ, fullData }
let currentStatsLevel  = 1;
let currentStatsItemId = null;

function initStatsView() {
    if (statsViewInitialized) return;
    statsViewInitialized = true;

    document.querySelectorAll('.stats-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.stats-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            document.querySelectorAll('.stats-tab-panel').forEach(p => p.classList.remove('active'));
            document.getElementById(tab.dataset.statsTab).classList.add('active');
        });
    });

    document.getElementById('statsChampSearch').addEventListener('input', (e) => {
        renderStatsChampGrid(e.target.value);
    });
    document.getElementById('statsItemSearch').addEventListener('input', (e) => {
        renderStatsItemGrid(e.target.value);
    });

    loadStatsChamps();
    loadStatsItems();
}

// ── Champions ────────────────────────────────────────────────────────────────

async function loadStatsChamps() {
    if (!champListCache) champListCache = await window.electronAPI.getChampionList();
    statsChampList = champListCache;
    renderStatsChampGrid('');
}

function renderStatsChampGrid(query) {
    const grid = document.getElementById('statsChampGrid');
    if (!statsChampList) return;
    grid.innerHTML = '';
    const q = (query || '').trim().toLowerCase();
    const list = q ? statsChampList.filter(c => c.name.toLowerCase().includes(q)) : statsChampList;

    const count = document.getElementById('statsChampCount');
    if (count) count.textContent = list.length;

    list.forEach(champ => {
        const item = document.createElement('div');
        item.className = 'stats-grid-item' + (currentStatsChamp?.champ.key === champ.key ? ' selected' : '');
        const img = document.createElement('img');
        img.src = champ.iconUrl;
        img.alt = champ.name;
        img.loading = 'lazy';
        img.decoding = 'async';
        img.onerror = () => { img.style.display = 'none'; };
        const span = document.createElement('span');
        span.textContent = champ.name;
        item.appendChild(img);
        item.appendChild(span);
        item.addEventListener('click', () => selectStatsChampion(champ));
        grid.appendChild(item);
    });
}

async function selectStatsChampion(champ) {
    currentStatsLevel = 1;
    const detail = document.getElementById('statsChampDetail');
    detail.innerHTML = `
        <div class="stats-empty">
            <div class="empty-icon"><i class="fas fa-spinner fa-spin"></i></div>
            <p>Loading ${champ.name}…</p>
        </div>`;

    const fullData = await window.electronAPI.getChampionFullData(champ.key);
    if (!fullData) {
        detail.innerHTML = `
            <div class="stats-empty">
                <div class="empty-icon"><i class="fas fa-triangle-exclamation"></i></div>
                <p>No stat data available for ${champ.name}.</p>
            </div>`;
        return;
    }

    currentStatsChamp = { champ, fullData };
    renderStatsChampGrid(document.getElementById('statsChampSearch').value);
    renderStatsChampDetail();
}

// Riot's standard non-linear per-level stat growth curve
function statGrowthFactor(level) {
    return 0.7025 + 0.0175 * (level - 1);
}
function growStat(base, perLevel, level) {
    return base + perLevel * (level - 1) * statGrowthFactor(level);
}

const INFO_BARS = [
    { key: 'attack',     label: 'Attack',     icon: 'fa-khanda' },
    { key: 'defense',    label: 'Defense',    icon: 'fa-shield-halved' },
    { key: 'magic',      label: 'Magic',      icon: 'fa-wand-sparkles' },
    { key: 'difficulty', label: 'Difficulty', icon: 'fa-brain' },
];

// Stat cards are grouped under these headers to give the sheet a clearer
// visual hierarchy than one flat grid of equally-weighted numbers.
const STAT_GROUPS = [
    { key: 'vitality', title: 'Vitality', icon: 'fa-heart' },
    { key: 'offense',  title: 'Offense',  icon: 'fa-khanda' },
    { key: 'defense',  title: 'Defense',  icon: 'fa-shield-halved' },
    { key: 'mobility', title: 'Mobility', icon: 'fa-shoe-prints' },
];

function updateSliderFill(slider) {
    const min = Number(slider.min), max = Number(slider.max), val = Number(slider.value);
    slider.style.setProperty('--pct', `${((val - min) / (max - min)) * 100}%`);
}

function renderStatsChampDetail() {
    const { champ, fullData } = currentStatsChamp;
    const { title, tags, partype, info, stats } = fullData;
    const level = currentStatsLevel;

    const hp       = growStat(stats.hp, stats.hpperlevel, level);
    const hpregen  = growStat(stats.hpregen, stats.hpregenperlevel, level);
    const armor    = growStat(stats.armor, stats.armorperlevel, level);
    const mr       = growStat(stats.spellblock, stats.spellblockperlevel, level);
    const ad       = growStat(stats.attackdamage, stats.attackdamageperlevel, level);
    const asBonus  = stats.attackspeedperlevel * (level - 1) * statGrowthFactor(level);
    const as       = stats.attackspeed * (1 + asBonus / 100);

    const hasResource = (stats.mp > 0 || stats.mpperlevel > 0) && partype && partype !== 'None';
    const mp      = hasResource ? growStat(stats.mp, stats.mpperlevel, level) : 0;
    const mpregen = hasResource ? growStat(stats.mpregen, stats.mpregenperlevel, level) : 0;

    const statCards = [
        { group: 'vitality', icon: 'fa-heart',          label: 'Health',         value: Math.round(hp), primary: true },
        { group: 'vitality', icon: 'fa-heart-pulse',    label: 'HP Regen / 5s',  value: hpregen.toFixed(1) },
        ...(hasResource ? [
            { group: 'vitality', icon: 'fa-droplet',         label: partype,             value: Math.round(mp) },
            { group: 'vitality', icon: 'fa-arrow-rotate-left', label: `${partype} Regen / 5s`, value: mpregen.toFixed(1) },
        ] : []),
        { group: 'offense', icon: 'fa-gavel',  label: 'Attack Damage',  value: ad.toFixed(1), primary: true },
        { group: 'offense', icon: 'fa-bolt',   label: 'Attack Speed',   value: `${as.toFixed(3)} / sec` },
        { group: 'offense', icon: 'fa-star',   label: 'Crit Chance',    value: `${Math.round((stats.crit || 0) + (stats.critperlevel || 0) * (level - 1))}%` },
        { group: 'defense', icon: 'fa-shield-halved', label: 'Armor',        value: armor.toFixed(1), primary: true },
        { group: 'defense', icon: 'fa-hat-wizard',    label: 'Magic Resist', value: mr.toFixed(1) },
        { group: 'mobility', icon: 'fa-shoe-prints', label: 'Move Speed',   value: Math.round(stats.movespeed), primary: true },
        { group: 'mobility', icon: 'fa-crosshairs',  label: 'Attack Range', value: Math.round(stats.attackrange) },
    ];

    const detail = document.getElementById('statsChampDetail');
    detail.innerHTML = `
        <div class="champ-detail-header">
            <img class="champ-detail-icon" src="${champ.iconUrl}" onerror="this.style.display='none'">
            <div class="champ-detail-info">
                <div class="champ-detail-name">${champ.name}</div>
                <div class="champ-detail-title">${title || ''}</div>
                <div class="champ-tags">
                    ${(tags || []).map(t => `<span class="champ-tag">${t}</span>`).join('')}
                </div>
            </div>
        </div>

        <div class="info-bars">
            ${INFO_BARS.map(b => `
                <div class="info-bar-row">
                    <span class="info-bar-label"><i class="fas ${b.icon}"></i> ${b.label}</span>
                    <div class="info-bar-track"><div class="info-bar-fill" style="width:${((info?.[b.key] || 0) / 10) * 100}%"></div></div>
                    <span class="info-bar-val">${info?.[b.key] ?? '—'}/10</span>
                </div>
            `).join('')}
        </div>

        <div class="level-slider-row">
            <label for="statsLevelSlider">Level</label>
            <span class="level-slider-end">1</span>
            <input type="range" id="statsLevelSlider" min="1" max="18" step="1" value="${level}">
            <span class="level-slider-end">18</span>
            <span class="level-slider-val">${level}</span>
        </div>

        ${STAT_GROUPS.map(g => {
            const cards = statCards.filter(c => c.group === g.key);
            if (!cards.length) return '';
            return `
                <div class="stat-group">
                    <div class="stat-group-header ${g.key}"><i class="fas ${g.icon}"></i> ${g.title}</div>
                    <div class="stat-cards-grid">
                        ${cards.map(c => `
                            <div class="stat-card ${g.key}${c.primary ? ' primary' : ''}">
                                <div class="stat-card-icon"><i class="fas ${c.icon}"></i></div>
                                <div class="stat-card-label">${c.label}</div>
                                <div class="stat-card-value">${c.value}</div>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
        }).join('')}
    `;

    const slider = document.getElementById('statsLevelSlider');
    updateSliderFill(slider);
    slider.addEventListener('input', (e) => {
        currentStatsLevel = parseInt(e.target.value);
        renderStatsChampDetail();
    });
}

// ── Items ────────────────────────────────────────────────────────────────────

async function loadStatsItems() {
    statsItemList = await window.electronAPI.getItemList();
    if (!statsItemList || statsItemList.length === 0) {
        setTimeout(async () => {
            statsItemList = await window.electronAPI.getItemList();
            renderStatsItemGrid(document.getElementById('statsItemSearch').value);
        }, 3000);
    }
    renderStatsItemGrid('');
}

function renderStatsItemGrid(query) {
    const grid = document.getElementById('statsItemGrid');
    const count = document.getElementById('statsItemCount');
    if (!statsItemList) return;
    if (statsItemList.length === 0) {
        if (count) count.textContent = '';
        grid.innerHTML = `<div class="stats-empty" style="padding:30px 0"><p>Loading items…</p></div>`;
        return;
    }
    const q = (query || '').trim().toLowerCase();
    const list = q ? statsItemList.filter(i => i.name.toLowerCase().includes(q)) : statsItemList;

    if (count) count.textContent = list.length;

    grid.innerHTML = '';
    list.forEach(item => {
        const el = document.createElement('div');
        el.className = 'stats-grid-item' + (currentStatsItemId === item.id ? ' selected' : '');
        const img = document.createElement('img');
        img.src = item.icon;
        img.alt = item.name;
        img.loading = 'lazy';
        img.decoding = 'async';
        img.onerror = () => { img.style.display = 'none'; };
        const span = document.createElement('span');
        span.textContent = item.name;
        el.appendChild(img);
        el.appendChild(span);
        el.addEventListener('click', () => selectStatsItem(item));
        grid.appendChild(el);
    });
}

function effClass(pct) {
    if (pct >= 100) return 'eff-good';
    if (pct >= 70) return 'eff-ok';
    return 'eff-low';
}

function selectStatsItem(item) {
    currentStatsItemId = item.id;
    renderStatsItemGrid(document.getElementById('statsItemSearch').value);

    const detail = document.getElementById('statsItemDetail');
    const pct = item.efficiency;

    const statRows = item.stats.map(s => `
        <div class="item-stat-row">
            <span class="item-stat-label">${s.label}</span>
            <span class="item-stat-value">+${s.value}${s.unit}</span>
            <span class="item-stat-gold">${s.goldValue}g</span>
        </div>
    `).join('');

    detail.innerHTML = `
        <div class="item-detail-header">
            <img class="item-detail-icon" src="${item.icon}" onerror="this.style.display='none'">
            <div class="item-detail-info">
                <div class="item-detail-name">${item.name}</div>
                <div class="item-gold-row">
                    <span class="gold-badge"><i class="fas fa-coins"></i> ${item.gold.total}</span>
                    ${item.gold.sell ? `<span class="gold-badge sell"><i class="fas fa-arrow-right-arrow-left"></i> ${item.gold.sell}</span>` : ''}
                </div>
                ${item.tags.length ? `
                    <div class="champ-tags item-tags">
                        ${item.tags.map(t => `<span class="champ-tag">${t}</span>`).join('')}
                    </div>
                ` : ''}
            </div>
        </div>

        <div class="efficiency-block">
            <div class="efficiency-label-row">
                <span>Gold Efficiency</span>
                <span class="efficiency-pct ${effClass(pct)}">${pct}%</span>
            </div>
            <div class="efficiency-bar-track">
                <div class="efficiency-bar-fill ${effClass(pct)}" style="width:${Math.min(pct, 100)}%"></div>
            </div>
            <div class="efficiency-note">Based on stat value (${item.statsGoldValue}g) vs. item cost (${item.gold.total}g). Active/passive effects add value beyond raw stats.</div>
        </div>

        ${item.stats.length ? `
            <div class="item-stats-table">
                ${statRows}
            </div>
        ` : ''}

        ${item.descriptionLines.length ? `
            <div class="item-description">
                ${item.descriptionLines.map(l => {
                    const isHeader = l.startsWith('@@') && l.endsWith('@@');
                    return `<div class="${isHeader ? 'item-description-header' : 'item-description-line'}"></div>`;
                }).join('')}
            </div>
        ` : ''}
    `;

    // Description lines are inserted as text content to avoid any markup injection
    if (item.descriptionLines.length) {
        const lines = detail.querySelectorAll('.item-description-header, .item-description-line');
        item.descriptionLines.forEach((line, i) => {
            const isHeader = line.startsWith('@@') && line.endsWith('@@');
            lines[i].textContent = isHeader ? line.slice(2, -2) : line;
        });
    }
}

// Expose
window.launchAccount = launchAccount;
window.editAccount = editAccount;
window.deleteAccount = deleteAccount;
