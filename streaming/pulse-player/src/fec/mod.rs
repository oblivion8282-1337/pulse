//! Empfang der FlexFEC-Paritaetspakete.
//!
//! **Wo die Pakete herkommen.** Der MediaMTX-Fork erzeugt sie auf der
//! WHEP-Sendeseite (`0003-flexfec-on-whep.patch`): je zehn Medienpaketen zwei
//! Paritaetspakete, unter eigener Quellkennung und Nutzlasttyp 110. Sie liegen
//! also auf derselben Verbindung wie Bild und Ton, gehoeren aber zu keiner
//! angemeldeten Spur.
//!
//! **Warum sie ohne Zutun verloren gehen.** webrtc-rs entschluesselt jedes
//! solche Paket und legt den Strom in einer Tabelle ab
//! (`undeclared_media_processor` → `store_simulcast_stream`), versucht ihn
//! dann einer Spur zuzuordnen, scheitert daran und meldet nur noch
//! `Incoming unhandled RTP ssrc(...), on_track will not be fired`. Der Strom
//! bleibt danach in der Tabelle liegen — erreichbar war er trotzdem nicht,
//! weil Tabelle und Zugriffe `pub(crate)` sind. Unser Zweig der Bibliothek
//! fuegt genau zwei lesende Methoden hinzu; dieses Modul ist ihr einziger
//! Nutzer.
//!
//! **Stand: Aufsammeln, noch kein Zurueckrechnen.** Bewusst in dieser
//! Reihenfolge — ob die Pakete den ganzen Weg bis in unseren Code schaffen,
//! ist die Frage, an der der Ansatz haette scheitern koennen, und sie laesst
//! sich ohne eine Zeile Rechenlogik beantworten.

pub mod empfaenger;
pub mod flexfec03;
pub mod gegenprobe;

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use webrtc::dtls_transport::RTCDtlsTransport;

/// Nutzlasttyp der Paritaetspakete, abgestimmt mit `FLEXFEC_PAYLOAD_TYPE` in
/// `whep.rs` und `pulseFlexFECPayloadType` im MediaMTX-Patch.
const FLEXFEC_PAYLOAD_TYPE: u8 = 110;

/// Wie oft nach neu aufgetauchten Stroemen gesehen wird. Der Paritaetsstrom
/// erscheint erst, wenn sein erstes Paket eingetroffen ist — also nach dem
/// Verbindungsaufbau und nicht vorhersagbar wann.
const SUCHINTERVALL: Duration = Duration::from_millis(200);

/// Groesse des Lesepuffers je Paket. 1500 deckt jede MTU ab, die ueber eine
/// gewoehnliche Leitung geht.
const LESEPUFFER: usize = 1500;

/// Ob der Paritaets-Empfang eingeschaltet ist.
///
/// Vorerst hinter einer Variablen: das Angebot veraendert die SDP-Aushandlung,
/// und ohne Gegenstueck am Server passiert ohnehin nichts.
pub fn eingeschaltet() -> bool {
    std::env::var("PULSE_PLAYER_FLEXFEC").as_deref() == Ok("1")
}

/// Startet den Paritaets-Empfang und liefert den Kanal, ueber den der
/// Video-Track seine Pakete meldet.
///
/// Zwei Aufgaben statt einer: die eine sucht und liest den Paritaetsstrom
/// (er taucht erst auf, wenn sein erstes Paket eintrifft), die andere haelt
/// den Empfaenger und bekommt beide Seiten ueber Kanaele. So braucht es
/// keinen geteilten Zustand zwischen den Aufgaben.
pub fn starten(
    transport: Arc<RTCDtlsTransport>,
    tx: tokio::sync::mpsc::Sender<crate::whep::RtpArrival>,
    codec: crate::whep::Codec,
    clock_rate: u32,
) -> tokio::sync::mpsc::Sender<(u16, Vec<u8>)> {
    let (medien_tx, mut medien_rx) = tokio::sync::mpsc::channel::<(u16, Vec<u8>)>(256);
    let (par_tx, mut par_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(64);

    aufsammeln(transport, Some(par_tx));

    tokio::spawn(async move {
        let mut empfaenger = empfaenger::Empfaenger::neu(codec, clock_rate, tx);
        let mut letzte_meldung = 0u64;
        loop {
            tokio::select! {
                Some((seq, bytes)) = medien_rx.recv() => {
                    empfaenger.medienpaket(seq, bytes).await;
                }
                Some(nutzlast) = par_rx.recv() => {
                    empfaenger.paritaetspaket(&nutzlast).await;
                    if empfaenger.repariert > 0 && empfaenger.repariert != letzte_meldung
                        && empfaenger.repariert % 10 == 0
                    {
                        letzte_meldung = empfaenger.repariert;
                        eprintln!(
                            "pulse-player: Paritaet reparierte {} Pakete \
                             ({} unreparierbar)",
                            empfaenger.repariert, empfaenger.unreparierbar
                        );
                    }
                }
                else => break,
            }
        }
    });

    medien_tx
}

/// Sammelt die Paritaetspakete der Sitzung ein.
///
/// Laeuft, bis die Verbindung abgebaut wird — `read_rtp` bricht dann mit einem
/// Fehler ab und die jeweilige Aufgabe endet.
///
/// **Nur einmal je Programmlauf.** Der Aufrufer haengt an `on_track`, und das
/// feuert je Spur — fuer Bild und Ton also zweimal, mit demselben Transport.
/// Zwei Sammler am selben Strom wuerden sich die Pakete TEILEN (jedes Paket
/// bekommt nur ein `read_rtp`), und die Paritaet waere in beiden Haelften
/// unbrauchbar. Der Fehler faellt nicht auf: beide Seiten zaehlen munter
/// Pakete, nur eben die Haelfte.
pub fn aufsammeln(
    transport: Arc<RTCDtlsTransport>,
    weiter: Option<tokio::sync::mpsc::Sender<Vec<u8>>>,
) {
    static GESTARTET: AtomicBool = AtomicBool::new(false);
    if GESTARTET.swap(true, Ordering::SeqCst) {
        return;
    }

    tokio::spawn(async move {
        let mut gesehen: HashSet<u32> = HashSet::new();
        loop {
            for ssrc in transport.undeclared_stream_ssrcs().await {
                if !gesehen.insert(ssrc) {
                    continue;
                }
                let Some(strom) = transport.undeclared_stream(ssrc).await else {
                    continue;
                };
                let weiter = weiter.clone();
                tokio::spawn(async move {
                    let mut puffer = vec![0u8; LESEPUFFER];
                    let mut anzahl: u64 = 0;
                    let mut fremd: u64 = 0;
                    while let Ok(paket) = strom.read_rtp(&mut puffer).await {
                        if paket.header.payload_type == FLEXFEC_PAYLOAD_TYPE {
                            anzahl += 1;
                            if gegenprobe::eingeschaltet() {
                                gegenprobe::paritaetspaket(&paket.payload);
                            }
                            if let Some(w) = &weiter {
                                // Voll heisst: der Empfaenger kommt nicht mit.
                                // Wegwerfen ist dann richtig — ein spaet
                                // verarbeitetes Paritaetspaket repariert
                                // ohnehin nichts mehr.
                                let _ = w.try_send(paket.payload.to_vec());
                            }
                        } else {
                            // Ein anderer nicht zugeordneter Strom. Zaehlen
                            // statt stillschweigend mitrechnen: sonst
                            // verwechselt der naechste Leser eine fremde
                            // Quelle mit Paritaet.
                            fremd += 1;
                        }
                        if anzahl > 0 && anzahl % 500 == 0 {
                            eprintln!("pulse-player: Paritaet ssrc={ssrc} {anzahl} Pakete");
                        }
                    }
                    eprintln!(
                        "pulse-player: Paritaetsstrom ssrc={ssrc} beendet, \
                         {anzahl} Pakete gelesen, {fremd} fremde verworfen"
                    );
                    if gegenprobe::eingeschaltet() {
                        gegenprobe::bilanz();
                    }
                });
            }
            tokio::time::sleep(SUCHINTERVALL).await;
        }
    });
}
