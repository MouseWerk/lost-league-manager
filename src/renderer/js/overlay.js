// ── State ────────────────────────────────────────────────────────────────────
let kills = 0, deaths = 0, assists = 0;
let cs = 0, gold = 0, level = 1;
let gameTime = 0;
let timerTick = null;
let myName = null;
let ddragonVersion = '15.1.1';
let allPlayers = [];
let panelOpen = false;
let buildPanelOpen = false;

// Ranked data fetched from LCU
let rankedData = {};    // { [playerName]: { tier, lp, winLose, ratio } }
let rankedLoading = false;
let rankedFetched = false;

// Build data fetched from OP.GG
let buildData = null;   // { champKey, starting:[], core:[], optional:[] }
let buildLoading = false;
let buildFetched = false;
let myChampKey = null;  // Data Dragon key of my champion

// Death tracking
let isDead = false;
let deathTick = null;
let respawnAt = 0;

const DEAD_TIPS = [
    'Buy items while dead!',
    'Check enemy positions!',
    'Ping your missing enemy!',
    'Plan your next move.',
    'Ward when you respawn!',
    'Back when you respawn?',
];

// ── DOM ───────────────────────────────────────────────────────────────────────
const ovKda    = document.getElementById('ovKda');
const ovCs     = document.getElementById('ovCs');
const ovCsm    = document.getElementById('ovCsm');
const ovGold   = document.getElementById('ovGold');
const ovTimer  = document.getElementById('ovTimer');
const ovLevel  = document.getElementById('ovLevel');
const ovChamp  = document.getElementById('ovChampIcon');
const ovToggle = document.getElementById('ovToggle');
const ovBuildToggle = document.getElementById('ovBuildToggle');
const ovRanked = document.getElementById('ovRanked');
const ovRankedContent = document.getElementById('ovRankedContent');
const ovBuilds = document.getElementById('ovBuilds');
const ovBuildsContent = document.getElementById('ovBuildsContent');
const ovLive   = document.getElementById('ovLive');
const ovDeadB  = document.getElementById('ovDeadBar');
const ovRCount = document.getElementById('ovRespawnCount');
const ovTip    = document.getElementById('ovDeadTip');

const COMPACT_H = 52;

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt2(n) { return String(Math.max(0, Math.floor(n))).padStart(2, '0'); }
function formatTime(s) { return `${fmt2(s / 60)}:${fmt2(s % 60)}`; }
function fmtGold(g) { return g >= 1000 ? (g / 1000).toFixed(1) + 'k' : String(g); }

function tryParse(val) {
    if (!val) return null;
    if (typeof val === 'object') return val;
    try { return JSON.parse(val); } catch { return null; }
}

function champDDKey(rawName) {
    if (!rawName) return null;
    return rawName.startsWith('game_character_displayname_')
        ? rawName.slice('game_character_displayname_'.length)
        : rawName.replace(/[\s'.]/g, '');
}

function champIconUrl(rawName) {
    const key = champDDKey(rawName);
    if (!key) return 'assets/logo.png';
    return `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/champion/${key}.png`;
}

function itemIconUrl(id) {
    return `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/item/${id}.png`;
}

// LoL respawn timer by level (seconds), with late-game scaling
function calcRespawnSecs(lvl, gameSecs) {
    const bases = [8, 10, 12, 14, 16, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80];
    const base = bases[Math.min(lvl - 1, bases.length - 1)];
    const minsOver25 = Math.max(0, gameSecs / 60 - 25);
    return Math.round(base * (1 + minsOver25 * 0.02));
}

// CS/min classification
function csmClass(rate) {
    if (rate >= 7.5) return 'csm-good';
    if (rate >= 5.0) return 'csm-ok';
    return 'csm-bad';
}

// ── Rank helpers ──────────────────────────────────────────────────────────────
function tierAbbr(tier) {
    if (!tier || tier === 'Unranked') return '–';
    const parts = tier.split(' ');
    const name = parts[0].toLowerCase();
    if (name === 'challenger') return 'C';
    if (name === 'grandmaster') return 'GM';
    if (name === 'master') return 'M';
    const letter = parts[0][0].toUpperCase();
    const roman = { 'I': '1', 'II': '2', 'III': '3', 'IV': '4' };
    const num = roman[parts[1]] || (parts[1] ? parts[1][0] : '');
    return letter + (num || '');
}

function tierClass(tier) {
    if (!tier) return 'tier-unranked';
    const t = tier.toLowerCase();
    if (t.startsWith('challenger'))  return 'tier-challenger';
    if (t.startsWith('grandmaster')) return 'tier-grandmaster';
    if (t.startsWith('master'))      return 'tier-master';
    if (t.startsWith('diamond'))     return 'tier-diamond';
    if (t.startsWith('emerald'))     return 'tier-emerald';
    if (t.startsWith('platinum'))    return 'tier-platinum';
    if (t.startsWith('gold'))        return 'tier-gold';
    if (t.startsWith('silver'))      return 'tier-silver';
    if (t.startsWith('bronze'))      return 'tier-bronze';
    if (t.startsWith('iron'))        return 'tier-iron';
    return 'tier-unranked';
}

// ── Timer ─────────────────────────────────────────────────────────────────────
function startTimer() {
    if (timerTick) return;
    timerTick = setInterval(() => { gameTime++; ovTimer.textContent = formatTime(gameTime); }, 1000);
}
function stopTimer() { if (timerTick) { clearInterval(timerTick); timerTick = null; } }

// ── Death / Respawn ───────────────────────────────────────────────────────────
function onDeath() {
    if (isDead) return;
    isDead = true;
    respawnAt = Date.now() + calcRespawnSecs(level, gameTime) * 1000;
    ovTip.textContent = DEAD_TIPS[Math.floor(Math.random() * DEAD_TIPS.length)];
    ovLive.style.display = 'none';
    ovDeadB.style.display = 'flex';
    if (deathTick) clearInterval(deathTick);
    deathTick = setInterval(tickDeath, 100);
}

function tickDeath() {
    const rem = Math.ceil((respawnAt - Date.now()) / 1000);
    if (rem <= 0) { onRespawn(); return; }
    ovRCount.textContent = rem;
}

function onRespawn() {
    if (!isDead) return;
    isDead = false;
    if (deathTick) { clearInterval(deathTick); deathTick = null; }
    ovDeadB.style.display = 'none';
    ovLive.style.display = 'flex';
}

// ── Bar update ────────────────────────────────────────────────────────────────
function updateBar() {
    ovKda.textContent  = `${kills}/${deaths}/${assists}`;
    ovCs.textContent   = `${cs} CS`;
    ovGold.textContent = fmtGold(gold) + 'g';
    ovTimer.textContent = formatTime(gameTime);
    ovLevel.textContent = level || 1;

    if (gameTime > 90) {
        const rate = cs / (gameTime / 60);
        ovCsm.textContent = rate.toFixed(1) + '/m';
        ovCsm.className = 'ov-csm ' + csmClass(rate);
    } else {
        ovCsm.textContent = '';
        ovCsm.className = 'ov-csm';
    }
}

function resetAll() {
    kills = deaths = assists = cs = gold = level = 0;
    gameTime = 0;
    allPlayers = [];
    myName = null;
    isDead = false;
    rankedData = {};
    rankedFetched = false;
    rankedLoading = false;
    buildData = null;
    buildFetched = false;
    buildLoading = false;
    myChampKey = null;
    if (deathTick) { clearInterval(deathTick); deathTick = null; }
    stopTimer();

    ovLive.style.display = 'flex';
    ovDeadB.style.display = 'none';
    ovCsm.textContent = '';
    ovCsm.className = 'ov-csm';
    ovChamp.src = 'assets/logo.png';
    ovLevel.textContent = '1';
    updateBar();

    if (panelOpen) togglePanel(false);
    if (buildPanelOpen) toggleBuildPanel(false);
}

// ── Build panel ───────────────────────────────────────────────────────────────
function triggerBuildFetch() {
    if (buildFetched || !myChampKey) return;
    buildFetched = true;
    buildLoading = true;
    window.overlayAPI.fetchBuilds(myChampKey)
        .then(data => {
            buildData = data;
            buildLoading = false;
            if (buildPanelOpen) renderBuildPanel();
        })
        .catch(() => {
            buildLoading = false;
            if (buildPanelOpen) renderBuildPanel();
        });
}

function renderBuildPanel() {
    if (buildLoading) {
        ovBuildsContent.innerHTML = '<div class="ov-rp-msg">Loading builds…</div>';
        return;
    }
    if (!myChampKey) {
        ovBuildsContent.innerHTML = '<div class="ov-rp-msg">Waiting for champion data…</div>';
        return;
    }
    if (!buildData || (!buildData.starting.length && !buildData.core.length)) {
        ovBuildsContent.innerHTML = '<div class="ov-rp-msg">No build data available for ' + myChampKey + '</div>';
        return;
    }

    const champIcon = champIconUrl(myChampKey);
    const rows = [];

    if (buildData.starting.length) {
        rows.push(buildRow('START', buildData.starting));
    }
    if (buildData.core.length) {
        rows.push(buildRow('CORE', buildData.core));
    }
    if (buildData.optional.length) {
        rows.push(buildRow('OPT', buildData.optional, true));
    }

    ovBuildsContent.innerHTML = `
        <div class="ov-build-header">
            <img class="ov-build-champ-icon" src="${champIcon}" onerror="this.src='assets/logo.png'">
            <span class="ov-build-champ-name">${myChampKey}</span>
            <span class="ov-build-source">op.gg</span>
        </div>
        ${rows.join('')}
    `;
}

function buildRow(label, ids, isBoot) {
    const imgs = ids.map(id =>
        `<img class="ov-build-item${isBoot ? ' ov-build-item--boot' : ''}" src="${itemIconUrl(id)}" title="${id}" onerror="this.style.display='none'">`
    ).join('');
    return `<div class="ov-build-row"><span class="ov-build-label">${label}</span><div class="ov-build-items">${imgs}</div></div>`;
}

function toggleBuildPanel(force) {
    buildPanelOpen = force !== undefined ? force : !buildPanelOpen;
    ovBuilds.style.display = buildPanelOpen ? 'block' : 'none';
    ovBuildToggle.classList.toggle('active', buildPanelOpen);

    if (buildPanelOpen) {
        if (panelOpen) togglePanel(false);
        if (!buildFetched && myChampKey) triggerBuildFetch();
        renderBuildPanel();
    }

    const rows = buildData
        ? (buildData.starting.length ? 1 : 0) + (buildData.core.length ? 1 : 0) + (buildData.optional.length ? 1 : 0)
        : 0;
    const panelH = 36 + rows * 42 + 10;
    window.overlayAPI.resize(480, COMPACT_H + (buildPanelOpen ? Math.max(panelH, 60) : 0));
}

// ── Ranked panel ──────────────────────────────────────────────────────────────
function renderRankedPanel() {
    if (!allPlayers.length || rankedLoading) {
        ovRankedContent.innerHTML = `<div class="ov-rp-msg">${rankedLoading ? 'Loading player data…' : 'Waiting for game data…'}</div>`;
        return;
    }

    const order = allPlayers.filter(p => p.team === 'ORDER' || p.teamID === '100');
    const chaos = allPlayers.filter(p => p.team === 'CHAOS' || p.teamID === '200');

    ovRankedContent.innerHTML = `<div class="ov-rp-teams">${buildTeamCol(order, true)}${buildTeamCol(chaos, false)}</div>`;
}

function buildTeamCol(players, isBlue) {
    const hdrClass = isBlue ? 'ov-rp-hdr--blue' : 'ov-rp-hdr--red';
    const label = isBlue ? 'Blue' : 'Red';
    let html = `<div class="ov-rp-col"><div class="ov-rp-hdr ${hdrClass}">${label}</div>`;

    for (const p of players) {
        const name  = p.riotIdGameName || p.summonerName || '?';
        const k     = p.scores?.kills   ?? 0;
        const d     = p.scores?.deaths  ?? 0;
        const a     = p.scores?.assists ?? 0;
        const dead  = p.isDead === true;
        const isMe  = myName && (p.summonerName === myName || p.riotIdGameName === myName);
        const icon  = champIconUrl(p.rawChampionName || p.championName);
        const rd    = rankedData[name];
        const tier  = rd?.tier || '';
        const abbr  = rd ? tierAbbr(tier) : '?';
        const cls   = tierClass(tier);
        const wr    = rd?.ratio || '—';

        html += `<div class="ov-rp-row${isMe ? ' is-me' : ''}${dead ? ' is-dead' : ''}">
            <img class="ov-rp-icon" src="${icon}" onerror="this.src='assets/logo.png'">
            <span class="ov-rp-name">${name}</span>
            <span class="ov-rp-badge ${cls}">${abbr}</span>
            <span class="ov-rp-wr">${wr}</span>
            <span class="ov-rp-kda">${k}/${d}/${a}</span>
        </div>`;
    }
    html += '</div>';
    return html;
}

function togglePanel(force) {
    panelOpen = force !== undefined ? force : !panelOpen;
    ovRanked.style.display = panelOpen ? 'block' : 'none';
    ovToggle.classList.toggle('active', panelOpen);

    if (panelOpen) {
        if (buildPanelOpen) toggleBuildPanel(false);
        if (!rankedFetched && allPlayers.length > 0) triggerRankedFetch();
        renderRankedPanel();
    }

    const rowH = 28;
    const rows = Math.max(allPlayers.length / 2, 5);
    const panelH = 6 + 18 + rows * rowH + 8; // top pad + header + rows + bottom pad
    window.overlayAPI.resize(480, COMPACT_H + (panelOpen ? Math.round(panelH) : 0));
}

function triggerRankedFetch() {
    if (rankedFetched) return;
    rankedFetched = true;
    rankedLoading = true;

    const playerList = allPlayers.map(p => ({
        gameName: p.riotIdGameName || null,
        tagLine:  p.riotIdTagLine  || null,
        summonerName: p.summonerName || null
    }));

    window.overlayAPI.fetchRanked(playerList)
        .then(data => {
            rankedData = data || {};
            rankedLoading = false;
            if (panelOpen) renderRankedPanel();
        })
        .catch(() => {
            rankedLoading = false;
            if (panelOpen) renderRankedPanel();
        });
}

// ── Dragging ──────────────────────────────────────────────────────────────────
const drag = document.getElementById('ovDrag');
drag.addEventListener('mousedown', (e) => {
    e.preventDefault();
    window.overlayAPI.startDragging();
});

// ── Hover-to-interact ─────────────────────────────────────────────────────────
document.addEventListener('mouseenter', () => window.overlayAPI.setInteractive(true));
document.addEventListener('mouseleave', () => window.overlayAPI.setInteractive(false));

// ── Toggle buttons ────────────────────────────────────────────────────────────
ovToggle.addEventListener('click', () => togglePanel());
ovBuildToggle.addEventListener('click', () => toggleBuildPanel());

// ── GEP: game events ──────────────────────────────────────────────────────────
window.overlayAPI.onGepGameEvent((data) => {
    if (!data?.feature) return;
    const k = data.key || data.feature;
    if (k === 'kill')   kills++;
    if (k === 'death')  { deaths++; onDeath(); }
    if (k === 'assist') assists++;
    updateBar();
});

// ── GEP: info updates ─────────────────────────────────────────────────────────
window.overlayAPI.onGepInfoUpdate((data) => {
    if (!data?.feature) return;

    switch (data.feature) {
        case 'matchState': {
            if (data.key !== 'matchState') break;
            const state = data.value;
            if (state === 'InProgress') startTimer();
            else if (state === 'EndOfGame' || state === 'PreGame') resetAll();
            break;
        }

        case 'live_client_data': {
            switch (data.key) {
                case 'game_data': {
                    const gd = tryParse(data.value);
                    if (gd?.gameTime) { gameTime = parseFloat(gd.gameTime); if (!timerTick) startTimer(); }
                    break;
                }
                case 'active_player': {
                    const ap = tryParse(data.value);
                    if (ap) {
                        myName = ap.riotIdGameName || ap.summonerName || myName;
                        level  = ap.level ?? ap.championStats?.level ?? level;
                        gold   = Math.floor(ap.currentGold ?? ap.championStats?.currentGold ?? gold);
                        const cs_ = ap.creepScore ?? ap.scores?.creepScore;
                        if (cs_ !== undefined) cs = cs_;
                    }
                    break;
                }
                case 'all_players': {
                    const players = tryParse(data.value);
                    if (Array.isArray(players)) {
                        allPlayers = players;
                        const me = players.find(p =>
                            p.summonerName === myName || p.riotIdGameName === myName
                        );
                        if (me) {
                            if (me.isDead === true  && !isDead) onDeath();
                            if (me.isDead === false && isDead)  onRespawn();
                            kills   = me.scores?.kills   ?? kills;
                            deaths  = me.scores?.deaths  ?? deaths;
                            assists = me.scores?.assists ?? assists;
                            level   = me.level ?? level;
                            cs      = me.scores?.creepScore ?? cs;
                            const iconUrl = champIconUrl(me.rawChampionName || me.championName);
                            if (ovChamp.src !== iconUrl) ovChamp.src = iconUrl;

                            // Detect champion and kick off build fetch
                            const key = champDDKey(me.rawChampionName || me.championName);
                            if (key && key !== myChampKey) {
                                myChampKey = key;
                                buildFetched = false;
                                buildData = null;
                            }
                            if (!buildFetched && myChampKey) triggerBuildFetch();
                        }

                        // Auto-fetch ranked data as soon as we have players
                        if (!rankedFetched && players.length > 0) {
                            triggerRankedFetch();
                        }

                        if (panelOpen) renderRankedPanel();
                    }
                    break;
                }
            }
            updateBar();
            break;
        }

        case 'summoner_info': {
            if (data.key === 'cs')    cs    = parseInt(data.value) || cs;
            if (data.key === 'gold')  gold  = parseInt(data.value) || gold;
            if (data.key === 'level') level = parseInt(data.value) || level;
            updateBar();
            break;
        }
    }
});

// ── Init ──────────────────────────────────────────────────────────────────────
window.overlayAPI.onInit((initData) => {
    if (initData?.ddragonVersion) ddragonVersion = initData.ddragonVersion;
    if (initData?.showRanked === false) ovToggle.style.display = 'none';
    if (initData?.showBuilds === false) ovBuildToggle.style.display = 'none';
});

updateBar();
