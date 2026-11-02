// Start-up speed: the modules the main process loads before the window opens
// must not pull in the large libraries (axios, electron-updater, the Discord
// RPC client) or derive keys with scrypt. Each of those cost 150-500 ms
// before the first paint; they now load on first use.
require('./helpers/a-fakes');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const path = require('path');

test('booting the main process loads no large library and runs no scrypt', () => {
    let scrypts = 0;
    const realScrypt = crypto.scryptSync;
    crypto.scryptSync = (...args) => { scrypts++; return realScrypt(...args); };
    try {
        for (const m of ['lcu', 'lcu-events', 'windows', 'overwolf', 'ipc/index', 'ipc/updater', 'ipc/launch',
            'services/storage', 'services/encryption', 'services/discord-rpc', 'services/champion-data', 'services/item-data']) {
            require(path.join('..', 'src', 'main', m));
        }
    } finally {
        crypto.scryptSync = realScrypt;
    }
    const loaded = Object.keys(require.cache).map(p => p.replace(/\\/g, '/'));
    for (const lib of ['/node_modules/axios/', '/node_modules/electron-updater/', '/node_modules/@xhayper/discord-rpc/']) {
        assert.ok(!loaded.some(p => p.includes(lib)), `${lib} is loaded at start-up`);
    }
    assert.equal(scrypts, 0, 'no key is derived at start-up');
});

test('the lazy HTTP client is axios once used', async () => {
    const http = require('../src/main/services/http');
    const axios = require('axios');
    assert.equal(typeof http.get, 'function');
    assert.equal(http.isAxiosError(new axios.AxiosError('x')), true);
});

test('the window loads nothing from the internet before it can paint', () => {
    const fs = require('fs');
    const renderer = path.join(__dirname, '..', 'src', 'renderer');
    const html = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8');
    const external = [...html.matchAll(/<(?:link|script)\b[^>]*(?:href|src)="(https?:[^"]+)"/g)].map(m => m[1]);
    assert.deepEqual(external, [], 'no stylesheet or script from a CDN');
    assert.doesNotMatch(html.match(/Content-Security-Policy" content="([^"]+)"/)[1], /(style|font)-src[^;]*https:/);
    const css = fs.readFileSync(path.join(renderer, 'assets', 'fontawesome', 'css', 'all.min.css'), 'utf8');
    for (const font of new Set([...css.matchAll(/url\(\.\.\/webfonts\/([\w-]+)\.woff2\)/g)].map(m => m[1]))) {
        assert.ok(fs.existsSync(path.join(renderer, 'assets', 'fontawesome', 'webfonts', `${font}.woff2`)), `${font}.woff2 bundled`);
    }
});
