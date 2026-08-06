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
# darin steht (Bildpunkte am oberen Rand des PQ-Bereichs).
#
# VORAUSSETZUNGEN:
#   * HDR muss in den Windows-Anzeigeeinstellungen fuer diesen Schirm AN sein.
#     Ist es das nicht, verweigert der Sidecar den Start -- mit genau dieser
#     Auskunft. Das ist der erwartete Ausgang, kein Fehler des Skripts.
#   * AMD mit AV1 (`av1_amf`). Andere Kombinationen tragen HDR heute nicht,
#     Begruendung je Encoder in `win-hq-sidecar/src/encode/hdr.rs`.
#
# AUFRUF:
#   pwsh -File hdr-nachweis.ps1 [-Sekunden 12] [-Ablage <verzeichnis>]

param(
  [int]$Sekunden = 12,
  [int]$Fps = 60,
  [int]$Bitrate = 12000,
  [string]$Aufloesung = '1080p',
  [string]$Ablage = "$PSScriptRoot\..\..\..\build\hdr-nachweis"
)

$ErrorActionPreference = 'Stop'

$SidecarRoot = Resolve-Path "$PSScriptRoot\..\..\win-hq-sidecar"
$Bin   = Join-Path $SidecarRoot 'target\release\pulse-win-hq-sidecar.exe'
$FfBin = Join-Path (Resolve-Path "$PSScriptRoot\..") 'ffmpeg-patched\bin'

if (-not (Test-Path $Bin)) {
  throw "Sidecar fehlt: $Bin  (cargo build --release --bins im win-hq-sidecar)"
}
New-Item -ItemType Directory -Force -Path $Ablage | Out-Null

# --- Ein Lauf ---------------------------------------------------------------
#
# `push_url` ist ein Dateipfad: `open_output` faellt dann auf `format::output`
# zurueck und schreibt den rohen Bitstrom. Kein Netz, kein Muxer-Sonderweg --
# und damit auch keine Frage, ob der Transportweg die Farbangaben durchreicht.
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

  # Bewegtbild waere schoener, ist hier aber NICHT Pflicht -- und das ist eine
  # Aussage ueber die Frage, nicht ueber die Bequemlichkeit: dieses Skript
  # prueft die FARBKETTE, und die haengt nicht daran, ob sich etwas bewegt.
  # (Fuer Intra-Refresh-Messungen gilt das Gegenteil, s.
  # `nvidia-intra-refresh-nachweis.ps1`: dort sagt die Bitverteilung auf einem
  # stehenden Schirm nichts.)
  #
  # `ffplay` gibt es in `ffmpeg-patched/bin` nicht -- der Bau dort ist ohne
  # SDL, also ohne Fensterausgabe. Wenn eines danebenliegt, wird es benutzt;
  # sonst wird der Schirm genommen, wie er gerade ist.
  $ffplayPfad = Join-Path $FfBin 'ffplay.exe'
  $ffplay = $null
  if (Test-Path $ffplayPfad) {
    $ffplay = Start-Process -FilePath $ffplayPfad -PassThru -ArgumentList @(
      '-hide_banner','-loglevel','error','-fs','-autoexit',
      '-f','lavfi','-i',"testsrc2=size=1920x1080:rate=$Fps")
    Start-Sleep -Seconds 3
  } else {
    Write-Host "  (kein ffplay -- aufgenommen wird der Schirm, wie er ist)" -ForegroundColor DarkGray
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
  if (-not $p.WaitForExit(15000)) { $p.Kill() }

  if ($ffplay -and -not $ffplay.HasExited) { $ffplay.Kill() }

  [pscustomobject]@{
    Stdout = $so.Result
    Stderr = $se.Result
    Datei  = $Ziel
  }
}

# --- Was der Strom ueber sich sagt ------------------------------------------
function Get-Farbangaben {
  param([string]$Datei)
  $j = & (Join-Path $FfBin 'ffprobe.exe') -v error -select_streams v:0 `
    -show_entries 'stream=pix_fmt,color_space,color_transfer,color_primaries,color_range' `
    -of json $Datei 2>$null
  if (-not $j) { return $null }
  $j | ConvertFrom-Json
}

# Die Begleitdaten getrennt und in FLACHER Ausgabe holen.
#
# **Nicht aus Geschmack:** `-show_entries frame=side_data_list -of json` liefert
# die Liste zwar, aber mit LEEREN Objekten darin -- der Typ und die Werte fehlen.
# Das sieht aus wie „keine Metadaten im Strom" und ist in Wahrheit eine
# Eigenheit der Ausgabeform. Am 2026-08-06 hat genau das einen Fehlalarm
# erzeugt. Die flache Form gibt jedes Feld einzeln aus.
function Get-Begleitdaten {
  param([string]$Datei)
  $z = & (Join-Path $FfBin 'ffprobe.exe') -v error -select_streams v:0 `
    -show_frames -read_intervals '%+#1' -of flat $Datei 2>$null
  if (-not $z) { return @() }
  @($z | Select-String -Pattern 'side_data_type="([^"]+)"' |
      ForEach-Object { $_.Matches[0].Groups[1].Value })
}

Write-Host "=== HDR-Nachweis, $(Get-Date -Format 'yyyy-MM-dd HH:mm') ===" -ForegroundColor Cyan
Write-Host "Ablage: $Ablage"

$ergebnisse = @()
foreach ($fall in @(@{n='sdr'; hdr=$false}, @{n='hdr'; hdr=$true})) {
  $ziel = Join-Path $Ablage "$($fall.n).obu"
  Write-Host "`n--- Lauf '$($fall.n)' ---" -ForegroundColor Yellow
  $r = Invoke-Lauf -Hdr $fall.hdr -Ziel $ziel

  # Die Zeilen, die die Kette belegen -- jede stammt aus einer anderen Stufe.
  foreach ($muster in @('\[hdr\]','\[farbraum\]','\[encode\] Encoder offen','\[encode\] HDR-Signalisierung','HDR verlangt')) {
    $r.Stderr -split "`n" | Where-Object { $_ -match $muster } | ForEach-Object {
      Write-Host "  $($_.Trim())"
    }
  }

  if (-not (Test-Path $ziel) -or (Get-Item $ziel).Length -eq 0) {
    Write-Host "  KEIN STROM -- s. Meldung oben" -ForegroundColor Red
    $ergebnisse += [pscustomobject]@{ Lauf=$fall.n; Bytes=0; Angaben=$null }
    continue
  }
  $groesse = (Get-Item $ziel).Length
  $angaben = Get-Farbangaben $ziel
  Write-Host "  Datei: $groesse Bytes"
  if ($angaben) {
    $s = $angaben.streams[0]
    Write-Host ("  ffprobe: pix_fmt={0} space={1} transfer={2} primaries={3} range={4}" -f `
      $s.pix_fmt, $s.color_space, $s.color_transfer, $s.color_primaries, $s.color_range)
  }
  $sd = Get-Begleitdaten $ziel
  if ($sd.Count -gt 0) { foreach ($e in $sd) { Write-Host "  Begleitdaten: $e" } }
  else { Write-Host "  Begleitdaten: keine" }
  $ergebnisse += [pscustomobject]@{ Lauf=$fall.n; Bytes=$groesse; Angaben=$angaben; Sd=$sd }
}

Write-Host "`n=== Urteil ===" -ForegroundColor Cyan
$hdr = $ergebnisse | Where-Object Lauf -eq 'hdr'
if (-not $hdr.Angaben) {
  Write-Host "HDR-Lauf lieferte keinen Strom." -ForegroundColor Red
  exit 1
}
$s = $hdr.Angaben.streams[0]
$ok = $true
foreach ($p in @(
    @{f='color_transfer';  soll='smpte2084'},
    @{f='color_primaries'; soll='bt2020'},
    @{f='color_space';     soll='bt2020nc'},
    @{f='pix_fmt';         soll='yuv420p10le'})) {
  $ist = $s.($p.f)
  if ($ist -eq $p.soll) { Write-Host "  OK    $($p.f) = $ist" -ForegroundColor Green }
  else { Write-Host "  FEHLT $($p.f): $ist statt $($p.soll)" -ForegroundColor Red; $ok = $false }
}
foreach ($t in @('Mastering display metadata','Content light level metadata')) {
  if ($hdr.Sd -contains $t) { Write-Host "  OK    $t" -ForegroundColor Green }
  else { Write-Host "  FEHLT $t" -ForegroundColor Red; $ok = $false }
}
if ($ok) { Write-Host "`nDer Strom traegt HDR." -ForegroundColor Green; exit 0 }
Write-Host "`nDer Strom traegt KEIN vollstaendiges HDR." -ForegroundColor Red
exit 1
