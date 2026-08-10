//! Die andere Haelfte der Bruecke: ein fremdes GPU-Bild in wgpu einhaengen und
//! als Ebenen-Ansichten binden.
//!
//! Gegenstueck zu [`crate::zerocopy`]; dort steht, warum es die Bruecke
//! ueberhaupt gibt und was sie kostet.
//!
//! ## Zwei Plattformen, drei Einhaengungen, EINE Bindegruppe
//!
//! Was der Shader sieht, ist auf allen Seiten dasselbe: zwei Ansichten (Luma,
//! Chroma) plus eine Blindtextur. Wie sie entstehen, ist von der jeweiligen
//! Schnittstelle erzwungen:
//!
//! | | Windows | Linux |
//! |---|---|---|
//! | Was ankommt | EINE geteilte NV12/P010-Textur | ZWEI Ebenen (R8+Rg8 bzw. R16+Rg16) |
//! | Warum | D3D11 gibt den Decoder-Frame so heraus | CUDA weist ein mehrplaniges `VkImage` ab, VAAPI exportiert getrennte Layer (beides gemessen) |
//! | Die zwei Ansichten | zwei ASPEKTE (`Plane0`/`Plane1`) einer Textur | zwei eigenstaendige Texturen |
//! | Noetige Merkmale | `TEXTURE_FORMAT_NV12`/`P010` | `16BIT_NORM` fuer 10 bit, `VULKAN_EXTERNAL_MEMORY_DMA_BUF` fuer VAAPI |
//!
//! Die beiden Linux-Wege stehen in [`super::fremdlinux`] und unterscheiden sich
//! erst darin, WOHER die zwei Texturen kommen. Daraus folgt die Stelle, an der
//! man beim Aendern aufpassen muss: [`Fremdbilder::moeglich`] fragt je Seite
//! **verschiedene** Merkmale ab. Wer dort das Windows-Merkmal auch fuer Linux
//! verlangte, schaltete den Weg dort grundlos ab — `TEXTURE_FORMAT_NV12` gibt
//! es im Vulkan-Unterbau von wgpu 29 nicht, obwohl der Weg traegt.
//!
//! ## Windows: nur ueber D3D12
//!
//! `wgpu-hal` 29.0.4 kann eine D3D11-Textur auf zwei Wegen
//! aufnehmen, und beide sind an ihr Backend gebunden:
//! `texture_from_d3d11_shared_handle` gibt es ausschliesslich im
//! Vulkan-Backend, `texture_from_raw` ausschliesslich im dx12-Backend. Der
//! Player faehrt unter Windows D3D12 (`setup::backends`, Voraussetzung fuer
//! HDR), also fuehrt der Weg hier ueber `ID3D12Device::OpenSharedHandle` und
//! `texture_from_raw`. Wer das Backend umstellt, verliert Zero-Copy — und
//! bekommt den Rueckfall, nicht einen Absturz.
//!
//! Gemessen als tragend auf einer Radeon 780M, NV12 und P010, auch beim
//! wiederholten Beschreiben derselben Textur:
//! `streaming/testbench/profiles/player-2026-08-06-zerocopy-d3d12-amd.json`.
//!
//! ## Zur Laenge dieser Datei
//!
//! Sie liegt ueber der Groessengrenze des Projekts, und das ist gesehen und
//! stehengelassen: der einzige sinnvolle Schnitt waere die Windows-Haelfte
//! (`einhaengen`/`oeffnen`) als Gegenstueck zu [`super::fremdlinux`]. Genau die
//! laesst sich auf der Entwicklungsmaschine nicht uebersetzen — ein Verschieben
//! ohne jede Probe waere teurer als die ueberzaehligen Zeilen. Wer das naechste
//! Mal unter Windows baut, hat den passenden Zeitpunkt.

use std::collections::HashMap;
use std::sync::Arc;

#[cfg(windows)]
use crate::decode::PixelLayout;
use crate::zerocopy::GpuBild;

/// Wie viele Einhaengungen des VAAPI-Weges gleichzeitig aufgehoben bleiben (s.
/// [`Fremdbilder::aufraeumen`]).
///
/// Drei, weil so viele Bilder hoechstens zugleich unterwegs sind: das gerade
/// eingetragene, das gezeichnete und das, dessen Zeichendurchgang noch laeuft
/// (die Swapchain fuehrt `desired_maximum_frame_latency + 1`). Weniger hiesse,
/// eine Surface freizugeben, auf die noch gezeichnet wird; mehr hielte dem
/// Decoder ohne Gewinn Vorrat vor — und der ist hier die knappe Groesse
/// (`zerocopy::vaapi::anker`).
///
/// **Die Zahl zaehlt das eben eingetragene Bild MIT**, denn [`Fremdbilder::aufraeumen`]
/// laeuft direkt nach dem Eintragen: nachgehalten sind also zwei Vorgaenger,
/// nicht drei. Bis zum 2026-08-10 stand daneben „drei volle Bilddurchgaenge
/// Abstand" — das war eine Verwechslung mit dieser Grenze; die drei
/// gleichzeitig lebenden Bilder oben sind gemeint und gedeckt.
const NACHHUT: usize = 3;

/// Ein eingehaengtes Bild samt seiner beiden Ebenen-Ansichten.
pub struct Import {
    /// Gehalten, weil die Bindegruppe daran haengt.
    ///
    /// Ein `Vec`, weil Linux ZWEI Texturen einhaengt und Windows eine
    /// (s. Modulkopf). **Der erste Eintrag ist die Luma-Seite** — daraus holt
    /// die Latenz-Sonde ihre Musterzeilen ([`Fremdbilder::luma_textur`]).
    texturen: Vec<wgpu::Texture>,
    /// Ob sich die Luma-Seite als Kopierquelle benutzen laesst — die
    /// Latenz-Sonde holt daraus ihre Musterzeilen (s. [`super::musterprobe`]).
    ///
    /// **Nur auf Linux und nur mit laufender Sonde `true`.** Zwei Gruende, und
    /// beide zaehlen einzeln: ohne Sonde soll die eingehaengte Textur gar keine
    /// zusaetzliche Nutzungsart tragen, und auf Windows ist der Fall nicht
    /// beurteilt — dort ist die Luma-Seite ein ASPEKT einer NV12/P010-Textur,
    /// deren Kopierbarkeit an der geteilten D3D11-Ressource haengt und hier
    /// nicht nachgemessen werden konnte. Lieber eine Sonde, die auf Windows
    /// deutlich sagt „hier nicht" (s. `musterprobe::nicht_kopierbar_melden`),
    /// als eine Nutzungsart, die den dortigen Zero-Copy-Weg umwirft.
    luma_kopierbar: bool,
    /// Die fertige Bindegruppe dieses Ringplatzes.
    ///
    /// **Hier stand die Bindegruppe frueher NICHT, sie entstand je Bild neu**,
    /// mit der Begruendung „der Ring rotiert je Bild, die Ansichten sind also
    /// andere". Das erklaert nur, warum EINE feste Gruppe nicht reicht — nicht,
    /// warum eine je Ringplatz es nicht taete. Alle fuenf Bestandteile sind je
    /// Ringplatz unveraenderlich (die beiden Ebenen-Ansichten, die Blindtextur,
    /// der Sampler und der Uniform-Puffer; letzterer wird beschrieben, nicht neu
    /// gebunden). `create_bind_group` ist in wgpu nicht billig — Layout-Pruefung,
    /// Deskriptoren in den shader-sichtbaren Haufen, fuenf Arc-Klone in die
    /// Ressourcen-Verfolgung —, und die alte Gruppe ging jedes Bild in die
    /// verzoegerte Zerstoerung. Bei 60 Bildern je Sekunde waren das 60 Gruppen
    /// je Sekunde statt einer je Ringplatz und Sitzung (heute 24, bis zum
    /// 2026-08-07 zwoelf — hier stand deshalb „statt zwoelf").
    pub bindegruppe: wgpu::BindGroup,
    /// Die Bindung fuer den Fingerabdruck (nur die Luma-Ansicht, s.
    /// [`super::abdruck`]). Aus demselben Grund hier wie `bindegruppe`: je
    /// Ringplatz unveraenderlich, also einmal gebaut statt sechzigmal je
    /// Sekunde.
    pub abdruck_gruppe: wgpu::BindGroup,
    /// Das Bild, dessen Speicher diese Texturen benutzen — **nur auf dem
    /// VAAPI-Weg gesetzt**, wo der Lebensanker nicht in den `drop_callback` der
    /// hal-Textur passt (Kopf von [`super::fremdlinux`]). Zugleich das Merkmal,
    /// an dem [`Fremdbilder`] erkennt, dass dieser Eintrag **nicht** dauerhaft
    /// bleibt.
    festhalten: Option<Arc<GpuBild>>,
}

/// Zwischenspeicher der Einhaengungen, ein Eintrag je Ringplatz.
///
/// **Der Schluessel ist das NT-Handle**, und das ist genau richtig: die Bruecke
/// legt ihren Ring einmal an und behaelt die Handles, bis Masse oder Format
/// sich aendern. Ein Bild je Einhaengung waere Verschwendung (0,5 ms Import je
/// Bild statt einmalig je Ringplatz), ein Zwischenspeicher ueber die
/// Bildnummer waere falsch.
pub struct Fremdbilder {
    importe: HashMap<isize, Import>,
    /// Die Schluessel der Eintraege, die **nicht** dauerhaft bleiben duerfen,
    /// in der Reihenfolge ihres Entstehens (s. [`Fremdbilder::aufraeumen`]).
    /// Auf den Wegen mit festem Ring bleibt sie leer.
    nachhut: Vec<isize>,
    /// Fuellt die dritte Bindung. Der Shader liest sie bei verschraenktem UV
    /// nicht, binden muss man sie trotzdem.
    blind: wgpu::TextureView,
    /// Masse und Bittiefe, fuer die die Eintraege gelten.
    ///
    /// **Ohne das waere der Zwischenspeicher gefaehrlich, nicht nur veraltet.**
    /// Aendert sich die Aufloesung, baut die Bruecke ihren Ring neu und
    /// SCHLIESST die alten NT-Handles — und Windows vergibt Handle-Werte
    /// wieder. Ein neuer Ringplatz kann also denselben Zahlenwert bekommen wie
    /// ein alter, und der Zwischenspeicher lieferte dann die Ansicht auf eine
    /// Textur, die es nicht mehr gibt.
    bauart: Option<(u32, u32, bool)>,
}

impl Fremdbilder {
    /// **Braucht das Geraet, statt die Blindtextur spaeter nachzuziehen.** Der
    /// Aufrufer (`Renderer::new`) hat es ohnehin in der Hand; lazy angelegt
    /// zwaenge sie in ein `Option` und damit zwei Fehlerpfade in `binden`, die
    /// nie eintreten koennen.
    pub fn neu(device: &wgpu::Device) -> Self {
        Self {
            importe: HashMap::new(),
            nachhut: Vec::new(),
            blind: blindtextur(device),
            bauart: None,
        }
    }

    /// Welche Merkmale das Geraet braucht, damit dieser Weg ueberhaupt offen
    /// ist — so weit die GPU sie anbietet.
    ///
    /// **Alle Merkmale zusammen anfordern und nicht je Strom nachfordern:** ein
    /// Geraet laesst sich in wgpu nicht nachtraeglich erweitern, und ob ein
    /// Strom 8 oder 10 bit fuehrt, steht erst beim ersten Bild fest. P010
    /// braucht ausserdem `TEXTURE_FORMAT_16BIT_NORM` fuer seine
    /// Ebenen-Ansichten — das fordert der Player ohnehin schon an.
    ///
    /// Auf Linux sind die beiden mehrplanigen Merkmale wirkungslos (dort
    /// entstehen zwei einfache Texturen), aber `& vorhanden` macht das
    /// harmlos: was die Karte nicht anbietet, wird nicht angefordert.
    ///
    /// **Dazu auf Linux `VULKAN_EXTERNAL_MEMORY_DMA_BUF`** — ohne dieses
    /// Merkmal weist `texture_from_dmabuf_fd` jeden Import ab
    /// (`wgpu-hal-30.0.0/src/vulkan/device.rs:535`), und den VAAPI-Weg gaebe es
    /// gar nicht. Der `#[cfg]` steht dabei, damit die Anforderung nur auf der
    /// Plattform gestellt wird, die sie braucht: dass `& vorhanden` sie auf
    /// einem D3D12-Geraet ohnehin verschluckt, waere Zufall und keine
    /// Begruendung.
    pub fn merkmale(vorhanden: wgpu::Features) -> wgpu::Features {
        let mut noetig = wgpu::Features::TEXTURE_FORMAT_NV12 | wgpu::Features::TEXTURE_FORMAT_P010;
        #[cfg(target_os = "linux")]
        {
            noetig |= wgpu::Features::VULKAN_EXTERNAL_MEMORY_DMA_BUF;
        }
        noetig & vorhanden
    }

    /// Traegt das Geraet den Weg fuer dieses Bild?
    ///
    /// **Die Antwort ist plattformabhaengig** — Begruendung im Modulkopf.
    pub fn moeglich(device: &wgpu::Device, zehn_bit: bool) -> bool {
        let f = device.features();
        #[cfg(target_os = "linux")]
        {
            // Zwei eigenstaendige Texturen: `R8Unorm`/`Rg8Unorm` gehoeren zum
            // Kern, nur die 16-bit-Fassungen haengen an einem Merkmal.
            !zehn_bit || f.contains(wgpu::Features::TEXTURE_FORMAT_16BIT_NORM)
        }
        #[cfg(not(target_os = "linux"))]
        if zehn_bit {
            f.contains(wgpu::Features::TEXTURE_FORMAT_P010)
                && f.contains(wgpu::Features::TEXTURE_FORMAT_16BIT_NORM)
        } else {
            f.contains(wgpu::Features::TEXTURE_FORMAT_NV12)
        }
    }

    /// Die fertige Bindegruppe fuer dieses Bild. `None` heisst: der Import ist
    /// nicht moeglich — der Aufrufer schaltet den Weg dann ab.
    pub fn binden(
        &mut self,
        device: &wgpu::Device,
        teile: &Bindeteile<'_>,
        bild: &Arc<GpuBild>,
        werk: &super::abdruck::Abdruckwerk,
    ) -> Option<&wgpu::BindGroup> {
        if !Self::moeglich(device, bild.zehn_bit()) {
            return None;
        }
        let (bw, bh) = bild.textur_masse();
        let bauart = (bw, bh, bild.zehn_bit());
        if self.bauart != Some(bauart) {
            // Nach einem Formatwechsel zeigen die alten Handles auf Texturen,
            // die es nicht mehr gibt (s. [`Fremdbilder::bauart`]).
            self.importe.clear();
            self.nachhut.clear();
            self.bauart = Some(bauart);
        }
        let schluessel = bild.handle();
        if !self.importe.contains_key(&schluessel) {
            let import = einhaengen(device, teile, &self.blind, bild, werk)?;
            let verganglich = import.festhalten.is_some();
            self.importe.insert(schluessel, import);
            if verganglich {
                self.nachhut.push(schluessel);
                self.aufraeumen();
            }
        }
        self.importe.get(&schluessel).map(|i| &i.bindegruppe)
    }

    /// Alte Einhaengungen des VAAPI-Weges wieder loswerden.
    ///
    /// **Ohne das waere der Zwischenspeicher eine Falle statt einer Hilfe.**
    /// Jeder Eintrag haelt ueber sein `festhalten` eine Decoder-Surface fest;
    /// ein Eintrag je Bild, dauerhaft aufgehoben, naehme dem Decoder binnen
    /// Sekunden seinen ganzen Vorrat, und das Bild bliebe stehen. Auf den Wegen
    /// mit festem Ring passiert hier nichts — dort gibt es nur so viele
    /// Schluessel wie Ringplaetze, und die sollen bleiben. Nicht sofort,
    /// sondern mit [`NACHHUT`] Abstand: dieser Weg kann den Rueckruf nicht
    /// haben, an dem die anderen erkennen, wann die GPU fertig ist (Kopf von
    /// [`super::fremdlinux`]).
    fn aufraeumen(&mut self) {
        while self.nachhut.len() > NACHHUT {
            let alt = self.nachhut.remove(0);
            self.importe.remove(&alt);
        }
    }

    /// Die Abdruck-Bindung eines Ringplatzes (s. [`Import::abdruck_gruppe`]).
    pub fn abdruckgruppe(&self, handle: isize) -> Option<&wgpu::BindGroup> {
        self.importe.get(&handle).map(|i| &i.abdruck_gruppe)
    }

    /// Die Luma-Textur eines Ringplatzes, sofern sie sich kopieren laesst
    /// (s. [`Import::luma_kopierbar`]). `None` heisst: die Latenz-Sonde kann
    /// hier nichts holen.
    pub fn luma_textur(&self, handle: isize) -> Option<&wgpu::Texture> {
        let import = self.importe.get(&handle)?;
        if !import.luma_kopierbar {
            return None;
        }
        import.texturen.first()
    }

    /// Die bereits gebaute Bindegruppe eines Ringplatzes.
    ///
    /// Getrennt von [`Fremdbilder::binden`], weil `render` sie mit `&self`
    /// braucht — `binden` laeuft in `upload` und darf einhaengen, `render`
    /// findet nur noch vor.
    pub fn bindegruppe(&self, handle: isize) -> Option<&wgpu::BindGroup> {
        self.importe.get(&handle).map(|i| &i.bindegruppe)
    }
}

/// Was ausser den Ebenen noch in die Bindegruppe gehoert.
///
/// Als Buendel, damit `binden` nicht vier Einzelteile durchreichen muss und der
/// Aufrufer sie nicht in der falschen Reihenfolge uebergeben kann.
pub struct Bindeteile<'a> {
    pub layout: &'a wgpu::BindGroupLayout,
    pub sampler: &'a wgpu::Sampler,
    pub uniform_buf: &'a wgpu::Buffer,
}

fn blindtextur(device: &wgpu::Device) -> wgpu::TextureView {
    // Dieselbe Bauart wie die Ebenen-Texturen (s. `bildquelle::textur`); nur
    // `COPY_DST` faellt weg, denn hier wird nie etwas hineingeschrieben.
    super::bildquelle::textur(
        device,
        1,
        1,
        wgpu::TextureFormat::R8Unorm,
        wgpu::TextureUsages::TEXTURE_BINDING,
        "pulse-player-blind",
    )
    .create_view(&wgpu::TextureViewDescriptor::default())
}

/// Auf macOS gibt es weder NT-Handles noch CUDA. Dass es diese Fassung gibt,
/// haelt `render/mod.rs` frei von `#[cfg]`-Zweigen; erreicht wird sie ohnehin
/// nie, weil `DecodedFrame::gpu` dort immer `None` ist (s. `zerocopy::leer`).
#[cfg(not(any(windows, target_os = "linux")))]
fn einhaengen(
    _device: &wgpu::Device,
    _teile: &Bindeteile<'_>,
    _blind: &wgpu::TextureView,
    _bild: &Arc<GpuBild>,
    _werk: &super::abdruck::Abdruckwerk,
) -> Option<Import> {
    None
}

/// Linux: die beiden Ebenen des Bildes uebernehmen — CUDA-Weg wie VAAPI-Weg.
///
/// **Wie die zwei Texturen entstehen, steht in [`super::fremdlinux`]**; hier
/// steht nur, was danach mit ihnen geschieht, und das ist auf beiden Wegen
/// dasselbe — der Unterschied betrifft ausschliesslich das Einhaengen. Wer hier
/// eine Fallunterscheidung sieht, hat einen Fehler vor sich.
#[cfg(target_os = "linux")]
fn einhaengen(
    device: &wgpu::Device,
    teile: &Bindeteile<'_>,
    blind: &wgpu::TextureView,
    bild: &Arc<GpuBild>,
    werk: &super::abdruck::Abdruckwerk,
) -> Option<Import> {
    // **Einmal gefragt und beides daraus**: die angemeldete Nutzungsart und das
    // Merkmal `luma_kopierbar` unten muessen dieselbe Antwort tragen. Sonst
    // holte die Sonde aus einer Textur, die `COPY_SRC` gar nicht angemeldet hat.
    let sonde_laeuft = crate::probe::sonde_aktiv();
    let [y, uv] = super::fremdlinux::einhaengen(device, bild, sonde_laeuft)?;
    let luma = y.create_view(&wgpu::TextureViewDescriptor::default());
    let chroma = uv.create_view(&wgpu::TextureViewDescriptor::default());
    // Einmal je Ringplatz, nicht je Bild — Begruendung an `Import::bindegruppe`.
    // Auf dem VAAPI-Weg ist beides dasselbe: dort ist jedes Bild eine eigene
    // Surface, es gibt gar nichts wiederzuverwenden (s. `zerocopy::vaapi`).
    let bindegruppe = super::setup::bind_group_aus_teilen(
        device,
        teile.layout,
        teile.sampler,
        teile.uniform_buf,
        [&luma, &chroma, blind],
    );
    // Der Fingerabdruck liest NUR die Luma-Ebene — Begruendung bei
    // `einfrieren::gpuabdruck`.
    let abdruck_gruppe = werk.bindung(device, &luma);
    Some(Import {
        texturen: vec![y, uv],
        luma_kopierbar: sonde_laeuft,
        bindegruppe,
        abdruck_gruppe,
        festhalten: super::fremdlinux::festhalten(bild),
    })
}

#[cfg(windows)]
fn einhaengen(
    device: &wgpu::Device,
    teile: &Bindeteile<'_>,
    blind: &wgpu::TextureView,
    bild: &Arc<GpuBild>,
    werk: &super::abdruck::Abdruckwerk,
) -> Option<Import> {
    let (breite, hoehe) = bild.textur_masse();
    let format =
        if bild.zehn_bit() { wgpu::TextureFormat::P010 } else { wgpu::TextureFormat::NV12 };
    // Die Ebenen-Formate kommen aus `farbe`, nicht von hier: dort steht auch
    // `scales`, das mit genau dieser Zuordnung rechnet. Zwei Tabellen koennten
    // auseinanderlaufen, ohne dass man es dem Bild ansaehe — genau die
    // Begruendung, mit der `scales` seinerzeit zusammengelegt wurde.
    //
    // `wide = zehn_bit`: auf diesem Weg wird nichts heruntergerechnet. Eine
    // P010-Textur traegt 16 bit, oder es gibt gar keinen Import
    // (`Fremdbilder::moeglich` prueft das Merkmal vorher).
    let (ebene0, ebene1) =
        super::farbe::ebenenformate(bild.zehn_bit(), PixelLayout::BiPlanar420);
    let masse = wgpu::Extent3d { width: breite, height: hoehe, depth_or_array_layers: 1 };

    let ressource = match oeffnen(device, bild.handle()) {
        Ok(r) => r,
        Err(e) => {
            // Eine Zeile, kein Absturz: der Aufrufer faellt auf den Weg ueber
            // den Hauptspeicher zurueck. Haeufigster Grund waere ein anderer
            // Adapter unter FFmpeg als unter wgpu (zwei GPUs im Rechner).
            eprintln!("pulse-player: Zero-Copy nicht moeglich ({e}) — Rueckfall auf Ruecklesen");
            return None;
        }
    };
    // SAFETY: `ressource` wurde gerade von genau diesem Geraet geoeffnet, die
    // Masse stammen aus dem Deskriptor der D3D11-Textur, und `bild` haelt sie
    // am Leben, solange der Import benutzt wird.
    let hal_tex = unsafe {
        wgpu::hal::dx12::Device::texture_from_raw(
            ressource,
            format,
            wgpu::TextureDimension::D2,
            masse,
            1,
            1,
        )
    };
    // SAFETY: die hal-Textur gehoert ab hier wgpu.
    let textur = unsafe {
        device.create_texture_from_hal::<wgpu::hal::api::Dx12>(
            hal_tex,
            &wgpu::TextureDescriptor {
                label: Some("pulse-player-fremdbild"),
                size: masse,
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage: wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[ebene0, ebene1],
            },
            // **Neu in wgpu 30 — und der Wert stimmt hier aus einem ANDEREN
            // Grund als auf der Vulkan-Seite oben.**
            //
            // Dort ist „uninitialisiert" die Wahrheit: das `VkImage` wird mit
            // `initial_layout(UNDEFINED)` angelegt. Hier nicht — die geteilte
            // Textur kommt aus dem D3D11-Decoder und **hat Inhalt**, wenn wir
            // sie einhaengen. Die naheliegende Sorge ist deshalb, wgpu duerfe
            // ihn verwerfen. Es darf nicht, und das steht im Quelltext:
            //
            // * `wgpu-hal-30.0.0/src/dx12/conv.rs:188` gibt fuer
            //   `UNINITIALIZED` `D3D12_RESOURCE_STATE_COMMON` zurueck — und
            //   COMMON ist genau der Zustand, in dem eine per
            //   `OpenSharedHandle` uebernommene D3D11-Ressource steht.
            // * Der Uebergang davon nach `PIXEL_SHADER_RESOURCE` ist eine
            //   gewoehnliche `ResourceBarrier`; die erhaelt den Inhalt.
            //   Verwerfen kann in D3D12 nur `DiscardResource` oder eine
            //   Aliasing-Sperre, und beides kommt im dx12-Befehlsschreiber
            //   nicht vor (geprueft am 2026-08-08).
            //
            // Der Unterschied zu Vulkan ist also echt: dort HEISST
            // `UNINITIALIZED` „Inhalt darf weg", hier heisst es „COMMON".
            //
            // Zusaetzlich ist es der Wert, mit dem dieser Weg ausgeliefert war:
            // wgpu-core 29 trug ihn intern immer selbst ein
            // (`device/resource.rs:1253`). Das Verhalten ist damit unveraendert.
            wgpu::TextureUses::UNINITIALIZED,
        )
    };
    let ansicht = |name: &'static str, f: wgpu::TextureFormat, a: wgpu::TextureAspect| {
        textur.create_view(&wgpu::TextureViewDescriptor {
            label: Some(name),
            format: Some(f),
            aspect: a,
            dimension: Some(wgpu::TextureViewDimension::D2),
            ..Default::default()
        })
    };
    let luma = ansicht("fremdbild-y", ebene0, wgpu::TextureAspect::Plane0);
    let chroma = ansicht("fremdbild-uv", ebene1, wgpu::TextureAspect::Plane1);
    // Einmal je Ringplatz, nicht je Bild — Begruendung an `Import::bindegruppe`.
    let bindegruppe = super::setup::bind_group_aus_teilen(
        device,
        teile.layout,
        teile.sampler,
        teile.uniform_buf,
        [&luma, &chroma, blind],
    );
    // Der Fingerabdruck liest NUR die Luma-Ebene — Begruendung bei
    // `einfrieren::gpuabdruck`. Die Chroma-Ansicht geht ihn nichts an.
    let abdruck_gruppe = werk.bindung(device, &luma);
    // **Nicht kopierbar** — die Luma-Seite ist hier ein Aspekt EINER
    // NV12/P010-Textur, und ob eine geteilte D3D11-Ressource sich als
    // Kopierquelle hergibt, ist auf dieser Plattform nicht nachgemessen
    // (Begruendung bei [`Import::luma_kopierbar`]). Die Sonde sagt das dann
    // deutlich, statt still nichts zu messen.
    // `festhalten: None` — der Lebensanker ist hier das NT-Handle der Bruecke,
    // und D3D12 nimmt beim Oeffnen eine eigene Referenz auf die Ressource
    // (s. [`oeffnen`]).
    Some(Import {
        texturen: vec![textur],
        luma_kopierbar: false,
        bindegruppe,
        abdruck_gruppe,
        festhalten: None,
    })
}

/// Das NT-Handle auf wgpus eigenem D3D12-Geraet oeffnen.
///
/// **Das Handle wird hier NICHT geschlossen** — es gehoert der Bruecke, die es
/// ueber die Lebensdauer ihres Rings haelt und in ihrem `Drop` schliesst. D3D12
/// nimmt beim Oeffnen eine eigene Referenz auf die Ressource.
#[cfg(windows)]
fn oeffnen(
    device: &wgpu::Device,
    handle: isize,
) -> Result<windows::Win32::Graphics::Direct3D12::ID3D12Resource, String> {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Graphics::Direct3D12::{ID3D12Device, ID3D12Resource};

    // SAFETY: das Geraet lebt waehrend des Aufrufs; `raw_device` gibt nur eine
    // Leihe auf das darunterliegende `ID3D12Device`.
    unsafe {
        let hal = device
            .as_hal::<wgpu::hal::api::Dx12>()
            .ok_or("Geraet ist kein D3D12-Geraet")?;
        let roh: &ID3D12Device = hal.raw_device();
        let mut res: Option<ID3D12Resource> = None;
        roh.OpenSharedHandle(HANDLE(handle as *mut std::ffi::c_void), &mut res)
            .map_err(|e| format!("OpenSharedHandle: {e}"))?;
        res.ok_or_else(|| "OpenSharedHandle lieferte keine Ressource".to_string())
    }
}
