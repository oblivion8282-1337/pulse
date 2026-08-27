"""Die Sätze zum Betreiber-Glied der Erreichbarkeitsprüfung.

Eigenes Modul, weil ``diagnose_texte.py`` mit 348 Zeilen an der weichen Grenze
der Größen-Policy steht (PLAN.md §12.1). Es mischt die drei Tabellen hier in
seine eigenen — **die einzige Quelle für Diagnose-Texte bleibt damit
``diagnose_texte``**, hier liegt nur ein Teil davon.

Der Adressat ist derselbe wie dort: jemand, der gerade nicht weiterkommt und
einen Handgriff braucht, keine Zustandsbeschreibung. ``was_tun`` ist deshalb
auch hier Pflicht.
"""

from __future__ import annotations

#: (de, en)
TITEL: tuple[str, str] = ("Betreiber-Erkennung", "Owner recognition")

GELUNGEN: tuple[str, str] = (
    "Der Server erkennt dich als seinen Betreiber.",
    "The server recognises you as its owner.",
)

#: ``(schritt, befund) -> ((was_ist_de, was_tun_de), (was_ist_en, was_tun_en))``
BEFUNDE: dict[tuple[str, str], tuple[tuple[str, str], tuple[str, str]]] = {
    ("betreiber", "andere_kennung"): (
        (
            "Dieser Server ist auf ein anderes Konto als Betreiber eingestellt — nicht auf deines. "
            "Deshalb bist du dort ein gewöhnliches Mitglied: Du kannst keine Community anlegen und "
            "die Server-Einstellungen nicht öffnen, obwohl der Server dir gehört. Am häufigsten "
            "passiert das, wenn die Konfigurationsdatei eines früheren Servers weiterverwendet wurde.",
            "Trage auf der Maschine in /etc/pulse/pulse.env bei PULSE_INSTANCE_OWNER_ID die Kennung "
            "ein, die dir in „Meine Instanzen“ angezeigt wird, und starte den Server neu: "
            "sudo docker restart {container}. Danach in der App einmal neu laden.",
        ),
        (
            "This server is configured with a different account as its owner — not yours. That makes "
            "you an ordinary member there: you cannot create a community or open the server settings, "
            "even though the server is yours. The most common cause is a configuration file carried "
            "over from an earlier server.",
            "On the machine, set PULSE_INSTANCE_OWNER_ID in /etc/pulse/pulse.env to the identifier "
            "shown to you under \"My instances\", then restart the server: "
            "sudo docker restart {container}. Afterwards reload the app once.",
        ),
    ),
    ("betreiber", "nicht_konfiguriert"): (
        (
            "Dieser Server weiss gar nicht, wem er gehört. Damit kann ihn niemand verwalten — auch du "
            "nicht.",
            "Trage auf der Maschine in /etc/pulse/pulse.env bei PULSE_INSTANCE_OWNER_ID die Kennung "
            "ein, die dir in „Meine Instanzen“ angezeigt wird, und starte den Server neu: "
            "sudo docker restart {container}.",
        ),
        (
            "This server does not know who it belongs to. Nobody can administer it that way — not "
            "even you.",
            "On the machine, set PULSE_INSTANCE_OWNER_ID in /etc/pulse/pulse.env to the identifier "
            "shown to you under \"My instances\", then restart the server: "
            "sudo docker restart {container}.",
        ),
    ),
    ("betreiber", "kein_self_host"): (
        (
            "Dieser Server läuft nicht in der Betriebsart für eigene Server. In dieser Einstellung "
            "wird niemand zum Verwalter ernannt, auch nicht mit der richtigen Kennung.",
            "Setze auf der Maschine in /etc/pulse/pulse.env PULSE_INSTANCE_MODE=self-host und starte "
            "den Server neu: sudo docker restart {container}.",
        ),
        (
            "This server is not running in the mode meant for your own servers. In that setting nobody "
            "is made an administrator, not even with the correct identifier.",
            "On the machine, set PULSE_INSTANCE_MODE=self-host in /etc/pulse/pulse.env and restart the "
            "server: sudo docker restart {container}.",
        ),
    ),
    ("betreiber", "signatur_abgelehnt"): (
        (
            "Der Server hat die Anfrage abgewiesen, weil er sie nicht als von howispulse.com kommend "
            "bestätigen konnte. Fast immer heisst das: Er hat die Cloud selbst noch nie erreicht — "
            "dann funktioniert auch die Anmeldung über dein Konto dort nicht.",
            "Prüfe, ob der Server ins Internet hinaus darf: docker exec {container} pulse-doctor, "
            "Abschnitt „Verbindung zur Cloud“. Ein ausgehender Sperrfilter oder ein Proxy-Zwang ist "
            "die übliche Ursache.",
        ),
        (
            "The server rejected the request because it could not confirm it came from howispulse.com. "
            "Almost always this means it has never reached the cloud itself — in that case signing in "
            "with your account there does not work either.",
            "Check whether the server is allowed to reach the internet: docker exec {container} "
            "pulse-doctor, \"Verbindung zur Cloud\" section. An outbound firewall or a mandatory proxy "
            "is the usual cause.",
        ),
    ),
    ("betreiber", "keine_auskunft"): (
        (
            "Dieser Server kann diese Auskunft noch nicht geben — er läuft mit einer älteren Fassung. "
            "Das ist kein Fehler: Alles andere an ihm ist in Ordnung, nur diese eine Prüfung entfällt.",
            "Nichts zu tun. Der Server holt sich die neue Fassung von selbst; danach beantwortet er "
            "die Frage beim nächsten Prüflauf mit.",
        ),
        (
            "This server cannot answer this yet — it runs an older version. That is not a fault: "
            "everything else about it is fine, only this one check is skipped.",
            "Nothing to do. The server picks up the new version by itself; after that it answers this "
            "question on the next check.",
        ),
    ),
}
