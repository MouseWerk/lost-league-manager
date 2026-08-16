const fs = require('fs');
const path = require('path');

// Riot Client writes every installed product's real location here regardless
// of which drive/library it lives on (Steam, manual, custom) — authoritative
// source for healing a stale/wrong lolPath without asking the user.
const INSTALLS_JSON_PATH = path.join(
    process.env.PROGRAMDATA || 'C:\\ProgramData',
    'Riot Games', 'RiotClientInstalls.json'
);

function fromInstallsJson() {
    try {
        if (!fs.existsSync(INSTALLS_JSON_PATH)) return null;
        const data = JSON.parse(fs.readFileSync(INSTALLS_JSON_PATH, 'utf8'));

        const leagueKeys = Object.keys(data).filter(k => k.startsWith('league_of_legends'));
        if (leagueKeys.length === 0) return null;
        const key = leagueKeys.find(k => k.endsWith('.live')) || leagueKeys[0];

        const installDir = data[key];
        if (!installDir) return null;

        const exePath = path.join(installDir, 'LeagueClient.exe');
        return fs.existsSync(exePath) ? exePath : null;
    } catch {
        return null;
    }
}

const DRIVE_SUBPATHS = [
    ['Riot Games', 'League of Legends'],
    ['Program Files', 'Riot Games', 'League of Legends'],
    ['Program Files (x86)', 'Riot Games', 'League of Legends'],
    ['SteamLibrary', 'steamapps', 'common', 'Riot Games', 'League of Legends'],
];

function fromCommonDrives() {
    for (const drive of ['C', 'D', 'E', 'F', 'G', 'H']) {
        for (const sub of DRIVE_SUBPATHS) {
            const exePath = path.join(`${drive}:\\`, ...sub, 'LeagueClient.exe');
            if (fs.existsSync(exePath)) return exePath;
        }
    }
    return null;
}

// Returns a working LeagueClient.exe path: the configured one if it still
// exists, otherwise an auto-detected one. Returns null if nothing is found,
// so callers can leave an unresolvable configured path untouched.
function resolveLolPath(configuredPath) {
    if (configuredPath && fs.existsSync(configuredPath)) return configuredPath;
    return fromInstallsJson() || fromCommonDrives();
}

module.exports = { resolveLolPath };
