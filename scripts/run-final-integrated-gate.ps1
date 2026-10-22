[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$OutputRoot,

  [string]$CandidateName,
  [string]$ArchiveInvalidCandidateName,
  [string]$ElectronDistOverride,
  [string]$NativeBuildDir,
  [switch]$Resume,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$script:SourceRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$script:OutputRoot = [System.IO.Path]::GetFullPath($OutputRoot)
$script:CandidatePath = $null
$script:EvidenceRoot = $null
$script:LogsRoot = $null
$script:ResultsPath = $null
$script:SourceManifestPath = $null
$script:SourceManifestSha256 = $null
$script:GateStartedAtUtc = [DateTime]::UtcNow
$script:FinalStatus = 'running'
$script:FinalError = $null
$script:ExternalToolRoot = [System.IO.Path]::GetFullPath('C:\twilight-build')
$script:ElectronLeafName = 'electron-final-integrated-v2'
$script:NativeLeafName = 'mingw-final-integrated-v2'
$script:RunId = [Guid]::NewGuid().ToString('D')
$script:PlanDigest = $null
$script:StagePlan = @()
$script:StagePlanById = @{}
$script:ForceRerunAll = $false
$script:InvocationPath = $null

if (-not ('TwilightFinalGate.PhysicalPath' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace TwilightFinalGate {
  public static class PhysicalPath {
    const uint FILE_SHARE_READ = 0x00000001;
    const uint FILE_SHARE_WRITE = 0x00000002;
    const uint FILE_SHARE_DELETE = 0x00000004;
    const uint OPEN_EXISTING = 3;
    const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFile(
      string name,
      uint access,
      uint share,
      IntPtr security,
      uint creation,
      uint flags,
      IntPtr template);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetFinalPathNameByHandle(
      SafeFileHandle handle,
      StringBuilder path,
      uint pathLength,
      uint flags);

    public static string ResolveExisting(string path) {
      using (SafeFileHandle handle = CreateFile(
        path,
        0,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        IntPtr.Zero,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS,
        IntPtr.Zero)) {
        if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), path);
        var buffer = new StringBuilder(32768);
        uint length = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, 0);
        if (length == 0 || length >= buffer.Capacity)
          throw new Win32Exception(Marshal.GetLastWin32Error(), path);
        return buffer.ToString();
      }
    }
  }

  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public IntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct IO_COUNTERS {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  public sealed class OwnedJob : IDisposable {
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    IntPtr handle;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    public OwnedJob() {
      handle = CreateJobObject(IntPtr.Zero, null);
      if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      int length = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
      IntPtr pointer = Marshal.AllocHGlobal(length);
      try {
        Marshal.StructureToPtr(info, pointer, false);
        if (!SetInformationJobObject(handle, 9, pointer, (uint)length))
          throw new Win32Exception(Marshal.GetLastWin32Error());
      } finally {
        Marshal.FreeHGlobal(pointer);
      }
    }

    public void Assign(IntPtr processHandle) {
      if (!AssignProcessToJobObject(handle, processHandle))
        throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    public void Terminate(uint exitCode) {
      if (handle != IntPtr.Zero && !TerminateJobObject(handle, exitCode))
        throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    public void Dispose() {
      if (handle != IntPtr.Zero) {
        CloseHandle(handle);
        handle = IntPtr.Zero;
      }
      GC.SuppressFinalize(this);
    }

    ~OwnedJob() { Dispose(); }
  }
}
'@
}

function ConvertTo-NormalizedPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  return $Path.Replace('\', '/')
}

function Get-PathWithSeparator {
  param([Parameter(Mandatory = $true)][string]$Path)
  $full = [System.IO.Path]::GetFullPath($Path)
  if (-not $full.EndsWith([System.IO.Path]::DirectorySeparatorChar)) {
    $full += [System.IO.Path]::DirectorySeparatorChar
  }
  return $full
}

function Assert-PathIsChild {
  param(
    [Parameter(Mandatory = $true)][string]$Parent,
    [Parameter(Mandatory = $true)][string]$Child,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $parentFull = Get-PathWithSeparator $Parent
  $childFull = [System.IO.Path]::GetFullPath($Child)
  if (-not $childFull.StartsWith($parentFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label escaped its intended root: $childFull"
  }
}

function Assert-SafeLeafName {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if ($Name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
    throw "$Label must be a single safe path segment: $Name"
  }
}

function Get-PhysicalCanonicalPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  $full = [System.IO.Path]::GetFullPath($Path)
  $tail = New-Object System.Collections.Generic.Stack[string]
  $existing = $full
  while (-not (Test-Path -LiteralPath $existing)) {
    $trimmed = $existing.TrimEnd('\', '/')
    $leaf = [System.IO.Path]::GetFileName($trimmed)
    if (-not $leaf) { throw "Cannot resolve a physical ancestor for path: $full" }
    $tail.Push($leaf)
    $parent = [System.IO.Directory]::GetParent($trimmed)
    if (-not $parent) { throw "Cannot resolve a physical ancestor for path: $full" }
    $existing = $parent.FullName
  }
  $physical = [TwilightFinalGate.PhysicalPath]::ResolveExisting($existing)
  if ($physical.StartsWith('\\?\UNC\', [System.StringComparison]::OrdinalIgnoreCase)) {
    $physical = '\\' + $physical.Substring(8)
  } elseif ($physical.StartsWith('\\?\', [System.StringComparison]::OrdinalIgnoreCase)) {
    $physical = $physical.Substring(4)
  }
  while ($tail.Count -gt 0) { $physical = Join-Path $physical $tail.Pop() }
  $result = [System.IO.Path]::GetFullPath($physical)
  if (-not $result.Equals([System.IO.Path]::GetPathRoot($result), [System.StringComparison]::OrdinalIgnoreCase)) {
    $result = $result.TrimEnd('\', '/')
  }
  return $result
}

function Test-PathContains {
  param(
    [Parameter(Mandatory = $true)][string]$Parent,
    [Parameter(Mandatory = $true)][string]$Child
  )
  $parentFull = $Parent.TrimEnd('\', '/')
  $childFull = $Child.TrimEnd('\', '/')
  if ($parentFull.Equals($childFull, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
  return $childFull.StartsWith($parentFull + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-PathsDoNotOverlap {
  param(
    [Parameter(Mandatory = $true)][string]$Left,
    [Parameter(Mandatory = $true)][string]$Right,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $leftPhysical = Get-PhysicalCanonicalPath $Left
  $rightPhysical = Get-PhysicalCanonicalPath $Right
  if ((Test-PathContains $leftPhysical $rightPhysical) -or (Test-PathContains $rightPhysical $leftPhysical)) {
    throw "$Label paths overlap physically: $leftPhysical <-> $rightPhysical"
  }
}

function Assert-DirectPhysicalChild {
  param(
    [Parameter(Mandatory = $true)][string]$Parent,
    [Parameter(Mandatory = $true)][string]$Child,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $parentPhysical = Get-PhysicalCanonicalPath $Parent
  $childPhysical = Get-PhysicalCanonicalPath $Child
  $childParent = [System.IO.Directory]::GetParent($childPhysical)
  if (-not $childParent -or
      -not $childParent.FullName.TrimEnd('\', '/').Equals($parentPhysical, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must be a direct physical child of $parentPhysical; got $childPhysical"
  }
}

function Assert-NoReparsePointsUnderRoot {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if (-not (Test-Path -LiteralPath $Root -PathType Container)) { throw "$Label root is missing: $Root" }
  $pending = New-Object System.Collections.Generic.Stack[string]
  $pending.Push([System.IO.Path]::GetFullPath($Root))
  while ($pending.Count -gt 0) {
    $directory = $pending.Pop()
    $directoryItem = Get-Item -LiteralPath $directory -Force
    if (($directoryItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label contains a reparse point: $directory"
    }
    foreach ($item in Get-ChildItem -LiteralPath $directory -Force) {
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label contains a reparse point: $($item.FullName)"
      }
      if ($item.PSIsContainer) { $pending.Push($item.FullName) }
    }
  }
}

function Assert-GateOperationalRoots {
  Assert-DirectPhysicalChild -Parent $script:CandidatePath -Child $script:EvidenceRoot -Label 'Evidence root'
  Assert-DirectPhysicalChild -Parent $script:CandidatePath -Child $script:LogsRoot -Label 'Logs root'
  Assert-NoReparsePointsUnderRoot -Root $script:EvidenceRoot -Label 'Evidence root'
  Assert-NoReparsePointsUnderRoot -Root $script:LogsRoot -Label 'Logs root'
}

function Get-OwnerMarkerPath {
  param([Parameter(Mandatory = $true)][string]$Root)
  return Join-Path $Root '.twilight-final-gate-owner.json'
}

function Write-OwnerMarker {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][ValidateSet('candidate', 'electron', 'native')][string]$Kind,
    [string]$SourceManifestSha256,
    [string]$PlanDigest,
    [string]$OwnerCandidateName = $CandidateName
  )
  $marker = [ordered]@{
    schemaVersion = 1
    managedBy = 'TwilightEcho.run-final-integrated-gate.ps1'
    kind = $Kind
    leafName = Split-Path -Leaf $Root
    physicalPath = Get-PhysicalCanonicalPath $Root
    outputRootPhysical = Get-PhysicalCanonicalPath $script:OutputRoot
    candidateName = $OwnerCandidateName
    runId = $script:RunId
    sourceManifestSha256 = $SourceManifestSha256
    planDigest = $PlanDigest
    updatedAtUtc = [DateTime]::UtcNow.ToString('o')
  }
  Write-JsonFile -Path (Get-OwnerMarkerPath $Root) -Value $marker -Depth 8
}

function Read-ValidatedOwnerMarker {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][ValidateSet('candidate', 'electron', 'native')][string]$Kind,
    [switch]$RequireCurrentPlan
  )
  $markerPath = Get-OwnerMarkerPath $Root
  if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
    throw "$Kind directory is not owned by this gate: $Root"
  }
  $markerPath = Resolve-SafeRelativePath -Root $Root -RelativePath '.twilight-final-gate-owner.json' -Label "$Kind ownership marker"
  $markerItem = Get-Item -LiteralPath $markerPath -Force
  if (($markerItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$Kind ownership marker must not be a reparse point: $Root"
  }
  $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
  if ([int]$marker.schemaVersion -ne 1 -or
      [string]$marker.managedBy -ne 'TwilightEcho.run-final-integrated-gate.ps1' -or
      [string]$marker.kind -ne $Kind -or
      [string]$marker.leafName -ne (Split-Path -Leaf $Root) -or
      ($Kind -eq 'candidate' -and [string]$marker.candidateName -ne (Split-Path -Leaf $Root)) -or
      -not ([string]$marker.physicalPath).Equals((Get-PhysicalCanonicalPath $Root), [System.StringComparison]::OrdinalIgnoreCase) -or
      -not ([string]$marker.outputRootPhysical).Equals((Get-PhysicalCanonicalPath $script:OutputRoot), [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Kind ownership marker does not match its physical directory: $Root"
  }
  if ($RequireCurrentPlan -and [string]$marker.planDigest -ne $script:PlanDigest) {
    throw "$Kind ownership marker is bound to a different gate plan"
  }
  return $marker
}

function Rebind-ArchivedOwnerMarker {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][ValidateSet('candidate', 'electron', 'native')][string]$Kind,
    [Parameter(Mandatory = $true)]$PreviousOwner
  )
  $rebound = [ordered]@{
    schemaVersion = [int]$PreviousOwner.schemaVersion
    managedBy = [string]$PreviousOwner.managedBy
    kind = $Kind
    leafName = Split-Path -Leaf $Root
    physicalPath = Get-PhysicalCanonicalPath $Root
    outputRootPhysical = Get-PhysicalCanonicalPath $script:OutputRoot
    candidateName = [string]$PreviousOwner.candidateName
    runId = [string]$PreviousOwner.runId
    sourceManifestSha256 = [string]$PreviousOwner.sourceManifestSha256
    planDigest = [string]$PreviousOwner.planDigest
    updatedAtUtc = [DateTime]::UtcNow.ToString('o')
  }
  Write-JsonFile -Path (Get-OwnerMarkerPath $Root) -Value $rebound -Depth 8
  return Read-ValidatedOwnerMarker -Root $Root -Kind $Kind
}

function Assert-CriticalPathPolicy {
  $sourcePhysical = Get-PhysicalCanonicalPath $script:SourceRoot
  $outputPhysical = Get-PhysicalCanonicalPath $script:OutputRoot
  $candidatePhysical = Get-PhysicalCanonicalPath $script:CandidatePath
  Assert-DirectPhysicalChild -Parent $script:OutputRoot -Child $script:CandidatePath -Label 'Candidate'
  Assert-PathsDoNotOverlap -Left $sourcePhysical -Right $outputPhysical -Label 'Source/OutputRoot'
  Assert-PathsDoNotOverlap -Left $sourcePhysical -Right $candidatePhysical -Label 'Source/Candidate'
}

function Assert-FixedExternalLeaf {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$ExpectedLeaf,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $expected = Join-Path $script:ExternalToolRoot $ExpectedLeaf
  $pathPhysical = Get-PhysicalCanonicalPath $Path
  $expectedPhysical = Get-PhysicalCanonicalPath $expected
  if (-not $pathPhysical.Equals($expectedPhysical, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label is restricted to the owned leaf $expectedPhysical"
  }
  Assert-DirectPhysicalChild -Parent $script:ExternalToolRoot -Child $Path -Label $Label
  Assert-PathsDoNotOverlap -Left $Path -Right $script:SourceRoot -Label "$Label/Source"
  Assert-PathsDoNotOverlap -Left $Path -Right $script:OutputRoot -Label "$Label/OutputRoot"
  Assert-PathsDoNotOverlap -Left $Path -Right $script:CandidatePath -Label "$Label/Candidate"
}

function Write-Utf8File {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text
  )
  $parent = Split-Path -Parent $Path
  if ($parent) {
    [System.IO.Directory]::CreateDirectory($parent) | Out-Null
  }
  [System.IO.File]::WriteAllText($Path, $Text, $script:Utf8NoBom)
}

function Write-JsonFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Value,
    [int]$Depth = 12
  )
  $json = $Value | ConvertTo-Json -Depth $Depth
  Write-Utf8File -Path $Path -Text ($json + "`n")
}

function Read-TextFileShared {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
  $stream = New-Object System.IO.FileStream(
    $Path,
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read,
    ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete)
  )
  $reader = New-Object System.IO.StreamReader($stream, $true)
  try { return $reader.ReadToEnd() } finally { $reader.Dispose(); $stream.Dispose() }
}

function Get-Sha256Bytes {
  param([Parameter(Mandatory = $true)][byte[]]$Bytes)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $digest = $sha.ComputeHash($Bytes)
    return -join ($digest | ForEach-Object { $_.ToString('x2') })
  } finally {
    $sha.Dispose()
  }
}

function Get-Sha256Text {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text)
  return Get-Sha256Bytes -Bytes $script:Utf8NoBom.GetBytes($Text)
}

function Get-Sha256File {
  param([Parameter(Mandatory = $true)][string]$Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-RelativePath {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$Path
  )
  $rootFull = Get-PathWithSeparator $Root
  $pathFull = [System.IO.Path]::GetFullPath($Path)
  if (-not $pathFull.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Path is outside root: $pathFull"
  }
  return ConvertTo-NormalizedPath $pathFull.Substring($rootFull.Length)
}

function Resolve-SafeRelativePath {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$RelativePath,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $normalized = ConvertTo-NormalizedPath $RelativePath
  $segments = @($normalized.Split('/'))
  if (-not $normalized -or
      [System.IO.Path]::IsPathRooted($RelativePath) -or
      $segments.Count -eq 0 -or
      @($segments | Where-Object { -not $_ -or $_ -eq '.' -or $_ -eq '..' }).Count -ne 0) {
    throw "$Label must be a non-rooted relative path without traversal: $RelativePath"
  }
  $resolved = [System.IO.Path]::GetFullPath((Join-Path $Root $normalized.Replace('/', '\')))
  $rootPhysical = Get-PhysicalCanonicalPath $Root
  $resolvedPhysical = Get-PhysicalCanonicalPath $resolved
  if (-not (Test-PathContains -Parent $rootPhysical -Child $resolvedPhysical) -or
      $rootPhysical.Equals($resolvedPhysical, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label escaped its physical root: $RelativePath"
  }
  return $resolved
}

function Invoke-GitLines {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  $lines = @(& git -C $script:SourceRoot -c core.quotepath=false @Arguments)
  if ($LASTEXITCODE -ne 0) {
    throw "git $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
  }
  return @($lines | ForEach-Object { [string]$_ })
}

function Get-GitState {
  $headLines = @(Invoke-GitLines @('rev-parse', 'HEAD'))
  if ($headLines.Count -ne 1) { throw 'git rev-parse HEAD returned an unexpected result' }
  $head = $headLines[0]
  $branchLines = @(Invoke-GitLines @('branch', '--show-current'))
  $branch = if ($branchLines.Count -gt 0) { $branchLines[0] } else { '' }
  $statusLines = @(Invoke-GitLines @('status', '--porcelain=v1', '--untracked-files=all'))
  $statusText = if ($statusLines.Count -gt 0) { ($statusLines -join "`n") + "`n" } else { '' }
  return [pscustomobject]@{
    head = $head
    branch = $branch
    statusLines = $statusLines
    statusText = $statusText
    statusSha256 = Get-Sha256Text $statusText
    statusEntries = $statusLines.Count
  }
}

function Test-ExcludedSourcePath {
  param([Parameter(Mandatory = $true)][string]$RelativePath)
  $normalized = ConvertTo-NormalizedPath $RelativePath
  $segments = @($normalized.Split('/'))
  $excludedSegments = @('.git', 'node_modules', 'out', 'dist', 'build', 'temp', 'tmp', 'log', 'logs')
  foreach ($segment in $segments) {
    if ($excludedSegments -contains $segment.ToLowerInvariant()) { return $true }
  }
  if ($normalized -match '^(Testing/Temporary)(/|$)') { return $true }
  if ($normalized -match '^electron\.vite\.config\.[0-9]+\.mjs$') { return $true }
  if ($normalized -match '\.(log|tmp|temp)$') { return $true }
  return $false
}

function Get-RecordsDigest {
  param([Parameter(Mandatory = $true)][object[]]$Records)
  $builder = New-Object System.Text.StringBuilder
  foreach ($record in $Records) {
    [void]$builder.Append([string]$record.path)
    [void]$builder.Append([char]0)
    [void]$builder.Append([string]$record.size)
    [void]$builder.Append([char]0)
    [void]$builder.Append([string]$record.sha256)
    [void]$builder.Append("`n")
  }
  return Get-Sha256Text $builder.ToString()
}

function Get-SourceSnapshot {
  param([string]$DestinationRoot)

  $beforeGit = Get-GitState
  $allPaths = @(Invoke-GitLines @('ls-files', '-co', '--exclude-standard') | Sort-Object -Unique)
  $tracked = @(Invoke-GitLines @('ls-files') | Sort-Object -Unique)
  $trackedSet = @{}
  foreach ($path in $tracked) { $trackedSet[$path] = $true }

  $records = New-Object System.Collections.Generic.List[object]
  $missingTracked = New-Object System.Collections.Generic.List[string]
  $excluded = New-Object System.Collections.Generic.List[object]
  $totalBytes = [int64]0

  foreach ($relativePath in $allPaths) {
    $normalized = ConvertTo-NormalizedPath $relativePath
    if (Test-ExcludedSourcePath $normalized) {
      $excluded.Add([pscustomobject]@{ path = $normalized; reason = 'generated-or-temporary' })
      continue
    }

    $sourcePath = Resolve-SafeRelativePath -Root $script:SourceRoot -RelativePath $normalized -Label 'Source snapshot path'
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
      if ($trackedSet.ContainsKey($relativePath)) { $missingTracked.Add($normalized) }
      continue
    }

    $sourceItem = Get-Item -LiteralPath $sourcePath
    if (($sourceItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Source snapshot contains a reparse point: $normalized"
    }
    $sourceHash = Get-Sha256File $sourcePath
    $record = [pscustomobject]@{
      path = $normalized
      size = [int64]$sourceItem.Length
      sha256 = $sourceHash
    }
    $records.Add($record)
    $totalBytes += [int64]$sourceItem.Length

    if ($DestinationRoot) {
      $destinationPath = Resolve-SafeRelativePath -Root $DestinationRoot -RelativePath $normalized -Label 'Candidate copy path'
      $destinationParent = Split-Path -Parent $destinationPath
      [System.IO.Directory]::CreateDirectory($destinationParent) | Out-Null
      Copy-Item -LiteralPath $sourcePath -Destination $destinationPath
      $copiedItem = Get-Item -LiteralPath $destinationPath
      $copiedHash = Get-Sha256File $destinationPath
      if ($copiedItem.Length -ne $sourceItem.Length -or $copiedHash -ne $sourceHash) {
        throw "Frozen copy differs from source: $normalized"
      }
    }
  }

  $orderedRecords = @($records | Sort-Object path)
  $orderedMissing = @($missingTracked | Sort-Object)
  $orderedExcluded = @($excluded | Sort-Object path)

  foreach ($record in $orderedRecords) {
    $sourcePath = Resolve-SafeRelativePath -Root $script:SourceRoot -RelativePath ([string]$record.path) -Label 'Source revalidation path'
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
      throw "Source changed while freezing (missing): $($record.path)"
    }
    $item = Get-Item -LiteralPath $sourcePath
    if ($item.Length -ne $record.size -or (Get-Sha256File $sourcePath) -ne $record.sha256) {
      throw "Source changed while freezing: $($record.path)"
    }
  }

  $afterGit = Get-GitState
  $afterPaths = @(Invoke-GitLines @('ls-files', '-co', '--exclude-standard') | Sort-Object -Unique)
  if ($beforeGit.head -ne $afterGit.head -or
      $beforeGit.statusSha256 -ne $afterGit.statusSha256 -or
      ($allPaths -join "`n") -ne ($afterPaths -join "`n")) {
    throw 'Git HEAD, worktree status, or source path set changed while freezing'
  }

  return [pscustomobject]@{
    git = $beforeGit
    records = $orderedRecords
    missingTrackedFiles = $orderedMissing
    excluded = $orderedExcluded
    fileCount = $orderedRecords.Count
    totalBytes = $totalBytes
    recordsDigestSha256 = Get-RecordsDigest $orderedRecords
  }
}

function Get-PackageProvenance {
  param([Parameter(Mandatory = $true)][object[]]$Records)
  $wanted = @('package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml')
  return @($Records | Where-Object { $wanted -contains $_.path })
}

function Test-OperationalCandidatePath {
  param([Parameter(Mandatory = $true)][string]$RelativePath)
  $normalized = ConvertTo-NormalizedPath $RelativePath
  if ($normalized -eq '.twilight-final-gate-owner.json') { return $true }
  if ($normalized -eq '.eslintcache') { return $true }
  if ($normalized -match '^(evidence|logs)(/|$)') { return $true }
  if ($normalized -match '^resources/audio-engine/' -and $normalized -ne 'resources/audio-engine/.gitkeep') { return $true }
  return Test-ExcludedSourcePath $normalized
}

function Get-CandidateScopeRecords {
  $records = New-Object System.Collections.Generic.List[object]
  $pending = New-Object System.Collections.Generic.Stack[string]
  $pending.Push($script:CandidatePath)
  while ($pending.Count -gt 0) {
    $directory = $pending.Pop()
    foreach ($item in Get-ChildItem -LiteralPath $directory -Force) {
      $relative = Get-RelativePath -Root $script:CandidatePath -Path $item.FullName
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Candidate source scope contains a reparse point: $relative"
      }
      if (Test-OperationalCandidatePath $relative) { continue }
      if ($item.PSIsContainer) {
        $pending.Push($item.FullName)
      } else {
        $records.Add([pscustomobject]@{
            path = $relative
            size = [int64]$item.Length
            sha256 = Get-Sha256File $item.FullName
          })
      }
    }
  }
  return @($records | Sort-Object path)
}

function Assert-CandidateMatchesManifest {
  param([Parameter(Mandatory = $true)]$Manifest)
  $expected = @($Manifest.files | Sort-Object path)
  $actual = @(Get-CandidateScopeRecords)
  $expectedPaths = @($expected | ForEach-Object { [string]$_.path })
  $actualPaths = @($actual | ForEach-Object { [string]$_.path })
  if (($expectedPaths -join "`n") -ne ($actualPaths -join "`n")) {
    $missing = @($expectedPaths | Where-Object { $actualPaths -notcontains $_ })
    $added = @($actualPaths | Where-Object { $expectedPaths -notcontains $_ })
    throw "Candidate source path set changed; missing=[$($missing -join ', ')]; added=[$($added -join ', ')]"
  }
  for ($index = 0; $index -lt $expected.Count; $index += 1) {
    if ([int64]$actual[$index].size -ne [int64]$expected[$index].size -or
        [string]$actual[$index].sha256 -ne [string]$expected[$index].sha256) {
      throw "Candidate source file changed after freeze: $($expected[$index].path)"
    }
  }
  if ((Get-RecordsDigest $actual) -ne [string]$Manifest.recordsDigestSha256) {
    throw 'Candidate source digest no longer matches the manifest'
  }
}

function Assert-SourceMatchesManifest {
  param([Parameter(Mandatory = $true)]$Manifest)
  $current = Get-SourceSnapshot
  if ($current.git.head -ne [string]$Manifest.source.gitHead -or
      $current.git.statusSha256 -ne [string]$Manifest.source.gitStatusSha256 -or
      $current.fileCount -ne [int]$Manifest.fileCount -or
      $current.recordsDigestSha256 -ne [string]$Manifest.recordsDigestSha256 -or
      ($current.missingTrackedFiles -join "`n") -ne (@($Manifest.scope.missingTrackedFiles) -join "`n")) {
    throw 'The main worktree no longer matches the frozen candidate source manifest'
  }
}

function Add-ResultRecord {
  param([Parameter(Mandatory = $true)]$Record)
  $json = $Record | ConvertTo-Json -Compress -Depth 10
  [System.IO.File]::AppendAllText($script:ResultsPath, $json + "`n", $script:Utf8NoBom)
}

function Get-StageHistory {
  param([Parameter(Mandatory = $true)][string]$Id)
  if (-not (Test-Path -LiteralPath $script:ResultsPath -PathType Leaf)) { return @() }
  $records = New-Object System.Collections.Generic.List[object]
  foreach ($line in [System.IO.File]::ReadAllLines($script:ResultsPath, $script:Utf8NoBom)) {
    if (-not $line.Trim()) { continue }
    try {
      $record = $line | ConvertFrom-Json
      if ([string]$record.id -eq $Id) { $records.Add($record) }
    } catch {
      throw "Invalid NDJSON record in $($script:ResultsPath): $line"
    }
  }
  return @($records.GetEnumerator() | ForEach-Object { $_ })
}

function Get-LatestBoundStageResult {
  param([Parameter(Mandatory = $true)][string]$Id)
  if ($script:ForceRerunAll -or -not $script:StagePlanById.ContainsKey($Id)) { return $null }
  $expected = $script:StagePlanById[$Id]
  $history = @(Get-StageHistory $Id)
  for ($index = $history.Count - 1; $index -ge 0; $index -= 1) {
    $record = $history[$index]
    if ([string]$record.planDigest -ne $script:PlanDigest -or
        [string]$record.sourceManifestSha256 -ne $script:SourceManifestSha256 -or
        [string]$record.command -ne [string]$expected.command -or
        [int]$record.timeoutSeconds -ne [int]$expected.timeout -or
        -not $record.logSha256) { continue }
    try {
      $logPath = Resolve-SafeRelativePath -Root $script:CandidatePath -RelativePath ([string]$record.log) -Label "Stage $Id log"
    } catch {
      continue
    }
    if (-not (Test-Path -LiteralPath $logPath -PathType Leaf)) { continue }
    if ((Get-Sha256File $logPath) -ne [string]$record.logSha256) { continue }
    return $record
  }
  return $null
}

function Test-StageAlreadyPassed {
  param([Parameter(Mandatory = $true)][string]$Id)
  $record = Get-LatestBoundStageResult $Id
  return $null -ne $record -and [int]$record.exitCode -eq 0
}

function Invoke-TaskkillWithDeadline {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [int]$DeadlineMilliseconds = 5000
  )
  $killPsi = New-Object System.Diagnostics.ProcessStartInfo
  $killPsi.FileName = 'taskkill.exe'
  $killPsi.Arguments = "/PID $ProcessId /T /F"
  $killPsi.UseShellExecute = $false
  $killPsi.CreateNoWindow = $true
  $killProcess = New-Object System.Diagnostics.Process
  try {
    $killProcess.StartInfo = $killPsi
    if (-not $killProcess.Start()) { return $false }
    if (-not $killProcess.WaitForExit($DeadlineMilliseconds)) {
      try { $killProcess.Kill() } catch {}
      [void]$killProcess.WaitForExit(1000)
      return $false
    }
    return $killProcess.ExitCode -eq 0
  } finally {
    $killProcess.Dispose()
  }
}

function Invoke-CommandProcess {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds
  )
  $captureId = [Guid]::NewGuid().ToString('N')
  $stdoutPath = Join-Path $script:LogsRoot ".capture-$captureId.stdout"
  $stderrPath = Join-Path $script:LogsRoot ".capture-$captureId.stderr"
  $signalPath = Join-Path $script:LogsRoot ".capture-$captureId.start"
  $wrapperPath = Join-Path $script:LogsRoot ".capture-$captureId.cmd"
  $commandPath = Join-Path $script:LogsRoot ".capture-$captureId.command.cmd"
  $commandInput = @(
    '@echo off'
    $Command
    'exit /b %errorlevel%'
  ) -join "`r`n"
  Write-Utf8File -Path $commandPath -Text ($commandInput + "`r`n")
  $wrapper = @(
    '@echo off'
    ':wait_for_job'
    "if not exist `"$signalPath`" goto wait_for_job"
    "call `"$commandPath`" 1>`"$stdoutPath`" 2>`"$stderrPath`""
    'exit /b %errorlevel%'
  ) -join "`r`n"
  Write-Utf8File -Path $wrapperPath -Text ($wrapper + "`r`n")
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $env:ComSpec
  if (-not $psi.FileName) { $psi.FileName = 'cmd.exe' }
  $psi.Arguments = '/d /s /c ""' + $wrapperPath + '""'
  $psi.WorkingDirectory = $script:CandidatePath
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true

  $process = $null
  $job = $null
  $timedOut = $false
  $terminationConfirmed = $false
  $exitCode = 125
  $processId = 0
  $processStarted = $false
  $stoppedBeforeSignal = $false
  $executionError = $null
  try {
    try {
      $process = New-Object System.Diagnostics.Process
      $process.StartInfo = $psi
      $job = New-Object TwilightFinalGate.OwnedJob
      if (-not $process.Start()) { throw "Failed to start command: $Command" }
      $processStarted = $true
      $processId = $process.Id
      try {
        $job.Assign($process.Handle)
      } catch {
        $assignmentError = $_
        try {
          $process.Kill()
          $stoppedBeforeSignal = $process.WaitForExit(5000)
        } catch {}
        if (-not $stoppedBeforeSignal) {
          try {
            [void](Invoke-TaskkillWithDeadline -ProcessId $process.Id)
            $stoppedBeforeSignal = $process.WaitForExit(5000)
          } catch {}
        }
        if (-not $stoppedBeforeSignal) {
          throw "Job assignment failed and the pre-signal wrapper could not be terminated: $($assignmentError.Exception.Message)"
        }
        throw "Job assignment failed before command release: $($assignmentError.Exception.Message)"
      }
      Write-Utf8File -Path $signalPath -Text "start`n"
      $timedOut = -not $process.WaitForExit($TimeoutSeconds * 1000)
      if ($timedOut) {
        try { $job.Terminate(124) } catch {}
        $terminationConfirmed = $process.WaitForExit(5000)

        if (-not $terminationConfirmed) {
          try {
            [void](Invoke-TaskkillWithDeadline -ProcessId $process.Id)
          } catch {}
          $terminationConfirmed = $process.WaitForExit(5000)
        }
        if (-not $terminationConfirmed) {
          try {
            $killTree = $process.GetType().GetMethod('Kill', [type[]]@([bool]))
            if ($killTree) { [void]$killTree.Invoke($process, @($true)) } else { $process.Kill() }
          } catch {}
          $terminationConfirmed = $process.WaitForExit(5000)
        }
        $exitCode = if ($terminationConfirmed) { 124 } else { 125 }
      } else {
        $terminationConfirmed = $true
        $exitCode = $process.ExitCode
      }
    } catch {
      $executionError = $_
      if (-not $processStarted) {
        $terminationConfirmed = $true
      } elseif ($stoppedBeforeSignal) {
        $terminationConfirmed = $true
      } else {
        try { if ($job) { $job.Terminate(125) } } catch {}
        try {
          $terminationConfirmed = $process.WaitForExit(5000)
        } catch {}
      }
    }
  } finally {
    if ($job) { $job.Dispose() }
    if ($process) { $process.Dispose() }
  }

  $stdout = Read-TextFileShared $stdoutPath
  $stderr = Read-TextFileShared $stderrPath
  $capturePaths = @($stdoutPath, $stderrPath, $signalPath, $wrapperPath, $commandPath)
  $remaining = @($capturePaths | Where-Object { Test-Path -LiteralPath $_ })
  if ($terminationConfirmed) {
    $cleanupDeadline = [DateTime]::UtcNow.AddSeconds(3)
    do {
      Remove-Item -LiteralPath $capturePaths -Force -ErrorAction SilentlyContinue
      $remaining = @($capturePaths | Where-Object { Test-Path -LiteralPath $_ })
      if ($remaining.Count -eq 0) { break }
      Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $cleanupDeadline)
    if ($remaining.Count -ne 0) {
      $terminationConfirmed = $false
      $exitCode = 125
      $stderr += "`r`nCapture handles remained open after the secondary hard deadline: $($remaining -join ', ')"
    }
  }
  if ($executionError) {
    if ($remaining.Count -ne 0) {
      throw "Command execution failed and capture cleanup was incomplete: $($executionError.Exception.Message); remaining=$($remaining -join ', ')"
    }
    throw $executionError
  }
  return [pscustomobject]@{
    exitCode = $exitCode
    timedOut = $timedOut
    terminationConfirmed = $terminationConfirmed
    stdout = $stdout
    stderr = $stderr
    processId = $processId
    capturePaths = $capturePaths
    captureFilesRemaining = $remaining
  }
}

function Invoke-GateStage {
  param(
    [Parameter(Mandatory = $true)][string]$Id,
    [Parameter(Mandatory = $true)][string]$Command,
    [int]$TimeoutSeconds = 1200
  )

  if (-not $script:StagePlanById.ContainsKey($Id)) { throw "Unplanned gate stage: $Id" }
  $descriptor = $script:StagePlanById[$Id]
  if ([string]$descriptor.kind -ne 'command' -or [string]$descriptor.command -ne $Command -or [int]$descriptor.timeout -ne $TimeoutSeconds) {
    throw "Gate stage invocation differs from its bound plan: $Id"
  }

  if ($Resume -and (Test-StageAlreadyPassed $Id)) {
    Write-Host "[resume] $Id already passed"
    return
  }

  $history = @(Get-StageHistory $Id)
  $attempt = $history.Count + 1
  $safeId = $Id -replace '[^A-Za-z0-9._-]', '-'
  $logName = if ($attempt -eq 1) { "$safeId.log" } else { "$safeId.attempt-$attempt.log" }
  $logPath = Join-Path $script:LogsRoot $logName
  $started = [DateTime]::UtcNow
  Write-Host "[gate] $Id (attempt $attempt)"
  $result = Invoke-CommandProcess -Command $Command -TimeoutSeconds $TimeoutSeconds
  $ended = [DateTime]::UtcNow
  $durationMs = [int64]($ended - $started).TotalMilliseconds
  $logText = @(
    "id: $Id"
    "attempt: $attempt"
    "startedAtUtc: $($started.ToString('o'))"
    "endedAtUtc: $($ended.ToString('o'))"
    "durationMs: $durationMs"
    "timeoutSeconds: $TimeoutSeconds"
    "timedOut: $($result.timedOut)"
    "terminationConfirmed: $($result.terminationConfirmed)"
    "exitCode: $($result.exitCode)"
    "command: $Command"
    ''
    '--- stdout ---'
    $result.stdout
    '--- stderr ---'
    $result.stderr
  ) -join "`r`n"
  Write-Utf8File -Path $logPath -Text $logText
  $logSha256 = Get-Sha256File $logPath
  Add-ResultRecord ([pscustomobject]@{
      id = $Id
      attempt = $attempt
      command = $Command
      startedAtUtc = $started.ToString('o')
      durationMs = $durationMs
      timeoutSeconds = $TimeoutSeconds
      timedOut = [bool]$result.timedOut
      terminationConfirmed = [bool]$result.terminationConfirmed
      exitCode = [int]$result.exitCode
      log = Get-RelativePath -Root $script:CandidatePath -Path $logPath
      logSha256 = $logSha256
      sourceManifestSha256 = $script:SourceManifestSha256
      planDigest = $script:PlanDigest
    })
  if ($result.exitCode -ne 0) {
    throw "Gate stage $Id failed with exit code $($result.exitCode); see $logPath"
  }
}

function Invoke-InternalStage {
  param(
    [Parameter(Mandatory = $true)][string]$Id,
    [Parameter(Mandatory = $true)][scriptblock]$Action
  )
  if (-not $script:StagePlanById.ContainsKey($Id) -or [string]$script:StagePlanById[$Id].kind -ne 'internal') {
    throw "Unplanned internal gate stage: $Id"
  }
  if ($Resume -and (Test-StageAlreadyPassed $Id)) {
    Write-Host "[resume] $Id already passed"
    return
  }
  $history = @(Get-StageHistory $Id)
  $attempt = $history.Count + 1
  $safeId = $Id -replace '[^A-Za-z0-9._-]', '-'
  $logName = if ($attempt -eq 1) { "$safeId.log" } else { "$safeId.attempt-$attempt.log" }
  $logPath = Join-Path $script:LogsRoot $logName
  $started = [DateTime]::UtcNow
  $exitCode = 0
  $message = 'ok'
  try {
    & $Action
  } catch {
    $exitCode = 1
    $message = $_.Exception.ToString()
  }
  $ended = [DateTime]::UtcNow
  $durationMs = [int64]($ended - $started).TotalMilliseconds
  Write-Utf8File -Path $logPath -Text ($message + "`n")
  $logSha256 = Get-Sha256File $logPath
  $descriptor = $script:StagePlanById[$Id]
  Add-ResultRecord ([pscustomobject]@{
      id = $Id
      attempt = $attempt
      command = [string]$descriptor.command
      startedAtUtc = $started.ToString('o')
      durationMs = $durationMs
      timeoutSeconds = [int]$descriptor.timeout
      timedOut = $false
      exitCode = $exitCode
      log = Get-RelativePath -Root $script:CandidatePath -Path $logPath
      logSha256 = $logSha256
      sourceManifestSha256 = $script:SourceManifestSha256
      planDigest = $script:PlanDigest
    })
  if ($exitCode -ne 0) { throw $message }
}

function Get-DirectoryManifest {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [string[]]$ExcludeRelativePaths = @()
  )
  $records = New-Object System.Collections.Generic.List[object]
  $pending = New-Object System.Collections.Generic.Stack[string]
  $pending.Push([System.IO.Path]::GetFullPath($Root))
  while ($pending.Count -gt 0) {
    $directory = $pending.Pop()
    foreach ($item in Get-ChildItem -LiteralPath $directory -Force) {
      $relative = Get-RelativePath -Root $Root -Path $item.FullName
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Directory manifest contains a reparse point: $relative"
      }
      if ($item.PSIsContainer) {
        $pending.Push($item.FullName)
      } elseif ($ExcludeRelativePaths -notcontains $relative) {
        $records.Add([pscustomobject]@{
            path = $relative
            size = [int64]$item.Length
            sha256 = Get-Sha256File $item.FullName
          })
      }
    }
  }
  $orderedRecords = @($records | Sort-Object path)
  return [pscustomobject]@{
    fileCount = $orderedRecords.Count
    totalBytes = [int64](($orderedRecords | Measure-Object -Property size -Sum).Sum)
    recordsDigestSha256 = Get-RecordsDigest $orderedRecords
    files = $orderedRecords
  }
}

function Initialize-ElectronOverride {
  if (-not $ElectronDistOverride) { return }
  $sourceDist = Join-Path $script:CandidatePath 'node_modules\electron\dist'
  if (-not (Test-Path -LiteralPath $sourceDist -PathType Container)) {
    throw "Candidate Electron dist is missing: $sourceDist"
  }
  $destination = [System.IO.Path]::GetFullPath($ElectronDistOverride)
  Assert-FixedExternalLeaf -Path $destination -ExpectedLeaf $script:ElectronLeafName -Label 'ElectronDistOverride'

  $sourceManifest = Get-DirectoryManifest $sourceDist
  $reused = $false
  $archivedPath = $null
  if (Test-Path -LiteralPath $destination) {
    if (-not (Test-Path -LiteralPath $destination -PathType Container)) {
      throw "ElectronDistOverride exists but is not an owned directory: $destination"
    }
    $owner = Read-ValidatedOwnerMarker -Root $destination -Kind electron
    $existing = Get-DirectoryManifest $destination -ExcludeRelativePaths @('.twilight-final-gate-owner.json')
    if ([string]$owner.planDigest -eq $script:PlanDigest -and
        $existing.recordsDigestSha256 -eq $sourceManifest.recordsDigestSha256 -and
        $existing.fileCount -eq $sourceManifest.fileCount) {
      $reused = $true
    } else {
      $archivedPath = Join-Path $script:ExternalToolRoot "failed-$($script:ElectronLeafName)-$($script:RunId)"
      if (Test-Path -LiteralPath $archivedPath) { throw "Electron archive path exists: $archivedPath" }
      Assert-DirectPhysicalChild -Parent $script:ExternalToolRoot -Child $archivedPath -Label 'Electron owned archive'
      Move-Item -LiteralPath $destination -Destination $archivedPath
      [void](Rebind-ArchivedOwnerMarker -Root $archivedPath -Kind electron -PreviousOwner $owner)
    }
  }

  if (-not $reused) {
    [System.IO.Directory]::CreateDirectory($script:ExternalToolRoot) | Out-Null
    [System.IO.Directory]::CreateDirectory($destination) | Out-Null
    foreach ($record in $sourceManifest.files) {
      $sourcePath = Join-Path $sourceDist ([string]$record.path).Replace('/', '\')
      $destinationPath = Join-Path $destination ([string]$record.path).Replace('/', '\')
      [System.IO.Directory]::CreateDirectory((Split-Path -Parent $destinationPath)) | Out-Null
      Copy-Item -LiteralPath $sourcePath -Destination $destinationPath
    }
    Write-OwnerMarker -Root $destination -Kind electron -SourceManifestSha256 $script:SourceManifestSha256 -PlanDigest $script:PlanDigest
  }

  [void](Read-ValidatedOwnerMarker -Root $destination -Kind electron -RequireCurrentPlan)
  $destinationManifest = Get-DirectoryManifest $destination -ExcludeRelativePaths @('.twilight-final-gate-owner.json')
  if ($destinationManifest.fileCount -ne $sourceManifest.fileCount -or
      $destinationManifest.recordsDigestSha256 -ne $sourceManifest.recordsDigestSha256) {
    throw 'Electron override copy is not byte-for-byte identical to the candidate dist'
  }
  $evidence = [pscustomobject]@{
    schemaVersion = 1
    createdAtUtc = [DateTime]::UtcNow.ToString('o')
    candidate = $CandidateName
    sourceRoot = $sourceDist
    destinationRoot = $destination
    reusedExistingIdenticalCopy = $reused
    archivedMismatchedCopy = $archivedPath
    fileCount = $sourceManifest.fileCount
    totalBytes = $sourceManifest.totalBytes
    recordsDigestSha256 = $sourceManifest.recordsDigestSha256
    files = $sourceManifest.files
  }
  $manifestPath = Join-Path $script:EvidenceRoot 'electron-override-manifest.json'
  Write-JsonFile -Path $manifestPath -Value $evidence -Depth 15
  Write-Utf8File -Path (Join-Path $script:EvidenceRoot 'electron-override-manifest.sha256') -Text ((Get-Sha256File $manifestPath) + " *electron-override-manifest.json`n")
  $env:ELECTRON_OVERRIDE_DIST_PATH = $destination
}

function Get-GatePlan {
  $duplicateOutput = 'evidence\benchmarks\duplicate-detection.json'
  $duplicateManifest = 'evidence\benchmarks\duplicate-detection.manifest.json'
  $queueOutput = 'evidence\benchmarks\queue-virtualization.json'
  $persistenceOutput = 'evidence\benchmarks\persistence.json'
  $persistenceWork = '%TEMP%\twilight-final-persistence-work'
  return @(
    [pscustomobject]@{ id = 'pnpm-install'; command = 'corepack pnpm@11.7.0 install --frozen-lockfile --store-dir "%PNPM_STORE_DIR%"'; timeout = 1800 },
    [pscustomobject]@{ id = 'verify-install-policy'; command = 'corepack pnpm@11.7.0 run verify:install-policy'; timeout = 300 },
    [pscustomobject]@{ id = 'verify-ncm-patch'; command = 'corepack pnpm@11.7.0 run verify:ncm-patch'; timeout = 300 },
    [pscustomobject]@{ id = 'test-production-audit'; command = 'corepack pnpm@11.7.0 run test:production-audit'; timeout = 300 },
    [pscustomobject]@{ id = 'test-production-audit-integration'; command = 'set "TWILIGHT_AUDIT_INTEGRATION_CANDIDATE=%CD%" && corepack pnpm@11.7.0 run test:production-audit'; timeout = 600 },
    [pscustomobject]@{ id = 'audit-production-live'; command = 'corepack pnpm@11.7.0 run audit:production -- --output evidence\production-dependency-audit.json'; timeout = 600 },
    [pscustomobject]@{ id = 'test-release-artifacts'; command = 'corepack pnpm@11.7.0 run test:release-artifacts'; timeout = 300 },
    [pscustomobject]@{ id = 'feature-gates'; command = 'node --test scripts\feature-test-gates.test.cjs'; timeout = 300 },
    [pscustomobject]@{ id = 'test-renderer-data-tooling'; command = 'corepack pnpm@11.7.0 run test:renderer-data-tooling'; timeout = 600 },
    [pscustomobject]@{ id = 'benchmark-persistence'; command = "node --expose-gc scripts\persistence-benchmark.cjs --work-dir $persistenceWork --output $persistenceOutput"; timeout = 1200 },
    [pscustomobject]@{ id = 'test-persistence-benchmark-after-live'; command = 'node --test scripts\persistence-benchmark.test.cjs'; timeout = 300 },
    [pscustomobject]@{ id = 'test-audio-toolchain'; command = 'corepack pnpm@11.7.0 run test:audio-toolchain'; timeout = 600 },
    [pscustomobject]@{ id = 'build-plugin-api'; command = 'corepack pnpm@11.7.0 run build:plugin-api'; timeout = 600 },
    [pscustomobject]@{ id = 'test-app'; command = 'corepack pnpm@11.7.0 run test:app'; timeout = 900 },
    [pscustomobject]@{ id = 'test-sleep-timer'; command = 'corepack pnpm@11.7.0 run test:sleep-timer'; timeout = 900 },
    [pscustomobject]@{ id = 'test-cross-cutting-regressions'; command = 'corepack pnpm@11.7.0 run test:cross-cutting-regressions'; timeout = 900 },
    [pscustomobject]@{ id = 'test-plugins'; command = 'corepack pnpm@11.7.0 run test:plugins'; timeout = 900 },
    [pscustomobject]@{ id = 'test-plugin-tooling'; command = 'corepack pnpm@11.7.0 run test:plugin-tooling'; timeout = 300 },
    [pscustomobject]@{ id = 'test-dsp-graph'; command = 'corepack pnpm@11.7.0 run test:dsp-graph'; timeout = 300 },
    [pscustomobject]@{ id = 'test-dsp-assets'; command = 'corepack pnpm@11.7.0 run test:dsp-assets'; timeout = 300 },
    [pscustomobject]@{ id = 'test-audio-manager'; command = 'corepack pnpm@11.7.0 run test:audio-manager'; timeout = 900 },
    [pscustomobject]@{ id = 'test-playback-routing'; command = 'corepack pnpm@11.7.0 run test:playback-routing'; timeout = 900 },
    [pscustomobject]@{ id = 'test-local-perf'; command = 'corepack pnpm@11.7.0 run test:local-perf'; timeout = 900 },
    [pscustomobject]@{ id = 'test-themes'; command = 'corepack pnpm@11.7.0 run test:themes'; timeout = 900 },
    [pscustomobject]@{ id = 'test-appearance-workspace'; command = 'corepack pnpm@11.7.0 run test:appearance-workspace'; timeout = 900 },
    [pscustomobject]@{ id = 'test-playlist-lifecycle'; command = 'corepack pnpm@11.7.0 run test:playlist-lifecycle'; timeout = 900 },
    [pscustomobject]@{ id = 'test-tag-duplicate-management'; command = 'corepack pnpm@11.7.0 run test:tag-duplicate-management'; timeout = 900 },
    [pscustomobject]@{ id = 'test-duplicate-detection'; command = 'corepack pnpm@11.7.0 run test:duplicate-detection'; timeout = 600 },
    [pscustomobject]@{ id = 'test-duplicate-detection-benchmark'; command = 'corepack pnpm@11.7.0 run test:duplicate-detection-benchmark'; timeout = 600 },
    [pscustomobject]@{ id = 'benchmark-duplicate-detection'; command = "corepack pnpm@11.7.0 run benchmark:duplicate-detection:ci -- --output $duplicateOutput --manifest $duplicateManifest"; timeout = 900 },
    [pscustomobject]@{ id = 'test-duplicate-benchmark-after-live'; command = 'corepack pnpm@11.7.0 run test:duplicate-detection-benchmark'; timeout = 600 },
    [pscustomobject]@{ id = 'test-queue-virtualization'; command = 'corepack pnpm@11.7.0 run test:queue-virtualization'; timeout = 600 },
    [pscustomobject]@{ id = 'benchmark-queue-virtualization'; command = "node --experimental-strip-types --expose-gc scripts\playback-queue-virtualization-benchmark.ts --output $queueOutput"; timeout = 900 },
    [pscustomobject]@{ id = 'test-queue-benchmark-after-live'; command = 'corepack pnpm@11.7.0 run test:queue-virtualization'; timeout = 600 },
    [pscustomobject]@{ id = 'test-lyrics-management'; command = 'corepack pnpm@11.7.0 run test:lyrics-management'; timeout = 900 },
    [pscustomobject]@{ id = 'test-radio-remote'; command = 'corepack pnpm@11.7.0 run test:radio-remote'; timeout = 900 },
    [pscustomobject]@{ id = 'test-network-sources'; command = 'corepack pnpm@11.7.0 run test:network-sources'; timeout = 900 },
    [pscustomobject]@{ id = 'test-cue'; command = 'corepack pnpm@11.7.0 run test:cue'; timeout = 900 },
    [pscustomobject]@{ id = 'typecheck-node'; command = 'corepack pnpm@11.7.0 run typecheck:node'; timeout = 900 },
    [pscustomobject]@{ id = 'typecheck-web'; command = 'corepack pnpm@11.7.0 run typecheck:web'; timeout = 900 },
    [pscustomobject]@{ id = 'lint'; command = 'corepack pnpm@11.7.0 exec eslint --no-cache .'; timeout = 900 },
    [pscustomobject]@{ id = 'build'; command = 'corepack pnpm@11.7.0 run build'; timeout = 1200 },
    [pscustomobject]@{ id = 'renderer-budget'; command = 'corepack pnpm@11.7.0 run verify:renderer-budgets'; timeout = 300 }
  )
}

function New-StageDescriptor {
  param(
    [Parameter(Mandatory = $true)][string]$Id,
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][int]$Timeout,
    [Parameter(Mandatory = $true)][ValidateSet('command', 'internal')][string]$Kind
  )
  return [pscustomobject][ordered]@{ id = $Id; command = $Command; timeout = $Timeout; kind = $Kind }
}

function Get-FullStagePlan {
  $plan = New-Object System.Collections.Generic.List[object]
  $plan.Add((New-StageDescriptor -Id 'source-manifest-verify-before-gate' -Command 'internal:source-manifest-verify-before-gate' -Timeout 0 -Kind internal))
  foreach ($stage in Get-GatePlan) {
    $plan.Add((New-StageDescriptor -Id $stage.id -Command $stage.command -Timeout $stage.timeout -Kind command))
    if ($stage.id -eq 'test-persistence-benchmark-after-live') {
      $plan.Add((New-StageDescriptor -Id 'benchmark-persistence-evidence' -Command 'internal:benchmark-persistence-evidence' -Timeout 0 -Kind internal))
    } elseif ($stage.id -eq 'test-duplicate-benchmark-after-live') {
      $plan.Add((New-StageDescriptor -Id 'benchmark-duplicate-evidence' -Command 'internal:benchmark-duplicate-evidence' -Timeout 0 -Kind internal))
    } elseif ($stage.id -eq 'test-queue-benchmark-after-live') {
      $plan.Add((New-StageDescriptor -Id 'benchmark-queue-evidence' -Command 'internal:benchmark-queue-evidence' -Timeout 0 -Kind internal))
    }
  }
  $plan.Add((New-StageDescriptor -Id 'native-configure' -Command 'corepack pnpm@11.7.0 run configure:audio-engine:mingw' -Timeout 1800 -Kind command))
  $plan.Add((New-StageDescriptor -Id 'native-build' -Command 'corepack pnpm@11.7.0 run build:audio-engine:mingw' -Timeout 2400 -Kind command))
  $plan.Add((New-StageDescriptor -Id 'native-ctest-list' -Command 'ctest --test-dir "%TAE_MINGW_BUILD_DIR%" -N' -Timeout 300 -Kind command))
  $plan.Add((New-StageDescriptor -Id 'native-ctest-21' -Command 'ctest --test-dir "%TAE_MINGW_BUILD_DIR%" --output-on-failure' -Timeout 2400 -Kind command))
  $plan.Add((New-StageDescriptor -Id 'native-ctest-evidence-check' -Command 'internal:native-ctest-evidence-check' -Timeout 0 -Kind internal))
  $plan.Add((New-StageDescriptor -Id 'candidate-source-verify-after-gate' -Command 'internal:candidate-source-verify-after-gate' -Timeout 0 -Kind internal))
  $plan.Add((New-StageDescriptor -Id 'main-source-verify-after-gate' -Command 'internal:main-source-verify-after-gate' -Timeout 0 -Kind internal))
  $plan.Add((New-StageDescriptor -Id 'mandatory-stage-coverage' -Command 'internal:mandatory-stage-coverage' -Timeout 0 -Kind internal))
  return @($plan.GetEnumerator() | ForEach-Object { $_ })
}

function Get-NormalizedPlanPath {
  param([string]$Path)
  if (-not $Path) { return '' }
  return (ConvertTo-NormalizedPath (Get-PhysicalCanonicalPath $Path)).ToLowerInvariant()
}

function Initialize-PlanBinding {
  $manifest = Get-Content -LiteralPath $script:SourceManifestPath -Raw | ConvertFrom-Json
  Assert-CriticalPathPolicy
  Assert-PathsDoNotOverlap -Left $script:ExternalToolRoot -Right $script:SourceRoot -Label 'ExternalToolRoot/Source'
  Assert-PathsDoNotOverlap -Left $script:ExternalToolRoot -Right $script:OutputRoot -Label 'ExternalToolRoot/OutputRoot'
  Assert-PathsDoNotOverlap -Left $script:ExternalToolRoot -Right $script:CandidatePath -Label 'ExternalToolRoot/Candidate'
  if (-not $NativeBuildDir) { throw 'NativeBuildDir is required for the complete integrated gate' }
  Assert-FixedExternalLeaf -Path $NativeBuildDir -ExpectedLeaf $script:NativeLeafName -Label 'NativeBuildDir'
  if ($ElectronDistOverride) {
    Assert-FixedExternalLeaf -Path $ElectronDistOverride -ExpectedLeaf $script:ElectronLeafName -Label 'ElectronDistOverride'
    Assert-PathsDoNotOverlap -Left $ElectronDistOverride -Right $NativeBuildDir -Label 'Electron/Native'
  }

  $script:StagePlan = @(Get-FullStagePlan)
  $script:StagePlanById = @{}
  foreach ($stage in $script:StagePlan) {
    if ($script:StagePlanById.ContainsKey([string]$stage.id)) { throw "Duplicate gate stage id: $($stage.id)" }
    $script:StagePlanById[[string]$stage.id] = $stage
  }
  $planCore = [ordered]@{
    schemaVersion = 1
    sourceManifestSha256 = $script:SourceManifestSha256
    candidateSourceDigestSha256 = [string]$manifest.recordsDigestSha256
    paths = [ordered]@{
      source = Get-NormalizedPlanPath $script:SourceRoot
      outputRoot = Get-NormalizedPlanPath $script:OutputRoot
      candidate = Get-NormalizedPlanPath $script:CandidatePath
      externalToolRoot = Get-NormalizedPlanPath $script:ExternalToolRoot
      nativeBuildDir = Get-NormalizedPlanPath $NativeBuildDir
      electronDistOverride = Get-NormalizedPlanPath $ElectronDistOverride
    }
    stages = @($script:StagePlan | ForEach-Object {
        [ordered]@{ id = [string]$_.id; command = [string]$_.command; timeout = [int]$_.timeout; kind = [string]$_.kind }
      })
  }
  $planJson = $planCore | ConvertTo-Json -Compress -Depth 12
  $script:PlanDigest = Get-Sha256Text $planJson
  $script:InvocationPath = Join-Path $script:EvidenceRoot 'gate-invocation.json'

  if ($Resume) {
    $validExisting = $false
    $hashPath = Join-Path $script:EvidenceRoot 'gate-invocation.sha256'
    if ((Test-Path -LiteralPath $script:InvocationPath -PathType Leaf) -and (Test-Path -LiteralPath $hashPath -PathType Leaf)) {
      $savedHash = ([System.IO.File]::ReadAllText($hashPath)).Split(' ')[0].Trim()
      $actualHash = Get-Sha256File $script:InvocationPath
      if ($savedHash -eq $actualHash) {
        $saved = Get-Content -LiteralPath $script:InvocationPath -Raw | ConvertFrom-Json
        $validExisting = [string]$saved.planDigest -eq $script:PlanDigest
      }
    }
    if (-not $validExisting) {
      $script:ForceRerunAll = $true
      if (Test-Path -LiteralPath $script:InvocationPath) {
        $stale = Join-Path $script:EvidenceRoot "gate-invocation.stale-$($script:RunId).json"
        if (Test-Path -LiteralPath $stale) { throw "Stale invocation archive already exists: $stale" }
        Copy-Item -LiteralPath $script:InvocationPath -Destination $stale
      }
      if (Test-Path -LiteralPath $script:ResultsPath -PathType Leaf) {
        $staleResults = Join-Path $script:EvidenceRoot "gate-results.stale-$($script:RunId).ndjson"
        if (Test-Path -LiteralPath $staleResults) { throw "Stale results archive already exists: $staleResults" }
        Copy-Item -LiteralPath $script:ResultsPath -Destination $staleResults
        Write-Utf8File -Path $script:ResultsPath -Text ''
      }
      $script:ForceRerunAll = $false
    }
  }

  $invocation = [ordered]@{
    schemaVersion = 1
    createdAtUtc = [DateTime]::UtcNow.ToString('o')
    candidate = $CandidateName
    runId = $script:RunId
    planDigest = $script:PlanDigest
    plan = $planCore
  }
  Write-JsonFile -Path $script:InvocationPath -Value $invocation -Depth 15
  Write-Utf8File -Path (Join-Path $script:EvidenceRoot 'gate-invocation.sha256') -Text ((Get-Sha256File $script:InvocationPath) + " *gate-invocation.json`n")
  Write-OwnerMarker -Root $script:CandidatePath -Kind candidate -SourceManifestSha256 $script:SourceManifestSha256 -PlanDigest $script:PlanDigest -OwnerCandidateName $CandidateName
}

function Initialize-GateEnvironment {
  $environmentRoot = Join-Path $script:OutputRoot '_final-integrated-env'
  $paths = [ordered]@{
    COREPACK_HOME = Join-Path $environmentRoot 'corepack'
    PNPM_HOME = Join-Path $environmentRoot 'pnpm-home'
    PNPM_STORE_DIR = Join-Path $environmentRoot 'pnpm-store'
    NPM_CONFIG_CACHE = Join-Path $environmentRoot 'npm-cache'
    TEMP = Join-Path $environmentRoot 'temp'
    TMP = Join-Path $environmentRoot 'temp'
    ELECTRON_CACHE = Join-Path $environmentRoot 'electron-cache'
    ELECTRON_BUILDER_CACHE = Join-Path $environmentRoot 'electron-builder-cache'
  }
  foreach ($entry in $paths.GetEnumerator()) {
    [System.IO.Directory]::CreateDirectory([string]$entry.Value) | Out-Null
    [Environment]::SetEnvironmentVariable([string]$entry.Key, [string]$entry.Value, 'Process')
  }
  $env:CI = '1'
  $env:PNPM_DISABLE_SELF_UPDATE_CHECK = '1'
  $env:PATH = "$($paths.PNPM_HOME);$env:PATH"
  Write-JsonFile -Path (Join-Path $script:EvidenceRoot 'environment.json') -Value ([pscustomobject]@{
      node = (& node --version)
      corepack = (& corepack --version)
      pnpmRequested = '11.7.0'
      environmentRoot = $environmentRoot
      variables = $paths
    })
}

function Move-ManagedInvalidCandidate {
  param([Parameter(Mandatory = $true)][string]$InvalidName)
  Assert-SafeLeafName -Name $InvalidName -Label 'ArchiveInvalidCandidateName'
  $invalidPath = Join-Path $script:OutputRoot $InvalidName
  if (-not (Test-Path -LiteralPath $invalidPath -PathType Container)) { return }
  Assert-DirectPhysicalChild -Parent $script:OutputRoot -Child $invalidPath -Label 'Archive source'
  Assert-PathsDoNotOverlap -Left $invalidPath -Right $script:SourceRoot -Label 'Archive source/Source'
  Assert-PathsDoNotOverlap -Left $invalidPath -Right $script:CandidatePath -Label 'Archive source/New candidate'

  $manifestPath = Resolve-SafeRelativePath -Root $invalidPath -RelativePath 'evidence/source-manifest.json' -Label 'Archive source manifest'
  $manifestHashPath = Resolve-SafeRelativePath -Root $invalidPath -RelativePath 'evidence/source-manifest.sha256' -Label 'Archive source manifest hash'
  $freezePath = Resolve-SafeRelativePath -Root $invalidPath -RelativePath 'evidence/freeze-result.json' -Label 'Archive freeze evidence'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf) -or
      -not (Test-Path -LiteralPath $manifestHashPath -PathType Leaf) -or
      -not (Test-Path -LiteralPath $freezePath -PathType Leaf)) {
    throw "Refusing to archive a candidate without manifest/hash/freeze ownership evidence: $invalidPath"
  }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $expectedHash = ([System.IO.File]::ReadAllText($manifestHashPath)).Split(' ')[0].Trim()
  $actualHash = Get-Sha256File $manifestPath
  $freeze = Get-Content -LiteralPath $freezePath -Raw | ConvertFrom-Json
  if ($expectedHash -ne $actualHash -or
      [string]$manifest.candidate -ne $InvalidName -or
      -not (Get-PhysicalCanonicalPath ([string]$freeze.candidatePath)).Equals((Get-PhysicalCanonicalPath $invalidPath), [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to archive candidate with inconsistent ownership evidence: $invalidPath"
  }

  $markerPath = Get-OwnerMarkerPath $invalidPath
  if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
    throw "Refusing to archive a candidate without its pre-existing ownership marker: $invalidPath"
  }
  $owner = Read-ValidatedOwnerMarker -Root $invalidPath -Kind candidate
  if ([string]$owner.sourceManifestSha256 -ne $actualHash) {
    throw "Refusing to archive a candidate whose ownership marker is bound to another source manifest: $invalidPath"
  }

  $archiveName = "failed-$InvalidName-source-changed"
  $archivePath = Join-Path $script:OutputRoot $archiveName
  if (Test-Path -LiteralPath $archivePath) {
    $archiveName = "$archiveName-$($script:RunId)"
    $archivePath = Join-Path $script:OutputRoot $archiveName
  }
  if (Test-Path -LiteralPath $archivePath) { throw "Archive destination already exists: $archivePath" }
  Assert-SafeLeafName -Name $archiveName -Label 'Archive destination'
  Assert-DirectPhysicalChild -Parent $script:OutputRoot -Child $archivePath -Label 'Archive destination'
  Assert-PathsDoNotOverlap -Left $archivePath -Right $script:SourceRoot -Label 'Archive destination/Source'
  Assert-PathsDoNotOverlap -Left $archivePath -Right $script:CandidatePath -Label 'Archive destination/New candidate'
  Move-Item -LiteralPath $invalidPath -Destination $archivePath
  Write-OwnerMarker -Root $archivePath -Kind candidate -SourceManifestSha256 $actualHash -OwnerCandidateName $archiveName
}

function Initialize-NewCandidate {
  if ($ArchiveInvalidCandidateName) {
    Move-ManagedInvalidCandidate -InvalidName $ArchiveInvalidCandidateName
  }

  if (Test-Path -LiteralPath $script:CandidatePath) {
    throw "Candidate already exists; use -Resume with the same CandidateName: $($script:CandidatePath)"
  }
  [System.IO.Directory]::CreateDirectory($script:CandidatePath) | Out-Null
  [System.IO.Directory]::CreateDirectory($script:EvidenceRoot) | Out-Null
  [System.IO.Directory]::CreateDirectory($script:LogsRoot) | Out-Null
  Write-OwnerMarker -Root $script:CandidatePath -Kind candidate -OwnerCandidateName $CandidateName

  $snapshot = Get-SourceSnapshot -DestinationRoot $script:CandidatePath
  $manifest = [pscustomobject]@{
    schemaVersion = 1
    candidate = $CandidateName
    createdAtUtc = [DateTime]::UtcNow.ToString('o')
    source = [pscustomobject]@{
      root = $script:SourceRoot
      gitHead = $snapshot.git.head
      gitBranch = $snapshot.git.branch
      gitStatusSha256 = $snapshot.git.statusSha256
      gitStatusEntries = $snapshot.git.statusEntries
    }
    scope = [pscustomobject]@{
      description = 'Tracked and untracked non-ignored source leaf files. Deleted tracked paths are recorded as missing. Generated .git/node_modules/out/dist/build/temp/log, Vite transient config, and CTest temporary paths are excluded.'
      excluded = $snapshot.excluded
      missingTrackedFiles = $snapshot.missingTrackedFiles
    }
    fileCount = $snapshot.fileCount
    totalBytes = $snapshot.totalBytes
    recordsDigestSha256 = $snapshot.recordsDigestSha256
    recordsDigestEncoding = 'UTF-8 path NUL size NUL sha256 LF, ordinal relative-path order'
    packageProvenance = Get-PackageProvenance $snapshot.records
    files = $snapshot.records
  }
  Write-JsonFile -Path $script:SourceManifestPath -Value $manifest -Depth 15
  $script:SourceManifestSha256 = Get-Sha256File $script:SourceManifestPath
  Write-Utf8File -Path (Join-Path $script:EvidenceRoot 'source-manifest.sha256') -Text ("$($script:SourceManifestSha256) *source-manifest.json`n")
  Write-OwnerMarker -Root $script:CandidatePath -Kind candidate -SourceManifestSha256 $script:SourceManifestSha256 -OwnerCandidateName $CandidateName
  Write-Utf8File -Path (Join-Path $script:EvidenceRoot 'git-status.txt') -Text $snapshot.git.statusText
  Write-JsonFile -Path (Join-Path $script:EvidenceRoot 'freeze-result.json') -Value ([pscustomobject]@{
      candidatePath = $script:CandidatePath
      createdAtUtc = [DateTime]::UtcNow.ToString('o')
      copiedFiles = $snapshot.fileCount
      totalBytes = $snapshot.totalBytes
      recordsDigestSha256 = $snapshot.recordsDigestSha256
      excludedFiles = $snapshot.excluded.Count
      missingTrackedFiles = $snapshot.missingTrackedFiles.Count
      sourceReverified = $true
      gitStatusStable = $true
      sourceManifestSha256 = $script:SourceManifestSha256
    })
}

function Initialize-ResumeCandidate {
  if (-not (Test-Path -LiteralPath $script:CandidatePath -PathType Container)) {
    throw "Resume candidate does not exist: $($script:CandidatePath)"
  }
  if (-not (Test-Path -LiteralPath $script:SourceManifestPath -PathType Leaf)) {
    throw "Resume candidate has no source manifest: $($script:SourceManifestPath)"
  }
  $script:SourceManifestSha256 = Get-Sha256File $script:SourceManifestPath
  $expectedHashPath = Join-Path $script:EvidenceRoot 'source-manifest.sha256'
  if (-not (Test-Path -LiteralPath $expectedHashPath -PathType Leaf)) {
    throw 'Resume candidate has no source-manifest.sha256'
  }
  $expectedHash = ([System.IO.File]::ReadAllText($expectedHashPath)).Split(' ')[0].Trim()
  if ($expectedHash -ne $script:SourceManifestSha256) { throw 'Resume source manifest hash mismatch' }
  $owner = Read-ValidatedOwnerMarker -Root $script:CandidatePath -Kind candidate
  if ([string]$owner.sourceManifestSha256 -ne $script:SourceManifestSha256) {
    throw 'Resume candidate ownership marker is bound to another source manifest'
  }
  $manifest = Get-Content -LiteralPath $script:SourceManifestPath -Raw | ConvertFrom-Json
  Assert-CandidateMatchesManifest $manifest
  Assert-SourceMatchesManifest $manifest
}

function Assert-FiniteNonNegativeNumber {
  param($Value, [Parameter(Mandatory = $true)][string]$Label)
  $number = [double]$Value
  if ([double]::IsNaN($number) -or [double]::IsInfinity($number) -or $number -lt 0) {
    throw "$Label must be a finite non-negative number"
  }
  return $number
}

function Get-NearestRankPercentile {
  param(
    [Parameter(Mandatory = $true)][object[]]$Samples,
    [Parameter(Mandatory = $true)][double]$Quantile,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if ($Samples.Count -eq 0 -or $Quantile -le 0 -or $Quantile -gt 1) {
    throw "$Label percentile contract is invalid"
  }
  $ordered = @($Samples | ForEach-Object { Assert-FiniteNonNegativeNumber $_ "$Label sample" } | Sort-Object)
  $index = [Math]::Min($ordered.Count - 1, [Math]::Ceiling($ordered.Count * $Quantile) - 1)
  return [double]$ordered[$index]
}

function Assert-DuplicateBenchmarkEvidence {
  param(
    [string]$EvidencePath = (Join-Path $script:EvidenceRoot 'benchmarks\duplicate-detection.json'),
    [string]$ManifestPath = (Join-Path $script:EvidenceRoot 'benchmarks\duplicate-detection.manifest.json')
  )
  if (-not (Test-Path -LiteralPath $EvidencePath -PathType Leaf) -or -not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
    throw 'Duplicate benchmark evidence or manifest is missing'
  }
  $result = Get-Content -LiteralPath $EvidencePath -Raw | ConvertFrom-Json
  $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
  if ([int]$result.schemaVersion -ne 2 -or [int]$manifest.schemaVersion -ne 1) { throw 'Duplicate benchmark schema mismatch' }
  if ([int]$result.rows -ne 10000 -or [int]$result.warmupIterations -ne 3 -or [int]$result.iterations -ne 20) {
    throw 'Duplicate benchmark did not run the required 10k/3-warmup/20-sample contract'
  }
  if ([double]$result.budgets.uniqueP95Ms -ne 1500 -or
      [double]$result.budgets.collisionP95Ms -ne 2500 -or
      [double]$manifest.benchmark.budgets.uniqueP95Ms -ne 1500 -or
      [double]$manifest.benchmark.budgets.collisionP95Ms -ne 2500) {
    throw 'Duplicate benchmark budget contract mismatch'
  }
  foreach ($name in @('unique', 'collision')) {
    $scenario = $result.scenarios.$name
    if ([int]$scenario.rows -ne 10000 -or @($scenario.elapsedMs).Count -ne 20) { throw "Duplicate $name scenario shape mismatch" }
    $p95 = Assert-FiniteNonNegativeNumber $scenario.p95Ms "$name p95"
    $p50 = Assert-FiniteNonNegativeNumber $scenario.p50Ms "$name p50"
    if ($p95 -ne (Get-NearestRankPercentile -Samples @($scenario.elapsedMs) -Quantile 0.95 -Label "$name p95") -or
        $p50 -ne (Get-NearestRankPercentile -Samples @($scenario.elapsedMs) -Quantile 0.5 -Label "$name p50")) {
      throw "Duplicate $name reported percentiles do not match the raw samples"
    }
    $budgetName = if ($name -eq 'unique') { 'uniqueP95Ms' } else { 'collisionP95Ms' }
    $budget = Assert-FiniteNonNegativeNumber $result.budgets.$budgetName "$name budget"
    if ($p95 -gt $budget) { throw "Duplicate $name p95 exceeded budget" }
  }
  if ([string]$manifest.evidence.path -ne (Split-Path -Leaf $EvidencePath) -or
      [string]$manifest.evidence.sha256 -ne (Get-Sha256File $EvidencePath)) {
    throw 'Duplicate benchmark manifest evidence hash/path mismatch'
  }
  if ([int]$manifest.benchmark.rows -ne 10000 -or
      [int]$manifest.benchmark.warmupIterations -ne 3 -or
      [int]$manifest.benchmark.iterations -ne 20 -or
      [double]$manifest.benchmark.unique.p50Ms -ne [double]$result.scenarios.unique.p50Ms -or
      [double]$manifest.benchmark.unique.p95Ms -ne [double]$result.scenarios.unique.p95Ms -or
      [double]$manifest.benchmark.collision.p50Ms -ne [double]$result.scenarios.collision.p50Ms -or
      [double]$manifest.benchmark.collision.p95Ms -ne [double]$result.scenarios.collision.p95Ms) {
    throw 'Duplicate benchmark manifest does not match the live result'
  }
  if ([string]$result.provenance.algorithm -ne 'sha256' -or [string]$manifest.provenance.algorithm -ne 'sha256') {
    throw 'Duplicate benchmark provenance algorithm mismatch'
  }
  $expectedProvenance = @('source', 'sharedContract', 'runner', 'runnerContract', 'packageManifest', 'lockfile')
  $actualProvenance = @($result.provenance.PSObject.Properties.Name | Where-Object { $_ -ne 'algorithm' } | Sort-Object)
  if (($actualProvenance -join ',') -ne (($expectedProvenance | Sort-Object) -join ',')) {
    throw 'Duplicate benchmark provenance path set mismatch'
  }
  foreach ($name in $expectedProvenance) {
    $entry = $result.provenance.$name
    $sourcePath = Resolve-SafeRelativePath -Root $script:CandidatePath -RelativePath ([string]$entry.path) -Label "Duplicate benchmark provenance $name"
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf) -or (Get-Sha256File $sourcePath) -ne [string]$entry.sha256) {
      throw "Duplicate benchmark provenance mismatch: $($entry.path)"
    }
  }
  $resultProvenance = $result.provenance | ConvertTo-Json -Compress -Depth 8
  $manifestProvenance = $manifest.provenance | ConvertTo-Json -Compress -Depth 8
  if ($resultProvenance -ne $manifestProvenance) { throw 'Duplicate benchmark manifest provenance mismatch' }
}

function Assert-QueueBenchmarkEvidence {
  param([string]$EvidencePath = (Join-Path $script:EvidenceRoot 'benchmarks\queue-virtualization.json'))
  $result = Get-Content -LiteralPath $EvidencePath -Raw | ConvertFrom-Json
  if ([int]$result.schemaVersion -ne 2 -or
      [string]$result.runner.implementation -ne 'src/renderer/src/utils/playbackQueueVirtualization.ts' -or
      -not [bool]$result.runner.gcExposed -or
      [int]$result.runner.rowHeight -ne 54 -or
      [int]$result.runner.viewportHeight -ne 324 -or
      [int]$result.runner.overscan -ne 6) {
    throw 'Queue benchmark schema/implementation mismatch'
  }
  $scenarios = @($result.scenarios)
  if ($scenarios.Count -ne 2 -or ($scenarios.queueLength -join ',') -ne '5000,20000') { throw 'Queue benchmark size matrix mismatch' }
  foreach ($scenario in $scenarios) {
    if (@($scenario.snapshotMetrics.samplesMs).Count -ne 3 -or
        @($scenario.windowMetrics.samplesMs).Count -ne 3 -or
        [int]$scenario.limits.mountedRows -ne 18 -or
        [double]$scenario.limits.snapshotP95Ms -ne [Math]::Max(16, [double]$scenario.queueLength / 1000 * 4) -or
        [double]$scenario.limits.windowP95Ms -ne 8 -or
        [int64]$scenario.limits.windowHeapDeltaBytes -ne 8388608 -or
        [int64]$scenario.limits.snapshotHeavyBytes -ne 0) {
      throw "Queue benchmark execution contract mismatch for $($scenario.queueLength) rows"
    }
    $snapshotP95 = Assert-FiniteNonNegativeNumber $scenario.snapshotMetrics.p95Ms 'queue snapshot p95'
    $windowP95 = Assert-FiniteNonNegativeNumber $scenario.windowMetrics.p95Ms 'queue window p95'
    $heap = Assert-FiniteNonNegativeNumber $scenario.windowMetrics.maxHeapDeltaBytes 'queue window heap'
    if ($snapshotP95 -ne (Get-NearestRankPercentile -Samples @($scenario.snapshotMetrics.samplesMs) -Quantile 0.95 -Label 'queue snapshot p95') -or
        $windowP95 -ne (Get-NearestRankPercentile -Samples @($scenario.windowMetrics.samplesMs) -Quantile 0.95 -Label 'queue window p95') -or
        $snapshotP95 -gt [double]$scenario.limits.snapshotP95Ms -or
        $windowP95 -gt [double]$scenario.limits.windowP95Ms -or
        $heap -gt [double]$scenario.limits.windowHeapDeltaBytes -or
        [int64]$scenario.snapshotHeavyBytes -ne [int64]$scenario.limits.snapshotHeavyBytes) {
      throw "Queue benchmark budget mismatch for $($scenario.queueLength) rows"
    }
  }
}

function Assert-PersistenceBenchmarkEvidence {
  param([string]$EvidencePath = (Join-Path $script:EvidenceRoot 'benchmarks\persistence.json'))
  $result = Get-Content -LiteralPath $EvidencePath -Raw | ConvertFrom-Json
  if ([int]$result.schemaVersion -ne 1 -or [int]$result.methodology.iterations -ne 7 -or -not [bool]$result.host.gcExposed) {
    throw 'Persistence benchmark schema/methodology mismatch'
  }
  $scenarios = @($result.scenarios)
  if ($scenarios.Count -ne 3 -or ($scenarios.trackCount -join ',') -ne '5000,20000,50000') {
    throw 'Persistence benchmark size matrix mismatch'
  }
  $workload = $result.methodology.workload
  if (($workload.localTrackCounts -join ',') -ne '5000,20000,50000' -or
      [int]$workload.playlistCount -ne 100 -or
      [int]$workload.tracksPerPlaylist -ne 500 -or
      [int]$workload.sessionQueueEntries -ne 20000 -or
      [int]$workload.listeningStatsEntries -ne 1000 -or
      [string]$result.methodology.percentile -ne 'nearest-rank') {
    throw 'Persistence benchmark workload contract mismatch'
  }
  $runnerPath = Join-Path $script:CandidatePath 'scripts\persistence-benchmark.cjs'
  if ([string]$result.provenance.scriptSha256 -ne (Get-Sha256File $runnerPath)) {
    throw 'Persistence benchmark runner hash mismatch'
  }
  foreach ($scenario in $scenarios) {
    foreach ($backendName in @('json', 'sqlite')) {
      $backend = $scenario.$backendName
      foreach ($property in $backend.PSObject.Properties) {
        if ($property.Name -match '(parse|write|load|seed|serialize|recovery)' -and $property.Value -and $property.Value.PSObject.Properties['p95Ms']) {
          [void](Assert-FiniteNonNegativeNumber $property.Value.p95Ms "persistence $backendName $($property.Name) p95")
        }
      }
    }
  }
}

function Assert-MandatoryStageCoverage {
  param([switch]$ExcludeCoverageStage)
  $expected = @($script:StagePlan | ForEach-Object { [string]$_.id })
  if ($ExcludeCoverageStage) { $expected = @($expected | Where-Object { $_ -ne 'mandatory-stage-coverage' }) }
  $bound = @{}
  if (Test-Path -LiteralPath $script:ResultsPath -PathType Leaf) {
    foreach ($line in [System.IO.File]::ReadAllLines($script:ResultsPath, $script:Utf8NoBom)) {
      if (-not $line.Trim()) { continue }
      $record = $line | ConvertFrom-Json
      if ([string]$record.planDigest -eq $script:PlanDigest) { $bound[[string]$record.id] = $record }
    }
  }
  $actual = @($bound.Keys | Sort-Object)
  $expectedSorted = @($expected | Sort-Object)
  if (($actual -join "`n") -ne ($expectedSorted -join "`n")) {
    throw "Bound gate stage set is not exact; expected=[$($expectedSorted -join ',')]; actual=[$($actual -join ',')]"
  }
  foreach ($id in $expectedSorted) {
    $record = Get-LatestBoundStageResult $id
    if ($null -eq $record -or [int]$record.exitCode -ne 0) { throw "Mandatory stage is not proven passing: $id" }
  }
}

function Initialize-NativeBuildDirectory {
  param([Parameter(Mandatory = $true)][string]$Path)

  $nativePath = [System.IO.Path]::GetFullPath($Path)
  if ($nativePath -match '\s') { throw 'NativeBuildDir must not contain whitespace' }
  Assert-FixedExternalLeaf -Path $nativePath -ExpectedLeaf $script:NativeLeafName -Label 'NativeBuildDir'
  if (Test-Path -LiteralPath $nativePath) {
    if (-not (Test-Path -LiteralPath $nativePath -PathType Container)) {
      throw "NativeBuildDir exists but is not an owned directory: $nativePath"
    }
    $owner = Read-ValidatedOwnerMarker -Root $nativePath -Kind native
    if ([string]$owner.planDigest -eq $script:PlanDigest) {
      if (-not $Resume) { throw "NativeBuildDir is already owned by the current gate plan; use -Resume: $nativePath" }
    } else {
      $archivePath = Join-Path $script:ExternalToolRoot "failed-$($script:NativeLeafName)-$($script:RunId)"
      if (Test-Path -LiteralPath $archivePath) { throw "Native archive path exists: $archivePath" }
      Assert-DirectPhysicalChild -Parent $script:ExternalToolRoot -Child $archivePath -Label 'Native owned archive'
      Move-Item -LiteralPath $nativePath -Destination $archivePath
      [void](Rebind-ArchivedOwnerMarker -Root $archivePath -Kind native -PreviousOwner $owner)
    }
  }
  [System.IO.Directory]::CreateDirectory($script:ExternalToolRoot) | Out-Null
  [System.IO.Directory]::CreateDirectory($nativePath) | Out-Null
  if (-not (Test-Path -LiteralPath (Get-OwnerMarkerPath $nativePath))) {
    Write-OwnerMarker -Root $nativePath -Kind native -SourceManifestSha256 $script:SourceManifestSha256 -PlanDigest $script:PlanDigest
  }
  [void](Read-ValidatedOwnerMarker -Root $nativePath -Kind native -RequireCurrentPlan)
  return $nativePath
}

function Invoke-NativeGate {
  if (-not $NativeBuildDir) { throw 'NativeBuildDir is required for the complete integrated gate' }
  $nativePath = Initialize-NativeBuildDirectory -Path $NativeBuildDir
  $env:TAE_MINGW_BUILD_DIR = $nativePath
  Invoke-GateStage -Id 'native-configure' -Command 'corepack pnpm@11.7.0 run configure:audio-engine:mingw' -TimeoutSeconds 1800
  Invoke-GateStage -Id 'native-build' -Command 'corepack pnpm@11.7.0 run build:audio-engine:mingw' -TimeoutSeconds 2400
  Invoke-GateStage -Id 'native-ctest-list' -Command 'ctest --test-dir "%TAE_MINGW_BUILD_DIR%" -N' -TimeoutSeconds 300
  Invoke-GateStage -Id 'native-ctest-21' -Command 'ctest --test-dir "%TAE_MINGW_BUILD_DIR%" --output-on-failure' -TimeoutSeconds 2400
  Invoke-InternalStage -Id 'native-ctest-evidence-check' -Action {
    $listRecord = Get-LatestBoundStageResult 'native-ctest-list'
    $runRecord = Get-LatestBoundStageResult 'native-ctest-21'
    if ($null -eq $listRecord -or $null -eq $runRecord) { throw 'Bound native CTest records are missing' }
    $listLog = Resolve-SafeRelativePath -Root $script:CandidatePath -RelativePath ([string]$listRecord.log) -Label 'Native CTest list log'
    $runLog = Resolve-SafeRelativePath -Root $script:CandidatePath -RelativePath ([string]$runRecord.log) -Label 'Native CTest run log'
    $listText = Get-Content -LiteralPath $listLog -Raw
    $runText = Get-Content -LiteralPath $runLog -Raw
    $cmakeSource = Get-Content -LiteralPath (Join-Path $script:CandidatePath 'audio-engine\CMakeLists.txt') -Raw
    $nativeTestCount = [regex]::Matches($cmakeSource, 'add_test\(\s*NAME\s+twilight_[a-z0-9_]+').Count
    if ($nativeTestCount -le 0 -or $listText -notmatch "Total Tests:\s*$nativeTestCount\b") {
      throw "CTest -N did not enumerate all $nativeTestCount registered tests"
    }
    if ($runText -notmatch "100% tests passed(?:, 0 tests failed)? out of $nativeTestCount\b") {
      throw "CTest execution did not report $nativeTestCount/$nativeTestCount passing"
    }
  }
}

function Finalize-Evidence {
  if (-not $script:EvidenceRoot -or -not (Test-Path -LiteralPath $script:EvidenceRoot)) { return }
  Assert-GateOperationalRoots
  $allResults = @()
  if (Test-Path -LiteralPath $script:ResultsPath -PathType Leaf) {
    $allResults = @(
      [System.IO.File]::ReadAllLines($script:ResultsPath, $script:Utf8NoBom) |
        Where-Object { $_.Trim() } |
        ForEach-Object { $_ | ConvertFrom-Json }
    )
  }
  $latestById = @{}
  foreach ($result in $allResults) { $latestById[[string]$result.id] = $result }
  $latest = @($latestById.Values | Sort-Object id)
  $failed = @($latest | Where-Object { [int]$_.exitCode -ne 0 })
  $summary = [pscustomobject]@{
    schemaVersion = 1
    candidate = $CandidateName
    candidatePath = $script:CandidatePath
    sourceManifestSha256 = $script:SourceManifestSha256
    startedAtUtc = $script:GateStartedAtUtc.ToString('o')
    finishedAtUtc = [DateTime]::UtcNow.ToString('o')
    status = $script:FinalStatus
    error = $script:FinalError
    stageCount = $latest.Count
    passedStages = @($latest | Where-Object { [int]$_.exitCode -eq 0 }).Count
    failedStages = $failed.Count
    latestResults = $latest
  }
  Write-JsonFile -Path (Join-Path $script:EvidenceRoot 'gate-summary.json') -Value $summary -Depth 12

  $excludedNames = @('evidence-manifest.json', 'evidence-manifest.sha256')
  $evidenceFiles = @(
    Get-ChildItem -LiteralPath $script:EvidenceRoot -Recurse -File |
      Where-Object { $excludedNames -notcontains $_.Name } |
      ForEach-Object {
        [pscustomobject]@{
          path = Get-RelativePath -Root $script:CandidatePath -Path $_.FullName
          size = [int64]$_.Length
          sha256 = Get-Sha256File $_.FullName
        }
      }
    Get-ChildItem -LiteralPath $script:LogsRoot -Recurse -File |
      ForEach-Object {
        [pscustomobject]@{
          path = Get-RelativePath -Root $script:CandidatePath -Path $_.FullName
          size = [int64]$_.Length
          sha256 = Get-Sha256File $_.FullName
        }
      }
  ) | Sort-Object path -Unique
  $manifest = [pscustomobject]@{
    schemaVersion = 1
    candidate = $CandidateName
    createdAtUtc = [DateTime]::UtcNow.ToString('o')
    sourceManifestSha256 = $script:SourceManifestSha256
    fileCount = $evidenceFiles.Count
    recordsDigestSha256 = Get-RecordsDigest $evidenceFiles
    files = $evidenceFiles
  }
  $manifestPath = Join-Path $script:EvidenceRoot 'evidence-manifest.json'
  Write-JsonFile -Path $manifestPath -Value $manifest -Depth 15
  Write-Utf8File -Path (Join-Path $script:EvidenceRoot 'evidence-manifest.sha256') -Text ((Get-Sha256File $manifestPath) + " *evidence-manifest.json`n")
}

function Show-DryRunPlan {
  $planCandidate = if ($CandidateName) { $CandidateName } else { 'final-integrated-<UTC timestamp>' }
  $plan = [pscustomobject]@{
    dryRun = $true
    sourceRoot = $script:SourceRoot
    outputRoot = $script:OutputRoot
    candidateName = $planCandidate
    resume = [bool]$Resume
    archiveInvalidCandidateName = $ArchiveInvalidCandidateName
    electronDistOverride = $ElectronDistOverride
    nativeBuildDir = $NativeBuildDir
    sourceExclusions = @('.git', 'node_modules', 'out', 'dist', 'build', 'temp', 'tmp', 'log', 'logs', 'Testing/Temporary', 'electron.vite.config.<timestamp>.mjs')
    stages = Get-FullStagePlan
  }
  $plan | ConvertTo-Json -Depth 8
}

if ($script:OutputRoot.StartsWith((Get-PathWithSeparator $script:SourceRoot), [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'OutputRoot must be outside the source repository'
}
if ($CandidateName) { Assert-SafeLeafName -Name $CandidateName -Label 'CandidateName' }
if ($Resume -and -not $CandidateName) { throw '-Resume requires an explicit -CandidateName' }
if ($DryRun) {
  Show-DryRunPlan
  return
}
if (-not $CandidateName) { $CandidateName = "final-integrated-$([DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))" }
Assert-SafeLeafName -Name $CandidateName -Label 'CandidateName'

$script:CandidatePath = [System.IO.Path]::GetFullPath((Join-Path $script:OutputRoot $CandidateName))
Assert-PathIsChild -Parent $script:OutputRoot -Child $script:CandidatePath -Label 'Candidate'
$script:EvidenceRoot = Join-Path $script:CandidatePath 'evidence'
$script:LogsRoot = Join-Path $script:CandidatePath 'logs'
$script:ResultsPath = Join-Path $script:EvidenceRoot 'gate-results.ndjson'
$script:SourceManifestPath = Join-Path $script:EvidenceRoot 'source-manifest.json'

try {
  Assert-CriticalPathPolicy
  [System.IO.Directory]::CreateDirectory($script:OutputRoot) | Out-Null
  if ($Resume) {
    Initialize-ResumeCandidate
  } else {
    Initialize-NewCandidate
  }
  Assert-GateOperationalRoots
  Initialize-PlanBinding
  Initialize-GateEnvironment
  Write-JsonFile -Path (Join-Path $script:EvidenceRoot 'gate-plan.json') -Value $script:StagePlan -Depth 8
  Invoke-InternalStage -Id 'source-manifest-verify-before-gate' -Action {
    $manifest = Get-Content -LiteralPath $script:SourceManifestPath -Raw | ConvertFrom-Json
    Assert-CandidateMatchesManifest $manifest
    Assert-SourceMatchesManifest $manifest
  }

  foreach ($stage in Get-GatePlan) {
    Invoke-GateStage -Id $stage.id -Command $stage.command -TimeoutSeconds $stage.timeout
    if ($stage.id -eq 'pnpm-install') { Initialize-ElectronOverride }
    if ($stage.id -eq 'test-persistence-benchmark-after-live') {
      Invoke-InternalStage -Id 'benchmark-persistence-evidence' -Action { Assert-PersistenceBenchmarkEvidence }
    } elseif ($stage.id -eq 'test-duplicate-benchmark-after-live') {
      Invoke-InternalStage -Id 'benchmark-duplicate-evidence' -Action { Assert-DuplicateBenchmarkEvidence }
    } elseif ($stage.id -eq 'test-queue-benchmark-after-live') {
      Invoke-InternalStage -Id 'benchmark-queue-evidence' -Action { Assert-QueueBenchmarkEvidence }
    }
  }

  Invoke-NativeGate
  Invoke-InternalStage -Id 'candidate-source-verify-after-gate' -Action {
    Assert-GateOperationalRoots
    $manifest = Get-Content -LiteralPath $script:SourceManifestPath -Raw | ConvertFrom-Json
    Assert-CandidateMatchesManifest $manifest
  }
  Invoke-InternalStage -Id 'main-source-verify-after-gate' -Action {
    $manifest = Get-Content -LiteralPath $script:SourceManifestPath -Raw | ConvertFrom-Json
    Assert-SourceMatchesManifest $manifest
  }
  Invoke-InternalStage -Id 'mandatory-stage-coverage' -Action {
    Assert-MandatoryStageCoverage -ExcludeCoverageStage
  }
  Assert-MandatoryStageCoverage
  $script:FinalStatus = 'passed'
} catch {
  $script:FinalStatus = 'failed'
  $script:FinalError = $_.Exception.ToString()
  throw
} finally {
  Finalize-Evidence
}
