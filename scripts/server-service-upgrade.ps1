#requires -Version 7.0
param([Parameter(Mandatory = $true)][ValidateSet('Query', 'Configure', 'CopyProfileAccess')][string]$Operation)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($env:OS -ne 'Windows_NT') { throw '服务入口切换只支持 Windows。' }
$request = $env:TWILIGHT_SERVICE_UPGRADE_REQUEST | ConvertFrom-Json
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$administrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
function Read-Service {
  if ($request.name -notmatch '^[A-Za-z0-9_-]{1,128}$') { throw '服务名称无效。' }
  $service = Get-CimInstance -ClassName Win32_Service -Filter "Name='$($request.name)'"
  if (-not $service) { throw '指定服务不存在，未创建服务。' }
  return $service
}
if ($Operation -eq 'Query') {
  $service = Read-Service
  @{ binaryPath = $service.PathName; state = $service.State; account = $service.StartName; administrator = $administrator } | ConvertTo-Json -Compress
  exit 0
}
if (-not $administrator) { throw '服务入口切换需要管理员 PowerShell。' }
switch ($Operation) {
  'Configure' {
    $service = Read-Service
    if ($service.State -ne 'Stopped' -or -not $service.PathName.Equals($request.expectedPath, [StringComparison]::OrdinalIgnoreCase)) { throw '服务状态或入口已变化，未修改配置。' }
    $result = Invoke-CimMethod -InputObject $service -MethodName Change -Arguments @{ PathName = [string]$request.binaryPath }
    if ($result.ReturnValue -ne 0) { throw "SCM 修改入口失败，返回码 $($result.ReturnValue)" }
  }
  'CopyProfileAccess' {
    foreach ($path in @($request.source, $request.destination)) {
      if (-not [IO.Path]::IsPathFullyQualified($path)) { throw '配置目录必须是绝对路径。' }
      $item = Get-Item -LiteralPath $path
      if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '配置目录必须是实际目录。' }
    }
    if ($request.source.Equals($request.destination, [StringComparison]::OrdinalIgnoreCase)) { throw '只能为新的配置副本复制访问规则。' }
    $source = Get-Acl -LiteralPath $request.source
    $target = Get-Acl -LiteralPath $request.destination
    $target.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($target.Access)) { [void]$target.RemoveAccessRuleSpecific($rule) }
    foreach ($rule in $source.Access) {
      $target.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($rule.IdentityReference, $rule.FileSystemRights, $rule.InheritanceFlags, $rule.PropagationFlags, $rule.AccessControlType))
    }
    Set-Acl -LiteralPath $request.destination -AclObject $target
  }
}
@{ ok = $true } | ConvertTo-Json -Compress
