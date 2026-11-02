// Blue Essence and RP show the client's own currency icons, bundled in
// assets/currency so they work offline, instead of generic icon glyphs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');

test('the currency icons are bundled PNGs', () => {
    for (const name of ['blue-essence', 'rp']) {
        const png = fs.readFileSync(path.join(RENDERER, 'assets', 'currency', `${name}.png`));
        assert.equal(png.toString('ascii', 1, 4), 'PNG', `${name}.png is not a PNG`);
    }
});

test('the wallet uses the client icons, not a glyph', () => {
    const wallet = html.match(/<div id="profileWalletWrap"[\s\S]*?<\/div>/)[0];
    assert.match(wallet, /src="assets\/currency\/blue-essence\.png"/);
    assert.match(wallet, /src="assets\/currency\/rp\.png"/);
    assert.doesNotMatch(wallet, /fa-gem/);
});
