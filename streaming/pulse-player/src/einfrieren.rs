//! Wacht darueber, ob der Decoder noch rechnet — und bestimmt, WIE OFT
//! dagegen etwas unternommen wird.
//!
//! **Der Fall, fuer den es das gibt.** Am 2026-07-31 fror `av1_cuvid` nach dem
//! Ende einer Saettigungsphase ein: er gab weiter 60 Bilder je Sekunde aus,
//! immer dasselbe, ueber 90 Sekunden — bei **null** verlorenen Paketen. Ohne
//! Verlust meldet der Jitter-Puffer keine Luecke, also greift die Rettung ueber
//! [`crate::decode::VideoDecoder::on_gap`] nicht. Der Nachweis kommt deshalb
//! aus dem Ergebnis statt aus der Ursache: gleiches Bild, obwohl Daten
//! hineingehen.
//!
//! **Warum das allein nicht genuegt.** Ein Standbild beim Sender
//! (Ladebildschirm, pausiertes Spiel, stillstehender Desktop) sieht am Ausgang
//! des Decoders GENAU GLEICH aus. Beide Zustaende liefern dasselbe Bild,
//! waehrend Daten hereinkommen — am Bild sind sie nicht zu trennen.
//!
//! **Die eigentliche Ursache des gemeldeten Fehlalarms war aber eine dritte,
//! und sie sass im Fingerabdruck.** Belegt durch den Vorfall vom 2026-08-05
//! (`player-nackprobe.log`): drei Meldungen in rund 17 Sekunden, bei **4646
//! kbit/s**, 60 Bildern je Sekunde und 774 dekodierten Bildern; Sender
//! `av1_nvenc` im **Vollbild**-Betrieb, also ohne wandernde Auffrischung. Auf
//! dem Bildschirm lief ein Terminal mit blinkendem Cursor. Beide Bedingungen
//! waren gleichzeitig erfuellt — 870 kB je anderthalb Sekunden UND 90 Bilder
//! „gleich" — obwohl sich das Bild sehr wohl aenderte.
//!
//! Der Grund: [`bild_abdruck`] las bis zum 2026-08-05 **jedes 1021. Byte,
//! hoechstens 4096 Proben**. Bei 1080p in NV12 (3,1 MB) sind das rund 3000
//! Stichproben, also ein Tausendstel des Bildes. Ein kleines bewegtes Element
//! — Cursor, laufende Uhr, Ladepunkte in einer Ecke — kostet den Encoder
//! echte Bits, wird von dieser Stichprobe aber fast nie getroffen: ein 8x16
//! grosser Cursor belegt 128 Byte, die Trefferchance liegt bei 128/1021, also
//! rund 12 %. Und sie ist NICHT je Bild neu ausgewuerfelt — das Raster liegt
//! fest, ein danebenliegendes Element bleibt **dauerhaft** unsichtbar.
//!
//! Damit hing der Fehlalarm nicht an einer Encoder-Eigenschaft, sondern an
//! der Dichte des Abdrucks, und er traf viel mehr als Standbilder: jedes Video
//! mit stehendem Rahmen, jede Oberflaeche mit blinkendem Cursor, jeden
//! Ladebildschirm mit Animation in einer Ecke. **[`bild_abdruck`] liest
//! deshalb seit dem 2026-08-05 jedes Byte** (Kosten dort gemessen).
//!
//! **Was hier bis zum 2026-08-05 als Trennung galt, und warum es keine ist.**
//! Die Byte-Schwelle trug den Satz „ein echtes Standbild kostet den Encoder
//! fast nichts (wenige hundert Byte je Bild); 500 kB ueber anderthalb Sekunden
//! entspricht rund 2,7 Mbit/s und kommt nur zustande, wenn wirklich Bildinhalt
//! gesendet wird." **Das ist falsch**, und zwar aus einem Grund, der am
//! Bildinhalt gar nicht haengt: die Schwelle zaehlt Bytes und sieht nicht nach,
//! WAS in ihnen steht. Richtig ist: sie beantwortet nur „kommt ueberhaupt
//! noch etwas an", nicht „ist es Bildinhalt".
//!
//! **Ebenfalls falsch — und hier als erste Erklaerung des Fehlalarms
//! aufgeschrieben, bis der Vorfall nachgelesen war: „unter CBR haelt der
//! Encoder seine Datenrate, notfalls mit Fuellmaterial."** Als Aussage ueber
//! Encoder im Allgemeinen stimmt sie (`av1_amf` erzeugt mit `filler_data=1`
//! `OBU_PADDING` von 0,4 bis 8,3 kB je Bild, `win-hq-sidecar/src/encode/mod.rs`
//! — deshalb ist die Byte-Schwelle KEINE Unterscheidung). Als Erklaerung des
//! gemessenen Fehlalarms ist sie widerlegt: gesendet hat `av1_nvenc`, und der
//! fuellt nachweislich nicht — faellt der Inhalt wirklich still, faellt seine
//! Datenrate auf ein Zwanzigstel (Messreihe unten). Die 4646 kbit/s im Vorfall
//! waren echter Bildinhalt, den nur der Abdruck nicht gesehen hat. Wer die
//! Fuell-Erklaerung weiterverfolgt, sucht an der falschen Stelle.
//!
//! **Am 2026-08-05 auf dieser Maschine nachgemessen** (Windows, `av1_nvenc`
//! bzw. `h264_nvenc`, 1080p60, 6000 kbps CBR, WHEP ueber den MediaMTX-Fork,
//! Fenster-Capture auf einem unbewegten Bild):
//!
//! | Standbild | Datenrate | gleiche Bilder in Folge |
//! |---|---|---|
//! | flaechig (Ladebildschirm), AV1 | 114–345 kbit/s | **118** |
//! | flaechig, H.264 | 155–199 kbit/s | 72 |
//! | detailreich (Desktop-Abzug) | 5,6–6,3 Mbit/s | 0 (jedes Bild anders) |
//! | Farbverlauf | 2,3–6,3 Mbit/s | 0 |
//!
//! Zwei Dinge stehen darin. Erstens: **auf FLAECHIGEM Inhalt fuellt NVENC
//! nicht** — steht das Bild, faellt die Datenrate auf ein Zwanzigstel, und die
//! Byte-Schwelle wird nie erreicht. Zweitens: **die Bild-Bedingung allein ist
//! bei Standbild erfuellt** (118 > 90). In keinem dieser sechs Laeufe kam eine
//! Meldung — nicht weil die Erkennung taugte, sondern weil keiner dieser
//! Inhalte beides zugleich war.
//!
//! **Beides zugleich ist ein STEHENDER, aber DETAILREICHER Bildschirm**, und
//! damit liess sich der Vorfall am 2026-08-05 mit unveraenderten Schwellen
//! nachstellen: ein Fenster mit 44 Zeilen Terminal-Text, unbewegt, `av1_nvenc`
//! im Vollbild-Betrieb, 1080p60 bei 6000 kbps. Gemessen **3,2–7,8 Mbit/s bei
//! bitgleichem Ausgabebild** — die Neucodierung scharfkantigen Textes kostet
//! dauerhaft Bits, ohne die Rekonstruktion zu veraendern. Der Player meldete
//! mit dem Stand vor dieser Datei **22-mal in 90 Sekunden**.
//!
//! Der Satz „NVENC fuellt nicht" gilt also nur fuer flaechigen Inhalt. Fuer
//! die Byte-Schwelle heisst das dasselbe wie bei einem fuellenden Encoder:
//! sie unterscheidet nichts.
//!
//! **Deshalb zwei Aenderungen, an zwei verschiedenen Stellen — gegen zwei
//! verschiedene Faelle**, die im Log gleich aussehen:
//!
//! * *Das Bild aendert sich, der Abdruck sieht es nur nicht* (Cursor, Uhr,
//!   Ladepunkte). Dagegen hilft nur ein vollstaendiger Abdruck, und der loest
//!   es restlos: was sich aendert, faellt auf.
//! * *Das Bild steht wirklich, und trotzdem fliessen Daten* (stehender
//!   detailreicher Bildschirm, oder ein fuellender Encoder). Da gibt es nichts
//!   zu unterscheiden — ein vollstaendig stehendes Bild sieht aus wie ein
//!   Haenger, mit jedem Abdruck. Dagegen hilft nur, den Preis des Nachsehens
//!   zu begrenzen.
//!
//! **Erstens also: die Abhilfe wird gestaffelt, statt die Erkennung
//! geschaerft.**
//! Schaerfen hiesse Schwellen hochdrehen, und das verzoegert nur die echte
//! Rettung. Gestaffelt heisst: der erste Verdacht wird sofort behandelt
//! (damals nach 90 Bildern; seit dem 2026-08-06 zusaetzlich gegen
//! [`EINFRIER_DAUER`] gemessen, s. den Abschnitt zum Takt weiter unten);
//! meldet sich derselbe Verdacht wieder, ohne dass
//! die Wiedergabe zwischendurch nachweislich lief, verdoppelt sich der
//! Pruefabstand — hoechstens [`MAX_STUFE`]-mal. Ein voellig stehendes Bild
//! kostet damit statt 40 erzwungener Vollbilder je Minute noch 7, und ein
//! haengender Decoder wird genauso schnell gerettet wie bisher.
//!
//! **Was das am 2026-08-05 in der laufenden Kette gebracht hat**, auf dem
//! stehenden Terminal-Bildschirm von oben, je 90 s, unveraenderte Schwellen:
//!
//! | Stand | Meldungen | Vollbilder |
//! |---|---|---|
//! | vorher | 22 | 29 |
//! | dichter Abdruck, Staffelung mit Rueckfall ueber EIN Fenster | 21 | 29 |
//! | Stichprobe, Staffelung mit Rueckfall ueber EIN Fenster | 23 | 28 |
//! | dichter Abdruck, Rueckfall ueber eine Fensterkette | **7 / 3** | 22 / 18 |
//!
//! (Letzte Zeile: zwei Laeufe. Die Staffel erreicht ihren Anschlag und bleibt
//! dort, die Streuung kommt daher, wie oft das in 90 s passt.)
//!
//! Die dritte Zeile ist der Grund fuer [`BEWEGUNGS_KETTE`] und die
//! unangenehmste Zahl der Reihe: die Staffelung war zuerst **wirkungslos**,
//! weil die Rettung selbst genug Bewegung erzeugte, um sie zurueckzusetzen.
//! Ohne den Lauf in der echten Kette waere das nicht aufgefallen — die
//! Unit-Tests hielten das Standbild fuer perfekt unbewegt, und genau das ist
//! es nach einer Rettung eben nicht.
//!
//! Auf einem FLAECHIGEN Standbild ist der Gewinn noch groesser (dort liegt der
//! Pruefabstand nach der ersten Meldung ueber dem Auffrischungstakt des
//! Senders, danach schlaegt die Erkennung gar nicht mehr an): 70 s, Byte-Boden
//! fuer den Pruefstand auf 20 kB gesenkt, sonst loest dort nichts aus —
//! **34 Meldungen vorher, 1 nachher**, Spitzen-Datenrate 257 → 169 kbit/s,
//! Bildrate 56–69 → 60–61. Die Datenrate ist die eigentliche Rechnung: die
//! Haelfte des Stroms bestand aus erzwungenen Vollbildern.
//!
//! Gegenprobe im Normalbetrieb, gleiche Kette, 60 s laufender Inhalt
//! (durchscrollendes Terminal): **null Meldungen**, 60–61 Bilder je Sekunde.
//!
//! **Verworfen: die Wirkung der Rettung als Unterscheidung.** Naheliegend
//! waere, nach dem erzwungenen Vollbild nachzusehen, ob sich das Bild
//! veraendert hat — hat es das nicht, war es kein Decoder-Problem. Am
//! 2026-08-05 widerlegt: bei stehendem Inhalt und abgeschaltetem
//! Vollbild-Takt (`PULSE_KEYFRAME_INTERVAL=0`, die Produktivvorgabe) aenderte
//! sich der Fingerabdruck **exakt alle 118 Bilder**, im Takt der wandernden
//! Auffrischung des Senders. Neu codierter, unveraenderter Inhalt kommt also
//! nicht bitgleich wieder heraus; ein erzwungenes Vollbild ist dieselbe
//! Neucodierung, nur auf einen Schlag. Die Pruefung haette bei jedem Standbild
//! „hat geholfen!" gemeldet und die Staffelung sofort zurueckgesetzt.
//! (Der Schluss steht; **„im Takt der wandernden Auffrischung" ist widerlegt** —
//! es ist der Vollbild-Takt und laeuft ohne Intra-Refresh genauso, s. den
//! Abschnitt zum Takt weiter unten.)
//!
//! Zurueckgesetzt wird deshalb an einem Merkmal, das dieses Rauschen nicht
//! traegt: **ueber Sekunden anhaltende Bewegung** (s. [`BEWEGUNGS_FENSTER`]
//! und [`BEWEGUNGS_KETTE`]). Ein Standbild schafft die nicht — auch nicht mit
//! der Nachwirkung der eigenen Rettung —, ein rechnender Decoder auf laufendem
//! Inhalt immer.
//!
//! **Zweitens: der Abdruck liest jedes Byte** — Begruendung und Kosten stehen
//! bei [`bild_abdruck`].
//!
//! ---
//!
//! ## Der Takt, in dem sich ein Standbild aendert (nachgemessen 2026-08-06)
//!
//! Oben steht, der Fingerabdruck aendere sich bei stehendem Inhalt „exakt alle
//! 118 Bilder, **im Takt der wandernden Auffrischung** des Senders". Die Zahl
//! stimmt ungefaehr (hier 117); **die Zuschreibung ist falsch** — derselbe Takt
//! laeuft ohne Intra-Refresh genauso.
//!
//! Sechsundsechzig Laeufe ueber die echte Kette, je Betriebsart mehrere Runden
//! abwechselnd gefahren; volle Messakte in
//! `streaming/testbench/profiles/player-2026-08-06-standbild-takt.json`.
//! Gemessen wird der **Abstand zwischen zwei veraenderten Bildern**: 1 heisst
//! „jedes Bild ist neu", N heisst „N-1 Bilder blieben bitgleich". Groesster
//! Abstand je Betriebsart, beide Runden gleich, mit Intra-Refresh wie ohne:
//!
//! | fps | AV1 1080p | AV1 1440p | H.264 1080p | Periode = fps x 2 |
//! |---|---|---|---|---|
//! | 30 | 57 | — | 48 | 60 |
//! | 60 | 117 | 119 | 103 | 120 |
//! | 144 | 285 | — | — | 288 |
//!
//! **Was den Takt setzt, ist der Vollbild-Abstand des Senders, nicht die
//! Auffrischung.** Alle drei Sidecars stellen ihn auf zwei Sekunden —
//! `set_gop(cfg.fps * 2)` in allen drei Encoder-Wegen des Windows-Sidecars,
//! `(fps * 2).max(1)` auf macOS, `keyframe_abstand_bilder()` auf Linux; in
//! Bildern also **2 x fps**, genau die Periode oben. Der Player bestaetigt es
//! unabhaengig: seine eigene Vollbild-Meldung nennt 1999 bis 2001 ms. Im
//! Intra-Refresh-Betrieb kommt gar kein zweites Vollbild (gemessen: **eines**
//! in 40 s) und der Takt ist trotzdem derselbe — NVENC richtet die Dauer eines
//! Auffrischungsdurchlaufs am GOP aus. Wer die Auffrischung fuer die Ursache
//! haelt, sucht bei abgeschaltetem Intra-Refresh nach einer zweiten Erklaerung,
//! wo es nur eine gibt.
//!
//! **Wie viel der Periode bitgleich bleibt, haengt am Inhalt** — von 0 (AV1 auf
//! dichtem Text) ueber 6 von 120 (H.264 auf dichtem Text) bis 117 von 120. Das
//! erklaert auch die 72 in der Tabelle vom 2026-08-05: dieselbe Frage, anderer
//! Ladebildschirm. Die Periode war dort dieselbe, nur stand weniger von ihr
//! still — die Zahl ist keine Encoder-Konstante und taugt nicht als eine.
//!
//! ### Damit ist der Fehlalarm ein Einheitenfehler
//!
//! [`EINFRIER_BILDER`] zaehlt **Bilder**, der Takt laeuft in **Sekunden**. 90
//! Bilder sind bei 30 fps drei Sekunden (ueber der Periode → Fehlalarm
//! unmoeglich), bei 60 anderthalb (darunter → moeglich), bei 144 sechs Zehntel.
//! Die Oberflaeche laesst bis 360 Bilder je Sekunde zu
//! (`capabilities.hqFpsMax`) — je hoeher die Bildrate, desto sicherer der
//! Fehlalarm, ohne dass sich am Inhalt irgendetwas aendert. Gegengeprueft auf
//! **44 Zeilen Terminal-Text wie im Vorfall, echte Schwellen, nichts
//! abgesenkt**, zwei Runden zu je 40 s: mit 90 Bildern Fenster **2 / 3**
//! Meldungen, mit 121 nur noch **0 / 1**.
//!
//! Deshalb steht neben dem Bilder-Zaehler jetzt [`EINFRIER_DAUER`] — dieselbe
//! Frage, in der Einheit gestellt, in der die Antwort liegt.
//!
//! **In der laufenden Kette nachgewiesen**, sechs Paare zu je 60 s auf dem
//! Inhalt des Vorfalls, DASSELBE Binary in beiden Armen
//! (`PULSE_PLAYER_EINFRIER_MS=1` schaltet die Zeitbedingung ab und stellt den
//! vorigen Stand her — sauberer als zwei Binaries): **12 Meldungen vorher
//! (2,2,2,3,1,2), 2 nachher (0,0,1,0,1,0)**, bei vergleichbarer Lage in beiden
//! Armen (der Encoder erreichte in 6 von 6 bzw. 5 von 6 Laeufen einen
//! Fixpunkt). Laufender Inhalt, drei Runden: jedes Bild neu, **null**
//! Meldungen — der Normalbetrieb ist unveraendert.
//!
//! ### Aber die Periode ist keine Obergrenze — deshalb bleibt die Staffelung
//!
//! Naheliegend waere jetzt „Fenster ueber die Periode, fertig". **Die zweite
//! Runde widerlegt das**: auf demselben Inhalt stand das Bild dort einmal
//! **239 Bilder** lang bitgleich — zwei volle Perioden, das Vollbild
//! rekonstruierte zweimal hintereinander exakt den Fixpunkt. Ein Lauf ist ein
//! VIELFACHES der Periode, und welches, ist unbeschraenkt. (Runde 1 sah keinen
//! Lauf ueber 120 und haette „vollstaendig geloest" ergeben — die
//! Zwei-Runden-Regel aus `streaming/testbench/README.md` hat wieder
//! zugeschlagen.) Also: **kein Fenster beseitigt den Fehlalarm, es verringert
//! ihn.** Nach oben begrenzt ihn weiterhin allein die Staffelung
//! ([`MAX_STUFE`]); [`EINFRIER_DAUER`] nimmt ihr die Faelle ab, in denen das
//! Fenster innerhalb EINER Periode lag — und das sind fast alle. Die Zahl ueber
//! zwei Perioden zu legen kaufte 4,5 s verzoegerte Rettung fuer einen Fall, den
//! die Staffelung nach der ersten Meldung ohnehin abfaengt.
//!
//! **Verworfen: das Fenster den Takt selbst beobachten lassen** — den groessten
//! gesehenen Abstand mitschreiben und das Fenster darueberlegen, dann braeuchte
//! es gar keine Zahl. **Es ist im Kreis geschlossen**: beobachtbar ist der Takt
//! nur, waehrend der Inhalt steht — also genau in der Lage, die von einem
//! Haenger nicht zu trennen ist. Ein haengender Decoder liefert einen immer
//! groesseren „Takt", das Fenster waechst mit, die Erkennung legt sich selbst
//! still; mit Deckel ist sie das, was [`MAX_STUFE`] schon ist, nur mit einer
//! zweiten, schlechter begruendeten Zahl daneben. Zwei weitere Gruende
//! (Sitzungsbeginn ohne Beobachtung, Umstellung mitten im Strom) stehen in der
//! Messakte unter `verworfen`.
//!
//! ---
//!
//! ## Wenn das Bild den Hauptspeicher nie sieht (seit 2026-08-06)
//!
//! Auf dem Zero-Copy-Weg gibt es keine Ebenen zu lesen. Der Abdruck entsteht
//! dann **auf der GPU** und kommt ein bis zwei Bilder spaeter zurueck
//! ([`bild_von_der_gpu`](EinfrierWacht::bild_von_der_gpu), gerechnet in
//! `render::abdruck`, beschrieben in [`gpuabdruck`]). Fuer alles unterhalb
//! dieser Zeile aendert sich nichts: der Waechter vergleicht Abdruecke nur mit
//! sich selbst.
//!
//! Zwei Dinge sind auf diesem Weg anders und stehen deshalb hier:
//!
//! * **Gezaehlt werden GEZEICHNETE Bilder, nicht dekodierte.** Das Fenster
//!   haelt immer nur das neuste Bild (`app::Session::pending`); wird unter Last
//!   ueberschrieben, faellt der Abdruck dieses Bildes weg. Der Zaehler
//!   [`EINFRIER_BILDER`] laeuft dadurch langsamer voll — die Erkennung wird
//!   traeger, nie empfindlicher. Bindend bleibt ohnehin meist
//!   [`EINFRIER_DAUER`], und die haengt an der Uhr, nicht an der Zahl der
//!   Bilder.
//! * **Bilder, die auf diesem Weg NICHT durchkommen, zaehlen gar nicht.** Ist
//!   kein Ringplatz frei, nimmt ein einzelnes Bild den Weg ueber den
//!   Hauptspeicher; sein CPU-Abdruck ist mit den GPU-Abdruecken nicht
//!   vergleichbar und gaelte faelschlich als „veraendert". Der Decoder laesst
//!   ihn deshalb aus, solange der GPU-Weg steht (`decode::VideoDecoder::drain`).

/// Ab wie vielen unveraenderten Bildern in Folge der Decoder als eingefroren
/// gilt. 90 sind bei 60 Bildern je Sekunde anderthalb Sekunden — lang genug,
/// dass eine kurze Standbild-Szene nicht hineinlaeuft, kurz genug, dass ein
/// Zuschauer nicht minutenlang festhaengt. **Allein genuegt sie nicht**: in
/// Bildern gemessen, abzugrenzen gegen etwas, das in Sekunden laeuft
/// ([`EINFRIER_DAUER`]).
const EINFRIER_BILDER: u32 = 90;

/// Wie lange dasselbe Bild MINDESTENS gestanden haben muss.
///
/// **Die eigentliche Untergrenze, und die einzige, die nicht an der Bildrate
/// haengt.** Der Sender legt alle zwei Sekunden ein Vollbild bzw. einen
/// abgeschlossenen Auffrischungsdurchlauf hin, und dabei aendert sich das
/// dekodierte Bild auch bei stehendem Inhalt (Messreihe im Modulkopf); ein
/// Fenster darunter liegt systematisch INNERHALB einer Periode und sieht dort
/// ein Standbild, das keines ist. 2500 ms sind die gemessenen 2000 plus ein
/// Viertel — der Aufschlag deckt den Jitter des Senders (1999–2001 ms), die
/// Wartezeit bis das Vollbild dekodiert ist, und den Fall, dass die Periode
/// exakt erreicht wird (gemessen: 120 von 120).
///
/// **Was diese ZAHL nicht deckt, und das ist nachgemessen statt befuerchtet:**
/// ein laengeres GOP verschiebt den Takt mit. Mit `PULSE_ENCODER_OPTS=g=600`
/// stand dasselbe Standbild **597 Bilder** bitgleich (Periode 600 statt 120,
/// wieder minus drei). `PULSE_KEYFRAME_SECONDS` erlaubt genau das, seit dem
/// 2026-08-18 bis zu 120 Sekunden und auf allen drei Plattformen.
///
/// Deshalb ist die Zahl seither nur noch die **Untergrenze**:
/// [`EinfrierWacht::mindestdauer`] hebt sie auf den Takt an, den der Sender
/// tatsaechlich faehrt. Die Staffelung ([`MAX_STUFE`]) haette das nicht
/// aufgefangen — sie kommt bei 60 fps nur bis 12 s und holt einen laengeren
/// Takt nie mehr ein, der Fehlalarm bliebe also dauerhaft statt nach der
/// ersten Meldung zu verschwinden.
///
/// **Nicht gestaffelt** — die Verdopplung bleibt allein bei
/// [`EINFRIER_BILDER`], damit der schlechteste Fall der bleibt, der bei
/// [`MAX_STUFE`] steht (12 s bei 60 fps). Bindend ist die laengere der beiden
/// Bedingungen; die Dauer gewinnt, wenn `Pruefabstand / Ausgaberate` unter ihr
/// liegt — bei 60 fps nur auf Stufe 0, bei 144 fps auf 0 und 1, bei 30 fps nie.
/// Also genau dort, wo der Fehlalarm ueberhaupt moeglich ist.
const EINFRIER_DAUER: std::time::Duration = std::time::Duration::from_millis(2_500);

/// Ueber wie viele beobachtete Vollbild-Abstaende
/// [`EinfrierWacht::mindestdauer`] ihr Maximum bildet.
///
/// Vier ist der Ausgleich zwischen den beiden Fehlern: zu kurz, und ein
/// einzelnes auf Anforderung gesendetes Vollbild zieht das Fenster zusammen
/// (Fehlalarm); zu lang, und ein einmaliger echter Haenger laesst die Wacht
/// noch minutenlang stumpf. Bei einem Zwei-Sekunden-Takt sind vier Abstaende
/// acht Sekunden Gedaechtnis.
const VOLLBILD_FENSTER: usize = 4;

/// Wie viele Bytes in derselben Zeit hineingegangen sein muessen.
///
/// **Das ist ein Boden, keine Unterscheidung** (Begruendung im Modulkopf): er
/// beantwortet „kommt ueberhaupt noch etwas an" und haelt die Erkennung von
/// dem Fall fern, um den sich `session.rs` kuemmert (Abriss). Ob die Bytes
/// Bildinhalt oder Fuellmaterial tragen, sieht er NICHT.
const EINFRIER_BYTES: u32 = 500_000;

/// Wie oft der Pruefabstand hoechstens verdoppelt wird.
///
/// 3 heisst: 90 → 180 → 360 → 720 Bilder, bei 60 fps also 1,5 → 3 → 6 → 12
/// Sekunden. Die Obergrenze ist der Preis, den ein haengender Decoder im
/// schlechtesten Fall kostet — und er faellt nur an, wenn der Haenger sich
/// MITTEN in eine nachweislich stehende Szene legt; nach jeder bewegten
/// Sekunde steht die Staffel wieder bei 0. Zwoelf Sekunden gegen die 90, die
/// der Fall vom 2026-07-31 ungerettet dauerte.
///
/// Nach oben begrenzt, aber nie abgeschaltet: eine Erkennung, die sich selbst
/// stilllegt, ist im entscheidenden Moment nicht da.
const MAX_STUFE: u32 = 3;

/// Ueber wie viele Bilder „laeuft die Wiedergabe wieder" beurteilt wird, und
/// wie viele davon sich geaendert haben muessen.
///
/// Der Abstand zu beiden Seiten ist gemessen, nicht geraten: ein Standbild
/// erzeugt **einen Wechsel je 117 bis 120 Bilder** (Vollbild-Takt des Senders,
/// s. Modulkopf; hier stand bis zum 2026-08-06 „118", und die Zuschreibung an
/// die wandernde Auffrischung war falsch), also hoechstens einen je Fenster —
/// bei 30 fps sogar nur einen je zweitem Fenster. Verlangt werden vier — das
/// traegt noch Inhalte, die nur mit 4 Bildern je Sekunde wirklich neu sind
/// (Diashow, stark gedrosseltes Spiel), und liegt weit ueber dem, was
/// Neucodierungs-Rauschen liefert.
const BEWEGUNGS_FENSTER: u32 = 60;
const BEWEGUNGS_WECHSEL: u32 = 4;

/// Wie viele Bewegungsfenster HINTEREINANDER Bewegung zeigen muessen.
///
/// **Das ist der Unterschied zwischen laufendem Inhalt und der Nachwirkung der
/// eigenen Rettung**, und ohne ihn haelt sich die Staffelung selbst bei null:
/// am 2026-08-05 meldete der Player auf einem stehenden Bildschirm 23-mal in
/// 90 Sekunden, im Log jede einzelne als „Meldung 1". Die Staffel war zwischen
/// zwei Meldungen jedes Mal zurueckgesetzt worden, obwohl der Inhalt stand.
///
/// Zurueckgesetzt hat sie die Rettung selbst: sie leert den Decoder und
/// erzwingt ein Vollbild, danach codiert der Encoder den unveraenderten Inhalt
/// neu und naehert sich seinem Fixpunkt wieder an. Im selben Lauf gezaehlt, je
/// 60 Bilder nach einer Meldung:
///
/// | Block nach der Meldung | 1 | 2 | 3 | 4 | 5 |
/// |---|---|---|---|---|---|
/// | veraenderte Bilder | 60/60 | 60/60 | 0–60 | 0–60 | 0/60 |
///
/// Also **zwei bis vier Sekunden lang aendert sich JEDES Bild**, danach steht
/// es wieder bitgleich. Wer nur in ein einzelnes Fenster sieht, liest genau
/// hier „laeuft ja wieder" — die Erkennung nimmt ihre eigene Abhilfe als
/// Entwarnung. Eine feste Sperre von fuenf Sekunden nach der Meldung half nur
/// halb (23 → 11 Meldungen), weil der Nachlauf mal kuerzer und mal laenger ist.
///
/// Was ihn zuverlaessig von echtem Inhalt trennt, ist seine **Dauer**: der
/// Nachlauf endet, laufender Inhalt nicht. Acht Fenster sind acht Sekunden
/// ununterbrochener Bewegung — doppelt so lang wie der laengste gemessene
/// Nachlauf. Der Preis: nach einer WIRKSAMEN Rettung steht das volle Tempo
/// erst acht Sekunden spaeter wieder bereit, und das wirkt sich fruehestens
/// auf die uebernaechste Meldung aus.
const BEWEGUNGS_KETTE: u32 = 8;

/// Messwerkzeug fuer den Pruefstand — im Betrieb vollstaendig aus.
mod messung;

/// Fingerabdruck eines dekodierten Bildes (s. [`abdruck::bild_abdruck`]).
mod abdruck;
use abdruck::bild_abdruck;

/// Derselbe Nachweis, wenn das Bild im Grafikspeicher liegenbleibt.
mod gpuabdruck;
pub use gpuabdruck::{Briefkasten, Zulauf};
#[cfg(test)]
pub use gpuabdruck::luma_abdruck;

/// Zustand der Einfrier-Erkennung. Bewusst ohne jeden FFmpeg-Bezug, damit die
/// Entscheidung ohne Decoder pruefbar ist.
#[derive(Default)]
pub struct EinfrierWacht {
    /// Fingerabdruck des zuletzt ausgegebenen Bildes und wie oft er sich in
    /// Folge NICHT geaendert hat.
    letzter_abdruck: Option<u64>,
    gleiche_bilder: u32,
    /// Wann sich das Bild zuletzt geaendert hat — die zweite Bedingung neben
    /// dem Zaehler (s. [`EINFRIER_DAUER`]). `None` heisst „noch kein Bild
    /// gesehen"; dann steht auch `gleiche_bilder` auf 0 und es kann nichts
    /// melden.
    letzte_aenderung: Option<std::time::Instant>,
    /// Bytes, die seit dem letzten VERAENDERTEN Bild hineingegangen sind.
    bytes_seit_bild: usize,
    /// Laufendes Bewegungsfenster: Bilder darin und wieviele davon neu waren.
    fenster_bilder: u32,
    fenster_wechsel: u32,
    /// Fenster mit Bewegung in Folge (s. [`BEWEGUNGS_KETTE`]).
    bewegte_fenster: u32,
    /// Meldungen seit der letzten nachweislich bewegten Wiedergabe.
    stufe: u32,
    /// Die letzten beobachteten Vollbild-Abstaende des Senders, aus denen
    /// [`EinfrierWacht::mindestdauer`] ihre Untergrenze zieht (s. dort).
    /// Ringpuffer, damit ein einzelner Ausreisser wieder herausfaellt.
    vollbild_abstaende: [std::time::Duration; VOLLBILD_FENSTER],
    vollbild_platz: usize,
    /// Nur mit `PULSE_PLAYER_TAKT_LOG=1` (s. [`messung::TaktDiagnose`]).
    takt: Option<messung::TaktDiagnose>,
}

impl EinfrierWacht {
    /// Eine hineingehende Zugriffseinheit mitzaehlen.
    pub fn daten(&mut self, bytes: usize) {
        self.bytes_seit_bild = self.bytes_seit_bild.saturating_add(bytes);
    }

    /// Ein ausgegebenes Bild mitzaehlen.
    pub fn bild(&mut self, planes: &[Vec<u8>]) {
        self.bild_zur_zeit(planes, std::time::Instant::now());
    }

    /// Ein Bild mitzaehlen, dessen Abdruck **auf der GPU** entstanden ist.
    ///
    /// Der Weg, auf dem das Bild den Hauptspeicher gar nicht erst sieht
    /// (`crate::zerocopy`). Von hier an ist alles gleich — der Waechter
    /// vergleicht den Abdruck ohnehin nur mit sich selbst, und WIE er entstand,
    /// geht ihn nichts an (s. [`gpuabdruck`]).
    ///
    /// **Der Versatz von ein bis zwei Bildern ist Absicht und folgenlos.** Das
    /// Ergebnis wird auf der GPU angefordert und ein paar Bilder spaeter
    /// abgeholt, statt darauf zu warten; ein blockierendes Ruecklesen je Bild
    /// waere genau die Rundreise, die der Zero-Copy-Weg gerade beseitigt. Der
    /// Waechter zaehlt ueber Sekunden und braucht die Antwort nicht im selben
    /// Bild — nur die REIHENFOLGE muss stimmen, und dafuer sorgt der Renderer.
    pub fn bild_von_der_gpu(&mut self, abdruck: u64) {
        self.abdruck_zur_zeit(abdruck, std::time::Instant::now());
    }

    /// Wie [`EinfrierWacht::bild`], mit gesetzter Uhr.
    ///
    /// Die Uhr ist herausgezogen, weil [`EINFRIER_DAUER`] sonst nicht pruefbar
    /// waere: ein Test fuettert 3600 Bilder in Millisekunden, `Instant::now()`
    /// bliebe dabei praktisch stehen und JEDE Meldung fiele aus — der Test
    /// waere gruen, ohne irgendetwas gezeigt zu haben.
    fn bild_zur_zeit(&mut self, planes: &[Vec<u8>], jetzt: std::time::Instant) {
        self.abdruck_zur_zeit(bild_abdruck(planes), jetzt);
    }

    /// Der gemeinsame Rumpf beider Wege: hier zaehlt nur noch der Abdruck.
    fn abdruck_zur_zeit(&mut self, abdruck: u64, jetzt: std::time::Instant) {
        let veraendert = self.letzter_abdruck != Some(abdruck);
        if veraendert {
            self.letzter_abdruck = Some(abdruck);
            self.gleiche_bilder = 0;
            self.bytes_seit_bild = 0;
            self.letzte_aenderung = Some(jetzt);
        } else {
            // `letzte_aenderung` steht hier immer: in diesen Zweig kommt man
            // nur mit einem vorherigen Bild, und das erste Bild gilt per
            // `letzter_abdruck == None` immer als veraendert.
            self.gleiche_bilder = self.gleiche_bilder.saturating_add(1);
        }
        if messung::takt_log() {
            self.takt.get_or_insert_with(messung::TaktDiagnose::default).bild(veraendert);
        }
        self.bewegung_fortschreiben(veraendert);
    }

    /// Laeuft die Wiedergabe wieder? Dann zurueck auf vollen Pruefabstand.
    /// Bewusst ueber ein Fenster und nicht ueber ein einzelnes veraendertes
    /// Bild: ein einzelnes liefert auch ein Standbild, sobald der Sender
    /// seine Auffrischung darueberzieht (Modulkopf). Und bewusst ueber eine
    /// KETTE von Fenstern, weil die Rettung selbst ein paar Sekunden
    /// Bewegung erzeugt (s. [`BEWEGUNGS_KETTE`]).
    fn bewegung_fortschreiben(&mut self, veraendert: bool) {
        self.fenster_bilder += 1;
        self.fenster_wechsel += u32::from(veraendert);
        if self.fenster_bilder < BEWEGUNGS_FENSTER {
            return;
        }
        if self.fenster_wechsel >= BEWEGUNGS_WECHSEL {
            self.bewegte_fenster += 1;
            if self.bewegte_fenster >= BEWEGUNGS_KETTE {
                self.stufe = 0;
            }
        } else {
            self.bewegte_fenster = 0;
        }
        self.fenster_zuruecksetzen();
    }

    /// Ein frisches Bewegungsfenster beginnen.
    fn fenster_zuruecksetzen(&mut self) {
        self.fenster_bilder = 0;
        self.fenster_wechsel = 0;
    }

    /// Liefert der Decoder trotz ankommender Daten immer dasselbe Bild?
    ///
    /// `true` heisst „jetzt behandeln" — der Aufrufer leert den Decoder und
    /// fordert ein Vollbild an. Die Zaehler werden dabei zurueckgesetzt, sonst
    /// meldete jeder folgende Durchgang erneut und der Aufrufer schickte im
    /// Millisekundentakt Anforderungen.
    ///
    /// **Der Fingerabdruck bleibt dabei absichtlich stehen.** Ihn hier zu
    /// loeschen (so war es bis 2026-08-05) laesst das naechste Bild als
    /// „veraendert" durchgehen, egal was es zeigt: das Bewegungsfenster
    /// bekaeme bei jedem Standbild einen geschenkten Wechsel.
    pub fn eingefroren(&mut self) -> bool {
        self.eingefroren_zur_zeit(std::time::Instant::now())
    }

    /// Wie [`EinfrierWacht::eingefroren`], mit gesetzter Uhr — Begruendung bei
    /// [`EinfrierWacht::bild_zur_zeit`].
    fn eingefroren_zur_zeit(&mut self, jetzt: std::time::Instant) -> bool {
        let boden = messung::zahl("PULSE_PLAYER_EINFRIER_BYTES", EINFRIER_BYTES) as usize;
        // Drei Bedingungen, drei verschiedene Fragen: steht das Bild lange
        // genug in BILDERN (haelt die Erkennung scharf, wenn die Ausgaberate
        // einbricht), steht es lange genug in SEKUNDEN (haelt sie vom
        // Vollbild-Takt des Senders fern, s. [`EINFRIER_DAUER`]), und kommt
        // ueberhaupt noch etwas an (s. [`EINFRIER_BYTES`]).
        let dauer = self.mindestdauer();
        let lange_genug = self
            .letzte_aenderung
            .is_some_and(|t| jetzt.saturating_duration_since(t) >= dauer);
        if self.gleiche_bilder < self.schwelle() || !lange_genug || self.bytes_seit_bild < boden {
            return false;
        }
        if messung::abhilfe_aus() {
            // Weiterzaehlen lassen, nur nicht eingreifen — sonst misst der
            // Pruefstand die Nachwirkung der Rettung statt des Senders.
            self.gleiche_bilder = 0;
            self.bytes_seit_bild = 0;
            return false;
        }
        self.stufe = (self.stufe + 1).min(MAX_STUFE);
        self.gleiche_bilder = 0;
        self.bytes_seit_bild = 0;
        // Die Uhr faengt mit, sonst waere zwischen zwei Meldungen nur noch der
        // Bilder-Zaehler im Weg: bei 144 Bildern je Sekunde sind 180 Bilder
        // 1,25 Sekunden und damit wieder kuerzer als der Vollbild-Takt des
        // Senders. So gilt „mindestens [`EINFRIER_DAUER`] Stillstand" zwischen
        // JE ZWEI Rettungen, nicht nur vor der ersten.
        self.letzte_aenderung = Some(jetzt);
        // Die laufende Bewegungsrechnung faellt weg: was jetzt kommt, ist
        // zuerst die Wirkung der Rettung und nicht der Inhalt.
        self.fenster_zuruecksetzen();
        self.bewegte_fenster = 0;
        true
    }

    /// Wie viele unveraenderte Bilder derzeit noetig sind.
    pub fn schwelle(&self) -> u32 {
        messung::zahl("PULSE_PLAYER_EINFRIER_BILDER", EINFRIER_BILDER) << self.stufe
    }

    /// Einen beobachteten Vollbild-Abstand des Senders melden.
    ///
    /// Der Decoder misst ihn ohnehin (`decode.rs`, `keyframe_abstand`) — hier
    /// wird er zur Untergrenze von [`EinfrierWacht::mindestdauer`]. Siehe dort,
    /// warum die Wacht ihn braucht.
    pub fn vollbild_abstand(&mut self, abstand: std::time::Duration) {
        // Sinnlose Werte (Uhr rueckwaerts, doppelte Meldung) draussen lassen:
        // sie koennten das Fenster nur verkuerzen, nie verlaengern, und genau
        // die Richtung ist die gefaehrliche.
        if abstand.is_zero() {
            return;
        }
        self.vollbild_abstaende[self.vollbild_platz] = abstand;
        self.vollbild_platz = (self.vollbild_platz + 1) % VOLLBILD_FENSTER;
    }

    /// Wie lange das Bild zusaetzlich gestanden haben muss (s.
    /// [`EINFRIER_DAUER`]).
    ///
    /// Wie [`EinfrierWacht::schwelle`] die eine Stelle, an der die Zahl
    /// herkommt — geprueft wird gegen sie, und die Diagnoseausgabe nennt
    /// dieselbe. Zwei getrennte Abfragen der Umgebung koennten
    /// auseinanderlaufen, und das faellt ausgerechnet im Log nicht auf.
    ///
    /// **Warum sie seit 2026-08-18 dem Sender folgt.** [`EINFRIER_DAUER`] ist
    /// aus einem Vollbild-Abstand von zwei Sekunden hergeleitet (2000 plus ein
    /// Viertel). Das Bild aendert sich bei stehendem Inhalt naemlich genau im
    /// Takt der Vollbilder, sonst nie — gemessen und im Modulkopf belegt. Steht
    /// der Sender auf einem laengeren Takt, liegt ein festes Fenster von 2,5 s
    /// systematisch INNERHALB einer Periode und sieht dort ein Standbild, das
    /// keines ist. Mit `g=600` stand dasselbe Bild **597 Bilder** bitgleich;
    /// die Staffelung ([`MAX_STUFE`]) kommt nur bis 12 s bei 60 fps und holt
    /// das ab einem Takt darueber nie mehr ein — der Fehlalarm bliebe dauerhaft.
    ///
    /// Statt einer zweiten Einstellung, die man am Empfaenger von Hand zum
    /// Sender passend halten muesste, nimmt die Wacht den Takt, den sie
    /// ohnehin beobachtet. Der Aufschlag ist derselbe wie bei
    /// [`EINFRIER_DAUER`] (ein Viertel), aus demselben Grund: Jitter des
    /// Senders, Dekodierzeit, und der Fall, dass die Periode exakt erreicht
    /// wird.
    ///
    /// Genommen wird das **Groesste** der letzten [`VOLLBILD_FENSTER`]
    /// Abstaende, nicht das Letzte: ein auf Anforderung gesendetes Vollbild
    /// kommt zwischen zwei regulaeren an und ergibt einen kurzen Abstand, der
    /// das Fenster sonst zusammenzoege. Das Fenster ist begrenzt, damit ein
    /// einmaliger Ausreisser (echter Haenger) wieder herausfaellt, statt die
    /// Wacht fuer den Rest der Sitzung stumpf zu lassen.
    pub fn mindestdauer(&self) -> std::time::Duration {
        let fest = messung::dauer("PULSE_PLAYER_EINFRIER_MS", EINFRIER_DAUER);
        // Noch nichts beobachtet heisst: alle Plaetze auf null, das Groesste
        // ist null, und es bleibt bei `fest`. Kein Sonderfall noetig.
        let groesster = self.vollbild_abstaende.iter().copied().max().unwrap_or_default();
        fest.max(groesster + groesster / 4)
    }

    /// Wievielte Meldung ohne zwischenzeitlich laufende Wiedergabe das war —
    /// nur fuer die Diagnoseausgabe.
    pub fn stufe(&self) -> u32 {
        self.stufe
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ein Bild, dessen Inhalt an `n` haengt.
    fn bild(n: u8) -> Vec<Vec<u8>> {
        vec![vec![n; 300_000], vec![n ^ 0x5a; 150_000]]
    }

    /// Gestellte Uhr: ein Bild je `1/fps` Sekunde.
    ///
    /// **Ohne sie pruefen die Tests unten die Haelfte der Bedingung nicht.**
    /// Ein Testlauf schiebt 3600 Bilder in Millisekunden durch;
    /// `Instant::now()` steht dabei praktisch still, [`EINFRIER_DAUER`] waere
    /// nie erfuellt, und jeder Test, der eine Meldung erwartet, wuerde
    /// fehlschlagen — oder, schlimmer, jeder Test, der KEINE erwartet, waere
    /// gruen, ohne etwas gezeigt zu haben.
    struct Uhr {
        start: std::time::Instant,
        bilder: u64,
        fps: u64,
    }

    impl Uhr {
        fn mit(fps: u32) -> Self {
            Self { start: std::time::Instant::now(), bilder: 0, fps: u64::from(fps) }
        }

        /// Der Zeitpunkt wird jedes Mal aus der Bildnummer gerechnet, nicht
        /// aufaddiert. Ein aufaddierter Schritt von `1e9 / 60` ns ist um
        /// 0,67 ns zu kurz — nach 150 Bildern fehlen 100 ns auf 2,5 Sekunden,
        /// und die Meldung faellt genau ein Bild zu spaet. Das kostete beim
        /// ersten Durchlauf drei rote Tests und sah aus wie ein Fehler in der
        /// Sache.
        fn tick(&mut self) -> std::time::Instant {
            self.bilder += 1;
            self.start + std::time::Duration::from_nanos(self.bilder * 1_000_000_000 / self.fps)
        }
    }

    /// Fuettert `anzahl` Bilder samt Daten, deren Inhalt an der Bildnummer
    /// haengt, und liefert die Bildnummern, bei denen gemeldet wurde. 12 kB je
    /// Bild sind bei 60 fps rund 5,8 Mbit/s — genau die Lage, in der ein
    /// fuellender Encoder die Byte-Schwelle traegt, obwohl der Inhalt steht.
    ///
    /// Ein neuer Puffer entsteht nur, wenn `inhalt` sich aendert: ein
    /// Standbild ueber 36 000 Bilder legt einen an, nicht 36 000.
    fn fuettern(
        wacht: &mut EinfrierWacht,
        uhr: &mut Uhr,
        anzahl: u32,
        inhalt: impl Fn(u32) -> u8,
    ) -> Vec<u32> {
        let mut alarme = Vec::new();
        let mut gezeigt = None;
        let mut planes = Vec::new();
        for i in 0..anzahl {
            let n = inhalt(i);
            if gezeigt != Some(n) {
                gezeigt = Some(n);
                planes = bild(n);
            }
            let jetzt = uhr.tick();
            wacht.daten(12_000);
            wacht.bild_zur_zeit(&planes, jetzt);
            if wacht.eingefroren_zur_zeit(jetzt) {
                alarme.push(i);
            }
        }
        alarme
    }

    /// Stehendes Bild: derselbe Inhalt, volle Datenrate.
    fn stehendes_bild(wacht: &mut EinfrierWacht, uhr: &mut Uhr, anzahl: u32) -> Vec<u32> {
        fuettern(wacht, uhr, anzahl, |_| 7)
    }

    /// Bewegte Wiedergabe: jedes Bild ist neu.
    fn bewegtes_bild(wacht: &mut EinfrierWacht, uhr: &mut Uhr, anzahl: u32) {
        let alarme = fuettern(wacht, uhr, anzahl, |i| (i % 251) as u8 + 1);
        assert!(alarme.is_empty(), "laufendes Bild darf nie melden, war {alarme:?}");
    }

    /// Der Fall vom 2026-07-31: gleiches Bild, volle Datenrate.
    ///
    /// **Hier stand bis zum 2026-08-06 „Die erste Meldung MUSS nach 90 Bildern
    /// kommen"**, und der Test bestand aus `stehendes_bild(&mut w, 91) ==
    /// [90]`. Das war die Zahl, die den Fehlalarm erzeugt hat: 90 Bilder sind
    /// bei 60 fps anderthalb Sekunden und liegen damit INNERHALB des
    /// Zwei-Sekunden-Takts, in dem der Sender ein Standbild ohnehin veraendert
    /// (Messreihe im Modulkopf). Bindend ist jetzt [`EINFRIER_DAUER`], also
    /// 2500 ms — bei 60 Bildern je Sekunde das 150. Bild.
    #[test]
    fn haengender_decoder_wird_nach_zweieinhalb_sekunden_gemeldet() {
        let mut w = EinfrierWacht::default();
        let mut uhr = Uhr::mit(60);
        assert_eq!(stehendes_bild(&mut w, &mut uhr, 151), vec![150]);
    }

    /// **Ein langer Vollbild-Takt des Senders darf keinen Fehlalarm
    /// ausloesen.** Bei stehendem Inhalt aendert sich das dekodierte Bild nur
    /// im Takt der Vollbilder (Messreihe im Modulkopf) — ein festes Fenster von
    /// 2,5 s liegt bei einem Zehn-Sekunden-Takt systematisch INNERHALB einer
    /// Periode und sieht dort ein Standbild, das keines ist.
    #[test]
    fn langer_vollbild_takt_meldet_nicht_zu_frueh() {
        let mut w = EinfrierWacht::default();
        let mut uhr = Uhr::mit(60);
        w.vollbild_abstand(std::time::Duration::from_secs(10));

        // Zehn Sekunden Stillstand sind bei diesem Sender der Normalfall.
        let alarme = stehendes_bild(&mut w, &mut uhr, 600);
        assert!(alarme.is_empty(), "im Takt des Senders darf nichts melden, war {alarme:?}");
    }

    /// Die Anpassung darf die Wacht nicht abschalten — jenseits des Takts ist
    /// ein stehendes Bild weiterhin ein Haenger.
    #[test]
    fn langer_vollbild_takt_meldet_trotzdem_noch() {
        let mut w = EinfrierWacht::default();
        let mut uhr = Uhr::mit(60);
        w.vollbild_abstand(std::time::Duration::from_secs(10));

        let alarme = stehendes_bild(&mut w, &mut uhr, 800);
        let erster = *alarme.first().expect("ein echter Haenger muss gemeldet werden");
        assert!(erster > 700, "nicht vor Ablauf des Takts, war {erster}");
    }

    /// Ein auf Anforderung gesendetes Vollbild landet zwischen zwei regulaeren
    /// und ergibt einen kurzen Abstand. Wuerde die Wacht dem letzten Wert
    /// folgen, zoege genau das ihr Fenster wieder zusammen — und der Fehlalarm
    /// waere zurueck, ausgerechnet nach einem Verlust.
    #[test]
    fn ein_kurzer_abstand_zieht_das_fenster_nicht_zusammen() {
        let mut w = EinfrierWacht::default();
        w.vollbild_abstand(std::time::Duration::from_secs(10));
        w.vollbild_abstand(std::time::Duration::from_millis(200));
        assert!(
            w.mindestdauer() >= std::time::Duration::from_secs(12),
            "war {:?}",
            w.mindestdauer()
        );
    }

    /// Umgekehrt darf ein einmaliger Ausreisser die Wacht nicht dauerhaft
    /// stumpf lassen — deshalb ein Fenster und kein Maximum ueber die ganze
    /// Sitzung.
    #[test]
    fn ausreisser_faellt_wieder_heraus() {
        let mut w = EinfrierWacht::default();
        w.vollbild_abstand(std::time::Duration::from_secs(30));
        for _ in 0..VOLLBILD_FENSTER {
            w.vollbild_abstand(std::time::Duration::from_secs(2));
        }
        assert_eq!(
            w.mindestdauer(),
            EINFRIER_DAUER,
            "nach einem vollen Fenster zaehlt der Ausreisser nicht mehr"
        );
    }

    /// **Dieselbe Dauer bei jeder Bildrate** — das ist der ganze Zweck von
    /// [`EINFRIER_DAUER`].
    ///
    /// Mit dem reinen Bilder-Zaehler war die erste Meldung bei 30 fps nach drei
    /// Sekunden faellig, bei 60 nach anderthalb und bei 144 nach sechs
    /// Zehnteln — ein Unterschied vom Fuenffachen, ohne dass sich am Inhalt
    /// etwas aenderte. Genau diese Spreizung war der Fehlalarm: unterhalb von
    /// zwei Sekunden liegt das Fenster im Takt des Senders.
    #[test]
    fn erste_meldung_haengt_nicht_mehr_an_der_bildrate() {
        for fps in [30u32, 60, 144, 240] {
            let mut w = EinfrierWacht::default();
            let mut uhr = Uhr::mit(fps);
            let alarme = stehendes_bild(&mut w, &mut uhr, fps * 4);
            let erste = *alarme.first().expect("es muss melden");
            let sekunden = f64::from(erste) / f64::from(fps);
            assert!(
                (2.4..=3.2).contains(&sekunden),
                "bei {fps} fps kam die erste Meldung nach {sekunden:.2} s (Bild {erste})"
            );
        }
    }

    /// **Die Gegenrichtung**: die Rettung hat gewirkt, das Bild laeuft wieder.
    /// Danach muss die Erkennung wieder mit vollem Tempo scharf sein, auch
    /// wenn der Pruefabstand vorher am Anschlag stand — sonst waere ein
    /// Haenger nach einer langen Standbild-Szene zwoelf Sekunden lang
    /// unbemerkt.
    #[test]
    fn bewegtes_bild_stellt_das_volle_tempo_wieder_her() {
        let mut w = EinfrierWacht::default();
        let mut uhr = Uhr::mit(60);
        stehendes_bild(&mut w, &mut uhr, 3000);
        assert_eq!(w.stufe(), MAX_STUFE, "Vorbedingung: Staffel am Anschlag");

        // Acht Fenster ununterbrochener Bewegung — s. BEWEGUNGS_KETTE.
        bewegtes_bild(&mut w, &mut uhr, BEWEGUNGS_FENSTER * BEWEGUNGS_KETTE);
        assert_eq!(w.stufe(), 0, "laufende Wiedergabe muss zuruecksetzen");
        assert_eq!(w.schwelle(), EINFRIER_BILDER);

        // Zweiter Haenger, direkt danach: wieder nach 2,5 Sekunden.
        assert_eq!(stehendes_bild(&mut w, &mut uhr, 151), vec![150]);
    }

    /// **Die Rettung darf ihre eigene Staffelung nicht zuruecksetzen.** Nach
    /// dem Leeren des Decoders kommt ein Schub unterschiedlicher Bilder — das
    /// Aufholen bis zum Vollbild —, der mit dem Inhalt nichts zu tun hat.
    ///
    /// Ohne diese Sperre stand die Staffel bei jeder Meldung wieder auf 1: am
    /// 2026-08-05 live gemessen, 23 Meldungen in 90 Sekunden auf stehendem
    /// Inhalt, im Log jede einzelne als „Meldung 1". Die Staffelung war damit
    /// wirkungslos, ohne dass ein Test das gezeigt haette.
    #[test]
    fn aufholschub_nach_der_rettung_setzt_die_staffelung_nicht_zurueck() {
        let mut w = EinfrierWacht::default();
        let mut uhr = Uhr::mit(60);
        assert_eq!(stehendes_bild(&mut w, &mut uhr, 151).len(), 1);
        assert_eq!(w.stufe(), 1);

        // Der Schub: 240 verschiedene Bilder unmittelbar nach der Meldung —
        // vier Sekunden, so lang wie der laengste live gemessene Nachlauf.
        bewegtes_bild(&mut w, &mut uhr, 240);

        // Danach steht der Inhalt wieder — die naechste Meldung muss die
        // Staffel WEITER hochzaehlen, nicht bei 1 anfangen.
        let alarme = stehendes_bild(&mut w, &mut uhr, 400);
        assert!(!alarme.is_empty(), "die Erkennung muss weiter melden");
        assert!(
            w.stufe() >= 2,
            "der Aufholschub darf nicht als Bewegung gelten, Staffel ist {}",
            w.stufe()
        );
    }

    /// Standbild: dieselbe Meldung kommt immer wieder. Der Abstand muss sich
    /// verdoppeln und bei [`MAX_STUFE`] stehenbleiben.
    #[test]
    fn standbild_meldet_immer_seltener() {
        let mut w = EinfrierWacht::default();
        let mut uhr = Uhr::mit(60);
        let alarme = stehendes_bild(&mut w, &mut uhr, 3600); // eine Minute bei 60 fps
        let abstaende: Vec<u32> = alarme.windows(2).map(|p| p[1] - p[0]).collect();
        assert_eq!(
            &abstaende[..3],
            &[180, 360, 720],
            "Abstand muss sich verdoppeln, war {abstaende:?}"
        );
        assert!(
            abstaende[3..].iter().all(|&a| a == 720),
            "ab MAX_STUFE muss der Abstand stehen, war {abstaende:?}"
        );
        // Ohne Staffelung waeren es 3600/90 = 40 Meldungen je Minute — jede
        // ein erzwungenes Vollbild zum Fuenffachen eines normalen Bildes.
        assert_eq!(alarme.len(), 7, "40 Meldungen je Minute waren der Fehler");
    }

    /// **Der Vollbild-Takt des Senders darf gar nicht erst melden.**
    ///
    /// **Hier stand bis zum 2026-08-06 ein schwaecherer Anspruch**: „auf genau
    /// diesem Inhalt kostet der Fehlalarm EINE Meldung statt 40 je Minute" —
    /// der Test verlangte `alarme == 1`. Eine Meldung je Standbild-Strecke ist
    /// eine zu viel: sie leert den Decoder und erzwingt ein Vollbild, ohne dass
    /// irgendetwas kaputt war. Mit [`EINFRIER_DAUER`] sind es **null**.
    ///
    /// Gefahren werden beide gemessenen Enden des Takts: 117 Bilder (AV1,
    /// 1080p60 auf flaechigem Standbild) und 120 — die volle Periode, so
    /// gemessen, sooft das Vollbild bitgleich rekonstruierte.
    #[test]
    fn vollbild_takt_des_senders_meldet_gar_nicht() {
        for takt in [117u32, 120] {
            let mut w = EinfrierWacht::default();
            let mut uhr = Uhr::mit(60);
            let alarme = fuettern(&mut w, &mut uhr, 3600, |i| 7 + (i / takt) as u8 % 3);
            assert!(
                alarme.is_empty(),
                "Takt {takt}: der Sender allein darf nichts ausloesen, war {alarme:?}"
            );
            assert_eq!(w.stufe(), 0, "Takt {takt}: ohne Meldung keine Staffel");
        }
    }

    /// Die Gegenprobe dazu, und ohne sie waere der Test darueber wertlos: ein
    /// Bild, das ueber den Takt HINAUS steht, muss weiterhin gemeldet werden.
    /// Sonst waere „null Meldungen" schlicht eine abgeschaltete Erkennung.
    #[test]
    fn stillstand_ueber_den_takt_hinaus_meldet_weiterhin() {
        let mut w = EinfrierWacht::default();
        let mut uhr = Uhr::mit(60);
        // Zwei Takte lang brav auffrischen, dann bleibt das Bild stehen.
        let alarme = fuettern(&mut w, &mut uhr, 3600, |i| {
            if i < 240 { 7 + (i / 120) as u8 % 3 } else { 9 }
        });
        assert!(alarme.len() >= 5, "ein echter Haenger muss melden, waren {}", alarme.len());
    }

    /// Die Staffelung darf sich NIE ganz abschalten: auch nach einer langen
    /// Standbild-Strecke muss weiter geprueft werden.
    #[test]
    fn erkennung_bleibt_dauerhaft_scharf() {
        let mut w = EinfrierWacht::default();
        let mut uhr = Uhr::mit(60);
        let alarme = stehendes_bild(&mut w, &mut uhr, 36_000); // zehn Minuten
        assert!(
            alarme.len() >= 45,
            "Erkennung darf nicht einschlafen: nur {} Meldungen",
            alarme.len()
        );
        assert_eq!(w.schwelle(), EINFRIER_BILDER << MAX_STUFE);
    }

    /// Ohne ankommende Daten keine Meldung — das ist der Abriss, und um den
    /// kuemmert sich `session.rs`. Ein Decoder, den niemand fuettert, ist
    /// nicht eingefroren.
    #[test]
    fn ohne_daten_keine_meldung() {
        let mut w = EinfrierWacht::default();
        let mut uhr = Uhr::mit(60);
        let stand = bild(3);
        for _ in 0..1000 {
            let jetzt = uhr.tick();
            w.bild_zur_zeit(&stand, jetzt);
            assert!(
                !w.eingefroren_zur_zeit(jetzt),
                "ohne Daten darf nichts gemeldet werden"
            );
        }
    }

    /// Die Byte-Schwelle ist ein Boden, kein Zeitfenster: ein langsamer Strom
    /// meldet spaeter, aber er meldet.
    #[test]
    fn langsamer_strom_meldet_spaeter_trotzdem() {
        let mut w = EinfrierWacht::default();
        let mut uhr = Uhr::mit(60);
        let stand = bild(11);
        let mut alarme = 0;
        for _ in 0..2000 {
            let jetzt = uhr.tick();
            w.daten(1000); // 60 kB/s statt 720 kB/s
            w.bild_zur_zeit(&stand, jetzt);
            if w.eingefroren_zur_zeit(jetzt) {
                alarme += 1;
            }
        }
        assert!(alarme >= 1, "auch langsame Stroeme muessen irgendwann melden");
    }
}
