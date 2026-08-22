const state = require('../state');
const { encrypt, decryptLegacy } = require('./encryption');
const { loadJson, saveJson } = require('./json-store');

function loadAccounts() {
    return loadJson(state.paths.accounts, [], 'accounts', Array.isArray);
}

function saveAccounts(accounts) {
    saveJson(state.paths.accounts, accounts, 'accounts');
}

function loadConfig() {
    Object.assign(state.config, loadJson(state.paths.config, {}, 'config'));
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
}

module.exports = { loadAccounts, saveAccounts, loadConfig, saveConfig, migratePasswords };
