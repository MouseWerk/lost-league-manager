const crypto = require('crypto');
const state = require('../state');
const { saveConfig } = require('./storage');

// The vault password is checked here, in the main process. The renderer
// sends the password itself; the verifier (salted scrypt) never leaves this
// process. Older versions stored an unsalted SHA-256 computed in the renderer
// as `vaultPasswordHash`, which get-config handed back and unlock-vault
// accepted as the password; it is replaced on the first successful unlock.
//
// The vault is a lock on this app's account functions, not an encryption
// layer: account passwords stay encrypted with the machine key either way.

const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const MAX_PASSWORD_LENGTH = 1024;

// Attempt limit: the first few wrong passwords are free, then each further
// one blocks the next attempt for 30 s, doubling up to 15 minutes. Kept in
// memory; a restart takes long enough that it does not help guessing.
const FREE_ATTEMPTS  = 5;
const BASE_DELAY_MS  = 30 * 1000;
const MAX_DELAY_MS   = 15 * 60 * 1000;

let _failures     = 0;
let _blockedUntil = 0;
let _now          = () => Date.now();
// Attempts run one after another, so a burst of parallel calls cannot slip
// past the limit while the first scrypt is still running.
let _queue        = Promise.resolve();

function isVaultEnabled() {
    const c = state.config;
    return !!c.vaultEnabled && !!(c.vaultHash || c.vaultPasswordHash);
}

function isVaultLocked() {
    return isVaultEnabled() && !state.vaultUnlocked;
}

function getVaultState() {
    return { enabled: isVaultEnabled(), unlocked: !isVaultLocked() };
}

function scrypt(password, salt) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, 32, SCRYPT_PARAMS, (err, key) => (err ? reject(err) : resolve(key)));
    });
}

function equalHex(a, bHex) {
    const b = Buffer.from(String(bHex || ''), 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// { ok, legacy }
async function verify(password) {
    const c = state.config;
    if (c.vaultKdf === 'scrypt' && c.vaultHash && c.vaultSalt) {
        const key = await scrypt(password, Buffer.from(c.vaultSalt, 'hex'));
        return { ok: equalHex(key, c.vaultHash), legacy: false };
    }
    if (c.vaultPasswordHash) {
        // Old renderer: sha256 hex of the UTF-8 password, trimmed when it was
        // set but not when unlocking. Accept both so nobody is locked out.
        const candidates = new Set([password, password.trim()]);
        for (const p of candidates) {
            const sha = crypto.createHash('sha256').update(p, 'utf8').digest();
            if (equalHex(sha, c.vaultPasswordHash)) return { ok: true, legacy: true };
        }
    }
    return { ok: false, legacy: false };
}

// Writes the scrypt verifier into state.config (not saved).
async function applyPassword(password) {
    const salt = crypto.randomBytes(16);
    const key  = await scrypt(password, salt);
    const c = state.config;
    c.vaultEnabled = true;
    c.vaultKdf  = 'scrypt';
    c.vaultSalt = salt.toString('hex');
    c.vaultHash = key.toString('hex');
    delete c.vaultPasswordHash;
}

const VAULT_KEYS = ['vaultEnabled', 'vaultKdf', 'vaultSalt', 'vaultHash', 'vaultPasswordHash'];

function snapshotVaultConfig() {
    const snap = {};
    for (const k of VAULT_KEYS) if (k in state.config) snap[k] = state.config[k];
    return snap;
}

function restoreVaultConfig(snap) {
    for (const k of VAULT_KEYS) delete state.config[k];
    Object.assign(state.config, snap);
}

function retryAfterMs() {
    return Math.max(0, _blockedUntil - _now());
}

function registerFailure() {
    _failures++;
    if (_failures >= FREE_ATTEMPTS) {
        const delay = Math.min(BASE_DELAY_MS * 2 ** (_failures - FREE_ATTEMPTS), MAX_DELAY_MS);
        _blockedUntil = _now() + delay;
    }
}

function tooManyAttempts(wait) {
    return { ok: false, message: `Too many attempts. Try again in ${Math.ceil(wait / 1000)} s.`, retryAfterMs: wait };
}

function serialized(fn) {
    const run = _queue.then(fn, fn);
    _queue = run.catch(() => {});
    return run;
}

// Checks `password` against the stored verifier with the attempt limit and
// upgrades a legacy verifier on success. Returns { ok, message?, retryAfterMs? }.
async function checkPassword(password) {
    const wait = retryAfterMs();
    if (wait > 0) return tooManyAttempts(wait);
    const valid = typeof password === 'string' && password.length > 0 && password.length <= MAX_PASSWORD_LENGTH;
    const r = valid ? await verify(password) : { ok: false };
    if (!r.ok) {
        registerFailure();
        const w = retryAfterMs();
        return w > 0 ? { ...tooManyAttempts(w), message: 'Incorrect password' } : { ok: false, message: 'Incorrect password' };
    }
    _failures = 0;
    _blockedUntil = 0;
    if (r.legacy) {
        const snap = snapshotVaultConfig();
        try {
            await applyPassword(password);
            saveConfig();
        } catch (e) {
            // The old verifier still works; try again on the next unlock.
            console.error('[Vault] Could not upgrade the stored password check:', e.message);
            restoreVaultConfig(snap);
        }
    }
    return { ok: true };
}

function unlockVault(password) {
    return serialized(async () => {
        if (!isVaultLocked()) {
            state.vaultUnlocked = true;
            return { success: true };
        }
        const r = await checkPassword(password);
        if (!r.ok) return { success: false, message: r.message, ...(r.retryAfterMs ? { retryAfterMs: r.retryAfterMs } : {}) };
        state.vaultUnlocked = true;
        return { success: true };
    });
}

// Sets or changes the password; enables the vault when it was off (then
// `current` is ignored). Neither value is trimmed.
function setVaultPassword(payload) {
    return serialized(async () => {
        const { current, next } = payload && typeof payload === 'object' ? payload : {};
        if (typeof next !== 'string' || !next) return { success: false, message: 'Enter a password' };
        if (next.length > MAX_PASSWORD_LENGTH) return { success: false, message: 'Password is too long' };
        if (isVaultEnabled()) {
            const r = await checkPassword(current);
            if (!r.ok) return { success: false, message: r.message, ...(r.retryAfterMs ? { retryAfterMs: r.retryAfterMs } : {}) };
        }
        const snap = snapshotVaultConfig();
        try {
            await applyPassword(next);
            saveConfig();
        } catch (e) {
            restoreVaultConfig(snap);
            return { success: false, message: `Could not save the password: ${e.message}` };
        }
        state.vaultUnlocked = true;
        return { success: true };
    });
}

function disableVault(current) {
    return serialized(async () => {
        if (isVaultEnabled()) {
            const r = await checkPassword(current);
            if (!r.ok) return { success: false, message: r.message, ...(r.retryAfterMs ? { retryAfterMs: r.retryAfterMs } : {}) };
        }
        const snap = snapshotVaultConfig();
        for (const k of VAULT_KEYS) delete state.config[k];
        state.config.vaultEnabled = false;
        try {
            saveConfig();
        } catch (e) {
            restoreVaultConfig(snap);
            return { success: false, message: `Could not save the setting: ${e.message}` };
        }
        state.vaultUnlocked = true;
        return { success: true };
    });
}

// Standard refusal for account IPC while the vault is locked.
function lockedResult() {
    return { success: false, locked: true, message: 'Vault is locked' };
}

// Test hooks.
function _resetAttempts() {
    _failures = 0;
    _blockedUntil = 0;
}
function _setClock(fn) {
    _now = fn || (() => Date.now());
}

module.exports = {
    isVaultLocked, isVaultEnabled, getVaultState, unlockVault, setVaultPassword, disableVault, lockedResult,
    _resetAttempts, _setClock,
};
