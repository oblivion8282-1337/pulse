# Spielt ein Browser (Chromium) einen Intra-Refresh-Strom ab?
#
# Das ist die Frage, an der die spaetere Umstellung haengt: Nutzer im Browser
# muessen weiter zusehen koennen. Geprueft wird nicht am Augenschein, sondern an
# `getStats()` - erst wenn `framesDecoded` steigt, ist wirklich ein Bild da.
#
# Die Seite schreibt ihre Zahlen zusaetzlich in die Konsole; der Browser laeuft
# mit `--enable-logging`, damit sie in einer Datei landen und hier auswertbar
# sind statt nur sichtbar.
param(
  [int]$Sekunden = 22,
  [string]$Browser = "",   # leer = automatisch (Brave, sonst Edge)
  [switch]$Software,       # Gegenprobe: Hardware-Dekodierung abschalten
  # Der alte Vergleichsarm. Ohne ihn faehrt das Labor seit dem 2026-08-02 den
  # herstellereigenen Weg MIT Auffrischung - dafuer braucht es keinen Schalter
  # mehr. (`-Amd` gab es kurz und ist weg: ein Schalter, der nichts tut, ist
  # genau das falsche Etikett, vor dem Regel 2 warnt.)
  # 10 Bit bricht auf dem Vulkan-Weg ab, weil es dort farblich kaputt ist.
  [switch]$Vulkan,
  # Gegenprobe zu -Amd: derselbe Weg, aber OHNE Auffrischung. Trennt
  # "der Browser mag den AMF-Strom nicht" von "er mag die Auffrischung nicht".
  [switch]$OhneAuffrischung,
  # Nur EINEN Fall fahren: "av1-8", "av1-10" oder "h264-8".
  [string]$Nur = "",
  # Ohne Tonspur senden. Die uebrigen Messwerkzeuge des Labors fahren ohne Ton,
  # und ein Unterschied zwischen ihnen und diesem Lauf muss zuerst hier gesucht
  # werden, bevor man ihn dem Browser anlastet.
  [switch]$OhneTon
)
$ErrorActionPreference = 'Continue'
$sp    = $PSScriptRoot
$ld    = Split-Path $PSScriptRoot -Parent
$ffbin = "$ld\ffmpeg-patched\bin"
$tok = "$(Get-Content "$sp\fern_token.txt" -Raw)".Trim()

if (-not $Browser) {
  $Browser = @(
    "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
    "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
}
"Browser: $(Split-Path $Browser -Leaf)"

$faelle = @(
  @{ pfad="br-av1-8";  codec="av1";  bits=8  },
  @{ pfad="br-av1-10"; codec="av1";  bits=10 },
  @{ pfad="br-h264";   codec="h264"; bits=8  }
)
# **Drei Sender gleichzeitig sind selbst eine Bedingung.** Am 2026-08-02 lief die
# AMF-Auffrischung bei drei parallelen Encodern nicht durch (der Zuschauer sah
# den 2-Sekunden-Takt statt eines einzigen Vollbilds), bei einem Sender dagegen
# schon. Wer eine Encoder-Eigenschaft prueft und nicht die Gleichzeitigkeit,
# nimmt `-Nur`.
if ($Nur) { $faelle = $faelle | Where-Object { "$($_.codec)-$($_.bits)" -eq $Nur } }
if (-not $faelle) { "Kein Fall passt zu -Nur $Nur (av1-8 | av1-10 | h264-8)"; exit 1 }

# --- die drei Sender starten -------------------------------------------------
$sender = @()
foreach ($f in $faelle) {
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = "$ld\target\release\pulse-win-hq-labor.exe"
  $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $psi.EnvironmentVariables["PATH"] = "$ffbin;$env:PATH"
  # Seit dem 2026-08-02 ist der herstellereigene Weg mit Auffrischung der
  # Standard - `-Amd` braucht daher nichts mehr zu setzen und ist nur noch die
  # ausdrueckliche Ansage. `-Vulkan` holt den alten Vergleichsarm zurueck.
  if ($Vulkan) { $psi.EnvironmentVariables["PULSE_LABOR_VULKAN"] = "1" }
  if ($OhneAuffrischung) { $psi.EnvironmentVariables["PULSE_LABOR_KEIN_IR"] = "1" }
  $p = [Diagnostics.Process]::Start($psi)
  $p.BeginOutputReadLine()
  $ov = @{ codec=$f.codec; fps=30; bitrate_kbps=4000; resolution="720p" }
  if ($f.bits -eq 10) { $ov["bit_depth"] = 10 }
  $r = @{ op="start"; id=1
    channel=@{ id="1"; push_url="https://pulse.unicutmedia.com/whep/$($f.pfad)/whip?token=$tok" }
    capture="monitor"; overrides=$ov }
  if (-not $OhneTon) { $r["audio"] = @{ mode="Desktop" } }
  $req = $r | ConvertTo-Json -Compress -Depth 5
  $p.StandardInput.WriteLine($req); $p.StandardInput.Flush()
  $sender += @{ proc = $p; fall = $f }
}
"3 Sender gestartet, warte auf die Stroeme..."
Start-Sleep -Seconds 8

# --- Browser darauf loslassen ------------------------------------------------
$profil  = "$sp\browser-profil"
$logdat  = "$sp\browser.log"
Remove-Item $logdat -ErrorAction SilentlyContinue
Remove-Item $profil -Recurse -Force -ErrorAction SilentlyContinue
$seite = "file:///" + ("$sp\browser-whep.html" -replace '\\','/') + "?token=$tok"
$bargs = @(
  "--user-data-dir=$profil",
  "--no-first-run", "--no-default-browser-check",
  "--autoplay-policy=no-user-gesture-required",
  # `--v=1`, nicht 0: erst ab dieser Stufe schreibt Chromium, WELCHEN Decoder es
  # genommen hat und ob es auf Software zurueckgefallen ist. Ohne das misst man
  # nur, DASS Bilder kommen - und ein Strom, der heimlich auf der CPU dekodiert,
  # sieht dabei genauso aus wie einer in Hardware.
  "--enable-logging", "--log-file=$logdat", "--v=1",
  "--window-size=1400,900"
)
# Hardware-Dekodierung ausdruecklich anbieten statt sie dem Profil zu ueberlassen.
# **Das ist der Unterschied, an dem 10 Bit haengt**: der Software-Weg (libdav1d
# in Chromiums WebRTC) lehnt 10 Bit ab, der Hardware-Weg koennte es koennen.
# Ein Lauf, der das nicht trennt, misst den Zufall der Profil-Einstellungen.
if (-not $Software) {
  $bargs += @(
    "--ignore-gpu-blocklist",
    "--enable-gpu-rasterization",
    "--enable-features=PlatformHEVCDecoderSupport,D3D11VideoDecoder"
  )
} else {
  # Gegenprobe: Hardware-Dekodierung aus, damit der Unterschied belegt ist.
  $bargs += @("--disable-accelerated-video-decode")
}
$bargs += $seite
$b = Start-Process -FilePath $Browser -ArgumentList $bargs -PassThru
Start-Sleep -Seconds $Sekunden
Stop-Process -Id $b.Id -Force -ErrorAction SilentlyContinue

# **Die KINDER mit beenden, nicht nur den Starter.** Ein Chromium startet ein
# gutes Dutzend Prozesse (GPU, Renderer, Netz); `Stop-Process` auf die eine
# gestartete PID laesst sie laufen. Am 2026-08-02 haben sich so ueber mehrere
# Laeufe fuenfzehn Browser-Prozesse angesammelt, und die Messwerte fielen von
# 493 auf 65 Bilder - das sah nach einer Regression im Sender aus und war die
# GPU-Last der eigenen Vorlaeufe. Erkannt am Profilverzeichnis, damit ein
# privat geoeffneter Browser des Nutzers unangetastet bleibt.
Get-CimInstance Win32_Process -Filter "Name='$(Split-Path $Browser -Leaf)'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profil*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

# --- Sender beenden ----------------------------------------------------------
# **Und aufschreiben, was sie wirklich gefahren haben.** Ohne das sagt der Lauf
# nur, was der Browser gesehen hat - nicht, welcher Encoder mit welchen Optionen
# es erzeugt hat. Genau daran ist am 2026-08-02 eine Messung gescheitert: die
# Zahlen sahen nach "Auffrischung kaputt" aus, und in Wahrheit war sie gar nicht
# gesetzt.
$senderlog = @()
foreach ($s in $sender) {
  try { $s.proc.StandardInput.WriteLine('{"op":"stop","id":2}'); $s.proc.StandardInput.Flush() } catch {}
  if (-not $s.proc.WaitForExit(6000)) { $s.proc.Kill() }
  $err = $s.proc.StandardError.ReadToEnd()
  $enc = [regex]::Match($err, 'Encoder offen: (\S+)').Groups[1].Value
  $opt = (($err -split "`r?`n" | Where-Object { $_ -match '^\[encode\] PULSE_ENCODER_OPTS' }) -join ' ')
  $senderlog += "  {0,-10} {1,3} Bit -> {2,-14} {3}" -f $s.fall.codec, $s.fall.bits, $enc, $opt
}
"=== Was die Sender gefahren haben ==="
$senderlog

# --- auswerten ---------------------------------------------------------------
"=== Was der Browser dekodiert hat ==="
if (Test-Path $logdat) {
  $zeilen = Get-Content $logdat | Where-Object { $_ -match 'Bilder=|FEHLER|HTTP |ICE:' }
  # Je Fall die LETZTE Zeile - das ist der Endstand.
  $zeilen | Select-Object -Last 24 | ForEach-Object { "  " + ($_ -replace '^.*CONSOLE.*?"','' -replace '",\s*source.*$','' -replace $tok,'***') }
} else { "  keine Logdatei - Browser hat nichts geschrieben" }

# **Zaehlen reicht nicht.** Ein Browser, der ein Bild zeigt, kann trotzdem auf
# der CPU dekodieren, weil sein Hardware-Decoder aufgegeben hat - das steht in
# keiner Bildzahl. Diese drei Zeilenarten sind der eigentliche Befund.
"=== Womit er dekodiert hat ==="
if (Test-Path $logdat) {
  $d = Get-Content $logdat | Where-Object { $_ -match 'Decoder implementation|falling back to software|unhandled bit depth' }
  if ($d) { $d | Select-Object -Last 20 | ForEach-Object { "  " + ($_ -replace '^\[[^]]*\]\s*','') } }
  else { "  keine Decoder-Zeilen im Protokoll (laeuft der Browser mit --v=1?)" }
}
