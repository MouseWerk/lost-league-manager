const fs = require('fs');

// Shared read/write-with-atomic-rename primitive for the app's small JSON
// data files (accounts, config, rank history, honor watch). `saveJson`
// always throws on failure — callers for whom a write failure is critical
// (e.g. accounts/config) let it propagate; callers for whom recording is a
// best-effort side effect (rank history, honor watch) catch it locally so a
// disk hiccup on the side channel never breaks the primary operation it's
// riding along on.

// A file that exists but cannot be parsed (truncated write, sync conflict,
// hand edit) used to come back as the empty fallback, and the next save then
// wrote over it, losing everything in it for good. Now the damaged file is
// first copied to `<file>.corrupt-<timestamp>`; if that copy cannot be made,
// saving over the original is refused until the app restarts.
const _corruptCopies = new Map(); // filePath -> { copy, size, mtimeMs }
const _blocked       = new Set(); // filePaths we must not overwrite
const _notices       = [];        // { file, copy } not yet shown to the user

// After startup a damaged or unreadable file must not be replaced by whatever
// the next save holds (an add-account after an empty list would leave only the
// new account). Saves stay blocked for it and the listener tells the user.
let _booted = false;
const _runtimeDamaged = new Set(); // found damaged after startup: blocked until restart
let _noticeListener = null;

function markBooted() { _booted = true; }
function setNoticeListener(fn) { _noticeListener = fn; }

function notifyRuntime(notice) {
    if (!_noticeListener) return;
    try { _noticeListener(notice); } catch (e) { console.error('Data file notice failed:', e.message); }
}

function keepCorruptCopy(filePath, label, reason) {
    let st = null;
    try { st = fs.statSync(filePath); } catch { /* vanished meanwhile */ }
    const known = _corruptCopies.get(filePath);
    // loadJson runs on every get-accounts; copy each damaged version only once.
    if (known && st && known.size === st.size && known.mtimeMs === st.mtimeMs) return;

    const copy = `${filePath}.corrupt-${Date.now()}`;
    try {
        fs.copyFileSync(filePath, copy, fs.constants.COPYFILE_EXCL);
        _corruptCopies.set(filePath, { copy, size: st?.size, mtimeMs: st?.mtimeMs });
        if (_booted) {
            _runtimeDamaged.add(filePath);
            _blocked.add(filePath);
            notifyRuntime({ file: filePath, copy, kind: 'damaged' });
        } else {
            // At startup the boot error box names the copy; starting fresh is expected.
            _blocked.delete(filePath);
            _notices.push({ file: filePath, copy });
        }
        console.error(`Failed to load ${label} (${reason}); kept a copy as ${copy}`);
    } catch (e) {
        _blocked.add(filePath);
        console.error(`Failed to load ${label} (${reason}) and could not keep a copy: ${e.message}`);
    }
}

function loadJson(filePath, fallback, label, validate = (v) => v !== null && typeof v === 'object') {
    if (!fs.existsSync(filePath)) return fallback;
    let raw;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
        // Not damage: the file is locked or briefly unreadable (antivirus,
        // OneDrive). No copy, but never save over it until it reads again.
        if (!_blocked.has(filePath)) {
            _blocked.add(filePath);
            console.error(`Failed to read ${label} (${e.code || e.message}); saving it is paused until it can be read`);
            if (_booted) notifyRuntime({ file: filePath, kind: 'unreadable' });
            else _notices.push({ file: filePath, kind: 'unreadable' });
        }
        return fallback;
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        keepCorruptCopy(filePath, label, e.message);
        return fallback;
    }
    if (!validate(parsed)) {
        keepCorruptCopy(filePath, label, 'unexpected content');
        return fallback;
    }
    // Readable again (lock released, or repaired by hand). A file found
    // damaged at runtime stays blocked until restart, see keepCorruptCopy.
    if (!_runtimeDamaged.has(filePath)) _blocked.delete(filePath);
    return parsed;
}

// Synchronous short pause for the rename retry below (the main process is
// already inside a synchronous save; this keeps the call sites unchanged).
function pause(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const RENAME_RETRIES = 3;

function saveJson(filePath, data, label) {
    if (_blocked.has(filePath)) {
        const e = new Error(`${label} could not be read, so it is not overwritten. Restart the app; if the file was damaged, a copy of it was kept next to it.`);
        console.error(`Failed to save ${label}:`, e.message);
        throw e;
    }
    const tmp = filePath + '.tmp';
    try {
        // Flush before the rename: NTFS can persist the rename before the
        // data, which leaves an empty file after a power loss.
        const fd = fs.openSync(tmp, 'w');
        try {
            fs.writeFileSync(fd, JSON.stringify(data, null, 4));
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        // Antivirus or a sync client briefly holding the target makes the
        // rename fail with EPERM/EBUSY; a short retry usually gets through.
        for (let attempt = 0; ; attempt++) {
            try {
                fs.renameSync(tmp, filePath);
                break;
            } catch (e) {
                if (attempt >= RENAME_RETRIES || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
                pause(50 * (attempt + 1));
            }
        }
    } catch (e) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
        console.error(`Failed to save ${label}:`, e.message);
        throw e;
    }
}

// Files found damaged since the last call, so the caller can tell the user
// where the copy is. Each notice is returned once.
function takeCorruptNotices() {
    return _notices.splice(0, _notices.length);
}

module.exports = { loadJson, saveJson, takeCorruptNotices, markBooted, setNoticeListener };
