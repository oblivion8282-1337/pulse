//! Eine Wiedergabe-Sitzung: WHEP -> Jitter-Puffer -> Depacketisierung ->
//! Decode. Laeuft vollstaendig im Tokio-Kontext und schickt fertige Bilder an
//! den Fenster-Thread.
//!
//! Die Reihenfolge ist der Kern des Ganzen. Chromium versteckt Puffer und
//! Decoder-Wahl; hier ist beides sichtbar und zur Laufzeit einstellbar.

use std::collections::HashMap;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tokio::sync::mpsc;

use crate::decode::{DecodedFrame, VideoDecoder};
use crate::depacket::Assembler;
use crate::jitter::{JitterBuffer, Release};
use crate::mediasink::{MediaSink, MediaStats};
use crate::proto::PlayerOptions;
use crate::whep::{self, redact_tokens, Codec, RtpArrival};

/// Wie oft der Jitter-Puffer auf faellige Pakete geprueft wird, wenn gerade
/// nichts hereinkommt. Feiner als die kleinste sinnvolle Zielzeit.
const POLL_INTERVAL: Duration = Duration::from_millis(2);

/// Wie oft die Statistik nach vorne geht. Bewusst grob: die Zahlen werden
/// angezeigt, nicht ausgewertet, und jedes Ereignis weckt den Fenster-Thread.
const STATS_INTERVAL: Duration = Duration::from_millis(250);

/// Nach wie vielen Statistik-Fenstern ohne ein einziges Byte die Sitzung als
/// abgerissen gilt. 12 mal 250 ms sind drei Sekunden.
///
/// **Warum es diesen zweiten Waechter braucht.** Die Einfrier-Erkennung in
/// `einfrieren.rs` kann einen Abriss PER KONSTRUKTION nicht sehen: sie verlangt
/// neben den unveraenderten Bildern auch `EINFRIER_BYTES` an ankommenden Daten
/// — und ohne Daten waechst dieser Zaehler nie. Sie fragt „aendert sich das
/// Bild nicht, obwohl gesendet wird", hier lautet die Frage „kommt ueberhaupt
/// noch etwas".
///
/// Gemessen am 2026-08-05: nach einem Abriss meldete der Player `dekodiert
/// 0/s`, `0 kbit/s`, keinen Fehler, versuchte keine Neuverbindung — und zaehlte
/// rund 100 Ton-Unterlaeufe je Sekunde weiter, in einem Lauf ueber 128 s bis
/// 13116. Von aussen sah das aus wie ein stehendes Bild.
///
/// Drei Sekunden sind ein Kompromiss: lang genug, dass eine Netzdelle oder
/// eine kurze Saettigung nicht hineinlaeuft (die laengste beobachtete
/// Ankunftsluecke lag bei 31 ms), kurz genug, dass niemand minutenlang auf ein
/// totes Bild sieht.
const STILLE_FENSTER_BIS_ABBRUCH: u32 = 12;

/// Fenster fuer Bildrate und Bitrate. Bewusst ein VIELFACHES von
/// [`STATS_INTERVAL`] und hier berechnet, nicht beim Anzeigen: wer die Rate aus
/// zwei Abfragen eines fremden Taktes bildet, misst mal 3, mal 4 Intervalle und
/// zeigt bei voellig gleichmaessigem Strom Schwankungen von ueber 30 %. Genau
/// das war der Fall, als Overlay und App das selbst rechneten.
const RATE_INTERVAL: Duration = Duration::from_millis(1000);

/// Wie lange eine Sitzung hoechstens braucht, um das erste Bild zu zeigen.
///
/// Das ist ein Auffangnetz fuer JEDE Ursache, nicht fuer eine bestimmte. Die
/// Einzeltimeouts in `whep.rs` (15 s HTTP, 2 s ICE-Sammeln) decken nur ab, was
/// sie kennen; beobachtet am 2026-07-26 wurde ein Fall, in dem der WHEP-Aufbau
/// gar nicht erst bei MediaMTX ankam — die Sitzung wartete danach still und
/// unbegrenzt auf RTP, und die Kachel im Renderer stand dauerhaft auf
/// "verbinde". Ohne Obergrenze ist jeder unbekannte Aufbaufehler ein Haenger.
///
/// Grosszuegiger als die Summe der Einzelschritte (Aufbau ~1 s, Warten auf den
/// Einstiegspunkt ~1 s gemessen), damit ein langsamer, aber funktionierender
/// Start nicht faelschlich abgebrochen wird.
const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(20);

/// Mindestabstand zwischen zwei Vollbild-Anforderungen.
///
/// 200 ms sind laenger als jede plausible Umlaufzeit (die echte Teststrecke
/// misst 53 ms) — die Antwort auf eine Anforderung ist also da, bevor die
/// naechste rausgeht. Kuerzer waere schaedlich: ein Verlust erzeugt meist
/// mehrere Luecken kurz hintereinander, und jede Anforderung kostet den Sender
/// ein volles Bild. Ohne Bremse traefe der Player die Leitung, die schon
/// ueberlastet ist, mit zusaetzlicher Last.
const KEYFRAME_REQUEST_INTERVAL: Duration = Duration::from_millis(200);

/// Wie oft nachgefordert wird, solange der Decoder noch gar keinen
/// Einstiegspunkt hat. Laenger als [`KEYFRAME_REQUEST_INTERVAL`]: dort ist eine
/// laufende Wiedergabe zu retten und jede Millisekunde zaehlt, hier wartet der
/// Zuschauer ohnehin schon auf das erste Bild. Fuenf Anforderungen je Sekunde
/// waeren nur Last auf dem Rueckkanal.
const EINSTIEG_REQUEST_INTERVAL: Duration = Duration::from_millis(500);

/// Laufende Zaehler einer Sitzung, wie sie `stats` nach vorne meldet.
#[derive(Debug, Default, Clone, Copy, serde::Serialize)]
pub struct SessionStats {
    pub packets_received: u64,
    /// Angekommene Nutzlast-Bytes (Bild + Ton).
    pub bytes_received: u64,
    /// Groesster Abstand zweier ankommender VIDEO-RTP-Pakete und die Zahl der
    /// Abstaende ueber 5 ms, je Melde-Fenster. Trennt „das Netz liefert in
    /// Schueben" von „der Player macht Schuebe daraus".
    pub arrival_gap_max_us: u64,
    pub arrival_gaps_over_5ms: u64,
    /// Gemessene Bildrate und Bitrate ueber [`RATE_INTERVAL`] — hier gerechnet,
    /// damit alle Anzeigen dieselbe Zahl zeigen (s. Konstanten-Doku). `None`,
    /// bis das erste Fenster voll ist.
    pub fps: Option<u64>,
    pub kbps: Option<u64>,
    pub packets_lost: u64,
    pub packets_reordered: u64,
    pub packets_duplicate: u64,
    /// Was die FlexFEC-Paritaet ausgerichtet hat: wiederhergestellte Pakete,
    /// Gruppen mit mehr Loechern als Paritaet (XOR loest nur EINE Unbekannte
    /// je Gruppe) und Reparaturen, die zu spaet fuer den Puffer kamen.
    ///
    /// **Gehoert neben `packets_lost` und nicht auf stderr.** Ohne beide
    /// Zahlen in derselben Akte ist nach einer Aenderung an der Paritaet nicht
    /// zu unterscheiden, ob sie gewirkt hat oder ob die Leitung ruhiger war.
    /// Alle drei bleiben null, wenn die Paritaet abgeschaltet ist
    /// (`PULSE_PLAYER_FLEXFEC=0`) oder der Server keine sendet.
    pub fec_repariert: u64,
    pub fec_unreparierbar: u64,
    /// Paritaet, die nichts bewirkt hat — MISST NICHT VERLUST. Was wirklich
    /// fehlte, steht in `packets_lost`.
    pub fec_verworfen: u64,
    /// Gruppen, in denen XOR an seine Grenze kam (mehr als ein Loch). Der
    /// Zaehler, der bis zum 2026-07-31 fehlte — `fec_unreparierbar` allein
    /// stand in acht Messlaeufen auf 0, auch wo die Paritaet nachweislich
    /// versagte, und trug damit die falsche Aussage „XOR scheitert nie".
    pub fec_mehrfach_loch: u64,
    pub fec_zu_spaet: u64,
    /// Gemessene Umlaufzeit der nominierten ICE-Paarung, in Millisekunden.
    /// Steuert die NACK-Sperrfrist (s. `whep::sperre_aus_rtt`) und gehoert
    /// deshalb in die Akte: ohne sie ist nicht nachvollziehbar, mit welcher
    /// Sperre ein Lauf gefahren ist.
    pub rtt_ms: Option<u64>,
    pub frames_decoded: u64,
    pub frames_dropped: u64,
    /// Bilder, die verworfen wurden, weil die Darstellung nicht mitkam.
    /// Anders als `frames_dropped` (Paketverlust) ist das kein Netzproblem.
    pub frames_skipped: u64,
    pub buffered_packets: u64,
    pub jitter_target_ms: u64,
    /// Latenz-Posten des Dekodierens: Summe und Anzahl (Mittel wird erst bei
    /// der Ausgabe gebildet, damit die Rohwerte nicht durch Rundung wandern)
    /// sowie der Ausschlag. Zuruecksetzen tut das Statistik-Fenster.
    pub decode_sum_us: u64,
    pub decode_count: u64,
    pub decode_max_us: u64,
    pub width: u32,
    pub height: u32,
    pub ten_bit_source: bool,
    /// Ton- und Aufnahme-Zaehler.
    #[serde(flatten)]
    pub media: MediaStats,
}

impl SessionStats {
    /// Mittel des Dekodierens im letzten vollen Fenster, in Mikrosekunden.
    /// `0` bis das erste Bild dekodiert wurde — an zwei Stellen gebraucht
    /// (Log-Zeile, `stats`-Antwort), deshalb hier gebuendelt.
    pub fn decode_avg_us(&self) -> u64 {
        if self.decode_count > 0 { self.decode_sum_us / self.decode_count } else { 0 }
    }
}

/// Bezugspunkt der Raten-Messung (s. [`RATE_INTERVAL`]).
struct RateRef {
    at: Instant,
    frames: u64,
    bytes: u64,
}

/// Was der Fenster-Thread von einer Sitzung zu sehen bekommt.
pub enum SessionEvent {
    Frame(Box<DecodedFrame>),
    Stats(SessionStats),
    /// Verbindung steht und der erste Frame ist dekodiert.
    Playing { decoder: String, hardware: bool },
    Ended { reason: String, failed: bool },
}

/// Rueckkanal fuer Aufnahme-Befehle: entweder die Nutzlast der RPC-Antwort
/// oder eine Fehlermeldung.
pub type MediaReply = tokio::sync::oneshot::Sender<Result<serde_json::Value, String>>;

/// Steuerbefehle an eine laufende Sitzung.
pub enum SessionCommand {
    Options(Box<PlayerOptions>),
    /// Laufende Aufnahme starten/stoppen bzw. die letzten Sekunden sichern.
    /// Die Antwort geht direkt an den Aufrufer zurueck, damit die
    /// RPC-Antwort das Ergebnis tragen kann.
    /// Antwort ist die JSON-Nutzlast der RPC-Antwort — bei `record` und `clip`
    /// steht dort der tatsaechlich benutzte Pfad, dessen Endung sich nach dem
    /// Codec richtet (AV1 braucht Matroska, H.264 MPEG-TS).
    Record { path: String, reply: MediaReply },
    StopRecord { reply: MediaReply },
    Clip { path: String, seconds: f64, reply: MediaReply },
    Stop,
}

/// Fuehrt eine Sitzung von Anfang bis Ende. Kehrt zurueck, wenn die Sitzung
/// endet (regulaer oder mit Fehler).
pub async fn run(
    url: String,
    ice: Vec<String>,
    mut options: PlayerOptions,
    events: mpsc::Sender<SessionEvent>,
    mut commands: mpsc::Receiver<SessionCommand>,
) {
    let (rtp_tx, mut rtp_rx) = mpsc::channel::<RtpArrival>(1024);

    let mut whep_session = match whep::connect(&url, &ice, rtp_tx).await {
        Ok(s) => s,
        Err(e) => {
            let _ = events
                .send(SessionEvent::Ended { reason: redact_tokens(&format!("{e:#}")), failed: true })
                .await;
            return;
        }
    };

    // Der Rueckfallwert muss mit `PlayerOptions::defaults` uebereinstimmen —
    // sonst haengt die Puffergeduld davon ab, ob der Aufrufer das Feld gesetzt
    // hat, und eine Messung trifft je nach Weg einen anderen Wert.
    let target = Duration::from_millis(u64::from(
        options.jitter_ms.unwrap_or(crate::proto::JITTER_MS_VORGABE),
    ));
    // Video und Audio haben eigene Sequenznummernkreise und brauchen deshalb
    // je einen eigenen Puffer.
    let mut buffers: HashMap<Codec, JitterBuffer> = HashMap::new();
    let mut assemblers: HashMap<Codec, Assembler> = HashMap::new();
    // Leer, solange `PULSE_PLAYER_DUMP_RTP` nicht gesetzt ist (s. `dump`).
    let mut dumps: HashMap<Codec, Option<crate::dump::RtpDump>> = HashMap::new();
    let mut decoder: Option<VideoDecoder> = None;
    let mut media = MediaSink::new();
    media.apply_options(&options);
    // Gemeinsame Zeitbasis fuer den Mitschnitt: Millisekunden seit Sitzungsstart.
    let started = Instant::now();
    let mut stats =
        SessionStats { jitter_target_ms: target.as_millis() as u64, ..Default::default() };
    let mut announced_playing = false;
    let mut last_stats = Instant::now();
    // Abriss-Erkennung: wie viele Fenster in Folge kein Byte kam, und der
    // Stand, gegen den verglichen wird.
    let mut stille_fenster: u32 = 0;
    let mut bytes_im_letzten_fenster: u64 = 0;
    let mut rate_ref = RateRef { at: Instant::now(), frames: 0, bytes: 0 };
    // Ankunfts-Diagnose (s. der Video-Zweig unten).
    //
    // `PULSE_PLAYER_ARRIVAL_GAP_LOG_MS` meldet jede Ankunftsluecke ab dieser
    // Groesse mit der WANDUHR. Der Zweck ist die Zuordnung zu einem
    // Paketmitschnitt: tcpdump stempelt in Wanduhrzeit, der Player rechnet
    // sonst nur in `Instant`. Erst beides zusammen ergibt, wie lange ein Paket
    // vom Draht bis hierher braucht — der letzte ungemessene Abschnitt der
    // Kette. Eine kuenstliche Sendepause erzeugt die noetige, unverwechselbare
    // Luecke; ohne sie ist der Strom zu gleichfoermig, um Punkte zuzuordnen.
    let arrival_gap_log_us: Option<u64> = std::env::var("PULSE_PLAYER_ARRIVAL_GAP_LOG_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .map(|ms| ms * 1000);
    let mut last_video_arrival: Option<Instant> = None;
    let mut arrival_gap_max = 0u64;
    let mut arrival_gaps_over_5ms = 0u64;
    // Vollbild-Anforderung nach Verlust (s. `whep::WhepSession::request_keyframe`).
    // Die Kennung kommt aus dem ersten Videopaket; vorher gibt es nichts
    // anzufordern.
    let mut video_ssrc: Option<u32> = None;
    // Takt der Video-Zeitstempel (s. der Video-Zweig unten). `0` = noch kein
    // Videopaket gesehen; `app::takt` behandelt das wie „kein Zeitstempel".
    let mut video_clock_rate: u32 = 0;
    // Gedrosselt, weil ein Verlust typischerweise MEHRERE Luecken hintereinander
    // erzeugt: ohne Bremse ginge fuer jede eine eigene Anforderung raus, der
    // Sender wuerde Vollbild um Vollbild schicken und damit genau die Bitrate
    // sprengen, die den Verlust verursacht hat.
    let mut last_keyframe_request = Instant::now() - KEYFRAME_REQUEST_INTERVAL;
    // Gar nicht erst anfordern, sondern sich von der wandernden Auffrischung
    // sauber waschen lassen (Versuch, hinter `PULSE_PLAYER_NO_KEYFRAME_REQUEST=1`;
    // gehoert zu `PULSE_PLAYER_DECODE_THROUGH`).
    //
    // Grund: Ein angefordertes Vollbild ist selbst ein Schwall aus 25-35
    // Paketen. Bei 5 % Verlust kommt es nur mit ~28 % Wahrscheinlichkeit heil
    // an — drei von vier Rettungsversuchen scheitern und werfen dabei erneut
    // Last auf die Leitung, die den Verlust verursacht hat. Am 2026-07-28
    // gemessen: 33 Anforderungen in 15 s, danach war die Verbindung tot,
    // waehrend derselbe Verlust im Keyframe-Betrieb spurlos vorbeiging.
    // Bei Intra-Refresh braucht es die Anforderung theoretisch nicht: nach
    // einem vollen Durchlauf (~2 s) ist jeder Bildteil einmal erneuert.
    // Anfordern ist Pflicht, nicht Kosmetik — am 2026-07-28 am laufenden
    // Stream WIDERLEGT, dass es auch ohne ginge:
    //
    // Die Annahme war, ein Strom mit wandernder Auffrischung repariere sich
    // binnen eines Durchlaufs von selbst, weil jeder Bildteil einmal erneuert
    // wird. Am Zuschauer passiert das nicht. Nach einem Aussetzer liefert
    // `av1_cuvid` weiter 60 Bilder je Sekunde — aber immer dasselbe. Das Bild
    // fror ein und blieb eingefroren, waehrend jede Kennzahl gesund aussah
    // (dekodiert 60/s, gezeichnet 60/s, Netz-bis-Schirm 4 ms). Zweimal
    // reproduziert.
    //
    // Der Preis bleibt bestehen und ist nicht hier zu loesen: Die Anforderung
    // geht an ALLE Zuschauer. Dagegen hilft das Auffangnetz
    // (`fallback_url`), nicht das Weglassen der Anforderung.
    let ohne_anforderung =
        std::env::var("PULSE_PLAYER_NO_KEYFRAME_REQUEST").as_deref() == Ok("1");
    let mut ticker = tokio::time::interval(POLL_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    // `failed` unterscheidet "Fenster zu" von "kaputt": nur beim zweiten faellt
    // der Renderer auf das <video>-Element zurueck.
    let (reason, failed) = loop {
        tokio::select! {
            cmd = commands.recv() => match cmd {
                Some(SessionCommand::Stop) | None => break ("closed".to_string(), false),
                Some(SessionCommand::Record { path, reply }) => {
                    let answer = media
                        .start_recording(&path)
                        .map(|used| serde_json::json!({ "path": used }));
                    let _ = reply.send(answer);
                }
                Some(SessionCommand::StopRecord { reply }) => {
                    let _ = reply.send(media.stop_recording().map(|()| serde_json::Value::Null));
                }
                Some(SessionCommand::Clip { path, seconds, reply }) => {
                    // Einsammeln ist ein Speicherkopiervorgang und darf hier
                    // laufen; das Schreiben geht auf einen Blocking-Thread.
                    // Synchron hier haette die Schleife stillgestanden, der
                    // RTP-Kanal waere uebergelaufen und der Strom haette einen
                    // sichtbaren Aussetzer bekommen.
                    match media.clip_snapshot(seconds) {
                        Ok(data) => {
                            tokio::task::spawn_blocking(move || {
                                let result =
                                    crate::recorder::write_clip(std::path::Path::new(&path), &data)
                                        .map(|(units, used)| {
                                            serde_json::json!({
                                                "units": units,
                                                "path": used.to_string_lossy(),
                                            })
                                        })
                                        .map_err(|e| format!("{e:#}"));
                                let _ = reply.send(result);
                            });
                        }
                        Err(e) => {
                            let _ = reply.send(Err(e));
                        }
                    }
                }
                Some(SessionCommand::Options(patch)) => {
                    options.apply(&patch);
                    options.clamp();
                    media.apply_options(&options);
                    // `hwdec` gilt laut proto.rs als zur Laufzeit umschaltbar.
                    // Der Decoder wird aber nur einmal angelegt — ohne dieses
                    // Verwerfen antwortete `set_option` mit `ok: true`, ohne
                    // dass sich etwas aenderte. Der naechste Frame legt ihn mit
                    // der neuen Einstellung neu an.
                    if patch.hwdec.is_some() {
                        decoder = None;
                    }
                    if let Some(ms) = options.jitter_ms {
                        let t = Duration::from_millis(u64::from(ms));
                        stats.jitter_target_ms = ms.into();
                        for b in buffers.values_mut() {
                            b.set_target(t);
                        }
                    }
                }
            },

            arrival = rtp_rx.recv() => {
                // Enden die Tracks, BEVOR je ein Bild kam, ist das ein
                // gescheiterter Aufbau und kein regulaeres Ende.
                let Some(arrival) = arrival else {
                    break ("track beendet".to_string(), !announced_playing);
                };
                let codec = arrival.codec;
                // Ankunfts-Abstand der VIDEO-Pakete, so früh wie möglich
                // gemessen. Das ist die Zahl, die entscheidet, wo die Buendel
                // entstehen: kommen die Pakete selbst schon in Schueben, ist es
                // das Netz (Sender oder MediaMTX); kommen sie gleichmaessig und
                // erst die Bilder in Schueben, macht der Player sie.
                if codec != Codec::Opus {
                    if let Some(prev) = last_video_arrival {
                        let gap = arrival.arrived.duration_since(prev).as_micros() as u64;
                        arrival_gap_max = arrival_gap_max.max(gap);
                        if gap > 5_000 {
                            arrival_gaps_over_5ms += 1;
                        }
                        if arrival_gap_log_us.is_some_and(|min| gap >= min) {
                            // Wanduhr des Stempels, nicht von jetzt: zwischen
                            // Ankunft und dieser Zeile liegt die Schleife.
                            let wall = SystemTime::now() - arrival.arrived.elapsed();
                            let ms = wall
                                .duration_since(UNIX_EPOCH)
                                .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
                            eprintln!(
                                "pulse-player: Ankunftsluecke {:.1} ms, erstes Paket danach \
                                 um {ms:.3}",
                                gap as f64 / 1000.0,
                            );
                        }
                    }
                    last_video_arrival = Some(arrival.arrived);
                    // Fuer die Vollbild-Anforderung nach einem Verlust: die
                    // Kennung des Videostroms steht nur im Paket selbst.
                    video_ssrc = Some(arrival.packet.header.ssrc);
                    // Der Takt der Zeitstempel — Grundlage des Ausgabe-Takts
                    // (`app::takt`). Er steht in der ausgehandelten
                    // Codec-Faehigkeit und ist deshalb NUR hier zu haben; der
                    // Jitter-Puffer reicht ihn nicht weiter. Nicht fest 90000
                    // eingesetzt, obwohl WebRTC-Video ihn immer so aushandelt:
                    // eine angenommene Zahl waere genau die Sorte Fehler, die
                    // sich als leichte Zeitlupe zeigt und nirgends auffaellt.
                    video_clock_rate = arrival.clock_rate;
                }
                buffers
                    .entry(codec)
                    .or_insert_with(|| JitterBuffer::new(target))
                    .push(arrival.packet, arrival.arrived);
            },

            _ = ticker.tick() => {}
        }

        // Auffangnetz gegen jede Art von haengendem Aufbau. Greift nur bis zum
        // ersten Bild; danach ist ein stiller Strom Sache des Senders.
        if !announced_playing && started.elapsed() > FIRST_FRAME_TIMEOUT {
            break (
                format!(
                    "kein Bild nach {} s — Verbindung kam nicht zustande",
                    FIRST_FRAME_TIMEOUT.as_secs()
                ),
                true,
            );
        }

        // Faellige Pakete freigeben und zu Zugriffseinheiten zusammensetzen.
        let now = Instant::now();
        for (codec, buffer) in buffers.iter_mut() {
            let assembler = assemblers
                .entry(*codec)
                .or_insert_with(|| Assembler::for_codec(*codec));
            // Genau einmal je Spur versuchen: `from_env` legt die Datei an,
            // ein Aufruf pro Durchlauf wuerde sie staendig neu leeren.
            dumps
                .entry(*codec)
                .or_insert_with(|| crate::dump::RtpDump::from_env(codec.as_str()));

            for release in buffer.poll(now) {
                let (unit, unit_arrived, unit_rtp_ts) = match release {
                    Release::Gap { .. } => {
                        assembler.on_gap();
                        // Eine Luecke bricht die Zeitreihe: das naechste Bild
                        // ist womoeglich weit spaeter. Der Ausgabe-Takt haengt
                        // sich in `app::takt` selbst neu ein, wenn der Abstand
                        // zu gross wird — hier ist nichts zu tun.
                        // Nur eine BILD-Luecke geht den Video-Decoder etwas an.
                        //
                        // Diese Schleife laeuft ueber ALLE Spuren, auch ueber
                        // Opus. Ohne die Abfrage stellte eine Tonluecke den
                        // Video-Decoder auf "warte auf Einstiegspunkt" und
                        // forderte ein Vollbild an — bei Verlust, der beide
                        // Spuren trifft, riss also der Ton das Bild mit. Am
                        // 2026-07-28 beim Nachmessen der Verlust-Erholung
                        // aufgefallen, eingebaut wenige Stunden zuvor mit dem
                        // Absturzschutz.
                        if codec.is_video() {
                            if let Some(d) = decoder.as_mut() {
                                d.on_gap();
                            }
                            // Und beim Sender ein Vollbild anfordern, sonst
                            // dauert das Warten bis zum naechsten regulaeren
                            // Keyframe.
                            if let Some(ssrc) = video_ssrc.filter(|_| !ohne_anforderung) {
                                if last_keyframe_request.elapsed() >= KEYFRAME_REQUEST_INTERVAL {
                                    last_keyframe_request = Instant::now();
                                    whep_session.request_keyframe(ssrc).await;
                                }
                            }
                        }
                        stats.frames_dropped += 1;
                        continue;
                    }
                    // Die Ankunftszeit reist mit: sie ist der Startpunkt der
                    // gemessenen Latenz und gehoert zu genau DIESER Einheit,
                    // nicht zum neuesten eingetroffenen Paket.
                    Release::Packet(p, arrived) => {
                        let marker = p.header.marker;
                        // Der RTP-Zeitstempel DIESES Pakets ist der der ganzen
                        // Zugriffseinheit: alle Pakete einer Einheit tragen
                        // denselben, das ist die RTP-Regel und zugleich das,
                        // woran der Zusammensetzer die Einheit erkennt. Er wird
                        // hier abgegriffen, weil `Assembler::push` ihn nicht
                        // durchreicht und eine Signaturaenderung dort jede
                        // Codec-Grammatik mit einer Zeitfrage belasten wuerde,
                        // die sie nichts angeht.
                        let ts = p.header.timestamp;
                        // Diagnose vor der Verarbeitung: der Mitschnitt soll
                        // zeigen, was ANKOMMT, nicht was wir daraus machen.
                        if let Some(d) = dumps.get(codec).and_then(Option::as_ref) {
                            d.write(&p.payload, marker);
                        }
                        (
                            assembler.push(p.header.sequence_number, &p.payload, marker),
                            Some(arrived),
                            Some(ts),
                        )
                    }
                };
                let Some(unit) = unit else { continue };

                // Jede Einheit geht an den Medien-Sink: Ton wird dort
                // dekodiert und ausgegeben, und beide Spuren laufen in den
                // Ringpuffer fuer Aufnahme und Clip.
                let ts_ms = started.elapsed().as_millis() as i64;
                media.handle_unit(*codec, &unit, ts_ms);

                if !codec.is_video() {
                    continue;
                }

                let dec = match decoder.as_mut() {
                    Some(d) => d,
                    None => match VideoDecoder::new(*codec, options.hwdec) {
                        Ok(d) => decoder.insert(d),
                        Err(e) => {
                            let reason = format!("Decoder: {e:#}");
                            let _ = events
                                .send(SessionEvent::Ended { reason, failed: true })
                                .await;
                            whep_session.close().await;
                            return;
                        }
                    },
                };

                match emit_frames(
                    dec,
                    &unit,
                    Zeitmarken {
                        arrived: unit_arrived,
                        rtp_ts: unit_rtp_ts,
                        clock_rate: video_clock_rate,
                    },
                    &mut stats,
                    &mut announced_playing,
                    &events,
                )
                .await
                {
                    Ok(()) => {}
                    // Der Fenster-Thread ist weg — die Sitzung hat keinen
                    // Abnehmer mehr. Kein Fehler, nur Ende.
                    Err(EmitError::NoConsumer) => {
                        whep_session.close().await;
                        return;
                    }
                    Err(EmitError::Decoder(reason)) => {
                        let _ = events
                            .send(SessionEvent::Ended {
                                reason: format!("Decoder: {reason}"),
                                failed: true,
                            })
                            .await;
                        whep_session.close().await;
                        return;
                    }
                }

                // Zweiter, von der Lueckenmeldung UNABHAENGIGER Weg zur
                // Rettung des Decoders.
                //
                // Der Gap-Zweig oben greift nur, wenn wirklich Pakete fehlen.
                // Am 2026-07-31 fror `av1_cuvid` aber nach dem Ende einer
                // Saettigungsphase ein, OHNE dass ein einziges Paket verloren
                // ging — er gab weiter 60 Bilder je Sekunde aus, immer
                // dasselbe, ueber 90 Sekunden. Keine Luecke, keine Rettung,
                // und jede Kennzahl sah gesund aus. Deshalb hier ein Auslöser,
                // der am ERGEBNIS haengt statt an der Ursache.
                //
                // WIE OFT er zuschlagen darf, entscheidet er selbst
                // (`einfrieren.rs`): ein Standbild sieht am Ergebnis genauso
                // aus wie ein Haenger, deshalb wird der Pruefabstand groesser,
                // solange sich nichts bewegt. Hier bleibt es bei „melden ->
                // Decoder neu -> Vollbild anfordern".
                if decoder.as_mut().is_some_and(VideoDecoder::eingefroren) {
                    if let Some(d) = decoder.as_mut() {
                        d.wegen_einfrieren_neu();
                    }
                    if let Some(ssrc) = video_ssrc.filter(|_| !ohne_anforderung) {
                        last_keyframe_request = Instant::now();
                        whep_session.request_keyframe(ssrc).await;
                    }
                }

                // Solange kein Einstiegspunkt da ist, NACHFORDERN.
                //
                // Im Intra-Refresh-Betrieb kommt kein regulaerer Keyframe mehr
                // — das einzige Vollbild kommt auf Anforderung. Ging die
                // hinaus, waehrend der Player noch im Verbindungsaufbau steckte,
                // wartete er danach vergeblich, bis
                // `MAX_UNITS_WITHOUT_KEYFRAME` die Sitzung abbrach: der
                // Zuschauer sah NIE ein Bild. Am 2026-07-31 im Pruefstand
                // beobachtet (150 Sekunden „dekodiert 0/s").
                //
                // Eigenes, laengeres Intervall als bei der Luecke: hier ist
                // noch gar nichts zu retten, und fuenf Anforderungen je Sekunde
                // waeren nur Last auf dem Rueckkanal.
                if decoder.as_ref().is_some_and(VideoDecoder::wartet_auf_einstieg)
                    && last_keyframe_request.elapsed() >= EINSTIEG_REQUEST_INTERVAL
                {
                    if let Some(ssrc) = video_ssrc.filter(|_| !ohne_anforderung) {
                        last_keyframe_request = Instant::now();
                        whep_session.request_keyframe(ssrc).await;
                    }
                }
            }
        }

        media.note_dimensions(stats.width, stats.height);
        media.note_ten_bit(stats.ten_bit_source);

        // Ueber ALLE Puffer summieren, nicht je Codec ueberschreiben: Bild und
        // Ton haben eigene Sequenznummernkreise und damit eigene Puffer. Vorher
        // gewann der zuletzt iterierte, und die HashMap-Reihenfolge ist pro
        // Prozess zufaellig — die Zahlen stammten also mal von der Video-, mal
        // von der Tonspur, ohne dass das erkennbar war.
        stats.packets_received = buffers.values().map(|b| b.received).sum();
        stats.bytes_received = buffers.values().map(|b| b.bytes_received).sum();
        stats.packets_lost = buffers.values().map(|b| b.lost).sum();
        (stats.fec_repariert, stats.fec_unreparierbar, stats.fec_verworfen,
         stats.fec_mehrfach_loch, stats.fec_zu_spaet) = whep_session.fec_zaehler();
        stats.packets_reordered = buffers.values().map(|b| b.reordered).sum();
        stats.packets_duplicate = buffers.values().map(|b| b.duplicates).sum();
        stats.buffered_packets = buffers.values().map(|b| b.buffered() as u64).sum();

        // --- Fund C: Statistik nicht bei jedem Schleifendurchlauf senden ---
        // Der Durchlauf wird von JEDEM RTP-Paket und zusaetzlich vom 2-ms-Ticker
        // ausgeloest, also ueber 1000-mal pro Sekunde. Jedes Ereignis weckt den
        // Fenster-Thread, der mit `ControlFlow::Wait` sonst schlafen wuerde —
        // nur um ein Zahlenfeld zu ueberschreiben.
        // Raten ueber ein festes Fenster nachziehen. Laeuft unabhaengig vom
        // Melde-Takt: die Felder behalten zwischen zwei Fenstern ihren Wert.
        if rate_ref.at.elapsed() >= RATE_INTERVAL {
            let secs = rate_ref.at.elapsed().as_secs_f64();
            if stats.frames_decoded >= rate_ref.frames {
                stats.fps = Some(
                    ((stats.frames_decoded - rate_ref.frames) as f64 / secs).round() as u64,
                );
            }
            if stats.bytes_received >= rate_ref.bytes {
                stats.kbps = Some(
                    ((stats.bytes_received - rate_ref.bytes) as f64 * 8.0 / secs / 1000.0).round()
                        as u64,
                );
            }
            rate_ref = RateRef {
                at: Instant::now(),
                frames: stats.frames_decoded,
                bytes: stats.bytes_received,
            };
        }

        if last_stats.elapsed() >= STATS_INTERVAL {
            last_stats = Instant::now();

            // --- Abriss erkennen: Stille, nicht Standbild ---
            //
            // Gegen `bytes_received` und nicht gegen die Bildzahl: ein Decoder,
            // der nichts mehr ausgibt, obwohl Pakete ankommen, ist das
            // EINFRIEREN und gehoert der Erkennung in `decode.rs`. Hier geht es
            // um den Fall, in dem gar nichts mehr kommt — und der sah bis heute
            // von aussen genauso aus.
            if stats.bytes_received == bytes_im_letzten_fenster {
                stille_fenster += 1;
            } else {
                stille_fenster = 0;
                bytes_im_letzten_fenster = stats.bytes_received;
            }
            if stille_fenster >= STILLE_FENSTER_BIS_ABBRUCH {
                // Ueber `break` und nicht ueber eine stille Ecke: die Sitzung
                // ist tot, und sie abzuraeumen beendet zugleich die
                // Ton-Unterlaeufe, die sonst bis in alle Ewigkeit weiterzaehlen.
                // Der Aufrufer entscheidet, ob neu verbunden wird.
                break (
                    format!(
                        "Verbindung abgerissen — seit {} Sekunden kein Paket",
                        (STILLE_FENSTER_BIS_ABBRUCH as u64 * STATS_INTERVAL.as_millis() as u64)
                            / 1000
                    ),
                    true,
                );
            }
            // NACK-Sperre an die gemessene Umlaufzeit koppeln. Im selben Takt
            // wie die Statistik, weil `get_stats()` ueber alle Transporte
            // laeuft — bei jedem Schleifendurchlauf waere das ueber 1000-mal
            // je Sekunde.
            stats.rtt_ms = whep_session.rtt_ms();
            // Erst hier abfragen: `media.stats()` nimmt die Sperre des
            // Audio-Ringpuffers, auf die auch der Geraete-Callback wartet.
            // Bei jedem Durchlauf waere das ueber 1000-mal pro Sekunde.
            stats.media = media.stats();
            stats.arrival_gap_max_us = arrival_gap_max;
            stats.arrival_gaps_over_5ms = arrival_gaps_over_5ms;
            arrival_gap_max = 0;
            arrival_gaps_over_5ms = 0;
            let _ = events.try_send(SessionEvent::Stats(stats));
            // Die drei Dekodier-Posten gelten JE FENSTER, nicht kumulativ —
            // sonst wuerde der Mittelwert ueber die ganze Sitzung glatt gebuegelt
            // und der Ausschlag blieb fuer immer stehen.
            stats.decode_sum_us = 0;
            stats.decode_count = 0;
            stats.decode_max_us = 0;
        }
    };

    // Eine laufende Aufnahme ausdruecklich abschliessen, damit der
    // Matroska-Trailer geschrieben wird. `Recorder` hat dafuer zusaetzlich ein
    // `Drop`-Netz; hier steht es explizit, weil die Absicht sonst nicht
    // erkennbar waere.
    if media.is_recording() {
        if let Err(e) = media.stop_recording() {
            eprintln!("pulse-player: Aufnahme beim Sitzungsende: {e}");
        }
    }
    whep_session.close().await;
    let _ = events.send(SessionEvent::Ended { reason, failed }).await;
}

/// Dekodiert eine Zugriffseinheit und schiebt die fertigen Bilder nach vorne.
/// `Err(())` heisst: der Fenster-Thread nimmt nichts mehr an, die Sitzung endet.
/// Warum das Ausliefern von Bildern abgebrochen ist. Die beiden Faelle
/// verlangen Gegensaetzliches: beim wegfallenden Abnehmer ist die Sitzung
/// ordnungsgemaess zu Ende (das Fenster wurde geschlossen), beim defekten
/// Decoder muss ein Fehler nach draussen — sonst haengt die Kachel im
/// Renderer fuer immer im Zustand "verbinde".
enum EmitError {
    /// Der Fenster-Thread nimmt nichts mehr an.
    NoConsumer,
    /// Der Decoder ist endgueltig hin (s. `decode::VideoDecoder::decode`).
    Decoder(String),
}

/// Die drei Zeitangaben, die eine Zugriffseinheit an ihre Bilder weitergibt.
///
/// Zusammen und nicht als drei Parameter: sie gehoeren zusammen, und drei
/// gleichartige `Option`s in einer Signatur sind die Sorte Stelle, an der zwei
/// davon irgendwann vertauscht werden.
struct Zeitmarken {
    /// Ankunft des abschliessenden Pakets — Start der gemessenen Latenz.
    arrived: Option<Instant>,
    /// Entstehungszeit beim Sender, auf dessen Uhr (s. `DecodedFrame::rtp_ts`).
    rtp_ts: Option<u32>,
    clock_rate: u32,
}

async fn emit_frames(
    dec: &mut VideoDecoder,
    unit: &[u8],
    zeit: Zeitmarken,
    stats: &mut SessionStats,
    announced_playing: &mut bool,
    events: &mpsc::Sender<SessionEvent>,
) -> Result<(), EmitError> {
    // Dauer des Dekodierens getrennt gemessen: sie ist der eine Posten der
    // Latenzkette, den DIESES Programm allein verantwortet. Gemessen wird der
    // ganze Aufruf, also Einspeisen UND Abholen — bei ffmpeg laeuft das
    // Dekodieren in eigenen Threads, ein Bild kann also erst beim naechsten
    // Aufruf herausfallen. Der Wert ist damit die Verzoegerung der Kette, nicht
    // die reine Rechenzeit eines Bildes; genau das ist die interessante Groesse.
    let before = Instant::now();
    let frames = dec.decode(unit).map_err(|e| EmitError::Decoder(format!("{e:#}")))?;
    if !frames.is_empty() {
        let us = before.elapsed().as_micros() as u64;
        stats.decode_sum_us += us;
        stats.decode_count += 1;
        stats.decode_max_us = stats.decode_max_us.max(us);
    }

    // Waehrend der Reparatur nach einer Luecke rechnet der Decoder auf einem
    // unvollstaendigen Referenzbild weiter. Das ist gewollt — nur ANSEHEN darf
    // man das Ergebnis nicht. Wird nichts geschickt, bleibt das letzte gute
    // Bild im Fenster stehen; nach einem Auffrisch-Durchlauf stimmt das Bild
    // wieder und es geht scharf weiter.
    let vorzeigbar = dec.ist_sauber();

    for mut f in frames {
        f.arrived = zeit.arrived;
        f.rtp_ts = zeit.rtp_ts;
        f.clock_rate = zeit.clock_rate;
        stats.frames_decoded += 1;
        stats.width = f.width;
        stats.height = f.height;
        stats.ten_bit_source = f.ten_bit;
        if !vorzeigbar {
            stats.frames_dropped += 1;
            continue;
        }
        if !*announced_playing {
            *announced_playing = true;
            let event =
                SessionEvent::Playing { decoder: dec.name.clone(), hardware: dec.hardware };
            let _ = events.send(event).await;
        }
        // Bewusst `try_send` statt `send().await`: das hier ist Live-Wiedergabe.
        // Kommt der Fenster-Thread nicht mit, ist das NEUESTE Bild richtig und
        // ein aufgestauter Rueckstand falsch — mit einem blockierenden Send
        // haetten sich Frames im Kanal gesammelt und die Latenz waere
        // mitgewachsen, statt dass Bilder uebersprungen werden. Der
        // Rueckstau haette sich ausserdem bis in den Jitter-Puffer
        // fortgepflanzt, weil die Schleife dann kein RTP mehr abholt.
        match events.try_send(SessionEvent::Frame(Box::new(f))) {
            Ok(()) => {}
            Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {
                stats.frames_skipped += 1;
            }
            Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                return Err(EmitError::NoConsumer)
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn unerreichbare_url_meldet_fehler_statt_zu_haengen() {
        let (tx, mut rx) = mpsc::channel(8);
        let (_cmd_tx, cmd_rx) = mpsc::channel(1);
        // Port 1 ist reserviert und antwortet nicht.
        run(
            "http://127.0.0.1:1/whep".to_string(),
            vec![],
            PlayerOptions::defaults(),
            tx,
            cmd_rx,
        )
        .await;

        let ev = rx.recv().await.expect("ein Ereignis erwartet");
        match ev {
            SessionEvent::Ended { failed, reason } => {
                assert!(failed, "muss als Fehler gemeldet werden: {reason}");
            }
            _ => panic!("erstes Ereignis muss Ended sein"),
        }
    }
}
