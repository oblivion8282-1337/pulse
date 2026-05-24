"""Listener-side strict validation for inbound Redis pub/sub events
(Plugin-System Schritt 1b).

Schritt 1 baute die Event-Schema-Registry (`dcc_shared.events.EVENT_REGISTRY`)
und migrierte die **Publisher** auf die Pydantic-Modelle. Diese Datei
schließt die andere Seite: jeder eingehende Event aus Redis wird gegen
die Registry validiert, bevor der Channel-Handler ihn fan-outet.

Drei Modi via Env-Var ``PULSE_EVENT_VALIDATION``:

* ``strict`` (Default) — invalid event wird verworfen + geloggt (ERROR).
* ``warn`` — invalid event wird verarbeitet, aber ein WARNING wird geloggt
  (Migrationspfad: Schema-Drift sichtbar machen, ohne sofort zu droppen).
* ``off`` — Validation komplett aus (Performance-kritische Setups).

Sonder-Behandlung:

* **Plugin-Ops** (Op-Code enthält ``:``, z.B. ``tamagotchi:ack``) bypassen
  die Validation. Plugins dürfen eigene Ops registrieren ohne in der
  Core-Registry zu stehen — sonst wären sie nicht "drittentwickler-tauglich".
* **Bare Snapshots** (keine ``op``-Feld in payload, z.B. ``voice:events``
  / ``stream:events`` / ``watch:events`` Snapshot-Form) — der Caller
  ruft ``validate_event`` für solche payloads nicht auf; die Snapshots
  sind nicht im ``EVENT_REGISTRY`` (sie tragen keinen Discriminator).
* **Unknown Ops** (Op-Code ist in Core, aber nicht im Registry) — werden
  durchgelassen aber mit einer Warning geloggt. Schützt vor versehentlichem
  Block durch out-of-date Registry; ein echtes Drift-Symptom kommt als Log raus.
"""

from __future__ import annotations

import logging
import os

from dcc_shared.events import EVENT_REGISTRY
from pydantic import ValidationError

log = logging.getLogger(__name__)

_MODES = frozenset({"strict", "warn", "off"})
_DEFAULT_MODE = "strict"


def resolve_validation_mode() -> str:
    """Read ``PULSE_EVENT_VALIDATION`` from the environment.

    Unknown / unset values fall back to ``strict`` so production gets the
    safest default. Case-insensitive (``Strict`` / ``STRICT`` work).
    """
    val = os.environ.get("PULSE_EVENT_VALIDATION", _DEFAULT_MODE).strip().lower()
    return val if val in _MODES else _DEFAULT_MODE


def validate_event(op: str, payload: dict) -> tuple[bool, str | None]:
    """Validate an inbound event payload against ``EVENT_REGISTRY``.

    Returns ``(is_valid, error_message)``:

    * ``(True, None)`` — payload validated cleanly, or validation is off,
      or the op is a plugin namespace (contains ``:``).
    * ``(True, <msg>)`` — payload accepted, but the op is unknown to the
      core registry. The caller may log this as a warning; it's an early
      signal of registry drift but not a fatal error.
    * ``(False, <msg>)`` — payload failed validation in strict mode. The
      caller decides whether to drop (strict) or proceed (warn).

    Plugin-Op-Bypass: any op containing ``:`` is treated as plugin-owned
    and skipped — they're free to register channel handlers + emit events
    that the core schema doesn't know about (the whole point of the
    plugin system).
    """
    mode = resolve_validation_mode()
    if mode == "off":
        return True, None
    # Plugin ops use the ``namespace:action`` convention (enforced by the
    # ws-op-registry's "must contain a colon" check on the publisher side).
    # The validation registry only covers core ops, so any colon-namespaced
    # op is by definition out of scope here.
    if ":" in op:
        return True, None
    model = EVENT_REGISTRY.get(op)
    if model is None:
        # Op is neither a plugin op nor in the registry. This is most
        # likely a stale-deployment case (publisher emits a new op that
        # the listener hasn't been redeployed for). Accept but flag.
        return True, f"unknown op (not in EVENT_REGISTRY): {op}"
    try:
        model.model_validate(payload)
        return True, None
    except ValidationError as exc:
        return False, str(exc)


def maybe_drop(op: str, payload: dict, channel_label: str) -> bool:
    """Validate + decide whether to drop the event.

    Returns ``True`` if the caller should DROP the event (strict mode +
    validation failed). Returns ``False`` if processing should continue
    (validation passed, or in warn/off mode, or unknown-op-accepted path).

    Logs:
      * ERROR on a dropped event (strict mode).
      * WARNING on a kept-but-invalid event (warn mode).
      * WARNING on an unknown-op (any mode).

    The split helper exists so the channel handlers stay readable —
    one call per dispatch, three lines instead of seven each.
    """
    mode = resolve_validation_mode()
    is_valid, err = validate_event(op, payload)
    if is_valid:
        if err is not None:
            # unknown-op-but-accepted path (any mode that runs at all).
            log.warning(
                "event %s on %s accepted with note: %s", op, channel_label, err
            )
        return False
    # is_valid == False can only happen in strict / warn modes
    # (off short-circuits to True up in validate_event).
    if mode == "strict":
        log.error(
            "dropping invalid %s event on %s: %s",
            op, channel_label, err,
        )
        return True
    # warn-mode: keep processing, but make the drift loud in the logs.
    log.warning(
        "invalid %s event on %s (proceeding anyway, mode=warn): %s",
        op, channel_label, err,
    )
    return False
