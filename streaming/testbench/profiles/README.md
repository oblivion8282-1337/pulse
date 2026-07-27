# Messprofile — Regeln

Ein Profil hält fest, **mit welchen Einstellungen** gemessen wurde und **was
dabei herauskam**. Sinn der Sache: eine Änderung an Encoder, Puffer oder
Transport ist nur dann eine Verbesserung, wenn sie gegen einen festen
Bezugspunkt gemessen wurde — nicht gegen die Erinnerung an letzte Woche.

## Zwei Regeln

1. **`baseline-*.json` wird nie geändert und nie überschrieben.** Es ist der
   Nullpunkt. Wenn sich der Code weiterentwickelt, entsteht ein NEUES Profil mit
   neuem Datum; das alte bleibt liegen, auch wenn es veraltet ist. Genau darin
   liegt sein Wert.
2. **Jede Variante bekommt ihre eigene Datei** — `variante-<datum>-<kurzname>.json`
   — und nennt im Feld `vergleich_gegen` das Profil, gegen das sie gemessen
   wurde. Gleiche Vorgabe (Auflösung, fps, Bitrate, Codec, Bittiefe), sonst
   vergleicht man zwei verschiedene Dinge.

## Vorgabe des Ausgangsprofils

2560×1440 (native Auflösung), 60 fps, AV1, 10 bit, 4000 kbps, Ton an.

Die fps stehen mit im Profil, weil sie **beide** Zielgrößen verschieben: bei
fester Bitrate hat ein Bild bei 60 fps doppelt so viele Bits wie bei 120, und
die Encode-Latenz beträgt zwei Bildabstände — in Millisekunden also das Doppelte
bei halber Bildrate. Ein Vergleich über verschiedene fps hinweg ist keiner.

## So wird gemessen

```bash
cd streaming/testbench
./real-harness.py --secs 25 --fps 60 --kbps 4000 --label <name>
```

Danach:

* **Encode-Latenz** aus `send-<name>.log`:
  `grep -oE "avg_ms=[0-9.]+ max_ms=[0-9.]+ frames=[0-9]+"`
* **Dekodieren und Netz-bis-Schirm** aus `player-<name>.log`:
  `grep -oE "dekodieren [0-9./]+ ms, Netz-bis-Schirm [0-9./]+ ms"`
* **Alles übrige** aus `samples-<name>.json` (jede Ein-Sekunden-Probe roh).

Beides — Ende-zu-Ende und Bildqualität gegen das Original — stand hier lange als
Lücke und ist seit dem 2026-07-26/27 gebaut: das Zeitmuster (`latency-pattern.py`
→ `probe.rs`) und der Vergleich gegen den verlustfreien Encoder-Eingang
(`PULSE_DUMP_RAW` → `compare-quality.py`).

## Zwei weitere Sorten Akte

Nicht jede Datei hier ist eine Messung mit Vorher/Nachher.

* **`rueckname-*.json`** hält fest, welche Aussagen zurückgenommen wurden, warum
  sie falsch waren und was stattdessen gilt. Grund: Behauptungen, die nur im
  Gespräch fielen und nirgends widerrufen sind, kommen später als scheinbar
  gesichertes Wissen zurück. Wer eine Messreihe liest, sollte die zugehörige
  Rücknahme daneben finden — die Messakten verweisen deshalb per
  `setzt_voraus` darauf.
* **`messprotokoll-*.json`** hält das Verfahren fest statt eines Ergebnisses:
  Lauflänge, Wiederholungen, ab welcher Streuung eine Größe belastbar ist, und
  welche Größen man **nicht mitteln darf**.

## Was heute noch fehlt

* **Die Serverseite der Latenz.** Über die echte Leitung sind rund 100 ms
  unerklärt (`fern-2026-07-27-echte-leitung.json`). Leitung, Upload-Stau,
  Jitter-Puffer und TCP-Rückstau sind ausgeschlossen; MediaMTX-Durchlauf und
  WebRTC-Ausgang sind der einzige unbetrachtete Abschnitt. Trennbar mit einem
  Paketmitschnitt am Server — dafür genügt Docker-Zugriff, kein Host-`sudo`.
* **Für SRT ist gar nichts eingegrenzt** — dort sind es 264 unerklärte
  Millisekunden, und geprüft ist nur der SRT-eigene Puffer (der es nicht ist).
* **Das Weglaufen der Browser-Latenz** (`vergleich-2026-07-27-browser-gegen-nativ.json`):
  reproduzierbar in drei von drei Läufen, Ursache nicht untersucht.
