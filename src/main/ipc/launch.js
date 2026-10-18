const { ipcMain, Notification } = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const https = require('https');
const axios = require('axios');
// Called as childProcess.spawn (not destructured) so tests can stand in a fake.
const childProcess = require('child_process');
const state = require('../state');
const { loadAccounts, saveAccounts } = require('../services/storage');
const { decrypt } = require('../services/encryption');
const { broadcastAccountsUpdate } = require('../windows');
const lcu = require('../lcu');

// Everything that has to be gone before another account can sign in. Current
// Riot Client builds run their UI as "Riot Client.exe", older ones as
// RiotClientUx; LeagueClientUxRender is League's renderer process.
const CLIENT_PROCESS_NAMES = [
    'LeagueClient', 'LeagueClientUx', 'LeagueClientUxRender',
    'RiotClientServices', 'RiotClientUx', 'Riot Client',
];
const LEAGUE_PROCESS_NAMES = ['LeagueClient', 'LeagueClientUx', 'LeagueClientUxRender'];

// Phases in which restarting the clients would throw the player out of a game.
const IN_GAME_PHASES = new Set(['ChampSelect', 'GameStart', 'InProgress', 'Reconnect']);

// The kill command waits up to 10 s for the processes to exit; this is the
// outer bound for powershell.exe itself (start-up included).
const POWERSHELL_TIMEOUT_MS = 20000;
// After login.ps1 saw LeagueClient start, the LCU lockfile poll (every 5 s in
// main.js) plus the client's own boot can take a while before
// /lol-login/v1/session answers.
const SESSION_CHECK_TIMEOUT_MS = 60000;
const SESSION_CHECK_INTERVAL_MS = 1000;

const riotClientAgent = new https.Agent({ rejectUnauthorized: false });

function send(channel, ...args) {
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
        state.mainWindow.webContents.send(channel, ...args);
    }
}

// The vault gate lives in services/vault.js. Until that module exists the
// vault cannot be locked from main's point of view, so launching stays open.
function isVaultLocked() {
    let vault;
    try {
        vault = require('../services/vault');
    } catch (e) {
        if (e.code === 'MODULE_NOT_FOUND' && /services[\\/]vault/.test(e.message)) return false;
        throw e;
    }
    return vault.isVaultLocked();
}

function sameUsername(a, b) {
    return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

function later(ms, fn) {
    const t = setTimeout(fn, ms);
    if (typeof t?.unref === 'function') t.unref();
    return t;
}

const sleep = (ms) => new Promise(r => later(ms, r));

// Riot's own record of where the Riot Client lives (written by its installer),
// so non-standard installs (Steam library, custom drives) are found reliably.
function riotClientFromInstallsJson() {
    try {
        const file = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Riot Games', 'RiotClientInstalls.json');
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        const leagueDir = path.dirname(state.config.lolPath || '').replace(/\\/g, '/').toLowerCase();
        const associated = Object.entries(data.associated_client || {})
            .find(([dir]) => dir.replace(/\/$/, '').toLowerCase() === leagueDir)?.[1];
        return [associated, data.rc_live, data.rc_default].filter(Boolean).map(p => path.normalize(p));
    } catch {
        return [];
    }
}

function discoverRiotClientPath() {
    const base = path.dirname(path.dirname(state.config.lolPath));
    const candidates = [
        ...riotClientFromInstallsJson(),
        path.join(base, 'Riot Client', 'RiotClientServices.exe'),
        'C:\\Riot Games\\Riot Client\\RiotClientServices.exe',
        'D:\\Riot Games\\Riot Client\\RiotClientServices.exe',
        ...['E', 'F', 'G'].map(d => `${d}:\\Riot Games\\Riot Client\\RiotClientServices.exe`),
    ];
    return candidates.find(p => fs.existsSync(p)) || null;
}

// Stops the processes, then waits (up to 10 s) until they are really gone, so
// the new Riot Client never starts next to a dying one whose window the login
// script could pick.
function killProcessesCommand(names) {
    const list = names.map(n => `'${n}'`).join(',');
    return `$n = @(${list}); `
        + 'Get-Process -Name $n -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; '
        + 'for ($i = 0; $i -lt 40 -and (Get-Process -Name $n -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 250 }';
}

// Runs a PowerShell command without a console window and resolves with its
// exit code (null if it could not start or hung). Never rejects: a failed
// spawn used to be an unhandled 'error' event that crashed the main process.
function runPowerShell(command) {
    return new Promise((resolve) => {
        let child;
        try {
            child = childProcess.spawn('powershell.exe',
                ['-NoProfile', '-NonInteractive', '-Command', command],
                { windowsHide: true, stdio: 'ignore' });
        } catch (e) {
            console.error('[Launch] powershell.exe could not start:', e.message);
            resolve(null);
            return;
        }
        const timer = later(POWERSHELL_TIMEOUT_MS, () => resolve(null));
        child.once('error', (e) => {
            clearTimeout(timer);
            console.error('[Launch] powershell.exe failed:', e.message);
            resolve(null);
        });
        child.once('close', (code) => {
            clearTimeout(timer);
            resolve(code);
        });
    });
}

// Launches the exe directly (no shell) instead of building a `powershell -Command`
// string: riotClientPath/lolPath are derived from user/config-supplied paths,
// and interpolating them into a shell command string is a command-injection
// vector (a path containing `"; ...` would execute arbitrary commands).
// Returns false when there is nothing to start; onError gets async spawn failures.
function launchClient(riotClientPath, onError = () => {}) {
    let target = null;
    let args = [];
    if (riotClientPath) {
        target = riotClientPath;
        args = ['--launch-product=league_of_legends', '--launch-patchline=live'];
    } else if (state.config.lolPath && fs.existsSync(state.config.lolPath)) {
        target = state.config.lolPath;
    }
    if (!target) return false;
    try {
        const child = childProcess.spawn(target, args, { detached: true, stdio: 'ignore' });
        child.on('error', (e) => {
            console.error('[Launch] Could not start', target, e.message);
            onError(e);
        });
        child.unref();
    } catch (e) {
        console.error('[Launch] Could not start', target, e.message);
        onError(e);
    }
    return true;
}

// Maps one line of login.ps1 output to a progress update, or null for lines
// that are not a progress step (debug output, errors: those are reported
// through the exit code instead of as "Logging in...").
function statusForLine(line) {
    if (line.includes('Waiting for Riot Client'))   return { message: 'Waiting for the Riot Client window...', progress: 55 };
    if (line.includes('Found window'))              return { message: 'Client found, entering login...', progress: 65 };
    if (line.includes('Credentials submitted'))     return { message: 'Waiting for League to start...', progress: 80 };
    if (line.includes('Polling for League'))        return { message: 'Waiting for League to start...', progress: 82 };
    if (line.includes('Launch triggered'))          return { message: 'Launching League...', progress: 88 };
    if (line.includes('League client detected'))    return { message: 'League is starting...', progress: 95 };
    return null;
}

// stdout 'data' chunks can hold several lines or half of one.
function createLineSplitter() {
    let buffer = '';
    return (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        return lines.map(l => l.trim()).filter(Boolean);
    };
}

// Compares the account the League client is signed in with against the one
// that was launched. ok: null means the session could not be read.
function verifyLoggedInAccount(expectedUsername, session) {
    const actual = session?.username;
    if (!actual) return { ok: null };
    if (sameUsername(actual, expectedUsername)) return { ok: true };
    return { ok: false, actual };
}

function riotClientLockfilePath() {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'Riot Games', 'Riot Client', 'Config', 'lockfile');
}

// Asks the Riot Client's local API whether someone is signed in:
// 'signed-in', 'signed-out', or 'unknown' when the client is not reachable.
async function riotClientAuthState() {
    let parts;
    try {
        parts = fs.readFileSync(riotClientLockfilePath(), 'utf8').trim().split(':');
    } catch {
        return 'unknown';
    }
    const [, , port, password, protocol] = parts;
    if (!port || !password) return 'unknown';
    const scheme = protocol === 'http' ? 'http' : 'https';
    try {
        await axios.get(`${scheme}://127.0.0.1:${port}/rso-auth/v1/authorization`, {
            auth: { username: 'riot', password },
            httpsAgent: riotClientAgent,
            timeout: 3000,
        });
        return 'signed-in';
    } catch (e) {
        return e.response?.status === 404 ? 'signed-out' : 'unknown';
    }
}

// ── Launch state ────────────────────────────────────────────────────────────
// One launch at a time. Every step after an await re-checks that its launch is
// still the active one, so Cancel works in every phase and a cancelled flow
// never spawns the login script or types credentials.
let launchSeq = 0;
let activeLaunch = null; // { seq, username, label, child, hidWindow, progress }

function isCurrent(launch) {
    return activeLaunch === launch;
}

function isLaunchInProgress() {
    return activeLaunch !== null;
}

// True while a launch has hidden the main window (minimize on launch), so the
// window's first ready-to-show does not bring it back.
function isWindowHiddenByLaunch() {
    return !!activeLaunch?.hidWindow;
}

function status(launch, message, progress, extra = {}) {
    if (!isCurrent(launch)) return;
    // Progress never goes backwards within one launch.
    launch.progress = Math.max(launch.progress, progress);
    send('login-status', { message, progress: launch.progress, ...extra });
}

// Clears the overlay after a finished launch unless a newer one started since.
function clearStatusLater(ms) {
    const seq = launchSeq;
    later(ms, () => {
        if (launchSeq === seq && !activeLaunch) send('login-status', null);
    });
}

function notify(title, body) {
    try {
        const n = new Notification({
            title,
            body,
            icon: path.join(__dirname, '../../renderer/assets/logo.png'),
        });
        n.on('click', showMainWindow);
        n.show();
    } catch { /* notifications may not be supported in this environment */ }
}

function showMainWindow() {
    const win = state.mainWindow;
    if (!win || win.isDestroyed()) return;
    win.show();
    if (win.isMinimized?.()) win.restore();
    win.focus();
}

// Brings the window back for a message the user has to see (minimize on
// launch would otherwise leave it hidden), with a notification if it was hidden.
function revealWindow(title, message) {
    const win = state.mainWindow;
    if (!win || win.isDestroyed()) return;
    const wasHidden = !win.isVisible();
    showMainWindow();
    if (wasHidden) notify(title, message);
}

function fail(launch, message, kind) {
    if (!isCurrent(launch)) return;
    activeLaunch = null;
    if (launch.child) {
        try { launch.child.kill(); } catch { /* already gone */ }
    }
    send('login-status', { message, progress: 0, error: true, kind });
    revealWindow('Login did not complete', message);
    clearStatusLater(5000);
}

function succeed(launch, message) {
    if (!isCurrent(launch)) return;
    send('login-status', { message, progress: 100, kind: 'done' });
    activeLaunch = null;
    clearStatusLater(3000);
}

// Polls the League client for the signed-in account until it answers, the
// launch is cancelled, or the timeout passes (then null).
async function waitForSession(launch) {
    const deadline = Date.now() + SESSION_CHECK_TIMEOUT_MS;
    while (isCurrent(launch) && Date.now() < deadline) {
        if (lcu.connected) {
            const session = await lcu.request('GET', '/lol-login/v1/session', null, { timeout: 3000 });
            if (session?.username) return session;
        }
        await sleep(SESSION_CHECK_INTERVAL_MS);
    }
    return null;
}

const NEEDS_ACTION_MESSAGES = {
    'signed-out': 'Sign-in did not complete. Check the Riot Client: wrong password, a verification code or a captcha?',
    'signed-in':  'Signed in, but League did not start. Click Play in the Riot Client.',
    'unknown':    'League did not start. Finish signing in or click Play in the Riot Client.',
};

async function onLoginScriptExit(launch, code, signal) {
    if (!isCurrent(launch)) return; // cancelled: the user already got login-status null
    launch.child = null;

    if (code === 0) {
        status(launch, 'Checking the signed-in account...', 98);
        const check = verifyLoggedInAccount(launch.username, await waitForSession(launch));
        if (!isCurrent(launch)) return;
        if (check.ok === false) {
            fail(launch, `Signed in as ${check.actual}, not ${launch.label}. Sign out in the Riot Client and try again.`, 'wrong-account');
            return;
        }
        succeed(launch, 'Done!');
        notify('League Launched!', `${launch.label} is ready to play.`);
        return;
    }

    // League never came up: wrong password, 2FA, captcha, or keystrokes that
    // reached the client before its UI was ready all end here.
    if (code === 3) {
        const auth = await riotClientAuthState();
        fail(launch, NEEDS_ACTION_MESSAGES[auth] || NEEDS_ACTION_MESSAGES.unknown, 'needs-action');
        return;
    }

    let message;
    if (code === 1) message = 'The Riot Client window did not appear. Start the Riot Client and try again.';
    else if (code === 2) message = 'Could not bring the Riot Client window to the front. Click it and try again.';
    else if (code === null) message = `The login was interrupted${signal ? ` (${signal})` : ''}. Try again.`;
    else message = 'Login failed. Check the Riot Client window and try again.';
    fail(launch, message, 'failed');
}

function startLoginScript(launch, account, password, riotClientPath, notBefore) {
    const loginScriptPath = path.join(state.RESOURCES_PATH, 'scripts', 'login.ps1');

    // Password is sent over stdin rather than as a command-line argument:
    // process argv is readable by other local processes/users for the life of
    // the child (e.g. Task Manager's "Command line" column). Base64 because
    // Windows PowerShell decodes console input with the OEM code page, which
    // garbled every non-ASCII character (ä, ß, €).
    const child = childProcess.spawn('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', loginScriptPath,
        '-Username', account.username,
        '-RiotClientPath', riotClientPath || '',
        '-NotBefore', String(notBefore),
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    launch.child = child;

    child.on('error', (e) => {
        console.error('[Launch] Login script failed to start:', e.message);
        fail(launch, 'The login script could not start (powershell.exe). Try again.', 'failed');
    });
    child.stdin.on('error', (e) => console.error('[Launch] Login script stdin:', e.message));
    child.stdin.write(Buffer.from(password, 'utf8').toString('base64') + '\n');
    child.stdin.end();

    const splitLines = createLineSplitter();
    child.stdout.on('data', (data) => {
        for (const line of splitLines(data)) {
            console.log('[Login Script]:', line);
            const step = statusForLine(line);
            if (step && step.progress >= launch.progress) status(launch, step.message, step.progress);
        }
    });
    child.stderr.on('data', (data) => {
        console.error('[Login Script stderr]:', data.toString());
    });
    child.on('close', (code, signal) => {
        onLoginScriptExit(launch, code, signal)
            .catch(e => fail(launch, `Login failed: ${e.message}`, 'failed'));
    });
}

const CANCELLED = Object.freeze({ success: false, cancelled: true });

async function executeAccountLaunch(username, opts = {}) {
    if (isVaultLocked()) return { success: false, locked: true, message: 'Vault is locked' };
    if (activeLaunch) return { success: false, busy: true, message: 'A launch is already in progress' };

    const accounts = loadAccounts();
    const idx = accounts.findIndex(a => a.username === username);
    if (idx < 0) return { success: false, message: 'Account not found' };
    const account = accounts[idx];

    // Checked before hiding the window: with minimizeOnLaunch on, failing
    // after the hide left the user with no visible window or error.
    const password = decrypt(account.password);
    if (!password) {
        // Usually means this password was encrypted under a key tied to
        // machine state that's since changed (e.g. a Windows update removing
        // wmic): the ciphertext can't be recovered, but re-saving the
        // password re-encrypts it under the current key.
        return { success: false, message: 'Saved password could not be read (often after a Windows update). Edit this account, re-enter its password and try again.' };
    }

    const launch = {
        seq: ++launchSeq,
        username: account.username,
        label: account.label || account.username,
        child: null,
        hidWindow: false,
        progress: 0,
    };
    // Claimed before the first await: a second launch (tray, jump list,
    // another click) now gets `busy` instead of running in parallel and
    // typing a second account into the same Riot Client.
    activeLaunch = launch;

    try {
        if (lcu.connected) {
            const [session, phase] = await Promise.all([
                lcu.request('GET', '/lol-login/v1/session', null, { timeout: 3000 }),
                lcu.request('GET', '/lol-gameflow/v1/gameflow-phase', null, { timeout: 3000 }),
            ]);
            if (!isCurrent(launch)) return CANCELLED;
            if (sameUsername(session?.username, account.username)) {
                send('launch-account-info', accountMeta(account));
                succeed(launch, 'Already logged in!');
                return { success: true };
            }
            if (IN_GAME_PHASES.has(phase) && !opts.confirmed) {
                activeLaunch = null;
                return { success: false, needsConfirm: true, message: 'You are in a game. Launching another account closes League.' };
            }
        }

        accounts[idx].lastUsed = Date.now();
        saveAccounts(accounts);
        broadcastAccountsUpdate();
        send('launch-account-info', accountMeta(account));

        if (account.minimizeOnLaunch && state.mainWindow && !state.mainWindow.isDestroyed()) {
            state.mainWindow.hide();
            launch.hidWindow = true;
        }
        status(launch, 'Closing League and the Riot Client...', 10);
        await runPowerShell(killProcessesCommand(CLIENT_PROCESS_NAMES));
        if (!isCurrent(launch)) return CANCELLED;

        status(launch, 'Launching Riot Client...', 30);
        const riotClientPath = discoverRiotClientPath();
        // The login script only accepts Riot Client windows created after this
        // point, never one that survived the kill above.
        const notBefore = Date.now();
        const started = launchClient(riotClientPath, (e) =>
            fail(launch, `Could not start the Riot Client (${e.code || e.message}).`, 'failed'));
        if (!started) {
            const message = 'Could not find the Riot Client or League of Legends. Set the path in Settings.';
            fail(launch, message, 'failed');
            return { success: false, message, reported: true };
        }

        status(launch, 'Waiting for the Riot Client window...', 50);
        startLoginScript(launch, account, password, riotClientPath, notBefore);
        return { success: true };
    } catch (e) {
        console.error('[Launch] Unexpected error:', e);
        const message = `Launch failed: ${e.message}`;
        const wasCurrent = isCurrent(launch);
        fail(launch, message, 'failed');
        return { success: false, message, reported: wasCurrent };
    }
}

function accountMeta(account) {
    return {
        label:    account.label || account.username,
        username: account.username,
        region:   (account.region || '').toUpperCase(),
    };
}

function cancelLaunch() {
    const launch = activeLaunch;
    if (!launch) return { success: false, message: 'No launch in progress' };
    activeLaunch = null;
    if (launch.child) {
        try { launch.child.kill(); } catch { /* already gone */ }
    }
    send('login-status', null);
    return { success: true };
}

// Tray, jump list and `--launch=`: no renderer is waiting on the result, so
// the window (lock screen, error) is shown here instead.
async function launchFromOutside(username) {
    if (isVaultLocked()) {
        showMainWindow();
        return { success: false, locked: true, message: 'Vault is locked' };
    }
    const win = state.mainWindow;
    const wasHidden = !!win && !win.isDestroyed() && !win.isVisible();
    const account = loadAccounts().find(a => a.username === username);
    if (!account?.minimizeOnLaunch) showMainWindow();

    const res = await executeAccountLaunch(username);
    if (res.busy) {
        showMainWindow(); // the running launch's progress is on screen
    } else if (!res.success && !res.cancelled && !res.reported) {
        send('login-status', { message: res.message, progress: 0, error: true, kind: 'failed' });
        clearStatusLater(5000);
        showMainWindow();
        if (wasHidden) notify('Could not launch', res.message);
    }
    return res;
}

function register() {
    ipcMain.handle('launch-account', (event, username, opts) =>
        executeAccountLaunch(username, { confirmed: !!opts?.confirmed }));

    // Plain "open the client" for the Live page's empty state: no account
    // login, just gets League/Riot Client running so the LCU can connect.
    ipcMain.handle('launch-league-client', () => {
        if (launchClient(discoverRiotClientPath())) return { success: true };
        return { success: false, message: 'Could not find Riot Client or League of Legends. Set the path in Settings.' };
    });

    ipcMain.handle('cancel-launch', () => cancelLaunch());

    ipcMain.handle('get-current-account', () => state.currentAccount?.username ?? null);
}

module.exports = {
    register,
    executeAccountLaunch,
    launchFromOutside,
    cancelLaunch,
    isLaunchInProgress,
    isWindowHiddenByLaunch,
    isVaultLocked,
    riotClientFromInstallsJson,
    riotClientAuthState,
    statusForLine,
    verifyLoggedInAccount,
    killProcessesCommand,
    runPowerShell,
    CLIENT_PROCESS_NAMES,
    LEAGUE_PROCESS_NAMES,
};
