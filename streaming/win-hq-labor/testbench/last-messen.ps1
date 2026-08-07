# Einen Messarm fahren: senden, dabei die GPU-Auslastung des Senders abgreifen.
#
# WOFUER: Vorher/Nachher-Vergleiche an der SENDESEITE. Die Spur des Senders
# (PULSE_HQ_TRACE) sagt, was der TAKTFADEN kostet -- nicht, was die
# Grafikeinheit rechnet. Zwischen beidem liegt Faktor 70 (25 us Absenden gegen
# 1,79 ms GPU-Arbeit, gemessen 2026-08-06). Wer GPU-Last messen will, braucht
# die Windows-Leistungsindikatoren, und die stehen hier.
#
# AUFRUF:
#   powershell -File last-messen.ps1 -Kennung a1 -Sekunden 50
#   powershell -File last-messen.ps1 -Kennung b1 -Sekunden 50 -Zwischenkopie
#
# BEIDE ARME KOMMEN AUS DEMSELBEN BINARY. -Zwischenkopie setzt
# PULSE_HQ_HDR_ZWISCHENKOPIE=1 und stellt damit den Stand vor dem 2026-08-07
# wieder her (fp16-Kopie in der Aufnahme, Farbwandlung auf dem Taktfaden). Zwei
# Binaries zu vergleichen waere schlechter: dann unterscheiden sich auch
# Uebersetzung und Anordnung im Speicher.
#
# ZWEI FALLEN, beide schon einmal teuer gewesen:
# * Die Instanznamen heissen `pid_1234_luid_..._engtype_3d`. Ein `\b` hinter der
#   Prozessnummer greift NICHT (der Unterstrich ist fuer den Regex ein
#   Wortzeichen) -- `^pid_1234_` nehmen.
# * PowerShell schreibt auf einer deutschen Maschine ein Dezimal-KOMMA. Werte
#   deshalb mit InvariantCulture ausgeben, sonst zerfaellt die Tabelle an den
#   Semikola.
#
# UND DIE WICHTIGSTE: eine Lastmessung braucht eine BILDAENDERUNG. Ohne sie
# liefert WGC nichts und beide Arme messen dasselbe Nichts. `bewegung.ps1`
# daneben starten (oder -Bewegung setzen, dann macht dieses Skript es selbst).

param(
  [Parameter(Mandatory=$true)][string]$Kennung,
  [int]$Sekunden = 50,
  # Die ersten Sekunden gehoeren dem Verbindungsaufbau und dem Encoder-Anlauf.
  [int]$Vorlauf = 12,
  # Alter Weg: fp16-Zwischenkopie in der Aufnahme, Farbwandlung auf dem Takt.
  [switch]$Zwischenkopie,
  # SDR statt HDR.
  [switch]$Ohne,
  # Die Bildaenderungsquelle mitstarten und am Ende wieder schliessen.
  [switch]$Bewegung,
  [string]$Ablage = ''
)

$ErrorActionPreference = 'Continue'
$sp = $PSScriptRoot
if ($Ablage -eq '') { $Ablage = $sp }
$spur = Join-Path $Ablage ("last-$Kennung.jsonl")
$csv  = Join-Path $Ablage ("last-$Kennung.csv")

$bewegungsProzess = $null
if ($Bewegung) {
  # KEIN -WindowStyle hier. `Start-Process -WindowStyle Hidden` setzt
  # `wShowWindow` in der Startinformation des Prozesses, und WinForms nimmt
  # genau diesen Wert fuer sein ERSTES Fenster -- die Bewegungsquelle bliebe
  # unsichtbar und der Bildschirm stuende still. Beim ersten Anlauf am
  # 2026-08-07 genau so passiert: 98,3 Prozent Duplikat-Takte, 1,0 Aufnahmen je
  # Sekunde, also dieselbe Falle wie am Vortag, nur mit anderer Ursache. Das
  # Konsolenfenster, das dadurch sichtbar bleibt, aendert sich nicht und
  # kostet nichts.
  $bewegungsProzess = Start-Process powershell -PassThru -ArgumentList @(
    '-NoProfile', '-File', (Join-Path $sp 'bewegung.ps1'),
    '-Sekunden', ($Sekunden + 30)
  )
  Start-Sleep -Seconds 2
}

if ($Zwischenkopie) { $env:PULSE_HQ_HDR_ZWISCHENKOPIE = '1' }
else { Remove-Item Env:\PULSE_HQ_HDR_ZWISCHENKOPIE -ErrorAction SilentlyContinue }
# Die Zwei-Sekunden-Zusammenfassung auch bei sauberem Fenster ausgeben -- dort
# steht der Rueckruf-Zaehler, und der ist gerade dann interessant, wenn nichts
# auffaellt.
$env:PULSE_ENC_LATENCY_LOG = '1'

$argumente = @(
  '-NoProfile', '-File', (Join-Path $sp 'hdr-ansehen.ps1'),
  '-Sekunden', $Sekunden, '-Kennung', $Kennung, '-Spur', $spur, '-OhneZuschauer'
)
if ($Ohne) { $argumente += "-Ohne" }
$lauf = Start-Process powershell -PassThru -WindowStyle Minimized -ArgumentList $argumente

Start-Sleep -Seconds $Vorlauf
$sender = Get-Process pulse-win-hq-sidecar -ErrorAction SilentlyContinue |
          Select-Object -First 1
if ($null -eq $sender) {
  Write-Host "Kein Sender-Prozess gefunden -- Lauf abgebrochen?" -ForegroundColor Red
  if ($null -ne $bewegungsProzess -and -not $bewegungsProzess.HasExited) { $bewegungsProzess.Kill() }
  exit 1
}
$pidMuster = "^pid_$($sender.Id)_"
Write-Host ("Sender PID $($sender.Id) -- messe {0} s" -f ($Sekunden - $Vorlauf - 3)) -ForegroundColor Cyan

$zeilen = New-Object Collections.Generic.List[string]
$zeilen.Add('t;engtype;wert')
$inv = [Globalization.CultureInfo]::InvariantCulture
$ende = (Get-Date).AddSeconds($Sekunden - $Vorlauf - 3)
$t0 = Get-Date
while ((Get-Date) -lt $ende -and -not $lauf.HasExited) {
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

while (-not $lauf.HasExited) { Start-Sleep -Milliseconds 300 }
if ($null -ne $bewegungsProzess -and -not $bewegungsProzess.HasExited) { $bewegungsProzess.Kill() }
Remove-Item Env:\PULSE_HQ_HDR_ZWISCHENKOPIE -ErrorAction SilentlyContinue

Write-Host ("Fertig: {0} / {1}" -f $csv, $spur) -ForegroundColor Green
