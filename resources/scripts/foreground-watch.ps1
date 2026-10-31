# Prints "<pid>|<process name>" of the foreground window each time it changes,
# so the overlay (plain window mode) shows only while League is in front.
# Ends with the app: it checks that the parent process is still running.
param(
    [int]$ParentPid = 0
)

$ErrorActionPreference = 'SilentlyContinue'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class ForegroundWindow {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@

$last = -1
$ticks = 0
while ($true) {
    $fgPid = [uint32]0
    [void][ForegroundWindow]::GetWindowThreadProcessId([ForegroundWindow]::GetForegroundWindow(), [ref]$fgPid)
    if ($fgPid -ne $last) {
        $last = $fgPid
        $name = ''
        try { $name = (Get-Process -Id $fgPid).ProcessName } catch { }
        [Console]::Out.WriteLine("$fgPid|$name")
        [Console]::Out.Flush()
    }
    $ticks++
    if ($ParentPid -gt 0 -and ($ticks % 20) -eq 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
        exit 0
    }
    Start-Sleep -Milliseconds 150
}
