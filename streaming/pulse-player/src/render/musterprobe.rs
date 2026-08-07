//! Das gemalte Latenz-Muster aus der eingehaengten GPU-Textur zurueckholen.
//!
//! Der Pruefstand malt einen Balken aus schwarzen und weissen Kloetzen ins Bild,
//! der die Millisekunden seit einer gemeinsamen Epoche kodiert; die Sonde
//! (`crate::probe`) liest ihn und bildet daraus die Ende-zu-Ende-Latenz ueber
//! die GANZE Kette. Bis zum 2026-08-07 las sie ihn aus der Luma-Ebene im
//! **Hauptspeicher** — und auf dem Zero-Copy-Weg (`crate::zerocopy`) gibt es die
//! nicht mehr. Damit war ausgerechnet die Zahl blind, an der der ganze Umbau
//! gemessen werden soll.
//!
//! ## Was hier kopiert wird — und was ausdruecklich nicht
//!
//! **Vier Bildzeilen, nicht die Ebene.** Ein Balken hat 24 Kloetze zu je 32
//! Bildpunkten, und die Sonde liest je Klotz **genau einen** Texel, naemlich in
//! der Blockmitte. Alle zwoelf Kandidatenstellen liegen damit auf vier Zeilen
//! (`probe::POS_Y` plus einem halben Klotz). Kopiert werden deshalb vier
//! Zeilen der Hoehe 1 — bei 1080p10 rund 20 kB je Bild statt 4 MB fuer die ganze
//! Ebene.
//!
//! **Kein Compute-Shader.** Es gibt nichts zu rechnen: die 24 Texte-Werte je
//! Stelle wertet `probe` ohnehin aus, und ein Shader dafuer waere eine zweite
//! Fassung derselben Bit-Auswertung — genau die Fehlerklasse, die in diesem
//! Labor schon einmal eine Messreihe entwertet hat.
//!
//! ## Der Rueckweg ist wieder die eigentliche Schwierigkeit
//!
//! Wie beim Fingerabdruck des Einfrier-Waechters ([`super::abdruck`], dessen
//! Modulkopf die lange Begruendung traegt): auf die GPU zu WARTEN waere genau
//! die Rundreise, die der Zero-Copy-Weg gerade beseitigt hat. Also **aufzeichnen
//! und spaeter abholen**, ueber einen Ring von [`RING_PLAETZE`] Abholpuffern.
//!
//! **Daraus folgt der Zeitstempel beim Aufzeichnen**, und das ist der Punkt, an
//! dem die Messung steht oder faellt: die Abholung hinkt ein bis zwei Bilder
//! hinterher. Wuerde die Uhr erst dort gelesen, steckten 16 bis 33 ms
//! Messfehler in jeder Zahl — dieselbe Groessenordnung wie der erwartete Gewinn,
//! und einseitig zu Lasten des neuen Weges. Der Ringplatz fuehrt seinen Stempel
//! deshalb mit (`probe::Musterzeilen::stempel_ms`).
//!
//! ## Nur mit `PULSE_PLAYER_LATENCY_PROBE=1`
//!
//! Ohne den Schalter entsteht dieses Werk gar nicht erst, und die eingehaengte
//! Textur bekommt auch die Nutzungsart `COPY_SRC` nicht (s.
//! `super::fremdbild`). Im Normalbetrieb wird also **kein einziger
//! zusaetzlicher Befehl** abgesetzt.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::probe::{jetzt_ms, musterzeile, Musterzeilen, MUSTER_BREITE, POS_Y};

/// Wie viele Abholpuffer gleichzeitig unterwegs sein duerfen. Dieselbe
/// Ueberlegung und dieselbe Zahl wie bei [`super::abdruck`]: das Ergebnis
/// braucht typisch ein bis zwei Bilder, zwei Plaetze waeren bei jedem Ruckler
/// knapp.
const RING_PLAETZE: usize = 3;

/// Ausrichtung, die wgpu fuer `bytes_per_row` einer Textur-Kopie verlangt.
const ZEILEN_AUSRICHTUNG: u32 = 256;

/// Wie viel Platz eine Zeile im Abholpuffer bekommt.
///
/// Fest auf den schlechtesten Fall gerechnet (zwei Byte je Texel, also 10 bit),
/// damit der Ring beim Wechsel der Bittiefe nicht neu angelegt werden muss —
/// 20 kB je Platz sind das nicht wert. Der Abstand ist zugleich der
/// Puffer-Versatz je Zeile und deshalb auf 256 ausgerichtet: `copy_texture_to_buffer`
/// verlangt das fuer `offset` genauso wie fuer `bytes_per_row`.
const ZEILEN_BYTES: u32 =
    (MUSTER_BREITE as u32 * 2).div_ceil(ZEILEN_AUSRICHTUNG) * ZEILEN_AUSRICHTUNG;

/// Ein Abholpuffer samt dem, was ueber sein Bild bekannt sein muss.
struct Platz {
    puffer: wgpu::Buffer,
    /// Vom Rueckruf des Treibers gesetzt, aus einem fremden Thread.
    fertig: Arc<AtomicBool>,
    belegt: bool,
    /// Laufende Nummer — die Reihenfolge der Bilder.
    nummer: u64,
    /// Die Uhr beim AUFZEICHNEN (Begruendung im Modulkopf).
    stempel_ms: u64,
    zehn_bit: bool,
    /// Wie viele Byte je Zeile wirklich Bild sind (ohne die Auffuellung auf
    /// [`ZEILEN_BYTES`]).
    zeilenbytes: usize,
    /// Die `POS_Y`-Werte der kopierten Zeilen, in der Reihenfolge der Kopien.
    zeilen: Vec<usize>,
}

/// Der Ring samt den fertig eingesammelten Zeilen.
pub(super) struct Musterprobe {
    ring: Vec<Platz>,
    zaehler: u64,
    /// Was der Aufrufer noch abholen kann. Gedeckelt wie der Briefkasten des
    /// Einfrier-Waechters: holt niemand ab, waechst hier sonst Speicher, den
    /// nie jemand liest.
    fertig: VecDeque<Musterzeilen>,
}

impl Musterprobe {
    /// Das Werk anlegen — **nur, wenn die Sonde laeuft**.
    pub fn neu_wenn_gebraucht(device: &wgpu::Device) -> Option<Self> {
        if !crate::probe::sonde_aktiv() {
            return None;
        }
        let ring = (0..RING_PLAETZE)
            .map(|_| Platz {
                puffer: device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("pulse-player-musterprobe-abholung"),
                    size: u64::from(ZEILEN_BYTES) * POS_Y.len() as u64,
                    usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                }),
                fertig: Arc::new(AtomicBool::new(false)),
                belegt: false,
                // Belanglos, solange `belegt` falsch ist: die Nummer vergibt
                // erst `abholung_starten`, und `aeltester_fertiger` sieht nur
                // belegte Plaetze an.
                nummer: 0,
                stempel_ms: 0,
                zehn_bit: false,
                zeilenbytes: 0,
                zeilen: Vec::new(),
            })
            .collect();
        eprintln!("pulse-player: Latenz-Sonde liest das Muster aus der GPU-Textur");
        Some(Self { ring, zaehler: 0, fertig: VecDeque::new() })
    }

    /// Die vier Musterzeilen in einen Abholpuffer kopieren — **in den
    /// Kommandopuffer des Renderers**, ohne eigene Abgabe.
    ///
    /// Wie bei [`super::abdruck::Abdruckwerk::aufzeichnen`] muss der Aufrufer
    /// nach dem `submit` desselben Kommandopuffers
    /// [`Musterprobe::abholung_starten`] mit dem Rueckgabewert rufen; deshalb
    /// ist die Rueckgabe ein eigener `#[must_use]`-Typ.
    ///
    /// Ist kein Platz frei, faellt die Messung dieses einen Bildes aus. Das ist
    /// kein Fehler, sondern derselbe Gegendruck wie beim Fingerabdruck: die
    /// Sonde mittelt ueber ein Sekundenfenster, eine Stichprobe der Bilder
    /// beantwortet dieselbe Frage.
    pub fn aufzeichnen(
        &mut self,
        device: &wgpu::Device,
        enc: &mut wgpu::CommandEncoder,
        luma: &wgpu::Texture,
        zehn_bit: bool,
    ) -> Option<Abholung> {
        self.ernten(device);
        let i = self.freier_platz()?;

        let bpp = if zehn_bit { 2u32 } else { 1 };
        let breite = luma.width().min(MUSTER_BREITE as u32);
        let zeilen: Vec<usize> =
            POS_Y.into_iter().filter(|y0| (musterzeile(*y0) as u32) < luma.height()).collect();
        // **Passt keine Zeile ins Bild, wird trotzdem etwas gemeldet.** Ein
        // stiller Ausfall waere genau der Fehler vom 2026-08-01: die Sonde
        // gaebe am Ende einen Mittelwert ueber null Bilder aus, ohne dass
        // irgendwo stuende, dass sie nichts gesehen hat.
        if zeilen.is_empty() || breite == 0 {
            self.melden(Musterzeilen { stempel_ms: jetzt_ms(), zehn_bit, zeilen: Vec::new() });
            return None;
        }
        let bpr = (breite * bpp).div_ceil(ZEILEN_AUSRICHTUNG) * ZEILEN_AUSRICHTUNG;

        for (n, y0) in zeilen.iter().enumerate() {
            enc.copy_texture_to_buffer(
                wgpu::TexelCopyTextureInfo {
                    texture: luma,
                    mip_level: 0,
                    // Ab Spalte 0 statt ab `POS_X[0]`: die 64 uebersprungenen
                    // Texel waeren 64 Byte weniger je Zeile und dafuer eine
                    // Verschiebung, die in jede Indexrechnung der Sonde
                    // eingehen muesste. Der Balken liegt so an genau der
                    // Spalte, an der er auch im Bild liegt.
                    origin: wgpu::Origin3d { x: 0, y: musterzeile(*y0) as u32, z: 0 },
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::TexelCopyBufferInfo {
                    buffer: &self.ring[i].puffer,
                    layout: wgpu::TexelCopyBufferLayout {
                        offset: u64::from(ZEILEN_BYTES) * n as u64,
                        bytes_per_row: Some(bpr),
                        rows_per_image: Some(1),
                    },
                },
                wgpu::Extent3d { width: breite, height: 1, depth_or_array_layers: 1 },
            );
        }
        let platz = &mut self.ring[i];
        platz.stempel_ms = jetzt_ms();
        platz.zehn_bit = zehn_bit;
        platz.zeilenbytes = (breite * bpp) as usize;
        platz.zeilen = zeilen;
        Some(Abholung(i))
    }

    /// Die Abholung anstossen — **erst nach dem `submit`**, nie davor
    /// (Begruendung bei [`super::abdruck::Abdruckwerk::abholung_starten`]).
    pub fn abholung_starten(&mut self, abholung: Abholung) {
        let Abholung(i) = abholung;
        let fertig = self.ring[i].fertig.clone();
        self.ring[i].puffer.slice(..).map_async(wgpu::MapMode::Read, move |r| {
            if r.is_ok() {
                fertig.store(true, Ordering::Release);
            }
        });
        self.ring[i].belegt = true;
        self.ring[i].nummer = self.zaehler;
        self.zaehler += 1;
    }

    /// Fertige Zeilen einsammeln — in der Reihenfolge der Bilder.
    ///
    /// Die Reihenfolge ist hier weniger kritisch als beim Einfrier-Waechter
    /// (jede Messung traegt ihren eigenen Zeitstempel), aber sie kostet nichts:
    /// beim ersten unfertigen Platz wird abgebrochen.
    fn ernten(&mut self, device: &wgpu::Device) {
        // Ohne diesen Anstoss laufen die Rueckrufe des Treibers nie an.
        let _ = device.poll(wgpu::PollType::Poll);
        while let Some(i) = self.aeltester_fertiger() {
            let gelesen: Vec<(usize, Vec<u8>)> = {
                let sicht = self.ring[i].puffer.slice(..).get_mapped_range();
                let p = &self.ring[i];
                p.zeilen
                    .iter()
                    .enumerate()
                    .map(|(n, y0)| {
                        let von = ZEILEN_BYTES as usize * n;
                        (*y0, sicht[von..von + p.zeilenbytes].to_vec())
                    })
                    .collect()
            };
            self.ring[i].puffer.unmap();
            self.ring[i].fertig.store(false, Ordering::Release);
            self.ring[i].belegt = false;
            let (stempel_ms, zehn_bit) = (self.ring[i].stempel_ms, self.ring[i].zehn_bit);
            self.melden(Musterzeilen { stempel_ms, zehn_bit, zeilen: gelesen });
        }
    }

    /// Ein Ergebnis zum Abholen hinlegen.
    fn melden(&mut self, zeilen: Musterzeilen) {
        if self.fertig.len() >= RING_PLAETZE * 4 {
            self.fertig.pop_front();
        }
        self.fertig.push_back(zeilen);
    }

    /// Das aelteste fertige Ergebnis — vom Fenster-Thread in die Sonde zu
    /// geben.
    pub fn nehmen(&mut self) -> Option<Musterzeilen> {
        self.fertig.pop_front()
    }

    fn aeltester_fertiger(&self) -> Option<usize> {
        let i = self
            .ring
            .iter()
            .enumerate()
            .filter(|(_, p)| p.belegt)
            .min_by_key(|(_, p)| p.nummer)
            .map(|(i, _)| i)?;
        self.ring[i].fertig.load(Ordering::Acquire).then_some(i)
    }

    fn freier_platz(&self) -> Option<usize> {
        self.ring.iter().position(|p| !p.belegt)
    }
}

/// Ein belegter Ringplatz, dessen Abholung noch anzustossen ist — derselbe
/// Kniff und dieselbe Begruendung wie bei [`super::abdruck::Abholung`].
#[must_use = "ohne abholung_starten bleibt der Ringplatz belegt und seine Zeilen ungelesen"]
pub(super) struct Abholung(usize);

/// Die ganze Fallunterscheidung „gibt es hier etwas aufzuzeichnen?" an EINER
/// Stelle.
///
/// **Steht hier und nicht am Aufrufort**, obwohl sie dort gebraucht wird:
/// `render/mod.rs` liegt an der harten Groessengrenze (`PLAN.md` §12.1), und
/// die drei Bedingungen gehoeren ohnehin zu diesem Werk. `bild` ist `None`,
/// wenn kein neues Fremdbild anliegt; die innere `None` heisst „Fremdbild da,
/// aber nicht kopierbar" — und **das** wird gemeldet, statt still nichts zu
/// messen.
pub(super) fn aufzeichnen_wenn_noetig(
    werk: &mut Option<Musterprobe>,
    device: &wgpu::Device,
    fremdbilder: &super::fremdbild::Fremdbilder,
    enc: &mut wgpu::CommandEncoder,
    bild: Option<(isize, bool)>,
) -> Option<Abholung> {
    let werk = werk.as_mut()?;
    let (handle, zehn_bit) = bild?;
    let Some(luma) = fremdbilder.luma_textur(handle) else {
        nicht_kopierbar_melden();
        return None;
    };
    werk.aufzeichnen(device, enc, luma, zehn_bit)
}

/// Die Sonde laeuft, aber die eingehaengte Textur laesst sich nicht kopieren.
///
/// **Das muss gesagt werden**, und zwar hier statt in `probe`: dort ist gar
/// nicht zu sehen, warum nichts ankommt. Der Fall tritt ein, wo der Zero-Copy-Weg
/// laeuft, dieser Rueckweg aber nicht gebaut ist (Windows, s.
/// `super::fremdbild`). Eine Sonde, die wortlos nichts misst, ist schlimmer als
/// keine.
pub(super) fn nicht_kopierbar_melden() {
    static EINMAL: std::sync::Once = std::sync::Once::new();
    EINMAL.call_once(|| {
        eprintln!(
            "pulse-player: Latenz-Sonde AUS — das Bild bleibt im Grafikspeicher (Zero-Copy) \
             und die eingehaengte Textur ist auf dieser Plattform nicht kopierbar. \
             Fuer eine Messung: PULSE_PLAYER_ZEROCOPY=0"
        );
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::probe::{musterbits, LatencyProbe, BLOCK, POS_X};

    /// Der Zeilenabstand muss beide Auflagen von `copy_texture_to_buffer`
    /// erfuellen: er ist zugleich `bytes_per_row` einer vollen Zeile und der
    /// Versatz der naechsten. Eine Abweichung davon lehnt wgpu erst zur Laufzeit
    /// ab — also im Pruefstand, mitten in einer Messreihe.
    #[test]
    fn der_zeilenabstand_ist_ausgerichtet_und_gross_genug() {
        assert_eq!(ZEILEN_BYTES % ZEILEN_AUSRICHTUNG, 0);
        assert!(
            ZEILEN_BYTES as usize >= MUSTER_BREITE * 2,
            "eine 10-bit-Zeile muss hineinpassen"
        );
    }

    /// Ein Geraet, oder gar kein Test — wie bei [`super::super::abdruck`]: auf
    /// einer Maschine ohne Grafikausgabe waere ein roter Test hier keine
    /// Aussage ueber den Code.
    fn geraet() -> Option<(wgpu::Device, wgpu::Queue)> {
        let instanz =
            wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
        let adapter = pollster::block_on(instanz.request_adapter(&Default::default())).ok()?;
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("pulse-player-musterprobe-test"),
            ..Default::default()
        }))
        .ok()?;
        Some((device, queue))
    }

    /// **Der ganze Weg auf echter Hardware**: ein gemaltes Muster in eine
    /// Luma-Textur, daraus die vier Zeilen zurueckholen, und die Sonde muss
    /// genau den gemalten Zaehler wiederfinden.
    ///
    /// Laeuft nur mit gesetztem Schalter — ohne ihn legt `neu_wenn_gebraucht`
    /// bewusst gar nichts an, und das ist selbst eine Zusage, die geprueft
    /// gehoert.
    #[test]
    fn der_ganze_rueckweg_findet_den_gemalten_zaehler() {
        if !crate::probe::sonde_aktiv() {
            eprintln!(
                "PULSE_PLAYER_LATENCY_PROBE nicht gesetzt — dieser Test hat NICHTS geprueft"
            );
            return;
        }
        let Some((device, queue)) = geraet() else {
            eprintln!("kein GPU-Adapter — dieser Test hat NICHTS geprueft");
            return;
        };
        let (b, h) = (2560u32, 1440u32);
        let (x0, y0) = (POS_X[1], POS_Y[1]);
        const ZAEHLER: u16 = 12_345;
        // Die Bitfolge kommt aus `probe` — dieselbe, die der Pruefstand malt und
        // die die Auswertung erwartet. Hier eine eigene hinzuschreiben hiesse,
        // den Test gegen seine eigene Annahme statt gegen das Format zu pruefen.
        let mut bild = vec![0u8; (b * h) as usize];
        for (i, bit) in musterbits(ZAEHLER).iter().enumerate() {
            if *bit == 0 {
                continue;
            }
            for y in y0..y0 + BLOCK {
                for x in x0 + i * BLOCK..x0 + (i + 1) * BLOCK {
                    bild[y * b as usize + x] = 0xFF;
                }
            }
        }
        let textur = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("musterprobe-test"),
            size: wgpu::Extent3d { width: b, height: h, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::R8Unorm,
            usage: wgpu::TextureUsages::COPY_DST | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &textur,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &bild,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(b),
                rows_per_image: Some(h),
            },
            wgpu::Extent3d { width: b, height: h, depth_or_array_layers: 1 },
        );

        let mut werk = Musterprobe::neu_wenn_gebraucht(&device).expect("Sonde ist an");
        let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("musterprobe-test"),
        });
        let platz = werk.aufzeichnen(&device, &mut enc, &textur, false);
        queue.submit(Some(enc.finish()));
        if let Some(a) = platz {
            werk.abholung_starten(a);
        }
        // Fuer den TEST wird gewartet — im Betrieb ausdruecklich nicht.
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
        werk.ernten(&device);

        let ernte = werk.nehmen().expect("die Zeilen muessen nach dem Warten dastehen");
        assert_eq!(ernte.zeilen.len(), POS_Y.len(), "alle vier Zeilen passen in 1440p");
        // Die Sonde findet den Balken, ohne dass wir ihr die Stelle sagen. Die
        // Epoche wird so gelegt, dass genau 80 ms herauskommen muessen —
        // waere irgendetwas am Weg verschoben (falsche Zeile, falscher Versatz,
        // falsche Bitlage), gaebe es stattdessen einen Fehlschlag.
        let mut probe = LatencyProbe::fuer_test(
            ernte.stempel_ms.saturating_sub(u64::from(ZAEHLER) + 80),
        );
        probe.note_gpu(&ernte);
        probe.roll();
        assert_eq!(probe.misses(), 0, "der Balken muss in den kopierten Zeilen stehen");
        assert_eq!(probe.avg_us(), 80_000, "die gemalte Zahl muss exakt zurueckkommen");
    }
}
