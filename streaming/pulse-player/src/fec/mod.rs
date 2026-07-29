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

pub mod flexfec03;

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
pub fn aufsammeln(transport: Arc<RTCDtlsTransport>) {
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
                tokio::spawn(async move {
                    let mut puffer = vec![0u8; LESEPUFFER];
                    let mut anzahl: u64 = 0;
                    let mut fremd: u64 = 0;
                    while let Ok(paket) = strom.read_rtp(&mut puffer).await {
                        if paket.header.payload_type == FLEXFEC_PAYLOAD_TYPE {
                            anzahl += 1;
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
                });
            }
            tokio::time::sleep(SUCHINTERVALL).await;
        }
    });
}
