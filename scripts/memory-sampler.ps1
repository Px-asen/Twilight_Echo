param([Parameter(Mandatory=$true)][int]$RootProcessId, [Parameter(Mandatory=$true)][string]$OutputPath, [Parameter(Mandatory=$true)][string]$StopPath)
$ErrorActionPreference = 'Stop'
# CIM numeric properties avoid localized Performance Monitor counter names.
$gpuClass = 'Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory'
$gpuAvailable = $null -ne (Get-CimClass -Namespace root/cimv2 -ClassName $gpuClass -ErrorAction SilentlyContinue)
while (-not (Test-Path -LiteralPath $StopPath)) {
  if (-not (Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue)) { break }
  $all = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process)
  $ids = [System.Collections.Generic.HashSet[int]]::new()
  [void]$ids.Add($RootProcessId)
  do {
    $changed = $false
    foreach ($p in $all) {
      if ($ids.Contains([int]$p.CreatingProcessID) -and $p.IDProcess -gt 0) {
        if ($ids.Add([int]$p.IDProcess)) { $changed = $true }
      }
    }
  } while ($changed)
  $processes = @($all | Where-Object { $ids.Contains([int]$_.IDProcess) } | ForEach-Object {
    @{ pid=[int]$_.IDProcess; parentPid=[int]$_.CreatingProcessID; privateWorkingSetBytes=[long]$_.WorkingSetPrivate; privateCommitBytes=[long]$_.PrivateBytes; workingSetBytes=[long]$_.WorkingSet }
  })
  $gpu = @()
  if ($gpuAvailable) {
    $gpu = @(Get-CimInstance $gpuClass -ErrorAction SilentlyContinue | ForEach-Object {
      if ($_.Name -match 'pid_(\d+)_' -and $ids.Contains([int]$Matches[1])) {
        @{ pid=[int]$Matches[1]; instance=$_.Name; dedicatedBytes=[long]$_.DedicatedUsage; sharedBytes=[long]$_.SharedUsage }
      }
    })
  }
  $sample = @{ timestamp=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); processes=$processes; gpu=$gpu; gpuAvailable=$gpuAvailable }
  [IO.File]::AppendAllText($OutputPath, (($sample | ConvertTo-Json -Depth 5 -Compress) + "`n"))
  Start-Sleep -Seconds 2
}
