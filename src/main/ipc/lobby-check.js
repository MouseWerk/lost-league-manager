const { ipcMain, shell } = require('electron');
const lcu = require('../lcu');
const { liveClientGet } = require('../services/live-client');
const { soloRankForPlayer } = require('./overlay-handlers');
const { getClientRegion } = require('./stats');
const { opggMultisearchUrl } = require('./client-controls');

// Lobby check: the ranks of the players around you, only where the game
// shows their names itself (your party in the lobby, champion select of
// queues that show names, everyone once the game runs). Ranked champion
// select hides teammates' names; Riot's policy forbids revealing them, so
// hidden players stay hidden here too.

// Lobby members: [{ gameName, tagLine, puuid, ... }]
function playersFromLobby(lobby, selfPuuid) {
    return (lobby?.members || [])
        .filter(m => m?.gameName)
        .map(m => ({
            gameName: m.gameName,
            tagLine: m.tagLine || '',
            team: 'mine',
            isSelf: !!selfPuuid && m.puuid === selfPuuid,
        }));
}

// Champion select: names only where the session gives a puuid and does not
// mark the player as hidden. `names` maps puuid -> { gameName, tagLine }.
function playersFromChampSelect(session, names, selfPuuid) {
    const self = session?.localPlayerCellId;
    return (session?.myTeam || []).map(m => {
        const isSelf = m.cellId === self || (!!selfPuuid && m.puuid === selfPuuid);
        const hidden = !isSelf && (!m.puuid || m.nameVisibilityType === 'HIDDEN');
        const n = hidden ? null : (m.gameName ? m : names?.[m.puuid]);
        if (!n?.gameName) return { hidden: true, team: 'mine', isSelf, position: m.assignedPosition || '' };
        return { gameName: n.gameName, tagLine: n.tagLine || '', team: 'mine', isSelf, position: m.assignedPosition || '' };
    });
}

// In game: /liveclientdata/playerlist, all ten players; `me` is the riotId
// from /liveclientdata/activeplayername.
function playersFromLiveGame(list, me) {
    const players = (Array.isArray(list) ? list : []).map(p => {
        const [name, tag] = String(p.riotId || '').split('#');
        return {
            gameName: p.riotIdGameName || name || p.summonerName || '',
            tagLine: p.riotIdTagLine || tag || '',
            side: p.team,
            champion: p.championName || '',
            position: p.position || '',
            isSelf: !!me && String(p.riotId || '').toLowerCase() === String(me).toLowerCase(),
        };
    }).filter(p => p.gameName);
    const mySide = players.find(p => p.isSelf)?.side;
    return players.map(({ side, ...p }) => ({ ...p, team: !mySide || side === mySide ? 'mine' : 'enemy' }));
}

async function namesForPuuids(puuids) {
    const out = {};
    await Promise.allSettled(puuids.map(async (puuid) => {
        const s = await lcu.request('GET', `/lol-summoner/v2/summoners/puuid/${encodeURIComponent(puuid)}`);
        if (s?.gameName) out[puuid] = { gameName: s.gameName, tagLine: s.tagLine || '' };
    }));
    return out;
}

async function collectPlayers(phase) {
    const me = await lcu.request('GET', '/lol-summoner/v1/current-summoner');
    if (phase === 'Lobby') {
        return playersFromLobby(await lcu.request('GET', '/lol-lobby/v2/lobby'), me?.puuid);
    }
    if (phase === 'ChampSelect') {
        const session = await lcu.request('GET', '/lol-champ-select/v1/session');
        const visible = (session?.myTeam || []).filter(m => m.puuid && m.nameVisibilityType !== 'HIDDEN' && !m.gameName).map(m => m.puuid);
        return playersFromChampSelect(session, await namesForPuuids(visible), me?.puuid);
    }
    if (phase === 'InProgress' || phase === 'GameStart') {
        try {
            const [list, active] = await Promise.all([liveClientGet('playerlist'), liveClientGet('activeplayername')]);
            return playersFromLiveGame(list, active);
        } catch {
            return []; // the game is still loading
        }
    }
    return [];
}

function register() {
    ipcMain.handle('get-lobby-check', async () => {
        if (!lcu.connected) return { connected: false, players: [] };
        const phase = await lcu.request('GET', '/lol-gameflow/v1/gameflow-phase');
        const players = await collectPlayers(phase);
        await Promise.allSettled(players.map(async (p) => {
            if (p.hidden) return;
            Object.assign(p, await soloRankForPlayer({ gameName: p.gameName, tagLine: p.tagLine }));
        }));
        const region = await getClientRegion();
        return { connected: true, phase, region, players };
    });

    ipcMain.handle('open-opgg-multisearch', async (event, region, riotIds) => {
        const url = opggMultisearchUrl(region, riotIds);
        if (!url) return { success: false };
        await shell.openExternal(url);
        return { success: true };
    });
}

module.exports = { register, playersFromLobby, playersFromChampSelect, playersFromLiveGame };
