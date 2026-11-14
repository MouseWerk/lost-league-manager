const { Notification } = require('electron');
const path = require('path');
const state = require('../state');
const buildPaths = require('./build-paths');
const championData = require('./champion-data');
const liveClient = require('./live-client');

// Watches live gold and fires one reminder per build-path step the moment the
// player can afford it ("650g — buy Boots + Dark Seal").
//
// The data comes straight from the game's own Live Client Data API via
// live-client.js, so this works with nothing but League running. Delivery is
// our own always-on-top popup window (windows.js), optionally a Windows toast,
// plus the app window and the overlay when either is up.

// Back-to-back steps (a plan with 650 and 700 thresholds, say) shouldn't stack
// two popups on top of each other in the same second.
const MIN_NOTIFY_GAP_MS = 6000;

let champKey = null;
let gold     = 0;
let owned    = new Set();
let plan     = null;    // resolved path for champKey, or null when there is none
let steps    = [];      // per-step delivery state, parallel to plan.steps
let lastNotifyAt = 0;

function send(win, channel, payload) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function reset() {
    champKey = null;
    gold = 0;
    owned = new Set();
    plan = null;
    steps = [];
    lastNotifyAt = 0;
}

function loadPlan() {
    plan = buildPaths.resolveForChampion(champKey);
    steps = (plan?.steps || []).map(() => ({ armed: true, skipped: false }));
    if (plan) {
        console.log(`[BuildReminder] ${champKey}: ${plan.steps.length} step(s) in plan`);
    }
}

// A step counts as bought once every item in it is owned — including as a
// component of something bigger, so a Dark Seal step stops nagging after it
// becomes Mejai's (see getOwnershipIds in item-data).
function isStepBought(step) {
    return step.items.every(item => item.ownershipIds.some(id => owned.has(id)));
}

// Only ever looks at the first step still outstanding: a plan is a sequence, so
// hitting 1300g doesn't mean skipping the 650g step you never bought. Crossing
// back below a threshold re-arms that step, which is what turns "you forgot to
// buy your Dark Seal" into a second ping on the next back instead of silence.
function evaluate() {
    if (state.config.buildRemindersEnabled === false) return;
    if (!champKey) return;
    if (!plan || plan.champKey !== champKey) loadPlan();
    if (!plan) return;

    for (let i = 0; i < plan.steps.length; i++) {
        const step  = plan.steps[i];
        const local = steps[i];
        if (local.skipped || isStepBought(step)) continue;

        if (gold < step.gold) { local.armed = true; return; }
        if (!local.armed) return;
        if (Date.now() - lastNotifyAt < MIN_NOTIFY_GAP_MS) return;  // retried on the next poll

        local.armed = false;
        lastNotifyAt = Date.now();
        notify(i, step);
        return;
    }
}

function notify(index, step) {
    const itemNames = step.items.map(i => i.name).join(' + ');
    const title = `Buy: ${itemNames}`;
    const body  = `${step.gold}g reached — step ${index + 1}/${plan.steps.length}`;
    console.log(`[BuildReminder] ${title} (${body})`);

    const payload = {
        index,
        gold: step.gold,
        currentGold: gold,
        totalSteps: plan.steps.length,
        champKey,
        items: step.items.map(i => ({ id: i.id, name: i.name, cost: i.cost })),
    };

    // Our own popup: the one delivery that's actually on top of the game.
    if (state.config.buildReminderPopup !== false) {
        try {
            require('../windows').showBuyReminder(payload);
        } catch (e) {
            console.error('[BuildReminder] Popup failed:', e.message);
        }
    }

    if (state.config.buildReminderToast !== false) {
        try {
            new Notification({
                title,
                body,
                icon: path.join(__dirname, '../../renderer/assets/logo.png'),
                silent: false,
            }).show();
        } catch (e) {
            console.error('[BuildReminder] Toast failed:', e.message);
        }
    }

    send(state.overlayWindow, 'build-reminder', payload);
    send(state.mainWindow, 'build-reminder', payload);
}

// Dismisses a step for the rest of the match (the popup's ✕) so a plan the
// player has deliberately deviated from stops asking.
function skipStep(index) {
    if (steps[index]) steps[index].skipped = true;
}

// Every name the game might identify a player by, lowercased, plus the part
// before the '#' — the active player and the roster entry for the same person
// don't always spell it the same way (one carries a bare game name, the other
// a full Riot ID).
function identityKeys(p) {
    const out = new Set();
    for (const value of [p?.riotIdGameName, p?.summonerName, p?.riotId]) {
        if (!value) continue;
        const s = String(value).toLowerCase();
        out.add(s);
        const hash = s.indexOf('#');
        if (hash > 0) out.add(s.slice(0, hash));
    }
    return out;
}

function findMe(players, activePlayer) {
    const mine = identityKeys(activePlayer);
    if (mine.size === 0) return null;
    return players.find(p => [...identityKeys(p)].some(k => mine.has(k))) || null;
}

// One live-client poll: gold from the active player, champion and inventory
// from our row in the roster.
function handleSnapshot(data) {
    const activePlayer = data?.activePlayer;
    const players = data?.allPlayers;
    if (!activePlayer || !Array.isArray(players)) return;

    const g = activePlayer.currentGold ?? activePlayer.championStats?.currentGold;
    if (typeof g === 'number') gold = Math.floor(g);

    const me = findMe(players, activePlayer);
    if (me) {
        const key = championData.resolveChampionKey(me.rawChampionName, me.championName);
        if (key && key !== champKey) {
            champKey = key;
            plan = null;    // re-resolved by evaluate()
        }
        if (Array.isArray(me.items)) {
            owned = new Set(
                me.items.map(it => Number(it.itemID ?? it.itemId ?? it.id)).filter(Number.isInteger)
            );
        }
    }

    evaluate();
}

function init() {
    liveClient.onSnapshot(handleSnapshot);
    liveClient.onGameEnd(reset);
    liveClient.start();
}

module.exports = { init, handleSnapshot, reset, skipStep };
