# E3 — Das persönliche Archiv

> Rahmen: `docs/superpowers/plans/2026-08-31-ablage-etappen.md`.
> Entwurf: `docs/superpowers/specs/2026-08-31-ablage-kanaele-design.md` §5.

**Ziel:** Der Nutzer bestimmt, wo sein verschlüsseltes Archiv liegt — und es
liegt dort auch nach einem Neustart.

## Der Zuschnitt hat sich am 2026-08-31 geändert

Ursprünglich war E3 ein **eigenes** Archiv-System neben den
Laufwerks-Verbindungen, das immer einen lokalen Ordner benutzt. Auf die Frage
des Eigentümers hin — „ist das nicht auch bloss ein Cloud-Ordner?" —
nachgesehen und festgestellt: **doch, es ist dasselbe.** Gleiches
Container-Format, gleiche Engine, gleiche Adapter. Der Ordner ist längst eine
gewöhnliche Verbindungsart (`sync_ordner`).

Der einzige echte Unterschied liegt nicht in der Technik, sondern in der
Frage, die beide beantworten:

| | muss erreichbar sein für | daraus folgt |
|---|---|---|
| Kanal-Ablage | **andere Mitglieder** | braucht eine Cloud-Adresse (§2.2) |
| persönliches Archiv | **nur dich selbst** | ein Ordner genügt |

**Entschieden: zusammenlegen.** Es gibt kein zweites System. Eine der
vorhandenen Verbindungen wird als „mein Archiv" markiert — Ordner,
Nextcloud, Drive oder Dropbox, ganz gleich. Das kostet weniger Code, es kann
weniger auseinanderlaufen, und es funktioniert auch in Firefox und Safari,
wo ein Ordner nicht wählbar ist, eine Cloud-Verbindung aber schon.

Damit fällt der grösste Teil der geplanten Ernte weg: kein paralleles
`archive/*`-Untersystem. Geerntet wird nur noch das, was die
**Ordner-Verbindung** braucht, um einen Neustart zu überleben.

---

## Der Befund, der die Etappe nötig macht

**Eine Ordner-Verbindung überlebt heute kein Neuladen.** `syncOrdner.ts`
legt den Verzeichnis-Griff nirgends ab, und der Verbinden-Dialog speichert
die Verbindung mit `konfiguration: {}`. Nach einem Neustart steht sie in der
Liste und zeigt ins Nichts — für den Nutzer sieht es aus, als sei sein
Laufwerk verschwunden.

Genau das löst `archiveFsa.ts` vom Juli-Zweig (168 Zeilen, hängt nur an
`identity/idb-shared`, das es heute gibt): Griff in IndexedDB, Berechtigung
beim Start erneut bestätigen, sauberer Rückfall bei Verweigerung.

---

## Globale Randbedingungen

Wie im E1-Plan: Nodes Testläufer statt Vitest (keine erweiterungslosen
Laufzeit-Importe in geprüften Dateien), Quelldateien ≤ 350 Zeilen,
Svelte-Komponenten ≤ 250, Deutsch mit echten Umlauten, keine Emojis, keine
neuen Abhängigkeiten, nichts Geheimes ins Log, `command grep` statt `grep`.
Vor jedem Commit `pnpm test:unit` und `pnpm check`.

---

## Aufgabe 1: Die Ordner-Verbindung überlebt den Neustart

**Dateien**
- Ernten: `web/src/lib/ablage/ordnerGriff.ts` — aus
  `git show origin/feat/dm-attachment-e2ee:web/src/lib/archive/archiveFsa.ts`
- Ändern: `web/src/lib/ablage/syncOrdner.ts`, `verbindungen.ts`,
  `components/ablage/AblageVerbindenDialog.svelte`
- Test: `web/test/ablage-ordner-griff.test.ts`

**Schritte**

1. `archiveFsa.ts` lesen und übernehmen — **nicht blind kopieren**. Jeder
   Kommentar, der eine Begründung trägt, muss an der neuen Stelle noch
   stimmen; Verweise auf abgelöste Dateien (`enckey`, `liveSync`) gegen das
   ersetzen, was heute gilt, oder streichen.
2. Beim Verbinden den Griff ablegen und seine Kennung in
   `konfiguration` schreiben, damit `adapterFür` ihn wiederfindet.
3. Beim Start die Berechtigung erneut anfordern. **Wird sie verweigert, ist
   das kein Fehler, sondern ein Zustand** — `laufwerk-weg` aus `zustand.ts`,
   mit dem Handgriff „Ordner erneut wählen".
4. Test: Verbindung anlegen, Griff ablegen, neue Sitzung vortäuschen,
   Verbindung wiederherstellen. Und der Gegenfall: Berechtigung verweigert →
   `laufwerk-weg`, nicht Absturz.

**Abnahme:** Nach einem Neuladen ist die Ordner-Verbindung wieder benutzbar,
ohne dass der Nutzer sie neu anlegt.

---

## Aufgabe 2: Die Markierung „mein Archiv"

**Dateien:** `verbindungen.ts`, `SpeicherSektion.svelte`,
`SpeicherVerbindungZeile.svelte`, Test.

**Schritte**

1. Ein Feld an der Verbindung: ist sie das Archiv? **Höchstens eine
   Verbindung darf es sein** — beim Setzen die vorige zurücksetzen, in einem
   Schritt. Zwei Archive gleichzeitig wären zwei Wahrheiten.
2. In der Zeile anzeigen und umschaltbar machen.
3. Ist keine Verbindung markiert, bleibt alles wie heute: der Verlauf liegt
   im Browser-Speicher. **Das ist kein Notbehelf**, sondern der Normalfall
   für jeden, der nie ein Laufwerk verbindet — und es darf nie kaputtgehen.
4. Test: die Markierung ist eindeutig; ein Wechsel lässt keine zwei
   markierten zurück.

**Abnahme:** Genau eine Verbindung trägt die Markierung, ein Wechsel ist
atomar.

---

## Aufgabe 3: Der Verlauf wandert ins Archiv

**Dateien:** `verlauf/index.ts`, ein neuer Schreibweg, Tests.

**Schritte**

1. Dort ansetzen, wo schon der dauerhafte Speicher angefordert wird:
   `verlaufSpeichernPflicht` — die Stelle, die weiss, wann etwas
   Unwiederbringliches entsteht.
2. Ist ein Archiv markiert, wandert der Satz zusätzlich dorthin. **Der
   Browser-Speicher bleibt trotzdem der schnelle Weg** — das Archiv ist die
   dauerhafte Kopie, nicht die einzige. Wer den Browser-Speicher hier
   abhängt, macht jede Anzeige von der Cloud abhängig.
3. Scheitert das Schreiben ins Archiv, darf das den lokalen Weg **nicht**
   umwerfen. Es wird zu `ausstehend` in der Zustandsanzeige — genau dafür
   ist sie da.
4. Die Nachzieh-Warteschlange (Backoff, Reihenfolge, Fortsetzungszeiger)
   vom Juli-Zweig als **Vorlage** nehmen (`archiveQueue.svelte.ts`,
   `archiveQueueStore.ts`), nicht den Code: er hängt am abgelösten Krypto,
   die Fälle nicht.

**Abnahme:** Ein Neustart mitten in der Warteschlange verliert nichts; ein
totes Laufwerk hält den Chat nicht auf.

---

## Aufgabe 4: Die drei Umgebungen

**Entwurf §5.2:**

| Umgebung | Ordner wählbar | Cloud wählbar |
|---|---|---|
| Desktop-App | ja | ja |
| Chrome/Edge | ja | ja |
| Firefox/Safari | **nein** | **ja** |

**Der wichtigste Satz der Etappe:** In Firefox und Safari wird **nichts
abgeschaltet**. Der Verlauf liegt dort weiter im Browser-Speicher, genau wie
bisher. Neu ist nur, dass auch dort ein Archiv möglich ist — über eine
Cloud-Verbindung. Das ist das eigentliche Geschenk der Zusammenlegung: der
ursprüngliche Plan hätte diesen Nutzern nur einen Hinweis auf die App
angeboten.

**Schritte**

1. Die Ordner-Auswahl dort ausblenden, wo sie nicht geht, statt sie
   scheitern zu lassen. `syncOrdnerMoeglich()` gibt es schon.
2. Ein Test je Umgebung, mit vorgetäuschter Plattform-Erkennung.

**Abnahme:** Unter vorgetäuschtem Firefox ist eine Cloud als Archiv wählbar,
ein Ordner nicht, und nichts geht verloren.

---

## Was aus dem alten Plan entfällt

Die Ernte des kompletten `archive/*`-Untersystems (13 Dateien) und die
Electron-Hälfte (`mediaArchive.ts` und Nachbarn, rund 350 Zeilen). Beides
war für ein **zweites** System gebaut. Übernommen wird allein `archiveFsa.ts`
als `ordnerGriff.ts`, und `archiveQueue*` dient als Vorlage für die
Nachzieh-Fälle.

**Damit entfällt auch der Version-Bump** für die Desktop-App in dieser
Etappe: es kommt kein Electron-Code hinzu. Sollte sich das ändern, gilt die
Regel wieder — `desktop/electron/**` geht über den Installer raus, und ohne
Bump ignoriert electron-updater die Auslieferung stillschweigend.

## Abschluss

- `bash scripts/gate.sh` grün, Playwright mindestens so grün wie vorher
- Changelog-Eintrag: ja — „du bestimmst, wo dein Archiv liegt" ist
  user-sichtbar.
