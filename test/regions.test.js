require('./helpers/fake-electron');
const test = require('node:test');
const assert = require('node:assert/strict');
const { getPlatform } = require('../src/main/services/riot-api');
const { opggProfileUrl } = require('../src/main/ipc/client-controls');
const { LCU_REGION_TO_APP } = require('../src/main/ipc/stats');

// LA1 is Latin America North (LAN), LA2 is Latin America South (LAS). These
// were swapped, so LAN/LAS accounts were looked up on the other server.
test('Riot API platform: LAN is la1, LAS is la2', () => {
    assert.equal(getPlatform('lan'), 'la1');
    assert.equal(getPlatform('las'), 'la2');
    assert.equal(getPlatform('LAN'), 'la1');
});

test('Riot API platform covers the split SEA servers and ME', () => {
    assert.equal(getPlatform('vn'), 'vn2');
    assert.equal(getPlatform('tw'), 'tw2');
    assert.equal(getPlatform('me'), 'me1');
    assert.equal(getPlatform('unknown'), 'euw1');
});

// "sea" is not a Riot platform host; legacy SEA accounts are looked up on SG,
// matching the OP.GG lookup and the op.gg profile link.
test('every app region has a Riot platform, an OP.GG region and a profile link that agree', () => {
    const { toOpggRegion } = require('../src/main/services/opgg-api');
    const regions = ['euw', 'eune', 'na', 'kr', 'jp', 'br', 'lan', 'las', 'oce', 'tr', 'ru', 'me', 'vn', 'tw', 'sg', 'ph', 'th', 'sea'];
    for (const r of regions) {
        const platform = getPlatform(r);
        assert.notEqual(platform, 'sea', r);
        assert.ok(platform === 'euw1' ? r === 'euw' : true, `${r} fell back to euw1`);
        const opggCode = toOpggRegion(r);
        assert.ok(opggCode, r);
        const link = opggProfileUrl(r, 'A#1');
        assert.equal(link, `https://www.op.gg/lol/summoners/${opggCode.toLowerCase()}/A-1`, r);
    }
    assert.equal(getPlatform('sea'), 'sg2');
});

test('OP.GG profile link uses the right server slug and encodes the Riot ID', () => {
    assert.equal(opggProfileUrl('la1', 'A#1'), 'https://www.op.gg/lol/summoners/lan/A-1');
    assert.equal(opggProfileUrl('la2', 'A#1'), 'https://www.op.gg/lol/summoners/las/A-1');
    assert.equal(opggProfileUrl('vn', 'Tên Tôi#VN2'), 'https://www.op.gg/lol/summoners/vn/T%C3%AAn%20T%C3%B4i-VN2');
    assert.equal(opggProfileUrl('euw', 'a/b#x?y'), 'https://www.op.gg/lol/summoners/euw/a%2Fb-x%3Fy');
});

test('OP.GG profile link rejects unusable input', () => {
    assert.equal(opggProfileUrl('cn', 'A#1'), null);
    assert.equal(opggProfileUrl('euw', 'NoTag'), null);
    assert.equal(opggProfileUrl('euw', '#TAG'), null);
    assert.equal(opggProfileUrl('euw', 42), null);
});

test('League client region names map to app regions', () => {
    assert.equal(LCU_REGION_TO_APP.la1, 'lan');
    assert.equal(LCU_REGION_TO_APP.la2, 'las');
    assert.equal(LCU_REGION_TO_APP.oc1, 'oce');
    assert.equal(LCU_REGION_TO_APP.euw, 'euw');
    assert.equal(LCU_REGION_TO_APP.eune, 'eune');
});
