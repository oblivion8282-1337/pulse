//! Vendor-Encoder-Optionen — was welchem Encoder beim Oeffnen mitgegeben wird.
//!
//! Gegenstueck zu `streaming/linux-hq-sidecar/src/encode/opts.rs`, und der Ort,
//! an dem die AMD-Arbeit ansetzt (`async_depth`, `usage`). Herausgezogen aus
//! `encoder.rs`, das mit den Begruendungen ueber die harte Groessen-Grenze von
//! 500 Zeilen gewachsen war (`PLAN.md` §12.1).
//!
//! **Jeder Wert traegt seine Begruendung an sich selbst.** Wer eine Zahl aendert,
//! aendert den Kommentar mit oder misst neu — geerbte Zahlen ohne Herleitung
//! sind in diesem Projekt schon zweimal teuer geworden.

use ffmpeg_next as ffmpeg;
use ffmpeg::Dictionary;

use super::codec::VideoCodec;
use super::output::apply_encoder_opts_override;

/// Vendor-spezifische Encoder-Optionen. Defaults sind „streaming-tauglich"
/// (Low-Latency, CBR) — pro Encoder mehr durchstimmen wenn die echten
/// Quality-Tradeoffs sichtbar sind.
///
/// `codec` wird für die eine Option gebraucht, die es nicht bei jedem Codec
/// desselben Vendors gibt (Begründung an der Stelle selbst). Jeder gesetzte
/// Schlüssel wird vor dem Open gegen die Optionstabelle des Encoders geprüft
/// (`output::warn_unknown_opts`) — ein Schlüssel, den der Encoder nicht kennt,
/// wird von ffmpeg still verworfen.
///
/// `ten_bit` gehört aus demselben Grund hierher wie `codec`: die Option, die
/// eine 10-bit-Ausgabe erzwingt, heißt bei jedem Hersteller anders. Sie im
/// Aufrufer zu setzen hieße, einen AMF-Schlüssel auch an NVENC zu schicken.
pub(crate) fn vendor_encoder_opts(
    vendor: &str,
    codec: VideoCodec,
    ten_bit: bool,
) -> Dictionary<'static> {
    let mut opts = Dictionary::new();
    match vendor {
        "nvidia" => {
            // NVENC-Presets: p1 (fastest) … p7 (slowest+best). Für Live-Stream
            // ist Throughput wichtiger als Last-bit-Quality → `p2` ist der
            // sweet-spot, sehr schnell und kaum schlechter als p4 im Screen-
            // Content. `tune=ull` (ultra-low-latency) statt nur `ll` damit
            // B-Frames und VBV-Lookahead komplett aus sind.
            opts.set("preset", "p2");
            opts.set("tune", "ull");
            opts.set("rc", "cbr");
            opts.set("zerolatency", "1");
            opts.set("delay", "0");
            // Ein angefordertes Vollbild soll ein ECHTES sein. Bei NVENC heisst
            // die Option mit Bindestrich; die Mechanik dahinter ist eine andere
            // als bei AMF (dort `amfenc.c`, s. AMD-Zweig unten).
            //
            // **Am 2026-08-04 auf NVIDIA nachgemessen** (RTX 5080, Messakte
            // `nvidia-2026-08-04-windows-intra-refresh.json`, Abschnitt 5):
            // zwei angeforderte Vollbilder, zwei IDR in der Datei, an der
            // erwarteten Stelle — und ausserhalb davon weiter keines. Gezaehlt
            // im Mitschnitt, nicht im Log des Senders; genau dort ist der
            // Fehler auf AMD zuerst durchgerutscht.
            opts.set("forced-idr", "1");
            // **Hier steht mit Absicht KEINE Bittiefen-Option** — anders als im
            // AMD-Zweig unten, der ohne `bitdepth=10` trotz P010-Eingang 8 bit
            // liefert. Die Asymmetrie ist der naheliegendste Verdacht an dieser
            // Datei („da wurde eine Zeile vergessen"), deshalb steht die Antwort
            // hier ausgeschrieben statt als Leerstelle.
            //
            // **Bei NVENC folgt die Bittiefe dem Pool-Format**
            // (`hw_frames_ctx.sw_format`, gesetzt in `bildencoder::pool_wahl`
            // → `hwctx.rs`). Ein P010-Pool genügt; `ten_bit` wird in diesem Arm
            // deshalb gar nicht gelesen.
            //
            // **Am 2026-08-11 auf dieser Karte an BEIDEN Enden nachgemessen**
            // (RTX 5080, Treiber 610.47 = 32.0.16.1047, Windows 11 26200;
            // Messakte `testbench/profiles/nvidia-2026-08-11-windows-zehnbit.json`),
            // weil eine Optionstabelle in genau dieser Frage schon zweimal
            // gelogen hat:
            //
            // * *Was der Strom über sich sagt* — `high_bitdepth = 1` im
            //   AV1-Sequenzkopf (`trace_headers` am Bitstrom, nicht am Log des
            //   Senders), `pix_fmt = yuv420p10le`.
            // * *Was wirklich drinsteckt* — die dekodierten Y-Werte liegen
            //   ZWISCHEN den 8-bit-Stufen: Anteil auf Rest 0 über drei Läufe
            //   14,6 / 14,6 / 33,3 %. Der 8-bit-Lauf desselben Aufbaus liegt
            //   bei 100,0 % — so sähe ein bloßes Etikett aus.
            //
            // Das bestätigt unabhängig, was die Messakte
            // `nvidia-2026-08-04-windows-intra-refresh.json` (Abschnitt 7d)
            // schon einmal gezeigt hatte, auf demselben Treiberstand.
            //
            // **`-highbitdepth` ist NICHT die fehlende Zeile**, obwohl der Name
            // danach klingt: `av1_nvenc` kennt den Schlüssel, aber er heißt
            // „10 bit encodieren, obwohl der Eingang 8 bit ist". Unser Eingang
            // ist P010. Einen `bitdepth`-Schlüssel (den AMF-Namen) kennt
            // `av1_nvenc` gar nicht — `warn_unknown_opts` mahnte ihn dann bei
            // jedem gesunden Stream an, und eine Warnung, die im gesunden Fall
            // feuert, erzieht dazu, Warnungen zu überlesen.
        }
        "amd" => {
            // `usage` ist bei AMF kein Etikett, sondern ein Bündel: es stellt
            // Vorlauf, Voranalyse und Referenzstruktur auf einen Schlag ein.
            // `transcoding` heißt „Generic Transcoding" und ist das Bündel für
            // Offline-Umkodierung — es stand hier, seit der Zweig existiert,
            // ohne dass je gemessen wurde, was es kostet.
            //
            // Am 2026-07-30 auf einer Radeon 780M gemessen (1080p60, 4000 kbps,
            // Bildschirminhalt, Eingang auf Echtzeit gedrosselt; GPU-Wert =
            // mittlere Auslastung der Video-Engine über den Prozess):
            //
            //                                 GPU-Video    VMAF
            //   AV1  usage=transcoding          23,9 %     82,85
            //   AV1  usage=ultralowlatency       9,4 %     82,86
            //   H264 usage=transcoding          26,6 %     82,00
            //   H264 usage=ultralowlatency      10,3 %     81,60
            //
            // Im laufenden Sidecar bestätigt (`av1_amf`, 1440p→1080p60):
            // Video-Engine 22,1 % → 9,8 %.
            //
            // Bei AV1 kostet der Wechsel NICHTS an Bildqualität und senkt die
            // Last der Video-Engine auf gut ein Drittel. Auf einer iGPU, die
            // sich die Leistungsaufnahme mit der CPU teilt, ist das der größte
            // Posten überhaupt.
            //
            // Bei H.264 kostet er 0,4 VMAF. **Seit dem 2026-08-04 ist das keine
            // Randnotiz mehr**, denn H.264 läuft jetzt ebenfalls über diesen
            // Zweig (`encode_path`) — hier stand vorher, er sei dafür nur der
            // Notausgang. 0,4 VMAF für zweieinhalbfach weniger Video-Engine ist
            // trotzdem der richtige Tausch, und zwar erst recht auf einer iGPU.
            //
            // **Hier stand vom 2026-08-07 bis zum 2026-08-19: „Dieser Wert ist
            // NICHT das letzte Wort — `auffrischung::anwenden` überschreibt ihn
            // mit `transcoding`, wenn die Betriebsart nicht verlangt ist." Das
            // gilt nicht mehr: der Wert ist wieder unbedingt.**
            //
            // Der Grund für die Rücknahme ist gemessen (2026-08-19, Radeon
            // 780M, 1080p60): das Überschreiben kostete **25,2 statt 10,2
            // Prozent Video-Engine**, weil `transcoding` die ganze Voranalyse
            // zurückbringt — und seit dem 2026-08-18 traf das nicht mehr nur
            // den, der ausdrücklich abwählte, sondern jeden AMD-Stream.
            // Dieselbe Zusage (echte Vollbilder für den einsteigenden
            // Zuschauer) löst jetzt `keyframe::Selbsttakt` ein, ohne die
            // sparsame Betriebsart aufzugeben. Herleitung und Messtabelle in
            // `auffrischung::braucht_selbsttakt`.
            opts.set("usage", "ultralowlatency");
            // **`quality` wirkt bei den beiden Encodern verschieden**, und der
            // Satz „unter `ultralowlatency` wirkungslos" galt nur für AV1:
            //
            // * `av1_amf` — `balanced` und `speed` liefern byte-identische
            //   Bitströme (SHA-256 über 720 Bilder). Wirklich wirkungslos.
            // * `h264_amf` — verändert den Bitstrom sehr wohl (drei Stufen,
            //   drei verschiedene Prüfsummen, 2026-08-04 nachgemessen).
            //
            // **Trotzdem bleibt `balanced` stehen**, und das ist eine
            // Entscheidung gegen einen scheinbaren Gewinn: `quality` sah auf
            // dem ersten Messinhalt nach +0,21 dB PSNR bei gleicher Bitrate und
            // gleichem Durchsatz aus (305–311 Bilder/s, verschränkt gemessen,
            // Unterschied im Rauschen). Auf dem zweiten Inhalt waren es +0,03 dB
            // — also nichts. Ein Gewinn, der sich beim zweiten Inhalt in Luft
            // auflöst, trägt keine Änderung an einer Vorgabe. Wer das aufgreift,
            // misst auf echtem Bildschirminhalt statt auf `testsrc2`.
            opts.set("quality", "balanced");
            opts.set("rc", "cbr");
            // **Zwei Optionen, die hier ABSICHTLICH fehlen** — beide am
            // 2026-08-04 am gebündelten FFmpeg nachgesehen, damit sie niemand
            // „zur Sicherheit" ergänzt:
            //
            // * `coder=cabac` (setzt der Linux-Zweig) — `h264_amf` schaltet
            //   CABAC von sich aus ein (`entropy_coding_mode_flag = 1` im PPS
            //   des erzeugten Stroms). Die Option wäre eine Anweisung ohne
            //   Wirkung.
            // * `filler_data=0` — unter CBR erzeugt `h264_amf` gar keine
            //   Füll-NALs (0 Stück in 300 Bildern, `trace_headers`). Das
            //   Füllbyten-Problem der Linux-Seite gibt es hier nicht.
            // AMFs Default ist **16** — bis zu 15 Bilder Vorlauf, und FFmpeg
            // schreibt die Latenzwirkung selbst in den Hilfetext.
            //
            // **Auf dieser Hardware ändert der Wert allerdings nichts**, und das
            // gehört dazugesagt, damit niemand ihn später für einen gemessenen
            // Gewinn hält: `av1_amf` lieferte im Sidecar bei `async_depth=1` wie
            // bei `16` dieselbe Encode-Latenz (17,2 ms, = ein Bildabstand) und
            // dieselbe Video-Engine-Last. Anders als auf dem d3d12va-Zweig, wo
            // jede Stufe messbar einen Bildabstand kostet
            // (s. `encoder_d3d12.rs::d3d12va_opts`), scheint AMF hier ohnehin
            // nur ein Bild zu halten.
            //
            // Der Wert bleibt trotzdem gesetzt: er kostet nachweislich nichts,
            // FFmpeg dokumentiert ihn als Latenzschraube, und auf einer anderen
            // AMD-Generation kann der Default 16 sehr wohl durchschlagen. Ein
            // Nachmessen dort ist billig — `PULSE_ENCODER_OPTS=async_depth=16`.
            opts.set("async_depth", "1");
            // **Ein angefordertes Vollbild soll ein ECHTES sein.**
            //
            // `amfenc.c` verzweigt auf genau diese Option: ohne sie wird aus
            // `pict_type = I` bei AV1 ein `FORCE_FRAME_TYPE_INTRA_ONLY` statt
            // `..._KEY` (bei H.264 ein `PICTURE_TYPE_I` statt `..._IDR`). Ein
            // Intra-Only-Bild ist zwar vollstaendig intra-kodiert, aber **kein
            // Keyframe** — es bringt den Sequenzkopf nicht mit, und ein neu
            // einsteigender Zuschauer kann damit nichts anfangen.
            //
            // Kostet nichts, solange niemand anfordert: die Option greift erst
            // bei einem Bild mit `pict_type = I`. Wie der Fehler auffiel und
            // was er verdeckte, steht in der Messakte
            // `testbench/profiles/rueckkanal-2026-08-02-windows.json`.
            opts.set("forced_idr", "1");
            // AMFs eigene Bittiefen-Option. Ohne sie liefert der Encoder trotz
            // P010-Eingang einen 8-bit-Strom — der P010-Pool allein genügt
            // also nicht. Nur `av1_amf` kennt den Schlüssel; bei H.264 über
            // diesen Zweig gibt es ohnehin kein 10 bit.
            //
            // **Das ist eine Aussage über AMF, nicht über Encoder im
            // Allgemeinen** — bei NVENC genügt der Pool sehr wohl, am
            // 2026-08-11 am fertigen Strom nachgemessen (Begründung im
            // NVIDIA-Zweig oben). Wer den Satz „der P010-Pool allein genügt
            // nicht" aus dieser Zeile mitnimmt, trägt ihn an die falsche
            // Stelle weiter.
            if ten_bit {
                opts.set("bitdepth", "10");
            }
            // **Die Fassung ausdrücklich setzen, weil wir sie ausdrücklich
            // zusagen.** `whip::sdp` schreibt `profile-level-id=6400xx` ins
            // Angebot — `64` heißt High. `h264_amf` wählt ohne Zutun aber
            // **Main** (2026-08-04 am erzeugten Strom nachgesehen, nicht am
            // Hilfetext). Die Richtung ist die harmlose — wer High dekodieren
            // kann, kann auch Main —, aber eine Zusage, die nicht stimmt, ist
            // in einer SDP-Verhandlung die falsche Sorte Ungenauigkeit: der
            // Empfänger legt seine Puffer danach aus.
            //
            // **Kostet nichts:** bei fester Quantisierung liefern `main` und
            // `high` auf demselben Inhalt 10 565 874 gegen 10 565 875 Bytes —
            // ein Byte auf 10 MB. AMF nutzt die High-Werkzeuge hier also
            // ohnehin kaum; der Gewinn ist die richtige Zusage, nicht die
            // Kompression.
            //
            // Nur H.264: `av1_amf` kennt bei `profile` allein `main`.
            if matches!(codec, VideoCodec::H264) {
                opts.set("profile", "high");
            }
        }
        "intel" => {
            opts.set("preset", "medium");
            // Lookahead aus (Latenz). Die Option gibt es bei `h264_qsv` und
            // `hevc_qsv` — bei `av1_qsv` NICHT (2026-07-30 gegen die
            // Optionstabellen des mitgelieferten FFmpeg n8.1 geprüft). Bis dahin
            // stand sie unbedingt hier und wurde bei jedem AV1-QSV-Stream still
            // verworfen; folgenlos (der Default ist ohnehin `false`), aber es
            // war eine Anweisung ohne Wirkung — und sie hätte die neue
            // Unbekannt-Warnung bei jedem gesunden AV1-Stream feuern lassen.
            // Eine Warnung, die im gesunden Fall feuert, erzieht dazu,
            // Warnungen zu überlesen.
            if !matches!(codec, VideoCodec::Av1) {
                opts.set("look_ahead", "0");
            }
        }
        _ => {}
    }
    apply_encoder_opts_override(&mut opts);
    opts
}
