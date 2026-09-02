# Bughunt Sicherung (Gesprächsordner + Lazy-Laden) — 2026-09-02

Adversarial-Hunt über den Stand von heute Nacht (Zweig `e2ee`: Ordner-Format,
seitenweises Laden, Grabsteine). Zwei frische Jäger (Schreibseite, Lese-/Anzeige-
seite), schwerste Befunde vom Assistenten selbst gegen den Code nachgefahren.
Methodik §6. 10 Befunde — B1–B6 + B8 GEFIXT (Commit nach Bericht, 2026-09-02 Nacht), alle 10 gefixt (B7/B9/B10 im Folgeturn). Reihenfolge = Priorität.

## Hoch

**B1 | Lock-Selbst-Deadlock nach Abmeldung + Neuanmeldung im selben Tab.**
`andock.ts` (spiegelFallsBereit): das Web-Lock wird in einem Callback gehalten,
der nie endet; `sicherungVerwerfen` setzt `spiegelBau = null`, das zugrunde
liegende Halten lebt weiter. Nach Logout→Login queues der zweite Request hinter
dem eigenen Nie-Ende → jede Sicherungsaktion hängt still (nur IDB-Puffer).
Zusätzlich: der request-`.catch` setzt `spiegelBau` nicht zurück. Vorschlag:
Lock-Handle merken und in `sicherungVerwerfen` releasen; im `.catch` Rücksetzen.
[Vom Assistenten verifiziert.]

**B2 | `sicherungGespraechEntfernen` + in-Flight-Spiegelbau = gelöschte
Unterhaltung kehrt ins Archiv zurück.** Bau beginnt (Map-Eintrag fehlt noch),
Nutzer löscht Gespräch (Ordner geleert, Puffer gewischt), Bau endet DANACH:
`spiegelJeKanal.set` + alter `pufferAlles`-Schnappschuß spülen den Ordner neu
voll. Vorschlag: Generations-Token je Kanal, Bau bricht bei Wechsel ab.

**B3 | `ordnerLeeren` bricht beim ersten Löschfehler ab → Teillöschung wird
dauerhaft.** Kein je-Datei-catch; ein totes Ziel fällt bei `adapterLieferant`
still aus der Runde — der Überrest im anderen Ziel wird vom Bulk-Lesen
wiedergefunden: gelöschte Unterhaltung kehrt auf allen Geräten zurück.
Vorschlag: je-Datei-catch + Bestandsprüfung (`liste().length === 0`).

## Mittel

**B4 | Puffer-Schlüssel kennt den Grabstein nicht.** Puffer nutzt
`<kanalId>:<id>`, Spiegel-Dedup `<kanalId>:<id>:geloescht` — Stein und Inhalt
überschreiben sich im Puffer gegenseitig; Absturz dazwischen = Löschung
erreicht das Archiv nie. Vorschlag: Marker auch in `pufferLegen`/`pufferWeg`.

**B5 | Kanal-öffnen-Gate zählt Grabsteine.** `dmKanalWechsel`: `lokal.length <
50` zählt Grabstein-Sätze mit — 40 sichtbare + 10 Steine = kein Archiv-Nachladen,
Ansicht bleibt lückenhaft. Spitze: ≥50 nur Steine + leerer Server = leerer Chat
ohne Hochscroll-Weg. Vorschlag: Gate über `deleted_at === null`-gefilterte Länge.

**B6 | Hochscroll-Archivseite nicht an `oldest` verankert.** Die Seite liefert
die neuesten 50 (schon sichtbar) → `nachgeladen` leer → Fall-through zum Server
→ `hasMore = false` dauerhaft; zugleich landen unsichtbare (neuere) Nachrichten
nur im Verlauf. Vorschlag: Lesestand-`hoch` beim ersten Archiv-Aufruf auf
`oldest` setzen, oder `hasMore=false` unterdrücken, wenn die Archivseite > 0
lieferte.

## Niedrig

**B7 | Fallback ohne Locks-API: zwei Tabs kämpfen um denselben Geräte-Präfix** —
Retry-Schleife hängt die Partie je Versuch erneut an, Segmente wachsen.
Vorschlag: `bestandAufnehmen()` vor jedem Retry.

**B8 | „Jetzt sichern" bedient den wartenden Tab nicht** (Puffer-Abgleich läuft
nur in `nachSpülung` des aktiven Schreibers). Verlustfrei, aber still.
Vorschlag: vor dem Spülen einmal `pufferAlles()` einsammeln.

**B9 | Aktive WS-Lücke überspringt den Archiv-Zweig** (der Block hängt in der
`betrifftLuecke`-Klammer); bei leerer Server-Antwort bleibt `hasMore = false`
für die Session. Vorschlag: Archiv-Zweig aus der Lücken-Klammer lösen.

**B10 | Bulk-„Archiv laden" liest je Kanal-Ordner zweimal komplett** (zweiter
Lauf bestätigt nur Erschöpfung, überträgt aber erneut). Vorschlag: Erschöpfung
ohne zweiten Lauf erkennen.

## Widerlegte Verdachtsmomente (damit niemand doppelt gräbt)

Fenster {hoch, tief} verliert keine Neuankömmlinge (überHoch/imFenster-Doppel-
grenze). Grabsteine landen nie als tote Zeilen in der Anzeige (verlaufMergen +
kanalSeiteFüttern). Konkurrierende Lesestand-Schreibvorgänge: last-wins kostet
nur Wieder-Auslieferung (Upsert dedup), nie eine Lücke. Leerer Ordner/fehlendes
Manifest = saubere 0. Erstsicherung spiegelt keine Grabstein-Zeilen. Beide
Ziel-Adapter implementieren `lösche`.

## Sekundärliteratur

Basis: `8bd92e2b` (Merge) + Ordner-Feature `356ec52d` + Lösch-Feature
`54661b85`. Jäger-Berichte nach §6 behandelt; B1 und B3 vom Assistenten
nachgefahren und bestätigt.

## Ergänzung 2026-09-02 (E2EE-Test auf lokalem Stack)

**B11 | HOCH (UX/Funktion) | Desktop-App bekommt den „braucht ein Gerät"-Wall statt Geräte-Setup.**
`DmOhneAppGeraet.svelte` bietet nur „Apps herunterladen" + „Browser koppeln" —
mitten in der Electron-App. Das lokale Test-Konto hat nie Geräte-Schlüssel
ausgestellt bekommen; die Wand erscheint dadurch JEDES Mal beim DM-Öffnen
(`GET /keys/verschluesselbar/{eigene_id}` = false). Erwartet: In der App
entweder automatisches Geräte-Setup beim Login oder der Wall-Knopf „Gerät
jetzt einrichten". Ohne diesen Weg sind verschlüsselte DMs auf einem frischen
App-Profil unerreichbar — Blocker für den E2EE-Test auf lokalem Stack. GEFIXT (2026-09-02): Ursache war ein Rennen — die Wand-Cached-Antwort (false) gewann gegen die erst danach laufende Schlüssel-Veröffentlichung und blieb die ganze Session stehen;Publish-Fehler wurden zudem still geschluckt. Neu: Frisch-Nachfrage nach dem Setup-Flow (Wand heilt sich selbst), „Gerät jetzt einrichten"-Primärknopf in App-Kontexten (Electron/Android), sichtbare Fehlschläge mit Retry, Browser unverändert. 1092 Tests grün.
