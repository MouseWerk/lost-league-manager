const { ipcMain, shell } = require('electron');
const lcu = require('../lcu');
const { liveClientGet } = require('../services/live-client');
const { soloRankForPlayer, championRecord } = require('./overlay-handlers');
const championData = require('../services/champion-data');
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

// Loading screen: the client's game session lists both teams (names are
// visible from here on). `names` maps puuid -> { gameName, tagLine }.
function playersFromGameflow(session, names, selfPuuid, idToKey = {}) {
    const data = session?.gameData || {};
    const one = Array.isArray(data.teamOne) ? data.teamOne : [];
    const two = Array.isArray(data.teamTwo) ? data.teamTwo : [];
    const mineIsOne = !selfPuuid || one.some((p) => p.puuid === selfPuuid) || !two.some((p) => p.puuid === selfPuuid);
    const picks = {};
    for (const s of Array.isArray(data.playerChampionSelections) ? data.playerChampionSelections : []) {
        if (s.puuid) picks[s.puuid] = s.championId;
    }
    const row = (p, mine) => {
        const n = (p.gameName ? p : names?.[p.puuid]) || {};
        const championId = p.championId || picks[p.puuid] || 0;
        return {
            gameName: n.gameName || p.summonerName || '',
            tagLine: n.tagLine || '',
            team: mine ? 'mine' : 'enemy',
            champion: idToKey[championId] || '',
            position: String(p.selectedPosition || '').toUpperCase(),
            isSelf: !!selfPuuid && p.puuid === selfPuuid,
        };
    };
    return [...one.map((p) => row(p, mineIsOne)), ...two.map((p) => row(p, !mineIsOne))].filter((p) => p.gameName);
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
    if (phase === 'GameStart') {
        const session = await lcu.request('GET', '/lol-gameflow/v1/session');
        const all = [...(session?.gameData?.teamOne || []), ...(session?.gameData?.teamTwo || [])];
        const missing = all.filter((p) => p.puuid && !p.gameName).map((p) => p.puuid);
        const players = playersFromGameflow(session, await namesForPuuids(missing), me?.puuid, championData.getIdToNameMap());
        if (players.length) return players;
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

    // The overlay on the loading screen: both teams with rank and how each
    // plays the champion they picked (Porofessor-style tags come from this).
    ipcMain.handle('overlay-get-loading', async () => {
        if (!lcu.connected) return { players: [] };
        const phase = await lcu.request('GET', '/lol-gameflow/v1/gameflow-phase');
        if (phase !== 'GameStart' && phase !== 'InProgress') return { phase, players: [] };
        await championData.whenReady();
        const players = await collectPlayers(phase);
        await Promise.allSettled(players.map(async (p) => {
            const who = { gameName: p.gameName, tagLine: p.tagLine };
            const [rank, champ] = await Promise.all([soloRankForPlayer(who), championRecord(who, p.champion)]);
            Object.assign(p, rank, champ);
        }));
        return { phase, players };
    });

    ipcMain.handle('open-opgg-multisearch', async (event, region, riotIds) => {
        const url = opggMultisearchUrl(region, riotIds);
        if (!url) return { success: false };
        await shell.openExternal(url);
        return { success: true };
    });
}

module.exports = { register, playersFromLobby, playersFromChampSelect, playersFromLiveGame, playersFromGameflow };
