//! Fernsteuerung — Eingabe-Injektion auf dem Host (Wire-Protokoll **v2**).
//!
//! Verbindlich ist `docs/plans/2026-08-12-input-wire-protokoll-v2.md`. Der
//! Steuernde (`pulse-player` bzw. Electron) erzeugt die Frames, der Gateway
//! reicht sie **unangetastet** durch, dieser Sidecar parst und injiziert sie.
//! Hereingereicht werden sie über die stdio-Operation `remote_input`
//! ([`crate::ops::remote_input`]); dasselbe Frame-Format trägt auch der
//! P2P-Weg (WebRTC-DataChannel), der auf `feat/remote-control-windows` liegt —
//! deshalb steht hier nichts über den Träger, nur über die Frames.
//!
//! Aufteilung: [`rahmen`] parst, [`ausfuehrung`] entscheidet was injiziert wird,
//! [`zuordnung`] rechnet Koordinaten um, [`ziel`] löst den Slot in eine
//! Aufnahmequelle auf, [`injektion`] ruft `SendInput`. Dieses Modul hält die
//! **Sitzung** zusammen — und damit die Zusagen, an denen die Fernsteuerung
//! hängt:
//!
//! * **Alles loslassen beim Ende.** Die Menge des Gedrückten wird mitgeführt und
//!   bei jedem Sitzungsende freigegeben — regulär, bei Verbindungsverlust, bei
//!   fail-closed und beim Prozessende. Ohne das läuft nach einem Abbruch die
//!   W-Taste im Spiel für immer weiter. **Auch eine VERWORFENE Nachricht gibt
//!   frei** (unbekannter Slot, unauflösbare Quelle, geschwärzter Sichtschutz) —
//!   sonst genügt es, dass der Host sein gestreamtes Fenster minimiert, damit
//!   ein Hoch-Ereignis verschluckt wird und die Taste am fremden Rechner
//!   weiterläuft. Und **jedes weitere Hello** gibt ebenso frei: es heißt „neuer
//!   Eingabestrom", und der Steuernde leert dabei seine eigene Gedrückt-Menge,
//!   ohne Hoch-Ereignisse zu senden — er RECHNET mit der Freigabe hier.
//! * **Fail-closed.** Unbekannter Opcode, falsche Länge, fehlendes oder falsches
//!   Hello, unbekannter Knopf → Sitzung stilllegen, alles freigeben, Zustand
//!   melden. Die Eingabe kommt vom einzigen, per Consent bestätigten Gegenüber;
//!   alles Missgeformte ist ein Fehler oder ein Angriff. **Ausnahme:**
//!   unbekannter Slot (Begründung in [`ziel`]).
//! * **Der Handschlag ist Sitzungszustand, keine Eingabe.** Er wird auch dann
//!   verarbeitet, wenn die Eingabe-Frames derselben Nachricht verworfen werden
//!   ([`nur_handschlag`]). Sonst tötete ein Hello, das zufällig in eine
//!   Verwerf-Lage fällt (Stream läuft gerade an, Sichtschutz schwärzt genau
//!   dann), die Sitzung eine Nachricht später mit „Eingabe vor dem
//!   Hello-Handschlag".
//! * **Keine Panik nimmt die Freigabe mit.** Alle Zugriffe auf den Zustand gehen
//!   über [`Sitzung::sperre`], das eine **vergiftete** Sperre übernimmt. Sonst
//!   panikte ausgerechnet [`Sitzung::beenden_endgueltig`] und alles Gedrückte
//!   bliebe unten.

pub mod ausfuehrung;
pub mod base64;
mod druck;
pub mod injektion;
pub mod rahmen;
pub mod ziel;
pub mod zuordnung;

#[cfg(test)]
mod tests;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};

use anyhow::{Result, anyhow};

use druck::Druck;
use rahmen::{InputFrame, PROTOKOLL_VERSION};
use ziel::Zielsuche;

/// Was aus einer Nachricht wurde — geht als Antwortfelder zurück an den
/// Aufrufer und ist damit das, woran die Abnahme misst.
pub struct Bericht {
    pub verarbeitet: usize,
    /// `live` · `unknown_slot` · `unresolved_source` · `masked` · `ended`
    pub zustand: &'static str,
}

/// Läuft gerade eine Fernsteuerung? Gesetzt vom Hello-Handschlag, gelöscht
/// von jedem Sitzungsende (auch fail-closed und Prozessende).
///
/// **Wofür.** Der Pacing-Loop (`pipeline_hw`) schaltet daran auf „Senden bei
/// Ankunft" um: beim Zusehen glättet das feste Tick-Raster, beim Steuern
/// kostet es im Mittel einen halben Bildabstand im geschlossenen Kreis.
/// Atomar statt über [`Sitzung::sperre`], weil der Pacing-Loop das bis zu
/// 60-mal je Sekunde liest und dafür nicht die Eingabe-Sperre anfassen soll.
static FERN_AKTIV: AtomicBool = AtomicBool::new(false);

/// Für den Pacing-Loop: läuft gerade eine Fernsteuerung?
pub fn fern_aktiv() -> bool {
    FERN_AKTIV.load(Ordering::Relaxed)
}

/// Die eine Fernsteuer-Sitzung dieses Prozesses.
///
/// Eine reicht: der Consent bestätigt genau ein Gegenüber, und der Sidecar fährt
/// genau einen Stream (s. [`ziel`]). Alles steht hinter **einer** Sperre —
/// Injektion und Zustandsführung dürfen nicht auseinanderlaufen, sonst liegt
/// zwischen dem physischen Druck und dem Vermerk darüber ein Fenster, in dem ein
/// Sitzungsende die Taste am Host hängen lässt.
pub struct Sitzung {
    inner: Mutex<Zustand>,
}

#[derive(Default)]
pub(in crate::remote_input) struct Zustand {
    /// Die Kennung der laufenden Sitzung — wechselt sie, ist es eine neue
    /// Sitzung: alles Gedrückte der alten wird freigegeben.
    id: Option<String>,
    /// Hello empfangen? Der erste Frame MUSS eines sein.
    begruesst: bool,
    /// Nach einem Protokollfehler stillgelegt → weitere Frames werden abgewiesen,
    /// bis die Sitzung beendet wird.
    stillgelegt: bool,
    /// Endgültig zu (Prozess fährt herunter) → gar nichts wird mehr injiziert,
    /// auch keine neue Sitzung. Nur [`Sitzung::beenden_endgueltig`] setzt es.
    geschlossen: bool,
    /// Wo dieser Sidecar den Zeiger zuletzt SELBST hingesetzt hat — geklemmt und
    /// damit nachweislich im Quell-Rechteck. `None` = unbekannt, dann feuert
    /// kein Knopf und kein Rad (Begründung in [`ausfuehrung`]).
    pub(in crate::remote_input) zeiger: Option<(i32, i32)>,
    /// Alles, was gerade physisch unten ist — fürs Loslassen.
    pub(in crate::remote_input) druck: Druck,
}

impl Sitzung {
    pub fn singleton() -> &'static Sitzung {
        static INSTANCE: OnceLock<Sitzung> = OnceLock::new();
        INSTANCE.get_or_init(|| Sitzung { inner: Mutex::new(Zustand::default()) })
    }

    /// Die Sperre nehmen — **auch eine vergiftete**.
    ///
    /// `unwrap()` wäre hier der teuerste Fehler des Moduls: panikt irgendetwas
    /// unter der Sperre, panikte danach jeder weitere Zugriff — allen voran
    /// [`Self::beenden_endgueltig`] auf dem Prozess-Ende-Pfad (`main.rs`). Dann
    /// bliebe am fremden Rechner **alles** gedrückt, und der Prozess wäre weg.
    /// Der Zustand hinter der Sperre ist dabei nie halb geschrieben: er wird nur
    /// über kleine Schritte fortgeschrieben, und im Zweifel ist ein
    /// übernommener Zustand plus Freigabe besser als gar keine Freigabe.
    fn sperre(&self) -> MutexGuard<'_, Zustand> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Eine Nachricht voller Frames verarbeiten. `slot` und `sitzungs_id` kommen
    /// aus der **Hülle**, nicht aus den Frames (Spezifikation).
    ///
    /// `Err` = fail-closed: die Sitzung ist danach stillgelegt und der Aufrufer
    /// soll sie beenden. `Ok` mit `zustand != "live"` = still verworfen, die
    /// Sitzung steht weiter.
    pub fn frames(
        &self,
        slot: u64,
        sitzungs_id: Option<&str>,
        frames: &[Vec<u8>],
    ) -> Result<Bericht> {
        let mut z = self.sperre();

        // Endgültig zu: der Prozess ist auf dem Weg nach draußen und hat schon
        // freigegeben. Ab hier nichts mehr drücken — sonst stürbe er mit einer
        // physisch gedrückten Taste, und niemand wäre mehr da, der sie löst
        // (s. [`Self::beenden_endgueltig`]). Vor dem Sitzungswechsel unten,
        // der den Zustand sonst zurücksetzte.
        if z.geschlossen {
            return Ok(Bericht { verarbeitet: 0, zustand: "ended" });
        }

        // Sitzungswechsel ohne vorheriges Ende (Verbindung weg, Gegenüber
        // gewechselt): erst die alte auflösen, sonst hinge deren Gedrücktes.
        //
        // **Auch das FEHLEN der Kennung ist ein Wechsel.** Hier wurde früher nur
        // bei vorhandenem Feld verglichen — eine Nachricht ohne `session_id`
        // erbte damit `begruesst` und die Gedrückt-Menge der Vorgängersitzung.
        // Der Sidecar verlässt sich ausdrücklich nicht darauf, dass vor ihm
        // jemand geprüft hat; „kein Feld" ist deshalb eine eigene Sitzung und
        // keine Fortsetzung der fremden.
        if z.id.as_deref() != sitzungs_id {
            z.druck.loslassen();
            *z = Zustand { id: sitzungs_id.map(str::to_string), ..Zustand::default() };
        }
        if z.stillgelegt {
            return Err(anyhow!(
                "Eingabe-Sitzung nach Protokollfehler stillgelegt — mit `remote_input_end` \
                 beenden und neu beginnen"
            ));
        }

        let bindung = match ziel::bindung_fuer_slot(slot) {
            Zielsuche::Gefunden(b) => b,
            // Unbekannter Slot: still verwerfen, Sitzung bleibt stehen (die
            // Ausnahme von fail-closed, begründet in [`ziel`]).
            Zielsuche::KeinStrom => return nur_handschlag(&mut z, frames, "unknown_slot"),
            Zielsuche::NichtAufloesbar(grund) => {
                eprintln!("[remote-input] Slot {slot}: Quelle nicht auflösbar ({grund}) → verworfen");
                return nur_handschlag(&mut z, frames, "unresolved_source");
            }
        };

        // Sichtschutz: solange geschwärzt wird, sieht der Steuernde nichts und
        // darf auch nichts tun — **sämtliche** Eingabe fällt weg.
        if bindung.wacht.is_some_and(|w| !w.is_source_visible()) {
            return nur_handschlag(&mut z, frames, "masked");
        }

        // Das Quell-Rechteck **einmal je Nachricht**, nicht je Frame: die Frames
        // einer Nachricht gehören zusammen (Bewegung → Klick), und ein Rechteck,
        // das mitten in der Nachricht springt, setzte den Klick woandershin als
        // die Bewegung davor.
        let rechteck = bindung.ziel.screen_rect();

        // Cursor-Echo: welcher Zeiger führt, sagt der Frame-Opcode. Absolute
        // Bewegungen heißen „der Steuernde sieht seinen eigenen Zeiger überm
        // Bild" → der Host-Cursor im Stream wäre nur ein nachlaufendes
        // Geisterbild und fliegt raus. Relative Bewegungen (Zeigerfang)
        // heißen „der lokale Zeiger ist versteckt" → der Host-Cursor ist der
        // einzige, den es gibt, und muss zurück ins Bild. Entschieden wird
        // NACH der Schleife, damit der letzte Opcode einer Nachricht gewinnt.
        let mut cursor_wunsch: Option<bool> = None;
        for roh in frames {
            let frame = match InputFrame::parse(roh) {
                Ok(f) => f,
                Err(e) => return Err(stilllegen(&mut z, format!("ungültiger Frame: {e}"))),
            };
            match frame {
                InputFrame::MouseMoveAbs { .. } => cursor_wunsch = Some(true),
                InputFrame::MouseMoveRel { .. } => cursor_wunsch = Some(false),
                _ => {}
            }
            let ergebnis = match frame {
                InputFrame::Hello { version } => handschlag(&mut z, version),
                // Handschlag-Tor: der erste Frame MUSS ein gültiges Hello sein.
                _ if !z.begruesst => Err("Eingabe vor dem Hello-Handschlag".to_string()),
                andere => ausfuehrung::einspielen(&mut z, rechteck, andere),
            };
            if let Err(grund) = ergebnis {
                return Err(stilllegen(&mut z, grund));
            }
        }
        match cursor_wunsch {
            Some(true) => crate::capture::cursorsteuerung::verbergen(),
            Some(false) => crate::capture::cursorsteuerung::zeigen(),
            None => {}
        }
        Ok(Bericht { verarbeitet: frames.len(), zustand: "live" })
    }

    /// Sitzung beenden: alles Gedrückte freigeben und den Zustand zurücksetzen,
    /// damit die nächste Sitzung wieder mit einem Hello beginnt. Idempotent —
    /// auch nach fail-closed und ohne je begonnene Sitzung aufrufbar.
    /// Liefert die Anzahl der freigegebenen Tasten und Knöpfe.
    pub fn beenden(&self) -> usize {
        // Cursor zurück in den Stream — das Sitzungsende ist die eine Stelle,
        // die JEDER Ausstiegsweg passiert (regulär, Verbindungsverlust,
        // fail-closed über `remote_input_end`).
        crate::capture::cursorsteuerung::zeigen();
        FERN_AKTIV.store(false, Ordering::Relaxed);
        let mut z = self.sperre();
        let n = z.druck.loslassen();
        *z = Zustand::default();
        n
    }

    /// Wie [`Self::beenden`], aber die Sitzung nimmt danach **nichts mehr an**.
    ///
    /// Für das Prozessende. Auf dem Fehler-Exit-Pfad gibt der Writer-Faden frei
    /// und ruft unmittelbar danach `process::exit` (`main.rs`) — ohne diese
    /// Sperre könnte der Dispatch-Faden in genau diesem Fenster noch eine
    /// wartende Nachricht einspielen. Der Prozess stürbe dann mit einer
    /// physisch gedrückten Taste, und es gäbe niemanden mehr, der sie löst.
    pub fn beenden_endgueltig(&self) -> usize {
        crate::capture::cursorsteuerung::zeigen();
        FERN_AKTIV.store(false, Ordering::Relaxed);
        let mut z = self.sperre();
        let n = z.druck.loslassen();
        *z = Zustand { geschlossen: true, ..Zustand::default() };
        n
    }

    /// Protokollfehler aus der **Hülle** statt aus einem Frame — missgeformter
    /// Slot, zu viele Frames, kaputtes Base64 ([`crate::ops::remote_input`]).
    /// Gleiche Folge wie bei einem missgeformten Frame: stilllegen, alles
    /// freigeben, melden. Ohne diesen Weg bliebe Gedrücktes ausgerechnet auf dem
    /// Pfad liegen, auf dem die Gegenseite nachweislich etwas falsch macht.
    pub fn protokollfehler(&self, grund: String) -> anyhow::Error {
        let mut z = self.sperre();
        stilllegen(&mut z, grund)
    }
}

/// Hello — Handschlag **und** Neuanfang.
///
/// Die Spezifikation ist hier normativ: „Ein weiteres Hello ist erlaubt und
/// bedeutet ‚neuer Eingabestrom'. Der Host gibt dabei alles Gedrückte frei und
/// beginnt mit leerem Zustand." Das ist keine Kosmetik, sondern die
/// Selbstheilung gegen klemmende Tasten — und die Gegenseite BAUT DARAUF: der
/// Steuernde leert beim Stromwechsel seine eigene Gedrückt-Menge, ohne
/// Hoch-Ereignisse zu erzeugen, weil der Host freigibt. Ohne die Freigabe hier
/// bliebe die Taste am fremden Rechner physisch unten, bis die ganze Sitzung
/// endet.
///
/// „Leerer Zustand" schließt die gemerkte Zeigerlage ein: der neue Strom hat
/// noch nichts positioniert, also darf vor seiner ersten Bewegung auch nichts
/// klicken.
fn handschlag(z: &mut Zustand, version: u8) -> Result<(), String> {
    if version != PROTOKOLL_VERSION {
        return Err(format!(
            "Eingabe-Protokoll Fassung {version}, erwartet {PROTOKOLL_VERSION}"
        ));
    }
    z.druck.loslassen();
    z.zeiger = None;
    z.begruesst = true;
    FERN_AKTIV.store(true, Ordering::Relaxed);
    Ok(())
}

/// Eine Nachricht verwerfen — **die Eingabe, nicht den Handschlag**, und mit
/// Freigabe.
///
/// Zwei Zusagen auf einmal:
///
/// * *Freigabe.* „Wird wegen unbekannten Slots, unauflösbarer Quelle oder
///   geschwärzten Sichtschutzes verworfen, gibt der Host trotzdem alles
///   Gedrückte frei." Es genügt, dass der Host sein gestreamtes Fenster
///   minimiert — die Quelle löst dann nicht mehr auf, und ohne Freigabe
///   verschluckt genau dieser Pfad das Hoch-Ereignis.
/// * *Handschlag.* Der ist **Sitzungszustand**, keine Eingabe. Lag er in dieser
///   Nachricht, gilt er auch dann, wenn die Frames verworfen werden — sonst
///   bliebe `begruesst` falsch und die nächste Nachricht liefe in „Eingabe vor
///   dem Hello-Handschlag", also in fail-closed, und der Renderer beendete die
///   ganze Sitzung. Auslöser dafür sind Alltagsfälle: der Stream läuft gerade
///   an, der Sichtschutz schwärzt genau dann, der Sidecar wurde neu gestartet.
///
/// Missgeformte Frames werden hier **nicht** bewertet: die Eingabe dieser
/// Nachricht ist ohnehin verworfen, und ein Parse-Fehler auf einem Slot, den es
/// gerade nicht gibt, ist kein Anlass, die Sitzung zu beenden (die Frames
/// stammen aus einem Rennen, nicht aus einem Angriff). Eine falsche
/// **Hello-Fassung** dagegen ist kein Rennen und bleibt fail-closed.
fn nur_handschlag(z: &mut Zustand, frames: &[Vec<u8>], zustand: &'static str) -> Result<Bericht> {
    for roh in frames {
        let Ok(InputFrame::Hello { version }) = InputFrame::parse(roh) else {
            continue;
        };
        if let Err(grund) = handschlag(z, version) {
            return Err(stilllegen(z, grund));
        }
    }
    z.druck.loslassen();
    Ok(Bericht { verarbeitet: 0, zustand })
}

/// Fail-closed: stilllegen, alles freigeben, Zustand melden. Der Fehler geht
/// zusätzlich als Antwort auf die Operation zurück.
fn stilllegen(z: &mut Zustand, grund: String) -> anyhow::Error {
    z.stillgelegt = true;
    z.druck.loslassen();
    z.zeiger = None;
    // Fail-closed heißt: diese Sitzung steuert nichts mehr — der Stream läuft
    // aber weiter, seine Zuschauer bekommen den Cursor zurück und der
    // Pacing-Loop sein glättendes Tick-Raster.
    crate::capture::cursorsteuerung::zeigen();
    FERN_AKTIV.store(false, Ordering::Relaxed);
    eprintln!("[remote-input] fail-closed: {grund}");
    crate::events::emit(serde_json::json!({
        "ev": "remote_state",
        "state": "input_error",
        "reason": grund,
    }));
    anyhow!(grund)
}

/// Prüfstand-Sperre für alle Tests, die an den **prozessweiten** Singletons
/// hängen (Sitzung und Stream-Registrierung).
///
/// Ohne Reihenfolge liefen die Tests beider Module ineinander: einer meldet
/// einen Strom an, während der andere „kein Strom" erwartet. Beim Nehmen wird
/// gleich aufgeräumt, damit kein Test die Hinterlassenschaft eines anderen
/// sieht. Vergiftete Sperre (Panik in einem Test) wird übernommen — sonst
/// scheiterten danach alle übrigen an der Sperre statt an ihrer eigenen Sache.
#[cfg(test)]
pub(crate) fn pruefstand() -> std::sync::MutexGuard<'static, ()> {
    static SPERRE: Mutex<()> = Mutex::new(());
    let sperre = SPERRE.lock().unwrap_or_else(|e| e.into_inner());
    ziel::strom_beendet();
    Sitzung::singleton().beenden();
    let _ = injektion::pruefspur::nimm();
    sperre
}
