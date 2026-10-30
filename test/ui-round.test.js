// Fixes from the 1.8 UI pass that live in markup and styles.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'src', 'renderer');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');
const stats = fs.readFileSync(path.join(root, 'css', 'stats.css'), 'utf8');

// The overlay is not built yet; its switches showed as on and could be changed.
test('the game overlay settings cannot be changed while it is in development', () => {
    const section = html.slice(html.indexOf('id="settingsOverlay"'), html.indexOf('id="settingsAbout"'));
    assert.match(section, /class="settings-section is-wip"/);
    const controls = [...section.matchAll(/<(input|button)\b[^>]*>/g)].map(m => m[0]);
    assert.equal(controls.length, 4);
    for (const c of controls) assert.match(c, /\bdisabled\b/, c);
});

// Without a client the Live view said "Idle", as if League were open.
test('the phase badge says Offline when no client is connected', () => {
    const fn = app.slice(app.indexOf('function updateGameflowBadge'), app.indexOf('function updateContextButtons'));
    assert.match(fn, /phase == null\s*\?\s*\{ label: "Offline"/);
    assert.match(app, /function setLcuOffline\(\) \{[\s\S]*?updateGameflowBadge\(null\)/);
});

// "Abyssal M..." was cut after one line.
test('item and champion names in the grids wrap to two lines', () => {
    const rule = stats.slice(stats.indexOf('.stats-grid-item span {'), stats.indexOf('}', stats.indexOf('.stats-grid-item span {')));
    assert.match(rule, /-webkit-line-clamp: 2/);
    assert.doesNotMatch(rule, /white-space: nowrap/);
});

// The panel showed "N/A" where the list row says "Rank unavailable".
test('a failed rank lookup reads "Rank unavailable" in the list and the panel', () => {
    const fill = app.slice(app.indexOf('function fillProfileRank'), app.indexOf('function populateProfileModal'));
    assert.match(fill, /tier === "N\/A" \? "Rank unavailable"/);
    assert.match(app, /\? "Rank unavailable"/);
});

// tierClass("Diamond II") returned rank-unranked: grey ranks in the panel.
test('the tier color works for full tier text', () => {
    const start = app.indexOf('function tierClass');
    const src = app.slice(start, start + app.slice(start).search(/\r?\n\}/) + 3);
    const TIERS = ['iron', 'bronze', 'silver', 'gold', 'platinum', 'emerald', 'diamond', 'master', 'grandmaster', 'challenger'];
    const tierClass = new Function('TIERS', `${src}; return tierClass;`)(TIERS);
    assert.equal(tierClass('Diamond II'), 'rank-diamond');
    assert.equal(tierClass('GOLD'), 'rank-gold');
    assert.equal(tierClass('Master'), 'rank-master');
    assert.equal(tierClass('Unranked'), 'rank-unranked');
    assert.equal(tierClass(null), 'rank-unranked');
});
