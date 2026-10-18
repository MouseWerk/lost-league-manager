const { ipcMain, dialog } = require('electron');
const fs = require('fs');
const { loadAccounts, saveAccounts, sameUser } = require('../services/storage');
const { encrypt, decrypt, encryptExport, decryptExport, decryptExportV1, backupVersion } = require('../services/encryption');
const { broadcastAccountsUpdate } = require('../windows');
const { loadHonorWatch, getHonorRecord, isFlaggedRecord, forgetHonor } = require('../services/honor-watch');
const vault = require('../services/vault');
const state = require('../state');

// Fields an account record may carry besides username/password, with their
// type and the default for a new record. add-account, update-account, import
// and export all go through this list, so internal fields (_cachedStats,
// lastUsed, passwordOk, ...) never come in from a backup or the renderer.
const STRING_MAX = 2048;
const ACCOUNT_FIELDS = {
    label:            { type: 'string',  def: '', max: 200 },
    riotId:           { type: 'string',  def: '', max: 100 },
    region:           { type: 'string',  def: '', max: 16 },
    notes:            { type: 'string',  def: '', max: 5000 },
    appearOffline:    { type: 'boolean', def: false },
    autoSkinRandom:   { type: 'boolean', def: false },
    autoChampLock:    { type: 'string',  def: '', max: 100 },
    minimizeOnLaunch: { type: 'boolean', def: false },
    isFavourite:      { type: 'boolean', def: false },
    customRank:       { type: 'string',  def: '', max: 100 },
    customAvatar:     { type: 'string',  def: '', max: STRING_MAX },
};
const ACCOUNT_DEFAULTS = Object.fromEntries(Object.entries(ACCOUNT_FIELDS).map(([k, s]) => [k, s.def]));
const MAX_USERNAME = 256;
const MAX_PASSWORD = 1024;
const MAX_BACKUP_BYTES = 5 * 1024 * 1024;
const MIN_PASSPHRASE = 8;
const PENDING_IMPORT_TTL_MS = 10 * 60 * 1000;

function validUsername(u) {
    return typeof u === 'string' && u.trim().length > 0 && u.length <= MAX_USERNAME;
}

// Picks the known fields out of `data`. With `base` (an existing record),
// missing or null fields keep the base value; without it they get defaults.
// Returns { ok: true, fields } or { ok: false, message }.
function pickFields(data, base) {
    const fields = {};
    for (const [key, spec] of Object.entries(ACCOUNT_FIELDS)) {
        const v = data[key];
        if (v === undefined || v === null) {
            fields[key] = base ? (base[key] ?? spec.def) : spec.def;
            continue;
        }
        if (typeof v !== spec.type) return { ok: false, message: `Invalid value for ${key}` };
        if (spec.type === 'string' && v.length > spec.max) return { ok: false, message: `${key} is too long` };
        fields[key] = v;
    }
    return { ok: true, fields };
}

function errorResult(e) {
    return { success: false, message: e?.message || String(e) };
}

// Writes via a temp file and rename so a failed export never leaves a
// half-written backup under the chosen name.
function writeFileAtomic(filePath, text) {
    const tmp = `${filePath}.tmp`;
    try {
        fs.writeFileSync(tmp, text);
        fs.renameSync(tmp, filePath);
    } catch (e) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
        throw e;
    }
}

// A backup chosen in the file dialog that still needs its passphrase. The
// contents are kept (not the path) so the file cannot change in between.
let _pendingImport = null;

function register() {
    ipcMain.handle('get-accounts', () => {
        if (vault.isVaultLocked()) return [];
        // passwordOk lets the renderer flag accounts whose stored password can't
        // be decrypted under the current key (e.g. after a Windows update broke
        // the old wmic-derived key) *before* the user tries to launch and hits
        // the failure mid-flow — never the plaintext itself, just whether it's
        // readable. honorFlagged is true once this account's honor level has
        // dropped below its previously observed peak (see honor-watch.js).
        //
        // honor-watch is loaded once here rather than per-account (isHonorFlagged
        // would otherwise re-read and re-parse the whole file once per account,
        // O(N) sync disk reads on every get-accounts call).
        const honorWatch = loadHonorWatch();
        return loadAccounts().map(a => ({
            ...a,
            password: '',
            passwordOk: decrypt(a.password) !== null,
            honorFlagged: isFlaggedRecord(getHonorRecord(honorWatch, a.username)),
        }));
    });

    ipcMain.handle('add-account', (event, data) => {
        if (vault.isVaultLocked()) return vault.lockedResult();
        if (!data || typeof data !== 'object') return { success: false, message: 'Invalid account data' };
        if (!validUsername(data.username)) return { success: false, message: 'Enter a username' };
        if (typeof data.password !== 'string' || !data.password) return { success: false, message: 'Enter a password' };
        if (data.password.length > MAX_PASSWORD) return { success: false, message: 'Password is too long' };
        const picked = pickFields(data);
        if (!picked.ok) return { success: false, message: picked.message };

        try {
            const accounts = loadAccounts();
            // Case-insensitive — session/active-account matching elsewhere (launch.js,
            // lcu-events.js) is case-insensitive, so allowing "Player1" and "player1"
            // as distinct accounts here would let LCU session detection misattribute
            // state (appearOffline, auto-skin, "currently active" highlight) to the
            // wrong one.
            if (accounts.some(a => sameUser(a.username, data.username))) {
                return { success: false, message: 'Account already exists' };
            }
            accounts.push({ username: data.username, password: encrypt(data.password), ...picked.fields });
            saveAccounts(accounts);
        } catch (e) {
            return errorResult(e);
        }
        broadcastAccountsUpdate();
        return { success: true };
    });

    ipcMain.handle('update-account', (event, data) => {
        if (vault.isVaultLocked()) return vault.lockedResult();
        if (!data || typeof data !== 'object' || typeof data.username !== 'string') return { success: false, message: 'Invalid account data' };
        if (data.password !== undefined && data.password !== null && data.password !== '' &&
            (typeof data.password !== 'string' || data.password.length > MAX_PASSWORD)) {
            return { success: false, message: 'Invalid password' };
        }

        let updated;
        try {
            const accounts = loadAccounts();
            const index    = accounts.findIndex(a => sameUser(a.username, data.username));
            if (index === -1) return { success: false, message: 'Account not found' };

            const old = accounts[index];
            const picked = pickFields(data, old);
            if (!picked.ok) return { success: false, message: picked.message };
            updated = { ...old, ...picked.fields };
            if (data.password) updated.password = encrypt(data.password);
            accounts[index] = updated;
            saveAccounts(accounts);
        } catch (e) {
            return errorResult(e);
        }
        broadcastAccountsUpdate();

        // Live-update active account settings without disrupting login state
        if (sameUser(state.currentAccount?.username, updated.username)) {
            state.currentAccount = { ...state.currentAccount, ...updated, password: state.currentAccount.password };
        }

        return { success: true };
    });

    ipcMain.handle('delete-account', (event, username) => {
        if (vault.isVaultLocked()) return vault.lockedResult();
        if (typeof username !== 'string') return { success: false, message: 'Account not found' };
        try {
            const accounts = loadAccounts();
            const index = accounts.findIndex(a => sameUser(a.username, username));
            if (index === -1) return { success: false, message: 'Account not found' };
            const [removed] = accounts.splice(index, 1);
            saveAccounts(accounts);
            // Re-adding the same username later must not inherit an old honor flag.
            forgetHonor(removed.username);
            if (sameUser(state.currentAccount?.username, removed.username)) state.currentAccount = null;
        } catch (e) {
            return errorResult(e);
        }
        broadcastAccountsUpdate();
        return { success: true };
    });

    ipcMain.handle('get-vault-state', () => vault.getVaultState());

    ipcMain.handle('unlock-vault', async (event, password) => {
        const wasLocked = vault.isVaultLocked();
        const res = await vault.unlockVault(password);
        // Tray menu and jump list list no accounts while locked; rebuild them.
        if (res.success && wasLocked) broadcastAccountsUpdate();
        return res;
    });

    // Enabling or disabling changes what the tray and jump list may show.
    ipcMain.handle('set-vault-password', async (event, payload) => {
        const res = await vault.setVaultPassword(payload);
        if (res.success) broadcastAccountsUpdate();
        return res;
    });

    ipcMain.handle('disable-vault', async (event, current) => {
        const res = await vault.disableVault(current);
        if (res.success) broadcastAccountsUpdate();
        return res;
    });

    ipcMain.handle('get-account-password', (event, username) => {
        // The renderer's lock screen is only a UI gate — enforce the vault here too,
        // otherwise anything that can call exposed IPC methods (e.g. devtools) could
        // read every plaintext password without ever unlocking. Returns a string or
        // null (also while locked), which is what the renderer checks.
        if (vault.isVaultLocked()) return null;
        if (typeof username !== 'string') return null;
        const acc = loadAccounts().find(a => sameUser(a.username, username));
        if (!acc) return null;
        return decrypt(acc.password);
    });

    ipcMain.handle('reorder-accounts', (event, usernames) => {
        if (vault.isVaultLocked()) return vault.lockedResult();
        if (!Array.isArray(usernames) || !usernames.every(u => typeof u === 'string')) {
            return { success: false, message: 'Invalid order' };
        }
        try {
            const accounts = loadAccounts();
            const map = new Map(accounts.map(a => [a.username.toLowerCase(), a]));
            const ordered = [];
            const included = new Set();
            for (const u of usernames) {
                const a = map.get(u.toLowerCase());
                if (a && !included.has(a)) { ordered.push(a); included.add(a); }
            }
            // Append any accounts not present in the new order list (safety net)
            accounts.filter(a => !included.has(a)).forEach(a => ordered.push(a));
            saveAccounts(ordered);
        } catch (e) {
            return errorResult(e);
        }
        broadcastAccountsUpdate();
        return { success: true };
    });

    ipcMain.handle('export-accounts', async (event, passphrase) => {
        if (vault.isVaultLocked()) return vault.lockedResult();
        // Not trimmed: the passphrase is used exactly as typed.
        if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE) {
            return { success: false, message: `The passphrase needs at least ${MIN_PASSPHRASE} characters` };
        }
        try {
            const result = await dialog.showSaveDialog(state.mainWindow, {
                title: 'Export Accounts',
                defaultPath: 'lost-league-accounts.llem',
                filters: [{ name: 'Lost League Backup', extensions: ['llem'] }],
            });
            if (result.canceled || !result.filePath) return { success: false, canceled: true };

            const accounts = loadAccounts();
            let unreadable = 0;
            const exportData = {
                version: 1,
                exported: Date.now(),
                accounts: accounts.map(a => {
                    const password = decrypt(a.password);
                    if (password === null) unreadable++;
                    const picked = pickFields(a, ACCOUNT_DEFAULTS);
                    return { username: a.username, password: password ?? '', ...(picked.ok ? picked.fields : {}) };
                }),
            };
            writeFileAtomic(result.filePath, await encryptExport(exportData, passphrase));
            return { success: true, count: accounts.length, unreadable };
        } catch (e) {
            return errorResult(e);
        }
    });

    ipcMain.handle('import-accounts', async (event, opts) => {
        if (vault.isVaultLocked()) return vault.lockedResult();
        const passphrase = opts && typeof opts === 'object' && typeof opts.passphrase === 'string' ? opts.passphrase : undefined;
        try {
            // A call without a passphrase starts over with a new file.
            if (_pendingImport && (passphrase === undefined || Date.now() - _pendingImport.at > PENDING_IMPORT_TTL_MS)) {
                _pendingImport = null;
            }

            let text;
            if (_pendingImport) {
                text = _pendingImport.text;
            } else {
                const result = await dialog.showOpenDialog(state.mainWindow, {
                    title: 'Import Accounts',
                    filters: [{ name: 'Lost League Backup', extensions: ['llem'] }],
                    properties: ['openFile'],
                });
                if (result.canceled || !result.filePaths?.length) return { success: false, canceled: true };
                const file = result.filePaths[0];
                if (fs.statSync(file).size > MAX_BACKUP_BYTES) return { success: false, message: 'This file is too large to be a backup' };
                text = fs.readFileSync(file, 'utf8').trim();
            }

            let data;
            const version = backupVersion(text);
            if (version === 'v1') {
                data = decryptExportV1(text);
            } else if (version === 'v2') {
                if (!passphrase) {
                    _pendingImport = { text, at: Date.now() };
                    return { success: false, needsPassphrase: true };
                }
                const r = await decryptExport(text, passphrase);
                if (!r.ok && r.reason === 'wrong-passphrase') {
                    _pendingImport = { text, at: Date.now() };
                    return { success: false, needsPassphrase: true, wrongPassphrase: true };
                }
                data = r.ok ? r.data : null;
            }
            _pendingImport = null;

            if (!data || typeof data !== 'object' || !Array.isArray(data.accounts)) {
                return { success: false, message: 'Invalid or corrupted backup file' };
            }
            if (typeof data.version === 'number' && data.version > 1) {
                return { success: false, message: 'This backup was made by a newer version of the app' };
            }
            return importRecords(data.accounts);
        } catch (e) {
            return errorResult(e);
        }
    });
}

function importRecords(records) {
    const existing = loadAccounts();
    let added = 0, duplicates = 0, invalid = 0, withoutPassword = 0;
    for (const acc of records) {
        if (!acc || typeof acc !== 'object' || !validUsername(acc.username)) { invalid++; continue; }
        // Accounts whose password could not be read at export come with ''.
        // Keep them (label, notes, Riot ID); the app asks for the password.
        const password = acc.password ?? '';
        if (typeof password !== 'string' || password.length > MAX_PASSWORD) { invalid++; continue; }
        const picked = pickFields(acc);
        if (!picked.ok) { invalid++; continue; }
        if (existing.some(e => sameUser(e.username, acc.username))) { duplicates++; continue; }
        // encrypt() throws without the machine key; nothing is saved then.
        existing.push({ username: acc.username, password: password ? encrypt(password) : '', ...picked.fields });
        if (!password) withoutPassword++;
        added++;
    }
    if (added > 0) {
        saveAccounts(existing);
        broadcastAccountsUpdate();
    }
    return { success: true, added, skipped: duplicates + invalid, duplicates, invalid, withoutPassword };
}

module.exports = { register };
