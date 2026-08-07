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
    // y = Matrix-Kennzahl (0 = BT.709, 1 = BT.601, 2 = BT.2020 NCL),
    // z = 8-bit-aequivalente Codewerte je normierter Einheit
    // (s. render::farbe::scales und `yuv_to_rgb`), w frei
    output: vec4<f32>,
    // x = Quelle ist PQ (sonst SDR-artig), y = Ausgabe ist ein HDR-Fenster
    // (scRGB), z = Spitzenhelligkeit des Inhalts in cd/m², w frei
    hdr: vec4<f32>,
};

// Diffusweiss in cd/m². Das ist die Helligkeit, auf der in einem HDR-Bild eine
// weisse Flaeche liegt, die man in SDR einfach „weiss" nennen wuerde — Papier,
// eine Textseite, ein Fenster-Hintergrund. Alles darueber sind Spitzlichter.
//
// **203 ist keine gegriffene Zahl**, sondern der Referenzwert aus ITU-R BT.2408.
// Er entscheidet beim Herunterrechnen darueber, wie hell das Bild insgesamt
// wirkt: nimmt man stattdessen 100, wird alles zu hell und die Spitzlichter
// fressen aus; nimmt man 300, wirkt das Bild duester.
const DIFFUSWEISS: f32 = 203.0;

// Der Bezugswert von scRGB: 1,0 entspricht 80 cd/m². Auch das ist keine Wahl,
// sondern die Festlegung des Farbraums (IEC 61966-2-2) — Windows rechnet
// Fliesskomma-Fensterinhalte genau so in Bildschirmhelligkeit um. Eine andere
// Zahl hier waere ein Bild, das durchgehend zu hell oder zu dunkel ist.
const SCRGB_WEISS: f32 = 80.0;

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
//
// **Der Nullpunkt des Chromas ist NICHT 0.5** — und die Grenzen des begrenzten
// Wertebereichs sind es auch nicht ohne Weiteres. Der Abtastwert ist ein
// Codewert geteilt durch seinen Hoechstwert; neutrales Chroma ist Code 128 von
// 255 (= 0.50196), in 10 bit Code 512 von 1023 (= 0.50049). Der frueher hier
// stehende Abzug von 0.5 lag also immer um einen HALBEN Chroma-Code daneben.
// Auf Grau hiess das (BT.709, gemessen 2026-08-04 am zurueckgelesenen
// Bildpunkt): R +0,9, G -0,37, B +1,06 Stufen — Grau mit leichtem Blaustich,
// ueber die ganze Flaeche, in jedem Bild.
//
// `u.output.z` traegt deshalb den Massstab: wieviele 8-BIT-AEQUIVALENTE
// Codewerte auf normiert 1.0 gehen (255 bei 8-bit-Texturen, 255,75 bei
// planarem 10 bit, 255,996 bei P010 — s. `render::code_scale`). Damit stimmen
// dieselben Konstanten 16/219/128/224 fuer JEDE Bittiefe, statt fuer 8 bit zu
// gelten und bei 10 bit knapp danebenzuliegen (dort fehlten am Weisspunkt
// zuletzt 3,2 von 1023 Stufen).
fn yuv_to_rgb(yuv: vec3<f32>, full_range: bool) -> vec3<f32> {
    let k = u.output.z;
    var y = yuv.x;
    var cb = yuv.y - 128.0 / k;
    var cr = yuv.z - 128.0 / k;
    if (!full_range) {
        // Begrenzter Bereich: Y 16..235, Chroma 16..240 (auf 8-bit bezogen).
        y = (y * k - 16.0) / 219.0;
        cb = cb * k / 224.0;
        cr = cr * k / 224.0;
    }
    if (u.output.y > 1.5) {
        // BT.2020 ohne konstante Leuchtdichte — die Matrix jedes HDR10-Stroms.
        // Aus Kr = 0,2627 und Kb = 0,0593 (BT.709 hat 0,2126 / 0,0722). Der
        // Unterschied sieht klein aus und ist es nicht: mit der BT.709-Matrix
        // gelesen wandern gesaettigtes Gruen und Hauttoene sichtbar, ohne dass
        // das Bild unplausibel wuerde.
        return vec3<f32>(
            y + 1.4746 * cr,
            y - 0.16455 * cb - 0.57135 * cr,
            y + 1.8814 * cb,
        );
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

// Umkehrung davon: lineares Licht zurueck in sRGB-kodierte Werte. Gebraucht
// wird sie nur auf dem HDR-nach-SDR-Weg — dort entsteht am Ende lineares Licht,
// das Fenster erwartet aber kodierte Werte. Ohne diese Stufe waere das Bild
// durchgehend viel zu dunkel, und zwar genau so, wie ein falsch gelesener
// HDR-Strom aussieht; die beiden Fehler waeren nicht zu unterscheiden.
fn linear_to_srgb(c: vec3<f32>) -> vec3<f32> {
    let sicher = max(c, vec3<f32>(0.0));
    let low = sicher * 12.92;
    let high = 1.055 * pow(sicher, vec3<f32>(1.0 / 2.4)) - 0.055;
    return select(high, low, sicher <= vec3<f32>(0.0031308));
}

// PQ-Kurve (SMPTE ST 2084) ruecklaeufig: aus dem Codewert wird die Helligkeit,
// die der Bildpunkt haben SOLL — in cd/m², absolut.
//
// „Absolut" ist der ganze Unterschied zu allem darueber. Eine Gamma-Kurve sagt
// „halb so hell wie das Maximum dieses Schirms"; PQ sagt „94 cd/m²". Deshalb
// laesst sich ein PQ-Strom nicht einfach anzeigen, sondern muss auf das
// gerechnet werden, was der Schirm kann — und deshalb sieht er ohne diese
// Rechnung immer falsch aus, nie nur etwas daneben.
//
// Die Konstanten stammen aus der Norm; sie sehen willkuerlich aus, weil sie es
// sind (Bruchzahlen mit Nenner 4096 bzw. 16384).
fn pq_zu_nits(e: vec3<f32>) -> vec3<f32> {
    let m1 = 0.1593017578125;   // 2610 / 16384
    let m2 = 78.84375;          // 2523 / 4096 * 128
    let c1 = 0.8359375;         // 3424 / 4096
    let c2 = 18.8515625;        // 2413 / 4096 * 32
    let c3 = 18.6875;           // 2392 / 4096 * 32
    // Negative Codewerte gibt es nicht; sie entstehen hoechstens durch Dither
    // am unteren Rand und wuerden `pow` in den Nichtwert schicken.
    let x = pow(max(e, vec3<f32>(0.0)), vec3<f32>(1.0 / m2));
    let zaehler = max(x - c1, vec3<f32>(0.0));
    let nenner = c2 - c3 * x;
    return 10000.0 * pow(zaehler / nenner, vec3<f32>(1.0 / m1));
}

// BT.2020 nach BT.709, beides in LINEAREM Licht.
//
// Muss linear passieren — auf kodierte Werte angewandt ergaebe dieselbe Matrix
// Unsinn. Deshalb steht sie hier hinter der PQ-Kurve und nicht bei der
// YUV-Matrix, obwohl beide „Farbraum" heissen.
//
// **Die Werte duerfen negativ werden, und das ist richtig so.** BT.2020 kann
// Farben, die BT.709 nicht darstellt; sie landen ausserhalb des Wuerfels. Auf
// dem HDR-Weg bleiben sie stehen (scRGB traegt sie), auf dem SDR-Weg werden sie
// abgeschnitten — dort gibt es sie einfach nicht.
//
// **Aus den Primaervalenzen gerechnet, nicht abgeschrieben** (beide Raeume nach
// XYZ ueber D65, SMPTE RP 177, dann invertiert). Bis zum 2026-08-06 standen
// hier fuenfstellige Werte aus fremder Quelle; zwei in der dritten Zeile lagen
// um 1e-4 daneben (-0,01825 statt -0,0181508, 1,11883 statt 1,1187297 — sie
// hoben sich auf, die Zeilensumme blieb 1). An Grau unsichtbar, messbar erst an
// einer reinen BT.2020-Primaervalenz: bei rotem Spitzlicht lag der blaue Kanal
// um 0,5 % daneben (`testbench/profiles/player-2026-08-06-hdr-farbweg.json`).
// Alle drei Zeilensummen sind exakt 1 — deshalb kann ein Farbstich NIE aus
// dieser Matrix kommen.
fn bt2020_zu_bt709(c: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(
        dot(c, vec3<f32>( 1.6604910, -0.5876411, -0.0728499)),
        dot(c, vec3<f32>(-0.1245505,  1.1328999, -0.0083494)),
        dot(c, vec3<f32>(-0.0181508, -0.1005789,  1.1187297)),
    );
}

// Spitzlichter auf einen SDR-Schirm bringen (Tone-Mapping).
//
// Erweitertes Reinhard: `y = x (1 + x/w²) / (1 + x)`, mit `w` = der hellsten
// Stelle des Inhalts. Die Kurve trifft zwei Punkte exakt — 0 bleibt 0, und `w`
// landet genau auf 1,0 — und laeuft dazwischen glatt und monoton. Genau das
// braucht es hier: kein Spitzlicht darf ausfressen (sonst verschwinden Wolken,
// Lampen und Sonnenreflexe zu weissen Flecken), und nichts darf dunkler werden,
// als es war.
//
// **Warum je Kanal und nicht auf die Leuchtdichte.** Auf die Leuchtdichte
// gerechnet bleiben die Farben gesaettigter, aber helle gesaettigte Flaechen
// laufen aus dem darstellbaren Bereich heraus und muessten dann doch
// abgeschnitten werden — was sie kippen laesst. Je Kanal entsaettigen
// Spitzlichter stattdessen zum Weiss hin, und das entspricht dem, was ein Auge
// (und jede Fotografie) bei sehr hellen Flaechen ohnehin tut.
//
// Bezugspunkt ist das Diffusweiss, nicht die Null: ein HDR-Bild wird dadurch
// genauso hell wie dasselbe Bild in SDR, und nur die Spitzlichter darueber
// werden zusammengeschoben.
fn auf_sdr_rechnen(nits: vec3<f32>, spitze_nits: f32) -> vec3<f32> {
    let x = max(nits, vec3<f32>(0.0)) / DIFFUSWEISS;
    // Unter dem Diffusweiss gibt es nichts zusammenzuschieben — und ein `w`
    // unter 1 wuerde die Kurve umdrehen.
    let w = max(spitze_nits / DIFFUSWEISS, 1.0001);
    return x * (1.0 + x / (w * w)) / (1.0 + x);
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

    // ── Ab hier trennen sich SDR- und HDR-Quelle ────────────────────────────
    //
    // Alles darueber (Matrix, Deband, Dither) laeuft im KODIERTEN Raum, und
    // zwar in beiden Faellen: dort liegen die sichtbaren Stufen, und bei PQ ist
    // der kodierte Raum sogar besonders gut dafuer geeignet (die Kurve ist auf
    // die Wahrnehmung gebaut). Erst jetzt wird aus Codewerten Licht.
    if (u.hdr.x > 0.5) {
        return pq_ausgeben(rgb);
    }

    rgb = clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0));
    // Ganz zum Schluss: alles davor (Matrix, Deband, Dither) ist im
    // gamma-kodierten Raum gedacht, dort liegen die sichtbaren Stufen.
    if (u.output.x > 0.5) {
        rgb = srgb_to_linear(rgb);
    }
    return vec4<f32>(rgb, 1.0);
}

// Der HDR-Weg: aus PQ-kodierten Werten wird das, was das Fenster erwartet.
//
// Zwei Ziele, ein Weg bis zur Mitte — die Kurve aufloesen und den Farbraum
// umrechnen muss man immer; erst danach entscheidet sich, ob das Licht
// unveraendert weitergereicht (HDR-Fenster) oder zusammengeschoben wird
// (SDR-Fenster).
fn pq_ausgeben(kodiert: vec3<f32>) -> vec4<f32> {
    // Codewerte -> Licht in cd/m². Ab hier sind die Zahlen Helligkeiten, keine
    // Bildpunktwerte mehr; 100 heisst 100 cd/m².
    let nits = pq_zu_nits(kodiert);
    // Farbraum auf den des Fensters. Negative Werte bleiben stehen — s. dort.
    let bt709 = bt2020_zu_bt709(nits);

    if (u.hdr.y > 0.5) {
        // **HDR-Fenster.** scRGB traegt lineares Licht mit 1,0 = 80 cd/m², und
        // Werte ueber 1,0 sind genau das, wofuer der Farbraum da ist. Hier wird
        // deshalb NICHT begrenzt und NICHT kodiert: jede Rundung waere ein
        // Verlust an genau der Stelle, wegen der der ganze Weg existiert.
        //
        // Die untere Grenze bleibt offen (negative Werte = Farben ausserhalb
        // von BT.709), die obere auch — der Compositor rechnet auf die
        // Faehigkeiten des Schirms herunter, und er weiss besser als wir, was
        // der kann.
        return vec4<f32>(bt709 / SCRGB_WEISS, 1.0);
    }

    // **SDR-Fenster.** Zusammenschieben, abschneiden, kodieren — in dieser
    // Reihenfolge. Das Abschneiden nach dem Zusammenschieben ist wichtig: es
    // trifft dann nur noch Farben ausserhalb von BT.709, nicht mehr die
    // Helligkeit.
    let gerechnet = auf_sdr_rechnen(bt709, u.hdr.z);
    let begrenzt = clamp(gerechnet, vec3<f32>(0.0), vec3<f32>(1.0));
    // Erwartet das Fenster lineares Licht (fp16-Oberflaeche im SDR-Betrieb),
    // bleibt es linear; sonst wird sRGB-kodiert. Dieselbe Frage wie auf dem
    // SDR-Weg oben, nur andersherum gestellt — dort liegen kodierte Werte vor
    // und muessen ggf. linearisiert werden, hier ist es umgekehrt.
    if (u.output.x > 0.5) {
        return vec4<f32>(begrenzt, 1.0);
    }
    return vec4<f32>(linear_to_srgb(begrenzt), 1.0);
}
