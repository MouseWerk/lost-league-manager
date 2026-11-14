const state = require('../state');
const { loadJson, saveJson } = require('./json-store');
const championData = require('./champion-data');
const itemData = require('./item-data');
const { getBuilds } = require('./builds-api');

// User-authored shopping plans, one per champion: "when I can afford 650g on
// Ahri, buy Boots + Dark Seal". build-reminder.js watches live gold in-game and
// pings once a step becomes affordable.
//
// On-disk shape (build-paths.json in userData):
//   { version: 1, paths: { "Ahri": { key: "Ahri", steps: [...] } } }
// A step: { items: [itemId, ...], gold: 650, autoGold: true }
//
// `autoGold` only drives the editor (keep the threshold in sync with the summed
// item cost as items are added/removed) — the reminder only ever reads `gold`.

const MAX_STEPS = 12;
const MAX_ITEMS_PER_STEP = 6;
const MAX_GOLD = 30000;

let cache = null;

function emptyStore() {
    return { version: 1, paths: {} };
}

// An earlier build of this feature also allowed plans on a champion class and
// keyed everything "<scope>:<key>". Classes are gone; carry the champion plans
// over to the flat key and drop the rest.
function migrate(paths) {
    const out = {};
    for (const [id, entry] of Object.entries(paths)) {
        if (id.startsWith('class:')) continue;
        const key = id.startsWith('champion:') ? id.slice('champion:'.length) : id;
        if (!entry?.steps?.length) continue;
        out[key] = { key, steps: entry.steps };
    }
    return out;
}

function load() {
    if (!cache) {
        const raw = loadJson(state.paths.buildPaths, null, 'build paths');
        cache = raw?.paths && typeof raw.paths === 'object'
            ? { version: 1, paths: migrate(raw.paths) }
            : emptyStore();
    }
    return cache;
}

function isKnownChampion(key) {
    return typeof key === 'string' && !!key && championData.getChampionIdByKey(key) !== null;
}

// Everything that lands on disk goes through here: the renderer is the only
// caller, but a step list with a negative threshold or a bogus item id would
// silently break the in-game reminder rather than fail loudly, so normalise
// first and drop what can't be salvaged.
function sanitizeSteps(steps) {
    if (!Array.isArray(steps)) return [];
    const out = [];
    for (const raw of steps.slice(0, MAX_STEPS)) {
        const ids = Array.isArray(raw?.items) ? raw.items : [];
        const items = [...new Set(
            ids.map(n => parseInt(n, 10)).filter(n => Number.isInteger(n) && n >= 1000 && n <= 99999)
        )].slice(0, MAX_ITEMS_PER_STEP);
        if (items.length === 0) continue;

        const autoGold = raw?.autoGold !== false;
        const summed   = items.reduce((sum, id) => sum + itemData.getItemCost(id), 0);
        let gold = Math.round(Number(raw?.gold));
        if (autoGold || !Number.isFinite(gold) || gold < 0) gold = summed;

        out.push({ items, gold: Math.min(gold, MAX_GOLD), autoGold });
    }
    return out;
}

function getAll() {
    return load().paths;
}

function getPath(champKey) {
    return load().paths[champKey] || null;
}

// Saving an empty step list deletes the plan — that's how the editor's "remove
// the last step" and "Delete plan" both end up here.
function setPath(champKey, steps) {
    if (!isKnownChampion(champKey)) {
        return { success: false, message: `Unknown champion: ${champKey}` };
    }
    const clean = sanitizeSteps(steps);
    const store = load();
    if (clean.length === 0) {
        delete store.paths[champKey];
    } else {
        store.paths[champKey] = { key: champKey, steps: clean };
    }
    try {
        saveJson(state.paths.buildPaths, store, 'build paths');
    } catch (e) {
        return { success: false, message: `Could not save build paths: ${e.message}` };
    }
    return { success: true, steps: clean };
}

function deletePath(champKey) {
    return setPath(champKey, []);
}

// Attaches the item metadata the reminder needs (name for the message, cost for
// the editor, ownership ids so an already-bought step is skipped) so callers
// don't have to reach into item-data themselves.
function decorateSteps(steps) {
    return steps.map(step => ({
        gold: step.gold,
        items: step.items.map(id => ({
            id,
            name: itemData.getItemMeta(id)?.name || `Item ${id}`,
            cost: itemData.getItemCost(id),
            ownershipIds: itemData.getOwnershipIds(id),
        })),
    }));
}

function resolveForChampion(champKey) {
    const plan = champKey ? load().paths[champKey] : null;
    if (!plan?.steps?.length) return null;
    return { champKey, steps: decorateSteps(plan.steps) };
}

// Rough price bands used to sanity-check what the scraper hands back. OP.GG's
// structured data isn't always available, and the HTML fallback in builds-api
// classifies items by id range — which happily files a 2800g legendary under
// "starting items". A first step that only fires at 3250g is worse than no
// first step, so anything priced outside its section's band is dropped.
const STARTER_MAX_COST = 500;
const BOOTS_COST_RANGE = [300, 1400];

// Seeds a plan from OP.GG's recommended build for the champion (and role), so a
// usable starting point is one click rather than a dozen item searches. Each
// core item becomes its own step, priced at its full cost — that's the gold you
// need in hand to walk out of the shop with it.
async function importFromOpgg(champKey, position) {
    if (!isKnownChampion(champKey)) {
        return { success: false, message: `Unknown champion: ${champKey}` };
    }

    const isAram = String(position || '').toUpperCase() === 'ARAM';
    const builds = await getBuilds(champKey, isAram ? 'ARAM' : 'CLASSIC', isAram ? null : position || null);
    if (!builds) {
        const role = position && !isAram ? ` (${position.toLowerCase()})` : '';
        return { success: false, message: `OP.GG had no build for ${champKey}${role}` };
    }

    // Trinkets and other unbuyables come back priced at 0; an item already
    // placed earlier shouldn't get a second step of its own.
    const used = new Set();
    const usable = (id, min, max) => {
        const cost = itemData.getItemCost(id);
        if (cost <= 0 || used.has(id)) return false;
        if (min !== undefined && cost < min) return false;
        if (max !== undefined && cost > max) return false;
        return true;
    };
    const take = (id) => { used.add(id); return id; };

    const steps = [];
    const starting = (builds.starting || [])
        .filter(id => usable(id, undefined, STARTER_MAX_COST))
        .slice(0, 3)
        .map(take);
    if (starting.length) steps.push({ items: starting, autoGold: true });

    const boot = (builds.boots || []).find(id => usable(id, ...BOOTS_COST_RANGE));
    if (boot !== undefined) steps.push({ items: [take(boot)], autoGold: true });

    for (const id of builds.core || []) {
        if (!usable(id)) continue;
        steps.push({ items: [take(id)], autoGold: true });
    }

    if (steps.length === 0) {
        return { success: false, message: `OP.GG returned no usable items for ${champKey}` };
    }
    return setPath(champKey, steps);
}

module.exports = {
    MAX_STEPS,
    MAX_ITEMS_PER_STEP,
    getAll,
    getPath,
    setPath,
    deletePath,
    importFromOpgg,
    resolveForChampion,
};
