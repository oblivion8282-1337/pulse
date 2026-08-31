# Etappe E0 — Messen und gezielt jagen (2026-08-31)

> Erste Etappe des Rahmenplans
> `docs/superpowers/plans/2026-08-31-ablage-etappen.md`. Zweig
> `feat/e2e-dm-krypto-weg-a`.

---

## 1. Der Messlauf

| Was | Ergebnis |
|---|---|
| `PULSE_GATE_VOLL=1 bash scripts/gate.sh` | **grün** — Backend-Tests (8 Prozesse), Cargo-Tests `krypto/pulse-krypto`, WASM-Bau, `pnpm check` + `pnpm build`, Node-Unit-Tests web und desktop, Auslieferer-Fälle |
| `bash scripts/gate.sh --maschine` | vollständig — inklusive `redis-server`, `wasm-pack`, gepinnter FFmpeg |
| Playwright (voller Lauf, 13,7 min) | **146 grün, 9 rot, 14 nicht gelaufen** |

**Das Gate war grün und hat trotzdem nichts von den Fehlern unten gesehen.**
Das ist keine Überraschung, sondern die bekannte Lücke: Playwright hängt in
keinem Gate, und die Ablage-Engine war zwar unit-geprüft, aber nicht in den
Fällen, um die es hier geht (Gleichzeitigkeit, Grenzwerte, drittes
ID-Schema).

Der Playwright-Lauf ist als Messung nur eingeschränkt gültig — er lief,
während schon behoben wurde, und der Entwicklungsserver lädt Änderungen
sofort nach. Ein sauberer Wiederholungslauf steht am Ende der Etappe.

---

## 2. Befunde

Sortiert nach Schwere. „Bestätigt" heisst: am Original nachgelesen und mit
einem Test festgenagelt, der vorher rot war.

### B1 — Klartext in einem Kanal, der sich als verschlüsselt ausweist

`services/chat-gateway/.../routes/ws_op_send.py` · **Sicherheit** · behoben

`handle_send` hat einen schnellen und einen langsamen Pfad. Die
Mischzustand-Regel aus Konzept §2a — kein Klartext in einen Ablage-Kanal —
stand nur im langsamen. Ein einziges `subscribe` vorher genügte, und der
Server quittierte anschliessend Klartext in einem Kanal, dessen
Kennzeichnung anderen Mitgliedern Ende-zu-Ende-Verschlüsselung zusagt.

Der schnelle Pfad lädt die Kanalzeile jetzt ebenfalls. Der Test fährt beide
Pfade nacheinander und prüft am Bestand nach, dass keine Zeile entstand.

### B2 — Der lokale Verlauf war die einzige Kopie, ohne Netz darunter

`web/src/lib/identity/`, `web/src/lib/verlauf/` · **Datenverlust** · behoben

Das Postfach löscht die Zustellung serverseitig, sobald der Klient quittiert
hat. Der Server hält nie Klartext und kann den Geheimtext danach kein zweites
Mal ausliefern — `pulse-verlauf` in der IndexedDB ist die einzige Kopie. Sie
lag im „best effort"-Eimer, den Browser bei Speicherdruck leeren dürfen;
Safari räumt schreibbaren Speicher schon nach etwa sieben Tagen ohne Besuch.
Zwei Wochen Urlaub hätten gereicht.

`navigator.storage.persist()` wird jetzt angefordert, an den zwei Stellen, an
denen etwas Unwiederbringliches entsteht — nicht beim Seitenladen, weil
Firefox dort eine Nachfrage zeigt, die der Nutzer nicht einordnen kann.

### B3 — Der Sortiervergleich kannte nur zwei von drei ID-Schemata

`web/src/lib/utils/snowflakeZeit.ts` · **Absturz** · behoben

Die vorläufige `tmp-`-Kennung einer noch unbestätigten Nachricht ist keine
Ziffernfolge; `BigInt(id)` warf darauf mitten im `Array.sort`. Eine Ausnahme
dort reisst nicht bloss den Vergleich ab, sondern die Listendarstellung — im
Playwright-Lauf als unbehandelter Fehler aus der Community-Kanal- **und** der
DM-Route zu sehen. Ein unbekanntes Schema wird jetzt deterministisch nach
hinten geordnet statt durchzufallen.

### B4 — Eine zu grosse Lücke wurde still halbiert

`web/src/lib/ablage/quelle.ts` · **Datenverlust** · behoben

Der Blätterlauf hört nach 200 Seiten auf. Weil er von neu nach alt geht, lag
das Abgeschnittene direkt über dem Wasserzeichen — und der Nachzieher setzt
sein Wasserzeichen auf die höchste gelieferte Id, womit der übersprungene
Block für immer darunter lag. Ab 20 000 Nachrichten fehlte ein
zusammenhängender Teil im Archiv, ohne Fehler und ohne Lücken-Eintrag.

Jetzt wird geworfen statt gekürzt; das hält das Wasserzeichen stehen. Eine
einzige Zusatzanfrage unterscheidet exakt zwischen „Grenze erreicht" und „es
fehlt wirklich etwas".

### B5 — Gleichzeitige Uploads verloren einen Verzeichniseintrag

`web/src/lib/ablage/dateispeicher.ts` · **Datenverlust** · behoben

Lesen-Ändern-Schreiben ohne Sperre: zwei parallele Uploads schrieben das
Verzeichnis jeder für sich, und bei umgekehrter Ankunftsreihenfolge
überschrieb der ältere Stand den neueren. Der Container blieb liegen, aber
kein Verzeichnis zeigte mehr auf ihn — die Datei war kommentarlos weg, und
anders als bei den Nachrichten-Segmenten adoptiert hier niemand Waisen. Zwei
Dateien gleichzeitig auszuwählen genügte.

### B6 — Falsche Rahmenzahl meldet Lücke auf intaktem Segment

`web/src/lib/ablage/schreiber.ts` · Korrektheit · in Arbeit

`alteRahmen` stammt aus dem zwischengespeicherten Manifest, `alteRahmenBytes`
aus der frisch gelesenen Datei. Hat ein anderer Schreiber verlängert, zählt
der neue Manifest-Eintrag zu wenig — und `leser.ts` meldet eine Lücke auf
einem Segment, dessen Prüfsumme stimmt. Untergräbt das Vertrauen in die
Lücken-Diagnose selbst.

### B7 — Mehrgeräte-Schreiben wirft Segmente aus dem Manifest

`web/src/lib/ablage/schreiber.ts` · Korrektheit · in Arbeit

`festigen()` schreibt das Manifest bedingungslos, ohne den abgelegten Stand
gegen den erwarteten zu prüfen. Ein zweites Gerät kann ein Manifest schreiben,
in dem ein gerade erst angelegtes Segment fehlt. Selbstheilend erst beim
nächsten `bestandAufnehmen()`, das die Waise adoptiert — bis dahin fehlt der
Verlauf ohne Fehleranzeige.

### B8 — Google Drive legt Dubletten an

`web/src/lib/ablage/gdrive.ts` · Korrektheit · in Arbeit

Nachsehen und dann Anlegen ist nicht atomar, und Drive erlaubt mehrere
Dateien gleichen Namens im selben Ordner. Zwei Geräte können zweimal
`manifest.puls` erzeugen; welche danach gelesen wird, entscheidet Googles
Suchsortierung. Ein Restfenster bleibt, weil Drive keine Eindeutigkeit
garantiert — es gehört benannt, nicht wegdefiniert.

---

## 3. Geprüft, kein Befund

- **Stored XSS über Blob-URLs entschlüsselter Anhänge.** Eine
  MIME-Erlaubnisliste wie auf dem Juli-Zweig fehlt, der Schaden entsteht
  trotzdem nicht: Bilder landen in `<img>` (dort führt kein Browser Skript
  in einem SVG aus), alles Übrige in einem Link mit `download`-Attribut, das
  Speichern erzwingt statt Navigation. **Aber die Absicherung ist implizit** —
  wer den „sonstige"-Zweig ändert oder den Dateinamen optional macht, hebt
  sie stillschweigend auf. Als Härtung vorgemerkt, nicht als Fehler gezählt.
- **Postfach und Schlüsselverzeichnis**: Eigentümerschaft zweifach geprüft,
  fail-closed, IDs als Strings, keine Schlüssel im Log, Vorratsverbrauch
  begrenzt.
- **Geräte-Kopplung**: alle Routen filtern auf den Besitzer, Einlösung und
  Anlege-Grenze atomar im selben Statement.
- **Private Gruppen und Ereignisweg**: der neue Broadcast-Zweig ist
  fail-closed ohne Admin-Umweg, Nichtmitglieder bekommen 404 statt 403.
- **Migrationen 0065–0081**: lineare Kette, ein Kopf, keine NOT-NULL-Spalte
  ohne Vorgabewert auf bewohnter Tabelle.

## 4. Bekannte Grenzen, bewusst nicht behoben

Beide stehen bereits im Code und sind dort begründet:

- `schluessel_nachweis.py`: die Geräteprüfung belegt Kontozugehörigkeit, nicht
  Gerätebesitz — eine Kontoübernahme kann Postfach-Zustellungen aller eigenen
  Geräte abholen.
- `geraete_widerruf.py`: die Verdrängung des ältesten Schlüsselbündels kann
  einen eigenen Geräte-Grabstein wegräumen.
