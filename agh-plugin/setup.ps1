param(
  [string]$AgnesCli = 'D:\黑客松\agh\dist\agnes.mjs'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $AgnesCli -PathType Leaf)) {
  throw 'AGH CLI was not found. Pass its installed agnes.mjs path with -AgnesCli.'
}

$node = (Get-Command node -ErrorAction Stop).Source
if ([string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
  throw 'USERPROFILE is unavailable; refusing to use the existing default AGH home.'
}
$photoCadHome = Join-Path $env:USERPROFILE '.agh-photo-cad'
$env:AGH_HOME = $photoCadHome
Remove-Item Env:AGNES_HOME -ErrorAction SilentlyContinue
Write-Host 'Opening the official AGH configuration wizard in the separate .agh-photo-cad home and built-in local-dev profile.'
Write-Host 'Choose Agnes AI and an Agnes Flash chat model in the wizard. Keep the built-in China endpoint for a China key; for an international key use the official Base URL https://apihub.agnes-ai.com/v1 and let AGH verify it.'
Write-Host 'Your key is entered directly in AGH and is never printed by this script.'
Write-Host 'This creates a private per-user AGH home without using your existing .agh home.'
& $node $AgnesCli config --profile local-dev
if ($LASTEXITCODE -ne 0) {
  throw "AGH configuration ended with exit code $LASTEXITCODE. No key or wizard output was captured by this script."
}
