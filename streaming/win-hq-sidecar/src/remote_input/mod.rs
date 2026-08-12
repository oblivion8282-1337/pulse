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
//! Aufteilung: [`rahmen`] parst, [`zuordnung`] rechnet Koordinaten um, [`ziel`]
//! löst den Slot in eine Aufnahmequelle auf, [`injektion`] ruft `SendInput`.
//! Dieses Modul hält die **Sitzung** zusammen — und damit die zwei Zusagen, an
//! denen die Fernsteuerung hängt:
//!
//! * **Alles loslassen beim Ende.** Die Menge des Gedrückten wird mitgeführt und
//!   bei jedem Sitzungsende freigegeben — regulär, bei Verbindungsverlust, bei
//!   fail-closed und beim Prozessende. Ohne das läuft nach einem Abbruch die
//!   W-Taste im Spiel für immer weiter.
//! * **Fail-closed.** Unbekannter Opcode, falsche Länge, fehlendes oder falsches
//!   Hello, unbekannter Knopf → Sitzung stilllegen, alles freigeben, Zustand
//!   melden. Die Eingabe kommt vom einzigen, per Consent bestätigten Gegenüber;
//!   alles Missgeformte ist ein Fehler oder ein Angriff. **Ausnahme:**
//!   unbekannter Slot (Begründung in [`ziel`]).

pub mod base64;
pub mod injektion;
pub mod rahmen;
pub mod ziel;
pub mod zuordnung;

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use anyhow::{Result, anyhow};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_MOVE, MOUSEEVENTF_VIRTUALDESK,
    MOUSEEVENTF_WHEEL,
};

use rahmen::{InputFrame, PROTOKOLL_VERSION};
use ziel::{Bindung, Zielsuche};

/// Was aus einer Nachricht wurde — geht als Antwortfelder zurück an den
/// Aufrufer und ist damit das, woran die Abnahme misst.
pub struct Bericht {
    pub verarbeitet: usize,
    /// `live` · `unknown_slot` · `unresolved_source` · `masked` · `ended`
    pub zustand: &'static str,
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
struct Zustand {
    /// Die Kennung der laufenden Sitzung — wechselt sie, ist es eine neue
    /// Sitzung: alles Gedrückte der alten wird freigegeben.
    id: Option<String>,
    /// Hello empfangen? Der erste Frame MUSS eines sein.
    begruesst: bool,
    /// Nach einem Protokollfehler stillgelegt → weitere Frames werden abgewiesen,
    /// bis die Sitzung beendet wird.
    stillgelegt: bool,
    /// Gedrückte Maustasten (btn-Code) — fürs Loslassen beim Ende.
    knoepfe: HashSet<u8>,
    /// Gedrückte Tasten (voller Scancode inkl. `0xE0`-Präfix) — dito.
    tasten: HashSet<u16>,
}

impl Sitzung {
    pub fn singleton() -> &'static Sitzung {
        static INSTANCE: OnceLock<Sitzung> = OnceLock::new();
        INSTANCE.get_or_init(|| Sitzung { inner: Mutex::new(Zustand::default()) })
    }

    /// Eine Nachricht voller Frames verarbeiten. `slot` und `sitzungs_id` kommen
    /// aus der **Hülle**, nicht aus den Frames (Spezifikation).
    ///
    /// `Err` = fail-closed: die Sitzung ist danach stillgelegt und der Aufrufer
    /// soll sie beenden. `Ok` mit `zustand != "live"` = still verworfen, die
    /// Sitzung steht weiter.
    pub fn frames(
        &self,
        slot: u32,
        sitzungs_id: Option<&str>,
        frames: &[Vec<u8>],
    ) -> Result<Bericht> {
        let mut z = self.inner.lock().unwrap();

        // Sitzungswechsel ohne vorheriges Ende (Verbindung weg, Gegenüber
        // gewechselt): erst die alte auflösen, sonst hinge deren Gedrücktes.
        if let Some(id) = sitzungs_id {
            if z.id.as_deref() != Some(id) {
                loslassen(&mut z);
                *z = Zustand { id: Some(id.to_string()), ..Zustand::default() };
            }
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
            Zielsuche::KeinStrom => {
                return Ok(Bericht { verarbeitet: 0, zustand: "unknown_slot" });
            }
            Zielsuche::NichtAufloesbar(grund) => {
                eprintln!("[remote-input] Slot {slot}: Quelle nicht auflösbar ({grund}) → verworfen");
                return Ok(Bericht { verarbeitet: 0, zustand: "unresolved_source" });
            }
        };

        // Sichtschutz: solange geschwärzt wird, sieht der Steuernde nichts und
        // darf auch nichts tun — **sämtliche** Eingabe fällt weg. Freigeben, was
        // schon gedrückt war, sonst klemmte es für die Dauer der Schwärzung.
        if bindung.wacht.is_some_and(|w| !w.is_source_visible()) {
            loslassen(&mut z);
            return Ok(Bericht { verarbeitet: 0, zustand: "masked" });
        }

        for roh in frames {
            let frame = match InputFrame::parse(roh) {
                Ok(f) => f,
                Err(e) => return Err(stilllegen(&mut z, format!("ungültiger Frame: {e}"))),
            };
            if let Err(grund) = einspielen(&mut z, &bindung, frame) {
                return Err(stilllegen(&mut z, grund));
            }
        }
        Ok(Bericht { verarbeitet: frames.len(), zustand: "live" })
    }

    /// Sitzung beenden: alles Gedrückte freigeben und den Zustand zurücksetzen,
    /// damit die nächste Sitzung wieder mit einem Hello beginnt. Idempotent —
    /// auch nach fail-closed und ohne je begonnene Sitzung aufrufbar.
    /// Liefert die Anzahl der freigegebenen Tasten und Knöpfe.
    pub fn beenden(&self) -> usize {
        let mut z = self.inner.lock().unwrap();
        let n = loslassen(&mut z);
        *z = Zustand::default();
        n
    }
}

/// Einen geprüften Frame ausführen. `Err(grund)` = fail-closed.
fn einspielen(z: &mut Zustand, bindung: &Bindung, frame: InputFrame) -> Result<(), String> {
    // Handschlag-Tor: der erste Frame MUSS ein gültiges Hello sein.
    if let InputFrame::Hello { version } = frame {
        if version != PROTOKOLL_VERSION {
            return Err(format!(
                "Eingabe-Protokoll Fassung {version}, erwartet {PROTOKOLL_VERSION}"
            ));
        }
        z.begruesst = true;
        return Ok(());
    }
    if !z.begruesst {
        return Err("Eingabe vor dem Hello-Handschlag".to_string());
    }

    match frame {
        InputFrame::Hello { .. } => {} // oben behandelt
        InputFrame::MouseMoveAbs { x, y } => {
            // Kein Rechteck (Bildschirm abgesteckt, Fenster zu) → nichts
            // zu rechnen. Kein Protokollfehler: die Welt hat sich geändert.
            if let Some(rect) = bindung.ziel.screen_rect() {
                let (px, py) = zuordnung::anteil_auf_punkt(x, y, &rect);
                let vd = zuordnung::virtueller_desktop();
                let (nx, ny) = zuordnung::punkt_auf_absolut(px, py, &vd);
                injektion::maus(
                    nx,
                    ny,
                    0,
                    MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                );
            }
        }
        // Ohne `ABSOLUTE` — Windows legt seine Beschleunigung darauf, und
        // genau das ist im Zeigerfang-Fall (Spiele) erwünscht.
        InputFrame::MouseMoveRel { dx, dy } => {
            injektion::maus(dx as i32, dy as i32, 0, MOUSEEVENTF_MOVE);
        }
        InputFrame::MouseButton { btn, down } => {
            let (flag, daten) = injektion::tasten_ereignis(btn, down)
                .ok_or_else(|| format!("unbekannte Maustaste: {btn}"))?;
            injektion::maus(0, 0, daten, flag);
            vermerken(&mut z.knoepfe, btn, down);
        }
        InputFrame::MouseWheel { dv, dh } => {
            if dv != 0 {
                injektion::maus(0, 0, dv as i32, MOUSEEVENTF_WHEEL);
            }
            if dh != 0 {
                injektion::maus(0, 0, dh as i32, MOUSEEVENTF_HWHEEL);
            }
        }
        InputFrame::Key { scan, down } => {
            injektion::taste(scan, down);
            vermerken(&mut z.tasten, scan, down);
        }
    }
    Ok(())
}

/// Fail-closed: stilllegen, alles freigeben, Zustand melden. Der Fehler geht
/// zusätzlich als Antwort auf die Operation zurück.
fn stilllegen(z: &mut Zustand, grund: String) -> anyhow::Error {
    z.stillgelegt = true;
    loslassen(z);
    eprintln!("[remote-input] fail-closed: {grund}");
    crate::events::emit(serde_json::json!({
        "ev": "remote_state",
        "state": "input_error",
        "reason": grund,
    }));
    anyhow!(grund)
}

/// Alles Gedrückte freigeben. Liefert, wie viel es war.
fn loslassen(z: &mut Zustand) -> usize {
    let knoepfe = std::mem::take(&mut z.knoepfe);
    let tasten = std::mem::take(&mut z.tasten);
    let n = knoepfe.len() + tasten.len();
    for btn in knoepfe {
        if let Some((flag, daten)) = injektion::tasten_ereignis(btn, false) {
            injektion::maus(0, 0, daten, flag);
        }
    }
    for scan in tasten {
        injektion::taste(scan, false);
    }
    n
}

/// Druckzustand nachführen: runter merkt sich die Taste, hoch vergisst sie.
fn vermerken<T: Eq + std::hash::Hash>(menge: &mut HashSet<T>, was: T, down: bool) {
    if down {
        menge.insert(was);
    } else {
        menge.remove(&was);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Ohne Stream (und ohne Labor-Schalter) ist der Slot unbekannt: still
    /// verworfen, **kein** Fehler — die Sitzung darf daran nicht sterben.
    #[test]
    fn unbekannter_slot_beendet_die_sitzung_nicht() {
        ziel::strom_beendet();
        if crate::env::flag("PULSE_LABOR_EINGABE_OHNE_STREAM") {
            return; // Labor-Weg: dann gibt es ein Ersatzrechteck, s. `ziel`.
        }
        let s = Sitzung::singleton();
        s.beenden();
        let b = s
            .frames(9, Some("test-unbekannter-slot"), &[vec![0x00, 2]])
            .expect("unbekannter Slot ist kein Fehler");
        assert_eq!(b.zustand, "unknown_slot");
        assert_eq!(b.verarbeitet, 0);
        s.beenden();
    }

    /// Nichts gedrückt → nichts freizugeben, und das beliebig oft.
    #[test]
    fn beenden_ist_idempotent() {
        let s = Sitzung::singleton();
        assert_eq!(s.beenden(), 0);
        assert_eq!(s.beenden(), 0);
    }

    #[test]
    fn vermerken_fuehrt_den_druckzustand() {
        let mut menge: HashSet<u16> = HashSet::new();
        vermerken(&mut menge, 0x11, true);
        vermerken(&mut menge, 0x1E, true);
        assert_eq!(menge.len(), 2);
        vermerken(&mut menge, 0x11, false);
        assert_eq!(menge.iter().copied().collect::<Vec<_>>(), vec![0x1E]);
    }
}
