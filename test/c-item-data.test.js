const test = require('node:test');
const assert = require('node:assert/strict');
const itemData = require('../src/main/services/item-data');

const RIFT = { '11': true, '12': true, '30': false };
const NOT_RIFT = { '11': false, '12': true, '30': true };

function item(name, total, stats, extra = {}) {
    return { name, description: '', gold: { base: total, total, sell: 0, purchasable: true }, maps: RIFT, stats, tags: [], ...extra };
}

// Base item prices as of Data Dragon 16.20.1.
const BASE_ITEMS = {
    1036: item('Long Sword', 350, { FlatPhysicalDamageMod: 10 }),
    1052: item('Amplifying Tome', 400, { FlatMagicDamageMod: 20 }),
    1029: item('Cloth Armor', 300, { FlatArmorMod: 15 }),
    1028: item('Ruby Crystal', 400, { FlatHPPoolMod: 150 }),
    1027: item('Sapphire Crystal', 300, { FlatMPPoolMod: 300 }),
    1001: item('Boots', 300, { FlatMovementSpeedMod: 25 }),
    1053: item('Vampiric Scepter', 900, { FlatPhysicalDamageMod: 15, PercentLifeStealMod: 0.07 }),
};

// Data Dragon also lists Arena / ARAM / Swarm items; 158 of them showed up in
// the item viewer with a gold efficiency.
test('the item list holds Summoner\'s Rift shop items only', () => {
    const data = {
        3031: item('Infinity Edge', 3450, { FlatPhysicalDamageMod: 65 }),
        3039: item('Atma\'s Reckoning', 2900, { FlatHPPoolMod: 400 }, { maps: NOT_RIFT }),
        2147: item('Augment Level', 100, {}, { maps: NOT_RIFT }),
        223031: item('Infinity Edge', 3450, { FlatPhysicalDamageMod: 65 }, { maps: NOT_RIFT }),
        3599: item('Kalista\'s Black Spear', 1, {}, { requiredChampion: 'Kalista' }),
        3400: item('Your Cut', 1, {}, { inStore: false }),
        2052: item('Poro-Snax', 1, {}, { gold: { total: 0, purchasable: false } }),
    };
    const list = itemData.buildItemList(data, '16.20.1');
    assert.deepEqual(list.map(i => i.id), [3031]);
    assert.equal(list[0].icon, 'https://ddragon.leagueoflegends.com/cdn/16.20.1/img/item/3031.png');
});

test('every base item is exactly 100% gold efficient', () => {
    const list = itemData.buildItemList(BASE_ITEMS, '16.20.1');
    assert.equal(list.length, Object.keys(BASE_ITEMS).length);
    for (const i of list) assert.equal(i.efficiency, 100, i.name);
});

test('gold values follow the prices in the loaded item data', () => {
    const cheaperTome = { ...BASE_ITEMS, 1052: item('Amplifying Tome', 300, { FlatMagicDamageMod: 20 }) };
    assert.equal(itemData.deriveGoldValues(cheaperTome).FlatMagicDamageMod, 15);
});

test('fallback gold values price AP at 20 g and life steal from Vampiric Scepter', () => {
    assert.equal(itemData.computeItemStats({ FlatMagicDamageMod: 20 }).statsGoldValue, 400);
    assert.equal(Math.round(itemData.computeItemStats({ FlatPhysicalDamageMod: 15, PercentLifeStealMod: 0.07 }).statsGoldValue), 900);
});

const desc = (...lines) => `<mainText><stats>${lines.join('<br>')}</stats></mainText>`;
const at = (n, name) => `<attention>${n}</attention> ${name}`;

// Reference items for the stats Data Dragon lists only in the description.
const DESCRIPTION_ITEMS = {
    ...BASE_ITEMS,
    1033: item('Null-Magic Mantle', 450, { FlatSpellBlockMod: 25 }),
    1004: item('Faerie Charm', 200, {}, { description: desc(at('50%', 'Base Mana Regen')) }),
    2022: item('Glowing Mote', 250, {}, { description: desc(at(5, 'Ability Haste')) }),
    3134: item('Serrated Dirk', 1000, { FlatPhysicalDamageMod: 20 }, { description: desc(at(20, 'Attack Damage'), at(10, 'Lethality')) }),
    3114: item('Forbidden Idol', 600, {}, { description: desc(at('50%', 'Base Mana Regen'), at('8%', 'Heal and Shield Power')) }),
    3020: item("Sorcerer's Shoes", 1100, { FlatMovementSpeedMod: 45 }, { description: desc(at(12, 'Magic Penetration'), at(45, 'Move Speed')) }),
    4630: item('Blighting Jewel', 1100, { FlatMagicDamageMod: 25 }, { description: desc(at(25, 'Ability Power'), at('13%', 'Magic Penetration')) }),
};

// Ability haste, lethality, penetration and the rest used to count as 0 g,
// so Black Cleaver showed 88% instead of 121%.
test('stats listed only in the description are priced by their reference items', () => {
    const v = itemData.deriveGoldValues(DESCRIPTION_ITEMS);
    assert.equal(v.AbilityHaste, 50);
    assert.equal(v.Lethality, 30);
    assert.equal(v.BaseMPRegen, 4);
    assert.equal(v.HealShieldPower, 50);   // after the mana regen of the same item
    assert.equal(Math.round(v.MagicPenFlat * 100) / 100, 46.67);
    assert.equal(Math.round(v.MagicPenPercent * 100) / 100, 46.15);
    const list = itemData.buildItemList(DESCRIPTION_ITEMS, '16.20.1');
    for (const i of list) assert.equal(i.efficiency, 100, i.name);
});

test('flat and percent magic penetration are told apart', () => {
    assert.deepEqual(itemData.descriptionStats(desc(at(20, 'Magic Penetration'), at('8%', 'Magic Penetration'), at(45, 'Move Speed'))),
        { MagicPenFlat: 20, MagicPenPercent: 8 });
});

test('an item with ability haste counts it in its gold value', () => {
    const data = {
        ...DESCRIPTION_ITEMS,
        3071: item('Black Cleaver', 3000, { FlatPhysicalDamageMod: 45, FlatHPPoolMod: 400 }, {
            description: desc(at(45, 'Attack Damage'), at(400, 'Health'), at(20, 'Ability Haste')),
        }),
    };
    const bc = itemData.buildItemList(data, '16.20.1').find(i => i.id === 3071);
    assert.equal(bc.stats.find(s => s.key === 'AbilityHaste').goldValue, 1000);
    assert.equal(bc.efficiency, 121.4);
    assert.equal(bc.efficiencyIncomplete, false);
});

test('items with stats that have no gold value are marked as incomplete', () => {
    const data = {
        3152: item("Gambler's Blade", 3000, { FlatPhysicalDamageMod: 40 }, {
            description: desc(at(40, 'Attack Damage'), at(15, 'Adaptive Force')),
        }),
        3031: item('Infinity Edge', 3450, { FlatPhysicalDamageMod: 65 }, {
            description: '<mainText><stats><attention>65</attention> Attack Damage</stats><br><passive>Adaptive Force</passive> mentioned outside the stats</mainText>',
        }),
    };
    const list = itemData.buildItemList(data, '16.20.1');
    assert.equal(list.find(i => i.id === 3152).efficiencyIncomplete, true);
    assert.equal(list.find(i => i.id === 3031).efficiencyIncomplete, false);
});
