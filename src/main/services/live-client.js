const axios = require('axios');
const https = require('https');

// Riot's Live Client Data API, served by the running game on this machine.
// It only speaks HTTPS with a self-signed certificate; plain http never
// answered, so the Live view's game clock and HP stayed empty.
const BASE = 'https://127.0.0.1:2999/liveclientdata/';
const agent = new https.Agent({ rejectUnauthorized: false });

async function liveClientGet(path, timeout = 2000) {
    const res = await axios.get(BASE + path, { timeout, httpsAgent: agent });
    return res.data;
}

module.exports = { liveClientGet, LIVE_CLIENT_BASE: BASE };
