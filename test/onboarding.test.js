// First start: the setup dialog remembers it was done, and tells the
// renderer whether the League install was found.
const { invoke, userData } = require('./helpers/fake-electron');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const state = require('../src/main/state');
require('../src/main/ipc/config').register();

test('finishing the setup is saved; other values are refused', async () => {
    assert.equal((await invoke('set-config', { onboardingDone: true })).success, true);
    assert.equal(state.config.onboardingDone, true);
    assert.equal((await invoke('set-config', { onboardingDone: 'yes' })).success, false);
    assert.equal(state.config.onboardingDone, true);
});

test('the config says whether LeagueClient.exe exists', async () => {
    state.config.lolPath = path.join(userData, 'missing', 'LeagueClient.exe');
    assert.equal((await invoke('get-config')).lolPathFound, false);
    const dir = path.join(userData, 'Riot Games', 'League of Legends');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'LeagueClient.exe'), '');
    state.config.lolPath = path.join(dir, 'LeagueClient.exe');
    assert.equal((await invoke('get-config')).lolPathFound, true);
});

test('the setup dialog has its four steps and replaces What\'s new on first start', () => {
    const root = path.join(__dirname, '..', 'src', 'renderer');
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const steps = [...html.matchAll(/class="ob-step" data-step="(\d)"/g)].map(m => m[1]);
    assert.deepEqual(steps, ['0', '1', '2', '3']);
    const app = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');
    assert.match(app, /if \(firstStart\) \{[\s\S]*?openOnboarding\(config\);[\s\S]*?\}\s*\/\/[^\n]*\n[\s\S]*?else if \(PATCH_NOTES\[version\]/);
});
