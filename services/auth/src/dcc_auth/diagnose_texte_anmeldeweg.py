"""Die Sätze zum Anmeldeweg-Glied der Erreichbarkeitsprüfung.

Eigenes Modul aus demselben Grund wie ``diagnose_texte_betreiber``:
``diagnose_texte`` steht an der weichen Grenze der Größen-Policy. Es mischt die
drei Tabellen hier in seine eigenen — **die einzige Quelle für Diagnose-Texte
bleibt ``diagnose_texte``**.

Besonderheit dieses Glieds: Sein häufigster Befund ist **kein Mangel**. Ein
Server auf dem Zertifikats-Weg ist während der Übergangszeit völlig in Ordnung,
und der Handgriff lautet „nichts tun". Das muss der Text deutlich sagen, sonst
schraubt jemand an einer Maschine herum, an der nichts fehlt.
"""

from __future__ import annotations

#: (de, en)
TITEL: tuple[str, str] = ("Anmeldeweg", "Sign-in method")

GELUNGEN: tuple[str, str] = (
    "Der Anmeldeweg dieses Servers ist bekannt.",
    "This server's sign-in method is known.",
)

#: ``(schritt, befund) -> ((was_ist_de, was_tun_de), (was_ist_en, was_tun_en))``
BEFUNDE: dict[tuple[str, str], tuple[tuple[str, str], tuple[str, str]]] = {
    ("anmeldeweg", "zertifikats_weg"): (
        (
            "Dieser Server meldet Nutzer noch über den älteren Weg an, bei dem der Browser einen "
            "Ausweis dauerhaft speichert. Das funktioniert, hat aber einen bekannten Nachteil: Zwei "
            "Browser auf demselben Rechner können sich gegenseitig abmelden.",
            "Nichts. Der Server holt sich die Umstellung mit dem nächsten Update von selbst. Wer "
            "nicht warten möchte, kann sie vorziehen: sudo docker pull und danach "
            "sudo docker restart {container}.",
        ),
        (
            "This server still signs users in the older way, where the browser stores a credential "
            "permanently. That works, but has a known drawback: two browsers on the same machine can "
            "sign each other out.",
            "Nothing. The server picks up the change with its next update. To pull it forward: "
            "sudo docker pull, then sudo docker restart {container}.",
        ),
    ),
    ("anmeldeweg", "keine_auskunft"): (
        (
            "Der Server hat auf die Frage nach seinem Anmeldeweg nicht verwertbar geantwortet. Das "
            "ist für sich genommen kein Fehler — es kann an einem vorgeschalteten Proxy liegen, der "
            "die Antwort ersetzt. Für die Anmeldung selbst sagt dieser Schritt dann nichts aus.",
            "Wenn die Anmeldung funktioniert, ignoriere diesen Punkt. Wenn nicht, sieh dir die "
            "vorherigen Schritte an — sie zeigen, wo die Kette wirklich reisst.",
        ),
        (
            "The server did not give a usable answer about its sign-in method. That is not an error "
            "in itself — an upstream proxy may be replacing the response. In that case this step "
            "says nothing about signing in.",
            "If signing in works, ignore this point. If it does not, look at the earlier steps — "
            "they show where the chain actually breaks.",
        ),
    ),
}
