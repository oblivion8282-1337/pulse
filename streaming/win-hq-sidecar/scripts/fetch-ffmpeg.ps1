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
# Quelle: SELBST GEHOSTETE Kopie der BtbN n8.1-LGPL-shared-Win64-Distribution
# auf unserem VPS (https://howispulse.com/downloads/vendor/…). Bewusst NICHT
# mehr BtbNs `latest`-Release: das ist ein rollendes Tag, BtbN lädt die
# Artefakte laufend mit neuen Nightlies neu hoch → der gepinnte $ExpectedSha
# wird bei jedem Re-Release stale und ein clean fetch failt mit „SHA256
# mismatch" (genau das hat den win-build-Workflow ab 2026-06-10 reihenweise
# kaputtgemacht, sobald der CI-Cache weg war). Eine eigene Kopie ist
# unveränderlich, wird nicht gepruned und kann nicht ohne uns wechseln — der
# Pin hält damit „für immer". Ein bewusster FFmpeg-Bump = neue datierte Datei
# hochladen + $Url/$ExpectedSha gemeinsam setzen (nie ein stiller Wechsel).
# LGPL-Redistribution ist erlaubt; die DLLs liegen separat neben der .exe.
#
# Datei einmalig auf den VPS legen (Beispiel, vom Repo-Root):
#   curl -sSL <BtbN-latest-url> -o ffm.zip
#   scp ffm.zip michael@159.195.150.54:pulse/downloads/vendor/ffmpeg-n8.1-lgpl-shared-<DATUM>.zip
#   ssh … 'sha256sum pulse/downloads/vendor/ffmpeg-n8.1-lgpl-shared-<DATUM>.zip'  # → $ExpectedSha
#
# Hardware-Encoder enthalten: h264/hevc/av1 für nvenc + amf + qsv. Audio:
# libopus. Mux: flv + mpegts. TLS: schannel (RTMPS ohne externe OpenSSL-DLL).

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SidecarRoot = Split-Path -Parent $ScriptDir
$Dist = Join-Path $SidecarRoot 'ffmpeg-dist'
$Zip = Join-Path $Dist 'ffmpeg-n8.1-win64-lgpl-shared.zip'
$Target = Join-Path $Dist 'n8.1-lgpl-shared'

# Selbst gehostet (siehe Kopf-Kommentar). Stammt aus BtbNs n8.1-LGPL-shared-
# `latest`-Build vom 2026-06-16; danach eingefroren auf unserem VPS.
$Url = 'https://howispulse.com/downloads/vendor/ffmpeg-n8.1-lgpl-shared-2026-06-16.zip'
$ExpectedSha = 'b8b241337a3a20ab6cbea66da73cd45377b480d6c4207e44926a3873365f31d7'

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
