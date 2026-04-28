const { app, BrowserWindow, ipcMain, shell, dialog, screen, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');
const https = require('https');
const axios = require('axios');
const cheerio = require('cheerio');
const lcu = require('./lcu');
const yaml = require('js-yaml');
const { autoUpdater } = require('electron-updater');

const LOL_GEP_GAME_ID = 5426;
const LOL_OVERLAY_CLASS_ID = 54261; // overlay package uses a different ID than GEP

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

// --- Auth / Encryption ---
const ALGORITHM = 'aes-256-cbc';
// Legacy key (hardcoded) — kept only for transparent migration of old passwords
const LEGACY_KEY = crypto.scryptSync('lost-league-manager-secret', 'salt', 32);
let _machineKey = null;

function getMachineKey() {
    if (_machineKey) return _machineKey;
    try {
        const out = execSync('wmic csproduct get uuid /value 2>nul', { encoding: 'utf8', timeout: 5000 });
        const m = out.match(/UUID=([^\r\n]+)/i);
        const uuid = (m ? m[1].trim().replace(/[{}]/g, '') : '') || 'unknown';
        const user = process.env.USERNAME || process.env.USER || 'user';
        _machineKey = crypto.scryptSync(`${uuid}|${user}|lostleague-v2`, 'salt-v2', 32);
    } catch (e) {
        console.error('[Auth] Machine key derivation failed, using legacy key:', e.message);
        _machineKey = LEGACY_KEY;
    }
    return _machineKey;
}

function migratePasswords() {
    const accounts = loadAccounts();
    let migrated = 0;
    for (const acc of accounts) {
        if (acc.password && !acc.password.startsWith('v2:')) {
            const plain = decryptLegacy(acc.password);
            if (plain) {
                acc.password = encrypt(plain);
                migrated++;
            }
        }
    }
    if (migrated > 0) {
        saveAccounts(accounts);
        console.log(`[Auth] Migrated ${migrated} password(s) to machine-bound encryption`);
    }
}

function decryptLegacy(text) {
    try {
        const parts = text.split(':');
        const iv = Buffer.from(parts.shift(), 'hex');
        const enc = Buffer.from(parts.join(':'), 'hex');
        const d = crypto.createDecipheriv(ALGORITHM, LEGACY_KEY, iv);
        return Buffer.concat([d.update(enc), d.final()]).toString();
    } catch (e) { return null; }
}

// --- State ---
let mainWindow;
let overlayWindow = null;
let tray = null;
app.isQuiting = false;
let currentAccount = null;
let liveClientPollInterval = null;
const liveClientAgent = new https.Agent({ rejectUnauthorized: false });
let owOverlayPackage = null;
let championMap = {};
let latestDDragonVersion = '14.1.1'; // Default fallback
let skinsMap = {};
let idToImageMap = {};
let idToNameMap = {}; // champId (int) -> champion key string (e.g. "Ahri")
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
    const cipher = crypto.createCipheriv(ALGORITHM, getMachineKey(), iv);
    const enc = Buffer.concat([cipher.update(text), cipher.final()]);
    return 'v2:' + iv.toString('hex') + ':' + enc.toString('hex');
}

function decrypt(text) {
    try {
        // v2 = machine-bound key; no prefix = legacy key
        const isV2 = text.startsWith('v2:');
        const key  = isV2 ? getMachineKey() : LEGACY_KEY;
        const raw  = isV2 ? text.slice(3) : text;
        const parts = raw.split(':');
        const iv  = Buffer.from(parts.shift(), 'hex');
        const enc = Buffer.from(parts.join(':'), 'hex');
        const d   = crypto.createDecipheriv(ALGORITHM, key, iv);
        return Buffer.concat([d.update(enc), d.final()]).toString();
    } catch (e) {
        return null;
    }
}

function loadConfig() {
    if (fs.existsSync(CONFIG_FILE)) {
        try {
            config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE)) };
        } catch (e) { console.error('Failed to load config:', e.message); }
    }
}

function saveConfig() {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 4));
}

function loadAccounts() {
    if (fs.existsSync(ACCOUNTS_FILE)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(ACCOUNTS_FILE));
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) { console.error('Failed to load accounts:', e.message); }
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
            const id = parseInt(champ.key);
            championMap[champ.name.toLowerCase()] = id;
            idToImageMap[champ.key] = `https://ddragon.leagueoflegends.com/cdn/${latest}/img/champion/${champ.id}.png`;
            idToNameMap[id] = champ.id; // e.g. 103 → "Ahri"
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
        console.error('checkGameFlowAndQueue error:', e.message);
    }
}

async function setAppearOffline() {
    if (currentAccount && currentAccount.appearOffline) {
        try {
            await lcu.request('PUT', '/lol-chat/v1/me', { availability: "offline" });
        } catch (e) { console.error('setAppearOffline error:', e.message); }
    }
}

lcu.onConnect(async () => {
    if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send('lcu-connected');
    try {
        const phase = await lcu.request('GET', '/lol-gameflow/v1/gameflow-phase');
        if (phase) {
            if (mainWindow && !mainWindow.isDestroyed())
                mainWindow.webContents.send('lcu-gameflow', phase);
            // Show overlay if already in a game when we connect
            if (phase === 'InProgress' && overlayWindow && !overlayWindow.isDestroyed())
                overlayWindow.show();
        }
    } catch (e) {}
});

lcu.onDisconnect(() => {
    if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send('lcu-disconnected');
});

lcu.onEvent(async (event) => {
    // Forward gameflow phase changes to renderer AND drive overlay visibility
    if (event.uri === '/lol-gameflow/v1/gameflow-phase' && event.eventType === 'Update') {
        const phase = event.data;
        if (mainWindow && !mainWindow.isDestroyed())
            mainWindow.webContents.send('lcu-gameflow', phase);
        // LCU fires for ALL game modes: ranked, normal, custom, Practice Tool, ARAM, etc.
        if (overlayWindow && !overlayWindow.isDestroyed()) {
            if (phase === 'InProgress') overlayWindow.show();
            else if (['None', 'Lobby', 'EndOfGame', 'WaitingForStats', 'PreEndOfGame'].includes(phase))
                overlayWindow.hide();
        }
    }

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
            } catch (e) { console.error('autoSkinRandom error:', e.message); }
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

    // Minimize to tray instead of closing
    mainWindow.on('close', (e) => {
        if (!app.isQuiting) {
            e.preventDefault();
            mainWindow.hide();
        }
    });

    mainWindow.on('closed', () => {
        if (overlayWindow && !overlayWindow.isDestroyed()) {
            overlayWindow.destroy();
            overlayWindow = null;
        }
    });
}

function createOverlayWindow(owOverlay) {
    const { width: sw } = screen.getPrimaryDisplay().workAreaSize;
    const w = 480;
    const opts = {
        name: 'overlay',          // required by ow-electron overlay package
        width: w,
        height: 52,
        x: sw - w - 16,
        y: 16,
        transparent: true,
        frame: false,
        resizable: false,
        skipTaskbar: true,
        focusable: true,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, '../preload/overlay-preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        }
    };

    const finish = (rawWin) => {
        // ow-electron may return an OverlayBrowserWindow that wraps or extends BrowserWindow.
        // Keep rawWin for startDragging(); resolve the actual BrowserWindow for everything else.
        const bw = rawWin?.window ?? rawWin?.browserWindow ?? rawWin;
        if (!bw) throw new Error('[Overlay] Window handle is missing after createWindow');

        overlayWindow = bw;
        // Expose startDragging on overlayWindow directly so IPC handler can call it.
        if (!overlayWindow.startDragging && typeof rawWin?.startDragging === 'function') {
            overlayWindow.startDragging = rawWin.startDragging.bind(rawWin);
        }

        overlayWindow.setIgnoreMouseEvents(true, { forward: true });
        overlayWindow.loadFile(path.join(__dirname, '../renderer/overlay.html'));
        overlayWindow.webContents.on('did-finish-load', () => {
            if (!overlayWindow || overlayWindow.isDestroyed()) return;
            overlayWindow.webContents.send('overlay-init', { ddragonVersion: latestDDragonVersion });
        });
    };

    if (owOverlay) {
        owOverlay.createWindow(opts)
            .then(finish)
            .catch(e => {
                console.error('[Overlay] createWindow failed, using BrowserWindow fallback:', e.message);
                const fb = new BrowserWindow(opts);
                fb.setAlwaysOnTop(true, 'screen-saver');
                finish(fb);
            });
    } else {
        const fb = new BrowserWindow(opts);
        fb.setAlwaysOnTop(true, 'screen-saver');
        finish(fb);
    }
}

function createTray() {
    const iconPath = path.join(__dirname, '../renderer/assets/logo.ico');
    tray = new Tray(iconPath);
    tray.setToolTip('Lost League Manager');
    tray.on('double-click', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
    updateTrayMenu();
}

function updateTrayMenu() {
    if (!tray) return;
    const accounts = loadAccounts();
    const acctItems = accounts.slice(0, 10).map(acc => ({
        label: `${acc.label || acc.username}${acc.region ? '  ' + acc.region.toUpperCase() : ''}`,
        click: () => {
            executeAccountLaunch(acc.username);
            if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
        }
    }));
    const menu = Menu.buildFromTemplate([
        { label: 'Lost League Manager', enabled: false },
        { type: 'separator' },
        ...acctItems,
        { type: 'separator' },
        { label: 'Open', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
        { type: 'separator' },
        { label: 'Quit', click: () => { app.isQuiting = true; app.quit(); } }
    ]);
    tray.setContextMenu(menu);
}

function handleOverlayVisibility(data) {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    // data = gep.InfoUpdate: { gameId, feature, key, value, category }
    if (data?.feature !== 'matchState' || data?.key !== 'matchState') return;
    const state = data.value;
    if (state === 'InProgress') overlayWindow.show();
    else if (state === 'EndOfGame' || state === 'PreGame') overlayWindow.hide();
}

app.whenReady().then(async () => {
    loadConfig();
    migratePasswords();
    await fetchChampionData();
    createWindow();
    createTray();
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

    // Check for updates 10 s after launch so the window is fully ready
    if (app.isPackaged) {
        setTimeout(() => {
            autoUpdater.checkForUpdates().catch(e =>
                console.error('[Updater] startup check failed:', e.message)
            );
        }, 10000);
    }

    // --- Overwolf packages: GEP + Overlay ---
    if (app.overwolf) {
        app.overwolf.disableAnonymousAnalytics();

        const packages = app.overwolf.packages;

        packages.on('ready', async (e, packageName, version) => {
            console.log(`[OW] Package ready: ${packageName} v${version}`);

            // ── GEP ─────────────────────────────────────────────────────────
            if (packageName === 'gep') {
                const gep = packages.gep;

                // game-detected fires when LoL launches (or is already running).
                // We must call event.enable() to activate GEP data collection.
                gep.on('game-detected', async (event, gameId, name) => {
                    if (gameId !== LOL_GEP_GAME_ID) return;
                    console.log(`[GEP] Game detected: ${name} (${gameId})`);
                    event.enable();
                    try {
                        await gep.setRequiredFeatures(LOL_GEP_GAME_ID, [
                            'matchState', 'match_info', 'kill', 'death',
                            'live_client_data', 'summoner_info', 'teams'
                        ]);
                        console.log('[GEP] Features registered for LoL');
                    } catch (err) {
                        console.error('[GEP] setRequiredFeatures failed:', err.message);
                    }

                    // The overlay's game-launched only fires for new game starts, not for
                    // games already running when the app starts. Use requestGameInjection
                    // as a fallback so the overlay is always injected when GEP detects LoL.
                    if (owOverlayPackage) {
                        try {
                            await owOverlayPackage.requestGameInjection(gameId);
                            console.log('[Overlay] requestGameInjection succeeded');
                        } catch (err) {
                            console.warn('[Overlay] requestGameInjection failed:', err.message);
                        }
                    }

                    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.show();
                });

                gep.on('game-exit', (ev, gameId) => {
                    if (gameId !== LOL_GEP_GAME_ID) return;
                    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
                });

                // data = gep.GameEvent: { gameId, feature, key, value }
                gep.on('new-game-event', (ev, gameId, data) => {
                    if (gameId !== LOL_GEP_GAME_ID) return;
                    if (mainWindow && !mainWindow.isDestroyed())
                        mainWindow.webContents.send('gep-game-event', data);
                    if (overlayWindow && !overlayWindow.isDestroyed())
                        overlayWindow.webContents.send('gep-game-event', data);
                });

                // data = gep.InfoUpdate: { gameId, feature, key, value, category }
                gep.on('new-info-update', (ev, gameId, data) => {
                    if (gameId !== LOL_GEP_GAME_ID) return;
                    if (mainWindow && !mainWindow.isDestroyed())
                        mainWindow.webContents.send('gep-info-update', data);
                    if (overlayWindow && !overlayWindow.isDestroyed())
                        overlayWindow.webContents.send('gep-info-update', data);
                    handleOverlayVisibility(data);
                });
            }

            // ── Overlay ──────────────────────────────────────────────────────
            if (packageName === 'overlay') {
                const owOverlay = packages.overlay;
                owOverlayPackage = owOverlay;

                // Wire up ALL listeners BEFORE calling registerGames.
                // registerGames may fire game-launched synchronously for already-running
                // games, so the handlers must be in place first.

                // game-launched: LoL is starting → inject overlay into its process.
                // The event arg order has two known shapes; handle both.
                owOverlay.on('game-launched', (first, second) => {
                    // Shape A: (GameLaunchEvent, GameInfo)  ← matches ow-electron types
                    // Shape B: (GameInfo)                   ← some older versions
                    const hasInject = typeof first?.inject === 'function';
                    const launchEvent = hasInject ? first  : second;
                    const gameInfo    = hasInject ? second : first;

                    const gid = gameInfo?.id ?? gameInfo?.gameId ?? gameInfo?.classId;
                    console.log('[Overlay] game-launched: gameId=%s inject=%s', gid, hasInject);
                    if (gid && gid !== LOL_GEP_GAME_ID && gid !== LOL_OVERLAY_CLASS_ID) return;

                    try {
                        if (typeof launchEvent?.inject === 'function') {
                            launchEvent.inject();
                            console.log('[Overlay] inject() called successfully');
                        } else {
                            console.warn('[Overlay] game-launched: no inject() found on event args');
                        }
                    } catch (err) {
                        console.error('[Overlay] inject() threw:', err.message);
                    }

                    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.show();
                });

                owOverlay.on('game-injected', (gameInfo) => {
                    console.log('[Overlay] game-injected into game:', gameInfo?.id ?? gameInfo);
                    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.show();
                });

                owOverlay.on('game-injection-error', (err, gameInfo) => {
                    console.error('[Overlay] injection error for game', gameInfo?.id, ':', err);
                });

                owOverlay.on('game-exit', () => {
                    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
                });

                // Create the overlay window BEFORE registerGames so it exists
                // when injection happens.
                if (!overlayWindow || overlayWindow.isDestroyed()) {
                    createOverlayWindow(owOverlay);
                }

                // Now register — may fire game-launched immediately if LoL is running.
                try {
                    owOverlay.registerGames({ gameIds: [LOL_GEP_GAME_ID, LOL_OVERLAY_CLASS_ID] });
                    console.log('[Overlay] registerGames done for LoL');
                } catch (err) {
                    console.error('[Overlay] registerGames failed:', err.message);
                }
            }
        });

        packages.on('failed-to-initialize', (e, packageName) => {
            console.warn(`[OW] Package failed to initialize: ${packageName}`);
            // Fallback: create a plain always-on-top window so the overlay still works in windowed mode
            if (packageName === 'overlay' && (!overlayWindow || overlayWindow.isDestroyed())) {
                createOverlayWindow(null);
            }
        });
    } else {
        // Running outside ow-electron — create a regular always-on-top overlay window
        console.warn('[OW] app.overwolf not available — running outside ow-electron');
        createOverlayWindow(null);
    }
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
    // Tray app — only truly exit when user chooses Quit from tray
    if (app.isQuiting && process.platform !== 'darwin') app.quit();
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
        if (!win.isDestroyed()) win.webContents.send('accounts-updated');
    });
    updateTrayMenu();
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
        autoSpells: data.autoSpells || false,
        minimizeOnLaunch: data.minimizeOnLaunch || false
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
        autoSpells: data.autoSpells !== undefined ? data.autoSpells : oldAcc.autoSpells,
        minimizeOnLaunch: data.minimizeOnLaunch !== undefined ? data.minimizeOnLaunch : (oldAcc.minimizeOnLaunch || false)
    };

    if (data.password) {
        accounts[index].password = encrypt(data.password);
    }

    saveAccounts(accounts);
    broadcastAccountsUpdate();
    updateJumpList();

    // LIVE UPDATE: If this is the active account, update currentAccount in memory immediately
    if (currentAccount && currentAccount.username === data.username) {
        currentAccount = { ...currentAccount, ...accounts[index], password: currentAccount.password };
        console.log("Live updated current account settings:", currentAccount.username);
    }

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

    // Persist last-used timestamp
    const accIdx = accounts.findIndex(a => a.username === username);
    accounts[accIdx].lastUsed = Date.now();
    saveAccounts(accounts);

    // Send account info to renderer so overlay shows account details
    const accountMeta = { label: account.label || account.username, username: account.username, region: (account.region || '').toUpperCase() };
    if (mainWindow) mainWindow.webContents.send('launch-account-info', accountMeta);

    // Minimize main window if the account has that preference
    if (account.minimizeOnLaunch && mainWindow) mainWindow.hide();

    // Send immediate update to ensure UI doesn't hang on "Initializing..."
    if (mainWindow) mainWindow.webContents.send('login-status', { message: 'Preparing...', progress: 5 });

    const password = decrypt(account.password);
    if (!password) return { success: false, message: "Password error" };

    currentAccount = { ...account };

    // Short delay to allow UI to update
    await new Promise(r => setTimeout(r, 100));

    // Skip kill if this account is already active in the LCU
    let alreadyActive = false;
    try {
        if (lcu.connected) {
            const session = await lcu.request('GET', '/lol-login/v1/session');
            if (session && session.username && session.username.toLowerCase() === username.toLowerCase()) {
                alreadyActive = true;
            }
        }
    } catch (e) {}

    if (alreadyActive) {
        if (mainWindow) mainWindow.webContents.send('login-status', { message: 'Already logged in!', progress: 100 });
        setTimeout(() => { if (mainWindow) mainWindow.webContents.send('login-status', null); }, 2000);
        return { success: true };
    }

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

    if (!fs.existsSync(riotClientPath)) {
        for (const drive of ['E', 'F', 'G']) {
            const p = `${drive}:\\Riot Games\\Riot Client\\RiotClientServices.exe`;
            if (fs.existsSync(p)) { riotClientPath = p; break; }
        }
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
        '-Password', password,
        '-RiotClientPath', fs.existsSync(riotClientPath) ? riotClientPath : ''
    ]);

    currentAccount.loginChild = child;

    child.stdout.on('data', (data) => {
        const line = data.toString().trim();
        console.log(`[Login Script]: ${line}`);

        let msg = 'Logging in…';
        let pct = 70;
        if (line.includes('Waiting for Riot Client'))       { msg = 'Waiting for client window…';     pct = 55; }
        else if (line.includes('Found window'))              { msg = 'Client found, entering login…';  pct = 65; }
        else if (line.includes('Credentials submitted'))     { msg = 'Waiting for League to start…';  pct = 80; }
        else if (line.includes('Polling for League'))        { msg = 'Waiting for League to start…';  pct = 82; }
        else if (line.includes('League client detected'))    { msg = 'League is launching!';           pct = 95; }
        else if (line.includes('Launch triggered'))          { msg = 'Launching League…';              pct = 88; }
        else if (line.includes('League client is now'))      { msg = 'League is starting!';            pct = 97; }
        else if (line.includes('Login script complete'))     { msg = 'Done!';                          pct = 100; }

        if (mainWindow) mainWindow.webContents.send('login-status', { message: msg, progress: pct });
    });

    child.stderr.on('data', (data) => {
        console.error(`[Login Script stderr]: ${data}`);
    });

    child.on('close', (code) => {
        currentAccount.loginChild = null;
        if (code !== 0 && code !== null) return; // killed / cancelled

        if (mainWindow) mainWindow.webContents.send('login-status', { message: 'Done!', progress: 100 });

        // The script already handled the League re-trigger internally.
        // As a final safety net, fire it once more — if League is already
        // running, RiotClientServices just focuses it (no harm).
        spawn('powershell.exe', ['-Command', launchCmd]);

        setTimeout(() => {
            if (mainWindow) mainWindow.webContents.send('login-status', null);
        }, 3000);
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

// Helper used by get-stats
function capFirst(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

function formatLcuRanked(q) {
    if (!q || !q.tier || q.tier === 'NONE' || q.tier === 'UNRANKED') return null;
    const tier = `${capFirst(q.tier)} ${q.division || ''}`.trim();
    const w = q.wins || 0, l = q.losses || 0;
    return {
        tier,
        lp: `${q.leaguePoints ?? 0} LP`,
        winLose: `${w}W ${l}L`,
        ratio: w + l > 0 ? Math.round(w / (w + l) * 100) + '%' : ''
    };
}

ipcMain.handle('get-stats', async (event, { region, riotId }) => {
    if (!riotId || !riotId.includes('#')) return { tier: 'N/A' };
    const [name, tag] = riotId.trim().split('#');

    // ── Strategy 1: LCU (instant, authoritative) ─────────────────────────────
    if (lcu.connected) {
        try {
            const summoner = await lcu.request('GET',
                `/lol-summoner/v2/summoners/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`
            );
            if (summoner?.puuid) {
                const ranked = await lcu.request('GET',
                    `/lol-ranked/v1/ranked-stats/${summoner.puuid}`
                );
                const soloData = ranked?.RANKED_SOLO_5x5;
                const ranked_ = formatLcuRanked(soloData) || { tier: 'Unranked', lp: '', winLose: '', ratio: '' };
                const result = {
                    success: true,
                    ...ranked_,
                    iconSrc: summoner.profileIconId
                        ? `https://ddragon.leagueoflegends.com/cdn/${latestDDragonVersion}/img/profileicon/${summoner.profileIconId}.png`
                        : `https://ddragon.leagueoflegends.com/cdn/${latestDDragonVersion}/img/profileicon/29.png`,
                    level: summoner.summonerLevel?.toString() || '',
                    source: 'lcu'
                };
                // Cache in account record so we can show it when LCU is offline
                try {
                    const accs = loadAccounts();
                    const idx = accs.findIndex(a => a.riotId === riotId);
                    if (idx >= 0) {
                        accs[idx]._cachedStats = { ...result, ts: Date.now() };
                        saveAccounts(accs);
                    }
                } catch (_) {}
                return result;
            }
        } catch (e) {
            console.log('[Stats] LCU lookup failed:', e.message);
        }
    }

    // ── Strategy 2: cached LCU data (no client running) ──────────────────────
    try {
        const accs = loadAccounts();
        const acc = accs.find(a => a.riotId === riotId);
        const cached = acc?._cachedStats;
        // Show cached data if it's less than 6 hours old
        if (cached && Date.now() - cached.ts < 6 * 3600 * 1000) {
            console.log(`[Stats] ${riotId}: serving cached LCU data (${Math.round((Date.now() - cached.ts) / 60000)}min old)`);
            return { ...cached, source: 'cache' };
        }
    } catch (_) {}

    // ── Strategy 3: OP.GG scrape ─────────────────────────────────────────────
    try {
        const url = `https://www.op.gg/summoners/${region.toLowerCase()}/${encodeURIComponent(name)}-${tag}`;
        console.log(`[Stats] Fetching: ${url}`);

        const response = await axios.get(url, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });

        const $ = cheerio.load(response.data);
        let tier = 'Unranked', lp = '', winLose = '', ratio = '', iconSrc = '', level = '';
        let jsonParsed = false; // true once __NEXT_DATA__ is successfully parsed

        // Parse __NEXT_DATA__ — OP.GG changes structure often; try many paths
        const nextRaw = $('#__NEXT_DATA__').html();
        if (nextRaw) {
            try {
                const nextData = JSON.parse(nextRaw);
                const pp = nextData?.props?.pageProps;
                jsonParsed = true;

                // Candidate root objects in order of likelihood
                const roots = [
                    pp?.data,
                    pp?.summoner,
                    pp?.pageProps?.data,
                    pp?.data?.summoner,
                    pp,
                ].filter(Boolean);

                let leagueStatsArray = null;
                for (const root of roots) {
                    const candidates = [
                        root.league_stats,
                        root.summoner?.league_stats,
                        root.ranked_stats,
                        root.summary?.league_stats,
                        root.data?.league_stats,
                        root.data?.summoner?.league_stats,
                    ];
                    leagueStatsArray = candidates.find(v => Array.isArray(v) && v.length > 0);

                    if (!iconSrc) {
                        const pid = root.profile_icon_id
                            || root.summoner?.profile_icon_id
                            || root.summoner?.profile_image_url?.match(/\/(\d+)\.(png|jpg|webp)/)?.[1];
                        if (pid) iconSrc = `https://ddragon.leagueoflegends.com/cdn/${latestDDragonVersion}/img/profileicon/${pid}.png`;
                    }
                    if (!level) {
                        const lvl = root.level ?? root.summoner?.level ?? root.league_stats?.[0]?.summoner?.level;
                        if (lvl != null) level = String(lvl);
                    }

                    if (leagueStatsArray) break;
                }

                if (leagueStatsArray) {
                    // Solo/Duo only — never fall back to Flex queue (queue id 440)
                    const solo = leagueStatsArray.find(s =>
                        s.queue_info?.id === 420 ||
                        s.queue_info?.queue_type === 'SOLORANKED' ||
                        s.queue_info?.queue_translate?.toLowerCase().includes('solo') ||
                        s.queue_type === 'RANKED_SOLO_5x5'
                    );

                    if (solo) {
                        const info = solo.tier_info || solo;
                        const rawTier = info.tier || '';
                        if (rawTier && rawTier !== 'NONE' && rawTier !== 'UNRANKED') {
                            const isApex = ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(rawTier.toUpperCase());
                            const div = info.division || info.rank || '';
                            tier = `${capFirst(rawTier)} ${div}`.trim();
                            const rawLp = info.lp ?? 0;
                            // LP should be 0-100 for Iron-Diamond; reject impossible values
                            if (isApex || rawLp <= 100) lp = `${rawLp} LP`;
                            const w = solo.win || 0, l = solo.lose || 0;
                            winLose = `${w}W ${l}L`;
                            if (w + l > 0) ratio = Math.round(w / (w + l) * 100) + '%';
                        }
                    }
                }
            } catch (e) {
                console.error('[Stats] __NEXT_DATA__ parse error:', e.message);
            }
        }

        // HTML fallback — ONLY if __NEXT_DATA__ was absent or unparseable.
        // If JSON was parsed and tier is still Unranked, the player IS Unranked this season —
        // don't let seasonal history or Flex queue data from body text override that.
        if (tier === 'Unranked' && !jsonParsed) {
            const bodyText = $('body').text();
            // Scan for tier + LP together within a 100-char window
            const APEX = ['Master', 'Grandmaster', 'Challenger'];
            const rankRe = /\b(Iron|Bronze|Silver|Gold|Platinum|Emerald|Diamond|Master|Grandmaster|Challenger)(?:\s+([IVX]{1,3}|\d))?\b/gi;
            let m;
            while ((m = rankRe.exec(bodyText)) !== null) {
                const ctx = bodyText.slice(m.index, m.index + 100);
                const lpM = ctx.match(/(\d+)\s*LP/i);
                if (!lpM) continue; // no LP nearby — likely a UI label, skip
                const lpVal = parseInt(lpM[1]);
                const isApex = APEX.includes(capFirst(m[1]));
                if (!isApex && lpVal > 100) continue; // impossible LP for Iron-Diamond, skip
                tier = m[2] ? `${capFirst(m[1])} ${m[2]}` : capFirst(m[1]);
                lp = `${lpVal} LP`;
                const wlM = bodyText.match(/(\d+)W\s*(\d+)L/);
                if (wlM) {
                    const w = parseInt(wlM[1]), l = parseInt(wlM[2]);
                    winLose = `${w}W ${l}L`;
                    if (w + l > 0) ratio = Math.round(w / (w + l) * 100) + '%';
                }
                break;
            }
        }

        // Profile icon from rendered HTML
        if (!iconSrc) {
            const iconEl = $('img[src*="profileicon"]').first();
            const src = iconEl.attr('src') || '';
            const iconNum = src.match(/[/\\](\d+)\.(png|jpg|webp)/i)?.[1];
            if (iconNum) iconSrc = `https://ddragon.leagueoflegends.com/cdn/${latestDDragonVersion}/img/profileicon/${iconNum}.png`;
        }

        // Level fallback from meta description ("Lv. 870")
        if (!level) {
            const desc = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '';
            const m = desc.match(/Lv[.\s]+(\d+)/i);
            if (m) level = m[1];
        }

        if (!iconSrc) iconSrc = `https://ddragon.leagueoflegends.com/cdn/${latestDDragonVersion}/img/profileicon/29.png`;

        console.log(`[Stats] ${riotId}: ${tier}${lp ? ' ' + lp : ''} (${nextRaw ? 'json' : 'html'})`);
        return { success: true, tier, lp, winLose, ratio, iconSrc, level, source: 'opgg' };

    } catch (e) {
        console.error('[Stats] OP.GG fetch error:', e.message);
        return {
            tier: 'Unranked',
            lp: '', winLose: '', ratio: '',
            iconSrc: `https://ddragon.leagueoflegends.com/cdn/${latestDDragonVersion}/img/profileicon/29.png`,
            level: ''
        };
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

ipcMain.handle('open-file-dialog', async (event, options) => {
    return dialog.showOpenDialog(mainWindow, options);
});

ipcMain.handle('get-current-account', () => currentAccount ? currentAccount.username : null);

// Overlay window management
ipcMain.on('overlay-interactive', (_, on) => {
    if (overlayWindow && !overlayWindow.isDestroyed())
        overlayWindow.setIgnoreMouseEvents(!on, { forward: true });
});
// Called from overlay renderer on drag-handle mousedown.
// OverlayBrowserWindow.startDragging() lets the Overwolf overlay package handle
// native window dragging — works correctly in exclusive-fullscreen games.
ipcMain.on('overlay-start-dragging', () => {
    if (overlayWindow && !overlayWindow.isDestroyed() && typeof overlayWindow.startDragging === 'function') {
        overlayWindow.startDragging();
    }
});
ipcMain.on('overlay-move', (_, x, y) => {
    if (overlayWindow && !overlayWindow.isDestroyed())
        overlayWindow.setPosition(Math.round(x), Math.round(y));
});
ipcMain.handle('overlay-get-position', () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return { x: 0, y: 0 };
    const [x, y] = overlayWindow.getPosition();
    return { x, y };
});
ipcMain.on('overlay-resize', (_, w, h) => {
    if (overlayWindow && !overlayWindow.isDestroyed())
        overlayWindow.setSize(Math.round(w), Math.round(h));
});

ipcMain.handle('get-lcu-overview', async () => {
    if (!lcu.connected) return { connected: false };
    try {
        const results = await Promise.allSettled([
            lcu.request('GET', '/lol-summoner/v1/current-summoner'),
            lcu.request('GET', '/lol-ranked/v1/current-ranked-stats'),
            lcu.request('GET', '/lol-gameflow/v1/gameflow-phase'),
            lcu.request('GET', '/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=7'),
            lcu.request('GET', '/lol-champion-mastery/v1/top-champion-masteries/count/5'),
            lcu.request('GET', '/lol-honor-v2/v1/profiles')
        ]);
        const [summoner, ranked, gameflow, matches, mastery, honor] = results.map(r => r.value ?? null);
        return {
            connected: true,
            summoner,
            ranked,
            gameflow,
            matches,
            mastery,
            honor,
            ddragonVersion: latestDDragonVersion,
            idToNameMap
        };
    } catch (e) {
        console.error('[LCU Overview]', e.message);
        return { connected: false };
    }
});

ipcMain.handle('overlay-get-ranked-bulk', async (event, players) => {
    const results = {};
    if (!lcu.connected || !Array.isArray(players)) return results;

    for (const p of players) {
        const key = p.gameName || p.summonerName;
        if (!key) continue;
        try {
            let summoner = null;

            if (p.gameName && p.tagLine) {
                try {
                    summoner = await lcu.request('GET',
                        `/lol-summoner/v2/summoners/by-riot-id/${encodeURIComponent(p.gameName)}/${encodeURIComponent(p.tagLine)}`
                    );
                } catch (_) {}
            }

            if (!summoner?.puuid && p.summonerName) {
                try {
                    const res = await lcu.request('GET',
                        `/lol-summoner/v1/summoners?name=${encodeURIComponent(p.summonerName)}`
                    );
                    summoner = Array.isArray(res) ? res[0] : res;
                } catch (_) {}
            }

            if (summoner?.puuid) {
                const ranked = await lcu.request('GET', `/lol-ranked/v1/ranked-stats/${summoner.puuid}`);
                const soloData = ranked?.RANKED_SOLO_5x5;
                results[key] = formatLcuRanked(soloData) || { tier: 'Unranked', lp: '', winLose: '', ratio: '' };
            } else {
                results[key] = { tier: 'Unranked', lp: '', winLose: '', ratio: '' };
            }
        } catch (e) {
            console.log(`[Overlay Ranked] ${key}:`, e.message);
            results[key] = { tier: 'Unranked', lp: '', winLose: '', ratio: '' };
        }
    }
    return results;
});

// Boot item IDs — used to tint boot slots in the build panel
const BOOT_IDS = new Set([
    1001, 3006, 3009, 3020, 3047, 3111, 3117, 3158, 2422
]);

ipcMain.handle('overlay-get-builds', async (event, champKey) => {
    if (!champKey) return null;

    // Convert Data Dragon key to OP.GG URL slug
    // "MissFortune" → "miss-fortune", "KogMaw" → "kog-maw"
    const slug = champKey
        .replace(/([a-z])([A-Z])/g, '$1-$2')
        .toLowerCase()
        .replace(/['.]/g, '');

    try {
        const url = `https://www.op.gg/champions/${slug}/items`;
        const res = await axios.get(url, {
            timeout: 8000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8'
            }
        });

        const $ = cheerio.load(res.data);
        const raw = $('#__NEXT_DATA__').html();
        if (!raw) return null;

        const parsed = JSON.parse(raw);
        const pp = parsed?.props?.pageProps;

        // OP.GG changes their data shape frequently — try several paths
        const itemRoots = [
            pp?.data?.summary?.items,
            pp?.summaryData?.summary?.items,
            pp?.data?.items,
            pp?.summary?.items,
        ].filter(Boolean);

        for (const items of itemRoots) {
            const startArr = items.startingItems || items.starter_items || items.starting_items;
            const coreArr  = items.coreItems     || items.core_items    || items.mythic_items;
            const lastArr  = items.lastItems      || items.last_items    || items.soleItems;

            const starting = Array.isArray(startArr) && startArr.length
                ? (startArr[0]?.ids || startArr[0]?.item_ids || []).slice(0, 5)
                : [];
            const core = Array.isArray(coreArr) && coreArr.length
                ? (coreArr[0]?.ids || coreArr[0]?.item_ids || []).slice(0, 6)
                : (coreArr?.ids || []).slice(0, 6);
            const optional = (Array.isArray(lastArr) ? lastArr : [])
                .slice(0, 4)
                .map(i => (typeof i === 'object' ? (i.id ?? i.item_id) : i))
                .filter(Boolean);

            if (starting.length || core.length) {
                console.log(`[Builds] ${champKey} → start:${starting.length} core:${core.length} opt:${optional.length}`);
                return { champKey, starting, core, optional };
            }
        }

        console.log(`[Builds] ${champKey}: no parseable build data at ${url}`);
        return null;
    } catch (e) {
        console.log(`[Builds] ${champKey}:`, e.message);
        return null;
    }
});

// --- Auto Updater ---
// Only configure and run auto-updater in a packaged build.
// In dev mode there is no embedded app-update.yml, so any checkForUpdates()
// call would throw and surface a confusing error toast to developers.
if (app.isPackaged) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = console;

    autoUpdater.on('checking-for-update', () => {
        console.log('[Updater] Checking for update…');
    });

    autoUpdater.on('update-available', (info) => {
        console.log('[Updater] Update available:', info.version);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('update-available', {
                version: info.version,
                releaseNotes: info.releaseNotes
            });
        }
    });

    autoUpdater.on('update-not-available', (info) => {
        console.log('[Updater] Up to date:', info.version);
    });

    autoUpdater.on('download-progress', (progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('update-progress', {
                percent: Math.round(progress.percent),
                transferred: progress.transferred,
                total: progress.total
            });
        }
    });

    autoUpdater.on('update-downloaded', (info) => {
        console.log('[Updater] Update downloaded:', info.version);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('update-downloaded', { version: info.version });
        }
    });

    autoUpdater.on('error', (err) => {
        console.error('[Updater] Error:', err.message);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('update-error', err.message);
        }
    });
}

ipcMain.handle('check-for-updates', async () => {
    if (!app.isPackaged) return { updateAvailable: false, currentVersion: app.getVersion() };
    try {
        const result = await autoUpdater.checkForUpdates();
        const latest = result?.updateInfo?.version;
        return {
            updateAvailable: !!latest && latest !== app.getVersion(),
            latestVersion: latest,
            currentVersion: app.getVersion()
        };
    } catch (e) {
        console.error('[Updater] check-for-updates failed:', e.message);
        return { updateAvailable: false, error: e.message, currentVersion: app.getVersion() };
    }
});

ipcMain.handle('install-update', () => {
    if (app.isPackaged) autoUpdater.quitAndInstall(false, true);
});

ipcMain.handle('get-version', () => app.getVersion());
