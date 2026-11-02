// The account row shows more than the rank: LP and win rate, the flex rank
// of solo-unranked accounts, when the account last played and its Blue
// Essence. And hover is visible on the panel's buttons in the dark theme.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { rankDetail, compactNumber, shortAgo, cardFacts } = require('../src/renderer/js/ui-lib.js');

const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 2, 12);

test('the line under the rank: LP and win rate, else the flex rank', () => {
    assert.equal(rankDetail({ tier: 'Diamond II', lp: '64 LP', ratio: '58%' }), '64 LP, 58% WR');
    assert.equal(rankDetail({ tier: 'Unranked', flexTier: 'Gold I', flexLp: '3 LP' }), 'Flex Gold I 3 LP');
    assert.equal(rankDetail({ tier: 'Unranked', flexTier: 'Unranked' }), '');
    assert.equal(rankDetail({ tier: 'N/A' }), '');
    assert.equal(rankDetail(null), '');
});

test('numbers and ages are short enough for the row', () => {
    assert.equal(compactNumber(109416), '109.4k');
    assert.equal(compactNumber(41000), '41k');
    assert.equal(compactNumber(276), '276');
    assert.equal(compactNumber(2500000), '2.5M');
    assert.equal(shortAgo(NOW - 2 * 3600000, NOW), 'today');
    assert.equal(shortAgo(NOW - DAY, NOW), 'yesterday');
    assert.equal(shortAgo(NOW - 5 * DAY, NOW), '5d ago');
    assert.equal(shortAgo(NOW - 21 * DAY, NOW), '3w ago');
    assert.equal(shortAgo(NOW - 90 * DAY, NOW), '3mo ago');
});

test('facts next to the Riot ID: last played (or signed in) and Blue Essence', () => {
    assert.deepEqual(cardFacts({ status: { lastPlayed: NOW - 3 * DAY, wallet: { be: 109416, rp: 276 } } }, NOW), [
        { kind: 'played', text: 'Played 3d ago' },
        { kind: 'be', text: '109.4k' },
    ]);
    assert.deepEqual(cardFacts({ lastUsed: NOW - DAY }, NOW), [{ kind: 'played', text: 'Signed in yesterday' }]);
    assert.deepEqual(cardFacts({}, NOW), []);
});

test('the row renders the facts and the rank detail', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'app.js'), 'utf8');
    assert.match(app, /<span class="card-facts"><\/span>/);
    assert.match(app, /cardFacts\(account, Date\.now\(\)\)/);
    assert.match(app, /rankDetail\(stats\)/);
});

// Relative luminance difference of two hex colors, as a contrast ratio.
function contrast(a, b) {
    const lum = (hex) => {
        const [r, g, bl] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
            .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    };
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
}

test('dark theme: hover stands out from buttons and the panel', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'css', 'tokens.css'), 'utf8');
    const dark = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
    const tok = (name) => dark.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`))[1];
    assert.ok(contrast(tok('bg-hover'), tok('surface-raised')) >= 1.15, 'hover vs button background');
    assert.ok(contrast(tok('bg-hover'), tok('surface')) >= 1.2, 'hover vs panel');
});
