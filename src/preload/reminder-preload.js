const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('reminderAPI', {
    onInit:     (cb) => ipcRenderer.on('reminder-init',   (_, d) => cb(d)),
    onReminder: (cb) => ipcRenderer.on('buy-reminder',    (_, d) => cb(d)),
});
