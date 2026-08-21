//! D3D11VA-hwdevice + hwframes-Pool für Zero-Copy-Encode (NVENC und AMF).
//!
//! ffmpeg-next 8.1 hat keine safe Bindings für `hwcontext_d3d11va.h` — wir gehen
//! direkt über `ffmpeg-sys-next`-FFI. Der `AVD3D11VADeviceContext`-Struct ist
//! verbatim aus FFmpeg 8.1 hier gespiegelt (Layout-Mismatch = sofortiger
//! Crash beim Init, also stabil genug, solange wir an FFmpeg 8.x bleiben).
//!
//! Lebenszyklus:
//! - `HwContext::new(d3d_device, d3d_context, w, h, pool)` baut device_ref +
//!   frames_ref.
//! - `acquire_frame()` zieht einen Pool-Frame; Drop unrefs die AVFrame und gibt
//!   die D3D11-Texture an den Pool zurück.
//! - `frames_ref()` ist die Roh-AVBufferRef, die der Encoder via
//!   `av_buffer_ref()` adoptiert und an `AVCodecContext.hw_frames_ctx` hängt.
//!
//! Thread-Safety: ID3D11DeviceContext ist nicht thread-safe. Wir registrieren
//! eine CRITICAL_SECTION als `lock`/`unlock` an `AVD3D11VADeviceContext`,
//! damit FFmpeg vor jedem internen D3D11-Zugriff lockt. Der Capture-Thread
//! MUSS denselben Lock via `lock()`/`unlock()` halten wenn er
//! CopySubresourceRegion gegen den Pool-Frame fährt.

use anyhow::{Result, anyhow};
use ffmpeg_next::ffi::*;
use std::ffi::c_void;
use std::os::raw::c_int;
use windows::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11DeviceContext};
use windows::Win32::System::Threading::{
    CRITICAL_SECTION, DeleteCriticalSection, EnterCriticalSection, InitializeCriticalSection,
    LeaveCriticalSection,
};
use windows::core::Interface;

/// `AVD3D11VADeviceContext` aus FFmpeg 8.1 `libavutil/hwcontext_d3d11va.h`.
/// ffmpeg-sys-next bindet die D3D11VA-Header nicht — Hand-Spiegel.
#[repr(C)]
struct AVD3D11VADeviceContext {
    device: *mut c_void,         // ID3D11Device*
    device_context: *mut c_void, // ID3D11DeviceContext*
    video_device: *mut c_void,   // ID3D11VideoDevice* (libavutil füllt)
    video_context: *mut c_void,  // ID3D11VideoContext* (libavutil füllt)
    lock: Option<unsafe extern "C" fn(lock_ctx: *mut c_void)>,
    unlock: Option<unsafe extern "C" fn(lock_ctx: *mut c_void)>,
    lock_ctx: *mut c_void,
}

/// **Zweite Spiegelung im Repo:** `AVD3D11VADeviceContext` (nicht dieselbe
/// Struktur, aber dieselbe Kopfdatei und dieselbe Falle) wird auch in
/// `streaming/pulse-player/src/zerocopy/ffmpeg_geraet.rs` von Hand abgebildet.
/// Wer eine an FFmpeg-Aenderungen anpasst, sieht bitte auch dort nach — ein
/// Fehler daran uebersetzt fehlerfrei und beschaedigt Speicher.
///
/// `AVD3D11VAFramesContext` aus FFmpeg 8.1 `libavutil/hwcontext_d3d11va.h`.
/// **Achtung Layout:** das erste Feld ist `ID3D11Texture2D *texture` — eine
/// frühere Spiegelung hier hat das weggelassen, dadurch landete `bind_flags`
/// am falschen Offset (Schreiben in `texture` statt `BindFlags`). Reihenfolge
/// MUSS sein: `texture, BindFlags, MiscFlags, texture_infos`.
#[repr(C)]
struct AVD3D11VAFramesContext {
    texture: *mut c_void,       // ID3D11Texture2D* — von uns NULL gelassen
    bind_flags: u32,            // D3D11_BIND_* (0 = libavutil-Default DECODER|SHADER_RESOURCE)
    misc_flags: u32,            // D3D11_RESOURCE_MISC_* (0 = libavutil-Default)
    texture_infos: *mut c_void, // AVD3D11FrameDescriptor* — output, ungenutzt
}

/// `D3D11_BIND_SHADER_RESOURCE`. Sobald wir `bind_flags` explizit befüllen,
/// übernimmt libavutil seinen Default (`DECODER|SHADER_RESOURCE`) NICHT mehr —
/// SHADER_RESOURCE müssen wir selbst dazunehmen, sonst kann NVENC nicht aus
/// dem Pool lesen.
///
/// `D3D11_BIND_DECODER` (0x200) lassen wir BEWUSST WEG: das Flag ist für
/// Video-Decoder-Output-Surfaces (NV12/P010) gedacht und ist mit
/// `D3D11_BIND_RENDER_TARGET` auf einem BGRA-Format inkompatibel —
/// `CreateTexture2D` failt dann mit `E_INVALIDARG` (0x80070057). NVENC braucht
/// für seinen D3D11-Input kein DECODER-Flag, nur SHADER_RESOURCE.
const D3D11_BIND_SHADER_RESOURCE: u32 = 0x8;

/// `D3D11_RESOURCE_MISC_SHARED` / `..._SHARED_NTHANDLE`. Nur zusammen brauchbar:
/// NTHANDLE allein lehnt `CreateTexture2D` mit `E_INVALIDARG` ab. Warum nicht
/// `KEYEDMUTEX` — s. [`HwPoolConfig::shared`].
const D3D11_RESOURCE_MISC_SHARED: u32 = 0x2;
const D3D11_RESOURCE_MISC_SHARED_NTHANDLE: u32 = 0x800;

/// Hängt das D3D11-Device an einer AMD-GPU (VendorId `0x1002`)? Einer der
/// beiden Gründe für Einzeltexturen statt Texture-Array in [`HwContext::new`]
/// (der andere ist ein P010-Pool — Begründung dort). Bewusst am Device statt
/// an `select_adapter()` abgefragt:
/// maßgeblich ist die GPU, auf der WGC captured und AMF encodiert, und die
/// kann auf Multi-GPU von der `HIGH_PERFORMANCE`-Wahl abweichen (gleiche
/// Überlegung wie `pipeline_hw::device_vendor`).
fn device_is_amd(device: &ID3D11Device) -> bool {
    crate::system::dxgi::device_vendor(device) == Some("amd")
}

unsafe extern "C" fn cs_lock(ctx: *mut c_void) {
    unsafe { EnterCriticalSection(ctx as *mut CRITICAL_SECTION) }
}
unsafe extern "C" fn cs_unlock(ctx: *mut c_void) {
    unsafe { LeaveCriticalSection(ctx as *mut CRITICAL_SECTION) }
}

pub struct HwContext {
    device_ref: *mut AVBufferRef,
    frames_ref: *mut AVBufferRef,
    /// Eigene CRITICAL_SECTION — `None`, wenn dieser Context einen FREMDEN Lock
    /// teilt (Scaler-dst-Pool teilt den Capture-Pool-Lock, s. `new`). Die Box
    /// hält die Section heap-stabil; `lock_ptr` zeigt hinein.
    owned_cs: Option<Box<CRITICAL_SECTION>>,
    /// Tatsächlich benutzter Lock (eigener oder geteilter). Über `lock()`/
    /// `unlock()` und als FFmpeg-`lock_ctx` registriert.
    lock_ptr: *mut CRITICAL_SECTION,
    // ID3D11Device + ID3D11DeviceContext: Context brauchen wir im
    // Capture-Callback für CopySubresourceRegion, Device + Context zusätzlich
    // für den D3D11Scaler (ID3D11VideoDevice/-Context-Cast). Context-Zugriffe
    // MÜSSEN durch lock()/unlock() geschützt sein.
    device: ID3D11Device,
    device_context: ID3D11DeviceContext,
    width: u32,
    height: u32,
}

// HwContext ist Send/Sync, weil:
// - AVBufferRefs sind reference-counted und thread-safe (FFmpeg garantiert das).
// - ID3D11DeviceContext-Zugriffe sind durch die CRITICAL_SECTION serialisiert
//   (Capture-Thread via lock()/unlock(), FFmpeg-intern via lock_ctx-Callback).
// - CRITICAL_SECTION ist Box-stable; wir nehmen seine Adresse nur über *mut.
unsafe impl Send for HwContext {}
unsafe impl Sync for HwContext {}

/// Alles am Pool, was zwischen den Aufrufern abweicht. Als Struct statt als
/// Argumentliste, weil beide Aufrufer nur je zwei Felder vom Default abrücken —
/// als Positionsargumente wären das zwei Reihen aus `0`, `None` und `false`,
/// die man nur mit Inline-Kommentaren lesen kann.
pub struct HwPoolConfig {
    /// Schranke **nur der Array-Bauart** (s. Pool-Bauart in [`HwContext::new`])
    /// — dort kann der Pool nicht wachsen, also muss er Encoder-Vorlauf und
    /// Capture-Backpressure von vornherein fassen. Die Aufrufer geben 24
    /// (Capture-Pool) bzw. 16 (Scaler-Ziel-Pool).
    ///
    /// **In der Einzeltextur-Bauart (AMD oder P010-Pool) ist der Wert
    /// wirkungslos**: dort wächst der Pool bis zur Arbeitsmenge. Zwei Folgen,
    /// die man kennen sollte — die ersten Frames tragen je ein
    /// `CreateTexture2D` (bei 1440p-BGRA ~15 MB) **im Capture-Callback** statt
    /// einmalig beim Pool-Bau, und `acquire_frame` kann nicht mehr wegen „Pool
    /// erschöpft" fehlschlagen, das Backpressure-Signal kommt dann allein aus
    /// der Channel-Kapazität (`wgc_hw.rs::CHANNEL_CAPACITY`).
    pub pool_size: u32,
    /// Zusätzliche `D3D11_BIND_*`-Flags für die Pool-Texturen (0 = nur
    /// libavutil-Default DECODER|SHADER_RESOURCE). Der `D3D11Scaler`-Ziel-Pool
    /// übergibt `D3D11_BIND_RENDER_TARGET`, damit
    /// `CreateVideoProcessorOutputView` die Texturen akzeptiert; der
    /// Capture-Pool übergibt 0.
    pub extra_bind_flags: u32,
    /// Fremde CRITICAL_SECTION mitbenutzen statt einer eigenen. Der
    /// Scaler-Ziel-Pool teilt so den Lock des Capture-Pools — Begründung in
    /// [`HwContext::new`].
    pub shared_lock: Option<*mut CRITICAL_SECTION>,
    /// Pool-Format. `AV_PIX_FMT_BGRA` ist der Regelfall (der Encoder wandelt
    /// selbst); `AV_PIX_FMT_P010LE` braucht der 10-bit-Weg, weil `av1_amf`
    /// BGRA-Eingang für 10 bit ablehnt (`SubmitInput() failed with error 18`,
    /// gemessen 2026-08-01), P010 als D3D11-Textur aber annimmt.
    ///
    /// **Falle:** die Bind-Flags müssen zum Format passen. FFmpegs eigener
    /// `scale_d3d11`-Filter scheitert an genau dieser Stelle mit
    /// `CreateTexture2D`-Fehler `0x80070057` — dieselbe Fehlerklasse wie
    /// `DECODER|RENDER_TARGET` auf BGRA (s. Konstanten-Doku oben). Wer hier ein
    /// Format ergänzt, prüft die Flags mit.
    pub sw_format: AVPixelFormat,
    /// Pool-Texturen als NT-Handle teilbar machen. Braucht nur der Messstand
    /// (`streaming/win-hq-labor/`), dessen Encoder Vulkan ist und die Texturen
    /// importieren muss. `NTHANDLE` allein genügt nicht — ohne `SHARED` lehnt
    /// `CreateTexture2D` mit `E_INVALIDARG` ab. **Nicht `KEYEDMUTEX` nehmen**,
    /// obwohl auch das die Textur erzeugbar macht: ein Keyed-Mutex verlangt,
    /// dass jeder Zugriff die Sperre nimmt, und an FFmpegs
    /// Vulkan-Kommandopuffer kommt man nicht heran.
    pub shared: bool,
}

impl Default for HwPoolConfig {
    fn default() -> Self {
        Self {
            pool_size: 0,
            extra_bind_flags: 0,
            shared_lock: None,
            sw_format: AVPixelFormat::AV_PIX_FMT_BGRA,
            shared: false,
        }
    }
}

impl HwContext {
    /// Baut device_ctx + frames_ctx aus WGCs D3D11-Handles.
    pub fn new(
        device: ID3D11Device,
        device_context: ID3D11DeviceContext,
        width: u32,
        height: u32,
        cfg: HwPoolConfig,
    ) -> Result<Self> {
        let HwPoolConfig { pool_size, extra_bind_flags, shared_lock, sw_format, shared } = cfg;
        // Eigenen Lock anlegen ODER einen fremden teilen. Letzteres ist der
        // #2-Fix: der Scaler-dst-Pool teilt die CRITICAL_SECTION des Capture-
        // Pools, damit CopySubresourceRegion (Capture-Thread), VideoProcessorBlt
        // (Pacing-Thread) und NVENC-Submit (FFmpeg-intern) ALLE auf EINEM Lock
        // serialisieren — sie bespielen denselben immediate ID3D11DeviceContext,
        // der nicht thread-safe ist. Zwei Locks für einen Context = Datenrace.
        let (owned_cs, lock_ptr) = match shared_lock {
            Some(ptr) => (None, ptr),
            None => {
                let mut cs = Box::new(CRITICAL_SECTION::default());
                unsafe { InitializeCriticalSection(&mut *cs as *mut CRITICAL_SECTION) };
                let ptr = &mut *cs as *mut CRITICAL_SECTION;
                (Some(cs), ptr)
            }
        };

        let device_ref = unsafe { av_hwdevice_ctx_alloc(AVHWDeviceType::AV_HWDEVICE_TYPE_D3D11VA) };
        if device_ref.is_null() {
            if owned_cs.is_some() {
                unsafe { DeleteCriticalSection(lock_ptr) };
            }
            return Err(anyhow!("av_hwdevice_ctx_alloc(D3D11VA) returned NULL"));
        }

        // `into_raw()` konsumiert den AddRef-Count: wir geben FFmpeg unsere
        // Refs ab. Die WGC-Originale (device/device_context im Caller-Scope)
        // sind separate AddRefs und bleiben gültig.
        let device_raw = device.clone().into_raw();
        let ctx_raw = device_context.clone().into_raw();

        unsafe {
            let dev_ctx = (*device_ref).data as *mut AVHWDeviceContext;
            let d3d_hw = (*dev_ctx).hwctx as *mut AVD3D11VADeviceContext;
            (*d3d_hw).device = device_raw;
            (*d3d_hw).device_context = ctx_raw;
            (*d3d_hw).lock = Some(cs_lock);
            (*d3d_hw).unlock = Some(cs_unlock);
            (*d3d_hw).lock_ctx = lock_ptr as *mut c_void;
        }

        let init = unsafe { av_hwdevice_ctx_init(device_ref) };
        if init < 0 {
            let mut r = device_ref;
            unsafe {
                av_buffer_unref(&mut r);
                if owned_cs.is_some() {
                    DeleteCriticalSection(lock_ptr);
                }
            }
            return Err(anyhow!("av_hwdevice_ctx_init(D3D11VA) failed: {init}"));
        }

        let frames_ref = unsafe { av_hwframe_ctx_alloc(device_ref) };
        if frames_ref.is_null() {
            let mut r = device_ref;
            unsafe {
                av_buffer_unref(&mut r);
                if owned_cs.is_some() {
                    DeleteCriticalSection(lock_ptr);
                }
            }
            return Err(anyhow!("av_hwframe_ctx_alloc returned NULL"));
        }

        unsafe {
            let frames_hdr = (*frames_ref).data as *mut AVHWFramesContext;
            (*frames_hdr).format = AVPixelFormat::AV_PIX_FMT_D3D11;
            (*frames_hdr).sw_format = sw_format;
            (*frames_hdr).width = width as c_int;
            (*frames_hdr).height = height as c_int;
            // Pool-Bauart — Texture-Array oder Einzeltexturen. Was libavutil
            // daraus macht (FFmpeg n8.1.1):
            //
            // - `initial_pool_size > 0` → libavutil legt EIN `ID3D11Texture2D`
            //   mit `ArraySize = pool_size` an; die Frames unterscheiden sich
            //   nur im Subresource-Index (`data[1]`).
            // - `initial_pool_size = 0` → je Frame eine EIGENE Textur
            //   (`ArraySize = 1`, Index 0; `d3d11va_alloc_single` in
            //   `hwcontext_d3d11va.c`). Der AVBufferPool recycelt sie, die
            //   Allokation wächst also nur bis zur Arbeitsmenge (~6 Texturen
            //   statt fix `pool_size` — bei 1440p-BGRA spart das zudem
            //   ~250 MB VRAM gegenüber dem 24er-Array).
            //
            // **AMF (AMD) liefert über den Array-Pool ein zerrissenes Bild**
            // (2026-07-30, Radeon 780M, Treiber 32.0.31035.1003) — doppelte,
            // versetzte Kopien, verschmierter Text; `av1_amf` wie `h264_amf`,
            // 1440p nativ wie 1080p über den Scaler-Pool. Mit Einzeltexturen
            // ist dasselbe Material über denselben Pfad sauber (Standbilder
            // `f_singletex/f_st1080/f_sth264.png` gegen
            // `f_arrayctl.png`, A/B auf demselben Build; deckungsgleich die
            // CLI-Probe F2: `hwupload` ohne `extra_hw_frames` = dynamische
            // Einzeltexturen, VMAF 82,1). FFmpeg übergibt den Index korrekt
            // per `SetPrivateData(AMFTextureArrayIndexGUID)` vor
            // `CreateSurfaceFromDX11Native` (`amfenc.c`) — die AMF-Runtime
            // dieses Treibers verwertet ihn beim BGRA-Eingang offenbar nicht.
            // NVENC (NVIDIA) läuft über den Array-Pool fehlerfrei, **solange er
            // BGRA führt** — und bleibt dafür darauf; die Einzeltextur-Wirkung
            // ist dort ungemessen.
            //
            // **P010 kann NVIDIA dagegen nicht als Array** (2026-08-04, RTX
            // 5080, Treiber 32.0.16.1047): der Ziel-Pool des Skalierers scheitert
            // an `Could not create the texture (80070057)` = `E_INVALIDARG`, und
            // damit stirbt jeder 10-bit-Stream noch vor dem Encoder-Open. Mit
            // Einzeltexturen läuft dieselbe Kombination auf Anhieb
            // (`av1_nvenc`, `yuv420p10le` am fertigen Strom nachgesehen).
            // Getrennt ist NICHT, ob der Treiber P010-Arrays grundsätzlich
            // ablehnt oder nur zusammen mit `RENDER_TARGET` — der 10-bit-Pool
            // hat dieses Bind-Flag immer, die Frage stellt sich hier also nicht.
            // Gemessen am 2026-08-04 auf einer RTX 5080.
            //
            // Deshalb hängt die Bauart an **beidem**: am Vendor (AMDs
            // zerrissenes Bild) und am Format (NVIDIAs abgelehntem P010-Array).
            // Ein reiner Vendor-Schalter hat hier still eine Funktion gekostet,
            // die `health` als vorhanden gemeldet hat.
            //
            // `PULSE_HQ_D3D11_SINGLE_TEX=1|0` übersteuert beides in beide
            // Richtungen (Messschalter; `0` reproduziert das zerrissene Bild auf
            // AMD und den P010-Fehlschlag auf NVIDIA, `1` misst Einzeltexturen
            // auf NVIDIA in 8 bit).
            let single_tex = crate::env::flag_opt("PULSE_HQ_D3D11_SINGLE_TEX")
                .unwrap_or_else(|| {
                    device_is_amd(&device) || sw_format == AVPixelFormat::AV_PIX_FMT_P010LE
                });
            (*frames_hdr).initial_pool_size = if single_tex { 0 } else { pool_size as c_int };
            // BindFlags setzen wir nur explizit, wenn `extra_bind_flags != 0`
            // (Scaler-Ziel-Pool braucht RENDER_TARGET). Dann SHADER_RESOURCE
            // selbst dazunehmen — DECODER lassen wir weg (inkompatibel mit
            // RENDER_TARGET auf BGRA, s. Konstanten-Doku oben). Capture-Pool
            // (flags=0) bleibt unverändert auf libavutil-Default.
            let d3d_frames = (*frames_hdr).hwctx as *mut AVD3D11VAFramesContext;
            if extra_bind_flags != 0 {
                (*d3d_frames).bind_flags = D3D11_BIND_SHADER_RESOURCE | extra_bind_flags;
            }
            if shared {
                (*d3d_frames).misc_flags = D3D11_RESOURCE_MISC_SHARED_NTHANDLE
                    | D3D11_RESOURCE_MISC_SHARED;
            }
        }

        let init = unsafe { av_hwframe_ctx_init(frames_ref) };
        if init < 0 {
            let mut fr = frames_ref;
            let mut dr = device_ref;
            unsafe {
                av_buffer_unref(&mut fr);
                av_buffer_unref(&mut dr);
                if owned_cs.is_some() {
                    DeleteCriticalSection(lock_ptr);
                }
            }
            return Err(anyhow!("av_hwframe_ctx_init failed: {init}"));
        }

        Ok(Self { device_ref, frames_ref, owned_cs, lock_ptr, device, device_context, width, height })
    }

    pub fn width(&self) -> u32 { self.width }
    pub fn height(&self) -> u32 { self.height }

    /// ID3D11Device — für den `D3D11Scaler` (Cast auf `ID3D11VideoDevice`).
    pub fn device(&self) -> &ID3D11Device { &self.device }

    /// Roh-Pointer auf die frames AVBufferRef. Encoder muss `av_buffer_ref`
    /// aufrufen um eine eigene Referenz für `AVCodecContext.hw_frames_ctx` zu
    /// bekommen.
    pub fn frames_ref(&self) -> *mut AVBufferRef { self.frames_ref }

    /// ID3D11DeviceContext für CopySubresourceRegion.
    ///
    /// # Safety
    /// Der immediate Context ist NICHT thread-safe; die `Sync`-Zusicherung
    /// oben steht und fällt damit, dass jeder Befehl darauf zwischen `lock()`/
    /// `unlock()` läuft. Als `unsafe fn`, damit diese Invariante nicht mehr
    /// nur im Kommentar lebt: Der Caller bestätigt, dass er entweder den Lock
    /// hält (GPU-Befehle) oder die Referenz nur klont (`AddRef` ist atomar,
    /// z.B. für die Weitergabe an `D3D11Scaler::new`).
    pub unsafe fn device_context(&self) -> &ID3D11DeviceContext { &self.device_context }

    pub fn lock(&self) {
        unsafe { EnterCriticalSection(self.lock_ptr) }
    }
    pub fn unlock(&self) {
        unsafe { LeaveCriticalSection(self.lock_ptr) }
    }

    /// Roh-Pointer auf die CRITICAL_SECTION dieses Contexts — damit ein anderer
    /// `HwContext` (Scaler-dst-Pool) DENSELBEN Lock teilen kann (`new(.., Some(p))`)
    /// statt einen eigenen anzulegen. So serialisieren Capture-Copy, Blt und
    /// NVENC-Submit auf EINEM Lock (geteilter immediate ID3D11DeviceContext).
    /// **Lebensdauer:** der teilende Context darf diesen hier nicht überleben
    /// (in `pipeline_hw` droppt der Scaler vor dem Capture-`HwContext`, bzw. im
    /// Normalfall werden beide geleakt → Prozess-Exit).
    pub fn lock_ptr(&self) -> *mut CRITICAL_SECTION {
        self.lock_ptr
    }

    /// Pool-Frame anfordern. AVBufferPool ist intern thread-safe.
    pub fn acquire_frame(&self) -> Result<OwnedHwFrame> {
        let frame = unsafe { av_frame_alloc() };
        if frame.is_null() {
            return Err(anyhow!("av_frame_alloc returned NULL"));
        }
        let ret = unsafe { av_hwframe_get_buffer(self.frames_ref, frame, 0) };
        if ret < 0 {
            let mut f = frame;
            unsafe { av_frame_free(&mut f) };
            return Err(anyhow!("av_hwframe_get_buffer failed: {ret}"));
        }
        Ok(OwnedHwFrame { frame })
    }
}

impl Drop for HwContext {
    fn drop(&mut self) {
        unsafe {
            // frames_ref hält interne Ref auf device_ref → frames zuerst.
            av_buffer_unref(&mut self.frames_ref);
            av_buffer_unref(&mut self.device_ref);
            // Nur die EIGENE Section löschen; einen geteilten Lock besitzt der
            // andere Context und löscht ihn selbst. owned_cs-Box gibt danach den
            // Heap frei.
            if self.owned_cs.is_some() {
                DeleteCriticalSection(self.lock_ptr);
            }
        }
    }
}

/// Eine Pool-Allokation aus HwContext. Drop unrefs die AVFrame; die D3D11-
/// Texture geht zurück in den Pool. Send, weil der AVFrame-Ptr nur eine
/// Heap-Adresse ist; alles tatsächlich Texture-bezogene ist ref-counted.
pub struct OwnedHwFrame {
    frame: *mut AVFrame,
}

unsafe impl Send for OwnedHwFrame {}

impl OwnedHwFrame {
    /// Roh-Pointer auf die D3D11-Texture im AVFrame (`data[0]`). Für
    /// CopySubresourceRegion als `pDstResource`. Borrowed — kein AddRef.
    pub fn texture_raw(&self) -> *mut c_void {
        unsafe { (*self.frame).data[0] as *mut c_void }
    }

    /// Subresource-Index in der Pool-Array-Texture (`data[1]`, intptr_t).
    pub fn subresource_index(&self) -> u32 {
        unsafe { (*self.frame).data[1] as isize as u32 }
    }

    /// AVFrame-Pointer für `avcodec_send_frame`. Eigentumsverhältnis: bleibt
    /// bei OwnedHwFrame — der Encoder ref'd intern wenn er den Frame
    /// weiterleitet.
    pub fn as_mut_ptr(&mut self) -> *mut AVFrame { self.frame }

    pub fn set_pts(&mut self, pts: i64) {
        unsafe { (*self.frame).pts = pts }
    }
}

impl Drop for OwnedHwFrame {
    fn drop(&mut self) {
        unsafe { av_frame_free(&mut self.frame) }
    }
}
