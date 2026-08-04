# Traegt Intra-Refresh auf Windows+NVIDIA? Der Nachweis am AUSGELIEFERTEN
# Sidecar, ohne Labor, ohne Server, ohne Netz.
#
# Diese Datei ist bewusst REIN ASCII, ohne Umlaute und ohne Gedankenstriche:
# Windows PowerShell 5.1 liest ein `.ps1` ohne BOM als ANSI, und aus dem UTF-8-
# Byte eines Gedankenstrichs wird dabei ein Anfuehrungszeichen, das mitten im
# Satz eine Zeichenkette beendet (dieselbe Falle wie in
# `win-hq-sidecar/scripts/build-ffmpeg-patched.ps1`).
#
# ## Warum es dieses Skript zusaetzlich zu `amd-intra-refresh-nachweis.ps1` gibt
#
# Das AMD-Gegenstueck misst am dekodierenden Zuschauer ueber den Hetzner-
# Messstand. Das ist der bessere Nachweis und bleibt der Massstab - er verlangt
# aber Labor-Binary, Zugangsdaten, gepatchtes FFmpeg und eine Leitung. Auf
# NVIDIA ging es zuerst um eine engere Frage: **tut der Encoder ueberhaupt, was
# die Optionstabelle behauptet?** Die ist an einem Dateimitschnitt zu
# beantworten, und zwar auf jedem NVIDIA-Rechner ohne Vorbereitung.
#
# Gemessen wird deshalb an der DATEI, nicht am Log des Senders - die Regel aus
# `CLAUDE.md`: am 2026-08-02 meldete der Sender auf AMD zwei eingeloeste
# Vollbild-Anforderungen, in der Datei stand keine einzige.
#
# ## Was es NICHT beantwortet
#
# Was Intra-Refresh unter Paketverlust bringt. Dafuer braucht es Zuschauer,
# Verlustprofil und Server; die Antwort steht auf Linux und ist keine
# Plattformfrage (`hq-labor/CLAUDE.md`).
#
#   -Laeufe      Wiederholungen je Variante (Vorgabe 3 - ein Lauf traegt nichts)
#   -Codecs      welche Codecs
#   -Anfordern   zusaetzlicher Lauf, der per `{"op":"keyframe"}` Vollbilder
#                anfordert (Nachweis fuer `forced-idr`)
param(
  [int]$Laeufe = 3,
  [string[]]$Codecs = @('h264','av1'),
  [int]$Sekunden = 20,
  [int]$Bitrate = 4000,
  [int]$Fps = 60,
  [string]$Aufloesung = '1080p',
  [switch]$Anfordern,
  [string]$Ablage = ''
)
$ErrorActionPreference = 'Stop'

$LaborRoot   = Split-Path $PSScriptRoot -Parent
$SidecarRoot = Join-Path (Split-Path $LaborRoot -Parent) 'win-hq-sidecar'
$Bin         = Join-Path $SidecarRoot 'target\release\pulse-win-hq-sidecar.exe'
$FfBin       = Join-Path $SidecarRoot 'ffmpeg-dist\n8.1-lgpl-shared\bin'
if (-not $Ablage) { $Ablage = Join-Path $env:TEMP 'pulse-nvidia-ir' }
New-Item -ItemType Directory -Force -Path $Ablage | Out-Null

if (-not (Test-Path $Bin)) {
  throw "Sidecar fehlt: $Bin  (cargo build --release --bins im win-hq-sidecar)"
}

# --- Ein Lauf ---------------------------------------------------------------
#
# `push_url` ist ein Dateipfad: `open_output` faellt dann auf `format::output`
# zurueck und schreibt den rohen Bitstrom. Kein Netz, kein Muxer-Sonderweg.
function Invoke-Lauf {
  param([string]$Codec, [bool]$Auffrischung, [string]$Ziel, [int[]]$KeyframeBei)

  if (Test-Path $Ziel) { Remove-Item -Force $Ziel }
  $ir = if ($Auffrischung) { 'true' } else { 'false' }
  $url = $Ziel -replace '\\','\\\\'
  $start = '{"op":"start","id":2,"channel":{"id":"1","token":"","push_url":"' + $url +
           '"},"capture":"monitor","audio":{"mode":"Aus"},"overrides":{"codec":"' + $Codec +
           '","bitrate_kbps":' + $Bitrate + ',"fps":' + $Fps + ',"resolution":"' + $Aufloesung +
           '","intra_refresh":' + $ir + '}}'

  # Bewegtbild ist Pflicht. Auf einem stehenden Schirm sagt weder die
  # Bitverteilung noch die Bildgroesse etwas aus (Lehre des Linux-Pruefstands).
  $ffplay = Start-Process -FilePath (Join-Path $FfBin 'ffplay.exe') -PassThru -ArgumentList @(
    '-hide_banner','-loglevel','error','-fs','-autoexit',
    '-f','lavfi','-i',"testsrc2=size=1920x1080:rate=$Fps")
  Start-Sleep -Seconds 3

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Bin
  $psi.WorkingDirectory = $SidecarRoot
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput  = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError  = $true

  $p  = [System.Diagnostics.Process]::Start($psi)
  # stderr am Ende in EINEM Stueck lesen - `Register-ObjectEvent` hat auf der
  # AMD-Maschine Zeilen verschluckt, und zwar die aussagekraeftigen.
  $so = $p.StandardOutput.ReadToEndAsync()
  $se = $p.StandardError.ReadToEndAsync()

  $p.StandardInput.WriteLine($start)
  $p.StandardInput.Flush()
  $t0 = Get-Date

  foreach ($s in ($KeyframeBei | Sort-Object)) {
    $warte = $s - ((Get-Date) - $t0).TotalSeconds
    if ($warte -gt 0) { Start-Sleep -Milliseconds ([int]($warte * 1000)) }
    $p.StandardInput.WriteLine('{"op":"keyframe","id":9}')
    $p.StandardInput.Flush()
  }
  # Nach der letzten Anforderung noch ein paar Bilder mitnehmen - sonst endet
  # der Mitschnitt genau auf dem angeforderten Vollbild.
  $dauer = $Sekunden
  if ($KeyframeBei.Count) {
    $dauer = [math]::Max($Sekunden, ($KeyframeBei | Measure-Object -Maximum).Maximum + 3)
  }
  $rest = $dauer - ((Get-Date) - $t0).TotalSeconds
  if ($rest -gt 0) { Start-Sleep -Milliseconds ([int]($rest * 1000)) }

  $p.StandardInput.WriteLine('{"op":"stop","id":3}')
  $p.StandardInput.Flush()
  Start-Sleep -Seconds 2
  # stdin BLEIBT bis hierher offen: EOF faehrt den Sidecar sofort herunter,
  # unter Umstaenden mitten im Aufbau.
  $p.StandardInput.Close()
  if (-not $p.WaitForExit(15000)) { $p.Kill() }
  try { $ffplay | Stop-Process -Force } catch {}

  $stderr = $se.Result
  $null = $so.Result
  Set-Content -Path "$Ziel.stderr.log" -Value $stderr -Encoding utf8
  $encoder = ($stderr -split "`n" | Select-String 'Encoder offen' | Select-Object -First 1)
  $angefordert = @($stderr -split "`n" | Select-String 'Vollbild auf Anforderung').Count
  [pscustomobject]@{ Encoder = "$encoder".Trim(); Eingeloest = $angefordert }
}

# --- Auswertung an der Datei ------------------------------------------------
function Get-Kennzahlen {
  param([string]$Datei, [string]$Codec)

  $fmt = if ($Codec -eq 'av1') { @('-f','obu') } else { @() }
  $csv = & (Join-Path $FfBin 'ffprobe.exe') -v error @fmt -select_streams v `
           -show_entries frame=key_frame,pkt_size -of csv=p=0 $Datei

  $groessen = New-Object System.Collections.Generic.List[int]
  $vollbilder = New-Object System.Collections.Generic.List[int]
  $maxOhne = 0
  $i = 0
  foreach ($z in $csv) {
    if (-not $z) { continue }
    $t = $z.Split(',')
    $g = [int]$t[1]
    $groessen.Add($g)
    if ($t[0] -eq '1') { $vollbilder.Add($i) } elseif ($g -gt $maxOhne) { $maxOhne = $g }
    $i++
  }
  $summe = ($groessen | Measure-Object -Sum).Sum
  $n = $groessen.Count
  [pscustomobject]@{
    Bilder     = $n
    Vollbilder = $vollbilder.Count
    BeiBild    = ($vollbilder -join ' ')
    KbitS      = [math]::Round($summe * 8 / 1000 / ($n / $Fps), 0)
    MittelB    = [math]::Round($summe / $n, 0)
    MaxBild    = ($groessen | Measure-Object -Maximum).Maximum
    MaxOhneVoll= $maxOhne
  }
}

# --- Reihe ------------------------------------------------------------------
$ergebnisse = @()
foreach ($lauf in 1..$Laeufe) {
  foreach ($codec in $Codecs) {
    foreach ($modus in 'mit','ohne') {
      $ext  = if ($codec -eq 'av1') { 'obu' } else { 'h264' }
      $ziel = Join-Path $Ablage ("{0}-{1}-{2}.{3}" -f $lauf, $codec, $modus, $ext)
      Write-Host ("### Lauf {0}  {1}  Auffrischung {2}" -f $lauf, $codec, $modus)
      $lz = Invoke-Lauf -Codec $codec -Auffrischung ($modus -eq 'mit') -Ziel $ziel -KeyframeBei @()
      Write-Host ("    {0}" -f $lz.Encoder)
      $k = Get-Kennzahlen -Datei $ziel -Codec $codec
      $ergebnisse += [pscustomobject]@{
        Lauf = $lauf; Codec = $codec; Modus = $modus
        Bilder = $k.Bilder; Vollbilder = $k.Vollbilder; KbitS = $k.KbitS
        MittelB = $k.MittelB; MaxBild = $k.MaxBild; MaxOhneVoll = $k.MaxOhneVoll
      }
    }
  }
}

# Der Rueckkanal: ein eigener Lauf, weil ein angefordertes Vollbild die
# Spitzenwerte oben verfaelschen wuerde.
if ($Anfordern) {
  foreach ($codec in $Codecs) {
    $ext  = if ($codec -eq 'av1') { 'obu' } else { 'h264' }
    $ziel = Join-Path $Ablage ("anforderung-{0}.{1}" -f $codec, $ext)
    Write-Host ("### Anforderung  {0}  (Vollbild bei 8 s und 14 s)" -f $codec)
    $lz = Invoke-Lauf -Codec $codec -Auffrischung $true -Ziel $ziel -KeyframeBei @(8,14)
    $k  = Get-Kennzahlen -Datei $ziel -Codec $codec
    Write-Host ("    eingeloest laut Sender: {0} | Vollbilder in der DATEI: {1} bei Bild {2}" -f `
      $lz.Eingeloest, $k.Vollbilder, $k.BeiBild)
  }
}

Write-Host ''
$ergebnisse | Format-Table -AutoSize
Write-Host "Mitschnitte und stderr: $Ablage"
