const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    closeWindow: () => ipcRenderer.invoke('window-control', 'close'),
    minimizeWindow: () => ipcRenderer.invoke('window-control', 'minimize'),

    getAccounts: () => ipcRenderer.invoke('get-accounts'),
    addAccount: (data) => ipcRenderer.invoke('add-account', data),
    updateAccount: (data) => ipcRenderer.invoke('update-account', data),
    deleteAccount: (username) => ipcRenderer.invoke('delete-account', username),

    // getConfig returns no secrets: riotApiKeySet and vaultEnabled instead.
    getConfig: () => ipcRenderer.invoke('get-config'),
    setConfig: (config) => ipcRenderer.invoke('set-config', config),
    setRiotApiKey: (key) => ipcRenderer.invoke('set-riot-api-key', key),

    launchAccount: (username, opts) => ipcRenderer.invoke('launch-account', username, opts),
    launchLeagueClient: () => ipcRenderer.invoke('launch-league-client'),
    cancelLaunch: () => ipcRenderer.invoke('cancel-launch'),
    getStats: (region, riotId, force = false) => ipcRenderer.invoke('get-stats', { region, riotId, force }),
    lookupSummoner: (input, region) => ipcRenderer.invoke('lookup-summoner', { input, region }),
    getClientSummoner: () => ipcRenderer.invoke('get-client-summoner'),
    getMatchHistory: (region, riotId) => ipcRenderer.invoke('get-match-history', { region, riotId }),
    getRankHistory: (riotId) => ipcRenderer.invoke('get-rank-history', riotId),

    acceptMatch: () => ipcRenderer.invoke('accept-match'),

    changeLanguage: (locale) => ipcRenderer.invoke('change-language', locale),
    dodgeQueue: () => ipcRenderer.invoke('dodge-queue'),
    getLobbyMembers: () => ipcRenderer.invoke('get-lobby-members'),

    fixClient: () => ipcRenderer.invoke('fix-client'),
    repairClient: () => ipcRenderer.invoke('repair-client'),
    clearClientCache: () => ipcRenderer.invoke('clear-client-cache'),
    openDataFolder: () => ipcRenderer.invoke('open-data-folder'),

    reorderAccounts: (usernames) => ipcRenderer.invoke('reorder-accounts', usernames),
    // Vault: the plaintext password goes to the main process, which checks it.
    unlockVault: (password) => ipcRenderer.invoke('unlock-vault', password),
    getVaultState: () => ipcRenderer.invoke('get-vault-state'),
    setVaultPassword: ({ current, next } = {}) => ipcRenderer.invoke('set-vault-password', { current, next }),
    disableVault: (current) => ipcRenderer.invoke('disable-vault', current),
    getAccountPassword: (username) => ipcRenderer.invoke('get-account-password', username),
    exportAccounts: (passphrase) => ipcRenderer.invoke('export-accounts', passphrase),
    importAccounts: ({ passphrase } = {}) => ipcRenderer.invoke('import-accounts', { passphrase }),
    openFileDialog: (options) => ipcRenderer.invoke('open-file-dialog', options),
    getCurrentAccount: () => ipcRenderer.invoke('get-current-account'),
    getLcuOverview: () => ipcRenderer.invoke('get-lcu-overview'),
    onLcuConnected:    (cb) => ipcRenderer.on('lcu-connected',    () => cb()),
    onLcuDisconnected: (cb) => ipcRenderer.on('lcu-disconnected', () => cb()),
    onLcuGameflow:     (cb) => ipcRenderer.on('lcu-gameflow',  (_, phase) => cb(phase)),
    setProfileBackground: (championName, skinId) => ipcRenderer.invoke('set-profile-background', { championName, skinId }),
    setStatusMessage: (message) => ipcRenderer.invoke('set-status-message', message),

    onChampSelectUpdate: (callback) => ipcRenderer.on('champ-select-update', (event, data) => callback(data)),
    onChampSelectEnd: (callback) => ipcRenderer.on('champ-select-end', () => callback()),
    onLoginStatus: (callback) => ipcRenderer.on('login-status', (event, data) => callback(data)),
    onAccountsUpdated: (callback) => ipcRenderer.on('accounts-updated', () => callback()),
    onLaunchAccountInfo: (callback) => ipcRenderer.on('launch-account-info', (event, data) => callback(data)),

    resetOverlayPosition: () => ipcRenderer.invoke('overlay-reset-position'),

    // Updates
    checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
    installUpdate: () => ipcRenderer.invoke('install-update'),
    getVersion: () => ipcRenderer.invoke('get-version'),
    onUpdateAvailable: (callback) => ipcRenderer.on('update-available', (event, data) => callback(data)),
    onUpdateProgress: (callback) => ipcRenderer.on('update-progress', (event, data) => callback(data)),
    onUpdateDownloaded: (callback) => ipcRenderer.on('update-downloaded', (event, data) => callback(data)),
    onUpdateError: (callback) => ipcRenderer.on('update-error', (event, message) => callback(message)),

    // Overwolf GEP (Game Events Provider)
    onGepGameEvent: (callback) => ipcRenderer.on('gep-game-event', (event, data) => callback(data)),
    onGepInfoUpdate: (callback) => ipcRenderer.on('gep-info-update', (event, data) => callback(data)),

    // Dodge info (queue type + active penalty) — call before confirming a dodge
    getDodgeInfo: () => ipcRenderer.invoke('get-dodge-info'),

    openExternal:   (url) => ipcRenderer.invoke('open-external', url),
    openOpgg:       (region, riotId) => ipcRenderer.invoke('open-opgg', region, riotId),
    openPatchNotes: () => ipcRenderer.invoke('open-patch-notes'),
    getChampionList: () => ipcRenderer.invoke('get-champion-list'),
    getChampionFullData: (champKey) => ipcRenderer.invoke('get-champion-full-data', champKey),
    getItemList: () => ipcRenderer.invoke('get-item-list'),
    setZoomFactor: (factor) => ipcRenderer.invoke('set-zoom-factor', factor),

    // Fired when LCU connect reveals which account is logged in externally
    onActiveAccountDetected: (cb) => ipcRenderer.on('active-account-detected', (_, username) => cb(username)),
});
