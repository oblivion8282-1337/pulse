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
//! **Stand: es wird zurueckgerechnet.** Hier stand bis zum 2026-07-31
//! „Aufsammeln, noch kein Zurueckrechnen" — das war der Stand des ersten
//! Schritts und ist ueberholt: `empfaenger.rs` stellt fehlende Medienpakete
//! aus der Paritaet wieder her und zaehlt das mit ([`Zaehler`]).
//!
//! **Seit 2026-08-03 ist der Paritaets-Empfang der Standardweg**,
//! `PULSE_PLAYER_FLEXFEC=0` schaltet ihn ab. Vorher lag er hinter einem
//! `=1`-Schalter, den ausser dem Pruefstand niemand setzte — der ausgelieferte
//! Player bot FlexFEC damit gar nicht erst an, und ein Server mit
//! eingeschalteter Paritaet haette ihren Aufschlag fuer ihn umsonst gezahlt.
//!
//! Der Grund fuer die Umstellung lag in der Bildstruktur: Ein
//! Intra-Refresh-Strom heilte sich nach einem Verlust NICHT selbst (gemessen
//! 2026-07-29 — eine verworfene Zugriffseinheit liess das Bild dauerhaft
//! stehen, bei av1_cuvid wie bei libdav1d). Wo keine Vollbilder mehr im Strom
//! standen, musste der Verlust verhindert werden statt hinterher repariert, und
//! die Paritaet ist die Schicht, die weder NACK noch die Vollbild-Anforderung
//! abdecken: Redundanz, die VOR dem Verlust unterwegs ist.
//!
//! **Die Betriebsart ist am 2026-08-21 entfallen, die Begruendung nicht.** Der
//! Vollbild-Abstand steht seit dem 2026-08-18 bei 60 s: zwischen zwei
//! Vollbildern liegt jetzt eine Minute statt eines Auffrischungsdurchlaufs,
//! und in dieser Minute gilt jedes Wort oben unveraendert.
//!
//! Die alte Warnung bleibt als Merkposten gueltig: Wer eine Messung fuer „mit
//! Paritaet" haelt, muss geprueft haben, dass sie im laufenden Binary wirklich
//! ausgehandelt wurde — die Zaehler in der Statistik zeigen es.

pub mod empfaenger;
pub mod flexfec03;
pub mod gegenprobe;

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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

/// Ob der Paritaets-Empfang eingeschaltet ist. **Standard: ja** (seit
/// 2026-08-03), abschaltbar mit `PULSE_PLAYER_FLEXFEC=0`.
///
/// **Die EINZIGE Stelle, die das entscheidet.** `whep.rs` fragte dieselbe
/// Variable frueher selbst ab — zwei Abfragen fuer eine Entscheidung, und die
/// gefaehrlichere Haelfte war die stille: Wer nur das Angebot umstellt, zahlt
/// den Aufschlag der Paritaet und wertet sie nicht aus. Genau umgekehrt lief es
/// am 2026-07-31 schon einmal (Angebot fehlte, Server sendete trotzdem), und
/// die Messakte haelt die Lehre fest: „Ein Schalter, den niemand setzt, ist
/// kein Schalter."
pub fn eingeschaltet() -> bool {
    std::env::var("PULSE_PLAYER_FLEXFEC").as_deref() != Ok("0")
}

/// Was die Paritaet tatsaechlich ausgerichtet hat, fuer die Statistik.
///
/// **Warum das nicht im `Empfaenger` bleiben kann.** Der lebt in einer
/// eigenen Aufgabe, die niemand von aussen erreicht — bis 2026-07-31 gingen
/// seine drei Zaehler deshalb nur auf stderr, und zwar auch dort nur jedes
/// zehnte Mal. `packets_lost` steht derweil sauber alle 250 ms in der
/// Statistik. Ein A/B einer Paritaets-Einstellung braucht aber BEIDE Zahlen
/// in derselben Messakte: „weniger Verlust" und „mehr repariert" sind
/// verschiedene Aussagen, und ohne die zweite ist nicht zu unterscheiden, ob
/// eine Aenderung gewirkt oder die Leitung sich beruhigt hat.
///
/// Atomics statt Sperre, weil ausschliesslich gezaehlt und gelesen wird —
/// `Relaxed` genuegt: die drei Werte haengen nicht voneinander ab, und eine
/// Statistik, die einen Zaehler ein Fenster zu spaet sieht, ist richtig genug.
#[derive(Debug, Default)]
pub struct Zaehler {
    pub repariert: AtomicU64,
    pub unreparierbar: AtomicU64,
    /// Paritaet, die nichts bewirkt hat (s. `empfaenger::Empfaenger::verworfen`).
    pub verworfen: AtomicU64,
    /// Wie oft XOR an seine Grenze kam (Gruppe mit mehr als einem Loch).
    /// Siehe `empfaenger::Empfaenger::mehrfach_loch` — ohne diese Zahl sagt
    /// `unreparierbar` allein nichts darueber, ob die Paritaet ausreicht.
    pub mehrfach_loch: AtomicU64,
    pub zu_spaet: AtomicU64,
}

impl Zaehler {
    /// `(repariert, unreparierbar, verworfen, mehrfach_loch, zu_spaet)`.
    pub fn lesen(&self) -> (u64, u64, u64, u64, u64) {
        (
            self.repariert.load(Ordering::Relaxed),
            self.unreparierbar.load(Ordering::Relaxed),
            self.verworfen.load(Ordering::Relaxed),
            self.mehrfach_loch.load(Ordering::Relaxed),
            self.zu_spaet.load(Ordering::Relaxed),
        )
    }
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
    zaehler: Arc<Zaehler>,
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
                    // Nach JEDEM Paritaetspaket spiegeln, nicht nur bei der
                    // stderr-Meldung unten: die haengt an `% 10` und liesse die
                    // Statistik zwischen zwei Zehnerschritten alt aussehen.
                    zaehler.repariert.store(empfaenger.repariert, Ordering::Relaxed);
                    zaehler.unreparierbar.store(empfaenger.unreparierbar, Ordering::Relaxed);
                    zaehler.verworfen.store(empfaenger.verworfen, Ordering::Relaxed);
                    zaehler.mehrfach_loch.store(empfaenger.mehrfach_loch, Ordering::Relaxed);
                    zaehler.zu_spaet.store(empfaenger.zu_spaet, Ordering::Relaxed);
                    if empfaenger.repariert > 0 && empfaenger.repariert != letzte_meldung
                        && empfaenger.repariert % 10 == 0
                    {
                        letzte_meldung = empfaenger.repariert;
                        eprintln!(
                            "pulse-player: Paritaet reparierte {} Pakete \
                             ({} unreparierbar, {} mit mehr als einem Loch)",
                            empfaenger.repariert, empfaenger.unreparierbar,
                            empfaenger.mehrfach_loch
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
