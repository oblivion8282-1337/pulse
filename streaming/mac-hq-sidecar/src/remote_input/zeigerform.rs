//! Welche **Form** der Zeiger des Hosts gerade hat — die macOS-Haelfte.
//!
//! Die Buchfuehrung (was zuletzt gemeldet wurde, was die Gegenseite kennt, wann
//! aufgefrischt wird) liegt in [`pulse_fernsteuerung::zeigerbuch`], gemeinsam
//! mit Windows. Dort steht auch, warum es das Merkmal ueberhaupt gibt: das
//! Cursor-Echo nimmt den Host-Zeiger aus dem Bild und mit ihm alles, was seine
//! Form erzaehlt.
//!
//! ## Warum hier kein NAME hinausgeht — der Windows-Entwurf, umgedreht
//!
//! Windows meldet bevorzugt einen Namen aus der CSS-Zeigerliste (`text`,
//! `ns-resize`, …) und nur ausnahmsweise Pixel. Das ist der bessere Weg, wo er
//! traegt: ein paar Byte, und gezeichnet wird der lokale Zeiger des Steuernden
//! in dessen Groesse und Thema. Er traegt hier nicht. Gemessen (macOS 15.7.3,
//! Entwurf §6.1): `NSCursor.arrow.image` und `NSCursor.iBeam.image` liefern
//! Groesse (0,0) und gar kein Bild — **ausgerechnet die beiden haeufigsten
//! Formen sind nicht wiedererkennbar**, und ein Vergleich gegen sie kann
//! deshalb nichts entscheiden. Es gibt auf macOS auch keine Zeiger-Kennung, die
//! man wie ein Windows-Handle vergleichen koennte; die private CGS-Schnittstelle
//! haette eine, ist aber ausdruecklich verworfen (Entwurf §2.1, undokumentiert
//! und braeche beim Nutzer statt beim Bau).
//!
//! **Der Mac schickt deshalb immer das Bild.** Eine Namenstabelle gibt es hier
//! nicht und soll es nicht geben — sie waere geraten. Der Name `VORGABE` faehrt
//! trotzdem in jeder Meldung mit: `Zeigerbuch` setzt ihn bei
//! [`Stand::Eigen`] selbst, und er ist der Rueckfall, wenn das Bild nicht
//! ankommt oder drueben nicht gebaut werden kann.
//!
//! ## Was gemessen ist (2026-08-23, `examples/probe_zeigerform.rs`)
//!
//! * `NSCursor.currentSystemCursor` traegt **prozessuebergreifend** und
//!   funktioniert **auch ausserhalb des Hauptfadens** — der Wecker der Wache
//!   laeuft auf einem eigenen Faden, und dieselbe Abfrage lieferte dort
//!   dasselbe Ergebnis.
//! * Eine Abfrage samt Zeichnen kostet **0,16 bis 0,18 ms** (drei Laeufe zu je
//!   200 Abfragen: 165, 179, 161 µs), die **allererste 135 bis 140 ms** —
//!   einmaliges Laden von AppKit, nicht die Abfrage selbst. Gegen den
//!   100-ms-Takt der Wache faellt der laufende Betrieb nicht ins Gewicht. Der
//!   erste Aufruf **ueberzieht den Takt um gut einen Wecker** — die erste
//!   Formmeldung einer Sitzung kommt also rund 100 ms spaeter als die zweite.
//!   Ungemessen ist, ob das jemandem auffaellt; behoben ist es nicht.
//! * Die Abfrage ist **abgekuendigt**: der Kopf des SDK sagt woertlich, die
//!   Eigenschaft werde in einer kuenftigen macOS-Fassung immer `nil` liefern.
//!   Genau dafuer gibt es den Rueckfall — [`abfragen`] liefert dann `None`, und
//!   der Sidecar schaltet auf „Zeiger im Bild" um (Etappe 4, Aufgabe 5).
//!
//! ## Nie am Systemobjekt festhalten
//!
//! Bei jedem Wecker wird frisch abgefragt und frisch gezeichnet. Das ist
//! dieselbe Lehre wie auf Windows, wo ein gemerktes Zeiger-Handle nach dem
//! Freigeben ein fremdes Bild liefert — hier waere es ein `NSCursor`, den
//! niemand mehr fuehrt. Gemerkt wird nur weiter drueben und nur das
//! **Ergebnis**: `Zeigerbuch` fuehrt die Kennungen, die der Steuernde schon
//! kennt, der Player seinen Vorrat gebauter Zeiger. Zwischen Abfrage und
//! Kennung liegt hier bewusst nichts.

use objc2::msg_send;
use objc2::rc::{Retained, autoreleasepool};
use objc2::runtime::{AnyClass, AnyObject};
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_core_graphics::{
    CGBitmapContextCreate, CGBitmapContextGetBytesPerRow, CGBitmapContextGetData, CGColorSpace,
    CGContext, CGImage, CGImageAlphaInfo, CGImageByteOrderInfo, CGInterpolationQuality,
    kCGColorSpaceSRGB,
};

use pulse_fernsteuerung::zeigerbuch::{Stand, VORGABE};
use pulse_zeigerbild::Zeigerbild;

use super::zeigerpunkte;

// AppKit wird nur **verlinkt**, nicht als Kiste eingebunden. Gebraucht werden
// fuenf Nachrichten — `currentSystemCursor`, `hotSpot`, `image`, `size` und
// `CGImageForProposedRect:context:hints:` —, und die gehen ueber den
// Laufzeitaufruf, den `objc2` ohnehin mitbringt. Eine
// `objc2-app-kit`-Abhaengigkeit dafuer waere ein neuer Bauweg fuer nichts.
#[link(name = "AppKit", kind = "framework")]
unsafe extern "C" {}

/// Der gerade gezeichnete System-Zeiger als sendefertiges Bild.
///
/// `None` heisst **nicht** „Fehler", sondern „von dieser Maschine ist gerade
/// kein Zeigerbild zu bekommen" — und ist damit zugleich der Ausloeser des
/// Rueckfalls (Aufgabe 5: `showsCursor = true` und `zeiger_im_bild` an den
/// Steuernden). Deshalb wird hier auch **nichts protokolliert**: der Wecker
/// kaeme 100 ms spaeter mit derselben Zeile wieder und flutete das Protokoll,
/// ohne je etwas Neues zu sagen.
pub fn abfragen() -> Option<Zeigerbild> {
    // Eigener Freigabe-Ring: `currentSystemCursor` und `image` geben
    // autofreigegebene Objekte heraus, und der Wecker der Wache laeuft auf
    // einem gewoehnlichen Faden, der von sich aus keinen mitbringt. Ohne den
    // Ring sammelte jede Abfrage einen Zeiger an — zehnmal je Sekunde,
    // solange eine Fernsteuerung laeuft.
    autoreleasepool(|_| {
        // **`Option` ist hier Pflicht, nicht Stil.** `msg_send!` mit einem
        // blanken `Retained` bricht bei `nil` mit einer Panik ab — und `nil`
        // ist genau das, was der SDK-Kopf fuer eine kuenftige macOS-Fassung
        // ankuendigt. Der Sidecar wuerde dann sterben, wo er zurueckfallen
        // soll.
        let zeiger: Option<Retained<AnyObject>> =
            unsafe { msg_send![AnyClass::get(c"NSCursor")?, currentSystemCursor] };
        let zeiger = zeiger?;
        let halt: CGPoint = unsafe { msg_send![&*zeiger, hotSpot] };
        let bild: Option<Retained<AnyObject>> = unsafe { msg_send![&*zeiger, image] };
        let bild = bild?;
        let punktmasse: CGSize = unsafe { msg_send![&*bild, size] };

        // `CGImageForProposedRect` liefert die Darstellung, die AppKit fuer die
        // beste haelt — auf dieser Maschine beim Pfeil die einfache, beim
        // I-Balken die doppelte Aufloesung (Messtabelle im Kopf von
        // [`zeigerpunkte`]). Der Vorschlag wird deshalb nur gestellt, nicht
        // geglaubt; die Masse entscheidet `zielmasse` aus den **Punkten**.
        let mut vorschlag = CGRect::new(CGPoint::new(0.0, 0.0), punktmasse);
        let cg: *mut CGImage = unsafe {
            msg_send![&*bild,
                CGImageForProposedRect: &mut vorschlag,
                context: std::ptr::null::<AnyObject>(),
                hints: std::ptr::null::<AnyObject>()]
        };
        // Das CGImage gehoert dem `NSImage` und lebt, solange dieses gehalten
        // wird — also bis zum Ende dieses Blocks. Lange genug: gezeichnet wird
        // sofort, und danach haelt `zeigerpunkte` nur noch eigene Bytes.
        let cg = unsafe { cg.as_ref() }?;

        let (breite, hoehe) = zeigerpunkte::zielmasse(
            (punktmasse.width, punktmasse.height),
            (CGImage::width(Some(cg)), CGImage::height(Some(cg))),
        )?;
        let (roh, bytes_je_zeile) = zeichnen(cg, breite, hoehe)?;
        zeigerpunkte::bild(breite, hoehe, (halt.x, halt.y), &roh, bytes_je_zeile)
    })
}

/// Was der Sender dem [`pulse_fernsteuerung::zeigerbuch`] in dieser Runde
/// beisteuert.
pub fn ermitteln() -> Stand {
    ermitteln_mit(abfragen)
}

/// Die Weiche zwischen Bild und Rueckfall, getrennt von der Abfrage.
///
/// Sie ist kein Selbstzweck: die Abfrage selbst laesst sich ohne Fenster-Server
/// nicht pruefen, diese eine Regel aber schon — **es wird in jeder Runde neu
/// gefragt**. Ein zwischengespeichertes Ergebnis waere der naheliegende
/// „Sparbetrag" (0,3 ms je Wecker) und zugleich der Fehler, bei dem der
/// Steuernde bis zum Sitzungsende mit demselben Zeiger dasteht, waehrend der
/// Host laengst ueber einem Textfeld haengt.
fn ermitteln_mit(abfrage: impl Fn() -> Option<Zeigerbild>) -> Stand {
    match abfrage() {
        Some(bild) => Stand::Eigen(bild),
        // Kein Bild zu bekommen — die Vorgabe ist hier kein Ratschlag, sondern
        // die ehrliche Auskunft „ich weiss es nicht". Der Rueckfall aus
        // Aufgabe 5 haengt sich an denselben Zweig.
        None => Stand::Name(VORGABE),
    }
}

/// Den Zeiger in einen **selbst angelegten** Zeichenraum malen und dessen
/// Bytes herausholen.
///
/// Zwei Dinge entstehen erst dadurch, und beide sind der Grund fuer diesen
/// Umweg statt eines direkten Zugriffs auf die Bitmap der Darstellung:
///
/// 1. **Die einfache Aufloesung.** `breite`/`hoehe` sind die Punktmasse; ein
///    doppelt so grosses Quellbild wird beim Zeichnen heruntergerechnet. Ueber
///    die Darstellungen zu gehen ginge nicht: der gemessene I-Balken bringt gar
///    keine einfache mit (nur 18x36 und groesser).
/// 2. **Ein bekanntes Format.** Der Zeichenraum wird als RGBA/8 bit mit
///    vorvervielfachter Deckung angelegt, also genau so, wie
///    [`zeigerpunkte::entvielfachtes_feld`] es erwartet. Die Darstellungen
///    liefern dagegen, was sie wollen — die gemessene trug
///    `kCGBitmapByteOrder32Little`, also ABGR im Speicher, und jede weitere
///    koennte etwas anderes tragen.
fn zeichnen(bild: &CGImage, breite: u16, hoehe: u16) -> Option<(Vec<u8>, usize)> {
    // sRGB ausdruecklich, nicht DeviceRGB: Zeigerbilder sind sRGB, und der
    // Empfaenger deutet die Punkte ebenso. „Geraeteabhaengig" hiesse hier, dass
    // die Farbe des Zeigers vom Schirm des Hosts abhinge.
    let raum = CGColorSpace::with_name(Some(unsafe { kCGColorSpaceSRGB }))?;
    let format = CGImageAlphaInfo::PremultipliedLast.0 | CGImageByteOrderInfo::Order32Big.0;
    let raum_ctx = unsafe {
        CGBitmapContextCreate(
            // Kein eigener Puffer: CoreGraphics legt einen an, nullt ihn und
            // gibt ihn mit dem Zeichenraum wieder frei. Ein selbst gehaltener
            // Puffer waere eine Lebensdauer mehr, die niemand braucht — die
            // Bytes werden ohnehin kopiert.
            std::ptr::null_mut(),
            breite as usize,
            hoehe as usize,
            8,
            // Zeilenabstand von CoreGraphics waehlen lassen (0) und danach
            // erfragen. Selbst `breite * 4` vorzugeben ginge, verboete aber
            // jede Auffuellung, die die Bibliothek fuer schneller haelt.
            0,
            Some(&raum),
            format,
        )
    }?;
    // Beim Herunterrechnen von der doppelten auf die einfache Aufloesung
    // entscheidet das ueber den Rand des Zeigers.
    CGContext::set_interpolation_quality(Some(&raum_ctx), CGInterpolationQuality::High);
    CGContext::draw_image(
        Some(&raum_ctx),
        CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(breite as f64, hoehe as f64)),
        Some(bild),
    );

    let daten = CGBitmapContextGetData(Some(&raum_ctx));
    if daten.is_null() {
        return None;
    }
    let bytes_je_zeile = CGBitmapContextGetBytesPerRow(Some(&raum_ctx));
    let laenge = bytes_je_zeile.checked_mul(hoehe as usize)?;
    // Kopiert, bevor der Zeichenraum faellt: `zeigerpunkte` rechnet auf einer
    // eigenen Scheibe, und alles danach ist reine Rechnung ohne CoreGraphics.
    let roh = unsafe { std::slice::from_raw_parts(daten as *const u8, laenge) }.to_vec();
    Some((roh, bytes_je_zeile))
}

// Die Tests liegen daneben, wie bei `zeigerpunkte` — seit sie auch
// [`zeichnen`] abdecken, sind es mehr Zeilen als das Modul selbst hat. Was sie
// koennen und warum es ohne Fenster-Server geht, steht in ihrem Kopf.
#[cfg(test)]
#[path = "zeigerform_tests.rs"]
mod zeigerform_tests;
