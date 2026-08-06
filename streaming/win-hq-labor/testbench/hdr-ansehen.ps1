# HDR mit eigenen Augen ansehen: Sidecar sendet, Player zeigt -- beides auf
# dieser Maschine, ueber den Hetzner-Messstand.
#
# WARUM ES DAS GIBT: `hdr-nachweis.ps1` beweist, dass der STROM HDR traegt --
# am Bitstrom, ohne Bildschirm. Was es nicht beweisen kann, ist, ob das ANKOMMENDE
# BILD richtig aussieht. Das kann kein Skript entscheiden; dafuer muss jemand
# hinsehen. Dieses hier baut nur die Strecke auf und sagt, worauf zu achten ist.
#
# WARUM UEBER DEN SERVER UND NICHT LOKAL: derselbe Grund wie beim uebrigen
# Messstand -- lokal gibt es keinen Verlust, keine Laufzeit und keine
# Schwankung. Ausserdem ist es genau der Weg, den ein echter Zuschauer nimmt.
#
# AUFRUF:
#   powershell -File hdr-ansehen.ps1              # HDR
#   powershell -File hdr-ansehen.ps1 -Ohne        # dasselbe in SDR, zum Vergleich
#
# Der Vergleich ist der eigentliche Test. Ein HDR-Bild allein sieht man nicht an,
# ob es stimmt -- erst neben dem SDR-Bild derselben Szene.
#
# WOFUER DIESES SKRIPT NICHT TAUGT: die Frage, ob eine Sitzung DURCHHAELT.
# Die Vorgabe von 90 Sekunden liegt knapp UNTER allen Endzeiten des Abbruchs
# vom 2026-08-06 (134 bis 178 s) -- genau deshalb ist der wochenlang niemandem
# aufgefallen. Ausserdem liest dieses Skript stderr erst am Ende in einem
# Stueck; die Reihenfolge zwischen Sender und Player ist danach nicht mehr
# rekonstruierbar, und ohne die ist eine Ursache nicht von ihrer Wirkung zu
# trennen. Fuer Dauer- und Abbruchfragen deshalb `abriss-messen.sh` nehmen.

param(
  [int]$Sekunden = 90,
  [switch]$Ohne,
  [switch]$Voll,
  [switch]$Ruecklesen,
  [switch]$Takt,
  [int]$Bitrate = 12000,
  [int]$Fps = 60,
  [string]$Aufloesung = '1080p',
  # Eigener Name der Strecke auf dem Pruefstand.
  #
  # Zwei Laeufe auf DEMSELBEN Pfad streiten sich um dieselbe Sitzung, und beide
  # messen danach Rauschen. Das ist keine graue Theorie: am 2026-08-06 lief eine
  # Untersuchung ueber die Strecke, waehrend jemand nebenher hinsehen wollte.
  # Die Abhilfe war zuerst eine KOPIE dieses Skripts mit geaendertem Pfad --
  # ein Doppelgaenger, der beim naechsten Umbau hier zurueckgeblieben waere.
  # Ein Parameter tut dasselbe und kann nicht auseinanderlaufen.
  [string]$Kennung = 'ansehen'
)

# -Ruecklesen: das dekodierte Bild wieder ueber den Hauptspeicher schicken
# (PULSE_PLAYER_ZEROCOPY=0, s. src/zerocopy).
#
# HIER STAND BIS ZUM 2026-08-06 EIN SCHALTER "-Zerocopy", der den Weg am
# Hauptspeicher vorbei EINschaltete. Das ist ueberholt: seit der Fingerabdruck
# des Einfrier-Waechters auf der GPU entsteht, ist Zero-Copy die Vorgabe, und
# der Schalter zeigt in die andere Richtung. Wer den alten Aufruf benutzt,
# bekommt einen Parameterfehler statt eines stillschweigend falschen Arms.
#
# Der Schalter gehoert hierher, weil der Unterschied nur an einer LAUFENDEN
# Strecke zu messen ist: die Posten "hochladen" und "dekodieren" in der
# Statistikzeile des Players. Zwei Laeufe hintereinander, einer mit und einer
# ohne, auf demselben Material -- alles andere waere ein Vergleich zweier
# verschiedener Szenen.
#
# ACHTUNG bei der Deutung: die LATENZ-SONDE misst auf dem Zero-Copy-Weg nicht
# (sie liest ein gemaltes Muster aus dem Hauptspeicher und sagt beim ersten Bild
# selbst, dass sie aus ist). Fuer eine Latenzmessung also -Ruecklesen setzen.

# -Takt: die Abstaende zwischen zwei VERAENDERTEN Bildern melden
# (PULSE_PLAYER_TAKT_LOG=1). Das ist der Nachweis, dass der Einfrier-Waechter
# ueberhaupt Bilder sieht -- auf dem Zero-Copy-Weg kommt sein Fingerabdruck von
# der GPU zurueck, und ohne diese Zeilen liesse sich nicht unterscheiden, ob er
# "keine Aenderung" meldet oder gar nichts bekommt.

# -Voll: die VOLLSTAENDIGE Fehlerausgabe beider Programme in Dateien neben
# diesem Skript, und der Rueckgabewert des Players dazu.
#
# WARUM DAS NOETIG WAR: die Zusammenfassung unten filtert stderr auf ein paar
# Stichwoerter. Am 2026-08-06 hat genau das eine Stunde gekostet -- gemeldet war
# "wenn sich da was bewegt schmiert der Player ab", und im gefilterten Auszug
# stand davon nichts, weil keine der Zeilen ein Stichwort trug. Wer einem
# Absturz oder einer Stockung nachgeht, braucht ALLES, samt Rueckgabewert:
# ein Rust-Panic steht auf stderr, ein Abbruch der Grafikschicht gar nirgends.
# Zusaetzlich lohnt dann RUST_BACKTRACE=1 in der Umgebung.

$ErrorActionPreference = 'Continue'
$sp     = $PSScriptRoot
$labor  = Split-Path $sp -Parent
$wurzel = Split-Path (Split-Path $labor -Parent) -Parent
$ffbin  = "$labor\ffmpeg-patched\bin"
$side   = "$wurzel\streaming\win-hq-sidecar\target\release\pulse-win-hq-sidecar.exe"
$player = "$wurzel\streaming\pulse-player\target\release\pulse-player.exe"

foreach ($p in @($side, $player)) {
  if (-not (Test-Path $p)) { throw "fehlt: $p  (cargo build --release)" }
}
$tokDatei = "$sp\fern_token.txt"
if (-not (Test-Path $tokDatei)) { throw "Messstand-Token fehlt: $tokDatei" }
$tok  = "$(Get-Content $tokDatei -Raw)".Trim()
$pfad = "hdr-$Kennung-" + $(if ($Ohne) { 'sdr' } else { 'hdr' })
$basis = "https://pulse.unicutmedia.com/whep/$pfad"

# --- Sender ------------------------------------------------------------------
$ov = @{ codec='av1'; bit_depth=10; bitrate_kbps=$Bitrate; fps=$Fps; resolution=$Aufloesung }
if (-not $Ohne) { $ov['hdr'] = $true }
$req = @{ op='start'; id=1
  channel=@{ id='1'; token=''; push_url="$basis/whip?token=$tok" }
  capture='monitor'; audio=@{ mode='Aus' }; overrides=$ov
} | ConvertTo-Json -Compress -Depth 5

$psi = New-Object Diagnostics.ProcessStartInfo
$psi.FileName = $side
$psi.WorkingDirectory = Split-Path (Split-Path $side -Parent) -Parent
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$s = [Diagnostics.Process]::Start($psi)
$sErr = $s.StandardError.ReadToEndAsync()
$s.StandardOutput.ReadToEndAsync() | Out-Null
$s.StandardInput.WriteLine($req); $s.StandardInput.Flush()

Write-Host ("Sender laeuft ({0}) -- warte auf den ersten Strom ..." -f $(if ($Ohne) { 'SDR' } else { 'HDR' })) -ForegroundColor Cyan
Start-Sleep -Seconds 6

if ($s.HasExited) {
  Write-Host "Der Sender ist beendet. Meldung:" -ForegroundColor Red
  # Token nie ausgeben -- die Meldung kann die Push-URL enthalten.
  ($sErr.Result -replace 'token=[^\s"&]+', 'token=WEG') -split "`n" |
    Where-Object { $_ -match 'HDR|hdr|error|Fehler' } | Select-Object -First 6
  exit 1
}

# --- Zuschauer ---------------------------------------------------------------
# stdin OFFEN halten: kaeme die Anfrage aus einer Datei, saehe der Player nach
# der letzten Zeile EOF und faehrt herunter -- mitten im Verbindungsaufbau.
$pp = New-Object Diagnostics.ProcessStartInfo
$pp.FileName = $player
$pp.UseShellExecute = $false
$pp.RedirectStandardInput = $true; $pp.RedirectStandardOutput = $true
$pp.RedirectStandardError = $true
$pp.EnvironmentVariables['PATH'] = "$ffbin;$env:PATH"
if ($Ruecklesen) { $pp.EnvironmentVariables['PULSE_PLAYER_ZEROCOPY'] = '0' }
if ($Takt) { $pp.EnvironmentVariables['PULSE_PLAYER_TAKT_LOG'] = '1' }
# Die Statistikzeile je Sekunde -- ohne sie steht in der Zusammenfassung unten
# nichts ueber den Bildweg, und genau dort steht, was das Hochladen kostet.
if ($Voll) { $pp.EnvironmentVariables['PULSE_PLAYER_STATS_LOG'] = '1' }
$p = [Diagnostics.Process]::Start($pp)
$pErr = $p.StandardError.ReadToEndAsync()
$p.StandardOutput.ReadToEndAsync() | Out-Null

# ASCII-Bytes direkt in den Strom: PowerShells `WriteLine` stellt der Zeile
# sonst eine Byte-Reihenfolge-Marke voran, und der Player kann sie dann nicht
# lesen ("expected value at line 1 column 1").
$titel = if ($Ohne) { 'SDR-Vergleich' } else { 'HDR' }
$json = (@{ op='open'; id=1; url="$basis/whep?token=$tok"; title=$titel } |
         ConvertTo-Json -Compress) + "`n"
$b = [Text.Encoding]::ASCII.GetBytes($json)
$p.StandardInput.BaseStream.Write($b, 0, $b.Length)
$p.StandardInput.BaseStream.Flush()

Write-Host ""
Write-Host "Das Player-Fenster sollte gleich aufgehen. Worauf achten:" -ForegroundColor Yellow
if (-not $Ohne) {
  Write-Host "  * Helle Stellen (Fenster, weisse Flaechen, Lichter) duerfen HELLER"
  Write-Host "    sein als das uebrige Bild -- das ist der ganze Punkt von HDR."
  Write-Host "  * Farben duerfen NICHT ausgewaschen oder gruenstichig sein."
  Write-Host "  * Das Bild darf NICHT durchgehend zu dunkel wirken (dann wurde PQ"
  Write-Host "    nicht aufgeloest) und nicht ausgefressen (dann falsch skaliert)."
} else {
  Write-Host "  * Das ist der Vergleichslauf. So sieht dieselbe Szene ohne HDR aus."
}
Write-Host ""
Write-Host "Das Fenster laeuft $Sekunden Sekunden, dann raeume ich auf."
Write-Host "(Frueher beenden: Fenster schliessen.)"
Write-Host ""

$ende = (Get-Date).AddSeconds($Sekunden)
while ((Get-Date) -lt $ende -and -not $p.HasExited) { Start-Sleep -Milliseconds 500 }

# --- Abbau + was der Player ueber seinen Farbweg sagt -------------------------
if (-not $p.HasExited) { $p.Kill() }
$s.StandardInput.WriteLine('{"op":"stop","id":2}'); $s.StandardInput.Flush()
if (-not $s.WaitForExit(8000)) { $s.Kill() }

if ($Voll) {
  $pDat = "$sp\hdr-ansehen-player.log"
  $sDat = "$sp\hdr-ansehen-sender.log"
  ($pErr.Result -replace 'token=[^\s"&]+', 'token=WEG') | Set-Content -Encoding utf8 $pDat
  ($sErr.Result -replace 'token=[^\s"&]+', 'token=WEG') | Set-Content -Encoding utf8 $sDat
  Write-Host ("Volle Ausgabe: {0} / {1}" -f $pDat, $sDat) -ForegroundColor Cyan
  $rc = if ($p.HasExited) { $p.ExitCode } else { 'lief noch' }
  Write-Host ("Rueckgabewert des Players: {0}" -f $rc) -ForegroundColor Cyan
  $stock = ($pErr.Result -split "`n" | Where-Object { $_ -match 'Stockung' }).Count
  if ($stock -gt 0) {
    Write-Host ("ACHTUNG: {0} Stockungen im Decoder -- s. Messakte " -f $stock) -ForegroundColor Yellow
    Write-Host "  streaming/testbench/profiles/player-2026-08-06-absturz-ist-eine-stockung.json"
  }
}

Write-Host "=== Was der Player gemeldet hat ===" -ForegroundColor Cyan
($pErr.Result -replace 'token=[^\s"&]+', 'token=WEG') -split "`n" |
  Where-Object { $_ -match 'Oberflaechenformat|Farbraum|Farbwelt|Decoder|HDR|Zero-Copy|Latenz-Sonde' } |
  Select-Object -First 8 | ForEach-Object { "  " + $_.Trim() }

# Sieht der Einfrier-Waechter ueberhaupt Bilder? Nur mit -Takt. "Abstand 1"
# heisst "jedes Bild ist neu" -- auf laufendem Inhalt muss das der Regelfall
# sein, egal auf welchem Bildweg.
if ($Takt) {
  Write-Host "=== Einfrier-Waechter: Abstaende zwischen veraenderten Bildern ===" -ForegroundColor Cyan
  ($pErr.Result -split "`n" | Where-Object { $_ -match 'Takt-Diagnose' } |
    Select-Object -Last 4) | ForEach-Object { "  " + $_.Trim() }
}

# Die Posten, um die es beim Zero-Copy-Weg geht. Die LETZTEN Zeilen, nicht die
# ersten: die erste Statistikzeile faellt in den Verbindungsaufbau, und ein
# Mittelwert ueber die ersten Sekunden misst mehr den Anlauf als den Betrieb.
Write-Host "=== Bildweg (letzte Statistikzeilen) ===" -ForegroundColor Cyan
($pErr.Result -split "`n" | Where-Object { $_ -match 'hochladen .* ms' } |
  Select-Object -Last 3) | ForEach-Object {
    if ($_ -match '(hochladen [0-9.]+ ms.*?dekodieren [0-9./]+ ms)') { "  " + $Matches[1] }
  }

Write-Host "=== Was der Sender gemeldet hat ===" -ForegroundColor Cyan
($sErr.Result -replace 'token=[^\s"&]+', 'token=WEG') -split "`n" |
  Where-Object { $_ -match '\[hdr\]|\[hdr-wandler\]|capture .*->|Encoder offen|HDR-Signalisierung' } |
  Select-Object -First 8 | ForEach-Object { "  " + $_.Trim() }
