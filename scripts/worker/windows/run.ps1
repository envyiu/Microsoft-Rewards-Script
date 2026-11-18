$ErrorActionPreference = 'Stop'
$base = $PSScriptRoot
$env:MSRW_WORKER_HOME = $base
. "$base\job-process.ps1"
$sha = [Security.Cryptography.SHA256]::Create()
try { $identity = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($base.ToLowerInvariant()))).Replace('-', '').Substring(0, 16) }
finally { $sha.Dispose() }
$mutex = New-Object System.Threading.Mutex($false, ('Global\MSRWWorker-' + $identity))
$owned = $false
try {
    try { $owned = $mutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $owned = $true }
    if (-not $owned) { exit 0 }
    while ($true) {
        if (Test-Path (Join-Path $base 'maintenance.flag')) {
            Start-Sleep -Seconds 5
            continue
        }
        try {
            [MSRW.JobProcess]::Run("$base\runtime\node-v24.22.2-win-x64\node.exe", ('"'+"$base\supervisor.mjs"+'"'), $base) | Out-Null
        } catch {
            ((Get-Date -Format o) + ' supervisor failed: ' + $_.Exception.Message) | Add-Content "$base\logs\watchdog.log"
        }
        Start-Sleep -Seconds 5
    }
} finally {
    if ($owned) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
