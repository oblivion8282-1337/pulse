# Lädt die BtbN FFmpeg-LGPL-Shared-Win64-Distribution + verifiziert SHA256 +
# entpackt nach `ffmpeg-dist/n8.1-lgpl-shared/`. Idempotent: skipt wenn die
# Distribution schon mit passendem SHA da liegt.
#
# Aufruf (vom Sidecar-Root):
#   pwsh scripts/fetch-ffmpeg.ps1
#
# Warum LGPL-shared:
#   - LGPL (kein libx264/libx265) = Pulse darf closed bleiben, FFmpeg-DLLs
#     werden separat ausgeliefert + austauschbar (LGPL-konform)
#   - Shared = wir linken gegen .lib-Stubs, .dll-Dateien werden zur Laufzeit
#     neben unser .exe gestellt (siehe scripts/copy-ffmpeg-dlls.ps1)
#
# Pin: BtbN n8.1-LGPL-shared, SHA-Stand 2026-05-20. Die URL zeigt auf BtbNs
# rollendes `latest`-Release — BtbN lädt das laufend mit neuen Nightlies neu
# hoch, d.h. $ExpectedSha muss bei einem BtbN-Re-Release neu gesetzt werden
# (clean fetch failt sonst mit „SHA256 mismatch"). Die CI cached `ffmpeg-dist/`
# darum keyed auf diese Datei — solange der Cache hält, kein Re-Download.
# Hardware-Encoder enthalten: h264/hevc/av1 für nvenc + amf + qsv. Audio:
# libopus. Mux: flv + mpegts. TLS: schannel (RTMPS ohne externe OpenSSL-DLL).

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SidecarRoot = Split-Path -Parent $ScriptDir
$Dist = Join-Path $SidecarRoot 'ffmpeg-dist'
$Zip = Join-Path $Dist 'ffmpeg-n8.1-win64-lgpl-shared.zip'
$Target = Join-Path $Dist 'n8.1-lgpl-shared'

$Url = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-win64-lgpl-shared-8.1.zip'
$ExpectedSha = 'c9acc29c2b614bd6ea40e08c27f3b532413894a27d7fd69242221a9a71319aca'

if (-not (Test-Path $Dist)) {
    New-Item -ItemType Directory -Path $Dist | Out-Null
}

# Skip wenn schon ausgepackt + Zip vorhanden + Hash passt
if ((Test-Path $Target) -and (Test-Path "$Target\bin\ffmpeg.exe") -and (Test-Path $Zip)) {
    $sha = (Get-FileHash -Algorithm SHA256 -Path $Zip).Hash.ToLower()
    if ($sha -eq $ExpectedSha) {
        Write-Host "[fetch-ffmpeg] already up-to-date at $Target"
        return
    }
    Write-Host "[fetch-ffmpeg] SHA mismatch ($sha vs $ExpectedSha); re-downloading"
    Remove-Item -Recurse -Force $Target
    Remove-Item -Force $Zip
}

Write-Host "[fetch-ffmpeg] downloading $Url"
$ProgressPreference = 'SilentlyContinue'
Invoke-WebRequest -Uri $Url -OutFile $Zip -UseBasicParsing

$actualSha = (Get-FileHash -Algorithm SHA256 -Path $Zip).Hash.ToLower()
if ($actualSha -ne $ExpectedSha) {
    throw "SHA256 mismatch! got $actualSha, expected $ExpectedSha"
}
Write-Host "[fetch-ffmpeg] sha256 ok"

# BtbN zip extracts to `ffmpeg-n8.1-latest-win64-lgpl-shared-8.1/` — rename to
# stable `n8.1-lgpl-shared/` so .cargo/config.toml's FFMPEG_DIR path doesn't
# need to change when BtbN re-releases.
Write-Host "[fetch-ffmpeg] extracting to $Target"
Expand-Archive -Path $Zip -DestinationPath $Dist -Force
$Inner = Join-Path $Dist 'ffmpeg-n8.1-latest-win64-lgpl-shared-8.1'
if (Test-Path $Target) {
    Remove-Item -Recurse -Force $Target
}
Move-Item -Path $Inner -Destination $Target

Write-Host "[fetch-ffmpeg] done — FFMPEG_DIR=$Target"
Write-Host "[fetch-ffmpeg] verify: & '$Target\bin\ffmpeg.exe' -version"
