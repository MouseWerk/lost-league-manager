const fs = require('fs');
const state = require('../state');
const { encrypt, decryptLegacy } = require('./encryption');

function loadAccounts() {
    if (fs.existsSync(state.paths.accounts)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(state.paths.accounts));
            return Array.isArray(parsed) ? parsed : [];
        } catch (e) {
            console.error('Failed to load accounts:', e.message);
        }
    }
    return [];
}

function saveAccounts(accounts) {
    fs.writeFileSync(state.paths.accounts, JSON.stringify(accounts, null, 4));
}

function loadConfig() {
    if (fs.existsSync(state.paths.config)) {
        try {
            Object.assign(state.config, JSON.parse(fs.readFileSync(state.paths.config)));
        } catch (e) {
            console.error('Failed to load config:', e.message);
        }
    }
}

function saveConfig() {
    fs.writeFileSync(state.paths.config, JSON.stringify(state.config, null, 4));
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
