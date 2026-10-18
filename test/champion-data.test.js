const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const championData = require('../src/main/services/champion-data');

// Boot no longer blocks on Data Dragon; handlers wait on whenReady() instead.
test('whenReady gives up after its timeout when Data Dragon never answers', async () => {
    const start = Date.now();
    await championData.whenReady(30);
    assert.ok(Date.now() - start >= 25);
});

test('Data Dragon requests have a timeout, and whenReady resolves once loaded', async (t) => {
    const timeouts = [];
    t.mock.method(axios, 'get', async (url, opts) => {
        timeouts.push(opts?.timeout);
        if (url.endsWith('versions.json')) return { data: ['99.1.1'] };
        return { data: { data: { Ahri: { id: 'Ahri', key: '103', name: 'Ahri', title: 'the Nine-Tailed Fox' } } } };
    });
    await championData.fetchChampionData();
    await championData.whenReady(1000);
    assert.ok(timeouts.every(ms => typeof ms === 'number' && ms > 0), `timeouts: ${timeouts}`);
    assert.equal(championData.getLatestVersion(), '99.1.1');
    assert.equal(championData.getChampionIdByKey('Ahri'), 103);
    assert.equal(championData.getChampionIdByKey('Nobody'), null);
});
