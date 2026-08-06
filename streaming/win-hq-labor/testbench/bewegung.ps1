# Eine billige Bildaenderung -- damit eine Lastmessung ueberhaupt Last hat.
#
# WARUM ES DAS GIBT: WGC ist aenderungsgetrieben. Steht der Bildschirm, liefert
# es fast nichts, und dann misst man eine Kopie oder einen Shader, der gar nicht
# laeuft. Genau so ist die erste Reihe am 2026-08-06 gescheitert (93 Prozent
# Duplikat-Takte, beide Arme bei 0,5 Prozent -- ein "kein Unterschied", das nur
# hiess, dass keine Arbeit anfiel).
#
# WARUM NICHT DER PLAYER: er streitet um dieselbe Grafikeinheit und verzerrt die
# Sender-Zahlen ueber die Taktregelung der APU. Ausserdem laesst sich mit
# laufendem Player kein STEHENDES Bild herstellen, und das ist der zweite
# Messfall. Dieses Fenster kostet praktisch nichts (GDI, ein Rechteck).
#
# ES WAR SCHON EINMAL DA UND IST VERLORENGEGANGEN. Die Messung vom 2026-08-06
# hat sich so eine Quelle gebaut und nicht eingecheckt; die naechste Messung
# musste sie neu erfinden. Deshalb liegt sie jetzt hier.
#
# AUFRUF:
#   powershell -File bewegung.ps1 -Sekunden 300
#   (endet von selbst; Fenster schliessen geht auch)

param(
  [int]$Sekunden = 300,
  [int]$Breite = 480,
  [int]$Hoehe = 160,
  # Bildabstand in Millisekunden. 15 ist der Deckel der Aufnahme (0,9/60) --
  # schneller zu zeichnen brauchte niemand, weil WGC ohnehin nicht oefter
  # liefert.
  [int]$Abstand = 15
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:breite = $Breite
$script:hoehe  = $Hoehe
$script:x      = 0

$f = New-Object Windows.Forms.Form
$f.Text            = 'Bewegung (Messquelle)'
$f.FormBorderStyle = 'FixedToolWindow'
$f.TopMost         = $true
$f.StartPosition   = 'Manual'
$f.Location        = New-Object Drawing.Point(40, 40)
$f.ClientSize      = New-Object Drawing.Size($Breite, $Hoehe)
$f.BackColor       = [Drawing.Color]::Black

# Ein wandernder heller Balken. Absichtlich WEISS auf SCHWARZ: der groesste
# Kontrast, den ein Bild hergibt, also auch fuer den Encoder etwas zu tun.
$f.Add_Paint({
  param($absender, $e)
  $e.Graphics.FillRectangle([Drawing.Brushes]::White, $script:x, 0, 60, $script:hoehe)
})

$t = New-Object Windows.Forms.Timer
$t.Interval = $Abstand
$t.Add_Tick({
  $script:x = ($script:x + 11) % $script:breite
  $f.Invalidate()
})

$schluss = New-Object Windows.Forms.Timer
$schluss.Interval = [Math]::Max(1000, $Sekunden * 1000)
$schluss.Add_Tick({ $f.Close() })

$t.Start()
$schluss.Start()
[Windows.Forms.Application]::Run($f)
