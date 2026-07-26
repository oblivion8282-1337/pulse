// Farbkonvertierung, Debanding, Dithering und Zoom in einem Durchgang.
//
// Reihenfolge ist nicht beliebig:
//   YUV -> RGB  ->  Deband  ->  (Ausgabe)  ->  Dither
// Debanding muss NACH der Konvertierung laufen, weil die sichtbaren Stufen im
// RGB-Ergebnis liegen, und Dithering ganz zum Schluss, weil es die
// Quantisierung auf das Ausgabeformat aufbricht. Dithert man vorher, glaettet
// der Deband-Schritt das Rauschen wieder weg.

struct Uniforms {
    // Bildausschnitt: xy = Ursprung, zw = Groesse, jeweils 0..1
    crop: vec4<f32>,
    // x = Deband-Staerke, y = Dither an/aus, z = Anzahl Ausgabestufen, w = Zeit
    params: vec4<f32>,
    // x = 10-bit-Quelle, y = voller Wertebereich, z = biplanar (NV12/P010),
    // w = Skalierungsfaktor der Abtastwerte (s. render::sample_scale)
    flags: vec4<f32>,
    // x = Ausgabe erwartet LINEARE Werte (s. render::surface_is_linear),
    // y = BT.601 statt BT.709 (z/w frei)
    output: vec4<f32>,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex_y: texture_2d<f32>;
@group(0) @binding(3) var tex_u: texture_2d<f32>;
@group(0) @binding(4) var tex_v: texture_2d<f32>;

struct VsOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

// Vollbild-Dreieck ohne Vertexpuffer.
@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VsOut {
    var out: VsOut;
    let x = f32((idx << 1u) & 2u);
    let y = f32(idx & 2u);
    let uv = vec2<f32>(x, y);
    out.pos = vec4<f32>(uv * 2.0 - 1.0, 0.0, 1.0);
    // Y-Achse kippen: Texturen liegen oben-links, Clipspace unten-links.
    out.uv = vec2<f32>(uv.x, 1.0 - uv.y);
    return out;
}

// YUV nach RGB. WELCHE Matrix, sagt der Strom (`output.y`) — nicht wir.
//
// Die Annahme "Bildschirm-Streams sind immer BT.709" war falsch: der gemessene
// GSR-Stream meldet am 2026-07-26 `BT470BG`, also BT.601, obwohl er 1440p ist.
// Mit der falschen Matrix bleibt das Bild dekodierbar, wirkt aber entsaettigt
// und verwaschen — ein Fehler, den man leicht dem Encoder anlastet.
// `cb`/`cr` statt `u`/`v`, weil `u` sonst den Uniform-Block verdecken wuerde.
fn yuv_to_rgb(yuv: vec3<f32>, full_range: bool) -> vec3<f32> {
    var y = yuv.x;
    var cb = yuv.y - 0.5;
    var cr = yuv.z - 0.5;
    if (!full_range) {
        // Begrenzter Bereich: Y 16..235, Chroma 16..240 (auf 8-bit bezogen).
        y = (y - 16.0 / 255.0) * (255.0 / 219.0);
        cb = cb * (255.0 / 224.0);
        cr = cr * (255.0 / 224.0);
    }
    if (u.output.y > 0.5) {
        // BT.601 (ITU-R BT.470BG / SMPTE 170M)
        return vec3<f32>(
            y + 1.4020 * cr,
            y - 0.3441 * cb - 0.7141 * cr,
            y + 1.7720 * cb,
        );
    }
    // BT.709
    return vec3<f32>(
        y + 1.5748 * cr,
        y - 0.1873 * cb - 0.4681 * cr,
        y + 1.8556 * cb,
    );
}

fn sample_yuv(uv: vec2<f32>) -> vec3<f32> {
    let luma = textureSampleLevel(tex_y, samp, uv, 0.0).r;
    var cb: f32;
    var cr: f32;
    if (u.flags.z > 0.5) {
        // Biplanar (NV12/P010): Cb und Cr liegen verschraenkt in einer Textur.
        let chroma = textureSampleLevel(tex_u, samp, uv, 0.0);
        cb = chroma.r;
        cr = chroma.g;
    } else {
        cb = textureSampleLevel(tex_u, samp, uv, 0.0).r;
        cr = textureSampleLevel(tex_v, samp, uv, 0.0).r;
    }
    // Skalierung fuer 10-bit-Quellen, die ihre Werte in den unteren Bits
    // ablegen (planar). Bei P010 und 8 bit ist der Faktor 1.
    return vec3<f32>(luma, cb, cr) * u.flags.w;
}

fn hash23(p: vec3<f32>) -> f32 {
    let h = dot(p, vec3<f32>(127.1, 311.7, 74.7));
    return fract(sin(h) * 43758.5453123);
}

// Debanding nach dem Prinzip von libplacebos Deband-Filter:
// vier Nachbarn in pseudozufaelligem Abstand abtasten; liegt die groesste
// Abweichung unter der Schwelle, ist die Flaeche flach und darf gemittelt
// werden. Kanten bleiben dadurch scharf, nur Verlaeufe werden geglaettet.
fn deband(uv: vec2<f32>, center: vec3<f32>, strength: f32) -> vec3<f32> {
    if (strength <= 0.001) {
        return center;
    }
    let dims = vec2<f32>(textureDimensions(tex_y, 0));
    let texel = 1.0 / dims;

    // Radius zufaellig je Pixel, damit kein Muster entsteht.
    let angle = hash23(vec3<f32>(uv * dims, u.params.w)) * 6.2831853;
    let radius = (1.0 + hash23(vec3<f32>(uv * dims, u.params.w + 7.0)) * 3.0);
    let dir = vec2<f32>(cos(angle), sin(angle)) * texel * radius;
    let ortho = vec2<f32>(-dir.y, dir.x);

    let a = yuv_to_rgb(sample_yuv(uv + dir), u.flags.y > 0.5);
    let b = yuv_to_rgb(sample_yuv(uv - dir), u.flags.y > 0.5);
    let c = yuv_to_rgb(sample_yuv(uv + ortho), u.flags.y > 0.5);
    let d = yuv_to_rgb(sample_yuv(uv - ortho), u.flags.y > 0.5);

    let avg = (a + b + c + d) * 0.25;
    let deviation = max(max(abs(a - center), abs(b - center)), max(abs(c - center), abs(d - center)));

    // Schwelle in der Groessenordnung einer Quantisierungsstufe der Quelle.
    let step_size = select(1.0 / 255.0, 1.0 / 1023.0, u.flags.x > 0.5);
    let threshold = step_size * 2.0 * (0.5 + strength * 2.0);

    let flat = step(deviation, vec3<f32>(threshold));
    return mix(center, avg, flat * strength);
}

// sRGB-EOTF: gamma-kodierte Werte in lineares Licht.
//
// Nur fuer Oberflaechen, die lineares Licht erwarten — auf dieser Maschine
// `Rgba16Float`. Ohne die Umrechnung wendet der Compositor die sRGB-Kurve ein
// zweites Mal an, die Mitten steigen und der Kontrast faellt: das Bild wirkt
// flau. Am 2026-07-26 im Zwei-Fenster-Vergleich belegt.
fn srgb_to_linear(c: vec3<f32>) -> vec3<f32> {
    let low = c / 12.92;
    let high = pow((c + 0.055) / 1.055, vec3<f32>(2.4));
    return select(high, low, c <= vec3<f32>(0.04045));
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    // Zoom/Pan: aus dem dekodierten Vollbild ausschneiden, nicht aus einem
    // bereits herunterskalierten Fensterinhalt. Das ist der Unterschied zum
    // CSS-Zoom im Browser.
    let uv = u.crop.xy + in.uv * u.crop.zw;

    let full_range = u.flags.y > 0.5;
    var rgb = yuv_to_rgb(sample_yuv(uv), full_range);
    rgb = deband(uv, rgb, u.params.x);

    if (u.params.y > 0.5) {
        // Dithering: Rauschen unterhalb einer Ausgabestufe, damit die
        // Quantisierung keine harten Kanten erzeugt. Bewusst noch im
        // gamma-kodierten Raum — dort liegen die sichtbaren Stufen, und dort
        // entspricht eine Ausgabestufe tatsaechlich `1/levels`.
        let levels = max(u.params.z, 2.0);
        let n = hash23(vec3<f32>(in.pos.xy, u.params.w)) - 0.5;
        rgb = rgb + n / levels;
    }

    rgb = clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0));
    // Ganz zum Schluss: alles davor (Matrix, Deband, Dither) ist im
    // gamma-kodierten Raum gedacht, dort liegen die sichtbaren Stufen.
    if (u.output.x > 0.5) {
        rgb = srgb_to_linear(rgb);
    }
    return vec4<f32>(rgb, 1.0);
}
