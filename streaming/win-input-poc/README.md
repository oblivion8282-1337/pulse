# pulse-input-poc

Windows-Input-PoC (M0) für die Pulse-Fernsteuerung. Beweist die kniffligste
Stelle der Input-Injection: **Maus-Events treffen auf einem Multi-Monitor-Setup
mit gemischter DPI auf jedem Monitor präzise.**

## Warum

Fremdsteuerung braucht `SendInput` mit absoluten Koordinaten. Zwei bekannte
Fallen, an denen selbstgebaute Remote-Control-Stacks scheitern:

1. **`MOUSEEVENTF_VIRTUALDESK`** — ohne das Flag mappt Windows die absoluten
   0..65535-Koordinaten nur auf den Primärmonitor; Klicks auf dem Zweitmonitor
   landen falsch.
2. **Per-Monitor-DPI-Awareness** (`PER_MONITOR_AWARE_V2`) — ohne sie liefern die
   Koordinaten-APIs bei gemischter Skalierung (z.B. 125 % + 100 %) skalierte
   Werte → systematischer Klick-Versatz.

Beide sind hier korrekt gelöst. Der PoC ist **selbstverifizierend**: er setzt
den Cursor per Injection auf die Mitte jedes Monitors und liest per
`GetCursorPos` zurück, ob er dort gelandet ist. Kein zweiter Rechner nötig.

## Starten (auf Windows)

```
cargo run --release
```

Idealer Test: **zwei Monitore mit unterschiedlicher Skalierung** in den
Windows-Anzeigeeinstellungen (z.B. Hauptmonitor 125 %, zweiter 100 %).

## Ergebnis lesen

Pro Monitor eine Zeile mit Ziel-, Ist-Koordinate und Abweichung Δ. **Δ ≤ 2 px
auf allen Monitoren = OK** — die Injection trifft überall, auch bei gemischter
DPI. Ein FAIL (großes Δ, meist genau auf dem nicht-primären / anders skalierten
Monitor) zeigt, dass eine der beiden Fallen zuschlägt.

Am Ende (nach 5 s Countdown) ein echter Linksklick auf dem zuletzt gesetzten
Punkt — schließe vorher nichts Wichtiges, worauf der Cursor stehen könnte.

## Status

- Cross-Compile-verifiziert auf Linux (`cargo check --target
  x86_64-pc-windows-gnu`, grün) — die windows-crate-API-Nutzung stimmt.
- **Noch nicht auf echtem Windows gelaufen** — das ist genau der Test, den du
  fährst. Bei Compile-/Laufzeitproblemen melden, ich fixe.

Tastatur-Injection (Scancodes, Layout) ist bewusst nicht drin — separates Thema,
kommt mit dem echten `RemoteController` (M2). Dieser PoC klärt die Maus-/
Monitor-/DPI-Falle, die das größte Einzelrisiko war.
