// Unit tests for the pure renderer helpers in src/renderer/js/ui-lib.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../src/renderer/js/ui-lib.js');

test('escapeHtml escapes markup from outside sources', () => {
    assert.equal(lib.escapeHtml('<img src=x onerror=1>Gold'), '&lt;img src=x onerror=1&gt;Gold');
    assert.equal(lib.escapeHtml(`"a" & 'b'`), '&quot;a&quot; &amp; &#39;b&#39;');
    assert.equal(lib.escapeHtml(null), '');
    assert.equal(lib.escapeHtml(42), '42');
    assert.equal(lib.escapeHtml('Nunu & Willump'), 'Nunu &amp; Willump');
});

test('rankScore orders divisions within a tier', () => {
    const s = (tier, lp) => lib.rankScore({ tier, lp });
    assert.ok(s('Gold I', '10 LP') > s('Gold IV', '90 LP'));
    assert.ok(s('Gold II') > s('Gold III'));
    assert.ok(s('Gold III', '0 LP') > s('Gold IV', '99 LP'));
    assert.ok(s('Platinum IV', '0 LP') > s('Gold I', '99 LP'));
});

test('rankScore uses LP within a division and in apex tiers', () => {
    const s = (tier, lp) => lib.rankScore({ tier, lp });
    assert.ok(s('Gold I', '90 LP') > s('Gold I', '10 LP'));
    assert.ok(s('Master', '900 LP') > s('Master', '50 LP'));
    // Apex division text (Riot sends "I", the LCU "NA") must not outweigh LP.
    assert.ok(s('Master', '900 LP') > s('Master I', '50 LP'));
    assert.ok(s('Grandmaster', '0 LP') > s('Master', '1500 LP'));
    assert.ok(s('Challenger', '0 LP') > s('Grandmaster', '1400 LP'));
});

test('rankScore puts unranked and missing data last', () => {
    assert.equal(lib.rankScore({ tier: 'Unranked' }), 0);
    for (const v of [undefined, null, {}, { tier: 'N/A' }, { tier: 'Loading stats...' }, { tier: 'Err' }, '']) {
        assert.equal(lib.rankScore(v), -1, JSON.stringify(v));
    }
    assert.ok(lib.rankScore({ tier: 'Iron IV', lp: '0 LP' }) > lib.rankScore({ tier: 'Unranked' }));
    assert.ok(lib.rankScore('Gold IV') > lib.rankScore('Silver I'));
});

test('reorderList moves a card onto the drop target, both directions', () => {
    const abc = ['A', 'B', 'C'];
    assert.deepEqual(lib.reorderList(abc, 0, 1), ['B', 'A', 'C']);
    assert.deepEqual(lib.reorderList(abc, 0, 2), ['B', 'C', 'A']);
    assert.deepEqual(lib.reorderList(abc, 2, 0), ['C', 'A', 'B']);
    assert.deepEqual(lib.reorderList(abc, 1, 0), ['B', 'A', 'C']);
    assert.deepEqual(lib.reorderList(abc, 1, 1), abc);
    assert.deepEqual(lib.reorderList(abc, -1, 1), abc);
    assert.deepEqual(abc, ['A', 'B', 'C'], 'input is not mutated');
});

test('stats cache entries expire after 10 minutes', () => {
    const acc = { region: 'euw', riotId: 'Name#TAG' };
    const entry = lib.makeStatsEntry({ tier: 'Gold I' }, acc, 1_000_000);
    assert.equal(lib.statsEntryState(entry, acc, 1_000_000), 'fresh');
    assert.equal(lib.statsEntryState(entry, acc, 1_000_000 + lib.STATS_TTL_MS - 1), 'fresh');
    assert.equal(lib.statsEntryState(entry, acc, 1_000_000 + lib.STATS_TTL_MS), 'stale');
    assert.equal(lib.STATS_TTL_MS, 10 * 60 * 1000);
    // Clock moved back: an entry from the future is not trusted as fresh.
    assert.equal(lib.statsEntryState(entry, acc, 1_000_000 - 5000), 'stale');
});

test('stats cache entries are dropped when the Riot ID or region changes', () => {
    const acc = { region: 'euw', riotId: 'Name#TAG' };
    const entry = lib.makeStatsEntry({ tier: 'Gold I' }, acc, 0);
    assert.equal(lib.statsEntryState(entry, { region: 'na', riotId: 'Name#TAG' }, 0), 'missing');
    assert.equal(lib.statsEntryState(entry, { region: 'euw', riotId: 'Other#TAG' }, 0), 'missing');
    assert.equal(lib.statsEntryState(entry, { region: 'EUW', riotId: 'name#tag' }, 0), 'fresh', 'case does not matter');
    assert.equal(lib.statsEntryState(undefined, acc, 0), 'missing');
});

test('errors are never cached', () => {
    assert.equal(lib.shouldCacheStats({ tier: 'Gold I', lp: '1 LP' }), true);
    assert.equal(lib.shouldCacheStats({ tier: 'N/A', error: 'OP.GG unreachable' }), false);
    assert.equal(lib.shouldCacheStats({ tier: 'Gold I', stale: true, error: 'timeout' }), false);
    assert.equal(lib.shouldCacheStats({ tier: 'N/A' }), false);
    assert.equal(lib.shouldCacheStats(null), false);
});

test('stat growth matches the League formula', () => {
    assert.equal(lib.growStat(600, 100, 1), 600);
    assert.ok(Math.abs(lib.growStat(600, 100, 18) - (600 + 17 * 100)) < 1e-9);
    assert.ok(Math.abs(lib.statGrowthFactor(18) - 1) < 1e-9);
    assert.equal(lib.attackSpeedAt(0.625, 2, 1), 0.625);
    assert.ok(Math.abs(lib.attackSpeedAt(0.625, 2, 18) - 0.625 * 1.34) < 1e-9);
});

test('sparkline points fill the whole box', () => {
    const pts = lib.sparklinePoints([{ score: 10 }, { score: 30 }, { score: 20 }], 300, 60, 3);
    assert.equal(pts.length, 3);
    assert.equal(pts[0].x, 3);
    assert.equal(pts[2].x, 297);
    assert.equal(pts[0].y, 57, 'lowest score at the bottom of the 60 unit box');
    assert.equal(pts[1].y, 3, 'highest score at the top');
    assert.equal(pts[2].y, 30);
    const flat = lib.sparklinePoints([{ score: 5 }, { score: 5 }], 300, 60);
    assert.deepEqual(flat.map(p => p.y), [30, 30]);
    assert.deepEqual(lib.sparklinePoints([], 300, 60), []);
});

test('lobby members show their Riot ID', () => {
    assert.equal(lib.lobbyMemberLabel({ gameName: 'Faker', tagLine: 'KR1', summonerName: '' }), 'Faker#KR1');
    assert.equal(lib.lobbyMemberLabel({ summonerName: 'Old' }), 'Old');
    assert.equal(lib.lobbyMemberLabel({ summonerInternalName: 'old2' }), 'old2');
    assert.equal(lib.lobbyMemberLabel({}), '?');
});

test('login status payloads are normalized, old and new shapes', () => {
    assert.deepEqual(lib.normalizeLoginStatus(null), { clear: true });
    assert.equal(lib.normalizeLoginStatus({ message: 'Preparing...', progress: 5 }).kind, null);
    assert.equal(lib.normalizeLoginStatus({ message: 'Login failed', progress: 0, error: true }).kind, 'failed');
    assert.equal(lib.normalizeLoginStatus({ message: 'Done!', progress: 100 }).kind, 'done');
    assert.equal(lib.normalizeLoginStatus({ message: 'Signed in as someone else', error: true, kind: 'wrong-account' }).kind, 'wrong-account');
    assert.equal(lib.normalizeLoginStatus({ message: 'Cancelled', kind: 'cancelled' }).kind, 'cancelled');
    assert.equal(lib.normalizeLoginStatus({ message: 'x', progress: 250 }).progress, 100);
    assert.equal(lib.needsLaunchAttention('needs-action'), true);
    assert.equal(lib.needsLaunchAttention('failed'), true);
    assert.equal(lib.needsLaunchAttention('done'), false);
    assert.equal(lib.needsLaunchAttention(null), false);
});

test('new passphrases: at least 8 characters, typed twice, never trimmed', () => {
    assert.match(lib.validateNewPassphrase('short', 'short'), /at least 8/);
    assert.match(lib.validateNewPassphrase('longenough', 'longenougH'), /do not match/);
    assert.equal(lib.validateNewPassphrase('longenough', 'longenough'), null);
    // Spaces count and are kept: "  1234567" is 9 characters.
    assert.equal(lib.validateNewPassphrase('  1234567', '  1234567'), null);
    assert.match(lib.validateNewPassphrase('pass word ', 'pass word'), /do not match/);
    assert.equal(lib.validateNewPassphrase('ab', 'ab', 1), null, 'minimum is configurable (vault password: 1)');
});

test('retry countdown rounds up to whole seconds', () => {
    assert.equal(lib.secondsUntil(1), 1);
    assert.equal(lib.secondsUntil(1000), 1);
    assert.equal(lib.secondsUntil(1001), 2);
    assert.equal(lib.secondsUntil(0), 1);
});
