const { ipcMain, dialog } = require('electron');
const fs = require('fs');
const { loadAccounts, saveAccounts } = require('../services/storage');
const { encrypt, decrypt, encryptExport, decryptExport } = require('../services/encryption');
const { broadcastAccountsUpdate } = require('../windows');
const { loadHonorWatch, isFlaggedRecord } = require('../services/honor-watch');
const state = require('../state');

function register() {
    ipcMain.handle('get-accounts', () => {
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
            honorFlagged: isFlaggedRecord(honorWatch[a.username]),
        }));
    });

    ipcMain.handle('add-account', (event, data) => {
        const accounts = loadAccounts();
        // Case-insensitive — session/active-account matching elsewhere (launch.js,
        // lcu-events.js) is case-insensitive, so allowing "Player1" and "player1"
        // as distinct accounts here would let LCU session detection misattribute
        // state (appearOffline, auto-skin, "currently active" highlight) to the
        // wrong one.
        const usernameLower = (data.username || '').toLowerCase();
        if (accounts.find(a => a.username.toLowerCase() === usernameLower)) {
            return { success: false, message: 'Account already exists' };
        }

        accounts.push({
            username:         data.username,
            password:         encrypt(data.password),
            label:            data.label            || '',
            riotId:           data.riotId           || '',
            region:           data.region           || '',
            notes:            data.notes            || '',
            appearOffline:    data.appearOffline    || false,
            autoSkinRandom:   data.autoSkinRandom   || false,
            autoChampLock:    data.autoChampLock    || '',
            minimizeOnLaunch: data.minimizeOnLaunch || false,
            isFavourite:      data.isFavourite      || false,
            customRank:       data.customRank       || '',
            customAvatar:     data.customAvatar     || '',
        });

        saveAccounts(accounts);
        broadcastAccountsUpdate();
        return { success: true };
    });

    ipcMain.handle('update-account', (event, data) => {
        const accounts = loadAccounts();
        const index    = accounts.findIndex(a => a.username === data.username);
        if (index === -1) return { success: false, message: 'Account not found' };

        const old = accounts[index];
        accounts[index] = {
            ...old,
            label:            data.label            ?? old.label,
            riotId:           data.riotId           ?? old.riotId,
            region:           data.region           ?? old.region,
            notes:            data.notes            !== undefined ? data.notes            : old.notes,
            appearOffline:    data.appearOffline    !== undefined ? data.appearOffline    : old.appearOffline,
            autoSkinRandom:   data.autoSkinRandom   !== undefined ? data.autoSkinRandom   : old.autoSkinRandom,
            autoChampLock:    data.autoChampLock    !== undefined ? data.autoChampLock    : (old.autoChampLock  || ''),
            minimizeOnLaunch: data.minimizeOnLaunch !== undefined ? data.minimizeOnLaunch : (old.minimizeOnLaunch || false),
            isFavourite:      data.isFavourite      !== undefined ? data.isFavourite      : (old.isFavourite     || false),
            customRank:       data.customRank       !== undefined ? data.customRank       : (old.customRank      || ''),
            customAvatar:     data.customAvatar     !== undefined ? data.customAvatar     : (old.customAvatar    || ''),
        };

        if (data.password) accounts[index].password = encrypt(data.password);

        saveAccounts(accounts);
        broadcastAccountsUpdate();

        // Live-update active account settings without disrupting login state
        if (state.currentAccount?.username === data.username) {
            state.currentAccount = { ...state.currentAccount, ...accounts[index], password: state.currentAccount.password };
        }

        return { success: true };
    });

    ipcMain.handle('delete-account', (event, username) => {
        const accounts = loadAccounts().filter(a => a.username !== username);
        saveAccounts(accounts);
        broadcastAccountsUpdate();
        return { success: true };
    });

    ipcMain.handle('unlock-vault', (event, passwordHash) => {
        if (!state.config.vaultEnabled || !state.config.vaultPasswordHash) {
            state.vaultUnlocked = true;
            return { success: true };
        }
        if (passwordHash && passwordHash === state.config.vaultPasswordHash) {
            state.vaultUnlocked = true;
            return { success: true };
        }
        return { success: false };
    });

    ipcMain.handle('get-account-password', (event, username) => {
        // The renderer's lock screen is only a UI gate — enforce the vault here too,
        // otherwise anything that can call exposed IPC methods (e.g. devtools) could
        // read every plaintext password without ever unlocking.
        if (state.config.vaultEnabled && !state.vaultUnlocked) return null;
        const acc = loadAccounts().find(a => a.username === username);
        if (!acc) return null;
        return decrypt(acc.password);
    });

    ipcMain.handle('reorder-accounts', (event, usernames) => {
        const accounts = loadAccounts();
        const map = new Map(accounts.map(a => [a.username, a]));
        const ordered = usernames.map(u => map.get(u)).filter(Boolean);
        // Append any accounts not present in the new order list (safety net)
        const included = new Set(usernames);
        accounts.filter(a => !included.has(a.username)).forEach(a => ordered.push(a));
        saveAccounts(ordered);
        broadcastAccountsUpdate();
        return { success: true };
    });

    ipcMain.handle('export-accounts', async () => {
        if (state.config.vaultEnabled && !state.vaultUnlocked) {
            return { success: false, message: 'Vault is locked' };
        }
        const result = await dialog.showSaveDialog(state.mainWindow, {
            title: 'Export Accounts',
            defaultPath: 'lost-league-accounts.llem',
            filters: [{ name: 'Lost League Backup', extensions: ['llem'] }],
        });
        if (result.canceled) return { success: false, canceled: true };

        const accounts = loadAccounts();
        const exportData = {
            version: 1,
            exported: Date.now(),
            accounts: accounts.map(a => ({ ...a, password: decrypt(a.password) || '' })),
        };
        fs.writeFileSync(result.filePath, encryptExport(exportData));
        return { success: true, count: accounts.length };
    });

    ipcMain.handle('import-accounts', async () => {
        const result = await dialog.showOpenDialog(state.mainWindow, {
            title: 'Import Accounts',
            filters: [{ name: 'Lost League Backup', extensions: ['llem'] }],
            properties: ['openFile'],
        });
        if (result.canceled || !result.filePaths.length) return { success: false, canceled: true };

        const raw = fs.readFileSync(result.filePaths[0], 'utf8').trim();
        const data = decryptExport(raw);
        if (!data || !Array.isArray(data.accounts)) {
            return { success: false, message: 'Invalid or corrupted backup file' };
        }

        const existing = loadAccounts();
        let added = 0, skipped = 0;
        for (const acc of data.accounts) {
            if (!acc.username || !acc.password) { skipped++; continue; }
            if (existing.find(e => e.username.toLowerCase() === acc.username.toLowerCase())) { skipped++; continue; }
            existing.push({ ...acc, password: encrypt(acc.password) });
            added++;
        }
        saveAccounts(existing);
        broadcastAccountsUpdate();
        return { success: true, added, skipped };
    });
}

module.exports = { register };
