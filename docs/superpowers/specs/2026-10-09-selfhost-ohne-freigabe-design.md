# Self-Host ohne Freigabe

Fassung 2 vom 2026-10-10 (Fassung 1 vom 2026-10-09, Unterschiede in
Abschnitt 9). Vom Eigentümer im Gespräch entschieden. Skizzen der Oberfläche
und des Ablaufs: https://claude.ai/artifact/RUbfNR22z4nj3KmHwRCwjA. Die
Übersicht zu Fassung 1 (https://claude.ai/artifact/5PJFE2VeBMrxLXPeeqr9Zt) ist
in den Teilen Einrichtungscode und Adresse im Ticket überholt.

## 1. Anlass

Wer heute einen eigenen Pulse-Server auf einem gemieteten Rechner (VPS)
betreiben will, stellt einen Antrag, wartet auf die Freigabe durch den
Cloud-Eigentümer, holt einen Einmal-Token und installiert damit. Der
Eigentümer will das abschaffen: Jeder lädt den Installer oder die
Compose-Datei herunter und startet einen Server. Nutzer melden sich weiter mit
ihrem Pulse-Konto an (Minecraft-Modell, `IDENTITY_CONCEPT.md`).

Die Freigabe schaltet heute vier Sperren frei:

| # | Sperre | Stelle | Fassung 2 |
|---|---|---|---|
| 1 | Image privat, Pull nur mit Instanz-Zugangsdaten | `routes_registry_auth.py`, GHCR-Paket privat | fällt (Image öffentlich, E9) |
| 2 | Startprüfung verlangt sechs Cloud-Werte | `10-check-cloud-creds.sh`, `app.py` | gelockert: Start ohne Verbindung möglich (E4) |
| 3 | Ticket nur für eingetragene Hostnamen | `routes_server_ticket.py` | bleibt; das Verbinden trägt ein (E1) |
| 4 | Admin nur über `PULSE_INSTANCE_OWNER_ID` | `session_ticket.py` | bleibt; das Verbinden setzt den Besitzer (E3) |

Der Heim-Server-Weg (Server-App, `origin = app_host`) ist seit dem 2026-09-27
freigabefrei (`POST /me/instances`) und bleibt unverändert.

## 2. Leitgedanke

Die Freigabe fällt, die **Verbindung mit einem Konto bleibt**. Ein Server
gehört von Anfang an jemandem: Am Ende der Installation verbindet der Betreiber
ihn mit seinem Pulse-Konto, im Browser, mit einem Klick. Danach hat der Server
dieselben Zugangsdaten wie heute ein freigegebener Server. Alles, was daran
hängt (Anmelde-Tickets, Admin für den Besitzer, Sperre, Sperr-Poller, Prüfung
von außen, Server-Liste im Konto), läuft unverändert weiter. Neu ist nur, wer
das Token auslöst: der Klick des Betreibers statt der Freigabe des
Cloud-Eigentümers.

## 3. Entscheidungen

**E1 — Verbinden per Gerätecode.** Ablauf nach dem Muster „Device
Authorization Grant“ (RFC 8628; so verbinden sich auch GitHub CLI und
Tailscale):

1. Der Server fragt bei der Cloud anonym einen Gerätecode für seine Adresse an
   (`POST /selfhost/verbinden/start`, Feld `hostname`). Antwort: eine geheime
   Abholkennung für den Server, ein kurzer Anzeigecode (`XXXX-XXXX`,
   Crockford-Base32), der Link zur Bestätigungsseite, Gültigkeit 15 Minuten,
   Abfrage-Abstand 5 Sekunden.
2. Der Betreiber öffnet den Link im Browser, meldet sich bei Pulse an (wie
   gewohnt, mit Zwei-Faktor-Anmeldung) und bestätigt (E5).
3. Die Cloud prüft, dass unter der Adresse wirklich dieser Server läuft (E2),
   legt den Eintrag in `auth.registered_instances` an (`registered_by` = das
   bestätigende Konto, `origin = 'vps'`, `ohne_freigabe = true`) samt
   Besitzer-Mitgliedschaft und gibt die Zugangsdaten zur Abholung frei.
4. Der Server holt sie mit seiner Abholkennung ab (`POST
   /selfhost/verbinden/abholen`). Die Antwort hat die Form von
   `BootstrapCredsOut` (`routes_selfhost_bootstrap.py`) ohne die Relay-Felder.
   Abholen geht genau einmal.

Benutzername und Passwort in die Konsole einzugeben ist ausdrücklich verworfen:
Passkeys funktionieren dort nicht, das Passwort öffnet das ganze Konto und
landete auf einem fremden Rechner, und ein Anmeldeweg für Skripte wäre eine
neue Angriffsfläche.

**E2 — Nachweis, dass der Server unter der Adresse läuft.** Vor dem Eintragen
ruft die Cloud `https://<hostname>/.well-known/pulse-verbinden` ab und
erwartet dort einen Wert, der aus der Abholkennung abgeleitet ist (SHA-256,
nicht die Kennung selbst). Nur der Server, der den Gerätecode angefragt hat,
kennt ihn. Das schließt aus, dass jemand eine fremde Adresse für sich
einträgt und sie damit blockiert, und es macht einen Besitzerwechsel einfach:
Ist die Adresse schon eingetragen, gewinnt, wer sie nachweislich gerade
betreibt. Der alte Eintrag wird dann gelöscht (Soft-Delete wie
`routes_instance_delete.py`, damit sein noch laufender Server über die
Sperrliste stehen bleibt). Bestandsserver und Heim-Server lassen sich so nicht
übernehmen, solange sie unter ihrer Adresse antworten: Sie liefern den Wert
nicht.

**E3 — Ergebnis wie ein freigegebener Server.** Nach dem Abholen hat der
Server `PULSE_INSTANCE_ID`, `PULSE_INSTANCE_OWNER_ID` (das bestätigende Konto),
`PULSE_CLOUD_CLIENT_ID`/`_SECRET`. Tickets (`aud` = Instanz-Nummer), Admin
für den Besitzer, Sperre samt Sperr-Poller und die Prüfung von außen gelten
unverändert. Der Server erscheint im Konto des Besitzers unter „Meine Server“
und in der Leiste aller seiner Geräte (`hydrateFromBackend`; die Instanz zählt
als eingerichtet, sobald die Zugangsdaten abgeholt sind).

**E4 — Start ohne Verbindung.** Pflicht für den Start ist nur
`PULSE_HOSTNAME`. `PULSE_ADMIN_EMAIL` wird optional (fehlt sie, entfällt die
`email`-Zeile im Caddyfile). Ein unverbundener Server holt sein Zertifikat,
liefert `/.well-known/pulse-verbinden` und `/.well-known/pulse-server-info`
(neues Feld `verbunden: false`), nimmt aber niemanden auf. Im Container-Log
steht einmal ein Hinweis auf `pulse-connect`. Die abgeholten Zugangsdaten
liegen im Datenvolumen (`/data/pulse/verbindung.env`, `chmod 600`);
`07-render-env.sh` liest sie, wenn die Umgebung die Werte nicht setzt. Werte aus
der Umgebung gewinnen, damit Bestandsserver und Server-App unverändert laufen.

**E5 — Bestätigungsseite im Browser.** Eigene Seite außerhalb von `/app`:
`https://howispulse.com/verbinden#XXXX-XXXX`. Der Code steht hinter `#`, damit
er in keinem Server-Protokoll landet. Ohne Anmeldung führt die Seite über die
Anmeldung zurück (Muster der gemerkten Einladung, `einladung/gemerkt.ts`).
Sie zeigt Adresse und Code und den Satz „Bestätige nur, wenn du diesen Server
gerade selbst installierst“. Ein Knopf „Verbinden“, ein Knopf „Abbrechen“.
Wer den Link nicht öffnen kann, tippt den Code auf `howispulse.com/verbinden`
ein.

**E6 — `pulse-connect` im Container.** Ein Werkzeug für alle Wege:
`docker exec -it pulse pulse-connect`. Es fragt den Gerätecode an, zeigt Link
und Code, wartet bis zu 15 Minuten, schreibt die Zugangsdaten ins Volumen,
startet die Dienste neu und meldet „Connected to <Anzeigename>. Your server now
appears in Pulse.“ Englisch, weil Betreiber aus aller Welt kommen. Der
Installer ruft es am Ende selbst auf; wer mit Compose installiert, ruft es
einmal von Hand auf (steht in der Compose-Datei und im Container-Log). Ein
erneuter Aufruf auf einem verbundenen Server fragt nach und verbindet mit
einem anderen Konto (Besitzerwechsel über E2). Der Anzeigecode wird nie
geloggt.

**E7 — Kein Kennnummern-Vorrat mehr für neue Server.** Die Cloud vergibt heute
jedem Eintrag drei Snowflake-Worker-IDs (`_allocate_worker_ids`,
`routes_admin_instances.py`). Kein Self-Host benutzt sie
(`07-render-env.sh` setzt fest 1 und 2), der Vorrat ist aber nach rund 307
Einträgen erschöpft, und gelöschte Einträge geben ihre Nummern nie zurück.
Ohne Freigabe wäre das eine harte Obergrenze. Neue Einträge bekommen deshalb
keine Worker-IDs mehr (Spalten nullable), auch neue Heim-Server.

**E8 — Grenzen.** Gerätecode 15 Minuten, einmal einlösbar. Anfragen je IP
gebremst, Bestätigen je Konto gebremst. Höchstens 10 verbundene gemietete
Server je Konto (Vorschlag, offen). Heim-Server bleibt bei einem je Konto
(offen). `self_host_enabled` wird zum Riegel „darf Server verbinden“
(Vorgabe an): Er ist der Hebel gegen ein Konto, das nach einer Sperre immer
neue Server verbindet. Der Schalter in der Nutzerliste bleibt deshalb,
umbenannt.

**E9 — Öffentliches Image unter der Organisation `oblivion-pictures`.** Das
Repo zieht nach `github.com/oblivion-pictures/pulse` (Organisation am
2026-10-10 angelegt, Plan Free). Das Self-Host-Image heißt
`ghcr.io/oblivion-pictures/pulse` und ist öffentlich (endgültig, GitHub lässt
das nicht zurücknehmen). Cloud-Images ziehen nach
`ghcr.io/oblivion-pictures/pulse-<dienst>` und bleiben privat. MediaMTX-Pins
bleiben bis zum nächsten Versionssprung auf dem alten Namensraum (sonst
Neustart des Containers, Streams reißen ab).

**E10 — Bestand bleibt unberührt.** Die drei freigegebenen VPS behalten Eintrag
und Zugangsdaten. Ihr Update-Skript meldet sich mit den Zugangsdaten bei
`registry.howispulse.com` an und hört bei einem Fehlschlag still auf zu
aktualisieren. Spiegel und Registry-Anmeldung bleiben deshalb bestehen.

**E11 — Was entfällt.** Antrag (`routes_applications.py`), Admin-Freigabe
(`routes_admin_applications.py`), `.env`-Download (`POST
/me/instances/{id}/env-file`), die Einrichtungsoberfläche für freigegebene
VPS (`InstanceSetupPanel` und Umgebung) und der Antragszähler am
Admin-Schild. Bleiben: Bootstrap-Token und `POST /selfhost/bootstrap`
(Server-App), `self_host_enabled` (E8), die Tabelle `instance_applications`
(Historie, Beschwerde-Kontakte).

## 4. Ablauf aus Sicht des Betreibers

**Gemieteter Server, mit dem Installer:**

1. Pulse: Plus → „Eigenen Server einrichten“ → „Auf einem gemieteten Server“ →
   Befehl kopieren (`curl -fsSL https://howispulse.com/install | bash`).
2. Konsole des Servers: Befehl einfügen. Der Installer fragt nach der Adresse
   und startet den Server.
3. Der Installer ruft `pulse-connect` auf: Link und Code erscheinen, die
   Konsole wartet.
4. Browser: Link öffnen, „Verbinden“ klicken.
5. Konsole: „Connected to michael. Your server now appears in Pulse.“
6. Pulse: Der Server steht in der Leiste aller Geräte. Über sein Plus legt der
   Besitzer die erste Community an.

**Gemieteter Server, mit Compose:** `.env` mit einer Zeile `PULSE_HOSTNAME=…`,
`docker compose up -d`, dann `docker exec -it pulse pulse-connect`. Weiter ab
Schritt 3.

**Heim-Server:** Pulse: Plus → „Eigenen Server einrichten“ → „Auf diesem
Rechner“ → Server-App laden → in der Server-App mit dem Pulse-Konto anmelden →
der Server erscheint in der Leiste. Unverändert gegenüber heute.

## 5. App-Oberfläche

- **Server-Knopf weg:** Der Knopf unten in der linken Leiste
  (`SelfHostRailButton`) und sein Gegenstück am Ende der Räume-Liste
  (`SelfHostRoomsButton`) entfallen.
- **Einstieg „Eigenen Server einrichten“:** im Plus-Menü jeder Server-Gruppe
  der Leiste (gleich in jedem Plus) und am Handy im Menü oben rechts in den
  Räumen. Er öffnet einen Dialog (am Handy ein Blatt von unten) mit zwei
  Wegen:
  - **„Auf diesem Rechner“:** Download der Server-App, wie `ServerAppDownload`
    heute.
  - **„Auf einem gemieteten Server“:** Installationsbefehl zum Kopieren und
    der Satz „Der Installer verbindet den Server am Ende mit deinem Konto.“
- **„Meine Server“:** Eintrag im Konto-Menü (unten links) und im Du-Bereich,
  nur sichtbar, wenn das Konto mindestens einen eigenen Server hat. Dahinter
  die Liste mit Diagnose und Löschen (heute `MyInstances`). Die Route
  `/app/server` bleibt als Ziel; der Hinweis „Verlassen geht nicht, lösche den
  Server“ führt weiter dorthin.
- **Admin-Bereich der Cloud:** Reiter „Anträge“ heißt „Server“, ohne Zähler;
  der Unterreiter „Ausstehend“ entfällt; Einträge aus E1 tragen den Vermerk
  „ohne Freigabe“; „Secret rotieren“ nur bei freigegebenen Einträgen.
  Nutzerliste: Abzeichen „Hosting“ entfällt, der Schalter heißt „Darf Server
  verbinden“ (E8).

## 6. Bestand am 2026-10-09 (Cloud-Datenbank, nur gelesen)

Fünf aktive Server: drei VPS (9, 2, 1 Mitglieder; einer von Hand per `.env`,
zwei per Installer) und zwei Heim-Server (5, 1). Keine offenen Anträge.

## 7. Nicht-Ziele

- Föderation, lokale Konten (`ALLOW_LOCAL_ACCOUNTS` bleibt, wie es ist).
- Cloud-Images öffentlich machen.
- Änderungen am Heim-Server-Weg über E7 hinaus.
- Server, die nie verbunden werden, nutzbar machen. Ein unverbundener Server
  nimmt niemanden auf.

## 8. Bewusste Lücken und Folgearbeiten

- **Nachweis braucht Port 443:** In den Proxy-Modi des Installers
  (`static-docker`, `hostproxy`) kann der fremde Proxy beim Verbinden noch
  fehlen. `pulse-connect` prüft den eigenen Nachweis vorher von außen und sagt
  in diesem Fall, was zu tun ist, statt den Gerätecode zu verbrauchen.
- **Wer den Code schneller bestätigt, wird Besitzer.** Gleiche Gefahrenklasse
  wie jeder Einmalcode. Gegenmittel: 15 Minuten Gültigkeit, Code nur in der
  Konsole, die Konsole nennt das bestätigende Konto, `pulse-connect` verbindet
  neu.
- **`stable` = `edge`** (Phasen-Policy 2026-06-10): Jeder `main`-Push erreicht
  binnen fünf Minuten jeden Server mit Auto-Update, künftig auch fremde.
- **Organisations-Sicherheit:** Wer das GitHub-Konto der Organisation
  übernimmt, erreicht jeden Auto-Updater. Zwei-Faktor-Pflicht für Mitglieder
  der Organisation einschalten (Etappe 0).

## 9. Unterschiede zu Fassung 1

Fassung 1 bestimmte den Besitzer über einen Einrichtungscode, den der Server
erzeugt und den man beim ersten Beitreten in der App eingibt. Der Eigentümer
fand das nicht intuitiv: Man installiert einen Server und muss ihn dann über
„Community beitreten“ finden, und neue Server wären nie unter „Meine Server“
erschienen, weil die Cloud ihren Besitzer nie erfahren hätte. Entfallen sind
deshalb:

- E1/E2 alt (Adresse im Ticket, Server prüft Adresse oder Nummer): Tickets
  bleiben an die Instanz-Nummer gebunden.
- E3 alt (Eintrag beim ersten Ticket für unbekannte Adressen): Eingetragen
  wird beim Verbinden.
- E5/E6 alt (Einrichtungscode, `pulse-setup-code`, `besitzer_offen`, Tabelle
  `chat.instanz_besitz`, Feld im Beitrittsdialog).
- E11 alt (Prüfung von außen entfällt für neue Server): Sie funktioniert,
  weil verbundene Server Zugangsdaten haben.

Der Plan `docs/superpowers/plans/2026-10-09-selfhost-ohne-freigabe.md` folgt
Fassung 1. Etappe 0 gilt mit dem neuen Organisationsnamen weiter, die Etappen
1 bis 5 werden nach dieser Fassung neu geschrieben.

## 10. Prüfplan

- **auth-svc:** Gerätecode anfragen, bestätigen, abholen; Ablauf nach 15
  Minuten; Abholen nur einmal; Nachweis fehlt oder falsch → kein Eintrag;
  bestehende Adresse mit gültigem Nachweis → Besitzerwechsel, alter Eintrag
  gesperrt; Bestandsserver ohne Nachweis → nicht übernehmbar; neue Einträge
  ohne Worker-IDs; Grenzen aus E8; `self_host_enabled = false` → Bestätigen
  abgelehnt.
- **Server (`infra/self-host`, chat-gateway):** Start nur mit
  `PULSE_HOSTNAME`; Nachweis-Route; `verbunden` in der Server-Info;
  `pulse-connect` schreibt die Datei und startet neu; Umgebung gewinnt vor der
  Datei.
- **Installer:** `web/test/install-*.test.ts` (Node-Läufer, im Gate).
- **App:** Bestätigungsseite mit und ohne Anmeldung (Playwright), Plus-Eintrag,
  „Meine Server“ nur mit eigenem Server.
- **Manuell:** frischer Testserver mit dem neuen Installer bis „Connected“,
  Server erscheint auf einem zweiten Gerät; Neuinstallation unter derselben
  Adresse mit anderem Konto (Besitzerwechsel); Compose-Weg; Bestandsserver
  nach dem Ausrollen (Anmeldung, Besitzer weiterhin Admin, Update läuft
  weiter).
