param(
  [string]$OutputDir = "..\dist"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$addonRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifestPath = Join-Path $addonRoot "manifest.json"

if (-not (Test-Path -LiteralPath $manifestPath)) {
  throw "manifest.json nicht gefunden: $manifestPath"
}

$firefoxManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$version = [string]$firefoxManifest.version
if ([string]::IsNullOrWhiteSpace($version)) {
  throw "Keine gueltige Version in manifest.json gefunden."
}

function Is-HostPattern([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) {
    return $false
  }
  if ($value -eq "<all_urls>") {
    return $true
  }
  return $value -match "://"
}

function Normalize-StringArray([object]$value) {
  if ($null -eq $value) {
    return @()
  }

  if ($value -is [System.Array]) {
    return @($value | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  }

  return @([string]$value)
}

$firefoxPermissions = Normalize-StringArray $firefoxManifest.permissions
$permissionSet = New-Object System.Collections.Generic.HashSet[string]
$hostPermissionSet = New-Object System.Collections.Generic.HashSet[string]

foreach ($entry in $firefoxPermissions) {
  if (Is-HostPattern $entry) {
    [void]$hostPermissionSet.Add($entry)
  } else {
    [void]$permissionSet.Add($entry)
  }
}

if ($firefoxManifest.content_scripts) {
  foreach ($contentScript in $firefoxManifest.content_scripts) {
    if ($contentScript.matches) {
      foreach ($match in (Normalize-StringArray $contentScript.matches)) {
        if (Is-HostPattern $match) {
          [void]$hostPermissionSet.Add($match)
        }
      }
    }
  }
}

$chromeManifest = [ordered]@{
  manifest_version = 3
  name = $firefoxManifest.name
  version = $version
  description = $firefoxManifest.description
  default_locale = $firefoxManifest.default_locale
  icons = $firefoxManifest.icons
  permissions = @($permissionSet)
  host_permissions = @($hostPermissionSet)
  action = [ordered]@{
    default_title = $firefoxManifest.browser_action.default_title
    default_popup = $firefoxManifest.browser_action.default_popup
    default_icon = $firefoxManifest.browser_action.default_icon
  }
  background = [ordered]@{
    service_worker = "background/background.js"
  }
  content_scripts = $firefoxManifest.content_scripts
}

$resolvedOutputDir = [System.IO.Path]::GetFullPath((Join-Path $addonRoot $OutputDir))
New-Item -ItemType Directory -Path $resolvedOutputDir -Force | Out-Null

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("aniskipper-chrome-build-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

try {
  $includePaths = @(
    "popup.html",
    "background",
    "content",
    "icons",
    "_locales",
    "popup"
  )

  foreach ($entry in $includePaths) {
    $source = Join-Path $addonRoot $entry
    if (-not (Test-Path -LiteralPath $source)) {
      throw "Pfad fehlt fuer Build: $source"
    }
    Copy-Item -LiteralPath $source -Destination (Join-Path $tempRoot $entry) -Recurse -Force
  }

  $chromeManifestPath = Join-Path $tempRoot "manifest.json"
  ($chromeManifest | ConvertTo-Json -Depth 30) + "`n" | Set-Content -LiteralPath $chromeManifestPath -Encoding UTF8

  $destinationZip = Join-Path $resolvedOutputDir ("AniSkipper-chrome-" + $version + ".zip")
  if (Test-Path -LiteralPath $destinationZip) {
    Remove-Item -LiteralPath $destinationZip -Force
  }

  Compress-Archive -Path (Join-Path $tempRoot "*") -DestinationPath $destinationZip -CompressionLevel Optimal
  Write-Output ("Chrome ZIP erstellt: " + $destinationZip)
}
finally {
  if (Test-Path -LiteralPath $tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force
  }
}
