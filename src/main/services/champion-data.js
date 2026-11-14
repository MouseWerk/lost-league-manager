const axios = require('axios');

let championMap  = {};   // name.toLowerCase() → champId (int)
let idToNameMap  = {};   // champId (int)  → DDragon key string  (e.g. "Ahri")
let idToImageMap = {};   // DDragon key    → champion icon URL
let champList    = [];   // { id, name, key, iconUrl } sorted by name — for the UI picker
let champFullData = {};  // DDragon key    → { title, tags, partype, info, stats }
let latestVersion = '14.1.1';
let nameToKeyCache = null;   // built lazily from championMap, dropped on refetch

async function fetchChampionData(attempt = 0) {
    const MAX_ATTEMPTS = 3;
    try {
        const ver = await axios.get('https://ddragon.leagueoflegends.com/api/versions.json');
        latestVersion = ver.data[0];

        const res  = await axios.get(
            `https://ddragon.leagueoflegends.com/cdn/${latestVersion}/data/en_US/champion.json`
        );
        const data = res.data.data;

        champList = [];
        champFullData = {};
        nameToKeyCache = null;
        for (const key in data) {
            const champ   = data[key];
            const id      = parseInt(champ.key);
            const iconUrl = `https://ddragon.leagueoflegends.com/cdn/${latestVersion}/img/champion/${champ.id}.png`;
            championMap[champ.name.toLowerCase()] = id;
            idToImageMap[champ.id] = iconUrl;
            idToNameMap[id] = champ.id;
            champList.push({ id, name: champ.name, key: champ.id, iconUrl });
            champFullData[champ.id] = {
                name: champ.name,
                title: champ.title,
                tags: champ.tags || [],
                partype: champ.partype,
                info: champ.info || {},
                stats: champ.stats || {},
            };
        }
        champList.sort((a, b) => a.name.localeCompare(b.name));

        console.log(`[DDragon] Loaded ${Object.keys(championMap).length} champions (v${latestVersion})`);
    } catch (e) {
        console.error(`[DDragon] Attempt ${attempt + 1}/${MAX_ATTEMPTS} failed: ${e.message}`);
        if (attempt < MAX_ATTEMPTS - 1) {
            await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
            return fetchChampionData(attempt + 1);
        }
        console.warn('[DDragon] All attempts failed, overlay will use fallback version:', latestVersion);
    }
}

function getChampionIdByKey(champKey) {
    const entry = Object.entries(idToNameMap).find(([, k]) => k === champKey);
    return entry ? parseInt(entry[0]) : null;
}

// Display name (lowercase) → authoritative DDragon key, e.g. "wukong" → "MonkeyKing",
// "cho'gath" → "Chogath". Needed because several champion keys don't follow the
// naive "strip spaces/punctuation from the display name" pattern.
function getNameToKeyMap() {
    if (nameToKeyCache) return nameToKeyCache;
    const map = {};
    for (const nameLower in championMap) {
        map[nameLower] = idToNameMap[championMap[nameLower]];
    }
    nameToKeyCache = map;
    return map;
}

// GEP player payload → DDragon key. `rawChampionName` is the localisation key
// ("game_character_displayname_Ahri") when GEP provides it, which needs no
// guessing; otherwise fall back to the display name via getNameToKeyMap().
// Mirrors champDDKey() in the overlay renderer, which can't require this module.
function resolveChampionKey(rawChampionName, championName) {
    const PREFIX = 'game_character_displayname_';
    if (rawChampionName && rawChampionName.startsWith(PREFIX)) {
        return rawChampionName.slice(PREFIX.length);
    }
    const displayName = championName || rawChampionName;
    if (!displayName) return null;
    return getNameToKeyMap()[displayName.toLowerCase()] || displayName.replace(/[\s'.&]/g, '');
}

module.exports = {
    fetchChampionData,
    getChampionMap:    () => championMap,
    getIdToNameMap:    () => idToNameMap,
    getIdToImageMap:   () => idToImageMap,
    getChampionList:   () => champList,
    getLatestVersion:  () => latestVersion,
    getChampionIdByKey,
    getNameToKeyMap,
    resolveChampionKey,
    getChampionFullData: (champKey) => champFullData[champKey] || null,
};
