#!/bin/sh
# Generate every Self-Host-internal secret on first boot. All files live
# under /data/jwt_keys/ (chmod 600, owned by pulse).
# Idempotent: only writes if the file is missing.
set -eu
DATA="${PULSE_DATA_PATH:-/data}"
KEYS="${DATA}/jwt_keys"
mkdir -p "${KEYS}"
chmod 0700 "${KEYS}"

gen_urlsafe() {
    # 32 bytes → 43 url-safe chars (no padding)
    python3 -c 'import secrets; print(secrets.token_urlsafe(32))'
}

gen_hex() {
    python3 -c 'import secrets; print(secrets.token_hex(32))'
}

write_if_missing() {
    target="$1"
    value="$2"
    if [ ! -f "${target}" ]; then
        printf '%s' "${value}" > "${target}"
        chmod 0600 "${target}"
        chown pulse:pulse "${target}"
        echo "[03-init-secrets] generated ${target}"
    fi
}

# Internal service-to-service shared secret (auth → chat-gateway etc.)
[ -f "${KEYS}/internal_service.token" ] || write_if_missing \
    "${KEYS}/internal_service.token" "$(gen_urlsafe)"

# Postgres password (used by the role 'pulse' and every service in env)
[ -f "${KEYS}/postgres.password" ] || write_if_missing \
    "${KEYS}/postgres.password" "$(gen_hex)"

# Cert-challenge HMAC (chat-gateway /cert-login challenge signing)
[ -f "${KEYS}/cert_challenge.secret" ] || write_if_missing \
    "${KEYS}/cert_challenge.secret" "$(gen_urlsafe)"

# LiveKit API key + secret pair
[ -f "${KEYS}/livekit.key" ] || write_if_missing \
    "${KEYS}/livekit.key" "pulse-selfhost-$(python3 -c 'import secrets; print(secrets.token_hex(4))')"
[ -f "${KEYS}/livekit.secret" ] || write_if_missing \
    "${KEYS}/livekit.secret" "$(gen_hex)"

# MinIO root credentials — embedded S3 object store for message attachments.
# Doubles as the S3 access-key/secret the chat-gateway signs presigned URLs
# with. MinIO requires user ≥3 chars + password ≥8; both satisfied. Generated
# once and persisted, so existing buckets keep matching creds across restarts.
[ -f "${KEYS}/minio.user" ] || write_if_missing \
    "${KEYS}/minio.user" "pulse-$(python3 -c 'import secrets; print(secrets.token_hex(4))')"
[ -f "${KEYS}/minio.password" ] || write_if_missing \
    "${KEYS}/minio.password" "$(gen_hex)"

# Self-Host JWT signing keypair — Ed25519 for Self-Host session tokens
# (Phase 5 issues those for /cert-login; the key here is what chat-gateway
# uses to sign + voice-signaling/media-svc to verify).
if [ ! -f "${KEYS}/session-token-signing.pem" ]; then
    echo "[03-init-secrets] generating Ed25519 keypair (session-token-signing)"
    openssl genpkey -algorithm ED25519 -out "${KEYS}/session-token-signing.pem"
    openssl pkey -in "${KEYS}/session-token-signing.pem" -pubout \
        -out "${KEYS}/session-token-signing.pub.pem"
    chmod 0600 "${KEYS}/session-token-signing.pem"
    chmod 0644 "${KEYS}/session-token-signing.pub.pem"
    chown pulse:pulse "${KEYS}/session-token-signing.pem" "${KEYS}/session-token-signing.pub.pem"
fi

# RS256 JWT keypair — used by chat-gateway as the OIDC-style issuer for
# user tokens (mirrors prod auth-svc). Self-Host hosts both sides in one
# process so the same key is signer + verifier.
if [ ! -f "${KEYS}/jwt_private.pem" ]; then
    echo "[03-init-secrets] generating RS256 keypair (chat-gateway issuer)"
    openssl genrsa -out "${KEYS}/jwt_private.pem" 2048
    openssl rsa -in "${KEYS}/jwt_private.pem" -pubout -out "${KEYS}/jwt_public.pem"
    chmod 0600 "${KEYS}/jwt_private.pem"
    chmod 0644 "${KEYS}/jwt_public.pem"
    chown pulse:pulse "${KEYS}/jwt_private.pem" "${KEYS}/jwt_public.pem"
fi

echo "[03-init-secrets] secrets verified"
