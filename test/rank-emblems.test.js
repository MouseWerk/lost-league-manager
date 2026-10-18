// The ranked emblems are the client's own images, bundled in assets/ranks so
// they show offline. Every tier the app knows needs its file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
const app = fs.readFileSync(path.join(RENDERER, 'js', 'app.js'), 'utf8');

test('every tier has a bundled emblem image', () => {
    const list = app.match(/const TIERS = \[([^\]]+)\]/);
    assert.ok(list, 'TIERS list in app.js');
    const tiers = [...list[1].matchAll(/"(\w+)"/g)].map(m => m[1]);
    assert.equal(tiers.length, 10);
    for (const t of tiers) {
        const file = path.join(RENDERER, 'assets', 'ranks', `${t}.png`);
        assert.ok(fs.existsSync(file), `${t}.png missing`);
        const png = fs.readFileSync(file);
        assert.equal(png.toString('ascii', 1, 4), 'PNG', `${t}.png is not a PNG`);
        assert.ok(png.readUInt32BE(16) <= 256, `${t}.png is larger than needed`);
    }
});

test('the rank views use the emblem images, not icon glyphs', () => {
    assert.ok(!/TIER_ICONS/.test(app));
    assert.match(app, /assets\/ranks\/\$\{t\}\.png/);
});
