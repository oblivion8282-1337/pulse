"""Die zwei Ebenen pro Limit — Obergrenze des Betreibers, Wert der Community.

    Betreiber-Obergrenze   ──klemmt──▶   Wert der Community   ──▶  wirksam

Warum überhaupt zwei Ebenen: die Obergrenze ist wertlos, wenn die Ebene
darunter sie überschreiben kann. Genau das war bei
``attachment_max_size_bytes`` der Fall — ``GuildPatchIn`` (MANAGE_GUILD) und
der Owner-Endpoint schrieben dieselbe Spalte, wer zuletzt speicherte, gewann.

Warum alle Paarungen HIER und nicht je Route: sonst entscheidet jede
Aufrufstelle für sich, in welche Richtung geklemmt wird, und die eine, die es
vergisst, ist das Loch. ``LIMITS`` ist die einzige Stelle, an der ein neues
Limit eingetragen wird; Klemmen, wirksamer Wert und die Formularfelder für die
Community-Einstellungen leiten sich daraus ab.

NULL heißt auf beiden Ebenen „nicht gesetzt": oben der Instanz-Standard, unten
„nimm die Obergrenze".
"""

from __future__ import annotations

from dataclasses import dataclass

from dcc_chat_gateway.models import Guild

# Instanz-Standards für die zwei Limits, deren Obergrenze aus keinem
# ``chat_settings``-Feld kommt. Die Werte spiegeln die Spalten-Defaults, die
# ``guilds`` seit jeher trägt — ohne sie hätte "Obergrenze nicht gesetzt" auf
# diesen beiden Feldern keine Zahl, gegen die geklemmt werden könnte.
DEFAULT_ATTACHMENT_MAX_SIZE_BYTES = 26214400  # 25 MiB
DEFAULT_ATTACHMENT_MAX_COUNT = 4


@dataclass(frozen=True)
class LimitSpec:
    """Ein Limit über beide Ebenen.

    ``ceiling_attr``/``value_attr`` sind Spalten auf ``Guild``.
    ``instance_default`` greift, wenn die Obergrenze NULL ist; None bedeutet
    „unbegrenzt", dann kann nichts geklemmt werden.
    """

    key: str
    ceiling_attr: str
    value_attr: str
    instance_default: int | None = None
    #: Auflösungen sind eine Leiter, keine Zahl — sie werden über den Index in
    #: ``RESOLUTION_LADDER`` verglichen (kleiner Index = höhere Auflösung).
    is_resolution: bool = False


#: Von hoch nach niedrig. 'Native' = ungedeckelt und deshalb ganz oben.
RESOLUTION_LADDER = ["Native", "4K", "1440p", "1080p", "720p", "480p"]


LIMITS: tuple[LimitSpec, ...] = (
    LimitSpec("voice_bitrate_kbps", "voice_bitrate_max_kbps", "community_voice_bitrate_kbps"),
    LimitSpec(
        "stream_bitrate_kbps", "stream_bitrate_max_kbps", "community_stream_bitrate_kbps"
    ),
    LimitSpec("stream_fps", "stream_fps_max", "community_stream_fps"),
    LimitSpec(
        "stream_resolution",
        "stream_resolution_max",
        "community_stream_resolution",
        is_resolution=True,
    ),
    LimitSpec("max_members", "max_members", "community_max_members"),
    LimitSpec("max_channels", "max_channels", "community_max_channels"),
    LimitSpec("max_roles", "max_roles", "community_max_roles"),
    LimitSpec(
        "max_concurrent_streams",
        "max_concurrent_streams",
        "community_max_concurrent_streams",
    ),
    LimitSpec(
        "attachment_storage_quota_bytes",
        "attachment_storage_quota_bytes",
        "community_attachment_storage_quota_bytes",
    ),
    # Umgekehrte Paarung: hier ist die alte Spalte der Wert, die Obergrenze
    # kam mit 0057 dazu.
    LimitSpec(
        "attachment_max_size_bytes",
        "attachment_max_size_ceiling_bytes",
        "attachment_max_size_bytes",
        instance_default=DEFAULT_ATTACHMENT_MAX_SIZE_BYTES,
    ),
    LimitSpec(
        "attachment_max_count_per_message",
        "attachment_max_count_ceiling",
        "attachment_max_count_per_message",
        instance_default=DEFAULT_ATTACHMENT_MAX_COUNT,
    ),
)

LIMITS_BY_KEY = {spec.key: spec for spec in LIMITS}


def ceiling_of(guild: Guild, spec: LimitSpec) -> int | str | None:
    """Die Obergrenze des Betreibers, oder None für „unbegrenzt".

    Bewusst auf ``is None`` geprüft und nicht mit ``or``: eine Obergrenze von 0
    (etwa „gar keine gleichzeitigen Streams") ist eine echte Vorgabe und darf
    nicht als „nicht gesetzt" durchfallen."""
    ceiling = getattr(guild, spec.ceiling_attr)
    return spec.instance_default if ceiling is None else ceiling


def effective(guild: Guild, spec: LimitSpec) -> int | str | None:
    """Der wirksame Wert: was die Community gewählt hat, sonst die Obergrenze.

    Ohne zusätzliches ``min()`` — die Werte werden beim Schreiben geklemmt
    (``clamp_to_ceilings``), damit die Leseseite (Durchsetzung, Wire-Format)
    nicht bei jedem Zugriff dieselbe Rechnung wiederholen muss."""
    value = getattr(guild, spec.value_attr)
    return ceiling_of(guild, spec) if value is None else value


def _exceeds(value: int | str, ceiling: int | str, spec: LimitSpec) -> bool:
    if spec.is_resolution:
        # Nicht in der Leiter (Altwert, Tippfehler) → als zu hoch behandeln und
        # auf die Obergrenze zurückholen, statt still durchzulassen.
        try:
            value_rank = RESOLUTION_LADDER.index(str(value))
        except ValueError:
            return True
        try:
            ceiling_rank = RESOLUTION_LADDER.index(str(ceiling))
        except ValueError:
            return False
        return value_rank < ceiling_rank  # kleinerer Index = höhere Auflösung
    return int(value) > int(ceiling)


#: Wire-Feldname → Limit-Schlüssel. Die Namen tragen historisch ``_max_``; was
#: darin steht, ist seit 0057 der wirksame Wert, nicht die Obergrenze.
WIRE_LIMIT_FIELDS = {
    "voice_bitrate_max_kbps": "voice_bitrate_kbps",
    "stream_bitrate_max_kbps": "stream_bitrate_kbps",
    "stream_fps_max": "stream_fps",
    "stream_resolution_max": "stream_resolution",
}


def effective_wire_limits(guild: Guild) -> dict[str, int | str | None]:
    """Die wirksamen Qualitätsgrenzen unter ihren Wire-Namen — für den
    ``guild_updated``-Umschlag und den ready-Frame."""
    return {
        field: effective(guild, LIMITS_BY_KEY[key])
        for field, key in WIRE_LIMIT_FIELDS.items()
    }


def clamp_to_ceilings(guild: Guild) -> list[str]:
    """Jeden Wert der Community auf die Obergrenze zurückholen.

    Aufzurufen nach JEDEM Schreiben auf einer der beiden Ebenen — nach dem
    Speichern durch die Community (sie könnte zu hoch gegriffen haben) und nach
    dem Senken einer Obergrenze durch den Betreiber (sonst würde die Senkung
    nur für Communities gelten, die danach noch einmal speichern).

    Gibt die Schlüssel der geklemmten Limits zurück, damit die Oberfläche sagen
    kann, was angepasst wurde."""
    clamped: list[str] = []
    for spec in LIMITS:
        value = getattr(guild, spec.value_attr)
        if value is None:
            continue
        ceiling = ceiling_of(guild, spec)
        if ceiling is None:
            continue  # unbegrenzt — nichts, wogegen geklemmt werden könnte
        if _exceeds(value, ceiling, spec):
            setattr(guild, spec.value_attr, ceiling)
            clamped.append(spec.key)
    return clamped
