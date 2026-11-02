
// Recent games in one shape, whether they come from the Riot API (match-v5)
// or OP.GG, and a small store of the last games per Riot ID so the games
// dialog and the champion stats work without asking again.
//
// A match:
// { id, source, createdAt (ms), duration (s), queue, win, remake,
//   champion, championIcon, position, kills, deaths, assists, kda, cs, gold,
//   damage, items: [ids], players?: [player] }
// A player: { team: 'blue'|'red', name, tag, champion, championIcon, position,
//   kills, deaths, assists, cs, gold, damage, items, win, isSelf }

const MAX_STORED = 30;

const { QUEUE_NAMES, queueName, gameModeName } = require('../../renderer/js/ui-lib.js');

// Short names for the ranked queues (the list is narrow); everything else
// comes from the shared queue table in ui-lib.js.
const RIOT_QUEUES = { ...QUEUE_NAMES, 420: 'Ranked Solo', 440: 'Ranked Flex' };
const OPGG_QUEUES = {
    SOLORANKED: 'Ranked Solo', FLEXRANKED: 'Ranked Flex', NORMAL: 'Normal', ARAM: 'ARAM',
    ARENA: 'Arena', URF: 'URF', ARURF: 'ARURF', CLASH: 'Clash', CUSTOM: 'Custom', QUICKPLAY: 'Quickplay',
    SWIFTPLAY: 'Swiftplay', ARAM_MAYHEM: 'ARAM Mayhem', KIWI: 'ARAM Mayhem', ONE_FOR_ALL: 'One for All',
    NEXUS_BLITZ: 'Nexus Blitz', ULTBOOK: 'Ultimate Spellbook', BRAWL: 'Brawl', SWARM: 'Swarm', BOT: 'Co-op vs AI',
};

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const kdaText = (k, d, a) => `${k}/${d}/${a}`;

function championFields(championId, fallbackName, maps) {
    // match-v5's championName is not always the DDragon key ("FiddleSticks");
    // the numeric id is reliable.
    const key = maps.idToName[championId] || fallbackName || '';
    return { champion: key || `Champion ${championId}`, championIcon: maps.idToImage[key] || null };
}

// ── Riot API ────────────────────────────────────────────────────────────────

function riotPlayer(p, selfPuuid, maps) {
    return {
        team: p.teamId === 200 ? 'red' : 'blue',
        name: p.riotIdGameName || p.summonerName || '',
        tag: p.riotIdTagline || '',
        ...championFields(p.championId, p.championName, maps),
        position: p.teamPosition || p.individualPosition || '',
        kills: num(p.kills), deaths: num(p.deaths), assists: num(p.assists),
        cs: num(p.totalMinionsKilled) + num(p.neutralMinionsKilled),
        gold: num(p.goldEarned),
        damage: num(p.totalDamageDealtToChampions),
        items: [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6].filter((i) => num(i) > 0),
        win: !!p.win,
        isSelf: p.puuid === selfPuuid,
    };
}

function fromRiotMatch(matchId, info, puuid, maps) {
    const parts = Array.isArray(info?.participants) ? info.participants : [];
    const players = parts.map((p) => riotPlayer(p, puuid, maps));
    const self = players.find((p) => p.isSelf);
    if (!self) return null;
    const remake = parts.some((p) => p.gameEndedInEarlySurrender);
    return {
        id: matchId,
        source: 'riot-api',
        createdAt: num(info.gameStartTimestamp || info.gameCreation),
        duration: num(info.gameDuration),
        queue: RIOT_QUEUES[info.queueId] || queueName(info.queueId, info.gameMode),
        win: self.win,
        remake,
        champion: self.champion,
        championName: self.champion,
        championIcon: self.championIcon,
        position: self.position,
        kills: self.kills, deaths: self.deaths, assists: self.assists,
        kda: kdaText(self.kills, self.deaths, self.assists),
        cs: self.cs, gold: self.gold, damage: self.damage, items: self.items,
        players,
    };
}

// ── OP.GG ───────────────────────────────────────────────────────────────────

function sameRiotId(summoner, riotId) {
    if (!summoner?.game_name || !riotId) return false;
    return `${summoner.game_name}#${summoner.tagline || ''}`.toLowerCase() === riotId.toLowerCase();
}

function opggPlayer(p, maps, isSelf) {
    const st = p.stats || {};
    return {
        team: String(p.team_key || '').toUpperCase() === 'RED' ? 'red' : 'blue',
        name: p.summoner?.game_name || '',
        tag: p.summoner?.tagline || '',
        ...championFields(p.champion_id, p.champion_name, maps),
        position: p.position || '',
        kills: num(st.kill), deaths: num(st.death), assists: num(st.assist),
        cs: num(st.minion_kill) + num(st.neutral_minion_kill),
        gold: num(st.gold_earned),
        damage: num(st.total_damage_dealt_to_champions),
        items: (Array.isArray(p.items) ? p.items : []).filter((i) => num(i) > 0),
        win: st.result === 'WIN',
        isSelf,
    };
}

function opggMatch(g, self, extra, maps) {
    const result = self?.stats?.result;
    const me = opggPlayer(self || {}, maps, true);
    return {
        id: String(g.id || ''),
        source: 'opgg',
        createdAt: Date.parse(g.created_at) || 0,
        createdAtIso: g.created_at || '',
        duration: num(g.game_length_second),
        queue: OPGG_QUEUES[String(g.game_type || '').toUpperCase()] || gameModeName(g.game_type) || 'Other',
        win: result === 'WIN',
        remake: !!result && result !== 'WIN' && result !== 'LOSE',
        champion: me.champion,
        championName: me.champion,
        championIcon: me.championIcon,
        position: me.position,
        kills: me.kills, deaths: me.deaths, assists: me.assists,
        kda: kdaText(me.kills, me.deaths, me.assists),
        cs: me.cs, gold: me.gold, damage: me.damage, items: me.items,
        ...extra,
    };
}

// One game from lol_list_summoner_matches: only the player's own row.
function fromOpggGame(g, riotId, maps) {
    const parts = Array.isArray(g?.participants) ? g.participants : [];
    const self = parts.find((p) => sameRiotId(p.summoner, riotId)) || parts[0];
    if (!self) return null;
    return opggMatch(g, self, {}, maps);
}

// One game from lol_get_summoner_game_detail: both teams.
function fromOpggDetail(d, riotId, maps) {
    const parts = (Array.isArray(d?.teams) ? d.teams : []).flatMap((t) => (Array.isArray(t.participants) ? t.participants : []));
    const self = parts.find((p) => p.is_target) || parts.find((p) => sameRiotId(p.summoner, riotId));
    if (!self) return null;
    const players = parts.map((p) => opggPlayer(p, maps, p === self));
    return opggMatch(d, self, { players }, maps);
}

// ── Store ───────────────────────────────────────────────────────────────────

function storeKey(riotId) {
    return typeof riotId === 'string' ? riotId.trim().toLowerCase() : '';
}

// Loaded on use: opgg-api.js needs only the normalizers, without electron.
function storePath() {
    return require('../state').paths.matchStore;
}

function loadStore() {
    const { loadJson } = require('./json-store');
    return loadJson(storePath(), {}, 'match store', (v) => v !== null && typeof v === 'object' && !Array.isArray(v));
}

function saveStore(data) {
    try {
        require('./json-store').saveJson(storePath(), data, 'match store');
    } catch { /* logged by saveJson already */ }
}

// Adds games (newest data wins, players are kept once known) and returns the
// stored list, newest first, at most MAX_STORED.
// The Riot API and OP.GG name one game differently; the same start time
// (within a few minutes) on the same champion is the same game.
const SAME_GAME_MS = 3 * 60 * 1000;
function sameGame(a, b) {
    return a.id === b.id
        || (!!a.createdAt && !!b.createdAt && !!a.champion && a.champion === b.champion && Math.abs(a.createdAt - b.createdAt) <= SAME_GAME_MS);
}

function mergeMatches(riotId, matches) {
    const key = storeKey(riotId);
    if (!key) return [];
    const data = loadStore();
    const byId = new Map((data[key] || []).map((m) => [m.id, m]));
    for (const m of matches) {
        if (!m?.id) continue;
        const old = byId.get(m.id) || [...byId.values()].find((x) => sameGame(x, m));
        if (old) byId.delete(old.id);
        // The stored id stays, so a games dialog open on it keeps working.
        byId.set(old ? old.id : m.id, old ? { ...old, ...m, id: old.id, players: m.players || old.players } : m);
    }
    const list = [...byId.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_STORED);
    data[key] = list;
    saveStore(data);
    return list;
}

function renameMatches(oldId, newId) {
    const from = storeKey(oldId);
    const to = storeKey(newId);
    const data = loadStore();
    if (!from || !to || from === to || !data[from]) return;
    const list = data[from];
    delete data[from];
    saveStore(data);
    mergeMatches(newId, list);
}

function forgetMatches(riotId) {
    const key = storeKey(riotId);
    const data = loadStore();
    if (!key || !(key in data)) return;
    delete data[key];
    saveStore(data);
}

function getStoredMatches(riotId) {
    return loadStore()[storeKey(riotId)] || [];
}

module.exports = { fromRiotMatch, fromOpggGame, fromOpggDetail, mergeMatches, getStoredMatches, forgetMatches, renameMatches, MAX_STORED, RIOT_QUEUES, OPGG_QUEUES };
