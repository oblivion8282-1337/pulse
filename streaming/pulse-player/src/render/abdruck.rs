//! Den Fingerabdruck des Bildes auf der GPU rechnen — und ihn ABHOLEN, ohne
//! auf sie zu warten.
//!
//! Der Einfrier-Waechter (`crate::einfrieren`) braucht je Bild eine Zahl, die
//! sich aendert, wenn sich das Bild aendert. Auf dem Weg ueber den
//! Hauptspeicher liest er dafuer die Ebenen; auf dem Zero-Copy-Weg
//! ([`crate::zerocopy`]) gibt es die nicht mehr. Gerechnet wird die Zahl
//! deshalb hier, in einem Durchgang ueber die Luma-Ebene der eingehaengten
//! Fremdtextur. WAS gerechnet wird, steht bei
//! [`crate::einfrieren::luma_abdruck`] und im Shader `abdruck.wgsl`.
//!
//! ## Die eigentliche Schwierigkeit ist der Rueckweg, nicht die Rechnung
//!
//! Ein Ergebnis von der GPU abzuholen, indem man auf sie wartet, ist genau die
//! Rundreise, die der Zero-Copy-Weg gerade beseitigt hat: `map_async` plus
//! `PollType::Wait` je Bild kostete die Wartezeit bis zum Ende des laufenden
//! Zeichendurchgangs — dieselbe Groessenordnung wie das Ruecklesen, das damit
//! eingespart werden sollte, und obendrein ein neuer Anlass fuer Stockungen
//! (`crate::stockung`).
//!
//! Deshalb **angefordert und spaeter abgeholt**: je Bild wird die Rechnung
//! abgeschickt und das Ergebnis in einen von [`RING_PLAETZE`] Abholpuffern
//! kopiert; eingesammelt wird, was aus FRUEHEREN Bildern bereits fertig
//! dasteht. Der Waechter zaehlt ueber Sekunden — ein Versatz von ein bis zwei
//! Bildern ist ihm gleichgueltig, solange die Reihenfolge stimmt. Sie stimmt,
//! weil [`Abdruckwerk::ernten`] die Plaetze nach ihrer laufenden Nummer
//! abraeumt und beim ersten unfertigen abbricht.
//!
//! Ist gerade kein Platz frei (alle drei noch unterwegs), faellt der Abdruck
//! dieses einen Bildes aus. Das ist kein Fehler, sondern der Gegendruck: der
//! Waechter bekommt dann eben eine Stichprobe der Bilder statt aller — und
//! seine Frage („aendert sich ueberhaupt noch etwas") beantwortet die genauso.
//!
//! ## Und die Rechnung faehrt im Zeichendurchgang mit (seit 2026-08-06)
//!
//! Sie hat **keinen eigenen Kommandopuffer** mehr. Bis dahin legte
//! `Abdruckwerk::schritt` einen an, gab ihn selbst ab und kostete damit eine
//! **zweite** `submit` je Bild — unter D3D12 ein zusaetzliches
//! `ExecuteCommandLists` samt Zaun-Signal, in derselben Warteschlange wie der
//! Zeichendurchgang und damit gegen ihn serialisiert. Gemessen schlug das mit
//! rund 0,3 ms je Bild im Posten „hochladen" zu Buche
//! (`profiles/player-2026-08-06-einfrier-waechter-auf-der-gpu.json`).
//!
//! Jetzt zeichnet [`Abdruckwerk::aufzeichnen`] in den Kommandopuffer des
//! Renderers, und [`Abdruckwerk::abholung_starten`] laeuft nach dessen
//! `submit`. **Der Waechter sieht dabei genauso viele Bilder wie vorher** —
//! das war die Bedingung: die naheliegende Abhilfe „nur jedes n-te Bild
//! rechnen" haette zwei Drittel der Kosten gespart und die Erkennung im selben
//! Verhaeltnis traeger gemacht, also die Schwellen in `crate::einfrieren`
//! mitverschoben. Hier aendert sich an der Empfindlichkeit nichts.
//!
//! Bezahlt ist es mit einer Zusage, die auseinanderfallen kann: Aufzeichnen
//! und Abholen sind jetzt zwei Aufrufe mit einer Reihenfolge dazwischen
//! (Begruendung an [`Abdruckwerk::abholung_starten`]).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::einfrieren::Briefkasten;

/// Wie viele Abholpuffer gleichzeitig unterwegs sein duerfen.
///
/// Drei, weil das Ergebnis typisch ein bis zwei Bilder braucht (die Rechnung
/// haengt hinter dem Zeichendurchgang desselben Bildes in derselben
/// Warteschlange). Zwei waeren knapp — dann faellt bei jedem Ruckler ein Bild
/// aus. Vier brachten in nichts eine Verbesserung und kosten je einen
/// Abholpuffer samt Zuordnung.
const RING_PLAETZE: usize = 3;

/// Kantenlaenge einer Arbeitsgruppe. **Muss zu `@workgroup_size` in
/// `abdruck.wgsl` passen** — laufen die beiden auseinander, deckt der Aufruf
/// entweder nicht das ganze Bild ab (zu klein) oder rechnet ins Leere.
const KANTE: u32 = 8;

/// Ein Abholpuffer samt seinem Zustand.
struct Platz {
    puffer: wgpu::Buffer,
    /// Vom Rueckruf des Treibers gesetzt, aus einem fremden Thread. Deshalb
    /// atomar und nicht `bool`.
    fertig: Arc<AtomicBool>,
    /// Laeuft eine Rechnung auf diesen Platz?
    belegt: bool,
    /// Laufende Nummer der Anforderung — die Reihenfolge der Abdruecke.
    nummer: u64,
}

/// Rechenwerk und Abholung, einmal je Renderer.
pub(super) struct Abdruckwerk {
    pipeline: wgpu::ComputePipeline,
    layout: wgpu::BindGroupLayout,
    /// Breite, Hoehe und Skalierung des laufenden Bildes.
    masse: wgpu::Buffer,
    /// Wohin der Shader summiert. **Einer fuer alle Bilder**, und das geht:
    /// Leeren, Rechnen und Wegkopieren stehen in EINEM Kommandopuffer, und die
    /// Warteschlange arbeitet sie der Reihe nach ab. Ein Puffer je Ringplatz
    /// waere eine zweite Zuordnung ohne Gegenwert.
    summe: wgpu::Buffer,
    ring: Vec<Platz>,
    zaehler: u64,
}

impl Abdruckwerk {
    pub fn neu(device: &wgpu::Device) -> Self {
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("pulse-player-abdruck-shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("abdruck.wgsl").into()),
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("pulse-player-abdruck-bind"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Texture {
                        // Dieselbe Angabe wie im Zeichenweg (`setup::texture_entry`):
                        // die Ebenen-Ansicht ist dieselbe Ansicht, und eine
                        // abweichende Angabe liesse die Bindung scheitern.
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: false },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });
        let rohr = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("pulse-player-abdruck-layout"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("pulse-player-abdruck"),
            layout: Some(&rohr),
            module: &shader,
            entry_point: Some("abdruck"),
            compilation_options: Default::default(),
            cache: None,
        });
        let masse = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("pulse-player-abdruck-masse"),
            size: 16,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let summe = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("pulse-player-abdruck-summe"),
            size: 8,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_SRC
                | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let ring = (0..RING_PLAETZE)
            .map(|i| Platz {
                puffer: device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some("pulse-player-abdruck-abholung"),
                    size: 8,
                    usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                    mapped_at_creation: false,
                }),
                fertig: Arc::new(AtomicBool::new(false)),
                belegt: false,
                nummer: i as u64,
            })
            .collect();
        Self { pipeline, layout, masse, summe, ring, zaehler: 0 }
    }

    /// Die Bindung fuer eine Luma-Ansicht.
    ///
    /// Gebaut wird sie **einmal je Ringplatz der Bruecke**, nicht je Bild — sie
    /// liegt deshalb beim Import (`super::fremdbild::Import`) und nicht hier.
    /// Aus demselben Grund wie die Zeichen-Bindegruppe: `create_bind_group` ist
    /// nicht billig, und die Bestandteile sind je Ringplatz unveraenderlich.
    pub fn bindung(&self, device: &wgpu::Device, luma: &wgpu::TextureView) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("pulse-player-abdruck-gruppe"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(luma),
                },
                wgpu::BindGroupEntry { binding: 1, resource: self.masse.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: self.summe.as_entire_binding() },
            ],
        })
    }

    /// Ein Bild: Fertiges einsammeln, Neues **in einen fremden Kommandopuffer
    /// aufzeichnen**. Rueckgabe ist der belegte Ringplatz.
    ///
    /// `breite`/`hoehe` sind die des BILDES, nicht die der Textur — die ist
    /// aufgerundet, und was in der Auffuellung steht, gehoert nicht zum Bild
    /// (s. `zerocopy::GpuBild::textur_masse`).
    ///
    /// **Warum der Aufrufer den Kommandopuffer stellt** (seit 2026-08-06): bis
    /// dahin legte diese Funktion einen eigenen an und gab ihn selbst ab — eine
    /// **zweite** `submit` je Bild neben der des Zeichendurchgangs. Unter D3D12
    /// ist jede Abgabe ein `ExecuteCommandLists` samt Zaun-Signal, und beide
    /// lagen in derselben Warteschlange, serialisierten also gegeneinander. Der
    /// Posten „hochladen" stieg dadurch von 0,0-0,1 auf 0,3-0,4 ms
    /// (`profiles/player-2026-08-06-einfrier-waechter-auf-der-gpu.json`). In
    /// den vorhandenen Durchgang gefaltet bleibt EINE Abgabe je Bild, und der
    /// Waechter sieht **genauso viele Bilder wie vorher** — anders als bei der
    /// naheliegenden Abhilfe „nur jedes n-te Bild rechnen", die seine
    /// Empfindlichkeit mitgesenkt haette.
    ///
    /// **Der Aufrufer MUSS nach dem `submit` desselben Kommandopuffers
    /// [`Abdruckwerk::abholung_starten`] mit dem Rueckgabewert rufen** — sonst
    /// bleibt der Platz belegt, sein Inhalt wird nie abgeholt, und der Waechter
    /// bekaeme von diesem Ringplatz nie wieder einen Abdruck. Deshalb ist die
    /// Rueckgabe ein eigener `#[must_use]`-Typ und keine blosse Zahl: das
    /// Vergessen wird zur Warnung des Uebersetzers.
    pub fn aufzeichnen(
        &mut self,
        enc: &mut wgpu::CommandEncoder,
        teile: Werkteile<'_>,
        bild: Bildangabe,
        kasten: &Briefkasten,
    ) -> Option<Abholung> {
        self.ernten(teile.device, kasten);
        let i = self.freier_platz()?;

        // 255 bei NV12 (R8Unorm), 65535 bei P010 (R16Unorm): `textureLoad`
        // liefert den normierten Wert, und das hier holt die ganze Zahl zurueck.
        let skala: f32 = if bild.zehn_bit { 65535.0 } else { 255.0 };
        let mut kopf = [0u8; 16];
        kopf[0..4].copy_from_slice(&bild.breite.to_le_bytes());
        kopf[4..8].copy_from_slice(&bild.hoehe.to_le_bytes());
        kopf[8..12].copy_from_slice(&skala.to_le_bytes());
        teile.queue.write_buffer(&self.masse, 0, &kopf);

        // Ohne das Leeren summierte jedes Bild auf das vorige auf — der Abdruck
        // waere dann eine Laufsumme und aenderte sich in JEDEM Bild, auch im
        // stehenden. Der Waechter saehe nie ein eingefrorenes Bild.
        //
        // **Das gilt auch im geteilten Kommandopuffer**: Leeren, Rechnen und
        // Wegkopieren stehen weiterhin unmittelbar hintereinander darin, und
        // der Zeichendurchgang, der danach hineinkommt, ruehrt `summe` nicht an.
        enc.clear_buffer(&self.summe, 0, None);
        {
            let mut pass = enc.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("pulse-player-abdruck-pass"),
                timestamp_writes: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, teile.bindung, &[]);
            pass.dispatch_workgroups(bild.breite.div_ceil(KANTE), bild.hoehe.div_ceil(KANTE), 1);
        }
        enc.copy_buffer_to_buffer(&self.summe, 0, &self.ring[i].puffer, 0, 8);
        Some(Abholung(i))
    }

    /// Die Abholung des in [`Abdruckwerk::aufzeichnen`] belegten Platzes
    /// anstossen — **erst nach dem `submit`**, nie davor.
    ///
    /// Die Reihenfolge ist keine Foermlichkeit. `map_async` ordnet sich gegen
    /// die zum Zeitpunkt des Aufrufs BEREITS abgegebene Arbeit ein; vor dem
    /// `submit` gerufen, koennte die Abbildung fertig sein, bevor die Kopie in
    /// den Abholpuffer ueberhaupt gelaufen ist — der Waechter bekaeme dann den
    /// Inhalt eines frueheren Bildes oder Nullen. Solange `aufzeichnen` seinen
    /// Kommandopuffer selbst abgab, war das eine Zeile weiter unten und konnte
    /// nicht auseinanderfallen; jetzt haelt es diese Trennung zusammen.
    ///
    /// [`Abholung`] wird dabei VERBRAUCHT — damit ist auch der zweite Fehler
    /// ausgeschlossen, denselben Platz zweimal einzuloesen.
    pub fn abholung_starten(&mut self, abholung: Abholung) {
        let Abholung(i) = abholung;
        let fertig = self.ring[i].fertig.clone();
        self.ring[i].puffer.slice(..).map_async(wgpu::MapMode::Read, move |r| {
            // Bei einem Fehler bleibt der Platz unfertig und damit belegt —
            // das ist gewollt: ein Platz weniger im Ring ist harmlos, ein
            // Abdruck aus einem nicht abgebildeten Puffer waere Unsinn.
            if r.is_ok() {
                fertig.store(true, Ordering::Release);
            }
        });
        self.ring[i].belegt = true;
        self.ring[i].nummer = self.zaehler;
        self.zaehler += 1;
    }

    /// Alles einsammeln, was fertig dasteht — **in der Reihenfolge der
    /// Anforderung**.
    ///
    /// Die Reihenfolge ist die eine Eigenschaft, auf die der Waechter angewiesen
    /// ist: er zaehlt, wie oft derselbe Wert HINTEREINANDER kam. Kaeme der
    /// Abdruck von Bild 7 nach dem von Bild 8, saehe er einen Wechsel, wo keiner
    /// war. Deshalb wird beim ersten unfertigen Platz abgebrochen und nicht
    /// weitergesucht.
    fn ernten(&mut self, device: &wgpu::Device, kasten: &Briefkasten) {
        // Ohne diesen Anstoss laufen die Rueckrufe des Treibers nie an —
        // `Poll` fragt nur nach und blockiert nicht.
        let _ = device.poll(wgpu::PollType::Poll);
        while let Some(i) = self.aeltester_fertiger() {
            let wert = {
                // `expect` und nicht `?`: seit wgpu 30 gibt `get_mapped_range`
                // ein `Result` zurueck, wo es vorher selbst panickte — die
                // Fehlerfaelle sind dieselben geblieben, und keiner von ihnen
                // kann hier eintreten (`aeltester_fertiger` liefert nur Plaetze,
                // deren `map_async` durch ist). Ein Ergebnis still zu
                // verschlucken hiesse, einen falschen Abdruck zu melden.
                let sicht = self.ring[i]
                    .puffer
                    .slice(..)
                    .get_mapped_range()
                    .expect("Abdruck-Puffer war als fertig gemeldet, ist aber nicht lesbar");
                let roh: [u8; 8] = sicht[..8].try_into().unwrap_or([0; 8]);
                // Zwei u32 in der Reihenfolge des Shaders; die obere Haelfte des
                // Abdrucks ist die erste Summe (wie im Zwilling auf der CPU).
                let a = u32::from_le_bytes([roh[0], roh[1], roh[2], roh[3]]);
                let b = u32::from_le_bytes([roh[4], roh[5], roh[6], roh[7]]);
                (u64::from(a) << 32) | u64::from(b)
            };
            self.ring[i].puffer.unmap();
            self.ring[i].fertig.store(false, Ordering::Release);
            self.ring[i].belegt = false;
            kasten.einwerfen(wert);
        }
    }

    /// Der aelteste belegte Platz — aber nur, wenn er FERTIG ist.
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

/// Ein belegter Ringplatz, dessen Abholung noch anzustossen ist.
///
/// **Ein eigener Typ und kein `usize`**, damit die Zusage zwischen
/// [`Abdruckwerk::aufzeichnen`] und [`Abdruckwerk::abholung_starten`] nicht
/// allein im Kommentar steht: `#[must_use]` macht das Vergessen zur Warnung,
/// und weil `abholung_starten` ihn verbraucht, laesst er sich nicht zweimal
/// einloesen. Beides waeren stille Fehler — der Waechter bekaeme falsche oder
/// gar keine Abdruecke und meldete Einfrieren, wo keines ist.
///
/// Ein `Drop`, der die Abholung selbst anstiesse, ginge NICHT: er bekaeme das
/// `&mut Abdruckwerk` nicht, das `map_async` dafuer braucht.
#[must_use = "ohne abholung_starten bleibt der Ringplatz belegt und sein Abdruck ungelesen"]
pub(super) struct Abholung(usize);

/// Was das Rechenwerk je Bild von aussen braucht.
///
/// Als Buendel, damit [`Abdruckwerk::aufzeichnen`] sie nicht einzeln und in der
/// richtigen Reihenfolge entgegennehmen muss — der Aufrufer haelt sie ohnehin
/// alle in derselben Hand.
pub(super) struct Werkteile<'a> {
    pub device: &'a wgpu::Device,
    pub queue: &'a wgpu::Queue,
    /// Die Bindung dieses Ringplatzes (s. [`Abdruckwerk::bindung`]).
    pub bindung: &'a wgpu::BindGroup,
}

/// Masse und Bittiefe des Bildes.
#[derive(Clone, Copy)]
pub(super) struct Bildangabe {
    pub breite: u32,
    pub hoehe: u32,
    pub zehn_bit: bool,
}

impl Bildangabe {
    /// Die Angaben eines eingehaengten Fremdbildes.
    ///
    /// Steht hier und nicht am Aufrufort, damit `render` beim Zusammenstellen
    /// des Auftrags eine Zeile braucht statt fuenf — die Datei dort liegt ueber
    /// der Groessen-Grenze (`PLAN.md` §12.1), diese nicht.
    pub(super) fn vom_fremdbild(f: &super::Fremdform) -> Self {
        Self { breite: f.width, hoehe: f.height, zehn_bit: f.gpu.zehn_bit() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::einfrieren::luma_abdruck;

    /// Ein Geraet, oder gar kein Test.
    ///
    /// **Kein `unwrap`**: auf einer Maschine ohne Grafikausgabe (CI-Container,
    /// Server) gaebe es sonst einen roten Test, der nichts ueber den Code
    /// aussagt. Die Meldung sagt dafuer deutlich, dass hier nichts geprueft
    /// wurde — ein stillschweigend uebersprungener Test waere schlimmer als
    /// keiner.
    fn geraet() -> Option<(wgpu::Device, wgpu::Queue)> {
        let instanz =
            wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
        let adapter = pollster::block_on(instanz.request_adapter(&Default::default())).ok()?;
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("pulse-player-abdruck-test"),
            ..Default::default()
        }))
        .ok()?;
        Some((device, queue))
    }

    /// Ein Bild anfordern, so wie der Renderer es tut: aufzeichnen, abgeben,
    /// dann die Abholung anstossen.
    ///
    /// **Als Helfer und nicht dreimal ausgeschrieben**, damit die Tests
    /// dieselbe Reihenfolge fahren wie `render::Renderer::render`. Ginge das
    /// hier auseinander, prueften sie einen Ablauf, den im Betrieb niemand
    /// ausfuehrt — genau der Fall, den `abholung_starten` beschreibt.
    fn anfordern(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        werk: &mut Abdruckwerk,
        bindung: &wgpu::BindGroup,
        bild: Bildangabe,
        kasten: &Briefkasten,
    ) {
        let mut enc = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("abdruck-test"),
        });
        let platz = werk.aufzeichnen(&mut enc, Werkteile { device, queue, bindung }, bild, kasten);
        queue.submit(Some(enc.finish()));
        if let Some(abholung) = platz {
            werk.abholung_starten(abholung);
        }
    }

    /// Ein Bild als R8Unorm-Textur hochladen und den Abdruck darueber rechnen.
    fn auf_der_gpu(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        werk: &mut Abdruckwerk,
        daten: &[u8],
        breite: u32,
        hoehe: u32,
    ) -> u64 {
        let textur = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("abdruck-test"),
            size: wgpu::Extent3d { width: breite, height: hoehe, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::R8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &textur,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            daten,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(breite),
                rows_per_image: Some(hoehe),
            },
            wgpu::Extent3d { width: breite, height: hoehe, depth_or_array_layers: 1 },
        );
        let sicht = textur.create_view(&wgpu::TextureViewDescriptor::default());
        let bindung = werk.bindung(device, &sicht);
        let kasten = Briefkasten::neu();
        anfordern(
            device,
            queue,
            werk,
            &bindung,
            Bildangabe { breite, hoehe, zehn_bit: false },
            &kasten,
        );
        // Fuer den TEST wird gewartet — im Betrieb ausdruecklich nicht
        // (Modulkopf). Ohne das Warten haette der Test nichts abzuholen.
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
        werk.ernten(device, &kasten);
        kasten.nehmen().expect("der Abdruck muss nach dem Warten dastehen")
    }

    /// **Der Nachweis, dass die beiden Fassungen dasselbe rechnen.** Ohne ihn
    /// waere `luma_abdruck` eine Behauptung ueber den Shader statt seines
    /// Zwillings — und die Tests dort prueften eine Rechnung, die im Betrieb
    /// niemand ausfuehrt.
    #[test]
    fn gpu_und_cpu_rechnen_dasselbe() {
        let Some((device, queue)) = geraet() else {
            eprintln!("kein GPU-Adapter — dieser Test hat NICHTS geprueft");
            return;
        };
        let mut werk = Abdruckwerk::neu(&device);
        // Absichtlich keine Vielfachen von 8: die Kachelung muss ueber den Rand
        // hinausrechnen duerfen, ohne dass die Auffuellung mitzaehlt.
        let (b, h) = (253u32, 131u32);
        let daten: Vec<u8> = (0..(b * h) as usize).map(|i| (i * 7 % 256) as u8).collect();
        assert_eq!(
            auf_der_gpu(&device, &queue, &mut werk, &daten, b, h),
            luma_abdruck(&daten, b, h, b as usize, false),
            "Shader und CPU-Zwilling muessen denselben Wert liefern"
        );
    }

    /// Der eigentliche Massstab, auf echter Hardware: **ein Bildpunkt reicht**.
    #[test]
    fn ein_einzelner_bildpunkt_faellt_auch_auf_der_gpu_auf() {
        let Some((device, queue)) = geraet() else {
            eprintln!("kein GPU-Adapter — dieser Test hat NICHTS geprueft");
            return;
        };
        let mut werk = Abdruckwerk::neu(&device);
        let (b, h) = (1920u32, 1080u32);
        let ohne = vec![40u8; (b * h) as usize];
        let mut mit = ohne.clone();
        mit[701 * b as usize + 933] = 41;
        let a = auf_der_gpu(&device, &queue, &mut werk, &ohne, b, h);
        let c = auf_der_gpu(&device, &queue, &mut werk, &mit, b, h);
        assert_ne!(a, c, "eine Helligkeitsstufe an einer Stelle muss den Abdruck aendern");
        // Und derselbe Inhalt muss denselben Wert geben, sonst meldete der
        // Waechter dauernd Bewegung.
        assert_eq!(a, auf_der_gpu(&device, &queue, &mut werk, &ohne, b, h));
    }

    /// Die Reihenfolge ist die Bedingung, unter der der Versatz folgenlos ist.
    /// Hier wird sie an drei Bildern nachgewiesen, die zusammen den Ring
    /// fuellen.
    #[test]
    fn die_abdruecke_kommen_in_der_reihenfolge_der_bilder() {
        let Some((device, queue)) = geraet() else {
            eprintln!("kein GPU-Adapter — dieser Test hat NICHTS geprueft");
            return;
        };
        let mut werk = Abdruckwerk::neu(&device);
        let (b, h) = (64u32, 64u32);
        let erwartet: Vec<u64> = (0..RING_PLAETZE as u8)
            .map(|n| {
                let daten = vec![n * 20 + 5; (b * h) as usize];
                luma_abdruck(&daten, b, h, b as usize, false)
            })
            .collect();

        let texturen: Vec<_> = (0..RING_PLAETZE as u8)
            .map(|n| {
                let daten = vec![n * 20 + 5; (b * h) as usize];
                let t = device.create_texture(&wgpu::TextureDescriptor {
                    label: None,
                    size: wgpu::Extent3d { width: b, height: h, depth_or_array_layers: 1 },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: wgpu::TextureFormat::R8Unorm,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                    view_formats: &[],
                });
                queue.write_texture(
                    wgpu::TexelCopyTextureInfo {
                        texture: &t,
                        mip_level: 0,
                        origin: wgpu::Origin3d::ZERO,
                        aspect: wgpu::TextureAspect::All,
                    },
                    &daten,
                    wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(b),
                        rows_per_image: Some(h),
                    },
                    wgpu::Extent3d { width: b, height: h, depth_or_array_layers: 1 },
                );
                t.create_view(&wgpu::TextureViewDescriptor::default())
            })
            .collect();

        let kasten = Briefkasten::neu();
        for sicht in &texturen {
            let bindung = werk.bindung(&device, sicht);
            anfordern(
                &device,
                &queue,
                &mut werk,
                &bindung,
                Bildangabe { breite: b, hoehe: h, zehn_bit: false },
                &kasten,
            );
        }
        let _ = device.poll(wgpu::PollType::wait_indefinitely());
        werk.ernten(&device, &kasten);

        let mut gesehen = Vec::new();
        while let Some(v) = kasten.nehmen() {
            gesehen.push(v);
        }
        assert_eq!(gesehen, erwartet, "die Reihenfolge der Bilder muss erhalten bleiben");
    }
}
