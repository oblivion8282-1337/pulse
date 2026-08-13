//! Die Wache: sitzt der **Host** gerade selbst an Maus und Tastatur?
//!
//! Sie beantwortet die eine Frage, an der der Vorrang hängt (`super`): der Host
//! behält sein Gerät, indem er es anfasst — bewegt er die Maus oder tippt er,
//! wird die Fremdeingabe für [`frist_ms`] verworfen, und jede weitere Regung
//! schiebt die Frist neu.
//!
//! ## Warum ein Hook und nicht ein Blick auf den Zeiger
//!
//! Der naheliegende Weg wäre, `GetCursorPos` mit der zuletzt selbst gesetzten
//! Lage zu vergleichen ([`super::Zustand::zeiger`]). Er trägt aus zwei Gründen
//! nicht: `SendInput` wirkt verzögert, direkt nach einer eigenen Injektion liest
//! man die alte Lage und meldete den Host, der gar nichts getan hat — und vor
//! allem **bewegt ein Klick den Zeiger nicht**. Tastatur und Maustasten wären
//! damit unsichtbar, und gerade sie sind das deutlichste Zeichen, dass der Host
//! selbst arbeitet. Ein systemweiter Low-Level-Hook sieht beides.
//!
//! ## Die eigene Injektion muss draußen bleiben
//!
//! Der Hook sieht auch, was dieser Prozess selbst injiziert. Ungefiltert löste
//! die erste Mausbewegung des Steuernden den Vorrang aus und sperrte ihn für
//! immer aus — die Fernsteuerung schaltete sich selbst ab. Erkannt wird die
//! eigene Eingabe an [`super::injektion::PULSE_MARKE`] in `dwExtraInfo`; die
//! Marke setzt jedes `SendInput` dieses Moduls.
//!
//! **Fremde** Injektion (Makrotasten eines Maustreibers, Bedienhilfen) gilt
//! dagegen ausdrücklich als Host — das `LLMHF_INJECTED`-Flag wird bewusst
//! **nicht** ausgewertet. Die Richtung des Irrtums ist hier alles: ein
//! Fehlalarm kostet den Steuernden fünf Sekunden und heilt von selbst, ein
//! verpasster Alarm kostet den Host die zugesagte Übernahme seines eigenen
//! Rechners.
//!
//! ## Der Faden
//!
//! Low-Level-Hooks verlangen einen Faden mit Nachrichtenschleife; der Rückruf
//! läuft in dessen Zusammenhang. Er tut deshalb so wenig wie möglich — einen
//! Zeitstempel ablegen — und fasst **nie** die Sitzungssperre an: Windows
//! entfernt einen Hook stillschweigend, dessen Rückruf zu lange braucht
//! (`LowLevelHooksTimeout`, Vorgabe 300 ms). Die Übergänge (Vorrang beginnt /
//! endet) entstehen stattdessen an einem 100-ms-Wecker auf einem EIGENEN Faden,
//! und der nimmt die Sperre nur mit `try_lock` (s. [`wecker_starten`] und
//! [`super::vorrang::tick`]).
//!
//! **Was diese Wache nicht kann:** Wird der Hook zur Laufzeit doch entfernt
//! (Zeitüberschreitung unter Last), merkt Windows es niemandem an — es gibt
//! keine Abfrage dafür. Der Rückruf hier legt einen Zeitstempel ab und sonst
//! nichts, er kann die Grenze also nicht reißen; ein Restrisiko bleibt und ist
//! hier notiert statt weggeschwiegen.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, HHOOK, HC_ACTION, KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT,
    PostThreadMessageW, SetWindowsHookExW, UnhookWindowsHookEx, WH_KEYBOARD_LL, WH_MOUSE_LL,
    WM_MOUSEMOVE,
};

/// Wie lange nach der letzten Regung des Hosts seine Eingabe Vorrang hat.
const VORRANG_FRIST_MS: u64 = 5_000;

/// Wie weit der Zeiger des Hosts wandern muss, damit es als Absicht zählt.
///
/// Ohne Schwelle genügte ein angestoßener Tisch oder ein Handballen auf dem
/// Touchpad, um den Steuernden fünf Sekunden auszusperren. Knopf und Taste
/// tragen keine solche Schwelle — die drückt niemand versehentlich.
const BEWEGUNGS_SCHWELLE_PX: u32 = 8;

/// In welchem Zeitfenster sich die Schwelle summieren darf. Danach beginnt die
/// Summe von vorn, damit ein über Minuten kriechender Zeiger (Sensorrauschen)
/// sie nie erreicht.
const BEWEGUNGS_FENSTER_MS: u64 = 250;

/// Abstand der Übergangsprüfung (s. [`wecker_starten`]).
const WECKER_MS: u64 = 100;

/// Wann sich der Host zuletzt geregt hat (`jetzt_ms`), `0` = noch nie.
static LETZTE_REGUNG_MS: AtomicU64 = AtomicU64::new(0);

/// Der Faden der Wache, solange sie steht — die Zahl ist seine Kennung, an die
/// [`stoppen`] sein `WM_QUIT` schickt.
static LAUFEND: Mutex<Option<u32>> = Mutex::new(None);

/// Laufnummer des Weckers (s. [`wecker_starten`]).
static WECKER_NR: AtomicU64 = AtomicU64::new(0);

/// Sammelstelle für die Bewegungsschwelle. Nur der Wache-Faden fasst sie an
/// (der Rückruf läuft in seinem Zusammenhang); die Sperre ist deshalb immer
/// frei und der Rückruf nimmt sie mit `try_lock`, damit er unter keinen
/// Umständen wartet.
static BEWEGUNG: Mutex<Bewegung> = Mutex::new(Bewegung::neu());

#[derive(Clone, Copy)]
struct Bewegung {
    /// Zuletzt gesehene Zeigerlage, `None` = noch keine.
    lage: Option<(i32, i32)>,
    /// Summierter Weg im laufenden Fenster.
    summe: u32,
    /// Wann das Fenster begann.
    seit_ms: u64,
}

impl Bewegung {
    const fn neu() -> Self {
        Self { lage: None, summe: 0, seit_ms: 0 }
    }
}

/// Millisekunden seit dem ersten Blick auf die Uhr — eine monotone Zahl, die in
/// ein Atomic passt (`Instant` tut das nicht).
fn jetzt_ms() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// Die Frist, einmal gelesen. `PULSE_FERN_VORRANG_MS` setzt sie um — gedacht
/// für den Zwei-Geräte-Test, wo fünf Sekunden je Durchgang die Messung
/// beherrschen. Geklemmt, damit ein Vertipper die Zusage nicht aufhebt.
pub fn frist_ms() -> u64 {
    static FRIST: OnceLock<u64> = OnceLock::new();
    *FRIST.get_or_init(|| {
        std::env::var("PULSE_FERN_VORRANG_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .map(|v| v.clamp(100, 60_000))
            .unwrap_or(VORRANG_FRIST_MS)
    })
}

/// Hat der Host gerade Vorrang?
pub fn host_regt_sich() -> bool {
    rest_ms() > 0
}

/// Wie lange der Vorrang noch gilt (0 = kein Vorrang). Geht als Zahl an den
/// Renderer, damit der Steuernde „noch 4 s" sehen kann statt nur „gesperrt".
pub fn rest_ms() -> u64 {
    let letzte = LETZTE_REGUNG_MS.load(Ordering::Relaxed);
    if letzte == 0 {
        return 0;
    }
    frist_ms().saturating_sub(jetzt_ms().saturating_sub(letzte))
}

/// Die Wache aufstellen. Idempotent; `Err` heißt **die Zusage ist auf diesem
/// System nicht zu halten** — der Aufrufer verweigert die Sitzung dann
/// (Begründung in [`super::handschlag`]).
pub fn starten() -> Result<(), String> {
    let mut laufend = LAUFEND.lock().unwrap_or_else(|e| e.into_inner());
    if laufend.is_some() {
        return Ok(());
    }
    // **Der Zähler beginnt bei null, nicht bei „gerade eben".** Die Zustimmung
    // kommt aus einem Klick des Hosts — seine letzte Regung liegt beim Start
    // also Millisekunden zurück, und ohne dieses Zurücksetzen begänne JEDE
    // Sitzung mit fünf Sekunden Vorrang, in denen der Steuernde nichts kann.
    // Nur hier, nicht bei jedem Hello: ein Hello mitten in der Sitzung
    // (Transportwechsel, Notbremse) würde sonst einen laufenden Vorrang löschen,
    // während der Host tippt.
    LETZTE_REGUNG_MS.store(0, Ordering::Relaxed);
    *BEWEGUNG.lock().unwrap_or_else(|e| e.into_inner()) = Bewegung::neu();

    // **Im Testbau keine echten System-Hooks** — aus demselben Grund, aus dem
    // `injektion::pruefspur` dort nicht wirklich injiziert: die Tests laufen auf
    // der Maschine des Entwicklers, und ein systemweiter Eingabe-Hook samt
    // Nachrichtenschleife gehört dort nicht hin. Die Wache gilt als stehend;
    // ihre Regungen setzen die Tests über [`pruefhilfe`].
    if cfg!(test) {
        *laufend = Some(0);
        return Ok(());
    }

    let (melden, warten) = std::sync::mpsc::channel::<Result<u32, String>>();
    std::thread::Builder::new()
        .name("pulse-fern-wache".into())
        .spawn(move || faden(melden))
        .map_err(|e| format!("Wache-Faden nicht startbar: {e}"))?;
    // Kein `recv_timeout`: der Faden meldet sich als Erstes, noch vor der
    // Schleife. Bleibt die Meldung aus, ist der Faden gestorben und der Kanal
    // geschlossen — dann kommt `Err` von selbst.
    let id = match warten.recv() {
        Ok(Ok(id)) => id,
        Ok(Err(grund)) => return Err(grund),
        Err(_) => return Err("Wache-Faden endete vor seiner Meldung".to_string()),
    };
    wecker_starten();
    *laufend = Some(id);
    Ok(())
}

/// Der Wecker, der die Übergänge auslöst — **auf einem eigenen Faden**.
///
/// Er lief zuerst als `WM_TIMER` in der Nachrichtenschleife der Hooks, und das
/// war ein Fehler: die Folgen eines Übergangs sind kein Nichts (Freigabe des
/// Gedrückten, ein WinRT-Aufruf für den Host-Cursor, eine Meldung nach vorn).
/// Solange der Hook-Faden damit beschäftigt ist, beantwortet er keinen
/// Hook-Rückruf — und Windows entfernt einen Hook, dessen Faden nicht binnen
/// `LowLevelHooksTimeout` antwortet. Der Wecker hätte also ausgerechnet die
/// Wache abräumen können, die er bedient. Getrennt kann der Hook-Faden nichts
/// anderes tun als Nachrichten pumpen.
///
/// Beendet wird über die **Laufnummer**: `stoppen` (und jedes neue `starten`)
/// zählt sie hoch, der Wecker sieht beim nächsten Aufwachen eine fremde Nummer
/// und geht. Ein Schalter täte es nicht — ein Neustart innerhalb einer
/// Schlafphase ließe den alten Wecker weiterlaufen, und dann liefen zwei.
fn wecker_starten() {
    let nr = WECKER_NR.fetch_add(1, Ordering::SeqCst) + 1;
    let gebaut = std::thread::Builder::new()
        .name("pulse-fern-wecker".into())
        .spawn(move || {
            loop {
                std::thread::sleep(std::time::Duration::from_millis(WECKER_MS));
                if WECKER_NR.load(Ordering::SeqCst) != nr {
                    return;
                }
                super::vorrang::tick();
            }
        });
    if let Err(e) = gebaut {
        // Kein Grund, die Sitzung zu verweigern: die Wache selbst steht, und
        // der Vorrang GREIFT auch ohne Wecker — er wird bei jeder eingehenden
        // Nachricht nachgeführt (`Sitzung::frames`). Nur sein ENDE bliebe
        // liegen, solange der Steuernde nichts sendet.
        eprintln!("[remote-input] Wecker der Wache nicht startbar ({e}) — Vorrang endet erst mit der nächsten Eingabe");
    }
}

/// Die Wache abbauen. Idempotent, und **ohne auf den Faden zu warten**: dieser
/// Weg läuft auch beim Prozessende und unter der Sitzungssperre — ein `join()`
/// hier hinge, sobald der Faden seinerseits auf ebendiese Sperre wartete. Er
/// hängt die Hooks selbst aus, sobald er das `WM_QUIT` sieht.
pub fn stoppen() {
    let Some(id) = LAUFEND.lock().unwrap_or_else(|e| e.into_inner()).take() else {
        return;
    };
    // Im Testbau steht kein Faden (s. [`starten`]) — und die Regungen der Tests
    // gehören ihnen, nicht dieser Funktion.
    if cfg!(test) {
        return;
    }
    // Die letzte Regung mit abräumen: der Faden hängt seine Hooks erst aus,
    // wenn er das `WM_QUIT` sieht, und ein Wecker, der bis dahin noch fällt,
    // meldete sonst einen Vorrang für eine Sitzung, die es nicht mehr gibt.
    LETZTE_REGUNG_MS.store(0, Ordering::Relaxed);
    // Der Wecker geht über seine Laufnummer (s. [`wecker_starten`]).
    WECKER_NR.fetch_add(1, Ordering::SeqCst);
    // `WM_QUIT` per Zahl: die Konstante ist in `windows` an einem anderen Ort
    // deklariert als die Nachrichten, und eine zweite Einfuhr für einen Wert,
    // der seit Windows 3.0 0x0012 ist, wäre Aufwand ohne Ertrag.
    const WM_QUIT: u32 = 0x0012;
    unsafe {
        let _ = PostThreadMessageW(id, WM_QUIT, WPARAM(0), LPARAM(0));
    }
}

/// Der Faden: Hooks anmelden, Erfolg melden, Nachrichten pumpen, aufräumen.
fn faden(melden: std::sync::mpsc::Sender<Result<u32, String>>) {
    let hooks = match anmelden() {
        Ok(h) => h,
        Err(grund) => {
            let _ = melden.send(Err(grund));
            return;
        }
    };
    if melden.send(Ok(unsafe { GetCurrentThreadId() })).is_err() {
        // Niemand wartet mehr (Aufrufer weg) — nicht anfangen zu wachen.
        abmelden(hooks);
        return;
    }
    // Ab hier tut dieser Faden **nichts** außer Nachrichten pumpen — die
    // Übergänge fährt der Wecker auf seinem eigenen Faden, damit hier nie
    // etwas läuft, das einen Hook-Rückruf aufhalten könnte (s.
    // [`wecker_starten`]).
    //
    // `GetMessageW` liefert 0 bei `WM_QUIT` und -1 bei einem Fehler; beides
    // beendet die Schleife. Ohne Fenster gibt es nichts zu übersetzen und
    // nichts weiterzureichen.
    let mut msg = MSG::default();
    while unsafe { GetMessageW(&mut msg, None, 0, 0) }.0 > 0 {}
    abmelden(hooks);
}

fn anmelden() -> Result<(HHOOK, HHOOK), String> {
    // Ohne Modul-Handle (`None`) und ohne Faden-Bindung (`0`, also systemweit):
    // bei Low-Level-Hooks liegt der Rückruf im eigenen Prozess, Windows braucht
    // dafür keine Bibliothek benannt.
    let maus = unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(maus_wache), None, 0) }
        .map_err(|e| format!("Maus-Wache nicht anmeldbar: {e}"))?;
    let tasten = unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(tasten_wache), None, 0) };
    match tasten {
        Ok(tasten) => Ok((maus, tasten)),
        Err(e) => {
            // Die halbe Wache ist keine: eine Maus-Wache ohne Tastatur-Wache
            // ließe den tippenden Host übersteuert. Also ganz oder gar nicht.
            unsafe {
                let _ = UnhookWindowsHookEx(maus);
            }
            Err(format!("Tasten-Wache nicht anmeldbar: {e}"))
        }
    }
}

fn abmelden((maus, tasten): (HHOOK, HHOOK)) {
    unsafe {
        let _ = UnhookWindowsHookEx(maus);
        let _ = UnhookWindowsHookEx(tasten);
    }
}

/// Eine Regung des Hosts vermerken. `max(1)`, weil `0` „noch nie" bedeutet.
fn vermerken() {
    LETZTE_REGUNG_MS.store(jetzt_ms().max(1), Ordering::Relaxed);
}

/// Ist die eigene Injektion? Dann geht sie die Wache nichts an.
fn eigene(extra: usize) -> bool {
    extra == super::injektion::PULSE_MARKE
}

unsafe extern "system" fn maus_wache(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        let daten = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
        if !eigene(daten.dwExtraInfo) {
            if wparam.0 as u32 == WM_MOUSEMOVE {
                // Nur Bewegung trägt eine Schwelle (s. [`BEWEGUNGS_SCHWELLE_PX`]).
                if let Ok(mut b) = BEWEGUNG.try_lock()
                    && bewegung_zaehlt(&mut b, jetzt_ms(), daten.pt.x, daten.pt.y)
                {
                    vermerken();
                }
            } else {
                // Knopf und Rad: sofort.
                vermerken();
            }
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

unsafe extern "system" fn tasten_wache(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        let daten = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        // Auch das Loslassen zählt: es gehört zu einem Druck, den wir
        // womöglich verpasst haben (Sitzungsbeginn mitten im Tippen).
        if !eigene(daten.dwExtraInfo) {
            vermerken();
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

/// Zählt diese Zeigerlage als gewollte Bewegung des Hosts?
///
/// Reine Rechnung, damit sie ohne Windows und ohne Hook prüfbar ist: der Weg
/// zur vorigen Lage summiert sich über ein Zeitfenster, und erst die Schwelle
/// löst aus. Nach dem Auslösen beginnt die Summe von vorn — sonst zählte jede
/// weitere Regung derselben Bewegung noch einmal.
fn bewegung_zaehlt(b: &mut Bewegung, jetzt_ms: u64, x: i32, y: i32) -> bool {
    let vorige = b.lage.replace((x, y));
    let Some((vx, vy)) = vorige else {
        // Die erste gesehene Lage ist der Nullpunkt, keine Bewegung: beim
        // Aufstellen der Wache steht der Zeiger irgendwo, und das ist kein
        // Zutun des Hosts.
        b.seit_ms = jetzt_ms;
        return false;
    };
    if jetzt_ms.saturating_sub(b.seit_ms) > BEWEGUNGS_FENSTER_MS {
        b.summe = 0;
        b.seit_ms = jetzt_ms;
    }
    let weg = x.abs_diff(vx) + y.abs_diff(vy);
    b.summe = b.summe.saturating_add(weg);
    if b.summe < BEWEGUNGS_SCHWELLE_PX {
        return false;
    }
    b.summe = 0;
    b.seit_ms = jetzt_ms;
    true
}

/// Was die Sitzungs-Tests brauchen, um den Vorrang zu stellen: im Testbau
/// steht keine echte Wache (s. [`starten`]), also gibt es auch nichts, was
/// sich regen könnte. Diese beiden Griffe setzen den Zustand, den der Hook
/// sonst setzte — mehr nicht.
#[cfg(test)]
pub(super) mod pruefhilfe {
    use super::{LETZTE_REGUNG_MS, Ordering, vermerken};

    /// Der Host hat sich gerade geregt.
    pub(in crate::remote_input) fn regung() {
        vermerken();
    }

    /// Der Host hat lange nichts getan.
    pub(in crate::remote_input) fn ruhe() {
        LETZTE_REGUNG_MS.store(0, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frisch() -> Bewegung {
        Bewegung::neu()
    }

    /// Die erste Lage ist der Nullpunkt — beim Aufstellen der Wache steht der
    /// Zeiger irgendwo, und das ist keine Regung des Hosts.
    #[test]
    fn erste_lage_zaehlt_nicht() {
        let mut b = frisch();
        assert!(!bewegung_zaehlt(&mut b, 0, 500, 500));
    }

    /// Ein Ruckeln unterhalb der Schwelle löst nichts aus — der Fall, für den
    /// die Schwelle da ist (angestoßener Tisch, Handballen auf dem Touchpad).
    #[test]
    fn zittern_unter_der_schwelle_loest_nicht_aus() {
        let mut b = frisch();
        bewegung_zaehlt(&mut b, 0, 500, 500);
        for (i, (x, y)) in [(501, 500), (500, 501), (501, 501), (500, 500)].iter().enumerate() {
            assert!(
                !bewegung_zaehlt(&mut b, i as u64 * 10, *x, *y),
                "({x},{y}) hätte nicht auslösen dürfen"
            );
        }
    }

    /// Eine gewollte Bewegung löst aus, sobald der Weg die Schwelle erreicht —
    /// auch über mehrere Ereignisse hinweg, denn eine Maus meldet in kleinen
    /// Schritten.
    #[test]
    fn gewollte_bewegung_loest_aus() {
        let mut b = frisch();
        bewegung_zaehlt(&mut b, 0, 500, 500);
        assert!(!bewegung_zaehlt(&mut b, 10, 503, 500));
        assert!(!bewegung_zaehlt(&mut b, 20, 506, 500));
        assert!(bewegung_zaehlt(&mut b, 30, 509, 500), "9 px müssen reichen");
    }

    /// Ein Sprung über die Schwelle löst sofort aus.
    #[test]
    fn sprung_loest_sofort_aus() {
        let mut b = frisch();
        bewegung_zaehlt(&mut b, 0, 500, 500);
        assert!(bewegung_zaehlt(&mut b, 10, 900, 200));
    }

    /// **Der Grund für das Zeitfenster:** ein über Minuten kriechender Zeiger
    /// (Sensorrauschen, schräger Tisch) darf die Schwelle nie erreichen. Jeder
    /// Schritt für sich ist winzig, und zwischen ihnen verfällt die Summe.
    #[test]
    fn kriechen_ueber_die_zeit_erreicht_die_schwelle_nie() {
        let mut b = frisch();
        bewegung_zaehlt(&mut b, 0, 0, 0);
        for i in 1..200u64 {
            let t = i * (BEWEGUNGS_FENSTER_MS + 50);
            assert!(
                !bewegung_zaehlt(&mut b, t, i as i32, 0),
                "Schritt {i} (1 px je {}ms) hätte nicht auslösen dürfen",
                BEWEGUNGS_FENSTER_MS + 50
            );
        }
    }

    /// Nach dem Auslösen beginnt die Summe von vorn — sonst löste jede weitere
    /// Regung derselben Bewegung erneut aus und die Schwelle wäre wirkungslos.
    #[test]
    fn nach_dem_ausloesen_beginnt_die_summe_von_vorn() {
        let mut b = frisch();
        bewegung_zaehlt(&mut b, 0, 0, 0);
        assert!(bewegung_zaehlt(&mut b, 10, 20, 0));
        assert!(!bewegung_zaehlt(&mut b, 20, 21, 0), "1 px nach dem Auslösen");
    }

    /// Ohne Regung gibt es keinen Vorrang — und die Frist ist eine echte Zahl.
    #[test]
    fn ohne_regung_kein_vorrang() {
        LETZTE_REGUNG_MS.store(0, Ordering::Relaxed);
        assert_eq!(rest_ms(), 0);
        assert!(!host_regt_sich());
        assert!(frist_ms() >= 100);
    }
}
