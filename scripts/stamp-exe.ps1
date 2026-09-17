# Stamp the DeckBridge icon + Win32 version info into a PE executable (rcedit).
# Version comes from ts/package.json, the single source of truth (sync-version.mjs).
#
# Usage: ./scripts/stamp-exe.ps1 -Target path\to.exe -Rcedit path\to\rcedit.exe
param(
  [Parameter(Mandatory = $true)][string]$Target,
  [string]$Rcedit = "rcedit.exe"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path $Target)) { Write-Error "stamp-exe: missing target $Target"; exit 1 }

$ver = (Get-Content (Join-Path $root "ts/package.json") -Raw | ConvertFrom-Json).version
$ico = Join-Path $root "src-tauri/icons/icon.ico"

& $Rcedit $Target `
  --set-icon $ico `
  --set-file-version "$ver.0" `
  --set-product-version "$ver.0" `
  --set-version-string "ProductName" "DeckBridge" `
  --set-version-string "FileDescription" "DeckBridge - Stream Deck to Elgato relay" `
  --set-version-string "CompanyName" "DeckBridge" `
  --set-version-string "LegalCopyright" "MIT License"

if ($LASTEXITCODE -ne 0) { Write-Error "stamp-exe: rcedit failed on $Target"; exit 1 }
Write-Host "stamp-exe: $Target <- icon + v$ver"
