# Laedt das MediaMTX-Windows-Release + entpackt nach `mediamtx-dist/v<ver>/`.
# Idempotent: skipt wenn die Distribution schon da liegt.
#
# Nur fuer lokale Test-Driver-Runs (`examples/test_driver.rs video_only`) -
# Prod nutzt das pinned Container-Image `pulse-mediamtx:1.17.1-pulse`.
#
# Aufruf (vom Sidecar-Root):
#   powershell -ExecutionPolicy Bypass -File scripts/fetch-mediamtx.ps1
#
# Start (mit bundled default-Config, anonym publish auf RTMP :1935):
#   Start-Process mediamtx-dist/v1.18.1/mediamtx.exe `
#     -WorkingDirectory mediamtx-dist/v1.18.1 -WindowStyle Hidden

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SidecarRoot = Split-Path -Parent $ScriptDir
$Version = 'v1.18.1'
$Dist = Join-Path $SidecarRoot 'mediamtx-dist'
$Target = Join-Path $Dist $Version
$Exe = Join-Path $Target 'mediamtx.exe'

if (Test-Path $Exe) {
    Write-Host "[fetch-mediamtx] already at $Exe"
    return
}

if (-not (Test-Path $Dist)) {
    New-Item -ItemType Directory -Path $Dist | Out-Null
}

$Zip = Join-Path $Dist "mediamtx_${Version}_windows_amd64.zip"
$Url = "https://github.com/bluenviron/mediamtx/releases/download/${Version}/mediamtx_${Version}_windows_amd64.zip"

Write-Host "[fetch-mediamtx] downloading $Url"
$ProgressPreference = 'SilentlyContinue'
Invoke-WebRequest -Uri $Url -OutFile $Zip -UseBasicParsing

Write-Host "[fetch-mediamtx] extracting to $Target"
if (Test-Path $Target) {
    Remove-Item -Recurse -Force $Target
}
Expand-Archive -Path $Zip -DestinationPath $Target -Force

if (-not (Test-Path $Exe)) {
    throw "extraction did not produce $Exe"
}

Write-Host "[fetch-mediamtx] done - $Exe"
