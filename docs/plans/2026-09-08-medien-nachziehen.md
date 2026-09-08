# Medien-Nachziehen / lokales Medien-Archiv — Planung (2026-09-08)

> Feature aus `docs/UEBERGABE-MOBILE.md` §5 „gerettete Ideen". Zweiteiliger
> Schnitt: (A) Backfill-Endpunkt im chat-gateway, (B) Geräte-Ablage im Klienten
> (Android zuerst). Rahmen: Ponytail — kleinster arbeitsfähiger Schnitt je
> Stufe, keine Abstraktionen auf Vorrat, keine neue Abhängigkeit.

## Befund (aus dem Code, vor jedem Bau)

1. **Kein paginierter Anhang-Metadaten-Endpunkt existiert.** `messages.py`
   paginiert Nachrichten pro Kanal (`limit`, `before`/`after`), Anhänge reiten
   als Nebenausgabe mit (`serialize_attachments`); `channels.py`/`owner.py`
   summieren nur. Also neu gebaut — Blattmuster von `messages.py` übernommen.
2. **Wo die Schlüssel liegen (E2EE-Klärung):** Dateiname, MIME, Maße und der
   AES-Schlüssel stehen im verschlüsselten Umschlag (Postfach-Nutzlast). Die
   Server-Zeile `MessageAttachment` trägt `filename/mime/width/height`
   **bewusst als NULL** (`models/messages.py`, Kopf von
   `postfach_anhaenge.py`). Der Server kann sie weder sehen noch liefern — und
   darf es auch nicht. Der Endpunkt liefert nur, was er hat: id, Kanal,
   Größe, Zeitpunkt, verschlüsselt-Marke, Laufwerk-Marke. Namen/MIME ergänzt
   der Klient aus seinem lokalen Bestand (`Satz.anhaenge` samt
   `schluessel`/`thumb_schluessel`).
3. **E2EE-Anhang-Zeilen sind sterblich:** fällt der letzte Umschlag-Bezug
   (Quittierung), fällt die Zeile (`postfach_pflege.py::
   loesche_anhaenge_ohne_umschlag`). Der Server ist **nicht** die dauerhafte
   Wahrheit für Medien — die Geräte-Ablage ist es. Der Backfill rekonstruiert
   bestenfalls einen Anfang, kein Archiv.
4. **Auf dem Gerät existiert schon viel:** `pulse-verlauf` (IndexedDB, v2)
   hält Sätze inkl. Anhang-Metadaten + Schlüssel (`nachrichten`) und die
   entschüsselten Bytes (`anhaenge`, gesichert **vor** der Quittierung). Die
   Medienübersicht (`MedienuebersichtSheet.svelte`) liest aber nur den
   Speicher-Nachrichten-Store — Sichtweite des geladenen Verlaufs.
5. **Passt zu E3** (`2026-08-31-ablage-e3-…`): persönliches Archiv = markierte
   Verbindung (Ordner/Cloud), kein zweites Archiv-System. Browser-/WebView-
   Speicher bleibt der schnelle Weg, das Archiv die Dauerkopie.

---

## Teil A — Server: Backfill-Endpunkt (Stufe A1)

`GET /meine-anhaenge?limit=&before=` — paginierte Anhang-Metadaten des
anfragenden Kontos (eigene Uploads), newest-first, Cursor `before` (exklusiv),
`limit ≤ 100`. **Keine vorsignierten URLs**: Bytes bleiben hinter den
bestehenden Routen mit ihren Rechteprüfungen
(`/attachments/{id}/download-url`, `/postfach/anhaenge/{id}/abrufadresse`,
eigenes Laufwerk via `archivAbruf`). Damit stellt sich die Frage „darf er das
noch sehen, wenn der Kanal weg ist?" für diesen Endpunkt gar nicht erst.

- Auswahl: `uploader_id == current.id`, `deleted_at IS NULL`,
  `(message_id IS NOT NULL OR postfach_gebunden_am IS NOT NULL)` —
  pendente Hüllen und halbfertige Klartext-Uploads bleiben außen.
- Antwortfelder: `id, channel_id, size, filename|null, mime|null,
  width/height|null, hat_thumb (+Maße), erstellt_am,
  verschluesselt, laufwerk_verteilt` — die letzte Marke braucht der Klient,
  um „liegt in deinem Archiv-Ordner" zu zeigen (der 410-Weg des Abrufs).
- `ratelimit.check("attach", …)` (dieselbe Drossel wie die Upload-Adressen).
- Migration: Index auf `(uploader_id, id)` — sonst blättert jede Seite per
  Seq-Scan über `message_attachments`.

**Dateien:** neu `services/chat-gateway/src/dcc_chat_gateway/routes/
meine_anhaenge.py` (~80 Zeilen), registriert in `routes/__init__.py`; Schema
in `routes/_deps.py`-Nachbar `schemas.py`; eine Migration.
**Test:** `services/chat-gateway/tests/test_meine_anhaenge.py` — Paginierung
komplett durchlaufen (Cursor exklusiv, Reihenfolge), fremder Nutzer sieht
nichts, gelöschte/pendende Zeilen fehlen, verschlüsselte Zeilen kommen mit
NULL-Metadaten sauber serialisiert.
**Fertig, wenn:** ein Testkonto seine komplette eigene Upload-Historie
seitenweise abholt und ein zweites Konto dieselbe Route leer sieht.

**Bewusst NICHT in A1 (Ceiling):** empfangene (fremde) Medien — sie hängen an
`DmAnhangBezug` und sterben mit der Quittierung; der Empfänger hat Metadaten
und Bytes ohnehin lokal (und im eigenen Laufwerk). Upgrade-Pfad: zweite
Auswahlbedingung „Zeile eines Kanals, an dem mir eine Zustellung gehört/ein
Bezug existiert", sobald ein Geräte-Wechsel-Fall das verlangt. Ebenso nicht:
Filter (MIME/Kanal/Zeitraum), Bytes oder URLs im selben Endpunkt.

---

## Teil B — Klient: Geräte-Ablage (Android zuerst)

### Stufe B1: Medien-Index + Nachzug + geräteweite Liste

- `verlauf/schema.ts`: `DB_VERSION 3`, neuer Objektspeicher `medien` (Bump ist
  zwingend — neuer Store nur in `onupgradeneeded`, steht im Modulkopf).
  Index-Zeile als **Ableger** (wiederherstellbar aus `nachrichten`):
  `{ id, kontoId, kanalId, autorId, erstelltAm, dateiname|null, mime|null,
  size, verschluesselt, hatThumb, schluessel|null, laufwerkVerteilt }`;
  `kontoId` Pflicht (`kontoFilter` liest fail-closed).
- `verlauf/db.ts`: Zweit-Schreibweg in `verlaufPutSaetze` — die **einzige
  Schreibpforte** aller Wege (WS, Nachladen, `archivRueckweg`): beim Ablegen
  eines Satzes wandern seine Anhänge als Index-Zeilen per Upsert mit. Ein
  Leseweg `medienLesen` (absteigend, konto-gefiltert) neben
  `verlaufAlleLesen`.
- Neu `verlauf/medienNachzug.ts`: Quelle mit **injiziertem Abruf** (Muster
  `ablage/postfachQuelle.ts` — keine Netz-Imports, Node-testbar); Schleife
  newest-first mit `before`-Cursor, Abbruch, wenn eine gelieferte id schon im
  Index liegt (Überlappung ⇒ der Rest ist lokal). **Was lädt man nach, wann:**
  nur Metadaten, beim ersten Öffnen der geräteweiten Medienliste und auf
  frisch gekoppelten Geräten; danach deckt die Überlappung den Zuwachs — kein
  Vollsweep pro Start. **Bytes nie im Nachzug**, nur auf Klick über die
  bestehenden Wege (`anhangBlob`: lokal → Netz → 410 → eigenes Laufwerk;
  Klartext → `refresh_download_url` mit Kanalrechten).
- UI: geräteweites Medien-Blatt `components/mobile/MedienArchivSheet.svelte`,
  Einstieg im Du-Tab (`MeSectionList.svelte`); Raster/Dateiliste/Lightbox
  wiederverwenden (`AutoRefreshImage`, `Lightbox`, Muster
  `MedienuebersichtSheet` — das DM-Sheet selbst bleibt, wie es ist).
- i18n: Keys in `web/messages/{de,en}.json` (Paraglide/Vite-Falle: Vite per
  PID neu starten, Key per curl verifizieren). `mobile/` bleibt unangetastet —
  die Hülle lädt die Web-App.

**Dateien:** oben genannte fünf + `verlauf/index.ts` (nur falls eine
Schichtfunktion nötig wird). **Test:** `web/test/medien-nachziehen.test.ts`
(Repo-Konvention: `pnpm test:unit` = Node-Testläufer, nicht Vitest) — Cursor-
Exklusivität, Abbruch am lokal-bekannten Anhang, NULL-Metadaten (verschlüsselt)
landen trotzdem mit kanalId/kontoId im Index.
**Fertig, wenn:** ein frisches Gerät (leere IndexedDB) die Medienliste
seitenweise vom Server füllt und ein zweiter Lauf sofort am Überlappungs-
Abbruch hängt.

### Stufe B2: Dauerkopie — an E3 andocken (Verdrahtung, kein neuer Mechanismus)

IndexedDB überlebt App-Neustarts, aber nicht „Speicher leeren", Deinstallation
und den 14-Tage-Verfall (`krypto/verfallPruefen.ts`). Der Weg darüber hinaus
existiert: markierte Archiv-Verbindung (E3 A2), `archivSchreibweg` schreibt den
Verlauf dorthin, `archivRueckweg` holt ihn zurück — und weil der Index aus
`verlaufPutSaetze` mitgefüttert wird, **baut der Rückweg den Medien-Index
selbst wieder auf**, ohne eigenen Code. E2EE-Anhang-Bytes liegen nach §11.1
ohnehin im eigenen Cloud-Ordner (`ablage_anhang_verteilung`), `anhangHolen`
liest sie mit 410-Rückweg von dort.

Arbeit in B2: prüfen, dass im Android-WebView eine **Cloud**-Verbindung als
Archiv wählbar bleibt (WebDAV/S3/Dropbox sind pure HTTP — kein File System
Access nötig; `anbieterFuerUmgebung.ts` blendet nur den Ordner aus, E3 A4)
und der Rückweg inkl. Medienliste dort einmal real durchläuft.

**Dateien:** kaum Code — `anbieterFuerUmgebung.ts`/`verbindungen.svelte.ts`
nur falls die Umgebungserkennung die Hülle falsch einsortiert.
**Test:** Playwright-Lauf mit vorgetäuschter Plattform (Muster E3 A4: Cloud
wählbar, Ordner nicht).
**Fertig, wenn:** Cache-Clear auf dem Gerät → nach Rückweg sind Verlauf und
Medienliste wieder da, ohne Server-Vollsweep.

**Bewusst NICHT in B2 (Ceiling):** `@capacitor/filesystem` als echter
Geräte-Ordner (neue native Abhängigkeit) — erst, wenn Nutzer ohne Cloud das
nachweislich verlangen. Upgrade-Pfad: ein Adapter nach dem bestehenden
`ablage/adapter.ts`-Interface, nativ nur in der Hülle, Web-Code unverändert.

## Reihenfolge und Gesamtbild

A1 ist unabhängig lieferbar (API-Nutzer, Tests). B1 hängt an A1, B2 an B1.
Ein Stufe-1-System danach: eigene Medien sind geräteweit auffindbar, alte
Anhänge laden auf Klick nach, die Dauerkopie fährt über die E3-Ablage — ohne
neue Abhängigkeit und ohne zweites Archiv-System.
