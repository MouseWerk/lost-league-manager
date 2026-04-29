const crypto = require('crypto');
const { execSync } = require('child_process');

const ALGORITHM  = 'aes-256-cbc';
const LEGACY_KEY = crypto.scryptSync('lost-league-manager-secret', 'salt', 32);
let _machineKey  = null;

function getMachineKey() {
    if (_machineKey) return _machineKey;
    try {
        const out  = execSync('wmic csproduct get uuid /value 2>nul', { encoding: 'utf8', timeout: 5000 });
        const m    = out.match(/UUID=([^\r\n]+)/i);
        const uuid = (m ? m[1].trim().replace(/[{}]/g, '') : '') || 'unknown';
        const user = process.env.USERNAME || process.env.USER || 'user';
        _machineKey = crypto.scryptSync(`${uuid}|${user}|lostleague-v2`, 'salt-v2', 32);
    } catch (e) {
        console.error('[Auth] Machine key derivation failed, using legacy key:', e.message);
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
    try {
        const isV2  = text.startsWith('v2:');
        const key   = isV2 ? getMachineKey() : LEGACY_KEY;
        const raw   = isV2 ? text.slice(3) : text;
        const parts = raw.split(':');
        const iv    = Buffer.from(parts.shift(), 'hex');
        const enc   = Buffer.from(parts.join(':'), 'hex');
        const d     = crypto.createDecipheriv(ALGORITHM, key, iv);
        return Buffer.concat([d.update(enc), d.final()]).toString();
    } catch {
        return null;
    }
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

module.exports = { encrypt, decrypt, decryptLegacy };
