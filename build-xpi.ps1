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

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$version = [string]$manifest.version
if ([string]::IsNullOrWhiteSpace($version)) {
  throw "Keine gueltige Version in manifest.json gefunden."
}

$resolvedOutputDir = [System.IO.Path]::GetFullPath((Join-Path $addonRoot $OutputDir))
New-Item -ItemType Directory -Path $resolvedOutputDir -Force | Out-Null

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("aniskipper-build-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null

try {
  $includePaths = @(
    "manifest.json",
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

  $destinationXpi = Join-Path $resolvedOutputDir ("AniSkipper-" + $version + ".xpi")
  $destinationZip = Join-Path $resolvedOutputDir ("AniSkipper-" + $version + ".zip")

  if (Test-Path -LiteralPath $destinationXpi) {
    Remove-Item -LiteralPath $destinationXpi -Force
  }
  if (Test-Path -LiteralPath $destinationZip) {
    Remove-Item -LiteralPath $destinationZip -Force
  }

  Compress-Archive -Path (Join-Path $tempRoot "*") -DestinationPath $destinationZip -CompressionLevel Optimal
  Move-Item -LiteralPath $destinationZip -Destination $destinationXpi -Force
  Write-Output ("XPI erstellt: " + $destinationXpi)
}
finally {
  if (Test-Path -LiteralPath $tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force
  }
}
