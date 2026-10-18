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

// Killing the client (another launch, Dodge, Fix client, a crash) makes the
// socket emit 'error' before 'close'. The error handler used to clear
// `connected`, so the close handler thought it had never been connected and
// the renderer, Discord and the timers never heard of the disconnect.
test('a socket error before close still fires the disconnect once', async (t) => {
    const WebSocket = require('ws');
    const server = new WebSocket.WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise(r => server.once('listening', r));
    t.after(() => server.close());
    let serverSide = null;
    server.on('connection', (ws) => { serverSide = ws; });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-lcu-'));
    fs.writeFileSync(path.join(dir, 'lockfile'), `LeagueClient:1234:${server.address().port}:secret:http`);

    let connects = 0;
    let disconnects = 0;
    let errors = 0;
    lcu.clearHandlers();
    lcu.onConnect(() => connects++);
    lcu.onDisconnect(() => disconnects++);

    await lcu.connect(path.join(dir, 'LeagueClient.exe'));
    await waitFor(() => connects === 1 && serverSide, 'the connection');
    lcu.ws.on('error', () => errors++);
    // An invalid frame: the client socket emits 'error', then 'close'.
    serverSide._socket.write(Buffer.from([0xff, 0x00]));
    await waitFor(() => lcu.ws === null, 'the socket to close');

    assert.equal(errors, 1, 'the error path was taken');
    assert.equal(disconnects, 1);
    assert.equal(lcu.connected, false);
});

test('requests without credentials return null instead of throwing', async () => {
    assert.equal(await lcu.request('GET', '/lol-summoner/v1/current-summoner'), null);
});
