param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [int]$DurationSec = 30,
    [int]$IntervalSec = 1,
    [string]$Out = "gpu_mem.csv"
)

# Samples per-process GPU memory from the Windows GPU Performance Counters
# provider. Names are "pid_<pid>_luid_<high>_<low>_phys_<n>", one row per
# adapter/engine, so rows are summed per sample.
#
# On WDDM 2.x the meaningful fields are LocalUsage (GPU-local memory = VRAM)
# and NonLocalUsage (shared system memory). DedicatedUsage is always 0 on this
# machine, so it is not used.
$end = (Get-Date).AddSeconds($DurationSec)
"timestamp,local_mb,nonlocal_mb" | Out-File -Encoding ascii $Out
while ((Get-Date) -lt $end) {
    If (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) { break }
    $rows = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory `
        -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like "pid_$($ProcessId)_*" }
    $local = 0.0
    $nonLocal = 0.0
    foreach ($row in $rows) {
        $local += [double]$row.LocalUsage
        $nonLocal += [double]$row.NonLocalUsage
    }
    $timestamp = (Get-Date).ToString("HH:mm:ss")
    "$timestamp,$([math]::Round($local / 1MB, 1)),$([math]::Round($nonLocal / 1MB, 1))" |
        Out-File -Append -Encoding ascii $Out
    Start-Sleep -Seconds $IntervalSec
}
