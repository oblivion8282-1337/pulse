# fetch-win-native.ps1 — baut resources-native/ für das native Windows-Backend
# (Server-App OHNE WSL2/Virtualisierung). Lokales Gegenstück zum CI-Step
# "native Backend-Bausteine bündeln" (win-build-server.yml).
#
# Layout nach Lauf:
#   resources-native/
#     native-bin/   caddy.exe, weed.exe, livekit-server.exe, mediamtx.exe,
#                   direct-adapter.exe, frpc.exe, garnet/GarnetServer.exe
#                   (+dlls), dotnet/ (Runtime für Garnet), pg/bin/ (Postgres 15)
#     python/       venv (uv, Python 3.13) mit allen Service-Deps
#     services/     Python-Quellen: auth, chat-gateway, media-svc,
#                   voice-signaling, mediamtx-auth-hook, shared
#     templates/    Caddyfile.template (aus infra/self-host)
#     gen_selfsigned_cert.py
#
# weed.exe: SeaweedFS liefert KEIN volles Windows-Binary mehr (nur weed-volume,
# ohne Subcommands, 2026-10 verifiziert) → aus dem Source gebaut (Go cross-
# compile, CI) oder lokal via -WeedSource. direct-adapter.exe: cargo build
# aus infra/self-host/direct-adapter (CI) oder lokal via -AdapterSource.

param(
    [string]$Root = (Join-Path $PSScriptRoot "..\resources-native"),
    [switch]$WeedSource,   # weed.exe selbst bauen (braucht go + Netz)
    [switch]$AdapterSource # direct-adapter.exe selbst bauen (braucht cargo)
)

$ErrorActionPreference = "Stop"

# Versions-Pins — zusammen mit den SHA256-Prüfungen unten pflegen.
$CaddyVersion   = "2.8.4"
$GarnetVersion  = "2.2.0"
$LivekitVersion = "1.13.3"   # gleiches Pin wie das allinone-Image
$MediamtxVersion = "1.19.1"  # upstream; Fork-Windows-Artifact steht noch aus
$PgVersion      = "15.14-1"
$DotnetVersion  = "10.0.12"
$WeedVersion    = "4.48"
$FrpVersion     = "0.69.1"   # passend zum frps der Cloud (snowdreamtech/frps:0.69.1)

$Repo = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$Tmp = Join-Path $env:TEMP "pulse-native-fetch"
New-Item -ItemType Directory -Force -Path $Tmp, $Root | Out-Null
$Bin = Join-Path $Root "native-bin"
New-Item -ItemType Directory -Force -Path $Bin | Out-Null

function Fetch($Url, $Out) {
    Write-Host "→ $Url"
    Invoke-WebRequest -Uri $Url -OutFile $Out -MaximumRedirection 5
}

function Unzip($Zip, $Dest) {
    Expand-Archive -Path $Zip -DestinationPath $Dest -Force
}

# ── Caddy ────────────────────────────────────────────────────────────────────
if (-not (Test-Path (Join-Path $Bin "caddy.exe"))) {
    Fetch "https://github.com/caddyserver/caddy/releases/download/v$CaddyVersion/caddy_${CaddyVersion}_windows_amd64.zip" "$Tmp/caddy.zip"
    Unzip "$Tmp/caddy.zip" "$Tmp/caddy"
    Copy-Item "$Tmp/caddy/caddy.exe" $Bin
}

# ── frpc (Steuerungs-Relay-Tunnel: /livekit + /whep auf den Relay-Hostnamen) ─
if (-not (Test-Path (Join-Path $Bin "frpc.exe"))) {
    Fetch "https://github.com/fatedier/frp/releases/download/v$FrpVersion/frp_${FrpVersion}_windows_amd64.zip" "$Tmp/frp.zip"
    Unzip "$Tmp/frp.zip" "$Tmp/frp"
    Copy-Item "$Tmp/frp/frp_${FrpVersion}_windows_amd64/frpc.exe" $Bin
}

# ── Garnet (+ .NET-Runtime — das Release-Zip ist runtime-abhängig) ──────────
if (-not (Test-Path (Join-Path $Bin "garnet\GarnetServer.exe"))) {
    Fetch "https://github.com/microsoft/garnet/releases/download/v$GarnetVersion/win-x64-based-readytorun.zip" "$Tmp/garnet.zip"
    Unzip "$Tmp/garnet.zip" "$Tmp/garnet"
    $garnetExe = Get-ChildItem "$Tmp/garnet" -Recurse -Filter "GarnetServer.exe" | Select-Object -First 1
    if (-not $garnetExe) { throw "GarnetServer.exe nicht im Release-Zip" }
    New-Item -ItemType Directory -Force -Path (Join-Path $Bin "garnet") | Out-Null
    Copy-Item (Join-Path $garnetExe.Directory.FullName "*") (Join-Path $Bin "garnet") -Recurse -Force
}
if (-not (Test-Path (Join-Path $Bin "dotnet\dotnet.exe"))) {
    Fetch "https://builds.dotnet.microsoft.com/dotnet/Runtime/$DotnetVersion/dotnet-runtime-$DotnetVersion-win-x64.zip" "$Tmp/dotnet.zip"
    Unzip "$Tmp/dotnet.zip" (Join-Path $Bin "dotnet")
}

# ── LiveKit ─────────────────────────────────────────────────────────────────
if (-not (Test-Path (Join-Path $Bin "livekit-server.exe"))) {
    Fetch "https://github.com/livekit/livekit-server/releases/download/v$LivekitVersion/livekit_${LivekitVersion}_windows_amd64.zip" "$Tmp/livekit.zip"
    Unzip "$Tmp/livekit.zip" "$Tmp/livekit"
    Copy-Item "$Tmp/livekit/livekit-server.exe" $Bin
}

# ── MediaMTX ────────────────────────────────────────────────────────────────
if (-not (Test-Path (Join-Path $Bin "mediamtx.exe"))) {
    Fetch "https://github.com/bluenviron/mediamtx/releases/download/v$MediamtxVersion/mediamtx_v${MediamtxVersion}_windows_amd64.zip" "$Tmp/mediamtx.zip"
    Unzip "$Tmp/mediamtx.zip" "$Tmp/mediamtx"
    Copy-Item "$Tmp/mediamtx/mediamtx.exe" $Bin
}

# ── weed (SeaweedFS) — self-built bis ein volles Windows-Release existiert ──
if (-not (Test-Path (Join-Path $Bin "weed.exe"))) {
    if ($WeedSource) {
        if (-not (Get-Command go -ErrorAction SilentlyContinue)) { throw "go nicht gefunden (-WeedSource)" }
        $src = Join-Path $Tmp "seaweedfs"
        if (-not (Test-Path $src)) {
            git clone --depth 1 --branch "$WeedVersion" https://github.com/seaweedfs/seaweedfs.git $src
        }
        Push-Location (Join-Path $src "weed")
        go build -trimpath -ldflags "-s -w" -o (Join-Path $Bin "weed.exe") .
        Pop-Location
    } else {
        throw "weed.exe fehlt — CI-Artifact oder -WeedSource verwenden (kein offizielles Windows-Release, siehe Kopf)."
    }
}

# ── direct-adapter ──────────────────────────────────────────────────────────
if (-not (Test-Path (Join-Path $Bin "direct-adapter.exe"))) {
    if ($AdapterSource) {
        if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { throw "cargo nicht gefunden (-AdapterSource)" }
        Push-Location (Join-Path $Repo "infra\self-host\direct-adapter")
        cargo build --release
        Copy-Item "target\release\direct-adapter.exe" $Bin
        Pop-Location
    } else {
        Write-Warning "direct-adapter.exe fehlt — Direktpfad/Chat-Brücke bleibt aus (CI-Artifact oder -AdapterSource)."
    }
}

# ── Postgres 15 (EDB portable binaries) ─────────────────────────────────────
# initdb braucht bin/ + lib/ + share/ (postgres.bki, Timezonedaten) — der
# Rest des EDB-Zips (pgAdmin, doc, include, StackBuilder) bleibt draußen.
if (-not (Test-Path (Join-Path $Bin "pg\share\postgres.bki"))) {
    Fetch "https://get.enterprisedb.com/postgresql/postgresql-$PgVersion-windows-x64-binaries.zip" "$Tmp/pg.zip"
    Unzip "$Tmp/pg.zip" "$Tmp/pg"
    $pgBinSrc = Get-ChildItem "$Tmp/pg" -Recurse -Filter "postgres.exe" | Select-Object -First 1
    if (-not $pgBinSrc) { throw "postgres.exe nicht im EDB-Zip" }
    $pgSrc = $pgBinSrc.Directory.Parent.FullName
    New-Item -ItemType Directory -Force -Path (Join-Path $Bin "pg") | Out-Null
    foreach ($part in @("bin", "lib", "share")) {
        Copy-Item (Join-Path $pgSrc $part) (Join-Path $Bin "pg") -Recurse -Force
    }
}

# ── Python-venv (uv) mit allen Service-Deps ────────────────────────────────
$venv = Join-Path $Root "python"
if (-not (Test-Path (Join-Path $venv "python.exe"))) {
    if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { throw "uv nicht gefunden — https://docs.astral.sh/uv/" }
    uv venv $venv --python 3.13
    # Deps aus den pyprojects (die Quelle der Wahrheit), NICHT von Hand:
    foreach ($svc in @("auth", "chat-gateway", "media-svc", "voice-signaling", "mediamtx-auth-hook")) {
        uv pip install --python $venv (Join-Path $Repo "services\$svc")
    }
    uv pip install --python $venv (Join-Path $Repo "shared")
}

# ── Service-Quellen + Templates + Cert-Helfer ──────────────────────────────
$svcDest = Join-Path $Root "services"
New-Item -ItemType Directory -Force -Path $svcDest | Out-Null
foreach ($d in @("auth", "chat-gateway", "media-svc", "voice-signaling", "mediamtx-auth-hook")) {
    $from = Join-Path $Repo "services\$d"
    $to = Join-Path $svcDest $d
    if (Test-Path $to) { Remove-Item $to -Recurse -Force }
    robocopy $from $to /E /XD __pycache__ .venv tests /NFL /NDL /NJH /NJS | Out-Null
    # robocopy: 0-7 sind Erfolgscodes (1 = Dateien kopiert), ab 8 Fehler.
    if ($LASTEXITCODE -ge 8) { throw "robocopy $d fehlgeschlagen (Exit $LASTEXITCODE)" }
}
$sharedTo = Join-Path $svcDest "shared"
if (Test-Path $sharedTo) { Remove-Item $sharedTo -Recurse -Force }
robocopy (Join-Path $Repo "shared") $sharedTo /E /XD __pycache__ .venv tests /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy shared fehlgeschlagen (Exit $LASTEXITCODE)" }

$tplDest = Join-Path $Root "templates"
New-Item -ItemType Directory -Force -Path $tplDest | Out-Null
Copy-Item (Join-Path $Repo "infra\self-host\s6\etc\caddy\Caddyfile.template") $tplDest -Force
Copy-Item (Join-Path $Repo "desktop\electron\gen_selfsigned_cert.py") $Root -Force

Write-Host "`nresources-native fertig: $Root"
# pwsh -File gibt sonst den Exit-Code des LETZTEN nativen Befehls zurück —
# robocopy meldet 1 bei Erfolg ("Dateien kopiert"), der CI-Schritt failte
# trotz vollständigem Lauf (Win-Runner, 2026-10-03). Explizit 0 setzen.
exit 0
