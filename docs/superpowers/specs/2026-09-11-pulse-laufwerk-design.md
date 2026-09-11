# Pulse-Laufwerk — vermieteter E2E-verschlüsselter Speicher

> Status: **Spezifikation, nicht gebaut.** Stand: 2026-09-11.
> Produktentscheidung des Eigentümers vom selben Tag: Fremde Laufwerke
> (Nextcloud, Dropbox, Google Drive, OneDrive, fremdes S3) werden **nicht
> ausgeliefert** — stattdessen vermietet Pulse selbst Onlinespeicher.
> Baut auf: `2026-08-31-ablage-kanaele-design.md` (PADF-Format, §8
> Wiederherstellung), `ablage-krypto-schnittanalyse.md` (Weg A steht),
> `docs/medien-speicher-und-scanning.md` (§3b Hash-Matching im Upload-Pfad),
> `docs/managed-server-vermietung.md` (Geschäftsmodell).

---

## 0. Ergebnis in einem Satz

Das Pulse-Laufwerk ist eine ganz normale Ablage-Verbindung wie jedes andere
Laufwerk auch — nur dass hinter dem Adapter Pulse selbst steht: presigned
URLs gegen den eigenen MinIO, Kontingente als Tarife, kein Credential im
Browser, kein Festigungsgerät, und der Server sieht weiterhin nur Chiffrat.

**Warum das zusammenpasst:** Die E2EE-Entscheidung ist hier kein Kostenaufwand,
sondern das Geschäftsmodell. Pulse vermietet Chiffrat, das es nicht lesen
kann — „wir hosten deine Dateien und können sie trotzdem nicht lesen" ist
die Position, die keiner der großen Clouds hat. Der Server ist Host mit
Hoster-Pflichten; die Scan-Frage wird clientseitig gelöst (§7), sodass die
„keine Kenntnis"-Position intakt bleibt.

## 1. Was diese Entscheidung vereinfacht (Ehrlichkeitsliste)

Alles Folgende existierte **nur, weil die Laufwerke fremd waren**, und stirbt
mit dem Pivot:

| Weggefallen | Warum es nur für Fremdspeicher existierte |
|---|---|
| Geheimhaltung der Freigabe-Adresse (`ablage_kanal_laufwerke`, `ablage_guild_laufwerke`, `ablage_konto_laufwerke`) | Nur fremde Anbieter machen den Link zum Schlüssel in Textform |
| CORS-Weiterreicher Lesen (`ablage_abruf`) und Schreiben (`ablage_schreiben.py`) samt SSRF-Prüfung | Browser kann nicht in fremde Clouds; gegen MinIO mit presigned URLs entfällt das Problem ganz |
| Festigung + Festigungs-Schleife + „Der Besitzer war lange nicht online" | Es gibt keinen Owner-Maschinenpfad mehr: das presigned PUT des Mitglieds IST bereits die persistente Ablage |
| Zwischenlager + Alters-Sweep + Quittungs-Lebenszyklus | Kein Wartezimmer mehr — Speicher ist sofort Speicher |
| OAuth-Apparat (Dropbox/Google/OneDrive, Refresh, Azure-Entscheidung) | Kein fremdes Konto, kein Consent-Flow |
| Share-Link-Zerlegung (`freigabeLink.ts`) | Kein Fremdanbieter-Link mehr einzupassen |
| Verfügbarkeits-Abhängigkeit von einem einzelnen Gerät | Verfügbarkeit wird zur Aufgabe des Vermieters — das ist ja der Punkt, für den man zahlt |

## 2. Sicherheitsmodell

Unverändert gegenüber dem Ablage-Konzept, jetzt aber auf eigene Faust:

- **Verschlüsselung clientseitig, Format PADF** (`dateiablage.ts`):
  zufälliger Inhaltsschlüssel je Datei, Kopf (Name, MIME) und Verzeichnis
  unter dem Ablage-Hauptschlüssel. Auf dem Server liegen nur `.puls`-Klumpen
  mit Snowflake-Namen — keine Klartext-Metadaten, nirgends.
- **Der Server sieht:** Größen, Zeiten, Stückzahl, Uploader-Bezug, IPs,
  Chiffrat. **Er sieht nie:** Namen, Typen, Inhalte, Verzeichnis.
- **Schlüssel:** ein Ablage-Hauptschlüssel je Laufwerk, erzeugt auf dem
  ersten verbindenden Gerät, nur auf Geräten der Berechtigten gespeichert
  (Muster `syncOrdnerSchluessel.ts`); Verteilung an weitere
  Geräte/Mitglieder über den Olm/Postfach-Weg (Muster
  `kanalLaufwerkSchluessel.ts`, Weg-A-Gerätekrypto steht).
- **Wiederherstellungs-Satz ist Pflicht beim ersten Pulse-Laufwerk**
  (Konzept §8): Pulse hält die einzige Kopie des Chiffrats — ohne Satz ist
  Schlüsselverlust unwiederbringlicher als bei jedem Fremdlaufwerk. Das
  verschlüsselte Päckchen liegt im Laufwerk selbst + als undurchsichtiger
  Block auf Pulse, wie im Konzept §8 vorgesehen.

## 3. Das Pulse-Laufwerk als Verbindung

Neue Anbieterart `pulse` im Verbindungs-Store (`AblageVerbindung.anbieter`),
restlos in die bestehende Chassis-Form eingebaut:

- **Keine `konfiguration` mit Credentials.** Das unterscheidet ihn von allen
  fremden Anbietern: authentifiziert wird über die normale Pulse-Session,
  Datenwege laufen über kurzlebige presigned URLs, die die API je Bedarf
  münzt (dasselbe Muster wie `ablage_zwischenlager.py` und `attachments.py`
  heute). Verliert das Gerät die Session, verliert es nur Zugriff, nicht
  Daten.
- **Bezug wie gehabt:** `istArchiv` (persönliches Archiv) und `fuerGuild`
  (Community-Laufwerk) gelten unverändert. Damit trägt dieselbe Verbindung
  die beiden vermietbaren Produkte: Archiv-Speicher je Konto,
  Community-Speicher je Guild (kauft der Besitzer).
- **Adapter:** ein neuer `pulse`-Adapter hinter `AblageAdapter`
  (`adapter.ts`) — `schreibe`/`lese`/`liste`/`lösche` gemünzt auf
  presigned PUT/GET/DELETE. `liste` liest das Verzeichnis (§4), nicht den
  Bucket (der Klient listet den Bucket nie direkt).

## 4. Ablageorte und Verzeichnis

- **Objektschema im Bucket:** `pulse-laufwerk/{bezug}/{snowflake}.bin`
  (`bezug` = `konto-{id}` bzw. `guild-{id}`). Namen sind Snowflakes — der
  Bucket-Pfad trägt keine Information, die nicht schon die DB hat.
- **Metadaten-Zeilen serverseitig, aber namenlos:** je Objekt eine Zeile
  (storage_key, bezug, hochgeladen_von, größe, Zeit). Kein Dateiname, kein
  MIME — die liegen verschlüsselt im PADF-Kopf des Objekts selbst.
- **Verzeichnis als verschlüsselte Geräte-Scheren.** Das Konzept-Kernstück
  (Inhaltsschlüssel steckt nur im Verzeichnis) bleibt. Neu gelöst wird der
  Schreibkonflikt: statt eines einzelnen Verzeichnisobjekts schreibt JEDES
  Schreibgerät seine eigene append-only-Kette (neue Objektversion je
  Update, Server-Zeile zeigt auf die jüngste je Gerät). Leser laden alle
  Ketten des Bezugs und mergen nach Snowflake. Ein Gerät, eine Kette — kein
  Sperrfall, kein In-Place-Rewrite.
- **Kopf-Lesen per Range:** PADF trägt `KopfLen` im Rahmenkopf — die UI kann
  Namen für eine Dateiliste per Range-Request nachziehen, ohne ganze
  Klumpen zu laden (Optimierung, kein Blocker für v1).

## 5. Kontingente und Tarife

- Neue Einstellwerte je Bezug (Konto/Guild): `pulse_laufwerk_max_bytes`,
  `pulse_laufwerk_max_datei_bytes`. Nutzungszähler aus den namenlosen
  Metadaten-Zeilen summiert, nicht aus MinIO abgefragt.
- Presigned PUT wird nur erteilt, solange das Kontingent es hergibt;
  Überschreitung ist ein **eigener, ehrlicher Fehler** („Speicher voll —
  Tarif ansehen"), nie ein generisches „Upload fehlgeschlagen".
- **Offene Produktentscheidung (Eigentümer):** Tarifmodell und Abrechnung.
  v1 braucht davon nichts — nur die Kontingentwerte als Stellschrauben. Der
  Abrechnungshaken ist ein Feld (`tarif`/`max_bytes` je Zeile), kein System.

## 6. Löschen und Konto-Ende

- Löschen clientseitig ausgelöst: Zeile + Objekt weg, Grabstein-Regel des
  Formats wie gehabt (ohne expliziten Löschwunsch bleibt der verschlüsselte
  Rest — hier aber mit echtem physischen Löschen als Default, weil der
  Vermieter Platz abrechnen muss).
- Konto-Purge nach dem `user_purge_ablage.py`-Muster erweitern: Objekte und
  Zeilen des Bezugs `konto-{id}` fallen mit der Kontolöschung; Bytes nach
  dem Zeilen-Delete, wie überall im Purge.
- DSGVO-Auskunft/Löschung ist hier unkompliziert: der Server kann über das
  Chiffrat nichts sagen und es vollständig entfernen — die Schlüssel waren
  nie seine.

## 7. Hash-Scan vor der Verschlüsselung

Als Hoster braucht Pulse die Scan-Fähigkeit aus
`medien-speicher-und-scanning.md` — bei E2EE kann sie nur **clientseitig,
vor der Verschlüsselung** laufen. Der Upload-Pfad im `pulse`-Adapter bekommt
eine feste Stelle: Hash des Klartexts (das Format aus §3b des Scanning-Docs)
gegen ein Hash-Set, **bevor** der PADF-Klumpen entsteht.

- Treffer → Upload abgelehnt mit fester Meldung; Pfad für Meldung/Protokoll
  wie im Scanning-Doc vorgesehen.
- **Offene Entscheidung:** Hash-Set-Bezug und Verteilweg an die Klienten
  (Arachnid-Shield-Antrag samt Auflagen, s. Scanning-Doc §3b-2). Bis dahin
  bleibt der Schritt hinter einem Flag aus — die Stelle im Code ist ab v1
  reserviert, damit kein Upload-Weg daran vorbeiführt.

## 8. Ehrliche Grenzen

- **Kein Retro-Entzug beim Community-Laufwerk:** Wer den
  Hauptschlüssel hatte, liest alles, was bis zu seinem Rauswurf
  verschlüsselt wurde — wie im Konzept dokumentiert. Ein echter Re-Key
  (neuer Hauptschlüssel, alle Köpfe und Scheren neu verschlüsselt) ist
  möglich, aber ein Voll-Rewrite aller Objekte; v1 behandelt ihn als teuren
  Ausnahmepfad, nicht als Rauswurf-Mechanismus.
- **Server kann Chiffrat löschen, nicht lesen:** Verfügbarkeit ist die
  Leistung, Geheimhaltung nicht — die Grenze des Produkts ist zugleich die
  Grenze des Supports („Ihre Dateien sind uns verschlüsselt, Ihr
  Wiederherstellungs-Satz ist der einzige Weg").
- **Verzeichnis-Ketten machen das erste Listing teurer** (alle Ketten
  laden). Bei den erwarteten Bestellgrößen (Geräte je Bezug: einstellig)
  vermint — `ponytail:`-Deckel: Kettenzahl je Bezug begrenzen, älteste
  Ketten nach Merge komprimieren, wenn es je zum Problem wird.

## 9. Was mit den fremden Laufwerken passiert

- **Jetzt:** UI-Einstiege für fremde Anbieter ausblenden (Flag), Code bleibt
  unangetastet — E7/E8-Routen arbeiten heute und niemand wird gebrochen.
- **Später, in einem Rutsch mit dem Pulse-Laufwerk-Bau:** Rip-out der
  fremden Adapter (`webdav`, `dropbox`, `gdrive`, `onedrive`, `oauth`,
  `freigabeLink`, …), der drei Laufwerk-Tabellen samt Routen
  (`ablage_kanal.py`, `ablage_guild_laufwerk.py`, `ablage_konto_laufwerk.py`)
  und der Weiterreicher (`ablage_schreiben.py`, `ablage_abruf`, SSRF-Modul).
  Vorher löschen hieße dieselben Tests zweimal anfassen.
- **Ablage-Kanäle (E7):** Entscheidung offen — entweder auf das
  Pulse-Laufwerk umbinden (Kanal liegt dann im bezahlten Speicher des
  Erstellers) oder zusammen mit den fremden Anbietern parken. Nicht in dieser
  Spezifikation festgelegt.

## 10. Etappen in Ordnung

1. **Parken** (klein): fremde Anbieter hinter Flag, kein weiterer Aufwand dort.
2. **Server:** Modell + Migration (namenlose Metadaten, Bezug, Kontingente),
   Endpoints (Kontingent-Abfrage, presigned PUT/GET/DELETE, Nutzung),
   Purge-Erweiterung.
3. **Klient:** `pulse`-Adapter, Verzeichnis-Scheren + Merge, Verbindung
   „Pulse-Laufwerk" (Archiv + Community), Kontingent-Fehler ehrlich.
4. **Wiederherstellungs-Satz** als Pflicht beim ersten Pulse-Laufwerk
   (Konzept §8, `pulse-krypto`).
5. **Hash-Scan-Stelle** im Upload-Pfad, Flag aus bis zum Hash-Set-Beschluss.
6. **Staubsauger-Etappe:** Rip-out laut §9.
7. **Tarif/Billing** — Produktentscheidung, kein Code vor der Entscheidung.

---

## 11. Festlegungen nach Abstimmung mit dem Eigentümer (2026-09-11, nachmittags)

Die Baustelle lief auf, dann Punkt-für-Punkt konsolidiert. Diese vier
Entscheidungen schneiden §9 und Teile der Einleitung neu:

1. **Fremde Anbieter bleiben — aber NUR für die Sicherung der eigenen
   Nachrichten.** Dropbox, Google Drive, Nextcloud und der Sync-Ordner
   gehören ausschließlich zur Archiv-Auswahl (Einstellungen). Nicht
   geparkt, kein Rip-out — §9 „Staubsauger-Etappe" ist damit gestrichen
   (OneDrive/S3 bleiben wie seit 2026-08-31 unbelegt in der Liste).
2. **Das Community-Laufwerk verbindet sich über den gewohnten
   Verbinden-Dialog** (AblageVerbindenDialog, Anbieter-Auswahl mit Icon und
   Beschreibung) — nicht über eine Sonderkarte. In dieser Dialog-Instanz
   steht genau ein Anbieter: das Pulse-Laufwerk. Die Dialog-Liste ist
   deshalb als Prop überschreibbar (`anbieterListe`), Standard bleibt die
   Archiv-Auswahl.
3. **Das persönliche Archiv bekommt KEIN Pulse-Laufwerk.** Eigentümer:
   „Archiv bleibt eigenständig" — eigene Clouds und der eigene Ordner,
   kein Miet-Speicher dort. Der Vermietungsfall ist ausschließlich:
   Community-Besitzer mietet Speicher für seine Community.
4. **Die Grundrichtung bleibt:** Pulse vermietet verschlüsselten Speicher;
   der Server sieht weiterhin nur Chiffrat.
5. **Einbettung (nachgereicht im selben Gespräch):** Die Dateiablage ist
   und bleibt ein **Kanal** (Typ 2, „Ablage" im Plus-Menü neben Text und
   Sprache). Die alte Dreifach-Freigabe aus Dropbox-Zeiten entfällt — die
   Option ist immer sichtbar. Das separate Laufwerk-Symbol im
   Kanallisten-Kopf ist entfernt; der Kanal öffnet die
   CommunityDateiablage (verbinden → Verbinden-Dialog mit „Pulse-Laufwerk",
   dann Dateiliste). Der alte Dropbox-Speicherweg (`DropboxView`, alte
   Server-Routen) bleibt ungenutzt im Baum, sein E2E-Spec ruht.

Konsequenz im Klienten: `anbieter.ts` führt die zwei Kontexte getrennt —
`angeboteneAnbieter()` (Archiv, fremde Anbieter) und `communityAnbieter()`
(„nur Pulse"). Das zwischenzeitlich gebaute Park-Flag
`ABLAGE_FREMDE_ANBIETER_ENABLED` ist wieder entfernt.

*Offene Entscheidungen beim Eigentümer (unverändert aus §0-Ende): Tarifmodell
(§5), Hash-Set-Bezug (§7), Schicksal der Ablage-Kanäle (§9), Re-Key-Politik
für Communitys (§8).*

---

*Offene Entscheidungen beim Eigentümer: Tarifmodell (§5), Hash-Set-Bezug
(§7), Schicksal der Ablage-Kanäle (§9), Re-Key-Politik für Communitys (§8).*
