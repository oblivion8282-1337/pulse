#!/bin/sh
# Restart-rate limiter — invoked from each longrun unit's ./finish.
# Counts crashes in /var/run/pulse/restart-counter/<service> and, if more
# than 5 happened in the last 60s, signals s6-overlay to terminate stage 2
# (S6_BEHAVIOUR_IF_STAGE2_FAILS=2 → container exit → Docker restart-policy).
#
# Implementation note: s6-overlay v3 supports finish-scripts but has no
# native "max restarts in window" knob. We approximate it with a rolling
# counter that records the unix timestamp of each crash. 5 crashes within
# 60 seconds → call /run/s6/basedir/bin/halt to bring the supervision tree
# down cleanly. This is the documented escape hatch in the s6-overlay v3
# docs (see "Stopping the container").
set -eu

SERVICE="$1"
WINDOW=60            # seconds
LIMIT=5              # crashes per window
STATE_DIR=/var/run/pulse/restart-counter
STATE_FILE="${STATE_DIR}/${SERVICE}"

mkdir -p "${STATE_DIR}"
now=$(date +%s)

# Append current timestamp; keep only the last 20 (we cap at LIMIT but a
# small buffer makes the awk simpler).
echo "${now}" >> "${STATE_FILE}"
tail -n 20 "${STATE_FILE}" > "${STATE_FILE}.tmp" && mv "${STATE_FILE}.tmp" "${STATE_FILE}"

# Count entries within the window
count=$(awk -v now="${now}" -v win="${WINDOW}" 'now - $1 <= win { c++ } END { print c+0 }' "${STATE_FILE}")

echo "[restart-gate] ${SERVICE} crashed (count=${count}/${LIMIT} in last ${WINDOW}s)" >&2

if [ "${count}" -ge "${LIMIT}" ]; then
    echo "[restart-gate] ${SERVICE} hit ${LIMIT} crashes in ${WINDOW}s — halting container" >&2
    /run/s6/basedir/bin/halt 2>/dev/null || s6-svscanctl -t /run/s6-rc 2>/dev/null || kill 1
fi
