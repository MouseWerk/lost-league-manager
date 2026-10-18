// RiotClientInstalls.json as current Riot Client versions write it: League's
// folder only appears as a key of associated_client. The old lookup only
// read `league_of_legends*` keys and never found these installs.
const fs = require('fs');
const os = require('os');
const path = require('path');

const programData = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-programdata-'));
const leagueDir = path.join(programData, 'Games', 'Riot Games', 'League of Legends');
const riotClientExe = path.join(programData, 'Games', 'Riot Games', 'Riot Client', 'RiotClientServices.exe');
fs.mkdirSync(leagueDir, { recursive: true });
fs.mkdirSync(path.dirname(riotClientExe), { recursive: true });
fs.writeFileSync(path.join(leagueDir, 'LeagueClient.exe'), '');
fs.writeFileSync(riotClientExe, '');

const fwd = (p) => p.replace(/\\/g, '/');
fs.mkdirSync(path.join(programData, 'Riot Games'));
fs.writeFileSync(path.join(programData, 'Riot Games', 'RiotClientInstalls.json'), JSON.stringify({
    associated_client: { [fwd(leagueDir) + '/']: fwd(riotClientExe) },
    rc_default: fwd(riotClientExe),
    rc_live: fwd(riotClientExe),
}));

// Both modules read the ProgramData location from the environment.
process.env.PROGRAMDATA = programData;
process.env.ProgramData = programData;

require('./helpers/fake-electron');
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveLolPath } = require('../src/main/services/league-path');
const state = require('../src/main/state');
const { riotClientFromInstallsJson } = require('../src/main/ipc/launch');

test('a stale League path is healed from associated_client', () => {
    const found = resolveLolPath('Z:\\nowhere\\LeagueClient.exe');
    assert.equal(path.normalize(found), path.join(leagueDir, 'LeagueClient.exe'));
});

test('an existing configured League path is kept', () => {
    const configured = path.join(leagueDir, 'LeagueClient.exe');
    assert.equal(resolveLolPath(configured), configured);
});

test('the Riot Client for this League install comes first', () => {
    state.config.lolPath = path.join(leagueDir, 'LeagueClient.exe');
    const candidates = riotClientFromInstallsJson();
    assert.equal(candidates[0], path.normalize(riotClientExe));
});
