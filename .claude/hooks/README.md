# Simplifier-Gates

> **Achtung: die beiden Gates sind seit dem 2026-06-28 NICHT MEHR verdrahtet.**
> Commit `b345ca8d` hat sie aus `.claude/settings.json` entfernt („Hooks haben
> hauptsächlich genervt"). Daneben standen bis zum 2026-09-02 noch zwei
> graphify-Hooks; mit der Deinstallation von graphify sind auch die weg, und
> damit ist in `.claude/settings.json` **gar nichts mehr verdrahtet**. Die
> Skripte hier liegen weiter und funktionieren — sie feuern nur niemand mehr.
>
> **Was daraus folgt:** die Regel unten ist eine Regel, keine Schranke. Sie wird
> nicht mehr erzwungen, sondern muss eingehalten werden. `simplify-stamp.sh`
> von Hand aufzurufen ist damit die Geste, die den Durchlauf bezeugt — nichts
> prüft sie nach.
>
> Dieser Abschnitt stand hier bis 2026-08-04 nicht, obwohl der Text darunter am
> 2026-07-27 — fast einen Monat NACH der Abschaltung — neu geschrieben wurde und
> die Verdrahtung erneut als gegeben beschrieb. Wer den Gates vertraut hat, hat
> ein Netz angenommen, das es nicht gab.
>
> Wer sie zurückwill: die beiden Einträge (`PreToolUse` mit Matcher `Bash` auf
> `require-simplifier.sh`, plus ein `Stop`-Eintrag auf
> `stop-require-simplifier.sh`) gehören in eine `hooks`-Sektion in
> `.claude/settings.json`, die es dort derzeit nicht gibt.

Diese vier Skripte erzwingen eine einzige Regel:

> Nach jeder abgeschlossenen Code-Änderung läuft der `code-simplifier`-Agent
> über die geänderten Dateien, danach werden die relevanten Tests wieder grün
> gezogen — **erst dann** darf committet bzw. der Turn beendet werden.

Die Tests sind dabei die eigentliche Kontrolle: Ob die Vereinfachung etwas
gebrochen hat, beantwortet pytest / `pnpm check` + build, kein zweiter
Review-Agent.

Betrifft nur, was Claude über das Tool tut. Manuelle Commits am Terminal laufen
ungehindert durch.

## Die vier Teile

| Datei | Rolle |
|---|---|
| `require-simplifier.sh` | PreToolUse-Hook (Bash) — blockt `git commit` |
| `stop-require-simplifier.sh` | Stop-Hook — blockt das Turn-Ende |
| `simplify-changed-hash.sh` | Inhalts-Hash der geänderten App-Dateien |
| `simplify-stamp.sh` | setzt beide Stempel = „Simplifier gelaufen, Checks grün" |

Verdrahtet ist davon nichts — s. den Kasten ganz oben.

# Eine Lehre aus dem entfernten graphify-Hook

Hier lag bis zum 2026-09-02 `graphify-hinweis.mjs`, der vor rohem Suchen und
Lesen an `graphify` erinnerte. Mit dem Werkzeug ist er weg. Ein Satz daraus
gilt für **jeden** Hook, der hier je wieder entsteht:

**Er war ursprünglich ein `python3 -c`-Einzeiler in `settings.json` und feuerte
auf dem Windows-Rechner NIE** — `python3` ist dort der Microsoft-Store-Platz-
halter, der mit „Python was not found" abbricht, und das `2>/dev/null || true`
am Ende verschluckte es. Node ist auf jedem Rechner dieses Repos Voraussetzung
(pnpm-Workspace), Python nur fürs Backend. Und ein Hook gehört in eine **Datei**,
weil man die von Hand anstossen und damit nachprüfen kann; ein Einzeiler mit
dreifach geflüchteten Anführungszeichen lässt sich nur hoffen. Dasselbe Muster
wie im Kasten ganz oben: ein Netz, das man für gespannt hält.


**Warum zwei Gates.** Das Commit-Gate allein käme zu spät: Nicht jede Änderung
mündet sofort in einen Commit. Das Stop-Gate zieht den Simplifier ans Ende
*jeder* Änderung.

## Der Ablauf

```
1) code-simplifier über die geänderten Dateien
2) Tests/Checks erneut grün ziehen
3) bash .claude/hooks/simplify-stamp.sh
4) committen / Turn beenden
```

## Die Stempel

`simplify-stamp.sh` schreibt **zwei** Marken nach `.git/` — nie getrackt, pro
Klon lokal:

- `.simplify-stamp` — `git write-tree` des **Index** → gegen das Commit-Gate
- `.simplify-stamp-stop` — Inhalts-Hash der geänderten Dateien → gegen das
  Stop-Gate

Zwei Marken, weil die Gates zu unterschiedlichen Zeitpunkten fragen: Beim
Commit zählt der gestagte Stand, beim Turn-Ende der Stand im Arbeitsverzeichnis
(inklusive noch ungestagter und neuer Dateien).

Der Hash-Vergleich macht das Stop-Gate **schleifenfrei**: Sobald gestempelt ist,
stimmt der Hash und der nächste Stop geht durch. Ändert der Simplifier nichts,
genügt das blosse Stempeln.

## Was ausgenommen ist

Beide Gates teilen denselben Filter — er spiegelt die Ausnahmen der
Größen-Policy aus `PLAN.md` §12.1:

- Nur `.py .ts .tsx .js .jsx .mjs .cjs .svelte .rs .go` zählen überhaupt
- Ausgenommen: `tests/`, `*.spec.*`, `*.test.*`, `*/alembic/versions/`,
  `*/components/ui/` (vendored)
- Damit fallen reine Doku-, Config- und Changelog-Änderungen von selbst heraus

**Den Filter in `require-simplifier.sh` und `simplify-changed-hash.sh`
synchron halten** — laufen sie auseinander, blockt ein Gate, was das andere
durchlässt, und der Widerspruch ist von aussen kaum zu sehen.

## Fail-open

Fehlt git oder python3, erlauben beide Gates statt zu blockieren. Ein
Randfall in der Werkzeugkette soll nie den Arbeitsfluss festsetzen — die Regel
ist eine Qualitätsroutine, keine Sicherheitsgrenze.

## Wenn das Gate nicht greift

Stop-Hooks werden erst **nach** einem Turn aktiv. Auf einer frischen Maschine
greift der Gate deshalb nicht sofort: einmal `/hooks` öffnen oder die Session
neu starten.
