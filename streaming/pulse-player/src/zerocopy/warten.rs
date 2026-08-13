//! Die beiden Wartepunkte der Windows-Bruecke — und ihre Zeitgrenzen.
//!
//! **Warum eine eigene Datei.** Zusammen mit den Begruendungen waere `bruecke.rs`
//! ueber die harte Groessengrenze gewachsen (`PLAN.md` §12.1). Die Trennung
//! passt aber auch sachlich: hier steht ausschliesslich, WORAUF gewartet wird
//! und wie lange, waehrend `bruecke.rs` den Ring und die Kopie fuehrt.
//!
//! **Was hier bis zum 2026-08-13 stand: `INFINITE`, an beiden Stellen.** Das
//! war der eigentliche Fehler. Beide Wartepunkte liegen im Dekodier-Pfad, der
//! im Tokio-Task der Sitzung laeuft. Blockierte einer, stand die ganze Sitzung —
//! und zwar ohne Ausweg:
//!
//! * Der Einfrier-Waechter (`crate::einfrieren`) misst erst, NACHDEM ein Bild
//!   fertig dekodiert wurde. Kam keins mehr, mass er nichts und griff nie.
//! * Der Rueckfall auf den Hauptspeicher-Weg haengt an derselben Kette.
//!
//! Fuer den Zuschauer hiess das: Standbild, keine Meldung, kein Rueckfall, bis
//! er das Fenster selbst schliesst.

use anyhow::{anyhow, bail, Context, Result};
use windows::core::{Interface, HRESULT};
use windows::Win32::Foundation::{HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
use windows::Win32::Graphics::Direct3D11::ID3D11Fence;
use windows::Win32::Graphics::Dxgi::IDXGIKeyedMutex;
use windows::Win32::System::Threading::{ResetEvent, WaitForSingleObject};

/// Ab wann ein einzelner Wartepunkt gemeldet wird.
///
/// Grosszuegig gewaehlt: im gesunden Betrieb liegen beide Wartepunkte unter
/// einer Millisekunde, gemeldet werden soll nur das, was ein Zuschauer als
/// Stocken merkt. 100 ms sind rund fuenfzehn ausgefallene Bilder bei 144 fps.
const LANGSAM: std::time::Duration = std::time::Duration::from_millis(100);

/// Wie lange ein einzelner Wartepunkt hoechstens warten darf.
///
/// **Ehrlich zur Herkunft der Zahl: 250 ms sind NICHT gemessen.** Sie sind so
/// gewaehlt, dass sie deutlich ueber [`LANGSAM`] liegen — also ueber dem, was
/// dieses Modul selbst als „langsam, aber normal" meldet — und weit unter dem,
/// was ein Zuschauer als Standbild wahrnimmt. Was fehlt, ist die Messung am
/// laufenden Bildweg: wie lange die Anmeldung am Platz im gesunden Betrieb
/// dauert und wie weit sie unter Last streut (144 fps, HDR, mehrere Streams).
/// Genau dafuer steht der Wert unter `PULSE_PLAYER_BRUECKE_WARTE_MS` und muss
/// zum Messen nicht neu uebersetzt werden.
pub(super) const WARTE_MS_VORGABE: u32 = 250;

/// Wieviele Zeitueberschreitungen **in Folge** die Bruecke aufgeben lassen.
///
/// Eine einzelne ist noch kein Grund, den Weg zu verwerfen: sie kostet ein
/// Bild, das ueber den Hauptspeicher geht, und der naechste Versuch laeuft
/// wieder. Bleibt es dabei — haengender Treiber, abgestuerzter Renderer-Faden —
/// waere jedes weitere Bild um die Wartezeit verzoegert, und dann ist Aufgeben
/// besser als Weiterprobieren: der Fehler geht nach oben, `uebergabe.rs`
/// schaltet den Weg ab und der Player liest wieder ueber den Hauptspeicher.
pub(super) const ZEITUEBERSCHREITUNGEN_MAX: u32 = 3;

// Die beiden Wartepunkte bleiben in den Meldungen auseinandergehalten: der eine
// wartet auf den Renderer, der andere auf die Grafikeinheit. Die Unterscheidung
// hat am 2026-08-07 einen halben Messtag gekostet und ist es wert, erhalten zu
// bleiben.
pub(super) const WO_ANMELDUNG: &str = "Anmeldung am Platz (wartet auf den Renderer)";
pub(super) const WO_ZAUN: &str = "Zaun nach der Kopie (wartet auf die Grafikeinheit)";

/// Die Wartegrenze, einmal je Bruecke aus der Umgebung gelesen.
pub(super) fn warte_ms() -> u32 {
    std::env::var("PULSE_PLAYER_BRUECKE_WARTE_MS")
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
        // Unter 20 ms waere bei 144 fps schon ein normaler Zeichendurchgang
        // knapp; ueber 10 s ist es wieder das Standbild ohne Ausweg.
        .filter(|ms| (20..=10_000).contains(ms))
        .unwrap_or(WARTE_MS_VORGABE)
}

/// Wie ein Wartepunkt ausgegangen ist.
pub(super) enum Kopierstand {
    Fertig,
    /// Der genannte Wartepunkt hat seine Zeitgrenze gerissen. Kein Fehler:
    /// dieses eine Bild nimmt den Weg ueber den Hauptspeicher.
    Zeitueberschreitung(&'static str),
}

/// Anmeldung am Schluessel-Mutex mit Zeitgrenze — **bewusst am sicheren Aufsatz
/// der windows-Kiste vorbei.**
///
/// `IDXGIKeyedMutex::AcquireSync` endet dort auf `HRESULT::ok()`, und
/// `WAIT_TIMEOUT` ist `0x00000102`, also positiv: die Zeitueberschreitung kommt
/// als `Ok(())` an und ist vom Erfolg nicht mehr zu unterscheiden. Wer nur
/// `INFINITE` durch eine Zahl ersetzt und das `?` stehen laesst, baut sich damit
/// einen schlimmeren Fehler ein als den, den er behebt: der Code liefe weiter,
/// als hielte er die Sperre, und schriebe in eine Flaeche, die der Renderer noch
/// benutzt. Aus einem Standbild wuerden zerrissene Bilder — und die Uebersetzung
/// meldet nichts, weil alles sauber typisiert ist.
///
/// Deshalb der rohe Aufruf, der den HRESULT unverfaelscht liefert. Behandelt
/// wird streng: **nur** `S_OK` heisst „Sperre gehoert uns". Damit faellt auch
/// `WAIT_ABANDONED` (ebenfalls positiv, heisst: geteilte Flaeche und Mutex sind
/// nicht mehr stimmig) nicht mehr durch.
///
/// `Ok(false)` = Zeitgrenze gerissen, die Sperre gehoert uns **nicht**, und
/// `ReleaseSync` darf dann auch NICHT laufen.
///
/// # Safety
/// `mutex` muss eine lebende Schnittstelle sein.
pub(super) unsafe fn anmelden(mutex: &IDXGIKeyedMutex, ms: u32, slot: usize) -> Result<bool> {
    let uhr = std::time::Instant::now();
    // SAFETY: lebende Schnittstelle, der rohe Zeiger stammt aus ihr selbst und
    // bleibt fuer die Dauer des Aufrufs gueltig.
    let hr = unsafe { (Interface::vtable(mutex).AcquireSync)(Interface::as_raw(mutex), 0, ms) };
    if hr.0 as u32 == WAIT_TIMEOUT.0 {
        return Ok(false);
    }
    if hr != HRESULT(0) {
        return Err(anyhow!("AcquireSync: HRESULT 0x{:08X}", hr.0 as u32));
    }
    let gewartet = uhr.elapsed();
    if gewartet >= LANGSAM {
        eprintln!(
            "pulse-player: Bruecke — Anmeldung am Platz {slot} dauerte {} ms \
             (wartet auf den Renderer)",
            gewartet.as_millis()
        );
    }
    Ok(true)
}

/// Auf den Zaun nach der Kopie warten, mit Zeitgrenze.
///
/// **Warum eine Schleife und nicht ein einzelnes Warten.** Seit das Warten eine
/// Zeitgrenze hat, kann es abgebrochen werden, WAEHREND die Anmeldung ueber
/// `SetEventOnCompletion` noch steht. Erreicht der Zaun spaeter diesen alten
/// Wert, setzt er das Ereignis — und ein spaeteres Warten auf einen HOEHEREN
/// Wert kaeme sofort zurueck, obwohl die Kopie noch laeuft. Genau daraus wuerden
/// die zerrissenen Bilder, die die Zeitgrenze vermeiden soll. Zwei Dinge fangen
/// das: das `ResetEvent` vor jeder Anmeldung und der Zaunwert-Vergleich im
/// Schleifenkopf, der ueber das Ende entscheidet — nicht das Ereignis.
///
/// # Safety
/// Zaun und Ereignis muessen leben, und das Ereignis darf von niemandem sonst
/// benutzt werden.
pub(super) unsafe fn auf_zaun_warten(
    zaun: &ID3D11Fence,
    ereignis: HANDLE,
    wert: u64,
    ms: u32,
) -> Result<Kopierstand> {
    let uhr = std::time::Instant::now();
    let frist = uhr + std::time::Duration::from_millis(ms as u64);
    // SAFETY: Zaun und Ereignis leben, s. Vertrag oben.
    let stand = unsafe {
        loop {
            if zaun.GetCompletedValue() >= wert {
                break Kopierstand::Fertig;
            }
            let rest = frist.saturating_duration_since(std::time::Instant::now());
            if rest.is_zero() {
                break Kopierstand::Zeitueberschreitung(WO_ZAUN);
            }
            ResetEvent(ereignis).context("ResetEvent")?;
            // Rennfrei: ist der Wert zwischen Pruefung und hier erreicht worden,
            // setzt `SetEventOnCompletion` das Ereignis sofort.
            zaun.SetEventOnCompletion(wert, ereignis).context("SetEventOnCompletion")?;
            match WaitForSingleObject(ereignis, rest.as_millis() as u32) {
                // Beide Faelle entscheidet der Schleifenkopf neu — das Ereignis
                // ist nur ein Anstoss, der Zaunwert ist die Antwort.
                WAIT_OBJECT_0 | WAIT_TIMEOUT => {}
                anderes => bail!("WaitForSingleObject (Zaun): {}", anderes.0),
            }
        }
    };
    let gewartet = uhr.elapsed();
    if gewartet >= LANGSAM {
        eprintln!(
            "pulse-player: Bruecke — Zaun nach der Kopie dauerte {} ms \
             (wartet auf die Grafikeinheit)",
            gewartet.as_millis()
        );
    }
    Ok(stand)
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::Foundation::{CloseHandle, GENERIC_ALL};
    use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
    use windows::Win32::Graphics::Direct3D11::{
        D3D11CreateDevice, ID3D11Device, ID3D11Device1, ID3D11Texture2D,
        D3D11_BIND_SHADER_RESOURCE, D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX,
        D3D11_RESOURCE_MISC_SHARED_NTHANDLE, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC,
        D3D11_USAGE_DEFAULT,
    };
    use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_NV12, DXGI_SAMPLE_DESC};
    use windows::Win32::Graphics::Dxgi::IDXGIResource1;

    /// Die Wartegrenze bleibt im vernuenftigen Bereich.
    ///
    /// Ohne die Schranken waere `PULSE_PLAYER_BRUECKE_WARTE_MS=0` ein Weg, jedes
    /// Bild ueber den Hauptspeicher zu schicken, und ein sehr grosser Wert holte
    /// das Standbild ohne Ausweg zurueck, das die Grenze gerade behebt.
    ///
    /// Bewusst ohne `set_var`: Umgebungsvariablen sind prozessweit, und die
    /// Tests laufen nebeneinander. Geprueft wird deshalb die Vorgabe und ihr
    /// Verhaeltnis zu [`LANGSAM`], nicht das Lesen.
    #[test]
    fn die_wartegrenze_bleibt_im_vernuenftigen_bereich() {
        assert_eq!(warte_ms(), WARTE_MS_VORGABE, "ohne Variable gilt die Vorgabe");
        assert!(
            WARTE_MS_VORGABE > LANGSAM.as_millis() as u32,
            "die Grenze muss ueber dem liegen, was als „langsam, aber normal\" gilt"
        );
    }

    fn geraet() -> Option<ID3D11Device> {
        let mut d = None;
        // SAFETY: Standardaufruf; alle Ausgaben optional und geprueft.
        let hr = unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                Default::default(),
                Default::default(),
                None,
                D3D11_SDK_VERSION,
                Some(&mut d),
                None,
                None,
            )
        };
        hr.ok().and(d)
    }

    /// **Der Test zu der Falle, an der dieses Modul haengt.**
    ///
    /// `IDXGIKeyedMutex::AcquireSync` liefert `WAIT_TIMEOUT` (`0x00000102`) als
    /// positiven, also ERFOLGREICHEN HRESULT. Der sichere Aufsatz der
    /// windows-Kiste macht daraus `Ok(())` — nicht unterscheidbar vom Erfolg.
    /// Wer [`anmelden`] eines Tages durch `mutex.AcquireSync(0, ms)` ersetzt,
    /// weil das kuerzer aussieht, baut damit lautlos zerrissene Bilder ein: der
    /// Code schriebe in eine Flaeche, die der Renderer noch haelt.
    ///
    /// Dieser Test haelt beides nebeneinander fest — dass der Aufsatz die
    /// Zeitueberschreitung verschluckt und dass [`anmelden`] sie sieht.
    ///
    /// **Er braucht ZWEI Geraete, und das ist kein Beiwerk.** Der erste Anlauf
    /// meldete sich zweimal vom selben Geraet an, in der Annahme, ein
    /// Schluessel-Mutex sei nicht rekursiv und die zweite Anmeldung warte.
    /// Falsch: DXGI erkennt das und antwortet sofort mit
    /// `DXGI_ERROR_INVALID_CALL` (`0x887A0001`) — ein negativer HRESULT, also
    /// ein echter Fehler, und damit gerade NICHT der Fall, um den es hier geht.
    /// Warten tut nur, wer den Mutex ueber ein FREMDES Geraet anfasst, und genau
    /// so liegt es im Betrieb: D3D11 kopiert hinein, D3D12 liest heraus.
    ///
    /// Fehlen die Geraete, ist das ein Befund, kein Fehler.
    #[test]
    fn zeitueberschreitung_kommt_nicht_als_erfolg_zurueck() {
        let (Some(device), Some(fremd)) = (geraet(), geraet()) else {
            eprintln!("PROBE: kein D3D11-Geraet — hier nicht zu pruefen");
            return;
        };

        let desc = D3D11_TEXTURE2D_DESC {
            Width: 64,
            Height: 64,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_NV12,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
            CPUAccessFlags: 0,
            MiscFlags: (D3D11_RESOURCE_MISC_SHARED_NTHANDLE.0
                | D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX.0) as u32,
        };
        let mut tex: Option<ID3D11Texture2D> = None;
        // SAFETY: gueltiges Geraet, Deskriptor vollstaendig belegt.
        unsafe { device.CreateTexture2D(&desc, None, Some(&mut tex)) }.expect("geteilte Textur");
        let tex = tex.unwrap();
        let mutex: IDXGIKeyedMutex = tex.cast().expect("IDXGIKeyedMutex");
        let res: IDXGIResource1 = tex.cast().expect("IDXGIResource1");
        // SAFETY: lebende Ressource; der Handle wird unten geschlossen.
        let handle = unsafe { res.CreateSharedHandle(None, GENERIC_ALL.0, None) }
            .expect("CreateSharedHandle");

        // Dieselbe Textur auf dem fremden Geraet oeffnen — das ist die Rolle,
        // die im Betrieb der Renderer ueber D3D12 spielt.
        let fremd1: ID3D11Device1 = fremd.cast().expect("ID3D11Device1");
        // SAFETY: eigener, noch offener NT-Handle.
        let fremde_tex: ID3D11Texture2D =
            unsafe { fremd1.OpenSharedResource1(handle) }.expect("OpenSharedResource1");
        let fremder_mutex: IDXGIKeyedMutex = fremde_tex.cast().expect("fremder IDXGIKeyedMutex");

        // Anmelden — ab hier gehoert der Schluessel 0 dieser Seite, und niemand
        // gibt ihn frei. Genau der Zustand, den es zu deckeln gilt.
        // SAFETY: lebende Schnittstelle.
        assert!(unsafe { anmelden(&mutex, 1_000, 0) }.expect("erste Anmeldung"));

        // SAFETY: wie oben.
        let fremde =
            unsafe { anmelden(&fremder_mutex, 50, 0) }.expect("kein Fehler, nur Zeitablauf");
        assert!(!fremde, "die Zeitueberschreitung muss als „nicht erlangt\" ankommen");

        // Die Gegenprobe auf den sicheren Aufsatz, um dessentwillen `anmelden`
        // ueberhaupt existiert: er meldet dasselbe Warten als Erfolg.
        // SAFETY: wie oben.
        let ueber_aufsatz = unsafe { fremder_mutex.AcquireSync(0, 50) };
        assert!(
            ueber_aufsatz.is_ok(),
            "Grundannahme dieses Moduls gefallen: der Aufsatz meldet die \
             Zeitueberschreitung inzwischen als Fehler. Dann darf `anmelden` weg."
        );

        // SAFETY: wir halten den Schluessel aus der ersten Anmeldung; der Handle
        // stammt aus `CreateSharedHandle` und ist noch offen.
        unsafe {
            mutex.ReleaseSync(0).expect("ReleaseSync");
            let _ = CloseHandle(handle);
        }
    }
}
