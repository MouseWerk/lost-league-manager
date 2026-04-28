const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayAPI', {
    onGepGameEvent:  (cb) => ipcRenderer.on('gep-game-event',  (_, d) => cb(d)),
    onGepInfoUpdate: (cb) => ipcRenderer.on('gep-info-update', (_, d) => cb(d)),
    onInit:          (cb) => ipcRenderer.on('overlay-init',    (_, d) => cb(d)),
    setInteractive:  (on) => ipcRenderer.send('overlay-interactive', on),
    startDragging:   ()  => ipcRenderer.send('overlay-start-dragging'),
    moveWindow:      (x, y) => ipcRenderer.send('overlay-move', x, y),
    getPosition:     ()  => ipcRenderer.invoke('overlay-get-position'),
    resize:          (w, h) => ipcRenderer.send('overlay-resize', w, h),
    fetchRanked:     (players) => ipcRenderer.invoke('overlay-get-ranked-bulk', players),
    fetchBuilds:     (champKey) => ipcRenderer.invoke('overlay-get-builds', champKey)
});
