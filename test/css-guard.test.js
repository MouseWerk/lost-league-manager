// Design guards over the stylesheets (AICodeGuidelines design/guard-tests.md):
// no accent-colored frames on interactive states, no colored left bars,
// focus only on :focus-visible with the neutral token, reduced motion honored.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CSS_DIR = path.join(__dirname, '..', 'src', 'renderer', 'css');
const SHEETS = fs.readdirSync(CSS_DIR).filter(f => f.endsWith('.css'));

// Flattens a stylesheet into { selector, decls } rules, descending into
// @media/@supports blocks and skipping @keyframes bodies.
function parseRules(css) {
    const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [];
    let i = 0;
    function block(end) {
        while (i < end) {
            const open = src.indexOf('{', i);
            if (open === -1 || open >= end) return;
            const head = src.slice(i, open).trim();
            let depth = 1, j = open + 1;
            while (j < src.length && depth) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; j++; }
            const body = src.slice(open + 1, j - 1);
            if (/^@(media|supports)/.test(head)) {
                const save = i; i = open + 1; block(j - 1); i = save;
            } else if (!/^@(-webkit-)?keyframes/.test(head) && !head.startsWith('@')) {
                const decls = {};
                for (const d of body.split(';')) {
                    const k = d.indexOf(':');
                    if (k > 0) decls[d.slice(0, k).trim().toLowerCase()] = d.slice(k + 1).trim();
                }
                rules.push({ selector: head, decls });
            }
            i = j;
        }
    }
    block(src.length);
    return rules;
}

const STATE = /\.(active|is-active|selected|current|checked|is-fav|on|live|running|playing|dragging|drag-over)\b|:(checked|hover|focus|focus-visible|focus-within|active)\b|\[aria-(selected|current|pressed|checked)/;
const FRAME = /^(border(-\w+)*|outline(-color)?|box-shadow)$/;
// The app's accent (teal #0AC8B9) and status colors, in every spelling used.
const ACCENT = /var\(--(primary|ov-primary|primary-glow|danger|success|warning)\b|#0ac8b9|rgba?\(\s*10\s*,\s*200\s*,\s*185|#09b4a7/i;

// Drag-and-drop drop targets may show an accent outline (allowed by the guide).
const ALLOWED = [/\.drag-over\b/];

const allRules = SHEETS.flatMap(f => parseRules(fs.readFileSync(path.join(CSS_DIR, f), 'utf8')).map(r => ({ ...r, file: f })));

test('stylesheets have balanced braces and no merge markers', () => {
    for (const f of SHEETS) {
        const css = fs.readFileSync(path.join(CSS_DIR, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        assert.equal((css.match(/{/g) || []).length, (css.match(/}/g) || []).length, `${f}: unbalanced braces`);
        assert.ok(!/^(<<<<<<<|=======|>>>>>>>)/m.test(css), `${f}: merge marker`);
    }
});

test('no accent-colored borders, outlines or glows on states', () => {
    const offenders = [];
    for (const r of allRules) {
        if (!STATE.test(r.selector) || ALLOWED.some(a => a.test(r.selector))) continue;
        for (const [prop, value] of Object.entries(r.decls)) {
            if (FRAME.test(prop) && ACCENT.test(value)) offenders.push(`${r.file}: ${r.selector} { ${prop}: ${value} }`);
        }
    }
    assert.deepEqual(offenders, []);
});

test('no colored bars on the left', () => {
    const offenders = allRules.flatMap(r => Object.entries(r.decls)
        .filter(([p, v]) => /^border-(left|inline-start)(-color)?$/.test(p) && ACCENT.test(v))
        .map(([p, v]) => `${r.file}: ${r.selector} { ${p}: ${v} }`));
    assert.deepEqual(offenders, []);
});

test('focus rings use the neutral token and only on :focus-visible', () => {
    const offenders = [];
    for (const r of allRules) {
        if (!/:focus\b(?!-)/.test(r.selector)) continue;
        const ring = [r.decls.outline, r.decls['box-shadow']].filter(v => v && v !== 'none' && v !== '0');
        if (ring.length) offenders.push(`${r.file}: ${r.selector} draws a ring on :focus`);
    }
    for (const r of allRules.filter(r => /:focus-visible/.test(r.selector))) {
        const ring = r.decls['box-shadow'] || r.decls.outline || '';
        if (ring && !/var\(--focus-ring\)|none/.test(ring)) offenders.push(`${r.file}: ${r.selector} ring is not --focus-ring`);
    }
    assert.deepEqual(offenders, []);
});

test('reduced motion is honored', () => {
    for (const f of SHEETS) {
        const css = fs.readFileSync(path.join(CSS_DIR, f), 'utf8');
        if (!/animation\s*:/.test(css)) continue;
        assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/, `${f} animates but ignores prefers-reduced-motion`);
    }
});

test('no animation runs forever', () => {
    const offenders = allRules.flatMap(r => Object.entries(r.decls)
        .filter(([p, v]) => /^animation(-iteration-count)?$/.test(p) && /\binfinite\b/.test(v))
        .map(([p, v]) => `${r.file}: ${r.selector} { ${p}: ${v} }`))
        // Loading spinners and shimmer skeletons run only while something loads.
        .filter(o => !/spin|shimmer|skeleton|loading|launch-spinner|install/i.test(o));
    assert.deepEqual(offenders, []);
});
