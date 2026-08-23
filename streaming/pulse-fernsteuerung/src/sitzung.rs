//! Fernsteuerung — die Sitzung auf dem Host (Wire-Protokoll **v2**).
//!
//! Verbindlich ist `docs/plans/2026-08-12-input-wire-protokoll-v2.md`. Der
//! Steuernde (`pulse-player` bzw. Electron) erzeugt die Frames, der Gateway
//! reicht sie **unangetastet** durch, der Sidecar der jeweiligen Plattform
//! parst und injiziert sie. Hereingereicht werden sie über die stdio-Operation
//! `remote_input`; dasselbe Frame-Format trägt auch der P2P-Weg
//! (WebRTC-DataChannel), der auf `feat/remote-control-windows` liegt —
//! deshalb steht hier nichts über den Träger, nur über die Frames.
//!
//! Aufteilung: [`crate::rahmen`] parst, `ausfuehrung` entscheidet was injiziert
//! wird, [`crate::zuordnung`] rechnet Koordinaten um, [`Umgebung::ziel`] löst
//! den Slot in eine Aufnahmequelle auf, der [`Injektor`] feuert ab, und die
//! [`Wache`] merkt, ob der Host selbst an seinem Gerät sitzt. Dieses Modul hält
//! die **Sitzung** zusammen — und damit die Zusagen, an denen die Fernsteuerung
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
//!   unbekannter Slot (Begründung in [`Zielsuche::KeinStrom`]).
//! * **Der Handschlag ist Sitzungszustand, keine Eingabe.** Er wird auch dann
//!   verarbeitet, wenn die Eingabe-Frames derselben Nachricht verworfen werden
//!   (`nur_handschlag`). Sonst tötete ein Hello, das zufällig in eine
//!   Verwerf-Lage fällt (Stream läuft gerade an, Sichtschutz schwärzt genau
//!   dann), die Sitzung eine Nachricht später mit „Eingabe vor dem
//!   Hello-Handschlag".
//! * **Der Host hat Vorrang.** Regt sich der Host selbst an Maus oder Tastatur,
//!   wird die Fremdeingabe verworfen, bis er einige Sekunden Ruhe gegeben hat
//!   ([`Wache`], [`Sitzung::vorrang_tick`]). Die Sitzung bleibt dabei stehen —
//!   es ist ein Stummschalten, kein Abbruch; der Not-Aus daneben bleibt der
//!   harte Weg. Umgesetzt über denselben Verwerf-Pfad wie Sichtschutz und
//!   unbekannter Slot, und damit samt Freigabe: sonst liefe die W-Taste des
//!   Steuernden weiter, während der Host übernimmt.
//! * **Keine Panik nimmt die Freigabe mit.** Alle Zugriffe auf den Zustand gehen
//!   über `Sitzung::sperre`, das eine **vergiftete** Sperre übernimmt. Sonst
//!   panikte ausgerechnet [`Sitzung::beenden_endgueltig`] und alles Gedrückte
//!   bliebe unten.

use std::sync::atomic::AtomicU64;
use std::sync::{Mutex, MutexGuard};

use crate::ausfuehrung;
use crate::format::PROTOKOLL_VERSION;
use crate::plattform::{Injektor, Umgebung, Wache, Zielsuche};
use crate::rahmen::InputFrame;

/// Der Vorrang des Hosts — Methoden auf [`Sitzung`], nur in einer eigenen
/// Datei: zusammen mit der Zustandsmaschine lag diese Datei über der harten
/// Grenze der Größen-Policy.
mod vorrang;

/// Was aus einer Nachricht wurde — geht als Antwortfelder zurück an den
/// Aufrufer und ist damit das, woran die Abnahme misst.
///
/// `Debug` nicht der Zierde wegen: ohne es sind `Result::expect_err` und
/// `unwrap_err` auf `frames` unbenutzbar, und ein Test, der fail-closed
/// belegen will, muss auf `let Err(…) else` ausweichen.
#[derive(Debug)]
pub struct Bericht {
    pub verarbeitet: usize,
    /// `live` · `unknown_slot` · `unresolved_source` · `masked` · `host_active`
    /// · `ended`
    pub zustand: &'static str,
}

/// Die eine Fernsteuer-Sitzung eines Sidecar-Prozesses.
///
/// Eine reicht: der Consent bestätigt genau ein Gegenüber, und ein Sidecar
/// fährt genau einen Stream. Alles steht hinter **einer** Sperre — Injektion
/// und Zustandsführung dürfen nicht auseinanderlaufen, sonst liegt zwischen
/// dem physischen Druck und dem Vermerk darüber ein Fenster, in dem ein
/// Sitzungsende die Taste am Host hängen lässt.
///
/// **Die Plattform ist ein Feld, kein Singleton.** Dadurch braucht diese Kiste
/// keinen globalen Zustand: jeder Test baut sich eine eigene Sitzung mit
/// eigenem Prüfstand, und es gibt keine Reihenfolge zwischen Tests zu
/// verwalten. Der Sidecar-Prozess hält seine eine Sitzung selbst.
pub struct Sitzung {
    inner: Mutex<Zustand>,
    injektor: &'static dyn Injektor,
    wache: &'static dyn Wache,
    umgebung: &'static dyn Umgebung,
    /// Wecker seit der letzten Vorrang-Meldung (s. `vorrang::WIEDERHOLUNG_TAKTE`).
    seit_meldung: AtomicU64,
}

#[derive(Default)]
pub(crate) struct Zustand {
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
    /// Hat der Host gerade Vorrang? Gespiegelt aus der Wache, damit die
    /// Übergänge (freigeben, Zeiger zurück, Meldung) genau **einmal** laufen
    /// und nicht bei jeder Nachricht.
    vorrang: bool,
    /// Zeigerlage und Gedrücktes — führt die Ausführung fort.
    pub(crate) tat: ausfuehrung::Tat,
}

impl Sitzung {
    pub fn neu(
        injektor: &'static dyn Injektor,
        wache: &'static dyn Wache,
        umgebung: &'static dyn Umgebung,
    ) -> Self {
        Self {
            inner: Mutex::new(Zustand::default()),
            injektor,
            wache,
            umgebung,
            seit_meldung: AtomicU64::new(0),
        }
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
    /// `fremder_vorrang` meldet, dass ein **anderer** Stream-Platz dieses
    /// Rechners gerade Vorrang meldet. Nur der Renderer des Hosts weiß das: die
    /// Wache sitzt je Sidecar-PROZESS, und ein Prozess sieht die anderen nicht
    /// (Begründung in `web/src/lib/remote/vorrang.ts`). Der Wert kann die
    /// Eingabe ausschließlich einschränken, nie erweitern.
    pub fn frames(
        &self,
        slot: u64,
        sitzungs_id: Option<&str>,
        frames: &[Vec<u8>],
        fremder_vorrang: bool,
    ) -> Result<Bericht, String> {
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
            z.tat.druck.loslassen(self.injektor);
            *z = Zustand { id: sitzungs_id.map(str::to_string), ..Zustand::default() };
        }
        if z.stillgelegt {
            return Err("Eingabe-Sitzung nach Protokollfehler stillgelegt — mit \
                        `remote_input_end` beenden und neu beginnen"
                .to_string());
        }

        // **Vorrang des Hosts** — vor der Slot-Auflösung, denn er gilt
        // unabhängig davon, welcher Stream gemeint ist. Nachgeführt wird hier
        // ein zweites Mal (der Wecker der Wache tut es alle 100 ms): eine
        // Nachricht, die zwischen zwei Weckern eintrifft, soll nicht noch
        // injiziert werden, nachdem der Host schon die Maus angefasst hat.
        // Der eigene Vorrang wird nachgeführt (Übergänge, Freigabe, Meldung),
        // der fremde nur beachtet — er gehört der Wache eines anderen
        // Prozesses, und zwei Wachen dürfen sich nicht gegenseitig die
        // Übergänge melden.
        let eigener = self.vorrang_nachfuehren(&mut z);
        if eigener || fremder_vorrang {
            return self.nur_handschlag(&mut z, frames, "host_active");
        }

        // Das Quell-Rechteck **einmal je Nachricht**, nicht je Frame: die Frames
        // einer Nachricht gehören zusammen (Bewegung → Klick), und ein Rechteck,
        // das mitten in der Nachricht springt, setzte den Klick woandershin als
        // die Bewegung davor.
        let (rechteck, sichtbar) = match self.umgebung.ziel(slot) {
            Zielsuche::Gefunden { rechteck, sichtbar } => (rechteck, sichtbar),
            // Unbekannter Slot: still verwerfen, Sitzung bleibt stehen (die
            // Ausnahme von fail-closed, begründet in [`Zielsuche::KeinStrom`]).
            Zielsuche::KeinStrom => {
                return self.nur_handschlag(&mut z, frames, "unknown_slot");
            }
            Zielsuche::NichtAufloesbar(grund) => {
                eprintln!(
                    "[remote-input] Slot {slot}: Quelle nicht auflösbar ({grund}) → verworfen"
                );
                return self.nur_handschlag(&mut z, frames, "unresolved_source");
            }
        };

        // Sichtschutz: solange geschwärzt wird, sieht der Steuernde nichts und
        // darf auch nichts tun — **sämtliche** Eingabe fällt weg.
        if !sichtbar {
            return self.nur_handschlag(&mut z, frames, "masked");
        }

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
                Err(e) => return Err(self.stilllegen(&mut z, format!("ungültiger Frame: {e}"))),
            };
            match frame {
                InputFrame::MouseMoveAbs { .. } => cursor_wunsch = Some(true),
                InputFrame::MouseMoveRel { .. } => cursor_wunsch = Some(false),
                _ => {}
            }
            let ergebnis = match frame {
                InputFrame::Hello { version } => self.handschlag(&mut z, version),
                // Handschlag-Tor: der erste Frame MUSS ein gültiges Hello sein.
                _ if !z.begruesst => Err("Eingabe vor dem Hello-Handschlag".to_string()),
                andere => ausfuehrung::einspielen(&mut z.tat, self.injektor, rechteck, andere),
            };
            if let Err(grund) = ergebnis {
                return Err(self.stilllegen(&mut z, grund));
            }
        }
        match cursor_wunsch {
            Some(true) => self.umgebung.host_zeiger_zeigen(false),
            Some(false) => self.umgebung.host_zeiger_zeigen(true),
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
        self.fern_abschalten();
        let mut z = self.sperre();
        let n = z.tat.druck.loslassen(self.injektor);
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
        self.fern_abschalten();
        let mut z = self.sperre();
        let n = z.tat.druck.loslassen(self.injektor);
        *z = Zustand { geschlossen: true, ..Zustand::default() };
        n
    }

    /// Protokollfehler aus der **Hülle** statt aus einem Frame — missgeformter
    /// Slot, zu viele Frames, kaputtes Base64 ([`crate::huelle`]).
    /// Gleiche Folge wie bei einem missgeformten Frame: stilllegen, alles
    /// freigeben, melden. Ohne diesen Weg bliebe Gedrücktes ausgerechnet auf dem
    /// Pfad liegen, auf dem die Gegenseite nachweislich etwas falsch macht.
    pub fn protokollfehler(&self, grund: String) -> String {
        let mut z = self.sperre();
        self.stilllegen(&mut z, grund)
    }

    /// Was ein Sitzungsende nach AUSSEN bedeutet: Host-Zeiger zurück in den
    /// Stream, Aufnahme-Takt zurück auf sein glättendes Raster, Wache
    /// abgebaut.
    ///
    /// **An einer Stelle, weil das zusammengehört.** Es gibt drei
    /// Ausstiegswege ([`Self::beenden`], [`Self::beenden_endgueltig`] und
    /// fail-closed in `stilllegen`); einer, der nur die Hälfte täte,
    /// ließe entweder den Zeiger für alle Zuschauer aus dem Bild verschwunden
    /// oder den Stream dauerhaft im ungeglätteten Fern-Takt.
    fn fern_abschalten(&self) {
        self.umgebung.host_zeiger_zeigen(true);
        self.umgebung.fern_aktiv_setzen(false);
        // Was die Plattform an sitzungsgebundenen Merkern führt — auf Windows
        // die zuletzt gemeldete Zeigerform. Ausdrücklich NICHT in
        // `host_zeiger_zeigen`, das auch bei jedem Führungswechsel und jedem
        // Vorrang-Übergang läuft.
        self.umgebung.sitzung_beendet();
        // Die Wache hört systemweit mit; sie hat nur zu stehen, solange
        // wirklich jemand steuert. Wartet NICHT auf ihren Faden — dieser Weg
        // läuft auch unter der Sitzungssperre und beim Prozessende.
        self.wache.stoppen();
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
    fn handschlag(&self, z: &mut Zustand, version: u8) -> Result<(), String> {
        if version != PROTOKOLL_VERSION {
            return Err(format!(
                "Eingabe-Protokoll Fassung {version}, erwartet {PROTOKOLL_VERSION}"
            ));
        }
        // **Ohne Wache keine Fernsteuerung.** Der Host hat zugestimmt, weil ihm
        // zugesagt ist, dass er jederzeit mit einer Handbewegung übernimmt. Lässt
        // sich das auf diesem System nicht durchsetzen, ist die Zusage nicht
        // einlösbar — dann verweigert der Start, statt still etwas Schwächeres
        // unter demselben Etikett zu liefern (dieselbe Linie wie bei HDR,
        // s. `encode/hdr.rs`). Idempotent: das zweite Hello einer
        // Sitzung findet die Wache stehend vor.
        self.wache.starten().map_err(|e| {
            format!("Vorrang des Hosts nicht durchsetzbar, Fernsteuerung verweigert: {e}")
        })?;
        z.tat.druck.loslassen(self.injektor);
        z.tat.zeiger = None;
        z.begruesst = true;
        self.umgebung.fern_aktiv_setzen(true);
        Ok(())
    }

    /// Eine Nachricht verwerfen — **die Eingabe, nicht den Handschlag**, und mit
    /// Freigabe.
    ///
    /// Zwei Zusagen auf einmal:
    ///
    /// * *Freigabe.* „Wird wegen unbekannten Slots, unauflösbarer Quelle oder
    ///   geschwärzten Sichtschutzes verworfen, gibt der Host trotzdem alles
    ///   Gedrückte frei." Für den Vorrang des Hosts gilt dasselbe — dort gibt schon
    ///   `vorrang_nachfuehren` beim Übergang frei, und hier bleibt es bei jeder
    ///   weiteren Nachricht dabei. Es genügt, dass der Host sein gestreamtes Fenster
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
    fn nur_handschlag(
        &self,
        z: &mut Zustand,
        frames: &[Vec<u8>],
        zustand: &'static str,
    ) -> Result<Bericht, String> {
        for roh in frames {
            let Ok(InputFrame::Hello { version }) = InputFrame::parse(roh) else {
                continue;
            };
            if let Err(grund) = self.handschlag(z, version) {
                return Err(self.stilllegen(z, grund));
            }
        }
        z.tat.druck.loslassen(self.injektor);
        Ok(Bericht { verarbeitet: 0, zustand })
    }

    /// Fail-closed: stilllegen, alles freigeben, Zustand melden. Der Fehler geht
    /// zusätzlich als Antwort auf die Operation zurück.
    fn stilllegen(&self, z: &mut Zustand, grund: String) -> String {
        z.stillgelegt = true;
        z.tat.druck.loslassen(self.injektor);
        z.tat.zeiger = None;
        // Fail-closed heißt: diese Sitzung steuert nichts mehr — der Stream läuft
        // aber weiter, seine Zuschauer bekommen den Cursor zurück und der
        // Aufnahme-Takt sein glättendes Raster.
        self.fern_abschalten();
        eprintln!("[remote-input] fail-closed: {grund}");
        self.umgebung.fehler_melden(&grund);
        grund
    }
}

#[cfg(test)]
#[path = "sitzung_tests.rs"]
mod sitzung_tests;
