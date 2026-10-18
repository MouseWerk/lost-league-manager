const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const championData = require('../src/main/services/champion-data');
const itemData = require('../src/main/services/item-data');

const CHAMPIONS = { data: { Ahri: { id: 'Ahri', key: '103', name: 'Ahri', title: 'the Nine-Tailed Fox' } } };
const ITEMS = {
    data: {
        1036: { name: 'Long Sword', description: '', gold: { total: 350, purchasable: true }, maps: { '11': true }, stats: { FlatPhysicalDamageMod: 10 } },
    },
};

const flush = () => new Promise(r => setImmediate(r));

// Advances the mocked clock in small steps so awaited timers chain correctly.
async function advance(t, ms, step = 500) {
    for (let done = 0; done < ms; done += step) {
        await flush();
        t.mock.timers.tick(step);
    }
    await flush();
}

// An offline start used to leave champion names, icons and the item list
// empty until the app was restarted, and fetched item.json for the old
// fallback version 14.1.1.
test('Data Dragon is fetched again after an offline start, and items wait for the real version', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let online = false;
    const urls = [];
    t.mock.method(axios, 'get', async (url) => {
        urls.push(url);
        if (!online) throw new Error('getaddrinfo ENOTFOUND ddragon.leagueoflegends.com');
        if (url.endsWith('versions.json')) return { data: ['99.1.1'] };
        if (url.endsWith('champion.json')) return { data: CHAMPIONS };
        if (url.endsWith('item.json')) return { data: ITEMS };
        throw new Error(`unexpected ${url}`);
    });

    // Boot order from main.js: champions, then items.
    const boot = championData.fetchChampionData().then(() => itemData.fetchItemData());
    await advance(t, 7000);
    await boot;
    assert.equal(championData.isLoaded(), false);
    assert.equal(championData.getChampionIdByKey('Ahri'), null);
    assert.ok(!urls.some(u => u.endsWith('item.json')), 'item.json must not be fetched with the fallback version');

    online = true;
    await advance(t, 60000);
    assert.equal(championData.isLoaded(), true);
    assert.equal(championData.getChampionIdByKey('Ahri'), 103);
    await advance(t, 1000);
    const itemUrls = urls.filter(u => u.endsWith('item.json'));
    assert.deepEqual(itemUrls, ['https://ddragon.leagueoflegends.com/cdn/99.1.1/data/en_US/item.json']);
    assert.deepEqual(itemData.getItemList().map(i => i.name), ['Long Sword']);
});
