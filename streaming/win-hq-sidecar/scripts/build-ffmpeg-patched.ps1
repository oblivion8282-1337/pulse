# Baut das FFmpeg, gegen das der Sidecar linkt - aus Quelltext, mit unserem
# AMF-Patch, LGPL.
#
# Aufruf (vom Sidecar-Root, PowerShell):
#   .\scripts\build-ffmpeg-patched.ps1              # bauen, pruefen, einsetzen
#   .\scripts\build-ffmpeg-patched.ps1 -NoInstall   # nur bauen + pruefen
#   .\scripts\build-ffmpeg-patched.ps1 -Zip         # zusaetzlich das VPS-Paket schnueren
#
# Diese Datei ist bewusst REIN ASCII, ohne Umlaute und ohne Gedankenstriche.
# Windows PowerShell 5.1 liest ein `.ps1` ohne BOM als ANSI: aus dem UTF-8-Byte
# eines Gedankenstrichs wird dabei unter anderem ein typografisches
# Anfuehrungszeichen, und das beendet PowerShell eine Zeichenkette mitten im
# Satz. Das Skript scheitert dann mit einem Syntaxfehler an einer Stelle, an der
# nichts falsch aussieht.
#
# ## Warum ueberhaupt selbst bauen
#
# `streaming/ffmpeg-patches/0002-amfenc_av1-rollender-intra-refresh.patch` gibt
# `av1_amf` die Optionen `intra_refresh_mode`/`intra_refresh_stripes`. Die gibt
# es in KEINER FFmpeg-Fassung - auch nicht in master, auch nicht in einem
# neueren Fertigpaket. Ohne sie faehrt AV1 auf AMD periodische Vollbilder, und
# der Sidecar verweigert den Start ehrlich statt still (`encode/auffrischung.rs`).
# Ein fertiges Paket kann diesen Zustand also nicht beheben; ein selbst gebautes
# ist die einzige Moeglichkeit.
#
# ## Was das Ergebnis ist
#
# Ein vollstaendiger LGPL-Shared-Baum (`bin/ include/ lib/`) im selben Layout wie
# das bisherige BtbN-Paket, damit `FFMPEG_DIR` (`.cargo/config.toml`) und
# `build.rs` unveraendert bleiben. Er wird ERST eingesetzt, wenn alle Pruefungen
# unten gruen sind; das bisherige Verzeichnis wandert vorher zur Seite.
#
# ## Maschinenwissen (hat schon Zeit gekostet)
#
# * `make` liegt in `C:\msys64\usr\bin`, die Uebersetzer in
#   `C:\msys64\mingw64\bin` - BEIDE muessen in den PATH. Deshalb laeuft der Bau
#   ueber `bash -lc` mit `MSYSTEM=MINGW64`: das MSYS2-Profil setzt genau diese
#   Reihenfolge, statt dass wir sie von Hand nachbauen.
# * `TMP`/`TEMP` muessen auf ein beschreibbares Windows-Verzeichnis zeigen. Kommen
#   sie nicht als Windows-Variable an, faellt gcc auf `C:\Windows\` zurueck und
#   scheitert dort an den Rechten - mit einer Meldung, die nach einem
#   Uebersetzerfehler aussieht.
# * Der Sidecar sieht ein ausgetauschtes FFmpeg NICHT von allein. Windows sucht
#   DLLs zuerst neben der `.exe`, und `build.rs` kopiert sie nur, wenn cargo es
#   ueberhaupt aufruft. Deshalb stupst dieses Skript zum Schluss `build.rs` an.
#
# ## Voraussetzungen
#
# MSYS2 unter `C:\msys64` (Pfad per `-Msys` aenderbar) mit diesen Paketen -
# fehlt eines, sagt das Skript welches:
#
#   pacman -S --needed mingw-w64-x86_64-toolchain mingw-w64-x86_64-nasm \
#             mingw-w64-x86_64-pkgconf mingw-w64-x86_64-opus \
#             mingw-w64-x86_64-dav1d mingw-w64-x86_64-srt \
#             mingw-w64-x86_64-ffnvcodec-headers mingw-w64-x86_64-libvpl \
#             mingw-w64-x86_64-amf-headers

[CmdletBinding()]
param(
    # FFmpeg-Fassung. Der Patch ist gegen n8.1.2 entstanden und passt dort
    # exakt; eine andere Fassung ist eine bewusste Entscheidung, kein Default.
    [string]$Ref = 'n8.1.2',
    [string]$Msys = 'C:\msys64',
    # 0 = Anzahl der logischen Kerne.
    [int]$Jobs = 0,
    # Nur bauen und pruefen, das ausgelieferte Verzeichnis nicht anfassen.
    [switch]$NoInstall,
    # Quellbaum und Zwischenstand wegwerfen und von Null anfangen.
    [switch]$Clean,
    # Zusaetzlich das Zip fuer den VPS schnueren und den SHA256 ausgeben.
    [switch]$Zip
)

$ErrorActionPreference = 'Stop'

$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$SidecarRoot = Split-Path -Parent $ScriptDir
$RepoRoot    = Split-Path -Parent (Split-Path -Parent $SidecarRoot)
$PatchDir    = Join-Path $RepoRoot 'streaming\ffmpeg-patches'
# NUR die Patches, die Windows braucht - `0001` ist VAAPI und hat hier nichts zu
# suchen. Kommt ein weiterer Windows-Patch dazu, gehoert er in diese Liste; das
# Verzeichnis blind zu nehmen waere falsch, weil dort auch Linux-Patches liegen.
$Patches     = @(
    '0002-amfenc_av1-rollender-intra-refresh.patch'
) | ForEach-Object { Join-Path $PatchDir $_ }

$Dist    = Join-Path $SidecarRoot 'ffmpeg-dist'
$Target  = Join-Path $Dist 'n8.1-lgpl-shared'   # Pfad aus .cargo/config.toml
$Work    = Join-Path $Dist '_build'             # Quellbaum + Zwischenstand
$Src     = Join-Path $Work 'ffmpeg-src'
# `make install` landet direkt unter dem Namen, den das Paket spaeter traegt.
# Damit ist das Einsetzen ein Umbenennen (kostenlos) statt einer 48-MB-Kopie,
# und das Zip bekommt ohne Zwischenschritt das richtige oberste Verzeichnis.
$Stage   = Join-Path $Work 'n8.1-lgpl-shared'

$Bash    = Join-Path $Msys 'usr\bin\bash.exe'
$Mingw   = Join-Path $Msys 'mingw64\bin'

$script:LogTag = 'build-ffmpeg'
. (Join-Path $ScriptDir 'lib\gemeinsam.ps1')

if (-not (Test-Path $Bash)) { Die "MSYS2-bash nicht gefunden: $Bash. MSYS2 installieren oder -Msys setzen." }
foreach ($p in $Patches) {
    if (-not (Test-Path $p)) { Die "Patch fehlt: $p" }
}
if ($Jobs -le 0) { $Jobs = [Environment]::ProcessorCount }

# --- MSYS2-Aufruf ------------------------------------------------------------
#
# `-l` laesst das MSYS2-Profil laufen, das mit `MSYSTEM=MINGW64` /mingw64/bin
# VOR /usr/bin haengt (Uebersetzer) und /usr/bin drin behaelt (make, sed, ...).
# `CHERE_INVOKING` verhindert, dass das Profil ins Home wechselt.
# `TMP`/`TEMP` reichen wir als Windows-Pfad durch (s. Kopf).
function Invoke-Msys([string]$WorkDir, [string]$Command) {
    $tmp = $env:TEMP
    if (-not $tmp -or -not (Test-Path $tmp)) { $tmp = Join-Path $Work 'tmp' }
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null

    $env:MSYSTEM       = 'MINGW64'
    $env:CHERE_INVOKING = '1'
    $env:MSYS2_PATH_TYPE = 'inherit'
    $env:TMP = $tmp
    $env:TEMP = $tmp

    Push-Location $WorkDir
    try {
        Invoke-Fremd { & $Bash -lc $Command }
        if ($LASTEXITCODE -ne 0) { Die "Schritt fehlgeschlagen (Exit $LASTEXITCODE): $Command" }
    } finally {
        Pop-Location
    }
}

# --- Bauabhaengigkeiten pruefen, bevor configure 20 Minuten spaeter meckert ---
#
# Schluessel = Pfad unterhalb von $Msys, Wert = das pacman-Paket, das ihn
# mitbringt. Werkzeuge und Header in EINER Tabelle: getrennt gepflegt landet
# ein neuer Eintrag frueher oder spaeter im falschen Block.
$brauchen = @{
    'mingw64\bin\gcc.exe'                     = 'mingw-w64-x86_64-toolchain'
    'mingw64\bin\objdump.exe'                 = 'mingw-w64-x86_64-toolchain'
    'mingw64\bin\nasm.exe'                    = 'mingw-w64-x86_64-nasm'
    'mingw64\bin\pkg-config.exe'              = 'mingw-w64-x86_64-pkgconf'
    'mingw64\include\AMF\core\Version.h'      = 'mingw-w64-x86_64-amf-headers'
    'mingw64\include\ffnvcodec\nvEncodeAPI.h' = 'mingw-w64-x86_64-ffnvcodec-headers'
    'mingw64\include\opus\opus.h'             = 'mingw-w64-x86_64-opus'
    'mingw64\include\dav1d\dav1d.h'           = 'mingw-w64-x86_64-dav1d'
    'mingw64\include\srt\srt.h'               = 'mingw-w64-x86_64-srt'
    'mingw64\include\vpl\mfxvideo.h'          = 'mingw-w64-x86_64-libvpl'
}
foreach ($p in $brauchen.Keys) {
    if (-not (Test-Path (Join-Path $Msys $p))) {
        Die "$p fehlt unter $Msys - pacman -S --needed $($brauchen[$p])"
    }
}

if ($Clean -and (Test-Path $Work)) {
    Say "raeume $Work"
    Remove-Item -Recurse -Force $Work
}
New-Item -ItemType Directory -Force -Path $Work | Out-Null

# --- Quelle holen ------------------------------------------------------------
#
# git laeuft ueber PowerShell, nicht ueber bash: MSYS2 bringt nicht zwingend ein
# eigenes git mit, und dem Windows-git einen MSYS-Pfad (`/c/...`) zu geben
# scheitert. Nur configure/make brauchen die MSYS2-Umgebung.
#
# `--depth 1 --branch <tag>` statt eines Vollklons: der Bau braucht genau einen
# Stand, und ein Vollklon von FFmpeg sind ueber 1 GB.
if (-not (Test-Path (Join-Path $Src 'configure'))) {
    Say "klone FFmpeg $Ref nach $Src"
    if (Test-Path $Src) { Remove-Item -Recurse -Force $Src }
    Invoke-Fremd { & git clone --depth 1 --branch $Ref https://git.ffmpeg.org/ffmpeg.git $Src }
    if ($LASTEXITCODE -ne 0) { Die "git clone $Ref fehlgeschlagen" }
} else {
    Say "Quellbaum vorhanden ($Src) - -Clean erzwingt einen frischen"
}

# --- Patch anwenden ----------------------------------------------------------
#
# `git apply --check` zuerst: greift der Patch auf dieser Fassung nicht, ist das
# ein Abbruchgrund und keine Warnung. Ein Bau ohne den Patch saehe gesund aus
# und liefe hinterher ohne Intra-Refresh.
Push-Location $Src
try {
    foreach ($p in $Patches) {
        $name = Split-Path -Leaf $p
        # Meldung verschlucken: dass der Patch NICHT rueckwaerts passt, ist der
        # Normalfall und keine Nachricht wert. `Get-Ausgabe` faengt dabei schon
        # ab, was `Invoke-Fremd` sonst abfaengt.
        Get-Ausgabe { & git apply --reverse --check $p } | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Say "$name liegt bereits im Quellbaum"
            continue
        }
        Say "wende $name an"
        Invoke-Fremd { & git apply --check $p }
        if ($LASTEXITCODE -ne 0) { Die "$name passt nicht auf $Ref - Abbruch statt eines Baus ohne ihn" }
        Invoke-Fremd { & git apply $p }
        if ($LASTEXITCODE -ne 0) { Die "git apply $name fehlgeschlagen" }
    }
} finally { Pop-Location }

# --- configure ---------------------------------------------------------------
#
# Jede Zeile traegt ihren Grund. Was hier fehlt, fehlt spaeter im Produkt - und
# was hier zu viel steht, muss als DLL mitgeliefert werden.
$stageMsys = (& $Bash -lc "cygpath -u '$Stage'").Trim()
$configure = @(
    "--prefix='$stageMsys'"
    # Der Sidecar linkt gegen die Bibliotheken, `build.rs` legt die DLLs neben
    # die exe. Ein statischer Bau nuetzt ihm nichts - und LGPL will die DLLs
    # ohnehin austauschbar.
    '--enable-shared'
    '--disable-static'
    # LGPL bleibt LGPL: KEIN --enable-gpl, KEIN --enable-nonfree, kein libx264.
    # Das ist Projektvorgabe (CLAUDE.md, Abschnitt Lizenz), kein Detail.
    # `--enable-version3` steht bewusst auch nicht da: keine der eingebundenen
    # Bibliotheken verlangt es, und LGPLv2.1 ist die kleinere Zusage.
    '--disable-debug'
    '--disable-doc'
    # TLS fuer den RTMPS-Push. Ohne schannel stirbt jeder Stream nach dem
    # Handshake - und zwar erst beim Nutzer, nicht hier.
    '--enable-schannel'
    # Die drei Encoder-Wege des Sidecars (encode/encoder.rs):
    '--enable-amf'          # AMD - traegt mit dem Patch den Intra-Refresh
    '--enable-ffnvcodec'    # NVIDIA - *_nvenc
    '--enable-nvenc'
    '--enable-libvpl'       # Intel - *_qsv
    # D3D11VA ist der hwframes-Pool beider GPU-Wege (encode/hwctx.rs), D3D12VA
    # der Gegenprobe-Weg (PULSE_HQ_AMD_D3D12=1). Beide wuerden autoerkannt;
    # ausdruecklich, damit ein fehlendes SDK hier scheitert und nicht still
    # einen Encoder-Weg wegnimmt.
    '--enable-d3d11va'
    '--enable-d3d12va'
    '--enable-libopus'      # Ton des Streams
    '--enable-libdav1d'     # AV1-Decoder - Gegenproben und Messungen brauchen ihn
    '--enable-libsrt'       # srt:// als Push-Ziel (encode/output.rs)
    '--enable-zlib'
    # Damit `ffmpeg -version` erkennen laesst, dass das nicht der Upstream-Bau
    # ist. Der Sidecar liest die Zeichenkette nicht, Menschen schon.
    '--extra-version=pulse-intra-refresh'
) -join ' '

# configure ist auf Windows der langsamste Schritt (Minuten, weil jeder Test
# eigene Prozesse startet). Deshalb nur, wenn es etwas zu tun gibt: die zuletzt
# benutzte Zeile liegt daneben, und schon ein geaendertes Zeichen loest ein
# neues configure aus. Sich auf das blosse Vorhandensein von `config.mak` zu
# verlassen waere die gefaehrliche Abkuerzung - dann baute ein geaenderter
# Schalter still mit der alten Konfiguration weiter.
$configureStempel = Join-Path $Src '.pulse-configure'
$configureNoetig = -not (
    (Test-Path (Join-Path $Src 'ffbuild/config.mak')) -and
    (Test-Path $configureStempel) -and
    ((Get-Content $configureStempel -Raw) -eq $configure)
)
if ($configureNoetig) {
    Say "configure ($Ref, LGPL, shared)"
    Invoke-Msys $Src "./configure $configure"
    Set-Content -Path $configureStempel -Value $configure -NoNewline -Encoding ASCII
} else {
    Say 'configure uebersprungen (unveraenderte Schalter, config.mak liegt vor)'
}

# Bauen und installieren in EINER MSYS2-Sitzung: `bash -l` liest jedes Mal das
# Profil, und das kostet auf Windows spuerbar mehr als der Schritt selbst.
# Das Zielverzeichnis vorher leeren, damit kein Rest eines frueheren Baus
# mitgeliefert wird.
if (Test-Path $Stage) { Remove-Item -Recurse -Force $Stage }
Say "make -j$Jobs && make install -> $Stage"
Invoke-Msys $Src "make -j$Jobs && make install"

# --- MSYS2-Laufzeit-DLLs mitnehmen -------------------------------------------
#
# Ohne sie startet kein Binary, und zwar WORTLOS (0xC0000135, bevor eine Zeile
# Code laeuft). Die Liste wird nicht gepflegt, sondern gelaufen: `objdump -p`
# nennt die Importe, und was davon in mingw64/bin liegt, gehoert mit. Eine von
# Hand gepflegte Liste veraltet beim naechsten configure-Schalter still.
$StageBin = Join-Path $Stage 'bin'
$Objdump  = Join-Path $Mingw 'objdump.exe'
$gesehen  = New-Object 'System.Collections.Generic.HashSet[string]'

function Copy-Abhaengigkeiten([string]$File) {
    $importe = Get-Ausgabe { & $Objdump -p $File } |
        Select-String -Pattern '^\s*DLL Name:\s*(\S+)' |
        ForEach-Object { $_.Matches[0].Groups[1].Value }
    foreach ($dll in $importe) {
        $key = $dll.ToLowerInvariant()
        if (-not $gesehen.Add($key)) { continue }
        $quelle = Join-Path $Mingw $dll
        if (-not (Test-Path $quelle)) { continue }   # System-DLL - bleibt beim System
        $ziel = Join-Path $StageBin $dll
        if (-not (Test-Path $ziel)) { Copy-Item $quelle $ziel }
        Copy-Abhaengigkeiten $ziel                    # transitiv (libsrt -> libssl -> ...)
    }
}

Say 'sammle die MSYS2-Laufzeit-DLLs ein'
foreach ($f in Get-ChildItem $StageBin -Include *.exe, *.dll -Recurse) {
    Copy-Abhaengigkeiten $f.FullName
}

# --- Pruefen, BEVOR das laufende Paket angefasst wird -------------------------
$Ffmpeg = Join-Path $StageBin 'ffmpeg.exe'
if (-not (Test-Path $Ffmpeg)) { Die "kein ffmpeg.exe in $StageBin" }

# Die Ausgabe wird EINMAL zusammengefuegt und danach nur noch durchsucht -
# `-join` je Suchbegriff waere dieselbe Arbeit mehrfach.
function Muss-Enthalten([string[]]$Ausgabe, [string[]]$Erwartet, [string]$Was) {
    $text = $Ausgabe -join "`n"
    $fehlt = @($Erwartet | Where-Object { $text -notmatch [regex]::Escape($_) })
    if ($fehlt.Count) { Die "$Was fehlt: $($fehlt -join ', ')" }
    Say "$Was vollstaendig: $($Erwartet -join ', ')"
}

# Gegenstueck: was hier auftaucht, darf nicht ausgeliefert werden.
function Darf-Nicht-Enthalten([string[]]$Ausgabe, [string[]]$Verboten, [string]$Was) {
    $text = $Ausgabe -join "`n"
    $treffer = @($Verboten | Where-Object { $text -match [regex]::Escape($_) })
    if ($treffer.Count) { Die "$Was : $($treffer -join ', ')" }
    Say "$Was : keiner davon gesetzt"
}

$buildconf = Get-Ausgabe { & $Ffmpeg -hide_banner -buildconf }
Muss-Enthalten $buildconf @(
    '--enable-shared', '--disable-static', '--enable-schannel',
    '--enable-amf', '--enable-nvenc', '--enable-libvpl',
    '--enable-libopus', '--enable-libdav1d', '--enable-libsrt'
) 'Pflicht-Konfiguration'
Darf-Nicht-Enthalten $buildconf @(
    '--enable-gpl', '--enable-nonfree', '--enable-libx264', '--enable-libx265'
) 'LIZENZ - GPL-/nonfree-Schalter'

# Dieselbe Frage, die auch `fetch-ffmpeg.ps1` am geholten Paket stellt, aus
# derselben Quelle (`lib\gemeinsam.ps1`).
$fehlendeOptionen = $null
if (-not (Test-Gepatcht $Stage ([ref]$fehlendeOptionen))) {
    Die "av1_amf-Optionen fehlen: $($fehlendeOptionen -join ', ') - der Patch hat nicht gegriffen"
}
Say 'av1_amf-Optionen vollstaendig: intra_refresh_mode, intra_refresh_stripes'

Muss-Enthalten (Get-Ausgabe { & $Ffmpeg -hide_banner -muxers }) @('flv', 'mpegts', 'whip') 'Muxer'
Muss-Enthalten (Get-Ausgabe { & $Ffmpeg -hide_banner -protocols }) @('rtmps', 'tls', 'dtls', 'srtp', 'srt') 'Protokolle'
Muss-Enthalten (Get-Ausgabe { & $Ffmpeg -hide_banner -encoders }) @(
    'av1_amf', 'h264_amf', 'h264_nvenc', 'av1_nvenc', 'h264_qsv', 'h264_d3d12va'
) 'Encoder'

Say 'alle Pruefungen gruen'

# --- Paket fuer den VPS ------------------------------------------------------
#
# VOR dem Einsetzen, weil `$Stage` schon den richtigen Verzeichnisnamen traegt
# (`n8.1-lgpl-shared`) und danach dorthin umbenannt wird. So wird der Baum
# genau einmal gelesen statt zweimal kopiert.
if ($Zip) {
    $Name = "ffmpeg-n8.1-lgpl-shared-patched-$(Get-Date -Format 'yyyy-MM-dd').zip"
    $ZipPath = Join-Path $Dist $Name
    if (Test-Path $ZipPath) { Remove-Item -Force $ZipPath }
    Compress-Archive -Path $Stage -DestinationPath $ZipPath
    $sha = (Get-FileHash -Algorithm SHA256 -Path $ZipPath).Hash.ToLower()
    Say "Paket: $ZipPath"
    Say "SHA256: $sha"
    Say 'Naechster Schritt (von Hand, siehe scripts/fetch-ffmpeg.ps1):'
    Say "  scp `"$ZipPath`" michael@159.195.150.54:pulse/downloads/vendor/$Name"
    Say "  danach in fetch-ffmpeg.ps1 `$PatchedUrl + `$PatchedSha gemeinsam setzen"
}

# --- Einsetzen ---------------------------------------------------------------
if ($NoInstall) {
    Say "-NoInstall: das Ergebnis liegt in $Stage, $Target bleibt unangetastet"
} else {
    # Zur Seite legen statt loeschen: wer den Bau verwirft, will das alte Paket
    # zurueck, ohne es neu zu laden. GENAU EINES davon - datierte Kopien
    # sammelten sich sonst zu je 48 MB an, und niemand raeumt sie weg.
    $Beiseite = Join-Path $Dist 'n8.1-lgpl-shared.vorher'
    if (Test-Path $Target) {
        if (Test-Path $Beiseite) { Remove-Item -Recurse -Force $Beiseite }
        Say "lege das bisherige Paket beiseite: $Beiseite"
        Move-Item $Target $Beiseite
    }
    # Umbenennen statt kopieren: derselbe Datentraeger, also praktisch umsonst.
    Say "setze das neue Paket ein: $Target"
    Move-Item $Stage $Target

    # `build.rs` kopiert die DLLs nur, wenn cargo es aufruft - und das tut es
    # nur bei einer beobachteten Aenderung. Ohne diesen Stups laeuft die exe
    # weiter mit den alten DLLs daneben, waehrend `ffmpeg.exe -h` das Neue
    # zeigt. Genau diese Verwechslung hat schon eine halbe Stunde gekostet.
    $BuildRs = Join-Path $SidecarRoot 'build.rs'
    if (Test-Path $BuildRs) {
        (Get-Item $BuildRs).LastWriteTime = Get-Date
        Say 'build.rs angestupst - jetzt `cargo build --release --bins --examples`'
    }
}

Say 'fertig'
