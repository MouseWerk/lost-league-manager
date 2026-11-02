const axios = require('./http');
const championData = require('./champion-data');

let itemList = []; // processed, purchasable items sorted by name
let latestVersion = null;

let resolveReady;
const ready = new Promise(r => { resolveReady = r; });
function whenReady(timeoutMs = 20000) {
    return Promise.race([ready, new Promise(r => setTimeout(r, timeoutMs))]);
}

// ── Gold value per stat point ────────────────────────────────────────────────
// Item "gold efficiency" = stat value ÷ item cost, where a stat point is worth
// what the cheapest single-stat shop item charges for it. Percent-based stats
// are stored by DDragon as fractions (e.g. 0.2 == 20%), so their gold value is
// scaled to a per-1.0 (=100%) basis.
//
// These are fallbacks; the real values are derived from the loaded item.json
// (BASE_ITEMS below), so they follow price changes. Source: Data Dragon
// 16.20.1 item.json — Long Sword 350 g / 10 AD, Amplifying Tome 400 g / 20 AP,
// Cloth Armor 300 g / 15 armor, Ruby Crystal 400 g / 150 HP, Sapphire Crystal
// 300 g / 300 mana, Boots 300 g / 25 move speed, Vampiric Scepter 900 g =
// 15 AD (525 g) + 7% life steal (375 g).
const GOLD_VALUES = {
    FlatHPPoolMod:         2.67,   // Health
    FlatMPPoolMod:         1.00,   // Mana
    FlatHPRegenMod:        3.33,   // Health Regen
    FlatMPRegenMod:        2.50,   // Mana Regen
    FlatArmorMod:          20,     // Armor
    FlatSpellBlockMod:     20,     // Magic Resist
    FlatPhysicalDamageMod: 35,     // Attack Damage
    FlatMagicDamageMod:    20,     // Ability Power
    FlatCritChanceMod:     4000,   // Critical Strike Chance (per 100%)
    PercentAttackSpeedMod: 2500,   // Attack Speed (per 100%)
    FlatMovementSpeedMod:  12,     // Move Speed (flat)
    PercentMovementSpeedMod: 4000, // Move Speed % (per 100%)
    PercentLifeStealMod:   5357,   // Life Steal (per 100%)
};

// Single-stat basic items that set the price of their stat.
const BASE_ITEMS = {
    FlatPhysicalDamageMod: '1036', // Long Sword
    FlatMagicDamageMod:    '1052', // Amplifying Tome
    FlatArmorMod:          '1029', // Cloth Armor
    FlatSpellBlockMod:     '1033', // Null-Magic Mantle
    FlatHPPoolMod:         '1028', // Ruby Crystal
    FlatMPPoolMod:         '1027', // Sapphire Crystal
    PercentAttackSpeedMod: '1042', // Dagger
    FlatCritChanceMod:     '1018', // Cloak of Agility
    FlatMovementSpeedMod:  '1001', // Boots
};
const LIFE_STEAL_ITEM = '1053'; // Vampiric Scepter: attack damage + life steal

// Stats Data Dragon lists only in an item's description (not in `stats`).
// Each is priced like the others: by the cheapest shop item that carries it,
// minus the gold of its other stats. Amounts are as written in the
// description (points, or percent for "%" stats). Fallbacks from 16.20.1.
const DESCRIPTION_STATS = [
    { key: 'BaseHPRegen',     name: 'Base Health Regen',     percent: true,  ref: '1006', gold: 3 },     // Rejuvenation Bead
    { key: 'BaseMPRegen',     name: 'Base Mana Regen',       percent: true,  ref: '1004', gold: 4 },     // Faerie Charm
    { key: 'AbilityHaste',    name: 'Ability Haste',         percent: false, ref: '2022', gold: 50 },    // Glowing Mote
    { key: 'Lethality',       name: 'Lethality',             percent: false, ref: '3134', gold: 30 },    // Serrated Dirk
    { key: 'ArmorPenPercent', name: 'Armor Penetration',     percent: true,  ref: '3035', gold: 41.67 }, // Last Whisper
    { key: 'MagicPenFlat',    name: 'Magic Penetration',     percent: false, ref: '3020', gold: 46.67 }, // Sorcerer's Shoes
    { key: 'MagicPenPercent', name: 'Magic Penetration',     percent: true,  ref: '4630', gold: 46.15 }, // Blighting Jewel
    { key: 'Omnivamp',        name: 'Omnivamp',              percent: true,  ref: '3008', gold: 115 },   // Gluttonous Greaves
    { key: 'HealShieldPower', name: 'Heal and Shield Power', percent: true,  ref: '3114', gold: 50 },    // Forbidden Idol
    { key: 'Tenacity',        name: 'Tenacity',              percent: true,  ref: '3111', gold: 10.33 }, // Mercury's Treads
];
for (const d of DESCRIPTION_STATS) GOLD_VALUES[d.key] = d.gold;

function statsBlock(html) {
    return (String(html || '').match(/<stats>([\s\S]*?)<\/stats>/i) || [])[1] || '';
}

// The <stats> lines of a description as { amount, percent, name }.
function descriptionStatLines(html) {
    return statsBlock(html).split(/<br\s*\/?>/i).map(line => {
        const m = line.replace(/<[^>]+>/g, '').trim().match(/^([\d.]+)\s*(%?)\s+(.+)$/);
        return m ? { amount: Number(m[1]), percent: m[2] === '%', name: m[3].trim() } : null;
    }).filter(Boolean);
}

// Description-only stats of an item, keyed like GOLD_VALUES.
function descriptionStats(html) {
    const out = {};
    for (const line of descriptionStatLines(html)) {
        const d = DESCRIPTION_STATS.find(x => x.name === line.name && x.percent === line.percent);
        if (d) out[d.key] = (out[d.key] || 0) + line.amount;
    }
    return out;
}

function deriveGoldValues(data) {
    const values = { ...GOLD_VALUES };
    for (const [stat, id] of Object.entries(BASE_ITEMS)) {
        const item = data?.[id];
        const amount = item?.stats?.[stat];
        const cost = item?.gold?.total;
        const statCount = Object.values(item?.stats || {}).filter(Boolean).length;
        if (amount > 0 && cost > 0 && statCount === 1) values[stat] = cost / amount;
    }
    const scepter = data?.[LIFE_STEAL_ITEM];
    const ls = scepter?.stats?.PercentLifeStealMod;
    if (ls > 0 && scepter.gold?.total > 0) {
        const rest = scepter.gold.total - (scepter.stats.FlatPhysicalDamageMod || 0) * values.FlatPhysicalDamageMod;
        if (rest > 0) values.PercentLifeStealMod = rest / ls;
    }
    // In list order, so the other stats of a reference item are already
    // priced (Faerie Charm before Forbidden Idol).
    for (const d of DESCRIPTION_STATS) {
        const item = data?.[d.ref];
        const cost = item?.gold?.total;
        const own = descriptionStats(item?.description);
        const amount = own[d.key];
        if (!(amount > 0 && cost > 0)) continue;
        let rest = cost;
        for (const [k, v] of Object.entries(item.stats || {})) rest -= (v || 0) * (values[k] ?? Infinity);
        for (const [k, v] of Object.entries(own)) if (k !== d.key) rest -= v * (values[k] ?? Infinity);
        if (rest > 0 && Number.isFinite(rest)) values[d.key] = rest / amount;
    }
    return values;
}

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
    ...Object.fromEntries(DESCRIPTION_STATS.map(d => [d.key, d.name])),
};

const PERCENT_STATS = new Set([
    'FlatCritChanceMod', 'PercentAttackSpeedMod', 'PercentMovementSpeedMod', 'PercentLifeStealMod',
]);

// Description stat names the two lists above price; anything else in the
// <stats> block (Adaptive Force, Gold Per 10 Seconds ...) has no gold value,
// so the efficiency of such an item reads too low.
const PRICED_NAMES = new Set([
    'Health', 'Mana', 'Armor', 'Magic Resist', 'Attack Damage', 'Ability Power', 'Critical Strike Chance',
    'Attack Speed', 'Move Speed', 'Life Steal', 'Health Regen', 'Mana Regen',
    ...DESCRIPTION_STATS.map(d => d.name),
]);
const DESCRIPTION_PERCENT = new Set(DESCRIPTION_STATS.filter(d => d.percent).map(d => d.key));

// rawStats: DDragon `stats` (percent stats as fractions); descStats: from
// descriptionStats() (percent stats as written, e.g. 18 for 18%).
function computeItemStats(rawStats, goldValues = GOLD_VALUES, descStats = {}) {
    const stats = [];
    let statsGoldValue = 0;
    const entries = [
        ...Object.entries(rawStats || {}).map(([k, v]) => [k, v, PERCENT_STATS.has(k) ? v * 100 : v]),
        ...Object.entries(descStats).map(([k, v]) => [k, v, v]),
    ];
    for (const [key, val, shown] of entries) {
        if (!val) continue;
        const goldPerUnit = goldValues[key];
        if (goldPerUnit === undefined) continue;

        const isPercent   = PERCENT_STATS.has(key) || DESCRIPTION_PERCENT.has(key);
        const displayVal  = Math.round(shown * 100) / 100;
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

// Summoner's Rift shop items only: DDragon also lists Arena, ARAM and Swarm
// items, champion-specific items (Kalista's spear, ...) and hidden ones.
function isRiftShopItem(item) {
    return !!item?.gold?.purchasable
        && item.gold.total > 0
        && item.maps?.['11'] === true
        && !item.requiredChampion
        && item.inStore !== false;
}

function buildItemList(data, version) {
    const goldValues = deriveGoldValues(data);
    const list = [];
    for (const id in data) {
        const item = data[id];
        if (!isRiftShopItem(item)) continue;

        const { stats, statsGoldValue } = computeItemStats(item.stats, goldValues, descriptionStats(item.description));
        const efficiency = Math.round((statsGoldValue / item.gold.total) * 1000) / 10;

        list.push({
            id: parseInt(id),
            name: item.name,
            icon: `https://ddragon.leagueoflegends.com/cdn/${version}/img/item/${id}.png`,
            tags: item.tags || [],
            gold: item.gold,
            stats,
            statsGoldValue,
            efficiency,
            efficiencyIncomplete: descriptionStatLines(item.description).some(l => !PRICED_NAMES.has(l.name)),
            descriptionLines: descriptionToLines(item.description),
        });
    }
    // DDragon can list separate item IDs for map-specific rebalances that
    // share the same display name. Keep only the lowest-numbered ID per name —
    // that's consistently the base Summoner's Rift version.
    const byName = new Map();
    for (const item of list) {
        const existing = byName.get(item.name);
        if (!existing || item.id < existing.id) byName.set(item.name, item);
    }
    const deduped = [...byName.values()];
    deduped.sort((a, b) => a.name.localeCompare(b.name));
    return deduped;
}

// Same background retry as champion-data: 1 minute, doubling up to 10.
const RETRY_FIRST_MS = 60 * 1000;
const RETRY_MAX_MS = 10 * 60 * 1000;
let retryDelayMs = RETRY_FIRST_MS;
let retryTimer = null;
let waitingForChampions = false;

function scheduleRetry() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
        retryTimer = null;
        fetchItemData();
    }, retryDelayMs);
    retryTimer.unref?.();
    retryDelayMs = Math.min(retryDelayMs * 2, RETRY_MAX_MS);
}

async function fetchItemData(attempt = 0) {
    // Without the real Data Dragon version, item.json would come from an old
    // patch. Wait for champion-data to load it (it keeps retrying).
    if (!championData.isLoaded()) {
        if (!waitingForChampions) {
            waitingForChampions = true;
            championData.onLoaded(() => { waitingForChampions = false; fetchItemData(); });
        }
        console.warn('[DDragon] Item list waits for the Data Dragon version');
        resolveReady();
        return;
    }

    const MAX_ATTEMPTS = 3;
    try {
        const version = championData.getLatestVersion();
        const res  = await axios.get(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/item.json`, { timeout: 15000 });
        itemList = buildItemList(res.data.data, version);
        latestVersion = version;

        console.log(`[DDragon] Loaded ${itemList.length} purchasable items (v${latestVersion})`);
        resolveReady();
    } catch (e) {
        console.error(`[DDragon] Item fetch attempt ${attempt + 1}/${MAX_ATTEMPTS} failed: ${e.message}`);
        if (attempt < MAX_ATTEMPTS - 1) {
            await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
            return fetchItemData(attempt + 1);
        }
        console.warn('[DDragon] All item fetch attempts failed, retrying later.');
        resolveReady();
        scheduleRetry();
    }
}

module.exports = {
    fetchItemData,
    whenReady,
    getItemList: () => itemList,
    buildItemList,
    computeItemStats,
    deriveGoldValues,
    descriptionStats,
};
