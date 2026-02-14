param (
    [string]$Username,
    [string]$Password
)

$ErrorActionPreference = "Stop"

# Logging for debugging
$logPath = Join-Path $env:TEMP "leaguelogin_debug.txt"
Start-Transcript -Path $logPath -Append

Write-Host "Script Started at $(Get-Date)"
Write-Host "Username: $Username"


Add-Type -AssemblyName System.Windows.Forms

# Add BlockInput to prevent user interference
try {
    $code = @"
        [DllImport("user32.dll")]
        public static extern bool BlockInput(bool fBlockIt);
"@
    $inputBlocker = Add-Type -MemberDefinition $code -Name "InputBlocker" -Namespace Win32 -PassThru
}
catch {
    # Ignore if already added
}

# Helper to escape special characters for SendKeys
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


# Helper to focus window
function Ensure-Focus {
    param ($procId)
    $wshell = New-Object -ComObject WScript.Shell
    if ($wshell) {
        $wshell.AppActivate($procId)
    }
}

# Wait for Riot Client Window
$proc = $null
for ($i = 0; $i -lt 120; $i++) { 
    $proc = Get-Process | Where-Object { $_.MainWindowTitle -match "Riot Client" -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($proc) {
        break
    }
    Start-Sleep -Milliseconds 300
}


if (-not $proc) {
    Write-Host "Timeout waiting for client"
    exit
}

# Focus Window
Ensure-Focus -procId $proc.Id
Start-Sleep -Milliseconds 500


try {
    # Lock Input - Only if type is available
    $canBlock = ("Win32.InputBlocker" -as [type])
    if ($canBlock) {
        try {
            [Win32.InputBlocker]::BlockInput($true)
        }
        catch {
            Write-Host "Warning: Could not block input (Admin required?)"
        }
    }

    Write-Host "Found window, waiting 5s for UI load..."
    Start-Sleep -Seconds 5
    
    # Type Username

    Ensure-Focus -procId $proc.Id
    $escapedUsername = Escape-SendKeys -text $Username
    [System.Windows.Forms.SendKeys]::SendWait($escapedUsername)
    Start-Sleep -Milliseconds 300


    # Tab to password field
    Ensure-Focus -procId $proc.Id
    [System.Windows.Forms.SendKeys]::SendWait("{TAB}")
    Start-Sleep -Milliseconds 300


    # Escape-SendKeys is now globally defined at the top

    $escapedPwd = Escape-SendKeys -text $Password

    # Type Password
    Ensure-Focus -procId $proc.Id
    [System.Windows.Forms.SendKeys]::SendWait($escapedPwd)
    Start-Sleep -Milliseconds 300


    # Press Enter
    Ensure-Focus -procId $proc.Id
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")

    Write-Host "Login commands sent"

}
finally {
    # ALWAYS Unlock Input if we blocked it
    if ($canBlock) {
        try {
            [Win32.InputBlocker]::BlockInput($false)
        }
        catch { 
            # Ignore unlock errors
        }
    }
}
Stop-Transcript

