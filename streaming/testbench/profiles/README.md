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

## Was heute noch fehlt

* **Ende-zu-Ende.** Zwei Posten der Kette sind unbeobachtet: Aufnahme bis
  Encoder-Eingang (der Sender verwirft die Aufnahmezeit) und die Laufzeit durch
  MediaMTX. Der Rest ist gemessen. Eine echte Ende-zu-Ende-Zahl braucht eine
  gemeinsame Uhr — entweder ein Zeitstempel, der im Bitstrom mitreist, oder eine
  physische Messung: ein maschinenlesbares Muster auf dem Bildschirm, das im
  Player-Fenster verzögert wieder auftaucht, beides in einem Bildschirmfoto.
* **Bildqualität gegen das Original.** Dafür muss der Sender das aufgenommene
  Bild verlustfrei mitschreiben können; ohne diese Referenz sind nur Varianten
  untereinander vergleichbar. VMAF, PSNR, SSIM und XPSNR stehen bereit.
