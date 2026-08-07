//! Nachrichten und Dateideskriptoren ueber den Unix-Socket — die Mechanik, die
//! beide Seiten teilen.
//!
//! **Warum `SOCK_SEQPACKET` und nicht `SOCK_STREAM`.** Die Begleitdaten
//! (`SCM_RIGHTS`, also die DMABUF-Deskriptoren) haengen am ERSTEN Byte einer
//! Nachricht. Auf einem Strom-Socket darf der Kern eine Nachricht teilen; wer
//! dann in zwei Zuegen liest, hat die Deskriptoren beim ersten Zug und den Rest
//! der Beschreibung beim zweiten — und beim naechsten Bild passt beides nicht
//! mehr zusammen. Ein Paket-Socket haelt die Grenzen ein, kennt aber weiterhin
//! `SCM_RIGHTS`. Das ist hier die ganze Begruendung fuer eine Zeile.
//!
//! **`SO_PEERCRED` ist der eigentliche Schutz.** Wer mit dem Helfer reden darf,
//! liest den Bildschirm mit. Die Rechte am Socket (0600 in einem Verzeichnis
//! mit 0700) sind die erste Schranke, die abgefragte Kennung der Gegenseite die
//! zweite — und die zweite haelt auch dann noch, wenn jemand die erste durch
//! eine unglueckliche Umgebung (fremdes Laufzeitverzeichnis, geerbter
//! Deskriptor) umgangen hat. Beide Seiten fragen: der Helfer, wem er das Bild
//! gibt, und die App, wem sie ihre Anfragen schickt.

use std::io;
use std::os::fd::{AsRawFd, OwnedFd, RawFd};

/// Kennung des Gegenuebers am verbundenen Socket.
pub fn gegenueber_uid(sock: RawFd) -> io::Result<u32> {
    let mut ucred = libc::ucred { pid: 0, uid: u32::MAX, gid: u32::MAX };
    let mut len = size_of::<libc::ucred>() as libc::socklen_t;
    let rc = unsafe {
        libc::getsockopt(
            sock,
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&raw mut ucred).cast(),
            &mut len,
        )
    };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(ucred.uid)
}

/// Prueft, dass am anderen Ende derselbe Benutzer sitzt.
pub fn gegenueber_ist_derselbe_nutzer(sock: RawFd) -> io::Result<()> {
    urteilen(gegenueber_uid(sock)?, unsafe { libc::geteuid() })
}

/// Die Entscheidung selbst, getrennt vom Socket — damit sie in beide
/// Richtungen pruefbar ist. Ein zweiter Benutzer laesst sich in einem
/// gewoehnlichen Test nicht herstellen; die Probe am echten Socket steht
/// deshalb in der Messakte, nicht hier.
pub fn urteilen(fremd: u32, eigen: u32) -> io::Result<()> {
    if fremd != eigen {
        return Err(io::Error::other(format!(
            "Gegenseite gehoert Benutzer {fremd}, nicht {eigen} — abgewiesen"
        )));
    }
    Ok(())
}

/// Groesse des Begleitdaten-Puffers fuer bis zu vier Dateideskriptoren —
/// eine Stelle fuer den Wert statt ihn in `senden` und `empfangen` je einmal
/// hinzuschreiben.
const CMSG_BUF_LEN: usize = unsafe { libc::CMSG_SPACE(4 * 4) } as usize;

/// Eine `sockaddr_un` aus einem Pfad bauen. Braucht sowohl die Bind-Seite
/// (Helfer, `kms-helfer/src/main.rs`) als auch die Connect-Seite (App,
/// `capture/kms_helfer.rs`) — eine Laengenpruefung an einer Stelle statt
/// zweimal von Hand nachgebaut.
pub fn adresse_aus_pfad(pfad: &std::path::Path) -> io::Result<libc::sockaddr_un> {
    let mut adresse: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    adresse.sun_family = libc::AF_UNIX as _;
    let bytes = pfad.as_os_str().as_encoded_bytes();
    if bytes.len() + 1 > adresse.sun_path.len() {
        return Err(io::Error::other("Socket-Pfad zu lang fuer einen Unix-Socket"));
    }
    for (ziel, &b) in adresse.sun_path.iter_mut().zip(bytes) {
        *ziel = b as libc::c_char;
    }
    Ok(adresse)
}

/// Eine Nachricht senden, wahlweise mit Dateideskriptoren im Gepaeck.
///
/// Die Deskriptoren bleiben Eigentum des Aufrufers: der Kern dupliziert sie in
/// den Empfaenger, das Original ist danach weiter zu schliessen.
pub fn senden(sock: RawFd, daten: &[u8], fds: &[RawFd]) -> io::Result<()> {
    let mut iov = libc::iovec {
        iov_base: daten.as_ptr() as *mut libc::c_void,
        iov_len: daten.len(),
    };
    let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
    msg.msg_iov = &mut iov;
    msg.msg_iovlen = 1;

    // Platz fuer die Begleitdaten. Steht auf dem Stapel und lebt bis zum
    // Ende dieser Funktion — der Kern liest ihn waehrend `sendmsg`.
    let mut puffer = [0u8; CMSG_BUF_LEN];
    if !fds.is_empty() {
        let n = fds.len().min(4);
        msg.msg_control = puffer.as_mut_ptr().cast();
        msg.msg_controllen = unsafe { libc::CMSG_SPACE((n * 4) as u32) } as _;
        unsafe {
            let cmsg = libc::CMSG_FIRSTHDR(&msg);
            (*cmsg).cmsg_level = libc::SOL_SOCKET;
            (*cmsg).cmsg_type = libc::SCM_RIGHTS;
            (*cmsg).cmsg_len = libc::CMSG_LEN((n * 4) as u32) as _;
            std::ptr::copy_nonoverlapping(fds.as_ptr(), libc::CMSG_DATA(cmsg).cast(), n);
        }
    }

    let rc = unsafe { libc::sendmsg(sock, &msg, libc::MSG_NOSIGNAL) };
    if rc < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Eine Nachricht empfangen. Liefert die Zahl der gelesenen Bytes und die
/// mitgereisten Deskriptoren (die der Aufrufer besitzt).
///
/// 0 Bytes heisst: die Gegenseite hat aufgelegt.
pub fn empfangen(sock: RawFd, ziel: &mut [u8]) -> io::Result<(usize, Vec<OwnedFd>)> {
    let mut iov = libc::iovec {
        iov_base: ziel.as_mut_ptr().cast(),
        iov_len: ziel.len(),
    };
    let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
    msg.msg_iov = &mut iov;
    msg.msg_iovlen = 1;
    let mut puffer = [0u8; CMSG_BUF_LEN];
    msg.msg_control = puffer.as_mut_ptr().cast();
    msg.msg_controllen = puffer.len() as _;

    let gelesen = unsafe { libc::recvmsg(sock, &mut msg, libc::MSG_CMSG_CLOEXEC) };
    if gelesen < 0 {
        return Err(io::Error::last_os_error());
    }

    let mut fds = Vec::new();
    unsafe {
        let mut cmsg = libc::CMSG_FIRSTHDR(&msg);
        while !cmsg.is_null() {
            if (*cmsg).cmsg_level == libc::SOL_SOCKET && (*cmsg).cmsg_type == libc::SCM_RIGHTS {
                let n = ((*cmsg).cmsg_len as usize - libc::CMSG_LEN(0) as usize) / 4;
                let daten: *const RawFd = libc::CMSG_DATA(cmsg).cast();
                for i in 0..n {
                    fds.push(<OwnedFd as std::os::fd::FromRawFd>::from_raw_fd(*daten.add(i)));
                }
            }
            cmsg = libc::CMSG_NXTHDR(&msg, cmsg);
        }
    }
    // Abgeschnittene Begleitdaten heissen: es kamen mehr Deskriptoren, als
    // hier Platz war, und der Rest ist verloren. Ein halbes Bild ist kein
    // Bild — lieber ein klarer Fehler als ein Import, der irgendwo scheitert.
    if msg.msg_flags & libc::MSG_CTRUNC != 0 {
        return Err(io::Error::other("Begleitdaten abgeschnitten"));
    }
    Ok((gelesen as usize, fds))
}

/// Ein Paket-Socket-Paar fuer Tests und fuer den Aufruf ohne Datei-Socket.
pub fn paar() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [-1i32; 2];
    let rc = unsafe {
        libc::socketpair(
            libc::AF_UNIX,
            libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC,
            0,
            fds.as_mut_ptr(),
        )
    };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    unsafe {
        use std::os::fd::FromRawFd;
        Ok((OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])))
    }
}

/// Kleine Hilfe fuer Besitz-Typen: `as_raw_fd` ohne Import an jeder Stelle.
pub fn roh(fd: &OwnedFd) -> RawFd {
    fd.as_raw_fd()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nachricht_und_deskriptor_reisen_zusammen() {
        let (a, b) = paar().unwrap();
        // Irgendein echter Deskriptor, den wir wiedererkennen koennen.
        let datei = std::fs::File::open("/dev/null").unwrap();
        senden(roh(&a), b"hallo", &[datei.as_raw_fd()]).unwrap();
        let mut ziel = [0u8; 16];
        let (n, fds) = empfangen(roh(&b), &mut ziel).unwrap();
        assert_eq!(&ziel[..n], b"hallo");
        assert_eq!(fds.len(), 1);
        // Der empfangene Deskriptor ist ein ANDERER als der gesendete, zeigt
        // aber auf dieselbe Datei — genau das ist SCM_RIGHTS.
        assert_ne!(fds[0].as_raw_fd(), datei.as_raw_fd());
    }

    /// Auf einem Paket-Socket bleiben Nachrichtengrenzen erhalten; das ist die
    /// Eigenschaft, wegen der er hier steht.
    #[test]
    fn grenzen_bleiben_erhalten() {
        let (a, b) = paar().unwrap();
        senden(roh(&a), &[1u8; 40], &[]).unwrap();
        senden(roh(&a), &[2u8; 40], &[]).unwrap();
        let mut ziel = [0u8; 200];
        let (n1, _) = empfangen(roh(&b), &mut ziel).unwrap();
        assert_eq!((n1, ziel[0]), (40, 1), "die zweite Nachricht darf nicht mitkommen");
        let (n2, _) = empfangen(roh(&b), &mut ziel).unwrap();
        assert_eq!((n2, ziel[0]), (40, 2));
    }

    #[test]
    fn aufgelegte_gegenseite_liefert_null() {
        let (a, b) = paar().unwrap();
        drop(a);
        let mut ziel = [0u8; 8];
        assert_eq!(empfangen(roh(&b), &mut ziel).unwrap().0, 0);
    }

    /// Am eigenen Socket-Paar sitzt der eigene Benutzer — die Pruefung muss ihn
    /// durchlassen, sonst faende sie nie etwas.
    #[test]
    fn eigener_nutzer_wird_durchgelassen() {
        let (a, _b) = paar().unwrap();
        assert_eq!(gegenueber_uid(roh(&a)).unwrap(), unsafe { libc::geteuid() });
        gegenueber_ist_derselbe_nutzer(roh(&a)).unwrap();
    }

    /// Und die Pruefung muss auch Nein sagen koennen. Ohne diesen Fall waere
    /// oben nur belegt, dass sie nichts tut.
    #[test]
    fn fremder_nutzer_wird_abgewiesen() {
        assert!(urteilen(1000, 1000).is_ok());
        for fremd in [0u32, 1, 999, 1001, u32::MAX] {
            assert!(urteilen(fremd, 1000).is_err(), "uid {fremd} haette Nein sein muessen");
        }
        let e = urteilen(0, 1000).unwrap_err().to_string();
        assert!(e.contains("abgewiesen"), "{e}");
    }
}
