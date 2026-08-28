#!/bin/sh
# Hard-fail if mandatory env vars are missing. The pulse-required vars
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
check_var PULSE_INSTANCE_ID
check_var PULSE_CLOUD_CLIENT_ID
check_var PULSE_CLOUD_CLIENT_SECRET
check_var PULSE_ADMIN_EMAIL
check_var PULSE_INSTANCE_OWNER_ID

if [ -n "${MISSING}" ]; then
    cat >&2 <<EOF
[10-check-cloud-creds] FATAL: missing required env var(s):${MISSING}

Set these in your \`docker run\` (or compose file). The registry needs a login
first — an anonymous pull is rejected with 401. Example:

  docker login registry.howispulse.com -u <client_id> -p <client_secret>

  docker run -d --name pulse \\
    -v pulse-data:/data \\
    -p 443:443 -p 80:80 -p 7882-7892:7882-7892/udp -p 3478:3478 -p 3478:3478/udp \\
    -p 1936:1936/tcp -p 8189:8189/udp \\
    -e PULSE_HOSTNAME=chat.firma.de \\
    -e PULSE_INSTANCE_ID=... \\
    -e PULSE_INSTANCE_OWNER_ID=... \\
    -e PULSE_CLOUD_CLIENT_ID=... \\
    -e PULSE_CLOUD_CLIENT_SECRET=... \\
    -e PULSE_ADMIN_EMAIL=admin@firma.de \\
    registry.howispulse.com/pulse-allinone:stable

instance_id, owner_id, client_id and client_secret all come from approval on
howispulse.com — copy the ready-to-use .env from "Meine Instanzen" (Download)
and fill in the client_secret you saved at approval time.
(see https://howispulse.com/self-host/guide → step 1, "Download the .env").
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
