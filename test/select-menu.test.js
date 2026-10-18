// Themed dropdowns (src/renderer/js/select-menu.js): keyboard movement over
// options, type-ahead, and the page loading the script before app.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { nextEnabledIndex, typeaheadIndex } = require('../src/renderer/js/select-menu.js');

const o = (label, disabled = false) => ({ label, value: label.toLowerCase(), disabled });
const REGIONS = [o('Select region...', true), o('EUW'), o('EUNE'), o('NA', true), o('KR')];

test('arrow keys skip disabled options and stop at the ends', () => {
    assert.equal(nextEnabledIndex(REGIONS, 0, 1), 1);
    assert.equal(nextEnabledIndex(REGIONS, 2, 1), 4);   // NA is disabled
    assert.equal(nextEnabledIndex(REGIONS, 4, 1), 4);   // last stays last
    assert.equal(nextEnabledIndex(REGIONS, 1, -1), 1);  // placeholder is never active
    assert.equal(nextEnabledIndex(REGIONS, 4, -1), 2);
});

test('Home and End land on the first and last enabled option', () => {
    assert.equal(nextEnabledIndex(REGIONS, -1, 1), 1);
    assert.equal(nextEnabledIndex(REGIONS, REGIONS.length, -1), 4);
    assert.equal(nextEnabledIndex([], -1, 1), -1);
});

test('type-ahead finds the next match and wraps around', () => {
    assert.equal(typeaheadIndex(REGIONS, 0, 'e'), 1);
    assert.equal(typeaheadIndex(REGIONS, 1, 'e'), 2);   // pressing again moves on
    assert.equal(typeaheadIndex(REGIONS, 2, 'e'), 1);   // and wraps
    assert.equal(typeaheadIndex(REGIONS, 1, 'eun'), 2);
    assert.equal(typeaheadIndex(REGIONS, 0, 'n'), -1);  // NA is disabled
    assert.equal(typeaheadIndex(REGIONS, 0, ''), -1);
});

test('the page loads the dropdown script after ui-lib and before app.js', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
    const order = [...html.matchAll(/<script src="js\/([\w.-]+)"/g)].map(m => m[1]);
    assert.ok(order.indexOf('select-menu.js') > order.indexOf('ui-lib.js'));
    assert.ok(order.indexOf('select-menu.js') < order.indexOf('app.js'));
});
