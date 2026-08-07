// Der Fingerabdruck der Luma-Ebene, gerechnet auf der GPU.
//
// ZWILLING von `einfrieren::gpuabdruck::luma_abdruck` — dort steht die
// Begruendung (warum eine Summe ueber GEMISCHTE Werte und nicht ueber die
// Helligkeiten, warum die Position eingeht, warum zwei Haelften). Wer hier
// etwas aendert, aendert es dort mit; `render::abdruck` prueft im Test, dass
// beide auf demselben Bild denselben Wert liefern.

struct Masse {
    breite: u32,
    hoehe: u32,
    // Womit der normierte Texelwert auf die ganze Zahl zurueckgerechnet wird:
    // 255 bei NV12 (R8Unorm), 65535 bei P010 (R16Unorm). Als Zahl statt als
    // zwei Shader-Fassungen — der Unterschied ist genau dieser Faktor.
    skala: f32,
    _fuellung: u32,
};

@group(0) @binding(0) var luma: texture_2d<f32>;
@group(0) @binding(1) var<uniform> masse: Masse;
// Zwei Summen, nicht eine: siehe Zwilling.
@group(0) @binding(2) var<storage, read_write> summe: array<atomic<u32>, 2>;

// Murmur3 fmix32 — eine Bijektion. Dass sie umkehrbar ist, ist der Grund,
// weshalb kein veraenderter Bildpunkt denselben Beitrag liefern kann.
fn mische(x: u32) -> u32 {
    var h = x;
    h = h ^ (h >> 16u);
    h = h * 0x85ebca6bu;
    h = h ^ (h >> 13u);
    h = h * 0xc2b2ae35u;
    h = h ^ (h >> 16u);
    return h;
}

const ZWEITER: u32 = 0x5bd1e995u;

// Eine Kachel je Arbeitsgruppe. 8x8 = 64 Aufrufe, also eine volle Wellenfront
// auf AMD (Wave64) und zwei auf NVIDIA — beides ohne Rest.
const KANTE: u32 = 8u;
const AUFRUFE: u32 = 64u;

// Zwischenablage fuer die Reduktion innerhalb der Gruppe. Ohne sie braeuchte
// jeder Bildpunkt einen eigenen atomaren Zugriff; bei 1080p waeren das zwei
// Millionen statt zweiunddreissigtausend.
var<workgroup> teil_a: array<u32, AUFRUFE>;
var<workgroup> teil_b: array<u32, AUFRUFE>;

@compute @workgroup_size(8, 8, 1)
fn abdruck(
    @builtin(global_invocation_id) gid: vec3<u32>,
    @builtin(local_invocation_index) lid: u32,
) {
    var a: u32 = 0u;
    var b: u32 = 0u;
    // Die Auffuellung der Textur bleibt draussen: der Decoder rundet auf (bei
    // AV1 auf Vielfache von 128), und was dort steht, ist nicht unser Bild.
    if (gid.x < masse.breite && gid.y < masse.hoehe) {
        let roh = textureLoad(luma, vec2<i32>(i32(gid.x), i32(gid.y)), 0).r;
        let wert = u32(round(roh * masse.skala));
        let index = gid.y * masse.breite + gid.x;
        a = mische(mische(index) ^ wert);
        b = mische(mische(index ^ ZWEITER) ^ wert);
    }
    teil_a[lid] = a;
    teil_b[lid] = b;

    // Baumreduktion: sechs Schritte statt vierundsechzig. Die Summe ist
    // kommutativ, die Reihenfolge also gleichgueltig — genau deshalb ist sie
    // hier ueberhaupt zulaessig.
    var schritt: u32 = AUFRUFE / 2u;
    loop {
        workgroupBarrier();
        if (lid < schritt) {
            teil_a[lid] = teil_a[lid] + teil_a[lid + schritt];
            teil_b[lid] = teil_b[lid] + teil_b[lid + schritt];
        }
        schritt = schritt / 2u;
        if (schritt == 0u) {
            break;
        }
    }
    workgroupBarrier();
    if (lid == 0u) {
        atomicAdd(&summe[0], teil_a[0]);
        atomicAdd(&summe[1], teil_b[0]);
    }
}
