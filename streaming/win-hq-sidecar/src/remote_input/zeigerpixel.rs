//! Die **Pixel** des Host-Zeigers holen — für alles, was keinem Standardzeiger
//! entspricht.
//!
//! Der gewöhnliche Weg ([`super::zeigerform`]) meldet einen **Namen** aus der
//! CSS-Liste, und wo er trägt, ist er der bessere: ein paar Byte, und gezeichnet
//! wird der lokale Zeiger des Steuernden in dessen Größe und Thema. Er trägt
//! aber nur die dreizehn Formen, die Windows selbst mitbringt. Eine
//! Schnittanwendung mit Rasierklinge und Trimm-Zeigern, eine Bildbearbeitung
//! mit Werkzeug-Zeigern, ein 3D-Programm mit Achsen-Zeigern — die fallen alle
//! auf den Standardpfeil, und der Steuernde sieht nichts von dem, was das
//! Programm ihm gerade sagen will. Hier werden für genau diese Fälle die Pixel
//! ausgelesen; das Format, in dem sie hinausgehen, steht in
//! [`crate::zeigerbild`], die Umrechnung in [`super::zeigerpunkte`].
//!
//! **Es wird nicht danach gefragt, WER den Zeiger gesetzt hat.** Windows führt
//! genau einen Systemzeiger, und `GetCursorInfo` gibt dessen Handle heraus,
//! gleich ob es von Qt, von einem Adobe-Programm oder von der Shell stammt. Eine
//! Liste bekannter Anwendungen gibt es deshalb nicht und soll es nicht geben —
//! sie wäre am Tag ihrer Fertigstellung unvollständig.
//!
//! ## Die drei Sorten Zeiger, die Windows kennt
//!
//! `GetIconInfo` liefert bis zu zwei Bitmaps, und aus deren Zusammenspiel ergibt
//! sich, welche Sorte vorliegt:
//!
//! 1. **Farbzeiger mit echtem Alpha** (heute der Regelfall): `hbmColor` ist
//!    32 bit und trägt eine brauchbare Deckung. Nur hier ist die Maske
//!    entbehrlich.
//! 2. **Farbzeiger ohne Alpha** (die ältere Bauart): `hbmColor` ist da, aber
//!    die Deckung ist durchweg null. Wer das für bare Münze nimmt, überträgt
//!    einen vollständig durchsichtigen Zeiger — der Steuernde sähe gar nichts
//!    und hielte es für einen Fehler der Fernsteuerung. Die Deckung kommt in
//!    diesem Fall aus `hbmMask`.
//! 3. **Reine Maskenzeiger**: `hbmColor` fehlt ganz, `hbmMask` ist doppelt so
//!    hoch und enthält beide Masken übereinander.
//!
//! **Die Höhe von `hbmMask` hängt davon ab, welcher Fall vorliegt** — das ist
//! die Stelle, an der man sich am leichtesten vertut, und sie steht so in der
//! `ICONINFO`-Definition: bei einem Schwarzweiss-Symbol ist die obere Hälfte
//! die UND-, die untere die XOR-Maske; bei einem Farbsymbol beschreibt die
//! Maske ausdrücklich **nur** die UND-Maske und hat damit die gewöhnliche
//! Höhe. Deshalb liest [`bild_holen`] sie im Farbfall mit `hoehe` und im
//! Maskenfall mit `roh_hoehe`.
//!
//! Der gefährliche Irrtum ist dabei **der umgekehrte**: wer die Maske eines
//! reinen Maskenzeigers mit der halben Höhe läse, bekäme als XOR-Hälfte lauter
//! Nullen und damit einen still falschen, durchweg schwarzen Zeiger. In die
//! andere Richtung passiert nichts Schlimmes — im Farbfall ist `hoehe`
//! definitionsgemäss gleich `roh_hoehe`, die beiden Aufrufe wären identisch.
//! (Aus fremdem Speicher liest hier ohnehin nichts: [`als_bgra`] legt seinen
//! Puffer selbst in der angeforderten Höhe an, und die Maske wird über
//! `.get()` gelesen.)
//!
//! ## Warum alles als 32 bit gelesen wird
//!
//! `GetDIBits` wandelt beim Auslesen in das angeforderte Format um. Eine
//! 1-bit-Maske als 32 bit zu lesen kostet nichts und erspart das Auspacken von
//! Bitreihen samt ihrer Auffüllung auf Vierbyte-Grenzen — ein Rechenweg, den
//! man nicht prüfen kann, ohne ihn auf einem Windows-Rechner laufen zu lassen.
//! Gesetzte Bits kommen als Weiss an, gelöschte als Schwarz; mehr wird von der
//! Maske nicht gebraucht.

use std::ffi::c_void;

use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAP, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, DeleteObject, GetDC, GetDIBits,
    GetObjectW, HBITMAP, HDC, HGDIOBJ, ReleaseDC,
};
use windows::Win32::UI::WindowsAndMessaging::{GetIconInfo, HCURSOR, HICON, ICONINFO};

use super::zeigerpunkte::{farbzeiger, maskenzeiger};
use crate::zeigerbild::{MAX_KANTE, Zeigerbild};

/// Die beiden Bitmaps aus `GetIconInfo` gehören dem Aufrufer und müssen von ihm
/// freigegeben werden. Das je Ausgang von Hand zu tun, geht genau so lange gut,
/// bis jemand einen frühen `return` einbaut — und ein Leck, das alle 100 ms um
/// zwei Bitmaps wächst, fällt erst nach Stunden als erschöpftes GDI-Kontingent
/// auf, dann aber systemweit.
struct Bitmaps(ICONINFO);

impl Bitmaps {
    fn holen(zeiger: HCURSOR) -> Option<Bitmaps> {
        let mut info = ICONINFO::default();
        // Ein Zeiger IST ein Symbol, nur mit Haltepunkt statt Ursprung — die
        // Umdeutung des Handles ist die von Windows vorgesehene.
        let ergebnis = unsafe { GetIconInfo(HICON(zeiger.0), &mut info) };
        // **Die Hülle wird auch im Fehlerfall gebaut**, und erst danach wird
        // abgebrochen: die Dokumentation sagt nicht zu, dass bei einem
        // Fehlschlag keine der beiden Bitmaps schon angelegt war. So gibt
        // `Drop` frei, was da ist, und `default()` hat Nullzeiger, die der
        // Freigabe-Zweig ohnehin überspringt.
        let bitmaps = Bitmaps(info);
        ergebnis.ok()?;
        Some(bitmaps)
    }
}

impl Drop for Bitmaps {
    fn drop(&mut self) {
        for bitmap in [self.0.hbmColor, self.0.hbmMask] {
            if !bitmap.0.is_null() {
                unsafe {
                    let _ = DeleteObject(HGDIOBJ(bitmap.0));
                }
            }
        }
    }
}

/// Der Bildschirm-Zeichenbereich, den `GetDIBits` als Bezug braucht. Eigener
/// Typ aus demselben Grund wie [`Bitmaps`]: der Weg hat mehrere Ausgänge, und
/// ein nicht zurückgegebener Bereich ist ein Leck im Fenstersystem.
struct Schirm(HDC);

impl Schirm {
    fn holen() -> Option<Schirm> {
        let hdc = unsafe { GetDC(None) };
        (!hdc.0.is_null()).then_some(Schirm(hdc))
    }
}

impl Drop for Schirm {
    fn drop(&mut self) {
        unsafe { ReleaseDC(None, self.0) };
    }
}

/// Masse einer Bitmap.
fn masse(bitmap: HBITMAP) -> Option<(i32, i32)> {
    let mut bm = BITMAP::default();
    let gelesen = unsafe {
        GetObjectW(
            HGDIOBJ(bitmap.0),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bm as *mut BITMAP as *mut c_void),
        )
    };
    (gelesen != 0).then_some((bm.bmWidth, bm.bmHeight))
}

/// Eine Bitmap als BGRA auslesen, Zeilen von oben nach unten.
///
/// Die **negative** Höhe im Kopf ist das, was die Zeilenrichtung umdreht; ohne
/// sie liefert Windows von unten nach oben, und der Zeiger stünde auf dem Kopf.
fn als_bgra(schirm: &Schirm, bitmap: HBITMAP, breite: i32, hoehe: i32) -> Option<Vec<u8>> {
    let mut kopf = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: breite,
            biHeight: -hoehe,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut puffer = vec![0u8; breite as usize * hoehe as usize * 4];
    let zeilen = unsafe {
        GetDIBits(
            schirm.0,
            bitmap,
            0,
            hoehe as u32,
            Some(puffer.as_mut_ptr() as *mut c_void),
            &mut kopf,
            DIB_RGB_COLORS,
        )
    };
    // **Genau so viele Zeilen wie angefordert**, nicht bloss „mehr als null":
    // eine Teilkopie gälte sonst als Erfolg, und der unkopierte Rest bliebe
    // Null — beim Farbbild also durchsichtig, bei der Maske deckend. Beides
    // wäre ein still falscher Zeiger statt eines Rückfalls auf den Namen.
    (zeilen == hoehe).then_some(puffer)
}

/// Das Bild des gerade gezeichneten Zeigers.
///
/// `None` bei jedem Fehlschlag, und zwar wortlos: der Aufrufer fällt dann auf
/// den Namen zurück (also auf den Standardpfeil), und eine Zeile im Protokoll
/// käme im Takt der Wache immer wieder — sie würde das Protokoll fluten, ohne
/// je etwas Neues zu sagen.
pub(super) fn bild_holen(zeiger: HCURSOR) -> Option<Zeigerbild> {
    if zeiger.0.is_null() {
        return None;
    }
    let bitmaps = Bitmaps::holen(zeiger)?;
    let info = &bitmaps.0;
    let schirm = Schirm::holen()?;
    let farbig = !info.hbmColor.0.is_null();

    let (breite, roh_hoehe) = masse(if farbig { info.hbmColor } else { info.hbmMask })?;
    // Beim reinen Maskenzeiger liegen zwei Masken übereinander.
    let hoehe = if farbig { roh_hoehe } else { roh_hoehe / 2 };
    if breite < 1 || hoehe < 1 || breite > MAX_KANTE as i32 || hoehe > MAX_KANTE as i32 {
        return None;
    }

    let punkte = if farbig {
        let bgra = als_bgra(&schirm, info.hbmColor, breite, hoehe)?;
        // Trägt das Farbbild überhaupt eine Deckung? Ist sie durchweg null,
        // liegt die ältere Bauart vor (Sorte 2 im Modulkopf) und die Maske muss
        // einspringen.
        if bgra.chunks_exact(4).any(|p| p[3] != 0) {
            farbzeiger(&bgra, None)
        } else {
            let maske = als_bgra(&schirm, info.hbmMask, breite, hoehe)?;
            farbzeiger(&bgra, Some(&maske))
        }
    } else {
        let bgra = als_bgra(&schirm, info.hbmMask, breite, roh_hoehe)?;
        maskenzeiger(&bgra, breite as usize * hoehe as usize)
    };

    let bild = Zeigerbild {
        breite: breite as u16,
        hoehe: hoehe as u16,
        // Der Haltepunkt kann bei einem missgebildeten Zeiger neben dem Bild
        // liegen; geklemmt statt verworfen, weil ein Zeiger mit leicht
        // verschobenem Zielpunkt immer noch besser ist als keiner.
        halt_x: (info.xHotspot as u16).min(breite as u16 - 1),
        halt_y: (info.yHotspot as u16).min(hoehe as u16 - 1),
        punkte,
    };
    // Die letzte Wache vor der Leitung: was hier nicht stimmig ist, ginge sonst
    // als Bild hinaus, das die Gegenseite nur abweisen kann.
    bild.stimmig().then_some(bild)
}
