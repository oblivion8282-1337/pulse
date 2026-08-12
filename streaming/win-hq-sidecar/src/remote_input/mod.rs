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
//!   W-Taste im Spiel für immer weiter. **Auch eine VERWORFENE Nachricht gibt
//!   frei** (unbekannter Slot, unauflösbare Quelle, geschwärzter Sichtschutz) —
//!   sonst genügt es, dass der Host sein gestreamtes Fenster minimiert, damit
//!   ein Hoch-Ereignis verschluckt wird und die Taste am fremden Rechner
//!   weiterläuft.
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
    /// Endgültig zu (Prozess fährt herunter) → gar nichts wird mehr injiziert,
    /// auch keine neue Sitzung. Nur [`Sitzung::beenden_endgueltig`] setzt es.
    geschlossen: bool,
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
        slot: u64,
        sitzungs_id: Option<&str>,
        frames: &[Vec<u8>],
    ) -> Result<Bericht> {
        let mut z = self.inner.lock().unwrap();

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
            Zielsuche::KeinStrom => return Ok(verworfen(&mut z, "unknown_slot")),
            Zielsuche::NichtAufloesbar(grund) => {
                eprintln!("[remote-input] Slot {slot}: Quelle nicht auflösbar ({grund}) → verworfen");
                return Ok(verworfen(&mut z, "unresolved_source"));
            }
        };

        // Sichtschutz: solange geschwärzt wird, sieht der Steuernde nichts und
        // darf auch nichts tun — **sämtliche** Eingabe fällt weg.
        if bindung.wacht.is_some_and(|w| !w.is_source_visible()) {
            return Ok(verworfen(&mut z, "masked"));
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

    /// Wie [`Self::beenden`], aber die Sitzung nimmt danach **nichts mehr an**.
    ///
    /// Für das Prozessende. Auf dem Fehler-Exit-Pfad gibt der Writer-Faden frei
    /// und ruft unmittelbar danach `process::exit` (`main.rs`) — ohne diese
    /// Sperre könnte der Dispatch-Faden in genau diesem Fenster noch eine
    /// wartende Nachricht einspielen. Der Prozess stürbe dann mit einer
    /// physisch gedrückten Taste, und es gäbe niemanden mehr, der sie löst.
    pub fn beenden_endgueltig(&self) -> usize {
        let mut z = self.inner.lock().unwrap();
        let n = loslassen(&mut z);
        *z = Zustand { geschlossen: true, ..Zustand::default() };
        n
    }

    /// Protokollfehler aus der **Hülle** statt aus einem Frame — heute der
    /// missgeformte Slot ([`crate::ops::remote_input`]). Gleiche Folge wie bei
    /// einem missgeformten Frame: stilllegen, alles freigeben, melden. Ohne
    /// diesen Weg bliebe Gedrücktes ausgerechnet auf dem Pfad liegen, auf dem
    /// die Gegenseite nachweislich etwas falsch macht.
    pub fn protokollfehler(&self, grund: String) -> anyhow::Error {
        let mut z = self.inner.lock().unwrap();
        stilllegen(&mut z, grund)
    }
}

/// Eine Nachricht verwerfen — **mit Freigabe**. Die Spezifikation sagt das
/// ausdrücklich: „Wird wegen unbekannten Slots, unauflösbarer Quelle oder
/// geschwärzten Sichtschutzes verworfen, gibt der Host trotzdem alles Gedrückte
/// frei." Es genügt, dass der Host sein gestreamtes Fenster minimiert — die
/// Quelle löst dann nicht mehr auf, und ohne Freigabe verschluckt genau dieser
/// Pfad das Hoch-Ereignis: die Taste läuft am fremden Rechner weiter, bis die
/// ganze Sitzung endet.
fn verworfen(z: &mut Zustand, zustand: &'static str) -> Bericht {
    loslassen(z);
    Bericht { verarbeitet: 0, zustand }
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
            // Kein Rechteck (Bildschirm abgesteckt, Fenster zu) oder ein
            // entartetes (gecloaktes Fenster, s. `zuordnung`) → nichts zu
            // rechnen. Kein Protokollfehler: die Welt hat sich geändert.
            let punkt = bindung
                .ziel
                .screen_rect()
                .and_then(|rect| zuordnung::anteil_auf_punkt(x, y, &rect));
            if let Some((px, py)) = punkt {
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
            // Missgeformter Scancode → beenden statt raten (Spezifikation). Ein
            // `0xE11D` würde sonst als linke Strg-Taste injiziert, weil `wScan`
            // nur das niederwertige Byte trägt — und bliebe gedrückt.
            if !injektion::scancode_gueltig(scan) {
                return Err(format!(
                    "missgeformter Scancode {scan:#06x} — Satz 1 kennt nur 0x00xx und 0xE0xx"
                ));
            }
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
    use injektion::pruefspur::{self, Ereignis};

    /// Ohne echten Stream lässt sich kein Gedrücktes über die Frames aufbauen
    /// (es gäbe kein Ziel). Für die Freigabe-Tests wird der Druckzustand
    /// deshalb direkt gesetzt — geprüft wird ja, was beim VERWERFEN passiert,
    /// nicht wie es dazu kam.
    fn gedrueckt(s: &Sitzung, tasten: &[u16], knoepfe: &[u8]) {
        let mut z = s.inner.lock().unwrap();
        z.tasten.extend(tasten.iter().copied());
        z.knoepfe.extend(knoepfe.iter().copied());
    }

    fn ist_noch_gedrueckt(s: &Sitzung) -> usize {
        let z = s.inner.lock().unwrap();
        z.tasten.len() + z.knoepfe.len()
    }

    /// Ohne Stream (und ohne Labor-Schalter) ist der Slot unbekannt: still
    /// verworfen, **kein** Fehler — die Sitzung darf daran nicht sterben.
    #[test]
    fn unbekannter_slot_beendet_die_sitzung_nicht() {
        let _sperre = pruefstand();
        if crate::env::flag("PULSE_LABOR_EINGABE_OHNE_STREAM") {
            return; // Labor-Weg: dann gibt es ein Ersatzrechteck, s. `ziel`.
        }
        let s = Sitzung::singleton();
        let b = s
            .frames(9, Some("test-unbekannter-slot"), &[vec![0x00, 2]])
            .expect("unbekannter Slot ist kein Fehler");
        assert_eq!(b.zustand, "unknown_slot");
        assert_eq!(b.verarbeitet, 0);
        s.beenden();
    }

    /// **Der Fund:** eine verworfene Nachricht gab früher zurück, ohne
    /// freizugeben — alles Gedrückte blieb am Host physisch gedrückt. Es
    /// genügt, dass der Host sein gestreamtes Fenster minimiert, damit die
    /// Quelle nicht mehr auflöst und das Key-Up in diesem Zweig verschwindet.
    #[test]
    fn verworfene_nachricht_gibt_trotzdem_frei() {
        let _sperre = pruefstand();
        if crate::env::flag("PULSE_LABOR_EINGABE_OHNE_STREAM") {
            return;
        }
        let s = Sitzung::singleton();
        gedrueckt(s, &[0x11, 0xE01D], &[0]); // W, rechte Strg, linke Maustaste
        let b = s
            .frames(9, Some("test-freigabe"), &[vec![0x00, 2]])
            .expect("unbekannter Slot ist kein Fehler");
        assert_eq!(b.zustand, "unknown_slot");
        assert_eq!(ist_noch_gedrueckt(s), 0, "nichts darf gedrückt bleiben");

        // Und es wurde wirklich losgelassen, nicht nur vergessen: für jede
        // Taste ein Hoch-Ereignis, für den Knopf ein Maus-Ereignis.
        let spur = pruefspur::nimm();
        assert!(
            spur.contains(&Ereignis::Taste { scan: 0x11, hoch: true }),
            "W-Taste nicht losgelassen: {spur:?}"
        );
        assert!(
            spur.contains(&Ereignis::Taste { scan: 0x1D, hoch: true }),
            "rechte Strg-Taste nicht losgelassen: {spur:?}"
        );
        assert_eq!(
            spur.iter().filter(|e| matches!(e, Ereignis::Maus { .. })).count(),
            1,
            "genau ein Knopf-Hoch: {spur:?}"
        );
        s.beenden();
    }

    /// Dieselbe Zusage auf dem Weg über die Hülle: ein missgeformter Slot ist
    /// ein Protokollfehler — stilllegen, aber nicht ohne Freigabe.
    #[test]
    fn protokollfehler_der_huelle_gibt_frei_und_legt_still() {
        let _sperre = pruefstand();
        let s = Sitzung::singleton();
        gedrueckt(s, &[0x11], &[]);
        let fehler = s.protokollfehler("slot ist keine Zahl".to_string());
        assert!(fehler.to_string().contains("slot"));
        assert_eq!(ist_noch_gedrueckt(s), 0);
        assert!(
            pruefspur::nimm().contains(&Ereignis::Taste { scan: 0x11, hoch: true }),
            "die gedrückte Taste muss losgelassen worden sein"
        );
        // Stillgelegt: weitere Frames werden abgewiesen, bis beendet wird.
        assert!(s.frames(0, None, &[vec![0x00, 2]]).is_err());
        s.beenden();
        s.beenden();
    }

    /// Nach dem endgültigen Schluss (Prozessende) darf **nichts** mehr
    /// injiziert werden — auch nicht von einer Nachricht, die im Dispatch-Faden
    /// schon auf der Sperre wartete, während der Writer-Faden freigab und
    /// `process::exit` ansteuerte.
    #[test]
    fn nach_endgueltigem_schluss_wird_nichts_mehr_eingespielt() {
        let _sperre = pruefstand();
        let s = Sitzung::singleton();
        gedrueckt(s, &[0x11], &[]);
        assert_eq!(s.beenden_endgueltig(), 1);
        let _ = pruefspur::nimm();
        let b = s
            .frames(0, Some("test-nach-schluss"), &[vec![0x05, 0x11, 0x00, 1]])
            .expect("geschlossen ist kein Fehler, nur folgenlos");
        assert_eq!(b.zustand, "ended");
        assert_eq!(b.verarbeitet, 0);
        assert!(pruefspur::nimm().is_empty(), "es darf nichts injiziert werden");
        s.beenden(); // wieder öffnen, sonst sähe der nächste Test „ended"
    }

    /// Nichts gedrückt → nichts freizugeben, und das beliebig oft.
    #[test]
    fn beenden_ist_idempotent() {
        let _sperre = pruefstand();
        let s = Sitzung::singleton();
        assert_eq!(s.beenden(), 0);
        assert_eq!(s.beenden(), 0);
    }

    /// Ein Scancode außerhalb von Satz 1 wird abgewiesen, statt als eine
    /// ANDERE Taste injiziert zu werden (`0xE11D` → linke Strg-Taste). Geprüft
    /// auf der Ebene, die entscheidet: `einspielen`.
    #[test]
    fn missgeformter_scancode_ist_fail_closed() {
        let _ = pruefspur::nimm(); // eigene Spur, unabhängig von der Sperre
        let mut z = Zustand { begruesst: true, ..Zustand::default() };
        let bindung = Bindung {
            ziel: ziel::InjectTarget::Monitor(0),
            wacht: None,
        };
        let fehler = einspielen(
            &mut z,
            &bindung,
            InputFrame::Key { scan: 0xE11D, down: true },
        )
        .expect_err("0xE11D darf nicht injiziert werden");
        assert!(fehler.contains("0xe11d"), "{fehler}");
        assert!(z.tasten.is_empty(), "nichts darf gemerkt worden sein");
        assert!(
            pruefspur::nimm().is_empty(),
            "und schon gar nichts injiziert"
        );
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
