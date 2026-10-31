// Fixes from the 1.8 UI pass that live in markup and styles.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'src', 'renderer');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');
const stats = fs.readFileSync(path.join(root, 'css', 'stats.css'), 'utf8');

// 1.9: the overlay is finished; its settings work and it starts off.
test('the game overlay settings can be used, and the overlay is off by default', () => {
    const section = html.slice(html.indexOf('id="settingsOverlay"'), html.indexOf('id="settingsAbout"'));
    assert.doesNotMatch(section, /is-wip|In development/);
    const controls = [...section.matchAll(/<(input|button)\b[^>]*>/g)].map(m => m[0]);
    assert.equal(controls.length, 4);
    for (const c of controls) assert.doesNotMatch(c, /\bdisabled\b/, c);
    assert.match(app, /bindSettingToggle\("overlayEnabledToggle", "overlayEnabled", false\)/);
    const stateSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'state.js'), 'utf8');
    assert.match(stateSrc, /overlayEnabled: false/);
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

// "Too slim": Settings > Appearance > Layout brings back the 1.7 sizes.
test('the roomy layout enlarges the control tokens and is wired to its buttons', () => {
    const tokens = fs.readFileSync(path.join(root, 'css', 'tokens.css'), 'utf8');
    const px = (block, name) => Number((block.match(new RegExp(`${name}:\\s*(\\d+)px`)) || [])[1]);
    const base = tokens.slice(tokens.indexOf(':root {'), tokens.indexOf('--control-lg', tokens.indexOf(':root {')) + 24);
    const roomy = tokens.slice(tokens.indexOf(':root[data-density="roomy"] {'));
    for (const t of ['--control-xs', '--control-sm', '--control', '--control-lg']) {
        assert.ok(px(roomy, t) > px(base, t), t);
    }
    assert.match(html, /id="densityBtns"[\s\S]*data-density="compact"[\s\S]*data-density="roomy"/);
    assert.match(app, /document\.documentElement\.dataset\.density =/);
    // The interface size buttons must not pick up the layout buttons.
    assert.doesNotMatch(app, /querySelectorAll\("\.scale-btn"\)/);
});

// Roomy has to reach every view and dialog, not only the account list.
test('the roomy layout covers the live view, stat viewer, settings, tools and dialogs', () => {
    const tokens = fs.readFileSync(path.join(root, 'css', 'tokens.css'), 'utf8');
    const roomy = tokens.slice(tokens.indexOf(':root[data-density="roomy"] {'));
    for (const sel of ['.view', '.ov-player', '.match-item', '.ov-ranked-card', '.summoner-banner',
        '.stats-grid-item', '.stat-card', '.settings-nav-link', '.setting-card', '.modal-content',
        '.onboarding-content', '.launch-content', '.vault-lock-content']) {
        assert.ok(roomy.includes(`[data-density="roomy"] ${sel} `) || roomy.includes(`[data-density="roomy"] ${sel},`), sel);
    }
});

// Dragging a filtered list would reorder only the visible part.
test('accounts cannot be reordered while a tag filter is on', () => {
    assert.match(app, /function canReorder\(\) \{\s*return [^;]*!currentTag;/);
    assert.match(app, /if \(currentTag\) list = list\.filter\(\(a\) => hasTag\(a, currentTag\)\)/);
});

// The overlay ships as a beta: off until switched on, and labelled so.
test('the game overlay is marked Beta and off by default', () => {
    const section = html.slice(html.indexOf('id="settingsOverlay"'), html.indexOf('id="settingsAbout"'));
    assert.match(section, /<span class="wip-badge">Beta<\/span>/);
    assert.doesNotMatch(section, /Ctrl\+Shift\+H;/, 'no fixed key named as the only one');
});

test('an Overview row clears the list filters before it opens the account', () => {
    const fn = app.slice(app.indexOf('A row opens that account'), app.indexOf('selectAccount(row.dataset.username)'));
    assert.match(fn, /currentRegion = "";[\s\S]*currentTag = "";[\s\S]*currentQuery = "";/);
});

// Several accounts at once: Select, then tag, refresh, export or delete them.
test('the account list has a select mode with bulk actions', () => {
    for (const id of ['selectModeBtn', 'bulkBar', 'bulkTagBtn', 'bulkRefreshBtn', 'bulkExportBtn', 'bulkDeleteBtn']) assert.match(html, new RegExp(`id="${id}"`), id);
    assert.match(app, /if \(bulkMode\) return toggleBulkPick\(account\.username\);/);
    assert.match(app, /exportAccountsFlow\(e\.currentTarget, \[\.\.\.bulkPicked\]\)/);
});
