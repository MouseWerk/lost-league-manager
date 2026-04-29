const axios = require('axios');

let championMap  = {};   // name.toLowerCase() → champId (int)
let idToNameMap  = {};   // champId (int)  → DDragon key string  (e.g. "Ahri")
let idToImageMap = {};   // DDragon key    → champion icon URL
let latestVersion = '14.1.1';

async function fetchChampionData() {
    try {
        const ver = await axios.get('https://ddragon.leagueoflegends.com/api/versions.json');
        latestVersion = ver.data[0];

        const res  = await axios.get(
            `https://ddragon.leagueoflegends.com/cdn/${latestVersion}/data/en_US/champion.json`
        );
        const data = res.data.data;

        for (const key in data) {
            const champ = data[key];
            const id    = parseInt(champ.key);
            championMap[champ.name.toLowerCase()] = id;
            idToImageMap[champ.key] = `https://ddragon.leagueoflegends.com/cdn/${latestVersion}/img/champion/${champ.id}.png`;
            idToNameMap[id] = champ.id;
        }

        console.log(`[DDragon] Loaded ${Object.keys(championMap).length} champions (v${latestVersion})`);
    } catch (e) {
        console.error('[DDragon] Failed to fetch champion data:', e.message);
    }
}

function getChampionIdByKey(champKey) {
    const entry = Object.entries(idToNameMap).find(([, k]) => k === champKey);
    return entry ? parseInt(entry[0]) : null;
}

module.exports = {
    fetchChampionData,
    getChampionMap:    () => championMap,
    getIdToNameMap:    () => idToNameMap,
    getIdToImageMap:   () => idToImageMap,
    getLatestVersion:  () => latestVersion,
    getChampionIdByKey,
};
