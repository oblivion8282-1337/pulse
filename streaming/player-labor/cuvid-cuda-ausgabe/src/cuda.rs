//! Der Zeigertest: liegt ein Speicherbereich auf der Karte oder im Hauptspeicher?
//!
//! **Warum das der Kern der Probe ist.** Die Frage „gibt `av1_cuvid` seine
//! Bilder als CUDA-Speicher heraus?" laesst sich auf zwei Wegen beantworten,
//! und nur einer taugt:
//!
//! * Der Name des Pixelformats (`cuda` gegen `nv12`) ist eine *Behauptung*
//!   FFmpegs. Sie ist sehr wahrscheinlich richtig — aber sie ist unser eigenes
//!   Werkzeug, das ueber sich selbst aussagt.
//! * `cuPointerGetAttribute` fragt den **Treiber**, was er ueber die Adresse
//!   weiss. Das ist eine Aussage von ausserhalb der geprueften Kette.
//!
//! Die Probe verlangt beides und meldet einen Widerspruch als Fehler.
//!
//! CUDA kommt per `dlopen` herein, nicht ueber eine Bindungs-Crate:
//! `libcuda.so.1` gehoert zum Treiber, ein Crate wie `cust` zoege ein
//! CUDA-Toolkit nach, das auf einer Nutzermaschine niemand hat. Gleiche Bauart
//! wie `../cuda-vulkan-import`.

use anyhow::{bail, Context, Result};
use libloading::{Library, Symbol};

/// Attribut-Nummern aus `cuda.h`. Von Hand uebernommen, deshalb im Selbsttest
/// gegengeprueft: eine falsche Nummer erzeugt keinen Fehler, sondern eine
/// stille Falschaussage.
const CU_POINTER_ATTRIBUTE_MEMORY_TYPE: u32 = 2;
const CU_POINTER_ATTRIBUTE_DEVICE_ORDINAL: u32 = 9;

/// Rueckgabewerte von `CU_POINTER_ATTRIBUTE_MEMORY_TYPE`.
const CU_MEMORYTYPE_HOST: u32 = 1;
const CU_MEMORYTYPE_DEVICE: u32 = 2;
const CU_MEMORYTYPE_ARRAY: u32 = 3;
const CU_MEMORYTYPE_UNIFIED: u32 = 4;

/// `CUDA_ERROR_INVALID_VALUE` — was der Treiber zu einer Adresse sagt, die er
/// nicht kennt. Bei gewoehnlichem `malloc`-Speicher ist genau das die richtige
/// Antwort und kein Fehler.
const CUDA_ERROR_INVALID_VALUE: i32 = 1;

/// Wie der Treiber eine Adresse einordnet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Lage {
    /// Grafikspeicher. Das ist die gesuchte Antwort.
    Geraet { ordinal: i32 },
    /// Vom Treiber registrierter Hauptspeicher (`cuMemHostAlloc`).
    Wirt,
    /// Verwalteter Speicher, beiden Seiten sichtbar.
    Vereinheitlicht,
    /// CUDA-Array.
    Feld,
    /// Der Treiber kennt die Adresse nicht — gewoehnlicher Hauptspeicher.
    Unbekannt,
    /// Ein Rueckgabewert, mit dem hier niemand gerechnet hat. Bewusst eigene
    /// Variante statt „sonst ist es Hauptspeicher": eine unerwartete Antwort
    /// darf nicht als Befund durchgehen.
    Fremd(u32),
}

impl Lage {
    pub fn ist_geraet(&self) -> bool {
        matches!(self, Self::Geraet { .. })
    }

    pub fn text(&self) -> String {
        match self {
            Self::Geraet { ordinal } => format!("Grafikspeicher (Geraet {ordinal})"),
            Self::Wirt => "registrierter Hauptspeicher".into(),
            Self::Vereinheitlicht => "vereinheitlicht".into(),
            Self::Feld => "CUDA-Array".into(),
            Self::Unbekannt => "Hauptspeicher (dem Treiber unbekannt)".into(),
            Self::Fremd(v) => format!("unerwartet ({v})"),
        }
    }

    /// Kurzform fuer die Messakte.
    pub fn schluessel(&self) -> &'static str {
        match self {
            Self::Geraet { .. } => "geraet",
            Self::Wirt => "wirt",
            Self::Vereinheitlicht => "vereinheitlicht",
            Self::Feld => "feld",
            Self::Unbekannt => "hauptspeicher",
            Self::Fremd(_) => "fremd",
        }
    }
}

type CuInit = unsafe extern "C" fn(u32) -> i32;
type CuDeviceGet = unsafe extern "C" fn(*mut i32, i32) -> i32;
type CuDevicePrimaryCtxRetain = unsafe extern "C" fn(*mut *mut std::ffi::c_void, i32) -> i32;
type CuCtxSetCurrent = unsafe extern "C" fn(*mut std::ffi::c_void) -> i32;
type CuPointerGetAttribute = unsafe extern "C" fn(*mut std::ffi::c_void, u32, u64) -> i32;
type CuMemAlloc = unsafe extern "C" fn(*mut u64, usize) -> i32;
type CuMemFree = unsafe extern "C" fn(u64) -> i32;
type CuMemcpyDtoH = unsafe extern "C" fn(*mut std::ffi::c_void, u64, usize) -> i32;

pub struct Treiber {
    _lib: Library,
    zeiger_attribut: CuPointerGetAttribute,
    mem_alloc: CuMemAlloc,
    mem_free: CuMemFree,
    memcpy_dtoh: CuMemcpyDtoH,
}

impl Treiber {
    /// Oeffnet den Treiber und macht den primaeren Kontext von Geraet 0
    /// aktuell.
    ///
    /// **Ein eigener Kontext ist hier richtig, kein Behelf.** `cuPointerGet-
    /// Attribute` beantwortet Fragen ueber Adressen im vereinheitlichten
    /// Adressraum kontextuebergreifend; wir muessen also NICHT an FFmpegs
    /// CUDA-Kontext herankommen. Das ist wichtig, weil das Herankommen ein
    /// Nachbau von `AVCUDADeviceContext` erforderte — also genau die Sorte von
    /// Hand nachgebautem Struct-Layout, die in der Nachbarprobe eigens
    /// abgesichert werden musste.
    ///
    /// Die Gegenprobe dazu ist [`selbsttest`]: sie klassifiziert Speicher aus
    /// DIESEM Kontext und gewoehnlichen Hauptspeicher und verlangt, dass beide
    /// unterschiedlich herauskommen. Kaeme kontextfremder Speicher als
    /// unbekannt heraus, faende sie das nicht — deshalb prueft der Hauptlauf
    /// zusaetzlich, dass Formatname und Zeigertest UEBEREINSTIMMEN.
    pub fn oeffnen() -> Result<Self> {
        // SAFETY: `libcuda.so.1` ist die Treiberbibliothek; die Symbolnamen und
        // ihre Signaturen stammen aus `cuda.h`.
        unsafe {
            let lib = Library::new("libcuda.so.1").context("libcuda.so.1 laesst sich nicht oeffnen")?;

            let init: Symbol<CuInit> = lib.get(b"cuInit\0")?;
            pruefe(init(0), "cuInit")?;

            let device_get: Symbol<CuDeviceGet> = lib.get(b"cuDeviceGet\0")?;
            let mut dev: i32 = 0;
            pruefe(device_get(&mut dev, 0), "cuDeviceGet")?;

            let retain: Symbol<CuDevicePrimaryCtxRetain> = lib.get(b"cuDevicePrimaryCtxRetain\0")?;
            let mut ctx: *mut std::ffi::c_void = std::ptr::null_mut();
            pruefe(retain(&mut ctx, dev), "cuDevicePrimaryCtxRetain")?;

            let set_current: Symbol<CuCtxSetCurrent> = lib.get(b"cuCtxSetCurrent\0")?;
            pruefe(set_current(ctx), "cuCtxSetCurrent")?;

            let zeiger_attribut: CuPointerGetAttribute = *lib.get(b"cuPointerGetAttribute\0")?;
            let mem_alloc: CuMemAlloc = *lib.get(b"cuMemAlloc_v2\0")?;
            let mem_free: CuMemFree = *lib.get(b"cuMemFree_v2\0")?;
            let memcpy_dtoh: CuMemcpyDtoH = *lib.get(b"cuMemcpyDtoH_v2\0")?;

            Ok(Self { _lib: lib, zeiger_attribut, mem_alloc, mem_free, memcpy_dtoh })
        }
    }

    /// Fragt den Treiber, wo eine Adresse liegt.
    pub fn lage(&self, adresse: u64) -> Lage {
        if adresse == 0 {
            return Lage::Unbekannt;
        }
        let mut art: u32 = 0;
        // SAFETY: `art` ist ein gueltiger 32-bit-Ausgabeplatz, wie es
        // `CU_POINTER_ATTRIBUTE_MEMORY_TYPE` verlangt.
        let rc = unsafe {
            (self.zeiger_attribut)(
                (&mut art) as *mut u32 as *mut std::ffi::c_void,
                CU_POINTER_ATTRIBUTE_MEMORY_TYPE,
                adresse,
            )
        };
        if rc == CUDA_ERROR_INVALID_VALUE {
            return Lage::Unbekannt;
        }
        if rc != 0 {
            return Lage::Fremd(art);
        }
        match art {
            CU_MEMORYTYPE_HOST => Lage::Wirt,
            CU_MEMORYTYPE_DEVICE => Lage::Geraet { ordinal: self.ordinal(adresse) },
            CU_MEMORYTYPE_ARRAY => Lage::Feld,
            CU_MEMORYTYPE_UNIFIED => Lage::Vereinheitlicht,
            sonst => Lage::Fremd(sonst),
        }
    }

    fn ordinal(&self, adresse: u64) -> i32 {
        let mut ord: i32 = -1;
        // SAFETY: wie oben, 32-bit-Ausgabeplatz.
        let rc = unsafe {
            (self.zeiger_attribut)(
                (&mut ord) as *mut i32 as *mut std::ffi::c_void,
                CU_POINTER_ATTRIBUTE_DEVICE_ORDINAL,
                adresse,
            )
        };
        if rc == 0 {
            ord
        } else {
            -1
        }
    }
}

impl Treiber {
    /// Liest eine Ebene zeilenweise ueber die **CUDA-Treiber-API** aus.
    ///
    /// **Wozu, wenn `av_hwframe_transfer_data` dasselbe kann?** Weil das die
    /// zweite Haelfte der Auftragsfrage beantwortet: taugen `AVFrame.data[i]`
    /// und `linesize[i]` als Quelle fuer einen CUDA-Kopierbefehl — also fuer
    /// genau das, was der Zero-Copy-Umbau in ein eingehaengtes Vulkan-Bild
    /// braucht? FFmpegs eigene Rueckholung koennte sich intern anders behelfen;
    /// dieser Weg kann es nicht.
    ///
    /// Bewusst zeilenweise `cuMemcpyDtoH` statt `cuMemcpy2D`: die 2D-Fassung
    /// verlangt ein von Hand nachgebautes `CUDA_MEMCPY2D` — dieselbe Sorte
    /// Struct-Layout, die in `../cuda-vulkan-import` eigens abgesichert werden
    /// musste. Zeilenweise prueft dieselben zwei Dinge (Adresse UND
    /// Zeilenabstand) ohne diesen Aufwand. Dass `cuMemcpy2D` in ein
    /// eingehaengtes `VkImage` traegt, ist dort bereits gemessen.
    pub fn ebene_lesen(
        &self,
        adresse: u64,
        zeilenabstand: usize,
        bytes_je_zeile: usize,
        zeilen: usize,
    ) -> Result<Vec<u8>> {
        let mut out = vec![0u8; bytes_je_zeile * zeilen];
        for y in 0..zeilen {
            // SAFETY: `adresse` ist ein gueltiger Geraetezeiger (im Aufrufer
            // per `lage()` geprueft); das Ziel ist gross genug.
            let rc = unsafe {
                (self.memcpy_dtoh)(
                    out.as_mut_ptr().add(y * bytes_je_zeile) as *mut std::ffi::c_void,
                    adresse + (y * zeilenabstand) as u64,
                    bytes_je_zeile,
                )
            };
            if rc != 0 {
                bail!("cuMemcpyDtoH scheiterte in Zeile {y} (rc={rc})");
            }
        }
        Ok(out)
    }
}

fn pruefe(rc: i32, was: &str) -> Result<()> {
    if rc != 0 {
        bail!("{was} scheiterte (rc={rc})");
    }
    Ok(())
}

/// **Kontrolle A — kann der Zeigertest ueberhaupt anschlagen?**
///
/// Ohne sie waere „die Bilder liegen im Hauptspeicher" nicht von „der Test
/// erkennt Grafikspeicher gar nicht" zu unterscheiden. Genau diese
/// Verwechslung hat in diesem Labor schon Befunde gekostet.
///
/// Der Test klassifiziert zwei Adressen, deren Lage FESTSTEHT:
/// echten Grafikspeicher aus `cuMemAlloc` und einen gewoehnlichen
/// `Vec<u8>`. Kommen beide gleich heraus, taugt der Test nicht und die Probe
/// bricht ab, statt eine Zahl zu liefern, die keine ist.
pub fn selbsttest(t: &Treiber) -> Result<(String, String)> {
    let mut dptr: u64 = 0;
    // SAFETY: 4 MiB Geraetespeicher; `dptr` wird sofort danach geprueft.
    pruefe(unsafe { (t.mem_alloc)(&mut dptr, 4 << 20) }, "cuMemAlloc")?;
    let auf_karte = t.lage(dptr);
    // SAFETY: `dptr` stammt aus `cuMemAlloc` und wird danach nicht mehr benutzt.
    unsafe { (t.mem_free)(dptr) };

    let wirt: Vec<u8> = vec![0u8; 4 << 20];
    let im_wirt = t.lage(wirt.as_ptr() as u64);
    drop(wirt);

    if !auf_karte.ist_geraet() {
        bail!(
            "Kontrolle A: cuMemAlloc-Speicher kommt als {} heraus — der Zeigertest erkennt \
             Grafikspeicher nicht, jede Aussage der Probe waere wertlos",
            auf_karte.text()
        );
    }
    if im_wirt.ist_geraet() {
        bail!(
            "Kontrolle A: gewoehnlicher Vec-Speicher kommt als {} heraus — der Zeigertest \
             sagt zu allem 'Grafikspeicher'",
            im_wirt.text()
        );
    }
    Ok((auf_karte.text(), im_wirt.text()))
}
