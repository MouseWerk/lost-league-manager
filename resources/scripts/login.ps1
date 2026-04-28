param (
    [string]$Username,
    [string]$Password,
    [string]$RiotClientPath = ""
)

$ErrorActionPreference = "Stop"

$logPath = Join-Path $env:TEMP "leaguelogin_debug.txt"
Start-Transcript -Path $logPath -Append

Write-Host "Script Started at $(Get-Date)"
Write-Host "Username: $Username"

Add-Type -AssemblyName System.Windows.Forms

# BlockInput helper
try {
    $memberDef = '[DllImport("user32.dll")] public static extern bool BlockInput(bool fBlockIt);'
    $inputBlocker = Add-Type -MemberDefinition $memberDef -Name 'InputBlocker' -Namespace Win32 -PassThru
}
catch { }

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

function Ensure-Focus {
    param ($procId)
    $wshell = New-Object -ComObject WScript.Shell
    if ($wshell) { $wshell.AppActivate($procId) }
}

# Wait for Riot Client login window
Write-Host "Waiting for Riot Client window..."
$proc = $null
for ($i = 0; $i -lt 120; $i++) {
    $proc = Get-Process | Where-Object {
        $_.MainWindowTitle -match "Riot Client" -and $_.MainWindowHandle -ne 0
    } | Select-Object -First 1
    if ($proc) { break }
    Start-Sleep -Milliseconds 500
}

if (-not $proc) {
    Write-Host "Timeout: Riot Client window not found"
    Stop-Transcript
    exit 1
}

Write-Host "Found window: '$($proc.MainWindowTitle)' - waiting for UI to load..."
Ensure-Focus -procId $proc.Id
Start-Sleep -Seconds 5

# Enter credentials
$canBlock = ("Win32.InputBlocker" -as [type])
try {
    if ($canBlock) {
        try { [Win32.InputBlocker]::BlockInput($true) }
        catch { Write-Host "BlockInput failed (admin required)" }
    }

    Ensure-Focus -procId $proc.Id
    $escapedUser = Escape-SendKeys -text $Username
    [System.Windows.Forms.SendKeys]::SendWait($escapedUser)
    Start-Sleep -Milliseconds 300

    Ensure-Focus -procId $proc.Id
    [System.Windows.Forms.SendKeys]::SendWait("{TAB}")
    Start-Sleep -Milliseconds 300

    Ensure-Focus -procId $proc.Id
    $escapedPwd = Escape-SendKeys -text $Password
    [System.Windows.Forms.SendKeys]::SendWait($escapedPwd)
    Start-Sleep -Milliseconds 300

    Ensure-Focus -procId $proc.Id
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
    Write-Host "Credentials submitted"
}
finally {
    # Unlock input immediately; never leave user locked out.
    if ($canBlock) {
        try { [Win32.InputBlocker]::BlockInput($false) }
        catch { }
    }
}

# Wait for League to start
# After pressing Enter, Riot Client authenticates and should start League
# automatically when launched with --launch-product=league_of_legends.
Write-Host "Polling for League client launch..."
$leagueStarted = $false
for ($k = 0; $k -lt 180; $k++) {
    Start-Sleep -Milliseconds 500

    $lc = Get-Process -Name "LeagueClient" -ErrorAction SilentlyContinue
    if ($lc) {
        Write-Host "League client detected - done!"
        $leagueStarted = $true
        break
    }
}

# Fallback: trigger League via RiotClientServices if it did not auto-start.
if (-not $leagueStarted) {
    Write-Host "League did not auto-start; triggering via RiotClientServices..."

    # Try the path passed in as a parameter first.
    $rcExe = $RiotClientPath
    if (-not ($rcExe -and (Test-Path $rcExe))) {
        # Discover from running process.
        $rcProc = Get-Process -Name "RiotClientServices" -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($rcProc) {
            try { $rcExe = $rcProc.MainModule.FileName }
            catch { }
        }
    }

    if ($rcExe -and (Test-Path $rcExe)) {
        Write-Host "Launching: $rcExe"
        Start-Process -FilePath $rcExe -ArgumentList "--launch-product=league_of_legends", "--launch-patchline=live"
        Write-Host "Launch triggered - waiting for League..."

        # Give it another 30 seconds.
        for ($m = 0; $m -lt 60; $m++) {
            Start-Sleep -Milliseconds 500
            if (Get-Process -Name "LeagueClient" -ErrorAction SilentlyContinue) {
                Write-Host "League client is now running"
                break
            }
        }
    }
    else {
        Write-Host "Could not find RiotClientServices.exe path - manual click may be required"
    }
}

Write-Host "Login script complete"
Stop-Transcript
