const path = require('path');
const state = require('../state');
const { encrypt, decrypt, isCurrentEncryption, hasMachineKey } = require('./encryption');
const { loadJson, saveJson, takeCorruptNotices } = require('./json-store');
const secrets = require('./secrets');

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

// Usernames are compared case-insensitively everywhere (Riot logins are).
function sameUser(a, b) {
    return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

function loadConfig() {
    Object.assign(state.config, loadJson(state.paths.config, {}, 'config', (v) => v !== null && typeof v === 'object' && !Array.isArray(v)));
    // Moves a plaintext Riot API key from older versions into safeStorage.
    if (secrets.loadSecrets(state.config)) saveConfig();
}

function saveConfig() {
    saveJson(state.paths.config, state.config, 'config');
}

// AES-CBC with a wrong key still passes the padding check about 1 time in
// 256 and returns garbage. Re-encrypting that would replace the original for
// good, so only text that can be a typed password is migrated.
function looksLikePassword(text) {
    return text.length > 0 && !/[\u0000-\u001f\u007f\ufffd]/.test(text);
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
            if (plain === null || !looksLikePassword(plain)) continue;
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
        const lines = notices.map(n => dataFileProblemText(n));
        throw new Error(lines.join('\n'));
    }
}

// User-facing text for a damaged or unreadable data file (boot box and the
// renderer's runtime notice share it).
function dataFileProblemText(n) {
    const name = path.basename(n.file);
    if (n.copy) return `${name} could not be read. A copy was kept as ${path.basename(n.copy)}.`;
    return `${name} could not be read (it may be locked by antivirus or OneDrive). Changes to it are not saved until it can be read again.`;
}

module.exports = { loadAccounts, saveAccounts, updateAccounts, sameUser, loadConfig, saveConfig, migratePasswords, dataFileProblemText, looksLikePassword };
