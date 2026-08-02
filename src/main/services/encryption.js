const crypto = require('crypto');
const { execSync } = require('child_process');

const ALGORITHM  = 'aes-256-cbc';
const LEGACY_KEY = crypto.scryptSync('lost-league-manager-secret', 'salt', 32);
let _machineKey          = null;
let _legacyWmicKey       = null;
let _legacyWmicKeyTried  = false;

// wmic.exe (used by the v2 key below) is deprecated and has been removed
// outright in recent Windows 11 feature updates. When it disappears on a
// machine whose accounts were encrypted under the old wmic-derived key,
// decryption breaks with no way back — this reads a stable, non-deprecated
// per-install identifier instead so that stops happening going forward.
function readMachineGuid() {
    const out = execSync(
        'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
        { encoding: 'utf8', timeout: 5000, windowsHide: true }
    );
    const m = out.match(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i);
    if (!m) throw new Error('MachineGuid not found in registry output');
    return m[1].trim();
}

function getMachineKey() {
    if (_machineKey) return _machineKey;
    try {
        const guid = readMachineGuid();
        const user = process.env.USERNAME || process.env.USER || 'user';
        _machineKey = crypto.scryptSync(`${guid}|${user}|lostleague-v3`, 'salt-v3', 32);
    } catch {
        console.warn('[Auth] Could not read MachineGuid — using fallback key');
        _machineKey = LEGACY_KEY;
    }
    return _machineKey;
}

// Only ever used to *decrypt* passwords that were encrypted before the v3
// switch away from wmic. Never used to encrypt new data. Returns null (not
// LEGACY_KEY) when wmic is unavailable, so callers can tell "no key" apart
// from "the fallback key".
function getLegacyWmicKey() {
    if (_legacyWmicKeyTried) return _legacyWmicKey;
    _legacyWmicKeyTried = true;
    try {
        const out  = execSync('wmic csproduct get uuid /value', { encoding: 'utf8', timeout: 5000, windowsHide: true });
        const m    = out.match(/UUID=([^\r\n]+)/i);
        const uuid = (m ? m[1].trim().replace(/[{}]/g, '') : '') || 'unknown';
        const user = process.env.USERNAME || process.env.USER || 'user';
        _legacyWmicKey = crypto.scryptSync(`${uuid}|${user}|lostleague-v2`, 'salt-v2', 32);
    } catch {
        _legacyWmicKey = null; // wmic unavailable — nothing to fall back to
    }
    return _legacyWmicKey;
}

function encrypt(text) {
    const iv     = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, getMachineKey(), iv);
    const enc    = Buffer.concat([cipher.update(text), cipher.final()]);
    return 'v3:' + iv.toString('hex') + ':' + enc.toString('hex');
}

function decrypt(text) {
    if (!text) return null;
    const isV3 = text.startsWith('v3:');
    const isV2 = text.startsWith('v2:');
    const raw  = (isV3 || isV2) ? text.slice(3) : text;

    const tryDecrypt = (key) => {
        if (!key) return null;
        try {
            const parts = raw.split(':');
            const iv    = Buffer.from(parts.shift(), 'hex');
            const enc   = Buffer.from(parts.join(':'), 'hex');
            const d     = crypto.createDecipheriv(ALGORITHM, key, iv);
            return Buffer.concat([d.update(enc), d.final()]).toString();
        } catch {
            return null;
        }
    };

    if (isV3) {
        // Try the current key first; fall back to LEGACY_KEY for passwords
        // encrypted when machine key derivation previously failed.
        return tryDecrypt(getMachineKey()) ?? tryDecrypt(LEGACY_KEY);
    }
    if (isV2) {
        // Encrypted under the old wmic-derived key. Try reproducing that key
        // (works if wmic is still installed), then the current registry-based
        // key (covers the case where wmic was already broken at encrypt time),
        // then the shared legacy key. If wmic is gone and neither of the other
        // two matches, this password is unrecoverable — the caller needs to
        // re-enter it, there's no way to reproduce the original key.
        return tryDecrypt(getLegacyWmicKey()) ?? tryDecrypt(getMachineKey()) ?? tryDecrypt(LEGACY_KEY);
    }
    return tryDecrypt(LEGACY_KEY);
}

function decryptLegacy(text) {
    try {
        const parts = text.split(':');
        const iv    = Buffer.from(parts.shift(), 'hex');
        const enc   = Buffer.from(parts.join(':'), 'hex');
        const d     = crypto.createDecipheriv(ALGORITHM, LEGACY_KEY, iv);
        return Buffer.concat([d.update(enc), d.final()]).toString();
    } catch {
        return null;
    }
}

const EXPORT_KEY = crypto.scryptSync('lost-league-export-v1', 'export-salt-ll', 32);

function encryptExport(obj) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, EXPORT_KEY, iv);
    const payload = Buffer.from(JSON.stringify(obj));
    const enc = Buffer.concat([cipher.update(payload), cipher.final()]);
    return 'llem:' + iv.toString('hex') + ':' + enc.toString('hex');
}

function decryptExport(text) {
    try {
        if (!text.startsWith('llem:')) return null;
        const raw = text.slice(5);
        const sep = raw.indexOf(':');
        const iv  = Buffer.from(raw.slice(0, sep), 'hex');
        const enc = Buffer.from(raw.slice(sep + 1), 'hex');
        const d = crypto.createDecipheriv(ALGORITHM, EXPORT_KEY, iv);
        return JSON.parse(Buffer.concat([d.update(enc), d.final()]).toString());
    } catch {
        return null;
    }
}

module.exports = { encrypt, decrypt, decryptLegacy, encryptExport, decryptExport };
