//! Die Gegenstelle zum Helfer-Programm: verbinden, notfalls starten, Bilder
//! holen.
//!
//! **Warum es diesen Umweg gibt.** Der Kernel gibt die GEM-Handles des
//! Scanouts nur an DRM-Master oder an Traeger von `CAP_SYS_ADMIN` heraus. Ein
//! Flatpak kann diese Faehigkeit nicht tragen — die Sandbox setzt
//! `no_new_privs`, gesetzte Datei-Faehigkeiten verfallen beim Betreten. Also
//! haelt sie ein kleines Programm ausserhalb (`pulse-kms-helfer`, Quelltext in
//! `kms-helfer/`), und die Bilder reisen als Dateideskriptoren ueber einen
//! Unix-Socket herein.
//!
//! **Der Handschlag ist kein Beiwerk.** Die App aktualisiert sich selbst, der
//! Helfer nicht — er liegt auf dem Host. Ohne Fassungsabgleich haetten wir in
//! drei Monaten Fehlerbilder, die niemand deutet. Deshalb traegt jede Anfrage
//! ihre Fassung, und eine Absage nennt **beide** Fassungen und den Befehl zum
//! Nachinstallieren. Der Unterschied zwischen „HDR nicht verfuegbar" und „der
//! installierte Helfer ist aelter als die App, hier ist der Befehl" entscheidet,
//! ob jemand das in zehn Sekunden loest oder gar nicht.

use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd, OwnedFd};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};

use pulse_kms_helfer::protokoll as p;
use pulse_kms_helfer::uebertragung as u;

use super::kms::als_frame;
use super::pipewire_stream::{DmabufFrame, DmabufPlane};

/// Anwendungskennung des Flatpak — dieselbe wie in `packaging/`.
const FLATPAK_ID: &str = "com.howispulse.Pulse";
/// Wohin das Einrichtungsskript den Helfer legt. Ein fester Ort, damit die
/// Meldung an den Nutzer und das Skript dasselbe meinen; abweichen kann man mit
/// `$PULSE_KMS_HELFER`.
const HOST_PFAD: &str = "/usr/local/libexec/pulse-kms-helfer";
/// Verzeichnis im Laufzeitverzeichnis des Nutzers. **Nicht `pulse`** — das
/// gehoert PulseAudio, und der Flatpak bindet es bereits fuer den Ton.
const SOCKET_DIR: &str = "pulse-hq";
const SOCKET_NAME: &str = "kms.sock";

fn im_flatpak() -> bool {
    std::env::var_os("FLATPAK_ID").is_some()
}

/// Der Socket-Pfad. Innerhalb des Flatpak zeigt derselbe absolute Pfad auf
/// dasselbe Verzeichnis wie auf dem Host — dafuer sorgt
/// `--filesystem=xdg-run/pulse-hq:create` im Manifest. Genau deshalb kann der
/// Pfad hier gerechnet und dem Helfer als Argument mitgegeben werden.
pub fn socket_pfad() -> PathBuf {
    let laufzeit = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(format!("/run/user/{}", unsafe { libc::geteuid() })));
    laufzeit.join(SOCKET_DIR).join(SOCKET_NAME)
}

/// Der Befehl, den der Nutzer einmal ausfuehrt. Er steht in jeder Meldung, die
/// den Helfer vermisst — eine Absage ohne Abhilfe fuehrt zur Fehlersuche an der
/// falschen Stelle.
///
/// Der Pfad wird **nicht geraten**: `flatpak info --show-location` ist der
/// dokumentierte Weg zum Ablageort einer Anwendung und beantwortet nebenbei die
/// Frage, ob sie im System oder im Benutzerverzeichnis installiert ist.
pub fn installationsbefehl() -> String {
    if im_flatpak() {
        format!(
            "sudo \"$(flatpak info --show-location {FLATPAK_ID})/files/libexec/pulse-kms-helfer-einrichten\""
        )
    } else {
        "sudo scripts/pulse-kms-helfer-einrichten.sh   (aus dem Pulse-Quellbaum)".to_string()
    }
}

/// Liegt der Helfer da, wo wir ihn erwarten?
///
/// **Das ist eine Auskunft, keine Zusage.** Ob er die Berechtigung wirklich
/// traegt und ob seine Protokollfassung passt, entscheidet der Handschlag beim
/// Start. Hier soll nur die Oberflaeche sagen koennen, warum das Kaestchen
/// nicht greift — und ein `false`, das eigentlich `true` waere, ist dabei die
/// harmlosere Richtung.
///
/// Aus der Sandbox heraus liegt das Wurzelverzeichnis des Hosts unter
/// `/run/host` (Flatpak legt es dort ab, wenn die Anwendung Zugriff auf das
/// Dateisystem hat — Pulse hat `--filesystem=host:ro`). Findet sich dort
/// nichts, gilt der Helfer als nicht eingerichtet.
pub fn vorhanden() -> bool {
    if let Some(p) = std::env::var_os("PULSE_KMS_HELFER") {
        return std::path::Path::new(&p).exists();
    }
    // Laeuft er gerade, ist die Frage ohnehin beantwortet.
    if socket_pfad().exists() {
        return true;
    }
    if !im_flatpak() && neben_dem_sidecar().is_some() {
        return true;
    }
    let host = PathBuf::from("/run/host").join(HOST_PFAD.trim_start_matches('/'));
    std::path::Path::new(HOST_PFAD).exists() || host.exists()
}

/// Eine offene Verbindung zum Helfer.
pub struct Helfer {
    sock: OwnedFd,
}

impl Helfer {
    /// Verbinden — und wenn niemand da ist, den Helfer starten und noch einmal
    /// versuchen.
    pub fn verbinden_oder_starten() -> Result<Self> {
        let pfad = socket_pfad();
        if let Ok(h) = verbinden(&pfad) {
            return Ok(h);
        }
        starten(&pfad)?;
        // Der Helfer bindet seinen Socket innerhalb weniger Millisekunden; die
        // Frist ist so bemessen, dass auch ein `flatpak-spawn` ueber den Bus
        // hineinpasst.
        let bis = Instant::now() + Duration::from_secs(5);
        let mut letzter = anyhow!("kein Versuch");
        while Instant::now() < bis {
            match verbinden(&pfad) {
                Ok(h) => return Ok(h),
                Err(e) => letzter = e,
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Err(letzter.context(format!(
            "der Helfer fuer die Bildschirmaufnahme antwortet nicht. Ohne ihn gibt es unter \
             Linux kein HDR (der Kernel gibt die Bildpuffer nur an Programme mit erhoehten \
             Rechten). Einmalig einrichten: {}",
            installationsbefehl()
        )))
    }

    /// Ein Bild des Ausgangs holen.
    pub fn bild(&mut self, ausgang: &str, pts: u64, epoch: u64) -> Result<DmabufFrame> {
        let fd = self.sock.as_raw_fd();
        u::senden(fd, &p::Anfrage::bild(ausgang).kodieren(), &[]).context("Anfrage senden")?;
        let mut puffer = [0u8; p::ANTWORT_LEN];
        let (n, fds) = u::empfangen(fd, &mut puffer).context("Antwort lesen")?;
        if n == 0 {
            bail!("der Helfer hat die Verbindung beendet");
        }
        let antwort = p::Antwort::dekodieren(&puffer[..n]).map_err(|e| anyhow!("{e}"))?;
        pruefen(&antwort)?;
        if fds.len() != antwort.ebenen.len() || fds.is_empty() {
            bail!(
                "der Helfer meldete {} Bildebenen, schickte aber {} Deskriptoren",
                antwort.ebenen.len(),
                fds.len()
            );
        }
        let planes = fds
            .into_iter()
            .zip(&antwort.ebenen)
            .map(|(fd, e)| DmabufPlane {
                fd: fd.into_raw_fd(),
                offset: e.offset,
                stride: e.pitch as i32,
            })
            .collect();
        Ok(als_frame(
            antwort.width,
            antwort.height,
            antwort.fourcc,
            antwort.modifier,
            planes,
            pts,
            epoch,
        ))
    }
}

/// Der Rohdeskriptor der Verbindung. **Nur fuer Proben** (`examples/`): der
/// Handschlag laesst sich sonst nicht mit einer FALSCHEN Fassung pruefen, weil
/// [`Helfer::bild`] immer die richtige sendet — und eine Absage, die nie
/// nachgestellt wurde, ist eine Behauptung.
pub fn sock_fd(h: &mut Helfer) -> std::os::fd::RawFd {
    h.sock.as_raw_fd()
}

/// Die Antwort deuten — und im Fehlerfall so, dass der Nutzer etwas damit
/// anfangen kann.
fn pruefen(antwort: &p::Antwort) -> Result<()> {
    match antwort.ergebnis {
        p::OK => Ok(()),
        p::FEHLER_FASSUNG => bail!(
            "der installierte Helfer spricht Fassung {}, diese App erwartet Fassung {} — {}. \
             Abhilfe: denselben Befehl noch einmal ausfuehren: {}",
            antwort.fassung,
            p::FASSUNG,
            if antwort.fassung < p::FASSUNG {
                "der Helfer ist aelter als die App"
            } else {
                "der Helfer ist neuer als die App (haengt die App an einer alten Fassung fest?)"
            },
            installationsbefehl()
        ),
        p::FEHLER_RECHTE => bail!(
            "der Helfer laeuft, traegt aber die noetige Berechtigung nicht (cap_sys_admin). \
             Das passiert, wenn er von Hand kopiert statt eingerichtet wurde. Abhilfe: {}",
            installationsbefehl()
        ),
        p::FEHLER_AUSGANG => bail!("der Helfer kennt diesen Bildschirmausgang nicht (mehr)"),
        _ => bail!("der Helfer meldet: {}", antwort.meldung),
    }
}

fn verbinden(pfad: &std::path::Path) -> Result<Helfer> {
    let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC, 0) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error()).context("Socket anlegen");
    }
    let sock = unsafe { OwnedFd::from_raw_fd(fd) };
    let adresse = u::adresse_aus_pfad(pfad).context("Socket-Adresse aufbauen")?;
    let rc = unsafe {
        libc::connect(
            sock.as_raw_fd(),
            (&raw const adresse).cast(),
            size_of::<libc::sockaddr_un>() as libc::socklen_t,
        )
    };
    if rc != 0 {
        return Err(std::io::Error::last_os_error()).context("mit dem Helfer verbinden");
    }
    // Auch diese Richtung pruefen: was am anderen Ende horcht, muss uns
    // gehoeren. Sonst reichte ein fremder Socket an derselben Stelle, um zu
    // sehen, welchen Ausgang wir aufnehmen.
    u::gegenueber_ist_derselbe_nutzer(sock.as_raw_fd())
        .map_err(|e| anyhow!("am Helfer-Socket sitzt der falsche Benutzer: {e}"))?;
    Ok(Helfer { sock })
}

/// Den Helfer starten. Im Flatpak ueber `flatpak-spawn --host`, weil er auf dem
/// Host liegen MUSS (Datei-Faehigkeiten verfallen beim Betreten der Sandbox).
///
/// Die dafuer noetige Busadresse `org.freedesktop.Flatpak` steht seit dem
/// App-Hosting im Manifest — sie wird fuer HDR **nicht** hinzugefuegt.
fn starten(sockpfad: &std::path::Path) -> Result<()> {
    let eigen = std::env::var("PULSE_KMS_HELFER").ok();
    let mut befehl = if im_flatpak() {
        let mut c = std::process::Command::new("flatpak-spawn");
        c.arg("--host");
        c.arg(eigen.as_deref().unwrap_or(HOST_PFAD));
        c
    } else {
        // Ausserhalb der Sandbox (Labor, Entwicklung): erst der eigene Pfad,
        // dann das Geschwister-Programm neben dem Sidecar, dann das
        // eingerichtete auf dem Host.
        let pfad = eigen
            .map(PathBuf::from)
            .or_else(neben_dem_sidecar)
            .unwrap_or_else(|| PathBuf::from(HOST_PFAD));
        std::process::Command::new(pfad)
    };
    befehl.arg("--socket").arg(sockpfad);
    befehl
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null());
    let kind = befehl.spawn().with_context(|| {
        format!(
            "den Helfer starten. Ist er eingerichtet? Einmalig: {}",
            installationsbefehl()
        )
    })?;
    // Nicht auf das Ende warten — der Helfer laeuft, solange wir Bilder holen.
    // Aber jemand muss ihn abholen, sonst bleibt bei jedem Streamstart ein
    // Zombie stehen (bei `flatpak-spawn` sogar sofort, denn das Zwischenstueck
    // endet gleich nach dem Weiterreichen).
    std::thread::Builder::new()
        .name("hq-kms-helfer-abholen".into())
        .spawn(move || {
            let mut kind = kind;
            let _ = kind.wait();
        })
        .ok();
    Ok(())
}

fn neben_dem_sidecar() -> Option<PathBuf> {
    let eigen = std::env::current_exe().ok()?;
    let kandidat = eigen.parent()?.join("pulse-kms-helfer");
    kandidat.exists().then_some(kandidat)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Der Socket liegt im Laufzeitverzeichnis und **nicht** in dem von
    /// PulseAudio — sonst schriebe der Helfer in ein Verzeichnis, das der
    /// Flatpak fuer den Ton bindet.
    #[test]
    fn socket_liegt_im_eigenen_laufzeitverzeichnis() {
        let p = socket_pfad();
        assert!(p.ends_with("pulse-hq/kms.sock"), "{p:?}");
        assert!(p.is_absolute());
    }

    /// Die Meldung bei einer alten Fassung muss den GRUND nennen, nicht nur
    /// „geht nicht" — sonst sucht der Nutzer an der falschen Stelle.
    #[test]
    fn alte_fassung_wird_benannt() {
        let mut a = p::Antwort::fehler(p::FEHLER_FASSUNG, "andere Protokollfassung");
        a.fassung = p::FASSUNG.saturating_sub(1);
        let e = pruefen(&a).unwrap_err().to_string();
        assert!(e.contains("aelter als die App"), "{e}");
        assert!(e.contains("Fassung"), "{e}");
        assert!(e.contains("einrichten"), "der Befehl gehoert in die Meldung: {e}");
    }

    /// Und der umgekehrte Fall darf nicht als „zu alt" durchgehen.
    #[test]
    fn neuere_fassung_wird_anders_benannt() {
        let mut a = p::Antwort::fehler(p::FEHLER_FASSUNG, "");
        a.fassung = p::FASSUNG + 5;
        let e = pruefen(&a).unwrap_err().to_string();
        assert!(e.contains("neuer als die App"), "{e}");
    }

    #[test]
    fn fehlende_berechtigung_nennt_den_befehl() {
        let e = pruefen(&p::Antwort::fehler(p::FEHLER_RECHTE, "")).unwrap_err().to_string();
        assert!(e.contains("cap_sys_admin"), "{e}");
        assert!(e.contains("einrichten"), "{e}");
    }

    #[test]
    fn ok_ist_kein_fehler() {
        assert!(pruefen(&p::Antwort::fehler(p::OK, "")).is_ok());
    }
}
