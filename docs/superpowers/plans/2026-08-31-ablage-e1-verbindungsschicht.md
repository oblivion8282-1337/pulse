# E1 — Verbindungsschicht und Einstellungen

> **Für agentische Bearbeiter:** Dieser Plan wird task-für-task abgearbeitet.
> Rahmen: `docs/superpowers/plans/2026-08-31-ablage-etappen.md`.
> Entwurf: `docs/superpowers/specs/2026-08-31-ablage-kanaele-design.md`.

**Ziel:** Ein Ort für Laufwerke — verbinden, Zustand sehen, Probe fahren —
mit drei Anbietern statt fünf, und ohne die Prototyp-Reste.

**Zweig:** `feat/e2e-dm-krypto-weg-a`

## Globale Randbedingungen

Gelten für jede Aufgabe, ohne Wiederholung:

- Test-Läufer im Web ist **Nodes eingebauter** (`pnpm test:unit`), kein
  Vitest. **Eine geprüfte Datei darf keinen erweiterungslosen
  Laufzeit-Import haben** — reine Rechnungen in importfreie Module ziehen
  (Muster: `lib/navigation/tabs.ts`, `lib/krypto/sichererBlobTyp.ts`).
- Quelldateien ≤ 350 Zeilen (hart 500), Svelte-Komponenten ≤ 250.
- Kommentare und Testnamen auf Deutsch, echte Umlaute, **keine Emojis**.
- Keine neuen Abhängigkeiten ohne Rückfrage.
- **Niemals Zugangsdaten, Tokens oder Freigabe-Adressen loggen.**
- **Ein Kommentar darf nicht mehr behaupten, als er hält** — jeden Grund am
  Code an dieser Stelle prüfen.
- Vor jedem Wert-, Pfad- oder Namenswechsel `command grep -rn "<alt>"`;
  `command grep`/`command find`/`command sed` benutzen, die blanken Namen
  sind auf dieser Maschine durch Hüllen ersetzt.
- Vor jedem Commit: `pnpm test:unit` und `pnpm check` grün.

---

## Ausgangslage (erhoben 2026-08-31)

| Stück | Zustand |
|---|---|
| `web/src/lib/components/settings/AblageSektion.svelte` (137 Z.) | Prototyp. Hängt unter `SettingsSecurity.svelte:111`. **Legt den Ablage-Hauptschlüssel in `localStorage` ab** und erzeugt ihn dort ad hoc. **Baut den Speicher-Adapter inline nach**, obwohl sie `adapterAusVerzeichnis` aus `syncOrdner.ts` bereits importiert. |
| `web/src/lib/ablage/verbindungen.ts` (153 Z.) | Der vorgesehene Ort: Verbindungen und Hauptschlüssel gerätelokal in IndexedDB, nie am Server. Wird von der Sektion nicht benutzt. |
| `web/src/routes/app/ablage/+page.svelte` (346 Z.) | Eigene Seite mit Dropbox-OAuth, Sync-Ordner, Dateiliste. **Harter Dropbox-Schlüssel im Quelltext.** Emoji-Dateisymbole neben lucide-Icons. |
| `web/src/routes/ablage-probe/+page.svelte` (154 Z.) | Testseite. |
| `oauth.ts`, `dropbox.ts`, `gdrive.ts` | `auffrischeZugang` ist exportiert, **wird aber nirgends aufgerufen** — es gibt keinen Auffrisch-Weg (Befund aus E0). |
| `onedrive.ts`, `s3.ts` | Gebaut, unit-geprüft, **fallen aus der Oberfläche** (Entscheidung 2026-08-31). Dateien bleiben im Baum. |

---

## Aufgabe 1: Ein Ort für die Schlüssel — `localStorage` raus

**Warum zuerst:** Solange zwei Schlüsselquellen nebeneinander leben, baut
jede weitere Aufgabe auf der falschen. `localStorage` ist ausserdem
synchron für jedes Skript im Ursprung lesbar; ein Hauptschlüssel gehört
dorthin, wo schon die Geräteschlüssel liegen.

**Dateien**
- Ändern: `web/src/lib/components/settings/AblageSektion.svelte`
- Nutzen: `web/src/lib/ablage/verbindungen.ts`
- Test: `web/test/ablage-verbindungen.test.ts` (anlegen, falls nicht da)

**Schritte**
1. Lesen: `verbindungen.ts` ganz — welche Schnittstelle bietet der Store für
   Anlegen, Lesen und Hauptschlüssel?
2. Test schreiben, der festhält: eine neu angelegte Verbindung trägt ihren
   Hauptschlüssel im Store, und ein zweiter Aufruf legt **keinen zweiten**
   Schlüssel an. Erst rot sehen.
3. `holeSchlüssel()` aus der Komponente entfernen; den Schlüssel über
   `verbindungen.ts` beziehen.
4. Den inline nachgebauten Adapter durch `adapterAusVerzeichnis` ersetzen —
   der Import steht schon in der Datei.
5. `command grep -rn "pulse-ablage-hauptschluessel" web/` — die Zeichenkette
   darf danach nirgends mehr stehen. **Wandert ein bestehender Schlüssel
   mit?** Entscheide bewusst und schreibe die Entscheidung in den Code: ohne
   Umzug ist jede bereits abgelegte Datei unlesbar. Da die Ablage bisher nur
   auf Testgeräten lief, ist "kein Umzug" vertretbar — aber nur, wenn es
   dasteht.
6. `pnpm test:unit`, `pnpm check`, committen.

**Abnahme:** Kein Ablage-Schlüssel mehr in `localStorage`; die Sektion
benutzt Store und Adapter, statt beides nachzubauen.

---

## Aufgabe 1b: Drei Anläufe zur selben Sache — zwei davon tot

**Erhoben 2026-08-31.** Die Ablage-Verbindung ist in derselben Nacht **dreimal**
gebaut worden, und nur der schlechteste Anlauf ist erreichbar:

| Stück | Zeilen | Wer benutzt es |
|---|---|---|
| `lib/stores/ablage-verbindungen.svelte.ts` | 157 | **niemand** |
| `lib/ablage/verbindungen.ts` | 153 | nur `AblageVerbindenDialog.svelte` |
| `lib/components/ablage/AblageVerbindenDialog.svelte` | 180 | **niemand** |
| `lib/components/ablage/DateiablageAnsicht.svelte` | 185 | **niemand** |
| `lib/components/settings/AblageSektion.svelte` | 137 | `SettingsSecurity.svelte` — **der einzige erreichbare Weg, und der mit `localStorage`** |

Beide Stores definieren `AblageAnbieterArt` und `AblageVerbindung` doppelt —
zwei Quellen für dieselbe Wahrheit, von denen eine niemand liest.

**Zu tun:**

1. `lib/stores/ablage-verbindungen.svelte.ts` löschen. Vorher prüfen, ob er
   etwas kann, was der andere nicht kann (er exportiert zusätzlich
   `bytesZuBase64`/`base64ZuBytes` — wandern lassen, falls gebraucht), und
   **danach** `command grep -rn` auf den Pfad, inklusive Bau-Rezepte und
   Tests.
2. `AblageVerbindenDialog.svelte` und `DateiablageAnsicht.svelte` **nicht**
   löschen: der Dialog ist genau das, was Aufgabe 5 braucht, die Ansicht
   gehört zu E8. In beide einen Kopfsatz schreiben, worauf sie warten —
   sonst hält sie beim nächsten Aufräumen jemand für Leichen.
3. Die Emoji-Symbole im Dialog durch lucide-Icons ersetzen (Hausregel).

**Warum das vor Aufgabe 5 kommt:** Wer die Zustandsanzeige an den falschen
der beiden Stores hängt, baut die Doppelung fest ein.

---

## Aufgabe 2: Anbieterliste an genau einer Stelle

**Warum:** Wird die Auswahl an jeder Anzeigestelle einzeln gefiltert, ist die
nächste Stelle die, die es vergisst.

**Dateien**
- Anlegen: `web/src/lib/ablage/anbieter.ts` (**importfrei**)
- Ändern: alle Stellen, die heute eine Anbieterliste aufzählen — vorher
  `command grep -rln "onedrive\|OneDrive" web/src` und dasselbe für `s3`
- Test: `web/test/ablage-anbieter.test.ts`

**Schritte**
1. `anbieter.ts` mit einer Liste je Anbieter: technische Kennung,
   Anzeigename, ob er in der Oberfläche angeboten wird, und ob er eine
   erreichbare Adresse für andere liefern kann (Kanäle brauchen das,
   Entwurf §2.2).
2. Test: die angebotene Liste enthält genau Google Drive, Nextcloud und
   Dropbox — und **nicht** OneDrive oder S3. Der Test nennt die drei
   ausdrücklich; eine Behauptung wie "genau drei" prüft nichts.
3. Alle gefundenen Stellen auf diese eine Liste umstellen.
4. In `onedrive.ts` und `s3.ts` je einen Kopfsatz ergänzen: gebaut,
   unit-geprüft, **nicht angeboten** — mit dem Grund (OneDrive braucht ein
   Azure-Konto mit Kartenprüfung und ist nie echt gelaufen; S3 hat eine zu
   schmale Zielgruppe).

**Abnahme:** `command grep` findet keine zweite Anbieteraufzählung mehr.

---

## Aufgabe 3: Die Verbindungsprobe

**Warum:** Ein Laufwerk, das nicht schreiben kann, darf sich nicht als
verbunden melden — sonst legt jemand einen Kanal darauf an.

**Dateien**
- Anlegen: `web/src/lib/ablage/probe.ts`
- Test: `web/test/ablage-probe.test.ts`

**Schnittstelle**
```ts
export type ProbeSchritt = 'schreiben' | 'lesen' | 'vergleichen' | 'loeschen';
export type ProbeErgebnis =
  | { gut: true }
  | { gut: false; schritt: ProbeSchritt; grund: string };

export function probiere(adapter: AblageAdapter): Promise<ProbeErgebnis>;
```

**Schritte**
1. Tests zuerst, einer je Fehlschlag-Schritt plus der gute Fall. Der
   Testadapter aus `adapter.ts::speicherAdapter` ist die Grundlage; für die
   Fehlschläge wird je eine Methode ersetzt.
2. Umsetzung: eine Datei mit zufälligem Namen und zufälligem Inhalt
   schreiben, zurücklesen, **byteweise vergleichen**, löschen. Der
   Vergleich ist der eigentliche Punkt — ein Anbieter, der schreibt und
   etwas anderes zurückgibt, fällt sonst nicht auf.
3. Nach dem Lauf aufräumen, **auch wenn ein Schritt scheitert**. Eine
   liegengebliebene Probedatei in einem fremden Cloud-Ordner ist ein
   schlechter erster Eindruck.
4. Der Name der Probedatei muss erkennbar sein (etwa
   `pulse-probe-<zufall>.tmp`), damit ein Nutzer sie zuordnen kann, wenn das
   Aufräumen doch scheitert.

**Abnahme:** Jeder der vier Schritte lässt sich einzeln zum Scheitern
bringen, und das Ergebnis nennt genau den Schritt.

---

## Aufgabe 3b: Löschen löscht nicht

**Erhoben beim Bau der Probe, 2026-08-31.** `lösche` ist im Adapter-Vertrag
optional (`adapter.lösche?.()`), und **kein einziger der angebotenen
Cloud-Adapter setzt es um** — nur `syncOrdner.ts` und der Testadapter im
Speicher. Dropbox, Google Drive und Nextcloud haben es nicht.

Zwei Folgen, und beide sind ernst:

1. **`DateiSpeicher.löschen()` löscht nichts.** Es entfernt den
   Verzeichniseintrag und ruft `adapter.lösche?.()` ins Leere. Der
   verschlüsselte Container bleibt für immer auf dem Laufwerk. Der Nutzer
   sieht die Datei verschwinden und glaubt, sie sei weg — bei einem Produkt,
   dessen Versprechen die Hoheit über die eigenen Daten ist, ist das die
   falsche Sorte Überraschung. Der Kommentar an der Stelle sagt „wo der
   Adapter das anbietet"; das ist formal richtig und verschleiert, dass es
   heute nirgends angeboten wird.
2. **Die Verbindungsprobe scheitert dadurch bei jedem angebotenen
   Anbieter.** Ihre strenge Haltung (ohne Löschen keine gute Verbindung) ist
   richtig — sie deckt gerade auf, dass die Adapter unvollständig sind. Wer
   sie stattdessen aufweicht, macht die Probe wertlos.

**Zu tun:** `lösche` in `dropbox.ts`, `gdrive.ts` und `webdav.ts` umsetzen —
alle drei haben eine Löschschnittstelle. Je Adapter ein Test mit gefälschtem
Transport. Danach den Kommentar an `DateiSpeicher.löschen()` berichtigen: er
darf nicht länger offenlassen, ob gelöscht wird.

**Erst nach Aufgabe 4**, sonst kollidiert es mit deren Änderungen an
denselben zwei Dateien.

---

## Aufgabe 4: Der Auffrisch-Weg

**Warum:** Befund aus E0 — `auffrischeZugang` existiert und wird von
niemandem aufgerufen. Ein abgelaufener Zugang beendet die Verbindung heute
endgültig und unbemerkt. Das ist der häufigste Dauerfehler dieser Bauart.

**Dateien**
- Ändern: `web/src/lib/ablage/oauth.ts`, `dropbox.ts`, `gdrive.ts`
- Test: `web/test/ablage-oauth.test.ts`

**Schritte**
1. Erst lesen und aufschreiben, WO ein 401 heute ankommt — in welcher
   Funktion, mit welchem Fehler.
2. Test zuerst: ein Adapter, dessen erster Aufruf 401 liefert und dessen
   zweiter gelingt, führt genau **eine** Auffrischung und danach den
   ursprünglichen Aufruf erneut aus.
3. Zweiter Test: **zwei gleichzeitige** Aufrufe, die beide auf 401 laufen,
   lösen zusammen genau **eine** Auffrischung aus. Ohne dieses Merken des
   laufenden Versprechens verbrennen bei Anbietern mit rotierenden
   Auffrisch-Tokens beide den Zugang.
4. Umsetzung; der neue Zugang wird über `verbindungen.ts` zurückgeschrieben,
   sonst ist er beim nächsten Start wieder weg.
5. Schlägt die Auffrischung fehl, bekommt die Verbindung einen Zustand, den
   Aufgabe 5 anzeigen kann — **nicht** stillschweigend nichts.

**Abnahme:** Beide Tests grün; ein abgelaufener Zugang erneuert sich, ein
endgültig ungültiger wird sichtbar.

---

## Aufgabe 5: Der Verbindungszustand

**Dateien**
- Anlegen: `web/src/lib/ablage/zustand.ts` (**importfrei** — die Einstufung
  ist reine Rechnung und gehört unter Test)
- Anlegen: `web/src/lib/components/settings/SpeicherSektion.svelte`
- Anlegen: `web/src/lib/components/settings/SpeicherVerbindungZeile.svelte`
- Test: `web/test/ablage-zustand.test.ts`

**Was angezeigt wird** (Entwurf §6.2): Anbieter, verbunden seit, zuletzt
gesichert, wie viel aussteht, Kontingent soweit der Anbieter es meldet, und
ob das Ziel hinterherhängt.

**Schritte**
1. `zustand.ts`: aus den Rohwerten eine Einstufung rechnen —
   `gut` · `hinterher` · `anmeldung-abgelaufen` · `laufwerk-weg` ·
   `kein-platz`. Tests je Fall, **und einer für die Reihenfolge**: liegt
   mehr als eine Sache gleichzeitig an, muss die Anzeige die dringlichste
   nennen. Welche das ist, gehört als Begründung in den Code.
2. Die Sektion baut auf `MediaArchiveBlock.svelte` von
   `origin/feat/dm-attachment-e2ee` auf (E0.5) — lesen mit
   `git show origin/feat/dm-attachment-e2ee:web/src/lib/components/settings/MediaArchiveBlock.svelte`.
   Übernommen wird der Zuschnitt, **nicht** die Anbindung an das dortige,
   abgelöste Krypto.
3. `SettingsPanel.svelte` bekommt den neuen Abschnitt; `AblageSektion`
   verschwindet aus `SettingsSecurity.svelte` — Speicher ist kein
   Sicherheitsthema.
4. Kontingent nur anzeigen, wo der Anbieter es liefert. **Erst am echten
   Anbieter prüfen, welcher das tut** (offene Frage 4 des Entwurfs), und das
   Ergebnis am Code vermerken statt aus der Doku zu folgern.

**Abnahme:** Für jeden der fünf Zustände zeigt die Zeile das Richtige;
`pnpm check` grün.

---

## Aufgabe 6: Prototyp-Reste entfernen

**Reihenfolge beachten** — zuletzt, damit die Vorlagen bis dahin lesbar
bleiben.

**Schritte**
1. `web/src/routes/ablage-probe/` ersatzlos löschen.
2. `web/src/routes/app/ablage/` als Menüpunkt entfernen. Die Dateiansicht
   wird in E8 zur Community-Dateiablage; **bis dahin nicht löschen**,
   sondern aus der Navigation nehmen und im Dateikopf vermerken, worauf sie
   wartet.
3. Den harten Dropbox-Schlüssel aus dem Quelltext an dieselbe Stelle ziehen,
   an der die übrigen Anbieter-Kennungen liegen.
4. **`command grep -rn` auf jeden gelöschten Pfad** — die Regel gilt fürs
   Löschen genauso, und die blinden Flecken sind Bau-Rezepte
   (`Dockerfile*`, Compose, `.github/workflows/**`) und Testdateien, die
   eine Route ansteuern.
5. Emoji-Dateisymbole durch lucide-Icons ersetzen (Hausregel: keine Emojis).

**Abnahme:** `pnpm build` grün, kein toter Verweis, Playwright kennt keine
gelöschte Route mehr.

---

## Abschluss der Etappe

- `bash scripts/gate.sh` grün
- `cd web && pnpm exec playwright test` — mindestens so grün wie vorher
- Changelog-Eintrag: **ja**, hier wird zum ersten Mal etwas
  Nutzer-Sichtbares umgestellt (Einstellungen, verschwundener Menüpunkt).
  Stil vom Eigentümer wählen lassen, echte Umlaute, keine Emojis.
