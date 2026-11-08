param([Parameter(Mandatory=$true)][int]$RootProcessId, [Parameter(Mandatory=$true)][string]$OutputPath, [Parameter(Mandatory=$true)][string]$StopPath)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'memory-process-tree.ps1')
# CIM numeric properties avoid localized Performance Monitor counter names.
$gpuClass = 'Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory'
$gpuAvailable = $null -ne (Get-CimClass -Namespace root/cimv2 -ClassName $gpuClass -ErrorAction SilentlyContinue)
$rootCreationDate = $null
while (-not (Test-Path -LiteralPath $StopPath)) {
  if (-not (Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue)) { break }
  $identities = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate)
  $rootIdentity = $identities | Where-Object { $_.ProcessId -eq $RootProcessId }
  if ($null -eq $rootIdentity) { break }
  if ($null -eq $rootCreationDate) { $rootCreationDate = $rootIdentity.CreationDate }
  elseif ($rootCreationDate -ne $rootIdentity.CreationDate) { break }
  $byId = @{}
  foreach ($identity in $identities) { $byId[[int]$identity.ProcessId] = $identity }
  $all = @(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process)
  $ids = Get-MemoryProcessIds -RootProcessId $RootProcessId -Processes $identities
  $processes = @($all | Where-Object {
    $ids.Contains([int]$_.IDProcess) -and
      $byId[[int]$_.IDProcess].ParentProcessId -eq $_.CreatingProcessID
  } | ForEach-Object {
    @{ pid=[int]$_.IDProcess; parentPid=[int]$_.CreatingProcessID; createdAt=$byId[[int]$_.IDProcess].CreationDate.ToUniversalTime().ToString('o'); privateWorkingSetBytes=[long]$_.WorkingSetPrivate; privateCommitBytes=[long]$_.PrivateBytes; workingSetBytes=[long]$_.WorkingSet }
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
