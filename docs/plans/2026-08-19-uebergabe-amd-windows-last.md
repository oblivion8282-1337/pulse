# Übergabe — AMD/Windows: Encoder-Last nach dem Vorgabe-Wechsel

Für die Maschine, die AMD unter Windows testet. Branch:
**`remote/2026-08-18/integration`**.

Hier steht nur, was zu tun ist und warum. Die Messwerte und ihre Herleitung
stehen in `docs/plans/2026-07-30-amd-windows-messung.md` und im Doc-Kommentar
von `streaming/win-hq-sidecar/src/encode/auffrischung.rs`.

---

## Was passiert ist

Am 2026-08-18 sind zwei Vorgaben gewechselt:

* Vollbild-Abstand **2 s → 60 s** (an der echten Leitung gemessen)
* Intra-Refresh **an → aus**

Beides zusammen hat auf AMD/Windows eine Nebenwirkung, die niemand beabsichtigt
hat und die vorher niemanden traf.

## Die Kopplung, um die es geht

`h264_amf` bekommt aus Lastgründen `usage=ultralowlatency`
(`encode/opts.rs`, seit 2026-07-30 — das drittelt die Video-Engine-Last).
**Diese Einstellung schaltet die rollende Auffrischung von sich aus mit ein.**

Damit ein abgewählter Intra-Refresh-Haken auch wirklich wirkt, überschreibt
`auffrischung.rs::abschalt_optionen_fuer` sie bei `h264_amf` mit
`usage=transcoding` (seit 2026-08-07). Angewandt wird das in `anwenden()`
genau dann, wenn Intra-Refresh **nicht** gewünscht ist.

Bekannte Zahlen (H.264, 2026-07-30):

| | `ultralowlatency` | `transcoding` |
|---|---|---|
| Video-Engine | 10,3 % | **26,6 %** |
| Bildqualität | — | +0,4 VMAF |
| Latenz | — | **nicht gemessen** |

Bis zum 2026-08-18 zahlte den teuren Zweig nur, wer den Haken ausdrücklich
abwählte. Seit die Vorgabe „aus" ist und H.264 der Vorgabe-Codec, nimmt ihn
**jeder** AMD-Stream unter Windows.

## Was hier zu tun ist

**1. Die fehlende Zahl messen: Latenz `transcoding` gegen `ultralowlatency`.**
Das ist die einzige Größe, die für eine Bewertung fehlt. Ohne sie lässt sich
nicht sagen, ob die zweieinhalbfache Last ein akzeptabler Preis ist. Der
Doc-Kommentar in `auffrischung.rs` sagt dazu: „Wer die Zahl braucht, misst
gegen `ultralowlatency` und trägt sie hier ein."

**2. Prüfen, ob der Befund auf dieser Hardware überhaupt gilt.** Die 26,6 %
stammen vom 2026-07-30 von einer iGPU. Auf einer dedizierten Karte kann das
anders aussehen.

**3. Danach entscheiden und umsetzen** — welcher Weg richtig ist, entscheidet
der Nutzer, nicht das Dokument.

## Was du beim Bauen wissen musst

Der Windows-Sidecar hat gestern den Schalter `PULSE_KEYFRAME_SECONDS` bekommen
(`src/keyframe.rs::abstand_bilder`, eingehängt an drei `set_gop`-Stellen in
`encode/encoder.rs`, `encoder_hw.rs`, `encoder_d3d12.rs`). Geschrieben wurde
das auf der Linux-Maschine, die den Windows-Sidecar **nicht bauen kann** — die
reine Rechnung ist in einem Wegwerf-Crate geprüft, die Einbindung nicht.
Bricht der Build dort, liegt es sehr wahrscheinlich daran.

**Kontrolle, dass der neue Stand wirklich läuft:** Die Zeile `Encoder offen …`
im Sidecar-Log muss `keyframe_abstand_bilder` = fps × 60 zeigen (60 fps → 3600,
144 fps → 8640). Steht dort fps × 2, ist der Sidecar nicht neu gebaut.

**Seit 2026-08-19 hängt die Vorgabe an der Betriebsart:** ohne Intra-Refresh
60 s Vollbild-Abstand, mit Intra-Refresh 2 s Umlaufdauer. Dieselbe Zahl steuert
je Betriebsart zwei verschiedene Dinge — bei eingeschaltetem Intra-Refresh ist
sie die Umlaufdauer der Auffrischungswelle, und 60 s wären dort unbrauchbar.

## Was auf Windows *nicht* das Problem ist

Der `forced-idr`-Fehler vom 2026-08-19 (NVENC kodiert ein angefordertes
Vollbild ohne die Option nicht zwingend als IDR → schwarzes Bild beim
Zuschauer, bis das nächste reguläre Vollbild kommt) betrifft nur den
Linux-Sidecar. Der Windows-Sidecar setzt `forced-idr` bzw. `forced_idr` längst
unbedingt, für NVENC wie für AMF (`encode/opts.rs`).
