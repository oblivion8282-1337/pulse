//! `pulse-kms-helfer` — reicht den Scanout-Puffer eines Bildschirmausgangs als
//! DMABUF an Pulse weiter. **Das einzige Stueck Pulse mit erhoehten Rechten.**
//!
//! ## Wozu es das gibt
//!
//! Die GEM-Handles aus `DRM_IOCTL_MODE_GETFB2` gibt der Kernel nur an
//! DRM-Master oder an Traeger von `CAP_SYS_ADMIN` heraus (gemessen, Messakte
//! `hdr-2026-08-07-scanout-linux-nvidia.json`, Befund M8). Ohne Handle kein
//! DMABUF, ohne DMABUF kein Bild — und ohne dieses Bild kein HDR unter Linux,
//! weil der Portal-Weg auch bei eingeschaltetem HDR ein SDR-Bild liefert.
//! Ein Flatpak kann diese Rechte nicht selbst tragen: die Sandbox setzt
//! `no_new_privs`, gesetzte Datei-Faehigkeiten verfallen beim Betreten. Also
//! haelt sie ein kleines Programm **ausserhalb** und reicht das Bild herein.
//!
//! ## Warum `setcap cap_sys_admin+ep` und nicht setuid root
//!
//! Beides gibt Rechte, aber nicht dieselbe Menge. `setuid root` gaebe diesem
//! Programm **alle** Faehigkeiten des Systems — Dateien beliebig lesen und
//! schreiben, Prozesse toeten, Module laden — und dazu eine zweite Kennung, an
//! der jeder Fehler im Programm zum Rechteproblem des ganzen Rechners wird.
//! `cap_sys_admin+ep` gibt genau die eine Faehigkeit, an der der Kernel die
//! GEM-Handles festmacht; die Kennung bleibt die des Nutzers, seine
//! Datei-Rechte bleiben seine. Das ist immer noch eine maechtige Faehigkeit
//! (CAP_SYS_ADMIN ist die Sammelkiste des Kernels), aber es ist die kleinste,
//! die diese eine ioctl oeffnet, und sie kommt ohne Kennungswechsel aus.
//! Deshalb macht gpu-screen-recorder es ebenso (`extra/meson_post_install.sh`).
//!
//! ## Was es kann — und was ausdruecklich nicht
//!
//! Eine Operation: „gib mir das Bild von Ausgang X". Kein Netz, keine
//! Oberflaeche, keine Einstellungen, kein Encoder, kein Schreiben in die
//! Anzeige. Es nimmt keinen Geraetepfad von aussen entgegen (es sucht die
//! Karte selbst) und keinen Socket-Pfad ausserhalb des eigenen
//! Laufzeitverzeichnisses.
//!
//! ## Wer mit ihm reden darf
//!
//! Wer mit ihm redet, liest den Bildschirm mit. Drei Schranken: der Socket
//! liegt im Laufzeitverzeichnis des Nutzers (`/run/user/<uid>/`), das
//! Verzeichnis traegt 0700 und der Socket 0600, und jede Verbindung wird ueber
//! `SO_PEERCRED` gegen die eigene Kennung geprueft. Die dritte ist die, auf die
//! es ankommt — sie haelt auch dann, wenn die ersten beiden durch eine
//! unglueckliche Umgebung umgangen wurden.
//!
//! ## Lebensdauer
//!
//! Es endet von selbst, wenn der letzte Client weg ist (Schonfrist s.
//! [`LEERLAUF_S`]). Ein Dienst, der dauerhaft mit `CAP_SYS_ADMIN` in der
//! Sitzung wartet, waere mehr Angriffsflaeche fuer weniger Nutzen; gebraucht
//! wird er nur, solange ein HDR-Stream laeuft. Der Preis ist ein Programmstart
//! je Stream — im Millisekundenbereich, gegen einen Streamstart, der ohnehin
//! ein Portal oder einen Encoder aufbaut.

use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};

use pulse_kms_helfer::karte::Karte;

mod bedienen;
use bedienen::bedienen;
use pulse_kms_helfer::protokoll as p;
use pulse_kms_helfer::uebertragung as u;

/// Schonfrist nach dem letzten Client. Nicht null, damit ein Stream-Neustart
/// (stop, dann sofort start) nicht jedes Mal einen Programmstart kostet.
const LEERLAUF_S: u64 = 10;
/// Wenn ueberhaupt nie jemand kommt, ist der Aufrufer gestorben, bevor er
/// verbinden konnte. Dann nicht ewig liegenbleiben.
const ANLAUF_S: u64 = 15;
/// Mehr gleichzeitige Zuhoerer braucht niemand: ein Stream, ein Client. Die
/// Grenze steht gegen ein Programm, das in einer Schleife verbindet.
const CLIENTS_MAX: usize = 8;

fn main() {
    if let Err(e) = laufen() {
        eprintln!("pulse-kms-helfer: {e:#}");
        std::process::exit(1);
    }
}

fn laufen() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let mut sockpfad: Option<PathBuf> = None;
    while let Some(a) = args.next() {
        match a.as_str() {
            "--socket" => sockpfad = args.next().map(PathBuf::from),
            "--fassung" => {
                // Der Handschlag ueber den Socket ist der verbindliche Weg;
                // das hier ist fuer das Installationsskript und fuer Menschen.
                println!("pulse-kms-helfer Protokollfassung {}", p::FASSUNG);
                return Ok(());
            }
            "--hilfe" | "-h" => {
                println!(
                    "pulse-kms-helfer --socket <pfad im eigenen Laufzeitverzeichnis>\n\
                     Reicht Bildschirm-Scanout-Puffer als DMABUF an Pulse weiter.\n\
                     Wird von Pulse selbst gestartet und beendet sich von allein."
                );
                return Ok(());
            }
            _ => bail!("unbekanntes Argument (erlaubt: --socket, --fassung, --hilfe)"),
        }
    }
    let sockpfad = sockpfad.ok_or_else(|| anyhow!("--socket fehlt"))?;
    pfad_pruefen(&sockpfad)?;

    let horcher = horcher_aufsetzen(&sockpfad)?;
    let ergebnis = schleife(horcher.as_raw_fd());
    // Aufraeumen in jedem Fall: ein liegengebliebener Socket sieht fuer den
    // naechsten Start aus wie ein laufender Helfer.
    let _ = std::fs::remove_file(&sockpfad);
    ergebnis
}

/// Der Socket muss im Laufzeitverzeichnis DIESES Nutzers liegen.
///
/// Der Pfad kommt vom Aufrufer, und der Aufrufer ist ein Programm mit weniger
/// Rechten als dieses hier. Ein Pfad ausserhalb waere die Moeglichkeit, ein
/// Verzeichnis anzulegen oder eine Datei zu ueberschreiben, an die der Aufrufer
/// selbst nicht herankaeme. Die Pruefung ist billig und schliesst das aus.
fn pfad_pruefen(pfad: &Path) -> Result<()> {
    let uid = unsafe { libc::geteuid() };
    let erlaubt = PathBuf::from(format!("/run/user/{uid}"));
    if !pfad.starts_with(&erlaubt) {
        bail!("der Socket muss unter /run/user/{uid}/ liegen");
    }
    if pfad.components().any(|c| c.as_os_str() == "..") {
        bail!("der Socket-Pfad darf kein '..' enthalten");
    }
    Ok(())
}

fn horcher_aufsetzen(pfad: &Path) -> Result<OwnedFd> {
    if let Some(dir) = pfad.parent() {
        if !dir.exists() {
            std::fs::create_dir_all(dir).with_context(|| "Socket-Verzeichnis anlegen")?;
        }
        // 0700: nur dieser Nutzer darf ueberhaupt hineinsehen.
        let rechte = std::fs::Permissions::from_mode(0o700);
        let _ = std::fs::set_permissions(dir, rechte);
    }
    // Ein Ueberbleibsel eines abgestuerzten Vorgaengers. Wenn dort noch jemand
    // horcht, scheitert unser `bind` gleich darauf ohnehin nicht — der alte
    // Eintrag ist dann weg und der alte Helfer bekommt keine neuen Clients
    // mehr, endet also nach seiner Leerlauffrist. Das ist die harmlosere
    // Richtung: zwei kurz nebeneinander laufende Helfer statt keiner.
    let _ = std::fs::remove_file(pfad);

    let fd = unsafe {
        libc::socket(
            libc::AF_UNIX,
            libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC,
            0,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error()).context("Socket anlegen");
    }
    let horcher = unsafe { OwnedFd::from_raw_fd(fd) };
    let adresse = u::adresse_aus_pfad(pfad).context("Socket-Adresse aufbauen")?;

    // Die Rechte des Socket entstehen beim `bind` aus der umask — nachtraeglich
    // zu chmod'en liesse ein Zeitfenster offen, in dem er offen dasteht.
    let vorher = unsafe { libc::umask(0o177) };
    let rc = unsafe {
        libc::bind(
            horcher.as_raw_fd(),
            (&raw const adresse).cast(),
            size_of::<libc::sockaddr_un>() as libc::socklen_t,
        )
    };
    unsafe { libc::umask(vorher) };
    if rc != 0 {
        return Err(std::io::Error::last_os_error()).context("Socket binden");
    }
    if unsafe { libc::listen(horcher.as_raw_fd(), 4) } != 0 {
        return Err(std::io::Error::last_os_error()).context("horchen");
    }
    eprintln!("pulse-kms-helfer: bereit, Protokollfassung {}", p::FASSUNG);
    Ok(horcher)
}

/// Die Hauptschleife: Verbindungen annehmen, Anfragen beantworten, im Leerlauf
/// enden.
fn schleife(horcher: RawFd) -> Result<()> {
    let mut karte: Option<Karte> = None;
    let mut clients: Vec<OwnedFd> = Vec::new();
    let mut seit_letztem = Instant::now();
    let mut je_bedient = false;

    loop {
        let mut fds = vec![libc::pollfd { fd: horcher, events: libc::POLLIN, revents: 0 }];
        fds.extend(clients.iter().map(|c| libc::pollfd {
            fd: c.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        }));
        let rc = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, 1000) };
        if rc < 0 {
            let e = std::io::Error::last_os_error();
            if e.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(e).context("poll");
        }

        if fds[0].revents & libc::POLLIN != 0 {
            if let Some(c) = annehmen(horcher) {
                if clients.len() < CLIENTS_MAX {
                    clients.push(c);
                    seit_letztem = Instant::now();
                    je_bedient = true;
                }
            }
        }

        let mut weg = Vec::new();
        // `take`: gerade eben kann ein Client dazugekommen sein, fuer den es in
        // `fds` noch keinen Eintrag gibt. Er ist erst in der naechsten Runde an
        // der Reihe — ohne diese Grenze griffe die Schleife daneben.
        for (i, c) in clients.iter().enumerate().take(fds.len() - 1) {
            if fds[i + 1].revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) == 0 {
                continue;
            }
            match bedienen(c.as_raw_fd(), &mut karte) {
                Ok(true) => seit_letztem = Instant::now(),
                Ok(false) | Err(_) => weg.push(i),
            }
        }
        for i in weg.into_iter().rev() {
            clients.remove(i);
            seit_letztem = Instant::now();
        }

        if clients.is_empty() {
            let frist = if je_bedient { LEERLAUF_S } else { ANLAUF_S };
            if seit_letztem.elapsed() > Duration::from_secs(frist) {
                eprintln!("pulse-kms-helfer: kein Client mehr, beende");
                return Ok(());
            }
        }
    }
}

fn annehmen(horcher: RawFd) -> Option<OwnedFd> {
    let fd = unsafe { libc::accept4(horcher, std::ptr::null_mut(), std::ptr::null_mut(), libc::SOCK_CLOEXEC) };
    if fd < 0 {
        return None;
    }
    let client = unsafe { OwnedFd::from_raw_fd(fd) };
    // **Hier haengt die Sicherheit dieses Programms.** Ein anderer Benutzer
    // bekommt kein Bild, auch wenn er den Socket irgendwie erreicht hat.
    if let Err(e) = u::gegenueber_ist_derselbe_nutzer(client.as_raw_fd()) {
        eprintln!("pulse-kms-helfer: Verbindung abgewiesen: {e}");
        return None;
    }
    Some(client)
}
