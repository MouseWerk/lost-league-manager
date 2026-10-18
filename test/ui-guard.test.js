// Rule guards over the renderer sources: no emojis, a Content-Security-Policy
// on every page, and nothing that policy would block (inline scripts, styles
// or event-handler attributes).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
const PAGES = ['index.html', 'overlay.html'];
const SOURCES = [...PAGES, 'js/app.js', 'js/ui-lib.js', 'js/overlay.js'];
const read = (rel) => fs.readFileSync(path.join(RENDERER, rel), 'utf8');

test('no emojis in UI sources', () => {
    const offenders = [];
    for (const rel of SOURCES) {
        read(rel).split('\n').forEach((line, i) => {
            if (/\p{Extended_Pictographic}/u.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 80)}`);
        });
    }
    assert.deepEqual(offenders, []);
});

test('every page sets a strict Content-Security-Policy', () => {
    for (const page of PAGES) {
        const m = read(page).match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/);
        assert.ok(m, `${page} has no CSP`);
        const csp = m[1];
        assert.match(csp, /script-src 'self'(;|$)/, `${page}: script-src must be 'self' only`);
        assert.ok(!/script-src[^;]*'unsafe-(inline|eval)'/.test(csp), `${page}: unsafe script source`);
        assert.match(csp, /object-src 'none'/, `${page}: object-src`);
    }
});

// Markup built in app.js must not interpolate a raw property (`${stats.lp}`,
// `${m.championIcon}`): stats, match history and Data Dragon text come from
// outside (OP.GG, imported backups) and go through escapeHtml(...) instead.
// Plain local variables (numbers, constant class names) are allowed.
function rawMemberInterpolations(source) {
    const member = /\$\{\s*[A-Za-z_$][\w$]*(?:\??\.[\w$]+|\[[^\]]+\])+\s*\}/;
    const offenders = [];
    source.split('\n').forEach((line, i) => {
        if (line.includes('<') && member.test(line)) offenders.push(`${i + 1}: ${line.trim().slice(0, 100)}`);
    });
    return offenders;
}

test('markup in app.js escapes every interpolated property', () => {
    assert.deepEqual(rawMemberInterpolations(read('js/app.js')), []);
    // The check itself catches the shapes it is meant for.
    assert.equal(rawMemberInterpolations('el.innerHTML = `<span>${stats.lp}</span>`;').length, 1);
    assert.equal(rawMemberInterpolations('el.innerHTML = `<img src="${m?.icon}">`;').length, 1);
    assert.equal(rawMemberInterpolations('el.innerHTML = `<span>${escapeHtml(stats.lp)}</span>`;').length, 0);
});

test('vault passwords leave the renderer as typed: no hashing, no trimming', () => {
    const app = read('js/app.js');
    // The main process verifies with salted scrypt; a renderer-side hash
    // would become the password (anyone reading it could unlock).
    assert.ok(!/crypto\.subtle|sha256/i.test(app), 'app.js must not hash vault passwords');
    assert.match(app, /unlockVault\(input\.value\)/, 'unlock sends the input value unchanged');
    assert.ok(!/vaultPassword\w*["']\)\??\.value\??\.trim\(\)/.test(app), 'vault password inputs are not trimmed');
    assert.ok(!/vaultPasswordHash|config\.riotApiKey\s*\|\|/.test(app), 'no vault hash or API key read from config');
});

test('index.html loads ui-lib.js before app.js', () => {
    const html = read('index.html');
    const lib = html.indexOf('<script src="js/ui-lib.js"></script>');
    const app = html.indexOf('<script src="js/app.js"></script>');
    assert.ok(lib !== -1 && app !== -1 && lib < app, 'ui-lib.js must be a src= script before app.js');
});

test('no inline scripts, styles or event-handler attributes', () => {
    const offenders = [];
    for (const page of PAGES) {
        const html = read(page);
        if (/<script(?![^>]*\bsrc=)[^>]*>/.test(html)) offenders.push(`${page}: inline <script>`);
        if (/<style\b/.test(html)) offenders.push(`${page}: inline <style>`);
    }
    for (const rel of SOURCES) {
        read(rel).split('\n').forEach((line, i) => {
            if (/\son(click|error|load|input|change|submit|mouse\w+|key\w+)\s*=\s*["']/i.test(line)) {
                offenders.push(`${rel}:${i + 1}: inline handler`);
            }
        });
    }
    assert.deepEqual(offenders, []);
});

// A form dialog replaced while its submit was in flight resolves null even
// though main applied the change; the vault switch must follow main's state.
test('the vault switch re-reads the state from main after its dialog', () => {
    const app = read('js/app.js');
    const fn = app.slice(app.indexOf('async function initVaultSettings'), app.indexOf('function initRiotApiKeySettings'));
    assert.match(fn, /enabled = \(await readVaultState\(config\)\)\.enabled;\s*\r?\n\s*render\(\);\s*\r?\n\s*\}\);/);
});
