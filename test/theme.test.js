// The theme setting (Settings > Appearance) drives nativeTheme.themeSource,
// which every window's prefers-color-scheme follows.
const { fakeElectron, invoke } = require('./helpers/fake-electron');
const test = require('node:test');
const assert = require('node:assert/strict');
const state = require('../src/main/state');
const config = require('../src/main/ipc/config');
config.register();

test('the theme defaults to following Windows', () => {
    assert.equal(state.config.theme, 'system');
    config.applyTheme();
    assert.equal(fakeElectron.nativeTheme.themeSource, 'system');
});

test('choosing light or dark applies it at once', async () => {
    assert.equal((await invoke('set-config', { theme: 'dark' })).success, true);
    assert.equal(fakeElectron.nativeTheme.themeSource, 'dark');
    assert.equal((await invoke('set-config', { theme: 'light' })).success, true);
    assert.equal(fakeElectron.nativeTheme.themeSource, 'light');
    await invoke('set-config', { theme: 'system' });
    assert.equal(fakeElectron.nativeTheme.themeSource, 'system');
});

test('an unknown theme is rejected and changes nothing', async () => {
    const res = await invoke('set-config', { theme: 'neon' });
    assert.equal(res.success, false);
    assert.deepEqual(res.rejected, ['theme']);
    assert.equal(fakeElectron.nativeTheme.themeSource, 'system');
});
