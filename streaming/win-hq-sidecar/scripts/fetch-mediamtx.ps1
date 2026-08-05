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
# 1.19.1, NICHT 1.18.1: Dev-Compose und Produktion fahren beide
# "pulse-mediamtx:1.19.1-pulse". Mit 1.18.1 testete man lokal gegen einen
# Empfaenger, der sich anders verhaelt als der echte - bei AV1 lehnte 1.18.1 den
# Strom mit "unable to parse AV1 sequence header: not enough bytes" komplett ab,
# 1.19.1 nimmt ihn an. Wer das nicht weiss, haelt einen funktionierenden Encoder
# fuer kaputt (2026-07-30 genau so passiert).
#
# Diese Datei absichtlich ASCII-rein halten: PowerShell 5.1 liest .ps1 als ANSI,
# ein UTF-8-Sonderzeichen wird dann zu einem Smart-Quote und kann den Parser
# zerlegen - genau daran scheiterte scripts/fetch-ffmpeg.ps1 unter 5.1.
$Version = 'v1.19.1'
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
