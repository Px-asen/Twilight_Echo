param(
  [ValidateRange(1, 720)][int]$Hours = 168,
  [string]$OutputPath
)

# Read-only support collection. No service restart, registry write, or upload.
# Keep this file ASCII so it also runs under Windows PowerShell 5.1.
function ConvertTo-TwilightCrashEvent {
  param([Parameter(Mandatory = $true)][xml]$EventXml)

  $fields = @{}
  foreach ($item in $EventXml.Event.EventData.Data) {
    $fields[[string]$item.Name] = [string]$item.InnerText
  }
  $appName = [IO.Path]::GetFileName($fields['AppName'])
  $moduleName = [IO.Path]::GetFileName($fields['ModuleName'])
  $isTwilight = $appName -match '^Twilight\s*Echo\.exe$'
  $isNativeHost = $appName -in @('node.exe', 'electron.exe') -and (
    $moduleName -match '^twilight[-_]' -or
    $fields['AppPath'] -match '[\\/]Twilight[ -]?Echo[\\/]'
  )
  if (-not ($isTwilight -or $isNativeHost)) { return $null }

  [ordered]@{
    timestamp = [string]$EventXml.Event.System.TimeCreated.SystemTime
    recordId = [string]$EventXml.Event.System.EventRecordID
    application = $appName
    applicationVersion = $fields['AppVersion']
    module = $moduleName
    moduleVersion = $fields['ModuleVersion']
    exceptionCode = $fields['ExceptionCode']
    faultingOffset = $fields['FaultingOffset']
    processId = $fields['ProcessId']
  }
}

function Export-TwilightCrashReport {
  param([int]$LookbackHours, [string]$Destination)

  $since = (Get-Date).AddHours(-$LookbackHours)
  $events = @()
  $eventLogStatus = 'ok'
  try {
    $records = @(Get-WinEvent -FilterHashtable @{
      LogName = 'Application'
      ProviderName = 'Application Error'
      Id = 1000
      StartTime = $since
    } -ErrorAction Stop)
    $events = @($records | ForEach-Object {
      ConvertTo-TwilightCrashEvent -EventXml ([xml]$_.ToXml())
    } | Where-Object { $null -ne $_ })
  } catch {
    if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') {
      $eventLogStatus = 'no-events'
    } else {
      $eventLogStatus = 'unavailable'
    }
  }

  $windows = $null
  try {
    $version = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction Stop
    $windows = [ordered]@{
      displayVersion = $version.DisplayVersion
      build = $version.CurrentBuildNumber
      revision = $version.UBR
    }
  } catch {
    # A failed optional OS query does not discard the crash events.
  }

  $report = [ordered]@{
    schemaVersion = 1
    generatedAt = [DateTime]::UtcNow.ToString('o')
    since = $since.ToUniversalTime().ToString('o')
    windows = $windows
    eventLogStatus = $eventLogStatus
    events = $events
  }
  $json = $report | ConvertTo-Json -Depth 6
  $fullPath = [IO.Path]::GetFullPath($Destination)
  [IO.File]::WriteAllText($fullPath, $json, [Text.UTF8Encoding]::new($false))
  Write-Output "Saved $($events.Count) matching crash event(s): $fullPath"
  if ($eventLogStatus -eq 'unavailable') {
    Write-Warning 'The Windows Application event log could not be read. The report records this failure.'
  } elseif ($events.Count -eq 0) {
    Write-Output 'No matching crash event was found. Reproduce the audio failure and run this script again.'
  }
}

if ($MyInvocation.InvocationName -ne '.') {
  if (-not $OutputPath) {
    $OutputPath = Join-Path $PSScriptRoot ("TwilightEcho-windows-crash-{0}.json" -f [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff'))
  }
  Export-TwilightCrashReport -LookbackHours $Hours -Destination $OutputPath
}
