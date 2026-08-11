# Liefert der Windows-Sidecar auf NVIDIA wirklich 10 bit, wenn 10 bit bestellt
# ist -- oder einen 8-bit-Strom unter 10-bit-Etikett?
#
# Diese Datei ist bewusst REIN ASCII, ohne Umlaute und ohne Gedankenstriche:
# Windows PowerShell 5.1 liest ein `.ps1` ohne BOM als ANSI, und aus dem UTF-8-
# Byte eines Gedankenstrichs wird dabei ein Anfuehrungszeichen, das mitten im
# Satz eine Zeichenkette beendet (dieselbe Falle wie in
# `nvidia-intra-refresh-nachweis.ps1`).
#
# ## Warum es dieses Skript gibt
#
# `encode/opts.rs::vendor_encoder_opts` setzt die Bittiefe NUR im AMD-Zweig
# (`bitdepth=10`), der NVIDIA-Zweig setzt dazu gar nichts -- und der Kommentar
# dort sagt ausdruecklich, dass ein P010-Pool ALLEIN nicht genuegt, weil AMF
# sonst trotz P010-Eingang 8 bit liefert. Gleichzeitig meldet
# `VideoCodec::supports_ten_bit` rein codecabhaengig "AV1 kann 10 bit", und
# `health` bietet es auf dieser Karte an. Ob `av1_nvenc` die Tiefe aus dem
# Pixelformat zieht oder still auf 8 bit zurueckfaellt, war offen.
#
# ## Zwei getrennte Nachweise, weil sie verschiedene Fehler fangen
#
#   1. WAS DER STROM UEBER SICH SAGT -- `high_bitdepth` im AV1-Sequenzkopf
#      (per `trace_headers` am Bitstrom, nicht am Log des Senders) und das
#      `pix_fmt`, das ffprobe daraus ableitet.
#   2. WAS WIRKLICH DRINSTECKT -- Bildpunkt-Praezision, `zehnbit-praezision.py`:
#      ein aus 8 bit hochgeschobener Wert ist immer durch 4 teilbar, eine echte
#      10-bit-Rechnung trifft alle vier Reste.
#
# Nur 1 waere kein Beleg. Das Etikett kommt aus dem Sequenzkopf, und den
# schreibt der Encoder aus seiner KONFIGURATION -- ein Encoder, der intern auf
# 8 bit kappt und trotzdem `high_bitdepth=1` schreibt, faellt dort nicht auf.
# Genau diese Fehlerklasse hat das Projekt zweimal getroffen (`h264_d3d12va`
# nimmt `-intra-refresh` an und tut nichts damit; `avcodec_open2` schluckt
# Farbfelder, die der Encoder nie weiterreicht).
#
# ## DIE FALLE IN NACHWEIS 2, und sie ist teuer
#
# **Bei zu niedriger Bitrate sagt die Rest-Verteilung nichts.** Auf einem
# glatten Verlauf bei 4000 kbps liefert derselbe, nachweislich echte 10-bit-Weg
# (`av1_nvenc` mit p010-Eingang ueber die Kommandozeile) 81,3 % Rest 0 und damit
# das Urteil "unklar" -- nicht weil die Tiefe fehlte, sondern weil die
# Quantisierung die Rekonstruktion auf grobe Stufen zieht. Bei 12000 kbps
# derselbe Aufbau: 12,8 / 12,9 / 32,2 / 42,1 %, eindeutig. Die Vorgabe steht
# deshalb auf 12000 kbps; wer sie senkt, misst die Ratensteuerung statt der
# Bittiefe.
#
# ## Was es NICHT beantwortet
#
# Ob ein Zuschauer den 10-bit-Strom dekodiert (Chromiums Software-Rueckfall
# kann es nicht, s. `win-hq-labor/CLAUDE.md`), und ob HDR getragen wird -- das
# ist eine andere Frage mit eigenem Skript (`hdr-nachweis.ps1`).
#
#   -Laeufe   Wiederholungen je Variante (Vorgabe 3 - ein Lauf traegt nichts)
#   -Bild     welches Bild ausgewertet wird. NICHT 0: das erste Bild ist das
#             Vollbild und auch dann richtig, wenn alle folgenden es nicht sind.
#   -Tiefen   welche Bittiefen. **Mit `-Command` aufrufen, nicht mit `-File`**:
#             `powershell -File ... -Tiefen 10,8` reicht die Liste als EINEN
#             String durch, daraus wird die Zahl 108, und der Lauf misst
#             klaglos 8 bit unter der Ueberschrift "108 bit".
param(
  [int]$Laeufe = 3,
  [int]$Sekunden = 20,
  [int]$Bitrate = 12000,
  [int]$Fps = 60,
  [string]$Aufloesung = '1080p',
  [int]$Bild = 90,
  [int[]]$Tiefen = @(10, 8),
  [string]$Ablage = ''
)
$ErrorActionPreference = 'Stop'

$LaborRoot   = Split-Path $PSScriptRoot -Parent
$SidecarRoot = Join-Path (Split-Path $LaborRoot -Parent) 'win-hq-sidecar'
$Bin         = Join-Path $SidecarRoot 'target\release\pulse-win-hq-sidecar.exe'
$FfBin       = Join-Path $SidecarRoot 'ffmpeg-dist\n8.1-lgpl-shared\bin'
# `ffplay` fehlt im ausgelieferten Bau (der ist ohne SDL gebaut). Der
# Vorgaenger-Bau daneben hat es; er wird hier NUR zum Anzeigen benutzt, nicht
# zum Messen -- gemessen wird durchweg mit dem gebuendelten, gepatchten FFmpeg.
$PlayBin     = Join-Path $SidecarRoot 'ffmpeg-dist\n8.1-lgpl-shared.vorher\bin\ffplay.exe'
$Praezision  = Join-Path $PSScriptRoot 'zehnbit-praezision.py'
if (-not $Ablage) { $Ablage = Join-Path $env:TEMP 'pulse-nvidia-10bit' }
New-Item -ItemType Directory -Force -Path $Ablage | Out-Null

if (-not (Test-Path $Bin)) {
  throw "Sidecar fehlt: $Bin  (cargo build --release --bins im win-hq-sidecar)"
}

# --- Ein Lauf ---------------------------------------------------------------
#
# `push_url` ist ein Dateipfad: `url_format_hint` liefert dafuer `None`, der
# Muxer schreibt eine Datei statt zu pushen. Kein Netz, kein Server -- und der
# Encode-Weg ist derselbe wie im Betrieb, seit der Sendeweg den Encoder nicht
# mehr bestimmt.
function Invoke-Lauf {
  param([int]$Tiefe, [string]$Ziel)

  if (Test-Path $Ziel) { Remove-Item -Force $Ziel }
  $url = $Ziel -replace '\\','\\\\'
  $start = '{"op":"start","id":2,"channel":{"id":"1","token":"","push_url":"' + $url +
           '"},"capture":"monitor","audio":{"mode":"Aus"},"overrides":{"codec":"av1' +
           '","bit_depth":' + $Tiefe + ',"bitrate_kbps":' + $Bitrate + ',"fps":' + $Fps +
           ',"resolution":"' + $Aufloesung + '"}}'

  # Verlaeufe UND Bewegung sind hier Pflicht, anders als beim HDR-Nachweis:
  # ein einfarbiges Bild hat immer wenige Y-Werte, und dann sagt die
  # Rest-Verteilung nichts. `gradients` liefert beides in einem -- weiche
  # Rampen ueber die ganze Flaeche, die ueber die Zeit wandern.
  #
  # **`SDL_RENDER_DRIVER=software` ist Pflicht, sonst nimmt man Schwarz auf.**
  # Mit SDLs Vorgabe-Renderer bleibt der FENSTERINHALT in der WGC-Aufnahme
  # schwarz, waehrend der Desktop drumherum sauber ankommt -- das Fenster
  # liegt dann auf einer Ebene, die die Aufnahme nicht sieht.
  #
  # **Hier stand zuerst, das liege am Vollbild (`-fs`) und ein rahmenloses
  # Fenster sei die Abhilfe. Das ist falsch**, und der Irrtum steht hier, weil
  # er nach dem ersten Lauf voellig plausibel aussah (ohne `-fs` UND mit
  # Software-Renderer war das Bild da, also schien `-fs` schuld). Die
  # Halbierung ueber alle vier Kombinationen sagt etwas anderes -- mittlere
  # Helligkeit eines Bildabzugs aus dem Fensterinneren, 0 bis 765:
  #
  #                  Vollbild   Fenster
  #     direct3d          0,0       0,0
  #     software        621,7     553,5
  #
  # Die Zeile entscheidet der RENDERER, nicht die Fenstergroesse. Das
  # rahmenlose Fenster unten ist damit reine Nebensache und bleibt nur
  # stehen, weil die Messreihe vom 2026-08-11 so gefahren wurde.
  #
  # **Folge fuer die Nachbarskripte:** `nvidia-intra-refresh-nachweis.ps1` und
  # `hdr-nachweis.ps1` starten ffplay ohne diese Variable. Auf dieser Maschine
  # nehmen sie damit heute Schwarz auf -- am 2026-08-04 taten sie es
  # nachweislich nicht (die Messakte `nvidia-2026-08-04-windows-intra-refresh`
  # zeigt 700 Bilder bei 4132 kbit/s, das ist echter Inhalt). Was sich
  # dazwischen geaendert hat, ist NICHT bestimmt; der Treiber ist derselbe
  # (32.0.16.1047). Beide Skripte haben die Variable deshalb nachgetragen
  # bekommen.
  #
  # Die Dateigroesse ist die Warnlampe dafuer (s. unten).
  $ffplay = $null
  if (Test-Path $PlayBin) {
    $env:SDL_RENDER_DRIVER = 'software'
    $ffplay = Start-Process -FilePath $PlayBin -PassThru -ArgumentList @(
      '-hide_banner','-loglevel','error','-noborder','-autoexit',
      '-x','2400','-y','1320','-left','40','-top','40',
      '-f','lavfi','-i',"gradients=s=2400x1320:n=6:rate=$($Fps):speed=0.05:d=3600")
    Start-Sleep -Seconds 3
  } else {
    Write-Host "  (kein ffplay -- aufgenommen wird der Schirm, wie er ist; die Praezisionszahl ist dann wertlos)" -ForegroundColor Red
  }

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
  if ($ffplay -and -not $ffplay.HasExited) { try { $ffplay | Stop-Process -Force } catch {} }

  $stderr = $se.Result
  $null = $so.Result
  Set-Content -Path "$Ziel.stderr.log" -Value $stderr -Encoding utf8
  # Der Encode-WEG gehoert in jede Messung (Regel 2 in `win-hq-labor/CLAUDE.md`):
  # ein Lauf, der still ueber die CPU-Pipeline gelaufen ist, beantwortet eine
  # andere Frage als die gestellte.
  $zeilen = $stderr -split "`n"
  [pscustomobject]@{
    Offen     = "$($zeilen | Select-String 'Encoder offen' | Select-Object -First 1)".Trim()
    Weg       = "$($zeilen | Select-String 'pipeline-hw\] capture' | Select-Object -First 1)".Trim()
    Delegiert = @($zeilen | Select-String 'Delegation an|CPU-Pipeline|Fallback').Count
  }
}

# --- Werkzeuge aufrufen, ohne in die PowerShell-5.1-Falle zu treten ---------
#
# **Nicht `& ffmpeg ... 2>&1`.** Windows PowerShell 5.1 verpackt jede
# stderr-Zeile eines nativen Programms in einen ErrorRecord, sobald man sie
# umleitet; mit `$ErrorActionPreference = 'Stop'` bricht das Skript dann mitten
# in der Auswertung ab, obwohl ffmpeg mit 0 zurueckkam. ffmpeg schreibt aber
# ALLES auf stderr, auch die `trace_headers`-Ausgabe, die hier gebraucht wird.
# Deshalb ueber Dateien.
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

# --- 1. Was der Strom ueber sich sagt ---------------------------------------
function Get-Selbstauskunft {
  param([string]$Datei)
  # **`csv=p=0` waere hier falsch**, obwohl es kuerzer ist: ffprobe gibt die
  # Felder in SEINER Reihenfolge aus, nicht in der angefragten. Die Spalten
  # verschieben sich damit lautlos, und `pix_fmt` landet in `Breite`. Deshalb
  # Schluessel=Wert und namentlich zugreifen.
  $r = Invoke-Werkzeug (Join-Path $FfBin 'ffprobe.exe') @(
    '-v','error','-f','obu','-select_streams','v:0',
    '-show_entries','stream=pix_fmt,width,height,color_space,color_transfer,color_primaries,color_range',
    '-of','default=noprint_wrappers=1',$Datei)
  $f = @{}
  foreach ($z in ("$($r.Aus)" -split "`n")) {
    if ($z -match '^\s*([a-z_]+)=(.*?)\s*$') { $f[$Matches[1]] = $Matches[2] }
  }
  # `high_bitdepth` steht im AV1-Sequenzkopf. Das ist die Aussage des BITSTROMS;
  # `pix_fmt` ist nur, was ffprobe daraus ableitet.
  $tr = (Invoke-Werkzeug (Join-Path $FfBin 'ffmpeg.exe') @(
    '-v','trace','-f','obu','-i',$Datei,'-c','copy',
    '-bsf:v','trace_headers','-frames:v','1','-f','null','-')).Fehler -split "`n"
  $hb = ($tr | Select-String 'high_bitdepth\s+(\d)' | Select-Object -First 1)
  $hbw = if ($hb) { $hb.Matches[0].Groups[1].Value } else { '?' }
  [pscustomobject]@{
    PixFmt = $f['pix_fmt']; Breite = [int]$f['width']; Hoehe = [int]$f['height']
    Raum = $f['color_space']; Kurve = $f['color_transfer']
    Primaer = $f['color_primaries']; Bereich = $f['color_range']
    HighBitdepth = $hbw
  }
}

# --- 2. Was wirklich drinsteckt ---------------------------------------------
function Get-Praezision {
  param([string]$Datei, [int]$Breite, [int]$Hoehe)
  $roh = "$Datei.b$Bild.raw"
  # Immer nach yuv420p10le dekodieren, auch im 8-bit-Lauf. Dort hebt swscale
  # mit einem glatten `<<2` an (nachgeprueft: 100,0 % Rest 0) -- der 8-bit-Lauf
  # ist damit die Negativ-Kontrolle, die zeigt, dass die Kennzahl den Fall
  # ueberhaupt anzeigen WUERDE.
  $null = Invoke-Werkzeug (Join-Path $FfBin 'ffmpeg.exe') @(
    '-v','error','-f','obu','-i',$Datei,
    '-vf',"select=eq(n\,$Bild)",'-frames:v','1','-pix_fmt','yuv420p10le','-f','rawvideo','-y',$roh)
  if (-not (Test-Path $roh) -or (Get-Item $roh).Length -lt ($Breite * $Hoehe * 2)) {
    return [pscustomobject]@{ Verschieden = 0; R0 = 0; R1 = 0; R2 = 0; R3 = 0; Befund = 'KEIN BILD' }
  }
  $aus = (Invoke-Werkzeug 'python' @($Praezision, $roh, "$Breite", "$Hoehe")).Aus -split "`n"
  $v = ($aus | Select-String 'verschiedene Werte:\s+(\d+)').Matches[0].Groups[1].Value
  $r = @()
  foreach ($i in 0..3) {
    $r += [double](($aus | Select-String "^\s+$($i):\s+([\d,\.]+) %").Matches[0].Groups[1].Value -replace ',','.')
  }
  $befund = "$($aus | Select-String '=> BEFUND:')" -replace '.*BEFUND:\s*',''
  [pscustomobject]@{
    Verschieden = [int]$v; R0 = $r[0]; R1 = $r[1]; R2 = $r[2]; R3 = $r[3]; Befund = $befund.Trim()
  }
}

# --- Reihe ------------------------------------------------------------------
Write-Host "=== 10-bit-Nachweis NVIDIA, $(Get-Date -Format 'yyyy-MM-dd HH:mm') ===" -ForegroundColor Cyan
Write-Host "Ablage: $Ablage   Bitrate: $Bitrate kbps   Bild: $Bild"

$ergebnisse = @()
foreach ($lauf in 1..$Laeufe) {
  foreach ($tiefe in $Tiefen) {
    $ziel = Join-Path $Ablage ("{0}-av1-{1}bit.obu" -f $lauf, $tiefe)
    Write-Host ("`n### Lauf {0}  av1  {1} bit" -f $lauf, $tiefe) -ForegroundColor Yellow
    $lz = Invoke-Lauf -Tiefe $tiefe -Ziel $ziel
    Write-Host ("    {0}" -f $lz.Weg)
    Write-Host ("    {0}" -f $lz.Offen)
    if (-not (Test-Path $ziel) -or (Get-Item $ziel).Length -eq 0) {
      Write-Host "    KEIN STROM -- s. $ziel.stderr.log" -ForegroundColor Red
      continue
    }
    # **Die Groesse ist die Warnlampe fuer eine schwarze Aufnahme.** Ein
    # 20-s-Lauf bei 12000 kbps wiegt zweistellige Megabyte; ein paar Kilobyte
    # heisst, der Encoder hat eine unveraenderte Flaeche komprimiert. Ohne
    # diesen Hinweis liest man die Rest-Verteilung eines schwarzen Bildes als
    # Befund -- genau das ist beim ersten Anlauf passiert (ffplay mit `-fs`).
    $bytes = (Get-Item $ziel).Length
    if ($bytes -lt 1MB) {
      Write-Host ("    WARNUNG: nur {0} Bytes -- die Aufnahme war vermutlich schwarz, die Zahlen unten sind wertlos" -f $bytes) -ForegroundColor Red
    }
    $s = Get-Selbstauskunft $ziel
    $pr = Get-Praezision -Datei $ziel -Breite $s.Breite -Hoehe $s.Hoehe
    Write-Host ("    sagt:  pix_fmt={0} high_bitdepth={1} {2}x{3} raum={4} kurve={5} primaer={6}" -f `
      $s.PixFmt, $s.HighBitdepth, $s.Breite, $s.Hoehe, $s.Raum, $s.Kurve, $s.Primaer)
    Write-Host ("    ist:   Reste {0}/{1}/{2}/{3} %  -> {4}" -f $pr.R0, $pr.R1, $pr.R2, $pr.R3, $pr.Befund)
    $ergebnisse += [pscustomobject]@{
      Lauf = $lauf; Tiefe = $tiefe; Bytes = $bytes
      PixFmt = $s.PixFmt; HighBd = $s.HighBitdepth; Masse = "$($s.Breite)x$($s.Hoehe)"
      Verschieden = $pr.Verschieden; R0 = $pr.R0; R1 = $pr.R1; R2 = $pr.R2; R3 = $pr.R3
      Befund = $pr.Befund; Delegiert = $lz.Delegiert
    }
  }
}

Write-Host ''
$ergebnisse | Format-Table -AutoSize
Write-Host "Mitschnitte, Rohbilder und stderr: $Ablage"
