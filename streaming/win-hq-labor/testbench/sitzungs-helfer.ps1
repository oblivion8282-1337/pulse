# Sitzungs-Helfer -- das Auge der Bruecke.
#
# WARUM ES DAS GIBT: Windows trennt die am Monitor angemeldete Sitzung streng
# von der Sitzung, die eine SSH-Anmeldung erzeugt. Jeder Prozess sieht nur den
# Desktop seiner EIGENEN Sitzung. Ueber SSH heisst das:
#   * ein gestarteter HQ-Sidecar nimmt nicht den echten Bildschirm auf,
#   * GetCursorPos liefert den Zeiger der unsichtbaren Sitzung,
#   * ein Bildschirmfoto ist schwarz.
# Genau diese drei Dinge sind beim Fernsteuer-Test das Messobjekt. SSH allein
# kann bauen, lesen und Dateien schieben -- sehen und pruefen kann es nicht.
#
# Dieses Programm laeuft IN der angemeldeten Sitzung und lauscht auf 127.0.0.1.
# Die Gegenseite ist ueber SSH ohnehin schon auf der Maschine und ruft es lokal.
#
# ES IST EIN PRUEFWERKZEUG, KEIN PRODUKTTEIL. Es gehoert nicht in den Installer
# und nicht in den Autostart einer Auslieferung.
#
# KEINE AUTHENTIFIZIERUNG, KEINE VERSCHLUESSELUNG -- Absicht: die Bindung ist
# ausschliesslich Loopback, und wer SSH auf dieser Maschine hat, hat ohnehin
# alles. Ein Passwort waere Zierde ohne Wirkung. Deshalb aber auch NIEMALS
# 0.0.0.0 oder + als Praefix.
#
# AUFRUF:
#   powershell -File sitzungs-helfer.ps1
#   powershell -File sitzungs-helfer.ps1 -Port 47615 -Sekunden 3600
#
# ABFRAGEN (von der SSH-Seite, auf derselben Maschine):
#   curl.exe -s http://127.0.0.1:47615/gesundheit
#   curl.exe -s http://127.0.0.1:47615/zeiger
#   curl.exe -s http://127.0.0.1:47615/monitore
#   curl.exe -s "http://127.0.0.1:47615/bild?monitor=0&pfad=C:\Temp\schirm.png"
#   curl.exe -s -X POST --data-binary "{\"datei\":\"notepad.exe\"}" http://127.0.0.1:47615/starten

param(
  [int]$Port = 47615,
  # 0 = laeuft, bis das Fenster geschlossen wird.
  [int]$Sekunden = 0
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# WARUM DAS ZUERST KOMMT: ohne DPI-Bewusstsein spiegelt Windows dem Prozess
# eine kleinere, hochgerechnete Bildflaeche vor. Zeigerposition und
# Monitor-Rechtecke kaemen dann in virtuellen Punkten heraus, das Bildschirmfoto
# in echten Pixeln -- und die Fernsteuerung rechnete mit zwei Massstaeben.
Add-Type -Namespace Bruecke -Name Nativ -MemberDefinition @'
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(System.Drawing.Point pt, uint flags);
  [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr hmon, int typ, out uint dpiX, out uint dpiY);
'@ -ReferencedAssemblies System.Drawing

try { [void][Bruecke.Nativ]::SetProcessDPIAware() } catch { }

function Skalierung([int]$x, [int]$y) {
  # 96 dpi ist 100 Prozent. Faellt die Abfrage aus (aeltere Windows-Fassung),
  # ist 1.0 die ehrlichere Antwort als eine geratene Zahl.
  try {
    $h = [Bruecke.Nativ]::MonitorFromPoint((New-Object Drawing.Point($x, $y)), 2)
    $dx = 0; $dy = 0
    if ([Bruecke.Nativ]::GetDpiForMonitor($h, 0, [ref]$dx, [ref]$dy) -eq 0) {
      return [Math]::Round($dx / 96.0, 4)
    }
  } catch { }
  return 1.0
}

function MonitorListe {
  $i = 0
  $aus = @()
  foreach ($s in [Windows.Forms.Screen]::AllScreens) {
    $b = $s.Bounds
    $aus += [ordered]@{
      index       = $i
      name        = $s.DeviceName
      primaer     = $s.Primary
      x           = $b.X
      y           = $b.Y
      breite      = $b.Width
      hoehe       = $b.Height
      skalierung  = (Skalierung ($b.X + [int]($b.Width / 2)) ($b.Y + [int]($b.Height / 2)))
    }
    $i++
  }
  return ,$aus
}

function GesamtRechteck {
  $l = [int]::MaxValue; $o = [int]::MaxValue; $r = [int]::MinValue; $u = [int]::MinValue
  foreach ($s in [Windows.Forms.Screen]::AllScreens) {
    $b = $s.Bounds
    if ($b.Left   -lt $l) { $l = $b.Left }
    if ($b.Top    -lt $o) { $o = $b.Top }
    if ($b.Right  -gt $r) { $r = $b.Right }
    if ($b.Bottom -gt $u) { $u = $b.Bottom }
  }
  return New-Object Drawing.Rectangle($l, $o, ($r - $l), ($u - $o))
}

function Bildschirmfoto([string]$monitor, [string]$pfad) {
  if ([string]::IsNullOrWhiteSpace($pfad)) { throw "Parameter 'pfad' fehlt" }
  $verz = Split-Path -Parent $pfad
  if ($verz -and -not (Test-Path $verz)) { New-Item -ItemType Directory -Force $verz | Out-Null }

  if ($monitor -eq 'alle' -or [string]::IsNullOrWhiteSpace($monitor)) {
    $rect = GesamtRechteck
  } else {
    $schirme = [Windows.Forms.Screen]::AllScreens
    $n = [int]$monitor
    if ($n -lt 0 -or $n -ge $schirme.Count) { throw "Monitor $n gibt es nicht (0..$($schirme.Count - 1))" }
    $rect = $schirme[$n].Bounds
  }

  $bmp = New-Object Drawing.Bitmap($rect.Width, $rect.Height)
  try {
    $g = [Drawing.Graphics]::FromImage($bmp)
    try {
      $g.CopyFromScreen($rect.Location, [Drawing.Point]::Empty, $rect.Size)
    } finally { $g.Dispose() }
    $bmp.Save($pfad, [Drawing.Imaging.ImageFormat]::Png)
  } finally { $bmp.Dispose() }

  return [ordered]@{ pfad = $pfad; x = $rect.X; y = $rect.Y; breite = $rect.Width; hoehe = $rect.Height }
}

function ProzessStarten($anfrage) {
  # VORSICHT MIT DER ZURUECKGEGEBENEN PID: bei Startprogrammen, die den echten
  # Prozess erst anstossen (die meisten Store-Anwendungen, auch notepad.exe unter
  # Windows 11), beendet sich der gestartete Prozess sofort wieder, und die PID
  # zeigt auf nichts. Fuer den Zweck hier -- einen Sidecar auf dem echten Desktop
  # starten -- ist das kein Problem, weil das eine echte .exe ist. Wer die PID
  # zum Beenden benutzt, prueft sie vorher.
  if (-not $anfrage.datei) { throw "Feld 'datei' fehlt" }
  $p = @{ FilePath = [string]$anfrage.datei; PassThru = $true }
  if ($anfrage.argumente) { $p.ArgumentList     = [string[]]$anfrage.argumente }
  if ($anfrage.verzeichnis) { $p.WorkingDirectory = [string]$anfrage.verzeichnis }
  $proc = Start-Process @p
  return [ordered]@{ pid = $proc.Id; datei = [string]$anfrage.datei }
}

# --- HTTP ---------------------------------------------------------------

$l = New-Object System.Net.HttpListener
$l.Prefixes.Add("http://127.0.0.1:$Port/")
$l.Start()

$ende = if ($Sekunden -gt 0) { (Get-Date).AddSeconds($Sekunden) } else { [datetime]::MaxValue }

Write-Host "Sitzungs-Helfer laeuft auf http://127.0.0.1:$Port/"
Write-Host "Sitzung $((Get-Process -Id $PID).SessionId), Benutzer $env:USERNAME. Strg+C beendet."

try {
  while ($l.IsListening -and (Get-Date) -lt $ende) {
    $ctx  = $l.GetContext()
    $req  = $ctx.Request
    $res  = $ctx.Response
    $code = 200

    try {
      $koerper = $null
      if ($req.HasEntityBody) {
        $sr = New-Object IO.StreamReader($req.InputStream, $req.ContentEncoding)
        try { $roh = $sr.ReadToEnd() } finally { $sr.Dispose() }
        if ($roh) { $koerper = $roh | ConvertFrom-Json }
      }

      switch ($req.Url.AbsolutePath.TrimEnd('/')) {
        ''            { $antwort = [ordered]@{ ok = $true; pfade = @('/gesundheit','/zeiger','/monitore','/bild','/starten') } }
        '/gesundheit' { $antwort = [ordered]@{
                          ok        = $true
                          sitzung   = (Get-Process -Id $PID).SessionId
                          benutzer  = $env:USERNAME
                          rechner   = $env:COMPUTERNAME
                          monitore  = ([Windows.Forms.Screen]::AllScreens).Count
                        } }
        '/zeiger'     { $pos = [Windows.Forms.Cursor]::Position
                        $antwort = [ordered]@{ x = $pos.X; y = $pos.Y } }
        '/monitore'   { $antwort = MonitorListe }
        '/bild'       { $antwort = Bildschirmfoto $req.QueryString['monitor'] $req.QueryString['pfad'] }
        '/starten'    { $antwort = ProzessStarten $koerper }
        default       { $code = 404; $antwort = [ordered]@{ fehler = "unbekannter Pfad $($req.Url.AbsolutePath)" } }
      }
    } catch {
      $code = 400
      $antwort = [ordered]@{ fehler = $_.Exception.Message }
    }

    $text  = $antwort | ConvertTo-Json -Depth 6 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($text)
    $res.StatusCode  = $code
    $res.ContentType = 'application/json; charset=utf-8'
    $res.ContentLength64 = $bytes.Length
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
    $res.Close()
  }
} finally {
  $l.Stop()
  $l.Close()
}
