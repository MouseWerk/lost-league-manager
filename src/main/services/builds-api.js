const axios = require('axios');
const championData = require('./champion-data');

// OP.GG exposes a JSON statistics API — no HTML parsing required.
// Endpoint: https://lol-api-champion.op.gg/api/v1.0/statistics/champions/{id}/ranked/items
const OPGG_API_BASE = 'https://lol-api-champion.op.gg/api/v1.0/statistics/champions';

const REQUEST_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'Accept': 'application/json',
    'Origin': 'https://www.op.gg',
    'Referer': 'https://www.op.gg/',
};

function flattenIdArray(arr) {
    if (!Array.isArray(arr) || !arr.length) return [];
    const first = arr[0];
    if (typeof first === 'number') return arr;
    return first?.ids || first?.item_ids || [];
}

function flattenSingleIds(arr) {
    if (!Array.isArray(arr)) return [];
    return arr
        .map(i => (typeof i === 'object' ? (i.id ?? i.item_id) : i))
        .filter(Boolean);
}

async function getBuilds(champKey) {
    const champId = championData.getChampionIdByKey(champKey);
    if (!champId) {
        console.log(`[Builds] Unknown champKey: ${champKey}`);
        return null;
    }

    try {
        const url = `${OPGG_API_BASE}/${champId}/ranked/items?region=global&tier=platinum_plus`;
        const res  = await axios.get(url, { headers: REQUEST_HEADERS, timeout: 8000 });

        // The API may nest data under a 'data' key or return it at the top level
        const payload = res.data?.data ?? res.data;

        const startArr    = payload?.startingItems ?? payload?.starting_items ?? payload?.starter_items ?? [];
        const coreArr     = payload?.coreItems     ?? payload?.core_items     ?? payload?.mythicItems   ?? [];
        const optionalArr = payload?.lastItems      ?? payload?.last_items     ?? payload?.soleItems     ?? [];

        const starting = flattenIdArray(startArr).slice(0, 5);
        const core     = flattenIdArray(coreArr).slice(0, 6);
        const optional = flattenSingleIds(optionalArr).slice(0, 4);

        if (!starting.length && !core.length) {
            console.log(`[Builds] ${champKey} (id ${champId}): no build data in response`);
            return null;
        }

        console.log(`[Builds] ${champKey} → start:${starting.length} core:${core.length} opt:${optional.length}`);
        return { champKey, starting, core, optional };
    } catch (e) {
        console.log(`[Builds] ${champKey}:`, e.message);
        return null;
    }
}

module.exports = { getBuilds };
