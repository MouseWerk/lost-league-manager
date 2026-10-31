# Watches the game for the overlay without taking anything from it. Prints:
#   fg|<pid>|<process name>   the foreground window changed
#   tab|1 / tab|0             Tab was pressed / released
#   hotkey                    the show-or-hide key combination was pressed
# Keys are only read (GetAsyncKeyState), never captured, so League gets every
# key as usual. Ends with the app: it checks that the parent process runs.
param(
    [int]$ParentPid = 0,
    # Virtual-key codes of the show-or-hide combination, e.g. "17,16,72" (Ctrl+Shift+H).
    [string]$HotkeyKeys = ''
)

$ErrorActionPreference = 'SilentlyContinue'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class GameInput {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
    public static bool IsDown(int vKey) { return (GetAsyncKeyState(vKey) & 0x8000) != 0; }
}
"@

$hotkey = @($HotkeyKeys -split ',' | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ })
$VK_TAB = 0x09

function Out-Line([string]$text) {
    [Console]::Out.WriteLine($text)
    [Console]::Out.Flush()
}

$lastPid = -1
$tabDown = $false
$hotkeyDown = $false
$ticks = 0
while ($true) {
    $fgPid = [uint32]0
    [void][GameInput]::GetWindowThreadProcessId([GameInput]::GetForegroundWindow(), [ref]$fgPid)
    if ($fgPid -ne $lastPid) {
        $lastPid = $fgPid
        $name = ''
        try { $name = (Get-Process -Id $fgPid).ProcessName } catch { }
        Out-Line "fg|$fgPid|$name"
    }

    $tab = [GameInput]::IsDown($VK_TAB)
    if ($tab -ne $tabDown) {
        $tabDown = $tab
        Out-Line ("tab|" + [int]$tab)
    }

    if ($hotkey.Count -gt 0) {
        $all = $true
        foreach ($k in $hotkey) { if (-not [GameInput]::IsDown($k)) { $all = $false; break } }
        if ($all -and -not $hotkeyDown) { Out-Line 'hotkey' }
        $hotkeyDown = $all
    }

    $ticks++
    if ($ParentPid -gt 0 -and ($ticks % 60) -eq 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
        exit 0
    }
    Start-Sleep -Milliseconds 40
}
