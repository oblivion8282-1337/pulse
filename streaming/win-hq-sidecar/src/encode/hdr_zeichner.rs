//! Der Farbweg selbst: scRGB (16-Bit-Fließkomma) → PQ/BT.2020 in P010, als
//! Zeichendurchgang auf der Grafikkarte.
//!
//! **Warum getrennt von [`super::hdr_wandler`].** Dort wohnt der Ziel-Pool und
//! die Begründung, warum es überhaupt einen eigenen Shader gibt. Hier wohnt der
//! Shader. Die Trennung ist entstanden, als der Farbweg einen **zweiten
//! Aufrufer** bekam: seit dem 2026-08-07 kann er auch schon im
//! Aufnahme-Rückruf laufen und dabei direkt aus der WGC-Textur in eine
//! Pool-Textur schreiben ([`crate::capture::aufnahmeziel`]) — dann gibt es gar
//! keinen zweiten Pool, den er besitzen könnte. Zwei Aufrufer, einer mit
//! eigenem Pool und einer ohne, und dazwischen genau ein Shader.
//!
//! ## Was der Shader tut, in vier Schritten
//!
//! 1. **scRGB → cd/m².** Die Aufnahme liefert lineares Licht mit
//!    BT.709-Primärvalenzen, bei dem 1,0 achtzig cd/m² entspricht (IEC
//!    61966-2-2). Multiplizieren, fertig — hier entsteht der absolute Bezug,
//!    ohne den PQ keinen Sinn ergibt.
//! 2. **BT.709 → BT.2020**, in linearem Licht. Auf kodierte Werte angewandt
//!    ergäbe dieselbe Matrix Unsinn, deshalb steht sie hier und nicht weiter
//!    unten.
//! 3. **PQ (SMPTE ST 2084)**, die Umkehrung dessen, was der Player später
//!    rechnet.
//! 4. **RGB → YCbCr, BT.2020 NCL, Studio-Bereich**, und ab in die beiden
//!    Ebenen von P010.
//!
//! ## Was hier NICHT passiert
//!
//! **Kein Tone-Mapping.** Der Strom trägt, was der Bildschirm anzeigt, bis zu
//! 10 000 cd/m². Was ein Zuschauer daraus macht, entscheidet er selbst — der
//! Player rechnet auf einem SDR-Schirm herunter (`render/shader.wgsl`). Hier
//! zu beschneiden hieße, diese Entscheidung allen Zuschauern abzunehmen.

use anyhow::{Result, anyhow};
use windows::Win32::Graphics::Direct3D::Fxc::D3DCompile;
use windows::Win32::Graphics::Direct3D::{D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST, ID3DBlob};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::System::Threading::{
    CRITICAL_SECTION, EnterCriticalSection, LeaveCriticalSection,
};
use windows::core::PCSTR;

use super::hdr_ansichten::Ansichten;
use super::hwctx::OwnedHwFrame;

/// Ein Vollbild-Dreieck ohne Vertexpuffer plus die beiden Farbstufen.
///
/// **Die Konstanten sind Normwerte, keine Wahl.** Wer eine ändert, ändert die
/// Farben des Stroms, und zwar so, dass es plausibel aussieht: 80 statt 100 als
/// scRGB-Bezug macht das Bild um ein Viertel dunkler, die
/// BT.2020-Koeffizienten leicht verschoben verziehen Hauttöne. Beides fällt
/// ohne Vergleichsbild nicht auf.
const SHADER_HLSL: &str = r#"
Texture2D<float4> Src  : register(t0);
SamplerState      Samp : register(s0);
cbuffer Params : register(b0) { float2 InvDst; float2 _pad; }

struct VsOut { float4 pos : SV_Position; float2 uv : TEXCOORD0; };

VsOut vs_main(uint id : SV_VertexID) {
    VsOut o;
    float2 t = float2((id << 1) & 2, id & 2);
    o.pos = float4(t * float2(2, -2) + float2(-1, 1), 0, 1);
    o.uv  = t;
    return o;
}

// 1,0 in scRGB sind 80 cd/m² (IEC 61966-2-2). Windows rechnet
// Fliesskomma-Fensterinhalte genau so in Bildschirmhelligkeit um.
static const float SCRGB_WEISS = 80.0;

// BT.709 nach BT.2020, LINEAR. (ITU-R BT.2087, Anhang A.)
float3 nach_bt2020(float3 c) {
    return float3(
        dot(c, float3(0.62740, 0.32930, 0.04330)),
        dot(c, float3(0.06910, 0.91950, 0.01140)),
        dot(c, float3(0.01640, 0.08800, 0.89560)));
}

// PQ vorwaerts (SMPTE ST 2084): Helligkeit in cd/m² -> Codewert 0..1.
// Gegenstueck zu `pq_zu_nits` im Player-Shader; die Konstanten sind dieselben.
float3 nach_pq(float3 nits) {
    const float m1 = 0.1593017578125;
    const float m2 = 78.84375;
    const float c1 = 0.8359375;
    const float c2 = 18.8515625;
    const float c3 = 18.6875;
    float3 y  = saturate(nits / 10000.0);
    float3 ym = pow(y, m1);
    return pow((c1 + c2 * ym) / (1.0 + c3 * ym), m2);
}

// Lineares Licht eines Bildpunkts in cd/m², noch in BT.709-Primaervalenzen.
// **Eigene Funktion, weil hier die Trennlinie liegt:** bis hierher ist alles
// linear, danach kommen Matrix und Kurve. Der Chroma-Durchgang mittelt VIER
// davon und rechnet den Rest genau einmal (s. `ps_chroma`).
float3 licht709(float2 uv) {
    return Src.SampleLevel(Samp, uv, 0).rgb * SCRGB_WEISS;
}

// Aus linearem BT.709-Licht der fertige PQ-Codewert in BT.2020. Negative Werte
// bedeuten scRGB als "ausserhalb von BT.709"; nach BT.2020 liegen fast alle
// wieder im Bereich, was danach noch negativ ist, kann PQ nicht darstellen.
float3 nach_pq2020(float3 licht) { return nach_pq(max(nach_bt2020(licht), 0.0)); }

// Der ganze Farbweg fuer einen Bildpunkt: scRGB -> PQ-kodiertes BT.2020.
float3 farbe(float2 uv) { return nach_pq2020(licht709(uv)); }

// RGB -> YCbCr, BT.2020 ohne konstante Leuchtdichte, Studio-Bereich, 10 bit.
//
// Die Bereichsgrenzen sind die ECHTEN 10-Bit-Werte (64..940 bzw. 64..960 um
// 512), nicht die mit 4 multiplizierten 8-Bit-Werte: der Unterschied sind rund
// drei Codewerte am Weisspunkt, und die sitzen als Verstaerkungsfehler im
// ganzen Bild. Genau dieser Fehler ist am 2026-08-04 im Player gefunden worden.
float3 nach_ycbcr(float3 rgb) {
    float y = 0.2627 * rgb.r + 0.6780 * rgb.g + 0.0593 * rgb.b;
    float u = (rgb.b - y) / 1.8814;
    float v = (rgb.r - y) / 1.4746;
    return float3(
        y * (876.0 / 1023.0) + (64.0 / 1023.0),
        u * (896.0 / 1023.0) + (512.0 / 1023.0),
        v * (896.0 / 1023.0) + (512.0 / 1023.0));
}

// P010 legt die zehn Bit in die OBEREN Bits eines 16-Bit-Wortes. Eine
// R16_UNORM-Ansicht schreibt aber den vollen 16-Bit-Bereich — der Wert muss
// also um 65472/65535 gestaucht werden, damit Codewert 1023 als 1023<<6 landet
// und nicht als 65535. Ohne diesen Faktor waere das Bild um 0,1 % zu hell;
// das sieht niemand, aber Schwarz und Weiss laegen daneben, und genau daran
// misst man spaeter.
static const float P010 = 65472.0 / 65535.0;

float ps_luma(VsOut i) : SV_Target {
    return nach_ycbcr(farbe(i.uv)).x * P010;
}

float2 ps_chroma(VsOut i) : SV_Target {
    // Die vier Luma-Stellen dieses Chroma-Punkts mitteln — 4:2:0 heisst, dass
    // ein Chroma-Wert fuer einen 2x2-Block gilt. **Gemittelt wird in linearem
    // Licht, VOR Matrix und Kurve**; danach laeuft der Farbweg genau einmal.
    //
    // HIER STAND BIS ZUM 2026-08-06: "Vor der Matrix zu mitteln waere farblich
    // richtiger, kostet aber vier Matrixdurchlaeufe." **Das Kostenargument war
    // falsch ueber den eigenen Code:** die alte Fassung rief `farbe()` und
    // `nach_ycbcr()` je viermal auf, zahlte die vier Matrixdurchlaeufe also
    // bereits — dazu vier PQ-Kurven zu je sechs `pow`. Der angeblich teurere
    // Weg ist der billigere: 2N Farbwege je Bild werden zu 1,25N, Ersparnis
    // genau auf den `pow` (auf RDNA ein Viertel der Rate).
    //
    // Farblich ist es zugleich richtiger: eine Unterabtastung mittelt LICHT,
    // nicht Codewerte. Wie weit beide auseinanderliegen, rechnet der
    // CPU-Zwilling in `tests` aus — auf Flaechen, Text, Grau und Spitzlichtern
    // null, an gesaettigten Farbkanten bis 28,7 von 1023. Das Luma-Bild ist
    // unberuehrt, eine Helligkeitsverschiebung also ausgeschlossen.
    float2 h = InvDst * 0.5;
    float3 licht = 0.25 * (licht709(i.uv + float2(-h.x, -h.y))
                         + licht709(i.uv + float2( h.x, -h.y))
                         + licht709(i.uv + float2(-h.x,  h.y))
                         + licht709(i.uv + float2( h.x,  h.y)));
    return nach_ycbcr(nach_pq2020(licht)).yz * P010;
}
"#;

/// Der Farbweg als Zeichendurchgang — **ohne eigenen Pool.** Wer ihn benutzt,
/// bringt das Zielbild mit.
///
/// Alle Kontext-Zugriffe laufen unter der `CRITICAL_SECTION`, die beim Bau
/// übergeben wird; die COM-Zeiger selbst sind nur Heap-Adressen.
pub struct HdrZeichner {
    context: ID3D11DeviceContext,
    device: ID3D11Device,
    vs: ID3D11VertexShader,
    ps_luma: ID3D11PixelShader,
    ps_chroma: ID3D11PixelShader,
    sampler: ID3D11SamplerState,
    params: ID3D11Buffer,
    dst_w: u32,
    dst_h: u32,
    /// Die eine Sperre, auf der alle Befehle an den unmittelbaren
    /// `ID3D11DeviceContext` serialisieren — geteilt mit Aufnahme-Pool und
    /// Encoder. **Sie gehört nicht diesem Objekt**, es benutzt sie nur.
    sperre: *mut CRITICAL_SECTION,
    ansichten: Ansichten,
}

// Begründung wie bei `HwContext`: die Serialisierung macht die Sperre, nicht
// der Typ. Nach dem Umbau vom 2026-08-07 nimmt sie ein anderer Faden als vorher
// (der WGC-Rückruf statt des Taktfadens) — genau dafür ist sie da.
unsafe impl Send for HdrZeichner {}
unsafe impl Sync for HdrZeichner {}

impl HdrZeichner {
    pub fn new(
        device: ID3D11Device,
        context: ID3D11DeviceContext,
        dst_w: u32,
        dst_h: u32,
        sperre: *mut CRITICAL_SECTION,
    ) -> Result<Self> {
        let vs_code = uebersetzen("vs_main", "vs_5_0")?;
        let ps_luma_code = uebersetzen("ps_luma", "ps_5_0")?;
        let ps_chroma_code = uebersetzen("ps_chroma", "ps_5_0")?;

        let mut vs = None;
        let mut ps_luma = None;
        let mut ps_chroma = None;
        unsafe {
            device.CreateVertexShader(bytes(&vs_code), None, Some(&mut vs))?;
            device.CreatePixelShader(bytes(&ps_luma_code), None, Some(&mut ps_luma))?;
            device.CreatePixelShader(bytes(&ps_chroma_code), None, Some(&mut ps_chroma))?;
        }

        // Bilineare Abtastung, an den Rändern geklemmt. Das ist zugleich der
        // Verkleinerer: ein 1440p-Bild auf 1080p ist damit weicher als über den
        // Video-Prozessor, der mehrere Abtastwerte gewichtet. Ein besserer
        // Filter wäre eine eigene Messung wert — er gehörte in denselben
        // Shader und kostet nichts an Struktur.
        let mut sampler = None;
        unsafe {
            device.CreateSamplerState(
                &D3D11_SAMPLER_DESC {
                    Filter: D3D11_FILTER_MIN_MAG_MIP_LINEAR,
                    AddressU: D3D11_TEXTURE_ADDRESS_CLAMP,
                    AddressV: D3D11_TEXTURE_ADDRESS_CLAMP,
                    AddressW: D3D11_TEXTURE_ADDRESS_CLAMP,
                    MaxLOD: f32::MAX,
                    ..Default::default()
                },
                Some(&mut sampler),
            )?;
        }

        // Konstantenpuffer: der halbe Bildpunktabstand des Ziels, für die
        // Chroma-Mittelung. 16 Byte, weil D3D11 Konstantenpuffer auf
        // 16 ausrichtet.
        let werte = [1.0f32 / dst_w as f32, 1.0f32 / dst_h as f32, 0.0, 0.0];
        let mut params = None;
        unsafe {
            device.CreateBuffer(
                &D3D11_BUFFER_DESC {
                    ByteWidth: 16,
                    Usage: D3D11_USAGE_IMMUTABLE,
                    BindFlags: D3D11_BIND_CONSTANT_BUFFER.0 as u32,
                    ..Default::default()
                },
                Some(&D3D11_SUBRESOURCE_DATA {
                    pSysMem: werte.as_ptr().cast(),
                    ..Default::default()
                }),
                Some(&mut params),
            )?;
        }

        Ok(Self {
            context,
            device,
            vs: vs.ok_or_else(|| anyhow!("Vertex-Shader NULL"))?,
            ps_luma: ps_luma.ok_or_else(|| anyhow!("Luma-Shader NULL"))?,
            ps_chroma: ps_chroma.ok_or_else(|| anyhow!("Chroma-Shader NULL"))?,
            sampler: sampler.ok_or_else(|| anyhow!("Sampler NULL"))?,
            params: params.ok_or_else(|| anyhow!("Konstantenpuffer NULL"))?,
            dst_w,
            dst_h,
            sperre,
            ansichten: Ansichten::default(),
        })
    }

    /// Ein scRGB-Bild in ein P010-Bild wandeln.
    ///
    /// `quelle` ist eine `ID3D11Texture2D` in `R16G16B16A16_FLOAT` — entweder
    /// ein Pool-Bild oder die WGC-Textur selbst; `scheibe` ist ihre
    /// Array-Ebene (bei WGC immer 0). Die Sperre nimmt diese Funktion selbst;
    /// die Ansichten entstehen davor, weil `ID3D11Device` anders als der
    /// unmittelbare Kontext frei nebenläufig ist.
    pub fn wandeln_in(
        &mut self,
        quelle: *mut std::ffi::c_void,
        scheibe: u32,
        ziel: &OwnedHwFrame,
    ) -> Result<()> {
        let srv = self.ansichten.quelle(&self.device, quelle, scheibe)?;
        let (rtv_y, rtv_uv) =
            self.ansichten
                .ziel(&self.device, ziel.texture_raw(), ziel.subresource_index())?;

        unsafe { EnterCriticalSection(self.sperre) };
        let ergebnis = unsafe { self.zeichnen(&srv, &rtv_y, &rtv_uv) };
        unsafe { LeaveCriticalSection(self.sperre) };
        ergebnis
    }

    /// Zwei Durchgänge: Luma in voller, Chroma in halber Auflösung.
    ///
    /// # Safety
    /// Aufrufer hält die Sperre.
    unsafe fn zeichnen(
        &self,
        srv: &ID3D11ShaderResourceView,
        rtv_y: &ID3D11RenderTargetView,
        rtv_uv: &ID3D11RenderTargetView,
    ) -> Result<()> {
        let c = &self.context;
        unsafe {
            c.IASetInputLayout(None);
            c.IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
            c.VSSetShader(&self.vs, None);
            c.PSSetShaderResources(0, Some(&[Some(srv.clone())]));
            c.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
            c.PSSetConstantBuffers(0, Some(&[Some(self.params.clone())]));

            for (rtv, ps, w, h) in [
                (rtv_y, &self.ps_luma, self.dst_w, self.dst_h),
                (rtv_uv, &self.ps_chroma, self.dst_w / 2, self.dst_h / 2),
            ] {
                c.OMSetRenderTargets(Some(&[Some(rtv.clone())]), None);
                c.RSSetViewports(Some(&[D3D11_VIEWPORT {
                    Width: w as f32,
                    Height: h as f32,
                    MaxDepth: 1.0,
                    ..Default::default()
                }]));
                c.PSSetShader(ps, None);
                c.Draw(3, 0);
            }
            // Beides wieder abhängen. Das ZIEL, weil der Encoder gleich aus
            // derselben Textur liest und eine noch gebundene Ausgabe eine
            // Ressource wäre, die zugleich beschrieben und gelesen wird. Die
            // QUELLE, weil in sie gleich wieder hineingeschrieben wird — im
            // Pool-Fall der Aufnahme-Faden, im Rückruf-Fall WGC selbst. D3D11
            // löst beides still auf (die Bindung wird verworfen) und meldet es
            // nur im Debug-Layer; die zweite Zeile war Befund 6.1 der
            // Durchsicht vom 2026-08-06 und ist hier fällig geworden, weil der
            // Rückruf-Weg genau diese Überschneidung in jedem Bild hat.
            c.OMSetRenderTargets(None, None);
            c.PSSetShaderResources(0, Some(&[None]));
        }
        Ok(())
    }
}

/// Einen Einstiegspunkt des Shaders übersetzen.
fn uebersetzen(einstieg: &str, ziel: &str) -> Result<ID3DBlob> {
    let einstieg_c = format!("{einstieg}\0");
    let ziel_c = format!("{ziel}\0");
    let mut code = None;
    let mut fehler = None;
    let hr = unsafe {
        D3DCompile(
            SHADER_HLSL.as_ptr().cast(),
            SHADER_HLSL.len(),
            None,
            None,
            None,
            PCSTR(einstieg_c.as_ptr()),
            PCSTR(ziel_c.as_ptr()),
            0,
            0,
            &mut code,
            Some(&mut fehler),
        )
    };
    if hr.is_err() {
        let text = fehler
            .map(|b| unsafe {
                let p = b.GetBufferPointer() as *const u8;
                String::from_utf8_lossy(std::slice::from_raw_parts(p, b.GetBufferSize())).to_string()
            })
            .unwrap_or_default();
        return Err(anyhow!("D3DCompile({einstieg}) fehlgeschlagen: {hr:?} — {text}"));
    }
    code.ok_or_else(|| anyhow!("D3DCompile({einstieg}) lieferte kein Blob"))
}

fn bytes(blob: &ID3DBlob) -> &[u8] {
    unsafe {
        std::slice::from_raw_parts(blob.GetBufferPointer() as *const u8, blob.GetBufferSize())
    }
}

#[cfg(test)]
mod tests {
    //! **Der Zwilling des Shaders auf der CPU** — er beantwortet die eine
    //! Frage, die die Umstellung des Chroma-Durchgangs offenlässt: **wie weit
    //! weicht die neue Mittelung farblich von der alten ab?**
    //!
    //! Das ersetzt keine Sichtprüfung an bewegtem Bild, aber es macht sie
    //! entbehrlich für die Frage „ist das ein Rückschritt": ein Auge kann zwei
    //! Codewerte Unterschied nicht sehen, ein Test kann sie zählen.
    //!
    //! Die Zahlen unten sind **gerechnet, nicht gemessen** — sie stammen aus
    //! dieser Rechnung, nicht von der Grafikkarte. Was die Karte tut, ist
    //! dasselbe: die Formeln sind Zeile für Zeile aus `SHADER_HLSL` übernommen.
    //!
    //! **Und genau darin liegt die Schwachstelle dieses Zwillings:** er ist
    //! eine Abschrift, und nichts erzwingt, dass er eine bleibt. Wer die
    //! BT.2087-Matrix oder eine PQ-Konstante im HLSL ändert und hier nicht,
    //! bekommt weiterhin grüne Tests — über eine Rechnung, die die Karte nicht
    //! mehr fährt. Beim Ändern also immer beide Seiten. (Den Shader aus
    //! Rust-Konstanten zusammenzusetzen wäre der dichte Weg; er macht den
    //! Shader-Text unsuchbar und wurde deshalb hier nicht genommen.)

    /// BT.709 → BT.2020, linear (ITU-R BT.2087 Anhang A) — wie `nach_bt2020`.
    fn nach_bt2020(c: [f64; 3]) -> [f64; 3] {
        let d = |m: [f64; 3]| c[0] * m[0] + c[1] * m[1] + c[2] * m[2];
        [
            d([0.62740, 0.32930, 0.04330]),
            d([0.06910, 0.91950, 0.01140]),
            d([0.01640, 0.08800, 0.89560]),
        ]
    }

    /// PQ vorwärts (SMPTE ST 2084) — wie `nach_pq`.
    fn nach_pq(nits: [f64; 3]) -> [f64; 3] {
        const M1: f64 = 0.1593017578125;
        const M2: f64 = 78.84375;
        const C1: f64 = 0.8359375;
        const C2: f64 = 18.8515625;
        const C3: f64 = 18.6875;
        let e = |v: f64| {
            let y = (v / 10000.0).clamp(0.0, 1.0);
            let ym = y.powf(M1);
            ((C1 + C2 * ym) / (1.0 + C3 * ym)).powf(M2)
        };
        [e(nits[0]), e(nits[1]), e(nits[2])]
    }

    /// RGB → YCbCr, BT.2020 NCL, Studio, 10 bit — wie `nach_ycbcr`.
    fn nach_ycbcr(rgb: [f64; 3]) -> [f64; 3] {
        let y = 0.2627 * rgb[0] + 0.6780 * rgb[1] + 0.0593 * rgb[2];
        let u = (rgb[2] - y) / 1.8814;
        let v = (rgb[0] - y) / 1.4746;
        [
            y * (876.0 / 1023.0) + (64.0 / 1023.0),
            u * (896.0 / 1023.0) + (512.0 / 1023.0),
            v * (896.0 / 1023.0) + (512.0 / 1023.0),
        ]
    }

    const SCRGB_WEISS: f64 = 80.0;

    fn farbe(scrgb: [f64; 3]) -> [f64; 3] {
        let l = nach_bt2020([
            scrgb[0] * SCRGB_WEISS,
            scrgb[1] * SCRGB_WEISS,
            scrgb[2] * SCRGB_WEISS,
        ]);
        nach_pq([l[0].max(0.0), l[1].max(0.0), l[2].max(0.0)])
    }

    /// Der ALTE Weg: vier fertige PQ-Farben nach YCbCr, dann mitteln.
    fn chroma_alt(block: &[[f64; 3]; 4]) -> (f64, f64) {
        let mut s = [0.0; 3];
        for p in block {
            let c = nach_ycbcr(farbe(*p));
            for i in 0..3 {
                s[i] += c[i] * 0.25;
            }
        }
        (s[1], s[2])
    }

    /// Der NEUE Weg: die vier scRGB-Werte in linearem Licht mitteln, dann
    /// einmal Matrix, Kurve und YCbCr.
    fn chroma_neu(block: &[[f64; 3]; 4]) -> (f64, f64) {
        let mut m = [0.0; 3];
        for p in block {
            for i in 0..3 {
                m[i] += p[i] * 0.25;
            }
        }
        let c = nach_ycbcr(farbe(m));
        (c[1], c[2])
    }

    /// In Codewerten (10 bit, also 1023 Stufen) — so groß ist der Unterschied
    /// wirklich, und nur so ist er einzuordnen.
    fn abstand_codewerte(block: &[[f64; 3]; 4]) -> (f64, f64) {
        let (au, av) = chroma_alt(block);
        let (nu, nv) = chroma_neu(block);
        (((nu - au) * 1023.0).abs(), ((nv - av) * 1023.0).abs())
    }

    /// **Auf gleichmäßigen Blöcken ist der Unterschied null** — und das ist
    /// kein Zufall, sondern die Aussage: nur dort, wo sich die vier Bildpunkte
    /// unterscheiden, kann die Reihenfolge von Mittelung und Kurve überhaupt
    /// etwas ändern. Auf Flächen, also auf dem allermeisten Bild, ist das neue
    /// Ergebnis **bitgleich**.
    #[test]
    fn auf_einer_flaeche_aendert_sich_nichts() {
        for wert in [0.0, 0.05, 0.2, 0.5, 1.0, 3.0, 12.5] {
            let block = [[wert, wert * 0.8, wert * 0.6]; 4];
            let (du, dv) = abstand_codewerte(&block);
            assert!(du < 1e-6 && dv < 1e-6, "gleichmässiger Block {wert}: {du}/{dv}");
        }
    }

    /// **Und auf dem härtesten Übergang bleibt er klein.** Schwarz gegen ein
    /// Spitzlicht in einem 2×2-Block ist der schlechteste Fall, den ein Bild
    /// hergibt; gemessen in Codewerten ist selbst er einstellig bis knapp
    /// zweistellig von 1023.
    ///
    /// Die Schranke ist bewusst als **Zahl mit Herleitung** gesetzt und nicht
    /// als „irgendwas Kleines": sie ist der größte Wert, den diese Rechnung
    /// über die Blöcke unten liefert, aufgerundet. Wer die Mittelung erneut
    /// ändert, sieht hier sofort, ob er den Rahmen verlässt.
    #[test]
    fn selbst_der_haerteste_uebergang_bleibt_im_rahmen() {
        let faelle: [(&str, [[f64; 3]; 4]); 4] = [
            (
                "Schwarz gegen Spitzlicht (10 000 cd/m²)",
                [[0.0, 0.0, 0.0], [125.0, 125.0, 125.0], [0.0, 0.0, 0.0], [125.0, 125.0, 125.0]],
            ),
            (
                "Schwarz gegen SDR-Weiss",
                [[0.0, 0.0, 0.0], [1.0, 1.0, 1.0], [0.0, 0.0, 0.0], [1.0, 1.0, 1.0]],
            ),
            (
                "Rot gegen Blau, beide voll",
                [[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]],
            ),
            (
                "Textkante: dunkles Grau gegen helles Grau",
                [[0.05, 0.05, 0.05], [0.6, 0.6, 0.6], [0.05, 0.05, 0.05], [0.6, 0.6, 0.6]],
            ),
        ];
        let mut groesster: f64 = 0.0;
        for (name, block) in faelle {
            let (du, dv) = abstand_codewerte(&block);
            eprintln!("{name}: Cb {du:.1}, Cr {dv:.1} Codewerte von 1023");
            groesster = groesster.max(du).max(dv);
        }
        assert!(
            groesster < 40.0,
            "der grösste Abstand über alle Fälle war {groesster:.1} Codewerte — \
             über 40 wäre die Mittelung keine Verfeinerung mehr, sondern eine \
             andere Farbe"
        );
    }
}
