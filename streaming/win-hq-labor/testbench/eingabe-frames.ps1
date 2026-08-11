# Frame-Erzeuger fuer das Input-Wire-Protokoll v2.
#
# ZUM EINBINDEN GEDACHT, nicht zum Aufrufen:
#   . .\eingabe-frames.ps1
#
# WARUM ES DAS GETRENNT GIBT: Der Nachweis der Fernsteuerung braucht Frames,
# die GENAU der Spezifikation entsprechen -- sonst prueft er den Injektor gegen
# einen zweiten Fehler statt gegen die Absprache. Die Kodierung steht deshalb an
# EINER Stelle, und die ist diese hier. Vorlage ist
# docs/plans/2026-08-12-input-wire-protokoll-v2.md; weicht der Code davon ab,
# ist der Code falsch.
#
# Alles little-endian, Byte 0 ist der Opcode, feste Laengen.

# KEIN Set-StrictMode hier: Die Datei wird eingebunden, und der Modus wuerde in
# die aufrufende Sitzung durchschlagen. Das hat beim ersten Versuch die
# Fehlerbehandlung des Aufrufers zerlegt.

function New-HelloFrame {
  param([byte]$Version = 2)
  return [byte[]]@(0x00, $Version)
}

function New-MausAbsFrame {
  # x/y sind ANTEILE 0..65535, bezogen auf das Bildrechteck -- nicht Pixel.
  # Begruendung steht in der Spezifikation: ein Anteil bedeutet auf jeder
  # Aufloesung dasselbe, Pixelwerte verlangten, dass beide Seiten die Geometrie
  # des Hosts kennen und einig sind.
  param([int]$X, [int]$Y)
  $b = [byte[]]::new(5)
  $b[0] = 0x01
  [BitConverter]::GetBytes([uint16]$X).CopyTo($b, 1)
  [BitConverter]::GetBytes([uint16]$Y).CopyTo($b, 3)
  return $b
}

function New-MausRelFrame {
  param([int]$Dx, [int]$Dy)
  $b = [byte[]]::new(5)
  $b[0] = 0x02
  [BitConverter]::GetBytes([int16]$Dx).CopyTo($b, 1)
  [BitConverter]::GetBytes([int16]$Dy).CopyTo($b, 3)
  return $b
}

function New-MausTasteFrame {
  # 0=links 1=rechts 2=mitte 3=X1 4=X2
  param([int]$Taste, [bool]$Runter)
  return [byte[]]@(0x03, [byte]$Taste, [byte]($(if ($Runter) { 1 } else { 0 })))
}

function New-RadFrame {
  # 120 = eine Raste, positiv = vom Nutzer weg.
  param([int]$Dv, [int]$Dh = 0)
  $b = [byte[]]::new(5)
  $b[0] = 0x04
  [BitConverter]::GetBytes([int16]$Dv).CopyTo($b, 1)
  [BitConverter]::GetBytes([int16]$Dh).CopyTo($b, 3)
  return $b
}

function New-TasteFrame {
  # Scancode Satz 1; erweiterte Tasten als 0xE0xx.
  param([int]$Scan, [bool]$Runter)
  $b = [byte[]]::new(4)
  $b[0] = 0x05
  [BitConverter]::GetBytes([uint16]$Scan).CopyTo($b, 1)
  $b[3] = [byte]($(if ($Runter) { 1 } else { 0 }))
  return $b
}

function ConvertTo-FrameBase64 {
  # Nimmt eine Liste von Byte-Feldern und liefert die Base64-Zeichenketten fuer
  # das frames-Feld der Huelle.
  param([object[]]$Frames)
  return @($Frames | ForEach-Object { [Convert]::ToBase64String([byte[]]$_) })
}

function ConvertTo-Anteil {
  # Bildanteil 0..1 auf die 16-Bit-Stufung. Beide Raender muessen exakt treffen:
  # 0.0 -> 0 und 1.0 -> 65535, sonst erreicht der Zeiger den Bildrand nie.
  # Genau dieser Rundungsfehler steckt in Nvidias Skalierung und ist bei
  # Moonlight eigens umschifft worden.
  param([double]$Anteil)
  $v = [Math]::Round($Anteil * 65535.0)
  if ($v -lt 0) { $v = 0 }
  if ($v -gt 65535) { $v = 65535 }
  return [int]$v
}

# Scancodes Satz 1 fuer einen Textnachweis.
#
# ACHTUNG, UND DAS IST DER PUNKT DES NACHWEISES: Diese Zahlen sind PHYSISCHE
# Tastenplaetze, keine Zeichen. Auf einer deutschen Belegung erzeugt 0x15 ein
# "z" und 0x2C ein "y" -- die US-Namen unten benennen die Taste, nicht das, was
# herauskommt. Deshalb wird beim Nachweis SCANCODE gegen SCANCODE verglichen und
# nicht Zeichen gegen Zeichen: Das Protokoll ist absichtlich
# belegungsunabhaengig, und ein Zeichenvergleich wuerde die Belegung mitpruefen
# statt der Uebertragung.
$script:ScanSatz1 = @{
  'a' = 0x1E; 'b' = 0x30; 'c' = 0x2E; 'd' = 0x20; 'e' = 0x12; 'f' = 0x21
  'g' = 0x22; 'h' = 0x23; 'i' = 0x17; 'j' = 0x24; 'k' = 0x25; 'l' = 0x26
  'm' = 0x32; 'n' = 0x31; 'o' = 0x18; 'p' = 0x19; 'q' = 0x10; 'r' = 0x13
  's' = 0x1F; 't' = 0x14; 'u' = 0x16; 'v' = 0x2F; 'w' = 0x11; 'x' = 0x2D
  'y' = 0x15; 'z' = 0x2C
  '1' = 0x02; '2' = 0x03; '3' = 0x04; '4' = 0x05; '5' = 0x06
  '6' = 0x07; '7' = 0x08; '8' = 0x09; '9' = 0x0A; '0' = 0x0B
  ' ' = 0x39
}

function Get-ScancodeFolge {
  # Liefert die Scancode-Folge fuer eine Zeichenkette (nur Zeichen aus der
  # Tabelle oben). Unbekannte Zeichen werden uebersprungen und gemeldet --
  # still zu verwerfen hiesse, einen Nachweis mit Luecken zu fuehren.
  param([string]$Text)
  $aus = @()
  foreach ($c in $Text.ToLowerInvariant().ToCharArray()) {
    $k = [string]$c
    if ($script:ScanSatz1.ContainsKey($k)) {
      $aus += $script:ScanSatz1[$k]
    } else {
      Write-Warning "Kein Scancode fuer '$k' -- uebersprungen"
    }
  }
  return ,$aus
}

function New-TastenFolge {
  # Runter/Hoch-Paare fuer eine Scancode-Folge.
  param([int[]]$Scancodes)
  $aus = @()
  foreach ($s in $Scancodes) {
    $aus += ,(New-TasteFrame -Scan $s -Runter $true)
    $aus += ,(New-TasteFrame -Scan $s -Runter $false)
  }
  return ,$aus
}
