// The popup page was written against an Electron preload that exposed
// `window.reminderAPI`. Same shape here, backed by Tauri, so
// src/renderer/js/reminder.js runs unchanged.
(function () {
  const tauri = window.__TAURI__;
  if (!tauri) return;

  const handlers = { init: [], reminder: [] };

  window.reminderAPI = {
    onInit: (cb) => handlers.init.push(cb),
    onReminder: (cb) => handlers.reminder.push(cb),
  };

  const deliver = (payload) => {
    if (!payload) return;
    // The version rides along with the payload so the page can build icon URLs.
    handlers.init.forEach((cb) => cb({ ddragonVersion: payload.ddragonVersion }));
    handlers.reminder.forEach((cb) => cb(payload));
  };

  tauri.event.listen("buy-reminder", (e) => deliver(e.payload));

  // A payload emitted while this page was still booting would otherwise be
  // lost, so ask for it once we're listening.
  window.addEventListener("DOMContentLoaded", () => {
    tauri.core.invoke("get_pending_reminder").then(deliver).catch(() => {});
  });
})();
