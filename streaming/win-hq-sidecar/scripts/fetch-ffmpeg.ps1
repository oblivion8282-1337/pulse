# Holt das FFmpeg, gegen das der Sidecar linkt, nach `ffmpeg-dist/n8.1-lgpl-shared/`
# und prueft den SHA256. Idempotent.
#
# Aufruf (vom Sidecar-Root):
#   pwsh scripts/fetch-ffmpeg.ps1
#
# ## Warum das Paket nicht mehr das von BtbN sein kann
#
# Der Sidecar faehrt AV1 auf AMD mit rollendem Intra-Refresh. Die dafuer noetigen
# Optionen an `av1_amf` (`intra_refresh_mode`, `intra_refresh_stripes`) gibt es in
# KEINER FFmpeg-Fassung - nicht in 8.1, nicht in master, also auch in keinem
# Fertigpaket. Sie kommen aus
# `streaming/ffmpeg-patches/0002-amfenc_av1-rollender-intra-refresh.patch`.
# Ein neueres BtbN-Bundle hilft nachweislich nicht; wer das Gegenteil vermutet,
# prueft an einem ungepatchten Bau.
#
# Das ausgelieferte Paket wird deshalb selbst gebaut:
# `scripts/build-ffmpeg-patched.ps1` (FFmpeg n8.1.2 + Patch 0002, LGPL, shared).
# Dieses Skript hier laedt nur noch das Ergebnis dieses Baus.
#
# ## Warum selbst gehostet
#
# Wie vorher: BtbNs `latest` ist ein rollendes Tag, dessen Artefakte laufend neu
# hochgeladen werden - der gepinnte $ExpectedSha wird bei jedem Re-Release stale
# und ein sauberer Fetch scheitert mit "SHA256 mismatch" (genau das hat den
# win-build-Workflow ab 2026-06-10 reihenweise kaputtgemacht, sobald der CI-Cache
# weg war). Eine eigene Kopie ist unveraenderlich. Fuer den selbst gebauten Bau
# gilt dasselbe Verfahren: eine datierte Datei hochladen, $Url und $ExpectedSha
# GEMEINSAM setzen, nie ein stiller Wechsel.
#
# ## Lizenz
#
# LGPL, ohne `--enable-gpl`/`--enable-nonfree`/libx264/libx265. Die DLLs liegen
# separat neben der `.exe` (dynamisch gelinkt, LGPL-konform). Die volle
# Konfiguration steht in `build-ffmpeg-patched.ps1` - jede Zeile mit ihrem Grund.
#
# ## Datei einmalig auf den VPS legen (vom Sidecar-Root)
#
#   .\scripts\build-ffmpeg-patched.ps1 -Zip     # baut + schnuert + nennt den SHA256
#   scp ffmpeg-dist\ffmpeg-n8.1-lgpl-shared-patched-<DATUM>.zip `
#       michael@159.195.150.54:pulse/downloads/vendor/
#   # danach $PatchedUrl + $PatchedSha unten GEMEINSAM setzen

param(
    # Ueberschreibt auch ein bereits vorhandenes, gepatchtes Paket.
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

# --- Das gepatchte Paket (das Ziel) ------------------------------------------
#
# LEER = liegt noch nicht auf dem VPS. Dann faellt dieses Skript auf das alte
# BtbN-Paket zurueck und WARNT - der Sidecar baut damit, faehrt AV1 aber ohne
# Intra-Refresh und verweigert den Start ehrlich, wenn er verlangt wird
# (`src/encode/auffrischung.rs`). Beide Zeilen gemeinsam setzen.
#
# GESETZT seit 2026-08-05. Gebaut mit `build-ffmpeg-patched.ps1` aus n8.1.2 +
# `0002-amfenc_av1-rollender-intra-refresh.patch`, LGPL-shared, ohne
# --enable-gpl/--enable-nonfree/libx264/libx265 und ohne --enable-version3.
# Am gebauten Binary gegengeprueft: `av1_amf` kennt jetzt `intra_refresh_mode`
# UND `intra_refresh_stripes` - im BtbN-Paket fehlten beide, weshalb AMD unter
# Windows bis hierher kein Intra-Refresh bekam, obwohl es auf der AMD-Maschine
# laengst gemessen war. Der Patch existierte, das Paket war nur nie hochgeladen.
$PatchedUrl = 'https://howispulse.com/downloads/vendor/ffmpeg-n8.1-lgpl-shared-patched-2026-08-05.zip'
$PatchedSha = 'a8b6fc7ccb7b45b014c7c17abb030e3d738ef7b57f34d27b51426e02d3a9e708'

# --- Rueckfall: das bisherige BtbN-Paket -------------------------------------
#
# Selbst gehostet, aus BtbNs n8.1-LGPL-shared-`latest`-Build vom 2026-06-16,
# danach eingefroren. Enthaelt alle Encoder und Muxer, die der Sidecar braucht -
# nur die AMF-Intra-Refresh-Optionen eben nicht.
$FallbackUrl = 'https://howispulse.com/downloads/vendor/ffmpeg-n8.1-lgpl-shared-2026-06-16.zip'
$FallbackSha = 'b8b241337a3a20ab6cbea66da73cd45377b480d6c4207e44926a3873365f31d7'

if ($PatchedUrl -and $PatchedSha) {
    $Url = $PatchedUrl
    $ExpectedSha = $PatchedSha
    $IstGepatcht = $true
} else {
    $Url = $FallbackUrl
    $ExpectedSha = $FallbackSha
    $IstGepatcht = $false
}

# Ein fehlender Patch im ausgelieferten Paket ist eine Feststellung, die im
# CI-Protokoll untergeht - dort scrollt niemand. Auf GitHub Actions wird daraus
# deshalb eine Annotation, die in der Zusammenfassung des Laufs steht.
function Warnen([string]$Text) {
    Write-Warning $Text
    if ($env:GITHUB_ACTIONS -eq 'true') {
        Write-Host "::warning title=FFmpeg ohne Patch 0002::$($Text -replace '\r?\n', ' ')"
    }
}

if (-not (Test-Path $Dist)) {
    New-Item -ItemType Directory -Path $Dist | Out-Null
}

# Ein bereits gepatchtes Paket NICHT wegwerfen. Wer es von Hand gebaut hat
# (build-ffmpeg-patched.ps1), verlaeuft sich sonst genau hier: das Skript laedt
# klaglos das ungepatchte Paket darueber, und die Optionen sind wieder weg.
if ((-not $Force) -and (-not $IstGepatcht) -and (Test-Gepatcht $Target)) {
    Say "$Target ist bereits gepatcht - nichts zu tun."
    Say '(-Force ueberschreibt es mit dem Paket aus $Url)'
    return
}

# Skip wenn schon ausgepackt + Zip vorhanden + Hash passt
if ((Test-Path $Target) -and (Test-Path "$Target\bin\ffmpeg.exe") -and (Test-Path $Zip)) {
    $sha = (Get-FileHash -Algorithm SHA256 -Path $Zip).Hash.ToLower()
    if ($sha -eq $ExpectedSha) {
        Say "already up-to-date at $Target"
        if (-not $IstGepatcht) { Warnen 'FFmpeg ohne Patch 0002 - AV1-Intra-Refresh fehlt (s. Kopf dieses Skripts).' }
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

# Unser eigenes Zip traegt `n8.1-lgpl-shared/` bereits als oberstes Verzeichnis;
# BtbNs traegt `ffmpeg-n8.1-latest-win64-lgpl-shared-8.1/`. Beides landet am
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

# Gegenprobe am Ergebnis, nicht am Dateinamen.
$fehlend = $null
if (Test-Gepatcht $Target ([ref]$fehlend)) {
    Say 'Patch 0002 ist drin (av1_amf kennt intra_refresh_mode)'
} elseif ($IstGepatcht) {
    Die "Das als gepatcht gepinnte Paket vermisst: $($fehlend -join ', ') - falsche Datei hochgeladen?"
} else {
    Warnen @'
Dieses FFmpeg ist NICHT gepatcht: av1_amf kennt intra_refresh_mode nicht.
AV1 auf AMD faehrt damit periodische Vollbilder; der Sidecar verweigert den
Start, wenn Intra-Refresh verlangt wird (src/encode/auffrischung.rs).
Abhilfe: scripts/build-ffmpeg-patched.ps1 - und das Ergebnis auf den VPS legen,
dann $PatchedUrl/$PatchedSha oben setzen.
'@
}

Say "done - FFMPEG_DIR=$Target"
Say "verify: & '$Target\bin\ffmpeg.exe' -version"
