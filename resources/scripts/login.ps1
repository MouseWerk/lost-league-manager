param (
    [string]$Username,
    [string]$Password
)

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
    $proc = Get-Process | Where-Object { $_.MainWindowTitle -match "Riot Client" } | Select-Object -First 1
    if ($proc) {
        break
    }
    Start-Sleep -Milliseconds 500
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
        [Win32.InputBlocker]::BlockInput($true)
    }

    # Type Username
    Ensure-Focus -procId $proc.Id
    [System.Windows.Forms.SendKeys]::SendWait($Username)
    Start-Sleep -Milliseconds 100

    # Tab to password field
    Ensure-Focus -procId $proc.Id
    [System.Windows.Forms.SendKeys]::SendWait("{TAB}")
    Start-Sleep -Milliseconds 100

    # Escape special characters
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

    $escapedPwd = Escape-SendKeys -text $Password

    # Type Password
    Ensure-Focus -procId $proc.Id
    [System.Windows.Forms.SendKeys]::SendWait($escapedPwd)
    Start-Sleep -Milliseconds 100

    # Press Enter
    Ensure-Focus -procId $proc.Id
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")

    Write-Host "Login commands sent"

}
finally {
    # ALWAYS Unlock Input if we blocked it
    if ($canBlock) {
        [Win32.InputBlocker]::BlockInput($false)
    }
}
