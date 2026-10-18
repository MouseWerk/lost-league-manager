// Rule guards over the renderer sources: no emojis, a Content-Security-Policy
// on every page, and nothing that policy would block (inline scripts, styles
// or event-handler attributes).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
const PAGES = ['index.html', 'overlay.html'];
const SOURCES = [...PAGES, 'js/app.js', 'js/overlay.js'];
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
