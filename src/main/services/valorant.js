const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('./http');
const state = require('../state');
const { loadJson, saveJson } = require('./json-store');

// Valorant for the saved Riot accounts. The account is the same Riot account
// League uses; the Riot Client signs it in. While the Riot Client is signed
// in with an account, its local API hands out that account's tokens, and
// Valorant's own servers (pd.<shard>.a.pvp.net, as the game uses them) answer
// for it: rank, recent matches, wallet, today's store, owned items and the
// loadout. What was read is kept per account (valorant.json, keyed by
// lower-cased username) and shown until the next sign-in, as Blue Essence is.
//
// Names and pictures of skins, agents, maps and ranks come from
// valorant-api.com (public, no key), cached in valorant-content.json.
//
// HenrikDev's community API (key in safeStorage, see secrets.js) is the
// fallback for the rank of an account that is not signed in.

const CLIENT_PLATFORM = Buffer.from(JSON.stringify({
    platformType: 'PC', platformOS: 'Windows', platformOSVersion: '10.0.19042.1.256.64bit', platformChipset: 'Unknown',
})).toString('base64');

// Entitlement item types (store/v1/entitlements/<puuid>/<type>).
const ITEM_TYPES = {
    skinLevel: 'e7c63390-eda7-46e0-bb7a-a6abdacd2433',
    chroma: '3ad1b2b2-acdb-4524-852f-954a76ddae0a',
    agent: '01bb38e1-da47-4e6a-9b3d-945fe4655707',
};
const CURRENCIES = {
    vp: '85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741',
    rad: 'e59aa87c-4cbf-517a-5983-6e81511be9b7',
    kc: '85ca954a-41f2-ce94-9b45-8ca3dd39a00d',
};
// The "Standard" skins every player owns.
const STANDARD_THEME = '5a629df4-4765-0214-bd40-fbb96542941f';

// League server of the saved account -> Valorant region (glz, HenrikDev) and
// shard (pd). Only a first guess: Valorant keeps its own region per account,
// so the shard the game itself reports wins (see resolveShard).
const REGIONS = {
    euw: 'eu', eune: 'eu', tr: 'eu', ru: 'eu', me: 'eu',
    na: 'na', br: 'br', lan: 'latam', las: 'latam',
    kr: 'kr',
    jp: 'ap', oce: 'ap', sg: 'ap', ph: 'ap', th: 'ap', tw: 'ap', vn: 'ap',
};
const SHARD_OF_REGION = { eu: 'eu', na: 'na', br: 'na', latam: 'na', kr: 'kr', ap: 'ap' };
const SHARDS = ['eu', 'na', 'ap', 'kr'];

const TIER_NAMES = ['Unrated', 'Unused 1', 'Unused 2',
    'Iron 1', 'Iron 2', 'Iron 3', 'Bronze 1', 'Bronze 2', 'Bronze 3', 'Silver 1', 'Silver 2', 'Silver 3',
    'Gold 1', 'Gold 2', 'Gold 3', 'Platinum 1', 'Platinum 2', 'Platinum 3', 'Diamond 1', 'Diamond 2', 'Diamond 3',
    'Ascendant 1', 'Ascendant 2', 'Ascendant 3', 'Immortal 1', 'Immortal 2', 'Immortal 3', 'Radiant'];

const MATCHES_KEPT = 10;
const CONTENT_MAX_AGE_MS = 24 * 3600 * 1000;
// Bumped when trimContent() changes, so a cache in the old shape is fetched again.
const CONTENT_FORMAT = 2;

function userKey(username) {
    return typeof username === 'string' ? username.toLowerCase() : '';
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isCount = (v) => isNum(v) && v >= 0;
const isUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

function regionFor(appRegion) {
    return REGIONS[String(appRegion || '').toLowerCase()] || 'eu';
}

function tierName(tier) {
    return TIER_NAMES[tier] || (isNum(tier) && tier > 27 ? 'Radiant' : 'Unrated');
}

// ── Parsers (shapes as Valorant's servers send them) ────────────────────────

// mmr/v1/players/<puuid>: the current rank (latest competitive update), this
// act's games, and the peak tier over every act.
function parseMmr(mmr) {
    if (!mmr || typeof mmr !== 'object') return null;
    const latest = mmr.LatestCompetitiveUpdate || {};
    const seasons = mmr.QueueSkills?.competitive?.SeasonalInfoBySeasonID || {};
    const seasonId = latest.SeasonID || null;
    const season = (seasonId && seasons[seasonId]) || null;
    let tier = isNum(latest.TierAfterUpdate) ? latest.TierAfterUpdate : null;
    let rr = isNum(latest.RankedRatingAfterUpdate) ? latest.RankedRatingAfterUpdate : null;
    if (season && isNum(season.CompetitiveTier) && tier === null) tier = season.CompetitiveTier;
    if (season && isNum(season.RankedRating) && rr === null) rr = season.RankedRating;
    let peak = 0;
    for (const s of Object.values(seasons)) {
        for (const t of Object.keys(s?.WinsByTier || {})) peak = Math.max(peak, Number(t) || 0);
        if (isNum(s?.CompetitiveTier)) peak = Math.max(peak, s.CompetitiveTier);
    }
    return {
        tier: tier || 0,
        rr: rr || 0,
        wins: isCount(season?.NumberOfWinsWithPlacements) ? season.NumberOfWinsWithPlacements : (isCount(season?.NumberOfWins) ? season.NumberOfWins : null),
        games: isCount(season?.NumberOfGames) ? season.NumberOfGames : null,
        seasonId,
        peakTier: Math.max(peak, tier || 0),
    };
}

// match-details/v1/matches/<id>, from one player's side.
function parseMatch(detail, puuid) {
    const info = detail?.matchInfo;
    const players = Array.isArray(detail?.players) ? detail.players : [];
    const me = players.find((p) => p?.subject === puuid);
    if (!info?.matchId || !me) return null;
    const teams = Array.isArray(detail.teams) ? detail.teams : [];
    const mine = teams.find((t) => t?.teamId === me.teamId);
    const theirs = teams.find((t) => t?.teamId !== me.teamId);
    const s = me.stats || {};
    return {
        id: info.matchId,
        mapId: typeof info.mapId === 'string' ? info.mapId : '',
        queue: typeof info.queueID === 'string' ? info.queueID : (typeof info.queueId === 'string' ? info.queueId : ''),
        ranked: !!info.isRanked,
        start: isNum(info.gameStartMillis) ? info.gameStartMillis : null,
        length: isNum(info.gameLengthMillis) ? info.gameLengthMillis : null,
        agentId: typeof me.characterId === 'string' ? me.characterId : '',
        kills: s.kills || 0, deaths: s.deaths || 0, assists: s.assists || 0, score: s.score || 0,
        won: mine ? !!mine.won : null,
        rounds: mine && theirs ? [mine.roundsWon || 0, theirs.roundsWon || 0] : null,
        tier: isNum(me.competitiveTier) ? me.competitiveTier : 0,
        // A draw (both sides lost the last round count) shows as such.
        draw: mine && theirs ? !mine.won && !theirs.won : false,
    };
}

function parseWallet(wallet) {
    const b = wallet?.Balances;
    if (!b || typeof b !== 'object') return null;
    const pick = (id) => (isCount(b[id]) ? b[id] : null);
    return { vp: pick(CURRENCIES.vp), rad: pick(CURRENCIES.rad), kc: pick(CURRENCIES.kc) };
}

const costOf = (cost) => (cost && isCount(cost[CURRENCIES.vp]) ? cost[CURRENCIES.vp] : null);
const skinLevelOf = (rewards) => (Array.isArray(rewards) ? rewards.find((r) => r?.ItemTypeID === ITEM_TYPES.skinLevel)?.ItemID : null) || null;

// store/v2|v3/storefront/<puuid>: today's four skins and, while it runs, the
// night market. Times are when each one changes (ms).
function parseStorefront(front, now = Date.now()) {
    if (!front || typeof front !== 'object') return null;
    const panel = front.SkinsPanelLayout || {};
    const offers = Array.isArray(panel.SingleItemStoreOffers) ? panel.SingleItemStoreOffers : [];
    let daily = offers.map((o) => ({ levelId: skinLevelOf(o?.Rewards) || o?.OfferID, cost: costOf(o?.Cost) })).filter((o) => isUuid(o.levelId));
    if (!daily.length && Array.isArray(panel.SingleItemOffers)) daily = panel.SingleItemOffers.filter(isUuid).map((id) => ({ levelId: id, cost: null }));
    const secs = (v) => (isCount(v) ? now + v * 1000 : null);
    const bonus = front.BonusStore;
    const night = Array.isArray(bonus?.BonusStoreOffers) ? bonus.BonusStoreOffers.map((b) => ({
        levelId: skinLevelOf(b?.Offer?.Rewards),
        cost: costOf(b?.Offer?.Cost),
        discounted: costOf(b?.DiscountCosts),
        percent: isCount(b?.DiscountPercent) ? b.DiscountPercent : null,
    })).filter((o) => isUuid(o.levelId)) : [];
    return {
        daily,
        dailyEndsAt: secs(panel.SingleItemOffersRemainingDurationInSeconds),
        night,
        nightEndsAt: night.length ? secs(bonus.BonusStoreRemainingDurationInSeconds) : null,
    };
}

// store/v1/entitlements/<puuid>/<type>: the owned item ids.
function parseOwned(ent) {
    const list = Array.isArray(ent?.Entitlements) ? ent.Entitlements : null;
    if (!list) return null;
    return [...new Set(list.map((e) => e?.ItemID).filter(isUuid))];
}

// personalization/v2/players/<puuid>/playerloadout: the gun skins, by weapon.
function parseLoadout(loadout) {
    const guns = Array.isArray(loadout?.Guns) ? loadout.Guns : null;
    if (!guns) return null;
    const out = {};
    for (const g of guns) {
        if (isUuid(g?.ID)) out[g.ID] = { skinId: g.SkinID || null, levelId: g.SkinLevelID || null, chromaId: g.ChromaID || null };
    }
    return out;
}

// HenrikDev mmr, v2 (current_data) or v3 (current) shapes.
function parseHenrikMmr(res) {
    const d = res?.data;
    if (!d || typeof d !== 'object') return null;
    if (d.current_data || d.highest_rank) {
        const c = d.current_data || {};
        return {
            tier: isNum(c.currenttier) ? c.currenttier : 0,
            rr: isNum(c.ranking_in_tier) ? c.ranking_in_tier : 0,
            peakTier: isNum(d.highest_rank?.tier) ? d.highest_rank.tier : (isNum(c.currenttier) ? c.currenttier : 0),
            wins: null, games: null, seasonId: null,
        };
    }
    if (d.current || d.peak) {
        const tier = d.current?.tier?.id;
        return {
            tier: isNum(tier) ? tier : 0,
            rr: isNum(d.current?.rr) ? d.current.rr : 0,
            peakTier: isNum(d.peak?.tier?.id) ? d.peak.tier.id : (isNum(tier) ? tier : 0),
            wins: null, games: null, seasonId: null,
        };
    }
    return null;
}

// ── Store ───────────────────────────────────────────────────────────────────

function loadStore() {
    return loadJson(state.paths.valorant, {}, 'valorant', (v) => v !== null && typeof v === 'object' && !Array.isArray(v));
}

function saveStore(data) {
    try {
        saveJson(state.paths.valorant, data, 'valorant');
    } catch { /* logged by saveJson already */ }
}

function getRecordMap() {
    return loadStore();
}

function getRecord(username) {
    return loadStore()[userKey(username)] || null;
}

function updateRecord(username, fn) {
    const key = userKey(username);
    if (!key) return null;
    const data = loadStore();
    const next = fn({ ...(data[key] || {}) });
    data[key] = next;
    saveStore(data);
    return next;
}

function forgetAccount(username) {
    const data = loadStore();
    const key = userKey(username);
    if (!(key in data)) return;
    delete data[key];
    saveStore(data);
}

// ── Content (valorant-api.com) ──────────────────────────────────────────────

let content = null;      // trimmed catalogue, see trimContent()
let contentLoading = null;

const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o?.[k] ?? null]));

function trimContent(raw) {
    const weapons = (raw.weapons || []).map((w) => ({
        id: w.uuid, name: w.displayName, category: String(w.category || '').replace('EEquippableCategory::', ''), icon: w.displayIcon || null,
        skins: (w.skins || []).filter((s) => s?.uuid && !/^Random Favorite/i.test(s.displayName || '')).map((s) => ({
            id: s.uuid, name: s.displayName,
            // Standard skins have a placeholder picture; the weapon's own looks right.
            icon: (s.themeUuid === STANDARD_THEME ? w.displayIcon : null) || s.displayIcon || s.levels?.[0]?.displayIcon || s.chromas?.[0]?.fullRender || w.displayIcon || null,
            theme: s.themeUuid || null, tier: s.contentTierUuid || null,
            levels: (s.levels || []).map((l) => ({ id: l.uuid, name: l.displayName, item: l.levelItem ? String(l.levelItem).replace('EEquippableSkinLevelItem::', '') : null })),
            chromas: (s.chromas || []).map((c) => ({ id: c.uuid, name: c.displayName, icon: c.displayIcon || c.fullRender || null, swatch: c.swatch || null })),
        })),
    }));
    const tiers = raw.tiers?.length ? raw.tiers[raw.tiers.length - 1] : null;
    return {
        format: CONTENT_FORMAT,
        version: raw.version || null,
        fetchedAt: raw.fetchedAt || Date.now(),
        weapons,
        tiers: tiers ? (tiers.tiers || []).map((t) => ({ tier: t.tier, name: t.tierName, icon: t.smallIcon || t.largeIcon || null })) : [],
        agents: (raw.agents || []).map((a) => ({ id: a.uuid, name: a.displayName, icon: a.displayIcon || null, role: a.role?.displayName || null })),
        maps: (raw.maps || []).map((m) => ({ id: m.uuid, path: m.mapUrl || null, name: m.displayName, icon: m.listViewIcon || null })),
        contentTiers: (raw.contentTiers || []).map((t) => pick({ id: t.uuid, name: t.devName || t.displayName, icon: t.displayIcon, rank: t.rank }, ['id', 'name', 'icon', 'rank'])),
        currencies: (raw.currencies || []).map((c) => ({ id: c.uuid, name: c.displayName, icon: c.displayIcon || c.largeIcon || null })),
    };
}

// A cache file is used only in the current shape.
function readCache() {
    try {
        const cached = JSON.parse(fs.readFileSync(contentPath(), 'utf8'));
        if (cached && Array.isArray(cached.weapons) && cached.format === CONTENT_FORMAT) return cached;
    } catch { /* no cache yet */ }
    return null;
}

function contentPath() {
    return path.join(path.dirname(state.paths.valorant), 'valorant-content.json');
}

async function fetchContent() {
    const get = async (p) => (await http.get(`https://valorant-api.com/v1/${p}`, { timeout: 20000 })).data?.data;
    const [version, weapons, tiers, agents, maps, contentTiers, currencies] = await Promise.all([
        get('version'), get('weapons'), get('competitivetiers'), get('agents?isPlayableCharacter=true'), get('maps'), get('contenttiers'), get('currencies'),
    ]);
    return trimContent({ version: version?.riotClientVersion || null, weapons, tiers, agents, maps, contentTiers, currencies, fetchedAt: Date.now() });
}

// The catalogue, from memory, the cache file, or valorant-api.com (then
// cached). A failed download keeps an older cache; with none, the catalogue
// is empty and the app shows ids and plain names.
async function getContent({ refresh = false } = {}) {
    if (content && !refresh && Date.now() - content.fetchedAt < CONTENT_MAX_AGE_MS) return content;
    if (!content) {
        content = readCache();
        if (content && !refresh && Date.now() - content.fetchedAt < CONTENT_MAX_AGE_MS) return content;
    }
    if (!contentLoading) {
        contentLoading = fetchContent()
            .then((c) => {
                content = c;
                try { fs.writeFileSync(contentPath(), JSON.stringify(c)); } catch (e) { console.warn('[Valorant] Content cache not written:', e.message); }
                return c;
            })
            .catch((e) => {
                console.warn('[Valorant] Content download failed:', e.message);
                return content || trimContent({});
            })
            .finally(() => { contentLoading = null; });
    }
    return contentLoading;
}

function setContentForTests(c) {
    content = c;
}

// The catalogue if it is loaded or cached on disk, without downloading (the
// account list must not wait for the network). Starts a download if stale.
function cachedContent() {
    if (!content) content = readCache();
    if (!content || Date.now() - content.fetchedAt >= CONTENT_MAX_AGE_MS) getContent().catch(() => {});
    return content || trimContent({});
}

// Lookup tables over the catalogue (skin level / chroma / skin id -> skin).
function indexContent(c) {
    const bySkin = new Map(), byLevel = new Map(), byChroma = new Map();
    for (const w of c?.weapons || []) {
        for (const s of w.skins || []) {
            const entry = { weapon: w, skin: s };
            bySkin.set(s.id, entry);
            for (const l of s.levels || []) byLevel.set(l.id, entry);
            for (const ch of s.chromas || []) byChroma.set(ch.id, entry);
        }
    }
    return { bySkin, byLevel, byChroma };
}

// ── Talking to the Riot Client and Valorant's servers ───────────────────────

function launchModule() {
    return require('../ipc/launch');
}

// The signed-in account's tokens: { accessToken, entitlement, puuid } or null.
async function localTokens() {
    try {
        const res = await launchModule().riotClientRequest('GET', '/entitlements/v1/token');
        const t = res?.data;
        if (!t?.accessToken || !t?.token || !t?.subject) return null;
        return { accessToken: t.accessToken, entitlement: t.token, puuid: t.subject };
    } catch {
        return null;
    }
}

// "-ares-deployment=eu" in the running game's launch arguments, or null.
async function shardFromSession() {
    try {
        const sessions = (await launchModule().riotClientRequest('GET', '/product-session/v1/external-sessions'))?.data;
        for (const s of Object.values(sessions || {})) {
            if (s?.productId !== 'valorant') continue;
            for (const arg of s.launchConfiguration?.arguments || []) {
                const m = /^-ares-deployment=(\w+)$/.exec(String(arg));
                if (m && SHARDS.includes(m[1])) return m[1];
            }
        }
    } catch { /* no session */ }
    return null;
}

let clientVersion = null;
// The game version Valorant's servers expect in X-Riot-ClientVersion: from
// the content catalogue, else from the game's own log.
async function getClientVersion() {
    if (clientVersion) return clientVersion;
    const c = await getContent().catch(() => null);
    if (c?.version) return (clientVersion = c.version);
    try {
        const log = fs.readFileSync(path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'VALORANT', 'Saved', 'Logs', 'ShooterGame.log'), 'utf8');
        const m = /CI server version: (\S+)/.exec(log);
        if (m) {
            const p = m[1].split('-');
            clientVersion = p.length >= 4 ? `${p[0]}-${p[1]}-shipping-${p.slice(2).join('-')}` : m[1];
        }
    } catch { /* not installed here */ }
    return clientVersion;
}

function headers(tokens, version) {
    return {
        Authorization: `Bearer ${tokens.accessToken}`,
        'X-Riot-Entitlements-JWT': tokens.entitlement,
        'X-Riot-ClientPlatform': CLIENT_PLATFORM,
        ...(version ? { 'X-Riot-ClientVersion': version } : {}),
    };
}

// One request to pd.<shard>.a.pvp.net. Returns the body, or null on 404.
async function pd(ctx, method, endpoint, body) {
    try {
        const res = await http({ method, url: `https://pd.${ctx.shard}.a.pvp.net${endpoint}`, headers: headers(ctx.tokens, ctx.version), data: body, timeout: 10000 });
        return res.data;
    } catch (e) {
        if (e.response?.status === 404) return null;
        throw e;
    }
}

async function glz(ctx, endpoint) {
    try {
        const res = await http.get(`https://glz-${ctx.region}-1.${ctx.shard}.a.pvp.net${endpoint}`, { headers: headers(ctx.tokens, ctx.version), timeout: 5000 });
        return res.data;
    } catch (e) {
        if (e.response?.status === 404) return null;
        throw e;
    }
}

// Which account is signed into the Riot Client, with what it needs to ask
// Valorant's servers: { username, tokens, shard, region, version } or null.
async function signedInContext() {
    const user = await launchModule().riotClientUser();
    if (!user?.username) return null;
    const tokens = await localTokens();
    if (!tokens) return null;
    const accounts = require('./storage').loadAccounts();
    const acc = accounts.find((a) => userKey(a.username) === userKey(user.username));
    const rec = acc ? getRecord(acc.username) : null;
    const affinity = user.info?.affinity?.pp || user.info?.affinity?.live;
    const shard = await shardFromSession()
        || (SHARDS.includes(affinity) ? affinity : null)
        || rec?.shard
        || SHARD_OF_REGION[regionFor(acc?.region)];
    const region = rec?.region || (shard === 'eu' || shard === 'kr' || shard === 'ap' ? shard : regionFor(acc?.region));
    return { username: acc?.username || user.username, saved: !!acc, tokens, shard, region, version: await getClientVersion() };
}

// Reads everything for the account signed into the Riot Client, if it is a
// saved one and the expected one. Returns true when something was stored.
async function captureForAccount(username) {
    const ctx = await signedInContext();
    if (!ctx || !ctx.saved || userKey(ctx.username) !== userKey(username)) return false;
    return captureWith(ctx);
}

async function captureWith(ctx) {
    const { puuid } = ctx.tokens;
    let mmr = await pd(ctx, 'GET', `/mmr/v1/players/${puuid}`).catch(() => null);
    // The first guess of the shard can be wrong (Valorant keeps its own
    // region per account): a 404 there tries the other shards once.
    if (!mmr) {
        for (const s of SHARDS.filter((x) => x !== ctx.shard)) {
            const r = await pd({ ...ctx, shard: s }, 'GET', `/mmr/v1/players/${puuid}`).catch(() => null);
            if (r) { ctx.shard = s; mmr = r; break; }
        }
    }
    const [history, wallet, front, skins, chromas, agents, loadout] = await Promise.all([
        pd(ctx, 'GET', `/match-history/v1/history/${puuid}?startIndex=0&endIndex=${MATCHES_KEPT}`).catch(() => null),
        pd(ctx, 'GET', `/store/v1/wallet/${puuid}`).catch(() => null),
        pd(ctx, 'POST', `/store/v3/storefront/${puuid}`, {}).catch(() => pd(ctx, 'GET', `/store/v2/storefront/${puuid}`).catch(() => null)),
        pd(ctx, 'GET', `/store/v1/entitlements/${puuid}/${ITEM_TYPES.skinLevel}`).catch(() => null),
        pd(ctx, 'GET', `/store/v1/entitlements/${puuid}/${ITEM_TYPES.chroma}`).catch(() => null),
        pd(ctx, 'GET', `/store/v1/entitlements/${puuid}/${ITEM_TYPES.agent}`).catch(() => null),
        pd(ctx, 'GET', `/personalization/v3/players/${puuid}/playerloadout`).catch(() => null),
    ]);
    const old = getRecord(ctx.username) || {};
    const known = new Map((old.matches || []).map((m) => [m.id, m]));
    const ids = (Array.isArray(history?.History) ? history.History : []).map((h) => h?.MatchID).filter(isUuid).slice(0, MATCHES_KEPT);
    const matches = [];
    for (const id of ids) {
        if (known.has(id)) { matches.push(known.get(id)); continue; }
        const m = parseMatch(await pd(ctx, 'GET', `/match-details/v1/matches/${id}`).catch(() => null), puuid);
        if (m) matches.push(m);
    }
    const now = Date.now();
    const rank = parseMmr(mmr);
    const parsed = {
        rank: rank ? { ...rank, source: 'client', checkedAt: now } : null,
        wallet: (() => { const w = parseWallet(wallet); return w ? { ...w, checkedAt: now } : null; })(),
        store: (() => { const s = parseStorefront(front, now); return s ? { ...s, checkedAt: now } : null; })(),
        owned: (() => {
            const s = parseOwned(skins), c = parseOwned(chromas), a = parseOwned(agents);
            return s || c || a ? { skinLevels: s || old.owned?.skinLevels || [], chromas: c || old.owned?.chromas || [], agents: a || old.owned?.agents || [], checkedAt: now } : null;
        })(),
        loadout: parseLoadout(loadout),
        matches: matches.length ? matches : null,
    };
    if (!Object.values(parsed).some(Boolean)) return false;
    updateRecord(ctx.username, (rec) => {
        for (const [k, v] of Object.entries(parsed)) if (v) rec[k] = v;
        rec.puuid = puuid;
        rec.shard = ctx.shard;
        rec.region = ctx.region;
        rec.checkedAt = now;
        return rec;
    });
    return true;
}

// The rank from HenrikDev's API for an account that is not signed in.
async function henrikRank(account) {
    const key = require('./secrets').getHenrikKey();
    const [name, tag] = String(account?.riotId || '').split('#');
    if (!key || !name || !tag) return null;
    const rec = getRecord(account.username);
    const region = rec?.region || regionFor(account.region);
    const res = await http.get(`https://api.henrikdev.xyz/valorant/v2/mmr/${region}/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`, {
        headers: { Authorization: key }, timeout: 10000,
    });
    const rank = parseHenrikMmr(res.data);
    if (!rank) return null;
    updateRecord(account.username, (r) => ({ ...r, rank: { ...rank, source: 'henrik', checkedAt: Date.now() } }));
    return rank;
}

// ── Loadout ─────────────────────────────────────────────────────────────────

// Whether the account owns a skin (its first level), a level and a chroma.
// Standard skins and each skin's first chroma come with the skin.
function ownership(rec, c) {
    const levels = new Set(rec?.owned?.skinLevels || []);
    const chromas = new Set(rec?.owned?.chromas || []);
    const skinOwned = (skin) => skin.theme === STANDARD_THEME || /^Standard /.test(skin.name || '') || levels.has(skin.levels?.[0]?.id);
    return {
        skinOwned,
        levelOwned: (skin, levelId) => skinOwned(skin) && (skin.levels?.[0]?.id === levelId || levels.has(levelId)),
        chromaOwned: (skin, chromaId) => skinOwned(skin) && (skin.chromas?.[0]?.id === chromaId || chromas.has(chromaId)),
    };
}

// Every weapon with its equipped skin and the owned choices.
function loadoutView(rec, c) {
    const own = ownership(rec, c);
    const current = rec?.loadout || {};
    return (c?.weapons || []).map((w) => ({
        id: w.id, name: w.name, category: w.category, icon: w.icon,
        equipped: current[w.id] || null,
        skins: w.skins.filter((s) => own.skinOwned(s)).map((s) => ({
            id: s.id, name: s.name, icon: s.icon,
            levels: s.levels.filter((l) => own.levelOwned(s, l.id)).map((l) => ({ id: l.id, name: l.name })),
            chromas: s.chromas.filter((ch) => own.chromaOwned(s, ch.id)).map((ch) => ({ id: ch.id, name: ch.name, icon: ch.icon, swatch: ch.swatch })),
        })),
    }));
}

// The guns to equip, checked against what the account owns. Returns
// { guns } or { error }.
function checkGuns(rec, c, guns) {
    const { bySkin } = indexContent(c);
    const own = ownership(rec, c);
    const out = {};
    for (const [weaponId, g] of Object.entries(guns || {})) {
        const entry = bySkin.get(g?.skinId);
        if (!entry || entry.weapon.id !== weaponId) return { error: 'Unknown skin for this weapon' };
        const s = entry.skin;
        if (!own.skinOwned(s)) return { error: `${s.name} is not owned by this account` };
        const levelId = g.levelId || s.levels[0]?.id;
        const chromaId = g.chromaId || s.chromas[0]?.id;
        if (!own.levelOwned(s, levelId)) return { error: `That level of ${s.name} is not owned` };
        if (!own.chromaOwned(s, chromaId)) return { error: `That chroma of ${s.name} is not owned` };
        out[weaponId] = { skinId: s.id, levelId, chromaId };
    }
    return { guns: out };
}

// Equips guns on the signed-in account (only that one: the servers only
// take its own token). The rest of the loadout (sprays, card, title) is sent
// back unchanged.
async function equip(username, guns) {
    const ctx = await signedInContext();
    if (!ctx || userKey(ctx.username) !== userKey(username)) {
        return { success: false, message: 'Sign in to this account first: Play it with Valorant selected.' };
    }
    const c = await getContent();
    const rec = getRecord(username) || {};
    const checked = checkGuns(rec, c, guns);
    if (checked.error) return { success: false, message: checked.error };
    const { puuid } = ctx.tokens;
    const loadout = await pd(ctx, 'GET', `/personalization/v3/players/${puuid}/playerloadout`);
    if (!loadout || !Array.isArray(loadout.Guns)) return { success: false, message: 'Valorant did not send the loadout.' };
    for (const g of loadout.Guns) {
        const want = checked.guns[g?.ID];
        if (!want) continue;
        g.SkinID = want.skinId;
        g.SkinLevelID = want.levelId;
        g.ChromaID = want.chromaId;
    }
    const saved = await pd(ctx, 'PUT', `/personalization/v3/players/${puuid}/playerloadout`, loadout);
    const next = parseLoadout(saved) || parseLoadout(loadout);
    updateRecord(username, (r) => ({ ...r, loadout: next }));
    return { success: true, loadout: next };
}

// Saved sets: a name, an optional agent, and the guns.
function saveSet(username, { id, name, agentId = null, guns }) {
    const cleanName = String(name || '').trim().slice(0, 40);
    if (!cleanName) return { success: false, message: 'Give the set a name' };
    if (agentId !== null && !isUuid(agentId)) return { success: false, message: 'Unknown agent' };
    const g = {};
    for (const [w, v] of Object.entries(guns || {})) {
        if (isUuid(w) && isUuid(v?.skinId)) g[w] = { skinId: v.skinId, levelId: isUuid(v.levelId) ? v.levelId : null, chromaId: isUuid(v.chromaId) ? v.chromaId : null };
    }
    if (!Object.keys(g).length) return { success: false, message: 'The set has no skins' };
    const setId = isUuid(id) ? id : require('crypto').randomUUID();
    const rec = updateRecord(username, (r) => {
        const sets = (r.sets || []).filter((s) => s.id !== setId);
        // One set per agent: the agent moves to the new set.
        if (agentId) for (const s of sets) if (s.agentId === agentId) s.agentId = null;
        sets.push({ id: setId, name: cleanName, agentId, guns: g });
        return { ...r, sets: sets.slice(-30) };
    });
    return { success: true, sets: rec.sets };
}

function deleteSet(username, id) {
    const rec = updateRecord(username, (r) => ({ ...r, sets: (r.sets || []).filter((s) => s.id !== id) }));
    return { success: true, sets: rec.sets };
}

// ── Agent select: a set for the locked agent is equipped ───────────────────

let watchTimer = null;
let watchState = { matchId: null, applied: null };

async function pregameTick() {
    if (!state.config.valorantAutoSets) return;
    const ctx = await signedInContext().catch(() => null);
    if (!ctx?.saved) return;
    const { puuid } = ctx.tokens;
    const player = await glz(ctx, `/pregame/v1/players/${puuid}`).catch(() => null);
    const matchId = player?.MatchID;
    if (!matchId) { watchState = { matchId: null, applied: null }; return; }
    if (matchId !== watchState.matchId) watchState = { matchId, applied: null };
    const match = await glz(ctx, `/pregame/v1/matches/${matchId}`).catch(() => null);
    const me = (match?.AllyTeam?.Players || []).find((p) => p?.Subject === puuid);
    if (!me?.CharacterID || me.CharacterSelectionState !== 'locked' || watchState.applied === me.CharacterID) return;
    watchState.applied = me.CharacterID;
    const set = (getRecord(ctx.username)?.sets || []).find((s) => s.agentId === me.CharacterID);
    if (!set) return;
    const res = await equip(ctx.username, set.guns).catch((e) => ({ success: false, message: e.message }));
    console.log(`[Valorant] Set "${set.name}" for the locked agent:`, res.success ? 'equipped' : res.message);
}

function startAgentWatch() {
    if (watchTimer) return;
    watchTimer = setInterval(() => {
        launchModule().valorantRunning()
            .then((up) => (up ? pregameTick() : null))
            .catch(() => {});
    }, 3000);
    watchTimer.unref?.();
}

function stopAgentWatch() {
    if (watchTimer) clearInterval(watchTimer);
    watchTimer = null;
}

module.exports = {
    ITEM_TYPES, CURRENCIES, TIER_NAMES, REGIONS, SHARD_OF_REGION,
    regionFor, tierName,
    parseMmr, parseMatch, parseWallet, parseStorefront, parseOwned, parseLoadout, parseHenrikMmr,
    getRecord, getRecordMap, forgetAccount, updateRecord,
    getContent, cachedContent, setContentForTests, contentPath, trimContent, indexContent,
    signedInContext, captureForAccount, captureWith, henrikRank,
    loadoutView, checkGuns, equip, saveSet, deleteSet,
    pregameTick, startAgentWatch, stopAgentWatch,
};
