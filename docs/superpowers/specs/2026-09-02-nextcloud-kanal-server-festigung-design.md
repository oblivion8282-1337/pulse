# Nextcloud-Kanäle: Pulse legt selbst ab — Entwurf

> Entscheidung des Eigentümers vom 2026-09-02, in drei Sätzen:
> **Ein Kanal ist ein Ordner in der Nextcloud des Erstellers. Jede Nachricht
> ist eine Datei darin. Pulse legt die Datei ab, wenn sie ankommt, und holt
> sie, wenn jemand liest.**
>
> Ergänzt `2026-08-31-ablage-kanaele-design.md` für **genau einen Anbieter**.
> Google- und Dropbox-Kanäle bleiben beim dortigen Weg (Protokoll mit
> Manifest, Gerät des Erstellers trägt ein).

---

## 1. Warum ein eigener Weg für Nextcloud

Ein Browser darf in eine Nextcloud weder schreiben noch aus ihr lesen
(keine CORS-Kopfzeilen, nextcloud/server#3131, an echter Instanz gemessen).
Alles läuft deshalb ohnehin über den Pulse-Server, und der hält seit dem
2026-09-02 den Freigabe-Link des Konto-Laufwerks (`AblageKontoLaufwerk`).
Damit **kann Pulse selbst ablegen** — die Lücke „kein Gerät des Erstellers
online, Nachrichten warten im Postfach" entfällt.

Was Pulse dafür NICHT braucht: den Ordnerschlüssel des Kanals. Das heutige
Kanal-Protokoll (Manifest + Segmente, E6) ist damit verschlüsselt und nur von
einem Gerät führbar. Der neue Weg braucht kein Manifest.

## 2. Der Ordner

- **Ein Link je Konto.** Die Nextcloud-Verbindung aus dem Speicher-Bereich
  (Freigabe-Link mit Schreibrecht, serverseitig als Konto-Laufwerk) trägt
  Sicherung, Anhänge **und** Kanäle. Es gibt keinen zweiten Kanal-Link mehr
  (`AblageKanalLaufwerk` bleibt für Google/Dropbox).
- **Pfad:** `kanaele/<kanalId>/` im freigegebenen Ordner. Der Server legt
  die Ordner an (`MKCOL`, idempotent — 405 gilt als vorhanden).
- **Eine Datei je Umschlag:** `<nutzlastId>.puls`. Die Nutzlast-ID ist ein
  Server-Snowflake, die Dateinamen sortieren damit nach Ankunftszeit.
- **Inhalt:** JSON in genau der Form, die der Klient heute aus dem Postfach
  liest (`PostfachZustellung`: `id`, `channel_id`, `absender_device_pubkey`,
  `absender_curve25519`, `absender_user_id`, `art`, `daten`, `created_at`).
  Der Umschlag bleibt Chiffrat; Pulse und Nextcloud sehen Absender-Kennung,
  Kanal und Zeit — dasselbe, was das Postfach heute in Postgres hält.
- **Bearbeiten und Löschen** sind weitere Dateien (der Lösch-Frame vom
  2026-09-02 ist ein gewöhnlicher Umschlag). Der Leser wendet sie an. Die
  Datei einer gelöschten Nachricht bleibt liegen — wie im Postfach ist sie
  ohne Schlüssel wertlos; ein späteres Aufräumen ist nicht Teil dieses
  Entwurfs.

## 3. Schreiben

`POST /postfach` bekommt je Umschlag ein optionales Feld `archiv: true`.
Der Klient setzt es **nur** für Nachrichten-Umschläge eines Kanals (Megolm,
gleicher Inhalt für alle Geräte), **nie** für Schlüssel-Umschläge je Gerät.
Der Server legt einen so markierten Umschlag ab, wenn

1. der Kanal `ablage` trägt und eine Zeile `ablage_kanal_ordner`
   `(channel_id, ersteller_id)` hat — sie entsteht beim Anlegen eines
   Nextcloud-Kanals und sagt „dieser Kanal liegt im Konto-Laufwerk seines
   Erstellers, Pulse legt ab"; Google-/Dropbox-Kanäle haben stattdessen
   wie bisher ihre `AblageKanalLaufwerk`-Zeile —, und
2. der Ersteller ein Konto-Laufwerk hinterlegt hat.

Die Ablage geschieht **nach** dem Commit der Zustellungen, best-effort mit
Wiederholung (Ausfall der Nextcloud darf das Postfach nicht kippen). Was
nicht abgelegt werden konnte, steht in einer Nachtrage-Tabelle
(`ablage_kanal_nachtrag(nutzlast_id)`) und wird von der Pflege-Schleife
(`postfach_pflege.py`) nachgeholt, solange die Nutzlast lebt. Das Postfach
selbst bleibt unverändert: Zustellungen an Geräte, Quittung, Verfall.

## 4. Lesen

Zwei Routen am Server, beide mit derselben Prüfung wie heute
(`_kanal_fuer_mitglied`: 404 → 403 → `VIEW_CHANNEL`):

- `GET /channels/{id}/ablage/ordner?nach=<nutzlastId>&limit=` — Dateinamen
  aufsteigend hinter `nach`, aus `PROPFIND Depth 1` auf den Kanal-Ordner.
- `GET /channels/{id}/ablage/ordner/{name}` — eine Datei, durchgereicht.

Der Klient liest den Verlauf eines Nextcloud-Kanals aus diesen Routen und
öffnet jede Datei mit `zustellungOeffnen` — derselbe Code wie fürs Postfach,
nur die Quelle ist eine andere. Kein Link erreicht je ein Mitglied; die
Freigabe-Adresse wird beim Beitritt für Nextcloud-Kanäle **nicht** verteilt
und beim Mitgliederwechsel nicht erneuert. Rotiert wird nur die
Gruppensitzung (unverändert, `sitzungswahl.ts`).

## 5. Beitritt

Schlüssel verteilen Geräte, nie Pulse. **Übergabe beim Einladen:** das
Gerät des Einladenden verschlüsselt die Kanalschlüssel (alle bisherigen
Gruppensitzungen, die es kennt) für die Geräte des Eingeladenen und legt
sie ins Postfach — bevor der Eingeladene den Kanal je öffnet. Ein zweites
Gerät desselben Kontos bekommt sie über die Gerätekopplung. Der Ordner
hängt an keinem davon.

## 6. Was noch fehlt, bewusst

- **Kein Verdichten.** Zehntausend Nachrichten sind zehntausend Dateien.
  Wird das Listen träge, kommt ein Index dazu, nicht ein anderes Format.
- **Kein Aufräumen gelöschter Dateien** (s. §2).
- **Kein Umzug**: es gibt keine Nextcloud-Kanäle mit echtem Inhalt
  (Entscheidung 2026-09-02, Frage 2). Bestehende Testkanäle werden neu
  angelegt.
- **Trennt der Ersteller sein Konto-Laufwerk, sterben seine Nextcloud-
  Kanäle** — der Speicher-Bereich sagt das vor dem Trennen an (Anzahl der
  betroffenen Kanäle).

## 7. Prüfung

- Server: Ablage beim Einliefern (Mock des Laufwerks), Nachtrag bei
  Ausfall, beide Leserouten mit der Rechte-Reihenfolge, `MKCOL`-Idempotenz.
- Klient: importfreie Rechnung „welche Umschläge tragen `archiv`" und der
  Ordner-Leser als Quelle mit Unit-Tests.
- **Nachweis, nicht Test:** Zwei-Browser-Lauf gegen den Dev-Stack mit
  echter Nextcloud — Ersteller schreibt, geht offline, Mitglied schreibt,
  drittes Gerät tritt bei und liest alles aus dem Ordner.
