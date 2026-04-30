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

document.addEventListener('DOMContentLoaded', async () => {
    // Load system info


    // Version
    const version = await window.electronAPI.getVersion();
    const versionEl = document.getElementById('appVersion');
    if (versionEl) versionEl.innerText = `v${version}`;

    try {
        // Load config
        const config = await window.electronAPI.getConfig();
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
        bindSettingToggle('startMinimizedToggle',        'startMinimized',          false);
        bindSettingToggle('checkUpdatesOnStartupToggle', 'checkUpdatesOnStartup',   true);

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

    // Dodge / Accept buttons
    document.getElementById('ovDodgeBtn').addEventListener('click', async () => {
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
    const rankEl = cardEl.querySelector('.rank');
    if (rankEl) {
        const tierName = (stats.tier || 'unranked').split(' ')[0].toLowerCase();
        const valid = ['iron','bronze','silver','gold','platinum','emerald','diamond','master','grandmaster','challenger'];
        const cls = valid.includes(tierName) ? `rank-${tierName}` : 'rank-unranked';
        rankEl.className = `rank ${cls}`;
        const tierDisplay = stats.tier && stats.tier !== 'Unranked' ? stats.tier : 'Unranked';
        rankEl.innerHTML = `<span>${tierDisplay}</span>${stats.lp ? ` • <span>${stats.lp}</span>` : ''}`;
    }
    const iconEl = cardEl.querySelector('.summoner-icon');
    if (iconEl && stats.iconSrc) iconEl.src = stats.iconSrc;

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
    card.className = `account-card${isActive ? ' is-active' : ''}`;

    const defaultIcon = 'assets/logo.png';
    const region = (account.region || '').toUpperCase();
    const lastUsedText = timeAgo(account.lastUsed);

    card.innerHTML = `
        <div class="account-info">
            <div class="summoner-icon-container">
                <img src="${defaultIcon}" class="summoner-icon" onerror="this.src='${defaultIcon}'">
                <span class="level-badge" style="display:none">1</span>
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
                <div class="rank">Loading stats...</div>
                ${account.notes ? '<div class="notes-preview card-notes"></div>' : ''}
            </div>
        </div>
        <div class="card-actions">
            <button class="icon-btn info-btn" title="View Stats"><i class="fas fa-chart-bar"></i></button>
            <button class="icon-btn play-btn" title="Launch"><i class="fas fa-play"></i></button>
            <button class="icon-btn edit-btn" title="Edit"><i class="fas fa-pen"></i></button>
            <button class="icon-btn delete-btn" title="Delete"><i class="fas fa-trash"></i></button>
        </div>
    `;

    card.querySelector('.card-label').textContent = account.label || 'Account';
    card.querySelector('.card-username').textContent = account.username;
    if (account.notes) card.querySelector('.card-notes').textContent = account.notes;

    card.querySelector('.account-info').addEventListener('click', () => launchAccount(account.username));
    card.querySelector('.info-btn').addEventListener('click',   (e) => { e.stopPropagation(); showProfileModal(account.username); });
    card.querySelector('.play-btn').addEventListener('click',   (e) => { e.stopPropagation(); launchAccount(account.username); });
    card.querySelector('.edit-btn').addEventListener('click',   (e) => { e.stopPropagation(); editAccount(account.username); });
    card.querySelector('.delete-btn').addEventListener('click', (e) => { e.stopPropagation(); deleteAccount(account.username); });

    return card;
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
        document.getElementById('autoSpellsToggle').checked = account.autoSpells || false;
        document.getElementById('autoQueueToggle').checked = account.autoQueue || false;
        document.getElementById('minimizeOnLaunchToggle').checked = account.minimizeOnLaunch || false;

        // Per-account auto pick/ban and queue settings
        document.getElementById('newAutoPick').value = account.autoPickChamp || "";
        document.getElementById('newAutoBan').value = account.autoBanChamp || "";
        document.getElementById('queueType').value = account.queueType || 'RANKED_SOLO';
        document.getElementById('primaryRole').value = account.primaryRole || '';
        document.getElementById('secondaryRole').value = account.secondaryRole || '';
        document.getElementById('chatOnDeath').value     = account.chatOnDeath     || '';
        document.getElementById('chatOnKill').value      = account.chatOnKill      || '';
        document.getElementById('chatOnAssist').value    = account.chatOnAssist    || '';
        document.getElementById('chatOnGameStart').value = account.chatOnGameStart || '';

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
        document.getElementById('autoSpellsToggle').checked = false;
        document.getElementById('autoQueueToggle').checked = false;
        document.getElementById('minimizeOnLaunchToggle').checked = false;

        // Reset per-account auto pick/ban and queue settings
        document.getElementById('newAutoPick').value = "";
        document.getElementById('newAutoBan').value = "";
        document.getElementById('queueType').value = 'RANKED_SOLO';
        document.getElementById('primaryRole').value = '';
        document.getElementById('secondaryRole').value = '';
        document.getElementById('chatOnDeath').value     = '';
        document.getElementById('chatOnKill').value      = '';
        document.getElementById('chatOnAssist').value    = '';
        document.getElementById('chatOnGameStart').value = '';

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

    const appearOffline = document.getElementById('appearOfflineToggle').checked;
    const autoSkin = document.getElementById('autoSkinToggle').checked;
    const autoSpells = document.getElementById('autoSpellsToggle').checked;
    const autoQueue = document.getElementById('autoQueueToggle').checked;
    const minimizeOnLaunch = document.getElementById('minimizeOnLaunchToggle').checked;

    // Per-account auto pick/ban and queue settings
    const autoPickChamp = document.getElementById('newAutoPick').value;
    const autoBanChamp = document.getElementById('newAutoBan').value;
    const queueType = document.getElementById('queueType').value;
    const primaryRole = document.getElementById('primaryRole').value;
    const secondaryRole = document.getElementById('secondaryRole').value;
    const chatOnDeath     = document.getElementById('chatOnDeath').value.trim();
    const chatOnKill      = document.getElementById('chatOnKill').value.trim();
    const chatOnAssist    = document.getElementById('chatOnAssist').value.trim();
    const chatOnGameStart = document.getElementById('chatOnGameStart').value.trim();

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
        autoSpells,
        autoQueue,
        autoPickChamp,
        autoBanChamp,
        queueType,
        primaryRole,
        secondaryRole,
        minimizeOnLaunch,
        chatOnDeath,
        chatOnKill,
        chatOnAssist,
        chatOnGameStart,
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
    1020: 'One for All', 1900: 'URF', 76: 'URF'
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
        const recEl    = document.getElementById(ids.record);
        const emblemEl = document.getElementById(emblemId);
        const primary  = primaryBadgeId ? document.getElementById(primaryBadgeId) : null;

        const unranked = !qd || !qd.tier || qd.tier === 'NONE' || qd.tier === 'UNRANKED';
        if (unranked) {
            if (tierEl)   { tierEl.textContent = 'Unranked'; tierEl.className = 'ov-ranked-tier rank-unranked'; }
            if (lpEl)     lpEl.textContent = '—';
            if (recEl)    recEl.textContent = '—';
            if (emblemEl) emblemEl.textContent = '—';
            if (primary)  { primary.textContent = 'Unranked'; primary.className = 'summoner-banner-rank rank-unranked'; }
            return;
        }
        const t = cap(qd.tier), div = qd.division || '';
        const tierStr = `${t} ${div}`.trim();
        const lpStr   = `${qd.leaguePoints ?? 0} LP`;
        const w = qd.wins || 0, l = qd.losses || 0;
        const wr = w + l > 0 ? ` · ${Math.round(w / (w + l) * 100)}% WR` : '';
        const cls = tierClass(qd.tier);
        if (tierEl)   { tierEl.textContent = tierStr; tierEl.className = `ov-ranked-tier ${cls}`; }
        if (lpEl)     lpEl.textContent = lpStr;
        if (recEl)    recEl.textContent = `${w}W / ${l}L${wr}`;
        if (emblemEl) emblemEl.textContent = TIER_EMBLEMS[qd.tier.toLowerCase()] || '?';
        if (primary)  { primary.textContent = `${tierStr} · ${lpStr}`; primary.className = `summoner-banner-rank ${cls}`; }
    }

    fillRanked(soloData,
        { tier: 'ovSoloTier', lp: 'ovSoloLP', record: 'ovSoloRecord' },
        'ovSoloEmblem', 'ovPrimaryRank');
    fillRanked(flexData,
        { tier: 'ovFlexTier', lp: 'ovFlexLP', record: 'ovFlexRecord' },
        'ovFlexEmblem', null);

    // ── Gameflow ───────────────────────────────────────────────────────────────
    if (gameflow) { updateGameflowBadge(gameflow); updateContextButtons(gameflow); }

    // ── Champion mastery ───────────────────────────────────────────────────────
    const masteryEl = document.getElementById('ovMastery');
    masteryEl.innerHTML = '';
    const masteryList = Array.isArray(mastery) ? mastery : [];
    if (masteryList.length === 0) {
        masteryEl.innerHTML = `<div class="empty-state" style="padding:30px 0;grid-column:1/-1">
            <div class="empty-icon"><i class="fas fa-hat-wizard"></i></div>
            <p>No mastery data found.</p></div>`;
    } else {
        for (const m of masteryList.slice(0, 5)) {
            const champKey = idToNameMap?.[m.championId];
            const iconSrc  = champKey
                ? `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/champion/${champKey}.png`
                : 'assets/logo.png';
            const lv = m.championLevel || 0;
            const lvCls = lv >= 7 ? 'mastery-lv7' : lv >= 6 ? 'mastery-lv6' : lv >= 5 ? 'mastery-lv5' : 'mastery-lv-other';
            const pts = m.championPoints ? (m.championPoints >= 1000 ? (m.championPoints / 1000).toFixed(0) + 'k' : m.championPoints) : '?';
            const card = document.createElement('div');
            card.className = 'mastery-card';
            card.innerHTML = `
                <img class="mastery-champ-icon" src="${iconSrc}" onerror="this.src='assets/logo.png'">
                <div class="mastery-champ-name">${champKey || 'Unknown'}</div>
                <div class="mastery-level-badge ${lvCls}">M${lv}</div>
                <div class="mastery-pts">${pts} pts</div>
            `;
            masteryEl.appendChild(card);
        }
    }

    // ── Match history ──────────────────────────────────────────────────────────
    const matchesEl = document.getElementById('ovMatches');
    matchesEl.innerHTML = '';
    const games     = matches?.games?.games || [];
    const myAccountId = summoner?.accountId;
    const myPuuid     = summoner?.puuid;

    if (games.length === 0) {
        matchesEl.innerHTML = `<div class="empty-state" style="padding:40px 0">
            <div class="empty-icon"><i class="fas fa-gamepad"></i></div>
            <p>No recent games found.</p></div>`;
    }

    for (const game of games.slice(0, 10)) {
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

        const s      = participant.stats || {};
        const win    = s.win === true;
        const k = s.kills || 0, d = s.deaths || 0, a = s.assists || 0;
        const cs     = (s.totalMinionsKilled || 0) + (s.neutralMinionsKilled || 0);
        const dur    = game.gameDuration ? formatDuration(game.gameDuration) : '—';
        const csMin  = game.gameDuration > 0 ? (cs / (game.gameDuration / 60)).toFixed(1) : null;
        const queue  = QUEUE_NAMES[game.queueId] || 'Custom';

        const champKey = idToNameMap?.[participant.championId];
        const champSrc = champKey
            ? `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/champion/${champKey}.png`
            : 'assets/logo.png';

        const item = document.createElement('div');
        item.className = `match-item ${win ? 'win' : 'loss'}`;
        item.innerHTML = `
            <img class="match-champ-icon" src="${champSrc}" onerror="this.src='assets/logo.png'">
            <span class="match-result-badge">${win ? 'WIN' : 'LOSS'}</span>
            <div class="match-main">
                <div class="match-kda">${k} / ${d} / ${a}</div>
                <div class="match-sub">
                    <span>${cs} CS</span>
                    ${csMin ? `<span class="match-sub-sep">·</span><span class="match-cs-min">${csMin}/min</span>` : ''}
                </div>
            </div>
            <span class="match-queue">${queue}</span>
            <div class="match-right">
                <span class="match-duration">${dur}</span>
            </div>
        `;
        matchesEl.appendChild(item);
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
