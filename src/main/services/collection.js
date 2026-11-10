const lcu = require('../lcu');
const state = require('../state');
const { loadJson, saveJson } = require('./json-store');

// What each account owns, as the League client showed it at its last
// sign-in: champions, skins and the shards in its loot. The account search
// finds an account by a champion or skin name ("which account has Star
// Guardian Ahri?"), and the panel lists the collection.
//
// Keyed by lower-cased username, like account-status.json.

function userKey(username) {
    return typeof username === 'string' ? username.toLowerCase() : '';
}

function loadCollections() {
    return loadJson(state.paths.collection, {}, 'collection', (v) => v !== null && typeof v === 'object' && !Array.isArray(v));
}

function saveCollections(data) {
    // Best effort: a failed write must not break the client event that led here.
    try {
        saveJson(state.paths.collection, data, 'collection');
    } catch { /* logged by saveJson already */ }
}

const isId = (v) => Number.isInteger(v) && v > 0;
const isCount = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const cleanName = (v) => (typeof v === 'string' ? v.trim().slice(0, 80) : '');
const byName = (a, b) => a.name.localeCompare(b.name);

// /lol-champions/v1/owned-champions-minimal: owned champions (free rotation
// and rentals left out), as [{ id, name }].
function parseChampions(list) {
    if (!Array.isArray(list)) return null;
    const out = [];
    for (const c of list) {
        if (!isId(c?.id) || c.ownership?.owned !== true) continue;
        const name = cleanName(c.name);
        if (name) out.push({ id: c.id, name });
    }
    return out.sort(byName);
}

// /lol-champions/v1/inventories/{summonerId}/skins-minimal: owned skins
// without the base skins, as [{ id, name, championId }].
function parseSkins(list) {
    if (!Array.isArray(list)) return null;
    const out = [];
    for (const s of list) {
        if (!isId(s?.id) || s.isBase || s.ownership?.owned !== true) continue;
        const name = cleanName(s.name);
        if (name) out.push({ id: s.id, name, championId: isId(s.championId) ? s.championId : Math.floor(s.id / 1000) });
    }
    return out.sort(byName);
}

// /lol-loot/v1/player-loot: champion and skin shards and the Blue Essence the
// champion shards give when disenchanted.
function parseLoot(list) {
    if (!Array.isArray(list)) return null;
    const loot = { championShards: 0, skinShards: 0, shardBe: 0 };
    for (const l of list) {
        const count = isCount(l?.count) ? l.count : 0;
        if (!count) continue;
        if (l.type === 'CHAMPION_RENTAL' || l.type === 'CHAMPION') {
            loot.championShards += count;
            if (isCount(l.disenchantValue)) loot.shardBe += l.disenchantValue * count;
        } else if (l.type === 'SKIN_RENTAL' || l.type === 'SKIN') {
            loot.skinShards += count;
        }
    }
    return loot;
}

// Reads the collection of the signed-in account. Endpoints that are missing
// return null and leave the old value untouched.
async function captureCollection(username) {
    const key = userKey(username);
    if (!key) return;
    const me = await lcu.request('GET', '/lol-summoner/v1/current-summoner');
    const [champs, skins, loot] = await Promise.all([
        lcu.request('GET', '/lol-champions/v1/owned-champions-minimal'),
        me?.summonerId ? lcu.request('GET', `/lol-champions/v1/inventories/${me.summonerId}/skins-minimal`) : null,
        lcu.request('GET', '/lol-loot/v1/player-loot'),
    ]);
    const parsed = { champions: parseChampions(champs), skins: parseSkins(skins), loot: parseLoot(loot) };
    // An empty champion list means the client was not ready, not that the
    // account owns nothing.
    if (parsed.champions && !parsed.champions.length) parsed.champions = null;
    if (!parsed.champions && !parsed.skins && !parsed.loot) return;
    const data = loadCollections();
    const rec = { ...(data[key] || {}) };
    for (const [k, v] of Object.entries(parsed)) if (v) rec[k] = v;
    rec.checkedAt = Date.now();
    data[key] = rec;
    saveCollections(data);
}

function getCollectionMap() {
    return loadCollections();
}

// What the account list needs: the counts, and the names the search looks in.
function collectionSummary(rec) {
    if (!rec || typeof rec !== 'object') return null;
    const champions = Array.isArray(rec.champions) ? rec.champions : [];
    const skins = Array.isArray(rec.skins) ? rec.skins : [];
    return {
        champions: champions.length,
        skins: skins.length,
        loot: rec.loot || null,
        checkedAt: rec.checkedAt || null,
        names: [...champions.map((c) => c.name), ...skins.map((s) => s.name)],
    };
}

function summaryFor(map, username) {
    return collectionSummary(map[userKey(username)]);
}

// The whole collection of one account, for the panel's dialog.
function getCollection(username) {
    return loadCollections()[userKey(username)] || null;
}

// Called when an account is deleted.
function forgetCollection(username) {
    const data = loadCollections();
    const key = userKey(username);
    if (!(key in data)) return;
    delete data[key];
    saveCollections(data);
}

module.exports = {
    parseChampions, parseSkins, parseLoot, captureCollection, getCollectionMap,
    collectionSummary, summaryFor, getCollection, forgetCollection,
};
