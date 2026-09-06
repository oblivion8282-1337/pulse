# Gast-Links: externe Teilnehmer in einem Sprachkanal

Stand 2026-09-04. **Gebaut.** Drei Stellen weichen bewusst vom ersten Entwurf
ab; sie sind unten jeweils dort vermerkt, wo sie hingehören, und hier in einer
Zeile:

1. **Getrennte Routen statt Gast-Zweigen.** Der Entwurf liess
   ``GET /channels/{id}/whep`` und ``voice/token`` zusätzlich Gast-Tickets
   annehmen. Das widersprach der eigenen Regel „nirgends ein Nutzer ODER Gast
   an einer Abhängigkeit": beide haben jetzt eine eigene Gast-Route
   (``/gast/sitzung/whep`` im chat-gateway, ``/gast/whep`` in media-svc,
   ``POST /gast/token`` in voice-signaling).
2. **Die Ticket-Routen liegen unter ``/gast/sitzung/…``**, nicht direkt unter
   ``/gast/…`` — ``/gast/{code}`` frisst sonst jeden einsegmentigen Pfad
   darunter. Beim ersten Testlauf prompt passiert (404 statt 403).
3. **Das Benutzerlimit wird beim Beitritt geprüft**, nicht bei der
   Token-Ausgabe: die Kanal-Zeile mit dem Limit liegt in der
   chat-gateway-Datenbank, und der Gast-Weg in voice-signaling hat keinen
   Nutzer-Bearer, mit dem er danach fragen könnte.

## Wozu

Ein Mitglied schickt jemandem ohne Pulse-Konto einen Link. Der Empfänger
tippt seinen Namen ein und sitzt im Sprachkanal: er wird gehört, er sieht die
anderen, und er sieht, was übertragen wird — die Bildschirmfreigabe aus dem
Browser ebenso wie eine HQ-Übertragung. Gedacht für Besprechungen mit Leuten
ausserhalb der eigenen Community, ohne dass jemand ein Konto anlegt.

## Zuschnitt

Der Gast **darf**: verbinden, sprechen, zuhören, Kamera senden, alles
mitsehen (LiveKit-Screenshare und HQ-Stream).

Der Gast **darf nicht**: den eigenen Bildschirm teilen, im Chat lesen oder
schreiben, andere Kanäle sehen, irgendetwas ausserhalb des einen Kanals.

**Nicht in v1** (bewusst, jeweils mit Grund):
- **Wartezimmer** (Host lässt jeden einzeln herein) — teuerstes Stück des
  Vorhabens (eigener Zustand, Benachrichtigung, Warteschlange). Solange der
  Link kurz lebt, entwertbar ist und man rauswerfen kann, trägt der Verzicht.
- **Gast im Text-Chat** — bräuchte eine Autoren-Identität für Nachrichten und
  den WebSocket-Weg; beides zieht den Gast in Bereiche, die er sonst nicht
  berührt.
- **Gast teilt selbst den Bildschirm** — technisch billig (eine weitere
  erlaubte Quelle), aber erst auf Bedarf.
- **Benannte Einzel-Links pro Person** — ein Besprechungslink für alle ist der
  gewählte Schnitt.

## Die Entscheidung, die alles trägt: wer unterschreibt das Ticket

Ein Gast bekommt **kein Konto**, sondern ein kurzlebiges JWT. Die Frage ist,
mit welchem Schlüssel.

- **Ed25519-Sitzungsschlüssel des chat-gateway** (`session_signing.pem`) —
  fällt aus. In der Cloud liegt er im privaten Volume `pulse_chat_data`;
  voice-signaling und media-svc kommen nicht heran. Beide weisen kid-lose
  Token im Cloud-Betrieb ohnehin grundsätzlich ab (`security.py`, Dispatch
  über die kryptografische Struktur). Nur im All-in-One-Image teilen sich
  alle Dienste `/data/jwt_keys` — ein Weg, der nur auf einer der beiden
  Betriebsarten funktioniert, ist keiner.
- **Eigener Schlüssel im chat-gateway plus zweites JWKS** — funktioniert,
  kostet aber eine zweite Schlüsselverteilung und eine zweite JWKS-URL in
  jedem Dienst.
- **RS256-Schlüssel von auth-svc über JWKS** — gewählt. Der einzige
  Schlüssel, dem chat-gateway, voice-signaling **und** media-svc in **beiden**
  Betriebsarten schon heute trauen. Kein neues Vertrauensverhältnis, keine
  neue Verteilung.

auth-svc stellt das Ticket also aus, über eine schmale interne Route. Es
erfindet dabei nichts: chat-gateway liefert die Werte, auth-svc prüft die
Form.

```
POST /internal/guest-token          (auth-svc, INTERNAL_SERVICE_SECRET)
  in : {guild_id, channel_id, gast_id, name, ttl_s}
  out: {token}
```

Claims: `typ="gast"`, `sub="gast-<snowflake>"`, `guild_id`, `channel_id`,
`name`, `jti`, `exp`. `ttl_s` ist hart auf **4 h** gedeckelt und wird vom
Aufrufer zusätzlich auf die Restlaufzeit des Links begrenzt. Die Route mintet
ausschliesslich diese Form — sie ist kein allgemeiner Token-Automat, sonst
wäre der interne Dienst-Schlüssel ein Generalschlüssel für beliebige
Identitäten.

## Datenmodell

Neue Tabelle `chat.guest_links` (chat-gateway, eigene Migration):

| Spalte | Typ | Anmerkung |
|---|---|---|
| `id` | Snowflake-PK | |
| `guild_id`, `channel_id` | BIGINT | Kanal muss ein Sprachkanal sein |
| `code_hash` | TEXT, unique | SHA-256 des Codes. **Der Code selbst steht nie in der Datenbank** — wer sie liest, kommt damit nicht in die Besprechung. Vorbild: `_token_redis_key` in `session_tokens.py`. |
| `created_by` | BIGINT | Nutzer-ID des Erzeugers |
| `expires_at` | TIMESTAMPTZ | Vorgabe 24 h, wählbar |
| `revoked_at` | TIMESTAMPTZ NULL | gesetzt = entwertet |

Kein FK auf `guilds` oder `channels` (die Tabelle folgt darin
`community_invite_notifications`); das Aufräumen beim Kanal- oder
Community-Löschen macht die jeweilige Delete-Route von Hand.

Kein Zähler für die Teilnehmerzahl: das Benutzerlimit des Sprachkanals
begrenzt den Raum bereits, und zwei Zahlen für dieselbe Sache driften.

Lebende Gäste stehen in Redis, nicht in der Datenbank — derselbe Grund wie
bei den Standplatz-Geräten: eine Spalte löge nach jedem Absturz, und zwar
Richtung „ist noch da".

```
gast:<gast_id>            HASH {name, link_id, channel_id, guild_id}   TTL = exp
gast:gesperrt:<gast_id>   "1"                                          TTL = exp
gast:link:<link_id>       SET von gast_id                              TTL = exp
```

## Routen

### Verwalten (Mitglieder)

```
POST   /channels/{channel_id}/guest-links     MOVE_MEMBERS  → {id, url, expires_at}
GET    /guilds/{guild_id}/guest-links         MOVE_MEMBERS  → Liste (ohne Code)
DELETE /guest-links/{link_id}                 MOVE_MEMBERS  → entwertet + wirft raus
```

**Warum `MOVE_MEMBERS` und nicht `CREATE_INVITES`:** eine gewöhnliche
Einladung führt jemanden durch die Mitgliedschaft und damit durch das ganze
Rechtesystem; ein Gast-Link führt daran vorbei. Wer heute einladen darf, dürfte
mit `CREATE_INVITES` unbeabsichtigt mehr. `MOVE_MEMBERS` trägt bereits den
Rauswurf aus dem Sprachkanal — hereinbitten und hinauswerfen gehören zusammen.
Ein eigenes Bit wäre die sauberste Trennung, kostet aber drei synchron zu
haltende Stellen und wurde für v1 verworfen.

Der Code wird **nur in der Antwort auf das Erzeugen** ausgeliefert. Die Liste
zeigt ihn nicht — er ist danach nicht mehr rekonstruierbar (nur der Hash liegt
vor). Wer den Link verliert, erzeugt einen neuen.

Entwerten setzt `revoked_at`, liest `gast:link:<id>` und entfernt jeden
darin genannten Gast bei LiveKit — sonst wäre die Entwertung erst beim
nächsten Ticket-Ablauf spürbar.

### Beitreten (anonym)

```
GET  /gast/{code}            → {guild_name, channel_name, gueltig}
POST /gast/{code}/beitritt   → {ticket, livekit_ws_url, channel_id, guild_name, channel_name}
     body {name}
```

**Das sind die ersten unauthentifizierten Routen im chat-gateway**, und der
Dienst hat heute nur einen In-Process-Zähler pro Nutzer-ID
(`ratelimit.py`) — für anonyme Aufrufer greift der nicht. Beide Routen
brauchen deshalb eine **Redis-Bremse**, zweifach: pro IP (gegen Streuung über
viele Codes) und pro Code (gegen Erraten eines einzelnen). Der Code selbst ist
mit 128 bit Zufall nicht zu erraten; die Bremse schützt die Datenbank, nicht
den Code. Vorbild für die Zählweise: der Redis-Weg, nicht `slowapi` (das lebt
nur im auth-svc und ist ebenfalls in-process).

`GET /gast/{code}` antwortet für abgelaufene, entwertete und unbekannte Codes
**gleich** (404). Sonst verrät die Antwort, welche Codes es einmal gab.

Der Name wird auf 1–32 Zeichen begrenzt und getrimmt. Er ist **nicht
verifiziert** und wird deshalb überall als Gast markiert dargestellt (s. u.).

## Voice

`POST /gast/token` (voice-signaling) — eine **eigene** Route neben
`POST /token`, nicht ein Zweig darin:

- Kein Aufruf zum chat-gateway für Mitgliedschaft und Rechte. Statt dessen:
  `claim.channel_id` **ist** der Kanal; ein Ticket für Kanal A kann Kanal B
  nicht öffnen (Prüfung gegen den angefragten `channel_id` im Body).
- Feste Rechte, kein Resolver: `room_join`, `can_publish` mit den Quellen
  **Mikrofon und Kamera**, `can_subscribe`. Kein `screen_share`, kein
  `can_publish_data`.
- Identität `gast-<id>`, Anzeigename aus dem Claim.
- `gast:gesperrt:<id>` gesetzt → 403 (Rauswurf hält bis zum Ticket-Ablauf).
- Das Benutzerlimit des Kanals zählt den Gast mit; Mod-Bypass gilt für ihn
  nicht.

**Präsenz.** Der LiveKit-Webhook parst Identitäten heute strikt als
`user-<id>` (`user_id_from_identity`, `_IDENTITY_PREFIX`). Er akzeptiert
künftig beide Präfixe und legt Gäste als `gast-<id>` in dieselben Sets
`voice:room:channel-<cid>` (und die Kamera-Variante). Das `voice_state`-
Ereignis bekommt ein zusätzliches Feld:

```
{"channel_id": …, "user_ids": [… , "gast-17…"], "guests": {"gast-17…": {"name": "Frau Meier"}}}
```

Der Name muss mitgeliefert werden, weil die Mitglieder-Oberfläche für eine
Gast-ID nirgendwo ein Profil nachschlagen kann. voice-signaling liest ihn aus
`gast:<id>`.

**Frontend.** `userIdFromIdentity` bleibt streng auf `^user-(\d+)$` — daneben
tritt `gastIdFromIdentity`. Jede Stelle, die aus einer Präsenz-ID ein Profil
lädt (`userCache`), muss Gäste **auslassen**; sonst zeigt die Kachel still
„Unbekannt" statt des getippten Namens. Betroffen sind mindestens
`VoiceChannelView`, `MemberList`, `VoiceChannelPresence`,
`MemberActivityHeader`, `CameraTile`. Die Kachel eines Gastes trägt ein
sichtbares „Gast"-Abzeichen — der Name ist selbst getippt und darf nie wie ein
verifizierter Mitgliedsname aussehen.

## Zusehen

**LiveKit-Screenshare** fällt ohne Zutun ab: der Gast ist im selben Raum und
abonniert die Tracks der anderen.

**HQ-Übertragung.** `GET /gast/sitzung/whep` (chat-gateway) reicht das
Gast-Ticket an `GET /gast/whep` (media-svc) weiter. Beide prüfen den
Kanal-Claim gegen den angefragten Kanal, keine prüft eine Mitgliedschaft. In
media-svc teilen sich Mitglieder- und Gast-Route denselben Rumpf
(`_whep_fuer_zuschauer`) — der Zuschauer taucht dort nur als Bestandteil des
Lese-Token-Schlüssels auf, und ob dort eine Nutzer-ID oder eine Gast-Kennung
steht, ist dieser Ebene gleich.

**Woher weiss der Gast, dass übertragen wird.** Das Ereignis
`stream:events` läuft heute nur über den chat-gateway-WebSocket, den der Gast
nicht hat. Die Gastseite fragt statt dessen alle **5 s**
`GET /gast/sitzung/stream-state` ab (Gast-Ticket, liest dieselben `stream:channel:*`
aus Redis wie die Mitglieder-Route). Preis, ausdrücklich: Anfang und Ende
einer Übertragung erscheinen beim Gast bis zu 5 s verzögert. Ein schlanker
Gast-WebSocket wäre die saubere Alternative und ist der erste Kandidat, falls
sich das im Betrieb störend anfühlt.

## Rauswerfen

`POST /channels/{cid}/members/{uid}/voice-disconnect` (MOVE_MEMBERS) nimmt
zusätzlich eine Gast-ID an. Das Pfadmuster lässt heute nur Ziffern zu
(`^\d+$`) und wird auf `^(gast-)?\d+$` erweitert. Die Route entfernt den
Teilnehmer bei LiveKit und setzt `gast:gesperrt:<id>` bis zum Ticket-Ablauf.

**Bekannte Grenze, bewusst getragen:** wer denselben Link erneut öffnet, ist
formal ein neuer Gast mit neuer ID und kommt zurück. Der Rauswurf beendet eine
Sitzung, nicht den Zugang. Dagegen wirkt die Entwertung des Links — deshalb
gehören die beiden zusammen und sind beide in v1. Ein Rauswurf, der den Link
gleich mit tötet, wäre die härtere Variante; verworfen, weil er in einer
Besprechung mit mehreren Gästen alle anderen mit hinauswirft.

## Die Gastseite

Neue SPA-Route `/gast/<code>`, **ausserhalb der Anmelde-Wache** des
`app`-Layouts. Zwei Zustände:

1. **Vorraum** — Community- und Kanalname, Namensfeld, Mikrofonauswahl mit
   Pegel, Knopf „Beitreten". Bei ungültigem Code eine ruhige Endseite.
2. **Im Raum** — Sprecherkacheln (Mitglieder und Gäste), Stummschalter,
   Kamera, Auflegen, und die Videofläche für Screenshare beziehungsweise den
   HQ-Stream.

Kein WebSocket zum chat-gateway, keine Kanalliste, kein Chat, keine
Community-Navigation. Dieselbe Seite auf dem Telefon; die Knopfreihe folgt
der bestehenden Regel (einzeilig auf `< md`).

## Der gefährliche Teil

Ein Gast erscheint in **keinem** Rechte-Resolver. Er hat keine Mitgliedschaft,
keine Rolle, kein Overwrite. Fehlt auf irgendeiner Route die Typprüfung, ist
er kein Gast mehr, sondern ein Vollnutzer mit einer synthetischen ID — und
zwar auf jeder Route, die eine Nutzer-ID einfach entgegennimmt.

Deshalb, nicht verhandelbar:

1. `decode_token` (chat-gateway **und** voice-signaling **und** media-svc)
   weist `typ: "gast"` **zentral ab**. Der Standardweg bleibt geschlossen.
2. Die Gast-Routen hängen an einer **eigenen** Abhängigkeit `CurrentGast`,
   die nur `typ="gast"` akzeptiert. Es gibt nirgends ein „`CurrentUser` oder
   Gast" — das ist die Konstruktion, in der eine spätere Änderung still ein
   Loch aufreisst.
3. Genau **vier** Stellen kennen eine Gast-Abhängigkeit, je eine pro Dienst
   plus die zweite im chat-gateway: `POST /gast/token` (voice-signaling),
   `GET /gast/whep` (media-svc), `GET /gast/sitzung/whep` und
   `GET /gast/sitzung/stream-state` (chat-gateway). Die beiden
   Beitrittsrouten (`GET /gast/{code}`, `POST /gast/{code}/beitritt`) sind
   davon verschieden: sie sind **anonym**, verlangen gar kein Ticket und
   stellen es erst aus.
4. Ein Riegel-Test pro nicht-Gast-Route („Gast-Ticket → 401") als Muster in
   der Testschiene, damit eine neue Route den Riegel nicht stillschweigend
   auslässt.

Zweitwichtigste Stelle: **die Kanalbindung**. Das Ticket nennt einen Kanal,
und jede Route, die es akzeptiert, vergleicht ihn gegen den angefragten. Ohne
diesen Vergleich wird aus einem Ticket für den Besprechungsraum ein Ticket für
jeden Sprachkanal der Community.

## Tests

**pytest** (chat-gateway, voice-signaling, media-svc, auth-svc) — gebaut in
`test_gast_links.py`, `test_gast_token.py`, `test_gast_whep.py`,
`test_gast_ticket.py` und zwei Ergänzungen in `test_webhook.py`:
- Link-Lebenslauf: erzeugen, benutzen, abgelaufen, entwertet, unbekannter Code
  — die letzten drei mit identischer Antwort.
- Ticket-Form: auth-svc deckelt `ttl_s`; ein Aufruf ohne internes Geheimnis
  scheitert.
- Kanalbindung: Ticket für Kanal A gegen `POST /voice/token` mit Kanal B → 403.
- Rechte im Grant: kein `screen_share`, kein `can_publish_data`.
- Rauswurf-Sperre: nach `voice-disconnect` liefert dasselbe Ticket 403.
- Entwertung wirft lebende Gäste (Aufruf an LiveKit gemockt).
- Riegel: ein Gast-Ticket gegen `GET /guilds`, `POST /messages`,
  `GET /channels/{id}/messages`, `POST /channels/{id}/stream-token` → je 401.
- Präsenz: `voice_state` trägt den Gastnamen; ein Gast ohne
  `gast:<id>`-Eintrag fällt sauber auf die Identität zurück statt zu werfen.

**E2E** (Playwright): `/gast/<code>` ist ohne Anmeldung erreichbar, ein
ungültiger Code zeigt die Endseite, ein gültiger führt bis zur
Verbindungsanfrage (LiveKit läuft im Testaufbau nicht — weiter kommt der Test
nicht, und das gehört so benannt).

**Von Hand, nicht automatisierbar:** zwei Geräte, ein Mitglied und ein Gast,
Sprache in beide Richtungen, HQ-Übertragung ansehen, Rauswurf, Entwertung
während laufender Besprechung.

## Berührte Stellen

- `services/auth/` — interne Mint-Route, Riegel in `security.py`.
- `services/chat-gateway/` — Modell + Migration, Verwaltungsrouten, anonyme
  Beitrittsrouten mit Redis-Bremse, `CurrentGast`, `whep`-Zweig,
  `gast/stream-state`, Aufräumen beim Kanal-/Community-Löschen.
- `services/voice-signaling/` — Gast-Zweig in `token.py`, Identitätspräfix in
  `webhook.py`, Gastnamen im `voice_state`, Pfadmuster in
  `voice_disconnect.py`.
- `services/media-svc/` — `typ: "gast"` beim Read-Token.
- `web/` — Route `/gast/<code>` samt Vorraum und Raum, `gastIdFromIdentity`,
  Gast-Abzeichen und Profil-Auslassung in den fünf genannten Komponenten,
  Verwaltungsfläche für Links im Kanal-Menü.
- `web/static/changelog.json` — Eintrag, sobald die Funktion sichtbar wird.

---

## Bughunt 2026-09-04 (nach der Umsetzung)

Sechs Befunde, alle behoben. Zwei davon hätte kein bestehender Test gefunden:

1. **Ein rausgeworfener Gast konnte weiterschauen.** Das WHEP-Lese-Token hängt
   an Kanal und Streamer, nicht am Zuschauer, und der auth-hook nimmt es die
   volle Stunde lang an, ohne es zu verbrauchen — er sieht keine Identität. Der
   Rauswurf sperrte nur den Weg zu einer *neuen* Adresse. Dieselbe Lücke, die
   der Bughunt am 2026-08-13 beim gebannten Mitglied fand
   (`chat_gateway/stream_revoke.py`), und dieselbe Antwort: das Token aktiv
   wegnehmen. Neu in `dcc_shared/gaeste.py::lese_token_loeschen`, gerufen beim
   Rauswurf **und** bei der Link-Entwertung. Ohne Datenbank, weil das Ticket
   eines Gastes ohnehin nur einen Kanal nennt — nur deshalb kann
   voice-signaling es selbst tun.
2. **Der Gast-Link zeigte bei einer Self-Host-Community auf die Cloud.**
   `window.location.origin` ist der Ursprung der *Seite*, nicht der Server, auf
   dem die Community lebt. Wer von `howispulse.com` aus einen Self-Host
   verwaltet, verschickte einen Link, dessen Code dort gar nicht existiert —
   der Gast bekäme ein 404 ohne erkennbaren Grund. Anders als beim
   Einladungslink gibt es hier **keinen `?host=`-Umweg über die Cloud**: der
   führt durch Anmeldung und Grant, und genau die hat ein Gast nicht.
3. **Ein Ticket konnte den Link überleben.** `ticket_holen` hebt jede Laufzeit
   unter einer Minute an (auth-svc nimmt darunter nichts an) — ein Link mit
   zehn Sekunden Restlaufzeit erzeugte einen Gast, der ihn um fünfzig Sekunden
   überlebte. Der Kommentar behauptete dabei ausdrücklich das Gegenteil. Jetzt
   wird ein Link in seiner letzten Minute nicht mehr eingelöst.
4. **Der Rauswurf hatte keinen Knopf** (eigener Commit): beide Stellen, an
   denen man einen Teilnehmer anklickt, hängen an `UserProfilePopover`, und die
   steht hinter `{#if p.userId}` — ein Gast hat keine. Der Server konnte es von
   Anfang an, die Oberfläche bot es nur nirgends an.
5. **Die Gastseite blieb auf der Endseite stehen.** `gastRaum` ist ein
   Modul-Singleton und überlebt den Seitenwechsel; wer verlassen hatte und den
   Link erneut öffnete, sah weiter „Besprechung verlassen". Dazu lief die
   Stream-Abfrage nach einem Rauswurf im Fünf-Sekunden-Takt weiter und
   sammelte 403er.
6. **Karteileichen und fehlende Bremse:** Gast-Links überlebten das Löschen
   ihres Kanals und ihrer Community (kein Fremdschlüssel, wie beim
   Einladungs-Modell — das Aufräumen gehört in die Delete-Route), und das
   Erzeugen war ungebremst.

Nicht behoben, weil unverändert richtig: ein Rauswurf beendet eine Sitzung,
nicht den Zugang. Wer denselben Link erneut öffnet, ist ein neuer Gast — das
ist der Grund, warum die Entwertung danebensteht.

## Bughunt, zweite Runde (ponytail-Raster)

Vier Befunde. Die beiden ersten sind Funktionen, die es nur auf dem Papier gab:

1. **Das „Gast"-Abzeichen an der Sprecher-Kachel lief nie.** Ich hatte es in
   den Zweig gesetzt, den `VoiceParticipantTile` für Teilnehmer MIT Nutzer-ID
   rendert — für einen Gast läuft der `{:else}`-Zweig. Ein Gast sah in der
   Mitte des Sprachkanals also aus wie ein Mitglied, obwohl sein Name selbst
   getippt und von niemandem geprüft ist. Dass die Datei dafür zwei getrennte
   Zweige hat, war der Grund, aus dem der Gast dort überhaupt erscheint —
   und genau deshalb übersehen.
2. **Eine Gast-Kamera hätte niemand öffnen können.** Das CAM-Abzeichen steht
   ebenfalls nur im Mitglieder-Zweig. Erlaubt hatte ich die Kamera im Token,
   sichtbar war sie nirgends. Jetzt trägt der Gast-Zweig genau dieses eine
   Aktivitäts-Abzeichen (es hängt an der LiveKit-Identität, nicht an einem
   Profil); LIVE und PARTY bleiben weg, die brauchen Server-Präsenz.
3. **Die Vier-Stunden-Grenze stand in drei Dateien.** `dcc_shared`,
   `chat_gateway` und `auth-svc` trugen je ihre eigene `4 * 3600` — die
   Sorte Wiederholung, die beim nächsten Anfassen an zwei Stellen stimmt.
   Jetzt eine Quelle, aus der die anderen beiden importieren; die
   delegierenden Hüllen im chat-gateway sind mit weggefallen.
4. **Die Ratenbremse konnte eine IP dauerhaft aussperren.** Zähler und Frist
   sind zwei Befehle; blieb der zweite aus, lag ein fristloser Schlüssel da,
   der weiterzählte und nie ablief. `expire(..., nx=True)` holt die Frist beim
   nächsten Aufruf nach und verlängert ein laufendes Fenster nicht.

Dazu, aus der ponytail-Konvention: die drei bewussten Abkürzungen mit
bekannter Decke tragen jetzt einen `ponytail:`-Vermerk mit Decke und
Aufstiegsweg (Abfrage statt Zustellung, zweimal; Schleife statt Sammel-Aufruf
bei der Entwertung).

## Bughunt, dritte Runde

Sechs Befunde, davon zwei in der Testschiene — und der zweite war ein
Flackern, das ich selbst eingebaut hatte.

1. **Off-by-one an der Platz-Schranke.** `GET /gast/sitzung/whep` liess
   `slot` bis 99 durch, `SLOT_MAX` ist 98: Platz 99 kam durch den
   chat-gateway und holte sich in media-svc ein 422, das der Gast als
   undurchsichtigen Fehler sah. Genau die zweite Wahrheit, vor der der
   Kommentar am Mitglieder-Weg warnt — jetzt dieselbe `SlotQuery`.
2. **Bearer-Zerlegung von Hand** (`split(" ")[-1]`) neben dem vorhandenen
   `_bearer_from_header`. Die Handarbeit hätte einen Header ohne
   `Bearer`-Präfix als Token weitergereicht.
3. **Ein Knopf, der etwas Falsches behauptete:** die Kopieren-Schaltfläche
   trug „Link kopiert" — die Rückmeldung *nach* dem Klick.
4. **Ton-Elemente mit ungleichem Schlüsselpaar** (Setzen mit Rückfall auf die
   Identität, Löschen mit Rückfall auf den leeren Text). Die Karte ist ganz
   entfallen; `track.detach()` gibt seine Elemente selbst zurück.
5. **Ein Kamerawechsel mitten in der Besprechung** hätte das alte Bild
   stehen lassen: gleicher Sender, gleiche Quelle, neuer Track — der
   `{#each}`-Schlüssel trägt jetzt die Spur-Kennung.
6. **`gastStreams.fehler` wurde gesetzt und nirgends gezeigt.** Der Gast
   klickte auf „Ansehen" und sah bei einem Fehlschlag nichts.

**Testschiene**, beide Male dieselbe Fehlerklasse (feste Schlüssel auf einem
geteilten Redis, dazu ein `flushdb()`):
* `test_voice_override.py` verdrahtete `redis://localhost:6380/9` fest. Unter
  `-n` startet der Wurzel-`conftest` je Worker einen eigenen Server — fest
  verdrahtet landeten alle auf demselben und räumten einander mitten im Test
  die Schlüssel weg. Der Server kommt jetzt aus `REDIS_URL`, Datenbank 9
  bleibt (sonst leerte ein serieller Lauf die Dev-Daten).
* Meine eigenen Redis-Tests in `test_gast_token.py` benutzten feste
  Kennungen (`gast-77`) und stiessen unter `-n 8` mit sich selbst zusammen.
  Jetzt je Test eine eigene Kennung.

Nachgemessen: **acht Volllaufe unter `-n 8`**, davon die letzten sechs
durchgehend 2594 grün.

Ponytail: `gaeste.als_utc` war eine Weiterreichung mit `noqa` — die drei
Aufrufer holen die Funktion jetzt direkt aus `zeit.py`.
