# Lokales Gegenstück zum CI-Step "Podman für App-Hosting bündeln" (win-build.yml).
# Lädt SHA-gepinnt podman.exe + gvproxy.exe + win-sshproxy.exe nach resources-podman/.
$ErrorActionPreference = 'Stop'
$ver = '5.8.4'
$sha = 'dce234b1810d1cbe3ce2562cf961294f942b0fa886a61897a2926aab17885f90'
$zip = "$env:TEMP\podman-win.zip"
if (-not (Test-Path $zip)) {
  Invoke-WebRequest -Uri "https://github.com/containers/podman/releases/download/v$ver/podman-remote-release-windows_amd64.zip" -OutFile $zip
}
$actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
if ($actual -ne $sha) { throw "podman zip SHA mismatch: $actual" }
Write-Output 'SHA OK'
Expand-Archive $zip -DestinationPath "$env:TEMP\podman-extract" -Force
$bin = "$env:TEMP\podman-extract\podman-$ver\usr\bin"
$dest = "$PSScriptRoot\..\resources-podman"
Copy-Item "$bin\podman.exe", "$bin\gvproxy.exe", "$bin\win-sshproxy.exe" -Destination $dest
Get-ChildItem $dest | Select-Object Name, Length
