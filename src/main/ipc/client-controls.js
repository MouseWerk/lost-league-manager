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

    ipcMain.handle('open-file-dialog', async (event, options) => {
        return dialog.showOpenDialog(state.mainWindow, options);
    });

    ipcMain.handle('window-control', (event, action) => {
        if (!state.mainWindow) return;
        if (action === 'close')    state.mainWindow.close();
        if (action === 'minimize') state.mainWindow.minimize();
    });
}

module.exports = { register };
