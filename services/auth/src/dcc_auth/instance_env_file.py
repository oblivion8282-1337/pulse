"""Rendering der fertigen ``.env`` für den allinone-Self-Host-Container.

Eigenes Modul, damit die Vorlage als zusammenhängender Text lesbar bleibt
(und ``routes_instance_applications.py`` unter der Größen-Policy) — was der
Self-Hoster herunterlädt, steht hier wörtlich.

Die Var-Namen MÜSSEN exakt die sein, die der Container liest
(``10-check-cloud-creds.sh`` / ``07-render-env.sh``): ``PULSE_CLOUD_CLIENT_*``
(nicht ``PULSE_INSTANCE_CLIENT_*``) plus ``PULSE_INSTANCE_OWNER_ID``,
``PULSE_HOSTNAME`` und ``PULSE_ADMIN_EMAIL``. Worker-IDs tauchen NICHT auf
(der Single-Container nutzt feste interne IDs).
"""

from __future__ import annotations

from dcc_auth.models_instances import RegisteredInstance


def render_instance_env(
    inst: RegisteredInstance,
    *,
    client_secret: str,
    admin_email: str,
    cloud_origin: str,
) -> str:
    """Baut den Datei-Inhalt. ``client_secret`` ist Klartext — NIE loggen."""
    return f"""\
# Pulse Self-Host — Instance {inst.id}
# Hostname: {inst.hostname}
#
# Fertige .env für den allinone-Container — alle Werte sind gesetzt.
# Das client_secret unten ist FRISCH erzeugt. Es laesst sich in der App
# neu ausstellen, falls diese Datei verloren geht — dabei wird dieses
# hier ungueltig und ein damit laufender Server verliert den Zugang.
# Bewahr die Datei sicher auf.
# Start: docker compose up -d   (docker-compose.yml + diese .env)

PULSE_HOSTNAME={inst.hostname}
PULSE_INSTANCE_ID={inst.id}
PULSE_INSTANCE_OWNER_ID={inst.registered_by}
PULSE_INSTANCE_MODE=self-host
PULSE_CLOUD_ORIGIN={cloud_origin}

# Cloud-Pairing-Credentials (frisch erzeugt):
PULSE_CLOUD_CLIENT_ID={inst.client_id}
PULSE_CLOUD_CLIENT_SECRET={client_secret}

PULSE_ADMIN_EMAIL={admin_email}
"""
