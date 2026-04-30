const axios = require('axios');
const championData = require('./champion-data');

const OPGG_BASE = 'https://www.op.gg/champions';

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    'Referer': 'https://www.op.gg/',
};

// GEP position → op.gg URL segment
const POS_MAP = {
    TOP: 'top', JUNGLE: 'jungle',
    MIDDLE: 'mid', MID: 'mid',
    BOTTOM: 'adc', ADC: 'adc',
    UTILITY: 'support', SUPPORT: 'support',
};

// Known LoL boot item IDs
const BOOT_IDS = new Set([3006, 3009, 3010, 3020, 3047, 3111, 3117, 3158]);

function champToSlug(champKey) {
    // DDragon key → op.gg URL slug: lowercase, strip ' and .
    return champKey.toLowerCase().replace(/['.]/g, '');
}

function isItemId(n) {
    return typeof n === 'number' && n >= 1001 && n <= 9999;
}

// ── __NEXT_DATA__ parser ──────────────────────────────────────────────────────

// DFS through arbitrary JSON looking for arrays that contain item IDs.
// targetKeys are checked first so known section names surface quickly.
function findSection(obj, targetKeys, visited = new Set(), depth = 0) {
    if (depth > 12 || !obj || typeof obj !== 'object' || visited.has(obj)) return null;
    visited.add(obj);

    if (Array.isArray(obj)) {
        const ids = obj.map(x => {
            if (isItemId(x)) return x;
            if (x && isItemId(x.id))      return x.id;
            if (x && isItemId(x.itemId))  return x.itemId;
            if (x && isItemId(x.item_id)) return x.item_id;
            return null;
        }).filter(Boolean);
        return ids.length >= 1 ? ids : null;
    }

    for (const key of targetKeys) {
        if (obj[key] !== undefined) {
            const r = findSection(obj[key], targetKeys, visited, depth + 1);
            if (r) return r;
        }
    }
    for (const val of Object.values(obj)) {
        if (val && typeof val === 'object') {
            const r = findSection(val, targetKeys, visited, depth + 1);
            if (r) return r;
        }
    }
    return null;
}

function extractFromNextData(json) {
    const root = json?.props?.pageProps ?? json;

    const starting = findSection(root, ['starting', 'startingItems', 'starting_items', 'starter', 'starterItems']);
    const boots    = findSection(root, ['boots', 'bootsItems', 'boot']);
    const core     = findSection(root, ['core', 'coreItems', 'core_items', 'mythic', 'build', 'mainItems']);
    const optional = findSection(root, ['last', 'lastItems', 'situational', 'optional', 'soleItems', 'depth4', 'depth_4']);

    if (!core && !starting) return null;
    return {
        starting: (starting || []).slice(0, 4),
        boots:    (boots    || []).slice(0, 2),
        core:     (core     || []).slice(0, 6),
        optional: (optional || []).slice(0, 4),
    };
}

// ── HTML image-URL fallback ───────────────────────────────────────────────────

function extractFromHtml(html) {
    // Collect all item IDs from opgg-static image src URLs, in order, deduplicated
    const rx = /\/item\/(\d{4,5})\.png/g;
    const seen = new Set();
    const all = [];
    let m;
    while ((m = rx.exec(html)) !== null) {
        const id = parseInt(m[1]);
        if (isItemId(id) && !seen.has(id)) { seen.add(id); all.push(id); }
    }
    if (all.length < 3) return null;

    // Classify by item ID range:
    //   1001–2999 → typically starter/component items
    //   3000+     → finished items; boot IDs separated out
    const starting = all.filter(id => id < 3000);
    const boots    = all.filter(id => BOOT_IDS.has(id));
    const rest     = all.filter(id => id >= 3000 && !BOOT_IDS.has(id));

    return {
        starting: starting.slice(0, 4),
        boots:    boots.slice(0, 2),
        core:     rest.slice(0, 6),
        optional: rest.slice(6, 10),
    };
}

// ── Public API ────────────────────────────────────────────────────────────────

async function getBuilds(champKey, gameMode, position) {
    const slug   = champToSlug(champKey);
    const isAram = (gameMode || '').toUpperCase() === 'ARAM';
    const pos    = isAram ? 'aram' : (POS_MAP[(position || '').toUpperCase()] || '');
    const url    = pos ? `${OPGG_BASE}/${slug}/build/${pos}` : `${OPGG_BASE}/${slug}/build`;

    try {
        const res  = await axios.get(url, { headers: HEADERS, timeout: 12000 });
        const html = res.data;

        // Try structured __NEXT_DATA__ first
        const ndMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
        if (ndMatch) {
            try {
                const builds = extractFromNextData(JSON.parse(ndMatch[1]));
                if (builds && (builds.core.length || builds.starting.length)) {
                    console.log(`[Builds] ${champKey}/${pos || 'default'} via __NEXT_DATA__ ✓`);
                    return { champKey, gameMode: gameMode || 'CLASSIC', position: position || null, ...builds };
                }
            } catch { /* fall through */ }
        }

        // Fallback: classify item IDs from image URLs
        const builds = extractFromHtml(html);
        if (builds) {
            console.log(`[Builds] ${champKey}/${pos || 'default'} via HTML fallback (${builds.core.length} core items)`);
            return { champKey, gameMode: gameMode || 'CLASSIC', position: position || null, ...builds };
        }

        console.log(`[Builds] ${champKey}: no data found at ${url}`);
        return null;
    } catch (e) {
        console.log(`[Builds] ${champKey}:`, e.message);
        return null;
    }
}

module.exports = { getBuilds };
