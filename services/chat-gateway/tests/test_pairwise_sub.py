"""Tests for compute_pairwise_sub (DE 11 A.4).

Coverage:
1. Deterministic: same inputs → same sub
2. Different instance_ids → different subs
3. Different user_ids → different subs
4. Different pairwise_seeds → different subs
"""

from __future__ import annotations

import base64

import pytest

from dcc_chat_gateway.credential_validator import compute_pairwise_sub


def _seed(value: bytes = b"\xab" * 32) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


def test_deterministic():
    """Same inputs always produce the same sub."""
    seed = _seed()
    a = compute_pairwise_sub("100", 42, seed)
    b = compute_pairwise_sub("100", 42, seed)
    assert a == b
    assert len(a) == 16


def test_different_instance_ids():
    """Same user + same seed, different instance → different sub."""
    seed = _seed()
    sub_a = compute_pairwise_sub("100", 1, seed)
    sub_b = compute_pairwise_sub("100", 2, seed)
    assert sub_a != sub_b


def test_different_user_ids():
    """Same instance + same seed, different user → different sub."""
    seed = _seed()
    sub_alice = compute_pairwise_sub("100", 1, seed)
    sub_bob = compute_pairwise_sub("200", 1, seed)
    assert sub_alice != sub_bob


def test_different_seeds():
    """Same user + same instance, different seed → different sub."""
    seed_a = _seed(b"\xab" * 32)
    seed_b = _seed(b"\xcd" * 32)
    sub_a = compute_pairwise_sub("100", 1, seed_a)
    sub_b = compute_pairwise_sub("100", 1, seed_b)
    assert sub_a != sub_b


def test_output_length():
    """Output is always 16 characters."""
    seed = _seed()
    for uid in ["1", "999999999999999", "42"]:
        for iid in [0, 1, 1023]:
            result = compute_pairwise_sub(uid, iid, seed)
            assert len(result) == 16, f"bad length for uid={uid}, iid={iid}: {result!r}"
