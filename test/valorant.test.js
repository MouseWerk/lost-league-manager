// Valorant: what Valorant's servers send, read into what the app keeps per
// account; the loadout only with owned skins; saved sets. No network: the
// http module and the Riot Client are faked.
const fx = require('./helpers/a-fakes');
const { invoke } = require('./helpers/fake-electron');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const state = require('../src/main/state');

// Valorant's servers, by "METHOD url".
const routes = new Map();
const requests = [];
function fakeHttp(config) {
    const key = `${(config.method || 'GET').toUpperCase()} ${config.url}`;
    requests.push({ key, headers: config.headers || {}, data: config.data });
    if (!routes.has(key)) return Promise.reject(Object.assign(new Error('404'), { response: { status: 404 } }));
    const r = routes.get(key);
    return Promise.resolve({ data: typeof r === 'function' ? r(config) : r });
}
fakeHttp.get = (url, opts = {}) => fakeHttp({ ...opts, method: 'GET', url });
require.cache[require.resolve('../src/main/services/http')] = { id: 'http', filename: 'http', loaded: true, exports: fakeHttp };

const valorant = require('../src/main/services/valorant');
const launch = require('../src/main/ipc/launch');
require('../src/main/ipc/accounts').register();
require('../src/main/ipc/valorant').register();

const PUUID = '11111111-2222-3333-4444-555555555555';
const SEASON = 'aaaaaaaa-0000-0000-0000-000000000001';
const OLD_SEASON = 'aaaaaaaa-0000-0000-0000-000000000002';
const VANDAL = '9c82e19d-4575-0200-1a81-3eacf00cf872';
const PHANTOM = 'ee8e8d15-496b-07ac-e5f6-8fae5d4c7b1a';
const W = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
// Skins: Standard Vandal (everyone), Prime Vandal (owned, 2 levels, 2 chromas), Reaver Vandal (not owned).
const CONTENT = valorant.trimContent({
    version: 'release-09.08-shipping-1-123',
    weapons: [
        { uuid: VANDAL, displayName: 'Vandal', category: 'EEquippableCategory::Rifle', skins: [
            { uuid: W(1), displayName: 'Standard Vandal', themeUuid: '5a629df4-4765-0214-bd40-fbb96542941f', levels: [{ uuid: W(11) }], chromas: [{ uuid: W(21) }] },
            { uuid: W(2), displayName: 'Prime Vandal', levels: [{ uuid: W(12) }, { uuid: W(13) }], chromas: [{ uuid: W(22) }, { uuid: W(23) }, { uuid: W(24) }] },
            { uuid: W(3), displayName: 'Reaver Vandal', levels: [{ uuid: W(14) }], chromas: [{ uuid: W(25) }] },
            { uuid: W(4), displayName: 'Random Favorite Skin', levels: [], chromas: [] },
        ] },
        { uuid: PHANTOM, displayName: 'Phantom', category: 'EEquippableCategory::Rifle', skins: [
            { uuid: W(5), displayName: 'Standard Phantom', themeUuid: '5a629df4-4765-0214-bd40-fbb96542941f', levels: [{ uuid: W(15) }], chromas: [{ uuid: W(26) }] },
        ] },
    ],
    tiers: [{ tiers: [{ tier: 0, tierName: 'UNRATED' }, { tier: 15, tierName: 'PLATINUM 1', smallIcon: 'https://media/15.png' }] }],
    agents: [{ uuid: 'add6443a-41bd-e414-f6ad-e58d267f4e95', displayName: 'Jett', displayIcon: 'https://media/jett.png' }],
    maps: [{ uuid: 'm1', mapUrl: '/Game/Maps/Ascent/Ascent', displayName: 'Ascent' }],
});
valorant.setContentForTests(CONTENT);

const MMR = {
    LatestCompetitiveUpdate: { SeasonID: SEASON, TierAfterUpdate: 15, RankedRatingAfterUpdate: 42 },
    QueueSkills: { competitive: { SeasonalInfoBySeasonID: {
        [SEASON]: { NumberOfWinsWithPlacements: 9, NumberOfGames: 17, CompetitiveTier: 15, RankedRating: 42, WinsByTier: { 14: 3, 15: 6 } },
        [OLD_SEASON]: { NumberOfWinsWithPlacements: 20, NumberOfGames: 38, CompetitiveTier: 16, WinsByTier: { 16: 4, 17: 2 } },
    } } },
};
const MATCH = (id, won) => ({
    matchInfo: { matchId: id, mapId: '/Game/Maps/Ascent/Ascent', queueID: 'competitive', isRanked: true, gameStartMillis: 1700000000000, gameLengthMillis: 2100000 },
    players: [
        { subject: PUUID, teamId: 'Blue', characterId: 'ADD6443A-41BD-E414-F6AD-E58D267F4E95', competitiveTier: 15, stats: { kills: 21, deaths: 14, assists: 5, score: 6200 } },
        { subject: 'other', teamId: 'Red', characterId: 'x', stats: { kills: 1, deaths: 1, assists: 1 } },
    ],
    teams: [{ teamId: 'Blue', won, roundsWon: won ? 13 : 9 }, { teamId: 'Red', won: !won, roundsWon: won ? 9 : 13 }],
});
const VP = '85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741';
const STOREFRONT = {
    SkinsPanelLayout: {
        SingleItemOffers: [W(14)],
        SingleItemStoreOffers: [{ OfferID: W(14), Cost: { [VP]: 1775 }, Rewards: [{ ItemTypeID: 'e7c63390-eda7-46e0-bb7a-a6abdacd2433', ItemID: W(14), Quantity: 1 }] }],
        SingleItemOffersRemainingDurationInSeconds: 3600,
    },
    BonusStore: {
        BonusStoreOffers: [{ Offer: { Cost: { [VP]: 1775 }, Rewards: [{ ItemTypeID: 'e7c63390-eda7-46e0-bb7a-a6abdacd2433', ItemID: W(14) }] }, DiscountPercent: 34, DiscountCosts: { [VP]: 1171 } }],
        BonusStoreRemainingDurationInSeconds: 86400,
    },
};
const ENT = (ids) => ({ ItemTypeID: 'x', Entitlements: ids.map((id) => ({ TypeID: 'y', ItemID: id })) });
const LOADOUT = () => ({
    Subject: PUUID, Version: 5,
    Guns: [
        { ID: VANDAL, SkinID: W(1), SkinLevelID: W(11), ChromaID: W(21), Attachments: [] },
        { ID: PHANTOM, SkinID: W(5), SkinLevelID: W(15), ChromaID: W(26), Attachments: [] },
    ],
    Sprays: [{ EquipSlotID: 's', SprayID: 'spray' }],
    Identity: { PlayerCardID: 'card', PlayerTitleID: 'title' },
    Incognito: false,
});

const pdUrl = (p) => `https://pd.eu.a.pvp.net${p}`;
function serveValorant({ matches = [W(901), W(902)] } = {}) {
    routes.clear();
    requests.length = 0;
    routes.set(`GET ${pdUrl(`/mmr/v1/players/${PUUID}`)}`, MMR);
    routes.set(`GET ${pdUrl(`/match-history/v1/history/${PUUID}?startIndex=0&endIndex=10`)}`, { History: matches.map((m) => ({ MatchID: m })) });
    matches.forEach((m, i) => routes.set(`GET ${pdUrl(`/match-details/v1/matches/${m}`)}`, MATCH(m, i === 0)));
    routes.set(`GET ${pdUrl(`/store/v1/wallet/${PUUID}`)}`, { Balances: { [VP]: 2350, 'e59aa87c-4cbf-517a-5983-6e81511be9b7': 40 } });
    routes.set(`POST ${pdUrl(`/store/v3/storefront/${PUUID}`)}`, STOREFRONT);
    routes.set(`GET ${pdUrl(`/store/v1/entitlements/${PUUID}/e7c63390-eda7-46e0-bb7a-a6abdacd2433`)}`, ENT([W(12)]));
    routes.set(`GET ${pdUrl(`/store/v1/entitlements/${PUUID}/3ad1b2b2-acdb-4524-852f-954a76ddae0a`)}`, ENT([W(23)]));
    routes.set(`GET ${pdUrl(`/store/v1/entitlements/${PUUID}/01bb38e1-da47-4e6a-9b3d-945fe4655707`)}`, ENT(['add6443a-41bd-e414-f6ad-e58d267f4e95']));
    routes.set(`GET ${pdUrl(`/personalization/v3/players/${PUUID}/playerloadout`)}`, () => LOADOUT());
    routes.set(`PUT ${pdUrl(`/personalization/v3/players/${PUUID}/playerloadout`)}`, (cfg) => cfg.data);
}

// The Riot Client: signed in as `who`, Valorant running on the eu shard.
function signedInAs(who) {
    launch.riotClientUser = async () => (who ? { username: who, info: { username: who } } : null);
    launch.riotClientRequest = async (method, endpoint) => {
        if (!who) return null;
        if (endpoint === '/entitlements/v1/token') return { data: { accessToken: 'AT', token: 'ENT', subject: PUUID } };
        if (endpoint === '/product-session/v1/external-sessions') return { data: { v: { productId: 'valorant', launchConfiguration: { arguments: ['-ares-deployment=eu'] } } } };
        return null;
    };
}

function reset() {
    fs.rmSync(state.paths.valorant, { force: true });
    fx.writeAccounts([{ username: 'alice', password: 'x', region: 'euw', riotId: 'Alice#EUW' }, { username: 'bob', password: 'x', region: 'na', riotId: 'Bob#NA1' }]);
}

test('the rank: current tier and RR, this act, and the peak over every act', () => {
    assert.deepEqual(valorant.parseMmr(MMR), { tier: 15, rr: 42, wins: 9, games: 17, seasonId: SEASON, peakTier: 17 });
    assert.deepEqual(valorant.parseMmr({}), { tier: 0, rr: 0, wins: null, games: null, seasonId: null, peakTier: 0 });
    assert.equal(valorant.parseMmr(null), null);
    assert.equal(valorant.tierName(15), 'Platinum 1');
    assert.equal(valorant.tierName(27), 'Radiant');
    assert.equal(valorant.tierName(0), 'Unrated');
});

test('a match from the player\'s side: agent, score, rounds, result', () => {
    const m = valorant.parseMatch(MATCH(W(901), true), PUUID);
    assert.deepEqual(m, {
        id: W(901), mapId: '/Game/Maps/Ascent/Ascent', queue: 'competitive', ranked: true, start: 1700000000000, length: 2100000,
        agentId: 'ADD6443A-41BD-E414-F6AD-E58D267F4E95', kills: 21, deaths: 14, assists: 5, score: 6200,
        won: true, rounds: [13, 9], tier: 15, draw: false,
    });
    assert.equal(valorant.parseMatch(MATCH(W(901), true), 'someone-else'), null);
});

test('wallet, store with night market, owned items and loadout', () => {
    assert.deepEqual(valorant.parseWallet({ Balances: { [VP]: 2350 } }), { vp: 2350, rad: null, kc: null });
    const s = valorant.parseStorefront(STOREFRONT, 1000);
    assert.deepEqual(s.daily, [{ levelId: W(14), cost: 1775 }]);
    assert.equal(s.dailyEndsAt, 1000 + 3600 * 1000);
    assert.deepEqual(s.night, [{ levelId: W(14), cost: 1775, discounted: 1171, percent: 34 }]);
    // Without the night market and with only offer ids (older shape).
    const plain = valorant.parseStorefront({ SkinsPanelLayout: { SingleItemOffers: [W(12), 'bad'] } }, 0);
    assert.deepEqual(plain.daily, [{ levelId: W(12), cost: null }]);
    assert.deepEqual(plain.night, []);
    assert.deepEqual(valorant.parseOwned(ENT([W(1), W(1), 'x'])), [W(1)]);
    assert.equal(valorant.parseOwned({}), null);
    assert.deepEqual(valorant.parseLoadout(LOADOUT())[VANDAL], { skinId: W(1), levelId: W(11), chromaId: W(21) });
});

test('HenrikDev ranks in both of its shapes', () => {
    assert.deepEqual(valorant.parseHenrikMmr({ data: { current_data: { currenttier: 18, ranking_in_tier: 55 }, highest_rank: { tier: 21 } } }),
        { tier: 18, rr: 55, peakTier: 21, wins: null, games: null, seasonId: null });
    assert.deepEqual(valorant.parseHenrikMmr({ data: { current: { tier: { id: 12 }, rr: 7 }, peak: { tier: { id: 14 } } } }),
        { tier: 12, rr: 7, peakTier: 14, wins: null, games: null, seasonId: null });
    assert.equal(valorant.parseHenrikMmr({ data: {} }), null);
});

test('Standard skins show the weapon picture, not the catalogue placeholder', () => {
    const c = valorant.trimContent({ weapons: [{ uuid: VANDAL, displayName: 'Vandal', displayIcon: 'weapon.png', skins: [
        { uuid: W(1), displayName: 'Standard Vandal', displayIcon: 'placeholder.png', themeUuid: '5a629df4-4765-0214-bd40-fbb96542941f', levels: [], chromas: [] },
        { uuid: W(2), displayName: 'Prime Vandal', displayIcon: 'prime.png', levels: [], chromas: [] },
    ] }] });
    assert.deepEqual(c.weapons[0].skins.map((s) => s.icon), ['weapon.png', 'prime.png']);
});

test('a content cache in an older shape is not used (fetched again instead)', () => {
    const file = valorant.contentPath();
    fs.mkdirSync(require('path').dirname(file), { recursive: true });
    const fresh = valorant.trimContent({ weapons: [{ uuid: VANDAL, displayName: 'Vandal', skins: [] }] });
    try {
        fs.writeFileSync(file, JSON.stringify({ ...fresh, format: undefined }));
        valorant.setContentForTests(null);
        assert.equal(valorant.cachedContent().weapons.length, 0, 'old shape ignored');
        fs.writeFileSync(file, JSON.stringify(fresh));
        valorant.setContentForTests(null);
        assert.equal(valorant.cachedContent().weapons.length, 1, 'current shape used');
    } finally {
        fs.rmSync(file, { force: true });
        valorant.setContentForTests(CONTENT);
    }
});

test('League servers map to Valorant regions and shards', () => {
    assert.equal(valorant.regionFor('EUW'), 'eu');
    assert.equal(valorant.regionFor('las'), 'latam');
    assert.equal(valorant.SHARD_OF_REGION[valorant.regionFor('lan')], 'na');
    assert.equal(valorant.regionFor('oce'), 'ap');
    assert.equal(valorant.regionFor(''), 'eu');
});

test('capturing the signed-in account stores rank, matches, wallet, store and inventory', async () => {
    reset();
    serveValorant();
    signedInAs('Alice');
    assert.equal(await valorant.captureForAccount('alice'), true);
    const rec = valorant.getRecord('ALICE');
    assert.equal(rec.rank.tier, 15);
    assert.equal(rec.rank.source, 'client');
    assert.equal(rec.matches.length, 2);
    assert.equal(rec.wallet.vp, 2350);
    assert.equal(rec.store.daily[0].cost, 1775);
    assert.deepEqual(rec.owned.skinLevels, [W(12)]);
    assert.equal(rec.shard, 'eu');
    // Valorant's headers: tokens and the game version, never the vault.
    const h = requests[0].headers;
    assert.equal(h.Authorization, 'Bearer AT');
    assert.equal(h['X-Riot-Entitlements-JWT'], 'ENT');
    assert.equal(h['X-Riot-ClientVersion'], 'release-09.08-shipping-1-123');

    // A known match is not fetched again.
    requests.length = 0;
    await valorant.captureForAccount('alice');
    assert.ok(!requests.some((r) => r.key.includes('/match-details/')), 'stored matches are reused');
});

test('another signed-in account, or none, is never stored under this one', async () => {
    reset();
    serveValorant();
    signedInAs('bob');
    assert.equal(await valorant.captureForAccount('alice'), false);
    assert.equal(valorant.getRecord('alice'), null);
    signedInAs(null);
    assert.equal(await valorant.captureForAccount('alice'), false);
});

test('get-accounts carries the Valorant summary, deleting the account forgets it', async () => {
    reset();
    serveValorant();
    signedInAs('alice');
    await valorant.captureForAccount('alice');
    const list = await invoke('get-accounts');
    const alice = list.find((a) => a.username === 'alice');
    assert.equal(alice.valorant.tier, 15);
    assert.equal(alice.valorant.vp, 2350);
    assert.deepEqual(alice.valorant.names, ['Prime Vandal']);
    assert.equal(list.find((a) => a.username === 'bob').valorant, null);
    await invoke('delete-account', 'alice');
    assert.equal(valorant.getRecord('alice'), null);
});

test('the account view resolves names and pictures', async () => {
    reset();
    serveValorant();
    signedInAs('alice');
    await valorant.captureForAccount('alice');
    const res = await invoke('valorant-account', 'alice');
    assert.equal(res.success, true);
    assert.equal(res.view.rank.current.name, 'Platinum 1');
    assert.equal(res.view.rank.current.icon, 'https://media/15.png');
    assert.equal(res.view.matches[0].agent, 'Jett', 'agent ids match whatever their case');
    assert.equal(res.view.matches[0].map, 'Ascent');
    assert.equal(res.view.store.daily[0].name, 'Reaver Vandal');
    assert.equal(res.view.store.night[0].discounted, 1171);
    assert.deepEqual(res.view.owned.map((s) => s.name), ['Prime Vandal']);
});

test('the loadout offers owned skins only, and equip refuses what is not owned', async () => {
    reset();
    serveValorant();
    signedInAs('alice');
    const view = await invoke('valorant-loadout', 'alice');
    assert.equal(view.success, true);
    assert.equal(view.canEquip, true);
    const vandal = view.weapons.find((w) => w.id === VANDAL);
    assert.deepEqual(vandal.skins.map((s) => s.name), ['Standard Vandal', 'Prime Vandal']);
    const prime = vandal.skins[1];
    assert.deepEqual(prime.levels.map((l) => l.id), [W(12)], 'level 2 is not owned');
    assert.deepEqual(prime.chromas.map((c) => c.id), [W(22), W(23)], 'the base chroma and the bought one');

    const refused = await invoke('valorant-equip', { username: 'alice', guns: { [VANDAL]: { skinId: W(3) } } });
    assert.equal(refused.success, false);
    assert.match(refused.message, /not owned/);
    const wrongLevel = await invoke('valorant-equip', { username: 'alice', guns: { [VANDAL]: { skinId: W(2), levelId: W(13) } } });
    assert.equal(wrongLevel.success, false);
    assert.ok(!requests.some((r) => r.key.startsWith('PUT ')), 'nothing was sent');

    const ok = await invoke('valorant-equip', { username: 'alice', guns: { [VANDAL]: { skinId: W(2), chromaId: W(23) } } });
    assert.equal(ok.success, true);
    const put = requests.find((r) => r.key.startsWith('PUT '));
    const sent = put.data;
    const gun = sent.Guns.find((g) => g.ID === VANDAL);
    assert.deepEqual([gun.SkinID, gun.SkinLevelID, gun.ChromaID], [W(2), W(12), W(23)]);
    assert.deepEqual(sent.Sprays, LOADOUT().Sprays, 'the rest of the loadout goes back unchanged');
    assert.equal(sent.Guns.find((g) => g.ID === PHANTOM).SkinID, W(5));
});

test('equip only works for the account that is signed in', async () => {
    reset();
    serveValorant();
    signedInAs('alice');
    await valorant.captureForAccount('alice');
    signedInAs('bob');
    const res = await invoke('valorant-equip', { username: 'alice', guns: { [VANDAL]: { skinId: W(2) } } });
    assert.equal(res.success, false);
    assert.match(res.message, /Sign in to this account/);
});

test('saved sets: named, one per agent, only real skin ids', async () => {
    reset();
    const agent = 'add6443a-41bd-e414-f6ad-e58d267f4e95';
    const a = await invoke('valorant-save-set', { username: 'alice', set: { name: 'Prime', agentId: agent, guns: { [VANDAL]: { skinId: W(2) }, bogus: { skinId: 'x' } } } });
    assert.equal(a.success, true);
    assert.deepEqual(Object.keys(a.sets[0].guns), [VANDAL]);
    const b = await invoke('valorant-save-set', { username: 'alice', set: { name: 'Plain', agentId: agent, guns: { [VANDAL]: { skinId: W(1) } } } });
    assert.equal(b.sets.find((s) => s.name === 'Prime').agentId, null, 'the agent moved to the newer set');
    assert.equal((await invoke('valorant-save-set', { username: 'alice', set: { name: '', guns: {} } })).success, false);
    const id = b.sets[0].id;
    const c = await invoke('valorant-delete-set', { username: 'alice', id });
    assert.equal(c.sets.length, 1);
});

test('refresh: from the client when signed in, else HenrikDev with a key, else a hint', async () => {
    reset();
    serveValorant();
    signedInAs('bob');
    const hint = await invoke('valorant-refresh', 'alice');
    assert.equal(hint.success, false);
    assert.match(hint.message, /Play this account with Valorant selected/);

    const secrets = require('../src/main/services/secrets');
    const restore = secrets.hasHenrikKey;
    const restoreGet = secrets.getHenrikKey;
    secrets.hasHenrikKey = () => true;
    secrets.getHenrikKey = () => 'HDEV-test';
    routes.set('GET https://api.henrikdev.xyz/valorant/v2/mmr/eu/Alice/EUW', { data: { current_data: { currenttier: 18, ranking_in_tier: 10 }, highest_rank: { tier: 19 } } });
    const res = await invoke('valorant-refresh', 'alice');
    secrets.hasHenrikKey = restore;
    secrets.getHenrikKey = restoreGet;
    assert.equal(res.success, true);
    assert.equal(res.source, 'henrik');
    assert.equal(valorant.getRecord('alice').rank.source, 'henrik');
    assert.equal(requests.find((r) => r.key.includes('henrikdev')).headers.Authorization, 'HDEV-test');
});

test('the HenrikDev key is checked, encrypted and never sent to the renderer', async () => {
    const { fakeElectron } = require('./helpers/fake-electron');
    fakeElectron.safeStorage = {
        isEncryptionAvailable: () => true,
        encryptString: (s) => Buffer.from('DPAPI:' + Buffer.from(s).toString('hex')),
        decryptString: (b) => Buffer.from(b.toString().slice(6), 'hex').toString(),
    };
    require('../src/main/ipc/config').register();
    assert.equal((await invoke('set-henrik-key', 'nope')).success, false);
    const ok = await invoke('set-henrik-key', 'HDEV-01234567-89ab-cdef-0123-456789abcdef');
    assert.equal(ok.success, true);
    assert.doesNotMatch(state.config.henrikKeyEnc, /HDEV-/);
    const pub = await invoke('get-config');
    assert.equal(pub.henrikKeySet, true);
    assert.equal(pub.henrikKeyEnc, undefined);
    await invoke('set-henrik-key', '');
    assert.equal((await invoke('get-config')).henrikKeySet, false);
});

test('the game switch is a config key with two values', async () => {
    require('../src/main/ipc/config').register();
    assert.equal((await invoke('set-config', { game: 'valorant' })).success, true);
    assert.equal(state.config.game, 'valorant');
    assert.equal((await invoke('set-config', { game: 'tft' })).success, false);
    await invoke('set-config', { game: 'lol' });
});

test('the Valorant panel keeps its flex layout (and gaps) when shown', () => {
    const css = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'renderer', 'css', 'accounts.css'), 'utf8');
    const shown = /body\[data-game="valorant"\] \.val-only \{ display: (\w+)/.exec(css);
    const panel = /\.val-panel \{ display: (\w+)/.exec(css);
    assert.ok(shown && panel, 'both rules exist');
    assert.equal(shown[1], panel[1]);
});
