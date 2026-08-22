# STILLGELEGT AM 2026-08-21 -- DIESE MESSUNG IST SINNLOS GEWORDEN.
#
# Intra-Refresh ist an diesem Tag aus Pulse entfernt worden. Das Skript baute
# seine beiden Arme ausschliesslich ueber `"intra_refresh":true` gegen
# `"intra_refresh":false` -- und genau dieses Feld verschluckt der Sidecar
# seither stillschweigend. Beide Arme faehrt er damit IDENTISCH.
#
# Ohne diesen Hinweis waere das die gefaehrlichste Sorte Messung: sie liefe
# durch, fuellte die Tabelle und lieferte fuer "mit" und "ohne" fast dieselben
# Zahlen -- was wie ein Befund aussieht ("die Auffrischung kostet nichts") und
# in Wahrheit nur zweimal derselbe Lauf ist. Deshalb bricht das Skript unten
# ausdruecklich ab, statt lauffaehig zu bleiben.
#
# WAS DAVON GUELTIG BLEIBT: die Messwerte, die damit am 2026-08-11 entstanden
# sind (10 bit und HDR auf `av1_nvenc`), und die Fallen im Aufbau. Die stehen
# unveraendert unten.
#
# WER NUR 10 BIT ODER HDR PRUEFEN WILL, nimmt die Nachbarskripte, die ohne die
# Betriebsart auskommen: `nvidia-zehnbit-nachweis.ps1` und `hdr-nachweis.ps1`.
#
# ------------------------------------------------------------------------
# Der urspruengliche Kopf, als Historie:
#
# Traegt Intra-Refresh auf dieser Karte, heute, in Kombination mit 10 bit und
# mit HDR? Diese Kombination gab es auf NVIDIA bis zum 2026-08-11 nicht, weil
# HDR hier erst seit heute freigeschaltet ist (`encode/hdr.rs`,
# `traegt_hdr("av1_nvenc")` von false auf true). Ein HDR-Start schaltet 10 bit
# selbst ein -- es ist also die Kombination, die ein echter Nutzer ab jetzt
# faehrt.
#
# Diese Datei ist bewusst REIN ASCII, ohne Umlaute und ohne Gedankenstriche --
# dieselbe Falle wie in den Nachbarskripten (Windows PowerShell 5.1 liest ein
# `.ps1` ohne BOM als ANSI).
#
# GEZAEHLT WIRD AM MITSCHNITT, NICHT IM LOG DES SENDERS (Regel aus CLAUDE.md).
# Zwei Kennzahlen je Lauf:
#   1. Vollbilder/IDR in der Datei (ffprobe key_frame=1)
#   2. recovery-point-SEI (H.264) bzw. dieselbe Kennzahl indirekt ueber die
#      Vollbild-Zahl (AV1 hat keine SEI-Recovery-Points wie H.264 -- der
#      Nachweis "tut der Encoder wirklich Intra-Refresh" lief am 2026-08-04
#      ueber H.264-SEI; hier zaehlt fuer AV1 zusaetzlich die Bytegroesse des
#      groessten Bildes, weil ein reines Keyframe-Aus haette die Bild-Statistik
#      NICHT veraendert).
#
# NUR AV1 wird hier mit 10 bit / HDR kombiniert -- H.264 traegt auf dieser
# Karte kein 10 bit (`VideoCodec::supports_ten_bit` laesst nur AV1 durch,
# `encode/hdr.rs`). Die reine Intra-Refresh-Regression (8 bit, beide Codecs)
# war NICHT Teil dieses Skripts -- dafuer gab es `nvidia-intra-refresh-
# nachweis.ps1 -Bitrate 12000`, das am 2026-08-21 mit der Betriebsart geloescht
# worden ist.
param(
  [int]$Laeufe = 3,
  [int]$Sekunden = 20,
  [int]$Bitrate = 12000,
  [int]$Fps = 60,
  [string]$Aufloesung = '1080p',
  [string]$Ablage = ''
)
$ErrorActionPreference = 'Stop'

# Der Riegel. Siehe den Kopf: beide Arme dieses Skripts sind seit dem
# 2026-08-21 derselbe Lauf. Eine Messung, die zwei gleiche Dinge vergleicht,
# ist gefaehrlicher als eine, die abbricht.
throw 'Stillgelegt am 2026-08-21: Intra-Refresh ist aus Pulse entfernt, die Arme "mit" und "ohne" sind identisch. Begruendung im Kopf dieser Datei.'

$LaborRoot   = Split-Path $PSScriptRoot -Parent
$SidecarRoot = Join-Path (Split-Path $LaborRoot -Parent) 'win-hq-sidecar'
$Bin         = Join-Path $SidecarRoot 'target\release\pulse-win-hq-sidecar.exe'
$FfBin       = Join-Path $SidecarRoot 'ffmpeg-dist\n8.1-lgpl-shared\bin'
$PlayBin     = Join-Path $SidecarRoot 'ffmpeg-dist\n8.1-lgpl-shared.vorher\bin\ffplay.exe'
if (-not $Ablage) { $Ablage = Join-Path $env:TEMP 'pulse-nvidia-ir-10bit-hdr' }
New-Item -ItemType Directory -Force -Path $Ablage | Out-Null

if (-not (Test-Path $Bin)) {
  throw "Sidecar fehlt: $Bin  (cargo build --release --bins im win-hq-sidecar)"
}

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

# --- Ein Lauf ---------------------------------------------------------------
function Invoke-Lauf {
  param([bool]$Auffrischung, [string]$Modus, [string]$Ziel)

  if (Test-Path $Ziel) { Remove-Item -Force $Ziel }
  # `$Auffrischung` steht nur noch fuer die Ablage und die Ausgabe. Das Feld
  # `intra_refresh`, das den Unterschied ausgemacht hat, gibt es seit dem
  # 2026-08-21 nicht mehr -- deshalb der Riegel oben.
  $url = $Ziel -replace '\\','\\\\'
  $extra = if ($Modus -eq 'hdr') { '"hdr":true' } else { '"bit_depth":10' }
  $start = '{"op":"start","id":2,"channel":{"id":"1","token":"","push_url":"' + $url +
           '"},"capture":"monitor","audio":{"mode":"Aus"},"overrides":{"codec":"av1' +
           '","bitrate_kbps":' + $Bitrate + ',"fps":' + $Fps + ',"resolution":"' + $Aufloesung +
           '",' + $extra + '}}'

  # Bewegtbild + Verlaeufe, wie in `nvidia-zehnbit-nachweis.ps1` begruendet:
  # ein einfarbiges Bild sagt weder ueber die Bittiefe noch ueber die
  # Vollbild-Zahl etwas aus. SDL_RENDER_DRIVER=software ist Pflicht, sonst
  # nimmt WGC den Fensterinhalt schwarz auf (Falle 2 der Zehnbit-Akte).
  $ffplay = $null
  if (Test-Path $PlayBin) {
    $env:SDL_RENDER_DRIVER = 'software'
    $ffplay = Start-Process -FilePath $PlayBin -PassThru -ArgumentList @(
      '-hide_banner','-loglevel','error','-fs','-autoexit',
      '-f','lavfi','-i',"gradients=s=2400x1320:n=6:rate=$($Fps):speed=0.05:d=3600")
    Start-Sleep -Seconds 3
  } else {
    Write-Host "  (kein ffplay -- Aufnahme ist der Schirm, wie er ist)" -ForegroundColor Red
  }

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Bin
  $psi.WorkingDirectory = $SidecarRoot
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput  = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError  = $true

  $p  = [System.Diagnostics.Process]::Start($psi)
  $so = $p.StandardOutput.ReadToEndAsync()
  $se = $p.StandardError.ReadToEndAsync()

  $p.StandardInput.WriteLine($start)
  $p.StandardInput.Flush()
  Start-Sleep -Seconds $Sekunden
  $p.StandardInput.WriteLine('{"op":"stop","id":3}')
  $p.StandardInput.Flush()
  Start-Sleep -Seconds 2
  # stdin BLEIBT bis hierher offen: EOF faehrt den Sidecar sofort herunter,
  # mitten im Aufbau.
  $p.StandardInput.Close()
  if (-not $p.WaitForExit(20000)) { $p.Kill() }
  if ($ffplay -and -not $ffplay.HasExited) { try { $ffplay | Stop-Process -Force } catch {} }

  $stderr = $se.Result
  $null = $so.Result
  Set-Content -Path "$Ziel.stderr.log" -Value $stderr -Encoding utf8
  $zeilen = $stderr -split "`n"
  [pscustomobject]@{
    Offen     = "$($zeilen | Select-String 'Encoder offen' | Select-Object -First 1)".Trim()
    Weg       = "$($zeilen | Select-String 'pipeline-hw\] capture' | Select-Object -First 1)".Trim()
    HdrZeile  = "$($zeilen | Select-String '\[hdr\]' | Select-Object -First 1)".Trim()
    Fehler    = "$($zeilen | Select-String '\[error\]|ev.:.error' | Select-Object -First 1)".Trim()
    Delegiert = @($zeilen | Select-String 'Delegation an|CPU-Pipeline|Fallback').Count
  }
}

function Get-Kennzahlen {
  param([string]$Datei)
  $csv = & (Join-Path $FfBin 'ffprobe.exe') -v error -f obu -select_streams v `
           -show_entries frame=key_frame,pkt_size -of csv=p=0 $Datei
  $groessen = New-Object System.Collections.Generic.List[int]
  $vollbilder = New-Object System.Collections.Generic.List[int]
  $i = 0
  foreach ($z in $csv) {
    if (-not $z) { continue }
    $t = $z.Split(',')
    $g = [int]$t[1]
    $groessen.Add($g)
    if ($t[0] -eq '1') { $vollbilder.Add($i) }
    $i++
  }
  $summe = ($groessen | Measure-Object -Sum).Sum
  $n = $groessen.Count
  [pscustomobject]@{
    Bilder = $n; Vollbilder = $vollbilder.Count; BeiBild = ($vollbilder -join ' ')
    KbitS = if ($n -gt 0) { [math]::Round($summe * 8 / 1000 / ($n / $Fps), 0) } else { 0 }
    MaxBild = if ($n -gt 0) { ($groessen | Measure-Object -Maximum).Maximum } else { 0 }
  }
}

function Get-Selbstauskunft {
  param([string]$Datei)
  $r = Invoke-Werkzeug (Join-Path $FfBin 'ffprobe.exe') @(
    '-v','error','-f','obu','-select_streams','v:0',
    '-show_entries','stream=pix_fmt,color_space,color_transfer,color_primaries',
    '-of','default=noprint_wrappers=1',$Datei)
  $f = @{}
  foreach ($z in ("$($r.Aus)" -split "`n")) {
    if ($z -match '^\s*([a-z_]+)=(.*?)\s*$') { $f[$Matches[1]] = $Matches[2] }
  }
  [pscustomobject]@{ PixFmt = $f['pix_fmt']; Raum = $f['color_space']; Kurve = $f['color_transfer']; Primaer = $f['color_primaries'] }
}

# --- Reihe --------------------------------------------------------------
Write-Host "=== Intra-Refresh x 10bit/HDR, NVIDIA, $(Get-Date -Format 'yyyy-MM-dd HH:mm') ===" -ForegroundColor Cyan
Write-Host "Ablage: $Ablage   Bitrate: $Bitrate kbps"

$ergebnisse = @()
foreach ($modus in 'zehnbit','hdr') {
  foreach ($auffrischung in $true,$false) {
    for ($lauf = 1; $lauf -le $Laeufe; $lauf++) {
      $tag = if ($auffrischung) { 'mit' } else { 'ohne' }
      $ziel = Join-Path $Ablage ("{0}-lauf{1}-{2}.obu" -f $modus, $lauf, $tag)
      Write-Host ("`n### $modus  Lauf $lauf  Auffrischung $tag") -ForegroundColor Yellow
      $lz = Invoke-Lauf -Auffrischung $auffrischung -Modus $modus -Ziel $ziel
      Write-Host "    $($lz.Weg)"
      Write-Host "    $($lz.Offen)"
      if ($lz.HdrZeile) { Write-Host "    $($lz.HdrZeile)" }
      if ($lz.Fehler)   { Write-Host "    FEHLER: $($lz.Fehler)" -ForegroundColor Red }
      if (-not (Test-Path $ziel) -or (Get-Item $ziel).Length -eq 0) {
        Write-Host "    KEIN STROM -- s. $ziel.stderr.log" -ForegroundColor Red
        $ergebnisse += [pscustomobject]@{ Modus=$modus; Lauf=$lauf; Auffrischung=$tag; Bytes=0; Bilder=0; Vollbilder=-1; BeiBild=''; KbitS=0; MaxBild=0; PixFmt=''; Kurve=''; Delegiert=$lz.Delegiert }
        continue
      }
      $bytes = (Get-Item $ziel).Length
      if ($bytes -lt 1MB) { Write-Host "    WARNUNG: nur $bytes Bytes -- vermutlich schwarze Aufnahme" -ForegroundColor Red }
      $k = Get-Kennzahlen -Datei $ziel
      $s = Get-Selbstauskunft -Datei $ziel
      Write-Host ("    Bilder=$($k.Bilder) Vollbilder=$($k.Vollbilder) bei [$($k.BeiBild)] kbit/s=$($k.KbitS) maxBild=$($k.MaxBild)")
      Write-Host ("    pix_fmt=$($s.PixFmt) raum=$($s.Raum) kurve=$($s.Kurve) primaer=$($s.Primaer)")
      $ergebnisse += [pscustomobject]@{
        Modus=$modus; Lauf=$lauf; Auffrischung=$tag; Bytes=$bytes
        Bilder=$k.Bilder; Vollbilder=$k.Vollbilder; BeiBild=$k.BeiBild; KbitS=$k.KbitS; MaxBild=$k.MaxBild
        PixFmt=$s.PixFmt; Kurve=$s.Kurve; Delegiert=$lz.Delegiert
      }
    }
  }
}

Write-Host ''
$ergebnisse | Format-Table -AutoSize
Write-Host "Mitschnitte und stderr: $Ablage"
