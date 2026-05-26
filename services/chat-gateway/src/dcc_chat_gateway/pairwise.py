"""Pairwise-Sub helper for Self-Host mode (DE 11 A.4).

Thin re-export wrapper so callers that only need the pairwise identifier
don't have to import from ``credential_validator`` (which pulls in the
heavy JWT / cryptography stack).

The actual implementation lives in
:func:`dcc_chat_gateway.credential_validator.compute_pairwise_sub`.
"""

from __future__ import annotations

from dcc_chat_gateway.credential_validator import compute_pairwise_sub

__all__ = ["compute_pairwise_sub"]
