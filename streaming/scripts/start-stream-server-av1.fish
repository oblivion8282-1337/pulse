#!/usr/bin/env fish
# AV1 + Opus + Enhanced RTMP — höchste Effizienz, WebRTC-kompatibel.
#
# Braucht:
#   - GSR ≥ 5.13.5 (Custom-Build) MIT zusätzlichem flv-Patch in Opus-Whitelist
#   - FFmpeg ≥ 6.1 (Enhanced RTMP / FourCC av01+Opus) — n8.1.1 ist drauf, ok
#   - MediaMTX ≥ 1.x (RTMP-Ingest mit Enhanced-RTMP-Support, ist drin)
#
# Custom-Build mit Patch erstellen: bootstrap-gsr-master.fish + manueller Patch
# (siehe README → "AV1 via Enhanced RTMP")

set script_dir (dirname (status -f))
set custom_gsr /tmp/gsr-analysis/gpu-screen-recorder/build/gpu-screen-recorder

if not test -x $custom_gsr
    echo "✗ Custom-Build fehlt unter $custom_gsr"
    echo "  Erst bootstrap-gsr-master.fish + Opus-FLV-Patch ausführen"
    exit 1
end

# Verifikation: hat das Binary den FLV-Patch?
if not strings $custom_gsr | grep -q "and .flv files"
    echo "⚠️  Custom-Build hat den FLV-Patch nicht — Audio würde auf AAC fallen"
    echo "    Patch siehe README"
    exit 1
end

echo "→ Nutze gepatchten Custom-Build: $custom_gsr"

set stream_key (cat $script_dir/server/.stream-key)
set server_ip 77.42.71.166
set stream_name test
set rtmp_url "rtmp://$server_ip:1935/$stream_name?user=michael&pass=$stream_key"

set fps 60
set bitrate 4000      # AV1 ~50% effizienter als H.264 → halbe Bitrate
set codec av1
set audio_codec opus

echo ""
echo "→ GSR pusht via Enhanced RTMP:"
echo "    Server  : $server_ip:1935 (RTMP/TCP)"
echo "    Stream  : $stream_name (Auth via Query-Param)"
echo "    Codec   : AV1 @ $bitrate kbps CBR + Opus Audio"
echo ""
echo "→ Zuschauer-URLs:"
echo "    WebRTC: http://$server_ip:8889/$stream_name"
echo "    HLS:    http://$server_ip:8888/$stream_name"
echo ""
echo "⚠️  Bekannter MediaMTX-Bug #5632: WebRTC kann bei sehr wenig Bewegung"
echo "    einfrieren. Refresh löst es."
echo ""
echo "→ Stoppen mit Ctrl+C"
echo ""

$custom_gsr \
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
