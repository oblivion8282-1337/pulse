# Self-Host-Identität vereinfachen: Cloud-Ticket statt Geräte-Zertifikat

Stand 2026-08-28. Entwurf, noch nicht umgesetzt.
Anlass: der Vorfall um `pulse.all3media.de` (siehe „Ausgangslage").

## Ausgangslage

Ein Betreiber konnte auf seinem eigenen Server keine Community anlegen. Die App
meldete „Verbindung zu pulse.all3media.de fehlgeschlagen. Anmeldung abgelaufen
oder Server nicht erreichbar."

Gemessen wurde: Der Server war einwandfrei. Alle zehn Glieder der
Erreichbarkeitsprüfung grün, die Instanz in der Cloud `active`, der
Betreiber-Check `{"modus_self_host":true,"owner_konfiguriert":true,
"stimmt_ueberein":true}`, das Zertifikat gültig, CORS und WebSocket-Aufstieg in
Ordnung. Die Meldung war eine Sammelmeldung, hinter der ein anderer Grund stand.

Der Grund war ein Geräte-Begriff, den es nicht gibt. Das `device_label` entsteht
im Browser als `<Browser> · <OS>` ohne Rechnernamen — Chrome, Edge, ein zweites
Profil und ein Fenster im privaten Modus tragen auf demselben Windows-Rechner
alle `Chrome · Windows`. Eine Neuausstellung zog jeden aktiven Pass mit gleichem
Label zurück. Weil `runIssueFlow` bei jeder Cloud-Anmeldung läuft und der
Idempotenz-Pfad nur bei einem **noch aktiven** Pass greift, warfen zwei Browser
sich endlos abwechselnd hinaus.

Der akute Bruch ist am 2026-08-28 getrennt behoben (Commit „ein zweiter Browser
meldete den ersten ab"). Dieses Dokument beschreibt, was danach kommt.

**Die eigentliche Lehre ist aber nicht der Geräte-Begriff, sondern dass die
Diagnose zwei Stunden brauchte, obwohl das Programm den Grund kannte.**
`certLogin` unterscheidet `cert-invalid`, `rate-limited`, `join-closed` und
`network`; `reauth()` macht daraus ein `false`. Dieselbe Fehlerklasse hat das
Projekt bei der Erreichbarkeitsprüfung schon einmal behoben — hier stand sie
noch.

## Getroffene Entscheidungen

1. **Das Versprechen bleibt.** Ein Cloud-Konto öffnet beliebig viele isolierte
   Self-Host-Server, ohne zweites Passwort und ohne gemeinsame Datenbank.
   Vereinfacht wird der Weg dorthin, nicht das Ziel.
2. **Cloud-Abhängigkeit für Neuanmeldungen ist hinnehmbar.** Fällt die Cloud
   aus, kann sich niemand neu anmelden. Bestehende Sitzungen laufen weiter
   (siehe „Sitzung auf dem Self-Host").
3. **Der Self-Host sieht die Cloud-Kennung.** Das Pseudonym (`pairwise_sub`) und
   die daraus abgeleitete synthetische Nutzer-ID entfallen. Es gibt künftig eine
   Kennung statt zweier.

### Folge von Entscheidung 3, ausdrücklich festgehalten

Ein Self-Host-Betreiber erfährt künftig, welches Cloud-Konto hinter einem Nutzer
steckt. Zwei Betreiber können ihre Nutzerlisten abgleichen und dieselbe Person
über Server hinweg wiedererkennen. Bisher war das durch das serverabhängige
Pseudonym ausgeschlossen.

Das betrifft nicht nur Betreiber, sondern deren Nutzer, und Pulse-Server laufen
auf fremden Maschinen. Die Datenschutzerklärung (`web/src/lib/legal/`) muss das
benennen, bevor der Umbau ausgeliefert wird. Diese Zeile ist Teil des Umfangs,
nicht ein Nachgedanke.

## Zielbild: drei Rollen, eine wird dumm

| | heute | künftig |
|---|---|---|
| Cloud | stellt ein Gerätezertifikat aus (1 Jahr), führt eine Sperrliste | stellt pro Anmeldung ein Serverticket aus (60 s), führt keine Geräteliste |
| Browser | hält ein Ed25519-Schlüsselpaar, signiert Challenges, rotiert Zertifikate | hält nichts Geheimes, reicht ein Ticket weiter |
| Self-Host | prüft Zertifikat, Sperrliste und Signatur über eine Nonce; gibt 5-Minuten-Token | prüft eine Cloud-Signatur; gibt eine eigene, langlebige Sitzung |

Entscheidend ist die Eigenschaft, nicht der Mechanismus: **im Browser liegt kein
Langzeitgeheimnis mehr.** Damit ist die Fehlerklasse strukturell weg — nichts
kann aus der IndexedDB verschwinden, kein Browser nimmt einem anderen etwas weg,
kein Label muss zwei Rechner auseinanderhalten.

Das Verfahren ist nicht neu: `selfhost_probe_betreiber.py` und
`routes_suspended_instances.py::broadcast_update` signieren bereits zweckgebundene
Cloud-Token, und der Self-Host prüft sie gegen die zwischengespeicherten
Cloud-JWKS (`auth:cloud_jwks:cached`). Am 2026-08-28 wurde das an einem echten
fremden Server nachgemessen.

## Datenfluss

```
1. Browser → Cloud      POST /me/server-ticket  {instance_id}
                        (mit gewöhnlichem Cloud-Access-Token)
2. Cloud → Browser      {ticket, expires_in: 60}
3. Browser → Self-Host  POST /session  {ticket}
4. Self-Host → Browser  {session_token, expires_in}
```

### Was die Cloud vor dem Ausstellen prüft

Konto aktiv und nicht gesperrt, E-Mail bestätigt, Instanz vorhanden und `active`,
Instanz nicht gesperrt. Dazu ein Ratenlimit — und zwar im auth-svc, der als einziger der beiden
Dienste einen Begrenzer führt (`routes.py::_check_rate`, ein gleitendes Fenster
mit Regeln aus den Einstellungen; `slowapi` ist zwar importiert, wird aber
bewusst nicht als Dekorator benutzt — seine Middleware macht die Testisolierung
unbrauchbar, so der Kommentar an Ort und Stelle). Der selbstgebaute Zähler im
chat-gateway (`_CERT_LOGIN_RATE_LIMIT`, rund 100 Zeilen Eimer-Verwaltung samt
Verdrängungsstrategie) entfällt damit.

Die Cloud prüft **nicht**, ob der Nutzer auf diesen Server darf. Das bleibt die
Entscheidung des Betreibers. Das Ticket sagt „das ist dieser Mensch", nicht „lass
ihn rein".

### Ticket-Inhalt

```
iss      https://howispulse.com     Aussteller (pulse_oidc_issuer)
aud      "<instanz_id>"             genau EINE Instanz
sub      "<cloud_user_id>"          rohe Cloud-Kennung (Entscheidung 3)
purpose  "server-session"           Zweckbindung wie bei owner-check
jti      <uuid4>                    für die Einmal-Einlösung
name     "<anzeigename>"
avatar   "<bildkennung>"
amr      ["pwd","otp"]              wie der Nutzer sich ausgewiesen hat
acr      "mfa"
iat/exp  exp = iat + 60
legacy_uid <int>                    NUR während der Übergangszeit, s. Migration
```

`amr`/`acr` werden unverändert aus dem heutigen Zertifikat übernommen — daran
hängt, ob ein Server für heikle Aktionen einen zweiten Faktor verlangen kann.
Ohne sie wäre diese Möglichkeit stillschweigend weg.

`pairwise_seed`, `cert_id`, `device_pubkey` und `device_label` haben keine
Entsprechung. Sie fallen weg, weil ihr Zweck entfällt.

### Was der Self-Host prüft, in dieser Reihenfolge

1. Ist diese Instanz gesperrt? (`raise_if_suspended`, unverändert)
2. Signatur gegen die Cloud-JWKS (`_get_jwks_keys`, unverändert)
3. `iss` stimmt, `aud` ist die eigene Instanz-ID, `purpose` ist `server-session`,
   `exp` nicht überschritten (60 s Uhrentoleranz wie beim Betreiber-Check)
4. `jti` in Redis einmalig beanspruchen (`SETNX`, Ablauf = Ticketlaufzeit)
5. Beitritts-Gate (vorhandene Logik aus `cert_login.py`, unverändert)
6. Bann-Gate auf dem lokalen Profil, unverändert
7. Betreiber-Erkennung: `sub == PULSE_INSTANCE_OWNER_ID`

Punkt 7 ist **derselbe Vergleich wie heute** (`cert.user_id` gegen
`PULSE_INSTANCE_OWNER_ID`) und wird sogar geradliniger, weil `sub` dieselbe Zahl
trägt, die in der `.env` steht. Die eine Stelle, an der auf einem Self-Host Admin
entsteht, bleibt die eine Stelle; der Betreiber-Check-Endpunkt vom 2026-08-27
funktioniert unverändert.

Prüfung 3 und 4 zusammen ersetzen die heutige Nonce-Signatur: Ein abgefangenes
Ticket taugt weder für einen anderen Server noch ein zweites Mal noch nach einer
Minute.

## Sitzung auf dem Self-Host

Heute gilt eine Sitzung 300 Sekunden (`SESSION_TTL_SECONDS`), erneuert durch
stillen Cert-Login alle vier Minuten je Tab. Das war die Antwort auf die
Sperrliste — ein widerrufenes Zertifikat sollte schnell wirken. Es ist zugleich
die Ursache der Wiederanmelde-Stürme und der Ratenlimit-Treffer.

**Künftig: eine Stunde, erneuert am offenen Socket.** Der Weg existiert bereits
(`ws_token_renewal.py`, angekündigt als Fähigkeit `token_refresh` im `hello`).
Fehlt der Socket, holt der Browser ein neues Ticket — dieselben vier Schritte,
kein zweiter Mechanismus.

**Ausdrücklich keine Refresh-Token auf dem Self-Host.** Die Refresh-Kette der
Cloud ist erarbeitete Feinmechanik (Ketten statt Konten, idempotentes
Nachreichen, `NACHREICH_LIMIT`, drei Log-Ereignisse zur Unterscheidung von
Diebstahl und abgerissenem Rundlauf). Sie ein zweites Mal zu bauen, wäre das
Gegenteil des Ziels — und sie wird nicht gebraucht, weil die Cloud-Sitzung die
Wurzel ist.

Eine Stunde und nicht ein Tag, weil das Bann-Gate beim Ausstellen der Sitzung
greift: Bei einem Tag käme ein gebannter Nutzer bis zu einen Tag lang weiter
durch die REST-Schnittstelle. Für die lebende Verbindung gibt es den Nachlauf
gar nicht, weil ein Bann den Socket sofort schliesst.

**Ein Stück Cloud-Unabhängigkeit kommt dabei zurück:** Die Erneuerung am Socket
läuft rein lokal, der Self-Host stellt sie mit seinem eigenen Schlüssel aus. Wer
verbunden ist, bleibt verbunden, solange sein Server läuft — unabhängig davon,
wie lange die Cloud weg ist. Das ist mehr, als Entscheidung 2 verlangt, und
kostet nichts extra.

## Löschliste

**Frontend:** `identity/keypair.svelte.ts`, `identity/cert.svelte.ts`,
`identity/cert-rotation.svelte.ts`, `identity/issue-flow.ts`,
`identity/idb-shared.ts`, `api/cert-login.ts`, die Erneuerungs-Zeitgeber aus
`api/self-host-reauth.ts`, `DeviceManagement.svelte`, `currentServerUserId()`
samt seiner 28 Aufrufstellen.

**chat-gateway:** `routes/cert_login.py` mit Challenge-Ausgabe,
Nonce-Signaturprüfung, Einmal-Einlösung und dem eigenen Ratenzähler;
`credential_validator.py`; `synthesize_self_host_user_id`;
`resolve_user_identifier`.

**auth-svc:** Zertifikats-Ausstellung und -Rotation in `routes_credentials.py`,
`credential_revocation.py`, Tabelle `revoked_credentials` samt Grabstein-Mechanik,
CRL-Endpunkt, Tabelle `issued_credentials`.

**Poller:** `crl_poller.py` verliert die Sperrlisten-Hälfte und behält das
Warmhalten der JWKS.

## Migration

### Versionsversatz diktiert die Reihenfolge

Die Web-App wird von der Cloud ausgeliefert und ist für alle sofort neu — auch
für Electron, das die deployte App remote lädt. Self-Hosts aktualisieren sich
über ihren eigenen Timer. Daraus folgt zwingend: **eine neue Web-App trifft auf
alte Server, für Wochen.**

Entschieden wird deshalb nach angekündigter Fähigkeit, nicht nach Version. Der
`hello`-Rahmen führt bereits eine `capabilities`-Liste (heute
`["token_refresh"]`). Sie nimmt `server-ticket` auf, sobald ein Server den neuen
Weg kann. Umgekehrt muss ein umgestellter Server `cert-login` weiter beantworten,
solange es Clients gibt, die es sprechen. Beide Wege koexistieren; das ist der
Preis.

### Nutzer-IDs

Bestandsserver tragen in allen Spalten die synthetische ID
(`SHA256(pairwise_sub)[:8] & 0x7FFF_FFFF_FFFF_FFFF`). Der Server kann sie nicht
zurückrechnen — die Cloud aber vorwärts, weil sie `pairwise_salt` und die
Instanz-ID hat. Deshalb trägt das Ticket in der Übergangszeit `legacy_uid`.

Beim ersten Anmelden auf dem neuen Weg schreibt der Server die Zeilen dieses
einen Nutzers in einer Transaktion um. Der genaue Umfang steht im Anhang:
**25 Spalten in 21 Tabellen**, die eine Nutzer-ID unbedingt tragen, plus **fünf
Spalten, die sie nur bedingt tragen** — abhängig von einer Nachbarspalte. Diese
Spalten sind blanke `BigInteger` **ohne Fremdschlüssel** (es gibt auf dem
Self-Host keine `users`-Tabelle); die Umschreibung ist damit eine Reihe
schlichter `UPDATE`s ohne Kaskaden und ohne Reihenfolgezwang.

**Die bedingten Spalten sind die eigentliche Gefahr**, nicht die offensichtlichen.
Eine Liste, die über Spaltennamen entsteht, findet sie nicht: `target_id`,
`subject_id` und `mention_type` heissen nicht nach einem Nutzer und sind es nur
manchmal. Dieselbe Fehlerklasse, die im Projekt schon bei Bau-Rezepten und
Lizenztexten zugeschlagen hat — was in keinem Namensmuster steht, fällt aus der
Liste und in keinem Test auf.

Zwei Sicherungen:

- **Kollisionsprüfung vor dem Schreiben.** Trägt die Ziel-ID auf diesem Server
  bereits eine andere Identität, wird abgebrochen und geloggt. Rechnerisch
  ausgeschlossen ist kein Grund, die Prüfung wegzulassen, wenn sie eine Zeile
  kostet.
- **Marke je Nutzer**, damit zwei gleichzeitige Anmeldungen desselben Kontos die
  Umschreibung nicht doppelt anstossen.

Wer nie wiederkommt, bleibt unmigriert. Unschädlich: Seine alten Nachrichten
zeigen weiter seinen Namen aus dem zwischengespeicherten Profil unter dem alten
Schlüssel.

### Drei Phasen mit einem Tor

1. **Hinzufügen.** Ticket-Endpunkt, `/session`, Fähigkeit angekündigt, App
   bevorzugt den neuen Weg. Nichts wird gelöscht, Rückfall jederzeit möglich.
2. **Wandern lassen.** Umschreibung je Nutzer bei dessen erster neuer Anmeldung.
3. **Löschen.** Erst wenn Phase 2 für die real existierenden Server abgeschlossen
   ist. `legacy_uid` fällt zuletzt.

Das Tor zwischen 2 und 3 ist eine Zahl, keine Ahnung: wie viele Instanzen zuletzt
noch über `cert-login` angemeldet haben.

## Fehlerbehandlung

**Regel: Der Grund reist von dort, wo er bekannt ist, bis dorthin, wo er
angezeigt wird.** `/session` liefert bei jeder Ablehnung einen festen Code, und
jeder Code hat einen Text mit Handgriff — nach dem Muster von
`dcc_auth/diagnose_texte.py` (Titel, was ist das, was tun; zweisprachig, an einer
Stelle).

| Code | heisst | Handgriff |
|---|---|---|
| `ticket_expired` | mehr als 60 s vergangen | nichts, wird wiederholt |
| `ticket_replayed` | `jti` schon eingelöst | dito, einmalig |
| `ticket_wrong_audience` | Ticket für einen anderen Server | Serverliste prüfen, Adresse doppelt vorhanden |
| `jwks_cold` | Server hat die Cloud nie erreicht | Server ans Netz, Ausgehend-Regel prüfen |
| `join_not_permitted` | kein gültiger Zugang | Einladung beim Betreiber erfragen |
| `banned` | auf diesem Server gesperrt | Betreiber ansprechen |
| `instance_suspended` | Instanz von der Cloud gesperrt | Cloud-Konto prüfen |

Dabei wird eine bestehende Lücke mitgeschlossen: `reasonForStatus` in
`cert-login.ts` bildet `instance_suspended` und `instance_deleted` heute gar
nicht ab — ein wirklich gesperrter Server erzeugt dieselbe nichtssagende Meldung
wie alles andere.

Die Erreichbarkeitsprüfung bekommt ein neuntes Glied: **spricht dieser Server den
Ticket-Weg schon?** Damit ist die Übergangszeit von aussen sichtbar.

## Tests

**Backend, Ausstellung:** Bindung an `aud`, Zweck, Ablauf; Verweigerung bei
gesperrtem Konto, gesperrter Instanz, unbestätigter Adresse.

**Backend, Einlösung:** falsches `aud`, falscher Zweck, abgelaufen, zweite
Einlösung desselben `jti`, kalte JWKS.

**Verhaltensgleichheit** (drei Prüfsteine): Betreiber-Admin entsteht weiter an
genau einer Stelle, Beitritts-Gate entscheidet wie bisher, Bann-Gate ebenso.

**Umschreibung:** gegen eine gesäte Alt-Datenbank, mit Prüfung **jeder einzelnen**
der 25 Spalten — eine vergessene Spalte fällt sonst erst Monate später als
verwaister Datensatz auf. Dazu ein Test, der die Kollisionssicherung auslöst.

**Frontend:** Die Entscheidung „welcher Weg" gehört in ein **importfreies** Modul,
sonst läuft sie in `pnpm test:unit` nicht (Muster: `navigation/tabs.ts`,
`stream/monitorZuordnung.ts`). Dazu ein Prüfstein, dass jeder Ablehnungscode auf
einen eigenen Text zeigt — ein Code ohne Text wäre die Sammelmeldung zurück.

**Der Test, der diesen Vorfall verhindert hätte:** zwei Browser-Kontexte, dasselbe
Konto, beide angemeldet, beide bleiben es. Mit Playwright direkt prüfbar; er wäre
vor dem 2026-08-28 rot gewesen.

Redlichkeitsvermerk: Playwright hängt in keinem Gate, und auf `main` stehen dort
drei rote Dateien. Ein E2E-Test ist so viel wert, wie jemand ihn ausführt.

## Risiken

**Die Umschreibung ist der einzige Schritt, der Bestandsdaten anfasst**, und ein
Fehler darin ist nicht zurückzunehmen. Zwei Auflagen: Sie wird gegen eine **Kopie
einer echten Self-Host-Datenbank** erprobt, nicht gegen einen Testaufbau (der hat
weder Verwaisungen noch Altlasten), und die Instanz zieht vorher eine Sicherung.

**Die Koexistenz beider Anmeldewege** verdoppelt für die Übergangszeit die Fläche,
auf der ein Fehler entstehen kann. Sie ist unvermeidbar, aber zeitlich begrenzt
und über das Tor zwischen Phase 2 und 3 kontrolliert.

**Die Datenschutz-Folge aus Entscheidung 3** ist kein technisches Risiko, sondern
eine Zusage an Nutzer, die zurückgenommen wird. Sie gehört vor der Auslieferung
in die Datenschutzerklärung.

## Nicht Teil dieses Entwurfs

- Ein Rückfallweg ohne Cloud für Neuanmeldungen (Entscheidung 2).
- Echtes OIDC mit Weiterleitung. Bewusst verworfen: derselbe Gedanke zum
  doppelten Preis, für eine Anschlussfähigkeit an Fremd-Clients, die heute
  niemand abruft. Das Ticket ist absichtlich OIDC-förmig geschnitten, damit ein
  späterer Wechsel möglich bleibt.
- Änderungen an der Cloud-eigenen Anmeldung (Passwort, Passkeys, TOTP,
  Refresh-Kette). Die bleibt unberührt.


## Anhang: die Spalten, die eine Nutzer-ID tragen

Erhoben am 2026-08-28 aus `services/chat-gateway/src/dcc_chat_gateway/models/`.
Der Umsetzungsplan erhebt sie erneut — diese Liste ist eine Momentaufnahme und
veraltet mit jeder neuen Tabelle.

### Unbedingt (25 Spalten, 21 Tabellen)

| Tabelle | Spalte | Typ |
|---|---|---|
| `admin_audit_log` | `actor_id` | BIGINT |
| `devices` | `owner_user_id` | BIGINT |
| `device_grants` | `created_by_user_id` | BIGINT |
| `user_privacy` | `user_id` | BIGINT |
| `guilds` | `owner_id` | BIGINT |
| `guild_members` | `user_id` | BIGINT |
| `guild_bans` | `user_id` | BIGINT |
| `community_invite_notifications` | `inviter_user_id` | BIGINT |
| `community_invite_notifications` | `invitee_user_id` | BIGINT |
| `instance_members` | `user_identifier` | TEXT |
| `messages` | `author_id` | BIGINT |
| `message_reactions` | `user_id` | BIGINT |
| `cached_user_profiles` | `user_identifier` | TEXT |
| `cached_user_profiles` | `synthetic_user_id` | BIGINT |
| `reports` | `reporter_user_id` | BIGINT |
| `reports` | `target_user_id` | BIGINT |
| `reports` | `resolver_user_id` | BIGINT |
| `mod_audit_log` | `actor_user_id` | BIGINT |
| `web_push_subscriptions` | `user_id` | BIGINT |
| `instance_plugin_allowlist` | `added_by_user_id` | BIGINT |
| `guild_plugins` | `enabled_by_user_id` | BIGINT |
| `guild_plugin_state` | `updated_by_user_id` | BIGINT |
| `member_roles` | `user_id` | BIGINT |
| `user_preferences` | `user_id` | BIGINT |
| `channel_voice_pulls` | `user_id` | BIGINT |

Die beiden `TEXT`-Spalten lauten heute auf das Pseudonym und werden auf die
Cloud-Kennung als Text umgeschlüsselt.

### Bedingt — nur wenn die Nachbarspalte es sagt

| Tabelle | Spalte | trägt eine Nutzer-ID, wenn |
|---|---|---|
| `permission_overwrites` | `target_id` | `target_type = 1` (0 = Rolle) |
| `message_mentions` | `target_id` | `mention_type = 0` (1 = Rolle, 2 = alle) |
| `device_grants` | `subject_id` | `subject_type` = Nutzer-Variante (`String(16)`, Wert im Plan bestätigen) |
| `mod_audit_log` | `target_id` | `target_kind` = Nutzer-Variante (`Text`, Wert im Plan bestätigen) |
| `admin_audit_log` | `target_id` | **kein Diskriminator vorhanden** — der Typ steckt implizit in `action` |

### Zwei offene Punkte für den Plan

**`admin_audit_log.target_id` hat keine Typspalte.** Es gibt keine verlässliche
Bedingung, unter der die Zeile eine Nutzer-ID trägt. Eine Umschreibung wäre hier
also entweder unvollständig oder übergriffig.

**Beide Audit-Tabellen führen ein freies `payload`-JSON**, in dem ebenfalls
Kennungen stehen können. Ein `UPDATE` sieht dort nicht hinein.

Vorschlag zur Entscheidung im Plan: **Verlaufsdaten werden nicht umgeschrieben.**
Ein Audit-Eintrag hält fest, was unter der damals gültigen Identität geschah;
ihn nachträglich umzuschreiben wäre eine Fälschung des Protokolls. Umgeschrieben
wird nur, was für den laufenden Betrieb aufgelöst werden muss. Preis: Ein
Audit-Eintrag verweist danach auf eine Kennung, die nirgends mehr auflöst — das
ist als Verhalten zu dokumentieren, nicht als Panne zu entdecken.
