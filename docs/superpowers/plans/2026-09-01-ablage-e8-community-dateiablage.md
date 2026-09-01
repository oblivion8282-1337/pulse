# E8 — Die Community-Dateiablage

> Rahmen: `docs/superpowers/plans/2026-08-31-ablage-etappen.md`.
> Entwurf: `docs/superpowers/specs/2026-08-31-ablage-kanaele-design.md` §7.

**Ziel:** Die Dateien einer Community liegen verschlüsselt auf dem Laufwerk
ihres Besitzers. Mitglieder laden hoch und herunter, wenn sie dürfen.

## Die Entscheidungen, die schon getroffen sind

- **Das Laufwerk gehört dem Community-Besitzer** (Entscheidung 2026-08-31).
- **Ohne verbundenes Laufwerk gibt es den Bereich nicht** — der Besitzer
  sieht eine Aufforderung mit einem Klick zum Verbinden, Mitglieder sehen
  gar nichts.
- **Hochladen folgt der Kernaufteilung (§1):** Das Mitglied verschlüsselt
  lokal und legt das Chiffrat über Pulse ab; ein Gerät des Besitzers festigt
  es ins Laufwerk. Bis dahin ist die Datei aus dem Zwischenlager lesbar,
  also sofort nutzbar.
- **Warum nicht direkt ins Laufwerk:** ein Freigabe-Link kennt keine
  Personen. Wer ihn hat, darf alles darin — auch löschen. „Ablegen dürfen,
  wenn der Besitzer es erlaubt" ist damit nicht ausdrückbar; mit Pulse
  dazwischen greift das bestehende Rechtesystem (§4.0a).

## Was schon dasteht — benutzen, nicht nachbauen

| Stück | Was es kann |
|---|---|
| `ablage/dateispeicher.ts` | Hochladen, auflisten, herunterladen, löschen — verschlüsselt, mit Reihe gegen gleichzeitige Schreibvorgänge |
| `ablage/dateiablage.ts` | Der Container: Kopf und Inhalt getrennt verschlüsselt, Klartext-Name nur im Kopf |
| `components/ablage/DateiablageAnsicht.svelte` | Die fertige Ansicht — **hängt an keiner Stelle und wartet genau auf diese Etappe** |
| `models/ablage_laufwerk.py` + `routes/ablage_kanal.py` | Freigabe-Adresse je Kanal, Weiterreich-Route mit SSRF-Schutz |
| `ablage/spiegel.ts` | Zwei Ziele, falls der Besitzer spiegelt |

---

## Aufgabe 1: Das Laufwerk der Community

**Serverseitig.** Eine Community braucht dieselbe Angabe, die ein Kanal schon
hat: wo ihre Dateien liegen. Sieh dir `models/ablage_laufwerk.py` an — die
Tabelle trägt heute `channel_id`. Entscheide, ob eine zweite Tabelle für
Communities richtig ist oder eine gemeinsame mit einem Bezugstyp, und
begründe es. **Ein Alembic-Kopf**, nachprüfen.

Nur der Community-Besitzer darf sie setzen. Nicht `MANAGE_GUILD` — das
Laufwerk gehört ihm persönlich, und die Rechte einer Community reichen nicht
bis in fremde Cloud-Konten.

**Abnahme:** Setzen und Ersetzen nur durch den Besitzer; die Adresse wird nie
in einer Antwort gespiegelt.

---

## Aufgabe 2: Das Zwischenlager

**Serverseitig.** Ein Mitglied lädt hoch: das Chiffrat geht an Pulse und
wartet dort, bis ein Gerät des Besitzers es ins Laufwerk festigt.

- **Rechte:** wer hochladen darf, entscheidet das bestehende Rechtesystem der
  Community — genau dafür läuft der Weg über Pulse.
- **Grenzen:** Grösse je Datei und Gesamtgrösse je Community. Ein
  Zwischenlager ohne Obergrenze ist eine Einladung, Pulse als Speicher zu
  benutzen. Wähle Werte und begründe sie mit einer Rechnung.
- **Alter:** was zu lange liegt, ohne gefestigt zu werden, muss weg — aber
  **nicht stillschweigend**. Die Oberfläche sagt dann „Der Besitzer war lange
  nicht online", nicht „Upload fehlgeschlagen".
- **Nach der Festigung wird gelöscht.** Ein Zwischenlager, das behält, ist ein
  zweiter Speicherort für Inhalte, von denen wir behaupten, sie lägen beim
  Besitzer.
- Beim Löschen der Community und beim Löschen des Kontos muss es mitgehen —
  sieh nach, wo aufgeräumt wird, und trag dich ein.

---

## Aufgabe 3: Die Festigung

**Klientseitig, auf dem Gerät des Besitzers.** Holen, was im Zwischenlager
liegt, ins Laufwerk schreiben, quittieren, damit der Server es löscht.

**Die Reihenfolge ist der ganze Punkt:** erst schreiben, dann quittieren.
Andersherum wäre eine Quittung nach fehlgeschlagenem Schreiben endgültiger
Verlust — dieselbe Regel, die `verlaufSpeichernPflicht` durchsetzt, und
derselbe Fehler, den der Bughunt am 2026-08-28 gefunden hat.

Die Warteschlange aus `ablage/archivSchreibweg.ts` ist das Vorbild: ein
Eintrag je Datei, kein Wasserzeichen, Backoff mit Deckel, Head-of-Line-Schutz.

---

## Aufgabe 4: Die Ansicht

`DateiablageAnsicht.svelte` anschliessen (sie wartet seit E1 darauf; ihr
Dateikopf sagt es). Dazu:

- Ohne Laufwerk: für den Besitzer die Aufforderung, für Mitglieder nichts.
- Eine Datei, die noch im Zwischenlager liegt, ist sichtbar und benutzbar —
  aber als „noch nicht gesichert" gekennzeichnet.
- Herunterladen geht direkt vom Laufwerk, wo es geht, sonst über die
  Weiterreich-Route (§4.2). Der Klient probiert, wie bei den Kanälen.
- Die Blob-Härtung nicht vergessen (`krypto/sichererBlobTyp.ts`) — der
  MIME-Typ kommt vom Hochladenden.

---

## Randbedingungen

Wie im E1-Plan. Zusätzlich:

- **Snowflake-IDs als String**, auch für die Zwischenlager-Einträge.
- **Nichts Geheimes ins Log** — keine Dateinamen (die stehen im
  verschlüsselten Kopf und gehen den Server nichts an), keine Adressen.
- Der Server darf den Klartext-Dateinamen **nie** sehen. Wenn dein Entwurf
  ihn braucht, ist der Entwurf falsch.

## Abnahme der Etappe

Mitglied lädt hoch, zweites Mitglied lädt herunter, und die Gegenprobe in
Postgres zeigt: kein Klartext, kein Dateiname, kein MIME-Typ.
