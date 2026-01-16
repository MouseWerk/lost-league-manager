const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const axios = require('axios');
const cheerio = require('cheerio');
const lcu = require('./lcu');
const yaml = require('js-yaml');
const { autoUpdater } = require('electron-updater');

// Set Application ID for Windows Jump Lists
app.setAppUserModelId('com.lostgames.leaguelogin');

// --- Configuration ---
const APP_DATA_PATH = app.getPath('userData');
const ACCOUNTS_FILE = path.join(APP_DATA_PATH, 'accounts.json');
const CONFIG_FILE = path.join(APP_DATA_PATH, 'config.json');
let RESOURCES_PATH;
if (app.isPackaged) {
    // Check multiple potential locations for the script
    const nested = path.join(process.resourcesPath, 'resources');
    const flat = process.resourcesPath;

    if (fs.existsSync(path.join(nested, 'scripts', 'login.ps1'))) {
        RESOURCES_PATH = nested;
    } else {
        RESOURCES_PATH = flat;
    }
} else {
    RESOURCES_PATH = path.join(__dirname, '../../resources');
}

// Encryption Key
const SECRET_KEY = crypto.scryptSync('lost-league-manager-secret', 'salt', 32);
const ALGORITHM = 'aes-256-cbc';

// --- State ---
let mainWindow;
let currentAccount = null;
let championMap = {};
let latestDDragonVersion = '14.1.1'; // Default fallback
let skinsMap = {}; // ChampID -> [Skins]
let idToImageMap = {};
let lcuQueueCheckInterval = null;

let config = {
    lolPath: "C:\\Riot Games\\League of Legends\\LeagueClient.exe",
    autoAccept: false
};

// --- Single Instance Lock ---
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        // Someone tried to run a second instance, we should focus our window.
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }

        // Check for launch argument
        const launchArg = commandLine.find(arg => arg.startsWith('--launch='));
        if (launchArg) {
            const username = launchArg.split('=')[1];
            executeAccountLaunch(username);
        }
    });
}

// --- Helpers ---
/**
 * Encrypts a text string using AES-256-CBC.
 * @param {string} text - The text to encrypt.
 * @returns {string} The IV and encrypted text joined by ':', or null on failure.
 */
function encrypt(text) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, SECRET_KEY, iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text) {
    try {
        const textParts = text.split(':');
        const iv = Buffer.from(textParts.shift(), 'hex');
        const encryptedText = Buffer.from(textParts.join(':'), 'hex');
        const decipher = crypto.createDecipheriv(ALGORITHM, SECRET_KEY, iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString();
    } catch (e) {
        return null;
    }
}

function loadConfig() {
    if (fs.existsSync(CONFIG_FILE)) {
        try {
            config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE)) };
        } catch (e) { }
    }
}

function saveConfig() {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 4));
}

function loadAccounts() {
    if (fs.existsSync(ACCOUNTS_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(ACCOUNTS_FILE));
        } catch (e) { }
    }
    return [];
}

function saveAccounts(accounts) {
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 4));
}

/**
 * Fetches the latest champion data from Data Dragon.
 * Populates the `championMap` for name-to-ID lookups.
 */
async function fetchChampionData() {
    try {
        const ver = await axios.get("https://ddragon.leagueoflegends.com/api/versions.json");
        const latest = ver.data[0];
        latestDDragonVersion = latest; // Update global version

        const res = await axios.get(`https://ddragon.leagueoflegends.com/cdn/${latest}/data/en_US/champion.json`);
        const data = res.data.data;
        for (const key in data) {
            const champ = data[key];
            championMap[champ.name.toLowerCase()] = parseInt(champ.key);
            idToImageMap[champ.key] = `https://ddragon.leagueoflegends.com/cdn/${latest}/img/champion/${champ.id}.png`;
        }
    } catch (e) {
        console.error("Failed to fetch champion data");
    }
}

// --- LCU Logic ---

/**
 * Periodically checks the LCU gameflow phase and handles auto-queue/role selection.
 */
async function checkGameFlowAndQueue() {
    if (!currentAccount || !currentAccount.autoQueue) return;

    try {
        const phase = await lcu.request('GET', '/lol-gameflow/v1/gameflow-phase');
        if (phase === 'None') {
            // 1. Create Lobby
            console.log("Creating Lobby...");
            const queueId = currentAccount.queueType === 'RANKED_SOLO' ? 420 : 440;
            await lcu.request('POST', '/lol-lobby/v2/lobby', { queueId });
        } else if (phase === 'Lobby') {
            // 2. Set Roles (If in lobby)
            if (currentAccount.primaryRole && currentAccount.secondaryRole) {
                console.log("Setting Roles...");
                await lcu.request('PUT', '/lol-lobby/v2/lobby/members/localMember/position-preferences', {
                    firstPreference: currentAccount.primaryRole,
                    secondPreference: currentAccount.secondaryRole
                });
            }

            // 3. Start Search
            console.log("Starting Search...");
            const res = await lcu.request('POST', '/lol-lobby/v2/lobby/matchmaking/search');

            // If successful (or already searching), disable auto queue
            if (res) {
                console.log("Auto Queue Started. Disabling flag.");
                currentAccount.autoQueue = false;
            }
        }
    } catch (e) {
    }
}

async function setAppearOffline() {
    if (currentAccount && currentAccount.appearOffline) {
        try {
            await lcu.request('PUT', '/lol-chat/v1/me', { availability: "offline" });
        } catch (e) { }
    }
}

lcu.onEvent(async (event) => {
    // Auto Accept
    if (config.autoAccept) {
        if (event.uri === '/lol-matchmaking/v1/ready-check') {
            const data = event.data;
            if (data && data.state === 'InProgress' && data.playerResponse === 'None') {
                console.log("Match Found! Accepting via API...");
                await lcu.request('POST', '/lol-matchmaking/v1/ready-check/accept');
            }
        }
    }

    // Chat Connection -> Appear Offline
    if (event.uri === '/lol-chat/v1/me' && event.eventType === 'Update') {
        // Enforce offline if enabled and not already offline
        if (currentAccount && currentAccount.appearOffline && event.data.availability !== 'offline') {
            setAppearOffline();
        }
    }

    // Champ Select - Notify Frontend
    if (event.uri === '/lol-champ-select/v1/session') {
        if (event.eventType === 'Update' || event.eventType === 'Create') {
            if (mainWindow) mainWindow.webContents.send('champ-select-update', event.data);
        } else if (event.eventType === 'Delete') {
            if (mainWindow) mainWindow.webContents.send('champ-select-end');
        }
    }

    // Auto Pick/Ban/Skin
    if (!currentAccount) return;
    if (event.uri !== '/lol-champ-select/v1/session') return;
    if (event.eventType !== 'Update') return;

    const session = event.data;
    const localCellId = session.localPlayerCellId;
    const actions = session.actions;

    const findMyAction = (type) => {
        for (const phase of actions) {
            for (const action of phase) {
                if (action.actorCellId === localCellId && action.type === type && !action.completed && action.isInProgress) {
                    return action;
                }
            }
        }
        return null;
    };

    if (currentAccount.autoBanChamp) {
        const banAction = findMyAction('ban');
        if (banAction) {
            const champId = championMap[currentAccount.autoBanChamp.toLowerCase()];
            if (champId) {
                await lcu.request('PATCH', `/lol-champ-select/v1/session/actions/${banAction.id}`, { championId: champId, completed: true });
            }
        }
    }

    if (currentAccount.autoPickChamp) {
        const pickAction = findMyAction('pick');
        if (pickAction) {
            const champId = championMap[currentAccount.autoPickChamp.toLowerCase()];
            if (champId) {
                await lcu.request('PATCH', `/lol-champ-select/v1/session/actions/${pickAction.id}`, { championId: champId, completed: true });
            }
        }
    }

    // Auto Skin (Random)
    if (currentAccount.autoSkinRandom) {
        // Check if we have locked in a pick
        // We can check if 'pick' action is completed
        const myPick = actions.flat().find(a => a.actorCellId === localCellId && a.type === 'pick' && a.completed);
        if (myPick) {
            // Get my skins
            // We need to fetch skins for this champ.
            // We can use /lol-champ-select/v1/skin-carousel-skins
            try {
                const skins = await lcu.request('GET', '/lol-champ-select/v1/skin-carousel-skins');
                if (skins && skins.length > 0) {
                    const owned = skins.filter(s => s.ownership.owned);
                    if (owned.length > 0) {
                        const randomSkin = owned[Math.floor(Math.random() * owned.length)];
                        await lcu.request('PATCH', '/lol-champ-select/v1/session/my-selection', { selectedSkinId: randomSkin.id });
                    }
                }
            } catch (e) { }
        }
    }
});


// --- App Lifecycle ---

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1100,
        height: 620,
        frame: false,
        transparent: true,
        resizable: false,
        icon: path.join(__dirname, '../renderer/assets/logo.ico'),
        webPreferences: {
            preload: path.join(__dirname, '../preload/preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(async () => {
    loadConfig();
    await fetchChampionData();
    lcu.start();
    createWindow();
    updateJumpList();

    // Check if launched via arg
    const launchArg = process.argv.find(arg => arg.startsWith('--launch='));
    if (launchArg) {
        const username = launchArg.split('=')[1];
        executeAccountLaunch(username);
    }

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    setInterval(() => lcu.connect(config.lolPath), 5000);
    setInterval(checkGameFlowAndQueue, 3000);
});

function updateJumpList() {
    if (process.platform !== 'win32') return;

    const accounts = loadAccounts();
    const tasks = accounts.slice(0, 5).map(acc => {
        // In development, we need to pass the app path ('.') as the first argument
        let args = `--launch=${acc.username}`;
        if (!app.isPackaged) {
            args = `. --launch=${acc.username}`;
        }

        return {
            program: process.execPath,
            arguments: args,
            iconPath: process.execPath,
            iconIndex: 0,
            title: `Launch ${acc.label || acc.username}`,
            description: `Login to ${acc.label || acc.username}`
        };
    });

    try {
        const res = app.setUserTasks(tasks);
        console.log("Jump List updated:", res);
    } catch (e) {
        console.error("Failed to set Jump List tasks:", e);
    }
}

app.on('window-all-closed', function () {
    lcu.stop();
    if (process.platform !== 'darwin') app.quit();
});

// --- IPC Handlers ---

ipcMain.handle('window-control', (event, action) => {
    if (!mainWindow) return;
    if (action === 'close') mainWindow.close();
    if (action === 'minimize') mainWindow.minimize();
});

ipcMain.handle('get-accounts', () => {
    const accounts = loadAccounts();
    return accounts.map(a => ({ ...a, password: '' }));
});

function broadcastAccountsUpdate() {
    const windows = BrowserWindow.getAllWindows();
    windows.forEach(win => {
        if (!win.isDestroyed()) {
            win.webContents.send('accounts-updated');
        }
    });
}

ipcMain.handle('add-account', (event, data) => {
    const accounts = loadAccounts();
    if (accounts.find(a => a.username === data.username)) {
        return { success: false, message: "Account exists" };
    }

    accounts.push({
        username: data.username,
        password: encrypt(data.password),
        label: data.label,
        riotId: data.riotId,
        region: data.region,
        autoPickChamp: data.autoPickChamp || "",
        autoBanChamp: data.autoBanChamp || "",
        notes: data.notes || "",
        autoQueue: data.autoQueue || false,
        queueType: data.queueType || 'RANKED_SOLO',
        primaryRole: data.primaryRole || '',
        secondaryRole: data.secondaryRole || '',
        appearOffline: data.appearOffline || false,
        autoSkinRandom: data.autoSkinRandom || false,
        autoSpells: data.autoSpells || false
    });

    saveAccounts(accounts);
    broadcastAccountsUpdate();
    updateJumpList();
    return { success: true };
});

ipcMain.handle('update-account', (event, data) => {
    let accounts = loadAccounts();
    const index = accounts.findIndex(a => a.username === data.username);
    if (index === -1) return { success: false, message: "Account not found" };

    const oldAcc = accounts[index];
    accounts[index] = {
        ...oldAcc,
        label: data.label || oldAcc.label,
        riotId: data.riotId || oldAcc.riotId,
        region: data.region || oldAcc.region,
        autoPickChamp: data.autoPickChamp !== undefined ? data.autoPickChamp : oldAcc.autoPickChamp,
        autoBanChamp: data.autoBanChamp !== undefined ? data.autoBanChamp : oldAcc.autoBanChamp,
        notes: data.notes !== undefined ? data.notes : oldAcc.notes,
        autoQueue: data.autoQueue !== undefined ? data.autoQueue : oldAcc.autoQueue,
        queueType: data.queueType !== undefined ? data.queueType : oldAcc.queueType,
        primaryRole: data.primaryRole !== undefined ? data.primaryRole : oldAcc.primaryRole,
        secondaryRole: data.secondaryRole !== undefined ? data.secondaryRole : oldAcc.secondaryRole,
        appearOffline: data.appearOffline !== undefined ? data.appearOffline : oldAcc.appearOffline,
        autoSkinRandom: data.autoSkinRandom !== undefined ? data.autoSkinRandom : oldAcc.autoSkinRandom,
        autoSpells: data.autoSpells !== undefined ? data.autoSpells : oldAcc.autoSpells
    };

    if (data.password) {
        accounts[index].password = encrypt(data.password);
    }

    saveAccounts(accounts);
    broadcastAccountsUpdate();
    updateJumpList();
    return { success: true };
});


ipcMain.handle('delete-account', (event, username) => {
    let accounts = loadAccounts();
    accounts = accounts.filter(a => a.username !== username);
    saveAccounts(accounts);
    broadcastAccountsUpdate();
    updateJumpList();
    return { success: true };
});

ipcMain.handle('get-config', () => config);

ipcMain.handle('set-config', (event, newConfig) => {
    config = { ...config, ...newConfig };
    saveConfig();
    return { success: true };
});

ipcMain.handle('launch-account', async (event, username) => {
    return await executeAccountLaunch(username);
});

async function executeAccountLaunch(username) {
    console.log(`Launching account: ${username}`);
    const accounts = loadAccounts();
    const account = accounts.find(a => a.username === username);
    if (!account) return { success: false, message: "Account not found" };

    // Send immediate update to ensure UI doesn't hang on "Initializing..."
    if (mainWindow) mainWindow.webContents.send('login-status', { message: 'Preparing...', progress: 5 });

    const password = decrypt(account.password);
    if (!password) return { success: false, message: "Password error" };

    currentAccount = { ...account };

    // Short delay to allow UI to update
    await new Promise(r => setTimeout(r, 100));

    if (mainWindow) mainWindow.webContents.send('login-status', { message: 'Killing League Processes...', progress: 10 });

    const killScript = `
        Get-Process -Name LeagueClient, LeagueClientUx, RiotClientServices, RiotClientUx -ErrorAction SilentlyContinue | Stop-Process -Force
    `;
    spawn('powershell.exe', ['-Command', killScript]);

    await new Promise(r => setTimeout(r, 2000));

    if (mainWindow) mainWindow.webContents.send('login-status', { message: 'Launching Riot Client...', progress: 30 });

    let launchCmd = `& "${config.lolPath}"`;

    // Improved Riot Client Discovery
    let riotClientPath = path.join(path.dirname(path.dirname(config.lolPath)), "Riot Client", "RiotClientServices.exe");

    if (!fs.existsSync(riotClientPath)) {
        // Check default C: location
        const defaultPath = "C:\\Riot Games\\Riot Client\\RiotClientServices.exe";
        if (fs.existsSync(defaultPath)) riotClientPath = defaultPath;
    }

    if (!fs.existsSync(riotClientPath)) {
        // Check default D: location
        const defaultPathD = "D:\\Riot Games\\Riot Client\\RiotClientServices.exe";
        if (fs.existsSync(defaultPathD)) riotClientPath = defaultPathD;
    }

    if (fs.existsSync(riotClientPath)) {
        launchCmd = `& "${riotClientPath}" --launch-product=league_of_legends --launch-patchline=live`;
    }

    spawn('powershell.exe', ['-Command', launchCmd]);

    if (mainWindow) mainWindow.webContents.send('login-status', { message: 'Waiting for Client Window...', progress: 50 });

    const loginScriptPath = path.join(RESOURCES_PATH, 'scripts', 'login.ps1');

    // Store current login child process
    if (currentAccount.loginChild) {
        try { currentAccount.loginChild.kill(); } catch (e) { }
    }

    const child = spawn('powershell.exe', [
        '-ExecutionPolicy', 'Bypass',
        '-File', loginScriptPath,
        '-Username', account.username,
        '-Password', password
    ]);

    currentAccount.loginChild = child;

    child.stdout.on('data', (data) => {
        if (mainWindow) mainWindow.webContents.send('login-status', { message: 'Logging in...', progress: 80 });
    });

    child.on('close', (code) => {
        currentAccount.loginChild = null;
        if (code !== 0 && code !== null) { // If killed, code might be null or specific signal
            // Handle cancellation if needed, but usually we just stop sending status
        } else {
            if (mainWindow) mainWindow.webContents.send('login-status', { message: 'Done! (Logs might take a moment)', progress: 100 });
            setTimeout(() => {
                if (mainWindow) mainWindow.webContents.send('login-status', null);
            }, 3000);
        }
    });

    return { success: true };
}

ipcMain.handle('cancel-launch', () => {
    if (currentAccount && currentAccount.loginChild) {
        try {
            currentAccount.loginChild.kill();
            console.log("Login process killed by user.");
        } catch (e) {
            console.error("Failed to kill login process:", e);
        }
        currentAccount.loginChild = null;
        return { success: true };
    }
    return { success: false, message: "No active login process" };
});

/**
 * Scrapes OP.GG for summoner statistics (Tier, LP, Winrate).
 * Uses local Riot ID to construct the URL.
 */
ipcMain.handle('get-stats', async (event, { region, riotId }) => {
    if (!riotId || !riotId.includes('#')) return { tier: "N/A" };

    try {
        const [name, tag] = riotId.trim().split('#');
        // Region must be lowercase for OP.GG
        // URL Format: https://www.op.gg/summoners/euw/Name-Tag
        const url = `https://www.op.gg/summoners/${region.toLowerCase()}/${encodeURIComponent(name)}-${tag}`;

        console.log(`Fetching Stats for: ${url}`);

        const response = await axios.get(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept-Language": "en-US,en;q=0.9",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8"
            }
        });

        const $ = cheerio.load(response.data);
        let tier = "Unranked";
        let lp = "";
        let winLose = "";
        let ratio = "";
        let iconSrc = "";
        let level = "";
        let matchHistory = [];
        let topChampions = [];

        // --- JSON Strategy (Preferred) ---
        const nextData = $('#__NEXT_DATA__').html();
        if (nextData) {
            try {
                const json = JSON.parse(nextData);
                const data = json.props?.pageProps?.data;

                if (data) {
                    // 1. Rank (Solo Duo)
                    const stats = data.league_stats || data.summoner?.league_stats || [];
                    if (Array.isArray(stats)) {
                        // Look for Solo/Duo queue (ID 420 or keyword match)
                        const solo = stats.find(s =>
                            s.queue_info?.queue_translate?.toLowerCase().includes('solo') ||
                            s.queue_info?.id === 420 ||
                            s.queue_info?.queue_type === 'SOLORANKED'
                        );

                        if (solo && (solo.tier_info || solo.tier)) {
                            const info = solo.tier_info || solo;
                            const division = info.division || info.rank || "";
                            tier = `${info.tier} ${division}`.trim();
                            lp = `${info.lp ?? 0} LP`;
                            winLose = `${solo.win || 0}W ${solo.lose || 0}L`;
                            const total = (solo.win || 0) + (solo.lose || 0);
                            if (total > 0) {
                                ratio = Math.round((solo.win / total) * 100) + "%";
                            }
                        }
                    }

                    // 2. Icon
                    let pid = data.profile_icon_id ||
                        data.league_stats?.[0]?.summoner?.profile_icon_id ||
                        data.summoner?.profile_icon_id;
                    if (pid) {
                        iconSrc = `https://ddragon.leagueoflegends.com/cdn/${latestDDragonVersion}/img/profileicon/${pid}.png`;
                    }

                    // 3. Level
                    let lvl = data.level || data.summoner?.level || data.league_stats?.[0]?.summoner?.level;
                    if (lvl) level = lvl.toString();

                    // 4. Match History
                    if (data.games && Array.isArray(data.games)) {
                        matchHistory = data.games.slice(0, 10).map(g => {
                            const stats = g.myData?.stats || {};
                            return {
                                championId: g.myData?.champion_id,
                                championImage: g.myData?.champion_info?.image_url || idToImageMap[g.myData?.champion_id],
                                result: stats.result || "UNKNOWN",
                                kda: `${stats.kill || 0}/${stats.death || 0}/${stats.assist || 0}`,
                                date: g.created_at
                            };
                        });
                    }

                    // 5. Top Champions
                    if (data.champion_stats && Array.isArray(data.champion_stats)) {
                        topChampions = data.champion_stats.slice(0, 3).map(c => ({
                            name: c.champion_info?.name || "Champ",
                            image: c.champion_info?.image_url || idToImageMap[c.id],
                            winRate: Math.round((c.win / (c.win + c.lose || 1)) * 100),
                            games: c.win + c.lose
                        }));
                    }
                }
            } catch (e) {
                console.error("JSON Parse Error in Stats:", e.message);
            }
        }

        // --- Meta Description Strategy (Robust for Level) ---
        // "Hide on bush#KR1 / Lv. 870"
        if (!level) {
            const desc = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content');
            if (desc) {
                const match = desc.match(/Lv\. (\d+)/);
                if (match) level = match[1];
            }
        }

        // --- Fallback Strategy (HTML Selectors) ---

        if (tier === "Unranked") {
            const tierEl = $('.tier').first();
            if (tierEl.length) tier = tierEl.text().trim();
            else {
                // Try finding "Ranked Solo" header
                const header = $('div').filter((i, el) => $(el).text().trim() === 'Ranked Solo/Duo').first();
                if (header.length) {
                    const content = header.parent().text();
                    // More robust regex: accounts for Master/Grandmaster/Challenger which don't have divisions
                    const match = content.match(/(Iron|Bronze|Silver|Gold|Platinum|Emerald|Diamond|Master|Grandmaster|Challenger)(?:\s+([1-4]))?/i);
                    if (match) {
                        tier = match[1] + (match[2] ? " " + match[2] : "");
                    }
                }
            }
        }

        if (!lp) lp = $('.lp').text().trim();
        if (!winLose) winLose = $('.win-lose').text().trim();
        if (!ratio) ratio = $('.ratio').text().trim();
        if (!level) level = $('.level').text().trim();

        // Icon Fallback (Image Search)
        if (!iconSrc) {
            $('img').each((i, el) => {
                const src = $(el).attr('src');
                if (src && /profile_?icon/i.test(src)) {
                    iconSrc = src;
                    return false;
                }
            });
        }

        // Final Icon Fallback
        if (!iconSrc) {
            iconSrc = `https://ddragon.leagueoflegends.com/cdn/${latestDDragonVersion}/img/profileicon/29.png`;
        }

        return {
            success: true,
            tier,
            lp,
            winLose,
            ratio,
            iconSrc,
            level,
            matchHistory,
            topChampions
        };
    } catch (e) {
        console.error("OP.GG Fetch Error:", e.message);
        return { tier: "Err" };
    }
});

ipcMain.handle('accept-match', async () => {
    try {
        await lcu.request('POST', '/lol-matchmaking/v1/ready-check/accept');
        return { success: true };
    } catch (e) {
        return { success: false, message: e.message };
    }
});

ipcMain.handle('change-language', async (event, locale) => {
    try {
        const gameDir = path.dirname(config.lolPath);
        const settingsPath = path.join(gameDir, 'Config', 'LeagueClientSettings.yaml');

        if (!fs.existsSync(settingsPath)) {
            return { success: false, message: "Config not found at " + settingsPath };
        }

        let content = fs.readFileSync(settingsPath, 'utf8');
        const regex = /locale: ".*?"/;
        if (regex.test(content)) {
            content = content.replace(regex, `locale: "${locale}"`);
            fs.writeFileSync(settingsPath, content);
            return { success: true };
        } else {
            return { success: false, message: "Locale key not found" };
        }
    } catch (e) {
        return { success: false, message: e.message };
    }
});

ipcMain.handle('dodge-queue', async () => {
    try {
        const killScript = `Get-Process -Name LeagueClient, LeagueClientUx -ErrorAction SilentlyContinue | Stop-Process -Force`;
        spawn('powershell.exe', ['-Command', killScript]);
        return { success: true };
    } catch (e) {
        return { success: false, message: e.message };
    }
});

ipcMain.handle('get-lobby-members', async () => {
    try {
        const session = await lcu.request('GET', '/lol-champ-select/v1/session');
        if (!session) return { success: false, message: "No session" };

        const members = session.myTeam; // Array of objects

        const names = [];
        for (const m of members) {
            if (m.summonerId && m.summonerId > 0) {
                try {
                    const summ = await lcu.request('GET', `/lol-summoner/v1/summoners/${m.summonerId}`);
                    if (summ && summ.gameName) {
                        names.push(`${summ.gameName}#${summ.tagLine}`);
                    }
                } catch (e) { }
            }
        }

        return { success: true, names };
    } catch (e) {
        return { success: false, message: e.message };
    }
});

ipcMain.handle('fix-client', async () => {
    const killScript = `Get-Process -Name LeagueClient, LeagueClientUx, RiotClientServices, RiotClientUx -ErrorAction SilentlyContinue | Stop-Process -Force`;
    spawn('powershell.exe', ['-Command', killScript]);
    return { success: true };
});

ipcMain.handle('set-profile-background', async (event, { championName, skinId }) => {
    // 1. Get Summoner ID
    try {
        const me = await lcu.request('GET', '/lol-summoner/v1/current-summoner');
        if (!me) return { success: false, message: "Not logged in" };

        // 2. Resolve Skin
        if (!skinId) {
            // Find champ id from map
            const champId = championMap[championName.toLowerCase()];
            if (!champId) return { success: false, message: "Champion not found" };
            // Use default skin (champId * 1000)
            skinId = champId * 1000;
        }

        await lcu.request('POST', '/lol-summoner/v1/current-summoner/summoner-profile', {
            key: "backgroundSkinId",
            value: parseInt(skinId)
        });

        return { success: true };

    } catch (e) {
        return { success: false, message: e.message };
    }
});

ipcMain.handle('set-status-message', async (event, message) => {
    try {
        await lcu.request('PUT', '/lol-chat/v1/me', { statusMessage: message });
        return { success: true };
    } catch (e) {
        return { success: false, message: e.message };
    }
});

// --- Auto Updater ---
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('checking-for-update', () => {
    console.log('Checking for update...');
});

autoUpdater.on('update-available', (info) => {
    console.log('Update available:', info.version);
    if (mainWindow) {
        mainWindow.webContents.send('update-available', {
            version: info.version,
            releaseNotes: info.releaseNotes
        });
    }
});

autoUpdater.on('update-not-available', () => {
    console.log('Update not available.');
});

autoUpdater.on('download-progress', (progress) => {
    if (mainWindow) {
        mainWindow.webContents.send('update-progress', {
            percent: Math.round(progress.percent),
            transferred: progress.transferred,
            total: progress.total
        });
    }
});

autoUpdater.on('update-downloaded', (info) => {
    console.log('Update downloaded:', info.version);
    if (mainWindow) {
        mainWindow.webContents.send('update-downloaded', {
            version: info.version
        });
    }
});

autoUpdater.on('error', (err) => {
    console.error('AutoUpdater error:', err.message);
});

ipcMain.handle('check-for-updates', async () => {
    try {
        const result = await autoUpdater.checkForUpdates();
        return {
            updateAvailable: result?.updateInfo?.version !== app.getVersion(),
            latestVersion: result?.updateInfo?.version,
            currentVersion: app.getVersion()
        };
    } catch (e) {
        console.error('Update check failed:', e.message);
        return { updateAvailable: false, error: e.message };
    }
});

ipcMain.handle('install-update', () => {
    autoUpdater.quitAndInstall(false, true);
});

ipcMain.handle('get-version', () => {
    return app.getVersion();
});
