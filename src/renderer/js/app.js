// Initialize
let isEditing = false;
let isLaunching = false;

document.addEventListener('DOMContentLoaded', async () => {
    // Setup listeners FIRST to ensure buttons work even if data fails
    setupEventListeners();

    // Version
    const version = "v1.1.0";
    if (document.getElementById('version')) document.getElementById('version').innerText = version;

    try {
        // Load config
        const config = await window.electronAPI.getConfig();
        if (config.lol_path) {
            const pathEl = document.getElementById('lolPathDisplay');
            if (pathEl) pathEl.innerText = config.lol_path;
        }

        // Load accounts
        await loadAccounts();
    } catch (err) {
        console.error("Initialization error:", err);
        // Optional: Show error in UI
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

    // Cancel Launch
    document.getElementById('cancelLaunchBtn').addEventListener('click', async () => {
        document.getElementById('launchOverlay').classList.remove('active');
        isLaunching = false;
        await window.electronAPI.cancelLaunch();
    });

    // Tools Listeners
    // Tools Listeners
    document.getElementById('fixClientBtn').addEventListener('click', async () => {
        const res = await window.electronAPI.fixClient();
        if (res.success) alert("Client processes killed!");
    });



    document.getElementById('setStatusBtn').addEventListener('click', async () => {
        const msg = document.getElementById('statusMsgInput').value;
        const res = await window.electronAPI.setStatusMessage(msg);
        if (res.success) alert("Status set!");
        else alert("Error: " + res.message);
    });
});

async function loadAccounts() {
    const accounts = await window.electronAPI.getAccounts();
    const list = document.getElementById('accountsList');
    list.innerHTML = '';

    // Sort accounts? (Optional)

    for (const acc of accounts) {
        // Fetch Stats if Riot ID is present and we don't have fresh data (optional cache logic could go here)
        // For now, let's fetch stats asynchronously to update the card

        // Render basic card first
        const el = createAccountCard(acc);
        list.appendChild(el);

        // Update stats in background
        if (acc.riotId && acc.region) {
            window.electronAPI.getStats(acc.region, acc.riotId).then(stats => {
                if (stats && stats.tier !== 'Err') {
                    // Update the card UI
                    const rankEl = el.querySelector('.rank');
                    const badgeEl = el.querySelector('.level-badge');
                    const iconEl = el.querySelector('.summoner-icon');

                    if (rankEl) rankEl.innerText = `${stats.tier} - ${stats.lp} ${stats.winLose || ''}`;
                    if (badgeEl && stats.level) badgeEl.innerText = `Lv. ${stats.level}`;

                    if (iconEl && stats.iconSrc) {
                        iconEl.src = stats.iconSrc;
                        iconEl.style.display = 'block';
                    }

                    // Ideally we should save these stats to the account in backend so we don't fetch every time
                    // But for now this fixes the "doesn't work" issue visually.
                }
            });
        }
    }
}

function createAccountCard(account) {
    const card = document.createElement('div');
    card.className = 'account-card';

    // Default or cached icon
    let iconSrc = 'assets/logo.png';
    // If we have cached icon stats
    if (account.iconId) {
        iconSrc = `https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/profile-icons/${account.iconId}.jpg`;
    }

    card.innerHTML = `
        <div class="account-info" onclick="launchAccount('${account.username}')">
            <div class="info-row">
                <img src="${iconSrc}" class="summoner-icon" style="display:block" onerror="this.src='assets/logo.png'">
                <div class="text-content">
                    <h3>
                        ${account.label || account.username}
                        <span class="level-badge">Lv. ${account.level || '?'}</span>
                    </h3>
                    <div class="username">${account.riotId || account.username}</div>
                    <div class="rank">${account.rank || 'Unranked'} - ${account.lp || '0 LP'}</div>
                    <div class="notes-preview">${account.note || ''}</div>
                </div>
            </div>
        </div>
        <div class="card-actions">
            <button class="play-btn" onclick="launchAccount('${account.username}')">▶</button>
            <button class="edit-btn" onclick="editAccount('${account.username}')">✎</button>
            <button class="delete-btn" onclick="deleteAccount('${account.username}')">🗑</button>
        </div>
    `;
    return card;
}

function setupEventListeners() {
    // Window Controls
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
    document.getElementById('addAccountBtn').addEventListener('click', () => {
        openModal();
    });

    // Modal Controls
    document.getElementById('cancelAddBtn').addEventListener('click', closeModal);
    document.getElementById('saveAccountBtn').addEventListener('click', saveAccount);

    // Settings / Tools Toggle
    const toolsBtn = document.getElementById('toolsBtn');
    if (toolsBtn) {
        // Implementation for tools toggle if needed, or handled by layout
    }
}

// Modal Functions
function openModal(account = null) {
    const modal = document.getElementById('addModal');
    modal.classList.add('active');

    if (account) {
        isEditing = true;
        document.getElementById('modalTitle').innerText = "Edit Account";
        document.getElementById('newUsername').value = account.username;
        document.getElementById('newPassword').value = ""; // Don't show password
        document.getElementById('newPassword').placeholder = "Unchanged";
        document.getElementById('newLabel').value = account.label || "";
        document.getElementById('newNotes').value = account.note || "";
        document.getElementById('newRiotId').value = account.riotId || "";
        document.getElementById('newRegion').value = account.region || "EUW";

        // Toggles
        document.getElementById('appearOfflineToggle').checked = account.appearOffline || false;
        document.getElementById('autoSkinToggle').checked = account.autoSkinRandom || false;
        document.getElementById('autoSpellsToggle').checked = account.autoSpells || false;
        document.getElementById('autoQueueToggle').checked = account.autoQueue || false;

        document.getElementById('newUsername').disabled = true; // Cannot change username key
    } else {
        isEditing = false;
        document.getElementById('modalTitle').innerText = "New Account";
        document.getElementById('newUsername').value = "";
        document.getElementById('newPassword').value = "";
        document.getElementById('newPassword').placeholder = "Passwort";
        document.getElementById('newLabel').value = "";
        document.getElementById('newNotes').value = "";
        document.getElementById('newRiotId').value = "";
        document.getElementById('newRegion').value = "EUW";

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
        alert("Username required!");
        return;
    }

    const data = {
        username,
        password, // Might be empty if editing
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
            alert("Password required for new account!");
            return;
        }
        res = await window.electronAPI.addAccount(data);
    }

    if (res.success) {
        closeModal();
        loadAccounts();
    } else {
        alert("Error: " + res.message);
    }
}

async function deleteAccount(username) {
    if (confirm("Wirklich löschen?")) {
        await window.electronAPI.deleteAccount(username);
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

    const overlay = document.getElementById('launchOverlay');
    const statusEl = document.getElementById('launchStatus');
    const progressEl = document.getElementById('launchProgress');

    statusEl.textContent = "Initializing...";
    overlay.classList.add('active');
    progressEl.style.width = '5%';

    try {
        const res = await window.electronAPI.launchAccount(username);
        if (!res.success) {
            alert(res.message || "Fehler beim Starten");
            overlay.classList.remove('active');
        }
    } catch (e) {
        console.error(e);
        overlay.classList.remove('active');
    } finally {
        isLaunching = false;
    }
}

// Expose to window for onclick handlers
window.launchAccount = launchAccount;
window.editAccount = editAccount;
window.deleteAccount = deleteAccount;
