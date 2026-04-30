const { ipcMain } = require('electron');
const { loadAccounts, saveAccounts } = require('../services/storage');
const { encrypt } = require('../services/encryption');
const { broadcastAccountsUpdate } = require('../windows');

function register() {
    ipcMain.handle('get-accounts', () => {
        return loadAccounts().map(a => ({ ...a, password: '' }));
    });

    ipcMain.handle('add-account', (event, data) => {
        const accounts = loadAccounts();
        if (accounts.find(a => a.username === data.username)) {
            return { success: false, message: 'Account already exists' };
        }

        accounts.push({
            username:         data.username,
            password:         encrypt(data.password),
            label:            data.label            || '',
            riotId:           data.riotId           || '',
            region:           data.region           || '',
            autoPickChamp:    data.autoPickChamp    || '',
            autoBanChamp:     data.autoBanChamp     || '',
            notes:            data.notes            || '',
            autoQueue:        data.autoQueue        || false,
            queueType:        data.queueType        || 'RANKED_SOLO',
            primaryRole:      data.primaryRole      || '',
            secondaryRole:    data.secondaryRole    || '',
            appearOffline:    data.appearOffline    || false,
            autoSkinRandom:   data.autoSkinRandom   || false,
            autoSpells:       data.autoSpells       || false,
            minimizeOnLaunch: data.minimizeOnLaunch || false,
            chatOnDeath:      data.chatOnDeath      || '',
            chatOnKill:       data.chatOnKill       || '',
            chatOnAssist:     data.chatOnAssist     || '',
            chatOnGameStart:  data.chatOnGameStart  || '',
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
            label:          data.label          ?? old.label,
            riotId:         data.riotId         ?? old.riotId,
            region:         data.region         ?? old.region,
            autoPickChamp:  data.autoPickChamp  !== undefined ? data.autoPickChamp  : old.autoPickChamp,
            autoBanChamp:   data.autoBanChamp   !== undefined ? data.autoBanChamp   : old.autoBanChamp,
            notes:          data.notes          !== undefined ? data.notes          : old.notes,
            autoQueue:      data.autoQueue      !== undefined ? data.autoQueue      : old.autoQueue,
            queueType:      data.queueType      !== undefined ? data.queueType      : old.queueType,
            primaryRole:    data.primaryRole    !== undefined ? data.primaryRole    : old.primaryRole,
            secondaryRole:  data.secondaryRole  !== undefined ? data.secondaryRole  : old.secondaryRole,
            appearOffline:  data.appearOffline  !== undefined ? data.appearOffline  : old.appearOffline,
            autoSkinRandom: data.autoSkinRandom !== undefined ? data.autoSkinRandom : old.autoSkinRandom,
            autoSpells:     data.autoSpells     !== undefined ? data.autoSpells     : old.autoSpells,
            minimizeOnLaunch: data.minimizeOnLaunch !== undefined ? data.minimizeOnLaunch : (old.minimizeOnLaunch || false),
            chatOnDeath:      data.chatOnDeath     !== undefined ? data.chatOnDeath     : (old.chatOnDeath     || ''),
            chatOnKill:       data.chatOnKill      !== undefined ? data.chatOnKill      : (old.chatOnKill      || ''),
            chatOnAssist:     data.chatOnAssist    !== undefined ? data.chatOnAssist    : (old.chatOnAssist    || ''),
            chatOnGameStart:  data.chatOnGameStart !== undefined ? data.chatOnGameStart : (old.chatOnGameStart || ''),
        };

        if (data.password) accounts[index].password = encrypt(data.password);

        saveAccounts(accounts);
        broadcastAccountsUpdate();

        // Live-update active account settings without disrupting login state
        const state = require('../state');
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
}

module.exports = { register };
