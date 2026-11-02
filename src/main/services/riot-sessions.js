const fs = require('fs');
const os = require('os');
const path = require('path');
const state = require('../state');
const { loadJson, saveJson } = require('./json-store');

// Sign-in without typing. When "Stay signed in" is ticked, the Riot Client
// keeps its sign-in in RiotGamesPrivateSettings.yaml (riot-login > persist)
// and signs in by itself on the next start. The app keeps a copy of that file
// per account, encrypted with safeStorage (Windows DPAPI, like the Riot API
// key), and puts the right one in place before it starts the Riot Client.
// The copy is as good as a password, so it never leaves this module
// unencrypted except into the Riot Client's own file, and it is not part of
// backups.
//
// Keyed by lower-cased login name, which does not change with the Riot ID.

function userKey(username) {
    return typeof username === 'string' ? username.toLowerCase() : '';
}

function settingsFilePath() {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'Riot Games', 'Riot Client', 'Data', 'RiotGamesPrivateSettings.yaml');
}

function safeStorage() {
    try {
        const s = require('electron').safeStorage;
        return s && s.isEncryptionAvailable() ? s : null;
    } catch {
        return null;
    }
}

function load() {
    return loadJson(state.paths.riotSessions, {}, 'Riot sessions', (v) => v !== null && typeof v === 'object' && !Array.isArray(v));
}

function save(data) {
    try {
        saveJson(state.paths.riotSessions, data, 'Riot sessions');
    } catch { /* logged by saveJson already */ }
}

// True when the settings file holds a kept sign-in: a persist block (not
// `persist: null`) with an ssid cookie that has a value.
function hasKeptSignIn(yaml) {
    if (typeof yaml !== 'string') return false;
    const m = yaml.match(/^riot-login:\r?\n((?:[ \t]+.*\r?\n?)*)/m);
    if (!m) return false;
    const block = m[1];
    if (/^\s+persist:\s*null\s*$/m.test(block)) return false;
    return /name:\s*"ssid"\s*\r?\n(?:[ \t]+.*\r?\n)*?[ \t]+value:\s*"[^"\s]+"/.test(block);
}

function readSettingsFile() {
    try {
        return fs.readFileSync(settingsFilePath(), 'utf8');
    } catch {
        return null;
    }
}

// Saves the Riot Client's current kept sign-in for `username`. Only call this
// once the signed-in account has been checked to be that account. Returns
// true when a sign-in was saved.
function captureSignIn(username) {
    const key = userKey(username);
    const s = safeStorage();
    const yaml = readSettingsFile();
    if (!key || !s || !hasKeptSignIn(yaml)) return false;
    const data = load();
    data[key] = { enc: s.encryptString(yaml).toString('base64'), savedAt: Date.now() };
    save(data);
    return true;
}

// Puts the saved sign-in of `username` in place for the next Riot Client
// start. Without one, a kept sign-in of another account is removed, so the
// client does not sign in as someone else. Call only while the Riot Client is
// closed. Returns true when a saved sign-in was put in place.
function restoreSignIn(username) {
    const file = settingsFilePath();
    const entry = load()[userKey(username)];
    const s = safeStorage();
    if (entry && s) {
        try {
            const yaml = s.decryptString(Buffer.from(entry.enc, 'base64'));
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, yaml);
            return true;
        } catch (e) {
            // Another Windows user or a restored profile: sign in by typing.
            console.warn('[Sessions] Saved sign-in could not be used:', e.message);
        }
    }
    if (hasKeptSignIn(readSettingsFile())) {
        try { fs.rmSync(file, { force: true }); } catch (e) { console.warn('[Sessions] Could not clear the kept sign-in:', e.message); }
    }
    return false;
}

function hasSignIn(username) {
    return !!load()[userKey(username)];
}

function forgetSignIn(username) {
    const key = userKey(username);
    const data = load();
    if (!key || !(key in data)) return;
    delete data[key];
    save(data);
}

// Usernames (lower-cased) with a saved sign-in, for the account list.
function signInKeys() {
    return new Set(Object.keys(load()));
}

module.exports = {
    settingsFilePath, hasKeptSignIn, captureSignIn, restoreSignIn,
    hasSignIn, forgetSignIn, signInKeys,
};
