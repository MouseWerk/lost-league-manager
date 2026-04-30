const { globalShortcut } = require('electron');
const state = require('./state');

let _current = null;

function toggleOverlayVisibility() {
    if (!state.overlayWindow || state.overlayWindow.isDestroyed()) return;
    if (state.overlayWindow.isVisible()) state.overlayWindow.hide();
    else state.overlayWindow.show();
}

function registerOverlayHotkey(hotkey) {
    if (_current) {
        try { globalShortcut.unregister(_current); } catch {}
        _current = null;
    }
    if (!hotkey) return;
    try {
        const ok = globalShortcut.register(hotkey, toggleOverlayVisibility);
        if (ok) _current = hotkey;
        else console.warn('[Overlay] Hotkey unavailable:', hotkey);
    } catch (e) {
        console.error('[Overlay] Hotkey register failed:', e.message);
    }
}

module.exports = { registerOverlayHotkey, toggleOverlayVisibility };
