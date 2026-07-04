const { Client } = require('@xhayper/discord-rpc');
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

// Deliberately excludes any account/summoner identifiers — only the
// League client's coarse gameflow phase is reflected.
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

    client = new Client({ clientId: CLIENT_ID });

    client.on('ready', () => {
        connecting = false;
        console.log('[DiscordRPC] Connected as', client.user?.username ?? 'unknown user');
        if (lastDetails) applyActivity(lastDetails);
    });

    client.on('disconnected', () => {
        connecting = false;
        console.log('[DiscordRPC] Disconnected, will retry');
        scheduleRetry();
    });

    client.login().catch((e) => {
        connecting = false;
        client = null;
        console.log('[DiscordRPC] Login failed (Discord not running?):', e.message);
        scheduleRetry();
    });
}

function applyActivity(details) {
    lastDetails = details;
    if (!isEnabled() || !client?.isConnected || !client.user) return;
    client.user.setActivity({
        details,
        startTimestamp: Date.now(),
        largeImageUrl: LARGE_IMAGE_URL,
        largeImageText: 'Lost League Manager',
        instance: false,
        buttons: BUTTONS,
    }).then(() => console.log('[DiscordRPC] Activity set:', details))
      .catch((e) => console.log('[DiscordRPC] setActivity failed:', e.message));
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
    lastDetails = null;
    if (toDestroy) toDestroy.destroy().catch(() => {});
}

function setEnabled(enabled) {
    if (enabled) init();
    else shutdown();
}

module.exports = { init, shutdown, setEnabled, setGameflowPhase, setIdle };
