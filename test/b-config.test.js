const { invoke, safe, userData, file, writeJson, readJson } = require('./helpers/b-fakes');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const state = require('../src/main/state');
const storage = require('../src/main/services/storage');
const secrets = require('../src/main/services/secrets');
require('../src/main/ipc/config').register();

const KEY = 'RGAPI-0123abcd-4567-89ab-cdef-0123456789ab';

test.beforeEach(() => {
    safe.available = true;
    delete state.config.riotApiKey;
    delete state.config.riotApiKeyEnc;
    secrets.loadSecrets(state.config);
    state.config.uiScale = 1.0;
});

test('a plaintext Riot API key from an older version is encrypted at start and removed from config.json', () => {
    writeJson('config.json', { riotApiKey: KEY, autoAccept: true });
    storage.loadConfig();

    const raw = fs.readFileSync(file('config.json'), 'utf8');
    assert.equal(raw.includes(KEY), false);
    assert.equal(readJson('config.json').autoAccept, true);
    assert.ok(readJson('config.json').riotApiKeyEnc);
    assert.equal(secrets.getRiotApiKey(), KEY);
    assert.equal('riotApiKey' in state.config, false);
});

test('the key is read back from encrypted storage on the next start', () => {
    writeJson('config.json', { riotApiKey: KEY });
    storage.loadConfig();
    delete state.config.riotApiKeyEnc;
    secrets.loadSecrets(state.config);
    assert.equal(secrets.getRiotApiKey(), '');

    storage.loadConfig();
    assert.equal(secrets.getRiotApiKey(), KEY);
});

test('without Windows encryption the old key keeps working and migrates later', () => {
    safe.available = false;
    writeJson('config.json', { riotApiKey: KEY });
    storage.loadConfig();
    assert.equal(secrets.getRiotApiKey(), KEY);
    assert.equal(readJson('config.json').riotApiKey, KEY);
});

test('get-config returns no key, only whether one is set', async () => {
    assert.equal((await invoke('set-riot-api-key', KEY)).success, true);
    const cfg = await invoke('get-config');
    assert.equal(JSON.stringify(cfg).includes(KEY), false);
    assert.equal('riotApiKeyEnc' in cfg, false);
    assert.equal(cfg.riotApiKeySet, true);
    assert.equal(fs.readFileSync(file('config.json'), 'utf8').includes(KEY), false);

    assert.equal((await invoke('set-riot-api-key', '')).success, true);
    assert.equal((await invoke('get-config')).riotApiKeySet, false);
    assert.equal(secrets.getRiotApiKey(), '');
});

test('set-riot-api-key trims, validates, and refuses to store unencrypted', async () => {
    assert.equal((await invoke('set-riot-api-key', `  ${KEY}\n`)).success, true);
    assert.equal(secrets.getRiotApiKey(), KEY);
    assert.equal((await invoke('set-riot-api-key', 'not a key')).success, false);
    assert.equal((await invoke('set-riot-api-key', 42)).success, false);
    assert.equal(secrets.getRiotApiKey(), KEY);

    safe.available = false;
    const res = await invoke('set-riot-api-key', KEY.replace('0123abcd', 'ffffffff'));
    assert.equal(res.success, false);
    assert.equal(secrets.getRiotApiKey(), KEY);
});

test('set-config no longer accepts the key or vault fields', async () => {
    const res = await invoke('set-config', { riotApiKey: KEY, vaultEnabled: false, vaultPasswordHash: 'x' });
    assert.equal(res.success, false);
    assert.deepEqual(res.rejected.sort(), ['riotApiKey', 'vaultEnabled', 'vaultPasswordHash']);
    assert.equal('riotApiKey' in state.config, false);
});

test('uiScale must be a finite value in range', async () => {
    for (const bad of [-3, 0, NaN, Infinity, 5, '1.25']) {
        const res = await invoke('set-config', { uiScale: bad });
        assert.equal(res.success, false, String(bad));
        assert.equal(state.config.uiScale, 1.0);
    }
    assert.equal((await invoke('set-config', { uiScale: 1.25 })).success, true);
    assert.equal(state.config.uiScale, 1.25);
});

test('lolPath must point to an existing LeagueClient.exe', async () => {
    const before = state.config.lolPath;
    const exe = path.join(userData, 'cmd.exe');
    fs.writeFileSync(exe, '');
    assert.equal((await invoke('set-config', { lolPath: exe })).success, false);
    assert.equal((await invoke('set-config', { lolPath: path.join(userData, 'missing', 'LeagueClient.exe') })).success, false);
    assert.equal((await invoke('set-config', { lolPath: 'LeagueClient.exe' })).success, false);
    assert.equal(state.config.lolPath, before);

    const client = path.join(userData, 'LeagueClient.exe');
    fs.writeFileSync(client, '');
    assert.equal((await invoke('set-config', { lolPath: client })).success, true);
    assert.equal(state.config.lolPath, client);
});

test('overlayHotkey is not settable through set-config (the overlay is disabled)', async () => {
    const res = await invoke('set-config', { overlayHotkey: 'garbage' });
    assert.equal(res.success, false);
    assert.notEqual(state.config.overlayHotkey, 'garbage');
});

test('a failed save reports the error and keeps the previous settings', async (t) => {
    state.config.autoAccept = false;
    t.mock.method(fs, 'openSync', () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); });
    const res = await invoke('set-config', { autoAccept: true });
    assert.equal(res.success, false);
    assert.match(res.message, /Could not save settings/);
    assert.equal(state.config.autoAccept, false);
});
