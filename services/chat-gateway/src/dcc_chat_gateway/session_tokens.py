"""Self-Host-local session tokens (DE 9) — chat-gateway view.

The *validation* + key-management + identity-synthesis primitives moved to
:mod:`dcc_shared.session_tokens` so voice-signaling (and any future service)
can accept Self-Host session-JWTs without duplicating the EdDSA path. This
module re-exports them for backward compatibility (existing imports such as
``from dcc_chat_gateway.session_tokens import validate_session_token`` keep
working unchanged) and adds the one piece that is chat-gateway-specific:

chat-gateway is the only service that *mints* tokens (after a successful
Cert-Auth handshake); ``issue_session_token`` is re-exported from the shared
module, which holds the signing key so mint + validate share one key cache.

Session metadata is also stored in Redis (``auth:session_tokens:<token_hash>``)
with a matching 5-minute TTL so other services could validate tokens via Redis
lookup instead of signature verification — though both chat-gateway and
voice-signaling now verify the EdDSA signature directly via the shared module.
"""

from __future__ import annotations

import json
from typing import Any

# Re-export the shared primitives so callers that import from this module keep
# working. Behaviour is identical — this is a pure move, not a rewrite.
from dcc_shared.session_tokens import (
    REDIS_SESSION_PREFIX,
    SESSION_TTL_SECONDS,
    SessionClaims,
    _token_redis_key,
    issue_session_token,
    reset_session_signer,
    validate_session_token,
)

__all__ = [
    "REDIS_SESSION_PREFIX",
    "SESSION_TTL_SECONDS",
    "SessionClaims",
    "issue_session_token",
    "reset_session_signer",
    "validate_session_token",
]


