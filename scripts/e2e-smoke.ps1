$relay = if (Test-Path "deckbridge.exe") { "deckbridge.exe" } else { "deckbridge" }
Remove-Item Env:DECKBRIDGE_MOCK -ErrorAction SilentlyContinue
$proc = Start-Process -FilePath ".\$relay" -PassThru `
  -RedirectStandardOutput "smoke-stdout.log" -RedirectStandardError "smoke-stderr.log"
$webuiPort = $null
for ($i = 0; $i -lt 60; $i++) {
  $match = Select-String -Path "smoke-stdout.log" `
    -Pattern 'WebUI: http://localhost:(\d+)' -AllMatches `
    -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($match) { $webuiPort = [int]$match.Matches[0].Groups[1].Value; break }
  if ($proc.HasExited) {
    Write-Host "FAIL: process exited before logging WebUI port"
    Get-Content smoke-stdout.log -ErrorAction SilentlyContinue
    Get-Content smoke-stderr.log -ErrorAction SilentlyContinue
    exit 1
  }
  Start-Sleep -Milliseconds 250
}
if (-not $webuiPort) {
  Write-Host "FAIL: WebUI port never appeared in startup log"
  Get-Content smoke-stdout.log -ErrorAction SilentlyContinue
  Get-Content smoke-stderr.log -ErrorAction SilentlyContinue
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  exit 1
}
$baseUrl = "http://localhost:$webuiPort"
$state = $null
for ($i = 0; $i -lt 60; $i++) {
  try {
    $state = Invoke-RestMethod -Uri "$baseUrl/api/state" -TimeoutSec 2
    break
  } catch {}
  if ($proc.HasExited) {
    Write-Host "FAIL: process exited before API became ready"
    Get-Content smoke-stdout.log -ErrorAction SilentlyContinue
    Get-Content smoke-stderr.log -ErrorAction SilentlyContinue
    exit 1
  }
  Start-Sleep -Milliseconds 500
}
if ($null -eq $state) {
  Write-Host "FAIL: /api/state never responded"
  Get-Content smoke-stdout.log -ErrorAction SilentlyContinue
  Get-Content smoke-stderr.log -ErrorAction SilentlyContinue
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  exit 1
}
if ($state.driverMode -ne "real") { throw "release started outside real mode" }
$mockRoute = Invoke-WebRequest -Method Post -Uri "$baseUrl/api/mock/dial" `
  -Body '{}' -ContentType 'application/json' `
  -UseBasicParsing -SkipHttpErrorCheck -TimeoutSec 15
if ($mockRoute.StatusCode -ne 404) { throw "mock route present in release" }
Write-Host "Smoke test OK: real state API responded; mock route absent"
Stop-Process -Id $proc.Id -Force
