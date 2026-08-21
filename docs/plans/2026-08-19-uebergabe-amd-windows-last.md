# Erledigt — AMD/Windows: Encoder-Last nach dem Vorgabe-Wechsel

**Stand 2026-08-19, nachmittags: gemessen und behoben.** Der Text unten
beschrieb die Lage am Vormittag und bleibt als Fragestellung stehen; was
dabei herauskam, steht hier.

## Ergebnis

Der gemeldete Aufschlag war real: **10,5 gegen 25,2 Prozent** Video-Engine
(H.264, 1080p60, 12 Mbit/s, Radeon 780M). Die Julizahlen sind bestätigt.

**Die vermutete Ursache war falsch.** Nicht die Umschaltung auf
`usage=transcoding` ist teuer, sondern alles, was nicht `ultralowlatency` ist
— nachgewiesen an `h264_d3d12va`, das gar kein `usage` setzt und dieselben
25,2 Prozent kostet. Den Gegenbeweis liefert AV1: dort greift der Abschaltweg
nie, und beide Betriebsarten kosten gleich viel (8,8 / 8,9 Prozent).

**Behoben ohne Preis:** die sparsame Betriebsart bleibt stehen, die Vollbilder
kommen aus einem eigenen Takt (`keyframe::Selbsttakt`, derselbe Weg, den eine
Zuschauer-Anfrage nimmt). Gemessen **10,5 Prozent mit** 60-Sekunden-Vollbildern
— die Last der billigen Betriebsart mit der Eigenschaft der teuren.

Messakte: `streaming/testbench/profiles/amd-2026-08-19-vollbilder-ohne-aufschlag.json`.
Messstand: `streaming/win-hq-labor/testbench/vollbild-last-messen.ps1`.

Die beiden offenen Punkte von heute Vormittag sind damit erledigt: die Latenz
von `transcoding` braucht niemand mehr zu messen (der Wert kommt nicht mehr
vor), und auf dieser Hardware gilt der Befund — er wurde hier erhoben.

**Zurückgenommen am selben Tag:** Hier stand „der Strom trägt jetzt beides,
rollende Auffrischung UND periodische Vollbilder, die Welle repariert weiterhin
dazwischen". Das ist **nicht belegt**. Belegt ist nur, dass die sparsame
Betriebsart den bestellten Vollbild-Takt unterdrückt — nicht, dass eine
Auffrischung an seine Stelle tritt. Drei Nachweisversuche sind gescheitert
(Bitstrom-Spur, Blockkarten, Schadenstest); die Einzelheiten stehen in der
Messakte und an `auffrischung::braucht_selbsttakt`. Das stärkste Gegenindiz kam
vom Nutzer: er sieht den Auffrischungs-Wischer **nur** bei ausdrücklich
eingeschalteter Auffrischung.

Für den Fix ändert das nichts — der Selbsttakt wird gebraucht, weil der
bestellte Takt ausbleibt, und alle Lastzahlen stehen. Wohl aber für jede
Aussage über Verlust-Robustheit: die naheliegendere Erklärung dafür, dass
H.264-Ströme Störungen besser überstehen, liegt beim **Empfänger** (H.264-
Decoder überdecken Fehler, dav1d gibt bei fehlenden Bezügen gar kein Bild aus).
Ebenfalls nicht gemessen.

**Und weiterhin offen:** nur auf einer iGPU gemessen.

---


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

Damit ein abgewählter Intra-Refresh-Haken auch wirklich wirkt, überschrieb
`auffrischung.rs::abschalt_optionen_fuer` sie bei `h264_amf` mit
`usage=transcoding` (seit 2026-08-07). Angewandt wurde das in `anwenden()`
genau dann, wenn Intra-Refresh **nicht** gewünscht war.

> **Nachtrag 2026-08-21.** Beide Funktionen gibt es nicht mehr: mit der
> Betriebsart ist auch der Abschaltweg entfallen. Von `auffrischung.rs` blieb
> allein `braucht_selbsttakt` übrig — die Frage, ob ein Encoder von sich aus
> auffrischt und damit den bestellten Vollbild-Takt verschluckt. `h264_amf`
> behält `usage=ultralowlatency`, die Vollbilder kommen aus
> `keyframe::Selbsttakt` (siehe „Ergebnis" oben).

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
Doc-Kommentar in `auffrischung.rs` sagte dazu: „Wer die Zahl braucht, misst
gegen `ultralowlatency` und trägt sie hier ein." (Der Satz ist am 2026-08-21
mit dem Abschaltweg entfallen — die Zahl wird nicht mehr gebraucht.)

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

**Vom 2026-08-19 bis zum 2026-08-21 hing die Vorgabe an der Betriebsart:** ohne
Intra-Refresh 60 s Vollbild-Abstand, mit Intra-Refresh 2 s Umlaufdauer —
dieselbe Zahl steuerte je Betriebsart zwei verschiedene Dinge. Seit dem
2026-08-21 gibt es nur noch die eine Betriebsart, und damit nur noch die eine
Bedeutung: 60 s Vollbild-Abstand.

## Was auf Windows *nicht* das Problem ist

Der `forced-idr`-Fehler vom 2026-08-19 (NVENC kodiert ein angefordertes
Vollbild ohne die Option nicht zwingend als IDR → schwarzes Bild beim
Zuschauer, bis das nächste reguläre Vollbild kommt) betrifft nur den
Linux-Sidecar. Der Windows-Sidecar setzt `forced-idr` bzw. `forced_idr` längst
unbedingt, für NVENC wie für AMF (`encode/opts.rs`).
