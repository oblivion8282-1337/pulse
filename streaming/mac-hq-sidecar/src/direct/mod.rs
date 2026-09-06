//! Die Direkt-Sitzung des Sidecars: Antworten statt veröffentlichen.
//!
//! **Stufe 1.5 auf dem Mac** — Zwilling zu `win-hq-sidecar/src/direct/mod.rs`.
//! Der Unterschied liegt NICHT im Protokoll, sondern in der Übergabe des
//! Senders an die Encode-Pipeline: Windows koppelt über ein Senken-Trait
//! (`PaketSenke`), der Mac fächelt in `encode/mod.rs` über das `Ausgabe`-
//! Enum — diese Variante heißt hier `Ausgabe::Direct` und holt den Sender
//! über [`Sitzung::nimm_sender`] selbst ab. Alles andere (Buchungen,
//! Wartezustand, Teardown, Ereignisse) ist wortgleich zum Windows-Zwilling.
//!
//! **Stufe 1 ist exklusiv.** Ein Stream läuft ENTWEDER als Server-Push (WHIP
//! an MediaMTX / RTMPS) ODER als Direktverbindung zum Player — nie beides.
//! Der Direktmodus beginnt mit `start` + `"direct": true`: der Controller
//! fährt im Wartezustand hoch (`{"ev":"state","running":true,"state":
//! "wartend"}`), Aufnahme und Encoder stehen still. `direct_offer` beantwortet
//! das Angebot des Players; erreicht die PeerConnection `Connected`, startet
//! die übliche Pipeline (state `starting` → `live` wie heute). `direct_stop`
//! — oder ein PC-Fehler — räumt ab und kehrt nach `wartend` zurück, wo das
//! nächste Angebot warten kann. Der ganze Lebenszyklus ist gebucht in
//! [`ablauf::Ablauf`] (rein, getestet); dieses Modul führt die Übergänge aus.
//!
//! **Wo der Sender herkommt.** [`pulse_whip::direct::DirectSender`] wird beim
//! Angebot gebaut und aushandelt dort. Die Pipeline holt ihn sich später
//! über [`Sitzung::nimm_sender`] — derselbe genau-einmal-Vertrag wie beim
//! Windows-Zwilling (nimm_senke): Codec und fps müssen zum Auftrag passen,
//! eine zweite Abholung ist ein Programmfehler.
//!
//! **Rückkanal.** PLI/FIR landen über den RTCP-Lesefaden bei
//! `crate::keyframe::request_keyframe` — derselbe Weg wie bei MediaMTX.
//! REMB wird wie dort eingeordnet ([`crate::whip::remb_auswerten`]).
//! Verlust-Reparatur ohne FlexFEC übernimmt der NACK-Responder von
//! webrtc-rs (Begründung im Modulkopf des Senders).
//!
//! **Ereignis-Reihenfolge.** `direct_state`-Events werden im Op-Handler
//! emittiert und erreichen den Controller VOR der Response-Zeile — dieselbe
//! Reihenfolge, mit der `start` sein `starting`-Event schreibt; der Renderer
//! finalisiert Ops über die Response-`id`, nicht über die Zeilenreihenfolge.

pub mod ablauf;
mod rueckkanal;

use std::sync::{Arc, Mutex, OnceLock};

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Map, Value};

use crate::events;
use crate::stream_controller::StreamController;
use rueckkanal::{rtcp_schleife, verdrahte_pc};

/// Pseudo-Ziel-URL des Direktpfads. Kein Server dahinter — sie dient allein
/// als Markierung im Routing (`encode::wahl::url_format_hint` kennt das
/// Schema) und in der Diagnose-argv. Die Auswahl der Schemas bleibt an EINEM
/// Ort, damit der Muxer nie an einem fremden Sendeweg vorbeiläuft.
pub const SITZUNG_URL: &str = "direct://sitzung";

/// Angebotsmaße, wenn der Renderer keine Auflösungs-Box gesetzt hat. Es geht
/// hier nur um die fmtp-STUFE des Answers: zu hoch ist folgenlos, zu niedrig
/// lässt den Hardware-Decoder des Players aussteigen — also lieber die
/// größte übliche Schirmgröße annehmen als zu klein ansetzen.
const ANGENOMMENE_MASSE: (u32, u32) = (3840, 2160);

pub struct Sitzung {
    inner: Mutex<SitzungsInner>,
}

struct SitzungsInner {
    ablauf: ablauf::Ablauf,
    sender: Option<Arc<pulse_whip::direct::DirectSender>>,
    /// Ziel-Bitrate der laufenden Aushandlung — Maßstab der REMB-Wacht.
    bitrate_kbps: u32,
}

/// Der Singleton. Genau eine Direkt-Sitzung je Prozess — der Sidecar ist
/// per-stream geplant, und zwei PCs auf einem Screen-Encoder ergeben keinen
/// Sinn.
pub fn sitzung() -> &'static Sitzung {
    static INSTANCE: OnceLock<Sitzung> = OnceLock::new();
    INSTANCE.get_or_init(|| Sitzung {
        inner: Mutex::new(SitzungsInner {
            ablauf: ablauf::Ablauf::neu(),
            sender: None,
            bitrate_kbps: 0,
        }),
    })
}

impl Sitzung {
    /// `start(direct:true)` angenommen — die Maschine auf Warten stellen.
    /// Der Controller hat den Wartezustand schon gesetzt (`already running`-
    /// Wache); diese Buchung hält die eigene Maschine mit ihm konform.
    pub fn bereite_vor(&self) -> Result<()> {
        let mut inner = self.lock();
        inner.ablauf.bereite_vor()
    }

    /// `direct_offer`: das Angebot des Players beantworten. Liefert den
    /// fertigen Answer-SDP (nicht-trickle, komplett gesammelt).
    pub fn anbieten(&self, offer_sdp: &str) -> Result<String> {
        // Zuerst die BUCHUNG — ihre Fehlertexte sind der Vertrag (z. B.
        // „direct session already negotiated" beim zweiten Angebot).
        {
            let mut inner = self.lock();
            inner.ablauf.aushandeln()?;
        }
        // Scheitert irgendetwas der folgenden Schritte, muss die Buchung
        // zurück — sonst bliebe „Ausgehandelt" ohne Sender hängen und jedes
        // weitere Angebot liefere in den Vertraglichen Fehler.
        let resultat = self.aushandle(offer_sdp);
        if let Err(e) = resultat {
            {
                let mut inner = self.lock();
                inner.ablauf.aushandlung_abgebrochen();
            }
            return Err(e);
        }
        let (antwort, sender, bitrate_kbps) = resultat.unwrap();
        {
            let mut inner = self.lock();
            inner.sender = Some(sender);
            inner.bitrate_kbps = bitrate_kbps;
        }
        // Nach dem Ok der Response vorausgeschickt (Reihenfolge-Begründung im
        // Modulkopf).
        events::emit(json!({ "ev": "direct_state", "state": "connecting" }));
        Ok(antwort)
    }

    /// Der teure Teil des Anbietens: Sender bauen, PC verdrahten, aushandeln.
    fn aushandle(
        &self,
        offer_sdp: &str,
    ) -> Result<(String, Arc<pulse_whip::direct::DirectSender>, u32)> {
        // Was gestreamt wird, steht im Wartezustand des Controllers — dessen
        // `wartende_direct_params` sind die EINE Quelle.
        let params = StreamController::singleton()
            .wartende_direct_params()
            .ok_or_else(|| anyhow!("kein wartender Direkt-Stream (start mit direct:true)"))?;
        // Macs StartParams trägt flache Maße (win: Overrides + Profil). Der
        // Codec läuft durch denselben Slug-Space wie `start_whip`: nur h264
        // und av1 sprechen den Direkt-Sendeweg (s. dortige Fallback-Begründung).
        let codec_slug: &'static str = match params.codec.as_str() {
            "av1" => "av1",
            _ => "h264",
        };
        let bitrate_kbps = params.bitrate_kbps;
        let konfig = pulse_whip::direct::Konfig {
            codec_slug,
            fps: params.fps,
            breite: params.width,
            hoehe: params.height,
            bitrate_kbps,
        };
        let sender = Arc::new(
            pulse_whip::direct::DirectSender::neu(&konfig)
                .context("Direkt-Sender aufbauen")?,
        );
        // Zustands-Handler VOR der Aushandlung anmelden — nur EIN Handler je
        // PC (Begruendung im Sender-Modulkopf); hier wird er auch NICHT von
        // `DirectSender` selbst belegt.
        verdrahte_pc(&sender);
        let antwort = sender
            .connect(offer_sdp)
            .context("Angebot beantworten")?;
        rtcp_schleife(sender.video_sender(), bitrate_kbps);
        Ok((antwort, sender, bitrate_kbps))
    }

    /// `direct_stop`: PeerConnection und — falls schon mitlaufend — die
    /// Pipeline abbauen, zurück nach wartend. Idempotent: ohne Aushandlung
    /// ein Ok mit Hinweis. Ein aktiver SERVER-Stream verweigert sauber
    /// (Stufe 1 exklusiv), statt still nichts zu tun.
    pub fn stoppen(&self) -> Result<Map<String, Value>> {
        let abreissen = { let mut inner = self.lock(); inner.ablauf.reissen() };
        if !abreissen {
            let snapshot = StreamController::singleton().state();
            if snapshot.running && snapshot.state != "wartend" {
                return Err(anyhow!(
                    "direct_stop verweigert: es läuft ein Server-Stream (Stufe 1 ist exklusiv)"
                ));
            }
            let mut out = Map::new();
            out.insert(
                "note".to_string(),
                Value::String("keine ausgehandelte Direkt-Sitzung".to_string()),
            );
            return Ok(out);
        }
        let sender = self.nimm_sender_fuer_teardown();
        self.raeume_auf(sender);
        Ok(Map::new())
    }

    /// Prozess-Ende (`stop`-Op, stdin-EOF): PC schließen, ohne in wartend
    /// zurückzukehren — danach existiert der Prozess nicht mehr.
    pub fn beende_endgueltig(&self) {
        { let mut inner = self.lock(); inner.ablauf.reissen(); }
        if let Some(s) = self.nimm_sender_fuer_teardown() {
            s.close();
        }
    }

    /// PC meldet `Connected`: genau einmal die Pipeline starten und „live"
    /// melden. Scheitert der Start, wird abgerissen — ein „live" ohne Bild
    /// wäre die schlimmere Lüge.
    fn pc_verbunden(&self) {
        let starten = { let mut inner = self.lock(); inner.ablauf.verbunden() };
        if !starten {
            return;
        }
        events::emit(json!({ "ev": "direct_state", "state": "live" }));
        if let Err(e) = StreamController::singleton().pipeline_starten() {
            eprintln!("[direct] Pipeline starten fehlgeschlagen: {e:#}");
            events::emit(json!({ "ev": "direct_state", "state": "failed" }));
            let sender = self.nimm_sender_fuer_teardown();
            self.raeume_auf(sender);
        }
    }

    /// PC meldet `Failed`/`Closed`: buchen, Melden, auf eigenem Faden
    /// aufräumen (der Callback läuft im Tokio-Kontext — `stop()` wartet bis
    /// 13 s auf den Worker, das darf dort nicht blockieren).
    fn pc_gescheitert(&self) {
        let abreissen = { let mut inner = self.lock(); inner.ablauf.reissen() };
        if !abreissen {
            // Spätes Closed nach eigenem Abbau (direct_stop) oder ohne
            // Aushandlung — kein zweiter Teardown, keine failed-Meldung.
            return;
        }
        events::emit(json!({ "ev": "direct_state", "state": "failed" }));
        let _ = std::thread::Builder::new()
            .name("direct-teardown".into())
            .spawn(move || {
                let sender = sitzung().nimm_sender_fuer_teardown();
                sitzung().raeume_auf(sender);
            });
    }

    /// Vom Pipeline-Worker (nach dessen eigener End-Meldung, nur im
    /// Direktmodus): die Pipeline endete von selbst — Encoder- oder
    /// Capture-Fehler, oder das Stop-Signal des Teardowns. Im zweiten Fall
    /// bucht `reissen` nichts (Aufräum-Phase läuft schon); im ersten führen
    /// WIR den Teardown, aber OHNE `stop()`-Warte: dieser Aufruf IST der
    /// Worker-Faden, ein Selbst-Join wäre eine Sackgasse.
    pub fn pipeline_beendet(&self) {
        let abreissen = { let mut inner = self.lock(); inner.ablauf.reissen() };
        if !abreissen {
            return;
        }
        let sender = self.nimm_sender_fuer_teardown();
        if let Some(s) = &sender {
            s.close();
        }
        drop(sender);
        StreamController::singleton().wieder_wartend();
        { let mut inner = self.lock(); inner.ablauf.wieder_wartend(); }
    }

    /// Für `encode::start_direct`: zielt der Auftrag auf den Direktpfad,
    /// bekommt die Pipeline DIESEN Sender — genau einmal, nur mit passendem
    /// Codec und Bildrate. Alles andere ist ein Programmfehler: die Pipeline
    /// läuft ausschließlich nach einer Aushandlung. (Zwilling zu
    /// `nimm_senke` beim Windows-Sidecar; der Mac entkoppelt über sein
    /// `Ausgabe`-Enum statt über ein Senken-Trait.)
    pub(crate) fn nimm_sender(
        &self,
        codec: &str,
        fps: u32,
    ) -> Result<Arc<pulse_whip::direct::DirectSender>> {
        let mut inner = self.lock();
        inner.ablauf.nimm_senke()?;
        let sender = inner
            .sender
            .as_ref()
            .ok_or_else(|| anyhow!("ausgehandelte Direkt-Sitzung ohne Sender (Programmfehler)"))?;
        if sender.codec_slug() != codec {
            return Err(anyhow!(
                "Direkt-Sitzung läuft als {}, der Pipeline-Auftrag sagt {} (Programmfehler)",
                sender.codec_slug(),
                codec
            ));
        }
        if sender.fps() != fps {
            return Err(anyhow!(
                "Direkt-Sitzung verhandelte {} fps, der Pipeline-Auftrag sagt {} (Programmfehler)",
                sender.fps(),
                fps
            ));
        }
        Ok(Arc::clone(sender))
    }

    /// Der Teardown selbst: Pipeline stoppen (wartet auf den Worker — nur von
    /// Nicht-Worker-Fäden rufen!), PC schließen, Controller in wartend.
    /// Der wartend-Event danach ist die sichtbare Rückkehr in die
    /// Bereitschaft.
    fn raeume_auf(&self, sender: Option<Arc<pulse_whip::direct::DirectSender>>) {
        let _ = StreamController::singleton().stop();
        if let Some(s) = &sender {
            s.close();
        }
        drop(sender);
        StreamController::singleton().wieder_wartend();
        { let mut inner = self.lock(); inner.ablauf.wieder_wartend(); }
    }

    fn nimm_sender_fuer_teardown(&self) -> Option<Arc<pulse_whip::direct::DirectSender>> {
        let mut inner = self.lock();
        inner.sender.take()
    }

    /// Eine vergiftete Sperre darf den Pfad nicht stilllegen — dieselbe
    /// Haltung wie `keyframe::request_keyframe`. Es gibt keinen Fall, in dem
    /// ein poisoning die richtige Antwort wäre.
    fn lock(&self) -> std::sync::MutexGuard<'_, SitzungsInner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}
