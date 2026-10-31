// The renderer scripts are plain <script> files the tests do not load whole:
// a syntax error (two "const badges" in one function) only showed in the app,
// as a blank window. Every script must at least parse.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'src', 'renderer', 'js');

for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    test(`${file} parses`, () => {
        const src = fs.readFileSync(path.join(dir, file), 'utf8');
        assert.doesNotThrow(() => new Function(src), file);
    });
}

test('the warning badges are redrawn when the rank arrives', () => {
    const app = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
    const fn = app.slice(app.indexOf('function applyStatsToCard'), app.indexOf('\n}\n', app.indexOf('function applyStatsToCard')));
    assert.match(fn, /statusWarnings\(acc\.status, stats\?\.tier/);
});
