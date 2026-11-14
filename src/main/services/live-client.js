const axios = require('axios');
const https = require('https');

// Riot's Live Client Data API — a small HTTP server the game itself runs on
// 127.0.0.1:2999 while you're in a match. It ships with League, needs no auth,
// no API key and no third-party runtime, which is why the build reminder reads
// gold from here rather than from the Overwolf events provider.
//
// The cert it presents is Riot's own self-signed one, so verification has to be
// off for this host. That's safe here: the request never leaves the loopback
// interface.
const HTTPS_BASE = 'https://127.0.0.1:2999/liveclientdata';
const HTTP_BASE  = 'http://127.0.0.1:2999/liveclientdata';
const agent = new https.Agent({ rejectUnauthorized: false });

const IDLE_MS = 5000;   // no game running — just probing
const LIVE_MS = 1000;   // in a match — gold changes constantly

let timer = null;
let running = false;
let inGame = false;
let base = HTTPS_BASE;
let baseConfirmed = false;

const snapshotHandlers = [];
const endHandlers = [];

async function get(url) {
    const res = await axios.get(url, {
        httpsAgent: agent,
        timeout: 2500,
        validateStatus: (s) => s === 200,
    });
    return res.data;
}

// Everything the reminder needs (gold, champion, inventory) in one request.
// Returns null whenever there's no match in progress — including the loading
// screen, where the server is up but answers with errors.
async function fetchSnapshot() {
    try {
        const data = await get(`${base}/allgamedata`);
        baseConfirmed = true;
        return data;
    } catch { /* try the other scheme below, if we haven't pinned one yet */ }

    if (baseConfirmed) return null;
    const alt = base === HTTPS_BASE ? HTTP_BASE : HTTPS_BASE;
    try {
        const data = await get(`${alt}/allgamedata`);
        base = alt;
        baseConfirmed = true;
        console.log(`[LiveClient] Using ${alt}`);
        return data;
    } catch {
        return null;
    }
}

function emit(handlers, arg) {
    for (const cb of handlers) {
        try { cb(arg); } catch (e) { console.error('[LiveClient] handler error:', e.message); }
    }
}

async function tick() {
    if (!running) return;

    const data = await fetchSnapshot();
    if (data) {
        if (!inGame) {
            inGame = true;
            console.log('[LiveClient] Match detected');
        }
        emit(snapshotHandlers, data);
    } else if (inGame) {
        inGame = false;
        console.log('[LiveClient] Match ended');
        emit(endHandlers);
    }

    schedule(inGame ? LIVE_MS : IDLE_MS);
}

// A self-rescheduling timeout rather than setInterval: a slow or hanging
// request can't stack a queue of overlapping polls behind it.
function schedule(ms) {
    if (!running) return;
    clearTimeout(timer);
    timer = setTimeout(tick, ms);
}

function start() {
    if (running) return;
    running = true;
    console.log('[LiveClient] Watching for a live match on 127.0.0.1:2999');
    schedule(500);
}

function stop() {
    running = false;
    clearTimeout(timer);
    timer = null;
    inGame = false;
}

module.exports = {
    start,
    stop,
    onSnapshot: (cb) => snapshotHandlers.push(cb),
    onGameEnd:  (cb) => endHandlers.push(cb),
    isInGame:   () => inGame,
};
