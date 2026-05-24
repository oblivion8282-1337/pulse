"""Base class for every event-schema model.

All Pub/Sub envelope models inherit ``_EventBase`` so they share:

* ``extra="forbid"`` — drift is loud: an unexpected field on a publisher
  fails validation in tests instead of silently riding along.
* ``frozen=True`` — events are pure data. A mutation after construction
  would mean two callers see different payloads of the "same" event.
* ``populate_by_name=True`` — the listener may pass either bytes/JSON or
  already-parsed dicts; models accept both freely.

Snowflake IDs travel as strings on the wire (Discord-clone convention —
JS ``Number`` can't hold the full 64-bit range losslessly). Field types in
subclasses use ``str`` accordingly; no shared validator needed since the
wire format is already a string.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class _EventBase(BaseModel):
    """Common config for every Redis-pub/sub event envelope.

    Subclasses add their own ``op: Literal["..."] = "..."`` discriminator
    field (when the wire envelope carries one). Bare-snapshot payloads
    that the listener wraps server-side don't need an ``op`` — the
    listener provides it when constructing the outbound WS envelope.
    """

    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        populate_by_name=True,
    )
