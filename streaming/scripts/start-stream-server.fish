#!/usr/bin/env fish
# Pusht GSR-Stream an den Public-Server (Hetzner-vServer 77.42.71.166)
# Stream-Key liegt in server/.stream-key (chmod 600)

set script_dir (dirname (status -f))
set stream_key (cat $script_dir/server/.stream-key)
set server_ip 77.42.71.166
set stream_name test
set rtmp_url "rtmp://$server_ip:1935/$stream_name?user=michael&pass=$stream_key"

# Settings
set fps 60
set bitrate 8000
set codec h264
set audio_codec aac

echo "→ GSR pusht an Public-Server:"
echo "    Server  : $server_ip"
echo "    Stream  : $stream_name (mit Auth)"
echo "    Codec   : $codec @ $bitrate kbps CBR"
echo ""
echo "→ Zuschauer-URL (HLS, mit Audio):"
echo "    http://$server_ip:8888/$stream_name"
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
