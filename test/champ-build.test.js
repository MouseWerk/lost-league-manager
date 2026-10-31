require('./helpers/fake-electron');
const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const state = require('../src/main/state');
const lcu = require('../src/main/lcu');
const opgg = require('../src/main/services/opgg-api');
const championData = require('../src/main/services/champion-data');
const clientImport = require('../src/main/services/client-import');
const champBuild = require('../src/main/ipc/champ-build');

// Trimmed from a real lol_get_champion_analysis answer for Ahri mid.
const BUILD_TEXT = [
    'class LolGetChampionAnalysis: data',
    'class Data: core_items,boots,starter_items,fourth_items,fifth_items,sixth_items,runes,skill_masteries',
    'class CoreItems: ids',
    'class Runes: primary_page_id,primary_page_name,primary_rune_ids,primary_rune_names,secondary_page_id,secondary_page_name,secondary_rune_ids,secondary_rune_names,stat_mod_ids,play,win',
    'class SkillMasteries: ids',
    '',
    'LolGetChampionAnalysis(Data(CoreItems([3118,4645,3157]),CoreItems([3020]),CoreItems([1056,2003,2003]),'
        + '[CoreItems([3089]),CoreItems([3157])],[CoreItems([3135])],[CoreItems([3089])],'
        + 'Runes(8100,"Domination",[8112,8139,8140,8106],["Electrocute","Taste of Blood","Grisly Mementos","Ultimate Hunter"],'
        + '8200,"Sorcery",[8210,8226],["Transcendence","Manaflow Band"],[5005,5008,5001],1000,520),SkillMasteries(["Q","W","E"])))',
].join('\n');
const POS_TEXT = 'class LolGetChampionAnalysis: data\nclass Data: summary\nclass Summary: positions\nclass Position: name\n\nLolGetChampionAnalysis(Data(Summary([Position("SUPPORT")])))';

const mcp = (text) => ({ data: { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } } });

test.beforeEach(() => opgg._resetForTests());

test('a build has a full rune page, items by stage and the skill order', async (t) => {
    t.mock.method(axios, 'post', async () => mcp(BUILD_TEXT));
    const b = await opgg.getChampionBuild('Ahri', 'mid');
    assert.deepEqual(b.runes.perkIds, [8112, 8139, 8140, 8106, 8210, 8226, 5005, 5008, 5001]);
    assert.equal(b.runes.primaryStyleId, 8100);
    assert.equal(b.runes.subStyleId, 8200);
    assert.equal(b.runes.winRate, 52);
    assert.deepEqual(b.items.starter, [1056, 2003, 2003]);
    assert.deepEqual(b.items.core, [3118, 4645, 3157]);
    assert.deepEqual(b.items.late, [3089, 3135]);
    assert.deepEqual(b.skills, ['Q', 'W', 'E']);
});

test('without a position the build is for the champion\'s main one', async (t) => {
    const calls = [];
    t.mock.method(axios, 'post', async (url, body) => {
        calls.push(body.params.arguments);
        return mcp(body.params.arguments.desired_output_fields.length === 1 ? POS_TEXT : BUILD_TEXT);
    });
    const b = await opgg.getChampionBuild('Lulu', null);
    assert.equal(b.position, 'support');
    assert.equal(calls[1].position, 'support');
    assert.equal(calls[1].champion, 'LULU');
});

test('a key that is not a champion is refused before asking OP.GG', async () => {
    await assert.rejects(opgg.getChampionBuild('../x', 'mid'), /Unknown champion/);
});

const BUILD = {
    position: 'mid', mode: 'ranked', skills: ['Q', 'W', 'E'],
    runes: { primaryStyleId: 8100, subStyleId: 8200, perkIds: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
    items: { starter: [1056], boots: [3020], core: [3118], late: [3089] },
};

test('payloads: the rune page and item set carry the app prefix', () => {
    const page = clientImport.runePagePayload(BUILD, 'Ahri');
    assert.equal(page.name, 'LLM Ahri Mid');
    assert.deepEqual(page.selectedPerkIds, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const set = clientImport.itemSetPayload(BUILD, 'Ahri', 103);
    assert.equal(set.title, 'LLM Ahri Mid');
    assert.deepEqual(set.associatedChampions, [103]);
    assert.deepEqual(set.associatedMaps, [11]);
    assert.deepEqual(set.blocks.map(b => b.items[0].id), ['1056', '3020', '3118', '3089']);
    assert.match(set.blocks[0].type, /max Q > W > E/);
    assert.deepEqual(clientImport.itemSetPayload({ ...BUILD, mode: 'aram' }, 'Ahri', 103).associatedMaps, [12]);
});

function fakeLcu(routes, log) {
    lcu.connected = true;
    lcu.request = async (method, url, body) => {
        log.push(`${method} ${url}`);
        const r = routes[`${method} ${url}`];
        return typeof r === 'function' ? r(body) : (r === undefined ? null : r);
    };
}

test('runes: the app\'s old page is replaced, the player\'s pages are not', async () => {
    const log = [];
    let posted = null;
    fakeLcu({
        'GET /lol-perks/v1/pages': [
            { id: 1, name: 'My page', isDeletable: true, current: true },
            { id: 2, name: 'LLM Zed Mid', isDeletable: true },
            { id: 3, name: 'Preset', isDeletable: false },
        ],
        'GET /lol-perks/v1/inventory': { ownedPageCount: 2 },
        'DELETE /lol-perks/v1/pages/2': {},
        'POST /lol-perks/v1/pages': (b) => { posted = b; return { id: 9 }; },
    }, log);
    const res = await clientImport.importRunes(BUILD, 'Ahri');
    assert.equal(res.success, true);
    assert.ok(log.includes('DELETE /lol-perks/v1/pages/2'));
    assert.ok(!log.includes('DELETE /lol-perks/v1/pages/1'));
    assert.equal(posted.name, 'LLM Ahri Mid');
});

test('runes: with every page taken, the current page goes only after a yes', async () => {
    const log = [];
    const routes = {
        'GET /lol-perks/v1/pages': [{ id: 1, name: 'A', isDeletable: true }, { id: 4, name: 'B', isDeletable: true, current: true }],
        'GET /lol-perks/v1/inventory': { ownedPageCount: 2 },
        'DELETE /lol-perks/v1/pages/4': {},
        'POST /lol-perks/v1/pages': { id: 9 },
    };
    fakeLcu(routes, log);
    const ask = await clientImport.importRunes(BUILD, 'Ahri');
    assert.equal(ask.needsConfirm, true);
    assert.ok(!log.some(l => l.startsWith('DELETE') || l.startsWith('POST')));
    const yes = await clientImport.importRunes(BUILD, 'Ahri', { replaceCurrent: true });
    assert.equal(yes.success, true);
    assert.ok(log.includes('DELETE /lol-perks/v1/pages/4'));
    assert.ok(!log.includes('DELETE /lol-perks/v1/pages/1'));
});

test('item set: other sets stay, the same title is replaced', async () => {
    let put = null;
    fakeLcu({
        'GET /lol-summoner/v1/current-summoner': { summonerId: 77, accountId: 5 },
        'GET /lol-item-sets/v1/item-sets/77/sets': { accountId: 5, itemSets: [{ title: 'Mine' }, { title: 'LLM Ahri Mid' }], timestamp: 1 },
        'PUT /lol-item-sets/v1/item-sets/77/sets': (b) => { put = b; return ''; },
    }, []);
    const res = await clientImport.importItemSet(BUILD, 'Ahri', 103);
    assert.equal(res.success, true);
    assert.deepEqual(put.itemSets.map(s => s.title), ['Mine', 'LLM Ahri Mid']);
    assert.equal(put.itemSets[1].blocks.length, 4);
});

test('auto import runs once per locked champion, only when switched on', async (t) => {
    t.mock.method(championData, 'whenReady', async () => {});
    t.mock.method(championData, 'getIdToNameMap', () => ({ 103: 'Ahri' }));
    t.mock.method(championData, 'getChampionList', () => [{ key: 'Ahri', name: 'Ahri' }]);
    t.mock.method(opgg, 'getChampionBuild', async () => BUILD);
    const runes = t.mock.method(clientImport, 'importRunes', async () => ({ success: true }));
    t.mock.method(clientImport, 'importItemSet', async () => ({ success: true }));
    fakeLcu({ 'GET /lol-gameflow/v1/session': { gameData: { queue: { gameMode: 'CLASSIC' } } } }, []);
    const hover = { localPlayerCellId: 0, myTeam: [{ cellId: 0, championPickIntent: 103, assignedPosition: 'middle' }], actions: [] };
    const locked = { localPlayerCellId: 0, myTeam: [{ cellId: 0, championId: 103, assignedPosition: 'middle' }], actions: [[{ actorCellId: 0, type: 'pick', completed: true, championId: 103 }]] };

    state.config.autoImportBuild = false;
    champBuild.resetAutoImport();
    assert.equal(await champBuild.autoImportOnLock(locked), null);
    state.config.autoImportBuild = true;
    assert.equal(await champBuild.autoImportOnLock(hover), null, 'a hover is not a pick');
    const r = await champBuild.autoImportOnLock(locked);
    assert.equal(r.champion, 'Ahri');
    assert.equal(await champBuild.autoImportOnLock(locked), null, 'once per champion');
    assert.equal(runes.mock.callCount(), 1);
    state.config.autoImportBuild = false;
});

test('the position comes from the assigned role', () => {
    const p = champBuild.pickFromSession({ localPlayerCellId: 2, myTeam: [{ cellId: 2, championId: 1, assignedPosition: 'utility' }], actions: [] });
    assert.deepEqual(p, { championId: 1, position: 'support', locked: false });
    assert.equal(champBuild.pickFromSession(null), null);
});
