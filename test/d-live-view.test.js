// Live view wiring in app.js (the behaviour needs a League client; these
// source checks pin the parts that keep the panel and its timers in step
// with the gameflow phase).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'app.js'), 'utf8');

function functionBody(name) {
    const start = app.indexOf(`function ${name}(`);
    assert.ok(start !== -1, `${name} exists`);
    const open = app.indexOf('{', start);
    let depth = 1, i = open + 1;
    while (depth && i < app.length) { if (app[i] === '{') depth++; else if (app[i] === '}') depth--; i++; }
    return app.slice(open, i);
}

test('gameflow events refresh the live view while it is visible', () => {
    assert.match(app, /onLcuGameflow\(handleGameflowEvent\)/);
    const body = functionBody('handleGameflowEvent');
    assert.match(body, /currentView === "liveView"/);
    assert.match(body, /setTimeout\(loadLiveView/);
    assert.match(body, /phase !== "Matchmaking"[\s\S]*clearInterval\(_queueTimerInterval\)/);
});

test('an older live view load never overwrites a newer one', () => {
    const body = functionBody('loadLiveView');
    assert.match(body, /const gen = \+\+_liveGen/);
    assert.match(body, /if \(gen !== _liveGen\) return/);
    // Timers of the previous phase always stop before the new phase renders.
    assert.match(body, /stopLiveTimers\(\)/);
});

test('leaving the live view stops its timers', () => {
    assert.match(functionBody('showView'), /stopLiveTimers\(\)/);
    assert.ok(!/window\._(queue|game)TimerInterval/.test(app), 'no leftover window-global timers');
});
