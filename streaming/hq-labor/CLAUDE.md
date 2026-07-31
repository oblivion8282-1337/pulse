# CLAUDE.md — HQ-Labor

Projektanweisungen für die Arbeit am HQ-Streaming-Weg (dieses Verzeichnis, der
Prüfstand unter `streaming/testbench/`, der Player unter
`streaming/pulse-player/` und der ausgelieferte Sidecar nebenan).

**Diese Datei ist der Einstieg für jede neue Sitzung und für jeden anderen
Rechner.** Sie steht bewusst im Repo und nicht in der Claude-Memory: die liegt
pro Maschine und wandert nicht mit.

## Wie hier gearbeitet wird (Vorgabe des Nutzers, 2026-07-31)

- **Nicht raten. Nichts von vornherein annehmen.** Jede Aussage über Verhalten
  wird belegt — am Quelltext, an einer Messung oder an der Doku der fremden
  Komponente. Wo ein Beleg fehlt, wird das dazugesagt.
- **Immer recherchieren**, bevor gebaut wird. Auch wenn die Antwort naheliegt.
- **Probleme an der Wurzel lösen**, nicht außen herum. Wenn eine fremde
  Komponente sich falsch verhält, zuerst prüfen, was der EIGENE Code ihr
  übergibt.
- **Arbeitsschritte an frische Agenten geben**, mit klarem Briefing. Bei
  hartnäckigen Problemen darf der Agent ausdrücklich quer denken. **Das
  Verifizieren und das Bauen macht der Hauptlauf, nicht der Agent.**
- Ergebnisse gehören als Messakte nach `streaming/testbench/profiles/`,
  Lehren aus Messfallen in die Notizen dort und hierher.

## Was am Ergebnis zählt (Reihenfolge ist keine Rangfolge — alles vier)

1. **Bildqualität** so hoch wie möglich
2. **GPU-Auslastung** so gering wie möglich
3. **Darstellung** so flüssig wie möglich
4. **Verzögerung** so gering wie möglich

Ein Gewinn bei einem der vier, der einen der anderen verschlechtert, ist kein
Gewinn, solange es nicht gemessen und benannt ist.

## Wo es laufen muss

| Ziel | Warum |
|---|---|
| **Nativer Player** (`streaming/pulse-player/`) | **Nur er** kann AV1 10 bit darstellen, und er trägt später die **Fernsteuerung**. Hier lohnt jede Optimierung. |
| **Electron-App** | der normale Weg für Desktop-Nutzer |
| **Browser** | Pulse ist web-first; was hier nicht geht, gibt es für die Mehrheit nicht |

Plattformen: **Linux, Windows, macOS**. Ein Weg, der nur auf einer davon
funktioniert, ist eine Zwischenlösung, kein Ergebnis.

**Daraus folgt die wichtigste offene Frage:** Wenn der Weg über Intra-Refresh
und Fehlerkorrektur gegangen wird, muss das **auch im Browser und in Electron**
ankommen — nicht nur im nativen Player. Vorrecherche des Nutzers sagt, dass
FEC und NACK dort inzwischen tragen. **Das ist zu prüfen, nicht zu glauben**
(Stand der Prüfung siehe „Offene Punkte").

## Das Messsetup

Der Grund für den ganzen Aufbau: **eine Messung, die von Handgriffen abhängt,
wird selten wiederholt** — und Bildzahl, Bitrate und Paketverlust sahen während
des ganzen Ruckelns tadellos aus. Gemessen wird deshalb, was man sonst nur
sieht.

| Werkzeug | misst |
|---|---|
| `testbench/latency-pattern.py` | **Verzögerung**: Balken aus schwarzen/weißen Klötzen kodieren die Millisekunden seit einer gemeinsamen Epoche; der Player liest sie aus dem dekodierten Bild zurück. Das Bild trägt die Uhrzeit selbst — nötig, weil jede Station unterwegs Zeitstempel umschreibt. |
| `testbench/bewegtbild.py` | **Ruckeln**: Bewegtbild ist Pflicht, auf einem stehenden Schirm ist jede Ruckel-Messung wertlos. |
| `testbench/tonsignal.py` + `ton-auswertung.py` | **Ton**: Verlust exakt, A/V-Versatz als Beep gegen Zeitbalken |
| `testbench/fern-harness.py` | derselbe Ablauf **über die echte Leitung** statt über die Schleife |
| `testbench/fern-referenz.py` | Referenzsender fern, **ohne Portal und wachen Bildschirm** |
| `testbench/compare-quality.py` | **Bildqualität**: VMAF/PSNR/SSIM gegen den verlustfreien Encoder-Eingang |
| `testbench/gpuload.py` | **GPU-Last** während des Laufs |

Die Zahl, auf die es beim Ruckeln ankommt, ist **nicht** die Bildrate, sondern
der Anteil der Ausgabe-Abstände über dem **doppelten** Soll — 13,9 ms bei
144 fps, aber nur 7,1 ms bei 280 fps.

**Das Setup soll auf andere Rechner mitgenommen werden können.** Alles dafür
liegt im Repo; was noch fehlt, steht unter „Offene Punkte".

## Randbedingungen dieser Leitung

- **Upload 10 Mbit.** Bei Messungen von hier schaut derselbe Anschluss zu, der
  auch sendet — der Strom läuft die Leitung hoch UND wieder runter.
  **Mit 4000 kbps testen**: 4 hoch, 4 runter, das passt. Wer mit 8000 misst,
  misst die eigene Leitung am Anschlag statt den Sendeweg (Falle vom
  2026-07-27, deshalb steht `ansehen.py` per Vorgabe auf 3000).
- Ein Qualitätsurteil braucht höhere Bitraten — dann aber wissen, dass die
  Leitung mitredet, und es dazusagen.

## Linux — zwei Dinge, die jede Messreihe stören

1. **Der Portal-Dialog kommt einmal pro Rechner, nicht pro Lauf — und das
   funktioniert.** `PULSE_PORTAL_REUSE=1` legt das Restore-Token nach
   `$XDG_STATE_HOME/pulse/portal-restore-token`, `real-harness.py` setzt die
   Variable von sich aus, und `portal-grant.py` wählt die Quelle einmal aus.
   **Hier stand zwischenzeitlich, der Dialog käme trotzdem bei jedem Lauf —
   das war falsch** und aus dem Gedächtnis geschrieben. Nachgeprüft am
   2026-07-31 im Portal-Journal: **genau ein** Dialog um 01:14:58 (die
   Erstanlage nach dem Löschen der Token-Datei), danach drei Läufe über 28
   Minuten ohne. Der `last_used_time` des Store-Eintrags belegt die Einlösung
   auf die Sekunde.
   Kontrolle, falls der Verdacht wiederkommt — **zählen, nicht erinnern**:
   ```bash
   journalctl --user -t xdg-desktop-portal-gnome -f
   ```
   Jede Zeile `Failed to associate portal window with parent window` ist ein
   *gezeigter* Dialog (sie fällt an, weil wir kein `parent_window` übergeben).
   Zwei echte Fallen: `zeigen.py --portal-neu` setzt `PULSE_PORTAL_REUSE=0`
   und erzwingt den Dialog **mit Absicht**; und ein Start aus der Flatpak-App
   hat eine andere App-Identität (`com.howispulse.Pulse`) als einer aus dem
   Terminal (dort ist sie der leere String) — Token gelten nur je Identität.
2. **Die Bildschirme dürfen sich während einer Messung nicht abschalten.**
   Ein dunkler Schirm liefert keine Frames (der Compositor sendet nur bei
   Damage), und die Messung sieht aus wie ein Aussetzer des Senders. Ebenso
   wenig darf der Bildschirmschoner das Zeitmuster verdecken.
   Der Idle-Manager dieser Maschine ist **`dms`** (Dank Material Shell), nicht
   swayidle/hypridle; `systemd-inhibit` greift hier ins Leere, weil in
   `logind.conf` `IdleAction` gar nicht gesetzt ist. Der Prüfstand hält den
   Schirm deshalb über `dms ipc call inhibit enable` wach und nimmt es in
   einem Trap zurück (`gemeinsam.py`), wie er es mit den `tc`-Regeln tut.

## Fehlerkorrektur — Stand und Richtung

Die Analyse `docs/plans/2026-07-31-fec-bandbreite-und-adaptivitaet.md` (293
Zeilen, auf `feat/native-hq-player`) ist die Grundlage für alles Weitere. Ihr
Kernbefund: der FlexFEC-Aufschlag ist **fest 20 Prozent, unabhängig davon, ob
etwas verloren geht** — und auf einer gesunden Leitung damit vollständig
umsonst bezahlt. Sie sortiert die Alternativen nach Bandbreiten-Effizienz;
adaptive Parität ist der größte Hebel.

Sie ist ausdrücklich **Analyse, keine Messung** und markiert jede Aussage mit
ihrer Belegklasse (GEMESSEN / GELESEN / EXTERN / VERMUTET). **VERMUTET ist
keine Entscheidungsgrundlage** — vor dem Bauen messen.

Was gemessen und belegt ist, steht in `streaming/testbench/profiles/` und in
`streaming/pulse-player/WISSENSSTAND.md`.

## Offene Punkte

- [ ] **Browser und Electron mit Intra-Refresh + FEC/NACK**: prüfen, nicht
      annehmen. Browser handeln flexfec-03 nicht aus (Stand der Notizen);
      was tragen sie stattdessen, und reicht das?
- [ ] **Portal-Dialog pro Sitzung** (s.o.) — Ursache finden
- [ ] **Bildschirm-Abschaltung während Messungen** unterbinden
- [ ] **Setup-Mitnahme**: eine knappe Anleitung, was ein frischer Rechner
      braucht (Prüfstand, Player-Build, Zugangsdaten, Vorlagen)
- [ ] Adaptive Parität statt fester 20 Prozent (s. Analyse-Dokument)
