// Collection: what each account owns, read from the League client at sign-in
// and after every game, so the search finds the account that has a skin.
const fx = require('./helpers/a-fakes');
const { invoke } = require('./helpers/fake-electron');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const state = require('../src/main/state');
const lcu = require('../src/main/lcu');
const collection = require('../src/main/services/collection');
const { registerLcuEvents } = require('../src/main/lcu-events');
const { collectionMatch, cardFacts } = require('../src/renderer/js/ui-lib.js');
require('../src/main/ipc/accounts').register();
require('../src/main/ipc/stats').register();

// Shapes as the client sends them (trimmed).
const CHAMPIONS = [
    { id: 103, name: 'Ahri', alias: 'Ahri', ownership: { owned: true, rental: { rented: false } } },
    { id: 1, name: 'Annie', alias: 'Annie', ownership: { owned: true } },
    { id: 157, name: 'Yasuo', alias: 'Yasuo', ownership: { owned: false, freeToPlayReward: false } }, // free rotation
    { id: -1, name: 'None', ownership: { owned: true } },
];
const SKINS = [
    { id: 103000, name: 'Ahri', championId: 103, isBase: true, ownership: { owned: true } },
    { id: 103015, name: 'Star Guardian Ahri', championId: 103, isBase: false, ownership: { owned: true } },
    { id: 103027, name: 'Spirit Blossom Ahri', championId: 103, isBase: false, ownership: { owned: false } },
    { id: 1005, name: 'Frostfire Annie', championId: 1, isBase: false, ownership: { owned: true } },
];
const LOOT = [
    { type: 'CHAMPION_RENTAL', count: 2, disenchantValue: 450, itemDesc: 'Garen' },
    { type: 'CHAMPION', count: 1, disenchantValue: 1260, itemDesc: 'Zed' },
    { type: 'SKIN_RENTAL', count: 3, disenchantValue: 220 },
    { type: 'CURRENCY', count: 5000, disenchantValue: 0 },
];

function fakeLcu(routes) {
    lcu.connected = true;
    lcu.request = async (method, endpoint) => {
        const r = routes[`${method} ${endpoint}`];
        return r === undefined ? null : r;
    };
}

const fullClient = () => ({
    'GET /lol-summoner/v1/current-summoner': { summonerId: 42, gameName: 'Main', tagLine: 'EUW' },
    'GET /lol-champions/v1/owned-champions-minimal': CHAMPIONS,
    'GET /lol-champions/v1/inventories/42/skins-minimal': SKINS,
    'GET /lol-loot/v1/player-loot': LOOT,
});

function reset() {
    fs.rmSync(state.paths.collection, { force: true });
}

test('owned champions and skins only, base skins and free rotation left out', () => {
    assert.deepEqual(collection.parseChampions(CHAMPIONS), [{ id: 103, name: 'Ahri' }, { id: 1, name: 'Annie' }]);
    assert.deepEqual(collection.parseSkins(SKINS), [
        { id: 1005, name: 'Frostfire Annie', championId: 1 },
        { id: 103015, name: 'Star Guardian Ahri', championId: 103 },
    ]);
    assert.equal(collection.parseChampions(null), null);
    assert.equal(collection.parseSkins({}), null);
});

test('loot counts champion and skin shards and what the champion shards are worth', () => {
    assert.deepEqual(collection.parseLoot(LOOT), { championShards: 3, skinShards: 3, shardBe: 2160 });
    assert.deepEqual(collection.parseLoot([]), { championShards: 0, skinShards: 0, shardBe: 0 });
    assert.equal(collection.parseLoot(null), null);
});

test('capturing keeps the old lists when the client does not answer or is not ready', async () => {
    reset();
    fakeLcu(fullClient());
    await collection.captureCollection('Main');
    assert.equal(collection.getCollection('MAIN').skins.length, 2);
    // Client still loading: no champions yet, skins endpoint missing.
    fakeLcu({ ...fullClient(), 'GET /lol-champions/v1/owned-champions-minimal': [], 'GET /lol-champions/v1/inventories/42/skins-minimal': undefined });
    await collection.captureCollection('Main');
    const rec = collection.getCollection('main');
    assert.equal(rec.champions.length, 2, 'an empty list does not wipe the champions');
    assert.equal(rec.skins.length, 2);
    fakeLcu({});
    await collection.captureCollection('Main');
    assert.equal(collection.getCollection('main').champions.length, 2);
});

test('the account is read when the client connects with it signed in', async () => {
    reset();
    fx.writeAccounts([{ username: 'main', password: 'x' }]);
    state.mainWindow = fx.fakeWindow();
    fakeLcu({ ...fullClient(), 'GET /lol-login/v1/session': { username: 'main' } });
    registerLcuEvents();
    await Promise.all(lcu.connectHandlers.map((h) => h()));
    await fx.waitFor(() => collection.getCollection('main')?.skins);
    assert.equal(collection.getCollection('main').loot.championShards, 3);
});

test('the end of a game reads the collection again (loot changes)', async () => {
    reset();
    state.mainWindow = fx.fakeWindow();
    fakeLcu(fullClient());
    registerLcuEvents();
    state.currentAccount = { username: 'main' };
    await Promise.all(lcu.handlers.map((h) => h({ uri: '/lol-gameflow/v1/gameflow-phase', eventType: 'Update', data: 'EndOfGame' })));
    await fx.waitFor(() => collection.getCollection('main')?.loot);
    state.currentAccount = null;
});

test('get-accounts carries the counts and names, get-collection the lists, delete forgets it', async () => {
    reset();
    fx.writeAccounts([{ username: 'smurf', password: 'x' }]);
    fakeLcu(fullClient());
    await collection.captureCollection('smurf');
    const [acc] = await invoke('get-accounts');
    assert.equal(acc.collection.champions, 2);
    assert.equal(acc.collection.skins, 2);
    assert.ok(acc.collection.names.includes('Star Guardian Ahri'));
    const full = await invoke('get-collection', 'Smurf');
    assert.equal(full.skins[1].name, 'Star Guardian Ahri');
    assert.ok('key' in full.champions[0], 'each champion carries its icon key');
    assert.ok('key' in full.skins[0], 'each skin carries its champion key for the tile');
    assert.ok('key' in full.skins[0], 'each skin carries its champion key for the tile');
    assert.equal(await invoke('get-collection', 42), null);
    await invoke('delete-account', 'smurf');
    assert.equal(collection.getCollection('smurf'), null);
});

test('the search finds an account by a champion or skin it owns, from three letters on', () => {
    const acc = { collection: { names: ['Ahri', 'Annie', 'Star Guardian Ahri', 'Frostfire Annie'] } };
    assert.equal(collectionMatch(acc, 'star guard'), 'Star Guardian Ahri');
    assert.equal(collectionMatch(acc, 'ahri'), 'Ahri', 'the champion before its skins');
    assert.equal(collectionMatch(acc, 'ah'), null, 'too short');
    assert.equal(collectionMatch(acc, 'zed'), null);
    assert.equal(collectionMatch({}, 'ahri'), null);
    assert.deepEqual(cardFacts(acc, Date.now(), 'frostfire')[0], { kind: 'owns', text: 'Owns Frostfire Annie' });
    assert.deepEqual(cardFacts(acc, Date.now(), ''), []);
});

test('the renderer searches the collection and shows it in the panel', () => {
    const root = path.join(__dirname, '..', 'src', 'renderer');
    const app = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    assert.match(app, /!!collectionMatch\(a, q\)/, 'getFilteredSorted looks in the collection');
    assert.match(app, /cardFacts\(account, Date\.now\(\), currentQuery\)/);
    for (const id of ['profileCollectionWrap', 'profileCollectionBtn', 'collectionModal', 'collectionFilter', 'collectionGrid']) {
        assert.match(html, new RegExp(`id="${id}"`), id);
    }
    // Names from the client go in as text, never as markup.
    const grid = app.slice(app.indexOf('function renderCollectionGrid'), app.indexOf('function showCollectionTab'));
    assert.ok(grid.includes('name.textContent = item.name'));
    assert.ok(!/innerHTML/.test(grid));
});
