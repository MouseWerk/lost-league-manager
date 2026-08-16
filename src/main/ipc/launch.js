const { ipcMain, Notification } = require('electron');
const path = require('path');
const fs   = require('fs');
const { spawn } = require('child_process');
const state = require('../state');
const { loadAccounts, saveAccounts } = require('../services/storage');
const { decrypt } = require('../services/encryption');
const { broadcastAccountsUpdate } = require('../windows');
const lcu = require('../lcu');

function send(channel, ...args) {
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
        state.mainWindow.webContents.send(channel, ...args);
    }
}

function discoverRiotClientPath() {
    const base = path.dirname(path.dirname(state.config.lolPath));
    const candidates = [
        path.join(base, 'Riot Client', 'RiotClientServices.exe'),
        'C:\\Riot Games\\Riot Client\\RiotClientServices.exe',
        'D:\\Riot Games\\Riot Client\\RiotClientServices.exe',
        ...['E', 'F', 'G'].map(d => `${d}:\\Riot Games\\Riot Client\\RiotClientServices.exe`),
    ];
    return candidates.find(p => fs.existsSync(p)) || null;
}

async function executeAccountLaunch(username) {
    const accounts = loadAccounts();
    const account  = accounts.find(a => a.username === username);
    if (!account) return { success: false, message: 'Account not found' };

    const idx = accounts.findIndex(a => a.username === username);
    accounts[idx].lastUsed = Date.now();
    saveAccounts(accounts);
    broadcastAccountsUpdate();

    const accountMeta = {
        label:    account.label || account.username,
        username: account.username,
        region:   (account.region || '').toUpperCase(),
    };
    send('launch-account-info', accountMeta);

    if (account.minimizeOnLaunch && state.mainWindow) state.mainWindow.hide();
    send('login-status', { message: 'Preparing...', progress: 5 });

    const password = decrypt(account.password);
    if (!password) {
        // Usually means this password was encrypted under a key tied to
        // machine state that's since changed (e.g. a Windows update removing
        // wmic) — the ciphertext can't be recovered, but re-saving the
        // password re-encrypts it under the current key.
        return { success: false, message: 'Saved password could not be read (often after a Windows update) — edit this account and re-enter its password, then try again' };
    }

    // Kill any in-progress login before overwriting state
    const oldChild = state.currentAccount?.loginChild;
    if (oldChild) {
        oldChild._cancelled = true;
        try { oldChild.kill(); } catch { /* already dead */ }
    }
    state.currentAccount = { ...account };

    await new Promise(r => setTimeout(r, 100));

    // Skip restart if this account is already active in the LCU
    if (lcu.connected) {
        try {
            const session = await lcu.request('GET', '/lol-login/v1/session');
            if (session?.username?.toLowerCase() === username.toLowerCase()) {
                send('login-status', { message: 'Already logged in!', progress: 100 });
                setTimeout(() => send('login-status', null), 2000);
                return { success: true };
            }
        } catch { /* not critical */ }
    }

    send('login-status', { message: 'Killing League processes...', progress: 10 });
    spawn('powershell.exe', ['-Command',
        'Get-Process -Name LeagueClient, LeagueClientUx, RiotClientServices, RiotClientUx -ErrorAction SilentlyContinue | Stop-Process -Force'
    ]);

    await new Promise(r => setTimeout(r, 2000));
    send('login-status', { message: 'Launching Riot Client...', progress: 30 });

    const riotClientPath = discoverRiotClientPath();

    // Launch the exe directly (no shell) instead of building a `powershell -Command`
    // string — riotClientPath/lolPath are derived from user/config-supplied paths,
    // and interpolating them into a shell command string is a command-injection
    // vector (a path containing `"; ...` would execute arbitrary commands).
    function launchClient() {
        if (riotClientPath) {
            spawn(riotClientPath, ['--launch-product=league_of_legends', '--launch-patchline=live'],
                { detached: true, stdio: 'ignore' }).unref();
        } else if (state.config.lolPath && fs.existsSync(state.config.lolPath)) {
            spawn(state.config.lolPath, [], { detached: true, stdio: 'ignore' }).unref();
        } else {
            console.error('[Launch] No valid Riot Client / League path configured');
        }
    }
    launchClient();

    send('login-status', { message: 'Waiting for client window...', progress: 50 });

    const loginScriptPath = path.join(state.RESOURCES_PATH, 'scripts', 'login.ps1');

    // Password is sent over stdin rather than as a command-line argument —
    // process argv is readable by other local processes/users for the life of
    // the child (e.g. Task Manager's "Command line" column), which would leak
    // the plaintext credential despite it being encrypted at rest.
    const child = spawn('powershell.exe', [
        '-ExecutionPolicy', 'Bypass',
        '-File', loginScriptPath,
        '-Username', account.username,
        '-RiotClientPath', riotClientPath || '',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.write(password + '\n');
    child.stdin.end();
    state.currentAccount.loginChild = child;

    child.stdout.on('data', (data) => {
        const line = data.toString().trim();
        console.log('[Login Script]:', line);

        let msg = 'Logging in…';
        let pct = 70;
        if (line.includes('Waiting for Riot Client'))    { msg = 'Waiting for client window…';    pct = 55; }
        else if (line.includes('Found window'))           { msg = 'Client found, entering login…'; pct = 65; }
        else if (line.includes('Credentials submitted'))  { msg = 'Waiting for League to start…'; pct = 80; }
        else if (line.includes('Polling for League'))     { msg = 'Waiting for League to start…'; pct = 82; }
        else if (line.includes('League client detected')) { msg = 'League is launching!';          pct = 95; }
        else if (line.includes('Launch triggered'))       { msg = 'Launching League…';             pct = 88; }
        else if (line.includes('League client is now'))   { msg = 'League is starting!';           pct = 97; }
        else if (line.includes('Login script complete'))  { msg = 'Done!';                         pct = 100; }

        send('login-status', { message: msg, progress: pct });
    });

    child.stderr.on('data', (data) => {
        console.error('[Login Script stderr]:', data.toString());
    });

    child.on('close', (code) => {
        // Killed via Cancel, or superseded by a newer launch replacing this
        // child (see oldChild above) — a killed process reports code === null
        // on Windows, indistinguishable from a clean exit by code alone, so
        // without this the close handler fell through to the success path:
        // "Done!" toast, a "League Launched!" notification, and relaunching
        // the client, all right after the user asked to cancel.
        if (child._cancelled) return;

        state.currentAccount.loginChild = null;

        // Credentials went in fine, but League never came up on its own —
        // not a failure of the login itself, so this isn't styled as an error
        // (no retry button, no red toast), just an accurate heads-up instead
        // of the old silent "Done!" that lied about League having started.
        if (code === 3) {
            send('login-status', { message: 'Logged in — click Launch in the Riot Client to start League', progress: 90 });
            setTimeout(() => send('login-status', null), 6000);
            return;
        }

        if (code !== 0 && code !== null) {
            const message = code === 2
                ? 'Could not bring the Riot Client window to the front — click it and try again'
                : 'Login failed — check the login window and try again';
            send('login-status', { message, progress: 0, error: true });
            setTimeout(() => send('login-status', null), 5000);
            return;
        }

        send('login-status', { message: 'Done!', progress: 100 });

        // Notify the user — especially useful when the window was minimized on launch
        try {
            const n = new Notification({
                title: 'League Launched!',
                body: `${state.currentAccount?.label || state.currentAccount?.username || 'Account'} is ready to play.`,
                icon: path.join(__dirname, '../../renderer/assets/logo.png'),
            });
            n.on('click', () => {
                if (state.mainWindow) { state.mainWindow.show(); state.mainWindow.focus(); }
            });
            n.show();
        } catch { /* notifications may not be supported in this environment */ }

        // Re-trigger launch as safety net (harmless if League is already running)
        launchClient();
        setTimeout(() => send('login-status', null), 3000);
    });

    return { success: true };
}

function register() {
    ipcMain.handle('launch-account', (event, username) => executeAccountLaunch(username));

    // Plain "open the client" for the Live page's empty state — no account
    // login, just gets League/Riot Client running so the LCU can connect.
    ipcMain.handle('launch-league-client', () => {
        const riotClientPath = discoverRiotClientPath();
        if (riotClientPath) {
            spawn(riotClientPath, ['--launch-product=league_of_legends', '--launch-patchline=live'],
                { detached: true, stdio: 'ignore' }).unref();
            return { success: true };
        }
        if (state.config.lolPath && fs.existsSync(state.config.lolPath)) {
            spawn(state.config.lolPath, [], { detached: true, stdio: 'ignore' }).unref();
            return { success: true };
        }
        return { success: false, message: 'Could not find Riot Client or League of Legends — set the path in Settings' };
    });

    ipcMain.handle('cancel-launch', () => {
        const child = state.currentAccount?.loginChild;
        if (child) {
            child._cancelled = true;
            try { child.kill(); } catch { /* ok */ }
            state.currentAccount.loginChild = null;
            return { success: true };
        }
        return { success: false, message: 'No active login process' };
    });

    ipcMain.handle('get-current-account', () => state.currentAccount?.username ?? null);
}

module.exports = { register, executeAccountLaunch };
