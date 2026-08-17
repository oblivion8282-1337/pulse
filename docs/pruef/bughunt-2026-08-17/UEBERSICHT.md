# Bughunt-Nacht vom 17. August 2026

Acht Reviere wurden getrennt voneinander durchsucht, jedes mit drei Linsen (Sonnet) auf denselben Code — einmal entlang der Datenwege, einmal entlang der Nebenlaeufigkeit, einmal entlang der Zusagen, die Kommentare und Entwurfsdokumente machen. Was eine Linse meldete, ging in eine Nachjagd, die den Befund am Code belegen oder fallenlassen musste; ein Vorfilter warf Dubletten und blosse Stilkritik heraus, und jeder verbliebene Befund lief anschliessend durch ein Gegengutachten mit Opus, das ihn entweder bestaetigte, in seiner Wirkungsbeschreibung praezisierte oder verwarf. Unter dem Strich: **46 Meldungen geprueft, 16 bestaetigt** — nach Zusammenfassung mehrfach gemeldeter identischer Stellen bleiben **13 eigenstaendige Fehler**. Vier davon wiegen hoch, sieben mittel, einer niedrig; ein weiterer ist rein kosmetisch. Kein einziger Befund ist eine Rechteumgehung im engeren Sinn — die serverseitige Durchsetzung hat ueberall standgehalten. Die Fehler sitzen stattdessen in den Aufraeumpfaden, in Rennen zwischen zwei nebenlaeufigen Ablaeufen und in bewusst doppelt gefuehrten Kopien, die auseinandergelaufen sind.

## Zuerst ansehen

1. **Hoch — Bann und Rauswurf beenden die laufende Bildschirmuebertragung des Betroffenen nicht** · `services/chat-gateway/src/dcc_chat_gateway/routes/bans.py:268` · *streaming* — der Gebannte sendet weiter in die Community, aus der er gerade entfernt wurde, und Verbliebene koennen sogar erst **nach** dem Bann neu einsteigen; die Moderationshandlung erreicht ihr Ziel nicht.
2. **Hoch — `disconnect()` bricht ein gleichzeitig laufendes `connect()` nicht ab** · `web/src/lib/voice/livekit.svelte.ts:531` · *weboberflaeche* — wer waehrend des Verbindens auflegt, kann samt Mikrofon im Kanal landen (auf Android belegt, sonst plausibel); ein Klick auf „Auflegen" fuehrt ins Gegenteil.
3. **Hoch — Fanout-Pfad grosser Communities sortiert Rollen-Ueberschreibungen ohne ID-Tiebreak** · `services/chat-gateway/src/dcc_chat_gateway/_members_view.py:290` · *rechte* — ab 500 Mitgliedern weicht die Sichtbarkeitsmenge des WS-Fanouts von der REST-Wahrheit ab; Berechtigte verlieren Live-Nachrichten, Unberechtigte erfahren Existenz und Aktivitaet gesperrter Kanaele.
4. **Hoch — Standplatz-Geraet bleibt nach einem Rennen dauerhaft auf „belegt"** · `services/chat-gateway/src/dcc_chat_gateway/routes/ws_remote_handlers.py:351` · *verbindungen* — genau bei den unbeaufsichtigten Geraeten, bei denen niemand vor Ort ist, um den Zustand zu loesen; heilt erst beim naechsten vollstaendigen Verbindungsverlust.
5. **Hoch — Server-Wechsel kann den kontoweiten Lesestatus mit einem leeren Objekt ueberschreiben** · `web/src/lib/stores/readState.svelte.ts:108` · *weboberflaeche* — stiller Verlust persistierter Daten ueber alle Server hinweg, und er braucht nicht einmal das Rennen: der naechste gewoehnliche Lesevorgang genuegt.
6. **Mittel — Stream-Token meldet 8 bit, waehrend ein Standplatz-Geraet mit 10 bit sendet** · `web/src/lib/stream/starten.ts:81` · *streaming* — hebt einen ausdruecklich gemessenen Schutzriegel auf; der Schaden trifft nicht nur den einen Browser-Zuschauer, sondern jeden anderen im selben Stream.
7. **Mittel — Konto-Purge loescht die Standplatz-Geraete des Nutzers nicht** · `services/chat-gateway/src/dcc_chat_gateway/user_purge.py:135` · *daten* — eine als „hart" zugesagte Kontoloeschung laesst Zeilen mit Besitzerkennung und Geraetenamen stehen, dauerhaft sichtbar und dauerhaft unloeschbar fuer den Namensraum.
8. **Mittel — WS-Schliesscode 4003 ist dreifach belegt** · `services/chat-gateway/src/dcc_chat_gateway/routes/ws.py:104` · *identitaet* — Instanz-Sperre und unbestaetigte E-Mail werden dem Nutzer als CORS-Problem erklaert, und der selbsttaetige Wiederverbindungsversuch wird dauerhaft abgeschaltet: ohne Neuladen kein Weg zurueck.
9. **Mittel — Rueckfall vom P2P-Kanal auf den Serverweg sendet einen frischen Druck doppelt** · `web/src/lib/remote/session.svelte.ts:240` · *fernsteuerung* — zwei `DOWN` ohne dazwischenliegendes `UP`, was echte Hardware nie erzeugt; kantengetriggerte Aktionen loesen zweimal aus.
10. **Mittel — Geraet meldet nach Verbindungsabriss weiter alte Stream-Plaetze** · `services/chat-gateway/src/dcc_chat_gateway/device_registry.py:263` · *verbindungen* — das LIVE-Abzeichen wandert an ein laengst offline gegangenes Geraet, dem wirklich sendenden Menschen fehlt es; genau der Fehler, den die Funktion beheben sollte.

Unterhalb dieser Linie bleiben drei Befunde von geringerem Gewicht: die widerspruechliche Herkunfts-Erklaerung der Kanalrechte bei gleichzeitig gesetztem `allow` und `deny` (`web/src/lib/permissions/herkunft.ts:163`), das nicht aufgeraeumte Geraeteregister bei Kanal- und Community-Loeschung (`routes/channels.py:208`, `routes/guilds.py:271`) und die ungerundeten Fliesskommazahlen im `fps`-Ereignis des Windows-Sidecars (`streaming/win-hq-sidecar/src/pipeline_hw/mod.rs:486`).

## Reviere

| Revier | bestaetigt | geprueft | Bericht |
|---|---:|---:|---|
| Rechte, Rollen und Ueberschreibungen | 2 | 6 | [rechte.md](rechte.md) |
| ConnectionManager, WebSocket-Ops und Registraturen | 2 | 5 | [verbindungen.md](verbindungen.md) |
| Fernsteuerung: Vorrang, Plaetze, Zeigerform, Transportwechsel | 1 | 3 | [fernsteuerung.md](fernsteuerung.md) |
| Stream-Tokens, Redis-Schluessel und Auth-Hook | 2 | 5 | [streaming.md](streaming.md) |
| Rust-Sidecars und Player: Zeitbasis, Encoder, Puffer | 1 | 4 | [sidecars.md](sidecars.md) |
| Weboberflaeche: Svelte-5-Runen und Zustandsfuehrung | 3 | 5 | [weboberflaeche.md](weboberflaeche.md) |
| Identitaet, Cert-Login, Instanz-Sperre und 2FA | 1 | 11 | [identitaet.md](identitaet.md) |
| Datenbank, Migrationen und Zustandsspeicher | 4 | 7 | [daten.md](daten.md) |
| **Summe** | **16** | **46** | |

Die Spalte „bestaetigt" zaehlt Meldungen, nicht Fehler: in `rechte` beschreiben beide dieselbe Stelle, in `daten` fallen vier Meldungen auf zwei Fehler zusammen. Eigenstaendige Fehler: **13**.

## Muster

**Die Standplatz-Geraete sind das schwaechste Stueck.** Fuenf der dreizehn Fehler haengen an der Funktion, die am 16. August dazukam — die haengende Belegung, die veralteten Stream-Plaetze, der fehlende Purge-Schritt, das nicht geraeumte Register bei Kanal- und Community-Loeschung, die falsche Bit-Tiefe beim Wecken. Kein einziger davon ist ein Denkfehler im Entwurf; es sind durchweg Anschlussstellen, an denen ein bestehender Pfad um den neuen Zustand erweitert werden musste und nicht erweitert wurde. Das ist das erwartbare Bild frisch gelandeter Funktionalitaet, und es ist gut behebbar — aber es bedeutet auch, dass die Funktion noch nicht in dem Zustand ist, in dem man einen Rechner unbeaufsichtigt daran haengt.

**Aufraeumpfade sind unvollstaendig, Durchsetzungspfade sind es nicht.** Bann, Rauswurf, Kontoloeschung, Kanal- und Community-Loeschung, Verbindungsabbau — an jeder dieser Stellen fehlt ein Schritt, und zwar reproduzierbar der zuletzt hinzugekommene. Der Bann raeumt Voice, Fernsteuerung, Geraete und Lese-Token, aber nicht die Sende-Seite; der Purge zaehlt zwoelf Tabellen auf, aber nicht die dreizehnte. Die Gegenrichtung — pruefen, ob jemand etwas darf — hat in allen acht Revieren gehalten. Der Aufwand liegt also nicht darin, die Riegel zu bauen, sondern darin, sie beim Aufraeumen wieder mitzunehmen.

**Bewusst doppelt gefuehrte Kopien laufen auseinander, und zwar genau an den Stellen, die `CLAUDE.md` als „synchron halten" markiert.** Der ID-Tiebreak im Rechte-Resolver wurde einmal eingefuehrt mit der ausdruecklichen Zusage, „alle Kontexte auf einmal" abzudecken — der SQL-Pfad benutzt den Resolver gar nicht und blieb unveraendert. Die Wire-Paritaet zwischen Linux- und Windows-Sidecar ist auf der Windows-Seite an fuenf Stellen gleichzeitig gebrochen, obwohl der Linux-Code die Begruendung im Kommentar traegt und zwei Tests sie festhalten. `tenBitPossible()` nennt sich im eigenen Docstring „EINE Definition fuer drei Verwendungen" — die dritte wurde beim Nachziehen vergessen. Und der Schliesscode 4003 hat drei Bedeutungen, weil Server und Client ihre Codetabellen unabhaengig gepflegt haben. Wo eine Invariante nur im Kommentar steht, haelt sie nicht; wo ein Test sie haelt (Linux-Sidecar), stimmt sie.

**Die Rennen folgen alle demselben Bauplan:** Zustand gewinnen, dann `await` auf etwas Fremdes, dann Nebenwirkung eintragen — ohne den Gewinn dazwischen noch einmal zu pruefen. Das gilt fuer die Geraetebelegung nach der Zustimmung, fuer `connect()` gegen `disconnect()`, fuer den entprellten Schreibpuffer gegen den Server-Wechsel. Bemerkenswert ist, dass an zwei dieser drei Stellen dieselbe Datei denselben Fehler an anderer Stelle bereits kommentiert und behoben hat.

**Auffaellig sauber:** Identitaet und Zugang. Elf Meldungen geprueft, zehn widerlegt, und der einzige Verbleibende ist ein Diagnose-Fehler ohne Sicherheitswirkung. Cert-Login, JWKS-Behandlung, Sperr-Poller und 2FA haben jedem Angriffsversuch der Linsen standgehalten, mehrfach mit der Begruendung, dass das vermeintete Fehlverhalten in `CLAUDE.md` als bewusste Entscheidung dokumentiert ist. Ebenfalls solide: die Rust-Sidecars — drei von vier Meldungen verworfen, der verbliebene rein kosmetisch.

## Was diese Nacht nicht geprueft hat

Es wurde **ausschliesslich gelesen**. Kein Test gelaufen, kein Build angestossen, kein Dienst gestartet, keine Zeile ausgefuehrt. Daraus folgen konkrete blinde Flecken:

- **Keiner der Befunde ist im Betrieb reproduziert.** Die Ausloesebeschreibungen sind aus dem Code abgeleitet, nicht beobachtet. Besonders die Rennen (Geraetebelegung, `connect`/`disconnect`, Schreibpuffer) haengen daran, ob der Event-Loop an der vermuteten Stelle tatsaechlich abgibt — das ist am Code plausibel gemacht, nicht gemessen.
- **Keine Aussage zur Haeufigkeit.** Ob ein Fehler taeglich auftritt oder einmal im Jahr, laesst sich aus dem Code nicht ablesen. Die Reihenfolge oben gewichtet nach Schaden im Eintrittsfall, nicht nach Eintrittswahrscheinlichkeit.
- **Nichts, was nur unter Last sichtbar wird**, wurde erfasst: Speicherverhalten, Verbindungszahlen, Datenbank-Ausfuehrungsplaene. Der Rechte-Befund haengt ausdruecklich am Ausfuehrungsplan von Postgres — ob er auf der Produktivmaschine heute kippt, ist offen.
- **Keine Regressionspruefung.** Es ist nicht geprueft, ob die bestehenden Tests diese Fehler haetten fangen muessen, und ob sie derzeit gruen sind. Die Playwright-Grundlinie (98 gruen, 4 rot) ist nicht nachgefahren worden.
- **Die vorgeschlagenen Fixes sind ungetestet.** Sie sind als Richtung gedacht, nicht als fertige Aenderung; keiner wurde geschrieben, keiner gebaut.
- **Nicht durchsuchte Bereiche:** Chat und Nachrichten selbst, Voice-Signaling und LiveKit-Anbindung serverseitig, Plugin-System, Watch-Party, Anhaenge und MinIO, Electron-Hauptprozess und Auto-Update, Flatpak- und Windows-Verpackung, die Produktiv-Konfiguration in `infra/`, Alembic-Migrationen abseits der Geraetetabelle sowie der gesamte auth-svc ausserhalb von 2FA und Cert-Login.
- **Kein Blick auf Abhaengigkeiten** — keine Pruefung auf bekannte Schwachstellen in `uv.lock` oder `pnpm-lock.yaml`, keine Lizenzpruefung.
