//! Tonausgabe: Opus dekodieren, auf die Geraeterate bringen, ausgeben.
//!
//! Aufbau, und warum er so aussieht:
//!
//! * `cpal::Stream` ist auf mehreren Plattformen **nicht** `Send`. Er kann
//!   deshalb nicht in der Tokio-Sitzung liegen. Stattdessen laeuft die Ausgabe
//!   auf einem eigenen Thread, der den Stream besitzt; gefuettert wird ueber
//!   einen Kanal.
//! * Zwischen Decode und Geraete-Callback liegt ein Ringpuffer. Der Callback
//!   darf nicht blockieren und nicht allokieren — er kopiert nur heraus und
//!   fuellt bei Unterlauf Stille auf.
//! * `av_offset_ms` wird als Ziel-Fuellstand des Rings umgesetzt: mehr Puffer
//!   heisst spaeterer Ton. Das ist grob, aber ehrlich — eine echte
//!   Zeitstempel-Synchronisierung braeuchte eine gemeinsame Uhr mit dem
//!   Videopfad, die es hier noch nicht gibt.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, bail, Context as _, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use ffmpeg_next as ffmpeg;

mod ringregelung;

use ringregelung::{Ringregelung, RING_SOLL_MS};

/// Wie viel Ton der Ring hoechstens vorhaelt. Laeuft die Wiedergabe davon,
/// ist er ohnehin verloren — dann lieber verwerfen als Speicher fressen.
///
/// Bewusst als ZEIT und nicht als feste Samplezahl: `av_offset_ms` darf bis
/// 2000 ms Vorlauf verlangen, und der Zielfuellstand skaliert mit Rate und
/// Kanalzahl des Geraets. Eine feste Zahl fuer 48 kHz Stereo lag darunter,
/// sobald ein Mehrkanal- oder Hochraten-Geraet im Spiel war — der Ring wurde
/// dann unter den Zielfuellstand gekappt, der Callback gab nie etwas aus und
/// es blieb dauerhaft still, ohne Meldung.
const MAX_RING_SECONDS: usize = 6;

/// Steuerbefehle an den Ausgabe-Thread.
enum AudioCommand {
    Pcm(Vec<f32>),
    /// Rohes Opus-Paket. Dekodiert und umgerechnet wird es auf DIESEM Thread,
    /// nicht beim Aufrufer — der Aufrufer ist die Sitzungsschleife, die auch
    /// die Bilder bearbeitet.
    ///
    /// Gemessen am 2026-07-26 (144-fps-Stream, 1440p10): mit Ton entstanden
    /// 42-44 Aussetzer je Sekunde mit Luecken bis 24 ms, ohne Ton NULL und der
    /// groesste Abstand lag bei 11 ms. Die 44 entsprachen dem Opus-Takt (ein
    /// Paket je 20 ms) — jedes Paket hielt die Bildverarbeitung an, solange es
    /// dekodiert und von 48000 auf die Geraeterate umgerechnet wurde.
    Packet(Vec<u8>),
    Volume(f32),
    OffsetMs(i32),
    Stop,
}

struct Shared {
    ring: VecDeque<f32>,
    volume: f32,
    /// Gewuenschter Fuellstand in Samples, bevor ausgegeben wird.
    /// = `RING_SOLL_MS` plus der Nutzer-Trim `av_offset_ms`.
    target_fill: usize,
    underruns: u64,
    dropped: u64,
    /// Rueckfuehrung auf `target_fill` (s. [`ringregelung`]).
    regelung: Ringregelung,
    /// Die Ausgabe wartet auf den Sollfuellstand, bevor sie (wieder) anlaeuft.
    ///
    /// **Warum das ein Zustand sein muss und keine Bedingung je Aufruf.** Bis
    /// zum 2026-08-07 stand in [`fill_output`] schlicht
    /// `if ring.len() < target_fill { Stille }`. Gemeint war der Anlauf, gewirkt
    /// hat es bei JEDEM Geraete-Aufruf: fiel der Ring einmal unter die 60 ms des
    /// Sollwerts, schwieg die Ausgabe, bis die vollen 60 ms wieder beisammen
    /// waren — bei 10-ms-Aufrufen also rund sechs stille Runden nach jeder
    /// Schwankung. Aus einer Delle von 20 ms wurde so ein hoerbarer Aussetzer,
    /// und `underruns` zaehlte davon **nichts**, weil der frueh verlassene Zweig
    /// am Zaehler vorbeiging. Die Kennzahl, an der dieser Weg beurteilt wird,
    /// mass den haeufigsten Fall nicht mit.
    ///
    /// Jetzt greift die Sperre nur, wenn der Ring wirklich leerlief — dann ist
    /// erneutes Vorfuellen richtig, weil sofortiges Weiterspielen mit ein paar
    /// Millisekunden Vorrat nur den naechsten Unterlauf holt.
    anlauf: bool,
    /// Solange der Ausgabe-Thread laeuft. Faellt er weg (vergiftete Sperre,
    /// Geraetefehler), meldete die Statistik sonst weiter "Ton aktiv",
    /// waehrend nichts mehr ankommt.
    alive: bool,
}

impl Shared {
    /// Ring nach dem Anhaengen auf den Sollwert zurueckfuehren. Der harte
    /// Deckel darueber (`max_ring_samples`) ist ein Notausgang, keine Regelung
    /// — die steht in [`ringregelung`].
    fn zurueckfuehren(&mut self, angehaengt: usize) {
        self.dropped +=
            self.regelung.nach_anhaengen(&mut self.ring, self.target_fill, angehaengt);
    }
}

/// Geraete-Callback. Laeuft im Echtzeit-Kontext: nicht blockieren, nicht
/// allokieren — nur aus dem Ring kopieren und bei Unterlauf Stille auffuellen.
fn fill_output(shared: &Mutex<Shared>, out: &mut [f32]) {
    let Ok(mut s) = shared.lock() else {
        out.fill(0.0);
        return;
    };
    // Erst anlaufen lassen, wenn der Zielfuellstand da ist — sonst startet die
    // Wiedergabe direkt mit Unterlauf. Das gilt beim Start und nach einem
    // leergelaufenen Ring, NICHT bei jeder Delle darunter (s. [`Shared::anlauf`]).
    if s.anlauf {
        if s.ring.len() < s.target_fill {
            out.fill(0.0);
            // Vorfuellen heisst: dem Geraet kommt nichts. Das gehoert gezaehlt,
            // sonst ist es genau die Sorte stiller Eingriff, die hier behoben wird.
            s.underruns += 1;
            return;
        }
        s.anlauf = false;
    }
    let volume = s.volume;
    let written = s.ring.len().min(out.len());
    for (slot, v) in out.iter_mut().zip(s.ring.drain(..written)) {
        *slot = (v * volume).clamp(-1.0, 1.0);
    }
    out[written..].fill(0.0);
    if written < out.len() {
        s.underruns += 1;
        // Der Ring ist jetzt leer — erst wieder vorfuellen, statt die naechsten
        // Aufrufe einzeln hungern zu lassen.
        s.anlauf = true;
    }
}

/// Nimmt Befehle entgegen, bis der Sender weg ist oder `Stop` kommt.
/// `per_ms` = Samples je Millisekunde ueber alle Kanaele.
fn pump_commands(
    rx: &std::sync::mpsc::Receiver<AudioCommand>,
    shared: &Mutex<Shared>,
    per_ms: usize,
    max_ring_samples: usize,
    // Fuer den Decoder, der hier lebt: Zielrate und Kanalzahl des Geraets.
    sample_rate: u32,
    channels: u16,
) {
    // Der Decoder lebt HIER, nicht beim Aufrufer, und wird beim ersten Paket
    // angelegt (das Geraet steht zu diesem Zeitpunkt schon).
    let mut decoder: Option<OpusDecoder> = None;
    let mut decoder_failed = false;
    while let Ok(cmd) = rx.recv() {
        // Dekodieren VOR der Sperre: auf dieselbe Sperre wartet der
        // Geraete-Callback, und ein Decode unter ihr wuerde ihn ausbremsen —
        // aus einem Bildruckler wuerde ein Tonaussetzer.
        let cmd = match cmd {
            AudioCommand::Packet(bytes) => {
                if decoder.is_none() && !decoder_failed {
                    match OpusDecoder::new(sample_rate, channels) {
                        Ok(d) => decoder = Some(d),
                        Err(e) => {
                            eprintln!("pulse-player: Opus-Decoder: {e:#} — bleibt stumm");
                            decoder_failed = true;
                        }
                    }
                }
                let Some(dec) = decoder.as_mut() else { continue };
                match dec.decode(&bytes) {
                    Ok(pcm) => AudioCommand::Pcm(pcm),
                    Err(e) => {
                        eprintln!("pulse-player: Opus-Decode: {e:#}");
                        continue;
                    }
                }
            }
            other => other,
        };
        let Ok(mut s) = shared.lock() else { break };
        match cmd {
            // Oben in fertiges PCM verwandelt — hier kann es nicht mehr
            // auftreten.
            AudioCommand::Packet(_) => {}
            AudioCommand::Pcm(samples) => {
                let angehaengt = samples.len();
                s.ring.extend(samples);
                // NACH dem Anhaengen kappen, nicht vorher: eine einzelne Charge
                // kann selbst groesser als die Ringgrenze sein, dann reichte das
                // Leeren des Alt-Rings nicht und die Grenze wurde dauerhaft
                // ueberschritten. Aelteste Daten weg — die sind ohnehin zu spaet.
                if s.ring.len() > max_ring_samples {
                    let excess = s.ring.len() - max_ring_samples;
                    s.ring.drain(..excess);
                    s.dropped += excess as u64;
                }
                s.zurueckfuehren(angehaengt);
            }
            AudioCommand::Volume(v) => s.volume = v,
            AudioCommand::OffsetMs(ms) => {
                // Positiv = Ton spaeter = mehr Vorlauf im Ring.
                // Nie ueber die Ringgroesse hinaus: der Callback gibt erst
                // aus, wenn der Zielfuellstand erreicht ist. Laege der ueber
                // dem, was der Ring haelt, bliebe es dauerhaft still.
                // Der Trim ist ein ZUSCHLAG auf den Sollwert, kein Ersatz.
                // Bis 2026-08-05 stand hier nur `ms`, und damit hiess der
                // Vorgabewert 0 "gar kein Puffer" — s. `RING_SOLL_MS`.
                s.target_fill = ((RING_SOLL_MS + ms.max(0) as usize) * per_ms)
                    .min(max_ring_samples / 2);
                if ms < 0 {
                    // Negativ = Ton frueher: vorhandenen Vorlauf kappen.
                    let n = ((-ms) as usize * per_ms).min(s.ring.len());
                    s.ring.drain(..n);
                }
            }
            AudioCommand::Stop => break,
        }
    }
}

/// Griff auf die laufende Ausgabe. Beim Fallenlassen endet der Thread.
pub struct AudioOutput {
    tx: std::sync::mpsc::Sender<AudioCommand>,
    shared: Arc<Mutex<Shared>>,
    pub sample_rate: u32,
    pub channels: u16,
}

/// Zaehlerstaende der Tonausgabe (s. [`AudioOutput::counters`]).
///
/// Benannte Felder und kein Tupel: es sind vier gleichartige Zahlen
/// hintereinander, und genau dort vertauscht irgendwann jemand zwei, ohne dass
/// es auffaellt (dieselbe Ueberlegung wie bei `session::Zeitmarken`).
#[derive(Debug, Default, Clone, Copy)]
pub struct AudioCounters {
    /// Wie oft dem Ausgabegeraet Daten fehlten.
    pub underruns: u64,
    /// Verworfene Samples (harte Ringgrenze und Rueckfuehrung zusammen).
    pub dropped: u64,
    /// Aktueller Fuellstand des Rings in Samples.
    pub buffered: usize,
    /// Grobkappungen der Rueckfuehrung (s. `audio::ringregelung`).
    pub resyncs: u64,
    /// Ob der Ausgabe-Thread noch laeuft.
    pub alive: bool,
}

/// Abtastrate von Opus. Der Codec kennt nur diese eine — alles andere
/// entsteht erst durch Umrechnen beim Ausgeben.
const OPUS_SAMPLE_RATE: u32 = 48_000;

impl AudioOutput {
    /// Oeffnet das Standard-Ausgabegeraet. Schlaegt das fehl, ist das kein
    /// Grund, die Sitzung zu beenden — der Aufrufer laeuft dann stumm weiter.
    pub fn new() -> Result<Self> {
        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .ok_or_else(|| anyhow!("kein Standard-Ausgabegeraet"))?;
        let default_config = device
            .default_output_config()
            .context("Standard-Ausgabeformat nicht abfragbar")?;
        // 48 kHz bevorzugen — Opus liefert IMMER 48 kHz.
        //
        // `default_output_config()` meldet unter ALSA gern 44100, unabhaengig
        // davon, was darunter wirklich laeuft. Am 2026-08-03 auf der
        // Dev-Maschine gemessen: PipeWire fuhr `clock.rate=48000` und liess mit
        // `allowed-rates=[48000]` gar nichts anderes zu, das Headset ebenfalls
        // 48000 — der Player waehlte trotzdem 44100. Der Ton wurde also von
        // 48000 auf 44100 heruntergerechnet und gleich darauf wieder hoch, mit
        // einem krummen Verhaeltnis in beide Richtungen. Hoerbar als Knacksen.
        //
        // Kann das Geraet 48 kHz, faellt beides ersatzlos weg (der Resampler
        // in `OpusStream` bleibt fuer Geraete, die es nicht koennen).
        let supported = device
            .supported_output_configs()
            .ok()
            .and_then(|mut ranges| {
                ranges.find(|r| {
                    // Kanalzahl MIT pruefen: die Geraeteliste enthaelt auch
                    // Mono-Varianten, und die stand hier zuerst — der Ton lief
                    // dadurch einkanalig (gemessen 2026-08-03: "48000 Hz,
                    // 1 Kanaele" statt 2). Rate zu treffen und dabei einen
                    // Kanal zu verlieren ist kein guter Tausch.
                    r.channels() == default_config.channels()
                        && r.sample_format() == default_config.sample_format()
                        && r.min_sample_rate() <= OPUS_SAMPLE_RATE
                        && OPUS_SAMPLE_RATE <= r.max_sample_rate()
                })
            })
            .map(|r| r.with_sample_rate(OPUS_SAMPLE_RATE))
            .unwrap_or(default_config);
        let sample_rate = supported.sample_rate();
        let channels = supported.channels();
        let config: cpal::StreamConfig = supported.into();

        // VOR dem Anlegen von `Shared`: der Sollfuellstand haengt daran, und ihn
        // erst spaeter zu setzen hiesse, dass die Wiedergabe bis zum ersten
        // `OffsetMs` ungeregelt liefe — also im Regelfall fuer immer, weil die
        // Oberflaeche den Trim nur schickt, wenn jemand ihn anfasst.
        let per_ms = (sample_rate as usize * channels as usize) / 1000;

        let shared = Arc::new(Mutex::new(Shared {
            // Volle Kapazitaet im Voraus: sonst allokiert der Fuetter-Thread
            // beim Wachsen des Rings, waehrend er die Sperre haelt, auf die der
            // Geraete-Callback wartet. Das ist die klassische
            // Prioritaetsumkehr und aeussert sich als Knacksen.
            ring: VecDeque::new(),
            volume: 1.0,
            target_fill: RING_SOLL_MS * per_ms,
            underruns: 0,
            dropped: 0,
            regelung: Ringregelung::default(),
            anlauf: true,
            alive: true,
        }));
        let max_ring_samples =
            MAX_RING_SECONDS * sample_rate as usize * channels as usize;
        let (tx, rx) = std::sync::mpsc::channel::<AudioCommand>();

        // Volle Kapazitaet im Voraus: sonst allokiert der Fuetter-Thread beim
        // Wachsen des Rings, waehrend er die Sperre haelt, auf die der
        // Geraete-Callback wartet — Prioritaetsumkehr, hoerbar als Knacksen.
        if let Ok(mut s) = shared.lock() {
            s.ring.reserve(max_ring_samples);
        }
        let cb_shared = Arc::clone(&shared);
        let thread_shared = Arc::clone(&shared);

        // Der Stream lebt auf diesem Thread und stirbt mit ihm.
        std::thread::Builder::new()
            .name("pulse-player-audio".into())
            .spawn(move || {
                let stream = device.build_output_stream(
                    &config,
                    move |out: &mut [f32], _: &cpal::OutputCallbackInfo| {
                        fill_output(&cb_shared, out);
                    },
                    |err| eprintln!("pulse-player: Audio-Stream: {err}"),
                    None,
                );
                let stream = match stream {
                    Ok(s) => s,
                    Err(e) => {
                        eprintln!("pulse-player: Ausgabestrom liess sich nicht bauen: {e}");
                        return;
                    }
                };
                if let Err(e) = stream.play() {
                    eprintln!("pulse-player: Ausgabe startet nicht: {e}");
                    return;
                }
                pump_commands(&rx, &thread_shared, per_ms, max_ring_samples, sample_rate, channels);
                // Egal warum die Schleife endet: ab hier kommt nichts mehr an.
                if let Ok(mut s) = thread_shared.lock() {
                    s.alive = false;
                }
            })
            .context("Audio-Thread liess sich nicht starten")?;

        Ok(Self { tx, shared, sample_rate, channels })
    }

    /// Rohes Opus-Paket zur Wiedergabe geben. Kehrt sofort zurueck — Dekodieren
    /// und Umrechnen passieren auf dem Ton-Thread (s. [`AudioCommand::Packet`]).
    pub fn push_packet(&self, packet: &[u8]) {
        if packet.is_empty() {
            return;
        }
        let _ = self.tx.send(AudioCommand::Packet(packet.to_vec()));
    }

    pub fn set_volume(&self, v: f32) {
        let _ = self.tx.send(AudioCommand::Volume(v.clamp(0.0, 4.0)));
    }

    pub fn set_offset_ms(&self, ms: i32) {
        let _ = self.tx.send(AudioCommand::OffsetMs(ms.clamp(-2000, 2000)));
    }

    /// Zaehlerstaende fuer die Statistik. Bei vergifteter Sperre gilt die
    /// Ausgabe als tot (`alive: false` aus [`AudioCounters::default`]) — dann
    /// stimmt nichts mehr, und das soll man sehen.
    pub fn counters(&self) -> AudioCounters {
        self.shared
            .lock()
            .map(|s| AudioCounters {
                underruns: s.underruns,
                dropped: s.dropped,
                buffered: s.ring.len(),
                resyncs: s.regelung.resyncs,
                alive: s.alive,
            })
            .unwrap_or_default()
    }
}

impl Drop for AudioOutput {
    fn drop(&mut self) {
        let _ = self.tx.send(AudioCommand::Stop);
    }
}

/// Opus-Dekoder samt Umrechnung auf das Format des Ausgabegeraets.
pub struct OpusDecoder {
    decoder: ffmpeg::decoder::Audio,
    resampler: Option<ffmpeg::software::resampling::Context>,
    out_rate: u32,
    out_channels: u16,
}

impl OpusDecoder {
    pub fn new(out_rate: u32, out_channels: u16) -> Result<Self> {
        ffmpeg::init().ok();
        let codec = ffmpeg::decoder::find_by_name("libopus")
            .or_else(|| ffmpeg::decoder::find_by_name("opus"))
            .ok_or_else(|| anyhow!("kein Opus-Decoder in diesem FFmpeg-Build"))?;

        let mut context = ffmpeg::codec::context::Context::new_with_codec(codec);
        // Opus ueber RTP ist immer 48 kHz; die Kanalzahl steht im TOC-Byte, der
        // Decoder braucht aber eine gesetzte Ausgangs-Konfiguration. ffmpeg-next
        // hat dafuer keinen sicheren Setter — deshalb direkt am Kontext.
        unsafe {
            let ptr = context.as_mut_ptr();
            (*ptr).sample_rate = 48_000;
            ffmpeg::ffi::av_channel_layout_default(&raw mut (*ptr).ch_layout, 2);
        }
        let decoder = context.decoder().audio().context("Opus-Decoder oeffnen")?;

        Ok(Self { decoder, resampler: None, out_rate, out_channels })
    }

    /// Dekodiert ein Opus-Paket und liefert verschraenkte f32-Samples in der
    /// Rate und Kanalzahl des Ausgabegeraets.
    pub fn decode(&mut self, packet: &[u8]) -> Result<Vec<f32>> {
        let pkt = ffmpeg::codec::packet::Packet::copy(packet);
        if let Err(e) = self.decoder.send_packet(&pkt) {
            // Ein kaputtes Paket nach einer Luecke darf den Ton nicht beenden.
            eprintln!("pulse-player: Opus send_packet: {e}");
            return Ok(Vec::new());
        }

        let mut out = Vec::new();
        let mut frame = ffmpeg::util::frame::audio::Audio::empty();
        while self.decoder.receive_frame(&mut frame).is_ok() {
            let converted = self.resample_for_device(&frame)?;
            out.extend_from_slice(&converted);
        }
        Ok(out)
    }

    fn resample_for_device(&mut self, frame: &ffmpeg::util::frame::audio::Audio) -> Result<Vec<f32>> {
        use ffmpeg::util::format::sample::{Sample, Type};

        let target_layout =
            ffmpeg::util::channel_layout::ChannelLayout::default(self.out_channels.into());
        let target_format = Sample::F32(Type::Packed);

        if self.resampler.is_none() {
            self.resampler = Some(
                ffmpeg::software::resampling::Context::get(
                    frame.format(),
                    frame.channel_layout(),
                    frame.rate(),
                    target_format,
                    target_layout,
                    self.out_rate,
                )
                .context("Resampler")?,
            );
        }
        let resampler = self.resampler.as_mut().expect("gerade gesetzt");

        let mut converted = ffmpeg::util::frame::audio::Audio::empty();
        resampler.run(frame, &mut converted).context("Resampling")?;

        // NICHT `plane::<f32>(0)` benutzen: das liefert eine Slice der Laenge
        // `samples()` — also nur die FRAME-Anzahl, ohne Kanalfaktor (belegt in
        // ffmpeg-next `util/frame/audio.rs`, `from_raw_parts(.., self.samples())`).
        // Bei verschraenktem Stereo liegen dort aber `samples * 2` Werte. Der
        // frueher hier gerechnete Index `samples() * channels` lief damit ueber
        // das Slice-Ende und riss den Audio-Thread mit einem Panic weg — bei
        // jedem Geraet ausser Mono, also praktisch immer.
        //
        // `data(0)` traegt die echte Puffergroesse (`linesize[0]`).
        let frames = converted.samples();
        let wanted = frames * self.out_channels as usize;
        let bytes = converted.data(0);
        let needed = wanted * std::mem::size_of::<f32>();
        if bytes.len() < needed {
            bail!("Audio-Ebene zu kurz: {} < {needed} Bytes", bytes.len());
        }
        // FFmpegs `AV_SAMPLE_FMT_FLT` ist in der Bytereihenfolge der Maschine.
        Ok(bytes[..needed]
            .chunks_exact(std::mem::size_of::<f32>())
            .map(|c| f32::from_ne_bytes([c[0], c[1], c[2], c[3]]))
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ein frisches `Shared` mit dem gewuenschten Zielfuellstand, Ring leer.
    fn shared_mit(target_fill: usize) -> Mutex<Shared> {
        Mutex::new(Shared {
            ring: VecDeque::new(),
            volume: 1.0,
            target_fill,
            underruns: 0,
            dropped: 0,
            regelung: Ringregelung::default(),
            anlauf: true,
            alive: true,
        })
    }

    /// Ein `Shared` wie zur Laufzeit: Sollwert gesetzt, Ring leer.
    fn shared_mit_soll(per_ms: usize) -> Mutex<Shared> {
        shared_mit(RING_SOLL_MS * per_ms)
    }

    /// 48 kHz stereo — dieselbe Rechnung wie zur Laufzeit.
    const TEST_PER_MS: usize = 96;
    const TEST_MAX_RING: usize = MAX_RING_SECONDS * 48_000 * 2;

    /// **Der Fehler vom 2026-08-07.** Die Anlaufsperre war als Startbedingung
    /// gemeint, wirkte aber bei jedem Geraete-Aufruf: ein Ring unter dem
    /// Sollwert hiess Stille, bis die vollen 60 ms wieder beisammen waren. Aus
    /// einer Delle wurde damit ein Aussetzer von rund sechs Aufrufen — und
    /// gezaehlt wurde er nirgends.
    #[test]
    fn eine_delle_unter_dem_sollwert_haelt_die_ausgabe_nicht_an() {
        let shared = shared_mit_soll(TEST_PER_MS);
        let soll = RING_SOLL_MS * TEST_PER_MS;
        shared.lock().unwrap().ring.extend(vec![0.5f32; soll]);

        // Anlauf: mit vollem Sollwert geht die Ausgabe los.
        let mut out = vec![0.0f32; 32];
        fill_output(&shared, &mut out);
        assert!(out.iter().all(|v| *v == 0.5), "nach dem Anlauf muss Ton kommen");

        // Unter den Sollwert fallen lassen, ohne leerzulaufen.
        {
            let mut s = shared.lock().unwrap();
            s.ring.clear();
            s.ring.extend(vec![0.25f32; 64]);
            s.underruns = 0;
        }
        let mut out = vec![0.0f32; 32];
        fill_output(&shared, &mut out);
        assert!(
            out.iter().all(|v| *v == 0.25),
            "eine Delle unter dem Sollwert darf die Ausgabe nicht anhalten"
        );
        assert_eq!(shared.lock().unwrap().underruns, 0, "und ist kein Unterlauf");
    }

    /// Die Gegenprobe: laeuft der Ring wirklich leer, wird wieder vorgefuellt —
    /// und JEDE dabei ausgegebene Stille zaehlt als Unterlauf. Ohne das misst
    /// die Kennzahl den haeufigsten Fall nicht mit.
    #[test]
    fn ein_leergelaufener_ring_fuellt_wieder_vor_und_zaehlt_die_stille() {
        let shared = shared_mit_soll(TEST_PER_MS);
        let soll = RING_SOLL_MS * TEST_PER_MS;
        shared.lock().unwrap().ring.extend(vec![0.5f32; soll]);

        // Mehr verlangt, als da ist: der Ring laeuft mitten im Aufruf leer.
        let mut out = vec![0.0f32; soll + 16];
        fill_output(&shared, &mut out);
        {
            let s = shared.lock().unwrap();
            assert_eq!(s.underruns, 1, "der Unterlauf gehoert gezaehlt");
            assert!(s.anlauf, "nach dem Leerlaufen wird wieder vorgefuellt");
        }

        // Zu wenig Nachschub: es bleibt still, und die Stille wird gezaehlt.
        shared.lock().unwrap().ring.extend(vec![0.5f32; 32]);
        let mut out = vec![0.0f32; 32];
        fill_output(&shared, &mut out);
        assert!(out.iter().all(|v| *v == 0.0), "unter dem Sollwert bleibt es beim Vorfuellen");
        assert_eq!(shared.lock().unwrap().underruns, 2);
    }

    /// **Der Fall, um den es geht.** Ein Nachhol-Schwall nach einer
    /// Lieferpause schiebt den Ring weit ueber den Sollwert. Ohne Grobkappung
    /// bliebe er dort bis Sitzungsende — am 2026-08-05 gemessen: 5980 ms, ueber
    /// 30 s hinweg, ohne Erholung und ohne Meldung.
    ///
    /// Als Test und nicht als Lastlauf, weil ein Lastlauf den Fall nur
    /// zufaellig trifft: der Versuch, ihn ueber CPU-Last zu erzwingen, blieb
    /// am 2026-08-05 folgenlos (Ring 87-118 ms, keine Kappung).
    #[test]
    fn grobkappung_holt_den_ring_zurueck() {
        let shared = shared_mit_soll(TEST_PER_MS);
        let soll = RING_SOLL_MS * TEST_PER_MS;
        let (tx, rx) = std::sync::mpsc::channel();
        // Vier Sollwerte auf einmal — ueber der Kappschwelle (Faktor 3).
        tx.send(AudioCommand::Pcm(vec![0.0; soll * 4])).unwrap();
        tx.send(AudioCommand::Stop).unwrap();
        pump_commands(&rx, &shared, TEST_PER_MS, TEST_MAX_RING, 48_000, 2);
        let s = shared.lock().unwrap();
        assert_eq!(s.ring.len(), soll, "Ring muss auf den Sollwert zurueck");
        assert_eq!(s.regelung.resyncs, 1, "die Kappung gehoert gezaehlt — sie ist hoerbar");
    }

    /// Zwei Schwaelle kurz hintereinander duerfen nicht zweimal schneiden.
    /// Ohne Sperrfrist wuerde jede Stoerungsserie zur Schnittserie.
    #[test]
    fn nach_einer_kappung_gilt_die_sperrfrist() {
        let shared = shared_mit_soll(TEST_PER_MS);
        let soll = RING_SOLL_MS * TEST_PER_MS;
        let (tx, rx) = std::sync::mpsc::channel();
        tx.send(AudioCommand::Pcm(vec![0.0; soll * 4])).unwrap();
        tx.send(AudioCommand::Pcm(vec![0.0; soll * 4])).unwrap();
        tx.send(AudioCommand::Stop).unwrap();
        pump_commands(&rx, &shared, TEST_PER_MS, TEST_MAX_RING, 48_000, 2);
        let s = shared.lock().unwrap();
        assert_eq!(s.regelung.resyncs, 1, "die zweite Kappung muss die Sperrfrist abfangen");
    }

    /// Unter dem Sollwert wird NICHT abgebaut — sonst arbeitete die Regelung
    /// gegen den normalen Jitter und erzeugte die Unterlaeufe, die sie
    /// verhindern soll.
    #[test]
    fn unter_dem_sollwert_bleibt_alles_liegen() {
        let shared = shared_mit_soll(TEST_PER_MS);
        let soll = RING_SOLL_MS * TEST_PER_MS;
        let (tx, rx) = std::sync::mpsc::channel();
        tx.send(AudioCommand::Pcm(vec![0.0; soll / 2])).unwrap();
        tx.send(AudioCommand::Stop).unwrap();
        pump_commands(&rx, &shared, TEST_PER_MS, TEST_MAX_RING, 48_000, 2);
        let s = shared.lock().unwrap();
        assert_eq!(s.ring.len(), soll / 2, "nichts darf verworfen werden");
        assert_eq!(s.dropped, 0);
        assert_eq!(s.regelung.resyncs, 0);
    }

    /// Der Nutzer-Trim ist ein ZUSCHLAG auf den Sollwert, kein Ersatz. Bis
    /// 2026-08-05 hiess `av_offset_ms = 0` "gar kein Puffer" — der Kern des
    /// Fehlers.
    #[test]
    fn trim_addiert_sich_auf_den_sollwert() {
        let shared = shared_mit_soll(TEST_PER_MS);
        let (tx, rx) = std::sync::mpsc::channel();
        tx.send(AudioCommand::OffsetMs(40)).unwrap();
        tx.send(AudioCommand::Stop).unwrap();
        pump_commands(&rx, &shared, TEST_PER_MS, TEST_MAX_RING, 48_000, 2);
        let s = shared.lock().unwrap();
        assert_eq!(
            s.target_fill,
            (RING_SOLL_MS + 40) * TEST_PER_MS,
            "Trim muss auf den Sollwert addieren"
        );
    }

    /// Der Opus-Decoder muss auf jeder Maschine oeffnen — sonst waere der
    /// Tonpfad von der FFmpeg-Konfiguration abhaengig, ohne es zu merken.
    #[test]
    fn opus_decoder_laesst_sich_oeffnen() {
        let d = OpusDecoder::new(48_000, 2);
        assert!(d.is_ok(), "Opus-Decoder fehlt: {:?}", d.err());
    }

    /// Muell darf nicht panisch werden — nach einer Luecke kommen kaputte Pakete.
    #[test]
    fn kaputtes_paket_beendet_den_decoder_nicht() {
        let mut d = OpusDecoder::new(48_000, 2).expect("Decoder");
        let out = d.decode(&[0xFF, 0x00, 0x13, 0x37]);
        assert!(out.is_ok(), "kaputtes Paket darf keinen Fehler werfen");
    }

    /// Liest die rohen Opus-Pakete aus einer Ogg-Opus-Datei (ein Ogg-Paket =
    /// ein Opus-Paket, ausser den zwei Kopf-Paketen). Erzeugung z.B.:
    ///   ffmpeg -f lavfi -i "sine=frequency=440:duration=2:sample_rate=48000" \
    ///     -ac 2 -c:a libopus -b:a 96k -f ogg ton_stereo.opus
    fn opus_packets_from_ogg(path: &str) -> Vec<Vec<u8>> {
        ffmpeg::init().ok();
        let mut ictx = ffmpeg::format::input(path).expect("Ogg-Datei oeffnen");
        let audio_idx = ictx
            .streams()
            .best(ffmpeg::media::Type::Audio)
            .expect("Audio-Stream in der Ogg-Datei")
            .index();
        ictx.packets()
            .filter(|(stream, _)| stream.index() == audio_idx)
            .filter_map(|(_, packet)| packet.data().map(|d| d.to_vec()))
            .collect()
    }

    /// RMS eines interleaved f32-Puffers (alle Kanaele zusammen).
    fn rms(samples: &[f32]) -> f32 {
        if samples.is_empty() {
            return 0.0;
        }
        (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
    }

    /// BEFUND (Bug, nicht behoben): `resample_for_device()` liefert bei jeder
    /// Zielkanalzahl > 1 einen Panic statt Samples. `converted.plane::<f32>(0)`
    /// hat laut ffmpeg-next-Doku/-Quelle IMMER Laenge `converted.samples()`
    /// (Anzahl Frames, nicht Frames*Kanaele) — auch fuer gepackte
    /// Multi-Kanal-Formate. Der Code rechnet aber
    /// `samples = converted.samples() * out_channels` und slice't
    /// `plane[..samples]`, was fuer out_channels >= 2 IMMER ausserhalb der
    /// von plane() zurueckgegebenen Slice liegt.
    ///
    /// Reproduktion (mit echten, per libopus erzeugten Stereo-Paketen):
    ///   thread panicked at src/audio.rs:309:37:
    ///   range end index 1920 out of range for slice of length 960
    /// (960 = converted.samples(), 1920 = 960*2 = der falsch berechnete Index)
    ///
    /// Auswirkung: JEDER Stereo- (oder Mehrkanal-)Opus-Frame crasht den
    /// Ausgabe-Thread beim ersten Paket. Der Tonpfad ist fuer praktisch jedes
    /// reale Ausgabegeraet (fast nie Mono) vollstaendig kaputt — nicht nur
    /// falsch, sondern abstuerzend. Nur out_channels=1 (Mono-Geraet) geht
    /// gut, weil dort samples == converted.samples() ist und die Slice genau
    /// passt.
    ///
    /// Env: PULSE_PLAYER_OPUS_STEREO_FIXTURE = Pfad zur .opus/.ogg-Datei
    /// (2s, 440 Hz Sinus, Stereo, 48 kHz — siehe opus_packets_from_ogg()).
    #[test]
    fn echtes_stereo_opus_dekodiert_korrekt() {
        let Ok(fixture) = std::env::var("PULSE_PLAYER_OPUS_STEREO_FIXTURE") else {
            eprintln!("PULSE_PLAYER_OPUS_STEREO_FIXTURE nicht gesetzt — uebersprungen");
            return;
        };
        let packets = opus_packets_from_ogg(&fixture);
        assert!(!packets.is_empty(), "keine Opus-Pakete in der Fixture");

        let mut decoder = OpusDecoder::new(48_000, 2).expect("Decoder");
        let mut pcm = Vec::new();
        for p in &packets {
            pcm.extend(decoder.decode(p).expect("Decode echter Pakete"));
        }

        assert!(!pcm.is_empty(), "kein Ton dekodiert");
        assert_eq!(pcm.len() % 2, 0, "verschraenktes Stereo braucht gerade Anzahl");
        assert!(pcm.iter().all(|v| v.is_finite()), "NaN oder unendlich im Signal");

        // Inhaltlich: ein 440-Hz-Sinus ist weder stumm noch uebersteuert.
        let rms = (pcm.iter().map(|v| f64::from(*v) * f64::from(*v)).sum::<f64>()
            / pcm.len() as f64)
            .sqrt();
        assert!(rms > 0.05, "Signal praktisch stumm (RMS {rms:.4})");
        assert!(rms < 0.9, "Signal uebersteuert (RMS {rms:.4})");

        // Beide Kanaele muessen Signal tragen — waere die Verschraenkung falsch,
        // laege der Ton nur auf einer Seite oder die Haelfte waere null.
        let links: Vec<f32> = pcm.iter().step_by(2).copied().collect();
        let rechts: Vec<f32> = pcm.iter().skip(1).step_by(2).copied().collect();
        let energie = |c: &[f32]| c.iter().map(|v| f64::from(*v).abs()).sum::<f64>();
        assert!(energie(&links) > 0.0 && energie(&rechts) > 0.0, "ein Kanal ist stumm");
    }

    /// Gleiche Prüfung fuer Mono-Ausgabe (out_channels=1), damit die
    /// plane()-Indizierung auch fuer den Nicht-Stereo-Fall belegt ist.
    ///
    /// Env: PULSE_PLAYER_OPUS_MONO_FIXTURE = Pfad zu einer Mono-Opus-Datei.
    #[test]
    fn echtes_mono_opus_dekodiert_ohne_panik() {
        let Ok(fixture) = std::env::var("PULSE_PLAYER_OPUS_MONO_FIXTURE") else {
            eprintln!("PULSE_PLAYER_OPUS_MONO_FIXTURE nicht gesetzt — uebersprungen");
            return;
        };
        let packets = opus_packets_from_ogg(&fixture);
        assert!(!packets.is_empty(), "keine Opus-Pakete in der Fixture");

        let mut decoder = OpusDecoder::new(48_000, 1).expect("Decoder");
        let mut out = Vec::new();
        for p in &packets {
            let pcm = decoder.decode(p).expect("Decode darf bei echten Paketen nicht fehlschlagen");
            out.extend(pcm);
        }
        let level = rms(&out);
        assert!(level > 0.01, "Ton ist praktisch stumm, RMS={level}");
    }

    /// Regression, systematisch fuer mehrere Zielkanalzahlen: frueher stuerzte
    /// jede Ausgabe ausser Mono ab, weil `plane::<f32>(0)` nur `samples()`
    /// Elemente liefert (Frames ohne Kanalfaktor) und der Code auf
    /// `samples * channels` schnitt. Nur out_channels=1 passte zufaellig.
    ///
    /// Env: PULSE_PLAYER_OPUS_STEREO_FIXTURE wie oben.
    #[test]
    fn jede_zielkanalzahl_liefert_brauchbare_samples() {
        let Ok(fixture) = std::env::var("PULSE_PLAYER_OPUS_STEREO_FIXTURE") else {
            eprintln!("PULSE_PLAYER_OPUS_STEREO_FIXTURE nicht gesetzt — uebersprungen");
            return;
        };
        let packets = opus_packets_from_ogg(&fixture);
        assert!(!packets.is_empty(), "keine Opus-Pakete in der Fixture");

        for out_channels in [1u16, 2, 4, 6] {
            let mut decoder = OpusDecoder::new(48_000, out_channels).expect("Decoder");
            let pcm = decoder
                .decode(&packets[0])
                .unwrap_or_else(|e| panic!("out_channels={out_channels}: {e:#}"));
            assert!(!pcm.is_empty(), "out_channels={out_channels}: keine Samples");
            assert_eq!(
                pcm.len() % out_channels as usize,
                0,
                "out_channels={out_channels}: {} Werte sind kein Vielfaches der Kanalzahl",
                pcm.len()
            );
            assert!(
                pcm.iter().all(|v| v.is_finite() && v.abs() <= 1.5),
                "out_channels={out_channels}: Werte ausserhalb des Wertebereichs"
            );
        }
    }

    /// Testet die Kanalzahl-Wechsel-Frage aus dem Auftrag isoliert von Bug 1
    /// oben: out_channels bleibt bei 1 (Mono-Ziel, dort crasht plane() nicht),
    /// aber die QUELLE wechselt mitten im Stream von echten Mono- auf echte
    /// Stereo-Opus-Pakete (zwei verschiedene, echte Encoder-Sessions). Der
    /// Resampler in resample_for_device() wird nur beim ERSTEN Frame gebaut
    /// und danach nie wieder geprueft — das hier prueft empirisch, ob ein
    /// spaeterer Formatwechsel der QUELLE damit sauber bleibt oder crasht.
    ///
    /// Env: PULSE_PLAYER_OPUS_STEREO_FIXTURE + PULSE_PLAYER_OPUS_MONO_FIXTURE.
    #[test]
    fn quellkanalzahl_wechsel_mitten_im_stream_bei_fixem_mono_ziel() {
        let (Ok(stereo_fixture), Ok(mono_fixture)) = (
            std::env::var("PULSE_PLAYER_OPUS_STEREO_FIXTURE"),
            std::env::var("PULSE_PLAYER_OPUS_MONO_FIXTURE"),
        ) else {
            eprintln!("Fixtures nicht gesetzt — uebersprungen");
            return;
        };
        let stereo_packets = opus_packets_from_ogg(&stereo_fixture);
        let mono_packets = opus_packets_from_ogg(&mono_fixture);
        assert!(!stereo_packets.is_empty() && !mono_packets.is_empty());

        // out_channels=1: Ziel bleibt Mono, damit Bug 1 (plane()-Index) hier
        // nicht zwischenfunkt. Es geht nur um den Resampler-Cache bei
        // wechselnder QUELL-Kanalzahl.
        let mut decoder = OpusDecoder::new(48_000, 1).expect("Decoder");
        let mut panicked = false;
        let mut decoded_before_switch = Vec::new();
        let mut decoded_after_switch = Vec::new();

        // Erst Mono-Pakete, damit der Resampler mit Mono-Eingang angelegt wird.
        for p in mono_packets.iter().take(10) {
            if let Ok(pcm) = decoder.decode(p) {
                decoded_before_switch.extend(pcm);
            }
        }

        // Jetzt Pakete aus einer FREMDEN Stereo-Session einspeisen — reale
        // Audioqualitaet ist irrelevant (der Decoder-Zustand passt ohnehin
        // nicht zur fremden Session), es geht nur darum, ob der Code mit
        // einem Kanalzahl-Wechsel der Quelle sauber umgeht statt zu crashen
        // oder die falsche Menge Speicher zu lesen.
        for p in stereo_packets.iter().take(10) {
            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| decoder.decode(p))) {
                Ok(Ok(pcm)) => decoded_after_switch.extend(pcm),
                Ok(Err(e)) => eprintln!("decode() Fehler nach Kanalzahlwechsel: {e:?}"),
                Err(_) => {
                    panicked = true;
                    break;
                }
            }
        }

        eprintln!(
            "Quellkanalzahl-Wechsel (Ziel=Mono): decoded_before={} (RMS {:.4}), \
             panicked={panicked}, decoded_after={} (RMS {:.4})",
            decoded_before_switch.len(),
            rms(&decoded_before_switch),
            decoded_after_switch.len(),
            rms(&decoded_after_switch),
        );
        assert!(
            !panicked,
            "decode() panickt, wenn eine spaetere Quelle eine andere Kanalzahl \
             hat als beim ersten Resampler-Aufbau — auch bei festem Mono-Ziel. \
             Reproduktion: siehe Testkoerper (Mono-Fixture, dann Stereo-Fixture, \
             derselbe OpusDecoder)."
        );
        // Kein Crash ist nicht dasselbe wie richtiges Audio — zumindest darf
        // es nach dem Wechsel nicht komplett stumm/NaN sein (Anzeichen fuer
        // eine intern voellig falsch interpretierte Ebene).
        let level_after = rms(&decoded_after_switch);
        assert!(
            level_after.is_finite() && level_after > 0.0,
            "nach dem Quellkanalzahl-Wechsel kommt kein plausibles Signal mehr \
             heraus (RMS={level_after}) — deutet auf falsch interpretierte \
             Kanaldaten hin, auch ohne Absturz"
        );
    }

    /// Regression: ein einzelner PCM-Push kann selbst groesser sein als die
    /// Ringgrenze. Wurde vor dem Anhaengen gekappt, reichte das Leeren des
    /// Alt-Rings nicht und die Grenze blieb dauerhaft ueberschritten.
    ///
    /// Ursache in pump_commands() (AudioCommand::Pcm-Zweig):
    ///   let drop_n = (total - max_ring_samples).min(s.ring.len());
    ///   s.ring.drain(..drop_n);
    ///   s.ring.extend(samples);
    /// `drop_n` ist auf `s.ring.len()` gedeckelt — es kann also nie mehr
    /// entfernt werden, als VOR dem Push schon im Ring lag. Ist die neue
    /// Charge (`samples.len()`) allein schon groesser als max_ring_samples,
    /// reicht das Leeren des kompletten Alt-Rings nicht aus: `extend(samples)`
    /// haengt danach trotzdem die volle, ungekuerzte neue Charge an, und der
    /// Ring landet bei `samples.len()` — weit ueber max_ring_samples.
    ///
    /// Das widerspricht dem eigenen Kommentar auf MAX_RING_SECONDS
    /// ("dann lieber verwerfen als Speicher fressen"): fuer diesen Fall
    /// gilt die Speichergrenze nicht. Ob das in der Praxis erreichbar ist,
    /// haengt daran, ob push() je mit einer einzelnen, ungewoehnlich grossen
    /// Charge aufgerufen wird (z.B. Nachhol-Burst nach einer Pause im
    /// aufrufenden Code) — hier bewusst mit kleinen Testzahlen belegt, damit
    /// die Mechanik unabhaengig von realen Groessen sichtbar ist.
    #[test]
    fn grosser_einzelner_push_haelt_die_ringgrenze_ein() {
        // `target_fill: 0` ist hier Absicht: dieser Test prueft NUR die harte
        // Ringgrenze. Mit Sollwert liefe zusaetzlich die Rueckfuehrung an und
        // vermischte zwei Mechaniken in einer Zusicherung.
        let shared = Arc::new(shared_mit(0));
        let (tx, rx) = std::sync::mpsc::channel::<AudioCommand>();
        let max_ring_samples = 100usize;
        let per_ms = 10usize;

        let thread_shared = Arc::clone(&shared);
        let handle = std::thread::spawn(move || {
            // Rate und Kanalzahl sind hier belanglos — der Test schickt fertiges
            // PCM, der Decoder wird nie angelegt.
            pump_commands(&rx, &thread_shared, per_ms, max_ring_samples, 48_000, 2);
        });

        // Ein einzelner Push, zehnmal groesser als der erlaubte Ring.
        tx.send(AudioCommand::Pcm(vec![1.0; 1000])).unwrap();
        tx.send(AudioCommand::Stop).unwrap();
        handle.join().unwrap();

        let len = shared.lock().unwrap().ring.len();
        assert!(
            len <= max_ring_samples,
            "Ring haelt {len} Samples, erlaubt sind {max_ring_samples}"
        );
    }

    /// Rechnet target_fill vs. max_ring_samples fuer die Grenzwerte von
    /// av_offset_ms (0..=2000, per Clamp in set_offset_ms) nach, statt es
    /// nur zu behaupten.
    #[test]
    fn target_fill_bleibt_innerhalb_der_ringgrenze() {
        for (sample_rate, channels) in [(48_000u32, 2u16), (44_100, 2), (48_000, 6), (96_000, 8)] {
            let max_ring_samples = MAX_RING_SECONDS * sample_rate as usize * channels as usize;
            let per_ms = (sample_rate as usize * channels as usize) / 1000;
            for ms in [0i32, 1, 500, 2000] {
                // Dieselbe Rechnung wie in `pump_commands` — seit 2026-08-05
                // MIT dem Sollwert, der Trim ist nur noch ein Zuschlag. Ohne
                // ihn hier mitzuziehen, prueft der Test eine Formel nach, die
                // es nicht mehr gibt.
                let target_fill =
                    ((RING_SOLL_MS + ms.max(0) as usize) * per_ms).min(max_ring_samples / 2);
                // Erreichbar sein muss er: der Callback startet erst, wenn
                // ring.len() >= target_fill, und der Ring wird bei
                // max_ring_samples gekappt.
                assert!(
                    target_fill <= max_ring_samples,
                    "rate={sample_rate} ch={channels} ms={ms}: target_fill={target_fill} \
                     > max_ring_samples={max_ring_samples} — waere nie erreichbar"
                );
            }
        }
    }
}
