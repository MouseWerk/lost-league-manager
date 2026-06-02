// --- State ---
let isEditing = false;
let isLaunching = false;
let lastLaunchedUsername = null;
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
    if (!config.vaultEnabled || !config.vaultPasswordHash) return;
    return new Promise((resolve) => {
        const lockEl  = document.getElementById('vaultLock');
        const input   = document.getElementById('vaultPasswordInput');
        const errorEl = document.getElementById('vaultError');
        lockEl.style.display = 'flex';
        setTimeout(() => input.focus(), 80);

        async function tryUnlock() {
            if (!input.value) return;
            const hash = await sha256(input.value);
            if (hash === config.vaultPasswordHash) {
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
        await window.electronAPI.cancelLaunch();
    });

    // Retry Launch
    document.getElementById('retryLaunchBtn').addEventListener('click', () => {
        if (lastLaunchedUsername) launchAccount(lastLaunchedUsername);
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

function showView(viewId) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');
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

    toast.innerHTML = `
        <span class="toast-icon">${icon}</span>
        <span class="toast-msg">${message}</span>
    `;

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
    document.getElementById('profileIcon').src    = stats?.iconSrc || defaultIcon;
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
    const iconSrc = account.customAvatar || defaultIcon;
    const region = (account.region || '').toUpperCase();
    const lastUsedText = timeAgo(account.lastUsed);
    const rankDisplay = account.customRank || (account.riotId && account.region ? 'Loading stats...' : '—');

    card.innerHTML = `
        <div class="account-info">
            <div class="summoner-icon-container">
                <img src="${iconSrc}" class="summoner-icon" onerror="this.src='${defaultIcon}'">
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
                <div class="rank">${rankDisplay}</div>
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
            allAccounts.splice(tgtIdx, 0, moved);
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

// Modal Functions
function openModal(account = null) {
    const modal = document.getElementById('addModal');
    modal.classList.add('active');
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
        document.getElementById('newRegion').value = account.region || "euw";

        document.getElementById('appearOfflineToggle').checked = account.appearOffline || false;
        document.getElementById('autoSkinToggle').checked = account.autoSkinRandom || false;
        document.getElementById('autoChampLockInput').value = account.autoChampLock || '';
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
        document.getElementById('newRegion').value = "euw";

        document.getElementById('appearOfflineToggle').checked = false;
        document.getElementById('autoSkinToggle').checked = false;
        document.getElementById('autoChampLockInput').value = '';
        document.getElementById('autoSpellsToggle').checked = false;
        document.getElementById('minimizeOnLaunchToggle').checked = false;
        document.getElementById('isFavouriteToggle').checked = false;
        document.getElementById('newCustomRank').value = '';
        document.getElementById('newCustomAvatar').value = '';

        document.getElementById('newUsername').disabled = false;
    }
}

function closeModal() {
    document.getElementById('addModal').classList.remove('active');
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
    const autoChampLock  = document.getElementById('autoChampLockInput').value.trim();
    const minimizeOnLaunch = document.getElementById('minimizeOnLaunchToggle').checked;

    if (!username) {
        showToast("Username required!", "error");
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

    let res;
    if (isEditing) {
        res = await window.electronAPI.updateAccount(data);
    } else {
        if (!password) {
            showToast("Password required for new account!", "error");
            shakeModal();
            return;
        }
        res = await window.electronAPI.addAccount(data);
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
    const content = document.querySelector('#addModal .modal-content');
    content.classList.add('shake');
    setTimeout(() => content.classList.remove('shake'), 500);
}

async function deleteAccount(username) {
    const ok = await showConfirm(
        "Delete Account",
        `Are you sure you want to delete ${username}? This action cannot be undone.`,
        'danger'
    );
    if (ok) {
        await window.electronAPI.deleteAccount(username);
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
    document.getElementById('retryLaunchBtn').style.display = 'none';
    try {
        const res = await window.electronAPI.launchAccount(username);
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
        document.getElementById('retryLaunchBtn').style.display = 'inline-flex';
    } finally {
        isLaunching = false;
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
    if (!data.connected) { setLcuOffline(); return; }

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

// Expose
window.launchAccount = launchAccount;
window.editAccount = editAccount;
window.deleteAccount = deleteAccount;
