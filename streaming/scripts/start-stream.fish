#!/usr/bin/env fish
# Startet GSR und pushed an lokalen MediaMTX via RTMP.
# Stoppen mit Ctrl+C (sauberer Shutdown).
#
# Stream-Name: "test" (frei wählbar, einfach Variable ändern)
# Schau dir den Stream im Browser an: http://localhost:8889/test

set stream_name test
set rtmp_url "rtmp://localhost:1935/$stream_name"

# Settings (anpassen falls nötig)
set fps 60
set bitrate 8000   # kbps, CBR
set codec h264     # Browser-kompatibel
set audio_codec aac # RTMP/FLV braucht AAC

echo "→ GSR startet:"
echo "    Capture : Wayland Portal (KDE wird Permission-Dialog zeigen)"
echo "    Codec   : $codec @ $bitrate kbps CBR"
echo "    FPS     : $fps"
echo "    Audio   : Default Output (AAC)"
echo "    Push an : $rtmp_url"
echo ""
echo "→ Stream im Browser: http://localhost:8889/$stream_name (WebRTC)"
echo "                  oder http://localhost:8888/$stream_name (HLS Vergleich)"
echo ""
echo "→ Stoppen mit Ctrl+C"
echo ""

gpu-screen-recorder \
    -w portal \
    -restore-portal-session yes \
    -f $fps \
    -c flv \
    -k $codec \
    -bm cbr \
    -q $bitrate \
    -ac $audio_codec \
    -a default_output \
    -o "$rtmp_url"
