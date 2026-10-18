// login.ps1 drives the real Riot Client and cannot run in a test. These checks
// pin the properties that keep credentials in the right window and intact;
// the Windows-only ones run the script's own code through powershell.exe.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const scriptPath = path.join(__dirname, '../resources/scripts/login.ps1');
const script = fs.readFileSync(scriptPath, 'utf8');
const onWindows = process.platform === 'win32';

function powershell(command, input) {
    const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
        { input, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    if (res.error) throw res.error;
    assert.equal(res.status, 0, res.stderr);
    return res.stdout.trim();
}

test('the login window is chosen by process, not by window title', () => {
    assert.doesNotMatch(script, /MainWindowTitle\s+-match/);
    assert.match(script, /Get-Process -Name \$riotUiProcessNames/);
    assert.match(script, /\$riotUiProcessNames = @\('Riot Client', 'RiotClientUx'\)/);
    assert.match(script, /\$_\.MainWindowHandle -ne 0 -and \(Test-StartedAfterLaunch \$_\)/);
});

test('focus is re-checked before Tab and before Enter', () => {
    const typing = script.slice(script.indexOf('$escapedUser'), script.indexOf('Credentials submitted'));
    const tab = typing.indexOf('SendWait("{TAB}")');
    const enter = typing.indexOf('SendWait("{ENTER}")');
    assert.ok(typing.lastIndexOf('Test-StillFocused', tab) > 0, 'checked before Tab');
    assert.ok(typing.lastIndexOf('Test-StillFocused', enter) > typing.indexOf('$escapedPwd'), 'checked before Enter');
});

test('the transcript is per run, best-effort and without the username', () => {
    assert.doesNotMatch(script, /Start-Transcript[^\r\n]*-Append/);
    assert.match(script, /try \{ Start-Transcript/);
    assert.doesNotMatch(script, /Write-Host "Username/);
});

test('the League launch is re-triggered at most twice', () => {
    assert.match(script, /\$retriggerAt\s+= @\(20, 60\)/);
    assert.doesNotMatch(script, /\$retriggerEvery/);
});

test('every parameter launch.js passes is declared by the script', { skip: !onWindows && 'needs powershell.exe' }, () => {
    const names = powershell(
        `$ast = [System.Management.Automation.Language.Parser]::ParseFile('${scriptPath}', [ref]$null, [ref]$null); `
        + '$ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath }');
    assert.deepEqual(names.split(/\r?\n/).sort(), ['NotBefore', 'RiotClientPath', 'Username']);
    const launchSrc = fs.readFileSync(path.join(__dirname, '../src/main/ipc/launch.js'), 'utf8');
    for (const flag of ['-Username', '-RiotClientPath', '-NotBefore']) {
        assert.ok(launchSrc.includes(`'${flag}'`), `launch.js passes ${flag}`);
    }
});

test('a non-ASCII password survives the trip over stdin', { skip: !onWindows && 'needs powershell.exe' }, () => {
    const decodeLine = script.split(/\r?\n/).find(l => l.includes('FromBase64String'));
    assert.ok(decodeLine, 'script decodes base64');
    const password = 'pä§wörd€ß{x}';
    const hex = powershell(
        `$encodedPassword = [Console]::In.ReadLine(); ${decodeLine.trim()}; `
        + '[BitConverter]::ToString([System.Text.Encoding]::UTF8.GetBytes($Password))',
        Buffer.from(password, 'utf8').toString('base64') + '\n');
    assert.equal(hex, Buffer.from(password, 'utf8').toString('hex').toUpperCase().match(/../g).join('-'));
});
