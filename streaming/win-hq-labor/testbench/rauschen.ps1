# Eine ANSPRUCHSVOLLE Bildaenderung: Vollbild-Rauschen, jedes Bild neu.
#
# WOZU, neben `bewegung.ps1`: der kleine wandernde Balken dort genuegt fuer
# eine LASTmessung (er sorgt dafuer, dass WGC ueberhaupt liefert), taugt aber
# NICHT fuer eine Messung der Ratensteuerung. Ein fast stehender Bildschirm
# braucht kaum Bits; jeder Encoder bleibt dann weit unter der bestellten
# Datenrate, ohne dass etwas kaputt waere. Am 2026-08-19 hat genau das einen
# Fehlschluss erzeugt: "av1_amf haelt bei 10 Bit die Datenrate nicht ein" --
# gemessen an einem Bild, das die Bits gar nicht braucht.
#
# Rauschen ist das Gegenteil: es ist nicht vorhersagbar, nicht zwischen Bildern
# aehnlich und nicht raeumlich glatt. Ein Encoder kann daran nicht sparen. Wer
# hier unter der Bestellung bleibt, kann es nicht am Inhalt liegen haben.
#
# Die Bloecke sind absichtlich GROESSER als ein Bildpunkt (Vorgabe 4): echtes
# Punktrauschen ist so hochfrequent, dass die Quantisierung es einfach
# wegwirft -- dann misst man wieder die Sparsamkeit des Encoders statt seiner
# Ratensteuerung. Vier Punkte je Block liegen ueber der Transformationsgroesse
# und ueberleben.
#
# KEIN -WindowStyle Hidden beim Start von aussen (Begruendung in
# last-messen.ps1): WinForms nimmt wShowWindow der Startinformation fuer sein
# erstes Fenster, das Fenster bliebe unsichtbar und der Bildschirm stuende
# still -- die Messung liefe dann gegen ein stehendes Bild, ohne dass es
# auffiele.
param(
  [int]$Sekunden = 60,
  # Kantenlaenge eines Rauschblocks in Bildpunkten.
  [int]$Block = 4,
  # Bildabstand in Millisekunden.
  [int]$Abstand = 15
)

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$schirm = [Windows.Forms.Screen]::PrimaryScreen.Bounds
$breite = [int]($schirm.Width / $Block)
$hoehe = [int]($schirm.Height / $Block)

$f = New-Object Windows.Forms.Form
$f.FormBorderStyle = 'None'
$f.WindowState = 'Maximized'
$f.TopMost = $true
$f.BackColor = 'Black'

# Ein kleines Bitmap zeichnen und beim Ausgeben vergroessern.
#
# **Der Speicherblock am Stueck ist der Punkt, nicht eine Feinheit.** Die erste
# Fassung setzte am 2026-08-19 jeden Punkt einzeln (`SetPixel`) -- fuer
# 480x270 sind das 129.600 Aufrufe je Bild, und PowerShell braucht dafuer
# Sekunden. Das Ergebnis war ein Bild, das sich alle paar Sekunden ruckartig
# komplett aenderte statt im Bildtakt: die Messung sah anspruchsvoll aus und
# war in Wahrheit ein stehender Bildschirm mit Ausschlaegen. `NextBytes` fuellt
# den ganzen Block in einem Aufruf, `LockBits` schiebt ihn in einem Stueck ins
# Bitmap.
$klein = New-Object Drawing.Bitmap($breite, $hoehe, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
$zufall = New-Object Random 12345
$puffer = New-Object byte[] ($breite * $hoehe * 4)
$rechteck = New-Object Drawing.Rectangle 0, 0, $breite, $hoehe

$f.Add_Paint({
  param($absender, $e)
  $zufall.NextBytes($puffer)
  $daten = $klein.LockBits($rechteck, [Drawing.Imaging.ImageLockMode]::WriteOnly,
                           [Drawing.Imaging.PixelFormat]::Format32bppArgb)
  [Runtime.InteropServices.Marshal]::Copy($puffer, 0, $daten.Scan0, $puffer.Length)
  $klein.UnlockBits($daten)
  $e.Graphics.InterpolationMode = 'NearestNeighbor'
  $e.Graphics.PixelOffsetMode = 'Half'
  $e.Graphics.DrawImage($klein, 0, 0, $schirm.Width, $schirm.Height)
})

$t = New-Object Windows.Forms.Timer
$t.Interval = $Abstand
$t.Add_Tick({ $f.Invalidate() })
$t.Start()

$ende = New-Object Windows.Forms.Timer
$ende.Interval = $Sekunden * 1000
$ende.Add_Tick({ $f.Close() })
$ende.Start()

[Windows.Forms.Application]::Run($f)
