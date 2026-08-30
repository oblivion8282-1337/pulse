# Schnittanalyse: DM-Krypto-Zweig ↔ Kanäle mit eigener Ablage

> Status: **Analyse** (kein Umsetzungsplan). Stand: 2026-08-30.
> Untersucht: `origin/feat/e2e-dm-krypto` (135 Commits, Basis 45f0be8 = main ~2026-08-27)
> gegen `feat/kanal-eigene-ablage` (Ablage-Infrastruktur, Basis main) und main selbst.
> Zweck: klären, wie die zwei Stränge zusammenkommen, ohne Arbeit zu verbrennen.

---

## 1. Ist-Zustand des DM-Zweigs — „fertig vs. behauptet"

| Etappe (Spec §10) | Stand | Belege auf dem Zweig |
|---|---|---|
| A Krypto-Kern (vodozemac Olm+Megolm, WASM) | **fertig** | `krypto/pulse-krypto/**`, 17 cargo-Tests, im Gate |
| B Schlüsselverzeichnis (Prekeys, Buendel, Claim) | **fertig** | Migr. 0065, `models/geraete_schluessel.py`, `routes/schluessel.py`, 21 Server-Tests, Klient `krypto/{veroeffentlichen,pickelschluessel}.ts` |
| C Lokaler Verlauf (C1–C5) | **fertig** | `web/src/lib/verlauf/**` (17 Module), 10 Node-Testdateien, lokale Suche inkl. Merge |
| D Postfach (Nutzlast/Zustellung, Frist, Quittung) | **fertig** | Migr. 0066/0070, `models/postfach.py`, `routes/postfach*.py`, `postfach_pflege.py`, 31 Tests |
| E Verschlüsselte Anhänge | **fertig** | Migr. 0073, `postfach_anhaenge.py`, `MessageAttachment.postfach_gebunden_am` |
| F Kopplung + Verlaufsumzug | **fertig, Schalter aus** | Migr. 0074/0075, `routes/kopplung*.py`, `web/src/lib/kopplung/**` inkl. QR |
| G Private Gruppen (Kanalart + Megolm) | **fertig, Schalter aus** | Migr. 0067/0072, `models/private_gruppen.py`, `krypto/gruppe/**`, `ws_gruppen_abo.py` |
| H Android-Wecker | **fehlt** | nichts im `mobile/`-Diff |
| I Altbestand / Klartext-Löschung | **fehlt** (§3a-Entscheidung nur dokumentiert) | — |

Alles liegt hinter drei Klienten-Schaltern (`web/src/lib/krypto/schalter.ts`, alle AUS)
und dem Server-Schalter `private_groups_enabled`. Vorgabeverhalten unverändert.

**Wichtige Konstruktionsdetails für die Ablage:**
- Postfach = zwei Tabellen: `dm_nutzlasten` (Ciphertext, art 0/1/2, Base64) und
  `dm_zustellungen` (je Empfängergerät, `verfaellt_am`, Quittung = Zeilenlöschung).
  Frist: `postfach_frist_tage` (config.py, Default 30) je Einlieferung gesetzt.
- **Fächer schon gruppenfähig**: eine Megolm-Nutzlast (art 2), viele Zustellzeilen
  (`test_gruppe_eine_nutzlast_viele_zustellungen`). Kein Sonderweg für die Ablage nötig.
- Gruppenschlüssel-Verteilung läuft über Olm-Einzelsendungen
  (`krypto/gruppe/gruppenNutzlast.ts`, Marke `typ:'gruppenschluessel'`); Sitzungswechsel
  bei erkannter Mitgliederänderung (`gruppe/sitzungswahl.ts`).
- **Keine Session-Export/Import-Routine**: Schlüssel-Retrogabe für Neumitglieder ist
  explizit nicht gebaut (`krypto/pulse-krypto/src/gruppe.rs:23`) — nur pickle.

---

## 2. Ist-Zustand des Ablage-Zweigs (`feat/kanal-eigene-ablage`)

Fertig und gegen echte Server erprobt (MinIO, Nextcloud 34, Dropbox, Google Drive):
Log-Format (Rahmen mit Typ-Byte 1/2, Snowflake im Rahmenkopf), Segmente, Manifest,
Schreiber mit Segment-Splitting und Absturz-Adoption, Leser mit Prüfsummen-Lücken,
Nachzieher mit REST-Quelle (umgeht die absteigende Server-Ordnung), Nutzlast-Schema,
sechs Adapter (Sync-Ordner, WebDAV, Dropbox, OneDrive, GDrive, S3), Dev-Probe-Seite.
Alles hinter `ABLAGE_KANAL_ENABLED = false`; keine Server-Änderungen; keine Kollision
mit dem DM-Zweig (disjunkte Verzeichnisse `web/src/lib/ablage/` vs. `krypto/`, `verlauf/`).

---

## 3. Der Blocker: main hat das Vertrauensfundament des DM-Zweigs abgerissen

Seit der Merge-Basis (45f0be8) hat **main** das Gerätezertifikat-System entfernt:

- `6f7ce5d8` — Gerätezertifikat weg, Anmeldung nur noch per Ticket; löscht
  `web/src/lib/identity/{keypair.svelte,cert.svelte,cert-rotation.svelte,issue-flow}.ts`
- `cda08a66` — Zertifikats-Ausstellung, Widerruf, Sperrliste aus dem auth-Dienst entfernt
- `b987d4b5` — `credential_validator.py` auf JWKS-Rest gekürzt (kein `validate_cert` mehr)

Der DM-Zweig baut in seinem Kern genau darauf: `schluessel_nachweis.py` (Geräte-Nachweis
= Zertifikat + Ed25519-Signatur), das Buendel-Veröffentlichen, der Pickle-Schlüssel
(SHA-256 über die Gerätesignatur) und `veroeffentlichen.ts` importieren Dateien, die
auf main **nicht mehr existieren**. Ein Merge ist deshalb kein Text-Konflikt, sondern
ein **Design-Bruch**: Etappen B/D/F/G sind gebaut und getestet, aber gegen ein
Vertrauensfundament, das main abgerissen hat.

**Was das für die Ablage heißt:** Der Ablage-Kanal ist ein privater Gruppenraum mit
Dauerspeicher — er erbt dieselbe Schlüsselverzeichnis-Abhängigkeit. Ohne Klärung von
§4 läuft die Krypto-Etappe der Ablage nicht.

---

## 4. Die Entscheidung, die alles freigibt: Geräte-Identität neu verankern

Der DM-Zweig braucht von der Cloud genau eine Zusicherung: „Dieses Ed25519-Geräteschlüssel-
Bündel gehört zu diesem Konto." Früher lief das über das Zertifikat des Cert-Logins.
Zwei Wege, das zurückzubringen, ohne das alte System komplett wiederzubauen:

- **Weg A — Schlanker Geräte-Nachweis (Empfehlung):** Beim ersten Login erzeugt das
  Gerät sein Ed25519/X25519-Paar (wie heute auf dem Zweig) und registriert den
  öffentlichen Teil über eine schmale Cloud-Route, die den Pubkey **beglaubigt**
  (Signatur der Cloud über `konto_id + device_pubkey + Zweck`). Buendel-Veröffentlichung
  und Geräte-Nachweis am Gateway bleiben unverändert — nur die Herkunft der Beglaubigung
  wandert vom Login-Zertifikat zu einer Attestierungs-Route. Widerruf = Eintrag löschen
  (Geräteliste existiert im Zweig bereits). Aufwand: eine Route, ein Test, keine
  Rückdrehung der Main-Refactors.
- **Weg B — Zertifikatssystem zurückdrehen:** Das Cert-Login wiederherstellen. Beachte:
  Main hat es bewusst entfernt (Ticket-Anmeldung); eine Rückdrehung kollidiert mit der
  Ticket-Architektur und den Main-Refactors in `identity/`.

Weg A ist der kleinste gemeinsame Nenner und ändert an Etappe B/D/F/G nichts außer der
Beglaubigungsquelle. **Diese Entscheidung braucht den Eigentümer**, bevor einer der
Stränge in main landet.

---

## 5. Schnittkarte: Was die Ablage vom DM-Stapel nimmt

| Ablage-Bedarf | DM-Baustein | Lücke |
|---|---|---|
| Kanalrahmen (Mitglieder, Schlüsselwechsel) | Private Gruppen (G1/G2) | Keine — Flavor statt neuer Kanalart |
| Nachricht verschlüsseln | Megolm (`krypto/gruppe`) | Rahmen-Typ 2 im Ablage-Log ist vorbereitet |
| Schlüssel an Geräte verteilen | Olm + Schlüsselverzeichnis (B) | Weg-A-Beglaubigung (§4) |
| Echtzeit-Zustellung | Postfach (D), Fächer für Gruppen | — |
| Frist für Ablage-Kanäle | `postfach_frist_tage` | Ablage-Wert (7 Tage, einstellbar) ergänzen |
| Neuer Autor / Neumitglieder | Megolm-Sitzungswechsel (G2) | Sitzungswechsel koppeln an Schlüssel-Rotation |
| Backfill aus der Ablage | Ablage-Leser (fertig) | Ablage-Zugang nur im Kanal verteilen |
| Owner-Rettungsweg | Kopplung + Umzug (F) | — |
| Manifest verschlüsseln | `umschlag`-Muster aus pulse-krypto | offen (K-Etappe) |
| Ablage-Quelle für den Nachzieher | `NachzieherQuelle` (fertig) | REST-Quelle → Postfach-Quelle tauschen |

**Ehrliche Lücken aus dem DM-Zweig, die die Ablage ebenfalls trifft:**
Keine Megolm-Retrogabe (→ „Verlauf ab Beitritt" bleibt Default, §3.4 des Konzepts),
kein Gruppensitzungs-Aufräumen, Etappe I/§3a (Klartext-Rückfall im Sendeweg ist im
Code noch da) — die Ablage-Regel „kein Mischzustand" darf nicht davon infiziert werden.

---

## 6. Clevere Reihenfolge (Empfehlung)

1. **Sofort (unabhängig, kein Konflikt):** Weg A als schmale Attestierungs-Route im
   DM-Zweig ergänzen (statt Zertifikate zurückzudrehen). Danach ist der DM-Zweig
   wieder auf main-Kurs.
2. **Dann:** DM-Zweig mit main zusammenführen (19 textuell überlappende Dateien,
   überwiegend UI/i18n — beherrschbar, solange die identity-Löschungen auf main
   liegen bleiben).
3. **Parallel möglich (läuft schon):** Ablage-Infrastruktur ist zusammengeführt und
   integrativ getestet; die Etappen K1–K6 des Konzepts sind in ihrem krypto-freien
   Teil abgeschlossen (Sync-Ordner, WebDAV, Dropbox, OneDrive, GDrive, S3 erprobt).
4. **Nach 1+2:** Krypto-Etappe der Ablage (Konzept §6, ursprüngliche Reihenfolge):
   Kanal-Flavor auf G1-Basis, Megolm-Rahmen (Typ 2), Postfach-Quelle im Nachzieher
   (Tausch gegen `quelle.ts`), Frist-Trennung Ablage/DM, verschlüsseltes Manifest,
   UI hinter `ABLAGE_KANAL_ENABLED`.

## 7. Entscheidungen, die der Eigentümer fällen muss

1. Weg A (Attestierungs-Route, empfohlen) oder Weg B (Cert-Rückdrehung)?
2. Reihenfolge des Zusammenführens: DM-Zweig erst auf neuen main-Stand heben
   (Rebase/Merge), dann Krypto-Ablage — oder Ablage-Krypto-Zweig vom gefestigten
   DM-Zweig abzweigen?
3. Frist-Trennung: eigener Einstellwert `ablage_frist_tage` (7) neben
   `postfach_frist_tage` (30)?

---

*Quellen: Explorationsbericht 2026-08-30 über `origin/feat/e2e-dm-krypto` (Etappen,
Postfach, Schlüsselverzeichnis, Kopplung, Tests, Merge-Überlappung); Ablage-Branch
`feat/kanal-eigene-ablage` (Integrationserprobung MinIO/Nextcloud/Dropbox/GDrive).*
