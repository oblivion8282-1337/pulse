# Self-Host ohne Freigabe

Stand: 2026-10-09. Vom Eigentümer im Gespräch entschieden; die Übersicht mit
Abbildungen liegt unter https://claude.ai/artifact/5PJFE2VeBMrxLXPeeqr9Zt.

## 1. Anlass

Wer heute einen eigenen Pulse-Server (VPS) betreiben will, stellt einen Antrag,
wartet auf die Freigabe durch den Cloud-Eigentümer, holt einen Einmal-Token und
installiert damit. Der Eigentümer will das abschaffen: Jeder lädt den Installer
oder die Compose-Datei herunter und startet einen Server. Nutzer melden sich
weiter mit ihrem Pulse-Konto an (Minecraft-Modell, `IDENTITY_CONCEPT.md`).

Die Freigabe ist dabei nur der Auslöser. Sie schaltet vier Sperren frei, die
alle fallen müssen:

| # | Sperre | Stelle |
|---|---|---|
| 1 | Image privat, Pull nur mit Instanz-Zugangsdaten | `routes_registry_auth.py:117`, GHCR-Paket privat |
| 2 | Startprüfung verlangt sechs Cloud-Werte | `10-check-cloud-creds.sh:16`, `app.py:172`, `session_ticket.py:96` |
| 3 | Ticket nur für eingetragene Hostnamen | `routes_server_ticket.py:97` |
| 4 | Admin nur über `PULSE_INSTANCE_OWNER_ID` | `session_ticket.py:124` |

Der Heim-Server-Weg (Server-App, `origin = app_host`) ist seit dem 2026-09-27
schon freigabefrei (`POST /me/instances`) und bleibt unverändert.

## 2. Entscheidungen

**E1 — Ticket trägt die Adresse.** Jedes Serverticket bekommt
`aud = [str(instance_id), hostname]`. `hostname` ist die normalisierte Adresse,
die der Klient angefragt hat (`dcc_shared.hostname.normalisiere_hostname`).
Sicherheit: Der Browser fragt das Ticket für die Adresse an, die der Nutzer
eingegeben hat; ein fremder Server bekommt nur Tickets mit seiner eigenen
Adresse. Ob die Adresse echt ist, hat vorher TLS geprüft. Die Instanz-Nummer
bleibt im Ticket, damit Server mit altem Code weiter funktionieren.

**E2 — Der Server prüft Adresse ODER Nummer.** Akzeptiert wird ein Ticket, wenn
`aud` die eigene normalisierte `PULSE_HOSTNAME` oder (falls gesetzt) die eigene
`PULSE_INSTANCE_ID` enthält. Damit ist die Reihenfolge des Ausrollens egal.

**E3 — Telefonbuch-Eintrag beim ersten Ticket.** Fragt jemand ein Ticket für
eine unbekannte, gültige Adresse an, legt die Cloud einen Eintrag in
`auth.registered_instances` an: `origin = 'vps'`, `ohne_freigabe = true`,
`registered_by = NULL`, Worker-IDs `NULL`, `client_id` zufällig,
`client_secret` ein Wert, der nie verifiziert (`!kein-zugang`; `verify_password`
gibt bei ungültigem Hash `False`). Damit laufen Mitgliedschaften, Server-Liste,
Sperre und Admin-Liste unverändert weiter. Ausgenommen sind Adressen unter den
eigenen Cloud-Domains (`howispulse.com`, Relay-Basisdomain) — dort bleibt es
bei 404. Neue Einträge sind zusätzlich ratenbegrenzt (10/Stunde).

**E4 — Sperre bleibt die vorhandene Instanz-Sperre.** Ein Eintrag ohne Freigabe
lässt sich im Admin-Bereich sperren wie jeder andere; gesperrte Einträge
bekommen keine Tickets (`instance_suspended`). Bestehende Sitzungen laufen
binnen einer Stunde ab (`SITZUNGSDAUER_S`). Server ohne Instanz-Nummer kennen
den Sperr-Poller nicht; das ist hingenommen.

**E5 — Besitzer per Einrichtungscode.** Reihenfolge: `PULSE_INSTANCE_OWNER_ID`
aus der Umgebung gewinnt (Bestand, Server-App). Sonst gilt der Besitzer aus der
neuen Tabelle `chat.instanz_besitz`. Fehlt beides, erzeugt der chat-gateway
beim Start einen Code (12 Zeichen Crockford-Base32, 60 bit, Anzeige
`XXXX-XXXX-XXXX`). Der Code wird **nie geloggt** (Diagnosepakete können Logs
enthalten); der Betreiber liest ihn mit `docker exec pulse
pulse-setup-code` (englischer Name, weil Betreiber fremd sind; die App sagt
„Einrichtungscode“), der Installer zeigt ihn am Ende an. Eingelöst wird er
beim ersten Beitritt: `POST /session` nimmt ein optionales Feld
`einrichtungscode` an. Grund für diesen Ort: Ohne Besitzer gibt es keine
Community und damit keinen Weg durch das Beitritts-Gate — eine eigene
Übernahme-Route nach dem Beitritt wäre nie erreichbar. Bremse: 5 Versuche je
Konto und 20 je IP in 15 Minuten (Redis). `pulse-setup-code --reset`
setzt den Besitzer zurück und erzeugt einen neuen Code (Rettungsweg).

**E6 — Server meldet „noch kein Besitzer“.** `/.well-known/pulse-server-info`
bekommt `besitzer_offen: bool` und die Fähigkeit `einrichtungscode`. Der
Beitrittsdialog zeigt dann ein Feld für den Code.

**E7 — Start braucht nur die Adresse.** Pflicht ist allein `PULSE_HOSTNAME`.
`PULSE_ADMIN_EMAIL` wird optional (fehlt sie, entfällt die `email`-Zeile im
Caddyfile). Instanz-Nummer, Zugangsdaten und Besitzer-Nummer bleiben für
Bestandsserver und die Server-App erlaubt, aber nicht nötig.

**E8 — Öffentliches Image unter einer Organisation.** Das Repo zieht nach
`github.com/howispulse/pulse`. Das Self-Host-Image heißt
`ghcr.io/howispulse/pulse` und ist öffentlich (endgültig, GitHub lässt das
nicht zurücknehmen). Cloud-Images ziehen nach `ghcr.io/howispulse/pulse-<dienst>`
und bleiben privat. MediaMTX-Pins bleiben bis zum nächsten Versionssprung auf
dem alten Namensraum (sonst Neustart des Containers, Streams reißen ab).

**E9 — Bestand bleibt unberührt.** Die drei freigegebenen VPS behalten Eintrag
und Zugangsdaten. Grund: Ihr Update-Skript liegt auf dem Host, wird nie mit
aktualisiert, meldet sich mit den Zugangsdaten bei `registry.howispulse.com`
an und hört bei einem Fehlschlag still auf zu aktualisieren. Der Spiegel nach
`registry.howispulse.com/pulse-allinone` und die Registry-Anmeldung bleiben
deshalb bestehen.

**E10 — Was entfällt.** Antrag (`routes_applications.py`), Admin-Freigabe
(`routes_admin_applications.py`), `.env`-Download (`POST
/me/instances/{id}/env-file`) und die VPS-Einrichtungsoberfläche. Bleiben:
Bootstrap-Token und `POST /selfhost/bootstrap` (Server-App), `self_host_enabled`
(Riegel des Server-App-Wegs), die Tabelle `instance_applications` (Historie,
Beschwerde-Kontakte).

**E11 — Prüfung von außen im Installer.** Die bisherige Cloud-Diagnose braucht
Zugangsdaten und entfällt für neue Server. Ersatz: `pulse-doctor` im Container
plus ein Abruf von `https://<adresse>/.well-known/pulse-server-info` vom Host.
Das ist schwächer als die neun Glieder der Cloud-Diagnose (UDP bleibt
ungeprüft) und steht als bewusste Lücke in Abschnitt 5.

## 3. Bestand am 2026-10-09 (Cloud-Datenbank, nur gelesen)

Fünf aktive Server: drei VPS (9, 2, 1 Mitglieder; einer von Hand per `.env`,
zwei per Installer) und zwei Heim-Server (5, 1). Keine offenen Anträge.

## 4. Nicht-Ziele

- Föderation, lokale Konten (`ALLOW_LOCAL_ACCOUNTS` bleibt, wie es ist).
- Cloud-Images öffentlich machen.
- Änderungen am Heim-Server-Weg über die `aud`-Liste hinaus.
- Ein Server-App-Versionssprung: die Änderungen sind abwärtskompatibel und
  reisen mit dem nächsten regulären Sprung.

## 5. Bewusste Lücken und Folgearbeiten

- **Prüfung von außen für neue Server** (E11): eine offene Cloud-Prüfung per
  Adresse bräuchte einen Nachweis, dass der Fragende den Server betreibt
  (sonst wird die Cloud zum Scanner). Nicht Teil dieses Umbaus.
- **Sperr-Poller** wirkt nur noch auf Server mit Instanz-Nummer (E4).
- **`stable` = `edge`** (Phasen-Policy 2026-06-10): Jeder `main`-Push erreicht
  binnen fünf Minuten jeden Server mit Auto-Update, künftig auch fremde.
- **Organisations-Sicherheit**: Wer das GitHub-Konto der Organisation
  übernimmt, erreicht jeden Auto-Updater. Zwei-Faktor-Pflicht für Mitglieder
  der Organisation einschalten (Etappe 1).

## 6. Prüfplan

- Backend: pytest je Etappe (auth, chat-gateway, shared, infra/self-host).
- Installer: `web/test/install-*.test.ts` (Node-Läufer, im Gate).
- Manuell: frischer Testserver mit dem neuen Installer, Code einlösen, zweiter
  Nutzer tritt über Einladung bei; Bestandsserver nach dem Ausrollen
  (Anmeldung, Besitzer weiterhin Admin, Update läuft weiter).
