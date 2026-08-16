"""Die Rollen im ``ready``-Frame tragen dieselbe Drahtform wie die
Rollen-Routen — insbesondere ``guild_id``.

Der Frame baute die Form bis 2026-08-16 von Hand nach und liess ``guild_id``
weg, obwohl der Frontend-Typ es als Pflichtfeld fuehrt: die Rollen-Zuordnung
im Client (``memberRoles.for(rolle.guild_id, …)``) lief damit immer leer, eine
Rollen-Erwaehnung leuchtete nie als eigene auf.
"""

from __future__ import annotations

import asyncio
import random

import pytest
from starlette.testclient import TestClient

from .conftest import receive_skipping

_FELDER = {
    "id",
    "guild_id",
    "name",
    "permissions",
    "color",
    "position",
    "hoist",
    "mentionable",
    "is_everyone",
}


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.asyncio
async def test_ready_rollen_tragen_guild_id(ws_app, _auth_signer):
    def _run():
        with TestClient(ws_app) as tc:
            uid = random.randint(1, 1_000_000)
            tok = _auth_signer.issue_access(uid, f"u{uid}")
            g = tc.post("/guilds", json={"name": "g"}, headers=_auth(tok)).json()
            rolle = tc.post(
                f"/guilds/{g['id']}/roles",
                json={"name": "Mods", "permissions": "0", "color": 0xFF8800},
                headers=_auth(tok),
            ).json()

            with tc.websocket_connect(f"/ws?token={tok}") as ws:
                ready = receive_skipping(ws)
            assert ready["op"] == "ready"
            eintrag = next(x for x in ready["guilds"] if x["id"] == g["id"])
            rollen = eintrag["roles"]
            # @everyone + die angelegte Rolle, beide vollstaendig.
            assert len(rollen) == 2
            for row in rollen:
                assert set(row) == _FELDER
                assert row["guild_id"] == g["id"]
            meine = next(x for x in rollen if x["id"] == rolle["id"])
            assert meine["name"] == "Mods"
            assert meine["color"] == 0xFF8800
            # Bitfelder als String — JS-Number traegt 64 Bit nicht exakt.
            assert isinstance(meine["permissions"], str)

    await asyncio.to_thread(_run)
