import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execute = promisify(execFile)

async function powershell(script: string): Promise<unknown> {
  const result = await execute(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')
    ],
    { windowsHide: true, timeout: 8000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }
  )
  return JSON.parse(result.stdout.replace(/^\uFEFF/, ''))
}

export async function collectWindowsModules(ids: number[]): Promise<unknown> {
  const safeIds = [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, 64)
  if (!safeIds.length) return []
  return powershell(`$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$records=@(); foreach ($targetId in @(${safeIds.join(',')})) {
  try { $p=Get-Process -Id $targetId; $modules=@($p.Modules | ForEach-Object { @{name=$_.ModuleName; path=$_.FileName; version=$_.FileVersionInfo.FileVersion; baseAddress=('0x{0:x}' -f $_.BaseAddress.ToInt64()); size=$_.ModuleMemorySize} }); $records+=@{processId=$targetId; status='ok'; modules=$modules} }
  catch { $records+=@{processId=$targetId; status='failed'; error=$_.Exception.Message} }
}; ConvertTo-Json -InputObject $records -Depth 6 -Compress`)
}

export async function collectWindowsCrashEvents(since: string, ids: number[]): Promise<unknown> {
  const time = new Date(since).toISOString()
  const safeIds = ids.filter((id) => Number.isSafeInteger(id) && id > 0)
  return powershell(`[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$result=@{status='ok'; events=@()}; $wanted=@(${safeIds.join(',')});
try { $records=@(Get-WinEvent -FilterHashtable @{LogName='Application';ProviderName='Application Error';Id=1000;StartTime=[datetime]'${time}'} -ErrorAction Stop)
foreach ($r in $records) { [xml]$xml=$r.ToXml(); $fields=@{}; foreach($d in $xml.Event.EventData.Data){$fields[[string]$d.Name]=[string]$d.InnerText};
$targetId=0; try { $targetId=[Convert]::ToInt32(($fields.ProcessId -replace '^0x',''),16) } catch {}
if (($fields.AppName -match '^Twilight\\s*Echo\\.exe$') -or ($wanted -contains $targetId)) {
$result.events+=@{timestamp=$r.TimeCreated.ToUniversalTime().ToString('o'); processId=$targetId; application=$fields.AppName; applicationVersion=$fields.AppVersion; applicationPath=$fields.AppPath; module=$fields.ModuleName; modulePath=$fields.ModulePath; moduleVersion=$fields.ModuleVersion; exceptionCode=$fields.ExceptionCode; faultingOffset=$fields.FaultingOffset}
} }
} catch { $result.status=if($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*'){'no-events'}else{'failed'}; if($result.status -eq 'failed'){$result.error=$_.Exception.Message} }
try{$v=Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion';$result.windows=@{build=$v.CurrentBuildNumber;revision=$v.UBR;displayVersion=$v.DisplayVersion}}catch{$result.windowsError=$_.Exception.Message}
$result | ConvertTo-Json -Depth 6 -Compress`)
}
