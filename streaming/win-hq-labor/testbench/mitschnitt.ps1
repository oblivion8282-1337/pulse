# Einen kurzen Mitschnitt in eine Datei schreiben -- fuer die Sichtpruefung.
#
# WOFUER: zu jeder Aenderung am BILDWEG gehoert ein Blick auf ein Bild. Ein
# zerrissenes Bild sah in Latenz, CPU-Last und Decodierbarkeit schon einmal
# hervorragend aus (2026-07-30, Array-Pool auf AMD). Und es muss ein Bild aus
# der MITTE sein: das erste ist das Vollbild und ist auch dann richtig, wenn
# alle folgenden es nicht sind -- so lag der 10-Bit-Fehler zwei Tage verdeckt.
#
# Der Mitschnitt kostet nichts: eine push_url, die nicht mit http beginnt, geht
# an den ffmpeg-Muxer statt an den WebRTC-Sendeweg (encode::output).
#
# AUFRUF:
#   powershell -File mitschnitt.ps1 -Datei C:\tmp\neu.mp4 -Sekunden 12
#   powershell -File mitschnitt.ps1 -Datei C:\tmp\alt.mp4 -Sekunden 12 -Zwischenkopie
#
# Danach ein Bild herausholen (Nummer 45, nicht 0):
#   ffmpeg -i neu.mp4 -vf "select=eq(n\,45)" -vframes 1 -y bild.png

param(
  [Parameter(Mandatory=$true)][string]$Datei,
  [int]$Sekunden = 12,
  [switch]$Zwischenkopie,
  [switch]$Ohne,
  [int]$Bitrate = 12000,
  [int]$Fps = 60,
  [string]$Aufloesung = '1080p'
)

$ErrorActionPreference = 'Continue'
$sp     = $PSScriptRoot
$labor  = Split-Path $sp -Parent
$wurzel = Split-Path (Split-Path $labor -Parent) -Parent
$side   = "$wurzel\streaming\win-hq-sidecar\target\release\pulse-win-hq-sidecar.exe"
if (-not (Test-Path $side)) { throw "fehlt: $side  (cargo build --release --bins)" }
if (Test-Path $Datei) { Remove-Item $Datei -Force }

$ov = @{ codec='av1'; bit_depth=10; bitrate_kbps=$Bitrate; fps=$Fps; resolution=$Aufloesung }
if (-not $Ohne) { $ov['hdr'] = $true }
$req = @{ op='start'; id=1
  channel=@{ id='1'; token=''; push_url=$Datei }
  capture='monitor'; audio=@{ mode='Aus' }; overrides=$ov
} | ConvertTo-Json -Compress -Depth 5

$psi = New-Object Diagnostics.ProcessStartInfo
$psi.FileName = $side
$psi.WorkingDirectory = Split-Path (Split-Path $side -Parent) -Parent
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
if ($Zwischenkopie) { $psi.EnvironmentVariables['PULSE_HQ_HDR_ZWISCHENKOPIE'] = '1' }
$s = [Diagnostics.Process]::Start($psi)
$sErr = $s.StandardError.ReadToEndAsync()
$s.StandardOutput.ReadToEndAsync() | Out-Null
$s.StandardInput.WriteLine($req); $s.StandardInput.Flush()

Start-Sleep -Seconds $Sekunden
$s.StandardInput.WriteLine('{"op":"stop","id":2}'); $s.StandardInput.Flush()
if (-not $s.WaitForExit(8000)) { $s.Kill() }

$sErr.Result -split "`n" |
  Where-Object { $_ -match '\[hdr\]|\[aufnahme\]|\[hdr-wandler\]|capture .*->|Encoder offen|error|Fehler' } |
  Select-Object -First 8 | ForEach-Object { "  " + $_.Trim() }
if (Test-Path $Datei) {
  Write-Host ("Mitschnitt: {0} ({1:N0} Bytes)" -f $Datei, (Get-Item $Datei).Length) -ForegroundColor Green
} else {
  Write-Host "KEIN Mitschnitt entstanden" -ForegroundColor Red
}
