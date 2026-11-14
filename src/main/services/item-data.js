const axios = require('axios');
const championData = require('./champion-data');

let itemList = []; // processed, purchasable items sorted by name
let latestVersion = '14.1.1';

// Every item id DDragon knows about — including the non-purchasable and
// map-specific ones filtered out of `itemList` — kept so build paths can answer
// "does the player already own this, or something built out of it?".
let rawById  = {};   // id → { name, total, from: [ids], into: [ids] }
let idsByName = {};  // name → [ids]  (ARAM/Arena rebalances share a name)
const ownershipCache = new Map();

// ── Community-standard gold values per stat point ────────────────────────────
// Approximate values used by the wider LoL community to estimate item
// "gold efficiency" (stat value ÷ item cost). Percent-based stats are stored
// by DDragon as fractions (e.g. 0.2 == 20%), so their gold value is scaled
// to a per-1.0 (=100%) basis.
const GOLD_VALUES = {
    FlatHPPoolMod:         2.67,   // Health
    FlatMPPoolMod:         1.00,   // Mana
    FlatHPRegenMod:        3.33,   // Health Regen
    FlatMPRegenMod:        2.50,   // Mana Regen
    FlatArmorMod:          20,     // Armor
    FlatSpellBlockMod:     20,     // Magic Resist
    FlatPhysicalDamageMod: 35,     // Attack Damage
    FlatMagicDamageMod:    21.75,  // Ability Power
    FlatCritChanceMod:     4000,   // Critical Strike Chance (per 100%)
    PercentAttackSpeedMod: 2500,   // Attack Speed (per 100%)
    FlatMovementSpeedMod:  12,     // Move Speed (flat)
    PercentMovementSpeedMod: 4000, // Move Speed % (per 100%)
    PercentLifeStealMod:   4000,   // Life Steal (per 100%)
};

const STAT_LABELS = {
    FlatHPPoolMod:         'Health',
    FlatMPPoolMod:         'Mana',
    FlatHPRegenMod:        'Health Regen',
    FlatMPRegenMod:        'Mana Regen',
    FlatArmorMod:          'Armor',
    FlatSpellBlockMod:     'Magic Resist',
    FlatPhysicalDamageMod: 'Attack Damage',
    FlatMagicDamageMod:    'Ability Power',
    FlatCritChanceMod:     'Critical Strike Chance',
    PercentAttackSpeedMod: 'Attack Speed',
    FlatMovementSpeedMod:  'Move Speed',
    PercentMovementSpeedMod: 'Move Speed',
    PercentLifeStealMod:   'Life Steal',
};

const PERCENT_STATS = new Set([
    'FlatCritChanceMod', 'PercentAttackSpeedMod', 'PercentMovementSpeedMod', 'PercentLifeStealMod',
]);

// The shop's own tiering. DDragon's `depth` is exactly League's basic/epic/
// legendary notion (absent means depth 1); consumables and trinkets sit outside
// it, the way the shop lists them separately.
function classifyTier(item) {
    const tags = item.tags || [];
    if (tags.includes('Consumable')) return 'consumable';
    if (tags.includes('Trinket'))    return 'trinket';
    const depth = item.depth || 1;
    if (depth >= 3) return 'legendary';
    if (depth === 2) return 'epic';
    return 'basic';
}

// Summoner's Rift (11) and Howling Abyss (12).
function isOnMainMaps(item) {
    const maps = item.maps || {};
    return maps['11'] === true || maps['12'] === true;
}

// Riot files map-specific rebalances (Arena, Swarm, event modes) under a
// six-digit id namespace — 223158 is Arena's Ionian Boots, 772004 Arena's Mana
// Potion. They share names with the originals and doubling every entry is most
// of what makes the item list hard to search, so the browsable list is base
// items only. `rawById` above still holds them, so a build step for Dark Seal
// is still satisfied by the Arena copy of Mejai's.
function isBaseGameItem(id) {
    return id < 100000;
}

function computeItemStats(rawStats) {
    const stats = [];
    let statsGoldValue = 0;
    for (const [key, val] of Object.entries(rawStats || {})) {
        if (!val) continue;
        const goldPerUnit = GOLD_VALUES[key];
        if (goldPerUnit === undefined) continue;

        const isPercent   = PERCENT_STATS.has(key);
        const displayVal  = isPercent ? Math.round(val * 1000) / 10 : Math.round(val * 100) / 100;
        const goldValue   = Math.round(val * goldPerUnit * 100) / 100;
        statsGoldValue += goldValue;

        stats.push({
            key,
            label: STAT_LABELS[key] || key,
            value: displayVal,
            unit: isPercent ? '%' : '',
            goldValue,
        });
    }
    stats.sort((a, b) => b.goldValue - a.goldValue);
    return { stats, statsGoldValue: Math.round(statsGoldValue * 100) / 100 };
}

// Converts DDragon's rich-text item description into plain text lines.
// All markup is stripped so the renderer can safely use textContent only.
// Lines wrapped in @@...@@ are passive/active ability names — the renderer
// strips the markers and renders them as small section headers.
function descriptionToLines(html) {
    if (!html) return [];
    const text = html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<li>/gi, '\n• ')
        .replace(/<(passive|active)>(.*?)<\/\1>/gi, '\n@@$2@@\n')
        .replace(/<\/(mainText|stats|rules|li|ul|p)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
    return text.split('\n').map(l => l.trim()).filter(Boolean);
}

async function fetchItemData(attempt = 0) {
    const MAX_ATTEMPTS = 3;
    try {
        latestVersion = championData.getLatestVersion();
        const res  = await axios.get(`https://ddragon.leagueoflegends.com/cdn/${latestVersion}/data/en_US/item.json`);
        const data = res.data.data;

        rawById  = {};
        idsByName = {};
        ownershipCache.clear();
        for (const id in data) {
            const item   = data[id];
            const numId  = parseInt(id);
            const toIds  = (arr) => (Array.isArray(arr) ? arr.map(Number).filter(Number.isInteger) : []);
            rawById[numId] = {
                name:  item.name,
                total: item.gold?.total || 0,
                from:  toIds(item.from),
                into:  toIds(item.into),
            };
            if (item.name) (idsByName[item.name] ||= []).push(numId);
        }

        const list = [];
        for (const id in data) {
            const item = data[id];
            if (!item.gold || !item.gold.purchasable || item.gold.total <= 0) continue;
            if (item.inStore === false || item.hideFromAll === true) continue;
            if (!isOnMainMaps(item) || !isBaseGameItem(parseInt(id))) continue;

            const { stats, statsGoldValue } = computeItemStats(item.stats);
            const efficiency = item.gold.total > 0
                ? Math.round((statsGoldValue / item.gold.total) * 1000) / 10
                : 0;

            list.push({
                id: parseInt(id),
                name: item.name,
                icon: `https://ddragon.leagueoflegends.com/cdn/${latestVersion}/img/item/${id}.png`,
                tags: item.tags || [],
                tier: classifyTier(item),
                depth: item.depth || 1,
                gold: item.gold,
                stats,
                statsGoldValue,
                efficiency,
                descriptionLines: descriptionToLines(item.description),
            });
        }
        // DDragon lists separate item IDs for map-specific rebalances (ARAM,
        // Arena, etc.) that share the same display name. Keep only the
        // lowest-numbered ID per name — that's consistently the base
        // Summoner's Rift version.
        const byName = new Map();
        for (const item of list) {
            const existing = byName.get(item.name);
            if (!existing || item.id < existing.id) byName.set(item.name, item);
        }
        const deduped = [...byName.values()];
        deduped.sort((a, b) => a.name.localeCompare(b.name));
        itemList = deduped;

        console.log(`[DDragon] Loaded ${itemList.length} purchasable items (v${latestVersion})`);
    } catch (e) {
        console.error(`[DDragon] Item fetch attempt ${attempt + 1}/${MAX_ATTEMPTS} failed: ${e.message}`);
        if (attempt < MAX_ATTEMPTS - 1) {
            await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
            return fetchItemData(attempt + 1);
        }
        console.warn('[DDragon] All item fetch attempts failed, item list unavailable.');
    }
}

// Item ids that mean "the gold for this item is already spent": the item
// itself, its map-specific twins (ARAM/Arena rebalances are separate ids that
// share a display name), and everything any of those build into. Without the
// upgrade walk a reminder for Dark Seal would fire again the moment it becomes
// Mejai's, and without the name twins it would never clear on ARAM.
function getOwnershipIds(itemId) {
    const id = Number(itemId);
    if (!Number.isInteger(id)) return [];
    if (ownershipCache.has(id)) return ownershipCache.get(id);

    // Breadth over both edges at every node: an item's map twins, and what it
    // builds into. Twins have to be followed all the way down too — Arena's
    // Mejai's is a different id from the Rift one, and a Dark Seal step has to
    // clear on either.
    const out = new Set();
    const queue = [id];
    while (queue.length > 0) {
        const cur = queue.pop();
        if (out.has(cur)) continue;
        out.add(cur);
        for (const twin of idsByName[rawById[cur]?.name] || []) {
            if (!out.has(twin)) queue.push(twin);
        }
        for (const next of rawById[cur]?.into || []) {
            if (!out.has(next)) queue.push(next);
        }
    }

    const ids = [...out];
    ownershipCache.set(id, ids);
    return ids;
}

module.exports = {
    fetchItemData,
    getItemList: () => itemList,
    getItemMeta: (id) => rawById[Number(id)] || null,
    getItemCost: (id) => rawById[Number(id)]?.total || 0,
    getOwnershipIds,
};
