#!/usr/bin/env fish
# Startet MediaMTX im Vordergrund mit unserer Config.
# Stoppen mit Ctrl+C.

set script_dir (dirname (status -f))
cd $script_dir

echo "→ MediaMTX startet auf:"
echo "    RTMP-Ingest : rtmp://localhost:1935/<stream-name>"
echo "    WebRTC-Out  : http://localhost:8889/<stream-name>"
echo "    HLS-Out     : http://localhost:8888/<stream-name>"
echo "    API         : http://localhost:9997/v3/paths/list"
echo ""
echo "→ Stoppen mit Ctrl+C"
echo ""

exec ./mediamtx mediamtx.yml
