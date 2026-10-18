const { fakeElectron } = require('./helpers/fake-electron');
const { EventEmitter } = require('events');
const test = require('node:test');
const assert = require('node:assert/strict');

// registerGames() returns a promise; on machines without the Overwolf game
// service it rejects ("game service utility error"), which used to surface as
// an unhandled promise rejection on every start.
test('a rejected overlay registerGames is handled', async () => {
    const packages = new EventEmitter();
    packages.overlay = Object.assign(new EventEmitter(), {
        registerGames: () => Promise.reject(new Error('game service utility error')),
    });
    fakeElectron.app.overwolf = { disableAnonymousAnalytics: () => {}, packages };

    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    const { initOverwolf } = require('../src/main/overwolf');
    initOverwolf();
    packages.emit('ready', {}, 'overlay', '1.0.0');
    await new Promise(r => setTimeout(r, 50));

    process.off('unhandledRejection', onUnhandled);
    assert.deepEqual(unhandled, []);
});
