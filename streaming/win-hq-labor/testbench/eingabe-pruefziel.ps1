# Eingabe-Pruefziel -- ein Vollbild-Fenster, das Maus und Tastatur auffaengt.
#
# WARUM ES DAS GIBT: Um die Fernsteuerung zu pruefen, muss Eingabe injiziert
# werden (SendInput). Das ist auf einem benutzten Rechner gefaehrlich -- ein
# Klick landet irgendwo, ein Tastendruck geht in ein fremdes Fenster. Dieses
# Fenster legt sich ueber ALLE Bildschirme und faengt beides ab. Nichts kann
# danebengehen, weil daneben nichts mehr liegt.
#
# UND ES IST DAS BESSERE MESSMITTEL. GetCursorPos zurueckzulesen sagt nur, wo
# der Zeiger steht. Dieses Fenster sagt, was Windows an einem echten Fenster
# tatsaechlich ANKOMMEN laesst -- also die Strecke, die es im Ernstfall auch
# geht. Zwischen beidem liegen die Fallen: Monitor-Zuordnung, DPI-Skalierung,
# erweiterte Tasten.
#
# ES SCHREIBT EINE JSONL-DATEI, eine Zeile je Ereignis, sofort geschrieben --
# damit ein zweiter Prozess mitlesen kann, waehrend der Lauf noch laeuft.
#
# ZWANGSABSCHALTUNG: Das Fenster beendet sich nach -Sekunden von selbst. Das
# ist keine Bequemlichkeit, sondern Pflicht -- ein Vollbildfenster, das Eingabe
# schluckt und haengenbleibt, sperrt den Rechner aus. Zusaetzlich beendet
# Strg+Alt+Umschalt+Q von Hand (dasselbe Kuerzel wie bei Moonlight).
#
# AUFRUF:
#   powershell -File eingabe-pruefziel.ps1 -Pfad C:\Temp\lauf.jsonl -Sekunden 60
#
# ZEILENARTEN in der Datei:
#   bereit      einmal am Anfang, mit Desktop-Rechteck und Monitorliste
#   maus_bewegt x/y in BILDSCHIRM-Koordinaten
#   maus_taste  taste, runter (true/false), x/y
#   rad         delta (120 = eine Raste), x/y
#   taste       vk, name, scan (Scancode Satz 1), erweitert, runter
#   text        Inhalt des Textfelds, beim Ende
#   ende        grund = zeit | kuerzel

param(
  [string]$Pfad = "$env:TEMP\eingabe-pruefziel.jsonl",
  [int]$Sekunden = 120,
  # Ohne Abdunkeln sieht man auf einem Bildschirmfoto nicht, ob das Fenster
  # wirklich oben lag. Mit 255 (deckend) ist es eine schwarze Flaeche.
  [int]$Deckkraft = 235
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# MUSS vor jeder Koordinaten-Abfrage stehen. Ohne DPI-Bewusstsein liefert
# Windows virtualisierte Werte, und dann misst dieses Fenster den Fehler, den
# es aufdecken soll. (Dieselbe Pflicht steht im Wire-Protokoll fuer den
# Sidecar: PER_MONITOR_AWARE_V2 vor der ersten Injektion.)
Add-Type -Namespace Pruefziel -Name Nativ -MemberDefinition @'
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern uint MapVirtualKeyW(uint code, uint art);
'@
try { [void][Pruefziel.Nativ]::SetProcessDPIAware() } catch { }

$verz = Split-Path -Parent $Pfad
if ($verz -and -not (Test-Path $verz)) { New-Item -ItemType Directory -Force $verz | Out-Null }

$schreiber = New-Object IO.StreamWriter($Pfad, $false, [Text.UTF8Encoding]::new($false))
$schreiber.AutoFlush = $true
$uhr = [Diagnostics.Stopwatch]::StartNew()

function Zeile($art, $werte) {
  $o = [ordered]@{ t = [int]$uhr.ElapsedMilliseconds; art = $art }
  foreach ($k in $werte.Keys) { $o[$k] = $werte[$k] }
  $schreiber.WriteLine(($o | ConvertTo-Json -Depth 5 -Compress))
}

# --- Geometrie ----------------------------------------------------------

$l = [int]::MaxValue; $o = [int]::MaxValue; $r = [int]::MinValue; $u = [int]::MinValue
$monitore = @()
$i = 0
foreach ($s in [Windows.Forms.Screen]::AllScreens) {
  $b = $s.Bounds
  if ($b.Left   -lt $l) { $l = $b.Left }
  if ($b.Top    -lt $o) { $o = $b.Top }
  if ($b.Right  -gt $r) { $r = $b.Right }
  if ($b.Bottom -gt $u) { $u = $b.Bottom }
  $monitore += [ordered]@{ index = $i; name = $s.DeviceName; primaer = $s.Primary
                           x = $b.X; y = $b.Y; breite = $b.Width; hoehe = $b.Height }
  $i++
}
$desktop = New-Object Drawing.Rectangle($l, $o, ($r - $l), ($u - $o))

# --- Fenster ------------------------------------------------------------

$f = New-Object Windows.Forms.Form
$f.Text            = 'Pulse Eingabe-Pruefziel'
$f.FormBorderStyle = 'None'
$f.StartPosition   = 'Manual'
$f.Bounds          = $desktop
$f.TopMost         = $true
$f.BackColor       = [Drawing.Color]::FromArgb(12, 12, 16)
$f.Opacity         = [Math]::Max(0.5, [Math]::Min(1.0, $Deckkraft / 255.0))
$f.KeyPreview      = $true
$f.Cursor          = [Windows.Forms.Cursors]::Cross

# Das Textfeld ist der Rueckleseweg fuer die Tastatur: injizierter Text landet
# hier und wird am Ende Zeichen fuer Zeichen verglichen. Es liegt bewusst weit
# ausserhalb der Bildmitte, damit Maus-Zielpunkte nicht darauf fallen.
$feld = New-Object Windows.Forms.TextBox
$feld.Multiline  = $true
$feld.Width      = [int]($desktop.Width * 0.5)
$feld.Height     = 90
$feld.Left       = [int](($desktop.Width - $feld.Width) / 2)
$feld.Top        = $desktop.Height - 150
$feld.Font       = New-Object Drawing.Font('Consolas', 14)
$feld.BackColor  = [Drawing.Color]::FromArgb(24, 24, 30)
$feld.ForeColor  = [Drawing.Color]::White
$feld.BorderStyle = 'FixedSingle'
$f.Controls.Add($feld)

$script:letzteX = -1
$script:letzteY = -1
$script:nMaus   = 0
$script:nTaste  = 0
$script:nKlick  = 0

# Gezeichnet wird im Takt, nicht je Ereignis -- sonst kostet eine schnelle
# Mausbewegung mehr Zeit im Zeichnen als in der Messung.
$f.Add_Paint({
  param($absender, $e)
  $g = $e.Graphics
  $mitteX = [int]($desktop.Width / 2)
  $mitteY = [int]($desktop.Height / 2)
  $stift = New-Object Drawing.Pen([Drawing.Color]::FromArgb(60, 60, 80), 1)
  for ($x = 0; $x -lt $desktop.Width; $x += 200)  { $g.DrawLine($stift, $x, 0, $x, $desktop.Height) }
  for ($y = 0; $y -lt $desktop.Height; $y += 200) { $g.DrawLine($stift, 0, $y, $desktop.Width, $y) }
  $stift.Dispose()

  $schrift = New-Object Drawing.Font('Consolas', 16)
  $text = "PULSE EINGABE-PRUEFZIEL`n" +
          "Bewegungen $($script:nMaus)   Klicks $($script:nKlick)   Tasten $($script:nTaste)`n" +
          "Zeiger $($script:letzteX) / $($script:letzteY)`n" +
          "Ende automatisch nach $Sekunden s   -   Strg+Alt+Umschalt+Q beendet"
  $g.DrawString($text, $schrift, [Drawing.Brushes]::Gainsboro, 40, 40)
  $schrift.Dispose()

  if ($script:letzteX -ge 0) {
    $p = New-Object Drawing.Pen([Drawing.Color]::OrangeRed, 2)
    $g.DrawLine($p, ($script:letzteX - 30), $script:letzteY, ($script:letzteX + 30), $script:letzteY)
    $g.DrawLine($p, $script:letzteX, ($script:letzteY - 30), $script:letzteX, ($script:letzteY + 30))
    $g.DrawEllipse($p, ($script:letzteX - 12), ($script:letzteY - 12), 24, 24)
    $p.Dispose()
  }
})

function BildschirmPunkt($e) {
  # MouseEventArgs liefert Fenster-Koordinaten. Das Fenster deckt den ganzen
  # virtuellen Desktop, dessen Ursprung aber negativ sein kann (Monitor links
  # vom Hauptmonitor) -- deshalb wird der Ursprung addiert, nicht angenommen.
  return @{ x = ($e.X + $desktop.X); y = ($e.Y + $desktop.Y) }
}

$f.Add_MouseMove({
  param($absender, $e)
  $script:letzteX = $e.X; $script:letzteY = $e.Y; $script:nMaus++
  $p = BildschirmPunkt $e
  Zeile 'maus_bewegt' @{ x = $p.x; y = $p.y }
})

$f.Add_MouseDown({
  param($absender, $e)
  $script:nKlick++
  $p = BildschirmPunkt $e
  Zeile 'maus_taste' @{ taste = "$($e.Button)"; runter = $true; x = $p.x; y = $p.y }
})

$f.Add_MouseUp({
  param($absender, $e)
  $p = BildschirmPunkt $e
  Zeile 'maus_taste' @{ taste = "$($e.Button)"; runter = $false; x = $p.x; y = $p.y }
})

$f.Add_MouseWheel({
  param($absender, $e)
  $p = BildschirmPunkt $e
  Zeile 'rad' @{ delta = $e.Delta; x = $p.x; y = $p.y }
})

function TasteZeile($e, $runter) {
  $vk = [int]$e.KeyCode
  # Art 4 = MAPVK_VK_TO_VSC_EX: liefert bei erweiterten Tasten den 0xE0-Praefix
  # im oberen Byte. Ohne EX faellt genau die Unterscheidung weg, die das
  # Protokoll fuer rechte Strg-Taste und Pfeiltasten braucht.
  $scan = [int][Pruefziel.Nativ]::MapVirtualKeyW([uint32]$vk, 4)
  Zeile 'taste' @{ vk = $vk; name = "$($e.KeyCode)"; scan = $scan
                   erweitert = (($scan -band 0xE000) -ne 0); runter = $runter }
}

$f.Add_KeyDown({
  param($absender, $e)
  $script:nTaste++
  TasteZeile $e $true
  if ($e.Control -and $e.Alt -and $e.Shift -and $e.KeyCode -eq [Windows.Forms.Keys]::Q) {
    $script:grund = 'kuerzel'
    $f.Close()
  }
})

$f.Add_KeyUp({ param($absender, $e); TasteZeile $e $false })

$zeichnen = New-Object Windows.Forms.Timer
$zeichnen.Interval = 50
$zeichnen.Add_Tick({ $f.Invalidate() })

$schluss = New-Object Windows.Forms.Timer
$schluss.Interval = [Math]::Max(1000, $Sekunden * 1000)
$schluss.Add_Tick({ $script:grund = 'zeit'; $f.Close() })

$script:grund = 'zeit'

$f.Add_Shown({
  $f.Activate()
  $feld.Focus() | Out-Null
  Zeile 'bereit' @{ desktop = @{ x = $desktop.X; y = $desktop.Y
                                 breite = $desktop.Width; hoehe = $desktop.Height }
                    monitore = $monitore; pid = $PID }
})

$zeichnen.Start()
$schluss.Start()

try {
  [Windows.Forms.Application]::Run($f)
} finally {
  Zeile 'text' @{ inhalt = $feld.Text }
  Zeile 'ende' @{ grund = $script:grund; bewegungen = $script:nMaus
                  klicks = $script:nKlick; tasten = $script:nTaste }
  $schreiber.Dispose()
}
