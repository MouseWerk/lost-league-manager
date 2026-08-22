const fs = require('fs');

// Shared read/write-with-atomic-rename primitive for the app's small JSON
// data files (accounts, config, rank history, honor watch). `saveJson`
// always throws on failure — callers for whom a write failure is critical
// (e.g. accounts/config) let it propagate; callers for whom recording is a
// best-effort side effect (rank history, honor watch) catch it locally so a
// disk hiccup on the side channel never breaks the primary operation it's
// riding along on.

function loadJson(filePath, fallback, label, validate = (v) => v !== null && typeof v === 'object') {
    if (fs.existsSync(filePath)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(filePath));
            return validate(parsed) ? parsed : fallback;
        } catch (e) {
            console.error(`Failed to load ${label}:`, e.message);
        }
    }
    return fallback;
}

function saveJson(filePath, data, label) {
    const tmp = filePath + '.tmp';
    try {
        fs.writeFileSync(tmp, JSON.stringify(data, null, 4));
        fs.renameSync(tmp, filePath);
    } catch (e) {
        console.error(`Failed to save ${label}:`, e.message);
        throw e;
    }
}

module.exports = { loadJson, saveJson };
