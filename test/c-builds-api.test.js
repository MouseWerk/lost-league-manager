const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const itemData = require('../src/main/services/item-data');
const { getBuilds } = require('../src/main/services/builds-api');

// Trimmed op.gg build page: item images in page order (no __NEXT_DATA__ any more).
const PAGE = ['1056', '2003', '3020', '3171', '3118', '4645', '3157', '3089']
    .map(id => `<img src="https://opgg-static.akamaized.net/meta/images/lol/16.20.1/item/${id}.png">`).join('\n');

test('ARAM builds come from the ARAM page, not the redirect to the Summoner\'s Rift build', async (t) => {
    const get = t.mock.method(axios, 'get', async () => ({ data: PAGE }));
    await getBuilds('MonkeyKing', 'ARAM', 'MIDDLE');
    assert.equal(get.mock.calls[0].arguments[0], 'https://op.gg/lol/modes/aram/monkeyking/build');
    await getBuilds('Ahri', 'CLASSIC', 'MIDDLE');
    assert.equal(get.mock.calls[1].arguments[0], 'https://op.gg/lol/champions/ahri/build/mid');
});

test('upgraded boots land in the boots row', async (t) => {
    t.mock.method(axios, 'get', async () => ({ data: PAGE }));
    const builds = await getBuilds('Ahri', 'CLASSIC', 'MIDDLE');
    assert.deepEqual(builds.boots, [3020, 3171]);
    assert.ok(!builds.core.includes(3171));
});

test('boots are recognised by their Data Dragon tag when the item list is loaded', async (t) => {
    t.mock.method(itemData, 'getItemList', () => [{ id: 3118, tags: ['Boots'] }]);
    t.mock.method(axios, 'get', async () => ({ data: PAGE }));
    const builds = await getBuilds('Ahri', 'CLASSIC', 'MIDDLE');
    assert.deepEqual(builds.boots, [3118]);
});
