# Nachweis, dass der Windows-Sidecar wirklich HDR sendet -- am fertigen Strom,
# nicht am Log des Senders.
#
# WARUM ES DAS GIBT: Die Kette von der Bildschirmaufnahme bis in den Bitstrom
# hat vier Stellen, an denen HDR verlorengehen kann, und **keine davon meldet
# sich, wenn sie es tut**:
#
#   1. Die Aufnahme holt 8-Bit-BGRA statt 16-Bit-Fliesskomma  -> SDR-Bildpunkte
#   2. Der Video-Prozessor wandelt nicht nach PQ/BT.2020      -> SDR-Bildpunkte
#   3. Der Encoder schreibt die Farbangaben nicht in den Kopf -> SDR-Etikett
#   4. Die Mastering-Metadaten fehlen                         -> kein Bezugsgeraet
#
# Bei 1 und 2 liefe ein Strom, der HDR BEHAUPTET und SDR ENTHAELT -- das ist der
# schlimmste Ausgang, weil er plausibel aussieht. Deshalb prueft dieses Skript
# beides getrennt: was der Strom ueber sich SAGT (ffprobe) und was wirklich
# darin steht (Bildpunkte am oberen Rand des PQ-Bereichs, `signalstats`).
#
# **Der zweite Nachweis stand bis zum 2026-08-11 nur in der Doku, nicht im
# Skript.** `docs/2026-08-06-hdr-windows-amd.md` beschreibt ihn als Befund 4
# und nennt dieses Skript als Werkzeug -- gefahren wurde er damals von Hand.
# Jetzt macht ihn das Skript mit, weil eine Doku, die auf ein Werkzeug zeigt,
# das die Messung gar nicht kann, schlimmer ist als gar keine.
#
# VORAUSSETZUNGEN:
#   * HDR muss in den Windows-Anzeigeeinstellungen fuer diesen Schirm AN sein.
#     Ist es das nicht, verweigert der Sidecar den Start -- mit genau dieser
#     Auskunft. Das ist der erwartete Ausgang, kein Fehler des Skripts.
#   * Ein Encoder, der HDR traegt: AV1 ueber AMF (AMD) oder AV1 ueber NVENC
#     (NVIDIA). Begruendung je Encoder in `win-hq-sidecar/src/encode/hdr.rs`.
#     **Hier stand bis zum 2026-08-11 "AMD mit AV1" als einzige Moeglichkeit --
#     das ist ueberholt, seit die NVIDIA-Seite gemessen ist**
#     (`docs/2026-08-11-hdr-windows-nvidia.md`).
#
# AUFRUF:
#   pwsh -File hdr-nachweis.ps1 [-Sekunden 12] [-Ablage <verzeichnis>]
#                               [-Inhalt <pfad.mp4>] [-Bild 45]

param(
  [int]$Sekunden = 12,
  [int]$Fps = 60,
  [int]$Bitrate = 12000,
  [string]$Aufloesung = '1080p',
  [int]$Bild = 45,
  # Was waehrend der Aufnahme auf dem Schirm laeuft.
  #
  # Leer = `ffplay` mit `testsrc2`. Das genuegt fuer die FARBKETTE, aber nicht
  # fuer die Frage, ob echte Spitzlichter durchkommen: ein SDR-Programm auf
  # einem HDR-Desktop wird vom Compositor auf SDR-Weiss abgebildet, und mehr
  # als SDR-Weiss steht dann nirgends im Bild. Genau diese Luecke steht in der
  # Messakte `nvidia-2026-08-04-windows-intra-refresh.json` als offener Punkt.
  #
  # Ein Pfad auf einen PQ/BT.2020-Clip laesst ihn stattdessen im VLC im
  # Vollbild laufen. **VLC, und das ist gemessen, nicht gewaehlt** (2026-08-11,
  # RTX 5080, HDR-Schirm mit 530 cd/m2, derselbe Clip und derselbe Bildindex):
  #
  #   VLC        Y-max 937  ->  9678 cd/m2   (Durchreichung, kein Tone-Mapping)
  #   Chrome     Y-max 590  ->   245 cd/m2   (= SDR-Weiss dieses Desktops)
  #   Edge       Y-max 592  ->   250 cd/m2
  #
  # Chrome und Edge geben den Clip auf dieser Maschine als SDR aus, auch mit
  # `--force-color-profile=scrgb-linear` bzw. `hdr10` (beide geprueft, ohne
  # Wirkung). Mit ihnen misst man den Weissabgleich des Compositors, nicht die
  # Frage. Sie bleiben als Rueckfall drin, falls kein VLC da ist -- dann sagt
  # das Urteil unten aber ausdruecklich, dass keine Spitzlichter dabei waren.
  [string]$Inhalt = '',
  [string]$Ablage = "$PSScriptRoot\..\..\..\build\hdr-nachweis"
)

$ErrorActionPreference = 'Stop'

$LaborRoot   = Resolve-Path "$PSScriptRoot\.."
$SidecarRoot = Resolve-Path "$PSScriptRoot\..\..\win-hq-sidecar"
$Bin   = Join-Path $SidecarRoot 'target\release\pulse-win-hq-sidecar.exe'

# **Das Labor-FFmpeg zuerst, das ausgelieferte als Rueckfall.** `ffmpeg-patched`
# gibt es nur auf einer Maschine, auf der der Vulkan-Arm gebaut wurde; auf der
# NVIDIA-Maschine steht dort nichts, und ohne diesen Rueckfall scheiterte jeder
# ffprobe-Aufruf still an einem Pfad, den es nicht gibt.
$FfKandidaten = @(
  (Join-Path $LaborRoot 'ffmpeg-patched\bin'),
  (Join-Path $SidecarRoot 'ffmpeg-dist\n8.1-lgpl-shared\bin')
)
$FfBin = $FfKandidaten | Where-Object { Test-Path (Join-Path $_ 'ffprobe.exe') } | Select-Object -First 1
if (-not $FfBin) { throw "Kein ffprobe gefunden in: $($FfKandidaten -join ' | ')" }

# `ffplay` fehlt in beiden Regelbauten (ohne SDL gebaut). Der Vorgaenger-Bau
# daneben hat es; er wird NUR zum Anzeigen benutzt, gemessen wird durchweg mit
# dem oben gewaehlten FFmpeg.
$PlayKandidaten = @(
  (Join-Path $LaborRoot 'ffmpeg-patched\bin\ffplay.exe'),
  (Join-Path $SidecarRoot 'ffmpeg-dist\n8.1-lgpl-shared.vorher\bin\ffplay.exe')
)
$PlayBin = $PlayKandidaten | Where-Object { Test-Path $_ } | Select-Object -First 1

$VlcPfade = @(
  "$env:ProgramFiles\VideoLAN\VLC\vlc.exe",
  "${env:ProgramFiles(x86)}\VideoLAN\VLC\vlc.exe"
)
$ChromePfade = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
)

if (-not (Test-Path $Bin)) {
  throw "Sidecar fehlt: $Bin  (cargo build --release --bins im win-hq-sidecar)"
}
New-Item -ItemType Directory -Force -Path $Ablage | Out-Null

# --- Werkzeuge aufrufen, ohne in die PowerShell-5.1-Falle zu treten ---------
#
# **Nicht `& ffmpeg ... 2>&1`.** Windows PowerShell 5.1 verpackt jede
# stderr-Zeile eines nativen Programms in einen ErrorRecord, sobald man sie
# umleitet; mit `$ErrorActionPreference = 'Stop'` bricht das Skript dann mitten
# in der Auswertung ab, obwohl ffmpeg mit 0 zurueckkam. Deshalb ueber Dateien.
function Invoke-Werkzeug {
  param([string]$Exe, [string[]]$Argumente)
  $o = [System.IO.Path]::GetTempFileName()
  $e = [System.IO.Path]::GetTempFileName()
  $p = Start-Process -FilePath $Exe -ArgumentList $Argumente -NoNewWindow -Wait -PassThru `
         -RedirectStandardOutput $o -RedirectStandardError $e
  $r = [pscustomobject]@{
    Aus = (Get-Content $o -Raw); Fehler = (Get-Content $e -Raw); Code = $p.ExitCode
  }
  Remove-Item $o, $e -Force
  $r
}

# --- Was auf dem Schirm laeuft ----------------------------------------------
function Start-Inhalt {
  if ($Inhalt) {
    $vlc = $VlcPfade | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($vlc) {
      $p = Start-Process -FilePath $vlc -PassThru -ArgumentList @(
        '--fullscreen','--loop','--no-video-title-show','--no-qt-privacy-ask',
        '--qt-notification=0', (Resolve-Path $Inhalt).Path)
      Start-Sleep -Seconds 12   # VLC-Kaltstart + Vollbild + Video-Anlauf
      return $p
    }
    $exe = $ChromePfade | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $exe) { throw "Weder VLC noch Chrome/Edge gefunden -- ohne Abspieler kein HDR-Inhalt" }
    Write-Host "  (kein VLC -- Rueckfall auf den Browser, der hier nur SDR-Weiss liefert)" -ForegroundColor Yellow
    $seite = Join-Path $Ablage 'inhalt.html'
    $quelle = (Resolve-Path $Inhalt).Path -replace '\\','/'
    # Eigenes Profilverzeichnis: sonst uebernimmt eine laufende Chrome-Instanz
    # den Aufruf, das Fenster geht irgendwo auf und der Prozess ist sofort weg.
    $profil = Join-Path $Ablage 'chrome-profil'
    @"
<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:#000;overflow:hidden}
video{width:100vw;height:100vh;object-fit:fill}</style>
<video src="file:///$quelle" autoplay loop muted playsinline></video>
"@ | Set-Content -Path $seite -Encoding UTF8
    $p = Start-Process -FilePath $exe -PassThru -ArgumentList @(
      '--kiosk', "--user-data-dir=$profil", '--no-first-run', '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required', '--disable-features=Translate',
      ("file:///" + ($seite -replace '\\','/')))
    Start-Sleep -Seconds 6   # Chrome-Kaltstart + Video-Anlauf
    return $p
  }
  if (-not $PlayBin) {
    Write-Host "  (kein ffplay -- aufgenommen wird der Schirm, wie er ist)" -ForegroundColor DarkGray
    return $null
  }
  # **`SDL_RENDER_DRIVER=software` nachgetragen am 2026-08-11**, aus demselben
  # Grund wie in `nvidia-intra-refresh-nachweis.ps1`: ohne die Variable bleibt
  # der ffplay-Fensterinhalt in der WGC-Aufnahme schwarz, der Desktop
  # drumherum aber nicht. Herleitung: `nvidia-zehnbit-nachweis.ps1`.
  $env:SDL_RENDER_DRIVER = 'software'
  $p = Start-Process -FilePath $PlayBin -PassThru -ArgumentList @(
    '-hide_banner','-loglevel','error','-fs','-autoexit',
    '-f','lavfi','-i',"testsrc2=size=1920x1080:rate=$Fps")
  Start-Sleep -Seconds 3
  return $p
}

# --- Ein Lauf ---------------------------------------------------------------
#
# `push_url` ist ein Dateipfad: `url_format_hint` liefert dafuer `None`, der
# Muxer schreibt den rohen Bitstrom. Kein Netz, kein Muxer-Sonderweg -- und
# damit auch keine Frage, ob der Transportweg die Farbangaben durchreicht.
function Invoke-Lauf {
  param([bool]$Hdr, [string]$Ziel)

  if (Test-Path $Ziel) { Remove-Item -Force $Ziel }
  $flag = if ($Hdr) { 'true' } else { 'false' }
  $url  = $Ziel -replace '\\','\\\\'
  # `bit_depth: 10` steht auch im HDR-Lauf ausdruecklich da, obwohl HDR es
  # selbst einschaltet: der Vergleichslauf soll sich NUR in HDR unterscheiden,
  # nicht zusaetzlich in der Bittiefe. Sonst maesse man zwei Dinge auf einmal.
  $start = '{"op":"start","id":2,"channel":{"id":"1","token":"","push_url":"' + $url +
           '"},"capture":"monitor","audio":{"mode":"Aus"},"overrides":{"codec":"av1' +
           '","bit_depth":10,"bitrate_kbps":' + $Bitrate + ',"fps":' + $Fps +
           ',"resolution":"' + $Aufloesung + '","hdr":' + $flag + '}}'

  $anzeige = Start-Inhalt

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Bin
  $psi.WorkingDirectory = $SidecarRoot
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput  = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError  = $true

  $p  = [System.Diagnostics.Process]::Start($psi)
  # stderr am Ende in EINEM Stueck lesen -- `Register-ObjectEvent` hat auf der
  # AMD-Maschine Zeilen verschluckt, und zwar die aussagekraeftigen.
  $so = $p.StandardOutput.ReadToEndAsync()
  $se = $p.StandardError.ReadToEndAsync()

  $p.StandardInput.WriteLine($start)
  $p.StandardInput.Flush()
  Start-Sleep -Seconds $Sekunden
  $p.StandardInput.WriteLine('{"op":"stop","id":3}')
  $p.StandardInput.Flush()
  Start-Sleep -Seconds 2
  # stdin BLEIBT bis hierher offen: EOF faehrt den Sidecar sofort herunter.
  $p.StandardInput.Close()
  if (-not $p.WaitForExit(15000)) { $p.Kill() }

  if ($anzeige -and -not $anzeige.HasExited) { try { $anzeige | Stop-Process -Force } catch {} }
  # Chrome verteilt sich auf mehrere Prozesse; der gestartete allein reicht
  # nicht. **Ueber das Profilverzeichnis gesucht, NICHT ueber den Namen** --
  # sonst raeumt ein Messlauf nebenbei die Browser-Sitzung des Nutzers weg.
  # (VLC braucht das nicht, dort genuegt der eine Prozess.)
  if ($Inhalt) {
    $profil = Join-Path $Ablage 'chrome-profil'
    Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" |
      Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profil) } |
      ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
  }

  $stderr = $se.Result
  $null = $so.Result
  Set-Content -Path "$Ziel.stderr.log" -Value $stderr -Encoding utf8
  [pscustomobject]@{ Stderr = $stderr; Datei = $Ziel }
}

# --- 1. Was der Strom ueber sich sagt ---------------------------------------
function Get-Farbangaben {
  param([string]$Datei)
  # **`csv=p=0` waere hier falsch**, obwohl es kuerzer ist: ffprobe gibt die
  # Felder in SEINER Reihenfolge aus, nicht in der angefragten.
  $r = Invoke-Werkzeug (Join-Path $FfBin 'ffprobe.exe') @(
    '-v','error','-f','obu','-select_streams','v:0',
    '-show_entries','stream=pix_fmt,width,height,color_space,color_transfer,color_primaries,color_range',
    '-of','default=noprint_wrappers=1',$Datei)
  $f = @{}
  foreach ($z in ("$($r.Aus)" -split "`n")) {
    if ($z -match '^\s*([a-z_]+)=(.*?)\s*$') { $f[$Matches[1]] = $Matches[2] }
  }
  [pscustomobject]@{
    PixFmt = $f['pix_fmt']; Breite = [int]$f['width']; Hoehe = [int]$f['height']
    Raum = $f['color_space']; Kurve = $f['color_transfer']
    Primaer = $f['color_primaries']; Bereich = $f['color_range']
  }
}

# Die Begleitdaten getrennt und in FLACHER Ausgabe holen.
#
# **Nicht aus Geschmack:** `-show_entries frame=side_data_list -of json` liefert
# die Liste zwar, aber mit LEEREN Objekten darin -- der Typ und die Werte
# fehlen. Das sieht aus wie "keine Metadaten im Strom" und ist in Wahrheit eine
# Eigenheit der Ausgabeform. Am 2026-08-06 hat genau das einen Fehlalarm
# erzeugt. Die flache Form gibt jedes Feld einzeln aus.
function Get-Begleitdaten {
  param([string]$Datei)
  $r = Invoke-Werkzeug (Join-Path $FfBin 'ffprobe.exe') @(
    '-v','error','-f','obu','-select_streams','v:0',
    '-show_frames','-read_intervals','%+#1','-of','flat',$Datei)
  @("$($r.Aus)" -split "`n" | Select-String -Pattern 'side_data_type="([^"]+)"' |
      ForEach-Object { $_.Matches[0].Groups[1].Value })
}

# --- 2. Was wirklich drinsteckt ---------------------------------------------
#
# **NICHT Bild 0.** Das erste Bild ist das Vollbild und auch dann richtig, wenn
# alle folgenden es nicht sind -- so lag der 10-Bit-Fehler am 2026-08-02 zwei
# Tage lang verdeckt.
function Get-Bildpunkte {
  param([string]$Datei)
  $r = Invoke-Werkzeug (Join-Path $FfBin 'ffmpeg.exe') @(
    '-v','error','-f','obu','-i',$Datei,
    '-vf',"select=eq(n\,$Bild),signalstats,metadata=print:file=-",
    '-frames:v','1','-f','null','-')
  $w = @{}
  foreach ($z in ("$($r.Aus)" -split "`n")) {
    if ($z -match 'lavfi\.signalstats\.([A-Z]+)=([\d\.\-]+)') {
      $w[$Matches[1]] = [double]$Matches[2]
    }
  }
  if ($w.Count -eq 0) { return $null }
  [pscustomobject]@{ YMin = $w['YMIN']; YAvg = $w['YAVG']; YMax = $w['YMAX']
                     UAvg = $w['UAVG']; VAvg = $w['VAVG'] }
}

# PQ-Codewert (10 bit, Studio-Bereich) -> cd/m2, nach SMPTE ST 2084.
# Das ist die Umrechnung, die aus "Code 601" die Aussage "275 cd/m2" macht --
# ohne sie ist die Zahl nicht lesbar.
function ConvertTo-Nits {
  param([double]$Code)
  $e = ($Code - 64.0) / (940.0 - 64.0)
  if ($e -le 0) { return 0.0 }
  if ($e -gt 1) { $e = 1.0 }
  $m1 = 0.1593017578125; $m2 = 78.84375
  $c1 = 0.8359375; $c2 = 18.8515625; $c3 = 18.6875
  $p = [Math]::Pow($e, 1.0 / $m2)
  $z = [Math]::Max($p - $c1, 0.0) / ($c2 - $c3 * $p)
  [Math]::Pow($z, 1.0 / $m1) * 10000.0
}

# --- Reihe ------------------------------------------------------------------
Write-Host "=== HDR-Nachweis, $(Get-Date -Format 'yyyy-MM-dd HH:mm') ===" -ForegroundColor Cyan
Write-Host "Ablage: $Ablage"
Write-Host "FFmpeg: $FfBin"
$abspieler = if (-not $Inhalt) { 'testsrc2 ueber ffplay' }
             elseif ($VlcPfade | Where-Object { Test-Path $_ }) { "$Inhalt (VLC, Vollbild)" }
             else { "$Inhalt (Browser, Kiosk -- nur SDR-Weiss)" }
Write-Host "Inhalt: $abspieler"

$ergebnisse = @()
foreach ($fall in @(@{n='sdr'; hdr=$false}, @{n='hdr'; hdr=$true})) {
  $ziel = Join-Path $Ablage "$($fall.n).obu"
  Write-Host "`n--- Lauf '$($fall.n)' ---" -ForegroundColor Yellow
  $r = Invoke-Lauf -Hdr $fall.hdr -Ziel $ziel

  # Die Zeilen, die die Kette belegen -- jede stammt aus einer anderen Stufe.
  foreach ($muster in @('\[hdr\]','\[aufnahme\]','\[pipeline-hw\] capture','\[encode\] Encoder offen','\[encode\] HDR-Signalisierung','HDR verlangt')) {
    $r.Stderr -split "`n" | Where-Object { $_ -match $muster } | ForEach-Object {
      Write-Host "  $($_.Trim())"
    }
  }

  if (-not (Test-Path $ziel) -or (Get-Item $ziel).Length -eq 0) {
    Write-Host "  KEIN STROM -- s. Meldung oben" -ForegroundColor Red
    $ergebnisse += [pscustomobject]@{ Lauf=$fall.n; Bytes=0; Angaben=$null; Sd=@(); Punkte=$null }
    continue
  }
  $groesse = (Get-Item $ziel).Length
  # **Die Groesse ist die Warnlampe fuer eine schwarze Aufnahme** (s.
  # `nvidia-zehnbit-nachweis.ps1`): ohne echten Inhalt sagen die Bildpunkte
  # unten nichts.
  if ($groesse -lt 1MB) {
    Write-Host ("  WARNUNG: nur $groesse Bytes -- die Aufnahme war vermutlich schwarz") -ForegroundColor Red
  }
  $angaben = Get-Farbangaben $ziel
  $sd = Get-Begleitdaten $ziel
  $punkte = Get-Bildpunkte $ziel
  Write-Host "  Datei: $groesse Bytes"
  Write-Host ("  sagt:  pix_fmt={0} raum={1} kurve={2} primaer={3} bereich={4}" -f `
    $angaben.PixFmt, $angaben.Raum, $angaben.Kurve, $angaben.Primaer, $angaben.Bereich)
  if ($sd.Count -gt 0) { foreach ($e in $sd) { Write-Host "  Begleitdaten: $e" } }
  else { Write-Host "  Begleitdaten: keine" }
  if ($punkte) {
    Write-Host ("  ist:   Bild {0}: Y {1} / {2:N1} / {3} (min/mittel/max), UAVG {4:N1} VAVG {5:N1}" -f `
      $Bild, $punkte.YMin, $punkte.YAvg, $punkte.YMax, $punkte.UAvg, $punkte.VAvg)
    if ($fall.hdr) {
      Write-Host ("         als PQ gelesen: Spitze {0:N0} cd/m2, Mittel {1:N2} cd/m2" -f `
        (ConvertTo-Nits $punkte.YMax), (ConvertTo-Nits $punkte.YAvg))
    }
  } else {
    Write-Host "  ist:   KEIN BILD $Bild" -ForegroundColor Red
  }
  $ergebnisse += [pscustomobject]@{ Lauf=$fall.n; Bytes=$groesse; Angaben=$angaben; Sd=$sd; Punkte=$punkte }
}

Write-Host "`n=== Urteil ===" -ForegroundColor Cyan
$hdr = $ergebnisse | Where-Object Lauf -eq 'hdr'
$sdr = $ergebnisse | Where-Object Lauf -eq 'sdr'
if (-not $hdr.Angaben) {
  Write-Host "HDR-Lauf lieferte keinen Strom." -ForegroundColor Red
  exit 1
}

# Teil 1: die Signalisierung. **Das ist der Pflichtteil** -- ohne diese vier
# Angaben deutet jeder Zuschauer den Strom als BT.709/SDR, und alles Weitere
# ist einerlei.
Write-Host "Signalisierung (Pflicht):"
$ok = $true
foreach ($p in @(
    @{f='Kurve';   soll='smpte2084'},
    @{f='Primaer'; soll='bt2020'},
    @{f='Raum';    soll='bt2020nc'},
    @{f='PixFmt';  soll='yuv420p10le'})) {
  $ist = $hdr.Angaben.($p.f)
  if ($ist -eq $p.soll) { Write-Host "  OK    $($p.f) = $ist" -ForegroundColor Green }
  else { Write-Host "  FEHLT $($p.f): $ist statt $($p.soll)" -ForegroundColor Red; $ok = $false }
}

# Teil 2: die Bildpunkte. Ein SDR-Bild unter PQ-Etikett klemmt oben an; ein
# echtes PQ-Bild tut das nicht, weil die Kurve denselben Inhalt viel tiefer
# ablegt. Der SDR-Lauf ist die Gegenprobe dazu.
Write-Host "Bildpunkte (Pflicht):"
if (-not $hdr.Punkte) {
  Write-Host "  FEHLT kein Bild $Bild im HDR-Lauf" -ForegroundColor Red; $ok = $false
} else {
  $spitze = ConvertTo-Nits $hdr.Punkte.YMax
  if ($sdr.Punkte) {
    Write-Host ("  Vergleich Y-max: SDR-Lauf {0}, HDR-Lauf {1}" -f $sdr.Punkte.YMax, $hdr.Punkte.YMax)
  }
  # 940 ist der nominelle Weisspunkt im Studio-Bereich. Liegt die Spitze eines
  # PQ-Stroms dort oder darueber, ist die Kurve NICHT angewandt worden -- dann
  # steckt SDR unter dem HDR-Etikett.
  if ($hdr.Punkte.YMax -ge 940) {
    Write-Host ("  FEHLT Y-max {0} liegt am SDR-Weisspunkt -- die PQ-Kurve wurde nicht angewandt" -f $hdr.Punkte.YMax) -ForegroundColor Red
    $ok = $false
  } else {
    Write-Host ("  OK    Y-max {0} => {1:N0} cd/m2, die PQ-Kurve rechnet wirklich" -f $hdr.Punkte.YMax, $spitze) -ForegroundColor Green
  }
  # **Und wo die Grenze dieser einen Pruefung liegt.** Reicht der Inhalt bis an
  # das obere Ende des PQ-Bereichs (ein PQ-Testbild tut das absichtlich), dann
  # liegen "gewandelt" und "nicht gewandelt" beide knapp unter 940 und die
  # Klemm-Pruefung trennt sie nicht mehr. Sie trennt scharf bei GEWOEHNLICHEM
  # Inhalt -- deshalb gehoeren beide Laeufe zur Messung, nicht nur der
  # spektakulaere.
  if ($sdr.Punkte -and $hdr.Punkte.YMax -gt 900 -and $sdr.Punkte.YMax -gt 900) {
    Write-Host "  HINWEIS beide Laeufe liegen oben an -- fuer die Klemm-Frage zusaetzlich ohne -Inhalt laufen lassen" -ForegroundColor Yellow
  }
  # Und die Zusatzfrage: hatte der Inhalt ueberhaupt Spitzlichter? Ein
  # SDR-Programm auf einem HDR-Desktop bleibt bei SDR-Weiss (rund 80 bis 250
  # cd/m2). Ohne echten HDR-Inhalt ist die obige Zahl zwar richtig, sagt aber
  # nichts darueber, ob HELLES durchkommt.
  if ($spitze -lt 260) {
    Write-Host ("  HINWEIS Spitze {0:N0} cd/m2 liegt im SDR-Bereich -- der Inhalt hatte keine echten Spitzlichter. Mit -Inhalt <pq-clip.mp4> wiederholen." -f $spitze) -ForegroundColor Yellow
  } else {
    Write-Host ("  OK    Spitze {0:N0} cd/m2 liegt ueber SDR-Weiss -- echte Spitzlichter kommen durch" -f $spitze) -ForegroundColor Green
  }
}

# Teil 3: die Mastering-Hinweise. **Kein Pflichtteil, und das ist eine
# Entscheidung, keine Nachlaessigkeit**: sie sind Hinweise fuer das
# Tone-Mapping des Zuschauers, nicht Bestandteil der Bilddeutung. Auf NVIDIA
# fehlen sie treiberbedingt ganz (2026-08-11), auf AMD sind sie da, aber falsch
# skaliert (2026-08-06, Befund 3). Ein Strom ohne sie ist HDR; ein Strom ohne
# Teil 1 ist es nicht.
Write-Host "Mastering-Hinweise (Zusatz):"
foreach ($t in @('Mastering display metadata','Content light level metadata')) {
  if ($hdr.Sd -contains $t) { Write-Host "  OK    $t" -ForegroundColor Green }
  else { Write-Host "  fehlt $t" -ForegroundColor Yellow }
}

if ($ok) { Write-Host "`nDer Strom traegt HDR." -ForegroundColor Green; exit 0 }
Write-Host "`nDer Strom traegt KEIN HDR." -ForegroundColor Red
exit 1
