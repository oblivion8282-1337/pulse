"""Web-Push notifications: VAPID key endpoint, subscribe/unsubscribe, fan-out.

Covers:
  * ``GET /notifications/vapid-public-key`` — 401 unauthed, 200 auth'd.
  * ``POST /notifications/subscribe`` — creates a row.
  * ``POST /notifications/subscribe`` upsert — second POST with the same
    endpoint updates the row, doesn't duplicate it.
  * ``DELETE /notifications/subscribe`` — removes the row.
  * ``GET /notifications/subscriptions`` — lists the caller's rows.
  * ``send_push_to_user`` is invoked on a mention with the documented
    payload shape (mocked sender, no real network).
  * Dead-endpoint cleanup: when pywebpush raises 410, the subscription
    row is dropped.
"""

from __future__ import annotations

import random
from types import SimpleNamespace

import pytest
from sqlalchemy import select


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _register(_auth_signer, uid: int | None = None) -> tuple[str, int]:
    uid = uid or random.randint(1, 1_000_000)
    return _auth_signer.issue_access(uid, f"u{uid}"), uid


def _sub_body(endpoint: str = "https://fcm.googleapis.com/abc/xyz") -> dict:
    return {
        "endpoint": endpoint,
        "keys": {
            "p256dh": "BL1234567890_fake_pubkey_base64url_padding_ok",
            "auth": "auth_secret_fake_value",
        },
        "user_agent": "Mozilla/5.0 (X11; Linux x86_64) Test",
    }


@pytest.fixture(autouse=True)
def _reset_vapid_cache():
    """Each test starts with a fresh in-memory VAPID cache so the
    auto-gen path is deterministic across the suite."""
    import dcc_chat_gateway.push as push_mod

    push_mod.reset_vapid_cache_for_tests()
    yield
    push_mod.reset_vapid_cache_for_tests()


# ---------------------------------------------------------------------------
# /vapid-public-key


@pytest.mark.asyncio
async def test_get_vapid_public_key_unauth_401(client):
    r = await client.get("/notifications/vapid-public-key")
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_get_vapid_public_key_returns_b64url(client, _auth_signer):
    token, _ = await _register(_auth_signer)
    r = await client.get(
        "/notifications/vapid-public-key", headers=_auth(token)
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert "public_key" in body
    key = body["public_key"]
    assert isinstance(key, str) and len(key) > 50
    # base64url: no padding, no slashes / pluses.
    assert "=" not in key and "/" not in key and "+" not in key


# ---------------------------------------------------------------------------
# operator-provided VAPID keys (env): raw PEM or base64-encoded PEM


@pytest.mark.parametrize("as_base64", [False, True])
def test_ensure_vapid_accepts_env_private_key(as_base64):
    """ensure_vapid trusts operator-provided env keys, accepting the private
    key as a raw PKCS#8 PEM *or* its base64 encoding (the env_file-safe
    single-line form — a multi-line PEM can't survive a Docker env_file).
    Both forms resolve to the identical PEM + public key."""
    import base64 as _b64

    from dcc_chat_gateway import vapid as vapid_mod
    from dcc_chat_gateway.config import Settings

    keys = vapid_mod._generate_keypair()
    provided = (
        _b64.b64encode(keys.private_pem.encode()).decode()
        if as_base64
        else keys.private_pem
    )
    vapid_mod.reset_vapid_cache_for_tests()
    s = Settings(
        vapid_private_key=provided, vapid_public_key=keys.public_b64url
    )
    resolved = vapid_mod.ensure_vapid(s)
    assert resolved is not None
    assert resolved.private_pem == keys.private_pem
    assert resolved.public_b64url == keys.public_b64url
    vapid_mod.reset_vapid_cache_for_tests()


def test_resolve_private_pem_rejects_garbage():
    """A value that is neither a PEM nor valid base64 must fail loudly at
    startup rather than silently falling through to a generated keypair."""
    from dcc_chat_gateway import vapid as vapid_mod

    with pytest.raises(ValueError):
        vapid_mod._resolve_private_pem("!!! neither pem nor base64 !!!")


# ---------------------------------------------------------------------------
# /subscribe + /subscriptions


@pytest.mark.asyncio
async def test_subscribe_creates_row(client, _auth_signer, session_factory):
    token, uid = await _register(_auth_signer)
    r = await client.post(
        "/notifications/subscribe", json=_sub_body(), headers=_auth(token)
    )
    assert r.status_code == 204, r.text
    # Row exists in DB with the user's id.
    from dcc_chat_gateway.models import WebPushSubscription

    async with session_factory() as session:
        rows = (
            await session.execute(
                select(WebPushSubscription).where(
                    WebPushSubscription.user_id == uid
                )
            )
        ).scalars().all()
    assert len(rows) == 1
    assert rows[0].endpoint == "https://fcm.googleapis.com/abc/xyz"
    assert rows[0].p256dh.startswith("BL")
    assert rows[0].auth_secret == "auth_secret_fake_value"


@pytest.mark.asyncio
async def test_subscribe_upserts_on_same_endpoint(
    client, _auth_signer, session_factory
):
    token, uid = await _register(_auth_signer)
    body1 = _sub_body()
    r = await client.post(
        "/notifications/subscribe", json=body1, headers=_auth(token)
    )
    assert r.status_code == 204
    # Re-subscribe with same endpoint but new keys → upsert, single row.
    body2 = _sub_body()
    body2["keys"]["p256dh"] = "BL_rotated_pubkey_v2"
    body2["keys"]["auth"] = "rotated_auth_v2"
    r = await client.post(
        "/notifications/subscribe", json=body2, headers=_auth(token)
    )
    assert r.status_code == 204
    from dcc_chat_gateway.models import WebPushSubscription

    async with session_factory() as session:
        rows = (
            await session.execute(
                select(WebPushSubscription).where(
                    WebPushSubscription.user_id == uid
                )
            )
        ).scalars().all()
    assert len(rows) == 1
    assert rows[0].p256dh == "BL_rotated_pubkey_v2"
    assert rows[0].auth_secret == "rotated_auth_v2"


@pytest.mark.asyncio
async def test_unsubscribe_removes_row(client, _auth_signer, session_factory):
    token, uid = await _register(_auth_signer)
    body = _sub_body()
    await client.post("/notifications/subscribe", json=body, headers=_auth(token))
    r = await client.request(
        "DELETE",
        "/notifications/subscribe",
        json={"endpoint": body["endpoint"]},
        headers=_auth(token),
    )
    assert r.status_code == 204
    from dcc_chat_gateway.models import WebPushSubscription

    async with session_factory() as session:
        rows = (
            await session.execute(
                select(WebPushSubscription).where(
                    WebPushSubscription.user_id == uid
                )
            )
        ).scalars().all()
    assert rows == []


@pytest.mark.asyncio
async def test_list_subscriptions(client, _auth_signer):
    token, _ = await _register(_auth_signer)
    await client.post(
        "/notifications/subscribe",
        json=_sub_body("https://fcm.googleapis.com/aaa"),
        headers=_auth(token),
    )
    await client.post(
        "/notifications/subscribe",
        json=_sub_body("https://test.push.services.mozilla.com/bbb"),
        headers=_auth(token),
    )
    r = await client.get("/notifications/subscriptions", headers=_auth(token))
    assert r.status_code == 200, r.text
    rows = r.json()
    assert len(rows) == 2
    eps = {row["endpoint"] for row in rows}
    assert eps == {
        "https://fcm.googleapis.com/aaa",
        "https://test.push.services.mozilla.com/bbb",
    }
    # p256dh / auth_secret are NOT exposed.
    for row in rows:
        assert "p256dh" not in row
        assert "auth_secret" not in row


@pytest.mark.asyncio
async def test_subscribe_rejects_non_https(client, _auth_signer):
    token, _ = await _register(_auth_signer)
    body = _sub_body("http://insecure.example.com/foo")
    r = await client.post(
        "/notifications/subscribe", json=body, headers=_auth(token)
    )
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# Mention → push fan-out (mocked sender)


async def _make_two_member_guild(client, _auth_signer):
    t_owner, uid_owner = await _register(_auth_signer)
    t_member, uid_member = await _register(_auth_signer)
    g = (
        await client.post("/guilds", json={"name": "g"}, headers=_auth(t_owner))
    ).json()
    await client.post(
        f"/guilds/{g['id']}/members",
        json={"user_id": str(uid_member)},
        headers=_auth(t_owner),
    )
    c = (
        await client.post(
            f"/guilds/{g['id']}/channels",
            json={"name": "general"},
            headers=_auth(t_owner),
        )
    ).json()
    return t_owner, uid_owner, t_member, uid_member, g["id"], c["id"]


@pytest.mark.asyncio
async def test_send_push_on_mention(client, _auth_signer, monkeypatch):
    """Posting a message that ``<@uid>`` mentions a subscribed user fires
    one ``_send_one`` call with the documented payload shape."""
    t_owner, _, t_member, uid_member, _, cid = await _make_two_member_guild(
        client, _auth_signer
    )
    # Bob subscribes for push.
    body = _sub_body("https://fcm.googleapis.com/bob-device-1")
    await client.post(
        "/notifications/subscribe", json=body, headers=_auth(t_member)
    )

    # Intercept the underlying sync sender (called via asyncio.to_thread)
    # so no real HTTP happens. Capture every call's kwargs for assertion.
    captured: list[dict] = []

    def _fake_send_one(**kwargs):
        captured.append(kwargs)
        return "ok"

    import dcc_chat_gateway.push as push_mod

    monkeypatch.setattr(push_mod, "_send_one", _fake_send_one)

    # Owner mentions Bob.
    r = await client.post(
        f"/channels/{cid}/messages",
        json={"content": f"hey <@{uid_member}> check this"},
        headers=_auth(t_owner),
    )
    assert r.status_code == 201, r.text
    msg_id = r.json()["id"]

    # Exactly one push attempt.
    assert len(captured) == 1, captured
    call = captured[0]
    assert call["endpoint"] == "https://fcm.googleapis.com/bob-device-1"
    assert call["p256dh"].startswith("BL")
    assert call["auth_secret"] == "auth_secret_fake_value"
    # Payload is the body JSON string — decode + check shape.
    import json as _json

    payload = _json.loads(call["body"])
    assert payload["type"] == "mention"
    assert payload["title"]  # owner's username
    assert payload["channel_id"] == str(cid)
    assert payload["message_id"] == msg_id
    assert payload["guild_id"] is not None  # guild channel
    assert payload["author_name"]
    assert "body" in payload
    assert payload["icon"] is None
    # All snowflakes serialised as strings (CLAUDE.md).
    assert isinstance(payload["channel_id"], str)
    assert isinstance(payload["message_id"], str)


@pytest.mark.asyncio
async def test_push_deletes_dead_subscription(
    client, _auth_signer, monkeypatch, session_factory
):
    """A 410 ``Gone`` from the push service drops the subscription row."""
    t_owner, _, t_member, uid_member, _, cid = await _make_two_member_guild(
        client, _auth_signer
    )
    body = _sub_body("https://fcm.googleapis.com/bob-dead-device")
    await client.post(
        "/notifications/subscribe", json=body, headers=_auth(t_member)
    )

    # Simulate the same path pywebpush takes: ``_send_one`` returns "dead"
    # for 404/410. Returning "dead" verbatim exercises the cleanup logic
    # without having to construct a real ``WebPushException``.
    def _fake_send_one(**kwargs):
        return "dead"

    import dcc_chat_gateway.push as push_mod

    monkeypatch.setattr(push_mod, "_send_one", _fake_send_one)

    r = await client.post(
        f"/channels/{cid}/messages",
        json={"content": f"yo <@{uid_member}>"},
        headers=_auth(t_owner),
    )
    assert r.status_code == 201, r.text

    # Subscription is gone.
    from dcc_chat_gateway.models import WebPushSubscription

    async with session_factory() as session:
        rows = (
            await session.execute(
                select(WebPushSubscription).where(
                    WebPushSubscription.user_id == uid_member
                )
            )
        ).scalars().all()
    assert rows == []


@pytest.mark.asyncio
async def test_push_dead_response_via_webpush_exception(monkeypatch):
    """Cover the WebPushException(410) branch of ``_send_one``.

    The mention-route test exercises the outer cleanup path; this
    one ensures the inner status-code → ``"dead"`` mapping is correct
    regardless of which pywebpush version is installed."""
    import dcc_chat_gateway.push as push_mod

    class _FakeResp:
        status_code = 410

    class _FakeException(Exception):
        def __init__(self):
            self.response = _FakeResp()

    def _fake_webpush(**kwargs):
        raise _FakeException()

    # pywebpush is imported lazily inside _send_one — install a stub
    # module that ``from pywebpush import ...`` picks up.
    fake_pywebpush = SimpleNamespace(
        webpush=_fake_webpush, WebPushException=_FakeException
    )
    monkeypatch.setitem(__import__("sys").modules, "pywebpush", fake_pywebpush)
    result = push_mod._send_one(
        endpoint="https://fcm.googleapis.com/foo",
        p256dh="x",
        auth_secret="y",
        body="{}",
        vapid_pem="pem",
        vapid_claims={"sub": "mailto:a@b"},
    )
    assert result == "dead"


@pytest.mark.asyncio
async def test_no_push_for_self_mention(client, _auth_signer, monkeypatch):
    """Author mentioning themselves doesn't fire a push (mirrors the
    in-window ``mention_added`` self-ping rule)."""
    t_owner, uid_owner, _, _, _, cid = await _make_two_member_guild(
        client, _auth_signer
    )
    body = _sub_body("https://fcm.googleapis.com/owner-device")
    await client.post(
        "/notifications/subscribe", json=body, headers=_auth(t_owner)
    )
    captured: list[dict] = []
    import dcc_chat_gateway.push as push_mod

    monkeypatch.setattr(
        push_mod, "_send_one", lambda **k: captured.append(k) or "ok"
    )
    r = await client.post(
        f"/channels/{cid}/messages",
        json={"content": f"self <@{uid_owner}>"},
        headers=_auth(t_owner),
    )
    assert r.status_code == 201
    assert captured == []
