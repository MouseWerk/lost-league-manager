require('./helpers/fake-electron');
const Module = require('module');
const { EventEmitter } = require('events');
const test = require('node:test');
const assert = require('node:assert/strict');

const activities = [];
class FakeClient extends EventEmitter {
    constructor() {
        super();
        this.isConnected = false;
        this.user = { username: 'tester', setActivity: async (a) => { activities.push(a.details); } };
    }
    async login() {
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
