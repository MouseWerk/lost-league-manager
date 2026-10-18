const axios = require('axios');

let championMap  = {};   // name.toLowerCase() → champId (int)
let idToNameMap  = {};   // champId (int)  → DDragon key string  (e.g. "Ahri")
let championIdByKey = {}; // DDragon key → champId (int)
let idToImageMap = {};   // DDragon key    → champion icon URL
let champList    = [];   // { id, name, key, iconUrl } sorted by name — for the UI picker
let champFullData = {};  // DDragon key    → { title, tags, partype, info, stats }
let latestVersion = '14.1.1';

// Resolves once the first fetch attempt sequence finishes (success or not), so
// callers that need the maps can wait for them without the app boot blocking
// on Data Dragon before the window is even shown.
let resolveReady;
const ready = new Promise(r => { resolveReady = r; });
function whenReady(timeoutMs = 15000) {
    return Promise.race([ready, new Promise(r => setTimeout(r, timeoutMs))]);
}

async function fetchChampionData(attempt = 0) {
    const MAX_ATTEMPTS = 3;
    try {
        const ver = await axios.get('https://ddragon.leagueoflegends.com/api/versions.json', { timeout: 10000 });
        latestVersion = ver.data[0];

        const res  = await axios.get(
            `https://ddragon.leagueoflegends.com/cdn/${latestVersion}/data/en_US/champion.json`,
            { timeout: 15000 }
        );
        const data = res.data.data;

        champList = [];
        champFullData = {};
        for (const key in data) {
            const champ   = data[key];
            const id      = parseInt(champ.key);
            const iconUrl = `https://ddragon.leagueoflegends.com/cdn/${latestVersion}/img/champion/${champ.id}.png`;
            championMap[champ.name.toLowerCase()] = id;
            idToImageMap[champ.id] = iconUrl;
            idToNameMap[id] = champ.id;
            championIdByKey[champ.id] = id;
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
        resolveReady();
    } catch (e) {
        console.error(`[DDragon] Attempt ${attempt + 1}/${MAX_ATTEMPTS} failed: ${e.message}`);
        if (attempt < MAX_ATTEMPTS - 1) {
            await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
            return fetchChampionData(attempt + 1);
        }
        console.warn('[DDragon] All attempts failed, overlay will use fallback version:', latestVersion);
        resolveReady();
    }
}

function getChampionIdByKey(champKey) {
    return championIdByKey[champKey] ?? null;
}

// Display name (lowercase) → authoritative DDragon key, e.g. "wukong" → "MonkeyKing",
// "cho'gath" → "Chogath". Needed because several champion keys don't follow the
// naive "strip spaces/punctuation from the display name" pattern.
function getNameToKeyMap() {
    const map = {};
    for (const nameLower in championMap) {
        map[nameLower] = idToNameMap[championMap[nameLower]];
    }
    return map;
}

module.exports = {
    fetchChampionData,
    whenReady,
    getChampionMap:    () => championMap,
    getIdToNameMap:    () => idToNameMap,
    getIdToImageMap:   () => idToImageMap,
    getChampionList:   () => champList,
    getLatestVersion:  () => latestVersion,
    getChampionIdByKey,
    getNameToKeyMap,
    getChampionFullData: (champKey) => champFullData[champKey] || null,
};
