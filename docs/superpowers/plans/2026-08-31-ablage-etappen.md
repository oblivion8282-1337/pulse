# Ablage-Kanäle — Rahmenplan der Etappen

> **Für agentische Bearbeiter:** Dieser Rahmenplan ist KEIN ausführbarer Plan.
> Jede Etappe bekommt vor ihrer Ausführung einen eigenen Detailplan unter
> `docs/superpowers/plans/2026-08-31-ablage-<etappe>.md`, und der wird mit
> `superpowers:subagent-driven-development` abgearbeitet.

**Ziel:** Kanäle und Community-Dateien liegen verschlüsselt auf dem
Cloud-Laufwerk ihres Erstellers, gelesen wird direkt von dort, geschrieben
über Pulse — mit persönlichem Archiv, Wiederherstellung und Spiegelung.

**Entwurf:** `docs/superpowers/specs/2026-08-31-ablage-kanaele-design.md`
(die Etappen argumentieren aus diesem Entwurf; beide zusammen lesen)

**Zweig:** `feat/e2e-dm-krypto-weg-a`

---

## Globale Randbedingungen

Gelten für **jede** Etappe, ohne dass sie dort wiederholt werden:

- **Test-Gate vor jedem Commit-Block:** `bash scripts/gate.sh` — rot heißt,
  die Etappe ist nicht fertig. Playwright hängt in keinem Gate und wird
  zusätzlich gefahren, wo die Etappe UI berührt.
- **Größen-Policy:** Quelldateien ≤ 350 Zeilen (hart 500), Svelte-Komponenten
  ≤ 250. Ausgenommen Tests, Migrationen, `lib/components/ui/`.
- **Keine neuen Abhängigkeiten ohne Rückfrage.** Vorhandenes nutzen:
  `krypto/pulse-krypto` (WASM) für Krypto, `web/src/lib/ablage/*` für Speicher.
- **Unit-Tests im Web laufen über Nodes eigenen Läufer** (`pnpm test:unit`),
  nicht Vitest. Eine geprüfte Datei darf **keinen erweiterungslosen
  Laufzeit-Import** haben — reine Rechnungen in importfreie Module ziehen
  (Muster: `lib/remote/zeigerbildPruefung.ts`, `lib/navigation/tabs.ts`).
- **Snowflake-IDs sind über die API immer Strings.**
- **Niemals Zugangsdaten, Tokens oder Freigabe-Adressen loggen.**
- **Changelog:** user-sichtbare Änderungen brauchen einen Eintrag oben in
  `web/static/changelog.json`, echte Umlaute, keine Emojis.
- **Behauptungen nie an einer Stelle korrigieren** — vor jeder Wert-, Pfad-
  oder Verhaltensänderung `command grep -rn "<alter Wert>"`. Gilt auch fürs
  Löschen: der Pfad einer Datei ist eine Behauptung (Bau-Rezepte und
  Lizenztexte sind die blinden Flecken).
- **Kein `git push`, kein Merge nach `main` ohne Freigabe des Eigentümers.**

## Agenten-Politik (Kostenstufen)

Modellwahl je Aufgabenart — Vorgabe des Eigentümers, 2026-08-31:

| Stufe | Wofür |
|---|---|
| **Haiku** | Mechanisches: Datei-Inventare, `grep`-Sweeps über Fundstellen, Fundstellen-Listen, Umbenennungen, Doku-Querverweise prüfen |
| **Sonnet** | Regelfall: Implementierung nach Detailplan, Tests schreiben, UI-Komponenten, Adapter, Routen, Fehlersuche mit klarer Spur |
| **Opus** | Nur wo Fehler teuer sind: Krypto (Sitzungen, Schlüsselverteilung, Wiederherstellung), Sicherheitsprüfung der Weiterreich-Route, Gegenprüfung von Bughunt-Funden, Entwurfsentscheidungen |

Regel: **im Zweifel eine Stufe niedriger anfangen** und erst hochgehen, wenn
das Ergebnis nicht trägt. Ein Fund aus einer niedrigen Stufe wird auf der
nächsthöheren gegengeprüft, bevor er als Wahrheit gilt.

---

## Zweiglandschaft — was schon vorgearbeitet ist

Erhoben am 2026-08-31. Zwei Zweige tragen Arbeit, die **nicht** in
`feat/e2e-dm-krypto-weg-a` steckt:

| Zweig | Stand | Bedeutung für uns |
|---|---|---|
| `feat/dm-attachment-e2ee` | 2026-07-20, 53 Commits, nie gelandet | **Erntbar.** Enthält lokales Medien-Archiv mit File System Access API, Schlüssel-Sicherung samt Wiederherstellungs-Oberfläche, neustartfeste Warteschlange, `navigator.storage.persist()`, dazu vier E2E-Specs. Deckt Teile von E1, E3, E4 vorweg. Einschränkung: stammt aus der Zertifikats-Zeit (auf `main` am 2026-08-28 entfallen) und aus der Zeit vor `krypto/pulse-krypto` — nicht alles trägt noch. |
| `feat/zwischenablage-kiste` | 2026-08-31, 56 Commits | **Nicht unser Thema.** Trotz des Commit-Bereichs `(ablage)` geht es um die geteilte **Zwischenablage der Fernsteuerung** (Sidecar, Renderer, macOS-Host), nicht um Dateiablage. Namenskollision — nicht verwechseln, nicht mergen. |

Bereits enthalten und deshalb ohne Handlungsbedarf: `feat/kanal-eigene-ablage`
(gemergt, Commit `b6142cbe`), `feat/e2e-dm-krypto`, `weg-a-test-basis`,
`plan/e2e-dm-uebergabe`.

---

## Etappen und Abhängigkeiten

```
E0 Messen + Bughunt
 ├─→ E0.5 Vorarbeit ernten (feat/dm-attachment-e2ee)
 │    └─→ speist E1, E3, E4
 ├─→ E1 Verbindungsschicht + Einstellungen-UI
 │    ├─→ E2 Nextcloud Login Flow v2
 │    ├─→ E3 Persönliches Archiv im Ordner
 │    │    └─→ E4 Wiederherstellungs-Satz
 │    └─→ E5 Spiegelung auf zwei Laufwerke
 └─→ E6 Kanal-Krypto (Gruppensitzungen + Ablage-Log)
      ├─→ E7 Freigabe-Adresse + Leseweg (direkt / über Pulse)
      │    └─→ E8 Community-Dateiablage
      └─→ E9 Umstellung (nur-Ablage überall, Alt-Kanäle nur lesbar)
E10 Klartext-Export      (nach E3)
E11 Kopplungs-E2E        (nach E6)
E12 Landen               (alles grün)
```

E1–E5 (Speicher) und E6–E8 (Krypto) sind weitgehend unabhängig und können
parallel laufen.

---

### E0 — Messen, dann gezielt jagen

**Zweck:** Erst wissen, wo es steht, dann suchen. Entscheidung des
Eigentümers gegen einen blinden Volldurchlauf über alle 378 Dateien.

1. Ist-Stand messen: `bash scripts/gate.sh` (voll, `PULSE_GATE_VOLL=1`),
   `pnpm check`, `pnpm build`, `pnpm test:unit` (web **und** desktop),
   Playwright, `cargo test` für `krypto/pulse-krypto`.
2. Ergebnis als Tabelle festhalten: was rot ist, was gar nicht erst läuft,
   was auf `main` ebenfalls rot ist (also kein Regressionsbefund).
3. Gezielter Bughunt mit Agenten auf: was rot war, was neu und ungetestet
   ist, und die vier Stellen mit der höchsten Fehlerdichte in diesem Projekt
   (Koexistenz/Mischzustände, Gnadenfristen und Zeitachsen, Rückfall-Zweige,
   dreifach synchron zu haltende Listen).
4. Jeder Fund wird von einem zweiten Agenten gegengeprüft, der ihn zu
   **widerlegen** versucht. Nur was das übersteht, wird gefixt.
5. Fixes mit Test, der vorher rot ist.

**Abnahme:** Gate grün. Eine Liste der Funde mit Zustand (gefixt /
Nicht-Fehler / bewusst offen) im Etappenbericht.

**Modelle:** Messen Haiku, Bughunt Sonnet, Gegenprüfung Opus.

---

### E0.5 — Vorarbeit aus `feat/dm-attachment-e2ee` ernten

**Zweck:** Nichts zweimal bauen, und vor allem nichts zweimal ausprobieren,
was dort schon gescheitert ist.

- Datei für Datei urteilen: **übernehmen** (läuft heute noch), **anpassen**
  (Kern gut, hängt an Abgelöstem) oder **verwerfen** (obsolet). Massgeblich
  sind zwei Ablösungen: Zertifikate sind seit 2026-08-28 weg, und Krypto
  liegt heute in `krypto/pulse-krypto` (Rust/WASM) statt in TypeScript.
- Die verworfenen Wege aus der Übergabe-Notiz jenes Zweigs in den Entwurf
  §11 übernehmen, damit E4 sie nicht erneut prüft.
- Übernommenes wird **einzeln** mit Test und Commit eingebracht, nicht als
  Zweig-Merge — der Juli-Zweig hängt an einer Welt, die es nicht mehr gibt.

**Abnahme:** Eine Urteilstabelle im Etappenbericht; alles mit Urteil
„übernehmen" ist eingebracht und grün.

**Modelle:** Sichtung Sonnet, Krypto-Urteile Opus.

---

### E1 — Verbindungsschicht und Einstellungen

**Zweck:** Ein Ort für Laufwerke, drei Anbieter, sichtbarer Zustand.

- Anbieterauswahl auf Google Drive, Nextcloud, Dropbox reduzieren; OneDrive
  und S3 bleiben im Baum, verschwinden aus der Oberfläche (an **einer** Stelle
  gegatet, nicht an jeder Anzeigestelle).
- Einstellungs-Abschnitt „Speicher": verbinden, Zustand, Ordner, Spiegel,
  Export, Wiederherstellung. `AblageSektion.svelte` ist der Ausgangspunkt.
- `/ablage-probe` ersatzlos löschen; `/app/ablage` als Menüpunkt entfernen,
  Dateiansicht zieht nach E8 um.
- Verbindungszustand je Laufwerk (Entwurf §6.2).
- Schreib-Lese-Vergleich-Lösch-Probe beim Verbinden (§6.3), mit Anzeige,
  an welchem Schritt es scheiterte.
- Harter Dropbox-Schlüssel im Quelltext prüfen und an die vorgesehene
  Konfigurationsstelle ziehen.

**Abnahme:** Verbinden, Zustand und Probe laufen für alle drei Anbieter;
Testseite ist weg; `pnpm check` und `pnpm test:unit` grün.

**Modelle:** Sonnet; Fundstellen-Sweeps Haiku.

---

### E2 — Nextcloud Login Flow v2

**Zweck:** Adresse eintippen, zustimmen, fertig.

- Zuerst **messen** (Entwurf §11.1): setzt der Poll-Endpunkt CORS-Header?
  Das Ergebnis entscheidet, ob der Weg im Browser direkt geht oder App-only
  wird. Ergebnis am Code vermerken, nicht aus Doku folgern.
- Anmelde-Start, Poll-Schleife mit Zeitlimit, Übernahme von Benutzername und
  App-Passwort nach `verbindungen.ts`.
- Manuellen App-Passwort-Weg aus der Oberfläche nehmen.

**Abnahme:** Ein echter Durchlauf gegen eine echte Nextcloud, protokolliert.

**Modelle:** Sonnet.

---

### E3 — Persönliches Archiv im Ordner

**Zweck:** Der Nutzer bestimmt, wo sein verschlüsseltes Archiv liegt.

- Electron: Ordnerdialog, Pfad in `desktop/electron/store.ts`, Dateizugriff
  über IPC; Renderer-Fassade `window.pulse.*` mit `preload.ts` und
  `web/src/lib/platform/pulse.d.ts` synchron halten.
- Chromium: File System Access API, Griff in IndexedDB, Berechtigung beim
  Start erneut bestätigen, Rückfall auf Browser-Speicher mit Meldung.
- Firefox/Safari: unverändert wie heute, plus Hinweis auf die App. **Nichts
  abschalten** — ausdrückliche Entscheidung.
- Archivinhalt: DMs, Kanalverläufe, Dateien.

**Abnahme:** In der Desktop-App liegt nach einem Neustart derselbe Verlauf
im gewählten Ordner; Firefox verliert nichts.

**Modelle:** Sonnet; Electron-IPC-Teil Sonnet.

---

### E4 — Wiederherstellungs-Satz

**Zweck:** Alle Geräte weg heißt nicht Archiv weg.

- Wörterfolge erzeugen und anzeigen, Bestätigungsabfrage.
- Ableitung in `krypto/pulse-krypto` (WASM), keine neue Abhängigkeit.
- Verschlüsseltes Päckchen mit Archiv-Hauptschlüsseln und Geräte-Identität;
  liegt in der Ablage **und** als undurchsichtiger Block auf Pulse.
- Wiederherstellungsweg: Satz eingeben, Päckchen holen, Archiv öffnen.

**Abnahme:** Test, der alle Geräte-Schlüssel löscht und allein mit dem Satz
wieder an den Klartext kommt.

**Modelle:** **Opus** (Krypto).

---

### E5 — Spiegelung auf zwei Laufwerke

**Zweck:** Ein gesperrtes Konto kostet nicht den Verlauf.

- Schreiber schreibt an alle Ziele; Runde gilt als erfolgreich bei ≥ 1
  Bestätigung; zurückgefallenes Ziel wird markiert und nachgeführt.
- Zustand je Ziel in der Anzeige aus E1.

**Abnahme:** Test, in dem ein Ziel dauerhaft fehlschlägt und nach dessen
Rückkehr vollständig aufholt.

**Modelle:** Sonnet.

---

### E6 — Kanal-Krypto: Gruppensitzungen und Ablage-Log

**Zweck:** Der eigentliche Ablage-Kanal.

- Gruppensitzungen nach `2026-08-28-etappe-g1-private-gruppen-kanal.md`.
- Rahmen Typ 2 (verschlüsselt) im Ablage-Log; Manifest verschlüsselt.
- Postfach als Quelle des Nachziehers, `quelle.ts` (Klartext-REST) tritt ab.
- Schlüsselverteilung beim Beitritt (Entwurf §3.1): Gruppensitzung,
  Ablage-Hauptschlüssel, Freigabe-Adresse.
- Rotation bei Mitgliederwechsel (§3.2).

**Abnahme:** Zwei-Geräte-Lauf gegen den Hetzner-Stack: verschlüsselt
schreiben, festigen, mit zweitem Gerät aus der Ablage lesen; Gegenprobe in
Postgres, dass kein Klartext entsteht.

**Modelle:** **Opus** (Krypto), Tests Sonnet.

---

### E7 — Freigabe-Adresse und Leseweg

**Zweck:** Lesen direkt vom Laufwerk, mit unsichtbarem Rückfall.

- `freigabeAnlegen()` / `freigabeErneuern()` je Adapter.
- Adresse als Kanal-Metadatum am Server; Verteilung an Mitglieder.
- Klient: direkt probieren, bei Netz-/CORS-Fehler über Pulse, Ergebnis je
  Kanal für die Sitzung merken.
- Route `GET /channels/{id}/ablage/abruf` mit **allen** Regeln aus §4.2:
  Mitgliedschaft, Basis-Adresse vom Server, Pfadnormalisierung, keine
  Umleitung in private Adressbereiche, Größen- und Zeitlimit,
  Ratenbegrenzung, nichts speichern.
- Messen (§11.2, §11.3): CORS-Verhalten von Google Drive, Rückzug von
  Dropbox-Links.

**Abnahme:** Ein Mitglied im Firefox liest einen Nextcloud-Kanal; ein
Sicherheitstest weist Pfad-Ausbrüche und private Ziele nach.

**Modelle:** Route und Sicherheitsprüfung **Opus**, Rest Sonnet.

---

### E8 — Community-Dateiablage

**Zweck:** Dateien einer Community auf dem Laufwerk ihres Besitzers.

- Laufwerk des Community-Besitzers als Ablage der Community.
- Ohne Laufwerk: Bereich existiert nicht, Besitzer sieht Aufforderung,
  Mitglieder sehen nichts.
- Hochladen über Pulse (verschlüsselt), Festigung durch ein Gerät des
  Besitzers; Zwischenlager mit Größen- und Altersgrenze; Meldung „Besitzer
  war lange nicht online" statt „Upload fehlgeschlagen".
- Dateiansicht aus `/app/ablage` zieht hierher.

**Abnahme:** Mitglied lädt hoch, zweites Mitglied lädt herunter, Klartext
entsteht nirgends auf dem Server.

**Modelle:** Sonnet.

---

### E9 — Umstellung

**Zweck:** Neue Kanäle verschlüsselt, alte nur lesbar — überall.

- `channel_creation_policy` als Vorgabe auf nur-Ablage, auch Cloud.
- Neuer Zustand `legacy_readonly` am Alt-Kanal; Schreiben wird serverseitig
  abgewiesen **mit begründender Meldung**, nicht mit nacktem 403.
- Oberfläche: Alt-Kanal zeigt seinen Zustand, Eingabefeld erklärt sich.
- `docs/user-gehostete-kanaele-konzept.md` §2a nachziehen (Entwurf §9).
- Changelog-Eintrag; Stil vom Eigentümer wählen lassen.

**Abnahme:** Alt-Kanal lesbar und nicht beschreibbar; neuer Kanal ohne
Laufwerk nicht anlegbar; Konzept-Doku widerspruchsfrei.

**Wichtig:** Der Schalter wird gebaut, aber auf howispulse.com **erst nach
ausdrücklicher Freigabe** umgelegt.

**Modelle:** Sonnet; Doku-Abgleich Haiku.

---

### E10 — Klartext-Export

**Zweck:** „Deine Daten gehören dir" nachprüfbar machen.

- Archiv als Verzeichnis: Nachrichten je Kanal und Tag als Textdateien,
  Anhänge unter ihrem echten Namen.

**Abnahme:** Export eines Testarchivs, Inhalt gegen die Quelle verglichen.

**Modelle:** Sonnet.

---

### E11 — Kopplungs-E2E

**Zweck:** Der offene Posten aus `docs/ablage-umsetzung-stand.md` §3.2 —
Zwei-Geräte-Verlaufsumzug. Routen sind montiert und rauchgeprüft, der
Krypto-Durchlauf fehlt.

**Modelle:** Opus für den Krypto-Durchlauf, Sonnet für den Testaufbau.

---

### E12 — Landen

- Volles Gate, Playwright, Rust-Tests grün
- Changelog vollständig
- Ein `bash scripts/ship.sh` vom Zweig — **Merge nach `main` ist ein
  Prod-Deploy und braucht die Freigabe des Eigentümers**

---

## Berichtsform

Der Eigentümer hat „nur melden, wenn ich nicht weiterkomme" gewählt. Also:
kein Zwischenbericht je Etappe, sondern eine Meldung bei
- einer Entscheidung, die der Entwurf nicht abdeckt,
- einem Messergebnis, das eine Entwurfsannahme widerlegt (§11),
- einem Blocker, der von außen kommt (Konto, Zugang, Anbieter),
- und am Ende.
