//! Die Bruecke D3D11 → geteilte Einzeltextur. Aufbau und Begruendung im
//! Modulkopf von [`super`].

use std::ffi::c_void;
use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use ffmpeg_next as ffmpeg;
use windows::core::Interface;
use windows::Win32::Foundation::{CloseHandle, GENERIC_ALL, HANDLE};
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11Device5, ID3D11DeviceContext, ID3D11DeviceContext4, ID3D11Fence,
    ID3D11Texture2D, D3D11_BIND_SHADER_RESOURCE, D3D11_FENCE_FLAG_NONE,
    D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX, D3D11_RESOURCE_MISC_SHARED_NTHANDLE,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
};
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_P010;

use super::ffmpeg_geraet::{geraetekontext, quellmasse, quelltextur};
use super::platz::{Freigabe, GpuBild};
use windows::Win32::Graphics::Dxgi::{IDXGIKeyedMutex, IDXGIResource1};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject, INFINITE};

/// Wie viele geteilte Texturen im Umlauf sind.
///
/// **Hier standen bis zum ersten Lauf vier, und das war zu wenig** — der Weg
/// schaltete sich nach dem ersten Bild selbst ab („kein freier Ringplatz").
/// Der Grund ist der Ausgabe-Takt: `app::takt` haelt die Bilder rund
/// `vorhalt_ms` lang zurueck (Vorgabe 60 ms), und bei 60 Bildern je Sekunde
/// haengen damit allein dort vier Stueck. Dazu kommen das Bild in `pending`,
/// das gerade gezeichnete und das, dessen Zeichendurchgang noch laeuft.
///
/// **Hier stand bis zum 2026-08-07 „Zwoelf deckt das mit Reserve und traegt
/// auch 144 Bilder je Sekunde (dort sind es rund neun im Vorhalt)". Die
/// Aufzaehlung war unvollstaendig:** sie zaehlt den Vorhalt, `pending` und die
/// zwei Bilder im Zeichendurchgang — aber **nicht den Kanal** zwischen
/// Decoder-Faden und Fenster-Faden (`app/mod.rs`, Fassungsvermoegen 8). Auch
/// dessen Bilder halten ihren Ringplatz.
///
/// Die vollstaendige Rechnung bei 144 fps und 60 ms Vorhalt:
///
/// | Wer | Plaetze |
/// |---|---|
/// | Warteschlange des Ausgabe-Takts (`app::takt::MAX_WARTEND`) | bis 12 |
/// | Kanal zum Fenster-Faden | bis 8 |
/// | `pending`, gezeichnetes und laufendes Bild | 3 |
/// | Decoder selbst | 1 |
///
/// Zusammen genau vierundzwanzig. **Die beiden Zahlen gehoeren zusammen:** wer
/// `MAX_WARTEND` erhoeht, muss hier mitgehen.
///
/// Mit zwoelf Plaetzen war der Ring damit dauerhaft ueberbucht, und der
/// Decoder wartete in `AcquireSync(..., INFINITE)` auf einen freien Platz.
/// **Gemessen am 2026-08-07: Stockungen von 0,7 bis 2,3 Sekunden, die mit
/// `PULSE_PLAYER_ZEROCOPY_RING=24` restlos verschwanden** (Messakte
/// `streaming/testbench/profiles/player-2026-08-07-ausgabetakt-warteschlange.json`).
///
/// Der Preis ist Grafikspeicher: ein Platz ist bei 1080p10 rund 6,6 MB (die
/// Textur ist auf 1920x1152 aufgerundet), bei 1440p10 rund 11 MB — bei
/// vierundzwanzig Plaetzen also 160 bis 265 MB. Auf einer eingebauten
/// Grafikeinheit ist das Systemspeicher; auf der Radeon 780M mit knapp 2 GB
/// gemessen unauffaellig.
///
/// `PULSE_PLAYER_ZEROCOPY_RING` stellt es um, falls sich das auf einer anderen
/// Maschine anders darstellt.
fn ringgroesse() -> usize {
    std::env::var("PULSE_PLAYER_ZEROCOPY_RING")
        .ok()
        .and_then(|s| s.trim().parse::<usize>().ok())
        .filter(|n| (2..=64).contains(n))
        // 32 statt 24 seit dem 2026-08-07: der Kanal zum Fenster-Faden fasst
        // seither 32 Bilder, und jedes davon haelt hier einen Platz. Mit 24
        // ging dem Ring bei 1440p144 der Platz aus, bevor der Kanal voll war —
        // gemessen 88 bis 93 gezeichnete Bilder statt der 112, die mit
        // groesserem Ring herauskamen. Die Speichergrenze unten schneidet das
        // bei grossen Bildern ohnehin wieder zu.
        .unwrap_or(32)
}

/// Wieviel Grafikspeicher der Ring hoechstens belegen darf.
///
/// **Warum ueberhaupt eine Grenze in Byte und nicht nur eine Zahl.** Die
/// Plaetze sind als Anzahl bemessen, ihr Preis haengt aber an der Bildgroesse:
/// vierundzwanzig sind bei 1080p10 rund 160 MB, bei 1440p10 rund 265 — und bei
/// 4K10 rund 600. Auf einer eingebauten Grafikeinheit ist das Systemspeicher,
/// den sich Player, Sender und Fenstersystem teilen. Eine feste Zahl, die bei
/// 1440p unauffaellig ist, kann bei 4K das Doppelte des Noetigen binden.
///
/// **Ehrlich zur Herkunft der Zahl:** 320 MB sind NICHT gemessen. Auf dieser
/// Maschine (2 GB fuer die 780M) waren 265 MB bei 1440p unauffaellig — drei
/// Paare, abwechselnd gefahren, kein Unterschied zu zwoelf Plaetzen. 4K liess
/// sich hier nicht pruefen, der Schirm gibt nur 1440p her. Die Grenze ist
/// deshalb als Sicherung gegen den ungeprueften Fall gesetzt, nicht als
/// gemessenes Optimum, und sie greift bei 1440p und darunter gar nicht.
const RING_SPEICHER_MAX: usize = 320 * 1024 * 1024;

/// Untergrenze: darunter faengt der Ring den Vorhalt nicht mehr ab, und die
/// Stockungen aus dem Kopf dieser Datei kaemen zurueck.
const RING_MIN: usize = 8;

/// Ab wann ein einzelner Wartepunkt der Bruecke gemeldet wird.
///
/// Grosszuegig gewaehlt: im gesunden Betrieb liegen beide Wartepunkte unter
/// einer Millisekunde, gemeldet werden soll nur das, was ein Zuschauer als
/// Stocken merkt. 100 ms sind rund fuenfzehn ausgefallene Bilder bei 144 fps.
const LANGSAM: std::time::Duration = std::time::Duration::from_millis(100);

/// Die gewuenschte Zahl Plaetze, gedeckelt auf [`RING_SPEICHER_MAX`].
fn plaetze_im_speicherrahmen(wunsch: usize, breite: u32, hoehe: u32, format: i32) -> usize {
    // NV12 und P010 tragen Luma plus halbes Chroma, also anderthalb Ebenen;
    // P010 zusaetzlich zwei Byte je Wert. Aufgerundet, die genaue Belegung
    // entscheidet der Treiber.
    let bytes_je_wert = if format == DXGI_FORMAT_P010.0 { 2 } else { 1 };
    let je_platz = (breite as usize) * (hoehe as usize) * 3 / 2 * bytes_je_wert;
    if je_platz == 0 {
        return wunsch;
    }
    let passt = RING_SPEICHER_MAX / je_platz;
    wunsch.min(passt).max(RING_MIN)
}

struct Ringplatz {
    textur: ID3D11Texture2D,
    mutex: IDXGIKeyedMutex,
    handle: HANDLE,
}

pub struct Bruecke {
    device: ID3D11Device,
    kontext: ID3D11DeviceContext,
    kontext4: ID3D11DeviceContext4,
    /// FFmpegs eigene Sperre um `device_context`. **Nicht weglassen:** derselbe
    /// Kontext bedient den Decoder, und `av_hwframe_transfer_data` benutzt ihn
    /// ebenfalls. Ohne die Sperre waere das ein Wettlauf, der sich als
    /// gelegentlich zerrissenes Bild zeigte.
    lock: Option<unsafe extern "C" fn(*mut c_void)>,
    unlock: Option<unsafe extern "C" fn(*mut c_void)>,
    lock_ctx: *mut c_void,
    zaun: ID3D11Fence,
    zaun_ereignis: HANDLE,
    zaun_wert: u64,
    ring: Vec<Ringplatz>,
    frei: Arc<Freigabe>,
    /// Masse und Format, fuer die der Ring angelegt wurde. Aendert sich etwas
    /// davon, wird der Ring verworfen und neu gebaut.
    bauart: (u32, u32, i32),
    /// Der Rueckweg fuer den Fingerabdruck. Jedes [`GpuBild`] bekommt einen
    /// Klon mit, damit der Renderer ihn findet (s. `GpuBild::briefkasten`).
    briefkasten: Arc<crate::einfrieren::Briefkasten>,
}

// SAFETY: alle Felder sind entweder COM-Schnittstellen (in windows-rs
// `Send`, weil es nur zaehlende Zeiger sind) oder rohe Zeiger, die
// ausschliesslich vom Decoder-Thread benutzt werden. Die `Bruecke` lebt in
// `VideoDecoder` und wandert mit ihm auf genau einen Thread.
unsafe impl Send for Bruecke {}

impl Drop for Bruecke {
    fn drop(&mut self) {
        for platz in &self.ring {
            // SAFETY: die Handles stammen aus `CreateSharedHandle` und wurden
            // seither nicht geschlossen.
            unsafe {
                let _ = CloseHandle(platz.handle);
            }
        }
        // SAFETY: aus `CreateEventW`, genau einmal geschlossen.
        unsafe {
            let _ = CloseHandle(self.zaun_ereignis);
        }
    }
}

impl Bruecke {
    /// Baut die Bruecke aus dem Geraet, das an einem dekodierten Bild haengt.
    ///
    /// **Bewusst aus dem BILD und nicht aus dem Decoder-Kontext.** Das Bild
    /// traegt seinen `hw_frames_ctx` mit, und darin steht dasselbe Geraet — der
    /// Weg ueber `AVCodecContext.hw_device_ctx` braeuchte zusaetzlich Zugriff
    /// auf den rohen Kontext des laufenden Decoders.
    pub fn neu(
        frame: &ffmpeg::util::frame::video::Video,
        briefkasten: Arc<crate::einfrieren::Briefkasten>,
    ) -> Result<Self> {
        let hwctx = geraetekontext(frame)?;
        // SAFETY: `hwctx` zeigt auf einen von FFmpeg angelegten, lebenden
        // Geraetekontext; das Bild haelt eine Referenz darauf.
        let (device, kontext, lock, unlock, lock_ctx) = unsafe {
            let d = (*hwctx).device as *mut c_void;
            let c = (*hwctx).device_context as *mut c_void;
            if d.is_null() || c.is_null() {
                bail!("D3D11-Geraetekontext ohne Geraet");
            }
            (
                ID3D11Device::from_raw_borrowed(&d)
                    .ok_or_else(|| anyhow!("ID3D11Device nicht lesbar"))?
                    .clone(),
                ID3D11DeviceContext::from_raw_borrowed(&c)
                    .ok_or_else(|| anyhow!("ID3D11DeviceContext nicht lesbar"))?
                    .clone(),
                (*hwctx).lock,
                (*hwctx).unlock,
                (*hwctx).lock_ctx,
            )
        };

        // Der Zaun ist der EINZIGE Weg, die Fertigstellung ueber die
        // API-Grenze zu erfahren: eine von D3D12 geoeffnete Ressource stellt
        // keinen `IDXGIKeyedMutex` bereit, der Schluessel-Mutex synchronisiert
        // also nur die D3D11-Seite (nachgewiesen im Sidecar,
        // `capture/wgc_d3d12.rs`).
        let device5: ID3D11Device5 = device.cast().context("ID3D11Device5 (Zaun)")?;
        let kontext4: ID3D11DeviceContext4 =
            kontext.cast().context("ID3D11DeviceContext4 (Zaun)")?;
        let mut zaun: Option<ID3D11Fence> = None;
        // SAFETY: gueltiges Geraet, Ausgabezeiger gehoert uns.
        unsafe { device5.CreateFence(0, D3D11_FENCE_FLAG_NONE, &mut zaun) }
            .context("CreateFence")?;
        let zaun = zaun.ok_or_else(|| anyhow!("Zaun ist NULL"))?;
        // SAFETY: alle Argumente sind Vorgabewerte; der Ereignis-Handle gehoert
        // uns und wird im `Drop` geschlossen.
        let zaun_ereignis = unsafe { CreateEventW(None, false, false, None) }
            .context("CreateEventW")?;

        let (breite, hoehe, format) = quellmasse(frame)?;
        let mut bruecke = Self {
            device,
            kontext,
            kontext4,
            lock,
            unlock,
            lock_ctx,
            zaun,
            zaun_ereignis,
            zaun_wert: 0,
            ring: Vec::new(),
            frei: Freigabe::leer(),
            bauart: (0, 0, 0),
            briefkasten,
        };
        bruecke.ring_bauen(breite, hoehe, format)?;
        Ok(bruecke)
    }

    fn ring_bauen(&mut self, breite: u32, hoehe: u32, format: i32) -> Result<()> {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: breite,
            Height: hoehe,
            MipLevels: 1,
            ArraySize: 1,
            Format: windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT(format),
            SampleDesc: windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_DEFAULT,
            // KEIN `BIND_DECODER`: hier hinein dekodiert niemand, es wird nur
            // kopiert und gelesen. Ein Stapel waere damit ohnehin unmoeglich,
            // aber das ist hier auch nicht gewollt.
            BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
            CPUAccessFlags: 0,
            // `SHARED_NTHANDLE` ist die Bedingung fuer `OpenSharedHandle` auf
            // der D3D12-Seite; `KEYEDMUTEX` verlangt D3D11 dazu.
            MiscFlags: (D3D11_RESOURCE_MISC_SHARED_NTHANDLE.0
                | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX.0) as u32,
        };
        let anzahl = plaetze_im_speicherrahmen(ringgroesse(), breite, hoehe, format);
        let mut ring = Vec::with_capacity(anzahl);
        for i in 0..anzahl {
            let mut tex: Option<ID3D11Texture2D> = None;
            // SAFETY: gueltiges Geraet, Deskriptor vollstaendig belegt.
            unsafe { self.device.CreateTexture2D(&desc, None, Some(&mut tex)) }
                .with_context(|| format!("geteilte Textur {i} ({breite}x{hoehe})"))?;
            let textur = tex.ok_or_else(|| anyhow!("geteilte Textur ist NULL"))?;
            let mutex: IDXGIKeyedMutex = textur.cast().context("IDXGIKeyedMutex")?;
            let res: IDXGIResource1 = textur.cast().context("IDXGIResource1")?;
            // SAFETY: lebende Ressource; der Handle wird im `Drop` geschlossen.
            let handle = unsafe { res.CreateSharedHandle(None, GENERIC_ALL.0, None) }
                .context("CreateSharedHandle")?;
            ring.push(Ringplatz { textur, mutex, handle });
        }
        // Alte Handles schliessen, bevor der alte Ring verschwindet.
        for platz in &self.ring {
            // SAFETY: wie im `Drop`.
            unsafe {
                let _ = CloseHandle(platz.handle);
            }
        }
        self.ring = ring;
        self.frei = Freigabe::mit(anzahl);
        self.bauart = (breite, hoehe, format);
        Ok(())
    }

    /// Kopiert die Schicht des Bildes in einen freien Ringplatz und gibt ihn
    /// als [`GpuBild`] zurueck.
    ///
    /// **`Ok(None)` ist kein Fehler**, sondern Gegendruck: gerade ist kein
    /// Ringplatz frei, weil Taktgeber und Renderer alle halten. Das geht
    /// vorueber, und dieses eine Bild nimmt den Weg ueber den Hauptspeicher.
    /// Die Unterscheidung zu `Err` ist der ganze Punkt — beim ersten Lauf am
    /// 2026-08-06 hat ein leerer Ring den Weg DAUERHAFT abgeschaltet, nach
    /// genau einem Bild.
    pub fn uebernehmen(
        &mut self,
        frame: &ffmpeg::util::frame::video::Video,
    ) -> Result<Option<Arc<GpuBild>>> {
        let (breite, hoehe, format) = quellmasse(frame)?;
        if self.bauart != (breite, hoehe, format) {
            self.ring_bauen(breite, hoehe, format)?;
        }
        let Some(slot) = self.frei.nehmen() else { return Ok(None) };

        let ergebnis = self.kopieren(frame, slot);
        if ergebnis.is_err() {
            // Sonst waere der Platz nach einem Fehlschlag dauerhaft verloren
            // und der Weg nach `RINGGROESSE` Fehlern still tot.
            self.frei.zurueck(slot);
        }
        ergebnis?;

        Ok(Some(Arc::new(GpuBild {
            handle: self.ring[slot].handle.0 as isize,
            breite,
            hoehe,
            zehn_bit: format == DXGI_FORMAT_P010.0,
            slot,
            frei: self.frei.clone(),
            briefkasten: self.briefkasten.clone(),
        })))
    }

    fn kopieren(
        &mut self,
        frame: &ffmpeg::util::frame::video::Video,
        slot: usize,
    ) -> Result<()> {
        let quelle = quelltextur(frame)?;
        // SAFETY: das Bild lebt; bei `AV_PIX_FMT_D3D11` traegt `data[1]` den
        // Schichtindex innerhalb des Decoder-Stapels (so legt es libavutil ab).
        let schicht = unsafe { (*frame.as_ptr()).data[1] as usize as u32 };

        // Der naechste Zaunwert steht VOR dem Block fest, nicht darin — sonst
        // braeuchte der Abschnitt `&mut self`, waehrend `platz` schon eine Leihe
        // auf `self.ring` haelt.
        let zaun_wert = self.zaun_wert + 1;
        let platz = &self.ring[slot];
        self.sperren();
        // Ein Abschnitt mit `?`, damit an jeder Zeile steht, was sie tut. Die
        // Sperre faellt danach in JEDEM Fall — deshalb steht das `?` auf dem
        // Ergebnis erst hinter `entsperren`.
        // SAFETY: alle Ressourcen leben, der Schichtindex stammt aus dem Bild.
        // **Getrennte Uhr fuer die Anmeldung.** Die Gesamtzeit der Bruecke sagt
        // nur, DASS es hing (`crate::stockung`), nicht WO — und die beiden
        // unbegrenzten Wartepunkte hier haben voellig verschiedene Ursachen:
        // die Anmeldung wartet auf den Renderer, der Zaun auf die Grafikeinheit.
        // Am 2026-08-07 kostete diese Unterscheidung einen halben Messtag.
        let anmeldung_uhr = std::time::Instant::now();
        let ergebnis = (|| -> Result<()> {
            unsafe {
                platz.mutex.AcquireSync(0, INFINITE).context("AcquireSync")?;
                let angemeldet = anmeldung_uhr.elapsed();
                if angemeldet >= LANGSAM {
                    eprintln!(
                        "pulse-player: Bruecke — Anmeldung am Platz {slot} dauerte {} ms \
                         (wartet auf den Renderer)",
                        angemeldet.as_millis()
                    );
                }
                self.kontext
                    .CopySubresourceRegion(&platz.textur, 0, 0, 0, 0, &quelle, schicht, None);
                platz.mutex.ReleaseSync(0).context("ReleaseSync")?;
                self.kontext4.Signal(&self.zaun, zaun_wert).context("Signal")?;
            }
            Ok(())
        })();
        self.entsperren();
        ergebnis?;
        self.zaun_wert = zaun_wert;

        // **Auf der CPU warten, bis die Kopie durch ist.** Ohne das koennte der
        // D3D12-Leser eine halb gefuellte Textur sehen: die beiden Seiten
        // haengen an verschiedenen Warteschlangen, und der Schluessel-Mutex
        // reicht nicht ueber die API-Grenze.
        //
        // Das ist der bekannte Preis dieses Weges und die naechste Stelle, an
        // der sich etwas holen liesse — ein auf beiden Seiten geteilter Zaun
        // (`ID3D11Fence` als NT-Handle, `ID3D12Fence::Wait` auf der
        // wgpu-Warteschlange).
        //
        // **HIER STAND BIS ZUM 2026-08-06 „braeuchte einen Zugriff auf die
        // Warteschlange, den wgpu 29 nicht anbietet". Das ist falsch** —
        // `wgpu::Queue::as_hal::<Dx12>()` gibt es (`wgpu-29.0.4`,
        // `src/api/queue.rs:339`), `wgpu_hal::dx12::Queue::as_raw()` liefert
        // die `ID3D12CommandQueue` (`wgpu-hal-29.0.4/src/dx12/mod.rs:792`),
        // und DIESELBE Kiste benutzt denselben Ausstieg zweimal:
        // `render/fremdbild.rs` (`as_hal` → `raw_device()`) und
        // `render/hdr_fenster.rs` (`as_hal` → `swap_chain()`).
        //
        // Der Weg ist also offen, aber nicht umsonst, und DAS ist der wahre
        // Grund, warum er hier noch nicht steht: der Zaun wird mit
        // `D3D11_FENCE_FLAG_NONE` angelegt (s.o.), ist also nicht teilbar. Es
        // braeuchte `D3D11_FENCE_FLAG_SHARED`, ein `CreateSharedHandle`, ein
        // `OpenSharedHandle` auf wgpus D3D12-Geraet und dann `Wait` auf der
        // Warteschlange — ein bekannter, aber nicht trivialer Weg, von dem
        // ungeprueft ist, ob AMDs Treiber ihn hier sauber bedient.
        //
        // **`Flush` und die Abkuerzung ueber `GetCompletedValue` sind vom
        // Zwilling uebernommen** (`win-hq-sidecar/src/capture/wgc_d3d12.rs`),
        // wo beides seit laengerem steht und hier am 2026-08-06 fehlte. `Flush`
        // schiebt die Arbeit ueberhaupt erst zur GPU — ohne das wartet man auf
        // etwas, das noch gar nicht laeuft. Und ist der Zaunwert schon erreicht,
        // spart der Vergleich Ereignis und Kernel-Uebergang; im gesunden Betrieb
        // ist das der Regelfall.
        // SAFETY: Zaun, Kontext und Ereignis leben; das Ereignis wird nur hier
        // benutzt.
        let zaun_uhr = std::time::Instant::now();
        unsafe {
            self.kontext.Flush();
            if self.zaun.GetCompletedValue() < self.zaun_wert {
                self.zaun
                    .SetEventOnCompletion(self.zaun_wert, self.zaun_ereignis)
                    .context("SetEventOnCompletion")?;
                WaitForSingleObject(self.zaun_ereignis, INFINITE);
            }
            let gewartet = zaun_uhr.elapsed();
            if gewartet >= LANGSAM {
                eprintln!(
                    "pulse-player: Bruecke — Zaun nach der Kopie dauerte {} ms \
                     (wartet auf die Grafikeinheit)",
                    gewartet.as_millis()
                );
            }
        }
        Ok(())
    }

    fn sperren(&self) {
        if let Some(f) = self.lock {
            // SAFETY: Rueckruf und Kontext stammen beide aus FFmpeg.
            unsafe { f(self.lock_ctx) };
        }
    }
    fn entsperren(&self) {
        if let Some(f) = self.unlock {
            // SAFETY: wie `sperren`.
            unsafe { f(self.lock_ctx) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
    use windows::Win32::Graphics::Direct3D11::{
        D3D11CreateDevice, D3D11_BIND_DECODER, D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
        D3D11_SDK_VERSION,
    };
    use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_NV12;

    /// **Die Frage, an der die naechste Ausbaustufe haengt.**
    ///
    /// Die Bruecke kopiert je Bild die volle Bildflaeche aus der Textur des
    /// Decoders in einen eigenen, teilbaren Ring — gemessen am 2026-08-07 rund
    /// 70 Prozentpunkte Videoeinheit bei 1440p144, mehr als Encodieren und
    /// Dekodieren zusammen.
    ///
    /// Die Kopie liesse sich ganz vermeiden, WENN der Treiber ein Texturfeld
    /// annimmt, das gleichzeitig `BIND_DECODER` (FFmpeg dekodiert hinein) und
    /// die Teil-Merker traegt (D3D12 liest heraus). Dann bekaeme FFmpegs
    /// Bilderpool die Merker ueber `AVD3D11VAFramesContext::MiscFlags` und der
    /// Player laese unmittelbar aus der Decoder-Textur.
    ///
    /// Bei 1440p und darunter greift die Speichergrenze nicht — dort bleibt es
    /// beim Wunsch. Erst 4K schneidet sie zu, und genau dieser Fall liess sich
    /// auf der Maschine nicht fahren, auf der die uebrigen Zahlen entstanden.
    #[test]
    fn die_speichergrenze_schneidet_erst_oberhalb_von_1440p() {
        let p010 = DXGI_FORMAT_P010.0;
        // 1080p und 1440p: unveraendert.
        assert_eq!(plaetze_im_speicherrahmen(24, 1920, 1152, p010), 24);
        assert_eq!(plaetze_im_speicherrahmen(24, 2560, 1536, p010), 24);
        // 4K in 10 bit: rund 25 MB je Platz, also deutlich weniger Plaetze.
        let vierk = plaetze_im_speicherrahmen(24, 3840, 2176, p010);
        assert!(vierk < 24, "4K muss zugeschnitten werden, war {vierk}");
        assert!(vierk >= RING_MIN, "aber nie unter die Untergrenze, war {vierk}");
        // Auch ein absurd grosses Bild darf den Ring nicht unter RING_MIN
        // druecken — lieber viel Speicher als ein Ring, der nicht traegt.
        assert_eq!(plaetze_im_speicherrahmen(24, 15360, 8640, p010), RING_MIN);
    }

    /// Dieser Test beantwortet das fuer die Maschine, auf der er laeuft. Er
    /// schlaegt NICHT fehl, wenn der Treiber ablehnt — das ist ein Befund, kein
    /// Fehler. Er schreibt ihn hin, damit niemand ihn zweimal erhebt.
    #[test]
    fn traegt_der_treiber_eine_teilbare_decoder_textur() {
        let mut device = None;
        // SAFETY: Standardaufruf; alle Ausgaben optional und geprueft.
        let hr = unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                Default::default(),
                D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                None,
            )
        };
        let Some(device) = hr.ok().and(device) else {
            eprintln!("PROBE: kein D3D11-Geraet — auf dieser Maschine nicht zu beantworten");
            return;
        };

        // `MISC_SHARED` ohne NT-Handle ist der vierte Fall und der einzige, der
        // ohne Schluessel-Mutex auskaeme. Er steht hier, weil FFmpeg genau ihn
        // anbietet (`d3d11va_device_create`, Option "SHARED") — er liefert aber
        // einen alten Handle, und `ID3D12Device::OpenSharedHandle` nimmt nur
        // NT-Handles. Er ist deshalb nur zur Vollstaendigkeit dabei.
        const MISC_SHARED_ALT: i32 = 0x2;
        for (name, format, bind, felder) in [
            ("NV12 Decoder-Feld", DXGI_FORMAT_NV12, D3D11_BIND_DECODER.0 | D3D11_BIND_SHADER_RESOURCE.0, 16),
            ("P010 Decoder-Feld", DXGI_FORMAT_P010, D3D11_BIND_DECODER.0 | D3D11_BIND_SHADER_RESOURCE.0, 16),
            // Gegenprobe OHNE `BIND_DECODER` und mit EINER Schicht: scheitert
            // "nur NT-teilbar" auch hier, ist der Schluessel-Mutex eine
            // allgemeine Regel von D3D11 und keine Eigenheit des
            // Decoder-Merkers. Genau das entscheidet, ob es einen Ausweg gibt.
            //
            // Ein FELD mit mehr als einer Schicht laesst sich ohne
            // `BIND_DECODER` ueberhaupt nicht teilen — mit `ArraySize: 16`
            // schlugen hier zuerst alle drei Faelle fehl, und die Gegenprobe
            // sagte damit nichts ueber den Mutex aus.
            ("P010 einzeln", DXGI_FORMAT_P010, D3D11_BIND_SHADER_RESOURCE.0, 1),
        ] {
            for (was, misc) in [
                ("nur NT-teilbar", D3D11_RESOURCE_MISC_SHARED_NTHANDLE.0),
                (
                    "NT-teilbar + Schluessel-Mutex",
                    D3D11_RESOURCE_MISC_SHARED_NTHANDLE.0 | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX.0,
                ),
                ("alt teilbar (ohne NT)", MISC_SHARED_ALT),
            ] {
                let desc = D3D11_TEXTURE2D_DESC {
                    Width: 1920,
                    Height: 1088,
                    MipLevels: 1,
                    ArraySize: felder,
                    Format: format,
                    SampleDesc: windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC {
                        Count: 1,
                        Quality: 0,
                    },
                    Usage: D3D11_USAGE_DEFAULT,
                    BindFlags: bind as u32,
                    CPUAccessFlags: 0,
                    MiscFlags: misc as u32,
                };
                let mut tex: Option<ID3D11Texture2D> = None;
                // SAFETY: gueltiges Geraet, Deskriptor vollstaendig belegt.
                let r = unsafe { device.CreateTexture2D(&desc, None, Some(&mut tex)) };
                match r {
                    Ok(()) => {
                        let teilbar = tex
                            .as_ref()
                            .and_then(|t| t.cast::<IDXGIResource1>().ok())
                            // SAFETY: lebende Ressource.
                            .and_then(|r| unsafe {
                                r.CreateSharedHandle(None, GENERIC_ALL.0, None).ok()
                            });
                        eprintln!(
                            "PROBE {name} / {was}: Textur JA, Handle {}",
                            if teilbar.is_some() { "JA" } else { "NEIN" }
                        );
                        if let Some(h) = teilbar {
                            // SAFETY: eigener Handle, nur hier benutzt.
                            unsafe { let _ = CloseHandle(h); }
                        }
                    }
                    Err(e) => eprintln!("PROBE {name} / {was}: NEIN — {}", e.message()),
                }
            }
        }
    }
}
