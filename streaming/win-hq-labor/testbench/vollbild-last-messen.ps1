# Was kosten PERIODISCHE VOLLBILDER auf AMD/Windows -- je Codec und je Encode-Weg?
#
# DIE FRAGE DAHINTER (2026-08-19): seit dem 2026-08-18 ist Intra-Refresh
# abgewaehlt voreingestellt. Auf `h264_amf` schaltet `usage=ultralowlatency`
# die Auffrischung aber VON SICH AUS ein, weshalb `auffrischung.rs` beim
# Abwaehlen auf `usage=transcoding` umstellt -- und dieser Zweig kostete am
# 2026-07-30 gemessen 26,6 statt 10,3 Prozent Video-Engine. Bis zum 2026-08-18
# zahlte das nur, wer ausdruecklich abwaehlte, seither jeder AMD-Stream.
#
# Drei Groessen je Arm, und alle drei stehen am Ende in der Ausgabe:
#   * Video-Engine  -- Leistungsindikatoren je Prozess, wie in `last-messen.ps1`
#   * Encoder-Zeit  -- `enc avg` aus der Diagnosezeile des Sidecars
#   * Vollbildtakt  -- ffprobe ueber den Mitschnitt (die GEGENPROBE: ein Arm,
#                      der gar keine periodischen Vollbilder liefert, hat die
#                      Frage nicht beantwortet, egal wie guenstig er misst)
#
# WARUM IN EINE DATEI UND NICHT UEBER DEN HETZNER-MESSSTAND -- zwei Gruende,
# der zweite ist der zwingende:
#
# 1. Der Messstand ist seit dem 2026-08-12 abgeschaltet (`mediamtx-labor`
#    gestoppt, Caddyfile getauscht), weil pulse.unicutmedia.com fuer den
#    gemeinsamen Remote-Dev-Stack gebraucht wird. Ein Lauf dagegen endet in
#    HTTP 401. Fuer die Frage nach der ENCODER-Last ist die Leitung ohnehin
#    ohne Belang -- anders als bei Verlust- und Erholungsfragen, fuer die der
#    Messstand gebaut wurde und wo lokal nichts zu holen ist.
#
# 2. **Ueber eine WHIP-URL ist der D3D12-Weg gar nicht messbar.**
#    `VideoCodec::encode_path` gibt einem angemeldeten Sendeweg den Vorrang vor
#    allem anderen und liefert D3D11 zurueck, noch bevor `PULSE_HQ_AMD_D3D12`
#    ueberhaupt gelesen wird. Ein Arm "d3d12 ueber WHIP" wuerde also klaglos
#    laufen und den D3D11-Weg messen -- eine Messung, die nicht scheitert,
#    sondern taeuscht. Genau die Sorte, gegen die es `auffrischung.rs` gibt.
#
# WAS DIE DATEI NICHT IST: der ausgelieferte Sendeweg. Der Muxer schreibt statt
# `src/whip/`. Das kostet CPU und Platte, nicht die Video-Engine, und aendert
# an Encoder-Last und Vollbildtakt nichts. Wer Latenz BIS ZUM ZUSCHAUER
# braucht, misst das nicht hier.
#
# UND DIE WICHTIGSTE FALLE (aus `last-messen.ps1`): eine Lastmessung braucht
# eine BILDAENDERUNG. Ohne sie liefert WGC nichts, der Sidecar zaehlt
# dup-frames und alle Arme messen dasselbe Nichts. Deshalb startet dieses
# Skript `bewegung.ps1` selbst, statt es als Option anzubieten.
#
# Zwei geerbte Fallen der Zaehler-Mechanik, beide in `last-messen.ps1` teuer
# bezahlt: Instanznamen mit `^pid_1234_` treffen (ein `\b` greift nicht, der
# Unterstrich ist ein Wortzeichen), und Werte mit InvariantCulture ausgeben,
# weil PowerShell hier ein Dezimal-KOMMA schreibt.
#
# AUFRUF (ein Arm):
#   powershell -File vollbild-last-messen.ps1 -Codec h264 -Weg amf -Auffrischung aus
#
# Die Arme gehen bewusst EINZELN, nicht als Schleife im Skript: sie teilten
# sich sonst Encoder-Anlauf und Zaehlerzustand, und ein Fehlschlag im letzten
# Arm naehme die Messwerte der vorherigen mit.

param(
  [ValidateSet('h264','av1')][string]$Codec = 'h264',
  # amf   = Regelweg seit 2026-08-04 (D3D11-Zero-Copy, `*_amf`)
  # d3d12 = Gegenprobe hinter PULSE_HQ_AMD_D3D12=1 (D3D12-Zero-Copy, `*_d3d12va`)
  [ValidateSet('amf','d3d12')][string]$Weg = 'amf',
  # aus = periodische Vollbilder (die Vorgabe seit 2026-08-18)
  # an  = rollende Auffrischung (die Vorgabe davor)
  [ValidateSet('an','aus')][string]$Auffrischung = 'aus',
  [int]$Sekunden = 45,
  # Die ersten Sekunden gehoeren dem Encoder-Anlauf.
  [int]$Vorlauf = 10,
  [int]$Bitrate = 12000,
  [int]$Fps = 60,
  [string]$Aufloesung = '1080p',
  [string]$Kennung = '',
  [string]$Ablage = '',
  # Vollbilder AUF ZURUF statt aus dem GOP-Takt: alle N Sekunden ein
  # `{"op":"keyframe"}` in die stdin des Sidecars.
  #
  # WOFUER (2026-08-19): der teure Zweig entsteht nur, weil das Abwaehlen der
  # Auffrischung bei `h264_amf` die sparsame Betriebsart mitnimmt. Bleibt
  # `usage=ultralowlatency` stehen (also Auffrischung AN) und kommen die
  # Vollbilder stattdessen auf Zuruf, muesste beides gleichzeitig zu haben
  # sein. Dieser Schalter misst genau das, ohne den Sidecar zu aendern.
  #
  # Die Rueckstaffelung in `keyframe.rs` steht dem nicht im Weg, solange der
  # Abstand ueber der Ruhe-Schwelle von 2 s liegt: die Leiter faengt dann bei
  # jeder Anforderung wieder oben an und bedient sie sofort.
  [double]$ZurufSekunden = 0
)

$ErrorActionPreference = 'Continue'
$sp     = $PSScriptRoot
$labor  = Split-Path $sp -Parent
$wurzel = Split-Path (Split-Path $labor -Parent) -Parent
$side   = "$wurzel\streaming\win-hq-sidecar\target\release\pulse-win-hq-sidecar.exe"
$probe  = "$wurzel\streaming\win-hq-sidecar\ffmpeg-dist\n8.1-lgpl-shared\bin\ffprobe.exe"
if (-not (Test-Path $side)) { throw "fehlt: $side  (cargo build --release)" }

if ($Kennung -eq '') { $Kennung = "$Codec-$Weg-ir$Auffrischung" }
if ($Ablage -eq '')  { $Ablage = $sp }
$mitschnitt = Join-Path $Ablage "vbl-$Kennung.flv"
$logDatei   = Join-Path $Ablage "vbl-$Kennung.log"
$csv        = Join-Path $Ablage "vbl-$Kennung.csv"
Remove-Item $mitschnitt -ErrorAction SilentlyContinue

# --- Bildaenderung -----------------------------------------------------------
# KEIN -WindowStyle Hidden (Begruendung in last-messen.ps1): WinForms nimmt
# wShowWindow der Startinformation fuer sein erstes Fenster, die Bewegungsquelle
# bliebe unsichtbar und der Bildschirm stuende still.
$bewegung = Start-Process powershell -PassThru -ArgumentList @(
  '-NoProfile', '-File', (Join-Path $sp 'bewegung.ps1'), '-Sekunden', ($Sekunden + 20)
)
Start-Sleep -Seconds 2

# --- Sender ------------------------------------------------------------------
$ov = @{
  codec = $Codec; bitrate_kbps = $Bitrate; fps = $Fps; resolution = $Aufloesung
  intra_refresh = ($Auffrischung -eq 'an')
}
$req = @{ op='start'; id=1
  channel=@{ id='1'; token=''; push_url=($mitschnitt -replace '\\', '/') }
  capture='monitor'; audio=@{ mode='Aus' }; overrides=$ov
} | ConvertTo-Json -Compress -Depth 5

$psi = New-Object Diagnostics.ProcessStartInfo
$psi.FileName = $side
$psi.WorkingDirectory = Split-Path (Split-Path $side -Parent) -Parent
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
# Nur AMD+H.264/HEVC nimmt den Gegenprobe-Weg an; bei AV1 laesst `encode_path`
# ihn ausdruecklich liegen (`av1_d3d12va` gibt keine brauchbare extradata
# heraus). Der Arm av1/d3d12 misst deshalb denselben Weg wie av1/amf -- das ist
# kein Fehler des Skripts, sondern die Antwort auf die Frage. Die Zeile
# "Encoder offen" unten sagt, welcher Encoder wirklich aufging.
if ($Weg -eq 'd3d12') { $psi.EnvironmentVariables['PULSE_HQ_AMD_D3D12'] = '1' }
# Die Zwei-Sekunden-Zusammenfassung auch bei unauffaelligem Fenster ausgeben --
# dort steht `enc avg`, die Encoder-Zeit.
$psi.EnvironmentVariables['PULSE_ENC_LATENCY_LOG'] = '1'

$s = [Diagnostics.Process]::Start($psi)
$sErr = $s.StandardError.ReadToEndAsync()
$sOut = $s.StandardOutput.ReadToEndAsync()
$s.StandardInput.WriteLine($req); $s.StandardInput.Flush()

Write-Host ("Arm: {0} / {1} / Auffrischung {2}" -f $Codec, $Weg, $Auffrischung) -ForegroundColor Cyan
Start-Sleep -Seconds $Vorlauf

if ($s.HasExited) {
  # UNGEFILTERT, und das ist Absicht: ein Stichwort-Filter gab beim ersten
  # Anlauf am 2026-08-19 bei einem stillen Ende NICHTS aus. Eine leere
  # Fehlermeldung sieht aus wie ein kaputtes Skript und schickt die Suche in
  # die falsche Richtung.
  Write-Host "Der Sender ist beendet. Letzte Zeilen:" -ForegroundColor Red
  (($sErr.Result + "`n" + $sOut.Result) -split "`n") |
    Select-Object -Last 15 | ForEach-Object { "  " + $_.Trim() }
  if (-not $bewegung.HasExited) { $bewegung.Kill() }
  exit 1
}

# --- Zaehler -----------------------------------------------------------------
$pidMuster = "^pid_$($s.Id)_"
$zeilen = New-Object Collections.Generic.List[string]
$zeilen.Add('t;engtype;wert')
$inv = [Globalization.CultureInfo]::InvariantCulture
$messdauer = $Sekunden - $Vorlauf
$ende = (Get-Date).AddSeconds($messdauer)
$t0 = Get-Date
Write-Host ("Sender PID $($s.Id) -- messe {0} s" -f $messdauer) -ForegroundColor Cyan

$naechsterZuruf = if ($ZurufSekunden -gt 0) { (Get-Date).AddSeconds($ZurufSekunden) } else { $null }
$zurufe = 0

while ((Get-Date) -lt $ende -and -not $s.HasExited) {
  if ($null -ne $naechsterZuruf -and (Get-Date) -ge $naechsterZuruf) {
    $s.StandardInput.WriteLine('{"op":"keyframe","id":9}'); $s.StandardInput.Flush()
    $zurufe++
    $naechsterZuruf = (Get-Date).AddSeconds($ZurufSekunden)
  }
  $proben = (Get-Counter '\GPU Engine(*)\Utilization Percentage' -ErrorAction SilentlyContinue).CounterSamples
  if ($null -eq $proben) { continue }
  $summen = @{}
  foreach ($p in $proben) {
    if ($p.InstanceName -notmatch $pidMuster) { continue }
    if ($p.InstanceName -match 'engtype_(.+)$') {
      $typ = $Matches[1]
      if (-not $summen.ContainsKey($typ)) { $summen[$typ] = 0.0 }
      $summen[$typ] += [double]$p.CookedValue
    }
  }
  $t = ((Get-Date) - $t0).TotalSeconds
  foreach ($k in $summen.Keys) {
    $zeilen.Add(("{0};{1};{2}" -f $t.ToString('0.00', $inv), $k, $summen[$k].ToString('0.000', $inv)))
  }
}
Set-Content -Encoding ascii -Path $csv -Value $zeilen

$s.StandardInput.WriteLine('{"op":"stop","id":2}'); $s.StandardInput.Flush()
if (-not $s.WaitForExit(8000)) { $s.Kill() }
if (-not $bewegung.HasExited) { $bewegung.Kill() }
Set-Content -Encoding utf8 -Path $logDatei -Value ($sErr.Result + "`n" + $sOut.Result)

# --- Auswertung --------------------------------------------------------------
# MEDIAN, nicht Mittelwert: Anlauf und Abklingen hinterlassen Ausreisser nach
# oben, und ein einzelner Ausschlag zieht ein Mittel spuerbar hoch. Gemessen
# wird ein Dauerzustand, also zaehlt die Mitte.
function Median([double[]]$w) {
  if ($w.Count -eq 0) { return [double]::NaN }
  $g = $w | Sort-Object
  if ($g.Count % 2) { return $g[[int](($g.Count - 1) / 2)] }
  return ($g[$g.Count / 2 - 1] + $g[$g.Count / 2]) / 2.0
}

Write-Host ""
$zurufText = if ($ZurufSekunden -gt 0) { " / Zuruf alle $ZurufSekunden s ($zurufe gesendet)" } else { '' }
Write-Host "=== $Codec / $Weg / Auffrischung $Auffrischung$zurufText ===" -ForegroundColor Green

$daten = Import-Csv $csv -Delimiter ';'
foreach ($typ in ($daten.engtype | Sort-Object -Unique)) {
  $w = @($daten | Where-Object { $_.engtype -eq $typ } |
        ForEach-Object { [double]::Parse($_.wert, $inv) })
  Write-Host ("  GPU {0,-10} Median {1,6:F1} %   Spitze {2,6:F1} %   ({3} Proben)" -f
    $typ, (Median $w), ($w | Measure-Object -Maximum).Maximum, $w.Count)
}

# Encoder-Zeit aus den Diagnosezeilen. Der ERSTE Block gehoert dem Anlauf und
# faellt weg -- dieselbe Begruendung wie beim Vorlauf oben.
$encWerte = @()
foreach ($z in (Get-Content $logDatei)) {
  if ($z -match 'enc avg=([0-9.]+)ms') { $encWerte += [double]::Parse($Matches[1], $inv) }
}
if ($encWerte.Count -gt 1) {
  $encWerte = $encWerte[1..($encWerte.Count - 1)]
  Write-Host ("  Encoder-Zeit  Median {0,6:F1} ms  Spitze {1,6:F1} ms   ({2} Fenster)" -f
    (Median $encWerte), ($encWerte | Measure-Object -Maximum).Maximum, $encWerte.Count)
} else {
  Write-Host "  Encoder-Zeit  keine Diagnosezeile im Log" -ForegroundColor Yellow
}

# Die Gegenprobe. Ein Arm ohne periodische Vollbilder hat die gestellte Frage
# nicht beantwortet, egal wie guenstig seine Last ausfaellt.
if ((Test-Path $mitschnitt) -and (Test-Path $probe)) {
  $roh = & $probe -v error -select_streams v:0 -show_entries packet=flags `
                  -of csv=p=0 $mitschnitt 2>$null
  $gesamt = ($roh | Measure-Object).Count
  $voll   = ($roh | Where-Object { $_ -like 'K*' } | Measure-Object).Count
  if ($gesamt -gt 0) {
    $abstand = if ($voll -gt 0) { $gesamt / $voll / $Fps } else { [double]::NaN }
    Write-Host ("  Vollbilder    {0} in {1} Bildern  = alle {2:F1} s" -f $voll, $gesamt, $abstand)
  }
} else {
  Write-Host "  Vollbilder    kein Mitschnitt oder kein ffprobe" -ForegroundColor Yellow
}

Write-Host "  --- was der Sender gemeldet hat ---" -ForegroundColor DarkGray
Get-Content $logDatei | Where-Object { $_ -match 'Encoder offen|verweiger' } |
  Select-Object -First 4 | ForEach-Object { "    " + $_.Trim() }
Write-Host ("  Rohdaten: {0}" -f $csv) -ForegroundColor DarkGray
