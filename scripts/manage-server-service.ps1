#requires -Version 7.0
param(
  [ValidateSet('Plan', 'Install', 'Start', 'Stop', 'Status', 'Remove')]
  [string]$Action = 'Plan',
  [Parameter(Mandatory = $true)][string]$Data,
  [string]$Name = 'TwilightEchoServer',
  [string]$Node = (Get-Command node -ErrorAction Stop).Source,
  [string]$Application = (Split-Path $PSScriptRoot -Parent),
  [switch]$Apply,
  [switch]$GrantProfileAccess
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($env:OS -ne 'Windows_NT') { throw 'Windows Service 管理脚本只支持 Windows。' }
if ($Name -notmatch '^[A-Za-z0-9_-]{1,128}$') { throw '服务名称只能包含字母、数字、下划线和短横线。' }
foreach ($path in @($Data, $Node, $Application)) {
  if (-not [IO.Path]::IsPathFullyQualified($path)) { throw "必须使用绝对路径：$path" }
}
if ($Data.TrimEnd('\') -eq [IO.Path]::GetPathRoot($Data).TrimEnd('\')) { throw '数据目录不能是磁盘或共享根目录。' }
$Data = [IO.Path]::GetFullPath($Data).TrimEnd('\')
$Application = [IO.Path]::GetFullPath($Application).TrimEnd('\')
$Node = [IO.Path]::GetFullPath($Node)
$hostExe = Join-Path $Application 'out\server-service\twilight-server-service.exe'
$entry = Join-Path $Application 'out\server\server.cjs'
$profile = Join-Path $Data 'server.json'
foreach ($path in @($Data, $Node, $hostExe, $entry, $profile)) {
  if (-not (Test-Path -LiteralPath $path)) { throw "文件或目录不存在：$path" }
}
if ((Get-Content -LiteralPath $profile -Raw | ConvertFrom-Json).version -ne 1) { throw '请先使用 Server init 创建独立数据目录。' }

# SCM stores one Windows command line. Match the native host's CRT argument quoting.
function Quote-Argument([string]$Value) {
  return '"' + ([regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1')) + '"'
}
$binPath = (@($hostExe, '--node', $Node, '--entry', $entry, '--data', $Data, '--service-name', $Name) |
  ForEach-Object { Quote-Argument $_ }) -join ' '
$plan = [ordered]@{
  action = $Action; serviceName = $Name; account = 'NT AUTHORITY\LocalService'; start = 'demand'
  binaryPath = $binPath; data = $Data; log = (Join-Path $Data 'server-service.log')
  bridgeOnly = $true; grantProfileAccess = $GrantProfileAccess.IsPresent
  changesApplied = $false
  prerequisites = @('服务账号必须能读取应用、Node、依赖及音乐目录；不自动修改这些目录。',
    '数据目录保存 TLS 私钥与管理令牌；安装前须限制为管理员、管理用户及 LocalService 可访问。GrantProfileAccess 仅适用于刚 init、尚未启动的目录。',
    '使用管理员 PowerShell 明确指定 -Action Install -Apply 才会注册服务；不自动启动。')
}
if ($Action -eq 'Plan' -or ($Action -ne 'Status' -and -not $Apply)) {
  $plan | ConvertTo-Json -Depth 5
  exit 0
}
function Invoke-Sc([string[]]$Arguments) {
  & "$env:SystemRoot\System32\sc.exe" @Arguments
  if ($LASTEXITCODE -ne 0) { throw "SCM 操作失败，退出码 $LASTEXITCODE" }
}
if ($Action -eq 'Status') {
  Invoke-Sc -Arguments @('queryex', $Name)
  & $Node $entry status --data $Data
  exit $LASTEXITCODE
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw '此操作需要管理员 PowerShell。' }
switch ($Action) {
  'Install' {
    if (Get-Service -Name $Name -ErrorAction SilentlyContinue) { throw '同名服务已存在；不覆盖其配置。' }
    $savedAcl = $null
    if ($GrantProfileAccess) {
      $item = Get-Item -LiteralPath $Data
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
          $Data.Equals($Application, [StringComparison]::OrdinalIgnoreCase) -or
          $Application.StartsWith($Data + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw '只能修改独立、非链接的数据目录权限，不能修改应用目录或其父目录。'
      }
      if (Test-Path -LiteralPath (Join-Path $Data 'server.lock')) { throw '请先停止 Server，再设置数据目录权限。' }
      $contents = @(Get-ChildItem -LiteralPath $Data -Force)
      if ($contents.Count -ne 1 -or $contents[0].Name -ne 'server.json' -or
          @((Get-Acl -LiteralPath $profile).Access | Where-Object { -not $_.IsInherited }).Count) {
        throw '自动授权只接受刚 init 且 server.json 仍继承目录权限的独立目录；已有数据需由管理员明确配置权限。'
      }
      $savedAcl = Get-Acl -LiteralPath $Data
      $savedAcl.Sddl | Set-Content -LiteralPath (Join-Path $Data 'server-service-acl.sddl') -NoClobber
      $acl = Get-Acl -LiteralPath $Data
      $acl.SetAccessRuleProtection($true, $false)
      foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
      foreach ($sid in @('S-1-5-18', 'S-1-5-32-544', $identity.User.Value, 'S-1-5-19') | Select-Object -Unique) {
        $rights = if ($sid -eq 'S-1-5-19') { 'Modify' } else { 'FullControl' }
        $rule = [Security.AccessControl.FileSystemAccessRule]::new(
          [Security.Principal.SecurityIdentifier]::new($sid), $rights, 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
      }
      Set-Acl -LiteralPath $Data -AclObject $acl
    }
    try {
      Invoke-Sc -Arguments @('create', $Name, 'binPath=', $binPath, 'start=', 'demand', 'obj=', 'NT AUTHORITY\LocalService', 'DisplayName=', 'Twilight Echo Server')
    } catch {
      if ($savedAcl) { Set-Acl -LiteralPath $Data -AclObject $savedAcl }
      throw
    }
    Write-Output '服务已注册，尚未启动。使用 -Action Start -Apply 启动；使用 Status 检查 Core 就绪状态。'
  }
  'Start' { Invoke-Sc -Arguments @('start', $Name) }
  'Stop' { Invoke-Sc -Arguments @('stop', $Name) }
  'Remove' {
    $service = Get-Service -Name $Name
    if ($service.Status -ne 'Stopped') { throw '请先正常停止服务，再移除注册。' }
    Invoke-Sc -Arguments @('delete', $Name)
    Write-Output '服务注册已移除，数据和权限保留。'
  }
}
