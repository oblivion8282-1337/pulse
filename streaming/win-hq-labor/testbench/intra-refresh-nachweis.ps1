# Der Nachweis, dass Intra-Refresh laeuft - am ZUSCHAUER gezaehlt, nicht am Log
# des Senders.
#
# Mit Intra-Refresh darf im ganzen Lauf HOECHSTENS EIN Vollbild ankommen (das
# auf die Einstiegs-Anforderung). Ohne Intra-Refresh sind es beim 2-s-Takt
# viele. Der Server hat PULSE_KEYFRAME_INTERVAL=0, es gibt also keinen Takt, der
# die Zahl von selbst hochtriebe.
param(
  [int]$Sekunden = 12,
  # Gegenprobe auf dem herstellereigenen Weg. Ohne den Schalter misst dieses
  # Skript den VULKAN-Weg - der ist seit dem 2026-08-02 nicht mehr der Standard
  # und wird deshalb ausdruecklich angefordert.
  [switch]$Amf
)
$ErrorActionPreference = 'Continue'
$sp    = $PSScriptRoot
$ld    = Split-Path $PSScriptRoot -Parent
$ffbin = "$ld\ffmpeg-patched\bin"
$tok = "$(Get-Content "$sp\fern_token.txt" -Raw)".Trim()

# AV1 10 Bit fehlt hier mit Absicht: ueber den Vulkan-Encoder ist es farblich
# kaputt (magenta ab dem ersten Zwischenbild, gemessen 2026-08-02, Messakte
# Abschnitt 11), und der Encoder verweigert es seitdem. Die Zahlen, die dieses
# Skript liefert, waeren fuer 10 Bit ohnehin nichtssagend gewesen - es zaehlt
# Bilder, und die kamen alle an.
$faelle = @(
  @{ name="AV1  8 Bit"; pfad="nw-av1-8";  codec="av1";  bits=8  },
  @{ name="H.264     "; pfad="nw-h264";   codec="h264"; bits=8  }
)

foreach ($f in $faelle) {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = "$ld\target\release\pulse-win-hq-labor.exe"
  $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.EnvironmentVariables["PATH"] = "$ffbin;$env:PATH"
  # Seit dem 2026-08-02 ist AMF der Standard; dieses Skript prueft den
  # VULKAN-Weg und muss ihn deshalb ausdruecklich anfordern. `-Amf` ist die
  # Gegenprobe und braucht dafuer gar nichts mehr.
  if (-not $Amf) { $psi.EnvironmentVariables["PULSE_LABOR_VULKAN"] = "1" }
  $s = [Diagnostics.Process]::Start($psi)
  $s.BeginOutputReadLine()
  $ov = @{ codec=$f.codec; fps=30; bitrate_kbps=4000; resolution="720p" }
  if ($f.bits -eq 10) { $ov["bit_depth"] = 10 }
  $req = @{ op="start"; id=1
    channel=@{ id="1"; push_url="https://pulse.unicutmedia.com/whep/$($f.pfad)/whip?token=$tok" }
    capture="monitor"; overrides=$ov } | ConvertTo-Json -Compress -Depth 5
  $s.StandardInput.WriteLine($req); $s.StandardInput.Flush()
  Start-Sleep -Seconds 8

  $zp = New-Object Diagnostics.ProcessStartInfo
  $zp.FileName = "$ld\target\release\examples\whep_messwerk.exe"
  $zp.Arguments = "https://pulse.unicutmedia.com/whep/$($f.pfad)/whep?token=$tok $Sekunden 999 0 pli"
  $zp.RedirectStandardOutput = $true; $zp.RedirectStandardError = $true; $zp.UseShellExecute = $false
  $zp.EnvironmentVariables["PATH"] = "$ffbin;$env:PATH"
  $z = [Diagnostics.Process]::Start($zp)
  if (-not $z.WaitForExit(($Sekunden + 30) * 1000)) { $z.Kill() }
  $aus = $z.StandardOutput.ReadToEnd()
  $b  = [regex]::Match($aus, 'BILDER \(unbeschaedigt\):\s+(\d+)').Groups[1].Value
  $vb = [regex]::Match($aus, 'davon VOLLBILDER:\s+(\d+)').Groups[1].Value
  $ab = [regex]::Match($aus, 'vom Decoder abgelehnt:\s+(\d+)').Groups[1].Value

  $s.StandardInput.WriteLine('{"op":"stop","id":2}'); $s.StandardInput.Flush()
  if (-not $s.WaitForExit(8000)) { $s.Kill() }
  $log = $s.StandardError.ReadToEnd()
  $enc = ($log -split "`r?`n" | Where-Object { $_ -match 'Encoder offen' } | Select-Object -First 1)
  $enc = [regex]::Match("$enc", 'Encoder offen: (\S+)').Groups[1].Value
  $irz = ($log -split "`r?`n" | Where-Object { $_ -match '\[vulkan-enc\] INTRA-REFRESH' } | Select-Object -First 1)

  "{0}  {1,-12}  Bilder={2,4}  VOLLBILDER={3,3}  abgelehnt={4,3}" -f $f.name, $enc, $b, $vb, $ab
  if ($irz) { "              $($irz.Trim())" } else { "              KEIN Intra-Refresh" }
}
