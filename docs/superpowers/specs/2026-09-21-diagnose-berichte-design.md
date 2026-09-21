# Diagnose-Berichte für alles: App, Server, Player — vom Streaming-Prototyp zum Produkt

Stand 2026-09-21. **Entwurf, noch nicht umgesetzt.** Anlass und Grundzüge
besprochen (Michael + Agent, nach zwei Supportfällen derselben Woche); die
Produktentscheidungen unten sind beschlossen, drei offene Punkte stehen in
§11. Umsetzung in drei Phasen (§10).

## 1. Anlass

Zwei Supportfälle derselben Woche (2026-09-21), beide ohne Diagnosebasis:

1. **pulse.all3media.de** fuhr wochenlang einen Stand vor dem
   Ticket-Umbau (2026-08-28) fort. Weder der Betreiber noch die Cloud
   konnten das sehen — die Cloud kennt keine Instanz-Versionen (das
   adressiert der getrennte Spec 2026-09-09, hier nicht doppelt).
2. **Gordon (dieselbe Instanz, frisch neu aufgesetzt):** Community-
   erstellen quittierte mit „Der Server ist gerade nicht erreichbar" —
   bei grüner Erreichbarkeitsprüfung. Die Meldung entsteht im
   *Browser* des Nutzers (`anmeldung_netzfehler`, geworfen, wenn der
   `fetch` auf `POST /api/chat/session` scheitert); sein Server-Log
   zeigte die Anfragen, **weil sie nie ankamen**. Beide Prüfungen
   maßen die falsche Straße: die Cloud-Diagnose nur GETs von außen,
   und der Nutzer hatte gar kein Messwerkzeug.

Die Lehre aus Fall 2 ist der Kern dieses Specs: **Ein Server-Log kann
keinen Fehler enthalten, der den Server nie erreicht.** Jede
Fehlerdiagnose braucht deshalb mindestens zwei Blickpunkte — das Gerät
des Nutzers und den Server — und einen Weg, beides an die Person zu
liefern, die helfen kann.

## 2. Was heute gilt (nachgelesen, nicht vermutet)

Es gibt bereits einen funktionierenden Prototyp — für HQ-Streaming:

- **Zuschauer-Sammler** `web/src/lib/stream/diagnose-bericht.ts`
  (2026-08-06): strukturiert `{kopf, bilanz, ereignisse[],
  ereignisse_verworfen, abschluss}`; gleichartige Ereignisse werden im
  10-s-Fenster zu einem Eintrag mit `anzahl` verdient; Deckel bei 200,
  die Verworfenen-Zahl steht **im** Bericht. Genau die Form
  *Zeitpunkt · Art · Anzahl · Werte*, die dieses Produkt braucht.
- **Versand** `web/src/lib/stream/diagnose-senden.ts`:
  `POST /api/auth/experimental-logs`, `keepalive`, wirft nie.
  Opt-in über `uploadDiagnosticLogs` — **nur in der Desktop-App**
  (default an, `!== false`); Browser-Nutzer senden grundsätzlich nicht,
  weil der Schalter dort nicht abwählbar wäre (dokumentierte Lücke,
  s. §5).
- **Sender-Seite** `desktop/electron/experimental-log-upload.ts`:
  Schwanz der `sidecar.log` (≤ 512 KiB) + Systeminfo, dieselbe Route.
- **Endpoint** `services/auth/src/dcc_auth/routes_experimental_logs.py`:
  öffentlich, 30/h je IP, `MAX_EVENTS=250`, `RETENTION_DAYS=28`,
  `MAX_ROWS=5000`, Aufräumen am Schreibpfad im SAVEPOINT,
  `extra="ignore"` für Bestandsclients. Tabelle
  `experimental_logs` (`models_experimental.py`).
- **Fehlerkategorien existieren bereits**:
  `ABLEHNUNGSCODES` (`web/src/lib/api/anmelde-fehler-codes.ts`, 16
  Codes inkl. `network`) und die WS-Close-Codes des Gateways (4070
  suspended u. a., `gateway-connection.ts`). Sie werden heute nur als
  UI-Text benutzt und danach weggeworfen.
- **Client-Proben existieren**: die Erreichbarkeits-Gegenproben aus dem
  „Server hinzufügen"-Flow (`joinByHost.ts`, `add-server-flow.ts`) —
  laufen nur dort und werden danach nie wieder benutzt.
- **Nicht vorhanden:** ein Admin-Lesezugriff (die Tabelle ist nur per
  DB erreichbar), jeder Bericht über Nicht-Streaming-Probleme, der
  Server-Bericht, der Player-Bericht, ein manueller „jetzt melden"-
  Weg.

## 3. Grundsätze (beschlossen)

1. **Zwei Sammelpunkte, ein Ziel.** Das *Gerät des Nutzers* (App +
   Player) und der *Server des Betreibers* liefern getrennte Berichte
   in dieselbe Cloud-Tabelle/Ansicht. Ein Nutzer-Bericht enthält
   nie Server-Zustand, ein Server-Bericht nie Geräte-Erlebnis —
   nebeneinandergelegt in der Ansicht ergeben sie das Bild
   (Gordon-Fall: „Server von außen grün, vom Gerät rot um 14:22").
2. **Der Berichtskanal ist unabhängig von der gestörten Komponente.**
   Versand geht an die Cloud — ausgerechnet „Server nicht erreichbar"
   ist also berichtbar. Schlägt auch der Versand fehl, bietet der Knopf
   „Bericht als Datei speichern" an (Fallback, §5).
3. **Einwilligung durch die Handlung.** Automatisches Senden bleibt wie
   heute auf die Desktop-App beschränkt (Schalter, default an). Der
   **manuelle Käfer-Knopf funktioniert überall — auch im Browser**,
   denn ein ausdrücklicher Klick IST die Einwilligung. Das löst die im
   Versand-Kommentar seit 2026-08-06 dokumentierte Browser-Lücke, ohne
   stille Telemetrie einzuführen.
4. **Schwärzung hart, nicht best-effort** (§8). Das Produktversprechen
   an Selfhoster ist „Eure Daten bleiben bei euch" — der Bericht ist
   der eine Ort, an dem es gebrochen werden kann, also entscheidet die
   Schwärzung über Vertrauen, nicht über Features.
5. **Kategorien statt Prosa** (§9). Zählbar und musterbar schlägt
   romantisch lesbar, von Tag eins.
6. **Aufbewahrung bleibt begrenzt** — die bestehenden 28 Tage/5000
   Zeilen des Endpoints gelten für alle neuen Berichtstypen unverändert
   weiter.

## 4. Baustein A: der Ereignis-Ringpuffer der App (Phase 1)

**Was:** ein Sitzungs-unabhängiger Sammler `app-diagnose.ts` (neu,
muster nach `diagnose-bericht.ts`, aber ohne WHEP-Bezug): ein Ring-
puffer der letzten **250 Ereignisse** je App-Lauf, Eintrag =
`{t_rel, baustein, kategorie, text_kurz, kontext}`. Persistenz als
`sessionStorage`-Niveau ist NICHT genug — der Bericht soll einen
Neustart überleben, wenn der Nutzer erst danach meldet; also
`localStorage` mit Fassung (ein Schlüssel, JSON, bei Überschreiten von
256 KiB älteste Hälfte verwerfen).

**Quellen, die ihn füttern (alle existieren, sie werfen ihre Information
heute weg):**

| Quelle | Heutiger Ort | Kategorie (§9) |
|---|---|---|
| Anmelde-Ablehnung je Server | `self-host-reauth.ts::merkeGrund` | `anmeldung_<code>` (16 Codes existieren) |
| Re-Auth-Fetch scheitert netzwerkseitig | `server-ticket.ts:108-112` | `fetch_failed` |
| WS-Close mit Code | `gateway-connection.ts` (4070 u. a.) | `ws_closed_<code>` |
| Session-Beginn/Ende je Server | `session_tokens.svelte.ts` | `sitzung_start`/`sitzung_ende` |
| Community-/Channel-Call schlägt fehl | `erstellen.ts` u. a. | `api_fehler_<status>` |

**Nebenbei gefixt:** `merkeGrund` hat keine TTL — ein vorübergehender
Netzfehler klebt als „nicht erreichbar"-Meldung bis zur nächsten
erfolgreichen Anmeldung (Gordons Verdachtsschleier). Der Ringpuffer
ersetzt die in-memory-Map als Wahrheitsquelle; die angezeigte Meldung
bleibt, aber der Bericht zeigt die *zeitstempelte* Geschichte.

## 5. Baustein B: der Käfer-Knopf (Phase 1)

**Wo:** in der Rail unten links, über dem bestehenden Server-Button
(Michaels Vorgabe). **Was passiert:** Panel mit drei Dingen —

1. Freitext „Was ist passiert?" (optional, ≤ 2000 Zeichen),
2. die **Vorschau dessen, was gesendet wird** (Kopf + die letzten
   N Ereignisse, klappbar) — die Einwilligung braucht Sichtbarkeit,
3. „Abschicken" bzw. — wenn die Cloud selbst nicht erreichbar ist —
   „Bericht als Datei speichern" (JSON-Download, gleicher Inhalt).

**Payload:** derselbe Endpoint (`POST /api/auth/experimental-logs`),
`reason: 'user_report'`, `role: 'app'`, `report.kopf` = App-Version,
Plattform (Electron/Browser + UA), bekannte Server-Liste (nur Hostnamen,
keine Tokens), aktiver Server; `report.ereignisse` = der Ringpuffer;
Freitext in `report.abschluss.notiz`. Rate-Limit: der Endpoint hat
30/h je IP — ausreichend; zusätzlich clientseitig auf 1/Minute drosseln.

**Sichtbarkeitsregel:** der Knopf erscheint für jeden Nutzer (auch
Nicht-Betreiber), denn Geräte-Berichte kommen von denen, bei denen es
hakt. Der Server-Bericht ist und bleibt Betreiber-Sache (§7).

## 6. Baustein C: die Admin-Ansicht (Phase 2)

Neuer Cloud-only Endpoint `GET /admin/experimental-logs` (+ Detail-GET):
Liste mit Filtern `reason`, `role`, `channel_id`, Instanz/Hostname (aus
`system_info`), Zeitraum; Detailansicht rendert Kopf/Bilanz/Ereignisse
als Tabelle, `log_text` als Pre. Kein Löschen-Einzelknopf nötig — die
28-Tage-Frist räumt; ein „alle Berichte von Nutzer X löschen" reicht als
DSGVO-Hahn. Super-Admin only (`is_admin`), keine Freigabe an
Instanz-Betreiber in Phase 2 (offen: §11).

## 7. Baustein D: das Server-Paket des Selfhosters (Phase 3)

**Wo:** im Instanz-Admin der Self-Host-Server-UI, neben dem bestehenden
Diagnose-/Backup-Bereich: „Diagnose-Paket an Pulse senden". Der Betreiber
kann in seinen Container — der Normalnutzer nicht; deshalb ist dies
bewusst ein Betreiber-Feature.

**Inhalt (alles existiert bereits als Datei/Ausgabe im Container, es
wird nur gesammelt):** `setup-status` (Start-Checkliste), `s6`-Unit-
Zustände, die letzten ~200 Fehlerzeilen je Kern-Dienst (auth,
chat-gateway, media, caddy; Log-Ring der Container), Versions-Stempel
(`PULSE_BUILD_VERSION`), Konfigurations-Fingerabdruck (TLS-Modus,
Hostname, Port-Set, Tags des laufenden Images — **keine** `.env`-Werte),
das Ergebnis der letzten Selbst-Diagnose, Backup-Status.

**Transport:** als Bericht mit `role: 'server'`, `reason: 'user_report'`,
authentifiziert als Owner über die bestehende Cloud-Anmeldung des
Betreibers (nicht der öffentliche Endpoint — der Server-Bericht trägt
Instanz-Identität und muss dieser Instanz zuschreibbar sein). Gleiche
Tabellen, gleiche Ansicht wie §6, Filter `role=server` verbindet die
Sichten.

## 8. Schwärzungs-Regeln (hart, prüfbar)

Diese Liste ist Test-Anhang, nicht Absichtserklärung — jede Regel bekommt
einen roten Test:

- **Nie:** Nachrichteninhalte, Token/Secrets jeder Art (incl.
  Session-Tickets, `client_secret`, JWKS-Private), `.env`-Werte,
  Datei-/Media-URLs mit Credentials, E-Mail-Adressen von Dritten.
- **Nur wenn für die Diagnose nötig:** eigener Nutzername, eigener
  Hostname (der Betreiber-Bericht trägt ihn ohnehin).
- **Vorbild ist die bestehende Entscheidung** in `diagnose-bericht.ts`
  §„Warum es keine Server-Sitzungskennung gibt": die MediaMTX-
  `session.secret` wird bewusst NICHT übertragen, obwohl sie das
  Logging einfacher machte — Sekurität schlägt Bequemlichkeit, und
  daran orientiert sich jeder neue Sammler.
- Freitext des Nutzers ist dessen Verantwortung; vor der Anzeige in der
  Admin-Ansicht aber als Text rendern, nie als HTML.

## 9. Fehlerkategorien (v1)

Wiederverwendung vor Erfindung — die 16 `ABLEHNUNGSCODES` werden
1:1 als Präfix `anmeldung_*` übernommen. Neu (Ringpuffer-quellbezogen,
§4): `fetch_failed`, `ws_closed_<code>`, `api_fehler_<status>`,
`sitzung_start`, `sitzung_ende`, `user_notiz` (Freitext). Streaming-
Seite behält ihre bestehenden `art`-Werte unverändert. Jede Kategorie
bekommt bei Einführung einen Eintrag in der Katalog-Testliste — ein
Ereignis ohne Kategorie ist ein roter Test, genau wie eine Meldung ohne
Text heute.

## 10. Umsetzung, Phasen

1. **Phase 1 — App-Gedächtnis + Käfer-Knopf** (Bausteine A+B, web):
   Ringpuffer, fünf Quellen anschließen, Panel, Datei-Fallback.
   Kleinste in sich geschlossene Einheit; beendet die Gordon-Klasse („er hätte
   rot statt grün gesehen").
2. **Phase 2 — Admin-Ansicht** (Baustein C, web + auth): GET-Endpoints
   + Listen-/Detail-UI. Erst danach nützen die Berichte aus Phase 1
   ohne SSH.
3. **Phase 3 — Server-Paket + Player** (Bausteine D+E): Sammlung im
   Selfhost-Container, Owner-authentifiziert; Player folgt, wenn der
   erste Player-Bericht tatsächlich gewünscht wird (er hängt sonst als
   ungenutzter Ballast in der Ansicht).

Reihenfolge begründet: Phase 1 erzeugt die Daten, ohne die Phase 2 eine
leere Liste zeigt; Phase 3 braucht beide.

## 11. Offene Entscheidungen

1. **Dürfen Instanz-Betreiber die Berichte ihrer eigenen Nutzer sehen**
   (gefiltert auf ihre Instanz), oder bleibt die Ansicht Super-Admin?
   Pro Betreiber-Sicht: er ist unser erster Support-Depp. Contra:
   Berichte enthalten Hostnamen anderer Server, wenn ein Nutzer mehrere
   kennt — Filterung müsste das sauber schneiden. Vorschlag: Phase 2
   Super-Admin only, Betreiber-Sicht als Phase-3-Option.
2. **Ringpuffer-Größe/Exposition**: 250 Ereignisse/256 KiB sind ein
   Erstandwurf, kein Vertrag — nach den ersten echten Berichten
   nachjustieren.
3. **Vorbefüllung des Freitexts**: Kategorie-des letzten Fehlers als
   Chip vorschlagen („Betraf es die Anmeldung?") — Ja/Nein-Klick statt
   Schreibblockade. Produktfeinschliff, nicht Blocker.
