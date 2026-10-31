const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayAPI', {
    onGepGameEvent:  (cb) => ipcRenderer.on('gep-game-event',  (_, d) => cb(d)),
    onGepInfoUpdate: (cb) => ipcRenderer.on('gep-info-update', (_, d) => cb(d)),
    onInit:          (cb) => ipcRenderer.on('overlay-init',    (_, d) => cb(d)),
    setInteractive:  (on) => ipcRenderer.send('overlay-interactive', on),
    moveWindow:      (x, y) => ipcRenderer.send('overlay-move', x, y),
    savePosition:    ()  => ipcRenderer.send('overlay-save-position'),
    getPosition:     ()  => ipcRenderer.invoke('overlay-get-position'),
    resize:          (w, h) => ipcRenderer.send('overlay-resize', w, h),
    fetchRanked:     (players) => ipcRenderer.invoke('overlay-get-ranked-bulk', players),
    fetchLoading:    ()  => ipcRenderer.invoke('overlay-get-loading'),
    onTab:           (cb) => ipcRenderer.on('overlay-tab', (_, down) => cb(down)),
    onPhase:         (cb) => ipcRenderer.on('overlay-phase', (_, phase) => cb(phase)),
    fetchBuilds:     (champKey, gameMode, position) => ipcRenderer.invoke('overlay-get-builds', { champKey, gameMode, position }),
    setOpacity:      (v)       => ipcRenderer.invoke('overlay-set-opacity', v),
    saveSettings:    (s)       => ipcRenderer.invoke('overlay-save-settings', s),
    onSettingsUpdate: (cb)      => ipcRenderer.on('overlay-settings-update', (_, d) => cb(d))
});
