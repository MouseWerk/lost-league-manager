const state = require('./state');

// The overlay's show-or-hide keys. They used to be a global shortcut
// (RegisterHotKey), which did not reach the overlay while League had the
// keyboard; overlay-manager.js now reads them with the game input watcher,
// which also leaves the keys to the game.

function toggleOverlayVisibility() {
    if (!state.overlayWindow || state.overlayWindow.isDestroyed()) return;
    require('./overlay-manager').toggleByHotkey();
}

function registerOverlayHotkey(hotkey) {
    if (hotkey) require('./overlay-manager').setHotkey(hotkey);
}

module.exports = { registerOverlayHotkey, toggleOverlayVisibility };
