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

## Was in der Nacht zum 2026-07-31 entschieden wurde

Vier Befunde, alle gemessen statt angenommen. Messakten in
`streaming/testbench/profiles/`.

**Browser und Electron tragen FlexFEC — die alte Notiz war falsch.** Chromium
handelt `flexfec-03` im Empfang per Default aus (Field-Trial ist nur fürs
*Senden* nötig), unser Fork erzeugt die dafür zwingende
`a=ssrc-group:FEC-FR`, und die Paritätspakete kommen an (1352–5788 je Lauf,
`fecPacketsReceived` aus `getStats()`). FEC im Browser ist keine Baustelle.

**AV1 10 bit ist im Browser tot.** Null Bilder in 15 Sekunden bei normal
ankommenden Paketen und 97 Keyframe-Anforderungen; 8 bit liefert im selben
Aufbau 722 Bilder. Ursache ist der Decoder (dav1d in libwebrtc lehnt
`bpc != 8` ab), nicht der Weg. **Folge: 10 bit bleibt dem nativen Player
vorbehalten**, Browser und Electron bekommen 8 bit.

**Intra-Refresh funktioniert im Browser — er braucht nur einen Einstiegspunkt.**
Hier stand zwischenzeitlich das Gegenteil („scheidet für Browser und Electron
aus"), geschlossen aus der Quelltextstelle `keyframe_required_ = true` in
libwebrtc. Das war voreilig: die Stelle betrifft den **Einstieg**, nicht den
Dauerbetrieb. Gemessen (`profiles/browser-2026-07-31-intra-refresh.json`):

| Lauf | Bilder |
|---|---|
| Intra-Refresh, Beitritt **nach** dem einzigen IDR | 0 (98 vergebliche Anforderungen) |
| **nativer Player**, derselbe Fall | 0 — es ist keine Browser-Eigenheit |
| dieselbe Kette mit Keyframes alle 2 s | 721 |
| Intra-Refresh, Beitritt **vor** dem IDR | **2228 in 40 s**, danach 37 s reiner Intra-Refresh, PLI-Zähler steht |

Die Bedingung ist also nicht „periodische Keyframes", sondern **ein IDR beim
Beitritt** — und das liefert Patch 0002 bereits, indem er die
Keyframe-Anforderung des Zuschauers an den Sender weiterleitet, statt sie wie
upstream zu verwerfen. Noch ungemessen ist das Verhalten nach einem **Verlust**
im laufenden Betrieb (dort muss derselbe Weg greifen).

**Das Stottern liegt nicht am Codec.** H.264, AV1 8 bit und AV1 10 bit liegen
in Bildrate und Ankunftslücken innerhalb des Rauschens (58,1–58,4 fps,
13,2–13,5 Lücken/s, größte Lücke 36 ms). Der Referenzsender schickt
gleichmäßig — die Bündelung entsteht dahinter.

## Offene Punkte

- [ ] **Wo entsteht die Bündelung?** Nächster Schritt: dieselbe Codec-Reihe
      über WHIP statt RTMPS, und `fern-split.py`, um zu trennen, ob die Lücken
      vor oder hinter dem eigenen Anschluss entstehen.
- [ ] **Der echte Sender ist noch nicht vermessen** — Aufnahme und Encoder
      können zusätzlich bündeln. Braucht das Portal und einen Menschen davor.
- [ ] **Portal nachts**: das Restore-Token greift (nachgeprüft), aber bei
      abgeschaltetem Bildschirm findet das Backend den gespeicherten Monitor
      über seine EDID-Kennung nicht wieder und fragt neu. Messungen mit dem
      echten Sender sind deshalb nicht unbeaufsichtigt fahrbar.
- [ ] **Adaptive Parität Stufe 2/3** (Rate je Sitzung, stufenlos) — erst
      sinnvoll, wenn gemessen ist, dass zwischen „aus" und „20 Prozent" etwas
      fehlt. Stufe 1 ist gebaut (Patch 0004) und wirkt.
- [ ] **Schwellenwert der Regelung** steht ungeprüft auf 1 Prozent.
- [ ] **Reed-Solomon statt XOR** (Analyse 2.2) — die Ausbaustufe für
      Bündelverlust, wo XOR strukturell nur ein Loch je Gruppe schließt.
- [ ] **Setup-Mitnahme**: eine knappe Anleitung, was ein frischer Rechner
      braucht (Prüfstand, Player-Build, Zugangsdaten, Vorlagen)
