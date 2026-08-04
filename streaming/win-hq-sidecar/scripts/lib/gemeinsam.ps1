# Gemeinsames fuer die Sidecar-Skripte. Per Punkt-Operator einbinden:
#
#   . (Join-Path $PSScriptRoot 'lib\gemeinsam.ps1')
#
# Warum eine eigene Datei: `fetch-ffmpeg.ps1` und `build-ffmpeg-patched.ps1`
# beantworten dieselbe Frage ("kennt dieses FFmpeg unseren Patch?") und stolpern
# ueber dieselbe PowerShell-5.1-Eigenart. Zweimal geschrieben liefe beides
# irgendwann auseinander - und zwar unbemerkt, weil beide Kopien fuer sich
# plausibel aussehen. Das bash-Gegenstueck ist `scripts/lib/gepatchter-klon.sh`
# im Repo-Wurzelverzeichnis, aus genau demselben Grund entstanden.
#
# REIN ASCII, ohne Umlaute und Gedankenstriche: Windows PowerShell 5.1 liest ein
# `.ps1` ohne BOM als ANSI, und aus dem UTF-8-Byte eines Gedankenstrichs wird
# dabei ein typografisches Anfuehrungszeichen, das eine Zeichenkette mitten im
# Satz beendet.

function Say([string]$m) { Write-Host "[$($script:LogTag)] $m" }
function Die([string]$m) { throw "[$($script:LogTag)] $m" }

# Ausgabe eines fremden Programms einsammeln, stdout und stderr zusammen.
#
# Der Umweg ist noetig, weil Windows PowerShell 5.1 jede stderr-Zeile eines
# nativen Programms in einen Fehlersatz verpackt, sobald man sie umleitet - und
# bei `$ErrorActionPreference = 'Stop'` bricht das Skript dann an einer ganz
# normalen Meldung ab. Betroffen ist genau der Weg, den die Pruefungen brauchen:
# `ffmpeg -buildconf` und `-h encoder=...` schreiben ueber av_log nach stderr.
# Ueber Erfolg entscheidet der Exit-Code, nicht die Frage, ob etwas nach stderr
# ging.
#
# Die Zuweisung wirkt nur in dieser Funktion - PowerShell legt beim Schreiben
# eine funktionslokale Kopie an, die beim Verlassen verschwindet.
function Get-Ausgabe([scriptblock]$Aufruf) {
    $ErrorActionPreference = 'Continue'
    & $Aufruf 2>&1 | ForEach-Object { "$_" }
}

# Ein fremdes Programm laufen lassen und seine Ausgabe durchreichen. Ueber
# Erfolg entscheidet der Aufrufer, an `$LASTEXITCODE` DANACH:
#
#   Invoke-Fremd { & git apply $p }
#   if ($LASTEXITCODE -ne 0) { Die '...' }
#
# Der Exit-Code wird bewusst NICHT zurueckgegeben: eine PowerShell-Funktion
# liefert alles, was in den Ausgabestrom faellt - der Rueckgabewert waere also
# die gesamte Programmausgabe mit dem Code hintendran. Genau daran ist die erste
# Fassung am 2026-08-04 gescheitert, mit der Meldung "Exit INSTALL libavdevice/...".
#
# Wozu die Funktion ueberhaupt: dieselbe 5.1-Falle wie oben, nur schwerer zu
# sehen. Hier leitet das Skript NICHTS um - aber sobald der AUFRUFER die Ausgabe
# umleitet (`.\build-ffmpeg-patched.ps1 | Tee-Object`, `2>&1 | Select-String`),
# sieht PowerShell die stderr-Zeilen doch, und bei
# `$ErrorActionPreference = 'Stop'` bricht der Bau an einer Compiler-WARNUNG ab.
function Invoke-Fremd([scriptblock]$Aufruf) {
    $ErrorActionPreference = 'Continue'
    & $Aufruf
}

# Die Optionen, die Patch 0002 an `av1_amf` haengt. Eine Stelle, weil sonst ein
# umbenannter Optionsname an drei Orten nachgezogen werden muesste - und der
# vergessene Ort meldete weiter "alles da".
$script:PatchOptionen = @('intra_refresh_mode', 'intra_refresh_stripes')

# Kennt das FFmpeg unter dieser Wurzel (`<wurzel>\bin\ffmpeg.exe`) die Optionen
# aus Patch 0002?
#
# Das ist die einzige Frage, die ein gepatchtes von einem ungepatchten Paket
# unterscheidet - der Dateiname sagt es nicht, die FFmpeg-Fassung auch nicht.
# `$Fehlend` nimmt die Namen auf, die nicht da sind, damit der Aufrufer eine
# brauchbare Meldung bauen kann.
function Test-Gepatcht([string]$Wurzel, [ref]$Fehlend) {
    $exe = Join-Path $Wurzel 'bin\ffmpeg.exe'
    if (-not (Test-Path $exe)) {
        if ($Fehlend) { $Fehlend.Value = $script:PatchOptionen }
        return $false
    }
    $hilfe = (Get-Ausgabe { & $exe -hide_banner -h encoder=av1_amf }) -join "`n"
    $fehlt = @($script:PatchOptionen | Where-Object { $hilfe -notmatch $_ })
    if ($Fehlend) { $Fehlend.Value = $fehlt }
    return ($fehlt.Count -eq 0)
}
