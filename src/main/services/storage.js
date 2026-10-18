const path = require('path');
const state = require('../state');
const { encrypt, decrypt, isCurrentEncryption, hasMachineKey } = require('./encryption');
const { loadJson, saveJson, takeCorruptNotices } = require('./json-store');

function loadAccounts() {
    return loadJson(state.paths.accounts, [], 'accounts', Array.isArray);
}

function saveAccounts(accounts) {
    saveJson(state.paths.accounts, accounts, 'accounts');
}

// Read-modify-write on the current file. For callers that await between
// reading and writing (e.g. the LCU Riot ID link): `fn` gets the accounts as
// they are on disk now, changes them in place and returns false to skip the
// write. Everything between load and save is synchronous, so no other
// handler can interleave.
function updateAccounts(fn) {
    const accounts = loadAccounts();
    const result = fn(accounts);
    if (result === false) return false;
    saveAccounts(accounts);
    return true;
}

function loadConfig() {
    Object.assign(state.config, loadJson(state.paths.config, {}, 'config', (v) => v !== null && typeof v === 'object' && !Array.isArray(v)));
}

function saveConfig() {
    saveJson(state.paths.config, state.config, 'config');
}

function migratePasswords() {
    const accounts = loadAccounts();
    let migrated = 0;
    // Re-encrypt everything that is not stored under the current machine key
    // while the old key can still be reproduced: unprefixed values (static
    // key), v2 (wmic-derived; wmic is being removed from Windows) and v3 values
    // written with the static fallback key while MachineGuid was unreadable.
    // Without the real machine key nothing is rewritten (it would only move
    // the data onto the public fallback key); the next start tries again.
    if (hasMachineKey()) {
        for (const acc of accounts) {
            if (!acc.password || isCurrentEncryption(acc.password)) continue;
            const plain = decrypt(acc.password);
            if (plain === null) continue;
            acc.password = encrypt(plain);
            migrated++;
        }
    }
    if (migrated > 0) {
        saveAccounts(accounts);
        console.log(`[Auth] Re-encrypted ${migrated} password(s) with the machine-bound key`);
    }

    // main.js runs this inside its boot try/catch and shows the message in an
    // error box, which is how the user learns that a file was damaged and
    // where the copy of it is.
    const notices = takeCorruptNotices();
    if (notices.length > 0) {
        const lines = notices.map(n => `${path.basename(n.file)} could not be read. A copy was kept as ${path.basename(n.copy)}.`);
        throw new Error(lines.join('\n'));
    }
}

module.exports = { loadAccounts, saveAccounts, updateAccounts, loadConfig, saveConfig, migratePasswords };
