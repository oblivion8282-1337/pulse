//! Rohe DRM/KMS-ioctls — nur die, die der Scanout-Aufnahmeweg braucht.
//!
//! **Warum von Hand und nicht ueber libdrm.** libdrm haette eine neue
//! Abhaengigkeit bedeutet (`drm-sys`/`pkg-config` im Bau), und gebraucht wird
//! ein knappes Dutzend ioctls mit unveraenderlichem Kernel-ABI. Die Strukturen
//! hier sind 1:1 die aus `include/uapi/drm/drm_mode.h` bzw. `drm.h`; ihre
//! Groesse geht ueber `size_of` in die ioctl-Nummer ein, ein Layout-Fehler
//! faellt damit sofort als `EINVAL` auf und nicht still.
//!
//! **Rechte.** `GETPLANERESOURCES`, `GETPLANE` und `GETFB2` beantwortet der
//! Kernel jedem, der die Karte oeffnen darf. Die **GEM-Handles** in der
//! `GETFB2`-Antwort bekommt aber nur, wer DRM-Master ist **oder**
//! `CAP_SYS_ADMIN` traegt (`drm_mode_getfb2_ioctl`); allen anderen liefert er
//! dieselbe Struktur mit `handles[] == 0`. Ohne Handle kein
//! `PRIME_HANDLE_TO_FD` und damit kein Bild. Das ist der Grund, warum
//! gpu-screen-recorder einen eigenen kleinen Helfer mit gesetzter Capability
//! mitbringt, statt den Aufnehmer selbst zu privilegieren — und der Grund,
//! warum [`crate::capture::kms`] den Fall ausdruecklich benennt, statt an einem
//! leeren Bild zu raten.

use std::os::fd::RawFd;

use anyhow::{Result, anyhow, bail};

// ── ioctl-Nummern ───────────────────────────────────────────────────────────
// Linux-Kodierung: [31:30] Richtung, [29:16] Groesse, [15:8] Typ, [7:0] Nummer.
const DRM_IOCTL_TYPE: u32 = 0x64; // 'd'

const fn ioctl_nr(dir: u32, nr: u32, size: usize) -> libc::c_ulong {
    ((dir << 30) | ((size as u32) << 16) | (DRM_IOCTL_TYPE << 8) | nr) as libc::c_ulong
}

const DIR_WRITE: u32 = 1;
const DIR_RW: u32 = 3;

/// `ioctl` mit Wiederholung bei `EINTR` — der Kernel bricht die
/// Mode-ioctls bei einem Signal ab, und ein einzelner verlorener Frame waere
/// hier ein Aussetzer im Stream.
fn ioctl<T>(fd: RawFd, request: libc::c_ulong, arg: &mut T) -> Result<()> {
    loop {
        let rc = unsafe { libc::ioctl(fd, request, arg as *mut T as *mut libc::c_void) };
        if rc == 0 {
            return Ok(());
        }
        let err = std::io::Error::last_os_error();
        if err.kind() == std::io::ErrorKind::Interrupted {
            continue;
        }
        return Err(anyhow!("DRM-ioctl {request:#x}: {err}"));
    }
}

// ── Strukturen (uapi/drm) ───────────────────────────────────────────────────

#[repr(C)]
#[derive(Default)]
struct SetClientCap {
    capability: u64,
    value: u64,
}

#[repr(C)]
#[derive(Default)]
struct PlaneRes {
    plane_id_ptr: u64,
    count_planes: u32,
}

#[repr(C)]
#[derive(Default)]
struct GetPlane {
    plane_id: u32,
    crtc_id: u32,
    fb_id: u32,
    possible_crtcs: u32,
    gamma_size: u32,
    count_format_types: u32,
    format_type_ptr: u64,
}

#[repr(C)]
#[derive(Default)]
struct FbCmd2 {
    fb_id: u32,
    width: u32,
    height: u32,
    pixel_format: u32,
    flags: u32,
    handles: [u32; 4],
    pitches: [u32; 4],
    offsets: [u32; 4],
    modifier: [u64; 4],
}

#[repr(C)]
#[derive(Default)]
struct PrimeHandle {
    handle: u32,
    flags: u32,
    fd: i32,
}

#[repr(C)]
#[derive(Default)]
struct GemClose {
    handle: u32,
    pad: u32,
}

#[repr(C)]
#[derive(Default)]
struct CardRes {
    fb_id_ptr: u64,
    crtc_id_ptr: u64,
    connector_id_ptr: u64,
    encoder_id_ptr: u64,
    count_fbs: u32,
    count_crtcs: u32,
    count_connectors: u32,
    count_encoders: u32,
    min_width: u32,
    max_width: u32,
    min_height: u32,
    max_height: u32,
}

#[repr(C)]
#[derive(Default)]
struct GetConnector {
    encoders_ptr: u64,
    modes_ptr: u64,
    props_ptr: u64,
    prop_values_ptr: u64,
    count_modes: u32,
    count_props: u32,
    count_encoders: u32,
    encoder_id: u32,
    connector_id: u32,
    connector_type: u32,
    connector_type_id: u32,
    connection: u32,
    mm_width: u32,
    mm_height: u32,
    subpixel: u32,
    pad: u32,
}

#[repr(C)]
#[derive(Default)]
struct GetEncoder {
    encoder_id: u32,
    encoder_type: u32,
    crtc_id: u32,
    possible_crtcs: u32,
    possible_clones: u32,
}

#[repr(C)]
struct GetProperty {
    values_ptr: u64,
    enum_blob_ptr: u64,
    prop_id: u32,
    flags: u32,
    name: [u8; 32],
    count_values: u32,
    count_enum_blobs: u32,
}

#[repr(C)]
#[derive(Default)]
struct GetBlob {
    blob_id: u32,
    length: u32,
    data: u64,
}

// ── Oeffentliche Sicht ──────────────────────────────────────────────────────

/// Ein Scanout-Framebuffer, wie ihn `GETFB2` beschreibt.
#[derive(Debug, Clone)]
pub struct Framebuffer {
    pub width: u32,
    pub height: u32,
    pub fourcc: u32,
    pub modifier: u64,
    /// Je belegter Ebene: (GEM-Handle, Pitch, Offset).
    pub ebenen: Vec<(u32, u32, u32)>,
}

/// Eine Plane mit ihrem aktuellen Framebuffer.
#[derive(Debug, Clone)]
pub struct Plane {
    pub plane_id: u32,
    pub crtc_id: u32,
    pub fb_id: u32,
}

/// Ein angeschlossener Ausgang.
#[derive(Debug, Clone)]
pub struct Connector {
    pub connector_id: u32,
    pub connector_type: u32,
    /// Laufende Nummer je Typ — zusammen mit dem Typ ergibt sie den Namen, den
    /// auch `kscreen-doctor` und `/sys/class/drm` zeigen (`DP-2`, `HDMI-A-1`).
    pub connector_type_id: u32,
    pub encoder_id: u32,
    /// Blob-Nummer der Property `HDR_OUTPUT_METADATA` (0 = nicht gesetzt).
    pub hdr_blob: u32,
    /// Wert der Property `Colorspace` (roher Enum-Index des Treibers).
    pub colorspace: u64,
}

pub const DRM_MODE_CONNECTED: u32 = 1;
const DRM_CLIENT_CAP_UNIVERSAL_PLANES: u64 = 2;
const DRM_CLIENT_CAP_ATOMIC: u64 = 3;

/// Universal-Planes und Atomic anmelden. Ohne das erste sieht der Aufrufer nur
/// die Primaerebenen der alten Schnittstelle — auf manchen Treibern gar keine.
pub fn set_client_caps(fd: RawFd) -> Result<()> {
    for cap in [DRM_CLIENT_CAP_UNIVERSAL_PLANES, DRM_CLIENT_CAP_ATOMIC] {
        let mut arg = SetClientCap { capability: cap, value: 1 };
        ioctl(fd, ioctl_nr(DIR_WRITE, 0x0d, size_of::<SetClientCap>()), &mut arg)
            .map_err(|e| anyhow!("DRM_CLIENT_CAP {cap} setzen: {e}"))?;
    }
    Ok(())
}

/// Alle Planes samt ihrem aktuell gescannten Framebuffer.
pub fn planes(fd: RawFd) -> Result<Vec<Plane>> {
    let req = ioctl_nr(DIR_RW, 0xB5, size_of::<PlaneRes>());
    let mut res = PlaneRes::default();
    ioctl(fd, req, &mut res)?;
    let mut ids = vec![0u32; res.count_planes as usize];
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    res.plane_id_ptr = ids.as_mut_ptr() as u64;
    ioctl(fd, req, &mut res)?;
    ids.truncate(res.count_planes as usize);

    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        let mut p = GetPlane { plane_id: id, ..Default::default() };
        if ioctl(fd, ioctl_nr(DIR_RW, 0xB6, size_of::<GetPlane>()), &mut p).is_err() {
            continue;
        }
        out.push(Plane { plane_id: p.plane_id, crtc_id: p.crtc_id, fb_id: p.fb_id });
    }
    Ok(out)
}

/// Beschreibung eines Framebuffers. Die Handles bleiben leer, wenn der Aufrufer
/// weder DRM-Master ist noch `CAP_SYS_ADMIN` traegt — [`Framebuffer::ebenen`]
/// ist dann leer, und genau das prueft der Aufrufer.
pub fn framebuffer(fd: RawFd, fb_id: u32) -> Result<Framebuffer> {
    let mut fb = FbCmd2 { fb_id, ..Default::default() };
    ioctl(fd, ioctl_nr(DIR_RW, 0xCE, size_of::<FbCmd2>()), &mut fb)?;
    let ebenen = (0..4)
        .filter(|&i| fb.handles[i] != 0)
        .map(|i| (fb.handles[i], fb.pitches[i], fb.offsets[i]))
        .collect();
    // `modifier[]` gilt nur, wenn das Flag es ansagt (DRM_MODE_FB_MODIFIERS);
    // sonst ist das Feld undefiniert und LINEAR anzunehmen waere geraten.
    const DRM_MODE_FB_MODIFIERS: u32 = 1 << 1;
    const DRM_FORMAT_MOD_INVALID: u64 = 0x00ff_ffff_ffff_ffff;
    let modifier = if fb.flags & DRM_MODE_FB_MODIFIERS != 0 {
        fb.modifier[0]
    } else {
        DRM_FORMAT_MOD_INVALID
    };
    Ok(Framebuffer {
        width: fb.width,
        height: fb.height,
        fourcc: fb.pixel_format,
        modifier,
        ebenen,
    })
}

/// GEM-Handle → DMABUF-fd. Der fd gehoert danach dem Aufrufer.
pub fn handle_to_fd(fd: RawFd, handle: u32) -> Result<RawFd> {
    let mut arg = PrimeHandle {
        handle,
        flags: (libc::O_RDONLY | libc::O_CLOEXEC) as u32,
        fd: -1,
    };
    ioctl(fd, ioctl_nr(DIR_RW, 0x2d, size_of::<PrimeHandle>()), &mut arg)?;
    if arg.fd < 0 {
        bail!("PRIME_HANDLE_TO_FD lieferte keinen fd");
    }
    Ok(arg.fd)
}

/// GEM-Handle wieder freigeben. **Pflicht nach jedem `GETFB2`:** der Kernel legt
/// fuer die Antwort neue Handles im Adressraum des Aufrufers an. Wer sie nicht
/// schliesst, sammelt bei 60 Bildern je Sekunde in Minuten Zehntausende an.
pub fn close_handle(fd: RawFd, handle: u32) {
    let mut arg = GemClose { handle, pad: 0 };
    let _ = ioctl(fd, ioctl_nr(DIR_WRITE, 0x09, size_of::<GemClose>()), &mut arg);
}

/// Alle angeschlossenen Ausgaenge mit ihrer HDR-Property.
pub fn connectors(fd: RawFd) -> Result<Vec<Connector>> {
    let req = ioctl_nr(DIR_RW, 0xA0, size_of::<CardRes>());
    let mut res = CardRes::default();
    ioctl(fd, req, &mut res)?;
    let mut ids = vec![0u32; res.count_connectors as usize];
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    res.connector_id_ptr = ids.as_mut_ptr() as u64;
    // Die uebrigen Zeiger bleiben null; der Kernel fuellt dann nur die Zaehler,
    // und genau die brauchen wir nicht.
    res.count_fbs = 0;
    res.count_crtcs = 0;
    res.count_encoders = 0;
    ioctl(fd, req, &mut res)?;
    ids.truncate(res.count_connectors as usize);

    let mut out = Vec::new();
    for id in ids {
        if let Some(c) = connector(fd, id)? {
            out.push(c);
        }
    }
    Ok(out)
}

fn connector(fd: RawFd, connector_id: u32) -> Result<Option<Connector>> {
    let req = ioctl_nr(DIR_RW, 0xA7, size_of::<GetConnector>());
    let mut c = GetConnector { connector_id, ..Default::default() };
    ioctl(fd, req, &mut c)?;
    if c.connection != DRM_MODE_CONNECTED {
        return Ok(None);
    }
    let n = c.count_props as usize;
    let mut props = vec![0u32; n];
    let mut vals = vec![0u64; n];
    if n > 0 {
        c.props_ptr = props.as_mut_ptr() as u64;
        c.prop_values_ptr = vals.as_mut_ptr() as u64;
        c.count_modes = 0;
        c.count_encoders = 0;
        ioctl(fd, req, &mut c)?;
    }

    let mut hdr_blob = 0;
    let mut colorspace = 0;
    for i in 0..(c.count_props as usize).min(n) {
        match property_name(fd, props[i])?.as_deref() {
            Some("HDR_OUTPUT_METADATA") => hdr_blob = vals[i] as u32,
            Some("Colorspace") => colorspace = vals[i],
            _ => {}
        }
    }
    Ok(Some(Connector {
        connector_id: c.connector_id,
        connector_type: c.connector_type,
        connector_type_id: c.connector_type_id,
        encoder_id: c.encoder_id,
        hdr_blob,
        colorspace,
    }))
}

fn property_name(fd: RawFd, prop_id: u32) -> Result<Option<String>> {
    let mut p = GetProperty {
        values_ptr: 0,
        enum_blob_ptr: 0,
        prop_id,
        flags: 0,
        name: [0; 32],
        count_values: 0,
        count_enum_blobs: 0,
    };
    if ioctl(fd, ioctl_nr(DIR_RW, 0xAA, size_of::<GetProperty>()), &mut p).is_err() {
        return Ok(None);
    }
    let end = p.name.iter().position(|&b| b == 0).unwrap_or(p.name.len());
    Ok(String::from_utf8(p.name[..end].to_vec()).ok())
}

/// CRTC hinter einem Encoder.
pub fn crtc_of_encoder(fd: RawFd, encoder_id: u32) -> Result<u32> {
    let mut e = GetEncoder { encoder_id, ..Default::default() };
    ioctl(fd, ioctl_nr(DIR_RW, 0xA6, size_of::<GetEncoder>()), &mut e)?;
    Ok(e.crtc_id)
}

/// Rohinhalt eines Property-Blobs (hier: `HDR_OUTPUT_METADATA`).
pub fn blob(fd: RawFd, blob_id: u32) -> Result<Vec<u8>> {
    let req = ioctl_nr(DIR_RW, 0xAC, size_of::<GetBlob>());
    let mut b = GetBlob { blob_id, ..Default::default() };
    ioctl(fd, req, &mut b)?;
    let mut buf = vec![0u8; b.length as usize];
    if buf.is_empty() {
        return Ok(buf);
    }
    b.data = buf.as_mut_ptr() as u64;
    ioctl(fd, req, &mut b)?;
    Ok(buf)
}
