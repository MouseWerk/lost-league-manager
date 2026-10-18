require('./helpers/fake-electron');
const Module = require('module');
const { EventEmitter } = require('events');
const test = require('node:test');
const assert = require('node:assert/strict');

const activities = [];
const created = [];
class FakeClient extends EventEmitter {
    constructor() {
        super();
        this.isConnected = false;
        this.user = { username: 'tester', setActivity: async (a) => { activities.push(a.details); } };
        created.push(this);
    }
    async login() {
        // Discord not answering: the login stays pending.
        if (FakeClient.hangLogin) return new Promise(() => {});
        this.isConnected = true;
        setImmediate(() => this.emit('ready'));
    }
    async destroy() { this.isConnected = false; }
}

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === '@xhayper/discord-rpc') return { Client: FakeClient };
    return originalLoad.call(this, request, parent, isMain);
};

const discordRpc = require('../src/main/services/discord-rpc');

// Re-sending the same status resets Discord's "elapsed" timer, so repeats
// (e.g. one per LCU reconnect poll) must not reach Discord.
test('an unchanged status is sent to Discord only once', async () => {
    discordRpc.init();
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    assert.deepEqual(activities, ['Managing Accounts']);

    discordRpc.setIdle();
    discordRpc.setIdle();
    assert.deepEqual(activities, ['Managing Accounts']);

    discordRpc.setGameflowPhase('Lobby');
    discordRpc.setGameflowPhase('Lobby');
    assert.deepEqual(activities, ['Managing Accounts', 'In Lobby']);

    discordRpc.shutdown();
});

// Toggling off and on while a login was pending waited for the old login to
// time out plus the 15 s retry; the old client kept its listeners; and the
// status fell back to "Managing Accounts" even in a game.
test('re-enabling during a pending login connects right away and keeps the current status', async () => {
    activities.length = 0;
    created.length = 0;
    FakeClient.hangLogin = true;
    discordRpc.setEnabled(true);
    assert.equal(created.length, 1);
    discordRpc.setGameflowPhase('InProgress');

    discordRpc.setEnabled(false);
    assert.equal(created[0].listenerCount('ready'), 0, 'old client keeps no listeners');
    FakeClient.hangLogin = false;
    discordRpc.setEnabled(true);
    assert.equal(created.length, 2, 'a new client is created immediately');
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    assert.deepEqual(activities, ['In Game']);

    discordRpc.shutdown();
});
