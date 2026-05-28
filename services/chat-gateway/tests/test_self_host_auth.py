"""Self-Host bearer-token acceptance through the existing auth dispatcher.

After ``/cert-login/verify`` mints an EdDSA session-JWT, every subsequent
REST/WS call presents that token as a Bearer header. ``security.decode_token``
must route it through the local Ed25519 validator (``session_tokens.
validate_session_token``) instead of the Cloud JWKS path — that wiring is
what these tests exercise.

Token-confusion is the security-critical edge: a Cloud Access-JWT (RS256 +
``kid``) must NEVER reach the Self-Host validator and a Self-Host session-
JWT (EdDSA, no ``kid``) must NEVER reach the Cloud validator. The dispatch
is structural (``kid`` header presence) so the two paths are crypto-isolated.
"""

from __future__ import annotations

import pytest
from dcc_chat_gateway.security import (
    AuthenticatedUser,
    decode_token,
    synthesize_self_host_user_id,
)
from dcc_chat_gateway.session_tokens import (
    issue_session_token,
    reset_session_signer,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def self_host_settings(_isolate_chat_settings, tmp_path):
    """Switch the test ``Settings`` snapshot into self-host mode for one test.

    The conftest fixture pins ``pulse_instance_mode`` via a function-scoped
    settings provider; we mutate the live instance and reset the session
    signer so each test gets a fresh ephemeral key (no cross-test bleed).
    """
    reset_session_signer()
    _isolate_chat_settings.pulse_instance_mode = "self-host"
    _isolate_chat_settings.session_signing_key_file = str(
        tmp_path / "session_signing.pem"
    )
    yield _isolate_chat_settings
    reset_session_signer()


# ---------------------------------------------------------------------------
# Pure decode_token unit tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_self_host_session_token_decodes_in_self_host_mode(
    self_host_settings,
):
    """Self-Host session-JWT → valid payload with synthetic numeric sub."""
    token = issue_session_token(
        "pairwise-abc-1234",
        "cert-id-xyz",
        key_path=self_host_settings.session_signing_key_file,
    )
    payload = await decode_token(token)
    assert payload["self_host"] is True
    assert payload["pairwise_sub"] == "pairwise-abc-1234"
    # ``sub`` is the synthetic 63-bit int as decimal string, not the raw
    # pairwise-sub — keeps downstream ``int(payload['sub'])`` callers happy.
    assert int(payload["sub"]) == synthesize_self_host_user_id("pairwise-abc-1234")
    # ``typ`` is normalised to ``access`` so existing assertions in
    # downstream code keep working.
    assert payload["typ"] == "access"


@pytest.mark.asyncio
async def test_self_host_token_rejected_in_cloud_mode(self_host_settings):
    """Cloud-mode deployment must reject Self-Host tokens (token confusion guard)."""
    token = issue_session_token(
        "pairwise-evil",
        "cert-x",
        key_path=self_host_settings.session_signing_key_file,
    )
    # Flip the live settings into cloud mode — the token itself is still a
    # valid EdDSA session-JWT, but a Cloud-mode dispatcher must refuse it.
    self_host_settings.pulse_instance_mode = "cloud"
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as ei:
        await decode_token(token)
    assert ei.value.status_code == 401


@pytest.mark.asyncio
async def test_get_current_user_yields_self_host_authuser(self_host_settings):
    """``get_current_user`` returns an ``AuthenticatedUser`` flagged self-host
    with the pairwise-sub stored on ``user_identifier`` and a non-zero numeric
    ``id`` deterministically derived from it."""
    from dcc_chat_gateway.security import get_current_user

    token = issue_session_token(
        "pairwise-sub-xyz",
        "cert-id-1",
        key_path=self_host_settings.session_signing_key_file,
    )
    user: AuthenticatedUser = await get_current_user(f"Bearer {token}")
    assert user.is_self_host is True
    assert user.user_identifier == "pairwise-sub-xyz"
    assert user.id == synthesize_self_host_user_id("pairwise-sub-xyz")
    assert user.id > 0  # fits BIGINT signed-positive
    # Same pairwise-sub → same synthetic id (determinism contract).
    again = await get_current_user(f"Bearer {token}")
    assert again.id == user.id


@pytest.mark.asyncio
async def test_cloud_token_still_works_in_self_host_mode(
    self_host_settings, _auth_signer
):
    """A Cloud Access-JWT presented to a Self-Host deployment must still
    decode via the Cloud-RS256 path (the dispatcher keys off ``kid`` header
    presence, not off ``instance_mode``).  Self-Host deployments may
    legitimately mix locally-issued session-JWTs with Cloud tokens during
    migration windows."""
    cloud_token = _auth_signer.issue_access(12345, "alice")
    payload = await decode_token(cloud_token)
    assert payload["sub"] == "12345"
    assert payload["typ"] == "access"
    assert payload.get("self_host") is not True


# ---------------------------------------------------------------------------
# Determinism + collision-resistance of the synthetic id
# ---------------------------------------------------------------------------


def test_synthesize_self_host_user_id_is_deterministic():
    a = synthesize_self_host_user_id("foo")
    b = synthesize_self_host_user_id("foo")
    assert a == b


def test_synthesize_self_host_user_id_differs_per_input():
    a = synthesize_self_host_user_id("alice")
    b = synthesize_self_host_user_id("bob")
    assert a != b


def test_synthesize_self_host_user_id_positive_63bit():
    """Must fit in a signed BIGINT column."""
    val = synthesize_self_host_user_id("any-string-here")
    assert 0 < val < 2**63


# ---------------------------------------------------------------------------
# End-to-end: a self-host session token gates a real REST route
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_self_host_token_authenticates_capabilities_route(
    client, self_host_settings
):
    """The dispatcher patch is enough to make a Self-Host session-JWT
    pass authentication on a vanilla ``CurrentUser``-gated route. We pick
    ``/capabilities`` because it doesn't need any DB seeding (no membership
    / guild lookup) so this test isolates the auth pathway."""
    token = issue_session_token(
        "pairwise-route-test",
        "cert-route-test",
        key_path=self_host_settings.session_signing_key_file,
    )
    resp = await client.get(
        "/capabilities", headers={"Authorization": f"Bearer {token}"}
    )
    assert resp.status_code == 200, resp.text


@pytest.mark.asyncio
async def test_self_host_token_can_create_guild(client, self_host_settings):
    """``POST /guilds`` is the canonical Self-Host smoke-test from the task
    brief — must return 201 with a self-host session-JWT instead of 401."""
    token = issue_session_token(
        "pairwise-guild-test",
        "cert-guild-test",
        key_path=self_host_settings.session_signing_key_file,
    )
    resp = await client.post(
        "/guilds",
        json={"name": "Self-Host Smoke"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["name"] == "Self-Host Smoke"
    # Owner id is the synthetic 63-bit numeric mapping of the pairwise-sub.
    assert int(body["owner_id"]) == synthesize_self_host_user_id(
        "pairwise-guild-test"
    )
