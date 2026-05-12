#!/usr/bin/env fish
# SRT-Push mit Opus-Audio. Braucht GSR ≥ 5.13.5 — die System-Version
# (AUR 5.13.4) hat das ts-in-Opus-Whitelist Feature noch nicht.
#
# Falls Custom-Build vorhanden, den nehmen, sonst System-Binary mit Warnung.
# Custom-Build erstellen: bootstrap-gsr-master.fish

set script_dir (dirname (status -f))
set custom_gsr /tmp/gsr-analysis/gpu-screen-recorder/build/gpu-screen-recorder
set system_gsr (command -v gpu-screen-recorder)

if test -x $custom_gsr
    set gsr_bin $custom_gsr
    echo "→ Nutze Custom-Build: $gsr_bin (Version: "($custom_gsr --version)")"
else
    set gsr_bin $system_gsr
    echo "⚠️  Custom-Build fehlt unter $custom_gsr"
    echo "    System-Version: "($system_gsr --version)
    echo "    Falls < 5.13.5 → Audio fällt auf AAC zurück (kein Opus)"
end

set stream_key (cat $script_dir/server/.stream-key)
set server_ip 77.42.71.166
set stream_name test
set srt_url "srt://$server_ip:8890?streamid=publish:$stream_name:michael:$stream_key&pkt_size=1316"

set fps 60
set bitrate 8000
set codec h264
set audio_codec opus

echo ""
echo "→ GSR pusht via SRT + MPEG-TS + Opus:"
echo "    Server  : $server_ip:8890 (SRT/UDP)"
echo "    Stream  : $stream_name"
echo "    Codec   : $codec @ $bitrate kbps CBR + Opus Audio"
echo ""
echo "→ Zuschauer-URLs:"
echo "    WebRTC (sub-second + Audio): http://$server_ip:8889/$stream_name"
echo "    HLS (Vergleich): http://$server_ip:8888/$stream_name"
echo ""
echo "→ Stoppen mit Ctrl+C"
echo ""

$gsr_bin \
    -w portal \
    -restore-portal-session yes \
    -f $fps \
    -c mpegts \
    -k $codec \
    -bm cbr \
    -q $bitrate \
    -ac $audio_codec \
    -a default_output \
    -o "$srt_url"
