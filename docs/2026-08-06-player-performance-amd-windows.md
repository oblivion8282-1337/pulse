# Wo der native Player auf AMD/Windows Zeit lässt — reine Code-Analyse

**Datum:** 2026-08-06 · **Zweig:** `feat/hdr-windows-amd` · **Maschine des Anlasses:**
Windows 11 26200, Radeon 780M (RDNA3-APU), Treiber 32.0.31035.1003, HDR-Schirm

**Gegenstand:** `streaming/pulse-player/`. Der Sidecar (`streaming/win-hq-sidecar/`)
ist ausdrücklich **nicht** Gegenstand; er wird nur dort erwähnt, wo er sich mit dem
Player dieselbe Grafikeinheit teilt.

> **Nachtrag vom selben Tag, abends: Punkt 1 und 3 sind behoben und gemessen.**
>
> * **Punkt 1 ist der kleinste der Posten, nicht der größte.** Die Bildschirm-Abfrage
>   kostet **116 µs im Median** (200 Aufrufe, `render::hdr_fenster::tests::
>   was_kostet_die_schirm_abfrage`), also 0,12 ms je Bild oder 0,7 % eines
>   Bildbudgets — nicht die zwei Millisekunden, die als Möglichkeit im Raum
>   standen. Aus `[UNBELEGT]` ist damit eine Zahl geworden, und sie fällt klein
>   aus. Behoben ist er trotzdem (Zwischenspeicher mit einer Sekunde Frist).
>   **Nicht gedeckt** bleibt der zweite Teil der Sorge: der Streit um dieselben
>   prozessweiten Sperren unter Last. Er kann nur größer sein als 116 µs.
> * **Punkt 3 ist gefaltet, nicht ausgedünnt** — der Rechendurchgang liegt jetzt
>   im Kommandopuffer des Zeichendurchgangs, der Wächter sieht genauso viele
>   Bilder wie vorher, und keine Schwelle in `einfrieren.rs` musste angefasst
>   werden. Das Ergebnis ist ehrlich gemischt: „hochladen" fällt von **0,5 auf
>   0,0 ms**, „ausgeben" steigt von **0,4 auf 0,8** — die Arbeit ist
>   größtenteils **umgezogen**, netto bleiben rund 0,1 ms je Bild.
> * **Berichtigt**, unabhängig von jedem Umbau: die vier Kommentare zum
>   Ausgabe-Takt (Punkt 5), die widerlegte Begründung in `bruecke.rs`
>   (Punkt 6) und die falsche Quellenangabe in `setup.rs` (Punkt F).
>
> Zahlen, Verfahren und Vorbehalte — samt der Stockungen, die drei von sechs
> Läufen getroffen haben:
> `streaming/testbench/profiles/leistung-2026-08-06-vier-befunde.json`.

## Wie dieses Dokument zu lesen ist

**Hier ist nichts gemessen worden.** Es wurde kein Stream gestartet, kein Player
gefahren, kein Prüfstand angefasst — die Grafikeinheit sollte unbelastet bleiben.
Alles hier stammt aus dem Quelltext und aus den bereits vorhandenen Messakten unter
`streaming/testbench/profiles/`.

Damit gemessene und geschätzte Zahlen nicht verwechselbar sind, trägt jede Zahl eine
Herkunft:

* **[GEMESSEN]** — steht mit Quellenangabe in einer Messakte oder einem
  Code-Kommentar, der eine Messung belegt. Diese Zahlen sind belastbar.
* **[GERECHNET]** — aus Code und Hardware-Eckdaten arithmetisch abgeleitet, nicht
  beobachtet. Belastbar in der Grössenordnung, nicht in der Stelle nach dem Komma.
* **[UNBELEGT]** — eine Einschätzung. Nicht gemessen, nicht gerechnet. Wo das steht,
  steht es, weil die Struktur der Stelle auffällig ist, nicht weil die Wirkung bekannt
  wäre.

Die Sicherheitsangabe je Punkt betrifft die **Feststellung**, nicht die Wirkung:
„hoch" heisst „der Code tut nachweislich das, was hier steht", nicht „das bringt
nachweislich etwas".

## Die Frage, die dahinter steht

Nicht „welche Zahl lässt sich kleiner machen", sondern „warum fühlt es sich schlecht
an". Ein Zuschauer merkt drei Dinge: **Stocken**, **Verzögerung** und **ungleichmässige
Bildabstände**. Die mittlere Dekodierzeit merkt er nicht.

Die Rangfolge unten ist danach geordnet — nach erwarteter Wirkung auf den *Eindruck*,
nicht nach eingesparten Mikrosekunden.

---

# Rangliste

## 1. Eine DXGI-Fabrik je Bild — und zwar nur auf dem HDR-Weg

**Wo:** `src/render/hdr_fenster.rs:210-213` (`farbraum_fuer_quelle`) →
`src/render/hdr_fenster.rs:120-149` (`schirm_ist_hdr`).
Aufrufer: `src/app/mod.rs:517`, im Zeichendurchgang.

**Was passiert.** `farbraum_fuer_quelle` ist laut eigenem Doc-Kommentar (Zeile 200-202)
so gebaut, dass es „bei jedem Bild gefragt" wird und nur beim Wechsel etwas tut. Der
Kurzschluss, der das billig machen soll, steht aber **hinter** der teuersten Prüfung:

```rust
let moeglich = farbe.uebertragung == Uebertragung::Pq
    && self.angebotene_formate.contains(&HDR_OBERFLAECHE)
    && schirm_ist_hdr(self.hwnd);        // <- läuft, bevor verglichen wird
if moeglich == self.hdr_gewuenscht {
    return None;                          // <- der frühe Ausgang kommt zu spät
}
```

Bei einem **SDR**-Strom greift die erste Bedingung und alles ist gut. Bei einem
**PQ/HDR**-Strom — also genau dem Fall, für den dieser Zweig existiert — läuft
`schirm_ist_hdr` je Bild durch, und darin:

* `MonitorFromWindow`
* **`CreateDXGIFactory1`** — eine neue DXGI-Fabrik, je Bild
* `EnumAdapters1` in einer Schleife über alle Grafikadapter
* `EnumOutputs` in einer Schleife über alle Ausgänge jedes Adapters
* `QueryInterface` auf `IDXGIOutput6` je Ausgang
* `GetDesc1()` je Ausgang — eine Treiberabfrage

**Warum es kostet.** `CreateDXGIFactory1` ist kein Abfrage-, sondern ein
Aufbau-Aufruf: COM-Initialisierung, Adapter-Aufzählung, prozessweite Sperren im
Grafikstapel. Er ist dafür gedacht, beim Programmstart einmal zu laufen. Ihn im
Bildtakt zu fahren, heisst, sechzigmal je Sekunde denselben Aufbau zu machen — und
zwar auf demselben Thread und gegen dieselben Treibersperren, die gleichzeitig das
Präsentieren des Fensters und (auf dieser APU) das Dekodieren bedienen.

**Und es steht in einem Messloch.** Der Aufruf liegt zwischen den beiden Abschnitten,
die der Player selbst misst: `upload_took` endet in `app/mod.rs:507`, `render_started`
beginnt in `app/mod.rs:558`. Die Zeile 517 liegt dazwischen. **Diese Kosten tauchen
in keiner Statistikzeile auf** — weder in „hochladen" noch in „ausgeben". Das ist
zugleich die Erklärung dafür, warum die Zahlen gut aussehen können, während der
Eindruck es nicht tut.

**Sicherheit der Feststellung:** hoch. Der Aufrufort, die Reihenfolge der
`&&`-Kette und die Lage zwischen den Messpunkten sind alle im Code eindeutig.

**Wirkung:** [UNBELEGT]. Ich habe keine Zahl für `CreateDXGIFactory1` auf dieser
Maschine, und ich erfinde keine. Was sich sagen lässt: es ist der einzige gefundene
Punkt, an dem eine **Windows-Systemschnittstelle mit Aufbau-Charakter** im Bildtakt
läuft, und er läuft ausschliesslich in der Betriebsart, um die es auf diesem Zweig
geht.

**Behebung:** klein. Das Ergebnis von `schirm_ist_hdr` in ein Feld legen und nur
erneuern, wenn es sich ändern kann — das Fenster wechselt den Schirm
(`WindowEvent::Moved`), der Skalierungsfaktor ändert sich, oder schlicht: höchstens
einmal je Sekunde. Alternativ die `&&`-Kette umdrehen und zuerst gegen
`self.hdr_gewuenscht` vergleichen, aber das ist die schlechtere Lösung: dann würde ein
Wechsel des Schirms nach HDR nie bemerkt.

**Gefahr dabei:** gering, aber nicht null. Wer zu grob zwischenspeichert, merkt das
Umschalten des Schirms auf HDR erst spät oder gar nicht. Die Eigenschaft, die der
Kommentar an `farbraum_fuer_quelle` schützt („nach JEDEM `surface.configure` erneut"),
darf dabei nicht kippen.

**Zuerst messen, dann bauen.** Ein `Instant::now()` um Zeile 517 herum, für einen Lauf,
beantwortet das in fünf Minuten und macht aus [UNBELEGT] eine Zahl. Solange das nicht
geschehen ist, ist dieser Punkt **der begründete Verdacht Nummer eins**, nicht mehr.

---

## 2. Die Stockung der Grafikeinheit hält gleichzeitig den Netzempfang an

**Wo:** `src/session.rs:537` (`emit_frames` im `tokio::select!`-Rumpf) in Verbindung mit
`src/zerocopy/bruecke.rs:314-322` (CPU-Zaun) bzw. `src/decode.rs:1286`
(`av_hwframe_transfer_data`).

**Was passiert.** Zwischen Depacketisierung und Dekodierung gibt es **keinen Kanal**.
`session::run` ruft `emit_frames` direkt in derselben Schleife auf, die auch die
RTP-Pakete aus `rtp_rx` (Kapazität 1024, `session.rs:205`) abholt. Solange dekodiert
wird, wird nicht empfangen.

Im gesunden Betrieb ist das folgenlos und ausdrücklich gewollt — die Begründung steht
sauber an `session.rs:813-819` (kein Rückstau, das neueste Bild ist das richtige).

Im **Stockungsfall** ist es das nicht. Beide Wartepunkte sind unbegrenzt:

* `bruecke.rs:314-322`: `Flush()` und dann `WaitForSingleObject(..., INFINITE)` auf den
  Zaun nach der GPU-internen Kopie.
* `decode.rs:1286`: `av_hwframe_transfer_data` auf dem Rückfallweg.

**[GEMESSEN]** Diese Wartezeiten liegen in Serien bei **0,7 bis 2,5 Sekunden**
(`streaming/testbench/profiles/player-2026-08-06-absturz-ist-eine-stockung.json`,
bestätigt in `player-2026-08-06-zuschauer-fliegt-nach-zwei-minuten.json`), 40
Video-TDR in 200 Sekunden. Der Aufruf kehrt dabei **erfolgreich** zurück, nur spät.

**Die Folge, die bisher nirgends steht.** Zwei Sekunden ohne Abholung aus `rtp_rx`.
Bei 12 Mbit/s und ~1200 Byte Nutzlast je Paket sind das **[GERECHNET]** rund
1200-2000 Pakete je Sekunde, also 2400-4000 Pakete in der Stockung — bei einer
Kanalkapazität von 1024. Der Kanal läuft über, der WHEP-Empfangs-Task verwirft (oder
blockiert, je nach Sendeart), und was dabei verlorengeht, sieht für den Player
hinterher aus wie Paketverlust auf der Leitung. Der bereits belegte Ablauf —
Stockung → Fehlerserie → Neuaufbau → nach drei Serien Sitzungsende
(`player-2026-08-06-zuschauer-fliegt-nach-zwei-minuten.json`) — hat hier eine
Verstärkerstufe, die in der Akte als eigener Punkt fehlt.

**Sicherheit der Feststellung:** hoch für die Kopplung (der Code hat dort keinen
Kanal), **mittel** für die Verstärkerwirkung — die Paketrate ist gerechnet, und ob der
Sende-Task blockiert oder verwirft, habe ich nicht bis in `whep.rs`/webrtc-rs
zurückverfolgt.

**Behebung, drei Grössen:**

1. **Klein, wirkt sofort:** die Dekodierung über `tokio::task::spawn_blocking` fahren
   statt inline. Dann läuft der Empfang während einer Stockung weiter, der Jitter-Puffer
   fängt sie ab, und aus einer Stockung wird ein Ruckler statt einer Verlustserie.
   Gefahr: die Reihenfolge der Bilder und der Zugriff auf `decoder` müssen dabei
   erhalten bleiben; das ist ein echter Umbau der Schleife, kein Handgriff.
2. **Mittel, ist bereits notiert:** der „tiefere Schnitt" aus
   `player-2026-08-06-zuschauer-fliegt-nach-zwei-minuten.json` — `GiveUp` gibt den
   *Decoder* auf, nicht die *Sitzung*. Für die Tonspur ist genau das schon so gelöst
   (`audio.rs`, „bleibt stumm"); für die Bildspur stirbt die Verbindung.
3. **Gar nicht behebbar im Player:** die Ursache. Auf einer 780M encodiert der Sidecar
   AV1 in 10 Bit und dekodiert der Player AV1 in 10 Bit — **auf derselben einen
   Video-Einheit**. Die Akte sagt es selbst: „gleichzeitiges AV1-Encodieren und
   -Dekodieren in 10 Bit auf dieser einen APU reicht offenbar schon". Kein
   Player-Handgriff ändert daran etwas. Wer diese Stockungen wirklich loswerden will,
   muss Sender und Zuschauer trennen oder die Last senken (8 Bit, H.264, kleinere
   Auflösung) — und das gehört in eine Sidecar-Betrachtung, nicht hierher.

---

## 3. Der Einfrier-Wächter kostet je Bild eine eigene Abgabe an die GPU-Warteschlange

**Wo:** `src/render/abdruck.rs:206-233` (`Abdruckwerk::schritt`), gerufen aus
`src/render/mod.rs:224-234` — also **vor** dem eigentlichen Zeichendurchgang, in einem
eigenen Kommandopuffer.

**Was passiert, je Bild:**

1. `queue.write_buffer` (16 Byte Kopfdaten)
2. `device.create_command_encoder` — ein frischer Kommandopuffer
3. `enc.clear_buffer` + Rechendurchgang + `copy_buffer_to_buffer`
4. **`queue.submit`** — eine zweite, eigene Abgabe an die Warteschlange
5. `map_async` auf einen Ringpuffer
6. in `ernten` (Zeile 250): `device.poll(PollType::Poll)`

Danach folgt in `render/mod.rs:357-409` derselbe Ablauf noch einmal für das Bild:
Encoder, Zeichendurchgang, Overlay, `submit`.

**[GEMESSEN]** Der Posten kostet **rund 0,3 ms je Bild** — der Statistikposten
„hochladen" stieg von 0,0-0,1 auf 0,3-0,4 ms, als der Fingerabdruck dazukam
(`player-2026-08-06-einfrier-waechter-auf-der-gpu.json`, im README als offener Punkt
notiert: „in den Zeichendurchgang gefaltet wäre er billiger").

**Was in dieser Zahl noch nicht steckt.** 0,3 ms ist die gemessene *CPU*-Zeit. Der
Punkt ist aber die **zweite `submit`**: unter D3D12 ist jede Abgabe ein
`ExecuteCommandLists` samt Zaun-Signal, und der Rechendurchgang liegt in derselben
Warteschlange wie der Zeichendurchgang — er wird also vor ihm abgearbeitet und
serialisiert gegen ihn. Auf einer GPU, die ohnehin am Anschlag läuft, ist eine
zusätzliche Serialisierung je Bild teurer als die 0,3 ms CPU vermuten lassen.
**[UNBELEGT]** — wie viel teurer, sagt nur eine Messung.

**Sicherheit der Feststellung:** hoch. Zwei getrennte Encoder und zwei `submit` je Bild
sind im Code unmittelbar abzulesen.

**Behebung:** mittel. Den Rechendurchgang in denselben Encoder legen, den `render`
ohnehin anlegt — dann eine `submit` je Bild statt zwei. Erfordert, dass `upload`
(wo `schritt` heute läuft) und `render` sich einen Encoder teilen, also eine Umstellung
der Schnittstelle zwischen den beiden.

**Gefahr:** gering für die Richtigkeit (der Rechendurchgang muss weiterhin vor der
Kopie in den Abholpuffer liegen, das bleibt innerhalb eines Encoders erhalten),
mittel für die Ordnung — die Trennung „upload lädt, render zeichnet" ist heute sauber
und würde weicher.

**Kleinere Variante ohne Umbau:** den Fingerabdruck nicht je Bild, sondern jedes
n-te Bild rechnen. Der Wächter zählt über Sekunden und ist gegen Stichproben
unempfindlich — das steht wörtlich in `render/abdruck.rs:28-32` („Ist gerade kein
Platz frei, fällt der Abdruck dieses einen Bildes aus. Das ist kein Fehler, sondern
der Gegendruck"). Bei jedem dritten Bild fielen zwei Drittel der Kosten weg, ohne dass
sich am Verhalten des Wächters etwas ändert. Das ist der billigste Gewinn in diesem
ganzen Dokument.

---

## 4. Bei sichtbarer Bedienleiste wird die ganze Oberfläche je Bild neu gebaut

**Wo:** `src/app/mod.rs:525-526` (`want_overlay`), `src/overlay/mod.rs:338-391`
(`paint`), `src/overlay/controls.rs:34-89` (Statistikfeld).

**Was passiert.** `wants_redraw` entscheidet richtig, *ob* ein Durchgang angestossen
wird — die Begründung aus dem README trägt heute noch (geprüft: alle drei Gründe in
`overlay/mod.rs:304-306` sind selbstlöschend, `stats_dirty` hängt an den
Statistik-Ereignissen und damit an **4 je Sekunde**, nicht an der Bildrate; und es ist
kein `set_request_repaint_callback` installiert, egui kann sich also nicht selbst
wecken). Die Selbstauslösungs-Schleife ist strukturell verhindert.

Was *in* einem ohnehin stattfindenden Durchgang gebaut wird, entscheidet dagegen
`visible()` — und das ist nach einer einzigen Mausbewegung **drei Sekunden lang wahr**.
In dieser Zeit läuft je Bild der vollständige egui-Weg: `take_egui_input`, `run_ui`
über etwa 25 Bedienelemente samt Trefferprüfung, `tessellate` (die ganze Oberfläche in
Dreiecke, auf der CPU), `update_buffers`, zweiter Zeichendurchgang.

Allein `controls.rs:34-89` erzeugt dabei **[GERECHNET]** über zwanzig Zeichenketten je
Durchgang (13-16 Zeilen, jede mit `format!`/`to_string`) — bei 60 Bildern je Sekunde
rund 1200, bei 144 rund 3000 je Sekunde. Die Werte, die sich ändern, verfehlen dabei
auch den Textcache von egui und werden je Durchgang neu gesetzt.

**Das Zusammensetzen ins Bild ist unvermeidbar** — `render/mod.rs:368` löscht die
Oberfläche je Bild mit `LoadOp::Clear`, das Overlay muss also in jedes präsentierte
Bild neu hinein. **`run_ui` und `tessellate` sind es nicht:** solange weder eine
Eingabe anliegt noch neue Zahlen vorliegen noch sich die Fenstergrösse geändert hat,
ist das Ergebnis bitgleich zum Vorgänger.

**Sicherheit der Feststellung:** hoch, dass die Arbeit je Bild anfällt.
**Wirkung: [UNBELEGT]** in der absoluten Höhe — sie steckt allerdings vollständig im
Posten „ausgeben" der Statistikzeile (`render_started` in `app/mod.rs:558` liegt vor
`renderer.render`, das `paint` aufruft). Ein Vergleich dieser Zahl mit sichtbarer und
mit ausgeblendeter Leiste ist die direkte Messung und kostet nichts.

**Behebung:** mittel. `tris` und `pixels_per_point` im `Overlay` halten und bei
unverändertem Zustand nur noch `update_buffers` + Zeichnen fahren.

**Gefahr:** mittel. Der zwischengespeicherte Aufbau muss bei Grössenwechsel,
Skalierungswechsel und Formatwechsel (`zeichner_neu`) verworfen werden — drei Stellen,
an denen ein vergessener Fall zu einer falsch skalierten Oberfläche führt.

---

## 5. Der Ausgabe-Takt steht auf 60 ms — und vier Kommentare behaupten das Gegenteil

**Wo:** `src/proto.rs:212` (`AUSGABETAKT_MS_VORGABE = 60`), `src/proto.rs:250`
(`defaults()`), `src/app/mod.rs:331`.

**Was gilt.** `open` beginnt bei `PlayerOptions::defaults()`, und dort steht
`ausgabetakt_ms: Some(60)`. Der Ausgabe-Takt ist also **eingeschaltet**, es sei denn,
die App schickt ausdrücklich etwas anderes.

**Was der Code an vier Stellen behauptet — und was falsch ist:**

* `src/app/takt.rs:22-23`: „Vorgabe ist deshalb AUS (`vorhalt = 0`)"
* `src/app/mod.rs:171-172`: „Bei ausgeschaltetem Vorhalt — der Vorgabe —"
* `src/app/mod.rs:809-812`: „Bei ausgeschaltetem Vorhalt — der Vorgabe —"
* `src/app/mod.rs:901-904`: „das ist der Vorgabefall mit ausgeschaltetem Vorhalt"

Alle vier stammen aus der Zeit vor dem Umstellen der Vorgabe. Die Messung, die das
Umstellen begründet, steht sauber an `proto.rs:142`; nachgezogen wurde sie nur dort.
Das ist genau das Muster, gegen das die Regel in `CLAUDE.md` steht („eine Behauptung
wird nie an nur EINER Stelle korrigiert").

**Warum es hier steht.** Erstens, weil es zwei Punkte weiter unten (Nummer 10) real
Arbeit verursacht, die niemand erwartet. Zweitens, weil der Vorhalt der **grösste
einzelne Verzögerungsposten des Players** ist und der Nutzer wissen soll, dass er ihn
in der Hand hat:

**[GEMESSEN]** (`ausgabetakt-2026-08-05-windows-produktion.json`, drei Paare,
abwechselnd gefahren, gleiche Richtung ohne Überlappung):

| | Takt aus | Takt 60 ms |
|---|---|---|
| grösster Ausgabe-Abstand, Median | 24,6 / 41,5 / 36,7 ms | 17,4 / 17,3 / 17,2 ms |
| Sekunden mit einem Abstand über 33 ms | 30 / 57 / 52 % | 7 / 22 / 2 % |
| zu späte Bilder je Lauf | 24 / 30 / 22 | 3 / 15 / 0 |
| Netz-bis-Schirm, Median | 4,5 ms | 59,5 ms |

Das ist ein sauberer Tausch und er ist bewusst so eingestellt: **55 ms zusätzliche
Verzögerung gegen ungefähr eine Halbierung der Ungleichmässigkeit.** Wer „es fühlt
sich träge an" sagt, meint mit hoher Wahrscheinlichkeit diese 55 ms; wer „es ruckelt"
sagt, meint sie nicht.

**Sicherheit:** hoch für alles hier — Vorgabewert, Messwerte und die vier veralteten
Kommentare sind alle unmittelbar belegt.

**Handlungsvorschlag:** keine Code-Änderung, sondern eine **Entscheidung**. Wenn der
Eindruck „träge" ist, `ausgabetakt_ms` auf 20-30 ms zu stellen wäre der erste Versuch
(die Messung deckt nur 0 und 60 ab, dazwischen ist nichts erhoben). Die vier
Kommentare gehören unabhängig davon berichtigt.

---

## 6. Der CPU-Zaun je Bild — und die Begründung, warum er bleiben muss, stimmt nicht mehr

**Wo:** `src/zerocopy/bruecke.rs:292-322`.

**Was passiert.** Nach der GPU-internen Kopie wartet der Decoder-Thread auf der CPU,
bis die Kopie durch ist: `Flush()`, dann bei nicht erreichtem Zaunwert
`SetEventOnCompletion` + `WaitForSingleObject(..., INFINITE)`. Je Bild. Auf demselben
Thread, der die RTP-Pakete abholt (siehe Punkt 2).

**[GEMESSEN]** Im gesunden Betrieb unter einer Millisekunde
(`player-2026-08-06-zerocopy-im-player.json`, „weitere_kosten/cpu_zaun"); im
Stockungsfall steht dort die ganze Wartezeit.

**Die Begründung im Code ist überholt.** `bruecke.rs:299-303` sagt, der saubere Weg —
geteilter Zaun, `ID3D12Fence::Wait` auf der wgpu-Warteschlange — „bräuchte einen
Zugriff auf die Warteschlange, den wgpu 29 nicht anbietet". Das habe ich nachgesehen,
und es stimmt nicht:

* `wgpu::Queue::as_hal::<Dx12>()` gibt es —
  `wgpu-29.0.4/src/api/queue.rs:339`.
* `wgpu_hal::dx12::Queue::as_raw()` liefert `&ID3D12CommandQueue` —
  `wgpu-hal-29.0.4/src/dx12/mod.rs:792`.
* Der Player benutzt denselben Ausstieg bereits zweimal:
  `render/fremdbild.rs:294` (`as_hal` → `raw_device()`) und
  `render/hdr_fenster.rs:67` (`as_hal` → `swap_chain()` → `SetColorSpace1`).

Der Weg ist also offen. **Er ist aber nicht kostenlos**, und das gehört dazu: der Zaun
wird heute mit `D3D11_FENCE_FLAG_NONE` angelegt (`bruecke.rs:144`), also **nicht
teilbar**. Für den Umbau bräuchte es `D3D11_FENCE_FLAG_SHARED`, ein
`CreateSharedHandle`, ein `OpenSharedHandle` auf wgpus D3D12-Gerät nach `ID3D12Fence`
und dann `Wait(fence, wert)` auf der Warteschlange.

**Sicherheit:** hoch für die Widerlegung der Begründung (drei Fundstellen, alle
nachgesehen). **Mittel** dafür, dass der Umbau am Ende trägt — der geteilte Zaun ist
ein bekannter, aber nicht trivialer D3D11↔D3D12-Weg, und ob AMDs Treiber ihn hier
sauber bedient, weiss man erst danach.

**Wirkung: [UNBELEGT]**, aber die Richtung ist klar: er nimmt je Bild eine
CPU-Wartezeit unter einer Millisekunde weg und, wichtiger, entkoppelt den
Stockungsfall von der RTP-Abholung (Punkt 2). Ein Wechsel auf wgpu 30 hilft
übrigens **nicht** — auch dort gibt es auf der sicheren Oberfläche keinen
Warte-Aufruf (nachgesehen in `wgpu-30.0.0/src/api/queue.rs`).

---

## 7. `AcquireSync(..., INFINITE)` innerhalb von FFmpegs Gerätesperre

**Wo:** `src/zerocopy/bruecke.rs:275-290`.

Je Bild wird FFmpegs `lock_ctx` genommen und **innerhalb** dieser Sperre unbegrenzt auf
den Schlüssel-Mutex des Ringplatzes gewartet. Hält der Renderer diesen Platz gerade
(er tut es, während er daraus zeichnet), blockiert damit nicht nur dieser Thread,
sondern jeder andere FFmpeg-Nutzer des Gerätekontexts.

Im Regelfall tritt das nicht ein — ein Platz wird erst nach seinem `Drop` wieder
ausgegeben (`platz.rs:87-90`, angestossen über `queue.on_submitted_work_done` in
`render/mod.rs:421`). Wenn es eintritt, ist es unbegrenzt.

**Sicherheit:** hoch für die Struktur, **[UNBELEGT]** für die Häufigkeit — aus dem
Code nicht ableitbar.

**Behebung:** eine Zeitschranke statt `INFINITE` (`AcquireSync` nimmt eine
Millisekundenangabe), und bei Ablauf dieses eine Bild über den Rückfallweg schicken.
Klein, risikoarm, und es verwandelt einen möglichen Totalhänger in einen einzelnen
teureren Frame.

---

## 8. Zwei Kleinigkeiten je Bild, die ohne Gegenwert laufen

Beide mit **Sicherheit: hoch**, beide in Minuten zu beheben, beide **[UNBELEGT]** in
der Wirkung — aber sie kosten nichts ausser dem Handgriff.

**a) `is_keyframe` läuft zweimal auf denselben Daten** —
`src/decode.rs:887` und `src/decode.rs:907`. Dazwischen wird `data` nicht verändert.
`scan_av1_for_keyframe` läuft dabei die ganze OBU-Kette der Zugriffseinheit ab. Ein
`let ist_keyframe = …` am Anfang halbiert das.

**b) `PlanePool::default()` je GPU-Bild** — `src/zerocopy/uebergabe.rs:106`. Der
Vorrat ist ein `Arc<Mutex<Vec<Vec<u8>>>>` (`decode.rs:372`); `default()` legt je Bild
einen frischen Arc-Block an, für einen Vorrat, der auf dem Zero-Copy-Weg garantiert
nie benutzt wird — `Drop` springt wegen leerer `planes` sofort heraus
(`decode.rs:511`). Eine Anforderung plus Freigabe je Bild, ohne Zweck.

---

## 9. Der Regler in der Bedienleiste erzeugt je Wertänderung eine Zeile auf stdout — mit `flush`

**Wo:** `src/overlay/controls.rs:253-258` → `src/app/mod.rs:699-710` →
`src/app/requests.rs:143-165` → `src/rpc.rs:25-31`.

Ein `slider.changed()` löst je Durchgang aus: ein `request_redraw` (das dabei die
`FRAME_FLOW_WINDOW`-Bremse aus `app/mod.rs:963-967` umgeht, weil die nur in
`window_event` sitzt), ein `runtime.spawn` mit `Box::new(patch)` — **ein Tokio-Task je
Wertänderung** —, und in `rpc.rs:26-30` ein `to_string` plus `writeln!` plus
**`flush()` je Nachricht**, also ein Schreib-Syscall auf die Pipe, **auf dem
Fenster-Thread**.

Da `paint` bei sichtbarer Leiste mit Bildrate läuft (Punkt 4), erzeugt das Ziehen des
Lautstärkereglers bis zu **[GERECHNET]** 60-144 JSON-Zeilen je Sekunde nach vorne.

**Der Preis ist nicht die CPU, sondern die Kopplung:** leert die Electron-Seite die
Pipe nicht, blockiert `flush` und damit die **gesamte** Fensterschleife —
Bildannahme, Eingabe, RPC.

**Sicherheit:** hoch für den Mechanismus. **[UNBELEGT]**, ob die Pipe je wirklich
blockiert — die Zeilen sind klein und der Pipe-Puffer üblicherweise 64 KB.

**Behebung:** klein. `player:option` entprellen (nur bei `drag_stopped()` oder
höchstens zehnmal je Sekunde melden); die Anwendung auf die laufende Sitzung bleibt
sofort.

**Nebenbefund an derselben Stelle, kein Performance-Punkt:** `SessionCommand::Options`
geht über einen Kanal (Kapazität 16, `app/mod.rs:374`), zugestellt aus je einem
eigenen Task. Die **Reihenfolge** zweier schnell aufeinanderfolgender Lautstärkewerte
ist damit nicht garantiert.

---

## 10. Feinschliff — richtig, aber unterhalb der Wahrnehmungsschwelle

Alle mit **Sicherheit: hoch** für das Vorkommen und **[UNBELEGT]/gering** für die
Wirkung. Sie stehen hier, damit niemand sie zweimal sucht, nicht als Auftrag.

| Wo | Was | Anmerkung |
|---|---|---|
| `app/mod.rs:962-967` | Im Standbild bekommt **jede** Mausbewegung ihren eigenen vollen Durchgang. Die Bremse greift nur bei fliessendem Bild. Mit `Mailbox` als Präsentationsart gibt es dabei keine Drosselung auf die Bildwiederholrate — die Obergrenze ist die Abtastrate der Maus, bis ~900/s | Nur im Standbild, bei Stockung oder vor dem ersten Bild |
| `overlay/mod.rs:310-314` | `mark_stats_dirty` fragt `visible()`, aber nicht `stats_visible`. Bei ausgeblendetem Zahlenfeld erzeugen die Statistik-Ereignisse 4 pixelgleiche Durchgänge je Sekunde | Einzeilige Korrektur |
| `app/mod.rs:915` | `about_to_wait` legt je Schleifendurchlauf eine `Vec` an. Der Schnellweg davor greift nur bei leerer Takt-Warteschlange — **und die ist mit der heutigen Vorgabe von 60 ms nie leer** (siehe Punkt 5). Die Ausnahme ist zum Regelfall geworden | Wirkung minimal; erwähnenswert als Folge der veralteten Annahme |
| `decode.rs:598`, `:636`, `einfrieren.rs:533/571/582`, `stockung.rs:130` | **Fünf bis sechs `std::env::var` je Bild.** Unter Windows je ein `GetEnvironmentVariableW` samt prozessweiter Sperre und ein bis zwei kleinen Anforderungen | **Ehrlich: unterhalb der Messschwelle.** Es steht trotzdem hier, weil `zerocopy/mod.rs:103-108` die Regel („Nicht je Bild") ausschreibt und `mod.rs:117-126` die Lösung (`OnceLock` + `AtomicBool`) fertig danebenstellt. Ein Aufräumpunkt, kein Leistungspunkt |
| `app/mod.rs:528` + `overlay/controls.rs:73` | Zwei `String` je Bild für das Oberflächenformat | Die erste löst einen echten Leihkonflikt auf und ist nicht so leicht wegzubekommen, wie sie aussieht; die zweite ist frei |
| `decode.rs:1289`, `:1332` | Zwei `eprintln!` **ohne jede Dämpfung** im Fehlerfall, je Bild — bei 60 fps sechzig ungepufferte stderr-Zeilen je Sekunde | Kein Dauerzustand, aber genau dann teuer, wenn ohnehin etwas schiefläuft. `uebergabe.rs:20-22` vermeidet dasselbe an anderer Stelle ausdrücklich |
| `app/mod.rs:267-307` | Der Auffangnetz-Pfad nimmt je Bild zweimal einen Mutex und macht zwei Task-Sprünge | Läuft heute nie, siehe „Nichts zu holen", Punkt E |

---

# Wo nichts zu holen ist

Dieser Teil ist genauso wichtig wie die Liste oben: er spart den nächsten Anlauf.

## A. Der Shader — auch mit dem HDR-Zweig

`src/render/shader.wgsl`. Der Verdacht liegt nahe: 15 Texturabtastungen, drei bis vier
`sin`/`cos`, und seit dem HDR-Zweig bis zu **neun** `pow` je Bildpunkt (sechs in
`pq_zu_nits`, drei in `linear_to_srgb` auf dem Weg zum SDR-Schirm). Das sieht teuer aus.

**[GERECHNET]**, und das Ergebnis ist eindeutig:

Eine Radeon 780M hat 12 Recheneinheiten mit je 64 Bahnen bei rund 2,7 GHz, also grob
2,1 Billionen einfache Gleitkomma-Bahnoperationen je Sekunde. Transzendente Funktionen
(`sin`, `exp2`, `log2`) laufen mit einem Viertel dieser Rate, also rund 520 Milliarden
je Sekunde. Ein `pow` ist `log2` + Multiplikation + `exp2`, also zwei transzendente
Operationen.

Der teuerste Fall — HDR-Quelle auf SDR-Schirm, Deband an, Dither an — kostet je
Bildpunkt neun `pow` (= 18) plus vier trigonometrische (= 4), zusammen **22
transzendente Operationen**.

* 1080p bei 60 Bildern je Sekunde: 124 Millionen Bildpunkte je Sekunde
  → 2,7 Milliarden Operationen je Sekunde → **0,5 % des Budgets**
* 1440p im Vollbild bei 60: 221 Millionen Bildpunkte je Sekunde → **0,9 %**

Die Texturabtastungen sind ebenso unkritisch: 12 Recheneinheiten mit je vier
Textureinheiten bei 2,7 GHz ergeben rund 130 Milliarden bilineare Abtastungen je
Sekunde; 15 Abtastungen auf 124 Millionen Bildpunkte sind 1,9 Milliarden, also
**etwa 1,5 %**.

**Der bewusst nicht gemachte Vorschlag aus dem README — Verstärkung und Nullpunkt auf
der CPU vorberechnen — ist auch heute richtig, nicht gemacht zu werden**, und zwar aus
zwei Gründen. Erstens ist das Budget, wie eben gerechnet, gar nicht knapp. Zweitens
sind die fraglichen Ausdrücke (`128.0 / k`, die Divisionen durch 219 und 224) über
`u.output.z` uniform und über alle fünf Aufrufe von `yuv_to_rgb` je Bildpunkt
identisch — jeder Shader-Übersetzer zieht sie aus den fünf Aufrufen heraus. Die
Vorberechnung auf der CPU spart also etwas, das ohnehin schon nur einmal je Bildpunkt
passiert.

**Der HDR-Zweig kostet nichts Nennenswertes.** Er verdoppelt die Zahl der
transzendenten Operationen ungefähr — von rund einem halben Prozent auf rund ein
Prozent. Das ist nicht der Grund, warum sich etwas schlecht anfühlt.

**Wichtige Einschränkung dieser Rechnung:** sie betrifft die **Recheneinheiten** der
GPU. Sie sagt nichts über die **Video-Einheit** (VCN), und genau die ist auf dieser APU
der Engpass — dort laufen Encodieren und Dekodieren gleichzeitig (siehe Punkt 2). Wer
den Shader vereinfacht, entlastet den falschen Teil des Chips.

## B. Der Rechendurchgang des Fingerabdrucks

`src/render/abdruck.wgsl`. Naheliegender Verdacht: zwei Millionen `atomicAdd` auf
dieselben zwei Speicherstellen. Falsch — der Shader macht eine Baumreduktion im
Arbeitsgruppen-Speicher und gibt je Gruppe **eine** atomare Addition ab. Bei 1080p sind
das 32 400 Gruppen, also 64 800 atomare Zugriffe statt 2 Millionen. Der Kommentar an
Zeile 44-47 sagt es und stimmt.

Teuer ist an dieser Stelle nicht die Rechnung, sondern ihre **Verpackung** — siehe
Punkt 3 der Rangliste.

## C. Das Herunterrechnen von 10 auf 8 Bit

`src/render/farbe.rs:180-193` (`narrow_plane_into`), gerufen aus
`src/render/bildquelle.rs:195-201`. Sieht teuer aus (`chunks_exact(2).map(…)` über
Megabytes) und läuft auf dieser Maschine **nie**: die Bedingung ist
`frame.ten_bit && !wide_textures`, und `wide_textures` ist wahr, sobald die GPU
`TEXTURE_FORMAT_16BIT_NORM` kann. Die Messakte sagt es ausdrücklich
(`player-2026-08-06-bildweg-kosten.json`). Ausserdem ist der Zielpuffer wiederverwendet
und fordert nach dem ersten Bild nichts mehr an.

## D. Der Ebenen-Vorrat, die Ringplatz-Suche und der Import

Drei Stellen, an denen die naheliegende Vermutung nicht zutrifft:

* **`PlanePool`** (`decode.rs:382-410`) wird wirklich wiederverwendet: `pop`, dann
  `clear` + `reserve` — `clear` hält die Kapazität, `reserve` fordert bei
  ausreichender Kapazität nichts an. Deckel bei 8, Rückgabe über `Drop`, Test in
  `decode.rs:1412-1426`. Sauber gebaut.
* **Die Ringplatz-Suche** (`platz.rs:23-25`) ist keine Suche: ein Mutex-Griff und ein
  `Vec::pop`, konstante Zeit. Die Freiliste ist bewusst vom Ring getrennt, weil die
  Rückgabe vom Render-Thread kommt.
* **`OpenSharedHandle`** (`fremdbild.rs:127-131`) läuft **zwölfmal je Sitzung**, nicht
  je Bild — der Zwischenspeicher ist über das NT-Handle geschlüsselt und trägt die
  Bindegruppe gleich mit. Das war der Unterschied zwischen 0,1-0,2 und 0,0-0,1 ms
  Hochladen **[GEMESSEN]** und ist bereits gemacht.

## E. Der Auffangnetz-Pfad — heute folgenlos, aber eine Falle für später

`src/app/mod.rs:259-315` (`spawn_with_fallback`) fährt **zwei vollständige
WHEP-Sitzungen** nebeneinander: zwei Jitter-Puffer, zwei Zusammensetzer, **zwei
Hardware-Decoder**, zwei Ton-Senken, zwei Aufnahme-Ringpuffer, zwei Zero-Copy-Ringe zu
je zwölf geteilten Texturen. Die Bilder der zweiten werden im Regelfall weggeworfen.

**Es läuft heute nicht.** Der Pfad hängt an `req.fallback_url`, und **niemand setzt
das Feld** — gesucht über `desktop/`, `web/src/` und `streaming/`, einzige Fundstellen
sind die Definition selbst. Also aktuell kein Kostenpunkt.

**Aber es ist eine Falle.** Wer das Feld eines Tages von der Electron-Seite füllt,
verdoppelt auf dieser APU die Dekodierlast — und die ist nach Punkt 2 schon der
Engpass. Zusätzlich läuft die Ton-Senke der zweiten Sitzung ungefiltert weiter: die
Aussortierung findet erst im Fenster-Thread statt (`app/mod.rs:294-302`), der
`MediaSink` sitzt aber **innerhalb** von `session::run` und gibt über cpal direkt aus.
Zwei gleichzeitige Tonausgaben desselben Streams. **Sicherheit: hoch** für die
Struktur, **[UNBELEGT]**, weil nie gelaufen.

## F. Die Präsentationsart und die Zahl der Swapchain-Bilder

`src/render/setup.rs:230-266`. Der Kommentar begründet `desired_maximum_frame_latency: 2`
mit einer Zeile aus **`wgpu-hal-29.0.4/src/vulkan/swapchain/native.rs:192`** — der
Player fährt unter Windows aber seit dem HDR-Umbau **D3D12**. Der Beleg passt also
nicht mehr zum Weg.

Nachgesehen: **die Schlussfolgerung stimmt trotzdem.**
`wgpu-hal-29.0.4/src/dx12/mod.rs:1344` rechnet `maximum_frame_latency + 1`, es sind
also auch dort drei Swapchain-Bilder, und `mod.rs:1504` setzt zusätzlich
`SetMaximumFrameLatency(2)`. `Mailbox` wird vom dx12-Backend immer angeboten
(`adapter.rs:1276`) und auf Präsentationsintervall 0 abgebildet (`mod.rs:1639`).

**Hier ist nichts zu ändern** — nur die Quellenangabe im Kommentar gehört berichtigt,
sonst prüft der Nächste wieder die Vulkan-Datei.

## G. Der Jitter-Puffer

`src/jitter.rs`. Sieht nach einem Latenzposten aus (`JITTER_MS_VORGABE = 100`), ist
keiner: `poll` gibt ein Paket frei, sobald es `target` lang liegt **oder alle Vorgänger
da sind** (`jitter.rs:231-236`). Bei lückenlosem Strom greift immer die zweite
Bedingung. Die 100 ms sind die Geduld bei einer **Lücke**, keine Wartezeit im
Regelbetrieb. Das `Vec::new()` in `poll` fordert nichts an, solange nichts
herausgegeben wird.

## H. Einiges an der Bedienoberfläche, das teuer aussieht

Schriften (`theme.rs:83-110`) werden über `FontData::from_static` eingebunden — keine
Kopie, und der Aufruf steht nur in `Overlay::new`. `theme::icon::*` expandiert zu
statischen Bytes; der Bildlader hält die gerasterte SVG im Zwischenspeicher, es bleibt
eine Hash-Suche je Symbol. `StatsView` (`app/mod.rs:531-553`) ist reiner Stapelspeicher.
`log_stats_if_due` prüft sein Flag vor allem anderen.

Und: **egui-Ereignisse werden aufgestaut**, nicht einzeln verarbeitet
(`overlay/mod.rs:238-284` sammelt nur, `take_egui_input` in Zeile 338 leert). Das ist
die richtige Bauart — ein Durchgang verarbeitet alle seit dem letzten angefallenen
Ereignisse.

---

# Was zuerst zu messen wäre

Vier Punkte hängen an je einer billigen Messung. Solange die nicht vorliegt, ist die
Rangfolge oben ein begründeter Verdacht und kein Befund.

1. **Punkt 1** — `Instant::now()` um `app/mod.rs:517`. Ein Lauf. Danach ist entweder
   der grösste Posten des Dokuments belegt oder gestrichen.
2. **Punkt 4** — den Statistikposten „ausgeben" einmal mit sichtbarer und einmal mit
   ausgeblendeter Bedienleiste ablesen. Kostet nichts ausser einer Mausbewegung.
3. **Punkt 3** — den Fingerabdruck versuchsweise nur jedes dritte Bild rechnen und den
   Posten „hochladen" vergleichen. Die Änderung ist zwei Zeilen und rückgängig zu
   machen.
4. **Punkt 5** — `ausgabetakt_ms` auf 20 und auf 30 stellen und den Eindruck gegen 60
   halten. Die vorhandene Messung deckt nur 0 und 60 ab.

Und eine Sache, die keine Messung braucht: **die vier veralteten Kommentare zum
Ausgabe-Takt** (Punkt 5) sowie die beiden falschen Begründungen (`bruecke.rs:299-303`,
Punkt 6, und die Vulkan-Quellenangabe in `setup.rs`, Punkt F) gehören berichtigt,
unabhängig davon, ob je etwas umgebaut wird. Sie kosten sonst dem Nächsten genau die
Stunden, die sie hier gekostet haben.

---

# Grenzen dieser Analyse

* **Nichts gemessen.** Jede Zahl ohne **[GEMESSEN]** ist gerechnet oder geschätzt und
  entsprechend gekennzeichnet.
* **Nur der Player.** `streaming/win-hq-sidecar/` war ausdrücklich ausgenommen. Punkt 2
  legt aber nahe, dass der grösste Einzelposten — die Stockung der Video-Einheit — auf
  dieser APU gar nicht im Player entsteht, sondern in der Gleichzeitigkeit von
  Encodieren und Dekodieren. Ohne die Sidecar-Seite ist dazu nichts Abschliessendes zu
  sagen.
* **Nur AMD, nur diese eine Maschine, nur der HDR-Weg.** Punkt 1 betrifft
  ausschliesslich PQ-Ströme. Auf NVIDIA und Intel ist der Zero-Copy-Weg ohnehin
  ungemessen (README, „Was noch daran hängt").
* **Nicht geprüft:** `whep.rs` und der FEC-Weg über die Paketebene hinaus, `audio.rs`
  jenseits der Sperre in `media.stats()`, `recorder.rs`, `depacket/`. Dort kann etwas
  liegen, das hier nicht steht.
* **Der Rangfolge liegt eine Annahme zugrunde**, die ich nicht prüfen konnte: dass die
  Beschwerde vor allem Stocken und Ungleichmässigkeit meint. Meint sie überwiegend
  Verzögerung, rutscht Punkt 5 an die Spitze und Punkt 1 nach unten.
