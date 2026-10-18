// Secrets at rest. The Riot API key is encrypted with Electron safeStorage
// (Windows DPAPI, bound to the Windows user) and kept in config.json only as
// that ciphertext (`riotApiKeyEnc`). The decrypted key lives in this module's
// memory and never goes to the renderer; main-process code reads it with
// getRiotApiKey().

let _riotApiKey = '';

const RIOT_KEY_PATTERN = /^RGAPI-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeStorage() {
    return require('electron').safeStorage;
}

function canEncrypt() {
    try {
        const s = safeStorage();
        return !!s && s.isEncryptionAvailable();
    } catch {
        return false;
    }
}

function encryptToBase64(text) {
    return safeStorage().encryptString(text).toString('base64');
}

// Reads the key from a freshly loaded config and migrates an old plaintext
// `riotApiKey` to `riotApiKeyEnc`. Returns true when `config` changed and
// must be saved. If Windows cannot encrypt right now, the plaintext value is
// left where it is (and still used) and the migration runs on the next start.
function loadSecrets(config) {
    let changed = false;
    _riotApiKey = '';

    if (typeof config.riotApiKeyEnc === 'string' && config.riotApiKeyEnc) {
        try {
            _riotApiKey = safeStorage().decryptString(Buffer.from(config.riotApiKeyEnc, 'base64'));
        } catch (e) {
            // Different Windows user or a restored profile: the key has to be
            // entered again. Keep the ciphertext in case the user comes back.
            console.warn('[Secrets] Riot API key could not be decrypted:', e.message);
        }
    }

    if ('riotApiKey' in config) {
        const plain = typeof config.riotApiKey === 'string' ? config.riotApiKey.trim() : '';
        if (!plain) {
            delete config.riotApiKey;
            changed = true;
        } else if (canEncrypt()) {
            config.riotApiKeyEnc = encryptToBase64(plain);
            delete config.riotApiKey;
            _riotApiKey = plain;
            changed = true;
            console.log('[Secrets] Moved the Riot API key into encrypted storage');
        } else {
            console.warn('[Secrets] Encryption unavailable; the Riot API key stays unencrypted until the next start');
            _riotApiKey = plain;
        }
    }
    return changed;
}

function getRiotApiKey() {
    return _riotApiKey;
}

function hasRiotApiKey() {
    return !!_riotApiKey;
}

// Validates and stores (or, for '', clears) the key in `config`; the caller
// saves the config. Returns { success, message? }.
function setRiotApiKey(config, key) {
    if (typeof key !== 'string') return { success: false, message: 'Invalid API key' };
    const trimmed = key.trim();
    if (!trimmed) {
        delete config.riotApiKeyEnc;
        delete config.riotApiKey;
        _riotApiKey = '';
        return { success: true };
    }
    if (!RIOT_KEY_PATTERN.test(trimmed)) {
        return { success: false, message: 'This does not look like a Riot API key (RGAPI-...)' };
    }
    if (!canEncrypt()) {
        return { success: false, message: 'Windows could not encrypt the key, so it was not saved' };
    }
    config.riotApiKeyEnc = encryptToBase64(trimmed);
    delete config.riotApiKey;
    _riotApiKey = trimmed;
    return { success: true };
}

module.exports = { loadSecrets, getRiotApiKey, hasRiotApiKey, setRiotApiKey };
