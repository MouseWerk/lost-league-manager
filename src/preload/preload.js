const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    closeWindow: () => ipcRenderer.invoke('window-control', 'close'),
    minimizeWindow: () => ipcRenderer.invoke('window-control', 'minimize'),

    getAccounts: () => ipcRenderer.invoke('get-accounts'),
    addAccount: (data) => ipcRenderer.invoke('add-account', data),
    updateAccount: (data) => ipcRenderer.invoke('update-account', data),
    deleteAccount: (username) => ipcRenderer.invoke('delete-account', username),

    getConfig: () => ipcRenderer.invoke('get-config'),
    setConfig: (config) => ipcRenderer.invoke('set-config', config),

    launchAccount: (username) => ipcRenderer.invoke('launch-account', username),
    cancelLaunch: () => ipcRenderer.invoke('cancel-launch'),
    getStats: (region, riotId) => ipcRenderer.invoke('get-stats', { region, riotId }),

    acceptMatch: () => ipcRenderer.invoke('accept-match'),

    changeLanguage: (locale) => ipcRenderer.invoke('change-language', locale),
    dodgeQueue: () => ipcRenderer.invoke('dodge-queue'),
    getLobbyMembers: () => ipcRenderer.invoke('get-lobby-members'),

    fixClient: () => ipcRenderer.invoke('fix-client'),
    setProfileBackground: (championName, skinId) => ipcRenderer.invoke('set-profile-background', { championName, skinId }),
    setStatusMessage: (message) => ipcRenderer.invoke('set-status-message', message),

    onChampSelectUpdate: (callback) => ipcRenderer.on('champ-select-update', (event, data) => callback(data)),
    onChampSelectEnd: (callback) => ipcRenderer.on('champ-select-end', () => callback()),
    onLoginStatus: (callback) => ipcRenderer.on('login-status', (event, data) => callback(data)),
    onAccountsUpdated: (callback) => ipcRenderer.on('accounts-updated', () => callback()),

    // Updates
    checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
    installUpdate: () => ipcRenderer.invoke('install-update'),
    getVersion: () => ipcRenderer.invoke('get-version'),
    onUpdateAvailable: (callback) => ipcRenderer.on('update-available', (event, data) => callback(data)),
    onUpdateProgress: (callback) => ipcRenderer.on('update-progress', (event, data) => callback(data)),
    onUpdateDownloaded: (callback) => ipcRenderer.on('update-downloaded', (event, data) => callback(data)),
    onUpdateError: (callback) => ipcRenderer.on('update-error', (event, message) => callback(message))
});
