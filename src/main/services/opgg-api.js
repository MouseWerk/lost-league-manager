const axios = require('axios');
const championData = require('./champion-data');
const matches = require('./matches');

// Per-player numbers asked for every game (list and detail).
const MATCH_STATS = '{kill,death,assist,result,minion_kill,neutral_minion_kill,gold_earned,total_damage_dealt_to_champions}';

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
            // Every champion OP.GG lists this season, most played first (overlay tags).
            championPool: (s.most_champions?.champion_stats || []).map(c => ({
                id: c.id,
                name: c.champion_name || idToName[c.id] || '',
                games: c.play || 0,
                wins: c.win || 0,
            })),
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
                'data.game_history[].{id,created_at,game_type,game_length_second}',
                'data.game_history[].participants[].{champion_id,champion_name,items[],position,team_key}',
                'data.game_history[].participants[].summoner.{game_name,tagline}',
                `data.game_history[].participants[].stats.${MATCH_STATS}`,
            ],
        });
        const maps = { idToName: championData.getIdToNameMap(), idToImage: championData.getIdToImageMap() };
        const riotId = `${gameName}#${tagLine}`;
        return (parsed?.data?.game_history || []).slice(0, limit)
            .map(g => matches.fromOpggGame(g, riotId, maps))
            .filter(m => m && !m.remake);
    });
}

// ── Champion builds (champ select import) ──────────────────────────────────

const BUILD_POSITIONS = ['top', 'jungle', 'mid', 'adc', 'support'];
const ids = (v) => (Array.isArray(v) ? v.filter((n) => Number.isInteger(n) && n > 0) : []);
const firstIds = (list) => (Array.isArray(list) && list[0] ? ids(list[0].ids) : []);

// The most played runes and items for a champion, from OP.GG's statistics.
// champKey is the DDragon key ("MonkeyKing"); position one of BUILD_POSITIONS
// or null for the champion's main position; mode 'ranked' or 'aram'.
async function getChampionBuild(champKey, position, mode = 'ranked') {
    const champion = String(champKey || '').toUpperCase();
    if (!/^[A-Z]+$/.test(champion)) throw new Error('Unknown champion');
    const gameMode = mode === 'aram' ? 'aram' : 'ranked';
    let pos = BUILD_POSITIONS.includes(position) ? position : null;
    if (!pos && gameMode === 'aram') pos = 'mid'; // ARAM has one build per champion
    if (!pos) {
        const main = await cached(`build-pos:${champion}`, () => callTool('lol_get_champion_analysis', {
            game_mode: 'ranked', champion, position: 'mid',
            desired_output_fields: ['data.summary.positions[].name'],
        }));
        const name = String(main?.data?.summary?.positions?.[0]?.name || 'MID').toLowerCase();
        pos = BUILD_POSITIONS.includes(name) ? name : 'mid';
    }
    return cached(`build:${gameMode}:${champion}:${pos}`, async () => {
        const parsed = await callTool('lol_get_champion_analysis', {
            game_mode: gameMode, champion, position: pos,
            desired_output_fields: [
                'data.runes.{primary_page_id,primary_page_name,primary_rune_ids[],primary_rune_names[],secondary_page_id,secondary_page_name,secondary_rune_ids[],secondary_rune_names[],stat_mod_ids[],play,win}',
                'data.starter_items.{ids[]}',
                'data.boots.{ids[]}',
                'data.core_items.{ids[]}',
                'data.fourth_items[].{ids[]}',
                'data.fifth_items[].{ids[]}',
                'data.sixth_items[].{ids[]}',
                'data.skill_masteries.{ids[]}',
            ],
        });
        const d = parsed?.data || {};
        const r = d.runes || {};
        const perks = [...ids(r.primary_rune_ids), ...ids(r.secondary_rune_ids), ...ids(r.stat_mod_ids)];
        // A full page is four primary, two secondary and three stat shards.
        const runes = Number.isInteger(r.primary_page_id) && Number.isInteger(r.secondary_page_id) && perks.length === 9
            ? {
                primaryStyleId: r.primary_page_id,
                subStyleId: r.secondary_page_id,
                perkIds: perks,
                primaryName: typeof r.primary_page_name === 'string' ? r.primary_page_name : '',
                secondaryName: typeof r.secondary_page_name === 'string' ? r.secondary_page_name : '',
                names: [...(r.primary_rune_names || []), ...(r.secondary_rune_names || [])].filter((n) => typeof n === 'string'),
                games: Number.isInteger(r.play) ? r.play : 0,
                winRate: r.play ? Math.round((r.win / r.play) * 1000) / 10 : null,
            }
            : null;
        const late = [...new Set([...firstIds(d.fourth_items), ...firstIds(d.fifth_items), ...firstIds(d.sixth_items)])];
        const items = {
            starter: ids(d.starter_items?.ids),
            boots: ids(d.boots?.ids),
            core: ids(d.core_items?.ids),
            late,
        };
        const skills = (Array.isArray(d.skill_masteries?.ids) ? d.skill_masteries.ids : []).filter((s) => /^[QWER]$/.test(s));
        if (!runes && !items.core.length) throw new Error('OP.GG has no build for this champion yet');
        return { champion: champKey, position: pos, mode: gameMode, runes, items, skills };
    });
}

// Both teams of one game (the games dialog), by the id and start time that
// lol_list_summoner_matches returned.
async function getGameDetail(gameName, tagLine, region, gameId, createdAtIso) {
    const opggRegion = toOpggRegion(region);
    if (!opggRegion) throw new Error('OP.GG does not cover this region');
    const riotId = `${gameName}#${tagLine}`;
    return cached(`game:${opggRegion}:${gameId}`, async () => {
        const parsed = await callTool('lol_get_summoner_game_detail', {
            region: opggRegion,
            game_id: gameId,
            created_at: createdAtIso,
            focus_riot_id: riotId,
            desired_output_fields: [
                'data.game_detail.{id,created_at,game_type,game_length_second}',
                'data.game_detail.teams[].participants[].{champion_id,champion_name,is_target,items[],position,team_key}',
                'data.game_detail.teams[].participants[].summoner.{game_name,tagline}',
                `data.game_detail.teams[].participants[].stats.${MATCH_STATS}`,
            ],
        });
        const maps = { idToName: championData.getIdToNameMap(), idToImage: championData.getIdToImageMap() };
        const match = matches.fromOpggDetail(parsed?.data?.game_detail, riotId, maps);
        if (!match) throw new Error('OP.GG has no details for this game');
        return match;
    });
}

module.exports = {
    getProfile, getRecentMatches, getGameDetail, getChampionBuild, BUILD_POSITIONS, parseRiotIdInput, toOpggRegion, parseToolText,
    // Clears the cache and the busy cooldown between tests.
    _resetForTests() {
        cache.clear();
        busyUntil = 0;
    },
};
