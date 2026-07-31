# CLAUDE.md — HQ-Labor

Projektanweisungen für die Arbeit am HQ-Streaming-Weg (dieses Verzeichnis, der
Prüfstand unter `streaming/testbench/`, der Player unter
`streaming/pulse-player/` und der ausgelieferte Sidecar nebenan).

**Diese Datei ist der Einstieg für jede neue Sitzung und für jeden anderen
Rechner.** Sie steht bewusst im Repo und nicht in der Claude-Memory: die liegt
pro Maschine und wandert nicht mit.

## Wiedereinstieg (Stand 2026-07-31, Nacht)

**Neuer Rechner? Zuerst `EINRICHTUNG.md` daneben lesen.** Zwei Dinge fehlen
nach einem frischen Klon und brechen sofort: der vendorierte webrtc-rs
(`vendor/` ist ignoriert, `bootstrap-webrtc.sh` stellt ihn her) und die
Zugangsdaten des Labor-Servers (die liegen auf dem Server).

**Wo die Arbeit liegt:** zwei Zweige, beide mit viel ungepushter Arbeit —
`werkzeug/pruefstand-labor-server` (Prüfstand, Messwerkzeuge, Messakten) und
`feat/native-hq-player` (Player, 122 Tests). **Sie hängen zusammen, liegen aber
getrennt:** der Player braucht den Prüfstand zum Messen, der Prüfstand den
Player als Zuschauer. Nicht den Zweig wechseln, während eine Messung läuft —
so sind fünf von sechs Läufen einer Kennlinie ausgefallen.

**Der Labor-Server** (`pulse.unicutmedia.com`) läuft eigenständig, nur MediaMTX.
Binary jetzt `mediamtx.fecfix` (drei Patches plus den neuen pion-Patch), das
vorherige liegt als `mediamtx.vor-fecfix` daneben. Betriebsart über
`~/mediamtx-labor/neustart.sh`, Zugang in `~/mediamtx-labor/zugang.txt`.
Aktuell: **FlexFEC 10+2, Intra-Refresh** (`PULSE_KEYFRAME_INTERVAL=0`).

### Was an diesem Tag entschieden ist

**Die Umstellung auf Intra-Refresh kostet nichts und gewinnt dreifach** — auf
Linux+NVIDIA gemessen, gegen Keyframes alle 2 s bei identischer Datenrate:
gleiche Bitrate (4015 gegen 3905 kbit/s), **1,4 statt 48,7 Prozent** gestörte
Sekunden, **92,8 statt 76,3 VMAF**. Der oft genannte Aufschlag von 20 Prozent
gehört *nicht* zu Intra-Refresh, sondern zur Parität — die ist eine getrennte
Entscheidung (ohne sie: 2,8 Prozent Aufschlag).

**Paritätsstufe: 10+2.** Bei gleichverteiltem Verlust gibt es bis 5 Prozent
keinen Unterschied zu 10+1; entschieden wird es am **Bündelverlust**, und dort
ließ 10+2 kein Paket endgültig verlorengehen, 10+1 neunzehn. 20+4 ist zweimal
geprüft und verliert trotz dreifacher Reparaturleistung dreifach so viel — die
größere Gruppe ist zu träge für unseren 100-ms-Puffer.

**Vier Reparaturen, alle gemessen** (Details in den Messakten):

| | war | ist |
|---|---|---|
| SRTP-Wiedergabefenster im Player | 64 Pakete → Nachlieferungen verworfen | 2048 |
| Paritätserzeugung (pion-Patch 0005) | brach unter Last auf ein Fünftel ein | konstant |
| FEC-Zähler | sah den Versagensfall von XOR nicht | drei getrennte Zahlen |
| NACK-Sperrfrist | dieselbe Lücke 6–8× angefordert | 20 ms, 56 % weniger Verkehr |

Zusammen: bei 5 Prozent Verlust derselbe Aufschlag wie vorher (36,5 gegen
37,0 Prozent) — aber vorher war es ein Strom **ohne** funktionierenden Schutz.

### Was als Nächstes ansteht

1. ~~**AMD klären**~~ — **erledigt am 2026-08-01, die Antwort ist JA.** Radeon
   780M (VCN 4, Mesa 26.1.5) meldet rollenden Intra-Refresh für AV1, H.264 und
   HEVC, und Mesa programmiert ihn bis in den VCN-Kommandostrom. Im Weg stand
   allein FFmpeg, das die VA-API-Schnittstelle in **keiner** Version
   durchreicht (auch nicht in `master`). Patch dafür:
   `hq-labor/ffmpeg-patches/`, Beweiskette in
   `testbench/profiles/amd-2026-08-01-intra-refresh.json`. `h264_amf` und der
   Verzicht auf AV1 auf AMD sind damit vom Tisch.
   **Was daran offen bleibt: die Auslieferung** — Sidecar und Labor linken
   gegen das FFmpeg des Systems. Upstream einreichen, eigenes FFmpeg ins
   Flatpak bündeln oder auf den Laborgebrauch beschränken ist eine
   Nutzer-Entscheidung. Und **die AMD-Zahlen fehlen**: dass die Betriebsart
   läuft, ist belegt; dass sie hier denselben Gewinn bringt wie auf NVIDIA,
   nicht.
2. **AV1 10 bit mit Hardware-Decoder im Browser.** Der bisherige Befund („geht
   nicht") stammt aus headless Chromium mit Software-Decoder und sagt über
   echte Nutzer nichts. Davon hängt die Bittiefe für alle Browser-Zuschauer ab.
3. **Die NACK-Kopplung** ist gebaut, aber abgeschaltet — sie misst 7 ms statt
   59. Zwei Ursachen sind behoben (Mittelwert → abklingendes Maximum,
   Aufräumfenster entkoppelt), die dritte ist offen.
   `PULSE_PLAYER_NACK_SPERRE_AUTO=1` schaltet sie zum Weitersuchen ein.
4. **Die Patches in die Produktion** (`hq-labor/mediamtx-patches/` →
   `infra/mediamtx-fork/`), erst wenn 1 geklärt ist.

### Fallen dieses Tages, damit sie sich nicht wiederholen

**Eine Zahl ohne Bezugsgröße ist keine Messung.** 61805 Wiederholungen sahen
nach schlechter Leitung aus — verteilt auf 795 Pakete waren es 78 Kopien je
Stück, also eine Rückkopplung im eigenen Empfänger. Dieselbe Falle dreimal an
einem Tag: `unreparierbar` zählte etwas anderes als sein Name sagt,
`fec_repariert` ist keine Erfolgskennzahl (20+4 reparierte dreifach und verlor
dreifach), und ein Bildausfall-Zähler suchte ein Feld, das es nicht gibt.

**Ein Lauf je Variante trägt keine Entscheidung.** Zwei Befunde mussten
zurückgenommen werden, weil der zweite Durchgang das Gegenteil zeigte.

**Werkzeuge zuerst am eigenen Material prüfen.** Der gesetzte Verlust ist im
Mitschnitt *nicht* als Lücke sichtbar (tcpdump hängt vor dem tc-Hook), und die
Qualitätsmessung verglich anfangs Bilder, die einander nie entsprachen — beides
hätte plausible, falsche Zahlen geliefert.

**Commit-Nachrichten über `git commit -F <datei>`**, nie inline: Backticks
werden sonst von der Shell ausgeführt und verstümmeln den Text. Dreimal
passiert.

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

**Nachtrag 2026-07-31 Nacht: ihre Empfehlung ist überholt.** Adaptive Parität
war als größter Hebel eingestuft; gemessen repariert sie *nichts*. Ihre
Regelgröße `fraction lost` reagiert auf bereits eingetretenen Verlust,
Vorwärtskorrektur muss aber vorher da sein — und feiner als 0,39 Prozent lässt
sich die Schwelle gar nicht stellen (8-Bit-Wert). Der wirkliche Hebel lag
woanders: **drei Fehler ließen Player und Server gegeneinander arbeiten**
(SRTP-Fenster, Paritätserzeugung, NACK-Wiederholungen). Nach ihrer Behebung
kostet voller Schutz ungefähr so viel wie vorher der kaputte.

Was die Analyse über die Alternativen sagt, bleibt lesenswert — aber jede ihrer
Zahlen ist gegen die Messakten zu prüfen, bevor darauf gebaut wird.

Die theoretische Grundlage, die dem Labor lange fehlte, ist
**Holmer/Shemer/Paniconi, „Handling Packet Loss in WebRTC" (Google, ICIP
2013)**: hybrides NACK/FEC, gesteuert über die **Umlaufzeit** statt über die
Verlustrate (FEC wird reduziert, sobald die halbe Umlaufzeit unter ~50 ms
liegt — bei uns sind es 29,5). Dort steht auch die Gruppengrößen-Formel
`λ ≈ max(1, min(f·RTT, λ₀))` und der Hinweis auf ungleichen Schutz über
Zeitschichten (spart 40–60 Prozent, bei uns aber blockiert: NVENC gibt über
FFmpeg keine Zeitschichten her).

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

**AV1 10 bit im Browser — nur für den SOFTWARE-Decoder geklärt, und das ist
nicht der Fall, der zählt.** Gemessen: 0 Bilder gegen 722 bei 8 bit, bei
gleicher Bitrate und ohne jeden Paketverlust. Aber der Chromium lief
**headless**, also ohne Hardware-Decode (`decoderImplementation` stand in allen
Läufen auf `n/a`). Belegt ist nur, dass libwebrtcs dav1d-Anbindung `bpc != 8`
ablehnt; über den **Hardware**-Pfad sagt das nichts — und Nutzer haben eine GPU.
Der Nutzer berichtet, der Browser gebe 10-bit-AV1 sehr wohl wieder, auf 8 bit
heruntergerechnet. Das widerspricht der Messung nicht.
**Offen und vor jeder Folgerung zu klären**: derselbe Lauf mit sichtbarem
Chromium und Hardware-Decoder, und derselbe Test in der echten Electron-App.
Erster Fehlversuch dabei: der ursprüngliche 10-bit-Lauf nutzte eine Vorlage mit
25 Mbit/s und 144 fps gegen 4 Mbit/s und 60 fps bei den anderen — über einen
10-Mbit-Uplink staut das zwangsläufig, und der Unterschied wurde fälschlich der
Bittiefe zugeschrieben.

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

## Offene Punkte (Stand 2026-07-31, Nacht)

**Blockierend — davor lohnt nichts anderes:**

- [x] **AMD: kann die Hardware Intra-Refresh?** JA (2026-08-01, Radeon 780M).
      Die Sperre war FFmpeg, nicht die Hardware — Patch liegt in
      `hq-labor/ffmpeg-patches/`, der Sidecar setzt die richtige Option je
      Vendor über `PULSE_INTRA_REFRESH=1` und **bricht ab**, wenn sein FFmpeg
      sie nicht kennt (statt still Keyframes zu fahren).
- [ ] **AMD messen**: derselbe Verlust-Lauf wie auf NVIDIA
      (`intraref-verlust.py`), mit einer AMD-Karte als Sender. Erst der sagt,
      ob der Gewinn hier derselbe ist. Ungemessen ist auch der GPU-Preis auf
      einer iGPU.
- [ ] **Auslieferung des Patches** entscheiden: upstream einreichen, eigenes
      (LGPL) FFmpeg ins Flatpak bündeln, oder Laborgebrauch. Bis dahin haben
      Nutzer auf AMD kein Intra-Refresh, egal was der Sidecar kann.
- [ ] **Windows und macOS**: eigene Encoder-Ketten, Intra-Refresh kommt in
      ihrem Quelltext null Mal vor. NVENC *kann* es (auf Linux belegt), es ist
      dort nur nicht gebaut.

**Wichtig, aber nicht blockierend:**

- [ ] **AV1 10 bit mit HARDWARE-Decoder im Browser.** Der Befund „geht nicht"
      stammt aus headless Chromium (Software-Decoder). Entscheidet die
      Bittiefe für alle Browser-Zuschauer.
- [ ] **NACK-Sperre an die gemessene Antwortzeit koppeln.** Gebaut, aber
      abgeschaltet: sie misst 7 statt 59 ms. Zwei Ursachen behoben
      (Mittelwert → abklingendes Maximum; Aufräumfenster entkoppelt), die
      dritte ist offen. `PULSE_PLAYER_NACK_SPERRE_AUTO=1` zum Weitersuchen.
- [ ] **Patches in die Produktion** (`mediamtx-patches/` →
      `infra/mediamtx-fork/`) — erst wenn AMD geklärt ist.
- [ ] **Portal nachts**: Restore-Token greift, aber bei abgeschaltetem
      Bildschirm findet das Backend den Monitor über seine EDID nicht wieder
      und fragt neu. Läufe mit echtem Sender sind nicht unbeaufsichtigt fahrbar.

**Erledigt, hier nur als Merkposten, warum nicht weiterverfolgt:**

- **Adaptive Parität** — repariert nachweislich nichts; `fraction lost` ist die
  falsche Regelgröße (reagiert auf Vergangenes), und feiner als 0,39 Prozent
  ist die Schwelle technisch nicht stellbar.
- **Reed-Solomon** — XOR kommt bei Bündelverlust in 81–93 Prozent der Fälle an
  seine Grenze (jetzt endlich messbar). Trotzdem gehen fast keine Pakete
  verloren, weil Nachfordern bei 59 ms Umlaufzeit schneller ist. Ein Problem,
  das nach dem Nachfordern nicht mehr besteht.
- **20+4 / größere Gruppen** — zweimal gemessen: repariert dreifach, verliert
  dreifach. Zu träge für einen 100-ms-Puffer.
- **Ungleicher Schutz über Zeitschichten** — blockiert, NVENC gibt über FFmpeg
  keine Zeitschichten her (dieselbe Sackgasse wie LTR).
- **Setup-Mitnahme** — steht in `EINRICHTUNG.md`.
