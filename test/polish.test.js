// Polish pass (light, dark, roomy and a narrow window): each fix found there.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const R = path.join(__dirname, '..', 'src', 'renderer');
const read = (...p) => fs.readFileSync(path.join(R, ...p), 'utf8');
const app = read('js', 'app.js');
const html = read('index.html');
const accountsCss = read('css', 'accounts.css');
const overlaysCss = read('css', 'overlays.css');

test('select mode highlights only the picked accounts, not the open one', () => {
    assert.match(accountsCss, /\.accounts-list\.is-selecting \.account-card\.is-selected:not\(\.is-picked\) \{ background: transparent; \}/);
});

test('the games dialog without games shows one centered message', () => {
    assert.match(app, /classList\.add\("is-empty"\)/);
    assert.match(app, /function renderGamesList\(\) \{\s*const el = document\.getElementById\("gamesList"\);\s*document\.getElementById\("gamesPane"\)\?\.classList\.remove\("is-empty"\);/);
    assert.match(overlaysCss, /\.games-pane\.is-empty \.game-detail \{ display: none; \}/);
});

test('the overlay description names the settings the overlay has', () => {
    const desc = html.match(/A small bar over the game[^<]+/)[0];
    const overlay = read('overlay.html');
    if (/opacity/i.test(desc)) assert.match(overlay, /id="ovOpacity/);
    assert.match(overlay, /id="ovItemsToggle"/, 'the Items panel button');
});

test('narrow rows drop the facts instead of cutting them', () => {
    assert.match(accountsCss, /\.text-content \{[^}]*container-type: inline-size;/);
    assert.match(accountsCss, /@container \(max-width: 190px\) \{ \.card-facts \{ display: none; \} \}/);
});

test('the rank history header wraps cleanly in a narrow panel', () => {
    assert.match(accountsCss, /\.profile-rank-history-wrap \{ container-type: inline-size; \}/);
    assert.match(accountsCss, /\.profile-rank-history-header \{[^}]*flex-wrap: wrap;/);
});

test('in a narrow window, Needs attention comes before the account cards', () => {
    assert.match(accountsCss, /\.ov-attention \{ order: -1; \}/);
});

test('an Overview card does not put old LP next to "Unranked"', () => {
    assert.match(app, /const fromHistory = !\(r\.stats\?\.tier && r\.stats\.tier !== "N\/A"\);/);
    assert.match(app, /const rankLp = r\.stats\?\.lp \|\| \(fromHistory && last \?/);
});

test('the season review says so when no ranked games are saved', () => {
    assert.match(app, /r\.rankedGamesSaved \? `in \$\{plural\(r\.rankedGamesSaved, "saved ranked game"\)\}` : "No ranked games saved yet"/);
});

test('the ban date in the panel is short enough for one line', () => {
    assert.match(app, /toLocaleString\(\[\], \{ day: "numeric", month: "short", hour: "numeric", minute: "2-digit" \}\)/);
});
