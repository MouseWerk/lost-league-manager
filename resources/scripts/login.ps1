param (
    [string]$Username,
    [string]$RiotClientPath = "",
    # Unix time in ms at which the app started the Riot Client; only windows
    # of processes started after it can receive the credentials.
    [long]$NotBefore = 0,
    # What the Riot Client starts after the sign-in, and the process that shows
    # it came up: League (default) or Valorant.
    [ValidateSet("league_of_legends", "valorant")]
    [string]$Product = "league_of_legends",
    [ValidateSet("LeagueClient", "VALORANT-Win64-Shipping")]
    [string]$GameProcess = "LeagueClient"
)

$ErrorActionPreference = "Stop"

# One log per run (not appended forever), without the username. It used to be
# a PowerShell transcript, whose header holds the full command line and so the
# login name. A locked log file must not stop the login: writing is best-effort.
$logPath = Join-Path $env:TEMP "leaguelogin_debug.txt"
try { Set-Content -Path $logPath -Value $null -Force } catch { }

# Every line goes to the app (stdout) and to the log file.
function Log ([string]$message) {
    Write-Host $message
    try { Add-Content -Path $logPath -Value $message } catch { }
}

function Exit-Script ([int]$code) {
    exit $code
}

# Any error nothing else catches ends the script with its own code (5), so the
# app can tell it apart from "window not found" (1).
trap {
    Log "ERROR: $_"
    Exit-Script 5
}

Log "Script Started at $(Get-Date)"

# Read the password from stdin rather than a command-line argument, so it
# never appears in this process's argv (visible to other local processes via
# Task Manager / WMI for the life of the process). The app sends base64 of the
# UTF-8 bytes: Windows PowerShell decodes console input with the OEM code
# page, which garbled every non-ASCII character (umlauts, sharp s, euro sign).
$encodedPassword = [Console]::In.ReadLine()
if ([string]::IsNullOrWhiteSpace($encodedPassword)) {
    Log "ERROR: No password received"
    Exit-Script 4
}
$Password = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($encodedPassword.Trim()))

Add-Type -AssemblyName System.Windows.Forms

# BlockInput helper
try {
    $memberDef = '[DllImport("user32.dll")] public static extern bool BlockInput(bool fBlockIt);'
    $inputBlocker = Add-Type -MemberDefinition $memberDef -Name 'InputBlocker' -Namespace Win32 -PassThru
}
catch { }

# Window-activation helpers. WScript.Shell's AppActivate (the old approach) is
# unreliable against a window that just finished loading — Windows' foreground-
# lock protection can silently reject it, and the old code never checked the
# return value before typing, so credentials sometimes went to whatever window
# actually had focus instead of the Riot Client.
try {
    $winApiDef = @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
'@
    $winApi = Add-Type -MemberDefinition $winApiDef -Name 'WinApi' -Namespace Win32 -PassThru
}
catch { $winApi = $null }

function Escape-SendKeys ($text) {
    $sb = New-Object System.Text.StringBuilder
    foreach ($char in $text.ToCharArray()) {
        if ("+^%~(){}[]".IndexOf($char) -ge 0) {
            [void]$sb.Append("{$char}")
        }
        else {
            [void]$sb.Append($char)
        }
    }
    return $sb.ToString()
}

function Force-Foreground {
    param ($hwnd)
    if (-not $winApi -or $hwnd -eq [IntPtr]::Zero) { return $false }
    try {
        $curFg = [Win32.WinApi]::GetForegroundWindow()
        if ($curFg -eq $hwnd) { return $true }

        [uint32]$dummy = 0
        $fgThread  = [Win32.WinApi]::GetWindowThreadProcessId($curFg, [ref]$dummy)
        $curThread = [Win32.WinApi]::GetCurrentThreadId()

        # A background process normally can't steal foreground focus; briefly
        # attaching input state to the current foreground thread lets it.
        [void][Win32.WinApi]::AttachThreadInput($curThread, $fgThread, $true)
        [void][Win32.WinApi]::ShowWindowAsync($hwnd, 9)  # SW_RESTORE
        [void][Win32.WinApi]::SetForegroundWindow($hwnd)
        [void][Win32.WinApi]::AttachThreadInput($curThread, $fgThread, $false)

        return ([Win32.WinApi]::GetForegroundWindow() -eq $hwnd)
    }
    catch { return $false }
}

function Ensure-Focus {
    param ($procId, $hwnd)
    if (Force-Foreground -hwnd $hwnd) { return $true }
    # Fallback to the older COM-based activation, best-effort.
    try {
        $wshell = New-Object -ComObject WScript.Shell
        return [bool]$wshell.AppActivate($procId)
    }
    catch { return $false }
}

# Process id that owns the foreground window, or 0.
function Get-ForegroundProcessId {
    if (-not $winApi) { return 0 }
    try {
        [uint32]$fgPid = 0
        [void][Win32.WinApi]::GetWindowThreadProcessId([Win32.WinApi]::GetForegroundWindow(), [ref]$fgPid)
        return [int]$fgPid
    }
    catch { return 0 }
}

# Checked right before each keystroke batch: credentials only ever go to the
# Riot Client, never to whatever took focus since. Any window of a Riot Client
# UI process started for this login counts: the client replaces its loading
# window with the login window, so one fixed window handle went stale and the
# login stopped with "Lost focus" although the Riot Client had the focus.
function Test-StillFocused {
    param ($hwnd)
    if (-not $winApi) { return $true }  # no API to check with; Wait-ForFocus already ran
    try {
        if ([Win32.WinApi]::GetForegroundWindow() -eq $hwnd) { return $true }
        $fgPid = Get-ForegroundProcessId
        if ($fgPid -eq 0) { return $false }
        return [bool](Get-RiotUiProcesses | Where-Object { $_.Id -eq $fgPid })
    }
    catch { return $false }
}

# Name of the process that has the focus, for the log (never a window title).
function Get-ForegroundProcessName {
    $fgPid = Get-ForegroundProcessId
    if ($fgPid -eq 0) { return "unknown" }
    try { return (Get-Process -Id $fgPid -ErrorAction Stop).ProcessName }
    catch { return "unknown" }
}

function Wait-ForFocus {
    param ($procId, $hwnd, [int]$maxAttempts = 6, [int]$delayMs = 400)
    for ($i = 0; $i -lt $maxAttempts; $i++) {
        if (Ensure-Focus -procId $procId -hwnd $hwnd) { return $true }
        Start-Sleep -Milliseconds $delayMs
    }
    return $false
}

# The Riot Client UI process: "Riot Client" in current builds, RiotClientUx in
# older ones. Matching on the window title alone also matched Explorer windows,
# browser tabs or chats with "Riot Client" in their title, and the window of
# the client that was just closed.
$riotUiProcessNames = @('Riot Client', 'RiotClientUx')
# Two seconds of slack for clock granularity between Node and Windows.
$notBeforeUtc = if ($NotBefore -gt 0) {
    [DateTimeOffset]::FromUnixTimeMilliseconds($NotBefore).UtcDateTime.AddSeconds(-2)
} else { [DateTime]::MinValue }

function Test-StartedAfterLaunch ($p) {
    try { return ($p.StartTime.ToUniversalTime() -ge $notBeforeUtc) }
    catch { return $false }  # start time unreadable: not provably ours
}

function Get-RiotUiProcesses {
    Get-Process -Name $riotUiProcessNames -ErrorAction SilentlyContinue | Where-Object { Test-StartedAfterLaunch $_ }
}

# A fresh Process object each call: MainWindowHandle is read once per object,
# so an old one keeps pointing at the loading window.
function Find-RiotClientWindow {
    Get-RiotUiProcesses | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
}

# Wait for Riot Client login window
Log "Waiting for Riot Client window..."
$proc = $null
for ($i = 0; $i -lt 120; $i++) {
    $proc = Find-RiotClientWindow
    if ($proc) { break }
    Start-Sleep -Milliseconds 500
}

if (-not $proc) {
    Log "Timeout: Riot Client window not found"
    Exit-Script 1
}

Log "Found window: '$($proc.MainWindowTitle)' - waiting for UI to load..."
Start-Sleep -Seconds 5

# The window found above is often the loading window, which the client
# replaces with the login window: look it up again now.
$fresh = Find-RiotClientWindow
if ($fresh) { $proc = $fresh }
$hwnd = $proc.MainWindowHandle
if (-not (Wait-ForFocus -procId $proc.Id -hwnd $hwnd)) {
    Log "ERROR: Could not bring the Riot Client window to the foreground after retries - aborting rather than typing into the wrong window"
    Exit-Script 2
}
Log "Riot Client window focused"

# Enter credentials
$canBlock = ("Win32.InputBlocker" -as [type])
try {
    if ($canBlock) {
        try { [void][Win32.InputBlocker]::BlockInput($true) }
        catch { Log "BlockInput failed (admin required)" }
    }

    $escapedUser = Escape-SendKeys -text $Username
    [System.Windows.Forms.SendKeys]::SendWait($escapedUser)
    Start-Sleep -Milliseconds 300

    # Something took the focus while typing (often the Riot Client bringing up
    # its login window late): focus the client again and type the name anew,
    # replacing whatever reached the field.
    if (-not (Test-StillFocused -hwnd $hwnd)) {
        Log "Focus moved to '$(Get-ForegroundProcessName)' after the username - focusing the Riot Client again"
        $fresh = Find-RiotClientWindow
        if ($fresh) { $proc = $fresh; $hwnd = $proc.MainWindowHandle }
        if (-not (Wait-ForFocus -procId $proc.Id -hwnd $hwnd -maxAttempts 4 -delayMs 400)) {
            Log "ERROR: Lost focus on the Riot Client window after the username - aborting"
            Exit-Script 2
        }
        Start-Sleep -Milliseconds 300
        [System.Windows.Forms.SendKeys]::SendWait("^a")
        [System.Windows.Forms.SendKeys]::SendWait($escapedUser)
        Start-Sleep -Milliseconds 300
        if (-not (Test-StillFocused -hwnd $hwnd)) {
            Log "ERROR: Lost focus on the Riot Client window after the username - aborting"
            Exit-Script 2
        }
    }
    [System.Windows.Forms.SendKeys]::SendWait("{TAB}")
    Start-Sleep -Milliseconds 300

    # Re-verify focus right before the password specifically — typing a
    # plaintext password into whatever window stole focus in the meantime
    # (a notification, another app) would be worse than just stopping.
    if (-not (Wait-ForFocus -procId $proc.Id -hwnd $hwnd -maxAttempts 3 -delayMs 300)) {
        Log "ERROR: Lost focus on the Riot Client window before entering the password - aborting"
        Exit-Script 2
    }
    $escapedPwd = Escape-SendKeys -text $Password
    [System.Windows.Forms.SendKeys]::SendWait($escapedPwd)
    Start-Sleep -Milliseconds 300

    # Enter in the wrong window could send the password as a chat message.
    if (-not (Test-StillFocused -hwnd $hwnd)) {
        Log "ERROR: Lost focus on the Riot Client window before submitting - aborting"
        Exit-Script 2
    }
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
    Log "Credentials submitted"
}
finally {
    # Unlock input immediately; never leave user locked out.
    if ($canBlock) {
        try { [void][Win32.InputBlocker]::BlockInput($false) }
        catch { }
    }
}

# Wait for League to start. After pressing Enter, Riot Client authenticates
# and is *supposed* to start League automatically since it was launched with
# --launch-product=league_of_legends, but that auto-launch signal is
# unreliable on its own (auth timing, patchline checks, etc.), so the trigger
# is re-issued while polling. Only twice and with long gaps: each re-trigger
# can pull the Riot Client window forward and interrupt someone typing a
# verification code.
Log "Polling for the game client launch..."

$rcExe = $RiotClientPath
if (-not ($rcExe -and (Test-Path $rcExe))) {
    $rcProc = Get-Process -Name "RiotClientServices" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($rcProc) {
        try { $rcExe = $rcProc.MainModule.FileName }
        catch { }
    }
}

function Trigger-LeagueLaunch {
    if ($rcExe -and (Test-Path $rcExe)) {
        Log "Launch triggered - retrying via RiotClientServices..."
        try { Start-Process -FilePath $rcExe -ArgumentList "--launch-product=$Product", "--launch-patchline=live" }
        catch { Log "Launch trigger failed: $_" }
    }
}

$leagueStarted   = $false
$maxWaitSeconds  = 150
$retriggerAt     = @(20, 60)
$elapsedSeconds  = 0
$triggerIndex    = 0

while ($elapsedSeconds -lt $maxWaitSeconds) {
    Start-Sleep -Milliseconds 500
    $elapsedSeconds += 0.5

    if (Get-Process -Name $GameProcess -ErrorAction SilentlyContinue) {
        Log "Game client detected - done!"
        $leagueStarted = $true
        break
    }

    if ($triggerIndex -lt $retriggerAt.Count -and $elapsedSeconds -ge $retriggerAt[$triggerIndex]) {
        Trigger-LeagueLaunch
        $triggerIndex++
    }
}

if ($leagueStarted) {
    Log "Login script complete"
    Exit-Script 0
}
else {
    Log "The game did not auto-start after $maxWaitSeconds seconds - manual launch required"
    Exit-Script 3
}
