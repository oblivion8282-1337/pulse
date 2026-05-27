#!/usr/bin/env fish
#
# Startet Chromium mit Remote-Debugging-Port + isoliertem User-Data-Dir.
# Default-URL ist die Pulse-Dev-Vite (127.0.0.1:5173).
#
# Nutzung:
#   ./scripts/cdp/launch.fish <port> <profile-suffix> [url]
#
# Beispiel:
#   ./scripts/cdp/launch.fish 9222 alice
#   ./scripts/cdp/launch.fish 9223 bob   http://127.0.0.1:5173/invite/ABCD
#
# Profile landen unter /tmp/pulse-cdp-profile-<suffix>/ — beim zweiten
# Launch mit gleichem Suffix bleibt die IndexedDB (= eingeloggter User
# inkl. Identity-Cert) erhalten.

if test (count $argv) -lt 2
    echo "Usage: launch.fish <port> <profile-suffix> [url]" >&2
    exit 2
end

set -l port $argv[1]
set -l suffix $argv[2]
set -l url (test (count $argv) -ge 3; and echo $argv[3]; or echo "http://127.0.0.1:5173/")
set -l profile "/tmp/pulse-cdp-profile-$suffix"

mkdir -p $profile
nohup chromium \
    --remote-debugging-port=$port \
    --user-data-dir=$profile \
    --no-first-run \
    --no-default-browser-check \
    --disable-features=PasswordCheck,AutofillServerCommunication \
    --window-size=1400,900 \
    $url \
    >/tmp/pulse-chromium-$suffix.log 2>&1 &
disown

# Auf CDP-HTTP-Endpoint warten (bis zu 10 s)
for i in (seq 20)
    if curl -fs http://127.0.0.1:$port/json/version >/dev/null 2>&1
        echo "[launch] Chromium $suffix bereit auf :$port (profile=$profile)"
        exit 0
    end
    sleep 0.5
end
echo "[launch] WARN: kein CDP-Response von :$port nach 10 s — Chromium evtl. gecrasht. Log: /tmp/pulse-chromium-$suffix.log" >&2
exit 1
