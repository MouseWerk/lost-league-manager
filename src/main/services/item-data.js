const axios = require('axios');
const championData = require('./champion-data');

let itemList = []; // processed, purchasable items sorted by name
let latestVersion = '14.1.1';

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

        const list = [];
        for (const id in data) {
            const item = data[id];
            if (!item.gold || !item.gold.purchasable || item.gold.total <= 0) continue;

            const { stats, statsGoldValue } = computeItemStats(item.stats);
            const efficiency = item.gold.total > 0
                ? Math.round((statsGoldValue / item.gold.total) * 1000) / 10
                : 0;

            list.push({
                id: parseInt(id),
                name: item.name,
                icon: `https://ddragon.leagueoflegends.com/cdn/${latestVersion}/img/item/${id}.png`,
                tags: item.tags || [],
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

module.exports = {
    fetchItemData,
    getItemList: () => itemList,
};
