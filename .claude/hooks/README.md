# Simplifier-Gates

> **Achtung: die beiden Gates sind seit dem 2026-06-28 NICHT MEHR verdrahtet.**
> Commit `b345ca8d` hat sie aus `.claude/settings.json` entfernt („Hooks haben
> hauptsächlich genervt"); dort stehen heute nur noch zwei graphify-Hooks, kein
> `git commit`-Gate und kein `Stop`-Gate. Die Skripte liegen weiter hier und
> funktionieren — sie feuern nur niemand mehr.
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
> `stop-require-simplifier.sh`) gehören in `.claude/settings.json` neben die
> graphify-Hooks.

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

Verdrahtet sind die beiden Hooks in `.claude/settings.json`.

# Der graphify-Hinweis — der einzige Hook, der wirklich feuert

`graphify-hinweis.mjs` ist der fünfte Bewohner dieses Verzeichnisses und
gehört **nicht** zu den Simplifier-Gates oben. Er erinnert daran, `graphify`
zu fragen, bevor roh gesucht (`Bash`, Matcher auf grep/rg/find/…) oder roh
gelesen wird (`Read|Glob`, Matcher auf Quell- und Doku-Endungen) — und nur,
solange `graphify-out/graph.json` überhaupt existiert.

**Seit dem 2026-08-06 ist es eine Datei statt zweier `python3 -c`-Einzeiler in
`settings.json`.** Der Grund ist kein Schönheitsempfinden: auf dem
Windows-Rechner (Sidecar- und Player-Bau) gibt es **kein Python** — `python3`
ist dort der Microsoft-Store-Platzhalter, der mit „Python was not found"
abbricht. Beide Einzeiler endeten auf `2>/dev/null || true`, **also fielen sie
dort still aus und haben nie gefeuert.** Dasselbe Muster wie im Kasten ganz
oben: ein Netz, das man für gespannt hält.

Node ist stattdessen eine harte Voraussetzung dieses Repos auf jedem Rechner
(pnpm-Workspace für `web` und `desktop`), Python nur für das Backend.

**Nachprüfbar, und das war der zweite Gewinn:**

```
echo '{"tool_input":{"command":"grep -r foo ."}}' | node .claude/hooks/graphify-hinweis.mjs bash
echo '{"tool_input":{"pattern":"**/*.ts"}}'       | node .claude/hooks/graphify-hinweis.mjs lesen
```

Ohne `graphify-out/graph.json` im Arbeitsverzeichnis bleibt beides stumm — das
ist der Normalfall auf einem Rechner, auf dem noch kein Graph gebaut wurde.

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
