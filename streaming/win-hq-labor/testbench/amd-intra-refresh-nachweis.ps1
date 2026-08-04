# Der Nachweis fuer die HERSTELLER-EIGENEN Wege: traegt Intra-Refresh dort bis
# zum ZUSCHAUER?
#
# Gegenstueck zu intra-refresh-nachweis.ps1, das dieselbe Frage fuer den
# Vulkan-Weg beantwortet. Gemessen wird am dekodierenden Zuschauer, nicht am Log
# des Senders.
#
# Auf dieser Karte sind es ZWEI verschiedene Encoder, je nach Codec - der
# Sidecar waehlt sie selbst (`pipeline_hw.rs`):
#
#   av1  -> av1_amf       -intra_refresh_mode gop_aligned  -intra_refresh_stripes N
#   h264 -> h264_d3d12va  -intra_refresh_mode row_based    -intra_refresh_duration N
#
# Beide setzen die Optionen NICHT von sich aus; sie kommen ueber
# PULSE_ENCODER_OPTS herein. Das ist Absicht: das ausgelieferte Binary wird fuer
# eine Labormessung nicht angefasst.
#
# `g=600` gehoert bei h264 dazu, weil der Sidecar gop = fps*2 setzt: der
# d3d12-Weg frischt DURCHGEHEND auf, ersetzt den GOP-Takt aber nicht von selbst,
# und ohne langen GOP kaemen die Vollbilder zusaetzlich. av1_amf braucht das
# nicht - dort verschwinden sie mit der Auffrischung.
#
#   -Ohne     Gegenprobe ohne Auffrischung (dann muessen die Vollbilder kommen)
#   -Opts     eigene Optionsliste statt der Vorgabe
param(
  [int]$Sekunden = 12,
  [ValidateSet('av1','h264')][string]$Codec = 'av1',
  [int]$Bits = 8,
  [switch]$Ohne,
  [string]$Opts = '',
  [ValidateSet('pli','kein-pli','nur-einstieg')][string]$Modus = 'pli',
  [int]$VerlustAb = 0,
  [int]$VerlustPakete = 60
)
$ErrorActionPreference = 'Continue'
$sp    = $PSScriptRoot
$ld    = Split-Path $PSScriptRoot -Parent
$ffbin = "$ld\ffmpeg-patched\bin"
$tok   = "$(Get-Content "$sp\fern_token.txt" -Raw)".Trim()
$pfad  = "amd-ir-$Codec-$Bits" + $(if ($Ohne) { "-ohne" } else { "-mit" })
if (-not $Opts) {
  # gop_aligned, NICHT continuous: Modus 2 nimmt der AMF-Treiber an und tut
  # nichts damit (gemessen 2026-08-02, amf-2026-08-02-intra-refresh-doch.json).
  $Opts = if ($Codec -eq 'av1') { "intra_refresh_mode=gop_aligned,intra_refresh_stripes=30" }
          else { "intra_refresh_mode=row_based,intra_refresh_duration=30,g=600" }
}

$psi = New-Object Diagnostics.ProcessStartInfo
$psi.FileName = "$ld\target\release\pulse-win-hq-labor.exe"
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$psi.EnvironmentVariables["PATH"] = "$ffbin;$env:PATH"
# Seit dem 2026-08-02 ist der herstellereigene Weg MIT Auffrischung der
# Standard - das Labor setzt die Optionen selbst. Hier werden sie trotzdem
# ausdruecklich gesetzt: eine Messung soll nennen, was sie fuhr, und nicht von
# einer Vorgabe abhaengen, die sich aendern kann.
if (-not $Ohne) { $psi.EnvironmentVariables["PULSE_ENCODER_OPTS"] = $Opts }
# Die Gegenprobe braucht dagegen die Vorgabe AUS - sonst frischt das Labor von
# sich aus auf, und die Gegenprobe waere keine.
else { $psi.EnvironmentVariables["PULSE_LABOR_KEIN_IR"] = "1" }
$s = [Diagnostics.Process]::Start($psi)
$s.BeginOutputReadLine()

$ov = @{ codec=$Codec; fps=30; bitrate_kbps=4000; resolution="720p" }
if ($Bits -eq 10) { $ov["bit_depth"] = 10 }
$req = @{ op="start"; id=1
  channel=@{ id="1"; push_url="https://pulse.unicutmedia.com/whep/$pfad/whip?token=$tok" }
  capture="monitor"; overrides=$ov } | ConvertTo-Json -Compress -Depth 5
$s.StandardInput.WriteLine($req); $s.StandardInput.Flush()
Start-Sleep -Seconds 8

$zp = New-Object Diagnostics.ProcessStartInfo
$zp.FileName = "$ld\target\release\examples\whep_messwerk.exe"
$va = $(if ($VerlustAb -gt 0) { $VerlustAb } else { 999 })
$zp.Arguments = "https://pulse.unicutmedia.com/whep/$pfad/whep?token=$tok $Sekunden $va $VerlustPakete $Modus"
$zp.RedirectStandardOutput = $true; $zp.RedirectStandardError = $true; $zp.UseShellExecute = $false
$zp.EnvironmentVariables["PATH"] = "$ffbin;$env:PATH"
$z = [Diagnostics.Process]::Start($zp)
if (-not $z.WaitForExit(($Sekunden + 30) * 1000)) { $z.Kill() }
$aus = $z.StandardOutput.ReadToEnd()

$s.StandardInput.WriteLine('{"op":"stop","id":2}'); $s.StandardInput.Flush()
if (-not $s.WaitForExit(8000)) { $s.Kill() }
$log = $s.StandardError.ReadToEnd()
$enc = [regex]::Match($log, 'Encoder offen: (\S+)').Groups[1].Value
# Verankert auf die Zeilen, die der Sidecar beim Setzen WIRKLICH druckt
# (`apply_encoder_opts_override`). Ein loser Filter auf 'PULSE_ENCODER_OPTS'
# faengt auch jeden Hinweistext, der die Variable nur erwaehnt - und traegt sie
# dann in die Optionsspalte eines Laufs ein, der sie gar nicht gesetzt hat.
$opt = (($log -split "`r?`n" | Where-Object { $_ -match '^\[encode\] PULSE_ENCODER_OPTS' }) -join ' ')

"== {0}, {1} Bit, {2}, Modus {3} ==" -f $Codec, $Bits, $(if ($Ohne) { "OHNE Auffrischung" } else { $Opts }), $Modus
"   Encoder: $enc   $opt"
foreach ($muster in 'RTP-Pakete empfangen:\s+(\d+)', 'BILDER \(unbeschaedigt\):\s+(\d+)', 'davon VOLLBILDER:\s+(\d+)', 'vom Decoder abgelehnt:\s+(\d+)', 'Bildrate.*') {
  foreach ($t in [regex]::Matches($aus, $muster)) { "   " + $t.Value.Trim() }
}
