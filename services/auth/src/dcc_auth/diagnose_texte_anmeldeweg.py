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
    ("anmeldeweg", "zu_alt"): (
        (
            "Dieser Server ist zu alt für die aktuelle Pulse-App. Er kennt den heutigen "
            "Anmeldeweg nicht, und den früheren gibt es seit dem 28. August 2026 nicht mehr — "
            "es kommt also niemand mehr herein, auch du nicht.",
            "Den Server neu aufsetzen: https://howispulse.com/self-host. Ein blosses Update "
            "genügt nicht, wenn er noch Nutzerdaten aus der Zeit davor trägt — er startet dann "
            "absichtlich nicht und sagt dir das beim Start.",
        ),
        (
            "This server is too old for the current Pulse app. It does not know today's sign-in "
            "method, and the previous one was removed on 28 August 2026 — so nobody can get in, "
            "including you.",
            "Set the server up again: https://howispulse.com/self-host. An update alone is not "
            "enough if it still holds user data from before that date — it will deliberately "
            "refuse to start and tell you so.",
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
