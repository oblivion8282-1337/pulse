# Erzeugt das REFERENZSIGNAL fuer die Ton-Messung.
#
# Warum ein eigenes Signal und nicht irgendein Video: gemessen werden soll, ob
# der Ton sauber ankommt UND ob er zum Bild passt. Beides braucht einen
# bekannten Bezug im Material selbst - "hoert sich gut an" ist keine Zahl, und
# ein zufaelliger Film hat keinen Punkt, an dem Bild und Ton nachweislich
# gleichzeitig etwas tun.
#
# Das Signal traegt deshalb drei Dinge:
#
#   * alle 2 s gleichzeitig einen 1-kHz-PIEP (50 ms) und einen weissen
#     VOLLBILD-BLITZ (100 ms). Beide entstehen aus derselben Quelle mit
#     denselben Zeitstempeln, sind also sample- und bildgenau gleichzeitig.
#     Der Empfaenger findet beide wieder und vergleicht ihre Zeiten.
#   * der Piep wechselt LINKS/RECHTS. Faellt die Stereo-Spur irgendwo zu Mono
#     zusammen (in dieser Kette schon einmal passiert, s. `noiseFilter.ts`),
#     faellt es sonst nicht auf - beide Kanaele traegen dann Ton, nur eben
#     denselben.
#   * dazwischen laeuft ein leiser 220-Hz-TRAEGER, der nie aussetzt. Damit ist
#     STILLE eindeutig ein Fehler. Ohne ihn waere jede Luecke im Ton von der
#     Ruhe zwischen zwei Pieps nicht zu unterscheiden - und genau Luecken sind
#     das, was man sucht.
#
# Das Bild ist `testsrc2` (bewegt), nicht Schwarz: ein stehendes schwarzes Bild
# kostet den Encoder nichts und misst deshalb einen Betriebszustand, den es im
# Ernstfall nicht gibt.
#
# Gegengeprueft am 2026-08-02 mit `silencedetect`: Pieps liegen exakt auf den
# geraden Sekunden, links bei 0/4/8, rechts bei 2/6, und der Blitz sitzt auf
# demselben Zeitstempel.
param(
  [int]$Sekunden = 330,
  [string]$Ziel = "$env:TEMP\pulse-tonreferenz.mp4"
)
$ErrorActionPreference = 'Stop'
$ld  = Split-Path $PSScriptRoot -Parent
$ff  = "$ld\ffmpeg-patched\bin\ffmpeg.exe"
if (-not (Test-Path $ff)) { throw "ffmpeg fehlt: $ff (siehe ffmpeg-patches/README.md)" }

# Der Piep haengt am Rest der Ausdruecke: `lt(mod(t,2),0.05)` schaltet ihn fuer
# 50 ms ein, `mod(floor(t/2),2)` verteilt ihn auf die Kanaele.
$links  = "0.03*sin(2*PI*220*t)+lt(mod(t\,2)\,0.05)*(1-mod(floor(t/2)\,2))*0.25*sin(2*PI*1000*t)"
$rechts = "0.03*sin(2*PI*220*t)+lt(mod(t\,2)\,0.05)*mod(floor(t/2)\,2)*0.25*sin(2*PI*1000*t)"

& $ff -hide_banner -loglevel error -y `
  -f lavfi -i "testsrc2=s=1280x720:r=30:d=$Sekunden" `
  -f lavfi -i "aevalsrc=$links|${rechts}:s=48000:c=stereo:d=$Sekunden" `
  -vf "drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='lt(mod(t\,2)\,0.1)'" `
  -c:v h264_amf -b:v 4M -g 60 -pix_fmt yuv420p `
  -c:a aac -b:a 192k -shortest $Ziel
if ($LASTEXITCODE -ne 0) { throw "ffmpeg ist gescheitert ($LASTEXITCODE)" }
"Referenz geschrieben: $Ziel"
