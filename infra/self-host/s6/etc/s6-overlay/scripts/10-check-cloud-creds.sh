#!/bin/sh
# Hard-fail if mandatory env vars are missing. The four pulse-required vars
# (Phase 6 plan, "Pflicht-Env-Vars"). All others have defaults.
set -eu

MISSING=""

check_var() {
    name="$1"
    value=$(eval "echo \${${name}:-}")
    if [ -z "${value}" ]; then
        MISSING="${MISSING} ${name}"
    fi
}

check_var PULSE_HOSTNAME
check_var PULSE_CLOUD_CLIENT_ID
check_var PULSE_CLOUD_CLIENT_SECRET
check_var PULSE_ADMIN_EMAIL

if [ -n "${MISSING}" ]; then
    cat >&2 <<EOF
[10-check-cloud-creds] FATAL: missing required env var(s):${MISSING}

Set these in your \`docker run\` (or compose file). Example:

  docker run -d --name pulse \\
    -v pulse-data:/data \\
    -p 443:443 -p 80:80 -p 7882-7892:7882-7892/udp -p 3478:3478 -p 3478:3478/udp \\
    -e PULSE_HOSTNAME=chat.firma.de \\
    -e PULSE_CLOUD_CLIENT_ID=... \\
    -e PULSE_CLOUD_CLIENT_SECRET=... \\
    -e PULSE_ADMIN_EMAIL=admin@firma.de \\
    ghcr.io/oblivion8282-1337/pulse-allinone:stable

The client_id/secret pair comes from approval on howispulse.com
(see docs/SELF_HOST.md → "Setup für Self-Hoster", step 4).
EOF
    exit 1
fi

# Validate the hostname looks like a real DNS name (defense in depth — also
# checked in the Cloud approval flow but better to reject loud here).
if ! echo "${PULSE_HOSTNAME}" | grep -qE '^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$'; then
    echo "[10-check-cloud-creds] FATAL: PULSE_HOSTNAME='${PULSE_HOSTNAME}' is not a valid DNS name" >&2
    exit 1
fi

echo "[10-check-cloud-creds] required env vars present (hostname=${PULSE_HOSTNAME})"
