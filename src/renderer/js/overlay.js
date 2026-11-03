// In-game overlay: a bar with your champion and score, and four panels
// (game, players, build, settings), one open at a time. Data comes as GEP info
// updates, from Overwolf or from the Live Client Data API (overlay-manager.js
// sends both in the same shape).

// Images that fail to load fall back to the logo or hide themselves, per their
// data-fallback attribute. Inline onerror handlers are blocked by the CSP.
document.addEventListener('error', (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.dataset.fallback) return;
    if (img.dataset.fallback === 'hide') img.style.display = 'none';
    else if (!img.src.endsWith('assets/logo.png')) img.src = 'assets/logo.png';
}, true);

// ── State ────────────────────────────────────────────────────────────────────
let kills = 0, deaths = 0, assists = 0;
let cs = 0, gold = 0, level = 1;
let gameTime = 0;
let timerTick = null;
let myName = null;
let ddragonVersion = '15.1.1';
let allPlayers = [];
let openPanel = null; // 'game' | 'players' | 'build' | 'settings' | null
let gameEvents = [];  // the game's event feed (kills of towers, dragons, ...)
let csGoal = 8;       // CS per minute the player aims for (overlay settings)
let phase = 'None';   // the client's gameflow phase
let loadingPlayers = []; // both teams on the loading screen (overlay-get-loading)
let tabPeek = null;   // the panel to go back to when Tab is let go
let overlayLocked = false;

// Ranked data from the main process: { [riotIdKey]: { tier, lp, ratio, failed? } }
let rankedData = {};
let rankedLoading = false;
let rankedFetched = false;
let rankedRetryCount = 0;
const MAX_RANKED_RETRIES = 2;

// Display name (lowercase) → Data Dragon key, sent from main on init
// (Wukong → MonkeyKing, Cho'Gath → Chogath, ...).
let champKeyMap = {};
let itemNames = {}; // item id → name, for the item tooltips

// OP.GG build for my champion (opgg-api.js getChampionBuild).
let buildData = null;
let buildError = null;
let buildLoading = false;
let buildFetched = false;
let myChampKey = null;
let myChampName = null;
let myGameMode = 'CLASSIC';
let myPosition = null;

// Death tracking
let isDead = false;
let deathTick = null;
let respawnAt = 0;
let respawnTotal = 1;

const DEAD_TIPS = [
    'Shop while you wait',
    'Check the minimap',
    'Plan your next fight',
    'Ward on the way back',
    'Look at the enemy items',
];

// ── DOM ───────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const ovRoot = $('ovRoot');
const ovKda = $('ovKda');
const ovCs = $('ovCs');
const ovCsm = $('ovCsm');
const ovGold = $('ovGold');
const ovTimer = $('ovTimer');
const ovLevel = $('ovLevel');
const ovChamp = $('ovChampIcon');
const ovLive = $('ovLive');
const ovDeadBar = $('ovDeadBar');
const ovRespawnCount = $('ovRespawnCount');
const ovRespawnBar = $('ovRespawnBar');
const ovRespawnFill = $('ovRespawnFill');
const ovDeadTip = $('ovDeadTip');
const ovGameToggle = $('ovGameToggle');
const ovGame = $('ovGame');
const ovGameContent = $('ovGameContent');
const ovCsGoalSeg = $('ovCsGoalSeg');
const ovToggle = $('ovToggle');
const ovBuildToggle = $('ovBuildToggle');
const ovItemsToggle = $('ovItemsToggle');
const ovItems = $('ovItems');
const ovItemsContent = $('ovItemsContent');
const ovSettingsBtn = $('ovSettingsBtn');
const ovRanked = $('ovRanked');
const ovRankedContent = $('ovRankedContent');
const ovBuilds = $('ovBuilds');
const ovBuildsContent = $('ovBuildsContent');
const ovSettingsPanel = $('ovSettingsPanel');
const ovOpacitySlider = $('ovOpacitySlider');
const ovOpacityVal = $('ovOpacityVal');
const ovHotkeySeg = $('ovHotkeySeg');
const ovLockToggle = $('ovLockToggle');
const ovShowRankedToggle = $('ovShowRankedToggle');
const ovShowBuildsToggle = $('ovShowBuildsToggle');
const ovTip = $('ovTip');

const Stats = window.OverlayStats;

// ── Helpers ───────────────────────────────────────────────────────────────────
function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fmt2(n) { return String(Math.max(0, Math.floor(n))).padStart(2, '0'); }
function formatTime(s) { return `${fmt2(s / 60)}:${fmt2(s % 60)}`; }
function fmtGold(g) { return g >= 1000 ? (g / 1000).toFixed(1) + 'k' : String(g); }

function tryParse(val) {
    if (!val) return null;
    if (typeof val === 'object') return val;
    try { return JSON.parse(val); } catch { return null; }
}

function champDDKey(rawChampionName, championName) {
    if (rawChampionName && rawChampionName.startsWith('game_character_displayname_')) {
        return rawChampionName.slice('game_character_displayname_'.length);
    }
    const displayName = championName || rawChampionName;
    if (!displayName) return null;
    const mapped = champKeyMap[displayName.toLowerCase()];
    if (mapped) return mapped;
    return displayName.replace(/[\s'.&]/g, '');
}

function champIconUrlFromKey(key) {
    if (!key) return 'assets/logo.png';
    return `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/champion/${key}.png`;
}

function champIconUrl(rawChampionName, championName) {
    return champIconUrlFromKey(champDDKey(rawChampionName, championName));
}

// The key the main process uses for overlay-get-ranked-bulk results: the full
// Riot ID when there is one, so two players with one game name stay apart.
function playerRiotKey(p) {
    const name = p.riotIdGameName || p.summonerName || '?';
    return p.riotIdTagLine ? `${name}#${p.riotIdTagLine}` : name;
}

function itemIconUrl(id) {
    return `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/item/${id}.png`;
}

// Respawn time by level (seconds), longer late in the game.
function calcRespawnSecs(lvl, gameSecs) {
    const bases = [8, 10, 12, 14, 16, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80];
    const base = bases[Math.min(Math.max(lvl, 1) - 1, bases.length - 1)];
    const minsOver25 = Math.max(0, gameSecs / 60 - 25);
    return Math.round(base * (1 + minsOver25 * 0.02));
}

function csmClass(rate) {
    if (rate >= 7.5) return 'is-good';
    if (rate >= 5.0) return 'is-ok';
    return 'is-low';
}

// "Diamond II" → "D2", "Master" → "M"
function tierAbbr(tier) {
    if (!tier || tier === 'Unranked') return '-';
    const parts = tier.split(' ');
    const name = parts[0].toLowerCase();
    if (name === 'challenger') return 'C';
    if (name === 'grandmaster') return 'GM';
    if (name === 'master') return 'M';
    const roman = { I: '1', II: '2', III: '3', IV: '4' };
    return parts[0][0].toUpperCase() + (roman[parts[1]] || '');
}

const TIERS = ['iron', 'bronze', 'silver', 'gold', 'platinum', 'emerald', 'diamond', 'master', 'grandmaster', 'challenger'];
function tierName(tier) {
    const t = String(tier || '').trim().toLowerCase().split(/\s+/)[0];
    return TIERS.includes(t) ? t : null;
}

// ── Window size follows the content ──────────────────────────────────────────
let lastSize = '';
new ResizeObserver(() => {
    const w = Math.ceil(ovRoot.offsetWidth);
    const h = Math.ceil(ovRoot.offsetHeight);
    const size = `${w}x${h}`;
    if (size === lastSize) return;
    lastSize = size;
    window.overlayAPI.resize(w, h);
}).observe(ovRoot);

// ── Timer ─────────────────────────────────────────────────────────────────────
function startTimer() {
    if (timerTick) return;
    timerTick = setInterval(() => {
        gameTime++;
        ovTimer.textContent = formatTime(gameTime);
        if (openPanel === 'game') renderGamePanel();
    }, 1000);
}
function stopTimer() { if (timerTick) { clearInterval(timerTick); timerTick = null; } }

// ── Death and respawn ─────────────────────────────────────────────────────────
function onDeath() {
    if (isDead) return;
    isDead = true;
    respawnTotal = calcRespawnSecs(level, gameTime);
    respawnAt = Date.now() + respawnTotal * 1000;
    ovDeadTip.textContent = DEAD_TIPS[Math.floor(Math.random() * DEAD_TIPS.length)];
    ovLive.hidden = true;
    ovDeadBar.hidden = false;
    ovRespawnBar.hidden = false;
    if (deathTick) clearInterval(deathTick);
    deathTick = setInterval(tickDeath, 200);
    tickDeath();
}

function tickDeath() {
    const left = (respawnAt - Date.now()) / 1000;
    if (left <= 0) { onRespawn(); return; }
    ovRespawnCount.textContent = Math.ceil(left);
    ovRespawnFill.style.transform = `scaleX(${Math.max(0, left / respawnTotal)})`;
}

function onRespawn() {
    if (!isDead) return;
    isDead = false;
    if (deathTick) { clearInterval(deathTick); deathTick = null; }
    ovDeadBar.hidden = true;
    ovRespawnBar.hidden = true;
    ovLive.hidden = false;
}

// ── Bar ───────────────────────────────────────────────────────────────────────
function updateBar() {
    ovKda.textContent = `${kills}/${deaths}/${assists}`;
    ovCs.textContent = `${cs} CS`;
    ovGold.textContent = fmtGold(gold);
    ovTimer.textContent = formatTime(gameTime);
    ovLevel.textContent = level || 1;
    if (gameTime > 90) {
        const rate = cs / (gameTime / 60);
        ovCsm.textContent = `${rate.toFixed(1)}/m`;
        ovCsm.className = `ov-csm ${csmClass(rate)}`;
    } else {
        ovCsm.textContent = '';
        ovCsm.className = 'ov-csm';
    }
}

function resetAll() {
    kills = deaths = assists = cs = gold = 0;
    level = 1;
    gameTime = 0;
    allPlayers = [];
    gameEvents = [];
    myName = null;
    myRiotId = null;
    rankedData = {};
    rankedFetched = false;
    rankedLoading = false;
    rankedRetryCount = 0;
    buildData = null;
    buildError = null;
    buildFetched = false;
    buildLoading = false;
    myChampKey = null;
    myChampName = null;
    myGameMode = 'CLASSIC';
    myPosition = null;
    stopTimer();
    if (isDead) onRespawn();
    ovChamp.src = 'assets/logo.png';
    updateBar();
    showPanel(null);
}

// ── Panels: one open at a time ────────────────────────────────────────────────
function showPanel(name) {
    openPanel = name === null || openPanel === name ? null : name;
    ovGame.hidden = openPanel !== 'game';
    ovRanked.hidden = openPanel !== 'players';
    ovBuilds.hidden = openPanel !== 'build';
    ovItems.hidden = openPanel !== 'items';
    ovSettingsPanel.hidden = openPanel !== 'settings';
    ovGameToggle.setAttribute('aria-pressed', String(openPanel === 'game'));
    ovToggle.setAttribute('aria-pressed', String(openPanel === 'players'));
    ovBuildToggle.setAttribute('aria-pressed', String(openPanel === 'build'));
    ovItemsToggle.setAttribute('aria-pressed', String(openPanel === 'items'));
    ovSettingsBtn.setAttribute('aria-pressed', String(openPanel === 'settings'));
    if (openPanel === 'game') renderGamePanel();
    if (openPanel === 'players') {
        if (!rankedFetched && allPlayers.length) triggerRankedFetch();
        renderRankedPanel();
        // (Opening the panel by hand still looks the ranks up.)
    }
    if (openPanel === 'build' || openPanel === 'items') {
        if (!buildFetched && myChampKey) triggerBuildFetch();
        renderBuildPanel();
        renderItemsPanel();
    }
}

ovGameToggle.addEventListener('click', () => showPanel('game'));
ovToggle.addEventListener('click', () => showPanel('players'));
ovBuildToggle.addEventListener('click', () => showPanel('build'));
ovItemsToggle.addEventListener('click', () => showPanel('items'));
ovSettingsBtn.addEventListener('click', () => showPanel('settings'));

// ── Game panel ────────────────────────────────────────────────────────────────
function myPlayer() {
    return allPlayers.find((p) => isMe(p)) || null;
}

function diffCell(mine, theirs, fmt = String) {
    const d = mine - theirs;
    const cls = d > 0 ? 'is-ahead' : d < 0 ? 'is-behind' : '';
    return `<span class="ov-stat-diff ${cls}">${escHtml(d > 0 ? `+${fmt(d)}` : d < 0 ? `-${fmt(-d)}` : '0')}</span>`;
}

function statRow(name, mine, theirs, fmt = String) {
    return `<span class="ov-stat-name">${escHtml(name)}</span><span class="ov-stat-val">${escHtml(fmt(mine))}</span><span class="ov-stat-val">${escHtml(fmt(theirs))}</span>${diffCell(mine, theirs, fmt)}`;
}

function timersHtml() {
    const timers = Stats.objectiveTimers(gameEvents, gameTime);
    if (!timers.length) return '';
    return `<div class="ov-divider"></div><p class="ov-label">Back in</p><div class="ov-timers">${timers.map((t) => `<span>${escHtml(t.name)}</span><span>${escHtml(formatTime(t.at - gameTime))}</span>`).join('')}</div>`;
}

function renderGamePanel() {
    const me = myPlayer();
    if (!me) { ovGameContent.innerHTML = '<p class="ov-msg">Waiting for the game...</p>'; return; }
    const us = me.team;
    const them = us === 'ORDER' ? 'CHAOS' : 'ORDER';
    const obj = Stats.objectives(gameEvents, allPlayers);
    const kp = Stats.killParticipation(me, allPlayers);
    const opp = Stats.laneOpponent(me, allPlayers);
    const minutes = gameTime / 60;
    const csm = minutes > 1 ? cs / minutes : 0;
    const goalPct = Math.min(100, Math.round((csm / csGoal) * 100));

    const rows = [
        statRow('Item gold', Stats.itemGold(allPlayers, us), Stats.itemGold(allPlayers, them), fmtGold),
        statRow('Towers', obj[us].towers, obj[them].towers),
        statRow('Dragons', obj[us].dragons, obj[them].dragons),
        statRow('Grubs', obj[us].grubs, obj[them].grubs),
        statRow('Heralds', obj[us].heralds, obj[them].heralds),
        statRow('Barons', obj[us].barons, obj[them].barons),
    ].join('');
    const vsLane = opp
        ? `<div class="ov-stat-grid">${statRow(`CS vs ${opp.championName || 'lane'}`, cs, opp.scores?.creepScore || 0)}${statRow('Level', level, opp.level || 0)}</div>`
        : '';

    ovGameContent.innerHTML = `
        <div class="ov-score-row">
            <div class="ov-score-side"><span class="ov-score-kills">${escHtml(Stats.kills(allPlayers, us))}</span><span class="ov-score-label">Your team</span></div>
            <span class="ov-score-vs">kills</span>
            <div class="ov-score-side is-enemy"><span class="ov-score-kills">${escHtml(Stats.kills(allPlayers, them))}</span><span class="ov-score-label">Enemies</span></div>
        </div>
        <div class="ov-stat-grid">
            <span></span><span class="ov-label">You</span><span class="ov-label">Them</span><span></span>
            ${rows}
        </div>
        <div class="ov-divider"></div>
        <p class="ov-label">Your game</p>
        <div class="ov-stat-grid">
            <span class="ov-stat-name">Kill participation</span><span class="ov-stat-val">${kp === null ? '-' : escHtml(kp + '%')}</span><span></span><span></span>
            <span class="ov-stat-name">Vision score</span><span class="ov-stat-val">${escHtml(Math.round(me.scores?.wardScore || 0))}</span><span></span><span></span>
            <span class="ov-stat-name">CS per minute</span><span class="ov-stat-val">${escHtml(csm.toFixed(1))}</span><span class="ov-stat-val">of ${escHtml(csGoal)}</span><span></span>
        </div>
        <div class="ov-goal-bar"><span style="width:${escHtml(goalPct)}%"></span></div>
        ${timersHtml()}
        ${vsLane ? '<div class="ov-divider"></div>' + vsLane : ''}`;
}

// ── Build panel ───────────────────────────────────────────────────────────────
function triggerBuildFetch() {
    if (buildFetched || !myChampKey) return;
    buildFetched = true;
    buildLoading = true;
    buildError = null;
    window.overlayAPI.fetchBuilds(myChampKey, myGameMode, myPosition)
        .then((res) => {
            buildLoading = false;
            if (res?.success) buildData = res.build;
            else buildError = res?.message || 'No build for this champion yet';
            if (openPanel === 'build') renderBuildPanel();
            if (openPanel === 'items') renderItemsPanel();
        })
        .catch(() => {
            buildFetched = false; // try again next time
            buildLoading = false;
            if (openPanel === 'build') renderBuildPanel();
            if (openPanel === 'items') renderItemsPanel();
        });
}

function ownedItems() {
    return new Set((myPlayer()?.items || []).map((it) => it.itemID));
}

function itemRow(label, ids) {
    if (!ids?.length) return '';
    const owned = ownedItems();
    const imgs = ids.map((id) => `<span class="ov-item-wrap${owned.has(id) ? ' is-owned' : ''}"><img class="ov-item" src="${escHtml(itemIconUrl(id))}" alt="" data-tip="${escHtml((itemNames[id] || id) + (owned.has(id) ? ', bought' : ''))}" data-fallback="hide"></span>`).join('');
    return `<div><p class="ov-label">${escHtml(label)}</p><div class="ov-item-row">${imgs}</div></div>`;
}

const POSITION_NAMES = { top: 'Top', jungle: 'Jungle', mid: 'Mid', adc: 'Bot', support: 'Support' };

function renderBuildPanel() {
    if (!myChampKey) { ovBuildsContent.innerHTML = '<p class="ov-msg">Waiting for your champion...</p>'; return; }
    if (buildLoading) { ovBuildsContent.innerHTML = '<p class="ov-msg">Loading the build from OP.GG...</p>'; return; }
    if (!buildData) { ovBuildsContent.innerHTML = `<p class="ov-msg">${escHtml(buildError || 'No build for this champion yet')}</p>`; return; }
    const b = buildData;
    const where = b.mode === 'aram' ? 'ARAM' : POSITION_NAMES[b.position] || '';
    const runes = b.runes
        ? `<div class="ov-runes">${b.runes.names.map((n, i) => `<span class="ov-rune${i === 0 ? ' is-key' : ''}">${escHtml(n)}</span>`).join('')}</div>`
        : '';
    const skills = b.skills?.length ? `<p class="ov-skills">Max <b>${escHtml(b.skills.join(' > '))}</b></p>` : '';
    ovBuildsContent.innerHTML = `
        <div class="ov-build-head">
            <img src="${escHtml(champIconUrlFromKey(myChampKey))}" alt="" data-fallback="logo">
            <span class="ov-build-title">${escHtml(myChampName || myChampKey)}</span>
            <span class="ov-build-sub">${escHtml([where, 'OP.GG'].filter(Boolean).join(', '))}</span>
        </div>
        ${runes}
        <div class="ov-items">
            ${itemRow('Start', b.items.starter)}${itemRow('Boots', b.items.boots)}${itemRow('Core', b.items.core)}${itemRow('Later', b.items.late)}
        </div>
        ${skills}`;
}

// Items panel: the core build, boots, and the choices for the 4th, 5th and
// 6th item with how often each is picked and won. Bought items are ticked.
function itemIcon(id, owned) {
    return `<span class="ov-item-wrap${owned.has(id) ? ' is-owned' : ''}"><img class="ov-item" src="${escHtml(itemIconUrl(id))}" alt="" data-tip="${escHtml((itemNames[id] || id) + (owned.has(id) ? ', bought' : ''))}" data-fallback="hide"></span>`;
}

function pickText(c) {
    return c?.pickRate === null || c?.pickRate === undefined ? '' : String(c.pickRate) + '% pick';
}

function rateText(c) {
    return c?.winRate === null || c?.winRate === undefined ? '' : `${c.winRate}%`;
}

function itemChoicesRow(label, list, owned) {
    if (!list?.length) return '';
    const cells = list.map((c) => `
        <span class="ov-choice">
            ${c.ids.map((id) => itemIcon(id, owned)).join('')}
            <span class="ov-choice-wr">${escHtml(rateText(c))}</span>
            <span class="ov-choice-pick">${escHtml(pickText(c))}</span>
        </span>`).join('');
    return `<div class="ov-choices-row"><p class="ov-label">${escHtml(label)}</p><div class="ov-choices">${cells}</div></div>`;
}

function renderItemsPanel() {
    if (!myChampKey) { ovItemsContent.innerHTML = '<p class="ov-msg">Waiting for your champion...</p>'; return; }
    if (buildLoading) { ovItemsContent.innerHTML = '<p class="ov-msg">Loading the builds from OP.GG...</p>'; return; }
    if (!buildData) { ovItemsContent.innerHTML = `<p class="ov-msg">${escHtml(buildError || 'No build for this champion yet')}</p>`; return; }
    const items = buildData.items || {};
    const owned = ownedItems();
    const opts = items.options || {};
    const core = items.core?.length
        ? `<div class="ov-core">
            <div class="ov-core-items">${items.core.map((id) => itemIcon(id, owned)).join('<span class="ov-core-arrow" aria-hidden="true"></span>')}</div>
            <div class="ov-core-stats">${escHtml([rateText(items.coreStats) && `${rateText(items.coreStats)} won`, items.coreStats?.games ? `${items.coreStats.games.toLocaleString('en-US')} games` : ''].filter(Boolean).join(', '))}</div>
        </div>`
        : '';
    const boots = items.boots?.length
        ? `<div class="ov-choices-row"><p class="ov-label">Boots</p><div class="ov-choices"><span class="ov-choice">${items.boots.map((id) => itemIcon(id, owned)).join('')}<span class="ov-choice-wr">${escHtml(rateText(items.bootsStats))}</span><span class="ov-choice-pick">${escHtml(pickText(items.bootsStats))}</span></span></div></div>`
        : '';
    const anyOptions = ['fourth', 'fifth', 'sixth'].some((k) => opts[k]?.length);
    ovItemsContent.innerHTML = `
        <div class="ov-build-head">
            <img src="${escHtml(champIconUrlFromKey(myChampKey))}" alt="" data-fallback="logo">
            <span class="ov-build-title">Item builds</span>
            <span class="ov-build-sub">OP.GG</span>
        </div>
        ${core ? `<p class="ov-label">Core build</p>${core}` : ''}
        ${boots}
        ${itemChoicesRow('4th item', opts.fourth, owned)}
        ${itemChoicesRow('5th item', opts.fifth, owned)}
        ${itemChoicesRow('6th item', opts.sixth, owned)}
        ${!anyOptions && items.late?.length ? itemRow('Later', items.late) : ''}`;
}

// ── Players panel ─────────────────────────────────────────────────────────────
function loadingRow(p) {
    const tier = tierName(p.tier);
    const lp = p.lp ? String(p.lp).replace(/\s*LP$/i, '') : '';
    const rank = tier
        ? `<span class="ov-rank tier-${tier}"><img src="assets/ranks/${tier}.png" alt="">${escHtml(tierAbbr(p.tier))}${lp ? ` ${escHtml(lp)}` : ''}</span>`
        : `<span class="ov-rank">${p.failed ? '?' : 'Unranked'}</span>`;
    return `<div class="ov-player${p.isSelf ? ' is-me' : ''}">
        <span class="ov-player-champ"><img class="ov-player-icon" src="${escHtml(champIconUrlFromKey(p.champion))}" alt="" data-fallback="logo" data-tip="${escHtml(p.championName || p.champion || '')}"></span>
        <span class="ov-player-main">
            <span class="ov-player-name">${escHtml(p.gameName)}</span>
            ${tagsHtml(p, p.championName || p.champion)}
        </span>
        <span class="ov-player-side">${rank}<span class="ov-sub"><span class="ov-wr">${escHtml(p.ratio || '')}</span></span></span>
    </div>`;
}

function renderLoadingPanel() {
    const mine = loadingPlayers.filter((p) => p.team === 'mine');
    const theirs = loadingPlayers.filter((p) => p.team !== 'mine');
    const block = (title, list) => (list.length ? `<div class="ov-team"><p class="ov-label">${escHtml(title)}</p>${list.map(loadingRow).join('')}</div>` : '');
    ovRankedContent.innerHTML = loadingPlayers.length
        ? block('Your team', mine) + block('Enemies', theirs)
        : '<p class="ov-msg">Looking up the players...</p>';
}

async function loadLoadingScreen() {
    const res = await window.overlayAPI.fetchLoading().catch(() => null);
    if (phase !== 'GameStart') return;
    loadingPlayers = res?.players || [];
    if (openPanel === 'players') renderLoadingPanel();
    // The client may not list everyone yet; ask again shortly.
    if (!loadingPlayers.length) setTimeout(() => { if (phase === 'GameStart') loadLoadingScreen(); }, 3000);
}

window.overlayAPI.onPhase((p) => {
    const was = phase;
    phase = p;
    if (p === 'GameStart' && was !== 'GameStart') {
        loadingPlayers = [];
        if (!ovShowRankedToggle.checked) return; // players switched off
        if (openPanel !== 'players') showPanel('players');
        renderLoadingPanel();
        loadLoadingScreen();
    } else if (p === 'InProgress' && was === 'GameStart') {
        loadingPlayers = [];
        if (openPanel === 'players') showPanel('players'); // close the loading list
    }
});

// Holding Tab in the game shows the players (as Porofessor does); letting go
// goes back to what was open.
window.overlayAPI.onTab((down) => {
    if (!ovShowRankedToggle.checked) return; // players switched off
    if (down) {
        if (tabPeek !== null) return;
        tabPeek = openPanel || '';
        if (openPanel !== 'players') showPanel('players');
    } else if (tabPeek !== null) {
        const back = tabPeek;
        tabPeek = null;
        if (back !== 'players') showPanel(back || null);
    }
});

function renderRankedPanel() {
    if (phase === 'GameStart' || (!allPlayers.length && loadingPlayers.length)) { renderLoadingPanel(); return; }
    if (!allPlayers.length) {
        ovRankedContent.innerHTML = '<p class="ov-msg">Waiting for the game...</p>';
        return;
    }
    const me = allPlayers.find((p) => isMe(p));
    const myTeam = me?.team || 'ORDER';
    const mine = allPlayers.filter((p) => p.team === myTeam);
    const theirs = allPlayers.filter((p) => p.team !== myTeam);
    ovRankedContent.innerHTML = teamBlock('Your team', mine) + teamBlock('Enemies', theirs)
        + (rankedLoading ? '<p class="ov-msg">Looking up ranks...</p>' : '');
}

// The full Riot ID when the game gives one (two players can share a name).
let myRiotId = null;
function isMe(p) {
    if (myRiotId && p.riotId) return p.riotId === myRiotId;
    return !!myName && (p.summonerName === myName || p.riotIdGameName === myName);
}

function teamBlock(title, players) {
    if (!players.length) return '';
    return `<div class="ov-team"><p class="ov-label">${escHtml(title)}</p>${players.map(playerRow).join('')}</div>`;
}

function playerRow(p) {
    const opp = Stats.laneOpponent(myPlayer(), allPlayers);
    const name = p.riotIdGameName || p.summonerName || '?';
    const rd = rankedData[playerRiotKey(p)];
    const tier = tierName(rd?.tier);
    const lp = rd?.lp ? String(rd.lp).replace(/\s*LP$/i, '') : '';
    const rank = tier
        ? `<span class="ov-rank tier-${tier}"><img src="assets/ranks/${tier}.png" alt="">${escHtml(tierAbbr(rd.tier))}${lp ? ` ${escHtml(lp)}` : ''}</span>`
        : `<span class="ov-rank">${rd ? 'Unranked' : '...'}</span>`;
    const k = p.scores?.kills ?? 0;
    const d = p.scores?.deaths ?? 0;
    const a = p.scores?.assists ?? 0;
    const items = (p.items || []).filter((it) => it.itemID && it.slot !== 6)
        .map((it) => `<img src="${escHtml(itemIconUrl(it.itemID))}" alt="" data-tip="${escHtml(itemNames[it.itemID] || it.displayName || it.itemID)}" data-fallback="hide">`).join('');
    const isOpp = opp && p === opp;
    return `<div class="ov-player${isMe(p) ? ' is-me' : ''}${isOpp ? ' is-opponent' : ''}${p.isDead ? ' is-dead' : ''}">
        <span class="ov-player-champ">
            <img class="ov-player-icon" src="${escHtml(champIconUrl(p.rawChampionName, p.championName))}" alt="" data-fallback="logo" data-tip="${escHtml(p.championName || '')}">
            <span class="ov-player-level">${escHtml(p.level || 1)}</span>
        </span>
        <span class="ov-player-main">
            <span class="ov-player-name">${escHtml(name)}${isOpp ? '<span class="ov-vs">vs you</span>' : ''}</span>
            ${tagsHtml(rd, p.championName)}
            <span class="ov-player-items">${items}</span>
        </span>
        <span class="ov-player-side">
            ${rank}
            <span class="ov-sub"><span class="ov-wr">${escHtml(rd?.ratio || '')}</span><span class="ov-pkda">${escHtml([k, d, a].join('/'))}</span></span>
        </span>
    </div>`;
}

function tagsHtml(rd, championName) {
    const tags = Stats.playerTags(rd, championName);
    const rec = rd && rd.champGames ? `${rd.champGames} games, ${Math.round((rd.champWins / rd.champGames) * 100)}% on ${championName || 'champ'}` : '';
    if (!tags.length && !rec) return '';
    return `<span class="ov-tags">${tags.map((t) => `<span class="ov-tag is-${escHtml(t.tone)}">${escHtml(t.text)}</span>`).join('')}${rec ? `<span class="ov-champ-rec">${escHtml(rec)}</span>` : ''}</span>`;
}

function triggerRankedFetch(retryPlayers) {
    if (!retryPlayers) {
        if (rankedFetched) return;
        rankedFetched = true;
    }
    rankedLoading = true;
    const source = retryPlayers || allPlayers;
    const playerList = source.map((p) => ({
        gameName: p.riotIdGameName || null,
        tagLine: p.riotIdTagLine || null,
        summonerName: p.summonerName || null,
        championName: p.championName || null,
    }));
    window.overlayAPI.fetchRanked(playerList)
        .then((data) => {
            rankedData = { ...rankedData, ...(data || {}) };
            rankedLoading = false;
            if (openPanel === 'players') renderRankedPanel();
            // Lookups that failed (the client had not cached the player yet, a
            // short API error) get a couple of retries.
            if (rankedRetryCount < MAX_RANKED_RETRIES) {
                const failed = new Set(Object.entries(data || {}).filter(([, v]) => v?.failed).map(([k]) => k));
                const retrySet = allPlayers.filter((p) => failed.has(playerRiotKey(p)));
                if (retrySet.length) {
                    rankedRetryCount++;
                    setTimeout(() => triggerRankedFetch(retrySet), 3000);
                }
            }
        })
        .catch(() => {
            if (!retryPlayers) rankedFetched = false;
            rankedLoading = false;
            if (openPanel === 'players') renderRankedPanel();
        });
}

// ── Dragging (by the bar) ─────────────────────────────────────────────────────
// Pointer capture keeps the moves coming when the pointer leaves the window.
const ovBar = $('ovBar');
let drag = null;
ovBar.addEventListener('pointerdown', async (e) => {
    if (overlayLocked || e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    ovBar.setPointerCapture(e.pointerId);
    const start = { x: e.screenX, y: e.screenY };
    drag = { start, win: null, pointerId: e.pointerId };
    ovBar.classList.add('is-dragging');
    drag.win = await window.overlayAPI.getPosition();
});
ovBar.addEventListener('pointermove', (e) => {
    if (!drag?.win) return;
    window.overlayAPI.moveWindow(drag.win.x + e.screenX - drag.start.x, drag.win.y + e.screenY - drag.start.y);
});
function endDrag() {
    if (!drag) return;
    drag = null;
    ovBar.classList.remove('is-dragging');
    window.overlayAPI.savePosition();
}
ovBar.addEventListener('pointerup', endDrag);
ovBar.addEventListener('pointercancel', endDrag);

// Clicks reach the overlay only while the pointer is over it; elsewhere they
// go through to the game.
document.addEventListener('mouseenter', () => window.overlayAPI.setInteractive(true));
document.addEventListener('mouseleave', () => {
    if (drag) return; // still dragging outside the window
    window.overlayAPI.setInteractive(false);
    ovTip.hidden = true;
});

// ── Tooltips (data-tip) ──────────────────────────────────────────────────────
document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-tip]');
    if (!el || !el.dataset.tip) { ovTip.hidden = true; return; }
    ovTip.textContent = el.dataset.tip;
    ovTip.hidden = false;
    const r = el.getBoundingClientRect();
    const left = Math.min(r.left, ovRoot.offsetWidth - ovTip.offsetWidth - 4);
    ovTip.style.left = `${Math.max(4, left)}px`;
    ovTip.style.top = `${r.bottom + 4}px`;
});

// ── Settings panel ────────────────────────────────────────────────────────────
function applyOpacity(v) {
    ovRoot.style.opacity = v;
}

ovOpacitySlider.addEventListener('input', () => {
    const pct = parseInt(ovOpacitySlider.value, 10);
    ovOpacityVal.textContent = `${pct}%`;
    applyOpacity(pct / 100);
});
ovOpacitySlider.addEventListener('change', () => {
    window.overlayAPI.setOpacity(parseInt(ovOpacitySlider.value, 10) / 100);
});
function setSeg(seg, value) {
    seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === String(value))));
}
ovHotkeySeg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    setSeg(ovHotkeySeg, b.dataset.value);
    window.overlayAPI.saveSettings({ hotkey: b.dataset.value });
});
ovCsGoalSeg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    csGoal = parseInt(b.dataset.value, 10) || 8;
    setSeg(ovCsGoalSeg, csGoal);
    window.overlayAPI.saveSettings({ csGoal });
    if (openPanel === 'game') renderGamePanel();
});
ovLockToggle.addEventListener('change', () => {
    setLocked(ovLockToggle.checked);
    window.overlayAPI.saveSettings({ locked: overlayLocked });
});
ovShowRankedToggle.addEventListener('change', () => {
    showButton(ovToggle, 'players', ovShowRankedToggle.checked);
    window.overlayAPI.saveSettings({ showRanked: ovShowRankedToggle.checked });
});
ovShowBuildsToggle.addEventListener('change', () => {
    showButton(ovBuildToggle, 'build', ovShowBuildsToggle.checked);
    showButton(ovItemsToggle, 'items', ovShowBuildsToggle.checked);
    window.overlayAPI.saveSettings({ showBuilds: ovShowBuildsToggle.checked });
});

function setLocked(on) {
    overlayLocked = !!on;
    ovLockToggle.checked = overlayLocked;
    ovRoot.classList.toggle('is-locked', overlayLocked);
}

function showButton(btn, panel, on) {
    btn.hidden = !on;
    if (!on && openPanel === panel) showPanel(panel);
}

// Settings changed in the app's Settings page.
window.overlayAPI.onSettingsUpdate((s) => {
    if (s.showRanked !== undefined) { ovShowRankedToggle.checked = s.showRanked; showButton(ovToggle, 'players', s.showRanked); }
    if (s.showBuilds !== undefined) { ovShowBuildsToggle.checked = s.showBuilds; showButton(ovBuildToggle, 'build', s.showBuilds); showButton(ovItemsToggle, 'items', s.showBuilds); }
    if (s.locked !== undefined) setLocked(s.locked);
});

// ── Game events ───────────────────────────────────────────────────────────────
window.overlayAPI.onGepGameEvent((data) => {
    if (!data?.feature) return;
    const k = data.key || data.feature;
    if (k === 'kill') kills++;
    if (k === 'death') { deaths++; onDeath(); }
    if (k === 'assist') assists++;
    updateBar();
});

window.overlayAPI.onGepInfoUpdate((data) => {
    if (!data?.feature) return;
    switch (data.feature) {
        case 'matchState': {
            if (data.key !== 'matchState') break;
            if (data.value === 'InProgress') startTimer();
            else if (data.value === 'EndOfGame' || data.value === 'PreGame') resetAll();
            break;
        }
        case 'live_client_data': {
            onLiveData(data.key, tryParse(data.value));
            updateBar();
            break;
        }
        case 'summoner_info': {
            if (data.key === 'cs') cs = parseInt(data.value, 10) || cs;
            if (data.key === 'gold') gold = parseInt(data.value, 10) || gold;
            if (data.key === 'level') level = parseInt(data.value, 10) || level;
            updateBar();
            break;
        }
    }
});

function onLiveData(key, value) {
    if (!value) return;
    if (key === 'game_data') {
        if (value.gameTime) {
            gameTime = Math.floor(parseFloat(value.gameTime));
            if (!timerTick) startTimer();
        }
        if (value.gameMode && value.gameMode !== myGameMode) {
            myGameMode = value.gameMode;
            buildFetched = false;
            buildData = null;
        }
    } else if (key === 'events') {
        if (Array.isArray(value.Events)) gameEvents = value.Events;
        if (openPanel === 'game') renderGamePanel();
    } else if (key === 'active_player') {
        myName = value.riotIdGameName || value.summonerName || myName;
        myRiotId = value.riotId || myRiotId;
        level = value.level ?? level;
        gold = Math.floor(value.currentGold ?? gold);
    } else if (key === 'all_players' && Array.isArray(value)) {
        allPlayers = value;
        const me = value.find(isMe);
        if (me) {
            if (me.isDead === true && !isDead) onDeath();
            if (me.isDead === false && isDead) onRespawn();
            // The game's respawn time, not the estimate.
            if (isDead && typeof me.respawnTimer === 'number' && me.respawnTimer > 0) {
                respawnAt = Date.now() + me.respawnTimer * 1000;
                respawnTotal = Math.max(respawnTotal, me.respawnTimer);
            }
            kills = me.scores?.kills ?? kills;
            deaths = me.scores?.deaths ?? deaths;
            assists = me.scores?.assists ?? assists;
            level = me.level ?? level;
            cs = me.scores?.creepScore ?? cs;
            const iconUrl = champIconUrl(me.rawChampionName, me.championName);
            if (ovChamp.src !== iconUrl) ovChamp.src = iconUrl;
            const champKey = champDDKey(me.rawChampionName, me.championName);
            const pos = me.position && me.position !== 'NONE' ? me.position : null;
            if (pos !== myPosition || champKey !== myChampKey) {
                myPosition = pos;
                myChampKey = champKey;
                myChampName = me.championName || champKey;
                buildFetched = false;
                buildData = null;
            }
            if (!buildFetched && myChampKey && openPanel === 'build') triggerBuildFetch();
        }
        if (!rankedFetched && value.length && ovShowRankedToggle.checked) triggerRankedFetch();
        if (openPanel === 'players') renderRankedPanel();
        if (openPanel === 'build') renderBuildPanel();
        if (openPanel === 'game') renderGamePanel();
    }
}

// ── Init ──────────────────────────────────────────────────────────────────────
window.overlayAPI.onInit((initData) => {
    if (initData?.ddragonVersion) ddragonVersion = initData.ddragonVersion;
    if (initData?.champKeyMap) champKeyMap = initData.champKeyMap;
    if (initData?.itemNames) itemNames = initData.itemNames;

    const opacity = typeof initData?.opacity === 'number' ? initData.opacity : 1.0;
    applyOpacity(opacity);
    ovOpacitySlider.value = Math.round(opacity * 100);
    ovOpacityVal.textContent = `${Math.round(opacity * 100)}%`;
    setSeg(ovHotkeySeg, initData?.hotkey || 'Ctrl+Shift+H');
    setLocked(initData?.locked);
    if ([6, 7, 8, 9, 10].includes(initData?.csGoal)) csGoal = initData.csGoal;
    setSeg(ovCsGoalSeg, csGoal);
    const showRanked = initData?.showRanked !== false;
    const showBuilds = initData?.showBuilds !== false;
    ovShowRankedToggle.checked = showRanked;
    ovShowBuildsToggle.checked = showBuilds;
    showButton(ovToggle, 'players', showRanked);
    showButton(ovBuildToggle, 'build', showBuilds);
    showButton(ovItemsToggle, 'items', showBuilds);
});

updateBar();
