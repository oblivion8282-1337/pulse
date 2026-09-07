# Der Direktweg fragt die falsche Liste — Befund und die drei Wege

Gefunden am 2026-09-07 in einem Bughunt, gegengeprüft am Code. **Nicht behoben**
— behoben ist nur die Bremse (s. unten „Was schon drin ist"). Wer das angeht,
liest zuerst diesen Abschnitt zu Ende: die Wahl zwischen den drei Wegen ist
keine technische, sondern eine über die Reichweite des Hostings.

## Der Befund

`POST /me/instances/{id}/membership` trägt den angemeldeten Nutzer als
`member` bei **jeder aktiven Instanz** ein, ohne irgendetwas zu prüfen. Das ist
Absicht und im Docstring der Route ausdrücklich festgehalten: die Cloud kann
die Mitgliedschaft auf einem Self-Host gar nicht verifizieren (isolierte
Datenbank-Welten), die Liste ist eine **Merkhilfe für „meine Server"**, damit
ein beigetretener Server auf allen Geräten auftaucht — „kein Zugriffsbeweis",
so steht es dort.

Zwei Routen behandeln sie trotzdem als Beweis:

| Route | Was sie herausgibt |
|---|---|
| `GET /me/instances/{id}/direct-endpoint` (`routes_selfhost_directory.py:141`) | ICE-Kandidaten + DTLS-Fingerprint — also die **Heim-IP** des Betreibers, im eigenen Docstring als sensibel bezeichnet |
| `POST /me/instances/{id}/direct-offer` (`routes_selfhost_signal.py:98`) | reicht ein beliebiges SDP-Angebot an die Instanz durch; `bridge.rs` spannt die entstehende Verbindung 1:1 als HTTP/WS-Proxy auf `127.0.0.1:8080` im Container auf |

Damit genügen zwei Aufrufe von einem beliebigen Cloud-Konto aus, um die
Heimadresse einer fremden Instanz zu erfahren und einen Draht auf ihre interne
HTTP-Fläche zu öffnen.

**Was der Angreifer NICHT bekommt:** Zugriff auf Daten. Die Anwendung dahinter
prüft die Anmeldung unverändert; ohne gültiges Sitzungs-Ticket kommt er nicht
weiter als bis zum Proxy.

**Was er bekommt:** die IP-Adresse eines privaten Anschlusses (grober Wohnort,
und genug für einen Überlastungsangriff) und einen Netzwerkzugang zu einer
Fläche, die der Betreiber bewusst nicht ins Internet gestellt hat — nutzbar zum
Abklopfen von Pfaden und zum Umgehen einer vorgelagerten IP-Sperre.

## Warum es kein Zweizeiler ist

Es gibt heute nur die Rollen `owner` und `member` und **kein Konzept für eine
Einladung**. Jede Absicherung muss also erst festlegen, woran man einen
Berechtigten überhaupt erkennt.

Hinzu kommt der Punkt, der die Entscheidung eigentlich trägt und der keine
Code-Frage ist: **der Direktweg funktioniert nur, indem er die Heimadresse
preisgibt.** Das ist keine Schwäche der Umsetzung, sondern die Natur einer
Direktverbindung. Bei einem Freundeskreis ist das unproblematisch. Bei vielen
Mitgliedern heißt es: jedes Mitglied kennt den Anschluss des Betreibers. Die
Frage ist deshalb weniger „wer darf die Abkürzung" als **„ab wann lohnt die
Abkürzung das Preisgeben nicht mehr"**.

## Die drei Wege

**1 — Nur der Besitzer.** Die beiden Routen fragen `role == "owner"` statt
„Eintrag vorhanden". Zwei Zeilen, sofort dicht.
*Preis:* Der Direktweg ist laut `web/src/lib/direct/registry.ts` **keine
Verwaltungsfunktion, sondern die Abkürzung für jeden Nutzer eines
Self-Host-Servers** — er spart den Umweg über den Relay. Mit diesem Weg behält
nur der Besitzer sie, alle anderen laufen wieder über den Relay. Ausfallen
würde nichts (der Relay ist der eingebaute Rückfall, ein gescheiterter
Direktversuch ist dort der Normalfall), es wird für die anderen langsamer und
der Relay trägt mehr Verkehr.

**2 — Eine echte Berechtigung neben der Merkhilfe.** Die Lesezeichen-Liste
bleibt, was sie ist; daneben tritt eine Markierung, die nur der Betreiber
vergibt, und die Direktrouten fragen diese. Braucht eine Spalte, einen
Vergabeweg (naheliegend: wer sich am Self-Host tatsächlich angemeldet hat,
bekommt sie — das weiß aber nur der Self-Host, nicht die Cloud) und eine Stelle
in den Servereinstellungen zum Ansehen und Zurücknehmen.
*Das ist der Weg, der dem Betreiber den Schalter in die Hand gibt, statt die
Abwägung oben im Code festzunageln.*

**3 — Die Instanz entscheidet.** Die Cloud reicht nur durch, der Self-Host
lehnt Unbekannte selbst ab. Verlegt die Autorisierung dorthin, wo das Wissen
ohnehin liegt, und ist damit die sauberste Antwort auf „die Cloud kann es nicht
wissen" — aber auch der größte Umbau, und die Heim-IP wäre schon heraus, bevor
die Instanz gefragt wird (der Fingerprint kommt aus dem Telefonbuch der Cloud).

## Was schon drin ist

`POST /me/instances/{id}/membership` hat seit dem 2026-09-07 eine Bremse
(`instance_membership_join`, 30/Stunde, **mit Konto-Eimer** — Kennungen
durchprobieren kostet dadurch ein Konto und nicht bloß eine IP). Sie steht in
jedem der drei Wege richtig und nimmt keinem etwas vorweg. Sie behebt den
Befund **nicht**: sie verteuert das Durchprobieren, während ein Angreifer mit
einer bereits bekannten Instanz-Kennung unverändert durchkommt.

## Nachbarbefund, gehört nicht hierher, aber in dieselbe Ecke

Snowflake-Kennungen sind nicht zufällig, sondern tragen ihren Zeitpunkt. Sie
erschweren das Durchprobieren, ersetzen aber keine Berechtigungsprüfung — wer
den ungefähren Registrierungszeitpunkt einer Instanz kennt, sucht in einem
kleinen Raum.
