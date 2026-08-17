//! Das **Bildformat** der Zeigerübertragung — die Läufe, die Grenzen, die
//! Kennung.
//!
//! **Diese Datei liegt wortgleich an zwei Stellen** und muss es bleiben:
//!
//! * `streaming/win-hq-sidecar/src/zeigerbild.rs` (kodiert)
//! * `streaming/pulse-player/src/zeigerbild.rs` (entpackt)
//!
//! Gleiches Muster und gleicher Grund wie bei `zeitbasis.rs`: die beiden Enden
//! müssen sich Byte für Byte einig sein, und eine Beschreibung in zwei
//! Fassungen ist eine Beschreibung, die auseinanderläuft. Alles hier ist reine
//! Rechnung — kein Windows, kein Fenster, keine Sitzung —, deshalb hält der
//! Test unten **beide** Richtungen fest, obwohl jede Seite nur eine braucht.
//!
//! ## Wozu überhaupt ein Bild
//!
//! Der gewöhnliche Weg überträgt einen **Namen** aus der CSS-Zeigerliste
//! (`remote_input/zeigerform.rs` → `app/zeigerform.rs`), und das ist der bessere
//! Weg, wo er trägt: ein paar Byte, gezeichnet wird der lokale Zeiger in der
//! Größe und dem Thema des Steuernden. Er trägt aber nur die dreizehn
//! Standardformen. Eine Schnittanwendung mit Rasierklinge und Trimm-Zeigern,
//! eine Bildbearbeitung mit Werkzeug-Zeigern, ein 3D-Programm mit Achsen-Zeigern
//! — die fielen alle auf den Standardpfeil, und der Steuernde sähe nichts von
//! dem, was das Programm ihm gerade sagen will. Deshalb hier der zweite Weg:
//! **wenn der Zeiger keinem Standard entspricht, gehen seine Pixel mit.**
//!
//! ## Warum eigene Läufe und kein PNG
//!
//! Ein Zeiger ist zu grossen Teilen durchsichtig, oft mit nur zwei oder drei
//! echten Farben. Genau dafür sind Wiederholungsläufe gemacht: ein üblicher
//! 32×32-Zeiger schrumpft von 4096 auf einige hundert Byte, und das Verfahren
//! sind vierzig Zeilen ohne Fremdcode. Ein PNG-Packer wäre eine neue
//! Abhängigkeit **auf beiden Seiten** — für ein Bild, das kleiner ist als sein
//! eigener Dateikopf.
//!
//! Die Enge ist echt: der Weiterleiter des Gateways deckelt die Nutzlast einer
//! `remote_signal`-Nachricht auf 8 KiB (`ws_remote_handlers.py`), und Base64
//! legt darauf noch ein Drittel drauf. Roh passt damit gerade ein 32×32-Zeiger
//! (4096 Byte → 5464 kodiert), ein 48×48 schon nicht mehr. Mit Läufen passen
//! auch die grossen bequem — und wo sie es wider Erwarten nicht tun, fällt der
//! Sender wortlos auf den Namen zurück, statt eine Nachricht zu schicken, die
//! unterwegs still verworfen würde.
//!
//! ## Der Aufbau
//!
//! Zeilen von oben nach unten, je Bildpunkt vier Byte **R, G, B, A** mit
//! **nicht** vorvervielfachtem Alpha (winit verlangt es so, GDI liefert es
//! andersherum — die Rückrechnung macht der Sidecar, s. dort). Die Läufe:
//!
//! | Steuerbyte | Bedeutung | danach |
//! |---|---|---|
//! | `1..=127` | so viele **einzelne** Bildpunkte | 4 × n Byte |
//! | `129..=255` | Steuerbyte − 128 **Wiederholungen** eines Punktes | 4 Byte |
//! | `0`, `128` | ungültig | — |
//!
//! Ein Lauf fasst höchstens 127 Punkte. Das kostet bei einer durchsichtigen
//! 32×32-Fläche neun Steuerbytes statt einem und ist die Grenze wert: so bleibt
//! das Steuerbyte ein Byte, und die Unterscheidung ist ein Bitvergleich.
//!
//! ## Warum hier toter Code steht
//!
//! Jede Seite braucht nur eine Richtung — der Sidecar packt, der Player
//! entpackt —, aber **beide Seiten tragen beide**. Das ist der Preis der
//! Wortgleichheit und billiger als die Alternative: zwei Dateien, die sich
//! unterscheiden, könnte niemand mehr mit einem `diff` prüfen. Die Tests unten
//! nutzen ohnehin beide Richtungen; nur der Auslieferungsbau sähe sonst
//! Warnungen für Code, der auf der anderen Seite der Leitung gebraucht wird.
#![allow(dead_code)]

/// Längste Kante, die angenommen wird. Windows-Zeiger sind 32×32, bei starker
/// Bildschirmskalierung 48×48 oder 64×64; 256 ist weit darüber und deckelt
/// zugleich, was ein fehlerhafter oder böswilliger Sender an Arbeit auslösen
/// kann (256 × 256 × 4 = 256 KiB entpackt). winit selbst nähme bis 2048 — das
/// wäre ein 16-MiB-Bild aus einer 8-KiB-Nachricht.
pub const MAX_KANTE: u16 = 256;

/// Wie viele gepackte Byte höchstens hinausgehen dürfen.
///
/// Die Rechnung, Schritt für Schritt. Der Weiterleiter des Gateways deckelt die
/// Nutzlast einer `remote_signal`-Nachricht auf **8192 Byte**
/// (`_SIGNAL_MAX_DATA_BYTES` in
/// `services/chat-gateway/src/dcc_chat_gateway/routes/ws_remote_handlers.py`),
/// gemessen an ihrer JSON-Länge. Darin steckt:
///
/// * die Hülle `{"form":"default","bild":{"id":…,"w":…,"h":…,"hx":…,"hy":…,
///   "daten":""}}` — nachgezählt 100 Byte im ungünstigsten Fall (längster
///   Formname `nwse-resize`, 16-stellige Kennung, dreistellige Masse);
/// * die Läufe als Base64, also Faktor 4/3.
///
/// Bleiben (8192 − 100) × 3/4 ≈ 6069 Byte für die Läufe. Gewählt sind **5900**,
/// womit die grösste mögliche Nachricht 7968 von 8192 Byte misst: **224 Byte
/// Rand**. Die Grenze wird nur einmal aufgeschrieben, und wer später ein Feld
/// ergänzt, soll nicht nachrechnen müssen, ob es noch passt.
///
/// **Die Grenze steht im Format und nicht beim Sender**, damit beide Enden
/// dieselbe kennen: ein Bild, das darüber liegt, wird gar nicht erst gepackt —
/// der Sender fällt auf den Namen zurück, statt eine Nachricht zu schicken, die
/// der Gateway still verwirft und deren Ausbleiben niemand als Fehler sähe.
pub const MAX_LAEUFE_BYTE: usize = 5900;

/// Ein Zeigerbild, wie es über die Leitung geht.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Zeigerbild {
    pub breite: u16,
    pub hoehe: u16,
    /// Der Punkt im Bild, der auf den Zielpunkt zeigt (Spitze des Pfeils,
    /// Mitte des Fadenkreuzes). Ohne ihn zeigte ein Fadenkreuz mit seiner
    /// linken oberen Ecke — der Steuernde klickte daneben.
    pub halt_x: u16,
    pub halt_y: u16,
    /// `breite × hoehe` Punkte à vier Byte, RGBA, Alpha nicht vorvervielfacht.
    pub punkte: Vec<u8>,
}

impl Zeigerbild {
    /// Ist das Bild in sich stimmig? Nach dem Entpacken **und** vor dem
    /// Kodieren geprüft: ein Bild, dessen Maße nicht zur Punktzahl passen,
    /// bringt sonst erst die Zeichenschicht zu Fall, wo der Zusammenhang zur
    /// Ursache längst verloren ist.
    pub fn stimmig(&self) -> bool {
        self.breite >= 1
            && self.hoehe >= 1
            && self.breite <= MAX_KANTE
            && self.hoehe <= MAX_KANTE
            // Der Halt darf auf dem Rand liegen, aber nicht daneben — winit
            // weist ein Bild mit Halt ausserhalb der Fläche ab.
            && self.halt_x < self.breite
            && self.halt_y < self.hoehe
            && self.punkte.len() == self.breite as usize * self.hoehe as usize * 4
    }

    /// Die **Kennung**: derselbe Zeiger ergibt dieselbe, ein anderer eine
    /// andere. Damit muss ein Bild nur einmal je Sitzung über die Leitung, und
    /// die Gegenseite erkennt an der Kennung, ob sie es schon fertig gebaut
    /// vorliegen hat.
    ///
    /// **Warum über die Punkte und nicht über das Windows-Handle:** Handles
    /// werden nach dem Freigeben wiederverwendet. Ein Zeiger, den die Anwendung
    /// verwirft, gäbe seine Zahl an einen ganz anderen weiter — und die
    /// Gegenseite zeigte den alten weiter, weil die Kennung stimmt. Über die
    /// Punkte kann das nicht passieren.
    ///
    /// FNV-1a, 64 bit: kein Schutz gegen absichtliche Kollisionen nötig (wer
    /// Bilder einschleusen kann, kann auch gleich das Bild schicken), aber
    /// schnell und in zwölf Zeilen auf beiden Seiten gleich.
    pub fn kennung(&self) -> String {
        const ANFANG: u64 = 0xcbf2_9ce4_8422_2325;
        const FAKTOR: u64 = 0x0000_0100_0000_01b3;
        let mut h = ANFANG;
        let mut schlucke = |b: u8| {
            h ^= b as u64;
            h = h.wrapping_mul(FAKTOR);
        };
        // Die Masse gehören mit hinein: zwei Zeiger mit gleichen Punkten, aber
        // verschiedenem Halt sind verschiedene Zeiger.
        for wert in [self.breite, self.hoehe, self.halt_x, self.halt_y] {
            for b in wert.to_le_bytes() {
                schlucke(b);
            }
        }
        for &b in &self.punkte {
            schlucke(b);
        }
        format!("{h:016x}")
    }

    /// Die Punkte in Läufe packen. `None`, wenn das Bild nicht stimmig ist oder
    /// nicht unter [`MAX_LAEUFE_BYTE`] passt — in beiden Fällen fällt der
    /// Sender auf den Namen zurück.
    pub fn packen(&self) -> Option<Vec<u8>> {
        if !self.stimmig() {
            return None;
        }
        let mut aus: Vec<u8> = Vec::with_capacity(self.punkte.len() / 4);
        let punkte: Vec<&[u8]> = self.punkte.chunks_exact(4).collect();
        let mut i = 0usize;
        while i < punkte.len() {
            // Wie weit reicht die Wiederholung ab hier?
            let mut gleich = 1usize;
            while i + gleich < punkte.len() && punkte[i + gleich] == punkte[i] && gleich < 127 {
                gleich += 1;
            }
            if gleich >= 2 {
                aus.push(128 + gleich as u8);
                aus.extend_from_slice(punkte[i]);
                i += gleich;
                if aus.len() > MAX_LAEUFE_BYTE {
                    return None;
                }
                continue;
            }
            // Kein Lauf: einzelne Punkte sammeln, bis wieder einer beginnt.
            // **Schon ein Paar bricht ab**, und die Rechnung dahinter ist
            // knapp: zwei gleiche Punkte in der Einzelfolge kosten 8 Byte;
            // herausgezogen kosten sie einen Lauf (1 + 4) plus ein neues
            // Steuerbyte für den Rest der Folge, also 6. Zwei Byte gespart,
            // und am Ende einer Folge sogar drei (dort entfällt das zweite
            // Steuerbyte). Es gibt keinen Fall, in dem das Paar drinbleiben
            // sollte.
            //
            // Gemessen an Mustern mit eingestreuten Paaren, wie sie ein weicher
            // Zeigerrand erzeugt: 63 Byte gespart bei einem Paar auf je acht
            // Punkte, 127 bei jedem vierten. Über 62 289 erschöpfend erzeugte
            // Muster (zwei Symbole bis Länge 14, drei bis Länge 9) ist die
            // Regel 37 346-mal besser und **kein einziges Mal schlechter**.
            let anfang = i;
            let mut einzeln = 0usize;
            while i < punkte.len() && einzeln < 127 {
                let paar = i + 1 < punkte.len() && punkte[i + 1] == punkte[i];
                // **`einzeln > 0` ist heute nicht erreichbar** — wer hier
                // ankommt, hat oben `gleich == 1` gemessen, also ist der
                // Nachbar in der ersten Runde zwangsläufig verschieden. Die
                // Bedingung bleibt trotzdem stehen: sie ist das, was ein
                // Steuerbyte 0 (verboten, s. Tabelle im Modulkopf) auch dann
                // noch verhindert, wenn jemand die äussere Bedingung umbaut.
                if paar && einzeln > 0 {
                    break;
                }
                i += 1;
                einzeln += 1;
            }
            aus.push(einzeln as u8);
            for p in &punkte[anfang..i] {
                aus.extend_from_slice(p);
            }
            // Geprüft wird IM Lauf, nicht erst am Ende: ein 256×256-Bild aus
            // lauter verschiedenen Punkten packte sonst 256 KiB zusammen, nur
            // um sie danach wegzuwerfen. **In BEIDEN Zweigen**, sonst umgeht ein
            // Bild aus lauter Zweierläufen die Prüfung und wächst trotzdem auf
            // ein Vielfaches der Grenze an, bevor sie am Ende greift.
            if aus.len() > MAX_LAEUFE_BYTE {
                return None;
            }
        }
        (aus.len() <= MAX_LAEUFE_BYTE).then_some(aus)
    }

    /// Läufe zurück in Punkte. Fehlermeldung statt `None`, weil der Aufrufer
    /// sie ins Protokoll schreibt: hier landet Fremdmaterial, und „geht nicht"
    /// wäre die nutzloseste Auskunft über einen Fehler, der nur auf dem
    /// Rechner eines anderen auftritt.
    pub fn entpacken(
        breite: u16,
        hoehe: u16,
        halt_x: u16,
        halt_y: u16,
        laeufe: &[u8],
    ) -> Result<Zeigerbild, String> {
        if breite < 1 || hoehe < 1 || breite > MAX_KANTE || hoehe > MAX_KANTE {
            return Err(format!("Masse {breite}x{hoehe} ausserhalb 1..={MAX_KANTE}"));
        }
        // **Vor** dem Entpacken belegt, nicht währenddessen wachsen lassen: die
        // Masse sind geprüft, also ist die Zahl bekannt — und ein Sender kann
        // mit kurzen Läufen keine unbegrenzte Zuteilung auslösen.
        let soll = breite as usize * hoehe as usize * 4;
        let mut punkte: Vec<u8> = Vec::with_capacity(soll);
        let mut i = 0usize;
        while i < laeufe.len() {
            let steuer = laeufe[i];
            i += 1;
            let (anzahl, wiederholt) = match steuer {
                0 | 128 => return Err(format!("ungueltiges Steuerbyte {steuer}")),
                1..=127 => (steuer as usize, false),
                _ => ((steuer - 128) as usize, true),
            };
            let noetig = if wiederholt { 4 } else { anzahl * 4 };
            if i + noetig > laeufe.len() {
                return Err("Lauf reicht ueber das Ende hinaus".to_string());
            }
            if punkte.len() + anzahl * 4 > soll {
                return Err("mehr Punkte als das Bild fasst".to_string());
            }
            if wiederholt {
                for _ in 0..anzahl {
                    punkte.extend_from_slice(&laeufe[i..i + 4]);
                }
            } else {
                punkte.extend_from_slice(&laeufe[i..i + noetig]);
            }
            i += noetig;
        }
        if punkte.len() != soll {
            return Err(format!("{} Byte statt {soll}", punkte.len()));
        }
        let bild = Zeigerbild { breite, hoehe, halt_x, halt_y, punkte };
        // Die Masse sind oben geprüft, die Punktzahl gerade eben — offen bleibt
        // nur der Halt, und der käme sonst erst bei winit als Fehler heraus.
        if !bild.stimmig() {
            return Err(format!("Halt {halt_x},{halt_y} liegt ausserhalb {breite}x{hoehe}"));
        }
        Ok(bild)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bild(breite: u16, hoehe: u16, punkte: Vec<u8>) -> Zeigerbild {
        Zeigerbild { breite, hoehe, halt_x: 0, halt_y: 0, punkte }
    }

    /// Der Regelfall: was gepackt wurde, kommt gleich wieder heraus. Der Test
    /// deckt beide Richtungen ab, weil jede Seite nur eine davon nutzt — ein
    /// Fehler in der ungenutzten fiele sonst erst im Betrieb auf, und zwar auf
    /// dem Rechner der Gegenseite.
    #[test]
    fn packen_und_entpacken_ergeben_dasselbe() {
        for muster in [
            // ganz durchsichtig (der häufigste Rand eines Zeigers)
            vec![0u8; 16 * 16 * 4],
            // abwechselnd — der schlechteste Fall für Läufe
            (0..16 * 16 * 4).map(|i| (i % 2) as u8 * 255).collect::<Vec<u8>>(),
            // Blöcke, wie sie ein echter Zeiger hat
            (0..16 * 16 * 4).map(|i| ((i / 32) % 4) as u8 * 60).collect::<Vec<u8>>(),
        ] {
            let vorher = bild(16, 16, muster);
            let gepackt = vorher.packen().expect("stimmiges Bild packt");
            let nachher = Zeigerbild::entpacken(16, 16, 0, 0, &gepackt).expect("entpackt");
            assert_eq!(vorher, nachher);
        }
    }

    /// **Erschöpfend über alle kurzen Muster.** Einzelfälle treffen die Ränder
    /// nicht, an denen ein Lauflängen-Verfahren wirklich bricht: Paar am Ende
    /// der Punktliste, Lauf direkt nach einer Einzelfolge, Wechsel bei jedem
    /// Punkt. Alle Folgen der Länge 1..=7 über drei verschiedene Punkte sind
    /// 3 279 Fälle und decken jede dieser Anordnungen ab.
    #[test]
    fn alle_kurzen_muster_ueberstehen_den_umlauf() {
        for laenge in 1..=7usize {
            for mut n in 0..3usize.pow(laenge as u32) {
                let mut punkte = Vec::with_capacity(laenge * 4);
                for _ in 0..laenge {
                    let f = (n % 3) as u8 * 100;
                    n /= 3;
                    punkte.extend_from_slice(&[f, f, f, 255]);
                }
                let vorher = bild(laenge as u16, 1, punkte);
                let gepackt = vorher.packen().expect("packt");
                let nachher = Zeigerbild::entpacken(laenge as u16, 1, 0, 0, &gepackt)
                    .unwrap_or_else(|e| panic!("{:?} entpackt nicht: {e}", vorher.punkte));
                assert_eq!(vorher, nachher);
            }
        }
    }

    /// Die Steuerbyte-Grenzen: ein Lauf fasst 127, eine Einzelfolge auch. Genau
    /// dort schlägt ein Zählfehler zu, und genau dort trifft ihn kein Muster
    /// aus dem erschöpfenden Test darüber (der geht nur bis 7).
    #[test]
    fn laeufe_ueber_der_steuerbyte_grenze_brechen_richtig_um() {
        for laenge in [126usize, 127, 128, 129, 254, 255, 256] {
            // durchgehend gleich → reine Wiederholungsläufe
            let gleich = bild(laenge as u16, 1, vec![7u8; laenge * 4]);
            let g = gleich.packen().expect("packt");
            assert_eq!(
                Zeigerbild::entpacken(laenge as u16, 1, 0, 0, &g).expect("entpackt"),
                gleich,
                "gleich, Länge {laenge}"
            );
            // durchgehend verschieden → reine Einzelfolgen
            let bunt: Vec<u8> =
                (0..laenge).flat_map(|i| [(i % 251) as u8, 0, 0, 255]).collect();
            let wechselnd = bild(laenge as u16, 1, bunt);
            let w = wechselnd.packen().expect("packt");
            assert_eq!(
                Zeigerbild::entpacken(laenge as u16, 1, 0, 0, &w).expect("entpackt"),
                wechselnd,
                "wechselnd, Länge {laenge}"
            );
        }
    }

    /// **Der Grund für das ganze Verfahren.** Ein Zeiger ist überwiegend
    /// durchsichtig; passte er nicht unter den 8-KiB-Deckel des Gateways, ginge
    /// er gar nicht erst hinaus.
    #[test]
    fn eine_durchsichtige_flaeche_schrumpft_deutlich() {
        let gepackt = bild(32, 32, vec![0u8; 32 * 32 * 4]).packen().unwrap();
        assert!(gepackt.len() < 100, "{} Byte", gepackt.len());
    }

    /// Auch der schlechteste Fall bleibt tragbar — sonst wäre die Rückfallregel
    /// beim Sender nicht die Ausnahme, sondern der Regelfall bei buntem
    /// Material.
    #[test]
    fn der_schlechteste_fall_blaeht_kaum_auf() {
        let bunt: Vec<u8> = (0..32 * 32 * 4).map(|i| (i % 251) as u8).collect();
        let gepackt = bild(32, 32, bunt).packen().unwrap();
        // 4096 Byte Punkte + je 127 Punkte ein Steuerbyte.
        assert!(gepackt.len() <= 4096 + 40, "{} Byte", gepackt.len());
    }

    /// Ein Zeiger von der Grösse, die bei starker Bildschirmskalierung entsteht,
    /// muss durchkommen. Täte er es nicht, griffe der Rückfall auf den Namen
    /// ausgerechnet bei den Nutzern, die HiDPI fahren — für die wäre das ganze
    /// Merkmal dann wirkungslos.
    #[test]
    fn ein_realistischer_grosser_zeiger_passt_unter_die_grenze() {
        let mut punkte: Vec<u8> = Vec::with_capacity(64 * 64 * 4);
        for y in 0..64u32 {
            for x in 0..64u32 {
                // Pfeil-artig: gefüllt nur im linken oberen Keil, mit hellem
                // Rand — also lange durchsichtige Läufe je Zeile, wie bei jedem
                // echten Zeiger.
                let drin = x < 3 + y / 2 && y < 44;
                let rand = drin && (x + 3 >= 3 + y / 2 || x < 2);
                let punkt: [u8; 4] = match (drin, rand) {
                    (false, _) => [0, 0, 0, 0],
                    (true, true) => [255, 255, 255, 255],
                    (true, false) => [0, 0, 0, 255],
                };
                punkte.extend_from_slice(&punkt);
            }
        }
        let gepackt = Zeigerbild { breite: 64, hoehe: 64, halt_x: 0, halt_y: 0, punkte }
            .packen()
            .expect("passt unter die Grenze");
        assert!(gepackt.len() < 1500, "{} Byte", gepackt.len());
    }

    /// Was nicht unter [`MAX_LAEUFE_BYTE`] passt, wird gar nicht erst gepackt —
    /// sonst ginge eine Nachricht hinaus, die der Gateway still verwirft.
    #[test]
    fn zu_grosses_wird_nicht_gepackt() {
        let bunt: Vec<u8> = (0..128 * 128 * 4).map(|i| (i % 251) as u8).collect();
        assert!(bild(128, 128, bunt).packen().is_none());
    }

    /// Schon ein Paar bricht die Einzelfolge auf — es spart zwei Byte
    /// (Begründung und Messung stehen in `packen`). Hält die Entscheidung fest,
    /// damit sie nicht bei der nächsten Vereinfachung als Umständlichkeit
    /// zurückgebaut wird.
    #[test]
    fn ein_paar_wird_zum_eigenen_lauf() {
        // vier verschiedene, dann zwei gleiche, dann zwei verschiedene
        let mut punkte = Vec::new();
        for f in [1u8, 2, 3, 4, 9, 9, 5, 6] {
            punkte.extend_from_slice(&[f, f, f, 255]);
        }
        let gepackt = bild(8, 1, punkte).packen().unwrap();
        assert_eq!(gepackt[0], 4, "erst die vier einzelnen");
        assert_eq!(gepackt[17], 128 + 2, "dann das Paar als Lauf");
        assert_eq!(gepackt[22], 2, "dann die restlichen zwei einzeln");
    }

    /// Ein längerer Lauf mitten in einer Folge, derselbe Weg.
    #[test]
    fn mehrere_gleiche_beginnen_einen_lauf() {
        let mut punkte = Vec::new();
        for f in [1u8, 2, 7, 7, 7, 7, 3, 4] {
            punkte.extend_from_slice(&[f, f, f, 255]);
        }
        let gepackt = bild(8, 1, punkte).packen().unwrap();
        assert_eq!(gepackt[0], 2, "erst zwei einzelne");
        assert_eq!(gepackt[9], 128 + 4, "dann vier Wiederholungen");
    }

    /// Fremdmaterial darf nie durchkommen: hier landet, was ein anderer
    /// Rechner geschickt hat, und die Zeichenschicht dahinter vertraut den
    /// Massen.
    #[test]
    fn missgeformtes_wird_abgewiesen() {
        // zu wenige Punkte für die angegebenen Masse
        assert!(Zeigerbild::entpacken(16, 16, 0, 0, &[1, 0, 0, 0, 0]).is_err());
        // Lauf reicht über das Ende der Daten hinaus
        assert!(Zeigerbild::entpacken(2, 1, 0, 0, &[2, 0, 0]).is_err());
        // verbotene Steuerbytes
        assert!(Zeigerbild::entpacken(1, 1, 0, 0, &[0, 0, 0, 0, 0]).is_err());
        assert!(Zeigerbild::entpacken(1, 1, 0, 0, &[128, 0, 0, 0, 0]).is_err());
        // Masse ausserhalb der Grenzen
        assert!(Zeigerbild::entpacken(0, 8, 0, 0, &[]).is_err());
        assert!(Zeigerbild::entpacken(MAX_KANTE + 1, 8, 0, 0, &[]).is_err());
        // Halt neben dem Bild
        assert!(Zeigerbild::entpacken(1, 1, 1, 0, &[129, 0, 0, 0, 0]).is_err());
    }

    /// Ein Sender darf mit einer kurzen Nachricht keine grosse Zuteilung
    /// auslösen — die Punktzahl wird gegen die Masse geprüft, nicht erst am
    /// Ende gezählt.
    #[test]
    fn mehr_punkte_als_das_bild_fasst_bricht_ab() {
        // 255 Wiederholungen in ein 2x2-Bild
        assert!(Zeigerbild::entpacken(2, 2, 0, 0, &[255, 1, 2, 3, 4]).is_err());
    }

    /// Gleiche Punkte, verschiedener Halt → verschiedene Kennung. Sonst
    /// zeigte die Gegenseite den gemerkten Zeiger mit dem falschen Zielpunkt,
    /// und der Steuernde klickte daneben.
    #[test]
    fn der_halt_geht_in_die_kennung_ein() {
        let punkte = vec![7u8; 4 * 4 * 4];
        let a = Zeigerbild { breite: 4, hoehe: 4, halt_x: 0, halt_y: 0, punkte: punkte.clone() };
        let b = Zeigerbild { breite: 4, hoehe: 4, halt_x: 2, halt_y: 0, punkte };
        assert_ne!(a.kennung(), b.kennung());
        assert_eq!(a.kennung(), a.kennung(), "dieselbe Eingabe, dieselbe Kennung");
    }
}
