const { ipcMain, app } = require('electron');
const fs = require('fs');
const path = require('path');
const state = require('../state');
const { saveConfig } = require('../services/storage');
const secrets = require('../services/secrets');
const { isVaultEnabled } = require('../services/vault');
const discordRpc = require('../services/discord-rpc');

// UI scale steps offered in Settings, with some room for hand-edited values.
const MIN_UI_SCALE = 0.5;
const MAX_UI_SCALE = 2.0;

function isLeagueClientPath(v) {
    return typeof v === 'string' && path.isAbsolute(v) &&
        path.basename(v).toLowerCase() === 'leagueclient.exe' && fs.existsSync(v);
}

// Whitelist of keys the renderer is allowed to set, with a check for each —
// set-config used to Object.assign() the raw payload straight into live
// config, so any bug (or compromised renderer) could inject unknown keys or
// overwrite sensitive ones with the wrong shape. Secrets and the vault have
// their own calls (set-riot-api-key, set-vault-password, disable-vault) and
// are refused here.
const ALLOWED_CONFIG_KEYS = {
    autoAccept:            v => typeof v === 'boolean',
    checkUpdatesOnStartup: v => typeof v === 'boolean',
    discordRpcEnabled:     v => typeof v === 'boolean',
    lastSeenPatchNotesVersion: v => typeof v === 'string' && v.length <= 64,
    // Launch and repair start or delete files next to this path.
    lolPath:               isLeagueClientPath,
    minimizeOnGameStart:   v => typeof v === 'boolean',
    overlayEnabled:        v => typeof v === 'boolean',
    overlayLocked:         v => typeof v === 'boolean',
    overlayShowBuilds:     v => typeof v === 'boolean',
    overlayShowRanked:     v => typeof v === 'boolean',
    startMinimized:        v => typeof v === 'boolean',
    startWithWindows:      v => typeof v === 'boolean',
    toastOnQueuePop:       v => typeof v === 'boolean',
    uiScale:               v => typeof v === 'number' && Number.isFinite(v) && v >= MIN_UI_SCALE && v <= MAX_UI_SCALE,
};

// Never sent to the renderer.
const PRIVATE_CONFIG_KEYS = ['riotApiKey', 'riotApiKeyEnc', 'vaultPasswordHash', 'vaultHash', 'vaultSalt', 'vaultKdf'];

function publicConfig() {
    const out = { ...state.config };
    for (const k of PRIVATE_CONFIG_KEYS) delete out[k];
    out.vaultEnabled  = isVaultEnabled();
    out.riotApiKeySet = secrets.hasRiotApiKey();
    return out;
}

function pushOverlaySettings() {
    const ow = state.overlayWindow;
    if (!ow || ow.isDestroyed()) return;
    ow.webContents.send('overlay-settings-update', {
        showRanked: state.config.overlayShowRanked !== false,
        showBuilds: state.config.overlayShowBuilds !== false,
        locked:     state.config.overlayLocked     || false,
    });
}

function register() {
    ipcMain.handle('get-config', () => {
        state.config.startWithWindows = app.getLoginItemSettings().openAtLogin;
        return publicConfig();
    });

    ipcMain.handle('set-riot-api-key', (event, key) => {
        const prev = { riotApiKey: state.config.riotApiKey, riotApiKeyEnc: state.config.riotApiKeyEnc };
        const res = secrets.setRiotApiKey(state.config, key);
        if (!res.success) return res;
        try {
            saveConfig();
        } catch (e) {
            for (const [k, v] of Object.entries(prev)) {
                if (v === undefined) delete state.config[k]; else state.config[k] = v;
            }
            secrets.loadSecrets(state.config);
            return { success: false, message: `Could not save the key: ${e.message}` };
        }
        return { success: true };
    });

    ipcMain.handle('set-config', (event, newConfig) => {
        if (!newConfig || typeof newConfig !== 'object') return { success: false, message: 'Invalid config payload' };

        const prev = { ...state.config };
        const rejected = [];
        for (const [key, value] of Object.entries(newConfig)) {
            const isValid = ALLOWED_CONFIG_KEYS[key];
            if (!isValid) { console.warn(`[Config] Rejected unknown config key: ${key}`); rejected.push(key); continue; }
            if (!isValid(value)) { console.warn(`[Config] Rejected invalid value for config key: ${key}`); rejected.push(key); continue; }
            state.config[key] = value;
        }
        if (rejected.length < Object.keys(newConfig).length) {
            try {
                saveConfig();
            } catch (e) {
                Object.assign(state.config, prev);
                return { success: false, message: `Could not save settings: ${e.message}` };
            }
        }

        // Compare against what was actually applied to state.config (post-validation),
        // not the raw payload — a rejected/invalid value must not trigger side effects.
        const ow = state.overlayWindow;
        if (ow && !ow.isDestroyed()) {
            // Live-toggle overlay visibility when overlayEnabled changes
            if (state.config.overlayEnabled !== prev.overlayEnabled) {
                if (!state.config.overlayEnabled) {
                    ow.hide();
                }
                // When re-enabled, show only if a game is currently in progress (handled by lcu-events)
            }

            // Push panel visibility / lock changes live
            const panelKeys = ['overlayShowRanked', 'overlayShowBuilds', 'overlayLocked'];
            if (panelKeys.some(k => state.config[k] !== prev[k])) {
                pushOverlaySettings();
            }
        }

        if (state.config.startWithWindows !== prev.startWithWindows) {
            app.setLoginItemSettings({ openAtLogin: !!state.config.startWithWindows });
        }

        if (state.config.discordRpcEnabled !== prev.discordRpcEnabled) {
            discordRpc.setEnabled(state.config.discordRpcEnabled);
        }

        // Previously always returned success even when every key in the payload
        // was silently dropped (unknown key, or wrong type) — callers had no way
        // to tell "applied" from "quietly ignored" short of grepping main-process
        // logs, so the renderer would show "updated!" for a change that never
        // actually took effect.
        if (rejected.length > 0) {
            return { success: false, message: `Rejected invalid config key(s): ${rejected.join(', ')}`, rejected };
        }
        return { success: true };
    });
}

module.exports = { register };
