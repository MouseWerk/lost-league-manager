// Extra stubs for the data/security tests, on top of fake-electron:
// safeStorage (DPAPI), file dialogs, and the `reg query` / `wmic` calls the
// machine key comes from. Require this instead of fake-electron.
const base = require('./fake-electron');
const { fakeElectron, userData } = base;
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// safeStorage: reversible, but the ciphertext never contains the plaintext.
const safe = { available: true };
fakeElectron.safeStorage = {
    isEncryptionAvailable: () => safe.available,
    encryptString: (s) => {
        if (!safe.available) throw new Error('Encryption is not available');
        return Buffer.from('DPAPI:' + Buffer.from(s, 'utf8').toString('hex'));
    },
    decryptString: (buf) => {
        const t = buf.toString();
        if (!t.startsWith('DPAPI:')) throw new Error('Error while decrypting the ciphertext');
        return Buffer.from(t.slice(6), 'hex').toString('utf8');
    },
};

fakeElectron.dialog.showSaveDialog = async () => ({ canceled: true });
fakeElectron.dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });

// Machine identity: `reg query ... MachineGuid` and `wmic csproduct`.
const machine = { guid: '6f1c3550-aaaa-bbbb-cccc-000000000001', regFails: false, wmicUuid: null };
const realExecSync = childProcess.execSync;
childProcess.execSync = function (cmd, opts) {
    if (typeof cmd === 'string' && cmd.startsWith('reg query') && cmd.includes('MachineGuid')) {
        if (machine.regFails) throw new Error('reg query timed out');
        return `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    ${machine.guid}\r\n\r\n`;
    }
    if (typeof cmd === 'string' && cmd.startsWith('wmic')) {
        if (!machine.wmicUuid) throw new Error("'wmic' is not recognized as an internal or external command");
        return `\r\n\r\nUUID=${machine.wmicUuid}\r\n\r\n`;
    }
    return realExecSync.call(this, cmd, opts);
};

const file = (name) => path.join(userData, name);

function writeJson(name, data) {
    fs.writeFileSync(file(name), typeof data === 'string' ? data : JSON.stringify(data));
}

function readJson(name) {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
}

// Builds values the way older versions wrote them, to test migrations.
const LEGACY_KEY = crypto.scryptSync('lost-league-manager-secret', 'salt', 32);
function cbc(key, text) {
    const iv = crypto.randomBytes(16);
    const c = crypto.createCipheriv('aes-256-cbc', key, iv);
    return iv.toString('hex') + ':' + Buffer.concat([c.update(text, 'utf8'), c.final()]).toString('hex');
}
const user = () => process.env.USERNAME || process.env.USER || 'user';
const legacy = {
    unprefixed: (text) => cbc(LEGACY_KEY, text),
    v2: (text, uuid) => 'v2:' + cbc(crypto.scryptSync(`${uuid}|${user()}|lostleague-v2`, 'salt-v2', 32), text),
    // CBC has no integrity check: about 1 in 256 values also "decrypts" with
    // another key. Retry until the value does not fit the machine key, so the
    // tests stay deterministic.
    v3StaticKey: (text) => {
        for (;;) {
            const v = 'v3:' + cbc(LEGACY_KEY, text);
            if (legacy.decryptV3(v) === null) return v;
        }
    },
    v3: (text, guid = machine.guid) => 'v3:' + cbc(crypto.scryptSync(`${guid}|${user()}|lostleague-v3`, 'salt-v3', 32), text),
    exportV1: (obj) => {
        const key = crypto.scryptSync('lost-league-export-v1', 'export-salt-ll', 32);
        const iv = crypto.randomBytes(16);
        const c = crypto.createCipheriv('aes-256-cbc', key, iv);
        return 'llem:' + iv.toString('hex') + ':' + Buffer.concat([c.update(JSON.stringify(obj)), c.final()]).toString('hex');
    },
    // Decrypts a v3 value with the key derived from `guid` (null if it does not fit).
    decryptV3: (text, guid = machine.guid) => {
        try {
            const key = crypto.scryptSync(`${guid}|${user()}|lostleague-v3`, 'salt-v3', 32);
            const [ivHex, encHex] = text.slice(3).split(':');
            const d = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
            return Buffer.concat([d.update(Buffer.from(encHex, 'hex')), d.final()]).toString('utf8');
        } catch {
            return null;
        }
    },
    sha256: (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
};

module.exports = { ...base, safe, machine, file, writeJson, readJson, legacy };
