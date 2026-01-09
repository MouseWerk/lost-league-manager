const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const axios = require('axios');
const https = require('https');

class LCUConnector {
    constructor() {
        this.credentials = null;
        this.ws = null;
        this.handlers = [];
        this.connected = false;
        this.pollInterval = null;
    }

    start() {
        this.pollInterval = setInterval(() => this.tryConnect(), 2000);
    }

    stop() {
        if (this.pollInterval) clearInterval(this.pollInterval);
        if (this.ws) this.ws.close();
    }

    tryConnect() {
        if (this.connected) return;

        // Try to find lockfile
        // Standard path or check process? 
        // We can just check the default install location or process arguments if we were running ps-node, 
        // but for simplicity let's assume standard path or config path.
        // Actually, getting it from process list is more robust if user installed elsewhere.
        // For now, let's look in the configured path from main.js if possible, but simpler:
        // Lockfile is at {LeaguePath}/lockfile
        
        // We will need the path passed to us or find it. 
        // Let's assume standard location for now or require it to be passed.
    }

    // Helper to parse lockfile
    async getLockfileData(leaguePath) {
        const lockfilePath = path.join(path.dirname(leaguePath), 'lockfile');
        if (!fs.existsSync(lockfilePath)) return null;

        try {
            const content = fs.readFileSync(lockfilePath, 'utf8');
            const [processName, pid, port, password, protocol] = content.split(':');
            return { port, password, protocol };
        } catch (e) {
            return null;
        }
    }

    async connect(leaguePath) {
        if (this.connected) return;

        const data = await this.getLockfileData(leaguePath);
        if (!data) return;

        this.credentials = data;
        const url = `wss://riot:${data.password}@127.0.0.1:${data.port}`;

        this.ws = new WebSocket(url, {
            rejectUnauthorized: false
        });

        this.ws.on('open', () => {
            this.connected = true;
            console.log('LCU Connected');
            this.ws.send(JSON.stringify([5, "OnJsonApiEvent"])); // Subscribe to all events
        });

        this.ws.on('message', (msg) => {
            if (!msg) return;
            try {
                const json = JSON.parse(msg);
                // Event structure is usually [opcode, eventName, data]
                // For OnJsonApiEvent: [8, "OnJsonApiEvent", { uri, eventType, data }]
                if (json[0] === 8 && json[1] === 'OnJsonApiEvent') {
                    this.handleEvent(json[2]);
                }
            } catch (e) {}
        });

        this.ws.on('close', () => {
            this.connected = false;
            this.ws = null;
        });

        this.ws.on('error', () => {
            this.connected = false;
        });
    }

    handleEvent(event) {
        this.handlers.forEach(h => h(event));
    }

    onEvent(callback) {
        this.handlers.push(callback);
    }

    // API Call helper
    async request(method, endpoint, body = null) {
        if (!this.credentials) return null;
        
        try {
            const agent = new https.Agent({ rejectUnauthorized: false });
            const url = `https://127.0.0.1:${this.credentials.port}${endpoint}`;
            const auth = Buffer.from(`riot:${this.credentials.password}`).toString('base64');
            
            const config = {
                method,
                url,
                headers: {
                    'Authorization': `Basic ${auth}`,
                    'Content-Type': 'application/json'
                },
                httpsAgent: agent
            };
            
            if (body) config.data = body;

            const response = await axios(config);
            return response.data;
        } catch (e) {
            console.error(`LCU Request Error ${endpoint}:`, e.message);
            return null;
        }
    }
}

module.exports = new LCUConnector();
