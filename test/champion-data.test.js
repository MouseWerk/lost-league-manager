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

// Community Dragon's character record carries the attack speed ratio that
// Data Dragon lacks (fixture shaped like graves.bin.json).
test('the attack speed ratio is read from the character record', () => {
    const bin = {
        'Characters/Graves/Spells/GravesBasicAttack': { mSpell: {} },
        'Characters/Graves/CharacterRecords/Root': {
            attackSpeedModifiable: { baseValue: 0.475 },
            attackSpeedRatioModifiable: { baseValue: 0.49 },
        },
    };
    assert.equal(championData.attackSpeedRatioFromBin(bin, 'Graves'), 0.49);
    assert.equal(championData.attackSpeedRatioFromBin({ 'Characters/Old/CharacterRecords/Root': { attackSpeedRatio: 0.625 } }, 'Old'), 0.625);
    assert.equal(championData.attackSpeedRatioFromBin({}, 'Graves'), null);
    assert.equal(championData.attackSpeedRatioFromBin(null, 'Graves'), null);
});

test('the attack speed ratio is fetched once per champion and not cached on failure', async (t) => {
    let calls = 0, fail = true;
    t.mock.method(axios, 'get', async (url, opts) => {
        calls++;
        assert.equal(url, 'https://raw.communitydragon.org/latest/game/data/characters/zeri/zeri.bin.json');
        assert.ok(opts.timeout > 0);
        if (fail) throw new Error('offline');
        return { data: { 'Characters/Zeri/CharacterRecords/Root': { attackSpeedRatioModifiable: { baseValue: 0.625 } } } };
    });
    assert.equal(await championData.getAttackSpeedRatio('Zeri'), null);
    fail = false;
    assert.equal(await championData.getAttackSpeedRatio('Zeri'), 0.625);
    assert.equal(await championData.getAttackSpeedRatio('Zeri'), 0.625);
    assert.equal(calls, 2);
    assert.equal(await championData.getAttackSpeedRatio('../x'), null);
});
