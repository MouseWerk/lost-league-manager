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

test('items with stats Data Dragon does not price are marked as incomplete', () => {
    const data = {
        3071: item('Black Cleaver', 3000, { FlatPhysicalDamageMod: 40, FlatHPPoolMod: 400 }, {
            description: '<mainText><stats><attention>40</attention> Attack Damage<br><attention>400</attention> Health<br><attention>20</attention> Ability Haste</stats></mainText>',
        }),
        3031: item('Infinity Edge', 3450, { FlatPhysicalDamageMod: 65 }, {
            description: '<mainText><stats><attention>65</attention> Attack Damage</stats><br><passive>Ability Haste</passive> mentioned outside the stats</mainText>',
        }),
    };
    const list = itemData.buildItemList(data, '16.20.1');
    assert.equal(list.find(i => i.id === 3071).efficiencyIncomplete, true);
    assert.equal(list.find(i => i.id === 3031).efficiencyIncomplete, false);
});
