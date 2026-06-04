const crypto = require('crypto');
const { execSync } = require('child_process');

const ALGORITHM  = 'aes-256-cbc';
const LEGACY_KEY = crypto.scryptSync('lost-league-manager-secret', 'salt', 32);
let _machineKey  = null;

function getMachineKey() {
    if (_machineKey) return _machineKey;
    try {
        const out  = execSync('wmic csproduct get uuid /value', { encoding: 'utf8', timeout: 5000, windowsHide: true });
        const m    = out.match(/UUID=([^\r\n]+)/i);
        const uuid = (m ? m[1].trim().replace(/[{}]/g, '') : '') || 'unknown';
        const user = process.env.USERNAME || process.env.USER || 'user';
        _machineKey = crypto.scryptSync(`${uuid}|${user}|lostleague-v2`, 'salt-v2', 32);
    } catch {
        console.warn('[Auth] Could not read machine UUID — using fallback key');
        _machineKey = LEGACY_KEY;
    }
    return _machineKey;
}

function encrypt(text) {
    const iv     = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, getMachineKey(), iv);
    const enc    = Buffer.concat([cipher.update(text), cipher.final()]);
    return 'v2:' + iv.toString('hex') + ':' + enc.toString('hex');
}

function decrypt(text) {
    if (!text) return null;
    const isV2 = text.startsWith('v2:');
    const raw  = isV2 ? text.slice(3) : text;

    const tryDecrypt = (key) => {
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

    if (isV2) {
        // Try machine key first; fall back to LEGACY_KEY for passwords encrypted
        // when machine key derivation previously failed (e.g. wmic unavailable)
        return tryDecrypt(getMachineKey()) ?? tryDecrypt(LEGACY_KEY);
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
