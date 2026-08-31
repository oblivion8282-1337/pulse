# E3 — Das persönliche Archiv im Ordner

> Rahmen: `docs/superpowers/plans/2026-08-31-ablage-etappen.md`.
> Entwurf: `docs/superpowers/specs/2026-08-31-ablage-kanaele-design.md` §5.

**Ziel:** Der Nutzer bestimmt, wo sein verschlüsseltes Archiv liegt — und es
liegt dort auch nach einem Neustart.

**Kern der Etappe: ernten, nicht neu bauen.** Auf
`origin/feat/dm-attachment-e2ee` (Juli 2026, nie gelandet) steht ein
vollständiges, dokumentiertes Archiv-Untersystem. Was fehlt, ist der
Anschluss an die heutige Krypto.

## Globale Randbedingungen

Wie im E1-Plan: Nodes Testläufer statt Vitest (keine erweiterungslosen
Laufzeit-Importe in geprüften Dateien), Quelldateien ≤ 350 Zeilen,
Svelte-Komponenten ≤ 250, Deutsch mit echten Umlauten, keine Emojis, keine
neuen Abhängigkeiten, nichts Geheimes ins Log, `command grep` statt `grep`.
Vor jedem Commit `pnpm test:unit` und `pnpm check`.

---

## Die Bestandsaufnahme (erhoben 2026-08-31)

**Web** — `web/src/lib/archive/`, 13 Dateien, rund 1600 Zeilen:

| Datei | Zeilen | Hängt an | Urteil |
|---|---|---|---|
| `archiveFsa.ts` | 168 | nur `identity/idb-shared` | **direkt brauchbar** — Verzeichnis-Griff, Berechtigung, Neubestätigung |
| `archiveEpoch.ts` | 24 | — | direkt brauchbar |
| `archiveHealth.svelte.ts` | 64 | — | direkt brauchbar |
| `archiveLastWrite.ts` | 36 | — | direkt brauchbar |
| `archiveProblemText.ts` | 44 | — | direkt brauchbar, Texte prüfen |
| `archiveTargets.ts` | 45 | — | direkt brauchbar |
| `archiveUi.svelte.ts` | 37 | — | direkt brauchbar |
| `archiveStore.ts` | 293 | `archiveFsa`, `platform/runtime`, `window.pulse.mediaArchive` | brauchbar, sobald die Electron-Hälfte da ist |
| `archiveQueueStore.ts` | 210 | — | brauchbar |
| `archiveQueue.svelte.ts` | 323 | `archiveFormat`, `chatApi` | brauchbar nach dem Formatwechsel |
| `archiveFormat.ts` | 178 | **`identity/enckey.svelte`** | **anpassen** — hängt am toten TypeScript-Krypto |
| `archiveRead.ts` | 86 | **`identity/enckey.svelte`**, `crypto/safeBlobType` | **anpassen** |
| `archiveFetch.ts` | 89 | — | brauchbar |

**Desktop** — fehlt heute vollständig:

| Datei | Zeilen |
|---|---|
| `desktop/electron/mediaArchive.ts` | 176 |
| `desktop/electron/mediaArchivePaths.ts` | 46 |
| `desktop/electron/main.ts` (Einhängung) | +20 |
| `desktop/electron/preload.ts` (Fassade) | +48 |
| `desktop/test/mediaArchivePaths.test.ts` | 79 |

Lesen mit `git show origin/feat/dm-attachment-e2ee:<pfad>`.

**Der einzige echte Umbau** ist die Verschlüsselungsschicht: `archiveFormat.ts`
packt und öffnet einen Archiv-Eintrag über `enckey.svelte` (X25519 in
TypeScript, abgelöst). Heute gilt `krypto/pulse-krypto` (Rust/WASM) und die
Container aus `lib/ablage/dateiablage.ts`.

---

## Aufgabe 1: Die abhängigkeitsfreie Hälfte übernehmen

**Dateien:** `archiveFsa.ts`, `archiveEpoch.ts`, `archiveHealth.svelte.ts`,
`archiveLastWrite.ts`, `archiveProblemText.ts`, `archiveTargets.ts`,
`archiveUi.svelte.ts` — nach `web/src/lib/archive/`.

**Schritte**

1. Je Datei mit `git show` holen, lesen, **dann** übernehmen. Nicht blind
   kopieren: jeder Kommentar, der eine Begründung trägt, muss an der neuen
   Stelle noch stimmen. Der häufigste Fehler dieses Projekts ist eine
   Begründung, die beim Kopieren mitwandert und am Zielort nicht zutrifft.
2. Verweise auf abgelöste Dateien (`enckey`, `liveSync`, `certVerify`) in
   Kommentaren gegen das ersetzen, was heute gilt — oder streichen.
3. Für `archiveFsa.ts` einen Test schreiben, der den Berechtigungs-Weg
   abbildet: Griff abgelegt, beim Start erneut bestätigt, Verweigerung führt
   zum Rückfall. Die Datei ist heute ungeprüft.
4. `archiveProblemText.ts`: die Texte gegen die Hausregel prüfen — jeder
   Befund braucht einen Handgriff, sonst ist er eine Sackgasse.

**Abnahme:** `pnpm test:unit` grün, `pnpm check` grün, nichts hängt an
`enckey`.

---

## Aufgabe 2: Die Electron-Hälfte übernehmen

**Dateien:** `desktop/electron/mediaArchive.ts`, `mediaArchivePaths.ts`,
Einhängung in `main.ts`, Fassade in `preload.ts`,
`desktop/test/mediaArchivePaths.test.ts`.

**Schritte**

1. Übernehmen, dann **`preload.ts` und `web/src/lib/platform/pulse.d.ts`
   synchron halten** — das ist im Haus eine ausdrückliche Regel, und die
   Typdatei ist die einzige Stelle, an der der Renderer erfährt, was es gibt.
2. `desktop/test/mediaArchivePaths.test.ts` mitnehmen. Prüfen, dass es in
   `pnpm test:unit` des Desktop-Teils wirklich läuft — ein nicht
   ausgeführter Test sieht in der Ausgabe genauso aus wie ein grüner.
3. Rechteprüfung der Pfade: der Store schreibt in einen vom Nutzer gewählten
   Ordner. Sieh nach, wie `desktop/electron/store.ts` seine Dateien
   absichert (Linux `chmod 700`/`600`) und halte es genauso.
4. **Kein Version-Bump nötig?** Doch: `desktop/electron/**` gehört zur
   Liste, die über den Installer ausgeliefert wird. Wird diese Etappe
   ausgeliefert, muss `desktop/package.json` die `version` erhöhen —
   electron-updater ignoriert eine gleiche Version stillschweigend.

**Abnahme:** `cd desktop && pnpm run build:electron` läuft durch,
`pnpm test:unit` im Desktop-Teil grün.

---

## Aufgabe 3: Der Formatwechsel

**Dateien:** `archiveFormat.ts`, `archiveRead.ts` (beide anzupassen).

**Das ist die eigentliche Denkarbeit der Etappe.** Vorgehen:

1. Zuerst lesen und aufschreiben, was das Juli-Format leistet: welche
   Metadaten, welche Mehrfach-Versiegelung (mehrere Geräte), welcher
   Testvektor.
2. Dann dagegenhalten, was `lib/ablage/dateiablage.ts` heute kann — es hat
   bereits einen Container mit verschlüsseltem Kopf und getrenntem
   Inhaltsschlüssel. **Die Frage, die zu beantworten ist: braucht das Archiv
   ein eigenes Format, oder ist es derselbe Container?** Ein zweites Format
   ist eine zweite Sache, die auseinanderlaufen kann — es zu vermeiden ist
   viel wert, aber nicht um jeden Preis.
3. Entscheiden, begründen, umsetzen.
4. **Den Testvektor-Wächter mitnehmen** (Idee aus `archive-format.spec.ts`
   des Juli-Zweigs, Code nicht): ein einmal abgelegtes Format darf sich nicht
   stillschweigend ändern. Ein fester Beispiel-Container im Test, der auch in
   einem Jahr noch lesbar sein muss.
5. `archiveRead.ts` nutzt `crypto/safeBlobType` — heute heisst das
   `krypto/sichererBlobTyp.ts`. Umhängen, nicht neu bauen.
6. `archiveRead.ts` unterscheidet dreiwertig: abgelaufen (Server hat
   gelöscht) / im Archiv, aber kaputt / kein Schlüssel. **Diese
   Unterscheidung ist der Wert der Datei** — sie muss den Umbau überleben.

**Abnahme:** Ein Eintrag lässt sich packen, ablegen, wieder öffnen; die drei
Fehlerfälle sind einzeln auslösbar und einzeln benannt.

---

## Aufgabe 4: Die Warteschlange anschliessen

**Dateien:** `archiveStore.ts`, `archiveQueueStore.ts`,
`archiveQueue.svelte.ts`, `archiveFetch.ts`.

**Schritte**

1. Übernehmen; `archiveQueue` an das Format aus Aufgabe 3 hängen.
2. Die drei Testdateien des Juli-Zweigs als **Vorlage** heranziehen
   (`archive-queue.spec.ts` prüft Backoff-Wachstum und -Deckel, Reihenfolge
   fälliger gegen kaputte Einträge, Fortsetzungszeiger, und dass ohne Ordner
   nichts gesammelt wird). Der Code ist an das alte Krypto gebunden, die
   Fälle nicht.
3. Anschliessen an den Ort, an dem heute der Verlauf geschrieben wird
   (`verlauf/index.ts::verlaufSpeichernPflicht`) — dort steht schon die
   Anforderung für dauerhaften Speicher, und dieselbe Stelle weiss, wann
   etwas Unwiederbringliches entsteht.

**Abnahme:** Ein Neustart mitten in der Warteschlange verliert nichts.

---

## Aufgabe 5: Die drei Umgebungen

**Entwurf §5.2**, ausdrücklich entschieden:

| Umgebung | Ordner wählbar | Verhalten |
|---|---|---|
| Desktop-App | ja | Ordnerdialog |
| Chrome/Edge | ja | File System Access, Griff in IndexedDB |
| Firefox/Safari | **nein** | **unverändert wie heute**, plus Hinweis auf die App |

**Der wichtigste Satz der Etappe:** In Firefox und Safari wird **nichts
abgeschaltet**. Der Verlauf liegt dort weiter im Browser-Speicher, genau wie
bisher; es fehlt allein die Ordner-Auswahl, und dort steht der Hinweis, dass
die Desktop-App sie bietet. Wer hier den lokalen Verlauf abhängt, nimmt
Browser-Nutzern ihre Nachrichten.

**Schritte**

1. Die Weiche in `archiveStore.ts` prüfen: sie kennt Electron und FSA, „sonst
   gar nicht". Der Rückfall auf den bestehenden Weg muss ergänzt werden.
2. Den Hinweis dort zeigen, wo der Nutzer nach dem Ordner sucht — im
   Einstellungs-Abschnitt „Speicher" aus E1.
3. Ein Test je Umgebung, mit gefälschter Plattform-Erkennung.

**Abnahme:** In der Desktop-App liegt nach einem Neustart derselbe Verlauf im
gewählten Ordner; unter einer vorgetäuschten Firefox-Umgebung geht nichts
verloren.

---

## Abschluss

- `bash scripts/gate.sh` grün, Playwright mindestens so grün wie vorher
- Changelog-Eintrag: ja — „du bestimmst, wo dein Archiv liegt" ist
  user-sichtbar. Stil vom Eigentümer wählen lassen.
- **Version-Bump in `desktop/package.json`**, sobald die Electron-Hälfte
  ausgeliefert wird (siehe Aufgabe 2, Punkt 4).
