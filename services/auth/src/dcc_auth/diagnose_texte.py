"""Die Sätze zur Erreichbarkeitsprüfung — **die einzige Quelle** dafür.

Warum sie hier liegen und nicht dreimal im Repo
-----------------------------------------------
Drei Stellen zeigen dasselbe Ergebnis: der Installer im Terminal, die App unter
„Meine Instanzen", und ``pulse-doctor`` im Container. Läge der Text an jeder
Stelle eigens, beschriebe bald jede denselben Zustand mit anderen Worten — der
Plan (``docs/plans/2026-08-25-selfhost-erreichbarkeit-diagnose.md``) verlangt
deshalb ausdrücklich **einen** Ort. Der Server liefert den fertigen Satz mit der
Antwort aus; die Anzeigen zeigen ihn nur noch an.

Der wichtigste Adressat sitzt im Terminal
-----------------------------------------
Er hat gerade installiert, steht auf der Maschine und kann sofort handeln. Für
ihn zerfällt jeder Befund in **zwei** Sätze, und beide sind Pflicht:

* ``was_ist`` — was gemessen wurde, in Alltagssprache.
* ``was_tun`` — der nächste Handgriff, konkret genug zum Abtippen.

Ein Befund ohne ``was_tun`` ist eine Sackgasse. Genau daran ist der Fall vom
2026-07-29 gescheitert: die Prüfung meldete ``kein_handschlag`` und liess den
Betreiber damit stehen.

Sprache
-------
``de`` und ``en``, mehr kennt die Prüfung nicht. Wer etwas anderes verlangt,
bekommt Englisch — eine leere Zeile wäre schlimmer als die falsche Sprache.
"""

from __future__ import annotations

import re

#: Die Kette in ihrer Reihenfolge. ``gesamt`` ist kein Glied, sondern der
#: Sammelbefund, wenn die ganze Prüfung in ihre Frist läuft.
SCHRITTE: tuple[str, ...] = (
    "dns",
    "tcp443",
    "tls",
    "health",
    "identitaet",
    "cors",
    "websocket",
    "stun",
    "rtmps",
)

SPRACHEN: tuple[str, ...] = ("de", "en")

#: Überschrift je Schritt — (de, en). Alltagssprache, keine Protokollnamen:
#: „tcp443" sagt einem Server-Admin etwas, „Erreichbarkeit (Port 443)" auch dem
#: Betreiber, der die Prüfung nur liest.
_TITEL: dict[str, tuple[str, str]] = {
    "dns": ("Namensauflösung", "Name lookup"),
    "tcp443": ("Erreichbarkeit (Port 443)", "Reachability (port 443)"),
    "tls": ("Verschlüsselung", "Encryption"),
    "health": ("Zustand des Servers", "Server condition"),
    "identitaet": ("Identität", "Identity"),
    "cors": ("Browser-Freigabe", "Browser access"),
    "websocket": ("Live-Verbindung", "Live connection"),
    "stun": ("Sprachverbindung (UDP)", "Voice connection (UDP)"),
    "rtmps": ("Bildschirmübertragung", "Screen sharing"),
    "gesamt": ("Prüfung", "Check"),
}

_TITEL_UNBEKANNT = ("Weiterer Schritt", "Further step")

#: Was ein gelungener Schritt bedeutet — für die Checkliste im Terminal, damit
#: hinter einem Haken nicht nur ein Stichwort steht.
_GELUNGEN: dict[str, tuple[str, str]] = {
    "dns": ("Der Name zeigt auf eine öffentliche Adresse.", "The name points at a public address."),
    "tcp443": ("Port 443 ist von aussen offen.", "Port 443 is open from the outside."),
    "tls": ("Das Zertifikat ist gültig und wird anerkannt.", "The certificate is valid and trusted."),
    "health": ("Der Server meldet sich gesund.", "The server reports itself healthy."),
    "identitaet": ("Es ist wirklich dein Server.", "It really is your server."),
    "cors": ("Der Browser darf zugreifen.", "Browsers are allowed access."),
    "websocket": ("Live-Verbindungen kommen durch.", "Live connections get through."),
    "stun": ("UDP kommt an — Sprache funktioniert.", "UDP arrives — voice works."),
    "rtmps": ("Port 1936 ist offen.", "Port 1936 is open."),
    "gesamt": ("Geprüft.", "Checked."),
}

_GELUNGEN_UNBEKANNT = ("In Ordnung.", "Fine.")

#: ``(schritt, befund) -> ((was_ist_de, was_tun_de), (was_ist_en, was_tun_en))``
#:
#: Die Befund-Schlüssel entstehen in ``selfhost_probe.py`` und
#: ``selfhost_probe_dienst.py``; ein Test hält beide Seiten gegeneinander, damit
#: kein Befund ohne Satz auf die Leitung geht.
_BEFUNDE: dict[tuple[str, str], tuple[tuple[str, str], tuple[str, str]]] = {
    ("dns", "name_unbekannt"): (
        ("Der Name lässt sich nicht auflösen — es gibt für ihn keinen Eintrag im Internet.",
         "Trage beim Domain-Anbieter einen A-Eintrag für diesen Namen auf die öffentliche IP-Adresse deines Servers ein. Neue Einträge brauchen bis zu einer Stunde, bis sie überall gelten."),
        ("The name does not resolve — there is no record for it on the internet.",
         "Add an A record for this name at your domain provider, pointing at your server's public IP address. New records can take up to an hour to take effect everywhere."),
    ),
    ("dns", "zeigt_ins_private_netz"): (
        ("Der Name zeigt auf eine Adresse aus einem privaten Netz (etwa 192.168.x.x oder 10.x.x.x). Aus dem Internet ist der Server so nicht erreichbar.",
         "Ändere den A-Eintrag auf die öffentliche IP-Adresse des Servers. Die private Adresse gilt nur innerhalb deines Netzes."),
        ("The name points at a private network address (such as 192.168.x.x or 10.x.x.x). The server cannot be reached from the internet that way.",
         "Change the A record to the server's public IP address. The private address only works inside your own network."),
    ),
    ("tcp443", "kein_durchkommen"): (
        ("Auf Port 443 antwortet nichts. Dort läuft der gesamte Zugang zu Pulse.",
         "Drei Dinge prüfen, in dieser Reihenfolge: Läuft der Container (docker ps)? Ist Port 443 in der Firewall des Servers offen? Steht ein Router oder eine Firewall davor, muss sie Port 443 auf diese Maschine weiterleiten."),
        ("Nothing answers on port 443. All access to Pulse runs through it.",
         "Check three things, in this order: is the container running (docker ps)? Is port 443 open in the server's firewall? If a router or firewall sits in front, it must forward port 443 to this machine."),
    ),
    ("tls", "kein_handschlag"): (
        ("Die Verbindung auf Port 443 wird angenommen, aber es kommt keine verschlüsselte Verbindung zustande. Dort antwortet also etwas — nur nicht Pulse.",
         "Meist steht unter dieser Adresse eine fremde Firewall oder ein anderer Server. Prüfe zuerst, ob der A-Eintrag wirklich auf diese Maschine zeigt. Reicht eine Firewall die Ports 80 und 443 an Pulse weiter, starte Pulse zusätzlich mit PULSE_TLS_MODE=behind-proxy — sonst versucht es vergeblich, sich selbst ein Zertifikat zu holen."),
        ("The connection on port 443 is accepted, but no encrypted connection is established. So something answers there — just not Pulse.",
         "Usually a foreign firewall or a different server sits at this address. First check whether the A record really points at this machine. If a firewall forwards ports 80 and 443 to Pulse, also start Pulse with PULSE_TLS_MODE=behind-proxy — otherwise it keeps trying in vain to obtain a certificate of its own."),
    ),
    ("tls", "handschlag_abgelehnt"): (
        ("Auf Port 443 wird keine Verschlüsselung gesprochen — dort antwortet ein anderer Dienst.",
         "Prüfe, ob der A-Eintrag auf diese Maschine zeigt und ob eine Firewall davor Port 443 tatsächlich an Pulse weiterleitet und nicht an einen anderen Dienst."),
        ("Nothing speaks TLS on port 443 — a different service answers there.",
         "Check whether the A record points at this machine, and whether a firewall in front really forwards port 443 to Pulse rather than to some other service."),
    ),
    ("tls", "abgelaufen"): (
        ("Das Zertifikat ist abgelaufen. Browser brechen die Verbindung ab.",
         "Normalerweise erneuert der Server es von selbst; dafür muss Port 80 von aussen offen sein. Port 80 öffnen, dann: docker restart {container}"),
        ("The certificate has expired. Browsers will refuse the connection.",
         "The server normally renews it on its own, but that needs port 80 open from the outside. Open port 80, then: docker restart {container}"),
    ),
    ("tls", "selbstsigniert"): (
        ("Das Zertifikat ist selbst ausgestellt — kein Browser nimmt es an.",
         "Ein echtes bekommt der Server nur, wenn der A-Eintrag auf diese Maschine zeigt UND Port 80 von aussen offen ist. Beides prüfen, dann: docker restart {container}"),
        ("The certificate is self-issued; no browser will accept it.",
         "The server can only obtain a real one once the A record points at this machine AND port 80 is open from the outside. Check both, then: docker restart {container}"),
    ),
    ("tls", "kette_unvollstaendig"): (
        ("Dem Zertifikat fehlt ein Teil seiner Kette. Am Rechner geht es oft trotzdem, auf Handys fast nie.",
         "Läuft ein eigener Reverse-Proxy davor, muss er die vollständige Kette ausliefern — bei Let's Encrypt ist das fullchain.pem, nicht cert.pem."),
        ("The certificate is missing part of its chain. Desktop browsers often still work, phones almost never.",
         "If you run your own reverse proxy in front, it must serve the full chain — with Let's Encrypt that is fullchain.pem, not cert.pem."),
    ),
    ("tls", "falscher_name"): (
        ("Das Zertifikat gilt für einen anderen Namen als den geprüften.",
         "Entweder zeigt der A-Eintrag auf einen fremden Server, oder der Proxy davor liefert das Zertifikat einer anderen Seite aus. Prüfe die Proxy-Regel für genau diesen Namen."),
        ("The certificate is issued for a different name than the one checked.",
         "Either the A record points at someone else's server, or the proxy in front serves another site's certificate. Check the proxy rule for exactly this name."),
    ),
    ("tls", "nicht_vertrauenswuerdig"): (
        ("Das Zertifikat wird nicht anerkannt; ein Browser würde die Verbindung abbrechen.",
         "Sieh nach, welches Zertifikat unter dieser Adresse ausgeliefert wird. Meist stammt es von einer Firewall, die die Verbindung aufbricht, oder von einem Proxy mit eigenem, unbekanntem Aussteller."),
        ("The certificate is not trusted; a browser would refuse the connection.",
         "Look at which certificate is served at this address. It usually comes from a firewall that intercepts the connection, or from a proxy with its own unknown issuer."),
    ),
    ("health", "keine_antwort"): (
        ("Der Server nimmt die Verbindung an, antwortet aber nicht.",
         "Steht ein Reverse-Proxy davor, zeigt seine Weiterleitung vermutlich ins Leere. Prüfe die Zieladresse in der Proxy-Regel — sie muss auf den Pulse-Container zeigen."),
        ("The server accepts the connection but does not answer.",
         "If a reverse proxy sits in front, its forwarding rule probably points nowhere. Check the target address in the proxy rule — it must point at the Pulse container."),
    ),
    ("health", "server_krank"): (
        ("Der Server läuft, meldet sich aber selbst als gestört.",
         "Der Zusatz nennt den betroffenen Teil. Einzelheiten von innen: docker exec {container} pulse-doctor"),
        ("The server is running but reports itself as impaired.",
         "The detail names the affected part. For details from the inside: docker exec {container} pulse-doctor"),
    ),
    ("health", "unerwartete_antwort"): (
        ("Der Server antwortet, aber nicht wie ein Pulse-Server.",
         "Zeigt die Proxy-Regel für diesen Namen wirklich auf Pulse? Häufig landet man stattdessen auf der Standardseite des Webservers."),
        ("The server answers, but not like a Pulse server.",
         "Does the proxy rule for this name really point at Pulse? Often you end up on the web server's default page instead."),
    ),
    ("identitaet", "keine_auskunft"): (
        ("Der Server gibt seine Kennung nicht heraus.",
         "Meist fehlt im vorgelagerten Proxy die Weiterleitung für Pfade unterhalb von /.well-known/. Diese Pfade müssen an Pulse gehen."),
        ("The server does not hand out its identity.",
         "Usually the proxy in front is missing the forwarding rule for paths under /.well-known/. Those paths must reach Pulse."),
    ),
    ("identitaet", "keine_json_antwort"): (
        ("Statt der Serverauskunft kommt eine gewöhnliche Webseite zurück.",
         "Der Proxy davor leitet diesen Pfad nicht an Pulse weiter. Leite den gesamten Namen an Pulse weiter, nicht einzelne Pfade."),
        ("A plain web page comes back instead of the server's identity.",
         "The proxy in front does not forward this path to Pulse. Forward the whole name to Pulse rather than individual paths."),
    ),
    ("identitaet", "fremde_instanz"): (
        ("Unter dieser Adresse antwortet ein ANDERER Pulse-Server.",
         "Der A-Eintrag oder die Proxy-Regel zeigt auf den falschen Rechner. Prüfe beides — alles andere sieht bis dahin grün aus, obwohl deine Nutzer beim falschen Server landen."),
        ("A DIFFERENT Pulse server answers at this address.",
         "The A record or the proxy rule points at the wrong machine. Check both — everything else looks green until you do, even though your users end up on the wrong server."),
    ),
    ("cors", "keine_antwort"): (
        ("Die Vorabfrage des Browsers bleibt unbeantwortet.",
         "Ein Proxy davor beantwortet OPTIONS-Anfragen selbst oder verwirft sie. Er muss sie unverändert an Pulse durchreichen."),
        ("The browser's preflight request goes unanswered.",
         "A proxy in front answers OPTIONS requests itself or drops them. It must pass them through to Pulse unchanged."),
    ),
    ("cors", "kein_header"): (
        ("Der Server erlaubt einem Browser, der auf einer ANDEREN Adresse steht, den Zugriff nicht. Das betrifft das Hinzufügen dieses Servers von dort aus — nicht das gewöhnliche Anmelden, wenn du bereits direkt auf dieser Adresse bist.",
         "Ein Proxy davor entfernt vermutlich Antwort-Kopfzeilen. Pulse setzt sie selbst — sie müssen unverändert durchkommen."),
        ("The server does not grant access to a browser sitting at a DIFFERENT address. This affects adding this server from there — not ordinary sign-in once you are already directly at this address.",
         "A proxy in front is probably stripping response headers. Pulse sets them itself — they must pass through unchanged."),
    ),
    ("cors", "doppelter_header"): (
        ("Die Freigabe kommt doppelt — der Browser verwirft die Antwort dann ganz.",
         "Der Proxy davor setzt eigene CORS-Kopfzeilen. Nimm sie dort heraus; Pulse setzt sie bereits selbst."),
        ("The grant arrives twice — browsers discard the response entirely then.",
         "The proxy in front sets its own CORS headers. Remove them there; Pulse already sets them itself."),
    ),
    ("cors", "andere_herkunft"): (
        ("Der Server erlaubt den Zugriff nur einer anderen Adresse.",
         "Prüfe, ob PULSE_HOSTNAME wirklich der Name ist, unter dem der Server erreichbar sein soll."),
        ("The server only grants access to a different address.",
         "Check whether PULSE_HOSTNAME is really the name the server should be reachable under."),
    ),
    ("websocket", "kein_upgrade"): (
        ("Der Proxy vor dem Server reicht Live-Verbindungen nicht durch. Das ist die häufigste Falle überhaupt: alles andere funktioniert, aber der Chat bleibt leer.",
         "Bei nginx fehlen die Kopfzeilen Upgrade und Connection. Beim Nginx Proxy Manager ist es der Haken „WebSockets Support“. Bei Caddy geht es ohne Zutun."),
        ("The proxy in front does not pass live connections through. This is the single most common trap: everything else works, but the chat stays empty.",
         "With nginx the Upgrade and Connection headers are missing. In Nginx Proxy Manager it is the \"WebSockets Support\" checkbox. Caddy does it without any configuration."),
    ),
    ("websocket", "kein_gateway"): (
        ("Die Verbindung wird angenommen, aber dahinter antwortet kein Pulse-Server.",
         "Prüfe die Weiterleitung des Proxys für den Pfad /ws — sie muss auf denselben Container zeigen wie der Rest."),
        ("The connection is accepted, but no Pulse server answers behind it.",
         "Check the proxy's forwarding for the path /ws — it must point at the same container as everything else."),
    ),
    ("websocket", "server_ohne_cloud"): (
        ("Der Chat-Dienst im Container hat noch keine Antwort von seinem eigenen Anmelde-Dienst (auth-svc) bekommen und lehnt deshalb jede Anmeldung ab. Das Problem sitzt IM Container — nicht an der Verbindung zu howispulse.com.",
         "Sieh von innen nach, welcher Dienst hängt: docker exec {container} pulse-doctor, Abschnitt „Dienste im Container“. Meist ist der Anmelde-Dienst noch nicht gestartet oder abgestürzt."),
        ("The chat service inside the container has not yet gotten an answer from its own sign-in service (auth-svc) and therefore refuses every sign-in. The problem sits INSIDE the container — not in the connection to howispulse.com.",
         "Check from the inside which service is stuck: docker exec {container} pulse-doctor, \"Dienste im Container\" section. Usually the sign-in service has not started yet or has crashed."),
    ),
    ("websocket", "instanz_gesperrt"): (
        ("Diese Instanz ist in der Cloud gesperrt. Anmeldungen werden abgelehnt, die Daten sind unangetastet.",
         "Wende dich an den Betreiber von howispulse.com. Eine Sperre ist umkehrbar."),
        ("This instance is suspended in the cloud. Sign-ins are refused; the data is untouched.",
         "Contact the operator of howispulse.com. A suspension can be lifted."),
    ),
    ("stun", "kein_durchkommen"): (
        ("Auf Port 3478 (UDP) kommt nichts an. Chat funktioniert damit, Sprache und Bildschirmübertragung nicht — die laufen am Reverse-Proxy vorbei direkt zum Server.",
         "Öffne in der Firewall UDP 3478 sowie UDP 7882 bis 7892 auf diese Maschine. Ein Reverse-Proxy hilft hier nichts, der Verkehr geht an ihm vorbei."),
        ("Nothing arrives on port 3478 (UDP). Chat still works, voice and screen sharing do not — those go straight to the server, past the reverse proxy.",
         "Open UDP 3478 and UDP 7882 to 7892 to this machine in the firewall. A reverse proxy does not help here; the traffic bypasses it."),
    ),
    ("stun", "fremde_antwort"): (
        ("Auf Port 3478 antwortet etwas anderes als erwartet.",
         "Belegt ein anderer Dienst den Port? Auf der Maschine prüfen mit: ss -ulpn | grep 3478"),
        ("Something other than expected answers on port 3478.",
         "Is another service occupying the port? Check on the machine with: ss -ulpn | grep 3478"),
    ),
    ("rtmps", "kein_durchkommen"): (
        ("Port 1936 ist nicht erreichbar. Bildschirmübertragung in hoher Qualität braucht ihn.",
         "Öffne TCP 1936 in der Firewall. Chat und Sprache funktionieren auch ohne — das hier ist der einzige Punkt, der warten darf."),
        ("Port 1936 is not reachable. High-quality screen sharing needs it.",
         "Open TCP 1936 in the firewall. Chat and voice work without it — this is the one point that may wait."),
    ),
    ("gesamt", "zeitueberschreitung"): (
        ("Die Prüfung dauerte zu lange und wurde abgebrochen.",
         "Später noch einmal versuchen. Bleibt es dabei, antwortet der Server sehr langsam — prüfe die Last der Maschine."),
        ("The check took too long and was aborted.",
         "Try again later. If it persists, the server answers very slowly — check the machine's load."),
    ),
}

#: Für einen Befund, den diese Fassung noch nicht kennt. Der Server darf neuer
#: sein als der Installer, den jemand vor Monaten heruntergeladen hat.
_ALLGEMEIN = (
    ("Hier ist etwas nicht in Ordnung.",
     "Einzelheiten stehen in den Protokollen des Servers: docker logs {container}"),
    ("Something is wrong here.",
     "The server logs have the details: docker logs {container}"),
)


def _index(sprache: str) -> int:
    return 0 if sprache == "de" else 1


#: Vorgabe, wenn kein (gültiger) Containername mitkommt.
_CONTAINER_STANDARD = "pulse"

#: Was Docker für Containernamen überhaupt erlaubt.
_CONTAINER_MUSTER = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]*$")


def container_name(roh: str | None) -> str:
    """Der Containername für die Handgriffe (``docker restart/exec/logs …``).

    Der Name kommt von außen — der Installer schickt ihn mit dem
    Diagnose-Aufruf mit — und landet in einem Befehl, den ein Mensch
    anschließend ungeprüft in seine Shell kopiert. Ungeprüft übernommen
    könnte jeder, der einen Diagnose-Aufruf absetzen darf, beliebigen Text in
    diesen Befehl einschleusen. Docker erlaubt für Containernamen nur
    ``[a-zA-Z0-9][a-zA-Z0-9_.-]*`` — alles andere fällt auf ``pulse`` zurück,
    ebenso ein fehlendes ODER leeres Feld (ältere Installer melden den Namen
    gar nicht mit; ``roh`` ist dann ``None`` oder ``""``, beides muss greifen).
    """
    if roh and _CONTAINER_MUSTER.match(roh):
        return roh
    return _CONTAINER_STANDARD


def sprache_aus_header(accept_language: str | None) -> str:
    """``de`` nur bei ausdrücklichem Wunsch, sonst ``en``.

    Bewusst grob: geprüft wird, ob irgendwo ``de`` als Sprach-Kennung steht.
    Eine vollständige Auswertung der Gewichte wäre für zwei Sprachen Aufwand
    ohne Ertrag — und ein Fehlgriff kostet hier die Sprache, nicht die Aussage.
    """
    if not accept_language:
        return "en"
    for teil in accept_language.split(","):
        kennung = teil.split(";")[0].strip().lower()
        if kennung == "de" or kennung.startswith("de-"):
            return "de"
    return "en"


def titel(schritt: str, sprache: str = "en") -> str:
    """Überschrift des Schritts in Alltagssprache."""
    return _TITEL.get(schritt, _TITEL_UNBEKANNT)[_index(sprache)]


def erklaerung(
    schritt: str, befund: str, ok: bool, sprache: str = "en", container: str | None = None
) -> tuple[str, str]:
    """``(was_ist, was_tun)``.

    Bei einem gelungenen Schritt ist ``was_tun`` leer — es gibt nichts zu tun,
    und ein Pflichtsatz an der Stelle wäre Füllwerk.

    Manche Handgriffe nennen den Docker-Container beim Namen (``docker
    restart``/``exec``/``logs``) — die Vorlagen tragen dafür den Platzhalter
    ``{container}``. Ohne ``container`` bleibt der Platzhalter unaufgelöst in
    ``was_tun`` stehen: diese Funktion nagelt selbst keinen Namen fest, das
    tut ``container_name()`` beim Aufrufer (der Route). So bleibt sichtbar,
    welcher Aufrufer den Namen tatsächlich kennt und welcher nur die Vorgabe
    einsetzt.
    """
    if ok:
        return _GELUNGEN.get(schritt, _GELUNGEN_UNBEKANNT)[_index(sprache)], ""
    was_ist, was_tun = _BEFUNDE.get((schritt, befund), _ALLGEMEIN)[_index(sprache)]
    if container is not None:
        was_tun = was_tun.format(container=container)
    return was_ist, was_tun


def alle_paare() -> list[tuple[str, str]]:
    """Jedes ``(schritt, befund)``, für das ein Satz hinterlegt ist."""
    return sorted(_BEFUNDE)
