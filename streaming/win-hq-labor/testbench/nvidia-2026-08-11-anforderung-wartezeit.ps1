# STAND 2026-08-21: INTRA-REFRESH IST AUS PULSE ENTFERNT.
#
# Dieses Skript schickte im Start-Auftrag `"intra_refresh":true` mit. Das Feld
# gibt es seit dem 2026-08-21 nicht mehr, der Sidecar verschluckt es
# stillschweigend -- es ist deshalb hier herausgenommen.
#
# DIE MESSUNG BLEIBT SINNVOLL, und zwar aus einem einzigen Grund: ihre beiden
# Arme unterscheiden sich am CODEC (h264 gegen av1), nicht an der Betriebsart.
# Das Wegfallen des Feldes macht sie also NICHT zu zwei gleichen Dingen.
#
# Was sich aendert, ist die Vergleichbarkeit nach hinten: alle bisherigen Zahlen
# entstanden bei rollender Auffrischung, ein Lauf von heute misst den Weg mit
# periodischen Vollbildern. Wer alte und neue Zahlen nebeneinanderlegt, sagt das
# dazu.

# Wie lange dauert es vom Anfordern eines Vollbilds bis zu dem Bild, mit dem
# der Zuschauer wieder sehen kann? STUFE 1: die Encoder-Seite allein.
#
# Diese Datei ist bewusst REIN ASCII, ohne Umlaute und ohne Gedankenstriche:
# Windows PowerShell 5.1 liest ein `.ps1` ohne BOM als ANSI, und aus dem UTF-8-
# Byte eines Gedankenstrichs wird dabei ein Anfuehrungszeichen, das mitten im
# Satz eine Zeichenkette beendet.
#
# ## Was gemessen wird
#
# Vom Absenden von `{"op":"keyframe"}` bis zu dem Bild, das als Vollbild in den
# Encoder geht, und weiter bis zu dessen fertigem Paket. Kein Netz, kein
# Player, kein Server: `push_url` ist ein Dateipfad, der Sendeweg schreibt den
# rohen Bitstrom.
#
#   t_anf   --- A --->  [encode] Vollbild auf Anforderung (pts=N)   (Einschub)
#                  --- B --->  Paket zu pts=N faellt heraus         (Encoder)
#
# A kommt aus zwei Uhren, die dieselbe sind: eine `Stopwatch` stempelt sowohl
# das Absenden auf stdin als auch die stderr-Zeile, die der Sidecar beim
# Einschieben genau dieses Bildes schreibt. Die Zeile steht in `send_avframe`
# VOR dem Zeitstempel des Encoders, also vor jeder Encoder-Arbeit.
#
# B kommt aus `PULSE_HQ_TRACE` (`enc_sum_us` des Ticks mit demselben pts) --
# das ist die Zuordnung Einschub->Paket aus `encode/latency.rs`, nicht die
# Dauer des Submit-Aufrufs.
#
# ## Warum nicht das Log des Senders allein
#
# Regel aus `win-hq-labor/CLAUDE.md`: am 2026-08-02 meldete der Sender auf AMD
# zwei eingeloeste Vollbild-Anforderungen, in der Datei stand keine einzige.
# Deshalb wird jede Anforderung am MITSCHNITT gegengeprueft -- Anzahl, Lage und
# ob das Bild ein echtes Vollbild MIT Sequenzkopf ist (bei AV1 war ein
# Intra-Only-Bild ohne Sequenzkopf schon einmal die falsche Antwort,
# `rueckkanal-2026-08-02-windows.json`).
#
# ## Warum die Anforderungen unregelmaessig gestreut sind
#
# Zweimal Absicht. Erstens setzt `keyframe.rs::RUHE` (2 s) die Staffelung
# zurueck -- mit mehr als zwei Sekunden Abstand ist JEDE Anforderung wieder
# "die erste", also genau der Einstiegsfall. Zweitens waere ein fester Abstand
# von z.B. 3,0 s bei 60 fps exakt 180 Bilder: die Anforderung fiele jedes Mal
# an dieselbe Stelle im Bildtakt, und die Messung zeigte eine Konstante, wo in
# Wahrheit eine Verteilung steht.
#
#   -Laeufe    Wiederholungen je Codec
#   -ProLauf   Anforderungen je Lauf
param(
  [int]$Laeufe = 3,
  [string[]]$Codecs = @('h264','av1'),
  [int]$ProLauf = 8,
  [double]$Vorlauf = 8.0,
  [int]$Bitrate = 12000,
  [int]$Fps = 60,
  [string]$Aufloesung = '1080p',
  [switch]$KeinFfplay,
  [string]$Ablage = ''
)
$ErrorActionPreference = 'Stop'

$LaborRoot   = Split-Path $PSScriptRoot -Parent
$SidecarRoot = Join-Path (Split-Path $LaborRoot -Parent) 'win-hq-sidecar'
$Bin         = Join-Path $SidecarRoot 'target\release\pulse-win-hq-sidecar.exe'
$FfBin       = Join-Path $SidecarRoot 'ffmpeg-dist\n8.1-lgpl-shared\bin'
# `ffplay` fehlt im ausgelieferten Bau (ohne SDL gebaut) -- derselbe Rueckfall
# wie in `nvidia-zehnbit-nachweis.ps1`. (Hier stand `nvidia-intra-refresh-
# nachweis.ps1`, am 2026-08-21 mit der Betriebsart geloescht.)
$PlayBin     = Join-Path $SidecarRoot 'ffmpeg-dist\n8.1-lgpl-shared.vorher\bin\ffplay.exe'
if (-not $Ablage) { $Ablage = Join-Path $env:TEMP 'pulse-nvidia-anforderung' }
New-Item -ItemType Directory -Force -Path $Ablage | Out-Null
if (-not (Test-Path $Bin)) {
  throw "Sidecar fehlt: $Bin  (cargo build --release --bins im win-hq-sidecar)"
}

# --- Bitstrom-Leser und Einstiegsprobe -------------------------------------
#
# Ausgelagert, weil es zwei verschiedene Fragen sind: hier werden Zeiten
# gestempelt, dort wird ein fertiger Mitschnitt gelesen. Und der Leser gehoert
# nicht dieser einen Messung -- jeder Rueckkanal-Nachweis stellt dieselbe
# Frage.
. (Join-Path $PSScriptRoot 'bitstrom-einstieg.ps1')

# --- Nebenlaeufiger, stempelnder Leser --------------------------------------
#
# Blockierendes `ReadLine` in einem eigenen Runspace, KEIN Poll: eine
# Poll-Schleife mit `Task.Wait(1)` haengt an der Windows-Timeraufloesung
# (15,6 ms) und verwischt genau die Groessenordnung, um die es hier geht.
# Nebenbei erfuellt es die zweite Pflicht -- die Pipe wird durchgehend geleert,
# sonst blockiert der Sidecar am vollen Rohrpuffer.
function Start-Leser {
  param($Leser, $Uhr, $Liste)
  $rs = [runspacefactory]::CreateRunspace()
  $rs.Open()
  $rs.SessionStateProxy.SetVariable('r', $Leser)
  $rs.SessionStateProxy.SetVariable('u', $Uhr)
  $rs.SessionStateProxy.SetVariable('l', $Liste)
  $ps = [powershell]::Create()
  $ps.Runspace = $rs
  [void]$ps.AddScript({
    while ($true) {
      $z = $r.ReadLine()
      if ($null -eq $z) { break }
      [void]$l.Add((New-Object psobject -Property @{ t = $u.Elapsed.TotalMilliseconds; z = $z }))
    }
  })
  New-Object psobject -Property @{ ps = $ps; h = $ps.BeginInvoke(); rs = $rs }
}

function Stop-Leser {
  param($L)
  try { $L.ps.Stop() } catch {}
  try { $L.ps.Dispose() } catch {}
  try { $L.rs.Close() } catch {}
}

# Das fuehrende Komma ist tragend: PowerShell rollt eine zurueckgegebene
# Sammlung aus, und eine LEERE Liste kaeme damit als `$null` beim Aufrufer an.
function Neue-Liste { ,([System.Collections.ArrayList]::Synchronized((New-Object System.Collections.ArrayList))) }

# --- Ein Lauf ---------------------------------------------------------------
function Invoke-Lauf {
  param([string]$Codec, [string]$Ziel, [string]$Trace)

  if (Test-Path $Ziel)  { Remove-Item -Force $Ziel }
  if (Test-Path $Trace) { Remove-Item -Force $Trace }
  $url = $Ziel -replace '\\','\\\\'
  $start = '{"op":"start","id":2,"channel":{"id":"1","token":"","push_url":"' + $url +
           '"},"capture":"monitor","audio":{"mode":"Aus"},"overrides":{"codec":"' + $Codec +
           '","bitrate_kbps":' + $Bitrate + ',"fps":' + $Fps + ',"resolution":"' + $Aufloesung +
           '"}}'

  # Bewegtbild ist Pflicht; `SDL_RENDER_DRIVER=software`, sonst nimmt WGC den
  # ffplay-Fensterinhalt schwarz auf (Herleitung: `nvidia-zehnbit-nachweis.ps1`).
  $ffplay = $null
  if ((-not $KeinFfplay) -and (Test-Path $PlayBin)) {
    $env:SDL_RENDER_DRIVER = 'software'
    $ffplay = Start-Process -FilePath $PlayBin -PassThru -ArgumentList @(
      '-hide_banner','-loglevel','error','-fs','-autoexit',
      '-f','lavfi','-i',"testsrc2=size=1920x1080:rate=$Fps")
    Start-Sleep -Seconds 3
  }

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Bin
  $psi.WorkingDirectory = $SidecarRoot
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput  = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError  = $true
  $psi.EnvironmentVariables['PULSE_HQ_TRACE'] = $Trace
  $psi.EnvironmentVariables['PULSE_ENC_LATENCY_LOG'] = '1'

  $uhr = [System.Diagnostics.Stopwatch]::StartNew()
  $p = [System.Diagnostics.Process]::Start($psi)
  $err = Neue-Liste; $out = Neue-Liste
  $leserErr = Start-Leser -Leser $p.StandardError  -Uhr $uhr -Liste $err
  $leserOut = Start-Leser -Leser $p.StandardOutput -Uhr $uhr -Liste $out
  $anforderungen = New-Object System.Collections.ArrayList

  try {
    $p.StandardInput.WriteLine($start); $p.StandardInput.Flush()

    # Auf "Encoder offen" warten -- harte Schranke, sonst haengt der Lauf.
    $frist = (Get-Date).AddSeconds(25)
    $offen = $null
    while ((Get-Date) -lt $frist) {
      $offen = $err.ToArray() | Where-Object { $_.z -match 'Encoder offen' } | Select-Object -First 1
      if ($offen) { break }
      if ($p.HasExited) { break }
      Start-Sleep -Milliseconds 100
    }
    if (-not $offen) { throw "Encoder ist nicht aufgegangen (siehe $Ziel.stderr.log)" }

    Start-Sleep -Milliseconds ([int]($Vorlauf * 1000))
    for ($k = 0; $k -lt $ProLauf; $k++) {
      $t = $uhr.Elapsed.TotalMilliseconds
      $p.StandardInput.WriteLine('{"op":"keyframe","id":' + (900 + $k) + '}')
      $p.StandardInput.Flush()
      [void]$anforderungen.Add($t)
      # 2,5 bis 3,5 s: ueber der Ruhe-Schwelle (2 s) und nicht im Bildtakt.
      Start-Sleep -Milliseconds (Get-Random -Minimum 2500 -Maximum 3500)
    }
    Start-Sleep -Seconds 2
    $p.StandardInput.WriteLine('{"op":"stop","id":3}'); $p.StandardInput.Flush()
    Start-Sleep -Seconds 2
  }
  finally {
    try { $p.StandardInput.Close() } catch {}
    if (-not $p.WaitForExit(15000)) { try { $p.Kill() } catch {} }
    Start-Sleep -Milliseconds 300
    Stop-Leser $leserErr; Stop-Leser $leserOut
    if ($ffplay) { try { $ffplay | Stop-Process -Force } catch {} }
  }

  # Die Leser sind gestoppt, die Liste waechst nicht mehr: ein Abzug genuegt.
  $zeilen = $err.ToArray()
  Set-Content -Path "$Ziel.stderr.log" -Value (($zeilen | ForEach-Object { $_.z }) -join "`r`n") -Encoding utf8
  New-Object psobject -Property @{
    Encoder   = "$($offen.z)".Trim()
    Anfragen  = @($anforderungen)
    Zeilen    = @($zeilen)
    Trace     = $Trace
  }
}

# --- Auswertung eines Laufs -------------------------------------------------
function Get-Messwerte {
  param($Lauf, [string]$Codec, [string]$Ziel)

  # 1. Die eingeloesten Anforderungen aus dem stderr, mit Zeitstempel.
  $eingeloest = @()
  foreach ($z in $Lauf.Zeilen) {
    if ($z.z -match 'Vollbild auf Anforderung \(pts=(-?\d+)') {
      $eingeloest += New-Object psobject -Property @{ t = $z.t; pts = [int]$matches[1] }
    }
  }

  # 2. Der Tick-Mitschnitt: pts -> Wanduhr des Sidecars + Encode-Latenz.
  $tick = @{}
  $ticks = New-Object System.Collections.ArrayList
  if (Test-Path $Lauf.Trace) {
    foreach ($z in (Get-Content $Lauf.Trace)) {
      if (-not $z) { continue }
      $j = $z | ConvertFrom-Json
      $tick[[int]$j.pts] = $j
      [void]$ticks.Add($j)
    }
  }

  # 3. Der Mitschnitt selbst -- die einzige Quelle, die nicht der Sender ist.
  $bilder = if ($Codec -eq 'av1') { [Bitstrom]::Av1($Ziel) } else { [Bitstrom]::H264($Ziel) }
  $voll = @()
  foreach ($b in $bilder) {
    # "index;schluessel;kopf;versatz" (Satzformat s. `bitstrom-einstieg.ps1`)
    $felder = $b.Split(';')
    if ($felder[1] -eq '1') {
      $voll += New-Object psobject -Property @{ idx = [int]$felder[0]; kopf = ($felder[2] -eq '1'); versatz = [long]$felder[3] }
    }
  }

  # 4. Uhren-Abgleich. Die stderr-Zeile entsteht im Tick des pts, die
  #    Trace-Zeile am ENDE desselben Ticks -- der Versatz ist konstant und
  #    faellt in der Differenz heraus. Der Median der Einzelversaetze ist die
  #    Umrechnung; ihre Streuung ist gleichzeitig die Guete der Zuordnung.
  $versatz = @()
  foreach ($e in $eingeloest) {
    if ($tick.ContainsKey($e.pts)) { $versatz += ($e.t - $tick[$e.pts].t_ms) }
  }
  $v0 = if ($versatz.Count) { ($versatz | Sort-Object)[[int]($versatz.Count/2)] } else { 0 }

  $mess = @()
  $n = [Math]::Min($Lauf.Anfragen.Count, $eingeloest.Count)
  for ($i = 0; $i -lt $n; $i++) {
    $tAnf = $Lauf.Anfragen[$i]
    $e = $eingeloest[$i]
    $a = $e.t - $tAnf
    $encMs = $null; $bilderDazwischen = $null
    if ($tick.ContainsKey($e.pts)) {
      $j = $tick[$e.pts]
      if ($j.enc_n -ge 1) { $encMs = [double]$j.enc_sum_us / [double]$j.enc_n / 1000.0 }
      $tAnfTrace = $tAnf - $v0
      $bilderDazwischen = @($ticks | Where-Object { $_.t_ms -gt $tAnfTrace -and $_.t_ms -le $j.t_ms }).Count
    }
    $mess += New-Object psobject -Property @{
      Codec = $Codec; Nr = $i + 1; Pts = $e.pts
      A_ms = [math]::Round($a, 2)
      B_ms = if ($null -ne $encMs) { [math]::Round($encMs, 2) } else { $null }
      Gesamt_ms = if ($null -ne $encMs) { [math]::Round($a + $encMs, 2) } else { $null }
      Bilder = $bilderDazwischen
    }
  }

  $spanne = $versatz | Measure-Object -Maximum -Minimum
  New-Object psobject -Property @{
    Messungen  = $mess
    Angefragt  = $Lauf.Anfragen.Count
    Eingeloest = $eingeloest.Count
    BilderGes  = $bilder.Count
    Vollbilder = $voll
    VersatzStreuung = if ($versatz.Count -gt 1) { [math]::Round($spanne.Maximum - $spanne.Minimum, 2) } else { 0 }
  }
}

function Quantil { param([double[]]$W, [double]$Q)
  if (-not $W.Count) { return $null }
  $s = $W | Sort-Object
  $i = [int][math]::Floor($Q * ($s.Count - 1) + 0.5)
  [math]::Round($s[$i], 2)
}

# --- Reihe ------------------------------------------------------------------
$alle = @()
$bericht = @()
foreach ($codec in $Codecs) {
  foreach ($lauf in 1..$Laeufe) {
    $ext   = if ($codec -eq 'av1') { 'obu' } else { 'h264' }
    $ziel  = Join-Path $Ablage ("{0}-{1}.{2}" -f $codec, $lauf, $ext)
    $trace = Join-Path $Ablage ("{0}-{1}.trace.jsonl" -f $codec, $lauf)
    Write-Host ("### {0}  Lauf {1}/{2}" -f $codec, $lauf, $Laeufe) -ForegroundColor Cyan
    $lz = Invoke-Lauf -Codec $codec -Ziel $ziel -Trace $trace
    Write-Host ("    {0}" -f $lz.Encoder)
    $m = Get-Messwerte -Lauf $lz -Codec $codec -Ziel $ziel
    $kopfLos = @($m.Vollbilder | Where-Object { -not $_.kopf }).Count
    $vollbildIndex = ($m.Vollbilder | ForEach-Object { $_.idx }) -join ' '
    Write-Host ("    angefragt {0} | eingeloest {1} | Vollbilder in der DATEI {2} (davon ohne Kopf {3}) | Bilder {4} | Uhrenstreuung {5} ms" -f `
      $m.Angefragt, $m.Eingeloest, $m.Vollbilder.Count, $kopfLos, $m.BilderGes, $m.VersatzStreuung)
    Write-Host ("    Vollbild-Index: {0}" -f $vollbildIndex)
    $einstieg = $null
    if ($m.Vollbilder.Count -ge 2) {
      # Das ZWEITE Vollbild ist das erste ANGEFORDERTE (das erste ist der Start).
      $einstieg = Test-Einstieg -Datei $ziel -Versatz $m.Vollbilder[1].versatz -Codec $codec -FfBin $FfBin
      Write-Host ("    Einstiegsprobe ab Bild {0}: {1} Bilder dekodiert, {2} Fehler {3}" -f `
        $m.Vollbilder[1].idx, $einstieg.Dekodiert, $einstieg.Fehler, $einstieg.ErsteZeile)
    }
    $m.Messungen | Format-Table Nr, Pts, A_ms, B_ms, Gesamt_ms, Bilder -AutoSize | Out-String | Write-Host
    $alle += $m.Messungen
    $bericht += New-Object psobject -Property @{
      Codec = $codec; Lauf = $lauf; Angefragt = $m.Angefragt; Eingeloest = $m.Eingeloest
      VollbilderDatei = $m.Vollbilder.Count; OhneKopf = $kopfLos; Bilder = $m.BilderGes
      VollbildIndex = $vollbildIndex
      EinstiegBilder = if ($einstieg) { $einstieg.Dekodiert } else { $null }
      EinstiegFehler = if ($einstieg) { $einstieg.Fehler } else { $null }
    }
  }
}

Write-Host ''
Write-Host '=== Zusammenfassung ===' -ForegroundColor Green
$bericht | Format-Table -AutoSize
foreach ($codec in $Codecs) {
  $w = @($alle | Where-Object { $_.Codec -eq $codec -and $null -ne $_.Gesamt_ms })
  if (-not $w.Count) { continue }
  $g = [double[]]($w | ForEach-Object { $_.Gesamt_ms })
  $a = [double[]]($w | ForEach-Object { $_.A_ms })
  $b = [double[]]($w | ForEach-Object { $_.B_ms })
  Write-Host ("{0}: n={1} | A(Anforderung->Einschub) med {2} max {3} | B(Encoder) med {4} max {5} | GESAMT med {6} p90 {7} max {8} ms" -f `
    $codec, $w.Count, (Quantil $a 0.5), (Quantil $a 1.0), (Quantil $b 0.5), (Quantil $b 1.0),
    (Quantil $g 0.5), (Quantil $g 0.9), (Quantil $g 1.0))
  Write-Host ("    Bildabstaende dazwischen: {0}" -f ((($w | ForEach-Object { $_.Bilder }) | Group-Object | ForEach-Object { "$($_.Name)x$($_.Count)" }) -join ' '))
}
$alle | Export-Csv -Path (Join-Path $Ablage 'messwerte.csv') -NoTypeInformation -Encoding utf8
Write-Host "Mitschnitte, Traces und messwerte.csv: $Ablage"
