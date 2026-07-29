//! RGB→P010-Wandlung auf der GPU (GL-Shader), Vorstufe des 10-bit-NVENC-Pfads.
//!
//! **Warum das nötig ist.** Im 8-bit-Pfad wandelt NVENC selbst: der Encoder
//! nimmt RGB direkt, der CUDA-Frame-Pool trägt `RGB0`. Für 10 bit geht das
//! nicht, und zwar aus zwei unabhängigen Gründen, beide gemessen
//! (2026-07-26, RTX 4090, FFmpeg 8.1):
//!
//! 1. FFmpegs CUDA-**Frame-Kontext** kennt kein 10-bit-RGB —
//!    `av_hwframe_ctx_init` mit `sw_format=x2bgr10le` scheitert mit
//!    „Pixel format 'x2bgr10le' is not supported" (rc=-38). 10 bit muss dort
//!    als `P010` anliegen. (Dass `av1_nvenc` `x2bgr10le` in seiner
//!    Formatliste führt, gilt nur für den Software-Frame-Weg mit interner
//!    Konvertierung — nicht für einen HW-Pool.)
//! 2. `scale_cuda` — der symmetrische Weg zum VAAPI-Pfad, der dort
//!    `scale_vaapi` für BGRx→NV12 nutzt — kann RGB nicht in ein
//!    10-bit-YUV wandeln: „Unsupported conversion: bgr0 -> semiplanar10".
//!
//! Bleibt: selbst wandeln. Zwei Shader-Durchgänge schreiben die beiden
//! P010-Ebenen, die CUDA dann direkt liest (`R16`/`RG16` sind — anders als
//! gepacktes `GL_RGB10_A2` — von der CUDA-GL-Interop unterstützt).
//!
//! **Bit-Lage.** P010 trägt die 10 Bit in den OBEREN Bits eines 16-bit-Worts.
//! Der Shader schreibt deshalb `code * 64 / 65535`: bei `code ≤ 1023` ist
//! `code*64 ≤ 65472` in 16 bit exakt darstellbar, die unteren 6 Bit sind null
//! und die oberen 10 tragen genau `code`. Keine Rundungs-Drift.
//!
//! **Farbkonvention.** BT.709, begrenzter Wertebereich (`Y ∈ [64,940]`,
//! `C ∈ [64,960]` in 10 bit) — genau das, was der Encoder im Bitstrom
//! signalisiert (s. `encode::mod`). Wer die Matrix hier ändert, MUSS die
//! Signalisierung mitändern, sonst zeigt der Player verschobene Farben.
//!
//! Dieses Modul ist bewusst GL-only: die CUDA-Registrierung und die Kopien in
//! den Frame liegen bei `nv_import`, das den CUDA-Kontext hält.

use std::ffi::{CStr, c_char, c_void};
use std::ptr;

use anyhow::{Result, anyhow};

// ── GL-Konstanten ───────────────────────────────────────────────────────────
const GL_TEXTURE_2D: u32 = 0x0DE1;
const GL_NO_ERROR: u32 = 0;
const GL_R16: u32 = 0x822A;
const GL_RG16: u32 = 0x822C;
const GL_TEXTURE_MIN_FILTER: u32 = 0x2801;
const GL_TEXTURE_MAG_FILTER: u32 = 0x2800;
const GL_NEAREST: i32 = 0x2600;
const GL_FRAMEBUFFER: u32 = 0x8D40;
const GL_COLOR_ATTACHMENT0: u32 = 0x8CE0;
const GL_FRAMEBUFFER_COMPLETE: u32 = 0x8CD5;
const GL_VERTEX_SHADER: u32 = 0x8B31;
const GL_FRAGMENT_SHADER: u32 = 0x8B30;
const GL_COMPILE_STATUS: u32 = 0x8B81;
const GL_LINK_STATUS: u32 = 0x8B82;
const GL_TRIANGLES: u32 = 0x0004;
const GL_TEXTURE0: u32 = 0x84C0;

type FnGetProcAddress = unsafe extern "C" fn(*const c_char) -> *mut c_void;

macro_rules! gl_proc {
    ($get:expr, $name:literal, $ty:ty) => {{
        let p = $get(concat!($name, "\0").as_ptr() as *const c_char);
        if p.is_null() {
            return Err(anyhow!(concat!("eglGetProcAddress(", $name, ") → NULL")));
        }
        std::mem::transmute::<*mut c_void, $ty>(p)
    }};
}

/// Die GL-Aufrufe, die dieses Modul braucht. Eigenes Bündel statt Durchreichen
/// aus `nv_import`: der EGL-Context ist auf diesem Thread schon current, das
/// Nachladen der Zeiger ist billig, und die Module bleiben entkoppelt.
#[allow(clippy::type_complexity)]
struct GlProcs {
    gen_textures: unsafe extern "C" fn(i32, *mut u32),
    delete_textures: unsafe extern "C" fn(i32, *const u32),
    bind_texture: unsafe extern "C" fn(u32, u32),
    tex_storage_2d: unsafe extern "C" fn(u32, i32, u32, i32, i32),
    tex_parameteri: unsafe extern "C" fn(u32, u32, i32),
    gen_framebuffers: unsafe extern "C" fn(i32, *mut u32),
    delete_framebuffers: unsafe extern "C" fn(i32, *const u32),
    bind_framebuffer: unsafe extern "C" fn(u32, u32),
    framebuffer_texture_2d: unsafe extern "C" fn(u32, u32, u32, u32, i32),
    check_framebuffer_status: unsafe extern "C" fn(u32) -> u32,
    viewport: unsafe extern "C" fn(i32, i32, i32, i32),
    get_error: unsafe extern "C" fn() -> u32,
    create_shader: unsafe extern "C" fn(u32) -> u32,
    shader_source: unsafe extern "C" fn(u32, i32, *const *const c_char, *const i32),
    compile_shader: unsafe extern "C" fn(u32),
    get_shaderiv: unsafe extern "C" fn(u32, u32, *mut i32),
    get_shader_info_log: unsafe extern "C" fn(u32, i32, *mut i32, *mut c_char),
    delete_shader: unsafe extern "C" fn(u32),
    create_program: unsafe extern "C" fn() -> u32,
    attach_shader: unsafe extern "C" fn(u32, u32),
    link_program: unsafe extern "C" fn(u32),
    get_programiv: unsafe extern "C" fn(u32, u32, *mut i32),
    get_program_info_log: unsafe extern "C" fn(u32, i32, *mut i32, *mut c_char),
    delete_program: unsafe extern "C" fn(u32),
    use_program: unsafe extern "C" fn(u32),
    get_uniform_location: unsafe extern "C" fn(u32, *const c_char) -> i32,
    uniform1i: unsafe extern "C" fn(i32, i32),
    uniform2f: unsafe extern "C" fn(i32, f32, f32),
    active_texture: unsafe extern "C" fn(u32),
    gen_vertex_arrays: unsafe extern "C" fn(i32, *mut u32),
    delete_vertex_arrays: unsafe extern "C" fn(i32, *const u32),
    bind_vertex_array: unsafe extern "C" fn(u32),
    draw_arrays: unsafe extern "C" fn(u32, i32, i32),
}

impl GlProcs {
    // Das Transmute-Ziel ist der Feldtyp — der IST die Annotation und die
    // einzige Quelle der Signatur. Sie hier zusätzlich auszuschreiben hieße,
    // 30+ FFI-Signaturen doppelt zu pflegen, mit dem Risiko, dass beide
    // Fassungen auseinanderlaufen (und eine falsche Signatur ist UB).
    #[allow(clippy::missing_transmute_annotations)]
    unsafe fn load() -> Result<Self> {
        unsafe {
            let egl_lib = crate::capture::egl_modifiers::egl_library().map_err(|e| anyhow!("{e}"))?;
            let get_proc: libloading::Symbol<FnGetProcAddress> = egl_lib
                .get(b"eglGetProcAddress\0")
                .map_err(|e| anyhow!("eglGetProcAddress: {e}"))?;
            let g = *get_proc;
            Ok(Self {
                gen_textures: gl_proc!(g, "glGenTextures", _),
                delete_textures: gl_proc!(g, "glDeleteTextures", _),
                bind_texture: gl_proc!(g, "glBindTexture", _),
                tex_storage_2d: gl_proc!(g, "glTexStorage2D", _),
                tex_parameteri: gl_proc!(g, "glTexParameteri", _),
                gen_framebuffers: gl_proc!(g, "glGenFramebuffers", _),
                delete_framebuffers: gl_proc!(g, "glDeleteFramebuffers", _),
                bind_framebuffer: gl_proc!(g, "glBindFramebuffer", _),
                framebuffer_texture_2d: gl_proc!(g, "glFramebufferTexture2D", _),
                check_framebuffer_status: gl_proc!(g, "glCheckFramebufferStatus", _),
                viewport: gl_proc!(g, "glViewport", _),
                get_error: gl_proc!(g, "glGetError", _),
                create_shader: gl_proc!(g, "glCreateShader", _),
                shader_source: gl_proc!(g, "glShaderSource", _),
                compile_shader: gl_proc!(g, "glCompileShader", _),
                get_shaderiv: gl_proc!(g, "glGetShaderiv", _),
                get_shader_info_log: gl_proc!(g, "glGetShaderInfoLog", _),
                delete_shader: gl_proc!(g, "glDeleteShader", _),
                create_program: gl_proc!(g, "glCreateProgram", _),
                attach_shader: gl_proc!(g, "glAttachShader", _),
                link_program: gl_proc!(g, "glLinkProgram", _),
                get_programiv: gl_proc!(g, "glGetProgramiv", _),
                get_program_info_log: gl_proc!(g, "glGetProgramInfoLog", _),
                delete_program: gl_proc!(g, "glDeleteProgram", _),
                use_program: gl_proc!(g, "glUseProgram", _),
                get_uniform_location: gl_proc!(g, "glGetUniformLocation", _),
                uniform1i: gl_proc!(g, "glUniform1i", _),
                uniform2f: gl_proc!(g, "glUniform2f", _),
                active_texture: gl_proc!(g, "glActiveTexture", _),
                gen_vertex_arrays: gl_proc!(g, "glGenVertexArrays", _),
                delete_vertex_arrays: gl_proc!(g, "glDeleteVertexArrays", _),
                bind_vertex_array: gl_proc!(g, "glBindVertexArray", _),
                draw_arrays: gl_proc!(g, "glDrawArrays", _),
            })
        }
    }
}

/// Vollbild-Dreieck ohne Vertex-Puffer (`gl_VertexID`). `uv` läuft über den
/// sichtbaren Teil von 0..1 — dieselbe Orientierung wie `glBlitFramebuffer`
/// im 8-bit-Pfad (unten-links auf unten-links), deshalb kein Y-Tausch.
const VERT: &str = r#"#version 330
out vec2 uv;
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    uv = p;
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
"#;

/// Gemeinsamer Kopf: BT.709-Matrix + P010-Quantisierung an EINER Stelle,
/// damit Luma- und Chroma-Shader nicht auseinanderlaufen können.
const COMMON: &str = r#"
uniform sampler2D src;
in vec2 uv;
const vec3 W709 = vec3(0.2126, 0.7152, 0.0722);
float luma(vec3 c) { return dot(c, W709); }
// 10-bit-Code → normalisierter 16-bit-Wert mit den 10 Bit OBEN.
float p010(float code) { return clamp(floor(code + 0.5) * 64.0 / 65535.0, 0.0, 1.0); }
"#;

const FRAG_Y: &str = r#"#version 330
out float outY;
void main() {
    // Begrenzter Wertebereich, 10 bit: Y' = 0 → 64, Y' = 1 → 940.
    outY = p010(luma(texture(src, uv).rgb) * 876.0 + 64.0);
}
"#;

const FRAG_UV: &str = r#"#version 330
uniform vec2 uv_texel;   // 1 / Größe der CHROMA-Ebene
out vec2 outUV;
void main() {
    // 2×2-Kastenmittel über die vier Quadranten des Chroma-Bildpunkts —
    // unabhängig davon, ob die Quelle genau doppelt so groß ist (bei
    // aktivem Herunterskalieren ist sie es nicht).
    vec2 q = uv_texel * 0.25;
    vec3 c = 0.25 * (texture(src, uv + vec2(-q.x, -q.y)).rgb
                   + texture(src, uv + vec2( q.x, -q.y)).rgb
                   + texture(src, uv + vec2(-q.x,  q.y)).rgb
                   + texture(src, uv + vec2( q.x,  q.y)).rgb);
    float y = luma(c);
    // BT.709-Nenner; begrenzter Bereich, 10 bit: Mitte 512, ±448.
    float cb = (c.b - y) / 1.8556;
    float cr = (c.r - y) / 1.5748;
    outUV = vec2(p010(cb * 896.0 + 512.0), p010(cr * 896.0 + 512.0));
}
"#;

/// Die zwei P010-Ebenen samt Shader-Programmen und FBO.
pub struct RgbToP010 {
    gl: GlProcs,
    /// Luma, `R16`, volle Ausgabegröße.
    y_tex: u32,
    /// Chroma verschränkt (Cb,Cr), `RG16`, halbe Größe.
    uv_tex: u32,
    width: u32,
    height: u32,
    uv_width: u32,
    uv_height: u32,
    prog_y: u32,
    prog_uv: u32,
    loc_uv_texel: i32,
    fbo: u32,
    vao: u32,
}

impl RgbToP010 {
    /// `width`/`height` = Ausgabegröße (Encoder-Größe). Muss auf dem Thread
    /// laufen, auf dem der EGL-Context current ist.
    pub fn new(width: u32, height: u32) -> Result<Self> {
        let gl = unsafe { GlProcs::load()? };
        // P010 ist 4:2:0 — die Chroma-Ebene ist die halbe Größe. Bei ungerader
        // Kantenlänge aufrunden, damit kein Rand fehlt (`ResolutionRequest`
        // liefert gerade Maße, der Native-Pfad rundet ebenfalls).
        let (uv_width, uv_height) = (width.div_ceil(2), height.div_ceil(2));
        let mut me = Self {
            gl,
            y_tex: 0,
            uv_tex: 0,
            width,
            height,
            uv_width,
            uv_height,
            prog_y: 0,
            prog_uv: 0,
            loc_uv_texel: -1,
            fbo: 0,
            vao: 0,
        };
        unsafe { me.build()? };
        Ok(me)
    }

    unsafe fn build(&mut self) -> Result<()> {
        let gl = &self.gl;
        unsafe {
            self.y_tex = make_plane(gl, GL_R16, self.width, self.height)?;
            self.uv_tex = make_plane(gl, GL_RG16, self.uv_width, self.uv_height)?;
            (gl.gen_framebuffers)(1, &mut self.fbo);
            (gl.gen_vertex_arrays)(1, &mut self.vao);
            self.prog_y = link_program(gl, VERT, &split_version(FRAG_Y))?;
            self.prog_uv = link_program(gl, VERT, &split_version(FRAG_UV))?;
            // `src` liegt fest auf Textureinheit 0.
            for p in [self.prog_y, self.prog_uv] {
                (gl.use_program)(p);
                let loc = (gl.get_uniform_location)(p, c"src".as_ptr());
                if loc >= 0 {
                    (gl.uniform1i)(loc, 0);
                }
            }
            self.loc_uv_texel = (gl.get_uniform_location)(self.prog_uv, c"uv_texel".as_ptr());
            (gl.use_program)(0);
            let err = (gl.get_error)();
            if err != GL_NO_ERROR {
                return Err(anyhow!("P010-Aufbau: glError={err:#06x}"));
            }
        }
        Ok(())
    }

    pub fn y_tex(&self) -> u32 {
        self.y_tex
    }

    pub fn uv_tex(&self) -> u32 {
        self.uv_tex
    }

    pub fn uv_size(&self) -> (u32, u32) {
        (self.uv_width, self.uv_height)
    }

    /// Wandelt die RGB-Quelltextur in die beiden P010-Ebenen. `src_tex` muss
    /// eine 2D-Textur mit gamma-kodiertem R'G'B' sein (die EGLImage-Textur des
    /// Capture-Buffers); skaliert wird implizit über die Ziel-Viewports, die
    /// Filterung übernimmt der `LINEAR`-Sampler der Quelle.
    pub fn convert(&self, src_tex: u32) -> Result<()> {
        let gl = &self.gl;
        unsafe {
            (gl.bind_framebuffer)(GL_FRAMEBUFFER, self.fbo);
            (gl.active_texture)(GL_TEXTURE0);
            (gl.bind_texture)(GL_TEXTURE_2D, src_tex);
            // Bilinear + Klemmen an den Rand: ohne LINEAR wäre das
            // Herunterskalieren ein Punkt-Griff (Aliasing), ohne CLAMP griffe
            // das 2×2-Mittel am Bildrand über die Kante.
            // Filter und Wrap-Modus setzt `nv_import::create_image_tex` EINMAL
            // beim Anlegen der Textur — hier je Bild waren es vier
            // Zustandsaufrufe fuer etwas, das sich nie aendert. Ein Cache nach
            // Textur-Nummer waere die falsche Loesung: GL vergibt Nummern nach
            // dem Loeschen wieder, eine neue Textur koennte eine alte erben und
            // ihre Filter nie bekommen.
            (gl.bind_vertex_array)(self.vao);

            self.pass(self.prog_y, self.y_tex, self.width, self.height, None)?;
            self.pass(
                self.prog_uv,
                self.uv_tex,
                self.uv_width,
                self.uv_height,
                Some((1.0 / self.uv_width as f32, 1.0 / self.uv_height as f32)),
            )?;

            (gl.bind_vertex_array)(0);
            (gl.use_program)(0);
            (gl.framebuffer_texture_2d)(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, 0, 0);
            (gl.bind_framebuffer)(GL_FRAMEBUFFER, 0);
            (gl.bind_texture)(GL_TEXTURE_2D, 0);
            let err = (gl.get_error)();
            if err != GL_NO_ERROR {
                return Err(anyhow!("RGB→P010: glError={err:#06x}"));
            }
        }
        Ok(())
    }

    unsafe fn pass(
        &self,
        prog: u32,
        target: u32,
        w: u32,
        h: u32,
        uv_texel: Option<(f32, f32)>,
    ) -> Result<()> {
        let gl = &self.gl;
        unsafe {
            (gl.framebuffer_texture_2d)(
                GL_FRAMEBUFFER,
                GL_COLOR_ATTACHMENT0,
                GL_TEXTURE_2D,
                target,
                0,
            );
            let status = (gl.check_framebuffer_status)(GL_FRAMEBUFFER);
            if status != GL_FRAMEBUFFER_COMPLETE {
                return Err(anyhow!("FBO unvollständig (status={status:#06x})"));
            }
            (gl.viewport)(0, 0, w as i32, h as i32);
            (gl.use_program)(prog);
            if let Some((tx, ty)) = uv_texel.filter(|_| self.loc_uv_texel >= 0) {
                (gl.uniform2f)(self.loc_uv_texel, tx, ty);
            }
            (gl.draw_arrays)(GL_TRIANGLES, 0, 3);
        }
        Ok(())
    }
}

impl Drop for RgbToP010 {
    fn drop(&mut self) {
        let gl = &self.gl;
        unsafe {
            for t in [self.y_tex, self.uv_tex] {
                if t != 0 {
                    (gl.delete_textures)(1, &t);
                }
            }
            if self.fbo != 0 {
                (gl.delete_framebuffers)(1, &self.fbo);
            }
            if self.vao != 0 {
                (gl.delete_vertex_arrays)(1, &self.vao);
            }
            for p in [self.prog_y, self.prog_uv] {
                if p != 0 {
                    (gl.delete_program)(p);
                }
            }
        }
    }
}

/// Ziel-Ebene anlegen: NEAREST (wird nur gelesen/geschrieben, nie gefiltert)
/// und ohne Mipmaps, damit CUDA sie als „complete" registrieren kann.
unsafe fn make_plane(gl: &GlProcs, internal: u32, w: u32, h: u32) -> Result<u32> {
    unsafe {
        let mut tex = 0u32;
        (gl.gen_textures)(1, &mut tex);
        (gl.bind_texture)(GL_TEXTURE_2D, tex);
        (gl.tex_parameteri)(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
        (gl.tex_parameteri)(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
        (gl.tex_storage_2d)(GL_TEXTURE_2D, 1, internal, w.max(1) as i32, h.max(1) as i32);
        (gl.bind_texture)(GL_TEXTURE_2D, 0);
        let err = (gl.get_error)();
        if err != GL_NO_ERROR {
            (gl.delete_textures)(1, &tex);
            return Err(anyhow!("Ebene {internal:#06x} anlegen failed (glError={err:#06x})"));
        }
        Ok(tex)
    }
}

/// Setzt [`COMMON`] hinter die `#version`-Zeile des Fragment-Shaders — die
/// muss in GLSL als Erstes stehen, die geteilten Helfer sollen aber trotzdem
/// nur an einer Stelle leben.
fn split_version(src: &str) -> String {
    match src.split_once('\n') {
        Some((version, rest)) => format!("{version}\n{COMMON}{rest}"),
        None => src.to_string(),
    }
}

unsafe fn compile(gl: &GlProcs, kind: u32, src: &str) -> Result<u32> {
    unsafe {
        let sh = (gl.create_shader)(kind);
        if sh == 0 {
            return Err(anyhow!("glCreateShader({kind:#06x}) → 0"));
        }
        let cstr = std::ffi::CString::new(src)?;
        let ptrs = [cstr.as_ptr()];
        (gl.shader_source)(sh, 1, ptrs.as_ptr(), ptr::null());
        (gl.compile_shader)(sh);
        let mut ok = 0i32;
        (gl.get_shaderiv)(sh, GL_COMPILE_STATUS, &mut ok);
        if ok == 0 {
            let log = info_log(|len, written, buf| (gl.get_shader_info_log)(sh, len, written, buf));
            (gl.delete_shader)(sh);
            return Err(anyhow!("Shader-Compile fehlgeschlagen: {log}"));
        }
        Ok(sh)
    }
}

unsafe fn link_program(gl: &GlProcs, vert: &str, frag: &str) -> Result<u32> {
    unsafe {
        let vs = compile(gl, GL_VERTEX_SHADER, vert)?;
        let fs = match compile(gl, GL_FRAGMENT_SHADER, frag) {
            Ok(fs) => fs,
            Err(e) => {
                (gl.delete_shader)(vs);
                return Err(e);
            }
        };
        let prog = (gl.create_program)();
        (gl.attach_shader)(prog, vs);
        (gl.attach_shader)(prog, fs);
        (gl.link_program)(prog);
        // Die Shader-Objekte hängen danach nur noch am Programm.
        (gl.delete_shader)(vs);
        (gl.delete_shader)(fs);
        let mut ok = 0i32;
        (gl.get_programiv)(prog, GL_LINK_STATUS, &mut ok);
        if ok == 0 {
            let log = info_log(|len, written, buf| (gl.get_program_info_log)(prog, len, written, buf));
            (gl.delete_program)(prog);
            return Err(anyhow!("Programm-Link fehlgeschlagen: {log}"));
        }
        Ok(prog)
    }
}

/// GL-Infolog einsammeln — ohne das wäre ein Shader-Fehler ein nackter
/// „0"-Status ohne jeden Hinweis, was daran nicht compiliert.
fn info_log(mut get: impl FnMut(i32, *mut i32, *mut c_char)) -> String {
    let mut buf = vec![0u8; 2048];
    let mut written: i32 = 0;
    get(buf.len() as i32, &mut written, buf.as_mut_ptr() as *mut c_char);
    unsafe { CStr::from_ptr(buf.as_ptr() as *const c_char) }
        .to_string_lossy()
        .trim()
        .to_string()
}
