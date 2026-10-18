const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const lcu = require('../src/main/lcu');

function freePort() {
    return new Promise((resolve) => {
        const srv = net.createServer().listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

async function waitFor(cond, what, timeoutMs = 5000) {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
        await new Promise(r => setTimeout(r, 20));
    }
}

// A lockfile left behind by a closed or crashed client makes every reconnect
// poll fail its handshake. That used to fire the disconnect handlers on each
// poll (every 5 s), resetting the UI and the Discord status each time.
test('a failed handshake against a stale lockfile is not a disconnect', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-lcu-'));
    const port = await freePort(); // nothing listens here
    fs.writeFileSync(path.join(dir, 'lockfile'), `LeagueClient:1234:${port}:secret:https`);

    let disconnects = 0;
    lcu.clearHandlers();
    lcu.onDisconnect(() => disconnects++);

    for (let i = 0; i < 3; i++) {
        await lcu.connect(path.join(dir, 'LeagueClient.exe'));
        await waitFor(() => lcu.ws === null, 'the failed socket to close');
    }
    assert.equal(lcu.connected, false);
    assert.equal(disconnects, 0);
});

test('requests without credentials return null instead of throwing', async () => {
    assert.equal(await lcu.request('GET', '/lol-summoner/v1/current-summoner'), null);
});
