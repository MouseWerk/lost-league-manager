const path = require('path');
const state = require('../state');
const { encrypt, decryptLegacy } = require('./encryption');
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
    for (const acc of accounts) {
        if (acc.password && !acc.password.startsWith('v2:')) {
            const plain = decryptLegacy(acc.password);
            if (plain) {
                acc.password = encrypt(plain);
                migrated++;
            }
        }
    }
    if (migrated > 0) {
        saveAccounts(accounts);
        console.log(`[Auth] Migrated ${migrated} password(s) to machine-bound encryption`);
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
