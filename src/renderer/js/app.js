// Initialize
let isEditing = false;
let isLaunching = false;

document.addEventListener('DOMContentLoaded', async () => {
    // Setup listeners FIRST
    setupEventListeners();

    // Version
    const version = "v1.0.0";
    if (document.getElementById('version')) document.getElementById('version').innerText = version;

    try {
        // Load config
        const config = await window.electronAPI.getConfig();
        if (config.lolPath) {
            const pathEl = document.getElementById('lolPathDisplay');
            if (pathEl) pathEl.innerText = config.lolPath;
        }

        // Initialize Auto-Accept Toggle
        const autoAcceptToggle = document.getElementById('autoAcceptToggle');
        if (autoAcceptToggle) {
            autoAcceptToggle.checked = config.autoAccept || false;
            autoAcceptToggle.addEventListener('change', async (e) => {
                await window.electronAPI.setConfig({ autoAccept: e.target.checked });
            });
        }

        // Load accounts
        await loadAccounts();

        // Check for updates on startup
        setTimeout(async () => {
            const update = await window.electronAPI.checkForUpdates();
            if (update && update.updateAvailable) {
                showUpdateBanner(update.url);
            }
        }, 2000);

    } catch (err) {
        console.error("Initialization error:", err);
    }

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
            if (pct > 0) {
                progressEl.style.width = pct + '%';
            }
        } else {
            overlay.classList.remove('active');
            setTimeout(() => {
                progressEl.style.width = '0%';
            }, 500);
        }
    });

    // Listen for external account updates
    window.electronAPI.onAccountsUpdated(() => {
        loadAccounts();
    });

    // Cancel Launch
    document.getElementById('cancelLaunchBtn').addEventListener('click', async () => {
        document.getElementById('launchOverlay').classList.remove('active');
        isLaunching = false;
        await window.electronAPI.cancelLaunch();
    });

    // Tools
    document.getElementById('fixClientBtn').addEventListener('click', async () => {
        const res = await window.electronAPI.fixClient();
        if (res.success) showToast("Client processes killed!", "success");
    });

    document.getElementById('setStatusBtn').addEventListener('click', async () => {
        const msg = document.getElementById('statusMsgInput').value;
        const res = await window.electronAPI.setStatusMessage(msg);
        if (res.success) showToast("Status set!", "success");
        else showToast("Error: " + res.message, "error");
    });

    // Manual update check
    document.getElementById('manualUpdateBtn').addEventListener('click', async (e) => {
        const btn = e.target;
        btn.innerText = "Checking...";
        btn.disabled = true;
        const update = await window.electronAPI.checkForUpdates();
        btn.innerText = "Check for Updates";
        btn.disabled = false;
        if (update && update.updateAvailable) {
            showUpdateBanner(update.url);
        } else {
            showToast("Application is up to date!", "success");
        }
    });
});

/**
 * Shows a premium toast notification
 */
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    let icon = "ℹ️";
    if (type === 'success') icon = "✅";
    if (type === 'error') icon = "❌";

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
    const accounts = await window.electronAPI.getAccounts();
    const list = document.getElementById('accountsList');
    list.innerHTML = '';

    if (accounts.length === 0) {
        const emptyState = document.createElement('div');
        emptyState.className = 'empty-state';
        emptyState.innerHTML = `
            <div class="empty-icon">📂</div>
            <p>No accounts added yet.</p>
            <button class="action-btn" onclick="document.getElementById('addAccountBtn').click()">Add Account</button>
        `;
        list.appendChild(emptyState);
        return;
    }

    for (const acc of accounts) {
        const el = createAccountCard(acc);
        list.appendChild(el);

        // Update stats in background
        if (acc.riotId && acc.region) {
            window.electronAPI.getStats(acc.region, acc.riotId).then(stats => {
                if (stats && stats.tier !== 'Err') {
                    const rankEl = el.querySelector('.rank');
                    if (rankEl) {
                        rankEl.innerHTML = `<span>${stats.tier}</span> • <span>${stats.lp}</span>`;
                    }
                    const iconEl = el.querySelector('.summoner-icon');
                    if (iconEl && stats.iconSrc) {
                        iconEl.src = stats.iconSrc;
                    }
                    const levelEl = el.querySelector('.level-badge');
                    if (levelEl && stats.level) {
                        levelEl.innerText = stats.level;
                        levelEl.style.display = 'block';
                    }
                }
            });
        }
    }
}

function createAccountCard(account) {
    const card = document.createElement('div');
    card.className = 'account-card';

    const defaultIcon = 'assets/logo.png';

    card.innerHTML = `
        <div class="account-info" onclick="launchAccount('${account.username}')">
            <div class="summoner-icon-container">
                <img src="${defaultIcon}" class="summoner-icon" onerror="this.src='${defaultIcon}'">
                <span class="level-badge" style="display:none">1</span>
            </div>
            <div class="text-content">
                <h3>${account.label || 'Account'}</h3>
                <div class="username">${account.username}</div>
                <div class="rank">Loading stats...</div>
                ${account.notes ? `<div class="notes-preview">${account.notes}</div>` : ''}
            </div>
        </div>
        <div class="card-actions">
            <button class="play-btn" onclick="launchAccount('${account.username}')" title="Launch">▶</button>
            <button class="edit-btn" onclick="editAccount('${account.username}')" title="Edit">✎</button>
            <button class="delete-btn" onclick="deleteAccount('${account.username}')" title="Delete">🗑</button>
        </div>
    `;
    return card;
}

function showUpdateBanner(url) {
    const banner = document.getElementById('updateBanner');
    banner.classList.add('active');
    document.getElementById('downloadUpdateBtn').onclick = () => {
        window.open(url, '_blank');
    };
    document.getElementById('closeUpdateBanner').onclick = () => {
        banner.classList.remove('active');
    };
}

function setupEventListeners() {
    const closeBtn = document.getElementById('closeAppBtn');
    if (closeBtn) closeBtn.addEventListener('click', () => window.electronAPI.closeWindow());

    const minBtn = document.getElementById('minBtn');
    if (minBtn) minBtn.addEventListener('click', () => window.electronAPI.minimizeWindow());

    // View Navigation
    const views = {
        accounts: document.getElementById('accountsView'),
        tools: document.getElementById('toolsView'),
        settings: document.getElementById('settingsView')
    };

    function showView(name) {
        Object.values(views).forEach(v => v.classList.remove('active'));
        if (views[name]) views[name].classList.add('active');
    }

    if (document.getElementById('settingsBtn')) {
        document.getElementById('settingsBtn').addEventListener('click', () => showView('settings'));
    }
    if (document.getElementById('toolsBtn')) {
        document.getElementById('toolsBtn').addEventListener('click', () => showView('tools'));
    }
    if (document.getElementById('backBtn')) {
        document.getElementById('backBtn').addEventListener('click', () => showView('accounts'));
    }
    if (document.getElementById('backToolsBtn')) {
        document.getElementById('backToolsBtn').addEventListener('click', () => showView('accounts'));
    }

    // Add Account
    document.getElementById('addAccountBtn').addEventListener('click', openModal);

    // Modal Controls
    document.getElementById('cancelAddBtn').addEventListener('click', closeModal);
    document.getElementById('saveAccountBtn').addEventListener('click', saveAccount);
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
        document.getElementById('newNotes').value = account.note || "";
        document.getElementById('newRiotId').value = account.riotId || "";
        document.getElementById('newRegion').value = account.region || "euw";

        document.getElementById('appearOfflineToggle').checked = account.appearOffline || false;
        document.getElementById('autoSkinToggle').checked = account.autoSkinRandom || false;
        document.getElementById('autoSpellsToggle').checked = account.autoSpells || false;
        document.getElementById('autoQueueToggle').checked = account.autoQueue || false;

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

    if (!username) {
        showToast("Username required!", "error");
        shakeModal();
        return;
    }

    const data = {
        username,
        password,
        label,
        note,
        riotId,
        region,
        appearOffline,
        autoSkinRandom: autoSkin,
        autoSpells,
        autoQueue
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
    const content = document.querySelector('.modal-content');
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
    try {
        const res = await window.electronAPI.launchAccount(username);
        if (!res.success) {
            showToast(res.message || "Error launching account", "error");
            document.getElementById('launchOverlay').classList.remove('active');
        }
    } catch (e) {
        console.error(e);
    } finally {
        isLaunching = false;
    }
}

// Expose
window.launchAccount = launchAccount;
window.editAccount = editAccount;
window.deleteAccount = deleteAccount;
