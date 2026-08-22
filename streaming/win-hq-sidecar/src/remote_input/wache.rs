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
//! Lage zu vergleichen (der gemerkten Zeigerlage der Sitzung). Er trägt aus zwei Gründen
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
//! `Sitzung::vorrang_tick` in `pulse_fernsteuerung::sitzung`).
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

use pulse_fernsteuerung::bewegung::{self, Bewegung};

/// Wie lange nach der letzten Regung des Hosts seine Eingabe Vorrang hat.
const VORRANG_FRIST_MS: u64 = 5_000;

/// Abstand der Übergangsprüfung (s. [`wecker_starten`]).
const WECKER_MS: u64 = 100;

/// Wann sich der Host zuletzt geregt hat (`jetzt_ms`), `0` = noch nie.
static LETZTE_REGUNG_MS: AtomicU64 = AtomicU64::new(0);

/// Der Faden der Wache, solange sie steht — die Zahl ist seine Kennung, an die
/// [`stoppen`] sein `WM_QUIT` schickt.
static LAUFEND: Mutex<Option<u32>> = Mutex::new(None);

/// Laufnummer des Weckers (s. [`wecker_starten`]).
static WECKER_NR: AtomicU64 = AtomicU64::new(0);

/// Sammelstelle für die Bewegungsschwelle. Im Betrieb fasst sie nur der
/// Hook-Rückruf an (der läuft im Zusammenhang des Wache-Fadens); die Sperre ist
/// deshalb praktisch immer frei, und er nimmt sie mit `try_lock`, damit er
/// unter keinen Umständen wartet. Der einzige weitere Zugriff ist das
/// Zurücksetzen in [`starten`] — aus dem Faden des Aufrufers, aber zu einem
/// Zeitpunkt, an dem noch kein Hook hängt.
static BEWEGUNG: Mutex<Bewegung> = Mutex::new(Bewegung::neu());

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
    // **Der Zähler beginnt bei null.** Zu räumen gibt es hier nur eine
    // Hinterlassenschaft: [`stoppen`] nullt zwar selbst, hängt die Hooks aber
    // nicht sofort aus (es wartet bewusst nicht auf den Faden) — regt sich der
    // Host in diesem Spalt, trägt der noch lebende alte Hook einen Zeitstempel
    // nach, und die nächste Sitzung begänne mit einem Vorrang, den niemand
    // ausgelöst hat. Nur hier, nicht bei jedem Hello: ein Hello mitten in der
    // Sitzung (Transportwechsel, Notbremse) würde sonst einen laufenden
    // Vorrang löschen, während der Host tippt.
    //
    // **Was das NICHT leistet:** den Zeitpunkt bestimmt der Steuernde, denn
    // gerufen wird aus dem Handschlag. Ein Sidecar, der sein erstes Hello erst
    // spät sieht, stellt seine Wache erst dann auf und weiß nichts von einer
    // Regung davor. Die maschinenweite Sperre dagegen sitzt im Renderer des
    // Hosts (`web/src/lib/remote/vorrang.ts`, Begründung dort).
    LETZTE_REGUNG_MS.store(0, Ordering::Relaxed);
    *BEWEGUNG.lock().unwrap_or_else(|e| e.into_inner()) = Bewegung::neu();

    // **Im Testbau keine echten System-Hooks** — aus demselben Grund, aus dem
    // die Injektion im Testbau nicht wirklich abfeuert: die Tests laufen auf
    // der Maschine des Entwicklers, und ein systemweiter Eingabe-Hook samt
    // Nachrichtenschleife gehört dort nicht hin. Die Wache gilt als stehend;
    // ihre Regungen setzen die Tests direkt über [`vermerken`].
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
                super::sitzung().vorrang_tick();
                // Auf demselben Wecker, weil dieselbe Bedingung gilt: er läuft
                // genau, solange eine Fernsteuerung läuft. Die Abfrage der
                // Zeigerform kostet einen Handle-Vergleich und darf deshalb
                // keinen eigenen Faden bekommen (s. `super::zeigerform`).
                super::zeigerform::tick();
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
    let ich = unsafe { GetCurrentThreadId() };
    if melden.send(Ok(ich)).is_err() {
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
    // **Den eigenen Eintrag räumen, falls er noch uns meint** (Bughunt
    // 2026-08-14). Der Regelfall ist [`stoppen`], das ihn vorher entnimmt —
    // aber die Schleife endet auch von selbst, wenn `GetMessageW` einen Fehler
    // meldet. Bliebe der Eintrag dann stehen, hätte das zwei üble Folgen:
    // [`starten`] meldete für den Rest der Prozesslebenszeit Erfolg, obwohl
    // kein Hook mehr hängt (die Startverweigerung fiele lautlos um, der Host
    // bekäme eine Sitzung ohne Vorrang), und ein späteres `WM_QUIT` ginge an
    // eine Faden-Kennung, die Windows längst neu vergeben hat — im eigenen
    // Prozess trifft das im schlimmsten Fall die Nachrichtenschleife der
    // Aufnahme.
    let mut laufend = LAUFEND.lock().unwrap_or_else(|e| e.into_inner());
    if *laufend == Some(ich) {
        *laufend = None;
        WECKER_NR.fetch_add(1, Ordering::SeqCst);
        eprintln!("[remote-input] Wache unerwartet beendet — nächste Sitzung stellt sie neu auf");
    }
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
        let eigen = eigene(daten.dwExtraInfo);
        if wparam.0 as u32 == WM_MOUSEMOVE {
            // **Auch die eigene Bewegung wird eingetragen**, nur eben nicht
            // gezählt (s. `bewegung::zaehlt`) — sonst misst die Schwelle
            // Unsinn. Nur Bewegung trägt überhaupt eine Schwelle.
            if let Ok(mut b) = BEWEGUNG.try_lock()
                && bewegung::zaehlt(&mut b, jetzt_ms(), daten.pt.x, daten.pt.y, eigen)
            {
                vermerken();
            }
        } else if !eigen {
            // Knopf und Rad: sofort.
            vermerken();
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Ohne Regung gibt es keinen Vorrang — und die Frist ist eine echte Zahl.
    ///
    /// Die Bewegungsschwelle selbst (`bewegung::zaehlt`) samt ihrer acht
    /// Tests steht jetzt in `pulse_fernsteuerung::bewegung`.
    #[test]
    fn ohne_regung_kein_vorrang() {
        LETZTE_REGUNG_MS.store(0, Ordering::Relaxed);
        assert_eq!(rest_ms(), 0);
        assert!(!host_regt_sich());
        assert!(frist_ms() >= 100);
    }
}
