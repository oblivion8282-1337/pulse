/**
 * Anhänge speichern — Web-Share mit Dateien auf Touch-Geräten, Anker sonst.
 *
 * WARUM: In der iOS-WKWebView gibt es keinen Download-Manager — der bisherige
 * `<a download>`-Trick erzeugt dort nur eine Warnung und speichert nichts.
 * Die Web-Share-API mit Dateien (`navigator.share({ files })`) läuft in der
 * WKWebView nativ (iOS 15+) und öffnet das System-Share-Sheet mit „In Dateien
 * sichern“/„Bild sichern“ — kein Capacitor-Plugin nötig.
 *
 * Der Share-Weg gilt bewusst nur bei `pointer: coarse`: Desktop-Chrome und
 * macOS-Safari können `canShare({ files })` ebenfalls, zeigen dann aber ein
 * OS-Share-Flyout statt eines Downloads — dort soll der Anker weiterladen.
 *
 * Sicherheits-Schiene: Ein leerer Dateiname fällt auf `anhang` zurück — mit
 * `undefined`/`''` würde der Anker-Klick in die `blob:`-Adresse NAVIGIEREN
 * statt zu speichern (ein `text/html`-Anhang liefe dann als Skript im
 * Ursprung der Anwendung; Muster aus `MessageAttachments.svelte`,
 * `ERSATZ_DATEINAME`).
 *
 * Objekt-URL-Besitz: Diese Funktion erzeugt selbst nur im Anker-Fall eine
 * Objekt-URL und revoket sie nach dem Klick selbst (Frist gibt dem Download
 * Zeit zu starten). Eine als `quelle` übergebene `blob:`-Adresse gehört dem
 * Aufrufer und wird NICHT revoket — die Blätter halten ihre Objekt-URLs für
 * wiederholte Klicks am Leben und räumen beim Abbau selbst auf.
 *
 * ponytail: Beide Wege halten die komplette Datei im RAM (fetch → blob →
 * Share/Objekt-URL) — bei mehrhundert-MB-Videos ein spürbarer Spike. Der
 * alte Anker auf fremdorigin-URLs war dagegen latent defekt (das
 * `download`-Attribut wird cross-origin ignoriert), das Holen ist also
 * nötig. Upgrade-Pfad: Streaming-Share via File-System-Access-API, sobald
 * WebKit sie schreibt.
 */

const ERSATZ_DATEINAME = 'anhang';

/** Reiner Kern (für den Test): leerer Name → Ersatzname, s. Modulkopf. */
export function dateiNameOderErsatz(dateiname: string | null | undefined): string {
  return dateiname || ERSATZ_DATEINAME;
}

/**
 * Stellt `quelle` als Datei bereit und reicht sie weiter: über das native
 * Share-Sheet (Touch-Geräte) oder den klassischen Anker-Download (Desktop/
 * Electron). `fetch` funktioniert auch für `blob:`-Adressen — der Aufrufer
 * muss nicht wissen, ob hinter `quelle` der Server oder der Objektspeicher
 * steht. Fire-and-forget wie die Vorgänger: Scheitern wird still gefangen —
 * die Kacheln zeigen ihren Zustand ohnehin selbst, ein Rückgabewert hätte
 * keinen Leser.
 */
export async function dateiTeilenOderLaden(
  quelle: string,
  dateiname: string | null | undefined
): Promise<void> {
  try {
    const name = dateiNameOderErsatz(dateiname);
    const antwort = await fetch(quelle);
    // Abgelaufene Presigned-URL? Der Fehlerkörper wäre sonst die „Datei“.
    if (!antwort.ok) throw new Error(`dateiTeilen: HTTP ${antwort.status}`);
    const blob = await antwort.blob();
    const datei = new File([blob], name, {
      type: blob.type || 'application/octet-stream'
    });

    if (navigator.canShare?.({ files: [datei] }) && matchMedia('(pointer: coarse)').matches) {
      try {
        await navigator.share({ files: [datei] });
        return; // geteilt (oder Sheet geschlossen — beides in Ordnung)
      } catch (e) {
        // Nutzer-Abbruch beendet den Vorgang sauber. Jede ANDERE Störung —
        // typisch: abgelaufene Nutzeraktivierung nach langem Fetch über
        // Mobile-Netz — fällt in den Anker-Download weiter unten, der keine
        // Aktivierung braucht (WKWebView speichert den trotzdem nicht, aber
        // mobile Browser tun es).
        if (e instanceof DOMException && e.name === 'AbortError') return;
      }
    }

    // Anker-Fallback: der bewährte Trick auf Desktop/Electron. Die Objekt-
    // URL gehört dieser Funktion und wird nach der Frist selbst freigegeben.
    const adresse = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = adresse;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(adresse), 10_000);
  } catch {
    // Hol-Fehler (Netz, HTTP, revokete blob:-Adresse) — still, wie bisher
    // bei `blob === null`.
  }
}
