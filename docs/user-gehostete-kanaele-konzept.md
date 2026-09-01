# Selbst gehostete Textkanäle — Konzept „Kanäle mit eigener Ablage"

> Status: **Konzept-Entwurf, nicht entschieden.** Stand: 2026-08-30.
> Baut auf: `docs/user-gehostete-kanaele-analyse.md` (2026-07-16, Empfehlung
> „nicht in der Reinform") und dem DM-E2EE-Branch `feat/e2e-dm-krypto`
> (Entwurf: `docs/superpowers/specs/2026-08-28-e2e-dm-design.md`).
>
> **Kein Rechtsrat.**

---

## 0. Ergebnis in einem Satz

Die Reinform bleibt tot (Browser schreibt direkt in fremde Consumer-Clouds,
Pulse-Cloud „raus"), aber **seit es den E2E-Stapel gibt, ist eine ehrliche
Variante baubar: verschlüsselte Textkanäle, deren Bytes in der Cloud-Ablage
des Kanal-Owners landen — geschrieben von einem einzigen Gerät (dem seinen),
gelesen im Echtzeitweg über Pulse wie gehabt, mit der Ablage nur als
Dauerspeicher für Verlauf.**

Die Juli-Analyse verwarf drei Wände. Zwei davon stellen sich mit E2EE anders
dar; die dritte (Prior Art) wird nicht umgangen, sondern **zur Architektur
erhoben** — sie ist der Entwurf.

---

## 1. Was sich seit der Analyse geändert hat

### Wand 1 (Technik) — hält für den Browser, weicht für die Desktop-App

Der Browse-Blocker (Nextcloud-CORS, MS-Konto pro Call, Dropbox-Token-Verbot,
GDrive-Konto-Zwang) betraf **Mitglieder, die direkt aus dem Browser in den
fremden Speicher schreiben**. Der neue Entwurf lässt genau das weg:

- **Schreiben tut nur ein Gerät: das des Owners.** Electron umgeht CORS
  (Fetch im Main-Prozess); OAuth läuft in der App, das Token verlässt das
  Gerät nicht. Damit fallen die Blocker für Nextcloud (WebDAV), Dropbox
  (App-Folder-Scope) und OneDrive (AppFolder-Scope) weg. Bei Google Drive
  reicht voraussichtlich der **`drive.file`-Scope** (nur app-erzeugte
  Dateien) — der ist nicht „restricted", also **kein CASA-Assessment**
  (nachprüfen, die Juli-Analyse bewertete nur den Vollzugriffs-Scope).
- **Mitglieder berühren den Speicher nie** im Echtzeitweg — sie laufen über
  denselben Postfach-Weg wie verschlüsselte DMs.
- **Universeller Fallback ohne jede Anbieter-API:** die
  **Sync-Ordner-Brücke**. Das Owner-Gerät schreibt in einen lokalen Ordner;
  der Sync-Client des Owners (Dropbox/Drive/OneDrive/Nextcloud-Client)
  trägt die Bytes in dessen Cloud. Genau der Mechanismus des lokalen
  Medien-Archivs (`docs/superpowers/specs/2026-07-19-lokales-medien-archiv.md`),
  nur als geteilter Kanal-Ordner. Funktioniert mit jedem Anbieter, kostet
  null API-Arbeit und null ToS-Diskussion — der Owner nutzt seinen eigenen
  Sync-Client mit seinem eigenen Konto.

### Wand 2 (Prior Art) — hält vollständig und wird zum Architekturprinzip

Die fünf Lehren sind Designvorgaben, keine Hindernisse:

| Lehre | Umsetzung hier |
|---|---|
| Fremder Speicher nie im Echtzeit-Pfad | Pulse behält Postfach + WS/Redis unverändert; die Ablage ist nur Dauerspeicher/Autorität für Verlauf |
| Genau ein Owner pro Datenraum | Das Owner-Gerät ist **alleiniger Schreiber** des Logs; ein Owner, eine Kopie, Löschen funktioniert |
| BYO als Pflicht = Onboarding-Killer | Default bleibt Pulse-Speicher; „eigene Ablage" ist Opt-in je Kanal |
| „Formal dezentral, praktisch zentral" ist unvermeidlich | ehrlich benannt, siehe Wand 3 |
| Ohne Index/Cache über dem Speicher keine Historie/Suche/Pagination | lokaler Verlauf auf jedem Gerät (Etappe C des DM-Plans) ist der Cache; die Suche ist lokal (C5-Muster); Pagination über das Manifest der Ablage |

### Wand 3 (Recht) — E2EE ändert die Lage des Owners, nicht die der Plattform

Zwei korrigierende Lesarten, beide wichtig:

1. **Das Owner-Opfer-Szenario verliert seinen Auslöser.** Der dokumentierte
   Schadenspfad läuft über **Inhalts-Scans** des Anbieters (PhotoDNA →
   NCMEC → BKA → Hausdurchsuchung, Konto-Verlust nach „Mark"). Auf einen
   Megolm-verschlüsselten Ordner greift dieser Scan ins Leere — der Anbieter
   sieht Blobs ohne Namen, ohne Typ, ohne Bild. Bleiben Restrisiken
   (Metadaten, Mengen-, Verhaltensmuster), die man nicht wegdiskutieren
   kann: Empfehlung bleibt, einen **dedizierten Ordner/App-Ordner** statt
   des persönlichen Konto-Wurzelverzeichnisses zu verwenden — ein
   Missbrauchsfall kostet dann schlimmstenfalls den Ordner/das Speicher-
   konto, nicht Mail/Fotos/Identität des Owners. Die Empfehlung der
   Juli-Analyse (Position B, dedizierter Bucket) gilt hier sinngemäß weiter.
2. **Die Plattform wird trotzdem nicht frei — und das Konzept verspricht es
   auch nicht.** Kanal-Name, Mitgliederliste, Postfach und Signalweg bleiben
   bei Pulse (zentrale Rolle, Pirate-Bay-Linie). Dieser Entwurf ist deshalb
   **bewusst nicht** als „Kanäle entschärfen" coupled mit irgendwelchen
   Restriktionen anderer Kanäle gedacht — genau diese Kopplung war der
   Bumerang (C-682/18). Die dokumentierte Motivation ist und bleibt:
   **Datenhoheit, Speicherkosten beim Owner, Selbstbestimmung der
   Community.** Nicht Haftung. (Dieser Satz steht hier, damit kein späteres
   internes Doc den anderen Eindruck erzeugt — Megaupload-Muster.)
3. Unverändert aus der Juli-Analyse: **Die Pulse Cloud verteilt keine
   Zugangs-Token zu fremdem Speicher.** Tokens leben ausschließlich auf dem
   Owner-Gerät; der Server sieht die Ablage nie.

---

## 2. Produktbild

Ein **neuer Kanal-Flavor** neben Text und privater Gruppe:

- **Verschlüsselter Kanal mit eigener Ablage.** Realtime-Chat für alle
  Mitglieder über Pulse — gefühlt exakt wie heute. Die Nachrichten landen
  zusätzlich als verschlüsseltes Log im Speicher des Kanal-Owners; dort liegt
  die Autorität für Verlauf über den lokalen Gerätespeicher hinaus.
- **Teilnahme setzt ein App-Gerät voraus** — dieselbe Regel wie bei den
  privaten Gruppen (§9 des DM-Entwurfs, Entscheidung 2026-08-29). Von Geburt
  verschlüsselt, **kein Mischbetrieb, kein Klartext-Rückfall**: die
  Koexistenz-Fehlerrunde des sechsten Bughunts ist der Grund, keine Ausnahme
  zu riskieren.
- **Rechte-Modell wie private Gruppen:** Owner verwaltet Mitglieder,
  Mitglieder können gehen. Keine Rollen, keine Overwrites — Overwrites setzen
  serverseitige Inhaltskenntnis voraus, die es hier nicht gibt. Der Kanal
  lebt technisch in der Guild, verhält sich aber wie ein geschlossener Raum.
- **Namensraum:** die bestehende MinIO-„Ablage" (Kanal-Typ `dropbox`, 2)
  behält ihren Namen; der neue Flavor heißt z. B. **„Kanal mit eigener
  Ablage"** — im Code z. B. `byo_storage` am Channel, nicht ein dritter
  Typ-Namensvetter.

Warum diese Positionierung (verschlüsselter Community-Kanal) und nicht
„einfach ein Storage-Backend am normalen Textkanal": ein normaler Textkanal
lebt davon, dass der Server die Inhalte kennt (Verlauf für Neue, Rechte-
Overwrites, Suche, Plugins, Moderation). Der Ablage-Kanal gibt all das
bewusst auf — das ist ein anderes Produkt, und es verdient eine eigene
Regel statt Fallunterscheidungen.

---

## 2a. Produktentscheidung (2026-08-31, präzisiert): Kanal-Erstellung als Instanz-Einstellung

Der Eigentümer entscheidet **pro Instanz** (Pulse-Cloud oder Self-Host), wie
die Textkanal-Erstellung funktioniert. Der Super-Admin/Operator stellt ein:

| Modus | Bedeutung |
|---|---|
| **Regulär** | Textkanäle wie heute: unverschlüsselt, auf dem Instanz-Speicher, keine Ablage nötig |
| **Nur Ablage** | Einen Textkanal erstellen kann nur, wer eine verbundene Cloud-Ablage hat — neue Kanäle sind Ablage-Kanäle (verschlüsselt, Inhalt auf dem Laufwerk des Erstellers) |

Gemeinsame Regeln in beiden Modi:

- Die Community-Owner steuern weiterhin per Rechte-System
  (`MANAGE_CHANNELS`), WER Kanäle erstellen darf.
- Im Ablage-Modus setzt das Erstellen-Recht eine **verbundene eigene Ablage**
  voraus (Kanal-Ersteller = Ablage-Owner).
- **Gelesen wird direkt vom Laufwerk des Erstellers; Pulse ist der
  Schreibweg und der Rückfall-Leseweg**, wenn das Laufwerk gerade nicht
  erreichbar ist (präzisiert 2026-09-01, Entwurf §9 — löst die ältere Aussage
  ab, Mitglieder bräuchten gar keinen Ablage-Bezug: der Leseweg führt jetzt
  über sie, nicht an ihnen vorbei).
- Bestehende Kanäle bleiben beim Modus-Wechsel **lesbar, aber nicht mehr
  beschreibbar** (`legacy_readonly`, Etappe E9) — reines „Legacy-Modus"
  ohne Schreibsperre galt bis 2026-08-31 und ist überholt. Die Einstellung
  `channel_creation_policy` wirkt weiterhin nur auf die NEUANLAGE; das
  Einfrieren bestehender Kanäle ist ein eigener, zweiter Zustand am Kanal.
- Der Modus wird als Server-Capability veröffentlicht (`GET /capabilities`),
  damit die Klient-Oberfläche den Erstellen-Dialog passend anzeigt.

Das ergibt eine koexistente Übergangsrealität: eine Instanz im
Ablage-Modus hat neben eventuellen eingefrorenen Alt-Kanälen nur noch
Ablage-Kanäle. **Entschieden (2026-08-31): die Pulse-Cloud stellt ebenfalls
um** — auch auf howispulse.com sind neue Kanäle ausschließlich Ablage-Kanäle;
kein Regulär-Modus als Dauerzustand für die Cloud (löst die ältere Aussage
ab, die Cloud könne im Regulär-Modus bleiben). Self-Hoster wählen weiter
frei. Der Umstellungs-Schalter ist gebaut; auf howispulse.com wird er erst
nach ausdrücklicher Freigabe des Eigentümers umgelegt (Entwurf §9).

Der Eigentümer hat entschieden: Nach der Einführung dieses Features gibt es
**keine Pulse-gehosteten Textkanäle mehr als Neuanlage**. Jeder neue Textkanal
ist ein Ablage-Kanal:

- **Erstellen setzt eine verbundene Ablage voraus** — in erster Linie das
  Laufwerk des Erstellers. Die Community-Owner steuern per bestehendem
  Rechte-System (`MANAGE_CHANNELS`), WER Kanäle erstellen darf; wer das Recht
  hat, braucht ein verbundenes Laufwerk (seine eigene Ablage) und erstellt
  damit KANÄLE AUF SEINEM LAUFWERK.
- **Teilnehmen braucht keine eigene Ablage, aber der Leseweg führt über das
  Laufwerk des Erstellers** (präzisiert 2026-09-01, Entwurf §9): Mitglieder
  lesen direkt von dort; Pulse bleibt der Schreibweg (verschlüsselt) und der
  Rückfall-Leseweg, wenn das Laufwerk gerade nicht erreichbar ist. Das löst
  die ältere Aussage ab, Inhalte kämen ausschließlich über Pulse ohne jeden
  Laufwerk-Bezug — Details zum Leseweg: Entwurf §4.
- **Das ändert die Priorität der UI:** Der Ablage-Verbindungs-Assistent
  (Laufwerk wählen → Zustimmen → fertig) wird zum Voraussetzungsschritt für
  die Kanal-Erstellung — nicht zum optionalen Zusatz.

Konsequenzen, ehrlich benannt:

| Entfällt gegenüber heutigen Kanälen | Ersetzt durch |
|---|---|
| Serverseitige Suche | lokale Suche (Etappen-C5-Muster) |
| Moderations-Einsicht in Inhalte | Meldeweg bleibt; Inhalte sind auch für Admins nicht lesbar |
| Plugins mit Inhalts-Zugriff | plugins wirken auf Metadaten/Ereignisse |
| Dauerhafte Historie ohne Owner | Festigung hängt am Owner-Gerät; Verfall/Grabstein bei Geraete-Verfall |
| Serverseitige Bearbeitungshistorie | Bearbeitung fährt im Log mit (letzte Fassung gewinnt) |

Bleibt unberührt: Rechte- und Rollensystem (Zugriff, nicht Inhalt), Realtime,
Anwesenheit, Voice/Streaming, Reaktionen (serverseitig als Zählwerk je
Nachrichten-Id ohne Inhalt möglich), Meldeweg.

**Entschieden (2026-08-31, Entwurf §9):** BESTEHENDE Klartext-Kanäle bleiben
nach der Umstellung lesbar, aber nicht mehr beschreibbar
(`legacy_readonly`, Etappe E9) — kein Migrationswerkzeug in dieser Etappe.
Der Server weist einen Schreibversuch mit einer begründenden Meldung ab statt
mit einem nackten 403/WS-Fehler.

---

## 3. Architektur

### 3.1 Rollen und Wege

```
                    Echtzeitweg (wie DMs heute)
  Mitglied A ── verschlüsselte Nutzlast ──▶ Pulse-Postfach ──▶ Geräte der Mitglieder
                    (Megolm, serverblind)      (Frist)             │ lokal entschlüsselt,
                                                                   │ lokaler Verlauf (C1–C5)
                                                                   ▼
                    Festigungsweg (neu)                    Chat fühlt sich an wie heute
  Owner-Gerät (Desktop, alleiniger Schreiber)
      │  nimmt Nutzlasten aus dem Postfach
      ▼
  Ablage-Log im Owner-Speicher (Nextcloud/Dropbox/GDrive/OneDrive/Sync-Ordner/S3)
      ▲
      │  Backfill/Lesen: neue Geräte & Neumitglieder, Zugang nur im Kanal verteilt
  Mitglieder-Geräte
```

- **Echtzeitweg:** unverändert aus dem DM-Entwurf (§4): Nutzlast einmal
  (Megolm — bei einer Gruppe ist sie für alle dieselbe), Zustellzeilen je
  Gerät, Quittung löscht, Frist löscht. Redis/WS-Weg derselbe.
- **Festigungsweg:** das Owner-Gerät holt die Kanal-Umschläge aus dem
  Postfach und hängt sie **append-only** an das Log in der Ablage. Erst mit
  dem Commit gilt eine Nachricht als „gefestigt" (dauerhaft); davor lebt sie
  nur realtime und im lokalen Bestand der Empfänger.

### 3.2 Ablage-Format

Ein Ordner je Kanal (Ordnername = Kanal-Id, nichtssagend):

```
/kanal-<id>/
├── manifest.puls      Index, verschlüsselt (Megolm-Session-Verweise,
│                      Segmentliste mit Hash + Nachrichtenzahl, Wasserzeichen)
├── seg-000123.puls    Append-only Segment: n Megolm-Frames hintereinander
├── seg-000124.puls
└── att-0192f3a1.puls  ein Anhang (PULSEARC-Bauart)
```

- **Nur Ciphertext auf dem Speicher.** Kein Dateiname, kein MIME, kein
  Absender, kein Kanalname außen. Sichtbar bleiben Zahl, Größe und Takt der
  Dateien — bei ordnerbasierter Ablage unvermeidbar (Archiv-Spec kennt
  denselben Preis).
- **Segmente:** der Owner-Gerät-Schreiber batcht Postfach-Umschläge zu
  Segmenten (~1–5 MB), hängt sie per Upload an (Consumer-Storage mag kein
  echtes Append; ein neues Segmentfile pro Batch ist die tragfähige Form),
  aktualisiert zuletzt das Manifest (Last-Writer-Wins durch den
  Ein-Schreiber kein Problem).
- **Anhänge:** das PULSEARC-Muster aus dem Medien-Archiv-Spec —
  Schlüssel-Umschlag **in der Datei**, Metadaten (Name, MIME, Maße,
  Vorschaubild) verschlüsselt im Kopf. Der Anhang wird vom sendenden
  Mitglied zunächst wie bei DMs nach MinIO hochgeladen (opaque, serverblind);
  das Owner-Gerät übernimmt die Bytes beim Festigen in die Ablage, danach
  fegt der Server-Blob mit der letzten Zustellzeile weg.
- **Manifest wiederherstellbar:** geht es verloren, baut es sich aus den
  Segmenten neu (Archiv-Spec-Muster). Dadurch ist die Ablage gegenüber
  Sync-Konflikten robust.

### 3.3 Krypto — Zuordnung zum DM-Stapel

| Baustein aus `feat/e2e-dm-krypto` | Verwendung hier |
|---|---|
| Etappe A: `pulse-krypto` (vodozemac, Olm **und** Megolm) | unverändert; der Kanal ist „eine Gruppe" |
| Etappe B: Schlüsselverzeichnis, Prekeys, Olm-Sitzungen | verteilt den Megolm-Gruppenschlüssel je Gerät |
| Etappe C: lokaler Verlauf (C1–C5) | Cache + lokale Suche; Ablage ist die Autorität darüber hinaus |
| Etappe D: Postfach (Nutzlast/Zustellzeilen, Quittung, Frist) | der Echtzeitweg; **Frist für Ablage-Kanäle großzügiger** (Empfehlung 7 Tage, einstellbar), weil sie auf das Owner-Gerät als Sammler wartet |
| Etappe E: verschlüsselte Anhänge | identisch; Ziel des Uploads ist MinIO, Ziel des Festigens die Ablage |
| Etappe F: Kopplung + Verlaufsumzug | Rettungsweg des Owners: stirbt sein Gerät, koppelt das neue an und wird Schreiber (Log holt es aus der Ablage, Schlüssel über die Kopplung) |
| Etappe G: private Gruppen (Kanalart, Schlüsselwechsel) | der Kanal **ist** ein Megolm-Raum: neuer Schlüssel bei jedem Mitgliedschafts-Wechsel, periodischer Wechsel wegen Megolms schwächerer Vorwärtssicherheit |
| Medien-Archiv (Juli-Strang, `feat/dm-attachment-e2ee`) | Ablage-Format, Warteschlange, Plattform-Weiche, „low space sichtbar melden" |

Neu gebaut werden **nur zwei Dinge**: der Schreiber (Postfach → Log-Commits)
und die Ablage-Adapter (Anbieter-APIs/Sync-Ordner). Die Krypto ist vollständig
wiederverwendet.

### 3.4 Neumitglieder und Verlauf

- **Default: Verlauf ab Beitritt.** Mitgliedschaftswechsel dreht ohnehin den
  Gruppenschlüssel; wer neu ist, hatte den alten nie. Das ist bei privaten
  Gruppen schon die Regel und muss in der Oberfläche erklärt werden.
- **Optional: „Rückblick freigeben".** Der Owner-Gerät kann gespeicherte
  Megolm-Session-Keys (vodozemac export/import) per Olm an ein neues Gerät
  retro-verteilen. Explizite Owner-Entscheidung, pro Kanal — nicht der
  Default, weil er die Vorwärtssicherheit des Kanals aushebelt.
- **Backfill eines Geräts:** bevorzugt aus der Ablage (Manifest → Segmente
  → lokale Entschlüsselung). Der Ablage-Zugang (Read-Share-Link samt
  Passwort beim Nextcloud/Dropbox/GDrive-Weg) wird **im Kanal selbst**
  verschlüsselt bekannt gemacht — der Server sieht ihn nie. Ohne Ablage-
  Zugang greift der Umzug aus einem anderen Mitgliedsgerät (Etappe-F-Muster).

### 3.5 Löschen, Moderation, Ende des Kanals

- Der Owner kann das Log **löschen** (Ordner weg = Verlauf weg); Mitglieder
  behalten ihre lokalen Kopien — wie bei WhatsApp. „Ein Owner, eine Kopie"
  bleibt wahr: die **geteilte** Autorität ist löschbar.
- Pulse kann die zentralen Anteile entziehen (Kanal aus dem Verzeichnis,
  Mitglieder-Zugang, Postfach stoppen) und behält den Melde-Weg — aber
  **Moderation von Inhalten endet** (§8 des DM-Entwurfs, dieselbe Folge).
- Kanal-Ende: „Ablage lösen" exportiert dem Owner sein Log zusätzlich als
  Tar nach oben; danach ist der Kanal ein normaler verschlüsselter Raum auf
  Pulse-Speicher — oder ganz weg.

---

## 4. Anbieter-Matrix (Schreib-/Leseadapter)

| Ziel | Weg | Bemerkung |
|---|---|---|
| **Nextcloud** | WebDAV aus der Desktop-App (Main-Prozess, kein CORS-Problem) | bester Fall; App-Passwort, Token bleibt lokal |
| **Dropbox** | OAuth in der Desktop-App, App-Folder-Scope | ToS §2.6(c) unberührt: Mitglieder bekommen nie ein Token |
| **Google Drive** | OAuth, `drive.file` (nur app-erzeugte Dateien) | voraussichtlich kein CASA (nicht „restricted") — **vor Umsetzung nachprüfen** |
| **OneDrive** | OAuth, `Files.ReadWrite.AppFolder` | Token bleibt lokal; Change-Detection brauchen wir nicht (wir wissen, was wir schreiben) |
| **Sync-Ordner** (universell) | lokaler Ordner + Sync-Client des Owners | null API, null ToS; funktioniert für jeden Anbieter inkl. solcher ohne brauchbare API; der erste Adapter |
| **S3-kompatibel** (optional) | direkter SigV4 aus der App | entspricht Position B der Juli-Analyse; für Hetzner/MinIO/Wasabi-Leute |
| **Mobil** | **kein direkter Ablage-Zugang** | teilnimmt komplett im Echtzeitweg; Festigung/Backfill ist Desktop-Sache — ehrlich anpreisen statt notdürftig zu verbauen |

Bau-Reihenfolge der Adapter: Sync-Ordner → Nextcloud (WebDAV ist trivial und
die Zielgruppe fragt am lautesten) → App-Folder-OAuth → S3.

---

## 5. Was dadurch nicht mehr geht (Folgen, keine Fehler)

- **Serverseitige Suche, Volltext, Plugins mit Inhalts-Hook:** endet für
  Ablage-Kanäle. Lokale Suche (C5-Muster) ersetzt sie — und ist nur so
  vollständig wie der lokale Bestand (die Kopplung Suche ↔ Speichergrenze
  ist eine Entscheidung, nicht zwei).
- **Benachrichtigungen generisch** („Neue Nachricht von …"); Entschlüsseln
  beim Öffnen, der Service Worker entschlüsselt nicht (Ratchet-Zustand).
- **Rechte-Feinsteuerung (Overwrites), Rollen-Prelude, serverseitige
  Moderation:** enden. Einfaches Modell: Owner + Mitglieder.
- **Verlauf hängt am Owner:** Speicher weg oder Owner-Gerät dauerhaft
  offline → keine Festigung, kein Backfill für Neue. Realtime läuft weiter.
  Die UI kennzeichnet ungefestigte Nachrichten („noch nicht in der Ablage").
- **Onboarding-Hürde:** Ablage-Kanal setzt App-Gerät + konfigurierten
  Speicher voraus. Deshalb Opt-in und nie Voraussetzung für anderes.

---

## 6. Etappen

### 6a. Bau-Variante 2: Speicher zuerst (angeschlagen 2026-08-30, Branch `feat/kanal-eigene-ablage`)

Die Reihenfolge ist umgedreht worden: die krypto-freie Speicher-Hälfte wird
**vor** dem DM-Stapel gebaut, die Krypto zieht später als Nutzlast-Tausch ein
(dasselbe Muster wie Etappe C des DM-Plans, die absichtlich vor der
Verschlüsselung mit lesbaren Daten steht). Was das heißt:

- **Vorab, ohne Krypto:** das Log-Format (K1 — Rahmen mit Typ-Byte von Anfang
  an, damit Megolm-Nutzlasten später ohne Formatbruch einziehen), die Adapter
  (K2 Sync-Ordner, später K5/K6), der Schreiber als Gerüst gegen den
  bestehenden Community-Kanal-Fluss (`GET /channels/{id}/messages` als Quelle
  statt später das Postfach) und der lokale Lese-Pfad. Alles in
  `web/src/lib/ablage/`, alles hinter `ABLAGE_KANAL_ENABLED` (aus).
- **Kein Produktzustand:** die Klartext-Phase wird nie ausgeliefert. Sobald
  echte Kanäle als Klartext-Log im privaten Cloud-Konto des Owners lägen,
  greift der Scan-/Haftungswall aus der Analyse (Wand 3). Der Schalter bleibt
  zu, bis der Krypto-Nachzug gelandet ist.
- **Beim Krypto-Nachzug kein reiner Payload-Tausch:** die Zustellquelle des
  Schreibers wechselt (Postfach statt `messages`), das Manifest wird
  verschlüsselt, Schlüsselrotation und Zugangsdaten-im-Kanal kommen dazu.
  Der Kanal geht von Geburt in eine Richtung — kein Mischzustand aus
  Klartext- und Megolm-Rahmen im Betrieb (Koexistenz-Lektion aus dem
  sechsten Bughunt). Falls je Klartext-Kanäle bestehen sollten: der Owner
  besitzt alle Bytes, ein „Log umschreiben" (lesen, neu verschlüsseln,
  Segmente neu schreiben, Klartext löschen) ist die Migration.

**Vorbedingung der ursprünglichen Reihenfolge:** die DM-Etappen A–D sind
gelandet, G1 (Kanalart) liefert das Rahmenmodell.

| | Etappe | Prüfbar | Hängt an |
|---|---|---|---|
| K1 | Log-Format + Manifest als Bibliothek (rein rechnerisch, importfrei testbar) | Node-Läufer | nichts |
| K2 | Sync-Ordner-Adapter (Desktop; Warteschlange/Plattform-Weiche aus dem Archiv) | Playwright (Desktop) | K1, C |
| K3 | Schreiber-Pfad: Postfach → Segment-Commits, Festigungs-Kennzeichnung, Frist-Regel | pytest, Playwright | K1/K2, D |
| K4 | Lesepfad/Backfill: Manifest-Pagination, Ablage-Zugang im Kanal verteilt, Neumitglieder | pytest, Playwright | K3 |
| K5 | WebDAV-Adapter (Nextcloud) + App-Folder-OAuth (Dropbox/OneDrive/GDrive) | manuell je Anbieter + Mock-Server | K2 |
| K6 | S3-Adapter (optional, Position B) | pytest mit MinIO | K2 |

K1+K2 sind die risikolosen Enden (analog A/C im DM-Plan); K3 ist der Kern.

---

## 7. Offene Entscheidungen (brauchen den Eigentümer)

1. **Rückblick für Neue:** nur ab Beitritt (empfohlen) oder per-Kanal-
   Schalter für die Session-Retrogabe?
2. **Stellvertreter-Schreiber:** streng ein Owner-Gerät (empfohlen fürs
   erste), oder later ein delegiertes, eng begrenztes Schreibrecht
   (möglich nur bei Nextcloud/S3/WebDAV — App-Passwort auf Unterordner)?
3. **Postfach-Frist für Ablage-Kanäle:** 7 Tage als Default (empfohlen)?
4. **Umfang des ersten Schnitts:** Nur Sync-Ordner + Nextcloud (K1–K5a) und
   den Rest später?
5. **Verhältnis zur MinIO-Ablage (Typ 2):** ist ein verschlüsselter
   Gemeinschafts-Kanal **ohne** BYO (Ablage = MinIO, Rest identisch) ein
   gewollter Nebenfund der Gleisarchitektur — oder bewusst nicht, weil
   „Community-Kanäle bleiben unverschlüsselt" (§9) eine klare Linie ist?

---

## Verwandte Dokumente

- `docs/user-gehostete-kanaele-analyse.md` — die drei Wände, Positionen A/B, Rechtsquellen
- `docs/superpowers/specs/2026-08-28-e2e-dm-design.md` — DM-E2EE-Entwurf (Postfach, Megolm, Kopplung)
- `docs/superpowers/plans/2026-08-28-e2e-dm-etappen.md` — Etappenplan
- `docs/superpowers/specs/2026-07-19-lokales-medien-archiv.md` — PULSEARC-Format, Warteschlange, Sync-Ordner-Mechanik
