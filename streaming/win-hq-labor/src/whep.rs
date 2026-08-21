//! Ein Zuschauer, der wirklich zusieht — empfängt, setzt zusammen, **dekodiert**
//! und rechnet nach.
//!
//! **Zwei Voraussetzungen dieses Messwerks sind weggefallen** (Stand
//! 2026-08-21), und beides steht hier, weil ein Lauf sonst plausibel aussieht
//! und nichts beantwortet:
//!
//! 1. **Der Vollbild-Nachweis ist gegenstandslos.** Die Zählung „wie viele der
//!    ankommenden Bilder sind Vollbilder" war der Beleg dafür, dass
//!    Intra-Refresh läuft. Die Betriebsart ist am 2026-08-21 aus Pulse
//!    entfernt; die Zahl ist heute nur noch der GOP-Takt des Senders.
//! 2. **Die Gegenstelle ist seit dem 2026-08-12 gestoppt.** Der Hetzner-
//!    Messstand trägt den gemeinsamen Remote-Dev-Stack, ein Lauf dagegen endet
//!    in HTTP 401 (Rückholanleitung auf dem Server,
//!    `~/messstand-gestoppt-2026-08-12.txt`).
//!
//! **Was weiter trägt, und deshalb bleibt die Datei unangetastet:** die
//! Erholungs-Messung nach Verlust, der Ton und die Frage, ob ein angefordertes
//! Vollbild wirklich ankommt. Das misst ein Decoder, und keine dieser drei
//! Fragen hängt an der Betriebsart.
//!
//! **Warum dekodieren.** Bis hierher war belegt: die Anforderung eines
//! Zuschauers erreicht den Encoder, und der erzeugt ein Vollbild. Was damit
//! NICHT belegt war, ist die Frage, um die es eigentlich geht — kommt der
//! Zuschauer nach einem Verlust **wieder ins Bild**, und wie lange dauert das?
//! Diese Frage beantwortet nur ein Decoder. Ein Zähler über ankommende Pakete
//! beantwortet sie nicht: Pakete kommen auch dann weiter an, wenn das Bild seit
//! zehn Sekunden steht.
//!
//! **Was gemessen wird**, und zwar in Millisekunden statt in Eindrücken:
//!
//! * wie viele Zeitabschnitte der Decoder wirklich zu einem Bild macht,
//! * wie lange nach einem Verlust **kein** Bild mehr herauskommt,
//! * und ob dieser Abstand kleiner wird, wenn der Zuschauer ein Vollbild
//!   anfordert — das ist der Nutzen des Rückkanals, als Zahl.
//!
//! Der Verlust wird dabei **selbst erzeugt** (`verlust_ab`/`verlust_pakete`),
//! nicht abgewartet. Anders wäre die Messung nicht wiederholbar: man wüsste nie,
//! ob gerade etwas verlorenging und wie viel.
//!
//! Es gibt kein Fenster und keine Wiedergabe. Das ist Absicht — ein Messwerk,
//! das nebenbei anzeigt, misst irgendwann die Anzeige mit.
//!
//! Der Decoder selbst und das Prüfen einer Mitschrift ohne Netz liegen in
//! [`dekoder`].

mod dekoder;
mod entpacken;
mod messwerk;
mod stoerung;
mod ton;
mod tonurteil;

pub use dekoder::pruefe_datei;
pub use tonurteil::TonErgebnis;
use messwerk::Messwerk;
use ton::Tonwerk;

/// Länge eines Opus-Pakets in Millisekunden — **die Regel des Senders**, nicht
/// eine eigene Zahl (`PULSE_OPUS_FRAME_MS`, Vorgabe 5). Sender und Messwerk
/// laufen auf derselben Maschine und lesen damit dieselbe Einstellung; eine
/// Kopie der Zahl hier liefe genau dann auseinander, wenn jemand am Sender
/// dreht — und der Ton-Versatz sähe dann nach einem Fehler aus, wo nur die
/// Erwartung falsch war.
fn ton_paket_ms() -> u64 {
    pulse_win_hq_sidecar::encode::audio::opus_frame_ms() as u64
}

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use webrtc::api::APIBuilder;
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::setting_engine::SettingEngine;
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::rtp_transceiver::RTCRtpTransceiverInit;
use webrtc::rtp_transceiver::rtp_codec::RTPCodecType;
use webrtc::rtp_transceiver::rtp_transceiver_direction::RTCRtpTransceiverDirection;

use rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;

/// Wie der Lauf aussehen soll.
pub struct Auftrag {
    pub url: String,
    pub sekunden: u64,
    /// Ab dieser Sekunde werden Pakete verworfen (Verlust erzeugen).
    pub verlust_ab: Option<u64>,
    /// Wie viele Pakete am Stück. Ein Stoß trifft ein Bild sicher; einzelne
    /// verstreute Verluste treffen oft nur Füllung.
    pub verlust_pakete: u64,
    /// Fordert dieser Zuschauer beim Einsteigen ein Vollbild an?
    ///
    /// **Bei Intra-Refresh ist das keine Kür, sondern Pflicht**: dort gibt es
    /// nach dem Start kein Vollbild mehr, an dem jemand anfangen könnte. Ein
    /// Zuschauer, der nicht fragt, bleibt für immer schwarz — beim regulären
    /// Verfahren dagegen ist er nach höchstens zwei Sekunden im Bild, ohne
    /// etwas zu tun. Am 2026-08-02 über den Messstand belegt: 0 Bilder gegen
    /// 401 bei sonst gleichem Lauf.
    pub fordert_beim_einstieg: bool,

    /// Und nach einem Verlust noch einmal?
    ///
    /// **Getrennt vom Einstieg, weil sonst genau die Frage unmessbar wäre**,
    /// um die es bei der Erholung geht. Ein Zuschauer ohne Einstiegs-Anforderung
    /// hat auf einem Intra-Refresh-Strom nie ein Bild — der „Verlust" hat dann
    /// nichts, was er zerstören könnte, und die Lücke danach ist keine Zahl,
    /// sondern eine Tautologie. Zu messen ist: beide sind im Bild, beide
    /// verlieren, und nur einer fragt nach.
    pub fordert_nach_verlust: bool,
}

/// Was dabei herauskam.
/// `Debug` bleibt: das ist das Ergebnis eines Messwerks, und wer es weiter
/// verarbeitet, will es notfalls roh sehen können. `Default` gibt es nicht —
/// ein Ergebnis ohne Messung wäre eine Zahlenreihe, die aussieht wie ein Lauf,
/// der nichts empfangen hat.
#[derive(Debug)]
pub struct Ergebnis {
    pub pakete: u64,
    /// Zeitabschnitte, die der Entpacker vollständig zusammenbekommen hat.
    pub abschnitte: u64,
    /// Abschnitte, die wegen einer Lücke verworfen wurden.
    pub verworfen: u64,
    /// Bilder, die der Decoder **ohne Beanstandung** ausgegeben hat.
    pub bilder: u64,
    /// Davon Vollbilder. **Das ist der Nachweis für Intra-Refresh**, am
    /// Zuschauer statt am Log des Senders: mit Intra-Refresh darf im ganzen
    /// Lauf höchstens eines kommen (das auf die Einstiegs-Anforderung), ohne
    /// sind es beim Zwei-Sekunden-Takt viele.
    pub vollbilder: u64,
    /// Bilder, die herauskamen, zu denen der Decoder aber Fehler gemeldet hat —
    /// sichtbar, aber falsch.
    ///
    /// **Bei dav1d bleibt das 0**, und das ist kein Fehler des Messwerks: der
    /// Decoder gibt kein falsches Bild aus, sondern gar keines. Der Schaden
    /// zeigt sich deshalb nicht hier, sondern in
    /// [`rate_nach`](Self::rate_nach).
    pub beschaedigt: u64,
    /// Zeitabschnitte, die der Decoder abgelehnt hat.
    pub decoder_fehler: u64,
    /// Millisekunden vom **Ende** des erzeugten Verlusts bis zum ersten Bild
    /// danach.
    ///
    /// **Alleine wertlos**, und das war die Falle: ein einzelnes Bild, das
    /// zufällig ohne die verlorenen Referenzen auskommt, setzt diese Zahl auf
    /// wenige Dutzend Millisekunden — auch wenn danach zehn Sekunden nichts
    /// mehr kommt. Am 2026-08-02 stand hier 67 ms für einen Zuschauer, der ab
    /// dem Verlust praktisch stand. Erst zusammen mit
    /// [`rate_nach`](Self::rate_nach) sagt sie etwas.
    pub luecke_ms: Option<u64>,
    /// Bilder je Sekunde **vor** dem Verlust — der Bezugswert.
    pub rate_vor: f64,
    /// Bilder je Sekunde **nach** dem Verlust. **Das ist die Zahl.**
    ///
    /// Sie beantwortet die Frage, um die es geht, ohne auf Decoder-Meldungen
    /// angewiesen zu sein: läuft das Bild weiter oder steht es? Fällt sie
    /// gegenüber [`rate_vor`](Self::rate_vor) ab, hat sich der Strom nicht
    /// erholt — gleichgültig, ob der Decoder das gemeldet hat.
    pub rate_nach: f64,
    /// Wurden überhaupt Pakete verworfen (= hat die Messung stattgefunden)?
    pub verlust_erzeugt: u64,
    /// Was die Tonspur hergab. **Leer, wenn der Strom keine hat** — dann sind
    /// alle Zahlen darin 0, und genau das ist die richtige Auskunft: ein Lauf
    /// ohne Ton hat keinen sauberen Ton, er hat gar keinen.
    pub ton: TonErgebnis,
}

/// Verbinden, zusehen, messen.
pub async fn miss(auftrag: Auftrag) -> Result<Ergebnis> {
    let mut media = MediaEngine::default();
    media.register_default_codecs().context("Codecs registrieren")?;
    let mut registry = Registry::new();
    registry =
        register_default_interceptors(registry, &mut media).context("Interceptor-Registry")?;
    // Gleiche Begründung wie beim Sender: ohne Loopback-Kandidat läuft der
    // Verkehr über die LAN-Adresse und damit durch die Windows-Firewall.
    let mut engine = SettingEngine::default();
    engine.set_include_loopback_candidate(true);
    let api = APIBuilder::new()
        .with_media_engine(media)
        .with_interceptor_registry(registry)
        .with_setting_engine(engine)
        .build();

    let pc = Arc::new(api.new_peer_connection(RTCConfiguration::default()).await?);
    for kind in [RTPCodecType::Video, RTPCodecType::Audio] {
        pc.add_transceiver_from_kind(
            kind,
            Some(RTCRtpTransceiverInit {
                direction: RTCRtpTransceiverDirection::Recvonly,
                send_encodings: vec![],
            }),
        )
        .await?;
    }

    let verbunden = Arc::new(AtomicBool::new(false));
    {
        let v = Arc::clone(&verbunden);
        pc.on_peer_connection_state_change(Box::new(move |s| {
            use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState as S;
            if s == S::Connected {
                v.store(true, Ordering::SeqCst);
            }
            Box::pin(async {})
        }));
    }

    let ssrc = Arc::new(AtomicU32::new(0));
    let mess = Arc::new(Messwerk::default());
    let tonwerk = Arc::new(Tonwerk::default());
    // **Eine Uhr für beide Spuren.** Jede Spur hat ihren eigenen Nullpunkt (die
    // Ankunft ihres ersten Pakets), und das ist für alles Bisherige richtig —
    // für den Vergleich Bild gegen Ton aber tödlich: die beiden Nullpunkte
    // liegen um den Abstand der beiden Spur-Rückrufe auseinander, und genau
    // dieser unbekannte Betrag ginge als „A/V-Versatz" durch. Deshalb hier eine
    // gemeinsame, VOR den Spuren gestellte Uhr, und nur sie geht in die
    // Ton-Bild-Rechnung ein.
    let gemeinsam = Instant::now();
    {
        let ssrc = Arc::clone(&ssrc);
        let mess = Arc::clone(&mess);
        let tonwerk = Arc::clone(&tonwerk);
        let verlust_ab = auftrag.verlust_ab;
        let verlust_pakete = auftrag.verlust_pakete;
        pc.on_track(Box::new(move |track, _r, _t| {
            let ist_video = track.kind() == RTPCodecType::Video;
            let mime = track.codec().capability.mime_type.clone();
            if ist_video {
                ssrc.store(track.ssrc(), Ordering::SeqCst);
            }
            let mess = Arc::clone(&mess);
            let tonwerk = Arc::clone(&tonwerk);
            // **Die Arbeit je Spur muss in eine eigene Aufgabe**, und der
            // Rückruf muss sofort zurückkehren: webrtc-rs ruft ihn je Spur
            // nacheinander auf und wartet dabei ab. Eine Schleife, die bis zum
            // Ende des Stroms läuft, hält damit alle weiteren Spuren auf.
            //
            // Am 2026-08-02 genau so passiert, als der Vulkan-Weg seine Tonspur
            // bekam: der Ton kam als erste Spur, blieb im Leerlesen stehen, und
            // das Messwerk meldete 0 empfangene Videopakete — bei einem Server,
            // der sichtbar 822 KB und beide Spuren führte. Das sah nach einem
            // Fehler am Sender aus und war einer im Zuschauer.
            Box::pin(async move {
                if !ist_video {
                    // **Bis zum 2026-08-02 wurde die Tonspur hier nur
                    // leergelesen** — der Empfangspuffer durfte nicht stauen,
                    // und gemessen wurde ohnehin nur das Bild. Die Folge war,
                    // dass jede Aussage über den Ton auf „am Server steht eine
                    // Opus-Spur" beruhte. Jetzt hört das Messwerk hin.
                    tokio::spawn(async move { tonwerk.lauf(&track, gemeinsam).await });
                    return;
                }
                tokio::spawn(bildspur(track, mime, mess, verlust_ab, verlust_pakete, gemeinsam));
            })
        }));
    }

    /// Die Bildspur bis zu ihrem Ende bedienen.
    async fn bildspur(
        track: Arc<webrtc::track::track_remote::TrackRemote>,
        mime: String,
        mess: Arc<Messwerk>,
        verlust_ab: Option<u64>,
        verlust_pakete: u64,
        gemeinsam: Instant,
    ) {
        // Der Zeitnullpunkt ist die Ankunft des ersten Videopakets, also der
        // Beginn genau dieser Aufgabe — es gibt eine Bildspur, und nur sie
        // misst. Ein geteilter Zeitstempel wäre eine Verabredung zwischen zwei
        // Stellen, von denen eine gar nicht mitspielt.
        let t0 = Instant::now();
        // Zwei Fäden: lesen+zusammensetzen hier, dekodieren nebenan.
        let (tx, rx) = std::sync::mpsc::channel();
        let dec = Arc::clone(&mess);
        let dec_mime = mime.clone();
        let decoder_faden = std::thread::Builder::new()
            .name("messwerk-decoder".into())
            .spawn(move || {
                if let Err(e) = dec.dekodiere(&dec_mime, rx) {
                    eprintln!("[messwerk] Decoder beendet: {e:#}");
                }
            })
            .expect("Decoder-Faden starten");
        if let Err(e) =
            mess.lauf(&track, &tx, t0, gemeinsam, &mime, verlust_ab, verlust_pakete).await
        {
            eprintln!("[messwerk] Bildspur beendet: {e:#}");
        }
        drop(tx); // Decoder-Faden beenden lassen
        let _ = decoder_faden.join();
    }

    handschlag(&pc, &auftrag.url).await?;

    // Bis zum Verlust zusehen, dann ggf. anfordern, dann weiter messen.
    //
    // **Auf die Laufzeit begrenzt.** Liegt der Verlustzeitpunkt hinter dem Ende
    // (so schaltet man ihn ab), wartete der Lauf sonst bis dorthin statt bis
    // zum Ende — und ein Messwerk, das nach seiner eigenen Laufzeit noch eine
    // Minute steht, wird vom Aufrufer abgeschossen und liefert gar nichts.
    let laufzeit = Duration::from_secs(auftrag.sekunden);
    let ende = Instant::now() + laufzeit;

    // **Beim Einsteigen anfordern**, sobald die Spur steht — das tut jeder
    // echte Abspieler, und bei Intra-Refresh ist es der einzige Weg ins Bild.
    if auftrag.fordert_beim_einstieg {
        for _ in 0..40 {
            if ssrc.load(Ordering::SeqCst) != 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        fordere_vollbild(&pc, &ssrc, "beim Einsteigen").await?;
    }

    let soll_anfordern = auftrag.fordert_nach_verlust
        && auftrag.verlust_ab.is_some_and(|ab| ab < auftrag.sekunden);

    if soll_anfordern {
        // **Auf den Verlust warten, nicht auf die Uhr** (Begründung an
        // `Messwerk::verlust_durch`). Kommt das Signal nicht — etwa weil zu
        // wenige Pakete ankamen —, endet der Lauf nach seiner Laufzeit statt
        // hängenzubleiben, und `verlust_erzeugt` bleibt 0: die Auswertung sieht
        // dann selbst, dass nichts gemessen wurde.
        let warten = mess.verlust_durch.notified();
        let _ = tokio::time::timeout_at(ende.into(), warten).await;
        if mess.verlust_erzeugt.load(Ordering::Relaxed) > 0 {
            fordere_vollbild(&pc, &ssrc, "nach dem Verlust").await?;
        }
    }
    tokio::time::sleep_until(ende.into()).await;

    let mut e = mess.ernte();
    e.ton = tonwerk.ernte(&mess.bildblöcke.lock().expect("Bildblöcke vergiftet"));
    if !verbunden.load(Ordering::SeqCst) {
        bail!("Verbindung kam nicht zustande — die Zahlen wären wertlos");
    }
    let _ = pc.close().await;
    Ok(e)
}

/// Ein Vollbild anfordern. Ohne bekannte Bildspur folgenlos — das ist kein
/// Fehler, sondern der Fall „die Spur steht noch nicht", und ein Abbruch dort
/// verlöre den ganzen Lauf für eine Anforderung, die ohnehin nichts erreicht
/// hätte.
async fn fordere_vollbild(pc: &Arc<RTCPeerConnection>, ssrc: &AtomicU32, wann: &str) -> Result<()> {
    let s = ssrc.load(Ordering::SeqCst);
    if s == 0 {
        eprintln!("[messwerk] keine Bildspur — Anforderung {wann} entfaellt");
        return Ok(());
    }
    pc.write_rtcp(&[Box::new(PictureLossIndication { sender_ssrc: 0, media_ssrc: s })])
        .await
        .with_context(|| format!("Vollbild-Anforderung {wann}"))?;
    eprintln!("[messwerk] Vollbild angefordert ({wann})");
    Ok(())
}

async fn handschlag(pc: &Arc<RTCPeerConnection>, url: &str) -> Result<()> {
    let offer = pc.create_offer(None).await?;
    pc.set_local_description(offer).await?;
    let mut gathering = pc.gathering_complete_promise().await;
    let _ = tokio::time::timeout(Duration::from_secs(2), gathering.recv()).await;
    let sdp = pc.local_description().await.ok_or_else(|| anyhow!("keine local description"))?.sdp;
    let http = reqwest::Client::builder().timeout(Duration::from_secs(15)).build()?;
    let res = http
        .post(url)
        .header(reqwest::header::CONTENT_TYPE, "application/sdp")
        .body(sdp)
        .send()
        .await
        // Die URL kann ein Token tragen — nicht roh in eine Meldung.
        .map_err(|e| {
            anyhow!(
                "WHEP-Server nicht erreichbar: {}",
                pulse_win_hq_sidecar::redact::secrets(&e.to_string())
            )
        })?;
    if !res.status().is_success() {
        bail!("WHEP-POST fehlgeschlagen: HTTP {}", res.status());
    }
    pc.set_remote_description(RTCSessionDescription::answer(res.text().await?)?).await?;
    Ok(())
}

