# Windows: HQ-Sendeweg und Empfänger — Plan

Ziel, in den Worten des Nutzers: **auf Windows senden können, der Player stellt
es sauber dar und erholt sich nach Fehlern, der Browser kann es auch — und das
über Kreuz** (Linux sendet, Windows schaut zu, und umgekehrt).

Arbeitsweise wie auf der Linux-Seite: jede Stufe ist eine **Frage** mit einem
**Instrument** und einem **Kriterium**. Keine Stufe gilt als beantwortet, bevor
eine Kontrolle gelaufen ist, die das Gegenteil hätte zeigen können.

---

## Was am 2026-08-01 schon gemessen ist

Alles auf Radeon 780M, Treiber 32.0.31035.1003, gebündeltes FFmpeg n8.1.

| Frage | Antwort | Beleg |
|---|---|---|
| Kann AMF Intra-Refresh? | **nein** — nimmt an, wirkt nicht | byte-identische Ströme bei `dirtyIntraRefreshRegions` = korrekt / 0 / 1, für AV1 und H.264 |
| Kann D3D12 es? | **nein brauchbar** — `av1_d3d12va` bricht ab, `h264_d3d12va` ändert 0,47 % ohne `constrained_intra_pred`, ohne recovery point | A/B bei fester Quantisierung |
| Kann Vulkan Video es? | **ja** | +1,8 % bei Umlauf 30, +4,9 % bei Umlauf 10 (richtige Richtung), ein Keyframe im Strom, 0 Decoder-Meldungen |
| Ist der Messaufbau empfindlich genug? | **ja** | Eichung: 30 erzwungene Vollbilder = +9,9 %; erwartet für Umlauf 30 ≈ +2 %, gemessen 1,8 % |
| Heilt Intra-Refresh nach Verlust? | **nein, auf keiner Plattform** | Messakte `decoder-2026-07-29-intra-refresh.json` (Linux, av1_nvenc): ein verworfenes Bild tötet den Strom dauerhaft; Ursache ist der Decoder |
| Was trägt dann? | FEC + NACK + Vollbild beim Beitritt | Messakte `browser-2026-07-31-intra-refresh-unter-stoerung.json`: 358 s, 5 Störzyklen, 0 Standbilder, 1 Anforderung |

> **Nachtrag 2026-08-21:** Die Betriebsart „Intra-Refresh" ist ersatzlos
> entfallen — der Befund „heilt nach Verlust nicht" war einer der vier Gründe
> dafür. Die beiden hier genannten Messakten sind mit ihr gelöscht worden und
> liegen nicht mehr unter `streaming/testbench/profiles/`; die Zeilen bleiben
> als Ergebnisprotokoll stehen.

**Konsequenz für alles Weitere:** Der Encoder ist nicht mehr die offene Frage.
Offen sind der Publish-Weg (WHIP statt RTMPS) und der Empfänger.

---

## Stufe 1 — Windows-Labor sendet über WHIP

**Frage:** Bringt der Windows-Sidecar einen eigenen WebRTC-Strom heraus, den
MediaMTX annimmt?

**Bau:** `streaming/win-hq-labor/` als eigenes Binary, `win-hq-sidecar` als
Bibliothek (dessen `lib.rs` führt alle Module bereits `pub`). Kopiert wird nur,
was der WHIP-Weg umbaut — dieselbe Aufteilung wie in `hq-labor/README.md`.
Portiert wird das WHIP-Modul des Linux-Labors (`whip/{mod,av1,pacer}.rs`,
1100 Zeilen, plattformneutral; einzige Verzahnung ist
`crate::encode::request_keyframe()`).

**Instrument:** `examples/test_driver.rs` (gibt es im Windows-Sidecar schon) für
das Protokoll; MediaMTX-API `/v3/paths/list` für „Strom liegt an".

**Kriterium:** `2 tracks (AV1, Opus)` an der Testinstanz, so wie es der
AMD-Branch am 2026-07-30 für RTMPS schon nachgewiesen hat.

**Was es widerlegen würde:** der ffmpeg-WHIP-Muxer wird versehentlich benutzt
statt des eigenen Senders. Erkennungszeichen: der Strom trägt H.264 statt AV1
(jener Muxer kann kein AV1 und fällt still zurück). Deshalb gehört der wirklich
offene Encoder ins Protokoll — die Zeile `[encode] Encoder offen: <name>` aus
dem AMD-Branch ist genau dafür gebaut.

## Stufe 2 — der native Player unter Windows

**Er ist nicht nur Messinstrument, sondern Produktpfad.** `desktop/electron/player.ts`
bindet ihn additiv in die App: fehlt das Binary, meldet `isAvailable()` false und
der Renderer bleibt auf dem `<video>`-Weg. Die Bittiefe des Senders reist zu den
Zuschauern, damit die den Wiedergabeweg wählen können (`settings.svelte.ts`).

**Damit hängt an dieser Stufe die 10-bit-Frage.** Ein AV1-10-bit-Strom ist für
Zuschauer **mit** Player vollwertig und für Zuschauer **ohne** ihn ein `<video>` —
und dort ist gemessen, dass Chromiums *Software*-Decoder AV1 10 bit gar nicht
erst anlaufen lässt (`framesDecoded` blieb null). Ob ein echter Browser mit
Hardware-AV1-Decode damit zurechtkommt, ist **ungemessen**. Ohne Player unter
Windows ist 10 bit dort also nicht nutzbar, mit ihm schon.

**Frage:** Baut und läuft `streaming/pulse-player` (heute nur Linux) unter
Windows, und misst er dort dasselbe?

**Bau:** wgpu und FFmpeg sind plattformneutral, die beiden `webrtc-rs`-Patches
(`0001-expose-undeclared-ssrc-streams`, `0002-nack-generator-resend-delay`)
ebenfalls. `ffmpeg-dist/` für Windows liegt schon im Repo.

**Instrument:** der Player selbst — er ist das Messinstrument
(`probe.rs`, `recorder.rs`, Statistikausgabe).

**Kriterium:** derselbe Strom ergibt auf Linux und Windows dieselbe Bildzahl und
vergleichbare Ende-zu-Ende-Zeit. **Kontrolle zuerst:** beide Player gegen
denselben aufgezeichneten Strom, nicht gegen zwei Live-Läufe.

## Stufe 3 — Erholung nach Fehlern, gemessen statt behauptet

**Frage:** Wie schnell ist ein Zuschauer nach Verlust wieder im Bild — und
womit?

**Instrumente:** `obu-schnitt.py` (verwirft gezielt Zugriffseinheiten),
`heilung.py` (PSNR je Bild **und** Änderung zum Vorbild, unterscheidet
„eingefroren" von „läuft, aber falsch"), `verluststrecke.py`, `nack-wirkung.py`.
Für Windows liegen die Nachbauten `obu-schnitt.ps1` und `heilung.exe` vor.

**Kriterium:** Erholungszeit je Mechanismus getrennt ausweisen — FEC allein,
NACK allein, Vollbild auf Anforderung. Auf Linux ist das Muster bekannt: Parität
liegt im Median 0,2 ms hinter ihrer Gruppe, eine NACK-Nachlieferung braucht über
dieselbe Strecke 61 ms.

**Falle, schon einmal zugeschlagen:** Zuordnung nach Bildindex trägt nicht — der
Decoder gibt nach einem Verlust weniger Bilder aus als die Referenz hat.
Kandidaten-Zuordnung ist Pflicht, nicht Kür.

## Stufe 4 — Browser

**Frage:** Stellt Chromium den Windows-Strom dar und hält er unter Störung
durch?

**Instrument:** `browser-whep.mjs` mit demselben Aufbau wie am 2026-07-31
(Pixel-Fingerabdruck je Sekunde gegen Standbilder, Zeitmuster im Bild, damit
sich jedes Bild ändert).

**Kriterium:** kein Standbild über die Laufzeit, Beitritt gelingt mit **einer**
Vollbild-Anforderung.

**Vorentscheidung, die daran hängt:** **8 bit**. AV1 10 bit scheitert im
Software-Decoder vollständig (265 vergebliche Anforderungen, `framesDecoded`
blieb null). Wer 10 bit fährt, misst die Bittiefe statt des Sendewegs.

## Stufe 5 — über Kreuz

**Wer kann was.** Senden kann **nur die Desktop-App**, weil der Sidecar dort
eingebaut ist — das Frontend gated HQ genau darauf
(`isElectron() && (isLinux() || isWindows() || isMac()) && stream.gsrAvailable`).
Der Browser ist **ausschließlich Empfänger**. Die Matrix ist deshalb nicht
quadratisch:

| Sender (App mit Sidecar) | Empfänger |
|---|---|
| Linux | Windows-App (Electron/Chromium) · Browser (jedes OS) · nativer Player |
| Windows | Linux-App (Electron/Chromium) · Browser (jedes OS) · nativer Player |

**Frage:** Sieht ein Zuschauer auf der jeweils anderen Plattform dasselbe, und
erholt er sich gleich?

**Kriterium:** je Kombination dieselben Kriterien wie Stufe 3 und 4. Auf der
Leitung ist es derselbe Strom — geprüft werden die **Empfänger**, nicht das
Format. Der nativer Player ist dabei Messinstrument, kein Produktteil; die
Produktaussage macht der Electron-/Browser-Pfad.

**Warum das trotzdem eine eigene Stufe ist:** die Empfänger unterscheiden sich
im Decoder, und genau dort lagen bisher alle Überraschungen — `av1_cuvid` friert
ein und meldet weiter 60 Bilder je Sekunde, der Chromium-Software-Decoder
verweigert AV1 10 bit vollständig, `libdav1d` steigt bei fehlender Referenz ganz
aus. Drei Decoder, drei verschiedene Fehlerbilder, keines davon als Fehler
gemeldet.

---

## Fallen, die auf Linux Zeit gekostet haben — hier von Anfang an mitführen

Aus `hq-labor/UEBERGABE-WINDOWS-MACOS.md` und den Messakten:

1. **Der Zustand der Maschine gehört vor jeden Lauf.** Sechs vergessene
   `mpv`-Prozesse haben anderthalb Stunden lang jede Messung verfälscht und
   zwei falsche Befunde erzeugt. Auf Windows gibt es `gemeinsam.zustand_pruefen()`
   nicht — also von Hand: läuft noch ein Sender, ein Player, ein Browser mit Video?
2. **Der Schalter muss im Protokoll stehen.** Eine Variante über eine
   Umgebungsvariable, die nirgends auftaucht, ist nicht nachweisbar — und „kein
   Unterschied" hat dann die naheliegendste Erklärung: es lief zweimal dasselbe.
3. **Die Fähigkeitsprobe muss dieselben Einstellungen benutzen wie der Betrieb.**
4. **Ein Lauf je Variante trägt nichts.** Rauschen zuerst bestimmen, dann messen.
5. **Bei Eingriffen in einen Bildweg gehört eine Sichtprüfung dazu.** Der
   zerrissene AV1-Pfad vom 2026-07-30 war in JEDER Kennzahl besser als der
   funktionierende — aufgefallen ist er am Standbild.
6. **Datei-Größe bei CBR ist kein Messpunkt.** Am 2026-08-01 zweimal
   hineingelaufen: die Ratenkontrolle deckelt, der Unterschied zeigt sich in der
   Qualität oder gar nicht. Bei festem QP messen.

---

## Offene Entscheidungen (Nutzer)

- **Ein Encoder-Pfad oder drei?** Vulkan ist herstellerneutral und würde
  NVENC/D3D11, AMD/D3D12 und den CPU-Notausgang ersetzen. NVIDIA ist hier
  mangels Karte ungetestet — das ist der Preis.
- **Gepatchtes FFmpeg ausliefern?** Für das Labor reicht der lokale Bau. Für
  Nutzer hieße es eigene Bauinfrastruktur, für Windows und später Linux.
- **Zweige.** Labor-Server-Patches liegen auf `werkzeug/pruefstand-labor-server`,
  der Player auf `feat/native-hq-player`, `hq-labor` auf `main`. Diese Arbeit
  läuft auf `feat/win-hq-labor`; für Messungen werden die anderen beiden
  benutzt, ohne sie zu mergen.
