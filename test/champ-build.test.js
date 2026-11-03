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

test('no build in modes OP.GG has none for (Arena, URF)', async (t) => {
    fakeLcu({ 'GET /lol-gameflow/v1/session': { gameData: { queue: { gameMode: 'CHERRY' } } } }, []);
    const pick = await champBuild.currentPick({ localPlayerCellId: 0, myTeam: [{ cellId: 0, championId: 103 }], actions: [] });
    assert.equal(pick.mode, null);
    state.config.autoImportBuild = true;
    champBuild.resetAutoImport();
    const runes = t.mock.method(clientImport, 'importRunes', async () => ({ success: true }));
    const locked = { localPlayerCellId: 0, myTeam: [{ cellId: 0, championId: 103 }], actions: [[{ actorCellId: 0, type: 'pick', completed: true, championId: 103 }]] };
    assert.equal(await champBuild.autoImportOnLock(locked), null);
    assert.equal(runes.mock.callCount(), 0);
    state.config.autoImportBuild = false;
});

// Matchup guide: OP.GG answers this tool in plain JSON.
const MATCHUP_JSON = JSON.stringify({
    my_champion: 'Ahri', opponent_champion: 'Zed', position: 'mid',
    data: {
        summoner_spells: [{ ids: [4, 14], ids_names: ['Flash', 'Ignite'], play: 600, win: 300 }, { ids: [4, 12], ids_names: ['Flash', 'Teleport'], play: 400, win: 220 }],
        starter_items: [{ ids: [1056, 2003] }], boots: [{ ids: [3020] }], core_items: [{ ids: [3118, 4645, 3157] }],
        runes: [{ primary_page_id: 8100, primary_page_name: 'Domination', primary_rune_ids: [8112, 8139, 8140, 8106], primary_rune_names: ['Electrocute', 'Taste of Blood', 'Grisly Mementos', 'Ultimate Hunter'], secondary_page_id: 8200, secondary_page_name: 'Sorcery', secondary_rune_ids: [8210, 8226], secondary_rune_names: ['Transcendence', 'Manaflow Band'], stat_mod_ids: [5005, 5008, 5001] }],
        skill_masteries: [{ ids: ['Q', 'E', 'W'] }],
    },
});

test('matchup guide: win rate over all games, runes, items, spells and skills against one champion', async (t) => {
    const posted = [];
    t.mock.method(axios, 'post', async (url, body) => { posted.push(body.params.arguments); return mcp(MATCHUP_JSON); });
    const g = await opgg.getMatchupGuide('Ahri', 'Zed', 'mid');
    assert.deepEqual(posted[0], { position: 'mid', my_champion: 'AHRI', opponent_champion: 'ZED' });
    assert.equal(g.games, 1000);
    assert.equal(g.winRate, 52);
    assert.equal(g.runes.perkIds.length, 9);
    assert.deepEqual(g.items, { starter: [1056, 2003], boots: [3020], core: [3118, 4645, 3157] });
    assert.deepEqual(g.spells, ['Flash', 'Ignite']);
    assert.deepEqual(g.skills, ['Q', 'E', 'W']);
});

test('duo synergy: OP.GG partners for a champion and position', async (t) => {
    const SYN = 'class LolGetChampionSynergies: data\nclass Data: synergies\nclass Synergie: synergy_champion_id,synergy_champion_name,score_rank,play,win_rate\n\nLolGetChampionSynergies(Data([Synergie(412,"Thresh",1,8592,0.53),Synergie(117,"Lulu",2,7525,0.5)]))';
    t.mock.method(axios, 'post', async () => mcp(SYN));
    const list = await opgg.getSynergies('Jinx', 'adc', 'support');
    assert.deepEqual(list[1], { champion: 'Lulu', championId: 117, winRate: 50, games: 7525, rank: 2 });
    await assert.rejects(opgg.getSynergies('Jinx', 'adc', 'nowhere'), /Unknown position/);
});

test('draft: enemy picks with their lane, and party members as duo', async (t) => {
    t.mock.method(championData, 'getIdToNameMap', () => ({ 238: 'Zed', 117: 'Lulu', 222: 'Jinx' }));
    t.mock.method(championData, 'getChampionList', () => [{ key: 'Zed', name: 'Zed' }, { key: 'Lulu', name: 'Lulu' }, { key: 'Jinx', name: 'Jinx' }]);
    t.mock.method(championData, 'getIdToImageMap', () => ({}));
    fakeLcu({ 'GET /lol-lobby/v2/lobby': { members: [{ puuid: 'me' }, { puuid: 'friend' }] } }, []);
    const session = {
        localPlayerCellId: 0,
        myTeam: [{ cellId: 0, puuid: 'me', championId: 222, assignedPosition: 'bottom' }, { cellId: 1, puuid: 'friend', championId: 117, assignedPosition: 'utility' }, { cellId: 2, puuid: 'rando', championId: 1 }],
        theirTeam: [{ championId: 238, assignedPosition: 'middle' }, { championId: 0 }],
    };
    const d = await champBuild.draftContext(session, { position: 'mid' });
    assert.deepEqual(d.enemies.map((e) => [e.key, e.position]), [['Zed', 'mid']]);
    assert.equal(d.laneOpponent, 'Zed');
    assert.deepEqual(d.duo.map((x) => [x.key, x.position]), [['Lulu', 'support']]);
});

test('the build keeps the choices for every later item slot with win and pick rate', async (t) => {
    const text = [
        'class LolGetChampionAnalysis: data',
        'class Data: core_items,boots,starter_items,fourth_items,fifth_items,sixth_items,skill_masteries',
        'class CoreItems: ids,play,win,pick_rate',
        'class SkillMasteries: ids',
        '',
        'LolGetChampionAnalysis(Data(CoreItems([3118,4645,3157],17974,9471,0.13),CoreItems([3020],132853,69027,0.59),CoreItems([1056,2003,2003],228208,117296,0.99),'
            + '[CoreItems([3089],18842,11074,0.32),CoreItems([3157],14748,8779,0.25),CoreItems([3135],5005,2661,0.09),CoreItems([3102],100,50,0.01)],'
            + '[CoreItems([3089],3076,1950,0.2)],[],SkillMasteries(["Q","W","E"])))',
    ].join('\n');
    t.mock.method(axios, 'post', async () => mcp(text));
    const b = await opgg.getChampionBuild('Ahri', 'mid');
    assert.deepEqual(b.items.coreStats, { ids: [3118, 4645, 3157], games: 17974, winRate: 52.7, pickRate: 13 });
    assert.equal(b.items.bootsStats.pickRate, 59);
    assert.equal(b.items.options.fourth.length, 3, 'at most three choices');
    assert.deepEqual(b.items.options.fourth[0], { ids: [3089], games: 18842, winRate: 58.8, pickRate: 32 });
    assert.deepEqual(b.items.options.fifth.map(c => c.ids[0]), [3089]);
    assert.deepEqual(b.items.options.sixth, []);
    assert.deepEqual(b.items.late, [3089], 'the most picked of each slot, as before');
});
