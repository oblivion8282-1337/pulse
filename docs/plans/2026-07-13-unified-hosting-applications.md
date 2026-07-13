# Plan: Ein Antragssystem für Self-Hosting (VPS + App-Host zusammenlegen)

**Status:** Entschieden 2026-07-13 (User), noch nicht gebaut. · **Kontext-Gespräch:** Design-Review des
kompletten Hosting-Klick-Flows + Monetarisierungs-Absicht.

## Warum

Heute existieren **zwei parallele Antrags-/Genehmigungssysteme**, die am Ende dasselbe erzeugen
(eine `RegisteredInstance`, nur mit anderem `origin`):

| | VPS-Self-Host | App-Host (Server-App) |
|---|---|---|
| Antrag | `InstanceApplication` (`routes_instance_applications.py`), Formular im Self-Host-Tab (`SelfHostApplication.svelte`) | `AppHostApplication` (`models_app_host.py`, `routes_app_host_applications.py`), Antrag in der Client-App |
| Genehmigung | `routes_admin_instances.py` (AdminInstances-Tabs, Badge, Sofort-Benachrichtigung, roter Punkt) | `routes_admin_app_host.py` (separater Pfad, weniger ausgebaut) |
| Ergebnis | Instanz `origin='vps'` + Bootstrap-Token/Installer | Instanz `origin='app_host'` + Pairing durch die Server-App |

Die Trennung entstand als Platzhalter für „vielleicht unterschiedliche Preise". Entscheidung:
**Preise unterscheiden sich (falls überhaupt) über das `origin`-Feld, nicht über getrennte Systeme.**
Ein System = ein späterer Bezahl-Checkout, keine doppelte Pflege, keine Feature-Drift
(der VPS-Pfad hat heute schon Benachrichtigungen/roten Punkt, der App-Host-Pfad nicht).

## Monetarisierungs-Rahmen (Hintergrund der Entscheidung)

- Der Genehmigungsweg bleibt dauerhaft — der **manuelle Entscheider wird später durch die Zahlung
  ersetzt** („approved" = „bezahlt"), die Maschinerie (Instanz anlegen, Credentials, Suspend,
  Widerruf) bleibt identisch.
- Verkauft werden die **Cloud-Dienste** (Identität/Cert-Login, Relay-Subdomain, Direktpfad-Telefonbuch,
  Registry/Updates), nicht die AGPL-Software. `ALLOW_LOCAL_ACCOUNTS` bleibt der versiegelte Escape-Hatch.
- `origin` (`vps` | `app_host`) ist der künftige **Preis-Diskriminator** (App-Host verbraucht mehr
  Cloud-Ressourcen: Relay, Telefonbuch, Fallback-Bandbreite).
- **Suspend-Semantik entschieden (User, 2026-07-13): sofort hart aus.** Zahlung endet = Instanz
  suspendiert (heutiger Mechanismus reicht). Abfederung ausschließlich VOR dem Ablauf:
  Erinnerungen an den Betreiber (z.B. 7 Tage + 1 Tag vorher) — reine Benachrichtigungslogik,
  kein Karenz-/Nur-Lesen-System.

## Weitere User-Entscheidungen 2026-07-13 (Kontext desselben Reviews)

- **Kein Relay-Fallback für App-Hosting** — Direktpfad wird der einzige Weg (Details/Konsequenzen
  im Memory `project-direct-path-webrtc`). Eigener Umbau-Block NACH dieser Zusammenlegung.
  Folge für Phase 5 unten: die Relay-Subdomain-Vergabe im Bootstrap entfällt perspektivisch.
- **Einladung aus der Server-App: nur Wegweiser** — die Server-App erklärt den Weg (Client öffnen →
  Community anlegen → Einladungslink erzeugen) und verlinkt dorthin; kein eingebauter
  Invite-Generator. Durch den Relay-Wegfall ist der Einladungslink der EINZIGE Beitrittsweg
  für App-Hosts (kein Hostname mehr zum Eintippen).
- **Übernahme-Warnung: ja** — „Server einrichten" auf einem zweiten Gerät zeigt vor dem Kapern
  der Instanz einen Bestätigungsdialog („alter Server verliert den Zugang").
- **Öffentliches Server-Verzeichnis: später als Opt-in** — vorgemerkt in `IDEAS.md` §17
  (Goldnugget 3), jetzt nicht bauen.
- **„Server hinzufügen"-Button (GuildRail unten) entfällt** — das Plus-Menü übernimmt
  (User-Vorschlag 2026-07-13). Das „Community beitreten"-Feld (`CreateGuildDialog`, Mode `join`)
  wird das Universal-Feld: es versteht heute Einladungslink/`?host=`-Link/`/c/`-Handle/nackten
  Code (`parseJoinInput`) und lernt als vierte Form die **nackte Hostadresse** (deckt den
  Exklusiv-Fall des alten Dialogs ab: Adresse + separater Code; klare Meldung „dieser Server
  verlangt eine Einladung" mit Code-Feld). Fremd-Link in irgendeinem Sektions-Plus → Link-
  Erkennung überstimmt die Sektion. `AddServerDialog`/`AddServerConfirmStep` werden gelöscht;
  Erstkontakt-Dialog (`SelfHostContactConfirmRequired`) bleibt im Join-Pfad erhalten.
  Gehört zu Block 3 (Relay-Abbau / Einladungslink-Zentrierung).
- **„Leute einladen"-Dialog bekommt den kopierbaren Link zurück** (`InviteDialog.svelte` zeigt
  heute NUR den Freunde-Picker): zweiter Abschnitt „Oder Link teilen" — erzeugt+kopiert einen
  Einladungslink (Default z.B. 7 Tage), Wiederverwendung von `createInvite`/`inviteLink()` aus
  `GuildInvitesEditor.svelte` (baut Self-Host-Form `…/invite/CODE?host=…` schon korrekt).
  Nur sichtbar mit CREATE_INVITES-Recht; Feinverwaltung (Limits/Widerruf) bleibt im
  Settings-Editor. Voraussetzung für Block 3 — nach dem Relay-Aus ist der Link der einzige
  Beitrittsweg zu App-Hosts, also muss er leicht erreichbar sein.
- **Einladung an Nicht-Freunde in-App: Einladungs-Benachrichtigung** (Entscheidung 2026-07-13,
  Variante A). DMs bleiben strikt friends-only (`routes/dms.py`, bewusstes Anti-Spam-Merkmal —
  NICHT lockern). Stattdessen: „Per Nutzername einladen" im Leute-einladen-Dialog → Empfänger
  bekommt eine strukturierte Annehmen/Ablehnen-Einladung in der Benachrichtigungs-Inbox, auf
  denselben Schienen wie Freundschaftsanfragen (rate-limitiert, respektiert Blocks, öffnet
  keinen Chat). Hauptweg fürs Link-Teilen bleibt extern (WhatsApp/Mail — Link ist normale URL).
- **Server-Liste live auffrischen:** `serversStore.hydrateFromBackend()` läuft heute nur bei
  Login/Session-Restore (`auth.svelte.ts` setUser + hydrate) — richtet der User seinen Server
  bei offener App ein, erscheint er erst nach Reload. Fix: beim `application_decided`-Ereignis
  (bzw. dem Genehmigt-Toast in `myInstanceApplications.svelte.ts`) zusätzlich
  `hydrateFromBackend()` anstoßen. Dazu: Eintrag einer genehmigten, aber noch nicht
  eingerichteten Instanz soll sich in der Leiste erklären („noch nicht eingerichtet" statt
  kommentarlos offline) — die Owner-Membership existiert ja schon ab Genehmigung.
- **App-Host löschen — heute eine Sackgasse (Befund 2026-07-13):** VPS-Instanzen haben in
  „Meine Instanzen" einen Löschen-Knopf (`DELETE /me/instances/{id}`, Soft-Delete + Sweep auf
  anderen Geräten); App-Host-Instanzen werden dort bewusst ausgeblendet UND die Server-App hat
  keinen Aufgeben-Knopf (`host:unpair`-IPC existiert, ungenutzt). Fix zweigleisig:
  (1) Server-App „Server aufgeben": Container stoppen+entfernen, Cloud-Registrierung via
  Login-Session löschen, unpair, optional lokales Datenvolumen (`pulse-host-data`) mitlöschen;
  (2) „Meine Instanzen" zeigt app_host-Zeilen wieder an (Status + Löschen, ohne VPS-Setup-UI) —
  für den Fall „Gerät kaputt/weg". Bestätigungsdialoge sagen ehrlich, was passiert (Mitglieder
  verlieren Zugang; VPS-Daten bleiben auf dem Server liegen — Hinweis auch im VPS-Dialog
  ergänzen). Fürs Bezahl-Modell zwingend: „Abo kündigen" braucht den sauberen Löschweg.
- **Verlassen vs. Löschen sauber trennen (Rechtsklick-Menü der Server-Leiste):** Der heutige
  Kontextmenü-Punkt „Server entfernen" (`leaveAndRemoveServer`, nur Nicht-Cloud) ist die
  Mitglieder-Aktion (Mitgliedschaft austragen + Eintrag von allen Geräten) — umbenennen in
  **„Server verlassen"**. Für den Betreiber (heute: nackter 403) zeigt das Menü stattdessen
  **„Server löschen…"** und öffnet den Lösch-Dialog aus „Meine Instanzen" (bzw. einen
  Wegweiser dorthin). Discord-analoge Rollentrennung: verlassen = Mitglied, löschen = Owner.
- **Test-Pflicht Link-Beitritt (nie end-zu-end getestet!):** Playwright-E2E für den Cloud-Fall
  (User A erzeugt Link im Leute-einladen-Dialog → frischer User B tritt darüber bei) + manueller
  Durchstich für den Self-Host-Fall (`?host=`-Link: Erstkontakt-Dialog → Cert-Login →
  Auto-Add des Servers → Community-Beitritt). Gate für Block 3, bevor der Link zum einzigen
  App-Host-Beitrittsweg wird.

## Ziel-Design

**Ein Antrag „Ich möchte selbst hosten"** mit einem `kind`/`origin`-Feld (`vps` | `app_host`):

1. **Datenmodell:** `InstanceApplication` bekommt `origin` (Default `vps`); `hostname` wird für
   `app_host` optional (dort vergibt das System den synthetischen `app-<id>`-Platzhalter, real
   erreichbar erst über die beim Pairing vergebene Relay-Subdomain). `AppHostApplication`-Bestand
   per Datenmigration in `instance_applications` überführen, Modell + Routen danach entfernen.
2. **Backend-Routen:** `routes_app_host_applications.py` + `routes_admin_app_host.py` in die
   bestehenden `routes_instance_applications.py` / `routes_admin_instances.py` falten. Approve
   verzweigt intern: `vps` → heutiger Pfad (Hostname, Bootstrap-Token), `app_host` →
   `provision_app_host_instance` (inkl. `self_host_enabled`, Owner-Membership). Guard
   `user_has_active_owner_instance` (max. eine aktive app_host-Instanz pro User) bleibt unverändert.
3. **User-Frontend:** Ein Formular im Self-Host-Tab mit Wahl „Auf eigenem Server (VPS, eigene Domain)"
   vs. „Zuhause mit der Server-App" — bei VPS Hostname-Feld, bei App-Host keins. Antragsliste,
   Polling, roter Punkt, Toasts (`myInstanceApplications.svelte.ts`) decken dann **beide** Arten ab.
4. **Admin-Frontend:** Ein Pending-Tab für beide Antragsarten (Badge zählt beide), Art als Spalte/Chip.
   Approve/Reject-Mechanik identisch.
5. **Server-App-Brücke (Folge-Schritt, schließt „Riss 1" aus dem Review):** Hat der eingeloggte User
   keine genehmigte app_host-Instanz, kann die Server-App den Antrag **direkt stellen** und den
   Status anzeigen („eingereicht, wartet auf Freigabe") statt des heutigen Sackgassen-Hinweistexts
   in `server.html`.
6. **Aufräumen:** tote Routen/Modelle/Frontend-Reste entfernen; `origin`-Backfill-Heuristik
   (Migration 0040) bleibt historisch unangetastet.

## Invarianten (dürfen nicht brechen)

- Bestehende genehmigte Instanzen (beide origins) funktionieren unverändert weiter
  (Pairing, Bootstrap, Memberships, Relay).
- `serverProvision.ts` der Server-App sucht weiter `status=='active' && origin=='app_host'` —
  Response-Shape von `GET /me/instances` bleibt stabil.
- Cloud-only-Gates (`_require_cloud`) und Owner-Checks (`registered_by`) bleiben auf allen
  credential-ausgebenden Endpoints.
- Nebenbefund aus dem Review gleich mitfixen: `_require_self_host_enabled` fehlt auf
  `mint_bootstrap_token`, obwohl der Docstring es verlangt (Code/Doku-Widerspruch klären —
  Gate ergänzen oder Docstring korrigieren).

## Befunde zweiter Analyse-Durchlauf (2026-07-13, gezielte Tiefenprüfung)

1. **BUG (prod, unabhängig von allen Blöcken): Konto-Löschung scheitert für Instanz-Besitzer.**
   `DELETE /me` (`routes_account.py:189`) läuft in eine FK-Verletzung → 500: `registered_instances.registered_by`
   hat KEIN `ondelete` (`models_instances.py:68-70`, Migration 0020) — Postgres-Default RESTRICT.
   `user_instance_memberships` cascaden korrekt. Fix: eigene Instanzen beim Konto-Löschen
   mitlöschen (Soft-Delete-Pfad wiederverwenden) + Vorab-Hinweis im UI („Du betreibst noch
   N Server"); Migration für `ondelete` bzw. explizites Cleanup; `test_account_delete.py`
   um den Instanz-Fall erweitern. DSGVO-relevant, zeitnah fixen.
2. **App-Host-Container bekommt im Dauerbetrieb NIE Updates:** pull nur in
   `containerBackendManager.start()`; kein Updater im Image (bewusst kein Watchtower,
   README:121), kein Pendant zum VPS-`pulse-update.timer`. Fix (Block 1): Server-App prüft
   beim App-Start + täglich im Betrieb auf neues Image → pull + recreate (kurze
   Unterbrechung), Phase im UI sichtbar.
3. **Backup deckt nur Postgres:** eingebauter s6-`backup`-Service (täglich pg_dump, Retention 7,
   `/data/backups`, Status via `GET /admin/self-host/backups`) — aber KEINE Objektspeicher-/
   Upload-Sicherung und kein Download-Knopf für den Betreiber (Gerät stirbt = Backup stirbt mit).
   Mindestens Backup-Download nachrüsten; Datei-Sicherung + Gerät-zu-Gerät-Umzug als Ausbaustufe.
   **Konsolidiert als „Deine Daten"-Bereich in der Server-App** — aber NUR mit echten Aktionen
   shippen (User-Einwand 2026-07-13: Erklär-Text allein nutzt niemandem). Mechanismus statt
   pg_dump-Kleinteiligkeit: **Voll-Volume-Export/-Import als EINE Datei**
   (`podman volume export pulse-host-data` → tar; Import als Gegenstück) — deckt Backup,
   Gerät-Umzug UND Katastrophenfall mit demselben Primitive ab, inkl. MinIO/Uploads.
   Konsistenz: Container für die Export-Dauer stoppen (UI sagt das ehrlich an).
   Bereich zeigt: belegte Größe, „Alles exportieren" + Datum des letzten Exports
   (Erinnerung bei Überfälligkeit), „Backup importieren" (Einricht-Flow auf neuem Gerät),
   Erklär-Satz nur als Überschrift; Linux-Pfad als Fußnote. **Export-Knopf + Größe → Block 1
   vorgezogen** (Export-Kommando existiert in der Runtime); Import/Umzug als Folgeschritt.
   Docker-Fallback: tar via Wegwerf-Container (kein natives volume export).
   **Geräte-Umzug (besprochen 2026-07-13, User-Szenario Linux→Mac):** Export → alten Server
   stoppen → auf neuem Gerät installieren + einloggen → „Backup importieren" → „Server
   einrichten" (reset-Mint rotiert Creds = altes Gerät verliert Cloud-Zugang, Übernahme-
   Warnung greift) → starten. Mitglieder folgen automatisch übers Telefonbuch (instanz-ID-
   basiert, kein Hostname); DTLS-Fingerprint liegt in /data und zieht mit um → keine
   TOFU-Alarme. Arch-Wechsel amd64↔arm64 ok (identisches multi-arch-Image, gleiche libc) —
   im Umzugs-Test explizit verifizieren. **Split-Brain unmöglich** (nur ein gültiger
   Creds-Satz pro Instanz), ABER: die abgelöste App merkt heute nichts und zeigt „läuft"
   als Zombie → **Ablöse-Erkennung ergänzen** (Server-App validiert Creds periodisch gegen
   die Cloud; bei Ablösung Container stoppen + „Dieser Server wurde auf ein anderes Gerät
   umgezogen"). Import-Reihenfolge beachten: Import muss VOR dem ersten Start des neuen
   Containers laufen (sonst initialisiert der ein frisches Volume).
4. **Versions-Politik ist halbfertig (bewusst vertagt):** `cloud_policy_poller` (6h) schreibt
   nach Redis, aber kein Produktions-Konsument (`get_cached_policy` nur in Tests; „Phase 4"
   laut Docstring); Policy-Endpoint liefert kein `min_version`, obwohl der Poller es erwartet;
   Client-`preCheckServer` prüft gegen statische `MIN_SERVER_VERSION`-Konstante. Mit Fix 2
   sinkt die Dringlichkeit; als Später-Baustelle markiert.
5. **Geprüft, kein Handlungsbedarf:** allinone-Image ist multi-arch (amd64+arm64, QEMU,
   `allinone.yml:165` + Registry-Mirror) — Pi/Apple-Silicon gedeckt.

## Dritter Durchlauf (2026-07-13, „haben wir was vergessen")

6. **Reboot-Überleben ungelöst:** `--restart unless-stopped` greift bei rootless Podman nach
   einem Geräte-Neustart NICHT (kein Daemon; bräuchte podman-restart.service/linger), auf
   Win/Mac muss zudem die Podman-VM erst wieder hochkommen. Heim-Server bleibt nach Reboot
   tot, bis der User manuell startet. Fix Block 1: **Autostart der Server-App beim Login**
   (Linux Autostart-Desktop-Datei / Mac Login-Item / Win Startup — war Phase 4 im
   Server-App-Plan 2026-07-09, nie gebaut); App macht beim Start Zustands-Abgleich +
   Container-Hochfahren. Verhalten pro Plattform explizit testen.
   Umsetzung (besprochen 2026-07-13, Aufwand klein): Win/Mac via Electron
   `app.setLoginItemSettings()` (eine Zeile); Linux-Flatpak via Background/Autostart-Portal
   (`org.freedesktop.portal.Background`, `flags: autostart`). Schalter in der Server-App
   „Beim Anmelden automatisch starten" (Default: an). Dazu „Dauerbetrieb einrichten"-
   Checkliste im UI für die zwei Glieder außerhalb unserer Kontrolle: BIOS „power on after
   AC loss" (PC/NUC) bzw. Mac-Einstellung + automatische Anmeldung (sonst wartet der
   Autostart am Login-Screen).
7. **DS-Lite/CGNAT-Früherkennung fehlt — zweistufig lösen (präzisiert 2026-07-13):**
   Maßgeblich ist der ANSCHLUSS (Router/Provider), nicht das Antrags-Gerät — ein Antrag vom
   Handy/Büro prüft das falsche Netz. Deshalb:
   **Stufe 1 (beratend), Settings → Self-Host-Tab:** im vereinten Antragsformular bei Wahl
   „Zuhause mit der Server-App" ein „Anschluss prüfen"-Schritt vor dem Absenden (STUN-Probe
   aus dem Client, Ampel grün/rot; rot = „DS-Lite/kein Direktweg — Hosting von zuhause nicht
   möglich" + VPS-Alternative nennen; Hinweis „im Netzwerk des künftigen Servers ausführen").
   Ergebnis am Antrag speichern (Admin sieht „Check bestanden").
   **Stufe 2 (verbindlich), Server-App:** dieselbe Prüfung auf dem echten Host-Gerät als
   Gate in „Server einrichten" — Abbruch mit klarer Meldung statt unerreichbarem Server.
   Später hängt der Bezahlschritt an Stufe 2 (Kauf erst nach bestandener Geräte-Prüfung).
   Der Block-1-Selbsttest nach dem Start bleibt als Dauer-Wächter (Firewall/Provider-Wechsel).
   DS-Lite (deutsche Kabelanschlüsse) ist der Massenfall.
   **Präzisierungen (User, 2026-07-13):** (a) Auf Mobilgeräten wird die App-Host-Option gar
   nicht angeboten (nur VPS-Weg + Hinweis „am Desktop einrichten") — `isMobile()`-Gate im
   Antragsformular. (b) Prüfung als **Diagnose-Bericht statt Ja/Nein**, jede Zeile mit
   Verursacher + konkreter Abhilfe: Geräte-Firewall (selbst fixbar, Anleitung pro OS) ·
   Router-Filterung (Router-Einstellung, Fritz!Box-Hinweis) · DS-Lite/kein öffentliches IPv4
   („Anbieter anrufen, Dual-Stack mit öffentlicher IPv4 anfragen" — nicht selbst fixbar) ·
   port-genaue Außen-Prüfung via Cloud-Prüfdienst (`routes_reachability`; „Voice ✓,
   Streaming-Port 8189 ✗"). Stufe 1 (Browser) kann nur grob (öffentl. Adresse/DS-Lite-
   Verdacht); der volle Bericht ist Stufe 2 (Server-App: innen Firewall-Erkennung + außen
   Port-Probe). Erwartungs-Management im UI: KEINE Router-Portfreigaben nötig (Lochung) —
   Bericht führt nie dorthin, sondern zu Geräte-Firewall oder Anbieter.
8. **Suspend-Wirkung auf LAUFENDE Server verifizieren:** Belegt ist nur Blockade von
   Bootstrap/Registry. Für „sofort hart aus" (Bezahl-Entscheidung) muss Suspend auch die
   Directory-Heartbeats/Signal-Vermittlung eines laufenden Servers abweisen (Mitglieder
   finden ihn nicht mehr) — beim Bau prüfen, sonst Papiertiger.
9. **Server-App Win/Mac-Verpackung einordnen:** Umzugs-Szenario (Linux→Mac) und Zielgruppe
   (Mac Mini) setzen die Builds voraus; heute nur Linux-Flatpak (Win-Branch
   `origin/feat/win-server-app` unfertig). Als eigener Punkt nach Block 1.
10. **Bewusste Grenze (keine Aktion):** Kein Mobile-Push für Self-Host-Inhalte bei
    geschlossener App — bekannte „Mobile-Push-Relay"-Idee (IDEAS.md §17, Cloud-Add-on,
    Monetarisierungs-Kandidat), bleibt Später-Liste.

## Phasen

1. Backend: Migration (Spalte + Datenübernahme AppHostApplication → InstanceApplication),
   Routen-Konsolidierung, pytest.
2. User-Frontend: vereintes Formular + Listen, `pnpm check`/build.
3. Admin-Frontend: vereinter Pending-Tab.
4. Server-App-Brücke (Antrag + Status aus der Server-App heraus).
5. Cleanup (alte Routen/Modelle/Components weg).

Pro Phase Commit + Mini-Review + User-Bestätigung (Phasen-Workflow). Changelog: Phasen 2–4 sind
user-facing (Stil-Vorschläge dem User vorlegen).
