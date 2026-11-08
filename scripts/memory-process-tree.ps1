function Get-MemoryProcessIds {
  param([int]$RootProcessId, [object[]]$Processes)
  $byId = @{}
  foreach ($process in $Processes) {
    if ($null -ne $process.CreationDate) { $byId[[int]$process.ProcessId] = $process }
  }
  $ids = [System.Collections.Generic.HashSet[int]]::new()
  if (-not $byId.ContainsKey($RootProcessId)) { return ,$ids }
  [void]$ids.Add($RootProcessId)
  do {
    $changed = $false
    foreach ($process in $byId.Values) {
      $parentId = [int]$process.ParentProcessId
      if ($process.ProcessId -gt 0 -and $ids.Contains($parentId) -and
          $process.CreationDate -ge $byId[$parentId].CreationDate) {
        if ($ids.Add([int]$process.ProcessId)) { $changed = $true }
      }
    }
  } while ($changed)
  return ,$ids
}
