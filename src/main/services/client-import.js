const crypto = require('crypto');
const lcu = require('../lcu');

// Puts an OP.GG build (opgg-api.js getChampionBuild) into the League client:
// a rune page and an item set. Both carry the "LLM " prefix, so the app only
// ever replaces what it created itself. Nothing here picks or locks a
// champion (auto champ lock stays off, see lcu-events.js).

const PREFIX = 'LLM ';
const POSITION_NAMES = { top: 'Top', jungle: 'Jungle', mid: 'Mid', adc: 'Bot', support: 'Support' };

function buildTitle(championName, build) {
    const where = build.mode === 'aram' ? 'ARAM' : POSITION_NAMES[build.position] || '';
    return `${PREFIX}${championName}${where ? ` ${where}` : ''}`.slice(0, 40);
}

function runePagePayload(build, championName) {
    const r = build?.runes;
    if (!r) return null;
    return {
        name: buildTitle(championName, build),
        primaryStyleId: r.primaryStyleId,
        subStyleId: r.subStyleId,
        selectedPerkIds: r.perkIds.slice(),
        current: true,
    };
}

const block = (type, list) => ({ type, items: list.map((id) => ({ id: String(id), count: 1 })) });

function itemSetPayload(build, championName, championId) {
    const it = build?.items || {};
    const blocks = [];
    if (it.starter?.length) blocks.push(block('Starting items', it.starter));
    if (it.boots?.length) blocks.push(block('Boots', it.boots));
    if (it.core?.length) blocks.push(block('Core items', it.core));
    if (it.late?.length) blocks.push(block('Later items', it.late));
    if (blocks.length && build?.skills?.length) blocks[0].type += `, max ${build.skills.join(' > ')}`;
    if (!blocks.length) return null;
    return {
        title: buildTitle(championName, build),
        associatedChampions: [championId],
        associatedMaps: [build.mode === 'aram' ? 12 : 11],
        blocks,
        map: 'any',
        mode: 'any',
        preferredItemSlots: [],
        sortrank: 0,
        startedFrom: 'blank',
        type: 'custom',
        uid: crypto.randomUUID(),
    };
}

// Replaces the app's own rune page. When every page slot is taken by the
// player's pages, the current page is replaced only with replaceCurrent;
// without it the result asks for that confirmation.
async function importRunes(build, championName, { replaceCurrent = false } = {}) {
    const payload = runePagePayload(build, championName);
    if (!payload) return { success: false, message: 'This build has no runes' };
    const pages = await lcu.request('GET', '/lol-perks/v1/pages');
    if (!Array.isArray(pages)) return { success: false, message: 'The League client did not answer' };
    const ours = pages.filter((p) => typeof p.name === 'string' && p.name.startsWith(PREFIX) && p.isDeletable);
    for (const p of ours) await lcu.request('DELETE', `/lol-perks/v1/pages/${p.id}`);
    const inventory = await lcu.request('GET', '/lol-perks/v1/inventory');
    const owned = Number.isInteger(inventory?.ownedPageCount) ? inventory.ownedPageCount : null;
    const theirs = pages.filter((p) => p.isDeletable && !ours.includes(p));
    if (owned !== null && theirs.length >= owned) {
        const current = theirs.find((p) => p.current) || null;
        if (!replaceCurrent || !current) {
            return { success: false, needsConfirm: true, message: 'All rune pages are in use. Replace the current page?' };
        }
        await lcu.request('DELETE', `/lol-perks/v1/pages/${current.id}`);
    }
    const created = await lcu.request('POST', '/lol-perks/v1/pages', payload, { verbose: true });
    if (created === null) return { success: false, message: 'The client did not accept the rune page' };
    return { success: true, name: payload.name };
}

// Adds or replaces the app's item set for this champion; other sets stay.
async function importItemSet(build, championName, championId) {
    const payload = itemSetPayload(build, championName, championId);
    if (!payload) return { success: false, message: 'This build has no items' };
    const me = await lcu.request('GET', '/lol-summoner/v1/current-summoner');
    if (!me?.summonerId) return { success: false, message: 'The League client did not answer' };
    const url = `/lol-item-sets/v1/item-sets/${me.summonerId}/sets`;
    const current = await lcu.request('GET', url);
    const sets = Array.isArray(current?.itemSets) ? current.itemSets : [];
    const kept = sets.filter((s) => s.title !== payload.title);
    const body = { ...(current || {}), accountId: current?.accountId ?? me.accountId, itemSets: [...kept, payload] };
    const res = await lcu.request('PUT', url, body, { verbose: true });
    if (res === null) return { success: false, message: 'The client did not accept the item set' };
    return { success: true, name: payload.title };
}

module.exports = { PREFIX, buildTitle, runePagePayload, itemSetPayload, importRunes, importItemSet };
