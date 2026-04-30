const { ipcMain, dialog } = require('electron');
const path  = require('path');
const fs    = require('fs');
const { spawn } = require('child_process');
const lcu   = require('../lcu');
const state = require('../state');

const KILL_ALL = 'Get-Process -Name LeagueClient, LeagueClientUx, RiotClientServices, RiotClientUx -ErrorAction SilentlyContinue | Stop-Process -Force';
const KILL_CLIENT = 'Get-Process -Name LeagueClient, LeagueClientUx -ErrorAction SilentlyContinue | Stop-Process -Force';

function register() {
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
            const gameDir     = path.dirname(state.config.lolPath);
            const settingsPath = path.join(gameDir, 'Config', 'LeagueClientSettings.yaml');

            if (!fs.existsSync(settingsPath)) {
                return { success: false, message: `Config not found at ${settingsPath}` };
            }

            let content = fs.readFileSync(settingsPath, 'utf8');
            const regex = /locale: ".*?"/;
            if (!regex.test(content)) {
                return { success: false, message: 'Locale key not found in settings file' };
            }

            fs.writeFileSync(settingsPath, content.replace(regex, `locale: "${locale}"`));
            return { success: true };
        } catch (e) {
            return { success: false, message: e.message };
        }
    });

    ipcMain.handle('dodge-queue', async () => {
        try {
            spawn('powershell.exe', ['-Command', KILL_CLIENT]);
            return { success: true };
        } catch (e) {
            return { success: false, message: e.message };
        }
    });

    ipcMain.handle('fix-client', async () => {
        spawn('powershell.exe', ['-Command', KILL_ALL]);
        return { success: true };
    });

    ipcMain.handle('get-lobby-members', async () => {
        try {
            const session = await lcu.request('GET', '/lol-champ-select/v1/session');
            if (!session) return { success: false, message: 'No champ select session' };

            const names = [];
            for (const m of session.myTeam) {
                if (m.summonerId && m.summonerId > 0) {
                    try {
                        const summ = await lcu.request('GET', `/lol-summoner/v1/summoners/${m.summonerId}`);
                        if (summ?.gameName) names.push(`${summ.gameName}#${summ.tagLine}`);
                    } catch { /* skip failed lookup */ }
                }
            }
            return { success: true, names };
        } catch (e) {
            return { success: false, message: e.message };
        }
    });

    ipcMain.handle('set-profile-background', async (event, { championName, skinId }) => {
        try {
            const me = await lcu.request('GET', '/lol-summoner/v1/current-summoner');
            if (!me) return { success: false, message: 'Not logged in' };

            if (!skinId) {
                const { getChampionMap } = require('../services/champion-data');
                const champId = getChampionMap()[championName?.toLowerCase()];
                if (!champId) return { success: false, message: 'Champion not found' };
                skinId = champId * 1000;
            }

            await lcu.request('POST', '/lol-summoner/v1/current-summoner/summoner-profile', {
                key:   'backgroundSkinId',
                value: parseInt(skinId),
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

    // ── In-game chat messages ─────────────────────────────────────────────────
    ipcMain.handle('trigger-chat-event', async (event, eventType) => {
        if (!state.currentAccount) return;
        const msg = {
            death:     state.currentAccount.chatOnDeath,
            kill:      state.currentAccount.chatOnKill,
            assist:    state.currentAccount.chatOnAssist,
            gameStart: state.currentAccount.chatOnGameStart,
        }[eventType];
        if (!msg || !msg.trim()) return;
        // Game start: delay so the chat system is ready
        const delay = eventType === 'gameStart' ? 8000 : 0;
        if (delay) await new Promise(r => setTimeout(r, delay));
        sendInGameChatMessage(msg.trim());
    });

    ipcMain.handle('open-file-dialog', async (event, options) => {
        return dialog.showOpenDialog(state.mainWindow, options);
    });

    ipcMain.handle('window-control', (event, action) => {
        if (!state.mainWindow) return;
        if (action === 'close')    state.mainWindow.close();
        if (action === 'minimize') state.mainWindow.minimize();
    });
}

// Escape WScript.Shell SendKeys special characters
function escapeSendKeys(text) {
    return text.replace(/[+^%~(){}]/g, '{$&}');
}

function sendInGameChatMessage(message) {
    const escaped   = escapeSendKeys(message);
    const psLiteral = "'" + escaped.replace(/'/g, "''") + "'";

    // Select-Object -First 1 guards against multiple matching processes
    // Shift+Enter opens team chat in LoL
    const lines = [
        `$proc = Get-Process "League of Legends" -ErrorAction SilentlyContinue | Select-Object -First 1`,
        `if (-not $proc) { exit 0 }`,
        `$wsh = New-Object -ComObject WScript.Shell`,
        `if (-not $wsh.AppActivate($proc.Id)) { exit 0 }`,
        `Start-Sleep -Milliseconds 250`,
        `$wsh.SendKeys("+{ENTER}")`,
        `Start-Sleep -Milliseconds 120`,
        `$wsh.SendKeys(${psLiteral})`,
        `Start-Sleep -Milliseconds 80`,
        `$wsh.SendKeys("{ENTER}")`,
    ];

    spawn('powershell.exe', ['-NonInteractive', '-Command', lines.join('; ')]);
}

module.exports = { register };
