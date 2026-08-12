# Abnahme der Eingabe-Injektion: echte Frames durch den echten Sidecar,
# aufgefangen vom Eingabe-Pruefziel.
#
# WAS HIER GEPRUEFT WIRD -- und was nicht. Geprueft wird die HOST-Haelfte der
# Fernsteuerung: kommt ein Frame, das der Spezifikation entspricht, als die
# richtige Eingabe am richtigen Punkt an? Nicht geprueft wird die Strecke
# darueber (Player, Electron, chat-gateway) und nicht die zweite Maschine.
#
# WARUM DAS OHNE ZWEITEN RECHNER GEHT: Der Steuernde erzeugt Frames, der Host
# spielt sie ein. Wer die Frames erzeugt, ist dem Host gleichgueltig -- deshalb
# darf sie hier der Pruefstand erzeugen. Der Nachweis ist damit vollstaendig
# fuer diese Haelfte und sagt nichts ueber die andere.
#
# WARUM GEGEN DAS PRUEFZIEL UND NICHT GEGEN GetCursorPos: weil die Zeigerposition
# nur sagt, wo der Zeiger steht. Ob ein Fenster die Eingabe zugestellt bekommt --
# und mit welchem Scancode und welcher Erweitert-Kennung -- steht dort nicht.
#
# AUFRUF:
#   .\fern-eingabe-nachweis.ps1
#   .\fern-eingabe-nachweis.ps1 -Akte C:\Temp\akte.json

param(
  [string]$Sidecar = "$PSScriptRoot\..\..\win-hq-sidecar\target\release\pulse-win-hq-sidecar.exe",
  [string]$Arbeitsverzeichnis = "$env:TEMP\pulse-fern-nachweis",
  [string]$Akte = '',
  [int]$Fenster = 45
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\eingabe-frames.ps1"

if (-not (Test-Path $Sidecar)) {
  throw "Sidecar nicht gebaut: $Sidecar  (cargo build --release --bins)"
}
if (-not (Test-Path $Arbeitsverzeichnis)) { New-Item -ItemType Directory -Force $Arbeitsverzeichnis | Out-Null }
$log = Join-Path $Arbeitsverzeichnis 'pruefziel.jsonl'
Remove-Item $log -ErrorAction SilentlyContinue

Add-Type -AssemblyName System.Windows.Forms
Add-Type -Namespace Nachweis -Name Nativ -MemberDefinition @'
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(System.Drawing.Point p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
'@ -ReferencedAssemblies System.Drawing
try { [void][Nachweis.Nativ]::SetProcessDPIAware() } catch { }

# EIN SYSTEMDIALOG ENTWERTET JEDE MESSUNG, UND ZWAR LAUTLOS.
#
# Windows fragt beim ersten Netzzugriff einer neuen Binaerdatei nach der
# Firewall-Freigabe. Unter diesen Dialog legt es eine bildschirmfuellende
# Abdunklung (Fensterklasse `Shell_SystemDim`, Prozess `PickerHost`), die UEBER
# allem liegt -- auch ueber einem Topmost-Fenster -- und saemtliche Eingabe
# schluckt. Das Ergebnis sieht aus wie "der Injektor tut nichts": der Sidecar
# meldet `ok:true, processed:30`, und das Pruefziel sieht null Ereignisse. Genau
# so sind am 2026-08-12 mehrere Anlaeufe verlorengegangen.
#
# Cargo-Testbinaerdateien tragen einen Inhalts-Hash im Namen, sind nach jedem
# Bau also eine NEUE Datei -- die Frage kommt daher immer wieder.
#
# GEPRUEFT WIRD POSITIV, nicht ueber eine Liste bekannter Stoerer: liegt unter
# der Bildschirmmitte wirklich ein Fenster DES PRUEFZIELS? Nach dem Titel zu
# suchen taugt nicht, der ist uebersetzt; nach Klassennamen zu suchen hiesse,
# jede kuenftige Windows-Variante nachzupflegen.
function Get-FensterOben([int]$x, [int]$y) {
  $h = [Nachweis.Nativ]::WindowFromPoint((New-Object Drawing.Point($x, $y)))
  $fpid = 0
  [void][Nachweis.Nativ]::GetWindowThreadProcessId($h, [ref]$fpid)
  $k = New-Object Text.StringBuilder 256
  [void][Nachweis.Nativ]::GetClassNameW($h, $k, 256)
  return @{ hwnd = $h; pid = [int]$fpid; klasse = $k.ToString() }
}
function Test-PruefzielObenauf($erwarteterPid, [int]$x, [int]$y) {
  $o = Get-FensterOben $x $y
  return @{ ok = ($o.pid -eq $erwarteterPid); info = $o }
}
function Clear-Fremdfenster([int]$x, [int]$y) {
  # WM_CLOSE entspricht "Abbrechen" -- es wird KEIN Zugriff gewaehrt.
  $o = Get-FensterOben $x $y
  [void][Nachweis.Nativ]::PostMessageW($o.hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
  Start-Sleep -Seconds 2
  return $o
}
$schirm = [Windows.Forms.Screen]::PrimaryScreen.Bounds
Write-Host "Primaerer Bildschirm: $($schirm.Width)x$($schirm.Height) ab $($schirm.X),$($schirm.Y)"

# --- Pruefziel hochfahren ------------------------------------------------

$pruefziel = Start-Process powershell -PassThru -ArgumentList @(
  '-NoProfile', '-ExecutionPolicy', 'Bypass',
  '-File', "$PSScriptRoot\eingabe-pruefziel.ps1",
  '-Pfad', $log, '-Sekunden', "$Fenster")
Start-Sleep -Seconds 5
if (-not (Test-Path $log)) { throw 'Pruefziel ist nicht hochgekommen (keine Protokolldatei).' }

# Das Pruefziel laeuft in einer eigenen powershell.exe; unter der Bildschirmmitte
# muss folglich ein Fenster GENAU DIESES Prozesses liegen.
$mitteX = [int]($schirm.Width / 2)
$mitteY = [int]($schirm.Height / 2)
$pruefung = Test-PruefzielObenauf $pruefziel.Id $mitteX $mitteY
if (-not $pruefung.ok) {
  Write-Host "Etwas liegt ueber dem Pruefziel: Klasse $($pruefung.info.klasse), Prozess-Id $($pruefung.info.pid) -- wird geschlossen."
  [void](Clear-Fremdfenster $mitteX $mitteY)
  $pruefung = Test-PruefzielObenauf $pruefziel.Id $mitteX $mitteY
}
if (-not $pruefung.ok) {
  $o = $pruefung.info
  Stop-Process -Id $pruefziel.Id -Force -ErrorAction SilentlyContinue
  throw ("Ueber dem Pruefziel liegt weiterhin ein fremdes Fenster (Klasse $($o.klasse), " +
         "Prozess-Id $($o.pid)). Jede Messung waere wertlos -- Lauf abgebrochen.")
}

# --- Sidecar starten -----------------------------------------------------

# stdin MUSS offen bleiben. Kommt die Anfrage aus einer Datei, sieht der Sidecar
# nach der letzten Zeile EOF und faehrt korrekt herunter -- mitten im Lauf. Von
# aussen sieht das wie ein Fehler aus. (testbench/README.md, Fallen im Messaufbau)
$psi = New-Object Diagnostics.ProcessStartInfo
$psi.FileName = $Sidecar
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
# Ohne laufenden Stream gibt es kein Quell-Rechteck. Der Labor-Schalter nimmt
# dann den primaeren Bildschirm -- nur damit sich die Injektion ohne echten
# Bildschirm-Push pruefen laesst. Kein Produktweg.
$psi.EnvironmentVariables['PULSE_LABOR_EINGABE_OHNE_STREAM'] = '1'
$proc = [Diagnostics.Process]::Start($psi)

$script:opId = 0
function Sende($obj) {
  $script:opId++
  $obj['id'] = $script:opId
  $proc.StandardInput.WriteLine(($obj | ConvertTo-Json -Depth 6 -Compress))
  $proc.StandardInput.Flush()
  Start-Sleep -Milliseconds 90
}
function SendeFrames($frames, $slot = 0) {
  Sende @{ op = 'remote_input'; slot = $slot; session_id = 'nachweis'
          frames = (ConvertTo-FrameBase64 $frames) }
}

# --- Der Ablauf ----------------------------------------------------------

# Ziele in Pixeln. Der Anteil bezieht sich auf das Quell-Rechteck, und das ist
# hier der primaere Bildschirm; px = u * (breite - 1) laut Spezifikation.
$zielPixel = @(
  @(0, 0), @(($schirm.Width - 1), 0), @(0, ($schirm.Height - 1)),
  @(($schirm.Width - 1), ($schirm.Height - 1)),
  @([int]($schirm.Width / 2), [int]($schirm.Height / 2)),
  @(100, 100), @(1000, 500), @(2000, 1200)
)
$scancodes = Get-ScancodeFolge 'pulse fern 2026'

Sende @{ op = 'remote_input'; slot = 0; session_id = 'nachweis'
        frames = (ConvertTo-FrameBase64 @(, (New-HelloFrame))) }

foreach ($z in $zielPixel) {
  $nx = ConvertTo-Anteil ($z[0] / ($schirm.Width - 1.0))
  $ny = ConvertTo-Anteil ($z[1] / ($schirm.Height - 1.0))
  SendeFrames @(, (New-MausAbsFrame -X $nx -Y $ny))
}

# Klick in der Mitte, damit Runter und Hoch je einmal kommen.
$mx = ConvertTo-Anteil 0.5
$my = ConvertTo-Anteil 0.5
SendeFrames @((New-MausAbsFrame -X $mx -Y $my),
              (New-MausTasteFrame -Taste 0 -Runter $true),
              (New-MausTasteFrame -Taste 0 -Runter $false))

SendeFrames @(, (New-RadFrame -Dv 120))

# Die Tastenfolge geht in Buendeln zu 32 hinaus -- das ist zugleich die
# Gegenprobe auf die Buendelung, die v2 gegenueber v1 neu erlaubt (v1 liess
# genau einen Frame je Nachricht zu).
$tastenFrames = @(New-TastenFolge $scancodes)
for ($k = 0; $k -lt $tastenFrames.Count; $k += 32) {
  $ende = [Math]::Min($k + 31, $tastenFrames.Count - 1)
  SendeFrames @($tastenFrames[$k..$ende])
}
# Erweiterte Taste getrennt -- sie ist der Fall, an dem ein Messmittel scheitert.
SendeFrames @((New-TasteFrame -Scan 0xE01D -Runter $true),
              (New-TasteFrame -Scan 0xE01D -Runter $false))

Sende @{ op = 'remote_input_end' }

$nachher = Test-PruefzielObenauf $pruefziel.Id $mitteX $mitteY
$stoerung = if ($nachher.ok) { 0 } else { 1 }

$proc.StandardInput.Close()
$ausgabe = $proc.StandardOutput.ReadToEnd()
$fehler  = $proc.StandardError.ReadToEnd()
$proc.WaitForExit(10000) | Out-Null

Start-Sleep -Seconds 2
if (-not $pruefziel.HasExited) { Stop-Process -Id $pruefziel.Id -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

# --- Auswerten -----------------------------------------------------------

$zeilen = @(Get-Content $log | ForEach-Object { $_ | ConvertFrom-Json })
$bewegt = @($zeilen | Where-Object { $_.art -eq 'maus_bewegt' })
$tasten = @($zeilen | Where-Object { $_.art -eq 'taste' })
$klicks = @($zeilen | Where-Object { $_.art -eq 'maus_taste' })
$raeder = @($zeilen | Where-Object { $_.art -eq 'rad' })

# Die erste Bewegung stammt vom Zeiger, der beim Aufziehen des Fensters ohnehin
# irgendwo stand -- sie gehoert nicht zur Messung.
$treffer = @()
$i = 0
foreach ($z in $zielPixel) {
  $passend = $bewegt | Where-Object { $_.x -eq $z[0] -and $_.y -eq $z[1] } | Select-Object -First 1
  if ($passend) {
    $treffer += [ordered]@{ ziel = "$($z[0]),$($z[1])"; ist = "$($passend.x),$($passend.y)"; delta = 0 }
  } else {
    # Naechstgelegene tatsaechliche Bewegung suchen, damit die Abweichung
    # benannt wird statt nur "nicht gefunden".
    $nah = $bewegt | Sort-Object { [Math]::Abs($_.x - $z[0]) + [Math]::Abs($_.y - $z[1]) } | Select-Object -First 1
    $d = if ($nah) { [Math]::Max([Math]::Abs($nah.x - $z[0]), [Math]::Abs($nah.y - $z[1])) } else { -1 }
    $treffer += [ordered]@{ ziel = "$($z[0]),$($z[1])"
                            ist = $(if ($nah) { "$($nah.x),$($nah.y)" } else { 'nichts' }); delta = $d }
  }
  $i++
}

$gesendeteScans = @($scancodes) + @(0xE01D)
$empfangeneScans = @($tasten | Where-Object { $_.runter } | ForEach-Object { $_.scan })
$tastenGleich = (($gesendeteScans -join ',') -eq ($empfangeneScans -join ','))
$maxDelta = ($treffer | ForEach-Object { $_.delta } | Measure-Object -Maximum).Maximum

if ($stoerung -gt 0) {
  Write-Host ''
  Write-Host ("LAUF UNGUELTIG: waehrend der Messung hat sich ein fremdes Fenster ueber das " +
              "Pruefziel gelegt (Klasse $($nachher.info.klasse), Prozess-Id $($nachher.info.pid)).")
  Write-Host 'Es schluckt die Eingabe -- die Zahlen unten waeren erfunden. Bitte erneut fahren.'
  [void](Clear-Fremdfenster $mitteX $mitteY)
  exit 2
}

Write-Host ''
Write-Host '=== Maus: Ziel gegen Empfangen ==='
$treffer | ForEach-Object { "  {0,-12} -> {1,-12} Delta {2}" -f $_.ziel, $_.ist, $_.delta }
Write-Host ''
Write-Host "Groesste Abweichung : $maxDelta px"
Write-Host "Klick-Ereignisse    : $($klicks.Count) (erwartet 2)"
Write-Host "Rad-Ereignisse      : $($raeder.Count) (erwartet 1), Delta $(($raeder | Select-Object -First 1).delta)"
Write-Host "Tasten gesendet     : $($gesendeteScans.Count)"
Write-Host "Tasten empfangen    : $($empfangeneScans.Count)"
Write-Host "Scancodes identisch : $tastenGleich"
Write-Host ''
Write-Host '=== Sidecar-Antworten ==='
$ausgabe -split "`n" | Where-Object { $_.Trim() } | Select-Object -Last 6 | ForEach-Object { "  $_" }
if ($fehler.Trim()) {
  Write-Host '=== stderr (letzte Zeilen) ==='
  $fehler -split "`n" | Where-Object { $_.Trim() } | Select-Object -Last 6 | ForEach-Object { "  $_" }
}

if ($Akte) {
  @{
    maus = $treffer; groesste_abweichung_px = $maxDelta
    klicks = $klicks.Count; raeder = $raeder.Count
    scancodes_gesendet = $gesendeteScans; scancodes_empfangen = $empfangeneScans
    scancodes_identisch = $tastenGleich
    bildschirm = "$($schirm.Width)x$($schirm.Height)"
  } | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 $Akte
  Write-Host "Rohwerte in $Akte"
}
