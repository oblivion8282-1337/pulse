# Holt das FFmpeg, gegen das der Sidecar linkt, nach `ffmpeg-dist/n8.1-lgpl-shared/`
# und prueft den SHA256. Idempotent.
#
# Aufruf (vom Sidecar-Root):
#   pwsh scripts/fetch-ffmpeg.ps1
#
# ## Warum selbst gehostet und nicht direkt von BtbN
#
# BtbNs `latest` ist ein rollendes Tag, dessen Artefakte laufend neu hochgeladen
# werden - der gepinnte $ExpectedSha wird bei jedem Re-Release stale und ein
# sauberer Fetch scheitert mit "SHA256 mismatch" (genau das hat den
# win-build-Workflow ab 2026-06-10 reihenweise kaputtgemacht, sobald der CI-Cache
# weg war). Eine eigene, eingefrorene Kopie ist unveraenderlich. Beim Anheben
# gilt: eine datierte Datei hochladen, $Url und $ExpectedSha GEMEINSAM setzen,
# nie ein stiller Wechsel.
#
# ## Unveraendert - und das war zwischenzeitlich anders
#
# Vom 2026-08-05 bis zum 2026-08-21 lud dieses Skript ein SELBST GEBAUTES,
# gepatchtes Paket (`build-ffmpeg-patched.ps1`, FFmpeg n8.1.2 + ein Patch, der
# `av1_amf` die Optionen `intra_refresh_mode`/`intra_refresh_stripes`
# freilegte). Die Betriebsart rollender Intra-Refresh ist entfallen, damit auch
# der Patch, der Eigenbau und das Hochladen auf den VPS. Geladen wird wieder
# das unveraenderte BtbN-Paket.
#
# ## Lizenz
#
# LGPL, ohne `--enable-gpl`/`--enable-nonfree`/libx264/libx265. Die DLLs liegen
# separat neben der `.exe` (dynamisch gelinkt, LGPL-konform).

param(
    # Ueberschreibt auch ein bereits vorhandenes Paket.
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SidecarRoot = Split-Path -Parent $ScriptDir

$script:LogTag = 'fetch-ffmpeg'
. (Join-Path $ScriptDir 'lib\gemeinsam.ps1')

$Dist = Join-Path $SidecarRoot 'ffmpeg-dist'
$Zip = Join-Path $Dist 'ffmpeg-n8.1-win64-lgpl-shared.zip'
$Target = Join-Path $Dist 'n8.1-lgpl-shared'

# --- Das Paket ---------------------------------------------------------------
#
# Selbst gehostet, aus BtbNs n8.1-LGPL-shared-`latest`-Build vom 2026-06-16,
# danach eingefroren. Enthaelt alle Encoder und Muxer, die der Sidecar braucht.
$Url = 'https://howispulse.com/downloads/vendor/ffmpeg-n8.1-lgpl-shared-2026-06-16.zip'
$ExpectedSha = 'b8b241337a3a20ab6cbea66da73cd45377b480d6c4207e44926a3873365f31d7'

if (-not (Test-Path $Dist)) {
    New-Item -ItemType Directory -Path $Dist | Out-Null
}

# Skip wenn schon ausgepackt + Zip vorhanden + Hash passt
if ((-not $Force) -and (Test-Path $Target) -and (Test-Path "$Target\bin\ffmpeg.exe") -and (Test-Path $Zip)) {
    $sha = (Get-FileHash -Algorithm SHA256 -Path $Zip).Hash.ToLower()
    if ($sha -eq $ExpectedSha) {
        Say "already up-to-date at $Target"
        return
    }
    Say "SHA mismatch ($sha vs $ExpectedSha); re-downloading"
    Remove-Item -Recurse -Force $Target
    Remove-Item -Force $Zip
}

Say "downloading $Url"
$ProgressPreference = 'SilentlyContinue'
Invoke-WebRequest -Uri $Url -OutFile $Zip -UseBasicParsing

$actualSha = (Get-FileHash -Algorithm SHA256 -Path $Zip).Hash.ToLower()
if ($actualSha -ne $ExpectedSha) {
    Die "SHA256 mismatch! got $actualSha, expected $ExpectedSha"
}
Say 'sha256 ok'

# BtbNs Zip traegt `ffmpeg-n8.1-latest-win64-lgpl-shared-8.1/` als oberstes
# Verzeichnis, ein direkt gebautes traegt `n8.1-lgpl-shared/`. Beides landet am
# selben Ort, damit `FFMPEG_DIR` in `.cargo/config.toml` nie mitwandern muss.
Say "extracting to $Target"
if (Test-Path $Target) {
    Remove-Item -Recurse -Force $Target
}
Expand-Archive -Path $Zip -DestinationPath $Dist -Force
$Inner = Join-Path $Dist 'ffmpeg-n8.1-latest-win64-lgpl-shared-8.1'
if ((-not (Test-Path $Target)) -and (Test-Path $Inner)) {
    Move-Item -Path $Inner -Destination $Target
}
if (-not (Test-Path "$Target\bin\ffmpeg.exe")) {
    Die "Nach dem Auspacken fehlt $Target\bin\ffmpeg.exe - Zip-Layout unerwartet."
}

Say "done - FFMPEG_DIR=$Target"
Say "verify: & '$Target\bin\ffmpeg.exe' -version"
