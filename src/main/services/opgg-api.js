const axios = require('axios');
const championData = require('./champion-data');

// OP.GG's public MCP endpoint — no API key required, so summoner lookups,
// ranked stats and match history work out of the box for users who don't
// have (or let expire) a Riot developer key.
const OPGG_MCP_URL = 'https://mcp-api.op.gg/mcp';

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache    = new Map(); // key → { ts, value }
const inFlight = new Map(); // key → Promise (dedupes concurrent identical lookups)

// App region values and Riot platform ids → OP.GG region codes. CN isn't
// covered (Tencent servers). LA1 is LAN, LA2 is LAS. Legacy SEA accounts go to
// SG, the same server the op.gg profile link opens.
const OPGG_REGIONS = {
    na: 'NA', na1: 'NA',
    euw: 'EUW', euw1: 'EUW',
    eune: 'EUNE', eun1: 'EUNE',
    kr: 'KR',
    jp: 'JP', jp1: 'JP',
    br: 'BR', br1: 'BR',
    lan: 'LAN', la1: 'LAN',
    las: 'LAS', la2: 'LAS',
    oce: 'OCE', oc1: 'OCE',
    tr: 'TR', tr1: 'TR',
    ru: 'RU',
    me: 'ME', me1: 'ME',
    sg: 'SG', sg2: 'SG', sea: 'SG',
    ph: 'PH', ph2: 'PH',
    th: 'TH', th2: 'TH',
    tw: 'TW', tw2: 'TW',
    vn: 'VN', vn2: 'VN',
};

function toOpggRegion(region) {
    return OPGG_REGIONS[(region || '').trim().toLowerCase()] || null;
}

// ── Response parser ──────────────────────────────────────────────────────────
// Tool results come back as a compact constructor notation, e.g.
//   class Summoner: game_name,level
//   Summoner("Faker",123)
// The `class` header lines give each constructor's positional field names.

function parseToolText(text) {
    const lines  = text.split('\n');
    const schema = {};
    let i = 0;
    for (; i < lines.length; i++) {
        const m = lines[i].match(/^class (\w+): (.*)$/);
        if (!m) break;
        schema[m[1]] = m[2].split(',').map(s => s.trim());
    }
    const src = lines.slice(i).join('\n').trim();
    let pos = 0;

    const skipWs = () => { while (pos < src.length && /\s/.test(src[pos])) pos++; };

    function parseList(close) {
        const out = [];
        skipWs();
        if (src[pos] === close) { pos++; return out; }
        for (;;) {
            out.push(parseValue());
            skipWs();
            if (src[pos] === ',') { pos++; continue; }
            if (src[pos] === close) { pos++; return out; }
            throw new Error(`OP.GG parse error at ${pos}`);
        }
    }

    function parseValue() {
        skipWs();
        const c = src[pos];
        if (c === '"') {
            let j = pos + 1;
            while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
            const s = JSON.parse(src.slice(pos, j + 1));
            pos = j + 1;
            return s;
        }
        if (c === '[') { pos++; return parseList(']'); }
        const m = /^[A-Za-z_][\w]*|^-?\d+(\.\d+)?([eE][-+]?\d+)?/.exec(src.slice(pos, pos + 64));
        if (!m) throw new Error(`OP.GG parse error at ${pos}`);
        const tok = m[0];
        pos += tok.length;
        if (tok === 'null' || tok === 'None') return null;
        if (tok === 'true' || tok === 'True') return true;
        if (tok === 'false' || tok === 'False') return false;
        if (/^-?\d/.test(tok)) return Number(tok);
        skipWs();
        if (src[pos] !== '(') return tok;
        pos++;
        const args   = parseList(')');
        const fields = schema[tok] || [];
        const obj = {};
        args.forEach((v, k) => { obj[fields[k] ?? `_${k}`] = v; });
        return obj;
    }

    return parseValue();
}

// Cap concurrent requests so a long account list doesn't fire them all at once.
const MAX_CONCURRENT = 4;
let active = 0;
const queue = [];
async function withSlot(fn) {
    // A released slot is handed straight to the next waiter (active stays the
    // same), so a new caller can't slip in between and exceed the cap.
    if (active >= MAX_CONCURRENT) await new Promise(r => queue.push(r));
    else active++;
    try { return await fn(); } finally {
        const next = queue.shift();
        if (next) next();
        else active--;
    }
}

// After a 429 or a server error, OP.GG gets a short break instead of one
// request per remaining card.
const BUSY_COOLDOWN_MS = 60 * 1000;
const BUSY_MESSAGE = 'OP.GG is busy, try again in a minute';
let busyUntil = 0;

function callTool(name, args) {
    if (Date.now() < busyUntil) return Promise.reject(new Error(BUSY_MESSAGE));
    return withSlot(() => callToolNow(name, args));
}

async function callToolNow(name, args) {
    let res;
    try {
        res = await axios.post(OPGG_MCP_URL,
            { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
            {
                headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
                timeout: 15000,
            });
    } catch (e) {
        const status = e.response?.status;
        if (status === 429 || status >= 500) {
            busyUntil = Date.now() + BUSY_COOLDOWN_MS;
            throw new Error(BUSY_MESSAGE);
        }
        if (status) throw new Error(`OP.GG request failed (HTTP ${status})`);
        throw new Error(`OP.GG is unreachable: ${e.message}`);
    }
    const body = res.data;
    if (body?.error) {
        const msg = body.error.message || 'OP.GG request failed';
        throw new Error(/not found/i.test(msg) ? 'Summoner not found on OP.GG — check the Riot ID and region' : `OP.GG: ${msg}`);
    }
    const text = body?.result?.content?.find(c => c.type === 'text')?.text;
    if (!text) throw new Error('OP.GG returned an empty response');
    if (body.result.isError) throw new Error(`OP.GG: ${text.slice(0, 200)}`);
    return parseToolText(text);
}

function cached(key, fn) {
    const hit = cache.get(key);
    const age = hit ? Date.now() - hit.ts : -1;
    if (hit && age >= 0 && age < CACHE_TTL_MS) return Promise.resolve(hit.value);
    if (inFlight.has(key)) return inFlight.get(key);
    const p = fn()
        .then(value => {
            // Drop expired entries so the cache doesn't grow for the whole session.
            const now = Date.now();
            for (const [k, v] of cache) if (now - v.ts >= CACHE_TTL_MS) cache.delete(k);
            cache.set(key, { ts: now, value });
            return value;
        })
        .finally(() => inFlight.delete(key));
    inFlight.set(key, p);
    return p;
}

// ── Riot ID / OP.GG link parsing ─────────────────────────────────────────────

// Accepts "Name#TAG", "Name #TAG", or an OP.GG profile URL like
// https://op.gg/lol/summoners/euw/Name-TAG (also the older /summoners/euw/ form).
function parseRiotIdInput(input) {
    const raw = (input || '').trim();
    if (!raw) return null;

    const url = raw.match(/op\.gg\/(?:[a-z]{2}\/)?(?:lol\/)?summoners\/([a-z0-9]+)\/([^/?#\s]+)/i);
    if (url) {
        const slug = decodeURIComponent(url[2].replace(/\+/g, ' '));
        const dash = slug.lastIndexOf('-');
        if (dash <= 0) return null;
        return { gameName: slug.slice(0, dash).trim(), tagLine: slug.slice(dash + 1).trim(), region: url[1].toLowerCase() };
    }

    const hash = raw.lastIndexOf('#');
    if (hash <= 0 || hash === raw.length - 1) return null;
    return { gameName: raw.slice(0, hash).trim(), tagLine: raw.slice(hash + 1).trim(), region: null };
}

// ── Formatting ───────────────────────────────────────────────────────────────

function capFirst(s) {
    return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : '';
}

const DIVISION_ROMAN = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV' };
const EMPTY_RANK = { tier: 'Unranked', lp: '', winLose: '', ratio: '' };

function formatLeagueStat(stat) {
    const t = stat?.tier_info;
    if (!t || !t.tier) return null;
    const rawTier = t.tier.toUpperCase();
    const isApex  = ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(rawTier);
    const div     = DIVISION_ROMAN[t.division] || '';
    const w = stat.win  || 0;
    const l = stat.lose || 0;
    return {
        tier:    isApex ? capFirst(rawTier) : `${capFirst(rawTier)} ${div}`.trim(),
        lp:      `${t.lp ?? 0} LP`,
        winLose: `${w}W ${l}L`,
        ratio:   w + l > 0 ? `${Math.round(w / (w + l) * 100)}%` : '',
        rawTier,
        rawDivision: div,
        rawLp:       t.lp,
    };
}

// ── Public API ───────────────────────────────────────────────────────────────

async function getProfile(gameName, tagLine, region) {
    const opggRegion = toOpggRegion(region);
    if (!opggRegion) throw new Error('OP.GG does not cover this region');
    const key = `profile:${opggRegion}:${gameName.toLowerCase()}#${tagLine.toLowerCase()}`;

    return cached(key, async () => {
        const parsed = await callTool('lol_get_summoner_profile', {
            game_name: gameName,
            tag_line:  tagLine,
            region:    opggRegion,
            desired_output_fields: [
                'data.summoner.{game_name,tagline,level,profile_image_url,puuid}',
                'data.summoner.league_stats[].{game_type,win,lose}',
                'data.summoner.league_stats[].tier_info.{tier,division,lp}',
                'data.summoner.most_champions.champion_stats[].{id,champion_name,play,win}',
            ],
        });
        const s = parsed?.data?.summoner;
        if (!s) throw new Error('Summoner not found on OP.GG — check the Riot ID and region');

        const stats = Array.isArray(s.league_stats) ? s.league_stats : [];
        const solo  = formatLeagueStat(stats.find(x => x.game_type === 'SOLORANKED')) || EMPTY_RANK;
        const flex  = formatLeagueStat(stats.find(x => x.game_type === 'FLEXRANKED')) || EMPTY_RANK;

        // Most-played champions this season stand in for mastery badges
        // (OP.GG doesn't expose mastery points).
        const idToName  = championData.getIdToNameMap();
        const idToImage = championData.getIdToImageMap();
        const champs = (s.most_champions?.champion_stats || []).slice(0, 3).map(c => {
            const key = idToName[c.id];
            return {
                name:   c.champion_name || key || `Champion ${c.id}`,
                icon:   key ? idToImage[key] : null,
                games:  c.play || 0,
                wins:   c.win  || 0,
            };
        });

        return {
            success:     true,
            gameName:    s.game_name || gameName,
            tagLine:     s.tagline   || tagLine,
            riotId:      `${s.game_name || gameName}#${s.tagline || tagLine}`,
            ...solo,
            flexTier:    flex.tier,
            flexLp:      flex.lp,
            flexWinLose: flex.winLose,
            flexRatio:   flex.ratio,
            masteryChampions: [],
            topChampions: champs,
            iconSrc:     s.profile_image_url || null,
            level:       s.level != null ? String(s.level) : '',
            source:      'opgg',
        };
    });
}

async function getRecentMatches(gameName, tagLine, region, limit = 5) {
    const opggRegion = toOpggRegion(region);
    if (!opggRegion) throw new Error('OP.GG does not cover this region');
    const key = `matches:${opggRegion}:${gameName.toLowerCase()}#${tagLine.toLowerCase()}:${limit}`;

    return cached(key, async () => {
        const parsed = await callTool('lol_list_summoner_matches', {
            game_name: gameName,
            tag_line:  tagLine,
            region:    opggRegion,
            limit:     Math.max(5, limit),
            desired_output_fields: [
                'data.game_history[].{id,game_type}',
                'data.game_history[].participants[].{champion_id,champion_name}',
                'data.game_history[].participants[].stats.{kill,death,assist,result}',
            ],
        });
        const idToName  = championData.getIdToNameMap();
        const idToImage = championData.getIdToImageMap();
        return (parsed?.data?.game_history || []).slice(0, limit).map(g => {
            const p   = g.participants?.[0];
            const st  = p?.stats || {};
            const key = p ? idToName[p.champion_id] : null;
            return {
                win:          st.result === 'WIN',
                remake:       st.result && st.result !== 'WIN' && st.result !== 'LOSE',
                kda:          `${st.kill ?? 0}/${st.death ?? 0}/${st.assist ?? 0}`,
                championName: p?.champion_name || key || '',
                championIcon: key ? idToImage[key] : null,
            };
        }).filter(m => !m.remake);
    });
}

module.exports = {
    getProfile, getRecentMatches, parseRiotIdInput, toOpggRegion, parseToolText,
    // Clears the cache and the busy cooldown between tests.
    _resetForTests() {
        cache.clear();
        busyUntil = 0;
    },
};
