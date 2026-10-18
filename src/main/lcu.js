const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const axios = require('axios');
const https = require('https');

// One keep-alive agent for every LCU call instead of a new TLS agent per request.
const lcuAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

class LCUConnector {
    constructor() {
        this.credentials = null;
        this.ws = null;
        this.handlers = [];
        this.connectHandlers = [];
        this.disconnectHandlers = [];
        this.connected = false;
    }

    stop() {
        if (this.ws) {
            try { this.ws.terminate(); } catch {}
            this.ws = null;
        }
    }

    async getLockfileData(leaguePath) {
        const lockfilePath = path.join(path.dirname(leaguePath), 'lockfile');
        if (!fs.existsSync(lockfilePath)) return null;

        try {
            const content = fs.readFileSync(lockfilePath, 'utf8');
            const [, , port, password, protocol] = content.split(':');
            return { port, password, protocol };
        } catch (e) {
            return null;
        }
    }

    async connect(leaguePath) {
        // Also bail if a handshake is already in flight (this.ws set but not yet
        // 'open'/'closed') — the 5s reconnect poll would otherwise terminate and
        // replace an in-progress socket every tick during a slow LCU startup,
        // preventing the handshake from ever completing.
        if (this.connected || this.ws) return;

        const data = await this.getLockfileData(leaguePath);
        if (!data) return;

        this.credentials = data;
        const url = `wss://riot:${data.password}@127.0.0.1:${data.port}`;

        const socket = new WebSocket(url, { rejectUnauthorized: false });
        this.ws = socket;

        socket.on('open', () => {
            if (this.ws !== socket) return;
            this.connected = true;
            console.log('LCU Connected');
            socket.send(JSON.stringify([5, 'OnJsonApiEvent']));
            this.connectHandlers.forEach(h => h());
        });

        socket.on('message', (msg) => {
            if (!msg || this.ws !== socket) return;
            try {
                const json = JSON.parse(msg);
                if (json[0] === 8 && json[1] === 'OnJsonApiEvent') {
                    this.handleEvent(json[2]);
                }
            } catch {}
        });

        socket.on('close', () => {
            if (this.ws !== socket) return;
            const wasConnected = this.connected;
            this.connected = false;
            this.ws = null;
            this.credentials = null;
            // A stale lockfile (client closed/crashed) makes every 5s poll fail
            // the handshake — only a real connected→closed transition is a
            // disconnect, otherwise the UI and Discord status got reset every poll.
            if (wasConnected) this.disconnectHandlers.forEach(h => h());
        });

        socket.on('error', () => {
            if (this.ws !== socket) return;
            this.connected = false;
        });
    }

    handleEvent(event) {
        this.handlers.forEach(h => h(event));
    }

    onEvent(callback)      { this.handlers.push(callback); }
    onConnect(callback)    { this.connectHandlers.push(callback); }
    onDisconnect(callback) { this.disconnectHandlers.push(callback); }

    clearHandlers() {
        this.handlers = [];
        this.connectHandlers = [];
        this.disconnectHandlers = [];
    }

    // API Call helper. opts.verbose logs the status even for 404/400/500 —
    // for probing multiple candidate endpoints (e.g. mastery) where those
    // codes are the actual signal needed to tell which one is wrong, instead
    // of silently discarding it like the default suppression does.
    async request(method, endpoint, body = null, opts = {}) {
        if (!this.credentials) return null;

        try {
            const url = `https://127.0.0.1:${this.credentials.port}${endpoint}`;
            const auth = Buffer.from(`riot:${this.credentials.password}`).toString('base64');

            const config = {
                method,
                url,
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Content-Type': 'application/json'
                },
                httpsAgent: lcuAgent,
                // A wedged client used to hang callers forever (no timeout).
                timeout: opts.timeout || 8000,
            };

            if (body) config.data = body;

            const response = await axios(config);
            return response.data;
        } catch (e) {
            const status = e.response?.status;
            // 404/400/500 on LCU endpoints are expected during client startup or
            // when an endpoint doesn't exist in the current client version — don't spam the log
            if (opts.verbose || (status !== 404 && status !== 400 && status !== 500)) {
                console.error(`LCU Request Error ${endpoint}:`, status, e.message);
            }
            return null;
        }
    }
}

module.exports = new LCUConnector();
