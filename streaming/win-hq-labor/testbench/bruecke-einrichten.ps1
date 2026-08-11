# Bruecke Linux -> Windows: den SSH-Zugang einrichten.
#
# ALS ADMINISTRATOR AUSFUEHREN. Ohne erhoehte Rechte laesst sich weder die
# OpenSSH-Faehigkeit nachinstallieren noch der Dienst setzen -- das Skript
# bricht dann sofort ab, statt auf halbem Weg liegenzubleiben.
#
#   powershell -ExecutionPolicy Bypass -File bruecke-einrichten.ps1 -Schluessel "ssh-ed25519 AAAA... kommentar"
#
# WAS ES TUT: OpenSSH-Server einschalten, den uebergebenen oeffentlichen
# Schluessel hinterlegen, PowerShell als Standard-Shell setzen, die
# Firewall-Regel pruefen. Danach kann die Gegenstelle diese Maschine bauen,
# lesen und beschreiben lassen -- sehen kann sie sie nicht, dafuer gibt es
# sitzungs-helfer.ps1 (Begruendung steht dort).
#
# ZURUECKNEHMEN, jederzeit:
#   Stop-Service sshd; Set-Service -Name sshd -StartupType Disabled
# oder nur die Schluesselzeile aus der authorized_keys loeschen -- dann ist
# dieser eine Zugang weg, der Dienst bleibt.

param(
  [Parameter(Mandatory = $true)]
  [string]$Schluessel,

  # Das Heimnetz ist bei der Ersteinrichtung oft als OEFFENTLICH eingestuft, und
  # dann greift eine Regel mit Profil "Private" nicht -- die Anmeldung laeuft
  # ins Zeitlimit, ohne dass irgendwo etwas Falsches steht. Dieser Schalter
  # stuft die genannte Verbindung auf "Private" herunter.
  [string]$NetzAufPrivat = ''
)

$ErrorActionPreference = 'Stop'

# NICHT IsInRole('Administrators') -- die Zeichenketten-Fassung vergleicht den
# GRUPPENNAMEN, und der heisst auf deutschem Windows "Administratoren". Die
# Pruefung liefert dort immer False, auch in einem erhoehten Fenster, und das
# Skript weist dann seine eigene Voraussetzung ab. Die Aufzaehlung geht ueber
# die feste Kennung der Gruppe und ist damit sprachunabhaengig. (Dieselbe Falle
# wie LC_ALL=C beim git-tidy-Alias in CLAUDE.md.)
$ich = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $ich.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Nicht erhoeht gestartet. PowerShell als Administrator oeffnen und erneut aufrufen."
}

if ($Schluessel -notmatch '^(ssh-ed25519|ssh-rsa|ecdsa-)') {
  throw "Das sieht nicht nach einem oeffentlichen SSH-Schluessel aus."
}

Write-Host '== OpenSSH-Server =='
$cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*'
if ($cap.State -ne 'Installed') {
  Add-WindowsCapability -Online -Name $cap.Name | Out-Null
}
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd
Get-Service sshd | Select-Object Status, StartType | Format-List

Write-Host '== Schluessel hinterlegen =='
# DIE HAEUFIGSTE STOLPERFALLE: fuer Konten in der Gruppe Administratoren liest
# Windows-OpenSSH NICHT %USERPROFILE%\.ssh\authorized_keys, sondern
# C:\ProgramData\ssh\administrators_authorized_keys -- und nur, wenn deren
# Rechte streng gesetzt sind. Ist eines von beidem nicht erfuellt, schlaegt die
# Anmeldung ohne brauchbare Meldung fehl.
$istAdminKonto = (Get-LocalGroupMember -Group (Get-LocalGroup -SID 'S-1-5-32-544').Name |
                  Where-Object { $_.Name -like "*\$env:USERNAME" }) -ne $null

if ($istAdminKonto) {
  $datei = 'C:\ProgramData\ssh\administrators_authorized_keys'
  if (-not (Test-Path $datei)) { New-Item -ItemType File -Path $datei | Out-Null }
  if (-not (Select-String -Path $datei -SimpleMatch $Schluessel -Quiet)) {
    Add-Content -Path $datei -Value $Schluessel -Encoding ascii
  }
  # Auch hier die festen Kennungen statt der Namen (S-1-5-32-544 = Administratoren,
  # S-1-5-18 = SYSTEM). Mit Namen gearbeitet, schlaegt icacls auf einem anders
  # eingestellten Windows fehl -- und OpenSSH lehnt die Datei dann wegen zu
  # weiter Rechte ab, ohne dass die Anmeldung sagt, woran es liegt.
  icacls $datei /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F' | Out-Null
} else {
  $datei = "$env:USERPROFILE\.ssh\authorized_keys"
  New-Item -ItemType Directory -Force "$env:USERPROFILE\.ssh" | Out-Null
  if (-not (Test-Path $datei)) { New-Item -ItemType File -Path $datei | Out-Null }
  if (-not (Select-String -Path $datei -SimpleMatch $Schluessel -Quiet)) {
    Add-Content -Path $datei -Value $Schluessel -Encoding ascii
  }
}
Write-Host "Schluessel steht in $datei (Adminkonto: $istAdminKonto)"

Write-Host '== Standard-Shell =='
# Sonst landet jede SSH-Sitzung in cmd.exe, und jeder Aufruf braucht ein
# umstaendliches powershell -Command "...".
$sh = if (Test-Path 'C:\Program Files\PowerShell\7\pwsh.exe') { 'C:\Program Files\PowerShell\7\pwsh.exe' }
      else { "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" }
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value $sh -PropertyType String -Force | Out-Null
Write-Host $sh

if ($NetzAufPrivat) {
  Write-Host '== Netzprofil =='
  Set-NetConnectionProfile -InterfaceAlias $NetzAufPrivat -NetworkCategory Private
  Get-NetConnectionProfile | Select-Object Name, InterfaceAlias, NetworkCategory | Format-Table -AutoSize
}

Write-Host '== Firewall =='
$regel = Get-NetFirewallRule -Name *OpenSSH-Server* -ErrorAction SilentlyContinue
if (-not $regel) {
  # Nur Private, nicht Public: der Zugang soll im Heimnetz erreichbar sein,
  # nicht in fremden WLANs.
  New-NetFirewallRule -Name sshd -DisplayName 'OpenSSH Server (sshd)' -Enabled True `
    -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -Profile Private | Out-Null
  $regel = Get-NetFirewallRule -Name sshd
}
$regel | Select-Object Name, Enabled, Profile | Format-Table -AutoSize

Write-Host ''
Write-Host 'Fertig. Gegenprobe auf dieser Maschine (darf NICHT nach einem Passwort fragen):'
Write-Host '  ssh -o BatchMode=yes localhost "whoami; hostname"'
Write-Host 'Schlaegt sie fehl:  Get-Content C:\ProgramData\ssh\logs\sshd.log -Tail 30'
