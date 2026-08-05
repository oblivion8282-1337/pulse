# TON-MESSUNG ueber den Hetzner-Messstand: kommt der Ton sauber an, und passt
# er zum Bild?
#
# Der Aufbau, und warum er so ist:
#
#   Referenzsignal (ton-referenz.ps1) -> Browser im Vollbild
#     -> Bildschirmaufnahme + Desktop-Loopback (der Sidecar)
#     -> eigener WHIP-Sendeweg -> MediaMTX auf dem Messstand
#     -> whep_messwerk, das BEIDE Spuren dekodiert und nachrechnet
#
# Gemessen wird am Zuschauer, nicht am Log des Senders - dieselbe Regel wie
# beim Bild, und sie gilt hier genauso: der Sender kann nicht wissen, was
# angekommen ist.
#
# Der Messstand statt der lokalen Schleife ist Absicht: ueber 127.0.0.1 gibt es
# keinen Verlust, keine Laufzeit und keine Schwankung. Ein Ton, der dort sauber
# ist, sagt ueber den Ernstfall nichts.
#
# WICHTIG fuer die Deutung - drei Zahlen, drei Fragen (Herleitung in
# `src/whep/tonurteil.rs`):
#
#   STILLE / Luecken   ist der Ton unversehrt angekommen?
#   Versatz bei Ankunft  was sieht ein Zuschauer OHNE eigene Synchronisierung?
#   DRIFT je Minute      laufen die beiden Sender-Uhren auseinander? <- die Zahl
#
# Der Drift ist der Punkt der ganzen Uebung: Bild und Ton bekommen auf dem
# eigenen Sendeweg ihre RTP-Zeit aus Nennwerten (Bildzahl mal Soll-Bildrate,
# aufaddierte Paketlaengen) statt aus der Aufnahmezeit. Laufen die auseinander,
# faellt das in keinem Log auf - nur hier.
param(
  [int]$Sekunden = 300,
  [ValidateSet('av1','h264')][string]$Codec = 'av1',
  [int]$Bits = 8,
  [string]$Referenz = "$env:TEMP\pulse-tonreferenz.mp4",
  # Ohne Ausschluss faengt der Desktop-Loopback ALLES ein, auch den Browser -
  # und genau den wollen wir hier. `PULSE_SELF_PID` bleibt deshalb ungesetzt.
  [string]$Tonquelle = 'Desktop'
)
$ErrorActionPreference = 'Continue'
$sp    = $PSScriptRoot
$ld    = Split-Path $PSScriptRoot -Parent
$ffbin = "$ld\ffmpeg-patched\bin"
$tok   = "$(Get-Content "$sp\fern_token.txt" -Raw)".Trim()
$pfad  = "ton-$Codec-$Bits"
$basis = "https://pulse.unicutmedia.com/whep/$pfad"

# Nur ASCII in dieser Datei. PowerShell 5.1 liest ein .ps1 ohne BOM als ANSI;
# ein Gedankenstrich wird dabei zu drei Zeichen und der Parser bricht mitten im
# Skript ab, mit Meldungen, die auf voellig andere Zeilen zeigen.
if (-not (Test-Path $Referenz)) { throw "Referenz fehlt: $Referenz - erst ton-referenz.ps1 laufen lassen" }

$browser = @(
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) { throw "weder Edge noch Chrome gefunden" }

# --- Referenz im Vollbild abspielen ------------------------------------------
$seite = "file:///$($sp -replace '\\','/')/ton-referenz.html?datei=file:///$($Referenz -replace '\\','/')"
$profil = "$sp\browser-profil-ton"
$bargs = @(
  "--user-data-dir=$profil", "--no-first-run", "--no-default-browser-check",
  "--autoplay-policy=no-user-gesture-required",
  "--kiosk", $seite
)
$b = Start-Process -FilePath $browser -ArgumentList $bargs -PassThru
Start-Sleep -Seconds 6

# --- Sender ------------------------------------------------------------------
$psi = New-Object Diagnostics.ProcessStartInfo
$psi.FileName = "$ld\target\release\pulse-win-hq-labor.exe"
$psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true;  $psi.UseShellExecute = $false
$psi.EnvironmentVariables["PATH"] = "$ffbin;$env:PATH"
$s = [Diagnostics.Process]::Start($psi)
$s.BeginOutputReadLine()

$ov = @{ codec=$Codec; fps=30; bitrate_kbps=4000; resolution="720p" }
if ($Bits -eq 10) { $ov["bit_depth"] = 10 }
$req = @{ op="start"; id=1
  channel=@{ id="1"; push_url="$basis/whip?token=$tok" }
  capture="monitor"; audio=@{ mode=$Tonquelle }; overrides=$ov
} | ConvertTo-Json -Compress -Depth 5
$s.StandardInput.WriteLine($req); $s.StandardInput.Flush()
Start-Sleep -Seconds 8

# --- Zuschauer ---------------------------------------------------------------
# Kein Verlust (999 = nie): hier wird die Unversehrtheit im Regelbetrieb
# gemessen. Ein erzeugter Verlust wuerde die Ton-Luecken erzeugen, die zu
# finden die Aufgabe ist.
$zp = New-Object Diagnostics.ProcessStartInfo
$zp.FileName = "$ld\target\release\examples\whep_messwerk.exe"
$zp.Arguments = "$basis/whep?token=$tok $Sekunden 999 60 pli"
$zp.RedirectStandardOutput = $true; $zp.RedirectStandardError = $true
$zp.UseShellExecute = $false
$zp.EnvironmentVariables["PATH"] = "$ffbin;$env:PATH"
$z = [Diagnostics.Process]::Start($zp)
if (-not $z.WaitForExit(($Sekunden + 60) * 1000)) { $z.Kill() }
$aus = $z.StandardOutput.ReadToEnd()
$zfehler = $z.StandardError.ReadToEnd()

# --- alles beenden -----------------------------------------------------------
$s.StandardInput.WriteLine('{"op":"stop","id":2}'); $s.StandardInput.Flush()
if (-not $s.WaitForExit(8000)) { $s.Kill() }
$log = $s.StandardError.ReadToEnd()

# **Ueber das Profil aufraeumen, nicht ueber den Prozessbaum.**
#
# Der naheliegende Weg (`taskkill /T` auf die gestartete PID) trifft hier
# NICHTS: Edge gibt die Arbeit sofort an einen anderen Prozess ab und beendet
# den gestarteten; danach hat der Baum keine Kinder mehr, der Aufruf meldet
# Erfolg, und ein gutes Dutzend Prozesse laeuft weiter. Am 2026-08-03 so
# gemessen - nach einem Lauf standen sieben davon offen, belegten die GPU und
# haben im naechsten Lauf die dekodierten Bilder von 8985 auf 5668 gedrueckt.
# Das sah wie eine Nebenwirkung der gerade geaenderten Zeitrechnung aus und war
# der Muell des Vorlaufs. (Dieselbe Falle in anderer Gestalt wie bei
# `browser-whep.ps1`.)
#
# Ueber das eigene `--user-data-dir` zu gehen ist zugleich der einzige Weg, der
# den Browser des Benutzers in Ruhe laesst - ein Kahlschlag ueber den
# Prozessnamen wuerde dessen Fenster mit schliessen.
$muster = [regex]::Escape($profil)
Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" |
  Where-Object { $_.CommandLine -match $muster } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

# --- Bericht -----------------------------------------------------------------
"== Ton-Messung: $Codec, $Bits Bit, Quelle '$Tonquelle', $Sekunden s =="
"   Ziel: $basis"
$enc = [regex]::Match($log, 'Encoder offen: (\S+)').Groups[1].Value
"   Encoder: $enc"
# **Womit gemessen wurde, gehoert in den Bericht.** Steht im Labor als Regel
# ("dem eigenen Messwerk auch nicht glauben") und hat schon einen halben Tag
# gekostet, als `libdav1d` fehlte und der Rueckfall `av1_amf` fuer einen
# gesunden Strom "0 Bilder" meldete.
($zfehler -split "`r?`n" | Where-Object { $_ -match 'Decoder:|Bildspur endet|Ton-Decoder' }) |
  ForEach-Object { "   $_" }
$aus
if ($aus -notmatch 'Opus-Pakete') {
  "   ACHTUNG: kein Ton-Abschnitt im Bericht - lief das Messwerk durch?"
  ($zfehler -split "`r?`n" | Select-Object -Last 15) -join "`n"
}
