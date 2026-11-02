const state = require('../state');

const CLIENT_ID = '1523021601606602902';

// Hosted from this public repo so no manual asset upload in the Discord
// Developer Portal is required — Discord resolves external image URLs
// passed as largeImageUrl/smallImageUrl directly.
const LARGE_IMAGE_URL = 'https://raw.githubusercontent.com/MouseWerk/lost-league-manager/master/src/renderer/assets/logo.png';

// Discord allows at most 2 activity buttons, and only renders them on
// other users' view of the profile — never on your own client.
const BUTTONS = [
    { label: 'Official Website', url: 'https://www.lostleague.com/' },
    { label: 'Download', url: 'https://github.com/MouseWerk/lost-league-manager/releases/latest' },
];

// Never an account or summoner name: the phase, and (Settings > App
// behavior > Show rank and champion) the solo rank and the champion and
// queue of the current game.
const PHASE_LABELS = {
    None: 'In Main Menu',
    Lobby: 'In Lobby',
    Matchmaking: 'In Queue',
    ReadyCheck: 'Accepting Match',
    ChampSelect: 'In Champion Select',
    GameStart: 'Loading Into Game',
    InProgress: 'In Game',
    Reconnect: 'Reconnecting To Game',
    WaitingForStats: 'Post-Game',
    PreEndOfGame: 'Post-Game',
    EndOfGame: 'Post-Game',
};

const RETRY_DELAY_MS = 15000;
const IDLE_LABEL = 'Managing Accounts';

const EMBLEM_URL = (tier) => `https://raw.githubusercontent.com/MouseWerk/lost-league-manager/master/src/renderer/assets/ranks/${tier}.png`;
const TIERS = ['iron', 'bronze', 'silver', 'gold', 'platinum', 'emerald', 'diamond', 'master', 'grandmaster', 'challenger'];

// Rank and game of the signed-in player: { rank, tier, champion, championIcon, queue }.
let context = {};

let client = null;
let connecting = false;
let retryTimer = null;
let lastDetails = null;

function isEnabled() {
    return !!CLIENT_ID && state.config.discordRpcEnabled !== false;
}

function scheduleRetry() {
    if (retryTimer || !isEnabled()) return;
    retryTimer = setTimeout(() => {
        retryTimer = null;
        connect();
    }, RETRY_DELAY_MS);
}

function connect() {
    if (!isEnabled() || connecting || (client && client.isConnected)) return;
    connecting = true;

    // A dead instance from an earlier connection must not keep its listeners.
    discard(client);
    // Loaded here: the library takes about half a second to require.
    const { Client } = require('@xhayper/discord-rpc');
    const c = new Client({ clientId: CLIENT_ID });
    client = c;

    // Events from an instance that was replaced or shut down are ignored.
    c.on('ready', () => {
        if (c !== client) return;
        connecting = false;
        console.log('[DiscordRPC] Connected as', c.user?.username ?? 'unknown user');
        if (lastDetails) applyActivity(lastDetails, { force: true });
    });

    c.on('disconnected', () => {
        if (c !== client) return;
        connecting = false;
        console.log('[DiscordRPC] Disconnected, will retry');
        appliedDetails = null;
        scheduleRetry();
    });

    c.login().catch((e) => {
        if (c !== client) return;
        connecting = false;
        discard(c);
        client = null;
        console.log('[DiscordRPC] Login failed (Discord not running?):', e.message);
        scheduleRetry();
    });
}

function discard(c) {
    if (!c) return;
    c.removeAllListeners?.();
    Promise.resolve().then(() => c.destroy()).catch(() => {});
}

let appliedDetails = null;

function showsDetails() {
    return state.config.discordShowDetails !== false;
}

// The activity for a phase label and the current context.
function buildActivity(details) {
    const c = showsDetails() ? context : {};
    const parts = [c.champion && c.queue ? `${c.champion}, ${c.queue}` : c.champion || '', c.rank || ''].filter(Boolean);
    const activity = {
        details,
        largeImageUrl: c.championIcon || LARGE_IMAGE_URL,
        largeImageText: c.champion || 'Lost League Manager',
        instance: false,
        buttons: BUTTONS,
    };
    if (parts.length) activity.state = parts.join(' | ').slice(0, 128);
    if (c.tier && TIERS.includes(c.tier)) {
        activity.smallImageUrl = EMBLEM_URL(c.tier);
        activity.smallImageText = c.rank || c.tier;
    }
    return activity;
}

function applyActivity(details, { force = false } = {}) {
    lastDetails = details;
    if (!isEnabled() || !client?.isConnected || !client.user) return;
    const activity = buildActivity(details);
    // Re-sending the same status would reset its "elapsed" timer.
    const key = JSON.stringify(activity);
    if (!force && key === appliedDetails) return;
    appliedDetails = key;
    client.user.setActivity({ ...activity, startTimestamp: Date.now() })
        .then(() => console.log('[DiscordRPC] Activity set:', details))
        .catch((e) => console.log('[DiscordRPC] setActivity failed:', e.message));
}

// New rank or game: the status follows (same phase label).
function setContext(next) {
    context = next && typeof next === 'object' ? next : {};
    if (lastDetails) applyActivity(lastDetails);
}

function setGameflowPhase(phase) {
    applyActivity(PHASE_LABELS[phase] || IDLE_LABEL);
}

function setIdle() {
    applyActivity(IDLE_LABEL);
}

function init() {
    if (!isEnabled()) return;
    if (!lastDetails) lastDetails = IDLE_LABEL;
    connect();
}

function shutdown() {
    if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
    }
    const toDestroy = client;
    client = null;
    // A login still pending must not block an immediate re-enable. The last
    // status (lastDetails) is kept so re-enabling shows the current phase.
    connecting = false;
    appliedDetails = null;
    discard(toDestroy);
}

function setEnabled(enabled) {
    if (enabled) init();
    else shutdown();
}

module.exports = { init, shutdown, setEnabled, setGameflowPhase, setIdle, setContext, buildActivity };
